pub mod minilang;
pub mod rust_lang;

use crate::kernel_mgr::InvokeExecError;
use crate::kernel_proc::KernelResponse;
use crate::tagged::TaggedValue;
use serde::Serialize;
use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use tokio::process::Command;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Serialize)]
pub struct LanguageInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub extensions: Vec<String>,
    pub comment_prefix: String,
    pub supports_notebook: bool,
    pub supports_invoke: bool,
    pub supports_ui: bool,
}

pub struct InvokeScriptRequest {
    pub code: String,
    pub source: String,
    pub cwd: PathBuf,
    pub params: BTreeMap<String, TaggedValue>,
    pub args: Vec<TaggedValue>,
    pub function: Option<String>,
    pub timeout_ms: u64,
    pub env: BTreeMap<String, String>,
}

/// Extensible backend trait for plugging additional languages into the notebook,
/// `/invoke` script runner, and file browser.
///
/// To add a new language:
/// 1. Implement `LanguageBackend` in `src/lang/<your_lang>.rs`.
/// 2. Register it in `LanguageRegistry::with_defaults()`.
pub trait LanguageBackend: Send + Sync {
    fn info(&self) -> LanguageInfo;

    /// Build the command to spawn an isolated interactive notebook kernel process
    /// speaking the newline-delimited JSON `KernelRequest`/`KernelResponse` protocol.
    fn kernel_command(&self, cwd: &Path) -> Result<Command, String>;

    /// Execute a script file with tagged JSON parameters and return a `KernelResponse::InvokeResult`.
    fn invoke_script(&self, req: InvokeScriptRequest) -> BoxFuture<'_, Result<KernelResponse, InvokeExecError>>;
}

pub struct LanguageRegistry {
    backends: Vec<Arc<dyn LanguageBackend>>,
}

impl LanguageRegistry {
    pub fn new() -> Self {
        Self {
            backends: Vec::new(),
        }
    }

    pub fn with_defaults() -> Self {
        let mut reg = Self::new();
        reg.register(Arc::new(minilang::MinilangBackend::new()));
        reg.register(Arc::new(rust_lang::RustBackend::new()));
        reg
    }

    pub fn register(&mut self, backend: Arc<dyn LanguageBackend>) {
        self.backends.push(backend);
    }

    pub fn list_info(&self) -> Vec<LanguageInfo> {
        self.backends.iter().map(|b| b.info()).collect()
    }

    pub fn by_id(&self, id: &str) -> Option<Arc<dyn LanguageBackend>> {
        let needle = id.trim().to_lowercase();
        self.backends
            .iter()
            .find(|b| b.info().id == needle)
            .cloned()
    }

    pub fn by_extension(&self, ext: &str) -> Option<Arc<dyn LanguageBackend>> {
        let needle = ext.trim().trim_start_matches('.').to_lowercase();
        self.backends
            .iter()
            .find(|b| b.info().extensions.iter().any(|e| e == &needle))
            .cloned()
    }

    pub fn default_backend(&self) -> Arc<dyn LanguageBackend> {
        self.backends
            .first()
            .expect("at least one language backend must be registered")
            .clone()
    }

    pub fn all_script_extensions(&self) -> Vec<String> {
        let mut exts = Vec::new();
        for b in &self.backends {
            let info = b.info();
            if info.supports_invoke {
                exts.extend(info.extensions);
            }
        }
        exts
    }
}
