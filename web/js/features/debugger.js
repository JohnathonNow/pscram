/**
 * Interactive Minilang Bytecode Debugger Drawer:
 * Breakpoints, stepping (Continue/Over/In/Out), call stack, frame locals, and Debug Console eval.
 */

import { escapeHtml } from "../core/highlight.js";
import { api } from "../core/auth.js";
import { toast } from "../core/ui_helpers.js";
import { state, langByExtension, activeTab } from "../core/state.js";
import { openPathInTab, syncFileEditorHighlight, syncFileEditorScroll } from "./viewers.js";
import { parseRunParamsJson, getActiveRunParamsText } from "./script_tools.js";

// =====================================================================
// Interactive Minilang Bytecode Debugger UI
// =====================================================================
const debugState = {
  open: false,
  session: null,
  selectedDepth: 0,
  activeSource: null,
  activeLine: null,
  breakpoints: {}, // { [source]: number[] }
  sourceCache: {}, // { [source]: string }
  evalHistory: [],
  busy: false,
};

function getBreakpointsForSource(source) {
  if (!source) return [];
  return debugState.breakpoints[source] || [];
}

function refreshActiveFileGutter() {
  const tab = activeTab();
  if (!tab || tab.kind !== "file") return;
  const isUi = tab.extension === "ui";
  const fileLang = langByExtension(tab.extension);
  const highlightLang = isUi ? "minilang" : (fileLang ? fileLang.id : null);
  syncFileEditorHighlight(tab.content || "", highlightLang);
  syncFileEditorScroll();
}

async function toggleBreakpoint(source, line) {
  if (!source || !line || line < 1) return;
  const list = new Set(debugState.breakpoints[source] || []);
  if (list.has(line)) list.delete(line);
  else list.add(line);
  const sorted = Array.from(list).sort((a, b) => a - b);
  if (sorted.length) debugState.breakpoints[source] = sorted;
  else delete debugState.breakpoints[source];

  refreshActiveFileGutter();
  renderDebugBreakpoints();
  renderDebugSource();

  if (debugState.session && debugState.session.status === "paused") {
    try {
      const res = await api(`/api/debug/${encodeURIComponent(debugState.session.id)}/breakpoints`, {
        method: "POST",
        body: JSON.stringify({ source, lines: sorted }),
      });
      if (res.session) debugState.session = res.session;
    } catch (e) {
      toast(`Breakpoint sync failed: ${e.message}`, "error");
    }
  }
}

async function clearAllBreakpoints() {
  const sources = Object.keys(debugState.breakpoints);
  debugState.breakpoints = {};
  refreshActiveFileGutter();
  renderDebugBreakpoints();
  renderDebugSource();
  if (debugState.session && debugState.session.status === "paused") {
    for (const src of sources) {
      try {
        await api(`/api/debug/${encodeURIComponent(debugState.session.id)}/breakpoints`, {
          method: "POST",
          body: JSON.stringify({ source: src, lines: [] }),
        });
      } catch { /* ignore */ }
    }
  }
}

function openDebugDrawer(show = true) {
  debugState.open = show;
  const drawer = document.getElementById("debug-drawer");
  const btn = document.getElementById("btn-toggle-debug");
  if (drawer) drawer.classList.toggle("hidden", !show);
  if (btn) btn.classList.toggle("active", show);
  if (show) renderDebugDrawer();
}

function toggleDebugDrawer() {
  openDebugDrawer(!debugState.open);
}

async function ensureDebugSourceLoaded(source) {
  if (!source) return "";
  if (debugState.sourceCache[source] != null) return debugState.sourceCache[source];
  if (debugState.session && debugState.session.source === source && debugState.session.code != null) {
    debugState.sourceCache[source] = debugState.session.code;
    return debugState.session.code;
  }
  // Check open tabs first
  const openTab = state.tabs.find((t) => t.kind === "file" && t.path === source);
  if (openTab && typeof openTab.content === "string") {
    debugState.sourceCache[source] = openTab.content;
    return openTab.content;
  }
  // Try fetching workspace file
  if (!source.startsWith("<")) {
    try {
      const res = await api(`/api/file?path=${encodeURIComponent(source)}`);
      if (typeof res.content === "string") {
        debugState.sourceCache[source] = res.content;
        return res.content;
      }
    } catch { /* ignore */ }
  }
  return "";
}

