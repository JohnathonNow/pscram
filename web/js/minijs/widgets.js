/**
 * Reactive DOM Widget tree (`MLUIWidget`) for Minilang UIs.
 */

import {
  ML_NIL, MLInt, MLReal, MLList, MLTuple, MLMap,
  isNil, mlBool, mlDeref, mlNumVal, mlToString, mlToPlainJs,
} from "./values.js";
import { MlnbViz } from "../viz/viz.js";

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
    if (this.el && this.kind === "table" && MlnbViz) {
      this.el.innerHTML = "";
      MlnbViz.mountTable(this.el, {
        title: this.propStr("title", ""),
        raw: mlToPlainJs(val),
      });
    }
    return this;
  }

  setSpec(val) {
    this.props.set("spec", val);
    if (this.el && this.kind === "chart" && MlnbViz) {
      this.el.innerHTML = "";
      const plain = mlToPlainJs(val);
      const spec = (plain && typeof plain === "object" && !Array.isArray(plain))
        ? plain
        : { type: "line", data: plain };
      if (!spec.title && this.propStr("title", "")) spec.title = this.propStr("title", "");
      MlnbViz.mountChart(this.el, spec);
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
        if (MlnbViz) {
          MlnbViz.mountTable(el, { title: this.propStr("title", ""), raw });
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
        if (MlnbViz) {
          MlnbViz.mountChart(el, spec);
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

export { MLUIWidget };
