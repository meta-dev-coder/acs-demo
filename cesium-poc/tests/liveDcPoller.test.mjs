import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DcWriterError, WRITER_ERRORS } from '../server/liveDc/dcWriter.mjs';
import {
  DEFAULT_SERVICE_CLIENT_SECRET_NAME, LIVE_DC_STATUS_KEY, createPollerHandler, createSecretCredentials, runLiveDcStep,
} from '../infra/lambdas/poller/poller.mjs';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const CLIENT_ID = 'service-client-id-123';
const CLIENT_SECRET = 'very-secret-value-xyz';
const ACCESS_TOKEN = 'issued-access-token-abc';
const SECRET_JSON = JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET });

const ENV = {
  DC_WRITER_BASE_URL: 'https://dataconnect.example',
  DC_WRITER_LOAD_BASE_URL: 'https://dc-load.example',
};

const PAYLOAD = {
  source: 'FL511', sourceStatus: 'LIVE', counts: { total: 1, incidents: 1, closures: 0 },
  events: [{ id: 'INCIDENT:1', type: 'INCIDENT', title: 'Crash' }],
};

const REPORT = {
  at: new Date(NOW).toISOString(), sourceStatus: 'LIVE',
  sync: { skipped: false, reason: null, stats: { seen: 1, new: 1, updated: 0 } },
  workflow: { chains: 1, tickets: 1 },
  loads: { 'SDNA Florida I595 Live Events': { sent: 1 }, 'SDNA Florida I595 Live Tickets': { sent: 1 } },
  errors: [], warnings: ['w'],
};

function silentLogger(lines = []) {
  return Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [level, (...args) => lines.push(args.map(String).join(' '))]));
}

/** A fake Secrets Manager: returns `values` in turn (a function throws), counting reads. */
function fakeSecrets(...values) {
  const reads = [];
  return {
    reads,
    readSecret: async name => {
      reads.push(name);
      const value = values[Math.min(reads.length - 1, values.length - 1)];
      if (typeof value === 'function') return value();
      return value;
    },
  };
}

function fakeFetch({ tokenStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, body: init.body ? String(init.body) : '', auth: new Headers(init.headers).get('authorization') });
    if (href.startsWith('https://ims.bentley.com/')) {
      if (typeof tokenStatus === 'function' ? tokenStatus(calls) !== 200 : tokenStatus !== 200) {
        return new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400 });
      }
      return new Response(JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 3600 }), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  };
  return { calls, fetchImpl };
}

function stepHarness({ secrets = fakeSecrets(SECRET_JSON), runCycle, createWriter, env = ENV } = {}) {
  const statuses = [];
  const writers = [];
  const cycles = [];
  const lines = [];
  const input = {
    payload: PAYLOAD,
    credentials: createSecretCredentials({ secretName: 'i595/test', readSecret: secrets.readSecret, logger: silentLogger(lines) }),
    writeStatus: async status => { statuses.push(status); },
    env,
    now: () => NOW,
    logger: silentLogger(lines),
    createWriter: createWriter ?? (options => { writers.push(options); return { fake: true }; }),
    runCycle: runCycle ?? (async args => { cycles.push(args); return REPORT; }),
  };
  return { input, statuses, writers, cycles, lines, secrets };
}

const leaks = (text, ...secrets) => secrets.some(s => text.includes(s));

test('poller: the service-client secret name defaults to i595/dataconnect/service-client', () => {
  assert.equal(DEFAULT_SERVICE_CLIENT_SECRET_NAME, 'i595/dataconnect/service-client');
  assert.equal(LIVE_DC_STATUS_KEY, 'status/live-dc-status.json');
});

