/**
 * Minilang MiniJS Bytecode Decoder & Virtual Machine (`MinijsVM`) and `MinijsUI.mount`.
 */

import {
  ML_NIL, ML_SOME, ML_BLANK,
  MLBool, ML_TRUE, ML_FALSE, mlBool,
  MLInt, MLReal, MLVar, MLMethod, MLList, MLTuple, MLSet, MLMap,
  MLNames, MLRange, MLChained, MLModule, MLNativeFn, MLClosure,
  MLPartial, MLRef, MLErrorVal, MLType, MLBytes, MLTime, MLUuid,
  isNil, mlDeref, mlNumVal, isNum, isIntVal, mlNumber,
  mlEquals, mlCompare, mlToString, mlTypeName,
  mlToTaggedJson, taggedJsonToMl,
  OP, OP_KIND,
} from "./values.js";
import { MLUIWidget } from "./widgets.js";
import { createServiceModule, vmAuthFetch } from "./service_client.js";

// --- MiniJS Bytecode VM ---
class MinijsVM {
  constructor(mountRoot) {
    this.mountRoot = mountRoot;
    this.errorBanner = null;
    this.clientId = `ui-${Math.random().toString(36).slice(2, 10)}`;
    this._serviceStreams = new Map(); // serviceName -> { es, handlers: Map<topic, Set<fn>> }
    this.externals = this._buildExternals();
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => this.disposeServices());
    }
  }

  disposeServices() {
    for (const [, entry] of this._serviceStreams) {
      try { entry.es.close(); } catch { /* ignore */ }
    }
    this._serviceStreams.clear();
  }

  showError(err) {
    const msg = err instanceof MLErrorVal
      ? `${err.errorType}: ${err.message}`
      : (err && err.message ? err.message : String(err));
    if (!this.errorBanner) {
      this.errorBanner = document.createElement("div");
      this.errorBanner.className = "mlui-error-banner";
      this.mountRoot.appendChild(this.errorBanner);
    }
    this.errorBanner.textContent = msg;
    this.errorBanner.classList.remove("hidden");
  }

  clearError() {
    if (this.errorBanner) this.errorBanner.classList.add("hidden");
  }

  mountWidget(widget) {
    // Preserve error banner if present
    this.mountRoot.innerHTML = "";
    this.errorBanner = null;
    if (widget instanceof MLUIWidget) {
      this.mountRoot.appendChild(widget.render());
      // Activate any top-level `service::on(...)` subscriptions bundled with this UI
      const subs = widget.props.get("__service_subs");
      if (subs instanceof MLList && this.externals.service?.exports?.on) {
        for (const item of subs.items) {
          if (item instanceof MLList && item.items.length >= 3) {
            try {
              this.externals.service.exports.on.fn([item.items[0], item.items[1], item.items[2]]);
            } catch (e) {
              this.showError(e);
            }
          }
        }
      }
      // Fire any `on_mount` handlers attached to widgets in the mounted tree
      const fireMounts = (w) => {
        if (!(w instanceof MLUIWidget)) return;
        const mh = w.handlers.get("mount");
        if (!isNil(mh)) this.safeCall(mh, [w]);
        for (const ch of w.children) fireMounts(ch);
      };
      fireMounts(widget);
    } else {
      const pre = document.createElement("pre");
      pre.textContent = mlToString(widget);
      this.mountRoot.appendChild(pre);
    }
  }

  // Parse Minilang named arguments + positional args from call args array
  _splitArgs(args) {
    const pos = [];
    const named = {};
    for (let i = 0; i < args.length; i++) {
      const a = mlDeref(args[i]);
      if (a instanceof MLNames) {
        let p = i + 1;
        for (const n of a.names) {
          if (p < args.length) named[n] = mlDeref(args[p++]);
        }
        break;
      }
      pos.push(a);
    }
    return { pos, named };
  }

  _makeWidget(kind, args, setupFn) {
    const w = new MLUIWidget(this, kind, new MLMap(), new MLList(), new MLMap());
    const { pos, named } = this._splitArgs(args);
    for (const [k, v] of Object.entries(named)) {
      if (k.startsWith("on_")) w.handlers.set(k.slice(3), v);
      else w.props.set(k, v);
    }
    if (setupFn) setupFn(w, pos);
    return w;
  }

  _addContainerChildren(w, pos, start = 0, fnEvent = null) {
    for (let i = start; i < pos.length; i++) {
      const a = pos[i];
      if (isNil(a)) continue;
      if (a instanceof MLUIWidget) {
        w.children.items.push(a);
      } else if (a instanceof MLList) {
        for (const item of a.items) {
          if (item instanceof MLUIWidget) w.children.items.push(item);
          else if (typeof item === "string") {
            w.children.items.push(new MLUIWidget(this, "text", new MLMap([["text", item]]), new MLList(), new MLMap()));
          }
        }
      } else if (fnEvent && (a instanceof MLClosure || a instanceof MLNativeFn)) {
        w.handlers.set(fnEvent, a);
      } else if (a instanceof MLMap) {
        for (const [k, v] of a.entries) {
          const ks = mlToString(k);
          if (ks.startsWith("on_")) w.handlers.set(ks.slice(3), v);
          else w.props.set(ks, v);
        }
      } else if (typeof a === "string") {
        w.children.items.push(new MLUIWidget(this, "text", new MLMap([["text", a]]), new MLList(), new MLMap()));
      }
    }
  }

  _buildExternals() {
    const vm = this;

    const uiExports = {
      vbox: new MLNativeFn("ui::vbox", (args) => vm._makeWidget("vbox", args, (w, pos) => vm._addContainerChildren(w, pos))),
      hbox: new MLNativeFn("ui::hbox", (args) => vm._makeWidget("hbox", args, (w, pos) => vm._addContainerChildren(w, pos))),
      grid: new MLNativeFn("ui::grid", (args) => vm._makeWidget("grid", args, (w, pos) => {
        let start = 0;
        if (pos.length > 0 && isNum(pos[0])) { w.props.set("columns", pos[0]); start = 1; }
        vm._addContainerChildren(w, pos, start);
      })),
      card: new MLNativeFn("ui::card", (args) => vm._makeWidget("card", args, (w, pos) => {
        let start = 0;
        if (pos.length > 0 && typeof pos[0] === "string") { w.props.set("title", pos[0]); start = 1; }
        vm._addContainerChildren(w, pos, start);
      })),
      panel: new MLNativeFn("ui::panel", (args) => vm._makeWidget("panel", args, (w, pos) => vm._addContainerChildren(w, pos))),
      form: new MLNativeFn("ui::form", (args) => vm._makeWidget("form", args, (w, pos) => vm._addContainerChildren(w, pos, 0, "submit"))),
      tabs: new MLNativeFn("ui::tabs", (args) => vm._makeWidget("tabs", args, (w, pos) => {
        const titles = new MLList();
        if (pos.length > 0 && pos[0] instanceof MLMap) {
          for (const [k, v] of pos[0].entries) {
            titles.items.push(k);
            w.children.items.push(v);
          }
        }
        w.props.set("titles", titles);
      })),
      text: new MLNativeFn("ui::text", (args) => vm._makeWidget("text", args, (w, pos) => {
        if (pos.length > 0) w.props.set("text", pos[0]);
      })),
      label: new MLNativeFn("ui::label", (args) => vm._makeWidget("label", args, (w, pos) => {
        if (pos.length > 0) w.props.set("text", pos[0]);
        if (pos.length > 1 && pos[1] instanceof MLUIWidget) w.children.items.push(pos[1]);
      })),
      heading: new MLNativeFn("ui::heading", (args) => vm._makeWidget("heading", args, (w, pos) => {
        if (pos.length > 0) w.props.set("text", pos[0]);
        if (pos.length > 1) w.props.set("level", pos[1]);
      })),
      html: new MLNativeFn("ui::html", (args) => vm._makeWidget("html", args, (w, pos) => {
        if (pos.length > 0) w.props.set("html", pos[0]);
      })),
      divider: new MLNativeFn("ui::divider", (args) => vm._makeWidget("divider", args)),
      badge: new MLNativeFn("ui::badge", (args) => vm._makeWidget("badge", args, (w, pos) => {
        if (pos.length > 0) w.props.set("text", pos[0]);
        if (pos.length > 1) w.props.set("variant", pos[1]);
      })),
      code: new MLNativeFn("ui::code", (args) => vm._makeWidget("code", args, (w, pos) => {
        if (pos.length > 0) w.props.set("text", pos[0]);
      })),
      input: new MLNativeFn("ui::input", (args) => vm._makeWidget("input", args, (w, pos) => {
        if (pos.length > 0 && !isNil(pos[0])) w.props.set("placeholder", pos[0]);
        if (pos.length > 1 && !isNil(pos[1])) w.props.set("value", pos[1]);
        if (pos.length > 2 && (pos[2] instanceof MLClosure || pos[2] instanceof MLNativeFn)) w.handlers.set("input", pos[2]);
      })),
      password: new MLNativeFn("ui::password", (args) => vm._makeWidget("password", args, (w, pos) => {
        if (pos.length > 0 && !isNil(pos[0])) w.props.set("placeholder", pos[0]);
        if (pos.length > 1 && !isNil(pos[1])) w.props.set("value", pos[1]);
      })),
      textarea: new MLNativeFn("ui::textarea", (args) => vm._makeWidget("textarea", args, (w, pos) => {
        if (pos.length > 0 && !isNil(pos[0])) w.props.set("placeholder", pos[0]);
        if (pos.length > 1 && !isNil(pos[1])) w.props.set("value", pos[1]);
        if (pos.length > 2 && isNum(pos[2])) w.props.set("rows", pos[2]);
      })),
      number: new MLNativeFn("ui::number", (args) => vm._makeWidget("number", args, (w, pos) => {
        if (pos.length > 0 && !isNil(pos[0])) w.props.set("value", pos[0]);
        if (pos.length > 1 && !isNil(pos[1])) w.props.set("min", pos[1]);
        if (pos.length > 2 && !isNil(pos[2])) w.props.set("max", pos[2]);
        if (pos.length > 3 && !isNil(pos[3])) w.props.set("step", pos[3]);
      })),
      slider: new MLNativeFn("ui::slider", (args) => vm._makeWidget("slider", args, (w, pos) => {
        if (pos.length > 0 && !isNil(pos[0])) w.props.set("value", pos[0]);
        if (pos.length > 1 && !isNil(pos[1])) w.props.set("min", pos[1]);
        if (pos.length > 2 && !isNil(pos[2])) w.props.set("max", pos[2]);
        if (pos.length > 3 && !isNil(pos[3])) w.props.set("step", pos[3]);
        if (pos.length > 4 && (pos[4] instanceof MLClosure || pos[4] instanceof MLNativeFn)) w.handlers.set("input", pos[4]);
      })),
      checkbox: new MLNativeFn("ui::checkbox", (args) => vm._makeWidget("checkbox", args, (w, pos) => {
        if (pos.length > 0 && !isNil(pos[0])) w.props.set("label", pos[0]);
        if (pos.length > 1 && !isNil(pos[1])) w.props.set("checked", pos[1]);
        if (pos.length > 2 && (pos[2] instanceof MLClosure || pos[2] instanceof MLNativeFn)) w.handlers.set("change", pos[2]);
      })),
      select: new MLNativeFn("ui::select", (args) => vm._makeWidget("select", args, (w, pos) => {
        if (pos.length > 0 && !isNil(pos[0])) w.props.set("options", pos[0]);
        if (pos.length > 1 && !isNil(pos[1])) w.props.set("value", pos[1]);
        if (pos.length > 2 && (pos[2] instanceof MLClosure || pos[2] instanceof MLNativeFn)) w.handlers.set("change", pos[2]);
      })),
      radio: new MLNativeFn("ui::radio", (args) => vm._makeWidget("radio", args, (w, pos) => {
        if (pos.length > 0 && !isNil(pos[0])) w.props.set("options", pos[0]);
        if (pos.length > 1 && !isNil(pos[1])) w.props.set("value", pos[1]);
        if (pos.length > 2 && (pos[2] instanceof MLClosure || pos[2] instanceof MLNativeFn)) w.handlers.set("change", pos[2]);
      })),
      date: new MLNativeFn("ui::date", (args) => vm._makeWidget("date", args, (w, pos) => {
        if (pos.length > 0 && !isNil(pos[0])) w.props.set("value", pos[0]);
      })),
      color: new MLNativeFn("ui::color", (args) => vm._makeWidget("color", args, (w, pos) => {
        if (pos.length > 0 && !isNil(pos[0])) w.props.set("value", pos[0]);
      })),
      button: new MLNativeFn("ui::button", (args) => vm._makeWidget("button", args, (w, pos) => {
        if (pos.length > 0 && !isNil(pos[0])) w.props.set("label", pos[0]);
        if (pos.length > 1 && (pos[1] instanceof MLClosure || pos[1] instanceof MLNativeFn)) w.handlers.set("click", pos[1]);
      })),
      table: new MLNativeFn("ui::table", (args) => vm._makeWidget("table", args, (w, pos) => {
        if (pos.length > 0 && !isNil(pos[0])) w.props.set("data", pos[0]);
        if (pos.length > 1 && !isNil(pos[1])) w.props.set("title", pos[1]);
      })),
      chart: new MLNativeFn("ui::chart", (args) => vm._makeWidget("chart", args, (w, pos) => {
        if (pos.length > 0 && !isNil(pos[0])) w.props.set("spec", pos[0]);
        if (pos.length > 1 && !isNil(pos[1])) w.props.set("title", pos[1]);
      })),
      show: new MLNativeFn("ui::show", (args) => {
        if (args.length > 0) vm.mountWidget(mlDeref(args[0]));
        return ML_NIL;
      }),
      compile: new MLNativeFn("ui::compile", (args) => args.length > 0 ? mlDeref(args[0]) : ML_NIL),
    };
    // Aliases
    uiExports.column = uiExports.vbox;
    uiExports.row = uiExports.hbox;
    uiExports.box = uiExports.panel;
    uiExports.pre = uiExports.code;
    uiExports.text_input = uiExports.input;
    uiExports.range = uiExports.slider;

    const uiModule = new MLModule("ui", uiExports);

    // exec(script, params?, callback) -> calls POST /invoke/<script> with tagged JSON!
    const execFn = new MLNativeFn("exec", (args) => {
      const { pos, named } = vm._splitArgs(args);
      if (pos.length < 1) throw new MLErrorVal("ArgumentError", "exec requires at least a script path");
      const scriptPath = mlToString(pos[0]);
      let paramsMap = null;
      let callback = null;
      let callArgs = named.args instanceof MLList ? named.args.items : [];
      let fnName = named.function !== undefined && !isNil(named.function) ? mlToString(named.function) : null;

      if (pos.length === 2) {
        if (pos[1] instanceof MLClosure || pos[1] instanceof MLNativeFn) {
          callback = pos[1];
        } else if (pos[1] instanceof MLMap) {
          paramsMap = pos[1];
        }
      } else if (pos.length >= 3) {
        if (pos[1] instanceof MLMap) paramsMap = pos[1];
        if (pos.length >= 4 && pos[2] instanceof MLMap) {
          const fnOpt = pos[2].get("function");
          if (!isNil(fnOpt)) fnName = mlToString(fnOpt);
          const argsOpt = pos[2].get("args");
          if (argsOpt instanceof MLList) callArgs = argsOpt.items;
          callback = pos[3];
        } else {
          callback = pos[2];
        }
      }

      const taggedParams = {};
      if (paramsMap instanceof MLMap) {
        for (const [k, v] of paramsMap.entries) {
          taggedParams[mlToString(k)] = mlToTaggedJson(v);
        }
      }
      const payload = {
        params: taggedParams,
        args: callArgs.map(mlToTaggedJson),
      };
      if (fnName) payload.function = fnName;

      const cleanPath = scriptPath.replace(/^\/+/, "");
      vmAuthFetch(`/invoke/${encodeURI(cleanPath)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.error || data.ok === false) {
            const errMsg = data.error
              ? (typeof data.error === "string" ? data.error : `${data.error.error_type}: ${data.error.message}`)
              : `HTTP ${res.status}`;
            if (callback) {
              vm.safeCall(callback, [ML_NIL, errMsg, new MLMap([["status", new MLInt(res.status)]])]);
            }
            return;
          }
          const mlResult = taggedJsonToMl(data.result);
          const meta = new MLMap([
            ["stdout", data.stdout || ""],
            ["duration_ms", new MLReal(data.duration_ms || 0)],
            ["type_name", data.type_name || "any"],
            ["repr", data.repr || ""],
          ]);
          if (callback) {
            vm.safeCall(callback, [mlResult, ML_NIL, meta]);
          }
        })
        .catch((e) => {
          if (callback) {
            vm.safeCall(callback, [ML_NIL, e.message || String(e), new MLMap()]);
          } else {
            vm.showError(e);
          }
        });

      return ML_NIL;
    });

    const listType = new MLType("list", (args) => {
      if (args.length === 0) return new MLList();
      const items = vm._collectSeq(mlDeref(args[0]));
      if (args.length >= 2) {
        const fn = mlDeref(args[1]);
        return new MLList(items.map((x) => vm.callValue(fn, [x])));
      }
      return new MLList(items);
    });

    const mapType = new MLType("map", (args) => {
      if (args.length === 0) return new MLMap();
      const m = new MLMap();
      if (args.length >= 2) {
        const seq = vm._iterEntries(mlDeref(args[0]));
        const fn = mlDeref(args[1]);
        for (const [k, v] of seq) {
          m.set(v, vm.callValue(fn, [v, k]));
        }
      }
      return m;
    });

    const setType = new MLType("set", (args) => {
      const s = new MLSet();
      if (args.length > 0) {
        for (const item of vm._collectSeq(mlDeref(args[0]))) {
          if (!s.items.some((e) => mlEquals(e, item))) s.items.push(item);
        }
      }
      return s;
    });

    const stringType = new MLType("string", (args) => args.map(mlToString).join(""));
    const intType = new MLType("integer", (args) => {
      const v = mlDeref(args[0]);
      if (isNum(v)) return new MLInt(Math.trunc(mlNumVal(v)));
      const n = parseInt(mlToString(v), 10);
      if (Number.isNaN(n)) throw new MLErrorVal("ValueError", `Cannot parse integer from '${mlToString(v)}'`);
      return new MLInt(n);
    });
    const realType = new MLType("real", (args) => {
      const v = mlDeref(args[0]);
      if (isNum(v)) return new MLReal(mlNumVal(v));
      const n = parseFloat(mlToString(v));
      if (Number.isNaN(n)) throw new MLErrorVal("ValueError", `Cannot parse real from '${mlToString(v)}'`);
      return new MLReal(n);
    });
    const boolType = new MLType("boolean", (args) => mlBool(!isNil(mlDeref(args[0]))));
    const jsonMod = new MLModule("json", {
      encode: new MLNativeFn("json::encode", (args) => JSON.stringify(vm._mlToPlainJson(args[0]))),
      decode: new MLNativeFn("json::decode", (args) => vm._plainJsonToMl(JSON.parse(mlToString(args[0])))),
    });

      const { serviceMod, serviceExports } = createServiceModule(vm);


    const ext = {
      ui: uiModule,
      service: serviceMod,
      exec: execFn,
      some: ML_SOME,
      list: listType,
      map: mapType,
      set: setType,
      tuple: new MLType("tuple", (args) => new MLTuple(args.map(mlDeref))),
      string: stringType,
      integer: intType,
      real: realType,
      number: realType,
      boolean: boolType,
      json: jsonMod,
      print: new MLNativeFn("print", (args) => { console.log("[minilang-ui]", args.map(mlToString).join("")); return ML_NIL; }),
      println: new MLNativeFn("println", (args) => { console.log("[minilang-ui]", args.map(mlToString).join(" ")); return ML_NIL; }),
      now: new MLNativeFn("now", () => new MLInt(Math.floor(Date.now() / 1000))),
      clock: new MLNativeFn("clock", () => new MLReal(Date.now() / 1000)),
      type: new MLNativeFn("type", (args) => new MLType(mlTypeName(args[0]), null)),
      raise: new MLNativeFn("raise", (args) => { throw new MLErrorVal(mlToString(args[0]), args[1] ? mlToString(args[1]) : ""); }),
      sum: new MLNativeFn("sum", (args) => {
        const items = vm._collectSeq(mlDeref(args[0]));
        let acc = 0, isFloat = false;
        for (const x of items) {
          if (!isIntVal(x)) isFloat = true;
          acc += mlNumVal(x);
        }
        return mlNumber(acc, isFloat);
      }),
      min: new MLNativeFn("min", (args) => {
        const items = args.length === 1 ? vm._collectSeq(mlDeref(args[0])) : args.map(mlDeref);
        if (!items.length) return ML_NIL;
        return items.reduce((a, b) => (mlCompare(a, b) <= 0 ? a : b));
      }),
      max: new MLNativeFn("max", (args) => {
        const items = args.length === 1 ? vm._collectSeq(mlDeref(args[0])) : args.map(mlDeref);
        if (!items.length) return ML_NIL;
        return items.reduce((a, b) => (mlCompare(a, b) >= 0 ? a : b));
      }),
      count: new MLNativeFn("count", (args) => new MLInt(vm._collectSeq(mlDeref(args[0])).length)),
      range: new MLNativeFn("range", (args) => {
        if (args.length === 2) return new MLRange(mlNumVal(args[0]), mlNumVal(args[1]), 1);
        if (args.length >= 3) return new MLRange(mlNumVal(args[0]), mlNumVal(args[1]), mlNumVal(args[2]));
        return new MLRange(1, mlNumVal(args[0]), 1);
      }),
    };

    for (const [k, v] of Object.entries(uiExports)) {
      ext[`ui::${k}`] = v;
    }
    for (const [k, v] of Object.entries(serviceExports)) {
      ext[`service::${k}`] = v;
    }
    return ext;
  }

  _mlToPlainJson(v) {
    v = mlDeref(v);
    if (isNil(v)) return null;
    if (v && v.__ml === "boolean") return v.v;
    if (isNum(v)) return mlNumVal(v);
    if (typeof v === "string") return v;
    if (v instanceof MLList || v instanceof MLTuple || v instanceof MLSet) return v.items.map((x) => this._mlToPlainJson(x));
    if (v instanceof MLMap) {
      const o = {};
      for (const [k, val] of v.entries) o[mlToString(k)] = this._mlToPlainJson(val);
      return o;
    }
    return mlToString(v);
  }

  _plainJsonToMl(v) {
    if (v === null || v === undefined) return ML_NIL;
    if (typeof v === "boolean") return mlBool(v);
    if (typeof v === "number") return mlNumber(v);
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return new MLList(v.map((x) => this._plainJsonToMl(x)));
    if (typeof v === "object") {
      return new MLMap(Object.entries(v).map(([k, val]) => [k, this._plainJsonToMl(val)]));
    }
    return String(v);
  }

  // --- MiniJS Decoder ---
  decode(json, cache = new Map()) {
    if (json === null || json === undefined) return ML_NIL;
    if (typeof json === "boolean") return mlBool(json);
    if (typeof json === "number") return Number.isInteger(json) ? new MLInt(json) : new MLReal(json);
    if (typeof json === "string") return json;
    if (!Array.isArray(json) || json.length === 0) return ML_NIL;

    let idx = 0;
    let cacheId = null;
    if (typeof json[0] === "number") {
      cacheId = json[0];
      if (json.length === 1) {
        return cache.has(cacheId) ? cache.get(cacheId) : ML_NIL;
      }
      idx = 1;
    }

    const tag = json[idx];
    const rest = json.slice(idx + 1);
    const reg = (val) => { if (cacheId !== null) cache.set(cacheId, val); return val; };

    switch (tag) {
      case "^": {
        const name = rest[0];
        const found = this.externals[name];
        return reg(found !== undefined ? found : new MLMethod(name));
      }
      case "_": return reg(ML_BLANK);
      case ":": return reg(new MLMethod(rest[0]));
      case "t": return reg(this.externals[rest[0]] || new MLType(rest[0], null));
      case "l": {
        const list = reg(new MLList());
        for (const item of rest) list.items.push(this.decode(item, cache));
        return list;
      }
      case "x": {
        const tup = reg(new MLTuple());
        for (const item of rest) tup.items.push(this.decode(item, cache));
        return tup;
      }
      case "n": {
        return reg(new MLNames(rest.map((x) => String(x))));
      }
      case "m": {
        const m = reg(new MLMap());
        for (let i = 0; i + 1 < rest.length; i += 2) {
          m.entries.push([this.decode(rest[i], cache), this.decode(rest[i + 1], cache)]);
        }
        return m;
      }
      case "v": {
        const box = reg(new MLVar(ML_NIL));
        if (rest.length > 0) box.v = this.decode(rest[0], cache);
        return box;
      }
      case "time": return reg(new MLTime(String(rest[0] || "")));
      case "uuid": return reg(new MLUuid(String(rest[0] || "")));
      case "w": {
        const w = reg(new MLUIWidget(this, rest[0], new MLMap(), new MLList(), new MLMap()));
        const props = this.decode(rest[1], cache);
        const children = this.decode(rest[2], cache);
        const handlers = this.decode(rest[3], cache);
        if (props instanceof MLMap) w.props = props;
        if (children instanceof MLList) w.children = children;
        if (handlers instanceof MLMap) w.handlers = handlers;
        return w;
      }
      case "u": {
        return reg(this.decode(rest[0], cache));
      }
      case "o": {
        const objType = rest[0];
        const objArgs = rest.slice(1).map((a) => this.decode(a, cache));
        if (objType === "map::template") {
          const pairs = [];
          for (let i = 0; i + 1 < objArgs.length; i += 2) {
            pairs.push([objArgs[i], objArgs[i + 1]]);
          }
          return reg(new MLNativeFn("map::template", (callArgs) => {
            const m = new MLMap();
            for (const [k, idxOrVal] of pairs) {
              const idx = Math.trunc(mlNumVal(idxOrVal));
              const v = (idx >= 0 && idx < callArgs.length) ? mlDeref(callArgs[idx]) : ML_NIL;
              m.set(k, v);
            }
            return m;
          }));
        }
        if (objType === "string-switch") {
          return reg(new MLNativeFn("string-switch", (callArgs) => {
            const target = mlToString(callArgs[0]);
            for (let i = 0; i < objArgs.length; i++) {
              const cases = objArgs[i] instanceof MLList ? objArgs[i].items : [];
              for (const c of cases) {
                if (typeof c === "string" && c === target) return new MLInt(i);
                if (c && c.__ml === "regex" && c.re.test(target)) return new MLInt(i);
              }
            }
            return new MLInt(objArgs.length);
          }));
        }
        if (objType === "integer-switch" || objType === "real-switch") {
          return reg(new MLNativeFn(objType, (callArgs) => {
            const val = mlNumVal(callArgs[0]);
            for (let i = 0; i < objArgs.length; i++) {
              const cases = objArgs[i] instanceof MLList ? objArgs[i].items : [];
              for (const c of cases) {
                if (c instanceof MLList && c.items.length >= 2) {
                  if (val >= mlNumVal(c.items[0]) && val <= mlNumVal(c.items[1])) return new MLInt(i);
                }
              }
            }
            return new MLInt(objArgs.length);
          }));
        }
        if (objType === "type-switch") {
          return reg(new MLNativeFn("type-switch", (callArgs) => {
            const tname = mlTypeName(callArgs[0]);
            for (let i = 0; i < objArgs.length; i++) {
              const cases = objArgs[i] instanceof MLList ? objArgs[i].items : [];
              for (const c of cases) {
                if (c instanceof MLType && (c.name === tname || c.name === "any")) return new MLInt(i);
              }
            }
            return new MLInt(objArgs.length);
          }));
        }
        if (objType === "->") {
          return reg(new MLNativeFn("->", (callArgs) => {
            let v = callArgs.length > 0 ? callArgs[0] : ML_NIL;
            for (const fn of objArgs) v = this.callValue(fn, [v]);
            return v;
          }));
        }
        if (objType === "error") {
          return reg(new MLErrorVal(mlToString(objArgs[0]), mlToString(objArgs[1])));
        }
        if (objType === "var") {
          return reg(new MLVar(objArgs[0] !== undefined ? objArgs[0] : ML_NIL));
        }
        return reg(ML_NIL);
      }
      case "r": {
        return reg({ __ml: "regex", pattern: String(rest[0] || ""), re: new RegExp(String(rest[0] || "")) });
      }
      case "z": {
        const infoArr = rest[0];
        const closure = reg(new MLClosure(null, []));
        closure.upvalues.push(closure); // UpValues[0] = self
        closure.info = this._decodeClosureInfo(infoArr, cache);
        for (let i = 1; i < rest.length; i++) {
          closure.upvalues.push(this.decode(rest[i], cache));
        }
        return closure;
      }
      default:
        return reg(ML_NIL);
    }
  }

  _decodeClosureInfo(arr, cache) {
    // ["!", version, source, startLine, frameSize, numParams, numUpValues, extraArgs, namedArgs, params, entry, returnOffset, initDecl, instructions, decls]
    const info = {
      version: arr[1],
      source: arr[2],
      startLine: arr[3],
      frameSize: arr[4],
      numParams: arr[5],
      numUpValues: arr[6],
      extraArgs: !!arr[7],
      namedArgs: !!arr[8],
      params: arr[9] || [],
      entryOffset: arr[10],
      returnOffset: arr[11],
      initDecl: arr[12],
      decls: arr[14] || [],
      code: [],
    };

    const flat = arr[13] || [];
    const offsetToIp = new Map();
    const rawInsts = [];
    let i = 0;

    while (i < flat.length) {
      const startOffset = i;
      offsetToIp.set(startOffset, rawInsts.length);
      const op = flat[i++];
      const line = flat[i++];
      const kind = OP_KIND[op];
      const inst = { op, line };

      switch (kind) {
        case "NONE": break;
        case "INST":
          inst.targetOffset = flat[i++];
          break;
        case "INST_CONFIG":
        case "INST_COUNT":
          inst.targetOffset = flat[i++];
          inst.count = flat[i++];
          break;
        case "INST_COUNT_DECL":
          inst.targetOffset = flat[i++];
          inst.count = flat[i++];
          inst.decl = flat[i++];
          break;
        case "COUNT":
          inst.count = flat[i++];
          break;
        case "COUNT_COUNT":
          inst.count = flat[i++];
          inst.count2 = flat[i++];
          break;
        case "VALUE":
          inst.value = this.decode(flat[i++], cache);
          break;
        case "VALUE_COUNT":
        case "VALUE_COUNT_DATA":
          inst.value = this.decode(flat[i++], cache);
          inst.count = flat[i++];
          break;
        case "COUNT_CHARS":
          inst.chars = String(flat[i++] ?? "");
          break;
        case "DECL":
          inst.decl = flat[i++];
          break;
        case "COUNT_DECL":
          inst.count = flat[i++];
          inst.decl = flat[i++];
          break;
        case "COUNT_COUNT_DECL":
          inst.count = flat[i++];
          inst.count2 = flat[i++];
          inst.decl = flat[i++];
          break;
        case "CLOSURE": {
          const subInfo = this._decodeClosureInfo(flat[i++], cache);
          inst.closureInfo = subInfo;
          inst.upvalueIndices = [];
          for (let u = 0; u < subInfo.numUpValues; u++) {
            inst.upvalueIndices.push(flat[i++]);
          }
          break;
        }
        case "SWITCH": {
          const sw = flat[i++]; // ["l", offset1, offset2, ...]
          inst.switchOffsets = Array.isArray(sw) ? sw.slice(1) : [];
          break;
        }
        default:
          throw new MLErrorVal("MinijsError", `Unknown opcode ${op}`);
      }
      rawInsts.push(inst);
    }

    // Patch jump targets from flat offsets to instruction indices
    for (const inst of rawInsts) {
      if (inst.targetOffset !== undefined) {
        inst.target = offsetToIp.get(inst.targetOffset);
      }
      if (inst.switchOffsets) {
        inst.targets = inst.switchOffsets.map((o) => offsetToIp.get(o));
      }
    }
    info.code = rawInsts;
    info.entryIp = offsetToIp.get(info.entryOffset) ?? 0;
    info.returnIp = offsetToIp.get(info.returnOffset) ?? (rawInsts.length - 1);
    return info;
  }

  // --- Sequence & Iterator Helpers ---
  _iterEntries(val) {
    val = mlDeref(val);
    if (val instanceof MLList) return val.items.map((v, i) => [new MLInt(i + 1), v]);
    if (val instanceof MLTuple) return val.items.map((v, i) => [new MLInt(i + 1), v]);
    if (val instanceof MLSet) return val.items.map((v) => [v, v]);
    if (val instanceof MLMap) return val.entries.slice();
    if (val instanceof MLRange) {
      const out = [];
      let k = 1;
      if (val.step > 0) {
        for (let x = val.start; x <= val.end; x += val.step) out.push([new MLInt(k++), mlNumber(x)]);
      } else if (val.step < 0) {
        for (let x = val.start; x >= val.end; x += val.step) out.push([new MLInt(k++), mlNumber(x)]);
      }
      return out;
    }
    if (val instanceof MLChained) {
      const base = this._iterEntries(val.base);
      const out = [];
      for (const [k, v] of base) {
        const r = this.callValue(val.fn, [v]);
        if (val.isFilter) {
          if (!isNil(mlDeref(r))) out.push([k, v]);
        } else {
          out.push([k, r]);
        }
      }
      return out;
    }
    if (typeof val === "string") {
      return Array.from(val).map((ch, i) => [new MLInt(i + 1), ch]);
    }
    return [];
  }

  _collectSeq(val) {
    return this._iterEntries(val).map(([, v]) => v);
  }

  // --- Method Dispatch ---
  _invokeMethod(name, args) {
    const a0 = args.length > 0 ? mlDeref(args[0]) : ML_NIL;
    const a1 = args.length > 1 ? mlDeref(args[1]) : ML_NIL;
    const a2 = args.length > 2 ? mlDeref(args[2]) : ML_NIL;

    // Arithmetic & comparison operators
    switch (name) {
      case "+": {
        if (args.length === 1) return a0;
        if (typeof a0 === "string" || typeof a1 === "string") return mlToString(a0) + mlToString(a1);
        if (a0 instanceof MLList && a1 instanceof MLList) return new MLList([...a0.items, ...a1.items]);
        if (isNum(a0) && isNum(a1)) return mlNumber(mlNumVal(a0) + mlNumVal(a1), !(isIntVal(a0) && isIntVal(a1)));
        throw new MLErrorVal("MethodError", `No method '+' for ${mlTypeName(a0)}, ${mlTypeName(a1)}`);
      }
      case "-": {
        if (args.length === 1) return mlNumber(-mlNumVal(a0), !isIntVal(a0));
        return mlNumber(mlNumVal(a0) - mlNumVal(a1), !(isIntVal(a0) && isIntVal(a1)));
      }
      case "*": {
        if (typeof a0 === "string" && isNum(a1)) return a0.repeat(Math.max(0, Math.trunc(mlNumVal(a1))));
        return mlNumber(mlNumVal(a0) * mlNumVal(a1), !(isIntVal(a0) && isIntVal(a1)));
      }
      case "/": {
        const d = mlNumVal(a1);
        if (d === 0) throw new MLErrorVal("ValueError", "Division by zero");
        const q = mlNumVal(a0) / d;
        return (isIntVal(a0) && isIntVal(a1) && Number.isInteger(q)) ? new MLInt(q) : new MLReal(q);
      }
      case "%": return new MLInt(mlNumVal(a0) % mlNumVal(a1));
      case "^": return mlNumber(Math.pow(mlNumVal(a0), mlNumVal(a1)), !(isIntVal(a0) && isIntVal(a1)));
      case "=": return mlEquals(a0, a1) ? a1 : ML_NIL;
      case "!=": return !mlEquals(a0, a1) ? a1 : ML_NIL;
      case "<": return mlCompare(a0, a1) < 0 ? a1 : ML_NIL;
      case "<=": return mlCompare(a0, a1) <= 0 ? a1 : ML_NIL;
      case ">": return mlCompare(a0, a1) > 0 ? a1 : ML_NIL;
      case ">=": return mlCompare(a0, a1) >= 0 ? a1 : ML_NIL;
      case "..": return new MLRange(mlNumVal(a0), mlNumVal(a1), 1);
      case "->": return new MLChained(a0, a1, false);
      case "->?": return new MLChained(a0, a1, true);
      case "[]": {
        if (a0 instanceof MLMap) {
          return new MLRef(() => a0.get(a1), (nv) => a0.set(a1, nv));
        }
        if (a0 instanceof MLList) {
          const idx = Math.trunc(mlNumVal(a1));
          const j = idx < 0 ? a0.items.length + idx : idx - 1;
          return new MLRef(
            () => (j >= 0 && j < a0.items.length ? a0.items[j] : ML_NIL),
            (nv) => { if (j >= 0 && j < a0.items.length) a0.items[j] = nv; return nv; }
          );
        }
        if (a0 instanceof MLTuple) {
          const idx = Math.trunc(mlNumVal(a1));
          const j = idx < 0 ? a0.items.length + idx : idx - 1;
          return j >= 0 && j < a0.items.length ? a0.items[j] : ML_NIL;
        }
        if (typeof a0 === "string") {
          const idx = Math.trunc(mlNumVal(a1));
          const j = idx < 0 ? a0.length + idx : idx - 1;
          return j >= 0 && j < a0.length ? a0[j] : ML_NIL;
        }
        return ML_NIL;
      }
      case "append": {
        // Used internally by MLI_STRING_ADD / MLI_STRING_ADD_1 on string buffers
        if (Array.isArray(a0) && a0.__ml_sbuf) {
          for (let i = 1; i < args.length; i++) a0.push(mlToString(args[i]));
          return a0;
        }
        if (a0 instanceof MLUIWidget) {
          for (let i = 1; i < args.length; i++) a0.appendChildWidget(mlDeref(args[i]));
          return a0;
        }
        if (a0 instanceof MLList) {
          for (let i = 1; i < args.length; i++) a0.items.push(mlDeref(args[i]));
          return a0;
        }
        return a0;
      }
    }

    // Widget methods
    if (a0 instanceof MLUIWidget) {
      switch (name) {
        case "value":
        case "get_value": return a0.getValue();
        case "set_value": return a0.setValue(a1);
        case "text": return a0.getText();
        case "set_text": return a0.setText(a1);
        case "html": return a0.getHtml();
        case "set_html": return a0.setHtml(a1);
        case "set_data": return a0.setData(a1);
        case "set_spec": return a0.setSpec(a1);
        case "append":
        case "add":
          for (let i = 1; i < args.length; i++) a0.appendChildWidget(mlDeref(args[i]));
          return a0;
        case "clear": return a0.clearChildren();
        case "set_disabled": return a0.setDisabled(a1);
        case "set_visible": return a0.setVisible(a1);
        case "set_style": return args.length >= 3 ? a0.setStyle(a1, a2) : a0.setStyle(a1);
        case "on": return a0.on(mlToString(a1), a2);
        case "on_click": return a0.on("click", a1);
        case "on_change": return a0.on("change", a1);
        case "on_input": return a0.on("input", a1);
        case "on_submit": return a0.on("submit", a1);
        case "show": this.mountWidget(a0); return ML_NIL;
      }
    }

    // List methods
    if (a0 instanceof MLList) {
      switch (name) {
        case "count":
        case "length":
        case "size": return new MLInt(a0.items.length);
        case "empty": return a0.items.length === 0 ? a0 : ML_NIL;
        case "put":
        case "push":
          for (let i = 1; i < args.length; i++) a0.items.push(mlDeref(args[i]));
          return a0;
        case "pop": return a0.items.length ? a0.items.pop() : ML_NIL;
        case "pull": return a0.items.length ? a0.items.shift() : ML_NIL;
        case "first": return a0.items.length ? a0.items[0] : ML_NIL;
        case "last": return a0.items.length ? a0.items[a0.items.length - 1] : ML_NIL;
        case "join": return a0.items.map(mlToString).join(args.length > 1 ? mlToString(a1) : "");
        case "reverse": a0.items.reverse(); return a0;
        case "sort": a0.items.sort(mlCompare); return a0;
        case "find": {
          const idx = a0.items.findIndex((x) => mlEquals(x, a1));
          return idx >= 0 ? new MLInt(idx + 1) : ML_NIL;
        }
        case "map": return new MLList(a0.items.map((x) => this.callValue(a1, [x])));
        case "filter": return new MLList(a0.items.filter((x) => !isNil(mlDeref(this.callValue(a1, [x])))));
      }
    }

    // Map methods
    if (a0 instanceof MLMap) {
      switch (name) {
        case "count":
        case "size": return new MLInt(a0.entries.length);
        case "empty": return a0.entries.length === 0 ? a0 : ML_NIL;
        case "insert": return a0.set(a1, a2);
        case "delete": return a0.delete(a1);
        case "keys": return new MLList(a0.entries.map(([k]) => k));
        case "values": return new MLList(a0.entries.map(([, v]) => v));
        default: {
          // Map property lookup via symbol e.g. m:foo
          const found = a0.get(name);
          if (!isNil(found)) return found;
          return ML_NIL;
        }
      }
    }

    // String methods
    if (typeof a0 === "string") {
      switch (name) {
        case "length":
        case "count":
        case "size": return new MLInt(a0.length);
        case "upper": return a0.toUpperCase();
        case "lower": return a0.toLowerCase();
        case "trim": return a0.trim();
        case "split": {
          const sep = args.length > 1 ? mlToString(a1) : /\s+/;
          return new MLList(a0.split(sep));
        }
        case "replace": return a0.split(mlToString(a1)).join(mlToString(a2));
        case "find": {
          const i = a0.indexOf(mlToString(a1));
          return i >= 0 ? new MLInt(i + 1) : ML_NIL;
        }
        case "starts": return a0.startsWith(mlToString(a1)) ? a0 : ML_NIL;
        case "ends": return a0.endsWith(mlToString(a1)) ? a0 : ML_NIL;
      }
    }

    // Generic conversions
    if (name === "string") return mlToString(a0);
    if (name === "integer") return this.externals.integer.ctor([a0]);
    if (name === "real") return this.externals.real.ctor([a0]);
    if (name === "boolean") return mlBool(!isNil(a0));

    // Module property access
    if (a0 instanceof MLModule && name in a0.exports) {
      return a0.exports[name];
    }

    throw new MLErrorVal("MethodError", `Method ':${name}' not found for ${mlTypeName(a0)}`);
  }

  callValue(fn, args) {
    fn = mlDeref(fn);
    if (fn instanceof MLClosure) return this.execClosure(fn, args);
    if (fn instanceof MLNativeFn) return fn.fn(args);
    if (fn instanceof MLMethod) return this._invokeMethod(fn.name, args);
    if (fn instanceof MLType && fn.ctor) return fn.ctor(args);
    if (fn instanceof MLPartial) {
      const merged = [];
      let ai = 0;
      for (const s of fn.slots) {
        merged.push(s !== undefined ? s : (ai < args.length ? args[ai++] : ML_NIL));
      }
      while (ai < args.length) merged.push(args[ai++]);
      return this.callValue(fn.fn, merged);
    }
    throw new MLErrorVal("TypeError", `Value of type ${mlTypeName(fn)} is not callable`);
  }

  safeCall(fn, args) {
    try {
      this.clearError();
      return this.callValue(fn, args);
    } catch (e) {
      this.showError(e);
      return ML_NIL;
    }
  }

  execClosure(closure, args) {
    const info = closure.info;
    const stack = new Array(Math.max(info.frameSize + 8, 32)).fill(null);

    // Bind parameters
    let numParams = info.numParams;
    if (info.extraArgs) numParams--;
    if (info.namedArgs) numParams--;
    const min = Math.min(args.length, numParams);
    let i = 0;
    for (; i < min; i++) {
      const arg = mlDeref(args[i]);
      if (arg instanceof MLNames) break;
      stack[i] = arg;
    }
    for (let j = i; j < numParams; j++) stack[j] = ML_NIL;

    if (info.extraArgs) {
      const rest = new MLList();
      for (; i < args.length; i++) {
        const arg = mlDeref(args[i]);
        if (arg instanceof MLNames) break;
        rest.items.push(arg);
      }
      stack[numParams++] = rest;
    }

    if (info.namedArgs) {
      const opts = new MLMap();
      for (; i < args.length; i++) {
        const arg = mlDeref(args[i]);
        if (arg instanceof MLNames) {
          for (const n of arg.names) {
            const v = ++i < args.length ? mlDeref(args[i]) : ML_NIL;
            const pIdx = info.params.indexOf(n);
            if (pIdx >= 0) stack[pIdx] = v;
            else opts.set(n, v);
          }
          break;
        }
      }
      stack[numParams++] = opts;
    }

    let top = numParams;
    let ip = info.entryIp;
    let onErrorIp = info.returnIp;
    let result = ML_NIL;
    const code = info.code;
    const upvalues = closure.upvalues;
    let steps = 0;

    const assignRef = (ref, val) => {
      val = mlDeref(val);
      if (ref instanceof MLVar) { ref.v = val; return val; }
      if (ref instanceof MLRef) { return ref.set(val); }
      throw new MLErrorVal("TypeError", "Cannot assign to non-variable");
    };

    while (ip >= 0 && ip < code.length) {
      if (++steps > 200000) {
        throw new MLErrorVal("RuntimeError", "UI execution step limit exceeded");
      }
      const inst = code[ip];
      try {
        switch (inst.op) {
          case OP.RETURN:
            return result;
          case OP.NIL:
            result = ML_NIL;
            ip++;
            break;
          case OP.NIL_PUSH:
            result = stack[top++] = ML_NIL;
            ip++;
            break;
          case OP.LOAD:
            result = inst.value;
            ip++;
            break;
          case OP.LOAD_PUSH:
            result = stack[top++] = inst.value;
            ip++;
            break;
          case OP.LOAD_VAR:
            result = mlDeref(inst.value);
            stack[top + inst.count].v = result;
            ip++;
            break;
          case OP.PUSH:
            stack[top++] = result;
            ip++;
            break;
          case OP.WITH:
            stack[top++] = result;
            ip++;
            break;
          case OP.WITHX: {
            const packed = mlDeref(result);
            const arr = packed instanceof MLTuple || packed instanceof MLList ? packed.items : [packed];
            for (let k = 0; k < inst.count; k++) stack[top++] = k < arr.length ? arr[k] : ML_NIL;
            ip++;
            break;
          }
          case OP.POP:
            result = stack[--top];
            stack[top] = null;
            ip++;
            break;
          case OP.AND:
            ip = isNil(mlDeref(result)) ? inst.target : ip + 1;
            break;
          case OP.AND_POP:
            if (isNil(mlDeref(result))) {
              for (let k = 0; k < inst.count; k++) stack[--top] = null;
              result = ML_NIL;
              ip = inst.target;
            } else {
              ip++;
            }
            break;
          case OP.OR:
            ip = !isNil(mlDeref(result)) ? inst.target : ip + 1;
            break;
          case OP.NOT:
            result = isNil(mlDeref(result)) ? ML_SOME : ML_NIL;
            ip++;
            break;
          case OP.GOTO:
            ip = inst.target;
            break;
          case OP.ENTER:
            for (let k = 0; k < inst.count; k++) stack[top++] = new MLVar(ML_NIL);
            for (let k = 0; k < inst.count2; k++) stack[top++] = null;
            ip++;
            break;
          case OP.EXIT:
            for (let k = 0; k < inst.count; k++) stack[--top] = null;
            ip++;
            break;
          case OP.TRY:
            onErrorIp = inst.target;
            ip++;
            break;
          case OP.CATCH:
            onErrorIp = inst.target;
            while (top > inst.count) stack[--top] = null;
            stack[top++] = result;
            ip++;
            break;
          case OP.CATCHX:
            onErrorIp = inst.target;
            while (top > inst.count) stack[--top] = null;
            ip++;
            break;
          case OP.RETRY:
            ip = onErrorIp;
            break;
          case OP.LOCAL:
            result = stack[top + inst.count];
            ip++;
            break;
          case OP.LOCAL_PUSH:
            result = stack[top + inst.count];
            stack[top++] = result;
            ip++;
            break;
          case OP.LOCALI:
            result = stack[top + inst.count] ?? ML_NIL;
            ip++;
            break;
          case OP.UPVALUE:
            result = upvalues[inst.count + 1];
            ip++;
            break;
          case OP.VAR:
            result = mlDeref(result);
            stack[top + inst.count].v = result;
            ip++;
            break;
          case OP.VAR_TYPE:
            ip++;
            break;
          case OP.VARX: {
            const packed = mlDeref(result);
            const arr = packed instanceof MLTuple || packed instanceof MLList ? packed.items : [packed];
            const base = top + inst.count;
            for (let k = 0; k < inst.count2; k++) stack[base + k].v = k < arr.length ? mlDeref(arr[k]) : ML_NIL;
            ip++;
            break;
          }
          case OP.LET:
          case OP.LETI:
            result = mlDeref(result);
            stack[top + inst.count] = result;
            ip++;
            break;
          case OP.LETX: {
            const packed = mlDeref(result);
            const arr = packed instanceof MLTuple || packed instanceof MLList ? packed.items : [packed];
            const base = top + inst.count;
            for (let k = 0; k < inst.count2; k++) stack[base + k] = k < arr.length ? mlDeref(arr[k]) : ML_NIL;
            ip++;
            break;
          }
          case OP.REF:
          case OP.REFI:
            stack[top + inst.count] = result;
            ip++;
            break;
          case OP.REFX: {
            const packed = mlDeref(result);
            const arr = packed instanceof MLTuple || packed instanceof MLList ? packed.items : [packed];
            const base = top + inst.count;
            for (let k = 0; k < inst.count2; k++) stack[base + k] = k < arr.length ? arr[k] : ML_NIL;
            ip++;
            break;
          }
          case OP.ASSIGN: {
            const ref = stack[--top];
            stack[top] = null;
            result = assignRef(ref, result);
            ip++;
            break;
          }
          case OP.ASSIGN_LOCAL: {
            const ref = stack[top + inst.count];
            result = assignRef(ref, result);
            ip++;
            break;
          }
          case OP.LIST_NEW:
            stack[top++] = new MLList();
            ip++;
            break;
          case OP.LIST_APPEND:
            result = mlDeref(result);
            stack[top - 1].items.push(result);
            ip++;
            break;
          case OP.MAP_NEW:
            stack[top++] = new MLMap();
            ip++;
            break;
          case OP.MAP_INSERT: {
            const key = mlDeref(stack[--top]);
            stack[top] = null;
            result = mlDeref(result);
            stack[top - 1].set(key, result);
            ip++;
            break;
          }
          case OP.TUPLE_NEW: {
            const items = [];
            for (let k = top - inst.count; k < top; k++) {
              items.push(mlDeref(stack[k]));
              stack[k] = null;
            }
            top -= inst.count;
            result = new MLTuple(items);
            ip++;
            break;
          }
          case OP.STRING_NEW: {
            const buf = [];
            buf.__ml_sbuf = true;
            stack[top++] = buf;
            ip++;
            break;
          }
          case OP.STRING_ADDS:
            stack[top - 1].push(inst.chars);
            ip++;
            break;
          case OP.STRING_ADD_1: {
            const v = stack[--top];
            stack[top] = null;
            stack[top - 1].push(mlToString(v));
            ip++;
            break;
          }
          case OP.STRING_ADD: {
            const base = top - inst.count;
            const buf = stack[base - 1];
            for (let k = base; k < top; k++) {
              buf.push(mlToString(stack[k]));
              stack[k] = null;
            }
            top = base;
            ip++;
            break;
          }
          case OP.STRING_POP: {
            const buf = stack[--top];
            stack[top] = null;
            result = buf.join("");
            ip++;
            break;
          }
          case OP.STRING_END: {
            result = stack[top - 1].join("");
            stack[top - 1] = result;
            ip++;
            break;
          }
          case OP.FOR: {
            const entries = this._iterEntries(mlDeref(result));
            result = entries.length > 0 ? { __ml: "iter", entries, pos: 0 } : ML_NIL;
            ip++;
            break;
          }
          case OP.ITER:
            if (isNil(result)) {
              ip = inst.target;
            } else {
              stack[top++] = result;
              ip++;
            }
            break;
          case OP.NEXT: {
            const it = stack[--top];
            stack[top] = null;
            it.pos++;
            result = it.pos < it.entries.length ? it : ML_NIL;
            ip = inst.target;
            break;
          }
          case OP.VALUE_1: {
            const it = stack[top - 1];
            result = it.entries[it.pos][1];
            ip++;
            break;
          }
          case OP.VALUE_2: {
            const it = stack[top - 2];
            result = it.entries[it.pos][1];
            ip++;
            break;
          }
          case OP.KEY: {
            const it = stack[top - 1];
            result = it.entries[it.pos][0];
            ip++;
            break;
          }
          case OP.RESOLVE: {
            const target = mlDeref(result);
            const sym = inst.value;
            const name = sym instanceof MLMethod ? sym.name : mlToString(sym);
            if (target instanceof MLModule && name in target.exports) {
              result = target.exports[name];
            } else if (target instanceof MLMap) {
              result = target.get(name);
            } else {
              result = this._invokeMethod(name, [target]);
            }
            ip++;
            break;
          }
          case OP.CALL:
          case OP.TAIL_CALL: {
            const count = inst.count;
            const callArgs = stack.slice(top - count, top);
            const fn = stack[top - count - 1];
            for (let k = top - count - 1; k < top; k++) stack[k] = null;
            top -= count + 1;
            result = this.callValue(fn, callArgs);
            if (inst.op === OP.TAIL_CALL) return result;
            ip++;
            break;
          }
          case OP.CALL_CONST:
          case OP.TAIL_CALL_CONST: {
            const count = inst.count;
            const callArgs = stack.slice(top - count, top);
            for (let k = top - count; k < top; k++) stack[k] = null;
            top -= count;
            result = this.callValue(inst.value, callArgs);
            if (inst.op === OP.TAIL_CALL_CONST) return result;
            ip++;
            break;
          }
          case OP.CALL_METHOD:
          case OP.TAIL_CALL_METHOD: {
            const count = inst.count;
            const callArgs = stack.slice(top - count, top);
            for (let k = top - count; k < top; k++) stack[k] = null;
            top -= count;
            const m = inst.value;
            result = this._invokeMethod(m instanceof MLMethod ? m.name : mlToString(m), callArgs);
            if (inst.op === OP.TAIL_CALL_METHOD) return result;
            ip++;
            break;
          }
          case OP.CLOSURE:
          case OP.CLOSURE_TYPED: {
            const subUp = [null];
            const subClosure = new MLClosure(inst.closureInfo, subUp);
            subUp[0] = subClosure;
            for (const uIdx of inst.upvalueIndices) {
              if (uIdx < 0) {
                subUp.push(upvalues[(~uIdx) + 1]);
              } else {
                subUp.push(stack[uIdx]);
              }
            }
            result = subClosure;
            ip++;
            break;
          }
          case OP.PARAM_TYPE:
            ip++;
            break;
          case OP.PARTIAL_NEW:
            stack[top++] = new MLPartial(mlDeref(result), inst.count);
            ip++;
            break;
          case OP.PARTIAL_SET:
            stack[top - 1].slots[inst.count] = mlDeref(result);
            ip++;
            break;
          case OP.SWITCH: {
            const idx = Math.trunc(mlNumVal(result));
            const targets = inst.targets || [];
            ip = (idx >= 0 && idx < targets.length) ? targets[idx] : targets[targets.length - 1];
            break;
          }
          case OP.LINK:
            ip = inst.target;
            break;
          default:
            throw new MLErrorVal("MinijsError", `Unsupported bytecode opcode ${inst.op}`);
        }
      } catch (err) {
        const mlErr = err instanceof MLErrorVal ? err : new MLErrorVal("RuntimeError", err.message || String(err));
        if (onErrorIp !== info.returnIp) {
          result = mlErr;
          ip = onErrorIp;
        } else {
          throw mlErr;
        }
      }
    }
    return result;
  }

  runBundle(bundle) {
    const decoded = this.decode(bundle.minijs);
    if (bundle.mode === "function" || decoded instanceof MLClosure) {
      const ret = this.safeCall(decoded, [this.externals.ui, this.externals.exec]);
      if (ret instanceof MLUIWidget && this.mountRoot.childNodes.length === 0) {
        this.mountWidget(ret);
      }
    } else if (decoded instanceof MLUIWidget) {
      this.mountWidget(decoded);
    } else {
      this.mountWidget(decoded);
    }
  }
}


export const MinijsUI = {
  mount(container, rawData) {
    try {
      const bundle = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
      const host = document.createElement("div");
      host.className = "mlui-root";
      container.appendChild(host);
      const vm = new MinijsVM(host);
      vm.runBundle(bundle);
      return vm;
    } catch (e) {
      const errEl = document.createElement("div");
      errEl.className = "mlui-error-banner";
      errEl.textContent = `UI mount error: ${e.message || e}`;
      container.appendChild(errEl);
      return null;
    }
  },
};

export { MinijsVM };
