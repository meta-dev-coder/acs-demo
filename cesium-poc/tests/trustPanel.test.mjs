/*---------------------------------------------------------------------------------------------
 * trustPanel.test.mjs — UC1 P5-b: pure-helper coverage for trustPanel.js's assumption merge/
 * clamp and provenance-badge mapping (design spec §4 "Trust panel", Assumptions tab). DOM
 * rendering (renderTrustPanel itself) isn't unit-tested under node --test, matching
 * windowPanel.test.mjs's own "DOM rendering isn't unit-testable without a DOM shim" posture —
 * this file covers only the exported pure functions.
 *--------------------------------------------------------------------------------------------*/
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HONESTY_LINE,
  DEFAULT_ASSUMPTIONS,
  ASSUMPTION_BOUNDS,
  ASSUMPTION_BADGES,
  boundsForAssumptionPath,
  badgeForAssumptionPath,
  clampAssumptionValue,
  getAssumptionAtPath,
  setAssumptionAtPath,
  mergeAssumptionDefaults,
} from "../src/trustPanel.js";

// ---- HONESTY_LINE: verbatim slide-10 line -------------------------------------------------------

test("HONESTY_LINE is the verbatim slide-10 honesty line from the design spec", () => {
  assert.equal(
    HONESTY_LINE,
    "traffic delay and exact revenue figures are calibrated in the pilot — no traffic actuals in this package."
  );
});

// ---- boundsForAssumptionPath / badgeForAssumptionPath -------------------------------------------

test("boundsForAssumptionPath resolves known top-level and nested paths", () => {
  assert.deepEqual(boundsForAssumptionPath("tollRateUsd"), ASSUMPTION_BOUNDS.tollRateUsd);
  assert.deepEqual(boundsForAssumptionPath("weights.revenue"), [0, 1]);
  assert.deepEqual(boundsForAssumptionPath("mergeFriction"), ASSUMPTION_BOUNDS.mergeFriction);
});

test("boundsForAssumptionPath falls back to the segmentDemandScale bucket for any segment id", () => {
  assert.deepEqual(boundsForAssumptionPath("segmentDemandScale.east"), ASSUMPTION_BOUNDS.segmentDemandScale);
  assert.deepEqual(boundsForAssumptionPath("segmentDemandScale.not-a-real-segment"), ASSUMPTION_BOUNDS.segmentDemandScale);
});

test("boundsForAssumptionPath returns null for unknown paths", () => {
  assert.equal(boundsForAssumptionPath("bogus.path"), null);
  assert.equal(boundsForAssumptionPath(undefined), null);
});

test("badgeForAssumptionPath: tollRateUsd is REAL, weights/mergeFriction/demandScale are SYNTHETIC", () => {
  assert.equal(badgeForAssumptionPath("tollRateUsd"), "REAL");
  assert.equal(badgeForAssumptionPath("weights.revenue"), "SYNTHETIC");
  assert.equal(badgeForAssumptionPath("weights.delay"), "SYNTHETIC");
  assert.equal(badgeForAssumptionPath("weights.safety"), "SYNTHETIC");
  assert.equal(badgeForAssumptionPath("weights.crew"), "SYNTHETIC");
  assert.equal(badgeForAssumptionPath("mergeFriction"), "SYNTHETIC");
  assert.equal(badgeForAssumptionPath("segmentDemandScale.west"), "SYNTHETIC");
});

test("badgeForAssumptionPath returns null for unknown paths, never an invalid label", () => {
  assert.equal(badgeForAssumptionPath("nonsense"), null);
  for (const path of Object.keys(ASSUMPTION_BADGES)) {
    assert.ok(["SYNTHETIC", "REAL", "EXTERNAL"].includes(ASSUMPTION_BADGES[path]));
  }
});

// ---- clampAssumptionValue ------------------------------------------------------------------------

test("clampAssumptionValue clamps within bounds", () => {
  assert.equal(clampAssumptionValue("weights.revenue", 1.5), 1);
  assert.equal(clampAssumptionValue("weights.revenue", -0.2), 0);
  assert.equal(clampAssumptionValue("weights.revenue", 0.42), 0.42);
});

test("clampAssumptionValue clamps mergeFriction and tollRateUsd to their own bounds", () => {
  assert.equal(clampAssumptionValue("mergeFriction", 0), 0.1); // min bound 0.1
  assert.equal(clampAssumptionValue("mergeFriction", 5), 1);
  assert.equal(clampAssumptionValue("tollRateUsd", -3), 0);
  assert.equal(clampAssumptionValue("tollRateUsd", 999), 10);
});

test("clampAssumptionValue clamps per-segment demand scale via the fallback bucket", () => {
  assert.equal(clampAssumptionValue("segmentDemandScale.east", 0), 0.1);
  assert.equal(clampAssumptionValue("segmentDemandScale.east", 10), 3);
  assert.equal(clampAssumptionValue("segmentDemandScale.east", 1.2), 1.2);
});

test("clampAssumptionValue accepts string input (raw slider/input DOM values)", () => {
  assert.equal(clampAssumptionValue("weights.delay", "0.35"), 0.35);
});

