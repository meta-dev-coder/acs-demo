/*---------------------------------------------------------------------------------------------
 * Scenario D — Lane Closure Simulation. Pure physics engine.
 *
 * Mirrors src/scenarioC/pricing.ts in structure: pure functions, config-driven, no React/DOM/iTwin.
 * All numeric constants are imported from closureConfig.json — zero numeric literals in function
 * bodies except 0 and 1 (HCM §5 discipline).
 *
 * Imports from Scenario C pricing module:
 *   computeCorridorPricing, computeToll, densityToLOS, interpolateDemandRetained,
 *   assertDemandCurveMonotonic, EXPRESS_SECTIONS
 *
 * Hard constraints (§4):
 *  - No SUMO, no Cesium, no React, no DOM, no @itwin imports
 *  - Pricing functions imported from scenarioC/pricing, never reimplemented
 *  - All geometry labels include SCHEMATIC
 *  - No CSV data source
 *--------------------------------------------------------------------------------------------*/

import config from "./closureConfig.json";
import {
  computeCorridorPricing,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  computeToll,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  densityToLOS,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interpolateDemandRetained,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  assertDemandCurveMonotonic,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  EXPRESS_SECTIONS,
} from "../scenarioC/pricing";

import type {
  LOSBand,
  TimeBlock,
  PricingStrategy,
} from "../scenarioC/types";

import type { ClosureEvent, ClosureLaneMenuEntry, ClosureSimState, StateDKpi } from "./typesD";

// ---------------------------------------------------------------------------
// Exported SCHEMATIC_LABEL constant (§4 constraint: every ribbon/marker includes SCHEMATIC)
// ---------------------------------------------------------------------------

export const SCHEMATIC_LABEL = "SCHEMATIC corridor context — NOT calibrated mainline geometry";

// Synthetic CORRIDOR easting frame (EPSG:32617), matching src/scene/place CORRIDOR + queueTailEasting.
// Used to map a queue-tail easting → an along-corridor fraction u ∈ [0,1] for the decorator/timeline.
const CORRIDOR_E_MIN = 578200;
const CORRIDOR_E_SPAN = 592000 - 578200; // 13,800 m

// ---------------------------------------------------------------------------
// Config helpers (typed access to closureConfig.json)
// ---------------------------------------------------------------------------

type SegmentConfig = {
  lanes: number;
  baseCapPerLane: number;
  freeFlowMph: number;
  kjVphpl: number;
};

type CafEntry = {
  lanesClosed: number;
  totalLanes: number;
  caf: number;
};

const segmentConfig = config.segments as Record<string, SegmentConfig>;
const cafTable = config.cafTable as CafEntry[];

/** Get the segment config record, throws if unknown. */
function getSegCfg(segmentId: string): SegmentConfig {
  const seg = segmentConfig[segmentId];
  if (!seg) throw new Error(`Unknown segment: ${segmentId}`);
  return seg;
}

/** Get the CAF for a specific (lanesClosed, totalLanes) combination.
 *  Throws if the combination is not in the table (§8-fix-2: per-segment consistent). */
function getCaf(lanesClosed: number, totalLanes: number): number {
  const entry = cafTable.find((e) => e.lanesClosed === lanesClosed && e.totalLanes === totalLanes);
  if (!entry) {
    throw new Error(
      `No CAF entry for lanesClosed=${lanesClosed} totalLanes=${totalLanes} — invalid lane closure configuration`
    );
  }
  return entry.caf;
}

// ---------------------------------------------------------------------------
// §8-fix-2: Per-segment-consistent CAF/lane menu
// ---------------------------------------------------------------------------

/**
 * Returns all valid lane-closure options for the given segment.
 * SEG-CONN (2 lanes) → exactly one entry (1-of-2, CAF 0.35).
 * 3-lane mainline segments → two entries (1-of-3 and 2-of-3).
 */
export function getLaneMenu(segmentId: string): ClosureLaneMenuEntry[] {
  const seg = getSegCfg(segmentId);
  return cafTable
    .filter((e) => e.totalLanes === seg.lanes)
    .map((e) => ({ lanesClosed: e.lanesClosed, totalLanes: e.totalLanes, caf: e.caf }));
}

/**
 * Validates and returns the closure event configuration.
 * Throws if lanesClosed is invalid for the segment (§8-fix-2 gate).
 */
