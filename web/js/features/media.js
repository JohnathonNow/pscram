/**
 * Media URL builders, thumbnail cards, lightbox viewer, and image zoom/rotate controls.
 */

import { escapeHtml } from "../core/highlight.js";
import { getStoredAccessToken, authState } from "../core/auth.js";
import { formatSize } from "../core/ui_helpers.js";
import { state, activeTab } from "../core/state.js";
import { openPathInTab, renderActiveWorkspace } from "./viewers.js";

// --- Media URL & Thumbnail Helpers ---
function rawFileUrl(relPath, download = false) {
  const qs = new URLSearchParams({ path: relPath || "" });
  if (download) qs.set("download", "1");
  const tok = authState.required ? getStoredAccessToken() : null;
  if (tok) qs.set("token", tok);
  return `/api/file/raw?${qs.toString()}`;
}

function resolveWorkspaceRelPath(href, baseFilePath = "") {
  if (!href) return "";
  if (href.startsWith("/")) return href.replace(/^\/+/, "");
  const baseDir = baseFilePath && baseFilePath.includes("/")
    ? baseFilePath.slice(0, baseFilePath.lastIndexOf("/"))
    : (state.currentDir || "");
  const parts = (baseDir ? `${baseDir}/${href}` : href).split("/");
  const norm = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") norm.pop();
    else norm.push(p);
  }
  return norm.join("/");
}

function renderMediaThumbnailCard({ kind, src, path = null, name = "", mime = "", size = null }) {
  const safeSrc = escapeHtml(src);
  const safeName = escapeHtml(name || (path ? path.split("/").pop() : (kind === "pdf" ? "document.pdf" : "image")));
  const safePath = path ? escapeHtml(path) : "";
  const dlHref = path ? escapeHtml(rawFileUrl(path, true)) : safeSrc;
  const sizeText = typeof size === "number" && size > 0 ? ` · ${formatSize(size)}` : "";

  if (kind === "pdf") {
    const thumbSrc = src.startsWith("data:") ? src : `${src}#page=1&toolbar=0&navpanes=0&scrollbar=0&view=FitH`;
    return `
      <div class="media-thumb-card" data-media-kind="pdf" data-media-src="${safeSrc}" data-media-path="${safePath}" data-media-name="${safeName}">
        <div class="pdf-thumb-stage" title="Click to preview PDF">
          <iframe class="pdf-thumb-frame" src="${escapeHtml(thumbSrc)}" tabindex="-1" loading="lazy"></iframe>
          <div class="pdf-thumb-overlay">
            <span class="media-thumb-pill">${path ? "Open PDF Tab" : "Expand PDF"}</span>
          </div>
        </div>
        <div class="media-thumb-footer">
          <div class="media-thumb-label">
            <span class="media-kind-badge pdf">PDF</span>
            <span class="media-thumb-name" title="${safePath || safeName}">${safeName}${sizeText}</span>
          </div>
          <div class="media-thumb-actions">
            ${path ? `<button type="button" class="media-thumb-btn act-media-open">Open</button>` : ""}
            <button type="button" class="media-thumb-btn act-media-expand">Expand</button>
            <a class="media-thumb-btn" href="${dlHref}" download="${safeName}" style="text-decoration:none">&darr;</a>
          </div>
        </div>
      </div>`;
  }

  return `
    <div class="media-thumb-card" data-media-kind="image" data-media-src="${safeSrc}" data-media-path="${safePath}" data-media-name="${safeName}">
      <div class="media-thumb-stage" title="Click to open image">
        <img class="media-thumb-img" src="${safeSrc}" alt="${safeName}" loading="lazy" />
        <div class="pdf-thumb-overlay">
          <span class="media-thumb-pill">${path ? "Open Image Tab" : "Expand Image"}</span>
        </div>
      </div>
      <div class="media-thumb-footer">
        <div class="media-thumb-label">
          <span class="media-kind-badge img">IMG</span>
          <span class="media-thumb-name" title="${safePath || safeName}">${safeName}${sizeText}</span>
        </div>
        <div class="media-thumb-actions">
          ${path ? `<button type="button" class="media-thumb-btn act-media-open">Open</button>` : ""}
          <button type="button" class="media-thumb-btn act-media-expand">Expand</button>
          <a class="media-thumb-btn" href="${dlHref}" download="${safeName}" style="text-decoration:none">&darr;</a>
        </div>
      </div>
    </div>`;
}

function openMediaLightbox({ kind, src, path = "", name = "Preview" }) {
  const lb = document.getElementById("media-lightbox");
  const titleEl = document.getElementById("media-lightbox-title");
  const bodyEl = document.getElementById("media-lightbox-body");
  const openTabBtn = document.getElementById("media-lightbox-open-tab");
  const dlLink = document.getElementById("media-lightbox-download");
  if (!lb || !bodyEl) return;

  titleEl.textContent = path || name || "Preview";
  dlLink.href = path ? rawFileUrl(path, true) : src;
  dlLink.setAttribute("download", name || "download");

  if (path) {
    openTabBtn.classList.remove("hidden");
    openTabBtn.onclick = () => {
      closeMediaLightbox();
      openPathInTab(path);
    };
  } else {
    openTabBtn.classList.add("hidden");
  }

  bodyEl.innerHTML = "";
  if (kind === "pdf") {
    const iframe = document.createElement("iframe");
    iframe.src = src;
    iframe.title = name || "PDF Preview";
    bodyEl.appendChild(iframe);
  } else {
    const img = document.createElement("img");
    img.src = src;
    img.alt = name || "Image Preview";
    bodyEl.appendChild(img);
  }
  lb.classList.remove("hidden");
}

