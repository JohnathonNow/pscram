/**
 * Workspace File Explorer: directory tree, search, upload/ZIP, clipboard operations,
 * file/folder creation prompts, and right-click context menu.
 */

import { escapeHtml } from "../core/highlight.js";
import { api, authFetch, authState } from "../core/auth.js";
import { toast, showModal, formatSize, parentDirOf, copyTextToClipboard } from "../core/ui_helpers.js";
import { state, langInfo, langByExtension, activeTab, buildAbsolutePath, updateStatusBar } from "../core/state.js";
import { rawFileUrl } from "./media.js";
import {
  openPathInTab,
  createUntitledNotebook,
  closeTab,
  renderTabs,
  renderActiveWorkspace,
} from "./viewers.js";
import { launchBackgroundJobQuick, openSchedulesModal } from "./managers.js";

// --- File Browser ---
function fileIconSvg(entry) {
  if (entry.kind === "dir") {
    return `<span class="file-icon dir"><svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg></span>`;
  }
  if (entry.is_notebook) {
    return `<span class="file-icon mnb"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="9" y1="8" x2="16" y2="8"/><line x1="9" y1="12" x2="14" y2="12"/></svg></span>`;
  }
  if (entry.is_minilang) {
    return `<span class="file-icon mini"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg></span>`;
  }
  if (entry.is_rust) {
    return `<span class="file-icon rust"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg></span>`;
  }
  if (entry.is_ui) {
    return `<span class="file-icon ui"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg></span>`;
  }
  if (entry.is_image) {
    return `<span class="file-icon image"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></span>`;
  }
  if (entry.is_pdf) {
    return `<span class="file-icon pdf"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg></span>`;
  }
  if (entry.is_markdown) {
    return `<span class="file-icon md"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4z" rx="2"/><path d="M7 15V9l3 3 3-3v6"/><path d="M17 9v6"/></svg></span>`;
  }
  if (entry.is_log) {
    return `<span class="file-icon log"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg></span>`;
  }
  return `<span class="file-icon generic"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg></span>`;
}

async function loadDirectory(relPath = state.currentDir) {
  try {
    const qs = new URLSearchParams({
      path: relPath,
      show_hidden: state.showHidden ? "true" : "false",
    });
    const data = await api(`/api/files?${qs}`);
    state.currentDir = data.path;
    state.dirEntries = data.entries;
    renderBreadcrumbs();
    renderFileList(data.entries, false);
  } catch (e) {
    toast(`Failed to list files: ${e.message}`, "error");
  }
}

async function searchFiles(query) {
  state.searchQuery = query;
  const clearBtn = document.getElementById("btn-clear-search");
  clearBtn.classList.toggle("hidden", !query);
  if (!query.trim()) {
    loadDirectory(state.currentDir);
    return;
  }
  try {
    const data = await api(`/api/files/search?q=${encodeURIComponent(query)}`);
    renderFileList(data.entries, true);
  } catch (e) {
    toast(`Search failed: ${e.message}`, "error");
  }
}

function renderBreadcrumbs() {
  const el = document.getElementById("breadcrumbs");
  const parts = state.currentDir ? state.currentDir.split("/").filter(Boolean) : [];
  let html = `<span class="crumb" data-path="">${escapeHtml(state.rootName)}</span>`;
  let accum = "";
  for (const part of parts) {
    accum = accum ? `${accum}/${part}` : part;
    html += `<span class="crumb-sep">/</span><span class="crumb" data-path="${escapeHtml(accum)}">${escapeHtml(part)}</span>`;
  }
  el.innerHTML = html;
  el.querySelectorAll(".crumb").forEach((c) => {
    c.onclick = () => {
      document.getElementById("file-search-input").value = "";
      state.searchQuery = "";
      document.getElementById("btn-clear-search").classList.add("hidden");
      loadDirectory(c.dataset.path);
    };
  });
}

