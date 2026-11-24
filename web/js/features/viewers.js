/**
 * Tab lifecycle, Workspace View Switching, File Editor Highlighting/Gutter,
 * Markdown/Log/SQLite/CSV Viewers, and Save/Export flows.
 */

import { escapeHtml, highlightCode } from "../core/highlight.js";
import { renderMarkdown } from "../core/markdown.js";
import { api } from "../core/auth.js";
import { toast, showModal, uid, formatSize } from "../core/ui_helpers.js";
import { state, langInfo, langByExtension, activeTab, markDirty, updateStatusBar } from "../core/state.js";
import { rawFileUrl, hydrateMediaPreviews, applyMediaImageTransform } from "./media.js";
import { loadDirectory, renderFileList, downloadFileEntry } from "./files.js";
import { ensureKernel, renderCells, updateKernelPill, refreshKernelList, refreshVariables } from "./notebook.js";
import { syncFileParamsPanelForTab } from "./script_tools.js";
import { renderFileAgyPanel } from "./agy.js";
import { debugState, getBreakpointsForSource } from "./debugger.js";
import { mountClusterGraph } from "../viz/cluster.js";

async function openPathInTab(relPath) {
  const existing = state.tabs.find((t) => t.path === relPath);
  if (existing) {
    activateTab(existing.id);
    return;
  }

  try {
    const file = await api(`/api/file?path=${encodeURIComponent(relPath)}`);
    if (file.is_image || file.is_pdf) {
      const tab = {
        id: uid(),
        kind: "media",
        mediaKind: file.is_pdf ? "pdf" : "image",
        path: file.path,
        title: file.name,
        dirty: false,
        kernelId: null,
        extension: file.extension,
        mimeType: file.mime_type || (file.is_pdf ? "application/pdf" : "image/png"),
        size: file.size,
        content: file.content || "",
        zoom: "fit",
        rotation: 0,
      };
      state.tabs.push(tab);
      activateTab(tab.id);
      renderFileList(state.dirEntries, !!state.searchQuery);
      return;
    }
    if (file.is_log) {
      const tab = {
        id: uid(),
        kind: "log",
        path: file.path,
        title: file.name,
        dirty: false,
        kernelId: null,
        extension: file.extension,
        size: file.size,
        isBinaryLog: !!file.is_binary,
        content: file.content || "",
        logQuery: "",
        logType: "all",
        logReverse: true,
        logOffset: 0,
        logLimit: 200,
        logLive: false,
        logData: null,
      };
      state.tabs.push(tab);
      activateTab(tab.id);
      renderFileList(state.dirEntries, !!state.searchQuery);
      return;
    }
    if (file.is_sqlite) {
      const tab = {
        id: uid(),
        kind: "sqlite",
        path: file.path,
        title: file.name,
        dirty: false,
        kernelId: null,
        extension: file.extension,
        size: file.size,
        sqliteSchema: null,
        sqliteSql: "",
        sqliteResult: null,
        sqliteAllowWrite: false,
        sqliteMode: "table",
        sqliteCluster: {
          source: "",
          xCol: "",
          yCol: "",
          colorCol: "",
          algo: "auto",
          k: 4,
          limit: 1000,
          data: null,
        },
      };
      state.tabs.push(tab);
      activateTab(tab.id);
      renderFileList(state.dirEntries, !!state.searchQuery);
      return;
    }
    if (file.is_tabular) {
      const tab = {
        id: uid(),
        kind: "data",
        path: file.path,
        title: file.name,
        dirty: false,
        kernelId: null,
        extension: file.extension,
        size: file.size,
        content: file.content || "",
      };
      state.tabs.push(tab);
      activateTab(tab.id);
      renderFileList(state.dirEntries, !!state.searchQuery);
      return;
    }
    if (file.is_markdown) {
      const tab = {
        id: uid(),
        kind: "markdown",
        path: file.path,
        title: file.name,
        dirty: false,
        kernelId: null,
        extension: file.extension,
        size: file.size,
        content: file.content || "",
        mdMode: "preview",
      };
      state.tabs.push(tab);
      activateTab(tab.id);
      renderFileList(state.dirEntries, !!state.searchQuery);
      return;
    }
    if (file.is_binary) {
      toast(`Cannot open binary file '${file.name}'`, "error");
      return;
    }

    if (file.extension === "mnb") {
      let doc;
      try {
        doc = JSON.parse(file.content);
        if (!Array.isArray(doc.cells)) throw new Error("Invalid cells");
      } catch {
        doc = {
          format: "minilang-notebook",
          version: 1,
          title: file.name,
          cells: [{ id: uid(), cell_type: "code", source: file.content, execution_count: null, output: null }],
        };
      }
      if (!doc.language) doc.language = "minilang";
      if (doc.cells.length === 0) {
        doc.cells.push({ id: uid(), cell_type: "code", source: "", execution_count: null, output: null });
      }
      doc.cells.forEach((c) => {
        if (!c.id) c.id = uid();
        if (!c.cell_type) c.cell_type = "code";
      });
      const kernelId = `nb-${uid().slice(0, 8)}`;
      const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
      await ensureKernel(kernelId, dir, doc.language);
      const tab = {
        id: uid(),
        kind: "notebook",
        path: file.path,
        title: file.name,
        dirty: false,
        kernelId,
        language: doc.language,
        doc,
        activeCellId: doc.cells[0].id,
      };
      state.tabs.push(tab);
      activateTab(tab.id);
    } else {
      const tab = {
        id: uid(),
        kind: "file",
        path: file.path,
        title: file.name,
        dirty: false,
        kernelId: null,
        content: file.content,
        extension: file.extension,
        size: file.size,
      };
      state.tabs.push(tab);
      activateTab(tab.id);
    }
    renderFileList(state.dirEntries, !!state.searchQuery);
  } catch (e) {
    toast(`Failed to open '${relPath}': ${e.message}`, "error");
  }
}

