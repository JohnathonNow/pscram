use crate::kernel_proc::{bind_minilang_params, DisplayItem, EvalError, EvalValue};
use crate::tagged::TaggedValue;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::{CStr, CString};
use std::io::{self, BufRead, Write};
use std::os::raw::{c_char, c_int, c_void};

type MldStdoutCb = extern "C" fn(*const c_char, usize, *mut c_void);
type MldDisplayCb = extern "C" fn(*const c_char, *const c_char, usize, *mut c_void);
type MldResultCb = extern "C" fn(*const c_char, *const c_char, usize, c_int, *mut c_void);
type MldErrorCb = extern "C" fn(*const c_char, *const c_char, *const c_char, *mut c_void);
type MldFrameCb = extern "C" fn(c_int, *const c_char, c_int, *mut c_void);
type MldLocalCb =
    extern "C" fn(*const c_char, *const c_char, *const c_char, c_int, c_int, *mut c_void);

const ML_DBG_STATUS_PAUSED: c_int = 1;
const ML_DBG_STATUS_COMPLETED: c_int = 2;
const ML_DBG_STATUS_ERROR: c_int = 3;

const ML_DBG_ACTION_CONTINUE: c_int = 0;
const ML_DBG_ACTION_STEP_IN: c_int = 1;
const ML_DBG_ACTION_STEP_OVER: c_int = 2;
const ML_DBG_ACTION_STEP_OUT: c_int = 3;

