/**
 * The recommendation evaluator and the day's shortage measures, on real November data.
 *
 *   Nov 19, Peak, Garage B: 148 Norwegian Jewel cars denied from 10:45. +100 at Garage B leaves 48
 *   (partly reduced); +148 leaves none (resolved).
 *   Nov 21, Peak, Garage B: the same 148 still unmet — a backlog from Nov 19, none denied today.
 *   Nov 21, Typical, Garage B: no shortage. Terminal AAA: no garage. Garage AA: no published capacity.
 * The mapping is the validated county mapping the app uses.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { importDockReport } from '../src/cruise/cruiseCalls.js';
import { applyProfile, defaultCruiseAssumptions } from '../src/cruise/cruiseAssumptions.js';
import { buildCohorts, summarizeDay } from '../src/cruise/turnaroundModel.js';
import { allocationsFromMapping, defaultTerminalGarageMapping, registryFacilities } from '../src/cruise/parkingAllocation.js';
import { runCruiseScenario } from '../src/cruise/cruiseSimulation.js';
import { FOCUS, compareDesigns, demandVsCapacity, explainDemandAt } from '../src/cruise/demandCapacity.js';
import { INFRASTRUCTURE_ASSETS } from '../src/config/infrastructure.js';

const calls = importDockReport(JSON.parse(readFileSync(new URL('../public/data/cruise/portmiami_november_2026_enriched.json', import.meta.url), 'utf8'))).calls;
const FAC = registryFacilities(INFRASTRUCTURE_ASSETS);
const CODES = [...new Set(calls.map(c => c.terminalCode).filter(Boolean))].sort();
const ALLOC = allocationsFromMapping(defaultTerminalGarageMapping(FAC, CODES), CODES);
const PEAK = applyProfile(defaultCruiseAssumptions(), 'PEAK'), TYPICAL = defaultCruiseAssumptions();
const GB = { kind: FOCUS.GARAGE, id: 'parking-garage-b' };
const ORDER = [{ id: 'baseline', key: 'Existing', name: 'Existing' }, { id: 'a', key: 'A', name: 'A. Expand Existing Garage' },
  { id: 'b', key: 'B', name: 'B. New Garage' }, { id: 'c', key: 'C', name: 'C. Optimise Surface Lots' }];
const A = n => ({ id: 'a', key: 'A', type: 'EXPAND_EXISTING', site: { assetId: 'parking-garage-b' }, assumptions: { additionalSpaces: n } });
const B = n => ({ id: 'b', key: 'B', type: 'NEW_GARAGE', site: {}, assumptions: { additionalSpaces: n } });
const C = n => ({ id: 'c', key: 'C', type: 'OPTIMIZE_SURFACE', site: {}, assumptions: { additionalSpaces: n } });

/** Every design through the same cohort set: identical demand by construction. */
function compare({ assumptions = PEAK, day = '2026-11-19', focus = GB, a = A(0), b = B(0), c = C(0), scopeFor = {} } = {}) {
  const cohortSet = buildCohorts(calls, assumptions);
  const dvcs = {}, sims = {};
  for (const [id, scenario] of [['baseline', null], ['a', a], ['b', b], ['c', c]]) {
    sims[id] = runCruiseScenario({ calls, assumptions, allocations: ALLOC, baseFacilities: FAC, scenario, scopeFor, cohortSet });
    dvcs[id] = demandVsCapacity(sims[id], summarizeDay(sims[id], day, { calls }), focus, day);
  }
  return { ...compareDesigns(dvcs, ORDER), dvcs, sims };
}
const UNSUPPORTED = /cheapest|best overall|lowest cost|most economical/i;

test('the day\'s measures: denials today kept apart from an earlier backlog', () => {
  const nov19 = compare().dvcs.baseline;
  assert.equal(nov19.deniedToday, 148);
  assert.equal(nov19.firstDenial.time, '10:45');
  assert.equal(nov19.backlogAtStart, 0);
  assert.equal(nov19.maxShortage.value, 148);
  const nov21 = compare({ day: '2026-11-21' }).dvcs.baseline;
  assert.equal(nov21.deniedToday, 0);
  assert.equal(nov21.firstDenial, null);
  assert.equal(nov21.backlogAtStart, 148, 'Jewel\'s Nov 19 cars are still away');
  assert.match(explainDemandAt({ sim: compare({ day: '2026-11-21' }).sims.baseline, dvc: nov21, index: 48, brief: true }),
    /^At 12:00, Garage B has 809 spaces[\s\S]*148 cars denied earlier \(Norwegian Jewel, denied Nov 19\)/);
});

