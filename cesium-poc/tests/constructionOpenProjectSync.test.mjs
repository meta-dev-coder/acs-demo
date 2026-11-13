/**
 * Phase 8B — automatic OpenProject synchronisation.
 *
 * Fixture-driven and clock-driven. No test here reaches the network, and no test waits: the
 * worker's timer is injected, so "polls every 60 seconds" is asserted by advancing a fake clock
 * rather than by sleeping, and a suite that takes 8 seconds does not become one that takes ten
 * minutes.
 *
 * The guards most likely to be removed by a well-meaning change each have a test that fails if
 * they go: the single lock that stops two walks of the same collection, the rejected token that
 * must not be retried for ever, the skipped tick that must not mark good data stale, the partial
 * page that must not look like a deletion, and the synthetic P6 record that an unattended worker
 * must never touch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createConstructionApi } from '../server/construction/api.mjs';
import { countRows, openConstructionDb } from '../server/construction/db.mjs';
import { seedSourceSystems } from '../server/construction/seed.mjs';
import { createOpenProjectAdapter } from '../server/construction/openProject.mjs';
import {
  MANUAL_MIN_INTERVAL_MS, SYNC_EVENT, WORKER_STATE, acquireSyncWorker, backoffFor,
  createOpenProjectSyncWorker, readSyncConfig, releaseSyncWorker, resetSyncWorkerRegistry,
  syncWorkerRefs, truthy,
} from '../server/construction/openProjectSync.mjs';
import { RUN_STATUS, SYNC_INTERVAL, TRIGGER } from '../server/construction/openProjectConfig.mjs';
import { STATE, parseRetryAfter } from '../server/construction/openProjectHttp.mjs';
import { createSseHub } from '../server/construction/sseHub.mjs';
import {
  changeLog, lastFetch, lastSuccessfulFetch, storedActivities, syncHistory,
} from '../server/construction/openProjectStore.mjs';
import { RUN_LABEL, WORKER_LABEL, relative, syncRowMarkup } from '../src/construction/openProjectSchedule.js';

const TOKEN = 'op-token-never-logged-8b';
const quiet = { warn() {}, error() {}, log() {} };

const ENV = Object.freeze({
  OPENPROJECT_API_TOKEN: TOKEN,
  OPENPROJECT_BASE_URL: 'https://superdnatechnolab.openproject.com',
  OPENPROJECT_PROJECT_ID: '3',
  OPENPROJECT_AUTO_SYNC_ENABLED: 'true',
  OPENPROJECT_SYNC_INTERVAL_SECONDS: '60',
  OPENPROJECT_SYNC_ON_STARTUP: 'true',
});

/* ── fixtures ──────────────────────────────────────────────────────────────────────────────── */

const WP38 = Object.freeze({
  _type: 'WorkPackage',
  id: 38,
  subject: 'Cast Level 2 Columns',
  startDate: '2026-11-12',
  dueDate: '2026-11-18',
  estimatedTime: 'P1DT16H',
  remainingTime: 'P1DT6H',
  percentageDone: 25,
  lockVersion: 1,
  createdAt: '2026-11-10T11:02:11.000Z',
  updatedAt: '2026-11-10T12:08:45.431Z',
  _links: {
    self: { href: '/api/v3/work_packages/38', title: 'Cast Level 2 Columns' },
    type: { href: '/api/v3/types/1', title: 'Task' },
    status: { href: '/api/v3/statuses/1', title: 'New' },
    project: { href: '/api/v3/projects/3', title: 'Construction' },
  },
});

/** A CLOSED work package, so "completed activities are handled" has something to be true about. */
const WP41 = Object.freeze({
  _type: 'WorkPackage',
  id: 41,
  subject: 'Strip Level 1 Formwork',
  startDate: '2026-11-02',
  dueDate: '2026-11-06',
  percentageDone: 100,
  lockVersion: 7,
  updatedAt: '2026-11-07T08:00:00.000Z',
  _links: {
    self: { href: '/api/v3/work_packages/41' },
    type: { href: '/api/v3/types/1', title: 'Task' },
    status: { href: '/api/v3/statuses/12', title: 'Closed' },
  },
});

const PROJECT3 = Object.freeze({
  _type: 'Project', id: 3, identifier: 'construction', name: 'Construction', active: true,
  _links: { self: { href: '/api/v3/projects/3', title: 'Construction' } },
});

const collection = (elements, extra = {}) => ({
  _type: 'Collection', total: elements.length, count: elements.length, pageSize: 100, offset: 1,
  _embedded: { elements }, _links: {}, ...extra,
});

const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/hal+json', ...headers } });

const opError = (identifier, message) => ({ _type: 'Error', errorIdentifier: identifier, message });

/**
 * A fake OpenProject that records every request and can be made to fail on demand.
 *
 * The recording is the only honest way to assert a request was NOT made, which is what several of
 * the rules below come down to.
 */
function stubOpenProject({ workPackages = [WP38], pages = null, project = PROJECT3 } = {}) {
  const calls = [];
  const state = {
    workPackages: structuredClone(workPackages),
    /** Set to make the collection fail: `{ status, body, headers }`, or a function. */
    fail: null,
    /** Milliseconds of artificial latency on the collection, for the overlap tests. */
    delayMs: 0,
    pages,
  };

  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, search: parsed.search, method: options.method ?? 'GET',
      headers: options.headers ?? {} });
    const path = parsed.pathname;
    if (path === '/api/v3/configuration') {
      return reply(opError('urn:openproject-org:api:v3:errors:NotFound', 'Not found.'), 404);
    }
    if (path === '/api/v3/projects/3') return reply(project);
    if (path === '/api/v3/projects/3/work_packages') {
      if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
      if (state.fail) {
        const spec = typeof state.fail === 'function' ? state.fail() : state.fail;
        if (spec) return reply(spec.body ?? opError('x', 'boom'), spec.status ?? 500,
          spec.headers ?? {});
      }
      if (state.pages) {
        const offset = Number(parsed.searchParams.get('offset') ?? 1);
        const page = state.pages.find(entry => entry.offset === offset);
        return page ? reply(page.body) : reply(opError('x', 'No such page.'), 404);
      }
      return reply(collection(state.workPackages));
    }
    const single = /^\/api\/v3\/work_packages\/(\d+)$/.exec(path);
    if (single) {
      const found = state.workPackages.find(entry => String(entry.id) === single[1]);
      return found ? reply(found) : reply(opError('x', 'Not found.'), 404);
    }
    if (/^\/api\/v3\/work_packages\/\d+\/relations$/.test(path)) return reply(collection([]));
    return reply(opError('urn:openproject-org:api:v3:errors:NotFound', 'Not found.'), 404);
  };

  return {
    fetchImpl, calls, state,
    collectionCalls: () => calls.filter(entry => entry.path.endsWith('/work_packages')
      && !/\d$/.test(entry.path)),
    update(patch, id = 38) {
      const index = state.workPackages.findIndex(entry => String(entry.id) === String(id));
      state.workPackages[index] = { ...state.workPackages[index], ...patch };
    },
  };
}

/**
 * A controllable clock.
 *
 * `setTimeout` only — the worker arms one shot at a time on purpose, so this does not need to
 * model intervals, and `pending()` being at most one is itself one of the assertions below.
 */
function fakeClock(start = 1_767_000_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms, ms });
      return { id, unref() {} };
    },
    clearTimeout(handle) { if (handle) timers.delete(handle.id); },
    pending: () => [...timers.values()],
    /** Move the clock without firing anything, for the throttle tests. */
    tick(ms) { now += ms; },
    /** Move the clock, fire what is due, and let the resulting promises settle. */
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.fn();
      }
      await flush();
    },
  };
}

