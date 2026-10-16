/**
 * The equipment-failure what-if engine.
 *
 * Most of these tests are about restraint rather than arithmetic. The engine's job is to say what a
 * scenario establishes without quietly inventing the parts nobody has measured: one antenna failing
 * is not a closed lane, a dark CCTV camera is not an outage of toll collection, and a gantry with
 * no wiring diagram has no indirect failures at all. The rest check that the baseline survives a
 * scenario untouched, and that the same question always gets the same answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addFailure, createScenario, createFailure, DURATION_LIMITS, FAILURE_MODES, nextSequence,
  removeFailure, SCENARIO_STATUSES, withDetails } from '../src/simulation/gantry/scenarioState.js';
import { ERRORS, validateScenario } from '../src/simulation/gantry/scenarioValidation.js';
import { assessZone, buildZones, propagate, ZONE_ASSESSMENT } from '../src/simulation/gantry/equipmentDependencies.js';
import { ASSESSMENT_STATUS, runScenario } from '../src/simulation/gantry/scenarioEngine.js';
import { availablePresets, PRESETS } from '../src/simulation/gantry/scenarioPresets.js';
import { syntheticFor } from '../src/tolling/gantryEquipmentSynthetic.js';

const manifest = JSON.parse(readFileSync(
  new URL('../config/gantryEquipment/i595-gantry-1-toll-plaza.json', import.meta.url)));
/** The inventory exactly as the workspace builds it: the model, plus the synthetic baseline. */
const inventory = manifest.assets.map(asset => ({ ...asset, ...(syntheticFor(asset.assetId) ?? {}) }));
const equipment = inventory.filter(asset => asset.type !== 'STRUCTURE');

const idOf = type => equipment.find(asset => asset.type === type
  && asset.operationalStatus === 'OPERATIONAL').assetId;
const RFID = idOf('RFID_ANTENNA');
const VES = idOf('VES_CAMERA');
const CCTV = idOf('CCTV_CAMERA');
const STRUCTURE = inventory.find(asset => asset.type === 'STRUCTURE').assetId;

const draft = (failures, overrides = {}) => failures.reduce(
  (scenario, failure) => addFailure(scenario, failure),
  withDetails(createScenario({ gantryId: 'I595_G01', sequence: 1, now: 0, ...overrides }), {}));
const run = (failures, overrides = {}, context = {}) =>
  runScenario(draft(failures, overrides), { inventory, ranAt: 0, ...context });

// ------------------------------------------------------------------ the simple cases

test('a single equipment failure is reported as exactly that', () => {
  const result = run([{ assetId: RFID }]);
  assert.equal(result.valid, true);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.equipment.length, 1);
  assert.equal(result.equipment[0].assetId, RFID);
  assert.equal(result.equipment[0].baselineStatus, 'OPERATIONAL');
  assert.equal(result.equipment[0].simulatedStatus, 'FAILED');
  assert.equal(result.equipmentImpact.directFailureCount, 1);
  assert.equal(result.equipmentImpact.indirectFailureCount, 0);
  assert.match(result.equipment[0].impact.statement, /transponder detection capability is unavailable/i);
});

test('several failures in one scenario are all carried', () => {
  const result = run([{ assetId: RFID }, { assetId: VES }, { assetId: CCTV }]);
  assert.equal(result.equipment.length, 3);
  assert.deepEqual(result.equipment.map(state => state.assetId).sort(), [RFID, VES, CCTV].sort());
  assert.equal(result.equipmentImpact.directFailureCount, 3);
});

test('intermittent and degraded keep the equipment working, and say how much', () => {
  const intermittent = run([{ assetId: RFID, failureMode: 'INTERMITTENT_FAILURE', availabilityPercent: 60 }]);
  assert.equal(intermittent.equipment[0].simulatedStatus, 'INTERMITTENT');
  assert.equal(intermittent.equipment[0].availabilityPercent, 60);
  assert.equal(intermittent.equipmentImpact.directFailureCount, 0, 'intermittent is not an outage');
  assert.equal(intermittent.equipmentImpact.directImpairedCount, 1);

  const degraded = run([{ assetId: VES, failureMode: 'DEGRADED_PERFORMANCE', performancePercent: 70 }]);
  assert.equal(degraded.equipment[0].simulatedStatus, 'DEGRADED');
  assert.equal(degraded.equipment[0].performancePercent, 70);
  assert.match(degraded.equipment[0].impact.statement, /reduced/i);
});

