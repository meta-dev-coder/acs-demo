/*---------------------------------------------------------------------------------------------
 * windowPanel.test.mjs — UC1 P4-b: the P2-a/P2-b integration adapter (design spec §4 bullet 3 +
 * §3 integration). Covers windowDemandAdapter() (the demandFn contract adapter) and
 * evaluateCandidates() (the pure glue windowPanel.js's caller uses to assemble the 3-window
 * table). No DOM here — that's windowPanel.test-covered-by-inspection only per task scope
 * (DOM rendering isn't unit-testable under node --test without a DOM shim, matching
 * contextPanel.js's own lack of a dedicated render test).
 *--------------------------------------------------------------------------------------------*/
import { test } from "node:test";
import assert from "node:assert/strict";

import { windowDemandAdapter, evaluateCandidates, throughputVsDemandPct } from "../src/windowAssembly.js";
import { createDemandModel } from "../src/demand.js";
import segments from "../config/segments.json" with { type: "json" };
import windowConfig from "../config/windowConfig.json" with { type: "json" };
import demandProfile from "../config/demandProfile.json" with { type: "json" };

// ---- 1. windowDemandAdapter: demandFn(segmentId, window) -> vph[] contract --------------------

// Builds a Date from LOCAL calendar fields (mirrors how windowEval.js's candidateWindows()
// anchors its heuristics via Date#setHours/getDay — a host-local wall clock, NOT a UTC instant).
function localDate(y, m, d, h, min = 0) {
  const dt = new Date();
  dt.setFullYear(y, m - 1, d);
  dt.setHours(h, min, 0, 0);
  return dt;
}

test("windowDemandAdapter: reads window.start's LOCAL wall-clock hour, not the instant's raw UTC hour", () => {
  const demandModel = createDemandModel(demandProfile, segments);
  const demandFn = windowDemandAdapter(demandModel);

  // 23:00 LOCAL, Monday 2026-07-13 — candidateWindows()'s "overnight" anchor. Regardless of the
  // host's UTC offset, this must read as the demand curve's night trough (see windowAssembly.js's
  // header for why: candidateWindows() and demand.js must agree on one wall clock).
  const window = { start: localDate(2026, 7, 13, 23), durationHours: 4 };
  const demands = demandFn("east", window);

  assert.equal(demands.length, 16); // 4h / 15min
  const troughVph = demandProfile.baseVph * demandProfile.troughMultiplier * 1.2; // East demandScale 1.2
  for (const vph of demands) {
    assert.ok(Math.abs(vph - troughVph) < 1e-6, `expected flat night-trough ${troughVph} vph, got ${vph}`);
  }
});

test("windowDemandAdapter: matches getWindowDemand() called with the same LOCAL fields reinterpreted as UTC", () => {
  const demandModel = createDemandModel(demandProfile, segments);
  const demandFn = windowDemandAdapter(demandModel);

  const start = localDate(2026, 7, 13, 23);
  const viaAdapter = demandFn("east", { start, durationHours: 4 });
  const utcEquivalent = new Date(
    Date.UTC(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours(), start.getMinutes())
  );
  const viaModel = demandModel.getWindowDemand("east", utcEquivalent, 4);

  assert.deepEqual(viaAdapter, viaModel);
});

test("windowDemandAdapter: overnight (23:00 local) and weekday-PM (14:00 local) windows produce different demand", () => {
  const demandModel = createDemandModel(demandProfile, segments);
  const demandFn = windowDemandAdapter(demandModel);

  const overnight = demandFn("east", { start: localDate(2026, 7, 13, 23), durationHours: 4 });
  const pm = demandFn("east", { start: localDate(2026, 7, 13, 14), durationHours: 4 });

  assert.notDeepEqual(overnight, pm);
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  assert.ok(avg(pm) > avg(overnight), "weekday 14:00-18:00 window (spans PM peak) should average higher than overnight trough");
});

// ---- 2. evaluateCandidates: glues candidateWindows + createWindowEvaluator + createDemandModel ---

