/**
 * Interactive Notebook Engine: cell rendering, code editor keyboard/autocomplete,
 * SSE streaming execution, kernel lifecycle controls, and Variable Inspector drawer.
 */

import { escapeHtml, highlightCode } from "../core/highlight.js";
import { renderMarkdown } from "../core/markdown.js";
import { api, authFetch } from "../core/auth.js";
import { toast, uid } from "../core/ui_helpers.js";
import { state, langInfo, activeTab, markDirty, updateStatusBar } from "../core/state.js";
import { rawFileUrl, renderMediaThumbnailCard, hydrateMediaPreviews } from "./media.js";
import { saveActiveTab, exportAsMini, renderActiveWorkspace } from "./viewers.js";
import { buildCellAgyPanel, toggleCellAgy, runCellAgy, formatOutputErrorForAgy } from "./agy.js";
import { startDebuggingCell } from "./debugger.js";

async function ensureKernel(sessionId, cwdPath = "", language = "minilang") {
  const body = { session_id: sessionId, language };
  if (cwdPath) body.cwd = cwdPath;
  const status = await api("/api/kernels", { method: "POST", body: JSON.stringify(body) });
  refreshKernelList();
  return status;
}

// --- Notebook Cell Rendering ---
function renderOutputHtml(output, execCount) {
  if (!output) return "";
  let rows = "";

  // 1. stdout
  if (output.stdout) {
    rows += `
      <div class="output-row">
        <div class="output-gutter"></div>
        <div class="output-body">
          <pre class="output-stdout">${escapeHtml(output.stdout)}</pre>
        </div>
      </div>`;
  }

  // 0. live streaming status indicator (e.g. Compiling with Cargo...)
  if (output._streamStatus) {
    rows += `
      <div class="output-row">
        <div class="output-gutter"></div>
        <div class="output-body"><div class="ml-stream-status"><span class="status-dot busy"></span>${escapeHtml(output._streamStatus)}</div></div>
      </div>`;
  }

  // 2. rich displays
  if (Array.isArray(output.displays)) {
    output.displays.forEach((d, idx) => {
      let rendered = "";
      if (d.mime === "application/vnd.minilang.ui+json") {
        rendered = `<div class="mlui-mount-slot" data-ui-idx="${idx}"></div>`;
      } else if (d.mime === "application/vnd.minilang.table+json") {
        rendered = `<div class="ml-table-mount-slot" data-viz-idx="${idx}"></div>`;
      } else if (d.mime === "application/vnd.minilang.chart+json") {
        rendered = `<div class="ml-chart-mount-slot" data-viz-idx="${idx}"></div>`;
      } else if (d.mime === "application/vnd.minilang.progress+json") {
        try {
          const p = JSON.parse(d.data);
          const pct = Math.max(0, Math.min(100, Number(p.percent ?? 0)));
          const label = p.label ? escapeHtml(p.label) : "Progress";
          const ratio = p.total != null ? `${p.done ?? 0} / ${p.total}` : `${pct.toFixed(0)}%`;
          rendered = `
            <div class="ml-progress-card">
              <div class="ml-progress-head"><span>${label}</span><span>${escapeHtml(ratio)} (${pct.toFixed(0)}%)</span></div>
              <div class="ml-progress-track"><div class="ml-progress-fill" style="width:${pct}%"></div></div>
            </div>`;
        } catch {
          rendered = `<pre class="output-stdout">${escapeHtml(d.data)}</pre>`;
        }
      } else if (d.mime === "application/vnd.minilang.media+json") {
        try {
          const info = JSON.parse(d.data);
          const src = info.path ? rawFileUrl(info.path) : (info.url || "");
          rendered = renderMediaThumbnailCard({
            kind: info.kind === "pdf" ? "pdf" : "image",
            src,
            path: info.path || null,
            name: info.name || (info.path ? info.path.split("/").pop() : "Media"),
            mime: info.mime || "",
            size: typeof info.size === "number" ? info.size : null,
          });
        } catch {
          rendered = `<pre class="output-stdout">${escapeHtml(d.data)}</pre>`;
        }
      } else if (d.mime === "application/pdf") {
        const dataUrl = d.data.startsWith("data:") ? d.data : `data:application/pdf;base64,${d.data}`;
        rendered = renderMediaThumbnailCard({
          kind: "pdf",
          src: dataUrl,
          path: null,
          name: `document_${idx + 1}.pdf`,
          mime: "application/pdf",
        });
      } else if (d.mime === "image/svg+xml") {
        const svgTrim = (d.data || "").trim();
        const dataUrl = svgTrim.startsWith("data:")
          ? svgTrim
          : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgTrim)}`;
        rendered = renderMediaThumbnailCard({
          kind: "image",
          src: dataUrl,
          path: null,
          name: `graphic_${idx + 1}.svg`,
          mime: "image/svg+xml",
        });
      } else if (d.mime && d.mime.startsWith("image/")) {
        const dataUrl = d.data.startsWith("data:") ? d.data : `data:${d.mime};base64,${d.data}`;
        const ext = d.mime.split("/")[1]?.split("+")[0] || "png";
        rendered = renderMediaThumbnailCard({
          kind: "image",
          src: dataUrl,
          path: null,
          name: `image_${idx + 1}.${ext}`,
          mime: d.mime,
        });
      } else if (d.mime === "text/html") {
        rendered = `<div class="output-rich-html">${d.data}</div>`;
      } else if (d.mime === "text/markdown") {
        rendered = `<div class="md-rendered" style="padding:2px 0">${renderMarkdown(d.data)}</div>`;
      } else {
        rendered = `<pre class="output-stdout">${escapeHtml(d.data)}</pre>`;
      }
      rows += `
        <div class="output-row">
          <div class="output-gutter"></div>
          <div class="output-body">${rendered}</div>
        </div>`;
    });
  }

  // 3. evaluated value (Jupyter-style: show the last expression's result if non-nil;
  //    if last is nil and no stdout/displays, show dimmed nil)
  if (Array.isArray(output.results) && output.results.length > 0 && !output.error) {
    const last = output.results[output.results.length - 1];
    const chosen = !last.is_nil
      ? last
      : (!output.stdout && (!output.displays || output.displays.length === 0) ? last : null);

    if (chosen) {
      const dur = typeof output.duration_ms === "number" ? `${output.duration_ms.toFixed(1)} ms` : "";
      rows += `
        <div class="output-row">
          <div class="output-gutter">${execCount != null ? `Out[${execCount}]:` : ""}</div>
          <div class="output-body">
            <div class="output-value-card">
              <pre class="output-value-pre ${chosen.is_nil ? "is-nil" : ""}">${escapeHtml(chosen.repr)}</pre>
              <div class="output-meta-badges">
                <span class="type-badge">${escapeHtml(chosen.type_name)}</span>
                ${dur ? `<span class="duration-badge">${dur}</span>` : ""}
              </div>
            </div>
          </div>
        </div>`;
    }
  }

  // 4. error
  if (output.error) {
    rows += `
      <div class="output-row">
        <div class="output-gutter" style="color:var(--accent-red)">Err:</div>
        <div class="output-body">
          <div class="output-error">
            <div class="output-error-head">
              <div class="output-error-title">${escapeHtml(output.error.error_type)}: ${escapeHtml(output.error.message)}</div>
              <button type="button" class="fix-agy-btn" title="Ask Google Antigravity (agy) to diagnose and fix this error">✦ Fix with agy</button>
            </div>
            ${output.error.traceback ? `<pre class="output-error-tb">${escapeHtml(output.error.traceback)}</pre>` : ""}
          </div>
        </div>
      </div>`;
  }

  if (!rows) return "";
  return `<div class="cell-output-area">${rows}</div>`;
}

function renderCells() {
  const tab = activeTab();
  if (!tab || tab.kind !== "notebook") return;
  const container = document.getElementById("cells-container");
  container.innerHTML = "";

  for (const cell of tab.doc.cells) {
    const el = buildCellElement(tab, cell);
    container.appendChild(el);
  }
  updateStatusBar();
}

function buildCellElement(tab, cell) {
  const el = document.createElement("div");
  const hasOutput = !!(cell.output && (
    cell.output._streamStatus ||
    cell.output.stdout ||
    (cell.output.displays && cell.output.displays.length) ||
    (cell.output.results && cell.output.results.length) ||
    cell.output.error
  ));
  el.className = [
    "cell",
    cell.id === tab.activeCellId ? "active" : "",
    cell._running ? "running" : "",
    cell.output && cell.output.error ? "has-error" : "",
    hasOutput ? "has-output" : "",
  ].filter(Boolean).join(" ");
  el.dataset.cellId = cell.id;

  // Floating toolbar
  const toolbar = document.createElement("div");
  toolbar.className = "cell-toolbar";
  toolbar.innerHTML = `
    <button class="icon-btn sm ct-agy" title="Ask Google Antigravity (agy) about this cell (Ctrl+K)">
      <span>✦ agy</span>
    </button>
    <button class="icon-btn sm ct-run" title="Run Cell (Shift+Enter)">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
    </button>
    ${cell.cell_type === "code" && (tab.doc.language || "minilang") === "minilang" ? `
    <button class="icon-btn sm ct-debug" title="Debug Minilang Cell">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="6" width="8" height="14" rx="4"/><path d="M10 6V4a2 2 0 1 1 4 0v2"/><line x1="3" y1="10" x2="8" y2="10"/><line x1="16" y1="10" x2="21" y2="10"/><line x1="3" y1="15" x2="8" y2="15"/><line x1="16" y1="15" x2="21" y2="15"/></svg>
    </button>` : ""}
    <button class="icon-btn sm ct-type" title="Switch Code / Markdown">
      <span style="font-size:10px;font-weight:700;font-family:var(--font-mono)">${cell.cell_type === "code" ? "MD" : "ML"}</span>
    </button>
    <button class="icon-btn sm ct-up" title="Move Up">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>
    </button>
    <button class="icon-btn sm ct-down" title="Move Down">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <button class="icon-btn sm ct-add" title="Insert Cell Below">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
    <button class="icon-btn sm ct-del" title="Delete Cell">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
    </button>
  `;
  toolbar.querySelector(".ct-agy").onclick = (e) => {
    e.stopPropagation();
    toggleCellAgy(tab, cell);
  };
  toolbar.querySelector(".ct-run").onclick = (e) => { e.stopPropagation(); runCell(cell.id); };
  const ctDbg = toolbar.querySelector(".ct-debug");
  if (ctDbg) {
    ctDbg.onclick = (e) => {
      e.stopPropagation();
      startDebuggingCell(tab, cell);
    };
  }
  toolbar.querySelector(".ct-type").onclick = (e) => { e.stopPropagation(); toggleCellType(cell.id); };
  toolbar.querySelector(".ct-up").onclick = (e) => { e.stopPropagation(); moveCell(cell.id, -1); };
  toolbar.querySelector(".ct-down").onclick = (e) => { e.stopPropagation(); moveCell(cell.id, 1); };
  toolbar.querySelector(".ct-add").onclick = (e) => { e.stopPropagation(); insertCellAfter(cell.id, "code"); };
  toolbar.querySelector(".ct-del").onclick = (e) => { e.stopPropagation(); deleteCell(cell.id); };
  el.appendChild(toolbar);

  const row = document.createElement("div");
  row.className = "cell-input-row";

  const gutter = document.createElement("div");
  gutter.className = "cell-gutter";
  if (cell.cell_type === "code") {
    const prompt = cell._running ? "In [*]:" : (cell.execution_count != null ? `In [${cell.execution_count}]:` : "In [ ]:");
    gutter.innerHTML = `
      <span>${prompt}</span>
      <button class="cell-run-mini" title="Run cell (Shift+Enter)">
        <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>
      </button>`;
    gutter.querySelector(".cell-run-mini").onclick = (e) => {
      e.stopPropagation();
      runCell(cell.id);
    };
  } else {
    gutter.innerHTML = `<span style="opacity:0.6">MD</span>`;
  }
  row.appendChild(gutter);

  if (cell.cell_type === "code") {
    const wrap = document.createElement("div");
    wrap.className = "cell-editor-wrap";

    const cellLang = tab.doc.language || "minilang";
    const pre = document.createElement("pre");
    pre.className = "code-highlight";
    pre.setAttribute("aria-hidden", "true");
    pre.innerHTML = highlightCode(cell.source, cellLang);

    const ta = document.createElement("textarea");
    ta.className = "code-textarea";
    ta.spellcheck = false;
    ta.autocomplete = "off";
    ta.autocapitalize = "off";
    ta.value = cell.source;
    ta.placeholder = `Enter ${langInfo(cellLang).name} code... (Shift+Enter to run)`;

    ta.addEventListener("focus", () => selectCell(cell.id, false));
    ta.addEventListener("input", () => {
      cell.source = ta.value;
      pre.innerHTML = highlightCode(ta.value, tab.doc.language || "minilang");
      markDirty(tab);
      hideAutocomplete();
    });
    ta.addEventListener("keydown", (e) => handleCodeKeydown(e, tab, cell, ta, pre));

    wrap.appendChild(pre);
    wrap.appendChild(ta);
    row.appendChild(wrap);
  } else {
    // Markdown cell
    if (cell._editingMd) {
      const wrap = document.createElement("div");
      wrap.className = "cell-editor-wrap";
      const ta = document.createElement("textarea");
      ta.className = "md-textarea";
      ta.value = cell.source;
      ta.placeholder = "Write Markdown... (Shift+Enter to render)";
      const resizeMd = () => {
        ta.style.height = "auto";
        ta.style.height = Math.max(76, ta.scrollHeight) + "px";
      };
      ta.addEventListener("focus", () => selectCell(cell.id, false));
      ta.addEventListener("input", () => {
        cell.source = ta.value;
        markDirty(tab);
        resizeMd();
      });
      ta.addEventListener("keydown", (e) => {
        if ((e.shiftKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          cell._editingMd = false;
          updateSingleCellDom(tab, cell.id);
          if (e.shiftKey) focusNextCell(tab, cell.id);
        } else if (e.key === "Escape") {
          cell._editingMd = false;
          updateSingleCellDom(tab, cell.id);
        }
      });
      wrap.appendChild(ta);
      row.appendChild(wrap);
      setTimeout(() => { resizeMd(); ta.focus(); }, 0);
    } else {
      const mdDiv = document.createElement("div");
      mdDiv.className = "md-rendered";
      mdDiv.innerHTML = renderMarkdown(cell.source);
      hydrateMediaPreviews(mdDiv);
      mdDiv.ondblclick = () => {
        cell._editingMd = true;
        selectCell(cell.id, false);
        updateSingleCellDom(tab, cell.id);
      };
      row.appendChild(mdDiv);
    }
  }

  el.appendChild(row);

  // Inline Antigravity (agy) assistant panel for this cell
  if (cell._agyOpen) {
    el.appendChild(buildCellAgyPanel(tab, cell));
  }

  // Output
  if (cell.cell_type === "code" && hasOutput) {
    const outWrap = document.createElement("div");
    outWrap.innerHTML = renderOutputHtml(cell.output, cell.execution_count);
    if (outWrap.firstElementChild) {
      const outNode = outWrap.firstElementChild;
      el.appendChild(outNode);
      hydrateUiDisplays(outNode, cell.output);
      hydrateMediaPreviews(outNode);
      outNode.querySelector(".fix-agy-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        cell._agyOpen = true;
        updateSingleCellDom(tab, cell.id);
        runCellAgy(tab, cell, "Diagnose and fix this error.", "fix");
      });
    }
  }

  el.addEventListener("mousedown", () => {
    if (tab.activeCellId !== cell.id) selectCell(cell.id, false);
  });

  return el;
}

function hydrateUiDisplays(container, output) {
  if (!output || !Array.isArray(output.displays)) return;
  if (window.MinijsUI) {
    container.querySelectorAll(".mlui-mount-slot").forEach((slot) => {
      const idx = Number(slot.dataset.uiIdx);
      const item = output.displays[idx];
      if (item && item.mime === "application/vnd.minilang.ui+json") {
        window.MinijsUI.mount(slot, item.data);
      }
    });
  }
  if (window.MlnbViz) {
    container.querySelectorAll(".ml-table-mount-slot").forEach((slot) => {
      const idx = Number(slot.dataset.vizIdx);
      const item = output.displays[idx];
      if (item && item.mime === "application/vnd.minilang.table+json") {
        window.MlnbViz.mountTable(slot, item.data);
      }
    });
    container.querySelectorAll(".ml-chart-mount-slot").forEach((slot) => {
      const idx = Number(slot.dataset.vizIdx);
      const item = output.displays[idx];
      if (item && item.mime === "application/vnd.minilang.chart+json") {
        window.MlnbViz.mountChart(slot, item.data);
      }
    });
  }
}

function updateSingleCellDom(tab, cellId) {
  const cell = tab.doc.cells.find((c) => c.id === cellId);
  const oldEl = document.querySelector(`.cell[data-cell-id="${cellId}"]`);
  if (!cell || !oldEl) return;
  const newEl = buildCellElement(tab, cell);
  oldEl.replaceWith(newEl);
}

function selectCell(cellId, shouldFocus = true) {
  const tab = activeTab();
  if (!tab || tab.kind !== "notebook") return;
  tab.activeCellId = cellId;
  document.querySelectorAll(".cell").forEach((el) => {
    el.classList.toggle("active", el.dataset.cellId === cellId);
  });
  if (shouldFocus) {
    const el = document.querySelector(`.cell[data-cell-id="${cellId}"]`);
    if (el) {
      const ta = el.querySelector("textarea");
      if (ta) ta.focus();
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
}

function focusNextCell(tab, cellId) {
  const idx = tab.doc.cells.findIndex((c) => c.id === cellId);
  if (idx < 0) return;
  if (idx + 1 < tab.doc.cells.length) {
    selectCell(tab.doc.cells[idx + 1].id, true);
  } else {
    insertCellAfter(cellId, "code");
  }
}

function insertCellAfter(afterId, cellType = "code") {
  const tab = activeTab();
  if (!tab || tab.kind !== "notebook") return;
  const newCell = {
    id: uid(),
    cell_type: cellType,
    source: "",
    execution_count: null,
    output: null,
    _editingMd: cellType === "markdown",
  };
  const idx = afterId ? tab.doc.cells.findIndex((c) => c.id === afterId) : tab.doc.cells.length - 1;
  tab.doc.cells.splice(idx + 1, 0, newCell);
  tab.activeCellId = newCell.id;
  markDirty(tab);
  renderCells();
  selectCell(newCell.id, true);
}

function deleteCell(cellId) {
  const tab = activeTab();
  if (!tab || tab.kind !== "notebook") return;
  if (tab.doc.cells.length <= 1) {
    const c = tab.doc.cells[0];
    c.source = "";
    c.output = null;
    c.execution_count = null;
    markDirty(tab);
    renderCells();
    return;
  }
  const idx = tab.doc.cells.findIndex((c) => c.id === cellId);
  if (idx < 0) return;
  tab.doc.cells.splice(idx, 1);
  const next = tab.doc.cells[Math.min(idx, tab.doc.cells.length - 1)];
  tab.activeCellId = next.id;
  markDirty(tab);
  renderCells();
  selectCell(next.id, true);
}

function moveCell(cellId, delta) {
  const tab = activeTab();
  if (!tab || tab.kind !== "notebook") return;
  const idx = tab.doc.cells.findIndex((c) => c.id === cellId);
  const target = idx + delta;
  if (idx < 0 || target < 0 || target >= tab.doc.cells.length) return;
  const [cell] = tab.doc.cells.splice(idx, 1);
  tab.doc.cells.splice(target, 0, cell);
  markDirty(tab);
  renderCells();
  selectCell(cellId, false);
}

function toggleCellType(cellId) {
  const tab = activeTab();
  if (!tab || tab.kind !== "notebook") return;
  const cell = tab.doc.cells.find((c) => c.id === cellId);
  if (!cell) return;
  cell.cell_type = cell.cell_type === "code" ? "markdown" : "code";
  cell._editingMd = cell.cell_type === "markdown";
  if (cell.cell_type === "markdown") cell.output = null;
  markDirty(tab);
  updateSingleCellDom(tab, cellId);
  selectCell(cellId, true);
}

// --- Code Editor Keyboard & Autocomplete ---
async function handleCodeKeydown(e, tab, cell, ta, pre) {
  // Handle autocomplete navigation first
  if (state.ac.visible) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      state.ac.index = (state.ac.index + 1) % state.ac.items.length;
      renderAutocompletePopup();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      state.ac.index = (state.ac.index - 1 + state.ac.items.length) % state.ac.items.length;
      renderAutocompletePopup();
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      applyAutocomplete(state.ac.items[state.ac.index]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hideAutocomplete();
      return;
    }
  }

  if (e.shiftKey && e.key === "Enter") {
    e.preventDefault();
    await runCell(cell.id, true);
    return;
  }
  if (e.ctrlKey && e.key === "Enter") {
    e.preventDefault();
    await runCell(cell.id, false);
    return;
  }
  if (e.altKey && e.key === "Enter") {
    e.preventDefault();
    await runCell(cell.id, false);
    insertCellAfter(cell.id, "code");
    return;
  }

  if (e.key === "Tab" && !e.shiftKey) {
    e.preventDefault();
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const match = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(before);
    if (match && tab.kernelId) {
      const prefix = match[1];
      const startPos = pos - prefix.length;
      try {
        const data = await api(`/api/kernels/${encodeURIComponent(tab.kernelId)}/complete`, {
          method: "POST",
          body: JSON.stringify({ prefix }),
        });
        if (data.items && data.items.length === 1) {
          insertCompletionText(ta, pre, tab, cell, startPos, pos, data.items[0].label);
          return;
        } else if (data.items && data.items.length > 1) {
          showAutocomplete(data.items, cell.id, ta, pre, startPos);
          return;
        }
      } catch { /* fall through to indent */ }
    }
    // Insert 4 spaces
    const end = ta.selectionEnd;
    ta.value = ta.value.slice(0, pos) + "    " + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = pos + 4;
    cell.source = ta.value;
    pre.innerHTML = highlightCode(ta.value, tab.doc.language || "minilang");
    markDirty(tab);
    return;
  }

  // Arrow up/down across cell boundaries
  if (e.key === "ArrowUp" && ta.selectionStart === 0 && ta.selectionEnd === 0) {
    const idx = tab.doc.cells.findIndex((c) => c.id === cell.id);
    if (idx > 0) {
      e.preventDefault();
      selectCell(tab.doc.cells[idx - 1].id, true);
    }
  } else if (e.key === "ArrowDown" && ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length) {
    const idx = tab.doc.cells.findIndex((c) => c.id === cell.id);
    if (idx + 1 < tab.doc.cells.length) {
      e.preventDefault();
      selectCell(tab.doc.cells[idx + 1].id, true);
    }
  }
}

function insertCompletionText(ta, pre, tab, cell, startPos, endPos, text) {
  ta.value = ta.value.slice(0, startPos) + text + ta.value.slice(endPos);
  const nextPos = startPos + text.length;
  ta.selectionStart = ta.selectionEnd = nextPos;
  cell.source = ta.value;
  pre.innerHTML = highlightCode(ta.value, tab.doc.language || "minilang");
  markDirty(tab);
}

function showAutocomplete(items, cellId, ta, pre, startPos) {
  const rect = ta.getBoundingClientRect();
  const linesBefore = ta.value.slice(0, ta.selectionStart).split("\n");
  const lineIdx = linesBefore.length - 1;
  const colIdx = linesBefore[lineIdx].length;

  const popup = document.getElementById("autocomplete-popup");
  popup.style.left = `${Math.min(window.innerWidth - 260, rect.left + 14 + Math.min(colIdx * 8, 420))}px`;
  popup.style.top = `${Math.min(window.innerHeight - 250, rect.top + 32 + lineIdx * 21)}px`;
  popup.classList.remove("hidden");

  state.ac = { visible: true, items, index: 0, cellId, textarea: ta, pre, startPos };
  renderAutocompletePopup();
}

function renderAutocompletePopup() {
  const popup = document.getElementById("autocomplete-popup");
  popup.innerHTML = state.ac.items.map((item, idx) => `
    <div class="ac-item ${idx === state.ac.index ? "selected" : ""}" data-idx="${idx}">
      <span>${escapeHtml(item.label)}</span>
      <span class="ac-detail">${escapeHtml(item.detail)}</span>
    </div>
  `).join("");
  popup.querySelectorAll(".ac-item").forEach((el) => {
    el.onmousedown = (e) => {
      e.preventDefault();
      applyAutocomplete(state.ac.items[Number(el.dataset.idx)]);
    };
  });
}

function applyAutocomplete(item) {
  if (!item || !state.ac.textarea) return;
  const tab = activeTab();
  const cell = tab && tab.doc.cells.find((c) => c.id === state.ac.cellId);
  if (tab && cell) {
    insertCompletionText(
      state.ac.textarea,
      state.ac.pre,
      tab,
      cell,
      state.ac.startPos,
      state.ac.textarea.selectionStart,
      item.label
    );
  }
  hideAutocomplete();
}

function hideAutocomplete() {
  state.ac.visible = false;
  document.getElementById("autocomplete-popup").classList.add("hidden");
}

// --- Execution & Kernel Controls (SSE Live Streaming) ---
async function runCell(cellId, advance = false) {
  const tab = activeTab();
  if (!tab || tab.kind !== "notebook") return;
  const cell = tab.doc.cells.find((c) => c.id === cellId);
  if (!cell) return;

  if (cell.cell_type === "markdown") {
    cell._editingMd = false;
    updateSingleCellDom(tab, cell.id);
    if (advance) focusNextCell(tab, cell.id);
    return;
  }

  if (!cell.source.trim()) {
    if (advance) focusNextCell(tab, cell.id);
    return;
  }

  cell._running = true;
  cell.output = {
    stdout: "",
    displays: [],
    results: [],
    error: null,
    _streamStatus: "Running...",
  };
  updateSingleCellDom(tab, cell.id);
  setKernelIndicator("busy", "Running...");

  const updateLiveProgress = (prog) => {
    const id = prog.id || "default";
    const serialized = JSON.stringify(prog);
    const existing = cell.output.displays.find((d) => {
      if (d.mime !== "application/vnd.minilang.progress+json") return false;
      try { return (JSON.parse(d.data).id || "default") === id; } catch { return false; }
    });
    if (existing) existing.data = serialized;
    else cell.output.displays.push({ mime: "application/vnd.minilang.progress+json", data: serialized });
  };

  try {
    const res = await authFetch(`/api/kernels/${encodeURIComponent(tab.kernelId)}/execute-stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: cell.source }),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }

    let finalResp = null;
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let lastRender = 0;

      const scheduleLiveRender = (force = false) => {
        const now = performance.now();
        if (force || now - lastRender >= 60) {
          lastRender = now;
          if (activeTab()?.id === tab.id) updateSingleCellDom(tab, cell.id);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";

        for (const frame of frames) {
          let evName = "message";
          const dataLines = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) evName = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (!dataLines.length) continue;
          const raw = dataLines.join("\n");
          let payload;
          try { payload = JSON.parse(raw); } catch { continue; }

          if (evName === "stdout" && typeof payload.text === "string") {
            cell.output._streamStatus = null;
            cell.output.stdout += payload.text;
            scheduleLiveRender();
          } else if (evName === "status" && typeof payload.text === "string") {
            cell.output._streamStatus = payload.text;
            setKernelIndicator("busy", payload.text);
            scheduleLiveRender(true);
          } else if (evName === "progress") {
            cell.output._streamStatus = null;
            updateLiveProgress(payload);
            scheduleLiveRender(true);
          } else if (evName === "display" && payload.mime) {
            cell.output._streamStatus = null;
            cell.output.displays.push({ mime: payload.mime, data: payload.data || "" });
            scheduleLiveRender(true);
          } else if (evName === "result") {
            finalResp = payload;
          } else if (evName === "error") {
            throw new Error(payload.error || "Kernel stream error");
          }
        }
      }
    }

    cell._running = false;
    if (finalResp && finalResp.type === "eval_result") {
      cell.execution_count = finalResp.execution_count;
      cell.output = {
        stdout: finalResp.stdout || "",
        displays: finalResp.displays || [],
        results: finalResp.results || [],
        error: finalResp.error || null,
        duration_ms: finalResp.duration_ms,
      };
    } else if (finalResp) {
      cell.output = {
        stdout: "",
        displays: [],
        results: [],
        error: { error_type: "KernelError", message: finalResp.message || "Execution failed", traceback: "" },
      };
    } else {
      delete cell.output._streamStatus;
    }

    markDirty(tab);
    updateSingleCellDom(tab, cell.id);
    if (advance) focusNextCell(tab, cell.id);
    const lname = langInfo(tab.doc.language || "minilang").name;
    setKernelIndicator("idle", lname);
    if (state.varsOpen) refreshVariables();
    refreshKernelList();
  } catch (e) {
    cell._running = false;
    cell.output = {
      stdout: cell.output?.stdout || "",
      displays: cell.output?.displays || [],
      results: [],
      error: { error_type: "KernelError", message: e.message, traceback: "" },
    };
    updateSingleCellDom(tab, cell.id);
    setKernelIndicator("dead", "Kernel error");
    toast(e.message, "error");
  }
}

