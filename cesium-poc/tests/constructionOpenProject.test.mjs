/**
 * Phase 8A — the live OpenProject schedule read.
 *
 * Fixture-driven, and deliberately so: a test that needs a live token, a cloud instance and the
 * internet fails on a train and tells you nothing when it does. The fixtures are the SHAPE of what
 * OpenProject API v3 actually returns — HAL+JSON with `_type`, `_embedded.elements`, `_links` with
 * titles, ISO 8601 durations, and `lockVersion` as the revision. Live verification against
 * `superdnatechnolab.openproject.com` is reported separately.
 *
 * The rules most likely to be broken by a well-meaning change each have a test that fails if the
 * guard is removed: the baseline that must not look like progress, the revision we must not do
 * arithmetic on, the name match that must not become an identification, and the P6 record that
 * must never be written.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

import {
  STATE, createOpenProjectAdapter, idFromHref, normalizeProject, normalizeWorkPackage,
} from '../server/construction/openProject.mjs';
import { FAILURE, createOpenProjectClient, parseId } from '../server/construction/openProjectHttp.mjs';
import {
  BASIS, basisFor, corroborate, parseIsoDuration,
} from '../server/construction/openProjectDuration.mjs';
import { CHANGE, EXPECTED, MAPPING, SOURCE } from '../server/construction/openProjectConfig.mjs';
import { TRACKED, diffActivity, sameValue, summarize } from '../server/construction/openProjectChanges.mjs';
import {
  candidatesFor, compare, nameEvidence, normalizeName, syntheticP6Activities,
} from '../server/construction/openProjectMapping.mjs';
import { BASE, createConstructionApi } from '../server/construction/api.mjs';
import { CHANGE_LABEL, OP_STATE, pct, work } from '../src/construction/openProjectSchedule.js';

const TOKEN = 'op-token-never-logged-8a';
const quiet = { warn() {}, error() {}, log() {} };
const ENV = Object.freeze({
  OPENPROJECT_API_TOKEN: TOKEN,
  OPENPROJECT_BASE_URL: 'https://superdnatechnolab.openproject.com',
  OPENPROJECT_PROJECT_ID: '3',
});

/* ── fixtures ──────────────────────────────────────────────────────────────────────────────── */

/** Work package 38 exactly as the brief recorded it. */
const WP38 = Object.freeze({
  _type: 'WorkPackage',
  id: 38,
  subject: 'Cast Level 2 Columns',
  description: { format: 'markdown', raw: 'Formwork, rebar, pour. Level 2 columns, Zone A.' },
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
    assignee: { href: '/api/v3/users/4', title: 'A. Site Engineer' },
  },
});

const PROJECT3 = Object.freeze({
  _type: 'Project', id: 3, identifier: 'construction', name: 'Construction',
  active: true, public: false,
  createdAt: '2026-11-01T09:00:00.000Z', updatedAt: '2026-11-10T12:08:45.431Z',
  _links: { self: { href: '/api/v3/projects/3', title: 'Construction' } },
});

const collection = (elements, extra = {}) => ({
  _type: 'Collection', total: elements.length, count: elements.length, pageSize: 100, offset: 1,
  _embedded: { elements }, _links: {}, ...extra,
});

const reply = (body, status = 200) => new Response(JSON.stringify(body),
  { status, headers: { 'content-type': 'application/hal+json' } });

const opError = (identifier, message) => ({ _type: 'Error', errorIdentifier: identifier, message });

/**
 * A fake OpenProject that serves one mutable work package, and RECORDS every request.
 *
 * The recording is what the "no writes" and "no request without a token" tests assert on: the
 * only honest way to prove a request was not made is to count the requests.
 */
function stubOpenProject({ workPackages = [WP38], project = PROJECT3, relations = [],
  configuration = null, pages = null } = {}) {
  const calls = [];
  const state = { workPackages: structuredClone(workPackages) };
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, search: parsed.search, method: options.method ?? 'GET',
      headers: options.headers ?? {}, redirect: options.redirect });
    const path = parsed.pathname;
    if (path === '/api/v3/configuration') {
      return configuration ? reply(configuration)
        : reply(opError('urn:openproject-org:api:v3:errors:NotFound', 'Not found.'), 404);
    }
    if (path === '/api/v3/projects/3') return reply(project);
    if (path === '/api/v3/projects/3/work_packages') {
      if (pages) {
        const offset = Number(parsed.searchParams.get('offset') ?? 1);
        const page = pages.find(entry => entry.offset === offset);
        return page ? reply(page.body) : reply(opError('x', 'No such page.'), 404);
      }
      return reply(collection(state.workPackages));
    }
    const single = /^\/api\/v3\/work_packages\/(\d+)$/.exec(path);
    if (single) {
      const found = state.workPackages.find(entry => String(entry.id) === single[1]);
      return found ? reply(found)
        : reply(opError('urn:openproject-org:api:v3:errors:NotFound',
          'The requested resource could not be found.'), 404);
    }
    if (/^\/api\/v3\/work_packages\/\d+\/relations$/.test(path)) return reply(collection(relations));
    return reply(opError('urn:openproject-org:api:v3:errors:NotFound', 'Not found.'), 404);
  };
  return { fetchImpl, calls, state,
    update(patch) { state.workPackages[0] = { ...state.workPackages[0], ...patch }; } };
}

/** Drive the real HTTP handler the way the browser does. */
function createApi({ env = ENV, fetchImpl, db = null } = {}) {
  const api = createConstructionApi({ path: ':memory:', db, logger: quiet,
    openProjectOptions: { env, fetchImpl },
    /*
     * Phase 8B. `autoSync: false` arms no timer — a unit test must never start polling a cloud
     * service — and `manualMinIntervalMs: 0` removes the floor between consecutive manual runs,
     * because several tests here refresh twice in a row on purpose to prove idempotency. The
     * `workerKey` keeps each test's worker out of the process-wide singleton the real hosts share.
     */
    autoSync: false,
    syncOptions: { manualMinIntervalMs: 0, workerKey: `test-${Math.random().toString(36).slice(2)}` },
  });
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const chunks = [];
    let status = null;
    const res = { writeHead(code) { status = code; }, end(text) { chunks.push(text ?? ''); } };
    const req = { url: `${BASE}${path}`, method, headers,
      on(event, cb) {
        if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
        if (event === 'end') cb();
        return req;
      } };
    const handled = await api.handle(req, res);
    return { handled, status, body: JSON.parse(chunks.join('') || '{}') };
  };
  return { api, call };
}

const adapterFor = stub => createOpenProjectAdapter(
  { env: ENV, fetchImpl: stub.fetchImpl, logger: quiet });

/* ── 1. a missing token makes no request at all ────────────────────────────────────────────── */

test('without a token the adapter reports NOT_CONFIGURED and never calls OpenProject', async () => {
  const stub = stubOpenProject();
  const adapter = createOpenProjectAdapter({ env: { OPENPROJECT_PROJECT_ID: '3' },
    fetchImpl: stub.fetchImpl, logger: quiet });

  for (const result of [await adapter.health(), await adapter.project(),
    await adapter.workPackages(), await adapter.workPackage('38')]) {
    assert.equal(result.state, STATE.NOT_CONFIGURED);
    assert.match(result.reason, /OPENPROJECT_API_TOKEN is not set/);
  }
  // The only proof that matters: nothing was sent.
  assert.equal(stub.calls.length, 0, 'an unconfigured adapter reached the network');
  assert.equal(adapter.configured(), false);
});

test('an empty-string token is not configured either', async () => {
  const stub = stubOpenProject();
  const adapter = createOpenProjectAdapter({ env: { ...ENV, OPENPROJECT_API_TOKEN: '   ' },
    fetchImpl: stub.fetchImpl, logger: quiet });
  assert.equal((await adapter.health()).state, STATE.NOT_CONFIGURED);
  assert.equal(stub.calls.length, 0);
});

/* ── 2. a successful authenticated read ────────────────────────────────────────────────────── */

