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
    "fold", "global", "globals", "grid", "halt", "html", "import", "isconstant",
    "iterate", "key", "last", "last2", "locale", "markcc", "markdown", "max",
    "max2", "min", "min2", "now", "null", "pair", "parallel", "print", "println",
    "prod", "raise", "range", "reduce", "reduce2", "replace", "sleep", "some",
    "sum", "svg", "swap", "swapcc", "top", "top2", "trace", "ui", "unfold",
    "unique", "unique1", "unpack", "visit", "watched", "weave", "zip", "zip2"
  ]);

  const ML_TYPES = new Set([
    "address", "any", "array", "base16", "base64", "boolean", "buffer", "cbor",
    "chained", "channel", "compiler", "complex", "condition", "context", "decimal",
    "dir", "double", "enum", "error", "external", "file", "flags", "function",
    "integer", "json", "list", "logger", "macro", "map", "matrix", "method",
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

  // --- Lightweight Markdown Renderer ---
  function renderMarkdown(md) {
    if (!md || !md.trim()) {
      return `<div class="md-placeholder">Double-click to edit Markdown cell...</div>`;
    }
    const lines = md.replace(/\r\n/g, "\n").split("\n");
    let html = "";
    let inCode = false;
    let codeLang = "";
    let codeBuf = [];
    let inList = false;

    const flushList = () => {
      if (inList) {
        html += "</ul>";
        inList = false;
      }
    };

    const inlineFmt = (text) => {
      let s = escapeHtml(text);
      s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
      s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      return s;
    };

    for (const line of lines) {
      if (line.trim().startsWith("```")) {
        flushList();
        if (!inCode) {
          inCode = true;
          codeLang = line.trim().slice(3).trim().toLowerCase();
          codeBuf = [];
        } else {
          const raw = codeBuf.join("\n");
          const body = (codeLang === "minilang" || codeLang === "mini" || codeLang === "")
            ? highlightMinilang(raw)
            : escapeHtml(raw);
          html += `<pre><code>${body}</code></pre>`;
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
      if (/^---+$/.test(trimmed)) {
        flushList();
        html += "<hr/>";
        continue;
      }
      const hMatch = /^(#{1,4})\s+(.*)$/.exec(trimmed);
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
        if (!inList) {
          html += "<ul>";
          inList = true;
        }
        html += `<li>${inlineFmt(trimmed.replace(/^[-*]\s+/, ""))}</li>`;
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

  // --- API Helpers ---
  async function api(url, opts = {}) {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
      ...opts,
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
    languages: [
      { id: "minilang", name: "Minilang", version: "2.17.0", extensions: ["mini"], supports_notebook: true, supports_invoke: true, supports_ui: true },
      { id: "rust", name: "Rust", version: "1.x", extensions: ["rs"], supports_notebook: true, supports_invoke: true, supports_ui: false },
    ],
    currentDir: "",
    showHidden: false,
    searchQuery: "",
    dirEntries: [],
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
      const subDir = isSearch && entry.path.includes("/")
        ? entry.path.slice(0, entry.path.lastIndexOf("/"))
        : "";
      html += `
        <div class="file-row ${selected}" data-path="${escapeHtml(entry.path)}" data-kind="${entry.kind}" data-notebook="${entry.is_notebook}">
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
    });

    listEl.querySelectorAll(".act-rename").forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const oldPath = btn.dataset.path;
        const base = oldPath.split("/").pop();
        const dir = oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/")) : "";
        const newName = await showModal({
          title: "Rename",
          bodyHtml: `<p style="margin:0 0 10px;color:var(--text-secondary)">Rename <code>${escapeHtml(base)}</code> to:</p>`,
          confirmText: "Rename",
          inputValue: base,
        });
        if (!newName || !newName.trim() || newName.trim() === base) return;
        const to = dir ? `${dir}/${newName.trim()}` : newName.trim();
        try {
          await api("/api/file/rename", { method: "POST", body: JSON.stringify({ from: oldPath, to }) });
          const existingTab = state.tabs.find((t) => t.path === oldPath);
          if (existingTab) {
            existingTab.path = to;
            existingTab.title = newName.trim();
            renderTabs();
            updateStatusBar();
          }
          toast(`Renamed to ${newName.trim()}`, "success");
          loadDirectory();
        } catch (err) {
          toast(`Rename failed: ${err.message}`, "error");
        }
      };
    });

    listEl.querySelectorAll(".act-delete").forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const p = btn.dataset.path;
        const ok = await showModal({
          title: "Delete",
          bodyHtml: `<p style="margin:0;color:var(--text-secondary)">Permanently delete <code>${escapeHtml(p)}</code>?</p>`,
          confirmText: "Delete",
        });
        if (!ok) return;
        try {
          await api(`/api/file?path=${encodeURIComponent(p)}`, { method: "DELETE" });
          const tabIdx = state.tabs.findIndex((t) => t.path === p);
          if (tabIdx >= 0) closeTab(state.tabs[tabIdx].id);
          toast(`Deleted ${p}`, "success");
          loadDirectory();
        } catch (err) {
          toast(`Delete failed: ${err.message}`, "error");
        }
      };
    });
  }

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

  function renderActiveWorkspace() {
    const tab = activeTab();
    const nbToolbar = document.getElementById("notebook-toolbar");
    const fileToolbar = document.getElementById("file-toolbar");
    const nbView = document.getElementById("notebook-view");
    const fileView = document.getElementById("file-view");

    if (!tab) return;

    if (tab.kind === "notebook") {
      nbToolbar.classList.remove("hidden");
      fileToolbar.classList.add("hidden");
      nbView.classList.remove("hidden");
      fileView.classList.add("hidden");
      const langSel = document.getElementById("tb-lang-select");
      if (langSel) langSel.value = tab.doc.language || "minilang";
      const linfo = langInfo(tab.doc.language || "minilang");
      const ext = (linfo.extensions && linfo.extensions[0]) || "mini";
      document.getElementById("tb-export-mini").querySelector("span").textContent = `Export .${ext}`;
      renderCells();
    } else {
      nbToolbar.classList.add("hidden");
      fileToolbar.classList.remove("hidden");
      nbView.classList.add("hidden");
      fileView.classList.remove("hidden");

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
        } else if (d.mime === "text/html" || d.mime === "image/svg+xml") {
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
              <div class="output-error-title">${escapeHtml(output.error.error_type)}: ${escapeHtml(output.error.message)}</div>
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
        mdDiv.ondblclick = () => {
          cell._editingMd = true;
          selectCell(cell.id, false);
          updateSingleCellDom(tab, cell.id);
        };
        row.appendChild(mdDiv);
      }
    }

    el.appendChild(row);

    // Output
    if (cell.cell_type === "code" && hasOutput) {
      const outWrap = document.createElement("div");
      outWrap.innerHTML = renderOutputHtml(cell.output, cell.execution_count);
      if (outWrap.firstElementChild) {
        const outNode = outWrap.firstElementChild;
        el.appendChild(outNode);
        hydrateUiDisplays(outNode, cell.output);
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
    if (!tab) return;

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

  // Sidebar file creation buttons
  document.getElementById("btn-new-notebook").onclick = async () => {
    const langOpts = state.languages
      .filter((l) => l.supports_notebook)
      .map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)} (${escapeHtml(l.version)})</option>`)
      .join("");
    const name = await showModal({
      title: "New Notebook",
      bodyHtml: `
        <p style="margin:0 0 8px;color:var(--text-secondary)">Language kernel:</p>
        <select id="modal-lang-select" class="modal-input" style="margin-bottom:12px">${langOpts}</select>
        <p style="margin:0 0 8px;color:var(--text-secondary)">Create in <code>${escapeHtml(state.currentDir || "/")}</code>:</p>`,
      confirmText: "Create",
      inputValue: "untitled.mnb",
    });
    if (!name || !name.trim()) return;
    const chosenLang = document.getElementById("modal-lang-select")?.value || "minilang";
    const fname = name.trim().endsWith(".mnb") ? name.trim() : `${name.trim()}.mnb`;
    const fullPath = state.currentDir ? `${state.currentDir}/${fname}` : fname;
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
  };

  document.getElementById("btn-new-ui").onclick = async () => {
    const name = await showModal({
      title: "New Minilang UI (.ui)",
      bodyHtml: `<p style="margin:0 0 10px;color:var(--text-secondary)">Create UI file in <code>${escapeHtml(state.currentDir || "/")}</code>:</p>`,
      confirmText: "Create",
      inputValue: "app.ui",
    });
    if (!name || !name.trim()) return;
    const fname = name.trim().endsWith(".ui") ? name.trim() : `${name.trim()}.ui`;
    const fullPath = state.currentDir ? `${state.currentDir}/${fname}` : fname;
    try {
      await api("/api/file/new", { method: "POST", body: JSON.stringify({ path: fullPath, kind: "ui" }) });
      await loadDirectory();
      await openPathInTab(fullPath);
      toast(`Created ${fname}`, "success");
    } catch (e) {
      toast(e.message, "error");
    }
  };

  document.getElementById("btn-new-file").onclick = async () => {
    const name = await showModal({
      title: "New File",
      bodyHtml: `<p style="margin:0 0 10px;color:var(--text-secondary)">Create file in <code>${escapeHtml(state.currentDir || "/")}</code>:</p>`,
      confirmText: "Create",
      inputValue: "script.mini",
    });
    if (!name || !name.trim()) return;
    const fullPath = state.currentDir ? `${state.currentDir}/${name.trim()}` : name.trim();
    try {
      await api("/api/file/new", { method: "POST", body: JSON.stringify({ path: fullPath, kind: "file" }) });
      await loadDirectory();
      await openPathInTab(fullPath);
    } catch (e) {
      toast(e.message, "error");
    }
  };

  document.getElementById("btn-new-folder").onclick = async () => {
    const name = await showModal({
      title: "New Folder",
      bodyHtml: `<p style="margin:0 0 10px;color:var(--text-secondary)">Create folder in <code>${escapeHtml(state.currentDir || "/")}</code>:</p>`,
      confirmText: "Create",
      inputValue: "notebooks",
    });
    if (!name || !name.trim()) return;
    const fullPath = state.currentDir ? `${state.currentDir}/${name.trim()}` : name.trim();
    try {
      await api("/api/file/new", { method: "POST", body: JSON.stringify({ path: fullPath, kind: "dir" }) });
      await loadDirectory();
    } catch (e) {
      toast(e.message, "error");
    }
  };

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
      outBody.innerHTML = renderOutputHtml(resp, resp.execution_count) || `<span style="color:var(--text-muted)">(no output)</span>`;
      hydrateUiDisplays(outBody, resp);
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
      const cmd = `curl -s -X POST "${url}" -H "Content-Type: application/json" -d '${JSON.stringify(payload)}'`;
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
      const res = await fetch(`/invoke/${encodeURI(tab.path)}`, {
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

  // --- Initialization ---
  async function init() {
    try {
      const info = await api("/api/info");
      state.rootName = info.root_name || "workspace";
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
