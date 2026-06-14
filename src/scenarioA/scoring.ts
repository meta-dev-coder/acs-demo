/*---------------------------------------------------------------------------------------------
 * Rule-based ITS asset failure-risk scoring. ALL coefficients come from
 * config/scoringConfig.json (scope hard constraint) — this file only applies them.
 *--------------------------------------------------------------------------------------------*/
import rawConfig from "./config/scoringConfig.json";
import type {
  AssetClass,
  BandMeta,
  HistoryRecord,
  RawAsset,
  RiskBand,
  RiskDriver,
  ScoredAsset,
} from "./types";

interface ScoringConfig {
  referenceDate: string;
  weights: Record<string, number>;
  normalizers: {
    openTicketsFull: number;
    recentWorkordersFull: number;
    inspectionIntervalMonths: number;
  };
  bands: { redAtOrAbove: number; amberAtOrAbove: number };
  bandMeta: Record<RiskBand, BandMeta>;
  driverLabels: Record<string, string>;
  recommendedActions: Record<string, Record<RiskBand, string>>;
  workPackage: WorkPackageConfig;
}

export interface WorkPackageConfig {
  crewHoursEach: Record<string, number>;
  sharedSetupHoursPerClosure: number;
  emergencyClosureHoursEach: number;
  plannedClosureHours: number;
  tolledLaneRevenuePerHour: number;
}

export const config = rawConfig as unknown as ScoringConfig;

const REF = new Date(config.referenceDate);

function monthsBetween(from: string, to: Date): number {
  const f = new Date(from);
  return (to.getFullYear() - f.getFullYear()) * 12 + (to.getMonth() - f.getMonth());
}
function yearsBetween(from: string, to: Date): number {
  return monthsBetween(from, to) / 12;
}
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

export function bandFor(score: number): RiskBand {
  if (score >= config.bands.redAtOrAbove) return "red";
  if (score >= config.bands.amberAtOrAbove) return "amber";
  return "green";
}

export function bandMeta(band: RiskBand): BandMeta {
  return config.bandMeta[band];
}

/** Compute the risk factors (each 0..1) for an asset. */
function factors(a: RawAsset) {
  const ageRatio = clamp01(yearsBetween(a.install_date, REF) / a.expected_life_years);
  const openTickets = clamp01(a.open_tickets / config.normalizers.openTicketsFull);
  const recentWorkorders = clamp01(
    a.recent_workorders / config.normalizers.recentWorkordersFull
  );
  const manufacturerEol = a.manufacturer_eol ? 1 : 0;
  const exposureFactor = clamp01(a.exposure_factor);
  const overdueInspection = clamp01(
    monthsBetween(a.last_inspection_date, REF) /
      config.normalizers.inspectionIntervalMonths -
      1
  );
  return {
    ageRatio,
    openTickets,
    recentWorkorders,
    manufacturerEol,
    exposureFactor,
    overdueInspection,
  } as Record<string, number>;
}

function driverText(key: string, a: RawAsset, f: Record<string, number>): string {
  const t = config.driverLabels[key] ?? key;
  switch (key) {
    case "ageRatio":
      return fmt(t, { pct: Math.round(f.ageRatio * 100) });
    case "openTickets":
      return fmt(t, { n: a.open_tickets });
    case "recentWorkorders":
      return fmt(t, { n: a.recent_workorders });
    case "overdueInspection": {
      const overdue = Math.max(
        0,
        monthsBetween(a.last_inspection_date, REF) -
          config.normalizers.inspectionIntervalMonths
      );
      return fmt(t, { months: overdue });
    }
    default:
      return t;
  }
}

export function scoreAsset(a: RawAsset, history: HistoryRecord[]): ScoredAsset {
  const f = factors(a);
  const weights = config.weights;
  const totalWeight = Object.values(weights).reduce((s, w) => s + w, 0) || 1;

  let score = 0;
  const drivers: RiskDriver[] = [];
  for (const [key, weight] of Object.entries(weights)) {
    const contribution = (weight * (f[key] ?? 0)) / totalWeight;
    score += contribution;
    if (contribution > 0.04 && (f[key] ?? 0) > 0.15) {
      drivers.push({ key, label: driverText(key, a, f), contribution });
    }
  }
  score = clamp01(score);
  const band = bandFor(score);
  drivers.sort((x, y) => y.contribution - x.contribution);

  const actionsForClass =
    config.recommendedActions[a.asset_class as AssetClass] ??
    config.recommendedActions.controller_cabinet;
  const recommendedAction = actionsForClass[band];

  const assetHistory = history
    .filter((h) => h.asset_tag === a.asset_tag)
    .sort((x, y) => (x.date < y.date ? 1 : -1));

  return { ...a, score, band, drivers, recommendedAction, history: assetHistory };
}

export function scoreAssets(
  assets: RawAsset[],
  history: HistoryRecord[]
): ScoredAsset[] {
  return assets
    .map((a) => scoreAsset(a, history))
    .sort((x, y) => y.score - x.score);
}
