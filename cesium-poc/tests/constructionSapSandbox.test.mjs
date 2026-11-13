/**
 * Phase 7A — the SAP sandbox connection.
 *
 * Every test here uses an INJECTED fetch. The one real call against
 * `https://sandbox.api.sap.com` is a manual verification reported in the phase notes, not part of
 * the suite: a unit test that needs the internet, a shared sandbox tenant and a live credential is
 * a test that fails on a train and tells you nothing when it does.
 *
 * What is worth testing is everything around that call — the three states, the parsing, the
 * allowlist, the `top` validation and, above all, that the key cannot get out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONNECTION, FAILURE, LIMITS, createSapSandboxAdapter, odataDate, parseTop, redacted,
  resolveBaseUrl, sanitizeRecord,
} from '../server/construction/sapSandbox.mjs';
import {
  ALLOWED_HOSTS, ENTITY_PATH, S4HANA_PROJECT_DATA, SERVICE,
} from '../server/construction/sapSandboxConfig.mjs';
import { INTERFACES, createMockSapAdapter } from '../server/construction/adapters.mjs';
import { BASE, createConstructionApi } from '../server/construction/api.mjs';
import {
  SANDBOX_API, SANDBOX_FAILURE, SANDBOX_STATE, dateOnly, statusWord,
} from '../src/construction/sapSandboxPanel.js';
import { readFile, readdir } from 'node:fs/promises';

/** Read once: three tests assert on what the panel's source does and does not contain. */
const panelSource = await readFile(new URL('../src/construction/sapSandboxPanel.js',
  import.meta.url), 'utf8');

const KEY = 'test-key-never-logged-0001';
const quiet = { warn() {}, error() {}, log() {} };

/** One record, shaped exactly as the sandbox returns one (trimmed to the fields we read). */
const SANDBOX_RECORD = Object.freeze({
  __metadata: { uri: 'https://sandbox.api.sap.com/SFPublicSectorManagement_Odata/'
    + "ProjectControllingObject(effectiveStartDate=datetime'2017-04-13T00:00:00',externalCode='P9999')",
  type: 'SFOData.ProjectControllingObject' },
  externalCode: 'P9999',
  name_defaultValue: 'Tower A controlling object',
  description_defaultValue: 'string',
  name_en_US: 'Tower A controlling object',
  name_ko_KR: null,
  projectControllingObjectType: null,
  company: null,
  effectiveStatus: 'I',
  effectiveStartDate: '/Date(1492041600000)/',
  effectiveEndDate: '/Date(253402214400000)/',
  isStatistical: true,
  lastModifiedDateTime: '/Date(1760663353000+0000)/',
  createdBy: 'sfadmin',
  lastModifiedBy: 'sfadmin',
  entityUUID: '9A371733E3E54740BDE0FD83FA368B24',
  nameTranslationTextNav: { __deferred: { uri: 'https://sandbox.api.sap.com/…' } },
});

/** A fetch that answers once, and records what it was asked. */
function stubFetch({ status = 200, body = { d: { results: [SANDBOX_RECORD] } }, text = null,
  throws = null } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (throws) throw throws;
    const payload = text ?? JSON.stringify(body);
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: new Map(),
      body: null,
      text: async () => payload,
    };
  };
  impl.calls = calls;
  return impl;
}

const adapterWith = (fetchImpl, env = {}) => createSapSandboxAdapter({
  fetchImpl, logger: quiet,
  env: { SAP_SANDBOX_API_KEY: KEY, SAP_SANDBOX_BASE_URL: 'https://sandbox.api.sap.com', ...env },
});

/* ── the three states ──────────────────────────────────────────────────────────────────────── */

test('a 200 with d.results is CONNECTED and carries the parsed records', async () => {
  const report = await adapterWith(stubFetch()).fetchProjectControllingObjects({ top: 5 });
  assert.equal(report.state, CONNECTION.CONNECTED);
  assert.equal(report.failure, null);
  assert.equal(report.httpStatus, 200);
  assert.equal(report.recordCount, 1);
  assert.equal(report.records[0].externalCode, 'P9999');
  assert.ok(report.lastSuccessAt, 'a successful call records when it happened');
});

