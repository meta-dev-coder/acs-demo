/*---------------------------------------------------------------------------------------------
 * OpenPaths demand-elasticity stub — Scenario C (Dynamic Tolling).
 *
 * STUB - replace with live OpenPaths origin-destination demand-elasticity data
 *
 * Returns a JSON fixture for the demand-elasticity curve per express section and time block.
 * Each curve is an array of {rate, demandRetained} points where:
 *  - rate: toll rate in dollars
 *  - demandRetained: fraction (0–1) of baseline express volume kept at that rate
 * The curve is MONOTONIC-DECREASING and asserted on load by assertDemandCurveMonotonic().
 * Raising the rate reads demandRetained off the curve; shed = baseline × (1 − demandRetained).
 * Shed demand redistributes 70% to connected GP mainline / 30% to SR-84 (config-driven).
 *
 * EXP-E curve is hand-tuned so the safety flag trips from a credible ~$3.00 over-price:
 * at $3.00, demandRetained ≈ 0.70 → shed = 2000 × 0.30 = 600 veh/hr
 * → mainline absorbed = 600 × 0.70 = 420 veh/hr
 * → mainline util = (1500 + 420) / 1800 ≈ 107% → flag fires (well above 0.95)
 *--------------------------------------------------------------------------------------------*/
import type { DemandCurvePoint } from "../scenarioC/types";

type SectionId = "EXP-W" | "EXP-C" | "EXP-E";
type TimeBlock = "morning_peak_eb" | "evening_peak_wb" | "off_peak" | "weekend";

/** Demand curves per section. Each is monotonic-decreasing from rate = $0.50 to $10.00.
 *  EXP-E is steeper (more elastic) because it has the most substitute routes (SR-84, SEG-MN-E).
 *  EXP-W is less elastic (fewer alternatives at the western approach).
 */