test('a configured adapter authenticates with Basic apikey:<token> and asks for HAL+JSON', async () => {
  const stub = stubOpenProject();
  const result = await adapterFor(stub).health();

  assert.equal(result.state, STATE.CONNECTED);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.project.name, EXPECTED.projectName);
  assert.equal(result.project.identifier, EXPECTED.projectIdentifier);
  assert.equal(result.project.id, EXPECTED.projectId);

  const [call] = stub.calls;
  assert.equal(call.path, '/api/v3/projects/3');
  assert.equal(call.method, 'GET');
  assert.equal(call.headers.Accept, 'application/hal+json');
  // The username is literally "apikey" and the token is the password.
  const decoded = Buffer.from(String(call.headers.Authorization).replace(/^Basic /, ''), 'base64')
    .toString('utf8');
  assert.equal(decoded, `apikey:${TOKEN}`);
  // A redirect must never forward the credential off the allowlisted host.
  assert.equal(call.redirect, 'error');
});

test('the project-scoped collection path is projects/<id>/work_packages, not workspaces', async () => {
  const stub = stubOpenProject();
  await adapterFor(stub).workPackages();
  const paths = stub.calls.map(call => call.path);
  assert.ok(paths.includes('/api/v3/projects/3/work_packages'),
    `expected the projects path; got ${paths.join(', ')}`);
  assert.ok(!paths.some(path => path.includes('/workspaces/')),
    'workspaces is not an OpenProject API v3 route');
});

/* ── 3 & 4. the HTTP failures, each reported as its own finding ────────────────────────────── */

for (const [status, state, pattern] of [
  [401, STATE.AUTH_FAILED, /rejected the API token/],
  [403, STATE.AUTH_FAILED, /refused the request/],
  [404, STATE.CONNECTION_FAILED, /no such resource/],
  [500, STATE.CONNECTION_FAILED, /HTTP 500/],
]) {
  test(`HTTP ${status} is reported as ${state}, with the upstream reason kept`, async () => {
    const adapter = createOpenProjectAdapter({ env: ENV, logger: quiet,
      fetchImpl: async () => reply(opError(`urn:x:${status}`, `Upstream says ${status}.`), status) });
    const result = await adapter.health();
    assert.equal(result.state, state);
    assert.equal(result.httpStatus, status);
    assert.match(result.reason, pattern);
    // The upstream's own words survive — a screen that cannot say why is useless.
    assert.match(result.reason, new RegExp(`Upstream says ${status}`));
    if (status === 404) assert.equal(result.failure, FAILURE.NOT_FOUND);
  });
}

test('403 explains that the token may not see the project, which 401 does not', async () => {
  const adapter = createOpenProjectAdapter({ env: ENV, logger: quiet,
    fetchImpl: async () => reply(opError('x', 'Forbidden.'), 403) });
  assert.match((await adapter.health()).reason, /may not see this project/);
});

/* ── 5. timeout and network failure ────────────────────────────────────────────────────────── */

test('a timeout is reported as TIMEOUT with the limit named, not as an auth problem', async () => {
  const adapter = createOpenProjectAdapter({ env: ENV, logger: quiet,
    fetchImpl: async () => { const error = new Error('aborted'); error.name = 'TimeoutError'; throw error; } });
  const result = await adapter.health();
  assert.equal(result.state, STATE.CONNECTION_FAILED);
  assert.equal(result.failure, FAILURE.TIMEOUT);
  assert.match(result.reason, /No response within \d+ ms/);
});

