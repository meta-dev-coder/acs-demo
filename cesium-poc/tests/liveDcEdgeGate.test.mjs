import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '../server/liveDc/demoAuth.mjs';
import { createDemoHost } from '../server/liveDc/demoHost.mjs';
import { createEdgeGate, edgeKeysFromEnv, EDGE_HEADER } from '../server/liveDc/edgeGate.mjs';

const KEY = 'k'.repeat(32);
const quiet = { log() {}, warn() {}, error() {} };

test('edge gate: key match, viewer IP, per-IP, stream and global limits', () => {
  let t = 0;
  const gate = createEdgeGate({ keys: [KEY, 'short'], now: () => t, limits: { perMinute: 2, perHour: 3, openStreams: 1, globalPerHour: 4 } });
  assert.equal(gate.matches({ headers: { [EDGE_HEADER]: KEY } }), true);
  assert.equal(gate.matches({ headers: { [EDGE_HEADER]: 'short' } }), false, 'keys under 16 chars are ignored');
  assert.equal(gate.matches({ headers: {} }), false);
  assert.equal(gate.viewerIp({ headers: { 'cloudfront-viewer-address': '203.0.113.9:443' } }), '203.0.113.9');
  assert.equal(gate.viewerIp({ headers: { 'cloudfront-viewer-address': '[2001:db8::1]:5000' } }), '2001:db8::1');
  const a = gate.admit('A');
  assert.equal(a.ok, true);
  assert.equal(gate.admit('A').reason, 'streams', 'one open answer per IP');
  a.release();
  assert.equal(gate.admit('A').ok, true);
  assert.equal(gate.admit('A').reason, 'minute', 'two questions this minute already');
  t = 61_000;
  const minute = createEdgeGate({ keys: [KEY], now: () => t, limits: { perMinute: 1, perHour: 9, openStreams: 9, globalPerHour: 9 } });
  minute.admit('B');
  const blocked = minute.admit('B');
  assert.equal(blocked.reason, 'minute');
  assert.ok(blocked.retryAfter >= 1);
  assert.equal(createEdgeGate({ keys: [] }).enabled, false);
  assert.deepEqual(edgeKeysFromEnv({ ASK_TWIN_EDGE_KEYS: ' a , b ,' }), ['a', 'b']);
});

test('demo host: the edge key stands in for the session on POST /api/i595/ask only', async () => {
  const seen = [];
  const ask = { handle: (req, res) => { seen.push(req.askClient); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"answer":"ok"}'); } };
  const edgeGate = createEdgeGate({ keys: [KEY], limits: { perMinute: 1, perHour: 9, openStreams: 9, globalPerHour: 9 } });
  const host = createDemoHost({ passwordHash: hashPassword('pw', { N: 1024 }), webDir: null, ask, logger: quiet, edgeGate });
  await new Promise(r => host.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${host.server.address().port}`;
  const edge = { [EDGE_HEADER]: KEY, 'cloudfront-viewer-address': '198.51.100.7:1234', 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/api/i595/ask`, { method: 'POST', body: '{}' })).status, 401, 'no session, no key');
    assert.equal((await fetch(`${base}/api/i595/ask`, { method: 'POST', headers: { ...edge, [EDGE_HEADER]: 'wrong-key-wrong-key' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/api/i595/ask`, { method: 'OPTIONS', headers: edge })).status, 204);
    const ok = await fetch(`${base}/api/i595/ask`, { method: 'POST', headers: edge, body: '{}' });
    assert.equal(ok.status, 200);
    assert.deepEqual(seen, ['edge:198.51.100.7']);
    const limited = await fetch(`${base}/api/i595/ask`, { method: 'POST', headers: edge, body: '{}' });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal((await fetch(`${base}/api/i595/ask/status`, { headers: edge })).status, 404, 'status is not exposed at the edge');
    assert.equal((await fetch(`${base}/api/live-dc/status`, { headers: edge })).status, 401, 'the key opens nothing else');
  } finally { host.server.close(); }
});
