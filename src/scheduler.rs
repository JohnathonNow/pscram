use crate::auth::{b64url_encode, random_bytes};
use crate::files::FileStore;
use crate::kernel_mgr::KernelManager;
use crate::kernel_proc::KernelResponse;
use crate::lang::LanguageRegistry;
use crate::tagged::TaggedValue;
use chrono::{DateTime, Datelike, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

const MLOG_MAGIC: &[u8; 4] = b"MLOG";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleJob {
    pub id: String,
    pub name: String,
    pub script: String,
    #[serde(default)]
    pub cron: Option<String>,
    #[serde(default)]
    pub interval_secs: Option<u64>,
    #[serde(default)]
    pub function: Option<String>,
    #[serde(default)]
    pub params: BTreeMap<String, TaggedValue>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub webhook_token: String,
    pub log_path: String,
    #[serde(default)]
    pub last_run_at: Option<String>,
    #[serde(default)]
    pub last_status: Option<String>, // "ok" | "error" | "timeout"
    #[serde(default)]
    pub last_duration_ms: Option<f64>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub run_count: u64,
    #[serde(skip)]
    pub last_cron_minute: Option<i64>,
    #[serde(skip)]
    pub last_interval_epoch: Option<i64>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
pub struct CreateScheduleRequest {
    pub name: Option<String>,
    pub script: String,
    #[serde(default)]
    pub cron: Option<String>,
    #[serde(default)]
    pub interval_secs: Option<u64>,
    #[serde(default)]
    pub function: Option<String>,
    #[serde(default)]
    pub params: BTreeMap<String, TaggedValue>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
pub struct UpdateScheduleRequest {
    pub name: Option<String>,
    pub script: Option<String>,
    pub cron: Option<Option<String>>,
    pub interval_secs: Option<Option<u64>>,
    pub function: Option<Option<String>>,
    pub params: Option<BTreeMap<String, TaggedValue>>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScheduleRunResult {
    pub job_id: String,
    pub ok: bool,
    pub status: String,
    pub duration_ms: f64,
    pub stdout: String,
    pub repr: String,
    pub error: Option<String>,
    pub log_path: String,
}

pub struct Scheduler {
    store_path: PathBuf,
    workspace_root: PathBuf,
    jobs: Mutex<Vec<ScheduleJob>>,
}

impl Scheduler {
    pub fn open(workspace_root: &Path) -> Self {
        let store_path = workspace_root.join(".minilang-schedules.json");
        let jobs = if store_path.exists() {
            fs::read_to_string(&store_path)
                .ok()
                .and_then(|s| serde_json::from_str::<Vec<ScheduleJob>>(&s).ok())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        Self {
            store_path,
            workspace_root: workspace_root.to_path_buf(),
            jobs: Mutex::new(jobs),
        }
    }

    pub async fn list(&self) -> Vec<ScheduleJob> {
        self.jobs.lock().await.clone()
    }

    pub async fn create(&self, req: CreateScheduleRequest) -> Result<ScheduleJob, String> {
        let script = req.script.trim().to_string();
        if script.is_empty() {
            return Err("Script path cannot be empty".to_string());
        }
        let cron = req.cron.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if let Some(ref expr) = cron {
            validate_cron(expr)?;
        }
        let interval = req.interval_secs.filter(|&v| v >= 5);
        if cron.is_none() && interval.is_none() && req.interval_secs.is_some() {
            return Err("interval_secs must be at least 5 seconds".to_string());
        }

        let id = format!("job-{}", &uuid::Uuid::new_v4().to_string()[..8]);
        let token_bytes = random_bytes::<18>()?;
        let webhook_token = b64url_encode(&token_bytes);
        let name = req
            .name
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                Path::new(&script)
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| script.clone())
            });
        let log_path = format!("logs/schedules/{}.mlog", id);

        let job = ScheduleJob {
            id,
            name,
            script,
            cron,
            interval_secs: interval,
            function: req.function.filter(|s| !s.trim().is_empty()),
            params: req.params,
            enabled: req.enabled,
            webhook_token,
            log_path,
            last_run_at: None,
            last_status: None,
            last_duration_ms: None,
            last_error: None,
            run_count: 0,
            last_cron_minute: None,
            last_interval_epoch: Some(Utc::now().timestamp()),
        };

        let mut list = self.jobs.lock().await;
        list.push(job.clone());
        self.persist_locked(&list)?;
        Ok(job)
    }

    pub async fn update(&self, id: &str, req: UpdateScheduleRequest) -> Result<ScheduleJob, String> {
        let mut list = self.jobs.lock().await;
        let job = list
            .iter_mut()
            .find(|j| j.id == id)
            .ok_or_else(|| format!("Schedule '{}' not found", id))?;

        if let Some(name) = req.name {
            let t = name.trim();
            if !t.is_empty() {
                job.name = t.to_string();
            }
        }
        if let Some(script) = req.script {
            let t = script.trim();
            if !t.is_empty() {
                job.script = t.to_string();
            }
        }
        if let Some(cron_opt) = req.cron {
            let cleaned = cron_opt.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            if let Some(ref expr) = cleaned {
                validate_cron(expr)?;
            }
            job.cron = cleaned;
        }
        if let Some(int_opt) = req.interval_secs {
            if let Some(v) = int_opt {
                if v < 5 {
                    return Err("interval_secs must be at least 5 seconds".to_string());
                }
            }
            job.interval_secs = int_opt;
        }
        if let Some(fn_opt) = req.function {
            job.function = fn_opt.filter(|s| !s.trim().is_empty());
        }
        if let Some(params) = req.params {
            job.params = params;
        }
        if let Some(enabled) = req.enabled {
            job.enabled = enabled;
        }

        let updated = job.clone();
        self.persist_locked(&list)?;
        Ok(updated)
    }

    pub async fn toggle(&self, id: &str) -> Result<ScheduleJob, String> {
        let mut list = self.jobs.lock().await;
        let job = list
            .iter_mut()
            .find(|j| j.id == id)
            .ok_or_else(|| format!("Schedule '{}' not found", id))?;
        job.enabled = !job.enabled;
        let updated = job.clone();
        self.persist_locked(&list)?;
        Ok(updated)
    }

    pub async fn delete(&self, id: &str) -> Result<bool, String> {
        let mut list = self.jobs.lock().await;
        let before = list.len();
        list.retain(|j| j.id != id);
        let removed = list.len() != before;
        if removed {
            self.persist_locked(&list)?;
        }
        Ok(removed)
    }

    pub async fn find_by_webhook(&self, token: &str) -> Option<ScheduleJob> {
        let list = self.jobs.lock().await;
        list.iter().find(|j| j.webhook_token == token).cloned()
    }

    pub async fn run_job_by_id(
        &self,
        id: &str,
        trigger: &str,
        override_params: Option<BTreeMap<String, TaggedValue>>,
        files: &FileStore,
        kernels: &KernelManager,
        languages: &LanguageRegistry,
    ) -> Result<ScheduleRunResult, String> {
        let job = {
            let list = self.jobs.lock().await;
            list.iter()
                .find(|j| j.id == id)
                .cloned()
                .ok_or_else(|| format!("Schedule '{}' not found", id))?
        };
        Ok(self
            .execute_job(job, trigger, override_params, files, kernels, languages)
            .await)
    }

    pub async fn execute_job(
        &self,
        job: ScheduleJob,
        trigger: &str,
        override_params: Option<BTreeMap<String, TaggedValue>>,
        files: &FileStore,
        kernels: &KernelManager,
        languages: &LanguageRegistry,
    ) -> ScheduleRunResult {
        let started = Utc::now();
        let mut merged_params = job.params.clone();
        if let Some(extra) = override_params {
            for (k, v) in extra {
                merged_params.insert(k, v);
            }
        }

        let resolved = resolve_script_for_schedule(files, languages, &job.script);
        let (ok, status, duration_ms, stdout, repr, error_msg) = match resolved {
            Err(err) => (false, "error".to_string(), 0.0, String::new(), String::new(), Some(err)),
            Ok((rel_path, abs_path, lang_id)) => match fs::read_to_string(&abs_path) {
                Err(e) => (
                    false,
                    "error".to_string(),
                    0.0,
                    String::new(),
                    String::new(),
                    Some(format!("Failed to read '{}': {}", rel_path, e)),
                ),
                Ok(code) => {
                    let cwd = abs_path
                        .parent()
                        .map(|p| p.to_path_buf())
                        .unwrap_or_else(|| files.root().to_path_buf());
                    match kernels
                        .invoke_script(
                            &lang_id,
                            code,
                            rel_path,
                            cwd,
                            merged_params,
                            Vec::new(),
                            job.function.clone(),
                            60_000,
                        )
                        .await
                    {
                        Ok(KernelResponse::InvokeResult {
                            repr,
                            stdout,
                            error,
                            duration_ms,
                            ..
                        }) => {
                            if let Some(e) = error {
                                (
                                    false,
                                    "error".to_string(),
                                    duration_ms,
                                    stdout,
                                    repr,
                                    Some(format!("{}: {}", e.error_type, e.message)),
                                )
                            } else {
                                (true, "ok".to_string(), duration_ms, stdout, repr, None)
                            }
                        }
                        Ok(_) => (
                            false,
                            "error".to_string(),
                            0.0,
                            String::new(),
                            String::new(),
                            Some("Unexpected kernel response".to_string()),
                        ),
                        Err(crate::kernel_mgr::InvokeExecError::Timeout(ms)) => (
                            false,
                            "timeout".to_string(),
                            ms as f64,
                            String::new(),
                            String::new(),
                            Some(format!("Timed out after {} ms", ms)),
                        ),
                        Err(crate::kernel_mgr::InvokeExecError::Internal(msg)) => (
                            false,
                            "error".to_string(),
                            0.0,
                            String::new(),
                            String::new(),
                            Some(msg),
                        ),
                    }
                }
            },
        };

        // Append structured CBOR frame to job's MLOG file (viewable in Log Viewer!)
        let log_abs = self.workspace_root.join(&job.log_path);
        let entry = json!({
            "level": if ok { "info" } else { "error" },
            "trigger": trigger,
            "job": job.name,
            "script": job.script,
            "status": status,
            "duration_ms": (duration_ms * 100.0).round() / 100.0,
            "result": if repr.len() > 500 { format!("{}...", &repr[..500]) } else { repr.clone() },
            "stdout": if stdout.len() > 500 { format!("{}...", &stdout[..500]) } else { stdout.clone() },
            "error": error_msg,
        });
        let _ = append_mlog_json_frame(&log_abs, started, &entry);

        // Update persisted job metadata
        {
            let mut list = self.jobs.lock().await;
            if let Some(j) = list.iter_mut().find(|x| x.id == job.id) {
                j.last_run_at = Some(started.to_rfc3339());
                j.last_status = Some(status.clone());
                j.last_duration_ms = Some(duration_ms);
                j.last_error = error_msg.clone();
                j.run_count += 1;
                let _ = self.persist_locked(&list);
            }
        }

        ScheduleRunResult {
            job_id: job.id,
            ok,
            status,
            duration_ms,
            stdout,
            repr,
            error: error_msg,
            log_path: job.log_path,
        }
    }

    pub fn spawn_background(
        self: Arc<Self>,
        files: Arc<FileStore>,
        kernels: Arc<KernelManager>,
        languages: Arc<LanguageRegistry>,
    ) {
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
            loop {
                tick.tick().await;
                let now = Utc::now();
                let now_sec = now.timestamp();
                let now_min = now_sec / 60;

                let due_jobs: Vec<(ScheduleJob, &'static str)> = {
                    let mut list = self.jobs.lock().await;
                    let mut out = Vec::new();
                    for job in list.iter_mut() {
                        if !job.enabled {
                            continue;
                        }
                        if let Some(ref expr) = job.cron {
                            if job.last_cron_minute != Some(now_min) && cron_matches(expr, &now) {
                                job.last_cron_minute = Some(now_min);
                                out.push((job.clone(), "cron"));
                                continue;
                            }
                        }
                        if let Some(iv) = job.interval_secs {
                            let last = job.last_interval_epoch.unwrap_or(0);
                            if now_sec - last >= iv as i64 {
                                job.last_interval_epoch = Some(now_sec);
                                out.push((job.clone(), "interval"));
                            }
                        }
                    }
                    out
                };

                for (job, trigger) in due_jobs {
                    let sched = self.clone();
                    let f = files.clone();
                    let k = kernels.clone();
                    let l = languages.clone();
                    tokio::spawn(async move {
                        let _ = sched.execute_job(job, trigger, None, &f, &k, &l).await;
                    });
                }
            }
        });
    }

    fn persist_locked(&self, list: &[ScheduleJob]) -> Result<(), String> {
        let json_str = serde_json::to_string_pretty(list)
            .map_err(|e| format!("Failed to serialize schedules: {}", e))?;
        let tmp = self.store_path.with_extension("json.tmp");
        fs::write(&tmp, json_str)
            .map_err(|e| format!("Failed to write schedules: {}", e))?;
        fs::rename(&tmp, &self.store_path)
            .map_err(|e| format!("Failed to save schedules: {}", e))?;
        Ok(())
    }
}

