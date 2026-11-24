/**
 * Shared Interactive Visualization Engine (Sortable/Filterable Tables, SVG Charts, CSV/TSV Parser, Cluster Graphs).
 * Exposed as ES module exports and attached to `window.MlnbViz` for compatibility.
 */

import { mountClusterGraph } from "./cluster.js";

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
  if (type === "cluster") {
    return mountClusterGraph(container, spec, { height: 380 });
  }
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

export { parseCsv, coerceCell, normalizeTablePayload, mountTable, mountChart, mountClusterGraph };
export const MlnbViz = { parseCsv, normalizeTablePayload, mountTable, mountChart, mountClusterGraph };

if (typeof window !== "undefined") {
  window.MlnbViz = MlnbViz;
}
