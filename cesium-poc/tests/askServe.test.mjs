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
