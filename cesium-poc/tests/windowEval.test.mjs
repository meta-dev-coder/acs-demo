/*---------------------------------------------------------------------------------------------
 * windowEval.test.mjs — UC1 P2-b: window evaluator (design spec §3). Small inline fixtures only
 * (mirrors adapter.test.mjs style). demandFn is always a hand-rolled fixture here — windowEval.js
 * must never import demand.js (decoupled from P2-a per task; integration happens later).
 *--------------------------------------------------------------------------------------------*/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  createWindowEvaluator,
  candidateWindows,
  rilcaSliceQueue,
  blendedClosureRate,
  revenueAtRisk,
  closedCapacityVph,
  buildWindowTimeseries,
} from "../src/windowEval.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "..", "config", "windowConfig.json");

function loadConfig() {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

const SEGMENTS = [
  { id: "east", name: "East Segment", lonBand: [-80.23, -80.18], laneCount: 3, demandScale: 1.2 },
  { id: "west", name: "West Segment", lonBand: [-80.36, -80.31], laneCount: 3, demandScale: 0.62 },
];

function closureIncident(segment, y, hours) {
  return { incident_id: `INC-${Math.random()}`, Segment: segment, lane_closure_y_n: y, lane_closure_duration_hours: hours };
}

// ---- 1. slice-wise RILCA matches closed-form on constant demand -------------------------------

test("rilcaSliceQueue: constant oversaturated demand matches closed-form triangle math", () => {
  const capacityVph = 2880; // e.g. 1600 * 2 open lanes * 0.9 merge friction
  const arrivalsVph = 3600;
  const sliceH = 0.25; // 15 min
  const nSlices = 8; // 2h window
  const demands = Array(nSlices).fill(arrivalsVph);

  const result = rilcaSliceQueue(demands, capacityVph, sliceH);

  const windowHours = nSlices * sliceH;
  const excessVph = arrivalsVph - capacityVph;
  const expectedMaxQueueVeh = excessVph * windowHours; // closed-form: (q1-C)*t1, whole window oversaturated
  const expectedTotalDelayVehHours = 0.5 * expectedMaxQueueVeh * windowHours; // triangle area, no recovery

  assert.ok(Math.abs(result.maxQueueVeh - expectedMaxQueueVeh) < 1e-6, `maxQueueVeh ${result.maxQueueVeh} vs ${expectedMaxQueueVeh}`);
  assert.ok(
    Math.abs(result.totalDelayVehHours - expectedTotalDelayVehHours) < 1e-6,
    `totalDelayVehHours ${result.totalDelayVehHours} vs ${expectedTotalDelayVehHours}`
  );

  const expectedTotalArrivals = arrivalsVph * windowHours;
  assert.ok(Math.abs(result.totalArrivals - expectedTotalArrivals) < 1e-6);
  const expectedAvgDelayMin = (expectedTotalDelayVehHours / expectedTotalArrivals) * 60;
  assert.ok(Math.abs(result.avgDelayMin - expectedAvgDelayMin) < 1e-6);
});

test("rilcaSliceQueue: queue carries over between slices (non-constant demand)", () => {
  const capacityVph = 1000;
  const sliceH = 0.25;
  // slice 1 oversaturated, slice 2 undersaturated but not enough to fully drain -> queue must persist
  const demands = [2000, 800];
  const result = rilcaSliceQueue(demands, capacityVph, sliceH);
  // slice 1: arrivals=500, cap=250 -> queueEnd=250
  // slice 2: arrivals=200, cap=250, queueStart=250 -> queueEnd=max(0,250+200-250)=200
  assert.ok(Math.abs(result.slices[0].queueEnd - 250) < 1e-6);
  assert.ok(Math.abs(result.slices[1].queueStart - 250) < 1e-6, "slice 2 must start from slice 1's leftover queue");
  assert.ok(Math.abs(result.slices[1].queueEnd - 200) < 1e-6);
  assert.ok(result.maxQueueVeh >= 250 - 1e-6);
});

test("rilcaSliceQueue: demand under capacity produces zero queue and zero delay", () => {
  const result = rilcaSliceQueue([500, 500, 500], 2000, 0.25);
  assert.equal(result.maxQueueVeh, 0);
  assert.equal(result.totalDelayVehHours, 0);
  assert.equal(result.avgDelayMin, 0);
});

// ---- C_closed --------------------------------------------------------------------------------

test("closedCapacityVph: 1600 * openLanes * mergeFriction", () => {
  const config = { workZoneCapacityVphpl: 1600, mergeFriction: 0.9 };
  assert.ok(Math.abs(closedCapacityVph(config, 2) - 2880) < 1e-6);
  assert.ok(Math.abs(closedCapacityVph(config, 0) - 0) < 1e-6);
  const defaulted = closedCapacityVph({}, 2);
  assert.ok(Math.abs(defaulted - 1600 * 2 * 0.9) < 1e-6, "defaults to 1600 vphpl / 0.9 merge friction when config omits them");
});

// ---- 2. overnight window scores better than PM peak -------------------------------------------

test("createWindowEvaluator: overnight window scores better (lower) than weekday 14:00 window", () => {
  const config = loadConfig();
  const incidents = [closureIncident("East Segment", "Yes", 3), closureIncident("East Segment", "No", 0)];
  const demandFn = (segmentId, window) => {
    const hour = new Date(window.start).getHours();
    const n = Math.round(window.durationHours / (config.sliceMinutes / 60));
    const vph = hour === 23 ? 800 : 4200; // overnight trough vs. daytime near-capacity/oversaturated
    return Array(n).fill(vph);
  };
  const evaluator = createWindowEvaluator({ config, segments: SEGMENTS, incidents, demandFn });

  const overnight = { id: "overnight", start: new Date("2026-07-13T23:00:00"), durationHours: 4 }; // Monday night
  const weekdayPm = { id: "weekdayPm", start: new Date("2026-07-13T14:00:00"), durationHours: 4 };

  const closureSpec = { lanesClosed: 1 };
  const overnightResult = evaluator.evaluateWindow("east", closureSpec, overnight);
  const pmResult = evaluator.evaluateWindow("east", closureSpec, weekdayPm);

  assert.ok(overnightResult.score < pmResult.score, `overnight score ${overnightResult.score} should be < PM score ${pmResult.score}`);
  assert.ok(overnightResult.revenueAtRiskUsd.point < pmResult.revenueAtRiskUsd.point);
  assert.ok(overnightResult.queue.avgDelayMin < pmResult.queue.avgDelayMin);

  const ranked = evaluator.rankWindows("east", closureSpec, [overnight, weekdayPm]);
  assert.equal(ranked[0].window.id, "overnight");
  assert.equal(ranked[0].rank, 1);
  assert.equal(ranked[0].winner, true);
  assert.equal(ranked[1].winner, false);
});

// ---- 3 & 4. segment/corridor rate blend --------------------------------------------------------

test("blendedClosureRate: zero segment sample size falls back to the corridor rate exactly", () => {
  const incidents = [
    closureIncident("Central Segment", "Yes", 5),
    closureIncident("Central Segment", "Yes", 3),
    closureIncident(null, "No", 0), // no-Segment row: corridor-only, per spec
  ];
  const blended = blendedClosureRate(incidents, "West Segment", 5); // West has 0 rows
  const corridorClosures = 2;
  const corridorHours = 8;
  const expectedCorridorRate = corridorClosures / corridorHours;
  assert.equal(blended.segmentSampleSize, 0);
  assert.equal(blended.weight, 0);
  assert.ok(Math.abs(blended.rate - expectedCorridorRate) < 1e-9);
  assert.ok(Math.abs(blended.rate - blended.corridorRate) < 1e-9);
});

test("blendedClosureRate: weight grows toward 1 as segment sample size grows, pulling rate toward the segment rate", () => {
  const corridorIncidents = [closureIncident("Central Segment", "Yes", 10), closureIncident(null, "No", 0)];
  // East Segment: 1 sample row, rate very different from corridor
  const smallSample = [...corridorIncidents, closureIncident("East Segment", "Yes", 1)];
  // East Segment: 50 duplicated sample rows, same local rate
  const bigSample = [...corridorIncidents, ...Array(50).fill(null).map(() => closureIncident("East Segment", "Yes", 1))];

  const small = blendedClosureRate(smallSample, "East Segment", 5);
  const big = blendedClosureRate(bigSample, "East Segment", 5);

  assert.ok(small.weight > 0 && small.weight < 1);
  assert.ok(big.weight > small.weight, `weight should grow with sample size: ${small.weight} -> ${big.weight}`);
  assert.ok(big.weight > 0.9, "large segment sample should dominate the blend");

  const segRate = big.segmentRate;
  const corridorRate = big.corridorRate;
  assert.ok(
    Math.abs(big.rate - segRate) < Math.abs(small.rate - segRate),
    "blended rate should move closer to the segment rate as sample size grows"
  );
  assert.notEqual(segRate, corridorRate, "fixture must have distinguishable segment vs corridor rates");
});

// ---- 5. score monotonic in weights ---------------------------------------------------------------

test("createWindowEvaluator: score is monotonically non-decreasing as the delay weight increases", () => {
  const baseConfig = loadConfig();
  const incidents = [closureIncident("East Segment", "Yes", 4)];
  const demandFn = () => Array(16).fill(3600); // oversaturated -> nonzero delay component
  const closureSpec = { lanesClosed: 1 };
  const window = { start: new Date("2026-07-13T14:00:00"), durationHours: 4 };

  const scores = [0, 0.2, 0.5, 1.0].map((w2) => {
    const config = JSON.parse(JSON.stringify(baseConfig));
    config.weights.delay = w2;
    const evaluator = createWindowEvaluator({ config, segments: SEGMENTS, incidents, demandFn });
    return evaluator.evaluateWindow("east", closureSpec, window).score;
  });

  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] >= scores[i - 1] - 1e-9, `score must not decrease as delay weight rises: ${scores}`);
  }
  assert.ok(scores[scores.length - 1] > scores[0], "score must strictly increase overall given nonzero delay");
});