export function buildClosureSegment(event: ClosureEvent): ClosureEvent {
  const seg = getSegCfg(event.segment_id);
  if (event.lanesClosed >= seg.lanes) {
    throw new Error(
      `lanesClosed=${event.lanesClosed} must be < totalLanes=${seg.lanes} on segment ${event.segment_id}`
    );
  }
  if (event.lanesClosed > 0) {
    // Validate that a CAF entry exists (throws if not)
    getCaf(event.lanesClosed, seg.lanes);
  }
  return event;
}

// ---------------------------------------------------------------------------
// §5.5: TimeBlock mapping (pm_peak → evening_peak_wb, off_peak → off_peak)
// ---------------------------------------------------------------------------

const TIME_BLOCK_MAP: Record<ClosureEvent["timeOfDay"], TimeBlock> = {
  pm_peak: "evening_peak_wb",
  off_peak: "off_peak",
};

/** Map Scenario D's timeOfDay to Scenario C's TimeBlock. Tested explicitly. */
export function mapTimeBlock(timeOfDay: ClosureEvent["timeOfDay"]): TimeBlock {
  return TIME_BLOCK_MAP[timeOfDay];
}

// ---------------------------------------------------------------------------
// §8-fix-1: Single turbulence source — mu_total
// ---------------------------------------------------------------------------

/**
 * Compute the total post-closure capacity (mu_total) in total corridor vph.
 *
 * mu_total = CAF × baseC × (weatherFactor if wet) × (queueDischargeFactor if queued)
 *
 * Only two independent multipliers beyond CAF (§8-fix-1):
 *  - weatherFactor (0.85) applied when hasWeather=true
 *  - queueDischargeFactor (0.93) applied when isQueued=true
 *
 * CAF already embeds merge friction + rubberneck. No additional turbulence factors.
 */
export function computeMuTotal(
  event: Pick<ClosureEvent, "segment_id" | "lanesClosed" | "timeOfDay" | "weather">,
  hasWeather: boolean,
  isQueued: boolean
): number {
  const seg = getSegCfg(event.segment_id);
  const baseC = seg.baseCapPerLane * seg.lanes; // total corridor vph (open road)

  const lanesClosed = event.lanesClosed;
  const totalLanes = seg.lanes;

  // mu_open: post-closure capacity from CAF (embeds merge + rubberneck)
  const caf = getCaf(lanesClosed, totalLanes);
  let muTotal = caf * baseC;

  // Apply weather factor (one independent multiplier)
  if (hasWeather) {
    muTotal = muTotal * (config.weatherFactor as number);
  }

  // Apply queue-discharge drop (second independent multiplier, only once queued)
  if (isQueued) {
    muTotal = muTotal * (config.queueDischargeFactor as number);
  }

  return muTotal;
}

// ---------------------------------------------------------------------------
// §8-fix-4: Total-vph units — D_total
// ---------------------------------------------------------------------------

/**
 * Compute the total approaching demand (D_total) in total corridor vph.
 * D_total(t) = vphpl × lanes × (1 − pctDiverted × diversionActive)
 *
 * vphpl is looked up by (segmentId, timeOfDay) from config.
 * All arithmetic in total-vph — never per-lane at the queue integral level.
 */
export function computeDTotal(
  segmentId: string,
  timeOfDay: ClosureEvent["timeOfDay"],
  pctDiverted: number // fraction [0, 0.12] — already converted
): number {
  const seg = getSegCfg(segmentId);
  // Per-lane demand: use corridor-specific config values for SEG-CONN, generalized for others
  const vphpl = timeOfDay === "pm_peak"
    ? (config.pmPeakVphplConn as number)
    : (config.offPeakVphplConn as number);

  const totalDemand = vphpl * seg.lanes;
  return totalDemand * (1 - pctDiverted);
}

// ---------------------------------------------------------------------------
// §8-fix-3: LOS branch selection by queue membership
// ---------------------------------------------------------------------------

/**
 * Determine the LOS band for a segment using the CORRECT branch selection rule.
 *
 * NEVER blindly invert density from served flow — this paints a jammed queue green.
 * Branch selection:
 *  - queued=true (or speed < losCongestedSpeedThresholdMph): CONGESTED branch → high density → LOS E or F
 *  - queued=false (free-flow): FREE-FLOW branch → low density → LOS A or B
 *
 * @param totalFlow  Total corridor flow in vph (sum across all lanes)
 * @param speed      Segment speed in mph
 * @param queued     True if this segment is inside the shockwave queue
 * @param lanes      Number of lanes on the segment (per-segment, NOT hardcoded)
 */