test('a missing key is NOT_CONFIGURED, and is never reported as a connection failure', async () => {
  const fetchImpl = stubFetch();
  const report = await adapterWith(fetchImpl, { SAP_SANDBOX_API_KEY: '' })
    .fetchProjectControllingObjects();
  assert.equal(report.state, CONNECTION.NOT_CONFIGURED);
  assert.equal(report.failure, null, 'not configured is not a failure kind');
  assert.equal(report.httpStatus, null);
  assert.match(report.reason, /SAP_SANDBOX_API_KEY is not set/);
  assert.equal(fetchImpl.calls.length, 0, 'and no request is made without a key');
});

test('a key of only whitespace counts as not configured', async () => {
  const report = await adapterWith(stubFetch(), { SAP_SANDBOX_API_KEY: '   ' })
    .fetchProjectControllingObjects();
  assert.equal(report.state, CONNECTION.NOT_CONFIGURED);
});

test('401 is FAILED/AUTH and says to check the key, without quoting it', async () => {
  const report = await adapterWith(stubFetch({ status: 401,
    text: JSON.stringify({ fault: { faultstring: 'Invalid ApiKey',
      detail: { errorcode: 'oauth.v2.InvalidApiKey' } } }) })).fetchProjectControllingObjects();
  assert.equal(report.state, CONNECTION.FAILED);
  assert.equal(report.failure, FAILURE.AUTH);
  assert.equal(report.httpStatus, 401);
  assert.match(report.reason, /Invalid ApiKey/);
  assert.match(report.reason, /oauth\.v2\.InvalidApiKey/);
  assert.match(report.reason, /SAP_SANDBOX_API_KEY/);
  assert.ok(!report.reason.includes(KEY));
});

test('403 is also an auth failure; 500 is not', async () => {
  const forbidden = await adapterWith(stubFetch({ status: 403, text: '{}' }))
    .fetchProjectControllingObjects();
  assert.equal(forbidden.failure, FAILURE.AUTH);
  const broken = await adapterWith(stubFetch({ status: 500, text: 'upstream exploded' }))
    .fetchProjectControllingObjects();
  assert.equal(broken.failure, FAILURE.HTTP);
  assert.match(broken.reason, /HTTP 500/);
});

test('a timeout is reported as a timeout, not as a network failure', async () => {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  const report = await adapterWith(stubFetch({ throws: error })).fetchProjectControllingObjects();
  assert.equal(report.state, CONNECTION.FAILED);
  assert.equal(report.failure, FAILURE.TIMEOUT);
  assert.match(report.reason, /No response within \d+ ms/);
});

test('a network error does not throw out of the adapter', async () => {
  const report = await adapterWith(stubFetch({ throws: new TypeError('fetch failed') }))
    .fetchProjectControllingObjects();
  assert.equal(report.state, CONNECTION.FAILED);
  assert.equal(report.failure, FAILURE.NETWORK);
  assert.match(report.reason, /could not be reached/);
});

test('200 with a body that is not JSON is an invalid response, not a connection', async () => {
  const report = await adapterWith(stubFetch({ text: '<html>gateway</html>' }))
    .fetchProjectControllingObjects();
  assert.equal(report.state, CONNECTION.FAILED);
  assert.equal(report.failure, FAILURE.INVALID_RESPONSE);
});

test('200 with JSON but no d.results is an invalid response', async () => {
  const report = await adapterWith(stubFetch({ body: { d: { other: [] } } }))
    .fetchProjectControllingObjects();
  assert.equal(report.failure, FAILURE.INVALID_RESPONSE);
  assert.match(report.reason, /d\.results/);
});

test('an empty collection is CONNECTED with zero records', async () => {
  const report = await adapterWith(stubFetch({ body: { d: { results: [] } } }))
    .fetchProjectControllingObjects();
  assert.equal(report.state, CONNECTION.CONNECTED);
  assert.equal(report.recordCount, 0);
});

/* ── the credential ────────────────────────────────────────────────────────────────────────── */

test('the key travels in a header and never in the URL', async () => {
  const fetchImpl = stubFetch();
  await adapterWith(fetchImpl).fetchProjectControllingObjects({ top: 3 });
  const [call] = fetchImpl.calls;
  assert.ok(!call.url.includes(KEY), 'not in the query string');
  assert.equal(call.init.headers.APIKey, KEY);
  assert.deepEqual(Object.keys(call.init.headers).sort(), ['APIKey', 'Accept']);
});

