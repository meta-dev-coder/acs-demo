#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 * seed_decisions.mjs — UC1 deck-parity Phase 1 (item 5, "seed revenue $0" fix): generates
 * tools/dataconnect-data/decisions_seed.json (and its runtime copy,
 * cesium-poc/public/dataconnect-data/decisions_seed.json) by running the ~15 historical
 * lane-closure rows straight through the REAL evaluator — createWindowEvaluator()
 * (cesium-poc/src/windowEval.js), fed by cesium-poc/src/demand.js's actual 15-minute demand
 * curve — instead of tools/seed_decisions.py's closed-form single-slice approximation.
 *
 * Root cause of the $0 bug: the old script estimated demand with a single constant slice at
 * demandProfile.json's SHOULDER multiplier (0.35), which — for every segment's demandScale —
 * never exceeds C_closed (workZoneCapacityVphpl * openLanes * mergeFriction), so
 * revenueAtRiskUsd.point was $0 for every one of the 15 seed rows, every time. Running the same
 * rows through the real per-15-minute evaluator (which sees each historical closure's actual
 * incident_date/incident_time, including any AM/PM peak or weekend-midday hours the closure
 * window overlapped) produces real excess-demand slices for rows that cross a peak, and
 * legitimately $0 for rows that don't — matching the honesty rule that not every closure creates
 * revenue-at-risk.
 *
 * Field shape is intentionally unchanged from the old script's output (matches windowEval.js's
 * evaluateWindow() core fields plus the seed-only bookkeeping fields id/workOrderId/assetId/
 * decidedAt/incidentId/seeded/source) — a live-written decision (main.js's
 * buildUc1DecisionRecord()) and a seeded one still render identically in the trust panel / exec
 * KPI strip (see execKpis.js's normalizeDecisionEvidence()).
 *
 * tools/seed_decisions.py is now a deprecation stub pointing here — this is the only generator.
 *
 * Run: node tools/seed_decisions.mjs
 *--------------------------------------------------------------------------------------------*/
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createDemandModel } from "../cesium-poc/src/demand.js";
import { createWindowEvaluator } from "../cesium-poc/src/windowEval.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(HERE);
const DATA_DIR = path.join(HERE, "dataconnect-data");
const INCIDENTS_PATH = path.join(DATA_DIR, "incidents_v3.json");
const SEGMENTS_PATH = path.join(REPO_ROOT, "cesium-poc", "config", "segments.json");
const WINDOW_CONFIG_PATH = path.join(REPO_ROOT, "cesium-poc", "config", "windowConfig.json");
const OUT_PATHS = [
  path.join(DATA_DIR, "decisions_seed.json"),
  path.join(REPO_ROOT, "cesium-poc", "public", "dataconnect-data", "decisions_seed.json"),
];

const SEED_COUNT = 15;
const SOURCE_LABEL = "2024-26 closure history";

function loadJson(p) {
  return JSON.parse(readFileSync(p, "utf-8"));
}

function isClosureYes(v) {
  return /^y(es)?$/i.test(String(v ?? "").trim());
}

/**
 * pickClosures(incidents, count) -> Row[]
 *
 * Deterministic, date-sorted, evenly-strided sample across the eligible closure rows so the
 * ~15 seeds span segments/dates rather than clustering at the start of the export. Ported 1:1
 * from seed_decisions.py's `_pick_closures()` so the seeded rows' identity/date spread is
 * unchanged even though the math generating their fields is now the real evaluator.
 */
export function pickClosures(incidents, count) {
  const eligible = (incidents || [])
    .filter(
      (r) =>
        isClosureYes(r?.lane_closure_y_n) &&
        r?.Segment &&
        typeof r?.lane_closure_duration_hours === "number" &&
        r.lane_closure_duration_hours > 0
    )
    .sort((a, b) => {
      const da = String(a?.incident_date || "");
      const db = String(b?.incident_date || "");
      if (da !== db) return da < db ? -1 : 1;
      const ia = String(a?.incident_id || "");
      const ib = String(b?.incident_id || "");
      return ia < ib ? -1 : ia > ib ? 1 : 0;
    });
  if (eligible.length <= count) return eligible;
  const stride = eligible.length / count;
  return Array.from({ length: count }, (_, i) => eligible[Math.floor(i * stride)]);
}