test('a communication failure is not assumed to lose the transaction', () => {
  const result = run([{ assetId: RFID, failureMode: 'COMMUNICATION_FAILURE' }]);
  assert.equal(result.equipment[0].simulatedStatus, 'COMMUNICATION_LOST');
  assert.match(result.equipment[0].impact.statement, /may still read transponders/i);
  assert.match(result.equipment[0].impact.statement, /outside this twin/i);
  assert.equal(result.revenueImpact.status, 'NOT_CALCULATED');
});

test('a power failure spreads only along a verified dependency', () => {
  const bare = run([{ assetId: RFID, failureMode: 'POWER_FAILURE' }]);
  assert.equal(bare.equipmentImpact.indirectFailureCount, 0, 'nothing on this gantry is known to share a circuit');
  assert.ok(bare.limitations.some(line => /No verified power or communication dependencies/.test(line)));

  const links = [{ from: RFID, to: VES, kind: 'POWER', verified: true },
    { from: RFID, to: CCTV, kind: 'POWER', verified: false }];
  const wired = run([{ assetId: RFID, failureMode: 'POWER_FAILURE' }], {}, { dependencyLinks: links });
  assert.equal(wired.equipmentImpact.indirectFailureCount, 1);
  assert.equal(wired.equipment.find(state => state.origin === 'INDIRECT').assetId, VES);
  // The unverified one is reported as a possibility and counted nowhere else.
  assert.equal(wired.equipmentImpact.unverifiedDependencyCount, 1);
  assert.ok(!wired.equipment.some(state => state.assetId === CCTV));
  assert.ok(wired.limitations.some(line => /NOT counted as affected/.test(line)));
});

// ------------------------------------------------------------------ what it refuses to conclude

test('one failed antenna does not close a lane', () => {
  const result = run([{ assetId: RFID }]);
  const zone = result.tollingImpact.affectedZones[0];
  assert.equal(zone.assessment, ZONE_ASSESSMENT.UNKNOWN);
  assert.equal(zone.reason,
    'Equipment failure confirmed in scenario; tolling coverage impact not yet determined.');
  assert.equal(result.tollingImpact.assessmentStatus, ASSESSMENT_STATUS.INSUFFICIENT_COVERAGE_DATA);
  assert.equal(result.tollingImpact.verificationStatus, 'PROVISIONAL');
  assert.ok(result.limitations.some(line => /not been verified against the roadway/.test(line)));
  // And the unknown is counted as an unknown, never as a zero.
  assert.ok(result.equipmentImpact.unknownDependencyCount > 0);
});

test('a dark CCTV camera is not an outage of toll collection', () => {
  const result = run([{ assetId: CCTV }]);
  assert.match(result.equipment[0].impact.statement, /Toll collection is not automatically considered unavailable/);
  assert.equal(result.revenueImpact.status, 'NOT_CALCULATED');
  assert.equal(result.trafficImpact.status, 'NOT_CALCULATED');
});

test('a coverage rule, once supplied, is what makes a zone conclusion possible', () => {
  const zoneOf = asset => `G01_L${String(asset.laneGroup).padStart(2, '0')}_${asset.side}`;
  const antenna = equipment.find(asset => asset.type === 'RFID_ANTENNA' && asset.laneGroup != null);
  const zoneId = zoneOf(antenna);
  const sameZone = equipment.filter(asset => asset.type === 'RFID_ANTENNA' && zoneOf(asset) === zoneId);
  const rules = { [zoneId]: { coverageRule: 'MINIMUM_OPERATIONAL', minimumOperationalAssets: sameZone.length } };
  const result = run([{ assetId: antenna.assetId }], {}, { coverageRules: rules });
  const zone = result.tollingImpact.affectedZones.find(item => item.zoneId === zoneId);
  assert.equal(zone.assessment, ZONE_ASSESSMENT.UNAVAILABLE);
  assert.match(zone.reason, /against a configured minimum/);
  assert.equal(result.tollingImpact.assessmentStatus, ASSESSMENT_STATUS.ASSESSED);
});

