/**
 * The server half: it holds the credentials, exchanges them for a token, attaches it, and never
 * lets a token, a password or an Authorization header reach a log or the browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataConnectApi, grantType, loadDataConnectConfig, missingConfig, readStoredToken, tokenExpiry } from '../server/dataConnect.mjs';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveClassIds } from '../src/maintenance/dataConnectClasses.js';

const config = {
  baseUrl: 'https://dc.example', classesPath: '/api/v1/class',
  curatedDataPath: '/api/v1/class/{classId}/curated-data',
  tokenUrl: 'https://ims.example/connect/token', clientId: 'app', clientSecret: '', grant: 'password',
  scope: 'itwin-platform', username: 'someone@example.com', password: 'hunter2',
  staticToken: '', timeoutMs: 5000, pageSize: 500,
};
const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

test('configuration is reported as missing by name, never guessed', () => {
  assert.deepEqual(missingConfig({ baseUrl: '', staticToken: '', clientId: '', username: '', password: '' }),
    ['DC_BASE_URL', 'DC_CLIENT_ID', 'DC_USERNAME', 'DC_PASSWORD']);
  // A service client needs a secret and no user at all.
  assert.deepEqual(missingConfig({ baseUrl: 'x', staticToken: '', clientId: 'app', grant: 'client_credentials', clientSecret: '' }),
    ['DC_CLIENT_SECRET']);
  assert.deepEqual(missingConfig({ baseUrl: 'x', staticToken: '', clientId: 'app', grant: 'client_credentials', clientSecret: 's' }), []);
  assert.deepEqual(missingConfig({ baseUrl: 'x', staticToken: 't' }), []);
  // The credentials are read from non-VITE names, so they are never bundled for the browser.
  const loaded = loadDataConnectConfig({ DC_BASE_URL: 'https://dc.example/', DC_USERNAME: 'u' });
  assert.equal(loaded.baseUrl, 'https://dc.example');
  assert.equal(loaded.curatedDataPath, '/api/v1/class/{classId}/curated-data');
});

test('credentials are exchanged once for a token, reused, and attached to every call', async () => {
  const calls = [];
  const api = createDataConnectApi({ config, logger: { info() {}, warn() {} }, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url === config.tokenUrl) return ok({ access_token: 'secret-token', expires_in: 3600 });
    return ok({ data: [{ id: '1' }], totalCount: 1 });
  } });
  await api.curatedData('class-work-orders', { page: 0, pageSize: 500 });
  await api.curatedData('class-work-orders', { page: 1, pageSize: 500 });
  assert.equal(calls.filter(call => call.url === config.tokenUrl).length, 1, 'signed in once');
  const dataCalls = calls.filter(call => call.url !== config.tokenUrl);
  assert.equal(dataCalls.length, 2);
  assert.equal(dataCalls[0].url, 'https://dc.example/api/v1/class/class-work-orders/curated-data?includeDescendants=false');
  assert.equal(dataCalls[0].options.headers.authorization, 'Bearer secret-token');
  assert.deepEqual(JSON.parse(dataCalls[0].options.body), { page: 0, pageSize: 500, filters: [] });
});

test('an expired token is replaced once, and a still-rejected call surfaces as 401', async () => {
  let tokens = 0, attempts = 0;
  const api = createDataConnectApi({ config, logger: { info() {}, warn() {} }, fetchImpl: async url => {
    if (url === config.tokenUrl) { tokens++; return ok({ access_token: `t${tokens}`, expires_in: 3600 }); }
    attempts++;
    return attempts === 1 ? { ok: false, status: 401, text: async () => 'expired', json: async () => ({}) } : ok({ data: [], totalCount: 0 });
  } });
  await api.curatedData('c');
  assert.deepEqual([tokens, attempts], [2, 2], 'one retry with a fresh token');

  const always401 = createDataConnectApi({ config, logger: { info() {}, warn() {} }, fetchImpl: async url =>
    (url === config.tokenUrl ? ok({ access_token: 't', expires_in: 3600 })
      : { ok: false, status: 401, text: async () => '', json: async () => ({}) }) });
  const error = await always401.curatedData('c').catch(caught => caught);
  assert.equal(error.status, 401);
});

/** A request/response pair shaped like Node's, enough for the middleware. */
function exchange(method, url, body = null) {
  const req = { method, url, on(event, fn) {
    if (event === 'data' && body) fn(JSON.stringify(body));
    if (event === 'end') fn();
    return req;
  } };
  const sent = {};
  const res = { writeHead(status, headers) { sent.status = status; sent.headers = headers; },
    end(payload) { sent.body = payload ? JSON.parse(payload) : null; } };
  return { req, res, sent };
}

