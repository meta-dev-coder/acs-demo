/**
 * Phase 10B — creating a work package in a system with no idempotency key.
 *
 * Every test here is about the thing that can go wrong rather than the thing that goes right: a
 * double-click, a timeout, a refusal, a mapping that fails after the task exists. The create path
 * is driven through a FAKE adapter that counts its POSTs, because the property under test is "how
 * many work packages did we create", and the only way to assert that is to count.
 *
 * No test reaches the network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openConstructionDb } from '../server/construction/db.mjs';
import { FAILURE, STATE, parseValidationErrors } from '../server/construction/openProjectHttp.mjs';
import { storedActivities } from '../server/construction/openProjectStore.mjs';
import {
  CREATION_STATUS, MAPPING_STATE, RECONCILIATION, buildPayload, claim, creationByKey,
  markerLine, reconcile, reconcileUnknown, retryMapping, runCreation, unresolved, validateRequest,
} from '../server/construction/workPackageCreate.mjs';

const db = () => openConstructionDb({ path: ':memory:' });

/**
 * An OpenProject that can be told how to behave, and that COUNTS what it was asked to do.
 *
 * `posts` is the assertion that matters in half this file: no sequence of clicks, retries or
 * reconciliations may ever take it above one.
 */
function fakeAdapter({ mode = 'ok', formErrors = null } = {}) {
  const state = { posts: 0, forms: 0, searches: 0, created: [], nextId: 100 };
  return {
    state,
    async workPackageForm(payload) {
      state.forms += 1;
      if (formErrors) {
        return { state: STATE.CONNECTED, valid: false, fieldErrors: formErrors, payload: null,
          commit: '/api/v3/work_packages' };
      }
      return { state: STATE.CONNECTED, valid: true, fieldErrors: {}, payload,
        commit: '/api/v3/work_packages' };
    },
    async createWorkPackage(payload) {
      state.posts += 1;
      if (mode === 'timeout') {
        // Sent, no answer. The dangerous case.
        return { state: STATE.CONNECTION_FAILED, failure: FAILURE.TIMEOUT, created: null,
          outcomeUnknown: true, reason: 'No response within 10000 ms.' };
      }
      if (mode === 'refused') {
        return { state: STATE.CONNECTION_FAILED, failure: FAILURE.VALIDATION, created: null,
          outcomeUnknown: false, httpStatus: 422, fieldErrors: { subject: "Subject can't be blank." },
          reason: 'OpenProject rejected the values.' };
      }
      const id = String(state.nextId++);
      const activity = {
        externalActivityId: id, activityName: payload.subject, activityType: 'Task',
        status: 'New', plannedStart: payload.startDate ?? null,
        plannedFinish: payload.dueDate ?? null, reportedProgressPct: 0,
        estimatedTimeRaw: 'P3DT8H', estimatedHours: 80,
        remainingTimeRaw: null, remainingHours: null, parentExternalId: null,
        sourceRevision: 1, sourceUpdatedAt: '2026-11-11T10:00:00Z',
        sourceUrl: `https://example.invalid/work_packages/${id}`,
        description: payload.description?.raw ?? '',
      };
      state.created.push(activity);
      return { state: STATE.CONNECTED, created: activity, outcomeUnknown: false, httpStatus: 201,
        endpoint: '/api/v3/work_packages', fieldErrors: {} };
    },
    async workPackage(id) {
      const found = state.created.find(a => a.externalActivityId === String(id));
      return found ? { state: STATE.CONNECTED, activity: found }
        : { state: STATE.CONNECTION_FAILED, activity: null };
    },
    async findByMarker(marker) {
      state.searches += 1;
      return { state: STATE.CONNECTED,
        matches: state.created.filter(a => String(a.description).includes(marker)) };
    },
  };
}

const REQUEST = { subject: 'Exterior Wall Waterproofing', description: 'Apply waterproofing.',
  startDate: '2026-11-16', dueDate: '2026-11-27', estimatedHours: 80 };

const start = (database, { key = 'key-1', bimContext = null } = {}) =>
  claim(database, { idempotencyKey: key, requested: REQUEST, bimContext, actor: 'Tester',
    actorRole: 'planner', projectId: '3' });

