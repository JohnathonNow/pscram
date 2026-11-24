use crate::kernel_mgr::InvokeExecError;
use crate::kernel_proc::{DisplayItem, EvalError, KernelResponse};
use crate::lang::{BoxFuture, InvokeScriptRequest, LanguageBackend, LanguageInfo};
use std::collections::hash_map::DefaultHasher;
use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

pub struct RustBackend {
    version: String,
    cache_dir: PathBuf,
}

impl RustBackend {
    pub fn new() -> Self {
        let version = std::process::Command::new("rustc")
            .arg("--version")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| {
                s.split_whitespace()
                    .nth(1)
                    .unwrap_or("1.x")
                    .to_string()
            })
            .unwrap_or_else(|| "unavailable".to_string());
        let cache_dir = std::env::temp_dir().join("minilang-notebook-rust-cache");
        let _ = std::fs::create_dir_all(&cache_dir);
        Self { version, cache_dir }
    }
}

impl LanguageBackend for RustBackend {
    fn info(&self) -> LanguageInfo {
        LanguageInfo {
            id: "rust".to_string(),
            name: "Rust".to_string(),
            version: self.version.clone(),
            extensions: vec!["rs".to_string()],
            comment_prefix: "//".to_string(),
            supports_notebook: true,
            supports_invoke: true,
            supports_ui: false,
        }
    }

    fn kernel_command(&self, cwd: &Path) -> Result<Command, String> {
        let exe = std::env::current_exe()
            .map_err(|e| format!("failed to locate executable: {}", e))?;
        let mut cmd = Command::new(exe);
        cmd.arg("--kernel")
            .arg("--lang")
            .arg("rust")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if cwd.exists() {
            cmd.current_dir(cwd);
        }
        Ok(cmd)
    }

    fn invoke_script(
        &self,
        req: InvokeScriptRequest,
    ) -> BoxFuture<'_, Result<KernelResponse, InvokeExecError>> {
        let cache_dir = self.cache_dir.clone();
        Box::pin(async move {
            let start = Instant::now();
            let extracted = extract_rust_dependencies(&req.code, &req.cwd);
            let generated = generate_invoke_harness(&extracted.code, req.function.as_deref());

            // Content-hash cache key (source + dependencies) so repeated invocations skip rustc/cargo (~5ms)!
            let mut hasher = DefaultHasher::new();
            generated.hash(&mut hasher);
            for (k, v) in &extracted.dependencies {
                k.hash(&mut hasher);
                v.hash(&mut hasher);
            }
            let hash = format!("{:016x}", hasher.finish());
            let bin_path = cache_dir.join(format!("invoke_{}", hash));
            let src_path = cache_dir.join(format!("invoke_{}.rs", hash));

            if !bin_path.exists() {
                if let Err(e) = std::fs::create_dir_all(&cache_dir) {
                    return Err(InvokeExecError::Internal(format!("cache mkdir failed: {}", e)));
                }
                let tmp_bin = cache_dir.join(format!("invoke_{}_{}.tmp", hash, uuid::Uuid::new_v4()));

                if extracted.dependencies.is_empty() {
                    if let Err(e) = std::fs::write(&src_path, &generated) {
                        return Err(InvokeExecError::Internal(format!("write src failed: {}", e)));
                    }

                    let compile_fut = Command::new("rustc")
                        .args(["--edition", "2021", "-C", "opt-level=0", "-C", "debuginfo=0"])
                        .arg(&src_path)
                        .arg("-o")
                        .arg(&tmp_bin)
                        .stdout(Stdio::piped())
                        .stderr(Stdio::piped())
                        .output();

                    let compile_out = match tokio::time::timeout(
                        Duration::from_millis(req.timeout_ms),
                        compile_fut,
                    )
                    .await
                    {
                        Ok(Ok(out)) => out,
                        Ok(Err(e)) => {
                            return Err(InvokeExecError::Internal(format!(
                                "Failed to spawn rustc: {}",
                                e
                            )));
                        }
                        Err(_) => return Err(InvokeExecError::Timeout(req.timeout_ms)),
                    };

                    if !compile_out.status.success() {
                        let _ = std::fs::remove_file(&tmp_bin);
                        let diag = String::from_utf8_lossy(&compile_out.stderr).into_owned();
                        return Ok(KernelResponse::InvokeResult {
                            result: serde_json::json!({ "type": "nil" }),
                            type_name: "error".to_string(),
                            repr: String::new(),
                            stdout: String::new(),
                            displays: Vec::new(),
                            error: Some(EvalError {
                                error_type: "CompileError".to_string(),
                                message: format!("rustc failed for '{}'", req.source),
                                traceback: diag,
                            }),
                            duration_ms: start.elapsed().as_secs_f64() * 1000.0,
                        });
                    }
                    let _ = std::fs::rename(&tmp_bin, &bin_path);
                } else {
                    let pkg_name = format!("mlnb_invoke_{}", &hash[..8]);
                    let proj_dir = cache_dir.join(format!("proj_{}_{}", hash, uuid::Uuid::new_v4()));
                    let build_res = build_cargo_project_async(
                        &proj_dir,
                        &pkg_name,
                        &extracted.dependencies,
                        &generated,
                        req.timeout_ms,
                    )
                    .await;

                    match build_res {
                        Ok(Ok(built_bin)) => {
                            let copy_res = std::fs::copy(&built_bin, &tmp_bin)
                                .and_then(|_| std::fs::rename(&tmp_bin, &bin_path));
                            let _ = std::fs::remove_dir_all(&proj_dir);
                            if let Err(e) = copy_res {
                                let _ = std::fs::remove_file(&tmp_bin);
                                return Err(InvokeExecError::Internal(format!(
                                    "Failed to cache compiled cargo binary: {}",
                                    e
                                )));
                            }
                        }
                        Ok(Err(diag)) => {
                            let _ = std::fs::remove_dir_all(&proj_dir);
                            return Ok(KernelResponse::InvokeResult {
                                result: serde_json::json!({ "type": "nil" }),
                                type_name: "error".to_string(),
                                repr: String::new(),
                                stdout: String::new(),
                                displays: Vec::new(),
                                error: Some(EvalError {
                                    error_type: "CompileError".to_string(),
                                    message: format!("cargo build failed for '{}'", req.source),
                                    traceback: diag,
                                }),
                                duration_ms: start.elapsed().as_secs_f64() * 1000.0,
                            });
                        }
                        Err(err) => {
                            let _ = std::fs::remove_dir_all(&proj_dir);
                            return Err(err);
                        }
                    }
                }
            }

            // Prepare tagged JSON input payload on stdin for the compiled Rust binary
            let input_payload = serde_json::json!({
                "params": req.params,
                "args": req.args,
            });
            let input_bytes = serde_json::to_vec(&input_payload)
                .map_err(|e| InvokeExecError::Internal(format!("encode params failed: {}", e)))?;

            let result_file = cache_dir.join(format!("res_{}.json", uuid::Uuid::new_v4()));
            let displays_file = cache_dir.join(format!("disp_{}.jsonl", uuid::Uuid::new_v4()));

            let mut cmd = Command::new(&bin_path);
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .env("__ML_RESULT_FILE", &result_file)
                .env("__ML_DISPLAYS_FILE", &displays_file)
                .kill_on_drop(true);
            for (k, v) in &req.env {
                cmd.env(k, v);
                cmd.env(format!("MLNB_SECRET_{}", k), v);
            }
            if req.cwd.exists() {
                cmd.current_dir(&req.cwd);
            }

            let mut child = cmd
                .spawn()
                .map_err(|e| InvokeExecError::Internal(format!("failed to run script binary: {}", e)))?;
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(&input_bytes).await;
                let _ = stdin.flush().await;
                drop(stdin);
            }

            let elapsed = start.elapsed().as_millis() as u64;
            let remaining = req.timeout_ms.saturating_sub(elapsed).max(100);
            let run_res = tokio::time::timeout(
                Duration::from_millis(remaining),
                child.wait_with_output(),
            )
            .await;

            let output = match run_res {
                Ok(Ok(o)) => o,
                Ok(Err(e)) => {
                    let _ = std::fs::remove_file(&result_file);
                    let _ = std::fs::remove_file(&displays_file);
                    return Err(InvokeExecError::Internal(format!("execution failed: {}", e)));
                }
                Err(_) => {
                    let _ = std::fs::remove_file(&result_file);
                    let _ = std::fs::remove_file(&displays_file);
                    return Err(InvokeExecError::Timeout(req.timeout_ms));
                }
            };

            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            let displays = read_displays_file(&displays_file);
            let result_raw = std::fs::read_to_string(&result_file).ok();
            let _ = std::fs::remove_file(&result_file);
            let _ = std::fs::remove_file(&displays_file);

            let duration_ms = start.elapsed().as_secs_f64() * 1000.0;

            if !output.status.success() {
                let err_msg = if !stderr.trim().is_empty() {
                    stderr.trim().to_string()
                } else {
                    format!("Process exited with status {}", output.status)
                };
                return Ok(KernelResponse::InvokeResult {
                    result: serde_json::json!({ "type": "nil" }),
                    type_name: "error".to_string(),
                    repr: String::new(),
                    stdout,
                    displays,
                    error: Some(EvalError {
                        error_type: "RuntimeError".to_string(),
                        message: err_msg,
                        traceback: String::new(),
                    }),
                    duration_ms,
                });
            }

            let tagged_result: serde_json::Value = result_raw
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_else(|| serde_json::json!({ "type": "nil" }));

            // Check if the script reported a parameter/runtime error inside the result envelope
            if let Some(err_str) = tagged_result.get("__ml_error").and_then(|v| v.as_str()) {
                return Ok(KernelResponse::InvokeResult {
                    result: serde_json::json!({ "type": "nil" }),
                    type_name: "error".to_string(),
                    repr: String::new(),
                    stdout,
                    displays,
                    error: Some(EvalError {
                        error_type: "RuntimeError".to_string(),
                        message: err_str.to_string(),
                        traceback: String::new(),
                    }),
                    duration_ms,
                });
            }

            let type_name = tagged_result
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("nil")
                .to_string();
            let repr = format_tagged_preview(&tagged_result);

            Ok(KernelResponse::InvokeResult {
                result: tagged_result,
                type_name,
                repr,
                stdout,
                displays,
                error: None,
                duration_ms,
            })
        })
    }
}

