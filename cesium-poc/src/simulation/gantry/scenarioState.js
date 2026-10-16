/**
 * What a what-if scenario IS, before anything is run.
 *
 * A scenario is a question — "suppose this antenna stopped reading" — and this module holds the
 * question only. It never touches the equipment inventory, and running it (`scenarioEngine`)
 * produces a separate result rather than writing anything back. That separation is the point: the
 * synthetic baseline on an asset is what the twin says the asset's condition is, and no scenario
 * may quietly become that.
 *
 * Pure and frozen: every change returns a new scenario, so a result computed from one can never be
 * altered underneath by a later edit.
 */

/** A scenario's life. Running is instantaneous here — a two-hour scenario does not take two hours. */
export const SCENARIO_STATUSES = Object.freeze(['DRAFT', 'RUNNING', 'COMPLETED', 'CANCELLED']);

/** The scenario kinds this engine knows. Only one in Phase 1; the field exists so the next fits. */
export const SCENARIO_TYPES = Object.freeze({ EQUIPMENT_FAILURE: 'EQUIPMENT_FAILURE' });

/**
 * How a piece of equipment can fail, and what each mode needs to be specific.
 *
 * `appliesTo` is the equipment this mode means anything for. A structural member does not have a
 * communication link to lose, and a painted sign does not degrade to 70% effectiveness — asking
 * for either produces a validation error rather than a number nobody can defend.
 */
export const DEVICE_TYPES = Object.freeze([
  'RFID_ANTENNA', 'VES_CAMERA', 'TOLL_CAMERA', 'CCTV_CAMERA', 'DIGITAL_SIGN', 'UNCLASSIFIED',
]);

export const FAILURE_MODES = Object.freeze({
  COMPLETE_FAILURE: Object.freeze({
    id: 'COMPLETE_FAILURE', label: 'Complete failure',
    description: 'The equipment is completely unavailable.',
    simulatedStatus: 'FAILED', parameter: null, appliesTo: DEVICE_TYPES,
  }),
  INTERMITTENT_FAILURE: Object.freeze({
    id: 'INTERMITTENT_FAILURE', label: 'Intermittent failure',
    description: 'The equipment works part of the time, at the stated availability.',
    simulatedStatus: 'INTERMITTENT',
    parameter: Object.freeze({ key: 'availabilityPercent', label: 'Availability', unit: '%', min: 1, max: 99, default: 60 }),
    appliesTo: DEVICE_TYPES,
  }),
  DEGRADED_PERFORMANCE: Object.freeze({
    id: 'DEGRADED_PERFORMANCE', label: 'Degraded performance',
    description: 'The equipment keeps working at reduced effectiveness.',
    simulatedStatus: 'DEGRADED',
    parameter: Object.freeze({ key: 'performancePercent', label: 'Effectiveness', unit: '%', min: 1, max: 99, default: 70 }),
    appliesTo: DEVICE_TYPES,
  }),
  COMMUNICATION_FAILURE: Object.freeze({
    id: 'COMMUNICATION_FAILURE', label: 'Communication failure',
    // Deliberately not "no revenue": a disconnected reader may still read, and what reaches the
    // back office depends on systems this twin cannot see.
    description: 'The equipment may still operate, but is disconnected from its monitoring or transaction system.',
    simulatedStatus: 'COMMUNICATION_LOST', parameter: null,
    appliesTo: Object.freeze(['RFID_ANTENNA', 'VES_CAMERA', 'TOLL_CAMERA', 'CCTV_CAMERA', 'DIGITAL_SIGN']),
  }),
  POWER_FAILURE: Object.freeze({
    id: 'POWER_FAILURE', label: 'Power failure',
    description: 'The equipment is unavailable through loss of power. It spreads only along a verified power dependency.',
    simulatedStatus: 'FAILED', parameter: null, appliesTo: DEVICE_TYPES,
  }),
});

/** Equipment this phase does not simulate: the span itself and fixed signage are not devices. */
export const UNSUPPORTED_TYPES = Object.freeze(['STRUCTURE', 'STATIC_SIGN']);

/** A scenario's duration, in minutes. A week is already far beyond what this is for. */
export const DURATION_LIMITS = Object.freeze({ min: 1, max: 10_080, default: 120 });

const pad = (value, width = 3) => String(value).padStart(width, '0');

/** `SIM-001`, `SIM-002`… Stable, and ordered by when they were made. */
export const scenarioIdFor = sequence => `SIM-${pad(Math.max(1, Math.trunc(Number(sequence) || 1)))}`;

