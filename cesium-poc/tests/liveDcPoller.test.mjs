import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_DC_STATUS_KEY } from '../server/liveDc/tokenHandoff.mjs';
import { DcWriterError, WRITER_ERRORS } from '../server/liveDc/dcWriter.mjs';
import { createPollerHandler, runLiveDcStep } from '../infra/lambdas/poller/poller.mjs';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const tokenExpiringIn = ms => `${b64({ alg: 'none' })}.${b64({ exp: Math.floor((NOW + ms) / 1000), sub: 'u' })}.sig`;

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

function stepHarness({ token = tokenExpiringIn(3600_000), runCycle, createWriter, env = ENV } = {}) {
  const statuses = [];
  const writers = [];
  const cycles = [];
  const lines = [];
  const input = {
    payload: PAYLOAD,
    readToken: async () => token,
    writeStatus: async status => { statuses.push(status); },
    env,
    now: () => NOW,
    logger: silentLogger(lines),
    createWriter: createWriter ?? (options => { writers.push(options); return { fake: true }; }),
    runCycle: runCycle ?? (async args => { cycles.push(args); return REPORT; }),
  };
  return { input, statuses, writers, cycles, lines };
}

test('poller step: a fresh token runs one cycle with a writer that uses that token and the fetched payload', async () => {
  const token = tokenExpiringIn(3600_000);
  const h = stepHarness({ token });
  const status = await runLiveDcStep(h.input);
  assert.equal(h.writers.length, 1);
  assert.equal(await h.writers[0].tokenProvider.getToken(), token);
  assert.equal(h.writers[0].config.baseUrl, 'https://dataconnect.example');
  assert.equal(h.writers[0].config.loadBaseUrl, 'https://dc-load.example');
  assert.equal(h.cycles.length, 1);
  const { service } = h.cycles[0];
  await service.refresh();
  assert.equal(await service.snapshot(), PAYLOAD);
  assert.equal(status.dcWrite, 'ok');
  assert.equal(status.reason, null);
  assert.equal(status.tokenExpiresAt, new Date(Math.floor((NOW + 3600_000) / 1000) * 1000).toISOString());
  assert.equal(status.lastRunAt, new Date(NOW).toISOString());
  assert.deepEqual(status.summary.loads, { Events: 1, Tickets: 1 });
  assert.equal(status.summary.errors, 0);
  assert.equal(status.summary.warnings, 1);
  assert.deepEqual(h.statuses, [status]);
  assert.ok(!JSON.stringify(status).includes(token));
});

