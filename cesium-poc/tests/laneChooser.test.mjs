/*---------------------------------------------------------------------------------------------
 * laneChooser.test.mjs — UC1 deck-parity item 3 (Phase 10): laneCloseOptions() pure core. The
 * DOM shell (renderLaneChooser/hideLaneChooser/positionLaneChooserAt) is e2e-covered, not
 * unit-tested — same convention as windowPicker.js's own DOM half (see that module's header).
 *--------------------------------------------------------------------------------------------*/
import { test } from "node:test";
import assert from "node:assert/strict";

import { laneCloseOptions } from "../src/laneChooser.js";

test("laneCloseOptions: laneCount=3 -> [1,2]", () => {
  assert.deepEqual(laneCloseOptions({ laneCount: 3 }), [1, 2]);
});

test("laneCloseOptions: laneCount=1 -> [] (degenerate single-lane segment)", () => {
  assert.deepEqual(laneCloseOptions({ laneCount: 1 }), []);
});

test("laneCloseOptions: laneCount=0 or missing -> [], no throw", () => {
  assert.deepEqual(laneCloseOptions({ laneCount: 0 }), []);
  assert.deepEqual(laneCloseOptions({}), []);
  assert.deepEqual(laneCloseOptions(null), []);
  assert.deepEqual(laneCloseOptions(undefined), []);
});

test("laneCloseOptions: laneCount=2 -> [1]; laneCount=4 -> [1,2,3]", () => {
  assert.deepEqual(laneCloseOptions({ laneCount: 2 }), [1]);
  assert.deepEqual(laneCloseOptions({ laneCount: 4 }), [1, 2, 3]);
});