/* ── validation ───────────────────────────────────────────────────────────────────────────── */

test('a request with no name is refused before the source is asked', () => {
  const { ok, errors } = validateRequest({ description: 'x' });
  assert.equal(ok, false);
  assert.equal(errors.subject, 'A task name is required.');
});

test('a finish date before the start date is refused', () => {
  const { errors } = validateRequest({ subject: 'X', startDate: '2026-11-27', dueDate: '2026-11-16' });
  assert.match(errors.dueDate, /on or after the start date/);
});

test('fields outside the allowlist cannot reach the source', () => {
  // A crafted body must not be able to set something this feature never meant to touch.
  const { ok, errors } = validateRequest({ subject: 'X', lockVersion: 9, id: 1 });
  assert.equal(ok, false);
  assert.match(errors.$form, /lockVersion/);
  assert.match(errors.$form, /id/);
});

test('an empty estimate is not an estimate of zero', () => {
  // Number('') is 0 and finite, which is exactly how a blank field becomes a wrong number.
  assert.equal(validateRequest({ subject: 'X', estimatedHours: '' }).ok, true);
  assert.equal(validateRequest({ subject: 'X', estimatedHours: '0' }).ok, false);
});

test('the payload carries the marker in the description and hours as an ISO duration', () => {
  const payload = buildPayload(REQUEST, { marker: 'acs-create-xyz', projectId: '3' });
  assert.match(payload.description.raw, /acs-create-xyz/);
  assert.equal(payload.estimatedTime, 'PT80H');
  assert.equal(payload._links.project.href, '/api/v3/projects/3');
});

test("OpenProject's own field errors survive the HTTP layer", () => {
  // The whole reason a create form can show the source's messages: a 422 is not flattened.
  const parsed = parseValidationErrors({
    _type: 'Error',
    _embedded: { errors: [
      { message: 'Finish date must be greater than or equal to the start date.',
        _embedded: { details: { attribute: 'dueDate' } } },
      { message: "Subject can't be blank.", _embedded: { details: { attribute: 'subject' } } },
    ] },
  });
  assert.deepEqual(parsed, { dueDate: 'Finish date must be greater than or equal to the start date.',
    subject: "Subject can't be blank." });
});

test('a duration normalised by the source still reconciles', () => {
  // We send PT80H; OpenProject stores P3DT8H. Comparing the strings would fail every task.
  const check = reconcile({ subject: 'W', estimatedHours: 80 },
    { activityName: 'W', estimatedTimeRaw: 'P3DT8H', estimatedHours: 80 });
  assert.equal(check.status, RECONCILIATION.MATCHED);
});

test('a date the source changed is reported as a difference, not corrected', () => {
  const check = reconcile({ subject: 'W', startDate: '2026-11-16' },
    { activityName: 'W', plannedStart: '2026-11-17' });
  assert.equal(check.status, RECONCILIATION.DIFFERS);
  assert.deepEqual(check.differences, [{ field: 'startDate', requested: '2026-11-16',
    stored: '2026-11-17' }]);
});

/* ── the happy path ───────────────────────────────────────────────────────────────────────── */

test('a created work package is confirmed, reconciled and cached as an activity', async () => {
  const database = db();
  const adapter = fakeAdapter();
  const { creation } = start(database);
  const result = await runCreation(database, creation.id, { adapter, actor: 'Tester' });

  assert.equal(result.ok, true);
  assert.equal(adapter.state.posts, 1);
  assert.equal(result.creation.status, CREATION_STATUS.RECONCILED);
  assert.equal(result.creation.reconciliation, RECONCILIATION.MATCHED);
  assert.equal(result.creation.workPackageId, '100');

  // Visible as an ordinary activity, in the same table the background sync writes.
  const activities = storedActivities(database, '3');
  assert.equal(activities.length, 1);
  assert.equal(activities[0].externalActivityId, '100');
});

/* ── duplicate prevention: the critical requirement ───────────────────────────────────────── */

test('a second claim of the same key returns the first request, it does not start another',
  () => {
    const database = db();
    const first = start(database);
    const second = start(database);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.creation.id, first.creation.id);
  });

