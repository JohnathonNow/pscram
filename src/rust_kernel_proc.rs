use crate::kernel_proc::{
    CompletionItem, EvalError, EvalValue, KernelRequest, KernelResponse, VarInfo,
};
use crate::lang::rust_lang::{
    build_cargo_project_sync, extract_rust_dependencies, read_displays_file, split_rust_source,
    RUST_TAGGED_PRELUDE,
};
use crate::tagged::TaggedValue;
use std::collections::{BTreeMap, HashSet};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Instant;

const RUST_KEYWORDS: &[&str] = &[
    "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum",
    "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move",
    "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true",
    "type", "unsafe", "use", "where", "while",
];

const RUST_PRELUDE_ITEMS: &[(&str, &str, &str)] = &[
    ("println!", "macro", "std::println!"),
    ("print!", "macro", "std::print!"),
    ("format!", "macro", "std::format!"),
    ("vec!", "macro", "std::vec!"),
    ("dbg!", "macro", "std::dbg!"),
    ("assert!", "macro", "std::assert!"),
    ("assert_eq!", "macro", "std::assert_eq!"),
    ("html", "function", "fn(&str)"),
    ("svg", "function", "fn(&str)"),
    ("markdown", "function", "fn(&str)"),
    ("image", "function", "fn(&str)"),
    ("image_bytes", "function", "fn(&[u8], &str)"),
    ("pdf", "function", "fn(&str)"),
    ("pdf_bytes", "function", "fn(&[u8])"),
    ("preview", "function", "fn(&str)"),
    ("table", "function", "fn(&str)"),
    ("chart", "function", "fn(&str)"),
    ("progress", "function", "fn(f64, f64, &str)"),
    ("secret", "function", "fn(&str) -> Option<String>"),
    ("display", "function", "fn(&str, &str)"),
    ("params", "variable", "Params (script input parameters)"),
    ("args", "variable", "Vec<Value> (positional arguments)"),
    ("Params", "type", "Script input parameters map"),
    ("Value", "type", "Tagged JSON value"),
    ("Vec", "type", "std::vec::Vec"),
    ("String", "type", "std::string::String"),
    ("Option", "type", "std::option::Option"),
    ("Result", "type", "std::result::Result"),
    ("HashMap", "type", "std::collections::HashMap"),
    ("HashSet", "type", "std::collections::HashSet"),
    ("BTreeMap", "type", "std::collections::BTreeMap"),
    ("Box", "type", "std::boxed::Box"),
    ("Some", "variant", "Option::Some"),
    ("None", "variant", "Option::None"),
    ("Ok", "variant", "Result::Ok"),
    ("Err", "variant", "Result::Err"),
];

struct RustReplState {
    session_dir: PathBuf,
    crate_pkg_name: String,
    items: Vec<String>,
    /// Prior committed cell bodies (executed with stdout suppressed when replaying)
    past_statements: Vec<String>,
    /// Tracked variable names (`let [mut] <ident>`) for the Variable Inspector
    tracked_vars: Vec<String>,
    /// Accumulated Cargo dependencies (`:dep ...`, `---cargo`, `//! ```cargo`)
    dependencies: BTreeMap<String, String>,
    /// Cached Cargo.toml contents so mtime stays untouched when deps don't change
    last_cargo_toml: String,
    /// Last inspected variable snapshot (updated automatically after each successful cell!)
    last_vars: Vec<VarInfo>,
    /// Active script/cell parameters passed via `KernelRequest::Eval { params, .. }`
    active_params: BTreeMap<String, TaggedValue>,
    exec_count: u64,
}

impl RustReplState {
    fn new() -> io::Result<Self> {
        let id = uuid::Uuid::new_v4().to_string();
        let short = id.split('-').next().unwrap_or("session");
        let dir = std::env::temp_dir().join(format!("mlnb-rust-repl-{}", id));
        std::fs::create_dir_all(&dir)?;
        Ok(Self {
            session_dir: dir,
            crate_pkg_name: format!("mlnb_repl_{}", short),
            items: Vec::new(),
            past_statements: Vec::new(),
            tracked_vars: Vec::new(),
            dependencies: BTreeMap::new(),
            last_cargo_toml: String::new(),
            last_vars: Vec::new(),
            active_params: BTreeMap::new(),
            exec_count: 0,
        })
    }