// ---- 6. revenue uncertainty band brackets the point estimate -------------------------------------

test("revenueAtRisk: uncertainty band brackets the point estimate", () => {
  const config = { revenueUncertaintyBand: 0.15 };
  const capacityVph = 2000;
  const sliceH = 0.25;
  const slices = [{ demandVph: 3000 }, { demandVph: 3500 }, { demandVph: 1000 }];
  const tollRateUsd = 2.5;

  const r = revenueAtRisk(config, slices, sliceH, capacityVph, tollRateUsd);

  assert.ok(r.point > 0, "some slices exceed capacity so revenue-at-risk must be positive");
  assert.ok(r.low <= r.point, `low ${r.low} should be <= point ${r.point}`);
  assert.ok(r.point <= r.high, `point ${r.point} should be <= high ${r.high}`);
  assert.ok(Math.abs(r.low - r.point * (1 - 0.15)) < 1e-9);
  assert.ok(Math.abs(r.high - r.point * (1 + 0.15)) < 1e-9);
});

test("revenueAtRisk: zero when demand never exceeds closed capacity", () => {
  const config = { revenueUncertaintyBand: 0.15 };
  const slices = [{ demandVph: 500 }, { demandVph: 900 }];
  const r = revenueAtRisk(config, slices, 0.25, 2000, 2.5);
  assert.equal(r.point, 0);
  assert.equal(r.low, 0);
  assert.equal(r.high, 0);
});

