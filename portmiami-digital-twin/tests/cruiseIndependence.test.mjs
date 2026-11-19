/**
 * Returning and departing calculations are independent, historical cohorts keep their stored
 * counts, profiles are explicit presets, and mode shares are a validated distribution.
 *
 * Edits go through `editAssumption` — the same reducer the hook uses for an input in the workspace —
 * so these tests exercise the path from an edited field to the engine, not a hand-built object.
 * The scenario is the real November 22 data: Carnival Magic and Carnival Celebration return with
 * cars parked by their November 14/15 departures (reconstructed cohorts); Seabourn Quest has no
 * earlier departure in the report (estimated cohort).
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { importDockReport } from '../src/cruise/cruiseCalls.js';
import {
  DEMAND_PROFILES, EDIT_SCOPE, MODE_SHARE_KEYS, applyProfile, assumptionIssues, defaultCruiseAssumptions,
  editAssumption, effectiveAssumptions, matchingProfile, migrateAssumptions, scopedAssumptionIssues,
} from '../src/cruise/cruiseAssumptions.js';
import { buildCohorts, parkedVehicles, summarizeDay } from '../src/cruise/turnaroundModel.js';
import { defaultAllocations, registryFacilities } from '../src/cruise/parkingAllocation.js';
import { runCruiseScenario } from '../src/cruise/cruiseSimulation.js';
import { dayCruises } from '../src/cruise/simulationInsight.js';
import { INFRASTRUCTURE_ASSETS } from '../src/config/infrastructure.js';

const CALLS = importDockReport(JSON.parse(readFileSync(new URL('../data/cruise/source/portmiami_november_2026_dock_enriched_all.json', import.meta.url), 'utf8'))).calls;
const BASE = registryFacilities(INFRASTRUCTURE_ASSETS);
const ALLOC = defaultAllocations(BASE, ['AA', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'J', 'V', 'AAA']);
const DAY = '2026-11-22';

const start = (scope = EDIT_SCOPE.DATE) => ({ assumptions: defaultCruiseAssumptions(), assumptionsByDate: {}, editScope: scope });
const edit = (state, key, value, date = DAY) => ({ ...state, ...editAssumption(state, date, key, value) });
const run = state => runCruiseScenario({ calls: CALLS, assumptions: state.assumptions, byDate: state.assumptionsByDate, allocations: ALLOC, baseFacilities: BASE });
const rows = (sim, date = DAY) => Object.fromEntries(dayCruises(sim, CALLS, date).filter(r => r.call.passengerCapacity).map(r => [r.call.shipName, r]));
const rebalance = (state, who, longStay) => {
  // Keep the distribution at 100%: move the difference into "other".
  const a = effectiveAssumptions(state.assumptions, state.assumptionsByDate, DAY);
  const other = 100 - longStay - a[`${who}PickupDropoffPct`] - a[`${who}TaxiRidesharePct`];
  return edit(edit(state, `${who}LongStayPct`, longStay), `${who}OtherModePct`, other);
};

const at12 = start();
const dep35 = rebalance(at12, 'departing', 35);
const ret42 = (() => {
  // 42% long-stay leaves 58% for the other modes; pick-up 18 + taxi 25 + other 15.
  let s = edit(dep35, 'returningLongStayPct', 42);
  s = edit(s, 'returningPickupDropoffPct', 18);
  s = edit(s, 'returningTaxiRidesharePct', 25);
  return edit(s, 'returningOtherModePct', 15);
})();

test('the November 22 scenario is valid at every step', () => {
  for (const s of [at12, dep35, ret42]) assert.deepEqual(scopedAssumptionIssues(s.assumptions, s.assumptionsByDate), []);
});

test('1 · departing share 12% → 35%: the returning share stays 12%', () => {
  const e = effectiveAssumptions(dep35.assumptions, dep35.assumptionsByDate, DAY);
  assert.equal(e.departingLongStayPct, 35);
  assert.equal(e.returningLongStayPct, 12);
  const r = rows(run(dep35));
  assert.equal(r['Carnival Magic'].departingCalc.inputs.longStayPct, 35);
  assert.equal(r['Seabourn Quest'].returningCalc.inputs.longStayPct, 12, 'estimated returning cohort uses the returning share');
});

test('2 · returning share 12% → 42%: the departing share stays 35%', () => {
  const e = effectiveAssumptions(ret42.assumptions, ret42.assumptionsByDate, DAY);
  assert.equal(e.returningLongStayPct, 42);
  assert.equal(e.departingLongStayPct, 35);
  const r = rows(run(ret42));
  assert.equal(r['Seabourn Quest'].returningCalc.inputs.longStayPct, 42);
  assert.equal(r['Seabourn Quest'].departingCalc.inputs.longStayPct, 35);
});

test('3 · changing departing occupancy does not change returning occupancy', () => {
  for (const scope of [EDIT_SCOPE.DATE, EDIT_SCOPE.MONTH]) {
    const s = edit(start(scope), 'departingOccupancyPct', 80);
    const e = effectiveAssumptions(s.assumptions, s.assumptionsByDate, DAY);
    assert.equal(e.departingOccupancyPct, 80);
    assert.equal(e.returningOccupancyPct, 95);
  }
});

test('4 · changing returning passengers per car does not change departing passengers per car', () => {
  for (const scope of [EDIT_SCOPE.DATE, EDIT_SCOPE.MONTH]) {
    const s = edit(start(scope), 'returningPassengersPerVehicle', 3.2);
    const e = effectiveAssumptions(s.assumptions, s.assumptionsByDate, DAY);
    assert.equal(e.returningPassengersPerVehicle, 3.2);
    assert.equal(e.departingPassengersPerVehicle, 2.5);
  }
});

test('5 · cars parked by an earlier departure are unaffected by November 22 edits', () => {
  const [a, b, c] = [at12, dep35, ret42].map(s => rows(run(s)));
  for (const ship of ['Carnival Magic', 'Carnival Celebration']) {
    assert.equal(a[ship].returningSource.kind, 'RECONSTRUCTED');
    assert.equal(b[ship].returningCohortVehicles, a[ship].returningCohortVehicles, `${ship} after departing edit`);
    assert.equal(c[ship].returningCohortVehicles, a[ship].returningCohortVehicles, `${ship} after returning edit`);
    assert.equal(b[ship].returningCalc.inputs.longStayPct, 12, 'stored at its own departure date');
    assert.notEqual(b[ship].returningCalc.inputs.assumptionDate, DAY);
  }
  // And the exits on the day are those cars, unchanged.
  const exitsOf = s => summarizeDay(run(s), DAY, { calls: CALLS }).exits;
  assert.equal(exitsOf(dep35), exitsOf(at12));
});

test('6 · estimated returning cars respond only to returning assumptions', () => {
  const quest = s => rows(run(s))['Seabourn Quest'];
  assert.equal(quest(at12).returningSource.kind, 'ESTIMATED');
  assert.equal(quest(dep35).returningCohortVehicles, quest(at12).returningCohortVehicles, 'a departing edit leaves it alone');
  const capacity = quest(at12).call.passengerCapacity;
  const expected = Math.ceil((Math.round(capacity * 0.95) * 0.42) / 3.2 - 1e-9);
  const withPpv = edit(ret42, 'returningPassengersPerVehicle', 3.2);
  assert.equal(quest(withPpv).returningCohortVehicles, expected);
  assert.equal(quest(withPpv).enteringVehicles, quest(dep35).enteringVehicles, 'its departing cars do not move');
});

test('7 · Typical / High / Peak write explicit, independent values into both sides', () => {
  for (const [id, p] of Object.entries(DEMAND_PROFILES)) {
    const a = applyProfile(defaultCruiseAssumptions(), id);
    assert.equal(matchingProfile(a), id);
    assert.equal(p.multiplier, undefined, 'no hidden multiplier');
    for (const who of ['departing', 'returning']) {
      assert.equal(MODE_SHARE_KEYS[who].reduce((t, k) => t + a[k], 0), 100, `${id} ${who} shares total 100`);
    }
    assert.equal(a.departingLongStayPct, a.returningLongStayPct);
    const b = { ...a, departingLongStayPct: 1 };
    assert.equal(b.returningLongStayPct, a.returningLongStayPct, 'independent primitives, not a shared object');
    assert.ok(Object.isFrozen(p.values));
  }
  assert.equal(matchingProfile({ ...applyProfile(defaultCruiseAssumptions(), 'PEAK'), departingLongStayPct: 20 }), 'CUSTOM');
});

test('8 · the calculation table shows exactly the engine\'s inputs', () => {
  const sim = run(dep35);
  for (const r of dayCruises(sim, CALLS, DAY)) {
    for (const [calc, cohort] of [[r.returningCalc, r.returning], [r.departingCalc, r.departing]]) {
      if (!calc) continue;
      assert.equal(calc.inputs, cohort.inputs, 'the same object the engine built');
      assert.equal(calc.check, true);
      const [pass, cars] = calc.steps;
      assert.equal(pass.inputs[0].value, cohort.inputs.capacity);
      assert.equal(pass.inputs[1].value, cohort.inputs.occupancyPct);
      assert.equal(cars.inputs[1].value, cohort.inputs.longStayPct);
      assert.equal(cars.inputs[2].value, cohort.inputs.passengersPerVehicle);
      assert.equal(cars.output.value, cohort.vehicles);
      assert.equal(cars.inputs.length, 3, 'passengers, share, party size — nothing else');
    }
  }
});

test('9 · mode shares that do not total 100%, or fall outside 0–100%, are rejected and named', () => {
  const a = defaultCruiseAssumptions();
  const over = assumptionIssues({ ...a, returningLongStayPct: 42 });
  assert.equal(over.length, 1);
  assert.match(over[0].message, /Returning mode shares total 130%, not 100%/);
  assert.deepEqual(over[0].keys, MODE_SHARE_KEYS.returning);
  assert.ok(assumptionIssues({ ...a, departingTaxiRidesharePct: -5, departingOtherModePct: 63 }).some(i => i.keys.includes('departingTaxiRidesharePct')));
  assert.ok(assumptionIssues({ ...a, departingLongStayPct: 120 }).length > 0);
  // A date's own edits are validated too, and the date is named.
  const day = edit(start(), 'returningLongStayPct', 42);
  const issues = scopedAssumptionIssues(day.assumptions, day.assumptionsByDate);
  assert.equal(issues[0].date, DAY);
  // Occupancy and party size are independent factors, not part of the 100% sum.
  assert.deepEqual(assumptionIssues({ ...a, departingOccupancyPct: 105, departingPassengersPerVehicle: 3 }), []);
});

test('10 · no unexplained multiplier: every cohort is exactly ⌈round(capacity × occupancy) × share ÷ party size⌉', () => {
  for (const id of Object.keys(DEMAND_PROFILES)) {
    const { cohorts } = buildCohorts(CALLS, applyProfile(defaultCruiseAssumptions(), id));
    for (const c of cohorts) {
      const x = c.inputs;
      assert.equal(c.vehicles, Math.ceil((Math.round((x.capacity * x.occupancyPct) / 100) * x.longStayPct) / 100 / x.passengersPerVehicle - 1e-9), `${id} ${c.id}`);
    }
  }
  assert.equal(parkedVehicles(1000, { occupancyPct: 100, longStayPct: 10, passengersPerVehicle: 2, multiplier: 1.3 }).vehicles, 50, 'a stray multiplier argument is ignored');
});

test('11 · every 15-minute interval conserves vehicles', () => {
  for (const s of [at12, dep35, ret42]) {
    const sim = run(s);
    assert.equal(sim.checks.conservationOk, true);
    for (const r of sim.intervals) {
      for (const f of Object.values(r.facilities)) assert.equal(f.end, f.start + f.served - f.exits);
    }
  }
});

test('12 · returning cars never exceed the cars in their cohort', () => {
  for (const s of [at12, dep35, ret42]) {
    const sim = run(s);
    const out = new Map();
    for (const m of sim.intervals.flatMap(r => r.moves)) if (m.type === 'OUT') out.set(m.cohortId, (out.get(m.cohortId) ?? 0) + m.n);
    for (const c of sim.cohorts) {
      assert.ok((out.get(c.id) ?? 0) <= c.servedTotal, c.id);
      assert.ok(c.servedTotal <= c.vehicles, c.id);
    }
  }
});

test('13 · identical inputs reproduce identical results', () => {
  const one = run(ret42), two = run(structuredClone(ret42));
  assert.deepEqual(one.intervals, two.intervals);
  assert.deepEqual(one.cohorts, two.cohorts);
});

test('a saved configuration from the earlier register is migrated explicitly', () => {
  const old = { departingLongStayPct: 12, returningLongStayPct: 12, pickupDropoffPct: 30, taxiRidesharePct: 35, departingOccupancyPct: 95 };
  const typical = migrateAssumptions(old, 'TYPICAL');
  assert.equal(typical.returningPickupDropoffPct, 30);
  assert.equal(typical.departingOtherModePct, 23);
  assert.deepEqual(assumptionIssues(typical), []);
  assert.equal(matchingProfile(migrateAssumptions(old, 'PEAK')), 'PEAK', 'the old ×1.3 profile becomes its explicit preset');
});
