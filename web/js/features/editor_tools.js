/**
 * Richer Code Editor Tools (Feature #8):
 * - Find & Replace bar (Ctrl+F / Ctrl+H) across File Editor & Notebooks
 * - Inline Diagnostics & Gutter Error Markers (Minilang & rustc error parsing)
 * - Clickable import("./...") Go-to-Definition (Ctrl+Click / F12 / jump pill)
 */

import { escapeHtml, highlightCode } from "../core/highlight.js";
import { api } from "../core/auth.js";
import { toast } from "../core/ui_helpers.js";
import { state, activeTab, langByExtension, markDirty } from "../core/state.js";
import { openPathInTab, syncFileEditorHighlight, syncFileEditorScroll } from "./viewers.js";
import { renderCells, selectCell, updateSingleCellDom } from "./notebook.js";

// =========================================================================
// 1. Inline Diagnostics & Gutter Error Markers
// =========================================================================

function parseDiagnosticsFromError(errObj, defaultSource = "") {
  if (!errObj) return [];
  const text = `${errObj.message || ""}\n${errObj.traceback || ""}`;
  const diags = [];
  const seen = new Set();

  // Minilang stack frames / syntax errors: `at foo.mini:12` or `foo.mini:12` or `line 12`
  const mlAtRe = new RegExp("(?:^|\\s|at\\s+)([^\\s:()]+):(\\d+)(?::(\\d+))?", "gm");
  let m;
  while ((m = mlAtRe.exec(text)) !== null) {
    const src = m[1];
    const line = Number(m[2]);
    const col = m[3] ? Number(m[3]) : null;
    if (!Number.isFinite(line) || line < 1) continue;
    // Skip URLs like http:8080
    if (src === "http" || src === "https") continue;
    const key = `${src}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diags.push({
      source: src,
      line,
      col,
      message: `${errObj.error_type || "Error"}: ${errObj.message || ""}`.trim(),
    });
  }

  // Rust compiler diagnostics: `--> cell_1.rs:14:9`
  const rustRe = new RegExp("-->\\s+([^:\\s]+):(\\d+):(\\d+)", "g");
  while ((m = rustRe.exec(text)) !== null) {
    const src = m[1];
    const line = Number(m[2]);
    const col = Number(m[3]);
    if (!Number.isFinite(line) || line < 1) continue;
    const key = `${src}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diags.push({
      source: src,
      line,
      col,
      message: `${errObj.error_type || "CompileError"}: ${errObj.message || ""}`.trim(),
    });
  }

  // Fallback: explicit `line 12` mention
  if (!diags.length) {
    const lineRe = new RegExp("\\bline\\s+(\\d+)\\b", "i");
    const lm = lineRe.exec(text);
    if (lm) {
      const line = Number(lm[1]);
      if (Number.isFinite(line) && line >= 1) {
        diags.push({
          source: defaultSource,
          line,
          col: null,
          message: `${errObj.error_type || "Error"}: ${errObj.message || ""}`.trim(),
        });
      }
    }
  }

  return diags;
}

function jumpToFileEditorLine(line, col = 1) {
  const ta = document.getElementById("file-editor-textarea");
  if (!ta) return;
  const lines = (ta.value || "").split("\n");
  const idx = Math.max(0, Math.min(lines.length - 1, (line || 1) - 1));
  let pos = 0;
  for (let i = 0; i < idx; i++) pos += lines[i].length + 1;
  const lineLen = lines[idx] ? lines[idx].length : 0;
  const start = pos + Math.max(0, Math.min(lineLen, (col || 1) - 1));
  const end = pos + lineLen;
  ta.focus();
  ta.setSelectionRange(start, end);
  // Approximate line height 21px
  ta.scrollTop = Math.max(0, idx * 21 - ta.clientHeight / 3);
  syncFileEditorScroll();
}

function applyFileDiagnostics(tab, errObj) {
  if (!tab || tab.kind !== "file") return;
  const diags = errObj ? parseDiagnosticsFromError(errObj, tab.title || tab.path || "") : [];
  tab._diagnostics = diags;
  renderFileDiagnostics(tab);
}

