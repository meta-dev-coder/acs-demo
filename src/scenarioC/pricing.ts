/*---------------------------------------------------------------------------------------------
 * Scenario C — Dynamic Tolling pricing engine.
 *
 * Implements the FDOT-mirrored control loop: detector → density → LOS → stepped toll → posted rate.
 * All parameters are config-driven from src/data/tollPricing.json.
 * Nothing is hardcoded; strategy presets, LOS bands, caps, and safety threshold come from config.
 *
 * Key design rules (§3.3 units discipline):
 *  - density = flowPerLane / speed (per-lane flow only — NEVER feed a 3-lane total)
 *  - density clamped to [0, 60] veh/mi/ln
 *  - algorithm posts within $0.50–$3.00 caps; operator override slider goes to $10.00
 *  - demand curve is asserted monotonic-decreasing on load
 *--------------------------------------------------------------------------------------------*/
import config from "../data/tollPricing.json";
import { getTrafficState } from "../stubs/v2xStub";
import { getDemandCurve } from "../stubs/openPathsStub";
import type {
  LOSBand,
  TimeBlock,
  PricingStrategy,
  ExpressSection,
  SectionPricingResult,
  CorridorPricingResult,
  DemandCurvePoint,
  TrafficState,
} from "./types";

// ---------------------------------------------------------------------------
// Express sub-sections: SEG-EXP-RVS (u 0.30→0.78) split into thirds
// Each maps to a connected GP mainline segment for the safety check.
// ---------------------------------------------------------------------------
export const EXPRESS_SECTIONS: ExpressSection[] = [
  {
    sectionId: "EXP-W",
    name: "Express West",
    connectedMainlineSegmentId: "SEG-MN-W",
    uFrom: 0.30,
    uTo: 0.46,
    fromE: 580200,
    fromN: 2883015,
    toE: 582800,
    toN: 2883016,
  },
  {
    sectionId: "EXP-C",
    name: "Express Central",
    connectedMainlineSegmentId: "SEG-MN-C",
    uFrom: 0.46,
    uTo: 0.62,
    fromE: 582800,
    fromN: 2883016,
    toE: 585400,
    toN: 2883018,
  },
  {
    sectionId: "EXP-E",
    name: "Express East",
    connectedMainlineSegmentId: "SEG-MN-E",
    uFrom: 0.62,
    uTo: 0.78,
    fromE: 585400,
    fromN: 2883018,
    toE: 588000,
    toN: 2883020,
  },
];

// ---------------------------------------------------------------------------
// LOS Band classification
// ---------------------------------------------------------------------------

/** Map a density value (veh/mi/ln) to an HCM LOS band using the config table. */
export function densityToLOS(density: number): LOSBand {
  const clampedDensity = Math.max(0, density);
  const bands = config.losBands as Record<LOSBand, { minDensity: number; maxDensity: number; minToll: number; maxToll: number }>;
  // Walk A→F; the last band (F) catches everything ≥46
  for (const band of ["A", "B", "C", "D", "E", "F"] as LOSBand[]) {
    const b = bands[band];
    if (clampedDensity <= b.maxDensity) return band;
  }
  return "F";
}

// ---------------------------------------------------------------------------
// Strategy multiplier application
// ---------------------------------------------------------------------------

/** Apply the pricing strategy to a base toll value.
 *  - current_static: returns the flat base rate from config, ignoring the LOS-derived value.
 *  - moderate_variable / aggressive: multiply the LOS-table toll by the strategy multiplier,
 *    then clamp to the algorithm cap ($3.00). */
export function applyStrategy(baseToll: number, strategy: PricingStrategy): number {
  const strategies = config.strategies as Record<PricingStrategy, {
    baseRate: number;
    multiplier: number;
    useLOSTable: boolean;
    deltaPerDensityUnit?: number;
  }>;
  const s = strategies[strategy];
  if (!s.useLOSTable) {
    // current_static: ignore LOS table entirely
    return s.baseRate;
  }
  const result = baseToll * s.multiplier;
  return clampAlgorithmRate(result);
}

// ---------------------------------------------------------------------------
// Stepped toll lookup (the canonical artifact)
// ---------------------------------------------------------------------------

/** Look up the density's LOS band, interpolate within [minToll, maxToll] using a delta rule,
 *  apply the strategy multiplier, and clamp to the algorithm cap ($0.50–$3.00).
 *
 *  The delta rule nudges the rate within the band based on where density falls within
 *  [minDensity, maxDensity] — mirroring FDOT's real ELM delta-table behavior. */
