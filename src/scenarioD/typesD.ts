/*---------------------------------------------------------------------------------------------
 * Scenario D — Lane Closure Simulation. TypeScript types.
 *
 * Mirrors src/scenarioC/types.ts in structure.
 * Re-exports shared types from Scenario C — never duplicates them.
 *--------------------------------------------------------------------------------------------*/

// Re-export shared types from Scenario C (never duplicated in D)
export type {
  LOSBand,
  SectionPricingResult,
  CorridorPricingResult,
  TimeBlock,
  PricingStrategy,
  DemandCurvePoint,
} from "../scenarioC/types";

import type { LOSBand } from "../scenarioC/types";

/**
 * An operator-defined closure event — the primary input to Scenario D's physics engine.
 * Built through the UI form (ClosureEventBuilder); no CSV source for Scenario D.
 */
export interface ClosureEvent {
  /** Segment on which the closure occurs (e.g. "SEG-CONN"). */
  segment_id: string;
  /** Number of lanes closed. Must be < total lanes on the segment. */
  lanesClosed: number;
  /** Closure start time offset in minutes from simulation start. */
  startMin: number;
  /** Duration of the closure in minutes. */
  durationMin: number;
  /** Time-of-day period — maps to Scenario C TimeBlock for toll response. */
  timeOfDay: "pm_peak" | "off_peak";
  /** Optional weather condition (omitted = clear/dry). */
  weather?: "rain";
  /** Optional cause description (for display only; does not affect physics). */
  cause?: string;
}

/**
 * One entry in the CAF (Capacity Adjustment Factor) table for a given lane-closure scenario.
 * CAF embeds merge friction + rubberneck — no additional derate factors needed.
 */
export interface ClosureLaneMenuEntry {
  /** Number of lanes being closed. */
  lanesClosed: number;
  /** Total lanes on the segment. */
  totalLanes: number;
  /** HCM freeway incident CAF — multiply by base capacity to get open-capacity post-closure. */
  caf: number;
}

/**
 * Per-segment traffic simulation state at one tick.
 * LOS band is determined by branch selection (queued vs. free-flow), not blind density inversion.
 */
export interface SegmentSimState {
  segmentId: string;
  /** HCM LOS band A–F, selected by queue-membership branch (see §5.3). */
  losBand: LOSBand;
  /** Traffic density in veh/mi/ln (per-lane, for LOS coloring only). */
  density: number;
  /** Segment speed in mph. */
  speed: number;
  /** True when this segment is upstream of the bottleneck, inside the queue. */
  queued: boolean;
}

/**
 * Position and extent of the queue tail (back-of-queue) at one tick.
 * All positions use UTM easting meters (EPSG:32617 zone 17N).
 */
export interface BackOfQueue {
  /** Arc-length fraction along corridor centerline (0 = west end, 1 = east end). */
  u: number;
  /** Queue tail position in easting meters. */
  eastingMeters: number;
  /** Queue length in miles (derived from Rankine-Hugoniot wave speed). */
  lengthMi: number;
  /** Ordered list of segment IDs currently spanned by the queue. */
  segmentSpan: string[];
}

/**
 * KPI summary for one tick (or the final simulation run).
 * Two economics lines are always computed separately (§5.7):
 * - delayCostUsd = vehHrsDelay × valueOfTime
 * - expressRevenueProtectedUsd = pricing-module upside × closureDurationHr
 */
export interface StateDKpi {
  /** Maximum queue length across all ticks, in miles. */
  maxQueueMi: number;
  /** Total vehicle-hours of delay accumulated across all ticks. */
  vehHrsDelay: number;
  /** First tick (in minutes) where cumulative departures ≥ cumulative arrivals. */
  clearanceMin: number;
  /** Current express lane toll in USD (from Scenario C pricing module). */
  currentTollUsd: number;
  /** Fraction of mainline demand currently diverted to EB SR-84 (0 or 0.12). */
  pctDiverted: number;
  /** Delay cost in USD: vehHrsDelay × valueOfTime (independent formula). */
  delayCostUsd: number;
  /** Express revenue protected in USD (independent formula — never closureHours × 7800). */
  expressRevenueProtectedUsd: number;
}

/**
 * Full simulation state at one tick — the output unit of the physics engine.
 */
export interface ClosureSimState {
  /** Current simulation tick (0-indexed). */
  tick: number;
  /** Traffic state for each simulated segment. */
  segmentStates: SegmentSimState[];
  /** Queue tail position and extent (null when no queue exists). */
  backOfQueue: BackOfQueue | null;
  /** KPI snapshot at this tick. */
  kpis: StateDKpi;
  /** True when VMS diversion threshold has been exceeded. */
  diversionActive: boolean;
  /** Shockwave propagation speed in mph (negative = upstream, e.g. −8 mph). */
  shockwaveMph: number;
}

/**
 * Playback state for the Concept B timeline bar.
 */
export type PlaybackState = "idle" | "playing" | "paused";
