/*---------------------------------------------------------------------------------------------
 * backtest.js — UC1 P5-a: trust-panel BACKTEST tab (design spec §4). Pure logic only — no
 * DOM/Cesium/React imports, config-driven (config/backtestConfig.json), importable in plain
 * Node (node --test).
 *
 * TEMPORAL HOLDOUT (review-mandated honesty rule, spec §4): fit on closures dated year 1
 * (Apr 2024-Mar 2025) — segment closure rates + a coarse duration-class model (short/medium/
 * long) from incident type + segment — then PREDICT year 2 (Apr 2025-Mar 2026) and compare
 * against year-2 actuals. Never fit and score on the same rows.
 *
 * Outputs are restricted to what the package can actually check against real actuals:
 *   - per-segment predicted-vs-actual closure recurrence (closureIncidentStats-style rate,
 *     reused from windowEval.js so this never reimplements that formula)
 *   - risk ranking comparison: predicted order vs actual order of segments by rate, plus a
 *     simple Spearman rank-correlation
 *   - duration-class confusion counts + hit rate
 *   - coverage stats (how many rows were usable, and why some weren't)
 *
 * Delay and revenue are explicitly OUT of scope here — there are no traffic actuals in this
 * package to check them against. HONESTY_LINE is exported and always surfaced on the result
 * verbatim (spec §4 / slide 10's "say it plainly" rule) rather than left to the caller to word.
 *--------------------------------------------------------------------------------------------*/

import { closureIncidentStats } from "./windowEval.js";

export const HONESTY_LINE =
  "traffic delay and exact revenue figures are calibrated in the pilot — no traffic actuals in this package.";

// ---- date parsing --------------------------------------------------------------------------------

/**
 * Parses the incidents_v3.json `incident_date` field, e.g. "2024-05-27T00:00:00" (ISO, no
 * timezone offset). Returns a Date, or null for missing/malformed input — callers must treat
 * null as "unusable row", never as epoch-0.
 */
export function parseIncidentDate(value) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function inWindow(date, startIso, endIso) {
  if (!date) return false;
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  const t = date.getTime();
  return t >= start && t < end;
}

// ---- closure row helpers --------------------------------------------------------------------------

function isClosureYes(v) {
  return /^y(es)?$/i.test(String(v ?? "").trim());
}

// ---- duration-class thresholds ---------------------------------------------------------------------

/** short/medium/long bucketing off config.durationClasses. Returns null for missing/invalid hours. */
export function durationClassOf(hours, config) {
  if (hours == null) return null;
  const h = Number(hours);
  if (!Number.isFinite(h)) return null;
  const thresholds = config?.durationClasses || {};
  const shortMax = thresholds.shortMaxHours ?? 2;
  const mediumMax = thresholds.mediumMaxHours ?? 5;
  if (h <= shortMax) return "short";
  if (h <= mediumMax) return "medium";
  return "long";
}

const DURATION_CLASSES = ["short", "medium", "long"];

// ---- per-segment closure recurrence (predicted from year1, actual from year2) ------------------

function segmentRateRow(segment, trainRows, testRows) {
  const segTrain = trainRows.filter((r) => r?.Segment === segment.name);
  const segTest = testRows.filter((r) => r?.Segment === segment.name);
  const predicted = closureIncidentStats(segTrain);
  const actual = closureIncidentStats(segTest);
  return {
    segmentId: segment.id,
    segmentName: segment.name,
    predictedClosures: predicted.closures,
    predictedRate: predicted.rate,
    actualClosures: actual.closures,
    actualRate: actual.rate,
    trainSampleSize: predicted.sampleSize,
    testSampleSize: actual.sampleSize,
  };
}

// ---- risk ranking comparison (predicted order vs actual order) ---------------------------------

/** Rank ids by `key` descending (rank 0 = highest). Simple, ties broken by input order. */
function rankByDesc(rows, key) {
  return [...rows]
    .sort((a, b) => b[key] - a[key])
    .map((r) => r.segmentId);
}

/**
 * Simple Spearman rank correlation between two orderings of the same id set: rho = 1 -
 * 6*Sum(d_i^2) / (n*(n^2-1)). Returns null when n < 2 (undefined / not meaningfully comparable).
 */
function spearmanRho(predictedOrder, actualOrder) {
  const n = predictedOrder.length;
  if (n < 2) return null;
  const actualRank = new Map(actualOrder.map((id, i) => [id, i]));
  let sumSqDiff = 0;
  predictedOrder.forEach((id, predictedRank) => {
    const d = predictedRank - (actualRank.get(id) ?? predictedRank);
    sumSqDiff += d * d;
  });
  return 1 - (6 * sumSqDiff) / (n * (n * n - 1));
}

// ---- duration-class model: fit on year1 (incident type + segment), predict year2 ----------------

function majorityClass(counts) {
  let best = null;
  let bestCount = -1;
  for (const cls of DURATION_CLASSES) {
    const c = counts[cls] || 0;
    if (c > bestCount) {
      bestCount = c;
      best = cls;
    }
  }
  return bestCount > 0 ? best : null;
}

function bumpCounts(map, key, cls) {
  if (!map.has(key)) map.set(key, { short: 0, medium: 0, long: 0 });
  const counts = map.get(key);
  counts[cls] = (counts[cls] || 0) + 1;
}

