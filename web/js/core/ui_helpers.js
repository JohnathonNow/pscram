/**
 * Reusable UI utilities: toasts, modal dialogs, formatting, clipboard, and path helpers.
 */

import { escapeHtml } from "./highlight.js";

// --- Toast Notifications ---
function toast(message, type = "info") {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.2s";
    setTimeout(() => el.remove(), 220);
  }, 2800);
}

// --- Modal Helper ---
let modalResolve = null;
function showModal({ title, bodyHtml, confirmText = "Confirm", inputValue = null, inputPlaceholder = "" }) {
  const backdrop = document.getElementById("modal-backdrop");
  document.getElementById("modal-title").textContent = title;
  const body = document.getElementById("modal-body");
  if (inputValue !== null) {
    body.innerHTML = `${bodyHtml || ""}<input id="modal-text-input" class="modal-input" type="text" placeholder="${escapeHtml(inputPlaceholder)}" />`;
    const inp = document.getElementById("modal-text-input");
    inp.value = inputValue;
    setTimeout(() => {
      inp.focus();
      const dotIdx = inputValue.lastIndexOf(".");
      if (dotIdx > 0) inp.setSelectionRange(0, dotIdx);
      else inp.select();
    }, 20);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") closeModal(inp.value);
      if (e.key === "Escape") closeModal(null);
    });
  } else {
    body.innerHTML = bodyHtml || "";
  }
  document.getElementById("modal-confirm").textContent = confirmText;
  backdrop.classList.remove("hidden");
  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

function closeModal(result) {
  document.getElementById("modal-backdrop").classList.add("hidden");
  if (modalResolve) {
    const fn = modalResolve;
    modalResolve = null;
    fn(result);
  }
}


function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
}


function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} M`;
}

function parentDirOf(relPath) {
  if (!relPath || !relPath.includes("/")) return "";
  return relPath.slice(0, relPath.lastIndexOf("/"));
}

async function copyTextToClipboard(text, label = "Copied") {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error("clipboard unavailable");
    }
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      ta.remove();
    }
  }
  toast(label, "success");
}

export function initModalControls() {
  document.getElementById("modal-close").onclick = () => closeModal(null);
  document.getElementById("modal-cancel").onclick = () => closeModal(null);
  document.getElementById("modal-confirm").onclick = () => {
    const inp = document.getElementById("modal-text-input");
    closeModal(inp ? inp.value : true);
  };
  document.getElementById("modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "modal-backdrop") closeModal(null);
  });

}

export {
  toast,
  showModal,
  closeModal,
  uid,
  formatSize,
  parentDirOf,
  copyTextToClipboard,
};
