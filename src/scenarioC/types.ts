/*---------------------------------------------------------------------------------------------
 * Scenario C — Dynamic Tolling. Shared types.
 *--------------------------------------------------------------------------------------------*/

/** HCM Level-of-Service density bands, A (best) → F (breakdown). */
export type LOSBand = "A" | "B" | "C" | "D" | "E" | "F";

/** Time-of-day blocks matching the reversible-lane direction schedule for I-595 Express. */
export type TimeBlock =
  | "morning_peak_eb"  // 4 a.m.–1 p.m. weekdays — express lanes eastbound
  | "evening_peak_wb"  // 2 p.m.–2 a.m. weekdays — express lanes westbound
  | "off_peak"         // mid-day / shoulder
  | "weekend";         // Saturday–Sunday

/** Three preset pricing strategies. All are config-multipliers over the same LOS table. */
export type PricingStrategy =
  | "current_static"      // flat base rate, LOS table ignored — comparison reference
  | "moderate_variable"   // standard LOS lookup with modest delta
  | "aggressive";         // raises caps on LOS E/F to shed more demand

/** One of the three express sub-sections split from SEG-EXP-RVS. */
export interface ExpressSection {
  sectionId: "EXP-W" | "EXP-C" | "EXP-E";
  name: string;
  /** The GP mainline segment this section can shed demand onto (for the 95% safety check). */
  connectedMainlineSegmentId: "SEG-MN-W" | "SEG-MN-C" | "SEG-MN-E";
  /** Arc-length fraction along the corridor centerline (u_from / u_to). */
  uFrom: number;
  uTo: number;
  /** EPSG:32617 endpoint coordinates (from the parent SEG-EXP-RVS, interpolated). */
  fromE: number;
  fromN: number;
  toE: number;
  toN: number;
}

/** Pricing result for one express sub-section. */
export interface SectionPricingResult {
  sectionId: string;
  /** Traffic density in vehicles per mile per lane (veh/mi/ln). */
  density: number;
  los: LOSBand;
  /** Per-lane flow (veh/hr/ln) — the input to the density formula. */
  flowPerLane: number;
  /** Section speed (mph). */
  speed: number;
  /** Per-section display volume (veh/hr) — shown in the inspector alongside density. */
  volume: number;
  /** Posted toll rate — what the LOS algorithm sets (within $0.50–$3.00 algorithm cap). */
  postedRate: number;
  /** Retained demand fraction after pricing (from the demand curve). */
  demandRetained: number;
  /** Vehicles per hour shed off the express to connected GP mainline + SR-84. */
  shedVehicles: number;
  /** Section revenue / hr = postedRate × retainedExpressVolume. */
  revenuePerHour: number;
  /** Connected mainline utilization fraction (after absorbing shed demand). */
  connectedMainlineUtilization: number;
  /** True when connected mainline util > safetyThreshold (~0.95) after shed. */
  safetyFlag: boolean;
  /** Utilization of the express section itself (retained volume / capacity). */
  utilization: number;
}

/** Full corridor pricing result across all three sub-sections. */
export interface CorridorPricingResult {
  sections: SectionPricingResult[];
  /** Sum of all three section posted rates — the honest end-to-end trip price readout. */
  corridorTotalRate: number;
  /** All sections holding ≥ 45 mph? (the mandated KPI). */
  speedHeld: boolean;
  /** Σ section revenuePerHour across all sections. */
  projectedRevenuePerHour: number;
  /** Average retained volume / capacity across express sections. */
  corridorUtilization: number;
  /** Number of sections where safetyFlag = true. */
  safetyFlagCount: number;
}

/** One point on the demand-elasticity curve (monotonic-decreasing). */
export interface DemandCurvePoint {
  /** Toll rate in dollars. */
  rate: number;
  /** Fraction of baseline express volume retained at this rate (0–1). */
  demandRetained: number;
}

/** V2X traffic state returned by the stub. */
export interface TrafficState {
  /** Per-lane flow in vehicles/hour/lane — the only value that feeds the density formula. */
  flowPerLane: number;
  /** Section speed in mph. */
  speed: number;
}