    fn eval_cell(
        &mut self,
        code: &str,
        params: Option<&BTreeMap<String, TaggedValue>>,
        mut stream: Option<&mut dyn Write>,
    ) -> KernelResponse {
        self.exec_count += 1;
        if let Some(p) = params {
            self.active_params = p.clone();
        }
        let start = Instant::now();
        let emit = |stream: &mut Option<&mut dyn Write>, event: &str, data: serde_json::Value| {
            if let Some(w) = stream.as_mut() {
                let msg = KernelResponse::StreamEvent {
                    event: event.to_string(),
                    data,
                };
                if let Ok(encoded) = serde_json::to_string(&msg) {
                    let _ = writeln!(w, "{}", encoded);
                    let _ = w.flush();
                }
            }
        };
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let extracted = extract_rust_dependencies(code, &cwd);
        let split = split_rust_source(&extracted.code);

        // Merge any newly declared Cargo dependencies into a candidate map (only committed on success!)
        let mut merged_deps = self.dependencies.clone();
        let mut added_deps = Vec::new();
        for (name, spec) in &extracted.dependencies {
            if merged_deps.get(name) != Some(spec) {
                added_deps.push(format!("{} = {}", name, spec));
            }
            merged_deps.insert(name.clone(), spec.clone());
        }

        let has_code = !split.items.is_empty()
            || !split.statements.is_empty()
            || split.trailing_expr.is_some();

        if !has_code && added_deps.is_empty() {
            let mut stdout = String::new();
            if extracted.show_deps {
                if self.dependencies.is_empty() {
                    stdout.push_str("No Cargo dependencies loaded. Add one with: :dep serde_json = \"1.0\"\n");
                } else {
                    stdout.push_str("Loaded Cargo dependencies:\n");
                    for (k, v) in &self.dependencies {
                        stdout.push_str(&format!("  {} = {}\n", k, v));
                    }
                }
            }
            return KernelResponse::EvalResult {
                execution_count: self.exec_count,
                stdout,
                displays: Vec::new(),
                results: Vec::new(),
                error: None,
                duration_ms: start.elapsed().as_secs_f64() * 1000.0,
                memory_bytes: None,
                memory_delta_bytes: None,
            };
        }

        // Collect newly declared `let` variable names in this cell
        let new_vars = extract_let_idents(&split.statements);
        let mut all_vars = self.tracked_vars.clone();
        for v in &new_vars {
            if !all_vars.contains(v) {
                all_vars.push(v.clone());
            }
        }

        let harness = self.build_repl_harness(&split, &all_vars);
        let src_path = self.session_dir.join(format!("cell_{}.rs", self.exec_count));
        let mut bin_path = self.session_dir.join(format!("cell_{}", self.exec_count));
        let res_path = self.session_dir.join(format!("cell_{}_res.json", self.exec_count));
        let vars_path = self.session_dir.join(format!("cell_{}_vars.jsonl", self.exec_count));
        let disp_path = self.session_dir.join(format!("cell_{}_disp.jsonl", self.exec_count));
        let params_path = self.session_dir.join(format!("cell_{}_params.json", self.exec_count));
        let params_payload = serde_json::json!({
            "params": &self.active_params,
            "args": [],
        });
        let _ = std::fs::write(&params_path, params_payload.to_string());
        let used_cargo = !merged_deps.is_empty();

        if !used_cargo {
            emit(&mut stream, "status", serde_json::json!({ "text": "Compiling with rustc..." }));
            if let Err(e) = std::fs::write(&src_path, &harness) {
                return KernelResponse::EvalResult {
                    execution_count: self.exec_count,
                    stdout: String::new(),
                    displays: Vec::new(),
                    results: Vec::new(),
                    error: Some(EvalError {
                        error_type: "IoError".to_string(),
                        message: format!("Failed to write temporary Rust source: {}", e),
                        traceback: String::new(),
                    }),
                    duration_ms: start.elapsed().as_secs_f64() * 1000.0,
                    memory_bytes: None,
                    memory_delta_bytes: None,
                };
            }

            let compile = Command::new("rustc")
                .args(["--edition", "2021", "-C", "opt-level=0", "-C", "debuginfo=0"])
                .arg(&src_path)
                .arg("-o")
                .arg(&bin_path)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output();

            let compile_out = match compile {
                Ok(o) => o,
                Err(e) => {
                    return KernelResponse::EvalResult {
                        execution_count: self.exec_count,
                        stdout: String::new(),
                        displays: Vec::new(),
                        results: Vec::new(),
                        error: Some(EvalError {
                            error_type: "CompileError".to_string(),
                            message: format!("Failed to launch rustc: {}", e),
                            traceback: String::new(),
                        }),
                        duration_ms: start.elapsed().as_secs_f64() * 1000.0,
                        memory_bytes: None,
                        memory_delta_bytes: None,
                    };
                }
            };

            if !compile_out.status.success() {
                let diag = String::from_utf8_lossy(&compile_out.stderr).into_owned();
                let _ = std::fs::remove_file(&src_path);
                return KernelResponse::EvalResult {
                    execution_count: self.exec_count,
                    stdout: String::new(),
                    displays: Vec::new(),
                    results: Vec::new(),
                    error: Some(EvalError {
                        error_type: "CompileError".to_string(),
                        message: "Rust compilation failed".to_string(),
                        traceback: diag,
                    }),
                    duration_ms: start.elapsed().as_secs_f64() * 1000.0,
                    memory_bytes: None,
                    memory_delta_bytes: None,
                };
            }
        } else {
            emit(&mut stream, "status", serde_json::json!({ "text": "Building with Cargo..." }));
            let crate_dir = self.session_dir.join("crate");
            let mut candidate_toml = self.last_cargo_toml.clone();
            match build_cargo_project_sync(
                &crate_dir,
                &self.crate_pkg_name,
                &merged_deps,
                &harness,
                &mut candidate_toml,
            ) {
                Ok(built) => {
                    self.last_cargo_toml = candidate_toml;
                    bin_path = built;
                }
                Err(diag) => {
                    // Restore previous Cargo.toml if it existed so failed deps don't poison the crate
                    if !self.last_cargo_toml.is_empty() {
                        let _ = std::fs::write(crate_dir.join("Cargo.toml"), &self.last_cargo_toml);
                    }
                    return KernelResponse::EvalResult {
                        execution_count: self.exec_count,
                        stdout: String::new(),
                        displays: Vec::new(),
                        results: Vec::new(),
                        error: Some(EvalError {
                            error_type: "CompileError".to_string(),
                            message: "Cargo compilation failed".to_string(),
                            traceback: diag,
                        }),
                        duration_ms: start.elapsed().as_secs_f64() * 1000.0,
                        memory_bytes: None,
                        memory_delta_bytes: None,
                    };
                }
            }
        }

        emit(&mut stream, "status", serde_json::json!({ "text": "Running..." }));

        let mut stdout = String::new();
        let mut stderr = String::new();
        let exit_status;

        if stream.is_some() {
            let mut child = match Command::new(&bin_path)
                .env("__ML_RES_FILE", &res_path)
                .env("__ML_VARS_FILE", &vars_path)
                .env("__ML_DISPLAYS_FILE", &disp_path)
                .env("__ML_PARAMS_FILE", &params_path)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
            {
                Ok(c) => c,
                Err(e) => {
                    if !used_cargo {
                        let _ = std::fs::remove_file(&bin_path);
                        let _ = std::fs::remove_file(&src_path);
                    }
                    return KernelResponse::EvalResult {
                        execution_count: self.exec_count,
                        stdout: String::new(),
                        displays: Vec::new(),
                        results: Vec::new(),
                        error: Some(EvalError {
                            error_type: "RuntimeError".to_string(),
                            message: format!("Failed to execute compiled cell: {}", e),
                            traceback: String::new(),
                        }),
                        duration_ms: start.elapsed().as_secs_f64() * 1000.0,
                        memory_bytes: None,
                        memory_delta_bytes: None,
                    };
                }
            };

            let child_stdout = child.stdout.take();
            let child_stderr = child.stderr.take();

            let (tx, rx) = std::sync::mpsc::channel::<(bool, String)>();
            let tx_err = tx.clone();
            let stdout_handle = std::thread::spawn(move || {
                if let Some(mut s) = child_stdout {
                    use std::io::Read;
                    let mut buf = [0u8; 2048];
                    loop {
                        match s.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                                let _ = tx.send((true, chunk));
                            }
                        }
                    }
                }
            });
            let stderr_handle = std::thread::spawn(move || {
                if let Some(mut s) = child_stderr {
                    use std::io::Read;
                    let mut buf = [0u8; 2048];
                    loop {
                        match s.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                                let _ = tx_err.send((false, chunk));
                            }
                        }
                    }
                }
            });

            let mut disp_lines_emitted = 0usize;
            loop {
                while let Ok((is_out, chunk)) = rx.try_recv() {
                    if is_out {
                        stdout.push_str(&chunk);
                        emit(&mut stream, "stdout", serde_json::json!({ "text": chunk }));
                    } else {
                        stderr.push_str(&chunk);
                    }
                }
                if let Ok(content) = std::fs::read_to_string(&disp_path) {
                    let lines: Vec<&str> = content.lines().collect();
                    while disp_lines_emitted < lines.len() {
                        if let Ok(item) = serde_json::from_str::<crate::kernel_proc::DisplayItem>(lines[disp_lines_emitted]) {
                            if item.mime == "application/vnd.minilang.progress+json" {
                                let parsed = serde_json::from_str::<serde_json::Value>(&item.data)
                                    .unwrap_or_else(|_| serde_json::json!({ "percent": 0 }));
                                emit(&mut stream, "progress", parsed);
                            } else {
                                emit(&mut stream, "display", serde_json::json!({ "mime": item.mime, "data": item.data }));
                            }
                        }
                        disp_lines_emitted += 1;
                    }
                }
                if let Ok(Some(st)) = child.try_wait() {
                    exit_status = st;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            let _ = stdout_handle.join();
            let _ = stderr_handle.join();
            while let Ok((is_out, chunk)) = rx.try_recv() {
                if is_out {
                    stdout.push_str(&chunk);
                    emit(&mut stream, "stdout", serde_json::json!({ "text": chunk }));
                } else {
                    stderr.push_str(&chunk);
                }
            }
        } else {
            let run = Command::new(&bin_path)
                .env("__ML_RES_FILE", &res_path)
                .env("__ML_VARS_FILE", &vars_path)
                .env("__ML_DISPLAYS_FILE", &disp_path)
                .env("__ML_PARAMS_FILE", &params_path)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output();
            match run {
                Ok(o) => {
                    stdout = String::from_utf8_lossy(&o.stdout).into_owned();
                    stderr = String::from_utf8_lossy(&o.stderr).into_owned();
                    exit_status = o.status;
                }
                Err(e) => {
                    if !used_cargo {
                        let _ = std::fs::remove_file(&bin_path);
                        let _ = std::fs::remove_file(&src_path);
                    }
                    return KernelResponse::EvalResult {
                        execution_count: self.exec_count,
                        stdout: String::new(),
                        displays: Vec::new(),
                        results: Vec::new(),
                        error: Some(EvalError {
                            error_type: "RuntimeError".to_string(),
                            message: format!("Failed to execute compiled cell: {}", e),
                            traceback: String::new(),
                        }),
                        duration_ms: start.elapsed().as_secs_f64() * 1000.0,
                        memory_bytes: None,
                        memory_delta_bytes: None,
                    };
                }
            }
        }

        if !used_cargo {
            let _ = std::fs::remove_file(&bin_path);
            let _ = std::fs::remove_file(&src_path);
        }

        let raw_displays = read_displays_file(&disp_path);
        // Deduplicate progress displays by id (keeping latest)
        let mut displays: Vec<crate::kernel_proc::DisplayItem> = Vec::new();
        for item in raw_displays {
            if item.mime == "application/vnd.minilang.progress+json" {
                let id = serde_json::from_str::<serde_json::Value>(&item.data)
                    .ok()
                    .and_then(|v| v.get("id").and_then(|s| s.as_str()).map(String::from))
                    .unwrap_or_else(|| "default".to_string());
                if let Some(existing) = displays.iter_mut().find(|d| {
                    d.mime == "application/vnd.minilang.progress+json"
                        && serde_json::from_str::<serde_json::Value>(&d.data)
                            .ok()
                            .and_then(|v| v.get("id").and_then(|s| s.as_str()).map(String::from))
                            .unwrap_or_else(|| "default".to_string())
                            == id
                }) {
                    existing.data = item.data;
                    continue;
                }
            }
            displays.push(item);
        }
        let res_raw = std::fs::read_to_string(&res_path).ok();
        let vars_raw = std::fs::read_to_string(&vars_path).ok();

        let _ = std::fs::remove_file(&res_path);
        let _ = std::fs::remove_file(&vars_path);
        let _ = std::fs::remove_file(&disp_path);
        let _ = std::fs::remove_file(&params_path);

        let duration_ms = start.elapsed().as_secs_f64() * 1000.0;

        if !exit_status.success() {
            return KernelResponse::EvalResult {
                execution_count: self.exec_count,
                stdout,
                displays,
                results: Vec::new(),
                error: Some(EvalError {
                    error_type: "PanicError".to_string(),
                    message: if stderr.trim().is_empty() {
                        format!("Exited with status {}", exit_status)
                    } else {
                        stderr.lines().next().unwrap_or("Runtime panic").to_string()
                    },
                    traceback: stderr,
                }),
                duration_ms,
                memory_bytes: None,
                memory_delta_bytes: None,
            };
        }

        // Commit dependencies and cell to persistent session history!
        self.dependencies = merged_deps;
        for item in split.items {
            if !item.trim().starts_with("fn main(") {
                self.items.push(item);
            }
        }
        for stmt in split.statements {
            self.past_statements.push(stmt);
        }
        self.tracked_vars = all_vars;

        if !added_deps.is_empty() && !has_code {
            stdout.push_str(&format!("Loaded Cargo dependencies: {}\n", added_deps.join(", ")));
        }
        if extracted.show_deps {
            stdout.push_str("Loaded Cargo dependencies:\n");
            for (k, v) in &self.dependencies {
                stdout.push_str(&format!("  {} = {}\n", k, v));
            }
        }

        // Parse live variable snapshots
        let mut live_vars = Vec::new();
        if let Some(raw) = vars_raw {
            for line in raw.lines() {
                if let Ok(v) = serde_json::from_str::<VarInfo>(line) {
                    live_vars.push(v);
                }
            }
        }
        self.last_vars = live_vars;

        let mut results = Vec::new();
        if let Some(raw) = res_raw {
            if let Ok(ev) = serde_json::from_str::<EvalValue>(&raw) {
                results.push(ev);
            }
        }

        KernelResponse::EvalResult {
            execution_count: self.exec_count,
            stdout,
            displays,
            results,
            error: None,
            duration_ms,
            memory_bytes: None,
            memory_delta_bytes: None,
        }
    }

    fn build_repl_harness(
        &self,
        current: &crate::lang::rust_lang::SplitRust,
        all_vars: &[String],
    ) -> String {
        let mut s = String::new();
        s.push_str("#![allow(unused_imports, unused_variables, unused_mut, dead_code, unused_assignments)]\n");
        s.push_str(RUST_TAGGED_PRELUDE);
        s.push_str("\nuse __ml_rt::{Params, Value};\n");
        s.push_str(RUST_REPL_PRELUDE);
        s.push('\n');

        // Emit accumulated top-level items + current cell's items
        for item in &self.items {
            s.push_str(item);
            s.push('\n');
        }
        for item in &current.items {
            if !item.trim().starts_with("fn main(") {
                s.push_str(item);
                s.push('\n');
            }
        }

        s.push_str("\nfn main() {\n");
        s.push_str("    let (params, args) = __ml_rt::read_env_params_file();\n");
        // Replay prior cells with stdout & display capture muted
        if !self.past_statements.is_empty() {
            s.push_str("    let __ml_saved_fd = __ml_repl::mute_stdout();\n");
            for stmt in &self.past_statements {
                s.push_str("    ");
                s.push_str(stmt);
                s.push('\n');
            }
            s.push_str("    __ml_repl::unmute_stdout(__ml_saved_fd);\n");
        }
        s.push_str("    __ml_repl::enable_displays();\n");

        // Run current cell's statements
        for stmt in &current.statements {
            s.push_str("    ");
            s.push_str(stmt);
            s.push('\n');
        }

        // Snapshot tracked variables for the Variable Inspector BEFORE trailing_expr
        // so trailing expressions that move local variables (e.g. `Value::list(lines)`) compile cleanly.
        if !all_vars.is_empty() {
            s.push_str("    {\n");
            s.push_str("        use __ml_repl::{__MlDebugFmt as _, __MlFallback as _};\n");
            s.push_str("        let mut __snap = String::new();\n");
            for var in all_vars {
                s.push_str(&format!(
                    "        __ml_repl::append_var(&mut __snap, {v:?}, std::any::type_name_of_val(&{v}), &(&&__ml_repl::__MlWrap(&{v})).__ml_fmt());\n",
                    v = var
                ));
            }
            s.push_str("        __ml_repl::write_vars(&__snap);\n");
            s.push_str("    }\n");
        }

        // Evaluate current cell's trailing expression if present
        if let Some(expr) = &current.trailing_expr {
            s.push_str("    {\n");
            s.push_str(&format!("        let __cell_val = {{\n            {}\n        }};\n", expr));
            s.push_str("        use __ml_repl::{__MlDebugFmt as _, __MlFallback as _};\n");
            s.push_str("        let __tname = std::any::type_name_of_val(&__cell_val);\n");
            s.push_str("        let __is_unit = __tname == \"()\";\n");
            s.push_str("        let __repr = (&&__ml_repl::__MlWrap(&__cell_val)).__ml_fmt();\n");
            s.push_str("        __ml_repl::write_eval_result(__tname, &__repr, __is_unit);\n");
            s.push_str("    }\n");
        }

        s.push_str("}\n");
        s
    }

    fn complete(&self, prefix: &str) -> Vec<CompletionItem> {
        let mut items = Vec::new();
        let mut seen = HashSet::new();

        for v in &self.last_vars {
            if v.name.starts_with(prefix) && seen.insert(v.name.clone()) {
                items.push(CompletionItem {
                    label: v.name.clone(),
                    kind: "variable".to_string(),
                    detail: v.type_name.clone(),
                });
            }
        }
        for v in &self.tracked_vars {
            if v.starts_with(prefix) && seen.insert(v.clone()) {
                items.push(CompletionItem {
                    label: v.clone(),
                    kind: "variable".to_string(),
                    detail: "local".to_string(),
                });
            }
        }
        for &kw in RUST_KEYWORDS {
            if kw.starts_with(prefix) && seen.insert(kw.to_string()) {
                items.push(CompletionItem {
                    label: kw.to_string(),
                    kind: "keyword".to_string(),
                    detail: "keyword".to_string(),
                });
            }
        }
        for (crate_name, spec) in &self.dependencies {
            let ident = crate_name.replace('-', "_");
            if ident.starts_with(prefix) && seen.insert(ident.clone()) {
                items.push(CompletionItem {
                    label: ident,
                    kind: "crate".to_string(),
                    detail: format!("dep {}", spec),
                });
            }
        }
        for &(label, kind, detail) in &[
            (":dep", "directive", "Add Cargo dependency (e.g. :dep serde_json = \"1.0\")"),
            (":deps", "directive", "List loaded Cargo dependencies"),
        ] {
            if label.starts_with(prefix) && seen.insert(label.to_string()) {
                items.push(CompletionItem {
                    label: label.to_string(),
                    kind: kind.to_string(),
                    detail: detail.to_string(),
                });
            }
        }
        for &(label, kind, detail) in RUST_PRELUDE_ITEMS {
            if label.starts_with(prefix) && seen.insert(label.to_string()) {
                items.push(CompletionItem {
                    label: label.to_string(),
                    kind: kind.to_string(),
                    detail: detail.to_string(),
                });
            }
        }
        items.sort_by(|a, b| a.label.cmp(&b.label));
        items.truncate(40);
        items
    }
}

