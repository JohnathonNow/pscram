use crate::files::FileStore;
use crate::kernel_mgr::KernelManager;
use crate::kernel_proc::{KernelRequest, KernelResponse};
use crate::lang::LanguageRegistry;
use crate::secrets::SecretsVault;
use crate::tagged::TaggedValue;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{Mutex, Notify};

const MLOG_MAGIC: &[u8; 4] = b"MLOG";

#[derive(Debug, Clone, Serialize)]
pub struct JobProgress {
    pub done: f64,
    pub total: f64,
    pub percent: f64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackgroundJobInfo {
    pub id: String,
    pub name: String,
    pub script: String,
    pub language: String,
    pub source: String,
    pub status: String, // "running" | "completed" | "failed" | "cancelled"
    pub pid: u32,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub duration_ms: f64,
    pub stdout: String,
    pub progress: Option<JobProgress>,
    pub result: Option<Value>,
    pub result_plain: Value,
    pub repr: String,
    pub error: Option<String>,
    pub log_path: String,
}

#[derive(Debug, Deserialize)]
pub struct StartJobRequest {
    pub script: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub params: Option<Value>,
    #[serde(default)]
    pub args: Option<Vec<Value>>,
    #[serde(default)]
    pub function: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

struct JobEntry {
    info: Mutex<BackgroundJobInfo>,
    started_instant: Instant,
    pid: AtomicU32,
    cancelled: AtomicBool,
    done_notify: Notify,
}

impl JobEntry {
    async fn snapshot(&self) -> BackgroundJobInfo {
        let mut info = self.info.lock().await.clone();
        info.pid = self.pid.load(Ordering::SeqCst);
        if info.status == "running" {
            info.duration_ms = self.started_instant.elapsed().as_secs_f64() * 1000.0;
        }
        info
    }

    fn kill_process_now(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let pid = self.pid.load(Ordering::SeqCst);
        if pid > 0 {
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
        }
    }
}

pub struct JobManager {
    workspace_root: PathBuf,
    jobs: Mutex<HashMap<String, Arc<JobEntry>>>,
    order: Mutex<Vec<String>>,
}

impl JobManager {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            workspace_root,
            jobs: Mutex::new(HashMap::new()),
            order: Mutex::new(Vec::new()),
        }
    }

    pub async fn list(&self) -> Vec<BackgroundJobInfo> {
        let entries: Vec<Arc<JobEntry>> = {
            let order = self.order.lock().await;
            let map = self.jobs.lock().await;
            order
                .iter()
                .rev()
                .filter_map(|id| map.get(id).cloned())
                .collect()
        };
        let mut out = Vec::with_capacity(entries.len());
        for e in entries {
            out.push(e.snapshot().await);
        }
        out
    }

    pub async fn get(&self, id: &str) -> Option<BackgroundJobInfo> {
        let entry = { self.jobs.lock().await.get(id).cloned() }?;
        Some(entry.snapshot().await)
    }