test('a network error is NETWORK and carries the cause', async () => {
  const adapter = createOpenProjectAdapter({ env: ENV, logger: quiet,
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
  const result = await adapter.health();
  assert.equal(result.failure, FAILURE.NETWORK);
  assert.match(result.reason, /ENOTFOUND/);
});

/* ── 6. a malformed HAL response ───────────────────────────────────────────────────────────── */

test('a 200 that is not JSON is DATA_INVALID, never an empty success', async () => {
  const adapter = createOpenProjectAdapter({ env: ENV, logger: quiet,
    fetchImpl: async () => new Response('<html>a proxy login page</html>', { status: 200 }) });
  const result = await adapter.health();
  assert.equal(result.state, STATE.DATA_INVALID);
  assert.match(result.reason, /not JSON/);
});

test('a collection without _embedded.elements is DATA_INVALID, not "no activities"', async () => {
  const adapter = createOpenProjectAdapter({ env: ENV, logger: quiet,
    fetchImpl: async url => (new URL(url).pathname === '/api/v3/projects/3'
      ? reply(PROJECT3) : reply({ _type: 'Collection', total: 7 })) });
  const result = await adapter.workPackages();
  assert.equal(result.state, STATE.DATA_INVALID);
  assert.match(result.reason, /_embedded\.elements/);
  assert.deepEqual(result.activities, []);
  // The distinction that matters: this is NOT reported as a project with no work.
  assert.notEqual(result.state, STATE.CONNECTED);
});

/* ── 7. an empty collection ────────────────────────────────────────────────────────────────── */

test('a genuinely empty project is CONNECTED with zero activities and no warning', async () => {
  const stub = stubOpenProject({ workPackages: [] });
  const result = await adapterFor(stub).workPackages();
  assert.equal(result.state, STATE.CONNECTED);
  assert.equal(result.returned, 0);
  assert.equal(result.total, 0);
  assert.deepEqual(result.activities, []);
  assert.deepEqual(result.warnings, []);
});

/* ── 8. pagination, and never a short list presented as a whole one ────────────────────────── */

test('the adapter follows nextByOffset and reports returned separately from the total', async () => {
  const wp = id => ({ ...WP38, id, _links: { ...WP38._links,
    self: { href: `/api/v3/work_packages/${id}`, title: `WP ${id}` } } });
  const stub = stubOpenProject({ pages: [
    { offset: 1, body: { ...collection([wp(1), wp(2)]), total: 4,
      _links: { nextByOffset: { href: '/api/v3/projects/3/work_packages?offset=2&pageSize=2' } } } },
    { offset: 2, body: { ...collection([wp(3), wp(4)]), total: 4, _links: {} } },
  ] });
  const result = await adapterFor(stub).workPackages({ pageSize: 2 });
  assert.equal(result.state, STATE.CONNECTED);
  assert.equal(result.pages, 2);
  assert.equal(result.returned, 4);
  assert.equal(result.total, 4);
  assert.deepEqual(result.activities.map(entry => entry.externalActivityId),
    ['1', '2', '3', '4']);
  assert.deepEqual(result.warnings, []);
});

test('a page that fails mid-walk is PARTIAL, keeps what it has, and says the rest is missing', async () => {
  const wp = id => ({ ...WP38, id, _links: { ...WP38._links, self: { href: `/api/v3/work_packages/${id}` } } });
  const stub = stubOpenProject({ pages: [
    { offset: 1, body: { ...collection([wp(1)]), total: 3,
      _links: { nextByOffset: { href: '/api/v3/projects/3/work_packages?offset=2' } } } },
    // offset 2 is absent, so the stub answers 404.
  ] });
  const result = await adapterFor(stub).workPackages({ pageSize: 1 });
  assert.equal(result.state, STATE.PARTIAL, 'an incomplete walk must not read as CONNECTED');
  assert.equal(result.returned, 1);
  assert.equal(result.total, 3, 'the collection total is still reported');
  assert.ok(result.warnings.some(entry => entry.kind === 'PAGE_FAILED'));
  assert.match(result.reason, /incomplete/);
});

test('the page limit stops the walk and is reported, never silently', async () => {
  const stub = stubOpenProject({ pages: [{ offset: 1, body: { ...collection([WP38]), total: 999,
    _links: { nextByOffset: { href: '/api/v3/projects/3/work_packages?offset=2' } } } }] });
  const result = await adapterFor(stub).workPackages({ pageSize: 1, maxPages: 1 });
  assert.equal(result.state, STATE.PARTIAL);
  assert.ok(result.warnings.some(entry => entry.kind === 'PAGE_LIMIT'));
});

test('a next-page link pointing off the allowlisted instance is not followed', async () => {
  const stub = stubOpenProject({ pages: [{ offset: 1, body: { ...collection([WP38]), total: 2,
    _links: { nextByOffset: { href: 'https://evil.example.com/api/v3/projects/3/work_packages' } } } }] });
  const result = await adapterFor(stub).workPackages({ pageSize: 1 });
  assert.equal(result.state, STATE.PARTIAL);
  assert.ok(result.warnings.some(entry => entry.kind === 'UNSAFE_NEXT_LINK'));
  assert.ok(!stub.calls.some(call => call.path.includes('evil')),
    'the credential was sent to a host that is not on the allowlist');
});

test('a count that disagrees with what arrived is reported rather than reconciled by truncation', async () => {
  const stub = stubOpenProject({ pages: [{ offset: 1,
    body: { ...collection([WP38]), total: 5, _links: {} } }] });
  const result = await adapterFor(stub).workPackages();
  assert.equal(result.state, STATE.PARTIAL);
  assert.equal(result.returned, 1);
  assert.equal(result.total, 5);
  assert.ok(result.warnings.some(entry => entry.kind === 'COUNT_MISMATCH'));
});

test('the default collection filter is overridden, so closed work packages are not hidden', async () => {
  const stub = stubOpenProject();
  const result = await adapterFor(stub).workPackages();
  const call = stub.calls.find(entry => entry.path.endsWith('/work_packages'));
  assert.match(call.search, /filters=%5B%5D/, 'filters=[] must be sent explicitly');
  const applied = result.filtersApplied.find(entry => entry.name === 'filters');
  assert.equal(applied.value, '[]');
  assert.match(applied.reason, /open statuses/);
});

/* ── 9. normalization of work package 38 ───────────────────────────────────────────────────── */

test('work package 38 normalizes to exactly the brief\'s verified values', () => {
  const activity = normalizeWorkPackage(WP38, { projectId: 3,
    projectIdentifier: 'construction', projectName: 'Construction' });

  assert.equal(activity.sourceSystem, 'OPENPROJECT');
  assert.equal(activity.sourceProjectId, EXPECTED.projectId);
  assert.equal(activity.sourceProjectIdentifier, EXPECTED.projectIdentifier);
  assert.equal(activity.externalActivityId, EXPECTED.workPackageId);
  assert.equal(activity.activityName, EXPECTED.subject);
  assert.equal(activity.activityType, EXPECTED.type);
  assert.equal(activity.status, EXPECTED.status);
  assert.equal(activity.plannedStart, EXPECTED.startDate);
  assert.equal(activity.plannedFinish, EXPECTED.dueDate);
  assert.equal(activity.reportedProgressPct, EXPECTED.percentageDone);
  assert.equal(activity.estimatedTimeRaw, EXPECTED.estimatedTime);
  assert.equal(activity.remainingTimeRaw, EXPECTED.remainingTime);
  assert.equal(activity.sourceRevision, EXPECTED.lockVersion);
  assert.equal(activity.sourceUpdatedAt, '2026-11-10T12:08:45.431Z');
  assert.equal(activity.sourceUrl, '/api/v3/work_packages/38');
  // The brief's shape had `parentExternalId: null` and `dependencies: []`; we distinguish them.
  assert.equal(activity.parentExternalId, null);
  assert.equal(activity.dependencies, null, 'unfetched dependencies are unknown, not none');
});

test('the raw duration survives beside the converted hours', () => {
  const activity = normalizeWorkPackage(WP38, { projectId: 3 });
  assert.equal(activity.estimatedTimeRaw, 'P1DT16H');
  assert.equal(activity.estimatedHours, 40);
  assert.equal(activity.remainingTimeRaw, 'P1DT6H');
  assert.equal(activity.remainingHours, 30);
  assert.equal(activity.hoursPerDay, 24);
  assert.equal(activity.durationBasis, BASIS.ISO_8601_NOMINAL);
});

test('a parent comes from _links.parent and is never inferred', () => {
  const withParent = { ...WP38, _links: { ...WP38._links,
    parent: { href: '/api/v3/work_packages/12', title: 'Level 2 structure' } } };
  assert.equal(normalizeWorkPackage(withParent, { projectId: 3 }).parentExternalId, '12');

  // A name that screams "child of something" and an id that follows another one: still no parent.
  const suggestive = { ...WP38, id: 39, subject: 'Cast Level 2 Columns — Phase 2',
    _links: { ...WP38._links, self: { href: '/api/v3/work_packages/39' } } };
  assert.equal(normalizeWorkPackage(suggestive, { projectId: 3 }).parentExternalId, null);
});

test('a work estimate is never read as calendar duration', () => {
  const activity = normalizeWorkPackage(WP38, { projectId: 3 });
  // 40 hours of work across a 7-day window. The two must not be the same field.
  assert.equal(activity.estimatedHours, 40);
  assert.equal(activity.plannedStart, '2026-11-12');
  assert.equal(activity.plannedFinish, '2026-11-18');
  assert.notEqual(activity.estimatedHours, activity.scheduledDurationDays);
});

test('an id is read from the HAL self href when the body omits it', () => {
  assert.equal(idFromHref('/api/v3/work_packages/38'), '38');
  assert.equal(idFromHref('/api/v3/projects/3'), '3');
  assert.equal(idFromHref('/api/v3/work_packages/38/relations'), '38');
  assert.equal(idFromHref('nonsense'), null);
  assert.equal(idFromHref(null), null);
});

test('a project normalizes without inventing fields it was not given', () => {
  const project = normalizeProject({ id: 3, identifier: 'construction', name: 'Construction' });
  assert.equal(project.id, 3);
  assert.equal(project.active, null, 'an absent boolean is null, never false');
  assert.equal(project.createdAt, null);
});

/* ── 10. ISO 8601 durations ────────────────────────────────────────────────────────────────── */

test('ISO 8601 durations convert on a stated basis, and the basis changes the answer', () => {
  assert.equal(parseIsoDuration('P1DT16H').hours, 40);
  assert.equal(parseIsoDuration('P1DT16H', { hoursPerDay: 8 }).hours, 24);
  assert.equal(parseIsoDuration('PT8H').hours, 8);
  assert.equal(parseIsoDuration('PT90M').hours, 1.5);
  assert.equal(parseIsoDuration('P1W').hours, 168);
  // A duration with no day component cannot be affected by the basis, and says so.
  assert.equal(parseIsoDuration('PT8H').exact, true);
  assert.equal(parseIsoDuration('P1DT16H').exact, false);
});

test('months and years are refused rather than converted to a plausible number of hours', () => {
  const result = parseIsoDuration('P1M');
  assert.equal(result.hours, null, 'a month has no fixed hour count');
  assert.match(result.warning, /months or years/);
  assert.equal(result.raw, 'P1M', 'the source value is still carried');
  assert.equal(parseIsoDuration('P1Y').hours, null);
});

test('an unreadable duration is absent, never zero', () => {
  const result = parseIsoDuration('not a duration');
  assert.equal(result.hours, null);
  assert.ok(result.warning);
  // The trap: Number(null) is 0 and finite.
  assert.notEqual(result.hours, 0);
  assert.equal(parseIsoDuration(null), null, 'nothing to parse is null, not a warning');
  assert.equal(parseIsoDuration(''), null);
});

test('work converts on the ISO nominal day, and the instance hoursPerDay is NOT applied to it', () => {
  // The live instance reports hoursPerDay: 8. Applying that to work turned P1DT6H into 14 h,
  // which is wrong — see basisFor()'s comment for the arithmetic that proves it.
  const basis = basisFor({ hoursPerDay: 8, durationFormat: 'hours_only' });
  assert.equal(basis.hoursPerDay, 24, 'the instance display setting leaked into work conversion');
  assert.equal(basis.basis, BASIS.ISO_8601_NOMINAL);

  // It is still reported, as context, with what it actually governs.
  assert.equal(basis.instanceHoursPerDay, 8);
  assert.equal(basis.instanceDurationFormat, 'hours_only');
  assert.match(basis.instanceNote, /displays the day-denominated scheduling duration/);
  assert.match(basis.instanceNote, /not converted with it/);

  // And the real values come out as the brief verified them.
  assert.equal(parseIsoDuration('P1DT16H', basis).hours, 40);
  assert.equal(parseIsoDuration('P1DT6H', basis).hours, 30);

  // A value we cannot believe is not reported as the instance's own.
  assert.equal(basisFor({ hoursPerDay: 0 }).instanceHoursPerDay, null);
  assert.equal(basisFor({ hoursPerDay: 99 }).instanceHoursPerDay, null);
  assert.equal(basisFor(null).instanceHoursPerDay, null);
  assert.equal(basisFor(null).hoursPerDay, 24);
});

test('the live instance\'s own arithmetic settles the basis, and only 24 h/day reconciles', () => {
  // The decisive evidence, kept as a test so a future change to basisFor() has to face it.
  const live = basisFor({ hoursPerDay: 8, durationFormat: 'hours_only' });
  const agrees = corroborate({
    estimated: parseIsoDuration('P1DT16H', live),
    remaining: parseIsoDuration('P1DT6H', live),
    percentDone: 25,
  });
  assert.equal(agrees.agrees, true);
  assert.equal(agrees.deltaHours, 0);

  const eight = { hoursPerDay: 8, basis: BASIS.FROM_INSTANCE };
  const disagrees = corroborate({
    estimated: parseIsoDuration('P1DT16H', eight),
    remaining: parseIsoDuration('P1DT6H', eight),
    percentDone: 25,
  });
  assert.equal(disagrees.agrees, false);
  assert.equal(disagrees.reportedRemainingHours, 14);
  assert.equal(disagrees.impliedRemainingHours, 18);
});

test('OpenProject\'s own arithmetic corroborates the 24 h/day basis for WP 38', () => {
  const check = corroborate({
    estimated: parseIsoDuration('P1DT16H'),
    remaining: parseIsoDuration('P1DT6H'),
    percentDone: 25,
  });
  // 40 h x 75% = 30 h, which is exactly what OpenProject reports as remaining.
  assert.equal(check.agrees, true);
  assert.equal(check.impliedRemainingHours, 30);
  assert.equal(check.deltaHours, 0);

  // At 8 h/day the same strings give 24 h and 14 h, and the check fails — which is the point:
  // the basis is corroborated, not assumed.
  const wrong = corroborate({
    estimated: parseIsoDuration('P1DT16H', { hoursPerDay: 8 }),
    remaining: parseIsoDuration('P1DT6H', { hoursPerDay: 8 }),
    percentDone: 25,
  });
  assert.equal(wrong.agrees, false);
});

test('the corroboration is an observation, never used to adjust a figure', () => {
  const check = corroborate({ estimated: parseIsoDuration('PT40H'),
    remaining: parseIsoDuration('PT10H'), percentDone: 25 });
  assert.equal(check.agrees, false);
  assert.equal(check.reportedRemainingHours, 10, 'the reported value is unchanged');
  assert.match(check.note, /not an error/);
});

/* ── 11. the first fetch is a baseline, not history ────────────────────────────────────────── */

test('a first sighting yields NEW_ACTIVITY only, with no before-values', () => {
  const activity = normalizeWorkPackage(WP38, { projectId: 3 });
  const diff = diffActivity(null, activity);

  assert.deepEqual(diff.kinds, [CHANGE.NEW_ACTIVITY]);
  assert.equal(diff.findings.length, 1);
  assert.equal(diff.baseline, true);
  assert.equal(diff.findings[0].previous, null);
  // The sentence that must never appear: "progress went from 0% to 25%".
  assert.ok(!diff.kinds.includes(CHANGE.PROGRESS_CHANGED));
  assert.match(diff.findings[0].detail, /no earlier values exist/);
});

test('through the API, a first refresh reports new and not changed', async () => {
  const stub = stubOpenProject();
  const { api, call } = createApi({ fetchImpl: stub.fetchImpl });
  const first = await call('/openproject/refresh', { method: 'POST', body: {} });
  assert.equal(first.status, 200);
  assert.equal(first.body.counts.new, 1);
  assert.equal(first.body.counts.changed, 0);
  assert.deepEqual(first.body.counts.byKind, { NEW_ACTIVITY: 1 });
  api.close();
});

/* ── 12. progress 0% → 25%, and 25% → 50% ─────────────────────────────────────────────────── */

test('a progress change is reported with both values and the revision that carried it', () => {
  const previous = { progress_pct: 0, source_revision: 1, status: 'New',
    planned_start: '2026-11-12', planned_finish: '2026-11-18',
    estimated_raw: 'P1DT16H', remaining_raw: 'P2D', source_updated_at: '2026-11-10T11:30:00.000Z' };
  const current = normalizeWorkPackage(WP38, { projectId: 3 });
  const diff = diffActivity(previous, current);

  const progress = diff.findings.find(entry => entry.kind === CHANGE.PROGRESS_CHANGED);
  assert.equal(progress.previous, '0');
  assert.equal(progress.current, '25');
  assert.equal(progress.previousRevision, 1);
  assert.equal(progress.currentRevision, 1);
  assert.ok(diff.kinds.includes(CHANGE.WORK_ESTIMATE_CHANGED), 'remaining work moved too');
});

test('end to end: 25% to 50% is detected, logged, and leaves synthetic P6 untouched', async () => {
  const stub = stubOpenProject();
  const { api, call } = createApi({ fetchImpl: stub.fetchImpl });

  await call('/openproject/refresh', { method: 'POST', body: {} });
  const before = (await call('/overview')).body;
  const p6Before = (await call('/mappings')).body;
  const auditIds = new Set(((await call('/history/audit')).body.events
    ?? (await call('/history/audit')).body.rows ?? []).map(entry => entry.id));

  stub.update({ percentageDone: 50, remainingTime: 'PT20H', lockVersion: 4,
    updatedAt: '2026-11-10T13:30:00.000Z' });
  const after = await call('/openproject/refresh', { method: 'POST', body: {} });

  assert.equal(after.body.counts.changed, 1);
  assert.equal(after.body.activities[0].reportedProgressPct, 50);
  const logged = after.body.changes.filter(entry => entry.kind === CHANGE.PROGRESS_CHANGED);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].previous, '25');
  assert.equal(logged[0].current, '50');
  assert.equal(logged[0].previousRevision, 1);
  assert.equal(logged[0].currentRevision, 4);

  // The whole point of the phase: nothing synthetic moved.
  const overview = (await call('/overview')).body;
  const records = ({ auditEvents, ...rest }) => rest;
  assert.deepEqual(records(overview.totals), records(before.totals),
    'a live read changed one of the demo\'s record counts');
  assert.deepEqual((await call('/mappings')).body.summary, p6Before.summary);

  // The audit trail DOES grow, and should: a read happened and the trail is where you find that
  // out. Stated as the set difference rather than as arithmetic on counts, so the assertion says
  // what it means — every event the refresh added is a live-schedule event.
  const audit = (await call('/history/audit')).body;
  const rows = audit.events ?? audit.rows ?? [];
  const added = rows.filter(entry => !auditIds.has(entry.id));
  assert.ok(added.length > 0, 'the read was not audited');
  for (const entry of added) {
    assert.match(String(entry.event ?? ''), /^LIVE_SCHEDULE/,
      `the refresh wrote a non-live-schedule audit event: ${entry.event}`);
  }
  api.close();
});

