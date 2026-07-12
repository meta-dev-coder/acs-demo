/*---------------------------------------------------------------------------------------------
 * uc1Data.test.mjs — UC1 deck-parity item 3 (Phase 10): segmentCenterlinePoints(). Split out from
 * adapter.test.mjs (already 600+ lines covering P1/P3's uc1Data.js surface) rather than growing
 * that file further — per the plan's own "check size first" guidance.
 *--------------------------------------------------------------------------------------------*/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { segmentCenterlinePoints } from "../src/uc1Data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadJson(...parts) {
  return JSON.parse(readFileSync(path.join(__dirname, "..", ...parts), "utf-8"));
}

const centerline = [
  { lon: -80.5, lat: 26.0 },
  { lon: -80.4, lat: 26.01 },
  { lon: -80.3, lat: 26.02 },
  { lon: -80.2, lat: 26.03 },
  { lon: -80.1, lat: 26.04 },
];

test("segmentCenterlinePoints: filters to lonBand inclusive", () => {
  const points = segmentCenterlinePoints(centerline, { lonBand: [-80.4, -80.2] });
  assert.deepEqual(points, [
    { lon: -80.4, lat: 26.01 },
    { lon: -80.3, lat: 26.02 },
    { lon: -80.2, lat: 26.03 },
  ]);
});

test("segmentCenterlinePoints: preserves west->east order", () => {
  const points = segmentCenterlinePoints(centerline, { lonBand: [-80.5, -80.1] });
  const lons = points.map((p) => p.lon);
  const sorted = [...lons].sort((a, b) => a - b);
  assert.deepEqual(lons, sorted);
  assert.equal(points.length, centerline.length);
});

test("segmentCenterlinePoints: [] for zero-overlap input", () => {
  assert.deepEqual(segmentCenterlinePoints(centerline, { lonBand: [-79.0, -78.9] }), []);
});

test("segmentCenterlinePoints: never throws on malformed input", () => {
  assert.deepEqual(segmentCenterlinePoints(centerline, {}), []);
  assert.deepEqual(segmentCenterlinePoints(centerline, null), []);
  assert.deepEqual(segmentCenterlinePoints(null, { lonBand: [-80.4, -80.2] }), []);
  assert.deepEqual(segmentCenterlinePoints(undefined, undefined), []);
  assert.deepEqual(segmentCenterlinePoints(centerline, { lonBand: [-80.2, -80.4] }).length > 0, true); // reversed band still works
});

test("segmentCenterlinePoints: every real segments.json entry against the real corridorCenterline.json yields >=2 points", () => {
  const segments = loadJson("config", "segments.json");
  const realCenterline = loadJson("config", "corridorCenterline.json");
  assert.ok(segments.length > 0, "segments.json must not be empty");
  for (const segment of segments) {
    const points = segmentCenterlinePoints(realCenterline, segment);
    assert.ok(
      points.length >= 2,
      `segment ${segment.id} yielded ${points.length} centerline points, expected >= 2`
    );
  }
});
