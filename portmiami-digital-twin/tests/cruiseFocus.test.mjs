/**
 * The selected cruise, its cohorts, overrides and the garage arithmetic, on the case that exposed
 * the bugs: November 21, Peak, Norwegian Luna (Terminal B) departing at 75% occupancy and a 5%
 * long-stay share — about 2,674 passengers and 54 cars — while its returning cars (parked by its
 * November 14 departure) stay 225.
 *
 * The terminal → garage mapping is the validated county mapping the app uses
 * (`defaultTerminalGarageMapping` → `allocationsFromMapping`), not a test fixture.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { importDockReport } from '../src/cruise/cruiseCalls.js';
import { ROW_SCOPE, applyProfile, applyRowEdit, balanceLongStay, cruiseAssumptions, defaultCruiseAssumptions } from '../src/cruise/cruiseAssumptions.js';
import { PROVENANCE, buildCohorts, summarizeDay, vesselKey } from '../src/cruise/turnaroundModel.js';
import { allocationsFromMapping, defaultTerminalGarageMapping, registryFacilities } from '../src/cruise/parkingAllocation.js';
import { runCruiseScenario } from '../src/cruise/cruiseSimulation.js';
import { dayCruises } from '../src/cruise/simulationInsight.js';
import { FOCUS, compareDesigns, demandVsCapacity } from '../src/cruise/demandCapacity.js';
import { DIRECTION, cohortContribution, cohortFor, cohortRecord, cohortStatus, eligibleGarages, garageEligibility } from '../src/cruise/cruiseFocus.js';
import { OVERRIDE_KIND, clearOverride, recordOverride } from '../src/cruise/cohortOverrides.js';
import { INFRASTRUCTURE_ASSETS } from '../src/config/infrastructure.js';

const CALLS = importDockReport(JSON.parse(readFileSync(new URL('../public/data/cruise/portmiami_november_2026_enriched.json', import.meta.url), 'utf8'))).calls;
const FAC = registryFacilities(INFRASTRUCTURE_ASSETS);
const CODES = [...new Set(CALLS.map(c => c.terminalCode).filter(Boolean))].sort();
const ALLOC = allocationsFromMapping(defaultTerminalGarageMapping(FAC, CODES), CODES);
const DAY = '2026-11-21';
const LUNA = CALLS.find(c => c.shipName === 'Norwegian Luna' && c.arrivalDate === DAY);
const LUNA_14 = CALLS.find(c => c.shipName === 'Norwegian Luna' && c.arrivalDate === '2026-11-14');
const GB = { kind: FOCUS.GARAGE, id: 'parking-garage-b' };

const PEAK = { assumptions: applyProfile(defaultCruiseAssumptions(), 'PEAK'), assumptionsByDate: {}, assumptionsByCruise: {}, cohortOverrides: {}, overrideAudit: [] };
const edit = (state, callId, values, date = DAY, scope = ROW_SCOPE.CRUISE) => ({ ...state, ...applyRowEdit(state, { callId, date, values, scope }) });
const run = (state, scenario = null) => runCruiseScenario({
  calls: CALLS, assumptions: state.assumptions, allocations: ALLOC, baseFacilities: FAC, scenario,
  cohortSet: buildCohorts(CALLS, state.assumptions, { byDate: state.assumptionsByDate, byCruise: state.assumptionsByCruise, overrides: state.cohortOverrides }),
});
const dvcOf = (sim, focus = GB, date = DAY) => demandVsCapacity(sim, summarizeDay(sim, date, { calls: CALLS }), focus, date);

/** The user's edit: Luna departing, this cruise only, 75% occupancy and a 5% long-stay share. */
const lunaEdited = (() => {
  const cur = cruiseAssumptions(PEAK.assumptions, {}, {}, DAY, LUNA.id);
  return edit(PEAK, LUNA.id, { departingOccupancyPct: 75, ...balanceLongStay(cur, 'departing', 5).values });
})();
const base = run(PEAK), edited = run(lunaEdited);

