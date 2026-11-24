/**
 * Script Editor Toolbar (`Run in Minilang`, `Launch UI`, `Open as Notebook`),
 * `/invoke` Tagged-JSON Tester Panel, and shared Run & Debug Params editor.
 */

import { escapeHtml } from "../core/highlight.js";
import { api, authFetch, authState, getStoredAccessToken } from "../core/auth.js";
import { toast } from "../core/ui_helpers.js";
import { state, langInfo, langByExtension, activeTab, markDirty, updateStatusBar } from "../core/state.js";
import { hydrateMediaPreviews } from "./media.js";
import {
  createUntitledNotebook,
  syncFileEditorHighlight,
  syncFileEditorScroll,
  saveActiveTab,
} from "./viewers.js";
import { ensureKernel, renderOutputHtml, hydrateUiDisplays } from "./notebook.js";
import { openFileAgyPanel, runFileAgy } from "./agy.js";

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

function buildInvokeRequestObject() {
  const raw = document.getElementById("invoke-params-textarea").value.trim() || "{}";
  const parsed = JSON.parse(raw);
  const fnName = document.getElementById("invoke-fn-input").value.trim();
  if (fnName) parsed.function = fnName;
  return parsed;
}

// =====================================================================
// Run & Debug Params Helpers (Shared between Run in Minilang & Debugger)
// =====================================================================
function parseRunParamsJson(rawText) {
  const trimmed = (rawText || "").trim();
  if (!trimmed) return { ok: true, params: {}, count: 0 };
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Params must be a JSON object (e.g. {\"name\": \"Ada\"})", count: 0 };
    }
    // If user pasted a full /invoke wrapper `{"params": {...}}`, unwrap automatically
    const keys = Object.keys(parsed);
    if (
      keys.length === 1 &&
      keys[0] === "params" &&
      parsed.params &&
      typeof parsed.params === "object" &&
      !Array.isArray(parsed.params)
    ) {
      return { ok: true, params: parsed.params, count: Object.keys(parsed.params).length };
    }
    return { ok: true, params: parsed, count: keys.length };
  } catch (e) {
    return { ok: false, error: e.message, count: 0 };
  }
}

function detectParamsTemplateFromCode(code) {
  const found = {};
  const re = /\bParams\s*\[\s*["']([^"']+)["']\s*\]/g;
  let m;
  while ((m = re.exec(code || "")) !== null) {
    if (!(m[1] in found)) found[m[1]] = "";
  }
  return found;
}

function getActiveRunParamsText() {
  const tab = activeTab();
  if (tab && tab.kind === "file") {
    return tab._paramsText || "";
  }
  const dbgTa = document.getElementById("dbg-params-textarea");
  return dbgTa ? dbgTa.value : "";
}

function updateParamsBadgesAndStatus(rawText) {
  const parsed = parseRunParamsJson(rawText);
  const ftbBadge = document.getElementById("ftb-params-badge");
  const dbgBadge = document.getElementById("dbg-params-badge");
  const fileTa = document.getElementById("file-params-textarea");
  const dbgTa = document.getElementById("dbg-params-textarea");
  const fileStatus = document.getElementById("file-params-status");
  const dbgStatus = document.getElementById("dbg-params-status");

  if (fileTa) fileTa.classList.toggle("is-invalid", !parsed.ok);
  if (dbgTa) dbgTa.classList.toggle("is-invalid", !parsed.ok);

  if (ftbBadge) {
    ftbBadge.textContent = parsed.ok ? String(parsed.count) : "!";
    ftbBadge.classList.toggle("hidden", parsed.ok && parsed.count === 0);
  }
  if (dbgBadge) {
    dbgBadge.textContent = parsed.ok ? String(parsed.count) : "!";
    dbgBadge.classList.toggle("hidden", parsed.ok && parsed.count === 0);
  }
  if (fileStatus) {
    if (!parsed.ok) {
      fileStatus.textContent = `Invalid JSON: ${parsed.error}`;
      fileStatus.style.color = "var(--accent-red)";
    } else if (parsed.count > 0) {
      fileStatus.textContent = `${parsed.count} parameter${parsed.count === 1 ? "" : "s"} active for Run & Debug`;
      fileStatus.style.color = "";
    } else {
      fileStatus.innerHTML = "Bound as <code>Params</code> map &amp; top-level identifiers for Run &amp; Debug";
      fileStatus.style.color = "";
    }
  }
  if (dbgStatus) {
    dbgStatus.classList.toggle("is-err", !parsed.ok);
    dbgStatus.textContent = !parsed.ok
      ? `Invalid JSON: ${parsed.error}`
      : parsed.count > 0
        ? `${parsed.count} parameter${parsed.count === 1 ? "" : "s"} will be bound on Start`
        : "Plain or tagged JSON object (bound as Params + identifiers)";
  }
}