const DEMAND_CURVES: Record<SectionId, Record<TimeBlock, DemandCurvePoint[]>> = {
  "EXP-W": {
    morning_peak_eb: [
      { rate: 0.50, demandRetained: 1.00 },
      { rate: 1.00, demandRetained: 0.97 },
      { rate: 1.50, demandRetained: 0.93 },
      { rate: 2.00, demandRetained: 0.88 },
      { rate: 2.50, demandRetained: 0.82 },
      { rate: 3.00, demandRetained: 0.75 },
      { rate: 5.00, demandRetained: 0.55 },
      { rate: 7.50, demandRetained: 0.40 },
      { rate: 10.0, demandRetained: 0.30 },
    ],
    evening_peak_wb: [
      { rate: 0.50, demandRetained: 1.00 },
      { rate: 1.00, demandRetained: 0.96 },
      { rate: 1.50, demandRetained: 0.90 },
      { rate: 2.00, demandRetained: 0.82 },
      { rate: 2.50, demandRetained: 0.73 },
      { rate: 3.00, demandRetained: 0.63 },
      { rate: 5.00, demandRetained: 0.45 },
      { rate: 7.50, demandRetained: 0.32 },
      { rate: 10.0, demandRetained: 0.25 },
    ],
    off_peak: [
      { rate: 0.50, demandRetained: 1.00 },
      { rate: 1.50, demandRetained: 0.95 },
      { rate: 3.00, demandRetained: 0.80 },
      { rate: 5.00, demandRetained: 0.60 },
      { rate: 10.0, demandRetained: 0.40 },
    ],
    weekend: [
      { rate: 0.50, demandRetained: 1.00 },
      { rate: 1.50, demandRetained: 0.92 },
      { rate: 3.00, demandRetained: 0.75 },
      { rate: 5.00, demandRetained: 0.55 },
      { rate: 10.0, demandRetained: 0.35 },
    ],
  },
  "EXP-C": {
    morning_peak_eb: [
      { rate: 0.50, demandRetained: 1.00 },
      { rate: 1.00, demandRetained: 0.95 },
      { rate: 1.50, demandRetained: 0.88 },
      { rate: 2.00, demandRetained: 0.80 },
      { rate: 2.50, demandRetained: 0.71 },
      { rate: 3.00, demandRetained: 0.62 },
      { rate: 5.00, demandRetained: 0.45 },
      { rate: 7.50, demandRetained: 0.33 },
      { rate: 10.0, demandRetained: 0.25 },
    ],
    evening_peak_wb: [
      { rate: 0.50, demandRetained: 1.00 },
      { rate: 1.00, demandRetained: 0.94 },
      { rate: 1.50, demandRetained: 0.86 },
      { rate: 2.00, demandRetained: 0.77 },
      { rate: 2.50, demandRetained: 0.67 },
      { rate: 3.00, demandRetained: 0.58 },
      { rate: 5.00, demandRetained: 0.42 },
      { rate: 7.50, demandRetained: 0.30 },
      { rate: 10.0, demandRetained: 0.22 },
    ],
    off_peak: [
      { rate: 0.50, demandRetained: 1.00 },
      { rate: 1.50, demandRetained: 0.93 },
      { rate: 3.00, demandRetained: 0.76 },
      { rate: 5.00, demandRetained: 0.55 },
      { rate: 10.0, demandRetained: 0.38 },
    ],
    weekend: [
      { rate: 0.50, demandRetained: 1.00 },
      { rate: 1.50, demandRetained: 0.90 },
      { rate: 3.00, demandRetained: 0.72 },
      { rate: 5.00, demandRetained: 0.52 },
      { rate: 10.0, demandRetained: 0.33 },
    ],
  },
  "EXP-E": {
    // Hand-tuned: at $3.00 → retained=0.70 → shed 600 → flag trips on SEG-MN-E
    morning_peak_eb: [
      { rate: 0.50, demandRetained: 1.00 },
      { rate: 1.00, demandRetained: 0.94 },
      { rate: 1.50, demandRetained: 0.86 },
      { rate: 2.00, demandRetained: 0.80 },
      { rate: 2.50, demandRetained: 0.74 },
      { rate: 3.00, demandRetained: 0.70 },
      { rate: 5.00, demandRetained: 0.50 },
      { rate: 7.50, demandRetained: 0.35 },
      { rate: 10.0, demandRetained: 0.25 },
    ],
    evening_peak_wb: [
      { rate: 0.50, demandRetained: 1.00 },
      { rate: 1.00, demandRetained: 0.96 },
      { rate: 1.50, demandRetained: 0.90 },
      { rate: 2.00, demandRetained: 0.83 },
      { rate: 2.50, demandRetained: 0.76 },
      { rate: 3.00, demandRetained: 0.68 },
      { rate: 5.00, demandRetained: 0.50 },
      { rate: 7.50, demandRetained: 0.36 },
      { rate: 10.0, demandRetained: 0.27 },
    ],
    off_peak: [
      { rate: 0.50, demandRetained: 1.00 },
      { rate: 1.50, demandRetained: 0.95 },
      { rate: 3.00, demandRetained: 0.82 },
      { rate: 5.00, demandRetained: 0.62 },
      { rate: 10.0, demandRetained: 0.42 },
    ],
    weekend: [
      { rate: 0.50, demandRetained: 1.00 },
      { rate: 1.50, demandRetained: 0.93 },
      { rate: 3.00, demandRetained: 0.78 },
      { rate: 5.00, demandRetained: 0.58 },
      { rate: 10.0, demandRetained: 0.38 },
    ],
  },
};

/**
 * STUB - replace with live OpenPaths origin-destination demand-elasticity data
 *
 * Returns a monotonic-decreasing demand-elasticity curve for a given section and time block.
 * Each point: { rate: dollars, demandRetained: 0–1 fraction of baseline volume kept }.
 * Callers must assert monotonicity via assertDemandCurveMonotonic() from pricing.ts.
 */
export function getDemandCurve(section: SectionId, timeBlock: TimeBlock): DemandCurvePoint[] {
  const curve = DEMAND_CURVES[section]?.[timeBlock];
  if (!curve) {
    // Fallback: a simple two-point inelastic curve
    return [
      { rate: 0.50, demandRetained: 1.00 },
      { rate: 10.0, demandRetained: 0.50 },
    ];
  }
  // Return a shallow copy so callers cannot mutate the stub fixture
  return curve.map((pt) => ({ ...pt }));
}