function applyDebugSnapshot(session) {
  debugState.session = session;
  debugState.selectedDepth = 0;
  if (session && session.source && typeof session.code === "string") {
    debugState.sourceCache[session.source] = session.code;
  }
  if (session && session.status === "paused") {
    const topFrame = (session.frames && session.frames[0]) || null;
    debugState.activeSource = session.current_source || (topFrame ? topFrame.source : session.source);
    debugState.activeLine = session.current_line || (topFrame ? topFrame.line : null);
  } else {
    debugState.activeSource = session ? session.source : null;
    debugState.activeLine = null;
  }
  const dot = document.getElementById("debug-active-dot");
  if (dot) {
    dot.classList.toggle("hidden", !(session && (session.status === "paused" || session.status === "running")));
  }
  refreshActiveFileGutter();
  renderDebugDrawer();
  if (debugState.activeSource) {
    ensureDebugSourceLoaded(debugState.activeSource).then(() => renderDebugSource());
  }
}

async function startDebuggingPayload(payload) {
  if (debugState.busy) return;
  if (debugState.session && (debugState.session.status === "paused" || debugState.session.status === "running")) {
    try {
      await api(`/api/debug/${encodeURIComponent(debugState.session.id)}`, { method: "DELETE" });
    } catch { /* ignore */ }
  }
  openDebugDrawer(true);
  const parsedParams = parseRunParamsJson(getActiveRunParamsText());
  if (!parsedParams.ok) {
    toast(`Invalid Params JSON: ${parsedParams.error}`, "error");
    const det = document.getElementById("dbg-params-details");
    if (det) det.open = true;
    return;
  }
  debugState.busy = true;
  debugState.evalHistory = [];
  const stopOnEntry = document.getElementById("dbg-opt-stop-entry")?.checked ?? true;
  const breakOnError = document.getElementById("dbg-opt-break-error")?.checked ?? true;
  try {
    const res = await api("/api/debug/start", {
      method: "POST",
      body: JSON.stringify({
        ...payload,
        params: parsedParams.params || {},
        breakpoints: debugState.breakpoints,
        stop_on_entry: stopOnEntry,
        break_on_error: breakOnError,
      }),
    });
    if (res.session) {
      applyDebugSnapshot(res.session);
    }
  } catch (e) {
    toast(`Debugger start failed: ${e.message}`, "error");
  } finally {
    debugState.busy = false;
    renderDebugTransport();
  }
}

async function startDebuggingFile(tab) {
  if (!tab || tab.kind !== "file") return;
  debugState.sourceCache[tab.path] = tab.content || "";
  await startDebuggingPayload({
    path: tab.path,
    code: tab.content || "",
  });
}

async function startDebuggingCell(tab, cell) {
  if (!tab || !cell) return;
  const idx = tab.doc.cells.findIndex((c) => c.id === cell.id);
  const label = `${tab.path || "Untitled.mnb"} [Cell ${idx >= 0 ? idx + 1 : 1}]`;
  const cwd = tab.path && tab.path.includes("/") ? tab.path.slice(0, tab.path.lastIndexOf("/")) : "";
  debugState.sourceCache[label] = cell.source || "";
  await startDebuggingPayload({
    source: label,
    code: cell.source || "",
    cwd,
  });
}

async function startDebuggingActive() {
  const tab = activeTab();
  if (!tab) {
    toast("Open a .mini script or Minilang notebook cell first", "info");
    return;
  }
  if (tab.kind === "file") {
    if (tab.extension !== "mini") {
      toast("Debugger supports Minilang (.mini) scripts and notebook cells", "info");
      return;
    }
    await startDebuggingFile(tab);
  } else if (tab.kind === "notebook") {
    if ((tab.doc.language || "minilang") !== "minilang") {
      toast("Debugger currently supports Minilang cells", "info");
      return;
    }
    const cell =
      tab.doc.cells.find((c) => c.id === tab.activeCellId && c.cell_type === "code") ||
      tab.doc.cells.find((c) => c.cell_type === "code");
    if (!cell) {
      toast("No code cell to debug", "info");
      return;
    }
    await startDebuggingCell(tab, cell);
  }
}