test('a double-click creates exactly one work package', async () => {
  const database = db();
  const adapter = fakeAdapter();
  const { creation } = start(database);
  // Both clicks reach the server before either finishes.
  const [a, b] = await Promise.all([
    runCreation(database, creation.id, { adapter, actor: 'Tester' }),
    runCreation(database, creation.id, { adapter, actor: 'Tester' }),
  ]);
  assert.equal(adapter.state.posts, 1, 'one POST, whatever the browser did');
  assert.equal(a.creation.workPackageId, b.creation.workPackageId);
});

test('a retry after a confirmed creation returns the same task rather than making a second',
  async () => {
    const database = db();
    const adapter = fakeAdapter();
    const { creation } = start(database);
    await runCreation(database, creation.id, { adapter, actor: 'Tester' });
    const again = await runCreation(database, creation.id, { adapter, actor: 'Tester' });
    assert.equal(again.repeat, true);
    assert.equal(adapter.state.posts, 1);
    assert.equal(again.creation.workPackageId, '100');
  });

test('a refresh finds the request by its key and never re-sends it', async () => {
  const database = db();
  const adapter = fakeAdapter();
  const { creation } = start(database, { key: 'after-refresh' });
  await runCreation(database, creation.id, { adapter, actor: 'Tester' });
  // The page reloads and submits the same key again.
  const rejoined = start(database, { key: 'after-refresh' });
  assert.equal(rejoined.created, false);
  assert.equal(rejoined.creation.status, CREATION_STATUS.RECONCILED);
  assert.equal(adapter.state.posts, 1);
});

/* ── the unknown outcome ──────────────────────────────────────────────────────────────────── */

test('a timed-out create is OUTCOME_UNKNOWN, never FAILED', async () => {
  const database = db();
  const adapter = fakeAdapter({ mode: 'timeout' });
  const { creation } = start(database);
  const result = await runCreation(database, creation.id, { adapter, actor: 'Tester' });

  assert.equal(result.outcomeUnknown, true);
  assert.equal(result.creation.status, CREATION_STATUS.OUTCOME_UNKNOWN);
  assert.notEqual(result.creation.status, CREATION_STATUS.FAILED);
  assert.equal(adapter.state.posts, 1);
});

test('an unknown outcome is never resolved by posting again', async () => {
  const database = db();
  const adapter = fakeAdapter({ mode: 'timeout' });
  const { creation } = start(database);
  await runCreation(database, creation.id, { adapter, actor: 'Tester' });
  // Whatever the operator clicks next, the POST count must not move.
  await runCreation(database, creation.id, { adapter, actor: 'Tester' });
  await reconcileUnknown(database, creation.id, { adapter, actor: 'Tester' });
  assert.equal(adapter.state.posts, 1);
  assert.ok(adapter.state.searches >= 1, 'it looked instead of sending');
});

test('reconciling an unknown outcome adopts the task the marker finds', async () => {
  const database = db();
  const adapter = fakeAdapter({ mode: 'timeout' });
  const { creation } = start(database);
  await runCreation(database, creation.id, { adapter, actor: 'Tester' });

  // The request HAD arrived: OpenProject made the record, the answer was lost on the way back.
  const row = creationByKey(database, 'key-1');
  adapter.state.created.push({ externalActivityId: '777', activityName: REQUEST.subject,
    activityType: 'Task', status: 'New', plannedStart: '2026-11-16', plannedFinish: '2026-11-27',
    reportedProgressPct: 0, estimatedTimeRaw: 'P3DT8H', estimatedHours: 80,
    sourceRevision: 1, description: `Apply waterproofing.${markerLine(row.marker)}` });

  const resolved = await reconcileUnknown(database, creation.id, { adapter, actor: 'Tester' });
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.outcome, 'CREATED');
  assert.equal(resolved.creation.workPackageId, '777');
  assert.equal(adapter.state.posts, 1, 'adopted, not re-created');
});

test('reconciling finds nothing when nothing was created, and says it is safe to try again',
  async () => {
    const database = db();
    const adapter = fakeAdapter({ mode: 'timeout' });
    const { creation } = start(database);
    await runCreation(database, creation.id, { adapter, actor: 'Tester' });
    const resolved = await reconcileUnknown(database, creation.id, { adapter, actor: 'Tester' });
    assert.equal(resolved.outcome, 'NOT_CREATED');
    assert.equal(resolved.creation.status, CREATION_STATUS.FAILED);
    assert.match(resolved.creation.error, /safe to submit a new one/);
  });