/** Let every already-resolved promise and `setTimeout(0)` in the stub settle. */
const flush = async (turns = 6) => {
  for (let index = 0; index < turns; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
};

/** Wait for whatever the worker has in flight, however many times it chains. */
async function settled(worker) {
  for (let index = 0; index < 40 && worker.inFlight; index += 1) {
    try { await worker.inFlight; } catch { /* reported by the worker */ }
    await flush(2);
  }
  await flush(2);
}

/**
 * A worker over a real in-memory database and a stubbed OpenProject.
 *
 * Each one gets its own registry-free worker: `createOpenProjectSyncWorker` directly, not
 * `acquireSyncWorker`, so no test can inherit another's singleton.
 */
function createWorker({ env = ENV, stub = stubOpenProject(), db = null, clock = fakeClock(),
  published = [], ...rest } = {}) {
  const database = db ?? openConstructionDb({ path: ':memory:' });
  // The API seeds the mock source systems on its first request; a worker built directly does not
  // get that, and the synthetic P6 rows are exactly what several tests here prove are untouched.
  if (countRows(database, ['src_p6_activity']).src_p6_activity === 0) seedSourceSystems(database);
  const adapter = createOpenProjectAdapter({ env, fetchImpl: stub.fetchImpl, logger: quiet });
  const worker = createOpenProjectSyncWorker({
    adapter: () => adapter,
    db: () => database,
    publish: (event, data) => published.push({ event, data }),
    env,
    logger: quiet,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    now: clock.now,
    manualMinIntervalMs: 0,
    ...rest,
  });
  return { worker, db: database, stub, clock, published, adapter };
}

/** The HTTP handler, driven the way the browser does. */
function createApi({ env = ENV, stub = stubOpenProject(), autoSync = false } = {}) {
  const api = createConstructionApi({ path: ':memory:', logger: quiet,
    openProjectOptions: { env, fetchImpl: stub.fetchImpl },
    autoSync,
    syncOptions: { manualMinIntervalMs: 0,
      workerKey: `test-${Math.random().toString(36).slice(2)}` } });
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    let status = null;
    let payload = null;
    const res = {
      writeHead(code) { status = code; return this; },
      end(text) { payload = text ? JSON.parse(text) : null; },
    };
    const req = { method, url: `/api/construction${path}`, headers,
      on(event, handler) {
        if (event === 'data' && body) handler(Buffer.from(JSON.stringify(body)));
        if (event === 'end') handler();
        return this;
      } };
    await api.handle(req, res);
    return { status, payload };
  };
  return { api, call, stub };
}

/** A demo session, so the gated routes can be reached. */
async function withSession(call, role = 'integrationLead') {
  const issued = await call('/session', { method: 'POST', body: { role } });
  return { 'x-demo-session': issued.payload.token };
}

/* ── configuration ────────────────────────────────────────────────────────────────────────── */

test('the worker is OFF unless the environment says otherwise', () => {
  // Not a default anybody chose: an integration must not begin talking to somebody's cloud
  // instance because a file happened to be present.
  assert.equal(readSyncConfig({}).enabled, false);
  assert.equal(readSyncConfig({ OPENPROJECT_AUTO_SYNC_ENABLED: 'false' }).enabled, false);
  assert.equal(readSyncConfig({ OPENPROJECT_AUTO_SYNC_ENABLED: 'maybe' }).enabled, false);
  assert.equal(readSyncConfig({ OPENPROJECT_AUTO_SYNC_ENABLED: 'true' }).enabled, true);
  assert.equal(readSyncConfig({ OPENPROJECT_AUTO_SYNC_ENABLED: 'TRUE' }).enabled, true);
  assert.equal(readSyncConfig({ OPENPROJECT_AUTO_SYNC_ENABLED: '1' }).enabled, true);
});

test('truthy accepts the spellings an operator actually types, and nothing else', () => {
  for (const value of ['true', 'TRUE', ' yes ', 'on', '1']) assert.equal(truthy(value), true);
  for (const value of ['false', '0', 'off', 'no', '', null, undefined, 'enabled']) {
    assert.equal(truthy(value), false);
  }
});

test('the interval defaults to 60 s', () => {
  assert.equal(readSyncConfig({}).intervalSeconds, 60);
  assert.equal(SYNC_INTERVAL.default, 60);
  assert.equal(readSyncConfig({ OPENPROJECT_SYNC_INTERVAL_SECONDS: '120' }).intervalSeconds, 120);
});

test('an interval below the floor is clamped and SAID, not silently honoured', () => {
  const config = readSyncConfig({ OPENPROJECT_SYNC_INTERVAL_SECONDS: '1' });
  assert.equal(config.intervalSeconds, SYNC_INTERVAL.min);
  assert.match(config.intervalClamped, /clamped to 15 s/);
  // A one-second poll of a shared rate-limited service is indistinguishable from an attack on it.
  assert.ok(SYNC_INTERVAL.min >= 15);
});

test('a nonsense interval falls back to the default rather than to zero', () => {
  for (const value of ['', 'soon', '-5', '0', null]) {
    const config = readSyncConfig({ OPENPROJECT_SYNC_INTERVAL_SECONDS: value });
    assert.equal(config.intervalSeconds, 60, `for ${JSON.stringify(value)}`);
    assert.equal(config.intervalClamped, null);
  }
});

test('syncOnStartup defaults to true and can be turned off', () => {
  assert.equal(readSyncConfig({}).syncOnStartup, true);
  assert.equal(readSyncConfig({ OPENPROJECT_SYNC_ON_STARTUP: 'false' }).syncOnStartup, false);
});

/* ── starting and not starting ────────────────────────────────────────────────────────────── */

test('the worker starts when enabled and arms exactly one timer', async () => {
  const { worker, clock, stub } = createWorker();
  const outcome = worker.start();
  assert.equal(outcome.started, true);
  await settled(worker);
  assert.equal(worker.state, WORKER_STATE.IDLE);
  assert.equal(clock.pending().length, 1, 'one armed timer, never two');
  assert.ok(stub.collectionCalls().length >= 1, 'the startup run read the collection');
  await worker.stop();
});

test('the worker does not start when disabled, and arms no timer at all', async () => {
  const { worker, clock, stub } = createWorker({
    env: { ...ENV, OPENPROJECT_AUTO_SYNC_ENABLED: 'false' } });
  const outcome = worker.start();
  assert.equal(outcome.started, false);
  assert.match(outcome.reason, /OPENPROJECT_AUTO_SYNC_ENABLED/);
  assert.equal(worker.state, WORKER_STATE.DISABLED);
  assert.equal(clock.pending().length, 0);
  await clock.advance(10 * 60_000);
  assert.equal(stub.calls.length, 0, 'a disabled worker makes no request, ever');
  await worker.stop();
});

test('a missing token prevents polling entirely — no timer and no request', async () => {
  const { worker, clock, stub } = createWorker({
    env: { ...ENV, OPENPROJECT_API_TOKEN: '' } });
  const outcome = worker.start();
  assert.equal(outcome.started, false);
  assert.match(outcome.reason, /OPENPROJECT_API_TOKEN/);
  assert.equal(worker.state, WORKER_STATE.NOT_CONFIGURED);
  assert.equal(clock.pending().length, 0, 'no timer: a missing credential is a configuration '
    + 'state, not something to rediscover every 60 seconds');
  await clock.advance(10 * 60_000);
  assert.equal(stub.calls.length, 0);
});

test('an unusable project id prevents polling', () => {
  const { worker, clock } = createWorker({
    env: { ...ENV, OPENPROJECT_PROJECT_ID: 'three' } });
  assert.equal(worker.start().started, false);
  assert.equal(worker.state, WORKER_STATE.NOT_CONFIGURED);
  assert.equal(clock.pending().length, 0);
});

test('start() is idempotent: a second call arms no second timer', async () => {
  const { worker, clock } = createWorker();
  worker.start();
  await settled(worker);
  const first = clock.pending().length;
  const again = worker.start();
  assert.equal(again.firstRun, null);
  assert.equal(clock.pending().length, first, 'still one timer');
  await worker.stop();
});

test('with syncOnStartup off, the timer is armed but nothing is read yet', async () => {
  const { worker, clock, stub } = createWorker({
    env: { ...ENV, OPENPROJECT_SYNC_ON_STARTUP: 'false' } });
  worker.start();
  await flush();
  assert.equal(stub.collectionCalls().length, 0, 'no startup read');
  assert.equal(clock.pending().length, 1);
  await clock.advance(60_000);
  await settled(worker);
  assert.equal(stub.collectionCalls().length, 1, 'the first scheduled tick read it');
  await worker.stop();
});

/* ── the interval, and overlap ────────────────────────────────────────────────────────────── */

test('it polls every 60 seconds and not before', async () => {
  const { worker, clock, stub } = createWorker();
  worker.start();
  await settled(worker);
  const afterStartup = stub.collectionCalls().length;

  await clock.advance(59_000);
  await settled(worker);
  assert.equal(stub.collectionCalls().length, afterStartup, 'nothing at 59 s');

  await clock.advance(1_500);
  await settled(worker);
  assert.equal(stub.collectionCalls().length, afterStartup + 1, 'one read at 60 s');

  await clock.advance(60_000);
  await settled(worker);
  assert.equal(stub.collectionCalls().length, afterStartup + 2, 'and one each interval after');
  await worker.stop();
});