test('no reported state contains the key anywhere in its payload', async () => {
  const cases = [
    stubFetch(),
    stubFetch({ status: 401, text: '{"fault":{"faultstring":"Invalid ApiKey"}}' }),
    stubFetch({ throws: new TypeError('fetch failed') }),
    stubFetch({ text: 'not json' }),
  ];
  for (const fetchImpl of cases) {
    const report = await adapterWith(fetchImpl).fetchProjectControllingObjects();
    assert.ok(redacted(report, KEY), `the key leaked in a ${report.state}/${report.failure} report`);
  }
});

test('an upstream body that echoes the key is discarded rather than returned', async () => {
  // Contrived — the sandbox does not do this — but it is the failure that would matter most.
  const body = { d: { results: [{ ...SANDBOX_RECORD, externalCode: KEY }] } };
  const report = await adapterWith(stubFetch({ body })).fetchProjectControllingObjects();
  assert.equal(report.state, CONNECTION.FAILED);
  assert.equal(report.failure, FAILURE.INVALID_RESPONSE);
  assert.match(report.reason, /echoed the API key/);
  assert.ok(redacted(report, KEY));
});

test('describe() reports whether the key is configured, never the key', () => {
  const described = adapterWith(stubFetch()).describe();
  assert.equal(described.configured, true);
  assert.ok(redacted(described, KEY));
  assert.equal(adapterWith(stubFetch(), { SAP_SANDBOX_API_KEY: '' }).describe().configured, false);
});

test('the key is read on every call, so adding it does not need a new adapter', async () => {
  const env = { SAP_SANDBOX_API_KEY: '', SAP_SANDBOX_BASE_URL: 'https://sandbox.api.sap.com' };
  const adapter = createSapSandboxAdapter({ fetchImpl: stubFetch(), logger: quiet, env });
  assert.equal((await adapter.fetchProjectControllingObjects()).state, CONNECTION.NOT_CONFIGURED);
  env.SAP_SANDBOX_API_KEY = KEY;
  assert.equal((await adapter.fetchProjectControllingObjects()).state, CONNECTION.CONNECTED);
});

test('nothing is logged that could carry the credential', async () => {
  const lines = [];
  const logger = { warn: (...args) => lines.push(args.join(' ')),
    error: (...args) => lines.push(args.join(' ')), log: () => {} };
  const env = { SAP_SANDBOX_API_KEY: KEY, SAP_SANDBOX_BASE_URL: 'https://sandbox.api.sap.com' };
  // The real 401 body, verbatim — SAP's own fault string contains the words "Invalid ApiKey",
  // and quoting the upstream reason is the point of the log line. What must never appear is the
  // VALUE, or the header as it was sent.
  const unauthorized = '{"fault":{"faultstring":"Invalid ApiKey",'
    + '"detail":{"errorcode":"oauth.v2.InvalidApiKey"}}}';
  for (const fetchImpl of [stubFetch({ status: 401, text: unauthorized }),
    stubFetch({ throws: new TypeError('fetch failed') }), stubFetch({ text: 'nope' })]) {
    await createSapSandboxAdapter({ fetchImpl, logger, env }).fetchProjectControllingObjects();
  }
  assert.ok(lines.length > 0, 'failures are logged');
  for (const line of lines) {
    assert.ok(!line.includes(KEY), `the key appeared in a log line: ${line}`);
    assert.ok(!/APIKey\s*[:=]\s*\S/.test(line), `a log line prints the auth header: ${line}`);
  }
  // And the upstream reason IS kept, because a 401 with no reason is an unactionable log line.
  assert.ok(lines.some(line => line.includes('Invalid ApiKey')));
});

/* ── the allowlist and the fixed path ──────────────────────────────────────────────────────── */

test('the URL is built from the module constants, not from anything a caller passed', async () => {
  const fetchImpl = stubFetch();
  await adapterWith(fetchImpl).fetchProjectControllingObjects({ top: 7 });
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.hostname, ALLOWED_HOSTS[0]);
  assert.equal(url.pathname, ENTITY_PATH);
  assert.equal(url.searchParams.get('$top'), '7');
});