test('no token, password or Authorization header is ever logged, even when a call fails', async () => {
  const logged = [];
  const record = (...args) => logged.push(JSON.stringify(args));
  const api = createDataConnectApi({ config, logger: { info: record, warn: record }, fetchImpl: async url =>
    (url === config.tokenUrl ? ok({ access_token: 'secret-token', refresh_token: 'secret-refresh', expires_in: 3600 })
      : { ok: false, status: 500, text: async () => 'Bearer secret-token leaked in body', json: async () => ({}) }) });
  const { req, res, sent } = exchange('POST', '/api/dataconnect/class/c/curated-data', { page: 0, pageSize: 500 });
  assert.equal(await api.handle(req, res), true, 'the route is handled');
  assert.equal(sent.status, 500);
  const all = logged.join(' ');
  for (const secret of ['secret-token', 'secret-refresh', 'hunter2', 'Bearer ', 'authorization']) {
    assert.ok(!all.toLowerCase().includes(secret.toLowerCase()), `${secret} must not be logged: ${all}`);
  }
  assert.match(all, /500/, 'the status is reported');
  // Nor does the response body hand the browser anything sensitive.
  assert.ok(!JSON.stringify(sent.body).includes('secret-token'));
});

test('an unconfigured server says exactly what is missing, and serves no data', async () => {
  const api = createDataConnectApi({ config: { ...config, baseUrl: '', username: '', password: '', clientId: '' },
    logger: { info() {}, warn() {} }, fetchImpl: async () => { throw new Error('must not be called'); } });
  const status = exchange('GET', '/api/dataconnect/status');
  await api.handle(status.req, status.res);
  assert.equal(status.sent.status, 200);
  assert.equal(status.sent.body.configured, false);
  assert.deepEqual(status.sent.body.missing, ['DC_BASE_URL', 'DC_CLIENT_ID', 'DC_USERNAME', 'DC_PASSWORD']);
  const data = exchange('POST', '/api/dataconnect/class/c/curated-data', {});
  await api.handle(data.req, data.res);
  assert.equal(data.sent.status, 503, 'no request is attempted without configuration');
});

test('class ids are discovered by name, and what is missing is named', () => {
  const { ids, missing } = resolveClassIds([
    { id: 'id-wo', name: 'Work Orders' }, { id: 'id-assets', name: 'asset_registry' },
    { id: 'id-tickets', name: 'tickets' }, { id: 'id-roadway', name: 'roadway_inspections_v3' },
  ]);
  assert.deepEqual(ids.workOrders, ['id-wo'], 'spelling of the name does not matter');
  assert.deepEqual(ids.assets, ['id-assets']);
  assert.deepEqual(ids.inspections, ['id-roadway'], 'one family is enough to browse inspections');
  assert.deepEqual(missing.sort(), ['Incidents', 'Tasks']);
});

test('requests this API does not own are passed on, so the dev server never stalls', async () => {
  const api = createDataConnectApi({ config, logger: { info() {}, warn() {} }, fetchImpl: async () => ok({}) });
  let passedOn = false;
  await new Promise(resolve => api.middleware({ method: 'GET', url: '/index.html', on() {} }, {},
    () => { passedOn = true; resolve(); }));
  assert.equal(passedOn, true);
});

test('the grant follows what is configured: a service client sends no username or password', async () => {
  // Chosen automatically: a secret and no user means an application identity.
  assert.equal(grantType({}, { clientSecret: 's', username: '' }), 'client_credentials');
  assert.equal(grantType({}, { clientSecret: '', username: 'u' }), 'password');
  assert.equal(grantType({}, { clientSecret: 's', username: 'u' }), 'password');
  assert.equal(grantType({ DC_GRANT: 'client_credentials' }, { clientSecret: '', username: 'u' }), 'client_credentials');

  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(String(init.body));
    return url.includes('token') ? ok({ access_token: 'tok', expires_in: 3600 }) : ok({ data: [], totalCount: 0 });
  };
  const api = createDataConnectApi({
    config: { ...config, grant: 'client_credentials', clientSecret: 'shhh', username: 'u', password: 'hunter2' },
    fetchImpl, logger: { info() {}, warn() {} },
  });
  await api.classes();
  const tokenBody = new URLSearchParams(bodies[0]);
  assert.equal(tokenBody.get('grant_type'), 'client_credentials');
  assert.equal(tokenBody.get('client_secret'), 'shhh');
  assert.equal(tokenBody.get('username'), null, 'no user identity travels with an application grant');
  assert.equal(tokenBody.get('password'), null);
});

test('a sign-in rejection reports the OAuth error code and nothing else from the body', async () => {
  const fetchImpl = async () => ({
    ok: false, status: 400,
    // A real IMS body can echo the request back; only the `error` code may be surfaced.
    json: async () => ({ error: 'unauthorized_client', error_description: 'user hunter2 not allowed' }),
    text: async () => '{"error":"unauthorized_client"}',
  });
  const api = createDataConnectApi({ config, fetchImpl, logger: { info() {}, warn() {} } });
  const error = await api.classes().then(() => null, e => e);
  assert.equal(error.oauthError, 'unauthorized_client');
  assert.equal(error.message, 'Sign-in failed (400: unauthorized_client)');
  assert.ok(!/hunter2/.test(error.message), 'the description, which can carry credentials, is not surfaced');
});

