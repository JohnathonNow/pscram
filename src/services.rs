use crate::files::FileStore;
use crate::jobs::{json_to_tagged_value, tagged_json_to_plain};
use crate::kernel_proc::{KernelRequest, KernelResponse};
use crate::secrets::SecretsVault;
use crate::tagged::TaggedValue;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot, Mutex, Notify};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceMessage {
    pub id: String,
    pub service: String,
    pub from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    pub topic: String,
    /// Stored as Tagged JSON so native Minilang types round-trip cleanly between services & UIs.
    pub data: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceBusEvent {
    pub id: String,
    /// "send" | "broadcast" | "direct" | "call" | "reply" | "lifecycle"
    pub kind: String,
    pub service: String,
    pub from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    pub topic: String,
    pub data: Value,
    pub data_plain: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    pub delivered: usize,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceInfo {
    pub id: String,
    pub name: String,
    pub script: String,
    pub status: String, // "running" | "stopped" | "failed"
    pub pid: u32,
    pub started_at: String,
    pub stopped_at: Option<String>,
    pub stdout: String,
    pub error: Option<String>,
    pub clients: Vec<String>,
    pub subscriber_count: usize,
    pub messages_in: u64,
    pub messages_out: u64,
    pub recent_messages: Vec<ServiceMessage>,
}

#[derive(Debug, Deserialize)]
pub struct StartServiceRequest {
    pub script: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub params: Option<Value>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub replace: bool,
}

#[derive(Debug, Deserialize)]
pub struct SendMessageRequest {
    pub topic: String,
    #[serde(default)]
    pub data: Option<Value>,
    #[serde(default)]
    pub from: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CallServiceRequest {
    pub topic: String,
    #[serde(default)]
    pub data: Option<Value>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct EmitMessageRequest {
    pub topic: String,
    #[serde(default)]
    pub data: Option<Value>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub from: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReplyMessageRequest {
    pub reply_to: String,
    #[serde(default)]
    pub data: Option<Value>,
}

#[derive(Debug, Deserialize, Default)]
pub struct RecvMessageRequest {
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

struct ServiceEntry {
    id: String,
    name: String,
    script: String,
    cwd: PathBuf,
    params: BTreeMap<String, TaggedValue>,
    state: Mutex<ServiceRuntimeState>,
    pid: AtomicU32,
    stopped: AtomicBool,
    inbox: Mutex<VecDeque<ServiceMessage>>,
    inbox_notify: Notify,
    subscribers: Mutex<HashMap<String, mpsc::UnboundedSender<ServiceMessage>>>,
    pending_replies: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    recent_messages: Mutex<VecDeque<ServiceMessage>>,
    messages_in: AtomicU64,
    messages_out: AtomicU64,
}

struct ServiceRuntimeState {
    status: String,
    started_at: String,
    stopped_at: Option<String>,
    stdout: String,
    error: Option<String>,
}

impl ServiceEntry {
    async fn snapshot(&self) -> ServiceInfo {
        let st = self.state.lock().await;
        let clients: Vec<String> = {
            let mut list: Vec<String> = self.subscribers.lock().await.keys().cloned().collect();
            list.sort();
            list
        };
        let recent: Vec<ServiceMessage> = self.recent_messages.lock().await.iter().cloned().collect();
        ServiceInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            script: self.script.clone(),
            status: st.status.clone(),
            pid: self.pid.load(Ordering::SeqCst),
            started_at: st.started_at.clone(),
            stopped_at: st.stopped_at.clone(),
            stdout: st.stdout.clone(),
            error: st.error.clone(),
            subscriber_count: clients.len(),
            clients,
            messages_in: self.messages_in.load(Ordering::SeqCst),
            messages_out: self.messages_out.load(Ordering::SeqCst),
            recent_messages: recent,
        }
    }

    async fn push_recent(&self, msg: ServiceMessage) {
        let mut recent = self.recent_messages.lock().await;
        recent.push_back(msg);
        while recent.len() > 50 {
            recent.pop_front();
        }
    }

    fn kill_pid(&self) {
        let pid = self.pid.swap(0, Ordering::SeqCst);
        if pid > 0 {
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

/// RAII subscription handle for an SSE UI client. Automatically unsubscribes on drop.
pub struct ServiceSubscription {
    pub client_id: String,
    pub service_name: String,
    entry: Arc<ServiceEntry>,
    rx: mpsc::UnboundedReceiver<ServiceMessage>,
}

impl ServiceSubscription {
    pub async fn recv(&mut self) -> Option<ServiceMessage> {
        self.rx.recv().await
    }
}

impl Drop for ServiceSubscription {
    fn drop(&mut self) {
        let entry = self.entry.clone();
        let client_id = self.client_id.clone();
        tokio::spawn(async move {
            entry.subscribers.lock().await.remove(&client_id);
        });
    }
}

pub struct ServiceManager {
    workspace_root: PathBuf,
    services: Mutex<BTreeMap<String, Arc<ServiceEntry>>>, // keyed by service name
    bus_history: Mutex<VecDeque<ServiceBusEvent>>,
    bus_taps: Mutex<Vec<mpsc::UnboundedSender<ServiceBusEvent>>>,
}

impl ServiceManager {
    pub fn new(workspace_root: PathBuf) -> Self {
        Self {
            workspace_root,
            services: Mutex::new(BTreeMap::new()),
            bus_history: Mutex::new(VecDeque::new()),
            bus_taps: Mutex::new(Vec::new()),
        }
    }

    async fn record_bus_event(&self, ev: ServiceBusEvent) {
        {
            let mut hist = self.bus_history.lock().await;
            hist.push_back(ev.clone());
            while hist.len() > 250 {
                hist.pop_front();
            }
        }
        let mut taps = self.bus_taps.lock().await;
        taps.retain(|tx| tx.send(ev.clone()).is_ok());
    }

    pub async fn bus_history(
        &self,
        service_filter: Option<&str>,
        topic_filter: Option<&str>,
        limit: usize,
    ) -> Vec<ServiceBusEvent> {
        let hist = self.bus_history.lock().await;
        let svc_q = service_filter.map(str::trim).filter(|s| !s.is_empty());
        let top_q = topic_filter.map(|s| s.trim().to_lowercase());
        let top_q = top_q.as_deref().filter(|s| !s.is_empty());

        let mut out: Vec<ServiceBusEvent> = hist
            .iter()
            .filter(|e| {
                if let Some(sq) = svc_q {
                    if e.service != sq {
                        return false;
                    }
                }
                if let Some(tq) = top_q {
                    if !e.topic.to_lowercase().contains(tq)
                        && !e.from.to_lowercase().contains(tq)
                        && !e.kind.to_lowercase().contains(tq)
                    {
                        return false;
                    }
                }
                true
            })
            .cloned()
            .collect();
        let cap = limit.clamp(1, 250);
        if out.len() > cap {
            out = out.split_off(out.len() - cap);
        }
        out
    }

    pub async fn subscribe_bus_tap(&self) -> mpsc::UnboundedReceiver<ServiceBusEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.bus_taps.lock().await.push(tx);
        rx
    }

    pub async fn clear_bus_history(&self) -> usize {
        let mut h = self.bus_history.lock().await;
        let n = h.len();
        h.clear();
        n
    }

    async fn find(&self, name_or_id: &str) -> Option<Arc<ServiceEntry>> {
        let map = self.services.lock().await;
        if let Some(e) = map.get(name_or_id) {
            return Some(e.clone());
        }
        map.values().find(|e| e.id == name_or_id).cloned()
    }

    pub async fn list(&self) -> Vec<ServiceInfo> {
        let entries: Vec<Arc<ServiceEntry>> = self.services.lock().await.values().cloned().collect();
        let mut out = Vec::with_capacity(entries.len());
        for e in entries {
            out.push(e.snapshot().await);
        }
        out
    }

    pub async fn get(&self, name_or_id: &str) -> Option<ServiceInfo> {
        let entry = self.find(name_or_id).await?;
        Some(entry.snapshot().await)
    }

    pub async fn start(
        &self,
        req: StartServiceRequest,
        files: &FileStore,
        secrets: Arc<SecretsVault>,
    ) -> Result<ServiceInfo, String> {
        let (rel_script, abs_script) =
            resolve_service_script(files, &req.script, req.cwd.as_deref())?;
        let code = fs::read_to_string(&abs_script)
            .map_err(|e| format!("Failed to read '{}': {}", rel_script, e))?;

        let name = derive_service_name(req.name.as_deref(), &rel_script)?;
        let params = parse_service_params(req.params)?;
        let cwd = abs_script
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| self.workspace_root.clone());

        // Check if a service with this name already exists
        let existing_subs = {
            let mut map = self.services.lock().await;
            if let Some(old) = map.get(&name).cloned() {
                let is_running = old.state.lock().await.status == "running";
                if is_running && !req.replace {
                    return Err(format!(
                        "Service '{}' is already running (pass replace=true or stop it first)",
                        name
                    ));
                }
                old.stopped.store(true, Ordering::SeqCst);
                old.inbox_notify.notify_waiters();
                old.kill_pid();
                let old_subs: HashMap<String, mpsc::UnboundedSender<ServiceMessage>> =
                    std::mem::take(&mut *old.subscribers.lock().await);
                map.remove(&name);
                old_subs
            } else {
                HashMap::new()
            }
        };

        let id = format!("svc-{}", &Uuid::new_v4().to_string()[..8]);
        let entry = Arc::new(ServiceEntry {
            id,
            name: name.clone(),
            script: rel_script.clone(),
            cwd: cwd.clone(),
            params: params.clone(),
            state: Mutex::new(ServiceRuntimeState {
                status: "running".to_string(),
                started_at: Utc::now().to_rfc3339(),
                stopped_at: None,
                stdout: String::new(),
                error: None,
            }),
            pid: AtomicU32::new(0),
            stopped: AtomicBool::new(false),
            inbox: Mutex::new(VecDeque::new()),
            inbox_notify: Notify::new(),
            subscribers: Mutex::new(existing_subs),
            pending_replies: Mutex::new(HashMap::new()),
            recent_messages: Mutex::new(VecDeque::new()),
            messages_in: AtomicU64::new(0),
            messages_out: AtomicU64::new(0),
        });

        self.services.lock().await.insert(name.clone(), entry.clone());

        spawn_service_process(entry.clone(), code, secrets);

        // Give the child process a brief moment to spawn and populate its PID
        tokio::time::sleep(Duration::from_millis(30)).await;
        let snap = entry.snapshot().await;
        self.record_bus_event(ServiceBusEvent {
            id: format!("bus-{}", &Uuid::new_v4().to_string()[..8]),
            kind: "lifecycle".to_string(),
            service: snap.name.clone(),
            from: "system".to_string(),
            to: Some(snap.name.clone()),
            topic: "started".to_string(),
            data: json!({ "type": "string", "value": snap.script }),
            data_plain: json!({ "script": snap.script, "pid": snap.pid }),
            reply_to: None,
            delivered: 0,
            timestamp: Utc::now().to_rfc3339(),
        })
        .await;
        Ok(snap)
    }

    pub async fn stop(&self, name_or_id: &str) -> Result<ServiceInfo, String> {
        let entry = self
            .find(name_or_id)
            .await
            .ok_or_else(|| format!("Service '{}' not found", name_or_id))?;

        entry.stopped.store(true, Ordering::SeqCst);
        entry.inbox_notify.notify_waiters();
        entry.kill_pid();

        // Fail any pending RPC calls immediately
        entry.pending_replies.lock().await.clear();

        {
            let mut st = entry.state.lock().await;
            if st.status == "running" {
                st.status = "stopped".to_string();
                st.stopped_at = Some(Utc::now().to_rfc3339());
            }
        }
        let snap = entry.snapshot().await;
        self.record_bus_event(ServiceBusEvent {
            id: format!("bus-{}", &Uuid::new_v4().to_string()[..8]),
            kind: "lifecycle".to_string(),
            service: snap.name.clone(),
            from: "system".to_string(),
            to: Some(snap.name.clone()),
            topic: "stopped".to_string(),
            data: json!({ "type": "nil" }),
            data_plain: Value::Null,
            reply_to: None,
            delivered: 0,
            timestamp: Utc::now().to_rfc3339(),
        })
        .await;
        Ok(snap)
    }

    pub async fn restart(
        &self,
        name_or_id: &str,
        files: &FileStore,
        secrets: Arc<SecretsVault>,
    ) -> Result<ServiceInfo, String> {
        let entry = self
            .find(name_or_id)
            .await
            .ok_or_else(|| format!("Service '{}' not found", name_or_id))?;

        let params_json: serde_json::Map<String, Value> = entry
            .params
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::to_value(v).unwrap_or(Value::Null)))
            .collect();

        let req = StartServiceRequest {
            script: entry.script.clone(),
            name: Some(entry.name.clone()),
            params: Some(Value::Object(params_json)),
            cwd: Some(entry.cwd.to_string_lossy().into_owned()),
            replace: true,
        };
        self.start(req, files, secrets).await
    }

    pub async fn remove(&self, name_or_id: &str) -> Result<bool, String> {
        let Some(entry) = self.find(name_or_id).await else {
            return Ok(false);
        };
        entry.stopped.store(true, Ordering::SeqCst);
        entry.inbox_notify.notify_waiters();
        entry.kill_pid();
        entry.pending_replies.lock().await.clear();
        entry.subscribers.lock().await.clear();
        self.services.lock().await.remove(&entry.name);
        Ok(true)
    }

    /// Push a message into a service's inbox (UI/script -> service).
    pub async fn send_to_service(
        &self,
        name_or_id: &str,
        req: SendMessageRequest,
    ) -> Result<ServiceMessage, String> {
        let entry = self
            .find(name_or_id)
            .await
            .ok_or_else(|| format!("Service '{}' not found", name_or_id))?;

        if entry.state.lock().await.status != "running" {
            return Err(format!("Service '{}' is not running", entry.name));
        }

        let tagged_data = normalize_tagged_data(req.data);
        let msg = ServiceMessage {
            id: format!("msg-{}", &Uuid::new_v4().to_string()[..8]),
            service: entry.name.clone(),
            from: req
                .from
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "client".to_string()),
            to: Some(entry.name.clone()),
            topic: req.topic,
            data: tagged_data,
            reply_to: None,
            timestamp: Utc::now().to_rfc3339(),
        };

        entry.messages_in.fetch_add(1, Ordering::SeqCst);
        entry.push_recent(msg.clone()).await;
        entry.inbox.lock().await.push_back(msg.clone());
        entry.inbox_notify.notify_one();
        self.record_bus_event(ServiceBusEvent {
            id: msg.id.clone(),
            kind: "send".to_string(),
            service: msg.service.clone(),
            from: msg.from.clone(),
            to: msg.to.clone(),
            topic: msg.topic.clone(),
            data: msg.data.clone(),
            data_plain: tagged_json_to_plain(&msg.data),
            reply_to: None,
            delivered: 1,
            timestamp: msg.timestamp.clone(),
        })
        .await;
        Ok(msg)
    }

    /// Request-reply RPC to a service (UI/script -> service -> reply).
    pub async fn call_service(
        &self,
        name_or_id: &str,
        req: CallServiceRequest,
    ) -> Result<(Value, Value), String> {
        let entry = self
            .find(name_or_id)
            .await
            .ok_or_else(|| format!("Service '{}' not found", name_or_id))?;

        if entry.state.lock().await.status != "running" {
            return Err(format!("Service '{}' is not running", entry.name));
        }

        let reply_id = format!("req-{}", &Uuid::new_v4().to_string()[..10]);
        let (tx, rx) = oneshot::channel::<Value>();
        entry.pending_replies.lock().await.insert(reply_id.clone(), tx);

        let tagged_data = normalize_tagged_data(req.data);
        let msg = ServiceMessage {
            id: format!("msg-{}", &Uuid::new_v4().to_string()[..8]),
            service: entry.name.clone(),
            from: req
                .from
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "client".to_string()),
            to: Some(entry.name.clone()),
            topic: req.topic,
            data: tagged_data,
            reply_to: Some(reply_id.clone()),
            timestamp: Utc::now().to_rfc3339(),
        };

        entry.messages_in.fetch_add(1, Ordering::SeqCst);
        entry.push_recent(msg.clone()).await;
        self.record_bus_event(ServiceBusEvent {
            id: msg.id.clone(),
            kind: "call".to_string(),
            service: msg.service.clone(),
            from: msg.from.clone(),
            to: msg.to.clone(),
            topic: msg.topic.clone(),
            data: msg.data.clone(),
            data_plain: tagged_json_to_plain(&msg.data),
            reply_to: msg.reply_to.clone(),
            delivered: 1,
            timestamp: msg.timestamp.clone(),
        })
        .await;
        entry.inbox.lock().await.push_back(msg);
        entry.inbox_notify.notify_one();

        let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(15_000).clamp(100, 120_000));
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply_tagged)) => {
                let plain = tagged_json_to_plain(&reply_tagged);
                Ok((reply_tagged, plain))
            }
            Ok(Err(_)) => {
                entry.pending_replies.lock().await.remove(&reply_id);
                Err(format!("Service '{}' closed before replying", entry.name))
            }
            Err(_) => {
                entry.pending_replies.lock().await.remove(&reply_id);
                Err(format!(
                    "Timed out after {} ms waiting for reply from service '{}'",
                    timeout.as_millis(),
                    entry.name
                ))
            }
        }
    }

    /// Long-poll next message from a service's inbox (called by the service script via `service::recv`).
    pub async fn recv_for_service(
        &self,
        name_or_id: &str,
        timeout_ms: u64,
    ) -> Result<(Option<ServiceMessage>, bool), String> {
        let entry = self
            .find(name_or_id)
            .await
            .ok_or_else(|| format!("Service '{}' not found", name_or_id))?;

        let deadline = tokio::time::Instant::now()
            + Duration::from_millis(timeout_ms.min(60_000));

        loop {
            if let Some(msg) = entry.inbox.lock().await.pop_front() {
                return Ok((Some(msg), false));
            }
            if entry.stopped.load(Ordering::SeqCst) {
                return Ok((None, true));
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Ok((None, false));
            }
            let remaining = deadline - now;
            let _ = tokio::time::timeout(remaining, entry.inbox_notify.notified()).await;
        }
    }

    /// Emit a message from a service to all subscribed UIs (broadcast) OR one specific UI (`to`).
    pub async fn emit_from_service(
        &self,
        name_or_id: &str,
        req: EmitMessageRequest,
    ) -> Result<(usize, ServiceMessage), String> {
        let entry = self
            .find(name_or_id)
            .await
            .ok_or_else(|| format!("Service '{}' not found", name_or_id))?;

        let tagged_data = normalize_tagged_data(req.data);
        let msg = ServiceMessage {
            id: format!("msg-{}", &Uuid::new_v4().to_string()[..8]),
            service: entry.name.clone(),
            from: req
                .from
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| entry.name.clone()),
            to: req.to.clone(),
            topic: req.topic,
            data: tagged_data,
            reply_to: None,
            timestamp: Utc::now().to_rfc3339(),
        };

        let delivered = {
            let mut subs = entry.subscribers.lock().await;
            let mut dead = Vec::new();
            let mut count = 0usize;
            if let Some(target_client) = req.to.as_deref() {
                if let Some(tx) = subs.get(target_client) {
                    if tx.send(msg.clone()).is_ok() {
                        count = 1;
                    } else {
                        dead.push(target_client.to_string());
                    }
                }
            } else {
                for (cid, tx) in subs.iter() {
                    if tx.send(msg.clone()).is_ok() {
                        count += 1;
                    } else {
                        dead.push(cid.clone());
                    }
                }
            }
            for cid in dead {
                subs.remove(&cid);
            }
            count
        };

        entry.messages_out.fetch_add(1, Ordering::SeqCst);
        entry.push_recent(msg.clone()).await;
        self.record_bus_event(ServiceBusEvent {
            id: msg.id.clone(),
            kind: if msg.to.is_some() {
                "direct".to_string()
            } else {
                "broadcast".to_string()
            },
            service: msg.service.clone(),
            from: msg.from.clone(),
            to: msg.to.clone(),
            topic: msg.topic.clone(),
            data: msg.data.clone(),
            data_plain: tagged_json_to_plain(&msg.data),
            reply_to: None,
            delivered,
            timestamp: msg.timestamp.clone(),
        })
        .await;
        Ok((delivered, msg))
    }

    /// Fulfill a pending `call_service` RPC request.
    pub async fn reply_from_service(
        &self,
        name_or_id: &str,
        req: ReplyMessageRequest,
    ) -> Result<bool, String> {
        let entry = self
            .find(name_or_id)
            .await
            .ok_or_else(|| format!("Service '{}' not found", name_or_id))?;

        let tagged_data = normalize_tagged_data(req.data);
        let tx = entry.pending_replies.lock().await.remove(&req.reply_to);
        if let Some(sender) = tx {
            entry.messages_out.fetch_add(1, Ordering::SeqCst);
            let data_plain = tagged_json_to_plain(&tagged_data);
            let ok = sender.send(tagged_data.clone()).is_ok();
            self.record_bus_event(ServiceBusEvent {
                id: format!("rep-{}", &Uuid::new_v4().to_string()[..8]),
                kind: "reply".to_string(),
                service: entry.name.clone(),
                from: entry.name.clone(),
                to: None,
                topic: format!("reply:{}", req.reply_to),
                data: tagged_data,
                data_plain,
                reply_to: Some(req.reply_to),
                delivered: if ok { 1 } else { 0 },
                timestamp: Utc::now().to_rfc3339(),
            })
            .await;
            Ok(ok)
        } else {
            Ok(false)
        }
    }

    /// Subscribe a UI client to real-time SSE messages emitted by a service.
    /// If the service hasn't started yet? Only existing services can be subscribed to (or returns 404).
    pub async fn subscribe(
        &self,
        name_or_id: &str,
        client_id: Option<String>,
    ) -> Result<ServiceSubscription, String> {
        let entry = self
            .find(name_or_id)
            .await
            .ok_or_else(|| format!("Service '{}' not found", name_or_id))?;

        let cid = client_id
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("ui-{}", &Uuid::new_v4().to_string()[..8]));
        let (tx, rx) = mpsc::unbounded_channel();
        entry.subscribers.lock().await.insert(cid.clone(), tx);

        Ok(ServiceSubscription {
            client_id: cid,
            service_name: entry.name.clone(),
            entry,
            rx,
        })
    }
}

