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

pub fn is_tabular_ext(ext: &str) -> bool {
    matches!(ext, "csv" | "tsv")
}

#[derive(Debug, Clone, Serialize)]
pub struct GrepMatch {
    pub path: String,
    pub line: usize,
    pub col: usize,
    pub text: String,
    pub match_start: usize,
    pub match_end: usize,
    pub cell_index: Option<usize>,
    pub cell_id: Option<String>,
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
    pub is_sqlite: bool,
    pub is_tabular: bool,
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
    pub is_sqlite: bool,
    pub is_tabular: bool,
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
            let is_sqlite = !is_dir && (crate::sqlite_reader::is_sqlite_ext(&ext) || crate::sqlite_reader::has_sqlite_magic(&path));
            let is_tabular = !is_dir && is_tabular_ext(&ext);
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
                is_sqlite,
                is_tabular,
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
                    let is_sqlite = !is_dir && crate::sqlite_reader::is_sqlite_ext(&ext);
                    let is_tabular = !is_dir && is_tabular_ext(&ext);
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
                        is_sqlite,
                        is_tabular,
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
        let is_sqlite = crate::sqlite_reader::is_sqlite_ext(&ext) || crate::sqlite_reader::has_sqlite_magic(&abs);
        let is_tabular = is_tabular_ext(&ext);
        let mime_type = media_mime_for_ext(&ext).map(|s| s.to_string());

        // For binary images, PDFs, SQLite DBs, or binary MLOG files, return metadata directly without UTF-8 decoding
        if (is_image && ext != "svg") || is_pdf || is_mlog || is_sqlite {
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
                is_sqlite,
                is_tabular,
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
                is_sqlite,
                is_tabular,
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
                is_sqlite,
                is_tabular,
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

    pub fn upload_file(&self, dir_rel: &str, file_name: &str, data: &[u8]) -> Result<String, String> {
        let dir_abs = if dir_rel.trim().is_empty() || dir_rel.trim() == "/" || dir_rel.trim() == "." {
            self.root.clone()
        } else {
            self.resolve_existing(dir_rel)?
        };
        if !dir_abs.is_dir() {
            return Err(format!("Upload destination '{}' is not a directory", dir_rel));
        }
        let clean_name = Path::new(file_name)
            .file_name()
            .and_then(|s| s.to_str())
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "." && *s != "..")
            .ok_or_else(|| "Invalid upload filename".to_string())?;
        let dst = dir_abs.join(clean_name);
        if !dst.starts_with(&self.root) {
            return Err("Upload outside workspace root is forbidden".to_string());
        }
        fs::write(&dst, data).map_err(|e| format!("Failed to save '{}': {}", clean_name, e))?;
        Ok(self.to_rel_string(&dst))
    }

