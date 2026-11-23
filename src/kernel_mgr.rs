use crate::kernel_proc::{
    CompletionItem, EvalError, EvalValue, KernelRequest, KernelResponse, VarInfo,
};
use crate::tagged::TaggedValue;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

struct KernelIo {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

pub struct KernelSession {
    pub id: String,
    cwd: Mutex<PathBuf>,
    io: Mutex<Option<KernelIo>>,
    pid: AtomicU32,
    busy: AtomicBool,
    alive: AtomicBool,
    exec_count: AtomicU64,
    interrupted: AtomicBool,
}

#[derive(Debug, Clone, Serialize)]
pub struct KernelStatus {
    pub id: String,
    pub alive: bool,
    pub busy: bool,
    pub pid: u32,
    pub execution_count: u64,
    pub cwd: String,
}

impl KernelSession {
    async fn spawn_new(id: String, cwd: PathBuf) -> Result<Arc<Self>, String> {
        let session = Arc::new(Self {
            id,
            cwd: Mutex::new(cwd),
            io: Mutex::new(None),
            pid: AtomicU32::new(0),
            busy: AtomicBool::new(false),
            alive: AtomicBool::new(false),
            exec_count: AtomicU64::new(0),
            interrupted: AtomicBool::new(false),
        });
        session.start_process().await?;
        Ok(session)
    }

