import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit, resolveTargets, runInvestigation } from '../src/ifcSpatial/askOrchestrator.js';
import { planQuestion } from '../src/ifcSpatial/askIntent.js';

const STATUS = { 'TX-M2': 'DEGRADED', 'TX-3': 'DEGRADED', 'STS-02': 'DEGRADED', 'TX-M1': 'POWERED', 'HM-3': 'NO_POWER' };
const CAT = { 'TX-M2': 'Transformer', 'TX-3': 'Transformer', 'STS-02': 'Crane', 'TX-M1': 'Transformer', 'HM-3': 'Mast' };
const IDS = new Set(Object.keys(STATUS));
const area = { selectionId: 'area-1', versionKey: 'k' };
const plan = (q, conversation = {}) => planQuestion(q, { knownIds: IDS, namedIds: q2 => [...IDS].filter(id => q2.includes(id)), categoriesIn: q2 => (/transformers?/i.test(q2) ? ['Transformer'] : null), conversation, area });
const tools = (over = {}) => ({
  scopeAssets: scope => (scope.type === 'SELECTED_AREA' ? ['TX-M2', 'TX-M1', 'STS-02', 'CB-X'] : [...IDS]),
  statusOf: id => (STATUS[id] ? { status: STATUS[id], monitored: true } : null), categoryOf: id => CAT[id] ?? null, isAsset: id => IDS.has(id),
  documentsOf: id => ({ 'TX-M2': [{}, {}], 'TX-3': [{}], 'STS-02': [] })[id] ?? [],
  analyze: async id => ({ asset: { id }, inspections: { count: 1 } }), ...over });

test('targets: a status filter over the area (status word as a filter, not the answer)', () => {
  const t = resolveTargets(plan('For degraded asset, what needs to be fixed?'), tools());
  assert.deepEqual(t.ids, ['TX-M2', 'STS-02']);
  assert.deepEqual(t.notAssets, ['CB-X']);
  assert.deepEqual(resolveTargets(plan('Show what needs to be fixed for all degraded assets across Seagirt'), tools()).ids, ['TX-M2', 'TX-3', 'STS-02'], 'whole terminal');
  assert.deepEqual(resolveTargets(plan('For degraded transformers, what needs to be fixed?'), tools()).ids, ['TX-M2']);
  assert.deepEqual(resolveTargets(plan('What needs to be fixed?', { collection: { ids: ['TX-3'] } }), tools()).ids, ['TX-3'], 'a referenced asset wherever it is');
});

test('dependent steps in order; documents read only for assets with linked documents; parallel with a limit', async () => {
  const steps = []; let running = 0, peak = 0; const read = [];
  const r = await runInvestigation(plan('Show what needs to be fixed for all degraded assets across Seagirt'), tools({
    analyze: async id => { running += 1; peak = Math.max(peak, running); read.push(id); await new Promise(res => setTimeout(res, 10)); running -= 1; return { asset: { id } }; } }),
  { concurrency: 2, onProgress: p => steps.push(p.step) });
  assert.deepEqual([...new Set(steps)], ['RESOLVE_SCOPE', 'FILTER_ASSETS_BY_STATUS', 'RETRIEVE_OPERATIONAL_STATUS', 'RETRIEVE_LINKED_DOCUMENTS', 'ANALYSE_INSPECTIONS', 'BUILD_MAINTENANCE_ASSESSMENT']);
  assert.deepEqual(read.sort(), ['TX-3', 'TX-M2'], 'STS-02 has no linked documents: not read, not invented');
  assert.ok(peak <= 2);
  assert.equal(r.assets.find(a => a.id === 'STS-02').documents.linked, 0);
  assert.equal(r.partial, false);
});

test('a failed document read is a partial result; the investigation goes on', async () => {
  const r = await runInvestigation(plan('Show what needs to be fixed for all degraded assets across Seagirt'), tools({ analyze: async id => { if (id === 'TX-3') throw Object.assign(new Error('ACC refused'), { code: 'FORBIDDEN' }); return { asset: { id } }; } }));
  assert.equal(r.partial, true);
  assert.deepEqual(r.failures, [{ id: 'TX-3', error: 'ACC refused', code: 'FORBIDDEN' }]);
  assert.ok(r.assets.find(a => a.id === 'TX-M2').analysis);
});

test('the documentation index not loaded: every target is read; a stale investigation stops', async () => {
  const read = [];
  await runInvestigation(plan('For degraded asset, what needs to be fixed?'), tools({ documentsOf: () => null, analyze: async id => { read.push(id); return {}; } }));
  assert.deepEqual(read.sort(), ['STS-02', 'TX-M2']);
  let current = true;
  const r = await runInvestigation(plan('For degraded asset, what needs to be fixed?'), tools({ analyze: async () => { current = false; return {}; } }), { isCurrent: () => current });
  assert.equal(r.cancelled, true);
});

test('mapLimit keeps order and failures', async () => {
  const r = await mapLimit([3, 1, 2], 2, async n => { if (n === 1) throw new Error('x'); return n * 2; });
  assert.deepEqual(r.map(x => (x.ok ? x.value : 'err')), [6, 'err', 4]);
});
