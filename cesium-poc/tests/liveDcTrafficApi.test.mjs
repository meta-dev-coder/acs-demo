/**
 * /api/i595/live-events?source=dataconnect over a seeded in-process stand-in: active Live Events
 * come back in the consumer shape, cleared ones are excluded, and the direct FL511 feed is never used:
 * when DataConnect cannot answer the payload is UNAVAILABLE from DataConnect. Without the parameter
 * nothing changes.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_BASE, createLiveEventsApi } from '../server/api.mjs';
import { loadConfig } from '../server/config.mjs';
import { loadI595Network } from '../server/i595Network.mjs';
import { LIVE_CLASS } from '../server/liveDc/classes.mjs';
import { createDcWriter, loadDcWriterConfig } from '../server/liveDc/dcWriter.mjs';
import { createDcStandin } from '../server/liveDc/standin.mjs';
import { createLiveDcReadApi, loadLiveDcReadConfig } from '../server/liveDc/liveReadApi.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const network = await loadI595Network(join(ROOT, 'public', 'data'));
const config = loadConfig({});
const silent = { info() {}, log() {}, warn() {}, error() {} };
const TEST_TOKEN = 'test-token';
const NOW = Date.parse('2026-09-26T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const EB = network.lines.find(line => line.facility === 'I595_EB').coordinates;

const record = (itemId, type, extra) => ({
  keyInSource: `FL511-${itemId}`, code: `FL511-${itemId}`, event_id: `FL511-${type}-${itemId}`, event_type: type,
  fl511_item_id: itemId, source: 'FL511', project: '2222FL', first_seen_at: iso(NOW - 600_000), last_seen_at: iso(NOW - 60_000),
  ...extra,
});
const RECORDS = [
  record('868702', 'INCIDENT', {
    name: 'Crash', title: 'Crash', description: 'Crash on I-595 West at Davie Rd. 2 right lanes blocked.', severity: 'Major',
    status: 'active', latitude: 26.093417, longitude: -80.226583, x_coordinates: -80.226583, y_coordinates: 26.093417,
  }),
  record('900010', 'CLOSURE', {
    name: 'Closure', title: 'Closure', description: 'Lane closure on I-595 East. Left lane closed.', status: 'active',
    latitude: EB[40][1], longitude: EB[40][0], x_coordinates: EB[40][0], y_coordinates: EB[40][1],
  }),
  record('777001', 'INCIDENT', {
    name: 'Crash', title: 'Crash', description: 'Crash on I-595 East at SR 7.', status: 'cleared', cleared_at: iso(NOW - 120_000),
    latitude: EB[20][1], longitude: EB[20][0], x_coordinates: EB[20][0], y_coordinates: EB[20][1],
  }),
];

const FL511_PAYLOAD = {
  source: 'FL511', sourceStatus: 'LIVE', bufferMeters: 250,
  counts: { total: 3, incidents: 3, closures: 0 },
  events: [
    { id: 'FL511-INCIDENT-1', type: 'INCIDENT' }, { id: 'FL511-INCIDENT-2', type: 'INCIDENT' }, { id: 'FL511-INCIDENT-3', type: 'INCIDENT' },
  ],
};

function stubService(result = FL511_PAYLOAD) {
  const service = {
    calls: 0,
    getI595LiveEvents: async () => { service.calls++; if (result instanceof Error) throw result; return result; },
    stop() {}, start: async () => {}, refresh: async () => {},
  };
  return service;
}

function fakeResponse() {
  return {
    statusCode: null, body: '',
    writeHead(status) { this.statusCode = status; },
    end(chunk = '') { this.body = chunk; },
    get json() { return JSON.parse(this.body); },
  };
}
const get = async (api, url) => {
  const response = fakeResponse();
  await api.handle({ url, method: 'GET' }, response);
  return response;
};

const readApiFor = url => createLiveDcReadApi({
  config: { ...loadLiveDcReadConfig({ LIVE_DC_READ_BASE_URL: url, LIVE_DC_READ_ACCESS_TOKEN: TEST_TOKEN }), timeoutMs: 2000 }, logger: silent,
});

async function seededStandin(records) {
  const standin = createDcStandin({ processingDelayMs: 1, curationDelayMs: 1, assetRows: [], logger: silent });
  const upstream = await standin.listen(0);
  if (records.length) {
    const writer = createDcWriter({
      config: { ...loadDcWriterConfig({ DC_WRITER_BASE_URL: upstream.url, DC_WRITER_LOAD_BASE_URL: upstream.url, DC_WRITER_ACCESS_TOKEN: TEST_TOKEN }), pollIntervalMs: 5, processTimeoutMs: 5000, curationTimeoutMs: 5000 },
      logger: silent,
    });
    await writer.loadRecords((await writer.resolveLiveClasses()).get(LIVE_CLASS.EVENTS), records);
  }
  return upstream;
}

const DC = `${API_BASE}?source=dataconnect`;

describe('live events sourced from DataConnect Live Events', () => {
  let upstream, service, api;
  before(async () => {
    upstream = await seededStandin(RECORDS);
    service = stubService();
    api = createLiveEventsApi({ config, network, service, liveDc: readApiFor(upstream.url), logger: silent, now: () => NOW });
  });
  after(async () => { await upstream?.close(); });

  test('active events come back in the direct-feed shape, cleared ones excluded, labelled DataConnect', async () => {
    const response = await get(api, DC);
    assert.equal(response.statusCode, 200);
    const body = response.json;
    assert.equal(body.source, 'DataConnect');
    assert.equal(body.sourceLabel, 'FL511 via DataConnect');
    assert.equal(body.sourceStatus, 'LIVE');
    assert.deepEqual(body.events.map(event => event.id), ['FL511-CLOSURE-900010', 'FL511-INCIDENT-868702']);
    assert.deepEqual(body.counts, { total: 2, incidents: 1, closures: 1, construction: 0, congestion: 0, disabledVehicles: 0 });
    const crash = body.events.find(event => event.type === 'INCIDENT');
    assert.equal(crash.rawSourceId, '868702');
    assert.equal(crash.severity, 'Major');
    assert.equal(crash.nearestFacility, 'I595_WB');
    assert.equal(crash.liveOps.carriageway, 'WB_GENERAL');
    assert.equal(crash.liveOps.laneImpact.blockedLanes, 2);
    assert.equal(crash.liveOps.contributesToImpact, true);
    assert.equal(service.calls, 0, 'the direct FL511 poller is not consulted while DataConnect answers');
  });

  test('sub-resources narrow the DataConnect payload the same way', async () => {
    const body = (await get(api, `${API_BASE}/incidents?source=dataconnect`)).json;
    assert.equal(body.source, 'DataConnect');
    assert.deepEqual(body.events.map(event => event.id), ['FL511-INCIDENT-868702']);
    assert.equal(body.counts.total, 1);
  });

  test('without the source parameter the direct feed is served exactly as before', async () => {
    const body = (await get(api, API_BASE)).json;
    assert.deepEqual(body, FL511_PAYLOAD);
  });
});

/** A logger that records what it was told, to prove the FL511 poller was never even started. */
function recordingLogger() {
  const lines = [];
  const push = (...args) => lines.push(args.map(String).join(' '));
  return { lines, logger: { info: push, log: push, warn: push, error: push } };
}

