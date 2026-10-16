/**
 * The synthetic financial layer.
 *
 * Every figure here rests on assumptions nobody has validated against this gantry, so most of
 * these tests are about the model refusing to overstate itself: a failed read is not a lost toll,
 * a dark surveillance camera costs nothing in revenue, an already-failed asset produces no
 * incremental loss, and a zone whose coverage nobody has configured is reported as unassessed
 * rather than as unaffected.
 *
 * The rest are the invariants that make the arithmetic trustworthy: outcomes reconcile with
 * crossings, nothing is counted twice, and the same question always gets the same answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runScenario } from '../src/simulation/gantry/scenarioEngine.js';
import { addFailure, createScenario } from '../src/simulation/gantry/scenarioState.js';
import { buildSyntheticZones, COVERAGE_MODEL, DEMO_COVERAGE } from '../src/simulation/gantry/tollingZones.js';
import { DEMO_BASELINE, validateBaseline, VIDEO_CHARGE, withAssumption }
  from '../src/simulation/gantry/syntheticTollingBaseline.js';
import { demandForDuration, demandFromCrossings } from '../src/simulation/gantry/vehicleDemand.js';
import { deviceEffectiveness, zoneCapability } from '../src/simulation/gantry/transactionEngine.js';
import { FINANCIAL_STATUS } from '../src/simulation/gantry/revenueEngine.js';
import { syntheticFor } from '../src/tolling/gantryEquipmentSynthetic.js';

const manifest = JSON.parse(readFileSync(
  new URL('../config/gantryEquipment/i595-gantry-1-toll-plaza.json', import.meta.url)));
const inventory = manifest.assets
  .map(asset => ({ ...asset, ...(syntheticFor(asset.assetId) ?? {}) }))
  .filter(asset => asset.type !== 'STRUCTURE');
const { tollingZones } = buildSyntheticZones(inventory);

const assetOf = (type, status = 'OPERATIONAL') =>
  inventory.find(asset => asset.type === type && asset.operationalStatus === status);
const statusOf = assetId => inventory.find(asset => asset.assetId === assetId)?.operationalStatus;
/**
 * A zone whose equipment is all working in the baseline.
 *
 * Eight assets are already failed before any scenario, and several share a zone — simulating a
 * failure there would correctly change nothing, which is a different test from this one.
 */
const healthyZone = () => tollingZones.find(zone => zone.rfidAssetIds.length > 1
  && zone.vesAssetIds.length
  && [...zone.rfidAssetIds, ...zone.vesAssetIds].every(id => statusOf(id) === 'OPERATIONAL'));
/** An antenna in such a zone, so redundancy is actually exercised. */
const redundantAntenna = () => inventory.find(asset => asset.assetId === healthyZone().rfidAssetIds[0]);

const run = (failures, { durationMinutes = 120, baseline = DEMO_BASELINE, zones = tollingZones } = {}) => {
  let scenario = createScenario({ gantryId: 'I595_G01', sequence: 1, now: 0, durationMinutes });
  for (const failure of failures) scenario = addFailure(scenario, failure);
  return runScenario(scenario, { inventory, ranAt: 0, tolling: { baseline, zones } });
};
const financial = (...args) => run(...args).revenueImpact;

// ------------------------------------------------------------------ the baseline itself

test('the baseline run uses the conditions the equipment is already in', () => {
  const money = financial([{ assetId: assetOf('CCTV_CAMERA').assetId }]);
  // Eight assets are failed in the synthetic baseline, so the baseline is NOT a perfect gantry.
  const baselineFailed = inventory.filter(asset => asset.operationalStatus === 'FAILED');
  assert.ok(baselineFailed.length > 0);
  assert.equal(money.baseline.transactions.crossings, 2400, '1200/h for two hours');
  assert.ok(money.baseline.transactions.rfidSuccess < 2400 * 0.85 * 0.98,
    'the already-failed antennas cost the baseline some reads');
  assert.equal(money.dataOrigin, 'SYNTHETIC');
});

