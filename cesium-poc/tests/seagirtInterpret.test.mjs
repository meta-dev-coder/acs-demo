/**
 * Seagirt Ask the Twin: questions the rules did not understand, read by Claude (server/ifcSpatial/interpret.mjs) and
 * checked again in the page (src/ifcSpatial/askInterpret.js). Offline: a fake provider, no network, no key.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { checkReply, cleanRequest, createInterpretApi, DEFAULT_INTERPRET_MODEL, interpretProviderFromEnv, QUESTION_FORMS, REPLY_SCHEMA, SYSTEM_PROMPT,
  userMessage } from '../server/ifcSpatial/interpret.mjs';
import { acceptedRewrite, interpretRequest, isWeakAreaInventory, understoodNote } from '../src/ifcSpatial/askInterpret.js';
import { createSpendGuard } from '../server/ask/spendGuard.mjs';

const quiet = { log() {}, info() {}, warn() {}, error() {} };
const ASSETS = [{ id: 'TX-M1', type: 'transformer', name: 'Main transformer' }, { id: 'TX-M2', type: 'transformer', name: '' }, { id: 'STS-05', type: 'crane', name: 'Ship-to-shore crane 5' }];

/** A provider that answers with `reply` (an object, serialised as the model's JSON text) and records each request. */
function fakeProvider(reply, { stop = 'end_turn', usage = { input_tokens: 900, cache_read_input_tokens: 2400, output_tokens: 120 }, fail = null } = {}) {
  const calls = [];
  return {
    calls, name: 'fake', model: 'claude-haiku-5-5',
    async complete(request) {
      calls.push(request);
      if (fail) throw fail;
      return { content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }], stop_reason: stop, usage };
    },
  };
}

