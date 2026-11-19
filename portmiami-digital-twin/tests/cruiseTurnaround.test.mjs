/**
 * The cruise-turnaround parking model.
 *
 * Fixtures are small and hand-built where a rule is being pinned down; the real November files
 * are used where the question is about the data itself (same ship on many dates, multiple berth
 * movements, missing capacity, the AAA terminal code).
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  callsOnDate, coverage, importDockReport, isSimulable, localMidnightMs, localToUtcMs, normalizeCall, utcMsToLocal,
} from '../src/cruise/cruiseCalls.js';
import { defaultCruiseAssumptions, validateCruiseAssumptions, VOYAGE_POLICY } from '../src/cruise/cruiseAssumptions.js';
import { buildCohorts, distribute, parkedVehicles, simulate, splitByShare, summarizeDay, INTERVAL_MS } from '../src/cruise/turnaroundModel.js';
import { defaultAllocations, registryFacilities, scenarioFacilities, validateAllocations } from '../src/cruise/parkingAllocation.js';
import { runCruiseScenario } from '../src/cruise/cruiseSimulation.js';
import { rankCruise } from '../src/cruise/cruiseComparison.js';
import { INFRASTRUCTURE_ASSETS } from '../src/config/infrastructure.js';

const ALL = JSON.parse(readFileSync(new URL('../data/cruise/source/portmiami_november_2026_dock_enriched_all.json', import.meta.url), 'utf8'));
const CAP = JSON.parse(readFileSync(new URL('../data/cruise/source/portmiami_november_2026_dock_enriched_with_capacity.json', import.meta.url), 'utf8'));
const A = defaultCruiseAssumptions();

/** A raw Dock Report record, in the files' own field names. */
const raw = ({ id, ship = 'Test Ship', terminal = 'F', arrive, depart, capacity = 4000, options = [] }) => ({
  id, dock_request_number: id, ship_name: ship, terminal_code: terminal,
  arrival_datetime_local: arrive, departure_datetime_local: depart,
  arrival_date: arrive.slice(0, 10), departure_date: depart.slice(0, 10),
  passenger_capacity: capacity, berth_movements: [], voyage_options: options,
  itinerary_match_status: options.length ? 'matched_sailing_list' : 'not_in_supplied_sailing_list',
});
const call = spec => normalizeCall(raw(spec));

const facility = (id, capacity, terminals) => ({ id, name: id, kind: 'GARAGE', capacity, servesTerminals: terminals, proposed: false, scope: 'OWN_TERMINALS', addedSpaces: 0 });
const window = (from = '2026-11-01', days = 30) => ({ startMs: localMidnightMs(from), endMs: localMidnightMs(from) + days * 24 * 3.6e6 + 3.6e6 });

const run = (calls, facilities, allocations, a = A) => {
  const { cohorts } = buildCohorts(calls, a);
  return simulate({ cohorts, facilities, allocations, assumptions: a, ...window() });
};

// ---- import --------------------------------------------------------------------------------------

test('the files load: 149 calls, 29 with capacity, the capacity file is exactly that subset', () => {
  const all = importDockReport(ALL).calls, cap = importDockReport(CAP).calls;
  assert.equal(all.length, 149);
  assert.equal(all.filter(isSimulable).length, 29);
  assert.deepEqual(new Set(cap.map(c => c.id)), new Set(all.filter(isSimulable).map(c => c.id)));
  const cov = coverage(all, { knownTerminalCodes: ['AA', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'J', 'V'], mappedTerminalCodes: ['AA', 'A', 'B', 'C', 'D', 'E', 'F', 'J', 'V'] });
  assert.equal(cov.excluded, 120);
  assert.deepEqual(cov.unknownTerminals, ['AAA']);
});

test('1 · the same ship on several November dates stays several calls', () => {
  const all = importDockReport(ALL).calls;
  const celebration = all.filter(c => c.shipName === 'Carnival Celebration');
  assert.equal(celebration.length, 5);
  assert.equal(new Set(celebration.map(c => c.id)).size, 5);
});

test('2 · every berth movement of a call is kept', () => {
  const multi = importDockReport(ALL).calls.find(c => c.id === 'PMIA-DOCK-98207');
  assert.equal(multi.berthMovements.length, 5);
  assert.ok(multi.berthMovements.every(m => Number.isFinite(m.arrivalMs)));
  assert.equal(multi.raw.id, 'PMIA-DOCK-98207');
});