test('all four designs face the same demand baseline', () => {
  const { dvcs, sims } = compare({ a: A(100), b: B(2000), c: C(1500), scopeFor: { NEW_GARAGE: ['B'], OPTIMIZE_SURFACE: ['B'] } });
  const peaks = Object.values(dvcs).map(d => d.peak.value);
  assert.deepEqual(new Set(peaks).size, 1, `peak demand ${peaks}`);
  const requested = id => sims[id].intervals.map(r => r.requested);
  for (const id of ['a', 'b', 'c']) assert.deepEqual(requested(id), requested('baseline'));
});

test('rule 4 — partly reduced: named as the best-performing modelled option, not a solution', () => {
  const { cards, verdict } = compare({ a: A(100) });
  assert.equal(cards.find(c => c.id === 'a').maxShortage, 48);
  assert.equal(cards.find(c => c.id === 'a').result, 'REDUCES');
  assert.equal(verdict.kind, 'REDUCES');
  assert.equal(verdict.best, 'a');
  assert.match(verdict.headline, /^No alternative fully solves the problem/);
  assert.ok(verdict.why.includes('Cars denied parking: 148 → 48'));
  assert.doesNotMatch(verdict.text + verdict.headline, UNSUPPORTED);
});

test('rule 2 — exactly one resolves it: the only feasible modelled option', () => {
  const { cards, verdict } = compare({ a: A(148) });
  assert.equal(cards.find(c => c.id === 'a').resolved, true);
  assert.equal(verdict.kind, 'ONLY');
  assert.equal(verdict.headline, 'Only feasible modelled option: A. Expand Existing Garage');
  assert.deepEqual(verdict.why.slice(0, 3), ['Cars denied parking: 148 → 0', 'Maximum unmet demand: 148 → 0', 'Time with unmet demand: 13 h 15 min → none']);
  assert.ok(verdict.why.includes('Added spaces usable here: +148'));
});

test('rule 3 — several resolve it: all feasible; the fewest added spaces is "most capacity-efficient", not cheapest', () => {
  const { verdict } = compare({ a: A(148), b: B(2000), scopeFor: { NEW_GARAGE: ['B'] } });
  assert.equal(verdict.kind, 'FEASIBLE');
  assert.deepEqual(verdict.options, ['a', 'b']);
  assert.equal(verdict.fewest, 'a', 'not B, which adds the most spaces');
  assert.match(verdict.text, /A\. Expand Existing Garage is the most capacity-efficient: it needs the fewest added spaces\. That is not a cost comparison/);
  assert.doesNotMatch(verdict.text + verdict.headline, UNSUPPORTED);
});

test('adding the most spaces is not a reason: spaces the terminal cannot use count for nothing', () => {
  // B adds 2,000 spaces for no terminal; only A's 148 at Garage B are usable by Terminal B.
  const { cards, verdict } = compare({ a: A(148), b: B(2000) });
  assert.equal(cards.find(c => c.id === 'b').addedCapacity, 0);
  assert.equal(verdict.best, 'a');
  const none = compare({ b: B(2000) }).verdict;
  assert.equal(none.kind, 'NONE');
  assert.match(none.text, /B adds no spaces these terminals can use/);
});

test('rule 1 — no shortage: no expansion under the current model', () => {
  const { verdict } = compare({ assumptions: TYPICAL, day: '2026-11-21', a: A(500) });
  assert.equal(verdict.kind, 'NONE_NEEDED');
  assert.equal(verdict.headline, 'No expansion needed under the current model');
});

test('rule 5 — missing mapping and unknown capacity: no recommendation, the data needed is named', () => {
  const aaa = compare({ day: '2026-11-21', focus: { kind: FOCUS.TERMINAL, id: 'AAA' } }).verdict;
  assert.equal(aaa.kind, 'ACCESS');
  assert.deepEqual(aaa.needs, ['A garage for Terminal AAA in the terminal → garage mapping']);
  assert.equal(aaa.best, undefined);
  const gaa = compare({ day: '2026-11-21', focus: { kind: FOCUS.GARAGE, id: 'parking-garage-aa' } }).verdict;
  assert.equal(gaa.kind, 'DATA_NEEDED');
  assert.deepEqual(gaa.needs, ['A verified space count for Garage AA']);
  assert.equal(gaa.best, undefined);
});

test('a capacity edit moves every affected result together', () => {
  const at = n => compare({ a: A(n) }).cards.find(c => c.id === 'a');
  const [x, y] = [at(50), at(100)];
  assert.ok(y.capacity > x.capacity && y.maxShortage < x.maxShortage && y.turnedAway < x.turnedAway);
  assert.equal(y.capacity - x.capacity, 50);
});
