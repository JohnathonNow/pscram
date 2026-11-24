use crate::kernel_proc::{
    CompletionItem, EvalError, EvalValue, KernelRequest, KernelResponse, VarInfo,
};
use crate::lang::{InvokeScriptRequest, LanguageBackend, LanguageRegistry};
use crate::secrets::SecretsVault;
use crate::tagged::TaggedValue;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex;

struct KernelIo {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

pub struct KernelSession {
    pub id: String,
    pub language: String,
    backend: Arc<dyn LanguageBackend>,
    secrets: Arc<SecretsVault>,
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
    pub language: String,
    pub alive: bool,
    pub busy: bool,
    pub pid: u32,
    pub execution_count: u64,
    pub cwd: String,
}

impl KernelSession {
    async fn spawn_new(
        id: String,
        backend: Arc<dyn LanguageBackend>,
        secrets: Arc<SecretsVault>,
        cwd: PathBuf,
    ) -> Result<Arc<Self>, String> {
        let language = backend.info().id;
        let session = Arc::new(Self {
            id,
            language,
            backend,
            secrets,
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
        let cwd = self.cwd.lock().await.clone();
        let mut cmd = self.backend.kernel_command(&cwd)?;
        for (k, v) in self.secrets.env_map() {
            cmd.env(&k, &v);
            cmd.env(format!("MLNB_SECRET_{}", k), &v);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn {} kernel: {}", self.language, e))?;

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
            language: self.language.clone(),
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
                Err("Kernel exited unexpectedly. Click Restart Kernel to continue.".to_string())
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

    pub async fn execute_with_params(
        &self,
        code: String,
        source: Option<String>,
        params: Option<BTreeMap<String, TaggedValue>>,
    ) -> Result<KernelResponse, String> {
        if !self.alive.load(Ordering::SeqCst) {
            self.start_process().await?;
        }
        let resp = self
            .send_request(&KernelRequest::Eval {
                code,
                source,
                params,
            })
            .await?;
        if !self.alive.load(Ordering::SeqCst) {
            let _ = self.start_process().await;
        }
        Ok(resp)
    }

    pub async fn execute_stream(
        &self,
        code: String,
        source: Option<String>,
        tx: tokio::sync::mpsc::UnboundedSender<KernelResponse>,
    ) -> Result<KernelResponse, String> {
        if !self.alive.load(Ordering::SeqCst) {
            self.start_process().await?;
        }
        self.busy.store(true, Ordering::SeqCst);
        let res = self
            .send_stream_request_inner(&KernelRequest::EvalStream { code, source }, tx)
            .await;
        self.busy.store(false, Ordering::SeqCst);
        if !self.alive.load(Ordering::SeqCst) {
            let _ = self.start_process().await;
        }
        res
    }

    async fn send_stream_request_inner(
        &self,
        req: &KernelRequest,
        tx: tokio::sync::mpsc::UnboundedSender<KernelResponse>,
    ) -> Result<KernelResponse, String> {
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

        loop {
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
                    return Err("Kernel exited unexpectedly. Click Restart Kernel to continue.".to_string());
                }
                Ok(_) => {
                    let parsed: KernelResponse = serde_json::from_str(line.trim())
                        .map_err(|e| format!("invalid kernel response: {}", e))?;
                    match parsed {
                        KernelResponse::StreamEvent { .. } => {
                            let _ = tx.send(parsed);
                        }
                        other => {
                            if let KernelResponse::EvalResult { execution_count, .. } = &other {
                                self.exec_count.store(*execution_count, Ordering::SeqCst);
                            }
                            return Ok(other);
                        }
                    }
                }
                Err(e) => {
                    self.alive.store(false, Ordering::SeqCst);
                    *io_guard = None;
                    return Err(format!("Kernel read error: {}", e));
                }
            }
        }
    }

    pub async fn set_env(&self, vars: BTreeMap<String, Option<String>>) {
        if self.alive.load(Ordering::SeqCst) && !self.busy.load(Ordering::SeqCst) {
            let _ = self.send_request(&KernelRequest::SetEnv { vars }).await;
        }
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
    languages: Arc<LanguageRegistry>,
    secrets: Arc<SecretsVault>,
    sessions: Mutex<HashMap<String, Arc<KernelSession>>>,
}

impl KernelManager {
    pub fn new(
        root_dir: PathBuf,
        languages: Arc<LanguageRegistry>,
        secrets: Arc<SecretsVault>,
    ) -> Self {
        Self {
            root_dir,
            languages,
            secrets,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub async fn broadcast_env_update(&self, vars: BTreeMap<String, Option<String>>) {
        let sessions: Vec<Arc<KernelSession>> = {
            let map = self.sessions.lock().await;
            map.values().cloned().collect()
        };
        for s in sessions {
            s.set_env(vars.clone()).await;
        }
    }

    pub async fn get_or_create(
        &self,
        session_id: Option<String>,
        language: Option<&str>,
        cwd: Option<PathBuf>,
    ) -> Result<Arc<KernelSession>, String> {
        let id = session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let mut map = self.sessions.lock().await;
        if let Some(existing) = map.get(&id) {
            if let Some(req_lang) = language {
                if existing.language != req_lang {
                    // Language switched on existing session id: shut down old and respawn new language
                    let old = map.remove(&id).unwrap();
                    drop(map);
                    old.shutdown().await;
                    let backend = self
                        .languages
                        .by_id(req_lang)
                        .ok_or_else(|| format!("Unsupported language '{}'", req_lang))?;
                    let target_cwd = cwd.unwrap_or_else(|| self.root_dir.clone());
                    let session = KernelSession::spawn_new(
                        id.clone(),
                        backend,
                        self.secrets.clone(),
                        target_cwd,
                    )
                    .await?;
                    self.sessions.lock().await.insert(id, session.clone());
                    return Ok(session);
                }
            }
            return Ok(existing.clone());
        }

        let backend = match language {
            Some(l) => self
                .languages
                .by_id(l)
                .ok_or_else(|| format!("Unsupported language '{}'", l))?,
            None => self.languages.default_backend(),
        };
        let target_cwd = cwd.unwrap_or_else(|| self.root_dir.clone());
        let session = KernelSession::spawn_new(
            id.clone(),
            backend,
            self.secrets.clone(),
            target_cwd,
        )
        .await?;
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

    /// Invoke a script in any registered language backend with tagged JSON parameters.
    #[allow(clippy::too_many_arguments)]
    pub async fn invoke_script(
        &self,
        language_id: &str,
        code: String,
        source: String,
        cwd: PathBuf,
        params: BTreeMap<String, TaggedValue>,
        args: Vec<TaggedValue>,
        function: Option<String>,
        timeout_ms: u64,
    ) -> Result<KernelResponse, InvokeExecError> {
        let backend = self.languages.by_id(language_id).ok_or_else(|| {
            InvokeExecError::Internal(format!("Unsupported language '{}'", language_id))
        })?;
        backend
            .invoke_script(InvokeScriptRequest {
                code,
                source,
                cwd,
                params,
                args,
                function,
                timeout_ms,
                env: self.secrets.env_map(),
            })
            .await
    }
}

#[derive(Debug)]
pub enum InvokeExecError {
    Timeout(u64),
    Internal(String),
}

#[allow(dead_code)]
pub fn _type_check_reexports(_: Option<EvalValue>) {}