test("revenueAtRisk: perSlice length matches input slices, and sum(perSlice.revenueUsd) === point", () => {
  const config = { revenueUncertaintyBand: 0.15 };
  const capacityVph = 2000;
  const sliceH = 0.25;
  const slices = [{ demandVph: 3000 }, { demandVph: 3500 }, { demandVph: 1000 }];
  const tollRateUsd = 2.5;

  const r = revenueAtRisk(config, slices, sliceH, capacityVph, tollRateUsd);

  assert.equal(r.perSlice.length, slices.length);
  const sum = r.perSlice.reduce((a, s) => a + s.revenueUsd, 0);
  assert.ok(Math.abs(sum - r.point) < 1e-9, `sum(perSlice.revenueUsd) ${sum} should equal point ${r.point}`);
});

test("revenueAtRisk: perSlice entries are zero when demand never exceeds capacity", () => {
  const config = { revenueUncertaintyBand: 0.15 };
  const slices = [{ demandVph: 500 }, { demandVph: 900 }];
  const r = revenueAtRisk(config, slices, 0.25, 2000, 2.5);
  assert.equal(r.perSlice.length, 2);
  for (const s of r.perSlice) {
    assert.equal(s.excessVehicles, 0);
    assert.equal(s.revenueUsd, 0);
  }
});

// ---- candidateWindows heuristic -----------------------------------------------------------------

