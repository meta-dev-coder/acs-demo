/*---------------------------------------------------------------------------------------------
 * windowPanel.js — UC1 P4-b: the window panel (design spec §4 bullet 3 "Window panel" + §3
 * integration). Pure DOM rendering only — no Cesium imports (same split as contextPanel.js:
 * geometry-free assembly lives in windowAssembly.js's evaluateCandidates(), this module only
 * renders whatever shape that returns). Styled to match contextPanel.js's dc-panel-* HUD
 * language, with a small uc1-win-* vocabulary of its own for the sparkline/table.
 *
 * renderWindowPanel(containerEl, data, onSchedule):
 *   data = { workOrder, windows, results, winnerIdx } — normally windowAssembly.js's
 *   evaluateCandidates() output, optionally with a `workOrder` field merged in by the caller for
 *   the header (mirrors contextPanel's convention). Wiring — creating/showing the container
 *   element, calling evaluateCandidates() on a picked work order, and calling this function with
 *   the result — is deferred to a later phase (main.js is intentionally untouched here).
 *
 *   onSchedule(window, result, rank) is invoked when a row's "Schedule this window" button is
 *   clicked. Left un-called (buttons still render, inert) if omitted.
 *
 *   The one derived metric this module needs but doesn't own the math for ("throughput vs
 *   demand") is imported from windowAssembly.js's throughputVsDemandPct() and computed per
 *   result here rather than reimplemented — this module stays a pure renderer.
 *--------------------------------------------------------------------------------------------*/
import { throughputVsDemandPct } from "./windowAssembly.js";

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtUsd(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function fmtMin(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)} min`;
}

function fmtPct(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `${n.toFixed(0)}%`;
}

function fmtScore(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toFixed(3);
}

function fmtHourLabel(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "—";
  const dow = date.toLocaleDateString(undefined, { weekday: "short" });
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${dow} ${h}:${m}`;
}

// Fixed color per heuristic id — reuses the existing red/amber/green HUD palette
// (contextPanel.js's badge colors) so overnight/weekend/weekday-PM read consistently everywhere.
const WINDOW_COLOR = {
  overnight: "#6fb1ff",
  weekendMorning: "#43d871",
  weekdayPm: "#f1a325",
};
const DEFAULT_COLOR = "#9fb0c3";

function colorForWindow(windowId) {
  return WINDOW_COLOR[windowId] || DEFAULT_COLOR;
}

/** "red"/"amber"/"green" ranked RELATIVELY within the 3 candidates (lowest = best = green,
 * highest = worst = red) — avoids needing an absolute threshold config just to color a table
 * cell; the ranked table already sorts, this just colors by the same ordering. */
function relativeBand(values, idx) {
  const sorted = [...values].map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const rank = sorted.findIndex(([, i]) => i === idx);
  if (values.length <= 1) return "green";
  if (rank === 0) return "green";
  if (rank === values.length - 1) return "red";
  return "amber";
}

// ---- demand sparkline: all 3 windows plotted on a shared 0-24 hour-of-day axis ------------------

const SPARK_W = 300;
const SPARK_H = 56;
const SPARK_PAD = 6;

/** hourOfDay for slice `i` of `window`, wrapped into [0, 24) — window.start's LOCAL hour is the
 * anchor (matches candidateWindows()'s local wall-clock heuristics; see windowAssembly.js's
 * header on why demand.js's UTC-hour reads are reconciled to that same wall clock). */
function sliceHourOfDay(window, sliceIndex, sliceHours) {
  const startHour = window.start.getHours() + window.start.getMinutes() / 60;
  return (((startHour + sliceIndex * sliceHours) % 24) + 24) % 24;
}

function sparklinePoints(window, result) {
  const slices = result?.queue?.slices || [];
  if (slices.length === 0) return [];
  const sliceHours = window.durationHours / slices.length;
  return slices.map((s, i) => ({ hour: sliceHourOfDay(window, i, sliceHours), vph: s.demandVph }));
}

/** Renders the 3 candidate windows' demand profiles as one small inline SVG polyline chart, x =
 * hour-of-day (0-24, wrapped), y = vph. No chart library — plain <svg>/<polyline>. */
function sparklineSvg(windows, results) {
  const series = windows.map((w, i) => ({ id: w.id, color: colorForWindow(w.id), points: sparklinePoints(w, results[i]) }));
  const allVph = series.flatMap((s) => s.points.map((p) => p.vph));
  const maxVph = Math.max(1, ...allVph);

  const x = (hour) => SPARK_PAD + (hour / 24) * (SPARK_W - 2 * SPARK_PAD);
  const y = (vph) => SPARK_H - SPARK_PAD - (vph / maxVph) * (SPARK_H - 2 * SPARK_PAD);

  const polylines = series
    .filter((s) => s.points.length > 0)
    .map((s) => {
      const pts = s.points.map((p) => `${x(p.hour).toFixed(1)},${y(p.vph).toFixed(1)}`).join(" ");
      return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.9" />`;
    })
    .join("");

  const legend = series
    .map((s) => `<span class="uc1-win-legend-item"><span class="uc1-win-legend-dot" style="background:${s.color}"></span>${esc(s.id)}</span>`)
    .join("");

  return `
    <div class="uc1-win-sparkline">
      <svg viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" role="img" aria-label="Segment demand by hour of day for the 3 candidate windows">
        <line x1="${SPARK_PAD}" y1="${SPARK_H - SPARK_PAD}" x2="${SPARK_W - SPARK_PAD}" y2="${SPARK_H - SPARK_PAD}" stroke="rgba(255,255,255,0.15)" stroke-width="1" />
        ${polylines}
      </svg>
      <div class="uc1-win-legend">${legend}</div>
    </div>`;
}