test('a scheduled tick that arrives mid-run is SKIPPED, not run concurrently', async () => {
  const { worker, db, stub, clock } = createWorker();
  stub.state.delayMs = 50;
  // Start a run and leave it in flight.
  const running = worker.run({ trigger: TRIGGER.SCHEDULED });
  await flush(1);
  assert.ok(worker.inFlight, 'a run is in flight');
  const before = stub.collectionCalls().length;

  const second = await worker.run({ trigger: TRIGGER.SCHEDULED });
  assert.equal(second.runStatus, RUN_STATUS.SKIPPED);
  assert.equal(second.skipped, true);
  assert.equal(stub.collectionCalls().length, before,
    'the skipped tick issued no request of its own');

  await running;
  await settled(worker);
  const skipped = syncHistory(db, '3').filter(run => run.runStatus === RUN_STATUS.SKIPPED);
  assert.equal(skipped.length, 1, 'the skip is recorded, because it explains a gap in the history');
  assert.match(skipped[0].reason, /still running/);
  await worker.stop();
  clock.pending();
});

test('a SKIPPED run never marks good data stale', async () => {
  const { worker, db } = createWorker();
  await worker.run({ trigger: TRIGGER.MANUAL });
  await settled(worker);
  const good = lastFetch(db, '3');

  // Force a skip by starting a run and asking for another before it settles.
  worker.run({ trigger: TRIGGER.SCHEDULED });
  await flush(1);
  await worker.run({ trigger: TRIGGER.SCHEDULED });
  await settled(worker);

  const latest = lastFetch(db, '3');
  assert.notEqual(latest.run_status, RUN_STATUS.SKIPPED,
    'lastFetch skips SKIPPED rows, so a coalesced tick cannot put the word SKIPPED where the '
    + 'screen expects a connection state');
  assert.ok(good.id <= latest.id);
  assert.equal(lastSuccessfulFetch(db, '3').state, STATE.CONNECTED);
  await worker.stop();
});

test('a manual run that arrives mid-cycle JOINS it rather than starting a second', async () => {
  const { worker, stub } = createWorker();
  stub.state.delayMs = 40;
  const first = worker.run({ trigger: TRIGGER.SCHEDULED });
  await flush(1);
  const before = stub.collectionCalls().length;
  const joined = await worker.run({ trigger: TRIGGER.MANUAL });
  assert.equal(joined.coalesced, true);
  assert.match(joined.reason, /already running/);
  assert.equal(stub.collectionCalls().length, before, 'no second walk of the collection');
  // It is the FIRST run's answer, which is the point: a second press gets the data, not an error.
  assert.equal(joined.runStatus, RUN_STATUS.SUCCESS);
  await first;
  await worker.stop();
});

test('the startup run and the first scheduled tick cannot overlap', async () => {
  const { worker, clock, stub } = createWorker();
  stub.state.delayMs = 30;
  worker.start();
  await flush(1);
  assert.ok(worker.inFlight, 'the startup run is in flight');
  // The timer is armed only by `settle`, once a run has finished, so there is nothing to fire.
  assert.equal(clock.pending().length, 0,
    'no tick is armed while the startup run is still going');
  await settled(worker);
  assert.equal(clock.pending().length, 1, 'armed once the startup run settled');
  await worker.stop();
});

test('only one timer exists at any moment, across many cycles', async () => {
  const { worker, clock } = createWorker();
  worker.start();
  await settled(worker);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(clock.pending().length, 1, `after ${index} cycles`);
    await clock.advance(60_000);
    await settled(worker);
  }
  await worker.stop();
});

test('a manual run is throttled so a held-down button cannot hammer OpenProject', async () => {
  const clock = fakeClock();
  const { worker, stub } = createWorker({ clock, manualMinIntervalMs: MANUAL_MIN_INTERVAL_MS });
  await worker.run({ trigger: TRIGGER.MANUAL });
  await settled(worker);
  const before = stub.collectionCalls().length;

  const immediate = await worker.run({ trigger: TRIGGER.MANUAL });
  assert.equal(immediate.runStatus, RUN_STATUS.SKIPPED);
  assert.equal(immediate.throttled, true);
  assert.equal(stub.collectionCalls().length, before, 'no request for a throttled click');

  clock.tick(MANUAL_MIN_INTERVAL_MS + 10);
  const later = await worker.run({ trigger: TRIGGER.MANUAL });
  await settled(worker);
  assert.equal(later.runStatus, RUN_STATUS.SUCCESS, 'a deliberate second press still works');
  await worker.stop();
});

test('a throttled click is NOT written to the history', async () => {
  const clock = fakeClock();
  const { worker, db } = createWorker({ clock, manualMinIntervalMs: MANUAL_MIN_INTERVAL_MS });
  await worker.run({ trigger: TRIGGER.MANUAL });
  await settled(worker);
  const before = syncHistory(db, '3').length;
  await worker.run({ trigger: TRIGGER.MANUAL });
  await worker.run({ trigger: TRIGGER.MANUAL });
  assert.equal(syncHistory(db, '3').length, before,
    'nothing happened, so nothing is recorded — a history full of double-clicks buries the runs '
    + 'that mattered');
  await worker.stop();
});

/* ── change detection through the worker ──────────────────────────────────────────────────── */

test('the first cycle is a BASELINE and reports no progress change', async () => {
  const { worker, db } = createWorker();
  const run = await worker.run({ trigger: TRIGGER.STARTUP });
  await settled(worker);
  assert.equal(run.runStatus, RUN_STATUS.SUCCESS);
  assert.equal(run.counts.new, 1);
  assert.equal(run.counts.changed, 0);
  const kinds = changeLog(db, '3').map(entry => entry.kind);
  assert.deepEqual(kinds, ['NEW_ACTIVITY']);
  assert.ok(!kinds.includes('PROGRESS_CHANGED'),
    '"progress went from nothing to 25%" is a sentence about our storage, not about the work');
  await worker.stop();
});

test('the brief\'s scenario: 25% → 50% is detected automatically with before and after', async () => {
  const { worker, db, stub, clock } = createWorker();
  worker.start();
  await settled(worker);
  assert.equal(storedActivities(db, '3')[0].reportedProgressPct, 25);

  // Somebody edits it in OpenProject. The revision moves by more than one on purpose — the
  // brief's figures are illustrative and nothing here may assume an increment.
  stub.update({ percentageDone: 50, lockVersion: 4,
    updatedAt: '2026-11-11T09:31:00.000Z' });

  await clock.advance(60_000);
  await settled(worker);

  assert.equal(storedActivities(db, '3')[0].reportedProgressPct, 50, 'the new value is stored');
  const change = changeLog(db, '3').find(entry => entry.kind === 'PROGRESS_CHANGED');
  assert.ok(change, 'PROGRESS_CHANGED was detected without anybody pressing refresh');
  assert.equal(change.previous, '25');
  assert.equal(change.current, '50');
  assert.equal(change.previousRevision, 1);
  assert.equal(change.currentRevision, 4, 'the ACTUAL revision, not an assumed +1');
  assert.equal(change.currentUpdatedAt, '2026-11-11T09:31:00.000Z');
  await worker.stop();
});

test('a schedule date change is detected', async () => {
  const { worker, db, stub, clock } = createWorker();
  worker.start();
  await settled(worker);
  stub.update({ dueDate: '2026-11-25', lockVersion: 2 });
  await clock.advance(60_000);
  await settled(worker);
  const change = changeLog(db, '3').find(entry => entry.field === 'plannedFinish');
  assert.ok(change);
  assert.equal(change.kind, 'SCHEDULE_CHANGED');
  assert.equal(change.previous, '2026-11-18');
  assert.equal(change.current, '2026-11-25');
  await worker.stop();
});

test('several fields in one revision produce several findings, not one', async () => {
  const { worker, db, stub, clock } = createWorker();
  worker.start();
  await settled(worker);
  stub.update({ percentageDone: 60, dueDate: '2026-11-30', remainingTime: 'PT4H',
    lockVersion: 9, _links: { ...WP38._links, status: { href: '/api/v3/statuses/7',
      title: 'In progress' } } });
  await clock.advance(60_000);
  await settled(worker);

  const kinds = new Set(changeLog(db, '3').filter(entry => entry.currentRevision === 9)
    .map(entry => entry.kind));
  for (const expected of ['PROGRESS_CHANGED', 'SCHEDULE_CHANGED', 'STATUS_CHANGED',
    'WORK_ESTIMATE_CHANGED']) {
    assert.ok(kinds.has(expected), `${expected} was reported`);
  }
  // One activity, four fields: the COUNT is of activities, so it must not read as four.
  const run = syncHistory(db, '3').find(entry => entry.runStatus === RUN_STATUS.SUCCESS
    && entry.changed === 1);
  assert.ok(run, 'the run counted one changed ACTIVITY, not four changes');
  await worker.stop();
});

