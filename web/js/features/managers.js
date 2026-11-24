/**
 * Workbench Manager Modals & Global Search:
 * - Background Jobs, Services & Active Sessions Manager
 * - Scheduled Jobs & Webhooks Manager
 * - Encrypted Workspace Secrets Vault
 * - Command Palette (Ctrl+Shift+P) & Find in Files (Ctrl+Shift+F)
 */

import { escapeHtml } from "../core/highlight.js";
import { api, authState } from "../core/auth.js";
import { toast, showModal, copyTextToClipboard } from "../core/ui_helpers.js";
import { state, langInfo, activeTab } from "../core/state.js";
import { loadDirectory, promptNewNotebook, promptNewUi, promptNewFile, promptNewFolder } from "./files.js";
import { openPathInTab, activateTab, saveActiveTab } from "./viewers.js";
import { runAllCells, restartKernel, interruptKernel, refreshKernelList, selectCell } from "./notebook.js";
import { parseRunParamsJson, openFileParamsPanel } from "./script_tools.js";
import { toggleDebugDrawer, startDebuggingActive } from "./debugger.js";

// =========================================================================
// Background Jobs & Active Sessions Manager
// =========================================================================
let jobsActiveTab = "bg";
let jobsPollTimer = null;

async function refreshJobsBadge() {
  try {
    const data = await api("/api/jobs");
    const badge = document.getElementById("jobs-active-badge");
    if (!badge) return;
    const running = data.running || 0;
    badge.textContent = String(running);
    badge.classList.toggle("hidden", running === 0);
  } catch { /* ignore */ }
}

async function launchBackgroundJobQuick(scriptPath) {
  try {
    const res = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ script: scriptPath, source: "ui" }),
    });
    toast(`Started background job ${res.job.id} (${scriptPath})`, "success");
    refreshJobsBadge();
    openJobsModal("bg");
  } catch (err) {
    toast(`Failed to start job: ${err.message}`, "error");
  }
}

