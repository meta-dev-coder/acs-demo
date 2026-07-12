/*---------------------------------------------------------------------------------------------
 * windowEval.js — UC1 P2-b: the lane-closure window evaluator (design spec §3, "core engine").
 * Pure logic only — no DOM/Cesium/React imports, config-driven (config/windowConfig.json),
 * importable in plain Node (node --test).
 *
 * Contract note (decoupled from P2-a by task instruction — do NOT import demand.js here):
 *   demandFn(segmentId, window) -> number[]
 *   Returns one vph value per 15-minute slice spanning `window` (length =
 *   window.durationHours / (config.sliceMinutes/60)), in chronological order. This mirrors the
 *   planned P2-a `getWindowDemand` shape; if P2-a lands with a different signature, adapt the
 *   caller that wires demand.js into createWindowEvaluator(), not this module's math.
 *
 * Math (spec §3, review-fixed):
 *   - C_closed = workZoneCapacityVphpl * openLanes * mergeFriction              (closedCapacityVph)
 *   - RILCA queue: 15-min slice-wise deterministic-queueing accumulation, queue carries over
 *     between slices (piecewise-constant demand, not one aggregate call). Ported from the
 *     shape of sumo/kpi.py's workzone_queue() — slice-summed here so demand can vary per slice.
 *     On constant demand for an entire window this reduces exactly to kpi.py's closed-form
 *     triangle-area result (see tests/windowEval.test.mjs).                      (rilcaSliceQueue)
 *   - R(w) revenue-at-risk = Σ slices [demand above C_closed] * sliceHours * tollRate, ±
 *     config.revenueUncertaintyBand.                                              (revenueAtRisk)
 *   - E(w) secondary-collision exposure blends the segment's own closure-incident rate with the
 *     corridor-wide rate (over ALL incident rows, including the ~90 that carry neither Segment
 *     nor coords — spec's coverage-fix requirement), weighted by segment sample size via
 *     shrinkage weight n/(n+k). n=0 (no segment data) falls back to the corridor rate exactly.
 *                                                          (closureIncidentStats / blendedClosureRate)
 *   - Score(w) = w1*R̂ + w2*delay + w3*Ê + w4*crew, each term normalized against a config
 *     reference scale so the weighted sum is comparable across metrics of very different units.
 *     Lower score = better window (less revenue lost / delay / risk).                (scoreWindow)
 *--------------------------------------------------------------------------------------------*/

// ---- C_closed ----------------------------------------------------------------------------------

/** C_closed = 1600 vphpl (config workZoneCapacityVphpl) * open lanes * merge-friction factor. */
export function closedCapacityVph(config, openLanes) {
  const capacityVphpl = config?.workZoneCapacityVphpl ?? 1600;
  const mergeFriction = config?.mergeFriction ?? 0.9;
  return capacityVphpl * openLanes * mergeFriction;
}

// ---- RILCA slice-wise queue ---------------------------------------------------------------------

/**
 * 15-min slice-wise deterministic (RILCA-style) queue accumulation. Queue carries over between
 * slices: queueEnd_i = max(0, queueStart_i + arrivals_i - departureCapacity_i). Delay contributed
 * by a slice is the vehicle-hours under the (linear) queue-length curve for that slice —
 * trapezoidal, which is exact for a piecewise-linear queue and reduces to kpi.py's closed-form
 * triangle area when demand is constant for the whole window.
 *
 * demandsVph — array of per-slice arrival rates (vph), one per 15-min (or config) slice.
 * capacityVph — constant departure capacity for the window (C_closed).
 * sliceH — slice duration in hours (e.g. 0.25 for 15 min).
 */