async function createUntitledNotebook(doc = null, title = "Untitled.mnb", path = null, language = "minilang") {
  const lang = (doc && doc.language) || language || "minilang";
  const kernelId = `nb-${uid().slice(0, 8)}`;
  await ensureKernel(kernelId, state.currentDir, lang);
  const nbDoc = doc || {
    format: "minilang-notebook",
    version: 1,
    language: lang,
    title,
    cells: [{ id: uid(), cell_type: "code", source: "", execution_count: null, output: null }],
  };
  if (!nbDoc.language) nbDoc.language = lang;
  const tab = {
    id: uid(),
    kind: "notebook",
    path,
    title,
    dirty: !path,
    kernelId,
    language: nbDoc.language,
    doc: nbDoc,
    activeCellId: nbDoc.cells[0].id,
  };
  state.tabs.push(tab);
  activateTab(tab.id);
}

function activateTab(tabId) {
  state.activeTabId = tabId;
  renderTabs();
  renderActiveWorkspace();
  updateStatusBar();
  updateKernelPill();
  if (state.varsOpen) refreshVariables();
}

async function closeTab(tabId) {
  const idx = state.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  const tab = state.tabs[idx];
  if (tab.kernelId) {
    api(`/api/kernels/${encodeURIComponent(tab.kernelId)}`, { method: "DELETE" }).catch(() => {});
  }
  state.tabs.splice(idx, 1);
  if (state.activeTabId === tabId) {
    const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
    if (next) activateTab(next.id);
    else await createUntitledNotebook();
  } else {
    renderTabs();
  }
  refreshKernelList();
}

function renderTabs() {
  const bar = document.getElementById("tab-bar");
  bar.innerHTML = state.tabs.map((t) => `
    <div class="tab-item ${t.id === state.activeTabId ? "active" : ""}" data-id="${t.id}" role="tab">
      <span class="tab-title" title="${escapeHtml(t.path || t.title)}">${escapeHtml(t.title)}</span>
      ${t.dirty ? '<span class="tab-dirty" title="Unsaved changes"></span>' : ""}
      <button class="tab-close" data-close="${t.id}" title="Close tab">&times;</button>
    </div>
  `).join("");

  bar.querySelectorAll(".tab-item").forEach((el) => {
    el.onclick = (e) => {
      if (e.target.dataset.close) {
        closeTab(e.target.dataset.close);
        return;
      }
      activateTab(el.dataset.id);
    };
  });
}

let logLiveTimer = null;

function syncLogLiveTimer(tab) {
  if (logLiveTimer) {
    clearInterval(logLiveTimer);
    logLiveTimer = null;
  }
  if (tab && tab.kind === "log" && tab.logLive) {
    logLiveTimer = setInterval(() => {
      const cur = activeTab();
      if (cur && cur.id === tab.id && cur.kind === "log" && cur.logLive) {
        loadLogTabData(cur, true);
      }
    }, 2000);
  }
}

async function loadLogTabData(tab, silent = false) {
  if (!tab || tab.kind !== "log") return;
  const listEl = document.getElementById("log-entries-list");
  const metaEl = document.getElementById("ltb-meta");
  if (!silent && !tab.logData && listEl) {
    listEl.innerHTML = `<div class="log-empty">Loading log entries...</div>`;
  }
  try {
    const qs = new URLSearchParams({
      path: tab.path,
      reverse: tab.logReverse ? "1" : "0",
      offset: String(tab.logOffset || 0),
      limit: String(tab.logLimit || 200),
    });
    if (tab.logQuery) qs.set("q", tab.logQuery);
    if (tab.logType && tab.logType !== "all") qs.set("type", tab.logType);
    const data = await api(`/api/log?${qs.toString()}`);
    tab.logData = data;
    tab.size = data.size;
    if (activeTab()?.id !== tab.id) return;
    renderLogEntries(tab);
  } catch (e) {
    if (!silent && listEl) {
      listEl.innerHTML = `<div class="log-empty" style="color:var(--accent-red)">Failed to load log: ${escapeHtml(e.message)}</div>`;
    }
    if (metaEl) metaEl.textContent = "Error loading log";
  }
}

function renderLogEntries(tab) {
  const data = tab.logData;
  const listEl = document.getElementById("log-entries-list");
  const metaEl = document.getElementById("ltb-meta");
  const typeSel = document.getElementById("ltb-type-select");
  const editRawBtn = document.getElementById("ltb-edit-raw");
  if (!data || !listEl) return;

  const fmtBadge = data.format === "mlog" ? "CBOR Log" : "Text Log";
  metaEl.textContent = `${fmtBadge} · ${data.filtered === data.total ? `${data.total} entries` : `${data.filtered} / ${data.total} entries`} · ${formatSize(data.size)}`;
  if (editRawBtn) editRawBtn.classList.toggle("hidden", data.format === "mlog");

  if (typeSel) {
    const prev = tab.logType || "all";
    const opts = ['<option value="all">All types</option>'].concat(
      (data.types || []).map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`)
    );
    typeSel.innerHTML = opts.join("");
    typeSel.value = (data.types || []).includes(prev) ? prev : "all";
  }

  if (!data.entries.length) {
    listEl.innerHTML = `<div class="log-empty">${data.total === 0 ? "Log is empty." : "No log entries match your filter."}</div>`;
    return;
  }

  let html = "";
  for (const entry of data.entries) {
    const lvlClass = entry.level ? `lvl-${escapeHtml(entry.level)}` : "";
    const typeClass = `t-${escapeHtml(entry.type_name)}`;
    const tsDisplay = entry.timestamp ? entry.timestamp.replace("T", " ").replace("Z", "") : "—";
    html += `
      <div class="log-entry-row ${lvlClass}">
        <span class="log-entry-idx">#${entry.index}</span>
        <span class="log-entry-ts" title="${escapeHtml(entry.timestamp || "")}">${escapeHtml(tsDisplay)}</span>
        <span class="log-entry-type ${typeClass}">${escapeHtml(entry.type_name)}</span>
        <pre class="log-entry-val">${escapeHtml(entry.repr)}</pre>
        <button type="button" class="media-thumb-btn log-copy-btn" data-copy-idx="${entry.index}" title="Copy value">Copy</button>
      </div>`;
  }

  if (data.filtered > data.limit) {
    const hasPrev = data.offset > 0;
    const hasNext = data.offset + data.entries.length < data.filtered;
    html += `
      <div class="log-pager">
        <button type="button" class="tb-btn" id="log-page-prev" ${hasPrev ? "" : "disabled"}>&larr; Prev</button>
        <span>Showing ${data.offset + 1}–${data.offset + data.entries.length} of ${data.filtered}</span>
        <button type="button" class="tb-btn" id="log-page-next" ${hasNext ? "" : "disabled"}>Next &rarr;</button>
      </div>`;
  }

  listEl.innerHTML = html;

  listEl.querySelectorAll(".log-copy-btn").forEach((btn) => {
    btn.onclick = () => {
      const idx = Number(btn.dataset.copyIdx);
      const found = data.entries.find((e) => e.index === idx);
      if (found) {
        navigator.clipboard?.writeText(found.repr).catch(() => {});
        toast(`Copied log entry #${idx}`, "success");
      }
    };
  });

  document.getElementById("log-page-prev")?.addEventListener("click", () => {
    tab.logOffset = Math.max(0, (tab.logOffset || 0) - (tab.logLimit || 200));
    loadLogTabData(tab);
  });
  document.getElementById("log-page-next")?.addEventListener("click", () => {
    tab.logOffset = (tab.logOffset || 0) + (tab.logLimit || 200);
    loadLogTabData(tab);
  });
}