test("candidateWindows: returns 3 windows on the correct day types, all after fromDate", () => {
  const config = loadConfig();
  const fromDate = new Date("2026-07-13T09:00:00"); // a Monday
  const windows = candidateWindows(config, fromDate);

  assert.equal(windows.length, 3);
  const byId = Object.fromEntries(windows.map((w) => [w.id, w]));

  for (const w of windows) {
    assert.ok(w.start.getTime() > fromDate.getTime(), `${w.id} must be scheduled after fromDate`);
    assert.equal(typeof w.durationHours, "number");
  }

  const overnightDow = byId.overnight.start.getDay();
  assert.ok(overnightDow >= 1 && overnightDow <= 5, "overnight window must land on a weeknight (Mon-Fri)");
  assert.equal(byId.overnight.start.getHours(), 23);

  const weekendDow = byId.weekendMorning.start.getDay();
  assert.ok(weekendDow === 0 || weekendDow === 6, "weekend-morning window must land on Sat/Sun");
  assert.equal(byId.weekendMorning.start.getHours(), 7);

  const pmDow = byId.weekdayPm.start.getDay();
  assert.ok(pmDow >= 1 && pmDow <= 5, "weekday-14:00 window must land on a weekday (Mon-Fri)");
  assert.equal(byId.weekdayPm.start.getHours(), 14);
});

test("candidateWindows: is deterministic for a given fromDate", () => {
  const config = loadConfig();
  const fromDate = new Date("2026-07-13T09:00:00");
  const a = candidateWindows(config, fromDate);
  const b = candidateWindows(config, fromDate);
  assert.deepEqual(
    a.map((w) => w.start.toISOString()),
    b.map((w) => w.start.toISOString())
  );
});

// ---- windowConfig.json schema sanity -------------------------------------------------------------

test("windowConfig.json has the fields the evaluator depends on", () => {
  const config = loadConfig();
  assert.equal(typeof config.sliceMinutes, "number");
  assert.equal(typeof config.workZoneCapacityVphpl, "number");
  assert.equal(typeof config.mergeFriction, "number");
  assert.equal(typeof config.tollRateUsd, "number");
  assert.equal(typeof config.revenueUncertaintyBand, "number");
  assert.equal(typeof config.weights.revenue, "number");
  assert.equal(typeof config.weights.delay, "number");
  assert.equal(typeof config.weights.safety, "number");
  assert.equal(typeof config.weights.crew, "number");
  assert.ok(config.candidateHeuristics.overnight && config.candidateHeuristics.weekendMorning && config.candidateHeuristics.weekdayPm);
});

// ---- lane availability + overall evaluateWindow shape ---------------------------------------------

test("evaluateWindow: lane availability % and result shape", () => {
  const config = loadConfig();
  const demandFn = () => Array(16).fill(1000);
  const evaluator = createWindowEvaluator({ config, segments: SEGMENTS, incidents: [], demandFn });
  const window = { start: new Date("2026-07-13T23:00:00"), durationHours: 4 };
  const result = evaluator.evaluateWindow("east", { lanesClosed: 1 }, window);

  assert.ok(Math.abs(result.laneAvailabilityPct - (2 / 3) * 100) < 1e-6);
  assert.equal(result.openLanes, 2);
  assert.equal(result.totalLanes, 3);
  assert.equal(typeof result.score, "number");
  assert.ok(Number.isFinite(result.score));
  assert.equal(typeof result.revenueAtRiskUsd.point, "number");
  assert.equal(typeof result.secondaryCrashExposure, "number");
});

// ---- buildWindowTimeseries: per-slice playback data (UC1 deck-parity item 1, Phase 2) -----------

function fixtureSlicesAndRevenue() {
  const config = { revenueUncertaintyBand: 0.15 };
  const capacityVph = 2000;
  const sliceH = 0.25;
  const demandsVph = [1000, 3000, 3500, 500];
  const rilca = rilcaSliceQueue(demandsVph, capacityVph, sliceH);
  const revenue = revenueAtRisk(config, rilca.slices, sliceH, capacityVph, 2.5);
  return { rilca, revenue };
}

test("buildWindowTimeseries: one row per slice, in order, sliceIndex 0..n-1", () => {
  const { rilca, revenue } = fixtureSlicesAndRevenue();
  const ts = buildWindowTimeseries(rilca.slices, revenue.perSlice);
  assert.equal(ts.length, rilca.slices.length);
  ts.forEach((row, i) => assert.equal(row.sliceIndex, i));
});