async function debugStep(action) {
  if (debugState.busy || !debugState.session || debugState.session.status !== "paused") return;
  debugState.busy = true;
  renderDebugTransport();
  try {
    const res = await api(`/api/debug/${encodeURIComponent(debugState.session.id)}/step`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    if (res.session) {
      applyDebugSnapshot(res.session);
    }
  } catch (e) {
    toast(`Step failed: ${e.message}`, "error");
  } finally {
    debugState.busy = false;
    renderDebugTransport();
  }
}

async function debugStop() {
  if (!debugState.session) return;
  const id = debugState.session.id;
  try {
    const res = await api(`/api/debug/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.session) applyDebugSnapshot(res.session);
  } catch {
    debugState.session = null;
    applyDebugSnapshot(null);
  }
}

async function debugSelectFrame(depth) {
  if (!debugState.session || debugState.session.status !== "paused") return;
  debugState.selectedDepth = depth;
  const frame = (debugState.session.frames || []).find((f) => f.depth === depth);
  if (frame) {
    debugState.activeSource = frame.source;
    debugState.activeLine = frame.line;
    await ensureDebugSourceLoaded(frame.source);
  }
  try {
    const res = await api(`/api/debug/${encodeURIComponent(debugState.session.id)}/locals?depth=${depth}`);
    if (Array.isArray(res.locals)) {
      debugState.session.locals = res.locals;
    }
  } catch (e) {
    toast(`Failed to load frame locals: ${e.message}`, "error");
  }
  refreshActiveFileGutter();
  renderDebugDrawer();
}

async function debugEval(expr) {
  if (!expr.trim() || !debugState.session || debugState.session.status !== "paused") return;
  try {
    const res = await api(`/api/debug/${encodeURIComponent(debugState.session.id)}/eval`, {
      method: "POST",
      body: JSON.stringify({ expr, depth: debugState.selectedDepth }),
    });
    debugState.evalHistory.push({
      expr,
      ok: !!res.ok,
      result: res.result,
      stdout: res.stdout || "",
      error: res.error || null,
    });
    renderDebugEvalHistory();
    // Refresh locals in case eval mutated a local variable
    try {
      const locRes = await api(
        `/api/debug/${encodeURIComponent(debugState.session.id)}/locals?depth=${debugState.selectedDepth}`
      );
      if (Array.isArray(locRes.locals)) {
        debugState.session.locals = locRes.locals;
        renderDebugLocals();
      }
    } catch { /* ignore */ }
  } catch (e) {
    debugState.evalHistory.push({
      expr,
      ok: false,
      error: { error_type: "Error", message: e.message },
    });
    renderDebugEvalHistory();
  }
}

function renderDebugTransport() {
  const sess = debugState.session;
  const isPaused = !!(sess && sess.status === "paused");
  const isActive = !!(sess && (sess.status === "paused" || sess.status === "running"));
  const badge = document.getElementById("dbg-status-badge");
  if (badge) {
    const st = debugState.busy && isActive ? "running" : (sess ? sess.status : "idle");
    badge.textContent = st;
    badge.className = `dbg-status-badge ${st}`;
  }
  const setDis = (id, dis) => {
    const el = document.getElementById(id);
    if (el) el.disabled = dis;
  };
  setDis("dbg-btn-continue", !isPaused || debugState.busy);
  setDis("dbg-btn-step-over", !isPaused || debugState.busy);
  setDis("dbg-btn-step-in", !isPaused || debugState.busy);
  setDis("dbg-btn-step-out", !isPaused || debugState.busy);
  setDis("dbg-btn-stop", !isActive);
  setDis("dbg-eval-input", !isPaused);
  setDis("dbg-eval-btn", !isPaused);
}

function renderDebugSource() {
  const el = document.getElementById("dbg-source-lines");
  const nameEl = document.getElementById("dbg-source-name");
  if (!el) return;
  const src = debugState.activeSource;
  if (!src) {
    if (nameEl) nameEl.textContent = "";
    el.innerHTML = `<div class="dbg-empty">Click <strong>Debug</strong> on any <code>.mini</code> script or Minilang notebook cell, or click line numbers in the gutter to set breakpoints.</div>`;
    return;
  }
  if (nameEl) nameEl.textContent = src;
  const text = debugState.sourceCache[src];
  if (text == null) {
    el.innerHTML = `<div class="dbg-empty">Loading ${escapeHtml(src)}...</div>`;
    return;
  }
  const lines = text.split("\n");
  const bpSet = new Set(getBreakpointsForSource(src));
  const curLine = debugState.session && debugState.session.status === "paused" ? debugState.activeLine : null;
  el.innerHTML = lines
    .map((lineText, idx) => {
      const ln = idx + 1;
      const rowCls = `dbg-src-row${curLine === ln ? " cur-line" : ""}`;
      const lnCls = `dbg-src-ln${bpSet.has(ln) ? " bp-active" : ""}`;
      return `<div class="${rowCls}" data-dbg-line="${ln}"><span class="${lnCls}" data-bp-src="${escapeHtml(src)}" data-bp-line="${ln}" title="Toggle breakpoint at line ${ln}"><span class="dbg-bp-dot"></span><span>${ln}</span></span><span class="dbg-src-code">${escapeHtml(lineText || " ")}</span></div>`;
    })
    .join("");
  if (curLine) {
    const curRow = el.querySelector(`.dbg-src-row[data-dbg-line="${curLine}"]`);
    if (curRow) curRow.scrollIntoView({ block: "center" });
  }
}

function renderDebugLocals() {
  const el = document.getElementById("dbg-locals-list");
  const meta = document.getElementById("dbg-locals-meta");
  if (!el) return;
  const sess = debugState.session;
  if (!sess || sess.status !== "paused") {
    if (meta) meta.textContent = "";
    el.innerHTML = `<div class="dbg-empty">No active frame.</div>`;
    return;
  }
  const locals = sess.locals || [];
  if (meta) meta.textContent = `Frame #${debugState.selectedDepth} (${locals.length})`;
  if (!locals.length) {
    el.innerHTML = `<div class="dbg-empty">No local variables in this frame yet.</div>`;
    return;
  }
  el.innerHTML = locals
    .map(
      (v) => `
    <div class="dbg-local-row">
      <span class="dbg-local-name">${escapeHtml(v.name)}</span>
      <span class="dbg-local-type">${escapeHtml(v.type_name)}${v.is_upvalue ? " ↑" : ""}</span>
      <span class="dbg-local-val">${escapeHtml(v.value)}</span>
    </div>`
    )
    .join("");
}

function renderDebugFrames() {
  const el = document.getElementById("dbg-frames-list");
  const meta = document.getElementById("dbg-frames-meta");
  if (!el) return;
  const sess = debugState.session;
  if (!sess || sess.status !== "paused") {
    if (meta) meta.textContent = "";
    el.innerHTML = `<div class="dbg-empty">Not paused.</div>`;
    return;
  }
  const frames = sess.frames || [];
  if (meta) meta.textContent = `${frames.length} frame${frames.length === 1 ? "" : "s"}`;
  if (!frames.length) {
    el.innerHTML = `<div class="dbg-empty">No frames available.</div>`;
    return;
  }
  el.innerHTML = frames
    .map(
      (f) => `
    <div class="dbg-frame-row${f.depth === debugState.selectedDepth ? " selected" : ""}" data-frame-depth="${f.depth}">
      <span><span class="dbg-frame-depth">#${f.depth}</span>${escapeHtml(f.source)}</span>
      <span>:${f.line}</span>
    </div>`
    )
    .join("");
}

function renderDebugBreakpoints() {
  const el = document.getElementById("dbg-bp-list");
  if (!el) return;
  const entries = [];
  for (const [src, lines] of Object.entries(debugState.breakpoints)) {
    for (const ln of lines) entries.push({ src, ln });
  }
  if (!entries.length) {
    el.innerHTML = `<div class="dbg-empty">No breakpoints set. Click a gutter line number to add one.</div>`;
    return;
  }
  el.innerHTML = entries
    .map(
      (bp) => `
    <div class="dbg-bp-row">
      <span class="dbg-bp-label" data-jump-src="${escapeHtml(bp.src)}" data-jump-line="${bp.ln}" title="${escapeHtml(bp.src)}:${bp.ln}">${escapeHtml(bp.src)}:${bp.ln}</span>
      <button type="button" class="icon-btn sm" data-rm-bp-src="${escapeHtml(bp.src)}" data-rm-bp-line="${bp.ln}" title="Remove breakpoint">&times;</button>
    </div>`
    )
    .join("");
}

function renderDebugEvalHistory() {
  const el = document.getElementById("dbg-eval-history");
  if (!el) return;
  if (!debugState.evalHistory.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = debugState.evalHistory
    .map((item) => {
      const out = item.error
        ? `<div class="dbg-eval-res is-err">${escapeHtml(item.error.error_type)}: ${escapeHtml(item.error.message)}</div>`
        : `<div class="dbg-eval-res">${item.stdout ? escapeHtml(item.stdout) : ""}${item.result ? escapeHtml(item.result.repr) + ` <span class="dbg-local-type">${escapeHtml(item.result.type_name)}</span>` : "nil"}</div>`;
      return `<div class="dbg-eval-entry"><div class="dbg-eval-expr">&gt; ${escapeHtml(item.expr)}</div>${out}</div>`;
    })
    .join("");
  el.scrollTop = el.scrollHeight;
}

function renderDebugOutput() {
  const el = document.getElementById("dbg-output-box");
  const banner = document.getElementById("dbg-loc-banner");
  if (!el) return;
  const sess = debugState.session;
  if (banner) {
    if (sess && sess.status === "paused") {
      const reason = sess.reason || "paused";
      const isErr = reason === "error";
      banner.className = `dbg-loc-banner${isErr ? " is-err" : ""}`;
      banner.textContent = isErr && sess.error
        ? `Error at ${debugState.activeSource || ""}:${debugState.activeLine || "?"} — ${sess.error.error_type}: ${sess.error.message}`
        : `Paused (${reason}) at ${debugState.activeSource || ""}:${debugState.activeLine || "?"}`;
    } else {
      banner.className = "dbg-loc-banner hidden";
    }
  }
  if (!sess) {
    el.innerHTML = `<div class="dbg-empty">No output yet.</div>`;
    return;
  }
  let html = "";
  if (sess.stdout) {
    html += `<div>${escapeHtml(sess.stdout)}</div>`;
  }
  if (sess.status === "completed" && sess.result && !sess.result.is_nil) {
    html += `<div class="dbg-output-res">=&gt; ${escapeHtml(sess.result.repr)} (${escapeHtml(sess.result.type_name)})</div>`;
  }
  if (sess.error) {
    html += `<div class="dbg-output-err">${escapeHtml(sess.error.error_type)}: ${escapeHtml(sess.error.message)}${sess.error.traceback ? "\n" + escapeHtml(sess.error.traceback) : ""}</div>`;
  }
  if (!html) {
    html = `<div class="dbg-empty">${sess.status === "completed" ? "Execution completed." : "No output yet."}</div>`;
  }
  el.innerHTML = html;
}

function renderDebugDrawer() {
  renderDebugTransport();
  renderDebugSource();
  renderDebugLocals();
  renderDebugFrames();
  renderDebugBreakpoints();
  renderDebugEvalHistory();
  renderDebugOutput();
}


export function initDebugger() {
  // Wire debugger DOM events
  document.getElementById("btn-toggle-debug")?.addEventListener("click", toggleDebugDrawer);
  document.getElementById("btn-close-debug")?.addEventListener("click", () => openDebugDrawer(false));
  document.getElementById("ftb-debug")?.addEventListener("click", () => {
    const tab = activeTab();
    if (tab && tab.kind === "file") startDebuggingFile(tab);
  });
  document.getElementById("dbg-btn-start")?.addEventListener("click", startDebuggingActive);
  document.getElementById("dbg-btn-continue")?.addEventListener("click", () => debugStep("continue"));
  document.getElementById("dbg-btn-step-over")?.addEventListener("click", () => debugStep("step_over"));
  document.getElementById("dbg-btn-step-in")?.addEventListener("click", () => debugStep("step_in"));
  document.getElementById("dbg-btn-step-out")?.addEventListener("click", () => debugStep("step_out"));
  document.getElementById("dbg-btn-stop")?.addEventListener("click", debugStop);
  document.getElementById("dbg-btn-clear-bps")?.addEventListener("click", clearAllBreakpoints);

  document.getElementById("dbg-opt-break-error")?.addEventListener("change", async (e) => {
    if (debugState.session && debugState.session.status === "paused") {
      try {
        await api(`/api/debug/${encodeURIComponent(debugState.session.id)}/config`, {
          method: "POST",
          body: JSON.stringify({ break_on_error: !!e.target.checked }),
        });
      } catch (err) {
        toast(`Config update failed: ${err.message}`, "error");
      }
    }
  });

  document.getElementById("file-editor-gutter")?.addEventListener("click", (e) => {
    const row = e.target.closest(".fe-gutter-line");
    if (!row) return;
    const tab = activeTab();
    if (!tab || tab.kind !== "file" || tab.extension !== "mini") return;
    const ln = Number(row.dataset.line);
    if (ln > 0) toggleBreakpoint(tab.path, ln);
  });

  document.getElementById("dbg-source-lines")?.addEventListener("click", (e) => {
    const lnEl = e.target.closest(".dbg-src-ln");
    if (!lnEl) return;
    const src = lnEl.dataset.bpSrc;
    const ln = Number(lnEl.dataset.bpLine);
    if (src && ln > 0) toggleBreakpoint(src, ln);
  });

  document.getElementById("dbg-frames-list")?.addEventListener("click", (e) => {
    const row = e.target.closest(".dbg-frame-row");
    if (!row) return;
    const depth = Number(row.dataset.frameDepth);
    if (!Number.isNaN(depth)) debugSelectFrame(depth);
  });

  document.getElementById("dbg-bp-list")?.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm-bp-src]");
    if (rm) {
      toggleBreakpoint(rm.dataset.rmBpSrc, Number(rm.dataset.rmBpLine));
      return;
    }
    const jmp = e.target.closest("[data-jump-src]");
    if (jmp) {
      const src = jmp.dataset.jumpSrc;
      if (src && !src.startsWith("<") && !src.includes(" [Cell ")) {
        openPathInTab(src);
      }
    }
  });

  document.getElementById("dbg-eval-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("dbg-eval-input");
    if (!input) return;
    const expr = input.value.trim();
    if (!expr) return;
    input.value = "";
    await debugEval(expr);
  });

  document.addEventListener("keydown", (e) => {
    if (!debugState.session || debugState.session.status !== "paused") return;
    if (e.key === "F5") {
      e.preventDefault();
      if (e.shiftKey) debugStop();
      else debugStep("continue");
    } else if (e.key === "F10") {
      e.preventDefault();
      debugStep("step_over");
    } else if (e.key === "F11") {
      e.preventDefault();
      if (e.shiftKey) debugStep("step_out");
      else debugStep("step_in");
    }
  });
}

export {
  debugState,
  getBreakpointsForSource,
  refreshActiveFileGutter,
  toggleBreakpoint,
  clearAllBreakpoints,
  openDebugDrawer,
  toggleDebugDrawer,
  ensureDebugSourceLoaded,
  applyDebugSnapshot,
  startDebuggingPayload,
  startDebuggingFile,
  startDebuggingCell,
  startDebuggingActive,
  debugStep,
  debugStop,
  debugSelectFrame,
  debugEval,
  renderDebugTransport,
  renderDebugSource,
  renderDebugLocals,
  renderDebugFrames,
  renderDebugBreakpoints,
  renderDebugEvalHistory,
  renderDebugOutput,
  renderDebugDrawer,
};
