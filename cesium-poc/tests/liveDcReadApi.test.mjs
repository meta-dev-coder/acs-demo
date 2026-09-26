/**
 * The read-only Live DataConnect proxy (/api/live-dc) over real loopback HTTP, against its own
 * in-process stand-in on a free port. Live records are seeded through the guarded writer.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { LIVE_CLASS, LIVE_CLASS_NAMES, REF } from '../server/liveDc/classes.mjs';
import { createDcWriter, loadDcWriterConfig } from '../server/liveDc/dcWriter.mjs';
import { createDcStandin } from '../server/liveDc/standin.mjs';
import { createLiveDcReadApi, LIVE_DC_KEYS, loadLiveDcReadConfig } from '../server/liveDc/liveReadApi.mjs';

const silent = { info() {}, log() {}, warn() {}, error() {} };
const TEST_TOKEN = 'test-token';
const { EVENTS, TICKETS } = LIVE_CLASS;

const EVENT = {
  keyInSource: 'FL511-868702', code: 'FL511-868702', name: 'Crash', description: 'Crash on I-595 West at Davie Rd.',
  event_type: 'INCIDENT', fl511_item_id: '868702', source: 'FL511', status: 'active',
  latitude: 26.093417, longitude: -80.226583, first_seen_at: '2026-09-25T12:00:00.000Z',
  x_coordinates: -80.226583, y_coordinates: 26.093417, project: '2222FL',
};
const TICKET = {
  keyInSource: 'TIC-FL511-868702', code: 'TIC-FL511-868702', name: 'Crash', description: 'Crash on I-595 West',
  'Ticket ID': 'TIC-FL511-868702', 'Issue Summary': 'Crash - Crash', 'Ticket Status': 'Open', Priority: 'Medium',
  'X Coordinate': -80.226583, 'Y Coordinate': 26.093417, source_event_id: 'FL511-868702',
};

async function mount(api) {
  const server = createServer((req, res) => api.middleware(req, res, () => { res.writeHead(418); res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }) };
}

const json = async response => ({ status: response.status, body: await response.json().catch(() => null) });

describe('live-dc read proxy against a seeded stand-in', () => {
  let standin, upstream, proxy, fetchLog;
  before(async () => {
    standin = createDcStandin({ processingDelayMs: 1, curationDelayMs: 1, assetRows: [], logger: silent });
    upstream = await standin.listen(0);
    const writer = createDcWriter({
      config: { ...loadDcWriterConfig({ DC_WRITER_BASE_URL: upstream.url, DC_WRITER_LOAD_BASE_URL: upstream.url, DC_WRITER_ACCESS_TOKEN: TEST_TOKEN }), pollIntervalMs: 5, processTimeoutMs: 5000, curationTimeoutMs: 5000 },
      logger: silent,
    });
    const dtos = await writer.resolveLiveClasses();
    await writer.loadRecords(dtos.get(EVENTS), [EVENT]);
    await writer.loadRecords(dtos.get(TICKETS), [TICKET]);
    fetchLog = [];
    const api = createLiveDcReadApi({
      config: loadLiveDcReadConfig({ LIVE_DC_READ_BASE_URL: upstream.url, LIVE_DC_READ_ACCESS_TOKEN: TEST_TOKEN }), logger: silent,
      fetchImpl: (url, options) => { fetchLog.push({ url: String(url), options }); return fetch(url, options); },
    });
    proxy = await mount(api);
  });
  after(async () => { await proxy?.close(); await upstream?.close(); });

  test('lists exactly the six Live classes, with their keys, and nothing historical', async () => {
    const { status, body } = await json(await fetch(`${proxy.base}/api/live-dc/classes`));
    assert.equal(status, 200);
    assert.deepEqual(body.classes.map(c => c.className).sort(), [...LIVE_CLASS_NAMES].sort());
    assert.deepEqual(body.classes.map(c => c.key).sort(), [...LIVE_DC_KEYS].sort());
    for (const entry of body.classes) assert.ok(entry.id && typeof entry.id === 'string');
    assert.ok(!JSON.stringify(body).includes(REF.ASSETS));
  });

  test('returns curated Live records for a Live class', async () => {
    const { body: { classes } } = await json(await fetch(`${proxy.base}/api/live-dc/classes`));
    const events = classes.find(c => c.className === EVENTS);
    const { status, body } = await json(await fetch(`${proxy.base}/api/live-dc/class/${events.id}/curated-data`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page: 0, pageSize: 50 }),
    }));
    assert.equal(status, 200);
    assert.equal(body.totalCount, 1);
    assert.equal(body.data[0].keyInSource, 'FL511-868702');
    assert.equal(body.data[0].attributes.status, 'active');
    const tickets = classes.find(c => c.className === TICKETS);
    const second = await json(await fetch(`${proxy.base}/api/live-dc/class/${tickets.id}/curated-data`, { method: 'POST', body: '{}' }));
    assert.equal(second.body.data[0].attributes['Ticket ID'], 'TIC-FL511-868702');
  });

  test('forwards a sort (field + asc/desc only), so a reader can window by date', async () => {
    const { body: { classes } } = await json(await fetch(`${proxy.base}/api/live-dc/classes`));
    fetchLog.length = 0;
    const post = body => fetch(`${proxy.base}/api/live-dc/class/${classes[0].id}/curated-data`, { method: 'POST', body: JSON.stringify(body) });
    await post({ page: 0, pageSize: 5, filters: [], sort: { field: 'attributes.cleared_at', direction: 'DESC', extra: 1 } });
    assert.deepEqual(JSON.parse(fetchLog.at(-1).options.body).sort, { field: 'attributes.cleared_at', direction: 'desc' });
    await post({ page: 0, pageSize: 5, sort: { field: 'attributes.code', direction: 'sideways' } });
    assert.deepEqual(JSON.parse(fetchLog.at(-1).options.body).sort, { field: 'attributes.code', direction: 'asc' });
    await post({ page: 0, pageSize: 5, sort: { field: '' } });
    assert.equal('sort' in JSON.parse(fetchLog.at(-1).options.body), false);
  });

  test('forwards only a sanitised read body, with the page size capped', async () => {
    const { body: { classes } } = await json(await fetch(`${proxy.base}/api/live-dc/classes`));
    fetchLog.length = 0;
    await fetch(`${proxy.base}/api/live-dc/class/${classes[0].id}/curated-data`, {
      method: 'POST', body: JSON.stringify({ page: 2, pageSize: 1e6, filters: [], loadType: 'Full', payload: [1] }),
    });
    const sent = JSON.parse(fetchLog.at(-1).options.body);
    assert.deepEqual(Object.keys(sent).sort(), ['filters', 'page', 'pageSize']);
    assert.equal(sent.page, 2);
    assert.ok(sent.pageSize <= 500);
  });

  test('refuses historical and unknown classes without calling upstream for their data', async () => {
    const assets = standin.classByName(REF.ASSETS);
    const incidents = standin.classByName('Florida I595 Incidents');
    fetchLog.length = 0;
    for (const id of [assets.id, incidents.id, 'nope', '..%2F..%2Fadmin']) {
      const { status, body } = await json(await fetch(`${proxy.base}/api/live-dc/class/${id}/curated-data`, { method: 'POST', body: '{}' }));
      assert.equal(status, 403, id);
      assert.match(body.error, /Live/);
    }
    assert.ok(fetchLog.every(call => !/curated-data/.test(call.url)), 'no curated-data read reached upstream');
  });

  test('refuses anything that is not a read', async () => {
    const { body: { classes } } = await json(await fetch(`${proxy.base}/api/live-dc/classes`));
    const id = classes[0].id;
    const before = standin.requests.length;
    const attempts = [
      ['POST', '/api/live-dc/loads/class'], ['POST', '/api/live-dc/classes'], ['DELETE', `/api/live-dc/class/${id}`],
      ['PUT', `/api/live-dc/class/${id}/curated-data`], ['POST', `/api/live-dc/class/${id}`],
      ['GET', `/api/live-dc/class/${id}/raw-data-process`], ['POST', '/api/live-dc/admin/data/import'],
    ];
    for (const [method, path] of attempts) {
      const { status, body } = await json(await fetch(`${proxy.base}${path}`, { method, body: method === 'GET' ? undefined : '[]' }));
      assert.ok(status === 404 || status === 405, `${method} ${path} -> ${status}`);
      assert.ok(body?.error);
    }
    assert.equal(standin.requests.length, before, 'nothing was forwarded');
  });

  test('never hands a token to the browser', async () => {
    const texts = await Promise.all(['/api/live-dc/classes', '/api/live-dc/status'].map(p => fetch(`${proxy.base}${p}`).then(r => r.text())));
    for (const text of texts) assert.ok(!/test-token|bearer|authorization/i.test(text), text);
    assert.ok(fetchLog.some(call => /^Bearer /.test(call.options.headers.authorization)), 'upstream calls are authenticated');
  });

  test('status says the Live classes are available', async () => {
    const { status, body } = await json(await fetch(`${proxy.base}/api/live-dc/status`));
    assert.equal(status, 200);
    assert.equal(body.available, true);
    assert.deepEqual(body.missing, []);
  });

  test('leaves routes outside /api/live-dc to the next middleware', async () => {
    assert.equal((await fetch(`${proxy.base}/api/dataconnect/classes`)).status, 418);
  });
});

describe('live-dc read proxy when the upstream is unavailable', () => {
  test('answers 503 with an error when the stand-in is down', async () => {
    const standin = createDcStandin({ seedHistorical: false, logger: silent });
    const gone = await standin.listen(0);
    await gone.close();
    const proxy = await mount(createLiveDcReadApi({
      config: loadLiveDcReadConfig({ LIVE_DC_READ_BASE_URL: gone.url, LIVE_DC_READ_ACCESS_TOKEN: TEST_TOKEN, LIVE_DC_READ_TIMEOUT_MS: '2000' }), logger: silent,
    }));
    try {
      const classes = await json(await fetch(`${proxy.base}/api/live-dc/classes`));
      assert.equal(classes.status, 503);
      assert.match(classes.body.error, /unavailable/i);
      const data = await json(await fetch(`${proxy.base}/api/live-dc/class/abc/curated-data`, { method: 'POST', body: '{}' }));
      assert.equal(data.status, 503);
      const status = await json(await fetch(`${proxy.base}/api/live-dc/status`));
      assert.equal(status.status, 200);
      assert.equal(status.body.available, false);
    } finally { await proxy.close(); }
  });

  test('a remote host with no read credential is refused before any network call', async () => {
    let calls = 0;
    const proxy = await mount(createLiveDcReadApi({
      config: loadLiveDcReadConfig({ LIVE_DC_READ_BASE_URL: 'https://dc.example' }), logger: silent,
      fetchImpl: async () => { calls++; throw new Error('should not be called'); },
    }));
    try {
      const { status, body } = await json(await fetch(`${proxy.base}/api/live-dc/classes`));
      assert.equal(status, 503);
      assert.match(body.error, /not configured/i);
      assert.equal(calls, 0);
    } finally { await proxy.close(); }
  });

  test('without LIVE_DC_READ_BASE_URL nothing is read: not configured, never a local default', async () => {
    let calls = 0;
    const proxy = await mount(createLiveDcReadApi({
      config: loadLiveDcReadConfig({ LIVE_DC_READ_ACCESS_TOKEN: TEST_TOKEN }), logger: silent,
      fetchImpl: async () => { calls++; throw new Error('should not be called'); },
    }));
    try {
      const { status, body } = await json(await fetch(`${proxy.base}/api/live-dc/classes`));
      assert.equal(status, 503);
      assert.equal(body.code, 'unconfigured');
      const state = await json(await fetch(`${proxy.base}/api/live-dc/status`));
      assert.equal(state.body.available, false);
      assert.equal(state.body.baseUrl, null);
      assert.equal(calls, 0);
    } finally { await proxy.close(); }
  });

  test('a loopback host gets no built-in stand-in token: without a credential it is not configured', async () => {
    let calls = 0;
    const proxy = await mount(createLiveDcReadApi({
      config: loadLiveDcReadConfig({ LIVE_DC_READ_BASE_URL: 'http://127.0.0.1:5190' }), logger: silent,
      fetchImpl: async () => { calls++; throw new Error('should not be called'); },
    }));
    try {
      const { status, body } = await json(await fetch(`${proxy.base}/api/live-dc/classes`));
      assert.equal(status, 503);
      assert.match(body.error, /not configured/i);
      assert.equal(calls, 0);
    } finally { await proxy.close(); }
  });

  test('upstream authentication failures surface as an error, not as data', async () => {
    const proxy = await mount(createLiveDcReadApi({
      config: loadLiveDcReadConfig({ LIVE_DC_READ_BASE_URL: 'https://dc.example.test', LIVE_DC_READ_ACCESS_TOKEN: TEST_TOKEN }), logger: silent,
      fetchImpl: async () => new Response(JSON.stringify({ title: 'Unauthorized' }), { status: 401 }),
    }));
    try {
      const { status, body } = await json(await fetch(`${proxy.base}/api/live-dc/classes`));
      assert.equal(status, 502);
      assert.ok(body.error);
    } finally { await proxy.close(); }
  });
});

test('configuration has no default host and rejects unsafe paths', () => {
  const config = loadLiveDcReadConfig({});
  assert.equal(config.baseUrl, '');
  assert.equal(config.dataMgmtPrefix, '/api/data-mgmt/v1');
  assert.throws(() => loadLiveDcReadConfig({ LIVE_DC_READ_DATA_MGMT_PREFIX: '@evil.example/x' }));
  assert.equal(loadLiveDcReadConfig({ LIVE_DC_READ_BASE_URL: 'http://127.0.0.1:5190/' }).baseUrl, 'http://127.0.0.1:5190');
});

describe('live-dc read proxy request validation', () => {
  const fakeRes = () => ({
    status: null, body: '',
    writeHead(status) { this.status = status; },
    end(chunk = '') { this.body = String(chunk); },
  });
  const request = (url, chunks) => Object.assign(Readable.from(chunks), { url, method: 'POST' });
  const within = (promise, ms = 2000) => {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };
  const offline = () => {
    const calls = [];
    const api = createLiveDcReadApi({
      config: loadLiveDcReadConfig({ LIVE_DC_READ_BASE_URL: 'https://dc.example.test', LIVE_DC_READ_ACCESS_TOKEN: TEST_TOKEN }),
      logger: silent, fetchImpl: async url => { calls.push(String(url)); throw new Error('offline'); },
    });
    return { api, calls };
  };

  test('an oversize body is answered 413 instead of hanging', async () => {
    const { api, calls } = offline();
    const res = fakeRes();
    const big = Buffer.alloc(40 * 1024, 'a');
    await within(api.handle(request('/api/live-dc/class/abc/curated-data', [big, big, big]), res));
    assert.equal(res.status, 413);
    assert.ok(JSON.parse(res.body).error);
    assert.deepEqual(calls, []);
  });

  test('a malformed class id is a 400, not an upstream failure', async () => {
    const { api, calls } = offline();
    const res = fakeRes();
    await within(api.handle(request('/api/live-dc/class/%E0%A4%A/curated-data', ['{}']), res));
    assert.equal(res.status, 400);
    assert.deepEqual(calls, []);
  });
});

describe('live-dc read proxy token file', () => {
  test('a remote upstream re-reads LIVE_DC_READ_ACCESS_TOKEN_FILE on every call, so a renewed sign-in needs no restart', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'livedc-token-')), 'token');
    writeFileSync(file, 'first-token\n');
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push(init.headers.authorization);
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const config = loadLiveDcReadConfig({ LIVE_DC_READ_BASE_URL: 'https://dc.example.test', LIVE_DC_READ_ACCESS_TOKEN_FILE: file });
    assert.equal(config.accessTokenFile, file);
    const api = createLiveDcReadApi({ config, fetchImpl, logger: { info() {}, warn() {}, error() {}, log() {} }, now: (() => { let t = 0; return () => (t += 120_000); })() });
    const call = () => new Promise(done => {
      const req = Readable.from([]);
      Object.assign(req, { method: 'GET', url: '/api/live-dc/classes', headers: {} });
      const res = { writeHead() { return res; }, setHeader() {}, end: () => done() };
      api.handle(req, res);
    });
    await call();
    writeFileSync(file, 'second-token\n');
    await call();
    assert.deepEqual(seen, ['Bearer first-token', 'Bearer second-token']);
  });

  test('a loopback upstream uses the token file too (no stand-in special case)', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(mkdtempSync(join(tmpdir(), 'livedc-token-')), 'token');
    writeFileSync(file, 'file-token\n');
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push(init.headers.authorization);
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const api = createLiveDcReadApi({
      config: loadLiveDcReadConfig({ LIVE_DC_READ_BASE_URL: 'http://127.0.0.1:5190', LIVE_DC_READ_ACCESS_TOKEN_FILE: file }), fetchImpl, logger: silent,
    });
    await api.liveClasses();
    assert.deepEqual(seen, ['Bearer file-token']);
  });
});

test('the Vite dev server builds one read proxy and shares it with the live-events API', () => {
  const source = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.equal(source.match(/createLiveDcReadApi\(/g)?.length, 1);
  assert.match(source, /createLiveEventsApi\(\{[^}]*liveDc\b/);
});