test('identical source data on a later cycle writes no duplicate change event', async () => {
  const { worker, db, clock } = createWorker();
  worker.start();
  await settled(worker);
  const after = changeLog(db, '3').length;

  for (let index = 0; index < 4; index += 1) {
    await clock.advance(60_000);
    await settled(worker);
  }
  assert.equal(changeLog(db, '3').length, after,
    'four more identical cycles, no new change rows');
  const runs = syncHistory(db, '3');
  assert.equal(runs.filter(run => run.runStatus === RUN_STATUS.SUCCESS).length, 5,
    'each cycle is still recorded as a run — a read did happen');
  assert.ok(runs.every(run => run.runStatus !== RUN_STATUS.SUCCESS || run.changed === 0
    || run.new === 1));
  await worker.stop();
});

test('a closed work package is synchronised with its status, not silently dropped', async () => {
  const stub = stubOpenProject({ workPackages: [WP38, WP41] });
  const { worker, db } = createWorker({ stub });
  await worker.run({ trigger: TRIGGER.MANUAL });
  await settled(worker);
  const closed = storedActivities(db, '3').find(entry => entry.externalActivityId === '41');
  assert.ok(closed, 'the closed activity is present');
  assert.equal(closed.status, 'Closed');
  assert.equal(closed.reportedProgressPct, 100);
  // The reason it is present: OpenProject filters the collection to open statuses unless told not
  // to, so a completed activity would otherwise be indistinguishable from a deleted one.
  const query = stub.collectionCalls()[0].search;
  assert.match(query, /filters=%5B%5D/);
  await worker.stop();
});

test('pagination is followed to the end; returned and total are separate figures', async () => {
  const many = Array.from({ length: 5 }, (_, index) => ({ ...WP38, id: 100 + index,
    subject: `Activity ${index}`, lockVersion: 1,
    _links: { ...WP38._links, self: { href: `/api/v3/work_packages/${100 + index}` } } }));
  const pages = [
    { offset: 1, body: { ...collection(many.slice(0, 2), { total: 5, count: 2, pageSize: 2,
      offset: 1 }), _links: { nextByOffset: { href: '/api/v3/projects/3/work_packages?offset=2&pageSize=2' } } } },
    { offset: 2, body: { ...collection(many.slice(2, 4), { total: 5, count: 2, pageSize: 2,
      offset: 2 }), _links: { nextByOffset: { href: '/api/v3/projects/3/work_packages?offset=3&pageSize=2' } } } },
    { offset: 3, body: collection(many.slice(4), { total: 5, count: 1, pageSize: 2, offset: 3 }) },
  ];
  const stub = stubOpenProject({ pages });
  const { worker, db } = createWorker({ stub });
  const run = await worker.run({ trigger: TRIGGER.MANUAL });
  await settled(worker);

  assert.equal(run.runStatus, RUN_STATUS.SUCCESS);
  assert.equal(run.returned, 5, 'all five, not the first page');
  assert.equal(run.collectionTotal, 5);
  assert.equal(storedActivities(db, '3').length, 5);
  assert.ok(stub.collectionCalls().length >= 3, 'three pages were walked');
  await worker.stop();
});

test('an incomplete walk is PARTIAL and infers no deletion', async () => {
  // Two activities are known. Then the collection claims 2 but returns only one.
  const stub = stubOpenProject({ workPackages: [WP38, WP41] });
  const { worker, db, clock } = createWorker({ stub });
  worker.start();
  await settled(worker);
  assert.equal(storedActivities(db, '3').length, 2);

  stub.state.pages = [{ offset: 1,
    body: collection([WP38], { total: 2, count: 1, pageSize: 100, offset: 1 }) }];
  await clock.advance(60_000);
  await settled(worker);

  const run = syncHistory(db, '3')[0];
  assert.equal(run.runStatus, RUN_STATUS.PARTIAL,
    'a read that is known to be short is neither a success nor a failure');
  assert.equal(storedActivities(db, '3').length, 2,
    'the activity missing from the short page is KEPT: an incomplete collection must not look '
    + 'like a deletion');
  assert.ok(!changeLog(db, '3').some(entry => entry.kind === 'REMOVED'),
    'and no REMOVED is reported');
  await worker.stop();
});

test('a complete read that no longer returns an activity reports REMOVED and keeps the snapshot', async () => {
  const stub = stubOpenProject({ workPackages: [WP38, WP41] });
  const { worker, db, clock } = createWorker({ stub });
  worker.start();
  await settled(worker);
  stub.state.workPackages = [structuredClone(WP38)];
  await clock.advance(60_000);
  await settled(worker);

  const removed = changeLog(db, '3').find(entry => entry.kind === 'REMOVED');
  assert.ok(removed, 'reported, because the retrieval was complete and explicitly scoped');
  assert.equal(removed.externalId, '41');
  assert.equal(storedActivities(db, '3').length, 2,
    'the snapshot is kept — deleted, moved and filtered-out are not yet distinguishable and '
    + 'discarding it would destroy the evidence');
  await worker.stop();
});

/* ── failure, backoff and parking ─────────────────────────────────────────────────────────── */

test('a failed cycle keeps the previous snapshot and records the failure', async () => {
  const { worker, db, stub, clock } = createWorker();
  worker.start();
  await settled(worker);
  const before = storedActivities(db, '3');
  assert.equal(before.length, 1);

  stub.state.fail = { status: 500, body: opError('x', 'Internal error') };
  await clock.advance(60_000);
  await settled(worker);

  assert.deepEqual(storedActivities(db, '3').map(entry => entry.sourceRevision),
    before.map(entry => entry.sourceRevision), 'untouched');
  const run = syncHistory(db, '3')[0];
  assert.equal(run.runStatus, RUN_STATUS.FAILED);
  assert.match(run.reason, /HTTP 500/);
  assert.equal(run.received, 0);
  // And the stored view can tell: the newest run is not the newest SUCCESSFUL one.
  assert.notEqual(lastFetch(db, '3').id, lastSuccessfulFetch(db, '3').id);
  await worker.stop();
});

test('a rejected token PARKS the worker instead of retrying for ever', async () => {
  const { worker, stub, clock } = createWorker();
  stub.state.fail = { status: 401, body: opError('urn:...:Unauthenticated', 'You need to be '
    + 'authenticated.') };
  worker.start();
  await settled(worker);

  assert.equal(worker.state, WORKER_STATE.AUTH_PARKED);
  assert.equal(clock.pending().length, 0, 'no timer: a credential OpenProject rejected will be '
    + 'rejected again, and a client that keeps trying looks like a brute-force attempt');
  const reads = stub.collectionCalls().length;
  await clock.advance(60 * 60_000);
  assert.equal(stub.collectionCalls().length, reads, 'an hour later, still no retry');
  assert.match(worker.status().parkedReason, /OPENPROJECT_API_TOKEN/);
  await worker.stop();
});

test('a parked worker still answers Sync Now, which is how you recover', async () => {
  const { worker, stub, clock } = createWorker();
  stub.state.fail = { status: 401, body: opError('x', 'nope') };
  worker.start();
  await settled(worker);
  assert.equal(worker.state, WORKER_STATE.AUTH_PARKED);

  stub.state.fail = null;
  const run = await worker.run({ trigger: TRIGGER.MANUAL });
  await settled(worker);
  assert.equal(run.runStatus, RUN_STATUS.SUCCESS);
  assert.equal(worker.status().parkedReason, null, 'the park is cleared by a run that worked');
  assert.equal(clock.pending().length, 1, 'and polling resumes');
  await worker.stop();
});

test('backoff grows with consecutive failures and never applies to an auth failure', () => {
  const interval = 60;
  assert.equal(backoffFor({ failures: 1, state: STATE.CONNECTION_FAILED, intervalSeconds: interval }), 60);
  assert.equal(backoffFor({ failures: 2, state: STATE.CONNECTION_FAILED, intervalSeconds: interval }), 120);
  assert.equal(backoffFor({ failures: 3, state: STATE.CONNECTION_FAILED, intervalSeconds: interval }), 240);
  // Bounded: it plateaus rather than growing until the next attempt is next week.
  assert.equal(backoffFor({ failures: 99, state: STATE.CONNECTION_FAILED, intervalSeconds: interval }),
    backoffFor({ failures: 5, state: STATE.CONNECTION_FAILED, intervalSeconds: interval }));
  assert.equal(backoffFor({ failures: 1, state: STATE.AUTH_FAILED, intervalSeconds: interval }), null,
    'null means park, not "wait longer"');
});

