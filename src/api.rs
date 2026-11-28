use crate::agy::{AgyAssistRequest, AgyPromptRequest, AgyRunner};
use crate::auth::{self, AuthManager, AuthenticatedUser};
use crate::debugger::{DebugManager, StartDebugRequest};
use crate::files::FileStore;
use crate::jobs::{JobManager, StartJobRequest};
use crate::kernel_mgr::{InvokeExecError, KernelManager};
use crate::kernel_proc::KernelResponse;
use crate::lang::LanguageRegistry;
use crate::notebook::NotebookDocument;
use crate::scheduler::{CreateScheduleRequest, Scheduler, UpdateScheduleRequest};
use crate::secrets::SecretsVault;
use crate::services::{
    CallServiceRequest, EmitMessageRequest, RecvMessageRequest, ReplyMessageRequest,
    SendMessageRequest, ServiceManager, StartServiceRequest,
};
use crate::tagged::TaggedValue;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{delete, get, post, put};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::convert::Infallible;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

const EMBED_INDEX_HTML: &str = include_str!("../web/index.html");
const EMBED_STYLE_CSS: &str = include_str!("../web/style.css");

const EMBED_JS_MODULES: &[(&str, &str)] = &[
    ("main.js", include_str!("../web/js/main.js")),
    ("viz/viz.js", include_str!("../web/js/viz/viz.js")),
    ("viz/cluster.js", include_str!("../web/js/viz/cluster.js")),
    ("minijs/index.js", include_str!("../web/js/minijs/index.js")),
    ("minijs/values.js", include_str!("../web/js/minijs/values.js")),
    ("minijs/widgets.js", include_str!("../web/js/minijs/widgets.js")),
    ("minijs/service_client.js", include_str!("../web/js/minijs/service_client.js")),
    ("minijs/vm.js", include_str!("../web/js/minijs/vm.js")),
    ("core/highlight.js", include_str!("../web/js/core/highlight.js")),
    ("core/markdown.js", include_str!("../web/js/core/markdown.js")),
    ("core/auth.js", include_str!("../web/js/core/auth.js")),
    ("core/ui_helpers.js", include_str!("../web/js/core/ui_helpers.js")),
    ("core/state.js", include_str!("../web/js/core/state.js")),
    ("features/media.js", include_str!("../web/js/features/media.js")),
    ("features/files.js", include_str!("../web/js/features/files.js")),
    ("features/viewers.js", include_str!("../web/js/features/viewers.js")),
    ("features/notebook.js", include_str!("../web/js/features/notebook.js")),
    ("features/script_tools.js", include_str!("../web/js/features/script_tools.js")),
    ("features/managers.js", include_str!("../web/js/features/managers.js")),
    ("features/agy.js", include_str!("../web/js/features/agy.js")),
    ("features/debugger.js", include_str!("../web/js/features/debugger.js")),
    ("features/editor_tools.js", include_str!("../web/js/features/editor_tools.js")),
];

pub struct AppState {
    pub files: Arc<FileStore>,
    pub kernels: Arc<KernelManager>,
    pub languages: Arc<LanguageRegistry>,
    pub auth: Arc<AuthManager>,
    pub agy: Arc<AgyRunner>,
    pub secrets: Arc<SecretsVault>,
    pub scheduler: Arc<Scheduler>,
    pub jobs: Arc<JobManager>,
    pub services: Arc<ServiceManager>,
    pub debugger: Arc<DebugManager>,
    pub internal_token: String,
    pub web_dir: Option<PathBuf>,
}

pub fn build_router(state: Arc<AppState>) -> Router {
    let public_routes = Router::new()
        .route("/", get(serve_index))
        .route("/style.css", get(serve_css))
        .route("/js/*path", get(serve_js_module))
        .route("/app.js", get(serve_js))
        .route("/minijs_vm.js", get(serve_minijs_vm))
        // Authentication & token lifecycle endpoints (always accessible)
        .route("/api/auth/status", get(api_auth_status))
        .route("/api/auth/login", post(api_auth_login))
        .route("/api/auth/refresh", post(api_auth_refresh))
        .route("/api/auth/logout", post(api_auth_logout))
        // Webhook trigger endpoint (authenticated by unguessable per-schedule webhook token)
        .route("/api/webhooks/:token", post(api_trigger_webhook));

    let protected_routes = Router::new()
        .route("/ui/*script", get(serve_standalone_ui))
        .route("/api/auth/me", get(api_auth_me))
        .route("/api/auth/logout-all", post(api_auth_logout_all))
        .route("/api/info", get(api_info))
        .route("/api/languages", get(api_languages))
        // File browser, upload, ZIP & grep API
        .route("/api/files", get(api_list_files))
        .route("/api/files/search", get(api_search_files))
        .route("/api/files/grep", get(api_grep_files))
        .route("/api/file", get(api_read_file).put(api_write_file).delete(api_delete_file))
        .route("/api/file/raw", get(api_read_file_raw))
        .route(
            "/api/file/upload",
            post(api_upload_file).layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route("/api/file/zip", get(api_zip_folder))
        .route("/api/log", get(api_read_log))
        .route("/api/sqlite/schema", get(api_sqlite_schema))
        .route("/api/sqlite/query", post(api_sqlite_query))
        .route("/api/sqlite/cluster", post(api_sqlite_cluster))
        .route("/api/file/new", post(api_create_file))
        .route("/api/file/rename", post(api_rename_file))
        .route("/api/file/copy", post(api_copy_file))
        .route("/api/notebook/from-mini", post(api_notebook_from_script))
        .route("/api/notebook/to-mini", post(api_notebook_to_script))
        .route("/api/notebook/from-script", post(api_notebook_from_script))
        .route("/api/notebook/to-script", post(api_notebook_to_script))
        .route("/api/notebook/checkpoints", get(api_list_checkpoints).post(api_create_checkpoint))
        .route("/api/notebook/checkpoints/:id", get(api_get_checkpoint).delete(api_delete_checkpoint))
        // Custom script invocation API
        .route("/invoke", post(api_invoke_root))
        .route("/invoke/*script", post(api_invoke_path))
        .route("/api/scripts", get(api_list_scripts))
        .route("/api/uis", get(api_list_uis))
        // Kernel / REPL API
        .route("/api/kernels", get(api_list_kernels).post(api_create_kernel))
        .route("/api/kernels/:id", delete(api_delete_kernel))
        .route("/api/kernels/:id/status", get(api_kernel_status))
        .route("/api/kernels/:id/execute", post(api_kernel_execute))
        .route("/api/kernels/:id/execute-stream", post(api_kernel_execute_stream))
        .route("/api/kernels/:id/interrupt", post(api_kernel_interrupt))
        .route("/api/kernels/:id/restart", post(api_kernel_restart))
        .route("/api/kernels/:id/inspect", get(api_kernel_inspect))
        .route("/api/kernels/:id/complete", post(api_kernel_complete))
        .route("/api/kernels/:id/chdir", post(api_kernel_chdir))
        // Encrypted Secrets Vault API
        .route("/api/secrets", get(api_list_secrets))
        .route("/api/secrets/:name", put(api_set_secret).delete(api_delete_secret))
        // Scheduled Jobs API
        .route("/api/schedules", get(api_list_schedules).post(api_create_schedule))
        .route("/api/schedules/:id", put(api_update_schedule).delete(api_delete_schedule))
        .route("/api/schedules/:id/run", post(api_run_schedule))
        .route("/api/schedules/:id/toggle", post(api_toggle_schedule))
        // Background Jobs API (used by Minilang `jobs` module & Web UI)
        .route("/api/jobs", get(api_list_jobs).post(api_start_job))
        .route("/api/jobs/clear", post(api_clear_jobs))
        .route("/api/jobs/:id", get(api_get_job).delete(api_delete_job))
        .route("/api/jobs/:id/wait", post(api_wait_job))
        .route("/api/jobs/:id/stop", post(api_stop_job))
        // Background Services & Cross-UI Messaging API
        .route("/api/services", get(api_list_services).post(api_start_service))
        .route("/api/services/bus/history", get(api_services_bus_history))
        .route("/api/services/bus/clear", post(api_services_bus_clear))
        .route("/api/services/bus/stream", get(api_services_bus_stream))
        .route("/api/services/:name", get(api_get_service).delete(api_delete_service))
        .route("/api/services/:name/stop", post(api_stop_service))
        .route("/api/services/:name/restart", post(api_restart_service))
        .route("/api/services/:name/send", post(api_service_send))
        .route("/api/services/:name/call", post(api_service_call))
        .route("/api/services/:name/recv", post(api_service_recv))
        .route("/api/services/:name/emit", post(api_service_emit))
        .route("/api/services/:name/reply", post(api_service_reply))
        .route("/api/services/:name/events", get(api_service_events))
        // Interactive Minilang Debugger API
        .route("/api/debug/sessions", get(api_debug_list))
        .route("/api/debug/start", post(api_debug_start))
        .route("/api/debug/:id", get(api_debug_get).delete(api_debug_terminate))
        .route("/api/debug/:id/step", post(api_debug_step))
        .route("/api/debug/:id/breakpoints", post(api_debug_breakpoints))
        .route("/api/debug/:id/config", post(api_debug_config))
        .route("/api/debug/:id/locals", get(api_debug_locals))
        .route("/api/debug/:id/eval", post(api_debug_eval))
        // Google Antigravity (agy) inline assistant & direct prompt API
        .route("/api/agy/status", get(api_agy_status))
        .route("/api/agy/assist", post(api_agy_assist))
        .route("/api/agy/prompt", post(api_agy_prompt))
        .route("/api/agy/prompt-stream", post(api_agy_prompt_stream))
        .route("/api/agy/cancel", post(api_agy_cancel))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth_middleware));

    public_routes.merge(protected_routes).with_state(state)
}