test('a base URL off the allowlist is refused before any request is made', async () => {
  for (const base of ['https://evil.example.com', 'https://sandbox.api.sap.com.evil.test',
    'http://sandbox.api.sap.com', 'not-a-url']) {
    const fetchImpl = stubFetch();
    const report = await adapterWith(fetchImpl, { SAP_SANDBOX_BASE_URL: base })
      .fetchProjectControllingObjects();
    assert.equal(report.failure, FAILURE.CONFIG, `${base} was not refused`);
    assert.equal(fetchImpl.calls.length, 0, `${base} was contacted`);
  }
});

test('an empty base URL falls back to the sandbox default', () => {
  const resolved = resolveBaseUrl('');
  assert.deepEqual(resolved, { ok: true, baseUrl: 'https://sandbox.api.sap.com' });
});

test('a base URL with a path is reduced to its origin', () => {
  assert.equal(resolveBaseUrl('https://sandbox.api.sap.com/some/other/service').baseUrl,
    'https://sandbox.api.sap.com');
});

test('redirects are refused, so the key cannot be forwarded to another host', async () => {
  const fetchImpl = stubFetch();
  await adapterWith(fetchImpl).fetchProjectControllingObjects();
  assert.equal(fetchImpl.calls[0].init.redirect, 'error');
});

/* ── top validation ────────────────────────────────────────────────────────────────────────── */

test('top accepts only whole numbers in range', () => {
  assert.equal(parseTop(undefined), LIMITS.defaultTop);
  assert.equal(parseTop(''), LIMITS.defaultTop);
  assert.equal(parseTop('1'), 1);
  assert.equal(parseTop(String(LIMITS.maxTop)), LIMITS.maxTop);
  for (const bad of ['0', '-1', '26', '999', '1e3', '2.5', 'abc', '5; DROP TABLE', ' 5 x',
    '٥', '+5', '0x5']) {
    assert.equal(parseTop(bad), null, `${bad} was accepted`);
  }
});

/* ── parsing ───────────────────────────────────────────────────────────────────────────────── */

test('OData dates become ISO, and an unreadable one becomes null rather than a guess', () => {
  assert.equal(odataDate('/Date(1492041600000)/'), '2017-04-13T00:00:00.000Z');
  assert.equal(odataDate('/Date(1760663353000+0000)/'), '2025-10-17T01:09:13.000Z');
  assert.equal(odataDate('/Date(-86400000)/'), '1969-12-31T00:00:00.000Z');
  for (const bad of [null, undefined, '', '2017-04-13', '/Date()/', '/Date(abc)/', 42, {}]) {
    assert.equal(odataDate(bad), null);
  }
});

test('sanitizing keeps the allowlisted fields and drops everything else', () => {
  const record = sanitizeRecord(SANDBOX_RECORD);
  assert.deepEqual(Object.keys(record).sort(), [
    'company', 'description', 'effectiveEndDate', 'effectiveStartDate', 'effectiveStatus',
    'externalCode', 'isStatistical', 'lastModifiedDateTime', 'name', 'objectType',
  ]);
  assert.equal(record.externalCode, 'P9999');
  assert.equal(record.name, 'Tower A controlling object');
  assert.equal(record.effectiveStatus, 'I');
  assert.equal(record.effectiveStartDate, '2017-04-13T00:00:00.000Z');
  assert.equal(record.isStatistical, true);
});

test('sanitizing drops the service URI, the tenant UUID and the account names', () => {
  const record = sanitizeRecord(SANDBOX_RECORD);
  const text = JSON.stringify(record);
  assert.ok(!text.includes('__metadata'));
  assert.ok(!text.includes('__deferred'));
  assert.ok(!text.includes('9A371733E3E54740BDE0FD83FA368B24'));
  assert.ok(!text.includes('sfadmin'));
});

test('a localised name is used only when the default is absent', () => {
  assert.equal(sanitizeRecord({ name_en_US: 'Fallback' }).name, 'Fallback');
  assert.equal(sanitizeRecord({ name_defaultValue: 'Primary', name_en_US: 'Fallback' }).name,
    'Primary');
  assert.equal(sanitizeRecord({}).name, null);
});

test('an empty string is reported as absent rather than as a value', () => {
  const record = sanitizeRecord({ externalCode: '', effectiveStatus: '' });
  assert.equal(record.externalCode, null);
  assert.equal(record.effectiveStatus, null);
});

test('a non-object record is dropped, not half-parsed', () => {
  for (const bad of [null, undefined, 'x', 42]) assert.equal(sanitizeRecord(bad), null);
});

