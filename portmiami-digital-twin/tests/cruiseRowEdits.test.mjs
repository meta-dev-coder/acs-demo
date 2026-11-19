/**
 * Independent returning and departing demand, edited row by row from Demand & Turnover.
 *
 * The data is the app's own enriched November file. On November 22 Allure of the Seas (Terminal A)
 * and Norwegian Aqua (Terminal B) both return with cars parked by their November 15 departures
 * (reconstructed cohorts), then sail again (new departing cohorts). Seabourn Quest has no earlier
 * departure in the report (an estimated cohort), and neither has Allure's first call on November 1.
 *
 * Edits go through `applyRowEdit` / `resetRowEdit` — the reducers behind the row editor's
 * "Apply to this cruise / date / all cruises" and "Reset to defaults" — so these tests follow an
 * edit from the button to the engine. The Peak profile is used so garages fill and some cars are
 * turned away, which is what the vehicle-accounting tests need.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { importDockReport } from '../src/cruise/cruiseCalls.js';
import {
  ROW_SCOPE, applyProfile, applyRowEdit, balanceLongStay, cruiseAssumptions, defaultCruiseAssumptions, resetRowEdit,
  scopedAssumptionIssues,
} from '../src/cruise/cruiseAssumptions.js';
import { buildCohorts } from '../src/cruise/turnaroundModel.js';
import { defaultAllocations, registryFacilities } from '../src/cruise/parkingAllocation.js';
import { runCruiseScenario } from '../src/cruise/cruiseSimulation.js';
import { dayCruises } from '../src/cruise/simulationInsight.js';
import { INFRASTRUCTURE_ASSETS } from '../src/config/infrastructure.js';

const CALLS = importDockReport(JSON.parse(readFileSync(new URL('../public/data/cruise/portmiami_november_2026_enriched.json', import.meta.url), 'utf8'))).calls;
const BASE = registryFacilities(INFRASTRUCTURE_ASSETS);
const ALLOC = defaultAllocations(BASE, ['AA', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'J', 'V', 'AAA']);
const DAY = '2026-11-22';
const call = (ship, date) => CALLS.find(c => c.shipName.toUpperCase() === ship.toUpperCase() && c.arrivalDate === date);
const ALLURE = call('Allure of the Seas', DAY), AQUA = call('Norwegian Aqua', DAY);
const ALLURE_NOV1 = call('Allure of the Seas', '2026-11-01');
const QUEST = call('Seabourn Quest', DAY);

const PEAK = { assumptions: applyProfile(defaultCruiseAssumptions(), 'PEAK'), assumptionsByDate: {}, assumptionsByCruise: {} };
const edit = (state, callId, values, scope, date = DAY) => ({ ...state, ...applyRowEdit(state, { callId, date, values, scope }) });
const cohortsOf = state => buildCohorts(CALLS, state.assumptions, { byDate: state.assumptionsByDate, byCruise: state.assumptionsByCruise });
const run = (state, scenario = null, cohortSet = cohortsOf(state)) => runCruiseScenario({
  calls: CALLS, assumptions: state.assumptions, allocations: ALLOC, baseFacilities: BASE, scenario, cohortSet,
  scopeFor: { NEW_GARAGE: 'ANY_TERMINAL' },
});
const row = (sim, c) => dayCruises(sim, CALLS, c.arrivalDate).find(r => r.call.id === c.id);
const outBy = sim => {
  const out = new Map();
  for (const rec of sim.intervals) for (const m of rec.moves) {
    if (m.type !== 'OUT') continue;
    const k = `${m.cohortId}|${m.facilityId}`;
    out.set(k, (out.get(k) ?? 0) + m.n);
  }
  return out;
};
/** What a returning cohort is: its count, its inputs, its garages, when it leaves. */
const returningOf = r => ({ vehicles: r.returning.vehicles, inputs: r.returning.inputs, parked: r.leavingVehicles, served: r.returning.served, exit: [r.returning.exitStartMs, r.returning.exitEndMs] });

const base = run(PEAK);

