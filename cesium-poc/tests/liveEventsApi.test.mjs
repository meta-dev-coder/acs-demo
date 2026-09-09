import test from 'node:test';
import assert from 'node:assert/strict';
import { API_BASE, createLiveEventsApi } from '../server/api.mjs';

const payload = {
  source: 'FL511', sourceStatus: 'LIVE', bufferMeters: 250,
  counts: { total: 2, incidents: 1, closures: 1 },
  events: [{ id: 'FL511-INCIDENT-1', type: 'INCIDENT' }, { id: 'FL511-CLOSURE-2', type: 'CLOSURE' }],
};

const stubService = (result = payload) => ({
  getI595LiveEvents: async () => { if (result instanceof Error) throw result; return result; },
  stop() {}, start: async () => {}, refresh: async () => {},
});

/** Minimal node:http response double. */
function fakeResponse() {
  return {
    statusCode: null, headers: null, body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(chunk = '') { this.body = chunk; },
    get json() { return JSON.parse(this.body); },
  };
}

const call = async (api, url, method = 'GET') => {
  const response = fakeResponse();
  const handled = await api.handle({ url, method }, response);
  return { handled, response };
};

const silent = { warn() {}, error() {}, log() {} };

test('serves the combined corridor payload', async () => {
  const { handled, response } = await call(createLiveEventsApi({ service: stubService(), logger: silent }), API_BASE);
  assert.ok(handled);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.counts.total, 2);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
});

test('sub-resources narrow the same payload', async () => {
  const api = createLiveEventsApi({ service: stubService(), logger: silent });
  const incidents = (await call(api, `${API_BASE}/incidents`)).response.json;
  assert.deepEqual(incidents.events.map(event => event.id), ['FL511-INCIDENT-1']);
  assert.equal(incidents.counts.total, 1);
  const closures = (await call(api, `${API_BASE}/closures?ignored=1`)).response.json;
  assert.deepEqual(closures.events.map(event => event.id), ['FL511-CLOSURE-2']);
});

test('leaves unrelated requests to the rest of the server', async () => {
  const api = createLiveEventsApi({ service: stubService(), logger: silent });
  assert.equal((await call(api, '/index.html')).handled, false);
  assert.equal((await call(api, '/api/i595/live-events-other')).handled, false);
});

test('rejects unknown sub-resources and non-GET methods', async () => {
  const api = createLiveEventsApi({ service: stubService(), logger: silent });
  assert.equal((await call(api, `${API_BASE}/vehicles`)).response.statusCode, 404);
  assert.equal((await call(api, API_BASE, 'POST')).response.statusCode, 405);
});

test('a backend failure answers UNAVAILABLE rather than an empty LIVE feed', async () => {
  const api = createLiveEventsApi({ service: stubService(new Error('FL511 down')), logger: silent });
  const { response } = await call(api, API_BASE);
  assert.equal(response.statusCode, 503);
  assert.equal(response.json.sourceStatus, 'UNAVAILABLE');
  assert.deepEqual(response.json.events, []);
  assert.equal(response.json.diagnostics.lastError, 'FL511 down');
});