async function runAllCells() {
  const tab = activeTab();
  if (!tab || tab.kind !== "notebook") return;
  for (const cell of tab.doc.cells) {
    await runCell(cell.id, false);
    if (cell.output && cell.output.error) break;
  }
}

async function interruptKernel() {
  const tab = activeTab();
  if (!tab || !tab.kernelId) return;
  try {
    await api(`/api/kernels/${encodeURIComponent(tab.kernelId)}/interrupt`, { method: "POST" });
    toast("Interrupt signal sent to kernel", "info");
  } catch (e) {
    toast(`Interrupt failed: ${e.message}`, "error");
  }
}

async function restartKernel() {
  const tab = activeTab();
  if (!tab || !tab.kernelId) return;
  try {
    setKernelIndicator("busy", "Restarting...");
    await api(`/api/kernels/${encodeURIComponent(tab.kernelId)}/restart`, { method: "POST" });
    setKernelIndicator("idle", "Minilang 2.17");
    toast("Kernel restarted (fresh REPL state)", "success");
    if (state.varsOpen) refreshVariables();
    refreshKernelList();
  } catch (e) {
    setKernelIndicator("dead", "Restart failed");
    toast(`Restart failed: ${e.message}`, "error");
  }
}

function setKernelIndicator(mode, label) {
  const dot = document.getElementById("kernel-dot");
  dot.className = `status-dot ${mode}`;
  document.getElementById("kernel-label").textContent = label;
  document.getElementById("status-kernel").textContent = mode === "busy" ? "Kernel busy" : (mode === "dead" ? "Kernel stopped" : "Kernel idle");
}