async fn auth_middleware<B>(
    State(st): State<Arc<AppState>>,
    mut req: Request<B>,
    next: Next<B>,
) -> Response {
    if !st.auth.is_enabled() {
        return next.run(req).await;
    }

    // Allow internal loopback calls from server-spawned kernels (e.g. Minilang `jobs` module)
    if let Some(tok) = req
        .headers()
        .get("x-internal-token")
        .and_then(|v| v.to_str().ok())
    {
        let a = tok.as_bytes();
        let b = st.internal_token.as_bytes();
        if a.len() == b.len() && !a.is_empty() {
            let mut diff = 0u8;
            for (&x, &y) in a.iter().zip(b.iter()) {
                diff |= x ^ y;
            }
            if diff == 0 {
                return next.run(req).await;
            }
        }
    }

    let token = auth::extract_access_token(req.headers(), req.uri().query());
    let auth_res = match token {
        Some(t) => st.auth.verify_access_token(&t),
        None => Err(auth::AuthError::Unauthorized(
            "Authentication required. Sign in via POST /api/auth/login.".to_string(),
        )),
    };

    match auth_res {
        Ok(user) => {
            req.extensions_mut().insert(user);
            next.run(req).await
        }
        Err(err) => {
            let path = req.uri().path();
            let wants_html = req
                .headers()
                .get(header::ACCEPT)
                .and_then(|v| v.to_str().ok())
                .map(|s| s.contains("text/html"))
                .unwrap_or(false);
            if path.starts_with("/ui/") && wants_html {
                let target = req
                    .uri()
                    .path_and_query()
                    .map(|pq| pq.as_str())
                    .unwrap_or(path);
                let encoded: String = target
                    .bytes()
                    .flat_map(|b| match b {
                        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                            vec![b as char]
                        }
                        _ => format!("%{:02X}", b).chars().collect(),
                    })
                    .collect();
                return Redirect::temporary(&format!("/?next={}", encoded)).into_response();
            }

            (
                err.status_code(),
                [(
                    header::WWW_AUTHENTICATE,
                    "Bearer realm=\"minilang-notebook\"",
                )],
                Json(json!({
                    "error": err.message(),
                    "code": err.code(),
                    "auth_required": true,
                })),
            )
                .into_response()
        }
    }
}

fn load_asset(web_dir: &Option<PathBuf>, filename: &str, fallback: &'static str) -> String {
    if let Some(dir) = web_dir {
        if let Ok(content) = std::fs::read_to_string(dir.join(filename)) {
            return content;
        }
    }
    fallback.to_string()
}

async fn serve_index(State(st): State<Arc<AppState>>) -> Response {
    let body = load_asset(&st.web_dir, "index.html", EMBED_INDEX_HTML);
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        body,
    )
        .into_response()
}

async fn serve_css(State(st): State<Arc<AppState>>) -> Response {
    let body = load_asset(&st.web_dir, "style.css", EMBED_STYLE_CSS);
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        body,
    )
        .into_response()
}

async fn serve_js_module(
    State(st): State<Arc<AppState>>,
    Path(path): Path<String>,
) -> Response {
    let clean = path.trim_start_matches('/');
    if clean.is_empty()
        || clean.contains("..")
        || clean.contains('\\')
        || !clean.ends_with(".js")
    {
        return (StatusCode::NOT_FOUND, "JS module not found").into_response();
    }
    if let Some(dir) = &st.web_dir {
        if let Ok(content) = std::fs::read_to_string(dir.join("js").join(clean)) {
            return (
                [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
                content,
            )
                .into_response();
        }
    }
    if let Some((_, embedded)) = EMBED_JS_MODULES.iter().find(|(k, _)| *k == clean) {
        return (
            [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
            *embedded,
        )
            .into_response();
    }
    (StatusCode::NOT_FOUND, "JS module not found").into_response()
}

async fn serve_js(State(_st): State<Arc<AppState>>) -> Response {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        "import \"/js/main.js\";\n",
    )
        .into_response()
}

async fn serve_minijs_vm(State(_st): State<Arc<AppState>>) -> Response {
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        "export * from \"/js/minijs/index.js\";\n",
    )
        .into_response()
}

fn resolve_ui_file(files: &FileStore, requested: &str) -> Result<(String, PathBuf), (StatusCode, String)> {
    let trimmed = requested.trim().trim_start_matches('/');
    if trimmed.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "Missing UI file path (expected a .ui or .mini file)".to_string(),
        ));
    }

    let mut candidates: Vec<String> = Vec::new();
    let ext = std::path::Path::new(trimmed)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase());

    match ext.as_deref() {
        Some("ui") => {
            candidates.push(trimmed.to_string());
            if !trimmed.starts_with("uis/") {
                candidates.push(format!("uis/{}", trimmed));
            }
        }
        Some("mini") => {
            candidates.push(trimmed.to_string());
            if !trimmed.starts_with("scripts/") {
                candidates.push(format!("scripts/{}", trimmed));
            }
        }
        Some(_) => {
            return Err((
                StatusCode::BAD_REQUEST,
                format!("Only '.ui' (or '.mini') UI files can be served at /ui (got '{}')", trimmed),
            ));
        }
        None => {
            candidates.push(format!("{}.ui", trimmed));
            if !trimmed.starts_with("uis/") {
                candidates.push(format!("uis/{}.ui", trimmed));
            }
            candidates.push(format!("{}.mini", trimmed));
            if !trimmed.starts_with("scripts/") {
                candidates.push(format!("scripts/{}.mini", trimmed));
            }
        }
    }

    for cand in &candidates {
        if let Ok(abs) = files.resolve_existing(cand) {
            if abs.is_file() {
                let rel = abs
                    .strip_prefix(files.root())
                    .unwrap_or(&abs)
                    .to_string_lossy()
                    .replace('\\', "/");
                return Ok((rel, abs));
            }
        }
    }

    Err((
        StatusCode::NOT_FOUND,
        format!("UI file '{}' not found", trimmed),
    ))
}

async fn serve_standalone_ui(
    State(st): State<Arc<AppState>>,
    Path(script): Path<String>,
) -> Response {
    let (rel_path, abs_path) = match resolve_ui_file(&st.files, &script) {
        Ok(pair) => pair,
        Err((status, msg)) => {
            return (status, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], msg).into_response();
        }
    };
    let code = match std::fs::read_to_string(&abs_path) {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Failed to read {}: {}", rel_path, e),
            )
                .into_response();
        }
    };

    // Support pre-compiled MiniJS JSON .ui files directly as well as Minilang source .ui files
    let (bundles, err_html) = if code.trim_start().starts_with('{') {
        match serde_json::from_str::<serde_json::Value>(&code) {
            Ok(v) if v.get("format").and_then(|f| f.as_str()) == Some("minilang-ui") => {
                (vec![code], None)
            }
            _ => compile_ui_source(&st, &rel_path, &abs_path, code).await,
        }
    } else {
        compile_ui_source(&st, &rel_path, &abs_path, code).await
    };

    let bundles_json = serde_json::to_string(&bundles).unwrap_or_else(|_| "[]".to_string());
    let err_json = serde_json::to_string(&err_html).unwrap_or_else(|_| "null".to_string());
    let title_esc = rel_path.replace('<', "&lt;").replace('>', "&gt;");

    let html = format!(
        r#"<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>{title} — Minilang UI</title>
  <link rel="stylesheet" href="/style.css"/>
  <style>
    body {{ overflow: auto; padding: 28px; background: var(--bg-app); }}
    .standalone-wrap {{ max-width: 900px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }}
    .standalone-header {{ display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: 12px; }}
    .standalone-header a {{ color: var(--accent); text-decoration: none; font-size: 13px; }}
  </style>
</head>
<body>
  <div class="standalone-wrap">
    <div class="standalone-header">
      <div class="brand"><span class="brand-logo">λ</span><span>{title}</span></div>
      <a href="/">&larr; Back to Minilang Notebook</a>
    </div>
    <div id="ui-mount"></div>
  </div>
  <script type="module">
    import {{ MinijsUI }} from "/js/minijs/index.js";
    const bundles = {bundles};
    const errMsg = {err};
    const mount = document.getElementById("ui-mount");
    if (errMsg) {{
      const d = document.createElement("pre");
      d.className = "mlui-error-banner";
      d.textContent = errMsg;
      mount.appendChild(d);
    }} else if (bundles.length === 0) {{
      const d = document.createElement("div");
      d.className = "mlui-panel";
      d.textContent = "UI file executed without calling ui::show(...).";
      mount.appendChild(d);
    }} else {{
      for (const b of bundles) MinijsUI.mount(mount, b);
    }}
  </script>
</body>
</html>"#,
        title = title_esc,
        bundles = bundles_json,
        err = err_json
    );
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response()
}

async fn compile_ui_source(
    st: &Arc<AppState>,
    rel_path: &str,
    abs_path: &std::path::Path,
    code: String,
) -> (Vec<String>, Option<String>) {
    let cwd = abs_path.parent().unwrap_or_else(|| st.files.root()).to_path_buf();
    let res = st
        .kernels
        .invoke_script(
            "minilang",
            code,
            rel_path.to_string(),
            cwd,
            BTreeMap::new(),
            Vec::new(),
            None,
            30_000,
        )
        .await;

    match res {
        Ok(KernelResponse::InvokeResult { displays, error, .. }) => {
            let ui_bundles: Vec<String> = displays
                .into_iter()
                .filter(|d| d.mime == "application/vnd.minilang.ui+json")
                .map(|d| d.data)
                .collect();
            let err = error.map(|e| format!("{}: {}\n{}", e.error_type, e.message, e.traceback));
            (ui_bundles, err)
        }
        Ok(KernelResponse::Err { message }) => (Vec::new(), Some(message)),
        Err(InvokeExecError::Timeout(ms)) => (Vec::new(), Some(format!("Timed out after {} ms", ms))),
        Err(InvokeExecError::Internal(m)) => (Vec::new(), Some(m)),
        _ => (Vec::new(), Some("Unexpected kernel response".to_string())),
    }
}