test('3 · a call without capacity is excluded from demand, not given one', () => {
  const none = call({ id: 'x', arrive: '2026-11-03T06:00:00', depart: '2026-11-03T16:00:00', capacity: null });
  assert.equal(none.passengerCapacity, null);
  assert.equal(isSimulable(none), false);
  assert.equal(buildCohorts([none], A).cohorts.length, 0);
});

test('4 · a terminal with no mapped facility puts its vehicles in unserved, not in a garage', () => {
  const c = call({ id: 'x', terminal: 'AAA', arrive: '2026-11-03T06:00:00', depart: '2026-11-03T16:00:00' });
  const sim = run([c], [facility('g', 1000, ['F'])], { AAA: [] });
  const dep = sim.cohorts.find(k => k.kind === 'DEPARTING');
  assert.equal(dep.servedTotal, 0);
  assert.equal(dep.unserved, dep.vehicles);
  assert.equal(sim.checks.conservationOk, true);
});

// ---- vehicles and cohorts ----------------------------------------------------------------------

test('vehicles: 5,360 berths at 90%, 12% parking at 2.5 per car is 232', () => {
  const r = parkedVehicles(5360, { occupancyPct: 90, longStayPct: 12, passengersPerVehicle: 2.5 });
  assert.deepEqual([r.passengers, r.vehicles], [4824, 232]);
  assert.ok(Math.abs(r.exact - 231.552) < 1e-9);
});

test('5 · arriving and departing passengers use their own assumptions', () => {
  const c = call({ id: 'x', arrive: '2026-11-03T06:00:00', depart: '2026-11-03T16:00:00' });
  const a = { ...A, returningLongStayPct: 20, departingLongStayPct: 10 };
  const { cohorts } = buildCohorts([c], a);
  const dep = cohorts.find(k => k.kind === 'DEPARTING'), ret = cohorts.find(k => k.kind === 'ESTIMATED_RETURN');
  assert.ok(ret.vehicles > dep.vehicles * 1.9);
});

const turnaround = () => [
  call({ id: 'c1', arrive: '2026-11-01T06:00:00', depart: '2026-11-01T16:00:00' }),
  call({ id: 'c2', arrive: '2026-11-08T06:00:00', depart: '2026-11-08T16:00:00' }),
];

test('6 · 7 · a departing cohort enters, stays, and exits when its voyage returns', () => {
  const sim = run(turnaround(), [facility('g', 5000, ['F'])], { F: [{ facilityId: 'g', sharePct: 100 }] });
  const dep = sim.cohorts.find(k => k.id === 'dep-c1');
  assert.equal(dep.returnCallId, 'c2');
  assert.equal(dep.basis, 'NEXT_CALL');
  assert.equal(dep.servedTotal, dep.vehicles);
  assert.equal(dep.released, dep.servedTotal);
  // Exits never exceed what the cohort put in.
  for (const k of sim.cohorts) assert.ok(k.released <= k.servedTotal);
  const nov4 = summarizeDay(sim, '2026-11-04');
  assert.equal(nov4.startOccupied, dep.vehicles);   // carried across days
  assert.equal(nov4.exits, 0);
});

test('8 · entries and exits in the same interval conserve vehicles', () => {
  const a = { ...A, exitStartAfterArrivalMin: 0, exitEndAfterArrivalMin: 600, entryStartBeforeDepartureMin: 600, entryEndBeforeDepartureMin: 0 };
  const c = turnaround();
  const sim = run(c, [facility('g', 5000, ['F'])], { F: [{ facilityId: 'g', sharePct: 100 }] }, a);
  const both = sim.intervals.filter(r => r.facilities.g.exits > 0 && r.facilities.g.served > 0);
  assert.ok(both.length > 0);
  for (const r of sim.intervals) assert.equal(r.facilities.g.end, r.facilities.g.start + r.facilities.g.served - r.facilities.g.exits);
  assert.equal(sim.checks.conservationOk, true);
});

test('9 · occupancy is carried across days', () => {
  const sim = run(turnaround(), [facility('g', 5000, ['F'])], { F: [{ facilityId: 'g', sharePct: 100 }] });
  const d1 = summarizeDay(sim, '2026-11-01'), d2 = summarizeDay(sim, '2026-11-02');
  assert.equal(d2.startOccupied, d1.endOccupied);
});