    /// Create an uncompressed (STORE) ZIP archive of a workspace directory (pure Rust, CRC-32 verified).
    pub fn zip_directory(&self, rel: &str) -> Result<(String, Vec<u8>), String> {
        let abs = if rel.trim().is_empty() || rel.trim() == "/" || rel.trim() == "." {
            self.root.clone()
        } else {
            self.resolve_existing(rel)?
        };
        if !abs.is_dir() {
            return Err(format!("'{}' is not a directory", rel));
        }
        let zip_base = abs
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "workspace".to_string());
        let mut files: Vec<(String, Vec<u8>)> = Vec::new();
        let mut total_bytes: u64 = 0;
        collect_zip_files(&abs, &abs, &mut files, &mut total_bytes)?;
        let bytes = build_zip_archive(&files);
        Ok((format!("{}.zip", zip_base), bytes))
    }

    /// Workspace-wide full-text content search across text files and `.mnb` notebook cells.
    pub fn grep_workspace(
        &self,
        query: &str,
        case_sensitive: bool,
        ext_filter: Option<&str>,
        max_matches: usize,
    ) -> Vec<GrepMatch> {
        let needle_raw = query.trim();
        if needle_raw.is_empty() {
            return Vec::new();
        }
        let needle_cmp = if case_sensitive {
            needle_raw.to_string()
        } else {
            needle_raw.to_lowercase()
        };
        let want_ext = ext_filter
            .map(|s| s.trim().trim_start_matches('.').to_lowercase())
            .filter(|s| !s.is_empty());

        let mut matches = Vec::new();
        let mut stack = vec![self.root.clone()];

        while let Some(dir) = stack.pop() {
            if matches.len() >= max_matches {
                break;
            }
            let Ok(rd) = fs::read_dir(&dir) else { continue };
            let mut entries: Vec<_> = rd.flatten().collect();
            entries.sort_by_key(|e| e.file_name());

            for entry in entries {
                if matches.len() >= max_matches {
                    break;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || name == "target" || name == "obj" || name == "node_modules" {
                    continue;
                }
                let path = entry.path();
                let Ok(meta) = entry.metadata() else { continue };
                if meta.is_dir() {
                    stack.push(path);
                    continue;
                }
                if meta.len() > 2 * 1024 * 1024 {
                    continue;
                }
                let ext = path
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if let Some(ref we) = want_ext {
                    if &ext != we {
                        continue;
                    }
                }
                if is_image_ext(&ext) && ext != "svg"
                    || ext == "pdf"
                    || ext == "mlog"
                    || ext == "cbor"
                    || crate::sqlite_reader::is_sqlite_ext(&ext)
                {
                    continue;
                }

                let Ok(bytes) = fs::read(&path) else { continue };
                if bytes.iter().take(512).any(|&b| b == 0) {
                    continue;
                }
                let Ok(content) = String::from_utf8(bytes) else { continue };
                let rel = self.to_rel_string(&path);

                if ext == "mnb" {
                    if let Ok(doc) = serde_json::from_str::<NotebookDocument>(&content) {
                        for (ci, cell) in doc.cells.iter().enumerate() {
                            for (li, line) in cell.source.lines().enumerate() {
                                if matches.len() >= max_matches {
                                    break;
                                }
                                let hay = if case_sensitive {
                                    line.to_string()
                                } else {
                                    line.to_lowercase()
                                };
                                if let Some(pos) = hay.find(&needle_cmp) {
                                    matches.push(GrepMatch {
                                        path: rel.clone(),
                                        line: li + 1,
                                        col: pos + 1,
                                        text: truncate_line(line, 200),
                                        match_start: pos,
                                        match_end: pos + needle_raw.len(),
                                        cell_index: Some(ci),
                                        cell_id: Some(cell.id.clone()),
                                    });
                                }
                            }
                        }
                        continue;
                    }
                }

                for (li, line) in content.lines().enumerate() {
                    if matches.len() >= max_matches {
                        break;
                    }
                    let hay = if case_sensitive {
                        line.to_string()
                    } else {
                        line.to_lowercase()
                    };
                    if let Some(pos) = hay.find(&needle_cmp) {
                        matches.push(GrepMatch {
                            path: rel.clone(),
                            line: li + 1,
                            col: pos + 1,
                            text: truncate_line(line, 200),
                            match_start: pos,
                            match_end: pos + needle_raw.len(),
                            cell_index: None,
                            cell_id: None,
                        });
                    }
                }
            }
        }
        matches
    }
}

fn truncate_line(s: &str, max_chars: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max_chars {
        s.to_string()
    } else {
        let head: String = chars[..max_chars].iter().collect();
        format!("{}...", head)
    }
}

fn collect_zip_files(
    base: &Path,
    dir: &Path,
    out: &mut Vec<(String, Vec<u8>)>,
    total_bytes: &mut u64,
) -> Result<(), String> {
    const MAX_ZIP_BYTES: u64 = 128 * 1024 * 1024;
    let rd = fs::read_dir(dir).map_err(|e| format!("read_dir failed: {}", e))?;
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "target" || name == ".git" || name == ".minilang-secrets.key" || name == ".minilang-secrets.enc" {
            continue;
        }
        let p = entry.path();
        let Ok(meta) = fs::symlink_metadata(&p) else { continue };
        if meta.is_dir() {
            collect_zip_files(base, &p, out, total_bytes)?;
        } else if meta.is_file() {
            *total_bytes = total_bytes.saturating_add(meta.len());
            if *total_bytes > MAX_ZIP_BYTES {
                return Err("Folder exceeds 128 MB ZIP export limit".to_string());
            }
            let rel = p
                .strip_prefix(base)
                .unwrap_or(&p)
                .to_string_lossy()
                .replace('\\', "/");
            let data = fs::read(&p).map_err(|e| format!("read '{}' failed: {}", rel, e))?;
            out.push((rel, data));
        }
    }
    Ok(())
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xffff_ffff;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            if crc & 1 != 0 {
                crc = (crc >> 1) ^ 0xedb8_8320;
            } else {
                crc >>= 1;
            }
        }
    }
    !crc
}

fn build_zip_archive(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();

    for (name, data) in files {
        let name_bytes = name.as_bytes();
        let crc = crc32(data);
        let size = data.len() as u32;
        let local_offset = out.len() as u32;

        // Local file header (method 0 = STORE, UTF-8 flag bit 11 = 0x0800)
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0x0800u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(data);

        // Central directory header
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0x0800u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&local_offset.to_le_bytes());
        central.extend_from_slice(name_bytes);
    }

    let cd_offset = out.len() as u32;
    let cd_size = central.len() as u32;
    let count = files.len() as u16;
    out.extend_from_slice(&central);

    // End of central directory record
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
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
