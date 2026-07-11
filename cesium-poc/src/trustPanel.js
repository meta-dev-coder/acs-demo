/*---------------------------------------------------------------------------------------------
 * trustPanel.js — UC1 P5-b: the trust panel (design spec §4 bullet "Trust panel", two tabs).
 * Pure DOM rendering only — no Cesium imports, no main.js coupling, matching the
 * windowPanel.js/contextPanel.js split (geometry-free assembly stays elsewhere; this module only
 * renders whatever shape it's handed and reports assumption edits back via a callback).
 *
 * renderTrustPanel(containerEl, { backtestResult, assumptions, onAssumptionChange }):
 *
 *   Tab 1 "Backtest" renders whatever backtestResult backtest.js's runBacktest() (temporal
 *   holdout: fit year 1, predict/compare year 2) hands it — this module does not compute
 *   recurrence/rank/duration-class stats itself (that's backtest.js's job per spec §4; P5-b only
 *   owns the two-tab UI). Shape (all optional/defensive — missing fields render as "—" / empty
 *   sections, never throw), matching runBacktest()'s actual return value:
 *     {
 *       honestyLine: string,     // HONESTY_LINE, re-exported below
 *       coverage: { totalIncidents, unparsableDates, train: {rows,closureRows,withSegment},
 *                   test: {rows,closureRows,withSegment} },
 *       segments: [{ segmentId, segmentName, predictedClosures, predictedRate, actualClosures,
 *                    actualRate, trainSampleSize, testSampleSize }],
 *       ranking: { n, predictedOrder: [segmentId...], actualOrder: [segmentId...], spearmanRho },
 *       durationClass: { n, hitRate, confusion, classes },
 *     }
 *
 *   Tab 2 "Assumptions" renders live-editable rows for tollRateUsd, weights.{revenue,delay,
 *   safety,crew} (w1-w4), mergeFriction, and one row per segment's demandScale — mirroring
 *   config/windowConfig.json's shape (see that file's header: "sliders in the trust panel (P5)
 *   mutate a clone of this object at runtime") plus segments.json's per-segment demandScale.
 *   Expected `assumptions` shape:
 *     {
 *       tollRateUsd: number,
 *       weights: { revenue, delay, safety, crew },
 *       mergeFriction: number,
 *       segmentDemandScale: { [segmentId]: number },
 *       segments: [{ id, name }]   // optional label source for the demandScale rows; falls back
 *                                  // to the segment id when a row has no matching label.
 *     }
 *   Missing/malformed fields are backfilled from DEFAULT_ASSUMPTIONS (mergeAssumptionDefaults)
 *   before rendering, so a caller can pass a partial object (e.g. before its own config clone is
 *   ready) without this module throwing.
 *
 *   Every slider/input calls onAssumptionChange(newAssumptions) on change — newAssumptions is a
 *   NEW object (setAssumptionAtPath never mutates its input), clamped to ASSUMPTION_BOUNDS. The
 *   caller re-ranks the window table with it; this module does not re-rank anything itself.
 *
 * Pure helpers (assumption merge/clamp, badge mapping) are exported and TDD'd in
 * tests/trustPanel.test.mjs; DOM rendering itself isn't unit-tested under node --test, matching
 * windowPanel.js's own "DOM rendering isn't unit-testable without a DOM shim" posture.
 *--------------------------------------------------------------------------------------------*/

// ---- honesty line (slide-10, rendered verbatim per spec §4) -----------------------------------
// backtest.js is the canonical source (runBacktest()'s result always carries it as
// `honestyLine`); re-exported here so callers of trustPanel.js get it without a second import,
// and so it always renders even if a caller hands renderTrustPanel() a backtestResult missing
// the field.
export { HONESTY_LINE } from "./backtest.js";
import { HONESTY_LINE } from "./backtest.js";

// ---- assumptions: defaults, bounds, badges, pure merge/clamp helpers --------------------------