// ------------------------------------------------------------------ validation

test('an unknown asset, a bad duration and a bad parameter are all refused', () => {
  const unknown = run([{ assetId: 'I595_G01_NOT_A_REAL_ASSET' }]);
  assert.equal(unknown.valid, false);
  assert.equal(unknown.status, 'CANCELLED');
  assert.equal(unknown.errors[0].code, ERRORS.UNKNOWN_ASSET);

  assert.equal(validateScenario(draft([{ assetId: RFID }], { durationMinutes: 0 }), inventory).valid, false);
  assert.equal(validateScenario(draft([{ assetId: RFID }], { durationMinutes: DURATION_LIMITS.max + 1 }), inventory)
    .errors[0].code, ERRORS.BAD_DURATION);
  assert.equal(validateScenario(
    draft([{ assetId: RFID, failureMode: 'INTERMITTENT_FAILURE', availabilityPercent: 150 }]), inventory)
    .errors[0].code, ERRORS.BAD_PARAMETER);
  assert.equal(validateScenario({ ...draft([]), failures: [{ assetId: RFID, failureMode: 'MELTED', severity: 100 }] },
    inventory).errors[0].code, ERRORS.UNKNOWN_MODE);
  assert.equal(validateScenario(draft([]), inventory).errors[0].code, ERRORS.NO_FAILURES);
  const severity = validateScenario({ ...draft([]), failures: [createFailure({ assetId: RFID, severity: 300 })] },
    inventory);
  assert.equal(severity.errors[0].code, ERRORS.BAD_SEVERITY);
});

test('the gantry structure is not simulated in this phase', () => {
  const result = run([{ assetId: STRUCTURE }]);
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, ERRORS.UNSUPPORTED_FOR_TYPE);
  assert.match(result.errors[0].message, /gantry structure/);
});

test('one asset holds one state: a repeat replaces rather than stacking', () => {
  let scenario = draft([{ assetId: RFID, failureMode: 'COMPLETE_FAILURE' }]);
  scenario = addFailure(scenario, { assetId: RFID, failureMode: 'DEGRADED_PERFORMANCE', performancePercent: 50 });
  assert.equal(scenario.failures.length, 1);
  assert.equal(scenario.failures[0].failureMode, 'DEGRADED_PERFORMANCE');
  // A hand-built duplicate is refused rather than silently merged.
  const duplicated = { ...scenario, failures: [...scenario.failures, { assetId: RFID, failureMode: 'COMPLETE_FAILURE', severity: 100 }] };
  assert.equal(validateScenario(duplicated, inventory).errors[0].code, ERRORS.DUPLICATE_ASSET);
});

test('simulating something already failed is allowed, and says so', () => {
  const alreadyFailed = equipment.find(asset => asset.operationalStatus === 'FAILED');
  const result = run([{ assetId: alreadyFailed.assetId }]);
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some(warning => warning.code === 'ALREADY_FAILED'));
  assert.ok(result.limitations.some(line => /already failed in the synthetic baseline/.test(line)));
});

// ------------------------------------------------------------------ isolation and determinism

test('running a scenario changes nothing in the inventory', () => {
  const before = JSON.stringify(inventory);
  const result = run([{ assetId: RFID }, { assetId: VES, failureMode: 'DEGRADED_PERFORMANCE' }]);
  assert.equal(JSON.stringify(inventory), before, 'the source records are untouched');
  // The baseline travels in the result instead of being overwritten in the record.
  assert.equal(result.equipment[0].baselineStatus, 'OPERATIONAL');
  assert.equal(inventory.find(asset => asset.assetId === RFID).operationalStatus, 'OPERATIONAL');
});

