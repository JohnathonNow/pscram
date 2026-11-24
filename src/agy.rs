use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};

#[derive(Debug, Clone, Serialize)]
pub struct AgyStatus {
    pub available: bool,
    pub bin: Option<String>,
    pub default_model: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AgyAssistRequest {
    pub prompt: String,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default = "default_kind")]
    pub kind: String, // "cell" | "file"
    #[serde(default = "default_lang")]
    pub language: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub selection: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub stdout: Option<String>,
    #[serde(default)]
    pub surrounding_cells: Vec<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

fn default_kind() -> String {
    "cell".to_string()
}

fn default_lang() -> String {
    "minilang".to_string()
}

#[derive(Debug, Serialize)]
pub struct AgyAssistResponse {
    pub ok: bool,
    pub response: String,
    pub suggested_code: Option<String>,
    pub suggested_lang: Option<String>,
    pub conversation_id: Option<String>,
    pub duration_ms: f64,
}

pub struct AgyRunner {
    bin_path: Option<PathBuf>,
    default_model: Option<String>,
    timeout_secs: u64,
    workspace_root: PathBuf,
    inflight: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
}

impl AgyRunner {
    pub fn new(
        bin_override: Option<PathBuf>,
        default_model: Option<String>,
        timeout_secs: u64,
        workspace_root: PathBuf,
    ) -> Self {
        let bin_path = resolve_agy_binary(bin_override);
        Self {
            bin_path,
            default_model,
            timeout_secs: timeout_secs.clamp(10, 600),
            workspace_root,
            inflight: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn status(&self) -> AgyStatus {
        AgyStatus {
            available: self.bin_path.is_some(),
            bin: self.bin_path.as_ref().map(|p| p.display().to_string()),
            default_model: self.default_model.clone(),
        }
    }

    pub async fn cancel(&self, request_id: &str) -> bool {
        let mut map = self.inflight.lock().await;
        if let Some(tx) = map.remove(request_id) {
            let _ = tx.send(());
            return true;
        }
        false
    }

    pub async fn assist(&self, req: AgyAssistRequest) -> Result<AgyAssistResponse, String> {
        let start = Instant::now();
        let bin = self.bin_path.as_ref().ok_or_else(|| {
            "Google Antigravity CLI (`agy`) was not found. Install `agy` or pass `--agy-bin /path/to/agy`."
                .to_string()
        })?;

        let full_prompt = build_assist_prompt(&req);
        let req_id = req
            .request_id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

        let mut cmd = Command::new(bin);
        cmd.arg("--print")
            .arg(full_prompt)
            .arg("--output-format")
            .arg("json")
            .arg("--disable-slash-commands")
            .arg("--mode")
            .arg("plan")
            .arg("--print-timeout")
            .arg(format!("{}s", self.timeout_secs))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        if let Some(conv_id) = req.conversation_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            cmd.arg("--conversation").arg(conv_id);
        }
        if let Some(model) = req
            .model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or(self.default_model.as_deref())
        {
            cmd.arg("--model").arg(model);
        }
        if let Some(effort) = req.effort.as_deref().map(str::trim).filter(|s| {
            matches!(*s, "low" | "medium" | "high" | "xhigh" | "max")
        }) {
            cmd.arg("--effort").arg(effort);
        }
        if self.workspace_root.is_dir() {
            cmd.current_dir(&self.workspace_root);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to launch agy ({}): {}", bin.display(), e))?;

        //if let Some(mut stdin) = child.stdin.take() {
        //    let _ = stdin.write_all(full_prompt.as_bytes()).await;
        //    let _ = stdin.flush().await;
        //    drop(stdin);
        //}

        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
        {
            let mut map = self.inflight.lock().await;
            map.insert(req_id.clone(), cancel_tx);
        }

        let wait_fut = child.wait_with_output();
        let timeout_dur = Duration::from_secs(self.timeout_secs + 5);

        let result = tokio::select! {
            _ = cancel_rx => {
                // child is dropped and killed via kill_on_drop(true)
                Err("Request cancelled by user".to_string())
            }
            res = tokio::time::timeout(timeout_dur, wait_fut) => {
                match res {
                    Ok(Ok(output)) => Ok(output),
                    Ok(Err(e)) => Err(format!("agy process failed: {}", e)),
                    Err(_) => Err(format!("agy timed out after {} seconds", self.timeout_secs)),
                }
            }
        };

        {
            let mut map = self.inflight.lock().await;
            map.remove(&req_id);
        }

        let output = result?;
        let stdout_raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr_raw = String::from_utf8_lossy(&output.stderr).trim().to_string();

        if !output.status.success() && stdout_raw.is_empty() {
            let msg = if !stderr_raw.is_empty() {
                stderr_raw
            } else {
                format!("agy exited with status {}", output.status)
            };
            return Err(msg);
        }

        let (response_text, conv_id) = parse_agy_output(&stdout_raw, &stderr_raw, output.status.success())?;
        let (suggested_code, suggested_lang) = extract_primary_code_block(&response_text);

        Ok(AgyAssistResponse {
            ok: true,
            response: response_text,
            suggested_code,
            suggested_lang,
            conversation_id: conv_id.or(req.conversation_id),
            duration_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }
}

fn resolve_agy_binary(override_path: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(p) = override_path {
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(env_bin) = std::env::var("MINILANG_AGY_BIN") {
        let p = PathBuf::from(env_bin.trim());
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let cand = dir.join("agy");
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        for rel in [".local/bin/agy", "bin/agy"] {
            let cand = Path::new(&home).join(rel);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

fn build_assist_prompt(req: &AgyAssistRequest) -> String {
    let mut p = String::new();
    let target_label = if req.kind == "file" {
        "script/document file"
    } else {
        "notebook cell"
    };

    p.push_str(&format!(
        "You are assisting a user inside a {} in a polyglot notebook & script webapp.\n",
        target_label
    ));
    p.push_str(&format!("Language: {}\n", req.language));
    if let Some(path) = req.path.as_deref().filter(|s| !s.is_empty()) {
        p.push_str(&format!("Path: {}\n", path));
    }

    match req.language.as_str() {
        "minilang" | "ui" => {
            p.push_str(
                "Minilang quick reference: assignment uses `:=`, equality `=` (returns RHS or nil), \
                 comments `:>` / `:< ... >:`, functions `fun f(X) ...` / `do ... end`, \
                 named args `key is val`, modules `import(\"path\")` / `export: ...`, \
                 built-in IO: `store::get/put/create` (CBOR), `store::get_raw/put_raw`, \
                 `store::get_string/put_string`, `http::get/post/put(url, mode, query, headers, body)`, \
                 `log()` / `log(path)`, rich displays `html/svg/markdown/image/pdf/preview`, \
                 UI widgets `ui::panel/vbox/hbox/text/input/button/select/checkbox/html/show`, `exec(script, params, cb)`.\n",
            );
        }
        "rust" => {
            p.push_str(
                "Rust notebook/script quick reference: Cargo dependencies can be declared with \
                 `:dep crate = \"ver\"`, `---cargo ... ---`, or `//! ```cargo ... ``` `. \
                 Notebook helpers: `html()`, `svg()`, `markdown()`, `image()`, `pdf()`, `preview()`. \
                 Invocable `.rs` scripts have `params: Params`, `args: Vec<Value>`, and `Value::*` prelude.\n",
            );
        }
        _ => {}
    }

    if !req.surrounding_cells.is_empty() {
        p.push_str("\nPreceding notebook cells (for context):\n");
        let start_idx = req.surrounding_cells.len().saturating_sub(6);
        for (i, cell_src) in req.surrounding_cells[start_idx..].iter().enumerate() {
            let trimmed = cell_src.trim();
            if trimmed.is_empty() {
                continue;
            }
            let snippet = truncate_str(trimmed, 1500);
            p.push_str(&format!("--- Cell {} ---\n{}\n", start_idx + i + 1, snippet));
        }
    }

    if !req.code.trim().is_empty() {
        p.push_str(&format!(
            "\nCurrent {} code:\n```{}\n{}\n```\n",
            target_label,
            req.language,
            truncate_str(&req.code, 16000)
        ));
    }

    if let Some(sel) = req.selection.as_deref().filter(|s| !s.trim().is_empty()) {
        p.push_str(&format!(
            "\nUser highlighted selection:\n```{}\n{}\n```\n",
            req.language,
            truncate_str(sel, 4000)
        ));
    }

    if let Some(err) = req.error.as_deref().filter(|s| !s.trim().is_empty()) {
        p.push_str(&format!("\nLast error output:\n```\n{}\n```\n", truncate_str(err, 3000)));
    }

    if let Some(out) = req.stdout.as_deref().filter(|s| !s.trim().is_empty()) {
        p.push_str(&format!("\nLast stdout:\n```\n{}\n```\n", truncate_str(out, 1500)));
    }

    let action = req.action.as_deref().unwrap_or("ask");
    let instruction = match action {
        "explain" => "Explain clearly and concisely what this code does.",
        "fix" => "Diagnose and fix the error or bug. Provide a brief explanation and a single fenced code block containing the complete fixed code.",
        "edit" | "refactor" | "improve" => "Apply the requested improvement/edit. Keep your explanation brief and include a single fenced code block with the complete updated code (or updated selection if a selection was highlighted).",
        "generate" => "Generate the requested code. Keep your explanation brief and include a single fenced code block ready to insert.",
        _ => "Help with the user's request concisely. If proposing code changes, include a single fenced code block containing the complete replacement code so the user can apply it with one click.",
    };

    p.push_str(&format!("\nInstructions: {}\n", instruction));
    p.push_str("Do NOT modify files on disk directly — return your answer and any suggested code in your response.\n");
    p.push_str(&format!("\nUser request: {}\n", req.prompt.trim()));
    p
}

fn truncate_str(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Parse output from `agy --print --output-format json` (with graceful fallback to plain text).
pub fn parse_agy_output(
    stdout: &str,
    stderr: &str,
    success: bool,
) -> Result<(String, Option<String>), String> {
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(stdout) {
        if let Some(err_obj) = val.get("error").filter(|v| !v.is_null()) {
            let msg = err_obj
                .as_str()
                .map(String::from)
                .or_else(|| err_obj.get("message").and_then(|m| m.as_str()).map(String::from))
                .unwrap_or_else(|| err_obj.to_string());
            return Err(msg);
        }
        let conv_id = val
            .get("conversation_id")
            .or_else(|| val.get("conversationId"))
            .or_else(|| val.get("session_id"))
            .or_else(|| val.get("sessionId"))
            .and_then(|v| v.as_str())
            .map(String::from);

        let text = val
            .get("result")
            .or_else(|| val.get("response"))
            .or_else(|| val.get("text"))
            .or_else(|| val.get("output"))
            .or_else(|| val.get("content"))
            .or_else(|| val.get("message"))
            .and_then(|v| v.as_str())
            .map(String::from);

        if let Some(t) = text {
            return Ok((t, conv_id));
        }
    }

    // Fallback: if stdout has NDJSON lines, inspect the last JSON object
    for line in stdout.lines().rev() {
        let lt = line.trim();
        if lt.starts_with('{') && lt.ends_with('}') {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(lt) {
                let conv_id = val
                    .get("conversation_id")
                    .or_else(|| val.get("conversationId"))
                    .or_else(|| val.get("session_id"))
                    .and_then(|v| v.as_str())
                    .map(String::from);
                if let Some(t) = val
                    .get("result")
                    .or_else(|| val.get("response"))
                    .or_else(|| val.get("text"))
                    .and_then(|v| v.as_str())
                {
                    return Ok((t.to_string(), conv_id));
                }
            }
        }
    }

    if !success {
        return Err(if !stderr.is_empty() {
            stderr.to_string()
        } else if !stdout.is_empty() {
            stdout.to_string()
        } else {
            "agy returned an empty error response".to_string()
        });
    }

    Ok((stdout.to_string(), None))
}

/// Extract the first (or primary) fenced code block from a Markdown response for 1-click Apply.
pub fn extract_primary_code_block(markdown: &str) -> (Option<String>, Option<String>) {
    let mut in_fence = false;
    let mut lang: Option<String> = None;
    let mut buf = Vec::new();
    let mut blocks: Vec<(Option<String>, String)> = Vec::new();

    for line in markdown.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            if !in_fence {
                in_fence = true;
                let l = trimmed.trim_start_matches('`').trim();
                lang = if l.is_empty() { None } else { Some(l.to_string()) };
                buf.clear();
            } else {
                blocks.push((lang.take(), buf.join("\n")));
                buf.clear();
                in_fence = false;
            }
        } else if in_fence {
            buf.push(line);
        }
    }

    // Prefer the last substantial code block (often the final complete fixed code)
    if let Some((l, code)) = blocks.into_iter().rev().find(|(_, c)| !c.trim().is_empty()) {
        (Some(code), l)
    } else {
        (None, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_primary_code_block() {
        let md = "Here is the fix:\n\n```minilang\nlet x := 42\nx * 2\n```\nDone!";
        let (code, lang) = extract_primary_code_block(md);
        assert_eq!(lang.as_deref(), Some("minilang"));
        assert_eq!(code.as_deref(), Some("let x := 42\nx * 2"));
    }

    #[test]
    fn test_parse_agy_json_and_plain() {
        let j = r#"{"result":"Hello!\n```rust\nlet a = 1;\n```","conversation_id":"conv-123"}"#;
        let (txt, cid) = parse_agy_output(j, "", true).unwrap();
        assert_eq!(cid.as_deref(), Some("conv-123"));
        assert!(txt.contains("let a = 1;"));

        let (plain, cid2) = parse_agy_output("Plain text answer", "", true).unwrap();
        assert_eq!(plain, "Plain text answer");
        assert!(cid2.is_none());
    }
}