/** Call the route in process: a readable request, a response that records status and JSON. */
async function call(api, { method = 'POST', path = '/api/ifc-spatial/interpret', body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(req, { method, url: path, headers: {}, socket: { remoteAddress: '127.0.0.1' } });
  const out = {};
  const res = { writeHead(status, headers) { out.status = status; out.headers = headers; }, end(text) { out.body = text ? JSON.parse(text) : null; } };
  out.handled = await api.handle(req, res);
  return out;
}

describe('server: the interpret route', () => {
  test('off by default: no provider without SEAGIRT_ASK_LLM=on, and the route answers 503', async () => {
    assert.equal(interpretProviderFromEnv({}).provider, null);
    assert.equal(interpretProviderFromEnv({ SEAGIRT_ASK_LLM: 'on' }).provider, null, 'on but no key: still off');
    assert.match(interpretProviderFromEnv({ SEAGIRT_ASK_LLM: 'on' }).reason, /no key/);
    const api = createInterpretApi({ env: {}, logger: quiet });
    assert.equal(api.enabled, false);
    const st = await call(api, { method: 'GET', path: '/api/ifc-spatial/interpret/status' });
    assert.deepEqual([st.status, st.body.enabled], [200, false]);
    const r = await call(api, { body: { question: 'anything' } });
    assert.equal(r.status, 503);
    assert.equal((await call(api, { method: 'GET', path: '/api/ifc-spatial/models' })).handled, false, 'other IFC Spatial routes pass through');
  });

  test('on: I-595\'s key (API key or the Secrets Manager name), Claude Haiku 5.5 at low effort by default', () => {
    const made = [];
    const make = o => { made.push(o); return { model: o.model }; };
    interpretProviderFromEnv({ SEAGIRT_ASK_LLM: 'on', ANTHROPIC_API_KEY: 'k' }, { make });
    interpretProviderFromEnv({ SEAGIRT_ASK_LLM: 'true', ASK_TWIN_ANTHROPIC_SECRET_NAME: 'i595/anthropic-key', SEAGIRT_ASK_MODEL: 'claude-sonnet-5', SEAGIRT_ASK_EFFORT: 'medium' }, { make });
    assert.equal(DEFAULT_INTERPRET_MODEL, 'claude-haiku-5-5');
    assert.deepEqual([made[0].model, made[0].effort, made[0].apiKey], ['claude-haiku-5-5', 'low', 'k']);
    assert.deepEqual([made[1].model, made[1].effort, typeof made[1].getApiKey, made[1].apiKey], ['claude-sonnet-5', 'medium', 'function', undefined]);
  });

  test('a rewrite: the cached system prompt, a structured reply, only the question and asset list sent', async () => {
    const provider = fakeProvider({ understood: true, rewritten: 'Which transformer supplies power to STS-05?', assetIds: ['STS-05'], reason: 'supply question' });
    const logs = [];
    const api = createInterpretApi({ env: {}, provider, logger: { ...quiet, log: l => logs.push(l) } });
    const r = await call(api, { body: { question: 'where does crane five get its juice', assets: ASSETS, context: { lastAssets: ['TX-M1'], area: { selected: false } },
      ifc: 'MUST NOT BE SENT', documents: ['MUST NOT BE SENT'] } });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.understood, r.body.rewritten, r.body.assetIds], [true, 'Which transformer supplies power to STS-05?', ['STS-05']]);
    const sent = provider.calls[0];
    assert.equal(sent.system, SYSTEM_PROMPT, 'the same system prompt every time (cached)');
    assert.deepEqual(sent.format, REPLY_SCHEMA);
    const text = sent.messages[0].content;
    assert.match(text, /Question: where does crane five get its juice/);
    assert.match(text, /STS-05 \| crane \| Ship-to-shore crane 5/);
    assert.doesNotMatch(text, /MUST NOT BE SENT/, 'unknown fields never reach the model');
    const line = JSON.parse(logs.find(l => l.includes('seagirt_interpret')));
    assert.equal(line.understood, true);
    assert.ok(!JSON.stringify(line).includes('juice'), 'the log carries no question text');
  });

  test('unsafe or useless replies are not used: unknown assets, the same question, a refusal, broken JSON, a model error', async () => {
    const ask = async (reply, opts) => (await call(createInterpretApi({ env: {}, provider: fakeProvider(reply, opts), logger: quiet }), { body: { question: 'q about crane five', assets: ASSETS } }));
    const invented = await ask({ understood: true, rewritten: 'What supplies STS-99?', assetIds: [], reason: '' });
    assert.deepEqual([invented.status, invented.body.understood], [200, false]);
    assert.match(invented.body.reason, /unknown asset STS-99/);
    assert.equal((await ask({ understood: true, rewritten: 'What supplies TX-M1?', assetIds: ['TX-M9'], reason: '' })).body.understood, false);
    assert.equal((await ask({ understood: true, rewritten: 'Q about crane five', assetIds: [], reason: '' })).body.understood, false);
    assert.equal((await ask({ understood: false, rewritten: '', assetIds: [], reason: 'outside the twin' })).body.understood, false);
    assert.equal((await ask({ understood: true, rewritten: 'What supplies TX-M1?', assetIds: [], reason: '' }, { stop: 'refusal' })).body.understood, false);
    assert.equal((await ask('{not json')).body.understood, false);
    const failed = await ask(null, { fail: new Error('overloaded') });
    assert.equal(failed.status, 502, 'the page falls back to the rules');
  });

  test('limits: body and question validated, a daily token budget, a per-client rate', async () => {
    const provider = fakeProvider({ understood: true, rewritten: 'What supplies TX-M1?', assetIds: ['TX-M1'], reason: '' });
    const api = createInterpretApi({ env: {}, provider, logger: quiet });
    assert.equal((await call(api, { body: { question: '   ' } })).status, 400);
    assert.equal((await call(api, { body: '{bad' })).status, 400);
    assert.equal((await call(api, { body: { question: 'x'.repeat(200_000) } })).status, 413);
    assert.equal((await call(api, { method: 'PUT', body: {} })).status, 405);
    const spend = createSpendGuard({ dailyTokens: 1000, logger: quiet });
    const capped = createInterpretApi({ env: {}, provider, spend, logger: quiet });
    assert.equal((await call(capped, { body: { question: 'one', assets: ASSETS } })).status, 200);
    const over = await call(capped, { body: { question: 'two', assets: ASSETS } });
    assert.deepEqual([over.status, over.body.error.code], [429, 'BUDGET'], 'usage of the first call (900 + 240 + 120) used the budget');
    let n = 0;
    const limited = createInterpretApi({ env: {}, provider, logger: quiet, limiter: { take: () => ++n <= 2 } });
    await call(limited, { body: { question: 'a', assets: ASSETS } });
    await call(limited, { body: { question: 'b', assets: ASSETS } });
    assert.deepEqual([(await call(limited, { body: { question: 'c', assets: ASSETS } })).status], [429]);
  });

  test('request cleaning and the prompt', () => {
    const c = cleanRequest({ question: `  ${'q'.repeat(900)} `, assets: [...ASSETS, { name: 'no id' }], context: { lastAssets: ['TX-M1', '', 'X'.repeat(200)], area: { selected: true, label: 'Zone B' } } });
    assert.equal(c.question.length, 512);
    assert.equal(c.assets.length, 3);
    assert.equal(c.context.lastAssets[1].length, 64);
    assert.deepEqual(c.context.area, { selected: true, label: 'Zone B' });
    assert.match(userMessage(c), /Area selected: yes \(Zone B\)/);
    // Every form in the prompt names its slots the same way, and the prompt forbids invented ids.
    assert.ok(QUESTION_FORMS.flatMap(([, f]) => f).length > 30);
    assert.match(SYSTEM_PROMPT, /Use only asset ids that appear in the asset list/);
    assert.equal(checkReply({ understood: true, rewritten: 'Does TX-M1 supply STS-05?', assetIds: [], reason: 'x' }, c).assetIds.join(), 'TX-M1,STS-05');
  });
});