test('1 · Norwegian Luna resolves to Terminal B → Garage B with the validated mapping', () => {
  assert.equal(LUNA.terminalCode, 'B');
  const { primary, mapped } = eligibleGarages({ allocations: ALLOC, facilities: FAC }, 'B');
  assert.equal(primary.id, 'parking-garage-b');
  assert.deepEqual(mapped.map(f => f.id), ['parking-garage-b']);
  // A terminal with no mapped garage resolves to none: "Garage assignment missing", never another.
  assert.equal(eligibleGarages({ allocations: ALLOC, facilities: FAC }, 'AAA').primary, null);
});

test('2 · a garage the cruise may not use is reported, not swapped for another cruise', () => {
  const a = garageEligibility(base, 'B', { kind: FOCUS.GARAGE, id: 'parking-garage-a' });
  assert.equal(a.eligible, false);
  assert.equal(garageEligibility(base, 'B', GB).eligible, true);
});

test('3 · the user\'s edit: 2,674 passengers and 54 cars departing; returning cars stay 225', () => {
  const r = dayCruises(edited, CALLS, DAY).find(x => x.call.id === LUNA.id);
  assert.equal(r.departing.inputs.passengers, 2674);
  assert.equal(r.departing.vehicles, 54);
  assert.equal(r.returningSource.kind, 'RECONSTRUCTED');
  assert.equal(r.returning.callId, LUNA_14.id, 'parked by the November 14 departure');
  assert.equal(r.returning.vehicles, 225);
  const before = dayCruises(base, CALLS, DAY).find(x => x.call.id === LUNA.id);
  assert.deepEqual([r.returning.vehicles, r.leavingVehicles, r.returning.served], [before.returning.vehicles, before.leavingVehicles, before.returning.served]);
});

test('4 · editing the ORIGINAL departure (Nov 14) updates its return on Nov 21, and nothing else', () => {
  const s = edit(PEAK, LUNA_14.id, { departingOccupancyPct: 80 }, '2026-11-14');
  const before = buildCohorts(CALLS, PEAK.assumptions).cohorts;
  const after = buildCohorts(CALLS, s.assumptions, { byCruise: s.assumptionsByCruise }).cohorts;
  const changed = after.filter((c, i) => c.vehicles !== before[i].vehicles).map(c => c.id);
  assert.deepEqual(changed, [`dep-${LUNA_14.id}`]);
  const ret = cohortFor(run(s), LUNA.id, DIRECTION.RETURNING);
  assert.equal(ret.id, `dep-${LUNA_14.id}`);
  assert.ok(ret.vehicles < 225);
  assert.equal(ret.inputs.occupancyPct, 80);
});