test('scenarios do not inherit each other\'s failures', () => {
  const first = draft([{ assetId: RFID }, { assetId: VES }]);
  const second = createScenario({ gantryId: 'I595_G01', sequence: nextSequence(first.scenarioId), now: 0 });
  assert.equal(second.failures.length, 0);
  assert.equal(second.scenarioId, 'SIM-002');
  assert.equal(first.failures.length, 2, 'the first scenario is unchanged by the second');
  assert.equal(removeFailure(first, RFID).failures.length, 1);
  assert.equal(first.failures.length, 2, 'removing returns a new scenario rather than editing one');
});

test('the same question gets the same answer', () => {
  const once = run([{ assetId: RFID }, { assetId: VES, failureMode: 'INTERMITTENT_FAILURE', availabilityPercent: 60 }]);
  const twice = run([{ assetId: RFID }, { assetId: VES, failureMode: 'INTERMITTENT_FAILURE', availabilityPercent: 60 }]);
  assert.deepEqual(once, twice);
});

test('a scenario carries its own identity and life cycle', () => {
  const scenario = draft([{ assetId: RFID }]);
  assert.equal(scenario.scenarioId, 'SIM-001');
  assert.equal(scenario.scenarioType, 'EQUIPMENT_FAILURE');
  assert.equal(scenario.status, 'DRAFT');
  assert.equal(scenario.createdAt, '1970-01-01T00:00:00.000Z');
  for (const status of ['DRAFT', 'RUNNING', 'COMPLETED', 'CANCELLED']) assert.ok(SCENARIO_STATUSES.includes(status));
});

// ------------------------------------------------------------------ zones and presets

test('zones are built from the model\'s grouping and marked provisional', () => {
  const { zones, ungroupedAssetIds } = buildZones(equipment);
  assert.ok(zones.length >= 6);
  for (const zone of zones) {
    assert.equal(zone.verificationStatus, 'PROVISIONAL');
    assert.equal(zone.coverageRule, 'UNKNOWN');
    assert.equal(zone.minimumOperationalAssets, null);
  }
  // Equipment the model does not place in a group is listed apart, never assigned to a likely zone.
  assert.ok(ungroupedAssetIds.length > 0);
  assert.equal(assessZone(zones[0], new Set(), new Set()).assessment, ZONE_ASSESSMENT.UNAFFECTED);
  assert.deepEqual(propagate([RFID], [], { modes: { [RFID]: 'POWER_FAILURE' } }).affected, []);
});

test('every preset names equipment that exists, and none of them runs itself', () => {
  const presets = availablePresets(equipment, { gantryId: 'I595_G01', sequence: 1, now: 0 });
  assert.equal(presets.length, PRESETS.length, 'this gantry can build all of them');
  const ids = new Set(equipment.map(asset => asset.assetId));
  for (const preset of presets) {
    assert.equal(preset.scenario.status, 'DRAFT', `${preset.id} must not run itself`);
    assert.ok(preset.scenario.failures.length > 0);
    for (const failure of preset.scenario.failures) {
      assert.ok(ids.has(failure.assetId), `${preset.id} names ${failure.assetId}, which does not exist`);
      assert.ok(FAILURE_MODES[failure.failureMode]);
    }
    assert.equal(runScenario(preset.scenario, { inventory, ranAt: 0 }).valid, true, `${preset.id} must be runnable`);
  }
  // A gantry without cameras simply offers fewer presets.
  assert.ok(availablePresets(equipment.filter(asset => asset.type === 'RFID_ANTENNA'),
    { gantryId: 'I595_G01' }).length < PRESETS.length);
});

test('the result is shaped for the modules that will consume it', () => {
  const result = run([{ assetId: RFID }]);
  assert.deepEqual(Object.keys(result.equipmentImpact).sort(),
    ['directFailureCount', 'directImpairedCount', 'incrementalFailureCount', 'incrementalImpairedCount',
      'indirectFailureCount', 'noAdditionalImpactCount', 'unknownDependencyCount',
      'unverifiedDependencyCount'].sort());
  assert.equal(result.revenueImpact.status, 'NOT_CALCULATED');
  assert.equal(result.trafficImpact.status, 'NOT_CALCULATED');
  // No financial or traffic figure appears anywhere in the result.
  const text = JSON.stringify(result);
  assert.ok(!/\$|USD|vehicles|transactions per/i.test(text), 'no fabricated money or traffic');
  assert.ok(result.comparison.some(row => row.metric === 'Tolling-zone capability'
    && row.baseline === 'Not assessed' && /Unknown pending coverage rules/.test(row.scenario)));
});