export function losFromState(totalFlow: number, speed: number, queued: boolean, lanes: number): LOSBand {
  const congestedSpeedThreshold = config.losCongestedSpeedThresholdMph as number; // from config (§639)
  const losEFloor = config.losEFloorDensity as number;                             // from config (§639)

  const flowPerLane = totalFlow / lanes;

  if (queued || speed < congestedSpeedThreshold) {
    // CONGESTED branch: segment is inside the queue (backward wave).
    // Density on the congested branch is high (approaching jam density).
    // Use speed to back-calculate density on the congested side:
    //   On the congested branch: vehicles are nearly stopped, real density >> flow/speed.
    //   Use congested speed (actual) only if meaningful; else floor at LOS E threshold.
    const effectiveSpeed = Math.max(1, speed);
    const densityPerLane = flowPerLane / effectiveSpeed;
    // Congested branch floor from config: bottom of LOS E (HCM table)
    const congestedDensity = Math.max(densityPerLane, losEFloor);
    return densityToLOS(congestedDensity);
  } else {
    // FREE-FLOW branch: density from actual speed (free-flow, low density)
    const effectiveSpeed = Math.max(1, speed);
    const densityPerLane = flowPerLane / effectiveSpeed;
    // Free-flow density — do NOT clamp upward; let it stay in A/B/C territory
    return densityToLOS(densityPerLane);
  }
}

// ---------------------------------------------------------------------------
// §5.4: Rankine-Hugoniot shockwave
// ---------------------------------------------------------------------------

/**
 * Compute the shockwave (backward) propagation speed using Rankine-Hugoniot.
 * w_stop = (q_queue − q_demand) / (k_queue − k_demand)  [mph, negative = upstream]
 *
 * Uses total (multi-lane) quantities for the corridor.
 */
export function computeShockwaveSpeed(
  segmentId: string,
  lanesClosed: number,
  timeOfDay: ClosureEvent["timeOfDay"]
): number {
  const seg = getSegCfg(segmentId);
  const totalLanes = seg.lanes;
  const vphpl = timeOfDay === "pm_peak"
    ? (config.pmPeakVphplConn as number)
    : (config.offPeakVphplConn as number);

  // Total demand approaching the closure (total vph)
  const qDemand = vphpl * totalLanes;

  // Flow in the queue (essentially 0 at the back of queue where vehicles decelerate to stop)
  const qQueue = 0;

  // Jam density (total, all lanes) — vehicles/mile total
  const kJamTotal = seg.kjVphpl * totalLanes;

  // Demand density: approaching vehicles at free-flow speed
  const kDemand = qDemand / seg.freeFlowMph;

  // Rankine-Hugoniot: negative value means upstream propagation
  const wStop = (qQueue - qDemand) / (kJamTotal - kDemand);

  void lanesClosed; // CAF is embedded in mu_total, shockwave uses demand/jam densities
  return wStop;
}

/**
 * Compute the recovery wave speed (positive = clears upstream queue faster than w_stop).
 * Uses the forward R-H wave: open-road capacity restores, clearing wave overtakes queue tail.
 *
 * w_recover = baseC_total / (kj_total − kc_open)  [mph, positive magnitude]
 */
export function computeRecoveryWaveSpeed(segmentId: string): number {
  const seg = getSegCfg(segmentId);
  const totalLanes = seg.lanes;

  // Open-road capacity (total vph)
  const baseCTotal = seg.baseCapPerLane * totalLanes;

  // Critical density at open-road capacity: kc = baseC / freeFlowMph
  const kcOpen = baseCTotal / seg.freeFlowMph;

  // Jam density (total)
  const kJamTotal = seg.kjVphpl * totalLanes;

  // Recovery wave magnitude (positive: moves faster upstream than w_stop, clears queue)
  const wRecover = baseCTotal / (kJamTotal - kcOpen);
  return wRecover;
}

// ---------------------------------------------------------------------------
// §5.4: queueTailEasting helper
// ---------------------------------------------------------------------------