pub fn read_displays_file(path: &Path) -> Vec<DisplayItem> {
    let mut out = Vec::new();
    if let Ok(content) = std::fs::read_to_string(path) {
        for line in content.lines() {
            if let Ok(item) = serde_json::from_str::<DisplayItem>(line) {
                out.push(item);
            }
        }
    }
    out
}

fn format_tagged_preview(v: &serde_json::Value) -> String {
    match v.get("type").and_then(|t| t.as_str()) {
        Some("nil") => "()".to_string(),
        Some("string") => v
            .get("value")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string(),
        Some("integer") | Some("real") | Some("boolean") => {
            v.get("value").map(|x| x.to_string()).unwrap_or_default()
        }
        _ => serde_json::to_string_pretty(v).unwrap_or_default(),
    }
}

/// Split Rust source into top-level items (fn, struct, enum, use, impl, const, etc.),
/// body statements, and an optional trailing expression (no semicolon).
#[derive(Debug, Default)]
pub struct SplitRust {
    pub items: Vec<String>,
    pub statements: Vec<String>,
    pub trailing_expr: Option<String>,
    pub has_fn_main: bool,
}

pub fn split_rust_source(src: &str) -> SplitRust {
    let units = split_top_level_units(src);
    let mut out = SplitRust::default();
    let mut body_units = Vec::new();

    for unit in units {
        let trimmed = unit.trim();
        if trimmed.is_empty() || is_only_comments(trimmed) {
            continue;
        }
        if is_top_level_item(trimmed) {
            if has_main_fn_signature(trimmed) {
                out.has_fn_main = true;
            }
            out.items.push(trimmed.to_string());
        } else {
            body_units.push(trimmed.to_string());
        }
    }

    if let Some(last) = body_units.pop() {
        if is_expression_unit(&last) {
            out.statements = body_units;
            out.trailing_expr = Some(last);
        } else {
            body_units.push(last);
            out.statements = body_units;
        }
    }
    out
}

