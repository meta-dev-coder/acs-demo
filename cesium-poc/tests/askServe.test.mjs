import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAskServer, statusOf } from '../tools/ask-serve.mjs';

const store = { classes: () => [
  { className: 'SDNA Florida I595 Live Events', source: 'dataconnect:live', rowCount: 3, asOf: '2026-10-11T12:00:00Z' },
  { className: 'Florida I595 Incidents', source: 'dataconnect:historical', rowCount: 178, asOf: '2026-10-11T06:00:00Z' },
  { className: 'Florida I595 Tickets', source: 'snapshot:tickets.json', rowCount: 9, asOf: '2026-10-01T00:00:00Z' },
] };

test('status names the model, each class with its origin, and the last refresh', () => {
  const status = statusOf({ label: 'claude-sonnet-5', store, refresher: { status: { lastRefresh: 'x', lastError: null, refreshes: 2 } }, now: () => 0 });
  assert.equal(status.ok, true);
  assert.deepEqual([status.store.live, status.store.historical, status.store.snapshot], [1, 1, 1]);
  assert.equal(status.refresh.refreshes, 2);
  assert.deepEqual(statusOf({ label: 'off' }).store.classes, []);
  assert.equal(statusOf({ label: 'off' }).ok, false);
});

test('the service routes /healthz, status and the ask route, and 404s the rest', async () => {
  const asked = [];
  const server = createAskServer({ ask: { label: 'm', store, handle: (req, res) => { asked.push(req.method); res.end('{"answer":"ok"}'); } } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await (await fetch(`${base}/healthz`)).text(), 'ok');
    assert.equal((await (await fetch(`${base}/api/i595/ask/status`)).json()).store.classes.length, 3);
    assert.equal((await (await fetch(`${base}/api/i595/ask`, { method: 'POST', body: '{}' })).json()).answer, 'ok');
    assert.deepEqual(asked, ['POST']);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally { server.close(); }
});

test('the demo-host proxy streams the service reply, names the caller and reports a stopped service', async () => {
  const { createAskProxy } = await import('../server/ask/askProxy.mjs');
  const { createServer } = await import('node:http');
  const seen = [];
  const upstream = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ client: req.headers['x-ask-client'], body, accept: req.headers.accept, cookie: req.headers.cookie });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write('event: RunStarted\ndata: {}\n\n');
      setTimeout(() => res.end('event: RunFinished\ndata: {}\n\n'), 20);
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const proxy = createAskProxy({ target: `http://127.0.0.1:${upstream.address().port}`, clientKey: () => 'session-1', logger: { warn() {} } });
  const front = createServer((req, res) => proxy.handle(req, res));
  await new Promise(r => front.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${front.address().port}/api/i595/ask`;
  try {
    const res = await fetch(url, { method: 'POST', headers: { accept: 'text/event-stream', 'content-type': 'application/json', cookie: 'live_dc_session=secret' }, body: '{"question":"q"}' });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    assert.match(await res.text(), /RunStarted[\s\S]*RunFinished/);
    assert.deepEqual(seen[0], { client: 'session-1', body: '{"question":"q"}', accept: 'text/event-stream', cookie: undefined });
    await new Promise(r => upstream.close(r));
    const down = await fetch(url, { method: 'POST', body: '{}' });
    assert.equal(down.status, 502);
    assert.match((await down.json()).error, /not running/);
  } finally { front.close(); upstream.close(); }
  assert.throws(() => createAskProxy({ target: 'https://example.com' }), /http:\/\//);
});

test('the demo server forwards to the ask service when ASK_TWIN_SERVICE_URL is set', async () => {
  const { createDemoAsk } = await import('../server/liveDc/demoServer.mjs');
  const logs = [];
  const ask = createDemoAsk({ env: { ASK_TWIN_SERVICE_URL: 'http://127.0.0.1:8787' }, logger: { log: m => logs.push(m) } });
  assert.equal(ask.target, 'http://127.0.0.1:8787');
  assert.ok(logs.some(m => /forwarded to http:\/\/127\.0\.0\.1:8787/.test(m)));
});