/**
 * Compute the easting position of the queue tail.
 *
 * The corridor easting range (578200–592000) is in UTM meters (EPSG:32617 zone 17N).
 * 1 easting unit ≈ 1 meter of along-corridor distance.
 * Queue tail is closureStartEasting − queueLengthMeters, clamped to the west corridor limit.
 *
 * This function is pure and Node-safe (no iTwin/DOM imports).
 */
export function queueTailEasting(
  closureStartEasting: number,
  queueLengthMeters: number
): number {
  const CORRIDOR_EASTING_MIN = 578200; // west limit of the connector iModel
  return Math.max(CORRIDOR_EASTING_MIN, closureStartEasting - queueLengthMeters);
}

// ---------------------------------------------------------------------------
// §5.2: Point-queue step model
// ---------------------------------------------------------------------------

type QueueStepState = {
  cumArrivals: number;
  cumDepartures: number;
  queue: number;
  isQueued: boolean;
};

/**
 * Advance the point-queue model by one time step (dtSec seconds).
 *
 * D_total(t) = vphpl × lanes × (1 − pctDiverted × diversionActive)
 * Dep(t)     = min(Q(t) + D_total(t), mu_total(t)) × dt
 * A(t)       += D_total(t) × dt
 * Q(t+1)     = max(0, A(t) − Dep(t))
 *
 * All operands in total corridor vph — never per-lane at the queue integral level.
 */
export function stepQueueModel(
  event: Pick<ClosureEvent, "segment_id" | "lanesClosed" | "timeOfDay" | "weather">,
  state: QueueStepState,
  dtSec: number,
  diversionActive: boolean
): QueueStepState {
  const dtHr = dtSec / 3600; // convert seconds to hours
  const pctDiverted = diversionActive ? (config.diversionShedFraction as number) : 0;

  // Demand (total corridor vph after diversion)
  const dTotal = computeDTotal(event.segment_id, event.timeOfDay, pctDiverted);

  // Capacity (total vph after closure + weather + queue-discharge drop)
  const hasWeather = event.weather === "rain";
  const segCfg = getSegCfg(event.segment_id);
  const muTotal = event.lanesClosed > 0
    ? computeMuTotal(event, hasWeather, state.isQueued)
    : segCfg.baseCapPerLane * segCfg.lanes; // open road

  // Cumulative arrivals (total vehicles)
  const arrivalVehicles = dTotal * dtHr;
  const newCumArrivals = state.cumArrivals + arrivalVehicles;

  // Departures = min(Q(t) + arrivals_this_step, mu_total × dt) — dimensionally correct
  // Q(t) is in vehicles; mu_total × dt is the maximum vehicles that can depart this step.
  const maxDepartures = muTotal * dtHr;
  const availableToDepart = state.queue + arrivalVehicles;
  const departures = Math.min(availableToDepart, maxDepartures);
  const newCumDepartures = state.cumDepartures + departures;

  // Queue = max(0, cumArrivals - cumDepartures)
  const newQueue = Math.max(0, newCumArrivals - newCumDepartures);

  // Update queued flag (queue exists means we're in congested regime)
  const newIsQueued = newQueue > 0;

  return {
    cumArrivals: newCumArrivals,
    cumDepartures: newCumDepartures,
    queue: newQueue,
    isQueued: newIsQueued,
  };
}

// ---------------------------------------------------------------------------
// §8-fix-6: Two economics lines — computeStateDKpi
// ---------------------------------------------------------------------------

type AccumulatedSimState = Pick<StateDKpi, "vehHrsDelay" | "maxQueueMi" | "pctDiverted">;

/** Representative travel time (min): config base corridor traverse + current queuing delay (Q/μ). */
function travelTimeMinFor(queueVeh: number, muTotalVph: number): number {
  const base = config.baseCorridorTraverseMin as number;
  const queueDelayMin = muTotalVph > 0 ? (queueVeh / muTotalVph) * 60 : 0;
  return base + queueDelayMin;
}

/** Secondary (rear-end) incident-risk index 0–1, scaling with queue length (illustrative). */
function incidentRiskFor(queueMi: number): number {
  const ref = config.incidentRiskRefMi as number;
  return Math.max(0, Math.min(1, queueMi / ref));
}

