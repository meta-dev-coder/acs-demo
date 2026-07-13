/*---------------------------------------------------------------------------------------------
 * assetBrowser.test.mjs — Task B: pure-helper coverage for assetBrowser.js's group/filter/cap
 * logic (the "By type"/"By area" left-docked asset browser). DOM rendering (renderAssetBrowser
 * itself) isn't unit-tested under node --test (no DOM shim) — matches uc1Mode.test.mjs/
 * windowPanel.test.mjs's own posture of covering only the exported pure functions.
 *--------------------------------------------------------------------------------------------*/
import { test } from "node:test";
import assert from "node:assert/strict";

import { filterGroups, capItems, tabCounts } from "../src/assetBrowser.js";

function makeGroups(spec) {
  // spec: [[key, label, itemCount], ...] -> Group[] with synthetic {id,label} items
  return spec.map(([key, label, n]) => ({
    key,
    label,
    items: Array.from({ length: n }, (_, i) => ({ id: `${key}-${i}`, label: `${label} widget ${i}` })),
  }));
}

// ---- tabCounts -------------------------------------------------------------------------------

test("tabCounts: sums item counts per tab across all groups in that tab", () => {
  const groups = {
    byType: makeGroups([["gantry", "Gantry", 3], ["camera", "Camera", 2]]),
    byArea: makeGroups([["east", "East", 4], ["west", "West", 1]]),
  };
  assert.deepEqual(tabCounts(groups), { byType: 5, byArea: 5 });
});

test("tabCounts: empty group lists yield 0", () => {
  assert.deepEqual(tabCounts({ byType: [], byArea: [] }), { byType: 0, byArea: 0 });
});

test("tabCounts: missing tab key on the input is treated as 0, never throws", () => {
  assert.deepEqual(tabCounts({ byType: makeGroups([["g", "G", 2]]) }), { byType: 2, byArea: 0 });
  assert.deepEqual(tabCounts({}), { byType: 0, byArea: 0 });
});

// ---- capItems --------------------------------------------------------------------------------

test("capItems: caps to n and reports the true total", () => {
  const items = Array.from({ length: 137 }, (_, i) => ({ id: i }));
  const capped = capItems(items, 50);
  assert.equal(capped.shown.length, 50);
  assert.equal(capped.total, 137);
  assert.deepEqual(capped.shown[0], { id: 0 });
  assert.deepEqual(capped.shown[49], { id: 49 });
});

test("capItems: fewer items than n returns them all, uncapped", () => {
  const items = [{ id: "a" }, { id: "b" }];
  const capped = capItems(items, 50);
  assert.equal(capped.shown.length, 2);
  assert.equal(capped.total, 2);
});

test("capItems: defaults n to 50 when omitted", () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ id: i }));
  const capped = capItems(items);
  assert.equal(capped.shown.length, 50);
  assert.equal(capped.total, 60);
});

test("capItems: empty/missing items never throws", () => {
  assert.deepEqual(capItems([], 50), { shown: [], total: 0 });
  assert.deepEqual(capItems(undefined, 50), { shown: [], total: 0 });
});

// ---- filterGroups ------------------------------------------------------------------------------

test("filterGroups: empty query returns the groups unchanged (no filtering, nothing dropped)", () => {
  const groups = makeGroups([["gantry", "Gantry", 2], ["camera", "Camera", 3]]);
  assert.deepEqual(filterGroups(groups, ""), groups);
  assert.deepEqual(filterGroups(groups, "   "), groups);
  assert.deepEqual(filterGroups(groups, undefined), groups);
});

test("filterGroups: matches item label case-insensitively, keeps only matching items per group", () => {
  const groups = [
    { key: "gantry", label: "Gantry", items: [{ id: "1", label: "Toll Gantry North" }, { id: "2", label: "Camera Pole" }] },
    { key: "camera", label: "Camera", items: [{ id: "3", label: "Speed Camera" }] },
  ];
  const filtered = filterGroups(groups, "camera");
  assert.equal(filtered.length, 2);
  assert.deepEqual(filtered[0].items.map((i) => i.id), ["2"]);
  assert.deepEqual(filtered[1].items.map((i) => i.id), ["3"]);
});

test("filterGroups: groups with zero matches after filtering are dropped entirely", () => {
  const groups = [
    { key: "gantry", label: "Gantry", items: [{ id: "1", label: "Toll Gantry" }] },
    { key: "camera", label: "Camera", items: [{ id: "2", label: "Speed Camera" }] },
  ];
  const filtered = filterGroups(groups, "gantry");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].key, "gantry");
});

test("filterGroups: falls back to matching item id when label is missing", () => {
  const groups = [{ key: "g", label: "G", items: [{ id: "AB-1234" }, { id: "XY-9" }] }];
  const filtered = filterGroups(groups, "ab-12");
  assert.deepEqual(filtered[0].items.map((i) => i.id), ["AB-1234"]);
});

test("filterGroups: no matches anywhere returns an empty array", () => {
  const groups = makeGroups([["gantry", "Gantry", 2]]);
  assert.deepEqual(filterGroups(groups, "zzz-nope"), []);
});

test("filterGroups: missing/empty groups array never throws", () => {
  assert.deepEqual(filterGroups([], "x"), []);
  assert.deepEqual(filterGroups(undefined, "x"), []);
});

// ---- DOM-env guard (mirrors uc1Mode.test.mjs/adapter.test.mjs's own check) --------------------

test("node --test runs with no DOM (document is undefined) — sanity check for this file's scope", () => {
  assert.equal(typeof document, "undefined");
});
