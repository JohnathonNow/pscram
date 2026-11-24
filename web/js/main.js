/**
 * pSCRAM Workbench Application Bootstrap (Native ES Modules).
 */

import "./minijs/index.js";
import { escapeHtml } from "./core/highlight.js";
import {
  authState,
  getStoredAccessToken,
  updateAuthUI,
  waitForLogin,
  refreshAuthTokens,
  api,
  startAuthRefreshLoop,
  initAuthControls,
} from "./core/auth.js";
import { initModalControls } from "./core/ui_helpers.js";
import { state, activeTab } from "./core/state.js";
import { initMediaControls } from "./features/media.js";
import { loadDirectory, initFileExplorer } from "./features/files.js";
import { openPathInTab, createUntitledNotebook, saveActiveTab, initViewers } from "./features/viewers.js";
import { refreshKernelList, initNotebook } from "./features/notebook.js";
import { initScriptTools } from "./features/script_tools.js";
import { openCommandPalette, openGrepModal, initManagers } from "./features/managers.js";
import { toggleCellAgy, openFileAgyPanel, initAgyControls } from "./features/agy.js";
import { initDebugger } from "./features/debugger.js";

function initShellChrome() {
  document.getElementById("btn-toggle-sidebar").onclick = () => {
    document.getElementById("sidebar").classList.toggle("hidden");
    document.getElementById("sidebar-resizer").classList.toggle("hidden");
  };

  document.getElementById("btn-theme").onclick = () => {
    const html = document.documentElement;
    const next = html.dataset.theme === "dark" ? "light" : "dark";
    html.dataset.theme = next;
    localStorage.setItem("ml_theme", next);
  };
  const savedTheme = localStorage.getItem("ml_theme");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;

  // Sidebar drag resizer
  (() => {
    const resizer = document.getElementById("sidebar-resizer");
    const sidebar = document.getElementById("sidebar");
    let dragging = false;
    resizer.addEventListener("mousedown", () => {
      dragging = true;
      resizer.classList.add("dragging");
      document.body.style.cursor = "col-resize";
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const w = Math.max(190, Math.min(520, e.clientX));
      sidebar.style.width = `${w}px`;
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove("dragging");
      document.body.style.cursor = "";
    });
  })();

  // Global keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === "p") {
      e.preventDefault();
      openCommandPalette();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === "p") {
      e.preventDefault();
      openCommandPalette("");
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === "f") {
      e.preventDefault();
      openGrepModal();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && key === "s") {
      e.preventDefault();
      saveActiveTab();
    } else if ((e.ctrlKey || e.metaKey) && key === "b") {
      e.preventDefault();
      document.getElementById("sidebar").classList.toggle("hidden");
      document.getElementById("sidebar-resizer").classList.toggle("hidden");
    } else if ((e.ctrlKey || e.metaKey) && key === "k") {
      const tab = activeTab();
      if (!tab) return;
      if (tab.kind === "notebook") {
        e.preventDefault();
        const cell = tab.doc.cells.find((c) => c.id === tab.activeCellId) || tab.doc.cells[0];
        if (cell) toggleCellAgy(tab, cell, true);
      } else if (tab.kind === "file") {
        e.preventDefault();
        openFileAgyPanel(tab);
      }
    }
  });
}

async function init() {
  initModalControls();
  initAuthControls();
  initShellChrome();
  initMediaControls();
  initFileExplorer();
  initViewers();
  initNotebook();
  initScriptTools();
  initManagers();
  initAgyControls();
  initDebugger();

    try {
      const headers = {};
      const existingTok = getStoredAccessToken();
      if (existingTok) headers["Authorization"] = `Bearer ${existingTok}`;
      const statusRes = await fetch("/api/auth/status", { headers });
      const authStatus = await statusRes.json().catch(() => ({}));
      authState.required = !!authStatus.auth_required;
      authState.requiredGroup = authStatus.required_group || null;
      if (authState.required) {
        if (authStatus.authenticated && authStatus.user) {
          authState.user = authStatus.user;
          updateAuthUI();
        } else {
          const refreshed = await refreshAuthTokens();
          if (!refreshed) {
            await waitForLogin();
          }
        }
        startAuthRefreshLoop();
      }
    } catch { /* ignore */ }

    try {
      const info = await api("/api/info");
      state.rootName = info.root_name || "workspace";
      state.rootPath = info.root_path || "";
      if (Array.isArray(info.languages) && info.languages.length > 0) {
        state.languages = info.languages;
      }
    } catch { /* ignore */ }

    const langSel = document.getElementById("tb-lang-select");
    if (langSel) {
      langSel.innerHTML = state.languages
        .filter((l) => l.supports_notebook)
        .map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`)
        .join("");
    }

    await loadDirectory("");

    // Auto-open notebooks/welcome.mnb if it exists, otherwise start an empty notebook
    try {
      await api(`/api/file?path=${encodeURIComponent("notebooks/welcome.mnb")}`);
      await openPathInTab("notebooks/welcome.mnb");
    } catch {
      await createUntitledNotebook();
    }
    refreshKernelList();
}

init();
