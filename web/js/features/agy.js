/**
 * Google Antigravity (`agy`) Inline AI Assistant for Notebook Cells & Script Files.
 */

import { escapeHtml } from "../core/highlight.js";
import { renderMarkdown } from "../core/markdown.js";
import { api } from "../core/auth.js";
import { toast, uid, formatSize } from "../core/ui_helpers.js";
import { langByExtension, activeTab, markDirty, updateStatusBar } from "../core/state.js";
import { hydrateMediaPreviews } from "./media.js";
import { syncFileEditorHighlight, syncFileEditorScroll } from "./viewers.js";
import { updateSingleCellDom, renderCells } from "./notebook.js";

// --- Google Antigravity (agy) Inline Assistant (Cells & Script Files) ---
function formatOutputErrorForAgy(output) {
  if (!output || !output.error) return null;
  const e = output.error;
  return `${e.error_type || "Error"}: ${e.message || ""}${e.traceback ? `\n${e.traceback}` : ""}`;
}

function toggleCellAgy(tab, cell, forceOpen = false) {
  cell._agyOpen = forceOpen ? true : !cell._agyOpen;
  updateSingleCellDom(tab, cell.id);
  if (cell._agyOpen) {
    setTimeout(() => {
      document.querySelector(`.cell[data-cell-id="${cell.id}"] .cell-agy-input`)?.focus();
    }, 20);
  }
}

async function runCellAgy(tab, cell, promptText, action = "ask") {
  const prompt = (promptText || "").trim();
  if (!prompt) return;
  if (cell._agyLoading && cell._agyRequestId) {
    api("/api/agy/cancel", { method: "POST", body: JSON.stringify({ request_id: cell._agyRequestId }) }).catch(() => {});
  }

  const idx = tab.doc.cells.findIndex((c) => c.id === cell.id);
  const surrounding = tab.doc.cells
    .slice(0, Math.max(0, idx))
    .filter((c) => c.cell_type === "code" && c.source.trim())
    .map((c) => c.source);

  const reqId = `agy-${uid().slice(0, 10)}`;
  cell._agyOpen = true;
  cell._agyPrompt = prompt;
  cell._agyLoading = true;
  cell._agyRequestId = reqId;
  cell._agyError = null;
  updateSingleCellDom(tab, cell.id);

  try {
    const data = await api("/api/agy/assist", {
      method: "POST",
      body: JSON.stringify({
        request_id: reqId,
        prompt,
        action,
        kind: "cell",
        language: cell.cell_type === "markdown" ? "markdown" : (tab.doc.language || "minilang"),
        path: tab.path || tab.title,
        code: cell.source || "",
        error: formatOutputErrorForAgy(cell.output),
        stdout: cell.output?.stdout || null,
        surrounding_cells: surrounding,
        conversation_id: cell._agyConvId || null,
      }),
    });
    if (cell._agyRequestId !== reqId) return;
    cell._agyResponse = data.response || "";
    cell._agySuggestedCode = data.suggested_code || null;
    cell._agyConvId = data.conversation_id || cell._agyConvId || null;
    cell._agyDurationMs = data.duration_ms || null;
  } catch (err) {
    if (cell._agyRequestId !== reqId) return;
    cell._agyError = err.message;
  } finally {
    if (cell._agyRequestId === reqId) {
      cell._agyLoading = false;
      cell._agyRequestId = null;
      updateSingleCellDom(tab, cell.id);
    }
  }
}

