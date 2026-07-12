/*---------------------------------------------------------------------------------------------
 * glassBox.js — UC1 deck-parity item 6 ("glass box" popovers, Phase 12). Pure logic only — no
 * DOM/Cesium imports, importable in plain Node (node --test). Turns a windowEval.js
 * evaluateWindow() result's `ingredients` bundle (Phase 12's addition — echoes the LIVE-resolved
 * config actually used for that evaluation, not a re-read of the static config file) and an
 * exec-KPI decision list into small [{label, value[, badge]}] arrays the DOM layer (Phase 13's
 * windowPanel.js / execKpis.js popovers) renders verbatim. Provenance badges come from
 * trustPanel.js's exported badgeForAssumptionPath() (imported, not re-invented, per Decision 4's
 * "each row badged SYNTHETIC/REAL/EXTERNAL" rule). Per-decision revenue/crash deltas come from
 * execKpis.js's exported decisionDeltas() (same function computeExecKpis() sums — cross-checked
 * by tests/glassBox.test.mjs so the popover total can never drift from the tile total).
 *--------------------------------------------------------------------------------------------*/

import { badgeForAssumptionPath } from "./trustPanel.js";
import { decisionDeltas } from "./execKpis.js";

const DASH = "—";

function line(label, value, badge) {
  return { label, value, badge: badge ?? null };
}

