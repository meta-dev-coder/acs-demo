/**
 * EC2 Ask the Twin: prompt from DataConnect live events, reply parsing, rate limit, the HTTP handler and
 * its wiring behind the demo host's password gate. Offline: fake Anthropic fetch and fake aws CLI.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import {
  apiKeyFromSecret, createAskHandler, createAskLimiter, liveEventsPrompt, parseModelReply, systemPrompt,
} from '../server/liveDc/askTwin.mjs';
import { createDemoAsk } from '../server/liveDc/demoServer.mjs';
import { hashPassword } from '../server/liveDc/demoAuth.mjs';
import { createDemoHost } from '../server/liveDc/demoHost.mjs';

const KEY = 'sk-ant-test-only-not-a-real-key';
const quiet = { log() {}, info() {}, warn() {}, error() {} };

const EVENTS = {
  events: [
    { id: 'FL511-CLOSURE-876564', type: 'CLOSURE', nearestFacilityLabel: 'I-95 Express NB ramp', longitude: -80.168159, latitude: 26.085694,
      description: 'Planned construction on 95 Express North.\nOn-ramp closed.', startTime: 'Sep 27 2026, 9:11 PM' },
    { id: 'FL511-INCIDENT-1', type: 'INCIDENT', nearestSegmentLabel: 'I-595 EB at University Dr', description: 'Crash, right lane blocked' },
  ],
};

function fakeAnthropic(replies) {
  const calls = [];
  const queue = [...replies];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = queue.shift() ?? { status: 200, text: '{"answer":"ok","action":{"type":"none","entity_id":null,"coordinates":null},"confidence":"high","sources":["static_knowledge"]}' };
    if (next.throw) throw next.throw;
    return {
      ok: next.status >= 200 && next.status < 300, status: next.status,
      json: async () => ({ content: [{ type: 'text', text: next.text }] }),
      text: async () => next.text ?? '',
    };
  };
  return { fetchImpl, calls };
}

async function serve(handler) {
  const server = createServer((req, res) => { handler.handle(req, res).catch(error => { res.writeHead(500); res.end(String(error)); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ask = (body, init = {}) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body), ...init });
  return { ask, base, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }) };
}

describe('askTwin: prompt', () => {
  test('lists DataConnect live events with id, type, place, coordinates and one-line description', () => {
    const text = liveEventsPrompt(EVENTS);
    assert.match(text, /- id=FL511-CLOSURE-876564 \[CLOSURE\] near I-95 Express NB ramp at lon=-80\.168159 lat=26\.085694: Planned construction on 95 Express North\. On-ramp closed\. \(since Sep 27 2026, 9:11 PM\)/);
    assert.match(text, /- id=FL511-INCIDENT-1 \[INCIDENT\] near I-595 EB at University Dr: Crash, right lane blocked \(since unknown\)/);
  });

  test('says when there are no events, and when DataConnect could not be read', () => {
    assert.match(liveEventsPrompt({ events: [] }), /No active events on I-595/);
    assert.match(liveEventsPrompt(null), /unavailable right now/);
  });

  test('caps the list at 10 events and says how many were left out', () => {
    const many = { events: Array.from({ length: 13 }, (_, i) => ({ id: `E${i}`, type: 'CONGESTION' })) };
    const text = liveEventsPrompt(many);
    assert.equal(text.match(/^- id=/gm).length, 10);
    assert.match(text, /\(3 more not listed\)/);
  });

  test('the system prompt keeps the Lambda reply contract', () => {
    const text = systemPrompt(EVENTS);
    for (const part of ['I-595 Digital Twin', 'CURRENT LIVE EVENTS', 'raw JSON only', '"type": "fly_to | open_camera | show_event | none"']) assert.ok(text.includes(part), part);
  });
});

describe('askTwin: reply parsing', () => {
  const reply = { answer: 'Two closures.', action: { type: 'show_event', entity_id: 'X', coordinates: { lon: -80.2, lat: 26.1 } }, confidence: 'high', sources: ['live_events'] };
  test('plain JSON, fenced JSON and JSON inside prose all parse', () => {
    assert.deepEqual(parseModelReply(JSON.stringify(reply)), reply);
    assert.deepEqual(parseModelReply('```json\n' + JSON.stringify(reply) + '\n```'), reply);
    assert.deepEqual(parseModelReply('Here you go: ' + JSON.stringify(reply) + ' thanks'), reply);
  });
  test('prose or a reply without an answer string becomes a low-confidence answer with no action', () => {
    assert.deepEqual(parseModelReply('I-595 is 11 miles long.'), {
      answer: 'I-595 is 11 miles long.', action: { type: 'none', entity_id: null, coordinates: null }, confidence: 'low', sources: ['static_knowledge'],
    });
    assert.equal(parseModelReply('{"foo":1}').confidence, 'low');
    assert.equal(parseModelReply(undefined).action.type, 'none');
  });
});

test('askTwin: limiter allows `limit` per window per client, then frees up', () => {
  let now = 0;
  const limiter = createAskLimiter({ limit: 2, windowMs: 1000, now: () => now });
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), false);
  assert.equal(limiter.take('b'), true);
  now = 1001;
  assert.equal(limiter.take('a'), true);
});

test('askTwin: apiKeyFromSecret reads {"api_key"} and never echoes a bad secret', () => {
  assert.equal(apiKeyFromSecret(`{"api_key":" ${KEY} "}\n`, 'i595/anthropic-key'), KEY);
  for (const bad of ['', 'not json', '{"key":"x"}', '{"api_key":""}']) {
    assert.throws(() => apiKeyFromSecret(bad, 'i595/anthropic-key'), error => /must be JSON \{"api_key"\}/.test(error.message) && !error.message.includes('not json'));
  }
});

describe('askTwin: HTTP handler', () => {
  test('answers with the model reply; sends key, model and the live events; reads the key once', async () => {
    const { fetchImpl, calls } = fakeAnthropic([
      { status: 200, text: '{"answer":"There is one closure.","action":{"type":"show_event","entity_id":"FL511-CLOSURE-876564","coordinates":{"lon":-80.168159,"lat":26.085694}},"confidence":"high","sources":["live_events"]}' },
    ]);
    let keyReads = 0;
    const handler = createAskHandler({ getApiKey: async () => { keyReads++; return KEY; }, getLiveEvents: async () => EVENTS, fetchImpl, model: 'test-model', logger: quiet });
    const srv = await serve(handler);
    try {
      const first = await srv.ask({ question: '  what is closed?  ' });
      assert.equal(first.status, 200);
      assert.equal(first.headers.get('cache-control'), 'no-store');
      const body = await first.json();
      assert.equal(body.action.entity_id, 'FL511-CLOSURE-876564');
      assert.deepEqual(body.sources, ['live_events']);
      assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
      assert.equal(calls[0].init.headers['x-api-key'], KEY);
      assert.equal(calls[0].body.model, 'test-model');
      assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: 'what is closed?' }]);
      assert.match(calls[0].body.system, /FL511-CLOSURE-876564/);
      assert.ok(!JSON.stringify(body).includes(KEY));
      await (await srv.ask({ question: 'again' })).json();
      assert.equal(keyReads, 1);
    } finally { await srv.close(); }
  });

  test('bad requests: method, JSON, missing, too long, too large', async () => {
    const { fetchImpl, calls } = fakeAnthropic([]);
    const srv = await serve(createAskHandler({ getApiKey: async () => KEY, getLiveEvents: async () => EVENTS, fetchImpl, logger: quiet }));
    try {
      assert.equal((await fetch(srv.base)).status, 405);
      assert.equal((await srv.ask('{nope')).status, 400);
      assert.equal((await srv.ask({ question: '   ' })).status, 400);
      assert.equal((await srv.ask({ question: 'x'.repeat(513) })).status, 400);
      assert.equal((await srv.ask({ question: 'x', pad: 'y'.repeat(20_000) })).status, 413);
      assert.equal(calls.length, 0);
    } finally { await srv.close(); }
  });

  test('rate limit answers 429 without calling the model', async () => {
    const { fetchImpl, calls } = fakeAnthropic([]);
    const srv = await serve(createAskHandler({
      getApiKey: async () => KEY, getLiveEvents: async () => EVENTS, fetchImpl, logger: quiet, limiter: createAskLimiter({ limit: 1 }),
    }));
    try {
      assert.equal((await srv.ask({ question: 'one' })).status, 200);
      const second = await srv.ask({ question: 'two' });
      assert.equal(second.status, 429);
      assert.match((await second.json()).error, /Too many questions/);
      assert.equal(calls.length, 1);
    } finally { await srv.close(); }
  });

  test('no key -> 503 without detail; the next question retries the key', async () => {
    const { fetchImpl } = fakeAnthropic([]);
    let fail = true;
    const lines = [];
    const srv = await serve(createAskHandler({
      getApiKey: async () => { if (fail) throw new Error('access denied reading secret i595/anthropic-key'); return KEY; },
      getLiveEvents: async () => EVENTS, fetchImpl, logger: { ...quiet, error: line => lines.push(line) },
    }));
    try {
      const first = await srv.ask({ question: 'hi' });
      assert.equal(first.status, 503);
      assert.doesNotMatch((await first.json()).error, /denied|secret/);
      assert.match(lines.join('\n'), /access denied/);
      fail = false;
      assert.equal((await srv.ask({ question: 'hi' })).status, 200);
    } finally { await srv.close(); }
  });

  test('live events failing still answers, with the "unavailable" note in the prompt', async () => {
    const { fetchImpl, calls } = fakeAnthropic([]);
    const srv = await serve(createAskHandler({ getApiKey: async () => KEY, getLiveEvents: async () => { throw new Error('dc down'); }, fetchImpl, logger: quiet }));
    try {
      assert.equal((await srv.ask({ question: 'hi' })).status, 200);
      assert.match(calls[0].body.system, /unavailable right now/);
    } finally { await srv.close(); }
  });

  test('Anthropic errors -> 502 with a generic message; a 401 drops the cached key', async () => {
    const { fetchImpl } = fakeAnthropic([{ status: 401, text: 'invalid x-api-key' }, { status: 529, text: 'overloaded' }, { throw: Object.assign(new Error('t'), { name: 'TimeoutError' }) }]);
    let keyReads = 0;
    const srv = await serve(createAskHandler({ getApiKey: async () => { keyReads++; return KEY; }, getLiveEvents: async () => EVENTS, fetchImpl, logger: quiet }));
    try {
      for (let i = 0; i < 3; i++) {
        const response = await srv.ask({ question: 'hi' });
        assert.equal(response.status, 502);
        assert.doesNotMatch((await response.json()).error, /x-api-key|overloaded/);
      }
      assert.equal(keyReads, 2);
    } finally { await srv.close(); }
  });
});

function fakeSpawn(stdout) {
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => { child.stdout.emit('data', Buffer.from(stdout)); child.emit('close', 0); });
    return child;
  };
  return { spawnImpl, calls };
}

describe('askTwin: EC2 wiring', () => {
  test('createDemoAsk is off unless ASK_TWIN_ANTHROPIC_SECRET_NAME is set', () => {
    assert.equal(createDemoAsk({ env: {}, logger: quiet }), null);
    assert.equal(createDemoAsk({ env: { ASK_TWIN_ANTHROPIC_SECRET_NAME: '  ' }, logger: quiet }), null);
  });

  test('createDemoAsk reads the key through the aws CLI on the first question and uses the DataConnect events', async () => {
    const { spawnImpl, calls } = fakeSpawn(`{"api_key":"${KEY}"}\n`);
    const { fetchImpl, calls: sent } = fakeAnthropic([]);
    const handler = createDemoAsk({
      env: { ASK_TWIN_ANTHROPIC_SECRET_NAME: 'i595/anthropic-key', LIVE_DC_AWS_REGION: 'us-east-1', ASK_TWIN_MODEL: 'm-1' },
      liveEvents: { dataConnectEvents: async () => EVENTS }, logger: quiet, spawnImpl, fetchImpl,
    });
    assert.equal(calls.length, 0, 'nothing read at startup');
    const srv = await serve(handler);
    try {
      assert.equal((await srv.ask({ question: 'hi' })).status, 200);
      assert.deepEqual(calls[0].args.slice(0, 4), ['secretsmanager', 'get-secret-value', '--secret-id', 'i595/anthropic-key']);
      assert.ok(calls[0].args.includes('us-east-1'));
      assert.equal(sent[0].init.headers['x-api-key'], KEY);
      assert.equal(sent[0].body.model, 'm-1');
      assert.match(sent[0].body.system, /FL511-INCIDENT-1/);
    } finally { await srv.close(); }
  });

  test('the demo host routes /api/i595/ask to the handler only with a session', async () => {
    const PASSWORD = 'Demo-Pass-Only-In-Tests-9912';
    const seen = [];
    const ask = { handle: async (req, res) => { seen.push(req.method); req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"answer":"hi"}'); } };
    const host = createDemoHost({ passwordHash: hashPassword(PASSWORD, { N: 1024 }), webDir: null, ask, logger: quiet });
    await new Promise(resolve => host.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${host.server.address().port}`;
    try {
      const post = headers => fetch(`${base}/api/i595/ask`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"question":"hi"}' });
      assert.equal((await post({})).status, 401);
      assert.deepEqual(seen, []);
      const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
      const answered = await post({ cookie });
      assert.equal(answered.status, 200);
      assert.deepEqual(await answered.json(), { answer: 'hi' });
      assert.deepEqual(seen, ['POST']);
    } finally {
      host.server.closeAllConnections?.();
      await new Promise(resolve => host.server.close(resolve));
    }
  });
});