async function loadJobsAndSessions() {
  const [jobsRes, svcsRes, kernelsRes] = await Promise.all([
    api("/api/jobs").catch(() => ({ jobs: [], running: 0 })),
    api("/api/services").catch(() => ({ services: [], running: 0 })),
    api("/api/kernels").catch(() => ({ kernels: [] })),
  ]);

  const jobs = jobsRes.jobs || [];
  const services = svcsRes.services || [];
  const kernels = kernelsRes.kernels || [];
  const runningJobs = jobsRes.running || 0;
  const runningSvcs = svcsRes.running || 0;
  const totalRunning = runningJobs + runningSvcs;

  const bgCnt = document.getElementById("jobs-tab-bg-count");
  const svcCnt = document.getElementById("jobs-tab-svc-count");
  const sessCnt = document.getElementById("jobs-tab-sess-count");
  if (bgCnt) bgCnt.textContent = runningJobs > 0 ? `${runningJobs}/${jobs.length}` : String(jobs.length);
  if (svcCnt) svcCnt.textContent = runningSvcs > 0 ? `${runningSvcs}/${services.length}` : String(services.length);
  if (sessCnt) sessCnt.textContent = String(kernels.length);
  const badge = document.getElementById("jobs-active-badge");
  if (badge) {
    badge.textContent = String(totalRunning);
    badge.classList.toggle("hidden", totalRunning === 0);
  }

  // Render Background Jobs
  const jobsList = document.getElementById("jobs-list");
  if (jobsList) {
    if (!jobs.length) {
      jobsList.innerHTML = `<div class="log-empty">No background jobs yet. Launch a <code>.mini</code> script above, right-click a script, or call <code>jobs::start("scripts/worker.mini")</code> in Minilang.</div>`;
    } else {
      jobsList.innerHTML = jobs.map((j) => {
        const pillCls = j.status === "running" ? "running" : (j.status === "completed" ? "ok" : (j.status === "cancelled" ? "paused" : "err"));
        const dur = j.duration_ms >= 1000 ? `${(j.duration_ms / 1000).toFixed(2)}s` : `${j.duration_ms.toFixed(0)} ms`;
        const progHtml = j.progress ? `
          <div class="ml-progress-card" style="max-width:none;padding:6px 9px">
            <div class="ml-progress-head" style="margin-bottom:4px">
              <span>${escapeHtml(j.progress.label || "Progress")}</span>
              <span>${j.progress.done}/${j.progress.total} (${Math.round(j.progress.percent)}%)</span>
            </div>
            <div class="ml-progress-track"><div class="ml-progress-fill" style="width:${Math.max(0, Math.min(100, j.progress.percent))}%"></div></div>
          </div>` : "";
        const outParts = [];
        if (j.stdout) outParts.push(`<pre class="job-output-box">${escapeHtml(j.stdout)}</pre>`);
        if (j.error) outParts.push(`<pre class="job-output-box is-err">${escapeHtml(j.error)}</pre>`);
        else if (j.status === "completed" && j.repr && j.repr !== "nil") {
          outParts.push(`<pre class="job-output-box">Result: ${escapeHtml(j.repr)}</pre>`);
        }
        return `
          <div class="job-card">
            <div class="job-card-top">
              <div class="manager-item-main">
                <div class="manager-item-title">
                  <span>${escapeHtml(j.name)}</span>
                  <span class="status-pill ${pillCls}">${escapeHtml(j.status)}</span>
                  <span class="tb-meta">${escapeHtml(j.id)}</span>
                </div>
                <div class="manager-item-sub">${escapeHtml(j.script)} · ${escapeHtml(j.language)} · ${escapeHtml(dur)}${j.pid ? ` · pid ${j.pid}` : ""} · via ${escapeHtml(j.source)}</div>
              </div>
              <div class="manager-item-actions">
                ${j.status === "running"
                  ? `<button type="button" class="tb-btn danger-hover job-act-stop" data-id="${escapeHtml(j.id)}">Stop</button>`
                  : `<button type="button" class="tb-btn job-act-log" data-log="${escapeHtml(j.log_path)}">Log</button>
                     <button type="button" class="tb-btn danger-hover job-act-del" data-id="${escapeHtml(j.id)}">Remove</button>`}
              </div>
            </div>
            ${progHtml}
            ${outParts.join("")}
          </div>`;
      }).join("");

      jobsList.querySelectorAll(".job-act-stop").forEach((b) => {
        b.onclick = async () => {
          await api(`/api/jobs/${encodeURIComponent(b.dataset.id)}/stop`, { method: "POST" });
          toast(`Stopped job ${b.dataset.id}`, "info");
          loadJobsAndSessions();
        };
      });
      jobsList.querySelectorAll(".job-act-log").forEach((b) => {
        b.onclick = () => {
          closeJobsModal();
          openPathInTab(b.dataset.log);
        };
      });
      jobsList.querySelectorAll(".job-act-del").forEach((b) => {
        b.onclick = async () => {
          await api(`/api/jobs/${encodeURIComponent(b.dataset.id)}`, { method: "DELETE" });
          loadJobsAndSessions();
        };
      });
    }
  }

  // Render Background Services
  const svcList = document.getElementById("services-list");
  if (svcList) {
    if (!services.length) {
      svcList.innerHTML = `<div class="log-empty">No background services running. Start a <code>.mini</code> script above, click <strong>Service</strong> in a script editor, or call <code>service::start("name", "script.mini")</code>. UIs connect via <code>service::on</code>, <code>service::send</code>, and <code>service::call</code>.</div>`;
    } else {
      svcList.innerHTML = services.map((s) => {
        const pillCls = s.status === "running" ? "running" : (s.status === "stopped" ? "paused" : "err");
        const outParts = [];
        if (s.stdout) outParts.push(`<pre class="job-output-box">${escapeHtml(s.stdout)}</pre>`);
        if (s.error) outParts.push(`<pre class="job-output-box is-err">${escapeHtml(s.error)}</pre>`);
        const sendForm = s.status === "running" ? `
          <form class="svc-send-form" data-svc="${escapeHtml(s.name)}" style="display:flex;gap:6px;margin-top:2px">
            <input class="modal-input svc-send-topic" type="text" placeholder="topic (e.g. ping)" style="flex:0 0 140px;height:26px;font-size:11.5px" required />
            <input class="modal-input svc-send-data" type="text" placeholder='data JSON (e.g. {"by":1})' style="flex:1;height:26px;font-size:11.5px" />
            <button type="submit" class="tb-btn" style="height:26px;font-size:11.5px">Send</button>
          </form>` : "";
        return `
          <div class="job-card">
            <div class="job-card-top">
              <div class="manager-item-main">
                <div class="manager-item-title">
                  <span>${escapeHtml(s.name)}</span>
                  <span class="status-pill ${pillCls}">${escapeHtml(s.status)}</span>
                  <span class="tb-meta">${s.subscriber_count} UI${s.subscriber_count === 1 ? "" : "s"} · ${s.messages_in} in / ${s.messages_out} out</span>
                </div>
                <div class="manager-item-sub">${escapeHtml(s.script)}${s.pid ? ` · pid ${s.pid}` : ""} · id ${escapeHtml(s.id)}</div>
              </div>
              <div class="manager-item-actions">
                <button type="button" class="tb-btn svc-act-restart" data-name="${escapeHtml(s.name)}">Restart</button>
                ${s.status === "running"
                  ? `<button type="button" class="tb-btn danger-hover svc-act-stop" data-name="${escapeHtml(s.name)}">Stop</button>`
                  : `<button type="button" class="tb-btn danger-hover svc-act-del" data-name="${escapeHtml(s.name)}">Remove</button>`}
              </div>
            </div>
            ${sendForm}
            ${outParts.join("")}
          </div>`;
      }).join("");

      svcList.querySelectorAll(".svc-act-stop").forEach((b) => {
        b.onclick = async () => {
          await api(`/api/services/${encodeURIComponent(b.dataset.name)}/stop`, { method: "POST" });
          toast(`Stopped service '${b.dataset.name}'`, "info");
          loadJobsAndSessions();
        };
      });
      svcList.querySelectorAll(".svc-act-restart").forEach((b) => {
        b.onclick = async () => {
          await api(`/api/services/${encodeURIComponent(b.dataset.name)}/restart`, { method: "POST" });
          toast(`Restarted service '${b.dataset.name}'`, "success");
          loadJobsAndSessions();
        };
      });
      svcList.querySelectorAll(".svc-act-del").forEach((b) => {
        b.onclick = async () => {
          await api(`/api/services/${encodeURIComponent(b.dataset.name)}`, { method: "DELETE" });
          loadJobsAndSessions();
        };
      });
      svcList.querySelectorAll(".svc-send-form").forEach((form) => {
        form.onsubmit = async (ev) => {
          ev.preventDefault();
          const svcName = form.dataset.svc;
          const topic = form.querySelector(".svc-send-topic").value.trim();
          const rawData = form.querySelector(".svc-send-data").value.trim();
          let data = null;
          if (rawData) {
            try { data = JSON.parse(rawData); } catch (err) {
              toast(`Invalid JSON data: ${err.message}`, "error");
              return;
            }
          }
          try {
            await api(`/api/services/${encodeURIComponent(svcName)}/send`, {
              method: "POST",
              body: JSON.stringify({ topic, data, from: "workbench" }),
            });
            toast(`Sent '${topic}' to service '${svcName}'`, "success");
            form.querySelector(".svc-send-topic").value = "";
            form.querySelector(".svc-send-data").value = "";
            loadJobsAndSessions();
          } catch (err) {
            toast(`Send failed: ${err.message}`, "error");
          }
        };
      });
    }
  }

  // Render Active Kernel Sessions
  const sessList = document.getElementById("sessions-list");
  if (sessList) {
    if (!kernels.length) {
      sessList.innerHTML = `<div class="log-empty">No active notebook kernel sessions.</div>`;
    } else {
      sessList.innerHTML = kernels.map((k) => {
        const linkedTab = state.tabs.find((t) => t.kernelId === k.id);
        const title = linkedTab ? linkedTab.title : k.id;
        const stCls = !k.alive ? "err" : (k.busy ? "running" : "ok");
        const stText = !k.alive ? "stopped" : (k.busy ? "busy" : "idle");
        return `
          <div class="manager-item">
            <div class="manager-item-main">
              <div class="manager-item-title">
                <span>${escapeHtml(title)}</span>
                <span class="status-pill ${stCls}">${stText}</span>
                <span class="tb-meta">${escapeHtml(langInfo(k.language).name)}</span>
              </div>
              <div class="manager-item-sub">id: ${escapeHtml(k.id)} · pid ${k.pid} · In[${k.execution_count}] · ${escapeHtml(k.cwd || "")}</div>
            </div>
            <div class="manager-item-actions">
              ${linkedTab ? `<button type="button" class="tb-btn sess-act-focus" data-tab="${escapeHtml(linkedTab.id)}">Open Tab</button>` : ""}
              <button type="button" class="tb-btn sess-act-int" data-id="${escapeHtml(k.id)}">Interrupt</button>
              <button type="button" class="tb-btn sess-act-rst" data-id="${escapeHtml(k.id)}">Restart</button>
              <button type="button" class="tb-btn danger-hover sess-act-kill" data-id="${escapeHtml(k.id)}">Kill</button>
            </div>
          </div>`;
      }).join("");

      sessList.querySelectorAll(".sess-act-focus").forEach((b) => {
        b.onclick = () => {
          closeJobsModal();
          activateTab(b.dataset.tab);
        };
      });
      sessList.querySelectorAll(".sess-act-int").forEach((b) => {
        b.onclick = async () => {
          await api(`/api/kernels/${encodeURIComponent(b.dataset.id)}/interrupt`, { method: "POST" });
          toast(`Interrupted session ${b.dataset.id}`, "info");
          loadJobsAndSessions();
        };
      });
      sessList.querySelectorAll(".sess-act-rst").forEach((b) => {
        b.onclick = async () => {
          await api(`/api/kernels/${encodeURIComponent(b.dataset.id)}/restart`, { method: "POST" });
          toast(`Restarted session ${b.dataset.id}`, "success");
          refreshKernelList();
          loadJobsAndSessions();
        };
      });
      sessList.querySelectorAll(".sess-act-kill").forEach((b) => {
        b.onclick = async () => {
          await api(`/api/kernels/${encodeURIComponent(b.dataset.id)}`, { method: "DELETE" });
          toast(`Terminated session ${b.dataset.id}`, "info");
          refreshKernelList();
          loadJobsAndSessions();
        };
      });
    }
  }
}