fn resolve_script_for_schedule(
    files: &FileStore,
    languages: &LanguageRegistry,
    requested: &str,
) -> Result<(String, PathBuf, String), String> {
    let trimmed = requested.trim().trim_start_matches('/');
    let mut candidates = vec![trimmed.to_string()];
    if !trimmed.starts_with("scripts/") {
        candidates.push(format!("scripts/{}", trimmed));
    }
    for cand in candidates {
        if let Ok(abs) = files.resolve_existing(&cand) {
            if abs.is_file() {
                let ext = abs
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if let Some(backend) = languages.by_extension(&ext) {
                    if backend.info().supports_invoke {
                        let rel = abs
                            .strip_prefix(files.root())
                            .unwrap_or(&abs)
                            .to_string_lossy()
                            .replace('\\', "/");
                        return Ok((rel, abs, backend.info().id));
                    }
                }
            }
        }
    }
    Err(format!("Invocable script '{}' not found", requested))
}

/* ============================================================================
 * Pure-Rust 5-Field Cron Expression Evaluator (min hour dom mon dow)
 * ============================================================================ */

pub fn validate_cron(expr: &str) -> Result<(), String> {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    if parts.len() != 5 {
        return Err("Cron expression must have 5 fields: min hour dom mon dow (e.g. '*/5 * * * *')".to_string());
    }
    let bounds = [(0u32, 59u32), (0, 23), (1, 31), (1, 12), (0, 6)];
    for (p, (lo, hi)) in parts.iter().zip(bounds.iter()) {
        parse_cron_field(p, *lo, *hi)?;
    }
    Ok(())
}