test('two matches for one marker is reported, not guessed at', async () => {
  const database = db();
  const adapter = fakeAdapter({ mode: 'timeout' });
  const { creation } = start(database);
  await runCreation(database, creation.id, { adapter, actor: 'Tester' });
  const row = creationByKey(database, 'key-1');
  for (const id of ['801', '802']) {
    adapter.state.created.push({ externalActivityId: id, activityName: 'X', sourceRevision: 1,
      description: markerLine(row.marker) });
  }
  const resolved = await reconcileUnknown(database, creation.id, { adapter, actor: 'Tester' });
  assert.equal(resolved.outcome, 'AMBIGUOUS');
  assert.equal(resolved.creation.status, CREATION_STATUS.OUTCOME_UNKNOWN);
  assert.equal(resolved.creation.workPackageId, null, 'it picked neither');
});

test('an unresolved attempt stays on the list a person has to clear', async () => {
  const database = db();
  const adapter = fakeAdapter({ mode: 'timeout' });
  const { creation } = start(database);
  await runCreation(database, creation.id, { adapter, actor: 'Tester' });
  const open = unresolved(database);
  assert.equal(open.length, 1);
  assert.equal(open[0].status, CREATION_STATUS.OUTCOME_UNKNOWN);
});

/* ── refusal ──────────────────────────────────────────────────────────────────────────────── */

test('a source refusal creates nothing and keeps the field messages', async () => {
  const database = db();
  const adapter = fakeAdapter({ formErrors: { dueDate: 'Finish date must be greater than or '
    + 'equal to the start date.' } });
  const { creation } = start(database);
  const result = await runCreation(database, creation.id, { adapter, actor: 'Tester' });

  assert.equal(result.ok, false);
  assert.equal(adapter.state.posts, 0, 'the form refused it, so nothing was posted');
  assert.equal(result.creation.status, CREATION_STATUS.FAILED);
  assert.match(result.creation.fieldErrors.dueDate, /greater than or equal/);
  assert.equal(storedActivities(database, '3').length, 0);
});

/* ── partial success: the task exists, the mapping does not ───────────────────────────────── */

const BIM = { speckleProjectId: '13347d8410', speckleModelId: 'd1fdafff76', versionId: 'v5',
  elements: [{ ifcGuid: 'GUID-A', ifcType: 'IfcWall', name: 'Wall A' }] };

test('a failed mapping does not undo the created task, and retrying maps without re-creating',
  async () => {
    const database = db();
    const adapter = fakeAdapter();
    const { creation } = start(database, { bimContext: BIM });

    let allowed = false;
    const onCreated = async () => {
      if (!allowed) throw new Error('the mapping store was unavailable');
      return { ok: true, proposed: 1 };
    };

    const first = await runCreation(database, creation.id, { adapter, actor: 'Tester', onCreated });
    assert.equal(first.ok, true, 'the work package still counts as created');
    assert.equal(first.creation.workPackageId, '100');
    assert.equal(first.creation.mappingStatus, MAPPING_STATE.FAILED);

    allowed = true;
    const retried = await retryMapping(database, creation.id, { actor: 'Tester', onCreated });
    assert.equal(retried.ok, true);
    assert.equal(retried.creation.mappingStatus, MAPPING_STATE.PROPOSED);
    assert.equal(adapter.state.posts, 1, 'retrying the MAPPING never touches OpenProject');
  });

test('a BIM-created task proposes its mappings and does not approve them', async () => {
  const database = db();
  const adapter = fakeAdapter();
  const { creation } = start(database, { bimContext: BIM });
  const seen = [];
  const onCreated = async ({ activity }) => {
    seen.push(activity.externalActivityId);
    return { ok: true, proposed: 1, status: 'PROPOSED' };
  };
  const result = await runCreation(database, creation.id, { adapter, actor: 'Tester', onCreated });
  assert.deepEqual(seen, ['100']);
  assert.equal(result.creation.mappingStatus, MAPPING_STATE.PROPOSED);
  assert.notEqual(result.creation.mappingStatus, 'APPROVED');
  assert.equal(result.creation.mappingDetail.status, 'PROPOSED');
});