function setJobsModalTab(tabName) {
  jobsActiveTab = (tabName === "sessions" || tabName === "services") ? tabName : "bg";
  document.getElementById("jobs-tab-bg")?.classList.toggle("active", jobsActiveTab === "bg");
  document.getElementById("jobs-tab-services")?.classList.toggle("active", jobsActiveTab === "services");
  document.getElementById("jobs-tab-sessions")?.classList.toggle("active", jobsActiveTab === "sessions");
  document.getElementById("jobs-pane-bg")?.classList.toggle("hidden", jobsActiveTab !== "bg");
  document.getElementById("jobs-pane-services")?.classList.toggle("hidden", jobsActiveTab !== "services");
  document.getElementById("jobs-pane-sessions")?.classList.toggle("hidden", jobsActiveTab !== "sessions");
  document.getElementById("jobs-clear-btn")?.classList.toggle("hidden", jobsActiveTab !== "bg");
}

function openJobsModal(tabName = "bg") {
  setJobsModalTab(tabName);
  document.getElementById("jobs-modal-overlay")?.classList.remove("hidden");
  loadJobsAndSessions();
  if (jobsPollTimer) clearInterval(jobsPollTimer);
  jobsPollTimer = setInterval(() => {
    const ov = document.getElementById("jobs-modal-overlay");
    if (ov && !ov.classList.contains("hidden")) {
      loadJobsAndSessions();
    }
  }, 1500);
}