test('records that cannot be read are counted, so a drop is visible', async () => {
  const body = { d: { results: [SANDBOX_RECORD, null, 'nonsense'] } };
  const report = await adapterWith(stubFetch({ body })).fetchProjectControllingObjects();
  assert.equal(report.receivedCount, 3);
  assert.equal(report.recordCount, 1);
});

/* ── INT-04 is untouched ───────────────────────────────────────────────────────────────────── */

test('the sandbox adapter belongs to no pilot interface', () => {
  const adapter = adapterWith(stubFetch());
  assert.equal(adapter.interfaceId, null);
  assert.equal(adapter.origin, 'SANDBOX');
  // Not an inbound adapter: no fetch(), so the sync engine has nothing to call even if it were
  // handed one. This is what keeps a "Run Demo Sync" from reaching the internet.
  assert.equal(typeof adapter.fetch, 'undefined');
});

test('INT-04 still describes itself as the mock SAP source', () => {
  const int04 = INTERFACES.find(entry => entry.id === 'INT-04');
  assert.equal(int04.from, 'SAP');
  assert.equal(int04.to, 'SYNCHRO');
  assert.match(int04.control, /SAP stays the only cost ledger/);
  // The mock adapter's own words, unchanged by this phase.
  const described = createMockSapAdapter({ prepare: () => ({ all: () => [] }) }).describe();
  assert.equal(described.origin, 'MOCK');
  assert.match(described.note, /src_sap_\* tables/);
});

test('the service description refuses the S/4HANA reading in its own words', () => {
  assert.match(SERVICE.service, /SuccessFactors/);
  assert.match(SERVICE.notS4hana, /Not S\/4HANA Project System data/);
  assert.match(SERVICE.scope, /Connectivity only/);
  assert.equal(S4HANA_PROJECT_DATA.connected, false);
  assert.match(S4HANA_PROJECT_DATA.label, /Not Connected/);
  assert.match(S4HANA_PROJECT_DATA.detail, /src_sap_\* tables/);
});

test('testConnection asks for the smallest page it can', async () => {
  const fetchImpl = stubFetch();
  await adapterWith(fetchImpl).testConnection();
  assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('$top'), '1');
});

/* ── the two endpoints ─────────────────────────────────────────────────────────────────────── */

/**
 * Drive `handle` directly.
 *
 * The existing construction tests call the modules; these two routes are worth testing at the
 * route because the status code, the 400 and the fact that they answer without a database are all
 * route-level decisions.
 */
function harness({ fetchImpl = stubFetch(), env, path = ':memory:' } = {}) {
  const api = createConstructionApi({ path, logger: quiet,
    sandboxOptions: { fetchImpl, logger: quiet,
      env: { SAP_SANDBOX_API_KEY: KEY, SAP_SANDBOX_BASE_URL: 'https://sandbox.api.sap.com',
        ...env } } });
  const get = route => new Promise((resolve, reject) => {
    const res = {
      writeHead(status) { this.statusCode = status; },
      end(text) {
        try { resolve({ status: this.statusCode, body: JSON.parse(text) }); } catch (e) { reject(e); }
      },
    };
    api.handle({ url: `${BASE}${route}`, method: 'GET', on() {} }, res).then(handled => {
      if (!handled) reject(new Error(`${route} was not handled`));
    }, reject);
  });
  return { api, get, fetchImpl };
}

test('GET /sap-sandbox/health reports the real connection state, not a fixed success', async () => {
  const connected = harness();
  const ok = await connected.get('/sap-sandbox/health');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.state, CONNECTION.CONNECTED);
  assert.equal(ok.body.httpStatus, 200);
  connected.api.close();

  const broken = harness({ fetchImpl: stubFetch({ status: 401, text: '{}' }) });
  const failed = await broken.get('/sap-sandbox/health');
  // Still HTTP 200 from US: the state is the finding this endpoint delivers.
  assert.equal(failed.status, 200);
  assert.equal(failed.body.state, CONNECTION.FAILED);
  assert.equal(failed.body.failure, FAILURE.AUTH);
  broken.api.close();

  const unset = harness({ env: { SAP_SANDBOX_API_KEY: '' } });
  const missing = await unset.get('/sap-sandbox/health');
  assert.equal(missing.body.state, CONNECTION.NOT_CONFIGURED);
  unset.api.close();
});

