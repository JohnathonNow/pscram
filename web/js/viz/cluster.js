/**
 * Interactive Zoomable / Pannable 2D Cluster Graph with Arbitrary-Type Color Grouping
 * and Click-to-Inspect Full Row Details.
 */

const DEFAULT_PALETTE = [
  "#7aa2f7", "#4ade80", "#f59e0b", "#c084fc", "#22d3ee", "#f87171", "#fb923c", "#a3e635",
  "#ec4899", "#14b8a6", "#eab308", "#818cf8", "#38bdf8", "#fb7185", "#34d399", "#a78bfa",
];

// 5-stop Viridis-inspired cool-to-warm ramp for continuous numeric color columns
const CONTINUOUS_STOPS = [
  [59, 130, 246],  // blue
  [34, 211, 238],  // cyan
  [74, 222, 128],  // green
  [245, 158, 11],  // amber
  [239, 68, 68],   // red
];

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sampleContinuousColor(t) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0.5));
  const scaled = clamped * (CONTINUOUS_STOPS.length - 1);
  const lo = Math.floor(scaled);
  const hi = Math.min(CONTINUOUS_STOPS.length - 1, lo + 1);
  const f = scaled - lo;
  const r = Math.round(CONTINUOUS_STOPS[lo][0] + (CONTINUOUS_STOPS[hi][0] - CONTINUOUS_STOPS[lo][0]) * f);
  const g = Math.round(CONTINUOUS_STOPS[lo][1] + (CONTINUOUS_STOPS[hi][1] - CONTINUOUS_STOPS[lo][1]) * f);
  const b = Math.round(CONTINUOUS_STOPS[lo][2] + (CONTINUOUS_STOPS[hi][2] - CONTINUOUS_STOPS[lo][2]) * f);
  return `rgb(${r}, ${g}, ${b})`;
}

function niceTickStep(span, targetTicks) {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / Math.max(2, targetTicks);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  if (norm < 1.5) return 1 * pow;
  if (norm < 3) return 2 * pow;
  if (norm < 7) return 5 * pow;
  return 10 * pow;
}

function formatAxisTick(v) {
  if (!Number.isFinite(v)) return "";
  if (Math.abs(v) < 1e-11) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e5 || abs < 1e-3) return v.toExponential(1);
  if (Number.isInteger(v)) return String(v);
  return Number(v.toPrecision(4)).toString();
}

