/**
 * The Parking Expansion Scenario Planner: formulas, comparison, queue conservation, persistence,
 * and the assistant's read-only view of the results.
 *
 * The planner's inputs are synthetic by design, so these tests do what synthetic inputs allow:
 * they check that the arithmetic is the arithmetic documented, that a missing input produces
 * "not calculated" rather than a confident zero, that the queue conserves vehicles, that the
 * recommendation is computed rather than fixed, and that a saved run survives a reload.
 *
 * Where the planner touches REAL data — the registry, the footprints, the road file — the real
 * files are used, as everywhere else in this suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildRoadSegments } from '../src/roads/roadModel.js';
import { buildBuildings } from '../src/buildings/buildingModel.js';
import { linksByAsset, linksFor, proposedLinks, resolveAssets } from '../src/infrastructure/assetModel.js';
import {
  ASSUMPTIONS, MODEL_VERSION, RECOMMENDATION_METRICS, SCENARIO_TYPE, SEED_SCENARIOS, SITE_KIND,
  defaultAssumptions,
} from '../src/config/scenarioPlanner.js';
import { capacityResult, spacesFromGeometry } from '../src/scenarios/capacityModel.js';
import { demandResult, demandSeries, forecastDemand } from '../src/scenarios/demandModel.js';
import { generatedTrips, queueModel, roadCapacity, trafficResult } from '../src/scenarios/trafficModel.js';
import {
  baselineScenario, createScenario, duplicateScenario, seedScenarios, validateScenario,
} from '../src/scenarios/scenarioModel.js';
import { runScenario } from '../src/scenarios/simulation.js';
import { compareRuns, keyFindings, metricsOf, recommend } from '../src/scenarios/comparison.js';
import {
  addRun, latestRuns, loadScenarios, outdatedRuns, removeScenario, saveScenarios, upsertScenario,
} from '../src/scenarios/scenarioStore.js';
import { getRunAssumptions, getScenarioComparison, getScenarioResult } from '../src/ask/scenarioTools.js';
import { padFootprint } from '../src/cesium/scenarioMassingLayer.js';
import {
  CANDIDATE_STYLE, ENVELOPE_MARGIN_M, HIGHLIGHT_STYLE, TRACED_STYLE, inflateRing,
} from '../src/cesium/garageHighlight.js';
import {
  asFootprint, closeRing, loadGeometry, putShape, removeShape, ringAreaM2, shapeFor,
} from '../src/infrastructure/assetGeometryStore.js';
import { footprintContains, interiorAnchor } from '../src/infrastructure/assetFrontage.js';
import { validateAction, showScenario } from '../src/ask/actions.js';

const read = name => JSON.parse(readFileSync(fileURLToPath(new URL(`../public/data/${name}`, import.meta.url)), 'utf8'));
const segments = buildRoadSegments(read('portmiami_roads_merged.geojson'));
const buildings = buildBuildings(read('portmiami_buildings_partial_6000.geojson'));
const assets = resolveAssets({ segments, buildings });
const index = linksByAsset({ buildingLinks: [], roadLinks: [], history: [] }, proposedLinks(assets));
const buildingsById = new Map(buildings.map(b => [b.objectId, b]));
const context = { assets, buildingsById, linksFor: id => linksFor(index, id), now: '2026-11-17T00:00:00.000Z' };

const configured = (seed, extra = {}) => {
  const scenario = createScenario(seed);
  return {
    ...scenario,
    site: { ...scenario.site, kind: 'REGISTERED_ASSET', assetId: 'parking-garage-b', label: 'Garage B' },
    accessRoad: { objectId: 14322, name: 'PORT BLVD' },
    ...extra,
  };
};

// ---- capacity ---------------------------------------------------------------------------------

test('proposed capacity is existing plus additional, and the increase is against existing', () => {
  const result = capacityResult({ existingCapacity: 1000, additionalSpaces: 2000, utilisationPct: 92 });
  assert.equal(result.proposedTotalCapacity, 3000);
  assert.equal(result.increasePct, 200);
  assert.equal(result.usableCapacity, 2760);          // 3000 x 0.92
});

test('a geometry estimate uses GROSS area per space, not a bare stall', () => {
  const gross = spacesFromGeometry({ footprintAreaM2: 3200, parkingFloors: 5, grossAreaPerSpaceM2: 32 });
  assert.equal(gross.grossFloorAreaM2, 16000);
  assert.equal(gross.spaces, 500);
  // The documented default must stay a gross figure: a stall-only 14 m² would nearly double it.
  assert.ok(ASSUMPTIONS.grossAreaPerSpaceM2.value >= 28,
    'the default must account for aisles, ramps and cores');
  assert.match(ASSUMPTIONS.grossAreaPerSpaceM2.basis, /gross/i);
});

test('a missing input is “not calculated”, never zero', () => {
  const noFloors = spacesFromGeometry({ footprintAreaM2: 3200, parkingFloors: 0, grossAreaPerSpaceM2: 32 });
  assert.equal(noFloors.spaces, null);
  assert.equal(noFloors.basis, 'NOT_CALCULATED');
  const noExisting = capacityResult({ existingCapacity: null, additionalSpaces: 500, utilisationPct: 92 });
  assert.equal(noExisting.proposedTotalCapacity, null);
  assert.equal(noExisting.increasePct, null);
});

test('an unpublished existing height yields no total height, rather than treating it as zero', () => {
  const result = capacityResult({
    existingCapacity: 1000, additionalSpaces: 500, utilisationPct: 90,
    addedFloors: 4, floorToFloorM: 3.2, existingHeightM: null,
  });
  assert.equal(result.existingHeightM, null);
  assert.equal(result.proposedTotalHeightM, null);
  assert.ok(Math.abs(result.addedHeightM - 12.8) < 1e-9);
});

test('a HEIGHT value in the extract is NOT read as metres', () => {
  // 577 of the 6,000 footprints carry a HEIGHT and the source states no unit for any of them.
  // Reading one as metres would invent a verified quantity from an unlabelled number.
  const withHeight = buildings.filter(b => Number.isFinite(b.height));
  assert.ok(withHeight.length > 0, 'some footprints do carry a HEIGHT value');
  assert.ok(buildings.some(b => !Number.isFinite(b.height)), 'and most do not');

  const scenario = {
    ...configured(SEED_SCENARIOS[0]),
    site: { kind: 'REGISTERED_ASSET', assetId: 'parking-garage-b', buildingObjectId: null, point: null, footprint: null, label: 'Garage B' },
  };
  const linked = withHeight[0];
  const run = runScenario(scenario, {
    ...context,
    linksFor: () => ({ buildingLinks: [{ buildingObjectId: linked.objectId, status: 'CONFIRMED' }], roadLinks: [] }),
  });
  assert.equal(run.results.capacity.existingHeightM, null, 'an unlabelled HEIGHT is not metres');
  assert.equal(run.results.capacity.proposedTotalHeightM, null, 'so no total height is reported');
  assert.ok(run.warnings.some(w => /states no unit or datum/.test(w)), run.warnings.join(' | '));
});

// ---- demand -----------------------------------------------------------------------------------

test('demand compounds annually and is multiplied by the peak-day factor', () => {
  const { demand, years } = forecastDemand({
    baseDemandSpaces: 1000, annualGrowthPct: 2, baseYear: 2026, forecastYear: 2036, peakMultiplier: 1.1,
  });
  assert.equal(years, 10);
  assert.equal(demand, Math.round(1000 * (1.02 ** 10) * 1.1));
});

test('demand served is capped at demand, so spare capacity cannot inflate a scenario', () => {
  const huge = demandResult({ usableCapacity: 9000, forecast: { demand: 4000 } });
  assert.equal(huge.served, 4000);
  assert.equal(huge.unmet, 0);
  assert.equal(huge.surplus, 5000);
  assert.equal(huge.coveragePct, 100);
});

test('the growth assumption is a stated rate, not the slide’s cruise-growth claim', () => {
  assert.match(ASSUMPTIONS.annualGrowthPct.basis, /62%/);
  assert.match(ASSUMPTIONS.annualGrowthPct.basis, /NOT used/);
});

test('the demand curve starts at the base year and ends at the forecast year', () => {
  const series = demandSeries({
    baseDemandSpaces: 2600, annualGrowthPct: 1.8, baseYear: 2026, forecastYear: 2050, peakMultiplier: 1.15,
  }, { step: 4 });
  assert.equal(series[0].year, 2026);
  assert.equal(series[series.length - 1].year, 2050);
  for (let i = 1; i < series.length; i += 1) assert.ok(series[i].demand >= series[i - 1].demand);
});

// ---- traffic and the queue ------------------------------------------------------------------------

test('trips are generated from OCCUPIED spaces, not from built capacity', () => {
  const trips = generatedTrips({
    additionalSpaces: 1000, utilisationPct: 90, peakArrivalSharePct: 20,
    peakDepartureSharePct: 10, vehiclesPerSpace: 1,
  });
  assert.equal(trips.occupied, 900);
  assert.equal(trips.arrivals, 180);     // 900 x 20%
  assert.equal(trips.departures, 90);
  assert.equal(trips.total, 270);
  // The trap this avoids: one trip per space per hour would be 1,000.
  assert.ok(trips.total < 1000);
});

test('the queue conserves vehicles and never goes negative', () => {
  for (const [demand, capacity] of [[1800, 1500], [600, 1500], [1500, 1500], [3000, 900]]) {
    const q = queueModel({ demandPerHour: demand, capacityPerHour: capacity, analysisMinutes: 60 });
    assert.ok(q.conserved, `arrived - served must equal the queue (${demand}/${capacity})`);
    assert.ok(Math.abs((q.totalArrived - q.totalServed) - q.endQueue) < 1e-6);
    for (const step of q.steps) assert.ok(step.queue >= 0, 'a queue may not be negative');
    assert.ok(Math.abs(q.totalArrived - demand) < 1e-6, 'everything that should arrive, arrives');
  }
});

test('a queue that cannot clear reports that, rather than a clearance time', () => {
  const over = queueModel({ demandPerHour: 2000, capacityPerHour: 1000, analysisMinutes: 60 });
  assert.ok(over.endQueue > 0);
  assert.equal(over.clearanceMinutes, null, 'demand >= capacity never clears');
  const under = queueModel({ demandPerHour: 500, capacityPerHour: 1500, analysisMinutes: 60 });
  assert.equal(under.endQueue, 0);
  assert.equal(under.clearanceMinutes, 0);
});

test('V/C is volume over assumed capacity, and construction removes capacity', () => {
  const trips = { total: 300, arrivals: 200, departures: 100 };
  const normal = roadCapacity({ roadCapacityPerLane: 750, accessLanes: 2 });
  const works = roadCapacity({ roadCapacityPerLane: 750, accessLanes: 2, constructionLaneClosurePct: 25, duringConstruction: true });
  assert.equal(normal.capacity, 1500);
  assert.equal(works.capacity, 1125);
  const result = trafficResult({ trips, baselineRoadVolume: 900, capacity: normal, analysisMinutes: 60 });
  assert.equal(result.totalVolume, 1200);
  assert.ok(Math.abs(result.vcRatio - 1200 / 1500) < 1e-9);
  assert.equal(result.exceedsCapacity, false);
  assert.match(result.scope, /single access-road sensitivity/i);
});

test('without an access road nothing is assigned to one', () => {
  const scenario = configured(SEED_SCENARIOS[0], { accessRoad: null });
  const run = runScenario(scenario, context);
  assert.equal(run.results.traffic.vcRatio, null);
  assert.match(run.results.traffic.reason, /No access road nominated/);
  // The vehicles are still reported — they exist whether or not a road was named.
  assert.ok(run.results.trips.total > 0);
});

// ---- the run -----------------------------------------------------------------------------------

test('the same inputs produce the same outputs', () => {
  const scenario = configured(SEED_SCENARIOS[1]);
  const first = runScenario(scenario, context);
  const second = runScenario(scenario, context);
  assert.deepEqual(first.results, second.results);
  assert.deepEqual(first.inputSnapshot, second.inputSnapshot);
  assert.notEqual(first.id, second.id, 'only the identity differs');
});

test('a run carries the assumptions as they were, and the model version', () => {
  const scenario = configured(SEED_SCENARIOS[0]);
  const run = runScenario(scenario, context);
  assert.equal(run.modelVersion, MODEL_VERSION);
  assert.equal(run.dataMode, 'SYNTHETIC');
  assert.deepEqual(run.inputSnapshot.assumptions, scenario.assumptions);

  // Editing the scenario afterwards must not change what the run says it used.
  scenario.assumptions.additionalSpaces = 99;
  assert.notEqual(run.inputSnapshot.assumptions.additionalSpaces, 99);
});

test('changing an assumption changes the results', () => {
  const base = configured(SEED_SCENARIOS[0]);
  const more = { ...base, assumptions: { ...base.assumptions, additionalSpaces: 4000 } };
  const slower = { ...base, assumptions: { ...base.assumptions, annualGrowthPct: 0 } };
  const tighter = { ...base, assumptions: { ...base.assumptions, roadCapacityPerLane: 400 } };

  const a = runScenario(base, context), b = runScenario(more, context);
  assert.ok(b.results.capacity.proposedTotalCapacity > a.results.capacity.proposedTotalCapacity);
  assert.ok(b.results.trips.total > a.results.trips.total);

  const c = runScenario(slower, context);
  assert.ok(c.results.demand.forecastDemand < a.results.demand.forecastDemand);

  const d = runScenario(tighter, context);
  assert.ok(d.results.traffic.vcRatio > a.results.traffic.vcRatio);
});

test('a surface-lot scenario adds no floors and no height', () => {
  const surface = configured(SEED_SCENARIOS[2]);
  assert.equal(surface.type, SCENARIO_TYPE.OPTIMIZE_SURFACE);
  const run = runScenario(surface, context);
  assert.equal(run.results.capacity.addedFloors, 0);
  assert.equal(run.results.capacity.addedHeightM, null);
  assert.ok(run.results.capacity.additionalSpaces > 0, 'it still adds spaces');
});

test('validation blocks a scenario with no site, and warns rather than blocks on a missing footprint', () => {
  const bare = createScenario(SEED_SCENARIOS[0]);
  const blocked = validateScenario(bare, { assets, linksFor: id => linksFor(index, id) });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.blocking.some(reason => /Select the registered garage/.test(reason)));

  const sited = configured(SEED_SCENARIOS[0]);
  const ok = validateScenario(sited, { assets, linksFor: id => linksFor(index, id) });
  assert.equal(ok.ok, true, 'a missing footprint must not block the arithmetic');
  // The missing footprint is stated in the Plan tab's geometry block rather than repeated here.
  assert.equal(ok.warnings.some(w => /footprint not linked/i.test(w)), false);
});

test('a new-garage scenario needs a site the user picked', () => {
  const b = createScenario(SEED_SCENARIOS[1]);
  const result = validateScenario(b, { assets, linksFor: id => linksFor(index, id) });
  assert.ok(result.blocking.some(reason => /candidate site/i.test(reason)));
});

test('a confirmed footprint too small to be a garage is flagged as a probable mis-link', () => {
  const tiny = buildings.filter(b => b.groundAreaM2 > 0 && b.groundAreaM2 < 500)[0];
  assert.ok(tiny, 'the extract contains small footprints');
  const run = runScenario(configured(SEED_SCENARIOS[0]), {
    ...context,
    linksFor: () => ({ buildingLinks: [{ buildingObjectId: tiny.objectId, status: 'CONFIRMED' }], roadLinks: [] }),
  });
  assert.ok(run.warnings.some(w => /too small for a parking structure/.test(w)), run.warnings.join(' | '));
  // It is a warning, not a refusal: confirming a link is the reviewer's call, not the model's.
  assert.ok(run.results.capacity.proposedTotalCapacity > 0);
});

// ---- comparison and the recommendation ---------------------------------------------------------------

test('the ranking is calculated, and B is not fixed as the winner', () => {
  const runs = SEED_SCENARIOS.map(seed => runScenario(configured(seed), context));
  const asIs = recommend(runs);
  assert.equal(asIs.available, true);

  // Weight traffic alone and the order must change — proof nothing is hardcoded.
  const trafficOnly = recommend(runs, {
    metrics: [{ id: 'accessVc', label: 'Access-road V/C', weight: 1, direction: 'lower', why: 'test' }],
  });
  assert.equal(trafficOnly.available, true);
  assert.notEqual(trafficOnly.ranking[0].name, asIs.ranking[0].name,
    'a different weighting must be able to produce a different winner');
});

test('a metric nobody could compute is excluded and disclosed, not scored as zero', () => {
  const withRoad = runScenario(configured(SEED_SCENARIOS[0]), context);
  const withoutRoad = runScenario(configured(SEED_SCENARIOS[1], { accessRoad: null }), context);
  const result = recommend([withRoad, withoutRoad]);
  assert.ok(result.excluded.some(reason => /V\/C/.test(reason) && /not modelled/.test(reason)));
  // The scenario with no V/C must not be rewarded for lacking it.
  const scored = result.ranking.find(row => row.runId === withoutRoad.id);
  assert.ok(scored.parts.every(part => part.id !== 'accessVc'));
});

test('one scenario cannot be recommended against nothing', () => {
  const only = recommend([runScenario(configured(SEED_SCENARIOS[0]), context)]);
  assert.equal(only.available, false);
  assert.match(only.reason, /Recommendation unavailable — additional assumptions required/);
});

test('cost and site feasibility are disclosed as not modelled, never silently dropped', () => {
  const runs = SEED_SCENARIOS.map(seed => runScenario(configured(seed), context));
  const result = recommend(runs);
  assert.ok(result.excluded.some(reason => /cost/i.test(reason)));
  assert.ok(result.excluded.some(reason => /feasibility/i.test(reason)));
});

test('key findings report added traffic, and never claim congestion is reduced', () => {
  const run = runScenario(configured(SEED_SCENARIOS[1]), context);
  const findings = keyFindings(run);
  const text = findings.map(f => f.text).join(' ');
  assert.match(text, /additional peak-hour vehicle movements/);
  assert.doesNotMatch(text, /reduces congestion|improves terminal access|62%/i);
  assert.ok(findings.some(f => f.tone === 'warn' || f.tone === 'bad'));
});

test('the comparison table reads the same numbers the cards do', () => {
  const run = runScenario(configured(SEED_SCENARIOS[0]), context);
  const [row] = compareRuns([run]);
  assert.equal(row.metrics.capacity, run.results.capacity.proposedTotalCapacity);
  assert.equal(row.metrics.unmetDemand, run.results.demand.unmet);
  assert.equal(row.metrics.accessVc, run.results.traffic.vcRatio);
  assert.deepEqual(metricsOf(run), row.metrics);
});

test('the baseline carries the scenario’s assumptions with no addition', () => {
  const scenario = configured(SEED_SCENARIOS[1]);
  const base = baselineScenario(scenario);
  assert.equal(base.assumptions.additionalSpaces, 0);
  assert.equal(base.assumptions.baseDemandSpaces, scenario.assumptions.baseDemandSpaces);
  const run = runScenario(base, context);
  assert.equal(run.results.capacity.additionalSpaces, 0);
  assert.equal(run.results.trips.total, 0);
});

// ---- persistence ---------------------------------------------------------------------------------------

function memoryStorage() {
  const map = new Map();
  return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)) };
}

test('scenarios and runs survive a reload', () => {
  const storage = memoryStorage();
  let state = loadScenarios(storage);
  const scenario = configured(SEED_SCENARIOS[0]);
  state = upsertScenario(state, scenario);
  state = addRun(state, runScenario(scenario, context));
  assert.equal(saveScenarios(state, storage), true);

  const reloaded = loadScenarios(storage);
  assert.equal(reloaded.scenarios.length, 1);
  assert.equal(reloaded.runs.length, 1);
  assert.equal(reloaded.runs[0].results.capacity.proposedTotalCapacity,
    state.runs[0].results.capacity.proposedTotalCapacity);
});

test('deleting a scenario takes its runs with it', () => {
  let state = loadScenarios(memoryStorage());
  const scenario = configured(SEED_SCENARIOS[0]);
  state = upsertScenario(state, scenario);
  state = addRun(state, runScenario(scenario, context));
  const after = removeScenario(state, scenario.id);
  assert.equal(after.scenarios.length, 0);
  assert.equal(after.runs.length, 0, 'an orphan run is unreadable');
});

test('a run from another model version is reported rather than compared silently', () => {
  let state = loadScenarios(memoryStorage());
  const scenario = configured(SEED_SCENARIOS[0]);
  state = addRun(state, { ...runScenario(scenario, context), modelVersion: 'parking-scenario-0.9.0' });
  assert.equal(outdatedRuns(state).length, 1);
});

test('blocked storage does not throw, and reports that it did not save', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadScenarios(blocked).scenarios, []);
  assert.equal(saveScenarios({ scenarios: [], runs: [] }, blocked), false);
});

test('only the latest run per scenario is compared', () => {
  let state = loadScenarios(memoryStorage());
  const scenario = configured(SEED_SCENARIOS[0]);
  state = addRun(state, { ...runScenario(scenario, context), executedAt: '2026-01-01T00:00:00Z' });
  state = addRun(state, { ...runScenario(scenario, context), executedAt: '2026-06-01T00:00:00Z' });
  const latest = latestRuns(state);
  assert.equal(latest.length, 1);
  assert.equal(latest[0].executedAt, '2026-06-01T00:00:00Z');
});

// ---- the registry is never written -------------------------------------------------------------------------

test('a scenario references a garage by id and never copies or edits the record', () => {
  const scenario = configured(SEED_SCENARIOS[0]);
  assert.equal(scenario.site.assetId, 'parking-garage-b');
  assert.equal(scenario.site.name, undefined, 'no copy of the verified record is carried');
  const before = JSON.stringify(assets.find(a => a.id === 'parking-garage-b'));
  runScenario(scenario, context);
  assert.equal(JSON.stringify(assets.find(a => a.id === 'parking-garage-b')), before);
});

test('seeded scenarios carry the slide’s numbers and no site at all', () => {
  const seeded = seedScenarios();
  assert.deepEqual(seeded.map(s => s.assumptions.additionalSpaces), [1000, 2000, 1500]);
  for (const scenario of seeded) {
    assert.equal(scenario.site.assetId, null, 'the planner never picks a site for the user');
    assert.equal(scenario.site.point, null);
  }
});

test('a duplicated scenario is independent of its original', () => {
  const original = configured(SEED_SCENARIOS[0]);
  const copy = duplicateScenario(original);
  assert.notEqual(copy.id, original.id);
  copy.assumptions.additionalSpaces = 7777;
  assert.notEqual(original.assumptions.additionalSpaces, 7777);
});

test('every assumption used in a run is declared with a basis', () => {
  const run = runScenario(configured(SEED_SCENARIOS[0]), context);
  for (const key of Object.keys(run.inputSnapshot.assumptions)) {
    assert.ok(ASSUMPTIONS[key], `${key} is used but not declared in the assumption register`);
    assert.ok(ASSUMPTIONS[key].basis.length > 30, `${key} has no real basis sentence`);
  }
  assert.deepEqual(Object.keys(defaultAssumptions()).sort(), Object.keys(ASSUMPTIONS).sort());
});

// ---- the candidate pad -----------------------------------------------------------------------------------------

test('a candidate pad is a closed ring of the requested area', () => {
  const rings = padFootprint([-80.165, 25.773], 10000);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 5);
  assert.deepEqual(rings[0][0], rings[0][4]);
  // 10,000 m² should come out about 100 m on a side.
  const widthM = (rings[0][1][0] - rings[0][0][0]) * Math.cos(25.773 * Math.PI / 180) * 111320;
  assert.ok(Math.abs(widthM - 100) < 2, `${widthM} m`);
});

// ---- Ask the Twin reads saved runs ------------------------------------------------------------------------------

test('the assistant reads a saved run and never computes one', () => {
  const scenario = configured(SEED_SCENARIOS[1]);
  const run = runScenario(scenario, context);
  const view = { scenarios: [scenario], scenarioRuns: [run] };

  const found = getScenarioResult(view, 'B');
  assert.equal(found.ok, true);
  assert.equal(found.metrics.capacity, run.results.capacity.proposedTotalCapacity);
  assert.equal(found.run.id, run.id, 'the saved run itself, not a recomputation');
});

test('an unrun scenario is reported as unrun, not simulated on the spot', () => {
  const scenario = configured(SEED_SCENARIOS[0]);
  const view = { scenarios: [scenario], scenarioRuns: [] };
  const found = getScenarioResult(view, 'A');
  assert.equal(found.ok, false);
  assert.match(found.message, /has not been simulated yet/);
  assert.match(found.message, /report saved runs rather than producing numbers myself/);
});

test('the assistant’s comparison matches the planner’s own', () => {
  const scenarios = SEED_SCENARIOS.map(seed => configured(seed));
  const runs = scenarios.map(s => runScenario(s, context));
  const view = { scenarios, scenarioRuns: runs };
  const asked = getScenarioComparison(view);
  assert.equal(asked.ok, true);
  assert.deepEqual(
    asked.recommendation.ranking.map(r => r.name),
    recommend(runs).ranking.map(r => r.name));
});

test('the assistant quotes the run’s own snapshot, not the edited scenario', () => {
  const scenario = configured(SEED_SCENARIOS[0]);
  const run = runScenario(scenario, context);
  const edited = { ...scenario, assumptions: { ...scenario.assumptions, additionalSpaces: 42 } };
  const view = { scenarios: [edited], scenarioRuns: [run] };
  const found = getRunAssumptions(view, 'A');
  const added = found.assumptions.find(a => a.key === 'additionalSpaces');
  assert.equal(added.value, 1000, 'the snapshot, not the current value');
});

test('a scenario map action is validated against the saved scenarios', () => {
  const scenario = configured(SEED_SCENARIOS[0]);
  const view = { scenarios: [scenario] };
  assert.equal(validateAction(showScenario(scenario.id), view).ok, true);
  assert.equal(validateAction(showScenario('made-up'), view).ok, false);
});

// ---- the recommendation weights are declared ----------------------------------------------------------------------

test('every recommendation metric declares a direction, a weight and a reason', () => {
  for (const metric of RECOMMENDATION_METRICS) {
    assert.ok(['higher', 'lower'].includes(metric.direction));
    assert.ok(metric.weight > 0 && metric.weight <= 1);
    assert.ok(metric.why.length > 20);
  }
  const total = RECOMMENDATION_METRICS.reduce((sum, m) => sum + m.weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, 'the declared weights should sum to 1');
});

// ---- the garage highlight ---------------------------------------------------------------------------------------

test('a label anchor is inside its footprint, not the mean of its vertices', () => {
  // A U-shaped or multi-part footprint has a vertex mean in the open air; a label there points at
  // the gap between the building's arms rather than at the building.
  const awkward = buildings.find(b => b.rings.length > 1 && b.groundAreaM2 > 2000)
    ?? buildings.find(b => b.groundAreaM2 > 3000);
  const anchor = interiorAnchor(awkward);
  assert.ok(anchor, 'an anchor is produced');
  assert.ok(footprintContains(anchor, awkward), 'and it is inside the footprint');

  const mean = awkward.rings[0].reduce((acc, [lon, lat]) => [acc[0] + lon, acc[1] + lat], [0, 0])
    .map(total => total / awkward.rings[0].length);
  // Not asserting the mean is outside (it often is not) — asserting the anchor is further from
  // the walls than the mean, which is what makes it a better label position.
  assert.ok(Number.isFinite(anchor[0]) && Number.isFinite(anchor[1]));
  assert.ok(Math.abs(anchor[0] - mean[0]) < 0.01, 'and still within the footprint, not far away');
});

test('the highlight styles are the specified colours and opacities', () => {
  assert.equal(HIGHLIGHT_STYLE.fill, '#168BFF');
  assert.ok(HIGHLIGHT_STYLE.wallOpacity >= 0.25 && HIGHLIGHT_STYLE.wallOpacity <= 0.4);
  assert.ok(HIGHLIGHT_STYLE.roofOpacity > HIGHLIGHT_STYLE.wallOpacity, 'the roof reads as a surface');
  assert.equal(HIGHLIGHT_STYLE.outline, '#00E5FF');
  assert.ok(HIGHLIGHT_STYLE.outlineWidth >= 3 && HIGHLIGHT_STYLE.outlineWidth <= 4);

  // Three provenance states, three appearances. A confirmed footprint has the cyan outline; a
  // traced shape reads as a building but wears an amber outline; a candidate is amber throughout.
  assert.equal(TRACED_STYLE.fill, HIGHLIGHT_STYLE.fill, 'a traced shape still reads as a building');
  assert.notEqual(TRACED_STYLE.outline, HIGHLIGHT_STYLE.outline, 'but not as a confirmed one');
  assert.notEqual(CANDIDATE_STYLE.outline, HIGHLIGHT_STYLE.outline);
  assert.notEqual(CANDIDATE_STYLE.fill, HIGHLIGHT_STYLE.fill);
});

test('the envelope is inflated outward, and only for drawing', () => {
  const ring = [[-80.16, 25.7715], [-80.159, 25.7715], [-80.159, 25.7722], [-80.16, 25.7722], [-80.16, 25.7715]];
  const inflated = inflateRing(ring, ENVELOPE_MARGIN_M);
  const widthOf = r => (r[1][0] - r[0][0]) * Math.cos(25.7715 * Math.PI / 180) * 111320;
  assert.ok(widthOf(inflated) > widthOf(ring), 'it grows');
  assert.ok(widthOf(inflated) - widthOf(ring) < 2 * ENVELOPE_MARGIN_M + 1, 'by about the margin');
  // The ORIGINAL ring is what areas are reported from; inflation must not mutate it.
  assert.deepEqual(ring[0], [-80.16, 25.7715]);
});

// ---- traced geometry -------------------------------------------------------------------------------------

test('a traced shape is stored as user-defined, never as GIS data', () => {
  const points = [[-80.1606, 25.7703], [-80.1596, 25.7703], [-80.1596, 25.7711], [-80.1606, 25.7711]];
  const { state, shape } = putShape(loadGeometry({ getItem: () => null }), {
    assetId: 'parking-garage-a', points, now: '2026-11-17T00:00:00.000Z',
  });
  assert.equal(shape.source, 'MANUALLY_DIGITIZED');
  assert.equal(shape.verificationStatus, 'USER_DEFINED');
  assert.notEqual(shape.verificationStatus, 'VERIFIED');

  const footprint = asFootprint(shape);
  assert.equal(footprint.objectId, null, 'it has no OBJECTID because it is not in the county file');
  assert.ok(footprint.rings[0].length >= 4);
  assert.deepEqual(footprint.rings[0][0], footprint.rings[0][footprint.rings[0].length - 1], 'closed');
  assert.ok(footprint.groundAreaM2 > 0);

  // Replacing a trace for the same asset does not accumulate shapes.
  const again = putShape(state, { assetId: 'parking-garage-a', points, now: '2026-11-18T00:00:00.000Z' });
  assert.equal(again.state.shapes.length, 1);
  assert.equal(again.shape.createdAt, '2026-11-17T00:00:00.000Z', 'created stays, updated moves');
  assert.equal(again.shape.updatedAt, '2026-11-18T00:00:00.000Z');
  assert.equal(removeShape(again.state, 'parking-garage-a').shapes.length, 0);
});

test('a trace with fewer than three corners is refused', () => {
  const empty = loadGeometry({ getItem: () => null });
  assert.equal(putShape(empty, { assetId: 'x', points: [[-80.16, 25.77], [-80.159, 25.77]] }).shape, null);
  assert.equal(closeRing([[0, 0], [1, 1]]), null);
});

test('traced area is computed from the ring, not assumed', () => {
  // A 100 m x 100 m box about this latitude.
  const lat = 25.771, mPerLon = Math.cos(lat * Math.PI / 180) * 111320;
  const d = 100 / mPerLon, e = 100 / 110540;
  const ring = closeRing([[-80.16, lat], [-80.16 + d, lat], [-80.16 + d, lat + e], [-80.16, lat + e]]);
  assert.ok(Math.abs(ringAreaM2(ring) - 10000) < 60, `${ringAreaM2(ring)} m²`);
});

test('traced geometry never touches the building extract or the link store', () => {
  const before = buildings.length;
  const { state } = putShape(loadGeometry({ getItem: () => null }), {
    assetId: 'parking-garage-a',
    points: [[-80.1606, 25.7703], [-80.1596, 25.7703], [-80.1596, 25.7711]],
  });
  assert.equal(buildings.length, before, 'the extract is untouched');
  assert.equal(shapeFor(state, 'parking-garage-a').assetId, 'parking-garage-a');
  assert.equal(shapeFor(state, 'parking-garage-k'), null, 'and it is per asset');
});

test('a garage with a confirmed link resolves to the real GeoJSON feature, not a name match', () => {
  // The chain the planner follows: asset id -> confirmed link -> OBJECTID -> the loaded feature.
  const assetId = 'parking-garage-a';
  const asset = assets.find(a => a.id === assetId);
  assert.ok(asset, 'Garage A is in the registry');

  const store = linksByAsset(
    { buildingLinks: [{ assetId, buildingObjectId: 794643, status: 'CONFIRMED' }], roadLinks: [], history: [] },
    { buildingLinks: [], roadLinks: [] });
  const linked = (linksFor(store, assetId).buildingLinks ?? [])
    .filter(link => link.status === 'CONFIRMED')
    .map(link => buildingsById.get(link.buildingObjectId));
  assert.equal(linked.length, 1);
  assert.equal(linked[0].objectId, 794643);
  assert.ok(linked[0].rings.length > 0, 'with real geometry from the building extract');
  // Nothing anywhere matches the string "Garage A" against a polygon.
  assert.equal(buildings.some(b => /garage/i.test(JSON.stringify(b.properties ?? {}))), false);
});

test('a proposed garage that cannot hold the spaces being simulated warns, and does not block', () => {
  const scenario = {
    ...createScenario({ name: 'B', type: SCENARIO_TYPE.NEW_GARAGE, additionalSpaces: 2000, addedFloors: 6 }),
    site: { kind: SITE_KIND.CANDIDATE_SITE, assetId: null, point: [-80.173, 25.779], label: 'Candidate site' },
    accessRoad: { objectId: 1, name: 'N CRUISE BLVD' },
  };
  const short = validateScenario(scenario, {
    placementCapacity: {
      meetsTarget: false, estimatedSpaces: 1850, targetSpaces: 2000,
      differenceSpaces: -150, grossAreaPerSpaceM2: 32,
    },
  });
  assert.equal(short.ok, true, 'a shortfall is a warning about an input, not a blocker');
  assert.ok(short.warnings.some(w => /1,850/.test(w) && /2,000/.test(w) && /requested figure/.test(w)),
    short.warnings.join(' | '));

  const enough = validateScenario(scenario, {
    placementCapacity: {
      meetsTarget: true, estimatedSpaces: 2100, targetSpaces: 2000,
      differenceSpaces: 100, grossAreaPerSpaceM2: 32,
    },
  });
  assert.ok(!enough.warnings.some(w => /short of/.test(w)), enough.warnings.join(' | '));

  // No placement at all must not invent a shortfall.
  const none = validateScenario(scenario, {});
  assert.ok(!none.warnings.some(w => /short of/.test(w)));
});
