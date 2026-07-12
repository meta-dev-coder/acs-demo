/*---------------------------------------------------------------------------------------------
 * demand.test.mjs — UC1 P2-a: synthetic 15-minute demand curve (createDemandModel). Pure module,
 * no DataConnect/DOM — segments passed in as a fixture so this stays isolated from the real
 * config/segments.json (see src/demand.js header for the fs-agnostic rationale).
 *--------------------------------------------------------------------------------------------*/
import { test } from "node:test";
import assert from "node:assert/strict";

import { createDemandModel } from "../src/demand.js";
import demandProfile from "../config/demandProfile.json" with { type: "json" };

// Small fixture segments, independent of the real config/segments.json (keeps this unit
// deterministic even if the real segment registry changes).
const SEGMENTS = [
  { id: "west", name: "West Segment", lonBand: [-80.4, -80.3], laneCount: 3, demandScale: 1.0 },
  { id: "east", name: "East Segment", lonBand: [-80.3, -80.2], laneCount: 3, demandScale: 2.0 },
];

// 2024-01-01 is a known Monday (weekday); 2024-01-06 is a Saturday (weekend). Using Date.UTC
// keeps the test host-timezone-independent.
const MONDAY = new Date(Date.UTC(2024, 0, 1));
const SATURDAY = new Date(Date.UTC(2024, 0, 6));

// Quarter-hour indices (0..95) — 32 = 08:00 (AM peak plateau), 12 = 03:00 (night trough).
const Q_8AM = 8 * 4;
const Q_3AM = 3 * 4;
const Q_1PM = 13 * 4; // inside the weekend midday peak window

function model(segments = SEGMENTS) {
  return createDemandModel(demandProfile, segments);
}

test("getDemand is deterministic: same inputs -> same output", () => {
  const m = model();
  const a = m.getDemand("west", MONDAY, Q_8AM);
  const b = m.getDemand("west", MONDAY, Q_8AM);
  assert.equal(a, b);
});

test("getDemand: weekday AM peak vph is greater than night trough vph", () => {
  const m = model();
  const peak = m.getDemand("west", MONDAY, Q_8AM);
  const trough = m.getDemand("west", MONDAY, Q_3AM);
  assert.ok(peak > trough, `expected peak (${peak}) > trough (${trough})`);
});

test("getDemand: weekend peak vph is lower than weekday peak vph for the same segment", () => {
  const m = model();
  const weekdayPeak = m.getDemand("west", MONDAY, Q_8AM);
  const weekendPeak = m.getDemand("west", SATURDAY, Q_1PM);
  assert.ok(
    weekendPeak < weekdayPeak,
    `expected weekend peak (${weekendPeak}) < weekday peak (${weekdayPeak})`
  );
});

test("getDemand: per-segment demandScale multiplier is applied proportionally", () => {
  const m = model();
  const west = m.getDemand("west", MONDAY, Q_8AM); // demandScale 1.0
  const east = m.getDemand("east", MONDAY, Q_8AM); // demandScale 2.0
  assert.ok(west > 0, "sanity: west vph must be positive");
  assert.ok(
    Math.abs(east - west * 2) < 1e-9,
    `expected east (${east}) to equal west * 2 (${west * 2})`
  );
});

test("getDemand: unknown segmentId falls back to a neutral (1x) scale instead of throwing", () => {
  const m = model();
  assert.doesNotThrow(() => m.getDemand("does-not-exist", MONDAY, Q_8AM));
});

test("getWindowDemand: slice array length equals durationHours * 4", () => {
  const m = model();
  assert.equal(m.getWindowDemand("west", MONDAY, 2).length, 8);
  assert.equal(m.getWindowDemand("west", MONDAY, 1.5).length, 6);
  assert.equal(m.getWindowDemand("west", MONDAY, 0.25).length, 1);
});