export function rilcaSliceQueue(demandsVph, capacityVph, sliceH) {
  let queue = 0;
  let totalDelayVehHours = 0;
  let maxQueueVeh = 0;
  let totalArrivals = 0;
  const slices = [];

  for (const demandVph of demandsVph) {
    const arrivals = demandVph * sliceH;
    const capacityInSlice = capacityVph * sliceH;
    const queueStart = queue;
    const queueEnd = Math.max(0, queueStart + arrivals - capacityInSlice);
    const departures = queueStart + arrivals - queueEnd;
    const delayVehHours = ((queueStart + queueEnd) / 2) * sliceH;

    slices.push({ demandVph, arrivals, departures, queueStart, queueEnd, delayVehHours });

    totalArrivals += arrivals;
    totalDelayVehHours += delayVehHours;
    maxQueueVeh = Math.max(maxQueueVeh, queueEnd);
    queue = queueEnd;
  }

  const avgDelayMin = totalArrivals > 0 ? (totalDelayVehHours / totalArrivals) * 60 : 0;

  return { slices, maxQueueVeh, totalDelayVehHours, totalArrivals, avgDelayMin };
}

// ---- E(w): segment/corridor closure-incident rate blend -----------------------------------------

function isClosureYes(v) {
  return /^y(es)?$/i.test(String(v ?? "").trim());
}

/**
 * rate = COUNT(lane_closure_y_n is Yes) / SUM(lane_closure_duration_hours), over `rows` as given
 * by the caller (already scoped to a segment, or to the whole corridor).
 */
export function closureIncidentStats(rows) {
  let closures = 0;
  let totalHours = 0;
  for (const r of rows || []) {
    if (isClosureYes(r?.lane_closure_y_n)) closures += 1;
    const h = Number(r?.lane_closure_duration_hours);
    if (Number.isFinite(h)) totalHours += h;
  }
  const rate = totalHours > 0 ? closures / totalHours : 0;
  return { closures, totalHours, rate, sampleSize: (rows || []).length };
}

/**
 * Blend the segment-specific closure-incident rate with the corridor-wide rate (computed over
 * ALL incident rows, including the ~90 with neither Segment nor coords — spec's coverage fix).
 * Blend weight = segment sample size via shrinkage: weight = n/(n+k). n=0 -> weight=0 -> rate
 * falls back to the corridor rate exactly.
 */
export function blendedClosureRate(incidents, segmentName, segmentBlendK = 5) {
  const rows = incidents || [];
  const segmentRows = segmentName == null ? [] : rows.filter((r) => r?.Segment === segmentName);
  const segStats = closureIncidentStats(segmentRows);
  const corridorStats = closureIncidentStats(rows); // ALL rows, incl. no-Segment ones

  const n = segStats.sampleSize;
  const k = segmentBlendK ?? 5;
  const weight = n + k > 0 ? n / (n + k) : 0;
  const rate = weight * segStats.rate + (1 - weight) * corridorStats.rate;

  return {
    rate,
    segmentRate: segStats.rate,
    corridorRate: corridorStats.rate,
    weight,
    segmentSampleSize: n,
    corridorSampleSize: corridorStats.sampleSize,
  };
}

/**
 * E(w) = blended closure-incident rate (per hour of closure) * window duration (hours) *
 * (vehicle exposure in the window / a config "typical exposure" normalizer). Vehicle exposure is
 * the total vehicle count traveling the segment during the window (Σ demand_i * sliceH).
 */
export function secondaryCrashExposure(config, blended, durationHours, vehicleExposureVeh) {
  const normalizerVeh = config?.crashExposure?.normalizerVeh ?? 5000;
  if (normalizerVeh <= 0) return 0;
  return blended.rate * durationHours * (vehicleExposureVeh / normalizerVeh);
}

// ---- R(w): revenue-at-risk ------------------------------------------------------------------------

/**
 * R(w) = Σ slices [demand above C_closed] * sliceHours * tollRate, ± config uncertainty band.
 * slices only needs a `demandVph` field per entry (rilcaSliceQueue's slices satisfy this).
 */
export function revenueAtRisk(config, slices, sliceH, capacityVph, tollRateUsd) {
  let excessVehicles = 0;
  const perSlice = [];
  for (const s of slices) {
    const sliceExcessVehicles = Math.max(0, s.demandVph - capacityVph) * sliceH;
    excessVehicles += sliceExcessVehicles;
    perSlice.push({ excessVehicles: sliceExcessVehicles, revenueUsd: sliceExcessVehicles * tollRateUsd });
  }
  const point = excessVehicles * tollRateUsd;
  const band = config?.revenueUncertaintyBand ?? 0.15;
  return {
    point,
    low: point * (1 - band),
    high: point * (1 + band),
    band,
    perSlice,
  };
}

