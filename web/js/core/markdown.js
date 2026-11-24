/**
 * Lightweight GitHub-Flavored Markdown renderer (tables, syntax-highlighted code blocks,
 * task lists, and workspace media previews).
 */

import { escapeHtml, highlightMinilang, highlightRust, highlightCode } from "./highlight.js";
import { activeTab } from "./state.js";
import { rawFileUrl, resolveWorkspaceRelPath, renderMediaThumbnailCard } from "../features/media.js";

// --- Markdown Renderer (GFM Tables, Code Highlighting, Lists, Media Previews) ---
function renderMarkdown(md) {
  if (!md || !md.trim()) {
    return `<div class="md-placeholder">Double-click to edit Markdown...</div>`;
  }
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let inCode = false;
  let codeLang = "";
  let codeBuf = [];
  let listTag = null; // "ul" | "ol"

  const flushList = () => {
    if (listTag) {
      html += `</${listTag}>`;
      listTag = null;
    }
  };

  const inlineFmt = (text) => {
    let s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    // Markdown image thumbnail preview: ![alt](path-or-url)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, href) => {
      const isExt = /^https?:\/\/|^data:/i.test(href);
      const rel = isExt ? null : resolveWorkspaceRelPath(href, activeTab()?.path || "");
      const srcUrl = isExt ? href : rawFileUrl(rel);
      const label = alt || (rel ? rel.split("/").pop() : href.split("/").pop()) || "Image";
      return renderMediaThumbnailCard({ kind: "image", src: srcUrl, path: rel, name: label, mime: "image/*" });
    });
    // Markdown PDF thumbnail preview: [label](path/to/doc.pdf)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+\.pdf)\)/gi, (_, label, href) => {
      const isExt = /^https?:\/\//i.test(href);
      const rel = isExt ? null : resolveWorkspaceRelPath(href, activeTab()?.path || "");
      const srcUrl = isExt ? href : rawFileUrl(rel);
      return renderMediaThumbnailCard({ kind: "pdf", src: srcUrl, path: rel, name: label || (rel ? rel.split("/").pop() : "Document.pdf"), mime: "application/pdf" });
    });
    // External links
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // Workspace relative links (e.g. [greet.mini](scripts/greet.mini))
    s = s.replace(/\[([^\]]+)\]\(([^)\s#][^)\s]*)\)/g, (_, label, href) => {
      if (/^[a-z]+:/i.test(href)) return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
      const rel = resolveWorkspaceRelPath(href, activeTab()?.path || "");
      return `<a href="#" class="md-ws-link" data-ws-path="${escapeHtml(rel)}">${label}</a>`;
    });
    return s;
  };

  const isTableSep = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  const splitTableRow = (line) => {
    let t = line.trim();
    if (t.startsWith("|")) t = t.slice(1);
    if (t.endsWith("|")) t = t.slice(0, -1);
    return t.split("|").map((c) => c.trim());
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (line.trim().startsWith("```")) {
      flushList();
      if (!inCode) {
        inCode = true;
        codeLang = line.trim().slice(3).trim().toLowerCase();
        codeBuf = [];
      } else {
        const raw = codeBuf.join("\n");
        let body;
        if (codeLang === "minilang" || codeLang === "mini") {
          body = highlightMinilang(raw);
        } else if (codeLang === "rust" || codeLang === "rs") {
          body = highlightRust(raw);
        } else {
          body = escapeHtml(raw);
        }
        const langTag = codeLang ? `<span class="md-code-lang">${escapeHtml(codeLang)}</span>` : "";
        html += `<pre>${langTag}<code>${body}</code></pre>`;
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      continue;
    }

    // GFM Table detection
    if (trimmed.includes("|") && idx + 1 < lines.length && isTableSep(lines[idx + 1])) {
      flushList();
      const headers = splitTableRow(line);
      idx += 2;
      let tbl = "<table><thead><tr>";
      for (const h of headers) tbl += `<th>${inlineFmt(h)}</th>`;
      tbl += "</tr></thead><tbody>";
      while (idx < lines.length && lines[idx].trim().includes("|") && lines[idx].trim() !== "") {
        const cells = splitTableRow(lines[idx]);
        tbl += "<tr>";
        for (let c = 0; c < headers.length; c++) {
          tbl += `<td>${inlineFmt(cells[c] || "")}</td>`;
        }
        tbl += "</tr>";
        idx++;
      }
      idx--;
      tbl += "</tbody></table>";
      html += tbl;
      continue;
    }

    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      flushList();
      html += "<hr/>";
      continue;
    }
    const hMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (hMatch) {
      flushList();
      const lvl = hMatch[1].length;
      html += `<h${lvl}>${inlineFmt(hMatch[2])}</h${lvl}>`;
      continue;
    }
    if (trimmed.startsWith("> ")) {
      flushList();
      html += `<blockquote>${inlineFmt(trimmed.slice(2))}</blockquote>`;
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      if (listTag !== "ul") {
        flushList();
        html += "<ul>";
        listTag = "ul";
      }
      html += `<li>${inlineFmt(trimmed.replace(/^[-*]\s+/, ""))}</li>`;
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      if (listTag !== "ol") {
        flushList();
        html += "<ol>";
        listTag = "ol";
      }
      html += `<li>${inlineFmt(trimmed.replace(/^\d+\.\s+/, ""))}</li>`;
      continue;
    }
    flushList();
    html += `<p>${inlineFmt(line)}</p>`;
  }
  flushList();
  if (inCode) {
    html += `<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`;
  }
  return html;
}

export { renderMarkdown };