function syncFileParamsPanelForTab(tab) {
  const panel = document.getElementById("file-params-panel");
  const fileTa = document.getElementById("file-params-textarea");
  const dbgTa = document.getElementById("dbg-params-textarea");
  const btn = document.getElementById("ftb-params");
  const txt = (tab && tab._paramsText) || "";
  if (panel) panel.classList.toggle("hidden", !(tab && tab._paramsOpen));
  if (btn) btn.classList.toggle("active", !!(tab && tab._paramsOpen));
  if (fileTa && fileTa.value !== txt) fileTa.value = txt;
  if (dbgTa && dbgTa.value !== txt) dbgTa.value = txt;
  updateParamsBadgesAndStatus(txt);
}

function openFileParamsPanel(tab, open) {
  if (!tab || tab.kind !== "file") return;
  tab._paramsOpen = open;
  if (open && !tab._paramsText) {
    const detected = detectParamsTemplateFromCode(tab.content || "");
    if (Object.keys(detected).length > 0) {
      tab._paramsText = JSON.stringify(detected, null, 2);
    }
  }
  syncFileParamsPanelForTab(tab);
  if (open) document.getElementById("file-params-textarea")?.focus();
}

function setRunParamsText(nextText) {
  const tab = activeTab();
  if (tab && tab.kind === "file") {
    tab._paramsText = nextText;
  }
  const fileTa = document.getElementById("file-params-textarea");
  const dbgTa = document.getElementById("dbg-params-textarea");
  if (fileTa && fileTa.value !== nextText) fileTa.value = nextText;
  if (dbgTa && dbgTa.value !== nextText) dbgTa.value = nextText;
  updateParamsBadgesAndStatus(nextText);
}

export function initScriptTools() {
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
    let runParams = undefined;
    if (fileLang.id === "minilang") {
      const parsed = parseRunParamsJson(tab._paramsText || "");
      if (!parsed.ok) {
        toast(`Invalid Params JSON: ${parsed.error}`, "error");
        openFileParamsPanel(tab, true);
        return;
      }
      runParams = parsed.params || {};
    }
    outPane.classList.remove("hidden");
    outBody.innerHTML = `<span style="color:var(--text-muted)">Running ${escapeHtml(tab.title)} (${escapeHtml(fileLang.name)})...</span>`;
    try {
      const kId = `script-${tab.id.slice(0, 8)}`;
      const dir = tab.path && tab.path.includes("/") ? tab.path.slice(0, tab.path.lastIndexOf("/")) : "";
      await ensureKernel(kId, dir, fileLang.id);
      await api(`/api/kernels/${encodeURIComponent(kId)}/restart`, { method: "POST" });
      const reqBody = { code: tab.content, source: tab.title, language: fileLang.id };
      if (runParams !== undefined) reqBody.params = runParams;
      const resp = await api(`/api/kernels/${encodeURIComponent(kId)}/execute`, {
        method: "POST",
        body: JSON.stringify(reqBody),
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


  document.getElementById("ftb-params")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab.kind !== "file") return;
    openFileParamsPanel(tab, !tab._paramsOpen);
  });
  document.getElementById("btn-file-params-close")?.addEventListener("click", () => {
    const tab = activeTab();
    if (tab && tab.kind === "file") openFileParamsPanel(tab, false);
  });
  document.getElementById("btn-file-params-clear")?.addEventListener("click", () => {
    setRunParamsText("");
  });
  document.getElementById("btn-file-params-detect")?.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab || tab.kind !== "file") return;
    const detected = detectParamsTemplateFromCode(tab.content || "");
    const keys = Object.keys(detected);
    if (!keys.length) {
      toast('No Params["..."] references found in script', "info");
      if (!tab._paramsText) setRunParamsText("{\n  \n}");
      return;
    }
    setRunParamsText(JSON.stringify(detected, null, 2));
    toast(`Detected ${keys.length} param key${keys.length === 1 ? "" : "s"}: ${keys.join(", ")}`, "success");
  });
  document.getElementById("btn-file-params-run")?.addEventListener("click", () => {
    document.getElementById("ftb-run-mini")?.click();
  });
  document.getElementById("btn-file-params-debug")?.addEventListener("click", () => {
    document.getElementById("ftb-debug")?.click();
  });
  document.getElementById("file-params-textarea")?.addEventListener("input", (e) => {
    setRunParamsText(e.target.value);
  });
  document.getElementById("dbg-params-textarea")?.addEventListener("input", (e) => {
    setRunParamsText(e.target.value);
  });
}

export {
  defaultInvokePayloadFor,
  buildInvokeRequestObject,
  parseRunParamsJson,
  detectParamsTemplateFromCode,
  getActiveRunParamsText,
  updateParamsBadgesAndStatus,
  syncFileParamsPanelForTab,
  openFileParamsPanel,
  setRunParamsText,
};