function clearFileDiagnostics(tab) {
  if (!tab) return;
  if (tab._diagnostics && tab._diagnostics.length) {
    tab._diagnostics = [];
    renderFileDiagnostics(tab);
  }
}

function renderFileDiagnostics(tab) {
  const banner = document.getElementById("file-diag-banner");
  const textEl = document.getElementById("file-diag-text");
  const jumpBtn = document.getElementById("file-diag-jump");
  const gutter = document.getElementById("file-editor-gutter");
  if (!banner || !textEl) return;

  const diags = (tab && tab.kind === "file" && Array.isArray(tab._diagnostics)) ? tab._diagnostics : [];
  if (gutter) {
    gutter.querySelectorAll(".fe-gutter-line.diag-error").forEach((el) => {
      el.classList.remove("diag-error");
      el.removeAttribute("title");
    });
    for (const d of diags) {
      const lineEl = gutter.querySelector(`.fe-gutter-line[data-line="${d.line}"]`);
      if (lineEl) {
        lineEl.classList.add("diag-error");
        lineEl.title = d.message;
      }
    }
  }

  if (!diags.length || activeTab()?.id !== tab?.id) {
    banner.classList.add("hidden");
    return;
  }

  const first = diags[0];
  textEl.textContent = `Line ${first.line}${first.col ? `:${first.col}` : ""} — ${first.message}`;
  banner.classList.remove("hidden");
  if (jumpBtn) {
    jumpBtn.onclick = () => jumpToFileEditorLine(first.line, first.col || 1);
  }
}

// =========================================================================
// 2. Clickable import("./...") Go-to-Definition (Ctrl+Click / F12 / Pill)
// =========================================================================

function findImportAtCursor(text, cursorPos) {
  if (!text) return null;
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursorPos - 1)) + 1;
  let lineEnd = text.indexOf("\n", cursorPos);
  if (lineEnd < 0) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd);
  const col = cursorPos - lineStart;

  // Match Minilang import("...") or Rust include_str!("...") / mod name;
  const patterns = [
    new RegExp("import\\s*\\(\\s*[\"']([^\"']+)[\"']\\s*\\)", "g"),
    new RegExp("include_str!\\s*\\(\\s*\"([^\"]+)\"\\s*\\)", "g"),
    new RegExp("^\\s*(?:pub\\s+)?mod\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*;", "g"),
  ];
  for (let pi = 0; pi < patterns.length; pi++) {
    const re = patterns[pi];
    let m;
    while ((m = re.exec(line)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (col >= start && col <= end) {
        return {
          spec: m[1],
          isRustMod: pi === 2,
        };
      }
    }
  }
  return null;
}