function fmtUsdPerVeh(n) {
  return typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(2)}/veh` : DASH;
}

function fmtVphpl(n) {
  return typeof n === "number" && Number.isFinite(n) ? `${n} vphpl` : DASH;
}

function fmtWeight(n) {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : DASH;
}

function fmtCount(n) {
  return typeof n === "number" && Number.isFinite(n) ? String(n) : DASH;
}

function fmtPct(n) {
  return typeof n === "number" && Number.isFinite(n) ? `${n.toFixed(1)}%` : DASH;
}

function fmtMin(n) {
  return typeof n === "number" && Number.isFinite(n) ? `${n.toFixed(1)} min` : DASH;
}

/** Demand-slice summary: "N slices, avg X vph" from result.queue.slices, "—" when unavailable. */
function demandSliceSummary(result) {
  const slices = result?.queue?.slices;
  if (!Array.isArray(slices) || slices.length === 0) return DASH;
  const demands = slices.map((s) => s?.demandVph).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (demands.length === 0) return DASH;
  const avg = demands.reduce((a, v) => a + v, 0) / demands.length;
  return `${slices.length} slices, avg ${Math.round(avg)} vph`;
}

// ---- windowIngredientLines -----------------------------------------------------------------------

const FIELD_BUILDERS = {
  revenue(result) {
    const ing = result?.ingredients || {};
    return [
      line("Toll rate", fmtUsdPerVeh(ing.tollRateUsd), badgeForAssumptionPath("tollRateUsd")),
      line("Work-zone capacity", fmtVphpl(ing.workZoneCapacityVphpl), null),
      line("Demand slices", demandSliceSummary(result), null),
    ];
  },
  delay(result) {
    const ing = result?.ingredients || {};
    return [
      line("Work-zone capacity", fmtVphpl(ing.workZoneCapacityVphpl), null),
      line("Merge friction", fmtWeight(ing.mergeFriction), badgeForAssumptionPath("mergeFriction")),
      line("Avg delay", fmtMin(result?.queue?.avgDelayMin), null),
    ];
  },
  throughput(result) {
    const ing = result?.ingredients || {};
    return [
      line("Work-zone capacity", fmtVphpl(ing.workZoneCapacityVphpl), null),
      line("Open lanes / total lanes", `${fmtCount(result?.openLanes)} / ${fmtCount(result?.totalLanes)}`, null),
      line("Demand slices", demandSliceSummary(result), null),
    ];
  },
  laneAvailability(result) {
    return [
      line("Open lanes", fmtCount(result?.openLanes), null),
      line("Total lanes", fmtCount(result?.totalLanes), null),
      line("Lane availability", fmtPct(result?.laneAvailabilityPct), null),
    ];
  },
  crashRisk(result) {
    const cr = result?.closureRate || {};
    return [
      line("Segment sample size", fmtCount(cr.segmentSampleSize), null),
      line("Corridor sample size", fmtCount(cr.corridorSampleSize), null),
      line("Blend weight", fmtWeight(cr.weight), null),
    ];
  },
  score(result) {
    const weights = result?.ingredients?.weights || {};
    return [
      line("w1 · Revenue weight", fmtWeight(weights.revenue), badgeForAssumptionPath("weights.revenue")),
      line("w2 · Delay weight", fmtWeight(weights.delay), badgeForAssumptionPath("weights.delay")),
      line("w3 · Safety weight", fmtWeight(weights.safety), badgeForAssumptionPath("weights.safety")),
      line("w4 · Crew weight", fmtWeight(weights.crew), badgeForAssumptionPath("weights.crew")),
    ];
  },
};

/**
 * windowIngredientLines(field, result) -> [{label, value, badge}]
 *
 * field — one of "revenue"|"delay"|"throughput"|"laneAvailability"|"crashRisk"|"score". Any other
 *   value (including undefined) returns [] rather than throwing.
 * result — normally an evaluateWindow() return value. Missing/malformed input never throws: every
 *   builder above reads through optional chaining and falls back to the "—" placeholder per line,
 *   so a partial result (e.g. missing `ingredients`) still returns the field's usual line shape
 *   with dash values instead of an empty array — the popover renders "we don't have that" rather
 *   than silently vanishing.
 */
export function windowIngredientLines(field, result) {
  const builder = FIELD_BUILDERS[field];
  if (!builder) return [];
  return builder(result || {});
}

// ---- execTileIngredientLines ---------------------------------------------------------------------

function decisionLabel(d, i) {
  return d?.id ?? d?.decisionId ?? `Decision ${i + 1}`;
}

const TILE_BUILDERS = {
  revenueProtected(decisions, windowResults) {
    return decisions.map((d, i) => {
      const entry = Array.isArray(windowResults) ? windowResults[i] : null;
      const delta = decisionDeltas(d, entry);
      return { label: decisionLabel(d, i), value: delta.revenueDeltaUsd };
    });
  },
  secondaryIncidentsAvoided(decisions, windowResults) {
    return decisions.map((d, i) => {
      const entry = Array.isArray(windowResults) ? windowResults[i] : null;
      const delta = decisionDeltas(d, entry);
      return { label: decisionLabel(d, i), value: delta.crashExposureDelta };
    });
  },
  closureHoursAvoided(decisions) {
    return decisions
      .filter((d) => (typeof d?.rank === "number" ? d.rank === 1 : true))
      .map((d, i) => ({ label: decisionLabel(d, i), value: typeof d?.window?.durationHours === "number" ? d.window.durationHours : 0 }));
  },
  pctOptimalWindow(decisions) {
    return decisions.map((d, i) => ({ label: decisionLabel(d, i), value: typeof d?.rank === "number" ? d.rank : 1 }));
  },
};

/**
 * execTileIngredientLines(tileKey, decisions, windowResults) -> [{label, value}]
 *
 * tileKey — one of computeExecKpis()'s tile keys: "revenueProtected"|"closureHoursAvoided"|
 *   "pctOptimalWindow"|"secondaryIncidentsAvoided". Any other value, or an empty/missing
 *   `decisions` array, returns [] rather than throwing.
 * decisions / windowResults — same shapes computeExecKpis() takes; revenueProtected and
 *   secondaryIncidentsAvoided route through execKpis.js's exported decisionDeltas() (the exact
 *   same per-decision math computeExecKpis() sums), so summing this array's `value` field always
 *   reproduces that tile's computeExecKpis() total.
 */
export function execTileIngredientLines(tileKey, decisions, windowResults) {
  const rows = Array.isArray(decisions) ? decisions : [];
  if (rows.length === 0) return [];
  const builder = TILE_BUILDERS[tileKey];
  if (!builder) return [];
  return builder(rows, windowResults);
}
