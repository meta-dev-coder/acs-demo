import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAskHttpHandler, sseFrame } from '../server/ask/httpAdapter.mjs';
import { createLocalAsk, providerFromEnv } from '../server/ask/localAsk.mjs';
import { requestKey } from '../server/ask/modelProvider.mjs';
import { createAskLimiter } from '../server/liveDc/askTwin.mjs';

const quiet = { log() {}, warn() {}, error() {} };
const ANSWER = { answer: 'ok', action: { type: 'none', entity_id: null, coordinates: null }, confidence: 'high', sources: ['x'], follow_ups: [] };

/** An orchestrator double that emits a fixed event script, optionally waiting for abort. */
function fakeOrchestrator({ fail = false, waitMs = 0, onSignal } = {}) {
  const seen = [];
  return {
    seen,
    async run(envelope, emit, { signal }) {
      seen.push(envelope);
      onSignal?.(signal);
      emit({ type: 'RunStarted', runId: 'r1' });
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
      if (fail) { emit({ type: 'RunError', runId: 'r1', message: 'boom', retryable: false }); return null; }
      emit({ type: 'AnswerReady', answer: ANSWER });
      emit({ type: 'RunFinished', runId: 'r1' });
      return ANSWER;
    },
  };
}

async function serve(handler, fn) {
  const server = createServer((req, res) => { handler.handle(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
}

const post = (base, body, headers = {}) => fetch(`${base}/api/i595/ask`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('ask HTTP adapter', () => {
  test('JSON clients get the answer in the reply contract; a failed run is a 502 with the reason', async () => {
    await serve(createAskHttpHandler({ orchestrator: fakeOrchestrator() }), async base => {
      const res = await post(base, { question: 'hi' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), ANSWER);
    });
    await serve(createAskHttpHandler({ orchestrator: fakeOrchestrator({ fail: true }) }), async base => {
      const res = await post(base, { question: 'hi' });
      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), { error: 'boom' });
    });
  });

  test('event-stream clients get one SSE frame per event, then the stream ends', async () => {
    await serve(createAskHttpHandler({ orchestrator: fakeOrchestrator() }), async base => {
      const res = await post(base, { question: 'hi' }, { accept: 'text/event-stream' });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      assert.match(res.headers.get('cache-control'), /no-transform/);
      const body = await res.text();
      assert.equal(body, [{ type: 'RunStarted', runId: 'r1' }, { type: 'AnswerReady', answer: ANSWER }, { type: 'RunFinished', runId: 'r1' }].map(sseFrame).join(''));
    });
  });

  test('a long run sends heartbeats so a proxy never sees a silent gap', async () => {
    await serve(createAskHttpHandler({ orchestrator: fakeOrchestrator({ waitMs: 120 }), heartbeatMs: 30 }), async base => {
      const body = await (await post(base, { question: 'hi' }, { accept: 'text/event-stream' })).text();
      assert.ok((body.match(/: heartbeat/g) ?? []).length >= 2);
    });
  });

  test('bad requests are refused before the orchestrator runs; the limiter answers 429', async () => {
    const orchestrator = fakeOrchestrator();
    const limiter = createAskLimiter({ limit: 1 });
    await serve(createAskHttpHandler({ orchestrator, limiter }), async base => {
      assert.equal((await fetch(`${base}/api/i595/ask`)).status, 405);
      assert.equal((await post(base, '{nope')).status, 400);
      assert.equal((await post(base, {})).status, 400);
      assert.equal((await post(base, { question: 'x'.repeat(40_000) })).status, 413);
      assert.equal(orchestrator.seen.length, 0);
      assert.equal((await post(base, { question: 'one' })).status, 200);
      assert.equal((await post(base, { question: 'two' })).status, 429);
    });
  });

  test('the orchestrator receives the sanitized envelope', async () => {
    const orchestrator = fakeOrchestrator();
    await serve(createAskHttpHandler({ orchestrator }), async base => {
      await post(base, { question: ' hi ', screen: { workspace: 'tmc', role: 'admin' }, history: [{ role: 'tool', text: 'x' }] });
      assert.deepEqual(orchestrator.seen[0], { question: 'hi', history: [], screen: { workspace: 'tmc' } });
    });
  });

  test('a client that disconnects aborts the run', async () => {
    let signal;
    await serve(createAskHttpHandler({ orchestrator: fakeOrchestrator({ waitMs: 300, onSignal: s => { signal = s; } }) }), async base => {
      const res = await post(base, { question: 'hi' }, { accept: 'text/event-stream' });
      // Read the first frame, then hang up.
      const reader = res.body.getReader();
      await reader.read();
      await reader.cancel();
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(signal.aborted, true);
    });
  });

  test('the middleware answers only the ask path', async () => {
    const { middleware } = createAskHttpHandler({ orchestrator: fakeOrchestrator() });
    let passed = false;
    middleware({ url: '/api/other' }, {}, () => { passed = true; });
    assert.equal(passed, true);
  });
});

describe('local ask configuration', () => {
  test('replay wins over a key; a key alone uses the EC2 default model; nothing set is off with a reason', () => {
    assert.match(providerFromEnv({ ASK_TWIN_REPLAY: '/r.json', ANTHROPIC_API_KEY: 'k' }).label, /^replay/);
    assert.equal(providerFromEnv({ ANTHROPIC_API_KEY: 'k' }).label, 'claude-sonnet-5, effort low');
    assert.equal(providerFromEnv({ ANTHROPIC_API_KEY: 'k', ASK_TWIN_MODEL: 'claude-x', ASK_TWIN_EFFORT: '' }).label, 'claude-x');
    assert.match(providerFromEnv({ ANTHROPIC_API_KEY: 'k', ASK_TWIN_RECORD: '/rec.json' }).label, /recording to \/rec\.json/);
    const off = providerFromEnv({});
    assert.equal(off.provider, null);
    assert.match(off.label, /ANTHROPIC_API_KEY/);
  });

  test('a secret name reads the key from Secrets Manager on the first question, not at startup', async () => {
    const reads = [];
    const readSecret = async (name, options) => { reads.push([name, options.region]); throw new Error('access denied reading secret'); };
    const { provider, label } = providerFromEnv({ ASK_TWIN_ANTHROPIC_SECRET_NAME: 'i595/anthropic-key', ASK_TWIN_MODEL: 'claude-sonnet-5', LIVE_DC_AWS_REGION: 'us-east-1' }, { readSecret });
    assert.equal(label, 'claude-sonnet-5, effort low (key from secret i595/anthropic-key)');
    assert.deepEqual(reads, []);
    const error = await provider.complete({ messages: [], maxTokens: 10 }).catch(e => e);
    assert.match(error.message, /key could not be read: access denied/);
    assert.deepEqual(reads, [['i595/anthropic-key', 'us-east-1']]);
    // A failed read is retried on the next question rather than cached.
    await provider.complete({ messages: [], maxTokens: 10 }).catch(() => {});
    assert.equal(reads.length, 2);
    // A key in the environment wins over the secret.
    assert.equal(providerFromEnv({ ANTHROPIC_API_KEY: 'k', ASK_TWIN_ANTHROPIC_SECRET_NAME: 's' }, { readSecret }).label, 'claude-sonnet-5, effort low');
  });

  test('with no model configured the route answers 503 saying what to set', async () => {
    const ask = createLocalAsk({ env: {}, logger: quiet });
    await serve(ask, async base => {
      const res = await post(base, { question: 'hi' });
      assert.equal(res.status, 503);
      assert.match((await res.json()).error, /ANTHROPIC_API_KEY/);
    });
  });

  test('end to end on replay: builds the store from the snapshot and streams a grounded answer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ask-local-'));
    try {
      const recordings = join(dir, 'rec.json');
      const storePath = join(dir, 'twin.sqlite');
      const { TOOL_DEFINITIONS } = await import('../server/ask/tools.mjs');
      const question = { role: 'user', content: 'How many incidents are in the snapshot?' };
      const call = { content: [{ type: 'tool_use', id: 'tu1', name: 'count_records', input: { class_name: 'Florida I595 Incidents' } }], stop_reason: 'tool_use', usage: {} };
      const first = { messages: [question], tools: TOOL_DEFINITIONS };
      writeFileSync(recordings, JSON.stringify({ version: 1, entries: { [requestKey(first)]: call } }));
      const env = { ASK_TWIN_REPLAY: recordings, ASK_TWIN_STORE: storePath };
      // The first local ask builds the store from the snapshot; the second request carries the real
      // tool result read from it, so that is what the second recording is keyed on.
      createLocalAsk({ env, logger: quiet });
      const { openTwinStore } = await import('../server/ask/twinStore.mjs');
      const store = openTwinStore(storePath);
      const count = store.count('Florida I595 Incidents');
      store.close();
      const { fitResult } = await import('../server/liveDc/askTools.mjs');
      const secondKey = requestKey({ messages: [question, { role: 'assistant', content: call.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: `ref R1\n${fitResult(count)}` }] }], tools: TOOL_DEFINITIONS });
      writeFileSync(recordings, JSON.stringify({ version: 1, entries: {
        [requestKey(first)]: call,
        [secondKey]: { content: [{ type: 'text', text: JSON.stringify({ answer: `${count.totalCount} incidents.`, basis: [{ claim: `${count.totalCount} incidents`, refs: ['R1'] }], action: { type: 'none' } }) }], stop_reason: 'end_turn', usage: {} },
      } }));
      const ask = createLocalAsk({ env, logger: quiet });
      await serve(ask, async base => {
        const body = await (await post(base, { question: question.content }, { accept: 'text/event-stream' })).text();
        const events = body.split('\n\n').filter(f => f.startsWith('event:')).map(f => JSON.parse(f.split('\ndata: ')[1]));
        const answer = events.find(e => e.type === 'AnswerReady').answer;
        assert.equal(answer.answer, '178 incidents.');
        assert.equal(answer.confidence, 'high');
        assert.deepEqual(answer.sources, ['DataConnect · Florida I595 Incidents (snapshot)']);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
