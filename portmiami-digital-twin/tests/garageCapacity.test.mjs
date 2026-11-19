/**
 * Garage-level capacity: cruises competing for registered garages through the terminal → garage
 * mapping, 15 minutes at a time. Small hand-built fixtures, so each rule is pinned exactly.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { localMidnightMs, normalizeCall } from '../src/cruise/cruiseCalls.js';
import { defaultCruiseAssumptions } from '../src/cruise/cruiseAssumptions.js';
import { buildCohorts, simulate, summarizeDay } from '../src/cruise/turnaroundModel.js';
import {
  ALLOCATION_POLICY, allocationsFromMapping, defaultTerminalGarageMapping, reconcileMapping, scenarioFacilities, validateMapping,
} from '../src/cruise/parkingAllocation.js';
import { PARKING_OUTCOME, cruiseGarageImpact, inspectInterval } from '../src/cruise/simulationInsight.js';

// No estimated returning cars (returning long-stay 0%), so each fixture holds only the cohorts it
// names; the returning distribution still totals 100% (the 12% moves to "other").
const A = { ...defaultCruiseAssumptions(), returningLongStayPct: 0, returningOtherModePct: 35 };
const raw = ({ id, ship = id, terminal = 'F', arrive, depart, capacity = 4000 }) => ({
  id, dock_request_number: id, ship_name: ship, terminal_code: terminal,
  arrival_datetime_local: arrive, departure_datetime_local: depart, arrival_date: arrive.slice(0, 10), departure_date: depart.slice(0, 10),
  passenger_capacity: capacity, berth_movements: [], voyage_options: [], itinerary_match_status: 'none',
});
const call = spec => normalizeCall(raw(spec));
const garage = (id, capacity, terminals, extra = {}) => ({ id, name: id, kind: 'GARAGE', capacity, servesTerminals: terminals, proposed: false, scope: 'OWN_TERMINALS', addedSpaces: 0, ...extra });
const window = { startMs: localMidnightMs('2026-11-01'), endMs: localMidnightMs('2026-11-16') };
const row = (facilityId, sharePct = 100, priority = 1, maxSharePct = null) => ({ facilityId, sharePct, priority, maxSharePct });

/** A run: calls, garages, allocations ({code: rows}) and policy; cars per cohort set by capacity. */
const run = (calls, facilities, allocations, policy = ALLOCATION_POLICY.PROPORTIONAL, a = A) => {
  const { cohorts } = buildCohorts(calls, a);
  return simulate({ cohorts, facilities, allocations, allocationPolicy: policy, assumptions: a, ...window });
};
const day = (sim, date, calls) => summarizeDay(sim, date, { calls });
const placed = (sim, id, types = ['IN', 'SPILL', 'OVERFLOW']) => sim.intervals.flatMap(r => r.moves).filter(m => m.cohortId === id && types.includes(m.type)).reduce((t, m) => t + m.n, 0);
const placedAt = (sim, id, fid) => sim.intervals.flatMap(r => r.moves).filter(m => m.cohortId === id && m.facilityId === fid && ['IN', 'SPILL', 'OVERFLOW'].includes(m.type)).reduce((t, m) => t + m.n, 0);
const invariants = sim => {
  for (const r of sim.intervals) {
    for (const f of sim.facilities) {
      const x = r.facilities[f.id];
      assert.ok(x.end >= 0, `${f.id} negative`);
      if (Number.isFinite(f.capacity)) assert.ok(x.end <= f.capacity, `${f.id} over capacity`);
      assert.equal(x.end, x.start + x.served - x.exits);
    }
  }
  assert.equal(sim.checks.conservationOk, true);
};

// Ship on Nov 3: 4000 berths → 3800 passengers → 12% / 2.5 → 183 cars.
const one = call({ id: 'one', arrive: '2026-11-03T06:00:00', depart: '2026-11-03T16:00:00' });
const CARS = 183;

test('1 · one cruise, one garage: every car parks there', () => {
  const sim = run([one], [garage('g', 1000, ['F'])], { F: [row('g')] });
  invariants(sim);
  assert.equal(placedAt(sim, 'dep-one', 'g'), CARS);
  const s = day(sim, '2026-11-03', [one]);
  const i = cruiseGarageImpact({ sim, summary: s, calls: [one], call: one, index: 50 });
  assert.equal(i.requested, CARS);
  assert.equal(i.accommodated, CARS);
  assert.equal(i.outcome, PARKING_OUTCOME.ALL);
});