test("buildWindowTimeseries: cumulativeRevenueUsd is monotonically non-decreasing, ends === sum of revenueUsd", () => {
  const { rilca, revenue } = fixtureSlicesAndRevenue();
  const ts = buildWindowTimeseries(rilca.slices, revenue.perSlice);
  let prev = -Infinity;
  let sum = 0;
  for (const row of ts) {
    assert.ok(row.cumulativeRevenueUsd >= prev - 1e-9, "cumulativeRevenueUsd must be non-decreasing");
    prev = row.cumulativeRevenueUsd;
    sum += row.revenueUsd;
  }
  assert.ok(Math.abs(ts[ts.length - 1].cumulativeRevenueUsd - sum) < 1e-9);
});

test("buildWindowTimeseries: cumulativeDelayVehHours monotonically non-decreasing, ends === rilcaSliceQueue()'s totalDelayVehHours", () => {
  const { rilca, revenue } = fixtureSlicesAndRevenue();
  const ts = buildWindowTimeseries(rilca.slices, revenue.perSlice);
  let prev = -Infinity;
  for (const row of ts) {
    assert.ok(row.cumulativeDelayVehHours >= prev - 1e-9, "cumulativeDelayVehHours must be non-decreasing");
    prev = row.cumulativeDelayVehHours;
  }
  assert.ok(Math.abs(ts[ts.length - 1].cumulativeDelayVehHours - rilca.totalDelayVehHours) < 1e-9);
});

test("buildWindowTimeseries: throughputPct is 100 (not NaN) for a slice with zero arrivals", () => {
  const config = { revenueUncertaintyBand: 0.15 };
  const capacityVph = 2000;
  const sliceH = 0.25;
  const demandsVph = [0, 3000];
  const rilca = rilcaSliceQueue(demandsVph, capacityVph, sliceH);
  const revenue = revenueAtRisk(config, rilca.slices, sliceH, capacityVph, 2.5);
  const ts = buildWindowTimeseries(rilca.slices, revenue.perSlice);
  assert.equal(ts[0].throughputPct, 100);
  assert.ok(Number.isFinite(ts[0].throughputPct));
});

test("evaluateWindow: result.timeseries present, same length as result.queue.slices, last cumulativeRevenueUsd ≈ result.revenueAtRiskUsd.point", () => {
  const config = loadConfig();
  const demandFn = () => [500, 3000, 3500, 900, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500];
  const evaluator = createWindowEvaluator({ config, segments: SEGMENTS, incidents: [], demandFn });
  const window = { start: new Date("2026-07-13T23:00:00"), durationHours: 4 };
  const result = evaluator.evaluateWindow("east", { lanesClosed: 1 }, window);

  assert.ok(Array.isArray(result.timeseries));
  assert.equal(result.timeseries.length, result.queue.slices.length);
  const lastCum = result.timeseries[result.timeseries.length - 1].cumulativeRevenueUsd;
  assert.ok(
    Math.abs(lastCum - result.revenueAtRiskUsd.point) < 1e-6,
    `last cumulativeRevenueUsd ${lastCum} should equal revenueAtRiskUsd.point ${result.revenueAtRiskUsd.point}`
  );
});

// ---- seed_decisions.mjs: buildDecision() matches a direct evaluateWindow() call ---------------
// Deck-parity Phase 1 (item 5, "seed revenue $0" fix). Extra imports live down here (rather than
// the top import block) so this append-only addition can't collide with concurrent edits to this
// file's existing imports — ES module `import` declarations are hoisted regardless of position.

import { createDemandModel } from "../src/demand.js";
import { buildDecision } from "../../tools/seed_decisions.mjs";

