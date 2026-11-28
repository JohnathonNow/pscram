# Minilang Notebook — Complete Guide

This guide covers everything you need to write, test, invoke, and deploy **polyglot notebooks (`.mnb` — Minilang & Rust)**, server-side **`.mini` and `.rs` scripts**, interactive browser-side **`.ui` user interfaces**, built-in **Minilang modules (`store`, `http`, `log`, `db`, `jobs`, `service`, `env`, `import`, `ui`)**, **interactive visualizations (`table`, `chart`, `progress`)**, **workspace viewers**, **inline Google Antigravity (`agy`) assistance**, and **local PAM authentication** in **Minilang Notebook**.

---

## Table of Contents

1. [Architecture Overview & Server CLI](#1-architecture-overview--server-cli)
   - [Supported File Types & Workflows](#supported-file-types--workflows)
   - [Server CLI Flags & Environment Variables](#server-cli-flags--environment-variables)
2. [Quick Minilang Syntax Primer](#2-quick-minilang-syntax-primer)
3. [Writing `.mini` Scripts, Modules & I/O](#3-writing-mini-scripts-modules--io)
   - [How `.mini` Scripts Execute](#how-mini-scripts-execute)
   - [Receiving Parameters (`Params`, `Args`, and Direct Variables)](#receiving-parameters-params-args-and-direct-variables)
   - [Returning Values](#returning-values)
   - [Modules & Imports (`import` / `export`)](#modules--imports-import--export)
   - [Persistent Storage (`store` Module)](#persistent-storage-store-module)
   - [HTTP Client (`http` Module)](#http-client-http-module)
   - [First-Class `log` Type](#first-class-log-type)
   - [SQLite Databases (`db` Module)](#sqlite-databases-db-module)
   - [Background Jobs (`jobs` Module & `sleep`)](#background-jobs-jobs-module--sleep)
   - [Background Services & Cross-UI Messaging (`service` Module)](#background-services--cross-ui-messaging-service-module)
   - [Prompting `agy` & Gemini (`ai`, `agy`, and `gemini` Modules)](#prompting-agy--gemini-ai-agy-and-gemini-modules)
   - [Environment Variables & Secrets (`env` Module & `secret`)](#environment-variables--secrets-env-module--secret)
   - [Rich Outputs, Visualizations & Media Previews (`table`, `chart`, `progress`, `image`, `pdf`, `preview`)](#rich-outputs-visualizations--media-previews-table-chart-progress-image-pdf-preview)
   - [Available Standard Modules & Helpers](#available-standard-modules--helpers)
   - [Using `.mini` Scripts in the Web UI](#using-mini-scripts-in-the-web-ui)
4. [Rust Notebooks & `.rs` Scripts](#4-rust-notebooks--rs-scripts)
   - [Interactive Rust Notebooks](#interactive-rust-notebooks)
   - [Specifying Cargo Dependencies](#specifying-cargo-dependencies)
   - [Invocable `.rs` Scripts](#invocable-rs-scripts)
5. [The `/invoke` HTTP Endpoint & Tagged JSON Format](#5-the-invoke-http-endpoint--tagged-json-format)
   - [Endpoints & Path Resolution](#endpoints--path-resolution)
   - [Request Schema](#request-schema)
   - [Response Schema & Status Codes](#response-schema--status-codes)
   - [Tagged JSON Type Reference](#tagged-json-type-reference)
   - [Calling Specific Functions in a Script](#calling-specific-functions-in-a-script)
   - [Timeouts, Isolation & Security](#timeouts-isolation--security)
6. [Writing `.ui` Files (Custom Minilang User Interfaces)](#6-writing-ui-files-custom-minilang-user-interfaces)
   - [How `.ui` Files Work (MiniJS Bytecode Compilation)](#how-ui-files-work-minijs-bytecode-compilation)
   - [Serving `.ui` Files from `/ui/{path}`](#serving-ui-files-from-uipath)
   - [Two Authoring Styles: Direct `ui::show` vs `ui::compile`](#two-authoring-styles-direct-uishow-vs-uicompile)
   - [Pre-Compiled `.ui` Files](#pre-compiled-ui-files)
7. [Complete `ui` Widget Reference](#7-complete-ui-widget-reference)
   - [Container Widgets](#container-widgets)
   - [Form Element Widgets](#form-element-widgets)
   - [Display & Raw HTML Widgets (`ui::html`)](#display--raw-html-widgets-uihtml)
   - [Widget Methods](#widget-methods)
   - [Common Styling & Layout Props](#common-styling--layout-props)
   - [Event Handling & Reactive State](#event-handling--reactive-state)
8. [Calling Scripts from `.ui` Files with `exec()`](#8-calling-scripts-from-ui-files-with-exec)
   - [Signatures](#signatures)
   - [Callback Arguments (`result`, `err`, `meta`)](#callback-arguments-result-err-meta)
   - [Automatic Tagged JSON Marshaling](#automatic-tagged-json-marshaling)
9. [Workspace Viewers, File Explorer & Inline `agy` Assistant](#9-workspace-viewers-file-explorer--inline-agy-assistant)
   - [File Explorer & Right-Click Context Menu](#file-explorer--right-click-context-menu)
   - [Image & PDF Viewer Tabs & Lightbox](#image--pdf-viewer-tabs--lightbox)
   - [Log File Viewer (`MLOG` & Plain-Text `.log`)](#log-file-viewer-mlog--plain-text-log)
   - [Markdown Document Viewer](#markdown-document-viewer)
   - [Inline Google Antigravity (`agy`) Assistant](#inline-google-antigravity-agy-assistant)
10. [Local Machine Authentication (PAM + Refreshable Tokens)](#10-local-machine-authentication-pam--refreshable-tokens)
    - [Enabling Login & Unix Group Restrictions](#enabling-login--unix-group-restrictions)
    - [Token Lifecycle & API Endpoints](#token-lifecycle--api-endpoints)
    - [Using Authenticated Requests with `curl`](#using-authenticated-requests-with-curl)
11. [End-to-End Cookbook Examples](#11-end-to-end-cookbook-examples)
    - [Example 1: Parameterized API Script (`scripts/greet.mini`)](#example-1-parameterized-api-script-scriptsgreetmini)
    - [Example 2: Multi-Function Data Script (`scripts/stats.mini`)](#example-2-multi-function-data-script-scriptsstatsmini)
    - [Example 3: Interactive Form UI (`uis/greeter.ui`)](#example-3-interactive-form-ui-uisgreeterui)
    - [Example 4: Tabbed Dashboard Calling Multiple Modes (`uis/stats.ui`)](#example-4-tabbed-dashboard-calling-multiple-modes-uisstatsui)
    - [Example 5: Dynamic List Builder with Raw HTML & Local State](#example-5-dynamic-list-builder-with-raw-html--local-state)
    - [Example 6: Cached HTTP Pipeline with `store`, `http`, and `log`](#example-6-cached-http-pipeline-with-store-http-and-log)
    - [Example 7: Reusable Minilang Module (`import` / `export`)](#example-7-reusable-minilang-module-import--export)
    - [Example 8: Invocable Rust Script with Cargo Dependencies](#example-8-invocable-rust-script-with-cargo-dependencies)
12. [Troubleshooting & Gotchas](#12-troubleshooting--gotchas)

---

## 1. Architecture Overview & Server CLI

### Supported File Types & Workflows

Minilang Notebook unifies polyglot notebooks, invocable backend scripts, browser UIs, rich file viewers, and inline AI assistance in a single Rust binary:

| File Type | Extension(s) | Where It Runs | How It Is Used |
|---|---|---|---|
| **Polyglot Notebook** | `.mnb` | Isolated persistent kernel per open tab (**Minilang** or **Rust**) | Interactive REPL cells, Markdown notes, Variable Inspector, rich HTML/SVG/UI/image/PDF outputs |
| **User Script** | `.mini`, `.rs` | Isolated server-side execution per request (Minilang worker or cached compiled Rust binary) | Backend logic callable via `POST /invoke/{path}` with tagged JSON parameters |
| **User Interface** | `.ui` | Compiled on the server via `minijs`, executed live in the browser | Custom interactive web apps served at `GET /ui/{path}`, calling `.mini` or `.rs` endpoints via `exec()` |
| **Structured / Text Logs** | `.log`, `.mlog` (or any `MLOG` binary file) | Parsed on the server via `GET /api/log` | Interactive Log Viewer tab with live tail, search, type filtering, and structured value inspection |
| **Markdown Documents** | `.md`, `.markdown` | Rendered in the browser | Dedicated Markdown viewer with Preview, Split, and Edit modes, GFM tables, syntax highlighting, and media thumbnails |
| **Images & PDFs** | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.ico`, `.avif`, `.pdf` | Streamed via `GET /api/file/raw` | Dedicated viewer tabs (zoom/fit/rotate/download) and inline thumbnail previews with Lightbox inside notebooks |

```text
Browser Workspace / Standalone /ui/{path}
  ├── Polyglot Notebooks (.mnb: Minilang & Rust kernels)
  ├── Live UI Apps (.ui running in MiniJS Bytecode VM)
  │     └── exec("scripts/foo.mini" | "scripts/bar.rs", params; result, err, meta)
  ├── File Explorer (right-click context menu: copy/cut/paste, paths, duplicate, ...)
  ├── Built-in Viewers (Images, PDFs, Logs, Markdown)
  └── Inline Google Antigravity (`agy`) Assistant (cells & script files)
          │
          ▼  HTTP / JSON (optional PAM + Bearer JWT auth)
Rust Server (Axum)
  ├── Minilang Kernels (`--kernel --lang minilang`) — store, http, log, import/export, ui
  ├── Rust Kernels (`--kernel --lang rust`) — rustc + Cargo dependency builds + binary cache
  ├── File & Viewer APIs (`/api/files`, `/api/file/copy`, `/api/file/raw`, `/api/log`)
  └── `agy` Runner (`/api/agy/status`, `/api/agy/assist`, `/api/agy/cancel`)
```

### Server CLI Flags & Environment Variables

Run `minilang-notebook --help` to see all options. Common startup flags:

| Flag | Default | Description |
|---|---|---|
| `--host <HOST>` | `127.0.0.1` | Host interface to bind to |
| `-p, --port <PORT>` | `8888` | Port to listen on |
| `-r, --root <DIR>` | `.` | Root workspace directory exposed in the file explorer and `/invoke` |
| `--web-dir <DIR>` | *(embedded)* | Serve frontend assets (`index.html`, `style.css`, `app.js`, `minijs_vm.js`) from disk for live editing |
| `--require-login` | `false` | Require local Unix login via PAM + Bearer access tokens for `/api/*`, `/invoke/*`, and `/ui/*` |
| `--require-group <GROUP>` | *(none)* | Restrict login to members of Unix group `<GROUP>` (implies `--require-login`) |
| `--pam-service <NAME>` | `login` | PAM service name under `/etc/pam.d/<service>` |
| `--access-token-ttl <SECS>` | `900` | Access JWT lifetime in seconds (15 minutes) |
| `--refresh-token-ttl <SECS>` | `604800` | Rotating refresh token lifetime in seconds (7 days) |
| `--auth-secret <SECRET>` | *(random)* | HMAC-SHA256 signing secret (can also be set via `MINILANG_AUTH_SECRET`) |
| `--agy-bin <PATH>` | *(auto-detected)* | Explicit path to the `agy` CLI binary (can also be set via `MINILANG_AGY_BIN`) |
| `--agy-model <MODEL>` | *(agy default)* | Default `--model` passed to `agy` for inline AI assistance |
| `--agy-timeout <SECS>` | `120` | Timeout in seconds for inline `agy` requests (`10`–`600`) |

Additional environment variables:
- `MINILANG_AUTH_SECRET`: HMAC signing secret when `--auth-secret` is omitted.
- `MINILANG_AGY_BIN`: Path to `agy` binary when `--agy-bin` is omitted.
- `MINILANG_RUST_OFFLINE=1`: Prevent Cargo from retrying online if a crate is not already cached locally.

---

## 2. Quick Minilang Syntax Primer

If you are new to Minilang, keep these core idioms in mind when writing `.mini` and `.ui` files:

- **Comments**:
  ```minilang
  :> Single-line comment
  :< Multi-line (nestable) block comment >:
  ```
- **Bindings & Assignment**:
  ```minilang
  let x := 10          :> Immutable binding
  var count := 0       :> Mutable variable
  count := count + 1   :> Reassigning a mutable variable
  ```
- **Equality vs Assignment**:
  - `:=` is assignment.
  - `=` is equality comparison (`!=`, `<`, `<=`, `>`, `>=`).
- **Truthiness (Very Important!)**:
  - **Only `nil` is falsy in Minilang.**
  - `false` is a `boolean` value, **not** `nil`! Always test booleans explicitly with `= true` or `= false`:
    ```minilang
    :> Correct way to branch on a boolean:
    if flag = true then
        "enabled"
    else
        "disabled"
    end
    ```
  - Comparison operators return the right-hand value on success or `nil` on failure, which is why `if x = 5 then ... end` works naturally.
- **Strings & Interpolation**:
  - Double-quoted `"hello\n"` is a plain string literal (no interpolation).
  - Single-quoted `'Hello, {name}! 2 + 2 = {2 + 2}'` evaluates `{...}` expressions inline.
- **Collections (1-Indexed!)**:
  ```minilang
  let xs := [10, 20, 30]
  xs[1]                               :> 10 (1-based indexing)
  xs[-1]                              :> 30 (negative index from end)

  let m := {"name" is "Ada", "age" is 36}
  m["name"]                           :> "Ada"
  m["missing"] or "default"           :> "default" (`or` falls back when nil)
  ```
- **Functions & Trailing Closure Syntax (`;`)**:
  ```minilang
  fun add(a, b) do
      ret a + b
  end

  :> Trailing closure syntax: arguments before `;` are passed first,
  :> and parameters after `;` define an anonymous closure passed as the final argument.
  let squares := list(1 .. 5; n) n * n     :> [1, 4, 9, 16, 25]

  ui::button("Click Me";) do
      println("Clicked!")
  end
  ```
- **Ranges**: Put spaces around `..` (e.g. `1 .. 10`, not `1..10`).

---

## 3. Writing `.mini` Scripts, Modules & I/O

`.mini` files are standard Minilang scripts stored anywhere inside the workspace (conventionally under `scripts/`). They can be run interactively in the editor, imported as modules, converted to notebooks, or invoked programmatically via `/invoke`.

### How `.mini` Scripts Execute

When a `.mini` script is called through `/invoke`:

1. The Rust server validates that the target file exists inside the workspace root and has a `.mini` (or `.rs`) extension.
2. It spawns a **fresh, isolated Minilang kernel subprocess** with its working directory set to the script's parent folder (so relative `file(...)`, `store::*(...)`, `log(...)`, and `import("./...")` paths resolve relative to the script).
3. All tagged JSON parameters are converted to native Minilang values and injected into the script's scope.
4. All top-level expressions in the `.mini` file are evaluated in order.
5. If a `function` name was requested, that function is then called.
6. The final evaluated value is serialized back into tagged JSON and returned alongside captured `stdout`, rich `displays`, string `repr`, `type_name`, and `duration_ms`.
7. The subprocess is terminated cleanly — no mutable state leaks between requests.

### Receiving Parameters (`Params`, `Args`, and Direct Variables)

Every `/invoke` request can supply named `params` and/or positional `args`:

1. **`Params` (Minilang `map`)**: Always defined. Contains all key-value pairs from the request's `params` object. Best used for optional parameters with defaults:
   ```minilang
   let who := Params["name"] or "World"
   let limit := Params["limit"] or 10
   ```
2. **Direct top-level variables**: Every key in `params` that is a valid Minilang identifier (`[A-Za-z_][A-Za-z0-9_]*`) is **also** bound directly in the script's top-level scope. So if the caller passes `"count": { "type": "integer", "value": 5 }`, you can reference `count` directly without indexing `Params`:
   ```minilang
   let doubled := count * 2
   ```
   *(Note: if a parameter might be omitted by callers, prefer `Params["count"] or 0` so referencing an omitted identifier does not raise an uninitialized `ValueError`.)*
3. **`Args` (Minilang `list`)**: Always defined. Contains all positional arguments passed in the request's `args` array (1-indexed: `Args[1]`, `Args[2]`, ...).

### Returning Values

The **last top-level expression** evaluated in the `.mini` script becomes the `result` of the `/invoke` response:

```minilang
let a := Params["a"] or 0
let b := Params["b"] or 0

println('Computing {a} + {b}')   :> Goes to `stdout`, does NOT overwrite final result

{
    "sum" is a + b,
    "product" is a * b
}
```

If you return a `map`, `list`, `tuple`, `set`, `integer`, `real`, `string`, `boolean`, `symbol`, `time`, `uuid`, `bytes`, or `nil`, it is faithfully encoded in the response's tagged JSON `result` field.

### Modules & Imports (`import` / `export`)

Minilang's native module/library loader (`ML_MODULES` + `ML_LIBRARY`) is enabled in both **`.mini` scripts** and **Minilang notebooks**.

#### Exporting Symbols from a `.mini` Module

Use `export:` to publish functions, constants, or values from a `.mini` file (e.g. `scripts/math.mini`):

```minilang
export: let VERSION := "1.0"
export: fun square(X) X * X
export: fun cube(X) X * X * X
```

*(A top-level fallback `export` is also defined so modules using `export:` can still be executed directly with the editor's Run button or `/invoke` without failing.)*

#### Importing `.mini` Modules

You can import with or without the `.mini` extension using either Minilang's `import:` syntax or direct `import(...)` calls:

```minilang
:> Relative to the current script or notebook directory
import: math("./math")
import: math2("./math.mini")
import: helper("../scripts/helper.mini")

:> Bare module name (searches workspace root & `scripts/` library paths)
import: math("math")

:> Expression form
let m := import("./math")
m::square(7)            :> 49
math::VERSION           :> "1.0"
```

#### Stringifying `import` (Current Script / Notebook Directory)

Stringifying `import` itself evaluates to the directory path of the current script or notebook (matching Minilang's built-in importer convention):

```minilang
string(import)                          :> "/path/to/workspace/scripts"
let data := store::get('{import}/cache.cbor')
let events := log('{import}/events.log')
```

### Persistent Storage (`store` Module)

The built-in `store` module makes saving and caching values on disk effortless. All writes create missing parent directories automatically and write **atomically** (temporary file + rename) so concurrent readers never see partial files.

#### CBOR Value Storage (Arbitrary Minilang Values)

| Function | Behavior |
|---|---|
| `store::get(path)` | Read and decode a CBOR-encoded Minilang value (`map`, `list`, `integer`, `real`, `string`, `boolean`, `bytes`, `time`, etc.) from `path`. |
| `store::put(path, value)` | CBOR-encode `value` and write it atomically to `path`. Returns `value`. |
| `store::create(path, fn)` | If `path` already exists, read and return its CBOR value; otherwise call `fn(path)`, store the returned value as CBOR, and return it. |

#### Raw Bytes Storage (`address` / `buffer`)

| Function | Aliases | Behavior |
|---|---|---|
| `store::get_raw(path)` | `store::get_bytes(path)` | Read raw bytes from `path` as a Minilang byte buffer (`address`). |
| `store::put_raw(path, bytes)` | `store::put_bytes(path, bytes)` | Write an `address`/buffer or `string` as raw bytes atomically to `path`. Returns `bytes`. |
| `store::create_raw(path, fn)` | `store::create_bytes(path, fn)` | Read raw bytes if `path` exists; otherwise call `fn(path)`, store raw bytes, and return them. |

#### Plain String Storage

| Function | Aliases | Behavior |
|---|---|---|
| `store::get_string(path)` | `store::get_text(path)` | Read UTF-8 text from `path` as a `string`. |
| `store::put_string(path, val)` | `store::put_text(path, val)` | Write a `string` (or stringified value) atomically to `path`. Returns `val`. |
| `store::create_string(path, fn)` | `store::create_text(path, fn)` | Read text if `path` exists; otherwise call `fn(path)`, store as text, and return it. |

#### Utility Helpers

| Function | Behavior |
|---|---|
| `store::exists(path)` | Returns `path` (truthy) if `path` is an existing regular file, or `nil` otherwise. |
| `store::delete(path)` | Deletes `path`. Returns `true` if deleted, `nil` if the file did not exist. |

```minilang
:> Cache an expensive computation to CBOR on disk
let table := store::create("cache/primes.cbor"; p) do
    println('Computing cache for {p}...')
    list(2 .. 100) ->? fun(n) not (2 .. (n - 1) ->? fun(d) n % d = 0):first
end

:> Save & read plain text or raw bytes
store::put_string("notes/summary.txt", "All systems nominal")
let raw := store::get_raw("assets/chart.png")
```

### HTTP Client (`http` Module)

The built-in `http` module (powered by dynamically loaded `libcurl.so.4`, following redirects by default) supports all standard HTTP verbs:

```minilang
http::get(url, mode?, query?, headers?)
http::post(url, mode?, query?, headers?, body?)
http::put(url, mode?, query?, headers?, body?)
http::patch(url, mode?, query?, headers?, body?)
http::delete(url, mode?, query?, headers?, body?)
http::request(method, url, mode?, query?, headers?, body?)
```

#### Response Modes (`mode`)

| Mode | Return Value |
|---|---|
| `"text"` *(default)* | Response body as a Minilang `string` |
| `"json"` | JSON-decoded Minilang value (`map`, `list`, primitives) |
| `"raw"` | Raw response bytes as a Minilang `address` buffer |
| `"file"` | Open `file` handle rewound to byte 0 (written to a temp file, or to disk if `file := "path"` is passed) |
| `"response"` | Full response `map`: `{"status" is <int>, "headers" is <lowercase-key map>, "body" is <string>}` (does **not** throw on HTTP 4xx/5xx) |

For `"json"`, `"text"`, `"raw"`, and `"file"` modes, HTTP status codes `>= 400` raise an `HttpError` with the status code and body snippet.

#### Arguments & Named Options

- **`query`**: A `map` of key-value pairs (URL-encoded automatically; list values repeat the key), a pre-formatted query `string`, or `nil`.
- **`headers`**: A `map` (`{"Authorization" is "Bearer ..."}`), a `list` of `"Header: value"` strings, or `nil`.
- **`body`**:
  - `string` → sent as-is (default `Content-Type: text/plain; charset=utf-8`).
  - `address` (raw bytes) → sent as-is (default `Content-Type: application/octet-stream`).
  - Any other Minilang value (`map`, `list`, etc.) → automatically JSON-encoded (default `Content-Type: application/json`).
- **Named keyword options**: Any argument can also be passed by name:
  - `mode :=` / `as :=`
  - `query :=` / `params :=`
  - `headers :=`
  - `body :=` / `data :=` / `json :=`
  - `file :=` / `path :=` / `dest :=` (destination path when `mode` is `"file"`)
  - `timeout := 60` (request timeout in seconds; default `30`)

```minilang
:> GET parsed JSON with query params and headers
let data := http::get(
    "https://api.example.com/items",
    "json",
    {"limit" is 25, "tag" is ["rust", "minilang"]},
    {"Accept" is "application/json"}
)

:> POST a Minilang map (auto-encoded as JSON) and inspect status + headers
let resp := http::post(
    "https://api.example.com/jobs",
    "response",
    nil,
    {"Authorization" is "Bearer secret"},
    {"task" is "reindex", "priority" is 1},
    timeout := 60
)
println('Status: {resp["status"]}')

:> Download binary asset directly to disk
let f := http::get("https://example.com/report.pdf", "file", file := "downloads/report.pdf")
f:close
```

### First-Class `log` Type

Minilang includes a built-in **`log`** type (`MLLogT`, inheriting `MLSequenceT`) for recording arbitrary timestamped values either **in memory** or **persistently on disk** using a crash-safe framed-CBOR format (`MLOG` magic + nanosecond UTC timestamps + length-prefixed CBOR payloads).

#### Constructors

| Constructor | Behavior |
|---|---|
| `log()` | Create an in-memory log (stores any Minilang value, including closures/handles). |
| `log(path)` or `log(path, "a")` | Open or create a persistent file-backed log in append/read-write mode (also accepts `"a+"`, `"rw"`). Loads existing entries automatically. |
| `log(path, "r")` | Open an existing file-backed log read-only. |
| `log(path, "w")` | Create or truncate a file-backed log to empty. |

#### Appending, Querying & Lifecycle Methods

| Operation | Description |
|---|---|
| `L(val)` / `L(v1, v2, ...)` | Calling a log directly appends one or more values and returns `L`. |
| `L:put(val)` | Append `val` and return `L` (aliases: `:push`, `:write`, `:add`, `:append`). |
| `L:count` | Number of entries (aliases: `:length`, `:size`). |
| `L[i]` | 1-based index (negative indices count from the end: `L[-1]` is the latest value). |
| `L[start, end]` | Slice returning a `list` of values from `start` (inclusive) to `end` (exclusive). |
| `L:first` / `L:last` | First or last logged value (`nil` if empty). |
| `L:head(n?)` / `L:tail(n?)` | First or last `n` values as a `list` (default `n = 10`). |
| `L:entry(i)` | Full entry `map`: `{"index" is i, "time" is <time>, "value" is <val>}`. |
| `L:time(i)` | Timestamp (`time`) of entry `i`. |
| `L:entries` / `L:values` | All entries (as `{index, time, value}` maps) or all raw values as a `list`. |
| `L:since(t)` | All entry maps recorded at or after `t` (`time`, integer epoch seconds, or real seconds). |
| `for v in L do ... end` | Iterate values directly (`log` is a `sequence`, so `list(L)`, `L -> fn`, `L ->? pred`, etc. all work). |
| `for ts, v in L do ... end` | Iterate `(timestamp, value)` pairs. |
| `L:path` | Backing file path (`nil` for in-memory logs). |
| `L:flush` / `L:sync` | Flush and `fsync` the backing file. |
| `L:reload` | Read any new frames appended externally to the backing file; returns count of newly loaded entries. |
| `L:clear` | Clear all entries (and truncate the backing file). |
| `L:close` | Flush and close the backing file handle. |

```minilang
let events := log("logs/pipeline.log")
events({"level" is "info", "step" is "fetch", "rows" is 1420})
events:put({"level" is "warn", "step" is "parse", "skipped" is 3})

println('Total entries: {events:count}')
println('Latest entry: {events:entry(-1)}')

:> Filter directly with Minilang sequence operators
let warnings := list(events ->? fun(e) e["level"] = "warn")
```

File-backed logs can be opened directly in the built-in [Log File Viewer](#log-file-viewer-mlog--plain-text-log) from the file explorer sidebar.

### SQLite Databases (`db` Module)

The built-in `db` module (powered by dynamically loaded `libsqlite3.so.0`) provides full SQLite3 access with parameterized queries, transactions, and schema introspection. File-backed databases automatically create missing parent directories and can be inspected visually in the built-in SQLite Browser by clicking any `.sqlite` / `.db` file in the sidebar.

#### Module Functions

| Function | Behavior |
|---|---|
| `db::open(path?, mode?)` | Open a SQLite connection (`path` defaults to `":memory:"`). Pass `"r"`, `"ro"`, `"readonly"`, or `true` as `mode` to open read-only. Returns a `db::connection`. |
| `db::query(path, sql, params?)` | One-shot helper: opens `path`, executes `sql` with optional `params`, closes the connection, and returns a `list` of row `map`s. |
| `db::exec(path, sql, params?)` | One-shot helper: opens `path`, executes DDL/DML `sql`, closes the connection, and returns `{"changes" is <int>, "last_insert_rowid" is <int>}`. |

#### Connection Methods (`db::connection`)

| Method | Description |
|---|---|
| `conn:exec(sql, params?)` | Execute DDL/DML statements. Returns `{"changes" is <int>, "last_insert_rowid" is <int>}`. |
| `conn:query(sql, params?)` | Run a `SELECT` query and return a `list` of row `map`s (keys are column names; SQLite `NULL` maps to `nil`, `BLOB` maps to `address`). |
| `conn:one(sql, params?)` | Run a `SELECT` query and return only the first row `map` (or `nil` if no rows match). |
| `conn:begin` / `conn:commit` / `conn:rollback` | Start, commit, or roll back a SQLite transaction (returns `conn`). |
| `conn:tables` | Returns a sorted `list` of table and view names (excluding internal `sqlite_*` tables). |
| `conn:schema(table_name?)` | Returns `sqlite_master` rows (`type`, `name`, `tbl_name`, `sql`), optionally filtered to `table_name`. |
| `conn:path` | Returns the database path string (`":memory:"` for in-memory connections). |
| `conn:close` | Closes the SQLite connection (also closed automatically by GC finalizer). |

**Parameter Binding (`params`)**:
- **Positional (`?`)**: Pass a `list` or `tuple`, e.g. `["Ada", 98.5, nil]`.
- **Named (`:name`, `@name`, `$name`)**: Pass a `map`, e.g. `{"name" is "Ada", "min_score" is 90}` (prefix optional in map keys).

```minilang
let conn := db::open("analytics.sqlite")
conn:exec("CREATE TABLE IF NOT EXISTS metrics (id INTEGER PRIMARY KEY, region TEXT, revenue REAL)")
conn:begin
conn:exec("INSERT INTO metrics (region, revenue) VALUES (?, ?)", ["NA", 4250.0])
conn:exec("INSERT INTO metrics (region, revenue) VALUES (:region, :rev)", {"region" is "EU", "rev" is 3180.5})
conn:commit

let rows := conn:query("SELECT region, SUM(revenue) AS total FROM metrics GROUP BY region ORDER BY total DESC")
table(rows, "Revenue by Region")
chart({"type" is "bar", "title" is "Revenue by Region ($)", "data" is rows, "x" is "region", "y" is "total"})
conn:close
```

See [notebooks/sqlite_db.mnb](notebooks/sqlite_db.mnb) for a complete walkthrough with transactions, joins, charts, and a live SQL dashboard.

### Background Jobs (`jobs` Module & `sleep`)

The built-in `jobs` module lets notebooks and scripts launch other `.mini` or `.rs` scripts asynchronously in isolated background worker processes, track their progress and `stdout`, wait for completion, or cancel them. All running and completed jobs also appear in the **Jobs** manager modal in the Web UI.

#### Module Functions

| Function | Aliases | Description |
|---|---|---|
| `jobs::start(script, params?, options?)` | `jobs::run`, `jobs::spawn` | Launch `script` asynchronously in the background. Returns a `jobs::handle`. Supports named args or an options map (`name :=`, `function :=`, `args :=`, `params :=`). |
| `jobs::list()` | — | Returns a `list` of status `map`s for all tracked background jobs. |
| `jobs::status(handle_or_id)` | `jobs::get` | Returns the status `map` (`id`, `name`, `script`, `status`, `progress`, `stdout`, `result_plain`, `error`, `duration_ms`, etc.). |
| `jobs::wait(handle_or_id, timeout_ms?)` | — | Blocks until the job completes and returns its unwrapped `result_plain` value (raises `JobError` if failed, cancelled, or timed out). |
| `jobs::join(handle_or_id, timeout_ms?)` | — | Blocks until the job finishes and returns the full job status `map` (does not throw on job failure). |
| `jobs::output(handle_or_id)` | `jobs::stdout` | Returns the captured `stdout` string produced by the job so far. |
| `jobs::stop(handle_or_id)` | `jobs::cancel`, `jobs::kill` | Terminates a running background job. |
| `jobs::clear()` | — | Removes finished/cancelled jobs from the job history list. |
| `jobs::sleep(seconds)` | `sleep(seconds)` | Sleeps for `seconds` (integer or real; e.g. `sleep(0.25)`). |

#### Handle Methods (`jobs::handle`)

| Method | Description |
|---|---|
| `h:id` | Job ID string |
| `h:status` | Full job status `map` |
| `h:running` | Returns `true` if still running, `nil` otherwise |
| `h:wait(timeout_ms?)` | Wait for completion and return the unwrapped result value |
| `h:join(timeout_ms?)` | Wait for completion and return the full status `map` |
| `h:result` | Current `result_plain` value (`nil` until finished) |
| `h:stdout` / `h:output` | Captured `stdout` string |
| `h:stop` / `h:cancel` / `h:kill` | Cancel/terminate the running job |

```minilang
let j1 := jobs::start("scripts/greet.mini", {"name" is "Worker 1", "repeat" is 3}, name := "Greeter 1")
let j2 := jobs::start("scripts/fib.rs", {"n" is 30}, name := "Fib 30")

let r1 := j1:wait(10000)
let r2 := j2:wait(10000)
println('Job 1: {r1["greeting"]} | Job 2 fib(30) = {r2["fib"]}')
```

### Background Services & Cross-UI Messaging (`service` Module)

The `service` module turns any `.mini` script into a **persistent background service** that maintains state and exchanges real-time messages (pub/sub broadcasts, direct messages, and request-reply RPC) with **multiple open `.ui` apps**, notebooks, and other scripts simultaneously. Services can also be started, restarted, inspected, and stopped from the script editor's **Start Service** button or the **Services** tab of the Jobs & Sessions manager.

#### Server-Side API (Services, Scripts & Notebooks)

| Function | Description |
|---|---|
| `service::start(script, opts?)` or `service::start(name, script, params_or_opts?)` | Start a `.mini` script as a named background service. Pass `{"params" is {...}, "replace" is true}` to restart/replace an existing service of the same name. |
| `service::self()` | Inside a service, returns `{"id" is ..., "name" is ...}` (or `nil` outside a service). |
| `service::list()` | Returns a `list` of all registered service status `map`s. |
| `service::status(name_or_id)` | Returns detailed status for a service (status, connected UI clients, message counters, stdout/stderr tail). |
| `service::stop(name_or_id)` / `service::restart(name_or_id)` | Stop or restart a background service. |
| `service::clients(name_or_id?)` | Returns the `list` of currently connected UI `client_id` strings (defaults to the current service). |
| `service::recv(timeout_ms?)` | Inside a service loop, blocks until the next inbound message arrives and returns `{"id", "from", "topic", "data", "reply_to", "timestamp"}` (or `nil` on timeout or shutdown). |
| `service::broadcast(topic, data?)` | Inside a service, pushes a real-time SSE event to **all** subscribed UIs (returns number of recipients). Outside a service, pass `service::broadcast(service_name, topic, data?)`. |
| `service::send(target, topic, data?)` | Inside a service, if `target` starts with `"ui-"` (a UI's `client_id`), delivers a direct message to that specific UI; otherwise sends into `target` service's inbox. |
| `service::reply(msg_or_reply_id, data?)` | Inside a service, fulfills a pending `service::call()` RPC request using the inbound `msg` map (or its `msg["reply_to"]` string). |
| `service::call(target_service, topic, data?, timeout_ms?)` | Synchronous request-reply RPC to a running service (default timeout 15,000 ms); returns the decoded reply value. |

#### Browser-Side API (Inside `.ui` Files via MiniJS VM)

| Function | Description |
|---|---|
| `service::on(service_name, topic?, handler)` | Subscribe to real-time SSE events from `service_name` (omit `topic` or use `"*"` for all topics). `handler` receives `(data, msg_map)`. Returns an unsubscribe function. Top-level `service::on(...)` calls automatically attach when the UI mounts. |
| `service::off(service_name, topic?)` | Unsubscribe from a specific `topic` or all topics on `service_name`. |
| `service::send(service_name, topic, data?, callback?)` | Fire-and-forget message from the browser UI into the service's inbox. |
| `service::call(service_name, topic, data?, callback?, timeout_ms?)` | Async request-reply RPC from the browser UI; invokes `callback(reply, err)`. |
| `service::client_id()` | Returns this UI tab's unique `"ui-..."` client ID. |
| `service::list(callback)` / `service::status(name, callback)` | Query running services asynchronously (`callback(result, err)`). |
| `service::start(name?, script, params?, callback?)` / `service::stop(name, callback?)` / `service::restart(name, callback?)` | Manage service lifecycle directly from a `.ui` app. |

```minilang
:> Example background service: scripts/counter_service.mini
var count := 0
while let msg := service::recv() do
    if msg["topic"] = "inc" then
        count := count + (msg["data"] or 1)
        service::broadcast("changed", {"count" is count, "by" is msg["from"]})
    elseif msg["topic"] = "get" then
        service::reply(msg, {"count" is count})
    end
end
```

```minilang
:> Example UI subscribing to the service (open in two browser tabs to watch them sync!)
let readout := ui::heading("Count: ?", 2)
service::on("counter", "changed"; data) do
    readout:set_text('Count: {data["count"]} (updated by {data["by"]})')
end
let btn := ui::button("+1";) do
    service::send("counter", "inc", 1)
end
ui::show(ui::card("Shared Counter", ui::vbox(readout, btn)))
```

> **Try the full ready-to-run example:** Start [services/taskboard.mini](services/taskboard.mini) and open [uis/taskboard.ui](uis/taskboard.ui) (at `/ui/uis/taskboard.ui`, which also auto-starts the service if it isn't running yet) in two browser tabs side by side to test real-time pub/sub broadcasts, request-reply RPC, targeted direct messages (`service::send("ui-...", ...)`), live tables/charts, and service lifecycle controls.

### Prompting `agy` & Gemini (`ai`, `agy`, and `gemini` Modules)

Minilang includes built-in modules for programmatically prompting both the local **Google Antigravity CLI (`agy`)** and the **Google Gemini REST API** directly from notebooks, `.mini` scripts, background jobs, and services — including multi-turn sessions, structured JSON outputs, multimodal images, and embeddings.

#### `agy` Module (Local Antigravity CLI)

| Function | Aliases | Description |
|---|---|---|
| `agy::prompt(prompt, opts?)` | `agy::ask`, `agy::run` | Prompt `agy` and return the response `string` (or decoded Minilang value if `json is true`, or full metadata map if `full is true`). Options: `system is`, `model is`, `effort is "low" \| "medium" \| "high" \| "xhigh" \| "max"`, `mode is "plan" \| ...`, `conversation_id is`, `timeout is 120`, `json is true`, `full is true`. |
| `agy::complete(prompt, opts?)` | — | Same as `agy::prompt(..., full is true)` — returns `{"provider", "text", "conversation_id", "suggested_code", "suggested_lang", "duration_ms"}`. |
| `agy::stream(prompt, on_chunk?, opts?)` | — | Stream incremental chunks from `agy --output-format stream-json` with live progressive Markdown rendering in notebook cells (`display is true` default) and optional `on_chunk` callback (`fun(chunk)`). |
| `agy::chat(messages, opts?)` | — | Prompt `agy` with a `list` of `{"role" is "system" \| "user" \| "assistant", "content" is "..."}` maps (or call with no message list to create a stateful session). |
| `agy::session(opts?)` | — | Create a stateful `ai::session` that automatically threads `conversation_id` across turns. |
| `agy::status()` | — | Returns `{"available" is bool, "bin" is path_or_nil, "default_model" is str_or_nil}`. |

#### `gemini` Module (Google Gemini REST API)

API keys are resolved automatically from `api_key is "..."`, the **Secrets Vault** (`GEMINI_API_KEY` / `GOOGLE_API_KEY`), or environment variables. Default model is `gemini-2.5-flash` (overridable via `model is "..."` or `GEMINI_MODEL`).

| Function | Aliases | Description |
|---|---|---|
| `gemini::prompt(prompt, opts?)` | `gemini::ask`, `gemini::generate` | Prompt Gemini (`:generateContent`) and return the text `string` (or decoded Minilang value if `json is true`). Options: `model is`, `system is`, `temperature is`, `top_p is`, `top_k is`, `max_tokens is`, `json is true`, `response_mime_type is`, `response_schema is`, `image is path_or_bytes`, `images is [...]`, `tools is [...]` (automatic Minilang function-calling loop!), `max_tool_rounds is 8`, `api_key is`, `base_url is`, `timeout is 90`, `full is true`. |
| `gemini::complete(prompt, opts?)` | — | Same as `gemini::prompt(..., full is true)` — returns `{"provider", "model", "text", "finish_reason", "usage", "tool_calls", "raw"}`. |
| `gemini::stream(prompt, on_chunk?, opts?)` | — | Stream tokens live via `:streamGenerateContent?alt=sse` with progressive Markdown display in notebook cells (`display is true` default) and optional `on_chunk` callback (`fun(chunk)`). |
| `gemini::chat(messages, opts?)` | — | Multi-turn chat with a `list` of `{"role" is "system" \| "user" \| "model" \| "assistant", "content" is "..."}` maps. |
| `gemini::session(opts?)` | — | Create a stateful `ai::session` that automatically maintains conversation history across turns. |
| `gemini::embed(text_or_list, opts?)` | — | Generate embedding vector(s) via `:embedContent` (default model `text-embedding-004`; supports `task_type is`, `dimensions is`). |
| `gemini::models(opts?)` | — | List available Gemini models (`GET /models`). |
| `gemini::status()` | — | Returns `{"configured" is bool, "default_model" is str, "base_url" is str}`. |

#### Unified `ai` Module & Stateful `ai::session`

- `ai::agy` and `ai::gemini` expose the `agy` and `gemini` sub-modules directly.
- `ai::prompt(prompt, opts?)` / `ai::ask` / `ai::complete` / `ai::stream(prompt, on_chunk?, opts?)` / `ai::chat` / `ai::session(provider?, opts?)` route to `provider is "agy"` or `provider is "gemini"` (defaulting to `"gemini"` when a Gemini API key is configured, otherwise `"agy"`).
- `ai::status()` returns `{"agy" is agy::status(), "gemini" is gemini::status()}`.
- **Session methods (`ai::session`)**: `s("Hello")` or `s:ask(prompt, opts?)` / `s:prompt(prompt, opts?)`, `s:complete(prompt, opts?)`, `s:history`, `s:provider`, `s:model`, `s:conversation_id`, `s:clear`.

```minilang
:> Prompt local agy (or stream tokens live into the cell!)
let summary := agy::stream("Summarize the files in this workspace", effort is "low")

:> Prompt Gemini with automatic Minilang tool calling
let answer := gemini::prompt(
    "What is 19 * 23?",
    tools is [
        {
            "name" is "multiply",
            "description" is "Multiply two numbers",
            "parameters" is {
                "type" is "object",
                "properties" is {"a" is {"type" is "number"}, "b" is {"type" is "number"}},
                "required" is ["a", "b"]
            },
            "fn" is fun(args) args["a"] * args["b"]
        }
    ]
)

:> Prompt Gemini with structured JSON output (reads GEMINI_API_KEY from Secrets Vault)
let items := gemini::prompt(
    "Return JSON: {\"languages\": [\"Minilang\", \"Rust\"]}",
    model is "gemini-2.5-flash",
    json is true
)

:> Multi-turn stateful chat session (works identically for agy::session and gemini::session)
let chat := gemini::session(system is "Answer in one short sentence.")
println(chat("What is SQLite?"))
println(chat:ask("How does it handle transactions?"))
```

### Environment Variables & Secrets (`env` Module & `secret`)

| Function | Description |
|---|---|
| `env::get(key, default?)` | Read process environment variable `key` (returns `default` or `nil` if unset). |
| `env::set(key, val)` | Set environment variable `key` to string `val` (passing `nil` unsets `key`). |
| `env::has(key)` | Returns `true` if environment variable `key` is set, `nil` otherwise. |
| `env::all()` | Returns a `map` of all current environment variables. |
| `secret(key, default?)` | Read an encrypted secret configured in the **Secrets Vault** (checks `MLNB_SECRET_<key>`, falling back to `<key>`, then `default` or `nil`). |

### Rich Outputs, Visualizations & Media Previews (`table`, `chart`, `progress`, `image`, `pdf`, `preview`)

Both notebooks and scripts can emit interactive tables, charts, progress bars, and media previews alongside return values and `stdout`:

| Helper | Description |
|---|---|
| `table(data, title?)` | Render an interactive **sortable, filterable, paginated table** with one-click CSV export. Accepts a list of maps, list of lists/tuples, key-value map, or list of scalars. See [notebooks/tables.mnb](notebooks/tables.mnb). |
| `chart(type, data, title?)` / `chart(spec_map)` | Render an interactive SVG chart with hover tooltips and legends. Supports `"line"`, `"area"`, `"bar"`, `"scatter"`, `"histogram"`, and `"pie"`, plus multi-series `spec_map`s (`type`, `title`, `data`, `x`, `y`, `labels`, `series`, `bins`, `colors`). See [notebooks/charts.mnb](notebooks/charts.mnb). |
| `progress(done, total, label?, id?)` | Emit a live streaming progress bar update in notebook cells and background jobs. |
| `html(str)` | Render raw HTML in cell output |
| `svg(str)` | Render inline SVG |
| `markdown(str)` | Render Markdown (with syntax highlighting, GFM tables, heading anchors, and auto image/PDF thumbnails) |
| `image(path_or_bytes, mime?)` | Display an image thumbnail preview from a file path or raw byte buffer (`address`). Auto-detects PNG/JPEG/GIF/WebP/SVG/BMP/AVIF. |
| `pdf(path_or_bytes)` | Display an interactive PDF thumbnail preview from a file path or raw byte buffer. |
| `preview(path_or_bytes)` | Auto-detect image vs. PDF from a file path or raw bytes and emit the appropriate thumbnail preview. |
| `display(mime, data)` | Emit an arbitrary MIME-typed display payload. |

Clicking any image or PDF thumbnail in a notebook output expands it in the **Media Lightbox** (with **Open in Tab** and **Download** buttons).

### Available Standard Modules & Helpers

Every `.mini` kernel initializes the full built-in Minilang runtime:

| Global / Module | Description |
|---|---|
| `print(...)`, `println(...)` | Writes formatted output to the captured `stdout` stream |
| `table`, `chart`, `progress` | Interactive tables, SVG charts, and live streaming progress bars |
| `html`, `svg`, `markdown`, `image`, `pdf`, `preview`, `display` | Rich display and media thumbnail helpers |
| `import`, `export`, `library` | Native Minilang module/library loader (`import("./mod")`, `string(import)` → current dir) |
| `store` | Atomic CBOR (`get`/`put`/`create`), raw bytes (`*_raw`/`*_bytes`), string (`*_string`/`*_text`), `exists`, `delete` |
| `http` | `http::get/post/put/patch/delete/request` via `libcurl.so.4` |
| `log` | First-class timestamped in-memory & crash-safe CBOR-framed persistent logs |
| `db` | Built-in SQLite3 database connections (`db::open`, `db::query`, `db::exec`, transactions, parameterized binds) |
| `jobs`, `sleep` | Background worker job launcher/controller (`jobs::start/list/status/wait/join/output/stop/clear`) & `sleep(secs)` |
| `service` | Persistent background services & real-time cross-UI pub/sub, direct messaging, and RPC (`service::start/recv/broadcast/send/reply/call/on`) |
| `ai`, `agy`, `gemini` | Prompt local `agy` CLI & Google Gemini REST API (`prompt`, `complete`, `chat`, stateful `session`, `gemini::embed`, `gemini::models`, `status`) |
| `env`, `secret` | Process environment variables (`env::get/set/has/all`) and encrypted Secrets Vault access (`secret(key)`) |
| `now()`, `clock()`, `time` | Current epoch time, high-resolution clock, ISO-8601 time parsing/formatting |
| `file`, `dir`, `popen`, `stream` | Filesystem & stream I/O (relative to the script's directory) |
| `socket` | TCP/UDP sockets |
| `json`, `cbor` | JSON and CBOR binary serialization |
| `uuid`, `base16`, `base64` | UUID generation/parsing, Hex and Base64 encoding/decoding |
| `logging` | Structured Minilang logger module |
| `minijs`, `ui`, `exec` | Browser UI widget constructors (`ui::table`, `ui::chart`, forms, layouts), `ui::compile`, `ui::show`, and `exec()` |
| `break`, `debugger`, `trace` | Interactive bytecode debugger hook (`break()` pauses in the Debugger drawer) and tracing utilities |
| `channel`, `semaphore`, `condition`, `rwlock` | Cooperative concurrency & synchronization primitives |
| `callcc`, `markcc`, `calldc`, `swapcc` | First-class & delimited continuations |
| `parser`, `compiler`, `macro`, `variable`, `global`, `globals` | Runtime parsing, compilation, macro, and global-scope inspection |
| `memory` | Boehm GC inspection (`memory::usage`, `memory::collect`, `memory::size`, `memory::dump`, etc.) |
| Core types & functions | `list`, `map`, `set`, `tuple`, `string`, `integer`, `real`, `boolean`, `regex`, `sum`, `min`, `max`, `count`, `range`, `zip`, `reduce`, `fold`, `unique`, etc. |

### Using `.mini` Scripts in the Web UI

When you open any `.mini` (or `.rs`) file from the left file browser sidebar, the editor toolbar provides:

- **Save (`Ctrl+S`)**: Saves changes to disk.
- **Params**: Opens a JSON parameter editor (supporting both plain and tagged JSON, with a **Detect** button that scans `Params["..."]` in `.mini` and `params.get_*("...")` in `.rs`) passed directly into **Run** and **Debug**.
- **Run in Minilang / Rust**: Executes the script immediately in a fresh kernel (with any configured **Params**) and renders `stdout`, `Out[N]`, interactive tables/charts, rich HTML/SVG/media, or live UI outputs below the editor.
- **Debug** (`.mini`): Launches the interactive bytecode debugger drawer with breakpoints, step over/into/out, call stack, live local variables, watch expressions, and **Params**.
- **Start Service** (`.mini`): Launches the script as a persistent background service managed under the **Services** tab.
- **Invoke (`/invoke`)**: Opens an interactive JSON tester panel wired directly to `POST /invoke/{script}`, complete with an optional function input, formatted JSON response viewer, and a **Copy curl** button.
- **Launch UI** (`.mini`/`.ui`): Opens `/ui/{script}` in a new browser tab.
- **Open as Notebook**: Converts the script into an interactive `.mnb` notebook tab. (Use `:> %%` or `# %%` in `.mini`, or `// %%` in `.rs`, to split a script into multiple cells automatically.)
- **✦ Ask agy (`Ctrl+K`)**: Opens the inline Google Antigravity assistant for the file or currently selected lines.

---

## 4. Rust Notebooks & `.rs` Scripts

Minilang Notebook includes a full **Rust** backend (`LanguageBackend`) alongside Minilang, supporting interactive Rust notebooks, external Cargo crates, and invocable `.rs` HTTP endpoints.

### Interactive Rust Notebooks

- Create a Rust notebook from **New Notebook** (choose **Rust** in the language kernel dropdown) or switch an existing notebook's kernel using the **Kernel** selector in the notebook toolbar.
- Each Rust cell is compiled with `rustc` (or `cargo` once dependencies are declared) and replayed seamlessly across cells while suppressing duplicate prior `stdout`.
- Top-level items (`fn`, `struct`, `enum`, `impl`, `use`, `const`, `type`) and `let` bindings persist across cells and appear in the **Variable Inspector** drawer.
- Autocompletion (`Tab`) suggests Rust keywords, prelude helpers, and your cell-defined symbols.
- **Rich display & runtime helpers** are automatically available in Rust cells and scripts:
  - `table(&str)`, `chart(&str)`, `progress(done, total, label)`
  - `html(&str)`, `svg(&str)`, `markdown(&str)`
  - `image(&str)`, `image_bytes(&[u8], &str)`
  - `pdf(&str)`, `pdf_bytes(&[u8])`
  - `preview(&str)`, `display(mime, data)`
  - `secret(&str) -> Option<String>`
  - `params` (`Params`), `args` (`Vec<Value>`), and `Value` constructors (including when running `.rs` files via **Params** + **Run in Rust**)

See [notebooks/rust_intro.mnb](notebooks/rust_intro.mnb) for a ready-to-run walkthrough.

### Specifying Cargo Dependencies

Both **Rust notebook cells** and **`.rs` scripts** support specifying Cargo crates using any of three syntaxes:

#### 1. Evcxr-style `:dep` Directives (Notebook Cells & Scripts)

```rust
:dep serde_json = "1.0"
//:dep chrono = { version = "0.4", features = ["serde"] }
//! :dep mylib = { path = "../crates/mylib" }

let v = serde_json::json!({ "ok": true, "items": [1, 2, 3] });
v
```

Run `:deps` alone in a Rust notebook cell to print all currently loaded Cargo dependencies for that kernel.

#### 2. Cargo Script Frontmatter (`---cargo`)

```rust
---cargo
[dependencies]
serde = { version = "1.0", features = ["derive"] }
uuid = { version = "1", features = ["v4"] }
---

let id = uuid::Uuid::new_v4();
id.to_string()
```

#### 3. Doc-Comment Fenced Block (`//! ```cargo`)

```rust
//! ```cargo
//! [dependencies]
//! rand = "0.8"
//! ```

let x: u8 = rand::random();
x
```

**How builds & caching work:**
- Relative `path = "..."` crate dependencies are automatically resolved against the script or notebook directory.
- Cargo shares a single persistent target directory (`/tmp/minilang-notebook-rust-cache/cargo-target`) across cells and scripts so incremental builds stay fast.
- Builds run with `cargo build --offline` first (zero network overhead for cached crates), and automatically retry online if a crate isn't cached yet. Set `MINILANG_RUST_OFFLINE=1` to strictly stay offline.

### Invocable `.rs` Scripts

Any `.rs` file in your workspace can be invoked via `POST /invoke/{path}` using the exact same Tagged JSON protocol as `.mini` scripts:

- Compiled binaries are **content-hashed** (source + Cargo dependencies) and cached on disk so repeated `/invoke` calls skip compilation and run in a few milliseconds.
- Inside a `.rs` script, `params` (`ParamMap`), `args` (`Vec<Value>`), and `Value` constructors (`Value::map`, `Value::list`, `Value::string`, `Value::int`, `Value::real`, `Value::bool`, `Value::nil`, `Value::bytes`, etc.) are injected automatically:
  ```rust
  let name = params.get_str("name").unwrap_or("World");
  let repeat = params.get_int("repeat").unwrap_or(1);
  Value::map([
      ("greeting", Value::string(format!("Hello from Rust, {}!", name))),
      ("count", Value::int(repeat)),
  ])
  ```
- You can also call a specific typed Rust function via `"function"` (see [scripts/fib.rs](scripts/fib.rs) and [scripts/hello.rs](scripts/hello.rs)).

---

## 5. The `/invoke` HTTP Endpoint & Tagged JSON Format

### Endpoints & Path Resolution

| Method & Path | Description |
|---|---|
| `POST /invoke` | Invoke a `.mini` or `.rs` script specified in the JSON body's `"script"` field |
| `POST /invoke/{path}` | Invoke a `.mini` or `.rs` script specified in the URL path |
| `GET /api/scripts` | List all invocable `.mini` and `.rs` scripts in the workspace (prioritizing `scripts/`) |

Path resolution rules for `{path}` (or `"script"`):

1. If `{path}` ends with `.mini` or `.rs`, the server checks `{path}`, then `scripts/{path}`.
2. If `{path}` has no extension (e.g., `POST /invoke/greet` or `POST /invoke/hello`), the server checks `{path}.mini`, `scripts/{path}.mini`, `{path}.rs`, and `scripts/{path}.rs`.
3. Any other file extension (e.g. `Cargo.toml`) is rejected with `400 Bad Request`.
4. Paths escaping the workspace root (`..`) are rejected with `404 Not Found`.

### Request Schema

```json
{
  "script": "scripts/greet.mini",
  "params": {
    "name": { "type": "string", "value": "Ada" },
    "repeat": { "type": "integer", "value": 2 },
    "excited": { "type": "boolean", "value": true }
  },
  "args": [
    { "type": "real", "value": 0.5 }
  ],
  "function": null,
  "timeout_ms": 30000
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `script` | Required for `POST /invoke`; omitted for `POST /invoke/{path}` | — | Path to `.mini` or `.rs` script |
| `params` | No | `{}` | Object mapping parameter names to Tagged JSON values |
| `args` | No | `[]` | Array of positional Tagged JSON values (`Args` in Minilang / `args` in Rust) |
| `function` | No | `null` | Optional function name in the script to invoke after loading |
| `timeout_ms` | No | `30000` | Execution timeout in ms (clamped to `100`–`120000`) |

An empty request body on `POST /invoke/{path}` is valid and runs the script with empty `params` and `args`.

### Response Schema & Status Codes

**Success (`200 OK`)**:

```json
{
  "ok": true,
  "script": "scripts/greet.mini",
  "result": {
    "type": "map",
    "value": {
      "count": { "type": "integer", "value": 2 },
      "greeting": { "type": "string", "value": "Hello, Ada!" },
      "lines": {
        "type": "list",
        "value": [
          { "type": "string", "value": "[1] Hello, Ada!" },
          { "type": "string", "value": "[2] Hello, Ada!" }
        ]
      },
      "timestamp": { "type": "integer", "value": 1795324200 }
    }
  },
  "type_name": "map",
  "repr": "{greeting is Hello, Ada!, count is 2, ...}",
  "stdout": "[1] Hello, Ada!\n[2] Hello, Ada!\n",
  "displays": [],
  "error": null,
  "duration_ms": 0.41
}
```

**HTTP Status Codes**:

| Status | Meaning |
|---|---|
| `200 OK` | Script executed cleanly (`ok: true`) |
| `400 Bad Request` | Malformed JSON, invalid/unsupported tagged type, missing `script`, or unsupported extension |
| `401 Unauthorized` / `403 Forbidden` | Missing, expired, or unauthorized Bearer token (when `--require-login` / `--require-group` is enabled) |
| `404 Not Found` | Script does not exist (or path traversal attempt) |
| `408 Request Timeout` | Script exceeded `timeout_ms` (subprocess killed) |
| `422 Unprocessable Entity` | Parse, compile, parameter, or runtime error (`ok: false`, details in `error`) |
| `500 Internal Server Error` | Kernel crashed or exited abnormally before returning |

### Tagged JSON Type Reference

Every parameter value and return value uses the adjacently-tagged JSON shape `{ "type": "<tag>", "value": <payload> }`:

| Tag (`type`) | Accepted Aliases | `value` Payload | Example | Minilang Type |
|---|---|---|---|---|
| `nil` | `null` | *(omitted or `null`)* | `{"type": "nil"}` | `nil` |
| `boolean` | `bool` | JSON boolean | `{"type": "boolean", "value": true}` | `boolean` |
| `integer` | `int` | 64-bit JSON integer | `{"type": "integer", "value": 42}` | `integer` |
| `real` | `float`, `double` | JSON number | `{"type": "real", "value": 3.14}` | `real` |
| `string` | `str` | JSON string | `{"type": "string", "value": "hi"}` | `string` |
| `symbol` | `method` | JSON string | `{"type": "symbol", "value": "length"}` | `method` (`:length`) |
| `list` | — | Array of Tagged JSON | `{"type": "list", "value": [{"type": "integer", "value": 1}]}` | `list` |
| `tuple` | — | Array of Tagged JSON | `{"type": "tuple", "value": [{"type": "integer", "value": 1}, {"type": "string", "value": "a"}]}` | `tuple` |
| `set` | — | Array of Tagged JSON | `{"type": "set", "value": [{"type": "string", "value": "x"}]}` | `set` |
| `map` | — | Object `{k: Tagged}` **or** `[[keyTagged, valTagged], ...]` | `{"type": "map", "value": {"k": {"type": "integer", "value": 1}}}` | `map` |
| `time` | — | ISO-8601 string or Unix epoch number | `{"type": "time", "value": "2026-11-23T00:00:00Z"}` | `time` |
| `uuid` | — | UUID string | `{"type": "uuid", "value": "550e8400-e29b-41d4-a716-446655440000"}` | `uuid` |
| `bytes` | — | Base64 string | `{"type": "bytes", "value": "aGVsbG8="}` | `address` (raw bytes) |

> **Non-string map keys**: Minilang maps support arbitrary keys (integers, symbols, tuples, etc.). Pass them as an array of `[key, value]` tagged pairs:
> ```json
> {
>   "type": "map",
>   "value": [
>     [{ "type": "integer", "value": 1 }, { "type": "string", "value": "one" }],
>     [{ "type": "integer", "value": 2 }, { "type": "string", "value": "two" }]
>   ]
> }
> ```
> When a Minilang map returned by a script has all-string keys, it serializes as a JSON object; if any key is non-string, it automatically serializes as a `[key, value]` pair array.

> **UTC Timestamps**: `time` values returned from scripts are always serialized as canonical UTC ISO-8601 strings ending in `Z`.

### Calling Specific Functions in a Script

Set `"function"` in the request body to call a specific function defined in a `.mini` or `.rs` script after the script's top-level definitions load:

- If `args` is non-empty, the function is called with `args` unpacked positionally (`fn(arg1, arg2, ...)`).
- If `args` is empty and `params` is non-empty, Minilang calls `fn(Params)` and Rust matches parameter names (or passes `params`).
- If both are empty, the function is called with 0 arguments (`fn()`).

```bash
# Minilang function call
curl -s -X POST http://127.0.0.1:8888/invoke/scripts/stats.mini \
  -H "Content-Type: application/json" \
  -d '{
    "function": "scale",
    "params": {
      "values": {
        "type": "list",
        "value": [
          { "type": "real", "value": 10.0 },
          { "type": "real", "value": 20.0 }
        ]
      }
    },
    "args": [{ "type": "real", "value": 0.5 }]
  }'

# Rust function call
curl -s -X POST http://127.0.0.1:8888/invoke/scripts/fib.rs \
  -H "Content-Type: application/json" \
  -d '{ "function": "fib", "args": [{ "type": "integer", "value": 20 }] }'
```

### Timeouts, Isolation & Security

- Each invocation runs in its own OS process and is killed cleanly on completion or timeout.
- Infinite loops (e.g. `loop end`) are terminated cleanly at `timeout_ms` and return HTTP `408`.
- Only `.mini` and `.rs` files inside `--root` can be invoked.

---

## 6. Writing `.ui` Files (Custom Minilang User Interfaces)

`.ui` files let you build complete interactive web interfaces in pure Minilang — including forms, layout containers, raw HTML views, reactive local state, and asynchronous calls to `.mini` or `.rs` backend scripts via `exec()`.

### How `.ui` Files Work (MiniJS Bytecode Compilation)

Minilang UIs are powered by Minilang's built-in **`minijs`** serializer (`ml_minijs.c`) paired with a browser-side **MiniJS Bytecode VM** (`/minijs_vm.js`):

1. When you call `ui::compile(...)` or `ui::show(...)`, Minilang encodes your widget tree **and** every Minilang event-handler closure (bytecode instructions, upvalues, captured mutable `var` boxes, and shared widget references) into a compact JSON bundle (`"format": "minilang-ui"`).
2. Because `minijs` tracks shared references by index, a widget captured inside a button's `on_click` closure points to the **exact same live widget object** rendered in the DOM tree — and a `var count := 0` captured by two different buttons shares the **exact same mutable variable**!
3. The browser's `MinijsUI` runtime decodes the bundle, renders real interactive DOM elements, and executes your Minilang bytecode closures directly in the browser whenever the user clicks buttons, types into inputs, drags sliders, or receives results from `exec()`.

### Serving `.ui` Files from `/ui/{path}`

Any `.ui` file in your workspace can be opened directly in a browser as a standalone web app:

| URL | Resolution |
|---|---|
| `GET /ui/uis/greeter.ui` | Serves `uis/greeter.ui` |
| `GET /ui/greeter.ui` | Checks `greeter.ui`, then falls back to `uis/greeter.ui` |
| `GET /ui/greeter` | Checks `greeter.ui`, `uis/greeter.ui`, `greeter.mini`, `scripts/greeter.mini` |
| `GET /ui/notebooks/my_tool.ui` | Serves `notebooks/my_tool.ui` |
| `GET /api/uis` | Returns JSON list of all `.ui` files in the workspace |

You can also create new `.ui` files from the **New Minilang UI (`.ui`)** button (or the file explorer right-click menu), preview them inline with **Preview UI**, or open them in a dedicated tab with **Launch UI**.

### Two Authoring Styles: Direct `ui::show` vs `ui::compile`

#### Style A — Declarative Widget Tree + `ui::show(widget)` (Recommended for most `.ui` files & cells)

Build widgets at top level, wire up callbacks, and call `ui::show(root)`. `ui::show` compiles the widget tree and all attached closures automatically via `minijs`:

```minilang
var count := 0
let label := ui::html('<span>Count: <strong>0</strong></span>')

let inc := ui::button("+1";) do
    count := count + 1
    label:set_html('<span>Count: <strong>{count}</strong></span>')
end

ui::show(ui::card("Counter", ui::hbox(label, inc)))
```

#### Style B — Explicit `ui::compile(fn_or_widget)`

Use `ui::compile(...)` when you want to compile an entire UI-building closure (whose body runs inside the browser VM) or obtain the compiled `ui::compiled` object (for inspection or saving to disk):

```minilang
let compiled := ui::compile(fun() do
    let inp := ui::input("Type something...", "")
    let preview := ui::text("")
    inp:on_input(fun(val) do
        preview:set_text('Length: {val:length}')
    end)
    ui::show(ui::vbox(inp, preview))
end)

:> Inspect the compiled MiniJS JSON string if desired:
:> println(compiled:json)

:> Display it:
ui::show(compiled)
```

`ui::compile` accepts either a `ui::widget` or a `function`. Inside a compiled function, `ui::show(widget)` mounts the widget into the page (and if the function returns a `ui::widget` without calling `ui::show`, it is mounted automatically).

### Pre-Compiled `.ui` Files

You can save the JSON output of `ui::compile(...):json` directly to a `.ui` file:

```minilang
let app := ui::compile(my_widget)
store::put_string("uis/prebuilt.ui", app:json)
```

When `GET /ui/uis/prebuilt.ui` is requested, the server detects `"format": "minilang-ui"` and serves the pre-compiled MiniJS bundle immediately without spawning a Minilang kernel process.

---

## 7. Complete `ui` Widget Reference

All widget constructors accept optional named properties (e.g. `gap := 12`, `variant := "danger"`, `on_click := fn`) using Minilang's named-argument syntax.

### Container Widgets

| Constructor | Aliases | Signature & Behavior |
|---|---|---|
| `ui::vbox(...)` | `ui::column(...)` | Vertical flex stack of child widgets |
| `ui::hbox(...)` | `ui::row(...)` | Horizontal flex row (wraps on narrow viewports) |
| `ui::grid(...)` | — | CSS grid container: `ui::grid(cols, child1, child2, ...)` or `ui::grid(..., columns := 3)` |
| `ui::card(...)` | — | Styled card with optional header title: `ui::card("Title", child1, ...)` |
| `ui::panel(...)` | `ui::box(...)` | Bordered padded container box |
| `ui::form(...)` | — | HTML `<form>` container (prevents page reload; trailing closure or `on_submit` handles submission) |
| `ui::tabs(map)` | — | Tabbed container from a map of `{"Tab Title" is widget, ...}` |

> Container constructors accept individual child widgets, lists of widgets (automatically flattened), plain strings (wrapped in `ui::text`), or an options `map`.

### Form Element Widgets

| Constructor | Aliases | Signature | `:value` Return Type |
|---|---|---|---|
| `ui::input(placeholder?, value?, on_input?)` | `ui::text_input` | Single-line text input | `string` |
| `ui::password(placeholder?, value?)` | — | Masked password input | `string` |
| `ui::textarea(placeholder?, value?, rows?)` | — | Multi-line text area | `string` |
| `ui::number(value?, min?, max?, step?)` | — | Numeric input | `integer` or `real` |
| `ui::slider(value?, min?, max?, step?, on_input?)` | `ui::range` | Range slider with live value readout | `integer` or `real` |
| `ui::checkbox(label?, checked?, on_change?)` | — | Checkbox with inline label | `boolean` (`true`/`false`) |
| `ui::select(options, value?, on_change?)` | — | Dropdown menu (`options`: `list` of strings, `list` of `(val, label)` tuples, or `map`) | `string` |
| `ui::radio(options, value?, on_change?)` | — | Radio button group (`options`: `list` of strings) | `string` |
| `ui::date(value?)` | — | Date picker (`"YYYY-MM-DD"`) | `string` |
| `ui::color(value?)` | — | Color picker (`"#7aa2f7"`) | `string` |
| `ui::button(label, on_click?)` | — | Clickable button (`variant := "primary" \| "secondary" \| "danger"`) | — |

### Display & Raw HTML Widgets (`ui::html`)

| Constructor | Aliases | Signature & Behavior |
|---|---|---|
| `ui::html(raw_html)` | — | Renders arbitrary raw HTML inside a `<div>`; update live with `:set_html(new_html)` |
| `ui::heading(text, level?)` | — | Heading `<h1>`–`<h4>` (default `level = 2`) |
| `ui::label(text, child?)` | — | Form `<label>` (optionally wrapping a control widget) |
| `ui::text(text)` | — | Plain text block (`:set_text(s)` escapes HTML safely) |
| `ui::badge(text, variant?)` | — | Status pill (`variant`: `"info"`, `"success"`, `"warning"`, `"danger"`) |
| `ui::code(text)` | `ui::pre` | Monospace `<pre>` block (`:set_text(s)`) |
| `ui::table(data, title?)` | — | Interactive sortable/filterable/paginated table widget with CSV export; update live with `:set_data(new_data)` |
| `ui::chart(spec, title?)` | — | Interactive SVG chart widget (`line`, `area`, `bar`, `scatter`, `histogram`, `pie`); update live with `:set_spec(new_spec)` |
| `ui::divider()` | — | Horizontal divider `<hr>` |

### Widget Methods

These methods work both while constructing widgets and live inside browser event callbacks:

| Method | Description |
|---|---|
| `w:value` / `w:get_value` | Read current value of a form control (`string`, `integer`/`real`, or `boolean`) |
| `w:set_value(v)` | Update a form control's value in the live DOM |
| `w:text` / `w:set_text(s)` | Get or set plain `textContent` (safe against HTML injection) |
| `w:html` / `w:set_html(h)` | Get or set `innerHTML` (ideal with `ui::html(...)`) |
| `w:set_data(data)` | Replace and re-render the dataset of a live `ui::table` widget |
| `w:set_spec(spec)` | Replace and re-render the chart specification of a live `ui::chart` widget |
| `w:append(child)` / `w:add(child)` | Append a child widget (or string) to a container dynamically |
| `w:clear()` | Remove all child widgets/content from a container |
| `w:set_disabled(bool)` | Enable or disable a form element or button |
| `w:set_visible(bool)` | Show or hide a widget (`display: none`) |
| `w:set_style(prop, val)` / `w:set_style(map)` | Set inline CSS style property/properties (e.g. `w:set_style("color", "#4ade80")`) |
| `w:on(event, fn)` | Attach a Minilang closure to any DOM event (`"click"`, `"input"`, `"change"`, `"submit"`, `"mount"`) |
| `w:on_click(fn)` / `w:on_input(fn)` / `w:on_change(fn)` / `w:on_submit(fn)` | Shorthand event binder methods (plus `on_mount := fn` prop fired when the widget mounts) |
| `w:show` | Equivalent to `ui::show(w)` |

### Common Styling & Layout Props

Pass these as named arguments or in a props map to any widget:

- `gap := 16` (or `gap := "1rem"`) — flex/grid gap
- `padding := 16` — inner padding
- `width := "100%"` (or `width := 320`) — widget width
- `class := "my-class"` — extra CSS class(es)
- `style := "border: 1px dashed #7aa2f7"` — raw CSS style string
- `styles := {"background" is "#1e293b"}` — CSS property map
- `visible := false` — initially hidden
- `disabled := true` — initially disabled
- `variant := "primary" | "secondary" | "danger"` — button styling (`"info" | "success" | "warning" | "danger"` for `ui::badge`)

### Event Handling & Reactive State

- **`on_click` / `on_submit`** callbacks receive `(widget)`.
- **`on_input` / `on_change`** callbacks receive `(new_value, widget)`.
- Mutable `var` variables defined outside callbacks are automatically shared across all callbacks that capture them:

```minilang
var total := 0
let out := ui::text("Total: 0")
let slider := ui::slider(10, 1, 50, 1; val) do
    out:set_text('Slider is at {val} (total: {total})')
end
let add_btn := ui::button("Add Slider to Total";) do
    total := total + slider:value
    out:set_text('Total is now {total}')
end
ui::show(ui::vbox(slider, add_btn, out))
```

---

## 8. Calling Scripts from `.ui` Files with `exec()`

`exec()` bridges your browser-side `.ui` interface to any server-side **`.mini` or `.rs`** script via `POST /invoke/{script}`.

### Signatures

```minilang
:> 1. No parameters
exec("scripts/greet.mini"; res, err, meta) do
    ...
end

:> 2. Named parameters map (works with .mini or .rs!)
exec("scripts/hello.rs", {
    "name" is name_inp:value,
    "repeat" is 3,
    "excited" is true
}; res, err, meta) do
    ...
end

:> 3. Named parameters + options map (`function` and/or `args`)
exec("scripts/stats.mini", {"values" is [10.0, 20.0]}, {
    "function" is "scale",
    "args" is [2.5]
}; res, err, meta) do
    ...
end

:> 4. Named parameters + named keyword options
exec("scripts/stats.mini", {"values" is [10.0, 20.0]}, function := "scale", args := [2.5]; res, err) do
    ...
end
```

### Callback Arguments (`result`, `err`, `meta`)

Your callback is invoked asynchronously once `/invoke` completes:

| Argument | On Success | On Error |
|---|---|---|
| `result` | Decoded native Minilang value (`map`, `list`, `integer`, `string`, etc.) | `nil` |
| `err` | `nil` | Error message `string` (truthy, so `if err then ... else ... end` works cleanly) |
| `meta` | `map` with `"stdout"`, `"duration_ms"`, `"type_name"`, `"repr"` | `map` with `"status"` (HTTP status code) |

### Automatic Tagged JSON Marshaling

You **never** need to hand-construct `{"type": "integer", "value": ...}` inside `.ui` files when using `exec()`:

- `exec()` automatically converts all Minilang values in `params` and `args` (`string`, `integer`, `real`, `boolean`, `nil`, `list`, `tuple`, `set`, `map`, `symbol`, `time`, `uuid`, `bytes`) into the server's tagged JSON format.
- When the server responds, `exec()` automatically converts the tagged JSON `result` back into native Minilang values so you can immediately write `res["greeting"]`, `res["count"] + 1`, `list(res["lines"]; l) ...`, etc.
- When authentication is enabled, `exec()` automatically includes the user's Bearer access token.

---

## 9. Workspace Viewers, File Explorer & Inline `agy` Assistant

### File Explorer & Right-Click Context Menu

Right-click any **file**, **folder**, or **empty space** in the left file explorer sidebar to open the context menu:

- **On a file**: Open, Launch UI (`.ui`), Open as Notebook (`.mini`/`.rs`), **Cut**, **Copy**, **Paste**, **Duplicate**, **Copy Relative Path**, **Copy Absolute Path**, **Copy File Name**, **Download**, **Rename**, and **Delete**.
- **On a folder**: Open Folder, New Notebook / File / UI / Folder Here, **Cut**, **Copy**, **Paste into Folder**, **Duplicate**, **Copy Relative Path**, **Copy Absolute Path**, **Copy Name**, **Rename**, and **Delete**.
- **On empty space**: New Notebook / File / UI / Folder, **Paste**, **Copy Folder Path**, **Copy Absolute Path**, and **Refresh**.

Details:
- **Copy & Paste** (`POST /api/file/copy`) recursively copies directories as well as single files, automatically resolves name collisions (`foo.mini` → `foo copy.mini`, `foo copy 2.mini`), and rejects copying or moving a directory into itself or outside the workspace root.
- **Cut & Paste** dims the cut item in the sidebar, moves it on paste, and keeps any open tabs synchronized with the new path.

### Image & PDF Viewer Tabs & Lightbox

- Clicking any image (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`, `.ico`, `.avif`) or `.pdf` in the file explorer opens it in a dedicated viewer tab with **Zoom In/Out**, **Fit**, **100%**, **Rotate** (images), and **Download** controls.
- Files are streamed efficiently via `GET /api/file/raw?path=<rel>&download=1` (with proper `Content-Type` and authentication support).
- In notebooks, `image()`, `pdf()`, `preview()`, and Markdown image/PDF links render compact **thumbnail previews** that expand into the **Media Lightbox** on click.

### Log File Viewer (`MLOG` & Plain-Text `.log`)

Opening any `.log` / `.mlog` file (or any binary file starting with the `MLOG` header created by Minilang's `log(path)`) opens the dedicated **Log Viewer** tab (backed by `GET /api/log`):

- **Binary `MLOG` logs**: Displays nanosecond timestamps, Minilang value types (`map`, `list`, `string`, `integer`, etc.), detected severity badges (`INFO`, `WARN`, `ERROR`, `DEBUG`), and expandable structured JSON/value previews.
- **Plain-text `.log` files**: Parses lines with timestamp & log-level highlighting.
- **Controls**: Full-text search filter, type filter dropdown, newest-first / oldest-first toggle, pagination, and a **Live Tail** mode that polls for newly appended entries.

### Markdown Document Viewer

Opening any `.md` or `.markdown` file opens the **Markdown Viewer** tab with three switchable modes:

- **Preview**: Rendered document with GitHub-Flavored Markdown tables, task lists, Minilang & Rust syntax-highlighted code blocks, clickable workspace links, and automatic inline thumbnails for linked images/PDFs.
- **Split**: Side-by-side live editor and synchronized preview.
- **Edit**: Distraction-free source editing with `Ctrl+S` save.

### Inline Google Antigravity (`agy`) Assistant

When the Google Antigravity CLI (`agy`) is installed on the host machine (auto-detected from `PATH`, `~/.local/bin/agy`, `~/bin/agy`, `MINILANG_AGY_BIN`, or `--agy-bin`), inline AI help is available directly inside both notebook cells and script editors:

- **In Notebook Cells**:
  - Click **`✦ agy`** on any cell (or press **`Ctrl+K`** while focused in a cell) to open an inline prompt bar with quick actions (**Explain**, **Optimize**, **Refactor**, **Fix**).
  - When a cell raises an error, a **`✦ Fix with agy`** button appears directly on the error output and automatically sends the cell code, surrounding context cells, `stdout`, and traceback.
  - Suggested code blocks can be applied with one click (**Replace Cell**, **Insert Cell Below**, or **Copy**).
- **In Script Files (`.mini`, `.rs`, `.ui`, etc.)**:
  - Click **`✦ Ask agy`** in the file toolbar (or press **`Ctrl+K`**). If you have text highlighted, `agy` receives your exact selection along with the surrounding file context and lets you **Replace Selection**, **Replace File**, or **Append**.
- **Conversation & Control**:
  - Multi-turn follow-ups preserve conversation state per cell/tab (`conversation_id`).
  - In-flight requests can be cancelled immediately (`POST /api/agy/cancel`).
  - REST endpoints: `GET /api/agy/status`, `POST /api/agy/assist`, `POST /api/agy/cancel`.

---

## 10. Local Machine Authentication (PAM + Refreshable Tokens)

### Enabling Login & Unix Group Restrictions

By default, authentication is disabled for local single-user use. To require local Unix credentials (verified via `libpam.so.0` + POSIX NSS group checks):

```bash
# Require any valid local Unix account
minilang-notebook --host 0.0.0.0 --port 8888 --require-login

# Restrict access to members of the `devs` Unix group
minilang-notebook --host 0.0.0.0 --port 8888 --require-group devs \
  --pam-service login \
  --access-token-ttl 900 \
  --refresh-token-ttl 604800
```

Set `--auth-secret` (or `MINILANG_AUTH_SECRET`) if you want issued access tokens to remain valid across server restarts.

### Token Lifecycle & API Endpoints

- **Access tokens**: Short-lived HS256 JWTs (`Authorization: Bearer <access_token>`).
- **Refresh tokens**: Opaque rotating tokens stored hashed (SHA-256) on the server with **token-family replay revocation** (reusing an already-rotated refresh token automatically revokes the entire session family).
- The Web UI handles sign-in, automatic background token rotation before expiry, and `/ui/{path}` login redirects seamlessly.

| Endpoint | Auth Required | Purpose |
|---|---|---|
| `GET /api/auth/status` | No | Check if auth is enabled, required group, and current session user |
| `POST /api/auth/login` | No | Authenticate `{ "username": "...", "password": "..." }` → `{ access_token, refresh_token, expires_in, user }` |
| `POST /api/auth/refresh` | No | Rotate `{ "refresh_token": "..." }` → fresh access & refresh token pair |
| `POST /api/auth/logout` | No | Revoke the provided `{ "refresh_token": "..." }` |
| `GET /api/auth/me` | Yes | Return authenticated user info (`username`, `uid`, `groups`) |
| `POST /api/auth/logout-all` | Yes | Revoke all active refresh token sessions for the current user |

### Using Authenticated Requests with `curl`

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:8888/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"..."}' | jq -r .access_token)

curl -s -X POST http://127.0.0.1:8888/invoke/greet \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"params":{"name":{"type":"string","value":"Alice"}}}'
```

---

## 11. End-to-End Cookbook Examples

### Example 1: Parameterized API Script (`scripts/greet.mini`)

```minilang
let who := Params["name"] or "World"
let times := Params["repeat"] or 1
let bang := if Params["excited"] = true then "!" else "." end

let lines := []
for i in 1 .. times do
    let msg := '[{i}] Hello, {who}{bang}'
    println(msg)
    lines:put(msg)
end

{
    "greeting" is 'Hello, {who}{bang}',
    "count" is times,
    "lines" is lines,
    "timestamp" is now()
}
```

Call via `curl`:

```bash
curl -s -X POST http://127.0.0.1:8888/invoke/greet \
  -H "Content-Type: application/json" \
  -d '{
    "params": {
      "name":    { "type": "string",  "value": "Minilang" },
      "repeat":  { "type": "integer", "value": 3 },
      "excited": { "type": "boolean", "value": true }
    }
  }'
```

### Example 2: Multi-Function Data Script (`scripts/stats.mini`)

```minilang
let vals := Params["values"] or []
let name := Params["label"] or "series"

fun scale(factor) do
    ret list(vals -> fun(x) x * factor)
end

if vals:count = 0 then
    { "label" is name, "count" is 0, "sum" is 0, "mean" is nil }
else
    var total := 0.0
    var lo := vals[1]
    var hi := vals[1]
    for v in vals do
        total := total + v
        if v < lo then lo := v end
        if v > hi then hi := v end
    end
    {
        "label" is name,
        "count" is vals:count,
        "sum" is total,
        "mean" is total / vals:count,
        "min" is lo,
        "max" is hi
    }
end
```

### Example 3: Interactive Form UI (`uis/greeter.ui`)

Served at `http://127.0.0.1:8888/ui/uis/greeter.ui` (or `/ui/greeter`):

```minilang
let name_inp := ui::input("Enter a name...", "Minilang")
let repeat_num := ui::number(3, 1, 10, 1)
let excited_cb := ui::checkbox("Add exclamation mark!", true)
let result_view := ui::html("<em>Fill out the form and click Greet.</em>")

let greet_btn := ui::button("Greet!";) do
    result_view:set_html("<em>Calling scripts/greet.mini...</em>")
    exec("scripts/greet.mini", {
        "name" is name_inp:value,
        "repeat" is repeat_num:value,
        "excited" is excited_cb:value
    }; res, err) do
        if err then
            result_view:set_html('<div class="mlui-error-banner">{err}</div>')
        else
            let items := list(res["lines"]; line) '<li>{line}</li>'
            result_view:set_html('<strong>{res["greeting"]}</strong><ul>{items:join}</ul>')
        end
    end
end

ui::show(ui::card("Minilang Greeter UI",
    ui::vbox(
        ui::hbox(ui::label("Name:"), name_inp),
        ui::hbox(ui::label("Repeat:"), repeat_num),
        excited_cb,
        greet_btn,
        ui::divider(),
        result_view
    )
))
```

### Example 4: Tabbed Dashboard Calling Multiple Modes (`uis/stats.ui`)

Served at `http://127.0.0.1:8888/ui/uis/stats.ui` (or `/ui/stats`):

```minilang
let nums_inp := ui::input("Comma-separated numbers", "12.5, 18.0, 9.5, 24.0, 16.0")
let label_inp := ui::input("Series label", "latency_ms")
let scale_slider := ui::slider(2, 1, 10, 1)

let summary_out := ui::html("<em>Click Compute Statistics.</em>")
let scaled_out := ui::html("<em>Click Scale Values.</em>")

let compute_btn := ui::button("Compute Statistics";) do
    let parsed := list(nums_inp:value:split(","); s) real(s:trim)
    exec("scripts/stats.mini", {"label" is label_inp:value, "values" is parsed}; res, err) do
        if err then
            summary_out:set_html('<div class="mlui-error-banner">{err}</div>')
        else
            summary_out:set_html(
                '<table><thead><tr><th>Label</th><th>Count</th><th>Sum</th><th>Mean</th><th>Min</th><th>Max</th></tr></thead>' +
                '<tbody><tr><td>{res["label"]}</td><td>{res["count"]}</td><td>{res["sum"]}</td><td>{res["mean"]}</td><td>{res["min"]}</td><td>{res["max"]}</td></tr></tbody></table>'
            )
        end
    end
end

let scale_btn := ui::button("Scale Values";) do
    let parsed := list(nums_inp:value:split(","); s) real(s:trim)
    exec("scripts/stats.mini", {"values" is parsed}, {"function" is "scale", "args" is [scale_slider:value]}; res, err) do
        if err then
            scaled_out:set_html('<div class="mlui-error-banner">{err}</div>')
        else
            scaled_out:set_html('<strong>Scaled ({scale_slider:value}x):</strong> <code>{res}</code>')
        end
    end
end

ui::show(ui::card("Minilang Stats Dashboard",
    ui::vbox(
        ui::hbox(ui::label("Label:"), label_inp),
        ui::hbox(ui::label("Numbers:"), nums_inp),
        ui::tabs({
            "Summary" is ui::vbox(compute_btn, summary_out),
            "Scale" is ui::vbox(ui::hbox(ui::label("Factor:"), scale_slider), scale_btn, scaled_out)
        })
    )
))
```

### Example 5: Dynamic List Builder with Raw HTML & Local State

```minilang
let task_inp := ui::input("Add a task...", "")
let list_box := ui::vbox()
let status := ui::badge("0 tasks", "info")
var task_count := 0

let add_task := fun() do
    let text := task_inp:value:trim
    if text:length = 0 then ret nil end
    task_count := task_count + 1
    status:set_text('{task_count} task(s)')
    let row := ui::hbox(
        ui::checkbox(text, false),
        ui::html('<span style="color:var(--text-muted);font-size:12px">#{task_count}</span>')
    )
    list_box:append(row)
    task_inp:set_value("")
end

let form := ui::form(
    ui::hbox(task_inp, ui::button("Add", add_task), status),
    add_task
)

ui::show(ui::card("Todo List", ui::vbox(form, ui::divider(), list_box)))
```

### Example 6: Cached HTTP Pipeline with `store`, `http`, and `log`

```minilang
let audit := log('{import}/sync.log')

let payload := store::create('{import}/users.cbor'; cache_path) do
    audit({"level" is "info", "event" is "cache_miss", "path" is cache_path})
    http::get("https://jsonplaceholder.typicode.com/users", "json")
end

audit({"level" is "info", "event" is "loaded", "count" is payload:count})
audit:close

{ "users" is payload:count }
```

### Example 7: Reusable Minilang Module (`import` / `export`)

`scripts/math.mini`:
```minilang
export: let VERSION := "1.0"
export: fun square(X) X * X
```

`scripts/test.mini` (or a notebook cell):
```minilang
import: math("./math")
println('Using math v{math::VERSION} from {import}')
math::square(5)   :> 25
```

### Example 8: Invocable Rust Script with Cargo Dependencies

`scripts/json_summary.rs`:
```rust
:dep serde_json = "1.0"

let label = params.get_str("label").unwrap_or("demo");
let count = params.get_int("count").unwrap_or(3);

let obj = serde_json::json!({
    "label": label,
    "squares": (1..=count).map(|n| n * n).collect::<Vec<_>>(),
});

Value::string(obj.to_string())
```

Invoke via `POST /invoke/json_summary` (or call from a `.ui` file with `exec("scripts/json_summary.rs", ...)`).

---

## 12. Troubleshooting & Gotchas

| Issue | Cause & Fix |
|---|---|
| `if flag then ...` always takes the `then` branch even when `flag` is `false` | In Minilang, **only `nil` is falsy**. Use `if flag = true then ... else ... end`. |
| `ValueError: foo is uninitialized` in a `.mini` script | The caller didn't pass `"foo"` in `params`. Use `Params["foo"] or default_value` for optional parameters. |
| `ParseError` on `1..10` | Add spaces around the range operator: `1 .. 10`. |
| `MiniJSError: Unsupported type: ...` when calling `ui::show` / `ui::compile` | A closure inside a `.ui` file captured a server-only native handle (such as an open `file`, `socket`, or `log`). Keep server I/O inside `.mini` / `.rs` scripts and call them from the `.ui` file using `exec()`. |
| `UI file executed without calling ui::show(...)` at `/ui/{path}` | Ensure your `.ui` file ends with `ui::show(root_widget)` (or `ui::show(ui::compile(...))`). |
| `400 Bad Request` on `/invoke` | Check that every parameter uses the tagged JSON format `{"type": "...", "value": ...}` (and `"type": "nil"` has `null` or omitted `"value"`). |
| `408 Request Timeout` on `/invoke` | Script exceeded `timeout_ms` (default 30s). Optimize the script or pass a higher `timeout_ms` (up to `120000`, especially for first-time Rust Cargo builds). |
| `HttpError: Could not load libcurl.so.4` | Install `libcurl` on the host OS (`libcurl4` / `curl` package). |
| `ModuleError` when calling `import(...)` | Use `./name` for files relative to the current script/notebook directory, or place shared modules in the workspace root or `scripts/`. Both `.mini` and extensionless names are supported. |
| Rust `:dep` fails in an air-gapped environment | Pre-fetch crates into Cargo's local cache or use a local `{ path = "..." }` dependency. Set `MINILANG_RUST_OFFLINE=1` to skip online retry attempts. |
| `✦ agy` reports `agy` not found | Ensure `agy` is in `PATH` or `~/.local/bin/agy`, or launch the server with `--agy-bin /path/to/agy` (or `MINILANG_AGY_BIN`). |
| PAM login fails with `401` / `403` | Verify the host has `/etc/pam.d/<service>` (default `login`), that the server process can authenticate via PAM (e.g., `unix_chkpwd` / shadow access), and that the user belongs to `--require-group` if configured. |