test('credentials: parsed from the secret JSON, cached per container, re-read after invalidate', async () => {
  const secrets = fakeSecrets(SECRET_JSON);
  const credentials = createSecretCredentials({ secretName: 'i595/test', readSecret: secrets.readSecret });
  const first = await credentials.get();
  assert.deepEqual({ ...first }, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  await credentials.get();
  assert.deepEqual(secrets.reads, ['i595/test']);
  credentials.invalidate();
  await credentials.get();
  assert.equal(secrets.reads.length, 2);
});

test('credentials: a missing, unreadable or incomplete secret fails without echoing it and is not cached', async () => {
  for (const value of [() => { throw Object.assign(new Error('ResourceNotFoundException'), { name: 'ResourceNotFoundException' }); },
    undefined, '', 'not json', JSON.stringify({ client_id: CLIENT_ID }), JSON.stringify({ client_secret: CLIENT_SECRET }), '[]']) {
    const secrets = fakeSecrets(value, SECRET_JSON);
    const lines = [];
    const credentials = createSecretCredentials({ secretName: 'i595/test', readSecret: secrets.readSecret, logger: silentLogger(lines) });
    await assert.rejects(credentials.get(), error => {
      assert.equal(error.code, 'credentials_unavailable');
      assert.ok(!leaks(error.message, CLIENT_ID, CLIENT_SECRET));
      return true;
    });
    assert.ok(!leaks(lines.join('\n'), CLIENT_ID, CLIENT_SECRET));
    assert.equal((await credentials.get()).clientId, CLIENT_ID, 'a failure is not cached');
  }
});

test('poller step: service-client credentials drive a client_credentials writer; nothing secret is logged or published', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const h = stepHarness({
    createWriter: undefined,
    runCycle: async ({ writer }) => {
      await writer.resolveLiveClasses().catch(() => {});
      return REPORT;
    },
  });
  delete h.input.createWriter;
  h.input.fetchImpl = fetchImpl;
  const status = await runLiveDcStep(h.input);

  const tokenCalls = calls.filter(c => c.url === 'https://ims.bentley.com/connect/token');
  assert.equal(tokenCalls.length, 1);
  const body = new URLSearchParams(tokenCalls[0].body);
  assert.equal(body.get('grant_type'), 'client_credentials');
  assert.equal(body.get('client_id'), CLIENT_ID);
  assert.equal(body.get('client_secret'), CLIENT_SECRET);
  assert.equal(body.get('scope'), 'itwin-platform');
  const dcCalls = calls.filter(c => c.url.startsWith('https://dataconnect.example/'));
  assert.ok(dcCalls.length > 0);
  assert.ok(dcCalls.every(c => c.auth === `Bearer ${ACCESS_TOKEN}`));

  assert.equal(status.dcWrite, 'ok');
  assert.equal(status.reason, null);
  assert.ok(!('tokenExpiresAt' in status));
  const published = JSON.stringify(h.statuses) + h.lines.join('\n');
  assert.ok(!leaks(published, CLIENT_ID, CLIENT_SECRET, ACCESS_TOKEN));
});

test('poller step: the token is reused across warm runs (one token request per hour, not per minute)', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const h = stepHarness({ createWriter: undefined, runCycle: async ({ writer }) => { await writer.resolveLiveClasses().catch(() => {}); return REPORT; } });
  delete h.input.createWriter;
  h.input.fetchImpl = fetchImpl;
  h.input.state = {};
  await runLiveDcStep(h.input);
  await runLiveDcStep(h.input);
  assert.equal(calls.filter(c => c.url.startsWith('https://ims.bentley.com/')).length, 1);
  assert.equal(h.secrets.reads.length, 1);
});

test('poller step: a rejected token request re-reads the secret once and retries (rotated secret)', async () => {
  const rotated = JSON.stringify({ client_id: 'rotated-id', client_secret: 'rotated-secret' });
  const secrets = fakeSecrets(SECRET_JSON, rotated);
  const { calls, fetchImpl } = fakeFetch({
    tokenStatus: all => (new URLSearchParams(all.at(-1).body).get('client_id') === 'rotated-id' ? 200 : 400),
  });
  const h = stepHarness({ secrets, createWriter: undefined, runCycle: async ({ writer }) => { await writer.resolveLiveClasses().catch(() => {}); return REPORT; } });
  delete h.input.createWriter;
  h.input.fetchImpl = fetchImpl;
  const status = await runLiveDcStep(h.input);
  assert.equal(secrets.reads.length, 2);
  assert.equal(calls.filter(c => c.url.startsWith('https://ims.bentley.com/')).length, 2);
  assert.ok(calls.filter(c => c.url.startsWith('https://dataconnect.example/')).every(c => c.auth === `Bearer ${ACCESS_TOKEN}`));
  assert.equal(status.dcWrite, 'ok');
});

test('poller step: credentials still rejected after one re-read is an error, not a loop', async () => {
  const secrets = fakeSecrets(SECRET_JSON);
  const { calls, fetchImpl } = fakeFetch({ tokenStatus: 400 });
  const h = stepHarness({ secrets, createWriter: undefined, runCycle: async ({ writer }) => { await writer.resolveLiveClasses(); return REPORT; } });
  delete h.input.createWriter;
  h.input.fetchImpl = fetchImpl;
  const status = await runLiveDcStep(h.input);
  assert.equal(secrets.reads.length, 2);
  assert.equal(calls.filter(c => c.url.startsWith('https://ims.bentley.com/')).length, 2);
  assert.equal(status.dcWrite, 'error');
  assert.equal(status.reason, 'auth_rejected');
  assert.ok(!leaks(JSON.stringify(status) + h.lines.join('\n'), CLIENT_ID, CLIENT_SECRET));
});

