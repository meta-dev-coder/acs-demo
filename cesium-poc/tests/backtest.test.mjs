/*---------------------------------------------------------------------------------------------
 * backtest.test.mjs — UC1 P5-a: trust-panel BACKTEST tab math (design spec §4). Temporal holdout
 * (fit year 1 Apr2024-Mar2025, predict/compare year 2 Apr2025-Mar2026). Small inline fixtures
 * (mirrors windowEval.test.mjs style) plus one real incidents_v3.json row for date-format proof.
 *--------------------------------------------------------------------------------------------*/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  runBacktest,
  parseIncidentDate,
  durationClassOf,
  HONESTY_LINE,
} from "../src/backtest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "..", "config", "backtestConfig.json");
const incidentsPath = path.join(__dirname, "..", "public", "dataconnect-data", "incidents_v3.json");

function loadConfig() {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

const SEGMENTS = [
  { id: "east", name: "East Segment", lonBand: [-80.23, -80.18], laneCount: 3, demandScale: 1.2 },
  { id: "west", name: "West Segment", lonBand: [-80.36, -80.31], laneCount: 3, demandScale: 0.62 },
];

function closure({ segment, date, type = "Vehicle fire", hours = 3.5 }) {
  return {
    incident_id: `INC-${Math.random().toString(36).slice(2)}`,
    incident_date: date,
    incident_type: type,
    lane_closure_y_n: "Yes",
    lane_closure_duration_hours: hours,
    Segment: segment,
  };
}

// ---- 0. date parsing off the real incidents_v3 field format -----------------------------------

test("parseIncidentDate: parses the real incidents_v3.json ISO-local field format", () => {
  const raw = JSON.parse(readFileSync(incidentsPath, "utf-8"));
  const row = raw[0];
  assert.equal(row.incident_date, "2024-05-27T00:00:00");
  const d = parseIncidentDate(row.incident_date);
  assert.ok(d instanceof Date);
  assert.equal(d.getFullYear(), 2024);
  assert.equal(d.getMonth(), 4); // May = index 4
  assert.equal(d.getDate(), 27);
});

test("parseIncidentDate: returns null for missing/malformed dates", () => {
  assert.equal(parseIncidentDate(null), null);
  assert.equal(parseIncidentDate(undefined), null);
  assert.equal(parseIncidentDate("not-a-date"), null);
});

// ---- 1. duration-class thresholds --------------------------------------------------------------

test("durationClassOf: buckets short/medium/long off config thresholds", () => {
  const config = loadConfig();
  assert.equal(durationClassOf(1.5, config), "short");
  assert.equal(durationClassOf(2, config), "short"); // <= shortMaxHours
  assert.equal(durationClassOf(3.5, config), "medium");
  assert.equal(durationClassOf(5, config), "medium"); // <= mediumMaxHours
  assert.equal(durationClassOf(7, config), "long");
  assert.equal(durationClassOf(null, config), null);
  assert.equal(durationClassOf(NaN, config), null);
});

// ---- 2. known split -> known per-segment closure recurrence rates -----------------------------

test("runBacktest: known train/test split produces known per-segment predicted/actual rates", () => {
  const config = loadConfig();
  const incidents = [
    // East: 2 closures in year1 totaling 10h -> predicted rate 0.2; 1 closure in year2 of 5h -> actual rate 0.2
    closure({ segment: "East Segment", date: "2024-06-01T00:00:00", hours: 5 }),
    closure({ segment: "East Segment", date: "2024-09-01T00:00:00", hours: 5 }),
    closure({ segment: "East Segment", date: "2025-06-01T00:00:00", hours: 5 }),
    // West: 1 closure in year1 of 4h -> predicted rate 0.25; 0 closures in year2 -> actual rate 0 (empty year-2 segment)
    closure({ segment: "West Segment", date: "2024-07-01T00:00:00", hours: 4 }),
    // Out-of-window noise: must not leak into either bucket
    closure({ segment: "East Segment", date: "2023-01-01T00:00:00", hours: 100 }),
    closure({ segment: "East Segment", date: "2026-06-01T00:00:00", hours: 100 }),
  ];

  const result = runBacktest({ incidents, segments: SEGMENTS, config });

  const east = result.segments.find((s) => s.segmentId === "east");
  const west = result.segments.find((s) => s.segmentId === "west");

  assert.equal(east.predictedClosures, 2);
  assert.ok(Math.abs(east.predictedRate - 2 / 10) < 1e-9);
  assert.equal(east.actualClosures, 1);
  assert.ok(Math.abs(east.actualRate - 1 / 5) < 1e-9);

  assert.equal(west.predictedClosures, 1);
  assert.ok(Math.abs(west.predictedRate - 1 / 4) < 1e-9);
  assert.equal(west.actualClosures, 0, "empty year-2 segment must report zero, not crash");
  assert.equal(west.actualRate, 0);
});

// ---- 3. risk ranking comparison (predicted order vs actual order) -----------------------------

test("runBacktest: ranking agrees perfectly when predicted and actual order match", () => {
  const config = loadConfig();
  const incidents = [
    // East predicted-highest and actual-highest -> perfect rank agreement over 2 segments
    closure({ segment: "East Segment", date: "2024-06-01T00:00:00", hours: 1 }),
    closure({ segment: "East Segment", date: "2024-07-01T00:00:00", hours: 1 }),
    closure({ segment: "East Segment", date: "2025-06-01T00:00:00", hours: 1 }),
    closure({ segment: "East Segment", date: "2025-07-01T00:00:00", hours: 1 }),
    closure({ segment: "West Segment", date: "2024-06-01T00:00:00", hours: 10 }),
    closure({ segment: "West Segment", date: "2025-06-01T00:00:00", hours: 10 }),
  ];

  const result = runBacktest({ incidents, segments: SEGMENTS, config });

  assert.equal(result.ranking.n, 2);
  assert.equal(result.ranking.predictedOrder[0], "east");
  assert.equal(result.ranking.actualOrder[0], "east");
  assert.ok(Math.abs(result.ranking.spearmanRho - 1) < 1e-9);
});

test("runBacktest: ranking reports null spearmanRho when fewer than 2 segments are comparable", () => {
  const config = loadConfig();
  const incidents = [closure({ segment: "East Segment", date: "2024-06-01T00:00:00", hours: 1 })];
  const result = runBacktest({ incidents, segments: [SEGMENTS[0]], config });
  assert.equal(result.ranking.n, 1);
  assert.equal(result.ranking.spearmanRho, null);
});

// ---- 4. duration-class confusion counts + hit rate ---------------------------------------------

test("runBacktest: duration-class model fit on year1 predicts year2 with a confusion matrix + hit rate", () => {
  const config = loadConfig();
  const incidents = [
    // Year 1: "Vehicle fire" on East is consistently "long" (7h) -> majority class = long
    closure({ segment: "East Segment", date: "2024-06-01T00:00:00", type: "Vehicle fire", hours: 7 }),
    closure({ segment: "East Segment", date: "2024-07-01T00:00:00", type: "Vehicle fire", hours: 7 }),
    closure({ segment: "East Segment", date: "2024-08-01T00:00:00", type: "Vehicle fire", hours: 6 }),
    // Year 2: two more "Vehicle fire"/East rows, one matches (long), one doesn't (short)
    closure({ segment: "East Segment", date: "2025-06-01T00:00:00", type: "Vehicle fire", hours: 7 }), // predicted long, actual long -> hit
    closure({ segment: "East Segment", date: "2025-07-01T00:00:00", type: "Vehicle fire", hours: 1 }), // predicted long, actual short -> miss
  ];

  const result = runBacktest({ incidents, segments: SEGMENTS, config });

  assert.equal(result.durationClass.n, 2);
  assert.ok(Math.abs(result.durationClass.hitRate - 0.5) < 1e-9);
  // confusion[actualClass][predictedClass]: hit is actual=long/predicted=long; miss is actual=short (1h)/predicted=long.
  assert.equal(result.durationClass.confusion.long.long, 1);
  assert.equal(result.durationClass.confusion.short.long, 1);
});

test("runBacktest: duration-class model falls back to global majority for an unseen type+segment key", () => {
  const config = loadConfig();
  const incidents = [
    // Year1: everything is short, regardless of type/segment -> global majority = short
    closure({ segment: "East Segment", date: "2024-06-01T00:00:00", type: "Vehicle fire", hours: 1 }),
    closure({ segment: "East Segment", date: "2024-07-01T00:00:00", type: "Guardrail strike", hours: 1 }),
    // Year2: a type never seen in year1 at all, on a segment never seen with it either
    closure({ segment: "West Segment", date: "2025-06-01T00:00:00", type: "Brand new incident type", hours: 1.5 }),
  ];

  const result = runBacktest({ incidents, segments: SEGMENTS, config });
  assert.equal(result.durationClass.n, 1);
  // fell back to global majority (short) and the actual (short) matches -> hit
  assert.ok(Math.abs(result.durationClass.hitRate - 1) < 1e-9);
});

// ---- 5. coverage stats ---------------------------------------------------------------------------

test("runBacktest: coverage stats count usable rows and flag unparsable dates", () => {
  const config = loadConfig();
  const incidents = [
    closure({ segment: "East Segment", date: "2024-06-01T00:00:00" }),
    closure({ segment: "East Segment", date: "2025-06-01T00:00:00" }),
    closure({ segment: null, date: "2024-06-01T00:00:00" }), // no-segment row, still date-usable
    closure({ segment: "East Segment", date: null }), // unparsable date
    { ...closure({ segment: "East Segment", date: "2024-06-01T00:00:00" }), lane_closure_y_n: "No" }, // not a closure
  ];

  const result = runBacktest({ incidents, segments: SEGMENTS, config });

  assert.equal(result.coverage.totalIncidents, 5);
  assert.equal(result.coverage.unparsableDates, 1);
  assert.equal(result.coverage.train.closureRows, 2); // the two Yes closures dated in year1
  assert.equal(result.coverage.train.withSegment, 2); // the two dated-in-year1 rows carrying a Segment (closure or not)
  assert.equal(result.coverage.test.closureRows, 1);
});

// ---- 6. honesty line -------------------------------------------------------------------------

test("HONESTY_LINE is exported verbatim per spec §4 and surfaced on the result", () => {
  assert.equal(
    HONESTY_LINE,
    "traffic delay and exact revenue figures are calibrated in the pilot — no traffic actuals in this package."
  );
  const config = loadConfig();
  const result = runBacktest({ incidents: [], segments: SEGMENTS, config });
  assert.equal(result.honestyLine, HONESTY_LINE);
  // No delay/revenue METRIC KEYS anywhere in the output (the honesty line text itself names
  // "delay"/"revenue" only to disclaim them — that's expected, not a leak of the real metrics).
  const segmentKeys = Object.keys(result.segments[0] || { x: 1 });
  const forbidden = ["revenue", "delay"];
  for (const key of segmentKeys) {
    for (const word of forbidden) {
      assert.ok(!key.toLowerCase().includes(word), `segment row must not carry a ${word} key, got ${key}`);
    }
  }
  assert.ok(!("delay" in result) && !("revenue" in result));
});

// ---- 7. runs cleanly against the real incidents_v3.json snapshot ------------------------------

test("runBacktest: runs against the real incidents_v3.json without throwing", () => {
  const config = loadConfig();
  const incidents = JSON.parse(readFileSync(incidentsPath, "utf-8"));
  const result = runBacktest({ incidents, segments: SEGMENTS, config });
  assert.ok(result.coverage.totalIncidents === incidents.length);
  assert.ok(Array.isArray(result.segments));
  assert.ok(result.durationClass.n >= 0);
});
