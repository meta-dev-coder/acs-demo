/*---------------------------------------------------------------------------------------------
 * windowPicker.test.mjs — UC1 deck-parity item 2 (planner window picker), Phase 6 (UI). Pure-core
 * tests for windowPicker.js: weekStartFor()/hourOfWeekToDate() (the week-scale SVG's x-axis time
 * math), clampPlannerWindow() (bounds a click-placed/dragged pick into config.plannerPick +
 * the visible week), ghostWindowsFor() (candidateWindows() reused as dimmed prefill markers —
 * this is where the design-directive deviation Phase 3 logged gets resolved: the WEEK-scale
 * demand curve with the 3 candidate windows as translucent bands lives here, not on
 * windowPanel.js's per-window 0-24h sparkline). No DOM here — DOM is e2e-covered per repo
 * convention (see windowPanel.test.mjs's own header).
 *--------------------------------------------------------------------------------------------*/
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  weekStartFor,
  hourOfWeekToDate,
  clampPlannerWindow,
  ghostWindowsFor,
} from "../src/windowPicker.js";
import { candidateWindows } from "../src/windowEval.js";
import windowConfig from "../config/windowConfig.json" with { type: "json" };

// ---- 1. weekStartFor -----------------------------------------------------------------------

test("weekStartFor: returns a Monday at local 00:00, at or before fromDate", () => {
  // Wednesday 2026-07-15 14:32 local
  const fromDate = new Date(2026, 6, 15, 14, 32, 0);
  const ws = weekStartFor(fromDate);
  assert.equal(ws.getDay(), 1, "must be a Monday");
  assert.equal(ws.getHours(), 0);
  assert.equal(ws.getMinutes(), 0);
  assert.equal(ws.getSeconds(), 0);
  assert.ok(ws.getTime() <= fromDate.getTime(), "week start must be at or before fromDate");
  assert.ok(fromDate.getTime() - ws.getTime() < 7 * 24 * 3_600_000, "must be within the same week");
});

test("weekStartFor: fromDate that IS a Monday at 00:00 returns itself", () => {
  const monday = new Date(2026, 6, 13, 0, 0, 0, 0); // 2026-07-13 is a Monday
  const ws = weekStartFor(monday);
  assert.equal(ws.getTime(), monday.getTime());
});

// ---- 2. hourOfWeekToDate --------------------------------------------------------------------

test("hourOfWeekToDate: round-trips with a manually constructed Date", () => {
  const weekStart = weekStartFor(new Date(2026, 6, 15, 0, 0, 0, 0));
  const target = new Date(weekStart.getTime() + 51.25 * 3_600_000); // Wed 03:15
  const hourOfWeek = (target.getTime() - weekStart.getTime()) / 3_600_000;
  const roundTripped = hourOfWeekToDate(weekStart, hourOfWeek);
  assert.equal(roundTripped.getTime(), target.getTime());
});

test("hourOfWeekToDate: hourOfWeek 0 returns weekStart itself", () => {
  const weekStart = weekStartFor(new Date());
  assert.equal(hourOfWeekToDate(weekStart, 0).getTime(), weekStart.getTime());
});

// ---- 3-5. clampPlannerWindow ------------------------------------------------------------------

test("clampPlannerWindow: durationHours clamps to config.plannerPick bounds", () => {
  const weekStart = weekStartFor(new Date());
  const tooShort = { start: new Date(weekStart.getTime() + 24 * 3_600_000), durationHours: 0.1 };
  const tooLong = { start: new Date(weekStart.getTime() + 24 * 3_600_000), durationHours: 40 };
  const clampedShort = clampPlannerWindow(tooShort, weekStart, windowConfig);
  const clampedLong = clampPlannerWindow(tooLong, weekStart, windowConfig);
  assert.equal(clampedShort.durationHours, windowConfig.plannerPick.minDurationHours);
  assert.equal(clampedLong.durationHours, windowConfig.plannerPick.maxDurationHours);
});

test("clampPlannerWindow: start before weekStart / after weekStart+7d clamps into range", () => {
  const weekStart = weekStartFor(new Date());
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 3_600_000);

  const early = { start: new Date(weekStart.getTime() - 5 * 3_600_000), durationHours: 4 };
  const late = { start: new Date(weekEnd.getTime() + 5 * 3_600_000), durationHours: 4 };

  const clampedEarly = clampPlannerWindow(early, weekStart, windowConfig);
  const clampedLate = clampPlannerWindow(late, weekStart, windowConfig);

  assert.equal(clampedEarly.start.getTime(), weekStart.getTime());
  assert.equal(clampedLate.start.getTime(), weekEnd.getTime());
});

test("clampPlannerWindow: does not mutate its input window object", () => {
  const weekStart = weekStartFor(new Date());
  const original = { start: new Date(weekStart.getTime() - 5 * 3_600_000), durationHours: 0.1, id: "p1" };
  const originalStartMs = original.start.getTime();
  const originalDuration = original.durationHours;
  const clamped = clampPlannerWindow(original, weekStart, windowConfig);
  assert.equal(original.start.getTime(), originalStartMs, "input start Date must be untouched");
  assert.equal(original.durationHours, originalDuration, "input durationHours must be untouched");
  assert.notEqual(clamped, original, "must return a new object");
  assert.equal(clamped.id, "p1", "other fields carried through");
});

test("clampPlannerWindow: missing config falls back to plannerPick defaults, never throws", () => {
  const weekStart = weekStartFor(new Date());
  const pick = { start: new Date(weekStart.getTime() + 3_600_000), durationHours: 100 };
  assert.doesNotThrow(() => clampPlannerWindow(pick, weekStart, null));
  const clamped = clampPlannerWindow(pick, weekStart, null);
  assert.equal(clamped.durationHours, 12);
});

// ---- 6. ghostWindowsFor ----------------------------------------------------------------------

test("ghostWindowsFor: returns 3 windows, each carrying ghost:true, matching candidateWindows()'s own output", () => {
  const fromDate = new Date(2026, 6, 15, 9, 0, 0);
  const ghosts = ghostWindowsFor(windowConfig, fromDate);
  const raw = candidateWindows(windowConfig, fromDate);
  assert.equal(ghosts.length, 3);
  ghosts.forEach((g, i) => {
    assert.equal(g.ghost, true);
    assert.equal(g.id, raw[i].id);
    assert.equal(g.start.getTime(), raw[i].start.getTime());
    assert.equal(g.durationHours, raw[i].durationHours);
  });
});