async function updateKernelPill() {
  const tab = activeTab();
  if (!tab || !tab.kernelId) {
    setKernelIndicator("idle", "No kernel");
    return;
  }
  try {
    const st = await api(`/api/kernels/${encodeURIComponent(tab.kernelId)}/status`);
    const lname = langInfo(st.language || tab.language || "minilang").name;
    if (!st.alive) setKernelIndicator("dead", `${lname} stopped`);
    else if (st.busy) setKernelIndicator("busy", `Running ${lname}...`);
    else setKernelIndicator("idle", `${lname} (pid ${st.pid})`);
  } catch {
    const lname = langInfo(tab.language || "minilang").name;
    setKernelIndicator("idle", lname);
  }
}

async function refreshKernelList() {
  try {
    const data = await api("/api/kernels");
    const el = document.getElementById("kernel-list");
    if (!data.kernels || !data.kernels.length) {
      el.innerHTML = `<div style="font-size:11.5px;color:var(--text-muted)">No running kernels</div>`;
      return;
    }
    el.innerHTML = data.kernels.map((k) => {
      const tab = state.tabs.find((t) => t.kernelId === k.id);
      const label = tab ? tab.title : k.id;
      return `
        <div class="kernel-item">
          <div class="kernel-item-left">
            <span class="status-dot ${k.alive ? (k.busy ? "busy" : "idle") : "dead"}"></span>
            <span class="kernel-item-name" title="PID ${k.pid} | ${escapeHtml(k.cwd)}">${escapeHtml(label)}</span>
          </div>
          <span style="font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted)">#${k.execution_count}</span>
        </div>`;
    }).join("");
  } catch { /* ignore */ }
}