test('2 · one cruise, two garages: split by share, or filled by priority', () => {
  const g = [garage('big', 1000, ['F']), garage('small', 1000, ['F'])];
  const split = run([one], g, { F: [row('big', 70, 1), row('small', 30, 2)] });
  assert.equal(placedAt(split, 'dep-one', 'big') + placedAt(split, 'dep-one', 'small'), CARS);
  assert.ok(Math.abs(placedAt(split, 'dep-one', 'big') - CARS * 0.7) <= 40, 'about 70% to the first');
  const prio = run([one], g, { F: [row('big', 0, 1), row('small', 0, 2)] }, ALLOCATION_POLICY.PRIORITY);
  assert.equal(placedAt(prio, 'dep-one', 'big'), CARS);
  assert.equal(placedAt(prio, 'dep-one', 'small'), 0);
});

test('3 · two cruises share one garage: each space used once; in a shared interval the earlier departure goes first', () => {
  const early = call({ id: 'early', arrive: '2026-11-03T06:00:00', depart: '2026-11-03T15:00:00' });
  const late = call({ id: 'late', arrive: '2026-11-03T06:30:00', depart: '2026-11-03T16:00:00' });
  const sim = run([early, late], [garage('g', 250, ['F'])], { F: [row('g')] });
  invariants(sim);
  assert.equal(placed(sim, 'dep-early') + placed(sim, 'dep-late'), 250, 'the garage fills exactly, never beyond');
  assert.equal(placed(sim, 'dep-early', ['UNSERVED']) + placed(sim, 'dep-late', ['UNSERVED']), 2 * CARS - 250);
  for (const r of sim.intervals) {
    const order = r.moves.filter(m => m.type !== 'OUT').map(m => m.cohortId);
    if (order.includes('dep-early') && order.includes('dep-late')) assert.ok(order.indexOf('dep-early') < order.indexOf('dep-late'));
  }
});

test('4 · several terminals share a garage, and its capacity', () => {
  const f = call({ id: 'f', terminal: 'F', arrive: '2026-11-03T06:00:00', depart: '2026-11-03T16:00:00' });
  const v = call({ id: 'v', terminal: 'V', arrive: '2026-11-03T06:00:00', depart: '2026-11-03T16:00:00' });
  const sim = run([f, v], [garage('g', 300, ['F', 'V'])], { F: [row('g')], V: [row('g')] });
  invariants(sim);
  assert.equal(placed(sim, 'dep-f') + placed(sim, 'dep-v'), 300);
  assert.ok(placed(sim, 'dep-f', ['UNSERVED']) + placed(sim, 'dep-v', ['UNSERVED']) === 2 * CARS - 300);
});

// A turnaround with the departure early enough that its parking window overlaps the exits.
const out = call({ id: 'out', ship: 'Same Ship', arrive: '2026-11-03T06:00:00', depart: '2026-11-03T16:00:00' });
const back = call({ id: 'back', ship: 'Same Ship', arrive: '2026-11-08T06:00:00', depart: '2026-11-08T12:00:00' });

test('5 · returning cars free spaces before new cars are placed in the same interval', () => {
  // Capacity exactly one cohort. The garage is full at the start of the overlapping intervals; new
  // cars park in them only because that interval's exits are taken first.
  const sim = run([out, back], [garage('g', CARS, ['F'])], { F: [row('g')] });
  invariants(sim);
  const fullYetServed = sim.intervals.filter(r => r.facilities.g.start === CARS && r.facilities.g.served > 0);
  assert.ok(fullYetServed.length > 0);
  for (const r of fullYetServed) assert.ok(r.facilities.g.served <= r.facilities.g.exits, 'never more than the spaces just freed');
  // Cars that arrive before the first exits (06:30–06:45) find the garage full: a real timing outcome.
  const early = sim.intervals.find(r => r.moves.some(m => m.cohortId === 'dep-back' && m.type === 'UNSERVED'));
  assert.ok(!early || early.facilities.g.exits === 0 || early.facilities.g.end === CARS);
  assert.equal(placed(sim, 'dep-back') + placed(sim, 'dep-back', ['UNSERVED']), CARS);
});

test('6 · entries and exits overlap in some intervals, and each interval still balances', () => {
  const sim = run([out, back], [garage('g', 1000, ['F'])], { F: [row('g')] });
  const both = sim.intervals.filter(r => r.facilities.g.exits > 0 && r.facilities.g.served > 0);
  assert.ok(both.length > 0, 'an interval with both');
  for (const r of both) assert.equal(r.facilities.g.end, r.facilities.g.start + r.facilities.g.served - r.facilities.g.exits);
});