fn strip_leading_comments_and_attrs(s: &str) -> &str {
    let mut rest = s.trim_start();
    loop {
        if rest.starts_with("//") {
            if let Some(nl) = rest.find('\n') {
                rest = rest[nl + 1..].trim_start();
                continue;
            }
            return "";
        }
        if rest.starts_with("/*") {
            let bytes = rest.as_bytes();
            let mut i = 2;
            let mut depth = 1;
            while i + 1 < bytes.len() && depth > 0 {
                if bytes[i] == b'/' && bytes[i + 1] == b'*' {
                    depth += 1;
                    i += 2;
                } else if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            rest = rest[i..].trim_start();
            continue;
        }
        if rest.starts_with("#[") {
            let bytes = rest.as_bytes();
            let mut i = 1;
            let mut depth = 0;
            while i < bytes.len() {
                if bytes[i] == b'[' {
                    depth += 1;
                } else if bytes[i] == b']' {
                    depth -= 1;
                    if depth == 0 {
                        i += 1;
                        break;
                    }
                }
                i += 1;
            }
            rest = rest[i..].trim_start();
            continue;
        }
        break;
    }
    rest
}

fn is_only_comments(s: &str) -> bool {
    strip_leading_comments_and_attrs(s).is_empty()
}

fn is_top_level_item(s: &str) -> bool {
    let mut head = strip_leading_comments_and_attrs(s);
    if head.starts_with("pub") {
        let after = &head[3..];
        if after.starts_with('(') {
            if let Some(end) = after.find(')') {
                head = after[end + 1..].trim_start();
            }
        } else if after.starts_with(char::is_whitespace) {
            head = after.trim_start();
        }
    }
    for prefix in ["async ", "unsafe ", "const ", "default "] {
        if let Some(stripped) = head.strip_prefix(prefix) {
            // `const X: T = ...;` is an item too!
            if prefix == "const " && !stripped.trim_start().starts_with("fn ") {
                return true;
            }
            head = stripped.trim_start();
        }
    }
    const ITEM_PREFIXES: &[&str] = &[
        "use ",
        "fn ",
        "struct ",
        "enum ",
        "trait ",
        "impl ",
        "impl<",
        "type ",
        "mod ",
        "extern ",
        "static ",
        "macro_rules!",
    ];
    ITEM_PREFIXES.iter().any(|p| head.starts_with(p))
}

fn has_main_fn_signature(s: &str) -> bool {
    let head = strip_leading_comments_and_attrs(s);
    let head = head.strip_prefix("pub ").unwrap_or(head).trim_start();
    head.starts_with("fn main(") || head.starts_with("fn main (")
}

fn is_expression_unit(s: &str) -> bool {
    let clean = strip_leading_comments_and_attrs(s);
    if clean.is_empty() {
        return false;
    }
    if clean.ends_with(';') {
        return false;
    }
    if clean.starts_with("let ")
        || clean.starts_with("for ")
        || clean.starts_with("while ")
        || clean.starts_with("loop ")
        || clean.starts_with("loop{")
    {
        return false;
    }
    true
}

/// Brace/string/comment-aware top-level unit splitter for Rust source code.
pub fn split_top_level_units(src: &str) -> Vec<String> {
    let bytes = src.as_bytes();
    let n = bytes.len();
    let mut units = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    let mut brace_depth = 0i32;
    let mut paren_depth = 0i32;
    let mut bracket_depth = 0i32;

    while i < n {
        let b = bytes[i];
        // Line comment
        if b == b'/' && i + 1 < n && bytes[i + 1] == b'/' {
            i += 2;
            while i < n && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // Block comment (nestable)
        if b == b'/' && i + 1 < n && bytes[i + 1] == b'*' {
            i += 2;
            let mut d = 1;
            while i + 1 < n && d > 0 {
                if bytes[i] == b'/' && bytes[i + 1] == b'*' {
                    d += 1;
                    i += 2;
                } else if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                    d -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        // Raw string r#"..."# or r"..."
        if b == b'r' && i + 1 < n && (bytes[i + 1] == b'"' || bytes[i + 1] == b'#') {
            let prev_ok = i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
            if prev_ok {
                let mut j = i + 1;
                let mut hashes = 0usize;
                while j < n && bytes[j] == b'#' {
                    hashes += 1;
                    j += 1;
                }
                if j < n && bytes[j] == b'"' {
                    j += 1;
                    while j < n {
                        if bytes[j] == b'"' {
                            let mut h = 0;
                            while h < hashes && j + 1 + h < n && bytes[j + 1 + h] == b'#' {
                                h += 1;
                            }
                            if h == hashes {
                                j += 1 + hashes;
                                break;
                            }
                        }
                        j += 1;
                    }
                    i = j;
                    continue;
                }
            }
        }
        // Regular string
        if b == b'"' {
            i += 1;
            while i < n {
                if bytes[i] == b'\\' && i + 1 < n {
                    i += 2;
                } else if bytes[i] == b'"' {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        // Char literal (distinguish from lifetime like `'a`)
        if b == b'\'' {
            if i + 2 < n && bytes[i + 1] == b'\\' {
                i += 2;
                while i < n && bytes[i] != b'\'' {
                    i += 1;
                }
                if i < n {
                    i += 1;
                }
                continue;
            } else if i + 2 < n && bytes[i + 2] == b'\'' {
                i += 3;
                continue;
            }
            i += 1;
            continue;
        }

        match b {
            b'(' => paren_depth += 1,
            b')' => paren_depth = (paren_depth - 1).max(0),
            b'[' => bracket_depth += 1,
            b']' => bracket_depth = (bracket_depth - 1).max(0),
            b'{' => brace_depth += 1,
            b'}' => {
                brace_depth = (brace_depth - 1).max(0);
                if brace_depth == 0 && paren_depth == 0 && bracket_depth == 0 {
                    // Check if followed by `else` (for `if { } else { }`) or `;` or `.` (method chain) or `,`
                    let mut look = i + 1;
                    while look < n && bytes[look].is_ascii_whitespace() {
                        look += 1;
                    }
                    let rest = &src[look..];
                    let continues = rest.starts_with("else")
                        || rest.starts_with(';')
                        || rest.starts_with('.')
                        || rest.starts_with(')')
                        || rest.starts_with('+')
                        || rest.starts_with('-')
                        || rest.starts_with('*')
                        || rest.starts_with('/');
                    if !continues {
                        // Only split on `}` when the unit is an item or block statement (fn/struct/enum/impl/trait/mod/for/while/loop/if/match)
                        let candidate = strip_leading_comments_and_attrs(&src[start..=i]);
                        let is_block_unit = is_top_level_item(&src[start..=i])
                            || candidate.starts_with("for ")
                            || candidate.starts_with("while ")
                            || candidate.starts_with("loop ")
                            || candidate.starts_with("loop{")
                            || candidate.starts_with("if ")
                            || candidate.starts_with("match ");
                        if is_block_unit {
                            units.push(src[start..=i].to_string());
                            start = i + 1;
                        }
                    }
                }
            }
            b';' => {
                if brace_depth == 0 && paren_depth == 0 && bracket_depth == 0 {
                    units.push(src[start..=i].to_string());
                    start = i + 1;
                }
            }
            _ => {}
        }
        i += 1;
    }

    if start < n {
        let tail = src[start..].trim();
        if !tail.is_empty() {
            units.push(src[start..].to_string());
        }
    }
    units
}

/// Extract parameter list `(name, type)` for a named `fn <target>(...)` if present.
fn extract_fn_params(items: &[String], target: &str) -> Option<Vec<(String, String)>> {
    let needle_a = format!("fn {}(", target);
    let needle_b = format!("fn {} (", target);
    for item in items {
        let clean = strip_leading_comments_and_attrs(item);
        let pos = clean.find(&needle_a).or_else(|| clean.find(&needle_b));
        if let Some(p) = pos {
            let after_fn = &clean[p..];
            let open = after_fn.find('(')?;
            let mut depth = 0i32;
            let mut close = None;
            for (idx, ch) in after_fn[open..].char_indices() {
                if ch == '(' {
                    depth += 1;
                } else if ch == ')' {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(open + idx);
                        break;
                    }
                }
            }
            let close = close?;
            let param_str = after_fn[open + 1..close].trim();
            if param_str.is_empty() {
                return Some(Vec::new());
            }
            // Split top-level commas inside param_str
            let mut parts = Vec::new();
            let mut pstart = 0;
            let mut angle = 0i32;
            let mut par = 0i32;
            let mut brk = 0i32;
            for (idx, ch) in param_str.char_indices() {
                match ch {
                    '<' => angle += 1,
                    '>' => angle -= 1,
                    '(' => par += 1,
                    ')' => par -= 1,
                    '[' => brk += 1,
                    ']' => brk -= 1,
                    ',' if angle == 0 && par == 0 && brk == 0 => {
                        parts.push(param_str[pstart..idx].trim());
                        pstart = idx + 1;
                    }
                    _ => {}
                }
            }
            parts.push(param_str[pstart..].trim());
            let mut params = Vec::new();
            for part in parts {
                if part.is_empty() {
                    continue;
                }
                if let Some(colon) = part.find(':') {
                    let pname = part[..colon].trim().trim_start_matches("mut ").trim().to_string();
                    let ptype = part[colon + 1..].trim().to_string();
                    params.push((pname, ptype));
                }
            }
            return Some(params);
        }
    }
    None
}

fn generate_invoke_harness(code: &str, function: Option<&str>) -> String {
    let split = split_rust_source(code);
    let mut out = String::new();
    out.push_str("#![allow(unused_imports, unused_variables, dead_code, unused_mut)]\n");
    out.push_str(RUST_TAGGED_PRELUDE);
    out.push_str("\nuse __ml_rt::{Value, Params, html, svg, markdown, display};\n\n");

    if split.has_fn_main && function.is_none() {
        // User provided their own `fn main()`. Expose `params()` and `args()` helpers.
        out.push_str(code);
        out.push('\n');
        return out;
    }

    for item in &split.items {
        if !has_main_fn_signature(item) {
            out.push_str(item);
            out.push('\n');
        }
    }

    if let Some(fn_name) = function.filter(|s| !s.trim().is_empty()) {
        let fn_name = fn_name.trim();
        out.push_str("\nfn __ml_entry(params: &Params, args: &[Value]) -> Result<Value, String> {\n");
        for stmt in &split.statements {
            out.push_str("    ");
            out.push_str(stmt);
            out.push('\n');
        }
        if let Some(sig) = extract_fn_params(&split.items, fn_name) {
            if sig.len() == 2 && sig[0].1.contains("Params") && sig[1].1.contains("Value") {
                out.push_str(&format!(
                    "    Ok(__ml_rt::IntoResult::into_result({}(params, args))?)\n",
                    fn_name
                ));
            } else if sig.len() == 1 && sig[0].1.contains("Params") {
                out.push_str(&format!(
                    "    Ok(__ml_rt::IntoResult::into_result({}(params))?)\n",
                    fn_name
                ));
            } else {
                let mut call_args = Vec::new();
                for (idx, (pname, ptype)) in sig.iter().enumerate() {
                    let var = format!("__arg_{}", idx);
                    out.push_str(&format!(
                        "    let {}: {} = __ml_rt::extract_arg(params, args, {}, {:?})?;\n",
                        var, ptype, idx, pname
                    ));
                    call_args.push(var);
                }
                out.push_str(&format!(
                    "    Ok(__ml_rt::IntoResult::into_result({}({}))?)\n",
                    fn_name,
                    call_args.join(", ")
                ));
            }
        } else {
            out.push_str(&format!(
                "    Ok(__ml_rt::IntoResult::into_result({}(params, args))?)\n",
                fn_name
            ));
        }
        out.push_str("}\n");
    } else {
        out.push_str("\nfn __ml_entry(params: &Params, args: &[Value]) -> Result<Value, String> {\n");
        for stmt in &split.statements {
            out.push_str("    ");
            out.push_str(stmt);
            out.push('\n');
        }
        if let Some(expr) = &split.trailing_expr {
            out.push_str(&format!(
                "    let __res = {{\n        {}\n    }};\n    __ml_rt::IntoResult::into_result(__res)\n",
                expr
            ));
        } else {
            out.push_str("    Ok(Value::Nil)\n");
        }
        out.push_str("}\n");
    }

    out.push_str(
        r#"
fn main() {
    let (params, args) = __ml_rt::read_stdin_envelope();
    match __ml_entry(&params, &args) {
        Ok(val) => __ml_rt::write_result_json(&val.to_tagged_json()),
        Err(msg) => {
            let escaped = __ml_rt::json_escape(&msg);
            __ml_rt::write_result_json(&format!("{{\"__ml_error\":{}}}", escaped));
        }
    }
}
"#,
    );
    out
}

/// Self-contained zero-dependency Rust prelude providing Tagged JSON `Value`, `Params`,
/// typed extractors, `IntoResult`, and `html()`/`svg()`/`markdown()`/`display()` helpers.
pub const RUST_TAGGED_PRELUDE: &str = r#"
mod __ml_rt {
    use std::io::Read;

    #[derive(Debug, Clone, PartialEq)]
    pub enum Value {
        Nil,
        Bool(bool),
        Int(i64),
        Real(f64),
        String(String),
        Symbol(String),
        List(Vec<Value>),
        Tuple(Vec<Value>),
        Set(Vec<Value>),
        Map(Vec<(Value, Value)>),
        Time(String),
        Uuid(String),
        Bytes(Vec<u8>),
    }

    impl Value {
        pub fn nil() -> Self { Value::Nil }
        pub fn bool(v: bool) -> Self { Value::Bool(v) }
        pub fn int(v: i64) -> Self { Value::Int(v) }
        pub fn real(v: f64) -> Self { Value::Real(v) }
        pub fn string(v: impl Into<String>) -> Self { Value::String(v.into()) }
        pub fn symbol(v: impl Into<String>) -> Self { Value::Symbol(v.into()) }
        pub fn list(v: impl IntoIterator<Item = Value>) -> Self { Value::List(v.into_iter().collect()) }
        pub fn tuple(v: impl IntoIterator<Item = Value>) -> Self { Value::Tuple(v.into_iter().collect()) }
        pub fn set(v: impl IntoIterator<Item = Value>) -> Self { Value::Set(v.into_iter().collect()) }
        pub fn map<K: Into<Value>, V: Into<Value>>(entries: impl IntoIterator<Item = (K, V)>) -> Self {
            Value::Map(entries.into_iter().map(|(k, v)| (k.into(), v.into())).collect())
        }
        pub fn time(iso: impl Into<String>) -> Self { Value::Time(iso.into()) }
        pub fn uuid(u: impl Into<String>) -> Self { Value::Uuid(u.into()) }
        pub fn bytes(b: impl Into<Vec<u8>>) -> Self { Value::Bytes(b.into()) }

        pub fn as_bool(&self) -> Option<bool> {
            match self { Value::Bool(b) => Some(*b), _ => None }
        }
        pub fn as_int(&self) -> Option<i64> {
            match self { Value::Int(n) => Some(*n), _ => None }
        }
        pub fn as_real(&self) -> Option<f64> {
            match self { Value::Real(f) => Some(*f), Value::Int(n) => Some(*n as f64), _ => None }
        }
        pub fn as_str(&self) -> Option<&str> {
            match self {
                Value::String(s) | Value::Symbol(s) | Value::Time(s) | Value::Uuid(s) => Some(s.as_str()),
                _ => None,
            }
        }
        pub fn as_list(&self) -> Option<&[Value]> {
            match self { Value::List(v) | Value::Tuple(v) | Value::Set(v) => Some(v.as_slice()), _ => None }
        }
        pub fn as_map(&self) -> Option<&[(Value, Value)]> {
            match self { Value::Map(m) => Some(m.as_slice()), _ => None }
        }
        pub fn as_bytes(&self) -> Option<&[u8]> {
            match self { Value::Bytes(b) => Some(b.as_slice()), _ => None }
        }

        pub fn to_tagged_json(&self) -> String {
            match self {
                Value::Nil => "{\"type\":\"nil\"}".to_string(),
                Value::Bool(b) => format!("{{\"type\":\"boolean\",\"value\":{}}}", b),
                Value::Int(n) => format!("{{\"type\":\"integer\",\"value\":{}}}", n),
                Value::Real(f) => {
                    if f.is_finite() { format!("{{\"type\":\"real\",\"value\":{}}}", f) }
                    else { "{\"type\":\"real\",\"value\":null}".to_string() }
                }
                Value::String(s) => format!("{{\"type\":\"string\",\"value\":{}}}", json_escape(s)),
                Value::Symbol(s) => format!("{{\"type\":\"symbol\",\"value\":{}}}", json_escape(s)),
                Value::Time(s) => format!("{{\"type\":\"time\",\"value\":{}}}", json_escape(s)),
                Value::Uuid(s) => format!("{{\"type\":\"uuid\",\"value\":{}}}", json_escape(s)),
                Value::Bytes(b) => format!("{{\"type\":\"bytes\",\"value\":{}}}", json_escape(&b64_encode(b))),
                Value::List(items) => {
                    let inner: Vec<String> = items.iter().map(|v| v.to_tagged_json()).collect();
                    format!("{{\"type\":\"list\",\"value\":[{}]}}", inner.join(","))
                }
                Value::Tuple(items) => {
                    let inner: Vec<String> = items.iter().map(|v| v.to_tagged_json()).collect();
                    format!("{{\"type\":\"tuple\",\"value\":[{}]}}", inner.join(","))
                }
                Value::Set(items) => {
                    let inner: Vec<String> = items.iter().map(|v| v.to_tagged_json()).collect();
                    format!("{{\"type\":\"set\",\"value\":[{}]}}", inner.join(","))
                }
                Value::Map(entries) => {
                    let all_str = entries.iter().all(|(k, _)| matches!(k, Value::String(_)));
                    if all_str {
                        let inner: Vec<String> = entries
                            .iter()
                            .map(|(k, v)| {
                                let ks = k.as_str().unwrap_or("");
                                format!("{}:{}", json_escape(ks), v.to_tagged_json())
                            })
                            .collect();
                        format!("{{\"type\":\"map\",\"value\":{{{}}}}}", inner.join(","))
                    } else {
                        let inner: Vec<String> = entries
                            .iter()
                            .map(|(k, v)| format!("[{},{}]", k.to_tagged_json(), v.to_tagged_json()))
                            .collect();
                        format!("{{\"type\":\"map\",\"value\":[{}]}}", inner.join(","))
                    }
                }
            }
        }
    }

    impl From<()> for Value { fn from(_: ()) -> Self { Value::Nil } }
    impl From<bool> for Value { fn from(v: bool) -> Self { Value::Bool(v) } }
    impl From<i32> for Value { fn from(v: i32) -> Self { Value::Int(v as i64) } }
    impl From<i64> for Value { fn from(v: i64) -> Self { Value::Int(v) } }
    impl From<isize> for Value { fn from(v: isize) -> Self { Value::Int(v as i64) } }
    impl From<u32> for Value { fn from(v: u32) -> Self { Value::Int(v as i64) } }
    impl From<usize> for Value { fn from(v: usize) -> Self { Value::Int(v as i64) } }
    impl From<f32> for Value { fn from(v: f32) -> Self { Value::Real(v as f64) } }
    impl From<f64> for Value { fn from(v: f64) -> Self { Value::Real(v) } }
    impl From<String> for Value { fn from(v: String) -> Self { Value::String(v) } }
    impl From<&str> for Value { fn from(v: &str) -> Self { Value::String(v.to_string()) } }
    impl<T: Into<Value>> From<Vec<T>> for Value {
        fn from(v: Vec<T>) -> Self { Value::List(v.into_iter().map(Into::into).collect()) }
    }
    impl<T: Into<Value>> From<Option<T>> for Value {
        fn from(v: Option<T>) -> Self { match v { Some(x) => x.into(), None => Value::Nil } }
    }

    pub trait IntoResult {
        fn into_result(self) -> Result<Value, String>;
    }
    impl<T: Into<Value>> IntoResult for T {
        fn into_result(self) -> Result<Value, String> { Ok(self.into()) }
    }
    impl<T: Into<Value>, E: std::fmt::Display> IntoResult for Result<T, E> {
        fn into_result(self) -> Result<Value, String> {
            match self {
                Ok(v) => Ok(v.into()),
                Err(e) => Err(e.to_string()),
            }
        }
    }

    pub trait FromValue: Sized {
        fn from_value(v: &Value) -> Result<Self, String>;
    }
    impl FromValue for Value {
        fn from_value(v: &Value) -> Result<Self, String> { Ok(v.clone()) }
    }
    impl FromValue for i64 {
        fn from_value(v: &Value) -> Result<Self, String> {
            v.as_int().ok_or_else(|| format!("expected integer, got {:?}", v))
        }
    }
    impl FromValue for i32 {
        fn from_value(v: &Value) -> Result<Self, String> {
            v.as_int().map(|n| n as i32).ok_or_else(|| format!("expected integer, got {:?}", v))
        }
    }
    impl FromValue for usize {
        fn from_value(v: &Value) -> Result<Self, String> {
            v.as_int().map(|n| n as usize).ok_or_else(|| format!("expected integer, got {:?}", v))
        }
    }
    impl FromValue for f64 {
        fn from_value(v: &Value) -> Result<Self, String> {
            v.as_real().ok_or_else(|| format!("expected real/number, got {:?}", v))
        }
    }
    impl FromValue for bool {
        fn from_value(v: &Value) -> Result<Self, String> {
            v.as_bool().ok_or_else(|| format!("expected boolean, got {:?}", v))
        }
    }
    impl FromValue for String {
        fn from_value(v: &Value) -> Result<Self, String> {
            v.as_str().map(|s| s.to_string()).ok_or_else(|| format!("expected string, got {:?}", v))
        }
    }
    impl<T: FromValue> FromValue for Vec<T> {
        fn from_value(v: &Value) -> Result<Self, String> {
            let slice = v.as_list().ok_or_else(|| format!("expected list, got {:?}", v))?;
            slice.iter().map(T::from_value).collect()
        }
    }
    impl<T: FromValue> FromValue for Option<T> {
        fn from_value(v: &Value) -> Result<Self, String> {
            match v { Value::Nil => Ok(None), other => Ok(Some(T::from_value(other)?)) }
        }
    }

    pub fn extract_arg<T: FromValue>(params: &Params, args: &[Value], idx: usize, name: &str) -> Result<T, String> {
        if let Some(v) = args.get(idx) {
            return T::from_value(v);
        }
        if let Some(v) = params.get(name) {
            return T::from_value(v);
        }
        Err(format!("Missing argument '{}' (index {})", name, idx))
    }

    #[derive(Debug, Clone, Default)]
    pub struct Params {
        pub entries: Vec<(String, Value)>,
    }

    impl Params {
        pub fn get(&self, key: &str) -> Option<&Value> {
            self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
        }
        pub fn get_str(&self, key: &str) -> Option<&str> { self.get(key).and_then(Value::as_str) }
        pub fn get_int(&self, key: &str) -> Option<i64> { self.get(key).and_then(Value::as_int) }
        pub fn get_real(&self, key: &str) -> Option<f64> { self.get(key).and_then(Value::as_real) }
        pub fn get_bool(&self, key: &str) -> Option<bool> { self.get(key).and_then(Value::as_bool) }
        pub fn get_list(&self, key: &str) -> Option<&[Value]> { self.get(key).and_then(Value::as_list) }
        pub fn get_map(&self, key: &str) -> Option<&[(Value, Value)]> { self.get(key).and_then(Value::as_map) }
    }

    pub fn display(mime: &str, data: impl AsRef<str>) {
        if let Ok(path) = std::env::var("__ML_DISPLAYS_FILE") {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(
                    f,
                    "{{\"mime\":{},\"data\":{}}}",
                    json_escape(mime),
                    json_escape(data.as_ref())
                );
            }
        }
    }
    pub fn html(s: impl AsRef<str>) { display("text/html", s); }
    pub fn svg(s: impl AsRef<str>) { display("image/svg+xml", s); }
    pub fn markdown(s: impl AsRef<str>) { display("text/markdown", s); }

    pub fn write_result_json(json: &str) {
        if let Ok(path) = std::env::var("__ML_RESULT_FILE") {
            let _ = std::fs::write(path, json);
        }
    }

    pub fn json_escape(s: &str) -> String {
        let mut out = String::with_capacity(s.len() + 2);
        out.push('"');
        for ch in s.chars() {
            match ch {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
        out
    }

    fn b64_encode(input: &[u8]) -> String {
        const TBL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in input.chunks(3) {
            let b0 = chunk[0] as u32;
            let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
            let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
            let n = (b0 << 16) | (b1 << 8) | b2;
            out.push(TBL[((n >> 18) & 63) as usize] as char);
            out.push(TBL[((n >> 12) & 63) as usize] as char);
            out.push(if chunk.len() > 1 { TBL[((n >> 6) & 63) as usize] as char } else { '=' });
            out.push(if chunk.len() > 2 { TBL[(n & 63) as usize] as char } else { '=' });
        }
        out
    }

    fn b64_decode(input: &str) -> Vec<u8> {
        let mut vals = Vec::new();
        for b in input.bytes() {
            if b.is_ascii_whitespace() { continue; }
            if b == b'=' { vals.push(64u8); continue; }
            let v = match b {
                b'A'..=b'Z' => b - b'A',
                b'a'..=b'z' => b - b'a' + 26,
                b'0'..=b'9' => b - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                _ => continue,
            };
            vals.push(v);
        }
        let mut out = Vec::new();
        for c in vals.chunks(4) {
            if c.len() < 4 || c[0] == 64 || c[1] == 64 { break; }
            out.push((c[0] << 2) | (c[1] >> 4));
            if c[2] != 64 {
                out.push((c[1] << 4) | (c[2] >> 2));
                if c[3] != 64 { out.push((c[2] << 6) | c[3]); }
            }
        }
        out
    }

    // Minimal pure-std JSON parser for stdin envelope
    #[derive(Debug, Clone)]
    enum JVal {
        Null,
        Bool(bool),
        Int(i64),
        Float(f64),
        Str(String),
        Arr(Vec<JVal>),
        Obj(Vec<(String, JVal)>),
    }

    struct JParser<'a> { b: &'a [u8], i: usize }
    impl<'a> JParser<'a> {
        fn skip(&mut self) {
            while self.i < self.b.len() && self.b[self.i].is_ascii_whitespace() { self.i += 1; }
        }
        fn parse(&mut self) -> Option<JVal> {
            self.skip();
            if self.i >= self.b.len() { return None; }
            match self.b[self.i] {
                b'n' => { self.i += 4; Some(JVal::Null) }
                b't' => { self.i += 4; Some(JVal::Bool(true)) }
                b'f' => { self.i += 5; Some(JVal::Bool(false)) }
                b'"' => Some(JVal::Str(self.parse_str()?)),
                b'[' => {
                    self.i += 1;
                    let mut arr = Vec::new();
                    self.skip();
                    if self.i < self.b.len() && self.b[self.i] == b']' { self.i += 1; return Some(JVal::Arr(arr)); }
                    loop {
                        arr.push(self.parse()?);
                        self.skip();
                        if self.i < self.b.len() && self.b[self.i] == b',' { self.i += 1; continue; }
                        if self.i < self.b.len() && self.b[self.i] == b']' { self.i += 1; break; }
                        return None;
                    }
                    Some(JVal::Arr(arr))
                }
                b'{' => {
                    self.i += 1;
                    let mut obj = Vec::new();
                    self.skip();
                    if self.i < self.b.len() && self.b[self.i] == b'}' { self.i += 1; return Some(JVal::Obj(obj)); }
                    loop {
                        self.skip();
                        let k = self.parse_str()?;
                        self.skip();
                        if self.i >= self.b.len() || self.b[self.i] != b':' { return None; }
                        self.i += 1;
                        let v = self.parse()?;
                        obj.push((k, v));
                        self.skip();
                        if self.i < self.b.len() && self.b[self.i] == b',' { self.i += 1; continue; }
                        if self.i < self.b.len() && self.b[self.i] == b'}' { self.i += 1; break; }
                        return None;
                    }
                    Some(JVal::Obj(obj))
                }
                _ => {
                    let s = self.i;
                    while self.i < self.b.len() && matches!(self.b[self.i], b'-'|b'+'|b'0'..=b'9'|b'.'|b'e'|b'E') {
                        self.i += 1;
                    }
                    let txt = std::str::from_utf8(&self.b[s..self.i]).ok()?;
                    if txt.contains('.') || txt.contains('e') || txt.contains('E') {
                        Some(JVal::Float(txt.parse().ok()?))
                    } else {
                        Some(JVal::Int(txt.parse().ok()?))
                    }
                }
            }
        }
        fn parse_str(&mut self) -> Option<String> {
            if self.b.get(self.i) != Some(&b'"') { return None; }
            self.i += 1;
            let mut out = String::new();
            while self.i < self.b.len() {
                let c = self.b[self.i];
                self.i += 1;
                if c == b'"' { return Some(out); }
                if c == b'\\' && self.i < self.b.len() {
                    let e = self.b[self.i];
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'b' => out.push('\x08'),
                        b'f' => out.push('\x0c'),
                        b'u' if self.i + 4 <= self.b.len() => {
                            let hex = std::str::from_utf8(&self.b[self.i..self.i+4]).ok()?;
                            self.i += 4;
                            if let Ok(cp) = u32::from_str_radix(hex, 16) {
                                if let Some(ch) = char::from_u32(cp) { out.push(ch); }
                            }
                        }
                        _ => out.push(e as char),
                    }
                } else {
                    // UTF-8 multi-byte safe decoding
                    let start = self.i - 1;
                    let len = if c < 0x80 { 1 } else if c < 0xE0 { 2 } else if c < 0xF0 { 3 } else { 4 };
                    let end = (start + len).min(self.b.len());
                    if let Ok(s) = std::str::from_utf8(&self.b[start..end]) { out.push_str(s); }
                    self.i = end;
                }
            }
            None
        }
    }

    fn obj_get<'a>(entries: &'a [(String, JVal)], key: &str) -> Option<&'a JVal> {
        entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    fn jval_to_tagged(j: &JVal) -> Value {
        let entries = match j { JVal::Obj(e) => e, _ => return Value::Nil };
        let ty = match obj_get(entries, "type") { Some(JVal::Str(s)) => s.as_str(), _ => return Value::Nil };
        let val = obj_get(entries, "value");
        match ty {
            "nil" => Value::Nil,
            "boolean" => match val { Some(JVal::Bool(b)) => Value::Bool(*b), _ => Value::Nil },
            "integer" => match val { Some(JVal::Int(n)) => Value::Int(*n), _ => Value::Nil },
            "real" => match val {
                Some(JVal::Float(f)) => Value::Real(*f),
                Some(JVal::Int(n)) => Value::Real(*n as f64),
                _ => Value::Nil,
            },
            "string" => match val { Some(JVal::Str(s)) => Value::String(s.clone()), _ => Value::Nil },
            "symbol" => match val { Some(JVal::Str(s)) => Value::Symbol(s.clone()), _ => Value::Nil },
            "time" => match val {
                Some(JVal::Str(s)) => Value::Time(s.clone()),
                Some(JVal::Int(n)) => Value::Time(n.to_string()),
                Some(JVal::Float(f)) => Value::Time(f.to_string()),
                _ => Value::Nil,
            },
            "uuid" => match val { Some(JVal::Str(s)) => Value::Uuid(s.clone()), _ => Value::Nil },
            "bytes" => match val { Some(JVal::Str(s)) => Value::Bytes(b64_decode(s)), _ => Value::Nil },
            "list" => match val { Some(JVal::Arr(a)) => Value::List(a.iter().map(jval_to_tagged).collect()), _ => Value::List(Vec::new()) },
            "tuple" => match val { Some(JVal::Arr(a)) => Value::Tuple(a.iter().map(jval_to_tagged).collect()), _ => Value::Tuple(Vec::new()) },
            "set" => match val { Some(JVal::Arr(a)) => Value::Set(a.iter().map(jval_to_tagged).collect()), _ => Value::Set(Vec::new()) },
            "map" => match val {
                Some(JVal::Obj(m)) => Value::Map(m.iter().map(|(k, v)| (Value::String(k.clone()), jval_to_tagged(v))).collect()),
                Some(JVal::Arr(pairs)) => {
                    let mut out = Vec::new();
                    for p in pairs {
                        if let JVal::Arr(ab) = p {
                            if ab.len() == 2 {
                                out.push((jval_to_tagged(&ab[0]), jval_to_tagged(&ab[1])));
                            }
                        }
                    }
                    Value::Map(out)
                }
                _ => Value::Map(Vec::new()),
            },
            _ => Value::Nil,
        }
    }

    pub fn read_stdin_envelope() -> (Params, Vec<Value>) {
        let mut raw = String::new();
        let _ = std::io::stdin().read_to_string(&mut raw);
        let mut p = JParser { b: raw.as_bytes(), i: 0 };
        let root = match p.parse() { Some(JVal::Obj(e)) => e, _ => return (Params::default(), Vec::new()) };
        let mut params = Params::default();
        if let Some(JVal::Obj(pe)) = obj_get(&root, "params") {
            for (k, v) in pe {
                params.entries.push((k.clone(), jval_to_tagged(v)));
            }
        }
        let mut args = Vec::new();
        if let Some(JVal::Arr(ae)) = obj_get(&root, "args") {
            for a in ae {
                args.push(jval_to_tagged(a));
            }
        }
        (params, args)
    }
}
"#;

// ============================================================================
// Cargo Dependency Extraction & Fast Shared-Target Building
// ============================================================================

#[derive(Debug, Default, Clone)]
pub struct ExtractedRustCode {
    pub code: String,
    pub dependencies: BTreeMap<String, String>,
    pub show_deps: bool,
}

/// Extract Cargo dependencies declared via any of the 3 supported Rust script/notebook conventions:
/// 1. Evcxr-style directives: `:dep serde_json = "1.0"` or `//:dep chrono = { version = "0.4", features = ["serde"] }`
/// 2. Cargo script RFC 3424 frontmatter:
///    ```
///    ---cargo
///    [dependencies]
///    serde_json = "1.0"
///    ---
///    ```
/// 3. Doc-comment manifest block:
///    ```
///    //! ```cargo
///    //! [dependencies]
///    //! serde_json = "1.0"
///    //! ```
///    ```
/// Relative `path = "..."` entries are automatically resolved against `cwd`.
pub fn extract_rust_dependencies(code: &str, cwd: &Path) -> ExtractedRustCode {
    let mut out = ExtractedRustCode::default();
    let lines: Vec<&str> = code.lines().collect();
    let mut kept: Vec<String> = Vec::with_capacity(lines.len());
    let mut i = 0;

    // 1. Optional leading shebang + RFC 3424 `---cargo` / `---` frontmatter
    while i < lines.len() && lines[i].trim().is_empty() {
        kept.push(lines[i].to_string());
        i += 1;
    }
    if i < lines.len() && lines[i].starts_with("#!") && !lines[i].starts_with("#![") {
        // Skip shebang line
        i += 1;
        while i < lines.len() && lines[i].trim().is_empty() {
            kept.push(lines[i].to_string());
            i += 1;
        }
    }
    if i < lines.len() {
        let trimmed = lines[i].trim();
        if trimmed == "---cargo" || trimmed == "---" {
            // Find matching closing `---`
            if let Some(rel_end) = lines[i + 1..].iter().position(|l| l.trim() == "---") {
                let end_idx = i + 1 + rel_end;
                let block = lines[i + 1..end_idx].join("\n");
                parse_cargo_toml_deps(&block, cwd, &mut out.dependencies);
                i = end_idx + 1;
            }
        }
    }

    // 2. Scan remaining lines for `//! ```cargo ... //! ``` ` blocks and `:dep` / `:deps` lines
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();

        // Check `//! ```cargo` doc-comment manifest block
        if let Some(doc) = trimmed.strip_prefix("//!") {
            let doc_t = doc.trim();
            if doc_t == "```cargo" || doc_t == "```toml" {
                let mut manifest_lines = Vec::new();
                let mut j = i + 1;
                let mut closed = false;
                while j < lines.len() {
                    let lt = lines[j].trim();
                    if let Some(d) = lt.strip_prefix("//!") {
                        let dt = d.trim();
                        if dt == "```" {
                            closed = true;
                            j += 1;
                            break;
                        }
                        manifest_lines.push(d.trim_start());
                        j += 1;
                    } else {
                        break;
                    }
                }
                if closed {
                    let block = manifest_lines.join("\n");
                    parse_cargo_toml_deps(&block, cwd, &mut out.dependencies);
                    i = j;
                    continue;
                }
            }
        }

        // Check Evcxr-style `:dep ...` / `//:dep ...` / `//! :dep ...` and `:deps`
        let directive = trimmed
            .strip_prefix("//!")
            .or_else(|| trimmed.strip_prefix("//"))
            .unwrap_or(trimmed)
            .trim_start();

        if directive == ":deps" {
            out.show_deps = true;
            i += 1;
            continue;
        }

        if let Some(spec) = directive.strip_prefix(":dep") {
            if spec.is_empty() || spec.starts_with(char::is_whitespace) {
                let spec = spec.trim();
                if !spec.is_empty() {
                    if let Some((name, val)) = parse_dep_entry(spec, cwd) {
                        out.dependencies.insert(name, val);
                    }
                }
                i += 1;
                continue;
            }
        }

        kept.push(line.to_string());
        i += 1;
    }

    out.code = kept.join("\n");
    out
}

fn parse_cargo_toml_deps(toml_block: &str, cwd: &Path, deps: &mut BTreeMap<String, String>) {
    // Support both `[dependencies]` section and bare `crate = "ver"` lines when no section header is present
    let mut in_deps = true;
    let mut saw_section = false;
    let mut pending_line = String::new();
    let mut brace_depth: i32 = 0;

    let flush = |line: &str, cwd: &Path, deps: &mut BTreeMap<String, String>| {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            return;
        }
        if let Some((k, v)) = parse_dep_entry(t, cwd) {
            deps.insert(k, v);
        }
    };

    for raw_line in toml_block.lines() {
        let line = strip_toml_line_comment(raw_line).trim();
        if line.is_empty() {
            continue;
        }
        if brace_depth == 0 && line.starts_with('[') && line.ends_with(']') {
            if !pending_line.is_empty() {
                if in_deps {
                    flush(&pending_line, cwd, deps);
                }
                pending_line.clear();
            }
            let section = line[1..line.len() - 1].trim();
            saw_section = true;
            in_deps = section == "dependencies";
            continue;
        }
        if saw_section && !in_deps {
            continue;
        }

        if !pending_line.is_empty() {
            pending_line.push(' ');
        }
        pending_line.push_str(line);

        let mut in_str = false;
        let mut prev_esc = false;
        for ch in line.chars() {
            if in_str {
                if prev_esc {
                    prev_esc = false;
                } else if ch == '\\' {
                    prev_esc = true;
                } else if ch == '"' {
                    in_str = false;
                }
            } else {
                match ch {
                    '"' => in_str = true,
                    '{' | '[' => brace_depth += 1,
                    '}' | ']' => brace_depth -= 1,
                    _ => {}
                }
            }
        }

        if brace_depth <= 0 {
            brace_depth = 0;
            flush(&pending_line, cwd, deps);
            pending_line.clear();
        }
    }

    if !pending_line.is_empty() && in_deps {
        flush(&pending_line, cwd, deps);
    }
}

fn strip_toml_line_comment(line: &str) -> &str {
    let mut in_dq = false;
    let mut in_sq = false;
    let mut esc = false;
    for (idx, ch) in line.char_indices() {
        if in_dq {
            if esc {
                esc = false;
            } else if ch == '\\' {
                esc = true;
            } else if ch == '"' {
                in_dq = false;
            }
        } else if in_sq {
            if ch == '\'' {
                in_sq = false;
            }
        } else {
            match ch {
                '"' => in_dq = true,
                '\'' => in_sq = true,
                '#' => return &line[..idx],
                _ => {}
            }
        }
    }
    line
}

fn parse_dep_entry(entry: &str, cwd: &Path) -> Option<(String, String)> {
    let entry = strip_toml_line_comment(entry).trim();
    if entry.is_empty() {
        return None;
    }
    let (raw_name, raw_val) = match entry.split_once('=') {
        Some((n, v)) => (n.trim(), v.trim()),
        None => (entry, "\"*\""),
    };
    let name = raw_name.trim_matches('"').trim_matches('\'').to_string();
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    let val = if raw_val.is_empty() {
        "\"*\"".to_string()
    } else {
        resolve_relative_path_dep(raw_val, cwd)
    };
    Some((name, val))
}

/// If a TOML inline table dependency contains `path = "relative/dir"`, resolve it against `cwd`.
fn resolve_relative_path_dep(spec: &str, cwd: &Path) -> String {
    let bytes = spec.as_bytes();
    let mut i = 0;
    let mut out = String::with_capacity(spec.len());

    while i < bytes.len() {
        // Look for `path` key followed by optional whitespace, `=`, optional whitespace, `"`
        if spec[i..].starts_with("path")
            && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric() && bytes[i - 1] != b'_')
        {
            let mut j = i + 4;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'=' {
                j += 1;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'') {
                    let quote = bytes[j];
                    let str_start = j + 1;
                    let mut k = str_start;
                    while k < bytes.len() && bytes[k] != quote {
                        if quote == b'"' && bytes[k] == b'\\' && k + 1 < bytes.len() {
                            k += 2;
                        } else {
                            k += 1;
                        }
                    }
                    if k < bytes.len() {
                        let raw_path = &spec[str_start..k];
                        let p = Path::new(raw_path);
                        let resolved = if p.is_relative() {
                            let joined = cwd.join(p);
                            std::fs::canonicalize(&joined).unwrap_or(joined)
                        } else {
                            p.to_path_buf()
                        };
                        let resolved_str = resolved.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
                        out.push_str(&spec[i..j]);
                        out.push('"');
                        out.push_str(&resolved_str);
                        out.push('"');
                        i = k + 1;
                        continue;
                    }
                }
            }
        }
        let ch = spec[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

pub fn cargo_shared_target_dir() -> PathBuf {
    std::env::temp_dir()
        .join("minilang-notebook-rust-cache")
        .join("cargo-target")
}

pub fn generate_cargo_toml(pkg_name: &str, deps: &BTreeMap<String, String>) -> String {
    let mut s = format!(
        "[package]\nname = {:?}\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[profile.dev]\nopt-level = 0\ndebug = 0\nincremental = true\n\n[dependencies]\n",
        pkg_name
    );
    for (name, spec) in deps {
        s.push_str(name);
        s.push_str(" = ");
        s.push_str(spec);
        s.push('\n');
    }
    s
}

fn should_retry_cargo_online(stderr: &str) -> bool {
    if std::env::var("MINILANG_RUST_OFFLINE").as_deref() == Ok("1") {
        return false;
    }
    let lower = stderr.to_lowercase();
    lower.contains("--offline")
        || lower.contains("offline")
        || lower.contains("failed to select a version")
        || lower.contains("no matching package")
        || lower.contains("not found in")
        || lower.contains("cannot update")
}

/// Synchronous Cargo build helper (used by the Rust REPL kernel subprocess).
/// Tries `--offline` first (0ms network overhead for cached crates), then automatically
/// retries online if a requested dependency isn't in the local cargo cache yet.
pub fn build_cargo_project_sync(
    proj_dir: &Path,
    pkg_name: &str,
    deps: &BTreeMap<String, String>,
    src_code: &str,
    last_cargo_toml: &mut String,
) -> Result<PathBuf, String> {
    let src_dir = proj_dir.join("src");
    std::fs::create_dir_all(&src_dir).map_err(|e| format!("Failed to create crate dir: {}", e))?;
    let target_dir = cargo_shared_target_dir();
    let _ = std::fs::create_dir_all(&target_dir);

    let manifest_path = proj_dir.join("Cargo.toml");
    let toml_text = generate_cargo_toml(pkg_name, deps);
    if toml_text != *last_cargo_toml || !manifest_path.exists() {
        std::fs::write(&manifest_path, &toml_text)
            .map_err(|e| format!("Failed to write Cargo.toml: {}", e))?;
        *last_cargo_toml = toml_text;
    }

    let main_rs = src_dir.join("main.rs");
    std::fs::write(&main_rs, src_code)
        .map_err(|e| format!("Failed to write src/main.rs: {}", e))?;

    let run_cargo = |offline: bool| -> Result<std::process::Output, String> {
        let mut cmd = std::process::Command::new("cargo");
        cmd.arg("build")
            .arg("--manifest-path")
            .arg(&manifest_path)
            .arg("--color=never")
            .env("CARGO_TARGET_DIR", &target_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if offline {
            cmd.arg("--offline");
        }
        cmd.output().map_err(|e| format!("Failed to launch cargo: {}", e))
    };

    let mut out = run_cargo(true)?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if should_retry_cargo_online(&stderr) {
            out = run_cargo(false)?;
        }
    }

    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }

    let bin_path = target_dir.join("debug").join(pkg_name);
    if !bin_path.exists() {
        return Err(format!("Cargo succeeded but binary not found at {}", bin_path.display()));
    }
    Ok(bin_path)
}

/// Async Cargo build helper with timeout (used by `RustBackend::invoke_script`).
pub async fn build_cargo_project_async(
    proj_dir: &Path,
    pkg_name: &str,
    deps: &BTreeMap<String, String>,
    src_code: &str,
    timeout_ms: u64,
) -> Result<Result<PathBuf, String>, InvokeExecError> {
    let src_dir = proj_dir.join("src");
    std::fs::create_dir_all(&src_dir)
        .map_err(|e| InvokeExecError::Internal(format!("Failed to create crate dir: {}", e)))?;
    let target_dir = cargo_shared_target_dir();
    let _ = std::fs::create_dir_all(&target_dir);

    let manifest_path = proj_dir.join("Cargo.toml");
    let toml_text = generate_cargo_toml(pkg_name, deps);
    std::fs::write(&manifest_path, &toml_text)
        .map_err(|e| InvokeExecError::Internal(format!("Failed to write Cargo.toml: {}", e)))?;
    std::fs::write(src_dir.join("main.rs"), src_code)
        .map_err(|e| InvokeExecError::Internal(format!("Failed to write src/main.rs: {}", e)))?;

    let start = Instant::now();
    let run_cargo = |offline: bool, rem_ms: u64| {
        let mut cmd = Command::new("cargo");
        cmd.arg("build")
            .arg("--manifest-path")
            .arg(&manifest_path)
            .arg("--color=never")
            .env("CARGO_TARGET_DIR", &target_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if offline {
            cmd.arg("--offline");
        }
        async move {
            match tokio::time::timeout(Duration::from_millis(rem_ms.max(100)), cmd.output()).await {
                Ok(Ok(o)) => Ok(o),
                Ok(Err(e)) => Err(InvokeExecError::Internal(format!("Failed to spawn cargo: {}", e))),
                Err(_) => Err(InvokeExecError::Timeout(timeout_ms)),
            }
        }
    };

    let mut out = run_cargo(true, timeout_ms).await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        if should_retry_cargo_online(&stderr) {
            let elapsed = start.elapsed().as_millis() as u64;
            if elapsed >= timeout_ms {
                return Err(InvokeExecError::Timeout(timeout_ms));
            }
            out = run_cargo(false, timeout_ms - elapsed).await?;
        }
    }

    if !out.status.success() {
        return Ok(Err(String::from_utf8_lossy(&out.stderr).into_owned()));
    }

    let bin_path = target_dir.join("debug").join(pkg_name);
    if !bin_path.exists() {
        return Err(InvokeExecError::Internal(format!(
            "Cargo succeeded but binary not found at {}",
            bin_path.display()
        )));
    }
    Ok(Ok(bin_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_evcxr_dep_directives() {
        let src = r#"
:dep serde_json = "1.0"
//:dep chrono = { version = "0.4", features = ["serde"] }
//! :dep mylib = { path = "local_crate" }
let v = serde_json::json!({"ok": true});
v
"#;
        let cwd = Path::new("/tmp/workspace");
        let ext = extract_rust_dependencies(src, cwd);
        assert_eq!(ext.dependencies.get("serde_json").map(String::as_str), Some("\"1.0\""));
        assert_eq!(
            ext.dependencies.get("chrono").map(String::as_str),
            Some("{ version = \"0.4\", features = [\"serde\"] }")
        );
        assert_eq!(
            ext.dependencies.get("mylib").map(String::as_str),
            Some("{ path = \"/tmp/workspace/local_crate\" }")
        );
        assert!(!ext.code.contains(":dep"));
        assert!(ext.code.contains("serde_json::json!"));
    }

    #[test]
    fn test_extract_frontmatter_and_doc_block() {
        let fm = r#"---cargo
[dependencies]
serde = { version = "1.0", features = ["derive"] }
uuid = { version = "1", features = ["v4"] }
---
let id = uuid::Uuid::new_v4();
id.to_string()
"#;
        let ext1 = extract_rust_dependencies(fm, Path::new("/tmp"));
        assert_eq!(ext1.dependencies.len(), 2);
        assert!(ext1.dependencies.contains_key("serde"));
        assert!(ext1.dependencies.contains_key("uuid"));
        assert!(!ext1.code.contains("---cargo"));

        let doc = r#"//! ```cargo
//! [dependencies]
//! rand = "0.8"
//! ```
let x: u8 = rand::random();
x
"#;
        let ext2 = extract_rust_dependencies(doc, Path::new("/tmp"));
        assert_eq!(ext2.dependencies.get("rand").map(String::as_str), Some("\"0.8\""));
        assert!(!ext2.code.contains("```cargo"));
    }
}