test('the health probe reads one record, not a page of them', async () => {
  const { api, get, fetchImpl } = harness();
  await get('/sap-sandbox/health');
  assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('$top'), '1');
  api.close();
});

test('GET /sap-sandbox/project-controlling-objects returns the parsed records', async () => {
  const { api, get } = harness();
  const { status, body } = await get('/sap-sandbox/project-controlling-objects?top=5');
  assert.equal(status, 200);
  assert.equal(body.state, CONNECTION.CONNECTED);
  assert.equal(body.recordCount, 1);
  assert.equal(body.records[0].externalCode, 'P9999');
  api.close();
});

test('every response states that S/4HANA project data is not connected', async () => {
  for (const options of [{}, { env: { SAP_SANDBOX_API_KEY: '' } },
    { fetchImpl: stubFetch({ status: 401, text: '{}' }) }]) {
    const { api, get } = harness(options);
    for (const route of ['/sap-sandbox/health', '/sap-sandbox/project-controlling-objects']) {
      const { body } = await get(route);
      assert.equal(body.s4hanaProjectData.connected, false);
      assert.match(body.s4hanaProjectData.label, /Not Connected/);
    }
    api.close();
  }
});

test('an out-of-range top is a 400, never clamped to something that looks like a result', async () => {
  const { api, get, fetchImpl } = harness();
  for (const bad of ['0', '26', '1000', 'abc', '-1', '2.5']) {
    const { status, body } = await get(`/sap-sandbox/project-controlling-objects?top=${bad}`);
    assert.equal(status, 400, `top=${bad} was not refused`);
    assert.match(body.error, /whole number from 1 to/);
  }
  assert.equal(fetchImpl.calls.length, 0, 'and SAP is never called for a refused request');
  api.close();
});

test('top is optional and defaults rather than failing', async () => {
  const { api, get, fetchImpl } = harness();
  const { status, body } = await get('/sap-sandbox/project-controlling-objects');
  assert.equal(status, 200);
  assert.equal(body.top, LIMITS.defaultTop);
  assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('$top'), String(LIMITS.defaultTop));
  api.close();
});

test('no endpoint response contains the API key', async () => {
  for (const options of [{}, { env: { SAP_SANDBOX_API_KEY: '' } },
    { fetchImpl: stubFetch({ status: 401, text: '{"fault":{"faultstring":"Invalid ApiKey"}}' }) },
    { fetchImpl: stubFetch({ throws: new TypeError('fetch failed') }) }]) {
    const { api, get } = harness(options);
    const { body } = await get('/sap-sandbox/project-controlling-objects?top=2');
    assert.ok(redacted(body, KEY), `the key reached the browser in a ${body.state} response`);
    api.close();
  }
});

test('lastSuccessAt stays at the last success and is not reset by a later failure', async () => {
  // One api instance, two different upstream answers. `fetchImpl` is resolved per call by the
  // stub, so the second harness would lose the first's memory — hence a switchable stub.
  let mode = 'ok';
  const fetchImpl = async (url, init) => {
    const inner = mode === 'ok' ? stubFetch() : stubFetch({ status: 401, text: '{}' });
    return inner(url, init);
  };
  const { api, get } = harness({ fetchImpl });
  const first = await get('/sap-sandbox/project-controlling-objects');
  assert.equal(first.body.state, CONNECTION.CONNECTED);
  assert.ok(first.body.lastSuccessAt);
  mode = 'bad';
  const second = await get('/sap-sandbox/project-controlling-objects');
  assert.equal(second.body.state, CONNECTION.FAILED);
  assert.equal(second.body.lastSuccessAt, first.body.lastSuccessAt,
    'a failure must not erase when the connection last worked');
  api.close();
});

test('the sandbox routes answer even when the SQLite database cannot be opened', async () => {
  // The one real integration shares no state with the rest of the project, so a host that cannot
  // open the database should still be able to prove the SAP connection works.
  const { api, get } = harness({ path: '/nonexistent-directory-7a/construction.sqlite' });
  const { status, body } = await get('/sap-sandbox/health');
  assert.equal(status, 200);
  assert.equal(body.state, CONNECTION.CONNECTED);
  // While every database-backed route reports the database as unavailable.
  const overview = await get('/overview');
  assert.equal(overview.status, 503);
  api.close();
});