test('7 · a garage reaching capacity is reported with its first and last full times', () => {
  const sim = run([one], [garage('g', 100, ['F'])], { F: [row('g')] });
  invariants(sim);
  const f = day(sim, '2026-11-03', [one]).facilities.find(x => x.id === 'g');
  assert.ok(f.firstFullTime && f.lastFullTime);
  assert.equal(f.peakOccupied, 100);
});

test('8 · a garage that cannot take all the cars: partial, the rest unserved and never parked', () => {
  const sim = run([one], [garage('g', 100, ['F'])], { F: [row('g')] });
  const s = day(sim, '2026-11-03', [one]);
  const i = cruiseGarageImpact({ sim, summary: s, calls: [one], call: one, index: 50 });
  assert.equal(i.accommodated, 100);
  assert.equal(i.unserved, CARS - 100);
  assert.equal(i.outcome, PARKING_OUTCOME.PARTIAL);
  assert.equal(i.garages[0].outcome, PARKING_OUTCOME.PARTIAL);
});

test('9 · a terminal with no garage: cars unallocated, never sent to the rest of the port', () => {
  const sim = run([one], [garage('g', 1000, ['D'])], { F: [], D: [row('g')] });
  invariants(sim);
  assert.equal(placed(sim, 'dep-one', ['UNALLOCATED']), CARS);
  assert.equal(placed(sim, 'dep-one'), 0);
  const i = cruiseGarageImpact({ sim, summary: day(sim, '2026-11-03', [one]), calls: [one], call: one, index: 50 });
  assert.equal(i.outcome, PARKING_OUTCOME.ASSIGNMENT_MISSING);
});

test('10 · a garage with no published capacity: not unlimited — cars are recorded as unchecked', () => {
  const sim = run([one], [garage('aa', null, ['F'])], { F: [row('aa')] });
  invariants(sim);
  assert.equal(placed(sim, 'dep-one'), 0);
  assert.equal(placed(sim, 'dep-one', ['NO_CAPACITY_DATA']), CARS);
  const i = cruiseGarageImpact({ sim, summary: day(sim, '2026-11-03', [one]), calls: [one], call: one, index: 50 });
  assert.equal(i.outcome, PARKING_OUTCOME.CAPACITY_DATA_UNAVAILABLE);
  assert.notEqual(i.outcome, PARKING_OUTCOME.ALL);
});

test('11 · returning cars leave from the garage they parked in', () => {
  const g = [garage('a', 1000, ['F']), garage('b', 1000, ['F'])];
  const sim = run([out, back], g, { F: [row('a', 60, 1), row('b', 40, 2)] });
  const c = sim.cohorts.find(x => x.id === 'dep-out');
  for (const fid of ['a', 'b']) {
    const left = sim.intervals.flatMap(r => r.moves).filter(m => m.cohortId === 'dep-out' && m.type === 'OUT' && m.facilityId === fid).reduce((t, m) => t + m.n, 0);
    assert.equal(left, c.served[fid], fid);
  }
});

// ---- designs ---------------------------------------------------------------------------------------------

const base = [garage('parking-garage-d', 822, ['D']), garage('parking-garage-g', 1735, ['F', 'G', 'V']), garage('parking-surface-lot-e', 511, ['E'], { kind: 'SURFACE_LOT' })];

test('12 · A adds its spaces to the selected garage only', () => {
  const f = scenarioFacilities(base, { type: 'EXPAND_EXISTING', key: 'A', site: { assetId: 'parking-garage-g' }, assumptions: { additionalSpaces: 500 } });
  assert.equal(f.find(x => x.id === 'parking-garage-g').capacity, 2235);
  assert.equal(f.find(x => x.id === 'parking-garage-d').capacity, 822);
  assert.equal(f.length, base.length, 'no new facility');
});

test('13 · B is usable only by the terminals given access', () => {
  const d = call({ id: 'd', terminal: 'D', arrive: '2026-11-03T06:00:00', depart: '2026-11-03T16:00:00' });
  const f = call({ id: 'f', terminal: 'F', arrive: '2026-11-03T06:00:00', depart: '2026-11-03T16:00:00' });
  const tight = [garage('gd', 50, ['D']), garage('gf', 50, ['F'])];
  const B = { type: 'NEW_GARAGE', key: 'B', id: 'b', site: {}, assumptions: { additionalSpaces: 1000 } };
  const facilities = scenarioFacilities(tight, B, { scopeFor: { NEW_GARAGE: ['F'] } });
  const sim = run([d, f], facilities, { D: [row('gd')], F: [row('gf')] });
  invariants(sim);
  assert.equal(placed(sim, 'dep-f', ['UNSERVED']), 0, 'F overflows into B');
  assert.equal(placed(sim, 'dep-d', ['UNSERVED']), CARS - 50, 'D cannot use B, so B does not solve its shortage');
  assert.equal(placedAt(sim, 'dep-d', 'proposed-B'), 0);
});