function renderFileList(entries, isSearch) {
  const listEl = document.getElementById("file-list");
  const tab = activeTab();
  const openPath = tab ? tab.path : null;

  if (!entries.length) {
    listEl.innerHTML = `<div class="file-empty">${isSearch ? "No matching files" : "Empty folder"}</div>`;
    return;
  }

  let html = "";
  if (!isSearch && state.currentDir) {
    const parent = state.currentDir.includes("/")
      ? state.currentDir.slice(0, state.currentDir.lastIndexOf("/"))
      : "";
    html += `
      <div class="file-row" data-up="${escapeHtml(parent)}">
        <span class="file-icon dir">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
        </span>
        <span class="file-name">..</span>
      </div>`;
  }

  for (const entry of entries) {
    const selected = openPath && entry.path === openPath ? "selected" : "";
    const isCut = state.fileClipboard && state.fileClipboard.mode === "cut" && state.fileClipboard.path === entry.path ? "is-cut" : "";
    const subDir = isSearch && entry.path.includes("/")
      ? entry.path.slice(0, entry.path.lastIndexOf("/"))
      : "";
    html += `
      <div class="file-row ${selected} ${isCut}" data-path="${escapeHtml(entry.path)}" data-kind="${entry.kind}" data-notebook="${entry.is_notebook}">
        ${fileIconSvg(entry)}
        <span class="file-name" title="${escapeHtml(entry.path)}">${escapeHtml(entry.name)}</span>
        ${subDir ? `<span class="file-subpath">${escapeHtml(subDir)}</span>` : ""}
        ${entry.kind === "file" && !subDir ? `<span class="file-size">${formatSize(entry.size)}</span>` : ""}
        <span class="file-row-actions">
          <button class="icon-btn sm act-rename" title="Rename" data-path="${escapeHtml(entry.path)}">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
          <button class="icon-btn sm act-delete" title="Delete" data-path="${escapeHtml(entry.path)}">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </span>
      </div>`;
  }

  listEl.innerHTML = html;

  const entryByPath = new Map(entries.map((ent) => [ent.path, ent]));

  listEl.querySelectorAll(".file-row").forEach((row) => {
    if (row.dataset.up !== undefined) {
      row.onclick = () => loadDirectory(row.dataset.up);
      return;
    }
    row.onclick = (e) => {
      if (e.target.closest(".file-row-actions")) return;
      const p = row.dataset.path;
      if (row.dataset.kind === "dir") {
        document.getElementById("file-search-input").value = "";
        state.searchQuery = "";
        document.getElementById("btn-clear-search").classList.add("hidden");
        loadDirectory(p);
      } else {
        openPathInTab(p);
      }
    };
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ent = entryByPath.get(row.dataset.path) || {
        path: row.dataset.path,
        name: row.dataset.path.split("/").pop(),
        kind: row.dataset.kind,
      };
      openFileContextMenu(e.clientX, e.clientY, ent, row);
    });
  });

  listEl.querySelectorAll(".act-rename").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      renameFileEntry(btn.dataset.path);
    };
  });

  listEl.querySelectorAll(".act-delete").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      deleteFileEntry(btn.dataset.path);
    };
  });
}

function updateOpenTabsForMove(oldPath, newPath) {
  let changed = false;
  const prefix = `${oldPath}/`;
  for (const tab of state.tabs) {
    if (!tab.path) continue;
    if (tab.path === oldPath) {
      tab.path = newPath;
      tab.title = newPath.split("/").pop();
      changed = true;
    } else if (tab.path.startsWith(prefix)) {
      tab.path = `${newPath}/${tab.path.slice(prefix.length)}`;
      changed = true;
    }
  }
  if (changed) {
    renderTabs();
    updateStatusBar();
  }
}

async function renameFileEntry(oldPath) {
  const base = oldPath.split("/").pop();
  const dir = parentDirOf(oldPath);
  const newName = await showModal({
    title: "Rename",
    bodyHtml: `<p style="margin:0 0 10px;color:var(--text-secondary)">Rename <code>${escapeHtml(base)}</code> to:</p>`,
    confirmText: "Rename",
    inputValue: base,
  });
  if (!newName || !newName.trim() || newName.trim() === base) return;
  const trimmed = newName.trim();
  const to = dir ? `${dir}/${trimmed}` : trimmed;
  try {
    await api("/api/file/rename", { method: "POST", body: JSON.stringify({ from: oldPath, to }) });
    updateOpenTabsForMove(oldPath, to);
    if (state.fileClipboard) {
      if (state.fileClipboard.path === oldPath) {
        state.fileClipboard.path = to;
        state.fileClipboard.name = trimmed;
      } else if (state.fileClipboard.path.startsWith(`${oldPath}/`)) {
        state.fileClipboard.path = `${to}/${state.fileClipboard.path.slice(oldPath.length + 1)}`;
      }
    }
    toast(`Renamed to ${trimmed}`, "success");
    loadDirectory();
  } catch (err) {
    toast(`Rename failed: ${err.message}`, "error");
  }
}