// --- Variable Inspector ---
async function refreshVariables() {
  const tab = activeTab();
  const content = document.getElementById("vars-content");
  if (!tab || !tab.kernelId) {
    content.innerHTML = `<div class="vars-empty">Open a notebook to inspect its kernel variables.</div>`;
    return;
  }
  try {
    const data = await api(`/api/kernels/${encodeURIComponent(tab.kernelId)}/inspect`);
    if (!data.variables || data.variables.length === 0) {
      content.innerHTML = `<div class="vars-empty">No user variables defined yet.<br/>Try <code>var x := 42</code> or <code>fun sq(n) n * n</code><br/><br/><span style="opacity:0.7">${data.globals_count || 0} built-in globals available</span></div>`;
      return;
    }
    content.innerHTML = data.variables.map((v) => `
      <div class="var-card" data-name="${escapeHtml(v.name)}" title="${escapeHtml(v.preview)}">
        <div class="var-card-top">
          <span class="var-name">${escapeHtml(v.name)}</span>
          <span class="type-badge">${escapeHtml(v.type_name)}</span>
        </div>
        <div class="var-preview">${escapeHtml(v.preview)}</div>
      </div>
    `).join("");
    content.querySelectorAll(".var-card").forEach((card) => {
      card.onclick = () => {
        navigator.clipboard?.writeText(card.dataset.name).catch(() => {});
        toast(`Copied '${card.dataset.name}'`, "info");
      };
    });
  } catch (e) {
    content.innerHTML = `<div class="vars-empty">${escapeHtml(e.message)}</div>`;
  }
}

