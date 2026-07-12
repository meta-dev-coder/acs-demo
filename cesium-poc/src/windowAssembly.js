/*---------------------------------------------------------------------------------------------
 * windowAssembly.js — UC1 P4-b: the first real integration of P2-a (demand.js) and P2-b
 * (windowEval.js), per design spec §4 bullet 3 ("Window panel") + §3's integration note. Pure
 * logic only — no DOM/Cesium imports, importable in plain Node (node --test). windowPanel.js (DOM)
 * consumes this module's output; it never computes scores itself.
 *
 *   - windowDemandAdapter(demandModel): adapts createDemandModel()'s getWindowDemand(segmentId,
 *     startDate, durationHours) -> vph[] to windowEval.js's demandFn(segmentId, window) -> vph[]
 *     contract (window = { start, durationHours }). windowEval.js intentionally never imports
 *     demand.js directly (see windowEval.js's header) — this adapter is the seam. It also
 *     reconciles a time-convention mismatch between the two already-committed P2 modules:
 *     candidateWindows() (windowEval.js) anchors its "23:00 / 07:00 / 14:00" heuristics to the
 *     HOST's LOCAL wall clock (Date#setHours/getDay), while demand.js's curve deliberately reads
 *     the UTC hour-of-day (its own header: "keeps demo results host-timezone-independent" for its
 *     own unit tests). Left alone, that mismatch means "overnight 23:00" can land on any UTC hour
 *     depending on where the demo runs, silently breaking the demand curve's day/night shape.
 *     windowEval.js's own docstring hands this reconciliation to whoever wires demand.js in
 *     ("adapt the caller ... not this module's math") — so the adapter reinterprets window.start's
 *     LOCAL calendar fields as the UTC instant demand.js should read, making both modules agree on
 *     one wall clock regardless of host timezone.
 *   - evaluateCandidates(wo, {segments, incidents, windowConfig, demandModel, fromDate,
 *     closureSpec}) -> { windows[3], results[3], winnerIdx }: resolves the picked work order's
 *     segment (wo.segment is a segment NAME, e.g. "East Segment" — openWorkOrders()'s shape,
 *     uc1Data.js), builds the 3 system-suggested candidateWindows(), evaluates each with
 *     createWindowEvaluator(), and returns them in CANDIDATE order (not score-sorted — windowPanel
 *     renders its own ranked view) plus the index of the lowest-scoring (best) window. A work
 *     order whose segment name doesn't resolve against segments.json still evaluates (segmentId
 *     null -> corridor-wide closure-rate fallback in windowEval.js), matching the
 *     keep-going-on-partial-data posture used throughout uc1Data.js.
 *--------------------------------------------------------------------------------------------*/
import { createWindowEvaluator, candidateWindows } from "./windowEval.js";

/** Resolve a segment NAME (as carried on an openWorkOrders() row's `segment` field) to its
 * segments.json entry. Returns null when unresolved (unknown/missing name) — callers must not
 * throw on that, matching the rest of the UC1 pure modules. */
function resolveSegmentByName(segments, segmentName) {
  if (segmentName == null) return null;
  return (segments || []).find((s) => s.name === segmentName) ?? null;
}

/** Reinterpret a Date's LOCAL calendar fields (year/month/day/hour/minute/second/ms) as a UTC
 * instant — see this module's header for why. Pure calendar-field copy, no arithmetic on the
 * original instant. */
function localWallClockAsUtc(date) {
  return new Date(
    Date.UTC(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
      date.getMilliseconds()
    )
  );
}

/**
 * windowDemandAdapter(demandModel) -> demandFn(segmentId, window) -> vph[]
 *
 * Adapts createDemandModel()'s getWindowDemand(segmentId, startDate, durationHours) to the shape
 * createWindowEvaluator() expects. A thin wrapper, not a re-implementation — demand.js remains the
 * only place slice math for the demand curve lives. See the module header for why window.start is
 * reinterpreted via localWallClockAsUtc() before being handed to demand.js.
 */
export function windowDemandAdapter(demandModel) {
  return function demandFn(segmentId, window) {
    return demandModel.getWindowDemand(segmentId, localWallClockAsUtc(window.start), window.durationHours);
  };
}