test('poller step: the default writer is the real guarded DataConnect writer', async () => {
  const token = tokenExpiringIn(3600_000);
  const seen = [];
  const h = stepHarness({
    token,
    createWriter: undefined,
    runCycle: async ({ writer }) => {
      assert.equal(typeof writer.resolveLiveClasses, 'function');
      await writer.resolveLiveClasses().catch(() => {});
      return REPORT;
    },
  });
  delete h.input.createWriter;
  h.input.fetchImpl = async (url, init) => { seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') }); return new Response('[]', { status: 200 }); };
  await runLiveDcStep(h.input);
  assert.ok(seen.length > 0);
  assert.ok(seen.every(call => call.url.startsWith('https://dataconnect.example/')));
  assert.ok(seen.every(call => call.auth === `Bearer ${token}`));
});

test('poller step: a missing, unreadable or nearly expired token skips the write but still writes a status', async () => {
  for (const [token, reason] of [[null, 'no_token'], ['', 'no_token'], ['garbage', 'token_unreadable'],
    [tokenExpiringIn(60_000), 'token_expired'], [tokenExpiringIn(-60_000), 'token_expired']]) {
    const h = stepHarness({ token });
    const status = await runLiveDcStep(h.input);
    assert.equal(status.dcWrite, 'skipped', String(token));
    assert.equal(status.reason, reason);
    assert.equal(h.writers.length, 0);
    assert.equal(h.cycles.length, 0);
    assert.equal(h.statuses.length, 1);
  }
});

test('poller step: missing writer URLs are skipped as not configured', async () => {
  const h = stepHarness({ env: {} });
  h.input.createWriter = undefined;
  delete h.input.createWriter;
  const status = await runLiveDcStep(h.input);
  assert.equal(status.dcWrite, 'skipped');
  assert.equal(status.reason, 'not_configured');
});

test('poller step: DataConnect errors are reported as error; a 401 says the token was rejected', async () => {
  const withErrors = stepHarness({ runCycle: async () => ({ ...REPORT, errors: ['SDNA Florida I595 Live Events: HTTP 500'] }) });
  const a = await runLiveDcStep(withErrors.input);
  assert.equal(a.dcWrite, 'error');
  assert.match(a.reason, /HTTP 500/);

  const thrown = stepHarness({ runCycle: async () => { throw new DcWriterError(WRITER_ERRORS.HTTP_ERROR, 'unauthorized', { status: 401 }); } });
  const b = await runLiveDcStep(thrown.input);
  assert.equal(b.dcWrite, 'error');
  assert.equal(b.reason, 'token_rejected');
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

// ── Whole handler ───────────────────────────────────────────────────────────────────────────────

function handlerHarness({ token = tokenExpiringIn(3600_000), runCycle, ddbFails = false, oldItems = [] } = {}) {
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
    tokenStore: { read: async () => token, writeStatus: async status => { calls.statuses.push(status); } },
    env: { ...ENV, LIVE_EVENTS_TABLE: 'events', EVENTS_BUS_ARN: 'bus' },
    now: () => NOW,
    logger: silentLogger(),
    liveDc: {
      createWriter: () => ({ fake: true }),
      runCycle: runCycle ?? (async args => { calls.cycles.push(args); return REPORT; }),
    },
  });
  return { handler, calls };
}

test('poller: FL511 is fetched once and feeds both DynamoDB and the DataConnect cycle', async () => {
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

test('poller: without a token the DynamoDB path is unchanged and the status says skipped', async () => {
  const h = handlerHarness({ token: null });
  await h.handler({});
  assert.equal(h.calls.puts.length, 1);
  assert.equal(h.calls.emits.length, 1);
  assert.equal(h.calls.cycles.length, 0);
  assert.equal(h.calls.statuses[0].dcWrite, 'skipped');
  assert.equal(h.calls.statuses[0].reason, 'no_token');
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

test('poller: status goes to the non-secret status key', () => {
  assert.equal(LIVE_DC_STATUS_KEY, 'status/live-dc-status.json');
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
  assert.equal(typeof h.cycles[0].capture, 'function');
  assert.equal(h.cycles[1].capture, h.cycles[0].capture);
  assert.equal(h.cycles[0].publicApiBase, 'https://cdn.example');
});

test('poller handler: passes its snapshot store to the DataConnect step', async () => {
  const store = { put: async () => {}, url: key => key };
  const cycles = [];
  const handler = createPollerHandler({
    getService: async () => ({ refresh: async () => {}, getI595LiveEvents: async () => PAYLOAD }),
    ddb: { scanAll: async () => [], put: async () => {}, remove: async () => {} },
    emit: async () => {},
    tokenStore: { read: async () => tokenExpiringIn(3600_000), writeStatus: async () => {} },
    snapshotStore: store,
    env: { ...ENV, LIVE_EVENTS_TABLE: 'events', EVENTS_BUS_ARN: 'bus' },
    now: () => NOW,
    logger: silentLogger(),
    liveDc: {
      createWriter: () => ({ fake: true }),
      createCapture: options => Object.assign(async () => ({}), { options }),
      runCycle: async args => { cycles.push(args); return REPORT; },
    },
  });
  await handler({}, { getRemainingTimeInMillis: () => 50_000 });
  assert.equal(cycles[0].capture.options.snapshotStore, store);
});