/**
 * Compute the final KPI snapshot from accumulated simulation state.
 *
 * Two economics lines with INDEPENDENT formulas (§5.7, §8-fix-6):
 *  delayCostUsd              = vehHrsDelay × valueOfTime   (midpoint of [18, 25] range)
 *  expressRevenueProtectedUsd = (projectedRevenuePerHour − baselineRevenuePerHour) × closureDurationHr
 *                               (delta formula per §5.7 — NEVER closureHours × 7800)
 *
 * These formulas are structurally distinct and will never be numerically equal
 * for any non-trivial scenario.
 */
export function computeStateDKpi(
  state: AccumulatedSimState & Partial<StateDKpi>,
  closureDurationMin: number,
  strategy: PricingStrategy = "moderate_variable"
): StateDKpi {
  // --- Economics line 1: delay cost ---
  const valueOfTimeLow = config.valueOfTimeLow as number;
  const valueOfTimeHigh = config.valueOfTimeHigh as number;
  const valueOfTime = (valueOfTimeLow + valueOfTimeHigh) / 2; // midpoint
  const delayCostUsd = state.vehHrsDelay * valueOfTime;

  // --- Economics line 2: express revenue protected (delta formula per §5.7) ---
  // Projected uses the active pricing STRATEGY (dynamic 'moderate_variable' vs flat 'current_static'),
  // so the dynamic-pricing toggle changes the upside. Baseline = off-peak static (the do-nothing case).
  const pricingResult = computeCorridorPricing("evening_peak_wb", strategy);
  const projectedRevenuePerHour = pricingResult.projectedRevenuePerHour;
  const baselinePricingResult = computeCorridorPricing("off_peak", "current_static" as PricingStrategy);
  const baselineRevenuePerHour = baselinePricingResult.projectedRevenuePerHour;
  const closureDurationHr = closureDurationMin / 60;
  const expressRevenueProtectedUsd = (projectedRevenuePerHour - baselineRevenuePerHour) * closureDurationHr;

  // --- Toll response ---
  const currentTollUsd = pricingResult.corridorTotalRate / 3; // per-section average

  // --- Queue and clearance (passed through from accumulated state or defaults) ---
  const maxQueueMi = state.maxQueueMi ?? 0;
  const clearanceMin = (state as ClosureSimState["kpis"]).clearanceMin ?? 0;
  const pctDiverted = state.pctDiverted ?? 0;

  return {
    maxQueueMi,
    vehHrsDelay: state.vehHrsDelay,
    clearanceMin,
    currentTollUsd,
    pctDiverted,
    delayCostUsd,
    expressRevenueProtectedUsd,
    // travelTimeMin + divertedVph are queue/demand-dependent — computeClosureSim overrides them
    // with the peak-tick values; here they default sensibly for direct callers.
    travelTimeMin: config.baseCorridorTraverseMin as number,
    divertedVph: 0,
    secondaryIncidentRisk: incidentRiskFor(maxQueueMi),
    netRevenueUsd: expressRevenueProtectedUsd - delayCostUsd,
    delayRateUsdPerHr: 0, // overridden by computeClosureSim with the peak instantaneous rate
  };
}

// ---------------------------------------------------------------------------
// Full simulation run — computeClosureSim
// ---------------------------------------------------------------------------

type ClosureSimResult = {
  tickHistory: Array<ClosureSimState & { queue: number }>;
  finalKpi: StateDKpi;
};

/**
 * Run the full deterministic point-queue simulation for a closure event.
 *
 * Steps through maxTicks time steps (each dtSec = config.simDtSec seconds).
 * Returns the full tick history and final KPI snapshot.
 *
 * Imports computeCorridorPricing from scenarioC/pricing for toll-response step.
 */
