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

import { segmentCenterlinePoints, groupAssetsBy, assetBrowserGroups } from "../src/uc1Data.js";

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

// ---- Task A: groupAssetsBy() / assetBrowserGroups() -------------------------------------------

test("groupAssetsBy: groups by keyFn, counts, sorts groups count-desc then key-asc on ties", () => {
  const items = [
    { id: "3", category: "Camera" },
    { id: "1", category: "Lighting" },
    { id: "2", category: "Lighting" },
    { id: "5", category: "Drainage" },
    { id: "4", category: "Camera" },
  ];
  const groups = groupAssetsBy(items, (i) => i.category);
  assert.deepEqual(
    groups.map((g) => [g.key, g.count]),
    [
      ["Camera", 2],
      ["Lighting", 2],
      ["Drainage", 1],
    ]
  );
  // ties (Lighting/Camera both count 2) break by key ascending
  assert.equal(groups[0].key, "Camera");
});

test("groupAssetsBy: items within each group sorted by id", () => {
  const items = [
    { id: "b2", category: "X" },
    { id: "a1", category: "X" },
    { id: "c3", category: "X" },
  ];
  const groups = groupAssetsBy(items, (i) => i.category);
  assert.deepEqual(
    groups[0].items.map((i) => i.id),
    ["a1", "b2", "c3"]
  );
});

test("groupAssetsBy: label mirrors key, empty input yields []", () => {
  assert.deepEqual(groupAssetsBy([], (i) => i.category), []);
  assert.deepEqual(groupAssetsBy(undefined, (i) => i.category), []);
  const groups = groupAssetsBy([{ id: "1", category: "X" }], (i) => i.category);
  assert.equal(groups[0].label, "X");
});

const fixtureRegistry = [
  {
    "Asset ID": "1",
    "Asset Category": "Lighting",
    "Asset Description": "Pole 1",
    Segment: "East Segment",
    "X Coordinates": -80.2,
    "Y Coordinates": 26.09,
  },
  {
    "Asset ID": "2",
    "Asset Category": "Lighting",
    "Asset Description": "Pole 2",
    Segment: "East Segment",
    "X Coordinates": -80.21,
    "Y Coordinates": 26.1,
  },
  {
    "Asset ID": "3",
    "Asset Category": "Attenuetors", // real export's own typo — preserved verbatim, not "corrected"
    "Asset Description": 1267, // numeric description (real export has these) — must String()-coerce
    Segment: "West Segment",
    "X Coordinates": -80.3,
    "Y Coordinates": 26.05,
  },
  {
    "Asset ID": "4",
    "Asset Category": "False", // literal placeholder value — must bucket under Uncategorized, not drop the row
    "Asset Description": null,
    Segment: "",
    "X Coordinates": -80.25,
    "Y Coordinates": 26.06,
  },
  {
    "Asset ID": "5",
    "Asset Category": null, // missing category entirely — same Uncategorized bucket
    "Asset Description": "Mystery box",
    Segment: null, // missing segment -> Unknown segment
    "X Coordinates": -80.26,
    "Y Coordinates": 26.07,
  },
  {
    "Asset ID": "ABC1X1",
    "Asset Category": "Accidents", // dated safety event row, not a physical asset
    "Asset Description": "Accidents",
    Segment: "Central Segment",
    "X Coordinates": -80.22,
    "Y Coordinates": 26.08,
  },
];

test("assetBrowserGroups: byType groups on Asset Category, Uncategorized bucket for falsy/placeholder values, nothing dropped", () => {
  const { byType } = assetBrowserGroups(fixtureRegistry);
  const total = byType.reduce((sum, g) => sum + g.count, 0);
  assert.equal(total, fixtureRegistry.length);
  const uncategorized = byType.find((g) => g.key === "Uncategorized");
  assert.ok(uncategorized, "falsy/placeholder categories must bucket under Uncategorized");
  assert.equal(uncategorized.count, 2); // "False" row + null-category row
  assert.deepEqual(uncategorized.items.map((i) => i.id).sort(), ["4", "5"]);
  const attenuators = byType.find((g) => g.key === "Attenuetors");
  assert.ok(attenuators, "the export's own 'Attenuetors' typo is preserved verbatim");
  assert.equal(attenuators.items[0].label, "1267"); // numeric description coerced to string
});

test("assetBrowserGroups: byArea groups on Segment, blank/null -> Unknown segment, nothing dropped", () => {
  const { byArea } = assetBrowserGroups(fixtureRegistry);
  const total = byArea.reduce((sum, g) => sum + g.count, 0);
  assert.equal(total, fixtureRegistry.length);
  const unknown = byArea.find((g) => g.key === "Unknown segment");
  assert.ok(unknown, "blank/null Segment must bucket under Unknown segment");
  assert.deepEqual(unknown.items.map((i) => i.id).sort(), ["4", "5"]);
  const east = byArea.find((g) => g.key === "East Segment");
  assert.equal(east.count, 2);
});

test("assetBrowserGroups: accident-category rows are included (flagged kind:'accident'), not scored assets", () => {
  const { byType } = assetBrowserGroups(fixtureRegistry);
  const accidents = byType.find((g) => g.key === "Accidents");
  assert.ok(accidents, "Accidents category row must still appear in the browser, not be dropped");
  assert.equal(accidents.items[0].kind, "accident");
  const lighting = byType.find((g) => g.key === "Lighting");
  assert.equal(lighting.items[0].kind, "asset");
});

test("assetBrowserGroups: items reduced to {id, label, lon, lat, category, kind}", () => {
  const { byType } = assetBrowserGroups(fixtureRegistry);
  const lighting = byType.find((g) => g.key === "Lighting");
  const item = lighting.items.find((i) => i.id === "1");
  assert.deepEqual(item, {
    id: "1",
    label: "Pole 1",
    lon: -80.2,
    lat: 26.09,
    category: "Lighting",
    kind: "asset",
  });
});

test("assetBrowserGroups: empty/missing input never throws", () => {
  assert.deepEqual(assetBrowserGroups([]), { byType: [], byArea: [] });
  assert.deepEqual(assetBrowserGroups(undefined), { byType: [], byArea: [] });
});

test("assetBrowserGroups: real asset_registry.json snapshot — byType and byArea counts both sum to the full export row count", () => {
  const registry = loadJson("public", "dataconnect-data", "asset_registry.json");
  const { byType, byArea } = assetBrowserGroups(registry);
  const typeTotal = byType.reduce((sum, g) => sum + g.count, 0);
  const areaTotal = byArea.reduce((sum, g) => sum + g.count, 0);
  assert.equal(typeTotal, registry.length);
  assert.equal(areaTotal, registry.length);
  assert.ok(registry.length > 5000, "sanity: real export should be ~5015 rows");
  // the real export's own typo/category names must survive verbatim
  assert.ok(byType.some((g) => g.key === "Attenuetors"));
  assert.ok(byType.some((g) => g.key === "Accidents"));
});
