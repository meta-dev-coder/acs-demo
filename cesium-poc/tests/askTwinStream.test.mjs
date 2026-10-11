import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AskError, askRemote, createSseParser, traceLine } from '../src/askTwinStream.js';

const sse = events => events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

/** A fetch double that returns `body` split into `pieces` chunks with the given content type. */
function fakeFetch({ body, type, status = 200, pieces = 3 }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const bytes = new TextEncoder().encode(body);
    const size = Math.ceil(bytes.length / pieces);
    const stream = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size)); controller.close(); } });
    return new Response(stream, { status, headers: { 'content-type': type } });
  };
  return { fetchImpl, calls };
}

test('the SSE parser handles frames split across chunks and skips heartbeats and junk', () => {
  const events = [];
  const feed = createSseParser(e => events.push(e));
  feed('event: A\ndata: {"type":"A"');
  feed('}\n\n: heartbeat\n\nevent: B\ndata: not json\n\n');
  feed('event: C\ndata: {"type":"C"}\n\n');
  assert.deepEqual(events, [{ type: 'A' }, { type: 'C' }]);
});

test('a streaming service: progress events are passed on and the answer is returned', async () => {
  const answer = { answer: 'two', confidence: 'high', sources: ['FL511 live events'] };
  const { fetchImpl, calls } = fakeFetch({ type: 'text/event-stream', body: sse([
    { type: 'RunStarted' }, { type: 'ToolCallStart', name: 'list_live_events' }, { type: 'ToolCallEnd', name: 'list_live_events', status: 'ok', ms: 3 },
    { type: 'AnswerReady', answer }, { type: 'RunFinished' },
  ]), pieces: 7 });
  const seen = [];
  const result = await askRemote('/api/i595/ask', { question: 'q' }, { fetchImpl, onEvent: e => seen.push(e.type) });
  assert.deepEqual(result, answer);
  assert.deepEqual(seen, ['RunStarted', 'ToolCallStart', 'ToolCallEnd', 'AnswerReady', 'RunFinished']);
  assert.match(calls[0].init.headers.accept, /text\/event-stream/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { question: 'q' });
});

test('a streamed RunError, or a stream that ends without an answer, throws with the reason', async () => {
  const failing = fakeFetch({ type: 'text/event-stream', body: sse([{ type: 'RunStarted' }, { type: 'RunError', message: 'The model is overloaded.' }]) });
  await assert.rejects(askRemote('/x', {}, { fetchImpl: failing.fetchImpl }), e => e instanceof AskError && e.message === 'The model is overloaded.');
  const cut = fakeFetch({ type: 'text/event-stream', body: sse([{ type: 'RunStarted' }]) });
  await assert.rejects(askRemote('/x', {}, { fetchImpl: cut.fetchImpl }), /stopped before it finished/);
});

test('a JSON service (the older Lambda) still works, including its error bodies', async () => {
  const ok = fakeFetch({ type: 'application/json', body: JSON.stringify({ answer: 'hi', sources: ['live_events'] }) });
  assert.equal((await askRemote('/x', {}, { fetchImpl: ok.fetchImpl })).answer, 'hi');
  const bad = fakeFetch({ type: 'application/json', status: 503, body: JSON.stringify({ error: 'not configured' }) });
  await assert.rejects(askRemote('/x', {}, { fetchImpl: bad.fetchImpl }), /not configured/);
});

test('trace lines say what ran, where from, how long, and what went wrong', () => {
  assert.equal(traceLine({ name: 'count_records', source: 'DataConnect · Florida I595 Incidents (snapshot)', ms: 4, status: 'ok' }),
    'Counting records · DataConnect · Florida I595 Incidents (snapshot) (4 ms)');
  assert.equal(traceLine({ name: 'query_records', ms: 2, status: 'gap', detail: 'Unknown class.' }), 'Reading records (2 ms) — gap: Unknown class.');
});