function closeJobsModal() {
  document.getElementById("jobs-modal-overlay")?.classList.add("hidden");
  if (jobsPollTimer) {
    clearInterval(jobsPollTimer);
    jobsPollTimer = null;
  }
}

// =========================================================================
// Scheduled Jobs & Webhooks Modal (#2)
// =========================================================================
async function loadSchedulesList() {
  const listEl = document.getElementById("schedules-list");
  listEl.innerHTML = `<div class="log-empty">Loading schedules...</div>`;
  try {
    const data = await api("/api/schedules");
    const jobs = data.schedules || [];
    if (!jobs.length) {
      listEl.innerHTML = `<div class="log-empty">No scheduled jobs yet. Add one above or right-click any <code>.mini</code> / <code>.rs</code> script.</div>`;
      return;
    }
    listEl.innerHTML = jobs.map((j) => {
      const triggerText = j.cron ? `cron: ${j.cron}` : (j.interval_secs ? `every ${j.interval_secs}s` : "webhook / manual only");
      const pillCls = !j.enabled ? "paused" : (j.last_status === "ok" ? "ok" : (j.last_status ? "err" : "paused"));
      const pillText = !j.enabled ? "Paused" : (j.last_status ? `${j.last_status} (${j.run_count})` : "Active");
      return `
        <div class="manager-item">
          <div class="manager-item-main">
            <div class="manager-item-title">
              <span>${escapeHtml(j.name)}</span>
              <span class="status-pill ${pillCls}">${escapeHtml(pillText)}</span>
            </div>
            <div class="manager-item-sub">${escapeHtml(j.script)} · ${escapeHtml(triggerText)}${j.last_run_at ? ` · last: ${escapeHtml(j.last_run_at.slice(0, 19).replace("T", " "))}` : ""}</div>
          </div>
          <div class="manager-item-actions">
            <button type="button" class="tb-btn sched-act-run" data-id="${escapeHtml(j.id)}">Run Now</button>
            <button type="button" class="tb-btn sched-act-toggle" data-id="${escapeHtml(j.id)}">${j.enabled ? "Pause" : "Resume"}</button>
            <button type="button" class="tb-btn sched-act-hook" data-token="${escapeHtml(j.webhook_token)}" title="Copy POST webhook URL">Webhook</button>
            <button type="button" class="tb-btn sched-act-log" data-log="${escapeHtml(j.log_path)}">Log</button>
            <button type="button" class="tb-btn danger-hover sched-act-del" data-id="${escapeHtml(j.id)}">Delete</button>
          </div>
        </div>`;
    }).join("");

    listEl.querySelectorAll(".sched-act-run").forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        b.textContent = "Running...";
        try {
          const res = await api(`/api/schedules/${encodeURIComponent(b.dataset.id)}/run`, { method: "POST" });
          toast(res.ok ? `Job succeeded (${res.duration_ms.toFixed(0)} ms)` : `Job failed: ${res.error}`, res.ok ? "success" : "error");
          loadSchedulesList();
        } catch (err) {
          toast(err.message, "error");
          loadSchedulesList();
        }
      };
    });
    listEl.querySelectorAll(".sched-act-toggle").forEach((b) => {
      b.onclick = async () => {
        await api(`/api/schedules/${encodeURIComponent(b.dataset.id)}/toggle`, { method: "POST" });
        loadSchedulesList();
      };
    });
    listEl.querySelectorAll(".sched-act-hook").forEach((b) => {
      b.onclick = () => {
        const url = `${window.location.origin}/api/webhooks/${b.dataset.token}`;
        copyTextToClipboard(url, "Copied webhook POST URL");
      };
    });
    listEl.querySelectorAll(".sched-act-log").forEach((b) => {
      b.onclick = () => {
        closeSchedulesModal();
        openPathInTab(b.dataset.log);
      };
    });
    listEl.querySelectorAll(".sched-act-del").forEach((b) => {
      b.onclick = async () => {
        await api(`/api/schedules/${encodeURIComponent(b.dataset.id)}`, { method: "DELETE" });
        toast("Deleted schedule", "info");
        loadSchedulesList();
      };
    });
  } catch (err) {
    listEl.innerHTML = `<div class="log-empty">Failed to load schedules: ${escapeHtml(err.message)}</div>`;
  }
}

