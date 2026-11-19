/**
 * Demand against capacity — the Cruise Parking Simulation's decision view — on the real
 * November 22 data (Peak preset): Garage A, Garage B, Garage G, Terminal AAA (no garage), and the
 * existing layout against A, B and C.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { importDockReport } from '../src/cruise/cruiseCalls.js';
import { applyProfile, defaultCruiseAssumptions } from '../src/cruise/cruiseAssumptions.js';
import { summarizeDay } from '../src/cruise/turnaroundModel.js';
import { allocationsFromMapping, defaultTerminalGarageMapping, registryFacilities } from '../src/cruise/parkingAllocation.js';
import { runCruiseScenario } from '../src/cruise/cruiseSimulation.js';
import { DESIGN_RESULT, FOCUS, compareDesigns, demandVsCapacity, explainDemandAt } from '../src/cruise/demandCapacity.js';
import { INFRASTRUCTURE_ASSETS } from '../src/config/infrastructure.js';

const D = '2026-11-22';
const { calls } = importDockReport(JSON.parse(readFileSync(new URL('../public/data/cruise/portmiami_november_2026_enriched.json', import.meta.url), 'utf8')));
const FAC = registryFacilities(INFRASTRUCTURE_ASSETS);
const CODES = [...new Set([...INFRASTRUCTURE_ASSETS.filter(a => a.category === 'CRUISE_TERMINAL').map(a => a.code), ...calls.map(c => c.terminalCode)])].sort();
const ALLOC = allocationsFromMapping(defaultTerminalGarageMapping(FAC, CODES), CODES);
const PEAK = applyProfile(defaultCruiseAssumptions(), 'PEAK');

const DESIGNS = [
  { id: 'baseline', key: 'Existing', name: 'Existing', scenario: null },
  { id: 'a', key: 'A', name: 'A. Expand Garage B', scenario: { id: 'a', key: 'A', type: 'EXPAND_EXISTING', site: { assetId: 'parking-garage-b' }, assumptions: { additionalSpaces: 500 } } },
  { id: 'b', key: 'B', name: 'B. New Garage', scenario: { id: 'b', key: 'B', type: 'NEW_GARAGE', site: {}, assumptions: { additionalSpaces: 2000 } } },
  { id: 'c', key: 'C', name: 'C. Surface Lot E', scenario: { id: 'c', key: 'C', type: 'OPTIMIZE_SURFACE', site: { assetId: 'parking-surface-lot-e' }, assumptions: { additionalSpaces: 1500 } } },
];
// B and C are given overflow access to every terminal explicitly, to test what that assumption does.
const OPEN = { NEW_GARAGE: 'ANY_TERMINAL', OPTIMIZE_SURFACE: 'ANY_TERMINAL' };
const SIMS = Object.fromEntries(DESIGNS.map(d => [d.id, runCruiseScenario({ calls, assumptions: PEAK, allocations: ALLOC, baseFacilities: FAC, scenario: d.scenario, scopeFor: OPEN })]));
const SUMS = Object.fromEntries(Object.entries(SIMS).map(([id, sim]) => [id, summarizeDay(sim, D, { calls })]));
const dvcFor = (focus, id = 'baseline') => demandVsCapacity(SIMS[id], SUMS[id], focus, D);
const all = focus => Object.fromEntries(DESIGNS.map(d => [d.id, dvcFor(focus, d.id)]));
const garage = id => ({ kind: FOCUS.GARAGE, id });

test('engine: spaces required = parked + turned-away cars still away + unchecked cars, never negative', () => {
  for (const sim of Object.values(SIMS)) {
    for (const r of sim.intervals) {
      for (const f of sim.facilities) {
        const x = r.facilities[f.id];
        assert.equal(x.required, x.end + x.shortActive + x.noDataActive);
        assert.ok(x.shortActive >= 0 && x.noDataActive >= 0);
        if (Number.isFinite(f.capacity)) assert.ok(x.end <= f.capacity, 'turned-away cars are never parked');
      }
    }
  }
});

test('Garage A: demand exceeds its 1,046 spaces; while it is full, the shortage is demand minus capacity', () => {
  const d = dvcFor(garage('parking-garage-a'));
  assert.equal(d.capacity, 1046);
  assert.ok(d.maxShortage.value > 0);
  for (const s of d.series) {
    assert.equal(s.required, s.occupied + s.shortage + s.unchecked);
    assert.ok(s.shortage >= Math.max(0, s.required - 1046));
    if (s.occupied === 1046) assert.equal(s.shortage, s.required - 1046);
  }
  assert.ok(d.firstShortage && d.shortageIntervals > 0);
});

test('Garage B: expanding Garage B (A) resolves its shortage; it does nothing for Garage A', () => {
  const b = compareDesigns(all(garage('parking-garage-b')), DESIGNS);
  assert.ok(b.cards.find(c => c.id === 'baseline').maxShortage > 0);
  assert.equal(b.cards.find(c => c.id === 'a').result, DESIGN_RESULT.RESOLVES);
  const a = compareDesigns(all(garage('parking-garage-a')), DESIGNS);
  const base = a.cards.find(c => c.id === 'baseline'), expandB = a.cards.find(c => c.id === 'a');
  assert.equal(expandB.maxShortage, base.maxShortage, 'an expansion at another garage does not solve this one');
  assert.equal(expandB.capacity, base.capacity);
});

test('Garage G: no shortage, and the sentence says so with the free spaces', () => {
  const d = dvcFor(garage('parking-garage-g'));
  assert.equal(d.maxShortage.value, 0);
  assert.equal(d.firstShortage, null);
  assert.match(explainDemandAt({ sim: SIMS.baseline, dvc: d, index: 48 }), /Garage G has 1,735 spaces \(\d[\d,]* occupied, \d[\d,]* free\)[\s\S]*No car is without parking/);
  assert.equal(compareDesigns(all(garage('parking-garage-g')), DESIGNS).verdict.kind, 'NONE_NEEDED');
});

test('Terminal AAA: a missing garage assignment, never a capacity shortage', () => {
  const d = dvcFor({ kind: FOCUS.TERMINAL, id: 'AAA' });
  assert.equal(d.missingAssignment, true);
  assert.equal(d.capacity, 0);
  assert.equal(d.maxShortage.value, 0);
  assert.ok(d.maxUnallocated > 0);
  assert.match(explainDemandAt({ sim: SIMS.baseline, dvc: d, index: 48 }), /missing garage assignment, not a capacity shortage/);
  const cmp = compareDesigns(all({ kind: FOCUS.TERMINAL, id: 'AAA' }), DESIGNS);
  assert.equal(cmp.cards.find(c => c.id === 'baseline').result, DESIGN_RESULT.ASSIGNMENT_MISSING);
  assert.equal(cmp.cards.find(c => c.id === 'a').result, DESIGN_RESULT.ASSIGNMENT_MISSING, 'expanding Garage B does not reach AAA');
  assert.equal(cmp.cards.find(c => c.id === 'b').result, DESIGN_RESULT.PROVIDES_ACCESS, 'B only through its assumed any-terminal access');
  assert.match(cmp.verdict.text, /missing assignment, not a capacity shortage/);
  assert.equal(cmp.verdict.kind, 'ACCESS');
});

test('all garages: unallocated and unchecked cars are kept out of the shortage', () => {
  const d = dvcFor({ kind: FOCUS.ALL });
  assert.ok(d.maxUnallocated > 0 && d.maxUnchecked > 0);
  const byTerminal = SIMS.baseline.intervals.filter(r => d.series.some(s => s.startMs === r.startMs));
  d.series.forEach((s, k) => {
    // Cars without parking are counted by terminal; unallocated and unchecked cars are not among them.
    assert.equal(s.shortage, d.terminals.reduce((t, code) => t + (byTerminal[k].terminalShort?.[code] ?? 0), 0));
    assert.ok(!Object.keys(byTerminal[k].terminalShort ?? {}).includes('AAA'));
  });
  assert.equal(d.constrained, true, 'cars are without parking while spaces stand free elsewhere in the group');
});

test('a backlog from an earlier day is named as such, never as a new shortage', () => {
  // Garage B on Nov 22 (Peak): no car is denied today; 148 Norwegian Jewel cars denied on Nov 19
  // are still away on their voyage. The sentence names them and the day, and says they do not retry.
  const d = dvcFor(garage('parking-garage-b'));
  assert.equal(d.deniedToday, 0);
  assert.equal(d.firstDenial, null);
  assert.equal(d.backlogAtStart, 148);
  const busy = d.series.find(s => s.shortage > 0 && s.entries > 0);
  const text = explainDemandAt({ sim: SIMS.baseline, dvc: d, index: busy.index });
  assert.match(text, /Norwegian Aqua/);
  assert.match(text, /Garage B has 809 spaces/);
  assert.match(text, /148 cars denied earlier \(Norwegian Jewel, denied Nov 19\) are still without parking until their ship returns; they do not retry/);
  assert.doesNotMatch(text, /cannot be accommodated now/);
});

test('switching designs changes the parking, never the cruise demand', () => {
  const requested = id => SIMS[id].intervals.reduce((t, r) => t + r.requested, 0);
  const cohorts = id => SIMS[id].cohorts.map(c => [c.id, c.vehicles]);
  for (const d of DESIGNS) {
    assert.equal(requested(d.id), requested('baseline'));
    assert.deepEqual(cohorts(d.id), cohorts('baseline'));
    assert.equal(SUMS[d.id].demand, SUMS.baseline.demand);
  }
});

test('the same date, assumptions and design give identical results', () => {
  const again = runCruiseScenario({ calls, assumptions: PEAK, allocations: ALLOC, baseFacilities: FAC, scenario: DESIGNS[1].scenario, scopeFor: OPEN });
  const x = demandVsCapacity(again, summarizeDay(again, D, { calls }), garage('parking-garage-b'), D);
  assert.deepEqual(x, dvcFor(garage('parking-garage-b'), 'a'));
});

test('several designs that each remove a shortage are listed as feasible, not ranked', () => {
  const dvcs = all(garage('parking-garage-b'));
  const twin = { ...dvcs, a2: dvcs.a };
  const out = compareDesigns(twin, [...DESIGNS, { id: 'a2', key: 'A2', name: 'A2' }]);
  assert.equal(out.verdict.kind, 'FEASIBLE', 'identical designs are both feasible, not ranked');
  assert.equal(out.verdict.fewest, null, 'equal added spaces: neither "needs the fewest"');
  assert.doesNotMatch(out.verdict.text, /cheapest|easier/);
});

test('by default a new garage gives Terminal AAA nothing: access must be configured', () => {
  const sim = runCruiseScenario({ calls, assumptions: PEAK, allocations: ALLOC, baseFacilities: FAC, scenario: DESIGNS[2].scenario });
  const d = demandVsCapacity(sim, summarizeDay(sim, D, { calls }), { kind: FOCUS.TERMINAL, id: 'AAA' }, D);
  assert.equal(d.missingAssignment, true);
});

// ---- the recommendation: Garage A, November 22 -----------------------------------------------------------

const GA = garage('parking-garage-a');
const runWith = (scenario, scopeFor = {}) => {
  const sim = runCruiseScenario({ calls, assumptions: PEAK, allocations: ALLOC, baseFacilities: FAC, scenario, scopeFor });
  return demandVsCapacity(sim, summarizeDay(sim, D, { calls }), GA, D);
};
const A = n => ({ id: 'a', key: 'A', name: 'A. Expand Existing Garage', type: 'EXPAND_EXISTING', site: { assetId: 'parking-garage-a' }, assumptions: { additionalSpaces: n } });
const B = n => ({ id: 'b', key: 'B', name: 'B. New Garage', type: 'NEW_GARAGE', site: {}, assumptions: { additionalSpaces: n } });
const C = n => ({ id: 'c', key: 'C', name: 'C. Optimise Surface Lots', type: 'OPTIMIZE_SURFACE', site: {}, assumptions: { additionalSpaces: n } });
const ORDER = [{ id: 'baseline', key: 'Existing', name: 'Existing' }, { id: 'a', key: 'A', name: 'A. Expand Existing Garage' }, { id: 'b', key: 'B', name: 'B. New Garage' }, { id: 'c', key: 'C', name: 'C. Optimise Surface Lots' }];
const ACCESS_A = { NEW_GARAGE: ['A'], OPTIMIZE_SURFACE: ['A'] };
const recommend = (a, b, c) => compareDesigns({ baseline: dvcFor(GA), a: runWith(A(a), ACCESS_A), b: runWith(B(b), ACCESS_A), c: runWith(C(c), ACCESS_A) }, ORDER);

test('Garage A: all three eliminate the shortage; A does it with the fewest added spaces', () => {
  const { cards, verdict } = recommend(1000, 2000, 1500);
  assert.ok(cards.find(x => x.id === 'baseline').maxShortage > 0);
  for (const id of ['a', 'b', 'c']) assert.equal(cards.find(x => x.id === id).maxShortage, 0, id);
  // Several designs resolve it: feasible options, none called best without cost or land data.
  assert.equal(verdict.kind, 'FEASIBLE');
  assert.equal(verdict.best, undefined);
  assert.deepEqual(verdict.options, ['a', 'c', 'b']);
  assert.equal(verdict.fewest, 'a');
  assert.equal(verdict.headline, 'Feasible options: A, C and B');
  assert.match(verdict.text, /each remove Garage A's modelled shortage under the same demand, adding A 1,000, C 1,500 and B 2,000 usable spaces\. A\. Expand Existing Garage is the most capacity-efficient: it needs the fewest added spaces\. That is not a cost comparison/);
  assert.doesNotMatch(verdict.text + verdict.headline, /cheapest|best overall|Recommended/);
  assert.match(verdict.text, /cost, land, access, constructability and engineering feasibility are not modelled/);
  assert.ok(verdict.why.some(w => /Maximum unmet demand: \d[\d,]* → 0/.test(w)), 'why is the calculated difference');
  assert.equal(verdict.added, 1000);
  assert.equal(verdict.after, 0);
});

test('Garage A: shrinking A until its shortage returns hands the recommendation to the next most efficient', () => {
  const { cards, verdict } = recommend(100, 2000, 1500);
  assert.ok(cards.find(x => x.id === 'a').maxShortage > 0, '+100 is not enough');
  assert.equal(verdict.fewest, 'c', 'C now eliminates it with fewer added spaces than B');
  assert.ok(!verdict.options.includes('a'));
});

test('Garage A: growing B and C, or shrinking them, moves the recommendation with them', () => {
  assert.ok(recommend(1000, 600, 1500).cards.find(x => x.id === 'b').maxShortage > 0, 'B at 600 does not: its overflow fills over the week');
  assert.equal(recommend(1000, 800, 1500).verdict.fewest, 'b', 'B at 800 is now the smallest that eliminates it');
  const none = recommend(50, 150, 50);
  assert.equal(none.verdict.kind, 'REDUCES');
  assert.equal(none.verdict.best, 'b');
  assert.match(none.verdict.text, /No alternative removes Garage A's modelled shortage\. B\. New Garage reduces it most — it is only the best-performing of the modelled options, not a solution/);
  assert.equal(none.verdict.headline, 'No alternative fully solves the problem — B. New Garage reduces it most');
  assert.equal(recommend(50, 50, 50).verdict.kind, 'TIE', 'equal additions reduce it equally: a tie, not a pick');
});

test('switching garage changes the recommendation, and a design for another garage does nothing', () => {
  const gb = compareDesigns({ baseline: dvcFor(garage('parking-garage-b')),
    a: demandVsCapacity(SIMS.a, SUMS.a, garage('parking-garage-b'), D), b: dvcFor(garage('parking-garage-b'), 'b'), c: dvcFor(garage('parking-garage-b'), 'c') }, ORDER);
  assert.equal(gb.verdict.best, 'a', 'expanding Garage B is the efficient fix for Garage B');
  const ga = compareDesigns({ baseline: dvcFor(GA), a: demandVsCapacity(SIMS.a, SUMS.a, GA, D), b: dvcFor(GA, 'b'), c: dvcFor(GA, 'c') }, ORDER);
  assert.notEqual(ga.verdict.best, 'a', 'expanding Garage B is not recommended for Garage A');
});

// ---- the minimum expansion, searched with the simulation ---------------------------------------------------

import { SEARCH_STATUS, findMinimumExpansion } from '../src/cruise/designSearch.js';

test('search: finds the exact threshold of a monotone shortage, and says when none is needed or none works', async () => {
  const at = k => n => ({ maxShortage: Math.max(0, k - n), turnedAway: 0 });
  const r = await findMinimumExpansion(at(637));
  assert.equal(r.status, SEARCH_STATUS.FOUND);
  assert.equal(r.minimum, 637);
  assert.equal(r.confirmed, true);
  assert.equal((await findMinimumExpansion(at(0))).status, SEARCH_STATUS.NONE_NEEDED);
  const never = await findMinimumExpansion(() => ({ maxShortage: 5, turnedAway: 0 }), { upper: 1000 });
  assert.equal(never.status, SEARCH_STATUS.INFEASIBLE);
});

test('search on Garage A, November 22: more than peak minus capacity, and exactly enough', async () => {
  const base = dvcFor(GA);
  const evaluate = n => {
    const d = runWith(A(n));
    return { maxShortage: d.maxShortage.value, turnedAway: d.turnedAway };
  };
  const r = await findMinimumExpansion(evaluate);
  assert.equal(r.status, SEARCH_STATUS.FOUND);
  assert.ok(r.minimum > base.maxShortage.value, `${r.minimum} > peak shortage ${base.maxShortage.value}: cars turned away earlier are still away`);
  assert.ok(r.minimum > 600 && r.minimum <= 700, `minimum ${r.minimum}`);
  assert.equal(runWith(A(r.minimum)).maxShortage.value, 0);
  assert.ok(runWith(A(r.minimum - 1)).maxShortage.value > 0);
  assert.equal(r.confirmed, true);
});
