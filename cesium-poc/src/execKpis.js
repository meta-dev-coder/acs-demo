/*---------------------------------------------------------------------------------------------
 * execKpis.js — UC1 P5-c: the exec KPI strip (design spec §4 "Exec KPI strip") + Decision 5's
 * seeded-decision-log fix ("a live log holds one decision at demo time, which reads as an empty
 * dashboard... clearly labelled 'seeded from 2024-26 closure history'"). Pure math + a thin DOM
 * renderer, same split as contextPanel.js/windowPanel.js.
 *
 * Inputs are DECISION RECORDS in either of the two shapes this repo already produces:
 *   - SEED shape (tools/dataconnect-data/decisions_seed.json, tools/seed_decisions.mjs):
 *     window.durationHours, revenueAtRiskUsd{point,low,high,band}, queue.avgDelayMin,
 *     secondaryCrashExposure, openLanes/totalLanes, seeded:true, no `rank`.
 *   - LIVE shape (main.js's buildUc1DecisionRecord()): window.durationHours, revenueAtRiskUsd,
 *     top-level avgDelayMin (NOT nested under queue), laneAvailabilityPct (not openLanes/
 *     totalLanes), rank (1..3, the evaluator's rank among that decision's 3 candidate windows),
 *     no `seeded` flag.
 * normalizeDecisionEvidence() bridges both into one flat shape everything else here works from.
 *
 * "Worst-window minus chosen-window" deltas need a decision's full 3-candidate set to compute
 * exactly. Only windowAssembly.js's evaluateCandidates() output ({windows, results, winnerIdx})
 * carries that, and it isn't persisted on the decision record itself (see main.js's
 * buildUc1DecisionRecord — it snapshots only the CHOSEN window's numbers). So:
 *   - `windowResults` (optional, index-aligned with `decisions`) lets a caller that still has a
 *     fresh evaluateCandidates() result in memory (this session's just-scheduled decisions) pass
 *     it through for an EXACT delta.
 *   - Every other decision (every seeded row, and any live decision from an earlier session)
 *     falls back to an evidence-only approximation grounded in what the record actually stored —
 *     see decisionDeltas()'s comments for exactly what that approximates and why. Nothing here
 *     invents a number that isn't traceable to a stored field; per the seed file, revenue/delay
 *     legitimately net to zero on the fallback path (matches the trust panel's backtest-tab
 *     honesty line: "traffic delay and exact revenue figures are calibrated in the pilot").
 *
 * computeExecKpis() must work given ONLY the seed file (no windowResults) — that's the whole
 * point of Decision 5's seeded log.
 *--------------------------------------------------------------------------------------------*/

function num(v, fallback = 0) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function round(n, decimals) {
  const f = 10 ** decimals;
  return Math.round(num(n, 0) * f) / f;
}

// ---- evidence normalization (bridges the seed shape and the live buildUc1DecisionRecord shape) --

/**
 * normalizeDecisionEvidence(d) -> flat evidence fields, defaulting safely on any missing/
 * malformed input (never throws, never leaks NaN/undefined).
 */
export function normalizeDecisionEvidence(d) {
  const revenue = d?.revenueAtRiskUsd || {};
  const point = num(revenue.point, 0);
  const high = num(revenue.high, point);

  let laneAvailabilityFrac = null;
  if (typeof d?.laneAvailabilityPct === "number" && Number.isFinite(d.laneAvailabilityPct)) {
    laneAvailabilityFrac = d.laneAvailabilityPct / 100;
  } else if (Number.isFinite(d?.openLanes) && Number.isFinite(d?.totalLanes) && d.totalLanes > 0) {
    laneAvailabilityFrac = d.openLanes / d.totalLanes;
  }

  return {
    id: d?.id ?? d?.decisionId ?? null,
    seeded: d?.seeded === true,
    rank: typeof d?.rank === "number" ? d.rank : null,
    durationHours: num(d?.window?.durationHours, 0),
    revenueAtRiskPointUsd: point,
    revenueAtRiskHighUsd: high,
    avgDelayMin: num(d?.queue?.avgDelayMin ?? d?.avgDelayMin, 0),
    secondaryCrashExposure: num(d?.secondaryCrashExposure, 0),
    laneAvailabilityFrac,
  };
}

