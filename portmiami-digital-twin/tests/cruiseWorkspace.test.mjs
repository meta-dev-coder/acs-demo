/**
 * The Cruise Parking Simulation workspace's model layer: estimated returning cohorts, the
 * per-interval movement records, the calculation inspector, events, the "what's happening"
 * explanation, terminal access in the day's capacity, and the comparison's wording.
 *
 * The inspector and explanation restate the simulation; these tests hold them to it — every
 * interval's equation balances, every cohort's restated arithmetic matches the cohort the model
 * built, and the per-interval records add back up to each cohort's total.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { importDockReport, localMidnightMs, normalizeCall } from '../src/cruise/cruiseCalls.js';
import { RETURNING_COHORT_POLICY, defaultCruiseAssumptions } from '../src/cruise/cruiseAssumptions.js';
import { buildCohorts, simulate, summarizeDay } from '../src/cruise/turnaroundModel.js';
import { defaultAllocations, registryFacilities } from '../src/cruise/parkingAllocation.js';
import { runCruiseScenario } from '../src/cruise/cruiseSimulation.js';
import { cruiseMetrics, demandIdentical, explainAlternatives, rankCruise } from '../src/cruise/cruiseComparison.js';
import { cohortCalculation, dayCruises, dayEvents, explainInterval, inspectInterval } from '../src/cruise/simulationInsight.js';
import { INFRASTRUCTURE_ASSETS } from '../src/config/infrastructure.js';

const ALL = JSON.parse(readFileSync(new URL('../data/cruise/source/portmiami_november_2026_dock_enriched_all.json', import.meta.url), 'utf8'));
const A = defaultCruiseAssumptions();
const CALLS = importDockReport(ALL).calls;
const BASE = registryFacilities(INFRASTRUCTURE_ASSETS);
const CODES = ['AA', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'J', 'V', 'AAA'];
const ALLOC = defaultAllocations(BASE, CODES);

const raw = ({ id, ship = 'Test Ship', terminal = 'F', arrive, depart, capacity = 4000 }) => ({
  id, dock_request_number: id, ship_name: ship, terminal_code: terminal,
  arrival_datetime_local: arrive, departure_datetime_local: depart,
  arrival_date: arrive.slice(0, 10), departure_date: depart.slice(0, 10),
  passenger_capacity: capacity, berth_movements: [], voyage_options: [], itinerary_match_status: 'not_in_supplied_sailing_list',
});
const call = spec => normalizeCall(raw(spec));
const facility = (id, capacity, terminals) => ({ id, name: id, kind: 'GARAGE', capacity, servesTerminals: terminals, proposed: false, scope: 'OWN_TERMINALS', addedSpaces: 0 });
const window = { startMs: localMidnightMs('2026-11-01'), endMs: localMidnightMs('2026-12-01') };
const runOne = (calls, a = A, cap = 5000) => {
  const { cohorts } = buildCohorts(calls, a);
  return simulate({ cohorts, facilities: [facility('g', cap, ['F'])], allocations: { F: [{ facilityId: 'g', sharePct: 100 }] }, assumptions: a, ...window });
};
// B's new garage is given overflow access to every terminal explicitly: it has none by default.
const real = (scenario = null, a = A, profile = 'TYPICAL') => runCruiseScenario({ calls: CALLS, assumptions: a, profile, allocations: ALLOC, baseFacilities: BASE, scenario, scopeFor: { NEW_GARAGE: 'ANY_TERMINAL' } });

// ---- estimated returning cohorts ----------------------------------------------------------------------

test('a ship first seen late in the month: its returning cars park the assumed voyage before, not from November 1', () => {
  const late = [call({ id: 'q', ship: 'Late Ship', arrive: '2026-11-22T06:30:00', depart: '2026-11-22T17:00:00' })];
  const sim = runOne(late);
  const est = sim.cohorts.find(c => c.kind === 'ESTIMATED_RETURN');
  assert.equal(est.basis, 'ESTIMATED_ASSUMED_VOYAGE');
  assert.equal(est.initial, false);
  assert.equal(sim.initialOccupied, 0, 'nothing parked on November 1');
  const nov14 = summarizeDay(sim, '2026-11-14');
  const nov15 = summarizeDay(sim, '2026-11-15');
  assert.equal(nov14.endOccupied, 0);
  assert.equal(nov15.entries, est.vehicles, 'they enter on Nov 15, 7 nights before the Nov 22 arrival');
  assert.equal(summarizeDay(sim, '2026-11-22').exits, est.vehicles);
});

test('the alternative policy parks the same cars from November 1, and is labelled so', () => {
  const late = [call({ id: 'q', ship: 'Late Ship', arrive: '2026-11-22T06:30:00', depart: '2026-11-22T17:00:00' })];
  const sim = runOne(late, { ...A, returningCohortPolicy: RETURNING_COHORT_POLICY.PARKED_AT_START });
  const est = sim.cohorts.find(c => c.kind === 'ESTIMATED_RETURN');
  assert.equal(est.basis, 'ESTIMATED_PARKED_AT_START');
  assert.equal(sim.initialOccupied, est.vehicles);
});

test('an early arrival\'s estimated cars were parked before the data begins, so they are there at the start', () => {
  const sim = runOne([call({ id: 'e', arrive: '2026-11-03T06:00:00', depart: '2026-11-03T16:00:00' })]);
  const est = sim.cohorts.find(c => c.kind === 'ESTIMATED_RETURN');
  assert.equal(est.initial, true);
  assert.equal(sim.initialOccupied, est.vehicles);
});

// ---- movement records ----------------------------------------------------------------------------------

test('per-interval movement records add up: to each facility\'s flows, and to each cohort\'s total', () => {
  const sim = real();
  for (const r of sim.intervals) {
    for (const [fid, f] of Object.entries(r.facilities)) {
      const moves = r.moves.filter(m => m.facilityId === fid);
      assert.equal(moves.filter(m => ['IN', 'SPILL', 'OVERFLOW'].includes(m.type)).reduce((t, m) => t + m.n, 0), f.served);
      assert.equal(moves.filter(m => m.type === 'OUT').reduce((t, m) => t + m.n, 0), f.exits);
    }
  }
  for (const c of sim.cohorts.filter(k => !k.initial)) {
    const placed = sim.intervals.flatMap(r => r.moves).filter(m => m.cohortId === c.id && m.type !== 'OUT').reduce((t, m) => t + m.n, 0);
    // Entries scheduled after the window ends would be missing; none of November's are.
    assert.equal(placed, c.vehicles, c.id);
  }
});

// ---- capacity and access ---------------------------------------------------------------------------------

test('a terminal whose calls publish no capacity does not bring its garages into the day\'s capacity', () => {
  const s = summarizeDay(real(), '2026-11-01', { calls: CALLS });
  // Nov 1 modelled terminals: D (Garage D, Surface D) and F (Garage G). Terminals A, B, C, V, AA
  // have calls but no capacity, so their garages are not "in play".
  assert.deepEqual(s.activeTerminals, ['D', 'F']);
  assert.ok(s.callTerminals.includes('A'));
  assert.equal(s.capacity, 822 + 135 + 1735);
  assert.deepEqual(s.terminalAccess.map(t => [t.code, t.capacity]), [['D', 957], ['F', 1735]]);
});

test('an expansion the day\'s terminals cannot reach adds nothing to that day\'s capacity', () => {
  const k = { type: 'EXPAND_EXISTING', key: 'A', id: 'a', site: { assetId: 'parking-garage-k' }, assumptions: { additionalSpaces: 1000 } };
  const base = summarizeDay(real(), '2026-11-01', { calls: CALLS });
  const withK = summarizeDay(real(k), '2026-11-01', { calls: CALLS });
  assert.equal(withK.capacity, base.capacity);
});

// ---- the inspector -------------------------------------------------------------------------------------

test('inspector: every interval of a day balances, and every restated cohort matches the model', () => {
  for (const profile of ['TYPICAL', 'PEAK']) {
    const sim = real(null, A, profile);
    const s = summarizeDay(sim, '2026-11-29', { calls: CALLS });
    for (let i = 0; i < s.timeline.length; i += 1) {
      const x = inspectInterval({ sim, summary: s, calls: CALLS, assumptions: A, profile, index: i });
      assert.equal(x.equation.ok, true, `${profile} ${x.time}`);
      assert.equal(x.totals.end, x.totals.start + x.totals.served - x.totals.exits);
      for (const c of x.cohorts) {
        assert.equal(c.calc.check, true, `${c.cohort.id} restated`);
        if (c.entry) assert.ok(Math.abs(c.entry.exact - c.entry.vehicles) < 1.0001, 'whole cars within one of the exact share');
      }
    }
  }
});

test('inspector: the vehicle formula is capacity × occupancy, × share ÷ party size, rounded up', () => {
  const c = CALLS.find(x => x.shipName === 'Carnival Celebration' && x.arrivalDate === '2026-11-29');
  const dep = real().cohorts.find(k => k.kind === 'DEPARTING' && k.callId === c.id);
  const calc = cohortCalculation(dep, { call: c, assumptions: A, profile: 'TYPICAL' });
  assert.equal(calc.passengers, Math.round(5360 * 0.95));
  assert.equal(calc.vehicles, Math.ceil((calc.passengers * 0.12) / 2.5));
  assert.equal(calc.steps[0].inputs[0].source, 'PUBLISHED');
  assert.equal(calc.steps[0].inputs[1].source, 'ASSUMED');
});

// ---- events and explanation ------------------------------------------------------------------------------

test('events are in time order, use reported ship times, and point at the interval they fall in', () => {
  const sim = real();
  const s = summarizeDay(sim, '2026-11-29', { calls: CALLS });
  const ev = dayEvents({ sim, summary: s, calls: CALLS, date: '2026-11-29' });
  for (let i = 1; i < ev.length; i += 1) assert.ok(ev[i].ms >= ev[i - 1].ms);
  const arr = ev.find(e => e.kind === 'ARRIVAL' && /Carnival Celebration/.test(e.text));
  assert.equal(arr.time, '05:30');
  assert.equal(s.timeline[arr.index].time, '05:30');
  const peak = ev.find(e => e.kind === 'PEAK');
  assert.equal(peak.time, s.peakTime);
  assert.ok(ev.some(e => e.kind === 'ARRIVAL' && e.modelled === false), 'unmodelled calls are still listed');
});

test('what is happening: sentences come from the interval\'s own movements and are deterministic', () => {
  const sim = real();
  const s = summarizeDay(sim, '2026-11-29', { calls: CALLS });
  const busy = s.timeline.findIndex(t => t.exits > 0);
  const one = explainInterval({ sim, summary: s, calls: CALLS, index: busy });
  assert.deepEqual(one, explainInterval({ sim, summary: s, calls: CALLS, index: busy }));
  const exits = one.find(x => x.kind === 'EXITS');
  const n = Number(exits.text.match(/: (\d+) cars leave/)[1]);
  assert.ok(n > 0 && n <= s.timeline[busy].exits);
  assert.equal(one.find(x => x.kind === 'OCCUPANCY').source, 'CALCULATED');
  const quiet = explainInterval({ sim, summary: s, calls: CALLS, index: 0 });
  assert.ok(quiet.some(x => x.kind === 'QUIET'));
});

test('day cruises: completeness says what is missing, and capacity is never invented', () => {
  const rows = dayCruises(real(), CALLS, '2026-11-01', { assumptions: A, profile: 'TYPICAL' });
  const allure = rows.find(r => r.call.shipName === 'Allure Of The Seas');
  assert.equal(allure.completeness.level, 'NONE');
  assert.equal(allure.enteringVehicles, null);
  const celeb = rows.find(r => r.call.shipName === 'Carnival Celebration');
  assert.equal(celeb.completeness.label, 'Returning cars estimated');
  assert.equal(celeb.enteringVehicles, celeb.departingCalc.vehicles);
});

// ---- comparison --------------------------------------------------------------------------------------------

const alt = (key, unserved, peakShortage, peakUtilisationPct) => ({ key, name: `Scenario ${key}`, metrics: { unserved, peakShortage, peakUtilisationPct } });

test('ranking: a partial tie names the leaders and does not claim every design serves all demand', () => {
  const r = rankCruise([alt('A', 430, 600, 72), alt('B', 0, 0, 68), alt('C', 0, 0, 75)]);
  assert.equal(r.best, null);
  assert.deepEqual(r.leaders.map(x => x.key), ['B', 'C']);
  assert.doesNotMatch(r.reason, /Every alternative/);
  assert.match(r.reason, /Scenario A turns away 430/);
});

test('comparison: identical demand in every case, and an unreachable expansion is explained as such', () => {
  const heavy = { ...A, departingLongStayPct: 35, returningLongStayPct: 35 };
  const scen = [
    { id: 'a', key: 'A', name: 'A. Expand', type: 'EXPAND_EXISTING', site: { assetId: 'parking-garage-g' }, assumptions: { additionalSpaces: 1000 } },
    { id: 'b', key: 'B', name: 'B. New', type: 'NEW_GARAGE', site: {}, assumptions: { additionalSpaces: 2000 } },
  ];
  const sims = { baseline: real(null, heavy, 'PEAK') };
  for (const x of scen) sims[x.id] = real(x, heavy, 'PEAK');
  const summaries = Object.fromEntries(Object.entries(sims).map(([id, sim]) => [id, summarizeDay(sim, '2026-11-29', { calls: CALLS })]));
  const rows = [{ key: 'Baseline', id: 'baseline', name: 'Baseline', metrics: cruiseMetrics(summaries.baseline) },
    ...scen.map(x => ({ key: x.key, id: x.id, name: x.name, metrics: cruiseMetrics(summaries[x.id]) }))];
  assert.equal(demandIdentical(rows), true);
  assert.ok(summaries.baseline.unserved > 0, 'the stress case is short');
  const [a, b] = explainAlternatives({ rows, summaries, sims });
  assert.match(a.text, /cannot serve under the access rules/);
  assert.match(b.text, /^Parks \d+ more cars than the baseline/);
});
