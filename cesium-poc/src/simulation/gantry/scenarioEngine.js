/**
 * Running a what-if scenario.
 *
 * In: a scenario, the equipment inventory as it stands, and whatever dependency rules exist.
 * Out: a result that says what the scenario establishes, what it only suggests, and what cannot be
 * determined — as three different things.
 *
 * Nothing is written back. The inventory passed in is read and never mutated, so the synthetic
 * baseline an operator sees when no scenario is running is exactly what it was before.
 *
 * Deterministic by construction: no clock, no randomness. An intermittent failure is a stated
 * availability, not a coin toss, because a scenario that answers differently on a second run is
 * not evidence of anything.
 */
import { assessZone, buildZones, DEFAULT_COVERAGE_RULES, DEFAULT_DEPENDENCY_LINKS, propagate,
  ZONE_ASSESSMENT } from './equipmentDependencies.js';
import { CERTAINTY, CHANGE, effectiveState, indirectState, isImpaired, isUnavailable } from './equipmentImpact.js';
import { financialImpact } from './revenueComparison.js';
import { withStatus } from './scenarioState.js';
import { validateScenario } from './scenarioValidation.js';

/** Whether the tolling conclusion could be reached at all. */
export const ASSESSMENT_STATUS = Object.freeze({
  ASSESSED: 'ASSESSED',
  INSUFFICIENT_COVERAGE_DATA: 'INSUFFICIENT_COVERAGE_DATA',
});

/**
 * @param {object} scenario
 * @param {{inventory: object[], coverageRules?: object, dependencyLinks?: object[], ranAt?: number}} context
 */
/**
 * @param {object} scenario
 * @param {{inventory: object[], coverageRules?: object, dependencyLinks?: object[], ranAt?: number,
 *          tolling?: {baseline: object, zones: object[]}}} context
 *   `tolling` is Phase 2's synthetic financial model. Without it the result's `revenueImpact`
 *   stays NOT_CALCULATED exactly as before — the equipment answer never depends on the money one.
 */
