use crate::kernel_proc::{DisplayItem, EvalError, EvalValue};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotebookDocument {
    pub format: String,
    pub version: u32,
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
    pub fn empty(title: Option<String>) -> Self {
        Self {
            format: "minilang-notebook".to_string(),
            version: 1,
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

    pub fn from_mini_script(title: &str, content: &str) -> Self {
        let mut cells = Vec::new();
        // Support `# %%` or `:>> ---` cell markers if present, otherwise single code cell
        let has_markers = content
            .lines()
            .any(|l| l.trim().starts_with(":> %%") || l.trim().starts_with("# %%"));
        if has_markers {
            let mut current = Vec::new();
            for line in content.lines() {
                let t = line.trim();
                if t.starts_with(":> %%") || t.starts_with("# %%") {
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
            title: Some(title.to_string()),
            cells,
        }
    }

    pub fn to_mini_script(&self) -> String {
        let mut parts = Vec::new();
        for (i, cell) in self.cells.iter().enumerate() {
            if cell.cell_type == "markdown" {
                let commented: Vec<String> = cell
                    .source
                    .lines()
                    .map(|l| format!(":> {}", l))
                    .collect();
                parts.push(commented.join("\n"));
            } else {
                parts.push(format!(":> %% Cell {}\n{}", i + 1, cell.source));
            }
        }
        parts.join("\n\n") + "\n"
    }
}