fn parse_cron_field(field: &str, lo: u32, hi: u32) -> Result<Vec<u32>, String> {
    let mut values = Vec::new();
    for part in field.split(',') {
        let (range_part, step) = match part.split_once('/') {
            Some((r, s)) => {
                let st: u32 = s.parse().map_err(|_| format!("Invalid cron step '{}'", s))?;
                if st == 0 {
                    return Err("Cron step cannot be 0".to_string());
                }
                (r, st)
            }
            None => (part, 1),
        };
        let (start, end) = if range_part == "*" {
            (lo, hi)
        } else if let Some((a, b)) = range_part.split_once('-') {
            let sa: u32 = a.parse().map_err(|_| format!("Invalid cron bound '{}'", a))?;
            let sb: u32 = b.parse().map_err(|_| format!("Invalid cron bound '{}'", b))?;
            let sa = if hi == 6 && sa == 7 { 0 } else { sa };
            let sb = if hi == 6 && sb == 7 { 6 } else { sb };
            if sa < lo || sb > hi || sa > sb {
                return Err(format!("Cron range '{}' out of bounds ({}..={})", range_part, lo, hi));
            }
            (sa, sb)
        } else {
            let v: u32 = range_part
                .parse()
                .map_err(|_| format!("Invalid cron value '{}'", range_part))?;
            let v = if hi == 6 && v == 7 { 0 } else { v };
            if v < lo || v > hi {
                return Err(format!("Cron value {} out of bounds ({}..={})", v, lo, hi));
            }
            if step == 1 {
                (v, v)
            } else {
                (v, hi)
            }
        };
        let mut cur = start;
        while cur <= end {
            values.push(cur);
            cur += step;
        }
    }
    Ok(values)
}