function renderMarkdownTabView(tab) {
  const editorPane = document.getElementById("md-editor-pane");
  const previewPane = document.getElementById("md-preview-pane");
  const ta = document.getElementById("md-editor-textarea");
  const article = document.getElementById("md-preview-content");
  const metaEl = document.getElementById("mdtb-meta");
  const mode = tab.mdMode || "preview";

  editorPane.classList.toggle("hidden", mode === "preview");
  previewPane.classList.toggle("hidden", mode === "edit");
  document.querySelectorAll(".tb-seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });

  if (ta.value !== (tab.content || "")) {
    ta.value = tab.content || "";
  }
  if (mode !== "edit") {
    article.innerHTML = renderMarkdown(tab.content || "");
    hydrateMediaPreviews(article);
  }
  metaEl.textContent = `${tab.path} (${formatSize((tab.content || "").length)})`;
}

function renderActiveWorkspace() {
  const tab = activeTab();
  const nbToolbar = document.getElementById("notebook-toolbar");
  const fileToolbar = document.getElementById("file-toolbar");
  const mediaToolbar = document.getElementById("media-toolbar");
  const mdToolbar = document.getElementById("md-toolbar");
  const logToolbar = document.getElementById("log-toolbar");
  const sqliteToolbar = document.getElementById("sqlite-toolbar");
  const dataToolbar = document.getElementById("data-toolbar");
  const nbView = document.getElementById("notebook-view");
  const fileView = document.getElementById("file-view");
  const mediaView = document.getElementById("media-view");
  const mdView = document.getElementById("markdown-view");
  const logView = document.getElementById("log-view");
  const sqliteView = document.getElementById("sqlite-view");
  const dataView = document.getElementById("data-view");

  if (!tab) return;
  syncLogLiveTimer(tab);

  nbToolbar.classList.toggle("hidden", tab.kind !== "notebook");
  fileToolbar.classList.toggle("hidden", tab.kind !== "file");
  mediaToolbar.classList.toggle("hidden", tab.kind !== "media");
  mdToolbar.classList.toggle("hidden", tab.kind !== "markdown");
  logToolbar.classList.toggle("hidden", tab.kind !== "log");
  sqliteToolbar.classList.toggle("hidden", tab.kind !== "sqlite");
  dataToolbar.classList.toggle("hidden", tab.kind !== "data");

  nbView.classList.toggle("hidden", tab.kind !== "notebook");
  fileView.classList.toggle("hidden", tab.kind !== "file");
  mediaView.classList.toggle("hidden", tab.kind !== "media");
  mdView.classList.toggle("hidden", tab.kind !== "markdown");
  logView.classList.toggle("hidden", tab.kind !== "log");
  sqliteView.classList.toggle("hidden", tab.kind !== "sqlite");
  dataView.classList.toggle("hidden", tab.kind !== "data");

  if (tab.kind === "notebook") {
    const langSel = document.getElementById("tb-lang-select");
    if (langSel) langSel.value = tab.doc.language || "minilang";
    const linfo = langInfo(tab.doc.language || "minilang");
    const ext = (linfo.extensions && linfo.extensions[0]) || "mini";
    document.getElementById("tb-export-mini").querySelector("span").textContent = `Export .${ext}`;
    renderCells();
  } else if (tab.kind === "sqlite") {
    renderSqliteTabView(tab);
  } else if (tab.kind === "data") {
    renderDataTabView(tab);
  } else if (tab.kind === "markdown") {
    renderMarkdownTabView(tab);
  } else if (tab.kind === "log") {
    document.getElementById("ltb-search").value = tab.logQuery || "";
    document.getElementById("ltb-order").textContent = tab.logReverse ? "Newest First" : "Oldest First";
    const liveBtn = document.getElementById("ltb-live");
    liveBtn.textContent = tab.logLive ? "Live Tail: On" : "Live Tail: Off";
    liveBtn.classList.toggle("live-on", !!tab.logLive);
    loadLogTabData(tab);
  } else if (tab.kind === "media") {
    const imgControls = document.getElementById("mtb-image-controls");
    const imgStage = document.getElementById("media-image-stage");
    const pdfStage = document.getElementById("media-pdf-stage");
    const editSvgBtn = document.getElementById("mtb-edit-svg");
    const metaEl = document.getElementById("mtb-meta");
    const rawUrl = rawFileUrl(tab.path);

    metaEl.textContent = `${tab.path} (${formatSize(tab.size || 0)})`;
    editSvgBtn.classList.toggle("hidden", tab.extension !== "svg");

    if (tab.mediaKind === "pdf") {
      imgControls.classList.add("hidden");
      imgStage.classList.add("hidden");
      pdfStage.classList.remove("hidden");
      const frame = document.getElementById("media-pdf-frame");
      if (frame.dataset.loadedPath !== tab.path) {
        frame.src = rawUrl;
        frame.dataset.loadedPath = tab.path;
      }
    } else {
      imgControls.classList.remove("hidden");
      imgStage.classList.remove("hidden");
      pdfStage.classList.add("hidden");
      const img = document.getElementById("media-image-el");
      img.onload = () => {
        if (activeTab()?.id === tab.id) {
          metaEl.textContent = `${tab.path} · ${img.naturalWidth} × ${img.naturalHeight} px (${formatSize(tab.size || 0)})`;
          applyMediaImageTransform(tab);
        }
      };
      img.alt = tab.title;
      img.src = rawUrl;
      applyMediaImageTransform(tab);
    }
  } else {

    const ta = document.getElementById("file-editor-textarea");
    ta.value = tab.content || "";
    const isUi = tab.extension === "ui";
    const fileLang = langByExtension(tab.extension);
    const isScript = !!(fileLang && fileLang.supports_invoke && !isUi);
    const highlightLang = isUi ? "minilang" : (fileLang ? fileLang.id : null);
    syncFileEditorHighlight(tab.content || "", highlightLang);
    ta.scrollTop = 0;
    ta.scrollLeft = 0;
    syncFileEditorScroll();
    document.getElementById("ftb-meta").textContent = `${tab.path} (${formatSize(tab.content.length)})`;
    document.getElementById("ftb-run-mini").classList.toggle("hidden", !(isScript || isUi));
    document.getElementById("ftb-run-mini").querySelector("span").textContent =
      isUi ? "Preview UI" : (fileLang ? `Run in ${fileLang.name}` : "Run");
    const isMiniScript = !!(isScript && fileLang && fileLang.id === "minilang");
    const ftbDebug = document.getElementById("ftb-debug");
    if (ftbDebug) {
      ftbDebug.classList.toggle("hidden", !isMiniScript);
    }
    const ftbParams = document.getElementById("ftb-params");
    if (ftbParams) {
      ftbParams.classList.toggle("hidden", !(isScript || isUi));
    }
    const ftbService = document.getElementById("ftb-service");
    if (ftbService) {
      ftbService.classList.toggle("hidden", !isMiniScript);
    }
    syncFileParamsPanelForTab(tab);
    document.getElementById("ftb-invoke-mini").classList.toggle("hidden", !isScript);
    document.getElementById("ftb-launch-ui").classList.toggle("hidden", !(isUi || (fileLang && fileLang.supports_ui)));
    document.getElementById("ftb-open-as-nb").classList.toggle("hidden", !isScript);
    document.getElementById("file-run-output").classList.add("hidden");
    document.getElementById("file-invoke-panel").classList.add("hidden");
    document.getElementById("file-agy-panel").classList.toggle("hidden", !tab._agyOpen);
    if (tab._agyOpen) renderFileAgyPanel(tab);
  }
}

function syncFileEditorHighlight(code, highlightLang) {
  const shell = document.getElementById("file-editor-shell");
  const hl = document.getElementById("file-editor-highlight");
  const gutter = document.getElementById("file-editor-gutter");
  shell.classList.toggle("highlighted", !!highlightLang);
  if (highlightLang) {
    hl.innerHTML = highlightCode(code, highlightLang);
  } else {
    hl.textContent = "";
  }
  const tab = activeTab();
  const isMiniFile = !!(tab && tab.kind === "file" && (tab.extension === "mini" || highlightLang === "minilang"));
  gutter.classList.toggle("bp-enabled", isMiniFile);
  const bpSet = isMiniFile && tab ? new Set(getBreakpointsForSource(tab.path)) : new Set();
  const curPausedLine =
    isMiniFile && tab && debugState.session && debugState.session.status === "paused" &&
    debugState.activeSource === tab.path
      ? debugState.activeLine
      : null;
  const lineCount = Math.max(1, code.split("\n").length);
  let html = "";
  for (let i = 1; i <= lineCount; i++) {
    const cls = [
      "fe-gutter-line",
      bpSet.has(i) ? "bp-active" : "",
      curPausedLine === i ? "dbg-cur-line" : "",
    ].filter(Boolean).join(" ");
    html += `<div class="${cls}" data-line="${i}"><span class="fe-bp-dot"></span><span>${i}</span></div>`;
  }
  gutter.innerHTML = html;
}

function syncFileEditorScroll() {
  const ta = document.getElementById("file-editor-textarea");
  const hl = document.getElementById("file-editor-highlight");
  const gutter = document.getElementById("file-editor-gutter");
  hl.scrollTop = ta.scrollTop;
  hl.scrollLeft = ta.scrollLeft;
  gutter.scrollTop = ta.scrollTop;
}

// --- Save & Export ---
async function saveActiveTab() {
  const tab = activeTab();
  if (!tab || tab.kind === "media" || tab.kind === "log") return;

  let targetPath = tab.path;
  if (!targetPath) {
    const suggested = tab.title.endsWith(".mnb") ? tab.title : `${tab.title}.mnb`;
    const name = await showModal({
      title: "Save Notebook",
      bodyHtml: `<p style="margin:0 0 10px;color:var(--text-secondary)">Save in <code>${escapeHtml(state.currentDir || "/")}</code> as:</p>`,
      confirmText: "Save",
      inputValue: suggested,
    });
    if (!name || !name.trim()) return;
    const clean = name.trim().endsWith(".mnb") ? name.trim() : `${name.trim()}.mnb`;
    targetPath = state.currentDir ? `${state.currentDir}/${clean}` : clean;
  }

  try {
    if (tab.kind === "notebook") {
      // Strip transient UI flags before saving
      const cleanDoc = {
        format: tab.doc.format || "minilang-notebook",
        version: tab.doc.version || 1,
        language: tab.doc.language || "minilang",
        title: tab.title,
        cells: tab.doc.cells.map((c) => ({
          id: c.id,
          cell_type: c.cell_type,
          source: c.source,
          execution_count: c.execution_count ?? null,
          output: c.output ?? null,
        })),
      };
      const content = JSON.stringify(cleanDoc, null, 2);
      const saved = await api("/api/file", {
        method: "PUT",
        body: JSON.stringify({ path: targetPath, content }),
      });
      tab.path = saved.path;
      tab.title = saved.path.split("/").pop();
      tab.dirty = false;
    } else {
      const content = document.getElementById("file-editor-textarea").value;
      tab.content = content;
      const saved = await api("/api/file", {
        method: "PUT",
        body: JSON.stringify({ path: targetPath, content }),
      });
      tab.path = saved.path;
      tab.dirty = false;
    }
    renderTabs();
    updateStatusBar();
    loadDirectory();
    toast(`Saved ${tab.title}`, "success");
  } catch (e) {
    toast(`Save failed: ${e.message}`, "error");
  }
}

async function exportAsMini() {
  const tab = activeTab();
  if (!tab || tab.kind !== "notebook") return;
  const linfo = langInfo(tab.doc.language || "minilang");
  const ext = (linfo.extensions && linfo.extensions[0]) || "mini";
  const base = tab.title.replace(/\.mnb$/i, "") + `.${ext}`;
  const name = await showModal({
    title: `Export as ${linfo.name} Script`,
    bodyHtml: `<p style="margin:0 0 10px;color:var(--text-secondary)">Export cells to <code>.${ext}</code> file in <code>${escapeHtml(state.currentDir || "/")}</code>:</p>`,
    confirmText: "Export",
    inputValue: base,
  });
  if (!name || !name.trim()) return;
  try {
    const cleanDoc = {
      format: "minilang-notebook",
      version: 1,
      language: tab.doc.language || "minilang",
      title: tab.title,
      cells: tab.doc.cells.map((c) => ({
        id: c.id,
        cell_type: c.cell_type,
        source: c.source,
        execution_count: null,
        output: null,
      })),
    };
    const res = await api("/api/notebook/to-script", {
      method: "POST",
      body: JSON.stringify(cleanDoc),
    });
    const dest = state.currentDir ? `${state.currentDir}/${name.trim()}` : name.trim();
    await api("/api/file", {
      method: "PUT",
      body: JSON.stringify({ path: dest, content: res.script }),
    });
    loadDirectory();
    toast(`Exported to ${dest}`, "success");
  } catch (e) {
    toast(`Export failed: ${e.message}`, "error");
  }
}

// =========================================================================
// SQLite Database Browser (#5) & CSV/TSV Tabular Data Viewer (#1)
// =========================================================================
async function loadSqliteSchema(tab) {
  try {
    const schema = await api(`/api/sqlite/schema?path=${encodeURIComponent(tab.path)}`);
    tab.sqliteSchema = schema;
    if (activeTab()?.id === tab.id) {
      renderSqliteSchema(tab);
      syncSqliteClusterControls(tab);
    }
  } catch (err) {
    toast(`Failed to load SQLite schema: ${err.message}`, "error");
  }
}

function ensureSqliteClusterState(tab) {
  if (!tab.sqliteCluster) {
    tab.sqliteCluster = {
      source: "",
      xCol: "",
      yCol: "",
      colorCol: "",
      algo: "auto",
      k: 4,
      limit: 1000,
      data: null,
    };
  }
  return tab.sqliteCluster;
}

function getSqliteColumnsForSource(tab, source) {
  if (source === "__sql__") {
    return (tab.sqliteResult?.columns || []).map((name) => ({ name, col_type: "" }));
  }
  const tbl = (tab.sqliteSchema?.tables || []).find((t) => t.name === source);
  return tbl?.columns || [];
}

function pickDefaultClusterCols(cols) {
  if (!cols.length) return { xCol: "", yCol: "__same__", colorCol: "" };
  const numRe = new RegExp("int|real|floa|doub|num|dec", "i");
  const textRe = new RegExp("text|char|clob|json|blob|vec", "i");
  const isNumType = (t) => numRe.test(t || "");
  const isTextOrBlob = (t) => textRe.test(t || "");
  const nonPk = cols.filter((c) => !c.pk);
  const pool = nonPk.length >= 2 ? nonPk : cols;
  const numCols = pool.filter((c) => isNumType(c.col_type));
  const textCols = pool.filter((c) => isTextOrBlob(c.col_type));

  let xCol = numCols[0]?.name || pool[0]?.name || cols[0].name;
  let yCol = numCols[1]?.name || (pool.find((c) => c.name !== xCol)?.name) || "__same__";
  const colorCand = textCols.find((c) => c.name !== xCol && c.name !== yCol)
    || pool.find((c) => c.name !== xCol && c.name !== yCol);
  const colorCol = colorCand ? colorCand.name : "";
  return { xCol, yCol, colorCol };
}

function syncSqliteClusterControls(tab) {
  const cs = ensureSqliteClusterState(tab);
  const srcSel = document.getElementById("sqlc-source");
  const xSel = document.getElementById("sqlc-x");
  const ySel = document.getElementById("sqlc-y");
  const cSel = document.getElementById("sqlc-color");
  const algoSel = document.getElementById("sqlc-algo");
  const kWrap = document.getElementById("sqlc-k-wrap");
  const kInp = document.getElementById("sqlc-k");
  const limSel = document.getElementById("sqlc-limit");
  if (!srcSel || !xSel || !ySel || !cSel) return;

  const tables = tab.sqliteSchema?.tables || [];
  const hasSqlQuery = !!(tab.sqliteSql && tab.sqliteSql.trim());
  const srcOpts = tables.map((t) => ({
    value: t.name,
    label: `${t.name}${t.row_count != null ? ` (${t.row_count})` : ""}`,
  }));
  if (hasSqlQuery) {
    srcOpts.push({ value: "__sql__", label: "Current SQL Query" });
  }
  if (!cs.source || !srcOpts.some((o) => o.value === cs.source)) {
    cs.source = srcOpts[0]?.value || "";
    cs.xCol = "";
    cs.yCol = "";
    cs.colorCol = "";
  }
  srcSel.innerHTML = srcOpts.length
    ? srcOpts.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join("")
    : `<option value="">(no tables)</option>`;
  srcSel.value = cs.source;

  const cols = getSqliteColumnsForSource(tab, cs.source);
  const colNames = cols.map((c) => c.name);
  if (!cs.xCol || !colNames.includes(cs.xCol)) {
    const def = pickDefaultClusterCols(cols);
    cs.xCol = def.xCol;
    cs.yCol = def.yCol;
    cs.colorCol = def.colorCol;
  }
  if (cs.yCol && cs.yCol !== "__same__" && !colNames.includes(cs.yCol)) {
    cs.yCol = colNames.find((n) => n !== cs.xCol) || "__same__";
  }
  if (cs.colorCol && cs.colorCol !== "__cluster__" && !colNames.includes(cs.colorCol)) {
    cs.colorCol = "";
  }

  xSel.innerHTML = cols.map((c) =>
    `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}${c.col_type ? ` (${escapeHtml(c.col_type)})` : ""}</option>`
  ).join("");
  xSel.value = cs.xCol;

  ySel.innerHTML =
    `<option value="__same__">(Same as X — Multi-dim 2D)</option>` +
    cols.map((c) =>
      `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}${c.col_type ? ` (${escapeHtml(c.col_type)})` : ""}</option>`
    ).join("");
  ySel.value = cs.yCol || "__same__";

  cSel.innerHTML =
    `<option value="">(None)</option>` +
    `<option value="__cluster__">(K-Means Cluster)</option>` +
    cols.map((c) =>
      `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}${c.col_type ? ` (${escapeHtml(c.col_type)})` : ""}</option>`
    ).join("");
  cSel.value = cs.colorCol || "";

  if (algoSel) algoSel.value = cs.algo || "auto";
  if (kInp) kInp.value = String(cs.k || 4);
  if (limSel) limSel.value = String(cs.limit || 1000);
  if (kWrap) {
    const showK = cs.algo === "kmeans_pca" || cs.colorCol === "__cluster__";
    kWrap.classList.toggle("hidden", !showK);
  }
}

async function runSqliteClusterPlot(tab) {
  const cs = ensureSqliteClusterState(tab);
  const host = document.getElementById("sqlc-graph-host");
  if (!host) return;
  if (!cs.source || !cs.xCol) {
    host.innerHTML = `<div class="log-empty">Select a table and X column to plot a cluster graph.</div>`;
    return;
  }
  host.innerHTML = `<div class="log-empty">Computing cluster projection...</div>`;
  try {
    const payload = {
      path: tab.path,
      x_col: cs.xCol,
      y_col: cs.yCol || "__same__",
      color_col: cs.colorCol || null,
      algorithm: cs.algo || "auto",
      k: Math.max(2, Math.min(16, Number(cs.k) || 4)),
      limit: Math.max(10, Math.min(5000, Number(cs.limit) || 1000)),
    };
    if (cs.source === "__sql__") {
      payload.sql = tab.sqliteSql || "";
    } else {
      payload.table = cs.source;
    }
    const res = await api("/api/sqlite/cluster", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    cs.data = res;
    if (activeTab()?.id === tab.id) {
      renderSqliteClusterResult(tab);
    }
  } catch (err) {
    host.innerHTML = `<div class="output-error"><div class="output-error-title">Cluster Plot Error</div><pre class="output-error-tb">${escapeHtml(err.message)}</pre></div>`;
  }
}

function renderSqliteClusterResult(tab) {
  const host = document.getElementById("sqlc-graph-host");
  if (!host) return;
  const cs = ensureSqliteClusterState(tab);
  host.innerHTML = "";
  if (!cs.data) {
    host.innerHTML = `<div class="log-empty">Choose columns above and click Plot to generate a cluster graph.</div>`;
    return;
  }
  mountClusterGraph(host, cs.data);
}

function setSqliteViewMode(tab, mode) {
  tab.sqliteMode = mode === "cluster" ? "cluster" : "table";
  const isCluster = tab.sqliteMode === "cluster";
  document.getElementById("sqltb-mode-table")?.classList.toggle("active", !isCluster);
  document.getElementById("sqltb-mode-cluster")?.classList.toggle("active", isCluster);
  document.getElementById("sqlite-editor-wrap")?.classList.toggle("hidden", isCluster);
  document.getElementById("sqlite-results-body")?.classList.toggle("hidden", isCluster);
  document.getElementById("sqlite-cluster-pane")?.classList.toggle("hidden", !isCluster);
  document.getElementById("sqltb-run")?.classList.toggle("hidden", isCluster);

  if (isCluster) {
    syncSqliteClusterControls(tab);
    const cs = ensureSqliteClusterState(tab);
    if (!cs.data && cs.source && cs.xCol) {
      runSqliteClusterPlot(tab);
    } else {
      renderSqliteClusterResult(tab);
    }
  } else {
    renderSqliteResult(tab);
  }
}

function renderSqliteSchema(tab) {
  const list = document.getElementById("sqlite-schema-list");
  const meta = document.getElementById("sqltb-meta");
  const schema = tab.sqliteSchema;
  if (!schema) {
    list.innerHTML = `<div class="log-empty">Loading schema...</div>`;
    return;
  }
  meta.textContent = `${schema.path} · ${schema.tables.length} table${schema.tables.length === 1 ? "" : "s"} (${formatSize(schema.size)})`;
  if (!schema.tables.length) {
    list.innerHTML = `<div class="log-empty">No tables found.</div>`;
    return;
  }
  list.innerHTML = schema.tables.map((t) => `
    <div class="sqlite-table-item">
      <div class="sqlite-table-head" data-sql-table="${escapeHtml(t.name)}" title="Click to preview rows">
        <span>${escapeHtml(t.name)}</span>
        <span class="sqlite-table-head-actions">
          <span class="tb-meta">${t.row_count != null ? t.row_count : "view"}</span>
          <button type="button" class="sqlite-plot-btn" data-plot-table="${escapeHtml(t.name)}" title="Plot cluster graph for ${escapeHtml(t.name)}">Plot</button>
        </span>
      </div>
      <div class="sqlite-col-list">
        ${(t.columns || []).map((c) => `
          <div class="sqlite-col-row">
            <span>${c.pk ? "🔑 " : ""}${escapeHtml(c.name)}</span>
            <span style="color:var(--text-muted)">${escapeHtml(c.col_type || "ANY")}</span>
          </div>`).join("")}
      </div>
    </div>`).join("");

  list.querySelectorAll(".sqlite-plot-btn").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const tbl = btn.dataset.plotTable;
      const cs = ensureSqliteClusterState(tab);
      cs.source = tbl;
      cs.xCol = "";
      cs.yCol = "";
      cs.colorCol = "";
      cs.data = null;
      setSqliteViewMode(tab, "cluster");
    };
  });

  list.querySelectorAll(".sqlite-table-head").forEach((hdr) => {
    hdr.onclick = () => {
      const tbl = hdr.dataset.sqlTable;
      if (tab.sqliteMode === "cluster") {
        const cs = ensureSqliteClusterState(tab);
        cs.source = tbl;
        cs.xCol = "";
        cs.yCol = "";
        cs.colorCol = "";
        cs.data = null;
        syncSqliteClusterControls(tab);
        runSqliteClusterPlot(tab);
        return;
      }
      const quoted = `"${tbl.replace(/"/g, '""')}"`;
      tab.sqliteSql = `SELECT * FROM ${quoted} LIMIT 100;`;
      document.getElementById("sqlite-sql-input").value = tab.sqliteSql;
      runSqliteTabQuery(tab);
    };
  });
}