test('the cases are what the test says they are', () => {
  for (const c of [ALLURE, AQUA]) {
    const r = row(base, c);
    assert.ok(c.passengerCapacity > 0, `${c.shipName} has a published capacity`);
    assert.equal(r.returningSource.kind, 'RECONSTRUCTED', `${c.shipName} returns with cars from an earlier departure`);
    assert.equal(r.returning.departureDate, '2026-11-15');
    assert.ok(r.departing, `${c.shipName} departs again on ${DAY}`);
  }
  assert.equal(row(base, QUEST).returningSource.kind, 'ESTIMATED');
  assert.equal(row(base, ALLURE_NOV1).returningSource.kind, 'ESTIMATED');
});

test('1 · a departing long-stay change does not change returning cars', () => {
  for (const [c, scope] of [[ALLURE, ROW_SCOPE.CRUISE], [AQUA, ROW_SCOPE.DATE]]) {
    const before = row(base, c);
    const { values } = balanceLongStay(cruiseAssumptions(PEAK.assumptions, {}, {}, DAY, c.id), 'departing', 25);
    const after = row(run(edit(PEAK, c.id, values, scope)), c);
    assert.equal(after.departing.inputs.longStayPct, 25);
    assert.ok(after.departing.vehicles > before.departing.vehicles, 'more departing cars');
    assert.deepEqual(returningOf(after), returningOf(before), `${c.shipName}: returning cars unchanged (${scope})`);
    assert.equal(after.departing.inputs.passengers, before.departing.inputs.passengers);
  }
});

test('2 · a departing occupancy change does not change a reconstructed returning cohort', () => {
  for (const scope of [ROW_SCOPE.CRUISE, ROW_SCOPE.DATE]) {
    for (const c of [ALLURE, AQUA]) {
      const after = row(run(edit(PEAK, c.id, { departingOccupancyPct: 80 }, scope)), c);
      assert.equal(after.departing.inputs.occupancyPct, 80);
      assert.deepEqual(returningOf(after), returningOf(row(base, c)), `${c.shipName} (${scope})`);
    }
  }
  // Nor does a RETURNING edit for November 22: those cars' count was fixed when they parked.
  const ret = row(run(edit(PEAK, ALLURE.id, { returningOccupancyPct: 60, returningPassengersPerVehicle: 4 }, ROW_SCOPE.DATE)), ALLURE);
  assert.equal(ret.returning.vehicles, row(base, ALLURE).returning.vehicles);
});

test('2b · "all cruises in this demand profile" changes earlier departures too, as the editor says', () => {
  const after = row(run(edit(PEAK, ALLURE.id, { departingOccupancyPct: 80 }, ROW_SCOPE.PROFILE)), ALLURE);
  assert.equal(after.returning.inputs.occupancyPct, 80, 'the November 15 departure now uses 80% too');
  assert.ok(after.returning.vehicles < row(base, ALLURE).returning.vehicles);
});

test('3 · unlinked returning voyages use the independent returning assumptions', () => {
  for (const c of [QUEST, ALLURE_NOV1]) {
    const { values } = balanceLongStay(cruiseAssumptions(PEAK.assumptions, {}, {}, c.arrivalDate, c.id), 'returning', 30);
    const before = row(base, c);
    const after = row(run(edit(PEAK, c.id, values, ROW_SCOPE.CRUISE, c.arrivalDate)), c);
    assert.equal(after.returning.inputs.side, 'returning');
    assert.equal(after.returning.inputs.longStayPct, 30);
    assert.ok(after.returning.vehicles > before.returning.vehicles);
    assert.deepEqual(after.returning.inputs.editedForCruise.sort(), ['returningLongStayPct', 'returningOtherModePct']);
    assert.equal(after.departing?.vehicles, before.departing?.vehicles, 'departing side unchanged');
    // A departing edit does not reach an estimated returning cohort.
    const dep = row(run(edit(PEAK, c.id, { departingOccupancyPct: 50, departingPassengersPerVehicle: 4 }, ROW_SCOPE.DATE, c.arrivalDate)), c);
    assert.equal(dep.returning.vehicles, before.returning.vehicles);
  }
});

test('3b · editing one cruise changes no other cruise', () => {
  const s = edit(PEAK, ALLURE.id, { departingOccupancyPct: 70 }, ROW_SCOPE.CRUISE);
  const a = cohortsOf(PEAK).cohorts, b = cohortsOf(s).cohorts;
  const changed = b.filter((c, i) => c.vehicles !== a[i].vehicles).map(c => c.id);
  assert.deepEqual(changed, [`dep-${ALLURE.id}`]);
});