describe('page: when a rewrite is used', () => {
  const knownIds = new Set(ASSETS.map(a => a.id));
  test('accepted only when understood, different from the question, and naming known assets', () => {
    assert.equal(acceptedRewrite({ understood: true, rewritten: 'What supplies TX-M1?', assetIds: ['TX-M1'] }, { question: 'juice for main tx', knownIds }), 'What supplies TX-M1?');
    assert.equal(acceptedRewrite({ understood: true, rewritten: 'What supplies TX-M7?', assetIds: [] }, { question: 'q', knownIds }), null);
    assert.equal(acceptedRewrite({ understood: true, rewritten: 'What supplies TX-M1?', assetIds: ['NOPE-1'] }, { question: 'q', knownIds }), null);
    assert.equal(acceptedRewrite({ understood: true, rewritten: 'what supplies tx-m1', assetIds: [] }, { question: 'What supplies TX-M1?', knownIds }), null);
    assert.equal(acceptedRewrite({ understood: false, rewritten: 'What supplies TX-M1?' }, { question: 'q', knownIds }), null);
    assert.equal(acceptedRewrite(null, { question: 'q', knownIds }), null);
    assert.equal(acceptedRewrite({ understood: true, rewritten: 'x'.repeat(400), assetIds: [] }, { question: 'q', knownIds }), null);
  });
  test('the request: question, asset ids, types and names, conversation ids, area label; nothing else', () => {
    const body = interpretRequest({ question: ' hi ', assets: [{ id: 'TX-M1', assetType: 'TRANSFORMER', name: 'Main transformer', location: { longitude: 1 }, route: [[1, 2]] }],
      previousQuestion: 'prev', lastAssets: ['TX-M1', null], selectedAssetId: 'TX-M1', area: { label: 'Zone B' }, typeLabel: () => 'transformer' });
    assert.deepEqual(body, { question: 'hi', assets: [{ id: 'TX-M1', type: 'transformer', name: 'Main transformer' }],
      context: { previousQuestion: 'prev', lastAssets: ['TX-M1'], selectedAssetId: 'TX-M1', area: { selected: true, label: 'Zone B' } } });
  });
  test('weak area questions: only ones the inventory took for "what" / "which"', () => {
    assert.equal(isWeakAreaInventory('What is going on here?'), true);
    assert.equal(isWeakAreaInventory('Which ones are struggling?'), true);
    for (const q of ['What assets are in this area?', 'How many cranes?', 'List everything here', 'Show the equipment']) assert.equal(isWeakAreaInventory(q), false, q);
    assert.equal(isWeakAreaInventory('What is here?', { hasCategory: true }), false);
    assert.equal(understoodNote('What supplies TX-M1?'), 'Understood as: “What supplies TX-M1?”');
  });
});
