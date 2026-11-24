/**
 * GitHub-Flavored Markdown renderer (tables, syntax-highlighted code blocks,
 * task lists, GFM heading anchors, full link syntax, and workspace media previews).
 */

import { escapeHtml, highlightMinilang, highlightRust } from "./highlight.js";
import { activeTab } from "./state.js";
import { rawFileUrl, resolveWorkspaceRelPath, renderMediaThumbnailCard } from "../features/media.js";

/** Compute a GitHub-Flavored Markdown heading slug. */
function slugifyHeading(text) {
  return String(text || "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

/** Parse optional link destination + title from inside `(...)`, handling `<url>` and `"title"`. */
function splitHrefAndTitle(raw) {
  let s = raw.trim();
  let href = "";
  let title = "";
  if (s.startsWith("<")) {
    const close = s.indexOf(">");
    if (close > 0) {
      href = s.slice(1, close).trim();
      s = s.slice(close + 1).trim();
    } else {
      href = s;
      s = "";
    }
  } else {
    const ws = s.search(/\s/);
    if (ws >= 0) {
      href = s.slice(0, ws);
      s = s.slice(ws).trim();
    } else {
      href = s;
      s = "";
    }
  }
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === "(" && last === ")")) {
      title = s.slice(1, -1);
    }
  }
  return { href, title };
}

