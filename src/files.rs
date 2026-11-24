use crate::notebook::NotebookDocument;
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

pub fn media_mime_for_ext(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        "pdf" => Some("application/pdf"),
        _ => None,
    }
}

pub fn is_image_ext(ext: &str) -> bool {
    matches!(ext, "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico" | "avif")
}

pub fn is_markdown_ext(ext: &str) -> bool {
    matches!(ext, "md" | "markdown")
}

pub fn is_log_ext(ext: &str) -> bool {
    matches!(ext, "log" | "mlog")
}

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: String, // "dir" | "file"
    pub size: u64,
    pub modified: Option<String>,
    pub extension: String,
    pub is_notebook: bool,
    pub is_minilang: bool,
    pub is_rust: bool,
    pub is_ui: bool,
    pub is_image: bool,
    pub is_pdf: bool,
    pub is_markdown: bool,
    pub is_log: bool,
    pub mime_type: Option<String>,
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileReadResult {
    pub path: String,
    pub name: String,
    pub extension: String,
    pub size: u64,
    pub content: String,
    pub is_binary: bool,
    pub is_image: bool,
    pub is_pdf: bool,
    pub is_markdown: bool,
    pub is_log: bool,
    pub mime_type: Option<String>,
}

pub struct FileStore {
    root: PathBuf,
}