test("clampAssumptionValue treats non-finite input as the lower bound, and 0 for unbounded paths", () => {
  assert.equal(clampAssumptionValue("weights.safety", "not-a-number"), 0);
  assert.equal(clampAssumptionValue("unbounded.path", "not-a-number"), 0);
  assert.equal(clampAssumptionValue("unbounded.path", 7), 7);
});

// ---- getAssumptionAtPath / setAssumptionAtPath -----------------------------------------------

test("getAssumptionAtPath reads nested and top-level fields", () => {
  assert.equal(getAssumptionAtPath(DEFAULT_ASSUMPTIONS, "tollRateUsd"), 2.5);
  assert.equal(getAssumptionAtPath(DEFAULT_ASSUMPTIONS, "weights.safety"), 0.3);
});

test("getAssumptionAtPath returns undefined for missing paths without throwing", () => {
  assert.equal(getAssumptionAtPath(DEFAULT_ASSUMPTIONS, "segmentDemandScale.east"), undefined);
  assert.equal(getAssumptionAtPath({}, "weights.revenue"), undefined);
  assert.equal(getAssumptionAtPath(null, "weights.revenue"), undefined);
});

test("setAssumptionAtPath sets a nested field and clamps it, without mutating the input", () => {
  const before = mergeAssumptionDefaults();
  const beforeSnapshot = JSON.parse(JSON.stringify(before));

  const after = setAssumptionAtPath(before, "weights.revenue", 0.9);

  assert.equal(getAssumptionAtPath(after, "weights.revenue"), 0.9);
  assert.deepEqual(before, beforeSnapshot, "input object must not be mutated");
  assert.notEqual(after, before, "must return a new object");
  assert.notEqual(after.weights, before.weights, "nested object along the path must be a new object too");
});

test("setAssumptionAtPath clamps out-of-range values on write", () => {
  const a = mergeAssumptionDefaults();
  const after = setAssumptionAtPath(a, "weights.delay", 5);
  assert.equal(getAssumptionAtPath(after, "weights.delay"), 1);
});

test("setAssumptionAtPath creates a not-yet-seen segment's demandScale entry", () => {
  const a = mergeAssumptionDefaults();
  const after = setAssumptionAtPath(a, "segmentDemandScale.newSegment", 1.4);
  assert.equal(getAssumptionAtPath(after, "segmentDemandScale.newSegment"), 1.4);
  // sibling fields untouched
  assert.equal(after.tollRateUsd, a.tollRateUsd);
});

test("setAssumptionAtPath leaves sibling weight fields untouched", () => {
  const a = mergeAssumptionDefaults();
  const after = setAssumptionAtPath(a, "weights.crew", 0.6);
  assert.equal(after.weights.crew, 0.6);
  assert.equal(after.weights.revenue, a.weights.revenue);
  assert.equal(after.weights.delay, a.weights.delay);
  assert.equal(after.weights.safety, a.weights.safety);
});

// ---- mergeAssumptionDefaults -------------------------------------------------------------------

test("mergeAssumptionDefaults fills in every field when given undefined", () => {
  const merged = mergeAssumptionDefaults(undefined);
  assert.equal(merged.tollRateUsd, DEFAULT_ASSUMPTIONS.tollRateUsd);
  assert.deepEqual(merged.weights, DEFAULT_ASSUMPTIONS.weights);
  assert.equal(merged.mergeFriction, DEFAULT_ASSUMPTIONS.mergeFriction);
  assert.deepEqual(merged.segmentDemandScale, {});
  assert.deepEqual(merged.segments, []);
});

test("mergeAssumptionDefaults preserves caller-provided fields and merges partial weights", () => {
  const merged = mergeAssumptionDefaults({
    tollRateUsd: 3.75,
    weights: { revenue: 0.8 }, // delay/safety/crew missing — should backfill from defaults
    segmentDemandScale: { east: 1.5 },
  });
  assert.equal(merged.tollRateUsd, 3.75);
  assert.equal(merged.weights.revenue, 0.8);
  assert.equal(merged.weights.delay, DEFAULT_ASSUMPTIONS.weights.delay);
  assert.equal(merged.weights.safety, DEFAULT_ASSUMPTIONS.weights.safety);
  assert.equal(merged.mergeFriction, DEFAULT_ASSUMPTIONS.mergeFriction);
  assert.deepEqual(merged.segmentDemandScale, { east: 1.5 });
});

test("mergeAssumptionDefaults does not mutate its input", () => {
  const input = { weights: { revenue: 0.77 } };
  const snapshot = JSON.parse(JSON.stringify(input));
  mergeAssumptionDefaults(input);
  assert.deepEqual(input, snapshot);
});

test("mergeAssumptionDefaults ignores non-finite tollRateUsd/mergeFriction and falls back to defaults", () => {
  const merged = mergeAssumptionDefaults({ tollRateUsd: "nope", mergeFriction: NaN });
  assert.equal(merged.tollRateUsd, DEFAULT_ASSUMPTIONS.tollRateUsd);
  assert.equal(merged.mergeFriction, DEFAULT_ASSUMPTIONS.mergeFriction);
});
