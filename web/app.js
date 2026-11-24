/* Minilang Notebook Frontend */
(() => {
  "use strict";

  // --- Minilang Syntax Highlighter (based on minilang/spec/minilang.lang) ---
  const ML_KEYWORDS = new Set([
    "and", "case", "class", "debug", "def", "do", "each", "else", "elseif", "end",
    "exit", "for", "fun", "if", "imp", "in", "is", "it", "let", "loop", "meth",
    "must", "next", "nil", "not", "old", "on", "or", "recur", "ref", "ret", "seq",
    "susp", "switch", "then", "to", "true", "false", "until", "var", "when", "while",
    "with", "xor"
  ]);

  const ML_BUILTINS = new Set([
    "Args", "Params", "all", "assign", "backtrace", "batch", "break", "buffered",
    "call", "callcc", "calldc", "cas", "clock", "console", "copy", "count",
    "count2", "debugger", "deref", "diffused", "display", "distill", "dup",
    "exchange", "exec", "export", "finalize", "findall", "first", "first2",
    "fold", "global", "globals", "grid", "halt", "html", "http", "image", "import", "isconstant",
    "iterate", "key", "last", "last2", "locale", "markcc", "markdown", "max",
    "max2", "min", "min2", "now", "null", "pair", "parallel", "pdf", "preview", "print", "println",
    "prod", "raise", "range", "reduce", "reduce2", "replace", "sleep", "some",
    "store", "sum", "svg", "swap", "swapcc", "top", "top2", "trace", "ui", "unfold",
    "unique", "unique1", "unpack", "visit", "watched", "weave", "zip", "zip2"
  ]);

  const ML_TYPES = new Set([
    "address", "any", "array", "base16", "base64", "boolean", "buffer", "cbor",
    "chained", "channel", "compiler", "complex", "condition", "context", "decimal",
    "dir", "double", "enum", "error", "external", "file", "flags", "function",
    "integer", "json", "list", "log", "logger", "macro", "map", "matrix", "method",
    "minijs", "mmap", "module", "number", "object", "parser", "permutation",
    "polynomial", "popen", "pqueue", "property", "random", "real", "regex",
    "rwlock", "semaphore", "sequence", "set", "slice", "socket", "stream", "string",
    "table", "task", "time", "tuple", "type", "uninitialized", "uuid", "variable",
    "vector", "weakref", "xml"
  ]);

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function highlightMinilang(code) {
    let out = "";
    let i = 0;
    const n = code.length;

    while (i < n) {
      const ch = code[i];
      const next = i + 1 < n ? code[i + 1] : "";

      // Line comment :> ...
      if (ch === ":" && next === ">") {
        let j = i + 2;
        while (j < n && code[j] !== "\n") j++;
        out += `<span class="tok-comment">${escapeHtml(code.slice(i, j))}</span>`;
        i = j;
        continue;
      }

      // Block comment :< ... >: (supports nesting)
      if (ch === ":" && next === "<") {
        let depth = 1;
        let j = i + 2;
        while (j < n && depth > 0) {
          if (code[j] === ":" && code[j + 1] === "<") {
            depth++;
            j += 2;
          } else if (code[j] === ">" && code[j + 1] === ":") {
            depth--;
            j += 2;
          } else {
            j++;
          }
        }
        out += `<span class="tok-comment">${escapeHtml(code.slice(i, j))}</span>`;
        i = j;
        continue;
      }

      // Double-quoted string
      if (ch === '"') {
        let j = i + 1;
        while (j < n && code[j] !== '"' && code[j] !== "\n") {
          if (code[j] === "\\" && j + 1 < n) j += 2;
          else j++;
        }
        if (j < n && code[j] === '"') j++;
        out += `<span class="tok-string">${escapeHtml(code.slice(i, j))}</span>`;
        i = j;
        continue;
      }

      // Single-quoted interpolated string '...'
      if (ch === "'") {
        let j = i + 1;
        let seg = "'";
        while (j < n && code[j] !== "'") {
          if (code[j] === "\\" && j + 1 < n) {
            seg += code[j] + code[j + 1];
            j += 2;
          } else if (code[j] === "{") {
            out += `<span class="tok-string">${escapeHtml(seg)}</span>`;
            seg = "";
            let depth = 1;
            let k = j + 1;
            while (k < n && depth > 0) {
              if (code[k] === "{") depth++;
              else if (code[k] === "}") depth--;
              k++;
            }
            const inner = code.slice(j + 1, depth === 0 ? k - 1 : k);
            out += `<span class="tok-op">{</span>${highlightMinilang(inner)}${depth === 0 ? '<span class="tok-op">}</span>' : ""}`;
            j = k;
          } else {
            seg += code[j];
            j++;
          }
        }
        if (j < n && code[j] === "'") {
          seg += "'";
          j++;
        }
        if (seg) out += `<span class="tok-string">${escapeHtml(seg)}</span>`;
        i = j;
        continue;
      }

      // Assignment :=
      if (ch === ":" && next === "=") {
        out += `<span class="tok-op">:=</span>`;
        i += 2;
        continue;
      }

      // Namespace ::ident
      if (ch === ":" && next === ":") {
        let j = i + 2;
        while (j < n && /[A-Za-z0-9_]/.test(code[j])) j++;
        out += `<span class="tok-op">::</span><span class="tok-func">${escapeHtml(code.slice(i + 2, j))}</span>`;
        i = j;
        continue;
      }

      // Symbol :ident
      if (ch === ":" && /[A-Za-z_]/.test(next)) {
        let j = i + 2;
        while (j < n && /[A-Za-z0-9_]/.test(code[j])) j++;
        out += `<span class="tok-symbol">${escapeHtml(code.slice(i, j))}</span>`;
        i = j;
        continue;
      }

      // Numbers
      if (/[0-9]/.test(ch)) {
        let j = i;
        while (j < n && /[0-9]/.test(code[j])) j++;
        if (j < n && code[j] === "." && j + 1 < n && /[0-9]/.test(code[j + 1])) {
          j++;
          while (j < n && /[0-9]/.test(code[j])) j++;
        }
        if (j < n && (code[j] === "e" || code[j] === "E")) {
          j++;
          if (j < n && (code[j] === "+" || code[j] === "-")) j++;
          while (j < n && /[0-9]/.test(code[j])) j++;
        }
        if (j < n && code[j] === "i") j++;
        out += `<span class="tok-number">${escapeHtml(code.slice(i, j))}</span>`;
        i = j;
        continue;
      }

      // Identifiers & Keywords
      if (/[A-Za-z_]/.test(ch)) {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_]/.test(code[j])) j++;
        const word = code.slice(i, j);
        if (ML_KEYWORDS.has(word)) {
          out += `<span class="tok-keyword">${escapeHtml(word)}</span>`;
        } else if (ML_BUILTINS.has(word)) {
          out += `<span class="tok-func">${escapeHtml(word)}</span>`;
        } else if (ML_TYPES.has(word)) {
          out += `<span class="tok-type">${escapeHtml(word)}</span>`;
        } else {
          out += escapeHtml(word);
        }
        i = j;
        continue;
      }

      // Operators
      if (/[+\-*/%=!<>|&^~.?@#$\\()[\]{};,]/.test(ch)) {
        out += `<span class="tok-op">${escapeHtml(ch)}</span>`;
        i++;
        continue;
      }

      out += escapeHtml(ch);
      i++;
    }

    // Trailing newline keeps <pre> height synchronized with <textarea>
    if (code.endsWith("\n") || code.length === 0) {
      out += "\n";
    }
    return out;
  }

  const RUST_KEYWORDS = new Set([
    "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else",
    "enum", "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop",
    "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self",
    "static", "struct", "super", "trait", "true", "type", "unsafe", "use",
    "where", "while"
  ]);

  const RUST_TYPES = new Set([
    "bool", "char", "str", "i8", "i16", "i32", "i64", "i128", "isize",
    "u8", "u16", "u32", "u64", "u128", "usize", "f32", "f64",
    "String", "Vec", "Option", "Result", "Box", "Rc", "Arc", "Cell", "RefCell",
    "HashMap", "HashSet", "BTreeMap", "BTreeSet", "Value", "Params", "Some",
    "None", "Ok", "Err"
  ]);

  function highlightRust(code) {
    let out = "";
    let i = 0;
    const n = code.length;

    while (i < n) {
      const ch = code[i];
      const next = i + 1 < n ? code[i + 1] : "";

      // Line comment // ...
      if (ch === "/" && next === "/") {
        let j = i + 2;
        while (j < n && code[j] !== "\n") j++;
        out += `<span class="tok-comment">${escapeHtml(code.slice(i, j))}</span>`;
        i = j;
        continue;
      }

      // Block comment /* ... */
      if (ch === "/" && next === "*") {
        let depth = 1;
        let j = i + 2;
        while (j < n && depth > 0) {
          if (code[j] === "/" && code[j + 1] === "*") { depth++; j += 2; }
          else if (code[j] === "*" && code[j + 1] === "/") { depth--; j += 2; }
          else j++;
        }
        out += `<span class="tok-comment">${escapeHtml(code.slice(i, j))}</span>`;
        i = j;
        continue;
      }

      // Attribute #[...] or #![...]
      if (ch === "#" && (next === "[" || (next === "!" && code[i + 2] === "["))) {
        let j = i + (next === "!" ? 3 : 2);
        let depth = 1;
        while (j < n && depth > 0) {
          if (code[j] === "[") depth++;
          else if (code[j] === "]") depth--;
          j++;
        }
        out += `<span class="tok-symbol">${escapeHtml(code.slice(i, j))}</span>`;
        i = j;
        continue;
      }

      // Raw string r#"..."# or r"..."
      if (ch === "r" && (next === '"' || next === "#") && (i === 0 || !/[A-Za-z0-9_]/.test(code[i - 1]))) {
        let j = i + 1;
        let hashes = 0;
        while (j < n && code[j] === "#") { hashes++; j++; }
        if (j < n && code[j] === '"') {
          j++;
          while (j < n) {
            if (code[j] === '"') {
              let h = 0;
              while (h < hashes && code[j + 1 + h] === "#") h++;
              if (h === hashes) { j += 1 + hashes; break; }
            }
            j++;
          }
          out += `<span class="tok-string">${escapeHtml(code.slice(i, j))}</span>`;
          i = j;
          continue;
        }
      }

      // Double-quoted string
      if (ch === '"') {
        let j = i + 1;
        while (j < n && code[j] !== '"') {
          if (code[j] === "\\" && j + 1 < n) j += 2;
          else j++;
        }
        if (j < n && code[j] === '"') j++;
        out += `<span class="tok-string">${escapeHtml(code.slice(i, j))}</span>`;
        i = j;
        continue;
      }

      // Char literal or lifetime 'a
      if (ch === "'") {
        if (i + 2 < n && code[i + 1] === "\\") {
          let j = i + 2;
          while (j < n && code[j] !== "'" && code[j] !== "\n") j++;
          if (j < n && code[j] === "'") j++;
          out += `<span class="tok-string">${escapeHtml(code.slice(i, j))}</span>`;
          i = j;
          continue;
        } else if (i + 2 < n && code[i + 2] === "'") {
          out += `<span class="tok-string">${escapeHtml(code.slice(i, i + 3))}</span>`;
          i += 3;
          continue;
        } else if (/[A-Za-z_]/.test(next)) {
          let j = i + 2;
          while (j < n && /[A-Za-z0-9_]/.test(code[j])) j++;
          out += `<span class="tok-symbol">${escapeHtml(code.slice(i, j))}</span>`;
          i = j;
          continue;
        }
      }

      // Numbers
      if (/[0-9]/.test(ch)) {
        let j = i;
        if (ch === "0" && (next === "x" || next === "X" || next === "b" || next === "o")) {
          j += 2;
          while (j < n && /[0-9a-fA-F_]/.test(code[j])) j++;
        } else {
          while (j < n && /[0-9_]/.test(code[j])) j++;
          if (j < n && code[j] === "." && j + 1 < n && /[0-9]/.test(code[j + 1])) {
            j++;
            while (j < n && /[0-9_]/.test(code[j])) j++;
          }
          if (j < n && (code[j] === "e" || code[j] === "E")) {
            j++;
            if (j < n && (code[j] === "+" || code[j] === "-")) j++;
            while (j < n && /[0-9_]/.test(code[j])) j++;
          }
        }
        while (j < n && /[A-Za-z0-9_]/.test(code[j])) j++;
        out += `<span class="tok-number">${escapeHtml(code.slice(i, j))}</span>`;
        i = j;
        continue;
      }

      // Identifiers, keywords, types, macros
      if (/[A-Za-z_]/.test(ch)) {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_]/.test(code[j])) j++;
        const word = code.slice(i, j);
        if (j < n && code[j] === "!") {
          out += `<span class="tok-func">${escapeHtml(word + "!")}</span>`;
          i = j + 1;
          continue;
        }
        if (RUST_KEYWORDS.has(word)) {
          out += `<span class="tok-keyword">${escapeHtml(word)}</span>`;
        } else if (RUST_TYPES.has(word)) {
          out += `<span class="tok-type">${escapeHtml(word)}</span>`;
        } else if (word === "html" || word === "svg" || word === "markdown" || word === "display") {
          out += `<span class="tok-func">${escapeHtml(word)}</span>`;
        } else {
          out += escapeHtml(word);
        }
        i = j;
        continue;
      }

      if (/[+\-*/%=!<>|&^~.:;?()[\]{};,]/.test(ch)) {
        out += `<span class="tok-op">${escapeHtml(ch)}</span>`;
        i++;
        continue;
      }

      out += escapeHtml(ch);
      i++;
    }

    if (code.endsWith("\n") || code.length === 0) out += "\n";
    return out;
  }

  function highlightCode(code, language = "minilang") {
    if (language === "rust") return highlightRust(code);
    return highlightMinilang(code);
  }

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

  // --- Auth & Refreshable Token Client ---
  const AUTH_KEYS = {
    access: "mlnb_access_token",
    refresh: "mlnb_refresh_token",
    exp: "mlnb_access_exp",
  };

  const authState = {
    required: false,
    requiredGroup: null,
    user: null,
    refreshInFlight: null,
    loginWaiters: [],
    refreshTimer: null,
  };

  function getStoredAccessToken() {
    try { return localStorage.getItem(AUTH_KEYS.access) || null; } catch { return null; }
  }
  function getStoredRefreshToken() {
    try { return localStorage.getItem(AUTH_KEYS.refresh) || null; } catch { return null; }
  }
  function getStoredAccessExp() {
    try { return parseInt(localStorage.getItem(AUTH_KEYS.exp) || "0", 10) || 0; } catch { return 0; }
  }
  function saveAuthTokens(data) {
    try {
      if (data.access_token) localStorage.setItem(AUTH_KEYS.access, data.access_token);
      if (data.refresh_token) localStorage.setItem(AUTH_KEYS.refresh, data.refresh_token);
      if (data.expires_at) localStorage.setItem(AUTH_KEYS.exp, String(data.expires_at));
    } catch { /* ignore storage errors */ }
    if (data.user) authState.user = data.user;
    updateAuthUI();
  }
  function clearAuthTokens() {
    try {
      localStorage.removeItem(AUTH_KEYS.access);
      localStorage.removeItem(AUTH_KEYS.refresh);
      localStorage.removeItem(AUTH_KEYS.exp);
    } catch { /* ignore */ }
    authState.user = null;
    updateAuthUI();
  }

  function updateAuthUI() {
    const menu = document.getElementById("auth-user-menu");
    const uname = document.getElementById("auth-username");
    const badge = document.getElementById("auth-user-badge");
    if (!menu) return;
    if (authState.required && authState.user) {
      menu.classList.remove("hidden");
      if (uname) uname.textContent = authState.user.username;
      if (badge) {
        const expDate = authState.user.exp ? new Date(authState.user.exp * 1000).toLocaleTimeString() : "";
        const groups = Array.isArray(authState.user.groups) ? authState.user.groups.join(", ") : "";
        badge.title = `User: ${authState.user.username}${groups ? ` | Groups: ${groups}` : ""}${expDate ? ` | Access token expires: ${expDate}` : ""}`;
      }
    } else {
      menu.classList.add("hidden");
    }
  }

  function showLoginOverlay(errorMsg = "") {
    const overlay = document.getElementById("login-overlay");
    const grpBanner = document.getElementById("login-group-banner");
    const errEl = document.getElementById("login-error");
    if (!overlay) return;
    if (authState.requiredGroup && grpBanner) {
      grpBanner.innerHTML = `Access restricted to local Unix group <code>${escapeHtml(authState.requiredGroup)}</code>`;
      grpBanner.classList.remove("hidden");
    } else if (grpBanner) {
      grpBanner.classList.add("hidden");
    }
    if (errEl) {
      if (errorMsg) {
        errEl.textContent = errorMsg;
        errEl.classList.remove("hidden");
      } else {
        errEl.classList.add("hidden");
      }
    }
    overlay.classList.remove("hidden");
    setTimeout(() => {
      const u = document.getElementById("login-username");
      if (u && !u.value) u.focus();
      else document.getElementById("login-password")?.focus();
    }, 30);
  }

  function hideLoginOverlay() {
    document.getElementById("login-overlay")?.classList.add("hidden");
    const pw = document.getElementById("login-password");
    if (pw) pw.value = "";
    const waiters = authState.loginWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  function waitForLogin() {
    showLoginOverlay();
    return new Promise((resolve) => authState.loginWaiters.push(resolve));
  }

  async function refreshAuthTokens() {
    if (authState.refreshInFlight) return authState.refreshInFlight;
    authState.refreshInFlight = (async () => {
      try {
        const rt = getStoredRefreshToken();
        const res = await fetch("/api/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(rt ? { refresh_token: rt } : {}),
        });
        if (!res.ok) {
          clearAuthTokens();
          return false;
        }
        const data = await res.json();
        saveAuthTokens(data);
        return true;
      } catch {
        return false;
      } finally {
        authState.refreshInFlight = null;
      }
    })();
    return authState.refreshInFlight;
  }

  async function getFreshAccessToken() {
    const tok = getStoredAccessToken();
    if (!authState.required) return tok;
    const exp = getStoredAccessExp();
    const now = Math.floor(Date.now() / 1000);
    if (!tok || (exp > 0 && exp - now <= 60)) {
      const ok = await refreshAuthTokens();
      if (ok) return getStoredAccessToken();
    }
    return getStoredAccessToken();
  }

  window.MlnbAuth = {
    getAccessToken: getFreshAccessToken,
    refresh: refreshAuthTokens,
    isRequired: () => authState.required,
  };

  async function authFetch(url, opts = {}, retryOn401 = true) {
    const headers = { ...(opts.headers || {}) };
    if (authState.required) {
      const tok = await getFreshAccessToken();
      if (tok) headers["Authorization"] = `Bearer ${tok}`;
    }
    const res = await fetch(url, { ...opts, headers });
    if (res.status === 401 && authState.required && retryOn401) {
      const refreshed = await refreshAuthTokens();
      if (refreshed) {
        return authFetch(url, opts, false);
      }
      showLoginOverlay("Your session has expired. Please sign in again.");
    }
    return res;
  }

  // --- API Helpers ---
  async function api(url, opts = {}) {
    const res = await authFetch(url, {
      ...opts,
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

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

  document.getElementById("modal-close").onclick = () => closeModal(null);
  document.getElementById("modal-cancel").onclick = () => closeModal(null);
  document.getElementById("modal-confirm").onclick = () => {
    const inp = document.getElementById("modal-text-input");
    closeModal(inp ? inp.value : true);
  };
  document.getElementById("modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "modal-backdrop") closeModal(null);
  });

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

  function uid() {
    return (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
  }

  function activeTab() {
    return state.tabs.find((t) => t.id === state.activeTabId) || null;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} K`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} M`;
  }

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

  // --- File Explorer Actions & Context Menu ---
  function parentDirOf(relPath) {
    if (!relPath || !relPath.includes("/")) return "";
    return relPath.slice(0, relPath.lastIndexOf("/"));
  }

  function buildAbsolutePath(relPath) {
    const base = (state.rootPath || "").replace(/\/+$/, "");
    if (!base) return relPath || "/";
    return relPath ? `${base}/${relPath}` : base;
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

  // --- Tabs & Opening Files ---
  async function ensureKernel(sessionId, cwdPath = "", language = "minilang") {
    const body = { session_id: sessionId, language };
    if (cwdPath) body.cwd = cwdPath;
    const status = await api("/api/kernels", { method: "POST", body: JSON.stringify(body) });
    refreshKernelList();
    return status;
  }

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
    const nbView = document.getElementById("notebook-view");
    const fileView = document.getElementById("file-view");
    const mediaView = document.getElementById("media-view");
    const mdView = document.getElementById("markdown-view");
    const logView = document.getElementById("log-view");

    if (!tab) return;
    syncLogLiveTimer(tab);

    nbToolbar.classList.toggle("hidden", tab.kind !== "notebook");
    fileToolbar.classList.toggle("hidden", tab.kind !== "file");
    mediaToolbar.classList.toggle("hidden", tab.kind !== "media");
    mdToolbar.classList.toggle("hidden", tab.kind !== "markdown");
    logToolbar.classList.toggle("hidden", tab.kind !== "log");

    nbView.classList.toggle("hidden", tab.kind !== "notebook");
    fileView.classList.toggle("hidden", tab.kind !== "file");
    mediaView.classList.toggle("hidden", tab.kind !== "media");
    mdView.classList.toggle("hidden", tab.kind !== "markdown");
    logView.classList.toggle("hidden", tab.kind !== "log");

    if (tab.kind === "notebook") {
      const langSel = document.getElementById("tb-lang-select");
      if (langSel) langSel.value = tab.doc.language || "minilang";
      const linfo = langInfo(tab.doc.language || "minilang");
      const ext = (linfo.extensions && linfo.extensions[0]) || "mini";
      document.getElementById("tb-export-mini").querySelector("span").textContent = `Export .${ext}`;
      renderCells();
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
    const lineCount = Math.max(1, code.split("\n").length);
    let nums = "";
    for (let i = 1; i <= lineCount; i++) nums += i + "\n";
    gutter.textContent = nums;
  }

  function syncFileEditorScroll() {
    const ta = document.getElementById("file-editor-textarea");
    const hl = document.getElementById("file-editor-highlight");
    const gutter = document.getElementById("file-editor-gutter");
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
    gutter.scrollTop = ta.scrollTop;
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

    // 2. rich displays
    if (Array.isArray(output.displays)) {
      output.displays.forEach((d, idx) => {
        let rendered = "";
        if (d.mime === "application/vnd.minilang.ui+json") {
          rendered = `<div class="mlui-mount-slot" data-ui-idx="${idx}"></div>`;
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
    if (!output || !Array.isArray(output.displays) || !window.MinijsUI) return;
    container.querySelectorAll(".mlui-mount-slot").forEach((slot) => {
      const idx = Number(slot.dataset.uiIdx);
      const item = output.displays[idx];
      if (item && item.mime === "application/vnd.minilang.ui+json") {
        window.MinijsUI.mount(slot, item.data);
      }
    });
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

  function markDirty(tab) {
    if (!tab.dirty) {
      tab.dirty = true;
      renderTabs();
    }
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

  document.addEventListener("mousedown", (e) => {
    if (state.ac.visible && !e.target.closest("#autocomplete-popup")) {
      hideAutocomplete();
    }
  });

  // --- Execution & Kernel Controls ---
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
    updateSingleCellDom(tab, cell.id);
    setKernelIndicator("busy", "Running...");

    try {
      const resp = await api(`/api/kernels/${encodeURIComponent(tab.kernelId)}/execute`, {
        method: "POST",
        body: JSON.stringify({ code: cell.source }),
      });

      cell._running = false;
      if (resp.type === "eval_result") {
        cell.execution_count = resp.execution_count;
        cell.output = {
          stdout: resp.stdout || "",
          displays: resp.displays || [],
          results: resp.results || [],
          error: resp.error || null,
          duration_ms: resp.duration_ms,
        };
      } else {
        cell.output = {
          stdout: "",
          displays: [],
          results: [],
          error: { error_type: "KernelError", message: resp.message || "Execution failed", traceback: "" },
        };
      }
      markDirty(tab);
      updateSingleCellDom(tab, cell.id);
      if (advance) focusNextCell(tab, cell.id);
      setKernelIndicator("idle", "Minilang 2.17");
      if (state.varsOpen) refreshVariables();
      refreshKernelList();
    } catch (e) {
      cell._running = false;
      cell.output = {
        stdout: "",
        displays: [],
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

  // --- Wire Up UI Controls ---
  document.getElementById("btn-toggle-sidebar").onclick = () => {
    document.getElementById("sidebar").classList.toggle("hidden");
    document.getElementById("sidebar-resizer").classList.toggle("hidden");
  };

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

  document.getElementById("btn-theme").onclick = () => {
    const html = document.documentElement;
    const next = html.dataset.theme === "dark" ? "light" : "dark";
    html.dataset.theme = next;
    localStorage.setItem("ml_theme", next);
  };
  const savedTheme = localStorage.getItem("ml_theme");
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;

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

  // Text file editor buttons & live syntax highlighting
  const fileEditorTa = document.getElementById("file-editor-textarea");
  fileEditorTa.addEventListener("input", (e) => {
    const tab = activeTab();
    if (tab && tab.kind === "file") {
      tab.content = e.target.value;
      const isUi = tab.extension === "ui";
      const fileLang = langByExtension(tab.extension);
      const highlightLang = isUi ? "minilang" : (fileLang ? fileLang.id : null);
      syncFileEditorHighlight(tab.content, highlightLang);
      syncFileEditorScroll();
      markDirty(tab);
      updateStatusBar();
    }
  });
  fileEditorTa.addEventListener("scroll", syncFileEditorScroll);
  fileEditorTa.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const start = fileEditorTa.selectionStart;
      const end = fileEditorTa.selectionEnd;
      fileEditorTa.value = fileEditorTa.value.slice(0, start) + "    " + fileEditorTa.value.slice(end);
      fileEditorTa.selectionStart = fileEditorTa.selectionEnd = start + 4;
      fileEditorTa.dispatchEvent(new Event("input"));
    }
  });
  document.getElementById("ftb-save").onclick = saveActiveTab;
  document.getElementById("btn-close-file-output").onclick = () => {
    document.getElementById("file-run-output").classList.add("hidden");
  };

  document.getElementById("ftb-run-mini").onclick = async () => {
    const tab = activeTab();
    if (!tab || tab.kind !== "file") return;
    const outPane = document.getElementById("file-run-output");
    const outBody = document.getElementById("file-run-output-body");
    const fileLang = tab.extension === "ui" ? langInfo("minilang") : (langByExtension(tab.extension) || langInfo("minilang"));
    outPane.classList.remove("hidden");
    outBody.innerHTML = `<span style="color:var(--text-muted)">Running ${escapeHtml(tab.title)} (${escapeHtml(fileLang.name)})...</span>`;
    try {
      const kId = `script-${tab.id.slice(0, 8)}`;
      const dir = tab.path && tab.path.includes("/") ? tab.path.slice(0, tab.path.lastIndexOf("/")) : "";
      await ensureKernel(kId, dir, fileLang.id);
      await api(`/api/kernels/${encodeURIComponent(kId)}/restart`, { method: "POST" });
      const resp = await api(`/api/kernels/${encodeURIComponent(kId)}/execute`, {
        method: "POST",
        body: JSON.stringify({ code: tab.content, source: tab.title, language: fileLang.id }),
      });
      tab._lastRunOutput = resp;
      outBody.innerHTML = renderOutputHtml(resp, resp.execution_count) || `<span style="color:var(--text-muted)">(no output)</span>`;
      hydrateUiDisplays(outBody, resp);
      hydrateMediaPreviews(outBody);
      outBody.querySelector(".fix-agy-btn")?.addEventListener("click", () => {
        openFileAgyPanel(tab);
        runFileAgy(tab, "Diagnose and fix the error from the last run.", "fix");
      });
    } catch (e) {
      outBody.innerHTML = `<div class="output-error">${escapeHtml(e.message)}</div>`;
    }
  };

  document.getElementById("ftb-launch-ui").onclick = async () => {
    const tab = activeTab();
    if (!tab || !tab.path) return;
    if (tab.dirty) await saveActiveTab();
    window.open(`/ui/${encodeURI(tab.path)}`, "_blank", "noopener");
  };

  document.getElementById("ftb-open-as-nb").onclick = async () => {
    const tab = activeTab();
    if (!tab || tab.kind !== "file") return;
    const fileLang = langByExtension(tab.extension);
    try {
      const doc = await api("/api/notebook/from-script", {
        method: "POST",
        body: JSON.stringify({
          title: tab.title,
          content: tab.content,
          language: fileLang ? fileLang.id : "minilang",
        }),
      });
      const nbTitle = tab.title.replace(/\.[^.]+$/i, "") + ".mnb";
      await createUntitledNotebook(doc, nbTitle, null, doc.language);
    } catch (e) {
      toast(e.message, "error");
    }
  };

  // Script /invoke panel controls
  function defaultInvokePayloadFor(path) {
    if (path && (path.endsWith("greet.mini") || path.endsWith("hello.rs"))) {
      return JSON.stringify({
        params: {
          name: { type: "string", value: path.endsWith(".rs") ? "Rust" : "Minilang" },
          repeat: { type: "integer", value: 3 },
          excited: { type: "boolean", value: true },
        },
      }, null, 2);
    }
    if (path && path.endsWith("fib.rs")) {
      return JSON.stringify({
        function: "fib",
        args: [{ type: "integer", value: 20 }],
      }, null, 2);
    }
    if (path && path.endsWith("stats.mini")) {
      return JSON.stringify({
        params: {
          label: { type: "string", value: "latency_ms" },
          values: {
            type: "list",
            value: [
              { type: "real", value: 12.5 },
              { type: "real", value: 18.0 },
              { type: "real", value: 9.5 },
            ],
          },
        },
      }, null, 2);
    }
    return JSON.stringify({
      params: {
        name: { type: "string", value: "World" },
        count: { type: "integer", value: 3 },
      },
      args: [],
    }, null, 2);
  }

  document.getElementById("ftb-invoke-mini").onclick = () => {
    const tab = activeTab();
    if (!tab || tab.kind !== "file") return;
    document.getElementById("file-run-output").classList.add("hidden");
    const panel = document.getElementById("file-invoke-panel");
    panel.classList.remove("hidden");
    document.getElementById("invoke-endpoint-label").textContent = `POST /invoke/${tab.path}`;
    const ta = document.getElementById("invoke-params-textarea");
    if (!tab._invokePayload) {
      tab._invokePayload = defaultInvokePayloadFor(tab.path);
    }
    ta.value = tab._invokePayload;
    document.getElementById("invoke-fn-input").value = tab._invokeFn || "";
    document.getElementById("invoke-status-badge").textContent = "";
    document.getElementById("invoke-response-pre").textContent =
      `Ready to invoke POST /invoke/${tab.path}`;
  };

  document.getElementById("btn-close-invoke").onclick = () => {
    document.getElementById("file-invoke-panel").classList.add("hidden");
  };

  document.getElementById("invoke-params-textarea").addEventListener("input", (e) => {
    const tab = activeTab();
    if (tab) tab._invokePayload = e.target.value;
  });

  document.getElementById("invoke-fn-input").addEventListener("input", (e) => {
    const tab = activeTab();
    if (tab) tab._invokeFn = e.target.value;
  });

  function buildInvokeRequestObject() {
    const raw = document.getElementById("invoke-params-textarea").value.trim() || "{}";
    const parsed = JSON.parse(raw);
    const fnName = document.getElementById("invoke-fn-input").value.trim();
    if (fnName) parsed.function = fnName;
    return parsed;
  }

  document.getElementById("btn-copy-curl").onclick = () => {
    const tab = activeTab();
    if (!tab || !tab.path) return;
    try {
      const payload = buildInvokeRequestObject();
      const url = `${window.location.origin}/invoke/${tab.path}`;
      const tok = authState.required ? getStoredAccessToken() : null;
      const authFlag = tok ? ` -H "Authorization: Bearer ${tok}"` : "";
      const cmd = `curl -s -X POST "${url}" -H "Content-Type: application/json"${authFlag} -d '${JSON.stringify(payload)}'`;
      navigator.clipboard?.writeText(cmd).catch(() => {});
      toast("Copied curl command", "success");
    } catch (e) {
      toast(`Invalid JSON payload: ${e.message}`, "error");
    }
  };

  document.getElementById("btn-run-invoke").onclick = async () => {
    const tab = activeTab();
    if (!tab || !tab.path) return;
    if (tab.dirty) {
      await saveActiveTab();
    }
    const respPre = document.getElementById("invoke-response-pre");
    const badge = document.getElementById("invoke-status-badge");
    let body;
    try {
      body = buildInvokeRequestObject();
    } catch (e) {
      badge.textContent = "Invalid JSON";
      respPre.textContent = `JSON parse error: ${e.message}`;
      return;
    }
    badge.textContent = "Invoking...";
    respPre.textContent = "";
    try {
      const res = await authFetch(`/invoke/${encodeURI(tab.path)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      const dur = typeof data.duration_ms === "number" ? ` · ${data.duration_ms.toFixed(1)} ms` : "";
      badge.textContent = `HTTP ${res.status}${dur}`;
      respPre.textContent = JSON.stringify(data, null, 2);
    } catch (e) {
      badge.textContent = "Network error";
      respPre.textContent = e.message;
    }
  };

  // Global keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveActiveTab();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
      e.preventDefault();
      document.getElementById("sidebar").classList.toggle("hidden");
      document.getElementById("sidebar-resizer").classList.toggle("hidden");
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
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

  // --- Google Antigravity (agy) Inline Assistant (Cells & Script Files) ---
  function formatOutputErrorForAgy(output) {
    if (!output || !output.error) return null;
    const e = output.error;
    return `${e.error_type || "Error"}: ${e.message || ""}${e.traceback ? `\n${e.traceback}` : ""}`;
  }

  function toggleCellAgy(tab, cell, forceOpen = false) {
    cell._agyOpen = forceOpen ? true : !cell._agyOpen;
    updateSingleCellDom(tab, cell.id);
    if (cell._agyOpen) {
      setTimeout(() => {
        document.querySelector(`.cell[data-cell-id="${cell.id}"] .cell-agy-input`)?.focus();
      }, 20);
    }
  }

  async function runCellAgy(tab, cell, promptText, action = "ask") {
    const prompt = (promptText || "").trim();
    if (!prompt) return;
    if (cell._agyLoading && cell._agyRequestId) {
      api("/api/agy/cancel", { method: "POST", body: JSON.stringify({ request_id: cell._agyRequestId }) }).catch(() => {});
    }

    const idx = tab.doc.cells.findIndex((c) => c.id === cell.id);
    const surrounding = tab.doc.cells
      .slice(0, Math.max(0, idx))
      .filter((c) => c.cell_type === "code" && c.source.trim())
      .map((c) => c.source);

    const reqId = `agy-${uid().slice(0, 10)}`;
    cell._agyOpen = true;
    cell._agyPrompt = prompt;
    cell._agyLoading = true;
    cell._agyRequestId = reqId;
    cell._agyError = null;
    updateSingleCellDom(tab, cell.id);

    try {
      const data = await api("/api/agy/assist", {
        method: "POST",
        body: JSON.stringify({
          request_id: reqId,
          prompt,
          action,
          kind: "cell",
          language: cell.cell_type === "markdown" ? "markdown" : (tab.doc.language || "minilang"),
          path: tab.path || tab.title,
          code: cell.source || "",
          error: formatOutputErrorForAgy(cell.output),
          stdout: cell.output?.stdout || null,
          surrounding_cells: surrounding,
          conversation_id: cell._agyConvId || null,
        }),
      });
      if (cell._agyRequestId !== reqId) return;
      cell._agyResponse = data.response || "";
      cell._agySuggestedCode = data.suggested_code || null;
      cell._agyConvId = data.conversation_id || cell._agyConvId || null;
      cell._agyDurationMs = data.duration_ms || null;
    } catch (err) {
      if (cell._agyRequestId !== reqId) return;
      cell._agyError = err.message;
    } finally {
      if (cell._agyRequestId === reqId) {
        cell._agyLoading = false;
        cell._agyRequestId = null;
        updateSingleCellDom(tab, cell.id);
      }
    }
  }

  function buildCellAgyPanel(tab, cell) {
    const panel = document.createElement("div");
    panel.className = "cell-agy-panel";
    panel.addEventListener("mousedown", (e) => e.stopPropagation());

    const hasErr = !!(cell.output && cell.output.error);
    const statusText = cell._agyLoading
      ? "Thinking with agy..."
      : (typeof cell._agyDurationMs === "number" ? `${(cell._agyDurationMs / 1000).toFixed(1)}s` : "");

    panel.innerHTML = `
      <div class="agy-header">
        <div class="agy-title-wrap">
          <span class="agy-spark">✦</span>
          <strong>Antigravity (agy)</strong>
          <span class="tb-meta">${escapeHtml(statusText)}</span>
        </div>
        <div class="toolbar-group">
          ${cell._agyConvId ? `<button type="button" class="tb-btn agy-cell-reset" style="height:22px;font-size:11px;padding:0 7px">New Thread</button>` : ""}
          <button type="button" class="icon-btn sm agy-cell-close" title="Close">&times;</button>
        </div>
      </div>
      <div class="agy-chips">
        ${hasErr ? `<button type="button" class="agy-chip emph" data-action="fix" data-prompt="Diagnose and fix this error.">Fix Error</button>` : ""}
        <button type="button" class="agy-chip" data-action="explain" data-prompt="Explain what this cell does.">Explain</button>
        <button type="button" class="agy-chip" data-action="improve" data-prompt="Improve and clean up this cell.">Improve</button>
        <button type="button" class="agy-chip" data-action="generate" data-prompt="Write a clean example for this cell.">Generate</button>
      </div>
      <div class="agy-prompt-row">
        <input class="agy-input cell-agy-input" type="text" placeholder="Ask agy about this cell... (Enter to send, Esc to close)" value="${escapeHtml(cell._agyPrompt || "")}" ${cell._agyLoading ? "disabled" : ""} />
        ${cell._agyLoading
          ? `<button type="button" class="tb-btn danger-hover agy-cell-cancel">Cancel</button>`
          : `<button type="button" class="tb-btn primary agy-cell-send">Ask</button>`}
      </div>
      ${(cell._agyError || cell._agyResponse) ? `
        <div class="agy-response-wrap">
          <div class="agy-response ${cell._agyError ? "is-error" : "md-rendered"}">
            ${cell._agyError ? escapeHtml(cell._agyError) : renderMarkdown(cell._agyResponse)}
          </div>
          ${(!cell._agyError && cell._agySuggestedCode) ? `
            <div class="agy-apply-bar">
              <button type="button" class="tb-btn primary agy-cell-replace">Replace Cell</button>
              <button type="button" class="tb-btn agy-cell-insert">Insert Cell Below</button>
              <button type="button" class="tb-btn agy-cell-copy">Copy Code</button>
            </div>
          ` : ""}
        </div>
      ` : ""}
    `;

    hydrateMediaPreviews(panel);

    const input = panel.querySelector(".cell-agy-input");
    input?.addEventListener("input", (e) => { cell._agyPrompt = e.target.value; });
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        runCellAgy(tab, cell, input.value, "ask");
      } else if (e.key === "Escape") {
        e.preventDefault();
        cell._agyOpen = false;
        updateSingleCellDom(tab, cell.id);
      }
    });

    panel.querySelector(".agy-cell-send")?.addEventListener("click", () => {
      runCellAgy(tab, cell, input?.value || "", "ask");
    });
    panel.querySelector(".agy-cell-cancel")?.addEventListener("click", () => {
      if (cell._agyRequestId) {
        api("/api/agy/cancel", { method: "POST", body: JSON.stringify({ request_id: cell._agyRequestId }) }).catch(() => {});
      }
    });
    panel.querySelector(".agy-cell-close")?.addEventListener("click", () => {
      cell._agyOpen = false;
      updateSingleCellDom(tab, cell.id);
    });
    panel.querySelector(".agy-cell-reset")?.addEventListener("click", () => {
      cell._agyConvId = null;
      cell._agyResponse = "";
      cell._agySuggestedCode = null;
      cell._agyError = null;
      cell._agyDurationMs = null;
      updateSingleCellDom(tab, cell.id);
    });
    panel.querySelectorAll(".agy-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        runCellAgy(tab, cell, chip.dataset.prompt, chip.dataset.action);
      });
    });
    panel.querySelector(".agy-cell-replace")?.addEventListener("click", () => {
      if (cell._agySuggestedCode == null) return;
      cell.source = cell._agySuggestedCode;
      markDirty(tab);
      updateSingleCellDom(tab, cell.id);
      toast("Applied agy code to cell", "success");
    });
    panel.querySelector(".agy-cell-insert")?.addEventListener("click", () => {
      if (cell._agySuggestedCode == null) return;
      const idx = tab.doc.cells.findIndex((c) => c.id === cell.id);
      const newCell = { id: uid(), cell_type: "code", source: cell._agySuggestedCode, execution_count: null, output: null };
      tab.doc.cells.splice(idx + 1, 0, newCell);
      tab.activeCellId = newCell.id;
      markDirty(tab);
      renderCells();
      toast("Inserted new cell with agy code", "success");
    });
    panel.querySelector(".agy-cell-copy")?.addEventListener("click", () => {
      if (cell._agySuggestedCode != null) {
        navigator.clipboard?.writeText(cell._agySuggestedCode).catch(() => {});
        toast("Copied code to clipboard", "success");
      }
    });

    return panel;
  }

  // --- Script File agy Panel ---
  function captureFileSelection(tab) {
    const ta = document.getElementById("file-editor-textarea");
    if (!ta) return;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    if (typeof s === "number" && typeof e === "number" && e > s) {
      tab._agySelStart = s;
      tab._agySelEnd = e;
      tab._agySelText = ta.value.slice(s, e);
    } else {
      tab._agySelStart = null;
      tab._agySelEnd = null;
      tab._agySelText = null;
    }
  }

  function renderFileAgyPanel(tab) {
    const panel = document.getElementById("file-agy-panel");
    const selBadge = document.getElementById("file-agy-selection-badge");
    const statusEl = document.getElementById("file-agy-status");
    const input = document.getElementById("file-agy-input");
    const sendBtn = document.getElementById("btn-file-agy-send");
    const cancelBtn = document.getElementById("btn-file-agy-cancel");
    const respWrap = document.getElementById("file-agy-response-wrap");
    const respEl = document.getElementById("file-agy-response");
    const applyBar = document.getElementById("file-agy-apply-bar");
    const repSelBtn = document.getElementById("btn-file-agy-replace-sel");
    if (!panel || !tab) return;

    panel.classList.toggle("hidden", !tab._agyOpen);
    if (!tab._agyOpen) return;

    if (tab._agySelText) {
      const lineCount = tab._agySelText.split("\n").length;
      selBadge.textContent = `Selection (${lineCount} ${lineCount === 1 ? "line" : "lines"})`;
      selBadge.classList.remove("hidden");
    } else {
      selBadge.classList.add("hidden");
    }

    statusEl.textContent = tab._agyLoading
      ? "Thinking with agy..."
      : (typeof tab._agyDurationMs === "number" ? `${(tab._agyDurationMs / 1000).toFixed(1)}s` : "");

    input.disabled = !!tab._agyLoading;
    sendBtn.classList.toggle("hidden", !!tab._agyLoading);
    cancelBtn.classList.toggle("hidden", !tab._agyLoading);

    if (tab._agyError) {
      respWrap.classList.remove("hidden");
      respEl.className = "agy-response is-error";
      respEl.textContent = tab._agyError;
      applyBar.classList.add("hidden");
    } else if (tab._agyResponse) {
      respWrap.classList.remove("hidden");
      respEl.className = "agy-response md-rendered";
      respEl.innerHTML = renderMarkdown(tab._agyResponse);
      hydrateMediaPreviews(respEl);
      const hasCode = !!tab._agySuggestedCode;
      applyBar.classList.toggle("hidden", !hasCode);
      repSelBtn.classList.toggle("hidden", !(hasCode && tab._agySelText));
    } else {
      respWrap.classList.add("hidden");
    }
  }

  function openFileAgyPanel(tab) {
    if (!tab || tab.kind !== "file") return;
    captureFileSelection(tab);
    tab._agyOpen = true;
    document.getElementById("file-invoke-panel")?.classList.add("hidden");
    renderFileAgyPanel(tab);
    setTimeout(() => document.getElementById("file-agy-input")?.focus(), 20);
  }

  async function runFileAgy(tab, promptText, action = "ask") {
    const prompt = (promptText || "").trim();
    if (!tab || !prompt) return;
    if (tab._agyLoading && tab._agyRequestId) {
      api("/api/agy/cancel", { method: "POST", body: JSON.stringify({ request_id: tab._agyRequestId }) }).catch(() => {});
    }

    const reqId = `agy-${uid().slice(0, 10)}`;
    const fileLang = tab.extension === "ui" ? "ui" : (langByExtension(tab.extension)?.id || tab.extension || "text");
    tab._agyOpen = true;
    tab._agyLoading = true;
    tab._agyRequestId = reqId;
    tab._agyError = null;
    renderFileAgyPanel(tab);

    try {
      const data = await api("/api/agy/assist", {
        method: "POST",
        body: JSON.stringify({
          request_id: reqId,
          prompt,
          action,
          kind: "file",
          language: fileLang,
          path: tab.path || tab.title,
          code: tab.content || "",
          selection: tab._agySelText || null,
          error: formatOutputErrorForAgy(tab._lastRunOutput),
          stdout: tab._lastRunOutput?.stdout || null,
          conversation_id: tab._agyConvId || null,
        }),
      });
      if (tab._agyRequestId !== reqId) return;
      tab._agyResponse = data.response || "";
      tab._agySuggestedCode = data.suggested_code || null;
      tab._agyConvId = data.conversation_id || tab._agyConvId || null;
      tab._agyDurationMs = data.duration_ms || null;
    } catch (err) {
      if (tab._agyRequestId !== reqId) return;
      tab._agyError = err.message;
    } finally {
      if (tab._agyRequestId === reqId) {
        tab._agyLoading = false;
        tab._agyRequestId = null;
        if (activeTab()?.id === tab.id) renderFileAgyPanel(tab);
      }
    }
  }

  function applyFileContentChange(tab, nextContent) {
    tab.content = nextContent;
    markDirty(tab);
    const ta = document.getElementById("file-editor-textarea");
    ta.value = nextContent;
    const isUi = tab.extension === "ui";
    const fileLang = langByExtension(tab.extension);
    syncFileEditorHighlight(nextContent, isUi ? "minilang" : (fileLang ? fileLang.id : null));
    syncFileEditorScroll();
    document.getElementById("ftb-meta").textContent = `${tab.path} (${formatSize(nextContent.length)})`;
  }

  document.getElementById("ftb-agy")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab.kind !== "file") return;
    if (tab._agyOpen) {
      tab._agyOpen = false;
      renderFileAgyPanel(tab);
    } else {
      openFileAgyPanel(tab);
    }
  });

  document.getElementById("btn-file-agy-close")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab) return;
    tab._agyOpen = false;
    renderFileAgyPanel(tab);
  });

  document.getElementById("btn-file-agy-reset")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab) return;
    tab._agyConvId = null;
    tab._agyResponse = "";
    tab._agySuggestedCode = null;
    tab._agyError = null;
    tab._agyDurationMs = null;
    document.getElementById("file-agy-input").value = "";
    renderFileAgyPanel(tab);
  });

  document.getElementById("btn-file-agy-send")?.addEventListener("click", () => {
    const tab = activeTab();
    const input = document.getElementById("file-agy-input");
    if (tab && input) runFileAgy(tab, input.value, "ask");
  });

  document.getElementById("btn-file-agy-cancel")?.addEventListener("click", () => {
    const tab = activeTab();
    if (tab && tab._agyRequestId) {
      api("/api/agy/cancel", { method: "POST", body: JSON.stringify({ request_id: tab._agyRequestId }) }).catch(() => {});
    }
  });

  document.getElementById("file-agy-input")?.addEventListener("keydown", (e) => {
    const tab = activeTab();
    if (!tab) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runFileAgy(tab, e.target.value, "ask");
    } else if (e.key === "Escape") {
      e.preventDefault();
      tab._agyOpen = false;
      renderFileAgyPanel(tab);
    }
  });

  document.querySelectorAll("[data-file-agy-action]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const tab = activeTab();
      if (!tab) return;
      document.getElementById("file-agy-input").value = chip.dataset.fileAgyPrompt;
      runFileAgy(tab, chip.dataset.fileAgyPrompt, chip.dataset.fileAgyAction);
    });
  });

  document.getElementById("btn-file-agy-replace-sel")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab._agySuggestedCode == null || tab._agySelStart == null || tab._agySelEnd == null) return;
    const next = tab.content.slice(0, tab._agySelStart) + tab._agySuggestedCode + tab.content.slice(tab._agySelEnd);
    tab._agySelStart = null;
    tab._agySelEnd = null;
    tab._agySelText = null;
    applyFileContentChange(tab, next);
    renderFileAgyPanel(tab);
    toast("Replaced selection with agy code", "success");
  });

  document.getElementById("btn-file-agy-replace-all")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab._agySuggestedCode == null) return;
    applyFileContentChange(tab, tab._agySuggestedCode);
    toast("Replaced file content with agy code", "success");
  });

  document.getElementById("btn-file-agy-append")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab._agySuggestedCode == null) return;
    const sep = tab.content.endsWith("\n") || !tab.content ? "" : "\n";
    applyFileContentChange(tab, `${tab.content}${sep}\n${tab._agySuggestedCode}\n`);
    toast("Appended agy code to file", "success");
  });

  document.getElementById("btn-file-agy-copy")?.addEventListener("click", () => {
    const tab = activeTab();
    if (tab && tab._agySuggestedCode != null) {
      navigator.clipboard?.writeText(tab._agySuggestedCode).catch(() => {});
      toast("Copied code to clipboard", "success");
    }
  });

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

  // Markdown Viewer event handlers
  document.getElementById("mdtb-save")?.addEventListener("click", () => saveActiveTab());

  document.querySelectorAll(".tb-seg-btn").forEach((btn) => {
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

  // Auth UI event handlers
  document.getElementById("login-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const uInput = document.getElementById("login-username");
    const pInput = document.getElementById("login-password");
    const errEl = document.getElementById("login-error");
    const submitBtn = document.getElementById("login-submit");
    const username = (uInput?.value || "").trim();
    const password = pInput?.value || "";
    if (!username || !password) return;
    if (errEl) errEl.classList.add("hidden");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Signing in...";
    }
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (errEl) {
          errEl.textContent = data.error || `Login failed (HTTP ${res.status})`;
          errEl.classList.remove("hidden");
        }
        if (pInput) { pInput.value = ""; pInput.focus(); }
        return;
      }
      saveAuthTokens(data);
      const nextUrl = new URLSearchParams(window.location.search).get("next");
      if (nextUrl && nextUrl.startsWith("/")) {
        window.location.assign(nextUrl);
        return;
      }
      hideLoginOverlay();
      toast(`Signed in as ${data.user?.username || username}`, "success");
    } catch (err) {
      if (errEl) {
        errEl.textContent = `Network error: ${err.message}`;
        errEl.classList.remove("hidden");
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Sign In";
      }
    }
  });

  document.getElementById("btn-auth-refresh")?.addEventListener("click", async () => {
    const ok = await refreshAuthTokens();
    if (ok) {
      toast("Access & refresh tokens rotated", "success");
    } else {
      toast("Session expired; please sign in again", "error");
      showLoginOverlay("Session expired. Please sign in again.");
    }
  });

  document.getElementById("btn-auth-logout")?.addEventListener("click", async () => {
    const rt = getStoredRefreshToken();
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rt ? { refresh_token: rt } : {}),
      });
    } catch { /* ignore */ }
    clearAuthTokens();
    toast("Signed out", "info");
    if (authState.required) {
      showLoginOverlay();
    }
  });

  function startAuthRefreshLoop() {
    if (authState.refreshTimer) clearInterval(authState.refreshTimer);
    if (!authState.required) return;
    authState.refreshTimer = setInterval(async () => {
      if (!authState.user) return;
      const exp = getStoredAccessExp();
      const now = Math.floor(Date.now() / 1000);
      if (exp > 0 && exp - now <= 90) {
        await refreshAuthTokens();
      }
    }, 30_000);
  }

  // --- Initialization ---
  async function init() {
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
})();
