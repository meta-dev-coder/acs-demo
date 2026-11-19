/**
 * Editing a parking design in the Cruise Parking Simulation: the scenario the planner holds is
 * changed (here, as the hook's draft would change it), every run is recomputed, and only the
 * infrastructure moves. Real November 22 data, Peak preset.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { importDockReport } from '../src/cruise/cruiseCalls.js';
import { applyProfile, defaultCruiseAssumptions } from '../src/cruise/cruiseAssumptions.js';
import { summarizeDay } from '../src/cruise/turnaroundModel.js';
import { allocationsFromMapping, defaultTerminalGarageMapping, registryFacilities, scenarioFacilities } from '../src/cruise/parkingAllocation.js';
import { runCruiseScenario } from '../src/cruise/cruiseSimulation.js';
import { FOCUS, demandVsCapacity } from '../src/cruise/demandCapacity.js';
import { CHANGE, CHECK, beforeAfter, checkExpansion, checkNewGarage, checkSurfaceLot, ringsAreaM2 } from '../src/cruise/designCheck.js';
import { INFRASTRUCTURE_ASSETS } from '../src/config/infrastructure.js';

const D = '2026-11-22';
const { calls } = importDockReport(JSON.parse(readFileSync(new URL('../public/data/cruise/portmiami_november_2026_enriched.json', import.meta.url), 'utf8')));
const FAC = registryFacilities(INFRASTRUCTURE_ASSETS);
const CODES = [...new Set([...INFRASTRUCTURE_ASSETS.filter(a => a.category === 'CRUISE_TERMINAL').map(a => a.code), ...calls.map(c => c.terminalCode)])].sort();
const ALLOC = allocationsFromMapping(defaultTerminalGarageMapping(FAC, CODES), CODES);
const PEAK = applyProfile(defaultCruiseAssumptions(), 'PEAK');

const run = (scenario, scopeFor = {}) => {
  const sim = runCruiseScenario({ calls, assumptions: PEAK, allocations: ALLOC, baseFacilities: FAC, scenario, scopeFor });
  return { sim, summary: summarizeDay(sim, D, { calls }) };
};
const expandB = n => ({ id: 'a', key: 'A', type: 'EXPAND_EXISTING', site: { assetId: 'parking-garage-b' }, assumptions: { additionalSpaces: n, addedFloors: 3 } });
const focus = id => ({ kind: FOCUS.GARAGE, id });
const at = (r, f) => demandVsCapacity(r.sim, r.summary, f, D);
const BASE = run(null);

test('A on Garage B: 0 → 500 → 700 added spaces, the shortage follows the model', () => {
  const base = at(BASE, focus('parking-garage-b'));
  assert.ok(base.maxShortage.value > 0, 'Garage B is short on Nov 22 at Peak');
  const results = [0, 500, 700].map(n => at(run(expandB(n)), focus('parking-garage-b')));
  assert.equal(results[0].maxShortage.value, base.maxShortage.value, '+0 changes nothing');
  assert.equal(results[1].capacity, 809 + 500);
  assert.equal(results[2].capacity, 809 + 700);
  assert.ok(results[1].maxShortage.value <= base.maxShortage.value);
  assert.ok(results[2].maxShortage.value <= results[1].maxShortage.value, 'more spaces never make it worse');
  const ba = beforeAfter({ base, draft: results[2], sim: run(expandB(700)).sim });
  assert.equal(ba.capacity[0], 809);
  assert.equal(ba.capacity[1], 1509);
  assert.ok([CHANGE.ELIMINATED, CHANGE.REDUCED].includes(ba.change));
});

test('expanding Garage B never resolves Garage A', () => {
  const baseA = at(BASE, focus('parking-garage-a'));
  for (const n of [500, 700, 5000]) {
    const r = at(run(expandB(n)), focus('parking-garage-a'));
    assert.equal(r.maxShortage.value, baseA.maxShortage.value);
    assert.equal(r.capacity, 1046);
    const ba = beforeAfter({ base: baseA, draft: r, sim: run(expandB(n)).sim });
    assert.equal(ba.change, CHANGE.NO_IMPROVEMENT);
    assert.match(ba.reason, /Garage B \(\+[\d,]+\) serves Terminal B/);
  }
});

test('existing capacity is never overwritten, and the cohorts never change', () => {
  const f = scenarioFacilities(FAC, expandB(500));
  const b = f.find(x => x.id === 'parking-garage-b');
  assert.equal(b.existingCapacity, 809);
  assert.equal(b.capacity, 1309);
  assert.equal(FAC.find(x => x.id === 'parking-garage-b').capacity, 809, 'the registry facility is untouched');
  const r = run(expandB(700));
  assert.deepEqual(r.sim.cohorts.map(c => [c.id, c.vehicles]), BASE.sim.cohorts.map(c => [c.id, c.vehicles]));
  assert.equal(r.summary.demand, BASE.summary.demand);
});

test('parked cars never exceed capacity and utilization never exceeds 100%', () => {
  for (const sc of [null, expandB(500)]) {
    const r = run(sc);
    for (const f of r.summary.facilities.filter(x => Number.isFinite(x.capacity))) {
      for (const t of r.summary.timeline) assert.ok(t.facilities[f.id].end <= f.capacity);
    }
    const d = at(r, focus('parking-garage-b'));
    for (const s of d.series) assert.ok(s.occupied <= d.capacity);
  }
});

test('B: capacity and terminal access are both inputs; no access, no effect', () => {
  const B = n => ({ id: 'b', key: 'B', type: 'NEW_GARAGE', site: {}, assumptions: { additionalSpaces: n } });
  const none = at(run(B(2000)), focus('parking-garage-b'));
  const base = at(BASE, focus('parking-garage-b'));
  assert.equal(none.maxShortage.value, base.maxShortage.value, 'without configured access B helps no terminal');
  const forB = at(run(B(2000), { NEW_GARAGE: ['B'] }), focus('parking-garage-b'));
  assert.ok(forB.maxShortage.value < base.maxShortage.value, 'given access from Terminal B, it takes B\'s overflow');
  const small = at(run(B(20), { NEW_GARAGE: ['B'] }), focus('parking-garage-b'));
  assert.ok(small.maxShortage.value >= forB.maxShortage.value, 'a smaller new garage helps less');
});

test('C: added spaces go to the chosen surface lots, for their own terminals', () => {
  const C = { id: 'c', key: 'C', type: 'OPTIMIZE_SURFACE', site: {}, assumptions: { additionalSpaces: 0 },
    lotAdditions: [{ assetId: 'parking-surface-lot-d', additionalSpaces: 60 }, { assetId: 'parking-surface-lot-e', additionalSpaces: 100 }] };
  const f = scenarioFacilities(FAC, C);
  assert.equal(f.find(x => x.id === 'parking-surface-lot-d').capacity, 195);
  assert.equal(f.find(x => x.id === 'parking-surface-lot-e').capacity, 611);
  const r = at(run(C), { kind: FOCUS.TERMINAL, id: 'D' });
  assert.equal(r.capacity, 822 + 195, 'Terminal D sees Garage D and its enlarged lot');
  assert.equal(at(run(C), focus('parking-garage-b')).capacity, 809, 'Terminal B gains nothing from lots it does not use');
});

test('geometry checks: area from a footprint, and an honest "cannot check" without one', () => {
  // A 100 m × 100 m square near PortMiami.
  const dLat = 100 / 111_195, dLon = 100 / (111_195 * Math.cos(25.77 * Math.PI / 180));
  const sq = [[[-80.17, 25.77], [-80.17 + dLon, 25.77], [-80.17 + dLon, 25.77 + dLat], [-80.17, 25.77 + dLat], [-80.17, 25.77]]];
  assert.ok(Math.abs(ringsAreaM2(sq) - 10_000) < 50);
  const ok = checkExpansion({ name: 'G', footprints: [sq], addedFloors: 2, additionalSpaces: 500, grossAreaPerSpaceM2: 32 });
  assert.equal(ok.status, CHECK.CONSISTENT);   // 312 per floor × 2 = 624
  assert.equal(checkExpansion({ name: 'G', footprints: [sq], addedFloors: 1, additionalSpaces: 500, grossAreaPerSpaceM2: 32 }).status, CHECK.EXCEEDS);
  assert.equal(checkExpansion({ name: 'G', footprints: undefined, addedFloors: 2, additionalSpaces: 500, grossAreaPerSpaceM2: 32 }).status, CHECK.UNKNOWN);
  assert.equal(checkSurfaceLot({ name: 'Lot C', footprints: [sq], existing: null, added: 50, surfaceAreaPerSpaceM2: 28 }).status, CHECK.UNKNOWN);
  assert.equal(checkSurfaceLot({ name: 'Lot E', footprints: [sq], existing: 200, added: 100, surfaceAreaPerSpaceM2: 28 }).status, CHECK.CONSISTENT);   // holds 357
  assert.equal(checkSurfaceLot({ name: 'Lot E', footprints: [sq], existing: 300, added: 100, surfaceAreaPerSpaceM2: 28 }).status, CHECK.EXCEEDS);
  assert.equal(checkNewGarage({ capacity: null, placed: false }).status, CHECK.UNKNOWN);
});