export function runScenario(scenario, {
  inventory = [], coverageRules = DEFAULT_COVERAGE_RULES, dependencyLinks = DEFAULT_DEPENDENCY_LINKS,
  ranAt = null, tolling = null,
} = {}) {
  const validation = validateScenario(scenario, inventory);
  if (!validation.valid) {
    return Object.freeze({
      scenarioId: scenario?.scenarioId ?? null,
      status: 'CANCELLED',
      valid: false,
      errors: validation.errors,
      warnings: validation.warnings,
    });
  }

  const byId = new Map(inventory.map(asset => [asset.assetId, asset]));
  const direct = scenario.failures.map(failure => effectiveState(byId.get(failure.assetId), failure));

  // Indirect effects travel only along verified links; everything else is reported as a possibility.
  const modes = Object.fromEntries(scenario.failures.map(failure => [failure.assetId, failure.failureMode]));
  const spread = propagate(direct.filter(isUnavailable).map(state => state.assetId), dependencyLinks, { modes });
  const indirect = spread.affected
    .filter(link => byId.has(link.assetId))
    .map(link => indirectState(byId.get(link.assetId), link));

  const equipment = Object.freeze([...direct, ...indirect]);
  const unavailable = new Set(equipment.filter(isUnavailable).map(state => state.assetId));
  const impaired = new Set(equipment.filter(isImpaired).map(state => state.assetId));

  const { zones, ungroupedAssetIds } = buildZones(inventory, { rules: coverageRules });
  const assessments = zones
    .map(zone => assessZone(zone, unavailable, impaired))
    .filter(assessment => assessment.assessment !== ZONE_ASSESSMENT.UNAFFECTED);
  const undetermined = assessments.filter(assessment => assessment.assessment === ZONE_ASSESSMENT.UNKNOWN);

  const touchedUngrouped = equipment.filter(state => ungroupedAssetIds.includes(state.assetId));

  // Assets the scenario cannot make any worse. Counted apart from the rest, because a later
  // revenue model that treated them as new outages would charge the same failure twice.
  const noChange = equipment.filter(state => state.change === CHANGE.NO_CHANGE);

  const limitations = [];
  if (noChange.length) {
    limitations.push(`${noChange.length} asset${noChange.length === 1 ? ' was' : 's were'} already at or below `
      + 'this condition in the baseline; the scenario adds no further loss of capability for them.');
  }
  if (undetermined.length) {
    limitations.push('Equipment failure confirmed in scenario; tolling coverage impact not yet determined.');
    limitations.push('Lane groups come from the 3D model and have not been verified against the roadway.');
  }
  if (touchedUngrouped.length) {
    limitations.push(`${touchedUngrouped.length} affected asset${touchedUngrouped.length === 1 ? ' is' : 's are'} `
      + 'not assigned to a tolling zone by the model, so no zone impact can be attributed to them.');
  }
  if (spread.unverified.length) {
    limitations.push(`${spread.unverified.length} possible dependent asset${spread.unverified.length === 1 ? '' : 's'} `
      + 'exist on unverified links and are NOT counted as affected.');
  }
  if (!dependencyLinks.length) {
    limitations.push('No verified power or communication dependencies are recorded for this gantry, '
      + 'so no indirect failures can be established.');
  }
  for (const warning of validation.warnings) limitations.push(warning.message);

  const comparison = Object.freeze([
    Object.freeze({ metric: 'Equipment simulated', baseline: '—', scenario: `${direct.length}` }),
    Object.freeze({ metric: 'Equipment failed',
      baseline: `${direct.filter(state => state.baselineStatus === 'FAILED').length}`,
      scenario: `${direct.filter(isUnavailable).length}` }),
    Object.freeze({ metric: 'Newly failed by this scenario', baseline: '0',
      scenario: `${direct.filter(state => isUnavailable(state) && state.change === CHANGE.WORSE).length}` }),
    Object.freeze({ metric: 'Confirmed indirect failures', baseline: '0', scenario: `${indirect.length}` }),
    Object.freeze({ metric: 'Equipment impaired', baseline: '0', scenario: `${impaired.size}` }),
    Object.freeze({ metric: 'Simulated duration', baseline: '—', scenario: `${scenario.durationMinutes} minutes` }),
    Object.freeze({ metric: 'Tolling-zone capability',
      baseline: 'Not assessed',
      scenario: undetermined.length === assessments.length && assessments.length
        ? 'Unknown pending coverage rules'
        : assessments.length ? `${assessments.length} zone(s) affected` : 'No zone affected' }),
  ]);

  return Object.freeze({
    scenarioId: scenario.scenarioId,
    scenarioName: scenario.name,
    scenarioType: scenario.scenarioType,
    gantryId: scenario.gantryId,
    status: withStatus(scenario, 'COMPLETED').status,
    valid: true,
    durationMinutes: scenario.durationMinutes,
    ranAt: ranAt == null ? null : new Date(ranAt).toISOString(),
    failures: scenario.failures,
    equipment,
    equipmentImpact: Object.freeze({
      directFailureCount: direct.filter(isUnavailable).length,
      directImpairedCount: direct.filter(isImpaired).length,
      indirectFailureCount: indirect.length,
      /** Of those, the ones the scenario actually changes. Phase 2's incremental figures start here. */
      incrementalFailureCount: direct.filter(state => isUnavailable(state) && state.change === CHANGE.WORSE).length,
      incrementalImpairedCount: direct.filter(state => isImpaired(state) && state.change === CHANGE.WORSE).length,
      noAdditionalImpactCount: noChange.length,
      /** Assets whose onward effect cannot be established: the honest middle of the answer. */
      unknownDependencyCount: undetermined.reduce((total, zone) => total + zone.failed.length + zone.degraded.length, 0)
        + touchedUngrouped.length,
      unverifiedDependencyCount: spread.unverified.length,
    }),
    tollingImpact: Object.freeze({
      affectedZones: Object.freeze(assessments),
      assessmentStatus: assessments.length && undetermined.length === assessments.length
        ? ASSESSMENT_STATUS.INSUFFICIENT_COVERAGE_DATA
        : assessments.length ? ASSESSMENT_STATUS.ASSESSED : ASSESSMENT_STATUS.INSUFFICIENT_COVERAGE_DATA,
      verificationStatus: 'PROVISIONAL',
    }),
    // The synthetic financial estimate, when the assumptions for one are supplied. Computed from
    // THIS result — the equipment answer above is what the money is derived from, never the other
    // way round — and still stated as not calculated when there is nothing to calculate with.
    revenueImpact: tolling?.baseline
      ? financialImpact({ equipment, durationMinutes: scenario.durationMinutes }, {
        inventory, zones: tolling.zones ?? [], baseline: tolling.baseline,
        // Phase 3 conditions. The scenario carries them; a caller may also pass them explicitly,
        // which is how the comparison runs the same scenario with one condition at a time.
        weather: tolling.weather ?? scenario.weather ?? null,
        incident: tolling.incident ?? scenario.trafficIncident ?? null,
        sensitivity: tolling.sensitivity,
      })
      : Object.freeze({ status: 'NOT_CALCULATED' }),
    trafficImpact: Object.freeze({ status: 'NOT_CALCULATED' }),
    comparison,
    certainty: Object.freeze({
      confirmed: equipment.length,
      assumed: spread.unverified.length,
      unknown: undetermined.length + touchedUngrouped.length,
      note: CERTAINTY.UNKNOWN,
    }),
    limitations: Object.freeze([...new Set(limitations)]),
    warnings: validation.warnings,
  });
}
