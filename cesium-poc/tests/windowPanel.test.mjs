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

import {
  windowDemandAdapter,
  evaluateCandidates,
  throughputVsDemandPct,
  buildSumoPlaybackPlan,
  validateWindowPick,
  weekDemandSeries,
  localWallClockAsUtc,
  resolveSegmentByName,
} from "../src/windowAssembly.js";
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

// ---- 2b. resolveSegmentByName (exported, item 3) + evaluateCandidates's segmentIdOverride --------

test("resolveSegmentByName: known name resolves to its segment object; unknown/null -> null", () => {
  const east = resolveSegmentByName(segments, "East Segment");
  assert.equal(east?.id, "east");
  assert.equal(resolveSegmentByName(segments, "Nonexistent Segment"), null);
  assert.equal(resolveSegmentByName(segments, null), null);
  assert.equal(resolveSegmentByName(segments, undefined), null);
});

test("evaluateCandidates: segmentIdOverride (different segment than wo.segment) wins — results reflect the override's laneCount/demandScale", () => {
  const demandModel = createDemandModel(demandProfile, segments);
  const wo = { id: "WO-OVR", segment: "East Segment" }; // demandScale 1.2

  const west = resolveSegmentByName(segments, "West Segment"); // demandScale 0.62
  assert.ok(west, "fixture must resolve West Segment");

  const withOverride = evaluateCandidates(wo, {
    segments,
    incidents: [],
    windowConfig,
    demandModel,
    fromDate: new Date("2026-07-13T10:00:00Z"),
    segmentIdOverride: west.id,
  });
  const withoutOverride = evaluateCandidates(wo, {
    segments,
    incidents: [],
    windowConfig,
    demandModel,
    fromDate: new Date("2026-07-13T10:00:00Z"),
  });

  assert.equal(withOverride.results[0].segmentName, "West Segment");
  assert.equal(withoutOverride.results[0].segmentName, "East Segment");

  // weekdayPm is where the two segments' demandScale (0.62 vs. 1.2) diverges most — the overnight
  // trough can legitimately score identically (near-zero congestion either way).
  const pmIdx = withOverride.windows.findIndex((w) => w.id === "weekdayPm");
  assert.notEqual(withOverride.results[pmIdx].score, withoutOverride.results[pmIdx].score);
});

test("evaluateCandidates: segmentIdOverride pointing at an absent id falls back to segmentId=null, no throw", () => {
  const demandModel = createDemandModel(demandProfile, segments);
  const wo = { id: "WO-OVR2", segment: "East Segment" };

  const { results } = evaluateCandidates(wo, {
    segments,
    incidents: [],
    windowConfig,
    demandModel,
    fromDate: new Date("2026-07-13T10:00:00Z"),
    segmentIdOverride: "no-such-segment-id",
  });

  assert.equal(results.length, 3);
  for (const r of results) assert.equal(r.segmentName, null);
});