test('10 · a cohort whose voyage returns after November stays parked past the end', () => {
  const c = call({ id: 'c1', arrive: '2026-11-28T06:00:00', depart: '2026-11-28T16:00:00',
    options: [{ duration_nights: 7, returns_to_miami: true, end_date: '2026-12-05', scheduled_return_date: '2026-12-05' }] });
  const sim = run([c], [facility('g', 5000, ['F'])], { F: [{ facilityId: 'g', sharePct: 100 }] });
  const dep = sim.cohorts.find(k => k.kind === 'DEPARTING');
  assert.equal(dep.basis, 'RETURNS_AFTER_DATASET');
  assert.equal(dep.released, 0);
  assert.ok(sim.parkedAtEnd >= dep.servedTotal);
});

test('11 · an ambiguous return is flagged, and the exclude policy leaves it out', () => {
  const c1 = call({ id: 'c1', arrive: '2026-11-01T06:00:00', depart: '2026-11-01T16:00:00',
    options: [{ duration_nights: 7, returns_to_miami: true, end_date: '2026-11-08' }, { duration_nights: 14, returns_to_miami: true, end_date: '2026-11-15' }] });
  const c2 = call({ id: 'c2', arrive: '2026-11-08T06:00:00', depart: '2026-11-08T16:00:00' });
  const dep = buildCohorts([c1, c2], A).cohorts.find(k => k.id === 'dep-c1');
  assert.equal(dep.ambiguous, true);
  assert.equal(dep.basis, 'NEXT_CALL');
  const excluded = buildCohorts([c1, c2], { ...A, voyagePolicy: VOYAGE_POLICY.EXCLUDE });
  assert.ok(!excluded.cohorts.some(k => k.id === 'dep-c1'));
  assert.ok(excluded.skipped.some(s => s.callId === 'c1'));
});

test('a single itinerary option is matched to the ship’s call on its return date; a port-call pair is never a voyage length', () => {
  const c1 = call({ id: 'c1', arrive: '2026-11-01T06:00:00', depart: '2026-11-01T16:00:00',
    options: [{ duration_nights: 8, returns_to_miami: true, end_date: '2026-11-09', scheduled_return_date: '2026-11-09' }] });
  const c2 = call({ id: 'c2', arrive: '2026-11-05T06:00:00', depart: '2026-11-05T16:00:00' });
  const c3 = call({ id: 'c3', arrive: '2026-11-09T06:00:00', depart: '2026-11-09T16:00:00' });
  const dep = buildCohorts([c1, c2, c3], A).cohorts.find(k => k.id === 'dep-c1');
  assert.equal(dep.returnCallId, 'c3');
  assert.equal(dep.basis, 'ITINERARY_MATCHED');
});

test('12 · returning passengers with no earlier departure are an estimated cohort parked from the start', () => {
  const sim = run(turnaround(), [facility('g', 5000, ['F'])], { F: [{ facilityId: 'g', sharePct: 100 }] });
  const est = sim.cohorts.find(k => k.kind === 'ESTIMATED_RETURN');
  assert.equal(est.callId, 'c1');
  assert.equal(sim.initialOccupied, est.vehicles);
  assert.equal(est.released, est.vehicles);
});

test('13 · a full garage turns vehicles away as unserved and never exceeds capacity', () => {
  const big = [call({ id: 'c1', ship: 'One', arrive: '2026-11-03T06:00:00', depart: '2026-11-03T16:00:00', capacity: 6000 })];
  const sim = run(big, [facility('g', 100, ['F'])], { F: [{ facilityId: 'g', sharePct: 100 }] });
  assert.ok(sim.intervals.every(r => r.facilities.g.end <= 100));
  const dep = sim.cohorts.find(k => k.kind === 'DEPARTING');
  assert.ok(dep.unserved > 0);
  assert.equal(dep.servedTotal + dep.unserved, dep.vehicles);
  const day = summarizeDay(sim, '2026-11-03');
  assert.ok(day.peakShortage > 0);
  assert.ok(day.demandServedPct < 100);
});

test('14 · several ships at one garage add up', () => {
  const two = [
    call({ id: 'a', ship: 'One', arrive: '2026-11-03T06:00:00', depart: '2026-11-03T16:00:00' }),
    call({ id: 'b', ship: 'Two', terminal: 'G', arrive: '2026-11-03T07:00:00', depart: '2026-11-03T17:00:00' }),
  ];
  const sim = run(two, [facility('g', 5000, ['F', 'G'])], { F: [{ facilityId: 'g', sharePct: 100 }], G: [{ facilityId: 'g', sharePct: 100 }] });
  const deps = sim.cohorts.filter(k => k.kind === 'DEPARTING');
  const day = summarizeDay(sim, '2026-11-03');
  assert.equal(day.entries, deps.reduce((t, k) => t + k.vehicles, 0));
});