async function deleteFileEntry(targetPath) {
  const ok = await showModal({
    title: "Delete",
    bodyHtml: `<p style="margin:0;color:var(--text-secondary)">Permanently delete <code>${escapeHtml(targetPath)}</code>?</p>`,
    confirmText: "Delete",
  });
  if (!ok) return;
  try {
    await api(`/api/file?path=${encodeURIComponent(targetPath)}`, { method: "DELETE" });
    const prefix = `${targetPath}/`;
    const tabsToClose = state.tabs
      .filter((t) => t.path === targetPath || (t.path && t.path.startsWith(prefix)))
      .map((t) => t.id);
    for (const id of tabsToClose) closeTab(id);
    if (state.fileClipboard && (state.fileClipboard.path === targetPath || state.fileClipboard.path.startsWith(prefix))) {
      state.fileClipboard = null;
    }
    toast(`Deleted ${targetPath}`, "success");
    loadDirectory();
  } catch (err) {
    toast(`Delete failed: ${err.message}`, "error");
  }
}

function setFileClipboard(mode, entry) {
  state.fileClipboard = {
    mode,
    path: entry.path,
    name: entry.name || entry.path.split("/").pop(),
    kind: entry.kind,
  };
  renderFileList(state.dirEntries, !!state.searchQuery);
  toast(`${mode === "cut" ? "Cut" : "Copied"} ${state.fileClipboard.name}`, "info");
}

async function pasteClipboardInto(targetDir) {
  const clip = state.fileClipboard;
  if (!clip) return;
  const destDir = targetDir || "";
  try {
    if (clip.mode === "copy") {
      const res = await api("/api/file/copy", {
        method: "POST",
        body: JSON.stringify({ from: clip.path, to_dir: destDir }),
      });
      toast(`Pasted ${res.path}`, "success");
      await loadDirectory();
    } else {
      const to = destDir ? `${destDir}/${clip.name}` : clip.name;
      if (to === clip.path) {
        state.fileClipboard = null;
        renderFileList(state.dirEntries, !!state.searchQuery);
        toast("Item is already in this folder", "info");
        return;
      }
      await api("/api/file/rename", {
        method: "POST",
        body: JSON.stringify({ from: clip.path, to }),
      });
      updateOpenTabsForMove(clip.path, to);
      state.fileClipboard = null;
      toast(`Moved to ${to}`, "success");
      await loadDirectory();
    }
  } catch (err) {
    toast(`Paste failed: ${err.message}`, "error");
  }
}

async function duplicateEntry(entry) {
  const dir = parentDirOf(entry.path);
  try {
    const res = await api("/api/file/copy", {
      method: "POST",
      body: JSON.stringify({ from: entry.path, to_dir: dir }),
    });
    toast(`Duplicated as ${res.path.split("/").pop()}`, "success");
    await loadDirectory();
  } catch (err) {
    toast(`Duplicate failed: ${err.message}`, "error");
  }
}

async function openEntryAsNotebook(entry) {
  try {
    const file = await api(`/api/file?path=${encodeURIComponent(entry.path)}`);
    const fileLang = langByExtension(file.extension);
    const doc = await api("/api/notebook/from-script", {
      method: "POST",
      body: JSON.stringify({
        title: file.name,
        content: file.content,
        language: fileLang ? fileLang.id : "minilang",
      }),
    });
    const nbTitle = file.name.replace(/\.[^.]+$/i, "") + ".mnb";
    await createUntitledNotebook(doc, nbTitle, null, doc.language);
  } catch (err) {
    toast(`Open as notebook failed: ${err.message}`, "error");
  }
}