const assertDcUnavailable = (response, reason) => {
  assert.equal(response.statusCode, 503);
  const body = response.json;
  assert.equal(body.source, 'DataConnect');
  assert.equal(body.sourceStatus, 'UNAVAILABLE');
  assert.deepEqual(body.events, []);
  assert.equal(body.counts.total, 0);
  assert.equal(body.lastUpdated, null);
  assert.match(body.diagnostics.lastError, reason);
  assert.equal(body.fallback, undefined);
  assert.doesNotMatch(response.body, /test-token|bearer|authorization|FL511 direct/i);
  return body;
};

describe('DataConnect requested but not available: UNAVAILABLE, never direct FL511', () => {
  test('DataConnect unreachable -> UNAVAILABLE from DataConnect; the FL511 poller is never consulted or started', async () => {
    const upstream = await seededStandin([]);
    const url = upstream.url;
    await upstream.close();
    const service = stubService();
    const log = recordingLogger();
    const api = createLiveEventsApi({ config, network, service, liveDc: readApiFor(url), logger: log.logger, now: () => NOW });
    assertDcUnavailable(await get(api, DC), /unavailable/i);
    assertDcUnavailable(await get(api, `${API_BASE}/incidents?source=dataconnect`), /unavailable/i);
    assert.equal(service.calls, 0);
    assert.ok(!log.lines.some(line => /^FL511 live events:/.test(line)), log.lines.join('\n'));
  });

  test('not configured (no LIVE_DC_READ_BASE_URL) -> UNAVAILABLE with the reason', async () => {
    const service = stubService();
    const liveDc = createLiveDcReadApi({ config: loadLiveDcReadConfig({}), logger: silent, fetchImpl: async () => { throw new Error('no call'); } });
    const api = createLiveEventsApi({ config, network, service, liveDc, logger: silent, now: () => NOW });
    assertDcUnavailable(await get(api, DC), /not configured/i);
    assert.equal(service.calls, 0);
  });

  test('Live Events class missing -> UNAVAILABLE', async () => {
    const service = stubService();
    const liveDc = { liveClasses: async () => [], curatedData: async () => { throw new Error('unexpected'); } };
    const api = createLiveEventsApi({ config, network, service, liveDc, logger: silent, now: () => NOW });
    assertDcUnavailable(await get(api, DC), /not found/);
    assert.equal(service.calls, 0);
  });

  test('an upstream error (401) -> UNAVAILABLE, no token details', async () => {
    const service = stubService();
    const liveDc = createLiveDcReadApi({
      config: loadLiveDcReadConfig({ LIVE_DC_READ_BASE_URL: 'https://dc.example.test', LIVE_DC_READ_ACCESS_TOKEN: TEST_TOKEN }),
      logger: silent, fetchImpl: async () => new Response('{"detail":"bad Bearer test-token"}', { status: 401 }),
    });
    const api = createLiveEventsApi({ config, network, service, liveDc, logger: silent, now: () => NOW });
    assertDcUnavailable(await get(api, DC), /401/);
    assert.equal(service.calls, 0);
  });

  test('an empty Live Events class is a live zero from DataConnect', async () => {
    const upstream = await seededStandin([]);
    try {
      const service = stubService();
      const api = createLiveEventsApi({ config, network, service, liveDc: readApiFor(upstream.url), logger: silent, now: () => NOW });
      const response = await get(api, DC);
      assert.equal(response.statusCode, 200);
      const body = response.json;
      assert.equal(body.source, 'DataConnect');
      assert.equal(body.sourceLabel, 'FL511 via DataConnect');
      assert.equal(body.sourceStatus, 'LIVE');
      assert.deepEqual(body.events, []);
      assert.equal(body.counts.total, 0);
      assert.equal(service.calls, 0);
    } finally { await upstream.close(); }
  });

  test('recovers on the next request once DataConnect answers again', async () => {
    let down = true;
    const liveDc = {
      liveClasses: async () => { if (down) throw Object.assign(new Error('Live DataConnect is unavailable.'), { status: 503 }); return [{ id: 'e', className: LIVE_CLASS.EVENTS }]; },
      curatedData: async () => ({ data: [], totalCount: 0 }),
    };
    const api = createLiveEventsApi({ config, network, service: stubService(), liveDc, logger: silent, now: () => NOW });
    assertDcUnavailable(await get(api, DC), /unavailable/i);
    down = false;
    const response = await get(api, DC);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json.sourceStatus, 'LIVE');
  });

  test('the plain endpoint still reports FL511 UNAVAILABLE when the direct feed is down', async () => {
    const api = createLiveEventsApi({ config, network, service: stubService(new Error('FL511 down')), logger: silent, now: () => NOW });
    const response = await get(api, API_BASE);
    assert.equal(response.statusCode, 503);
    assert.equal(response.json.source, 'FL511');
    assert.equal(response.json.sourceStatus, 'UNAVAILABLE');
    assert.deepEqual(response.json.events, []);
  });
});
