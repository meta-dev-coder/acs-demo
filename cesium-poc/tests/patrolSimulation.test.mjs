/**
 * The Road Ranger patrol simulation.
 *
 * Two things are being pinned here, and they matter more than the feature working at all:
 *
 *   1. DETERMINISM. The TMC investigates historical incidents, so the same incident must produce
 *      the same scenario forever. Anything that makes the output depend on the wall clock or on
 *      Math.random() breaks a client demo in a way that is very hard to notice.
 *
 *   2. HONESTY. A travel time may only exist when a route along real geometry exists. A simulated
 *      number must never be presentable as an operational one, and the risk engine must never see
 *      any of this.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CARRIAGEWAYS } from '../src/liveOps/carriagewayModel.js';
import {
  DISPATCHABLE_STATUSES, PATROL_CONFIG, PATROL_SOURCE_TYPES, PATROL_STATUS, ROUTE_CONFIDENCE,
} from '../src/tmc/patrol/patrolConfig.js';
import {
  allSimulated, describeProvider, isSimulated, PATROL_PROVIDER_METHODS, summariseAvailability,
} from '../src/tmc/patrol/patrolProvider.js';
import {
  createSimulatedPatrolProvider, scenarioSeed, simulateFleet,
} from '../src/tmc/patrol/simulatedPatrolProvider.js';
import { ROUTE_UNRESOLVED, pointAtDistance, routeToIncident, travelMinutes } from '../src/tmc/patrol/patrolRouting.js';
import {
  buildResponseScenario, canTransition, compareDispatchScenarios, DISPATCH_LIFECYCLE, resolveAssumptions, statusAt,
} from '../src/tmc/patrol/patrolDispatch.js';
import { assessSecondaryRisk } from '../src/tmc/secondaryIncidentRisk.js';
import { parseTmcQuestion, answerTmcQuestion, TWIN_ACTIONS } from '../src/tmc/tmcAnswers.js';

/** A straight 20 km corridor running west to east, standing in for the published I-595 geometry. */
const CENTERLINE = Array.from({ length: 60 }, (_, i) => ({ lon: -80.40 + i * 0.0035, lat: 26.06 }));
/** 10:00 AM Eastern on 6 March 2026 — inside EST, before the DST change. */
const ANCHOR = Date.parse('2026-03-06T15:00:00Z');
const incidentAt = (lon, carriageway = CARRIAGEWAYS.EB_GENERAL, id = 'INC-200150') =>
  ({ id, longitude: lon, latitude: 26.06, carriageway, anchorMs: ANCHOR });
const INCIDENT = incidentAt(-80.26);
const providerFor = () => createSimulatedPatrolProvider({ centerline: CENTERLINE });

// ---------------------------------------------------------------- provider contract

test('the simulated provider satisfies the provider contract', () => {
  const described = describeProvider(providerFor());
  assert.equal(described.ok, true);
  assert.deepEqual(described.missing, []);
  assert.equal(PATROL_PROVIDER_METHODS.length, 5);
});

test('an incomplete provider is rejected by name, not silently accepted', () => {
  const described = describeProvider({ getPatrolsAt: () => [] });
  assert.equal(described.ok, false);
  assert.ok(described.missing.includes('getDispatchOptions'));
});

test('every simulated record declares its own source type', () => {
  const fleet = simulateFleet({ centerline: CENTERLINE, incidentId: INCIDENT.id, anchorMs: ANCHOR });
  assert.ok(fleet.length > 0);
  assert.equal(allSimulated(fleet), true);
  for (const patrol of fleet) {
    assert.equal(patrol.sourceType, PATROL_SOURCE_TYPES.SIMULATED);
    assert.equal(isSimulated(patrol), true);
  }
  // A real record would not be mistaken for one.
  assert.equal(isSimulated({ sourceType: PATROL_SOURCE_TYPES.REAL_AVL }), false);
});

// ---------------------------------------------------------------- determinism

test('the same inputs produce an identical fleet, every time', () => {
  const a = simulateFleet({ centerline: CENTERLINE, incidentId: 'INC-1', anchorMs: ANCHOR });
  const b = simulateFleet({ centerline: CENTERLINE, incidentId: 'INC-1', anchorMs: ANCHOR });
  assert.deepEqual(a, b);
});

