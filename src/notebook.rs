use crate::kernel_proc::{DisplayItem, EvalError, EvalValue};
use serde::{Deserialize, Serialize};

fn default_language() -> String {
    "minilang".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookDocument {
    pub format: String,
    pub version: u32,
    #[serde(default = "default_language")]
    pub language: String,
    pub title: Option<String>,
    pub cells: Vec<NotebookCell>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookCell {
    pub id: String,
    pub cell_type: String, // "code" | "markdown"
    pub source: String,
    #[serde(default)]
    pub execution_count: Option<u64>,
    #[serde(default)]
    pub output: Option<CellOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CellOutput {
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub displays: Vec<DisplayItem>,
    #[serde(default)]
    pub results: Vec<EvalValue>,
    #[serde(default)]
    pub error: Option<EvalError>,
    #[serde(default)]
    pub duration_ms: Option<f64>,
}

impl NotebookDocument {
    pub fn empty(title: Option<String>, language: Option<&str>) -> Self {
        Self {
            format: "minilang-notebook".to_string(),
            version: 1,
            language: language.unwrap_or("minilang").to_string(),
            title,
            cells: vec![NotebookCell {
                id: uuid::Uuid::new_v4().to_string(),
                cell_type: "code".to_string(),
                source: String::new(),
                execution_count: None,
                output: None,
            }],
        }
    }

    pub fn from_script(title: &str, content: &str, language: &str) -> Self {
        let mut cells = Vec::new();
        let has_markers = content.lines().any(|l| {
            let t = l.trim();
            t.starts_with(":> %%") || t.starts_with("// %%") || t.starts_with("# %%")
        });
        if has_markers {
            let mut current = Vec::new();
            for line in content.lines() {
                let t = line.trim();
                if t.starts_with(":> %%") || t.starts_with("// %%") || t.starts_with("# %%") {
                    if !current.is_empty() {
                        cells.push(NotebookCell {
                            id: uuid::Uuid::new_v4().to_string(),
                            cell_type: "code".to_string(),
                            source: current.join("\n").trim().to_string(),
                            execution_count: None,
                            output: None,
                        });
                        current.clear();
                    }
                } else {
                    current.push(line);
                }
            }
            if !current.is_empty() {
                cells.push(NotebookCell {
                    id: uuid::Uuid::new_v4().to_string(),
                    cell_type: "code".to_string(),
                    source: current.join("\n").trim().to_string(),
                    execution_count: None,
                    output: None,
                });
            }
        } else {
            cells.push(NotebookCell {
                id: uuid::Uuid::new_v4().to_string(),
                cell_type: "code".to_string(),
                source: content.to_string(),
                execution_count: None,
                output: None,
            });
        }
        if cells.is_empty() {
            cells.push(NotebookCell {
                id: uuid::Uuid::new_v4().to_string(),
                cell_type: "code".to_string(),
                source: String::new(),
                execution_count: None,
                output: None,
            });
        }
        Self {
            format: "minilang-notebook".to_string(),
            version: 1,
            language: language.to_string(),
            title: Some(title.to_string()),
            cells,
        }
    }

    pub fn to_script(&self, comment_prefix: &str) -> String {
        let mut parts = Vec::new();
        for (i, cell) in self.cells.iter().enumerate() {
            if cell.cell_type == "markdown" {
                let commented: Vec<String> = cell
                    .source
                    .lines()
                    .map(|l| format!("{} {}", comment_prefix, l))
                    .collect();
                parts.push(commented.join("\n"));
            } else {
                parts.push(format!("{} %% Cell {}\n{}", comment_prefix, i + 1, cell.source));
            }
        }
        parts.join("\n\n") + "\n"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_notebook_defaults() {
        let nb = NotebookDocument::empty(Some("demo.mnb".into()), None);
        assert_eq!(nb.format, "minilang-notebook");
        assert_eq!(nb.version, 1);
        assert_eq!(nb.language, "minilang");
        assert_eq!(nb.cells.len(), 1);
        assert_eq!(nb.cells[0].cell_type, "code");

        let rust_nb = NotebookDocument::empty(None, Some("rust"));
        assert_eq!(rust_nb.language, "rust");
    }

    #[test]
    fn test_from_script_and_to_script_cell_markers() {
        let script = ":> %% Cell 1\nlet x := 10\n:> %% Cell 2\nx * 2\n";
        let nb = NotebookDocument::from_script("calc.mini", script, "minilang");
        assert_eq!(nb.cells.len(), 2);
        assert_eq!(nb.cells[0].source, "let x := 10");
        assert_eq!(nb.cells[1].source, "x * 2");

        let exported = nb.to_script(":>");
        assert!(exported.contains(":> %% Cell 1\nlet x := 10"));
        assert!(exported.contains(":> %% Cell 2\nx * 2"));

        let rust_script = "// %% Part 1\nlet a = 1;\n// %% Part 2\na + 2\n";
        let rnb = NotebookDocument::from_script("demo.rs", rust_script, "rust");
        assert_eq!(rnb.cells.len(), 2);
        assert_eq!(rnb.language, "rust");
        assert_eq!(rnb.cells[0].source, "let a = 1;");
        assert_eq!(rnb.cells[1].source, "a + 2");
    }

    #[test]
    fn test_to_script_comments_out_markdown_cells() {
        let mut nb = NotebookDocument::empty(Some("mix.mnb".into()), Some("minilang"));
        nb.cells = vec![
            NotebookCell {
                id: "c1".into(),
                cell_type: "markdown".into(),
                source: "# Title\nSome notes".into(),
                execution_count: None,
                output: None,
            },
            NotebookCell {
                id: "c2".into(),
                cell_type: "code".into(),
                source: "1 + 1".into(),
                execution_count: Some(1),
                output: None,
            },
        ];
        let out = nb.to_script(":>");
        assert!(out.contains(":> # Title\n:> Some notes"));
        assert!(out.contains(":> %% Cell 2\n1 + 1"));
    }

    #[test]
    fn test_from_script_without_markers_and_empty() {
        let nb = NotebookDocument::from_script("plain.mini", "let a := 1\na + 2", "minilang");
        assert_eq!(nb.cells.len(), 1);
        assert_eq!(nb.cells[0].source, "let a := 1\na + 2");

        let empty = NotebookDocument::from_script("empty.mini", ":> %%\n", "minilang");
        assert_eq!(empty.cells.len(), 1);
        assert_eq!(empty.cells[0].source, "");
    }
}