test('4 · cars leaving a garage are cars that parked there, from their own cohort', () => {
  const out = outBy(base);
  for (const c of base.cohorts) {
    for (const [fid, n] of Object.entries(c.served)) {
      const left = out.get(`${c.id}|${fid}`) ?? 0;
      assert.ok(left <= n, `${c.id} left ${fid} ${left} > parked ${n}`);
      if (c.exitEndMs <= base.endMs) assert.equal(left, n, `${c.id}: every parked car leaves ${fid} once`);
    }
    for (const [k] of out) if (k.startsWith(`${c.id}|`)) assert.ok(k.split('|')[1] in c.served, `${k}: left a garage it never parked in`);
  }
});

test('5 · cars that were turned away never leave a garage as parked cars', () => {
  const out = outBy(base);
  const turnedAway = base.cohorts.filter(c => c.unserved > 0);
  assert.ok(turnedAway.length > 0, 'Peak turns some cars away');
  for (const c of turnedAway) {
    const left = [...out].filter(([k]) => k.startsWith(`${c.id}|`)).reduce((t, [, n]) => t + n, 0);
    assert.ok(left <= c.servedTotal && c.servedTotal + c.unserved + c.noData === c.vehicles, c.id);
  }
  // Independence of the Seas, Terminal AAA (no garage mapped): none of its cars ever parked.
  const ind = row(base, call('Independence of the Seas', DAY));
  assert.equal(ind.leavingVehicles, 0);
  assert.ok(ind.returningWithoutSpace > 0);
});

test('6 · returning cars are removed from the garage they parked in', () => {
  const out = outBy(base);
  for (const c of [ALLURE, AQUA]) {
    const r = row(base, c);
    const garages = Object.keys(r.returning.served).filter(fid => r.returning.served[fid] > 0);
    assert.ok(garages.length, `${c.shipName} has parked cars`);
    for (const fid of garages) assert.equal(out.get(`${r.returning.id}|${fid}`), r.returning.served[fid]);
    assert.deepEqual(r.returningParkedByGarage.map(g => g.facilityId).sort(), garages.sort());
  }
});

test('7 · occupancy never goes below zero or above capacity, with or without edits', () => {
  const heavy = edit(edit(PEAK, ALLURE.id, { departingOccupancyPct: 110, departingPassengersPerVehicle: 1 }, ROW_SCOPE.CRUISE),
    AQUA.id, { exitStartAfterArrivalMin: 0, exitEndAfterArrivalMin: 600 }, ROW_SCOPE.CRUISE);
  for (const sim of [base, run(heavy)]) {
    assert.equal(sim.checks.conservationOk, true);
    for (const rec of sim.intervals) {
      for (const f of sim.facilities) {
        const r = rec.facilities[f.id];
        assert.ok(r.end >= 0, `${f.id} negative at ${rec.index}`);
        if (Number.isFinite(f.capacity)) assert.ok(r.end <= f.capacity, `${f.id} over capacity at ${rec.index}`);
      }
    }
  }
});

test('8 · every design is tested against the same cruise demand', () => {
  const s = edit(PEAK, ALLURE.id, { departingOccupancyPct: 105, exitEndAfterArrivalMin: 300 }, ROW_SCOPE.CRUISE);
  const set = cohortsOf(s);
  const designs = [
    null,
    { id: 'a', key: 'A', type: 'EXPAND_EXISTING', site: { assetId: 'parking-garage-a' }, assumptions: { additionalSpaces: 800 } },
    { id: 'b', key: 'B', type: 'NEW_GARAGE', site: {}, assumptions: { additionalSpaces: 2000 } },
    { id: 'c', key: 'C', type: 'OPTIMIZE_SURFACE', site: { assetId: 'parking-surface-lot-e' }, assumptions: { additionalSpaces: 1500 } },
  ].map(sc => run(s, sc, set));
  const demand = sim => sim.intervals.map(r => r.requested);
  const vehicles = sim => sim.cohorts.map(c => [c.id, c.vehicles]);
  for (const sim of designs.slice(1)) {
    assert.deepEqual(demand(sim), demand(designs[0]));
    assert.deepEqual(vehicles(sim), vehicles(designs[0]));
  }
});