test('a different incident, instant, scenario or seed produces a different fleet', () => {
  const base = scenarioSeed({ incidentId: 'INC-1', anchorMs: ANCHOR });
  assert.notEqual(base, scenarioSeed({ incidentId: 'INC-2', anchorMs: ANCHOR }));
  assert.notEqual(base, scenarioSeed({ incidentId: 'INC-1', anchorMs: ANCHOR + 3_600_000 }));
  assert.notEqual(base, scenarioSeed({ incidentId: 'INC-1', anchorMs: ANCHOR, scenarioId: 'OTHER' }));
  assert.notEqual(base, scenarioSeed({ incidentId: 'INC-1', anchorMs: ANCHOR, seed: 'different' }));
  assert.notEqual(base, scenarioSeed({ incidentId: 'INC-1', anchorMs: ANCHOR, configVersion: 'v2' }));

  const one = simulateFleet({ centerline: CENTERLINE, incidentId: 'INC-1', anchorMs: ANCHOR });
  const two = simulateFleet({ centerline: CENTERLINE, incidentId: 'INC-2', anchorMs: ANCHOR });
  assert.notDeepEqual(one.map(p => p.corridorAlongM), two.map(p => p.corridorAlongM));
});

test('the simulation never reads the wall clock', () => {
  // Two runs separated by a change of "now" must agree. If Date.now() leaked into the seed, the
  // positions would move between these two calls.
  const before = simulateFleet({ centerline: CENTERLINE, incidentId: 'INC-1', anchorMs: ANCHOR });
  const realNow = Date.now;
  Date.now = () => realNow() + 86_400_000;
  try {
    const after = simulateFleet({ centerline: CENTERLINE, incidentId: 'INC-1', anchorMs: ANCHOR });
    assert.deepEqual(before, after);
  } finally { Date.now = realNow; }
});

// ---------------------------------------------------------------- fleet shape and geometry

test('the fleet carries every field the contract names, on real corridor geometry', () => {
  const fleet = simulateFleet({ centerline: CENTERLINE, incidentId: INCIDENT.id, anchorMs: ANCHOR });
  assert.equal(fleet.length, PATROL_CONFIG.fleetSize);
  for (const [index, patrol] of fleet.entries()) {
    assert.equal(patrol.id, `SIM-RR-0${index + 1}`);
    for (const field of ['displayName', 'serviceArea', 'assignedRoute', 'status', 'scenarioId']) {
      assert.equal(typeof patrol[field], 'string', `${patrol.id}.${field}`);
    }
    assert.ok(Number.isFinite(patrol.latitude) && Number.isFinite(patrol.longitude));
    assert.equal(patrol.simulationTimestamp, ANCHOR);
    assert.ok(Object.values(PATROL_STATUS).includes(patrol.status));
    // On the published centerline, not at an invented coordinate.
    const onLine = pointAtDistance(CENTERLINE, patrol.corridorAlongM);
    assert.ok(Math.abs(onLine.lat - patrol.latitude) < 1e-9);
    assert.ok(Math.abs(onLine.lon - patrol.longitude) < 1e-9);
  }
});

test('the fleet covers both carriageways and always contains an ineligible patrol', () => {
  const fleet = simulateFleet({ centerline: CENTERLINE, incidentId: INCIDENT.id, anchorMs: ANCHOR });
  const sides = new Set(fleet.map(patrol => patrol.carriageway));
  assert.ok(sides.has(CARRIAGEWAYS.EB_GENERAL) && sides.has(CARRIAGEWAYS.WB_GENERAL));
  // The eligibility rules must be visible in the UI rather than theoretical.
  assert.ok(fleet.some(patrol => !DISPATCHABLE_STATUSES.includes(patrol.status)));
  assert.ok(fleet.some(patrol => patrol.status === PATROL_STATUS.AVAILABLE));
});

test('availability counts statuses separately rather than collapsing them', () => {
  const summary = summariseAvailability([
    { status: PATROL_STATUS.AVAILABLE }, { status: PATROL_STATUS.BUSY },
    { status: PATROL_STATUS.OUT_OF_SERVICE }, { status: PATROL_STATUS.EN_ROUTE },
  ]);
  assert.deepEqual({ ...summary }, { total: 4, available: 1, busy: 1, outOfService: 1, engaged: 1 });
});

// ---------------------------------------------------------------- routing honesty

