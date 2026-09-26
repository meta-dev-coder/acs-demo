/**
 * API-level proof of the Live DataConnect pipeline over real loopback HTTP: fake FL511 client ->
 * fl511Service -> runLiveDcCycle -> guarded writer -> DataConnect stand-in. Fully offline; the
 * writer runs on real time, while FL511, the sync and the workflow share one fake clock.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadI595Network } from '../server/i595Network.mjs';
import { createFl511Service } from '../server/fl511Service.mjs';
import { loadConfig } from '../server/config.mjs';
import {
  HISTORICAL_CLASSES, HISTORICAL_NUMERIC_CLASS_IDS, LIVE_CLASS, LIVE_CLASS_NAMES, REF,
} from '../server/liveDc/classes.mjs';
import { createDcWriter, loadDcWriterConfig } from '../server/liveDc/dcWriter.mjs';
import { createDcStandin } from '../server/liveDc/standin.mjs';
import { loadWorkflowConfig } from '../server/liveDc/workflow.mjs';
import { createAssetCache, createCycleMemory, runLiveDcCycle } from '../server/liveDc/cycle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const network = await loadI595Network(join(ROOT, 'public', 'data'));
const workflowConfig = loadWorkflowConfig();
const CRASH_CATEGORIES = workflowConfig.subtypes.find(s => s.id === 'crash').categories;
const { EVENTS, TICKETS, TASKS, WORK_ORDERS, INSPECTIONS, ASSET_STATUS } = LIVE_CLASS;

const T0 = Date.parse('2026-09-25T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const silent = { info() {}, log() {}, warn() {}, error() {} };

const EB = network.lines.find(line => line.facility === 'I595_EB').coordinates;
const DAVIE_CRASH = { itemId: '868702', latitude: 26.093417, longitude: -80.226583 };
const DISABLED = { itemId: '900001', latitude: EB[60][1], longitude: EB[60][0] };
const CONSTRUCTION = { itemId: '900002', latitude: EB[120][1], longitude: EB[120][0] };
const STATEWIDE = { itemId: '845391', latitude: 28.474586, longitude: -81.631436 };
const DETAILS = {
  868702: { title: 'Crash', description: 'Crash on I-595 West at Davie Rd. 2 right lanes blocked.', fields: [{ label: 'Severity', value: 'Minor' }] },
  900001: { title: 'Disabled Vehicle', description: 'Disabled vehicle on I-595 East. Right shoulder blocked.', fields: [] },
  900002: { title: 'Construction', description: 'Construction on I-595 East. Right lane blocked.', fields: [] },
};

function stubClient(feed) {
  const layer = key => async () => {
    if (feed.down) throw new Error('FL511 down');
    return feed[key];
  };
  return {
    fetchIncidents: layer('incidents'),
    fetchClosures: layer('closures'),
    fetchConstruction: layer('construction'),
    fetchCongestion: async () => [],
    fetchDisabledVehicles: layer('disabledVehicles'),
    fetchEventDetails: async (_layerId, itemId) => {
      if (feed.down) throw new Error('FL511 down');
      return DETAILS[itemId] ?? null;
    },
  };
}

async function createHarness({ incrementalMode }) {
  const standin = createDcStandin({ processingDelayMs: 1, curationDelayMs: 1, incrementalMode, logger: silent });
  const server = await standin.listen(0);
  const writer = createDcWriter({
    config: { ...loadDcWriterConfig({ DC_WRITER_BASE_URL: server.url, DC_WRITER_LOAD_BASE_URL: server.url, DC_WRITER_ACCESS_TOKEN: 'test-token' }), pollIntervalMs: 5, processTimeoutMs: 5000, curationTimeoutMs: 5000 },
    logger: silent,
  });
  const clock = { t: T0 };
  const now = () => clock.t;
  const feed = { down: false, incidents: [DAVIE_CRASH, STATEWIDE], closures: [], construction: [CONSTRUCTION], disabledVehicles: [DISABLED] };
  const service = createFl511Service({ config: loadConfig({}), network, client: stubClient(feed), logger: silent, now });
  const memory = createCycleMemory();
  const assetCache = createAssetCache({ writer, now });
  const liveDtos = await writer.resolveLiveClasses();
  return {
    standin, server, writer, clock, feed, service, liveDtos,
    async cycle(atSeconds) {
      clock.t = T0 + atSeconds * 1000;
      const report = await runLiveDcCycle({
        writer, service, now, workflowConfig, profileName: 'demo', memory, assetCache, logger: silent,
      });
      assert.deepEqual(report.errors, [], `cycle at +${atSeconds}s`);
      return report;
    },
    async curated(className) {
      return Object.fromEntries((await writer.readAll(liveDtos.get(className))).map(item => [item.keyInSource, item]));
    },
    rawCounts: () => Object.fromEntries(LIVE_CLASS_NAMES.map(name => [name, standin.processes(name).raw.length])),
    async close() {
      service.stop();
      await server.close();
    },
  };
}

// Steps shared by the merge and replace runs.
async function stepEventsLand(h) {
  await h.cycle(0);
  const events = await h.curated(EVENTS);
  assert.deepEqual(Object.keys(events).sort(), ['FL511-868702', 'FL511-900001', 'FL511-900002']);
  for (const item of Object.values(events)) assert.equal(item.attributes.status, 'active');
  const crash = events['FL511-868702'].attributes;
  assert.equal(crash.event_type, 'INCIDENT');
  assert.equal(crash['segment ID'], '104W');
  assert.equal(crash.blocked_lanes, '2');
  assert.equal(crash.first_seen_at, iso(T0));

  const tickets = await h.curated(TICKETS);
  assert.equal(tickets['TIC-FL511-868702'].attributes['Ticket Status'], 'Open');
  assert.ok(tickets['TIC-FL511-900001'], 'the disabled vehicle spawns a chain');
  assert.equal(tickets['TIC-FL511-900002'], undefined, 'construction spawns nothing');
  const tasks = await h.curated(TASKS);
  const crashTasks = Object.keys(tasks).filter(k => k.startsWith('TSK-FL511-868702-'));
  assert.deepEqual(crashTasks.sort(), ['TSK-FL511-868702-01', 'TSK-FL511-868702-02', 'TSK-FL511-868702-03']);
  for (const key of crashTasks) assert.equal(tasks[key].attributes['Task Status'], 'Open');
  assert.equal(Object.keys(tasks).filter(k => k.startsWith('TSK-FL511-900001-')).length, 2);

  for (const name of LIVE_CLASS_NAMES) {
    const invalid = h.standin.snapshot(name).filter(r => !r.valid).map(r => r.keyInSource);
    assert.deepEqual(invalid, [], `${name} has invalid curated records`);
  }
}

async function stepRepollIsIdempotent(h, atSeconds) {
  const before = h.rawCounts();
  const report = await h.cycle(atSeconds);
  assert.deepEqual(h.rawCounts(), before, 'no new raw-data-process on any Live class');
  assert.deepEqual(h.standin.invalidReasons(EVENTS), {}, 'DataConnect accepts every Live Events DateTime');
  const events = Object.values(await h.curated(EVENTS));
  assert.ok(events.length > 0);
  for (const { attributes } of events) {
    // Read back the way real DataConnect returns a DateTime; the diff above still saw no change.
    assert.match(attributes.reported_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000\+00:00$/);
    assert.match(attributes.updated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000\+00:00$/);
  }
  return report;
}

async function stepEventsClear(h, atSeconds) {
  h.feed.incidents = [STATEWIDE];
  h.feed.disabledVehicles = [];
  await h.cycle(atSeconds);
  const events = await h.curated(EVENTS);
  for (const key of ['FL511-868702', 'FL511-900001']) {
    assert.equal(events[key].attributes.status, 'cleared', key);
    assert.equal(events[key].attributes.cleared_at, iso(T0 + atSeconds * 1000), key);
  }
  assert.equal(events['FL511-900002'].attributes.status, 'active');
  assert.equal(events['FL511-900002'].attributes.cleared_at, undefined);
}

async function stepReactivateAsClosure(h, atSeconds) {
  h.feed.down = false;
  h.feed.closures = [DAVIE_CRASH];
  const report = await h.cycle(atSeconds);
  assert.equal(report.sourceStatus, 'LIVE');
  assert.equal(report.sync.stats.reactivated, 1);
  const events = await h.curated(EVENTS);
  assert.equal(Object.keys(events).length, 3, 'same keyInSource, no duplicate record');
  const reactivated = events['FL511-868702'].attributes;
  assert.equal(reactivated.event_type, 'CLOSURE');
  assert.equal(reactivated.status, 'active');
  assert.equal('cleared_at' in reactivated, false, 'cleared_at is wiped, not left behind');
  assert.equal(reactivated.first_seen_at, iso(T0));
  assert.equal((await h.curated(TICKETS))['TIC-FL511-868702'].attributes.incident_subtype, 'crash', 'the chain is sticky');
}

describe('Live DataConnect end to end (incrementalMode merge)', () => {
  let h;
  let assetsBefore;
  let segmentsBefore;
  before(async () => {
    h = await createHarness({ incrementalMode: 'merge' });
    assetsBefore = h.standin.snapshot(REF.ASSETS);
    segmentsBefore = h.standin.snapshot(REF.SEGMENTS);
  });
  after(() => h?.close());

  test('1. corridor events land in Live Events and spawn valid workflow records', () => stepEventsLand(h));

  test('2. re-polling the same feed writes nothing', () => stepRepollIsIdempotent(h, 30));

  test('3. the work order opens at +120 s', async () => {
    await h.cycle(150);
    assert.equal((await h.curated(WORK_ORDERS))['WO-FL511-868702'].attributes['Work Order Status'], 'Open');
    assert.equal((await h.curated(TICKETS))['TIC-FL511-868702'].attributes['Ticket Status'], 'In Progress');
  });

  test('4. events leaving the feed are cleared, never deleted', () => stepEventsClear(h, 180));

  test('5. the post-clear inspection finds the damaged asset; the disabled chain passes', async () => {
    await h.cycle(300);
    const inspections = await h.curated(INSPECTIONS);
    const crash = inspections['INSP-FL511-868702'].attributes;
    assert.equal(crash.pass_fail, 'Fail');
    assert.ok(CRASH_CATEGORIES.includes(crash.asset_type), crash.asset_type);
    assert.ok(crash.asset_id);
    const status = (await h.curated(ASSET_STATUS))[`AST-${crash.asset_id}`].attributes;
    assert.equal(status.status, 'Damaged');
    assert.equal(status.source_inspection_id, 'INSP-FL511-868702');
    assert.equal((await h.curated(TICKETS))['TIC-FL511-868702'].attributes['Ticket Status'], 'In Progress');

    assert.equal(inspections['INSP-FL511-900001'].attributes.pass_fail, 'Pass');
    const disabledWo = (await h.curated(WORK_ORDERS))['WO-FL511-900001'].attributes;
    assert.equal(disabledWo['Work Order Status'], 'Completed');
    assert.ok(disabledWo['Close Date']);
  });

  test('6. an FL511 outage writes no events and clears nothing', async () => {
    h.feed.down = true;
    const before = h.rawCounts();
    const report = await h.cycle(500);
    assert.equal(report.sourceStatus, 'STALE');
    assert.equal(report.sync.skipped, true);
    assert.equal(h.rawCounts()[EVENTS], before[EVENTS]);
    assert.equal((await h.curated(EVENTS))['FL511-900002'].attributes.status, 'active');
  });

  test('7. the same itemId returning as a closure reactivates the same record', async () => {
    await stepReactivateAsClosure(h, 520);
    await stepRepollIsIdempotent(h, 530);
  });

  test('9. the writer and the stand-in refuse every non-Live or non-Incremental write', async () => {
    const assetsDto = await h.writer.findClassByName(REF.ASSETS);
    const requestCount = h.standin.requests.length;
    const record = { keyInSource: 'X1', code: 'X1', name: 'x', description: 'x' };
    await assert.rejects(h.writer.loadRecords(assetsDto, [record]), { code: 'not_allowlisted' });
    assert.equal(h.standin.requests.length, requestCount, 'refused before any request');

    const handBuilt = { ...structuredClone(h.liveDtos.get(TICKETS)), classId: 11 };
    await assert.rejects(h.writer.loadRecords(handBuilt, []), { code: 'historical_class' });

    const events = h.liveDtos.get(EVENTS);
    await assert.rejects(h.writer.loadRecords(events, [], { loadType: 'Full' }), { code: 'load_type_refused' });
    await assert.rejects(h.writer.loadRecords(events, [], { loadType: 'Deletion' }), { code: 'load_type_refused' });
    assert.equal(h.standin.requests.length, requestCount);

    const post = (path, body) => fetch(`${h.server.url}${path}`, {
      method: 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const register = await post('/v1/loads', { classId: 'CL000008', classType: 'DATA_CLASS', loadType: 'Incremental' });
    assert.equal(register.status, 403);
    await register.body?.cancel();
    for (const path of ['/v1/loads/purge-all', '/v1/loads/groups', '/api/loads/class']) {
      const response = await post(path, {});
      assert.equal(response.status, 403, path);
      await response.body?.cancel();
    }
  });

  test('8. historical classes are untouched', () => {
    assert.deepEqual(h.standin.snapshot(REF.ASSETS), assetsBefore);
    assert.deepEqual(h.standin.snapshot(REF.SEGMENTS), segmentsBefore);
    assert.equal(assetsBefore.length, 5015);
    for (const { className } of HISTORICAL_CLASSES) {
      assert.deepEqual(h.standin.processes(className), { raw: [], curated: [] }, className);
    }
    const loads = h.standin.requests.filter(r => r.classId);
    assert.ok(loads.length > 0);
    for (const { classId } of loads) {
      if (classId === 'CL000008') continue; // the raw 403 probe in step 9
      assert.match(classId, /^CL0001\d\d$/);
      assert.equal(HISTORICAL_NUMERIC_CLASS_IDS.has(Number(classId.slice(2))), false);
    }
    assert.ok(loads.filter(r => r.classId === 'CL000008').every(r => r.status === 403));
  });
});

describe('Live DataConnect end to end (incrementalMode replace)', () => {
  let h;
  before(async () => { h = await createHarness({ incrementalMode: 'replace' }); });
  after(() => h?.close());

  test('events land and spawn valid workflow records', () => stepEventsLand(h));
  test('re-polling writes nothing', () => stepRepollIsIdempotent(h, 30));
  test('events leaving the feed are cleared', () => stepEventsClear(h, 180));
  test('a returning itemId reactivates the same record', () => stepReactivateAsClosure(h, 200));
  test('re-polling after reactivation writes nothing', () => stepRepollIsIdempotent(h, 210));
});

// ---- CLI smoke: real processes, fixture feed, no FL511 and no real DataConnect ------------------

function run(args, env, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out: ${args.join(' ')}\n${stdout}\n${stderr}`)); }, timeoutMs);
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/**
 * The runner reads .env.local, and a variable already set (even to '') wins over it. Every
 * DataConnect variable is therefore set here, so a developer's real host or token never reaches
 * the child: it can only talk to the in-process test double.
 */