// ------------------------------------------------------------------ baseline, mode and effect

test('a failure mode is never printed as if it were a status', () => {
  const degraded = equipment.find(asset => asset.operationalStatus === 'DEGRADED');
  const result = run([{ assetId: degraded.assetId, failureMode: 'INTERMITTENT_FAILURE', availabilityPercent: 60 }]);
  const state = result.equipment[0];
  // Three separate facts, and the status is never improved by the scenario.
  assert.equal(state.baselineStatus, 'DEGRADED');
  assert.equal(state.modeStatus, 'INTERMITTENT');
  assert.equal(state.simulatedStatus, 'DEGRADED', 'an intermittent fault does not "upgrade" a degraded asset');
  assert.equal(state.modeLabel, 'Intermittent failure · 60%');
  assert.equal(state.change, 'NO_CHANGE');
  assert.equal(result.equipmentImpact.incrementalImpairedCount, 0);
  assert.equal(result.equipmentImpact.noAdditionalImpactCount, 1);
});

test('failing something already failed adds no outage, and says so', () => {
  const alreadyFailed = equipment.find(asset => asset.operationalStatus === 'FAILED');
  const result = run([{ assetId: alreadyFailed.assetId, failureMode: 'COMPLETE_FAILURE' }]);
  const state = result.equipment[0];
  assert.equal(state.baselineStatus, 'FAILED');
  assert.equal(state.simulatedStatus, 'FAILED');
  assert.equal(state.change, 'NO_CHANGE');
  assert.equal(result.equipmentImpact.directFailureCount, 1, 'it is failed in the scenario…');
  assert.equal(result.equipmentImpact.incrementalFailureCount, 0, '…but the scenario did not fail it');
  assert.match(state.impact.statement, /adds no further loss of capability/);
  assert.ok(result.limitations.some(line => /adds no further loss of capability/.test(line)));
});

test('a degraded asset pushed to complete failure is counted as newly failed', () => {
  const degraded = equipment.find(asset => asset.operationalStatus === 'DEGRADED');
  const result = run([{ assetId: degraded.assetId, failureMode: 'COMPLETE_FAILURE' }]);
  assert.equal(result.equipment[0].simulatedStatus, 'FAILED');
  assert.equal(result.equipment[0].change, 'WORSE');
  assert.equal(result.equipmentImpact.incrementalFailureCount, 1);
  const row = result.comparison.find(item => item.metric === 'Newly failed by this scenario');
  assert.equal(row.scenario, '1');
});

test('the regression set: normal, degraded, already failed, and two at once', () => {
  const operational = equipment.find(asset => asset.operationalStatus === 'OPERATIONAL');
  const degraded = equipment.find(asset => asset.operationalStatus === 'DEGRADED');
  const failed = equipment.find(asset => asset.operationalStatus === 'FAILED');

  assert.equal(run([{ assetId: operational.assetId }]).equipmentImpact.incrementalFailureCount, 1);
  assert.equal(run([{ assetId: degraded.assetId }]).equipmentImpact.incrementalFailureCount, 1);
  assert.equal(run([{ assetId: failed.assetId }]).equipmentImpact.incrementalFailureCount, 0);

  const both = run([{ assetId: operational.assetId }, { assetId: failed.assetId }]);
  assert.equal(both.equipment.length, 2);
  assert.equal(both.equipmentImpact.directFailureCount, 2);
  assert.equal(both.equipmentImpact.incrementalFailureCount, 1, 'only one of the two is a new outage');
  assert.equal(both.equipmentImpact.noAdditionalImpactCount, 1);
});