// ---- scenarios -------------------------------------------------------------------------------------

const realSetup = () => {
  const calls = importDockReport(ALL).calls;
  const base = registryFacilities(INFRASTRUCTURE_ASSETS);
  const allocations = defaultAllocations(base, ['AA', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'J', 'V', 'AAA']);
  return { calls, base, allocations };
};

test('the county mapping drives allocation: Garage G serves F, J splits between J and K, AAA is unmapped', () => {
  const { base, allocations } = realSetup();
  assert.deepEqual(allocations.F, [{ facilityId: 'parking-garage-g', sharePct: 100 }]);
  assert.equal(allocations.J.reduce((t, r) => t + r.sharePct, 0), 100);
  assert.deepEqual(allocations.AAA, []);
  assert.deepEqual(validateAllocations(allocations, base), []);
  assert.equal(base.find(f => f.id === 'parking-garage-aa').capacity, null);
});

test('15 · baseline, A, B and C face identical demand; only the facilities differ', () => {
  const { calls, base, allocations } = realSetup();
  const scenarios = [null,
    { type: 'EXPAND_EXISTING', key: 'A', site: { assetId: 'parking-garage-d' }, assumptions: { additionalSpaces: 1000 } },
    { type: 'NEW_GARAGE', key: 'B', site: {}, assumptions: { additionalSpaces: 2000 } },
    { type: 'OPTIMIZE_SURFACE', key: 'C', site: { assetId: 'parking-surface-lot-e' }, assumptions: { additionalSpaces: 1500 } }];
  const runs = scenarios.map(scenario => runCruiseScenario({ calls, assumptions: A, allocations, baseFacilities: base, scenario }));
  const demand = r => r.cohorts.map(k => `${k.id}:${k.vehicles}`).join();
  for (const r of runs) assert.equal(demand(r), demand(runs[0]));
  assert.equal(runs[1].facilities.find(f => f.id === 'parking-garage-d').capacity, 822 + 1000);
  assert.ok(runs[2].facilities.some(f => f.proposed && f.capacity === 2000));
  for (const r of runs) assert.equal(r.checks.conservationOk, true);
});

test('16 · running a scenario never modifies it, whatever day is read', () => {
  const { calls, base, allocations } = realSetup();
  const scenario = { type: 'EXPAND_EXISTING', key: 'A', site: { assetId: 'parking-garage-d', point: null }, assumptions: { additionalSpaces: 1000, addedFloors: 3 } };
  const before = JSON.stringify(scenario);
  const sim = runCruiseScenario({ calls, assumptions: A, allocations, baseFacilities: base, scenario });
  summarizeDay(sim, '2026-11-22'); summarizeDay(sim, '2026-11-29');
  assert.equal(JSON.stringify(scenario), before);
  assert.equal(base.find(f => f.id === 'parking-garage-d').capacity, 822);
});

test('17 · the same inputs reproduce the same run to the vehicle', () => {
  const { calls, base, allocations } = realSetup();
  const one = runCruiseScenario({ calls, assumptions: A, allocations, baseFacilities: base });
  const two = runCruiseScenario({ calls, assumptions: { ...A }, allocations, baseFacilities: base });
  assert.equal(JSON.stringify(one.intervals), JSON.stringify(two.intervals));
});

test('18 · November 1 has 25 hours and the repeated hour is read deterministically', () => {
  assert.equal((localMidnightMs('2026-11-02') - localMidnightMs('2026-11-01')) / 3.6e6, 25);
  assert.equal(new Date(localToUtcMs('2026-11-01T01:30:00')).toISOString(), '2026-11-01T05:30:00.000Z');
  assert.equal(new Date(localToUtcMs('2026-11-01T02:00:00')).toISOString(), '2026-11-01T07:00:00.000Z');
  assert.equal(utcMsToLocal(Date.UTC(2026, 10, 1, 6, 30)).time, '01:30');
  assert.equal(utcMsToLocal(Date.UTC(2026, 10, 1, 6, 30)).offsetMinutes, -300);
  const { calls } = realSetup();
  const allure = calls.find(c => c.id === 'PMIA-DOCK-98162');
  assert.equal(new Date(allure.arrivalMs).toISOString(), '2026-11-01T07:00:00.000Z');
  const sim = runCruiseScenario({ calls, assumptions: A, allocations: realSetup().allocations, baseFacilities: realSetup().base });
  assert.equal(summarizeDay(sim, '2026-11-01').timeline.length, 100);
});