function buildCellAgyPanel(tab, cell) {
  const panel = document.createElement("div");
  panel.className = "cell-agy-panel";
  panel.addEventListener("mousedown", (e) => e.stopPropagation());

  const hasErr = !!(cell.output && cell.output.error);
  const statusText = cell._agyLoading
    ? "Thinking with agy..."
    : (typeof cell._agyDurationMs === "number" ? `${(cell._agyDurationMs / 1000).toFixed(1)}s` : "");

  panel.innerHTML = `
    <div class="agy-header">
      <div class="agy-title-wrap">
        <span class="agy-spark">✦</span>
        <strong>Antigravity (agy)</strong>
        <span class="tb-meta">${escapeHtml(statusText)}</span>
      </div>
      <div class="toolbar-group">
        ${cell._agyConvId ? `<button type="button" class="tb-btn agy-cell-reset" style="height:22px;font-size:11px;padding:0 7px">New Thread</button>` : ""}
        <button type="button" class="icon-btn sm agy-cell-close" title="Close">&times;</button>
      </div>
    </div>
    <div class="agy-chips">
      ${hasErr ? `<button type="button" class="agy-chip emph" data-action="fix" data-prompt="Diagnose and fix this error.">Fix Error</button>` : ""}
      <button type="button" class="agy-chip" data-action="explain" data-prompt="Explain what this cell does.">Explain</button>
      <button type="button" class="agy-chip" data-action="improve" data-prompt="Improve and clean up this cell.">Improve</button>
      <button type="button" class="agy-chip" data-action="generate" data-prompt="Write a clean example for this cell.">Generate</button>
    </div>
    <div class="agy-prompt-row">
      <input class="agy-input cell-agy-input" type="text" placeholder="Ask agy about this cell... (Enter to send, Esc to close)" value="${escapeHtml(cell._agyPrompt || "")}" ${cell._agyLoading ? "disabled" : ""} />
      ${cell._agyLoading
        ? `<button type="button" class="tb-btn danger-hover agy-cell-cancel">Cancel</button>`
        : `<button type="button" class="tb-btn primary agy-cell-send">Ask</button>`}
    </div>
    ${(cell._agyError || cell._agyResponse) ? `
      <div class="agy-response-wrap">
        <div class="agy-response ${cell._agyError ? "is-error" : "md-rendered"}">
          ${cell._agyError ? escapeHtml(cell._agyError) : renderMarkdown(cell._agyResponse)}
        </div>
        ${(!cell._agyError && cell._agySuggestedCode) ? `
          <div class="agy-apply-bar">
            <button type="button" class="tb-btn primary agy-cell-replace">Replace Cell</button>
            <button type="button" class="tb-btn agy-cell-insert">Insert Cell Below</button>
            <button type="button" class="tb-btn agy-cell-copy">Copy Code</button>
          </div>
        ` : ""}
      </div>
    ` : ""}
  `;

  hydrateMediaPreviews(panel);

  const input = panel.querySelector(".cell-agy-input");
  input?.addEventListener("input", (e) => { cell._agyPrompt = e.target.value; });
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runCellAgy(tab, cell, input.value, "ask");
    } else if (e.key === "Escape") {
      e.preventDefault();
      cell._agyOpen = false;
      updateSingleCellDom(tab, cell.id);
    }
  });

  panel.querySelector(".agy-cell-send")?.addEventListener("click", () => {
    runCellAgy(tab, cell, input?.value || "", "ask");
  });
  panel.querySelector(".agy-cell-cancel")?.addEventListener("click", () => {
    if (cell._agyRequestId) {
      api("/api/agy/cancel", { method: "POST", body: JSON.stringify({ request_id: cell._agyRequestId }) }).catch(() => {});
    }
  });
  panel.querySelector(".agy-cell-close")?.addEventListener("click", () => {
    cell._agyOpen = false;
    updateSingleCellDom(tab, cell.id);
  });
  panel.querySelector(".agy-cell-reset")?.addEventListener("click", () => {
    cell._agyConvId = null;
    cell._agyResponse = "";
    cell._agySuggestedCode = null;
    cell._agyError = null;
    cell._agyDurationMs = null;
    updateSingleCellDom(tab, cell.id);
  });
  panel.querySelectorAll(".agy-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      runCellAgy(tab, cell, chip.dataset.prompt, chip.dataset.action);
    });
  });
  panel.querySelector(".agy-cell-replace")?.addEventListener("click", () => {
    if (cell._agySuggestedCode == null) return;
    cell.source = cell._agySuggestedCode;
    markDirty(tab);
    updateSingleCellDom(tab, cell.id);
    toast("Applied agy code to cell", "success");
  });
  panel.querySelector(".agy-cell-insert")?.addEventListener("click", () => {
    if (cell._agySuggestedCode == null) return;
    const idx = tab.doc.cells.findIndex((c) => c.id === cell.id);
    const newCell = { id: uid(), cell_type: "code", source: cell._agySuggestedCode, execution_count: null, output: null };
    tab.doc.cells.splice(idx + 1, 0, newCell);
    tab.activeCellId = newCell.id;
    markDirty(tab);
    renderCells();
    toast("Inserted new cell with agy code", "success");
  });
  panel.querySelector(".agy-cell-copy")?.addEventListener("click", () => {
    if (cell._agySuggestedCode != null) {
      navigator.clipboard?.writeText(cell._agySuggestedCode).catch(() => {});
      toast("Copied code to clipboard", "success");
    }
  });

  return panel;
}