// ---- buildWindowTimeseries: per-slice playback data ------------------------------------------

/**
 * buildWindowTimeseries(rilcaSlices, revenuePerSlice) -> one row per slice, merging
 * rilcaSliceQueue()'s per-slice queue/delay shape with revenueAtRisk()'s perSlice revenue,
 * plus running cumulatives — exactly the shape a playback scrubber needs (queue level, revenue
 * lost so far, throughput served so far). Pure zip + running-sum, no new math: rilcaSlices and
 * revenuePerSlice are already positionally aligned (both built from the same demand slices in
 * evaluateWindow()).
 */
export function buildWindowTimeseries(rilcaSlices, revenuePerSlice) {
  let cumulativeDelayVehHours = 0;
  let cumulativeRevenueUsd = 0;
  return (rilcaSlices || []).map((s, sliceIndex) => {
    const revenueUsd = revenuePerSlice?.[sliceIndex]?.revenueUsd ?? 0;
    cumulativeDelayVehHours += s.delayVehHours ?? 0;
    cumulativeRevenueUsd += revenueUsd;
    const arrivals = s.arrivals ?? 0;
    const departures = s.departures ?? 0;
    const throughputPct = arrivals > 0 ? (departures / arrivals) * 100 : 100;
    return {
      sliceIndex,
      demandVph: s.demandVph,
      arrivals,
      departures,
      queueVeh: s.queueEnd ?? 0,
      delayVehHours: s.delayVehHours ?? 0,
      cumulativeDelayVehHours,
      throughputPct,
      revenueUsd,
      cumulativeRevenueUsd,
    };
  });
}

// ---- lane availability ---------------------------------------------------------------------------

export function laneAvailabilityPct(openLanes, totalLanes) {
  if (!totalLanes || totalLanes <= 0) return 0;
  return (openLanes / totalLanes) * 100;
}

// ---- Score(w) ---------------------------------------------------------------------------------

/** Score(w) = w1*R̂ + w2*delay + w3*Ê + w4*crew, each normalized against a config reference scale. */
export function scoreWindow(config, { revenuePoint, delayMin, crashExposure, crewCostUsd }) {
  const norm = config?.scoreNormalization || {};
  const weights = config?.weights || {};

  const rNorm = revenuePoint / (norm.revenueRefUsd || 1);
  const dNorm = delayMin / (norm.delayRefMin || 1);
  const eNorm = crashExposure / (norm.exposureRef || 1);
  const cNorm = crewCostUsd / (norm.crewRefUsd || 1);

  const score =
    (weights.revenue ?? 0) * rNorm + (weights.delay ?? 0) * dNorm + (weights.safety ?? 0) * eNorm + (weights.crew ?? 0) * cNorm;

  return { score, components: { revenue: rNorm, delay: dNorm, safety: eNorm, crew: cNorm } };
}

// ---- candidateWindows: the 3 system-suggested heuristic windows -----------------------------------

function nextOccurrence(fromDate, hour, dowPredicate) {
  const d = new Date(fromDate.getTime());
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= fromDate.getTime()) d.setDate(d.getDate() + 1);
  let guard = 0;
  while (!dowPredicate(d.getDay()) && guard < 8) {
    d.setDate(d.getDate() + 1);
    guard += 1;
  }
  return d;
}

const isWeeknightOrWeekday = (dow) => dow >= 1 && dow <= 5; // Mon-Fri
const isWeekend = (dow) => dow === 0 || dow === 6; // Sat/Sun

/**
 * candidateWindows(config, fromDate) -> [overnight, weekendMorning, weekdayPm], each
 * { id, label, start: Date, durationHours }. Heuristic, config-driven (spec §3): next weeknight
 * 23:00, next weekend morning, next weekday 14:00 (the teaching-bad option).
 */
