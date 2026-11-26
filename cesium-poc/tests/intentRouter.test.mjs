import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyQuestion } from '../src/ifcSpatial/intentRouter.js';

const assetIds = new Set(['USS-1', 'USS-2', 'TX-M1', 'TX-M2', 'UTIL-A', 'HM-3']);
const route = (q, lastAssets = []) => classifyQuestion(q, { assetIds, lastAssets });

test('relationship questions are relationships, never "locate the first asset"; direction follows the phrasing', () => {
  for (const q of ['Is USS-1 supplying power to USS-2?', 'Does USS-1 supply USS-2?', 'Does power flow from USS-1 to USS-2?', 'Is USS-1 upstream of USS-2?']) {
    assert.deepEqual(route(q), { intent: 'SUPPLY_RELATIONSHIP', entities: { sourceAssetId: 'USS-1', targetAssetId: 'USS-2' } }, q);
  }
  for (const q of ['Is USS-2 powered by USS-1?', 'Is USS-2 fed from USS-1?', 'Is USS-2 downstream of USS-1?']) {
    assert.deepEqual(route(q).entities, { sourceAssetId: 'USS-1', targetAssetId: 'USS-2' }, q);
  }
  for (const q of ['Are USS-1 and USS-2 physically connected?', 'Are USS-1 and USS-2 electrically connected?', 'Show the connection between USS-1 and USS-2']) {
    assert.equal(route(q).intent, 'PHYSICAL_CONNECTIVITY', q);
  }
});

test('alternate supply: the failing asset, the asset asked about, a candidate source', () => {
  assert.deepEqual(route('Does TX-M1 have alternate supply if it shuts down?').entities, { failedAssetId: 'TX-M1', targetAssetId: null, candidateSourceId: null });
  assert.deepEqual(route('If USS-1 fails, can USS-2 still receive power?').entities, { failedAssetId: 'USS-1', targetAssetId: 'USS-2', candidateSourceId: null });
  assert.deepEqual(route('Can TX-M2 supply the loads if TX-M1 fails?').entities, { failedAssetId: 'TX-M1', targetAssetId: null, candidateSourceId: 'TX-M2' });
});

test('details, and the rest left to its existing route (locate, upstream, downstream, outage, inventory, path)', () => {
  assert.deepEqual(route('What is USS-1?'), { intent: 'ASSET_DETAILS', entities: { assetId: 'USS-1' } });
  assert.equal(route('Is USS-1 a substation or ring main unit?').intent, 'ASSET_DETAILS');
  for (const q of ['Show USS-1', 'What supplies USS-2?', 'What does USS-1 supply?', 'What happens if TX-M1 shuts down?', 'How many substations are there?', 'Show the power path from UTIL-A to HM-3']) {
    assert.equal(route(q), null, q);
  }
});

test('conversation: "it" is the one asset of the conversation; with two, Ask the Twin asks which', () => {
  assert.deepEqual(route('Does it supply USS-2?', ['USS-1']).entities, { sourceAssetId: 'USS-1', targetAssetId: 'USS-2' });
  const ambiguous = route('What happens if it fails?', ['USS-1', 'USS-2']);
  assert.equal(ambiguous.intent, 'CLARIFY');
  assert.deepEqual(ambiguous.clarify.options, ['USS-1', 'USS-2']);
  assert.equal(route('What happens if it fails?', ['USS-1']), null, 'one asset: the engine resolves "it" itself');
});