/* ── the HTTP routes ──────────────────────────────────────────────────────────────────────── */

/**
 * A fake OpenProject at the FETCH level, so the real adapter and the real HTTP client are under
 * test rather than stubbed past. `posts` counts creates only: the form endpoint is also a POST,
 * and conflating the two would hide the very thing these tests exist to measure.
 */
function stubInstance({ mode = 'ok', canCreate = true } = {}) {
  const state = { posts: 0, forms: 0, created: new Map(), nextId: 500, calls: [] };
  const reply = (body, status = 200) => new Response(JSON.stringify(body),
    { status, headers: { 'content-type': 'application/hal+json' } });
  const PROJECT = {
    _type: 'Project', id: 3, name: 'Construction', identifier: 'construction',
    _links: {
      self: { href: '/api/v3/projects/3' },
      ...(canCreate ? {
        createWorkPackage: { href: '/api/v3/workspaces/3/work_packages/form', method: 'post' },
        createWorkPackageImmediately: { href: '/api/v3/workspaces/3/work_packages', method: 'post' },
      } : {}),
    },
  };
  const collection = elements => ({ _type: 'Collection', total: elements.length,
    count: elements.length, _embedded: { elements } });

  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const method = options.method ?? 'GET';
    state.calls.push(`${method} ${path}`);
    const body = options.body ? JSON.parse(options.body) : null;

    if (path === '/api/v3/projects/3') return reply(PROJECT);
    if (path === '/api/v3/configuration') return reply({ _type: 'Configuration' }, 200);
    if (path === '/api/v3/projects/3/types') {
      return reply(collection([{ id: 1, name: 'Task' }, { id: 2, name: 'Milestone', isMilestone: true }]));
    }
    if (path === '/api/v3/statuses') return reply(collection([{ id: 1, name: 'New', isDefault: true }]));
    if (path === '/api/v3/priorities') return reply(collection([{ id: 8, name: 'Normal', isDefault: true }]));

    if (method === 'POST' && path === '/api/v3/workspaces/3/work_packages/form') {
      state.forms += 1;
      const errors = {};
      if (!String(body?.subject ?? '').trim()) {
        errors.subject = { _type: 'Error', message: "Subject can't be blank." };
      }
      if (body?.startDate && body?.dueDate && body.dueDate < body.startDate) {
        errors.dueDate = { _type: 'Error',
          message: 'Finish date must be greater than or equal to the start date.' };
      }
      return reply({ _type: 'Form',
        _embedded: { payload: body, schema: {}, validationErrors: errors },
        _links: { commit: { href: '/api/v3/work_packages', method: 'post' } } });
    }

    if (method === 'POST' && path === '/api/v3/work_packages') {
      state.posts += 1;
      if (mode === 'timeout') throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      const id = state.nextId++;
      const wp = { _type: 'WorkPackage', id, subject: body.subject, lockVersion: 1,
        startDate: body.startDate ?? null, dueDate: body.dueDate ?? null,
        estimatedTime: body.estimatedTime === 'PT80H' ? 'P3DT8H' : body.estimatedTime ?? null,
        percentageDone: 0, createdAt: '2026-11-11T10:00:00Z', updatedAt: '2026-11-11T10:00:00Z',
        description: { raw: body.description?.raw ?? '' },
        _links: { self: { href: `/api/v3/work_packages/${id}` },
          type: { title: 'Task' }, status: { title: 'New' }, project: { href: '/api/v3/projects/3' } } };
      state.created.set(String(id), wp);
      return reply(wp, 201);
    }
    const one = /^\/api\/v3\/work_packages\/(\d+)$/.exec(path);
    if (one) {
      const wp = state.created.get(one[1]);
      return wp ? reply(wp) : reply({ _type: 'Error', message: 'Not found.' }, 404);
    }
    if (path === '/api/v3/work_packages/') return reply(collection([]));
    if (path === '/api/v3/projects/3/work_packages') {
      const filters = JSON.parse(parsed.searchParams.get('filters') ?? '[]');
      const marker = filters[0]?.description?.values?.[0];
      const all = [...state.created.values()];
      return reply(collection(marker
        ? all.filter(wp => String(wp.description?.raw ?? '').includes(marker)) : all));
    }
    const rel = /^\/api\/v3\/work_packages\/\d+\/relations$/.exec(path);
    if (rel) return reply(collection([]));
    return reply({ _type: 'Error', message: `No stub for ${method} ${path}` }, 404);
  };
  return { fetchImpl, state };
}

