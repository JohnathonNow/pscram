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