function closeMediaLightbox() {
  const lb = document.getElementById("media-lightbox");
  const bodyEl = document.getElementById("media-lightbox-body");
  if (lb) lb.classList.add("hidden");
  if (bodyEl) bodyEl.innerHTML = "";
}

function hydrateMediaPreviews(container) {
  if (!container) return;
  container.querySelectorAll(".media-thumb-card").forEach((card) => {
    if (card.dataset.mediaBound) return;
    card.dataset.mediaBound = "1";
    const kind = card.dataset.mediaKind || "image";
    const src = card.dataset.mediaSrc || "";
    const path = card.dataset.mediaPath || "";
    const name = card.dataset.mediaName || "Preview";

    const stage = card.querySelector(".media-thumb-stage, .pdf-thumb-stage");
    if (stage) {
      stage.onclick = (e) => {
        e.stopPropagation();
        if (path) openPathInTab(path);
        else openMediaLightbox({ kind, src, path, name });
      };
    }
    const openBtn = card.querySelector(".act-media-open");
    if (openBtn && path) {
      openBtn.onclick = (e) => {
        e.stopPropagation();
        openPathInTab(path);
      };
    }
    const expandBtn = card.querySelector(".act-media-expand");
    if (expandBtn) {
      expandBtn.onclick = (e) => {
        e.stopPropagation();
        openMediaLightbox({ kind, src, path, name });
      };
    }
  });
  container.querySelectorAll(".md-ws-link").forEach((a) => {
    if (a.dataset.wsBound) return;
    a.dataset.wsBound = "1";
    a.onclick = (e) => {
      e.preventDefault();
      const p = a.dataset.wsPath;
      if (p) openPathInTab(p);
    };
  });
}

function applyMediaImageTransform(tab) {
  const img = document.getElementById("media-image-el");
  const zoomLabel = document.getElementById("mtb-zoom-label");
  if (!img || !tab) return;
  const rot = tab.rotation || 0;
  if (tab.zoom === "fit") {
    img.classList.add("fit");
    img.style.width = "";
    img.style.height = "";
    img.style.transform = rot ? `rotate(${rot}deg)` : "";
    if (zoomLabel) zoomLabel.textContent = "Fit";
  } else {
    img.classList.remove("fit");
    const scale = Number(tab.zoom) || 1;
    if (img.naturalWidth > 0) {
      img.style.width = `${Math.round(img.naturalWidth * scale)}px`;
      img.style.height = "auto";
    }
    img.style.transform = rot ? `rotate(${rot}deg)` : "";
    if (zoomLabel) zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  }
}

export function initMediaControls() {
  // Media Viewer toolbar & Lightbox event handlers
  document.getElementById("mtb-zoom-in")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab.kind !== "media" || tab.mediaKind !== "image") return;
    const cur = tab.zoom === "fit" ? 1 : Number(tab.zoom) || 1;
    tab.zoom = Math.min(8, +(cur * 1.25).toFixed(2));
    applyMediaImageTransform(tab);
  });

  document.getElementById("mtb-zoom-out")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab.kind !== "media" || tab.mediaKind !== "image") return;
    const cur = tab.zoom === "fit" ? 1 : Number(tab.zoom) || 1;
    tab.zoom = Math.max(0.1, +(cur / 1.25).toFixed(2));
    applyMediaImageTransform(tab);
  });

  document.getElementById("mtb-zoom-fit")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab.kind !== "media") return;
    tab.zoom = "fit";
    applyMediaImageTransform(tab);
  });

  document.getElementById("mtb-zoom-100")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab.kind !== "media") return;
    tab.zoom = 1;
    applyMediaImageTransform(tab);
  });

  document.getElementById("mtb-rotate")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab.kind !== "media") return;
    tab.rotation = ((tab.rotation || 0) + 90) % 360;
    applyMediaImageTransform(tab);
  });

  document.getElementById("mtb-edit-svg")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab.kind !== "media" || tab.extension !== "svg") return;
    tab.kind = "file";
    renderActiveWorkspace();
  });

  document.getElementById("mtb-open-external")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || !tab.path) return;
    window.open(rawFileUrl(tab.path), "_blank", "noopener");
  });

  document.getElementById("mtb-download")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || !tab.path) return;
    const a = document.createElement("a");
    a.href = rawFileUrl(tab.path, true);
    a.download = tab.title;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  document.getElementById("media-lightbox-close")?.addEventListener("click", closeMediaLightbox);
  document.getElementById("media-lightbox")?.addEventListener("click", (e) => {
    if (e.target.id === "media-lightbox") closeMediaLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMediaLightbox();
  });

}

export {
  rawFileUrl,
  resolveWorkspaceRelPath,
  renderMediaThumbnailCard,
  openMediaLightbox,
  closeMediaLightbox,
  hydrateMediaPreviews,
  applyMediaImageTransform,
};
