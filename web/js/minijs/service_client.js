/**
 * Browser-side Minilang `service` module (`service::on`, `send`, `call`, `start`, `stop`, etc.).
 * Bridges `.ui` MiniJS VMs to server-side Background Services via REST + SSE.
 */

import {
  ML_NIL, MLMap, MLModule, MLNativeFn, MLClosure, MLErrorVal,
  isNum, mlDeref, mlNumVal, mlToString, mlToTaggedJson, taggedJsonToMl,
} from "./values.js";

/**
 * Shared authenticated fetch helper for MiniJS browser UIs (`exec` and `service::*`).
 * Automatically attaches Bearer tokens and retries once on HTTP 401 after refresh.
 */
export async function vmAuthFetch(url, options = {}, retryOn401 = true) {
  const headers = { ...(options.headers || {}) };
  try {
    const tok = (typeof window !== "undefined" && window.MlnbAuth)
      ? await window.MlnbAuth.getAccessToken()
      : (typeof window !== "undefined" ? window.localStorage?.getItem("mlnb_access_token") : null);
    if (tok) headers["Authorization"] = `Bearer ${tok}`;
  } catch { /* ignore */ }

  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 && retryOn401) {
    let refreshed = false;
    try {
      if (typeof window !== "undefined" && window.MlnbAuth) {
        refreshed = await window.MlnbAuth.refresh();
      } else if (typeof window !== "undefined") {
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
    if (refreshed) return vmAuthFetch(url, options, false);
  }
  return res;
}

export function createServiceModule(vm) {
  // --- Background Services & Cross-UI Messaging (`service::...`) ---
  const svcFetchJson = async (url, method = "GET", bodyObj = null) => {
    const res = await vmAuthFetch(url, {
      method,
      headers: bodyObj !== null ? { "Content-Type": "application/json" } : {},
      body: bodyObj !== null ? JSON.stringify(bodyObj) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  };

  const ensureServiceStream = (serviceName) => {
    let entry = vm._serviceStreams.get(serviceName);
    if (entry) return entry;
    entry = { es: null, handlers: new Map() };
    vm._serviceStreams.set(serviceName, entry);

    const openEs = () => {
      if (!vm._serviceStreams.has(serviceName)) return;
      if (vm.mountRoot && !vm.mountRoot.isConnected) {
        vm.disposeServices();
        return;
      }
      let qs = `client_id=${encodeURIComponent(vm.clientId)}`;
      try {
        const tok = window.localStorage?.getItem("mlnb_access_token");
        if (tok) qs += `&token=${encodeURIComponent(tok)}`;
      } catch { /* ignore */ }
      const url = `/api/services/${encodeURIComponent(serviceName)}/events?${qs}`;
      const es = new EventSource(url);
      entry.es = es;
      es.addEventListener("message", (ev) => {
        if (vm.mountRoot && !vm.mountRoot.isConnected) {
          vm.disposeServices();
          return;
        }
        let raw;
        try { raw = JSON.parse(ev.data); } catch { return; }
        const topic = String(raw.topic || "");
        const dataVal = taggedJsonToMl(raw.data);
        const msgMap = new MLMap([
          ["id", String(raw.id || "")],
          ["service", String(raw.service || serviceName)],
          ["from", String(raw.from || serviceName)],
          ["topic", topic],
          ["data", dataVal],
          ["timestamp", String(raw.timestamp || "")],
        ]);
        const specific = entry.handlers.get(topic);
        if (specific) {
          for (const fn of Array.from(specific)) vm.safeCall(fn, [dataVal, msgMap]);
        }
        const wild = entry.handlers.get("*");
        if (wild) {
          for (const fn of Array.from(wild)) vm.safeCall(fn, [dataVal, msgMap]);
        }
      });
    };
    openEs();
    return entry;
  };

  const serviceExports = {
    client_id: new MLNativeFn("service::client_id", () => vm.clientId),

    // service::on(service_name, topic, handler) OR service::on(service_name, handler)
    on: new MLNativeFn("service::on", (args) => {
      const { pos } = vm._splitArgs(args);
      if (pos.length < 2) throw new MLErrorVal("ArgumentError", "service::on requires (service, topic, handler) or (service, handler)");
      const svcName = mlToString(pos[0]);
      let topic = "*";
      let handler = null;
      if (pos.length === 2) {
        handler = pos[1];
      } else {
        topic = mlToString(pos[1]);
        handler = pos[2];
      }
      const entry = ensureServiceStream(svcName);
      if (!entry.handlers.has(topic)) entry.handlers.set(topic, new Set());
      entry.handlers.get(topic).add(handler);
      return new MLNativeFn("unsubscribe", () => {
        const set = entry.handlers.get(topic);
        if (set) {
          set.delete(handler);
          if (set.size === 0) entry.handlers.delete(topic);
        }
        if (entry.handlers.size === 0) {
          try { entry.es?.close(); } catch { /* ignore */ }
          vm._serviceStreams.delete(svcName);
        }
        return ML_NIL;
      });
    }),

    // service::off(service_name, topic?)
    off: new MLNativeFn("service::off", (args) => {
      const { pos } = vm._splitArgs(args);
      if (pos.length < 1) return ML_NIL;
      const svcName = mlToString(pos[0]);
      const entry = vm._serviceStreams.get(svcName);
      if (!entry) return ML_NIL;
      if (pos.length >= 2) {
        entry.handlers.delete(mlToString(pos[1]));
      } else {
        entry.handlers.clear();
      }
      if (entry.handlers.size === 0) {
        try { entry.es?.close(); } catch { /* ignore */ }
        vm._serviceStreams.delete(svcName);
      }
      return ML_NIL;
    }),

    // service::send(service_name, topic, data?, callback?)
    send: new MLNativeFn("service::send", (args) => {
      const { pos } = vm._splitArgs(args);
      if (pos.length < 2) throw new MLErrorVal("ArgumentError", "service::send requires (service, topic, data?, callback?)");
      const svcName = mlToString(pos[0]);
      const topic = mlToString(pos[1]);
      let dataVal = ML_NIL;
      let callback = null;
      if (pos.length === 3) {
        if (pos[2] instanceof MLClosure || pos[2] instanceof MLNativeFn) callback = pos[2];
        else dataVal = pos[2];
      } else if (pos.length >= 4) {
        dataVal = pos[2];
        callback = pos[3];
      }
      svcFetchJson(`/api/services/${encodeURIComponent(svcName)}/send`, "POST", {
        topic,
        from: vm.clientId,
        data: mlToTaggedJson(dataVal),
      })
        .then((res) => {
          if (callback) vm.safeCall(callback, [vm._plainJsonToMl(res.message || {}), ML_NIL]);
        })
        .catch((e) => {
          if (callback) vm.safeCall(callback, [ML_NIL, e.message || String(e)]);
          else vm.showError(e);
        });
      return ML_NIL;
    }),

    // service::call(service_name, topic, data?, callback?, timeout_ms?)
    call: new MLNativeFn("service::call", (args) => {
      const { pos, named } = vm._splitArgs(args);
      if (pos.length < 2) throw new MLErrorVal("ArgumentError", "service::call requires (service, topic, data?, callback?)");
      const svcName = mlToString(pos[0]);
      const topic = mlToString(pos[1]);
      let dataVal = ML_NIL;
      let callback = null;
      let timeoutMs = named.timeout_ms !== undefined ? Math.trunc(mlNumVal(named.timeout_ms)) : 15000;
      if (pos.length === 3) {
        if (pos[2] instanceof MLClosure || pos[2] instanceof MLNativeFn) callback = pos[2];
        else dataVal = pos[2];
      } else if (pos.length >= 4) {
        dataVal = pos[2];
        callback = pos[3];
        if (pos.length >= 5 && isNum(pos[4])) timeoutMs = Math.trunc(mlNumVal(pos[4]));
      }
      svcFetchJson(`/api/services/${encodeURIComponent(svcName)}/call`, "POST", {
        topic,
        from: vm.clientId,
        data: mlToTaggedJson(dataVal),
        timeout_ms: timeoutMs,
      })
        .then((res) => {
          if (callback) vm.safeCall(callback, [taggedJsonToMl(res.reply), ML_NIL]);
        })
        .catch((e) => {
          if (callback) vm.safeCall(callback, [ML_NIL, e.message || String(e)]);
          else vm.showError(e);
        });
      return ML_NIL;
    }),

    // service::list(callback)
    list: new MLNativeFn("service::list", (args) => {
      const { pos } = vm._splitArgs(args);
      const callback = pos[0] || null;
      svcFetchJson("/api/services", "GET")
        .then((res) => {
          if (callback) vm.safeCall(callback, [vm._plainJsonToMl(res.services || []), ML_NIL]);
        })
        .catch((e) => {
          if (callback) vm.safeCall(callback, [ML_NIL, e.message || String(e)]);
        });
      return ML_NIL;
    }),

    // service::status(service_name, callback)
    status: new MLNativeFn("service::status", (args) => {
      const { pos } = vm._splitArgs(args);
      if (pos.length < 1) return ML_NIL;
      const svcName = mlToString(pos[0]);
      const callback = pos[1] || null;
      svcFetchJson(`/api/services/${encodeURIComponent(svcName)}`, "GET")
        .then((res) => {
          if (callback) vm.safeCall(callback, [vm._plainJsonToMl(res.service || {}), ML_NIL]);
        })
        .catch((e) => {
          if (callback) vm.safeCall(callback, [ML_NIL, e.message || String(e)]);
        });
      return ML_NIL;
    }),

    // service::start(name, script, params?, callback?) OR service::start(script, callback?)
    start: new MLNativeFn("service::start", (args) => {
      const { pos } = vm._splitArgs(args);
      if (pos.length < 1) throw new MLErrorVal("ArgumentError", "service::start requires at least a script path");
      let name = null;
      let script = mlToString(pos[0]);
      let paramsMap = null;
      let callback = null;
      if (pos.length >= 2 && typeof mlDeref(pos[1]) === "string") {
        name = script;
        script = mlToString(pos[1]);
        if (pos.length === 3) {
          if (pos[2] instanceof MLClosure || pos[2] instanceof MLNativeFn) callback = pos[2];
          else if (pos[2] instanceof MLMap) paramsMap = pos[2];
        } else if (pos.length >= 4) {
          if (pos[2] instanceof MLMap) paramsMap = pos[2];
          callback = pos[3];
        }
      } else if (pos.length >= 2) {
        if (pos[1] instanceof MLClosure || pos[1] instanceof MLNativeFn) callback = pos[1];
        else if (pos[1] instanceof MLMap) {
          paramsMap = pos[1];
          if (pos.length >= 3) callback = pos[2];
        }
      }
      const body = { script };
      if (name) body.name = name;
      if (paramsMap instanceof MLMap) {
        const p = {};
        for (const [k, v] of paramsMap.entries) p[mlToString(k)] = mlToTaggedJson(v);
        body.params = p;
      }
      svcFetchJson("/api/services", "POST", body)
        .then((res) => {
          if (callback) vm.safeCall(callback, [vm._plainJsonToMl(res.service || {}), ML_NIL]);
        })
        .catch((e) => {
          if (callback) vm.safeCall(callback, [ML_NIL, e.message || String(e)]);
          else vm.showError(e);
        });
      return ML_NIL;
    }),

    // service::stop(service_name, callback?)
    stop: new MLNativeFn("service::stop", (args) => {
      const { pos } = vm._splitArgs(args);
      if (pos.length < 1) return ML_NIL;
      const svcName = mlToString(pos[0]);
      const callback = pos[1] || null;
      svcFetchJson(`/api/services/${encodeURIComponent(svcName)}/stop`, "POST", {})
        .then((res) => {
          if (callback) vm.safeCall(callback, [vm._plainJsonToMl(res.service || {}), ML_NIL]);
        })
        .catch((e) => {
          if (callback) vm.safeCall(callback, [ML_NIL, e.message || String(e)]);
        });
      return ML_NIL;
    }),

    // service::restart(service_name, callback?)
    restart: new MLNativeFn("service::restart", (args) => {
      const { pos } = vm._splitArgs(args);
      if (pos.length < 1) return ML_NIL;
      const svcName = mlToString(pos[0]);
      const callback = pos[1] || null;
      svcFetchJson(`/api/services/${encodeURIComponent(svcName)}/restart`, "POST", {})
        .then((res) => {
          if (callback) vm.safeCall(callback, [vm._plainJsonToMl(res.service || {}), ML_NIL]);
        })
        .catch((e) => {
          if (callback) vm.safeCall(callback, [ML_NIL, e.message || String(e)]);
        });
      return ML_NIL;
    }),
  };
  const serviceMod = new MLModule("service", serviceExports);
  return { serviceMod, serviceExports };
}