test('5 · overrides are audited, honest about their kind, and conserve vehicles', () => {
  const estimated = buildCohorts(CALLS, PEAK.assumptions).cohorts.find(c => c.kind === 'ESTIMATED_RETURN' && c.exitStartMs > Date.UTC(2026, 10, 10));
  const departure = buildCohorts(CALLS, PEAK.assumptions).cohorts.find(c => c.id === `dep-${LUNA_14.id}`);
  // A reconstructed cohort cannot be "manually estimated", and no override goes in without a reason.
  assert.match(recordOverride(PEAK, { cohort: departure, kind: OVERRIDE_KIND.MANUAL_ESTIMATE, vehicles: 10, reason: 'guess from the gate' }).issues[0], /cannot be re-estimated/);
  assert.match(recordOverride(PEAK, { cohort: estimated, kind: OVERRIDE_KIND.MANUAL_ESTIMATE, vehicles: 10, reason: '' }).issues.join(' '), /reason/);
  // A reconciliation needs an acknowledgement as well.
  assert.match(recordOverride(PEAK, { cohort: departure, kind: OVERRIDE_KIND.RECONCILIATION, vehicles: 200, reason: 'Gate count for Nov 14' }).issues.join(' '), /Confirm/);

  let s = { ...PEAK, ...recordOverride(PEAK, { cohort: estimated, kind: OVERRIDE_KIND.MANUAL_ESTIMATE, vehicles: 40, exitStartMin: 60, exitEndMin: 240, reason: 'Terminal survey', at: '2026-11-19T10:00:00Z' }) };
  s = { ...s, ...recordOverride(s, { cohort: departure, kind: OVERRIDE_KIND.RECONCILIATION, vehicles: 200, reason: 'Gate count for Nov 14', acknowledged: true, at: '2026-11-19T10:05:00Z' }) };
  assert.deepEqual(s.overrideAudit.map(a => [a.cohortId, a.action, a.from, a.to]), [[estimated.id, 'SET', estimated.vehicles, 40], [departure.id, 'SET', 225, 200]]);
  const sim = run(s);
  const est = sim.cohorts.find(c => c.id === estimated.id), dep = sim.cohorts.find(c => c.id === departure.id);
  assert.equal(est.provenance, PROVENANCE.MANUAL_ESTIMATE);
  assert.equal(est.vehicles, 40);
  assert.equal(est.calculatedVehicles, estimated.vehicles);
  assert.equal(dep.provenance, PROVENANCE.RECONCILED);
  // The reconciled cars enter at the departure and the same cars leave on the return.
  assert.equal(cohortFor(sim, LUNA.id, DIRECTION.RETURNING).vehicles, 200);
  assert.equal(cohortStatus(sim, dep.id, sim.endMs).left, dep.servedTotal);
  assert.equal(sim.checks.conservationOk, true);
  const cleared = { ...s, ...clearOverride(s, { cohort: dep, at: '2026-11-19T11:00:00Z' }) };
  assert.equal(cleared.overrideAudit.at(-1).action, 'CLEARED');
  assert.equal(cohortFor(run(cleared), LUNA.id, DIRECTION.RETURNING).vehicles, 225);
});

test('6 · parking conservation holds in every 15-minute interval of every garage', () => {
  for (const sim of [base, edited]) {
    assert.equal(sim.checks.conservationOk, true);
    for (const r of sim.intervals) for (const f of sim.facilities) {
      const x = r.facilities[f.id];
      assert.equal(x.end, x.start + x.served - x.exits, `${f.id} @${r.index}`);
    }
  }
});

test('7 · rejected cars are never counted as parked', () => {
  // Occupancy of each garage equals the cars of its cohorts admitted and not yet gone.
  const parkedIn = new Map();
  for (const m of base.initialMoves) if (['IN', 'SPILL', 'OVERFLOW'].includes(m.type)) parkedIn.set(m.facilityId, (parkedIn.get(m.facilityId) ?? 0) + m.n);
  for (const r of base.intervals) {
    for (const m of r.moves) {
      if (['IN', 'SPILL', 'OVERFLOW'].includes(m.type)) parkedIn.set(m.facilityId, (parkedIn.get(m.facilityId) ?? 0) + m.n);
      if (m.type === 'OUT') parkedIn.set(m.facilityId, parkedIn.get(m.facilityId) - m.n);
    }
    for (const f of base.facilities) assert.equal(r.facilities[f.id].end, parkedIn.get(f.id) ?? 0, `${f.id} @${r.index}`);
  }
  assert.ok(base.cohorts.some(c => c.unserved > 0), 'Peak does turn cars away');
});

test('8 · capacity, parked and free spaces stay consistent', () => {
  const d = dvcOf(edited);
  for (const s of d.series) {
    assert.ok(s.occupied <= d.capacity);
    assert.equal(s.free, Math.max(0, d.capacity - s.occupied));
    assert.equal(s.occupied, s.startOccupied + s.entries - s.exits);
    assert.ok(s.rejectedNow <= s.shortage);
    assert.equal(s.required, s.occupied + s.shortage + s.unchecked);
  }
});