/** The number after the last scenario, so ids keep counting across a session. */
export function nextSequence(previousId) {
  const found = /^SIM-(\d+)$/.exec(String(previousId ?? ''));
  return found ? Number(found[1]) + 1 : 1;
}

/**
 * A new, empty scenario.
 *
 * `now` is passed in rather than read from the clock so a test — and a repeat run — produces the
 * same scenario.
 */
export function createScenario({
  gantryId, name = null, durationMinutes = DURATION_LIMITS.default, sequence = 1, now = Date.now(), notes = null,
} = {}) {
  const scenarioId = scenarioIdFor(sequence);
  return Object.freeze({
    scenarioId,
    scenarioType: SCENARIO_TYPES.EQUIPMENT_FAILURE,
    gantryId: gantryId ?? null,
    name: name ?? `Scenario ${scenarioId}`,
    status: 'DRAFT',
    durationMinutes: Number(durationMinutes),
    createdAt: new Date(now).toISOString(),
    notes,
    failures: Object.freeze([]),
    // Phase 3. A scenario with none of these is exactly the Phase 1/2 scenario it always was, and
    // `failures` keeps its name so nothing saved or tested against it has to change.
    weather: null,
    trafficIncident: null,
    mitigations: Object.freeze([]),
    dataOrigin: 'SYNTHETIC',
  });
}

/** One failure, with only the parameter its mode actually takes. */
export function createFailure({ assetId, failureMode = 'COMPLETE_FAILURE', severity = 100, ...rest } = {}) {
  const mode = FAILURE_MODES[failureMode];
  const parameter = mode?.parameter;
  return Object.freeze({
    assetId: assetId == null ? null : String(assetId),
    failureMode,
    // Severity is what the UI shows for a total failure; a parameterised mode carries its own value.
    severity: Number(severity),
    ...(parameter
      ? { [parameter.key]: Number(rest[parameter.key] ?? parameter.default) }
      : {}),
  });
}

/**
 * Add a failure. An asset already in the scenario is REPLACED rather than listed twice: two
 * conflicting states for one antenna is not a scenario anyone can read.
 */
export function addFailure(scenario, failure) {
  const next = createFailure(failure);
  const others = scenario.failures.filter(item => item.assetId !== next.assetId);
  return Object.freeze({ ...scenario, failures: Object.freeze([...others, next]) });
}

export function removeFailure(scenario, assetId) {
  return Object.freeze({
    ...scenario,
    failures: Object.freeze(scenario.failures.filter(item => item.assetId !== String(assetId))),
  });
}

export function withStatus(scenario, status) {
  if (!SCENARIO_STATUSES.includes(status)) return scenario;
  return Object.freeze({ ...scenario, status });
}

/** The conditions the failures happen in. Either may be null, which is the Phase 2 scenario. */
export function withConditions(scenario, { weather, trafficIncident } = {}) {
  return Object.freeze({
    ...scenario,
    ...(weather === undefined ? {} : { weather }),
    ...(trafficIncident === undefined ? {} : { trafficIncident }),
  });
}

/** The measures being tried against it. */
export function withMitigations(scenario, mitigations = []) {
  return Object.freeze({ ...scenario, mitigations: Object.freeze([...mitigations]) });
}

/**
 * A scenario read back from storage or from another phase's shape.
 *
 * `equipmentFailures` is the name used in the Phase 3 brief and in saved files; `failures` is what
 * this engine has always called them. Both are accepted, and what comes out is always the latter.
 */
export function normaliseScenario(input = {}) {
  const base = createScenario({
    gantryId: input.gantryId, name: input.name ?? input.scenarioName,
    durationMinutes: input.durationMinutes ?? DURATION_LIMITS.default,
    now: input.createdAt ? Date.parse(input.createdAt) : Date.now(),
    notes: input.notes ?? null,
  });
  const failures = input.failures ?? input.equipmentFailures ?? [];
  return Object.freeze({
    ...base,
    scenarioId: input.scenarioId ?? base.scenarioId,
    status: SCENARIO_STATUSES.includes(input.status) ? input.status : 'DRAFT',
    failures: Object.freeze(failures.map(failure => createFailure(failure))),
    weather: input.weather ?? null,
    trafficIncident: input.trafficIncident ?? null,
    mitigations: Object.freeze([...(input.mitigations ?? [])]),
  });
}

/** Edit the scenario's own fields, never its failures. */
export function withDetails(scenario, { name, durationMinutes, notes } = {}) {
  return Object.freeze({
    ...scenario,
    ...(name === undefined ? {} : { name }),
    ...(durationMinutes === undefined ? {} : { durationMinutes: Number(durationMinutes) }),
    ...(notes === undefined ? {} : { notes }),
  });
}