async function downloadFileEntry(relPath) {
  const url = `/api/file/raw?path=${encodeURIComponent(relPath)}&download=1`;
  const fileName = relPath.split("/").pop() || "download";
  if (!authState.required) {
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  try {
    const res = await authFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
  } catch (err) {
    toast(`Download failed: ${err.message}`, "error");
  }
}

const CTX_ICONS = {
  open: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  cut: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  paste: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>`,
  path: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
  download: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  rename: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
  ui: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>`,
};

let activeContextRow = null;

function closeFileContextMenu() {
  const menu = document.getElementById("file-context-menu");
  if (menu) {
    menu.classList.add("hidden");
    menu.innerHTML = "";
  }
  if (activeContextRow) {
    activeContextRow.classList.remove("context-target");
    activeContextRow = null;
  }
}

function openFileContextMenu(x, y, entry, rowEl = null) {
  closeFileContextMenu();
  const menu = document.getElementById("file-context-menu");
  if (!menu) return;

  if (rowEl) {
    activeContextRow = rowEl;
    rowEl.classList.add("context-target");
  }

  const clip = state.fileClipboard;
  const clipHint = clip ? `${clip.mode === "cut" ? "Move" : "Copy"}: ${clip.name}` : "";
  const items = [];

  if (entry && entry.kind === "dir") {
    items.push({ header: entry.name });
    items.push({
      label: "Open Folder",
      icon: CTX_ICONS.folder,
      action: () => {
        document.getElementById("file-search-input").value = "";
        state.searchQuery = "";
        document.getElementById("btn-clear-search").classList.add("hidden");
        loadDirectory(entry.path);
      },
    });
    items.push({ sep: true });
    items.push({ label: "New Notebook Here", icon: CTX_ICONS.plus, action: () => promptNewNotebook(entry.path) });
    items.push({ label: "New File Here", icon: CTX_ICONS.plus, action: () => promptNewFile(entry.path) });
    items.push({ label: "New UI Here", icon: CTX_ICONS.ui, action: () => promptNewUi(entry.path) });
    items.push({ label: "New Folder Here", icon: CTX_ICONS.folder, action: () => promptNewFolder(entry.path) });
    items.push({ sep: true });
    items.push({ label: "Cut", icon: CTX_ICONS.cut, action: () => setFileClipboard("cut", entry) });
    items.push({ label: "Copy", icon: CTX_ICONS.copy, action: () => setFileClipboard("copy", entry) });
    items.push({
      label: "Paste into Folder",
      icon: CTX_ICONS.paste,
      hint: clipHint,
      disabled: !clip,
      action: () => pasteClipboardInto(entry.path),
    });
    items.push({ label: "Duplicate", icon: CTX_ICONS.copy, action: () => duplicateEntry(entry) });
    items.push({ sep: true });
    items.push({
      label: "Copy Relative Path",
      icon: CTX_ICONS.path,
      action: () => copyTextToClipboard(entry.path, `Copied path: ${entry.path}`),
    });
    items.push({
      label: "Copy Absolute Path",
      icon: CTX_ICONS.path,
      action: () => {
        const abs = buildAbsolutePath(entry.path);
        copyTextToClipboard(abs, `Copied absolute path`);
      },
    });
    items.push({
      label: "Copy Name",
      icon: CTX_ICONS.copy,
      action: () => copyTextToClipboard(entry.name, `Copied name: ${entry.name}`),
    });
    items.push({ sep: true });
    items.push({ label: "Download as ZIP", icon: CTX_ICONS.download, action: () => downloadFolderZip(entry.path) });
    items.push({ label: "Rename", icon: CTX_ICONS.rename, action: () => renameFileEntry(entry.path) });
    items.push({ label: "Delete", icon: CTX_ICONS.trash, danger: true, action: () => deleteFileEntry(entry.path) });
  } else if (entry) {
    const ext = (entry.extension || (entry.name.includes(".") ? entry.name.split(".").pop() : "") || "").toLowerCase();
    const targetDir = parentDirOf(entry.path);
    items.push({ header: entry.name });
    items.push({ label: "Open", icon: CTX_ICONS.open, action: () => openPathInTab(entry.path) });
    if (ext === "ui") {
      items.push({
        label: "Launch UI",
        icon: CTX_ICONS.ui,
        action: () => window.open(`/ui/${encodeURI(entry.path)}`, "_blank", "noopener"),
      });
    }
    if (ext === "mini" || ext === "rs") {
      items.push({
        label: "Open as Notebook",
        icon: CTX_ICONS.open,
        action: () => openEntryAsNotebook(entry),
      });
      items.push({
        label: "Run in Background",
        icon: CTX_ICONS.open,
        action: () => launchBackgroundJobQuick(entry.path),
      });
      items.push({
        label: "Schedule Script...",
        icon: CTX_ICONS.refresh,
        action: () => openSchedulesModal(entry.path),
      });
    }
    items.push({ sep: true });
    items.push({ label: "Cut", icon: CTX_ICONS.cut, action: () => setFileClipboard("cut", entry) });
    items.push({ label: "Copy", icon: CTX_ICONS.copy, action: () => setFileClipboard("copy", entry) });
    items.push({
      label: "Paste",
      icon: CTX_ICONS.paste,
      hint: clipHint,
      disabled: !clip,
      action: () => pasteClipboardInto(targetDir),
    });
    items.push({ label: "Duplicate", icon: CTX_ICONS.copy, action: () => duplicateEntry(entry) });
    items.push({ sep: true });
    items.push({
      label: "Copy Relative Path",
      icon: CTX_ICONS.path,
      action: () => copyTextToClipboard(entry.path, `Copied path: ${entry.path}`),
    });
    items.push({
      label: "Copy Absolute Path",
      icon: CTX_ICONS.path,
      action: () => {
        const abs = buildAbsolutePath(entry.path);
        copyTextToClipboard(abs, `Copied absolute path`);
      },
    });
    items.push({
      label: "Copy File Name",
      icon: CTX_ICONS.copy,
      action: () => copyTextToClipboard(entry.name, `Copied name: ${entry.name}`),
    });
    items.push({ sep: true });
    items.push({ label: "Download", icon: CTX_ICONS.download, action: () => downloadFileEntry(entry.path) });
    items.push({ label: "Rename", icon: CTX_ICONS.rename, action: () => renameFileEntry(entry.path) });
    items.push({ label: "Delete", icon: CTX_ICONS.trash, danger: true, action: () => deleteFileEntry(entry.path) });
  } else {
    const curDir = state.currentDir || "";
    items.push({ header: curDir || state.rootName || "/" });
    items.push({ label: "New Notebook", icon: CTX_ICONS.plus, action: () => promptNewNotebook(curDir) });
    items.push({ label: "New File", icon: CTX_ICONS.plus, action: () => promptNewFile(curDir) });
    items.push({ label: "New UI", icon: CTX_ICONS.ui, action: () => promptNewUi(curDir) });
    items.push({ label: "New Folder", icon: CTX_ICONS.folder, action: () => promptNewFolder(curDir) });
    items.push({ sep: true });
    items.push({
      label: "Paste",
      icon: CTX_ICONS.paste,
      hint: clipHint,
      disabled: !clip,
      action: () => pasteClipboardInto(curDir),
    });
    items.push({ sep: true });
    items.push({
      label: "Copy Folder Path",
      icon: CTX_ICONS.path,
      action: () => copyTextToClipboard(curDir || ".", `Copied path: ${curDir || "."}`),
    });
    items.push({
      label: "Copy Absolute Path",
      icon: CTX_ICONS.path,
      action: () => copyTextToClipboard(buildAbsolutePath(curDir), "Copied absolute path"),
    });
    items.push({ sep: true });
    items.push({ label: "Upload Files...", icon: CTX_ICONS.plus, action: () => document.getElementById("file-upload-input")?.click() });
    items.push({ label: "Download Folder as ZIP", icon: CTX_ICONS.download, action: () => downloadFolderZip(curDir) });
    items.push({ label: "Refresh", icon: CTX_ICONS.refresh, action: () => loadDirectory() });
  }

  const frag = document.createDocumentFragment();
  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement("div");
      sep.className = "context-menu-sep";
      frag.appendChild(sep);
      continue;
    }
    if (item.header) {
      const hdr = document.createElement("div");
      hdr.className = "context-menu-header";
      hdr.textContent = item.header;
      hdr.title = item.header;
      frag.appendChild(hdr);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `context-menu-item${item.danger ? " danger" : ""}${item.disabled ? " disabled" : ""}`;
    btn.setAttribute("role", "menuitem");
    if (item.disabled) btn.disabled = true;
    btn.innerHTML = `
      <span class="context-menu-item-icon">${item.icon || ""}</span>
      <span class="context-menu-item-label">${escapeHtml(item.label)}</span>
      ${item.hint ? `<span class="context-menu-item-hint" title="${escapeHtml(item.hint)}">${escapeHtml(item.hint)}</span>` : ""}
    `;
    if (!item.disabled) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeFileContextMenu();
        item.action();
      });
    }
    frag.appendChild(btn);
  }

  menu.innerHTML = "";
  menu.appendChild(frag);
  menu.classList.remove("hidden");

  // Position clamped to viewport
  const pad = 8;
  const rect = menu.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width + pad > window.innerWidth) {
    left = Math.max(pad, window.innerWidth - rect.width - pad);
  }
  if (top + rect.height + pad > window.innerHeight) {
    top = Math.max(pad, window.innerHeight - rect.height - pad);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

// Sidebar file creation helpers & buttons
async function promptNewNotebook(targetDir = state.currentDir) {
  const dir = targetDir || "";
  const langOpts = state.languages
    .filter((l) => l.supports_notebook)
    .map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)} (${escapeHtml(l.version)})</option>`)
    .join("");
  const name = await showModal({
    title: "New Notebook",
    bodyHtml: `
      <p style="margin:0 0 8px;color:var(--text-secondary)">Language kernel:</p>
      <select id="modal-lang-select" class="modal-input" style="margin-bottom:12px">${langOpts}</select>
      <p style="margin:0 0 8px;color:var(--text-secondary)">Create in <code>${escapeHtml(dir || "/")}</code>:</p>`,
    confirmText: "Create",
    inputValue: "untitled.mnb",
  });
  if (!name || !name.trim()) return;
  const chosenLang = document.getElementById("modal-lang-select")?.value || "minilang";
  const fname = name.trim().endsWith(".mnb") ? name.trim() : `${name.trim()}.mnb`;
  const fullPath = dir ? `${dir}/${fname}` : fname;
  try {
    await api("/api/file/new", {
      method: "POST",
      body: JSON.stringify({ path: fullPath, kind: "notebook", language: chosenLang }),
    });
    await loadDirectory();
    await openPathInTab(fullPath);
    toast(`Created ${fname} (${langInfo(chosenLang).name})`, "success");
  } catch (e) {
    toast(e.message, "error");
  }
}

async function promptNewUi(targetDir = state.currentDir) {
  const dir = targetDir || "";
  const name = await showModal({
    title: "New Minilang UI (.ui)",
    bodyHtml: `<p style="margin:0 0 10px;color:var(--text-secondary)">Create UI file in <code>${escapeHtml(dir || "/")}</code>:</p>`,
    confirmText: "Create",
    inputValue: "app.ui",
  });
  if (!name || !name.trim()) return;
  const fname = name.trim().endsWith(".ui") ? name.trim() : `${name.trim()}.ui`;
  const fullPath = dir ? `${dir}/${fname}` : fname;
  try {
    await api("/api/file/new", { method: "POST", body: JSON.stringify({ path: fullPath, kind: "ui" }) });
    await loadDirectory();
    await openPathInTab(fullPath);
    toast(`Created ${fname}`, "success");
  } catch (e) {
    toast(e.message, "error");
  }
}

async function promptNewFile(targetDir = state.currentDir) {
  const dir = targetDir || "";
  const name = await showModal({
    title: "New File",
    bodyHtml: `<p style="margin:0 0 10px;color:var(--text-secondary)">Create file in <code>${escapeHtml(dir || "/")}</code>:</p>`,
    confirmText: "Create",
    inputValue: "script.mini",
  });
  if (!name || !name.trim()) return;
  const fullPath = dir ? `${dir}/${name.trim()}` : name.trim();
  try {
    await api("/api/file/new", { method: "POST", body: JSON.stringify({ path: fullPath, kind: "file" }) });
    await loadDirectory();
    await openPathInTab(fullPath);
  } catch (e) {
    toast(e.message, "error");
  }
}

async function promptNewFolder(targetDir = state.currentDir) {
  const dir = targetDir || "";
  const name = await showModal({
    title: "New Folder",
    bodyHtml: `<p style="margin:0 0 10px;color:var(--text-secondary)">Create folder in <code>${escapeHtml(dir || "/")}</code>:</p>`,
    confirmText: "Create",
    inputValue: "notebooks",
  });
  if (!name || !name.trim()) return;
  const fullPath = dir ? `${dir}/${name.trim()}` : name.trim();
  try {
    await api("/api/file/new", { method: "POST", body: JSON.stringify({ path: fullPath, kind: "dir" }) });
    await loadDirectory();
  } catch (e) {
    toast(e.message, "error");
  }
}

// =========================================================================
// Drag-and-Drop File Upload & Folder ZIP Download (#3)
// =========================================================================
async function uploadFilesToDir(fileList, targetDir = state.currentDir) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  let uploaded = 0;
  for (const file of files) {
    try {
      const qs = new URLSearchParams({ dir: targetDir || "", name: file.name });
      const res = await authFetch(`/api/file/upload?${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      uploaded++;
    } catch (err) {
      toast(`Upload '${file.name}' failed: ${err.message}`, "error");
    }
  }
  if (uploaded > 0) {
    toast(`Uploaded ${uploaded} file${uploaded === 1 ? "" : "s"} to ${targetDir || "/"}`, "success");
    loadDirectory();
  }
}