async function runSqliteTabQuery(tab) {
  const sqlEl = document.getElementById("sqlite-sql-input");
  const sql = (sqlEl.value || tab.sqliteSql || "").trim();
  tab.sqliteSql = sql;
  if (!sql) return;
  const body = document.getElementById("sqlite-results-body");
  body.innerHTML = `<div class="log-empty">Running SQL...</div>`;
  try {
    const res = await api("/api/sqlite/query", {
      method: "POST",
      body: JSON.stringify({
        path: tab.path,
        sql,
        limit: 500,
        allow_write: !!tab.sqliteAllowWrite,
      }),
    });
    tab.sqliteResult = res;
    renderSqliteResult(tab);
    if (tab.sqliteAllowWrite && res.changes > 0) loadSqliteSchema(tab);
  } catch (err) {
    body.innerHTML = `<div class="output-error"><div class="output-error-title">SQLite Error</div><pre class="output-error-tb">${escapeHtml(err.message)}</pre></div>`;
  }
}

function renderSqliteResult(tab) {
  const body = document.getElementById("sqlite-results-body");
  const res = tab.sqliteResult;
  if (!res) {
    body.innerHTML = `<div class="log-empty">Select a table on the left or run a SQL query above.</div>`;
    return;
  }
  body.innerHTML = "";
  if (!res.columns.length) {
    body.innerHTML = `<div class="log-empty">Statement succeeded (${res.changes} row${res.changes === 1 ? "" : "s"} affected · ${res.duration_ms.toFixed(1)} ms)</div>`;
    return;
  }
  const title = `${res.row_count} row${res.row_count === 1 ? "" : "s"}${res.truncated ? " (truncated)" : ""} · ${res.duration_ms.toFixed(1)} ms`;
  window.MlnbViz?.mountTable(body, { title, columns: res.columns, rows: res.rows });
}