test('poller step: an unreadable secret is an error credentials_unavailable, with a status and no cycle', async () => {
  const h = stepHarness({ secrets: fakeSecrets(() => { throw Object.assign(new Error('AccessDeniedException'), { name: 'AccessDeniedException' }); }) });
  const status = await runLiveDcStep(h.input);
  assert.equal(status.dcWrite, 'error');
  assert.equal(status.reason, 'credentials_unavailable');
  assert.equal(h.writers.length, 0);
  assert.equal(h.cycles.length, 0);
  assert.deepEqual(h.statuses, [status]);
});

test('poller step: missing writer URLs are skipped as not configured without reading the secret', async () => {
  const h = stepHarness({ env: {} });
  delete h.input.createWriter;
  const status = await runLiveDcStep(h.input);
  assert.equal(status.dcWrite, 'skipped');
  assert.equal(status.reason, 'not_configured');
  assert.equal(h.secrets.reads.length, 0);
});

test('poller step: one cycle with the fetched payload and a summarized status', async () => {
  const h = stepHarness();
  const status = await runLiveDcStep(h.input);
  assert.equal(h.writers.length, 1);
  assert.equal(h.writers[0].config.baseUrl, 'https://dataconnect.example');
  assert.equal(h.writers[0].tokenProvider.renewable, true);
  assert.equal(h.cycles.length, 1);
  const { service } = h.cycles[0];
  await service.refresh();
  assert.equal(await service.snapshot(), PAYLOAD);
  assert.equal(status.lastRunAt, new Date(NOW).toISOString());
  assert.deepEqual(status.summary.loads, { Events: 1, Tickets: 1 });
  assert.equal(status.summary.warnings, 1);
  assert.deepEqual(h.statuses, [status]);
});

test('poller step: LIVE_DC_HOLD_OPEN is passed to the cycle as a set of keys', async () => {
  const h = stepHarness({ env: { ...ENV, LIVE_DC_HOLD_OPEN: ' INCIDENT:1, ,CLOSURE:2 ' } });
  await runLiveDcStep(h.input);
  assert.deepEqual([...h.cycles[0].holdOpen], ['INCIDENT:1', 'CLOSURE:2']);
  const none = stepHarness();
  await runLiveDcStep(none.input);
  assert.deepEqual([...none.cycles[0].holdOpen], []);
});

test('poller step: DataConnect errors are reported as error; a 401 is auth_rejected', async () => {
  const withErrors = stepHarness({ runCycle: async () => ({ ...REPORT, errors: ['SDNA Florida I595 Live Events: HTTP 500'] }) });
  const a = await runLiveDcStep(withErrors.input);
  assert.equal(a.dcWrite, 'error');
  assert.match(a.reason, /HTTP 500/);

  const thrown = stepHarness({ runCycle: async () => { throw new DcWriterError(WRITER_ERRORS.HTTP_ERROR, 'unauthorized', { status: 401 }); } });
  const b = await runLiveDcStep(thrown.input);
  assert.equal(b.dcWrite, 'error');
  assert.equal(b.reason, 'auth_rejected');
  assert.equal(thrown.statuses.length, 1);
});

test('poller step: a cycle that outlives the deadline is reported as a timeout', async () => {
  const h = stepHarness({ runCycle: () => new Promise(() => {}) });
  h.input.deadlineMs = 20;
  const status = await runLiveDcStep(h.input);
  assert.equal(status.dcWrite, 'error');
  assert.equal(status.reason, 'timeout');
  assert.equal(h.statuses.length, 1);
});

test('poller step: a failing status write is logged, not thrown', async () => {
  const lines = [];
  const h = stepHarness();
  h.input.logger = silentLogger(lines);
  h.input.writeStatus = async () => { throw new Error('s3 down'); };
  const status = await runLiveDcStep(h.input);
  assert.equal(status.dcWrite, 'ok');
  assert.ok(lines.some(line => /status/.test(line)));
});

test('poller step: the cycle gets the snapshot store, a capture and the public API base, and keeps the capture warm', async () => {
  const store = { put: async () => {}, url: key => `https://cdn.example/${key}` };
  const h = stepHarness({ env: { ...ENV, LIVE_DC_PUBLIC_API_BASE: 'https://cdn.example' } });
  const captures = [];
  h.input.snapshotStore = store;
  h.input.createCapture = options => { captures.push(options); return async () => ({}); };
  h.input.state = {};
  await runLiveDcStep(h.input);
  await runLiveDcStep(h.input);
  assert.equal(captures.length, 1, 'one capture per warm lambda');
  assert.equal(captures[0].snapshotStore, store);
  assert.equal(h.cycles[1].capture, h.cycles[0].capture);
  assert.equal(h.cycles[0].publicApiBase, 'https://cdn.example');
});

