use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const EXPECTED_JS_MODULES: &[&str] = &[
    "web/js/main.js",
    "web/js/viz/viz.js",
    "web/js/viz/cluster.js",
    "web/js/minijs/index.js",
    "web/js/minijs/values.js",
    "web/js/minijs/widgets.js",
    "web/js/minijs/service_client.js",
    "web/js/minijs/vm.js",
    "web/js/core/highlight.js",
    "web/js/core/markdown.js",
    "web/js/core/auth.js",
    "web/js/core/ui_helpers.js",
    "web/js/core/state.js",
    "web/js/features/media.js",
    "web/js/features/files.js",
    "web/js/features/viewers.js",
    "web/js/features/notebook.js",
    "web/js/features/script_tools.js",
    "web/js/features/managers.js",
    "web/js/features/agy.js",
    "web/js/features/debugger.js",
    "web/js/features/editor_tools.js",
];

fn normalize_rel(base_file: &Path, rel: &str) -> PathBuf {
    let mut parts: Vec<std::ffi::OsString> = Vec::new();
    let combined = base_file.parent().unwrap_or(Path::new("")).join(rel);
    for comp in combined.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                parts.pop();
            }
            std::path::Component::Normal(s) => parts.push(s.to_os_string()),
            _ => {}
        }
    }
    let mut out = PathBuf::new();
    for p in parts {
        out.push(p);
    }
    out
}