export function computeToll(density: number, strategy: PricingStrategy): number {
  const strategies = config.strategies as Record<PricingStrategy, {
    baseRate: number;
    multiplier: number;
    useLOSTable: boolean;
    deltaPerDensityUnit?: number;
  }>;
  const s = strategies[strategy];

  if (!s.useLOSTable) {
    return s.baseRate; // current_static: flat base rate
  }

  const clampedDensity = Math.max(0, Math.min(60, density));
  const los = densityToLOS(clampedDensity);
  const bands = config.losBands as Record<LOSBand, { minDensity: number; maxDensity: number; minToll: number; maxToll: number }>;
  const band = bands[los];

  // Delta rule: fraction through the band maps toll from minToll→maxToll
  const bandSpan = band.maxDensity - band.minDensity || 1;
  const frac = Math.max(0, Math.min(1, (clampedDensity - band.minDensity) / bandSpan));
  const bandToll = band.minToll + frac * (band.maxToll - band.minToll);

  // Apply strategy multiplier then clamp
  return clampAlgorithmRate(bandToll * s.multiplier);
}

/** Clamp to the algorithm rate caps: $0.50 floor, $3.00 ceiling. */
function clampAlgorithmRate(rate: number): number {
  const { algorithmCap } = config.operatorOverride as { min: number; max: number; algorithmCap: number };
  return Math.max(0.50, Math.min(algorithmCap, rate));
}

// ---------------------------------------------------------------------------
// Demand curve utilities
// ---------------------------------------------------------------------------

/** Assert that a demand curve is monotonic-decreasing (demandRetained falls as rate rises).
 *  Throws if the invariant is violated — callers load stubs through this check. */
export function assertDemandCurveMonotonic(curve: DemandCurvePoint[]): void {
  for (let i = 1; i < curve.length; i++) {
    if (curve[i].demandRetained > curve[i - 1].demandRetained) {
      throw new Error(
        `Demand curve is not monotonic-decreasing at index ${i}: ` +
          `rate ${curve[i].rate} has demandRetained ${curve[i].demandRetained} > ` +
          `previous ${curve[i - 1].demandRetained}`
      );
    }
  }
}

/** Linear interpolation of demandRetained from the elasticity curve at a given rate. */
export function interpolateDemandRetained(curve: DemandCurvePoint[], rate: number): number {
  if (curve.length === 0) return 1.0;
  if (rate <= curve[0].rate) return curve[0].demandRetained;
  if (rate >= curve[curve.length - 1].rate) return curve[curve.length - 1].demandRetained;

  for (let i = 1; i < curve.length; i++) {
    if (rate <= curve[i].rate) {
      const t = (rate - curve[i - 1].rate) / (curve[i].rate - curve[i - 1].rate);
      return curve[i - 1].demandRetained + t * (curve[i].demandRetained - curve[i - 1].demandRetained);
    }
  }
  return curve[curve.length - 1].demandRetained;
}

/** Shed vehicles = baseline volume × (1 − demandRetained). */
export function computeShedVehicles(baselineVolume: number, demandRetained: number): number {
  return baselineVolume * (1 - demandRetained);
}

// ---------------------------------------------------------------------------
// Mainline utilization + safety flag
// ---------------------------------------------------------------------------

/** Compute connected mainline utilization after absorbing shed express demand.
 *  connectedMainlineUtil = (baselineMainlineVol + mainlineShed) / mainlineCapacity */
export function computeConnectedMainlineUtilization(
  baselineMainlineVolume: number,
  mainlineShedVehicles: number,
  mainlineCapacity: number
): number {
  return (baselineMainlineVolume + mainlineShedVehicles) / mainlineCapacity;
}

// ---------------------------------------------------------------------------
// Section-level pricing (end-to-end for one express sub-section)
// ---------------------------------------------------------------------------

/** Compute all pricing outputs for one express sub-section + time block + strategy.
 *  Implements the full FDOT pipeline: traffic state → density → LOS → toll → demand → revenue → safety.
 *
 *  @param trafficTable  Optional external traffic table (CSV upload) that overrides the V2X stub.
 *                       When provided, lookups use this table first; falls back to the stub if the
 *                       section/block combo is not found (tolerant partial CSV support). */