/** Mirrors config/windowConfig.json's live-editable subset (Decision 4's w1-w4) + an empty
 * per-segment demandScale map, which callers backfill from segments.json. Not a copy of the whole
 * windowConfig — only the fields the assumptions tab edits. */
export const DEFAULT_ASSUMPTIONS = Object.freeze({
  tollRateUsd: 2.5,
  weights: Object.freeze({ revenue: 0.5, delay: 0.2, safety: 0.3, crew: 0 }),
  mergeFriction: 0.9,
  segmentDemandScale: Object.freeze({}),
});

/** [min, max] per editable field, keyed by the same dot-path setAssumptionAtPath()/
 * getAssumptionAtPath() use. "segmentDemandScale" (no suffix) is the fallback range applied to
 * ANY "segmentDemandScale.<id>" path — segments are data-driven, not enumerable here. */
export const ASSUMPTION_BOUNDS = Object.freeze({
  tollRateUsd: [0, 10],
  "weights.revenue": [0, 1],
  "weights.delay": [0, 1],
  "weights.safety": [0, 1],
  "weights.crew": [0, 1],
  mergeFriction: [0.1, 1],
  segmentDemandScale: [0.1, 3],
});

/** Provenance badge per editable field, keyed the same way as ASSUMPTION_BOUNDS (spec §4: "Each
 * row badged SYNTHETIC/REAL/EXTERNAL"). tollRateUsd is REAL (Decision 4: "public I-595 express
 * toll rate"); the scoring weights, merge friction, and per-segment demand scale are all
 * SYNTHETIC (Decision 4's blank V6 cost columns / demand.js's own "SYNTHETIC" self-label). */
export const ASSUMPTION_BADGES = Object.freeze({
  tollRateUsd: "REAL",
  "weights.revenue": "SYNTHETIC",
  "weights.delay": "SYNTHETIC",
  "weights.safety": "SYNTHETIC",
  "weights.crew": "SYNTHETIC",
  mergeFriction: "SYNTHETIC",
  segmentDemandScale: "SYNTHETIC",
});

const VALID_BADGES = new Set(["SYNTHETIC", "REAL", "EXTERNAL"]);

/** Resolves a dot-path ("weights.revenue", "segmentDemandScale.east") to its [min, max] bounds,
 * falling back to the bare "segmentDemandScale" bucket for any per-segment path. Unknown paths
 * return null (caller passes the raw value through unclamped rather than guessing). */
export function boundsForAssumptionPath(path) {
  if (Object.prototype.hasOwnProperty.call(ASSUMPTION_BOUNDS, path)) return ASSUMPTION_BOUNDS[path];
  if (path?.startsWith("segmentDemandScale.")) return ASSUMPTION_BOUNDS.segmentDemandScale;
  return null;
}

/** Same resolution rule as boundsForAssumptionPath, for provenance badges. Returns null (render
 * no badge) for unrecognized paths rather than defaulting to a possibly-misleading label. */
export function badgeForAssumptionPath(path) {
  const badge = Object.prototype.hasOwnProperty.call(ASSUMPTION_BADGES, path)
    ? ASSUMPTION_BADGES[path]
    : path?.startsWith("segmentDemandScale.")
      ? ASSUMPTION_BADGES.segmentDemandScale
      : null;
  return VALID_BADGES.has(badge) ? badge : null;
}

/** Clamps `value` to boundsForAssumptionPath(path); non-finite input clamps to the lower bound.
 * Paths with no known bounds pass the numeric value through unchanged (NaN -> 0). */
export function clampAssumptionValue(path, value) {
  const n = typeof value === "number" ? value : parseFloat(value);
  const safe = Number.isFinite(n) ? n : 0;
  const bounds = boundsForAssumptionPath(path);
  if (!bounds) return safe;
  const [min, max] = bounds;
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}

function splitPath(path) {
  return String(path).split(".");
}

/** Reads a dot-path off an assumptions object; missing intermediate keys read as undefined
 * rather than throwing. */
export function getAssumptionAtPath(assumptions, path) {
  return splitPath(path).reduce((acc, key) => (acc == null ? undefined : acc[key]), assumptions);
}