function normalizeWorkspacePath(baseDir, relSpec) {
  const raw = relSpec.startsWith("/")
    ? relSpec.slice(1)
    : (baseDir ? `${baseDir}/${relSpec}` : relSpec);
  const parts = [];
  for (const seg of raw.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

async function resolveAndOpenImport(spec, isRustMod = false) {
  const tab = activeTab();
  const baseDir = tab && tab.path && tab.path.includes("/")
    ? tab.path.slice(0, tab.path.lastIndexOf("/"))
    : (state.currentDir || "");

  const candidates = [];
  const norm = normalizeWorkspacePath(baseDir, spec);
  if (isRustMod) {
    candidates.push(`${norm}.rs`, `${norm}/mod.rs`);
  } else {
    candidates.push(norm);
    if (!norm.includes(".")) {
      candidates.push(`${norm}.mini`, `${norm}.ui`, `${norm}.rs`);
    }
    if (!spec.startsWith(".") && baseDir) {
      const rootNorm = normalizeWorkspacePath("", spec);
      if (rootNorm !== norm) {
        candidates.push(rootNorm);
        if (!rootNorm.includes(".")) {
          candidates.push(`${rootNorm}.mini`, `${rootNorm}.ui`);
        }
      }
    }
  }

  for (const cand of candidates) {
    try {
      await api(`/api/file?path=${encodeURIComponent(cand)}`);
      await openPathInTab(cand);
      toast(`Opened ${cand}`, "info");
      return true;
    } catch { /* try next */ }
  }
  toast(`Could not resolve import "${spec}"`, "error");
  return false;
}

let activeGotoTarget = null;

function updateGotoPillForTextarea(ta) {
  const pill = document.getElementById("editor-goto-pill");
  if (!pill) return;
  if (!ta) {
    activeGotoTarget = null;
    pill.classList.add("hidden");
    return;
  }
  const hit = findImportAtCursor(ta.value, ta.selectionStart || 0);
  if (!hit) {
    activeGotoTarget = null;
    pill.classList.add("hidden");
    return;
  }
  activeGotoTarget = hit;
  pill.textContent = `Go to "${hit.spec}" (F12)`;
  pill.classList.remove("hidden");
}

// =========================================================================
// 3. Find & Replace Bar (Ctrl+F / Ctrl+H) — File Editor + Notebooks
// =========================================================================

const frState = {
  open: false,
  replaceOpen: false,
  caseSensitive: false,
  matches: [], // { kind: "file"|"cell", cellId?, start, end }
  index: -1,
};

function computeFindMatches() {
  const query = document.getElementById("fr-find-input")?.value || "";
  const countEl = document.getElementById("fr-count");
  frState.matches = [];
  frState.index = -1;

  const tab = activeTab();
  if (!query || !tab) {
    if (countEl) countEl.textContent = "0 / 0";
    return;
  }

  const needle = frState.caseSensitive ? query : query.toLowerCase();

  if (tab.kind === "file") {
    const text = document.getElementById("file-editor-textarea")?.value || "";
    const hay = frState.caseSensitive ? text : text.toLowerCase();
    let from = 0;
    while (from <= hay.length) {
      const idx = hay.indexOf(needle, from);
      if (idx < 0) break;
      frState.matches.push({ kind: "file", start: idx, end: idx + query.length });
      from = idx + Math.max(1, query.length);
    }
  } else if (tab.kind === "notebook") {
    for (const cell of tab.doc.cells) {
      const text = cell.source || "";
      const hay = frState.caseSensitive ? text : text.toLowerCase();
      let from = 0;
      while (from <= hay.length) {
        const idx = hay.indexOf(needle, from);
        if (idx < 0) break;
        frState.matches.push({ kind: "cell", cellId: cell.id, start: idx, end: idx + query.length });
        from = idx + Math.max(1, query.length);
      }
    }
  }

  if (frState.matches.length > 0) {
    frState.index = 0;
    focusFindMatch(0, false);
  }
  updateFindCountLabel();
}

function updateFindCountLabel() {
  const countEl = document.getElementById("fr-count");
  if (!countEl) return;
  if (!frState.matches.length) {
    countEl.textContent = "0 / 0";
  } else {
    countEl.textContent = `${frState.index + 1} / ${frState.matches.length}`;
  }
}

function focusFindMatch(idx, stealFocus = true) {
  if (!frState.matches.length) return;
  const wrapped = ((idx % frState.matches.length) + frState.matches.length) % frState.matches.length;
  frState.index = wrapped;
  const m = frState.matches[wrapped];
  updateFindCountLabel();

  if (m.kind === "file") {
    const ta = document.getElementById("file-editor-textarea");
    if (!ta) return;
    const before = ta.value.slice(0, m.start);
    const lineNum = before.split("\n").length - 1;
    ta.setSelectionRange(m.start, m.end);
    ta.scrollTop = Math.max(0, lineNum * 21 - ta.clientHeight / 3);
    syncFileEditorScroll();
    if (stealFocus) ta.focus();
  } else if (m.kind === "cell") {
    const tab = activeTab();
    if (!tab || tab.kind !== "notebook") return;
    const cell = tab.doc.cells.find((c) => c.id === m.cellId);
    if (cell && cell.cell_type === "markdown" && !cell._editingMd) {
      cell._editingMd = true;
      updateSingleCellDom(tab, cell.id);
    }
    selectCell(m.cellId, false);
    const cellEl = document.querySelector(`.cell[data-cell-id="${m.cellId}"]`);
    const ta = cellEl?.querySelector("textarea");
    if (cellEl) cellEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (ta) {
      ta.setSelectionRange(m.start, m.end);
      if (stealFocus) ta.focus();
    }
  }
}

function replaceCurrentMatch() {
  if (!frState.matches.length || frState.index < 0) return;
  const repl = document.getElementById("fr-replace-input")?.value ?? "";
  const m = frState.matches[frState.index];
  const tab = activeTab();
  if (!tab) return;

  if (m.kind === "file" && tab.kind === "file") {
    const ta = document.getElementById("file-editor-textarea");
    if (!ta) return;
    ta.value = ta.value.slice(0, m.start) + repl + ta.value.slice(m.end);
    tab.content = ta.value;
    const isUi = tab.extension === "ui";
    const fileLang = langByExtension(tab.extension);
    syncFileEditorHighlight(tab.content, isUi ? "minilang" : (fileLang ? fileLang.id : null));
    markDirty(tab);
  } else if (m.kind === "cell" && tab.kind === "notebook") {
    const cell = tab.doc.cells.find((c) => c.id === m.cellId);
    if (!cell) return;
    cell.source = cell.source.slice(0, m.start) + repl + cell.source.slice(m.end);
    markDirty(tab);
    updateSingleCellDom(tab, cell.id);
  }

  const prevIdx = frState.index;
  computeFindMatches();
  if (frState.matches.length) {
    focusFindMatch(prevIdx, false);
  }
}

function replaceAllMatches() {
  const query = document.getElementById("fr-find-input")?.value || "";
  const repl = document.getElementById("fr-replace-input")?.value ?? "";
  const tab = activeTab();
  if (!query || !tab) return;

  const esc = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(esc, frState.caseSensitive ? "g" : "gi");
  let count = 0;

  if (tab.kind === "file") {
    const ta = document.getElementById("file-editor-textarea");
    if (!ta) return;
    const next = ta.value.replace(re, () => { count++; return repl; });
    if (count > 0) {
      ta.value = next;
      tab.content = next;
      const isUi = tab.extension === "ui";
      const fileLang = langByExtension(tab.extension);
      syncFileEditorHighlight(tab.content, isUi ? "minilang" : (fileLang ? fileLang.id : null));
      markDirty(tab);
    }
  } else if (tab.kind === "notebook") {
    for (const cell of tab.doc.cells) {
      const next = (cell.source || "").replace(re, () => { count++; return repl; });
      if (next !== cell.source) {
        cell.source = next;
      }
    }
    if (count > 0) {
      markDirty(tab);
      renderCells();
    }
  }

  toast(count > 0 ? `Replaced ${count} occurrence${count === 1 ? "" : "s"}` : "No matches to replace", count > 0 ? "success" : "info");
  computeFindMatches();
}

function openFindReplaceBar(showReplace = false) {
  const tab = activeTab();
  if (!tab || (tab.kind !== "file" && tab.kind !== "notebook")) return;
  const bar = document.getElementById("find-replace-bar");
  const repRow = document.getElementById("fr-replace-row");
  const inp = document.getElementById("fr-find-input");
  if (!bar || !inp) return;

  frState.open = true;
  frState.replaceOpen = showReplace;
  bar.classList.remove("hidden");
  repRow?.classList.toggle("hidden", !showReplace);

  // Pre-fill with selected text if any
  const activeEl = document.activeElement;
  if (activeEl && activeEl.tagName === "TEXTAREA") {
    const sel = activeEl.value.slice(activeEl.selectionStart, activeEl.selectionEnd);
    if (sel && !sel.includes("\n") && sel.length <= 120) {
      inp.value = sel;
    }
  }
  inp.focus();
  inp.select();
  computeFindMatches();
}

function closeFindReplaceBar() {
  frState.open = false;
  document.getElementById("find-replace-bar")?.classList.add("hidden");
}

export function initEditorTools() {
  const findInp = document.getElementById("fr-find-input");
  const repInp = document.getElementById("fr-replace-input");
  const caseBtn = document.getElementById("fr-case-btn");

  findInp?.addEventListener("input", computeFindMatches);
  findInp?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      focusFindMatch(frState.index + (e.shiftKey ? -1 : 1), false);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFindReplaceBar();
    }
  });
  repInp?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      replaceCurrentMatch();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFindReplaceBar();
    }
  });
  caseBtn?.addEventListener("click", () => {
    frState.caseSensitive = !frState.caseSensitive;
    caseBtn.classList.toggle("active", frState.caseSensitive);
    computeFindMatches();
  });
  document.getElementById("fr-prev-btn")?.addEventListener("click", () => focusFindMatch(frState.index - 1, false));
  document.getElementById("fr-next-btn")?.addEventListener("click", () => focusFindMatch(frState.index + 1, false));
  document.getElementById("fr-toggle-replace")?.addEventListener("click", () => {
    frState.replaceOpen = !frState.replaceOpen;
    document.getElementById("fr-replace-row")?.classList.toggle("hidden", !frState.replaceOpen);
    if (frState.replaceOpen) repInp?.focus();
  });
  document.getElementById("fr-replace-btn")?.addEventListener("click", replaceCurrentMatch);
  document.getElementById("fr-replace-all-btn")?.addEventListener("click", replaceAllMatches);
  document.getElementById("fr-close-btn")?.addEventListener("click", closeFindReplaceBar);

  document.getElementById("file-diag-clear")?.addEventListener("click", () => {
    const tab = activeTab();
    if (tab) clearFileDiagnostics(tab);
  });

  document.getElementById("editor-goto-pill")?.addEventListener("click", () => {
    if (activeGotoTarget) {
      resolveAndOpenImport(activeGotoTarget.spec, activeGotoTarget.isRustMod);
    }
  });

  // Track cursor in File Editor & Notebook code cells for Go-to-Definition
  const fileTa = document.getElementById("file-editor-textarea");
  if (fileTa) {
    fileTa.addEventListener("keyup", () => updateGotoPillForTextarea(fileTa));
    fileTa.addEventListener("click", (e) => {
      updateGotoPillForTextarea(fileTa);
      if ((e.ctrlKey || e.metaKey) && activeGotoTarget) {
        e.preventDefault();
        resolveAndOpenImport(activeGotoTarget.spec, activeGotoTarget.isRustMod);
      }
    });
    fileTa.addEventListener("input", () => {
      const tab = activeTab();
      if (tab) clearFileDiagnostics(tab);
    });
  }

  document.addEventListener("click", (e) => {
    const ta = e.target;
    if (ta && ta.classList && ta.classList.contains("code-textarea")) {
      updateGotoPillForTextarea(ta);
      if ((e.ctrlKey || e.metaKey) && activeGotoTarget) {
        e.preventDefault();
        resolveAndOpenImport(activeGotoTarget.spec, activeGotoTarget.isRustMod);
      }
    }
  });

  document.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === "f") {
      const tab = activeTab();
      if (tab && (tab.kind === "file" || tab.kind === "notebook")) {
        e.preventDefault();
        openFindReplaceBar(false);
      }
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === "h") {
      const tab = activeTab();
      if (tab && (tab.kind === "file" || tab.kind === "notebook")) {
        e.preventDefault();
        openFindReplaceBar(true);
      }
    } else if (e.key === "F12") {
      const el = document.activeElement;
      if (el && el.tagName === "TEXTAREA") {
        const hit = findImportAtCursor(el.value, el.selectionStart || 0);
        if (hit) {
          e.preventDefault();
          resolveAndOpenImport(hit.spec, hit.isRustMod);
        }
      }
    } else if (e.key === "Escape" && frState.open) {
      closeFindReplaceBar();
    }
  });
}

export {
  parseDiagnosticsFromError,
  jumpToFileEditorLine,
  applyFileDiagnostics,
  clearFileDiagnostics,
  renderFileDiagnostics,
  openFindReplaceBar,
  closeFindReplaceBar,
  resolveAndOpenImport,
};