function openSchedulesModal(prefillScript = "") {
  const ov = document.getElementById("schedules-modal-overlay");
  ov?.classList.remove("hidden");
  if (prefillScript) {
    const sInp = document.getElementById("sched-script");
    const nInp = document.getElementById("sched-name");
    if (sInp) sInp.value = prefillScript;
    if (nInp && !nInp.value) nInp.value = prefillScript.split("/").pop();
  }
  loadSchedulesList();
}
function closeSchedulesModal() {
  document.getElementById("schedules-modal-overlay")?.classList.add("hidden");
}


// =========================================================================
// Encrypted Secrets Vault Modal (#8)
// =========================================================================
async function loadSecretsList() {
  const listEl = document.getElementById("secrets-list");
  listEl.innerHTML = `<div class="log-empty">Loading secrets...</div>`;
  try {
    const data = await api("/api/secrets");
    const secrets = data.secrets || [];
    if (!secrets.length) {
      listEl.innerHTML = `<div class="log-empty">No secrets stored yet. Add one above to inject it into kernels &amp; /invoke scripts.</div>`;
      return;
    }
    listEl.innerHTML = secrets.map((s) => `
      <div class="manager-item">
        <div class="manager-item-main">
          <div class="manager-item-title">
            <code>${escapeHtml(s.name)}</code>
            <span class="tb-meta">${escapeHtml(s.masked)}</span>
          </div>
          <div class="manager-item-sub">${escapeHtml(s.description || "No description")} · updated ${escapeHtml((s.updated_at || "").slice(0, 19).replace("T", " "))}</div>
        </div>
        <div class="manager-item-actions">
          <button type="button" class="tb-btn sec-act-copy" data-name="${escapeHtml(s.name)}">Copy Snippet</button>
          <button type="button" class="tb-btn danger-hover sec-act-del" data-name="${escapeHtml(s.name)}">Delete</button>
        </div>
      </div>`).join("");

    listEl.querySelectorAll(".sec-act-copy").forEach((b) => {
      b.onclick = () => copyTextToClipboard(`secret("${b.dataset.name}")`, `Copied secret("${b.dataset.name}")`);
    });
    listEl.querySelectorAll(".sec-act-del").forEach((b) => {
      b.onclick = async () => {
        await api(`/api/secrets/${encodeURIComponent(b.dataset.name)}`, { method: "DELETE" });
        toast(`Deleted secret ${b.dataset.name}`, "info");
        loadSecretsList();
      };
    });
  } catch (err) {
    listEl.innerHTML = `<div class="log-empty">Failed to load secrets: ${escapeHtml(err.message)}</div>`;
  }
}

function openSecretsModal() {
  document.getElementById("secrets-modal-overlay")?.classList.remove("hidden");
  loadSecretsList();
}
function closeSecretsModal() {
  document.getElementById("secrets-modal-overlay")?.classList.add("hidden");
}


// =========================================================================
// Command Palette (Ctrl+Shift+P / Ctrl+P) & Find in Files (Ctrl+Shift+F) (#10)
// =========================================================================
let paletteItems = [];
let paletteIdx = 0;

function buildPaletteCommands() {
  return [
    { label: "New Notebook (.mnb)", meta: "Command", run: () => promptNewNotebook() },
    { label: "New Script / File", meta: "Command", run: () => promptNewFile() },
    { label: "New Minilang UI (.ui)", meta: "Command", run: () => promptNewUi() },
    { label: "New Folder", meta: "Command", run: () => promptNewFolder() },
    { label: "Upload Files...", meta: "Command", run: () => document.getElementById("file-upload-input")?.click() },
    { label: "Find in Files (Workspace Search)", meta: "Ctrl+Shift+F", run: () => openGrepModal() },
    { label: "Jobs & Sessions Manager", meta: "Manager", run: () => openJobsModal("bg") },
    { label: "Background Services Manager", meta: "Manager", run: () => openJobsModal("services") },
    { label: "Active Kernel Sessions", meta: "Manager", run: () => openJobsModal("sessions") },
    { label: "Scheduled Jobs & Webhooks", meta: "Manager", run: () => openSchedulesModal() },
    { label: "Encrypted Secrets Vault", meta: "Manager", run: () => openSecretsModal() },
    { label: "Save Active Tab", meta: "Ctrl+S", run: () => saveActiveTab() },
    { label: "Run All Cells", meta: "Notebook", run: () => runAllCells() },
    { label: "Restart Active Kernel", meta: "Kernel", run: () => restartKernel() },
    { label: "Interrupt Active Kernel", meta: "Kernel", run: () => interruptKernel() },
    { label: "Toggle Debugger", meta: "Debug", run: () => toggleDebugDrawer() },
    { label: "Debug Current Script / Cell", meta: "Debug", run: () => startDebuggingActive() },
    { label: "Toggle Variable Inspector", meta: "View", run: () => document.getElementById("btn-toggle-vars")?.click() },
    { label: "Toggle Sidebar", meta: "Ctrl+B", run: () => document.getElementById("btn-toggle-sidebar")?.click() },
    { label: "Toggle Light / Dark Theme", meta: "View", run: () => document.getElementById("btn-theme")?.click() },
    { label: "Refresh File Explorer", meta: "Files", run: () => loadDirectory() },
  ];
}