/** Returns a NEW assumptions object with `path` set to clampAssumptionValue(path, value) —
 * assumptions and every object along the path are shallow-cloned, never mutated. Unknown
 * top-level paths create the nested object as needed (e.g. a not-yet-seen segment id). */
export function setAssumptionAtPath(assumptions, path, value) {
  const keys = splitPath(path);
  const clamped = clampAssumptionValue(path, value);
  const root = { ...(assumptions || {}) };
  let cursor = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    cursor[key] = { ...(cursor[key] || {}) };
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = clamped;
  return root;
}

/** Backfills any fields missing from `assumptions` with DEFAULT_ASSUMPTIONS (weights and
 * segmentDemandScale merged per-key, not wholesale-replaced) — returns a NEW object, input is
 * never mutated. Lets renderTrustPanel accept a partial/undefined assumptions prop without
 * throwing (matches the rest of UC1's keep-going-on-partial-data posture). */
export function mergeAssumptionDefaults(assumptions) {
  const a = assumptions || {};
  return {
    tollRateUsd: Number.isFinite(a.tollRateUsd) ? a.tollRateUsd : DEFAULT_ASSUMPTIONS.tollRateUsd,
    weights: { ...DEFAULT_ASSUMPTIONS.weights, ...(a.weights || {}) },
    mergeFriction: Number.isFinite(a.mergeFriction) ? a.mergeFriction : DEFAULT_ASSUMPTIONS.mergeFriction,
    segmentDemandScale: { ...DEFAULT_ASSUMPTIONS.segmentDemandScale, ...(a.segmentDemandScale || {}) },
    segments: Array.isArray(a.segments) ? a.segments : [],
  };
}