/* ── 13. a revision that moves with no business change ─────────────────────────────────────── */

test('a revision bump with no tracked change is METADATA_ONLY, not a progress change', () => {
  const current = normalizeWorkPackage({ ...WP38, lockVersion: 9,
    updatedAt: '2026-11-10T14:00:00.000Z' }, { projectId: 3 });
  const previous = {
    progress_pct: 25, status: 'New', planned_start: '2026-11-12', planned_finish: '2026-11-18',
    estimated_raw: 'P1DT16H', remaining_raw: 'P1DT6H',
    source_revision: 1, source_updated_at: '2026-11-10T12:08:45.431Z',
  };
  const diff = diffActivity(previous, current);
  assert.deepEqual(diff.kinds, [CHANGE.METADATA_ONLY]);
  assert.equal(diff.findings[0].previous, '1');
  assert.equal(diff.findings[0].current, '9');
  assert.match(diff.findings[0].detail, /No progress change is implied/);
  assert.ok(!diff.kinds.includes(CHANGE.PROGRESS_CHANGED));
});

test('lockVersion is compared for inequality, never required to step by one', () => {
  const previous = {
    progress_pct: 25, status: 'New', planned_start: '2026-11-12', planned_finish: '2026-11-18',
    estimated_raw: 'P1DT16H', remaining_raw: 'P1DT6H', source_revision: 1,
  };
  // A jump of 14 — several edits between two polls — is still exactly one metadata change.
  const jumped = normalizeWorkPackage({ ...WP38, lockVersion: 15 }, { projectId: 3 });
  assert.deepEqual(diffActivity(previous, jumped).kinds, [CHANGE.METADATA_ONLY]);

  // And a revision that went BACKWARDS is a change, not a negative number.
  const backwards = normalizeWorkPackage({ ...WP38, lockVersion: 0 }, { projectId: 3 });
  assert.deepEqual(diffActivity({ ...previous, source_revision: 5 }, backwards).kinds,
    [CHANGE.METADATA_ONLY]);
});

