mod api;
mod auth;
mod files;
mod kernel_mgr;
mod kernel_proc;
mod lang;
mod log_reader;
mod notebook;
mod rust_kernel_proc;
mod tagged;

use clap::Parser;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Parser, Debug)]
#[command(name = "minilang-notebook", version, about = "Polyglot Jupyter-like notebook & script webapp (Minilang + Rust)")]
struct Cli {
    /// Internal mode: run as an isolated REPL kernel worker over stdio
    #[arg(long, hide = true)]
    kernel: bool,

    /// Internal mode: language id for `--kernel` (default: minilang)
    #[arg(long, hide = true, default_value = "minilang")]
    lang: String,

    /// Host interface to bind to
    #[arg(long, default_value = "127.0.0.1")]
    host: String,

    /// Port to listen on
    #[arg(short, long, default_value_t = 8888)]
    port: u16,

    /// Root workspace directory exposed in the file browser sidebar
    #[arg(short, long, default_value = ".")]
    root: PathBuf,

    /// Optional directory to serve frontend assets from disk (for live editing)
    #[arg(long)]
    web_dir: Option<PathBuf>,

    /// Require local machine login (PAM) + refreshable Bearer tokens for API, /invoke, and /ui
    #[arg(long, default_value_t = false)]
    require_login: bool,

    /// Require authenticated local users to belong to this Unix group (implies --require-login)
    #[arg(long, value_name = "GROUP")]
    require_group: Option<String>,

    /// PAM service name used to authenticate local users (from /etc/pam.d/<service>)
    #[arg(long, default_value = "login")]
    pam_service: String,

    /// Access token lifetime in seconds (default: 900 = 15 minutes)
    #[arg(long, default_value_t = 900)]
    access_token_ttl: i64,

    /// Refresh token lifetime in seconds (default: 604800 = 7 days)
    #[arg(long, default_value_t = 604_800)]
    refresh_token_ttl: i64,

    /// HMAC signing secret for access tokens (or set MINILANG_AUTH_SECRET env var; random if omitted)
    #[arg(long)]
    auth_secret: Option<String>,
}

fn main() {
    let cli = Cli::parse();

    if cli.kernel {
        let res = match cli.lang.as_str() {
            "rust" => rust_kernel_proc::run_rust_kernel_process(),
            _ => kernel_proc::run_kernel_process(),
        };
        if let Err(e) = res {
            eprintln!("{} kernel error: {}", cli.lang, e);
            std::process::exit(1);
        }
        return;
    }

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime");

    rt.block_on(async move {
        let files = files::FileStore::new(cli.root.clone()).unwrap_or_else(|e| {
            eprintln!("Invalid root directory '{}': {}", cli.root.display(), e);
            std::process::exit(1);
        });
        let root_canon = files.root().to_path_buf();
        std::env::set_var("MINILANG_WORKSPACE_ROOT", &root_canon);
        let languages = Arc::new(lang::LanguageRegistry::with_defaults());
        let kernels = kernel_mgr::KernelManager::new(root_canon.clone(), languages.clone());
        let auth_config = auth::AuthConfig::new(
            cli.require_login,
            cli.require_group.clone(),
            cli.pam_service.clone(),
            cli.access_token_ttl,
            cli.refresh_token_ttl,
            cli.auth_secret.clone(),
        )
        .unwrap_or_else(|e| {
            eprintln!("Failed to initialize auth config: {}", e);
            std::process::exit(1);
        });
        let auth = Arc::new(auth::AuthManager::new(auth_config));

        let state = Arc::new(api::AppState {
            files,
            kernels,
            languages,
            auth: auth.clone(),
            web_dir: cli.web_dir,
        });

        let app = api::build_router(state);
        let addr: SocketAddr = format!("{}:{}", cli.host, cli.port)
            .parse()
            .expect("invalid host:port");

        println!("Minilang Notebook Server v{}", env!("CARGO_PKG_VERSION"));
        println!("  Workspace: {}", root_canon.display());
        println!("  URL:       http://{}", addr);
        if auth.is_enabled() {
            println!(
                "  Auth:      ENABLED (PAM service '{}', group: {}, access TTL: {}s, refresh TTL: {}s)",
                cli.pam_service,
                auth.required_group().unwrap_or("<any local user>"),
                auth.access_token_ttl(),
                auth.refresh_token_ttl()
            );
        } else {
            println!("  Auth:      disabled (pass --require-login or --require-group <GROUP> to enable)");
        }

        axum::Server::bind(&addr)
            .serve(app.into_make_service())
            .await
            .expect("server error");
    });
}