test('running a demo sync never reaches the SAP sandbox', async () => {
  const { api, fetchImpl } = harness();
  const post = route => new Promise((resolve, reject) => {
    const res = { writeHead(s) { this.statusCode = s; },
      end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }); } };
    const req = { url: `${BASE}${route}`, method: 'POST',
      on(event, handler) { if (event === 'end') handler(); return this; } };
    api.handle(req, res).then(handled => { if (!handled) reject(new Error('not handled')); }, reject);
  });
  const { status, body } = await post('/sync');
  assert.equal(status, 200);
  assert.ok(body.runs.length > 0, 'the sync ran');
  assert.equal(fetchImpl.calls.length, 0,
    'Run Demo Sync must stay entirely local — no interface may reach the internet');
  api.close();
});

/* ── the panel's own vocabulary ────────────────────────────────────────────────────────────── */

test('the panel names all three states distinctly, and leans the right way on each', () => {
  assert.deepEqual(Object.keys(SANDBOX_STATE).sort(),
    ['CONNECTED', 'FAILED', 'NOT_CONFIGURED']);
  assert.equal(SANDBOX_STATE.NOT_CONFIGURED.label, 'Not configured');
  assert.equal(SANDBOX_STATE.CONNECTED.label, 'Connected');
  assert.equal(SANDBOX_STATE.FAILED.label, 'Connection failed');
  // "Not configured" is not a failure, so it does not wear the failure tone.
  assert.equal(SANDBOX_STATE.NOT_CONFIGURED.tone, 'warn');
  assert.equal(SANDBOX_STATE.CONNECTED.tone, 'ok');
  assert.equal(SANDBOX_STATE.FAILED.tone, 'bad');
  // Every state the adapter can report has a word in the panel.
  for (const state of Object.values(CONNECTION)) assert.ok(SANDBOX_STATE[state], state);
  for (const failure of Object.values(FAILURE)) assert.ok(SANDBOX_FAILURE[failure], failure);
});

test('an effective-status code is spelled out, and an absent one says so', () => {
  assert.equal(statusWord('A'), 'Active (A)');
  assert.equal(statusWord('I'), 'Inactive (I)');
  assert.equal(statusWord(null), 'Not recorded');
  assert.equal(statusWord(''), 'Not recorded');
  // An unknown code is shown rather than guessed at.
  assert.equal(statusWord('X'), 'X');
});

test('a date is formatted, a sentinel is named and an absent one is not invented', () => {
  assert.match(dateOnly('2017-04-13T00:00:00.000Z'), /2017/);
  assert.equal(dateOnly('9999-12-31T00:00:00.000Z'), 'No end date');
  assert.equal(dateOnly(null), 'Not recorded');
  assert.equal(dateOnly('not a date'), 'Not recorded');
});

test('the panel asks the server for its records, and names no host or path of its own', async () => {
  const source = panelSource;
  assert.ok(!/sandbox\.api\.sap\.com/.test(source),
    'the panel must not name the SAP host — the server owns the endpoint');
  assert.ok(!/SFPublicSectorManagement/.test(source), 'nor the service path');
  assert.ok(!/APIKey/i.test(source), 'nor the auth header');
  // The path is composed from SANDBOX_API, so check the exported constant and the route it is
  // joined to rather than a literal that the source never spells out in one piece.
  assert.equal(SANDBOX_API, '/sap-sandbox');
  assert.match(source, /\$\{SANDBOX_API\}\/project-controlling-objects/);
});

test('no frontend file reads the API key', async () => {
  const dir = new URL('../src/construction/', import.meta.url);
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.js')) continue;
    const source = await readFile(new URL(name, dir), 'utf8');
    assert.ok(!/SAP_SANDBOX_API_KEY/.test(source), `${name} names the server-side key`);
    assert.ok(!/VITE_SAP/.test(source), `${name} reads a VITE_ SAP variable, which would ship it`);
  }
});

