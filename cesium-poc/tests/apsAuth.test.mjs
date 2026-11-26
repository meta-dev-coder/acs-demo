import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApsApi, REFRESH_MARGIN_MS } from '../server/aps/api.mjs';
import { createIfcSpatialApi } from '../server/ifcSpatial/api.mjs';
import { classifyTokenError, loadApsConfig } from '../server/aps/oauth.mjs';
import { createEncryptedFileStore, createMemoryStore } from '../server/aps/sessions.mjs';

const SECRET = 'super-secret-client-value';
const env = { APS_CLIENT_ID: 'client-abc', APS_CLIENT_SECRET: SECRET, APS_CALLBACK_URL: 'http://localhost:5188/api/aps/callback' };
const quiet = { info() {}, warn() {}, error() {} };

/** A stand-in for Autodesk: the token endpoint plus a hub, a project, folders, items and versions. */
function fakeAutodesk({ hubs = [{ id: 'b.hub1', name: 'Forma Hub' }], projectsStatus = 200, scope = 'data:read viewables:read', omitDisplay = false } = {}) {
  const calls = [];
  let issued = 0;
  const validData = new Set();
  const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const version = (id, n, name) => ({ type: 'versions', id, attributes: { name, displayName: name, versionNumber: n, fileType: 'ifc', storageSize: 1234, createTime: '2026-11-01T00:00:00Z', lastModifiedTime: '2026-11-01T00:00:00Z' },
    relationships: { derivatives: { data: { type: 'derivatives', id: `urn-${id}` } }, storage: { data: { id: 'urn:adsk.objects:os.object:wip.dm.prod/secret-location' } } } });
  const item = (id, name, tip) => ({ type: 'items', id, attributes: { displayName: name }, relationships: { tip: { data: { id: tip } } } });
  const routes = {
    '/project/v1/hubs': () => json(200, { data: hubs.map(hub => ({ type: 'hubs', id: hub.id, attributes: { name: hub.name, region: 'US', extension: { type: 'hubs:autodesk.bim360:Account' } } })) }),
    '/project/v1/hubs/b.hub1/projects': () => projectsStatus !== 200 ? json(projectsStatus, { errors: [{ detail: 'You do not have permission to access this hub' }] })
      : json(200, { data: [{ type: 'projects', id: 'b.other', attributes: { name: 'Other' } },
        { type: 'projects', id: 'b.proj1', attributes: { name: 'Seagirt Electrical Digital Twin POC', extension: { type: 'projects:autodesk.bim360:Project' } }, relationships: { rootFolder: { data: { id: 'urn:root' } } } }],
      links: { next: { href: 'https://developer.api.autodesk.com/project/v1/hubs/b.hub1/projects?page%5Bnumber%5D=1' } } }),
    '/project/v1/hubs/b.hub1/projects?page%5Bnumber%5D=1': () => json(200, { data: [] }),
    '/project/v1/hubs/b.hub1/projects/b.proj1/topFolders': () => json(200, { data: [{ type: 'folders', id: 'urn:folder:pf', attributes: { name: 'Project Files', displayName: 'Project Files' } }] }),
    '/data/v1/projects/b.proj1/folders/urn%3Afolder%3Apf/contents': () => json(200, {
      data: [{ type: 'folders', id: 'urn:folder:ifc', attributes: { displayName: 'IFC' } }, item('urn:item:readme', 'readme.txt', 'urn:v:readme')], included: [] }),
    '/data/v1/projects/b.proj1/folders/urn%3Afolder%3Aifc/contents': () => json(200, {
      data: [item('urn:item:net', 'seagirt_power_network.ifc', 'urn:v:net?version=2'), ...(omitDisplay ? [] : [item('urn:item:disp', 'Seagirt_Power_Network_Display.ifc', 'urn:v:disp?version=1')])],
      included: [version('urn:v:net?version=2', 2, 'seagirt_power_network.ifc')] }),
    '/data/v1/projects/b.proj1/items/urn%3Aitem%3Anet/versions': () => json(200, { data: [version('urn:v:net?version=2', 2, 'seagirt_power_network.ifc'), version('urn:v:net?version=1', 1, 'seagirt_power_network.ifc')] }),
    '/data/v1/projects/b.proj1/items/urn%3Aitem%3Adisp/versions': () => json(200, { data: [version('urn:v:disp?version=1', 1, 'seagirt_power_network_display.ifc')] }),
  };
  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init });
    if (url.pathname === '/authentication/v2/token') {
      const body = new URLSearchParams(init.body);
      const auth = Buffer.from(String(init.headers.authorization).replace('Basic ', ''), 'base64').toString();
      if (auth !== `client-abc:${SECRET}`) return json(401, { error: 'invalid_client', error_description: 'The client_id or client_secret is invalid' });
      if (body.get('grant_type') === 'client_credentials') return json(200, { access_token: '2legged', expires_in: 3599 });
      if (body.get('grant_type') === 'authorization_code') {
        if (body.get('redirect_uri') !== env.APS_CALLBACK_URL) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri does not match' });
        if (body.get('code') !== 'good-code') return json(400, { error: 'invalid_grant', error_description: 'code expired' });
        fetchImpl.verifier = body.get('code_verifier');
        issued += 1;
        validData.add(`access-${issued}`);
        return json(200, { access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 3600, scope });
      }
      if (body.get('grant_type') === 'refresh_token') {
        if (body.get('refresh_token') !== `refresh-${issued}`) return json(400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
        const wanted = String(body.get('scope') ?? '').split(' ').filter(Boolean);
        if (!wanted.every(part => scope.split(' ').includes(part))) return json(400, { error: 'invalid_scope', error_description: 'scope exceeds the grant' });
        issued += 1;
        const viewOnly = wanted.length === 1 && wanted[0] === 'viewables:read';
        if (!viewOnly) validData.add(`access-${issued}`);
        return json(200, { access_token: `${viewOnly ? 'viewer' : 'access'}-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 3600 });
      }
    }
    if (url.pathname.startsWith('/modelderivative/')) return json(200, { status: 'success', progress: 'complete', derivatives: [{ outputType: 'svf2', status: 'success' }] });
    const token = String(init.headers?.authorization ?? '').replace('Bearer ', '');
    if (!validData.has(token)) return json(401, { developerMessage: 'The token is invalid' });
    const route = routes[url.pathname + url.search];
    return route ? route() : json(404, { errors: [{ detail: `no route ${url.pathname}` }] });
  }
  fetchImpl.calls = calls;
  fetchImpl.revokeData = () => validData.clear();
  return fetchImpl;
}

function makeApi(options = {}) {
  let clock = 1_000_000;
  const fetchImpl = options.fetchImpl ?? fakeAutodesk(options.autodesk);
  const api = createApsApi({ env: options.env ?? env, fetchImpl, now: () => clock, logger: quiet, store: options.store ?? createMemoryStore() });
  let cookie = '';
  async function call(path, { host = 'localhost:5188', useCookie = true } = {}) {
    let status, headers = {}, body = '';
    const handled = await api.handle({ url: path, method: 'GET', headers: { host, ...(useCookie && cookie ? { cookie } : {}) } }, {
      writeHead(code, h = {}) { status = code; headers = h; }, end(value) { body = value ?? ''; },
    });
    if (headers['set-cookie']) cookie = [].concat(headers['set-cookie'])[0].split(';')[0];
    let json = null;
    try { json = JSON.parse(body); } catch { /* an HTML page */ }
    return { handled, status, headers, body, json };
  }
  return { api, call, fetchImpl, tick: ms => { clock += ms; }, get cookie() { return cookie; }, set cookie(value) { cookie = value; } };
}

async function signIn(harness) {
  const login = await harness.call('/api/aps/login');
  const location = new URL(login.headers.location);
  const state = location.searchParams.get('state');
  const done = await harness.call(`/api/aps/callback?code=good-code&state=${encodeURIComponent(state)}`);
  return { login, location, state, done };
}

test('config reports what is missing and refuses a callback that is not this route', () => {
  assert.deepEqual(loadApsConfig({}).missing, ['APS_CLIENT_ID', 'APS_CLIENT_SECRET', 'APS_CALLBACK_URL']);
  assert.match(loadApsConfig({ ...env, APS_CALLBACK_URL: 'http://localhost:5188/callback' }).problems[0], /must end in \/api\/aps\/callback/);
  assert.equal(loadApsConfig(env).configured, true);
  assert.equal(loadApsConfig(env).scope, 'data:read viewables:read');
});

test('unconfigured: status explains, data routes answer 503, other paths are not handled', async () => {
  const harness = makeApi({ env: {} });
  const status = await harness.call('/api/aps/status');
  assert.equal(status.json.configured, false);
  assert.deepEqual(status.json.missingEnv, ['APS_CLIENT_ID', 'APS_CLIENT_SECRET', 'APS_CALLBACK_URL']);
  assert.equal((await harness.call('/api/aps/hubs')).json.error.code, 'APS_NOT_CONFIGURED');
  assert.equal((await harness.call('/api/aps/login')).status, 503);
  assert.equal((await harness.call('/api/i595/message-signs')).handled, false);
});

test('login redirects to Autodesk OAuth v2 with PKCE S256, the registered callback and data:read', async () => {
  const harness = makeApi();
  const { login, location } = await harness.call('/api/aps/login').then(login => ({ login, location: new URL(login.headers.location) }));
  assert.equal(login.status, 302);
  assert.equal(location.origin + location.pathname, 'https://developer.api.autodesk.com/authentication/v2/authorize');
  assert.equal(location.searchParams.get('response_type'), 'code');
  assert.equal(location.searchParams.get('client_id'), 'client-abc');
  assert.equal(location.searchParams.get('redirect_uri'), env.APS_CALLBACK_URL);
  assert.equal(location.searchParams.get('scope'), 'data:read viewables:read');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.match(location.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!login.headers.location.includes(SECRET), 'the secret is never in the redirect');
  const [sessionSet, legacyClear] = login.headers['set-cookie'];
  assert.match(sessionSet, /^aps_sid=[A-Za-z0-9_-]{43}; Path=\/api; HttpOnly; SameSite=Lax/);
  assert.match(legacyClear, /^aps_sid=; Path=\/api\/aps; .*Max-Age=0/, 'the older /api/aps cookie is expired');
  // The challenge is the S256 of the verifier the callback later sends.
  await harness.call(`/api/aps/callback?code=good-code&state=${encodeURIComponent(location.searchParams.get('state'))}`);
  assert.equal(createHash('sha256').update(harness.fetchImpl.verifier).digest('base64url'), location.searchParams.get('code_challenge'));
});

test('login opened on another host restarts on the callback host, so the cookie comes back', async () => {
  const harness = makeApi();
  const login = await harness.call('/api/aps/login?returnTo=/x', { host: '127.0.0.1:5188' });
  assert.equal(login.status, 302);
  assert.equal(login.headers.location, 'http://localhost:5188/api/aps/login?returnTo=/x');
  assert.equal(login.headers['set-cookie'], undefined);
});

test('state validation: missing session, wrong state, reused state and expired state are refused', async () => {
  const harness = makeApi();
  const login = await harness.call('/api/aps/login');
  const state = new URL(login.headers.location).searchParams.get('state');

  const noCookie = await harness.call(`/api/aps/callback?code=good-code&state=${state}`, { useCookie: false });
  assert.equal(noCookie.status, 400);
  assert.match(noCookie.body, /STATE_INVALID/);

  const wrong = await harness.call('/api/aps/callback?code=good-code&state=forged');
  assert.equal(wrong.status, 400);
  assert.match(wrong.body, /STATE_INVALID/);

  const ok = await harness.call(`/api/aps/callback?code=good-code&state=${state}`);
  assert.equal(ok.status, 200);
  const reused = await harness.call(`/api/aps/callback?code=good-code&state=${state}`);
  assert.equal(reused.status, 400, 'a state is single-use');

  const late = makeApi();
  const lateLogin = await late.call('/api/aps/login');
  late.tick(11 * 60 * 1000);
  const expired = await late.call(`/api/aps/callback?code=good-code&state=${new URL(lateLogin.headers.location).searchParams.get('state')}`);
  assert.match(expired.body, /STATE_EXPIRED/);
  assert.equal((await late.call('/api/aps/status')).json.authenticated, false);
});

test('callback exchanges the code, rotates the session id and keeps tokens server-side', async () => {
  const harness = makeApi();
  const before = (await harness.call('/api/aps/login')).headers['set-cookie'][0].split(';')[0];
  const state = new URL((await harness.call('/api/aps/login')).headers.location).searchParams.get('state');
  const done = await harness.call(`/api/aps/callback?code=good-code&state=${state}`);
  assert.equal(done.status, 200);
  assert.match(done.body, /Signed in to Autodesk/);
  assert.notEqual(harness.cookie, before, 'a fresh session id after sign-in');
  const tokenCall = harness.fetchImpl.calls.find(call => call.url.endsWith('/authentication/v2/token'));
  assert.equal(new URLSearchParams(tokenCall.init.body).get('grant_type'), 'authorization_code');
  assert.ok(!tokenCall.init.body.includes(SECRET), 'the secret goes in the Basic header, not the body');
  for (const text of [done.body, (await harness.call('/api/aps/status')).body]) {
    assert.ok(!/access-1|refresh-1|super-secret/.test(text), 'no token or secret reaches the browser');
  }
  const status = (await harness.call('/api/aps/status')).json;
  assert.equal(status.authenticated, true);
  assert.equal(status.grantedScope, 'data:read viewables:read');
  assert.equal(status.accessTokenExpiresInSeconds, 3600);
  // The old, pre-sign-in id carries nothing.
  harness.cookie = before;
  assert.equal((await harness.call('/api/aps/status')).json.authenticated, false);
});

test('callback errors: consent declined, reused code, callback mismatch and invalid credentials', async () => {
  const declined = makeApi();
  await declined.call('/api/aps/login');
  assert.match((await declined.call('/api/aps/callback?error=access_denied&state=x')).body, /ACCESS_DENIED/);

  const badCode = makeApi();
  const login = await badCode.call('/api/aps/login');
  const state = new URL(login.headers.location).searchParams.get('state');
  assert.match((await badCode.call(`/api/aps/callback?code=stale&state=${state}`)).body, /AUTH_CODE_INVALID/);

  const mismatch = classifyTokenError(400, { error: 'invalid_grant', error_description: 'redirect_uri does not match' }, { grant: 'authorization_code' });
  assert.equal(mismatch.code, 'CALLBACK_MISMATCH');
  assert.equal(classifyTokenError(403, { developerMessage: 'The client_id specified does not have access to the api product' }, { grant: 'authorization_code' }).code, 'APP_NO_API_ACCESS');

  const wrongSecret = makeApi({ env: { ...env, APS_CLIENT_SECRET: 'wrong' }, fetchImpl: fakeAutodesk() });
  const wrongLogin = await wrongSecret.call('/api/aps/login');
  const page = await wrongSecret.call(`/api/aps/callback?code=good-code&state=${new URL(wrongLogin.headers.location).searchParams.get('state')}`);
  assert.equal(page.status, 502);
  assert.match(page.body, /INVALID_CREDENTIALS/);
  const test = (await wrongSecret.call('/api/aps/status?test=1')).json.test;
  assert.equal(test.credentials, 'invalid');
  assert.equal((await makeApi().call('/api/aps/status?test=1')).json.test.credentials, 'valid');
});

test('token refresh: an access token near expiry is refreshed once, with the rotated refresh token', async () => {
  const harness = makeApi();
  await signIn(harness);
  harness.tick(3600 * 1000 - REFRESH_MARGIN_MS + 1);
  const [first, second] = await Promise.all([harness.call('/api/aps/hubs'), harness.call('/api/aps/hubs')]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const refreshes = harness.fetchImpl.calls.filter(call => call.url.endsWith('/token') && new URLSearchParams(call.init.body).get('grant_type') === 'refresh_token');
  assert.equal(refreshes.length, 1, 'concurrent requests share one refresh');
  assert.equal(new URLSearchParams(refreshes[0].init.body).get('refresh_token'), 'refresh-1');
  assert.equal((await harness.call('/api/aps/status')).json.accessTokenExpiresInSeconds, 3600);
});

test('token refresh: a revoked refresh token signs the session out with TOKEN_EXPIRED', async () => {
  const fetchImpl = fakeAutodesk();
  const harness = makeApi({ fetchImpl });
  await signIn(harness);
  // Another sign-in elsewhere advanced the issuer, so this session's refresh token is stale.
  const other = makeApi({ fetchImpl });
  await signIn(other);
  harness.tick(3600 * 1000);
  const hubs = await harness.call('/api/aps/hubs');
  assert.equal(hubs.status, 401);
  assert.equal(hubs.json.error.code, 'TOKEN_EXPIRED');
  assert.equal((await harness.call('/api/aps/status')).json.authenticated, false);
});

test('viewer token: refreshed down to viewables:read, cached, rotating the refresh token, never the data token', async () => {
  const harness = makeApi();
  assert.equal((await harness.call('/api/aps/viewer-token')).json.error.code, 'NOT_AUTHENTICATED');
  await signIn(harness);
  const first = await harness.call('/api/aps/viewer-token');
  assert.equal(first.status, 200);
  assert.equal(first.json.access_token, 'viewer-2');
  assert.equal(first.json.scope, 'viewables:read');
  assert.equal(first.json.expires_in, 3600);
  assert.ok(!/access-|refresh-|super-secret/.test(first.body), 'neither the data token nor the refresh token is handed out');
  const grant = harness.fetchImpl.calls.filter(call => call.url.endsWith('/token')).at(-1);
  assert.equal(new URLSearchParams(grant.init.body).get('scope'), 'viewables:read');
  assert.equal((await harness.call('/api/aps/viewer-token')).json.access_token, 'viewer-2', 'reused while valid');
  // The data token still works, and its next refresh uses the refresh token the viewer grant rotated.
  assert.equal((await harness.call('/api/aps/hubs')).status, 200);
  harness.tick(3600 * 1000);
  assert.equal((await harness.call('/api/aps/hubs')).status, 200);
  const last = harness.fetchImpl.calls.filter(call => call.url.endsWith('/token')).at(-1);
  assert.equal(new URLSearchParams(last.init.body).get('refresh_token'), 'refresh-2');
  assert.equal(new URLSearchParams(last.init.body).get('scope'), 'data:read viewables:read');
  assert.equal((await harness.call('/api/aps/viewer-token')).json.access_token, 'viewer-4', 'expired viewer token is replaced');
});

test('viewer token: a sign-in without viewables:read asks for a new sign-in; concurrent requests serialize', async () => {
  const narrow = makeApi({ autodesk: { scope: 'data:read' } });
  await signIn(narrow);
  const refused = await narrow.call('/api/aps/viewer-token');
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code, 'MISSING_SCOPE');
  assert.match(refused.json.error.hint, /Sign in again/);
  assert.equal((await narrow.call('/api/aps/hubs')).status, 200, 'the data session is unaffected');

  const busy = makeApi();
  await signIn(busy);
  busy.tick(3600 * 1000);
  const results = await Promise.all([busy.call('/api/aps/viewer-token'), busy.call('/api/aps/hubs'), busy.call('/api/aps/viewer-token')]);
  assert.deepEqual(results.map(r => r.status), [200, 200, 200], 'no refresh used a revoked refresh token');
});

test('files are cached per session for five minutes; ?refresh=1 re-reads, at most every 30 s', async () => {
  const harness = makeApi();
  await signIn(harness);
  await harness.call('/api/aps/files');
  const reads = () => harness.fetchImpl.calls.filter(call => call.url.includes('/topFolders')).length;
  assert.equal(reads(), 1);
  const again = await harness.call('/api/aps/files');
  assert.equal(again.status, 200);
  assert.equal(reads(), 1);
  // A refresh right after a read reuses it (the IFC screen checks every minute; ACC is not hammered).
  await harness.call('/api/aps/files?refresh=1');
  assert.equal(reads(), 1);
  harness.tick(30 * 1000);
  await harness.call('/api/aps/files?refresh=1');
  assert.equal(reads(), 2);
});

test('a 401 from the data API is retried once with a refreshed token', async () => {
  const base = fakeAutodesk();
  let reject = false;
  const flaky = async (url, init) => {
    if (reject && String(url).endsWith('/project/v1/hubs')) { reject = false; return { ok: false, status: 401, text: async () => '{}' }; }
    return base(url, init);
  };
  const harness = makeApi({ fetchImpl: flaky });
  await signIn(harness);
  reject = true;
  const hubs = await harness.call('/api/aps/hubs');
  assert.equal(hubs.status, 200);
  assert.ok(base.calls.some(call => call.url.endsWith('/token') && new URLSearchParams(call.init.body).get('grant_type') === 'refresh_token'));
});

test('hub discovery marks the hub holding the Seagirt project, following pagination', async () => {
  const harness = makeApi({ autodesk: { hubs: [{ id: 'b.hub1', name: 'Forma Hub' }] } });
  assert.equal((await harness.call('/api/aps/hubs')).json.error.code, 'NOT_AUTHENTICATED');
  await signIn(harness);
  const hubs = (await harness.call('/api/aps/hubs')).json;
  assert.equal(hubs.targetHubId, 'b.hub1');
  assert.deepEqual(hubs.targetProject, { id: 'b.proj1', name: 'Seagirt Electrical Digital Twin POC' });
  assert.equal(hubs.hubs[0].containsTargetProject, true);
  assert.equal(hubs.hubs[0].projectCount, 2);
  assert.ok(harness.fetchImpl.calls.some(call => call.url.includes('page%5Bnumber%5D=1')), 'the next page was read');
  const projects = (await harness.call('/api/aps/projects?hubId=b.hub1&name=seagirt')).json.projects;
  assert.deepEqual(projects.map(project => project.id), ['b.proj1']);
});

test('missing permissions: no hubs, a refused hub, a missing scope', async () => {
  const empty = makeApi({ autodesk: { hubs: [] } });
  await signIn(empty);
  const none = await empty.call('/api/aps/hubs');
  assert.equal(none.status, 403);
  assert.equal(none.json.error.code, 'HUB_INACCESSIBLE');
  assert.match(none.json.error.hint, /Custom Integration/);

  const refused = makeApi({ autodesk: { projectsStatus: 403 } });
  await signIn(refused);
  const hubs = (await refused.call('/api/aps/hubs')).json;
  assert.equal(hubs.hubs[0].accessible, false);
  assert.equal(hubs.hubs[0].error.code, 'HUB_INACCESSIBLE');
  const files = await refused.call('/api/aps/files');
  assert.equal(files.status, 403);
  assert.equal(files.json.error.code, 'HUB_INACCESSIBLE');

  const narrow = makeApi({ autodesk: { scope: 'user-profile:read' } });
  await signIn(narrow);
  const scoped = await narrow.call('/api/aps/hubs');
  assert.equal(scoped.status, 403);
  assert.equal(scoped.json.error.code, 'MISSING_SCOPE');
});

test('files: both IFC items found recursively with folder ids, versions and derivatives, sanitized', async () => {
  const harness = makeApi();
  await signIn(harness);
  const response = await harness.call('/api/aps/files');
  assert.equal(response.status, 200);
  const payload = response.json;
  assert.deepEqual(payload.hub, { id: 'b.hub1', name: 'Forma Hub', region: 'US' });
  assert.equal(payload.project.id, 'b.proj1');
  assert.deepEqual(payload.topFolders, [{ id: 'urn:folder:pf', name: 'Project Files' }]);
  assert.deepEqual(payload.missing, []);
  const network = payload.files.find(file => file.fileName === 'seagirt_power_network.ifc');
  assert.equal(network.itemId, 'urn:item:net');
  assert.equal(network.folderId, 'urn:folder:ifc');
  assert.deepEqual(network.folderPath.map(folder => folder.name), ['Project Files', 'IFC']);
  assert.equal(network.tipVersionId, 'urn:v:net?version=2');
  assert.deepEqual(network.versions.map(version => version.id), ['urn:v:net?version=2', 'urn:v:net?version=1']);
  assert.equal(network.derivative.urn, 'urn-urn:v:net?version=2');
  assert.equal(network.derivative.manifest.status, 'success');
  assert.ok(payload.files.some(file => file.itemId === 'urn:item:disp'), 'name match ignores case');
  assert.ok(!/access-|refresh-|super-secret|secret-location|Bearer/.test(response.body), 'no token, secret or storage location');
});

test('files: a missing IFC answers FILES_MISSING with what was found', async () => {
  const harness = makeApi({ autodesk: { omitDisplay: true } });
  await signIn(harness);
  const response = await harness.call('/api/aps/files');
  assert.equal(response.status, 404);
  assert.equal(response.json.error.code, 'FILES_MISSING');
  assert.deepEqual(response.json.missing, ['seagirt_power_network_display.ifc']);
  assert.equal(response.json.files.length, 1);
});

test('project not found answers PROJECT_NOT_FOUND', async () => {
  const harness = makeApi({ env: { ...env, APS_TARGET_PROJECT_NAME: 'Nope' } });
  await signIn(harness);
  const response = await harness.call('/api/aps/files');
  assert.equal(response.status, 404);
  assert.equal(response.json.error.code, 'PROJECT_NOT_FOUND');
});

test('the session cookie reaches every route that uses the sign-in, not only /api/aps', async () => {
  const harness = makeApi();
  await signIn(harness);
  const login = await harness.call('/api/aps/login');
  const path = /Path=([^;]+)/.exec(login.headers['set-cookie'][0])[1];
  for (const route of ['/api/aps/status', '/api/ifc-spatial/models', '/api/ifc-spatial/cache/x/model.glb']) {
    assert.ok(route === path || route.startsWith(`${path}/`), `${route} is under the cookie path ${path}`);
  }
});

test('the IFC Spatial routes accept the session signed in through /api/aps (same cookie, same instance)', async () => {
  const harness = makeApi();
  await signIn(harness);
  const spatial = createIfcSpatialApi({ aps: harness.api, cacheDir: mkdtempSync(join(tmpdir(), 'aps-spatial-')), logger: quiet });
  const call = async cookie => {
    let status, body = '';
    await spatial.handle({ url: '/api/ifc-spatial/models', method: 'GET', headers: { host: 'localhost:5188', ...(cookie ? { cookie } : {}) } },
      { writeHead(code) { status = code; }, end(value) { body = value ?? ''; } });
    return { status, json: JSON.parse(body) };
  };
  const signedIn = await call(harness.cookie);
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.json.project.name, 'Seagirt Electrical Digital Twin POC');
  assert.deepEqual(signedIn.json.models.map(model => model.status), ['not_converted', 'not_converted']);
  assert.equal((await call(null)).json.error.code, 'NOT_AUTHENTICATED');
});

test('a browser holding an old /api/aps cookie and a new /api cookie is still recognised', async () => {
  const harness = makeApi();
  await signIn(harness);
  const live = harness.cookie;
  harness.cookie = `aps_sid=stale-id-from-the-old-path; ${live}`;
  assert.equal((await harness.call('/api/aps/status')).json.authenticated, true);
  harness.cookie = `${live}; aps_sid=stale-id-from-the-old-path`;
  assert.equal((await harness.call('/api/aps/status')).json.authenticated, true);
});

test('logout forgets the session; non-GET is refused; no CORS header is sent', async () => {
  const harness = makeApi();
  await signIn(harness);
  const status = await harness.call('/api/aps/status');
  assert.equal(status.headers['access-control-allow-origin'], undefined);
  assert.equal(status.headers['cache-control'], 'no-store');
  await harness.call('/api/aps/logout');
  assert.equal((await harness.call('/api/aps/status')).json.authenticated, false);
  let code;
  await harness.api.handle({ url: '/api/aps/login', method: 'POST', headers: {} }, { writeHead(c) { code = c; }, end() {} });
  assert.equal(code, 405);
});

test('encrypted session store survives a restart and holds no plaintext token', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'aps-store-')), 'sessions.enc');
  const key = 'a'.repeat(64);
  const store = createEncryptedFileStore({ path, key, logger: quiet });
  store.set('sid', { tokens: { accessToken: 'plain-access', refreshToken: 'plain-refresh' } });
  assert.ok(!readFileSync(path).toString('latin1').includes('plain-'));
  assert.equal(createEncryptedFileStore({ path, key, logger: quiet }).get('sid').tokens.refreshToken, 'plain-refresh');
  assert.equal(createEncryptedFileStore({ path, key: 'b'.repeat(64), logger: quiet }).get('sid'), null, 'a wrong key reads nothing');
  assert.throws(() => createEncryptedFileStore({ path, key: 'short', logger: quiet }), /32 bytes/);
});