/** Find matching closing bracket `]` for `[` at `start`, respecting inline code spans and nesting. */
function findMatchingBracket(str, start) {
  let depth = 0;
  let inCode = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (ch === "\\" && !inCode) {
      i++;
      continue;
    }
    if (ch === "`") {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Find matching closing paren `)` for `(` at `start`, supporting balanced parens inside URLs. */
function findMatchingParen(str, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Render a single resolved Markdown link or image to HTML. */
function renderLinkHtml(isImage, rawLabel, href, title, formatLabel) {
  const cleanHref = (href || "").trim();
  if (!cleanHref) {
    return formatLabel(rawLabel);
  }
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";

  if (isImage) {
    const isExt = /^https?:\/\/|^data:/i.test(cleanHref);
    const rel = isExt ? null : resolveWorkspaceRelPath(cleanHref, activeTab()?.path || "");
    const srcUrl = isExt ? cleanHref : rawFileUrl(rel);
    const label = rawLabel || (rel ? rel.split("/").pop() : cleanHref.split("/").pop()) || "Image";
    return renderMediaThumbnailCard({ kind: "image", src: srcUrl, path: rel, name: label, mime: "image/*" });
  }

  // Block dangerous script URI schemes
  if (/^\s*(?:javascript|vbscript|data):/i.test(cleanHref)) {
    return formatLabel(rawLabel);
  }

  // Same-document anchor link (#section-id)
  if (cleanHref.startsWith("#")) {
    const anchor = cleanHref.slice(1);
    return `<a href="#${escapeHtml(anchor)}" class="md-anchor-link" data-md-anchor="${escapeHtml(anchor)}"${titleAttr}>${formatLabel(rawLabel)}</a>`;
  }

  // PDF thumbnail card for workspace/external PDF links
  if (/\.pdf(?:[?#].*)?$/i.test(cleanHref)) {
    const isExt = /^https?:\/\//i.test(cleanHref);
    const rel = isExt ? null : resolveWorkspaceRelPath(cleanHref.split(/[?#]/)[0], activeTab()?.path || "");
    const srcUrl = isExt ? cleanHref : rawFileUrl(rel);
    return renderMediaThumbnailCard({
      kind: "pdf",
      src: srcUrl,
      path: rel,
      name: rawLabel || (rel ? rel.split("/").pop() : "Document.pdf"),
      mime: "application/pdf",
    });
  }

  // External HTTP(S) / mailto / tel links
  if (/^(?:https?:\/\/|mailto:|tel:)/i.test(cleanHref)) {
    return `<a href="${escapeHtml(cleanHref)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${formatLabel(rawLabel)}</a>`;
  }

  // Root-relative server URLs (e.g. /ui/..., /api/...)
  if (cleanHref.startsWith("/")) {
    return `<a href="${escapeHtml(cleanHref)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${formatLabel(rawLabel)}</a>`;
  }

  // Workspace relative link (supports optional #anchor, e.g. GUIDE.md#debugger)
  const hashIdx = cleanHref.indexOf("#");
  const pathPart = hashIdx >= 0 ? cleanHref.slice(0, hashIdx) : cleanHref;
  const anchorPart = hashIdx >= 0 ? cleanHref.slice(hashIdx + 1) : "";
  const rel = resolveWorkspaceRelPath(pathPart, activeTab()?.path || "");
  const anchorAttr = anchorPart ? ` data-ws-anchor="${escapeHtml(anchorPart)}"` : "";
  return `<a href="#" class="md-ws-link" data-ws-path="${escapeHtml(rel)}"${anchorAttr}${titleAttr}>${formatLabel(rawLabel)}</a>`;
}

// --- Markdown Renderer (GFM Tables, Code Highlighting, Lists, Links, Media Previews) ---
function renderMarkdown(md) {
  if (!md || !md.trim()) {
    return `<div class="md-placeholder">Double-click to edit Markdown...</div>`;
  }
  const rawLines = md.replace(/\r\n/g, "\n").split("\n");

  // First pass: collect reference-style link definitions `[id]: url "title"` (outside fenced code blocks)
  const refDefs = new Map();
  const lines = [];
  let scanCode = false;
  for (const line of rawLines) {
    if (line.trim().startsWith("```")) {
      scanCode = !scanCode;
      lines.push(line);
      continue;
    }
    if (!scanCode) {
      const refMatch = /^\s*\[([^\]]+)\]:\s*(\S+)(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*$/.exec(line);
      if (refMatch) {
        const key = refMatch[1].trim().toLowerCase();
        const href = refMatch[2].replace(/^<|>$/g, "");
        const title = refMatch[3] || refMatch[4] || refMatch[5] || "";
        refDefs.set(key, { href, title });
        continue;
      }
    }
    lines.push(line);
  }

  let html = "";
  let inCode = false;
  let codeLang = "";
  let codeBuf = [];
  let listTag = null; // "ul" | "ol"
  const slugCounts = new Map();

  const nextHeadingId = (rawHeading) => {
    const base = slugifyHeading(rawHeading) || "section";
    const count = slugCounts.get(base) || 0;
    slugCounts.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };

  const flushList = () => {
    if (listTag) {
      html += `</${listTag}>`;
      listTag = null;
    }
  };

  const inlineFmt = (text) => {
    // Store protected HTML tokens (inline code, links, images) so emphasis/autolink regexes never corrupt them
    const tokens = [];
    const stash = (fragment) => {
      const idx = tokens.length;
      tokens.push(fragment);
      return `\u0000MDTOK${idx}\u0000`;
    };

    // 1. Extract inline code spans first so `[a](b)` or `*x*` inside backticks stays literal
    let s = String(text || "").replace(/`([^`]+)`/g, (_, code) => stash(`<code>${escapeHtml(code)}</code>`));

    // 2. Extract angle-bracket autolinks: <https://...> or <mailto:...>
    s = s.replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/gi, (_, url) => {
      const display = url.replace(/^mailto:/i, "");
      return stash(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(display)}</a>`);
    });

    // 3. Parse Markdown images `![alt](...)` and links `[label](...)` / `[label][ref]`
    //    with balanced parentheses support and recursive inline formatting on labels
    let parsed = "";
    let i = 0;
    while (i < s.length) {
      const isImg = s[i] === "!" && s[i + 1] === "[";
      if (isImg || s[i] === "[") {
        const bracketStart = isImg ? i + 1 : i;
        const bracketEnd = findMatchingBracket(s, bracketStart);
        if (bracketEnd > bracketStart) {
          const rawLabel = s.slice(bracketStart + 1, bracketEnd);
          // Inline link: [label](destination "title")
          if (s[bracketEnd + 1] === "(") {
            const parenEnd = findMatchingParen(s, bracketEnd + 1);
            if (parenEnd > bracketEnd + 1) {
              const { href, title } = splitHrefAndTitle(s.slice(bracketEnd + 2, parenEnd));
              const rendered = renderLinkHtml(isImg, rawLabel, href, title, (lbl) => formatPlainInline(lbl, tokens));
              parsed += stash(rendered);
              i = parenEnd + 1;
              continue;
            }
          }
          // Reference link: [label][ref] or shortcut [label][]
          if (s[bracketEnd + 1] === "[") {
            const refEnd = findMatchingBracket(s, bracketEnd + 1);
            if (refEnd > bracketEnd + 1) {
              const refKey = (s.slice(bracketEnd + 2, refEnd).trim() || rawLabel.trim()).toLowerCase();
              const def = refDefs.get(refKey);
              if (def) {
                const rendered = renderLinkHtml(isImg, rawLabel, def.href, def.title, (lbl) => formatPlainInline(lbl, tokens));
                parsed += stash(rendered);
                i = refEnd + 1;
                continue;
              }
            }
          }
          // Shortcut reference link: [ref]
          if (!isImg) {
            const def = refDefs.get(rawLabel.trim().toLowerCase());
            if (def) {
              const rendered = renderLinkHtml(false, rawLabel, def.href, def.title, (lbl) => formatPlainInline(lbl, tokens));
              parsed += stash(rendered);
              i = bracketEnd + 1;
              continue;
            }
          }
        }
      }
      parsed += s[i];
      i++;
    }

    // 4. Bare URL autolinks (outside stashed tokens/code/links)
    parsed = parsed.replace(/(^|[\s(>])(https?:\/\/[^\s<>\u0000]+)/gi, (_, lead, rawUrl) => {
      let url = rawUrl;
      let trail = "";
      while (/[.,;:!?]$/.test(url) || (url.endsWith(")") && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length)) {
        trail = url.slice(-1) + trail;
        url = url.slice(0, -1);
      }
      return `${lead}${stash(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`)}${trail}`;
    });

    return formatPlainInline(parsed, tokens);
  };

  const formatPlainInline = (str, tokens) => {
    let out = escapeHtml(str);
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    // Restore stashed HTML tokens (iterate in case a link label contained a code token)
    for (let pass = 0; pass < 3 && out.includes("\u0000MDTOK"); pass++) {
      out = out.replace(/\u0000MDTOK(\d+)\u0000/g, (_, idx) => tokens[Number(idx)] ?? "");
    }
    return out;
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
      const headingText = hMatch[2];
      const hid = nextHeadingId(headingText);
      html += `<h${lvl} id="${escapeHtml(hid)}">${inlineFmt(headingText)}</h${lvl}>`;
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

export { renderMarkdown, slugifyHeading };
