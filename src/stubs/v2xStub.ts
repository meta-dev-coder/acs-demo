/*---------------------------------------------------------------------------------------------
 * V2X / MVDS detector stub — Scenario C (Dynamic Tolling).
 *
 * STUB - replace with live V2X / MVDS detector feed (volume, speed, occupancy per 0.5-mi station)
 *
 * Returns synthetic per-section, per-time-block traffic state values that read credibly
 * to a tolling operator (I-595 Express, LLC / ACS):
 *  - Per-lane flow (veh/hr/ln) — the ONLY value fed to the density formula.
 *  - Speed (mph) — seeds ~45–65 mph, drops as volume rises.
 *  - Directional: lanes run EASTBOUND during morning peak, WESTBOUND during evening peak.
 *
 * Units discipline (§3.2): per-lane flow peaks ~1,800–2,100 veh/hr/ln on LOS-E sections
 * (the figure that places density at ~36–45 veh/mi/ln and supports the demo's $2.75 toll
 * climax). The inspector displays this as "per-section volume" alongside derived density.
 *--------------------------------------------------------------------------------------------*/
import type { TrafficState } from "../scenarioC/types";

type SectionId = "EXP-W" | "EXP-C" | "EXP-E";
type TimeBlock = "morning_peak_eb" | "evening_peak_wb" | "off_peak" | "weekend";

/** Synthetic traffic state table: sectionId → timeBlock → {flowPerLane, speed}.
 *  Values tuned so the LOS table produces credible results:
 *  - Morning peak EB: EXP-E approaches LOS E (density ~40 veh/mi/ln @ 2000/50)
 *  - Evening peak WB: EXP-W carries the higher load (reversed direction)
 *  - Off-peak / Weekend: lower load, LOS B/C range
 */
const TRAFFIC_TABLE: Record<SectionId, Record<TimeBlock, TrafficState>> = {
  "EXP-W": {
    morning_peak_eb: { flowPerLane: 900, speed: 62 },   // density 14.5 → LOS B
    evening_peak_wb: { flowPerLane: 1950, speed: 52 },  // density 37.5 → LOS E
    off_peak:        { flowPerLane: 600, speed: 66 },   // density  9.1 → LOS A
    weekend:         { flowPerLane: 750, speed: 65 },   // density 11.5 → LOS B
  },
  "EXP-C": {
    morning_peak_eb: { flowPerLane: 1400, speed: 57 },  // density 24.6 → LOS C
    evening_peak_wb: { flowPerLane: 1600, speed: 55 },  // density 29.1 → LOS D
    off_peak:        { flowPerLane: 700, speed: 67 },   // density 10.4 → LOS A
    weekend:         { flowPerLane: 850, speed: 64 },   // density 13.3 → LOS B
  },
  "EXP-E": {
    morning_peak_eb: { flowPerLane: 2000, speed: 50 },  // density 40.0 → LOS E (demo climax)
    evening_peak_wb: { flowPerLane: 1200, speed: 60 },  // density 20.0 → LOS C
    off_peak:        { flowPerLane: 650, speed: 67 },   // density  9.7 → LOS A
    weekend:         { flowPerLane: 800, speed: 65 },   // density 12.3 → LOS B
  },
};

/**
 * STUB - replace with live V2X / MVDS detector feed (volume, speed, occupancy per 0.5-mi station)
 *
 * Returns the synthetic traffic state for a given express section and time block.
 * Internal value is per-lane flow (veh/hr/ln) — the only correct input to density = flow/speed.
 */
export function getTrafficState(section: SectionId, timeBlock: TimeBlock): TrafficState {
  const row = TRAFFIC_TABLE[section]?.[timeBlock];
  if (!row) {
    // Fallback: off-peak free-flow values
    return { flowPerLane: 600, speed: 67 };
  }
  return { ...row };
}