extern "C" {
    fn mlk_add_library_path(path: *const c_char);

    fn ml_dbg_init(exec_name: *const c_char, ws_root: *const c_char);
    fn ml_dbg_define_global(name: *const c_char, val: *mut c_void);
    fn ml_dbg_set_breakpoints(source: *const c_char, lines: *const c_int, count: usize);
    fn ml_dbg_clear_all_breakpoints();
    fn ml_dbg_set_break_on_error(enabled: c_int);

    fn ml_dbg_start(
        source_name: *const c_char,
        code: *const c_char,
        stop_on_entry: c_int,
        break_on_error: c_int,
        stdout_cb: MldStdoutCb,
        display_cb: MldDisplayCb,
        cb_ctx: *mut c_void,
    ) -> c_int;

    fn ml_dbg_resume(
        action: c_int,
        stdout_cb: MldStdoutCb,
        display_cb: MldDisplayCb,
        cb_ctx: *mut c_void,
    ) -> c_int;

    fn ml_dbg_get_pause_info(
        reason_buf: *mut c_char,
        reason_cap: usize,
        source_buf: *mut c_char,
        source_cap: usize,
        line_out: *mut c_int,
    );

    fn ml_dbg_get_final_result(
        type_buf: *mut c_char,
        type_cap: usize,
        repr_buf: *mut c_char,
        repr_cap: usize,
        is_nil_out: *mut c_int,
    );

    fn ml_dbg_get_error(
        type_buf: *mut c_char,
        type_cap: usize,
        msg_buf: *mut c_char,
        msg_cap: usize,
        tb_buf: *mut c_char,
        tb_cap: usize,
    );

    fn ml_dbg_frames(cb: MldFrameCb, ctx: *mut c_void);
    fn ml_dbg_locals(depth: c_int, cb: MldLocalCb, ctx: *mut c_void);

    fn ml_dbg_eval_in_frame(
        depth: c_int,
        expr: *const c_char,
        stdout_cb: MldStdoutCb,
        display_cb: MldDisplayCb,
        result_cb: MldResultCb,
        error_cb: MldErrorCb,
        ctx: *mut c_void,
    );
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugFrame {
    pub depth: usize,
    pub source: String,
    pub line: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugLocal {
    pub name: String,
    pub type_name: String,
    pub value: String,
    pub decl_line: u32,
    pub is_upvalue: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum DebugWorkerRequest {
    Start {
        source: String,
        code: String,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        breakpoints: BTreeMap<String, Vec<u32>>,
        #[serde(default)]
        stop_on_entry: bool,
        #[serde(default)]
        break_on_error: bool,
        #[serde(default)]
        params: BTreeMap<String, TaggedValue>,
        #[serde(default)]
        env: BTreeMap<String, String>,
    },
    Step {
        action: String,
    },
    SetBreakpoints {
        source: String,
        lines: Vec<u32>,
    },
    ClearBreakpoints,
    SetConfig {
        break_on_error: bool,
    },
    Locals {
        depth: usize,
    },
    Eval {
        expr: String,
        depth: usize,
    },
    Terminate,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DebugWorkerResponse {
    State {
        status: String,
        reason: Option<String>,
        source: Option<String>,
        line: Option<u32>,
        frames: Vec<DebugFrame>,
        locals: Vec<DebugLocal>,
        stdout_chunk: String,
        displays: Vec<DisplayItem>,
        result: Option<EvalValue>,
        error: Option<EvalError>,
    },
    LocalsResult {
        depth: usize,
        locals: Vec<DebugLocal>,
    },
    EvalResult {
        result: Option<EvalValue>,
        stdout: String,
        error: Option<EvalError>,
    },
    Ok {
        message: String,
    },
    Err {
        message: String,
    },
}

struct OutputCollector {
    stdout: String,
    displays: Vec<DisplayItem>,
    result: Option<EvalValue>,
    error: Option<EvalError>,
}

extern "C" fn on_stdout(data: *const c_char, len: usize, ctx: *mut c_void) {
    if data.is_null() || len == 0 {
        return;
    }
    unsafe {
        let col = &mut *(ctx as *mut OutputCollector);
        let bytes = std::slice::from_raw_parts(data as *const u8, len);
        col.stdout.push_str(&String::from_utf8_lossy(bytes));
    }
}

extern "C" fn on_display(
    mime: *const c_char,
    data: *const c_char,
    len: usize,
    ctx: *mut c_void,
) {
    unsafe {
        let col = &mut *(ctx as *mut OutputCollector);
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
        col.displays.push(DisplayItem {
            mime: mime_str,
            data: data_str,
        });
    }
}

extern "C" fn on_eval_result(
    type_name: *const c_char,
    repr: *const c_char,
    repr_len: usize,
    is_nil: c_int,
    ctx: *mut c_void,
) {
    unsafe {
        let col = &mut *(ctx as *mut OutputCollector);
        let tname = if type_name.is_null() {
            "any".to_string()
        } else {
            CStr::from_ptr(type_name).to_string_lossy().into_owned()
        };
        let repr_str = if repr.is_null() || repr_len == 0 {
            String::new()
        } else {
            let bytes = std::slice::from_raw_parts(repr as *const u8, repr_len);
            String::from_utf8_lossy(bytes).into_owned()
        };
        col.result = Some(EvalValue {
            type_name: tname,
            repr: repr_str,
            is_nil: is_nil != 0,
        });
    }
}

extern "C" fn on_eval_error(
    err_type: *const c_char,
    err_msg: *const c_char,
    traceback: *const c_char,
    ctx: *mut c_void,
) {
    unsafe {
        let col = &mut *(ctx as *mut OutputCollector);
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
        col.error = Some(EvalError {
            error_type: et,
            message: em,
            traceback: tb,
        });
    }
}

extern "C" fn on_frame(depth: c_int, source: *const c_char, line: c_int, ctx: *mut c_void) {
    unsafe {
        let frames = &mut *(ctx as *mut Vec<DebugFrame>);
        let src = if source.is_null() {
            "<unknown>".to_string()
        } else {
            CStr::from_ptr(source).to_string_lossy().into_owned()
        };
        frames.push(DebugFrame {
            depth: depth.max(0) as usize,
            source: src,
            line: line.max(0) as u32,
        });
    }
}

extern "C" fn on_local(
    name: *const c_char,
    type_name: *const c_char,
    repr: *const c_char,
    decl_line: c_int,
    is_upvalue: c_int,
    ctx: *mut c_void,
) {
    unsafe {
        let locals = &mut *(ctx as *mut Vec<DebugLocal>);
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
        let v = if repr.is_null() {
            String::new()
        } else {
            CStr::from_ptr(repr).to_string_lossy().into_owned()
        };
        locals.push(DebugLocal {
            name: n,
            type_name: t,
            value: v,
            decl_line: decl_line.max(0) as u32,
            is_upvalue: is_upvalue != 0,
        });
    }
}

fn cstr_from_buf(buf: &[c_char]) -> String {
    unsafe { CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned() }
}

fn collect_frames() -> Vec<DebugFrame> {
    let mut frames = Vec::new();
    unsafe {
        ml_dbg_frames(on_frame, &mut frames as *mut Vec<DebugFrame> as *mut c_void);
    }
    frames
}

fn collect_locals(depth: usize) -> Vec<DebugLocal> {
    let mut locals = Vec::new();
    unsafe {
        ml_dbg_locals(
            depth as c_int,
            on_local,
            &mut locals as *mut Vec<DebugLocal> as *mut c_void,
        );
    }
    locals
}

fn read_error_info() -> Option<EvalError> {
    let mut tbuf = [0 as c_char; 128];
    let mut mbuf = [0 as c_char; 2048];
    let mut tbbuf = [0 as c_char; 4096];
    unsafe {
        ml_dbg_get_error(
            tbuf.as_mut_ptr(),
            tbuf.len(),
            mbuf.as_mut_ptr(),
            mbuf.len(),
            tbbuf.as_mut_ptr(),
            tbbuf.len(),
        );
    }
    let et = cstr_from_buf(&tbuf);
    if et.is_empty() {
        None
    } else {
        Some(EvalError {
            error_type: et,
            message: cstr_from_buf(&mbuf),
            traceback: cstr_from_buf(&tbbuf),
        })
    }
}

fn build_state_response(status_code: c_int, col: OutputCollector) -> DebugWorkerResponse {
    match status_code {
        ML_DBG_STATUS_PAUSED => {
            let mut rbuf = [0 as c_char; 64];
            let mut sbuf = [0 as c_char; 4096];
            let mut line: c_int = 0;
            unsafe {
                ml_dbg_get_pause_info(
                    rbuf.as_mut_ptr(),
                    rbuf.len(),
                    sbuf.as_mut_ptr(),
                    sbuf.len(),
                    &mut line,
                );
            }
            let reason = cstr_from_buf(&rbuf);
            let source = cstr_from_buf(&sbuf);
            let frames = collect_frames();
            let locals = collect_locals(0);
            let error = if reason == "error" {
                read_error_info()
            } else {
                None
            };
            DebugWorkerResponse::State {
                status: "paused".to_string(),
                reason: if reason.is_empty() {
                    None
                } else {
                    Some(reason)
                },
                source: if source.is_empty() {
                    None
                } else {
                    Some(source)
                },
                line: if line > 0 { Some(line as u32) } else { None },
                frames,
                locals,
                stdout_chunk: col.stdout,
                displays: col.displays,
                result: None,
                error,
            }
        }
        ML_DBG_STATUS_COMPLETED => {
            let mut tbuf = [0 as c_char; 128];
            let mut rbuf = [0 as c_char; 4096];
            let mut is_nil: c_int = 1;
            unsafe {
                ml_dbg_get_final_result(
                    tbuf.as_mut_ptr(),
                    tbuf.len(),
                    rbuf.as_mut_ptr(),
                    rbuf.len(),
                    &mut is_nil,
                );
            }
            DebugWorkerResponse::State {
                status: "completed".to_string(),
                reason: Some("completed".to_string()),
                source: None,
                line: None,
                frames: Vec::new(),
                locals: Vec::new(),
                stdout_chunk: col.stdout,
                displays: col.displays,
                result: Some(EvalValue {
                    type_name: cstr_from_buf(&tbuf),
                    repr: cstr_from_buf(&rbuf),
                    is_nil: is_nil != 0,
                }),
                error: None,
            }
        }
        ML_DBG_STATUS_ERROR => {
            let error = read_error_info().or_else(|| {
                Some(EvalError {
                    error_type: "Error".to_string(),
                    message: "Unknown runtime error".to_string(),
                    traceback: String::new(),
                })
            });
            DebugWorkerResponse::State {
                status: "error".to_string(),
                reason: Some("error".to_string()),
                source: None,
                line: None,
                frames: Vec::new(),
                locals: Vec::new(),
                stdout_chunk: col.stdout,
                displays: col.displays,
                result: None,
                error,
            }
        }
        _ => DebugWorkerResponse::State {
            status: "completed".to_string(),
            reason: None,
            source: None,
            line: None,
            frames: Vec::new(),
            locals: Vec::new(),
            stdout_chunk: col.stdout,
            displays: col.displays,
            result: None,
            error: None,
        },
    }
}

fn apply_breakpoints_for_source(source: &str, lines: &[u32]) {
    let c_src = CString::new(source).unwrap_or_else(|_| CString::new("<debug>").unwrap());
    let c_lines: Vec<c_int> = lines.iter().map(|&l| l as c_int).collect();
    unsafe {
        ml_dbg_set_breakpoints(
            c_src.as_ptr(),
            if c_lines.is_empty() {
                std::ptr::null()
            } else {
                c_lines.as_ptr()
            },
            c_lines.len(),
        );
    }
}

pub fn run_debug_worker_process() -> io::Result<()> {
    let exe_name = CString::new("minilang-notebook-debug").unwrap();
    let ws_root_str = std::env::var("MINILANG_WORKSPACE_ROOT").unwrap_or_else(|_| {
        std::env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".to_string())
    });
    let ws_cstr = CString::new(ws_root_str.as_str()).unwrap_or_else(|_| CString::new(".").unwrap());

    unsafe {
        ml_dbg_init(exe_name.as_ptr(), ws_cstr.as_ptr());
        mlk_add_library_path(ws_cstr.as_ptr());
    }

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for line_res in stdin.lock().lines() {
        let line = match line_res {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let req: DebugWorkerRequest = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(e) => {
                let resp = DebugWorkerResponse::Err {
                    message: format!("Invalid debug request: {}", e),
                };
                writeln!(out, "{}", serde_json::to_string(&resp).unwrap())?;
                out.flush()?;
                continue;
            }
        };

        let mut should_exit = false;
        let resp = match req {
            DebugWorkerRequest::Start {
                source,
                code,
                cwd,
                breakpoints,
                stop_on_entry,
                break_on_error,
                params,
                env,
            } => {
                for (k, v) in env {
                    std::env::set_var(k, v);
                }
                if let Some(dir) = cwd {
                    if std::env::set_current_dir(&dir).is_ok() {
                        if let Ok(c_dir) = CString::new(dir) {
                            unsafe {
                                mlk_add_library_path(c_dir.as_ptr());
                            }
                        }
                    }
                }
                if let Err(msg) = bind_minilang_params(&params, ml_dbg_define_global) {
                    let resp = DebugWorkerResponse::State {
                        status: "error".to_string(),
                        reason: Some("error".to_string()),
                        source: Some(source),
                        line: None,
                        frames: Vec::new(),
                        locals: Vec::new(),
                        stdout_chunk: String::new(),
                        displays: Vec::new(),
                        result: None,
                        error: Some(EvalError {
                            error_type: "ParameterError".to_string(),
                            message: msg,
                            traceback: String::new(),
                        }),
                    };
                    writeln!(out, "{}", serde_json::to_string(&resp).unwrap())?;
                    out.flush()?;
                    continue;
                }
                unsafe {
                    ml_dbg_clear_all_breakpoints();
                }
                for (src, lines) in &breakpoints {
                    apply_breakpoints_for_source(src, lines);
                }

                let c_src =
                    CString::new(source.as_str()).unwrap_or_else(|_| CString::new("<debug>").unwrap());
                let sanitized_code = code.replace('\0', "");
                let c_code =
                    CString::new(sanitized_code).unwrap_or_else(|_| CString::new("").unwrap());

                let mut col = OutputCollector {
                    stdout: String::new(),
                    displays: Vec::new(),
                    result: None,
                    error: None,
                };
                let status = unsafe {
                    ml_dbg_start(
                        c_src.as_ptr(),
                        c_code.as_ptr(),
                        if stop_on_entry { 1 } else { 0 },
                        if break_on_error { 1 } else { 0 },
                        on_stdout,
                        on_display,
                        &mut col as *mut OutputCollector as *mut c_void,
                    )
                };
                build_state_response(status, col)
            }
            DebugWorkerRequest::Step { action } => {
                let act_code = match action.as_str() {
                    "step_in" | "in" => ML_DBG_ACTION_STEP_IN,
                    "step_over" | "over" | "next" => ML_DBG_ACTION_STEP_OVER,
                    "step_out" | "out" => ML_DBG_ACTION_STEP_OUT,
                    _ => ML_DBG_ACTION_CONTINUE,
                };
                let mut col = OutputCollector {
                    stdout: String::new(),
                    displays: Vec::new(),
                    result: None,
                    error: None,
                };
                let status = unsafe {
                    ml_dbg_resume(
                        act_code,
                        on_stdout,
                        on_display,
                        &mut col as *mut OutputCollector as *mut c_void,
                    )
                };
                build_state_response(status, col)
            }
            DebugWorkerRequest::SetBreakpoints { source, lines } => {
                apply_breakpoints_for_source(&source, &lines);
                DebugWorkerResponse::Ok {
                    message: "breakpoints updated".to_string(),
                }
            }
            DebugWorkerRequest::ClearBreakpoints => {
                unsafe {
                    ml_dbg_clear_all_breakpoints();
                }
                DebugWorkerResponse::Ok {
                    message: "breakpoints cleared".to_string(),
                }
            }
            DebugWorkerRequest::SetConfig { break_on_error } => {
                unsafe {
                    ml_dbg_set_break_on_error(if break_on_error { 1 } else { 0 });
                }
                DebugWorkerResponse::Ok {
                    message: "config updated".to_string(),
                }
            }
            DebugWorkerRequest::Locals { depth } => DebugWorkerResponse::LocalsResult {
                depth,
                locals: collect_locals(depth),
            },
            DebugWorkerRequest::Eval { expr, depth } => {
                let sanitized = expr.replace('\0', "");
                let c_expr =
                    CString::new(sanitized).unwrap_or_else(|_| CString::new("").unwrap());
                let mut col = OutputCollector {
                    stdout: String::new(),
                    displays: Vec::new(),
                    result: None,
                    error: None,
                };
                unsafe {
                    ml_dbg_eval_in_frame(
                        depth as c_int,
                        c_expr.as_ptr(),
                        on_stdout,
                        on_display,
                        on_eval_result,
                        on_eval_error,
                        &mut col as *mut OutputCollector as *mut c_void,
                    );
                }
                DebugWorkerResponse::EvalResult {
                    result: col.result,
                    stdout: col.stdout,
                    error: col.error,
                }
            }
            DebugWorkerRequest::Terminate => {
                should_exit = true;
                DebugWorkerResponse::Ok {
                    message: "terminating".to_string(),
                }
            }
        };

        writeln!(out, "{}", serde_json::to_string(&resp).unwrap())?;
        out.flush()?;
        if should_exit {
            break;
        }
    }

    Ok(())
}