test("evaluateCandidates: no segmentIdOverride (omitted) — output unchanged vs. today (regression lock)", () => {
  const demandModel = createDemandModel(demandProfile, segments);
  const wo = { id: "WO-OVR3", segment: "East Segment" };
  const opts = {
    segments,
    incidents: [],
    windowConfig,
    demandModel,
    fromDate: new Date("2026-07-13T10:00:00Z"),
  };

  const a = evaluateCandidates(wo, opts);
  const b = evaluateCandidates(wo, { ...opts, segmentIdOverride: null });

  assert.deepEqual(a.results.map((r) => r.score), b.results.map((r) => r.score));
  assert.equal(a.winnerIdx, b.winnerIdx);
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

// ---- 4. buildSumoPlaybackPlan: sequences the 3 windows one-at-a-time (UC1 deck-parity item 1) ---

test("buildSumoPlaybackPlan: returns 3×[closeLane, watch, openLane] in window order, using the supplied lane", () => {
  const windows = [{ id: "overnight" }, { id: "weekendMorning" }, { id: "weekdayPm" }];
  const plan = buildSumoPlaybackPlan(windows, { lane: "uc1-ap-1" });

  assert.equal(plan.length, 9);
  for (let i = 0; i < 3; i++) {
    const group = plan.slice(i * 3, i * 3 + 3);
    assert.equal(group[0].kind, "closeLane");
    assert.equal(group[1].kind, "watch");
    assert.equal(group[2].kind, "openLane");
    for (const step of group) {
      assert.equal(step.window, windows[i]);
      assert.equal(step.lane, "uc1-ap-1");
    }
  }
});

test("buildSumoPlaybackPlan: watchMsPerWindow defaults to 8000 when not supplied; honored when supplied", () => {
  const windows = [{ id: "overnight" }];

  const defaulted = buildSumoPlaybackPlan(windows, { lane: "uc1-ap-1" });
  const watchStepDefault = defaulted.find((s) => s.kind === "watch");
  assert.equal(watchStepDefault.durationMs, 8000);

  const custom = buildSumoPlaybackPlan(windows, { lane: "uc1-ap-1", watchMsPerWindow: 3000 });
  const watchStepCustom = custom.find((s) => s.kind === "watch");
  assert.equal(watchStepCustom.durationMs, 3000);
});

// ---- 5. evaluateCandidates: `windows` override (UC1 deck-parity item 2, planner picker) ---------

test("evaluateCandidates: windows override with exactly 3 entries uses them, not candidateWindows()'s trio", () => {
  const demandModel = createDemandModel(demandProfile, segments);
  const wo = { id: "WO-5", segment: "East Segment" };
  const customWindows = [
    { id: "custom-a", label: "Custom A", start: new Date("2026-07-13T05:00:00Z"), durationHours: 2 },
    { id: "custom-b", label: "Custom B", start: new Date("2026-07-14T05:00:00Z"), durationHours: 2 },
    { id: "custom-c", label: "Custom C", start: new Date("2026-07-15T05:00:00Z"), durationHours: 2 },
  ];

  const { windows, results } = evaluateCandidates(wo, {
    segments,
    incidents: [],
    windowConfig,
    demandModel,
    fromDate: new Date("2026-07-13T00:00:00Z"),
    windows: customWindows,
  });

  assert.equal(windows, customWindows);
  assert.equal(results.length, 3);
  assert.deepEqual(
    windows.map((w) => w.id),
    ["custom-a", "custom-b", "custom-c"]
  );
});

test("evaluateCandidates: windows override with fewer/more than 3 falls back to candidateWindows()", () => {
  const demandModel = createDemandModel(demandProfile, segments);
  const wo = { id: "WO-6", segment: "East Segment" };
  const fromDate = new Date("2026-07-13T10:00:00Z");

  const tooFew = evaluateCandidates(wo, {
    segments,
    incidents: [],
    windowConfig,
    demandModel,
    fromDate,
    windows: [{ id: "only-one", start: fromDate, durationHours: 1 }],
  });
  assert.deepEqual(
    tooFew.windows.map((w) => w.id),
    ["overnight", "weekendMorning", "weekdayPm"]
  );

  const tooMany = evaluateCandidates(wo, {
    segments,
    incidents: [],
    windowConfig,
    demandModel,
    fromDate,
    windows: [1, 2, 3, 4].map((n) => ({ id: `extra-${n}`, start: fromDate, durationHours: 1 })),
  });
  assert.deepEqual(
    tooMany.windows.map((w) => w.id),
    ["overnight", "weekendMorning", "weekdayPm"]
  );
});

// ---- 6. validateWindowPick: planner-typed window bounds checking (UC1 deck-parity item 2) -------

test("validateWindowPick: valid pick returns {valid:true, errors:[]}", () => {
  const fromDate = new Date("2026-07-13T00:00:00Z");
  const pick = { start: new Date("2026-07-14T02:00:00Z"), durationHours: 4 };
  const result = validateWindowPick(pick, windowConfig, fromDate);
  assert.deepEqual(result, { valid: true, errors: [] });
});

test("validateWindowPick: durationHours below/above config bounds is invalid with a descriptive error", () => {
  const fromDate = new Date("2026-07-13T00:00:00Z");
  const start = new Date("2026-07-14T02:00:00Z");

  const tooShort = validateWindowPick({ start, durationHours: 0.1 }, windowConfig, fromDate);
  assert.equal(tooShort.valid, false);
  assert.ok(tooShort.errors.some((e) => /duration/i.test(e)), `expected a duration error, got ${JSON.stringify(tooShort.errors)}`);

  const tooLong = validateWindowPick({ start, durationHours: 20 }, windowConfig, fromDate);
  assert.equal(tooLong.valid, false);
  assert.ok(tooLong.errors.some((e) => /duration/i.test(e)), `expected a duration error, got ${JSON.stringify(tooLong.errors)}`);
});

test("validateWindowPick: start in the past / within minLeadHours is invalid", () => {
  const fromDate = new Date("2026-07-13T10:00:00Z");

  const past = validateWindowPick({ start: new Date("2026-07-12T10:00:00Z"), durationHours: 4 }, windowConfig, fromDate);
  assert.equal(past.valid, false);
  assert.ok(past.errors.length > 0);

  // 15 min lead vs. windowConfig.plannerPick.minLeadHours = 1
  const tooSoon = validateWindowPick({ start: new Date("2026-07-13T10:15:00Z"), durationHours: 4 }, windowConfig, fromDate);
  assert.equal(tooSoon.valid, false);
  assert.ok(tooSoon.errors.length > 0);
});

test("validateWindowPick: malformed start never throws, returns invalid", () => {
  const fromDate = new Date("2026-07-13T00:00:00Z");
  assert.doesNotThrow(() => validateWindowPick({ start: "not-a-date", durationHours: 4 }, windowConfig, fromDate));
  assert.doesNotThrow(() => validateWindowPick({ start: undefined, durationHours: 4 }, windowConfig, fromDate));
  assert.doesNotThrow(() => validateWindowPick(null, windowConfig, fromDate));
  assert.doesNotThrow(() => validateWindowPick(undefined, windowConfig, fromDate));

  assert.equal(validateWindowPick({ start: "not-a-date", durationHours: 4 }, windowConfig, fromDate).valid, false);
  assert.equal(validateWindowPick(null, windowConfig, fromDate).valid, false);
});

test("validateWindowPick: missing config falls back to 0.5/12/1 defaults", () => {
  const fromDate = new Date("2026-07-13T00:00:00Z");
  const okPick = { start: new Date("2026-07-14T02:00:00Z"), durationHours: 4 }; // 26h lead, 4h duration

  assert.equal(validateWindowPick(okPick, undefined, fromDate).valid, true);
  assert.equal(validateWindowPick(okPick, null, fromDate).valid, true);
  assert.equal(validateWindowPick(okPick, {}, fromDate).valid, true);

  const belowDefaultMin = validateWindowPick({ start: new Date("2026-07-14T02:00:00Z"), durationHours: 0.25 }, undefined, fromDate);
  assert.equal(belowDefaultMin.valid, false); // default minDurationHours = 0.5

  const aboveDefaultMax = validateWindowPick({ start: new Date("2026-07-14T02:00:00Z"), durationHours: 13 }, undefined, fromDate);
  assert.equal(aboveDefaultMax.valid, false); // default maxDurationHours = 12

  const belowDefaultLead = validateWindowPick({ start: new Date("2026-07-13T00:30:00Z"), durationHours: 4 }, undefined, fromDate);
  assert.equal(belowDefaultLead.valid, false); // default minLeadHours = 1
});

// ---- 7. weekDemandSeries: the picker's SVG week strip (UC1 deck-parity item 2) ------------------

test("weekDemandSeries: returns 672 points, monotonic hourOfWeek 0..167.75", () => {
  const demandModel = createDemandModel(demandProfile, segments);
  const weekStart = localDate(2026, 7, 13, 0); // Monday 00:00 local

  const series = weekDemandSeries(demandModel, "east", weekStart);

  assert.equal(series.length, 672);
  assert.equal(series[0].hourOfWeek, 0);
  assert.equal(series[series.length - 1].hourOfWeek, 167.75);
  for (let i = 1; i < series.length; i++) {
    assert.ok(
      series[i].hourOfWeek > series[i - 1].hourOfWeek,
      `hourOfWeek must be strictly increasing at index ${i}`
    );
    for (const entry of series) assert.equal(typeof entry.vph, "number");
  }
});

test("weekDemandSeries: a known local Tuesday-23:00 hour reads the same vph via weekDemandSeries and windowDemandAdapter()'s own reconciliation", () => {
  const demandModel = createDemandModel(demandProfile, segments);
  const weekStart = localDate(2026, 7, 13, 0); // Monday 00:00 local (2026-07-13 is a Monday)
  const series = weekDemandSeries(demandModel, "east", weekStart);

  const hourOfWeek = 47; // Tuesday 23:00 = 1 * 24 + 23
  const viaWeekSeries = series[hourOfWeek * 4].vph;

  const demandFn = windowDemandAdapter(demandModel);
  const tuesday2300 = localDate(2026, 7, 14, 23);
  const viaAdapter = demandFn("east", { start: tuesday2300, durationHours: 0.25 })[0];

  assert.ok(
    Math.abs(viaWeekSeries - viaAdapter) < 1e-9,
    `expected weekDemandSeries and windowDemandAdapter to agree: ${viaWeekSeries} vs ${viaAdapter}`
  );
});

test("localWallClockAsUtc: is exported and reinterprets local calendar fields as a UTC instant", () => {
  const local = localDate(2026, 7, 13, 23, 30);
  const utc = localWallClockAsUtc(local);
  assert.equal(utc.getUTCFullYear(), local.getFullYear());
  assert.equal(utc.getUTCMonth(), local.getMonth());
  assert.equal(utc.getUTCDate(), local.getDate());
  assert.equal(utc.getUTCHours(), local.getHours());
  assert.equal(utc.getUTCMinutes(), local.getMinutes());
});