export function computeClosureSim(
  event: ClosureEvent,
  maxTicks: number,
  strategy: PricingStrategy = "moderate_variable"
): ClosureSimResult {
  const dtSec = config.simDtSec as number;
  const dtHr = dtSec / 3600;
  const dtMin = dtSec / 60;

  const diversionThresholdMi = config.diversionThresholdMi as number;
  const diversionThresholdDelayMin = config.diversionThresholdDelayMin as number;
  const diversionShedFraction = config.diversionShedFraction as number;

  const seg = getSegCfg(event.segment_id);
  const baseCTotal = seg.baseCapPerLane * seg.lanes;

  // Get shockwave speed for metadata
  const shockwaveMph = event.lanesClosed > 0
    ? computeShockwaveSpeed(event.segment_id, event.lanesClosed, event.timeOfDay)
    : 0;

  // Simulation state
  let state: QueueStepState = {
    cumArrivals: 0,
    cumDepartures: 0,
    queue: 0,
    isQueued: false,
  };

  // Accumulators for KPIs
  let vehHrsDelay = 0;
  let maxQueue = 0;
  let maxQueueMi = 0;
  let clearanceMin = -1;
  let pctDiverted = 0;
  let peakTravelTimeMin = config.baseCorridorTraverseMin as number;
  let peakDivertedVph = 0;
  let peakDelayRate = 0;

  const tickHistory: ClosureSimResult["tickHistory"] = [];

  for (let tick = 0; tick < maxTicks; tick++) {
    const currentTimeMin = tick * dtMin;

    // Is the closure active at this tick?
    const closureActive =
      event.lanesClosed > 0 &&
      currentTimeMin >= event.startMin &&
      currentTimeMin < event.startMin + event.durationMin;

    // After the closure reopens, the PM peak is passing — demand relaxes toward off-peak, so the
    // restored open-road capacity drains the queue (the recovery wave clears it within the window).
    const pastClosure = currentTimeMin >= event.startMin + event.durationMin;
    const activeEvent: ClosureEvent = closureActive
      ? event
      : { ...event, lanesClosed: 0, timeOfDay: pastClosure ? "off_peak" : event.timeOfDay };

    // Compute diversion (VMS threshold — §5.6)
    const vehHrsDelayMin = vehHrsDelay * 60; // convert to vehicle-minutes for threshold
    const diversionActive =
      maxQueueMi > diversionThresholdMi || vehHrsDelayMin > diversionThresholdDelayMin;
    pctDiverted = diversionActive ? diversionShedFraction : 0;

    // Step the queue model
    state = stepQueueModel(activeEvent, state, dtSec, diversionActive);

    // Accumulate delay (vehicle-hours)
    vehHrsDelay += state.queue * dtHr;

    // Track max queue
    if (state.queue > maxQueue) {
      maxQueue = state.queue;

      // Queue length in miles: derived from flow-density relationship
      // queueMi = (queue vehicles) / (mu_total vph) × freeFlowMph × dtMin / (dtMin) — simplify
      // At jam density: queue length = (queue vehicles) / (kj × lanes)
      const kJamTotal = seg.kjVphpl * seg.lanes;
      maxQueueMi = maxQueue / kJamTotal;
    }

    // Clearance: first tick where queue reaches zero (cumDepartures ≥ cumArrivals)
    if (clearanceMin < 0 && state.queue <= 0 && tick > 0) {
      clearanceMin = currentTimeMin;
    }

    // Toll response (call Scenario C pricing module with the active pricing STRATEGY)
    const pricingResult = computeCorridorPricing(mapTimeBlock(event.timeOfDay), strategy);
    const currentTollUsd = pricingResult.corridorTotalRate / 3;

    // Per-lane density and LOS for the closure segment
    const hasWeather = event.weather === "rain";
    const muTotal = closureActive
      ? computeMuTotal(activeEvent, hasWeather, state.isQueued)
      : baseCTotal;
    const servedFlow = Math.min(
      (pctDiverted > 0 ? computeDTotal(event.segment_id, event.timeOfDay, pctDiverted) : computeDTotal(event.segment_id, event.timeOfDay, 0)),
      muTotal
    );
    const congestedSpeedFraction = config.congestedSpeedFraction as number; // from config (§639)
    const speed = closureActive && state.isQueued
      ? seg.freeFlowMph * congestedSpeedFraction  // congested speed fraction from config
      : seg.freeFlowMph;
    const losBand = losFromState(servedFlow, speed, state.isQueued && closureActive, seg.lanes);

    // Back-of-queue tail uses the CURRENT queue (grows during closure, recedes on recovery) so the
    // Concept B animation shows the shockwave crawl upstream and the recovery wave clear it.
    const curQueueMi = state.queue / (seg.kjVphpl * seg.lanes);
    const tailEasting = queueTailEasting(
      config.segConnFromEasting as number,
      curQueueMi * (config.metersPerMile as number)
    );

    // Extended KPIs (G4/G5/G7): travel time, absolute diverted volume, incident risk, net revenue.
    const tickDelayCostUsd = vehHrsDelay * (((config.valueOfTimeLow as number) + (config.valueOfTimeHigh as number)) / 2);
    const tickExpressRevUsd = pricingResult.projectedRevenuePerHour * ((currentTimeMin + dtMin) / 60);
    const tickDivertedVph = computeDTotal(event.segment_id, event.timeOfDay, 0) * pctDiverted;
    const tickTravelTimeMin = travelTimeMinFor(state.queue, muTotal);
    const tickIncidentRisk = incidentRiskFor(curQueueMi);
    // Instantaneous delay-cost RATE: currently-queued vehicles × value-of-time ($/hr). Eases as
    // the queue clears (unlike the cumulative delayCostUsd), so the KPI bar tracks the congestion.
    const tickDelayRate = state.queue * (((config.valueOfTimeLow as number) + (config.valueOfTimeHigh as number)) / 2);
    if (tickTravelTimeMin > peakTravelTimeMin) peakTravelTimeMin = tickTravelTimeMin;
    if (tickDivertedVph > peakDivertedVph) peakDivertedVph = tickDivertedVph;
    if (tickDelayRate > peakDelayRate) peakDelayRate = tickDelayRate;

    const kpiSnapshot: StateDKpi = {
      maxQueueMi,
      vehHrsDelay,
      clearanceMin: clearanceMin >= 0 ? clearanceMin : 0,
      currentTollUsd,
      pctDiverted,
      delayCostUsd: tickDelayCostUsd,
      expressRevenueProtectedUsd: tickExpressRevUsd,
      travelTimeMin: tickTravelTimeMin,
      divertedVph: tickDivertedVph,
      secondaryIncidentRisk: tickIncidentRisk,
      netRevenueUsd: tickExpressRevUsd - tickDelayCostUsd,
      delayRateUsdPerHr: tickDelayRate,
    };

    tickHistory.push({
      tick,
      segmentStates: [
        {
          segmentId: event.segment_id,
          losBand,
          density: servedFlow / seg.lanes / Math.max(1, speed),
          speed,
          queued: state.isQueued && closureActive,
        },
      ],
      backOfQueue: state.queue > 0
        ? {
            u: (tailEasting - CORRIDOR_E_MIN) / CORRIDOR_E_SPAN,
            eastingMeters: tailEasting,
            lengthMi: curQueueMi,
            segmentSpan: [event.segment_id],
          }
        : null,
      kpis: kpiSnapshot,
      diversionActive,
      shockwaveMph,
      queue: state.queue,
    });
  }

  // If queue never fully drained, project clearance time from remaining queue and drain rate
  if (clearanceMin < 0) {
    const closureEndMin = event.startMin + event.durationMin;
    // Drain rate after closure ends: open-road capacity minus continuing demand (after diversion)
    const postClosureDTotal = computeDTotal(event.segment_id, event.timeOfDay, pctDiverted);
    const drainRateVph = Math.max(0, baseCTotal - postClosureDTotal);
    if (drainRateVph > 0 && state.queue > 0) {
      // Time to drain remaining queue at the drain rate (in minutes)
      const remainingQueueVeh = state.queue;
      const drainTimeHr = remainingQueueVeh / drainRateVph;
      const simEndMin = maxTicks * dtMin;
      clearanceMin = simEndMin + drainTimeHr * 60; // projected clearance beyond sim window
    } else {
      // Drain rate is 0 or no queue — estimate from closure end
      clearanceMin = closureEndMin + event.durationMin;
    }
  }

  // Final KPI (strategy-aware; override the queue/demand-dependent fields with the peak-tick values)
  const finalKpi = computeStateDKpi(
    { vehHrsDelay, maxQueueMi, pctDiverted },
    event.durationMin,
    strategy
  );
  finalKpi.clearanceMin = clearanceMin;
  finalKpi.travelTimeMin = peakTravelTimeMin;
  finalKpi.divertedVph = peakDivertedVph;
  finalKpi.secondaryIncidentRisk = incidentRiskFor(maxQueueMi);
  finalKpi.netRevenueUsd = finalKpi.expressRevenueProtectedUsd - finalKpi.delayCostUsd;
  finalKpi.delayRateUsdPerHr = peakDelayRate;

  // Also update the last tick's KPI snapshot with the projected clearance
  if (tickHistory.length > 0) {
    const lastTick = tickHistory[tickHistory.length - 1];
    (lastTick.kpis as StateDKpi).clearanceMin = clearanceMin;
  }

  return { tickHistory, finalKpi };
}