let paletteFileTimer = null;
async function updatePaletteList(query) {
  const q = (query || "").trim().toLowerCase();
  const cmds = buildPaletteCommands().filter((c) => !q || c.label.toLowerCase().includes(q) || c.meta.toLowerCase().includes(q));
  let fileHits = [];
  if (q.length >= 1) {
    try {
      const res = await api(`/api/files/search?q=${encodeURIComponent(q)}`);
      fileHits = (res.entries || []).filter((e) => e.kind === "file").slice(0, 15).map((e) => ({
        label: e.name,
        meta: e.path,
        run: () => openPathInTab(e.path),
      }));
    } catch { /* ignore */ }
  } else {
    fileHits = state.dirEntries.filter((e) => e.kind === "file").slice(0, 8).map((e) => ({
      label: e.name,
      meta: e.path,
      run: () => openPathInTab(e.path),
    }));
  }
  paletteItems = [...cmds, ...fileHits];
  paletteIdx = 0;
  renderPaletteItems();
}

function renderPaletteItems() {
  const listEl = document.getElementById("cmd-palette-list");
  if (!paletteItems.length) {
    listEl.innerHTML = `<div class="log-empty">No matching commands or files.</div>`;
    return;
  }
  listEl.innerHTML = paletteItems.map((item, i) => `
    <button type="button" class="cmd-palette-item${i === paletteIdx ? " selected" : ""}" data-pidx="${i}">
      <span>${escapeHtml(item.label)}</span>
      <span class="cmd-palette-meta">${escapeHtml(item.meta)}</span>
    </button>`).join("");
  listEl.querySelectorAll(".cmd-palette-item").forEach((btn) => {
    btn.onclick = () => {
      const item = paletteItems[Number(btn.dataset.pidx)];
      closeCommandPalette();
      item?.run();
    };
  });
}

function openCommandPalette(initial = "") {
  const ov = document.getElementById("cmd-palette-overlay");
  const inp = document.getElementById("cmd-palette-input");
  ov?.classList.remove("hidden");
  if (inp) {
    inp.value = initial;
    inp.focus();
    updatePaletteList(initial);
  }
}
function closeCommandPalette() {
  document.getElementById("cmd-palette-overlay")?.classList.add("hidden");
}

function openGrepModal() {
  const ov = document.getElementById("grep-modal-overlay");
  ov?.classList.remove("hidden");
  document.getElementById("grep-input")?.focus();
}
function closeGrepModal() {
  document.getElementById("grep-modal-overlay")?.classList.add("hidden");
}
async function runWorkspaceGrep() {
  const q = document.getElementById("grep-input").value.trim();
  const ext = document.getElementById("grep-ext").value.trim();
  const cs = document.getElementById("grep-case").checked;
  const statusEl = document.getElementById("grep-status");
  const resEl = document.getElementById("grep-results");
  if (!q) {
    resEl.innerHTML = `<div class="log-empty">Enter a search term.</div>`;
    statusEl.textContent = "";
    return;
  }
  statusEl.textContent = "Searching...";
  try {
    const qs = new URLSearchParams({ q, case: cs ? "true" : "false" });
    if (ext) qs.set("ext", ext);
    const data = await api(`/api/files/grep?${qs}`);
    const hits = data.matches || [];
    statusEl.textContent = `${hits.length} match${hits.length === 1 ? "" : "es"}`;
    if (!hits.length) {
      resEl.innerHTML = `<div class="log-empty">No matches found for "${escapeHtml(q)}".</div>`;
      return;
    }
    resEl.innerHTML = hits.map((m, idx) => {
      const pre = escapeHtml(m.text.slice(0, m.match_start));
      const mid = escapeHtml(m.text.slice(m.match_start, m.match_end));
      const post = escapeHtml(m.text.slice(m.match_end));
      const loc = m.cell_index != null
        ? `${m.path} · Cell ${m.cell_index + 1} · Line ${m.line}`
        : `${m.path}:${m.line}:${m.col}`;
      return `
        <div class="grep-row" data-gidx="${idx}">
          <div class="grep-row-loc">${escapeHtml(loc)}</div>
          <div class="grep-row-text">${pre}<span class="grep-highlight">${mid}</span>${post}</div>
        </div>`;
    }).join("");
    resEl.querySelectorAll(".grep-row").forEach((row) => {
      row.onclick = async () => {
        const hit = hits[Number(row.dataset.gidx)];
        closeGrepModal();
        await openPathInTab(hit.path);
        const tab = activeTab();
        if (tab?.kind === "notebook" && hit.cell_id) {
          selectCell(hit.cell_id, true);
        } else if (tab?.kind === "file") {
          const ta = document.getElementById("file-editor-textarea");
          if (ta) {
            const lines = (ta.value || "").split("\n");
            let pos = 0;
            for (let i = 0; i < Math.min(hit.line - 1, lines.length); i++) pos += lines[i].length + 1;
            pos += Math.max(0, hit.col - 1);
            ta.focus();
            ta.setSelectionRange(pos, pos + q.length);
          }
        }
      };
    });
  } catch (err) {
    statusEl.textContent = "";
    resEl.innerHTML = `<div class="log-empty">Search failed: ${escapeHtml(err.message)}</div>`;
  }
}

