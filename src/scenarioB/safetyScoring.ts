/*---------------------------------------------------------------------------------------------
 * Scenario B safety scoring + deterministic countermeasure deltas. All coefficients come from
 * config/safetyConfig.json + the countermeasure catalog — not hardcoded.
 *--------------------------------------------------------------------------------------------*/
import safetyCfg from "./config/safetyConfig.json";
import cmData from "./data/countermeasures.json";
import type { BandMeta, RiskBand } from "../scenarioA/types";
import type {
  Countermeasure,
  CountermeasureDelta,
  IncidentType,
  RawSegment,
  ScoredSegment,
  SegIncident,
  SegmentStats,
  Severity,
} from "./types";

interface SafetyConfig {
  referenceDate: string;
  severityWeight: Record<Severity, number>;
  weights: { frequency: number; severity: number; closure: number };
  normalizers: { incidentsFull: number; severityScoreFull: number; closureMinFull: number };
  recency: { halfLifeMonths: number; floor: number };
  lengthNormalizationRefM: number;
  bands: { redAtOrAbove: number; amberAtOrAbove: number };
  bandMeta: Record<RiskBand, BandMeta>;
  economics: { tolledLaneRevenuePerHour: number; incidentResponseCostAvg: number };
}

export const config = safetyCfg as unknown as SafetyConfig;
export const countermeasures = (cmData.countermeasures as unknown) as Countermeasure[];

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

const REF = new Date(config.referenceDate);
/** Months from an incident date to the reference date (0 if in the future). */
function monthsSince(date: string): number {
  const d = new Date(date);
  return Math.max(0, (REF.getFullYear() - d.getFullYear()) * 12 + (REF.getMonth() - d.getMonth()));
}
/** Recency weight: exponential decay (config half-life), floored — recent crashes count more. */
function recencyWeight(date: string): number {
  return Math.max(config.recency.floor, Math.pow(0.5, monthsSince(date) / config.recency.halfLifeMonths));
}
/** Per-length factor: short segments with the same incident load read as higher-rate (per km). */
function lengthFactor(lengthM: number): number {
  return Math.max(0.5, Math.min(2.5, config.lengthNormalizationRefM / Math.max(lengthM, 1)));
}

export function bandFor(score: number): RiskBand {
  if (score >= config.bands.redAtOrAbove) return "red";
  if (score >= config.bands.amberAtOrAbove) return "amber";
  return "green";
}
export function bandMeta(band: RiskBand): BandMeta {
  return config.bandMeta[band];
}

function statsFor(incidents: SegIncident[]): SegmentStats {
  const counts: Record<string, number> = {};
  let injuries = 0;
  let serious = 0;
  let closureMin = 0;
  const factorCounts: Record<string, number> = {};
  for (const i of incidents) {
    counts[i.type] = (counts[i.type] ?? 0) + 1;
    if (i.severity === "injury" || i.severity === "serious") injuries++;
    if (i.severity === "serious") serious++;
    closureMin += i.lane_closure_min;
    factorCounts[i.contributing_factor] = (factorCounts[i.contributing_factor] ?? 0) + 1;
  }
  const dominantType = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ??
    "none") as IncidentType | "none";
  const factors = Object.entries(factorCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f);
  return { count: incidents.length, injuries, serious, closureMin, dominantType, factors };
}

/** Effective-weight scoring: each incident contributes `weight` (1, or 1-reduction if a
 * countermeasure addresses it) × a recency decay. Frequency + severity are normalized per segment
 * length (incidents/km); closure burden stays absolute. Lets the before/after toggle stay smooth. */
function scoreFromWeighted(
  incidents: SegIncident[],
  lengthM: number,
  weightOf: (i: SegIncident) => number
): number {
  const lf = lengthFactor(lengthM);
  let count = 0;
  let severity = 0;
  let closure = 0;
  for (const i of incidents) {
    const w = weightOf(i) * recencyWeight(i.date);
    count += w;
    severity += w * (config.severityWeight[i.severity] ?? 1);
    closure += w * i.lane_closure_min;
  }
  const n = config.normalizers;
  const wt = config.weights;
  return clamp01(
    wt.frequency * clamp01((count * lf) / n.incidentsFull) +
      wt.severity * clamp01((severity * lf) / n.severityScoreFull) +
      wt.closure * clamp01(closure / n.closureMinFull)
  );
}

function addresses(cm: Countermeasure, i: SegIncident): boolean {
  return (
    cm.affected_types.includes(i.type) || cm.affected_factors.includes(i.contributing_factor)
  );
}

export function recommendedFor(segmentId: string): Countermeasure | undefined {
  return (
    countermeasures.find((c) => c.recommended_for.includes(segmentId)) ??
    countermeasures[0]
  );
}

export function computeDelta(seg: ScoredSegment, cm: Countermeasure): CountermeasureDelta {
  const matching = seg.incidents.filter((i) => addresses(cm, i));
  const crashesAvoided = Math.round(matching.length * cm.reduction);
  const injuriesAvoided = Math.round(
    matching.filter((i) => i.severity === "injury" || i.severity === "serious").length *
      cm.reduction
  );
  const closureMinAvoided = Math.round(
    matching.reduce((s, i) => s + i.lane_closure_min, 0) * cm.reduction
  );
  const closureHoursAvoided = +(closureMinAvoided / 60).toFixed(1);
  const revenueProtected = Math.round(
    closureHoursAvoided * config.economics.tolledLaneRevenuePerHour
  );
  const afterScore = scoreFromWeighted(seg.incidents, seg.length_m, (i) =>
    addresses(cm, i) ? 1 - cm.reduction : 1
  );
  return {
    countermeasure: cm,
    crashesAvoided,
    injuriesAvoided,
    closureMinAvoided,
    closureHoursAvoided,
    revenueProtected,
    afterScore,
    afterBand: bandFor(afterScore),
  };
}

export function scoreSegments(
  segments: RawSegment[],
  incidents: SegIncident[]
): ScoredSegment[] {
  return segments
    .map((seg) => {
      const segIncidents = incidents
        .filter((i) => i.segment_id === seg.segment_id)
        .sort((a, b) => (a.date < b.date ? 1 : -1));
      const score = scoreFromWeighted(segIncidents, seg.length_m, () => 1);
      const band = bandFor(score);
      const stats = statsFor(segIncidents);
      const recommended = recommendedFor(seg.segment_id);
      const scored: ScoredSegment = {
        ...seg,
        score,
        band,
        incidents: segIncidents,
        stats,
        recommended,
      };
      if (recommended) scored.delta = computeDelta(scored, recommended);
      return scored;
    })
    .sort((a, b) => b.score - a.score);
}