// ---- worst-vs-chosen deltas -------------------------------------------------------------------

/** Index of the chosen result within a windowAssembly.js evaluateCandidates()-shaped entry:
 * match by the decision's window id when the entry carries `windows`, else fall back to the
 * entry's own winnerIdx (best-scoring candidate) so a caller that only has `{results,winnerIdx}`
 * still works. */
function resolveChosenIndex(entry, decision) {
  const windows = entry?.windows;
  const windowId = decision?.window?.id;
  if (Array.isArray(windows) && windowId != null) {
    const idx = windows.findIndex((w) => w?.id === windowId);
    if (idx >= 0) return idx;
  }
  return typeof entry?.winnerIdx === "number" ? entry.winnerIdx : 0;
}

/** Exact worst-vs-chosen delta from a full candidate set. null when `entry` doesn't carry a
 * usable `results` array (malformed, or simply absent — the normal case for seeded/older rows). */
function candidateWorstChosenDelta(entry, decision) {
  const results = entry?.results;
  if (!Array.isArray(results) || results.length === 0) return null;

  let worstIdx = 0;
  for (let i = 1; i < results.length; i++) {
    if (num(results[i]?.score) > num(results[worstIdx]?.score)) worstIdx = i;
  }
  const chosenIdx = resolveChosenIndex(entry, decision);
  const worst = results[worstIdx] || {};
  const chosen = results[chosenIdx] || {};

  return {
    revenueDeltaUsd: Math.max(0, num(worst.revenueAtRiskUsd?.point) - num(chosen.revenueAtRiskUsd?.point)),
    delayDeltaMin: Math.max(0, num(worst.queue?.avgDelayMin) - num(chosen.queue?.avgDelayMin)),
    crashExposureDelta: Math.max(0, num(worst.secondaryCrashExposure) - num(chosen.secondaryCrashExposure)),
  };
}

/**
 * decisionDeltas(decision, candidateEntry) -> {revenueDeltaUsd, delayDeltaMin, crashExposureDelta}
 *
 * Prefers the exact candidate-set delta when `candidateEntry` is usable. Otherwise falls back to
 * an evidence-only approximation:
 *   - revenue: the evaluator's own recorded uncertainty band (high - point) for the chosen
 *     window. Honestly zero whenever the evaluator itself recorded zero revenue-at-risk — that's
 *     a real outcome for closures the evaluator scored as never exceeding closed capacity (mixed
 *     with non-zero rows in the committed seed file: some historical closures overlapped a peak
 *     or weekend-midday window, others genuinely didn't; see tools/seed_decisions.mjs).
 *   - delay: not inferable from one window's numbers alone -> 0 (same honesty call as revenue;
 *     matches the trust panel's backtest-tab line that delay/revenue aren't backtested).
 *   - secondary-crash exposure: the share of the recorded exposure attributable to the closed
 *     lane(s) — i.e. what going to a full closure (0% lanes open) would add on top of the actual
 *     partial-closure exposure, approximated by the closed-lane share (1 - laneAvailabilityFrac).
 *     Unknown lane availability -> 0 (no fabricated number).
 */
function decisionDeltas(decision, candidateEntry) {
  const exact = candidateWorstChosenDelta(candidateEntry, decision);
  if (exact) return exact;

  const ev = normalizeDecisionEvidence(decision);
  const closedFrac = ev.laneAvailabilityFrac == null ? 0 : 1 - ev.laneAvailabilityFrac;
  return {
    revenueDeltaUsd: Math.max(0, ev.revenueAtRiskHighUsd - ev.revenueAtRiskPointUsd),
    delayDeltaMin: 0,
    crashExposureDelta: ev.secondaryCrashExposure * closedFrac,
  };
}

// ---- computeExecKpis ----------------------------------------------------------------------------

