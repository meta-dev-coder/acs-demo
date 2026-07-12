/*---------------------------------------------------------------------------------------------
 * glassBox.test.mjs — UC1 deck-parity item 6 (Phase 12): pure "glass box" ingredient lines for
 * the window-panel popovers (windowIngredientLines) and the exec-KPI-strip popovers
 * (execTileIngredientLines). Small inline fixtures only (mirrors windowEval.test.mjs style).
 *--------------------------------------------------------------------------------------------*/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createWindowEvaluator } from "../src/windowEval.js";
import { computeExecKpis } from "../src/execKpis.js";
import { windowIngredientLines, execTileIngredientLines } from "../src/glassBox.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(__dirname, "..", "config", "windowConfig.json");

function loadConfig() {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

const SEGMENTS = [{ id: "east", name: "East Segment", lonBand: [-80.23, -80.18], laneCount: 3, demandScale: 1.2 }];

function closureIncident(segment, y, hours) {
  return { incident_id: `INC-${Math.random()}`, Segment: segment, lane_closure_y_n: y, lane_closure_duration_hours: hours };
}

function fixtureResult() {
  const config = loadConfig();
  const incidents = [closureIncident("East Segment", "Yes", 4), closureIncident("East Segment", "Yes", 3), closureIncident("West Segment", "Yes", 2)];
  const demandFn = () => Array(16).fill(1500);
  const evaluator = createWindowEvaluator({ config, segments: SEGMENTS, incidents, demandFn });
  const window = { start: new Date("2026-07-13T23:00:00"), durationHours: 4 };
  return evaluator.evaluateWindow("east", { lanesClosed: 1 }, window);
}

// ---- windowIngredientLines("revenue", ...) -----------------------------------------------------

test("windowIngredientLines(\"revenue\", result): includes toll rate, capacity, demand-slice summary", () => {
  const result = fixtureResult();
  const lines = windowIngredientLines("revenue", result);

  assert.ok(Array.isArray(lines) && lines.length > 0);
  assert.ok(lines.some((l) => /toll rate/i.test(l.label)), "must include a toll-rate line");
  assert.ok(lines.some((l) => /capacity/i.test(l.label)), "must include a capacity line");
  assert.ok(lines.some((l) => /demand/i.test(l.label)), "must include a demand-slice summary line");
});

test("windowIngredientLines(\"revenue\", result): toll-rate line badge is \"REAL\"", () => {
  const result = fixtureResult();
  const lines = windowIngredientLines("revenue", result);
  const tollLine = lines.find((l) => /toll rate/i.test(l.label));
  assert.ok(tollLine, "toll-rate line must exist");
  assert.equal(tollLine.badge, "REAL");
});

// ---- windowIngredientLines("score", ...) -------------------------------------------------------

test("windowIngredientLines(\"score\", result): includes each of the 4 raw weights, each badged SYNTHETIC", () => {
  const result = fixtureResult();
  const lines = windowIngredientLines("score", result);

  const revenueW = lines.find((l) => /revenue/i.test(l.label));
  const delayW = lines.find((l) => /delay/i.test(l.label));
  const safetyW = lines.find((l) => /safety/i.test(l.label));
  const crewW = lines.find((l) => /crew/i.test(l.label));

  for (const l of [revenueW, delayW, safetyW, crewW]) {
    assert.ok(l, "each of the 4 raw weights must have a line");
    assert.equal(l.badge, "SYNTHETIC");
  }
});

// ---- windowIngredientLines("crashRisk", ...) ----------------------------------------------------

test("windowIngredientLines(\"crashRisk\", result): includes segment sample size, corridor sample size, blend weight", () => {
  const result = fixtureResult();
  const lines = windowIngredientLines("crashRisk", result);

  assert.ok(lines.some((l) => /segment sample/i.test(l.label)));
  assert.ok(lines.some((l) => /corridor sample/i.test(l.label)));
  assert.ok(lines.some((l) => /blend weight/i.test(l.label)));
});

// ---- unknown field / malformed result: defensive, never throws ----------------------------------

test("windowIngredientLines: unknown field returns [], never throws", () => {
  const result = fixtureResult();
  assert.deepEqual(windowIngredientLines("notAField", result), []);
  assert.deepEqual(windowIngredientLines(undefined, result), []);
});

test("windowIngredientLines: malformed/partial result (missing ingredients) returns defensive \"—\"-valued lines, never throws", () => {
  assert.doesNotThrow(() => windowIngredientLines("revenue", {}));
  assert.doesNotThrow(() => windowIngredientLines("revenue", null));
  assert.doesNotThrow(() => windowIngredientLines("crashRisk", { window: {} }));

  const lines = windowIngredientLines("revenue", {});
  assert.ok(Array.isArray(lines) && lines.length > 0, "still returns the field's line shape, just with dash values");
  assert.ok(lines.every((l) => l.value === "—"), "every line value defaults to the em-dash placeholder");

  assert.deepEqual(windowIngredientLines("revenue", null), lines, "null result behaves the same as {}");
});

// ---- execTileIngredientLines -------------------------------------------------------------------

test('execTileIngredientLines("revenueProtected", decisions): sums to the same total computeExecKpis() reports', () => {
  const decisions = [
    { id: "D1", window: { durationHours: 4 }, revenueAtRiskUsd: { point: 100, high: 150 }, queue: { avgDelayMin: 5 }, secondaryCrashExposure: 0.2, openLanes: 2, totalLanes: 3, seeded: true },
    { id: "D2", window: { durationHours: 3 }, revenueAtRiskUsd: { point: 0, high: 0 }, queue: { avgDelayMin: 0 }, secondaryCrashExposure: 0, openLanes: 3, totalLanes: 3, seeded: true },
    { id: "D3", window: { durationHours: 4 }, revenueAtRiskUsd: { point: 40, high: 55 }, avgDelayMin: 2, secondaryCrashExposure: 0.1, laneAvailabilityPct: 66.7, rank: 1 },
  ];

  const kpis = computeExecKpis(decisions);
  const lines = execTileIngredientLines("revenueProtected", decisions);

  assert.equal(lines.length, decisions.length);
  const sum = lines.reduce((a, l) => a + l.value, 0);
  assert.ok(Math.abs(sum - kpis.revenueProtected) < 0.01, `sum ${sum} should equal computeExecKpis().revenueProtected ${kpis.revenueProtected}`);
});

test("execTileIngredientLines: empty decisions array returns [], never throws", () => {
  assert.deepEqual(execTileIngredientLines("revenueProtected", []), []);
  assert.doesNotThrow(() => execTileIngredientLines("revenueProtected", undefined));
  assert.deepEqual(execTileIngredientLines("revenueProtected", undefined), []);
  assert.deepEqual(execTileIngredientLines("notATile", []), []);
});