test('a route exists only upstream on the same carriageway, and follows real geometry', () => {
  const patrol = { longitude: -80.34, latitude: 26.06, carriageway: CARRIAGEWAYS.EB_GENERAL, corridorAlongM: 6000 };
  const route = routeToIncident(patrol, INCIDENT, { centerline: CENTERLINE });
  assert.equal(route.resolved, true);
  assert.equal(route.confidence, ROUTE_CONFIDENCE.APPROXIMATE, 'never better than approximate');
  assert.ok(route.distanceMeters > 0);
  assert.ok(route.path.length > 1, 'the drawn route is a corridor slice, not two endpoints');
});

test('the opposite carriageway is refused — a divided highway has no published crossing', () => {
  const patrol = { longitude: -80.34, latitude: 26.06, carriageway: CARRIAGEWAYS.WB_GENERAL, corridorAlongM: 6000 };
  const route = routeToIncident(patrol, INCIDENT, { centerline: CENTERLINE });
  assert.equal(route.resolved, false);
  assert.equal(route.reason, ROUTE_UNRESOLVED.OPPOSITE_CARRIAGEWAY);
  assert.equal(route.travelSeconds, null);
});

test('a patrol past the incident is refused — a turnaround needs topology we do not have', () => {
  const patrol = { longitude: -80.21, latitude: 26.06, carriageway: CARRIAGEWAYS.EB_GENERAL, corridorAlongM: 19_000 };
  const route = routeToIncident(patrol, INCIDENT, { centerline: CENTERLINE });
  assert.equal(route.resolved, false);
  assert.equal(route.reason, ROUTE_UNRESOLVED.DOWNSTREAM);
});

test('an unresolved carriageway and Express each refuse, with their own reason', () => {
  const patrol = { longitude: -80.34, latitude: 26.06, carriageway: CARRIAGEWAYS.EB_GENERAL, corridorAlongM: 6000 };
  assert.equal(routeToIncident(patrol, incidentAt(-80.26, CARRIAGEWAYS.UNKNOWN), { centerline: CENTERLINE }).reason,
    ROUTE_UNRESOLVED.INCIDENT_CARRIAGEWAY);
  assert.equal(routeToIncident(patrol, incidentAt(-80.26, CARRIAGEWAYS.EXPRESS), { centerline: CENTERLINE }).reason,
    ROUTE_UNRESOLVED.EXPRESS);
});

test('no geometry means no route, never a straight line', () => {
  const patrol = { longitude: -80.34, latitude: 26.06, carriageway: CARRIAGEWAYS.EB_GENERAL };
  const route = routeToIncident(patrol, INCIDENT, { centerline: [] });
  assert.equal(route.resolved, false);
  assert.equal(route.distanceMeters, null);
  assert.equal(travelMinutes(route), null, 'an unresolved route yields no ETA at all');
});

test('route distance is along-corridor, not the lateral offset from the centerline', () => {
  // A patrol displaced well off the line still measures its DRIVING distance along the corridor.
  const near = { longitude: -80.34, latitude: 26.06, carriageway: CARRIAGEWAYS.EB_GENERAL };
  const offLine = { longitude: -80.34, latitude: 26.075, carriageway: CARRIAGEWAYS.EB_GENERAL };
  const a = routeToIncident(near, INCIDENT, { centerline: CENTERLINE });
  const b = routeToIncident(offLine, INCIDENT, { centerline: CENTERLINE });
  assert.equal(a.resolved, true);
  assert.equal(b.resolved, true);
  // Within a few metres: the lateral displacement must barely matter.
  assert.ok(Math.abs(a.distanceMeters - b.distanceMeters) < 50,
    `along-corridor distance should ignore lateral offset (${a.distanceMeters} vs ${b.distanceMeters})`);
});

// ---------------------------------------------------------------- eligibility and ranking

test('busy and out-of-service patrols are never eligible, and say why', () => {
  const { options } = providerFor().getDispatchOptions(INCIDENT, ANCHOR, { centerline: CENTERLINE });
  for (const option of options) {
    if (option.patrol.status === PATROL_STATUS.BUSY) {
      assert.equal(option.eligible, false);
      assert.match(option.ineligibleReason, /busy/i);
    }
    if (option.patrol.status === PATROL_STATUS.OUT_OF_SERVICE) {
      assert.equal(option.eligible, false);
      assert.match(option.ineligibleReason, /out of service/i);
    }
    // Every refusal carries a reason an operator can read.
    if (!option.eligible) assert.ok(option.ineligibleReason?.length > 0);
  }
});