// ---- ranked table ---------------------------------------------------------------------------

function tableRowHtml(window, result, rank, isWinner, allResults, idx) {
  const revenueVals = allResults.map((r) => r.revenueAtRiskUsd?.point ?? 0);
  const delayVals = allResults.map((r) => r.queue?.avgDelayMin ?? 0);
  const exposureVals = allResults.map((r) => r.secondaryCrashExposure ?? 0);

  const revenue = result.revenueAtRiskUsd || {};
  const bandPct = typeof revenue.band === "number" ? Math.round(revenue.band * 100) : null;

  return `
    <tr class="uc1-win-row${isWinner ? " uc1-win-row-winner" : ""}" data-window-id="${esc(window.id)}">
      <td class="uc1-win-rank">${isWinner ? "&#9733;" : rank}</td>
      <td>
        <div class="uc1-win-label" style="color:${colorForWindow(window.id)}">${esc(window.label || window.id)}</div>
        <div class="uc1-win-sub">${esc(fmtHourLabel(window.start))} &middot; ${esc(window.durationHours)}h</div>
      </td>
      <td class="uc1-win-cell ${relativeBand(revenueVals, idx)}">
        <div>${fmtUsd(revenue.point)}</div>
        ${bandPct != null ? `<div class="uc1-win-sub">&plusmn;${bandPct}% ($${Math.round(revenue.low ?? 0).toLocaleString()}&ndash;$${Math.round(revenue.high ?? 0).toLocaleString()})</div>` : ""}
      </td>
      <td class="uc1-win-cell ${relativeBand(delayVals, idx)}">${fmtMin(result.queue?.avgDelayMin)}</td>
      <td class="uc1-win-cell">${fmtPct(throughputVsDemandPct(result))}</td>
      <td class="uc1-win-cell">${fmtPct(result.laneAvailabilityPct)}</td>
      <td class="uc1-win-cell ${relativeBand(exposureVals, idx)}">${(result.secondaryCrashExposure ?? 0).toFixed(2)}</td>
      <td class="uc1-win-cell uc1-win-score">${fmtScore(result.score)}</td>
      <td><button type="button" class="uc1-win-schedule-btn" data-window-id="${esc(window.id)}">Schedule this window</button></td>
    </tr>`;
}

/**
 * renderWindowPanel(containerEl, data, onSchedule)
 *
 * data = { workOrder, windows, results, winnerIdx } — windowAssembly.js's evaluateCandidates()
 * shape, unmodified; the "throughput vs demand" column is derived per-row via
 * windowAssembly.js's throughputVsDemandPct().
 *
 * No-ops (clears + hides) when containerEl or data is missing/empty, same defensive posture as
 * contextPanel.js's renderWorkOrderContext(). Rows render sorted by score ascending (best first);
 * the lowest-scoring row (data.winnerIdx) is starred and highlighted regardless of table position.
 */
export function renderWindowPanel(containerEl, data, onSchedule) {
  if (!containerEl) return;
  const windows = data?.windows || [];
  const results = data?.results || [];
  if (!data || windows.length === 0 || results.length === 0) {
    containerEl.classList.add("hidden");
    containerEl.innerHTML = "";
    return;
  }

  const winnerIdx = data.winnerIdx ?? 0;
  const wo = data.workOrder || null;

  // Sort indices by score ascending (rank 1 = best) without mutating the caller's arrays.
  const order = results.map((_, i) => i).sort((a, b) => (results[a].score ?? 0) - (results[b].score ?? 0));

  const rowsHtml = order
    .map((idx, rankZero) => tableRowHtml(windows[idx], results[idx], rankZero + 1, idx === winnerIdx, results, idx))
    .join("");

  containerEl.classList.remove("hidden");
  containerEl.innerHTML = `
    <button class="dc-panel-close" aria-label="Close">&times;</button>
    <div class="dc-panel-h">Lane-closure window options</div>
    <div class="dc-panel-sub">${wo ? `${esc(wo.id)} &middot; ${esc(wo.segment || "Unspecified segment")}` : "3 system-suggested windows"}</div>
    ${sparklineSvg(windows, results)}
    <div class="uc1-win-table-wrap">
      <table class="uc1-win-table">
        <thead>
          <tr>
            <th></th>
            <th>Window</th>
            <th>Revenue loss</th>
            <th>Avg delay</th>
            <th>Throughput</th>
            <th>Lanes open</th>
            <th>Crash risk</th>
            <th>Score</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <div class="uc1-win-note">Demand curve is SYNTHETIC (see trust panel). Lower Score = better window.</div>
  `;

  const closeBtn = containerEl.querySelector(".dc-panel-close");
  if (closeBtn) closeBtn.onclick = () => containerEl.classList.add("hidden");

  containerEl.querySelectorAll(".uc1-win-schedule-btn").forEach((btn) => {
    btn.onclick = () => {
      const windowId = btn.getAttribute("data-window-id");
      const idx = windows.findIndex((w) => w.id === windowId);
      if (idx < 0) return;
      const rank = order.indexOf(idx) + 1;
      if (typeof onSchedule === "function") onSchedule(windows[idx], results[idx], rank);
    };
  });
}