test('transaction outcomes reconcile with the vehicles that crossed', () => {
  const money = financial([{ assetId: redundantAntenna().assetId }]);
  for (const run_ of [money.baseline, money.scenario]) {
    const { crossings, rfidSuccess, videoAttempts, videoRecovered, unrecovered } = run_.transactions;
    // Read by transponder, or sent to video. Nothing else, and nothing twice.
    assert.ok(Math.abs(rfidSuccess + videoAttempts - crossings) < 0.5);
    assert.ok(Math.abs(videoRecovered + unrecovered - videoAttempts) < 0.5);
    for (const value of Object.values(run_.transactions)) assert.ok(value >= 0, 'no negative transactions');
    assert.ok(run_.money.collectedRevenueUSD <= run_.money.grossRevenueUSD + 0.01);
    // Unrecovered revenue is the gap in collection, never an extra charge on top of it.
    assert.ok(Math.abs(run_.money.grossRevenueUSD - run_.money.collectedRevenueUSD
      - run_.money.unrecoveredRevenueUSD) < 0.01);
  }
});

test('processing costs follow the transactions, and the charge basis is stated', () => {
  const money = financial([{ assetId: redundantAntenna().assetId }]);
  const run_ = money.scenario;
  assert.equal(money.videoProcessingCharge, VIDEO_CHARGE.PER_ATTEMPT);
  assert.ok(Math.abs(run_.money.rfidProcessingCostUSD
    - run_.transactions.rfidSuccess * DEMO_BASELINE.tolling.rfidProcessingCostUSD) < 0.1);
  assert.ok(Math.abs(run_.money.videoProcessingCostUSD
    - run_.transactions.videoAttempts * DEMO_BASELINE.tolling.videoProcessingCostUSD) < 0.1);
  assert.ok(Math.abs(run_.money.netContributionUSD
    - (run_.money.collectedRevenueUSD - run_.money.processingCostUSD)) < 0.01);

  // Per recovered is the other definition, and it is used consistently when chosen.
  const perRecovered = financial([{ assetId: redundantAntenna().assetId }], {
    baseline: withAssumption(DEMO_BASELINE, 'tolling.videoProcessingCharge', VIDEO_CHARGE.PER_RECOVERED) });
  assert.ok(perRecovered.scenario.money.videoProcessingCostUSD < run_.money.videoProcessingCostUSD);
});

// ------------------------------------------------------------------ what a failure does

test('an RFID failure moves transactions to video rather than losing them all', () => {
  const money = financial([{ assetId: redundantAntenna().assetId }]);
  assert.equal(money.status, FINANCIAL_STATUS.CALCULATED_SYNTHETIC);
  assert.ok(money.delta.rfidSuccess < 0, 'fewer transponder reads');
  assert.ok(money.delta.videoAttempts > 0, 'more video attempts');
  assert.ok(money.delta.videoRecovered > 0, 'most of them are still collected');
  // The loss is far smaller than the shift: that is the whole point of the fallback.
  assert.ok(money.delta.unrecovered < money.delta.videoAttempts,
    'a failed read is not automatically a lost toll');
  assert.ok(money.delta.processingCostUSD > 0, 'video processing costs more');
  assert.ok(money.delta.netContributionUSD < 0);
});

test('with no video recovery at all, the same failure loses the whole shifted amount', () => {
  const noRecovery = withAssumption(DEMO_BASELINE, 'tolling.videoCollectionRecoveryRate', 0);
  const money = financial([{ assetId: redundantAntenna().assetId }], { baseline: noRecovery });
  assert.equal(money.scenario.transactions.videoRecovered, 0);
  assert.ok(Math.abs(money.delta.unrecovered - money.delta.videoAttempts) < 0.5);
  assert.ok(money.delta.collectedRevenueUSD < 0);
});

test('a VES camera failure changes capture, not transponder reading', () => {
  const zone = healthyZone();
  const camera = inventory.find(asset => asset.assetId === zone.vesAssetIds[0]);
  const money = financial([{ assetId: camera.assetId }]);
  assert.equal(money.delta.rfidSuccess, 0, 'reading is untouched by a camera');
  assert.equal(money.delta.videoAttempts, 0, 'the same vehicles still fall back to video');
  assert.ok(money.delta.unrecovered > 0, 'fewer of them are captured, so more go unrecovered');
  assert.ok(money.delta.netContributionUSD < 0);
});