/**
 * computeExecKpis(decisions, windowResults?) -> {
 *   revenueProtected, closureHoursAvoided, pctOptimalWindow, secondaryIncidentsAvoided,
 *   decisionCount, seededCount, hasSeededData,
 * }
 *
 * decisions   — array of decision records (seed and/or live shape, freely mixed).
 * windowResults — optional, index-aligned with `decisions`: evaluateCandidates()-shaped entries
 *   ({windows, results, winnerIdx}) for whichever decisions still have one in memory. Missing/
 *   null entries (the normal case for every seeded row) fall back per decisionDeltas() above.
 *
 * "Optimal window" (closureHoursAvoided / pctOptimalWindow) = the decision's rank === 1. Seeded
 * rows predate the optimizer and carry no `rank` — they represent the one historical outcome that
 * actually happened, so a missing rank defaults to 1 (counted as its own realized choice) rather
 * than being silently dropped from the denominator; this is what keeps the KPI strip non-empty on
 * the seed file alone (Decision 5).
 */
export function computeExecKpis(decisions, windowResults) {
  const rows = Array.isArray(decisions) ? decisions : [];

  let revenueProtected = 0;
  let secondaryIncidentsAvoided = 0;
  let closureHoursAvoided = 0;
  let optimalCount = 0;
  let seededCount = 0;

  rows.forEach((d, i) => {
    const entry = Array.isArray(windowResults) ? windowResults[i] : null;
    const delta = decisionDeltas(d, entry);
    revenueProtected += delta.revenueDeltaUsd;
    secondaryIncidentsAvoided += delta.crashExposureDelta;

    const ev = normalizeDecisionEvidence(d);
    if (ev.seeded) seededCount += 1;

    const rank = ev.rank ?? 1;
    if (rank === 1) {
      optimalCount += 1;
      closureHoursAvoided += ev.durationHours;
    }
  });

  const total = rows.length;

  return {
    revenueProtected: round(revenueProtected, 2),
    closureHoursAvoided: round(closureHoursAvoided, 2),
    pctOptimalWindow: total > 0 ? round((optimalCount / total) * 100, 1) : 0,
    secondaryIncidentsAvoided: round(secondaryIncidentsAvoided, 2),
    decisionCount: total,
    seededCount,
    hasSeededData: seededCount > 0,
  };
}

// ---- renderExecKpiStrip (DOM) -------------------------------------------------------------------

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtUsd(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function fmtHours(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)} h`;
}

function fmtPct(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `${n.toFixed(1)}%`;
}

// secondaryIncidentsAvoided is an EXPOSURE INDEX (same units as windowEval.js's E(w)), not a
// literal incident count — kept at 2 decimals so it doesn't misread as a whole-number tally.
function fmtIndex(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

const TILES = [
  { key: "revenueProtected", label: "Revenue protected", fmt: fmtUsd },
  { key: "closureHoursAvoided", label: "Closure hours avoided", fmt: fmtHours },
  { key: "pctOptimalWindow", label: "% closures in optimal window", fmt: fmtPct },
  { key: "secondaryIncidentsAvoided", label: "Secondary incidents avoided", fmt: fmtIndex },
];

/**
 * renderExecKpiStrip(containerEl, kpis, {seededNote})
 *
 * kpis — normally computeExecKpis()'s return value.
 * seededNote — override for whether the "includes seeded ... closure history" honesty label
 *   shows; defaults to kpis.hasSeededData (spec's honesty rule: show it whenever ANY decision in
 *   the strip is seeded). No-ops when containerEl is missing.
 */
export function renderExecKpiStrip(containerEl, kpis, { seededNote } = {}) {
  if (!containerEl) return;
  const k = kpis || {};
  const showNote = seededNote ?? k.hasSeededData === true;

  const tilesHtml = TILES.map(
    (t) => `<div class="uc1-exec-kpi"><div class="v">${esc(t.fmt(k[t.key]))}</div><div class="l">${esc(t.label)}</div></div>`
  ).join("");

  containerEl.innerHTML = `
    <div class="uc1-exec-kpis">${tilesHtml}</div>
    ${showNote ? `<div class="uc1-exec-kpi-note">Includes seeded 2024-26 closure history</div>` : ""}
  `;
}
