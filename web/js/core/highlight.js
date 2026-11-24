/**
 * Syntax highlighting for Minilang and Rust code blocks + HTML escaping.
 */

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

export { escapeHtml, highlightMinilang, highlightRust, highlightCode };