test('a transient failure backs off and then recovers to the plain interval', async () => {
  const { worker, stub, clock } = createWorker();
  worker.start();
  await settled(worker);
  stub.state.fail = { status: 503, body: opError('x', 'try later') };

  await clock.advance(60_000);
  await settled(worker);
  assert.equal(worker.status().consecutiveFailures, 1);
  assert.equal(clock.pending()[0].ms, 60_000, 'one interval after the first failure');

  await clock.advance(60_000);
  await settled(worker);
  assert.equal(worker.status().consecutiveFailures, 2);
  assert.equal(clock.pending()[0].ms, 120_000, 'two intervals after the second');

  stub.state.fail = null;
  await clock.advance(120_000);
  await settled(worker);
  assert.equal(worker.status().consecutiveFailures, 0);
  assert.equal(clock.pending()[0].ms, 60_000, 'back to the configured interval');
  await worker.stop();
});

test('HTTP 429 is honoured for as long as Retry-After asked', async () => {
  const { worker, db, stub, clock } = createWorker();
  worker.start();
  await settled(worker);
  stub.state.fail = { status: 429, body: opError('x', 'Too many requests'),
    headers: { 'retry-after': '300' } };

  await clock.advance(60_000);
  await settled(worker);
  assert.equal(clock.pending()[0].ms, 300_000,
    'five minutes, because that is what OpenProject asked for — guessing shorter than a published '
    + 'figure is how a client earns a ban');
  assert.equal(syncHistory(db, '3')[0].runStatus, RUN_STATUS.FAILED);
  assert.match(syncHistory(db, '3')[0].reason, /rate-limiting/);
  await worker.stop();
});

test('Retry-After is never allowed to park the worker indefinitely', () => {
  assert.equal(parseRetryAfter('999999'), 900, 'capped');
  assert.equal(backoffFor({ failures: 1, state: STATE.CONNECTION_FAILED, retryAfterSeconds: 5,
    intervalSeconds: 60 }), 60, 'and never shorter than one interval');
});

test('the database being unavailable is reported, not thrown', async () => {
  const stub = stubOpenProject();
  const adapter = createOpenProjectAdapter({ env: ENV, fetchImpl: stub.fetchImpl, logger: quiet });
  const worker = createOpenProjectSyncWorker({ adapter: () => adapter, db: () => null,
    env: ENV, logger: quiet, manualMinIntervalMs: 0 });
  const run = await worker.run({ trigger: TRIGGER.MANUAL });
  assert.equal(run.runStatus, RUN_STATUS.FAILED);
  assert.match(run.reason, /database is unavailable/);
  assert.equal(stub.calls.length, 0, 'and nothing was read, because there was nowhere to put it');
  await worker.stop();
});

/* ── read-only, and isolated ──────────────────────────────────────────────────────────────── */

test('the worker issues GET only — never POST, PATCH or DELETE', async () => {
  const { worker, stub, clock } = createWorker();
  worker.start();
  await settled(worker);
  stub.update({ percentageDone: 70, lockVersion: 3 });
  await clock.advance(60_000);
  await settled(worker);
  assert.ok(stub.calls.length > 0);
  for (const call of stub.calls) {
    assert.equal(call.method, 'GET', `${call.path} was a ${call.method}`);
  }
  await worker.stop();
});

test('the worker never calls the brief\'s /api/v3/workspaces path', async () => {
  const { worker, stub, clock } = createWorker();
  worker.start();
  await settled(worker);
  await clock.advance(60_000);
  await settled(worker);
  // `workspaces` is not an OpenProject API v3 route and answers 404; the project-scoped
  // collection is `/api/v3/projects/{id}/work_packages`.
  assert.ok(!stub.calls.some(call => call.path.includes('workspaces')));
  assert.ok(stub.calls.some(call => call.path === '/api/v3/projects/3/work_packages'));
  await worker.stop();
});

test('an unattended cycle does not touch the synthetic P6 activities', async () => {
  const { worker, db, stub, clock } = createWorker();
  const p6 = () => db.prepare('SELECT activity_id, pct_complete, rev FROM src_p6_activity '
    + 'ORDER BY activity_id').all();
  worker.start();
  await settled(worker);
  const before = p6();
  assert.ok(before.length > 0, 'there are synthetic activities to protect');

  stub.update({ percentageDone: 95, lockVersion: 6 });
  await clock.advance(60_000);
  await settled(worker);

  assert.deepEqual(p6(), before,
    'the live figure moved to 95% and not one synthetic P6 row changed');
  await worker.stop();
});

test('an unattended cycle opens no sync_run and proposes no write-back', async () => {
  const { worker, db, clock } = createWorker();
  const counts = () => ({
    runs: db.prepare('SELECT COUNT(*) n FROM sync_run').get().n,
    proposals: db.prepare('SELECT COUNT(*) n FROM outbound_proposal').get().n,
    drafts: db.prepare('SELECT COUNT(*) n FROM p6_update_draft').get().n,
    observations: db.prepare('SELECT COUNT(*) n FROM progress_observation').get().n,
    activities: db.prepare('SELECT COUNT(*) n FROM activity').get().n,
    costs: db.prepare('SELECT COUNT(*) n FROM cost').get().n,
  });
  const before = counts();
  worker.start();
  await settled(worker);
  await clock.advance(60_000);
  await settled(worker);
  assert.deepEqual(counts(), before,
    'a row in sync_run means records were written into SYNCHRO 4D, and reading a schedule writes '
    + 'nothing');
  await worker.stop();
});

test('an unattended cycle can propose a mapping but never approve one', async () => {
  const { worker, db } = createWorker();
  await worker.run({ trigger: TRIGGER.STARTUP });
  await settled(worker);
  const links = db.prepare('SELECT status, decided_at, decided_by FROM live_schedule_link').all();
  for (const link of links) {
    assert.equal(link.status, 'PROPOSED');
    assert.equal(link.decided_at, null);
    assert.equal(link.decided_by, null);
  }
  await worker.stop();
});

test('the run record and the published event carry no credential', async () => {
  const published = [];
  const { worker, db, clock } = createWorker({ published });
  worker.start();
  await settled(worker);
  await clock.advance(60_000);
  await settled(worker);

  const serialized = JSON.stringify({ published, history: syncHistory(db, '3'),
    status: worker.status(), snapshots: storedActivities(db, '3'),
    audit: db.prepare('SELECT * FROM audit_event').all() });
  assert.ok(!serialized.includes(TOKEN), 'the token appears nowhere that is stored or published');
  // Narrow on purpose: `SOURCE.protocol` contains the words "Basic auth" as PROSE, and a sweep
  // for /Basic/ would fail on a correct description of the protocol.
  assert.ok(!/Basic [A-Za-z0-9+/=]{16,}/.test(serialized),
    'and no encoded Authorization header value either');
  await worker.stop();
});

test('an upstream that echoes the token in its error body does not get it into the record', async () => {
  const { worker, db, stub } = createWorker();
  // The real leak this guard was written for: a 401 body quoting the credential back at us.
  stub.state.fail = { status: 401,
    body: opError('x', `apikey ${TOKEN} is not valid for this instance`) };
  await worker.run({ trigger: TRIGGER.MANUAL });
  await settled(worker);
  const serialized = JSON.stringify({ history: syncHistory(db, '3'),
    audit: db.prepare('SELECT * FROM audit_event').all(), status: worker.status() });
  assert.ok(!serialized.includes(TOKEN), 'scrubbed before it was stored');
  assert.match(serialized, /\[redacted\]/);
  await worker.stop();
});

/* ── notification ─────────────────────────────────────────────────────────────────────────── */

test('a completed cycle publishes a lightweight notification', async () => {
  const published = [];
  const { worker, stub, clock } = createWorker({ published });
  worker.start();
  await settled(worker);
  published.length = 0;

  stub.update({ percentageDone: 50, lockVersion: 2 });
  await clock.advance(60_000);
  await settled(worker);

  assert.equal(published.length, 1);
  const [event] = published;
  assert.equal(event.event, SYNC_EVENT);
  assert.equal(event.data.projectId, 3);
  assert.equal(event.data.changedActivities, 1);
  assert.equal(event.data.runStatus, RUN_STATUS.SUCCESS);
  assert.equal(event.data.trigger, TRIGGER.SCHEDULED);
  assert.ok(event.data.syncRunId);
  assert.ok(event.data.completedAt);
  // IDS AND COUNTS ONLY. No work-package payload: the client re-reads the normalizing endpoint,
  // so there is one source of truth for the data and a dropped event costs one interval.
  assert.ok(!JSON.stringify(event.data).includes('Cast Level 2 Columns'));
  await worker.stop();
});

