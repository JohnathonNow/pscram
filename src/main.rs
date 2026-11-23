mod api;
mod files;
mod kernel_mgr;
mod kernel_proc;
mod lang;
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
        let languages = Arc::new(lang::LanguageRegistry::with_defaults());
        let kernels = kernel_mgr::KernelManager::new(root_canon.clone(), languages.clone());

        let state = Arc::new(api::AppState {
            files,
            kernels,
            languages,
            web_dir: cli.web_dir,
        });

        let app = api::build_router(state);
        let addr: SocketAddr = format!("{}:{}", cli.host, cli.port)
            .parse()
            .expect("invalid host:port");

        println!("Minilang Notebook Server v{}", env!("CARGO_PKG_VERSION"));
        println!("  Workspace: {}", root_canon.display());
        println!("  URL:       http://{}", addr);

        axum::Server::bind(&addr)
            .serve(app.into_make_service())
            .await
            .expect("server error");
    });
}