impl Drop for RustReplState {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.session_dir);
    }
}

/// Extract simple `let [mut] <ident>` variable names from top-level statements.
fn extract_let_idents(stmts: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for s in stmts {
        let t = s.trim_start();
        if let Some(rest) = t.strip_prefix("let ") {
            let rest = rest.trim_start();
            let rest = rest.strip_prefix("mut ").unwrap_or(rest).trim_start();
            let ident: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if !ident.is_empty() && ident != "_" && ident.chars().next().unwrap().is_ascii_alphabetic() {
                out.push(ident);
            }
        }
    }
    out
}

pub fn run_rust_kernel_process() -> io::Result<()> {
    let mut state = RustReplState::new()?;
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let resp = match serde_json::from_str::<KernelRequest>(trimmed) {
            Ok(KernelRequest::Ping) => KernelResponse::Ok {
                message: "pong".to_string(),
            },
            Ok(KernelRequest::Chdir { path }) => match std::env::set_current_dir(&path) {
                Ok(()) => KernelResponse::Ok {
                    message: format!("changed directory to {}", path),
                },
                Err(e) => KernelResponse::Err {
                    message: format!("chdir failed: {}", e),
                },
            },
            Ok(KernelRequest::SetEnv { vars }) => {
                for (k, v) in vars {
                    match v {
                        Some(val) => {
                            std::env::set_var(&k, &val);
                            std::env::set_var(format!("MLNB_SECRET_{}", k), &val);
                        }
                        None => {
                            std::env::remove_var(&k);
                            std::env::remove_var(format!("MLNB_SECRET_{}", k));
                        }
                    }
                }
                KernelResponse::Ok {
                    message: "environment updated".to_string(),
                }
            }
            Ok(KernelRequest::Eval { code, params, .. }) => state.eval_cell(&code, params.as_ref(), None),
            Ok(KernelRequest::EvalStream { code, .. }) => state.eval_cell(&code, None, Some(&mut out)),
            Ok(KernelRequest::Inspect) => KernelResponse::InspectResult {
                variables: state.last_vars.clone(),
                globals_count: RUST_PRELUDE_ITEMS.len(),
            },
            Ok(KernelRequest::Complete { prefix }) => KernelResponse::CompleteResult {
                items: state.complete(&prefix),
            },
            Ok(KernelRequest::Invoke { .. }) => KernelResponse::Err {
                message: "Use RustBackend::invoke_script for .rs script invocation".to_string(),
            },
            Err(e) => KernelResponse::Err {
                message: format!("invalid request json: {}", e),
            },
        };
        let encoded = serde_json::to_string(&resp)
            .unwrap_or_else(|_| r#"{"type":"err","message":"serialization error"}"#.to_string());
        writeln!(out, "{}", encoded)?;
        out.flush()?;
    }
    Ok(())
}