export function candidateWindows(config, fromDate = new Date()) {
  const heuristics = config?.candidateHeuristics || {};

  const build = (id, dowPredicate) => {
    const h = heuristics[id] || {};
    const hour = h.hour ?? 23;
    const durationHours = h.durationHours ?? 4;
    return {
      id,
      label: h.label || id,
      start: nextOccurrence(fromDate, hour, dowPredicate),
      durationHours,
    };
  };

  return [
    build("overnight", isWeeknightOrWeekday),
    build("weekendMorning", isWeekend),
    build("weekdayPm", isWeeknightOrWeekday),
  ];
}

// ---- createWindowEvaluator -----------------------------------------------------------------------

/**
 * createWindowEvaluator({config, segments, incidents, demandFn}) -> { evaluateWindow, rankWindows }
 *
 * segments — segments.json array [{id, name, laneCount, ...}].
 * incidents — Incidents_V3-shaped rows [{Segment, lane_closure_y_n, lane_closure_duration_hours, ...}].
 * demandFn — see the module docstring's contract note. Injected, never imported here.
 */
export function createWindowEvaluator({ config, segments, incidents, demandFn }) {
  function evaluateWindow(segmentId, closureSpec, window) {
    const segment = (segments || []).find((s) => s.id === segmentId) || null;
    const totalLanes = closureSpec?.totalLanes ?? segment?.laneCount ?? 1;
    const openLanes = closureSpec?.openLanes != null ? closureSpec.openLanes : Math.max(0, totalLanes - (closureSpec?.lanesClosed ?? 0));

    const demands = demandFn(segmentId, window) || [];
    const numSlices = demands.length || 1;
    // Self-correcting: sliceH derived from durationHours/numSlices so the math stays consistent
    // even if demandFn returns a different slice count than config.sliceMinutes implies.
    const sliceH = window.durationHours / numSlices;

    const capacityVph = closedCapacityVph(config, openLanes);
    const rilca = rilcaSliceQueue(demands, capacityVph, sliceH);

    const segmentName = segment?.name ?? null;
    const blended = blendedClosureRate(incidents, segmentName, config?.crashExposure?.segmentBlendK);
    const vehicleExposureVeh = rilca.totalArrivals;
    const crashExposure = secondaryCrashExposure(config, blended, window.durationHours, vehicleExposureVeh);

    const tollRateUsd = closureSpec?.tollRateUsd ?? config?.tollRateUsd ?? 0;
    const revenue = revenueAtRisk(config, rilca.slices, sliceH, capacityVph, tollRateUsd);

    const crewCostUsd = closureSpec?.crewCostUsd ?? config?.crewCostUsd ?? 0;
    const scored = scoreWindow(config, {
      revenuePoint: revenue.point,
      delayMin: rilca.avgDelayMin,
      crashExposure,
      crewCostUsd,
    });

    return {
      segmentId,
      segmentName,
      window: { start: window.start, durationHours: window.durationHours },
      closedCapacityVph: capacityVph,
      openLanes,
      totalLanes,
      laneAvailabilityPct: laneAvailabilityPct(openLanes, totalLanes),
      queue: {
        maxQueueVeh: rilca.maxQueueVeh,
        totalDelayVehHours: rilca.totalDelayVehHours,
        avgDelayMin: rilca.avgDelayMin,
        totalArrivals: rilca.totalArrivals,
        slices: rilca.slices,
      },
      revenueAtRiskUsd: revenue,
      secondaryCrashExposure: crashExposure,
      closureRate: blended,
      score: scored.score,
      scoreComponents: scored.components,
      timeseries: buildWindowTimeseries(rilca.slices, revenue.perSlice),
    };
  }

  function rankWindows(segmentId, closureSpec, windows) {
    const evaluated = windows.map((window) => ({ window, result: evaluateWindow(segmentId, closureSpec, window) }));
    const sorted = [...evaluated].sort((a, b) => a.result.score - b.result.score);
    return sorted.map((entry, idx) => ({
      ...entry.result,
      window: entry.window,
      rank: idx + 1,
      winner: idx === 0,
    }));
  }

  return { evaluateWindow, rankWindows };
}