test('an ineligible patrol never carries a travel time', () => {
  const { options } = providerFor().getDispatchOptions(INCIDENT, ANCHOR, { centerline: CENTERLINE });
  for (const option of options.filter(entry => !entry.eligible)) {
    assert.equal(option.travelSeconds, null, `${option.patrol.id} must have no ETA`);
  }
});

test('eligible patrols are ranked fastest first and ineligible ones are kept, not hidden', () => {
  const result = providerFor().getDispatchOptions(INCIDENT, ANCHOR, { centerline: CENTERLINE });
  const times = result.eligible.map(option => option.travelSeconds);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(result.options.length, PATROL_CONFIG.fleetSize, 'the excluded ones stay visible');
});

test('no suggestion is made when the ranking is not defensible', () => {
  const result = providerFor().getDispatchOptions(INCIDENT, ANCHOR, { centerline: CENTERLINE });
  if (result.eligible.length === 0) assert.equal(result.suggested, null);
  if (result.suggested) {
    assert.equal(result.suggested.eligible, true);
    assert.equal(result.suggested, result.eligible[0]);
  }
  // A tie is reported as a tie rather than broken by a coin flip.
  if (result.tied.length > 1) assert.equal(result.suggested, null);
});

test('an incident with no resolvable carriageway yields no eligible patrol at all', () => {
  const result = providerFor().getDispatchOptions(
    incidentAt(-80.26, CARRIAGEWAYS.UNKNOWN), ANCHOR, { centerline: CENTERLINE });
  assert.equal(result.eligible.length, 0);
  assert.equal(result.suggested, null);
  for (const option of result.options) assert.equal(option.travelSeconds, null);
});

// ---------------------------------------------------------------- dispatch and timeline

const eligibleOption = () => {
  const result = providerFor().getDispatchOptions(INCIDENT, ANCHOR, { centerline: CENTERLINE });
  return result.suggested ?? result.eligible[0];
};

test('the dispatch lifecycle only advances one state at a time', () => {
  assert.equal(canTransition(PATROL_STATUS.AVAILABLE, PATROL_STATUS.DISPATCHED), true);
  assert.equal(canTransition(PATROL_STATUS.DISPATCHED, PATROL_STATUS.EN_ROUTE), true);
  assert.equal(canTransition(PATROL_STATUS.EN_ROUTE, PATROL_STATUS.ON_SCENE), true);
  assert.equal(canTransition(PATROL_STATUS.AVAILABLE, PATROL_STATUS.ON_SCENE), false, 'no skipping');
  assert.equal(canTransition(PATROL_STATUS.ON_SCENE, PATROL_STATUS.DISPATCHED), false, 'no going back');
  assert.deepEqual([...DISPATCH_LIFECYCLE], ['DISPATCHED', 'EN_ROUTE', 'ON_SCENE', 'SCENE_WORK', 'CLEARED']);
});