fn spawn_service_process(entry: Arc<ServiceEntry>, code: String, secrets: Arc<SecretsVault>) {
    tokio::spawn(async move {
        let exe = match std::env::current_exe() {
            Ok(p) => p,
            Err(e) => {
                mark_service_failed(&entry, format!("Failed to locate binary: {}", e)).await;
                return;
            }
        };

        let mut cmd = Command::new(exe);
        cmd.arg("--kernel")
            .arg("--lang")
            .arg("minilang")
            .current_dir(&entry.cwd)
            .env("MINILANG_SERVICE_ID", &entry.id)
            .env("MINILANG_SERVICE_NAME", &entry.name)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);

        for (k, v) in secrets.env_map() {
            cmd.env(&k, &v);
            cmd.env(format!("MLNB_SECRET_{}", k), &v);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                mark_service_failed(&entry, format!("Failed to spawn service process: {}", e)).await;
                return;
            }
        };

        if let Some(pid) = child.id() {
            entry.pid.store(pid, Ordering::SeqCst);
        }

        let Some(mut stdin) = child.stdin.take() else {
            mark_service_failed(&entry, "Failed to capture service stdin".to_string()).await;
            return;
        };
        let Some(stdout) = child.stdout.take() else {
            mark_service_failed(&entry, "Failed to capture service stdout".to_string()).await;
            return;
        };

        let req = KernelRequest::Invoke {
            code,
            source: entry.script.clone(),
            params: entry.params.clone(),
            args: Vec::new(),
            function: None,
            stream: true,
        };
        if let Ok(line) = serde_json::to_string(&req) {
            let _ = stdin.write_all(line.as_bytes()).await;
            let _ = stdin.write_all(b"\n").await;
            let _ = stdin.flush().await;
        }
        drop(stdin);

        let mut reader = BufReader::new(stdout);
        let mut buf = String::new();
        let mut final_error: Option<String> = None;

        loop {
            buf.clear();
            match reader.read_line(&mut buf).await {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = buf.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(resp) = serde_json::from_str::<KernelResponse>(trimmed) {
                        match resp {
                            KernelResponse::StreamEvent { event, data } => {
                                if event == "stdout" {
                                    if let Some(txt) = data.get("text").and_then(|v| v.as_str()) {
                                        let mut st = entry.state.lock().await;
                                        st.stdout.push_str(txt);
                                        if st.stdout.len() > 64 * 1024 {
                                            let drain = st.stdout.len() - 64 * 1024;
                                            st.stdout.drain(..drain);
                                        }
                                    }
                                }
                            }
                            KernelResponse::InvokeResult { stdout, error, .. } => {
                                let mut st = entry.state.lock().await;
                                if st.stdout.is_empty() && !stdout.is_empty() {
                                    st.stdout = stdout;
                                }
                                if let Some(err) = error {
                                    final_error = Some(format!("{}: {}", err.error_type, err.message));
                                }
                                break;
                            }
                            KernelResponse::Err { message } => {
                                final_error = Some(message);
                                break;
                            }
                            _ => {}
                        }
                    }
                }
                Err(e) => {
                    if !entry.stopped.load(Ordering::SeqCst) {
                        final_error = Some(format!("Service I/O error: {}", e));
                    }
                    break;
                }
            }
        }

        let _ = child.kill().await;
        let _ = child.wait().await;
        entry.pid.store(0, Ordering::SeqCst);
        entry.pending_replies.lock().await.clear();

        let was_stopped = entry.stopped.load(Ordering::SeqCst);
        let mut st = entry.state.lock().await;
        if st.status == "running" {
            if was_stopped {
                st.status = "stopped".to_string();
            } else if let Some(err) = final_error {
                st.status = "failed".to_string();
                st.error = Some(err);
            } else {
                st.status = "stopped".to_string();
            }
            st.stopped_at = Some(Utc::now().to_rfc3339());
        }
    });
}