    pub async fn start(
        self: &Arc<Self>,
        req: StartJobRequest,
        files: Arc<FileStore>,
        kernels: Arc<KernelManager>,
        languages: Arc<LanguageRegistry>,
        secrets: Arc<SecretsVault>,
    ) -> Result<BackgroundJobInfo, String> {
        let (rel_path, abs_path, lang_id) =
            resolve_job_script(&files, &languages, &req.script, req.cwd.as_deref())?;
        let code = fs::read_to_string(&abs_path)
            .map_err(|e| format!("Failed to read '{}': {}", rel_path, e))?;

        let params = parse_params_value(req.params)?;
        let args = parse_args_values(req.args)?;

        let id = format!("bg-{}", &uuid::Uuid::new_v4().to_string()[..8]);
        let name = req
            .name
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                abs_path
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| rel_path.clone())
            });
        let source = req
            .source
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "api".to_string());
        let log_path = format!("logs/jobs/{}.mlog", id);
        let started_at = Utc::now();

        let initial = BackgroundJobInfo {
            id: id.clone(),
            name,
            script: rel_path.clone(),
            language: lang_id.clone(),
            source,
            status: "running".to_string(),
            pid: 0,
            started_at: started_at.to_rfc3339(),
            finished_at: None,
            duration_ms: 0.0,
            stdout: String::new(),
            progress: None,
            result: None,
            result_plain: Value::Null,
            repr: String::new(),
            error: None,
            log_path: log_path.clone(),
        };

        let entry = Arc::new(JobEntry {
            info: Mutex::new(initial.clone()),
            started_instant: Instant::now(),
            pid: AtomicU32::new(0),
            cancelled: AtomicBool::new(false),
            done_notify: Notify::new(),
        });

        {
            self.jobs.lock().await.insert(id.clone(), entry.clone());
            self.order.lock().await.push(id.clone());
        }

        let cwd = abs_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| files.root().to_path_buf());
        let log_abs = self.workspace_root.join(&log_path);
        let entry_bg = entry.clone();
        let fn_opt = req.function.filter(|s| !s.trim().is_empty());

        tokio::spawn(async move {
            if lang_id == "minilang" {
                run_minilang_background_job(
                    entry_bg.clone(),
                    code,
                    rel_path,
                    cwd,
                    params,
                    args,
                    fn_opt,
                    secrets,
                    log_abs,
                )
                .await;
            } else {
                run_generic_background_job(
                    entry_bg.clone(),
                    lang_id,
                    code,
                    rel_path,
                    cwd,
                    params,
                    args,
                    fn_opt,
                    kernels,
                    log_abs,
                )
                .await;
            }
            entry_bg.done_notify.notify_waiters();
        });

        Ok(initial)
    }

    pub async fn wait(&self, id: &str, timeout_ms: Option<u64>) -> Result<BackgroundJobInfo, String> {
        let entry = {
            self.jobs
                .lock()
                .await
                .get(id)
                .cloned()
                .ok_or_else(|| format!("Background job '{}' not found", id))?
        };
        let deadline = timeout_ms.map(|ms| Instant::now() + Duration::from_millis(ms.max(10)));
        loop {
            let notified = entry.done_notify.notified();
            let snap = entry.snapshot().await;
            if snap.status != "running" {
                return Ok(snap);
            }
            match deadline {
                Some(dl) => {
                    let now = Instant::now();
                    if now >= dl {
                        return Ok(snap);
                    }
                    let rem = dl - now;
                    let _ = tokio::time::timeout(rem, notified).await;
                }
                None => {
                    notified.await;
                }
            }
        }
    }

    pub async fn stop(&self, id: &str) -> Result<BackgroundJobInfo, String> {
        let entry = {
            self.jobs
                .lock()
                .await
                .get(id)
                .cloned()
                .ok_or_else(|| format!("Background job '{}' not found", id))?
        };
        let is_running = { entry.info.lock().await.status == "running" };
        if is_running {
            entry.kill_process_now();
            let mut info = entry.info.lock().await;
            if info.status == "running" {
                info.status = "cancelled".to_string();
                info.finished_at = Some(Utc::now().to_rfc3339());
                info.duration_ms = entry.started_instant.elapsed().as_secs_f64() * 1000.0;
                info.error = Some("Job stopped by user".to_string());
                entry.pid.store(0, Ordering::SeqCst);
            }
            drop(info);
            entry.done_notify.notify_waiters();
        }
        Ok(entry.snapshot().await)
    }

    pub async fn remove(&self, id: &str) -> bool {
        let entry = { self.jobs.lock().await.remove(id) };
        if let Some(e) = entry {
            e.kill_process_now();
            e.done_notify.notify_waiters();
            self.order.lock().await.retain(|x| x != id);
            true
        } else {
            false
        }
    }

    pub async fn clear_finished(&self) -> usize {
        let mut to_remove = Vec::new();
        let all: Vec<(String, Arc<JobEntry>)> = {
            self.jobs
                .lock()
                .await
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        };
        for (id, e) in all {
            if e.info.lock().await.status != "running" {
                to_remove.push(id);
            }
        }
        let removed = to_remove.len();
        if removed > 0 {
            let mut map = self.jobs.lock().await;
            for id in &to_remove {
                map.remove(id);
            }
            self.order.lock().await.retain(|id| !to_remove.contains(id));
        }
        removed
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_minilang_background_job(
    entry: Arc<JobEntry>,
    code: String,
    source: String,
    cwd: PathBuf,
    params: BTreeMap<String, TaggedValue>,
    args: Vec<TaggedValue>,
    function: Option<String>,
    secrets: Arc<SecretsVault>,
    log_abs: PathBuf,
) {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            finalize_job_error(&entry, &log_abs, format!("Failed to locate executable: {}", e)).await;
            return;
        }
    };

    let mut cmd = Command::new(exe);
    cmd.arg("--kernel")
        .arg("--lang")
        .arg("minilang")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if cwd.exists() {
        cmd.current_dir(&cwd);
    }
    for (k, v) in secrets.env_map() {
        cmd.env(&k, &v);
        cmd.env(format!("MLNB_SECRET_{}", k), &v);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            finalize_job_error(&entry, &log_abs, format!("Failed to spawn Minilang job worker: {}", e)).await;
            return;
        }
    };
    let pid = child.id().unwrap_or(0);
    entry.pid.store(pid, Ordering::SeqCst);

    // If cancelled before pid was stored, kill immediately
    if entry.cancelled.load(Ordering::SeqCst) {
        let _ = child.kill().await;
        let _ = child.wait().await;
        entry.pid.store(0, Ordering::SeqCst);
        return;
    }

    let mut stdin = match child.stdin.take() {
        Some(s) => s,
        None => {
            let _ = child.kill().await;
            finalize_job_error(&entry, &log_abs, "Failed to open job stdin".to_string()).await;
            return;
        }
    };
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill().await;
            finalize_job_error(&entry, &log_abs, "Failed to open job stdout".to_string()).await;
            return;
        }
    };

    let kreq = KernelRequest::Invoke {
        code,
        source,
        params,
        args,
        function,
        stream: true,
    };
    let mut payload = match serde_json::to_string(&kreq) {
        Ok(s) => s,
        Err(e) => {
            let _ = child.kill().await;
            finalize_job_error(&entry, &log_abs, format!("Encode error: {}", e)).await;
            return;
        }
    };
    payload.push('\n');

    if let Err(e) = stdin.write_all(payload.as_bytes()).await {
        let _ = child.kill().await;
        finalize_job_error(&entry, &log_abs, format!("Write error: {}", e)).await;
        return;
    }
    let _ = stdin.flush().await;
    drop(stdin);

    let mut reader = BufReader::new(stdout);
    let mut final_invoke: Option<KernelResponse> = None;

    loop {
        let mut line = String::new();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Ok(_) => {
                let Ok(parsed) = serde_json::from_str::<KernelResponse>(line.trim()) else {
                    continue;
                };
                match parsed {
                    KernelResponse::StreamEvent { event, data } => {
                        let mut info = entry.info.lock().await;
                        if event == "stdout" {
                            if let Some(txt) = data.get("text").and_then(|v| v.as_str()) {
                                if info.stdout.len() < 512 * 1024 {
                                    info.stdout.push_str(txt);
                                }
                            }
                        } else if event == "progress" {
                            let done = data.get("done").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let total = data.get("total").and_then(|v| v.as_f64()).unwrap_or(100.0);
                            let percent = data.get("percent").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let label = data
                                .get("label")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            info.progress = Some(JobProgress {
                                done,
                                total,
                                percent,
                                label,
                            });
                        }
                    }
                    other => {
                        final_invoke = Some(other);
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }

    let _ = child.kill().await;
    let _ = child.wait().await;
    entry.pid.store(0, Ordering::SeqCst);

    if entry.cancelled.load(Ordering::SeqCst) {
        let snap = entry.snapshot().await;
        write_job_mlog(&log_abs, &snap);
        return;
    }

    match final_invoke {
        Some(KernelResponse::InvokeResult {
            result,
            repr,
            stdout,
            error,
            duration_ms,
            ..
        }) => {
            let mut info = entry.info.lock().await;
            info.finished_at = Some(Utc::now().to_rfc3339());
            info.duration_ms = duration_ms;
            if !stdout.is_empty() {
                info.stdout = stdout;
            }
            info.repr = repr;
            if let Some(e) = error {
                info.status = "failed".to_string();
                info.error = Some(format!("{}: {}", e.error_type, e.message));
            } else {
                info.status = "completed".to_string();
                info.result_plain = tagged_json_to_plain(&result);
                info.result = Some(result);
            }
            let snap = info.clone();
            drop(info);
            write_job_mlog(&log_abs, &snap);
        }
        _ => {
            finalize_job_error(
                &entry,
                &log_abs,
                "Background job worker exited unexpectedly before returning a result".to_string(),
            )
            .await;
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_generic_background_job(
    entry: Arc<JobEntry>,
    lang_id: String,
    code: String,
    source: String,
    cwd: PathBuf,
    params: BTreeMap<String, TaggedValue>,
    args: Vec<TaggedValue>,
    function: Option<String>,
    kernels: Arc<KernelManager>,
    log_abs: PathBuf,
) {
    let res = kernels
        .invoke_script(&lang_id, code, source, cwd, params, args, function, 300_000)
        .await;
    if entry.cancelled.load(Ordering::SeqCst) {
        let snap = entry.snapshot().await;
        write_job_mlog(&log_abs, &snap);
        return;
    }
    match res {
        Ok(KernelResponse::InvokeResult {
            result,
            repr,
            stdout,
            error,
            duration_ms,
            ..
        }) => {
            let mut info = entry.info.lock().await;
            info.finished_at = Some(Utc::now().to_rfc3339());
            info.duration_ms = duration_ms;
            info.stdout = stdout;
            info.repr = repr;
            if let Some(e) = error {
                info.status = "failed".to_string();
                info.error = Some(format!("{}: {}", e.error_type, e.message));
            } else {
                info.status = "completed".to_string();
                info.result_plain = tagged_json_to_plain(&result);
                info.result = Some(result);
            }
            let snap = info.clone();
            drop(info);
            write_job_mlog(&log_abs, &snap);
        }
        Ok(_) => {
            finalize_job_error(&entry, &log_abs, "Unexpected kernel response".to_string()).await;
        }
        Err(crate::kernel_mgr::InvokeExecError::Timeout(ms)) => {
            finalize_job_error(&entry, &log_abs, format!("Timed out after {} ms", ms)).await;
        }
        Err(crate::kernel_mgr::InvokeExecError::Internal(msg)) => {
            finalize_job_error(&entry, &log_abs, msg).await;
        }
    }
}

async fn finalize_job_error(entry: &Arc<JobEntry>, log_abs: &Path, msg: String) {
    let mut info = entry.info.lock().await;
    if info.status == "running" {
        info.status = "failed".to_string();
        info.finished_at = Some(Utc::now().to_rfc3339());
        info.duration_ms = entry.started_instant.elapsed().as_secs_f64() * 1000.0;
        info.error = Some(msg);
    }
    let snap = info.clone();
    drop(info);
    write_job_mlog(log_abs, &snap);
}

fn resolve_job_script(
    files: &FileStore,
    languages: &LanguageRegistry,
    requested: &str,
    cwd: Option<&str>,
) -> Result<(String, PathBuf, String), String> {
    let trimmed = requested.trim();
    if trimmed.is_empty() {
        return Err("Script path cannot be empty".to_string());
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    let root = files.root();

    // 1. If cwd was provided (e.g. from a Minilang kernel) and path is relative (./ or plain), check cwd first
    if let Some(cwd_str) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(cwd_canon) = fs::canonicalize(cwd_str) {
            if cwd_canon.starts_with(root) {
                let p = cwd_canon.join(trimmed);
                candidates.push(p.clone());
                if p.extension().is_none() {
                    candidates.push(cwd_canon.join(format!("{}.mini", trimmed)));
                    candidates.push(cwd_canon.join(format!("{}.rs", trimmed)));
                }
            }
        }
    }

    // 2. Workspace-relative & scripts/ candidates
    let stripped = trimmed.trim_start_matches('/');
    let rel_cands = if Path::new(stripped).extension().is_some() {
        vec![stripped.to_string(), format!("scripts/{}", stripped)]
    } else {
        vec![
            format!("{}.mini", stripped),
            format!("scripts/{}.mini", stripped),
            format!("{}.rs", stripped),
            format!("scripts/{}.rs", stripped),
        ]
    };
    for rc in rel_cands {
        if let Ok(abs) = files.resolve_existing(&rc) {
            candidates.push(abs);
        }
    }

    for cand in candidates {
        if let Ok(canon) = fs::canonicalize(&cand) {
            if canon.starts_with(root) && canon.is_file() {
                let ext = canon
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if let Some(backend) = languages.by_extension(&ext) {
                    if backend.info().supports_invoke {
                        let rel = canon
                            .strip_prefix(root)
                            .unwrap_or(&canon)
                            .to_string_lossy()
                            .replace('\\', "/");
                        return Ok((rel, canon, backend.info().id));
                    }
                }
            }
        }
    }

    Err(format!("Background job script '{}' not found (expected a .mini or .rs file)", requested))
}

fn parse_params_value(val: Option<Value>) -> Result<BTreeMap<String, TaggedValue>, String> {
    let mut out = BTreeMap::new();
    let Some(v) = val else { return Ok(out) };
    if v.is_null() {
        return Ok(out);
    }
    let obj = v
        .as_object()
        .ok_or_else(|| "Job 'params' must be a JSON object".to_string())?;
    for (k, raw) in obj {
        out.insert(k.clone(), json_to_tagged_value(raw));
    }
    Ok(out)
}

fn parse_args_values(vals: Option<Vec<Value>>) -> Result<Vec<TaggedValue>, String> {
    let Some(list) = vals else {
        return Ok(Vec::new());
    };
    Ok(list.iter().map(json_to_tagged_value).collect())
}

/// Accepts either an already-tagged `{ "type": "...", "value": ... }` object OR plain JSON.
pub fn json_to_tagged_value(v: &Value) -> TaggedValue {
    if let Ok(tagged) = serde_json::from_value::<TaggedValue>(v.clone()) {
        return tagged;
    }
    match v {
        Value::Null => TaggedValue::Nil,
        Value::Bool(b) => TaggedValue::Boolean(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                TaggedValue::Integer(i)
            } else {
                TaggedValue::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => TaggedValue::String(s.clone()),
        Value::Array(arr) => TaggedValue::List(arr.iter().map(json_to_tagged_value).collect()),
        Value::Object(map) => TaggedValue::Map(
            map.iter()
                .map(|(k, val)| (TaggedValue::String(k.clone()), json_to_tagged_value(val)))
                .collect(),
        ),
    }
}

pub fn tagged_json_to_plain(v: &Value) -> Value {
    let Some(obj) = v.as_object() else {
        return v.clone();
    };
    let Some(ty) = obj.get("type").and_then(|t| t.as_str()) else {
        return v.clone();
    };
    let val = obj.get("value");
    match ty {
        "nil" | "null" => Value::Null,
        "boolean" | "bool" | "integer" | "int" | "real" | "float" | "string" | "str" | "symbol"
        | "time" | "uuid" | "bytes" => val.cloned().unwrap_or(Value::Null),
        "list" | "tuple" | "set" => {
            let items = val
                .and_then(|x| x.as_array())
                .map(|a| a.iter().map(tagged_json_to_plain).collect())
                .unwrap_or_default();
            Value::Array(items)
        }
        "map" => match val {
            Some(Value::Object(m)) => {
                let mut out = serde_json::Map::new();
                for (k, mv) in m {
                    out.insert(k.clone(), tagged_json_to_plain(mv));
                }
                Value::Object(out)
            }
            Some(Value::Array(pairs)) => {
                let mut out = serde_json::Map::new();
                for p in pairs {
                    if let Some(arr) = p.as_array() {
                        if arr.len() == 2 {
                            let k = match tagged_json_to_plain(&arr[0]) {
                                Value::String(s) => s,
                                other => other.to_string(),
                            };
                            out.insert(k, tagged_json_to_plain(&arr[1]));
                        }
                    }
                }
                Value::Object(out)
            }
            _ => Value::Object(serde_json::Map::new()),
        },
        _ => val.cloned().unwrap_or(Value::Null),
    }
}

/* ============================================================================
 * MLOG Frame Writer (so job logs open in Log Viewer)
 * ============================================================================ */

fn write_job_mlog(path: &Path, snap: &BackgroundJobInfo) {
    let entry = json!({
        "level": if snap.status == "completed" { "info" } else if snap.status == "cancelled" { "warn" } else { "error" },
        "job_id": snap.id,
        "name": snap.name,
        "script": snap.script,
        "status": snap.status,
        "duration_ms": (snap.duration_ms * 100.0).round() / 100.0,
        "result": if snap.repr.len() > 500 { format!("{}...", &snap.repr[..500]) } else { snap.repr.clone() },
        "stdout": if snap.stdout.len() > 1000 { format!("{}...", &snap.stdout[..1000]) } else { snap.stdout.clone() },
        "error": snap.error,
    });
    let _ = append_mlog_frame(path, Utc::now(), &entry);
}

fn append_mlog_frame(path: &Path, ts: DateTime<Utc>, val: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut payload = Vec::new();
    encode_cbor_value(val, &mut payload);

    let mut header = [0u8; 20];
    header[0..4].copy_from_slice(MLOG_MAGIC);
    header[4..12].copy_from_slice(&ts.timestamp().to_le_bytes());
    header[12..16].copy_from_slice(&ts.timestamp_subsec_nanos().to_le_bytes());
    header[16..20].copy_from_slice(&(payload.len() as u32).to_le_bytes());

    let mut f = OpenOptions::new().create(true).append(true).open(path)?;
    f.write_all(&header)?;
    f.write_all(&payload)?;
    f.flush()?;
    Ok(())
}

fn cbor_write_type_len(major: u8, len: u64, out: &mut Vec<u8>) {
    let m = major << 5;
    if len < 24 {
        out.push(m | (len as u8));
    } else if len <= 0xff {
        out.push(m | 24);
        out.push(len as u8);
    } else if len <= 0xffff {
        out.push(m | 25);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else if len <= 0xffff_ffff {
        out.push(m | 26);
        out.extend_from_slice(&(len as u32).to_be_bytes());
    } else {
        out.push(m | 27);
        out.extend_from_slice(&len.to_be_bytes());
    }
}

fn encode_cbor_value(val: &Value, out: &mut Vec<u8>) {
    match val {
        Value::Null => out.push(0xf6),
        Value::Bool(false) => out.push(0xf4),
        Value::Bool(true) => out.push(0xf5),
        Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                cbor_write_type_len(0, u, out);
            } else if let Some(i) = n.as_i64() {
                if i >= 0 {
                    cbor_write_type_len(0, i as u64, out);
                } else {
                    cbor_write_type_len(1, (-1 - i) as u64, out);
                }
            } else if let Some(f) = n.as_f64() {
                out.push(0xfb);
                out.extend_from_slice(&f.to_be_bytes());
            } else {
                out.push(0xf6);
            }
        }
        Value::String(s) => {
            cbor_write_type_len(3, s.len() as u64, out);
            out.extend_from_slice(s.as_bytes());
        }
        Value::Array(arr) => {
            cbor_write_type_len(4, arr.len() as u64, out);
            for item in arr {
                encode_cbor_value(item, out);
            }
        }
        Value::Object(map) => {
            cbor_write_type_len(5, map.len() as u64, out);
            for (k, v) in map {
                cbor_write_type_len(3, k.len() as u64, out);
                out.extend_from_slice(k.as_bytes());
                encode_cbor_value(v, out);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plain_and_tagged_param_conversion() {
        assert_eq!(json_to_tagged_value(&json!(42)), TaggedValue::Integer(42));
        assert_eq!(json_to_tagged_value(&json!("hi")), TaggedValue::String("hi".into()));
        assert_eq!(
            json_to_tagged_value(&json!({"type": "integer", "value": 99})),
            TaggedValue::Integer(99)
        );
        let nested = json_to_tagged_value(&json!({"a": [1, true]}));
        assert!(matches!(nested, TaggedValue::Map(_)));

        let tagged_out = json!({
            "type": "map",
            "value": {
                "sum": {"type": "integer", "value": 15},
                "items": {"type": "list", "value": [{"type": "string", "value": "x"}]}
            }
        });
        assert_eq!(tagged_json_to_plain(&tagged_out), json!({"sum": 15, "items": ["x"]}));
    }
}
