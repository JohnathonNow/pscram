/**
 * Minilang MiniJS Runtime Value Types, Comparison/String Helpers,
 * Tagged JSON Conversion, and Bytecode Opcode Tables.
 */

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
  [Symbol.iterator]() { return this.items[Symbol.iterator](); }
}
class MLTuple {
  constructor(items = []) { this.__ml = "tuple"; this.items = items; }
  [Symbol.iterator]() { return this.items[Symbol.iterator](); }
}
class MLSet {
  constructor(items = []) { this.__ml = "set"; this.items = items; }
  [Symbol.iterator]() { return this.items[Symbol.iterator](); }
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

export {
  ML_NIL, ML_SOME, ML_BLANK,
  MLBool, ML_TRUE, ML_FALSE, mlBool,
  MLInt, MLReal, MLVar, MLMethod, MLList, MLTuple, MLSet, MLMap,
  MLNames, MLRange, MLChained, MLModule, MLNativeFn, MLClosure,
  MLPartial, MLRef, MLErrorVal, MLType, MLBytes, MLTime, MLUuid,
  isNil, mlDeref, mlNumVal, isNum, isIntVal, mlNumber,
  mlEquals, mlCompare, mlToString, mlTypeName,
  mlToTaggedJson, taggedJsonToMl, mlToPlainJs,
  OP, OP_KIND,
};