const RUST_REPL_PRELUDE: &str = r#"
mod __ml_repl {
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, Ordering};

    static DISPLAYS_ON: AtomicBool = AtomicBool::new(false);

    extern "C" {
        fn dup(fd: i32) -> i32;
        fn dup2(oldfd: i32, newfd: i32) -> i32;
        fn close(fd: i32) -> i32;
    }

    pub fn mute_stdout() -> i32 {
        use std::os::unix::io::IntoRawFd;
        let _ = std::io::stdout().flush();
        unsafe {
            let saved = dup(1);
            if let Ok(devnull) = std::fs::OpenOptions::new().write(true).open("/dev/null") {
                let nfd = devnull.into_raw_fd();
                dup2(nfd, 1);
                close(nfd);
            }
            saved
        }
    }

    pub fn unmute_stdout(saved: i32) {
        let _ = std::io::stdout().flush();
        if saved >= 0 {
            unsafe {
                dup2(saved, 1);
                close(saved);
            }
        }
    }

    pub fn enable_displays() {
        DISPLAYS_ON.store(true, Ordering::SeqCst);
    }

    pub fn display(mime: &str, data: impl AsRef<str>) {
        if !DISPLAYS_ON.load(Ordering::SeqCst) { return; }
        if let Ok(path) = std::env::var("__ML_DISPLAYS_FILE") {
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(f, "{{\"mime\":{},\"data\":{}}}", esc(mime), esc(data.as_ref()));
            }
        }
    }

    pub struct __MlWrap<'a, T: ?Sized>(pub &'a T);

    pub trait __MlFallback {
        fn __ml_fmt(&self) -> String { "<value>".to_string() }
    }
    impl<'a, T: ?Sized> __MlFallback for __MlWrap<'a, T> {}

    pub trait __MlDebugFmt {
        fn __ml_fmt(&self) -> String;
    }
    impl<'a, T: std::fmt::Debug + ?Sized> __MlDebugFmt for &__MlWrap<'a, T> {
        fn __ml_fmt(&self) -> String { format!("{:?}", self.0) }
    }

    pub fn esc(s: &str) -> String {
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

    pub fn write_eval_result(tname: &str, repr: &str, is_nil: bool) {
        if let Ok(path) = std::env::var("__ML_RES_FILE") {
            let body = format!(
                "{{\"type_name\":{},\"repr\":{},\"is_nil\":{}}}",
                esc(tname),
                esc(repr),
                is_nil
            );
            let _ = std::fs::write(path, body);
        }
    }

    pub fn append_var(buf: &mut String, name: &str, tname: &str, preview: &str) {
        let short = if preview.len() > 240 {
            format!("{}...", &preview[..240])
        } else {
            preview.to_string()
        };
        buf.push_str(&format!(
            "{{\"name\":{},\"type_name\":{},\"preview\":{},\"is_user\":true}}\n",
            esc(name),
            esc(tname),
            esc(&short)
        ));
    }

    pub fn write_vars(content: &str) {
        if let Ok(path) = std::env::var("__ML_VARS_FILE") {
            let _ = std::fs::write(path, content);
        }
    }

    pub fn b64_encode(bytes: &[u8]) -> String {
        const TBL: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity(((bytes.len() + 2) / 3) * 4);
        let mut i = 0;
        while i < bytes.len() {
            let b0 = bytes[i] as u32;
            let b1 = if i + 1 < bytes.len() { bytes[i + 1] as u32 } else { 0 };
            let b2 = if i + 2 < bytes.len() { bytes[i + 2] as u32 } else { 0 };
            let n = (b0 << 16) | (b1 << 8) | b2;
            out.push(TBL[((n >> 18) & 63) as usize] as char);
            out.push(TBL[((n >> 12) & 63) as usize] as char);
            out.push(if i + 1 < bytes.len() { TBL[((n >> 6) & 63) as usize] as char } else { '=' });
            out.push(if i + 2 < bytes.len() { TBL[(n & 63) as usize] as char } else { '=' });
            i += 3;
        }
        out
    }

    pub fn media_path(path: &str, force_kind: Option<&str>) {
        let p = std::path::Path::new(path);
        let canon = match std::fs::canonicalize(p) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("Media file '{}' not found: {}", path, e);
                return;
            }
        };
        let ext = canon.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "svg" => "image/svg+xml",
            "bmp" => "image/bmp",
            "ico" => "image/x-icon",
            "avif" => "image/avif",
            "pdf" => "application/pdf",
            _ => if force_kind == Some("pdf") { "application/pdf" } else { "image/png" },
        };
        let kind = force_kind.unwrap_or(if mime == "application/pdf" { "pdf" } else { "image" });
        let name = canon.file_name().and_then(|s| s.to_str()).unwrap_or(path);
        let size = std::fs::metadata(&canon).map(|m| m.len()).unwrap_or(0);

        if let Ok(ws_root) = std::env::var("MINILANG_WORKSPACE_ROOT") {
            if let Ok(ws_canon) = std::fs::canonicalize(ws_root) {
                if let Ok(rel) = canon.strip_prefix(&ws_canon) {
                    let rel_str = rel.to_string_lossy().replace('\\', "/");
                    let payload = format!(
                        "{{\"kind\":{},\"path\":{},\"mime\":{},\"name\":{},\"size\":{}}}",
                        esc(kind), esc(&rel_str), esc(mime), esc(name), size
                    );
                    display("application/vnd.minilang.media+json", &payload);
                    return;
                }
            }
        }

        if let Ok(bytes) = std::fs::read(&canon) {
            if mime == "image/svg+xml" {
                display(mime, String::from_utf8_lossy(&bytes));
            } else {
                display(mime, b64_encode(&bytes));
            }
        }
    }

    pub fn media_bytes(bytes: &[u8], mime: &str) {
        if mime == "image/svg+xml" {
            display(mime, String::from_utf8_lossy(bytes));
        } else {
            display(mime, b64_encode(bytes));
        }
    }
}