test('14 · C adds its spaces to the selected surface lot only', () => {
  const f = scenarioFacilities(base, { type: 'OPTIMIZE_SURFACE', key: 'C', site: { assetId: 'parking-surface-lot-e' }, assumptions: { additionalSpaces: 300 } });
  assert.equal(f.find(x => x.id === 'parking-surface-lot-e').capacity, 811);
  assert.equal(f.find(x => x.id === 'parking-garage-g').capacity, 1735);
});

// ---- reading it back -------------------------------------------------------------------------------------

test('15 · moving the time changes the garage figures', () => {
  const sim = run([one], [garage('g', 1000, ['F'])], { F: [row('g')] });
  const s = day(sim, '2026-11-03', [one]);
  const before = cruiseGarageImpact({ sim, summary: s, calls: [one], call: one, index: 20 });
  const during = cruiseGarageImpact({ sim, summary: s, calls: [one], call: one, index: 48 });
  assert.equal(before.garages[0].now.cruiseRequested, 0);
  assert.ok(during.garages[0].now.cruiseRequested > 0);
  assert.equal(before.garages[0].now.end, 0);
  assert.ok(during.garages[0].now.end > 0);
  const x = inspectInterval({ sim, summary: s, calls: [one], index: 48 });
  assert.equal(x.facilities[0].end, during.garages[0].now.end);
});

test('16 · the selected cruise reconciles with its garages and with the port totals', () => {
  const g = [garage('a', 100, ['F']), garage('b', 50, ['F'])];
  const other = call({ id: 'other', arrive: '2026-11-03T06:00:00', depart: '2026-11-03T15:00:00', capacity: 2000 });
  const sim = run([one, other], g, { F: [row('a', 50, 1), row('b', 50, 2)] });
  const s = day(sim, '2026-11-03', [one, other]);
  const i = cruiseGarageImpact({ sim, summary: s, calls: [one, other], call: one, index: 50 });
  assert.equal(i.accommodated + i.unserved + i.unallocated + i.noData, i.requested);
  assert.equal(i.garages.reduce((t, x) => t + x.accommodated, 0), sim.cohorts.find(c => c.id === 'dep-one').servedTotal);
  assert.equal(s.entries, sim.cohorts.filter(c => c.kind === 'DEPARTING').reduce((t, c) => t + c.servedTotal, 0));
  assert.ok(i.garages.some(x => x.competing.some(c => c.ship === 'other')), 'the competing cruise is named');
});

test('17 · no garage is counted twice in the day\'s capacity', () => {
  const g = [garage('g', 1735, ['F', 'V']), garage('d', 822, ['D'])];
  const calls = ['F', 'V', 'D'].map(t => call({ id: t, terminal: t, arrive: '2026-11-03T06:00:00', depart: '2026-11-03T16:00:00' }));
  const sim = run(calls, g, { F: [row('g')], V: [row('g')], D: [row('d')] });
  const s = day(sim, '2026-11-03', calls);
  assert.equal(new Set(s.facilities.map(f => f.id)).size, s.facilities.length);
  assert.equal(s.capacity, 1735 + 822);
});

test('18 · 19 · occupancy is never negative and never above capacity, in every scenario above', () => {
  const sims = [
    run([one, out, back], [garage('g', 120, ['F'])], { F: [row('g')] }),
    run([out, back], [garage('a', 90, ['F']), garage('b', 90, ['F'])], { F: [row('a', 50, 1), row('b', 50, 2)] }, ALLOCATION_POLICY.PRIORITY),
  ];
  for (const sim of sims) invariants(sim);
});

test('20 · identical inputs produce identical results', () => {
  const make = () => run([one, out, back], [garage('a', 150, ['F']), garage('b', 60, ['F'])], { F: [row('a', 60, 1), row('b', 40, 2)] });
  const [x, y] = [make(), make()];
  assert.deepEqual(x.intervals, y.intervals);
  assert.deepEqual(x.cohorts, y.cohorts);
});

// ---- the mapping -----------------------------------------------------------------------------------------

