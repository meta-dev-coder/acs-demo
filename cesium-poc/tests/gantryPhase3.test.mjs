/**
 * Weather, incidents, and the two together.
 *
 * The recurring theme: a condition only does what somebody has configured it to do. Rain does not
 * touch transponder reads because no sensitivity for that was ever supplied — and that absence is
 * reported rather than shown as a measured zero. A crash does not destroy revenue; it holds
 * vehicles back, and where they went is an explicit policy. Where two conditions overlap they are
 * composed once, and the arithmetic is checked against the vehicles that actually crossed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runScenario } from '../src/simulation/gantry/scenarioEngine.js';
import { addFailure, createScenario, normaliseScenario, withConditions } from '../src/simulation/gantry/scenarioState.js';
import { buildSyntheticZones } from '../src/simulation/gantry/tollingZones.js';
import { DEMO_BASELINE } from '../src/simulation/gantry/syntheticTollingBaseline.js';
import { DEMO_SENSITIVITY, normaliseWeather, validateWeather, weatherEffectiveness, WEATHER_PRESETS }
  from '../src/simulation/gantry/weatherImpact.js';
import { crossingsOverTime, DEMAND_POLICY, INCIDENT_PRESETS, normaliseIncident, validateIncident }
  from '../src/simulation/gantry/trafficImpact.js';
import { environmentFor, runCase } from '../src/simulation/gantry/combinedScenario.js';
import { compareScenario, comparisonRows } from '../src/simulation/gantry/scenarioComparison.js';
import { applyMitigations, MITIGATIONS, mitigationOutcome } from '../src/simulation/gantry/mitigations.js';
import { deleteScenario, listScenarios, loadScenario, saveScenario } from '../src/simulation/gantry/scenarioStore.js';
import { baselineConditions } from '../src/simulation/gantry/revenueComparison.js';
import { syntheticFor } from '../src/tolling/gantryEquipmentSynthetic.js';

const manifest = JSON.parse(readFileSync(
  new URL('../config/gantryEquipment/i595-gantry-1-toll-plaza.json', import.meta.url)));
const inventory = manifest.assets
  .map(asset => ({ ...asset, ...(syntheticFor(asset.assetId) ?? {}) }))
  .filter(asset => asset.type !== 'STRUCTURE');
const { tollingZones } = buildSyntheticZones(inventory);
const statusOf = assetId => inventory.find(asset => asset.assetId === assetId)?.operationalStatus;
const healthyZone = () => tollingZones.find(zone => zone.rfidAssetIds.length > 1 && zone.vesAssetIds.length
  && [...zone.rfidAssetIds, ...zone.vesAssetIds].every(id => statusOf(id) === 'OPERATIONAL'));

const scenarioWith = ({ failures = [], weather = null, incident = null, durationMinutes = 120 } = {}) => {
  let scenario = createScenario({ gantryId: 'I595_G01', sequence: 1, now: 0, durationMinutes });
  for (const failure of failures) scenario = addFailure(scenario, failure);
  return withConditions(scenario, {
    weather: weather ? { ...normaliseWeather(weather), startOffsetMinutes: 0, durationMinutes } : null,
    trafficIncident: incident ? normaliseIncident(incident) : null,
  });
};
const run = options => runScenario(scenarioWith(options), {
  inventory, ranAt: 0, tolling: { baseline: DEMO_BASELINE, zones: tollingZones } });
const moneyOf = options => run(options).revenueImpact;

// ------------------------------------------------------------------ weather

test('clear weather is the Phase 2 answer, unchanged', () => {
  const antenna = healthyZone().rfidAssetIds[0];
  // The same failure, with and without a clear-weather condition attached: adding "it was fine
  // out" must not move a single number.
  const clear = moneyOf({ failures: [{ assetId: antenna }], weather: 'CLEAR' });
  const none = moneyOf({ failures: [{ assetId: antenna }] });
  assert.deepEqual(clear.scenario.transactions, none.scenario.transactions);
  assert.equal(clear.delta.netContributionUSD, none.delta.netContributionUSD);
  // And weather alone, with nothing to be affected, changes nothing either.
  assert.equal(moneyOf({ weather: 'CLEAR' }).delta.netContributionUSD, 0);
});

test('heavy rain reduces camera capture, and nothing else', () => {
  const rain = moneyOf({ weather: 'HEAVY_RAIN' });
  assert.equal(rain.delta.rfidSuccess, 0, 'reading is untouched: no RFID sensitivity is configured');
  assert.equal(rain.delta.videoAttempts, 0, 'the same vehicles fall back to video');
  assert.ok(rain.delta.videoRecovered < 0, 'fewer of them are captured');
  assert.ok(rain.delta.unrecovered > 0);
  assert.ok(rain.delta.netContributionUSD < 0);
  assert.equal(rain.weather.effectiveness.capture, 0.85);
  assert.equal(rain.weather.effectiveness.read, 1);
});

test('rain with no configured RFID sensitivity says so rather than showing a measured zero', () => {
  const rain = moneyOf({ weather: 'HEAVY_RAIN' });
  assert.ok(rain.missingAssumptions.some(line => /no weather sensitivity is configured/.test(line)));
  assert.ok(rain.missingAssumptions.some(line => /rfid antenna/.test(line)));
});

test('fog and thunderstorm move capture by their configured amounts', () => {
  const fog = weatherEffectiveness(normaliseWeather('DENSE_FOG'));
  const storm = weatherEffectiveness(normaliseWeather('THUNDERSTORM'));
  assert.equal(fog.byType.VES_CAMERA, 0.6);
  assert.equal(storm.byType.VES_CAMERA, 0.78);
  // Surveillance is hit harder than enforcement capture, and carries no financial path at all.
  assert.ok(fog.byType.CCTV_CAMERA < fog.byType.VES_CAMERA);
  const stormMoney = moneyOf({ weather: 'THUNDERSTORM' });
  const fogMoney = moneyOf({ weather: 'DENSE_FOG' });
  assert.ok(fogMoney.delta.unrecovered > stormMoney.delta.unrecovered, 'fog is worse for capture here');
  for (const preset of WEATHER_PRESETS) {
    const effect = weatherEffectiveness(normaliseWeather(preset.id));
    for (const value of Object.values(effect.byType)) {
      assert.ok(value >= 0 && value <= 1, `${preset.id} produced ${value}`);
    }
  }
});

test('weather is applied once, not at the device and again at the zone', () => {
  const zone = healthyZone();
  const conditions = baselineConditions(inventory);
  const rain = { ...normaliseWeather('HEAVY_RAIN'), startOffsetMinutes: 0, durationMinutes: 120 };
  const once = runCase({ zones: [zone], baseline: DEMO_BASELINE, conditions, durationMinutes: 120, weather: rain });
  const clear = runCase({ zones: [zone], baseline: DEMO_BASELINE, conditions, durationMinutes: 120 });
  const expected = clear.totals.videoRecovered * environmentFor(rain).capture;
  assert.ok(Math.abs(once.totals.videoRecovered - expected) < 1e-6,
    'recovery falls by exactly the one capture factor');
});

test('a weather window shorter than the scenario only affects its own buckets', () => {
  const half = runScenario(withConditions(createScenario({ gantryId: 'I595_G01', sequence: 1, now: 0, durationMinutes: 120 }),
    { weather: { ...normaliseWeather('HEAVY_RAIN'), startOffsetMinutes: 0, durationMinutes: 60 } }),
  { inventory, ranAt: 0, tolling: { baseline: DEMO_BASELINE, zones: tollingZones } }).revenueImpact;
  const whole = moneyOf({ weather: 'HEAVY_RAIN' });
  assert.ok(half.delta.unrecovered > 0);
  assert.ok(Math.abs(half.delta.unrecovered - whole.delta.unrecovered / 2) < 1,
    'an hour of rain in a two-hour window is half the effect');
});

// ------------------------------------------------------------------ equipment with weather

test('an RFID failure during heavy rain is worse than either alone', () => {
  const antenna = healthyZone().rfidAssetIds[0];
  const equipment = moneyOf({ failures: [{ assetId: antenna }] });
  const weather = moneyOf({ weather: 'HEAVY_RAIN' });
  const combined = moneyOf({ failures: [{ assetId: antenna }], weather: 'HEAVY_RAIN' });
  assert.ok(combined.delta.unrecovered > equipment.delta.unrecovered);
  assert.ok(combined.delta.unrecovered > weather.delta.unrecovered);
  assert.ok(combined.delta.netContributionUSD < equipment.delta.netContributionUSD);
  // Reconciliation still holds with both conditions in force.
  const totals = combined.scenario.transactions;
  assert.ok(Math.abs(totals.rfidSuccess + totals.videoAttempts - totals.crossings) < 0.5);
  assert.ok(Math.abs(totals.videoRecovered + totals.unrecovered - totals.videoAttempts) < 0.5);
});

test('a camera failure during heavy rain compounds on the same zone', () => {
  const zone = healthyZone();
  const camera = zone.vesAssetIds[0];
  const dry = moneyOf({ failures: [{ assetId: camera }] });
  const wet = moneyOf({ failures: [{ assetId: camera }], weather: 'HEAVY_RAIN' });
  assert.ok(wet.delta.unrecovered > dry.delta.unrecovered);
  assert.equal(wet.delta.rfidSuccess, 0, 'neither a camera nor rain changes transponder reading');
});

// ------------------------------------------------------------------ incidents

test('a minor crash holds vehicles back without losing them', () => {
  const money = moneyOf({ incident: { type: 'MINOR_CRASH', durationMinutes: 30 } });
  assert.ok(money.traffic.crossings < money.traffic.plannedCrossings);
  assert.ok(money.traffic.divertedCrossings > 0);
  assert.equal(money.traffic.lostCrossings, 0, 'nothing is lost under the default policy');
  assert.equal(money.traffic.policy, DEMAND_POLICY.DELAYED);
  assert.ok(money.traffic.conserved, 'every vehicle is accounted for');
});

test('a major crash defers revenue, and deferral is not loss', () => {
  const money = moneyOf({ incident: { type: 'MAJOR_CRASH', durationMinutes: 90 } });
  assert.ok(money.traffic.deferredCrossings > 0);
  assert.ok(money.traffic.deferredRevenueUSD > 0);
  // Reported apart from the unrecovered revenue, which is a collection failure, not a timing one.
  assert.notEqual(money.traffic.deferredRevenueUSD, money.delta.unrecoveredRevenueUSD);
  assert.match(money.explanation.join(' '), /deferred, not lost/);
});

test('the demand-handling policy decides where held-back vehicles go', () => {
  const diverted = moneyOf({ incident: { type: 'MAJOR_CRASH', durationMinutes: 90,
    demandHandling: { policy: DEMAND_POLICY.DIVERTED, divertedShare: 1, lostShare: 0 } } });
  assert.ok(diverted.traffic.divertedCrossings > 0);
  assert.equal(diverted.traffic.deferredCrossings, 0);

  const lost = moneyOf({ incident: { type: 'MAJOR_CRASH', durationMinutes: 90,
    demandHandling: { policy: DEMAND_POLICY.LOST, divertedShare: 0, lostShare: 1 } } });
  assert.ok(lost.traffic.lostCrossings > 0);
  assert.ok(lost.traffic.lostRevenueUSD > 0);

  const unresolved = moneyOf({ incident: { type: 'MAJOR_CRASH', durationMinutes: 90,
    demandHandling: { policy: DEMAND_POLICY.UNRESOLVED } } });
  assert.ok(unresolved.traffic.unresolvedCrossings > 0);
  assert.ok(unresolved.missingAssumptions.some(line => /no demand-handling policy/.test(line)),
    'unclassified demand is reported, not folded into a loss');
});

test('vehicles are conserved across every incident preset and policy', () => {
  for (const preset of INCIDENT_PRESETS) {
    for (const policy of Object.values(DEMAND_POLICY)) {
      const traffic = crossingsOverTime({
        totalCrossings: 2400, durationMinutes: 120,
        incident: normaliseIncident({ type: preset.id, demandHandling: { policy, divertedShare: 0.15, lostShare: 0.05 } }),
      });
      if (policy === DEMAND_POLICY.UNRESOLVED) continue;
      assert.ok(traffic.conserved, `${preset.id}/${policy} lost track of vehicles`);
      assert.ok(traffic.crossed <= 2400 + 1e-6);
      for (const bucket of traffic.buckets) assert.ok(bucket.crossed >= 0 && bucket.queued >= 0);
    }
  }
});

test('an incident and an equipment failure do not double-count the vehicles held back', () => {
  const antenna = healthyZone().rfidAssetIds[0];
  const money = moneyOf({ failures: [{ assetId: antenna }], incident: { type: 'MAJOR_CRASH', durationMinutes: 90 } });
  const totals = money.scenario.transactions;
  // The transactions are computed from the vehicles that CROSSED, which is what the incident left.
  assert.ok(Math.abs(totals.crossings - money.traffic.crossings) < 1, 'crossings come from the traffic model');
  assert.ok(Math.abs(totals.rfidSuccess + totals.videoAttempts - totals.crossings) < 0.5);
  assert.ok(money.traffic.conserved);
});

test('a longer scenario changes the exposure, bucket by bucket', () => {
  const antenna = healthyZone().rfidAssetIds[0];
  const short = moneyOf({ failures: [{ assetId: antenna }], weather: 'HEAVY_RAIN', durationMinutes: 30 });
  const long = moneyOf({ failures: [{ assetId: antenna }], weather: 'HEAVY_RAIN', durationMinutes: 120 });
  assert.equal(short.baseline.transactions.crossings, 600);
  assert.equal(long.baseline.transactions.crossings, 2400);
  assert.ok(Math.abs(long.delta.netContributionUSD - short.delta.netContributionUSD * 4) < 0.1);
  assert.equal(long.traffic.bucketMinutes, 5);
  assert.equal(long.traffic.buckets, 24, 'two hours in five-minute buckets');
});

// ------------------------------------------------------------------ comparison and mitigation

test('the three cases share one baseline and the interaction is calculated from them', () => {
  const antenna = healthyZone().rfidAssetIds[0];
  const scenario = scenarioWith({ failures: [{ assetId: antenna }], weather: 'HEAVY_RAIN' });
  const comparison = compareScenario(scenario, { inventory, zones: tollingZones, baseline: DEMO_BASELINE });
  const labels = comparison.cases.map(item => item.label);
  assert.deepEqual(labels, ['Equipment only', 'Weather only', 'Combined']);
  // One baseline, shared by all of them.
  const baselines = comparison.cases.map(item => item.money.baseline.money.netContributionUSD);
  assert.equal(new Set(baselines).size, 1);
  const [equipment, weather, combined] = comparison.cases.map(item => item.money.delta.netContributionUSD);
  assert.ok(Math.abs(comparison.interaction.netContributionUSD - (combined - equipment - weather)) < 0.01);
  assert.ok(comparison.interaction.reading.length > 10);
  const rows = comparisonRows(comparison);
  assert.equal(rows.length, 8);
  assert.equal(rows[0].values.length, 3);
});

test('restoring the equipment removes its effect, and the measure says what it assumed', () => {
  const antenna = healthyZone().rfidAssetIds[0];
  const scenario = scenarioWith({ failures: [{ assetId: antenna }], weather: 'HEAVY_RAIN' });
  const context = { inventory, ranAt: 0, tolling: { baseline: DEMO_BASELINE, zones: tollingZones } };
  const original = runScenario(scenario, context).revenueImpact;
  const applied = [{ id: 'RESTORE_EQUIPMENT' }];
  const mitigated = applyMitigations({ scenario, baseline: DEMO_BASELINE, applied });
  const after = runScenario(mitigated.scenario, {
    inventory, ranAt: 0, tolling: { baseline: mitigated.baseline, zones: tollingZones } }).revenueImpact;
  const outcome = mitigationOutcome({ original, mitigated: after, applied, notes: mitigated.notes });
  assert.ok(outcome.netImprovementUSD > 0, 'taking the failure away improves the estimate');
  assert.ok(after.delta.netContributionUSD < 0, 'the rain is still there');
  assert.equal(outcome.implementationCostUSD, null);
  assert.match(outcome.caveat, /cost and feasibility are not modelled/);
  assert.ok(outcome.assumptions.length > 0);
});

test('clearing an incident faster shortens its effect', () => {
  const scenario = scenarioWith({ incident: { type: 'MAJOR_CRASH', durationMinutes: 90 } });
  const context = baselineOverride => ({ inventory, ranAt: 0,
    tolling: { baseline: baselineOverride ?? DEMO_BASELINE, zones: tollingZones } });
  const original = runScenario(scenario, context()).revenueImpact;
  const applied = [{ id: 'SHORTEN_INCIDENT', value: 0.5 }];
  const mitigated = applyMitigations({ scenario, baseline: DEMO_BASELINE, applied });
  const after = runScenario(mitigated.scenario, context(mitigated.baseline)).revenueImpact;
  assert.equal(mitigated.scenario.trafficIncident.durationMinutes, 45);
  assert.ok(after.traffic.crossings > original.traffic.crossings, 'more vehicles get through');
  assert.ok(after.traffic.divertedCrossings < original.traffic.divertedCrossings);

  const uplift = applyMitigations({ scenario, baseline: DEMO_BASELINE, applied: [{ id: 'IMPROVE_VIDEO_RECOVERY' }] });
  assert.ok(uplift.baseline.tolling.videoCollectionRecoveryRate > DEMO_BASELINE.tolling.videoCollectionRecoveryRate);
  assert.equal(MITIGATIONS.every(item => item.implementationCostUSD === null), true);
});

// ------------------------------------------------------------------ inputs, storage, determinism

test('weather and incident inputs are validated', () => {
  assert.equal(validateWeather({ rainfallMmPerHour: 500, visibilityMeters: 100, windSpeedKmh: 10 }).valid, false);
  assert.equal(validateWeather(normaliseWeather('HEAVY_RAIN')).valid, true);
  assert.equal(validateIncident(normaliseIncident({ type: 'MAJOR_CRASH' })).valid, true);
  assert.equal(validateIncident({ ...normaliseIncident({ type: 'MAJOR_CRASH' }),
    throughputReductionPercent: 140 }).valid, false);
  assert.equal(validateIncident({ ...normaliseIncident({ type: 'MAJOR_CRASH' }),
    demandHandling: { policy: 'MAGIC' } }).valid, false);
});

test('a saved scenario round-trips, recalculates, and flags a missing asset', () => {
  const antenna = healthyZone().rfidAssetIds[0];
  const scenario = scenarioWith({ failures: [{ assetId: antenna }], weather: 'HEAVY_RAIN' });
  const store = new Map();
  globalThis.localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  try {
    const saved = saveScenario({ name: 'Rain and antenna', scenario, assumptions: DEMO_BASELINE, savedAt: 0 });
    assert.ok(saved);
    assert.equal(listScenarios().length, 1);
    const loaded = loadScenario(saved.id, { inventory });
    assert.equal(loaded.scenario.failures[0].assetId, antenna);
    assert.equal(loaded.scenario.weather.type, 'HEAVY_RAIN');
    assert.deepEqual(loaded.warnings, []);
    // The inputs were saved, so re-running reproduces the same answer rather than replaying one.
    const first = runScenario(scenario, { inventory, ranAt: 0, tolling: { baseline: DEMO_BASELINE, zones: tollingZones } });
    const again = runScenario(loaded.scenario, {
      inventory, ranAt: 0, tolling: { baseline: loaded.assumptions, zones: tollingZones } });
    assert.deepEqual(again.revenueImpact.scenario, first.revenueImpact.scenario);

    // An asset that has gone is reported, never remapped onto something else.
    const thinner = inventory.filter(asset => asset.assetId !== antenna);
    const stale = loadScenario(saved.id, { inventory: thinner });
    assert.equal(stale.warnings.length, 1);
    assert.match(stale.warnings[0], /no longer on this gantry/);
    assert.equal(stale.scenario.failures[0].assetId, antenna, 'kept as saved');
    assert.equal(deleteScenario(saved.id), true);
    assert.equal(listScenarios().length, 0);
  } finally { delete globalThis.localStorage; }
});

test('a scenario read back from the Phase 3 field names is the same scenario', () => {
  const normalised = normaliseScenario({
    scenarioId: 'SIM-003', scenarioName: 'RFID failure during heavy rain', gantryId: 'I595_G01',
    durationMinutes: 120,
    equipmentFailures: [{ assetId: healthyZone().rfidAssetIds[0], failureMode: 'COMPLETE_FAILURE' }],
    weather: { type: 'HEAVY_RAIN' }, trafficIncident: null, mitigations: [],
  });
  assert.equal(normalised.failures.length, 1, 'equipmentFailures is accepted as failures');
  assert.equal(normalised.name, 'RFID failure during heavy rain');
  assert.equal(normalised.weather.type, 'HEAVY_RAIN');
});

test('the same combined question always gets the same answer', () => {
  const antenna = healthyZone().rfidAssetIds[0];
  const options = { failures: [{ assetId: antenna }], weather: 'THUNDERSTORM',
    incident: { type: 'MINOR_CRASH', durationMinutes: 30 } };
  assert.deepEqual(moneyOf(options), moneyOf(options));
});

test('the equipment inventory and the synthetic baseline are untouched by all of this', () => {
  const before = JSON.stringify(inventory);
  const baselineBefore = JSON.stringify(DEMO_BASELINE);
  const sensitivityBefore = JSON.stringify(DEMO_SENSITIVITY);
  moneyOf({ failures: [{ assetId: healthyZone().rfidAssetIds[0] }], weather: 'HEAVY_RAIN',
    incident: { type: 'MAJOR_CRASH', durationMinutes: 90 } });
  assert.equal(JSON.stringify(inventory), before);
  assert.equal(JSON.stringify(DEMO_BASELINE), baselineBefore);
  assert.equal(JSON.stringify(DEMO_SENSITIVITY), sensitivityBefore);
});