test('a tracked field that moves while the revision does not is a SOURCE_CONFLICT', () => {
  const previous = {
    progress_pct: 25, status: 'New', planned_start: '2026-11-12', planned_finish: '2026-11-18',
    estimated_raw: 'P1DT16H', remaining_raw: 'P1DT6H', source_revision: 1,
  };
  const current = normalizeWorkPackage({ ...WP38, percentageDone: 60, lockVersion: 1 },
    { projectId: 3 });
  const diff = diffActivity(previous, current);
  assert.ok(diff.kinds.includes(CHANGE.SOURCE_CONFLICT));
  assert.equal(diff.findings[0].kind, CHANGE.SOURCE_CONFLICT, 'the conflict leads');
  assert.match(diff.findings[0].detail, /contradict each other/);
});

/* ── 14. repeated refresh with no change ───────────────────────────────────────────────────── */

test('refreshing twice with nothing changed writes no new change rows', async () => {
  const stub = stubOpenProject();
  const { api, call } = createApi({ fetchImpl: stub.fetchImpl });

  const first = await call('/openproject/refresh', { method: 'POST', body: {} });
  const second = await call('/openproject/refresh', { method: 'POST', body: {} });
  const third = await call('/openproject/refresh', { method: 'POST', body: {} });

  assert.equal(first.body.counts.new, 1);
  assert.equal(second.body.counts.unchanged, 1);
  assert.equal(second.body.counts.changed, 0);
  assert.equal(second.body.changeRowsWritten, 0, 'an unchanged refresh wrote a change row');
  assert.equal(third.body.changeRowsWritten, 0);
  // The log holds the single baseline event and nothing more.
  assert.equal(third.body.changes.length, 1);
  assert.equal(third.body.changes[0].kind, CHANGE.NEW_ACTIVITY);
  // But each READ is recorded, because each read did happen.
  assert.equal(third.body.fetches.length, 3);
  api.close();
});

test('re-detecting the same change is idempotent at the database level', async () => {
  const stub = stubOpenProject();
  const { api, call } = createApi({ fetchImpl: stub.fetchImpl });
  await call('/openproject/refresh', { method: 'POST', body: {} });
  stub.update({ percentageDone: 50, lockVersion: 2 });
  const a = await call('/openproject/refresh', { method: 'POST', body: {} });
  assert.ok(a.body.changeRowsWritten > 0);
  // Same revision, same values, asked again: the UNIQUE constraint absorbs it.
  const before = a.body.changes.length;
  const b = await call('/openproject/refresh', { method: 'POST', body: {} });
  assert.equal(b.body.changes.length, before);
  api.close();
});

/* ── 15. several changes in one revision ───────────────────────────────────────────────────── */

test('one revision carrying four changes produces four findings, not one', () => {
  const previous = {
    progress_pct: 25, status: 'New', planned_start: '2026-11-12', planned_finish: '2026-11-18',
    estimated_raw: 'P1DT16H', remaining_raw: 'P1DT6H', source_revision: 1,
  };
  const current = normalizeWorkPackage({ ...WP38,
    percentageDone: 70, startDate: '2026-11-16', dueDate: '2026-11-25',
    estimatedTime: 'P2D', remainingTime: 'PT12H', lockVersion: 6,
    _links: { ...WP38._links, status: { title: 'In progress' } } }, { projectId: 3 });

  const diff = diffActivity(previous, current);
  assert.deepEqual([...diff.kinds].sort(), [CHANGE.PROGRESS_CHANGED, CHANGE.SCHEDULE_CHANGED,
    CHANGE.STATUS_CHANGED, CHANGE.WORK_ESTIMATE_CHANGED].sort());
  // Six fields moved: progress, start, finish, status, estimate, remaining.
  assert.equal(diff.findings.length, 6);
  for (const finding of diff.findings) {
    assert.notEqual(finding.previous, finding.current);
    assert.ok(finding.label, 'every finding names the field a person would recognise');
  }
});

test('the summary counts activities, not findings', () => {
  const previous = { progress_pct: 25, status: 'New', planned_start: '2026-11-12',
    planned_finish: '2026-11-18', estimated_raw: 'P1DT16H', remaining_raw: 'P1DT6H',
    source_revision: 1 };
  const multi = diffActivity(previous, normalizeWorkPackage({ ...WP38, percentageDone: 70,
    startDate: '2026-11-16', lockVersion: 2 }, { projectId: 3 }));
  const counts = summarize([multi]);
  assert.equal(counts.changed, 1, 'one activity changed, however many fields moved');
  assert.equal(counts.findings, 2);
  assert.equal(counts.activities, 1);
});

test('every tracked field is covered by a change kind', () => {
  for (const spec of TRACKED) {
    assert.ok(Object.values(CHANGE).includes(spec.kind), `${spec.field} has no change kind`);
    assert.ok(spec.label, `${spec.field} has no human label`);
    assert.ok(spec.column, `${spec.field} has no snapshot column`);
  }
});

test('stored numbers and incoming numbers compare as values, not as strings', () => {
  // SQLite returns REAL as a number; OpenProject sends an integer. 80 and '80' are one value.
  assert.equal(sameValue(80, '80', { numeric: true }), true);
  assert.equal(sameValue(80, 80.0, { numeric: true }), true);
  // But absence and zero are not the same fact, in either direction.
  assert.equal(sameValue(null, 0, { numeric: true }), false);
  assert.equal(sameValue(0, null, { numeric: true }), false);
  assert.equal(sameValue(null, '', {}), true, 'both absent');
  assert.equal(sameValue('New', 'new', {}), false, 'a status is case-sensitive');
});

/* ── 16 & 17. mapping: approval, rejection, and no P6 overwrite ────────────────────────────── */

test('a matching name is evidence labelled weak, never an identification', () => {
  const evidence = nameEvidence('Cast Level 2 Columns', 'Cast Level 2 columns');
  assert.equal(evidence.basis, 'NAME_EXACT');
  assert.match(evidence.detail, /weak evidence/);
  assert.match(evidence.detail, /different scopes of work/);

  assert.equal(nameEvidence('Cast Level 2 Columns', 'Pour slab Level 3').basis, 'NONE');
  assert.equal(nameEvidence(null, 'anything').basis, 'NONE');
  assert.equal(normalizeName('Cast Level 2 Columns'), 'cast level 2 columns');
});

test('candidates are proposed with their effect stated, and never applied', async () => {
  const stub = stubOpenProject();
  const { api, call } = createApi({ fetchImpl: stub.fetchImpl });
  const refreshed = await call('/openproject/refresh', { method: 'POST', body: {} });

  const [link] = refreshed.body.proposedLinks;
  assert.equal(link.status, MAPPING.PROPOSED, 'a candidate must not arrive approved');
  assert.equal(link.externalId, '38');
  assert.equal(link.targetActivityId, 'A-1020');
  assert.equal(link.basis, 'NAME_EXACT');
  assert.match(link.evidence.detail, /weak evidence/);

  // Nothing may be compared yet.
  const links = await call('/openproject/links');
  assert.equal(links.body.links[0].comparison, null,
    'a comparison was available before anyone approved the link');
  api.close();
});

test('the comparison is gated on approval in the mapping layer itself', () => {
  const activity = normalizeWorkPackage(WP38, { projectId: 3 });
  const target = { activityId: 'A-1020', name: 'Cast Level 2 columns', reportedProgressPct: 80 };
  for (const status of [MAPPING.PROPOSED, MAPPING.REJECTED, MAPPING.CONFLICT, MAPPING.UNMAPPED]) {
    assert.equal(compare({ link: { id: 1, status }, activity, target }), null,
      `${status} unlocked a comparison`);
  }
  const allowed = compare({ link: { id: 1, status: MAPPING.APPROVED, decidedBy: 'A planner' },
    activity, target });
  assert.equal(allowed.differencePoints, -55);
  assert.equal(allowed.live.kind, 'LIVE');
  assert.equal(allowed.synthetic.kind, 'SYNTHETIC');
  assert.match(allowed.caveat, /not a measurement of the work/);
  assert.match(allowed.writeBack, /read-only/);
});

