# Minilang Notebook — Complete Guide to `.mini` Scripts and `.ui` Interfaces

This guide covers everything you need to write, test, invoke, and deploy server-side **`.mini` scripts** and interactive browser-side **`.ui` user interfaces** in **Minilang Notebook**.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Quick Minilang Syntax Primer](#2-quick-minilang-syntax-primer)
3. [Writing `.mini` Scripts](#3-writing-mini-scripts)
   - [How `.mini` Scripts Execute](#how-mini-scripts-execute)
   - [Receiving Parameters (`Params`, `Args`, and Direct Variables)](#receiving-parameters-params-args-and-direct-variables)
   - [Returning Values](#returning-values)
   - [Available Standard Modules & Helpers](#available-standard-modules--helpers)
   - [Using `.mini` Scripts in the Web UI](#using-mini-scripts-in-the-web-ui)
4. [The `/invoke` HTTP Endpoint & Tagged JSON Format](#4-the-invoke-http-endpoint--tagged-json-format)
   - [Endpoints & Path Resolution](#endpoints--path-resolution)
   - [Request Schema](#request-schema)
   - [Response Schema & Status Codes](#response-schema--status-codes)
   - [Tagged JSON Type Reference](#tagged-json-type-reference)
   - [Calling Specific Functions in a `.mini` File](#calling-specific-functions-in-a-mini-file)
   - [Timeouts, Isolation & Security](#timeouts-isolation--security)
5. [Writing `.ui` Files (Custom Minilang User Interfaces)](#5-writing-ui-files-custom-minilang-user-interfaces)
   - [How `.ui` Files Work (MiniJS Bytecode Compilation)](#how-ui-files-work-minijs-bytecode-compilation)
   - [Serving `.ui` Files from `/ui/{path}`](#serving-ui-files-from-uipath)
   - [Two Authoring Styles: Direct `ui::show` vs `ui::compile`](#two-authoring-styles-direct-uishow-vs-uicompile)
   - [Pre-Compiled `.ui` Files](#pre-compiled-ui-files)
6. [Complete `ui` Widget Reference](#6-complete-ui-widget-reference)
   - [Container Widgets](#container-widgets)
   - [Form Element Widgets](#form-element-widgets)
   - [Display & Raw HTML Widgets (`ui::html`)](#display--raw-html-widgets-uihtml)
   - [Widget Methods](#widget-methods)
   - [Common Styling & Layout Props](#common-styling--layout-props)
   - [Event Handling & Reactive State](#event-handling--reactive-state)
7. [Calling `.mini` Endpoints from `.ui` Files with `exec()`](#7-calling-mini-endpoints-from-ui-files-with-exec)
   - [Signatures](#signatures)
   - [Callback Arguments (`result`, `err`, `meta`)](#callback-arguments-result-err-meta)
   - [Automatic Tagged JSON Marshaling](#automatic-tagged-json-marshaling)
8. [End-to-End Cookbook Examples](#8-end-to-end-cookbook-examples)
   - [Example 1: Parameterized API Script (`scripts/greet.mini`)](#example-1-parameterized-api-script-scriptsgreetmini)
   - [Example 2: Multi-Function Data Script (`scripts/stats.mini`)](#example-2-multi-function-data-script-scriptsstatsmini)
   - [Example 3: Interactive Form UI (`uis/greeter.ui`)](#example-3-interactive-form-ui-uisgreeterui)
   - [Example 4: Tabbed Dashboard Calling Multiple Modes (`uis/stats.ui`)](#example-4-tabbed-dashboard-calling-multiple-modes-uisstatsui)
   - [Example 5: Dynamic List Builder with Raw HTML & Local State](#example-5-dynamic-list-builder-with-raw-html--local-state)
9. [Troubleshooting & Minilang Gotchas](#9-troubleshooting--minilang-gotchas)

---

## 1. Architecture Overview

Minilang Notebook unifies three workflows in a single Rust binary:

| File Type | Extension | Where It Runs | How It Is Used |
|---|---|---|---|
| **Notebook** | `.mnb` | Isolated persistent Minilang kernel per open tab | Interactive REPL cells, Markdown notes, rich HTML/SVG/UI outputs |
| **User Script** | `.mini` | Fresh isolated Minilang kernel on the server per request | Backend logic callable via `POST /invoke/{path}` with tagged JSON parameters |
| **User Interface** | `.ui` | Compiled on the server via `minijs`, executed live in the browser | Custom interactive web apps served at `GET /ui/{path}`, calling `.mini` endpoints via `exec()` |

```text
Browser (.ui running in MiniJS Bytecode VM)
  ├── Live DOM Widgets (ui::card, ui::vbox, ui::input, ui::button, ui::html, ...)
  ├── Event Handlers (Minilang closures compiled to MiniJS bytecode)
  └── exec("scripts/foo.mini", params; result, err, meta) do ... end
          │
          ▼  POST /invoke/scripts/foo.mini  (Tagged JSON)
Rust Server (Axum)
  └── Spawns isolated `minilang-notebook --kernel` subprocess
          ├── Decodes Tagged JSON -> native Minilang values (Params, Args, vars)
          ├── Executes scripts/foo.mini (with timeout)
          └── Encodes return value -> Tagged JSON response
```

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

## 3. Writing `.mini` Scripts

`.mini` files are standard Minilang scripts stored anywhere inside the workspace (conventionally under `scripts/`). They can be run interactively in the editor, converted to notebooks, or invoked programmatically via the `/invoke` HTTP API.

### How `.mini` Scripts Execute

When a `.mini` script is called through `/invoke`:

1. The Rust server validates that the target file exists inside the workspace root and has a `.mini` extension.
2. It spawns a **fresh, isolated Minilang kernel subprocess** with its working directory set to the script's parent folder (so relative `file(...)` paths work relative to the script).
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

### Available Standard Modules & Helpers

Every `.mini` kernel initializes the full built-in Minilang runtime:

| Global / Module | Description |
|---|---|
| `print(...)`, `println(...)` | Writes formatted output to the captured `stdout` stream |
| `html(s)`, `svg(s)`, `markdown(s)`, `display(mime, s)` | Emits rich display payloads in `displays` |
| `now()`, `clock()`, `time` | Current epoch time, high-resolution clock, ISO-8601 time parsing/formatting |
| `file`, `dir`, `popen`, `stream` | Filesystem & stream I/O (relative to the script's directory) |
| `socket` | TCP/UDP sockets |
| `json` | `json::encode(val)`, `json::decode(str)` |
| `cbor` | CBOR binary serialization |
| `uuid` | UUID generation and parsing |
| `base16`, `base64` | Hex and Base64 encoding/decoding |
| `minijs` | `minijs::encode(val)`, `minijs::decode(val)` |
| `ui` | Widget constructors, `ui::compile`, `ui::show` |
| `memory` | Boehm GC inspection (`memory::usage`, `memory::collect`, etc.) |
| Core types & functions | `list`, `map`, `set`, `tuple`, `string`, `integer`, `real`, `boolean`, `regex`, `sum`, `min`, `max`, `count`, `range`, `zip`, `reduce`, `fold`, `unique`, etc. |

### Using `.mini` Scripts in the Web UI

When you open any `.mini` file from the left file browser sidebar, the editor toolbar provides:

- **Save (`Ctrl+S`)**: Saves changes to disk.
- **Run in Minilang**: Executes the script immediately in a fresh kernel and renders `stdout`, `Out[N]`, rich HTML/SVG, or live UI outputs below the editor.
- **Invoke (`/invoke`)**: Opens an interactive JSON tester panel wired directly to `POST /invoke/{script}`, complete with an optional function input, formatted JSON response viewer, and a **Copy curl** button.
- **Launch UI**: Opens `/ui/{script}` in a new browser tab if the script calls `ui::show(...)`.
- **Open as Notebook**: Converts the `.mini` script into an interactive `.mnb` notebook tab. (Use `:> %%` or `# %%` comment lines in a `.mini` file to split it into multiple cells automatically.)

---

## 4. The `/invoke` HTTP Endpoint & Tagged JSON Format

### Endpoints & Path Resolution

| Method & Path | Description |
|---|---|
| `POST /invoke` | Invoke a script specified in the JSON body's `"script"` field |
| `POST /invoke/{path}` | Invoke a script specified in the URL path |
| `GET /api/scripts` | List all `.mini` scripts in the workspace (prioritizing `scripts/`) |

Path resolution rules for `{path}` (or `"script"`):

1. If `{path}` ends with `.mini`, the server checks `{path}`, then `scripts/{path}`.
2. If `{path}` has no extension (e.g., `POST /invoke/greet`), the server checks `{path}.mini`, then `scripts/{path}.mini`.
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
| `script` | Required for `POST /invoke`; omitted for `POST /invoke/{path}` | — | Path to `.mini` script |
| `params` | No | `{}` | Object mapping parameter names to Tagged JSON values |
| `args` | No | `[]` | Array of positional Tagged JSON values (`Args` in Minilang) |
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
| `400 Bad Request` | Malformed JSON, invalid/unsupported tagged type, missing `script`, or non-`.mini` file |
| `404 Not Found` | Script does not exist (or path traversal attempt) |
| `408 Request Timeout` | Script exceeded `timeout_ms` (kernel subprocess killed) |
| `422 Unprocessable Entity` | Minilang parse, compile, parameter, or runtime error (`ok: false`, details in `error`) |
| `500 Internal Server Error` | Kernel crashed or called `halt()` before returning |

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

### Calling Specific Functions in a `.mini` File

Set `"function"` in the request body to call a specific function defined in the script after the script's top-level statements finish loading:

- If `args` is non-empty, the function is called with `args` unpacked positionally (`fn(arg1, arg2, ...)`).
- If `args` is empty and `params` is non-empty, the function is called with the `Params` map (`fn(Params)`).
- If both are empty, the function is called with 0 arguments (`fn()`).

```bash
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
```

### Timeouts, Isolation & Security

- Each invocation runs in its own OS process (`--kernel`) and is killed on completion or timeout.
- Infinite loops (e.g. `loop end`) are terminated cleanly at `timeout_ms` and return HTTP `408`.
- Only `.mini` files inside `--root` can be invoked.

---

## 5. Writing `.ui` Files (Custom Minilang User Interfaces)

`.ui` files let you build complete interactive web interfaces in pure Minilang — including forms, layout containers, raw HTML views, reactive local state, and asynchronous calls to `.mini` backend scripts via `exec()`.

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

You can also create new `.ui` files directly from the **New Minilang UI (`.ui`)** button in the sidebar header, preview them inline with **Preview UI**, or open them in a dedicated tab with **Launch UI**.

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
let f := file("uis/prebuilt.ui", "w")
f:write(app:json)
f:close
```

When `GET /ui/uis/prebuilt.ui` is requested, the server detects `"format": "minilang-ui"` and serves the pre-compiled MiniJS bundle immediately without spawning a Minilang kernel process.

---

## 6. Complete `ui` Widget Reference

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
| `ui::divider()` | — | Horizontal divider `<hr>` |

### Widget Methods

These methods work both while constructing widgets and live inside browser event callbacks:

| Method | Description |
|---|---|
| `w:value` / `w:get_value` | Read current value of a form control (`string`, `integer`/`real`, or `boolean`) |
| `w:set_value(v)` | Update a form control's value in the live DOM |
| `w:text` / `w:set_text(s)` | Get or set plain `textContent` (safe against HTML injection) |
| `w:html` / `w:set_html(h)` | Get or set `innerHTML` (ideal with `ui::html(...)`) |
| `w:append(child)` / `w:add(child)` | Append a child widget (or string) to a container dynamically |
| `w:clear()` | Remove all child widgets/content from a container |
| `w:set_disabled(bool)` | Enable or disable a form element or button |
| `w:set_visible(bool)` | Show or hide a widget (`display: none`) |
| `w:set_style(prop, val)` / `w:set_style(map)` | Set inline CSS style property/properties (e.g. `w:set_style("color", "#4ade80")`) |
| `w:on(event, fn)` | Attach a Minilang closure to any DOM event (`"click"`, `"input"`, `"change"`, `"submit"`) |
| `w:on_click(fn)` / `w:on_input(fn)` / `w:on_change(fn)` / `w:on_submit(fn)` | Shorthand event binder methods |
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

## 7. Calling `.mini` Endpoints from `.ui` Files with `exec()`

`exec()` bridges your browser-side `.ui` interface to your server-side `.mini` scripts via `POST /invoke/{script}`.

### Signatures

```minilang
:> 1. No parameters
exec("scripts/greet.mini"; res, err, meta) do
    ...
end

:> 2. Named parameters map
exec("scripts/greet.mini", {
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

---

## 8. End-to-End Cookbook Examples

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

---

## 9. Troubleshooting & Minilang Gotchas

| Issue | Cause & Fix |
|---|---|
| `if flag then ...` always takes the `then` branch even when `flag` is `false` | In Minilang, **only `nil` is falsy**. Use `if flag = true then ... else ... end`. |
| `ValueError: foo is uninitialized` in a `.mini` script | The caller didn't pass `"foo"` in `params`. Use `Params["foo"] or default_value` for optional parameters. |
| `ParseError` on `1..10` | Add spaces around the range operator: `1 .. 10`. |
| `MiniJSError: Unsupported type: ...` when calling `ui::show` / `ui::compile` | A closure inside a `.ui` file captured a server-only native handle (such as an open `file` or `socket`). Keep server I/O inside `.mini` scripts and call them from the `.ui` file using `exec()`. |
| `UI file executed without calling ui::show(...)` at `/ui/{path}` | Ensure your `.ui` file ends with `ui::show(root_widget)` (or `ui::show(ui::compile(...))`). |
| `400 Bad Request` on `/invoke` | Check that every parameter uses the tagged JSON format `{"type": "...", "value": ...}` (and `"type": "nil"` has `null` or omitted `"value"`). |
| `408 Request Timeout` on `/invoke` | Script exceeded `timeout_ms` (default 30s). Optimize the script or pass a higher `timeout_ms` (up to `120000`). |