function formatCellPreview(val) {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

/**
 * Normalize a notebook `chart({ type: "cluster", data: [...], x, y, color })` spec
 * into the standard `SqliteClusterResponse`-compatible shape.
 */
function normalizeNotebookClusterSpec(spec) {
  if (!spec || typeof spec !== "object") return null;
  if (Array.isArray(spec.points) && Array.isArray(spec.columns) && Array.isArray(spec.rows)) {
    return spec;
  }
  const rawData = Array.isArray(spec.data) ? spec.data : [];
  if (!rawData.length) return null;
  const first = rawData[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return null;

  const colSet = [];
  for (const row of rawData) {
    if (row && typeof row === "object") {
      for (const k of Object.keys(row)) {
        if (!colSet.includes(k)) colSet.push(k);
      }
    }
  }
  const numCols = colSet.filter((k) => typeof first[k] === "number");
  const xKey = spec.x || numCols[0] || colSet[0];
  const yKey = spec.y || numCols[1] || numCols[0] || colSet[1] || colSet[0];
  const colorKey = spec.color || null;

  const rows = rawData.map((r) => colSet.map((k) => (r[k] === undefined ? null : r[k])));
  const points = [];
  const labelCounts = new Map();
  let numericColorCount = 0;
  let nonNullColorCount = 0;

  rawData.forEach((r, idx) => {
    const xv = Number(r[xKey]);
    const yv = Number(r[yKey]);
    if (!Number.isFinite(xv) || !Number.isFinite(yv)) return;
    const rawC = colorKey ? r[colorKey] : null;
    const lbl = rawC === null || rawC === undefined ? "(NULL)" : String(rawC);
    if (colorKey) {
      labelCounts.set(lbl, (labelCounts.get(lbl) || 0) + 1);
      if (rawC !== null && rawC !== undefined) {
        nonNullColorCount++;
        if (typeof rawC === "number" && Number.isFinite(rawC)) numericColorCount++;
      }
    }
    points.push({
      row_index: idx,
      x: xv,
      y: yv,
      color_group: 0,
      color_value: rawC ?? null,
      color_label: colorKey ? lbl : "All Points",
      cluster: null,
    });
  });

  let color = { mode: "none", column: null, categories: [], min: null, max: null };
  if (colorKey) {
    const isContinuous = nonNullColorCount > 0 && numericColorCount === nonNullColorCount && labelCounts.size > 16;
    if (isContinuous) {
      const vals = points.map((p) => Number(p.color_value)).filter(Number.isFinite);
      color = {
        mode: "continuous",
        column: colorKey,
        categories: [],
        min: Math.min(...vals),
        max: Math.max(...vals),
      };
      points.forEach((p) => { p.color_group = null; });
    } else {
      const ranked = Array.from(labelCounts.entries()).sort((a, b) => b[1] - a[1]);
      const map = new Map();
      const cats = [];
      ranked.forEach(([lbl, cnt], i) => {
        const idx = i < 15 ? i : 15;
        map.set(lbl, idx);
        if (i < 15) {
          cats.push({
            index: i,
            label: lbl,
            color: lbl === "(NULL)" ? "#64748b" : DEFAULT_PALETTE[i % DEFAULT_PALETTE.length],
            count: cnt,
          });
        }
      });
      if (ranked.length > 15) {
        const otherCnt = ranked.slice(15).reduce((a, b) => a + b[1], 0);
        cats.push({ index: 15, label: `Other (${ranked.length - 15})`, color: "#94a3b8", count: otherCnt });
      }
      points.forEach((p) => { p.color_group = map.get(p.color_label) ?? 0; });
      color = { mode: "categorical", column: colorKey, categories: cats, min: null, max: null };
    }
  }

  return {
    source_label: spec.title || "Cluster Graph",
    algorithm_used: "direct",
    x_label: xKey,
    y_label: yKey,
    x_dim: 1,
    y_dim: 1,
    total_dim: 2,
    explained_variance: null,
    columns: colSet,
    rows,
    points,
    centroids: [],
    color,
    truncated: false,
    duration_ms: 0,
  };
}

/**
 * Mount an interactive zoomable, pannable, click-to-inspect cluster graph.
 */
function mountClusterGraph(container, rawInput, opts = {}) {
  const data = normalizeNotebookClusterSpec(rawInput) || rawInput;
  if (!data || !Array.isArray(data.points) || !data.points.length) {
    const empty = document.createElement("div");
    empty.className = "log-empty";
    empty.textContent = "No plottable points available.";
    container.appendChild(empty);
    return empty;
  }

  const points = data.points;
  const centroids = Array.isArray(data.centroids) ? data.centroids : [];
  const columns = Array.isArray(data.columns) ? data.columns : [];
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const colorInfo = data.color || { mode: "none", column: null, categories: [], min: null, max: null };

  const catColorMap = new Map();
  for (const cat of colorInfo.categories || []) {
    catColorMap.set(cat.index, cat.color);
  }

  function pointColor(pt) {
    if (colorInfo.mode === "continuous") {
      if (pt.color_value === null || pt.color_value === undefined || !Number.isFinite(Number(pt.color_value))) {
        return "#64748b";
      }
      const lo = Number(colorInfo.min ?? 0);
      const hi = Number(colorInfo.max ?? 1);
      const t = hi > lo ? (Number(pt.color_value) - lo) / (hi - lo) : 0.5;
      return sampleContinuousColor(t);
    }
    if (colorInfo.mode === "categorical" || colorInfo.mode === "cluster") {
      const idx = pt.color_group ?? 0;
      return catColorMap.get(idx) || DEFAULT_PALETTE[idx % DEFAULT_PALETTE.length];
    }
    return DEFAULT_PALETTE[0];
  }

  // Compute natural data bounds (including centroids)
  let rawMinX = Infinity, rawMaxX = -Infinity, rawMinY = Infinity, rawMaxY = -Infinity;
  for (const p of points) {
    if (p.x < rawMinX) rawMinX = p.x;
    if (p.x > rawMaxX) rawMaxX = p.x;
    if (p.y < rawMinY) rawMinY = p.y;
    if (p.y > rawMaxY) rawMaxY = p.y;
  }
  for (const c of centroids) {
    if (c.x < rawMinX) rawMinX = c.x;
    if (c.x > rawMaxX) rawMaxX = c.x;
    if (c.y < rawMinY) rawMinY = c.y;
    if (c.y > rawMaxY) rawMaxY = c.y;
  }
  if (rawMaxX === rawMinX) { rawMinX -= 1; rawMaxX += 1; }
  if (rawMaxY === rawMinY) { rawMinY -= 1; rawMaxY += 1; }
  const padX = (rawMaxX - rawMinX) * 0.08;
  const padY = (rawMaxY - rawMinY) * 0.08;
  const baseMinX = rawMinX - padX;
  const baseMaxX = rawMaxX + padX;
  const baseMinY = rawMinY - padY;
  const baseMaxY = rawMaxY + padY;

  // Viewport state in data coordinates
  let viewMinX = baseMinX;
  let viewMaxX = baseMaxX;
  let viewMinY = baseMinY;
  let viewMaxY = baseMaxY;

  const hiddenGroups = new Set();
  let hoveredIdx = -1;
  let selectedIdx = -1;

  // Build root layout
  const root = document.createElement("div");
  root.className = "cluster-widget";

  const header = document.createElement("div");
  header.className = "cluster-header";

  const metaLeft = document.createElement("div");
  metaLeft.className = "cluster-meta";
  const algoLabelMap = {
    direct: "Direct 2D",
    pca: "PCA 2D",
    tsne: "t-SNE 2D",
    kmeans_pca: "K-Means + PCA",
    per_col_pca: "Per-Column PCA",
  };
  const algoNice = algoLabelMap[data.algorithm_used] || data.algorithm_used || "Direct";
  const dimInfo = data.total_dim > 2 ? ` · ${data.total_dim}D → 2D` : "";
  const durInfo = data.duration_ms > 0 ? ` · ${data.duration_ms.toFixed(1)} ms` : "";
  const truncInfo = data.truncated ? " (truncated)" : "";
  metaLeft.innerHTML =
    `<strong>${escHtml(data.source_label || "Cluster Graph")}</strong>` +
    `<span class="cluster-pill">${points.length} pts${truncInfo}</span>` +
    `<span class="cluster-pill">${escHtml(algoNice)}${escHtml(dimInfo)}</span>` +
    (colorInfo.column ? `<span class="cluster-pill">Color: ${escHtml(colorInfo.column)}</span>` : "") +
    `<span class="cluster-meta-muted">${escHtml(durInfo)}</span>`;

  const zoomCtrl = document.createElement("div");
  zoomCtrl.className = "cluster-zoom-controls";
  const zoomOutBtn = document.createElement("button");
  zoomOutBtn.type = "button";
  zoomOutBtn.className = "tb-btn";
  zoomOutBtn.textContent = "−";
  zoomOutBtn.title = "Zoom out";
  const zoomPct = document.createElement("span");
  zoomPct.className = "cluster-zoom-readout";
  zoomPct.textContent = "100%";
  const zoomInBtn = document.createElement("button");
  zoomInBtn.type = "button";
  zoomInBtn.className = "tb-btn";
  zoomInBtn.textContent = "+";
  zoomInBtn.title = "Zoom in";
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "tb-btn";
  resetBtn.textContent = "Reset";
  resetBtn.title = "Reset zoom & pan (or double-click graph)";
  zoomCtrl.append(zoomOutBtn, zoomPct, zoomInBtn, resetBtn);
  header.append(metaLeft, zoomCtrl);

  const mainRow = document.createElement("div");
  mainRow.className = "cluster-main";

  const stage = document.createElement("div");
  stage.className = "cluster-stage";
  if (opts.height) stage.style.height = `${opts.height}px`;

  const canvas = document.createElement("canvas");
  canvas.className = "cluster-canvas";
  const tooltip = document.createElement("div");
  tooltip.className = "cluster-tooltip hidden";
  const hint = document.createElement("div");
  hint.className = "cluster-hint";
  hint.textContent = "Scroll to zoom · Drag to pan · Click point to inspect row · Double-click to reset";
  stage.append(canvas, tooltip, hint);

  // Row inspector side panel (revealed when a point is clicked)
  const inspector = document.createElement("aside");
  inspector.className = "cluster-inspector hidden";
  inspector.innerHTML = `
    <div class="cluster-inspector-head">
      <strong class="cluster-inspector-title">Row Details</strong>
      <div class="cluster-inspector-actions">
        <button type="button" class="tb-btn cluster-copy-row" title="Copy row as JSON">Copy</button>
        <button type="button" class="icon-btn sm cluster-close-inspector" title="Close">&times;</button>
      </div>
    </div>
    <div class="cluster-inspector-meta"></div>
    <div class="cluster-inspector-body"></div>
  `;

  mainRow.append(stage, inspector);

  // Interactive Legend
  const legendWrap = document.createElement("div");
  legendWrap.className = "cluster-legend";

  root.append(header, mainRow, legendWrap);
  container.appendChild(root);

  const pad = { top: 20, right: 20, bottom: 44, left: 62 };

  function getCanvasDims() {
    const rect = stage.getBoundingClientRect();
    const w = Math.max(320, Math.floor(rect.width || 680));
    const h = Math.max(260, Math.floor(rect.height || 420));
    return { w, h, plotW: Math.max(40, w - pad.left - pad.right), plotH: Math.max(40, h - pad.top - pad.bottom) };
  }

  function dataToScreen(dx, dy, dims) {
    const sx = pad.left + ((dx - viewMinX) / (viewMaxX - viewMinX)) * dims.plotW;
    const sy = pad.top + dims.plotH - ((dy - viewMinY) / (viewMaxY - viewMinY)) * dims.plotH;
    return [sx, sy];
  }

  function screenToData(sx, sy, dims) {
    const dx = viewMinX + ((sx - pad.left) / dims.plotW) * (viewMaxX - viewMinX);
    const dy = viewMinY + ((pad.top + dims.plotH - sy) / dims.plotH) * (viewMaxY - viewMinY);
    return [dx, dy];
  }

  function isPointVisible(pt) {
    if ((colorInfo.mode === "categorical" || colorInfo.mode === "cluster") && pt.color_group !== null && pt.color_group !== undefined) {
      return !hiddenGroups.has(pt.color_group);
    }
    return true;
  }

  function updateZoomReadout() {
    const scaleX = (baseMaxX - baseMinX) / Math.max(1e-12, viewMaxX - viewMinX);
    const pct = Math.round(scaleX * 100);
    zoomPct.textContent = `${pct}%`;
  }

  function readCssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch {
      return fallback;
    }
  }

  function draw() {
    const dims = getCanvasDims();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== dims.w * dpr || canvas.height !== dims.h * dpr) {
      canvas.width = dims.w * dpr;
      canvas.height = dims.h * dpr;
      canvas.style.width = `${dims.w}px`;
      canvas.style.height = `${dims.h}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);

    const bgColor = readCssVar("--bg-output", "#121521");
    const gridColor = readCssVar("--border-subtle", "#1d2233");
    const axisColor = readCssVar("--border", "#252b40");
    const textMuted = readCssVar("--text-muted", "#5f698a");
    const textSecondary = readCssVar("--text-secondary", "#9aa5ce");
    const textPrimary = readCssVar("--text-primary", "#e2e8f5");

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, dims.w, dims.h);

    // Draw grid lines and numeric ticks
    const stepX = niceTickStep(viewMaxX - viewMinX, Math.floor(dims.plotW / 95));
    const stepY = niceTickStep(viewMaxY - viewMinY, Math.floor(dims.plotH / 58));

    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    ctx.lineWidth = 1;

    // Vertical grid + X ticks
    const firstX = Math.ceil(viewMinX / stepX) * stepX;
    for (let x = firstX; x <= viewMaxX + stepX * 0.001; x += stepX) {
      const [sx] = dataToScreen(x, viewMinY, dims);
      if (sx < pad.left - 1 || sx > dims.w - pad.right + 1) continue;
      ctx.strokeStyle = Math.abs(x) < stepX * 1e-6 ? axisColor : gridColor;
      ctx.beginPath();
      ctx.moveTo(sx, pad.top);
      ctx.lineTo(sx, pad.top + dims.plotH);
      ctx.stroke();

      ctx.fillStyle = textMuted;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(formatAxisTick(x), sx, pad.top + dims.plotH + 6);
    }

    // Horizontal grid + Y ticks
    const firstY = Math.ceil(viewMinY / stepY) * stepY;
    for (let y = firstY; y <= viewMaxY + stepY * 0.001; y += stepY) {
      const [, sy] = dataToScreen(viewMinX, y, dims);
      if (sy < pad.top - 1 || sy > pad.top + dims.plotH + 1) continue;
      ctx.strokeStyle = Math.abs(y) < stepY * 1e-6 ? axisColor : gridColor;
      ctx.beginPath();
      ctx.moveTo(pad.left, sy);
      ctx.lineTo(dims.w - pad.right, sy);
      ctx.stroke();

      ctx.fillStyle = textMuted;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(formatAxisTick(y), pad.left - 8, sy);
    }

    // Plot border
    ctx.strokeStyle = axisColor;
    ctx.strokeRect(pad.left, pad.top, dims.plotW, dims.plotH);

    // Axis labels
    ctx.fillStyle = textSecondary;
    ctx.font = "600 11.5px -apple-system, BlinkMacSystemFont, Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(String(data.x_label || "X"), pad.left + dims.plotW / 2, dims.h - 4);

    ctx.save();
    ctx.translate(14, pad.top + dims.plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(String(data.y_label || "Y"), 0, 0);
    ctx.restore();

    // Clip to plot area for points & centroids
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left + 0.5, pad.top + 0.5, dims.plotW - 1, dims.plotH - 1);
    ctx.clip();

    const baseR = points.length > 1500 ? 3.2 : (points.length > 400 ? 4.2 : 5.2);

    // Draw points
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      if (!isPointVisible(pt)) continue;
      const [sx, sy] = dataToScreen(pt.x, pt.y, dims);
      if (sx < pad.left - 12 || sx > dims.w - pad.right + 12 || sy < pad.top - 12 || sy > pad.top + dims.plotH + 12) {
        continue;
      }
      ctx.beginPath();
      ctx.arc(sx, sy, baseR, 0, Math.PI * 2);
      ctx.fillStyle = pointColor(pt);
      ctx.globalAlpha = (selectedIdx >= 0 && selectedIdx !== i) ? 0.62 : 0.88;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = bgColor;
      ctx.stroke();
    }

    // Draw K-Means centroids (diamond marker + subtle label)
    if (centroids.length) {
      ctx.font = "700 10.5px -apple-system, BlinkMacSystemFont, Inter, sans-serif";
      for (const c of centroids) {
        if (colorInfo.mode === "cluster" && hiddenGroups.has(c.cluster)) continue;
        const [sx, sy] = dataToScreen(c.x, c.y, dims);
        const col = DEFAULT_PALETTE[c.cluster % DEFAULT_PALETTE.length];
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = col;
        ctx.strokeStyle = textPrimary;
        ctx.lineWidth = 1.6;
        ctx.fillRect(-5, -5, 10, 10);
        ctx.strokeRect(-5, -5, 10, 10);
        ctx.restore();

        ctx.fillStyle = textPrimary;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(`C${c.cluster + 1}`, sx + 9, sy);
      }
    }

    // Draw hovered point highlight
    if (hoveredIdx >= 0 && hoveredIdx < points.length && isPointVisible(points[hoveredIdx])) {
      const pt = points[hoveredIdx];
      const [sx, sy] = dataToScreen(pt.x, pt.y, dims);
      ctx.beginPath();
      ctx.arc(sx, sy, baseR + 3.2, 0, Math.PI * 2);
      ctx.fillStyle = pointColor(pt);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = textPrimary;
      ctx.stroke();
    }

    // Draw selected point double ring
    if (selectedIdx >= 0 && selectedIdx < points.length && isPointVisible(points[selectedIdx])) {
      const pt = points[selectedIdx];
      const [sx, sy] = dataToScreen(pt.x, pt.y, dims);
      ctx.beginPath();
      ctx.arc(sx, sy, baseR + 6, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = textPrimary;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(sx, sy, baseR + 2.5, 0, Math.PI * 2);
      ctx.fillStyle = pointColor(pt);
      ctx.fill();
    }

    ctx.restore();
    ctx.restore();
    updateZoomReadout();
  }

  function findNearestPoint(sx, sy) {
    const dims = getCanvasDims();
    let best = -1;
    let bestDist2 = 13 * 13;
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      if (!isPointVisible(pt)) continue;
      const [px, py] = dataToScreen(pt.x, pt.y, dims);
      const dx = px - sx;
      const dy = py - sy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist2) {
        bestDist2 = d2;
        best = i;
      }
    }
    return best;
  }

  function zoomAround(factor, anchorSx = null, anchorSy = null) {
    const dims = getCanvasDims();
    const sx = anchorSx !== null ? anchorSx : pad.left + dims.plotW / 2;
    const sy = anchorSy !== null ? anchorSy : pad.top + dims.plotH / 2;
    const [ax, ay] = screenToData(sx, sy, dims);

    const curW = viewMaxX - viewMinX;
    const curH = viewMaxY - viewMinY;
    const baseW = baseMaxX - baseMinX;
    const baseH = baseMaxY - baseMinY;
    const nextW = Math.min(baseW * 2.5, Math.max(baseW / 250, curW * factor));
    const nextH = Math.min(baseH * 2.5, Math.max(baseH / 250, curH * factor));

    const fx = (ax - viewMinX) / curW;
    const fy = (ay - viewMinY) / curH;
    viewMinX = ax - fx * nextW;
    viewMaxX = viewMinX + nextW;
    viewMinY = ay - fy * nextH;
    viewMaxY = viewMinY + nextH;
    draw();
  }

  function resetView() {
    viewMinX = baseMinX;
    viewMaxX = baseMaxX;
    viewMinY = baseMinY;
    viewMaxY = baseMaxY;
    draw();
  }

  function renderInspector(idx) {
    if (idx < 0 || idx >= points.length) {
      selectedIdx = -1;
      inspector.classList.add("hidden");
      draw();
      return;
    }
    selectedIdx = idx;
    const pt = points[idx];
    const row = rows[pt.row_index] || [];
    inspector.classList.remove("hidden");

    inspector.querySelector(".cluster-inspector-title").textContent = `Row #${pt.row_index + 1}`;
    const metaParts = [
      `X: ${formatAxisTick(pt.x)}`,
      `Y: ${formatAxisTick(pt.y)}`,
    ];
    if (pt.cluster !== null && pt.cluster !== undefined) {
      metaParts.push(`Cluster ${pt.cluster + 1}`);
    }
    if (colorInfo.column) {
      metaParts.push(`${colorInfo.column}: ${pt.color_label}`);
    }
    inspector.querySelector(".cluster-inspector-meta").innerHTML =
      `<span class="cluster-insp-swatch" style="background:${pointColor(pt)}"></span>` +
      `<span>${escHtml(metaParts.join(" · "))}</span>`;

    const body = inspector.querySelector(".cluster-inspector-body");
    body.innerHTML = columns.map((col, ci) => {
      const val = row[ci];
      const isNilVal = val === null || val === undefined;
      const text = formatCellPreview(val);
      return `
        <div class="cluster-insp-row">
          <div class="cluster-insp-key">${escHtml(col)}</div>
          <div class="cluster-insp-val${isNilVal ? " is-null" : ""}">${escHtml(text)}</div>
        </div>
      `;
    }).join("");

    const copyBtn = inspector.querySelector(".cluster-copy-row");
    copyBtn.onclick = () => {
      const obj = {};
      columns.forEach((c, ci) => { obj[c] = row[ci] ?? null; });
      navigator.clipboard?.writeText(JSON.stringify(obj, null, 2)).catch(() => {});
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1200);
    };
    draw();
  }

  inspector.querySelector(".cluster-close-inspector").onclick = () => renderInspector(-1);

  // Render legend
  function renderLegend() {
    legendWrap.innerHTML = "";
    if (colorInfo.mode === "continuous") {
      const gradStops = CONTINUOUS_STOPS.map((c) => `rgb(${c[0]},${c[1]},${c[2]})`).join(", ");
      legendWrap.innerHTML = `
        <div class="cluster-colorbar">
          <span class="cluster-legend-title">${escHtml(colorInfo.column || "Color")}:</span>
          <span>${escHtml(formatAxisTick(colorInfo.min ?? 0))}</span>
          <span class="cluster-colorbar-ramp" style="background:linear-gradient(90deg, ${gradStops})"></span>
          <span>${escHtml(formatAxisTick(colorInfo.max ?? 1))}</span>
        </div>
      `;
      return;
    }
    if ((colorInfo.mode === "categorical" || colorInfo.mode === "cluster") && colorInfo.categories?.length) {
      const titleSpan = document.createElement("span");
      titleSpan.className = "cluster-legend-title";
      titleSpan.textContent = `${colorInfo.column || "Groups"}:`;
      legendWrap.appendChild(titleSpan);

      for (const cat of colorInfo.categories) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `cluster-legend-item${hiddenGroups.has(cat.index) ? " is-muted" : ""}`;
        btn.title = "Click to toggle group · Double-click to isolate";
        btn.innerHTML = `<span class="ml-chart-swatch" style="background:${cat.color}"></span><span>${escHtml(cat.label)}</span><span class="cluster-legend-count">(${cat.count})</span>`;
        btn.onclick = () => {
          if (hiddenGroups.has(cat.index)) hiddenGroups.delete(cat.index);
          else hiddenGroups.add(cat.index);
          renderLegend();
          draw();
        };
        btn.ondblclick = () => {
          const allOtherHidden = colorInfo.categories.every((c) => c.index === cat.index || hiddenGroups.has(c.index));
          hiddenGroups.clear();
          if (!allOtherHidden) {
            for (const c of colorInfo.categories) {
              if (c.index !== cat.index) hiddenGroups.add(c.index);
            }
          }
          renderLegend();
          draw();
        };
        legendWrap.appendChild(btn);
      }
    } else {
      legendWrap.classList.add("hidden");
    }
  }

  // Pointer interaction: wheel zoom, drag pan, hover tooltip, click point to inspect row
  let isDragging = false;
  let didDrag = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragView = null;

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 0.82 : 1.22;
    zoomAround(factor, sx, sy);
  }, { passive: false });

  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    didDrag = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragView = { minX: viewMinX, maxX: viewMaxX, minY: viewMinY, maxY: viewMaxY };
    canvas.style.cursor = "grabbing";
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging || !dragView) return;
    const dxPx = e.clientX - dragStartX;
    const dyPx = e.clientY - dragStartY;
    if (Math.hypot(dxPx, dyPx) > 4) didDrag = true;
    if (!didDrag) return;
    const dims = getCanvasDims();
    const dxData = (dxPx / dims.plotW) * (dragView.maxX - dragView.minX);
    const dyData = (dyPx / dims.plotH) * (dragView.maxY - dragView.minY);
    viewMinX = dragView.minX - dxData;
    viewMaxX = dragView.maxX - dxData;
    viewMinY = dragView.minY + dyData;
    viewMaxY = dragView.maxY + dyData;
    tooltip.classList.add("hidden");
    draw();
  });

  window.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    dragView = null;
    canvas.style.cursor = hoveredIdx >= 0 ? "pointer" : "grab";
  });

  canvas.addEventListener("mousemove", (e) => {
    if (isDragging) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const hit = findNearestPoint(sx, sy);
    if (hit !== hoveredIdx) {
      hoveredIdx = hit;
      draw();
    }
    if (hit >= 0) {
      canvas.style.cursor = "pointer";
      const pt = points[hit];
      const row = rows[pt.row_index] || [];
      const previewLines = [];
      for (let ci = 0; ci < Math.min(4, columns.length); ci++) {
        const s = formatCellPreview(row[ci]);
        previewLines.push(`<div><span class="cluster-tt-k">${escHtml(columns[ci])}:</span> ${escHtml(s.length > 48 ? s.slice(0, 48) + "…" : s)}</div>`);
      }
      const colorBadge = colorInfo.column
        ? `<div><span class="cluster-tt-k">${escHtml(colorInfo.column)}:</span> <strong>${escHtml(pt.color_label)}</strong></div>`
        : "";
      tooltip.innerHTML =
        `<div class="cluster-tt-head">Row #${pt.row_index + 1} · (${formatAxisTick(pt.x)}, ${formatAxisTick(pt.y)})</div>` +
        colorBadge +
        previewLines.join("") +
        `<div class="cluster-tt-foot">Click to inspect all ${columns.length} columns</div>`;
      tooltip.classList.remove("hidden");
      const stageRect = stage.getBoundingClientRect();
      const left = Math.min(stageRect.width - 230, Math.max(8, sx + 14));
      const top = Math.max(8, sy - 16);
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    } else {
      canvas.style.cursor = "grab";
      tooltip.classList.add("hidden");
    }
  });

  canvas.addEventListener("mouseleave", () => {
    tooltip.classList.add("hidden");
    if (hoveredIdx !== -1) {
      hoveredIdx = -1;
      draw();
    }
  });

  canvas.addEventListener("click", (e) => {
    if (didDrag) return;
    const rect = canvas.getBoundingClientRect();
    const hit = findNearestPoint(e.clientX - rect.left, e.clientY - rect.top);
    if (hit >= 0) {
      renderInspector(hit);
    }
  });

  canvas.addEventListener("dblclick", () => resetView());

  zoomInBtn.onclick = () => zoomAround(0.7);
  zoomOutBtn.onclick = () => zoomAround(1.4);
  resetBtn.onclick = () => resetView();

  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => draw());
    ro.observe(stage);
  }

  renderLegend();
  requestAnimationFrame(() => draw());
  return root;
}

export { mountClusterGraph, normalizeNotebookClusterSpec };