test('9 · a design change updates the comparison', () => {
  const order = [{ id: 'baseline', key: 'Existing', name: 'Existing' }, { id: 'a', key: 'A', name: 'A. Expand Existing Garage' }];
  const A = n => ({ id: 'a', key: 'A', type: 'EXPAND_EXISTING', site: { assetId: 'parking-garage-b' }, assumptions: { additionalSpaces: n } });
  const small = compareDesigns({ baseline: dvcOf(base), a: dvcOf(run(PEAK, A(50))) }, order);
  const big = compareDesigns({ baseline: dvcOf(base), a: dvcOf(run(PEAK, A(800))) }, order);
  const card = (x, id) => x.cards.find(c => c.id === id);
  assert.ok(card(small, 'baseline').maxShortage > 0);
  assert.ok(card(small, 'a').maxShortage > 0 && card(big, 'a').maxShortage === 0);
  assert.equal(big.verdict.best, 'a');
  assert.ok(card(big, 'a').turnedAway === 0 && card(big, 'a').firstShortage === null);
});

test('10 · the selected cruise\'s demand is inside the garage total exactly once', () => {
  const d = dvcOf(edited);
  const all = edited.cohorts.map(c => cohortContribution(edited, d, c.id).series);
  d.series.forEach((s, i) => {
    const sum = all.reduce((t, x) => t + x[i].total, 0);
    assert.equal(sum, s.required, `${s.time}: every cohort together is the total`);
  });
  const luna = cohortContribution(edited, d, `dep-${LUNA.id}`);
  assert.equal(luna.peak, 54, 'all 54 Luna cars park in Garage B');
  assert.ok(d.series.every((s, i) => luna.series[i].total <= s.required));
  // And the cars it has parked match the run's own record of where they went.
  const end = cohortStatus(edited, `dep-${LUNA.id}`, d.series.at(-1).startMs);
  assert.deepEqual(end.byGarage, { 'parking-garage-b': 54 });
});

test('the cohort record carries the data model\'s fields, with provenance', () => {
  const rec = cohortRecord(edited, cohortFor(edited, LUNA.id, DIRECTION.RETURNING), CALLS, Date.UTC(2026, 10, 21, 12));
  assert.equal(rec.cohortId, `dep-${LUNA_14.id}`);
  assert.equal(rec.originDepartureCallId, LUNA_14.id);
  assert.equal(rec.returnCallId, LUNA.id);
  assert.equal(rec.vesselId, 'IMO:9824019');
  assert.equal(rec.terminalId, 'B');
  assert.equal(rec.originalParkedCars, 225);
  assert.equal(rec.calculationProvenance, PROVENANCE.ASSUMPTIONS);
  assert.ok(rec.remainingParkedCars < 225, 'by noon some have left');
  for (const k of ['departureDateTime', 'expectedReturnDateTime', 'garageAllocations', 'estimatedPassengers', 'parkingShare', 'passengersPerCar', 'sourceAssumptions']) assert.ok(rec[k] !== undefined && rec[k] !== null, k);
});

test('voyages are matched by IMO, not by ship name', () => {
  const [a, b] = [LUNA_14, LUNA].map(c => ({ ...c, voyageOptions: [] }));
  const renamedHull = { ...b, vesselImo: '9999999', vesselId: 'imo-9999999' };   // same name, another ship
  const linked = buildCohorts([a, b], PEAK.assumptions).cohorts.find(c => c.id === `dep-${a.id}`);
  assert.equal(linked.returnCallId, b.id);
  const notLinked = buildCohorts([a, renamedHull], PEAK.assumptions).cohorts.find(c => c.id === `dep-${a.id}`);
  assert.equal(notLinked.returnCallId, null);
  assert.equal(vesselKey(a), 'IMO:9824019');
});

test('occupancy above 100% only on a double-occupancy capacity basis', () => {
  const at105 = { ...PEAK.assumptions };   // Peak: 105%
  const lower = buildCohorts([LUNA], at105).cohorts.find(c => c.kind === 'DEPARTING');
  assert.equal(lower.inputs.occupancyPct, 105);
  assert.equal(lower.inputs.capacityBasis, 'double_occupancy');
  const max = buildCohorts([{ ...LUNA, capacityType: 'maximum' }], at105).cohorts.find(c => c.kind === 'DEPARTING');
  assert.equal(max.inputs.occupancyPct, 100);
  assert.equal(max.inputs.occupancyCappedFrom, 105);
  assert.equal(lower.inputs.manifestPassengers, null, 'no manifest: passengers are estimated, not observed');
});