fn api_err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

async fn api_info(State(st): State<Arc<AppState>>) -> Response {
    let root_name = st
        .files
        .root()
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".to_string());
    Json(json!({
        "app": "Minilang Notebook",
        "version": env!("CARGO_PKG_VERSION"),
        "minilang_version": "2.17.0",
        "languages": st.languages.list_info(),
        "auth_required": st.auth.is_enabled(),
        "required_group": st.auth.required_group(),
        "agy": st.agy.status(),
        "root_name": root_name,
        "root_path": st.files.root().display().to_string(),
    }))
    .into_response()
}

// --- Authentication & Refreshable Token Routes ---

async fn api_auth_status(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    let user = auth::extract_access_token(&headers, None)
        .and_then(|tok| st.auth.verify_access_token(&tok).ok());
    let authenticated = if st.auth.is_enabled() {
        user.is_some()
    } else {
        true
    };
    Json(json!({
        "auth_required": st.auth.is_enabled(),
        "required_group": st.auth.required_group(),
        "authenticated": authenticated,
        "user": user,
        "access_token_ttl": st.auth.access_token_ttl(),
        "refresh_token_ttl": st.auth.refresh_token_ttl(),
    }))
    .into_response()
}

#[derive(Deserialize)]
struct LoginBody {
    username: String,
    password: String,
}

async fn api_auth_login(
    State(st): State<Arc<AppState>>,
    Json(body): Json<LoginBody>,
) -> Response {
    match st.auth.login(body.username, body.password).await {
        Ok(pair) => {
            let mut resp = Json(&pair).into_response();
            auth::append_auth_cookies(resp.headers_mut(), &pair);
            resp
        }
        Err(err) => (
            err.status_code(),
            Json(json!({
                "error": err.message(),
                "code": err.code(),
            })),
        )
            .into_response(),
    }
}

#[derive(Deserialize, Default)]
struct RefreshBody {
    refresh_token: Option<String>,
}

async fn api_auth_refresh(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    raw_body: String,
) -> Response {
    let body_token = if raw_body.trim().is_empty() {
        None
    } else {
        serde_json::from_str::<RefreshBody>(&raw_body)
            .ok()
            .and_then(|b| b.refresh_token)
    };
    let refresh_token = body_token
        .filter(|s| !s.trim().is_empty())
        .or_else(|| auth::parse_cookie(&headers, auth::REFRESH_COOKIE_NAME));

    let Some(token) = refresh_token else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error": "Missing refresh token",
                "code": "missing_refresh_token",
            })),
        )
            .into_response();
    };

    match st.auth.refresh(&token).await {
        Ok(pair) => {
            let mut resp = Json(&pair).into_response();
            auth::append_auth_cookies(resp.headers_mut(), &pair);
            resp
        }
        Err(err) => {
            let mut resp = (
                err.status_code(),
                Json(json!({
                    "error": err.message(),
                    "code": err.code(),
                })),
            )
                .into_response();
            auth::append_clear_auth_cookies(resp.headers_mut());
            resp
        }
    }
}

async fn api_auth_logout(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    raw_body: String,
) -> Response {
    let body_token = if raw_body.trim().is_empty() {
        None
    } else {
        serde_json::from_str::<RefreshBody>(&raw_body)
            .ok()
            .and_then(|b| b.refresh_token)
    };
    let refresh_token = body_token
        .filter(|s| !s.trim().is_empty())
        .or_else(|| auth::parse_cookie(&headers, auth::REFRESH_COOKIE_NAME));

    let revoked = refresh_token
        .map(|t| st.auth.logout(&t))
        .unwrap_or(false);

    let mut resp = Json(json!({ "ok": true, "revoked": revoked })).into_response();
    auth::append_clear_auth_cookies(resp.headers_mut());
    resp
}

async fn api_auth_me(
    State(st): State<Arc<AppState>>,
    user: Option<Extension<AuthenticatedUser>>,
) -> Response {
    match user {
        Some(Extension(u)) => {
            let active_sessions = st.auth.active_sessions_for_user(&u.username);
            Json(json!({
                "auth_required": st.auth.is_enabled(),
                "authenticated": true,
                "user": u,
                "active_sessions": active_sessions,
            }))
            .into_response()
        }
        None => Json(json!({
            "auth_required": st.auth.is_enabled(),
            "authenticated": !st.auth.is_enabled(),
            "user": null,
            "active_sessions": 0,
        }))
        .into_response(),
    }
}

async fn api_auth_logout_all(
    State(st): State<Arc<AppState>>,
    user: Option<Extension<AuthenticatedUser>>,
) -> Response {
    let revoked_sessions = match user {
        Some(Extension(u)) => st.auth.logout_all_for_user(&u.username),
        None => 0,
    };
    let mut resp = Json(json!({
        "ok": true,
        "revoked_sessions": revoked_sessions,
    }))
    .into_response();
    auth::append_clear_auth_cookies(resp.headers_mut());
    resp
}

async fn api_languages(State(st): State<Arc<AppState>>) -> Response {
    Json(json!({ "languages": st.languages.list_info() })).into_response()
}

#[derive(Deserialize)]
struct ListFilesQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    show_hidden: bool,
}