async fn mark_service_failed(entry: &Arc<ServiceEntry>, msg: String) {
    entry.pid.store(0, Ordering::SeqCst);
    let mut st = entry.state.lock().await;
    st.status = "failed".to_string();
    st.error = Some(msg);
    st.stopped_at = Some(Utc::now().to_rfc3339());
}

fn normalize_tagged_data(val: Option<Value>) -> Value {
    match val {
        None | Some(Value::Null) => json!({ "type": "nil" }),
        Some(v) => {
            if v.as_object()
                .and_then(|o| o.get("type").and_then(|t| t.as_str()))
                .is_some()
                && serde_json::from_value::<TaggedValue>(v.clone()).is_ok()
            {
                v
            } else {
                let tv = json_to_tagged_value(&v);
                serde_json::to_value(&tv).unwrap_or_else(|_| json!({ "type": "nil" }))
            }
        }
    }
}

fn parse_service_params(val: Option<Value>) -> Result<BTreeMap<String, TaggedValue>, String> {
    let mut out = BTreeMap::new();
    let Some(v) = val else { return Ok(out) };
    if v.is_null() {
        return Ok(out);
    }
    let obj = v
        .as_object()
        .ok_or_else(|| "Service 'params' must be a JSON object".to_string())?;
    for (k, raw) in obj {
        out.insert(k.clone(), json_to_tagged_value(raw));
    }
    Ok(out)
}