/// Verifies ES module graph integrity (all files exist, every relative import target exists
/// and exports every requested symbol, and every module has balanced delimiters).
#[test]
fn test_frontend_es_module_integrity() {
    let mut exports_by_file: BTreeMap<PathBuf, BTreeSet<String>> = BTreeMap::new();
    let mut sources: BTreeMap<PathBuf, String> = BTreeMap::new();

    for &rel in EXPECTED_JS_MODULES {
        let path = PathBuf::from(rel);
        let src = fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("Expected JS module {} missing: {}", rel, e));
        assert!(!src.trim().is_empty(), "JS module {} is empty", rel);

        // Collect exported symbol names
        let mut exps = BTreeSet::new();
        for line in src.lines() {
            let t = line.trim();
            for prefix in [
                "export function ",
                "export async function ",
                "export class ",
                "export const ",
                "export let ",
                "export var ",
            ] {
                if let Some(rest) = t.strip_prefix(prefix) {
                    let ident: String = rest
                        .chars()
                        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
                        .collect();
                    if !ident.is_empty() {
                        exps.insert(ident);
                    }
                }
            }
        }
        // Collect `export { a, b as c }` blocks
        let mut rest = src.as_str();
        while let Some(pos) = rest.find("export {") {
            let after = &rest[pos + "export {".len()..];
            if let Some(end) = after.find('}') {
                for item in after[..end].split(',') {
                    let trimmed = item.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Some(last) = trimmed.split_whitespace().last() {
                        exps.insert(last.to_string());
                    }
                }
                rest = &after[end + 1..];
            } else {
                break;
            }
        }

        exports_by_file.insert(path.clone(), exps);
        sources.insert(path, src);
    }

    // Verify every relative import resolves to an existing module and exported symbol
    for (file, src) in &sources {
        let mut idx = 0;
        let bytes = src.as_bytes();
        while idx < bytes.len() {
            // Look for line-start `import `
            let is_line_start = idx == 0 || bytes[idx - 1] == b'\n';
            if is_line_start && src[idx..].starts_with("import ") {
                let stmt_end = src[idx..]
                    .find(';')
                    .map(|p| idx + p)
                    .unwrap_or(src.len());
                let stmt = &src[idx..stmt_end];
                if let Some(from_pos) = stmt.find("from ") {
                    let spec_part = stmt[from_pos + 5..].trim();
                    let quote = spec_part.chars().next().unwrap_or('"');
                    let rel = spec_part
                        .trim_start_matches(quote)
                        .split(quote)
                        .next()
                        .unwrap_or("");
                    let target = normalize_rel(file, rel);
                    let target_exports = exports_by_file.get(&target).unwrap_or_else(|| {
                        panic!(
                            "{} imports missing module '{}' (resolved to {:?})",
                            file.display(),
                            rel,
                            target
                        )
                    });
                    if let (Some(lb), Some(rb)) = (stmt.find('{'), stmt.find('}')) {
                        for item in stmt[lb + 1..rb].split(',') {
                            let t = item.trim();
                            if t.is_empty() {
                                continue;
                            }
                            let orig = t.split_whitespace().next().unwrap_or("");
                            assert!(
                                target_exports.contains(orig),
                                "{} imports '{}' from {}, which does not export it",
                                file.display(),
                                orig,
                                target.display()
                            );
                        }
                    }
                } else if let Some(q1) = stmt.find('"').or_else(|| stmt.find('\'')) {
                    let quote = stmt.as_bytes()[q1] as char;
                    let rel = stmt[q1 + 1..].split(quote).next().unwrap_or("");
                    let target = normalize_rel(file, rel);
                    assert!(
                        exports_by_file.contains_key(&target),
                        "{} side-effect imports missing module '{}'",
                        file.display(),
                        rel
                    );
                }
                idx = stmt_end + 1;
                continue;
            }
            idx += 1;
        }
    }

    // Verify zero monolithic legacy bundles remain
    assert!(
        !Path::new("web/app.js").exists(),
        "Legacy monolithic web/app.js should be removed"
    );
    assert!(
        !Path::new("web/minijs_vm.js").exists(),
        "Legacy monolithic web/minijs_vm.js should be removed"
    );

    // Verify delimiter balance, depth-0 `import`/`export`, zero undeclared variables,
    // zero top-level DOM side effects, and valid DOM element IDs across all 20 ES modules.
    let py_check = Command::new("python3")
        .arg("-c")
        .arg(r#"
import os, re
JS_BUILTINS = {
    "break","case","catch","class","const","continue","debugger","default","delete","do","else",
    "export","extends","false","finally","for","function","if","import","in","instanceof","let",
    "new","null","of","return","static","super","switch","this","throw","true","try","typeof",
    "var","void","while","with","yield","async","await","from","as","get","set","undefined","NaN","Infinity",
    "window","document","console","localStorage","sessionStorage","navigator","location","history",
    "fetch","EventSource","AbortController","Headers","Request","Response","URL","URLSearchParams",
    "Blob","File","FileReader","FormData","Event","CustomEvent","KeyboardEvent","MouseEvent",
    "HTMLElement","Node","Element","DOMParser","XMLSerializer","MutationObserver","ResizeObserver",
    "setTimeout","clearTimeout","setInterval","clearInterval","requestAnimationFrame","cancelAnimationFrame",
    "Promise","Object","Array","Map","Set","WeakMap","WeakSet","RegExp","Date","Math","JSON","Number",
    "String","Boolean","Symbol","BigInt","Error","TypeError","SyntaxError","RangeError","ReferenceError",
    "parseInt","parseFloat","isNaN","isFinite","encodeURI","decodeURI","encodeURIComponent","decodeURIComponent",
    "atob","btoa","structuredClone","queueMicrotask","globalThis","Uint8Array","Int32Array","Float64Array",
    "ArrayBuffer","DataView","TextEncoder","TextDecoder","Intl","Proxy","Reflect","alert","confirm","prompt",
    "getComputedStyle","matchMedia","performance","crypto","self","constructor",
}
CTRL_KW = {"if","while","for","switch","with","catch","else","return"}
REGEX_PREV = set("=(:,;!?&|+-*~^%[{}\n")
REGEX_PREV_WORDS = {"return","case","throw","in","of","typeof","void","delete","new","yield","await","else"}
def strip_js(src):
    out = []; i, n = 0, len(src); st = "code"; tpl = []; lnw = "\n"; lw = ""; in_cls = False
    while i < n:
        c = src[i]; nx = src[i+1] if i+1 < n else ""
        if st == "code":
            if c == "/" and nx == "/": st = "lc"; out.append("  "); i += 2
            elif c == "/" and nx == "*": st = "bc"; out.append("  "); i += 2
            elif c == "/" and (lnw in REGEX_PREV or lw in REGEX_PREV_WORDS): st = "rx"; in_cls = False; out.append("/"); i += 1
            elif c == '"': st = "dq"; out.append('"'); i += 1
            elif c == "'": st = "sq"; out.append("'"); i += 1
            elif c == "`": st = "tp"; out.append("`"); i += 1
            elif c == "{" and tpl: tpl[-1] += 1; out.append(c); lnw = c; lw = ""; i += 1
            elif c == "}" and tpl:
                tpl[-1] -= 1
                if tpl[-1] == 0: tpl.pop(); st = "tp"
                out.append("}"); lnw = "}"; lw = ""; i += 1
            else:
                out.append(c)
                if c.isalnum() or c in "_$": lw = (lw + c) if (lnw.isalnum() or lnw in "_$") else c; lnw = c
                elif not c.isspace(): lnw = c; lw = ""
                i += 1
        elif st == "rx":
            if c == "\\" and i+1 < n: out.append("  "); i += 2
            elif c == "[" and not in_cls: in_cls = True; out.append(" "); i += 1
            elif c == "]" and in_cls: in_cls = False; out.append(" "); i += 1
            elif c == "/" and not in_cls:
                st = "code"; out.append("/"); i += 1
                while i < n and src[i].isalpha(): out.append(" "); i += 1
                lnw = ")"; lw = ""
            else: out.append("\n" if c == "\n" else " "); i += 1
        elif st == "lc":
            if c == "\n": st = "code"; out.append("\n")
            else: out.append(" ")
            i += 1
        elif st == "bc":
            if c == "*" and nx == "/": st = "code"; out.append("  "); i += 2
            else: out.append("\n" if c == "\n" else " "); i += 1
        elif st == "dq":
            if c == "\\" and i+1 < n: out.append("  "); i += 2
            elif c == '"': st = "code"; out.append('"'); lnw = '"'; lw = ""; i += 1
            else: out.append("\n" if c == "\n" else " "); i += 1
        elif st == "sq":
            if c == "\\" and i+1 < n: out.append("  "); i += 2
            elif c == "'": st = "code"; out.append("'"); lnw = "'"; lw = ""; i += 1
            else: out.append("\n" if c == "\n" else " "); i += 1
        elif st == "tp":
            if c == "\\" and i+1 < n: out.append("  "); i += 2
            elif c == "`": st = "code"; out.append("`"); lnw = "`"; lw = ""; i += 1
            elif c == "$" and nx == "{": tpl.append(1); st = "code"; out.append("${"); lnw = "{"; lw = ""; i += 2
            else: out.append("\n" if c == "\n" else " "); i += 1
    assert st == "code", f"unterminated {st}"
    return "".join(out)

html_ids = set(re.findall(r'\bid="([^"]+)"', open("web/index.html").read()))
dyn_ids = set()
mods = []
for root, _, files in sorted(os.walk("web/js")):
    for fn in sorted(files):
        if not fn.endswith(".js"): continue
        p = os.path.join(root, fn)
        mods.append(p)
        for m in re.findall(r'id=\\?"([^"\\$]+)\\?"', open(p).read()):
            dyn_ids.add(m)
known_ids = html_ids | dyn_ids

errors = []
for p in mods:
    raw = open(p).read()
    s = strip_js(raw)
    # 1. Delimiter depth & top-level DOM check
    b = pr = bk = 0
    for idx, ln in enumerate(s.splitlines(), 1):
        t = ln.strip()
        if (t.startswith("export ") or t.startswith("import ")) and (b or pr or bk):
            errors.append(f"{p}:{idx} {t[:30]} at non-zero depth ({b},{pr},{bk})")
        if b == 0 and pr == 0 and bk == 0 and (t.startswith("document.") or t.startswith("window.addEventListener")):
            errors.append(f"{p}:{idx} top-level DOM side effect: {t[:60]}")
        for ch in ln:
            if ch == "{": b += 1
            elif ch == "}": b -= 1
            elif ch == "(": pr += 1
            elif ch == ")": pr -= 1
            elif ch == "[": bk += 1
            elif ch == "]": bk -= 1
            if b < 0 or pr < 0 or bk < 0:
                errors.append(f"{p}:{idx} negative depth ({b},{pr},{bk})")
    if b or pr or bk:
        errors.append(f"{p} EOF non-zero depth ({b},{pr},{bk})")

    # 2. DOM ID check
    for m in re.finditer(r'document\.getElementById\(\s*["\']([^"\']+)["\']\s*\)', raw):
        if m.group(1) not in known_ids:
            ln = raw[:m.start()].count("\n") + 1
            errors.append(f"{p}:{ln} unknown DOM id #{m.group(1)}")

    # 3. Undeclared variable check (catches missing imports / moved module-level lets like logLiveTimer!)
    declared = set(JS_BUILTINS)
    for im in re.finditer(r'(?m)^import\s*\{([^}]+)\}\s*from', s):
        for item in im.group(1).split(","):
            item = item.strip()
            if item: declared.add(item.split()[-1])
    for dm in re.finditer(r'\b(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)', s):
        declared.add(dm.group(1))
    for dm in re.finditer(r'\b(?:const|let|var)\s*[\{\[]([^\}\]]+)[\}\]]', s):
        for ident in re.findall(r'\b([A-Za-z_$][\w$]*)\b', dm.group(1)): declared.add(ident)
    for pm in re.finditer(r'(?:function\s*[A-Za-z_$]*\s*|catch\s*)\(([^)]*)\)', s):
        for ident in re.findall(r'\b([A-Za-z_$][\w$]*)\b', pm.group(1)): declared.add(ident)
    for pm in re.finditer(r'\(([^()]*)\)\s*=>', s):
        for ident in re.findall(r'\b([A-Za-z_$][\w$]*)\b', pm.group(1)): declared.add(ident)
    for pm in re.finditer(r'\b([A-Za-z_$][\w$]*)\s*=>', s):
        declared.add(pm.group(1))
    for pm in re.finditer(r'(?m)^  (?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{', s):
        if pm.group(1) not in CTRL_KW:
            for ident in re.findall(r'\b([A-Za-z_$][\w$]*)\b', pm.group(2)): declared.add(ident)
    # Handle class methods with default params like `decode(json, cache = new Map()) {`
    for pm in re.finditer(r'(?m)^  (?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^\{]*)\)\s*\{', s):
        if pm.group(1) not in CTRL_KW:
            declared.add(pm.group(1))
            for ident in re.findall(r'\b([A-Za-z_$][\w$]*)\b', pm.group(2)): declared.add(ident)
    for dm in re.finditer(r'\b(?:let|var|const)\s+([^;\n]+)', s):
        for v in re.findall(r'(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?:=|,|;|$)', dm.group(1)): declared.add(v)
    for fm in re.finditer(r'\bfor\s*\(\s*(?:const|let|var)\s+([^;]+?)\s+(?:in|of)\b', s):
        for ident in re.findall(r'\b([A-Za-z_$][\w$]*)\b', fm.group(1)): declared.add(ident)

    body_lines = []
    in_ie = False
    for ln in s.splitlines():
        t = ln.strip()
        if t.startswith("import ") or t.startswith("export {"):
            in_ie = not ("}" in t or ";" in t); body_lines.append(""); continue
        if in_ie:
            if "}" in t or ";" in t: in_ie = False
            body_lines.append(""); continue
        body_lines.append(ln)
    body = "\n".join(body_lines)
    seen = set()
    for match in re.finditer(r'(?<![.\w$])\b([A-Za-z_$][\w$]*)\b(?!\s*:)', body):
        name = match.group(1)
        if name in declared or name in seen: continue
        after = body[match.end():match.end()+40]
        if re.match(r'\s*\([^)]*\)\s*\{', after): continue
        seen.add(name)
        ln = body[:match.start()].count("\n") + 1
        errors.append(f"{p}:{ln} undeclared identifier `{name}`")

if errors:
    raise SystemExit("\n".join(errors))
"#)
        .output();
    if let Ok(out) = py_check {
        assert!(
            out.status.success(),
            "JS static/DOM/undeclared-var check failed:\n{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

#[test]
fn test_frontend_js_syntax_and_mlnb_viz_logic() {
    let has_node = Command::new("node")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !has_node {
        eprintln!("Skipping Node runtime JS tests because `node` is not installed");
        return;
    }

    // 1. Syntax-check every ES module with Node
    for &file in EXPECTED_JS_MODULES {
        let out = Command::new("node")
            .arg("--check")
            .arg(file)
            .output()
            .expect("failed to run node --check");
        assert!(
            out.status.success(),
            "Syntax error in {}:\n{}",
            file,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    // 2. Unit-test MlnbViz directly via native ES module import in Node
    let script = r#"
import assert from 'node:assert/strict';
import { parseCsv, normalizeTablePayload } from './web/js/viz/viz.js';
import { escapeHtml, highlightMinilang } from './web/js/core/highlight.js';

const csv = parseCsv('name,score,note\n"Ada, L.",98.5,"He said ""hi"""\nBob,42,ok\n');
assert.deepEqual(csv.columns, ['name', 'score', 'note']);
assert.equal(csv.rows.length, 2);
assert.equal(csv.rows[0][0], 'Ada, L.');
assert.equal(csv.rows[0][1], 98.5);
assert.equal(csv.rows[0][2], 'He said "hi"');
assert.equal(csv.rows[1][1], 42);

const tsv = parseCsv('a\tb\n1\t2\n3\t4\n');
assert.deepEqual(tsv.columns, ['a', 'b']);
assert.deepEqual(tsv.rows, [[1, 2], [3, 4]]);

const t1 = normalizeTablePayload([{ x: 1, y: 2 }, { y: 3, z: 4 }]);
assert.deepEqual(t1.columns, ['x', 'y', 'z']);
assert.deepEqual(t1.rows, [[1, 2, null], [null, 3, 4]]);

assert.equal(escapeHtml('<b>&"'), '&lt;b&gt;&amp;&quot;');
assert(highlightMinilang('var x := 42').includes('tok-kw'));
console.log('JS_MODULAR_TESTS_OK');
"#;

    let out = Command::new("node")
        .arg("--input-type=module")
        .arg("-e")
        .arg(script)
        .output()
        .expect("failed to execute JS test script");
    assert!(
        out.status.success(),
        "JS tests failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains("JS_MODULAR_TESTS_OK"));
}
