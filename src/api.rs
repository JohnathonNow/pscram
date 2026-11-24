use crate::auth::{self, AuthManager, AuthenticatedUser};
use crate::files::FileStore;
use crate::kernel_mgr::{InvokeExecError, KernelManager};
use crate::kernel_proc::KernelResponse;
use crate::lang::LanguageRegistry;
use crate::notebook::NotebookDocument;
use crate::tagged::TaggedValue;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{delete, get, post};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

const EMBED_INDEX_HTML: &str = include_str!("../web/index.html");
const EMBED_STYLE_CSS: &str = include_str!("../web/style.css");
const EMBED_APP_JS: &str = include_str!("../web/app.js");
const EMBED_MINIJS_VM_JS: &str = include_str!("../web/minijs_vm.js");

pub struct AppState {
    pub files: FileStore,
    pub kernels: KernelManager,
    pub languages: Arc<LanguageRegistry>,
    pub auth: Arc<AuthManager>,
    pub web_dir: Option<PathBuf>,
}

pub fn build_router(state: Arc<AppState>) -> Router {
    let public_routes = Router::new()
        .route("/", get(serve_index))
        .route("/style.css", get(serve_css))
        .route("/app.js", get(serve_js))
        .route("/minijs_vm.js", get(serve_minijs_vm))
        // Authentication & token lifecycle endpoints (always accessible)
        .route("/api/auth/status", get(api_auth_status))
        .route("/api/auth/login", post(api_auth_login))
        .route("/api/auth/refresh", post(api_auth_refresh))
        .route("/api/auth/logout", post(api_auth_logout));

    let protected_routes = Router::new()
        .route("/ui/*script", get(serve_standalone_ui))
        .route("/api/auth/me", get(api_auth_me))
        .route("/api/auth/logout-all", post(api_auth_logout_all))
        .route("/api/info", get(api_info))
        .route("/api/languages", get(api_languages))
        // File browser API
        .route("/api/files", get(api_list_files))
        .route("/api/files/search", get(api_search_files))
        .route("/api/file", get(api_read_file).put(api_write_file).delete(api_delete_file))
        .route("/api/file/raw", get(api_read_file_raw))
        .route("/api/file/new", post(api_create_file))
        .route("/api/file/rename", post(api_rename_file))
        .route("/api/notebook/from-mini", post(api_notebook_from_script))
        .route("/api/notebook/to-mini", post(api_notebook_to_script))
        .route("/api/notebook/from-script", post(api_notebook_from_script))
        .route("/api/notebook/to-script", post(api_notebook_to_script))
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
        .route("/api/kernels/:id/interrupt", post(api_kernel_interrupt))
        .route("/api/kernels/:id/restart", post(api_kernel_restart))
        .route("/api/kernels/:id/inspect", get(api_kernel_inspect))
        .route("/api/kernels/:id/complete", post(api_kernel_complete))
        .route("/api/kernels/:id/chdir", post(api_kernel_chdir))
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

async fn serve_js(State(st): State<Arc<AppState>>) -> Response {
    let body = load_asset(&st.web_dir, "app.js", EMBED_APP_JS);
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        body,
    )
        .into_response()
}

async fn serve_minijs_vm(State(st): State<Arc<AppState>>) -> Response {
    let body = load_asset(&st.web_dir, "minijs_vm.js", EMBED_MINIJS_VM_JS);
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        body,
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
  <script src="/minijs_vm.js"></script>
  <script>
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
      for (const b of bundles) window.MinijsUI.mount(mount, b);
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
}

async fn api_kernel_execute(
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
    match session.execute(body.code, body.source).await {
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