test('the timeline is anchored to the real incident time and keeps the durations separate', () => {
  const option = eligibleOption();
  assert.ok(option, 'this scenario needs an eligible patrol');
  const scenario = buildResponseScenario({ incident: INCIDENT, option });
  const settings = resolveAssumptions();
  const at = id => scenario.events.find(event => event.id === id).at;

  assert.equal(at('incident'), ANCHOR, 'the incident row is the real recorded time');
  assert.equal(scenario.events.find(event => event.id === 'incident').kind, 'REAL');
  for (const event of scenario.events.filter(event => event.id !== 'incident')) {
    assert.equal(event.kind, 'SIMULATED', `${event.id} must be marked simulated`);
  }
  // Each assumption moves its own step and no other.
  assert.equal(at('detected') - at('incident'), settings.detectionMinutes * 60_000);
  assert.equal(at('dispatched') - at('detected'), settings.dispatchMinutes * 60_000);
  assert.equal(at('cleared') - at('arrived'), settings.onSceneWorkMinutes * 60_000);
  assert.equal(at('arrived') - at('dispatched'), travelMinutes(option.route) * 60_000);
  // Monotonic: no event may precede the one before it.
  const times = scenario.events.map(event => event.at);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test('a scenario with no route states the reason and invents no arrival', () => {
  const blocked = {
    patrol: { id: 'SIM-RR-09' },
    eligible: false,
    ineligibleReason: ROUTE_UNRESOLVED.OPPOSITE_CARRIAGEWAY,
    route: { resolved: false, reason: ROUTE_UNRESOLVED.OPPOSITE_CARRIAGEWAY },
  };
  const scenario = buildResponseScenario({ incident: INCIDENT, option: blocked });
  assert.equal(scenario.resolved, false);
  assert.equal(scenario.arrivalMs, null);
  assert.equal(scenario.exposureMinutes, null);
  assert.equal(scenario.events.length, 1, 'only the real incident row survives');
});

test('a patrol status derived from the timeline matches the timeline', () => {
  const scenario = buildResponseScenario({ incident: INCIDENT, option: eligibleOption() });
  assert.equal(statusAt(scenario, ANCHOR), PATROL_STATUS.AVAILABLE);
  assert.equal(statusAt(scenario, scenario.arrivalMs), PATROL_STATUS.ON_SCENE);
  assert.equal(statusAt(scenario, scenario.clearanceMs), PATROL_STATUS.CLEARED);
});

// ---------------------------------------------------------------- scenario comparison

test('comparing dispatch delays changes exactly one assumption', () => {
  const option = eligibleOption();
  const comparison = compareDispatchScenarios({ incident: INCIDENT, option, baselineMinutes: 8, fasterMinutes: 3 });
  assert.equal(comparison.resolved, true);
  assert.equal(comparison.changedAssumption, 'dispatchMinutes');
  assert.equal(comparison.earlierByMinutes, 5);
  assert.equal(comparison.arrivalEarlierByMinutes, 5);
  assert.equal(comparison.exposureReducedByMinutes, 5);
  // Travel and on-scene work are held, and the result says so.
  assert.deepEqual([...comparison.held], ['travelMinutes', 'onSceneWorkMinutes']);
  assert.equal(comparison.scenarioA.assumptions.travelMinutes, comparison.scenarioB.assumptions.travelMinutes);
  assert.equal(comparison.scenarioA.assumptions.onSceneWorkMinutes, comparison.scenarioB.assumptions.onSceneWorkMinutes);
});

test('the comparison never claims a crash reduction or a validated outcome', () => {
  const comparison = compareDispatchScenarios({ incident: INCIDENT, option: eligibleOption() });
  const text = JSON.stringify(comparison).toLowerCase();
  for (const forbidden of ['crash probability', 'crashes prevented', 'crashes saved', '% reduction', 'roi']) {
    assert.ok(!text.includes(forbidden), `must not claim "${forbidden}"`);
  }
  assert.match(comparison.caveat, /not a predicted outcome/i);
});

// ---------------------------------------------------------------- isolation from the risk engine

test('the risk engine neither accepts nor is moved by patrol data', () => {
  const incident = {
    id: 'INC-200150', severity: 'Major', activeMinutes: 60,
    carriageway: CARRIAGEWAYS.EB_GENERAL, sectionIndex: 3,
    lanes: { stated: true, blockedLanes: 2 },
  };
  const before = assessSecondaryRisk(incident, { impactLevel: 'HIGH' });
  // Every patrol field the simulation produces, offered to the engine at once.
  const after = assessSecondaryRisk(incident, {
    impactLevel: 'HIGH',
    patrols: simulateFleet({ centerline: CENTERLINE, incidentId: incident.id, anchorMs: ANCHOR }),
    patrolDispatch: buildResponseScenario({ incident: INCIDENT, option: eligibleOption() }),
    simulatedResponseMinutes: 4,
  });
  assert.equal(after.score, before.score, 'a simulated patrol must not move the risk score');
  assert.equal(after.level, before.level);
  assert.deepEqual(after.factors.map(f => f.type), before.factors.map(f => f.type));
  assert.deepEqual({ ...after.confidence }, { ...before.confidence }, 'nor the data confidence');
  // No factor may have come from the simulation.
  assert.ok(!after.factors.some(factor => /patrol|ranger|dispatch/i.test(factor.type)));
});

// ---------------------------------------------------------------- Ask the Twin

test('the patrol questions each parse to their own intent', () => {
  assert.equal(parseTmcQuestion('Which simulated patrols are available?'), 'PATROL_AVAILABLE');
  assert.equal(parseTmcQuestion('Show Road Rangers on the map.'), 'PATROL_SHOW');
  assert.equal(parseTmcQuestion('Which simulated patrol could reach this incident fastest?'), 'PATROL_FASTEST');
  assert.equal(parseTmcQuestion('Compare patrol response times.'), 'PATROL_COMPARE');
  assert.equal(parseTmcQuestion('What if dispatch happened five minutes earlier?'), 'PATROL_EARLIER');
  assert.equal(parseTmcQuestion('Show the simulated patrol route.'), 'PATROL_ROUTE');
  assert.equal(parseTmcQuestion('What data do we need from ACS to make this real?'), 'PATROL_REAL_DATA');
});

test('the patrol intents do not swallow the existing questions', () => {
  assert.equal(parseTmcQuestion('What data is missing for this incident?'), 'DATA_GAPS');
  assert.equal(parseTmcQuestion('Show historical crashes here'), 'LOCATION_HISTORY');
  assert.equal(parseTmcQuestion('Why does this require attention?'), 'WHY_RISK');
});

test('every patrol answer declares that the data is simulated', () => {
  const patrol = providerFor().getDispatchOptions(INCIDENT, ANCHOR, { centerline: CENTERLINE });
  const assessed = { assessments: [], historical: true, when: { label: '6 Mar 2026' } };
  const selected = {
    incident: { id: 'INC-200150', carriageway: CARRIAGEWAYS.EB_GENERAL, sectionLabel: 'Eastbound Section 04' },
    risk: { factors: [], contributors: [], unavailableFactors: [], unknownFactors: [] },
    upstream: { status: 'RESOLVED' }, upstreamCongestion: [], resources: {}, mitigation: [],
  };
  for (const intent of ['PATROL_AVAILABLE', 'PATROL_SHOW', 'PATROL_FASTEST', 'PATROL_COMPARE',
    'PATROL_ROUTE', 'PATROL_EARLIER']) {
    const answer = answerTmcQuestion(intent, assessed, { selected, patrol });
    assert.ok(answer, `${intent} must answer`);
    assert.match(answer.answer, /SIMULATED/, `${intent} must say the data is simulated`);
    assert.match(answer.answer, /not actual FDOT or ACS/i, `${intent} must disclaim FDOT/ACS`);
  }
});

test('a patrol answer without a scenario says so rather than inventing one', () => {
  const assessed = { assessments: [], historical: false, when: { label: 'now' } };
  const selected = {
    incident: { id: 'INC-1', carriageway: CARRIAGEWAYS.EB_GENERAL },
    risk: { factors: [], contributors: [], unavailableFactors: [], unknownFactors: [] },
    upstream: { status: 'RESOLVED' }, upstreamCongestion: [], resources: {}, mitigation: [],
  };
  const answer = answerTmcQuestion('PATROL_FASTEST', assessed, { selected, patrol: null });
  assert.match(answer.answer, /SIMULATED/);
  assert.match(answer.answer, /No patrol scenario is available/i);
  assert.deepEqual(answer.actions, []);
});

test('patrol actions come from the closed action vocabulary', () => {
  const patrol = providerFor().getDispatchOptions(INCIDENT, ANCHOR, { centerline: CENTERLINE });
  const assessed = { assessments: [], historical: true, when: { label: '6 Mar 2026' } };
  const selected = {
    incident: { id: 'INC-200150', carriageway: CARRIAGEWAYS.EB_GENERAL },
    risk: { factors: [], contributors: [], unavailableFactors: [], unknownFactors: [] },
    upstream: { status: 'RESOLVED' }, upstreamCongestion: [], resources: {}, mitigation: [],
  };
  const known = new Set(Object.values(TWIN_ACTIONS));
  for (const intent of ['PATROL_AVAILABLE', 'PATROL_FASTEST', 'PATROL_COMPARE', 'PATROL_ROUTE']) {
    for (const action of answerTmcQuestion(intent, assessed, { selected, patrol }).actions) {
      assert.ok(known.has(action.type), `${action.type} is not a declared twin action`);
    }
  }
});

test('the "what would make this real" answer names integration fields without claiming SunGuide', () => {
  const assessed = { assessments: [], historical: true, when: { label: '6 Mar 2026' } };
  const selected = {
    incident: { id: 'INC-200150', carriageway: CARRIAGEWAYS.EB_GENERAL },
    risk: { factors: [], contributors: [], unavailableFactors: [], unknownFactors: [] },
    upstream: { status: 'RESOLVED' }, upstreamCongestion: [], resources: {}, mitigation: [],
  };
  const answer = answerTmcQuestion('PATROL_REAL_DATA', assessed, { selected, patrol: null });
  assert.match(answer.answer, /dispatch, arrival, departure and clearance/i);
  assert.match(answer.answer, /not a confirmed SunGuide payload/i);
});