test("seed_decisions.mjs: buildDecision() output matches evaluateWindow() for a known fixture row", () => {
  const config = loadConfig();
  const segments = SEGMENTS;
  const incidents = [closureIncident("East Segment", "Yes", 4), closureIncident("West Segment", "Yes", 2)];

  const demandModel = createDemandModel(undefined, segments);
  const demandFn = (segmentId, window) => demandModel.getWindowDemand(segmentId, window.start, window.durationHours);
  const evaluator = createWindowEvaluator({ config, segments, incidents, demandFn });

  // 08:00 UTC on a weekday lands inside demandProfile.json's AM peak (7-9) — chosen deliberately
  // so this fixture's revenue-at-risk isn't trivially zero (a regression here would previously
  // have been masked by the seed-script bug that made everything zero).
  const row = {
    incident_id: "INC-TEST-0001",
    incident_date: "2024-05-27T00:00:00",
    incident_time: "08:00",
    Segment: "East Segment",
    lane_closure_duration_hours: 4,
    damaged_asset_id: "999",
  };

  const decision = buildDecision(row, segments, config, evaluator);

  const segment = segments.find((s) => s.name === "East Segment");
  const window = { start: new Date(Date.UTC(2024, 4, 27, 8, 0, 0)), durationHours: 4 };
  const direct = evaluator.evaluateWindow(segment.id, { totalLanes: segment.laneCount, openLanes: segment.laneCount - 1 }, window);

  assert.equal(decision.segmentId, direct.segmentId);
  assert.equal(decision.openLanes, direct.openLanes);
  assert.equal(decision.totalLanes, direct.totalLanes);
  assert.equal(decision.closedCapacityVph, direct.closedCapacityVph);
  assert.ok(Math.abs(decision.revenueAtRiskUsd.point - direct.revenueAtRiskUsd.point) < 0.01);
  assert.ok(Math.abs(decision.queue.avgDelayMin - direct.queue.avgDelayMin) < 0.01);
  assert.ok(Math.abs(decision.secondaryCrashExposure - direct.secondaryCrashExposure) < 0.0001);
  assert.ok(Math.abs(decision.score - direct.score) < 0.0001);
  assert.ok(decision.revenueAtRiskUsd.point > 0, "fixture chosen to land in a peak window so revenue isn't trivially zero");
  assert.equal(decision.seeded, true);
  assert.equal(decision.source, "2024-26 closure history");
  assert.equal(decision.id, "SEED-DEC-INC-TEST-0001");
});

// ---- ingredients bundle: glass-box provenance (UC1 deck-parity item 6, Phase 12) ----------------
// Extra imports live down here (same append-only rationale as the seed_decisions block above).

test("evaluateWindow: ingredients.tollRateUsd matches the toll rate actually used (closureSpec override, not just config default)", () => {
  const config = loadConfig();
  assert.notEqual(config.tollRateUsd, 4.75, "fixture override must differ from the config default to be a real test");
  const demandFn = () => Array(16).fill(1000);
  const evaluator = createWindowEvaluator({ config, segments: SEGMENTS, incidents: [], demandFn });
  const window = { start: new Date("2026-07-13T23:00:00"), durationHours: 4 };

  const overridden = evaluator.evaluateWindow("east", { lanesClosed: 1, tollRateUsd: 4.75 }, window);
  assert.equal(overridden.ingredients.tollRateUsd, 4.75);

  const defaulted = evaluator.evaluateWindow("east", { lanesClosed: 1 }, window);
  assert.equal(defaulted.ingredients.tollRateUsd, config.tollRateUsd);
});

test("evaluateWindow: ingredients.weights matches config.weights exactly", () => {
  const config = loadConfig();
  const demandFn = () => Array(16).fill(1000);
  const evaluator = createWindowEvaluator({ config, segments: SEGMENTS, incidents: [], demandFn });
  const window = { start: new Date("2026-07-13T23:00:00"), durationHours: 4 };
  const result = evaluator.evaluateWindow("east", { lanesClosed: 1 }, window);

  assert.deepEqual(result.ingredients.weights, config.weights);
});

test("evaluateWindow: two evaluator instances from DIFFERENT configs (simulating pre/post assumption-slider edit) produce DIFFERENT ingredients.weights/tollRateUsd", () => {
  const baseConfig = loadConfig();
  const demandFn = () => Array(16).fill(1000);
  const window = { start: new Date("2026-07-13T23:00:00"), durationHours: 4 };

  const evaluatorA = createWindowEvaluator({ config: baseConfig, segments: SEGMENTS, incidents: [], demandFn });
  const resultA = evaluatorA.evaluateWindow("east", { lanesClosed: 1 }, window);

  const editedConfig = {
    ...baseConfig,
    tollRateUsd: baseConfig.tollRateUsd + 3,
    weights: { revenue: 0.1, delay: 0.6, safety: 0.2, crew: 0.1 },
  };
  const evaluatorB = createWindowEvaluator({ config: editedConfig, segments: SEGMENTS, incidents: [], demandFn });
  const resultB = evaluatorB.evaluateWindow("east", { lanesClosed: 1 }, window);

  assert.notEqual(resultA.ingredients.tollRateUsd, resultB.ingredients.tollRateUsd);
  assert.notDeepEqual(resultA.ingredients.weights, resultB.ingredients.weights);
});
