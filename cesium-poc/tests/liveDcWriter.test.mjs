/**
 * The guarded DataConnect writer: only resolved Live classes, only Incremental loads (plus a
 * confirmed reset), never a historical class by name, ObjectId or numeric classId, and never a
 * token in a log line. Writes go through the load service (/v1/loads register -> upload json-file ->
 * process -> poll), never purge-all or load groups. Every case runs against a fake fetch, except the
 * redirect case, which needs Node's real fetch and uses two loopback servers.
 */
import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DcWriterError, WRITER_ERRORS, loadDcWriterConfig, missingWriterConfig, formClassId,
  assertWritable, assertLoadServiceRequest, createStaticTokenProvider, createClientCredentialsTokenProvider, createDcWriter,
} from '../server/liveDc/dcWriter.mjs';
import { LIVE_CLASS_NAMES } from '../server/liveDc/classes.mjs';

const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const fail = (status, body) => ({
  ok: false, status,
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const [EVENTS, TICKETS, TASKS] = LIVE_CLASS_NAMES;
const ASSETS = { id: '6a3bdcf6a4e4185131480658', classId: 8, className: 'Florida I595 Assets' };
const TASKS_HIST = { id: '6a3d0b69a4e418513148067f', classId: 11, className: 'Florida I595 Tasks' };
const WO_HIST = { id: '6a3d0c2da4e418513148068f', classId: 13, className: 'Florida I595 Work Orders' };
const liveId = i => 'a0'.repeat(11) + String(i + 1).padStart(2, '0');
const LIVE_ID = Object.fromEntries(LIVE_CLASS_NAMES.map((name, i) => [name, liveId(i)]));

const core = ['keyInSource', 'code', 'name', 'description']
  .map(name => ({ name, displayName: name, type: 'String', mandatory: true, core: true, array: false }));
const attr = (name, type = 'String', extra = {}) => ({ name, displayName: name, type, mandatory: false, core: false, array: false, ...extra });

function classDto(className, id, classId, extras = []) {
  return {
    id, classId, className, classType: 'DATA_CLASS', status: 'Published', geometryAttributeName: 'geometry',
    attributes: [...core, attr('geometry', 'Geospatial'), ...extras],
  };
}

function defaultClasses() {
  const extras = {
    [EVENTS]: [attr('status'), attr('latitude', 'Decimal'), attr('reported_at', 'DateTime')],
    [TICKETS]: [attr('Ticket Status')],
    [TASKS]: [attr('Task Status'), attr('Related Ticket ID', 'String', {
      relatedClassId: LIVE_ID[TICKETS], relatedAttributeName: 'code', relationshipType: 'SDNA_Live_Ticket_Tasks',
    })],
  };
  return [
    classDto(ASSETS.className, ASSETS.id, ASSETS.classId, [attr('asset category')]),
    classDto(TASKS_HIST.className, TASKS_HIST.id, TASKS_HIST.classId),
    ...LIVE_CLASS_NAMES.map((name, i) => classDto(name, LIVE_ID[name], 101 + i, extras[name] ?? [attr('status')])),
  ];
}

const LOCAL = 'http://127.0.0.1:5190';
const LOCAL_LOAD = 'http://127.0.0.1:5191';
const REMOTE = 'https://dc.example';
const REMOTE_LOAD = 'https://dc-load.example';
const TEST_TOKEN = 'test-token';
/** Tests inject their own targets and token: there is no default host and no loopback special case. */
const TEST_ENV = Object.freeze({ DC_WRITER_BASE_URL: LOCAL, DC_WRITER_LOAD_BASE_URL: LOCAL_LOAD, DC_WRITER_ACCESS_TOKEN: TEST_TOKEN });
const empty = status => ({ ok: true, status, json: async () => { throw new SyntaxError('no body'); }, text: async () => '' });

/**
 * A scripted DataConnect: the data-management class list, raw-data-process and curated-data-process
 * lists (ascending, mixed with other loads) and paged curated data, plus the load service, whose
 * GET /v1/loads/{id} walks `statuses`; on Finished the raw process and the curation for that load appear.
 */
function createFakeDc({
  classes = defaultClasses(), statuses = ['Pending', 'Running', 'Finished'], curation = true, rawStats = true,
  curated = {}, totalCount = null, registerResponse = null, uploadResponse = null, processResponse = null,
  loadIdFor = n => `load-${n}`, tokenResponses = null, unauthorizedOnce = false, maxPageSize = Infinity,
  rawProcessResponse = null,
} = {}) {
  const calls = [];
  const raw = new Map();
  const cur = new Map();
  const loads = new Map();
  let n = 0;
  let rejected = !unauthorizedOnce;
  const tokenQueue = tokenResponses ? [...tokenResponses] : null;
  for (const c of classes) {
    raw.set(c.id, [{ id: `rp-old-${c.classId}`, loadId: `old-${c.classId}`, loadType: 'Incremental', status: 'Finished', stats: { new: 999 } }]);
    cur.set(c.id, [
      { id: 'c1', curationType: 'CLASS_UPDATE', loadId: null, status: 'Finished' },
      { id: 'c2', curationType: 'RAW_DATA_LOAD', loadId: `old-${c.classId}`, status: 'Finished' },
      { id: 'c3', curationType: 'DEPENDENCY_UPDATED', loadId: null, status: 'Finished' },
    ]);
  }
  const fetchImpl = async (url, options = {}) => {
    const u = new URL(url);
    const method = options.method ?? 'GET';
    const call = { url, origin: u.origin, method, path: u.pathname, search: u.search, headers: options.headers ?? {}, body: options.body };
    calls.push(call);
    if (u.pathname === '/connect/token') {
      call.form = Object.fromEntries(new URLSearchParams(String(options.body)));
      await new Promise(r => setTimeout(r, 5));
      return tokenQueue ? tokenQueue.shift() : ok({ access_token: `tok-${calls.length}`, expires_in: 3600 });
    }
    if (!rejected) { rejected = true; return fail(401, { title: 'Unauthorized' }); }
    if (u.pathname === '/api/data-mgmt/v1/class') return ok(classes);
    let m = u.pathname.match(/^\/api\/data-mgmt\/v1\/class\/([^/]+)\/(raw-data-process|curated-data-process|curated-data)$/);
    if (m) {
      const [, id, kind] = m;
      if (kind === 'raw-data-process') return rawProcessResponse?.() ?? ok(raw.get(id) ?? []);
      if (kind === 'curated-data-process') return ok(cur.get(id) ?? []);
      const body = JSON.parse(options.body);
      call.json = body;
      const items = curated[id] ?? [];
      const size = Math.min(body.pageSize, maxPageSize);
      const page = items.slice(body.page * size, (body.page + 1) * size);
      return ok({ data: page, totalCount: totalCount ?? items.length });
    }
    if (u.pathname === '/v1/loads' && method === 'POST') {
      call.json = JSON.parse(options.body);
      const target = classes.find(c => `CL${String(c.classId).padStart(6, '0')}` === call.json.classId);
      n += 1;
      const load = {
        id: loadIdFor(n), classId: call.json.classId, loadType: call.json.loadType, status: 'Init', createdBy: 'svc',
        createdOn: 't', lastUpdated: 't', payloadIds: [], log: [{ loadEvent: 'Registered', status: 'Finished', time: 't' }],
      };
      loads.set(load.id, { load, target, i: -1, processed: false });
      return registerResponse?.(load) ?? ok(load);
    }
    m = u.pathname.match(/^\/v1\/loads\/([^/]+)(?:\/(upload\/json-file|process))?$/);
    if (m) {
      const entry = loads.get(decodeURIComponent(m[1]));
      if (!entry) return fail(404, { detail: 'No load found for provided id' });
      if (m[2] === 'upload/json-file' && method === 'POST') {
        call.json = JSON.parse(options.body);
        entry.load.payloadIds.push(`p-${entry.load.payloadIds.length}`);
        return uploadResponse?.() ?? empty(200);
      }
      if (m[2] === 'process' && method === 'POST') {
        entry.processed = true;
        return processResponse?.() ?? empty(202);
      }
      if (!m[2] && method === 'GET') {
        if (entry.processed) {
          entry.i = Math.min(entry.i + 1, statuses.length - 1);
          entry.load.status = statuses[entry.i];
          entry.load.log.push({ loadEvent: 'Loading', status: entry.load.status, time: 't' });
          if (TERMINAL.has(entry.load.status) && !entry.done) {
            entry.done = true;
            const id = entry.target.id;
            raw.get(id).push({
              id: `rp-${entry.load.id}`, loadId: entry.load.id, loadType: entry.load.loadType, status: entry.load.status,
              ...(rawStats ? { stats: { new: 2, updated: 0, notChanged: 0, invalidRecords: 0, duplicateRecords: 0, deleted: 0, notFound: 0 } } : {}),
            });
            raw.get(id).push({ id: 'rp-later', loadId: 'someone-else', loadType: 'Incremental', status: 'Finished', stats: { new: 777 } });
            if (entry.load.status === 'Finished' && curation) {
              cur.get(id).push({ id: `c-${entry.load.id}`, curationType: 'RAW_DATA_LOAD', loadId: entry.load.id, loadType: entry.load.loadType, status: 'Finished' });
              cur.get(id).push({ id: `d-${entry.load.id}`, curationType: 'DEPENDENCY_UPDATED', loadId: null, status: 'Finished' });
            }
          }
        }
        return ok(structuredClone(entry.load));
      }
    }
    return fail(404, { detail: `no route ${method} ${u.pathname}` });
  };
  return { fetchImpl, calls, raw, cur, loads };
}
const TERMINAL = new Set(['Finished', 'Failed']);
const loadCalls = dc => dc.calls.filter(c => c.path.startsWith('/v1/loads'));
const polls = dc => dc.calls.filter(c => c.method === 'GET' && /^\/v1\/loads\/[^/]+$/.test(c.path));

function captureLogger() {
  const lines = [];
  const push = level => (...args) => lines.push({ level, text: args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') });
  return { lines, logger: { info: push('info'), log: push('log'), warn: push('warn'), error: push('error') } };
}

function fakeClock() {
  const clock = { t: 1_000_000 };
  return { now: () => clock.t, sleep: async ms => { clock.t += ms; }, clock };
}

function makeWriter(dc, { baseUrl = LOCAL, config = {}, tokenProvider, loggerOverride } = {}) {
  const { now, sleep } = fakeClock();
  const log = captureLogger();
  const writer = createDcWriter({
    config: { ...loadDcWriterConfig({ ...TEST_ENV, DC_WRITER_BASE_URL: baseUrl }), pollIntervalMs: 100, processTimeoutMs: 5000, curationTimeoutMs: 2000, ...config },
    fetchImpl: dc.fetchImpl, tokenProvider, now, sleep, logger: loggerOverride ?? log.logger,
  });
  return { writer, log };
}

const record = (key, extra = {}) => ({ keyInSource: key, code: key, name: key, description: 'd', ...extra });
const rejectsCode = (promise, code) => assert.rejects(promise, err => {
  assert.ok(err instanceof DcWriterError, `expected DcWriterError, got ${err}`);
  assert.equal(err.code, code, err.message);
  return true;
});
const throwsCode = (fn, code) => assert.throws(fn, err => {
  assert.ok(err instanceof DcWriterError);
  assert.equal(err.code, code, err.message);
  return true;
});

// ---- config ----

test('config defaults, env overrides and trailing-slash stripping', () => {
  const d = loadDcWriterConfig({});
  assert.equal(d.baseUrl, '', 'no default target: DataConnect is the only one and must be configured');
  assert.equal(d.loadBaseUrl, '', 'no default load service either');
  assert.equal(d.dataMgmtPrefix, '/api/data-mgmt/v1');
  assert.equal('loadsPath' in d, false, 'the WAF-blocked /api/loads/class gateway path is gone');
  assert.equal(d.accessToken, '');
  assert.equal(d.accessTokenFile, '');
  assert.equal(d.tokenUrl, 'https://ims.bentley.com/connect/token');
  assert.equal(d.scope, 'itwin-platform');
  assert.equal(d.timeoutMs, 30000);
  assert.equal(d.pollIntervalMs, 1000);
  assert.equal(d.processTimeoutMs, 120000);
  assert.equal(d.curationTimeoutMs, 120000);
  assert.equal(d.pageSize, 500);
  assert.equal('allowRemote' in d, false);
  assert.equal('local' in d, false);

  const e = loadDcWriterConfig({
    DC_WRITER_BASE_URL: 'https://dc.example//', DC_WRITER_LOAD_BASE_URL: 'https://dc-load.example/', DC_WRITER_PAGE_SIZE: '50', DC_WRITER_ACCESS_TOKEN_FILE: '/tmp/token',
    DC_WRITER_TIMEOUT_MS: '-3', DC_WRITER_POLL_INTERVAL_MS: 'abc', DC_WRITER_CLIENT_ID: 'svc', DC_WRITER_SCOPE: 's',
  });
  assert.equal(e.baseUrl, 'https://dc.example');
  assert.equal(e.loadBaseUrl, 'https://dc-load.example');
  assert.equal(e.accessTokenFile, '/tmp/token');
  assert.equal(e.pageSize, 50);
  assert.equal(e.timeoutMs, 30000);
  assert.equal(e.pollIntervalMs, 1000);
  assert.equal(e.clientId, 'svc');
  assert.equal(e.scope, 's');
});

test('missingWriterConfig: both base URLs and a token, token file or client are always needed, loopback included', () => {
  const CREDENTIALS = 'DC_WRITER_ACCESS_TOKEN, DC_WRITER_ACCESS_TOKEN_FILE or DC_WRITER_CLIENT_ID+DC_WRITER_CLIENT_SECRET';
  assert.deepEqual(missingWriterConfig(loadDcWriterConfig({})), ['DC_WRITER_BASE_URL', 'DC_WRITER_LOAD_BASE_URL', CREDENTIALS]);
  assert.deepEqual(missingWriterConfig(loadDcWriterConfig({ DC_WRITER_BASE_URL: LOCAL })), ['DC_WRITER_LOAD_BASE_URL', CREDENTIALS]);
  assert.deepEqual(missingWriterConfig(loadDcWriterConfig({ ...TEST_ENV, DC_WRITER_LOAD_BASE_URL: '' })), ['DC_WRITER_LOAD_BASE_URL']);
  assert.deepEqual(missingWriterConfig(loadDcWriterConfig(TEST_ENV)), []);
  const remote = loadDcWriterConfig({ DC_WRITER_BASE_URL: REMOTE, DC_WRITER_LOAD_BASE_URL: REMOTE_LOAD });
  assert.deepEqual(missingWriterConfig(remote), [CREDENTIALS]);
  assert.deepEqual(missingWriterConfig({ ...remote, clientId: 'x' }), [CREDENTIALS]);
  assert.deepEqual(missingWriterConfig({ ...remote, clientId: 'x', clientSecret: 'y' }), []);
  assert.deepEqual(missingWriterConfig({ ...remote, accessToken: 't' }), []);
  assert.deepEqual(missingWriterConfig({ ...remote, accessTokenFile: '/tmp/t' }), []);
});

test('the writer config copy masks secrets', () => {
  const dc = createFakeDc();
  const writer = createDcWriter({
    config: { ...loadDcWriterConfig({ DC_WRITER_BASE_URL: REMOTE, DC_WRITER_LOAD_BASE_URL: REMOTE_LOAD }), accessToken: 'real-token', clientSecret: 'shh' },
    fetchImpl: dc.fetchImpl, logger: captureLogger().logger,
  });
  assert.equal(writer.config.accessToken, '***');
  assert.equal(writer.config.clientSecret, '***');
  assert.ok(!JSON.stringify(writer.config).includes('real-token'));
});

test('a writer without a base URL is not_configured before any request', () => {
  let calls = 0;
  throwsCode(() => createDcWriter({
    config: loadDcWriterConfig({ DC_WRITER_ACCESS_TOKEN: TEST_TOKEN }), fetchImpl: async () => { calls++; return ok({}); },
  }), WRITER_ERRORS.NOT_CONFIGURED);
  assert.equal(calls, 0);
});

test('a loopback host without credentials is not_configured too: no stand-in dev token', () => {
  throwsCode(() => createDcWriter({ config: loadDcWriterConfig({ DC_WRITER_BASE_URL: LOCAL, DC_WRITER_LOAD_BASE_URL: LOCAL_LOAD }), fetchImpl: async () => ok({}) }),
    WRITER_ERRORS.NOT_CONFIGURED);
});

test('a remote host without credentials is not_configured', () => {
  throwsCode(() => createDcWriter({ config: loadDcWriterConfig({ DC_WRITER_BASE_URL: REMOTE, DC_WRITER_LOAD_BASE_URL: REMOTE_LOAD }), fetchImpl: async () => ok({}) }),
    WRITER_ERRORS.NOT_CONFIGURED);
});

test('a writer without a load-service URL, or with one that is not a plain http(s) origin, is not_configured', () => {
  for (const loadBaseUrl of ['', 'not a url', 'ftp://dc-load.example', 'https://user:pw@dc-load.example', 'https://dc-load.example/?x=1', 'https://dc-load.example/#f']) {
    let calls = 0;
    throwsCode(() => createDcWriter({
      config: { ...loadDcWriterConfig(TEST_ENV), loadBaseUrl }, fetchImpl: async () => { calls++; return ok({}); },
    }), WRITER_ERRORS.NOT_CONFIGURED);
    assert.equal(calls, 0, loadBaseUrl);
  }
});

test('the data-management prefix must be an absolute path so it cannot change the request authority', () => {
  for (const env of [
    { DC_WRITER_DATA_MGMT_PREFIX: '@evil.example/api/data-mgmt/v1' },
    { DC_WRITER_DATA_MGMT_PREFIX: 'api/data-mgmt/v1' },
    { DC_WRITER_DATA_MGMT_PREFIX: '/api@evil.example/v1' },
  ]) {
    throwsCode(() => loadDcWriterConfig(env), WRITER_ERRORS.NOT_CONFIGURED);
  }
  assert.equal(loadDcWriterConfig({ DC_WRITER_DATA_MGMT_PREFIX: '/api/v1' }).dataMgmtPrefix, '/api/v1');
});

test('a config with a spoofing prefix is refused before any request, locally and remotely', async () => {
  for (const [baseUrl, extra] of [[LOCAL, { accessToken: TEST_TOKEN }], [REMOTE, { accessToken: 'real-token' }]]) {
    for (const bad of [{ dataMgmtPrefix: '@evil.example/api/data-mgmt/v1' }]) {
      const dc = createFakeDc();
      throwsCode(() => createDcWriter({
        config: { ...loadDcWriterConfig({ DC_WRITER_BASE_URL: baseUrl, DC_WRITER_LOAD_BASE_URL: LOCAL_LOAD }), ...extra, ...bad },
        fetchImpl: dc.fetchImpl, logger: captureLogger().logger,
      }), WRITER_ERRORS.NOT_CONFIGURED);
      assert.equal(dc.calls.length, 0);
    }
  }
});

test('formClassId pads the numeric classId', () => {
  assert.equal(formClassId({ classId: 13 }), 'CL000013');
  assert.equal(formClassId({ classId: 101 }), 'CL000101');
  assert.throws(() => formClassId({ classId: 0 }));
  assert.throws(() => formClassId({ classId: '13' }));
  assert.throws(() => formClassId({}));
  assert.throws(() => formClassId(null));
});

test('WRITER_ERRORS is frozen and complete', () => {
  assert.ok(Object.isFrozen(WRITER_ERRORS));
  assert.equal(WRITER_ERRORS.UNRESOLVED_CLASS, 'unresolved_class');
  assert.equal(Object.keys(WRITER_ERRORS).length, 15);
  assert.equal(WRITER_ERRORS.LOAD_PATH_REFUSED, 'load_path_refused');
  assert.equal('REMOTE_NOT_ALLOWED' in WRITER_ERRORS, false);
  const err = new DcWriterError('http_error', 'x', { status: 500, detail: 'd' });
  assert.equal(err.code, 'http_error');
  assert.equal(err.status, 500);
  assert.equal(err.detail, 'd');
  assert.ok(err instanceof Error);
});

// ---- pure guard ----

test('assertWritable: name, ObjectId, numeric classId, classType, load type — in that order', () => {
  const live = classDto(TASKS, LIVE_ID[TASKS], 103);
  assertWritable(live, 'Incremental');
  throwsCode(() => assertWritable(classDto(TASKS_HIST.className, TASKS_HIST.id, 11), 'Incremental'), WRITER_ERRORS.NOT_ALLOWLISTED);
  throwsCode(() => assertWritable({ ...live, className: TASKS.toLowerCase() }, 'Incremental'), WRITER_ERRORS.NOT_ALLOWLISTED);
  throwsCode(() => assertWritable(undefined, 'Incremental'), WRITER_ERRORS.NOT_ALLOWLISTED);
  throwsCode(() => assertWritable({ ...live, id: WO_HIST.id }, 'Incremental'), WRITER_ERRORS.HISTORICAL_CLASS);
  throwsCode(() => assertWritable({ ...live, classId: 11 }, 'Incremental'), WRITER_ERRORS.HISTORICAL_CLASS);
  throwsCode(() => assertWritable({ ...live, classId: 22 }, 'Full'), WRITER_ERRORS.HISTORICAL_CLASS);
  throwsCode(() => assertWritable({ ...live, classType: 'SPATIAL_CLASS' }, 'Incremental'), WRITER_ERRORS.NOT_ALLOWLISTED);
  throwsCode(() => assertWritable({ ...live, classId: '103' }, 'Incremental'), WRITER_ERRORS.NOT_ALLOWLISTED);
  throwsCode(() => assertWritable(live, 'Full'), WRITER_ERRORS.LOAD_TYPE_REFUSED);
  throwsCode(() => assertWritable(live, 'Deletion'), WRITER_ERRORS.LOAD_TYPE_REFUSED);
  throwsCode(() => assertWritable(live, 'incremental'), WRITER_ERRORS.LOAD_TYPE_REFUSED);
});

// ---- resolve ----

test('resolveLiveClasses returns frozen copies of the 6 Live classes', async () => {
  const dc = createFakeDc();
  const { writer } = makeWriter(dc);
  const map = await writer.resolveLiveClasses();
  assert.deepEqual([...map.keys()], LIVE_CLASS_NAMES);
  const tasks = map.get(TASKS);
  assert.ok(Object.isFrozen(tasks));
  assert.ok(Object.isFrozen(tasks.attributes));
  assert.ok(Object.isFrozen(tasks.attributes[0]));
  assert.equal(tasks.classId, 103);
  assert.equal(dc.calls.length, 1);
  assert.equal(dc.calls[0].headers.authorization, `Bearer ${TEST_TOKEN}`);
});

test('resolveLiveClasses lists every missing Live class', async () => {
  const classes = defaultClasses().filter(c => c.className !== TICKETS && c.className !== TASKS);
  const { writer } = makeWriter(createFakeDc({ classes }));
  await rejectsCode(writer.resolveLiveClasses(), WRITER_ERRORS.LIVE_CLASS_MISSING).then(() => {});
  await writer.resolveLiveClasses().catch(err => {
    assert.match(err.message, new RegExp(TICKETS));
    assert.match(err.message, new RegExp(TASKS));
  });
});

test('resolveLiveClasses refuses duplicate names, shared numeric classIds and historical classIds', async () => {
  const dup = defaultClasses();
  dup.push(classDto(TICKETS, 'b0'.repeat(12), 150));
  await rejectsCode(makeWriter(createFakeDc({ classes: dup })).writer.resolveLiveClasses(), WRITER_ERRORS.AMBIGUOUS_CLASS);

  const shared = defaultClasses();
  shared.push(classDto('Some Other Class', 'c0'.repeat(12), 102));
  await rejectsCode(makeWriter(createFakeDc({ classes: shared })).writer.resolveLiveClasses(), WRITER_ERRORS.AMBIGUOUS_CLASS);

  const hist = defaultClasses().map(c => (c.className === TASKS ? { ...c, classId: 13 } : c));
  await rejectsCode(makeWriter(createFakeDc({ classes: hist })).writer.resolveLiveClasses(), WRITER_ERRORS.HISTORICAL_CLASS);

  const sameId = defaultClasses().map(c => (c.className === TASKS ? { ...c, id: LIVE_ID[TICKETS] } : c));
  await rejectsCode(makeWriter(createFakeDc({ classes: sameId })).writer.resolveLiveClasses(), WRITER_ERRORS.AMBIGUOUS_CLASS);
});

test('resolveLiveClasses checks numeric classId uniqueness among data classes only', async () => {
  // classIds are numbered per class type (CL/TS/IC), so a Term Set or iModel class may reuse a Live number.
  const mixed = defaultClasses();
  mixed.push({ id: 'd0'.repeat(12), classId: 101, className: 'Some Term Set', classType: 'TERM_SET', attributes: [] });
  mixed.push({ id: 'e0'.repeat(12), classId: 102, className: 'Some iModel', classType: 'IMODEL', attributes: [] });
  const map = await makeWriter(createFakeDc({ classes: mixed })).writer.resolveLiveClasses();
  assert.equal(map.get(EVENTS).classId, 101);

  const untyped = defaultClasses();
  untyped.push({ id: 'f0'.repeat(12), classId: 101, className: 'Legacy Class', attributes: [] });
  await rejectsCode(makeWriter(createFakeDc({ classes: untyped })).writer.resolveLiveClasses(), WRITER_ERRORS.AMBIGUOUS_CLASS);
});

test('listClasses accepts {data} and {classes}; findClassByName is exact', async () => {
  for (const wrap of [list => ({ data: list }), list => ({ classes: list })]) {
    const list = defaultClasses();
    const fetchImpl = async () => ok(wrap(list));
    const writer = createDcWriter({ config: loadDcWriterConfig(TEST_ENV), fetchImpl });
    assert.equal((await writer.listClasses()).length, list.length);
    assert.equal((await writer.findClassByName(ASSETS.className)).id, ASSETS.id);
    await rejectsCode(writer.findClassByName('florida i595 assets'), WRITER_ERRORS.LIVE_CLASS_MISSING);
  }
  const dup = [...defaultClasses(), classDto(ASSETS.className, 'd0'.repeat(12), 99)];
  const writer = createDcWriter({ config: loadDcWriterConfig(TEST_ENV), fetchImpl: async () => ok(dup) });
  await rejectsCode(writer.findClassByName(ASSETS.className), WRITER_ERRORS.AMBIGUOUS_CLASS);
});

// ---- guards on loadRecords (no fetch) ----

test('loadRecords guards run before any HTTP', async () => {
  const dc = createFakeDc();
  const { writer } = makeWriter(dc);
  const map = await writer.resolveLiveClasses();
  const assets = await writer.findClassByName(ASSETS.className);
  const before = dc.calls.length;
  const tickets = map.get(TICKETS);
  await rejectsCode(writer.loadRecords(assets, [record('A1')]), WRITER_ERRORS.NOT_ALLOWLISTED);
  await rejectsCode(writer.loadRecords({ ...tickets, id: WO_HIST.id }, [record('T1')]), WRITER_ERRORS.HISTORICAL_CLASS);
  await rejectsCode(writer.loadRecords({ ...tickets, classId: 11 }, [record('T1')]), WRITER_ERRORS.HISTORICAL_CLASS);
  await rejectsCode(writer.loadRecords(tickets, [record('T1')], { loadType: 'Full' }), WRITER_ERRORS.LOAD_TYPE_REFUSED);
  await rejectsCode(writer.loadRecords(tickets, [record('T1')], { loadType: 'Deletion' }), WRITER_ERRORS.LOAD_TYPE_REFUSED);
  await rejectsCode(writer.loadRecords(structuredClone(tickets), [record('T1')]), WRITER_ERRORS.UNRESOLVED_CLASS);
  await rejectsCode(writer.loadRecords({ ...tickets }, []), WRITER_ERRORS.UNRESOLVED_CLASS);
  // A DTO resolved by a different writer is foreign here.
  const other = await makeWriter(createFakeDc()).writer.resolveLiveClasses();
  await rejectsCode(writer.loadRecords(other.get(TICKETS), [record('T1')]), WRITER_ERRORS.UNRESOLVED_CLASS);
  assert.equal(dc.calls.length, before);
});

test('record checks: keys, duplicates, unknown attributes, mandatory and relationships — no fetch', async () => {
  const dc = createFakeDc();
  const { writer } = makeWriter(dc);
  const map = await writer.resolveLiveClasses();
  const before = dc.calls.length;
  const tasks = map.get(TASKS);
  const task = key => record(key, { 'Related Ticket ID': 'TIC-1' });
  await rejectsCode(writer.loadRecords(tasks, [task('K1'), task('K2'), task('K1')]), WRITER_ERRORS.DUPLICATE_KEYS);
  await writer.loadRecords(tasks, [task('K1'), task('K1')]).catch(err => assert.match(err.message, /K1/));
  await rejectsCode(writer.loadRecords(tasks, [{ ...task('K1'), code: 'K2' }]), WRITER_ERRORS.INVALID_RECORD);
  await rejectsCode(writer.loadRecords(tasks, [{ ...task(''), code: '' }]), WRITER_ERRORS.INVALID_RECORD);
  await rejectsCode(writer.loadRecords(tasks, [null]), WRITER_ERRORS.INVALID_RECORD);
  await rejectsCode(writer.loadRecords(tasks, 'nope'), WRITER_ERRORS.INVALID_RECORD);
  await rejectsCode(writer.loadRecords(tasks, [task('K1'), { ...task('K2'), bogus: 1 }]), WRITER_ERRORS.UNKNOWN_ATTRIBUTE);
  const { description, ...noDescription } = task('K1');
  await rejectsCode(writer.loadRecords(tasks, [noDescription]), WRITER_ERRORS.INVALID_RECORD);
  await rejectsCode(writer.loadRecords(tasks, [record('K1')]), WRITER_ERRORS.INVALID_RECORD);
  await writer.loadRecords(tasks, [record('K1')]).catch(err => assert.match(err.message, /Related Ticket ID/));
  await rejectsCode(writer.loadRecords(map.get(EVENTS), [record('E1', { latitude: '26.1' })]), WRITER_ERRORS.INVALID_RECORD);
  await rejectsCode(writer.loadRecords(map.get(EVENTS), [record('E1', { reported_at: '2026-09-26T08:11:41.238Z' })]), WRITER_ERRORS.INVALID_RECORD);
  await writer.loadRecords(map.get(EVENTS), [record('E1', { reported_at: '2026-09-26T08:11:41.238Z' })])
    .catch(err => assert.match(err.message, /reported_at Type/));
  assert.equal(dc.calls.length, before);
});

test('empty records still run the guards, then skip without HTTP', async () => {
  const dc = createFakeDc();
  const { writer } = makeWriter(dc);
  const map = await writer.resolveLiveClasses();
  const before = dc.calls.length;
  const res = await writer.loadRecords(map.get(TICKETS), []);
  assert.deepEqual(res, { skipped: true, className: TICKETS, loadType: 'Incremental', count: 0, load: null, process: null, curation: null, stats: null });
  await rejectsCode(writer.loadRecords(map.get(TICKETS), [], { loadType: 'Full' }), WRITER_ERRORS.LOAD_TYPE_REFUSED);
  assert.equal(dc.calls.length, before);
});

// ---- remote ----

test('the configured DataConnect host may load with no extra opt-in: guards, not a flag, protect it', async () => {
  const dc = createFakeDc();
  const writer = createDcWriter({
    config: { ...loadDcWriterConfig({ DC_WRITER_BASE_URL: REMOTE, DC_WRITER_LOAD_BASE_URL: REMOTE_LOAD, DC_WRITER_ACCESS_TOKEN: 'remote-tok' }), pollIntervalMs: 10 },
    fetchImpl: dc.fetchImpl, logger: captureLogger().logger, ...fakeClock(),
  });
  const map = await writer.resolveLiveClasses();
  assert.equal(dc.calls[0].url, `${REMOTE}/api/data-mgmt/v1/class`);
  assert.equal(dc.calls[0].headers.authorization, 'Bearer remote-tok');
  const res = await writer.loadRecords(map.get(TICKETS), [record('T1')]);
  assert.equal(res.load.status, 'Finished');
  assert.ok(dc.calls.some(c => c.url === `${REMOTE_LOAD}/v1/loads`));
  assert.ok(loadCalls(dc).every(c => c.origin === REMOTE_LOAD), 'load-service calls go only to the load service');
  assert.ok(dc.calls.filter(c => c.path.startsWith('/api/')).every(c => c.origin === REMOTE), 'reads go only to data-mgmt');
  assert.ok(!dc.calls.some(c => c.path.startsWith('/api/loads')), 'never the WAF-blocked gateway path');
  const before = dc.calls.length;
  await rejectsCode(writer.loadRecords(map.get(TICKETS), [record('T2')], { loadType: 'Full' }), WRITER_ERRORS.LOAD_TYPE_REFUSED);
  const assets = await writer.findClassByName(ASSETS.className);
  await rejectsCode(writer.loadRecords(assets, [record('A1')]), WRITER_ERRORS.NOT_ALLOWLISTED);
  assert.equal(dc.calls.length, before + 1, 'only the class-list read went out');
});

test('env credentials are used as configured for a loopback host too: an explicit token beats the client', async () => {
  const dc = createFakeDc();
  const writer = createDcWriter({
    config: { ...loadDcWriterConfig({ DC_WRITER_BASE_URL: LOCAL, DC_WRITER_LOAD_BASE_URL: LOCAL_LOAD, DC_WRITER_CLIENT_ID: 'svc', DC_WRITER_CLIENT_SECRET: 'secret', DC_WRITER_ACCESS_TOKEN: 'env-tok' }), pollIntervalMs: 10 },
    fetchImpl: dc.fetchImpl, logger: captureLogger().logger, ...fakeClock(),
  });
  const map = await writer.resolveLiveClasses();
  await writer.loadRecords(map.get(TICKETS), [record('T1')]);
  assert.ok(!dc.calls.some(c => c.path === '/connect/token'));
  assert.ok(dc.calls.every(c => c.headers.authorization === 'Bearer env-tok'));
});

test('DC_WRITER_ACCESS_TOKEN_FILE is re-read on every request, so `npm run dc:login` needs no restart', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dc-writer-token-'));
  const file = join(dir, 'token');
  try {
    writeFileSync(file, 'first-token\n');
    const dc = createFakeDc();
    const log = captureLogger();
    const writer = createDcWriter({
      config: { ...loadDcWriterConfig({ DC_WRITER_BASE_URL: REMOTE, DC_WRITER_LOAD_BASE_URL: REMOTE_LOAD, DC_WRITER_ACCESS_TOKEN_FILE: file }), pollIntervalMs: 10 },
      fetchImpl: dc.fetchImpl, logger: log.logger, ...fakeClock(),
    });
    assert.equal(writer.config.accessTokenFile, file);
    await writer.listClasses();
    writeFileSync(file, 'second-token\n');
    const map = await writer.resolveLiveClasses();
    await writer.loadRecords(map.get(TICKETS), [record('T1')]);
    const seen = dc.calls.map(c => c.headers.authorization);
    assert.equal(seen[0], 'Bearer first-token');
    assert.ok(seen.slice(1).every(h => h === 'Bearer second-token'), seen.join(','));
    assert.doesNotMatch(JSON.stringify(log.lines), /first-token|second-token/);

    rmSync(file);
    await assert.rejects(writer.listClasses(), err => {
      assert.equal(err.code, WRITER_ERRORS.NOT_CONFIGURED, err.message);
      assert.doesNotMatch(err.message, /second-token/);
      return true;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- load protocol ----

const items = (n, prefix = 'K') => Array.from({ length: n }, (_, i) => ({
  id: String(i).padStart(24, '0'), keyInSource: `${prefix}${String(i).padStart(3, '0')}`, attributes: { code: `${prefix}${i}` }, valid: true,
}));

test('load service: register JSON, upload the JSON array, process, poll; only the Authorization header; no token in logs', async () => {
  const dc = createFakeDc();
  const { writer, log } = makeWriter(dc, { tokenProvider: createStaticTokenProvider('super-secret-token') });
  const map = await writer.resolveLiveClasses();
  const recs = [record('TIC-1', { 'Ticket Status': 'Open' }), record('TIC-2')];
  const res = await writer.loadRecords(map.get(TICKETS), recs);
  const calls = loadCalls(dc);
  assert.deepEqual(calls.slice(0, 3).map(c => `${c.method} ${c.url}`), [
    `POST ${LOCAL_LOAD}/v1/loads`, `POST ${LOCAL_LOAD}/v1/loads/load-1/upload/json-file`, `POST ${LOCAL_LOAD}/v1/loads/load-1/process`,
  ]);
  assert.ok(calls.slice(3).every(c => c.method === 'GET' && c.url === `${LOCAL_LOAD}/v1/loads/load-1`));
  assert.deepEqual(calls[0].json, { classId: 'CL000102', classType: 'DATA_CLASS', loadType: 'Incremental' });
  assert.deepEqual(calls[1].json, recs);
  assert.equal(calls[2].body, undefined);
  for (const c of calls) {
    assert.equal(c.headers.authorization, 'Bearer super-secret-token');
    assert.deepEqual(Object.keys(c.headers).sort(), c.body === undefined ? ['authorization'] : ['authorization', 'content-type']);
    if (c.body !== undefined) assert.equal(c.headers['content-type'], 'application/json');
  }
  assert.equal(res.skipped, false);
  assert.equal(res.count, 2);
  assert.equal(res.className, TICKETS);
  assert.equal(res.load.id, 'load-1');
  assert.equal(res.load.status, 'Finished');
  assert.equal(res.process.loadId, 'load-1');
  assert.equal(res.stats.new, 2);
  assert.equal(res.curation.status, 'Finished');
  assert.equal(res.curation.loadId, 'load-1');
  const text = log.lines.map(l => l.text).join('\n');
  assert.ok(!text.includes('super-secret-token'));
  assert.ok(!/authorization|bearer/i.test(text));
  const loadLines = log.lines.filter(l => l.text.startsWith('live-dc load'));
  assert.equal(loadLines.length, 1);
  assert.equal(loadLines[0].text, `live-dc load ${TICKETS} Incremental id=load-1 n=2 new=2 updated=0 notChanged=0 invalid=0 curation=Finished`);
});

test('polling walks Pending -> Deferred -> Running -> Finished on GET /v1/loads/{id}', async () => {
  const dc = createFakeDc({ statuses: ['Init', 'Pending', 'Pending', 'Deferred', 'Running', 'Finished'] });
  const { writer } = makeWriter(dc);
  const map = await writer.resolveLiveClasses();
  const res = await writer.loadRecords(map.get(TICKETS), [record('T1')]);
  assert.equal(res.load.status, 'Finished');
  assert.equal(polls(dc).length, 6);
  assert.ok(!dc.calls.some(c => c.search.includes('latest')), 'no latest-process guessing');
});

test('stats and curation are correlated by the load id, not by the latest process', async () => {
  const dc = createFakeDc();
  const { writer } = makeWriter(dc);
  const map = await writer.resolveLiveClasses();
  const res = await writer.loadRecords(map.get(TICKETS), [record('T1')]);
  assert.equal(res.process.id, 'rp-load-1', 'not rp-old-102 and not the later rp-later');
  assert.equal(res.stats.new, 2);
  assert.equal(res.curation.id, 'c-load-1');
});

test('stats are optional: a raw-data-process without the load, without stats or failing still gives a result', async () => {
  for (const options of [{ rawStats: false }, { rawProcessResponse: () => ok([]) }, { rawProcessResponse: () => fail(500, 'boom') }]) {
    const dc = createFakeDc(options);
    const { writer, log } = makeWriter(dc);
    const map = await writer.resolveLiveClasses();
    const res = await writer.loadRecords(map.get(TICKETS), [record('T1')]);
    assert.equal(res.load.status, 'Finished');
    assert.equal(res.stats, null);
    assert.equal(res.curation.status, 'Finished');
    assert.ok(log.lines.some(l => l.text === `live-dc load ${TICKETS} Incremental id=load-1 n=1 stats=n/a curation=Finished`), JSON.stringify(log.lines));
  }
});

test('a Failed load is load_failed with the load log in detail', async () => {
  const dc = createFakeDc({ statuses: ['Pending', 'Failed'] });
  const { writer } = makeWriter(dc);
  const map = await writer.resolveLiveClasses();
  await assert.rejects(writer.loadRecords(map.get(TICKETS), [record('T1')]), err => {
    assert.equal(err.code, WRITER_ERRORS.LOAD_FAILED);
    assert.match(err.message, /load-1/);
    assert.equal(JSON.parse(err.detail).at(-1).status, 'Failed');
    return true;
  });
});

test('a load that never finishes is process_timeout', async () => {
  const dc = createFakeDc({ statuses: ['Pending', 'Running'] });
  const { writer } = makeWriter(dc, { config: { processTimeoutMs: 1000, pollIntervalMs: 100 } });
  const map = await writer.resolveLiveClasses();
  await rejectsCode(writer.loadRecords(map.get(TICKETS), [record('T1')]), WRITER_ERRORS.PROCESS_TIMEOUT);
  const n = polls(dc).length;
  assert.ok(n >= 10 && n <= 13, `polls=${n}`);
});

test('findCurationForLoad scans an ascending mixed list without a latest param', async () => {
  const dc = createFakeDc();
  const { writer } = makeWriter(dc);
  const map = await writer.resolveLiveClasses();
  const tickets = map.get(TICKETS);
  const found = await writer.findCurationForLoad(tickets, 'old-102');
  assert.equal(found.id, 'c2');
  assert.equal(await writer.findCurationForLoad(tickets, 'nope'), null);
  assert.equal(await writer.findCurationForLoad(tickets, null), null);
  const res = await writer.loadRecords(tickets, [record('T1')]);
  assert.equal(res.curation.id, `c-${res.load.id}`);
  const curCalls = dc.calls.filter(c => c.path.endsWith('/curated-data-process'));
  assert.ok(curCalls.length > 0);
  assert.ok(curCalls.every(c => c.search === '' && c.origin === LOCAL));
});

test('findCurationForLoad and rawProcessForLoad accept {data}', async () => {
  const writer = createDcWriter({
    config: loadDcWriterConfig(TEST_ENV),
    fetchImpl: async () => ok({ data: [{ curationType: 'RAW_DATA_LOAD', loadId: 'L', status: 'Finished' }] }),
  });
  assert.equal((await writer.findCurationForLoad({ id: 'x' }, 'L')).loadId, 'L');
  assert.equal((await writer.rawProcessForLoad({ id: 'x' }, 'L')).loadId, 'L');
  assert.equal(await writer.rawProcessForLoad({ id: 'x' }, 'M'), null);
  assert.equal(await writer.rawProcessForLoad({ id: 'x' }, null), null);
});

test('a curation that never appears gives curation null plus a warn', async () => {
  const dc = createFakeDc({ curation: false });
  const { writer, log } = makeWriter(dc, { config: { curationTimeoutMs: 500, pollIntervalMs: 100 } });
  const map = await writer.resolveLiveClasses();
  const res = await writer.loadRecords(map.get(TICKETS), [record('T1')]);
  assert.equal(res.curation, null);
  assert.equal(res.load.status, 'Finished');
  assert.ok(log.lines.some(l => l.level === 'warn'));
  assert.ok(log.lines.some(l => l.text.endsWith('curation=timeout')));
});

test('waitForCuration:false skips curation polling', async () => {
  const dc = createFakeDc();
  const { writer } = makeWriter(dc);
  const map = await writer.resolveLiveClasses();
  const res = await writer.loadRecords(map.get(TICKETS), [record('T1')], { waitForCuration: false });
  assert.equal(res.curation, null);
  assert.ok(!dc.calls.some(c => c.path.endsWith('/curated-data-process')));
});

test('a non-2xx register, upload or process is http_error with the ProblemDetail detail or truncated text', async () => {
  const problem = createFakeDc({ registerResponse: () => fail(403, { title: 'Forbidden', status: 403, detail: 'no permission' }) });
  const w1 = makeWriter(problem).writer;
  const m1 = await w1.resolveLiveClasses();
  await assert.rejects(w1.loadRecords(m1.get(TICKETS), [record('T1')]), err => {
    assert.equal(err.code, WRITER_ERRORS.HTTP_ERROR);
    assert.equal(err.status, 403);
    assert.equal(err.detail, 'no permission');
    return true;
  });
  assert.equal(loadCalls(problem).length, 1, 'nothing uploaded after a refused register');
  const plain = createFakeDc({ uploadResponse: () => fail(500, 'x'.repeat(1000)) });
  const w2 = makeWriter(plain).writer;
  const m2 = await w2.resolveLiveClasses();
  await assert.rejects(w2.loadRecords(m2.get(TICKETS), [record('T1')]), err => {
    assert.equal(err.status, 500);
    assert.equal(err.detail.length, 300);
    return true;
  });
  assert.ok(!loadCalls(plain).some(c => c.path.endsWith('/process')), 'not processed after a failed upload');
  const proc = createFakeDc({ processResponse: () => fail(409, { detail: 'Load has already been processed' }) });
  const w3 = makeWriter(proc).writer;
  const m3 = await w3.resolveLiveClasses();
  await assert.rejects(w3.loadRecords(m3.get(TICKETS), [record('T1')]), err => err.status === 409);
});

// ---- load-service path guard ----

test('assertLoadServiceRequest allows only register, upload json-file, process and get of one load', () => {
  assertLoadServiceRequest('POST', '/v1/loads');
  assertLoadServiceRequest('POST', '/v1/loads/6a3d0c2da4e418513148068f/upload/json-file');
  assertLoadServiceRequest('POST', '/v1/loads/load-1/process');
  assertLoadServiceRequest('GET', '/v1/loads/load-1');
  for (const [method, path] of [
    ['POST', '/v1/loads/purge-all'], ['GET', '/v1/loads/purge-all'], ['POST', '/v1/loads/purge-all/process'],
    ['GET', '/v1/loads/groups'], ['POST', '/v1/loads/groups'], ['GET', '/v1/loads/groups/g1'], ['DELETE', '/v1/loads/groups/g1'],
    ['POST', '/v1/loads/groups/g1/process'], ['GET', '/v1/loads/groups/g1/loads'], ['DELETE', '/v1/loads/load-1'],
    ['GET', '/v1/loads'], ['PUT', '/v1/loads/load-1'], ['POST', '/v1/loads/load-1/upload/file'], ['POST', '/v1/loads/load-1'],
    ['GET', '/v1/loads/a%2Fb'], ['GET', '/v1/loads/..'], ['POST', '/api/loads/class'], ['GET', '/server/is-alive'],
  ]) {
    throwsCode(() => assertLoadServiceRequest(method, path), WRITER_ERRORS.LOAD_PATH_REFUSED);
  }
});

test('the load-service guard also covers a load service on its own origin and under a path prefix', async () => {
  const seen = [];
  const writer = createDcWriter({
    config: { ...loadDcWriterConfig({ ...TEST_ENV, DC_WRITER_LOAD_BASE_URL: 'https://dc-load.example/load' }) },
    fetchImpl: async (url, options) => { seen.push(`${options.method} ${url}`); return ok([]); }, logger: captureLogger().logger,
  });
  assert.deepEqual(await writer.listClasses(), []);
  assert.deepEqual(seen, [`GET ${LOCAL}/api/data-mgmt/v1/class`]);
});

test('a registered load id that would reach purge-all, groups or another path is refused before any further call', async () => {
  for (const id of ['purge-all', 'groups', 'PURGE-ALL', '../x', 'a/b', '', 'x?y', null]) {
    const dc = createFakeDc({ loadIdFor: () => id });
    const { writer } = makeWriter(dc);
    const map = await writer.resolveLiveClasses();
    await rejectsCode(writer.loadRecords(map.get(TICKETS), [record('T1')]), WRITER_ERRORS.LOAD_PATH_REFUSED);
    assert.equal(loadCalls(dc).length, 1, `only the register call for id ${JSON.stringify(id)}`);
  }
});

test('the writer exposes no purge, cancel or load-group operation and never calls one', async () => {
  const dc = createFakeDc({ curated: { [LIVE_ID[TICKETS]]: items(2, 'TIC-') } });
  const { writer } = makeWriter(dc);
  for (const name of Object.keys(writer)) assert.doesNotMatch(name, /purge|group|cancel|delete/i, name);
  const map = await writer.resolveLiveClasses();
  await writer.loadRecords(map.get(TICKETS), [record('T1')]);
  await writer.resetLiveClass(map.get(TICKETS), { confirm: TICKETS });
  assert.ok(dc.calls.every(c => !/purge|groups/i.test(c.path) && c.method !== 'DELETE'));
});

// ---- readAll ----


test('readAll pages until a short page and sends the sort, filters and includeDescendants=false', async () => {
  const dc = createFakeDc({ curated: { [LIVE_ID[EVENTS]]: items(5) } });
  const { writer } = makeWriter(dc);
  const map = await writer.resolveLiveClasses();
  const filters = [{ field: 'attributes.status', operator: 'equals', value: 'active' }];
  const all = await writer.readAll(map.get(EVENTS), { pageSize: 2, filters });
  assert.equal(all.length, 5);
  const reads = dc.calls.filter(c => c.path.endsWith('/curated-data'));
  assert.equal(reads.length, 3);
  assert.equal(reads[0].url, `${LOCAL}/api/data-mgmt/v1/class/${LIVE_ID[EVENTS]}/curated-data?includeDescendants=false`);
  assert.deepEqual(reads.map(r => r.json.page), [0, 1, 2]);
  assert.deepEqual(reads[0].json, { page: 0, pageSize: 2, filters, sort: { field: 'attributes.code', direction: 'asc' } });
  assert.equal(reads[0].headers['content-type'], 'application/json');
});

test('readAll stops at totalCount, on an empty page, and at maxPages; dedupes by keyInSource', async () => {
  const exact = createFakeDc({ curated: { [LIVE_ID[EVENTS]]: items(4) } });
  const w1 = makeWriter(exact).writer;
  const m1 = await w1.resolveLiveClasses();
  assert.equal((await w1.readAll(m1.get(EVENTS), { pageSize: 2 })).length, 4);
  assert.equal(exact.calls.filter(c => c.path.endsWith('/curated-data')).length, 2);

  const lying = createFakeDc({ curated: { [LIVE_ID[EVENTS]]: items(4) }, totalCount: 1000 });
  const w2 = makeWriter(lying).writer;
  const m2 = await w2.resolveLiveClasses();
  assert.equal((await w2.readAll(m2.get(EVENTS), { pageSize: 2 })).length, 4);
  assert.equal(lying.calls.filter(c => c.path.endsWith('/curated-data')).length, 3);

  const capped = createFakeDc({ curated: { [LIVE_ID[EVENTS]]: items(10) }, totalCount: 1000 });
  const w3 = makeWriter(capped).writer;
  const m3 = await w3.resolveLiveClasses();
  assert.equal((await w3.readAll(m3.get(EVENTS), { pageSize: 2, maxPages: 2 })).length, 4);

  const dupList = [...items(3), { ...items(1)[0], attributes: { code: 'second' } }];
  const dup = createFakeDc({ curated: { [LIVE_ID[EVENTS]]: dupList } });
  const w4 = makeWriter(dup).writer;
  const m4 = await w4.resolveLiveClasses();
  const got = await w4.readAll(m4.get(EVENTS), { pageSize: 10 });
  assert.equal(got.length, 3);
  assert.equal(got[0].attributes.code, 'K0');
});

test('readAll keeps paging past a short page while totalCount says more records exist', async () => {
  const dc = createFakeDc({ curated: { [LIVE_ID[EVENTS]]: items(250) }, maxPageSize: 100 });
  const { writer } = makeWriter(dc);
  const map = await writer.resolveLiveClasses();
  assert.equal((await writer.readAll(map.get(EVENTS))).length, 250);
  assert.equal(dc.calls.filter(c => c.path.endsWith('/curated-data')).length, 3);

  // A server that ignores `page` would repeat page 0 forever; a page with nothing new ends the read.
  const stuck = createFakeDc({ curated: { [LIVE_ID[EVENTS]]: items(250) }, maxPageSize: 100 });
  const origFetch = stuck.fetchImpl;
  const ignoresPage = async (url, options = {}) => {
    if (String(url).includes('/curated-data?')) {
      const body = JSON.parse(options.body);
      return origFetch(url, { ...options, body: JSON.stringify({ ...body, page: 0 }) });
    }
    return origFetch(url, options);
  };
  const w2 = createDcWriter({
    config: { ...loadDcWriterConfig(TEST_ENV), pollIntervalMs: 1 }, fetchImpl: ignoresPage, logger: captureLogger().logger,
  });
  const m2 = await w2.resolveLiveClasses();
  assert.equal((await w2.readAll(m2.get(EVENTS))).length, 100);
  assert.equal(stuck.calls.filter(c => c.path.endsWith('/curated-data')).length, 2);

  // Without a totalCount (null or absent) the short page is the only end signal.
  const bare = createFakeDc({ curated: { [LIVE_ID[EVENTS]]: items(5) } });
  const noTotal = async (url, options) => {
    const res = await bare.fetchImpl(url, options);
    if (!String(url).includes('/curated-data?')) return res;
    const { data } = await res.json();
    return ok({ data, totalCount: null });
  };
  const w3 = createDcWriter({ config: loadDcWriterConfig(TEST_ENV), fetchImpl: noTotal, logger: captureLogger().logger });
  const m3 = await w3.resolveLiveClasses();
  assert.equal((await w3.readAll(m3.get(EVENTS), { pageSize: 2 })).length, 5);
});

test('readAll works for any class (reads are not allowlisted)', async () => {
  const dc = createFakeDc({ curated: { [ASSETS.id]: items(3, 'A') } });
  const { writer } = makeWriter(dc);
  const assets = await writer.findClassByName(ASSETS.className);
  assert.equal((await writer.readAll(assets)).length, 3);
});

// ---- tokens ----

test('client credentials: single flight, form body, cached until expiry minus 60 s', async () => {
  const dc = createFakeDc();
  let t = 0;
  const provider = createClientCredentialsTokenProvider({
    tokenUrl: 'https://ims.example/connect/token', clientId: 'svc', clientSecret: 'sec', scope: 'itwin-platform',
    fetchImpl: dc.fetchImpl, now: () => t,
  });
  assert.equal(provider.renewable, true);
  const [a, b] = await Promise.all([provider.getToken(), provider.getToken()]);
  assert.equal(a, b);
  const tokenCalls = () => dc.calls.filter(c => c.path === '/connect/token');
  assert.equal(tokenCalls().length, 1);
  assert.deepEqual(tokenCalls()[0].form, { grant_type: 'client_credentials', client_id: 'svc', client_secret: 'sec', scope: 'itwin-platform' });
  assert.equal(tokenCalls()[0].headers['content-type'], 'application/x-www-form-urlencoded');
  t = (3600 - 61) * 1000;
  await provider.getToken();
  assert.equal(tokenCalls().length, 1);
  t = (3600 - 59) * 1000;
  await provider.getToken();
  assert.equal(tokenCalls().length, 2);
  provider.invalidate();
  await provider.getToken();
  assert.equal(tokenCalls().length, 3);
});

test('client credentials failure never leaks the secret or body', async () => {
  const provider = createClientCredentialsTokenProvider({
    tokenUrl: 'https://ims.example/connect/token', clientId: 'svc', clientSecret: 'topsecret', scope: 's',
    fetchImpl: async () => fail(400, { error: 'invalid_client', error_description: 'bad topsecret' }),
  });
  await assert.rejects(provider.getToken(), err => {
    assert.equal(err.code, WRITER_ERRORS.HTTP_ERROR);
    assert.equal(err.message, 'token request failed (400: invalid_client)');
    assert.ok(!JSON.stringify({ ...err, m: err.message }).includes('topsecret'));
    return true;
  });
  const noCode = createClientCredentialsTokenProvider({
    tokenUrl: 'https://ims.example/connect/token', clientId: 'svc', clientSecret: 'x', scope: 's',
    fetchImpl: async () => fail(503, 'down'),
  });
  await assert.rejects(noCode.getToken(), { message: 'token request failed (503)' });
});

test('a 401 with a renewable provider invalidates and retries once', async () => {
  const dc = createFakeDc({ unauthorizedOnce: true });
  let invalidated = 0;
  let n = 0;
  const provider = { renewable: true, getToken: async () => `t${++n}`, invalidate() { invalidated += 1; } };
  const { writer } = makeWriter(dc, { tokenProvider: provider });
  const list = await writer.listClasses();
  assert.ok(list.length > 0);
  assert.equal(invalidated, 1);
  assert.deepEqual(dc.calls.map(c => c.headers.authorization), ['Bearer t1', 'Bearer t2']);
});

test('a 401 with a static token is not retried', async () => {
  const dc = createFakeDc({ unauthorizedOnce: true });
  const { writer } = makeWriter(dc, { tokenProvider: createStaticTokenProvider('static') });
  await assert.rejects(writer.listClasses(), err => err.code === WRITER_ERRORS.HTTP_ERROR && err.status === 401);
  assert.equal(dc.calls.length, 1);
  const p = createStaticTokenProvider('abc');
  assert.equal(p.renewable, false);
  assert.equal(await p.getToken(), 'abc');
});

test('a remote writer with client credentials uses the token endpoint', async () => {
  const dc = createFakeDc();
  const writer = createDcWriter({
    config: { ...loadDcWriterConfig({ DC_WRITER_BASE_URL: REMOTE, DC_WRITER_LOAD_BASE_URL: REMOTE_LOAD, DC_WRITER_CLIENT_ID: 'svc', DC_WRITER_CLIENT_SECRET: 'sec', DC_WRITER_TOKEN_URL: 'https://ims.example/connect/token' }) },
    fetchImpl: dc.fetchImpl,
  });
  await writer.listClasses();
  assert.equal(dc.calls[0].path, '/connect/token');
  assert.match(dc.calls[1].headers.authorization, /^Bearer tok-/);
});

// ---- reset ----

test('resetLiveClass requires confirm === className and sends Deletion with keys only', async () => {
  const dc = createFakeDc({ curated: { [LIVE_ID[TICKETS]]: items(3, 'TIC-') } });
  const { writer } = makeWriter(dc);
  const map = await writer.resolveLiveClasses();
  const tickets = map.get(TICKETS);
  const before = dc.calls.length;
  await rejectsCode(writer.resetLiveClass(tickets, { confirm: 'yes' }), WRITER_ERRORS.RESET_NOT_CONFIRMED);
  await rejectsCode(writer.resetLiveClass(tickets), WRITER_ERRORS.RESET_NOT_CONFIRMED);
  await rejectsCode(writer.resetLiveClass(structuredClone(tickets), { confirm: TICKETS }), WRITER_ERRORS.UNRESOLVED_CLASS);
  const assets = await writer.findClassByName(ASSETS.className);
  const afterFind = dc.calls.length;
  await rejectsCode(writer.resetLiveClass(assets, { confirm: ASSETS.className }), WRITER_ERRORS.NOT_ALLOWLISTED);
  await rejectsCode(writer.resetLiveClass({ ...tickets, classId: 11 }, { confirm: TICKETS }), WRITER_ERRORS.HISTORICAL_CLASS);
  assert.equal(dc.calls.length, afterFind);
  assert.equal(afterFind, before + 1);

  const res = await writer.resetLiveClass(tickets, { confirm: TICKETS });
  assert.equal(res.loadType, 'Deletion');
  assert.equal(res.count, 3);
  const [register, upload] = loadCalls(dc);
  assert.deepEqual(register.json, { classId: 'CL000102', classType: 'DATA_CLASS', loadType: 'Deletion' });
  assert.deepEqual(upload.json, [{ keyInSource: 'TIC-000' }, { keyInSource: 'TIC-001' }, { keyInSource: 'TIC-002' }]);
});

// ---- redirects ----

function listenLoopback(handler) {
  const server = createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }),
  })));
}

test('a redirect is http_error and never followed to another origin (real fetch)', async () => {
  const elsewhere = [];
  const other = await listenLoopback((req, res) => {
    elsewhere.push(`${req.method} ${req.url}`);
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(defaultClasses()));
  });
  let redirectClassList = false;
  const configured = await listenLoopback((req, res) => {
    req.resume();
    const path = new URL(req.url, 'http://x').pathname;
    const json = body => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (path === '/v1/loads' || (path === '/api/data-mgmt/v1/class' && redirectClassList)) {
      res.writeHead(307, { location: `${other.url}${req.url}` }).end();
    } else if (path === '/api/data-mgmt/v1/class') json(defaultClasses());
    else res.writeHead(404).end();
  });
  try {
    const writer = createDcWriter({
      config: { ...loadDcWriterConfig({ DC_WRITER_BASE_URL: configured.url, DC_WRITER_LOAD_BASE_URL: configured.url, DC_WRITER_ACCESS_TOKEN: TEST_TOKEN }), pollIntervalMs: 1, processTimeoutMs: 200 },
      logger: captureLogger().logger,
    });
    const map = await writer.resolveLiveClasses();
    await assert.rejects(writer.loadRecords(map.get(TICKETS), [record('T1')]), err => {
      assert.equal(err.code, WRITER_ERRORS.HTTP_ERROR, err.message);
      assert.equal(err.status, 307);
      return true;
    });
    redirectClassList = true;
    await rejectsCode(writer.resolveLiveClasses(), WRITER_ERRORS.HTTP_ERROR);
    assert.deepEqual(elsewhere, [], 'neither the load payload nor a read reached the redirect target');
  } finally {
    await configured.close();
    await other.close();
  }
});

test('a response that arrived through a redirect is refused even if fetchImpl followed it', async () => {
  const dc = createFakeDc();
  const fetchImpl = async (url, options) => {
    const response = await dc.fetchImpl(url, options);
    return { ...response, redirected: true, url: 'https://elsewhere.example/api/data-mgmt/v1/class' };
  };
  const { writer } = makeWriter({ fetchImpl });
  await rejectsCode(writer.listClasses(), WRITER_ERRORS.HTTP_ERROR);
  assert.equal(dc.calls[0].headers.authorization, `Bearer ${TEST_TOKEN}`);
});

test('the client-credentials POST never follows a redirect with the secret', async () => {
  const seen = [];
  const provider = createClientCredentialsTokenProvider({
    tokenUrl: 'https://ims.example/connect/token', clientId: 'svc', clientSecret: 'secret', scope: 's',
    fetchImpl: async (url, options) => { seen.push(options.redirect); return fail(307, ''); },
  });
  await rejectsCode(provider.getToken(), WRITER_ERRORS.HTTP_ERROR);
  assert.deepEqual(seen, ['manual']);
});
