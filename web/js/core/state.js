/**
 * Central Workbench application state and active-tab / status-bar helpers.
 */

import { renderTabs } from "../features/viewers.js";

// --- Application State ---
const state = {
  rootName: "workspace",
  rootPath: "",
  languages: [
    { id: "minilang", name: "Minilang", version: "2.17.0", extensions: ["mini"], supports_notebook: true, supports_invoke: true, supports_ui: true },
    { id: "rust", name: "Rust", version: "1.x", extensions: ["rs"], supports_notebook: true, supports_invoke: true, supports_ui: false },
  ],
  currentDir: "",
  showHidden: false,
  searchQuery: "",
  dirEntries: [],
  fileClipboard: null, // { mode: "copy"|"cut", path, name, kind }
  tabs: [], // { id, kind: 'notebook'|'file', path, title, dirty, kernelId, language?, doc?, activeCellId?, content?, extension? }
  activeTabId: null,
  varsOpen: false,
  ac: { visible: false, items: [], index: 0, cellId: null, textarea: null, startPos: 0 },
};

function langInfo(id) {
  return state.languages.find((l) => l.id === id) || state.languages[0];
}

function langByExtension(ext) {
  if (!ext) return null;
  if (ext === "ui") return langInfo("minilang");
  return state.languages.find((l) => (l.extensions || []).includes(ext)) || null;
}

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeTabId) || null;
}


function buildAbsolutePath(relPath) {
  const base = (state.rootPath || "").replace(/\/+$/, "");
  if (!base) return relPath || "/";
  return relPath ? `${base}/${relPath}` : base;
}

function markDirty(tab) {
  if (!tab.dirty) {
    tab.dirty = true;
    renderTabs();
  }
}

function updateStatusBar() {
  const tab = activeTab();
  if (!tab) return;
  document.getElementById("status-path").textContent = tab.path || `${tab.title} (unsaved)`;
  if (tab.kind === "notebook") {
    const n = tab.doc.cells.length;
    document.getElementById("status-cells").textContent = `${n} cell${n === 1 ? "" : "s"}`;
  } else {
    const lines = (tab.content || "").split("\n").length;
    document.getElementById("status-cells").textContent = `${lines} lines`;
  }
}

export {
  state,
  langInfo,
  langByExtension,
  activeTab,
  buildAbsolutePath,
  markDirty,
  updateStatusBar,
};