test('a FAILED cycle publishes nothing — there is no new data to go and read', async () => {
  const published = [];
  const { worker, stub, clock } = createWorker({ published });
  worker.start();
  await settled(worker);
  published.length = 0;
  stub.state.fail = { status: 500, body: opError('x', 'boom') };
  await clock.advance(60_000);
  await settled(worker);
  assert.equal(published.length, 0);
  await worker.stop();
});

test('a subscriber that throws does not fail the run that was already committed', async () => {
  const stub = stubOpenProject();
  const adapter = createOpenProjectAdapter({ env: ENV, fetchImpl: stub.fetchImpl, logger: quiet });
  const db = openConstructionDb({ path: ':memory:' });
  const worker = createOpenProjectSyncWorker({ adapter: () => adapter, db: () => db,
    publish: () => { throw new Error('the hub exploded'); },
    env: ENV, logger: quiet, manualMinIntervalMs: 0 });
  const run = await worker.run({ trigger: TRIGGER.MANUAL });
  await settled(worker);
  assert.equal(run.runStatus, RUN_STATUS.SUCCESS);
  assert.equal(storedActivities(db, '3').length, 1, 'the data is stored regardless');
  await worker.stop();
});

/* ── the SSE hub ──────────────────────────────────────────────────────────────────────────── */

/** A response object that records what was written to it. */
function fakeResponse() {
  const chunks = [];
  const handlers = new Map();
  return {
    chunks, headers: null, ended: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; return this; },
    flushHeaders() {},
    write(chunk) { chunks.push(chunk); return true; },
    end() { this.ended = true; },
    on(event, handler) { handlers.set(event, handler); return this; },
    fire(event) { handlers.get(event)?.(); },
    text: () => chunks.join(''),
  };
}

const fakeRequest = () => {
  const handlers = new Map();
  return { on(event, handler) { handlers.set(event, handler); return this; },
    fire(event) { handlers.get(event)?.(); } };
};

test('the hub sends an SSE frame to every subscriber', () => {
  const hub = createSseHub({ logger: quiet });
  const a = fakeResponse();
  const b = fakeResponse();
  assert.equal(hub.subscribe(fakeRequest(), a), true);
  assert.equal(hub.subscribe(fakeRequest(), b), true);
  assert.equal(hub.size, 2);
  assert.equal(a.status, 200);
  assert.equal(a.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(a.headers['cache-control'], 'no-store, no-transform');
  assert.equal(a.headers['x-accel-buffering'], 'no',
    'nginx buffers a proxied response by default, which holds every event until the buffer fills');

  const reached = hub.publish('openproject-sync-completed', { syncRunId: 'r1', changedActivities: 2 });
  assert.equal(reached, 2);
  for (const client of [a, b]) {
    assert.match(client.text(), /event: openproject-sync-completed/);
    assert.match(client.text(), /data: \{"syncRunId":"r1","changedActivities":2\}/);
    assert.match(client.text(), /\n\n$/, 'every frame is terminated by a blank line');
  }
  hub.close();
});

test('a multi-line payload is split per line so it cannot end the frame early', () => {
  const hub = createSseHub({ logger: quiet });
  const frame = hub.frame('x', 'one\ntwo');
  assert.equal(frame, 'event: x\ndata: one\ndata: two\n\n');
  hub.close();
});

test('the hub forgets a subscriber that disconnects', () => {
  const hub = createSseHub({ logger: quiet });
  const res = fakeResponse();
  const req = fakeRequest();
  hub.subscribe(req, res);
  assert.equal(hub.size, 1);
  req.fire('close');
  assert.equal(hub.size, 0);
  assert.equal(hub.publish('x', {}), 0, 'and writes to nobody');
  hub.close();
});

test('the hub drops a subscriber whose socket throws, rather than failing the publish', () => {
  const hub = createSseHub({ logger: quiet });
  const good = fakeResponse();
  const bad = fakeResponse();
  hub.subscribe(fakeRequest(), good);
  hub.subscribe(fakeRequest(), bad);
  bad.write = () => { throw new Error('EPIPE'); };
  hub.publish('x', { n: 1 });
  assert.equal(hub.size, 1, 'the broken one is gone');
  assert.match(good.text(), /"n":1/, 'and the good one still got it');
  hub.close();
});

test('the hub is bounded and refuses rather than silently accepting', () => {
  const hub = createSseHub({ logger: quiet, maxSubscribers: 2 });
  assert.equal(hub.subscribe(fakeRequest(), fakeResponse()), true);
  assert.equal(hub.subscribe(fakeRequest(), fakeResponse()), true);
  assert.equal(hub.subscribe(fakeRequest(), fakeResponse()), false,
    'false, so the route answers 503 rather than handing back a dead connection');
  hub.close();
  assert.equal(hub.subscribe(fakeRequest(), fakeResponse()), false, 'and a closed hub takes none');
});

/* ── the HTTP routes ──────────────────────────────────────────────────────────────────────── */

test('GET /openproject/sync/status reports the worker without calling OpenProject', async () => {
  const { call, stub } = createApi();
  const { status, payload } = await call('/openproject/sync/status');
  assert.equal(status, 200);
  assert.equal(payload.source.system, 'OPENPROJECT', 'the framed provenance object survives');
  assert.equal(payload.sourceSystem, 'OPENPROJECT');
  assert.equal(payload.enabled, true);
  assert.equal(payload.intervalSeconds, 60);
  assert.equal(payload.eventName, SYNC_EVENT);
  assert.match(payload.scope, /Read-only/);
  assert.match(payload.scheduling, /Single-process/);
  assert.equal(stub.calls.length, 0,
    'asking "are you polling?" must not itself become a poll of somebody\'s cloud instance');
});

test('the status endpoint stays small: it carries no work-package payload', async () => {
  const { call } = createApi();
  const headers = await withSession(call);
  await call('/openproject/sync/run', { method: 'POST', body: {}, headers });
  const { payload } = await call('/openproject/sync/status');
  assert.equal(payload.lastRun.runStatus, RUN_STATUS.SUCCESS);
  assert.ok(!Object.hasOwn(payload.lastRun, 'detail'),
    'the whole adapter result must not ride along on an endpoint a screen polls every ten seconds');
  assert.ok(!JSON.stringify(payload).includes('Cast Level 2 Columns'));
  assert.ok(payload.lastRun.counts, 'the counts are still there, because they are the point');
});

test('the status endpoint never reports a connection it has not tested', async () => {
  const { call } = createApi();
  const { payload } = await call('/openproject/sync/status');
  assert.equal(payload.lastRun, null);
  assert.equal(payload.lastSuccessfulFetchAt, null);
  assert.deepEqual(payload.history, []);
});

test('POST /openproject/sync/run needs a session, and says who may instead', async () => {
  const { call } = createApi();
  const refused = await call('/openproject/sync/run', { method: 'POST', body: {} });
  assert.equal(refused.status, 403);
  assert.match(refused.payload.error, /No demo session/);

  const headers = await withSession(call);
  const allowed = await call('/openproject/sync/run', { method: 'POST', body: {}, headers });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.payload.run.runStatus, RUN_STATUS.SUCCESS);
  assert.equal(allowed.payload.run.trigger, TRIGGER.MANUAL);
  assert.match(allowed.payload.effect, /No synchronisation run was opened/);
});

test('Sync Now records who asked for it', async () => {
  const { call, api } = createApi();
  const headers = await withSession(call, 'planner');
  await call('/openproject/sync/run', { method: 'POST', body: {}, headers });
  const { payload } = await call('/openproject/sync/history');
  assert.match(payload.runs[0].actor, /Planner/);
  await api.close();
});

test('GET /openproject/sync/history lists every run, skips included', async () => {
  const { call } = createApi();
  const headers = await withSession(call);
  await call('/openproject/sync/run', { method: 'POST', body: {}, headers });
  const { status, payload } = await call('/openproject/sync/history');
  assert.equal(status, 200);
  assert.equal(payload.runs.length, 1);
  const [run] = payload.runs;
  assert.equal(run.runStatus, RUN_STATUS.SUCCESS);
  assert.equal(run.trigger, TRIGGER.MANUAL);
  assert.ok(run.runId, 'a run id, so a notification can be correlated without guessing');
  assert.ok(run.startedAt && run.finishedAt);
  assert.ok(run.durationMs >= 0);
  assert.equal(run.received, 1);
  assert.deepEqual(payload.statuses, RUN_STATUS);
  assert.deepEqual(payload.triggers, TRIGGER);
});