// --- Script File agy Panel ---
function captureFileSelection(tab) {
  const ta = document.getElementById("file-editor-textarea");
  if (!ta) return;
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  if (typeof s === "number" && typeof e === "number" && e > s) {
    tab._agySelStart = s;
    tab._agySelEnd = e;
    tab._agySelText = ta.value.slice(s, e);
  } else {
    tab._agySelStart = null;
    tab._agySelEnd = null;
    tab._agySelText = null;
  }
}

function renderFileAgyPanel(tab) {
  const panel = document.getElementById("file-agy-panel");
  const selBadge = document.getElementById("file-agy-selection-badge");
  const statusEl = document.getElementById("file-agy-status");
  const input = document.getElementById("file-agy-input");
  const sendBtn = document.getElementById("btn-file-agy-send");
  const cancelBtn = document.getElementById("btn-file-agy-cancel");
  const respWrap = document.getElementById("file-agy-response-wrap");
  const respEl = document.getElementById("file-agy-response");
  const applyBar = document.getElementById("file-agy-apply-bar");
  const repSelBtn = document.getElementById("btn-file-agy-replace-sel");
  if (!panel || !tab) return;

  panel.classList.toggle("hidden", !tab._agyOpen);
  if (!tab._agyOpen) return;

  if (tab._agySelText) {
    const lineCount = tab._agySelText.split("\n").length;
    selBadge.textContent = `Selection (${lineCount} ${lineCount === 1 ? "line" : "lines"})`;
    selBadge.classList.remove("hidden");
  } else {
    selBadge.classList.add("hidden");
  }

  statusEl.textContent = tab._agyLoading
    ? "Thinking with agy..."
    : (typeof tab._agyDurationMs === "number" ? `${(tab._agyDurationMs / 1000).toFixed(1)}s` : "");

  input.disabled = !!tab._agyLoading;
  sendBtn.classList.toggle("hidden", !!tab._agyLoading);
  cancelBtn.classList.toggle("hidden", !tab._agyLoading);

  if (tab._agyError) {
    respWrap.classList.remove("hidden");
    respEl.className = "agy-response is-error";
    respEl.textContent = tab._agyError;
    applyBar.classList.add("hidden");
  } else if (tab._agyResponse) {
    respWrap.classList.remove("hidden");
    respEl.className = "agy-response md-rendered";
    respEl.innerHTML = renderMarkdown(tab._agyResponse);
    hydrateMediaPreviews(respEl);
    const hasCode = !!tab._agySuggestedCode;
    applyBar.classList.toggle("hidden", !hasCode);
    repSelBtn.classList.toggle("hidden", !(hasCode && tab._agySelText));
  } else {
    respWrap.classList.add("hidden");
  }
}

function openFileAgyPanel(tab) {
  if (!tab || tab.kind !== "file") return;
  captureFileSelection(tab);
  tab._agyOpen = true;
  document.getElementById("file-invoke-panel")?.classList.add("hidden");
  renderFileAgyPanel(tab);
  setTimeout(() => document.getElementById("file-agy-input")?.focus(), 20);
}

async function runFileAgy(tab, promptText, action = "ask") {
  const prompt = (promptText || "").trim();
  if (!tab || !prompt) return;
  if (tab._agyLoading && tab._agyRequestId) {
    api("/api/agy/cancel", { method: "POST", body: JSON.stringify({ request_id: tab._agyRequestId }) }).catch(() => {});
  }

  const reqId = `agy-${uid().slice(0, 10)}`;
  const fileLang = tab.extension === "ui" ? "ui" : (langByExtension(tab.extension)?.id || tab.extension || "text");
  tab._agyOpen = true;
  tab._agyLoading = true;
  tab._agyRequestId = reqId;
  tab._agyError = null;
  renderFileAgyPanel(tab);

  try {
    const data = await api("/api/agy/assist", {
      method: "POST",
      body: JSON.stringify({
        request_id: reqId,
        prompt,
        action,
        kind: "file",
        language: fileLang,
        path: tab.path || tab.title,
        code: tab.content || "",
        selection: tab._agySelText || null,
        error: formatOutputErrorForAgy(tab._lastRunOutput),
        stdout: tab._lastRunOutput?.stdout || null,
        conversation_id: tab._agyConvId || null,
      }),
    });
    if (tab._agyRequestId !== reqId) return;
    tab._agyResponse = data.response || "";
    tab._agySuggestedCode = data.suggested_code || null;
    tab._agyConvId = data.conversation_id || tab._agyConvId || null;
    tab._agyDurationMs = data.duration_ms || null;
  } catch (err) {
    if (tab._agyRequestId !== reqId) return;
    tab._agyError = err.message;
  } finally {
    if (tab._agyRequestId === reqId) {
      tab._agyLoading = false;
      tab._agyRequestId = null;
      if (activeTab()?.id === tab.id) renderFileAgyPanel(tab);
    }
  }
}

