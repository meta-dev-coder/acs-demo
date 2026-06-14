/*---------------------------------------------------------------------------------------------
 * Proactive work-package rollup. Deterministic, config-driven (scoringConfig.json > workPackage).
 * The "so what" of Scenario A: bundling several at-risk assets into ONE planned window instead
 * of N emergency call-outs => crew hours saved, lane closures avoided, toll revenue protected.
 *--------------------------------------------------------------------------------------------*/
import { config } from "./scoring";
import type { ScoredAsset } from "./types";

export interface WorkPackageSummary {
  count: number;
  assets: ScoredAsset[];
  crewHoursSeparate: number;
  crewHoursBundled: number;
  crewHoursSaved: number;
  closuresSeparate: number;
  closuresBundled: number;
  closuresAvoided: number;
  closureHoursSaved: number;
  revenueProtected: number;
}

export function computeWorkPackage(assets: ScoredAsset[]): WorkPackageSummary {
  const wp = config.workPackage;
  const n = assets.length;
  const wrench = assets.reduce(
    (s, a) => s + (wp.crewHoursEach[a.asset_class] ?? 3),
    0
  );

  // Separate: each asset is its own emergency call-out (own mobilization + own closure).
  const crewHoursSeparate = wrench + n * wp.sharedSetupHoursPerClosure;
  const closuresSeparate = n;
  const closureHoursSeparate = n * wp.emergencyClosureHoursEach;

  // Bundled: one planned window (single mobilization + single planned closure).
  const crewHoursBundled = wrench + wp.sharedSetupHoursPerClosure;
  const closuresBundled = n > 0 ? 1 : 0;
  const closureHoursBundled = n > 0 ? wp.plannedClosureHours : 0;

  const closureHoursSaved = Math.max(0, closureHoursSeparate - closureHoursBundled);

  return {
    count: n,
    assets,
    crewHoursSeparate,
    crewHoursBundled,
    crewHoursSaved: Math.max(0, crewHoursSeparate - crewHoursBundled),
    closuresSeparate,
    closuresBundled,
    closuresAvoided: Math.max(0, closuresSeparate - closuresBundled),
    closureHoursSaved,
    revenueProtected: Math.round(closureHoursSaved * wp.tolledLaneRevenuePerHour),
  };
}