async function downloadFolderZip(relDir) {
  const url = `/api/file/zip?path=${encodeURIComponent(relDir || "")}`;
  const fname = `${(relDir ? relDir.split("/").pop() : state.rootName || "workspace")}.zip`;
  try {
    if (!authState.required) {
      const a = document.createElement("a");
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    const res = await authFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
  } catch (err) {
    toast(`ZIP download failed: ${err.message}`, "error");
  }
}

export function initFileExplorer() {

  document.getElementById("file-list").addEventListener("contextmenu", (e) => {
    if (e.target.closest(".file-row")) return;
    e.preventDefault();
    openFileContextMenu(e.clientX, e.clientY, null, null);
  });
  document.getElementById("file-list").addEventListener("scroll", closeFileContextMenu);
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("file-context-menu");
    if (menu && !menu.classList.contains("hidden") && !menu.contains(e.target)) {
      closeFileContextMenu();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeFileContextMenu();
  });
  window.addEventListener("resize", closeFileContextMenu);
  window.addEventListener("blur", closeFileContextMenu);



  document.getElementById("btn-new-notebook").onclick = () => promptNewNotebook();
  document.getElementById("btn-new-ui").onclick = () => promptNewUi();
  document.getElementById("btn-new-file").onclick = () => promptNewFile();
  document.getElementById("btn-new-folder").onclick = () => promptNewFolder();

  document.getElementById("btn-toggle-hidden").onclick = (e) => {
    state.showHidden = !state.showHidden;
    e.currentTarget.classList.toggle("active", state.showHidden);
    loadDirectory();
  };
  document.getElementById("btn-refresh-files").onclick = () => loadDirectory();

  let searchTimer = null;
  document.getElementById("file-search-input").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value;
    searchTimer = setTimeout(() => searchFiles(q), 180);
  });
  document.getElementById("btn-clear-search").onclick = () => {
    document.getElementById("file-search-input").value = "";
    searchFiles("");
  };

  document.getElementById("btn-upload-files")?.addEventListener("click", () => {
    document.getElementById("file-upload-input")?.click();
  });
  document.getElementById("file-upload-input")?.addEventListener("change", (e) => {
    if (e.target.files?.length) {
      uploadFilesToDir(e.target.files, state.currentDir);
      e.target.value = "";
    }
  });

  const sidebarEl = document.getElementById("sidebar");
  const dropzoneEl = document.getElementById("sidebar-dropzone");
  let dragDepth = 0;
  sidebarEl?.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    dragDepth++;
    sidebarEl.classList.add("drag-over");
    dropzoneEl?.classList.remove("hidden");
    const lbl = document.getElementById("sidebar-dropzone-label");
    if (lbl) lbl.textContent = `Drop files to upload to ${state.currentDir || "/"}`;
  });
  sidebarEl?.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
  });
  sidebarEl?.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      sidebarEl.classList.remove("drag-over");
      dropzoneEl?.classList.add("hidden");
    }
  });
  sidebarEl?.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    sidebarEl.classList.remove("drag-over");
    dropzoneEl?.classList.add("hidden");
    const dirRow = e.target.closest?.(".file-row[data-kind='dir']");
    const dest = dirRow ? dirRow.dataset.path : state.currentDir;
    uploadFilesToDir(e.dataTransfer.files, dest);
  });
}

export {
  fileIconSvg,
  loadDirectory,
  searchFiles,
  renderBreadcrumbs,
  renderFileList,
  updateOpenTabsForMove,
  renameFileEntry,
  deleteFileEntry,
  setFileClipboard,
  pasteClipboardInto,
  duplicateEntry,
  openEntryAsNotebook,
  downloadFileEntry,
  closeFileContextMenu,
  openFileContextMenu,
  promptNewNotebook,
  promptNewUi,
  promptNewFile,
  promptNewFolder,
  uploadFilesToDir,
  downloadFolderZip,
};
