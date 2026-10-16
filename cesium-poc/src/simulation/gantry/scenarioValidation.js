/**
 * Whether a scenario is one this engine can answer.
 *
 * Refusing early is the point: a scenario with a severity of 400, a duration of nothing, or a
 * failure mode applied to the gantry's own span would still produce a result, and that result would
 * look exactly as authoritative as a real one.
 */
import { DURATION_LIMITS, FAILURE_MODES, UNSUPPORTED_TYPES } from './scenarioState.js';

export const ERRORS = Object.freeze({
  NO_FAILURES: 'NO_FAILURES',
  UNKNOWN_ASSET: 'UNKNOWN_ASSET',
  UNKNOWN_MODE: 'UNKNOWN_MODE',
  UNSUPPORTED_FOR_TYPE: 'UNSUPPORTED_FOR_TYPE',
  DUPLICATE_ASSET: 'DUPLICATE_ASSET',
  BAD_PARAMETER: 'BAD_PARAMETER',
  BAD_DURATION: 'BAD_DURATION',
  BAD_SEVERITY: 'BAD_SEVERITY',
});

const inRange = (value, min, max) => Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max;

/**
 * @param {object} scenario
 * @param {object[]} inventory the equipment that exists
 * @returns {{valid: boolean, errors: object[], warnings: object[]}}
 */
export function validateScenario(scenario, inventory = []) {
  const errors = [];
  const warnings = [];
  const byId = new Map(inventory.map(asset => [asset.assetId, asset]));

  if (!inRange(scenario?.durationMinutes, DURATION_LIMITS.min, DURATION_LIMITS.max)) {
    errors.push({ code: ERRORS.BAD_DURATION,
      message: `Duration must be between ${DURATION_LIMITS.min} and ${DURATION_LIMITS.max} minutes.` });
  }
  const failures = scenario?.failures ?? [];
  // A scenario needs something to BE. Equipment failures were the only possibility in Phase 1;
  // weather and a traffic incident are conditions in their own right, and a scenario made of only
  // one of those is a perfectly good question.
  if (!failures.length && !scenario?.weather && !scenario?.trafficIncident) {
    errors.push({ code: ERRORS.NO_FAILURES,
      message: 'A scenario needs at least one equipment failure, a weather condition or an incident.' });
  }

  const seen = new Set();
  for (const failure of failures) {
    const asset = byId.get(failure.assetId);
    if (!asset) {
      errors.push({ code: ERRORS.UNKNOWN_ASSET, assetId: failure.assetId,
        message: `No equipment with id ${failure.assetId} exists on this gantry.` });
      continue;
    }
    if (seen.has(failure.assetId)) {
      errors.push({ code: ERRORS.DUPLICATE_ASSET, assetId: failure.assetId,
        message: `${failure.assetId} appears twice. One asset holds one state in a scenario.` });
      continue;
    }
    seen.add(failure.assetId);

    const mode = FAILURE_MODES[failure.failureMode];
    if (!mode) {
      errors.push({ code: ERRORS.UNKNOWN_MODE, assetId: failure.assetId,
        message: `${failure.failureMode} is not a failure mode this engine knows.` });
      continue;
    }
    // The span and the painted signage are not devices: no device failure mode means anything for
    // them, and this phase says so rather than producing a number.
    if (UNSUPPORTED_TYPES.includes(asset.type)) {
      errors.push({ code: ERRORS.UNSUPPORTED_FOR_TYPE, assetId: failure.assetId,
        message: `${asset.name ?? failure.assetId} is ${asset.type === 'STRUCTURE' ? 'the gantry structure' : 'fixed signage'}; `
          + 'equipment-failure simulation does not apply to it in this phase.' });
      continue;
    }
    if (!mode.appliesTo.includes(asset.type)) {
      errors.push({ code: ERRORS.UNSUPPORTED_FOR_TYPE, assetId: failure.assetId,
        message: `${mode.label} does not apply to ${asset.typeLabel ?? asset.type}.` });
      continue;
    }
    if (!inRange(failure.severity, 0, 100)) {
      errors.push({ code: ERRORS.BAD_SEVERITY, assetId: failure.assetId,
        message: 'Severity must be between 0 and 100.' });
    }
    const parameter = mode.parameter;
    if (parameter && !inRange(failure[parameter.key], parameter.min, parameter.max)) {
      errors.push({ code: ERRORS.BAD_PARAMETER, assetId: failure.assetId,
        message: `${parameter.label} must be between ${parameter.min} and ${parameter.max}${parameter.unit}.` });
    }
    // Worth saying, not worth refusing: simulating the failure of something already failed is a
    // legitimate question, and the answer should note that the baseline was already out.
    if (asset.operationalStatus === 'FAILED') {
      warnings.push({ code: 'ALREADY_FAILED', assetId: failure.assetId,
        message: `${asset.name ?? failure.assetId} is already failed in the synthetic baseline.` });
    }
  }

  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors), warnings: Object.freeze(warnings) });
}
