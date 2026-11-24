use crate::tagged::{is_valid_ml_ident, TaggedValue};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::{CStr, CString};
use std::io::{self, BufRead, Write};
use std::os::raw::{c_char, c_int, c_void};
use std::time::Instant;

type MlkStdoutCb = extern "C" fn(*const c_char, usize, *mut c_void);
type MlkDisplayCb = extern "C" fn(*const c_char, *const c_char, usize, *mut c_void);
type MlkResultCb = extern "C" fn(*const c_char, *const c_char, usize, c_int, *mut c_void);
type MlkErrorCb = extern "C" fn(*const c_char, *const c_char, *const c_char, *mut c_void);
type MlkVarCb = extern "C" fn(*const c_char, *const c_char, *const c_char, c_int, *mut c_void);

extern "C" {
    fn mlk_init(exec_name: *const c_char);
    fn mlk_add_library_path(path: *const c_char);
    fn mlk_eval(
        source_name: *const c_char,
        code: *const c_char,
        stdout_cb: MlkStdoutCb,
        display_cb: MlkDisplayCb,
        result_cb: MlkResultCb,
        error_cb: MlkErrorCb,
        ctx: *mut c_void,
    );
    fn mlk_list_vars(cb: MlkVarCb, ctx: *mut c_void);

    fn mlk_val_nil() -> *mut c_void;
    fn mlk_val_bool(v: c_int) -> *mut c_void;
    fn mlk_val_int(v: i64) -> *mut c_void;
    fn mlk_val_real(v: f64) -> *mut c_void;
    fn mlk_val_string(ptr: *const c_char, len: usize) -> *mut c_void;
    fn mlk_val_symbol(name: *const c_char) -> *mut c_void;
    fn mlk_val_bytes(ptr: *const u8, len: usize) -> *mut c_void;
    fn mlk_val_time_str(
        iso: *const c_char,
        len: usize,
        err_buf: *mut c_char,
        err_cap: usize,
    ) -> *mut c_void;
    fn mlk_val_time_epoch(sec: i64, nsec: u64) -> *mut c_void;
    fn mlk_val_uuid(
        s: *const c_char,
        len: usize,
        err_buf: *mut c_char,
        err_cap: usize,
    ) -> *mut c_void;
    fn mlk_val_list_new() -> *mut c_void;
    fn mlk_val_list_put(list: *mut c_void, item: *mut c_void);
    fn mlk_val_tuple_new(items: *const *mut c_void, count: usize) -> *mut c_void;
    fn mlk_val_set_new() -> *mut c_void;
    fn mlk_val_set_insert(set: *mut c_void, item: *mut c_void);
    fn mlk_val_map_new() -> *mut c_void;
    fn mlk_val_map_insert(map: *mut c_void, key: *mut c_void, val: *mut c_void);
    fn mlk_define(name: *const c_char, val: *mut c_void);
    fn mlk_call_function(
        fn_name: *const c_char,
        args: *const *mut c_void,
        argc: usize,
        stdout_cb: MlkStdoutCb,
        display_cb: MlkDisplayCb,
        result_cb: MlkResultCb,
        error_cb: MlkErrorCb,
        ctx: *mut c_void,
    );
    fn mlk_last_value_tagged_json(cb: MlkStdoutCb, ctx: *mut c_void);
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum KernelRequest {
    Eval {
        code: String,
        source: Option<String>,
    },
    EvalStream {
        code: String,
        source: Option<String>,
    },
    Invoke {
        code: String,
        source: String,
        #[serde(default)]
        params: BTreeMap<String, TaggedValue>,
        #[serde(default)]
        args: Vec<TaggedValue>,
        #[serde(default)]
        function: Option<String>,
    },
    Inspect,
    Complete {
        prefix: String,
    },
    Chdir {
        path: String,
    },
    SetEnv {
        vars: BTreeMap<String, Option<String>>,
    },
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayItem {
    pub mime: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalValue {
    pub type_name: String,
    pub repr: String,
    pub is_nil: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvalError {
    pub error_type: String,
    pub message: String,
    pub traceback: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VarInfo {
    pub name: String,
    pub type_name: String,
    pub preview: String,
    pub is_user: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionItem {
    pub label: String,
    pub kind: String,
    pub detail: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum KernelResponse {
    StreamEvent {
        event: String,
        data: serde_json::Value,
    },
    EvalResult {
        execution_count: u64,
        stdout: String,
        displays: Vec<DisplayItem>,
        results: Vec<EvalValue>,
        error: Option<EvalError>,
        duration_ms: f64,
    },
    InvokeResult {
        result: serde_json::Value,
        type_name: String,
        repr: String,
        stdout: String,
        displays: Vec<DisplayItem>,
        error: Option<EvalError>,
        duration_ms: f64,
    },
    InspectResult {
        variables: Vec<VarInfo>,
        globals_count: usize,
    },
    CompleteResult {
        items: Vec<CompletionItem>,
    },
    Ok {
        message: String,
    },
    Err {
        message: String,
    },
}

struct EvalCollector<'a> {
    stdout: String,
    displays: Vec<DisplayItem>,
    results: Vec<EvalValue>,
    error: Option<EvalError>,
    stream: Option<&'a mut dyn Write>,
}

fn emit_stream_line(writer: &mut Option<&mut dyn Write>, event: &str, data: serde_json::Value) {
    if let Some(w) = writer.as_mut() {
        let msg = KernelResponse::StreamEvent {
            event: event.to_string(),
            data,
        };
        if let Ok(encoded) = serde_json::to_string(&msg) {
            let _ = writeln!(w, "{}", encoded);
            let _ = w.flush();
        }
    }
}

extern "C" fn on_stdout(data: *const c_char, len: usize, ctx: *mut c_void) {
    if data.is_null() || len == 0 {
        return;
    }
    unsafe {
        let collector = &mut *(ctx as *mut EvalCollector<'_>);
        let bytes = std::slice::from_raw_parts(data as *const u8, len);
        let chunk = String::from_utf8_lossy(bytes).into_owned();
        collector.stdout.push_str(&chunk);
        emit_stream_line(&mut collector.stream, "stdout", serde_json::json!({ "text": chunk }));
    }
}

extern "C" fn on_display(mime: *const c_char, data: *const c_char, len: usize, ctx: *mut c_void) {
    unsafe {
        let collector = &mut *(ctx as *mut EvalCollector<'_>);
        let mime_str = if mime.is_null() {
            "text/plain".to_string()
        } else {
            CStr::from_ptr(mime).to_string_lossy().into_owned()
        };
        let data_str = if data.is_null() || len == 0 {
            String::new()
        } else {
            let bytes = std::slice::from_raw_parts(data as *const u8, len);
            String::from_utf8_lossy(bytes).into_owned()
        };
        if mime_str == "application/vnd.minilang.progress+json" {
            let parsed = serde_json::from_str::<serde_json::Value>(&data_str)
                .unwrap_or_else(|_| serde_json::json!({ "percent": 0 }));
            emit_stream_line(&mut collector.stream, "progress", parsed);
            // Update/replace existing progress display with same id so final output stays tidy
            let new_id = serde_json::from_str::<serde_json::Value>(&data_str)
                .ok()
                .and_then(|v| v.get("id").and_then(|s| s.as_str()).map(String::from))
                .unwrap_or_else(|| "default".to_string());
            if let Some(existing) = collector.displays.iter_mut().find(|d| {
                d.mime == "application/vnd.minilang.progress+json"
                    && serde_json::from_str::<serde_json::Value>(&d.data)
                        .ok()
                        .and_then(|v| v.get("id").and_then(|s| s.as_str()).map(String::from))
                        .unwrap_or_else(|| "default".to_string())
                        == new_id
            }) {
                existing.data = data_str;
            } else {
                collector.displays.push(DisplayItem {
                    mime: mime_str,
                    data: data_str,
                });
            }
            return;
        }
        emit_stream_line(
            &mut collector.stream,
            "display",
            serde_json::json!({ "mime": mime_str, "data": data_str }),
        );
        collector.displays.push(DisplayItem {
            mime: mime_str,
            data: data_str,
        });
    }
}

extern "C" fn on_result(
    type_name: *const c_char,
    repr: *const c_char,
    repr_len: usize,
    is_nil: c_int,
    ctx: *mut c_void,
) {
    unsafe {
        let collector = &mut *(ctx as *mut EvalCollector<'_>);
        let t = if type_name.is_null() {
            "any".to_string()
        } else {
            CStr::from_ptr(type_name).to_string_lossy().into_owned()
        };
        let r = if repr.is_null() || repr_len == 0 {
            String::new()
        } else {
            let bytes = std::slice::from_raw_parts(repr as *const u8, repr_len);
            String::from_utf8_lossy(bytes).into_owned()
        };
        collector.results.push(EvalValue {
            type_name: t,
            repr: r,
            is_nil: is_nil != 0,
        });
    }
}

extern "C" fn on_error(
    err_type: *const c_char,
    err_msg: *const c_char,
    traceback: *const c_char,
    ctx: *mut c_void,
) {
    unsafe {
        let collector = &mut *(ctx as *mut EvalCollector<'_>);
        let et = if err_type.is_null() {
            "Error".to_string()
        } else {
            CStr::from_ptr(err_type).to_string_lossy().into_owned()
        };
        let em = if err_msg.is_null() {
            String::new()
        } else {
            CStr::from_ptr(err_msg).to_string_lossy().into_owned()
        };
        let tb = if traceback.is_null() {
            String::new()
        } else {
            CStr::from_ptr(traceback).to_string_lossy().into_owned()
        };
        collector.error = Some(EvalError {
            error_type: et,
            message: em,
            traceback: tb,
        });
    }
}

extern "C" fn on_var(
    name: *const c_char,
    type_name: *const c_char,
    preview: *const c_char,
    is_user: c_int,
    ctx: *mut c_void,
) {
    unsafe {
        let list = &mut *(ctx as *mut Vec<VarInfo>);
        let n = if name.is_null() {
            String::new()
        } else {
            CStr::from_ptr(name).to_string_lossy().into_owned()
        };
        let t = if type_name.is_null() {
            "any".to_string()
        } else {
            CStr::from_ptr(type_name).to_string_lossy().into_owned()
        };
        let p = if preview.is_null() {
            String::new()
        } else {
            CStr::from_ptr(preview).to_string_lossy().into_owned()
        };
        list.push(VarInfo {
            name: n,
            type_name: t,
            preview: p,
            is_user: is_user != 0,
        });
    }
}

const MINILANG_KEYWORDS: &[&str] = &[
    "and", "case", "class", "debug", "def", "do", "each", "else", "elseif", "end", "exit", "for",
    "fun", "if", "imp", "in", "is", "it", "let", "loop", "meth", "must", "next", "nil", "not",
    "old", "on", "or", "recur", "ref", "ret", "seq", "susp", "switch", "then", "to", "true",
    "false", "until", "var", "when", "while", "with", "xor",
];

fn collect_all_vars() -> Vec<VarInfo> {
    let mut vars = Vec::new();
    unsafe {
        mlk_list_vars(on_var, &mut vars as *mut Vec<VarInfo> as *mut c_void);
    }
    vars
}

fn tagged_to_ml(val: &TaggedValue) -> Result<*mut c_void, String> {
    unsafe {
        match val {
            TaggedValue::Nil => Ok(mlk_val_nil()),
            TaggedValue::Boolean(b) => Ok(mlk_val_bool(if *b { 1 } else { 0 })),
            TaggedValue::Integer(n) => Ok(mlk_val_int(*n)),
            TaggedValue::Real(f) => Ok(mlk_val_real(*f)),
            TaggedValue::String(s) => Ok(mlk_val_string(s.as_ptr() as *const c_char, s.len())),
            TaggedValue::Symbol(s) => {
                let cs = CString::new(s.replace('\0', "")).unwrap();
                Ok(mlk_val_symbol(cs.as_ptr()))
            }
            TaggedValue::Bytes(b) => Ok(mlk_val_bytes(b.as_ptr(), b.len())),
            TaggedValue::TimeIso(iso) => {
                let mut err = [0u8; 256];
                let ptr = mlk_val_time_str(
                    iso.as_ptr() as *const c_char,
                    iso.len(),
                    err.as_mut_ptr() as *mut c_char,
                    err.len(),
                );
                if ptr.is_null() {
                    let msg = CStr::from_ptr(err.as_ptr() as *const c_char)
                        .to_string_lossy()
                        .into_owned();
                    Err(format!("Invalid time '{}': {}", iso, msg))
                } else {
                    Ok(ptr)
                }
            }
            TaggedValue::TimeEpoch(sec, nsec) => Ok(mlk_val_time_epoch(*sec, *nsec)),
            TaggedValue::Uuid(u) => {
                let mut err = [0u8; 256];
                let ptr = mlk_val_uuid(
                    u.as_ptr() as *const c_char,
                    u.len(),
                    err.as_mut_ptr() as *mut c_char,
                    err.len(),
                );
                if ptr.is_null() {
                    let msg = CStr::from_ptr(err.as_ptr() as *const c_char)
                        .to_string_lossy()
                        .into_owned();
                    Err(format!("Invalid uuid '{}': {}", u, msg))
                } else {
                    Ok(ptr)
                }
            }
            TaggedValue::List(items) => {
                let list = mlk_val_list_new();
                for item in items {
                    let v = tagged_to_ml(item)?;
                    mlk_val_list_put(list, v);
                }
                Ok(list)
            }
            TaggedValue::Tuple(items) => {
                let mut ptrs = Vec::with_capacity(items.len());
                for item in items {
                    ptrs.push(tagged_to_ml(item)?);
                }
                Ok(mlk_val_tuple_new(ptrs.as_ptr(), ptrs.len()))
            }
            TaggedValue::Set(items) => {
                let set = mlk_val_set_new();
                for item in items {
                    let v = tagged_to_ml(item)?;
                    mlk_val_set_insert(set, v);
                }
                Ok(set)
            }
            TaggedValue::Map(entries) => {
                let map = mlk_val_map_new();
                for (k, v) in entries {
                    let mk = tagged_to_ml(k)?;
                    let mv = tagged_to_ml(v)?;
                    mlk_val_map_insert(map, mk, mv);
                }
                Ok(map)
            }
        }
    }
}

extern "C" fn on_tagged_json(data: *const c_char, len: usize, ctx: *mut c_void) {
    if data.is_null() || len == 0 {
        return;
    }
    unsafe {
        let out = &mut *(ctx as *mut String);
        let bytes = std::slice::from_raw_parts(data as *const u8, len);
        out.push_str(&String::from_utf8_lossy(bytes));
    }
}

fn capture_last_tagged_json() -> serde_json::Value {
    let mut raw = String::new();
    unsafe {
        mlk_last_value_tagged_json(on_tagged_json, &mut raw as *mut String as *mut c_void);
    }
    serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({ "type": "nil" }))
}

fn handle_invoke(
    code: String,
    source: String,
    params: BTreeMap<String, TaggedValue>,
    args: Vec<TaggedValue>,
    function: Option<String>,
) -> KernelResponse {
    let start = Instant::now();

    // Build Minilang Params map & individual identifier bindings
    let params_map = unsafe { mlk_val_map_new() };
    for (k, v) in &params {
        let ml_val = match tagged_to_ml(v) {
            Ok(ptr) => ptr,
            Err(msg) => {
                return KernelResponse::InvokeResult {
                    result: serde_json::json!({ "type": "nil" }),
                    type_name: "nil".to_string(),
                    repr: String::new(),
                    stdout: String::new(),
                    displays: Vec::new(),
                    error: Some(EvalError {
                        error_type: "ParameterError".to_string(),
                        message: format!("Parameter '{}': {}", k, msg),
                        traceback: String::new(),
                    }),
                    duration_ms: start.elapsed().as_secs_f64() * 1000.0,
                };
            }
        };
        unsafe {
            let mk = mlk_val_string(k.as_ptr() as *const c_char, k.len());
            mlk_val_map_insert(params_map, mk, ml_val);
            if is_valid_ml_ident(k) {
                let cname = CString::new(k.as_str()).unwrap();
                mlk_define(cname.as_ptr(), ml_val);
            }
        }
    }

    // Build Minilang Args list
    let args_list = unsafe { mlk_val_list_new() };
    let mut ml_arg_ptrs: Vec<*mut c_void> = Vec::with_capacity(args.len());
    for (idx, a) in args.iter().enumerate() {
        let ml_val = match tagged_to_ml(a) {
            Ok(ptr) => ptr,
            Err(msg) => {
                return KernelResponse::InvokeResult {
                    result: serde_json::json!({ "type": "nil" }),
                    type_name: "nil".to_string(),
                    repr: String::new(),
                    stdout: String::new(),
                    displays: Vec::new(),
                    error: Some(EvalError {
                        error_type: "ParameterError".to_string(),
                        message: format!("Arg [{}]: {}", idx, msg),
                        traceback: String::new(),
                    }),
                    duration_ms: start.elapsed().as_secs_f64() * 1000.0,
                };
            }
        };
        unsafe {
            mlk_val_list_put(args_list, ml_val);
        }
        ml_arg_ptrs.push(ml_val);
    }

    unsafe {
        let c_params = CString::new("Params").unwrap();
        let c_args = CString::new("Args").unwrap();
        mlk_define(c_params.as_ptr(), params_map);
        mlk_define(c_args.as_ptr(), args_list);
    }

    let c_source = CString::new(source.replace('\0', "")).unwrap();
    let c_code = CString::new(code.replace('\0', "")).unwrap();
    let mut collector = EvalCollector {
        stdout: String::new(),
        displays: Vec::new(),
        results: Vec::new(),
        error: None,
        stream: None,
    };

    unsafe {
        mlk_eval(
            c_source.as_ptr(),
            c_code.as_ptr(),
            on_stdout,
            on_display,
            on_result,
            on_error,
            &mut collector as *mut EvalCollector as *mut c_void,
        );
    }

    // If a target function was specified and script loaded without error, invoke it
    if collector.error.is_none() {
        if let Some(fn_name) = function.filter(|s| !s.trim().is_empty()) {
            let c_fn = CString::new(fn_name.trim().replace('\0', "")).unwrap();
            let call_args: Vec<*mut c_void> = if !ml_arg_ptrs.is_empty() {
                ml_arg_ptrs
            } else if !params.is_empty() {
                vec![params_map]
            } else {
                Vec::new()
            };
            collector.results.clear();
            unsafe {
                mlk_call_function(
                    c_fn.as_ptr(),
                    call_args.as_ptr(),
                    call_args.len(),
                    on_stdout,
                    on_display,
                    on_result,
                    on_error,
                    &mut collector as *mut EvalCollector as *mut c_void,
                );
            }
        }
    }

    let duration_ms = start.elapsed().as_secs_f64() * 1000.0;
    if collector.error.is_some() {
        return KernelResponse::InvokeResult {
            result: serde_json::json!({ "type": "nil" }),
            type_name: "error".to_string(),
            repr: String::new(),
            stdout: collector.stdout,
            displays: collector.displays,
            error: collector.error,
            duration_ms,
        };
    }

    let (type_name, repr) = collector
        .results
        .last()
        .map(|r| (r.type_name.clone(), r.repr.clone()))
        .unwrap_or_else(|| ("nil".to_string(), "nil".to_string()));
    let tagged_result = capture_last_tagged_json();

    KernelResponse::InvokeResult {
        result: tagged_result,
        type_name,
        repr,
        stdout: collector.stdout,
        displays: collector.displays,
        error: None,
        duration_ms,
    }
}

fn register_library_path(path: &std::path::Path) {
    if let Ok(canon) = std::fs::canonicalize(path) {
        if let Ok(c_path) = CString::new(canon.to_string_lossy().as_bytes()) {
            unsafe {
                mlk_add_library_path(c_path.as_ptr());
            }
        }
    }
}

pub fn run_kernel_process() -> io::Result<()> {
    let exec_name = CString::new("minilang-notebook").unwrap();
    unsafe {
        mlk_init(exec_name.as_ptr());
    }

    // Add search paths in reverse priority order (`ml_library_path_add` pushes to front):
    // 1. current working directory (highest priority)
    // 2. workspace root
    // 3. <workspace_root>/scripts
    if let Ok(ws_root) = std::env::var("MINILANG_WORKSPACE_ROOT") {
        let root_path = std::path::PathBuf::from(&ws_root);
        let scripts_dir = root_path.join("scripts");
        if scripts_dir.is_dir() {
            register_library_path(&scripts_dir);
        }
        if root_path.is_dir() {
            register_library_path(&root_path);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let local_scripts = cwd.join("scripts");
        if local_scripts.is_dir() {
            register_library_path(&local_scripts);
        }
        register_library_path(&cwd);
    }

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());
    let mut exec_count: u64 = 0;

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<KernelRequest>(trimmed) {
            Ok(KernelRequest::Ping) => KernelResponse::Ok {
                message: "pong".to_string(),
            },
            Ok(KernelRequest::Chdir { path }) => match std::env::set_current_dir(&path) {
                Ok(()) => {
                    if let Ok(cwd) = std::env::current_dir() {
                        register_library_path(&cwd);
                    }
                    KernelResponse::Ok {
                        message: format!("changed directory to {}", path),
                    }
                }
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
            Ok(KernelRequest::Eval { code, source }) => {
                exec_count += 1;
                let source_str = source.unwrap_or_else(|| format!("In[{}]", exec_count));
                let c_source = CString::new(source_str.replace('\0', "")).unwrap();
                let c_code = CString::new(code.replace('\0', "")).unwrap();

                let mut collector = EvalCollector {
                    stdout: String::new(),
                    displays: Vec::new(),
                    results: Vec::new(),
                    error: None,
                    stream: None,
                };

                let start = Instant::now();
                unsafe {
                    mlk_eval(
                        c_source.as_ptr(),
                        c_code.as_ptr(),
                        on_stdout,
                        on_display,
                        on_result,
                        on_error,
                        &mut collector as *mut EvalCollector<'_> as *mut c_void,
                    );
                }
                let duration_ms = start.elapsed().as_secs_f64() * 1000.0;

                KernelResponse::EvalResult {
                    execution_count: exec_count,
                    stdout: collector.stdout,
                    displays: collector.displays,
                    results: collector.results,
                    error: collector.error,
                    duration_ms,
                }
            }
            Ok(KernelRequest::EvalStream { code, source }) => {
                exec_count += 1;
                let source_str = source.unwrap_or_else(|| format!("In[{}]", exec_count));
                let c_source = CString::new(source_str.replace('\0', "")).unwrap();
                let c_code = CString::new(code.replace('\0', "")).unwrap();

                let mut collector = EvalCollector {
                    stdout: String::new(),
                    displays: Vec::new(),
                    results: Vec::new(),
                    error: None,
                    stream: Some(&mut out),
                };

                let start = Instant::now();
                unsafe {
                    mlk_eval(
                        c_source.as_ptr(),
                        c_code.as_ptr(),
                        on_stdout,
                        on_display,
                        on_result,
                        on_error,
                        &mut collector as *mut EvalCollector<'_> as *mut c_void,
                    );
                }
                let duration_ms = start.elapsed().as_secs_f64() * 1000.0;

                KernelResponse::EvalResult {
                    execution_count: exec_count,
                    stdout: collector.stdout,
                    displays: collector.displays,
                    results: collector.results,
                    error: collector.error,
                    duration_ms,
                }
            }
            Ok(KernelRequest::Invoke {
                code,
                source,
                params,
                args,
                function,
            }) => handle_invoke(code, source, params, args, function),
            Ok(KernelRequest::Inspect) => {
                let all = collect_all_vars();
                let globals_count = all.iter().filter(|v| !v.is_user).count();
                let mut user_vars: Vec<VarInfo> = all.into_iter().filter(|v| v.is_user).collect();
                user_vars.sort_by(|a, b| a.name.cmp(&b.name));
                KernelResponse::InspectResult {
                    variables: user_vars,
                    globals_count,
                }
            }
            Ok(KernelRequest::Complete { prefix }) => {
                let all = collect_all_vars();
                let mut items = Vec::new();
                let mut seen = std::collections::HashSet::new();

                for v in &all {
                    if v.is_user && v.name.starts_with(&prefix) && seen.insert(v.name.clone()) {
                        items.push(CompletionItem {
                            label: v.name.clone(),
                            kind: "variable".to_string(),
                            detail: v.type_name.clone(),
                        });
                    }
                }
                for &kw in MINILANG_KEYWORDS {
                    if kw.starts_with(&prefix) && seen.insert(kw.to_string()) {
                        items.push(CompletionItem {
                            label: kw.to_string(),
                            kind: "keyword".to_string(),
                            detail: "keyword".to_string(),
                        });
                    }
                }
                for v in &all {
                    if !v.is_user && v.name.starts_with(&prefix) && seen.insert(v.name.clone()) {
                        let kind = if v.type_name == "type" {
                            "type"
                        } else if v.type_name.contains("function") || v.type_name == "method" {
                            "function"
                        } else {
                            "builtin"
                        };
                        items.push(CompletionItem {
                            label: v.name.clone(),
                            kind: kind.to_string(),
                            detail: v.type_name.clone(),
                        });
                    }
                }
                items.sort_by(|a, b| a.label.cmp(&b.label));
                items.truncate(40);
                KernelResponse::CompleteResult { items }
            }
            Err(e) => KernelResponse::Err {
                message: format!("invalid request json: {}", e),
            },
        };

        let encoded = serde_json::to_string(&response).unwrap_or_else(|_| {
            r#"{"type":"err","message":"serialization error"}"#.to_string()
        });
        writeln!(out, "{}", encoded)?;
        out.flush()?;
    }

    Ok(())
}