export function initNotebook() {
  document.addEventListener("mousedown", (e) => {
    if (state.ac.visible && !e.target.closest("#autocomplete-popup")) {
      hideAutocomplete();
    }
  });

  document.getElementById("btn-toggle-vars").onclick = () => {
    state.varsOpen = !state.varsOpen;
    document.getElementById("vars-drawer").classList.toggle("hidden", !state.varsOpen);
    document.getElementById("btn-toggle-vars").classList.toggle("active", state.varsOpen);
    if (state.varsOpen) refreshVariables();
  };
  document.getElementById("btn-close-vars").onclick = () => {
    state.varsOpen = false;
    document.getElementById("vars-drawer").classList.add("hidden");
    document.getElementById("btn-toggle-vars").classList.remove("active");
  };
  document.getElementById("btn-refresh-vars").onclick = refreshVariables;


  // Notebook toolbar buttons
  document.getElementById("tb-save").onclick = saveActiveTab;
  document.getElementById("tb-add-code").onclick = () => {
    const tab = activeTab();
    insertCellAfter(tab && tab.activeCellId, "code");
  };
  document.getElementById("tb-add-md").onclick = () => {
    const tab = activeTab();
    insertCellAfter(tab && tab.activeCellId, "markdown");
  };
  document.getElementById("footer-add-code").onclick = () => insertCellAfter(null, "code");
  document.getElementById("footer-add-md").onclick = () => insertCellAfter(null, "markdown");
  document.getElementById("tb-run").onclick = () => {
    const tab = activeTab();
    if (tab && tab.activeCellId) runCell(tab.activeCellId, true);
  };
  document.getElementById("tb-run-all").onclick = runAllCells;
  document.getElementById("tb-interrupt").onclick = interruptKernel;
  document.getElementById("tb-restart").onclick = restartKernel;
  document.getElementById("tb-clear-outputs").onclick = () => {
    const tab = activeTab();
    if (!tab || tab.kind !== "notebook") return;
    tab.doc.cells.forEach((c) => { c.output = null; c.execution_count = null; });
    markDirty(tab);
    renderCells();
  };
  document.getElementById("tb-export-mini").onclick = exportAsMini;
  document.getElementById("tb-lang-select").onchange = async (e) => {
    const tab = activeTab();
    if (!tab || tab.kind !== "notebook") return;
    const nextLang = e.target.value;
    if (tab.doc.language === nextLang) return;
    tab.doc.language = nextLang;
    tab.language = nextLang;
    markDirty(tab);
    const dir = tab.path && tab.path.includes("/") ? tab.path.slice(0, tab.path.lastIndexOf("/")) : state.currentDir;
    try {
      setKernelIndicator("busy", `Switching to ${langInfo(nextLang).name}...`);
      await ensureKernel(tab.kernelId, dir, nextLang);
      renderActiveWorkspace();
      updateKernelPill();
      if (state.varsOpen) refreshVariables();
      toast(`Switched kernel to ${langInfo(nextLang).name}`, "success");
    } catch (err) {
      toast(`Failed to switch kernel: ${err.message}`, "error");
    }
  };

}

export {
  ensureKernel,
  renderOutputHtml,
  renderCells,
  buildCellElement,
  hydrateUiDisplays,
  updateSingleCellDom,
  selectCell,
  focusNextCell,
  insertCellAfter,
  deleteCell,
  moveCell,
  toggleCellType,
  handleCodeKeydown,
  insertCompletionText,
  showAutocomplete,
  renderAutocompletePopup,
  applyAutocomplete,
  hideAutocomplete,
  runCell,
  runAllCells,
  interruptKernel,
  restartKernel,
  setKernelIndicator,
  updateKernelPill,
  refreshKernelList,
  refreshVariables,
};