const ENV = Object.freeze({
  OPENPROJECT_API_TOKEN: 'test-token-not-a-real-one',
  OPENPROJECT_BASE_URL: 'https://superdnatechnolab.openproject.com',
  OPENPROJECT_PROJECT_ID: '3',
});

const quiet = { warn() {}, error() {}, info() {}, log() {} };

async function apiWith(stub) {
  const { createConstructionApi } = await import('../server/construction/api.mjs');
  const api = createConstructionApi({ path: ':memory:', logger: quiet,
    openProjectOptions: { env: ENV, fetchImpl: stub.fetchImpl },
    autoSync: false,
    syncOptions: { manualMinIntervalMs: 0,
      workerKey: `t-${Math.random().toString(36).slice(2)}` } });
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    let status = null; let payload = null;
    const res = { writeHead(code) { status = code; return this; },
      end(textBody) { payload = textBody ? JSON.parse(textBody) : null; } };
    const req = { method, url: `/api/construction${path}`, headers,
      on(event, handler) {
        if (event === 'data' && body) handler(Buffer.from(JSON.stringify(body)));
        if (event === 'end') handler();
        return this;
      } };
    await api.handle(req, res);
    return { status, payload };
  };
  const session = async (role = 'planner') => {
    const issued = await call('/session', { method: 'POST', body: { role } });
    return { 'x-demo-session': issued.payload.token };
  };
  return { api, call, session };
}

const FIELDS = { subject: 'Exterior Wall Waterproofing', description: 'Apply waterproofing.',
  startDate: '2026-11-16', dueDate: '2026-11-27', estimatedHours: 80 };

test('route: the create options come from the instance, not from a constant', async () => {
  const stub = stubInstance();
  const { call, session } = await apiWith(stub);
  const headers = await session('planner');
  const { status, payload } = await call('/openproject/create/options', { headers });
  assert.equal(status, 200);
  assert.equal(payload.permittedHere, true);
  assert.equal(payload.sourcePermits, true);
  assert.equal(payload.endpoints.form, '/api/v3/workspaces/3/work_packages/form');
  assert.deepEqual(payload.types.values.map(t => t.name), ['Task', 'Milestone']);
});

test('route: an instance that offers no create link is reported as refusing, not as broken',
  async () => {
    const stub = stubInstance({ canCreate: false });
    const { call, session } = await apiWith(stub);
    const { payload } = await call('/openproject/create/options',
      { headers: await session('planner') });
    assert.equal(payload.sourcePermits, false);
    assert.match(payload.sourceNote, /may not create/);
    assert.equal(stub.state.posts, 0);
  });

test('route: the BIM Coordinator may not create a task', async () => {
  const stub = stubInstance();
  const { call, session } = await apiWith(stub);
  const { status, payload } = await call('/openproject/work-packages', { method: 'POST',
    headers: await session('bimCoordinator'),
    body: { idempotencyKey: 'abcdefgh1234', fields: FIELDS } });
  assert.equal(status, 403);
  assert.match(payload.error, /BIM Coordinator may not create/);
  assert.equal(stub.state.posts, 0, 'a refused caller reaches no external system');
});

test('route: no session at all creates nothing', async () => {
  const stub = stubInstance();
  const { call } = await apiWith(stub);
  const { status } = await call('/openproject/work-packages', { method: 'POST',
    body: { idempotencyKey: 'abcdefgh1234', fields: FIELDS } });
  assert.equal(status, 403);
  assert.equal(stub.state.posts, 0);
});