async fn api_list_files(
    State(st): State<Arc<AppState>>,
    Query(q): Query<ListFilesQuery>,
) -> Response {
    match st.files.list_dir(&q.path, q.show_hidden) {
        Ok(listing) => Json(listing).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
}

async fn api_search_files(
    State(st): State<Arc<AppState>>,
    Query(q): Query<SearchQuery>,
) -> Response {
    let entries = st.files.search_files(&q.q, 100);
    Json(json!({ "entries": entries })).into_response()
}

#[derive(Deserialize)]
struct PathQuery {
    path: String,
}

#[derive(Deserialize)]
struct RawFileQuery {
    path: String,
    #[serde(default)]
    download: Option<String>,
}

async fn api_read_file_raw(
    State(st): State<Arc<AppState>>,
    Query(q): Query<RawFileQuery>,
) -> Response {
    let is_download = matches!(
        q.download.as_deref().map(|s| s.to_ascii_lowercase()).as_deref(),
        Some("1") | Some("true") | Some("yes")
    );
    match st.files.read_raw_file(&q.path) {
        Ok((name, mime, bytes)) => {
            let safe_name = name.replace('"', "_").replace('\r', "").replace('\n', "");
            let disp = if is_download {
                format!("attachment; filename=\"{}\"", safe_name)
            } else {
                format!("inline; filename=\"{}\"", safe_name)
            };
            (
                [
                    (header::CONTENT_TYPE, mime),
                    (header::CONTENT_DISPOSITION, disp),
                    (header::CACHE_CONTROL, "no-cache".to_string()),
                ],
                bytes,
            )
                .into_response()
        }
        Err(e) => api_err(StatusCode::NOT_FOUND, e),
    }
}

#[derive(Deserialize)]
struct LogQuery {
    path: String,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    r#type: Option<String>,
    #[serde(default)]
    reverse: Option<String>,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

async fn api_read_log(
    State(st): State<Arc<AppState>>,
    Query(q): Query<LogQuery>,
) -> Response {
    let abs = match st.files.resolve_existing(&q.path) {
        Ok(p) => p,
        Err(e) => return api_err(StatusCode::NOT_FOUND, e),
    };
    let rel = abs
        .strip_prefix(st.files.root())
        .unwrap_or(&abs)
        .to_string_lossy()
        .replace('\\', "/");
    let reverse = matches!(
        q.reverse.as_deref().map(|s| s.to_ascii_lowercase()).as_deref(),
        Some("1") | Some("true") | Some("yes")
    );
    let offset = q.offset.unwrap_or(0);
    let limit = q.limit.unwrap_or(500);
    match crate::log_reader::read_log_file(
        &abs,
        &rel,
        q.q.as_deref(),
        q.r#type.as_deref(),
        reverse,
        offset,
        limit,
    ) {
        Ok(resp) => Json(resp).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn api_read_file(
    State(st): State<Arc<AppState>>,
    Query(q): Query<PathQuery>,
) -> Response {
    match st.files.read_file(&q.path) {
        Ok(res) => Json(res).into_response(),
        Err(e) => api_err(StatusCode::NOT_FOUND, e),
    }
}

#[derive(Deserialize)]
struct WriteFileBody {
    path: String,
    content: String,
}

async fn api_write_file(
    State(st): State<Arc<AppState>>,
    Json(body): Json<WriteFileBody>,
) -> Response {
    match st.files.write_file(&body.path, &body.content) {
        Ok(saved_path) => Json(json!({ "ok": true, "path": saved_path })).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(Deserialize)]
struct CreateFileBody {
    path: String,
    #[serde(default = "default_kind")]
    kind: String,
    #[serde(default)]
    language: Option<String>,
}

fn default_kind() -> String {
    "file".to_string()
}

async fn api_create_file(
    State(st): State<Arc<AppState>>,
    Json(body): Json<CreateFileBody>,
) -> Response {
    match st
        .files
        .create_entry(&body.path, &body.kind, body.language.as_deref())
    {
        Ok(created_path) => Json(json!({ "ok": true, "path": created_path })).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(Deserialize)]
struct RenameBody {
    from: String,
    to: String,
}

async fn api_rename_file(
    State(st): State<Arc<AppState>>,
    Json(body): Json<RenameBody>,
) -> Response {
    match st.files.rename_entry(&body.from, &body.to) {
        Ok(new_path) => Json(json!({ "ok": true, "path": new_path })).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(Deserialize)]
struct CopyBody {
    from: String,
    #[serde(default)]
    to_dir: String,
    #[serde(default)]
    name: Option<String>,
}

async fn api_copy_file(
    State(st): State<Arc<AppState>>,
    Json(body): Json<CopyBody>,
) -> Response {
    match st.files.copy_entry(&body.from, &body.to_dir, body.name.as_deref()) {
        Ok(new_path) => Json(json!({ "ok": true, "path": new_path })).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn api_delete_file(
    State(st): State<Arc<AppState>>,
    Query(q): Query<PathQuery>,
) -> Response {
    match st.files.delete_entry(&q.path) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(Deserialize)]
struct FromScriptBody {
    title: String,
    content: String,
    #[serde(default)]
    language: Option<String>,
}

async fn api_notebook_from_script(
    State(st): State<Arc<AppState>>,
    Json(body): Json<FromScriptBody>,
) -> Response {
    let lang = body.language.unwrap_or_else(|| {
        let ext = std::path::Path::new(&body.title)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("mini");
        st.languages
            .by_extension(ext)
            .map(|b| b.info().id)
            .unwrap_or_else(|| "minilang".to_string())
    });
    let doc = NotebookDocument::from_script(&body.title, &body.content, &lang);
    Json(doc).into_response()
}

async fn api_notebook_to_script(
    State(st): State<Arc<AppState>>,
    Json(doc): Json<NotebookDocument>,
) -> Response {
    let comment_prefix = st
        .languages
        .by_id(&doc.language)
        .map(|b| b.info().comment_prefix)
        .unwrap_or_else(|| ":>".to_string());
    let script = doc.to_script(&comment_prefix);
    Json(json!({ "script": script })).into_response()
}

// --- Kernel routes ---

async fn api_list_kernels(State(st): State<Arc<AppState>>) -> Response {
    let list = st.kernels.list().await;
    Json(json!({ "kernels": list })).into_response()
}

#[derive(Deserialize, Default)]
struct CreateKernelBody {
    session_id: Option<String>,
    language: Option<String>,
    cwd: Option<String>,
}

async fn api_create_kernel(
    State(st): State<Arc<AppState>>,
    body: Option<Json<CreateKernelBody>>,
) -> Response {
    let body = body.map(|b| b.0).unwrap_or_default();
    let cwd = body
        .cwd
        .as_deref()
        .and_then(|rel| st.files.resolve_existing(rel).ok())
        .map(|p| if p.is_file() { p.parent().unwrap_or(st.files.root()).to_path_buf() } else { p });

    match st
        .kernels
        .get_or_create(body.session_id, body.language.as_deref(), cwd)
        .await
    {
        Ok(session) => {
            let status = session.status().await;
            Json(status).into_response()
        }
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn api_delete_kernel(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let removed = st.kernels.remove(&id).await;
    Json(json!({ "ok": removed })).into_response()
}

async fn api_kernel_status(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    match st.kernels.get(&id).await {
        Some(s) => Json(s.status().await).into_response(),
        None => api_err(StatusCode::NOT_FOUND, "Kernel not found"),
    }
}

#[derive(Deserialize)]
struct ExecuteBody {
    code: String,
    source: Option<String>,
    language: Option<String>,
    #[serde(default)]
    params: Option<serde_json::Value>,
}

async fn api_kernel_execute(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<ExecuteBody>,
) -> Response {
    let parsed_params = match body.params {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::Object(map)) => {
            let mut out = BTreeMap::new();
            for (k, v) in map {
                out.insert(k, crate::jobs::json_to_tagged_value(&v));
            }
            Some(out)
        }
        Some(_) => {
            return api_err(StatusCode::BAD_REQUEST, "'params' must be a JSON object");
        }
    };
    let session = match st
        .kernels
        .get_or_create(Some(id), body.language.as_deref(), None)
        .await
    {
        Ok(s) => s,
        Err(e) => return api_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    match session
        .execute_with_params(body.code, body.source, parsed_params)
        .await
    {
        Ok(resp) => Json(resp).into_response(),
        Err(e) => api_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn api_kernel_interrupt(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    match st.kernels.get(&id).await {
        Some(s) => {
            let sent = s.interrupt_now();
            Json(json!({ "ok": sent })).into_response()
        }
        None => api_err(StatusCode::NOT_FOUND, "Kernel not found"),
    }
}

async fn api_kernel_restart(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let session = match st.kernels.get_or_create(Some(id), None, None).await {
        Ok(s) => s,
        Err(e) => return api_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    match session.restart().await {
        Ok(()) => Json(session.status().await).into_response(),
        Err(e) => api_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn api_kernel_inspect(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let session = match st.kernels.get(&id).await {
        Some(s) => s,
        None => return api_err(StatusCode::NOT_FOUND, "Kernel not found"),
    };
    match session.inspect().await {
        Ok((variables, globals_count)) => {
            Json(json!({ "variables": variables, "globals_count": globals_count })).into_response()
        }
        Err(e) => api_err(StatusCode::CONFLICT, e),
    }
}

#[derive(Deserialize)]
struct CompleteBody {
    prefix: String,
}

#[derive(Serialize)]
struct CompleteResponse {
    items: Vec<crate::kernel_proc::CompletionItem>,
}

async fn api_kernel_complete(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<CompleteBody>,
) -> Response {
    let session = match st.kernels.get_or_create(Some(id), None, None).await {
        Ok(s) => s,
        Err(e) => return api_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    match session.complete(body.prefix).await {
        Ok(items) => Json(CompleteResponse { items }).into_response(),
        Err(e) => api_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

#[derive(Deserialize)]
struct ChdirBody {
    path: String,
}

async fn api_kernel_chdir(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<ChdirBody>,
) -> Response {
    let session = match st.kernels.get_or_create(Some(id), None, None).await {
        Ok(s) => s,
        Err(e) => return api_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let abs = if body.path.trim().is_empty() {
        st.files.root().to_path_buf()
    } else {
        match st.files.resolve_existing(&body.path) {
            Ok(p) => {
                if p.is_file() {
                    p.parent().unwrap_or(st.files.root()).to_path_buf()
                } else {
                    p
                }
            }
            Err(e) => return api_err(StatusCode::BAD_REQUEST, e),
        }
    };
    match session.chdir(abs).await {
        Ok(()) => Json(session.status().await).into_response(),
        Err(e) => api_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

// --- Custom .mini Script Invocation (/invoke) ---

#[derive(Deserialize)]
struct InvokeRequestBody {
    /// Required for POST /invoke; optional when script path is provided in URL POST /invoke/<script>
    #[serde(default)]
    script: Option<String>,
    /// Named parameters in tagged JSON format: { "name": { "type": "string", "value": "World" } }
    #[serde(default)]
    params: BTreeMap<String, TaggedValue>,
    /// Optional positional arguments in tagged JSON format (bound as `Args` or passed to `function`)
    #[serde(default)]
    args: Vec<TaggedValue>,
    /// Optional function name defined in the .mini script to call after loading
    #[serde(default)]
    function: Option<String>,
    /// Execution timeout in milliseconds (default: 30000, max: 120000)
    #[serde(default)]
    timeout_ms: Option<u64>,
}

fn resolve_invocable_script(
    files: &FileStore,
    languages: &LanguageRegistry,
    requested: &str,
) -> Result<(String, PathBuf, String), (StatusCode, String)> {
    let trimmed = requested.trim().trim_start_matches('/');
    let supported_exts = languages.all_script_extensions();
    if trimmed.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "Missing 'script' path (supported extensions: {})",
                supported_exts.join(", ")
            ),
        ));
    }

    let mut candidates: Vec<(String, String)> = Vec::new();
    let ext_opt = std::path::Path::new(trimmed)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase());

    if let Some(ext) = ext_opt {
        let backend = match languages.by_extension(&ext) {
            Some(b) if b.info().supports_invoke => b,
            _ => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    format!(
                        "Unsupported script extension '.{}' (supported: {})",
                        ext,
                        supported_exts
                            .iter()
                            .map(|e| format!(".{}", e))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                ));
            }
        };
        let lang_id = backend.info().id;
        candidates.push((trimmed.to_string(), lang_id.clone()));
        if !trimmed.starts_with("scripts/") {
            candidates.push((format!("scripts/{}", trimmed), lang_id));
        }
    } else {
        for ext in &supported_exts {
            if let Some(backend) = languages.by_extension(ext) {
                let lang_id = backend.info().id;
                candidates.push((format!("{}.{}", trimmed, ext), lang_id.clone()));
                if !trimmed.starts_with("scripts/") {
                    candidates.push((format!("scripts/{}.{}", trimmed, ext), lang_id));
                }
            }
        }
    }

    for (cand, lang_id) in &candidates {
        if let Ok(abs) = files.resolve_existing(cand) {
            if abs.is_file() {
                let rel = abs
                    .strip_prefix(files.root())
                    .unwrap_or(&abs)
                    .to_string_lossy()
                    .replace('\\', "/");
                return Ok((rel, abs, lang_id.clone()));
            }
        }
    }

    Err((
        StatusCode::NOT_FOUND,
        format!("Script '{}' not found", trimmed),
    ))
}

async fn execute_invoke(
    st: Arc<AppState>,
    script_path: String,
    params: BTreeMap<String, TaggedValue>,
    args: Vec<TaggedValue>,
    function: Option<String>,
    timeout_ms: Option<u64>,
) -> Response {
    let (rel_path, abs_path, language_id) =
        match resolve_invocable_script(&st.files, &st.languages, &script_path) {
            Ok(t) => t,
            Err((status, msg)) => return api_err(status, msg),
        };

    let code = match std::fs::read_to_string(&abs_path) {
        Ok(c) => c,
        Err(e) => return api_err(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to read script: {}", e)),
    };

    let cwd = abs_path
        .parent()
        .unwrap_or_else(|| st.files.root())
        .to_path_buf();
    let timeout = timeout_ms.unwrap_or(30_000).clamp(100, 120_000);

    match st
        .kernels
        .invoke_script(
            &language_id,
            code,
            rel_path.clone(),
            cwd,
            params,
            args,
            function,
            timeout,
        )
        .await
    {
        Ok(KernelResponse::InvokeResult {
            result,
            type_name,
            repr,
            stdout,
            displays,
            error,
            duration_ms,
        }) => {
            let status = if error.is_some() {
                StatusCode::UNPROCESSABLE_ENTITY
            } else {
                StatusCode::OK
            };
            (
                status,
                Json(json!({
                    "ok": error.is_none(),
                    "script": rel_path,
                    "language": language_id,
                    "result": result,
                    "type_name": type_name,
                    "repr": repr,
                    "stdout": stdout,
                    "displays": displays,
                    "error": error,
                    "duration_ms": duration_ms,
                })),
            )
                .into_response()
        }
        Ok(KernelResponse::Err { message }) => api_err(StatusCode::BAD_REQUEST, message),
        Ok(_) => api_err(StatusCode::INTERNAL_SERVER_ERROR, "Unexpected kernel response"),
        Err(InvokeExecError::Timeout(ms)) => api_err(
            StatusCode::REQUEST_TIMEOUT,
            format!("Script '{}' timed out after {} ms", rel_path, ms),
        ),
        Err(InvokeExecError::Internal(msg)) => api_err(StatusCode::INTERNAL_SERVER_ERROR, msg),
    }
}

async fn api_invoke_root(
    State(st): State<Arc<AppState>>,
    raw_body: String,
) -> Response {
    let body: InvokeRequestBody = match serde_json::from_str(&raw_body) {
        Ok(b) => b,
        Err(e) => return api_err(StatusCode::BAD_REQUEST, format!("Invalid tagged JSON request: {}", e)),
    };
    let script = match body.script {
        Some(s) if !s.trim().is_empty() => s,
        _ => {
            return api_err(
                StatusCode::BAD_REQUEST,
                "Missing 'script' field in request body (or call POST /invoke/<script.mini>)",
            );
        }
    };
    execute_invoke(st, script, body.params, body.args, body.function, body.timeout_ms).await
}

async fn api_invoke_path(
    State(st): State<Arc<AppState>>,
    Path(script): Path<String>,
    raw_body: String,
) -> Response {
    let body = if raw_body.trim().is_empty() {
        InvokeRequestBody {
            script: None,
            params: BTreeMap::new(),
            args: Vec::new(),
            function: None,
            timeout_ms: None,
        }
    } else {
        match serde_json::from_str::<InvokeRequestBody>(&raw_body) {
            Ok(b) => b,
            Err(e) => {
                return api_err(
                    StatusCode::BAD_REQUEST,
                    format!("Invalid tagged JSON request: {}", e),
                );
            }
        }
    };
    execute_invoke(st, script, body.params, body.args, body.function, body.timeout_ms).await
}

async fn api_list_scripts(State(st): State<Arc<AppState>>) -> Response {
    let mut entries = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for ext in st.languages.all_script_extensions() {
        let dot_ext = format!(".{}", ext);
        for e in st.files.search_files(&dot_ext, 200) {
            if e.kind == "file" && e.extension == ext && seen.insert(e.path.clone()) {
                entries.push(e);
            }
        }
    }
    // Prioritize scripts/ directory first
    entries.sort_by(|a, b| {
        let a_scripts = a.path.starts_with("scripts/");
        let b_scripts = b.path.starts_with("scripts/");
        b_scripts.cmp(&a_scripts).then_with(|| a.path.cmp(&b.path))
    });
    Json(json!({ "scripts": entries })).into_response()
}

async fn api_list_uis(State(st): State<Arc<AppState>>) -> Response {
    let mut entries = st.files.search_files(".ui", 200);
    entries.retain(|e| e.kind == "file" && e.is_ui);
    entries.sort_by(|a, b| {
        let a_uis = a.path.starts_with("uis/");
        let b_uis = b.path.starts_with("uis/");
        b_uis.cmp(&a_uis).then_with(|| a.path.cmp(&b.path))
    });
    Json(json!({ "uis": entries })).into_response()
}

// --- Google Antigravity (agy) Inline Assistant Routes ---

async fn api_agy_status(State(st): State<Arc<AppState>>) -> Response {
    Json(st.agy.status()).into_response()
}

async fn api_agy_assist(
    State(st): State<Arc<AppState>>,
    Json(req): Json<AgyAssistRequest>,
) -> Response {
    if req.prompt.trim().is_empty() {
        return api_err(StatusCode::BAD_REQUEST, "Prompt cannot be empty");
    }
    match st.agy.assist(req).await {
        Ok(resp) => Json(resp).into_response(),
        Err(e) => api_err(StatusCode::BAD_GATEWAY, e),
    }
}

async fn api_agy_prompt(
    State(st): State<Arc<AppState>>,
    Json(req): Json<AgyPromptRequest>,
) -> Response {
    if req.prompt.trim().is_empty() {
        return api_err(StatusCode::BAD_REQUEST, "Prompt cannot be empty");
    }
    match st.agy.prompt(req).await {
        Ok(resp) => Json(resp).into_response(),
        Err(e) => api_err(StatusCode::BAD_GATEWAY, e),
    }
}

async fn api_agy_prompt_stream(
    State(st): State<Arc<AppState>>,
    Json(req): Json<AgyPromptRequest>,
) -> Response {
    if req.prompt.trim().is_empty() {
        return api_err(StatusCode::BAD_REQUEST, "Prompt cannot be empty");
    }
    let (ev_tx, mut ev_rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
    let (sse_tx, sse_rx) = tokio::sync::mpsc::unbounded_channel::<Result<Event, Infallible>>();

    let agy = st.agy.clone();
    tokio::spawn(async move {
        let _ = agy.prompt_stream(req, ev_tx).await;
    });

    tokio::spawn(async move {
        while let Some(val) = ev_rx.recv().await {
            let payload = serde_json::to_string(&val).unwrap_or_else(|_| "{}".to_string());
            if sse_tx.send(Ok(Event::default().data(payload))).is_err() {
                break;
            }
        }
    });

    Sse::new(SseReceiverStream { rx: sse_rx })
        .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)))
        .into_response()
}

#[derive(Deserialize)]
struct AgyCancelBody {
    request_id: String,
}

async fn api_agy_cancel(
    State(st): State<Arc<AppState>>,
    Json(body): Json<AgyCancelBody>,
) -> Response {
    let cancelled = st.agy.cancel(&body.request_id).await;
    Json(json!({ "ok": true, "cancelled": cancelled })).into_response()
}

// --- Streaming Kernel Execution (SSE) ---

struct SseReceiverStream {
    rx: tokio::sync::mpsc::UnboundedReceiver<Result<Event, Infallible>>,
}

impl futures_core::Stream for SseReceiverStream {
    type Item = Result<Event, Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx)
    }
}

async fn api_kernel_execute_stream(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<ExecuteBody>,
) -> Response {
    let session = match st
        .kernels
        .get_or_create(Some(id), body.language.as_deref(), None)
        .await
    {
        Ok(s) => s,
        Err(e) => return api_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    let (sse_tx, sse_rx) = tokio::sync::mpsc::unbounded_channel::<Result<Event, Infallible>>();
    let (kern_tx, mut kern_rx) = tokio::sync::mpsc::unbounded_channel::<KernelResponse>();

    let sse_tx_fwd = sse_tx.clone();
    let fwd_task = tokio::spawn(async move {
        while let Some(msg) = kern_rx.recv().await {
            if let KernelResponse::StreamEvent { event, data } = msg {
                let payload = data.to_string();
                let _ = sse_tx_fwd.send(Ok(Event::default().event(event).data(payload)));
            }
        }
    });

    tokio::spawn(async move {
        let res = session.execute_stream(body.code, body.source, kern_tx).await;
        let _ = fwd_task.await;
        match res {
            Ok(final_resp) => {
                let data = serde_json::to_string(&final_resp).unwrap_or_else(|_| "{}".to_string());
                let _ = sse_tx.send(Ok(Event::default().event("result").data(data)));
            }
            Err(e) => {
                let data = json!({ "error": e }).to_string();
                let _ = sse_tx.send(Ok(Event::default().event("error").data(data)));
            }
        }
    });

    Sse::new(SseReceiverStream { rx: sse_rx })
        .keep_alive(KeepAlive::default())
        .into_response()
}

// --- Drag-and-Drop File Upload & Folder ZIP Download ---

#[derive(Deserialize)]
struct UploadQuery {
    #[serde(default)]
    dir: String,
    #[serde(default)]
    name: Option<String>,
}

async fn api_upload_file(
    State(st): State<Arc<AppState>>,
    Query(q): Query<UploadQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let ct = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if ct.to_lowercase().contains("multipart/form-data") {
        let Some(boundary) = extract_multipart_boundary(ct) else {
            return api_err(StatusCode::BAD_REQUEST, "Missing multipart boundary");
        };
        let parts = parse_multipart_files(&body, &boundary);
        if parts.is_empty() {
            return api_err(StatusCode::BAD_REQUEST, "No files found in multipart upload");
        }
        let mut uploaded = Vec::new();
        for (fname, data) in parts {
            match st.files.upload_file(&q.dir, &fname, data) {
                Ok(rel) => uploaded.push(rel),
                Err(e) => return api_err(StatusCode::BAD_REQUEST, e),
            }
        }
        return Json(json!({ "ok": true, "paths": uploaded })).into_response();
    }

    let Some(name) = q.name.filter(|s| !s.trim().is_empty()) else {
        return api_err(StatusCode::BAD_REQUEST, "Missing 'name' query parameter for raw upload");
    };
    match st.files.upload_file(&q.dir, &name, &body) {
        Ok(rel) => Json(json!({ "ok": true, "path": rel, "paths": [rel] })).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

fn extract_multipart_boundary(content_type: &str) -> Option<String> {
    for part in content_type.split(';') {
        let p = part.trim();
        if let Some(rest) = p.strip_prefix("boundary=").or_else(|| p.strip_prefix("BOUNDARY=")) {
            let clean = rest.trim().trim_matches('"').to_string();
            if !clean.is_empty() {
                return Some(clean);
            }
        }
    }
    None
}

fn find_bytes(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

fn parse_multipart_files<'a>(body: &'a [u8], boundary: &str) -> Vec<(String, &'a [u8])> {
    let delim = format!("--{}", boundary).into_bytes();
    let mut out = Vec::new();
    let mut pos = 0usize;

    while let Some(rel) = find_bytes(&body[pos..], &delim) {
        let part_start = pos + rel + delim.len();
        if part_start + 2 <= body.len() && &body[part_start..part_start + 2] == b"--" {
            break;
        }
        let mut cur = part_start;
        if cur + 2 <= body.len() && &body[cur..cur + 2] == b"\r\n" {
            cur += 2;
        } else if cur < body.len() && body[cur] == b'\n' {
            cur += 1;
        }
        let next_delim = match find_bytes(&body[cur..], &delim) {
            Some(n) => cur + n,
            None => break,
        };
        let part_slice = &body[cur..next_delim];
        let (hdr_end, sep_len) = if let Some(i) = find_bytes(part_slice, b"\r\n\r\n") {
            (i, 4)
        } else if let Some(i) = find_bytes(part_slice, b"\n\n") {
            (i, 2)
        } else {
            pos = next_delim;
            continue;
        };
        let hdr_str = String::from_utf8_lossy(&part_slice[..hdr_end]);
        let mut data = &part_slice[hdr_end + sep_len..];
        if data.ends_with(b"\r\n") {
            data = &data[..data.len() - 2];
        } else if data.ends_with(b"\n") {
            data = &data[..data.len() - 1];
        }

        if let Some(fname) = extract_disposition_filename(&hdr_str) {
            out.push((fname, data));
        }
        pos = next_delim;
    }
    out
}

fn extract_disposition_filename(headers: &str) -> Option<String> {
    for line in headers.lines() {
        let lower = line.to_lowercase();
        if lower.starts_with("content-disposition:") {
            if let Some(idx) = lower.find("filename=") {
                let rest = &line[idx + "filename=".len()..];
                let fname = if let Some(stripped) = rest.strip_prefix('"') {
                    stripped.split('"').next().unwrap_or("")
                } else {
                    rest.split(';').next().unwrap_or("").trim()
                };
                if !fname.is_empty() {
                    return Some(fname.to_string());
                }
            }
        }
    }
    None
}

#[derive(Deserialize)]
struct ZipQuery {
    #[serde(default)]
    path: String,
}

async fn api_zip_folder(
    State(st): State<Arc<AppState>>,
    Query(q): Query<ZipQuery>,
) -> Response {
    match st.files.zip_directory(&q.path) {
        Ok((zip_name, bytes)) => {
            let safe = zip_name.replace('"', "_");
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, "application/zip".to_string()),
                    (
                        header::CONTENT_DISPOSITION,
                        format!("attachment; filename=\"{}\"", safe),
                    ),
                ],
                bytes,
            )
                .into_response()
        }
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

// --- Workspace Full-Text Search (Grep) ---

#[derive(Deserialize)]
struct GrepQuery {
    q: String,
    #[serde(default)]
    case: bool,
    #[serde(default)]
    ext: Option<String>,
    #[serde(default = "default_grep_limit")]
    limit: usize,
}

fn default_grep_limit() -> usize {
    200
}

async fn api_grep_files(
    State(st): State<Arc<AppState>>,
    Query(q): Query<GrepQuery>,
) -> Response {
    let limit = q.limit.clamp(1, 500);
    let matches = st
        .files
        .grep_workspace(&q.q, q.case, q.ext.as_deref(), limit);
    Json(json!({ "query": q.q, "count": matches.len(), "matches": matches })).into_response()
}

// --- SQLite Database Browser API ---

#[derive(Deserialize)]
struct SqliteSchemaQuery {
    path: String,
}

async fn api_sqlite_schema(
    State(st): State<Arc<AppState>>,
    Query(q): Query<SqliteSchemaQuery>,
) -> Response {
    let abs = match st.files.resolve_existing(&q.path) {
        Ok(p) => p,
        Err(e) => return api_err(StatusCode::NOT_FOUND, e),
    };
    let rel = abs
        .strip_prefix(st.files.root())
        .unwrap_or(&abs)
        .to_string_lossy()
        .replace('\\', "/");
    match crate::sqlite_reader::inspect_schema(&abs, &rel) {
        Ok(res) => Json(res).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(Deserialize)]
struct SqliteQueryBody {
    path: String,
    sql: String,
    #[serde(default = "default_sql_limit")]
    limit: usize,
    #[serde(default)]
    allow_write: bool,
}

fn default_sql_limit() -> usize {
    500
}

async fn api_sqlite_query(
    State(st): State<Arc<AppState>>,
    Json(body): Json<SqliteQueryBody>,
) -> Response {
    let abs = match st.files.resolve_existing(&body.path) {
        Ok(p) => p,
        Err(e) => return api_err(StatusCode::NOT_FOUND, e),
    };
    let rel = abs
        .strip_prefix(st.files.root())
        .unwrap_or(&abs)
        .to_string_lossy()
        .replace('\\', "/");
    match crate::sqlite_reader::run_query(&abs, &rel, &body.sql, body.limit, !body.allow_write) {
        Ok(res) => Json(res).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn api_sqlite_cluster(
    State(st): State<Arc<AppState>>,
    Json(body): Json<crate::cluster::SqliteClusterRequest>,
) -> Response {
    let abs = match st.files.resolve_existing(&body.path) {
        Ok(p) => p,
        Err(e) => return api_err(StatusCode::NOT_FOUND, e),
    };
    let rel = abs
        .strip_prefix(st.files.root())
        .unwrap_or(&abs)
        .to_string_lossy()
        .replace('\\', "/");
    match crate::sqlite_reader::compute_cluster(&abs, &rel, &body) {
        Ok(res) => Json(res).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

// --- Encrypted Secrets Vault API ---

async fn api_list_secrets(State(st): State<Arc<AppState>>) -> Response {
    Json(json!({ "secrets": st.secrets.list() })).into_response()
}

#[derive(Deserialize)]
struct SetSecretBody {
    value: String,
    #[serde(default)]
    description: Option<String>,
}

async fn api_set_secret(
    State(st): State<Arc<AppState>>,
    Path(name): Path<String>,
    Json(body): Json<SetSecretBody>,
) -> Response {
    match st.secrets.set(&name, body.value.clone(), body.description) {
        Ok(meta) => {
            let mut vars = BTreeMap::new();
            vars.insert(meta.name.clone(), Some(body.value));
            st.kernels.broadcast_env_update(vars).await;
            Json(json!({ "ok": true, "secret": meta })).into_response()
        }
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn api_delete_secret(
    State(st): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Response {
    match st.secrets.delete(&name) {
        Ok(removed) => {
            let mut vars = BTreeMap::new();
            vars.insert(name.trim().to_string(), None);
            st.kernels.broadcast_env_update(vars).await;
            Json(json!({ "ok": true, "removed": removed })).into_response()
        }
        Err(e) => api_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

// --- Scheduled Jobs & Webhook Triggers API ---

async fn api_list_schedules(State(st): State<Arc<AppState>>) -> Response {
    Json(json!({ "schedules": st.scheduler.list().await })).into_response()
}

async fn api_create_schedule(
    State(st): State<Arc<AppState>>,
    Json(req): Json<CreateScheduleRequest>,
) -> Response {
    match st.scheduler.create(req).await {
        Ok(job) => Json(json!({ "ok": true, "schedule": job })).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn api_update_schedule(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<UpdateScheduleRequest>,
) -> Response {
    match st.scheduler.update(&id, req).await {
        Ok(job) => Json(json!({ "ok": true, "schedule": job })).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn api_delete_schedule(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    match st.scheduler.delete(&id).await {
        Ok(removed) => Json(json!({ "ok": true, "removed": removed })).into_response(),
        Err(e) => api_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn api_toggle_schedule(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    match st.scheduler.toggle(&id).await {
        Ok(job) => Json(json!({ "ok": true, "schedule": job })).into_response(),
        Err(e) => api_err(StatusCode::NOT_FOUND, e),
    }
}

async fn api_run_schedule(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    match st
        .scheduler
        .run_job_by_id(&id, "manual", None, &st.files, &st.kernels, &st.languages)
        .await
    {
        Ok(res) => Json(res).into_response(),
        Err(e) => api_err(StatusCode::NOT_FOUND, e),
    }
}

#[derive(Deserialize, Default)]
struct WebhookBody {
    #[serde(default)]
    params: BTreeMap<String, TaggedValue>,
}

async fn api_trigger_webhook(
    State(st): State<Arc<AppState>>,
    Path(token): Path<String>,
    raw_body: String,
) -> Response {
    let Some(job) = st.scheduler.find_by_webhook(&token).await else {
        return api_err(StatusCode::NOT_FOUND, "Unknown webhook token");
    };
    let extra = if raw_body.trim().is_empty() {
        None
    } else {
        match serde_json::from_str::<WebhookBody>(&raw_body) {
            Ok(b) if !b.params.is_empty() => Some(b.params),
            _ => None,
        }
    };
    let res = st
        .scheduler
        .execute_job(job, "webhook", extra, &st.files, &st.kernels, &st.languages)
        .await;
    let status = if res.ok {
        StatusCode::OK
    } else {
        StatusCode::UNPROCESSABLE_ENTITY
    };
    (status, Json(res)).into_response()
}

// --- Background Jobs API ---

async fn api_list_jobs(State(st): State<Arc<AppState>>) -> Response {
    let jobs = st.jobs.list().await;
    let running = jobs.iter().filter(|j| j.status == "running").count();
    Json(json!({ "jobs": jobs, "running": running, "total": jobs.len() })).into_response()
}

async fn api_start_job(
    State(st): State<Arc<AppState>>,
    Json(req): Json<StartJobRequest>,
) -> Response {
    match st
        .jobs
        .start(
            req,
            st.files.clone(),
            st.kernels.clone(),
            st.languages.clone(),
            st.secrets.clone(),
        )
        .await
    {
        Ok(job) => Json(json!({ "ok": true, "job": job })).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn api_get_job(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    match st.jobs.get(&id).await {
        Some(job) => Json(json!({ "ok": true, "job": job })).into_response(),
        None => api_err(StatusCode::NOT_FOUND, format!("Background job '{}' not found", id)),
    }
}

#[derive(Deserialize, Default)]
struct WaitJobBody {
    #[serde(default)]
    timeout_ms: Option<u64>,
}

async fn api_wait_job(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    raw_body: String,
) -> Response {
    let body: WaitJobBody = if raw_body.trim().is_empty() {
        WaitJobBody::default()
    } else {
        serde_json::from_str(&raw_body).unwrap_or_default()
    };
    match st.jobs.wait(&id, body.timeout_ms).await {
        Ok(job) => Json(json!({ "ok": true, "job": job })).into_response(),
        Err(e) => api_err(StatusCode::NOT_FOUND, e),
    }
}

async fn api_stop_job(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    match st.jobs.stop(&id).await {
        Ok(job) => Json(json!({ "ok": true, "job": job })).into_response(),
        Err(e) => api_err(StatusCode::NOT_FOUND, e),
    }
}

async fn api_delete_job(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let removed = st.jobs.remove(&id).await;
    Json(json!({ "ok": true, "removed": removed })).into_response()
}

async fn api_clear_jobs(State(st): State<Arc<AppState>>) -> Response {
    let cleared = st.jobs.clear_finished().await;
    Json(json!({ "ok": true, "cleared": cleared })).into_response()
}

// --- Interactive Minilang Debugger API ---

async fn api_debug_list(State(st): State<Arc<AppState>>) -> Response {
    let sessions = st.debugger.list().await;
    let active = sessions
        .iter()
        .filter(|s| s.status == "paused" || s.status == "running")
        .count();
    Json(json!({
        "sessions": sessions,
        "active": active,
        "total": sessions.len(),
    }))
    .into_response()
}

async fn api_debug_start(
    State(st): State<Arc<AppState>>,
    Json(req): Json<StartDebugRequest>,
) -> Response {
    match st.debugger.start(req, &st.files).await {
        Ok(session) => Json(json!({ "ok": true, "session": session })).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn api_debug_get(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    match st.debugger.get(&id).await {
        Some(session) => Json(json!({ "ok": true, "session": session })).into_response(),
        None => api_err(StatusCode::NOT_FOUND, format!("Debug session '{}' not found", id)),
    }
}

#[derive(Deserialize)]
struct DebugStepBody {
    action: String,
}

async fn api_debug_step(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<DebugStepBody>,
) -> Response {
    match st.debugger.step(&id, &body.action).await {
        Ok(session) => Json(json!({ "ok": true, "session": session })).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(Deserialize)]
struct DebugBreakpointsBody {
    source: String,
    #[serde(default)]
    lines: Vec<u32>,
}

async fn api_debug_breakpoints(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<DebugBreakpointsBody>,
) -> Response {
    match st.debugger.set_breakpoints(&id, body.source, body.lines).await {
        Ok(session) => Json(json!({ "ok": true, "session": session })).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(Deserialize)]
struct DebugConfigBody {
    break_on_error: bool,
}

async fn api_debug_config(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<DebugConfigBody>,
) -> Response {
    match st.debugger.set_config(&id, body.break_on_error).await {
        Ok(session) => Json(json!({ "ok": true, "session": session })).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(Deserialize, Default)]
struct DebugLocalsQuery {
    #[serde(default)]
    depth: usize,
}

async fn api_debug_locals(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<DebugLocalsQuery>,
) -> Response {
    match st.debugger.locals(&id, q.depth).await {
        Ok(locals) => Json(json!({ "ok": true, "depth": q.depth, "locals": locals })).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(Deserialize)]
struct DebugEvalBody {
    expr: String,
    #[serde(default)]
    depth: usize,
}

async fn api_debug_eval(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<DebugEvalBody>,
) -> Response {
    match st.debugger.eval_in_frame(&id, body.expr, body.depth).await {
        Ok(res) => Json(res).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn api_debug_terminate(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    match st.debugger.terminate(&id).await {
        Ok(session) => Json(json!({ "ok": true, "session": session })).into_response(),
        Err(e) => api_err(StatusCode::NOT_FOUND, e),
    }
}

// --- Background Services & Cross-UI Messaging API ---

async fn api_list_services(State(st): State<Arc<AppState>>) -> Response {
    let services = st.services.list().await;
    let running = services.iter().filter(|s| s.status == "running").count();
    Json(json!({
        "services": services,
        "running": running,
        "total": services.len(),
    }))
    .into_response()
}

async fn api_start_service(
    State(st): State<Arc<AppState>>,
    Json(req): Json<StartServiceRequest>,
) -> Response {
    match st
        .services
        .start(req, &st.files, st.secrets.clone())
        .await
    {
        Ok(service) => Json(json!({ "ok": true, "service": service })).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn api_get_service(
    State(st): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Response {
    match st.services.get(&name).await {
        Some(service) => Json(json!({ "ok": true, "service": service })).into_response(),
        None => api_err(StatusCode::NOT_FOUND, format!("Service '{}' not found", name)),
    }
}

async fn api_stop_service(
    State(st): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Response {
    match st.services.stop(&name).await {
        Ok(service) => Json(json!({ "ok": true, "service": service })).into_response(),
        Err(e) => api_err(StatusCode::NOT_FOUND, e),
    }
}

async fn api_restart_service(
    State(st): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Response {
    match st
        .services
        .restart(&name, &st.files, st.secrets.clone())
        .await
    {
        Ok(service) => Json(json!({ "ok": true, "service": service })).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn api_delete_service(
    State(st): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Response {
    match st.services.remove(&name).await {
        Ok(removed) => Json(json!({ "ok": true, "removed": removed })).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn api_service_send(
    State(st): State<Arc<AppState>>,
    Path(name): Path<String>,
    Json(req): Json<SendMessageRequest>,
) -> Response {
    match st.services.send_to_service(&name, req).await {
        Ok(msg) => Json(json!({ "ok": true, "message": msg })).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn api_service_call(
    State(st): State<Arc<AppState>>,
    Path(name): Path<String>,
    Json(req): Json<CallServiceRequest>,
) -> Response {
    match st.services.call_service(&name, req).await {
        Ok((reply, reply_plain)) => Json(json!({
            "ok": true,
            "reply": reply,
            "reply_plain": reply_plain,
        }))
        .into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, e),
    }
}

async fn api_service_recv(
    State(st): State<Arc<AppState>>,
    Path(name): Path<String>,
    raw_body: String,
) -> Response {
    let body: RecvMessageRequest = if raw_body.trim().is_empty() {
        RecvMessageRequest::default()
    } else {
        serde_json::from_str(&raw_body).unwrap_or_default()
    };
    let timeout_ms = body.timeout_ms.unwrap_or(25_000);
    match st.services.recv_for_service(&name, timeout_ms).await {
        Ok((msg, closed)) => Json(json!({
            "ok": true,
            "message": msg,
            "closed": closed,
        }))
        .into_response(),
        Err(e) => api_err(StatusCode::NOT_FOUND, e),
    }
}

async fn api_service_emit(
    State(st): State<Arc<AppState>>,
    Path(name): Path<String>,
    Json(req): Json<EmitMessageRequest>,
) -> Response {
    match st.services.emit_from_service(&name, req).await {
        Ok((delivered, msg)) => Json(json!({
            "ok": true,
            "delivered": delivered,
            "message": msg,
        }))
        .into_response(),
        Err(e) => api_err(StatusCode::NOT_FOUND, e),
    }
}

async fn api_service_reply(
    State(st): State<Arc<AppState>>,
    Path(name): Path<String>,
    Json(req): Json<ReplyMessageRequest>,
) -> Response {
    match st.services.reply_from_service(&name, req).await {
        Ok(delivered) => Json(json!({ "ok": true, "delivered": delivered })).into_response(),
        Err(e) => api_err(StatusCode::NOT_FOUND, e),
    }
}

#[derive(Deserialize, Default)]
struct ServiceEventsQuery {
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    topic: Option<String>,
}

async fn api_service_events(
    State(st): State<Arc<AppState>>,
    Path(name): Path<String>,
    Query(q): Query<ServiceEventsQuery>,
) -> Response {
    let mut sub = match st.services.subscribe(&name, q.client_id).await {
        Ok(s) => s,
        Err(e) => return api_err(StatusCode::NOT_FOUND, e),
    };

    let topic_filter = q.topic.filter(|t| !t.trim().is_empty() && t != "*");
    let (sse_tx, sse_rx) = tokio::sync::mpsc::unbounded_channel::<Result<Event, Infallible>>();

    let init_payload = json!({
        "client_id": sub.client_id,
        "service": sub.service_name,
    });
    let _ = sse_tx.send(Ok(Event::default()
        .event("connected")
        .data(init_payload.to_string())));

    tokio::spawn(async move {
        while let Some(msg) = sub.recv().await {
            if let Some(ref wanted) = topic_filter {
                if &msg.topic != wanted {
                    continue;
                }
            }
            let payload = serde_json::to_string(&msg).unwrap_or_else(|_| "{}".to_string());
            if sse_tx
                .send(Ok(Event::default().event("message").data(payload)))
                .is_err()
            {
                break;
            }
        }
        // `sub` drops here and automatically unsubscribes `client_id`
    });

    Sse::new(SseReceiverStream { rx: sse_rx })
        .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)))
        .into_response()
}

// --- Service Message Bus Inspector API (Feature #7) ---

#[derive(Deserialize, Default)]
struct BusHistoryQuery {
    #[serde(default)]
    service: Option<String>,
    #[serde(default)]
    topic: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

async fn api_services_bus_history(
    State(st): State<Arc<AppState>>,
    Query(q): Query<BusHistoryQuery>,
) -> Response {
    let events = st
        .services
        .bus_history(q.service.as_deref(), q.topic.as_deref(), q.limit.unwrap_or(150))
        .await;
    Json(json!({ "ok": true, "events": events })).into_response()
}

async fn api_services_bus_clear(State(st): State<Arc<AppState>>) -> Response {
    let cleared = st.services.clear_bus_history().await;
    Json(json!({ "ok": true, "cleared": cleared })).into_response()
}

async fn api_services_bus_stream(
    State(st): State<Arc<AppState>>,
    Query(q): Query<BusHistoryQuery>,
) -> Response {
    let mut rx = st.services.subscribe_bus_tap().await;
    let svc_filter = q.service.filter(|s| !s.trim().is_empty() && s != "*");
    let topic_filter = q.topic.filter(|t| !t.trim().is_empty() && t != "*");
    let (sse_tx, sse_rx) = tokio::sync::mpsc::unbounded_channel::<Result<Event, Infallible>>();

    let _ = sse_tx.send(Ok(Event::default()
        .event("connected")
        .data(json!({ "ok": true }).to_string())));

    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            if let Some(ref sf) = svc_filter {
                if &ev.service != sf {
                    continue;
                }
            }
            if let Some(ref tf) = topic_filter {
                if &ev.topic != tf {
                    continue;
                }
            }
            let payload = serde_json::to_string(&ev).unwrap_or_else(|_| "{}".to_string());
            if sse_tx
                .send(Ok(Event::default().event("bus").data(payload)))
                .is_err()
            {
                break;
            }
        }
    });

    Sse::new(SseReceiverStream { rx: sse_rx })
        .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)))
        .into_response()
}

// --- Notebook Checkpoints API (Feature #9) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
struct NotebookCheckpointRecord {
    id: String,
    path: String,
    label: String,
    created_at: String,
    cell_count: usize,
    doc: NotebookDocument,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct NotebookCheckpointMeta {
    id: String,
    path: String,
    label: String,
    created_at: String,
    cell_count: usize,
    size_bytes: u64,
}

fn notebook_checkpoint_dir(files: &FileStore, rel_path: &str) -> Result<PathBuf, String> {
    let clean = rel_path.trim().trim_start_matches('/').replace('\\', "/");
    if clean.is_empty() || clean.contains("..") {
        return Err("Invalid notebook path for checkpoints".to_string());
    }
    // FNV-1a 64-bit hash for stable folder name under .mlnb_checkpoints/
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in clean.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let dir = files
        .root()
        .join(".mlnb_checkpoints")
        .join(format!("{:016x}", hash));
    Ok(dir)
}

#[derive(Deserialize)]
struct CheckpointPathQuery {
    path: String,
}

#[derive(Deserialize)]
struct CreateCheckpointBody {
    path: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    doc: Option<NotebookDocument>,
}

async fn api_list_checkpoints(
    State(st): State<Arc<AppState>>,
    Query(q): Query<CheckpointPathQuery>,
) -> Response {
    let dir = match notebook_checkpoint_dir(&st.files, &q.path) {
        Ok(d) => d,
        Err(e) => return api_err(StatusCode::BAD_REQUEST, e),
    };
    let mut items: Vec<NotebookCheckpointMeta> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
            if let Ok(raw) = std::fs::read_to_string(&p) {
                if let Ok(rec) = serde_json::from_str::<NotebookCheckpointRecord>(&raw) {
                    items.push(NotebookCheckpointMeta {
                        id: rec.id,
                        path: rec.path,
                        label: rec.label,
                        created_at: rec.created_at,
                        cell_count: rec.cell_count,
                        size_bytes,
                    });
                }
            }
        }
    }
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
    Json(json!({ "ok": true, "checkpoints": items })).into_response()
}

async fn api_create_checkpoint(
    State(st): State<Arc<AppState>>,
    Json(body): Json<CreateCheckpointBody>,
) -> Response {
    let dir = match notebook_checkpoint_dir(&st.files, &body.path) {
        Ok(d) => d,
        Err(e) => return api_err(StatusCode::BAD_REQUEST, e),
    };
    let doc = match body.doc {
        Some(d) => d,
        None => match st.files.read_file(&body.path) {
            Ok(raw) => match serde_json::from_str::<NotebookDocument>(&raw.content) {
                Ok(d) => d,
                Err(e) => return api_err(StatusCode::BAD_REQUEST, format!("Invalid notebook JSON: {}", e)),
            },
            Err(e) => return api_err(StatusCode::NOT_FOUND, e),
        },
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return api_err(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to create checkpoint dir: {}", e));
    }
    let now = chrono::Utc::now();
    let short_id = uuid::Uuid::new_v4().to_string();
    let id = format!(
        "{}-{}",
        now.format("%Y%m%dT%H%M%S%3fZ"),
        &short_id[..8]
    );
    let label = body
        .label
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Checkpoint".to_string());
    let rec = NotebookCheckpointRecord {
        id: id.clone(),
        path: body.path.clone(),
        label: label.clone(),
        created_at: now.to_rfc3339(),
        cell_count: doc.cells.len(),
        doc,
    };
    let encoded = match serde_json::to_string_pretty(&rec) {
        Ok(s) => s,
        Err(e) => return api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let file_path = dir.join(format!("{}.json", id));
    if let Err(e) = std::fs::write(&file_path, &encoded) {
        return api_err(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to write checkpoint: {}", e));
    }
    // Prune older checkpoints beyond 30 per notebook
    if let Ok(entries) = std::fs::read_dir(&dir) {
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
            .collect();
        if files.len() > 30 {
            files.sort();
            let to_remove = files.len() - 30;
            for old in files.into_iter().take(to_remove) {
                let _ = std::fs::remove_file(old);
            }
        }
    }
    let meta = NotebookCheckpointMeta {
        id: rec.id,
        path: rec.path,
        label: rec.label,
        created_at: rec.created_at,
        cell_count: rec.cell_count,
        size_bytes: encoded.len() as u64,
    };
    Json(json!({ "ok": true, "checkpoint": meta })).into_response()
}

async fn api_get_checkpoint(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<CheckpointPathQuery>,
) -> Response {
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return api_err(StatusCode::BAD_REQUEST, "Invalid checkpoint id");
    }
    let dir = match notebook_checkpoint_dir(&st.files, &q.path) {
        Ok(d) => d,
        Err(e) => return api_err(StatusCode::BAD_REQUEST, e),
    };
    let p = dir.join(format!("{}.json", id));
    match std::fs::read_to_string(&p) {
        Ok(raw) => match serde_json::from_str::<NotebookCheckpointRecord>(&raw) {
            Ok(rec) => Json(json!({ "ok": true, "checkpoint": rec })).into_response(),
            Err(e) => api_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        },
        Err(_) => api_err(StatusCode::NOT_FOUND, format!("Checkpoint '{}' not found", id)),
    }
}

async fn api_delete_checkpoint(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<CheckpointPathQuery>,
) -> Response {
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return api_err(StatusCode::BAD_REQUEST, "Invalid checkpoint id");
    }
    let dir = match notebook_checkpoint_dir(&st.files, &q.path) {
        Ok(d) => d,
        Err(e) => return api_err(StatusCode::BAD_REQUEST, e),
    };
    let p = dir.join(format!("{}.json", id));
    let removed = std::fs::remove_file(&p).is_ok();
    Json(json!({ "ok": true, "removed": removed })).into_response()
}