test('an RFID and a camera in the same zone combine without double counting', () => {
  const zone = healthyZone();
  const money = financial([{ assetId: zone.rfidAssetIds[0] }, { assetId: zone.vesAssetIds[0] }]);
  const { crossings, rfidSuccess, videoAttempts, videoRecovered, unrecovered } = money.scenario.transactions;
  assert.ok(Math.abs(rfidSuccess + videoAttempts - crossings) < 0.5);
  assert.ok(Math.abs(videoRecovered + unrecovered - videoAttempts) < 0.5);
  // Worse than either alone. The two interact rather than add: the antenna sends more vehicles to
  // video AND the camera captures fewer of them, so the combined loss is larger than the sum —
  // which is the model working, not a double count. The reconciliation above is what rules that out.
  const rfidOnly = financial([{ assetId: zone.rfidAssetIds[0] }]);
  const cameraOnly = financial([{ assetId: zone.vesAssetIds[0] }]);
  assert.ok(money.delta.unrecovered > rfidOnly.delta.unrecovered);
  assert.ok(money.delta.unrecovered > cameraOnly.delta.unrecovered);
  assert.equal(money.delta.crossings, 0, 'the same vehicles crossed either way');
  assert.ok(money.scenario.transactions.unrecovered <= money.scenario.transactions.videoAttempts + 0.5);
});

test('a CCTV failure costs nothing in toll collection', () => {
  const money = financial([{ assetId: assetOf('CCTV_CAMERA').assetId }]);
  assert.equal(money.delta.rfidSuccess, 0);
  assert.equal(money.delta.videoAttempts, 0);
  assert.equal(money.delta.unrecovered, 0);
  assert.equal(money.delta.netContributionUSD, 0);
  assert.ok(money.outsideFinancialModel.includes(assetOf('CCTV_CAMERA').assetId));
  assert.match(money.explanation.join(' '), /not reduced by it|unchanged/i);
});

test('intermittent and degraded are translated through coverage, not applied to tolls directly', () => {
  const antenna = redundantAntenna();
  const intermittent = financial([{ assetId: antenna.assetId, failureMode: 'INTERMITTENT_FAILURE', availabilityPercent: 60 }]);
  const complete = financial([{ assetId: antenna.assetId }]);
  assert.ok(intermittent.delta.rfidSuccess < 0);
  assert.ok(Math.abs(intermittent.delta.rfidSuccess) < Math.abs(complete.delta.rfidSuccess),
    'partial availability is less damaging than total failure');
  // 60% available is NOT 40% of tolls lost.
  const lostShare = Math.abs(intermittent.delta.collectedRevenueUSD) / intermittent.baseline.money.collectedRevenueUSD;
  assert.ok(lostShare < 0.4, `collected revenue fell by ${(lostShare * 100).toFixed(1)}%, which must not track availability`);

  const degraded = financial([{ assetId: antenna.assetId, failureMode: 'DEGRADED_PERFORMANCE', performancePercent: 70 }]);
  assert.ok(degraded.delta.rfidSuccess < 0);
  assert.ok(Math.abs(degraded.delta.rfidSuccess) < Math.abs(complete.delta.rfidSuccess));
});

test('failing something already failed produces no incremental financial impact', () => {
  const failed = inventory.find(asset => asset.operationalStatus === 'FAILED' && asset.type === 'RFID_ANTENNA');
  const money = financial([{ assetId: failed.assetId }]);
  assert.equal(money.delta.rfidSuccess, 0);
  assert.equal(money.delta.videoAttempts, 0);
  assert.equal(money.delta.unrecovered, 0);
  assert.equal(money.delta.netContributionUSD, 0, 'no fictitious incremental loss');
  // And the baseline already reflects that outage, rather than pretending the gantry was perfect.
  assert.ok(money.baseline.transactions.unrecovered > 0);
});

// ------------------------------------------------------------------ duration, determinism, inputs

test('a longer scenario is a bigger exposure, at the configured constant rate', () => {
  const antenna = redundantAntenna();
  const half = financial([{ assetId: antenna.assetId }], { durationMinutes: 30 });
  const long = financial([{ assetId: antenna.assetId }], { durationMinutes: 120 });
  assert.equal(half.baseline.transactions.crossings, 600);
  assert.equal(long.baseline.transactions.crossings, 2400);
  assert.ok(Math.abs(long.delta.netContributionUSD - half.delta.netContributionUSD * 4) < 0.05,
    'four times the window, four times the effect under a constant rate');
  assert.equal(half.demand.basis, 'CONSTANT_RATE');
});

test('identical conditions on both sides produce exactly zero', () => {
  // A scenario that changes nothing: the asset is already under maintenance, simulated as degraded.
  const maintained = inventory.find(asset => asset.operationalStatus === 'UNDER_MAINTENANCE');
  const money = financial([{ assetId: maintained.assetId, failureMode: 'DEGRADED_PERFORMANCE', performancePercent: 70 }]);
  assert.equal(money.delta.netContributionUSD, 0);
  assert.equal(money.delta.collectedRevenueUSD, 0);
  assert.equal(money.delta.processingCostUSD, 0);
});