test('row edits: each scope writes where it says, the most specific value wins, reset restores', () => {
  const c = ALLURE.id;
  const atCruise = edit(PEAK, c, { departingOccupancyPct: 70 }, ROW_SCOPE.CRUISE);
  assert.deepEqual(atCruise.assumptionsByCruise, { [c]: { departingOccupancyPct: 70 } });
  assert.equal(cruiseAssumptions(atCruise.assumptions, atCruise.assumptionsByDate, atCruise.assumptionsByCruise, DAY, AQUA.id).departingOccupancyPct, 105);
  // Applying to the date replaces this cruise's own value so the row shows what was applied.
  const atDate = edit(atCruise, c, { departingOccupancyPct: 90 }, ROW_SCOPE.DATE);
  assert.deepEqual(atDate.assumptionsByCruise, {});
  assert.equal(atDate.assumptionsByDate[DAY].departingOccupancyPct, 90);
  const atProfile = edit(atDate, c, { departingOccupancyPct: 99 }, ROW_SCOPE.PROFILE);
  assert.deepEqual(atProfile.assumptionsByDate, {});
  assert.equal(atProfile.assumptions.departingOccupancyPct, 99);
  // Reset drops this cruise's and date's values for the row's keys only.
  const both = edit(edit(PEAK, c, { departingOccupancyPct: 70 }, ROW_SCOPE.CRUISE), c, { returningOccupancyPct: 80 }, ROW_SCOPE.DATE);
  const reset = { ...both, ...resetRowEdit(both, { callId: c, date: DAY, keys: ['departingOccupancyPct'] }) };
  assert.deepEqual(reset.assumptionsByCruise, {});
  assert.deepEqual(reset.assumptionsByDate, { [DAY]: { returningOccupancyPct: 80 } });
  // Departing and returning rows edit distinct keys: the returning value survived.
  assert.equal(cruiseAssumptions(reset.assumptions, reset.assumptionsByDate, reset.assumptionsByCruise, DAY, c).returningOccupancyPct, 80);
});

test('a long-stay share keeps its side at 100%, visibly, and an impossible one is refused', () => {
  const a = PEAK.assumptions;   // Peak: 15 / 28 / 33 / 24
  const ok = balanceLongStay(a, 'departing', 20);
  assert.deepEqual(ok.values, { departingLongStayPct: 20, departingOtherModePct: 19 });
  assert.equal(ok.issue, null);
  assert.match(balanceLongStay(a, 'departing', 50).issue, /leaves -11% for other modes/);
  // An invalid cruise value is reported against that cruise.
  const bad = edit(PEAK, ALLURE.id, { returningPassengersPerVehicle: 0 }, ROW_SCOPE.CRUISE);
  const issues = scopedAssumptionIssues(bad.assumptions, bad.assumptionsByDate, bad.assumptionsByCruise, { [ALLURE.id]: { label: 'Allure Of The Seas 11-22', dates: [DAY] } });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /^Allure Of The Seas 11-22: Returning passengers per parked car/);
});

test('an exit-window edit on a reconstructed row moves when those cars leave, not how many', () => {
  const after = row(run(edit(PEAK, ALLURE.id, { exitStartAfterArrivalMin: 90, exitEndAfterArrivalMin: 360 }, ROW_SCOPE.CRUISE)), ALLURE);
  const before = row(base, ALLURE);
  assert.equal(after.returning.exitStartMs, ALLURE.arrivalMs + 90 * 60_000);
  assert.equal(after.returning.exitEndMs, ALLURE.arrivalMs + 360 * 60_000);
  assert.equal(after.returning.vehicles, before.returning.vehicles);
  assert.deepEqual(after.returning.exitWindowInputs.editedForCruise.sort(), ['exitEndAfterArrivalMin', 'exitStartAfterArrivalMin']);
  // Norwegian Aqua, the other Terminal-side ship that day, keeps the default window.
  assert.equal(row(run(edit(PEAK, ALLURE.id, { exitStartAfterArrivalMin: 90 }, ROW_SCOPE.CRUISE)), AQUA).returning.exitStartMs, row(base, AQUA).returning.exitStartMs);
});