/**
 * evaluateCandidates(wo, opts) -> { windows[3], results[3], winnerIdx }
 *
 * opts:
 *   segments     — segments.json array (or fixture with the same shape).
 *   incidents    — Incidents_V3-shaped rows, passed straight through to windowEval.js's E(w).
 *   windowConfig — config/windowConfig.json (or a live-edited clone — the assumptions-tab slider
 *                  path from spec §4, P5).
 *   demandModel  — createDemandModel() instance (src/demand.js).
 *   fromDate     — optional; forwarded to candidateWindows() (defaults to "now" there).
 *   closureSpec  — optional overrides merged over the default { lanesClosed: 1 } (one lane closed
 *                  is UC1's standard demo closure spec; totalLanes/openLanes/tollRateUsd/
 *                  crewCostUsd all fall back to segment/config defaults inside windowEval.js).
 *
 * `windows` and `results` are positionally aligned and stay in candidateWindows()'s own order
 * (overnight, weekendMorning, weekdayPm) — NOT score-sorted, so a caller/renderer can label rows
 * by heuristic identity as well as by rank. `winnerIdx` is the index of the lowest-scoring
 * (best) window in that same order.
 */
export function evaluateCandidates(
  wo,
  { segments = [], incidents = [], windowConfig, demandModel, fromDate, closureSpec } = {}
) {
  const segment = resolveSegmentByName(segments, wo?.segment);
  const segmentId = segment?.id ?? null;

  const evaluator = createWindowEvaluator({
    config: windowConfig,
    segments,
    incidents,
    demandFn: windowDemandAdapter(demandModel),
  });

  const windows = candidateWindows(windowConfig, fromDate);
  const spec = { lanesClosed: 1, ...closureSpec };
  const results = windows.map((window) => evaluator.evaluateWindow(segmentId, spec, window));

  let winnerIdx = 0;
  for (let i = 1; i < results.length; i++) {
    if (results[i].score < results[winnerIdx].score) winnerIdx = i;
  }

  return { windows, results, winnerIdx };
}

/**
 * throughputVsDemandPct(result) -> 0-100
 *
 * Share of arriving demand actually served (departed) during the window, derived from the
 * per-slice `arrivals`/`departures` rilcaSliceQueue() already computes (see evaluateWindow()'s
 * `queue.slices`). 100% when there's no demand to serve (nothing withheld). windowPanel.js's
 * "throughput vs demand" column reads this — kept here (not inline in the DOM module) so it's
 * unit-testable and reusable by any future consumer of an evaluateWindow() result.
 */
export function throughputVsDemandPct(result) {
  const slices = result?.queue?.slices || [];
  let totalArrivals = 0;
  let totalDepartures = 0;
  for (const s of slices) {
    totalArrivals += s.arrivals ?? 0;
    totalDepartures += s.departures ?? 0;
  }
  if (totalArrivals <= 0) return 100;
  return (totalDepartures / totalArrivals) * 100;
}

/**
 * buildSumoPlaybackPlan(windows, opts) -> flat step list, 3 steps per window (closeLane, watch,
 * openLane), in window order. UC1 deck-parity item 1 ("per-window SUMO playback"): live_server.py
 * only has a single shared SIM, so the 3 candidate windows can only be shown one at a time — this
 * sequences that, it does not attempt simultaneous per-window physics runs (see the plan's
 * deferred-list note on that scope boundary).
 *
 * opts:
 *   lane            — the AP lane id to close/open (forwarded, not validated here).
 *   watchMsPerWindow — how long the "watch" step dwells before moving to openLane (ms). Defaults 8000.
 *   offsetFt/speedMph — forwarded onto the closeLane step for the caller's cone/geometry placement.
 */
export function buildSumoPlaybackPlan(windows, { lane, watchMsPerWindow = 8000, offsetFt = 12, speedMph = 60 } = {}) {
  const plan = [];
  for (const window of windows || []) {
    plan.push({ kind: "closeLane", window, lane, offsetFt, speedMph });
    plan.push({ kind: "watch", window, lane, durationMs: watchMsPerWindow });
    plan.push({ kind: "openLane", window, lane });
  }
  return plan;
}