test('the elapsed HTTP time and the whole-cycle duration are separate figures', async () => {
  const { call } = createApi();
  const headers = await withSession(call);
  await call('/openproject/sync/run', { method: 'POST', body: {}, headers });
  const { payload } = await call('/openproject/sync/history');
  const [run] = payload.runs;
  assert.ok(Object.hasOwn(run, 'elapsedMs'));
  assert.ok(Object.hasOwn(run, 'durationMs'));
  assert.notEqual('elapsedMs', 'durationMs');
});

test('GET /openproject/events holds the response open and says hello', async () => {
  const { call, api } = createApi();
  let status = null;
  const res = fakeResponse();
  res.writeHead = (code, headers) => { status = code; res.headers = headers; return res; };
  const req = { method: 'GET', url: '/api/construction/openproject/events', headers: {},
    on(event, handler) { if (event === 'x') handler(); return this; } };
  await api.handle(req, res);
  assert.equal(status, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.match(res.text(), /event: openproject-sync-hello/);
  assert.equal(res.ended, false, 'still open');
  await api.close();
  assert.equal(res.ended, true, 'and hung up when the API closed');
  assert.ok(status);
  assert.ok(call);
});

test('POST /openproject/refresh goes through the worker, so there is ONE writer', async () => {
  const { call, stub } = createApi();
  const { payload } = await call('/openproject/refresh', { method: 'POST', body: {} });
  // The Phase 8A response shape is unchanged...
  assert.equal(payload.counts.new, 1);
  assert.ok(Array.isArray(payload.diffs));
  assert.match(payload.effect, /No synchronisation run was opened/);
  // ...and it now carries the run it went through.
  assert.equal(payload.run.trigger, TRIGGER.MANUAL);
  assert.equal(payload.run.runStatus, RUN_STATUS.SUCCESS);
  assert.ok(stub.collectionCalls().length >= 1);
});

test('the stored view states the filter policy too, so the disclosure survives a background update', async () => {
  const { call } = createApi();
  const headers = await withSession(call);
  await call('/openproject/sync/run', { method: 'POST', body: {}, headers });
  const { payload } = await call('/openproject/work-packages');
  // Not a property of one request: it is how this adapter always asks, and the panel re-reads
  // THIS endpoint after every background cycle.
  assert.equal(payload.filtersApplied.length, 1);
  assert.equal(payload.filtersApplied[0].value, '[]');
  assert.match(payload.filtersApplied[0].reason, /open statuses/);
});

test('the SSE route is the only new browser-facing endpoint, and takes no upstream URL', async () => {
  const { call } = createApi();
  // Nothing accepts a host, a path or a credential from the caller.
  for (const path of ['/openproject/sync/status', '/openproject/sync/history']) {
    const { payload } = await call(`${path}?url=https://evil.example/api/v3/projects/3`);
    assert.ok(!JSON.stringify(payload).includes('evil.example'));
  }
  const unknown = await call('/openproject/sync/anything');
  assert.equal(unknown.status, 404);
});

/* ── one worker per process ───────────────────────────────────────────────────────────────── */

test('acquireSyncWorker returns the SAME worker for a key, so a reload arms no second timer', () => {
  resetSyncWorkerRegistry();
  let built = 0;
  const factory = () => { built += 1; return { id: built, stopped: false }; };
  const first = acquireSyncWorker('demo', factory);
  const second = acquireSyncWorker('demo', factory);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.worker, second.worker);
  assert.equal(built, 1, 'Vite re-evaluating the module graph must not double the polling');
  assert.equal(syncWorkerRefs('demo'), 2);

  assert.equal(releaseSyncWorker('demo', first.worker), false,
    'false: somebody else still holds it, and stopping it would kill their polling');
  assert.equal(releaseSyncWorker('demo', first.worker), true, 'the LAST holder stops it');
  const third = acquireSyncWorker('demo', factory);
  assert.equal(third.created, true, 'after the last release, the next host gets a fresh one');
  resetSyncWorkerRegistry();
});

test('THE RESTART BUG: the last holder stops the worker, not the one that made it', () => {
  /*
   * On a Vite config restart two APIs coexist in one process and the order is not ours to choose.
   * The order that broke it: the NEW api adopts the live worker, then the OLD api closes. If the
   * old one stopped "the worker it created", the new server would hold a stopped worker and
   * nothing would ever poll again — which is exactly what the dev server's log showed.
   */
  resetSyncWorkerRegistry();
  const worker = { id: 'live', stopped: false };
  const oldApi = acquireSyncWorker('demo', () => worker);
  const newApi = acquireSyncWorker('demo', () => ({ id: 'should-not-be-built' }));
  assert.equal(newApi.worker, worker, 'the new api adopted the running worker');

  assert.equal(releaseSyncWorker('demo', worker), false,
    'the old api lets go and must NOT stop it — the new api is using it');
  assert.equal(syncWorkerRefs('demo'), 1);
  assert.equal(releaseSyncWorker('demo', worker), true,
    'and when the new api finally closes, that one stops it');
  assert.ok(oldApi.created);
  resetSyncWorkerRegistry();
});

test('a STOPPED worker is never handed out again', () => {
  resetSyncWorkerRegistry();
  const dead = { id: 'dead', stopped: true };
  acquireSyncWorker('demo', () => dead);
  const next = acquireSyncWorker('demo', () => ({ id: 'fresh', stopped: false }));
  assert.equal(next.created, true);
  assert.notEqual(next.worker, dead, 'a stopped worker can never poll again');
  resetSyncWorkerRegistry();
});

test('releasing a worker that is not the registered one does nothing', () => {
  resetSyncWorkerRegistry();
  const { worker } = acquireSyncWorker('demo', () => ({ id: 'a', stopped: false }));
  assert.equal(releaseSyncWorker('demo', { id: 'b' }), false);
  assert.equal(syncWorkerRefs('demo'), 1, 'and does not decrement somebody else\'s count');
  assert.equal(acquireSyncWorker('demo', () => ({ id: 'c' })).worker, worker);
  resetSyncWorkerRegistry();
});

test('THE SECOND RESTART BUG: an adopted worker is rebound to the live server', async () => {
  /*
   * The refcount fix made the worker survive a restart. This one makes it survive USEFULLY: it
   * used to keep the closures of the API that created it, so when that API closed its database
   * handle the surviving worker logged `database is not open` on every cycle for ever — still
   * polling, no longer able to store anything. Found in the dev server's log, not in a test.
   */
  const first = stubOpenProject();
  const firstDb = openConstructionDb({ path: ':memory:' });
  const published = [];
  const worker = createOpenProjectSyncWorker({
    adapter: () => createOpenProjectAdapter({ env: ENV, fetchImpl: first.fetchImpl, logger: quiet }),
    db: () => firstDb, publish: (event, data) => published.push({ event, data }),
    env: ENV, logger: quiet, manualMinIntervalMs: 0 });
  await worker.run({ trigger: TRIGGER.STARTUP });
  await settled(worker);
  assert.equal(storedActivities(firstDb, '3').length, 1);

  // The "restarted server": a new stub, a new database, a new hub.
  const second = stubOpenProject({ workPackages: [WP38, WP41] });
  const secondDb = openConstructionDb({ path: ':memory:' });
  const rePublished = [];
  worker.rebind({
    adapter: () => createOpenProjectAdapter({ env: ENV, fetchImpl: second.fetchImpl, logger: quiet }),
    db: () => secondDb, publish: (event, data) => rePublished.push({ event, data }) });

  // The old server's handle goes away, exactly as `api.close()` does it.
  firstDb.close();

  const run = await worker.run({ trigger: TRIGGER.SCHEDULED });
  await settled(worker);
  assert.equal(run.runStatus, RUN_STATUS.SUCCESS, 'not "database is not open"');
  assert.equal(storedActivities(secondDb, '3').length, 2, 'it wrote to the LIVE database');
  assert.equal(rePublished.length, 1, 'and notified the live event hub');
  assert.ok(second.collectionCalls().length >= 1, 'through the live adapter');
  await worker.stop();
});