test('only a role that holds approve:SCHEDULE_LINK may decide a link', async () => {
  const stub = stubOpenProject();
  const { api, call } = createApi({ fetchImpl: stub.fetchImpl });
  const refreshed = await call('/openproject/refresh', { method: 'POST', body: {} });
  const linkId = refreshed.body.proposedLinks[0].id;

  // No session at all.
  const anonymous = await call(`/openproject/links/${linkId}/approve`, { method: 'POST', body: {} });
  assert.equal(anonymous.status, 403);
  assert.match(anonymous.body.error, /No demo session/);

  // A read-only role, refused in the server's own words, naming who may instead.
  const bim = await call('/session', { method: 'POST', body: { role: 'bimCoordinator' } });
  const refused = await call(`/openproject/links/${linkId}/approve`,
    { method: 'POST', body: {}, headers: { 'x-demo-session': bim.body.token } });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /BIM Coordinator may not approve SCHEDULE_LINK/);
  assert.match(refused.body.error, /Integration Lead|Project Planner/);

  // The planner may.
  const planner = await call('/session', { method: 'POST', body: { role: 'planner' } });
  const approved = await call(`/openproject/links/${linkId}/approve`,
    { method: 'POST', body: { note: 'Same scope, confirmed with the site team.' },
      headers: { 'x-demo-session': planner.body.token } });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.link.status, MAPPING.APPROVED);
  assert.ok(approved.body.comparison, 'approval must unlock the comparison');
  assert.match(approved.body.effect, /has not been modified/);
  api.close();
});

test('rejection records the decision and leaves the comparison locked', async () => {
  const stub = stubOpenProject();
  const { api, call } = createApi({ fetchImpl: stub.fetchImpl });
  const refreshed = await call('/openproject/refresh', { method: 'POST', body: {} });
  const linkId = refreshed.body.proposedLinks[0].id;
  const planner = await call('/session', { method: 'POST', body: { role: 'planner' } });

  const rejected = await call(`/openproject/links/${linkId}/reject`,
    { method: 'POST', body: { note: 'Different scope — ours excludes the rebar.' },
      headers: { 'x-demo-session': planner.body.token } });
  assert.equal(rejected.body.link.status, MAPPING.REJECTED);
  assert.equal(rejected.body.comparison, null);

  // A decided link cannot be decided again.
  const again = await call(`/openproject/links/${linkId}/approve`,
    { method: 'POST', body: {}, headers: { 'x-demo-session': planner.body.token } });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /cannot be decided again/);

  // And it is not re-proposed on the next refresh — the screen does not argue with its reviewer.
  const next = await call('/openproject/refresh', { method: 'POST', body: {} });
  assert.deepEqual(next.body.proposedLinks, []);
  api.close();
});

test('approving a link does not write the synthetic P6 activity', async () => {
  const stub = stubOpenProject();
  const { api, call } = createApi({ fetchImpl: stub.fetchImpl });
  const refreshed = await call('/openproject/refresh', { method: 'POST', body: {} });
  const linkId = refreshed.body.proposedLinks[0].id;

  const before = (await call('/progress/activities')).body;
  const planner = await call('/session', { method: 'POST', body: { role: 'planner' } });
  const approved = await call(`/openproject/links/${linkId}/approve`,
    { method: 'POST', body: {}, headers: { 'x-demo-session': planner.body.token } });
  const after = (await call('/progress/activities')).body;

  // The live value is 25 and the synthetic one is 80. After approval, both are still themselves.
  assert.equal(approved.body.comparison.live.progressPct, 25);
  assert.equal(approved.body.comparison.synthetic.progressPct, 80);
  assert.equal(approved.body.comparison.differencePoints, -55);
  assert.deepEqual(after, before, 'approving a mapping altered the synthetic schedule');
  api.close();
});

test('candidatesFor offers every plausible target rather than choosing one silently', () => {
  const activity = normalizeWorkPackage(WP38, { projectId: 3 });
  const candidates = candidatesFor(activity, [
    { activityId: 'A-1020', name: 'Cast Level 2 columns', reportedProgressPct: 80 },
    { activityId: 'A-1021', name: 'Cast level 2 Columns', reportedProgressPct: 40 },
    { activityId: 'A-9999', name: 'Install curtain wall', reportedProgressPct: 10 },
  ]);
  assert.equal(candidates.length, 2, 'both plausible targets must be offered');
  assert.ok(candidates.every(entry => entry.basis !== 'NONE'));
  assert.ok(candidates.every(entry => /read-only side-by-side comparison/.test(entry.effect)));
  assert.ok(candidates.every(entry => /does not copy progress/.test(entry.effect)));
});

/* ── 18. the token never reaches the browser or the logs ───────────────────────────────────── */

test('no adapter result contains the token, in any state', async () => {
  const cases = [
    ['connected', stubOpenProject().fetchImpl],
    ['401', async () => reply(opError('x', 'Unauthenticated.'), 401)],
    ['500', async () => reply(opError('x', 'Boom.'), 500)],
    ['not json', async () => new Response('nope', { status: 200 })],
    // The nastiest case: an upstream that echoes the credential back at us.
    ['echoes the token', async () => reply({ _type: 'Error', message: `token was ${TOKEN}` }, 200)],
  ];
  for (const [name, fetchImpl] of cases) {
    const adapter = createOpenProjectAdapter({ env: ENV, fetchImpl, logger: quiet });
    for (const result of [await adapter.health(), await adapter.workPackages(),
      await adapter.workPackage('38')]) {
      assert.ok(!JSON.stringify(result).includes(TOKEN),
        `the token leaked in the "${name}" case (${result.state})`);
    }
  }
});