function typeSegmentKey(row) {
  return `${row?.incident_type ?? "UNKNOWN"}|${row?.Segment ?? "UNKNOWN"}`;
}

function typeKey(row) {
  return row?.incident_type ?? "UNKNOWN";
}

/**
 * Fits a coarse duration-class model on training closure rows: majority class per
 * (incident_type, Segment), with fallbacks to majority-per-type and a global majority for keys
 * unseen in training (spec: "duration class from incident type + segment").
 */
function fitDurationModel(trainClosureRows, config) {
  const byTypeSegment = new Map();
  const byType = new Map();
  const global = { short: 0, medium: 0, long: 0 };

  for (const row of trainClosureRows) {
    const cls = durationClassOf(row.lane_closure_duration_hours, config);
    if (!cls) continue;
    bumpCounts(byTypeSegment, typeSegmentKey(row), cls);
    bumpCounts(byType, typeKey(row), cls);
    global[cls] += 1;
  }

  const globalMajority = majorityClass(global);

  return {
    predict(row) {
      const tsKey = typeSegmentKey(row);
      if (byTypeSegment.has(tsKey)) {
        const cls = majorityClass(byTypeSegment.get(tsKey));
        if (cls) return { class: cls, basis: "type+segment" };
      }
      const tKey = typeKey(row);
      if (byType.has(tKey)) {
        const cls = majorityClass(byType.get(tKey));
        if (cls) return { class: cls, basis: "type" };
      }
      return { class: globalMajority, basis: "global" };
    },
  };
}

function emptyConfusion() {
  const confusion = {};
  for (const actualCls of DURATION_CLASSES) {
    confusion[actualCls] = {};
    for (const predictedCls of DURATION_CLASSES) confusion[actualCls][predictedCls] = 0;
  }
  return confusion;
}

// ---- coverage stats -------------------------------------------------------------------------------

function windowCoverage(rows) {
  let closureRows = 0;
  let withSegment = 0;
  for (const r of rows) {
    if (isClosureYes(r?.lane_closure_y_n)) closureRows += 1;
    if (r?.Segment != null) withSegment += 1;
  }
  return { rows: rows.length, closureRows, withSegment };
}

// ---- runBacktest -----------------------------------------------------------------------------------

/**
 * runBacktest({incidents, segments, config}) -> temporal-holdout backtest result.
 *   incidents — raw Incidents_V3 rows (array).
 *   segments  — segment registry rows [{id, name, ...}] (config/segments.json shape).
 *   config    — config/backtestConfig.json (holdout window bounds + duration-class thresholds).
 *
 * NO delay/revenue backtesting anywhere in the output — see HONESTY_LINE.
 */
export function runBacktest({ incidents, segments, config }) {
  const rows = incidents || [];
  const segs = segments || [];
  const holdout = config?.holdout || {};

  let unparsableDates = 0;
  const trainRows = [];
  const testRows = [];

  for (const r of rows) {
    const d = parseIncidentDate(r?.incident_date);
    if (!d) {
      unparsableDates += 1;
      continue;
    }
    if (inWindow(d, holdout.trainStart, holdout.trainEnd)) trainRows.push(r);
    else if (inWindow(d, holdout.testStart, holdout.testEnd)) testRows.push(r);
  }

  // ---- per-segment closure recurrence + risk ranking ----
  const segmentRows = segs.map((s) => segmentRateRow(s, trainRows, testRows));

  const predictedOrder = rankByDesc(segmentRows, "predictedRate");
  const actualOrder = rankByDesc(segmentRows, "actualRate");
  const ranking = {
    n: segmentRows.length,
    predictedOrder,
    actualOrder,
    spearmanRho: spearmanRho(predictedOrder, actualOrder),
  };

  // ---- duration-class model: fit on year1, predict+compare on year2 ----
  const trainClosureRows = trainRows.filter(
    (r) => isClosureYes(r?.lane_closure_y_n) && durationClassOf(r?.lane_closure_duration_hours, config)
  );
  const testClosureRows = testRows.filter(
    (r) => isClosureYes(r?.lane_closure_y_n) && durationClassOf(r?.lane_closure_duration_hours, config)
  );

  const model = fitDurationModel(trainClosureRows, config);
  const confusion = emptyConfusion();
  let hits = 0;
  for (const row of testClosureRows) {
    const actualCls = durationClassOf(row.lane_closure_duration_hours, config);
    const predicted = model.predict(row);
    const predictedCls = predicted.class;
    if (predictedCls && actualCls) {
      confusion[actualCls][predictedCls] = (confusion[actualCls][predictedCls] || 0) + 1;
      if (predictedCls === actualCls) hits += 1;
    }
  }
  const durationClass = {
    n: testClosureRows.length,
    hitRate: testClosureRows.length > 0 ? hits / testClosureRows.length : null,
    confusion,
    classes: DURATION_CLASSES,
  };

  // ---- coverage ----
  const coverage = {
    totalIncidents: rows.length,
    unparsableDates,
    train: windowCoverage(trainRows),
    test: windowCoverage(testRows),
  };

  return {
    honestyLine: HONESTY_LINE,
    coverage,
    segments: segmentRows,
    ranking,
    durationClass,
  };
}