impl FileStore {
    pub fn new(root: PathBuf) -> std::io::Result<Self> {
        let canonical = fs::canonicalize(root)?;
        Ok(Self { root: canonical })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve a user-supplied relative path safely within `self.root`.
    pub fn resolve_existing(&self, rel: &str) -> Result<PathBuf, String> {
        let clean = sanitize_rel_path(rel)?;
        let candidate = self.root.join(&clean);
        let canonical = fs::canonicalize(&candidate)
            .map_err(|e| format!("Path '{}' not found: {}", rel, e))?;
        if !canonical.starts_with(&self.root) {
            return Err("Access outside workspace root is forbidden".to_string());
        }
        Ok(canonical)
    }

    /// Resolve a target path that may not exist yet (for create / save / rename).
    pub fn resolve_new(&self, rel: &str) -> Result<PathBuf, String> {
        let clean = sanitize_rel_path(rel)?;
        if clean.as_os_str().is_empty() {
            return Err("Path cannot be empty".to_string());
        }
        let target = self.root.join(&clean);
        // Ensure parent directory exists or is within root
        let mut ancestor = target.parent();
        while let Some(a) = ancestor {
            if a.exists() {
                let canon = fs::canonicalize(a)
                    .map_err(|e| format!("Invalid parent path: {}", e))?;
                if !canon.starts_with(&self.root) {
                    return Err("Access outside workspace root is forbidden".to_string());
                }
                break;
            }
            ancestor = a.parent();
        }
        Ok(target)
    }

    fn to_rel_string(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/")
    }

    pub fn list_dir(&self, rel: &str, show_hidden: bool) -> Result<DirListing, String> {
        let abs = if rel.trim().is_empty() || rel.trim() == "/" || rel.trim() == "." {
            self.root.clone()
        } else {
            self.resolve_existing(rel)?
        };

        if !abs.is_dir() {
            return Err(format!("'{}' is not a directory", rel));
        }

        let mut entries = Vec::new();
        let read_dir = fs::read_dir(&abs)
            .map_err(|e| format!("Failed to read directory: {}", e))?;

        for entry_res in read_dir {
            let entry = match entry_res {
                Ok(e) => e,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if !show_hidden && name.starts_with('.') {
                continue;
            }
            // Skip rust target directory and build clutter by default unless hidden shown? Keep visible so user can browse everything except dot-files.
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let is_dir = meta.is_dir();
            let path = entry.path();
            let rel_path = self.to_rel_string(&path);
            let ext = if is_dir {
                String::new()
            } else {
                path.extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_lowercase()
            };
            let modified = meta.modified().ok().map(|st| {
                let dt: DateTime<Utc> = st.into();
                dt.to_rfc3339()
            });

            let language = match ext.as_str() {
                "mini" | "ui" => Some("minilang".to_string()),
                "rs" => Some("rust".to_string()),
                _ => None,
            };

            let is_image = !is_dir && is_image_ext(&ext);
            let is_pdf = !is_dir && ext == "pdf";
            let is_markdown = !is_dir && is_markdown_ext(&ext);
            let is_log = !is_dir && (is_log_ext(&ext) || crate::log_reader::has_mlog_magic(&path));
            let mime_type = if is_dir {
                None
            } else {
                media_mime_for_ext(&ext).map(|s| s.to_string())
            };

            entries.push(FileEntry {
                name,
                path: rel_path,
                kind: if is_dir { "dir" } else { "file" }.to_string(),
                size: if is_dir { 0 } else { meta.len() },
                modified,
                is_notebook: ext == "mnb",
                is_minilang: ext == "mini",
                is_rust: ext == "rs",
                is_ui: ext == "ui",
                is_image,
                is_pdf,
                is_markdown,
                is_log,
                mime_type,
                language,
                extension: ext,
            });
        }

        entries.sort_by(|a, b| {
            let dir_ord = (b.kind == "dir").cmp(&(a.kind == "dir"));
            dir_ord.then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        let cur_rel = self.to_rel_string(&abs);
        let parent = if abs == self.root {
            None
        } else {
            abs.parent().map(|p| self.to_rel_string(p))
        };

        Ok(DirListing {
            path: cur_rel,
            parent,
            entries,
        })
    }

    pub fn search_files(&self, query: &str, max_results: usize) -> Vec<FileEntry> {
        let q = query.trim().to_lowercase();
        let mut results = Vec::new();
        if q.is_empty() {
            return results;
        }
        let mut stack = vec![self.root.clone()];
        while let Some(dir) = stack.pop() {
            if results.len() >= max_results {
                break;
            }
            let read_dir = match fs::read_dir(&dir) {
                Ok(r) => r,
                Err(_) => continue,
            };
            for entry_res in read_dir {
                if results.len() >= max_results {
                    break;
                }
                let entry = match entry_res {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || name == "target" || name == "obj" {
                    continue;
                }
                let path = entry.path();
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                let is_dir = meta.is_dir();
                if is_dir {
                    stack.push(path.clone());
                }
                let rel_path = self.to_rel_string(&path);
                if name.to_lowercase().contains(&q) || rel_path.to_lowercase().contains(&q) {
                    let ext = if is_dir {
                        String::new()
                    } else {
                        path.extension()
                            .and_then(|s| s.to_str())
                            .unwrap_or("")
                            .to_lowercase()
                    };
                    let language = match ext.as_str() {
                        "mini" | "ui" => Some("minilang".to_string()),
                        "rs" => Some("rust".to_string()),
                        _ => None,
                    };
                    let is_image = !is_dir && is_image_ext(&ext);
                    let is_pdf = !is_dir && ext == "pdf";
                    let is_markdown = !is_dir && is_markdown_ext(&ext);
                    let is_log = !is_dir && is_log_ext(&ext);
                    let mime_type = if is_dir {
                        None
                    } else {
                        media_mime_for_ext(&ext).map(|s| s.to_string())
                    };
                    results.push(FileEntry {
                        name,
                        path: rel_path,
                        kind: if is_dir { "dir" } else { "file" }.to_string(),
                        size: if is_dir { 0 } else { meta.len() },
                        modified: None,
                        is_notebook: ext == "mnb",
                        is_minilang: ext == "mini",
                        is_rust: ext == "rs",
                        is_ui: ext == "ui",
                        is_image,
                        is_pdf,
                        is_markdown,
                        is_log,
                        mime_type,
                        language,
                        extension: ext,
                    });
                }
            }
        }
        results.sort_by(|a, b| a.path.cmp(&b.path));
        results
    }

    pub fn read_file(&self, rel: &str) -> Result<FileReadResult, String> {
        let abs = self.resolve_existing(rel)?;
        if abs.is_dir() {
            return Err("Cannot read a directory as a file".to_string());
        }
        let meta = fs::metadata(&abs).map_err(|e| format!("stat failed: {}", e))?;
        let name = abs
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let ext = abs
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        let is_image = is_image_ext(&ext);
        let is_pdf = ext == "pdf";
        let is_markdown = is_markdown_ext(&ext);
        let is_mlog = crate::log_reader::has_mlog_magic(&abs);
        let is_log = is_log_ext(&ext) || is_mlog;
        let mime_type = media_mime_for_ext(&ext).map(|s| s.to_string());

        // For binary images, PDFs, or binary MLOG files, return metadata directly without UTF-8 decoding
        if (is_image && ext != "svg") || is_pdf || is_mlog {
            return Ok(FileReadResult {
                path: self.to_rel_string(&abs),
                name,
                extension: ext,
                size: meta.len(),
                content: String::new(),
                is_binary: true,
                is_image,
                is_pdf,
                is_markdown,
                is_log,
                mime_type,
            });
        }

        if meta.len() > 10 * 1024 * 1024 {
            return Err("File is too large to open in editor (> 10 MB)".to_string());
        }
        let bytes = fs::read(&abs).map_err(|e| format!("read failed: {}", e))?;

        match String::from_utf8(bytes) {
            Ok(content) => Ok(FileReadResult {
                path: self.to_rel_string(&abs),
                name,
                extension: ext,
                size: meta.len(),
                content,
                is_binary: false,
                is_image,
                is_pdf,
                is_markdown,
                is_log,
                mime_type,
            }),
            Err(_) => Ok(FileReadResult {
                path: self.to_rel_string(&abs),
                name,
                extension: ext,
                size: meta.len(),
                content: String::new(),
                is_binary: true,
                is_image,
                is_pdf,
                is_markdown,
                is_log,
                mime_type,
            }),
        }
    }

    pub fn read_raw_file(&self, rel: &str) -> Result<(String, String, Vec<u8>), String> {
        let abs = self.resolve_existing(rel)?;
        if abs.is_dir() {
            return Err("Cannot serve a directory as a raw file".to_string());
        }
        let meta = fs::metadata(&abs).map_err(|e| format!("stat failed: {}", e))?;
        if meta.len() > 64 * 1024 * 1024 {
            return Err("File exceeds 64 MB preview limit".to_string());
        }
        let name = abs
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".to_string());
        let ext = abs
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        let mime = media_mime_for_ext(&ext)
            .unwrap_or("application/octet-stream")
            .to_string();
        let bytes = fs::read(&abs).map_err(|e| format!("read failed: {}", e))?;
        Ok((name, mime, bytes))
    }

    pub fn write_file(&self, rel: &str, content: &str) -> Result<String, String> {
        let abs = self.resolve_new(rel)?;
        if let Some(parent) = abs.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
        }
        fs::write(&abs, content).map_err(|e| format!("write failed: {}", e))?;
        Ok(self.to_rel_string(&abs))
    }

    pub fn create_entry(
        &self,
        rel: &str,
        kind: &str,
        language: Option<&str>,
    ) -> Result<String, String> {
        let abs = self.resolve_new(rel)?;
        if abs.exists() {
            return Err(format!("'{}' already exists", rel));
        }
        match kind {
            "dir" | "folder" => {
                fs::create_dir_all(&abs).map_err(|e| format!("mkdir failed: {}", e))?;
            }
            "notebook" => {
                if let Some(parent) = abs.parent() {
                    fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
                }
                let title = abs
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string());
                let doc = NotebookDocument::empty(title, language);
                let json = serde_json::to_string_pretty(&doc)
                    .map_err(|e| format!("serialize failed: {}", e))?;
                fs::write(&abs, json).map_err(|e| format!("write failed: {}", e))?;
            }
            "ui" => {
                if let Some(parent) = abs.parent() {
                    fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
                }
                let title = abs
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Custom UI");
                let template = format!(
                    ":> Minilang UI file — open at /ui/{rel}\n\n\
                     let name := ui::input(\"Enter name\", \"World\")\n\
                     let output := ui::html(\"<em>Ready</em>\")\n\n\
                     let btn := ui::button(\"Run\";) do\n\
                     \texec(\"scripts/greet.mini\", {{\"name\" is name:value}}; res, err) do\n\
                     \t\tif err then\n\
                     \t\t\toutput:set_html('<div class=\"mlui-error-banner\">{{err}}</div>')\n\
                     \t\telse\n\
                     \t\t\toutput:set_html('<strong>{{res[\"greeting\"]}}</strong>')\n\
                     \t\tend\n\
                     \tend\n\
                     end\n\n\
                     ui::show(ui::card(\"{title}\", ui::vbox(ui::hbox(ui::label(\"Name:\"), name), btn, output)))\n"
                );
                fs::write(&abs, template).map_err(|e| format!("write failed: {}", e))?;
            }
            _ => {
                if let Some(parent) = abs.parent() {
                    fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
                }
                fs::write(&abs, "").map_err(|e| format!("write failed: {}", e))?;
            }
        }
        Ok(self.to_rel_string(&abs))
    }

    pub fn rename_entry(&self, from: &str, to: &str) -> Result<String, String> {
        let src = self.resolve_existing(from)?;
        if src == self.root {
            return Err("Cannot rename workspace root".to_string());
        }
        let dst = self.resolve_new(to)?;
        if src.is_dir() && dst.starts_with(&src) {
            return Err("Cannot move a directory into itself".to_string());
        }
        if dst.exists() {
            return Err(format!("Destination '{}' already exists", to));
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
        }
        fs::rename(&src, &dst).map_err(|e| format!("rename failed: {}", e))?;
        Ok(self.to_rel_string(&dst))
    }

    pub fn copy_entry(
        &self,
        from: &str,
        to_dir: &str,
        new_name: Option<&str>,
    ) -> Result<String, String> {
        let src = self.resolve_existing(from)?;
        if src == self.root {
            return Err("Cannot copy workspace root".to_string());
        }
        let dst_dir = if to_dir.trim().is_empty() || to_dir.trim() == "/" || to_dir.trim() == "." {
            self.root.clone()
        } else {
            self.resolve_existing(to_dir)?
        };
        if !dst_dir.is_dir() {
            return Err(format!("Destination '{}' is not a directory", to_dir));
        }

        let base_name = match new_name.map(str::trim).filter(|s| !s.is_empty()) {
            Some(n) => {
                if n.contains('/') || n.contains('\\') || n == "." || n == ".." {
                    return Err(format!("Invalid file name '{}'", n));
                }
                n.to_string()
            }
            None => src
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .ok_or_else(|| "Invalid source path".to_string())?,
        };

        let dst = pick_unique_dest(&dst_dir, &base_name, src.is_dir());
        if !dst.starts_with(&self.root) {
            return Err("Access outside workspace root is forbidden".to_string());
        }
        if src.is_dir() && dst.starts_with(&src) {
            return Err("Cannot copy a directory into itself".to_string());
        }

        if src.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            fs::copy(&src, &dst).map_err(|e| format!("copy failed: {}", e))?;
        }
        Ok(self.to_rel_string(&dst))
    }

    pub fn delete_entry(&self, rel: &str) -> Result<(), String> {
        let abs = self.resolve_existing(rel)?;
        if abs == self.root {
            return Err("Cannot delete workspace root".to_string());
        }
        if abs.is_dir() {
            fs::remove_dir_all(&abs).map_err(|e| format!("rmdir failed: {}", e))?;
        } else {
            fs::remove_file(&abs).map_err(|e| format!("unlink failed: {}", e))?;
        }
        Ok(())
    }
}

fn sanitize_rel_path(rel: &str) -> Result<PathBuf, String> {
    let trimmed = rel.trim().trim_start_matches('/');
    let mut out = PathBuf::new();
    for comp in Path::new(trimmed).components() {
        match comp {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("Invalid path segment in '{}'", rel));
            }
        }
    }
    Ok(out)
}