test('a rebind cannot split one cycle across two servers', async () => {
  const first = stubOpenProject();
  first.state.delayMs = 40;
  const firstDb = openConstructionDb({ path: ':memory:' });
  const secondDb = openConstructionDb({ path: ':memory:' });
  const worker = createOpenProjectSyncWorker({
    adapter: () => createOpenProjectAdapter({ env: ENV, fetchImpl: first.fetchImpl, logger: quiet }),
    db: () => firstDb, env: ENV, logger: quiet, manualMinIntervalMs: 0 });

  const running = worker.run({ trigger: TRIGGER.MANUAL });
  await flush(1);
  // Rebind while the cycle is in flight. The cycle captured its dependencies at the top, so this
  // must take effect on the NEXT cycle — a run that read through one server and wrote through
  // another's handle would be a genuinely confusing record.
  worker.rebind({ db: () => secondDb });
  await running;
  await settled(worker);
  assert.equal(storedActivities(firstDb, '3').length, 1, 'the in-flight cycle finished where it started');
  assert.equal(storedActivities(secondDb, '3').length, 0);

  await worker.run({ trigger: TRIGGER.MANUAL });
  await settled(worker);
  assert.equal(storedActivities(secondDb, '3').length, 1, 'and the next one went to the new one');
  await worker.stop();
});

test('closing an API releases its hold, and a second API in the process keeps polling', async () => {
  resetSyncWorkerRegistry();
  const key = 'restart-test';
  const a = createConstructionApi({ path: ':memory:', logger: quiet,
    openProjectOptions: { env: ENV, fetchImpl: stubOpenProject().fetchImpl },
    autoSync: false, syncOptions: { workerKey: key, manualMinIntervalMs: 0 } });
  const b = createConstructionApi({ path: ':memory:', logger: quiet,
    openProjectOptions: { env: ENV, fetchImpl: stubOpenProject().fetchImpl },
    autoSync: false, syncOptions: { workerKey: key, manualMinIntervalMs: 0 } });
  // Both ask for the worker, as the two servers would.
  assert.equal(a.syncStatus().enabled, true);
  assert.equal(b.syncStatus().enabled, true);
  assert.equal(syncWorkerRefs(key), 2);

  await a.close();
  assert.equal(b.syncStatus().state, WORKER_STATE.IDLE,
    'the surviving API\'s worker is still alive and not STOPPED');
  await b.close();
  assert.equal(syncWorkerRefs(key), 0);
  resetSyncWorkerRegistry();
});

test('the registry is per process, under a well-known symbol rather than a module variable', () => {
  resetSyncWorkerRegistry();
  acquireSyncWorker('demo', () => ({ id: 'a', stopped: false }));
  const registry = globalThis[Symbol.for('i595.construction.openProjectSyncWorkers')];
  assert.ok(registry instanceof Map);
  assert.ok(registry.has('demo'),
    'a module-level variable is per module INSTANCE, which is not the scope the uniqueness claim '
    + 'is about');
  resetSyncWorkerRegistry();
});

test('stop() is idempotent and leaves no timer behind', async () => {
  const { worker, clock, stub } = createWorker();
  worker.start();
  await settled(worker);
  await worker.stop();
  await worker.stop();
  assert.equal(worker.state, WORKER_STATE.STOPPED);
  assert.equal(clock.pending().length, 0);
  const reads = stub.collectionCalls().length;
  await clock.advance(10 * 60_000);
  assert.equal(stub.collectionCalls().length, reads);
  const after = await worker.run({ trigger: TRIGGER.MANUAL });
  assert.equal(after.runStatus, RUN_STATUS.SKIPPED, 'a stopped worker runs nothing');
});

test('stop() waits for the cycle in flight rather than cutting it off mid-transaction', async () => {
  const { worker, db, stub } = createWorker();
  stub.state.delayMs = 40;
  const running = worker.run({ trigger: TRIGGER.MANUAL });
  await flush(1);
  await worker.stop();
  assert.equal(worker.inFlight, null, 'stop() returned only once the cycle had finished');
  await running;
  assert.equal(storedActivities(db, '3').length, 1, 'and its writes are committed');
});

/* ── the status row ───────────────────────────────────────────────────────────────────────── */

test('relative() signs the distance so a reader never has to work out which side of now', () => {
  const now = Date.parse('2026-11-11T10:00:00.000Z');
  assert.equal(relative('2026-11-11T10:00:42.000Z', now), 'in 42 s');
  assert.equal(relative('2026-11-11T09:57:00.000Z', now), '3 min ago');
  assert.equal(relative('2026-11-11T08:00:00.000Z', now), '2 h ago');
  assert.equal(relative('2026-11-11T10:00:02.000Z', now), 'any moment');
  assert.equal(relative(null, now), null);
  assert.equal(relative('not a date', now), null);
});

test('automatic sync being OFF reads as a configured choice, not a failure', () => {
  const markup = syncRowMarkup({ enabled: false, configured: true, state: 'DISABLED',
    intervalSeconds: 60, lastRun: null, lastSuccessfulFetchAt: null, scope: 'Read-only.',
    enableHint: 'Set it in .env.local — here is how to turn it on.' },
  Date.parse('2026-11-11T10:00:00.000Z'));
  assert.match(markup, /data-tone="info"/, 'info, never bad');
  assert.match(markup, /Auto-sync: Off/);
  assert.match(markup, /Disabled/);
  assert.match(markup, /how to turn it on/, 'and says how to turn it on');
  assert.ok(!/data-tone="bad"/.test(markup));
});

test('a parked worker shows the reason and NO next scheduled sync', () => {
  const markup = syncRowMarkup({ enabled: true, configured: true, state: 'AUTH_PARKED',
    intervalSeconds: 60, nextRunAt: '2026-11-11T10:01:00.000Z',
    parkedReason: 'OpenProject rejected the API token.',
    lastRun: { runStatus: 'FAILED', trigger: 'SCHEDULED', durationMs: 120 },
    lastSuccessfulFetchAt: '2026-11-11T09:00:00.000Z', scope: 'Read-only.' },
  Date.parse('2026-11-11T10:00:00.000Z'));
  assert.match(markup, /data-op-parked="true"/);
  assert.match(markup, /rejected the API token/);
  assert.match(markup, /Not scheduled/,
    'a time that will not arrive is worse than saying there is none');
  assert.ok(!/in 60 s/.test(markup));
});

test('a SKIPPED last result is reported as skipped, and is not an error', () => {
  const markup = syncRowMarkup({ enabled: true, configured: true, state: 'IDLE',
    intervalSeconds: 60, nextRunAt: '2026-11-11T10:00:30.000Z',
    lastRun: { runStatus: 'SKIPPED', trigger: 'SCHEDULED', durationMs: 1, counts: null },
    lastSuccessfulFetchAt: '2026-11-11T09:59:00.000Z', scope: 'Read-only.' },
  Date.parse('2026-11-11T10:00:00.000Z'));
  assert.match(markup, /data-op-run="SKIPPED"/);
  assert.match(markup, /Skipped/);
  assert.equal(RUN_LABEL.SKIPPED.tone, 'info');
  assert.match(markup, /in 30 s/);
});

test('"last successful sync" is never filled in from a failed run', () => {
  const markup = syncRowMarkup({ enabled: true, configured: true, state: 'IDLE',
    intervalSeconds: 60, nextRunAt: '2026-11-11T10:01:00.000Z',
    lastRun: { runStatus: 'FAILED', trigger: 'SCHEDULED', durationMs: 90 },
    lastSuccessfulFetchAt: null, scope: 'Read-only.' },
  Date.parse('2026-11-11T10:00:00.000Z'));
  assert.match(markup, /Never/);
  assert.match(markup, /data-op-run="FAILED"/);
});

test('enabled without a token says so plainly', () => {
  const markup = syncRowMarkup({ enabled: true, configured: false, state: 'NOT_CONFIGURED',
    intervalSeconds: 60, lastRun: null, lastSuccessfulFetchAt: null, scope: 'Read-only.',
    configuredReason: 'OPENPROJECT_API_TOKEN is not set on the server.' },
  Date.now());
  assert.match(markup, /OPENPROJECT_API_TOKEN is not set/,
    'the sentence comes from the SERVER — a frontend file that names the credential variable is '
    + 'one careless edit from holding the credential, and a test fails if one does');
  assert.equal(WORKER_LABEL.NOT_CONFIGURED.tone, 'warn');
});

test('an unavailable status row admits it rather than claiming anything', () => {
  const markup = syncRowMarkup(null, Date.now());
  assert.match(markup, /Sync status unknown/);
  assert.ok(!/Connected/.test(markup));
});

test('every status row offers Sync Now, parked or not', () => {
  for (const state of ['DISABLED', 'IDLE', 'AUTH_PARKED', 'NOT_CONFIGURED']) {
    const markup = syncRowMarkup({ enabled: state !== 'DISABLED', configured: true, state,
      intervalSeconds: 60, lastRun: null, lastSuccessfulFetchAt: null, scope: '' }, Date.now());
    assert.match(markup, /data-action="sync-now"/, `for ${state}`);
  }
});