test('mapping: county defaults only, priorities by capacity, and a maximum share caps one garage', () => {
  const m = defaultTerminalGarageMapping(base, ['D', 'E', 'F', 'J']);
  assert.deepEqual(m.filter(r => r.terminal_code === 'F').map(r => r.garage_id), ['parking-garage-g']);
  assert.equal(m.filter(r => r.terminal_code === 'J').length, 0, 'no garage invented for J');
  assert.ok(m.every(r => r.mapping_source === 'COUNTY_PARKING_PAGE'));
  assert.deepEqual(validateMapping(m, base), []);
  const al = allocationsFromMapping(m, ['D', 'E', 'F', 'J']);
  assert.deepEqual(al.J, []);
  // Cap Garage A at 50% of the cohort: the rest goes to B.
  const sim = run([one], [garage('a', 1000, ['F']), garage('b', 1000, ['F'])], { F: [row('a', 0, 1, 50), row('b', 0, 2)] }, ALLOCATION_POLICY.PRIORITY);
  assert.equal(placedAt(sim, 'dep-one', 'a'), Math.floor(CARS / 2));
  assert.equal(placedAt(sim, 'dep-one', 'b'), CARS - Math.floor(CARS / 2));
});

test('mapping: invalid rows are named, user rows survive a registry refresh', () => {
  const m = defaultTerminalGarageMapping(base, ['D', 'F']);
  const bad = [...m, { ...m[0], allocation_priority: 0 }, { ...m[0], garage_id: 'nope', terminal_code: 'X', share_pct: 100 }];
  const errs = validateMapping(bad, base);
  assert.ok(errs.some(e => /twice/.test(e)));
  assert.ok(errs.some(e => /unknown garage nope/.test(e)));
  const mine = [...m, { ...m[0], terminal_code: 'F', terminal_id: 'terminal-f', garage_id: 'parking-garage-d', share_pct: 0, mapping_source: 'USER_CONFIGURED' }];
  assert.ok(reconcileMapping(mine, base, ['D', 'F']).some(r => r.terminal_code === 'F' && r.garage_id === 'parking-garage-d'));
});

test('demand is the same in every design, even where a terminal can only reach a design\'s overflow', () => {
  // Terminal X has no garage of its own; B takes its overflow. Its cars must count as demand in
  // the baseline (unallocated) and in B (placed) alike.
  const x = call({ id: 'x', terminal: 'X', arrive: '2026-11-03T06:00:00', depart: '2026-11-03T16:00:00' });
  const facilities = [garage('g', 1000, ['F'])];
  const B = { type: 'NEW_GARAGE', key: 'B', id: 'b', site: {}, assumptions: { additionalSpaces: 500 } };
  const base = run([one, x], facilities, { F: [row('g')], X: [] });
  const withB = run([one, x], scenarioFacilities(facilities, B, { scopeFor: { NEW_GARAGE: ['X'] } }), { F: [row('g')], X: [] });
  const [a, b] = [base, withB].map(sim => day(sim, '2026-11-03', [one, x]));
  assert.equal(a.demand, 2 * CARS);
  assert.equal(b.demand, a.demand);
  assert.ok(b.demandServedPct <= 100);
  assert.equal(placed(withB, 'dep-x'), CARS);
});

test('a new garage serves no terminal until one is configured', () => {
  const B = { type: 'NEW_GARAGE', key: 'B', id: 'b', site: {}, assumptions: { additionalSpaces: 500 } };
  const added = scenarioFacilities([garage('g', 100, ['F'])], B).find(f => f.proposed);
  assert.deepEqual(added.scope, []);
  const sim = run([one], scenarioFacilities([garage('g', 100, ['F'])], B), { F: [row('g')] });
  assert.equal(placedAt(sim, 'dep-one', 'proposed-B'), 0, 'no access configured, so no car parks there');
});

test('C across several lots: each lot gains its own spaces; an unknown lot stays unknown', () => {
  const lots = [garage('lot-d', 135, ['D'], { kind: 'SURFACE_LOT' }), garage('lot-e', 511, ['E'], { kind: 'SURFACE_LOT' }), garage('lot-c', null, [], { kind: 'SURFACE_LOT' })];
  const C = { type: 'OPTIMIZE_SURFACE', key: 'C', id: 'c', site: {}, assumptions: { additionalSpaces: 0 },
    lotAdditions: [{ assetId: 'lot-d', additionalSpaces: 40 }, { assetId: 'lot-e', additionalSpaces: 100 }, { assetId: 'lot-c', additionalSpaces: 200 }] };
  const f = scenarioFacilities(lots, C);
  assert.equal(f.find(x => x.id === 'lot-d').capacity, 175);
  assert.equal(f.find(x => x.id === 'lot-e').capacity, 611);
  assert.equal(f.find(x => x.id === 'lot-c').capacity, null, 'no published capacity: the total cannot be made up');
  assert.equal(f.find(x => x.id === 'lot-e').existingCapacity, 511);
});