test('route: a missing idempotency key is refused before anything is sent', async () => {
  const stub = stubInstance();
  const { call, session } = await apiWith(stub);
  const { status, payload } = await call('/openproject/work-packages', { method: 'POST',
    headers: await session('planner'), body: { fields: FIELDS } });
  assert.equal(status, 400);
  assert.match(payload.error, /idempotencyKey is required/);
  assert.equal(stub.state.posts, 0);
});

test('route: a create is confirmed, reconciled and visible as an activity', async () => {
  const stub = stubInstance();
  const { call, session } = await apiWith(stub);
  const headers = await session('planner');
  const { status, payload } = await call('/openproject/work-packages', { method: 'POST',
    headers, body: { idempotencyKey: 'create-once-1', fields: FIELDS } });

  assert.equal(status, 200);
  assert.equal(stub.state.posts, 1);
  assert.equal(payload.creation.status, CREATION_STATUS.RECONCILED);
  assert.equal(payload.creation.reconciliation, RECONCILIATION.MATCHED,
    'PT80H stored as P3DT8H still reconciles');
  const id = payload.creation.workPackageId;

  const list = await call('/lifecycle/activities', { headers });
  assert.ok(list.payload.activities.some(a => String(a.workPackageId) === String(id)),
    'the created task appears in the activity list without a reload');
});

test('route: posting the same key twice creates one work package', async () => {
  const stub = stubInstance();
  const { call, session } = await apiWith(stub);
  const headers = await session('planner');
  const body = { idempotencyKey: 'double-click-1', fields: FIELDS };
  const [a, b] = await Promise.all([
    call('/openproject/work-packages', { method: 'POST', headers, body }),
    call('/openproject/work-packages', { method: 'POST', headers, body }),
  ]);
  assert.equal(stub.state.posts, 1);
  assert.equal(a.payload.creation.workPackageId, b.payload.creation.workPackageId);

  // And a third, later, after it has settled.
  const c = await call('/openproject/work-packages', { method: 'POST', headers, body });
  assert.equal(c.payload.repeat, true);
  assert.equal(stub.state.posts, 1);
});

test("route: the source's field errors reach the browser and nothing is created", async () => {
  const stub = stubInstance();
  const { call, session } = await apiWith(stub);
  const { payload } = await call('/openproject/work-packages', { method: 'POST',
    headers: await session('planner'),
    body: { idempotencyKey: 'bad-dates-1',
      fields: { ...FIELDS, startDate: '2026-11-27', dueDate: '2026-11-16' } } });
  // Caught locally first, so it costs no round trip; the message names the field either way.
  assert.ok(payload.fieldErrors?.dueDate);
  assert.equal(stub.state.posts, 0);
});

test('route: a timeout answers 202 OUTCOME_UNKNOWN and reconciles by looking', async () => {
  const stub = stubInstance({ mode: 'timeout' });
  const { call, session } = await apiWith(stub);
  const headers = await session('planner');
  const first = await call('/openproject/work-packages', { method: 'POST', headers,
    body: { idempotencyKey: 'timeout-1', fields: FIELDS } });

  assert.equal(first.status, 202, 'not 200 and not 400: the question is open');
  assert.equal(first.payload.creation.status, CREATION_STATUS.OUTCOME_UNKNOWN);
  assert.equal(stub.state.posts, 1);

  const id = first.payload.creation.id;
  const resolved = await call(`/openproject/work-packages/creations/${id}/reconcile`,
    { method: 'POST', headers });
  assert.equal(resolved.payload.outcome, 'NOT_CREATED');
  assert.equal(stub.state.posts, 1, 'reconciling never sends another create');
});

test('route: a BIM-created task proposes mappings that are not approved', async () => {
  const stub = stubInstance();
  const { call, session } = await apiWith(stub);
  const headers = await session('planner');
  const { status, payload } = await call('/openproject/work-packages', { method: 'POST', headers,
    body: { idempotencyKey: 'from-bim-1', fields: FIELDS,
      bim: { versionId: 'v5', versionLabel: 'V5',
        elements: [{ ifcGuid: '1aBcDeFgH2iJkLmNoPqRsT', ifcType: 'IfcWall', name: 'Wall A' },
          { ifcGuid: '2aBcDeFgH2iJkLmNoPqRsT', ifcType: 'IfcWall', name: 'Wall B' }] } } });

  assert.equal(status, 200);
  assert.equal(payload.creation.mappingStatus, MAPPING_STATE.PROPOSED);
  assert.equal(payload.creation.mappingDetail.proposed, 2);

  const wpId = payload.creation.workPackageId;
  const list = await call(`/speckle/mappings?activityId=${wpId}`, { headers });
  const rows = list.payload.mappings ?? [];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.status, 'PROPOSED', 'creating from geometry never approves the mapping');
    assert.equal(row.basis, 'CREATED_FROM_SELECTION');
  }
});

