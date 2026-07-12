/*---------------------------------------------------------------------------------------------
 * windowPlayback.js — UC1 deck-parity item 1 (per-window SUMO playback), Phase 3 (UI). Pure
 * logic only — no DOM/Cesium imports (same split as windowEval.js / windowAssembly.js).
 *
 * computePlaybackFrame() is the scrubber's interpolation core: given an evaluateWindow() result
 * (Phase 2's result.timeseries — one row per 15-min slice, already carrying cumulative revenue/
 * delay/arrivals/departures) and a progress fraction in [0,1] across the whole window, it returns
 * the animated-counter state at that instant. It does NOT re-derive the math windowEval.js owns
 * (queue accumulation, revenue-at-risk) — it only interpolates between two already-computed
 * timeseries rows (the slice boundary before `progressFrac` and the one at/after it), exactly the
 * "one loop, two callers" discipline the rest of this codebase uses (see windowAssembly.js's
 * weekDemandSeries() for the same pattern applied to a different primitive).
 *
 * surrogatePlaybackDurationMs() / playbackModeLabel() are small config/copy helpers so
 * windowPanel.js's DOM layer never hardcodes the "live SUMO physics" vs. "surrogate playback"
 * distinction — see design directives: playback must always honestly label which one is running,
 * never conflate a plaza-wide live-SUMO stat with this module's analytic timeseries replay.
 *--------------------------------------------------------------------------------------------*/

/** Clamp a progress fraction to [0,1]; never throws, never returns NaN. */
export function clampProgress(frac) {
  if (typeof frac !== "number" || !Number.isFinite(frac)) return 0;
  if (frac < 0) return 0;
  if (frac > 1) return 1;
  return frac;
}

const ZERO_FRAME = {
  sliceIndex: 0,
  queueVeh: 0,
  avgDelayMinSoFar: 0,
  cumulativeRevenueLossUsd: 0,
  cumulativeArrivals: 0,
  cumulativeDepartures: 0,
};

/**
 * computePlaybackFrame(result, progressFrac) -> playback frame at that point in the window.
 *
 * Model: result.timeseries has n rows (one per slice), each already carrying THIS slice's
 * cumulative-through-end-of-slice values. Slice i occupies progress range [i/n, (i+1)/n). Within
 * a slice, values are linearly interpolated between the previous slice's end-state (or the
 * all-zero window-start state for slice 0) and this slice's own end-state — a piecewise-linear
 * reconstruction consistent with rilcaSliceQueue()'s own trapezoidal-delay assumption.
 */
export function computePlaybackFrame(result, progressFrac) {
  const frac = clampProgress(progressFrac);
  const timeseries = Array.isArray(result?.timeseries) ? result.timeseries : [];
  const n = timeseries.length;
  if (n === 0) return { ...ZERO_FRAME, progressPct: frac * 100 };

  const pos = frac * n; // continuous position across n slices, range [0, n]
  const sliceIndex = Math.min(n - 1, Math.floor(pos));
  const withinFrac = Math.min(1, Math.max(0, pos - sliceIndex));

  const entry = timeseries[sliceIndex];
  const prev = sliceIndex > 0 ? timeseries[sliceIndex - 1] : null;
  const prevQueue = prev?.queueVeh ?? 0;
  const prevCumRevenue = prev?.cumulativeRevenueUsd ?? 0;
  const prevCumDelay = prev?.cumulativeDelayVehHours ?? 0;

  // arrivals/departures are per-slice on each row, not cumulative — sum the completed slices,
  // then add this slice's in-progress fraction.
  let cumArrivalsBefore = 0;
  let cumDeparturesBefore = 0;
  for (let i = 0; i < sliceIndex; i += 1) {
    cumArrivalsBefore += timeseries[i]?.arrivals ?? 0;
    cumDeparturesBefore += timeseries[i]?.departures ?? 0;
  }

  const queueVeh = prevQueue + ((entry.queueVeh ?? 0) - prevQueue) * withinFrac;
  const cumulativeRevenueLossUsd = prevCumRevenue + ((entry.cumulativeRevenueUsd ?? 0) - prevCumRevenue) * withinFrac;
  const cumulativeDelayVehHours = prevCumDelay + ((entry.cumulativeDelayVehHours ?? 0) - prevCumDelay) * withinFrac;
  const cumulativeArrivals = cumArrivalsBefore + (entry.arrivals ?? 0) * withinFrac;
  const cumulativeDepartures = cumDeparturesBefore + (entry.departures ?? 0) * withinFrac;
  const avgDelayMinSoFar = cumulativeArrivals > 0 ? (cumulativeDelayVehHours / cumulativeArrivals) * 60 : 0;

  return {
    sliceIndex,
    queueVeh,
    avgDelayMinSoFar,
    cumulativeRevenueLossUsd,
    cumulativeArrivals,
    cumulativeDepartures,
    progressPct: frac * 100,
  };
}

/** config.playback.surrogateTotalMs (Phase 3's block, additive to Phase 2's watchMsPerWindow),
 * defaulting to 8000ms — same default as watchMsPerWindow so live/surrogate feel comparable in
 * demo pacing even when only one of the two is actually driving the clock. */
export function surrogatePlaybackDurationMs(config) {
  const ms = config?.playback?.surrogateTotalMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 8000;
}

/**
 * playbackModeLabel(isLiveConnected) -> honest badge copy distinguishing the two playback
 * sources (design directives: never let "live SUMO" and "surrogate/offline analytic replay"
 * blur together — the engine plan's same honesty finding that stats.cumulativeRevenue is a
 * plaza-wide number, never result.revenueAtRiskUsd).
 */
export function playbackModeLabel(isLiveConnected) {
  if (isLiveConnected) {
    return { mode: "live", label: "Live SUMO physics (generic plaza demo)" };
  }
  return { mode: "surrogate", label: "Surrogate playback — offline analytic replay" };
}