test("getWindowDemand: every slice value matches an equivalent getDemand call", () => {
  const m = model();
  const start = new Date(Date.UTC(2024, 0, 1, 7, 0)); // Monday 07:00
  const slices = m.getWindowDemand("west", start, 1); // 07:00, 07:15, 07:30, 07:45
  const expected = [28, 29, 30, 31].map((q) => m.getDemand("west", start, q));
  assert.deepEqual(slices, expected);
});

test("getWindowDemand: window crossing midnight rolls the day (and weekday/weekend) forward", () => {
  const m = model();
  const start = new Date(Date.UTC(2024, 0, 5, 23, 30)); // Friday 23:30 -> rolls into Saturday
  const slices = m.getWindowDemand("west", start, 1); // Fri 23:30, 23:45, Sat 00:00, 00:15
  assert.equal(slices.length, 4);
  slices.forEach((v) => assert.equal(typeof v, "number"));
});

test("demandProfile.json defines a weekday peak strictly greater than the weekend peak", () => {
  const weekdayMax = Math.max(...demandProfile.weekdayPeaks.map((p) => p.peakMultiplier));
  const weekendMax = Math.max(...demandProfile.weekendPeaks.map((p) => p.peakMultiplier));
  assert.ok(weekendMax < weekdayMax, "weekend curve must be flatter than weekday peaks");
});

// ---- getWindowDemandSeries: UC1 deck-parity item 2 (planner picker week demand series) ---------

test("getWindowDemandSeries: one {timestamp, vph} entry per slice, timestamps strictly increasing by 15 min", () => {
  const m = model();
  const start = new Date(Date.UTC(2024, 0, 1, 7, 0)); // Monday 07:00
  const series = m.getWindowDemandSeries("west", start, 2);

  assert.equal(series.length, 8);
  for (const entry of series) {
    assert.ok(entry.timestamp instanceof Date);
    assert.equal(typeof entry.vph, "number");
  }
  for (let i = 1; i < series.length; i++) {
    const deltaMs = series[i].timestamp.getTime() - series[i - 1].timestamp.getTime();
    assert.equal(deltaMs, 15 * 60 * 1000);
  }
});

test("getWindowDemandSeries: vph values match getDemand() called with the same segment/date/quarterHour", () => {
  const m = model();
  const start = new Date(Date.UTC(2024, 0, 1, 7, 0)); // Monday 07:00
  const series = m.getWindowDemandSeries("west", start, 1); // 07:00, 07:15, 07:30, 07:45
  const expected = [28, 29, 30, 31].map((q) => m.getDemand("west", start, q));
  assert.deepEqual(series.map((s) => s.vph), expected);
});

test("getWindowDemand: byte-identical output to getWindowDemandSeries(...).map(s => s.vph)", () => {
  const m = model();
  const cases = [
    { start: new Date(Date.UTC(2024, 0, 1, 7, 0)), hours: 2 },
    { start: new Date(Date.UTC(2024, 0, 5, 23, 30)), hours: 1 }, // crosses midnight, Fri->Sat
    { start: new Date(Date.UTC(2024, 0, 1, 7, 0)), hours: 1.5 },
  ];
  for (const { start, hours } of cases) {
    const direct = m.getWindowDemand("west", start, hours);
    const viaSeries = m.getWindowDemandSeries("west", start, hours).map((s) => s.vph);
    assert.deepEqual(direct, viaSeries, `mismatch for start=${start.toISOString()} hours=${hours}`);
  }
});

test("getWindowDemandSeries: durationHours=168 returns 672 slices spanning weekday and weekend peaks, and they differ", () => {
  const m = model();
  const series = m.getWindowDemandSeries("west", MONDAY, 168);
  assert.equal(series.length, 672);

  const weekdayPeakEntry = series[Q_8AM]; // Monday 08:00
  const weekendPeakEntry = series[5 * 96 + Q_1PM]; // 5 days later (Saturday) 13:00
  assert.notEqual(weekdayPeakEntry.vph, weekendPeakEntry.vph);
});
