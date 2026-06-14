/*---------------------------------------------------------------------------------------------
 * Scenario B — Safety Hotspot Predictor. Shared types.
 *--------------------------------------------------------------------------------------------*/
import type { RiskBand } from "../scenarioA/types";

export type SegmentRoadway =
  | "i595_mainline"
  | "express_lane"
  | "sr84"
  | "turnpike_ramp";

export interface RawSegment {
  segment_id: string;
  name: string;
  roadway: SegmentRoadway;
  direction: "EB" | "WB" | "reversible";
  from_e: number;
  from_n: number;
  to_e: number;
  to_n: number;
  u_from: number;
  u_to: number;
  length_m: number;
}

export type IncidentType =
  | "rear_end"
  | "sideswipe"
  | "breakdown"
  | "debris"
  | "secondary";
export type Severity = "minor" | "injury" | "serious";

export interface SegIncident {
  incident_id: string;
  segment_id: string;
  date: string;
  type: IncidentType;
  severity: Severity;
  lane_closure_min: number;
  contributing_factor: string;
}

export interface Countermeasure {
  id: string;
  name: string;
  short: string;
  affected_types: IncidentType[];
  affected_factors: string[];
  reduction: number;
  cost_usd: number;
  install_days: number;
  recommended_for: string[];
}

export interface SegmentStats {
  count: number;
  injuries: number; // injury + serious
  serious: number;
  closureMin: number;
  dominantType: IncidentType | "none";
  factors: string[];
}

export interface CountermeasureDelta {
  countermeasure: Countermeasure;
  crashesAvoided: number;
  injuriesAvoided: number;
  closureMinAvoided: number;
  closureHoursAvoided: number;
  revenueProtected: number;
  afterScore: number;
  afterBand: RiskBand;
}

export interface ScoredSegment extends RawSegment {
  score: number;
  band: RiskBand;
  incidents: SegIncident[];
  stats: SegmentStats;
  recommended?: Countermeasure;
  delta?: CountermeasureDelta;
}