test('the same question always gets the same answer', () => {
  const antenna = redundantAntenna();
  assert.deepEqual(financial([{ assetId: antenna.assetId }]), financial([{ assetId: antenna.assetId }]));
});

test('running a scenario leaves the equipment inventory untouched', () => {
  const before = JSON.stringify(inventory);
  financial([{ assetId: redundantAntenna().assetId }]);
  assert.equal(JSON.stringify(inventory), before);
});

// ------------------------------------------------------------------ the limits of the model

test('a zone with no coverage rule is not assessed, rather than treated as unaffected', () => {
  const zone = healthyZone();
  const blind = tollingZones.map(item => (item.zoneId === zone.zoneId
    ? { ...item, rfidCoverageModel: { type: COVERAGE_MODEL.UNKNOWN } } : item));
  const money = financial([{ assetId: zone.rfidAssetIds[0] }], { zones: blind });
  assert.equal(money.status, FINANCIAL_STATUS.PARTIALLY_ASSESSED);
  assert.ok(money.notAssessedZoneIds.includes(zone.zoneId));
  assert.ok(money.excludedCrossings > 0, 'the vehicles in that zone are excluded, not silently zeroed');
  assert.ok(money.missingAssumptions.some(line => /coverage rule/.test(line)));
  assert.match(money.explanation.join(' '), /could not be assessed/);
});

test('a disconnected antenna is not guessed at', () => {
  const antenna = redundantAntenna();
  const money = financial([{ assetId: antenna.assetId, failureMode: 'COMMUNICATION_FAILURE' }]);
  assert.ok(money.missingAssumptions.some(line => /disconnected antenna/.test(line)));
  assert.equal(money.status, FINANCIAL_STATUS.PARTIALLY_ASSESSED);
  // Supplying the missing assumption makes the same scenario calculable.
  const configured = financial([{ assetId: antenna.assetId, failureMode: 'COMMUNICATION_FAILURE' }],
    { baseline: withAssumption(DEMO_BASELINE, 'tolling.communicationDeliveryShare', 0) });
  assert.equal(configured.status, FINANCIAL_STATUS.CALCULATED_SYNTHETIC);
  assert.ok(configured.delta.rfidSuccess < 0);
});

test('invalid assumptions are refused rather than calculated with', () => {
  for (const [path, value] of [['tolling.rfidEquippedShare', 1.4], ['tolling.averageTollUSD', -1],
    ['traffic.vehiclesPerHour', -5], ['tolling.videoCollectionRecoveryRate', 2]]) {
    const broken = withAssumption(DEMO_BASELINE, path, value);
    assert.equal(validateBaseline(broken).valid, false, `${path} = ${value} must be refused`);
    const money = financial([{ assetId: redundantAntenna().assetId }], { baseline: broken });
    assert.equal(money.status, FINANCIAL_STATUS.NOT_ASSESSED);
    assert.ok(money.missingAssumptions.length > 0);
  }
  assert.equal(validateBaseline(DEMO_BASELINE).valid, true);
});

test('the zone model allocates all the demand and invents no coverage', () => {
  const total = tollingZones.reduce((sum, zone) => sum + zone.demandShare, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, 'the shares add to 100%');
  for (const zone of tollingZones) {
    assert.equal(zone.verificationStatus, 'SYNTHETIC_ASSUMPTION');
    assert.equal(zone.rfidCoverageModel.type, 'CONFIGURED_DEMO');
  }
  // Equipment outside any group is listed, not assigned to a plausible zone.
  const { unzonedAssetIds } = buildSyntheticZones(inventory);
  assert.ok(unzonedAssetIds.length > 0);
  assert.ok(unzonedAssetIds.every(id => !tollingZones.some(zone =>
    zone.rfidAssetIds.includes(id) || zone.vesAssetIds.includes(id))));
});