function applyFileContentChange(tab, nextContent) {
  tab.content = nextContent;
  markDirty(tab);
  const ta = document.getElementById("file-editor-textarea");
  ta.value = nextContent;
  const isUi = tab.extension === "ui";
  const fileLang = langByExtension(tab.extension);
  syncFileEditorHighlight(nextContent, isUi ? "minilang" : (fileLang ? fileLang.id : null));
  syncFileEditorScroll();
  document.getElementById("ftb-meta").textContent = `${tab.path} (${formatSize(nextContent.length)})`;
}


export function initAgyControls() {
  document.getElementById("ftb-agy")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab.kind !== "file") return;
    if (tab._agyOpen) {
      tab._agyOpen = false;
      renderFileAgyPanel(tab);
    } else {
      openFileAgyPanel(tab);
    }
  });

  document.getElementById("btn-file-agy-close")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab) return;
    tab._agyOpen = false;
    renderFileAgyPanel(tab);
  });

  document.getElementById("btn-file-agy-reset")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab) return;
    tab._agyConvId = null;
    tab._agyResponse = "";
    tab._agySuggestedCode = null;
    tab._agyError = null;
    tab._agyDurationMs = null;
    document.getElementById("file-agy-input").value = "";
    renderFileAgyPanel(tab);
  });

  document.getElementById("btn-file-agy-send")?.addEventListener("click", () => {
    const tab = activeTab();
    const input = document.getElementById("file-agy-input");
    if (tab && input) runFileAgy(tab, input.value, "ask");
  });

  document.getElementById("btn-file-agy-cancel")?.addEventListener("click", () => {
    const tab = activeTab();
    if (tab && tab._agyRequestId) {
      api("/api/agy/cancel", { method: "POST", body: JSON.stringify({ request_id: tab._agyRequestId }) }).catch(() => {});
    }
  });

  document.getElementById("file-agy-input")?.addEventListener("keydown", (e) => {
    const tab = activeTab();
    if (!tab) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runFileAgy(tab, e.target.value, "ask");
    } else if (e.key === "Escape") {
      e.preventDefault();
      tab._agyOpen = false;
      renderFileAgyPanel(tab);
    }
  });

  document.querySelectorAll("[data-file-agy-action]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const tab = activeTab();
      if (!tab) return;
      document.getElementById("file-agy-input").value = chip.dataset.fileAgyPrompt;
      runFileAgy(tab, chip.dataset.fileAgyPrompt, chip.dataset.fileAgyAction);
    });
  });

  document.getElementById("btn-file-agy-replace-sel")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab._agySuggestedCode == null || tab._agySelStart == null || tab._agySelEnd == null) return;
    const next = tab.content.slice(0, tab._agySelStart) + tab._agySuggestedCode + tab.content.slice(tab._agySelEnd);
    tab._agySelStart = null;
    tab._agySelEnd = null;
    tab._agySelText = null;
    applyFileContentChange(tab, next);
    renderFileAgyPanel(tab);
    toast("Replaced selection with agy code", "success");
  });

  document.getElementById("btn-file-agy-replace-all")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab._agySuggestedCode == null) return;
    applyFileContentChange(tab, tab._agySuggestedCode);
    toast("Replaced file content with agy code", "success");
  });

  document.getElementById("btn-file-agy-append")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab._agySuggestedCode == null) return;
    const sep = tab.content.endsWith("\n") || !tab.content ? "" : "\n";
    applyFileContentChange(tab, `${tab.content}${sep}\n${tab._agySuggestedCode}\n`);
    toast("Appended agy code to file", "success");
  });

  document.getElementById("btn-file-agy-copy")?.addEventListener("click", () => {
    const tab = activeTab();
    if (tab && tab._agySuggestedCode != null) {
      navigator.clipboard?.writeText(tab._agySuggestedCode).catch(() => {});
      toast("Copied code to clipboard", "success");
    }
  });
}

export {
  formatOutputErrorForAgy,
  toggleCellAgy,
  runCellAgy,
  buildCellAgyPanel,
  captureFileSelection,
  renderFileAgyPanel,
  openFileAgyPanel,
  runFileAgy,
  applyFileContentChange,
};