test("evaluateCandidates: returns exactly 3 windows/results and a valid winnerIdx", () => {
  const demandModel = createDemandModel(demandProfile, segments);
  const wo = { id: "WO-1", segment: "East Segment" };

  const { windows, results, winnerIdx } = evaluateCandidates(wo, {
    segments,
    incidents: [],
    windowConfig,
    demandModel,
    fromDate: new Date("2026-07-13T10:00:00Z"), // a Monday
  });

  assert.equal(windows.length, 3);
  assert.equal(results.length, 3);
  assert.ok(winnerIdx >= 0 && winnerIdx < 3);
  assert.equal(results[winnerIdx].segmentName, "East Segment");
});

test("evaluateCandidates: on real configs, the overnight window wins (lowest score) over weekday 14:00", () => {
  const demandModel = createDemandModel(demandProfile, segments);
  const wo = { id: "WO-900543", segment: "East Segment" };

  const { windows, results, winnerIdx } = evaluateCandidates(wo, {
    segments,
    incidents: [],
    windowConfig,
    demandModel,
    fromDate: new Date("2026-07-13T10:00:00Z"),
  });

  const winnerId = windows[winnerIdx].id;
  assert.equal(winnerId, "overnight", `expected overnight to win, got ${winnerId} (scores: ${results.map((r) => r.score.toFixed(4))})`);

  const weekdayPmIdx = windows.findIndex((w) => w.id === "weekdayPm");
  assert.ok(results[winnerIdx].score < results[weekdayPmIdx].score);
});

test("evaluateCandidates: unresolvable segment name still returns 3 windows (segmentId null, no throw)", () => {
  const demandModel = createDemandModel(demandProfile, segments);
  const wo = { id: "WO-2", segment: "Nonexistent Segment" };

  const { windows, results, winnerIdx } = evaluateCandidates(wo, {
    segments,
    incidents: [],
    windowConfig,
    demandModel,
    fromDate: new Date("2026-07-13T10:00:00Z"),
  });

  assert.equal(windows.length, 3);
  assert.equal(results.length, 3);
  assert.equal(results[winnerIdx].segmentName, null);
});

// ---- 3. throughputVsDemandPct: windowPanel.js's "throughput vs demand" column -------------------

test("throughputVsDemandPct: 100% when demand never exceeds capacity", () => {
  const demandModel = createDemandModel(demandProfile, segments);
  const wo = { id: "WO-3", segment: "West Segment" }; // lowest demandScale -> unsaturated even overnight/day
  const { results } = evaluateCandidates(wo, {
    segments,
    incidents: [],
    windowConfig,
    demandModel,
    fromDate: new Date("2026-07-13T10:00:00Z"),
    closureSpec: { lanesClosed: 0 }, // all lanes open -> capacity way above any demand
  });
  for (const r of results) {
    assert.equal(throughputVsDemandPct(r), 100);
  }
});

test("throughputVsDemandPct: below 100% when a window oversaturates capacity", () => {
  const demandModel = createDemandModel(demandProfile, segments);
  const wo = { id: "WO-4", segment: "East Segment" };
  const { windows, results } = evaluateCandidates(wo, {
    segments,
    incidents: [],
    windowConfig,
    demandModel,
    fromDate: new Date("2026-07-13T10:00:00Z"),
    closureSpec: { lanesClosed: 2 }, // only 1 lane open -> low capacity, PM window oversaturates
  });
  const pmIdx = windows.findIndex((w) => w.id === "weekdayPm");
  const pct = throughputVsDemandPct(results[pmIdx]);
  assert.ok(pct > 0 && pct < 100, `expected partial throughput, got ${pct}`);
});

test("throughputVsDemandPct: 100% (not NaN) when a result has zero arrivals", () => {
  assert.equal(throughputVsDemandPct({ queue: { slices: [] } }), 100);
  assert.equal(throughputVsDemandPct({}), 100);
});