// ---- DOM rendering ------------------------------------------------------------------------------

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtNum(n, digits = 1) {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function fmtPct(n, digits = 0) {
  return typeof n === "number" && Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : "—";
}

function badgeHtml(badge) {
  if (!badge) return "";
  return `<span class="uc1-trust-badge uc1-trust-badge-${badge.toLowerCase()}">${badge}</span>`;
}

// ---- Tab 1: Backtest --------------------------------------------------------------------------

/** Rank position (0 = highest rate) of `segmentId` within an [id...] order array from
 * runBacktest()'s `ranking.predictedOrder`/`actualOrder`, or null if absent. */
function rankOf(order, segmentId) {
  if (!Array.isArray(order)) return null;
  const i = order.indexOf(segmentId);
  return i < 0 ? null : i;
}

function backtestRowHtml(row, ranking) {
  const predictedRank = rankOf(ranking?.predictedOrder, row?.segmentId);
  const actualRank = rankOf(ranking?.actualOrder, row?.segmentId);
  const rankMatch = predictedRank != null && predictedRank === actualRank;
  return `
    <tr class="uc1-trust-row">
      <td>${esc(row?.segmentName || row?.segmentId || "—")}</td>
      <td class="uc1-trust-cell">${fmtNum(row?.predictedRate, 3)} <span class="uc1-trust-sub">(${row?.predictedClosures ?? "—"})</span></td>
      <td class="uc1-trust-cell">${fmtNum(row?.actualRate, 3)} <span class="uc1-trust-sub">(${row?.actualClosures ?? "—"})</span></td>
      <td class="uc1-trust-cell">${predictedRank != null ? `#${predictedRank + 1}` : "—"}</td>
      <td class="uc1-trust-cell">${actualRank != null ? `#${actualRank + 1}` : "—"}</td>
      <td class="uc1-trust-cell ${rankMatch ? "green" : ""}">${predictedRank != null && actualRank != null ? (rankMatch ? "match" : "off") : "—"}</td>
    </tr>`;
}

/** Renders runBacktest()'s `coverage` object (train/test row + closure counts, unparsable-date
 * count) as a short honest sentence — not a computed stat, just a plain-language readout of what
 * the holdout actually had to work with. */
function coverageNoteHtml(coverage) {
  if (!coverage) return "";
  const train = coverage.train || {};
  const test = coverage.test || {};
  return `<div class="uc1-trust-coverage">Coverage: train ${train.rows ?? "—"} incidents (${train.closureRows ?? "—"} closures) &middot; test ${test.rows ?? "—"} incidents (${test.closureRows ?? "—"} closures) &middot; ${coverage.unparsableDates ?? 0} rows skipped (unparsable date).</div>`;
}

function backtestTabHtml(backtestResult) {
  const segments = backtestResult?.segments || [];
  const ranking = backtestResult?.ranking || {};
  const durationClass = backtestResult?.durationClass || {};
  const honestyLine = backtestResult?.honestyLine || HONESTY_LINE;

  const tableHtml =
    segments.length > 0
      ? `
    <div class="uc1-trust-table-wrap">
      <table class="uc1-trust-table">
        <thead>
          <tr>
            <th>Segment</th>
            <th>Predicted rate (n)</th>
            <th>Actual rate (n)</th>
            <th>Predicted rank</th>
            <th>Actual rank</th>
            <th>Rank</th>
          </tr>
        </thead>
        <tbody>${segments.map((row) => backtestRowHtml(row, ranking)).join("")}</tbody>
      </table>
    </div>`
      : `<div class="uc1-trust-empty">No holdout segments to show yet.</div>`;

  return `
    <div class="uc1-trust-honesty">${esc(honestyLine)}</div>
    <div class="uc1-trust-subhead">Temporal holdout: year-1 fit, year-2 predicted vs. actual, per segment.</div>
    ${tableHtml}
    <div class="uc1-trust-stats">
      <div class="uc1-trust-stat">
        <div class="uc1-trust-stat-v">${fmtNum(ranking?.spearmanRho, 2)}</div>
        <div class="uc1-trust-stat-l">Segment rank agreement (Spearman &rho;)</div>
      </div>
      <div class="uc1-trust-stat">
        <div class="uc1-trust-stat-v">${fmtPct(durationClass?.hitRate)}</div>
        <div class="uc1-trust-stat-l">Duration-class hit rate (n=${durationClass?.n ?? 0})</div>
      </div>
    </div>
    ${coverageNoteHtml(backtestResult?.coverage)}
  `;
}

// ---- Tab 2: Assumptions -------------------------------------------------------------------------

function sliderRowHtml(path, label, value, badge, step = 0.05) {
  const bounds = boundsForAssumptionPath(path) || [0, 1];
  const [min, max] = bounds;
  return `
    <div class="uc1-trust-assump-row" data-path="${esc(path)}">
      <div class="uc1-trust-assump-label">${esc(label)} ${badgeHtml(badge)}</div>
      <div class="uc1-trust-slider-row">
        <input type="range" class="uc1-trust-slider" min="${min}" max="${max}" step="${step}" value="${value}" data-path="${esc(path)}" />
        <span class="uc1-trust-slider-v">${fmtNum(value, path === "tollRateUsd" ? 2 : 2)}</span>
      </div>
    </div>`;
}

function segmentLabel(segments, id) {
  return segments.find((s) => s.id === id)?.name || id;
}

function assumptionsTabHtml(assumptions) {
  const a = mergeAssumptionDefaults(assumptions);
  const segmentIds = Object.keys(a.segmentDemandScale);

  return `
    <div class="uc1-trust-assump-group">
      ${sliderRowHtml("tollRateUsd", "Toll rate ($)", a.tollRateUsd, badgeForAssumptionPath("tollRateUsd"), 0.25)}
      ${sliderRowHtml("weights.revenue", "w1 · Revenue weight", a.weights.revenue, badgeForAssumptionPath("weights.revenue"))}
      ${sliderRowHtml("weights.delay", "w2 · Delay weight", a.weights.delay, badgeForAssumptionPath("weights.delay"))}
      ${sliderRowHtml("weights.safety", "w3 · Safety weight", a.weights.safety, badgeForAssumptionPath("weights.safety"))}
      ${sliderRowHtml("weights.crew", "w4 · Crew weight", a.weights.crew, badgeForAssumptionPath("weights.crew"))}
      ${sliderRowHtml("mergeFriction", "Merge friction", a.mergeFriction, badgeForAssumptionPath("mergeFriction"))}
    </div>
    ${
      segmentIds.length > 0
        ? `<div class="uc1-trust-assump-subhead">Per-segment demand scale</div>
           <div class="uc1-trust-assump-group">
             ${segmentIds
               .map((id) =>
                 sliderRowHtml(
                   `segmentDemandScale.${id}`,
                   segmentLabel(a.segments, id),
                   a.segmentDemandScale[id],
                   badgeForAssumptionPath("segmentDemandScale")
                 )
               )
               .join("")}
           </div>`
        : ""
    }
    <div class="uc1-trust-note">${badgeHtml("EXTERNAL")} Demand curve shape is not sanity-checked against OpenPath's sample in this package.</div>
  `;
}

// ---- Public entry point -------------------------------------------------------------------------

/**
 * renderTrustPanel(containerEl, { backtestResult, assumptions, onAssumptionChange })
 *
 * No-op when containerEl is missing (same defensive posture as windowPanel.js/contextPanel.js).
 * Preserves the active tab across re-renders via containerEl.dataset.uc1TrustTab. Slider inputs
 * update their own numeric readout in place (not a full re-render) so dragging doesn't fight the
 * browser's own slider focus/state, then call onAssumptionChange(newAssumptions) on every 'input'
 * event so the window table can re-rank live (spec's "stress-test moment").
 */
export function renderTrustPanel(containerEl, { backtestResult, assumptions, onAssumptionChange } = {}) {
  if (!containerEl) return;

  const activeTab = containerEl.dataset.uc1TrustTab === "assumptions" ? "assumptions" : "backtest";
  let currentAssumptions = mergeAssumptionDefaults(assumptions);

  containerEl.classList.remove("hidden");
  containerEl.innerHTML = `
    <button class="dc-panel-close" aria-label="Close">&times;</button>
    <div class="dc-panel-h">Trust panel</div>
    <div class="dc-panel-sub">How this recommendation was checked, and what's still an assumption.</div>
    <div class="uc1-trust-tabs" role="tablist">
      <button type="button" class="uc1-trust-tab${activeTab === "backtest" ? " on" : ""}" data-tab="backtest" role="tab" aria-selected="${activeTab === "backtest"}">Backtest</button>
      <button type="button" class="uc1-trust-tab${activeTab === "assumptions" ? " on" : ""}" data-tab="assumptions" role="tab" aria-selected="${activeTab === "assumptions"}">Assumptions</button>
    </div>
    <div class="uc1-trust-body">
      ${activeTab === "backtest" ? backtestTabHtml(backtestResult) : assumptionsTabHtml(currentAssumptions)}
    </div>
  `;

  const closeBtn = containerEl.querySelector(".dc-panel-close");
  if (closeBtn) closeBtn.onclick = () => containerEl.classList.add("hidden");

  containerEl.querySelectorAll(".uc1-trust-tab").forEach((btn) => {
    btn.onclick = () => {
      containerEl.dataset.uc1TrustTab = btn.getAttribute("data-tab");
      renderTrustPanel(containerEl, { backtestResult, assumptions: currentAssumptions, onAssumptionChange });
    };
  });

  containerEl.querySelectorAll(".uc1-trust-slider").forEach((input) => {
    input.oninput = () => {
      const path = input.getAttribute("data-path");
      currentAssumptions = setAssumptionAtPath(currentAssumptions, path, input.value);
      const readout = input.parentElement?.querySelector(".uc1-trust-slider-v");
      if (readout) readout.textContent = fmtNum(getAssumptionAtPath(currentAssumptions, path), 2);
      if (typeof onAssumptionChange === "function") onAssumptionChange(currentAssumptions);
    };
  });
}