function renderSqliteTabView(tab) {
  document.getElementById("sqlite-sql-input").value = tab.sqliteSql || "";
  document.getElementById("sqltb-allow-write").checked = !!tab.sqliteAllowWrite;
  if (!tab.sqliteSchema) loadSqliteSchema(tab);
  else renderSqliteSchema(tab);
  setSqliteViewMode(tab, tab.sqliteMode || "table");
}

function renderDataTabView(tab) {
  const host = document.getElementById("data-table-host");
  const meta = document.getElementById("dtb-meta");
  host.innerHTML = "";
  const parsed = window.MlnbViz?.parseCsv(tab.content || "", tab.extension === "tsv" ? "\t" : null) || { columns: [], rows: [] };
  meta.textContent = `${tab.path} · ${parsed.rows.length} rows × ${parsed.columns.length} cols (${formatSize(tab.size || 0)})`;
  window.MlnbViz?.mountTable(host, { title: tab.title, columns: parsed.columns, rows: parsed.rows }, { pageSize: 100 });
}

export function initViewers() {
  document.querySelectorAll("#sqlite-toolbar [data-sql-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = activeTab();
      if (tab?.kind === "sqlite") setSqliteViewMode(tab, btn.dataset.sqlMode);
    });
  });
  document.getElementById("sqlc-source")?.addEventListener("change", (e) => {
    const tab = activeTab();
    if (tab?.kind !== "sqlite") return;
    const cs = ensureSqliteClusterState(tab);
    cs.source = e.target.value;
    cs.xCol = "";
    cs.yCol = "";
    cs.colorCol = "";
    syncSqliteClusterControls(tab);
    runSqliteClusterPlot(tab);
  });
  document.getElementById("sqlc-x")?.addEventListener("change", (e) => {
    const tab = activeTab();
    if (tab?.kind !== "sqlite") return;
    ensureSqliteClusterState(tab).xCol = e.target.value;
    runSqliteClusterPlot(tab);
  });
  document.getElementById("sqlc-y")?.addEventListener("change", (e) => {
    const tab = activeTab();
    if (tab?.kind !== "sqlite") return;
    ensureSqliteClusterState(tab).yCol = e.target.value;
    runSqliteClusterPlot(tab);
  });
  document.getElementById("sqlc-color")?.addEventListener("change", (e) => {
    const tab = activeTab();
    if (tab?.kind !== "sqlite") return;
    const cs = ensureSqliteClusterState(tab);
    cs.colorCol = e.target.value;
    syncSqliteClusterControls(tab);
    runSqliteClusterPlot(tab);
  });
  document.getElementById("sqlc-algo")?.addEventListener("change", (e) => {
    const tab = activeTab();
    if (tab?.kind !== "sqlite") return;
    const cs = ensureSqliteClusterState(tab);
    cs.algo = e.target.value;
    syncSqliteClusterControls(tab);
    runSqliteClusterPlot(tab);
  });
  document.getElementById("sqlc-k")?.addEventListener("change", (e) => {
    const tab = activeTab();
    if (tab?.kind !== "sqlite") return;
    ensureSqliteClusterState(tab).k = Number(e.target.value) || 4;
    runSqliteClusterPlot(tab);
  });
  document.getElementById("sqlc-limit")?.addEventListener("change", (e) => {
    const tab = activeTab();
    if (tab?.kind !== "sqlite") return;
    ensureSqliteClusterState(tab).limit = Number(e.target.value) || 1000;
    runSqliteClusterPlot(tab);
  });
  document.getElementById("sqlc-plot-btn")?.addEventListener("click", () => {
    const tab = activeTab();
    if (tab?.kind === "sqlite") runSqliteClusterPlot(tab);
  });
  document.getElementById("sqltb-run")?.addEventListener("click", () => {
    const tab = activeTab();
    if (tab?.kind === "sqlite") runSqliteTabQuery(tab);
  });
  document.getElementById("sqltb-refresh")?.addEventListener("click", () => {
    const tab = activeTab();
    if (tab?.kind === "sqlite") loadSqliteSchema(tab);
  });
  document.getElementById("sqltb-allow-write")?.addEventListener("change", (e) => {
    const tab = activeTab();
    if (tab?.kind === "sqlite") tab.sqliteAllowWrite = e.target.checked;
  });
  document.getElementById("sqltb-download")?.addEventListener("click", () => {
    const tab = activeTab();
    if (tab?.kind === "sqlite") downloadFileEntry(tab.path);
  });
  document.getElementById("sqlite-sql-input")?.addEventListener("input", (e) => {
    const tab = activeTab();
    if (tab?.kind === "sqlite") tab.sqliteSql = e.target.value;
  });
  document.getElementById("sqlite-sql-input")?.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      const tab = activeTab();
      if (tab?.kind === "sqlite") runSqliteTabQuery(tab);
    }
  });
  document.getElementById("dtb-edit-raw")?.addEventListener("click", () => {
    const tab = activeTab();
    if (tab?.kind === "data") {
      tab.kind = "file";
      renderActiveWorkspace();
      renderTabs();
    }
  });
  document.getElementById("dtb-download")?.addEventListener("click", () => {
    const tab = activeTab();
    if (tab?.kind === "data") downloadFileEntry(tab.path);
  });

  document.getElementById("mdtb-save")?.addEventListener("click", () => saveActiveTab());

  document.querySelectorAll("#md-toolbar .tb-seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = activeTab();
      if (!tab || tab.kind !== "markdown") return;
      tab.mdMode = btn.dataset.mode;
      renderMarkdownTabView(tab);
    });
  });

  document.getElementById("md-editor-textarea")?.addEventListener("input", (e) => {
    const tab = activeTab();
    if (!tab || tab.kind !== "markdown") return;
    tab.content = e.target.value;
    markDirty(tab);
    if (tab.mdMode === "split") {
      const article = document.getElementById("md-preview-content");
      article.innerHTML = renderMarkdown(tab.content);
      hydrateMediaPreviews(article);
    }
    document.getElementById("mdtb-meta").textContent = `${tab.path} (${formatSize(tab.content.length)})`;
  });

  // Log Viewer event handlers
  let logSearchTimer = null;
  document.getElementById("ltb-search")?.addEventListener("input", (e) => {
    const tab = activeTab();
    if (!tab || tab.kind !== "log") return;
    tab.logQuery = e.target.value;
    tab.logOffset = 0;
    clearTimeout(logSearchTimer);
    logSearchTimer = setTimeout(() => loadLogTabData(tab), 180);
  });

  document.getElementById("ltb-type-select")?.addEventListener("change", (e) => {
    const tab = activeTab();
    if (!tab || tab.kind !== "log") return;
    tab.logType = e.target.value;
    tab.logOffset = 0;
    loadLogTabData(tab);
  });

  document.getElementById("ltb-order")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab.kind !== "log") return;
    tab.logReverse = !tab.logReverse;
    tab.logOffset = 0;
    document.getElementById("ltb-order").textContent = tab.logReverse ? "Newest First" : "Oldest First";
    loadLogTabData(tab);
  });

  document.getElementById("ltb-refresh")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab.kind !== "log") return;
    loadLogTabData(tab);
  });

  document.getElementById("ltb-live")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab.kind !== "log") return;
    tab.logLive = !tab.logLive;
    const liveBtn = document.getElementById("ltb-live");
    liveBtn.textContent = tab.logLive ? "Live Tail: On" : "Live Tail: Off";
    liveBtn.classList.toggle("live-on", tab.logLive);
    syncLogLiveTimer(tab);
    if (tab.logLive) loadLogTabData(tab, true);
  });

  document.getElementById("ltb-edit-raw")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab.kind !== "log") return;
    tab.logLive = false;
    syncLogLiveTimer(null);
    tab.kind = "file";
    renderActiveWorkspace();
  });

  document.getElementById("ltb-download")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || !tab.path) return;
    const a = document.createElement("a");
    a.href = rawFileUrl(tab.path, true);
    a.download = tab.title;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}

export {
  openPathInTab,
  createUntitledNotebook,
  activateTab,
  closeTab,
  renderTabs,
  syncLogLiveTimer,
  loadLogTabData,
  renderLogEntries,
  renderMarkdownTabView,
  renderActiveWorkspace,
  syncFileEditorHighlight,
  syncFileEditorScroll,
  saveActiveTab,
  exportAsMini,
  loadSqliteSchema,
  renderSqliteSchema,
  runSqliteTabQuery,
  renderSqliteResult,
  renderSqliteTabView,
  renderDataTabView,
};
