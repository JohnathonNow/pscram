use crate::debug_worker::{DebugFrame, DebugLocal, DebugWorkerRequest, DebugWorkerResponse};
use crate::files::FileStore;
use crate::kernel_proc::{DisplayItem, EvalError, EvalValue};
use crate::secrets::SecretsVault;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct StartDebugRequest {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub breakpoints: BTreeMap<String, Vec<u32>>,
    #[serde(default)]
    pub stop_on_entry: bool,
    #[serde(default)]
    pub break_on_error: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DebugSessionSnapshot {
    pub id: String,
    pub created_at: String,
    pub source: String,
    pub code: String,
    pub status: String, // "paused" | "running" | "completed" | "error" | "terminated"
    pub reason: Option<String>,
    pub current_source: Option<String>,
    pub current_line: Option<u32>,
    pub frames: Vec<DebugFrame>,
    pub locals: Vec<DebugLocal>,
    pub breakpoints: BTreeMap<String, Vec<u32>>,
    pub break_on_error: bool,
    pub stdout: String,
    pub displays: Vec<DisplayItem>,
    pub result: Option<EvalValue>,
    pub error: Option<EvalError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DebugEvalResponse {
    pub ok: bool,
    pub depth: usize,
    pub expr: String,
    pub result: Option<EvalValue>,
    pub stdout: String,
    pub error: Option<EvalError>,
}

struct WorkerIo {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

struct DebugSession {
    info: Mutex<DebugSessionSnapshot>,
    io: Mutex<Option<WorkerIo>>,
    child: Mutex<Option<Child>>,
}

impl DebugSession {
    async fn send_cmd(&self, req: &DebugWorkerRequest) -> Result<DebugWorkerResponse, String> {
        let mut guard = self.io.lock().await;
        let io = guard
            .as_mut()
            .ok_or_else(|| "Debug session is no longer active".to_string())?;
        let line = serde_json::to_string(req).map_err(|e| format!("Serialize error: {}", e))?;
        io.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("Debug worker write failed: {}", e))?;
        io.stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Debug worker write failed: {}", e))?;
        io.stdin
            .flush()
            .await
            .map_err(|e| format!("Debug worker flush failed: {}", e))?;

        let mut resp_line = String::new();
        let n = io
            .stdout
            .read_line(&mut resp_line)
            .await
            .map_err(|e| format!("Debug worker read failed: {}", e))?;
        if n == 0 {
            return Err("Debug worker exited unexpectedly".to_string());
        }
        serde_json::from_str(resp_line.trim())
            .map_err(|e| format!("Invalid response from debug worker: {}", e))
    }

    async fn kill_worker(&self) {
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }

    async fn apply_state_resp(&self, resp: DebugWorkerResponse) -> Result<DebugSessionSnapshot, String> {
        match resp {
            DebugWorkerResponse::State {
                status,
                reason,
                source,
                line,
                frames,
                locals,
                stdout_chunk,
                displays,
                result,
                error,
            } => {
                let finished = status == "completed" || status == "error";
                let snap = {
                    let mut info = self.info.lock().await;
                    info.status = status;
                    info.reason = reason;
                    info.current_source = source;
                    info.current_line = line;
                    info.frames = frames;
                    info.locals = locals;
                    if !stdout_chunk.is_empty() {
                        info.stdout.push_str(&stdout_chunk);
                    }
                    if !displays.is_empty() {
                        info.displays.extend(displays);
                    }
                    info.result = result;
                    info.error = error;
                    info.clone()
                };
                if finished {
                    let _ = self.io.lock().await.take();
                    self.kill_worker().await;
                }
                Ok(snap)
            }
            DebugWorkerResponse::Err { message } => Err(message),
            other => Err(format!("Unexpected worker response: {:?}", other)),
        }
    }
}

pub struct DebugManager {
    root: PathBuf,
    secrets: Arc<SecretsVault>,
    sessions: Mutex<BTreeMap<String, Arc<DebugSession>>>,
}

impl DebugManager {
    pub fn new(root: PathBuf, secrets: Arc<SecretsVault>) -> Self {
        Self {
            root,
            secrets,
            sessions: Mutex::new(BTreeMap::new()),
        }
    }

    pub async fn list(&self) -> Vec<DebugSessionSnapshot> {
        let sessions: Vec<Arc<DebugSession>> = self.sessions.lock().await.values().cloned().collect();
        let mut out = Vec::with_capacity(sessions.len());
        for s in sessions {
            out.push(s.info.lock().await.clone());
        }
        out
    }

    pub async fn get(&self, id: &str) -> Option<DebugSessionSnapshot> {
        let sess = self.sessions.lock().await.get(id).cloned()?;
        let snap = sess.info.lock().await.clone();
        Some(snap)
    }

    pub async fn start(
        &self,
        req: StartDebugRequest,
        files: &FileStore,
    ) -> Result<DebugSessionSnapshot, String> {
        let (source, code, default_cwd) = if let Some(rel_path) = req.path.as_deref() {
            let trimmed = rel_path.trim().trim_start_matches('/');
            let full = files
                .resolve_existing(trimmed)
                .map_err(|e| format!("Invalid script path '{}': {}", trimmed, e))?;
            let text = match req.code {
                Some(override_code) => override_code,
                None => std::fs::read_to_string(&full)
                    .map_err(|e| format!("Failed to read '{}': {}", trimmed, e))?,
            };
            let parent = full
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| self.root.clone());
            (trimmed.to_string(), text, parent)
        } else if let Some(code) = req.code {
            let src = req
                .source
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "<cell>".to_string());
            (src, code, self.root.clone())
        } else {
            return Err("Either 'path' or 'code' is required to start debugging".to_string());
        };

        let cwd = if let Some(c) = req.cwd.as_deref().filter(|s| !s.trim().is_empty()) {
            files
                .resolve_existing(c)
                .unwrap_or(default_cwd)
        } else {
            default_cwd
        };

        let exe = std::env::current_exe()
            .map_err(|e| format!("Failed to locate server binary: {}", e))?;

        let mut cmd = Command::new(exe);
        cmd.arg("--debug-worker")
            .current_dir(&cwd)
            .env("MINILANG_WORKSPACE_ROOT", &self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn debug worker: {}", e))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to capture debug worker stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture debug worker stdout".to_string())?;

        let id = format!("dbg-{}", &Uuid::new_v4().to_string()[..8]);
        let initial_snap = DebugSessionSnapshot {
            id: id.clone(),
            created_at: Utc::now().to_rfc3339(),
            source: source.clone(),
            code: code.clone(),
            status: "running".to_string(),
            reason: None,
            current_source: Some(source.clone()),
            current_line: None,
            frames: Vec::new(),
            locals: Vec::new(),
            breakpoints: req.breakpoints.clone(),
            break_on_error: req.break_on_error,
            stdout: String::new(),
            displays: Vec::new(),
            result: None,
            error: None,
        };

        let session = Arc::new(DebugSession {
            info: Mutex::new(initial_snap),
            io: Mutex::new(Some(WorkerIo {
                stdin,
                stdout: BufReader::new(stdout),
            })),
            child: Mutex::new(Some(child)),
        });

        self.sessions.lock().await.insert(id.clone(), session.clone());

        let env_vars: BTreeMap<String, String> = self.secrets.env_map();

        let start_req = DebugWorkerRequest::Start {
            source,
            code,
            cwd: Some(cwd.to_string_lossy().into_owned()),
            breakpoints: req.breakpoints,
            stop_on_entry: req.stop_on_entry,
            break_on_error: req.break_on_error,
            env: env_vars,
        };

        match session.send_cmd(&start_req).await {
            Ok(resp) => session.apply_state_resp(resp).await,
            Err(e) => {
                session.kill_worker().await;
                let mut info = session.info.lock().await;
                info.status = "terminated".to_string();
                Err(e)
            }
        }
    }

    pub async fn step(&self, id: &str, action: &str) -> Result<DebugSessionSnapshot, String> {
        let sess = self
            .sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Debug session '{}' not found", id))?;

        {
            let mut info = sess.info.lock().await;
            if info.status != "paused" {
                return Err(format!("Debug session is not paused (status: {})", info.status));
            }
            info.status = "running".to_string();
        }

        let req = DebugWorkerRequest::Step {
            action: action.to_string(),
        };
        match sess.send_cmd(&req).await {
            Ok(resp) => sess.apply_state_resp(resp).await,
            Err(e) => {
                let mut info = sess.info.lock().await;
                if info.status == "running" {
                    info.status = "terminated".to_string();
                }
                Err(e)
            }
        }
    }

    pub async fn set_breakpoints(
        &self,
        id: &str,
        source: String,
        mut lines: Vec<u32>,
    ) -> Result<DebugSessionSnapshot, String> {
        lines.sort_unstable();
        lines.dedup();
        let sess = self
            .sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Debug session '{}' not found", id))?;

        let req = DebugWorkerRequest::SetBreakpoints {
            source: source.clone(),
            lines: lines.clone(),
        };
        let _ = sess.send_cmd(&req).await?;

        let mut info = sess.info.lock().await;
        if lines.is_empty() {
            info.breakpoints.remove(&source);
        } else {
            info.breakpoints.insert(source, lines);
        }
        Ok(info.clone())
    }

    pub async fn set_config(
        &self,
        id: &str,
        break_on_error: bool,
    ) -> Result<DebugSessionSnapshot, String> {
        let sess = self
            .sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Debug session '{}' not found", id))?;

        let req = DebugWorkerRequest::SetConfig { break_on_error };
        let _ = sess.send_cmd(&req).await?;

        let mut info = sess.info.lock().await;
        info.break_on_error = break_on_error;
        Ok(info.clone())
    }

    pub async fn locals(&self, id: &str, depth: usize) -> Result<Vec<DebugLocal>, String> {
        let sess = self
            .sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Debug session '{}' not found", id))?;

        let resp = sess
            .send_cmd(&DebugWorkerRequest::Locals { depth })
            .await?;
        match resp {
            DebugWorkerResponse::LocalsResult { locals, .. } => Ok(locals),
            DebugWorkerResponse::Err { message } => Err(message),
            other => Err(format!("Unexpected worker response: {:?}", other)),
        }
    }

    pub async fn eval_in_frame(
        &self,
        id: &str,
        expr: String,
        depth: usize,
    ) -> Result<DebugEvalResponse, String> {
        let sess = self
            .sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Debug session '{}' not found", id))?;

        let resp = sess
            .send_cmd(&DebugWorkerRequest::Eval {
                expr: expr.clone(),
                depth,
            })
            .await?;
        match resp {
            DebugWorkerResponse::EvalResult {
                result,
                stdout,
                error,
            } => Ok(DebugEvalResponse {
                ok: error.is_none(),
                depth,
                expr,
                result,
                stdout,
                error,
            }),
            DebugWorkerResponse::Err { message } => Err(message),
            other => Err(format!("Unexpected worker response: {:?}", other)),
        }
    }

    pub async fn terminate(&self, id: &str) -> Result<DebugSessionSnapshot, String> {
        let sess = self
            .sessions
            .lock()
            .await
            .remove(id)
            .ok_or_else(|| format!("Debug session '{}' not found", id))?;

        sess.kill_worker().await;
        let _ = sess.io.lock().await.take();

        let mut info = sess.info.lock().await;
        info.status = "terminated".to_string();
        info.reason = Some("terminated".to_string());
        info.frames.clear();
        info.locals.clear();
        Ok(info.clone())
    }
}
