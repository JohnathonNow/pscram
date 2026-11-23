use crate::kernel_mgr::InvokeExecError;
use crate::kernel_proc::{KernelRequest, KernelResponse};
use crate::lang::{BoxFuture, InvokeScriptRequest, LanguageBackend, LanguageInfo};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

pub struct MinilangBackend;

impl MinilangBackend {
    pub fn new() -> Self {
        Self
    }
}

impl LanguageBackend for MinilangBackend {
    fn info(&self) -> LanguageInfo {
        LanguageInfo {
            id: "minilang".to_string(),
            name: "Minilang".to_string(),
            version: "2.17.0".to_string(),
            extensions: vec!["mini".to_string()],
            comment_prefix: ":>".to_string(),
            supports_notebook: true,
            supports_invoke: true,
            supports_ui: true,
        }
    }

    fn kernel_command(&self, cwd: &Path) -> Result<Command, String> {
        let exe = std::env::current_exe()
            .map_err(|e| format!("failed to locate executable: {}", e))?;
        let mut cmd = Command::new(exe);
        cmd.arg("--kernel")
            .arg("--lang")
            .arg("minilang")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if cwd.exists() {
            cmd.current_dir(cwd);
        }
        Ok(cmd)
    }

    fn invoke_script(
        &self,
        req: InvokeScriptRequest,
    ) -> BoxFuture<'_, Result<KernelResponse, InvokeExecError>> {
        Box::pin(async move {
            let mut cmd = self
                .kernel_command(&req.cwd)
                .map_err(InvokeExecError::Internal)?;

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

            let kreq = KernelRequest::Invoke {
                code: req.code,
                source: req.source,
                params: req.params,
                args: req.args,
                function: req.function,
            };
            let mut payload = serde_json::to_string(&kreq)
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

            let result =
                tokio::time::timeout(Duration::from_millis(req.timeout_ms), run_future).await;
            let _ = child.kill().await;
            let _ = child.wait().await;

            match result {
                Ok(inner) => inner,
                Err(_) => Err(InvokeExecError::Timeout(req.timeout_ms)),
            }
        })
    }
}