test('19 · cruise-driven demand does not read the legacy forecast', () => {
  const { calls, base, allocations } = realSetup();
  const one = runCruiseScenario({ calls, assumptions: A, allocations, baseFacilities: base,
    scenario: { type: 'NEW_GARAGE', key: 'B', site: {}, assumptions: { additionalSpaces: 2000, baseDemandSpaces: 2600 } } });
  const two = runCruiseScenario({ calls, assumptions: A, allocations, baseFacilities: base,
    scenario: { type: 'NEW_GARAGE', key: 'B', site: {}, assumptions: { additionalSpaces: 2000, baseDemandSpaces: 99999 } } });
  assert.equal(JSON.stringify(one.intervals), JSON.stringify(two.intervals));
});

// ---- helpers ----------------------------------------------------------------------------------------

test('windows spread whole vehicles that sum exactly, and shares split exactly', () => {
  const start = localMidnightMs('2026-11-03');
  const d = distribute(233, start + 3.6e6, start + 6 * 3.6e6, start, 0.45);
  assert.equal([...d.values()].reduce((t, v) => t + v, 0), 233);
  assert.ok([...d.keys()].every(i => i >= 4 && i < 24));
  assert.deepEqual(splitByShare(7, [{ sharePct: 86 }, { sharePct: 14 }]).map(p => p.n), [6, 1]);
  assert.equal(INTERVAL_MS, 15 * 60_000);
});

test('assumptions are validated: mode shares must total 100%', () => {
  assert.deepEqual(validateCruiseAssumptions(A), []);
  assert.ok(validateCruiseAssumptions({ ...A, departingLongStayPct: 50 }).some(e => /Departing mode shares total 138%, not 100%/.test(e)));
});

test('scenario facilities: an expansion with no garage chosen adds nothing; a surface lot gains its spaces', () => {
  const base = registryFacilities(INFRASTRUCTURE_ASSETS);
  const none = scenarioFacilities(base, { type: 'EXPAND_EXISTING', site: {}, assumptions: { additionalSpaces: 1000 } });
  assert.equal(none.reduce((t, f) => t + (f.capacity ?? 0), 0), base.reduce((t, f) => t + (f.capacity ?? 0), 0));
  const lot = scenarioFacilities(base, { type: 'OPTIMIZE_SURFACE', key: 'C', site: { assetId: 'parking-surface-lot-e' }, assumptions: { additionalSpaces: 1500 } });
  assert.equal(lot.find(f => f.id === 'parking-surface-lot-e').capacity, 511 + 1500);
  assert.equal(callsOnDate(importDockReport(CAP).calls, '2026-11-22').length, 3);
});

const alt = (key, unserved, peakShortage, peakUtilisationPct) => ({ key, name: `Scenario ${key}`, metrics: { unserved, peakShortage, peakUtilisationPct } });

test('ranking: fewest unserved wins, then the smaller peak shortage', () => {
  const r = rankCruise([alt('A', 40, 30, 99), alt('B', 0, 0, 95), alt('C', 12, 10, 80)]);
  assert.equal(r.best.key, 'B');
  assert.equal(r.tie, false);
  assert.deepEqual(r.order.map(a => a.key), ['B', 'C', 'A']);
  const s = rankCruise([alt('A', 10, 30, 70), alt('B', 10, 5, 99)]);
  assert.equal(s.best.key, 'B');
  assert.match(s.reason, /peak shortage/);
});

test('ranking: when everyone serves all demand, lower utilisation does not crown a winner', () => {
  const r = rankCruise([alt('A', 0, 0, 60), alt('B', 0, 0, 40), alt('C', 0, 0, 50)]);
  assert.equal(r.best, null);
  assert.equal(r.tie, true);
  assert.equal(r.order[0].key, 'B');
});

test('a cruise scenario run is deterministic: the same inputs give identical results', () => {
  const calls = importDockReport(ALL).calls;
  const base = registryFacilities(INFRASTRUCTURE_ASSETS);
  const allocations = defaultAllocations(base, [...new Set(calls.map(c => c.terminalCode))]);
  const once = () => runCruiseScenario({ calls, assumptions: A, profile: 'TYPICAL', allocations, baseFacilities: base, scenario: null });
  const [x, y] = [once(), once()];
  assert.deepEqual(x.intervals, y.intervals);
  assert.equal(x.checks.conservationOk, true);
});