test('an upstream that echoes the token has its body discarded, not forwarded', async () => {
  const adapter = createOpenProjectAdapter({ env: ENV, logger: quiet,
    fetchImpl: async () => reply({ _type: 'Project', id: 3, name: `leak ${TOKEN}` }) });
  const result = await adapter.health();
  assert.equal(result.state, STATE.DATA_INVALID);
  assert.match(result.reason, /echoed the API token/);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('nothing logged contains the token or an Authorization header value', async () => {
  const lines = [];
  const logger = { warn: (...args) => lines.push(args.join(' ')),
    error: (...args) => lines.push(args.join(' ')), log: (...args) => lines.push(args.join(' ')) };
  for (const fetchImpl of [
    async () => reply(opError('x', `Unauthenticated. Supplied token: ${TOKEN}`), 401),
    async () => { throw new Error('ECONNRESET'); },
    async () => new Response('not json', { status: 200 }),
  ]) {
    const adapter = createOpenProjectAdapter({ env: ENV, fetchImpl, logger });
    await adapter.health();
    await adapter.workPackages();
  }
  assert.ok(lines.length > 0, 'the failures were not logged at all, so this proves nothing');
  for (const line of lines) {
    assert.ok(!line.includes(TOKEN), `a log line carried the token: ${line}`);
    assert.ok(!/Authorization\s*[:=]\s*\S/i.test(line), `a log line carried the header: ${line}`);
    assert.ok(!/Basic\s+[A-Za-z0-9+/=]{8,}/.test(line), `a log line carried Basic creds: ${line}`);
  }
});

test('no API response carries the token, across every route and state', async () => {
  for (const [name, fetchImpl] of [
    ['connected', stubOpenProject().fetchImpl],
    ['401', async () => reply(opError('x', `bad token ${TOKEN}`), 401)],
  ]) {
    const { api, call } = createApi({ fetchImpl });
    for (const path of ['/openproject/health', '/openproject/project', '/openproject/work-packages',
      '/openproject/work-packages/38', '/openproject/changes', '/openproject/links']) {
      const result = await call(path);
      assert.ok(!JSON.stringify(result.body).includes(TOKEN),
        `the token reached the browser from ${path} in the "${name}" case`);
    }
    const refreshed = await call('/openproject/refresh', { method: 'POST', body: {} });
    assert.ok(!JSON.stringify(refreshed.body).includes(TOKEN));
    api.close();
  }
});

test('no frontend file carries an OpenProject credential or the instance hostname', async () => {
  const files = (await readdir(new URL('../src/construction/', import.meta.url)))
    .filter(name => name.endsWith('.js'));
  assert.ok(files.length > 5, 'no frontend files found, so this proves nothing');
  for (const name of files) {
    const text = await readFile(new URL(`../src/construction/${name}`, import.meta.url), 'utf8');
    assert.ok(!/OPENPROJECT_API_TOKEN/.test(text), `${name} names the token variable`);
    // A header VALUE, not the word: `approvalCenter.js` discusses authorization in prose, which
    // is fine. What must not exist is a frontend file building the credential.
    assert.ok(!/Authorization['"\s]*:/.test(text), `${name} builds an Authorization header`);
    assert.ok(!/Basic\s*\$\{|btoa\(/.test(text), `${name} encodes Basic credentials`);
    assert.ok(!/openproject\.com/.test(text),
      `${name} hard-codes the instance host; it must come from the server`);
  }
});

/* ── 19. no writes to OpenProject ──────────────────────────────────────────────────────────── */

test('every request to OpenProject is a GET, including through a link approval', async () => {
  const stub = stubOpenProject();
  const { api, call } = createApi({ fetchImpl: stub.fetchImpl });

  await call('/openproject/health');
  await call('/openproject/refresh', { method: 'POST', body: {} });
  await call('/openproject/work-packages/38');
  const links = await call('/openproject/links');
  const planner = await call('/session', { method: 'POST', body: { role: 'planner' } });
  await call(`/openproject/links/${links.body.links[0].id}/approve`,
    { method: 'POST', body: {}, headers: { 'x-demo-session': planner.body.token } });

  assert.ok(stub.calls.length > 0, 'nothing was requested, so this proves nothing');
  for (const entry of stub.calls) {
    assert.equal(entry.method, 'GET', `a ${entry.method} reached OpenProject at ${entry.path}`);
  }
  api.close();
});

test('the API refuses write methods on every OpenProject route', async () => {
  const stub = stubOpenProject();
  const { api, call } = createApi({ fetchImpl: stub.fetchImpl });
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    for (const path of ['/openproject/work-packages', '/openproject/project',
      '/openproject/refresh', '/openproject/links']) {
      const result = await call(path, { method });
      assert.equal(result.status, 404, `${method} ${path} was accepted`);
    }
  }
  assert.equal(stub.calls.length, 0, 'a rejected write still reached OpenProject');
  api.close();
});

test('a project id from the environment is validated before it reaches a URL', async () => {
  for (const bad of ['3; DROP TABLE', '../../admin', '3/../../users', 'abc', '']) {
    const stub = stubOpenProject();
    const adapter = createOpenProjectAdapter({ env: { ...ENV, OPENPROJECT_PROJECT_ID: bad },
      fetchImpl: stub.fetchImpl, logger: quiet });
    const result = await adapter.health();
    assert.equal(result.state, STATE.CONNECTION_FAILED, `"${bad}" was accepted as a project id`);
    assert.equal(result.failure, FAILURE.CONFIG);
    assert.equal(stub.calls.length, 0, `"${bad}" reached the network`);
  }
  assert.equal(parseId('38'), '38');
  assert.equal(parseId('0038'), '0038');
  assert.equal(parseId('38 '), '38');
  assert.equal(parseId('3.5'), null);
  assert.equal(parseId('-3'), null);
});

test('a work-package id from the browser is validated, so no path can be traversed', async () => {
  const stub = stubOpenProject();
  const { api, call } = createApi({ fetchImpl: stub.fetchImpl });
  for (const bad of ['abc', '38x']) {
    const result = await call(`/openproject/work-packages/${bad}`);
    assert.equal(result.status, 400, `"${bad}" was accepted`);
  }
  assert.ok(!stub.calls.some(entry => /abc|38x/.test(entry.path)));
  api.close();
});

test('the base URL must be https and on the allowlist', () => {
  for (const bad of ['http://superdnatechnolab.openproject.com',
    'https://evil.example.com', 'not a url']) {
    const client = createOpenProjectClient({ env: { ...ENV, OPENPROJECT_BASE_URL: bad } });
    assert.equal(client.baseUrl().ok, false, `"${bad}" was allowed`);
  }
  const good = createOpenProjectClient({ env: ENV }).baseUrl();
  assert.equal(good.ok, true);
  assert.equal(good.baseUrl, 'https://superdnatechnolab.openproject.com');
});

test('a failed read never becomes a sync run or a write-back proposal', async () => {
  const stub = stubOpenProject();
  const { api, call } = createApi({ fetchImpl: stub.fetchImpl });
  const before = (await call('/overview')).body.totals;
  await call('/openproject/refresh', { method: 'POST', body: {} });
  const outbound = (await call('/outbound')).body;
  const after = (await call('/overview')).body;

  assert.equal(after.totals.syncRuns, before.syncRuns, 'a read opened a sync run');
  assert.deepEqual(outbound.proposals, [], 'a read created a write-back proposal');
  assert.match(after.interfaces.find(entry => entry.id === 'INT-01').health, /NEVER_RUN/);
  api.close();
});

test('the audit trail records the read as a read, with no interface id', async () => {
  const stub = stubOpenProject();
  const { api, call } = createApi({ fetchImpl: stub.fetchImpl });
  await call('/openproject/refresh', { method: 'POST', body: {} });
  const audit = (await call('/history/audit')).body;
  const events = (audit.events ?? audit.rows ?? []).filter(entry =>
    String(entry.event ?? '').startsWith('LIVE_SCHEDULE'));
  assert.ok(events.length > 0, 'the read was not recorded at all');
  const read = events.find(entry => entry.event === 'LIVE_SCHEDULE_READ');
  assert.ok(read, 'no LIVE_SCHEDULE_READ event');
  assert.ok(!read.interfaceId && !read.interface_id,
    'a live read was filed against one of the five pilot interfaces');
  api.close();
});

/* ── a failed refresh keeps the snapshot and marks it stale ────────────────────────────────── */

test('a failed refresh preserves the last snapshot and never shows it as fresh', async () => {
  const stub = stubOpenProject();
  let broken = false;
  const fetchImpl = async (url, options) => (broken
    ? reply(opError('x', 'Service unavailable.'), 503)
    : stub.fetchImpl(url, options));
  const { api, call } = createApi({ fetchImpl });

  const good = await call('/openproject/refresh', { method: 'POST', body: {} });
  assert.equal(good.body.stale, false);
  assert.equal(good.body.activities.length, 1);
  const freshAt = good.body.lastSuccessfulFetchAt;

  broken = true;
  const bad = await call('/openproject/refresh', { method: 'POST', body: {} });
  assert.equal(bad.body.state, STATE.CONNECTION_FAILED);
  assert.equal(bad.body.activities.length, 1, 'the snapshot was discarded on a failed read');
  assert.equal(bad.body.stale, true);
  assert.match(bad.body.staleReason, /left untouched/);
  assert.equal(bad.body.lastSuccessfulFetchAt, freshAt,
    'a failed read moved the "last successful" timestamp');

  // And the stored view says the same thing, so a page reload cannot lose the warning.
  const stored = await call('/openproject/work-packages');
  assert.equal(stored.body.stale, true);
  assert.ok(stored.body.staleReason);
  assert.equal(stored.body.lastSuccessfulFetchAt, freshAt);
  api.close();
});

test('an activity that stops being returned is REMOVED and its snapshot is kept', async () => {
  const stub = stubOpenProject();
  const { api, call } = createApi({ fetchImpl: stub.fetchImpl });
  await call('/openproject/refresh', { method: 'POST', body: {} });
  stub.state.workPackages = [];
  const result = await call('/openproject/refresh', { method: 'POST', body: {} });

  const removed = result.body.changes.find(entry => entry.kind === CHANGE.REMOVED);
  assert.ok(removed, 'an activity vanished without a word');
  assert.equal(removed.externalId, '38');
  // The snapshot survives, because deleted and filtered-out are not the same thing.
  const stored = await call('/openproject/work-packages');
  assert.equal(stored.body.activities.length, 1);
  api.close();
});

/* ── 20. I-595 and the rest of the demo are untouched ──────────────────────────────────────── */

test('the stored view reports what it knows and never claims an untested connection', async () => {
  const stub = stubOpenProject();

  // Configured, never read: "not read yet", not "unknown" and not "connected".
  const fresh = createApi({ fetchImpl: stub.fetchImpl });
  const unread = await fresh.call('/openproject/work-packages');
  assert.equal(unread.body.state, 'NOT_READ');
  assert.equal(unread.body.configured, true);
  assert.equal(unread.body.activities.length, 0);
  assert.equal(stub.calls.length, 0, 'the stored view reached OpenProject');
  assert.ok(OP_STATE[unread.body.state], 'the screen cannot render the stored view\'s state');
  assert.notEqual(OP_STATE[unread.body.state].tone, 'ok');
  fresh.api.close();

  // No token: a configuration state, with the fix named.
  const unconfigured = createApi({ env: { OPENPROJECT_PROJECT_ID: '3' }, fetchImpl: stub.fetchImpl });
  const none = await unconfigured.call('/openproject/work-packages');
  assert.equal(none.body.state, STATE.NOT_CONFIGURED);
  assert.match(none.body.reason, /OPENPROJECT_API_TOKEN is not set/);
  unconfigured.api.close();

  // After a successful read the stored view echoes that read's outcome, dated.
  const used = createApi({ fetchImpl: stub.fetchImpl });
  await used.call('/openproject/refresh', { method: 'POST', body: {} });
  const stored = await used.call('/openproject/work-packages');
  assert.equal(stored.body.state, STATE.CONNECTED);
  assert.ok(stored.body.lastSuccessfulFetchAt, 'a stored view with rows must be dated');
  used.api.close();
});

test('the OpenProject routes are the only thing that answers under /openproject', async () => {
  const stub = stubOpenProject();
  const { api, call } = createApi({ fetchImpl: stub.fetchImpl });
  const unknown = await call('/openproject/nonsense');
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error, /Unknown OpenProject route/);
  api.close();
});

test('no I-595 module imports anything from the OpenProject integration', async () => {
  const forbidden = /openProject|OPENPROJECT|openproject/;
  for (const name of ['i595Demo.js', 'entry.js', 'appNav.js', 'askTheTwin.js']) {
    const text = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
    assert.ok(!forbidden.test(text), `src/${name} references the OpenProject integration`);
  }
});

test('the live-schedule tables are isolated from the demo\'s own figures and its reset', async () => {
  const { ALL_TABLES, LIVE_SCHEDULE_TABLES } = await import('../server/construction/db.mjs');
  for (const table of LIVE_SCHEDULE_TABLES) {
    assert.ok(!ALL_TABLES.includes(table),
      `${table} is in ALL_TABLES, so a demo reset would destroy live observations`);
  }

  const stub = stubOpenProject();
  const { api, call } = createApi({ fetchImpl: stub.fetchImpl });
  await call('/openproject/refresh', { method: 'POST', body: {} });
  const before = (await call('/openproject/work-packages')).body.activities.length;
  assert.equal(before, 1);

  await call('/reset', { method: 'POST', body: {} });
  const after = (await call('/openproject/work-packages')).body.activities.length;
  assert.equal(after, before, 'resetting the demo destroyed the live-schedule snapshot');
  api.close();
});

test('the store writes to no table outside its own namespace', async () => {
  const text = await readFile(new URL('../server/construction/openProjectStore.mjs',
    import.meta.url), 'utf8');
  // Comments stripped first: this file's own header says "there is no INSERT or UPDATE here",
  // and a scan that reads prose as SQL would flag the sentence promising the opposite.
  const sql = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/^\s*\*.*$/gm, ' ');
  const writes = sql.match(/(?:INSERT INTO|INSERT OR IGNORE INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g) ?? [];
  assert.ok(writes.length > 0, 'no write statements found, so this proves nothing');
  for (const statement of writes) {
    const table = statement.split(/\s+/).pop();
    assert.ok(table.startsWith('live_schedule_'),
      `the store writes to ${table}, which is outside its namespace`);
  }
  // The one deliberate exception, through the shared helper rather than raw SQL.
  assert.match(text, /recordAudit/);
  assert.ok(!/INSERT INTO\s+(src_|activity|element|cost|sync_run|mapping)/.test(sql));
});

test('the mapping layer never writes to the synthetic P6 source table', async () => {
  const text = await readFile(new URL('../server/construction/openProjectMapping.mjs',
    import.meta.url), 'utf8');
  assert.match(text, /src_p6_activity/, 'it should read the synthetic table');
  assert.ok(!/(?:INSERT|UPDATE|DELETE)[\s\S]{0,80}src_p6_activity/.test(text),
    'the mapping layer writes to the synthetic P6 table');
});

/* ── the screen's own vocabulary ───────────────────────────────────────────────────────────── */

test('every adapter state and change kind has a label and a tone', () => {
  for (const state of Object.values(STATE)) {
    assert.ok(OP_STATE[state], `the screen cannot render state ${state}`);
    assert.ok(['ok', 'warn', 'bad', 'info'].includes(OP_STATE[state].tone));
  }
  for (const kind of Object.values(CHANGE)) {
    assert.ok(CHANGE_LABEL[kind], `the screen cannot render change ${kind}`);
  }
});

test('PARTIAL does not read as a clean success on screen', () => {
  assert.notEqual(OP_STATE.PARTIAL.tone, 'ok');
  assert.match(OP_STATE.PARTIAL.label, /incomplete/i);
});

test('an absent percentage is a dash, never 0%', () => {
  assert.equal(pct(null), '—');
  assert.equal(pct(undefined), '—');
  assert.equal(pct(0), '0%', 'a real zero is still zero');
  assert.equal(pct(25), '25%');
});

test('a work amount always shows the source string beside the hours', () => {
  const rendered = work(40, 'P1DT16H');
  assert.match(rendered, /40 h/);
  assert.match(rendered, /P1DT16H/, 'the source value must survive on screen');
  assert.match(work(null, 'P1M'), /not convertible/);
  assert.equal(work(null, null), '—');
});

test('the source is labelled LIVE and says what it is not', () => {
  assert.equal(SOURCE.kind, 'LIVE');
  assert.match(SOURCE.notP6, /not Primavera P6/);
  assert.match(SOURCE.notSynchro, /does not update SYNCHRO 4D/);
  assert.match(SOURCE.scope, /Read-only/);
});

test('the synthetic P6 activities are labelled synthetic wherever they are read', async () => {
  const { openConstructionDb } = await import('../server/construction/db.mjs');
  const { seedSourceSystems } = await import('../server/construction/seed.mjs');
  const db = openConstructionDb({ path: ':memory:' });
  seedSourceSystems(db);

  const rows = syntheticP6Activities(db);
  assert.ok(rows.length > 0, 'the synthetic P6 seed is empty, so this proves nothing');
  for (const row of rows) {
    assert.equal(row.kind, 'SYNTHETIC');
    assert.match(row.label, /synthetic/i);
  }
  // The worked example the brief names, with the progress the demo actually stores.
  const a1020 = rows.find(entry => entry.activityId === 'A-1020');
  assert.ok(a1020, 'A-1020 is missing from the synthetic seed');
  assert.equal(a1020.name, 'Cast Level 2 columns');
  assert.equal(a1020.reportedProgressPct, 80);
  db.close();
});

test('the comparison names each side\'s kind, so neither number stands alone', () => {
  const activity = normalizeWorkPackage(WP38, { projectId: 3 });
  const comparison = compare({
    link: { id: 1, status: MAPPING.APPROVED, decidedBy: 'A planner', decidedAt: '2026-11-10T15:00:00.000Z' },
    activity,
    target: { activityId: 'A-1020', name: 'Cast Level 2 columns', reportedProgressPct: 80,
      dataDate: '2026-11-01' },
  });
  assert.equal(comparison.live.kind, 'LIVE');
  assert.equal(comparison.live.system, SOURCE.label);
  assert.equal(comparison.synthetic.kind, 'SYNTHETIC');
  assert.match(comparison.synthetic.system, /demo data/);
  // Percentage POINTS, named as points.
  assert.equal(comparison.differencePoints, -55);
  assert.match(comparison.caveat, /different baselines|own baseline/);
  assert.equal(comparison.comparable, true);
});

test('an incomparable pair reports that rather than a difference of zero', () => {
  const activity = normalizeWorkPackage({ ...WP38, percentageDone: null }, { projectId: 3 });
  const comparison = compare({ link: { id: 1, status: MAPPING.APPROVED }, activity,
    target: { activityId: 'A-1020', name: 'Cast Level 2 columns', reportedProgressPct: 80 } });
  assert.equal(comparison.comparable, false);
  assert.equal(comparison.differencePoints, null, 'an absent percentage became a difference');
});