test('route: a Cesium feature id is refused as an IFC identifier', async () => {
  const stub = stubInstance();
  const { call, session } = await apiWith(stub);
  const { status, payload } = await call('/openproject/work-packages', { method: 'POST',
    headers: await session('planner'),
    body: { idempotencyKey: 'bad-guid-1', fields: FIELDS,
      bim: { elements: [{ ifcGuid: '17', ifcType: 'IfcWall' }] } } });
  assert.equal(status, 400);
  assert.match(payload.error, /not an IFC GlobalId/);
  assert.equal(stub.state.posts, 0);
});

/* ── multi-select in the viewer (Workflow B needs several elements at once) ───────────────── */

test('the viewer style highlights every selected element, and one is still one', async () => {
  const { buildStyle, SELECTED_COLOUR } = await import('../src/construction/bimViewer.js');

  // The spelling every screen before Phase 10B uses must keep working unchanged.
  const single = buildStyle({ selectedGuid: 'GUID-A' });
  const singleHits = single.color.conditions
    .filter(([, colour]) => colour.includes(SELECTED_COLOUR));
  assert.equal(singleHits.length, 1);

  const many = buildStyle({ selected: new Set(['GUID-A', 'GUID-B', 'GUID-C']) });
  const manyHits = many.color.conditions.filter(([, colour]) => colour.includes(SELECTED_COLOUR));
  assert.equal(manyHits.length, 3);
  for (const guid of ['GUID-A', 'GUID-B', 'GUID-C']) {
    assert.ok(manyHits.some(([test]) => test.includes(guid)), `${guid} is highlighted`);
  }
});

test('a quote in a selected id cannot break out of the style expression', async () => {
  const { buildStyle } = await import('../src/construction/bimViewer.js');
  const style = buildStyle({ selected: new Set(["x' || true || '"]) });
  for (const [condition] of style.color.conditions) {
    assert.equal((condition.match(/'/g) ?? []).length % 2, 0, 'quotes stay balanced');
  }
});

/* ── the drawer's duplicate guard ─────────────────────────────────────────────────────────── */

test('the draft key survives a reload and is spent once the task exists', async () => {
  const { clearDraftKey, draftKeyFor, localErrors, collectFields } =
    await import('../src/construction/createTaskDrawer.js');
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v),
    removeItem: k => store.delete(k) };

  const first = draftKeyFor(storage);
  // A reload re-reads the same draft: the same key, so the server recognises the same request.
  assert.equal(draftKeyFor(storage), first);
  clearDraftKey(storage);
  assert.notEqual(draftKeyFor(storage), first, 'the next task gets its own key');

  // Storage that throws (a private window) must not stop a person creating a task.
  const hostile = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); } };
  assert.match(draftKeyFor(hostile), /^[A-Za-z0-9_-]{8,128}$/);

  assert.deepEqual(localErrors({ subject: '' }), { subject: 'A task name is required.' });
  assert.deepEqual(localErrors({ subject: 'X', startDate: '2026-11-27', dueDate: '2026-11-16' }),
    { dueDate: 'Finish date must be on or after the start date.' });
  assert.deepEqual(localErrors({ subject: 'X' }), {}, 'no dates is not an error');

  // A blank optional field is absent, not zero.
  const form = { elements: { subject: { value: ' Wall work ' }, description: { value: '' },
    startDate: { value: '' }, dueDate: { value: '' }, estimatedHours: { value: '' },
    typeId: { value: '1' }, statusId: { value: '' }, priorityId: { value: '' },
    percentageDone: { value: '' } } };
  assert.deepEqual(collectFields(form), { subject: 'Wall work', description: '', typeId: '1' });
});
