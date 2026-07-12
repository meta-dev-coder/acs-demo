/*---------------------------------------------------------------------------------------------
 * uc1Mode.test.mjs — Task B: pure-helper coverage for uc1Mode.js's step-state machine and the
 * chrome-hide/keep selector data. DOM rendering (renderStartupTile/renderStepper/enterUc1Mode/
 * exitUc1Mode) isn't unit-tested under node --test (no DOM shim), matching windowPanel.test.mjs/
 * trustPanel.test.mjs's own posture — this file covers only the exported pure functions/data.
 *--------------------------------------------------------------------------------------------*/
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  UC1_STEPS,
  STEP_EVENTS,
  advanceUc1Step,
  resetUc1Step,
  UC1_HIDDEN_SELECTORS,
  UC1_KEPT_SELECTORS,
} from "../src/uc1Mode.js";

// ---- UC1_STEPS -----------------------------------------------------------------------------

test("UC1_STEPS: exactly 5 steps, in storyboard §1 order", () => {
  assert.deepEqual(
    UC1_STEPS.map((s) => s.label),
    ["Trigger", "Context", "Simulate", "Compare", "Decide"]
  );
});

// ---- advanceUc1Step: the pure step-state machine -------------------------------------------

test("advanceUc1Step: pickWorkOrder advances step 1 -> 2", () => {
  assert.equal(advanceUc1Step(1, "pickWorkOrder"), 2);
});

test("advanceUc1Step: evaluate advances step 2 -> 3", () => {
  assert.equal(advanceUc1Step(2, "evaluate"), 3);
});

test("advanceUc1Step: resultsRendered advances step 3 -> 4", () => {
  assert.equal(advanceUc1Step(3, "resultsRendered"), 4);
});

test("advanceUc1Step: schedule advances step 4 -> 5", () => {
  assert.equal(advanceUc1Step(4, "schedule"), 5);
});

test("advanceUc1Step: no-ops when the event's origin step doesn't match the current step (no skipping ahead)", () => {
  assert.equal(advanceUc1Step(1, "evaluate"), 1, "evaluate expects step 2, not 1");
  assert.equal(advanceUc1Step(1, "resultsRendered"), 1);
  assert.equal(advanceUc1Step(1, "schedule"), 1);
  assert.equal(advanceUc1Step(3, "pickWorkOrder"), 3, "pickWorkOrder expects step 1, not 3");
});

test("advanceUc1Step: no-ops on an already-advanced or already-final step (no re-firing / no overshoot)", () => {
  assert.equal(advanceUc1Step(2, "pickWorkOrder"), 2, "already past step 1 — pickWorkOrder shouldn't re-fire");
  assert.equal(advanceUc1Step(5, "schedule"), 5, "step 5 is terminal — schedule shouldn't re-fire");
});

test("advanceUc1Step: unknown event is a no-op, never throws", () => {
  assert.equal(advanceUc1Step(1, "bogusEvent"), 1);
  assert.equal(advanceUc1Step(3, undefined), 3);
});

test("advanceUc1Step: a full walk from step 1 to step 5 via the storyboard's literal event sequence", () => {
  let step = resetUc1Step();
  assert.equal(step, 1);
  step = advanceUc1Step(step, "pickWorkOrder");
  step = advanceUc1Step(step, "evaluate");
  step = advanceUc1Step(step, "resultsRendered");
  step = advanceUc1Step(step, "schedule");
  assert.equal(step, 5);
});

test("STEP_EVENTS: every event's `from`/`to` are valid 1..5 step numbers and to = from + 1", () => {
  for (const [name, rule] of Object.entries(STEP_EVENTS)) {
    assert.ok(rule.from >= 1 && rule.from <= 5, `${name}.from out of range`);
    assert.ok(rule.to >= 1 && rule.to <= 5, `${name}.to out of range`);
    assert.equal(rule.to, rule.from + 1, `${name} should advance exactly one step`);
  }
});

// ---- resetUc1Step ---------------------------------------------------------------------------

test("resetUc1Step: always returns 1", () => {
  assert.equal(resetUc1Step(), 1);
});

// ---- chrome-hide / chrome-keep selector data (storyboard §7) --------------------------------

test("UC1_HIDDEN_SELECTORS: covers every id/class the storyboard names as hidden", () => {
  const expectedSubstrings = [
    "#renderer-toggle",
    "#site-select",
    ".toggle",
    "#kpis",
    "#cash-aet-card",
    ".legend",
    "#weather-select",
    "#speed-seg",
    "#btn-view",
    "#gatePanel",
    "#workzone-hud",
    "#dc-panel",
    "#assetops-hud",
  ];
  for (const needle of expectedSubstrings) {
    assert.ok(
      UC1_HIDDEN_SELECTORS.some((sel) => sel.includes(needle)),
      `expected some hidden selector to reference ${needle}`
    );
  }
});

test("UC1_HIDDEN_SELECTORS: no duplicate entries", () => {
  assert.equal(new Set(UC1_HIDDEN_SELECTORS).size, UC1_HIDDEN_SELECTORS.length);
});

test("UC1_KEPT_SELECTORS: covers UC1's own panel + the floating context/window/trust panels", () => {
  for (const needle of ["#uc1-panel", "#uc1-exec-kpi-strip", "#uc1-context-panel", "#uc1-window-panel", "#uc1-trust-panel"]) {
    assert.ok(UC1_KEPT_SELECTORS.includes(needle), `expected UC1_KEPT_SELECTORS to include ${needle}`);
  }
});

test("UC1_HIDDEN_SELECTORS and UC1_KEPT_SELECTORS are disjoint (nothing is both hidden and kept)", () => {
  const hidden = new Set(UC1_HIDDEN_SELECTORS);
  for (const sel of UC1_KEPT_SELECTORS) {
    assert.ok(!hidden.has(sel), `${sel} appears in both hidden and kept lists`);
  }
});

// ---- DOM-env guard (mirrors adapter.test.mjs's own check) ------------------------------------

test("node --test runs with no DOM (document is undefined) — sanity check for this file's scope", () => {
  assert.equal(typeof document, "undefined");
});