export function initManagers() {
  document.getElementById("btn-open-jobs")?.addEventListener("click", () => openJobsModal("bg"));
  document.getElementById("btn-manage-sessions")?.addEventListener("click", () => openJobsModal("sessions"));
  document.getElementById("jobs-modal-close")?.addEventListener("click", closeJobsModal);
  document.getElementById("jobs-modal-overlay")?.addEventListener("click", (e) => {
    if (e.target.id === "jobs-modal-overlay") closeJobsModal();
  });
  document.getElementById("jobs-tab-bg")?.addEventListener("click", () => setJobsModalTab("bg"));
  document.getElementById("jobs-tab-services")?.addEventListener("click", () => setJobsModalTab("services"));
  document.getElementById("jobs-tab-sessions")?.addEventListener("click", () => setJobsModalTab("sessions"));
  document.getElementById("service-launch-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const script = document.getElementById("svc-script").value.trim();
    const name = document.getElementById("svc-name").value.trim() || null;
    const rawParams = document.getElementById("svc-params").value.trim();
    let params = null;
    if (rawParams) {
      try {
        params = JSON.parse(rawParams);
      } catch (err) {
        toast(`Invalid JSON params: ${err.message}`, "error");
        return;
      }
    }
    try {
      const res = await api("/api/services", {
        method: "POST",
        body: JSON.stringify({ script, name, params, replace: true }),
      });
      toast(`Started service '${res.service.name}'`, "success");
      document.getElementById("svc-name").value = "";
      document.getElementById("svc-script").value = "";
      document.getElementById("svc-params").value = "";
      loadJobsAndSessions();
    } catch (err) {
      toast(`Failed to start service: ${err.message}`, "error");
    }
  });
  document.getElementById("ftb-service")?.addEventListener("click", async () => {
    const tab = activeTab();
    if (!tab || tab.kind !== "file" || !tab.path) return;
    if (tab.dirty) await saveActiveTab();
    const parsed = parseRunParamsJson(tab._paramsText || "");
    if (!parsed.ok) {
      toast(`Invalid Params JSON: ${parsed.error}`, "error");
      openFileParamsPanel(tab, true);
      return;
    }
    const defaultName = tab.title.replace(/\.[^.]+$/, "");
    const chosen = await showModal({
      title: "Start Background Service",
      bodyHtml: `<p style="margin:0 0 8px;color:var(--text-secondary)">Run <code>${escapeHtml(tab.path)}</code> as a persistent service accessible by UIs via <code>service::on / send / call</code>:</p>`,
      confirmText: "Start Service",
      inputValue: defaultName,
    });
    if (!chosen || !chosen.trim()) return;
    try {
      const res = await api("/api/services", {
        method: "POST",
        body: JSON.stringify({
          script: tab.path,
          name: chosen.trim(),
          params: parsed.params || {},
          replace: true,
        }),
      });
      toast(`Service '${res.service.name}' is running`, "success");
      openJobsModal("services");
    } catch (err) {
      toast(`Failed to start service: ${err.message}`, "error");
    }
  });
  document.getElementById("jobs-refresh-btn")?.addEventListener("click", loadJobsAndSessions);
  document.getElementById("jobs-clear-btn")?.addEventListener("click", async () => {
    const res = await api("/api/jobs/clear", { method: "POST" });
    toast(`Cleared ${res.cleared || 0} finished job(s)`, "info");
    loadJobsAndSessions();
  });
  document.getElementById("job-launch-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const script = document.getElementById("job-script").value.trim();
    const name = document.getElementById("job-name").value.trim() || null;
    const rawParams = document.getElementById("job-params").value.trim();
    let params = null;
    if (rawParams) {
      try {
        params = JSON.parse(rawParams);
      } catch (err) {
        toast(`Invalid JSON params: ${err.message}`, "error");
        return;
      }
    }
    try {
      const res = await api("/api/jobs", {
        method: "POST",
        body: JSON.stringify({ script, name, params, source: "ui" }),
      });
      document.getElementById("job-script").value = "";
      document.getElementById("job-name").value = "";
      document.getElementById("job-params").value = "";
      toast(`Launched ${res.job.id}`, "success");
      loadJobsAndSessions();
    } catch (err) {
      toast(`Launch failed: ${err.message}`, "error");
    }
  });

  // Periodic lightweight badge sync for background jobs
  setInterval(() => {
    if (!authState.required || authState.user) refreshJobsBadge();
  }, 5000);


  document.getElementById("btn-open-schedules")?.addEventListener("click", () => openSchedulesModal());
  document.getElementById("schedules-modal-close")?.addEventListener("click", closeSchedulesModal);
  document.getElementById("schedules-modal-overlay")?.addEventListener("click", (e) => {
    if (e.target.id === "schedules-modal-overlay") closeSchedulesModal();
  });
  document.getElementById("schedule-create-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("sched-name").value.trim();
    const script = document.getElementById("sched-script").value.trim();
    const cron = document.getElementById("sched-cron").value.trim() || null;
    const ivRaw = document.getElementById("sched-interval").value.trim();
    const interval_secs = ivRaw ? Number(ivRaw) : null;
    try {
      await api("/api/schedules", {
        method: "POST",
        body: JSON.stringify({ name: name || null, script, cron, interval_secs, enabled: true }),
      });
      document.getElementById("sched-name").value = "";
      document.getElementById("sched-script").value = "";
      document.getElementById("sched-cron").value = "";
      document.getElementById("sched-interval").value = "";
      toast("Schedule created", "success");
      loadSchedulesList();
    } catch (err) {
      toast(`Create schedule failed: ${err.message}`, "error");
    }
  });


  document.getElementById("btn-open-secrets")?.addEventListener("click", openSecretsModal);
  document.getElementById("secrets-modal-close")?.addEventListener("click", closeSecretsModal);
  document.getElementById("secrets-modal-overlay")?.addEventListener("click", (e) => {
    if (e.target.id === "secrets-modal-overlay") closeSecretsModal();
  });
  document.getElementById("secret-create-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("secret-name").value.trim();
    const value = document.getElementById("secret-value").value;
    const description = document.getElementById("secret-desc").value.trim();
    try {
      await api(`/api/secrets/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify({ value, description }),
      });
      document.getElementById("secret-name").value = "";
      document.getElementById("secret-value").value = "";
      document.getElementById("secret-desc").value = "";
      toast(`Saved encrypted secret ${name}`, "success");
      loadSecretsList();
    } catch (err) {
      toast(`Failed to save secret: ${err.message}`, "error");
    }
  });



  document.getElementById("btn-command-palette")?.addEventListener("click", () => openCommandPalette());
  document.getElementById("cmd-palette-overlay")?.addEventListener("click", (e) => {
    if (e.target.id === "cmd-palette-overlay") closeCommandPalette();
  });
  document.getElementById("cmd-palette-input")?.addEventListener("input", (e) => {
    clearTimeout(paletteFileTimer);
    paletteFileTimer = setTimeout(() => updatePaletteList(e.target.value), 80);
  });
  document.getElementById("cmd-palette-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeCommandPalette(); return; }
    if (e.key === "ArrowDown" && paletteItems.length) {
      e.preventDefault();
      paletteIdx = (paletteIdx + 1) % paletteItems.length;
      renderPaletteItems();
    } else if (e.key === "ArrowUp" && paletteItems.length) {
      e.preventDefault();
      paletteIdx = (paletteIdx - 1 + paletteItems.length) % paletteItems.length;
      renderPaletteItems();
    } else if (e.key === "Enter" && paletteItems[paletteIdx]) {
      e.preventDefault();
      const item = paletteItems[paletteIdx];
      closeCommandPalette();
      item.run();
    }
  });

  // Find in Files (Grep) Modal

  document.getElementById("btn-find-in-files")?.addEventListener("click", openGrepModal);
  document.getElementById("grep-modal-close")?.addEventListener("click", closeGrepModal);
  document.getElementById("grep-modal-overlay")?.addEventListener("click", (e) => {
    if (e.target.id === "grep-modal-overlay") closeGrepModal();
  });
  document.getElementById("grep-run-btn")?.addEventListener("click", runWorkspaceGrep);
  document.getElementById("grep-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); runWorkspaceGrep(); }
    else if (e.key === "Escape") closeGrepModal();
  });
}

export {
  refreshJobsBadge,
  launchBackgroundJobQuick,
  loadJobsAndSessions,
  setJobsModalTab,
  openJobsModal,
  closeJobsModal,
  loadSchedulesList,
  openSchedulesModal,
  closeSchedulesModal,
  loadSecretsList,
  openSecretsModal,
  closeSecretsModal,
  buildPaletteCommands,
  updatePaletteList,
  renderPaletteItems,
  openCommandPalette,
  closeCommandPalette,
  openGrepModal,
  closeGrepModal,
  runWorkspaceGrep,
};