    async fn start_process(&self) -> Result<(), String> {
        let exe = std::env::current_exe()
            .map_err(|e| format!("failed to locate executable: {}", e))?;
        let cwd = self.cwd.lock().await.clone();

        let mut cmd = Command::new(exe);
        cmd.arg("--kernel")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if cwd.exists() {
            cmd.current_dir(&cwd);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn minilang kernel: {}", e))?;

        let pid = child.id().unwrap_or(0);
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to open kernel stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to open kernel stdout".to_string())?;

        let mut io_guard = self.io.lock().await;
        if let Some(mut old) = io_guard.take() {
            let _ = old.child.kill().await;
        }
        *io_guard = Some(KernelIo {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        });

        self.pid.store(pid, Ordering::SeqCst);
        self.alive.store(true, Ordering::SeqCst);
        self.busy.store(false, Ordering::SeqCst);
        self.exec_count.store(0, Ordering::SeqCst);
        self.interrupted.store(false, Ordering::SeqCst);
        Ok(())
    }

    pub async fn status(&self) -> KernelStatus {
        let cwd = self.cwd.lock().await.display().to_string();
        KernelStatus {
            id: self.id.clone(),
            alive: self.alive.load(Ordering::SeqCst),
            busy: self.busy.load(Ordering::SeqCst),
            pid: self.pid.load(Ordering::SeqCst),
            execution_count: self.exec_count.load(Ordering::SeqCst),
            cwd,
        }
    }

    async fn send_request(&self, req: &KernelRequest) -> Result<KernelResponse, String> {
        self.busy.store(true, Ordering::SeqCst);
        let res = self.send_request_inner(req).await;
        self.busy.store(false, Ordering::SeqCst);
        res
    }

    async fn send_request_inner(&self, req: &KernelRequest) -> Result<KernelResponse, String> {
        let mut io_guard = self.io.lock().await;
        let io = match io_guard.as_mut() {
            Some(io) => io,
            None => {
                self.alive.store(false, Ordering::SeqCst);
                return Err("Kernel is not running. Click Restart Kernel to start a new session.".to_string());
            }
        };

        let mut payload =
            serde_json::to_string(req).map_err(|e| format!("encode error: {}", e))?;
        payload.push('\n');

        if let Err(e) = io.stdin.write_all(payload.as_bytes()).await {
            self.alive.store(false, Ordering::SeqCst);
            *io_guard = None;
            return Err(format!("Kernel write failed (process exited): {}", e));
        }
        if let Err(e) = io.stdin.flush().await {
            self.alive.store(false, Ordering::SeqCst);
            *io_guard = None;
            return Err(format!("Kernel flush failed: {}", e));
        }

        let mut line = String::new();
        match io.stdout.read_line(&mut line).await {
            Ok(0) => {
                self.alive.store(false, Ordering::SeqCst);
                *io_guard = None;
                if self.interrupted.swap(false, Ordering::SeqCst) {
                    return Ok(KernelResponse::EvalResult {
                        execution_count: self.exec_count.load(Ordering::SeqCst) + 1,
                        stdout: String::new(),
                        displays: Vec::new(),
                        results: Vec::new(),
                        error: Some(EvalError {
                            error_type: "KeyboardInterrupt".to_string(),
                            message: "Execution interrupted; kernel process was terminated. Restarting fresh kernel..."
                                .to_string(),
                            traceback: String::new(),
                        }),
                        duration_ms: 0.0,
                    });
                }
                Err("Kernel exited unexpectedly (e.g. halt() called). Click Restart Kernel to continue.".to_string())
            }
            Ok(_) => {
                let parsed: KernelResponse = serde_json::from_str(line.trim())
                    .map_err(|e| format!("invalid kernel response: {}", e))?;
                if let KernelResponse::EvalResult { execution_count, .. } = &parsed {
                    self.exec_count.store(*execution_count, Ordering::SeqCst);
                }
                Ok(parsed)
            }
            Err(e) => {
                self.alive.store(false, Ordering::SeqCst);
                *io_guard = None;
                Err(format!("Kernel read error: {}", e))
            }
        }
    }

    pub async fn execute(&self, code: String, source: Option<String>) -> Result<KernelResponse, String> {
        if !self.alive.load(Ordering::SeqCst) {
            self.start_process().await?;
        }
        let resp = self.send_request(&KernelRequest::Eval { code, source }).await?;
        if !self.alive.load(Ordering::SeqCst) {
            // Auto-respawn after interrupt so next cell runs seamlessly
            let _ = self.start_process().await;
        }
        Ok(resp)
    }

    pub async fn inspect(&self) -> Result<(Vec<VarInfo>, usize), String> {
        if !self.alive.load(Ordering::SeqCst) {
            return Ok((Vec::new(), 0));
        }
        if self.busy.load(Ordering::SeqCst) {
            return Err("Kernel is busy".to_string());
        }
        match self.send_request(&KernelRequest::Inspect).await? {
            KernelResponse::InspectResult {
                variables,
                globals_count,
            } => Ok((variables, globals_count)),
            KernelResponse::Err { message } => Err(message),
            _ => Err("Unexpected response from inspect".to_string()),
        }
    }

    pub async fn complete(&self, prefix: String) -> Result<Vec<CompletionItem>, String> {
        if !self.alive.load(Ordering::SeqCst) {
            self.start_process().await?;
        }
        if self.busy.load(Ordering::SeqCst) {
            return Ok(Vec::new());
        }
        match self.send_request(&KernelRequest::Complete { prefix }).await? {
            KernelResponse::CompleteResult { items } => Ok(items),
            KernelResponse::Err { message } => Err(message),
            _ => Ok(Vec::new()),
        }
    }

    pub async fn chdir(&self, path: PathBuf) -> Result<(), String> {
        {
            let mut guard = self.cwd.lock().await;
            *guard = path.clone();
        }
        if self.alive.load(Ordering::SeqCst) && !self.busy.load(Ordering::SeqCst) {
            let _ = self
                .send_request(&KernelRequest::Chdir {
                    path: path.display().to_string(),
                })
                .await;
        }
        Ok(())
    }

    pub fn interrupt_now(&self) -> bool {
        let pid = self.pid.load(Ordering::SeqCst);
        if pid == 0 || !self.alive.load(Ordering::SeqCst) {
            return false;
        }
        self.interrupted.store(true, Ordering::SeqCst);
        // Kill the kernel child process immediately via SIGKILL using nix-free libc call
        unsafe {
            extern "C" {
                fn kill(pid: i32, sig: i32) -> i32;
            }
            kill(pid as i32, 9);
        }
        true
    }

    pub async fn restart(&self) -> Result<(), String> {
        self.interrupt_now();
        // Wait briefly for any in-flight eval lock to release
        self.start_process().await
    }

    pub async fn shutdown(&self) {
        self.interrupt_now();
        let mut io_guard = self.io.lock().await;
        if let Some(mut io) = io_guard.take() {
            let _ = io.child.kill().await;
        }
        self.alive.store(false, Ordering::SeqCst);
        self.pid.store(0, Ordering::SeqCst);
    }
}

pub struct KernelManager {
    root_dir: PathBuf,
    sessions: Mutex<HashMap<String, Arc<KernelSession>>>,
}

impl KernelManager {
    pub fn new(root_dir: PathBuf) -> Self {
        Self {
            root_dir,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub async fn get_or_create(
        &self,
        session_id: Option<String>,
        cwd: Option<PathBuf>,
    ) -> Result<Arc<KernelSession>, String> {
        let id = session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let mut map = self.sessions.lock().await;
        if let Some(existing) = map.get(&id) {
            return Ok(existing.clone());
        }
        let target_cwd = cwd.unwrap_or_else(|| self.root_dir.clone());
        let session = KernelSession::spawn_new(id.clone(), target_cwd).await?;
        map.insert(id, session.clone());
        Ok(session)
    }

    pub async fn get(&self, id: &str) -> Option<Arc<KernelSession>> {
        let map = self.sessions.lock().await;
        map.get(id).cloned()
    }

    pub async fn list(&self) -> Vec<KernelStatus> {
        let sessions: Vec<Arc<KernelSession>> = {
            let map = self.sessions.lock().await;
            map.values().cloned().collect()
        };
        let mut out = Vec::with_capacity(sessions.len());
        for s in sessions {
            out.push(s.status().await);
        }
        out
    }

    pub async fn remove(&self, id: &str) -> bool {
        let removed = {
            let mut map = self.sessions.lock().await;
            map.remove(id)
        };
        if let Some(session) = removed {
            session.shutdown().await;
            true
        } else {
            false
        }
    }

    /// Run a `.mini` script in a fresh isolated kernel subprocess with tagged JSON parameters.
    #[allow(clippy::too_many_arguments)]
    pub async fn invoke_script(
        &self,
        code: String,
        source: String,
        cwd: PathBuf,
        params: BTreeMap<String, TaggedValue>,
        args: Vec<TaggedValue>,
        function: Option<String>,
        timeout_ms: u64,
    ) -> Result<KernelResponse, InvokeExecError> {
        let exe = std::env::current_exe()
            .map_err(|e| InvokeExecError::Internal(format!("failed to locate executable: {}", e)))?;

        let mut cmd = Command::new(exe);
        cmd.arg("--kernel")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if cwd.exists() {
            cmd.current_dir(&cwd);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| InvokeExecError::Internal(format!("failed to spawn kernel: {}", e)))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| InvokeExecError::Internal("failed to open kernel stdin".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| InvokeExecError::Internal("failed to open kernel stdout".to_string()))?;
        let mut reader = BufReader::new(stdout);

        let req = KernelRequest::Invoke {
            code,
            source,
            params,
            args,
            function,
        };
        let mut payload = serde_json::to_string(&req)
            .map_err(|e| InvokeExecError::Internal(format!("encode error: {}", e)))?;
        payload.push('\n');

        let run_future = async {
            stdin
                .write_all(payload.as_bytes())
                .await
                .map_err(|e| InvokeExecError::Internal(format!("kernel write failed: {}", e)))?;
            stdin
                .flush()
                .await
                .map_err(|e| InvokeExecError::Internal(format!("kernel flush failed: {}", e)))?;
            drop(stdin);

            let mut line = String::new();
            let n = reader
                .read_line(&mut line)
                .await
                .map_err(|e| InvokeExecError::Internal(format!("kernel read failed: {}", e)))?;
            if n == 0 {
                return Err(InvokeExecError::Internal(
                    "Script kernel exited before returning a result (e.g. halt() called)"
                        .to_string(),
                ));
            }
            serde_json::from_str::<KernelResponse>(line.trim())
                .map_err(|e| InvokeExecError::Internal(format!("invalid kernel response: {}", e)))
        };

        let result = tokio::time::timeout(Duration::from_millis(timeout_ms), run_future).await;
        let _ = child.kill().await;
        let _ = child.wait().await;

        match result {
            Ok(inner) => inner,
            Err(_) => Err(InvokeExecError::Timeout(timeout_ms)),
        }
    }
}

#[derive(Debug)]
pub enum InvokeExecError {
    Timeout(u64),
    Internal(String),
}

#[allow(dead_code)]
pub fn _type_check_reexports(_: Option<EvalValue>) {}