fn pick_unique_dest(dir: &Path, name: &str, is_dir: bool) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = if is_dir {
        (name.to_string(), String::new())
    } else if let Some(dot) = name.rfind('.') {
        if dot > 0 {
            (name[..dot].to_string(), name[dot..].to_string())
        } else {
            (name.to_string(), String::new())
        }
    } else {
        (name.to_string(), String::new())
    };

    let cand1 = dir.join(format!("{} copy{}", stem, ext));
    if !cand1.exists() {
        return cand1;
    }
    for n in 2..10_000 {
        let cand = dir.join(format!("{} copy {}{}", stem, n, ext));
        if !cand.exists() {
            return cand;
        }
    }
    dir.join(format!("{} copy {}{}", stem, uuid::Uuid::new_v4(), ext))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("mkdir failed: {}", e))?;
    let entries = fs::read_dir(src).map_err(|e| format!("read_dir failed: {}", e))?;
    for entry_res in entries {
        let entry = entry_res.map_err(|e| format!("read_dir entry failed: {}", e))?;
        let src_child = entry.path();
        let dst_child = dst.join(entry.file_name());
        let meta = fs::symlink_metadata(&src_child).map_err(|e| format!("stat failed: {}", e))?;
        if meta.is_dir() {
            copy_dir_recursive(&src_child, &dst_child)?;
        } else if meta.is_file() {
            fs::copy(&src_child, &dst_child).map_err(|e| format!("copy failed: {}", e))?;
        }
    }
    Ok(())
}