fn display(mime: &str, data: impl AsRef<str>) { __ml_repl::display(mime, data); }
fn html(s: impl AsRef<str>) { __ml_repl::display("text/html", s); }
fn svg(s: impl AsRef<str>) { __ml_repl::display("image/svg+xml", s); }
fn markdown(s: impl AsRef<str>) { __ml_repl::display("text/markdown", s); }
fn image(path: impl AsRef<str>) { __ml_repl::media_path(path.as_ref(), Some("image")); }
fn image_bytes(bytes: &[u8], mime: &str) { __ml_repl::media_bytes(bytes, mime); }
fn pdf(path: impl AsRef<str>) { __ml_repl::media_path(path.as_ref(), Some("pdf")); }
fn pdf_bytes(bytes: &[u8]) { __ml_repl::media_bytes(bytes, "application/pdf"); }
fn preview(path: impl AsRef<str>) { __ml_repl::media_path(path.as_ref(), None); }
fn table(json: impl AsRef<str>) { __ml_repl::display("application/vnd.minilang.table+json", json); }
fn chart(json: impl AsRef<str>) { __ml_repl::display("application/vnd.minilang.chart+json", json); }
fn progress(done: f64, total: f64, label: impl AsRef<str>) {
    let pct = if total > 0.0 { ((done / total) * 100.0).clamp(0.0, 100.0) } else { 0.0 };
    let payload = format!(
        "{{\"done\":{},\"total\":{},\"percent\":{},\"label\":{},\"id\":\"default\"}}",
        done, total, pct, __ml_repl::esc(label.as_ref())
    );
    __ml_repl::display("application/vnd.minilang.progress+json", &payload);
}
fn secret(key: impl AsRef<str>) -> Option<String> {
    std::env::var(format!("MLNB_SECRET_{}", key.as_ref()))
        .ok()
        .or_else(|| std::env::var(key.as_ref()).ok())
}
"#;