test('an unreachable construction API is not reported as SAP being unreachable', () => {
  // Our own server being down tells us nothing about SAP, and saying "the sandbox could not be
  // reached" would blame SAP for it. Found by looking at a screenshot of exactly this state.
  assert.ok(SANDBOX_FAILURE.API_UNREACHABLE);
  assert.match(SANDBOX_FAILURE.API_UNREACHABLE, /construction API/);
  assert.match(SANDBOX_FAILURE.API_UNREACHABLE, /unknown/);
  assert.ok(!/sandbox could not be reached/i.test(SANDBOX_FAILURE.API_UNREACHABLE));
  // And it is the kind the panel raises there, not the server's NETWORK.
  assert.match(panelSource, /failure: 'API_UNREACHABLE'/);
  assert.ok(!/failure: 'NETWORK'/.test(panelSource),
    'the panel must not borrow the server’s NETWORK kind for its own fetch failure');
});

/* ── Phase 7B: the banner, and what did not change ─────────────────────────────────────────── */

test('the standing banner is gone, and every figure is still labelled where it sits', async () => {
  /*
   * The banner was removed at the user's request (Phase 9E). What it asserted has to remain
   * true somewhere a reader will see it, so this test moved from "the banner says X" to "no
   * screen shows an unlabelled figure": the provenance chips now carry the claim next to the
   * number it is about.
   */
  const shell = await readFile(new URL('../src/construction/constructionDemo.js',
    import.meta.url), 'utf8');
  assert.ok(!/ci-synthetic/.test(shell), 'the banner element is gone');
  // The old blanket denial must not come back in any form.
  assert.ok(!/No P6, ACC, SAP or SYNCHRO 4D system is connected/i.test(shell));

  const dir = new URL('../src/construction/', import.meta.url);
  const timeline = await readFile(new URL('bimTimeline.js', dir), 'utf8');
  assert.match(timeline, /DESIGN, NOT CONSTRUCTION/,
    'model-evolution figures still say they are not construction');

  const tabs = await readFile(new URL('constructionProgressTabs.js', dir), 'utf8');
  assert.match(tabs, /REAL — Speckle Cloud/);
  assert.match(tabs, /SYNTHETIC/);

  const schedule = await readFile(new URL('openProjectSchedule.js', dir), 'utf8');
  // The standing panel was removed too; the per-ROW labels in the comparison table remain, which
  // is where a live figure and a synthetic one actually sit next to each other.
  assert.match(schedule, /SYNTHETIC<\/span>\s*\n?\s*\$\{escape\(comparison\.synthetic\.system\)/,
    'the comparison table still names each side');
  assert.match(schedule, /Not a finding/,
    'and still says why the difference between them is not a measurement');
});

test('Phase 7B changed no adapter, no schema and no write path', async () => {
  const dir = new URL('../server/construction/', import.meta.url);
  // Discovery is documentation. If any of these grew a live SAP call, the phase overstepped.
  for (const name of ['adapters.mjs', 'sync.mjs', 'outbound.mjs', 'destinations.mjs', 'db.mjs']) {
    const source = await readFile(new URL(name, dir), 'utf8');
    assert.ok(!/sandbox\.api\.sap\.com/.test(source),
      `${name} now names the SAP sandbox host — INT-04/INT-05 must stay local`);
    assert.ok(!/s4hanacloud/.test(source), `${name} now names an S/4HANA service path`);
  }
  // And the sandbox adapter itself is untouched by this phase: still one entity, still no
  // interface, still GET-only.
  const adapter = await readFile(new URL('sapSandbox.mjs', dir), 'utf8');
  assert.match(adapter, /interfaceId: null/);
  assert.ok(!/method: '(POST|PUT|PATCH|DELETE)'/.test(adapter));
});

test('the discovery report labels every capability and never implies an untested one', async () => {
  const report = await readFile(new URL('../docs/sap-s4hana-api-discovery.md', import.meta.url),
    'utf8');
  for (const label of ['**LIVE**', '**DOC**', '**TENANT**', '**NONE**']) {
    assert.ok(report.includes(label), `the report never uses ${label}`);
  }
  // The two conclusions this phase exists to deliver.
  const body = report.replace(/\s+/g, ' ');
  assert.match(body, /Earned value cannot be posted to SAP through any API/);
  assert.match(body, /no budget, no planned cost, no actual cost/);
  // A 403 must never be presented as proof that an API does not exist.
  // The report is hard-wrapped, so collapse whitespace before matching a sentence.
  const flat = report.replace(/\s+/g, ' ');
  assert.match(flat, /It does \*\*not\*\* prove the API does not exist/);
});
