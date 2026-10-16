/**
 * Measures that might make a scenario less bad, and what each one assumes.
 *
 * A mitigation here is a CHANGE TO THE QUESTION, not a claim about the world: "suppose the antenna
 * were back within the hour", "suppose the crash cleared twice as fast". The engine then answers
 * the changed question and the two answers are compared.
 *
 * What this module refuses to do is rank them. None of these carries a real repair time, a
 * responder performance figure or an implementation cost — `implementationCostUSD` is null for
 * every one — so the largest financial improvement is not necessarily the best option, and the UI
 * says so rather than crowning a winner.
 */
import { removeFailure } from './scenarioState.js';
import { withAssumption } from './syntheticTollingBaseline.js';

export const MITIGATIONS = Object.freeze([
  Object.freeze({
    id: 'RESTORE_EQUIPMENT', label: 'Restore the failed equipment',
    assumedEffect: 'The simulated equipment failure does not happen at all during the assessment.',
    implementationCostUSD: null,
  }),
  Object.freeze({
    id: 'IMPROVE_VIDEO_RECOVERY', label: 'Improve video toll recovery',
    assumedEffect: 'The synthetic video collection recovery rate is raised by 10 percentage points.',
    implementationCostUSD: null,
    parameter: Object.freeze({ key: 'recoveryUplift', default: 0.1, min: 0.01, max: 0.5 }),
  }),
  Object.freeze({
    id: 'SHORTEN_INCIDENT', label: 'Clear the incident faster',
    assumedEffect: 'The incident lasts half as long.',
    implementationCostUSD: null,
    parameter: Object.freeze({ key: 'durationFactor', default: 0.5, min: 0.1, max: 0.9 }),
  }),
  Object.freeze({
    id: 'REDUCE_DIVERSION', label: 'Keep traffic on the corridor',
    assumedEffect: 'The share of held-back vehicles that divert away is halved.',
    implementationCostUSD: null,
    parameter: Object.freeze({ key: 'diversionFactor', default: 0.5, min: 0.1, max: 0.9 }),
  }),
]);

export const mitigation = id => MITIGATIONS.find(item => item.id === id) ?? null;

/**
 * The scenario and assumptions as the mitigations would leave them.
 *
 * Returns copies. Nothing is applied to the original scenario, so the unmitigated answer stays
 * available to compare against.
 *
 * @param {{scenario: object, baseline: object, applied: {id: string, value?: number}[]}} input
 */
export function applyMitigations({ scenario, baseline, applied = [] } = {}) {
  let nextScenario = scenario;
  let nextBaseline = baseline;
  const notes = [];
  for (const entry of applied) {
    const measure = mitigation(entry?.id);
    if (!measure) continue;
    const value = Number(entry?.value ?? measure.parameter?.default ?? 0);
    switch (measure.id) {
      case 'RESTORE_EQUIPMENT': {
        // Every failure named in the scenario is taken back out of it.
        for (const failure of [...nextScenario.failures]) {
          nextScenario = removeFailure(nextScenario, failure.assetId);
        }
        notes.push(measure.assumedEffect);
        break;
      }
      case 'IMPROVE_VIDEO_RECOVERY': {
        const current = Number(nextBaseline.tolling.videoCollectionRecoveryRate) || 0;
        nextBaseline = withAssumption(nextBaseline, 'tolling.videoCollectionRecoveryRate',
          Math.min(1, current + value));
        notes.push(`Video collection recovery is assumed to rise from ${(current * 100).toFixed(0)}% `
          + `to ${(Math.min(1, current + value) * 100).toFixed(0)}%.`);
        break;
      }
      case 'SHORTEN_INCIDENT': {
        if (!nextScenario.trafficIncident) break;
        const before = nextScenario.trafficIncident.durationMinutes;
        nextScenario = Object.freeze({ ...nextScenario, trafficIncident: Object.freeze({
          ...nextScenario.trafficIncident, durationMinutes: Math.max(1, Math.round(before * value)) }) });
        notes.push(`The incident is assumed to clear in ${Math.max(1, Math.round(before * value))} minutes `
          + `instead of ${before}.`);
        break;
      }
      case 'REDUCE_DIVERSION': {
        if (!nextScenario.trafficIncident) break;
        const handling = nextScenario.trafficIncident.demandHandling ?? {};
        const before = Number(handling.divertedShare) || 0;
        nextScenario = Object.freeze({ ...nextScenario, trafficIncident: Object.freeze({
          ...nextScenario.trafficIncident,
          demandHandling: Object.freeze({ ...handling, divertedShare: before * value }) }) });
        notes.push(`The diverted share is assumed to fall from ${(before * 100).toFixed(0)}% `
          + `to ${(before * value * 100).toFixed(0)}%.`);
        break;
      }
      default: break;
    }
  }
  return Object.freeze({ scenario: nextScenario, baseline: nextBaseline, notes: Object.freeze(notes) });
}

/**
 * What a mitigation changed, in the only terms this model can speak to.
 *
 * Deliberately not a recommendation: the improvement is stated, the assumption behind it is
 * stated, and the fact that its cost and feasibility are unknown is stated with it.
 */
export function mitigationOutcome({ original, mitigated, applied = [], notes = [] }) {
  const improvement = Number((mitigated.delta.netContributionUSD - original.delta.netContributionUSD).toFixed(2));
  return Object.freeze({
    applied: Object.freeze(applied.map(entry => entry.id)),
    assumptions: Object.freeze([...notes]),
    netImprovementUSD: improvement,
    unrecoveredAvoided: Number((original.delta.unrecovered - mitigated.delta.unrecovered).toFixed(1)),
    remainingNetImpactUSD: mitigated.delta.netContributionUSD,
    /** No mitigation here carries a cost or a delivery assumption, so none of them is "best". */
    implementationCostUSD: null,
    caveat: 'Implementation cost and feasibility are not modelled, so a larger improvement does not '
      + 'by itself make a measure preferable.',
  });
}
