/*---------------------------------------------------------------------------------------------
 * windowPlayback.test.mjs — UC1 deck-parity item 1 (per-window SUMO playback), Phase 3 (UI).
 * Pure-logic tests for windowPlayback.js: computePlaybackFrame() interpolates within
 * evaluateWindow()'s result.timeseries (Phase 2), surrogatePlaybackDurationMs()/
 * playbackModeLabel()/clampProgress() are small config/label helpers. No DOM here — DOM is
 * e2e-covered per repo convention (see windowPanel.test.mjs's own header).
 *--------------------------------------------------------------------------------------------*/
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computePlaybackFrame,
  surrogatePlaybackDurationMs,
  playbackModeLabel,
  clampProgress,
} from "../src/windowPlayback.js";
import { createWindowEvaluator, candidateWindows } from "../src/windowEval.js";
import windowConfig from "../config/windowConfig.json" with { type: "json" };
import segments from "../config/segments.json" with { type: "json" };

// A real evaluateWindow() result (Phase 2's result.timeseries), not a hand-rolled fixture, so
// these tests exercise the actual shape computePlaybackFrame() will see in production.
function realResult() {
  const demandFn = (segmentId, window) => {
    const numSlices = Math.round((window.durationHours * 60) / windowConfig.sliceMinutes);
    // Deliberately non-flat demand so cumulative/queue values are non-trivial across slices.
    return Array.from({ length: numSlices }, (_, i) => 1400 + i * 120);
  };
  const evaluator = createWindowEvaluator({ config: windowConfig, segments, incidents: [], demandFn });
  const [window] = candidateWindows(windowConfig, new Date("2026-07-13T10:00:00"));
  const segmentId = segments[0].id;
  return { window, result: evaluator.evaluateWindow(segmentId, { lanesClosed: 1 }, window) };
}

test("computePlaybackFrame: at progressFrac 0, sliceIndex 0 and zero cumulative revenue/queue", () => {
  const { result } = realResult();
  const frame = computePlaybackFrame(result, 0);
  assert.equal(frame.sliceIndex, 0);
  assert.equal(frame.queueVeh, 0);
  assert.equal(frame.cumulativeRevenueLossUsd, 0);
  assert.equal(frame.cumulativeArrivals, 0);
  assert.equal(frame.cumulativeDepartures, 0);
  assert.equal(frame.progressPct, 0);
});

test("computePlaybackFrame: at progressFrac 1, cumulative values match timeseries's last row", () => {
  const { result } = realResult();
  const last = result.timeseries[result.timeseries.length - 1];
  const frame = computePlaybackFrame(result, 1);
  assert.equal(frame.sliceIndex, result.timeseries.length - 1);
  assert.ok(Math.abs(frame.cumulativeRevenueLossUsd - last.cumulativeRevenueUsd) < 1e-9);
  assert.ok(Math.abs(frame.queueVeh - last.queueVeh) < 1e-9);
  // last row's cumulative revenue must itself reconcile with revenueAtRiskUsd.point (Phase 2 test 7).
  assert.ok(Math.abs(last.cumulativeRevenueUsd - result.revenueAtRiskUsd.point) < 1e-6);
  assert.equal(frame.progressPct, 100);
});

test("computePlaybackFrame: midpoint of a single timeseries entry interpolates linearly", () => {
  const { result } = realResult();
  const n = result.timeseries.length;
  // Land exactly at the midpoint of slice 0: progressFrac = 0.5/n.
  const frame = computePlaybackFrame(result, 0.5 / n);
  const entry0 = result.timeseries[0];
  assert.equal(frame.sliceIndex, 0);
  assert.ok(Math.abs(frame.cumulativeRevenueLossUsd - entry0.cumulativeRevenueUsd * 0.5) < 1e-9);
  assert.ok(Math.abs(frame.queueVeh - entry0.queueVeh * 0.5) < 1e-9);
});

test("computePlaybackFrame: progressFrac spanning multiple entries lands in the correct sliceIndex", () => {
  const { result } = realResult();
  const n = result.timeseries.length;
  assert.ok(n >= 4, "fixture must have >=4 slices for this test to be meaningful");
  const frame = computePlaybackFrame(result, 2.4 / n);
  assert.equal(frame.sliceIndex, 2);
});

test("computePlaybackFrame: a result with an empty timeseries does not throw, returns a zeroed frame", () => {
  const frame = computePlaybackFrame({ timeseries: [] }, 0.5);
  assert.equal(frame.sliceIndex, 0);
  assert.equal(frame.queueVeh, 0);
  assert.equal(frame.cumulativeRevenueLossUsd, 0);
  assert.equal(frame.cumulativeArrivals, 0);
  assert.equal(frame.cumulativeDepartures, 0);

  const frameMalformed = computePlaybackFrame(null, 0.5);
  assert.equal(frameMalformed.sliceIndex, 0);
  assert.equal(frameMalformed.cumulativeRevenueLossUsd, 0);
});

test("surrogatePlaybackDurationMs: reads config.playback.surrogateTotalMs; defaults to 8000 when missing", () => {
  assert.equal(surrogatePlaybackDurationMs(windowConfig), windowConfig.playback.surrogateTotalMs);
  assert.equal(surrogatePlaybackDurationMs({}), 8000);
  assert.equal(surrogatePlaybackDurationMs(null), 8000);
  assert.equal(surrogatePlaybackDurationMs({ playback: {} }), 8000);
});

test("playbackModeLabel: true -> mode 'live', label mentions 'Live'", () => {
  const { mode, label } = playbackModeLabel(true);
  assert.equal(mode, "live");
  assert.ok(/live/i.test(label), `label should mention Live, got: ${label}`);
});

test("playbackModeLabel: false -> mode 'surrogate', label mentions 'Surrogate' and 'offline'", () => {
  const { mode, label } = playbackModeLabel(false);
  assert.equal(mode, "surrogate");
  assert.ok(/surrogate/i.test(label), `label should mention Surrogate, got: ${label}`);
  assert.ok(/offline/i.test(label), `label should mention offline, got: ${label}`);
});

test("clampProgress: clamps negative/>1/NaN inputs to [0,1] without throwing", () => {
  assert.equal(clampProgress(-5), 0);
  assert.equal(clampProgress(5), 1);
  assert.equal(clampProgress(NaN), 0);
  assert.equal(clampProgress(undefined), 0);
  assert.equal(clampProgress(0.42), 0.42);
  assert.equal(clampProgress(0), 0);
  assert.equal(clampProgress(1), 1);
});