test('the coverage rule is redundancy, not a count of broken parts', () => {
  // One of two antennas out leaves the configured single-failure capability, not half.
  assert.equal(zoneCapability([1, 0], { single: DEMO_COVERAGE.singleFailureReadSuccessMultiplier, allFailed: 0 }), 0.6);
  assert.equal(zoneCapability([1, 1], { single: 0.6, allFailed: 0 }), 1);
  assert.equal(zoneCapability([0, 0], { single: 0.6, allFailed: 0 }), 0);
  assert.equal(zoneCapability([0.6, 1], { single: 0.6, allFailed: 0 }), 0.8, 'otherwise the mean, and said to be');
  assert.equal(zoneCapability([null, 1], { single: 0.6, allFailed: 0 }), null, 'an unknown stays unknown');
  assert.equal(deviceEffectiveness({ simulatedStatus: 'FAILED' }), 0);
  assert.equal(deviceEffectiveness({ simulatedStatus: 'INTERMITTENT', availabilityPercent: 60 }), 0.6);
  assert.equal(deviceEffectiveness({ simulatedStatus: 'COMMUNICATION_LOST' }), null);
  assert.equal(deviceEffectiveness({ simulatedStatus: 'OPERATIONAL' }), 1);
});

test('demand can come from crossing events, ready for SUMO', () => {
  const events = [
    { vehicleId: 'V1', tollingZoneId: 'G01_L06_A', tollEligible: true },
    { vehicleId: 'V2', tollingZoneId: 'G01_L06_A', tollEligible: true },
    { vehicleId: 'V3', tollingZoneId: 'G01_L06_A', tollEligible: false },
  ];
  const demand = demandFromCrossings(events, { durationMinutes: 60 });
  assert.equal(demand.total, 2, 'an ineligible vehicle is not a toll crossing');
  assert.equal(demand.byZone.G01_L06_A, 2);
  assert.equal(demand.basis, 'CROSSING_EVENTS');
  // The same shape the constant-rate model produces, so the engine cannot tell them apart.
  const rate = demandForDuration({ zones: tollingZones, vehiclesPerHour: 1200, durationMinutes: 60 });
  assert.deepEqual(Object.keys(demand).sort(), Object.keys(rate).sort());
});

test('without the financial assumptions, a Phase 1 result is exactly what it was', () => {
  let scenario = createScenario({ gantryId: 'I595_G01', sequence: 1, now: 0 });
  scenario = addFailure(scenario, { assetId: redundantAntenna().assetId });
  const result = runScenario(scenario, { inventory, ranAt: 0 });
  assert.deepEqual(result.revenueImpact, { status: 'NOT_CALCULATED' });
  assert.equal(result.trafficImpact.status, 'NOT_CALCULATED');
});

test('a degraded asset in the baseline is measured by its health, not treated as dead', () => {
  const degradedCamera = inventory.find(asset => asset.type === 'VES_CAMERA'
    && asset.operationalStatus === 'DEGRADED' && asset.health?.score > 0);
  if (!degradedCamera) return;
  const zone = tollingZones.find(item => item.vesAssetIds.includes(degradedCamera.assetId));
  const antenna = zone.rfidAssetIds.map(id => inventory.find(asset => asset.assetId === id))
    .find(asset => asset.operationalStatus === 'OPERATIONAL');
  if (!antenna) return;
  const money = financial([{ assetId: antenna.assetId }]);
  // Its camera still captures some of the extra traffic, so the fallback still recovers some of it.
  assert.ok(money.delta.videoAttempts > 0);
  assert.ok(money.delta.videoRecovered > 0,
    'a camera degraded in the baseline must still capture, or the baseline itself is wrong');
  assert.ok(money.delta.unrecovered < money.delta.videoAttempts);
  assert.equal(money.status, FINANCIAL_STATUS.CALCULATED_SYNTHETIC);
});

test('a degraded device with no health figure at all is not assessed', () => {
  const zone = healthyZone();
  const stripped = inventory.map(asset => (asset.assetId === zone.vesAssetIds[0]
    ? { ...asset, operationalStatus: 'DEGRADED', health: null } : asset));
  let scenario = createScenario({ gantryId: 'I595_G01', sequence: 1, now: 0, durationMinutes: 120 });
  scenario = addFailure(scenario, { assetId: zone.rfidAssetIds[0] });
  const money = runScenario(scenario, {
    inventory: stripped, ranAt: 0, tolling: { baseline: DEMO_BASELINE, zones: tollingZones } }).revenueImpact;
  assert.equal(money.status, FINANCIAL_STATUS.PARTIALLY_ASSESSED);
  assert.ok(money.notAssessedZoneIds.includes(zone.zoneId));
  assert.ok(money.missingAssumptions.some(line => /how well a degraded camera still performs/.test(line)),
    'the reason names the device and why, not a generic unknown');
});