/**
 * windowStartUtc(row) -> Date
 *
 * Explicit-UTC window start, TZ-independent (unlike a bare `new Date("...")` parse, which is
 * only UTC for a full "YYYY-MM-DDTHH:mm:ssZ" string — these rows carry no zone suffix). Matches
 * demand.js's own UTC-hour-of-day convention (see demand.js's header) so the seeded window lands
 * on the same demand-curve hour regardless of the host running this script.
 */
function windowStartUtc(row) {
  const date = String(row?.incident_date || "").slice(0, 10);
  const rawTime = row?.incident_time || "00:00";
  const time = rawTime.length === 5 ? `${rawTime}:00` : rawTime;
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm, ss] = time.split(":").map(Number);
  return new Date(Date.UTC(y || 1970, (m || 1) - 1, d || 1, hh || 0, mm || 0, ss || 0));
}

/** Unchanged naive-string convention from seed_decisions.py's `_window_start_iso()` — no
 * timezone suffix, kept for display/decidedAt continuity with the old seed file's shape. */
function windowStartIso(row) {
  const date = String(row?.incident_date || "").slice(0, 10);
  const time = row?.incident_time || "00:00";
  return time.length === 5 ? `${date}T${time}:00` : `${date}T${time}`;
}

function resolveSegment(name, segments) {
  return (segments || []).find((s) => s?.name === name) ?? null;
}

/**
 * buildDecision(row, segments, windowConfig, evaluator) -> DecisionRecord
 *
 * Runs the historical row through the REAL evaluator (`evaluator` — a createWindowEvaluator()
 * instance, already wired to a demand model and the full incidents list) instead of re-deriving
 * the math, so the seed file and a live-scheduled decision are produced by exactly the same code
 * path. Historical rows don't record lanes closed, so — same assumption as the old script — one
 * lane closed is assumed (openLanes = max(1, totalLanes - 1)).
 */
export function buildDecision(row, segments, windowConfig, evaluator) {
  const segment = resolveSegment(row.Segment, segments);
  const totalLanes = segment?.laneCount ?? 3;
  const openLanes = Math.max(1, totalLanes - 1);
  const segmentId = segment?.id ?? null;
  const durationHours = Number(row.lane_closure_duration_hours);

  const window = { start: windowStartUtc(row), durationHours };
  const closureSpec = { totalLanes, openLanes };
  const result = evaluator.evaluateWindow(segmentId, closureSpec, window);

  const band = result.revenueAtRiskUsd?.band ?? windowConfig?.revenueUncertaintyBand ?? 0.15;

  return {
    id: `SEED-DEC-${row.incident_id}`,
    workOrderId: null,
    assetId: row.damaged_asset_id ?? null,
    segmentId: result.segmentId,
    segmentName: row.Segment,
    window: { start: windowStartIso(row), durationHours },
    openLanes: result.openLanes,
    totalLanes: result.totalLanes,
    closedCapacityVph: result.closedCapacityVph,
    // Pick only the core fields (not e.g. `perSlice`, which belongs to the item-1 playback
    // feature) so this seed file's shape stays the same regardless of what else evaluateWindow()
    // grows to return over time.
    revenueAtRiskUsd: {
      point: round2(result.revenueAtRiskUsd?.point),
      low: round2(result.revenueAtRiskUsd?.low),
      high: round2(result.revenueAtRiskUsd?.high),
      band,
    },
    queue: { avgDelayMin: round2(result.queue?.avgDelayMin) },
    secondaryCrashExposure: round4(result.secondaryCrashExposure),
    score: round4(result.score),
    decidedAt: windowStartIso(row),
    incidentId: row.incident_id,
    seeded: true,
    source: SOURCE_LABEL,
  };
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

function main() {
  const incidents = loadJson(INCIDENTS_PATH);
  const segments = loadJson(SEGMENTS_PATH);
  const windowConfig = loadJson(WINDOW_CONFIG_PATH);

  const demandModel = createDemandModel(undefined, segments);
  const demandFn = (segmentId, window) => demandModel.getWindowDemand(segmentId, window.start, window.durationHours);
  const evaluator = createWindowEvaluator({ config: windowConfig, segments, incidents, demandFn });

  const picked = pickClosures(incidents, SEED_COUNT);
  const decisions = picked.map((row) => buildDecision(row, segments, windowConfig, evaluator));

  const json = JSON.stringify(decisions, null, 2) + "\n";
  for (const outPath of OUT_PATHS) {
    writeFileSync(outPath, json);
    console.log(`[seed_decisions] wrote ${decisions.length} seeded decisions -> ${outPath}`);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main();