// ── Whole handler ───────────────────────────────────────────────────────────────────────────────

function handlerHarness({ secrets = fakeSecrets(SECRET_JSON), runCycle, ddbFails = false, oldItems = [], snapshotStore = null, liveDc = {} } = {}) {
  const calls = { refresh: 0, get: 0, puts: [], deletes: [], emits: [], statuses: [], cycles: [] };
  const service = {
    refresh: async () => { calls.refresh++; },
    getI595LiveEvents: async () => { calls.get++; return PAYLOAD; },
    snapshot: async () => { throw new Error('the poller must not ask the FL511 service twice'); },
  };
  const ddb = {
    scanAll: async () => { if (ddbFails) throw new Error('ddb down'); return oldItems; },
    put: async (_table, item) => { calls.puts.push(item); },
    remove: async (_table, key) => { calls.deletes.push(key); },
  };
  const handler = createPollerHandler({
    getService: async () => service,
    ddb,
    emit: async entry => { calls.emits.push(entry); },
    credentials: createSecretCredentials({ secretName: 'i595/test', readSecret: secrets.readSecret, logger: silentLogger() }),
    writeStatus: async status => { calls.statuses.push(status); },
    snapshotStore,
    env: { ...ENV, LIVE_EVENTS_TABLE: 'events', EVENTS_BUS_ARN: 'bus' },
    now: () => NOW,
    logger: silentLogger(),
    liveDc: {
      createWriter: () => ({ fake: true }),
      runCycle: runCycle ?? (async args => { calls.cycles.push(args); return REPORT; }),
      ...liveDc,
    },
  });
  return { handler, calls };
}

test('poller: FL511 is fetched once and feeds both DynamoDB and the DataConnect cycle; status written', async () => {
  const h = handlerHarness();
  await h.handler({}, { getRemainingTimeInMillis: () => 50_000 });
  assert.equal(h.calls.refresh, 1);
  assert.equal(h.calls.get, 1);
  assert.equal(h.calls.puts.length, 1);
  assert.equal(h.calls.puts[0].eventId, 'INCIDENT:1');
  assert.equal(h.calls.emits.length, 1);
  assert.equal(h.calls.cycles.length, 1);
  assert.equal(await h.calls.cycles[0].service.snapshot(), PAYLOAD);
  assert.equal(h.calls.statuses.length, 1);
  assert.equal(h.calls.statuses[0].dcWrite, 'ok');
});

test('poller: the DataConnect cycle still runs when DynamoDB has nothing to change', async () => {
  const h = handlerHarness({ oldItems: [{ eventId: 'INCIDENT:1', ...PAYLOAD.events[0], lastUpdated: 'x', ttl: 1 }] });
  await h.handler({});
  assert.equal(h.calls.puts.length, 0);
  assert.equal(h.calls.emits.length, 0);
  assert.equal(h.calls.cycles.length, 1);
});

test('poller: unreadable credentials leave the DynamoDB path intact and report credentials_unavailable', async () => {
  const h = handlerHarness({ secrets: fakeSecrets(() => { throw new Error('ResourceNotFoundException'); }) });
  await h.handler({});
  assert.equal(h.calls.get, 1);
  assert.equal(h.calls.puts.length, 1);
  assert.equal(h.calls.emits.length, 1);
  assert.equal(h.calls.cycles.length, 0);
  assert.equal(h.calls.statuses.length, 1);
  assert.equal(h.calls.statuses[0].dcWrite, 'error');
  assert.equal(h.calls.statuses[0].reason, 'credentials_unavailable');
});

test('poller: a DataConnect failure leaves the DynamoDB path intact', async () => {
  const h = handlerHarness({ runCycle: async () => { throw new Error('dc exploded'); } });
  await h.handler({});
  assert.equal(h.calls.puts.length, 1);
  assert.equal(h.calls.emits.length, 1);
  assert.equal(h.calls.statuses[0].dcWrite, 'error');
});

test('poller: a DynamoDB failure does not stop the DataConnect cycle', async () => {
  const h = handlerHarness({ ddbFails: true });
  await h.handler({});
  assert.equal(h.calls.cycles.length, 1);
  assert.equal(h.calls.statuses[0].dcWrite, 'ok');
});

test('poller handler: passes its snapshot store to the DataConnect step', async () => {
  const store = { put: async () => {}, url: key => key };
  const h = handlerHarness({ snapshotStore: store, liveDc: { createCapture: options => Object.assign(async () => ({}), { options }) } });
  await h.handler({}, { getRemainingTimeInMillis: () => 50_000 });
  assert.equal(h.calls.cycles[0].capture.options.snapshotStore, store);
});
