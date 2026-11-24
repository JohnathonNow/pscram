/* Minilang MiniJS Bytecode VM & Live DOM Widget Runtime */
(() => {
  "use strict";

  // --- Core Minilang Runtime Value Types ---
  const ML_NIL = Object.freeze({ __ml: "nil" });
  const ML_SOME = Object.freeze({ __ml: "some" });
  const ML_BLANK = Object.freeze({ __ml: "blank" });

  class MLBool {
    constructor(v) { this.__ml = "boolean"; this.v = !!v; }
  }
  const ML_TRUE = Object.freeze(new MLBool(true));
  const ML_FALSE = Object.freeze(new MLBool(false));
  const mlBool = (b) => (b ? ML_TRUE : ML_FALSE);

  class MLInt {
    constructor(v) { this.__ml = "integer"; this.v = Math.trunc(v); }
  }
  class MLReal {
    constructor(v) { this.__ml = "real"; this.v = Number(v); }
  }
  class MLVar {
    constructor(v) { this.__ml = "var"; this.v = v === undefined ? ML_NIL : v; }
  }
  class MLMethod {
    constructor(name) { this.__ml = "method"; this.name = name; }
  }
  class MLList {
    constructor(items = []) { this.__ml = "list"; this.items = items; }
  }
  class MLTuple {
    constructor(items = []) { this.__ml = "tuple"; this.items = items; }
  }
  class MLSet {
    constructor(items = []) { this.__ml = "set"; this.items = items; }
  }
  class MLMap {
    constructor(entries = []) { this.__ml = "map"; this.entries = entries; } // [[k, v], ...]
    get(key) {
      const k = mlDeref(key);
      for (const [ek, ev] of this.entries) {
        if (mlEquals(ek, k)) return ev;
      }
      return ML_NIL;
    }
    set(key, val) {
      const k = mlDeref(key);
      const v = mlDeref(val);
      for (let i = 0; i < this.entries.length; i++) {
        if (mlEquals(this.entries[i][0], k)) {
          this.entries[i][1] = v;
          return v;
        }
      }
      this.entries.push([k, v]);
      return v;
    }
    delete(key) {
      const k = mlDeref(key);
      for (let i = 0; i < this.entries.length; i++) {
        if (mlEquals(this.entries[i][0], k)) {
          const old = this.entries[i][1];
          this.entries.splice(i, 1);
          return old;
        }
      }
      return ML_NIL;
    }
    toPlainObject() {
      const o = {};
      for (const [k, v] of this.entries) {
        o[mlToString(k)] = v;
      }
      return o;
    }
  }
  class MLNames {
    constructor(names = []) { this.__ml = "names"; this.names = names; }
  }
  class MLRange {
    constructor(start, end, step = 1) {
      this.__ml = "range";
      this.start = start;
      this.end = end;
      this.step = step;
    }
  }
  class MLChained {
    constructor(base, fn, isFilter = false) {
      this.__ml = "chained";
      this.base = base;
      this.fn = fn;
      this.isFilter = isFilter;
    }
  }
  class MLModule {
    constructor(name, exportsObj) {
      this.__ml = "module";
      this.name = name;
      this.exports = exportsObj;
    }
  }
  class MLNativeFn {
    constructor(name, fn) { this.__ml = "native_fn"; this.name = name; this.fn = fn; }
  }
  class MLClosure {
    constructor(info, upvalues) {
      this.__ml = "closure";
      this.info = info;
      this.upvalues = upvalues; // [self, up1, up2, ...]
    }
  }
  class MLPartial {
    constructor(fn, total) {
      this.__ml = "partial";
      this.fn = fn;
      this.slots = new Array(total).fill(undefined);
    }
  }
  class MLRef {
    constructor(getter, setter) {
      this.__ml = "ref";
      this.get = getter;
      this.set = setter;
    }
  }
  class MLErrorVal {
    constructor(type, message) {
      this.__ml = "error";
      this.errorType = type || "Error";
      this.message = message || "";
    }
  }
  class MLType {
    constructor(name, ctor) {
      this.__ml = "type";
      this.name = name;
      this.ctor = ctor;
    }
  }
  class MLBytes {
    constructor(b64) { this.__ml = "bytes"; this.b64 = b64; }
  }
  class MLTime {
    constructor(iso) { this.__ml = "time"; this.iso = iso; }
  }
  class MLUuid {
    constructor(str) { this.__ml = "uuid"; this.str = str; }
  }

  // --- Value Helpers ---
  function isNil(v) {
    return v === null || v === undefined || v === ML_NIL || (v && v.__ml === "nil");
  }

  function mlDeref(v) {
    if (v === null || v === undefined) return ML_NIL;
    if (typeof v === "object") {
      if (v.__ml === "var") return v.v;
      if (v.__ml === "ref") return v.get();
    }
    return v;
  }

  function mlNumVal(v) {
    v = mlDeref(v);
    if (typeof v === "number") return v;
    if (v && (v.__ml === "integer" || v.__ml === "real")) return v.v;
    return NaN;
  }

  function isNum(v) {
    v = mlDeref(v);
    return typeof v === "number" || (v && (v.__ml === "integer" || v.__ml === "real"));
  }

  function isIntVal(v) {
    v = mlDeref(v);
    return (v && v.__ml === "integer") || (typeof v === "number" && Number.isInteger(v));
  }

  function mlNumber(n, preferReal = false) {
    if (!preferReal && Number.isInteger(n)) return new MLInt(n);
    return new MLReal(n);
  }

  function mlEquals(a, b) {
    a = mlDeref(a);
    b = mlDeref(b);
    if (a === b) return true;
    if (isNil(a) && isNil(b)) return true;
    if (isNil(a) || isNil(b)) return false;
    if (a && b && a.__ml === "boolean" && b.__ml === "boolean") return a.v === b.v;
    if (isNum(a) && isNum(b)) return mlNumVal(a) === mlNumVal(b);
    if (typeof a === "string" && typeof b === "string") return a === b;
    if (a && b && a.__ml === "method" && b.__ml === "method") return a.name === b.name;
    if (a && b && a.__ml === "list" && b.__ml === "list") {
      if (a.items.length !== b.items.length) return false;
      for (let i = 0; i < a.items.length; i++) if (!mlEquals(a.items[i], b.items[i])) return false;
      return true;
    }
    return false;
  }

  function mlCompare(a, b) {
    a = mlDeref(a);
    b = mlDeref(b);
    if (isNum(a) && isNum(b)) {
      const na = mlNumVal(a), nb = mlNumVal(b);
      return na < nb ? -1 : na > nb ? 1 : 0;
    }
    if (typeof a === "string" && typeof b === "string") {
      return a < b ? -1 : a > b ? 1 : 0;
    }
    const sa = mlToString(a), sb = mlToString(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  function mlToString(v) {
    v = mlDeref(v);
    if (isNil(v)) return "nil";
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    if (typeof v === "boolean") return v ? "true" : "false";
    if (v.__ml === "boolean") return v.v ? "true" : "false";
    if (v.__ml === "integer" || v.__ml === "real") return String(v.v);
    if (v.__ml === "method") return `:${v.name}`;
    if (v.__ml === "list") return `[${v.items.map(mlToString).join(", ")}]`;
    if (v.__ml === "tuple") return `(${v.items.map(mlToString).join(", ")})`;
    if (v.__ml === "set") return `{${v.items.map(mlToString).join(", ")}}`;
    if (v.__ml === "map") return `{${v.entries.map(([k, val]) => `${mlToString(k)} is ${mlToString(val)}`).join(", ")}}`;
    if (v.__ml === "time") return v.iso;
    if (v.__ml === "uuid") return v.str;
    if (v.__ml === "bytes") return v.b64;
    if (v.__ml === "error") return `${v.errorType}: ${v.message}`;
    if (v.__ml === "widget") return `<ui::widget:${v.kind}>`;
    if (v.__ml === "closure") return `<closure>`;
    if (v.__ml === "some") return "some";
    return String(v);
  }

  function mlTypeName(v) {
    v = mlDeref(v);
    if (isNil(v)) return "nil";
    if (typeof v === "string") return "string";
    if (typeof v === "number") return Number.isInteger(v) ? "integer" : "real";
    return v.__ml || "any";
  }

  // --- Tagged JSON Conversion (for /invoke <-> MiniJS VM) ---
  function mlToTaggedJson(v) {
    v = mlDeref(v);
    if (isNil(v)) return { type: "nil" };
    if (typeof v === "boolean") return { type: "boolean", value: v };
    if (v && v.__ml === "boolean") return { type: "boolean", value: v.v };
    if (v && v.__ml === "integer") return { type: "integer", value: v.v };
    if (v && v.__ml === "real") return { type: "real", value: v.v };
    if (typeof v === "number") {
      return Number.isInteger(v) ? { type: "integer", value: v } : { type: "real", value: v };
    }
    if (typeof v === "string") return { type: "string", value: v };
    if (v.__ml === "method") return { type: "symbol", value: v.name };
    if (v.__ml === "list") return { type: "list", value: v.items.map(mlToTaggedJson) };
    if (v.__ml === "tuple") return { type: "tuple", value: v.items.map(mlToTaggedJson) };
    if (v.__ml === "set") return { type: "set", value: v.items.map(mlToTaggedJson) };
    if (v.__ml === "map") {
      const allStr = v.entries.every(([k]) => typeof mlDeref(k) === "string");
      if (allStr) {
        const obj = {};
        for (const [k, val] of v.entries) obj[mlDeref(k)] = mlToTaggedJson(val);
        return { type: "map", value: obj };
      }
      return { type: "map", value: v.entries.map(([k, val]) => [mlToTaggedJson(k), mlToTaggedJson(val)]) };
    }
    if (v.__ml === "time") return { type: "time", value: v.iso };
    if (v.__ml === "uuid") return { type: "uuid", value: v.str };
    if (v.__ml === "bytes") return { type: "bytes", value: v.b64 };
    return { type: "string", value: mlToString(v) };
  }

  function taggedJsonToMl(t) {
    if (!t || typeof t !== "object") return ML_NIL;
    switch (t.type) {
      case "nil": return ML_NIL;
      case "boolean": return mlBool(t.value);
      case "integer": return new MLInt(t.value);
      case "real": return new MLReal(t.value);
      case "string": return String(t.value ?? "");
      case "symbol": return new MLMethod(String(t.value ?? ""));
      case "list": return new MLList((t.value || []).map(taggedJsonToMl));
      case "tuple": return new MLTuple((t.value || []).map(taggedJsonToMl));
      case "set": return new MLSet((t.value || []).map(taggedJsonToMl));
      case "map": {
        if (Array.isArray(t.value)) {
          return new MLMap(t.value.map(([k, v]) => [taggedJsonToMl(k), taggedJsonToMl(v)]));
        }
        const entries = [];
        for (const [k, v] of Object.entries(t.value || {})) {
          entries.push([k, taggedJsonToMl(v)]);
        }
        return new MLMap(entries);
      }
      case "time": return new MLTime(String(t.value ?? ""));
      case "uuid": return new MLUuid(String(t.value ?? ""));
      case "bytes": return new MLBytes(String(t.value ?? ""));
      default: return t.value !== undefined ? String(t.value) : ML_NIL;
    }
  }

  // --- Bytecode Opcode Table (mirrors minilang/src/ml_opcodes.h & ml_opcodes.c) ---
  const OP = {
    AND: 0, AND_POP: 1, ASSIGN: 2, ASSIGN_LOCAL: 3, CALL: 4, CALL_CONST: 5,
    CALL_METHOD: 6, CATCH: 7, CATCHX: 8, CLOSURE: 9, CLOSURE_TYPED: 10,
    ENTER: 11, EXIT: 12, FOR: 13, GOTO: 14, IF_CONFIG: 15, ITER: 16, KEY: 17,
    LET: 18, LETI: 19, LETX: 20, LINK: 21, LIST_APPEND: 22, LIST_NEW: 23,
    LOAD: 24, LOAD_PUSH: 25, LOAD_VAR: 26, LOCAL: 27, LOCALI: 28, LOCAL_PUSH: 29,
    MAP_INSERT: 30, MAP_NEW: 31, NEXT: 32, NIL: 33, NIL_PUSH: 34, NOT: 35,
    OR: 36, PARAM_TYPE: 37, PARTIAL_NEW: 38, PARTIAL_SET: 39, POP: 40, PUSH: 41,
    REF: 42, REFI: 43, REFX: 44, RESOLVE: 45, RESUME: 46, RETRY: 47, RETURN: 48,
    STRING_ADD: 49, STRING_ADDS: 50, STRING_ADD_1: 51, STRING_END: 52,
    STRING_NEW: 53, STRING_POP: 54, SUSPEND: 55, SWITCH: 56, TAIL_CALL: 57,
    TAIL_CALL_CONST: 58, TAIL_CALL_METHOD: 59, TRY: 60, TUPLE_NEW: 61,
    UPVALUE: 62, VALUE_1: 63, VALUE_2: 64, VAR: 65, VARX: 66, VAR_TYPE: 67,
    WITH: 68, WITHX: 69
  };

  const OP_KIND = {
    [OP.AND]: "INST",
    [OP.AND_POP]: "INST_COUNT",
    [OP.ASSIGN]: "NONE",
    [OP.ASSIGN_LOCAL]: "COUNT",
    [OP.CALL]: "COUNT",
    [OP.CALL_CONST]: "VALUE_COUNT",
    [OP.CALL_METHOD]: "VALUE_COUNT_DATA",
    [OP.CATCH]: "INST_COUNT_DECL",
    [OP.CATCHX]: "INST_COUNT_DECL",
    [OP.CLOSURE]: "CLOSURE",
    [OP.CLOSURE_TYPED]: "CLOSURE",
    [OP.ENTER]: "COUNT_COUNT_DECL",
    [OP.EXIT]: "COUNT_DECL",
    [OP.FOR]: "NONE",
    [OP.GOTO]: "INST",
    [OP.IF_CONFIG]: "INST_CONFIG",
    [OP.ITER]: "INST",
    [OP.KEY]: "NONE",
    [OP.LET]: "COUNT",
    [OP.LETI]: "COUNT",
    [OP.LETX]: "COUNT_COUNT",
    [OP.LINK]: "INST",
    [OP.LIST_APPEND]: "NONE",
    [OP.LIST_NEW]: "NONE",
    [OP.LOAD]: "VALUE",
    [OP.LOAD_PUSH]: "VALUE",
    [OP.LOAD_VAR]: "VALUE_COUNT",
    [OP.LOCAL]: "COUNT",
    [OP.LOCALI]: "COUNT_DECL",
    [OP.LOCAL_PUSH]: "COUNT",
    [OP.MAP_INSERT]: "NONE",
    [OP.MAP_NEW]: "NONE",
    [OP.NEXT]: "INST",
    [OP.NIL]: "NONE",
    [OP.NIL_PUSH]: "NONE",
    [OP.NOT]: "NONE",
    [OP.OR]: "INST",
    [OP.PARAM_TYPE]: "COUNT",
    [OP.PARTIAL_NEW]: "COUNT",
    [OP.PARTIAL_SET]: "COUNT",
    [OP.POP]: "NONE",
    [OP.PUSH]: "NONE",
    [OP.REF]: "COUNT",
    [OP.REFI]: "COUNT",
    [OP.REFX]: "COUNT_COUNT",
    [OP.RESOLVE]: "VALUE",
    [OP.RESUME]: "NONE",
    [OP.RETRY]: "NONE",
    [OP.RETURN]: "NONE",
    [OP.STRING_ADD]: "COUNT",
    [OP.STRING_ADDS]: "COUNT_CHARS",
    [OP.STRING_ADD_1]: "NONE",
    [OP.STRING_END]: "NONE",
    [OP.STRING_NEW]: "NONE",
    [OP.STRING_POP]: "NONE",
    [OP.SUSPEND]: "NONE",
    [OP.SWITCH]: "SWITCH",
    [OP.TAIL_CALL]: "COUNT",
    [OP.TAIL_CALL_CONST]: "VALUE_COUNT",
    [OP.TAIL_CALL_METHOD]: "VALUE_COUNT_DATA",
    [OP.TRY]: "INST",
    [OP.TUPLE_NEW]: "COUNT",
    [OP.UPVALUE]: "COUNT",
    [OP.VALUE_1]: "NONE",
    [OP.VALUE_2]: "NONE",
    [OP.VAR]: "COUNT",
    [OP.VARX]: "COUNT_COUNT",
    [OP.VAR_TYPE]: "COUNT",
    [OP.WITH]: "DECL",
    [OP.WITHX]: "COUNT_DECL",
  };

  // --- Live DOM Widget Class ---
  let widgetSeq = 0;

  class MLUIWidget {
    constructor(vm, kind, propsMap, childrenList, handlersMap) {
      this.__ml = "widget";
      this.id = `mlw-${++widgetSeq}`;
      this.vm = vm;
      this.kind = kind;
      this.props = propsMap instanceof MLMap ? propsMap : new MLMap();
      this.children = childrenList instanceof MLList ? childrenList : new MLList();
      this.handlers = handlersMap instanceof MLMap ? handlersMap : new MLMap();
      this.el = null;
      this.bodyEl = null;
      this.controlEl = null;
      this._valueReadoutEl = null;
    }

    prop(name, fallback = undefined) {
      const v = this.props.get(name);
      return isNil(v) ? fallback : v;
    }

    propStr(name, fallback = "") {
      const v = this.prop(name);
      return v === undefined ? fallback : mlToString(v);
    }

    propBool(name, fallback = false) {
      const v = this.prop(name);
      if (v === undefined) return fallback;
      if (v && v.__ml === "boolean") return v.v;
      if (typeof v === "boolean") return v;
      return !isNil(v);
    }

    propNum(name, fallback = undefined) {
      const v = this.prop(name);
      if (v === undefined) return fallback;
      const n = mlNumVal(v);
      return Number.isNaN(n) ? fallback : n;
    }

    on(eventName, fn) {
      this.handlers.set(eventName, fn);
      if (this.el) this._attachSingleHandler(eventName, fn);
      return this;
    }

    _attachSingleHandler(eventName, fn) {
      const target = this.controlEl || this.el;
      if (!target) return;
      const key = `__ml_bound_${eventName}`;
      if (target[key]) return;
      target[key] = true;

      if (this.kind === "radio" && eventName === "change") {
        target.addEventListener("change", () => {
          const handler = this.handlers.get("change");
          if (!isNil(handler)) this.vm.safeCall(handler, [this.getValue(), this]);
        });
        return;
      }

      target.addEventListener(eventName, (ev) => {
        if (eventName === "submit") ev.preventDefault();
        const handler = this.handlers.get(eventName);
        if (!isNil(handler)) {
          const arg = (eventName === "input" || eventName === "change") ? this.getValue() : this;
          this.vm.safeCall(handler, [arg, this]);
        }
      });
    }

    getValue() {
      if (this.kind === "checkbox") {
        const checked = this.controlEl ? this.controlEl.checked : this.propBool("checked", false);
        return mlBool(checked);
      }
      if (this.kind === "number" || this.kind === "slider") {
        const raw = this.controlEl ? this.controlEl.value : this.propStr("value", "0");
        const n = Number(raw);
        if (Number.isNaN(n)) return ML_NIL;
        return Number.isInteger(n) && !raw.includes(".") ? new MLInt(n) : new MLReal(n);
      }
      if (this.kind === "radio") {
        if (this.el) {
          const checked = this.el.querySelector("input[type=radio]:checked");
          return checked ? checked.value : ML_NIL;
        }
        return this.prop("value", ML_NIL);
      }
      if (this.controlEl) return this.controlEl.value;
      return this.prop("value", "");
    }

    setValue(val) {
      this.props.set("value", val);
      if (this.kind === "checkbox") {
        const b = (val && val.__ml === "boolean") ? val.v : !isNil(val);
        this.props.set("checked", mlBool(b));
        if (this.controlEl) this.controlEl.checked = b;
        return this;
      }
      const s = isNil(val) ? "" : mlToString(val);
      if (this.kind === "radio" && this.el) {
        this.el.querySelectorAll("input[type=radio]").forEach((r) => {
          r.checked = (r.value === s);
        });
        return this;
      }
      if (this.controlEl) {
        this.controlEl.value = s;
        if (this._valueReadoutEl) this._valueReadoutEl.textContent = s;
      }
      return this;
    }

    getText() {
      if (this.el && (this.kind === "text" || this.kind === "heading" || this.kind === "label" || this.kind === "badge" || this.kind === "code")) {
        return this.el.textContent || "";
      }
      return this.propStr("text", this.propStr("label", ""));
    }

    setText(val) {
      const s = mlToString(val);
      this.props.set("text", s);
      if (this.kind === "button" && this.controlEl) {
        this.controlEl.textContent = s;
      } else if (this.el) {
        this.el.textContent = s;
      }
      return this;
    }

    getHtml() {
      if (this.el) return this.el.innerHTML;
      return this.propStr("html", "");
    }

    setHtml(val) {
      const s = mlToString(val);
      this.props.set("html", s);
      if (this.el) this.el.innerHTML = s;
      return this;
    }

    setData(val) {
      this.props.set("data", val);
      if (this.el && this.kind === "table" && window.MlnbViz) {
        this.el.innerHTML = "";
        window.MlnbViz.mountTable(this.el, {
          title: this.propStr("title", ""),
          raw: mlToPlainJs(val),
        });
      }
      return this;
    }

    setSpec(val) {
      this.props.set("spec", val);
      if (this.el && this.kind === "chart" && window.MlnbViz) {
        this.el.innerHTML = "";
        const plain = mlToPlainJs(val);
        const spec = (plain && typeof plain === "object" && !Array.isArray(plain))
          ? plain
          : { type: "line", data: plain };
        if (!spec.title && this.propStr("title", "")) spec.title = this.propStr("title", "");
        window.MlnbViz.mountChart(this.el, spec);
      }
      return this;
    }

    appendChildWidget(child) {
      if (typeof child === "string") {
        const p = new MLMap([["text", child]]);
        child = new MLUIWidget(this.vm, "text", p, new MLList(), new MLMap());
      }
      if (child instanceof MLUIWidget) {
        this.children.items.push(child);
        const target = this.bodyEl || this.el;
        if (target) target.appendChild(child.render());
      }
      return this;
    }

    clearChildren() {
      this.children.items = [];
      const target = this.bodyEl || this.el;
      if (target) target.innerHTML = "";
      return this;
    }

    setDisabled(val) {
      const b = (val && val.__ml === "boolean") ? val.v : !isNil(val);
      this.props.set("disabled", mlBool(b));
      if (this.controlEl) this.controlEl.disabled = b;
      return this;
    }

    setVisible(val) {
      const b = (val && val.__ml === "boolean") ? val.v : !isNil(val);
      this.props.set("visible", mlBool(b));
      if (this.el) this.el.style.display = b ? "" : "none";
      return this;
    }

    setStyle(k, v) {
      if (k instanceof MLMap) {
        for (const [sk, sv] of k.entries) this.setStyle(sk, sv);
        return this;
      }
      const prop = mlToString(k);
      const val = mlToString(v);
      let styles = this.props.get("styles");
      if (!(styles instanceof MLMap)) {
        styles = new MLMap();
        this.props.set("styles", styles);
      }
      styles.set(prop, val);
      if (this.el) this.el.style[prop] = val;
      return this;
    }

    _applyCommonProps(el) {
      const cls = this.propStr("class", "");
      if (cls) el.classList.add(...cls.split(/\s+/).filter(Boolean));
      const styleStr = this.propStr("style", "");
      if (styleStr) el.style.cssText += ";" + styleStr;
      const styles = this.props.get("styles");
      if (styles instanceof MLMap) {
        for (const [k, v] of styles.entries) el.style[mlToString(k)] = mlToString(v);
      }
      const gap = this.prop("gap");
      if (gap !== undefined) {
        el.style.gap = typeof gap === "string" ? gap : `${mlNumVal(gap)}px`;
      }
      const padding = this.prop("padding");
      if (padding !== undefined) {
        el.style.padding = typeof padding === "string" ? padding : `${mlNumVal(padding)}px`;
      }
      const width = this.prop("width");
      if (width !== undefined) {
        el.style.width = typeof width === "string" ? width : `${mlNumVal(width)}px`;
      }
      if (this.prop("visible") !== undefined && !this.propBool("visible", true)) {
        el.style.display = "none";
      }
    }

    render() {
      if (this.el) return this.el;
      let el;

      switch (this.kind) {
        case "vbox": {
          el = document.createElement("div");
          el.className = "mlui-vbox";
          this.bodyEl = el;
          for (const c of this.children.items) if (c instanceof MLUIWidget) el.appendChild(c.render());
          break;
        }
        case "hbox": {
          el = document.createElement("div");
          el.className = "mlui-hbox";
          this.bodyEl = el;
          for (const c of this.children.items) if (c instanceof MLUIWidget) el.appendChild(c.render());
          break;
        }
        case "grid": {
          el = document.createElement("div");
          el.className = "mlui-grid";
          const cols = this.propNum("columns", 2);
          el.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
          this.bodyEl = el;
          for (const c of this.children.items) if (c instanceof MLUIWidget) el.appendChild(c.render());
          break;
        }
        case "card": {
          el = document.createElement("div");
          el.className = "mlui-card";
          const title = this.propStr("title", "");
          if (title) {
            const hdr = document.createElement("div");
            hdr.className = "mlui-card-header";
            hdr.textContent = title;
            el.appendChild(hdr);
          }
          const body = document.createElement("div");
          body.className = "mlui-card-body";
          this.bodyEl = body;
          for (const c of this.children.items) if (c instanceof MLUIWidget) body.appendChild(c.render());
          el.appendChild(body);
          break;
        }
        case "panel": {
          el = document.createElement("div");
          el.className = "mlui-panel";
          this.bodyEl = el;
          for (const c of this.children.items) if (c instanceof MLUIWidget) el.appendChild(c.render());
          break;
        }
        case "form": {
          el = document.createElement("form");
          el.className = "mlui-form";
          this.bodyEl = el;
          this.controlEl = el;
          el.addEventListener("submit", (ev) => ev.preventDefault());
          for (const c of this.children.items) if (c instanceof MLUIWidget) el.appendChild(c.render());
          break;
        }
        case "tabs": {
          el = document.createElement("div");
          el.className = "mlui-tabs";
          const header = document.createElement("div");
          header.className = "mlui-tabs-header";
          const content = document.createElement("div");
          content.className = "mlui-tabs-content";
          const titles = this.props.get("titles");
          const titleList = titles instanceof MLList ? titles.items : [];
          const panes = [];
          const btns = [];
          this.children.items.forEach((child, idx) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = `mlui-tab-btn${idx === 0 ? " active" : ""}`;
            btn.textContent = titleList[idx] !== undefined ? mlToString(titleList[idx]) : `Tab ${idx + 1}`;
            const pane = document.createElement("div");
            pane.className = `mlui-tab-pane${idx === 0 ? "" : " hidden"}`;
            if (child instanceof MLUIWidget) pane.appendChild(child.render());
            btn.onclick = () => {
              btns.forEach((b, i) => b.classList.toggle("active", i === idx));
              panes.forEach((p, i) => p.classList.toggle("hidden", i !== idx));
            };
            btns.push(btn);
            panes.push(pane);
            header.appendChild(btn);
            content.appendChild(pane);
          });
          el.appendChild(header);
          el.appendChild(content);
          this.bodyEl = content;
          break;
        }
        case "heading": {
          const lvl = Math.min(4, Math.max(1, Math.trunc(this.propNum("level", 2))));
          el = document.createElement(`h${lvl}`);
          el.className = "mlui-heading";
          el.textContent = this.propStr("text", "");
          break;
        }
        case "label": {
          el = document.createElement("label");
          el.className = "mlui-label";
          if (this.children.items.length > 0) {
            const span = document.createElement("span");
            span.textContent = this.propStr("text", "");
            el.appendChild(span);
            for (const c of this.children.items) if (c instanceof MLUIWidget) el.appendChild(c.render());
          } else {
            el.textContent = this.propStr("text", "");
          }
          break;
        }
        case "text": {
          el = document.createElement("div");
          el.className = "mlui-text";
          el.textContent = this.propStr("text", "");
          break;
        }
        case "html": {
          el = document.createElement("div");
          el.className = "mlui-html";
          el.innerHTML = this.propStr("html", "");
          break;
        }
        case "divider": {
          el = document.createElement("hr");
          el.className = "mlui-divider";
          break;
        }
        case "badge": {
          el = document.createElement("span");
          const variant = this.propStr("variant", "info");
          el.className = `mlui-badge mlui-badge-${variant}`;
          el.textContent = this.propStr("text", "");
          break;
        }
        case "code": {
          el = document.createElement("pre");
          el.className = "mlui-code";
          el.textContent = this.propStr("text", "");
          break;
        }
        case "input":
        case "password":
        case "date":
        case "color": {
          el = document.createElement("input");
          el.type = this.kind === "input" ? "text" : this.kind;
          el.className = this.kind === "color" ? "mlui-color" : "mlui-input";
          const ph = this.propStr("placeholder", "");
          if (ph) el.placeholder = ph;
          const v = this.prop("value");
          if (v !== undefined) el.value = mlToString(v);
          if (this.propBool("disabled", false)) el.disabled = true;
          this.controlEl = el;
          break;
        }
        case "textarea": {
          el = document.createElement("textarea");
          el.className = "mlui-textarea";
          el.rows = this.propNum("rows", 4);
          const ph = this.propStr("placeholder", "");
          if (ph) el.placeholder = ph;
          const v = this.prop("value");
          if (v !== undefined) el.value = mlToString(v);
          if (this.propBool("disabled", false)) el.disabled = true;
          this.controlEl = el;
          break;
        }
        case "number": {
          el = document.createElement("input");
          el.type = "number";
          el.className = "mlui-input mlui-number";
          const v = this.prop("value");
          if (v !== undefined) el.value = mlToString(v);
          const min = this.propNum("min");
          const max = this.propNum("max");
          const step = this.propNum("step");
          if (min !== undefined) el.min = String(min);
          if (max !== undefined) el.max = String(max);
          if (step !== undefined) el.step = String(step);
          if (this.propBool("disabled", false)) el.disabled = true;
          this.controlEl = el;
          break;
        }
        case "slider": {
          el = document.createElement("div");
          el.className = "mlui-slider-wrap";
          const inp = document.createElement("input");
          inp.type = "range";
          inp.className = "mlui-slider";
          const min = this.propNum("min", 0);
          const max = this.propNum("max", 100);
          const step = this.propNum("step", 1);
          const val = this.propNum("value", min);
          inp.min = String(min);
          inp.max = String(max);
          inp.step = String(step);
          inp.value = String(val);
          const readout = document.createElement("span");
          readout.className = "mlui-slider-val";
          readout.textContent = String(val);
          inp.addEventListener("input", () => { readout.textContent = inp.value; });
          el.appendChild(inp);
          el.appendChild(readout);
          this.controlEl = inp;
          this._valueReadoutEl = readout;
          break;
        }
        case "checkbox": {
          el = document.createElement("label");
          el.className = "mlui-checkbox";
          const inp = document.createElement("input");
          inp.type = "checkbox";
          inp.checked = this.propBool("checked", false);
          if (this.propBool("disabled", false)) inp.disabled = true;
          const span = document.createElement("span");
          span.textContent = this.propStr("label", "");
          el.appendChild(inp);
          el.appendChild(span);
          this.controlEl = inp;
          break;
        }
        case "select": {
          el = document.createElement("select");
          el.className = "mlui-select";
          const opts = this.props.get("options");
          const curVal = this.propStr("value", "");
          if (opts instanceof MLList) {
            for (const item of opts.items) {
              const o = document.createElement("option");
              if (item instanceof MLTuple && item.items.length >= 2) {
                o.value = mlToString(item.items[0]);
                o.textContent = mlToString(item.items[1]);
              } else {
                const s = mlToString(item);
                o.value = s;
                o.textContent = s;
              }
              if (curVal && o.value === curVal) o.selected = true;
              el.appendChild(o);
            }
          } else if (opts instanceof MLMap) {
            for (const [k, v] of opts.entries) {
              const o = document.createElement("option");
              o.value = mlToString(k);
              o.textContent = mlToString(v);
              if (curVal && o.value === curVal) o.selected = true;
              el.appendChild(o);
            }
          }
          if (this.propBool("disabled", false)) el.disabled = true;
          this.controlEl = el;
          break;
        }
        case "radio": {
          el = document.createElement("div");
          el.className = "mlui-radio-group";
          const groupName = this.propStr("name", this.id);
          const curVal = this.propStr("value", "");
          const opts = this.props.get("options");
          const list = opts instanceof MLList ? opts.items : [];
          list.forEach((item, idx) => {
            const lbl = document.createElement("label");
            lbl.className = "mlui-radio";
            const inp = document.createElement("input");
            inp.type = "radio";
            inp.name = groupName;
            const s = mlToString(item);
            inp.value = s;
            if (curVal ? s === curVal : idx === 0) inp.checked = true;
            const span = document.createElement("span");
            span.textContent = s;
            lbl.appendChild(inp);
            lbl.appendChild(span);
            el.appendChild(lbl);
          });
          this.controlEl = el;
          break;
        }
        case "button": {
          el = document.createElement("button");
          el.type = this.propStr("type", "button");
          const variant = this.propStr("variant", "primary");
          el.className = `mlui-btn mlui-btn-${variant}`;
          el.textContent = this.propStr("label", "Button");
          if (this.propBool("disabled", false)) el.disabled = true;
          this.controlEl = el;
          break;
        }
        case "table": {
          el = document.createElement("div");
          el.className = "mlui-table-host";
          const raw = mlToPlainJs(this.props.get("data"));
          if (window.MlnbViz) {
            window.MlnbViz.mountTable(el, { title: this.propStr("title", ""), raw });
          }
          break;
        }
        case "chart": {
          el = document.createElement("div");
          el.className = "mlui-chart-host";
          const plain = mlToPlainJs(this.props.get("spec"));
          const spec = (plain && typeof plain === "object" && !Array.isArray(plain))
            ? plain
            : { type: "line", data: plain };
          if (!spec.title && this.propStr("title", "")) spec.title = this.propStr("title", "");
          if (window.MlnbViz) {
            window.MlnbViz.mountChart(el, spec);
          }
          break;
        }
        default: {
          el = document.createElement("div");
          el.className = "mlui-panel";
          el.textContent = this.propStr("text", `<${this.kind}>`);
        }
      }

      this.el = el;
      this._applyCommonProps(el);

      // Attach any event handlers defined before render
      for (const [evName, fn] of this.handlers.entries) {
        this._attachSingleHandler(mlToString(evName), fn);
      }
      return el;
    }
  }

  // --- MiniJS Bytecode VM ---
  class MinijsVM {
    constructor(mountRoot) {
      this.mountRoot = mountRoot;
      this.errorBanner = null;
      this.externals = this._buildExternals();
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
        const doInvokeFetch = async (retryOn401) => {
          const headers = { "Content-Type": "application/json" };
          try {
            const tok = window.MlnbAuth
              ? await window.MlnbAuth.getAccessToken()
              : window.localStorage?.getItem("mlnb_access_token");
            if (tok) headers["Authorization"] = `Bearer ${tok}`;
          } catch { /* ignore */ }
          const res = await fetch(`/invoke/${encodeURI(cleanPath)}`, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          });
          if (res.status === 401 && retryOn401) {
            let refreshed = false;
            try {
              if (window.MlnbAuth) {
                refreshed = await window.MlnbAuth.refresh();
              } else {
                const rt = window.localStorage?.getItem("mlnb_refresh_token");
                const rRes = await fetch("/api/auth/refresh", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(rt ? { refresh_token: rt } : {}),
                });
                if (rRes.ok) {
                  const rData = await rRes.json();
                  if (rData.access_token) window.localStorage?.setItem("mlnb_access_token", rData.access_token);
                  if (rData.refresh_token) window.localStorage?.setItem("mlnb_refresh_token", rData.refresh_token);
                  if (rData.expires_at) window.localStorage?.setItem("mlnb_access_exp", String(rData.expires_at));
                  refreshed = true;
                }
              }
            } catch { /* ignore */ }
            if (refreshed) return doInvokeFetch(false);
          }
          return res;
        };

        doInvokeFetch(true)
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

      const ext = {
        ui: uiModule,
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

  function mlToPlainJs(v) {
    v = mlDeref(v);
    if (isNil(v)) return null;
    if (v && v.__ml === "boolean") return !!v.v;
    if (v instanceof MLInt || v instanceof MLReal) return v.v;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    if (v instanceof MLList || v instanceof MLTuple || v instanceof MLSet) {
      return v.items.map(mlToPlainJs);
    }
    if (v instanceof MLMap) {
      const obj = {};
      for (const [k, val] of v.entries) {
        obj[mlToString(k)] = mlToPlainJs(val);
      }
      return obj;
    }
    return mlToString(v);
  }

  // =========================================================================
  // Shared Interactive Visualization Engine (Tables, Charts, CSV Parser)
  // =========================================================================
  const CHART_PALETTE = [
    "#7aa2f7", "#4ade80", "#f59e0b", "#c084fc", "#22d3ee", "#f87171", "#fb923c", "#a3e635",
  ];

  function escViz(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function parseCsv(text, delimiter = null) {
    const firstLine = (text || "").split(/\r?\n/)[0] || "";
    const sep = delimiter || (firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",");
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === sep) {
          row.push(coerceCell(field));
          field = "";
        } else if (ch === "\n") {
          row.push(coerceCell(field));
          if (row.length > 1 || row[0] !== "") rows.push(row);
          row = [];
          field = "";
        } else if (ch !== "\r") {
          field += ch;
        }
      }
    }
    if (field.length > 0 || row.length > 0) {
      row.push(coerceCell(field));
      if (row.length > 1 || row[0] !== "") rows.push(row);
    }
    if (rows.length === 0) return { columns: [], rows: [] };
    const columns = rows[0].map((c, idx) => String(c ?? `Col ${idx + 1}`));
    const body = rows.slice(1).map((r) => {
      const padded = r.slice(0, columns.length);
      while (padded.length < columns.length) padded.push(null);
      return padded;
    });
    return { columns, rows: body };
  }

  function coerceCell(raw) {
    const t = raw.trim();
    if (t === "") return "";
    if (/^-?\d+(\.\d+)?$/.test(t)) {
      const n = Number(t);
      if (Number.isFinite(n)) return n;
    }
    return raw;
  }

  function normalizeTablePayload(input) {
    if (!input) return { title: "", columns: [], rows: [] };
    if (typeof input === "string") {
      try { input = JSON.parse(input); } catch { return parseCsv(input); }
    }
    if (Array.isArray(input.columns) && Array.isArray(input.rows)) {
      return { title: input.title || "", columns: input.columns.map(String), rows: input.rows };
    }
    const raw = input.raw !== undefined ? input.raw : input;
    const title = input.title || "";
    if (Array.isArray(raw)) {
      if (raw.length === 0) return { title, columns: [], rows: [] };
      if (raw[0] && typeof raw[0] === "object" && !Array.isArray(raw[0])) {
        const colSet = [];
        for (const item of raw) {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            for (const k of Object.keys(item)) {
              if (!colSet.includes(k)) colSet.push(k);
            }
          }
        }
        const rows = raw.map((item) => colSet.map((k) => (item && typeof item === "object" ? item[k] ?? null : null)));
        return { title, columns: colSet, rows };
      }
      if (Array.isArray(raw[0])) {
        const maxCols = Math.max(...raw.map((r) => (Array.isArray(r) ? r.length : 1)));
        const columns = Array.from({ length: maxCols }, (_, i) => `Col ${i + 1}`);
        const rows = raw.map((r) => (Array.isArray(r) ? r : [r]));
        return { title, columns, rows };
      }
      return { title, columns: ["Index", "Value"], rows: raw.map((v, i) => [i + 1, v]) };
    }
    if (raw && typeof raw === "object") {
      return { title, columns: ["Key", "Value"], rows: Object.entries(raw) };
    }
    return { title, columns: ["Value"], rows: [[raw]] };
  }

  function mountTable(container, input, opts = {}) {
    const parsed = normalizeTablePayload(input);
    const pageSize = opts.pageSize || 50;
    let sortCol = -1;
    let sortDir = 1;
    let filterText = "";
    let page = 0;

    const card = document.createElement("div");
    card.className = "ml-table-card";

    const toolbar = document.createElement("div");
    toolbar.className = "ml-table-toolbar";
    const titleEl = document.createElement("span");
    titleEl.className = "ml-table-title";
    titleEl.textContent = parsed.title || `${parsed.rows.length} row${parsed.rows.length === 1 ? "" : "s"} × ${parsed.columns.length} col${parsed.columns.length === 1 ? "" : "s"}`;
    const filterInp = document.createElement("input");
    filterInp.className = "ml-table-filter";
    filterInp.type = "text";
    filterInp.placeholder = "Filter rows...";
    const csvBtn = document.createElement("button");
    csvBtn.type = "button";
    csvBtn.className = "tb-btn";
    csvBtn.style.cssText = "height:24px;font-size:11px;padding:0 8px";
    csvBtn.textContent = "CSV";
    csvBtn.title = "Download as CSV";
    toolbar.append(titleEl, filterInp, csvBtn);

    const wrap = document.createElement("div");
    wrap.className = "ml-table-wrap";
    const table = document.createElement("table");
    table.className = "ml-table";
    const thead = document.createElement("thead");
    const tbody = document.createElement("tbody");
    table.append(thead, tbody);
    wrap.appendChild(table);

    const footer = document.createElement("div");
    footer.className = "ml-table-footer";

    card.append(toolbar, wrap, footer);
    container.appendChild(card);

    function getProcessedRows() {
      let rows = parsed.rows;
      if (filterText) {
        const q = filterText.toLowerCase();
        rows = rows.filter((r) => r.some((cell) => String(cell ?? "").toLowerCase().includes(q)));
      }
      if (sortCol >= 0) {
        rows = rows.slice().sort((a, b) => {
          const av = a[sortCol];
          const bv = b[sortCol];
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          if (typeof av === "number" && typeof bv === "number") return (av - bv) * sortDir;
          return String(av).localeCompare(String(bv), undefined, { numeric: true }) * sortDir;
        });
      }
      return rows;
    }

    function render() {
      const proc = getProcessedRows();
      const totalPages = Math.max(1, Math.ceil(proc.length / pageSize));
      if (page >= totalPages) page = totalPages - 1;
      const start = page * pageSize;
      const slice = proc.slice(start, start + pageSize);

      thead.innerHTML = "";
      const trH = document.createElement("tr");
      parsed.columns.forEach((col, ci) => {
        const th = document.createElement("th");
        th.textContent = col;
        if (sortCol === ci) th.className = sortDir > 0 ? "sort-asc" : "sort-desc";
        th.onclick = () => {
          if (sortCol === ci) sortDir = -sortDir;
          else { sortCol = ci; sortDir = 1; }
          render();
        };
        trH.appendChild(th);
      });
      thead.appendChild(trH);

      tbody.innerHTML = "";
      if (!slice.length) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = Math.max(1, parsed.columns.length);
        td.className = "nil";
        td.textContent = parsed.rows.length === 0 ? "(empty table)" : "No matching rows";
        tr.appendChild(td);
        tbody.appendChild(tr);
      } else {
        for (const r of slice) {
          const tr = document.createElement("tr");
          for (let ci = 0; ci < parsed.columns.length; ci++) {
            const val = r[ci];
            const td = document.createElement("td");
            if (val === null || val === undefined) {
              td.className = "nil";
              td.textContent = "nil";
            } else if (typeof val === "number") {
              td.className = "num";
              td.textContent = String(val);
            } else if (typeof val === "object") {
              const s = JSON.stringify(val);
              td.textContent = s;
              td.title = s;
            } else {
              td.textContent = String(val);
              td.title = String(val);
            }
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
      }

      const end = Math.min(proc.length, start + slice.length);
      footer.innerHTML = `
        <span>${proc.length ? `${start + 1}–${end} of ${proc.length}` : "0 rows"}${proc.length !== parsed.rows.length ? ` (filtered from ${parsed.rows.length})` : ""}</span>
        <div style="display:flex;gap:6px;align-items:center">
          <button type="button" class="tb-btn tbl-prev" style="height:22px;font-size:11px;padding:0 7px" ${page <= 0 ? "disabled" : ""}>&larr;</button>
          <span>Page ${page + 1}/${totalPages}</span>
          <button type="button" class="tb-btn tbl-next" style="height:22px;font-size:11px;padding:0 7px" ${page + 1 >= totalPages ? "disabled" : ""}>&rarr;</button>
        </div>
      `;
      footer.querySelector(".tbl-prev")?.addEventListener("click", () => { if (page > 0) { page--; render(); } });
      footer.querySelector(".tbl-next")?.addEventListener("click", () => { if (page + 1 < totalPages) { page++; render(); } });
    }

    filterInp.addEventListener("input", () => {
      filterText = filterInp.value.trim();
      page = 0;
      render();
    });

    csvBtn.onclick = () => {
      const escCsv = (v) => {
        const s = v == null ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v));
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [parsed.columns.map(escCsv).join(",")];
      for (const r of getProcessedRows()) lines.push(r.map(escCsv).join(","));
      const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(parsed.title || "table").replace(/[^a-z0-9_-]+/gi, "_")}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    };

    render();
    return card;
  }

  function mountChart(container, inputSpec) {
    let spec = inputSpec;
    if (typeof spec === "string") {
      try { spec = JSON.parse(spec); } catch { spec = { type: "line", data: [] }; }
    }
    spec = spec || {};
    const type = String(spec.type || "line").toLowerCase();
    const colors = Array.isArray(spec.colors) && spec.colors.length ? spec.colors : CHART_PALETTE;

    const card = document.createElement("div");
    card.className = "ml-chart-card";
    if (spec.title) {
      const t = document.createElement("div");
      t.className = "ml-chart-title";
      t.textContent = spec.title;
      card.appendChild(t);
    }

    const tooltip = document.createElement("div");
    tooltip.className = "ml-chart-tooltip hidden";
    card.appendChild(tooltip);

    const W = 680;
    const H = 300;
    const pad = { top: 18, right: 22, bottom: 42, left: 54 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    // Normalize data into [{ name, points: [{ x, y, label }] }]
    let seriesList = [];
    const rawData = spec.data;

    if (type === "histogram" && Array.isArray(rawData)) {
      const nums = rawData.map((d) => (typeof d === "number" ? d : Number(spec.x ? d[spec.x] : d))).filter(Number.isFinite);
      const bins = Math.max(2, Math.min(40, Number(spec.bins) || Math.ceil(Math.sqrt(nums.length || 1))));
      if (nums.length) {
        const lo = Math.min(...nums);
        const hi = Math.max(...nums);
        const span = hi > lo ? (hi - lo) : 1;
        const counts = new Array(bins).fill(0);
        for (const v of nums) {
          const idx = Math.min(bins - 1, Math.floor(((v - lo) / span) * bins));
          counts[idx]++;
        }
        seriesList = [{
          name: spec.y_label || "Count",
          points: counts.map((c, i) => ({
            x: i,
            y: c,
            label: `${(lo + (i * span) / bins).toFixed(1)}–${(lo + ((i + 1) * span) / bins).toFixed(1)}`,
          })),
        }];
      }
    } else if (Array.isArray(spec.series)) {
      seriesList = spec.series.map((s, si) => ({
        name: s.name || `Series ${si + 1}`,
        points: (s.data || []).map((v, i) =>
          typeof v === "number"
            ? { x: i, y: v, label: (spec.labels && spec.labels[i]) || String(i + 1) }
            : { x: Number(v.x ?? i), y: Number(v.y ?? 0), label: String(v.label ?? v.x ?? (i + 1)) }
        ),
      }));
    } else if (Array.isArray(rawData) && rawData.length > 0) {
      if (typeof rawData[0] === "number") {
        seriesList = [{
          name: spec.y_label || "Value",
          points: rawData.map((y, i) => ({ x: i, y, label: (spec.labels && spec.labels[i]) || String(i + 1) })),
        }];
      } else if (typeof rawData[0] === "object" && rawData[0] !== null) {
        const keys = Object.keys(rawData[0]);
        const xKey = spec.x || keys.find((k) => typeof rawData[0][k] === "string") || keys[0];
        const yKeys = Array.isArray(spec.y)
          ? spec.y
          : (spec.y ? [spec.y] : keys.filter((k) => k !== xKey && typeof rawData[0][k] === "number"));
        const finalY = yKeys.length ? yKeys : [keys[keys.length - 1]];
        seriesList = finalY.map((yk) => ({
          name: yk,
          points: rawData.map((row, i) => ({
            x: typeof row[xKey] === "number" ? row[xKey] : i,
            y: Number(row[yk] ?? 0),
            label: String(row[xKey] ?? (i + 1)),
          })),
        }));
      }
    } else if (rawData && typeof rawData === "object") {
      seriesList = [{
        name: spec.y_label || "Value",
        points: Object.entries(rawData).map(([k, v], i) => ({ x: i, y: Number(v) || 0, label: k })),
      }];
    }

    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.classList.add("ml-chart-svg");

    function showTip(evt, text) {
      const rect = card.getBoundingClientRect();
      tooltip.textContent = text;
      tooltip.classList.remove("hidden");
      tooltip.style.left = `${Math.min(rect.width - 140, Math.max(8, evt.clientX - rect.left + 10))}px`;
      tooltip.style.top = `${Math.max(8, evt.clientY - rect.top - 28)}px`;
    }
    function hideTip() { tooltip.classList.add("hidden"); }

    const allPoints = seriesList.flatMap((s) => s.points);
    if (!allPoints.length) {
      const msg = document.createElement("div");
      msg.className = "log-empty";
      msg.textContent = "No numeric data to chart.";
      card.appendChild(msg);
      container.appendChild(card);
      return card;
    }

    if (type === "pie") {
      const pts = seriesList[0].points.filter((p) => p.y > 0);
      const total = pts.reduce((a, b) => a + b.y, 0) || 1;
      const cx = W / 2;
      const cy = H / 2;
      const r = Math.min(plotW, plotH) * 0.45;
      let angle = -Math.PI / 2;
      pts.forEach((p, idx) => {
        const frac = p.y / total;
        const next = angle + frac * Math.PI * 2;
        const x1 = cx + r * Math.cos(angle);
        const y1 = cy + r * Math.sin(angle);
        const x2 = cx + r * Math.cos(next);
        const y2 = cy + r * Math.sin(next);
        const large = frac > 0.5 ? 1 : 0;
        const path = document.createElementNS(ns, "path");
        path.setAttribute("d", `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`);
        path.setAttribute("fill", colors[idx % colors.length]);
        path.setAttribute("stroke", "var(--bg-cell)");
        path.setAttribute("stroke-width", "1.5");
        path.style.cursor = "pointer";
        path.addEventListener("mousemove", (e) => showTip(e, `${p.label}: ${p.y} (${(frac * 100).toFixed(1)}%)`));
        path.addEventListener("mouseleave", hideTip);
        svg.appendChild(path);
        angle = next;
      });
      card.appendChild(svg);
      const leg = document.createElement("div");
      leg.className = "ml-chart-legend";
      pts.forEach((p, idx) => {
        leg.innerHTML += `<span class="ml-chart-legend-item"><span class="ml-chart-swatch" style="background:${colors[idx % colors.length]}"></span>${escViz(p.label)} (${p.y})</span>`;
      });
      card.appendChild(leg);
      container.appendChild(card);
      return card;
    }

    const yVals = allPoints.map((p) => p.y);
    let yMin = Math.min(0, ...yVals);
    let yMax = Math.max(...yVals);
    if (type === "scatter" || type === "line") {
      yMin = Math.min(...yVals);
      if (yMin > 0 && yMin < yMax * 0.25) yMin = 0;
    }
    if (yMax === yMin) { yMax += 1; yMin -= 1; }
    const ySpan = yMax - yMin;
    const mapY = (y) => pad.top + plotH - ((y - yMin) / ySpan) * plotH;

    // Horizontal grid & Y axis labels
    const ticks = 5;
    for (let i = 0; i <= ticks; i++) {
      const val = yMin + (ySpan * i) / ticks;
      const py = mapY(val);
      const gl = document.createElementNS(ns, "line");
      gl.setAttribute("x1", pad.left);
      gl.setAttribute("x2", W - pad.right);
      gl.setAttribute("y1", py);
      gl.setAttribute("y2", py);
      gl.setAttribute("stroke", "var(--border-subtle)");
      gl.setAttribute("stroke-width", "1");
      svg.appendChild(gl);

      const txt = document.createElementNS(ns, "text");
      txt.setAttribute("x", pad.left - 8);
      txt.setAttribute("y", py + 4);
      txt.setAttribute("text-anchor", "end");
      txt.setAttribute("fill", "var(--text-muted)");
      txt.setAttribute("font-size", "10.5");
      txt.textContent = Number.isInteger(val) ? String(val) : val.toFixed(1);
      svg.appendChild(txt);
    }

    if (type === "bar" || type === "histogram") {
      const nCats = Math.max(...seriesList.map((s) => s.points.length));
      const groupW = plotW / Math.max(1, nCats);
      const barW = Math.max(4, (groupW * 0.74) / seriesList.length);
      const baseZero = mapY(Math.max(yMin, Math.min(yMax, 0)));

      seriesList.forEach((s, si) => {
        const color = colors[si % colors.length];
        s.points.forEach((p, i) => {
          const bx = pad.left + i * groupW + groupW * 0.13 + si * barW;
          const by = mapY(p.y);
          const bh = Math.max(1, Math.abs(baseZero - by));
          const rect = document.createElementNS(ns, "rect");
          rect.setAttribute("x", bx);
          rect.setAttribute("y", Math.min(by, baseZero));
          rect.setAttribute("width", Math.max(2, barW - 2));
          rect.setAttribute("height", bh);
          rect.setAttribute("rx", "2");
          rect.setAttribute("fill", color);
          rect.style.cursor = "pointer";
          rect.addEventListener("mousemove", (e) => showTip(e, `${s.name} · ${p.label}: ${p.y}`));
          rect.addEventListener("mouseleave", hideTip);
          svg.appendChild(rect);
        });
      });

      const step = Math.max(1, Math.ceil(nCats / 10));
      const refPts = seriesList[0].points;
      for (let i = 0; i < refPts.length; i += step) {
        const lx = pad.left + i * groupW + groupW / 2;
        const txt = document.createElementNS(ns, "text");
        txt.setAttribute("x", lx);
        txt.setAttribute("y", H - 14);
        txt.setAttribute("text-anchor", "middle");
        txt.setAttribute("fill", "var(--text-muted)");
        txt.setAttribute("font-size", "10.5");
        txt.textContent = String(refPts[i].label).slice(0, 14);
        svg.appendChild(txt);
      }
    } else {
      const xVals = allPoints.map((p) => p.x);
      let xMin = Math.min(...xVals);
      let xMax = Math.max(...xVals);
      if (xMax === xMin) xMax += 1;
      const mapX = (x) => pad.left + ((x - xMin) / (xMax - xMin)) * plotW;

      seriesList.forEach((s, si) => {
        const color = colors[si % colors.length];
        if (type === "line" || type === "area") {
          const d = s.points.map((p, i) => `${i === 0 ? "M" : "L"} ${mapX(p.x)} ${mapY(p.y)}`).join(" ");
          if (type === "area" && s.points.length > 1) {
            const firstX = mapX(s.points[0].x);
            const lastX = mapX(s.points[s.points.length - 1].x);
            const area = document.createElementNS(ns, "path");
            area.setAttribute("d", `${d} L ${lastX} ${pad.top + plotH} L ${firstX} ${pad.top + plotH} Z`);
            area.setAttribute("fill", color);
            area.setAttribute("opacity", "0.18");
            svg.appendChild(area);
          }
          const path = document.createElementNS(ns, "path");
          path.setAttribute("d", d);
          path.setAttribute("fill", "none");
          path.setAttribute("stroke", color);
          path.setAttribute("stroke-width", "2.2");
          svg.appendChild(path);
        }
        s.points.forEach((p) => {
          const dot = document.createElementNS(ns, "circle");
          dot.setAttribute("cx", mapX(p.x));
          dot.setAttribute("cy", mapY(p.y));
          dot.setAttribute("r", type === "scatter" ? "4.5" : "3.2");
          dot.setAttribute("fill", color);
          dot.style.cursor = "pointer";
          dot.addEventListener("mousemove", (e) => showTip(e, `${s.name} · (${p.label}, ${p.y})`));
          dot.addEventListener("mouseleave", hideTip);
          svg.appendChild(dot);
        });
      });

      const refPts = seriesList[0].points;
      const step = Math.max(1, Math.ceil(refPts.length / 8));
      for (let i = 0; i < refPts.length; i += step) {
        const txt = document.createElementNS(ns, "text");
        txt.setAttribute("x", mapX(refPts[i].x));
        txt.setAttribute("y", H - 14);
        txt.setAttribute("text-anchor", "middle");
        txt.setAttribute("fill", "var(--text-muted)");
        txt.setAttribute("font-size", "10.5");
        txt.textContent = String(refPts[i].label).slice(0, 12);
        svg.appendChild(txt);
      }
    }

    card.appendChild(svg);
    if (seriesList.length > 1) {
      const leg = document.createElement("div");
      leg.className = "ml-chart-legend";
      seriesList.forEach((s, si) => {
        leg.innerHTML += `<span class="ml-chart-legend-item"><span class="ml-chart-swatch" style="background:${colors[si % colors.length]}"></span>${escViz(s.name)}</span>`;
      });
      card.appendChild(leg);
    }

    container.appendChild(card);
    return card;
  }

  window.MlnbViz = { parseCsv, normalizeTablePayload, mountTable, mountChart };

  window.MinijsUI = {
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
})();