export function computeSectionPricing(
  section: ExpressSection,
  timeBlock: TimeBlock,
  strategy: PricingStrategy,
  overrideRate?: number, // optional operator override ($0.50–$10.00)
  trafficTable?: Record<string, Record<string, TrafficState>> | null
): SectionPricingResult {
  const sectionId = section.sectionId as "EXP-W" | "EXP-C" | "EXP-E";
  const timeBlockId = timeBlock as "morning_peak_eb" | "evening_peak_wb" | "off_peak" | "weekend";

  // 1. Traffic state: CSV table takes priority over the V2X stub (M5 feed override)
  const csvEntry = trafficTable?.[sectionId]?.[timeBlockId];
  const traffic = csvEntry ?? getTrafficState(sectionId, timeBlockId);
  const { flowPerLane, speed } = traffic;

  // 2. Density (per-lane only — NEVER feed 3-lane total)
  const density = Math.max(0, Math.min(60, flowPerLane / speed));

  // 3. LOS classification
  const los = densityToLOS(density);

  // 4. Toll lookup + strategy
  const algorithmRate = computeToll(density, strategy);
  const postedRate = overrideRate !== undefined
    ? Math.max(0.50, Math.min(10.00, overrideRate))
    : algorithmRate;

  // 5. Demand curve (monotonic-decreasing, asserted)
  const curve = getDemandCurve(sectionId, timeBlockId);
  assertDemandCurveMonotonic(curve);
  const demandRetained = interpolateDemandRetained(curve, postedRate);

  // 6. Volume display: per-lane flow is the display volume (§3.2 units discipline)
  const volume = flowPerLane;

  // 7. Shed vehicles
  const shedVehicles = computeShedVehicles(volume, demandRetained);

  // 8. Revenue / hr = postedRate × retained volume
  const revenuePerHour = postedRate * (volume * demandRetained);

  // 9. Mainline safety check
  const mainlineBaselines = config.mainlineBaseline as unknown as Record<string, { baselineVphpl: number; capacityVphpl: number }>;
  const mainlineInfo = mainlineBaselines[section.connectedMainlineSegmentId] ?? {
    baselineVphpl: 1500,
    capacityVphpl: 1800,
  };
  const shedSplit = config.demandShedSplit as { mainline: number; sr84: number };
  const mainlineShed = Math.round(shedVehicles * shedSplit.mainline);
  const connectedMainlineUtilization = computeConnectedMainlineUtilization(
    mainlineInfo.baselineVphpl,
    mainlineShed,
    mainlineInfo.capacityVphpl
  );
  const safetyFlag = connectedMainlineUtilization > config.safetyThreshold;

  // 10. Express section utilization (retained volume / lane capacity)
  const capacityVphpl = config.capacityVphpl as number;
  const utilization = (volume * demandRetained) / capacityVphpl;

  return {
    sectionId,
    density,
    los,
    flowPerLane,
    speed,
    volume,
    postedRate,
    demandRetained,
    shedVehicles,
    revenuePerHour,
    connectedMainlineUtilization,
    safetyFlag,
    utilization,
  };
}

// ---------------------------------------------------------------------------
// Corridor-level pricing (all 3 sub-sections)
// ---------------------------------------------------------------------------

/** Compute pricing for all three express sub-sections and aggregate KPIs.
 *
 *  @param trafficTable  Optional external traffic table (CSV upload) passed through to
 *                       computeSectionPricing. null/undefined → use the V2X stub. */
export function computeCorridorPricing(
  timeBlock: TimeBlock,
  strategy: PricingStrategy,
  overrides?: Partial<Record<string, number>>, // sectionId → operator override rate
  trafficTable?: Record<string, Record<string, TrafficState>> | null
): CorridorPricingResult {
  const sections = EXPRESS_SECTIONS.map((sec) =>
    computeSectionPricing(sec, timeBlock, strategy, overrides?.[sec.sectionId], trafficTable)
  );

  const corridorTotalRate = sections.reduce((s, sec) => s + sec.postedRate, 0);
  const speedHeld = sections.every((s) => s.speed >= 45);
  const projectedRevenuePerHour = sections.reduce((s, sec) => s + sec.revenuePerHour, 0);
  const corridorUtilization =
    sections.reduce((s, sec) => s + sec.utilization, 0) / sections.length;
  const safetyFlagCount = sections.filter((s) => s.safetyFlag).length;

  return {
    sections,
    corridorTotalRate,
    speedHeld,
    projectedRevenuePerHour,
    corridorUtilization,
    safetyFlagCount,
  };
}