const SEALED = Object.freeze(Object.fromEntries([
  'DC_WRITER_BASE_URL', 'DC_WRITER_LOAD_BASE_URL', 'DC_WRITER_ACCESS_TOKEN', 'DC_WRITER_ACCESS_TOKEN_FILE', 'DC_WRITER_CLIENT_ID', 'DC_WRITER_CLIENT_SECRET',
  'DC_WRITER_TOKEN_URL', 'DC_WRITER_SCOPE', 'DC_WRITER_DATA_MGMT_PREFIX', 'DC_WRITER_ALLOW_REMOTE',
  'DC_WRITER_TIMEOUT_MS', 'DC_WRITER_PROCESS_TIMEOUT_MS', 'DC_WRITER_CURATION_TIMEOUT_MS', 'DC_WRITER_PAGE_SIZE',
  'LIVE_DC_SPAWN_TYPES', 'LIVE_DC_PROFILE', 'LIVE_DC_LINK_MODE', 'LIVE_DC_HEARTBEAT_SECONDS', 'LIVE_DC_ASSET_REFRESH_SECONDS',
  'LIVE_DC_INTERVAL_SECONDS', 'FL511_BASE_URL',
].map(name => [name, ''])));

describe('live-dc-sync CLI smoke', () => {
  let dir;
  let feedFile;
  const baseEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...SEALED, DC_WRITER_POLL_INTERVAL_MS: '50' });
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'live-dc-smoke-'));
    feedFile = join(dir, 'feed.json');
    writeFileSync(feedFile, JSON.stringify({
      incidents: [DAVIE_CRASH, STATEWIDE], closures: [], construction: [CONSTRUCTION], congestion: [], disabledVehicles: [DISABLED], details: DETAILS,
    }));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('--once --feed runs one cycle against DC_WRITER_BASE_URL with a re-read token file', async () => {
    const standin = createDcStandin({ processingDelayMs: 1, curationDelayMs: 1, assetRows: [], logger: silent });
    const server = await standin.listen(0);
    const tokenFile = join(dir, '.dc-access-token');
    writeFileSync(tokenFile, 'smoke-file-token\n');
    try {
      const { code, stdout, stderr } = await run(['tools/live-dc-sync.mjs', '--once', '--feed', feedFile],
        { ...baseEnv(), DC_WRITER_BASE_URL: server.url, DC_WRITER_LOAD_BASE_URL: server.url, DC_WRITER_ACCESS_TOKEN_FILE: tokenFile });
      assert.equal(code, 0, stderr);
      const origin = server.url.replace(/[.]/g, '\\.');
      assert.match(stdout, new RegExp(`live-dc target: ${origin} \\(DataConnect\\) loads: ${origin}`));
      assert.ok(standin.requests.some(r => r.path === '/v1/loads' && r.status === 200), 'writes went through the load service');
      assert.match(stdout, /live-dc cycle .* source=LIVE .*events: seen=3 new=3 .*errors=0/);
      assert.doesNotMatch(stdout + stderr, /smoke-file-token|bearer/i);
      assert.ok(standin.snapshot(LIVE_CLASS.EVENTS).length >= 3);
    } finally { await server.close(); }
  });

  test('without DC_WRITER_LOAD_BASE_URL the runner exits 2 before any request', async () => {
    const { code, stdout, stderr } = await run(['tools/live-dc-sync.mjs', '--once', '--feed', feedFile],
      { ...baseEnv(), DC_WRITER_BASE_URL: 'http://127.0.0.1:9', DC_WRITER_ACCESS_TOKEN: 'unused' });
    assert.equal(code, 2);
    assert.match(stderr, /DC_WRITER_LOAD_BASE_URL/);
    assert.doesNotMatch(stdout, /live-dc target|live-dc cycle/);
  });

  test('without DC_WRITER_BASE_URL the runner exits 2 before any request', async () => {
    const { code, stdout, stderr } = await run(['tools/live-dc-sync.mjs', '--once', '--feed', feedFile],
      { ...baseEnv(), DC_WRITER_ACCESS_TOKEN: 'unused' });
    assert.equal(code, 2);
    assert.match(stderr, /DC_WRITER_BASE_URL/);
    assert.doesNotMatch(stdout, /live-dc target|live-dc cycle/);
  });

  test('the removed --standin flag exits 2 with a pointer to DC_WRITER_BASE_URL', async () => {
    const { code, stderr } = await run(['tools/live-dc-sync.mjs', '--once', '--standin'], baseEnv());
    assert.equal(code, 2);
    assert.match(stderr, /DC_WRITER_BASE_URL/);
  });
});