pub fn cron_matches(expr: &str, dt: &DateTime<Utc>) -> bool {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    if parts.len() != 5 {
        return false;
    }
    let m = dt.minute();
    let h = dt.hour();
    let dom = dt.day();
    let mon = dt.month();
    let dow = dt.weekday().num_days_from_sunday();

    let check = |field: &str, lo: u32, hi: u32, val: u32| -> bool {
        parse_cron_field(field, lo, hi)
            .map(|vs| vs.contains(&val))
            .unwrap_or(false)
    };
    check(parts[0], 0, 59, m)
        && check(parts[1], 0, 23, h)
        && check(parts[2], 1, 31, dom)
        && check(parts[3], 1, 12, mon)
        && check(parts[4], 0, 6, dow)
}

/* ============================================================================
 * Minimal CBOR + MLOG Frame Writer (so schedule logs open directly in Log Viewer)
 * ============================================================================ */

fn append_mlog_json_frame(path: &Path, ts: DateTime<Utc>, val: &Value) -> std::io::Result<()> {
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
    use chrono::TimeZone;

    #[test]
    fn test_cron_validation_and_matching() {
        assert!(validate_cron("*/5 * * * *").is_ok());
        assert!(validate_cron("0 9 * * 1-5").is_ok());
        assert!(validate_cron("15,45 8-17/2 1 1,6 0").is_ok());
        assert!(validate_cron("0 0 * * 7").is_ok()); // Sunday = 7 alias

        assert!(validate_cron("* * *").is_err());
        assert!(validate_cron("60 * * * *").is_err());
        assert!(validate_cron("*/0 * * * *").is_err());
        assert!(validate_cron("0 25 * * *").is_err());
        assert!(validate_cron("0 0 0 * *").is_err());
        assert!(validate_cron("10-5 * * * *").is_err());

        // 2026-11-24 is a Tuesday (dow = 2)
        let dt = Utc.with_ymd_and_hms(2026, 11, 24, 9, 15, 0).unwrap();
        assert!(cron_matches("*/15 9 * * 1-5", &dt));
        assert!(cron_matches("15 9 24 11 2", &dt));
        assert!(!cron_matches("0 9 * * 1-5", &dt));
        assert!(!cron_matches("15 9 * * 0,6", &dt));
    }

    #[test]
    fn test_mlog_cbor_frame_readable_by_log_reader() {
        let path = std::env::temp_dir().join(format!("mlnb_sched_mlog_{}.mlog", uuid::Uuid::new_v4()));
        let ts = Utc::now();
        let entry = json!({
            "level": "info",
            "job": "nightly",
            "count": 42,
            "neg": -7,
            "ratio": 1.25,
            "ok": true,
            "tags": ["a", "b"],
            "err": null
        });
        append_mlog_json_frame(&path, ts, &entry).unwrap();

        let parsed = crate::log_reader::read_log_file(&path, "test.mlog", None, None, false, 0, 50).unwrap();
        assert_eq!(parsed.format, "mlog");
        assert_eq!(parsed.total, 1);
        assert_eq!(parsed.entries[0].level.as_deref(), Some("info"));
        assert_eq!(parsed.entries[0].value.get("job").and_then(|v| v.as_str()), Some("nightly"));
        assert_eq!(parsed.entries[0].value.get("count").and_then(|v| v.as_i64()), Some(42));
        assert_eq!(parsed.entries[0].value.get("neg").and_then(|v| v.as_i64()), Some(-7));
        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn test_scheduler_crud_and_persistence() {
        let dir = std::env::temp_dir().join(format!("mlnb_sched_crud_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();

        let sched = Scheduler::open(&dir);
        let created = sched
            .create(CreateScheduleRequest {
                name: Some("Ping Job".into()),
                script: "scripts/greet.mini".into(),
                cron: Some("*/10 * * * *".into()),
                interval_secs: None,
                function: None,
                params: BTreeMap::new(),
                enabled: true,
            })
            .await
            .unwrap();
        assert_eq!(created.name, "Ping Job");
        assert!(created.enabled);
        assert!(sched.find_by_webhook(&created.webhook_token).await.is_some());

        // Interval < 5 rejected
        assert!(sched
            .create(CreateScheduleRequest {
                name: None,
                script: "scripts/greet.mini".into(),
                cron: None,
                interval_secs: Some(2),
                function: None,
                params: BTreeMap::new(),
                enabled: true,
            })
            .await
            .is_err());

        // Toggle & update
        let toggled = sched.toggle(&created.id).await.unwrap();
        assert!(!toggled.enabled);
        let updated = sched
            .update(
                &created.id,
                UpdateScheduleRequest {
                    name: Some("Renamed Job".into()),
                    script: None,
                    cron: Some(Some("0 * * * *".into())),
                    interval_secs: None,
                    function: None,
                    params: None,
                    enabled: Some(true),
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.name, "Renamed Job");
        assert_eq!(updated.cron.as_deref(), Some("0 * * * *"));

        // Reopen from disk
        let reopened = Scheduler::open(&dir);
        assert_eq!(reopened.list().await.len(), 1);
        assert_eq!(reopened.list().await[0].name, "Renamed Job");

        assert!(reopened.delete(&created.id).await.unwrap());
        assert!(reopened.list().await.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }
}