fn derive_service_name(requested: Option<&str>, rel_script: &str) -> Result<String, String> {
    let raw = match requested.map(str::trim).filter(|s| !s.is_empty()) {
        Some(n) => n.to_string(),
        None => Path::new(rel_script)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("service")
            .to_string(),
    };
    let clean: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if clean.is_empty() {
        return Err("Invalid service name".to_string());
    }
    Ok(clean)
}

fn resolve_service_script(
    files: &FileStore,
    requested: &str,
    cwd: Option<&str>,
) -> Result<(String, PathBuf), String> {
    let trimmed = requested.trim();
    if trimmed.is_empty() {
        return Err("Service script path cannot be empty".to_string());
    }

    let root = files.root();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(cwd_str) = cwd.map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(cwd_canon) = fs::canonicalize(cwd_str) {
            if cwd_canon.starts_with(root) {
                candidates.push(cwd_canon.join(trimmed));
                if !trimmed.ends_with(".mini") {
                    candidates.push(cwd_canon.join(format!("{}.mini", trimmed)));
                }
            }
        }
    }
    let clean = trimmed.trim_start_matches('/');
    candidates.push(root.join(clean));
    if !clean.ends_with(".mini") {
        candidates.push(root.join(format!("{}.mini", clean)));
        if !clean.contains('/') {
            candidates.push(root.join(format!("services/{}.mini", clean)));
            candidates.push(root.join(format!("scripts/{}.mini", clean)));
        }
    } else if !clean.contains('/') {
        candidates.push(root.join(format!("services/{}", clean)));
        candidates.push(root.join(format!("scripts/{}", clean)));
    }

    for cand in candidates {
        if let Ok(canon) = fs::canonicalize(&cand) {
            if canon.starts_with(root) && canon.is_file() {
                let rel = canon
                    .strip_prefix(root)
                    .unwrap_or(&canon)
                    .to_string_lossy()
                    .replace('\\', "/");
                return Ok((rel, canon));
            }
        }
    }

    Err(format!("Service script '{}' not found", requested))
}