test('a pasted token reports its own expiry, so a stale paste is not mistaken for a bad password', () => {
  const jwt = exp => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`;
  const now = 1_790_000_000_000;
  const fresh = tokenExpiry(jwt(now / 1000 + 3600), now);
  assert.equal(fresh.expired, false);
  assert.equal(fresh.minutesLeft, 60);
  const stale = tokenExpiry(jwt(now / 1000 - 600), now);
  assert.equal(stale.expired, true);
  assert.equal(stale.minutesLeft, -10);
  // Not a JWT, or no exp claim: no expiry is known, and nothing throws.
  assert.equal(tokenExpiry('an-opaque-token', now), null);
  assert.equal(tokenExpiry('', now), null);
  assert.equal(tokenExpiry(`h.${Buffer.from('{"sub":"x"}').toString('base64url')}.s`, now), null);
});

test('a refresh token renews the access token, and its rotation is saved', async () => {
  const store = join(tmpdir(), `dc-refresh-${Date.now()}`);
  const calls = [];
  let issued = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).includes('token')) {
      calls.push(new URLSearchParams(String(init.body)));
      issued += 1;
      // IMS rotates: every refresh retires the token just used and returns a new one.
      return ok({ access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 3600 });
    }
    calls.push(init.headers.authorization);
    return ok({ classes: [] });
  };
  const api = createDataConnectApi({
    config: { ...config, staticToken: '', refreshToken: 'refresh-0', tokenStore: store },
    fetchImpl, logger: { info() {}, warn() {} },
  });
  await api.classes();

  const grant = calls[0];
  assert.equal(grant.get('grant_type'), 'refresh_token');
  assert.equal(grant.get('refresh_token'), 'refresh-0');
  assert.equal(grant.get('password'), null, 'no password is involved');
  assert.equal(grant.get('client_secret'), null, 'and no client secret either');
  assert.equal(calls[1], 'Bearer access-1');
  // The rotated token is on disk, so a restart does not need another interactive sign-in.
  assert.equal(readFileSync(store, 'utf8').trim(), 'refresh-1');
  assert.equal(readStoredToken(store), 'refresh-1');
  rmSync(store, { force: true });
});

test('a refresh token is preferred over a pasted one, which cannot be renewed', async () => {
  const store = join(tmpdir(), `dc-refresh-pref-${Date.now()}`);
  const seen = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('token')) return ok({ access_token: 'minted', expires_in: 3600 });
    seen.push(init.headers.authorization);
    return ok({ classes: [] });
  };
  const api = createDataConnectApi({
    config: { ...config, staticToken: 'pasted-and-expiring', refreshToken: 'r0', tokenStore: store },
    fetchImpl, logger: { info() {}, warn() {} },
  });
  await api.classes();
  assert.deepEqual(seen, ['Bearer minted'], 'the renewable credential wins');

  // With no refresh token, the pasted one is still honoured.
  const plain = createDataConnectApi({
    config: { ...config, staticToken: 'pasted-and-expiring', refreshToken: '', tokenStore: store },
    fetchImpl: async (url, init) => { seen.push(init.headers?.authorization); return ok({ classes: [] }); },
    logger: { info() {}, warn() {} },
  });
  await plain.classes();
  assert.equal(seen.at(-1), 'Bearer pasted-and-expiring');
  rmSync(store, { force: true });
});

test('a refresh token alone is enough configuration; a pasted token is not renewable', () => {
  assert.deepEqual(missingConfig({ baseUrl: 'x', clientId: 'app', refreshToken: 'r', tokenStore: '' }), []);
  // It still needs the client it was issued to.
  assert.deepEqual(missingConfig({ baseUrl: 'x', clientId: '', refreshToken: 'r', tokenStore: '' }), ['DC_CLIENT_ID']);
});

test('an expired pasted token is reported as expiry, and re-reading the store needs no restart', async () => {
  const store = join(tmpdir(), `dc-access-${Date.now()}`);
  const jwt = exp => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`;
  const nowMs = 1_790_000_000_000;
  writeFileSync(store, `${jwt(nowMs / 1000 - 60)}\n`);
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(init.headers?.authorization); return ok({ classes: [] }); };
  const api = createDataConnectApi({
    config: { ...config, staticToken: '', refreshToken: '', accessStore: store, tokenStore: '' },
    fetchImpl, now: () => nowMs, logger: { info() {}, warn() {} },
  });

  const error = await api.classes().then(() => null, e => e);
  assert.equal(error.code, 'token_expired');
  assert.equal(error.status, 401);
  assert.deepEqual(seen, [], 'an expired token is not spent on a doomed request');

  // `dc:login` rewrites the file; the very next call must use it, with no restart.
  writeFileSync(store, `${jwt(nowMs / 1000 + 3600)}\n`);
  await api.classes();
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^Bearer /);
  rmSync(store, { force: true });
});
