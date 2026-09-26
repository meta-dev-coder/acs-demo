import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_CLASS, LIVE_CLASS_NAMES, REF, placeholderObjectId,
} from '../server/liveDc/classes.mjs';
import { mapEventToRecord } from '../server/liveDc/eventSync.mjs';
import { loadWorkflowConfig } from '../server/liveDc/workflow.mjs';
import { createAssetCache, createCycleMemory, mergeReadBack, runLiveDcCycle } from '../server/liveDc/cycle.mjs';
import { createFl511Service } from '../server/fl511Service.mjs';
import {
  UsageError, createFixtureClient, formatCycleSummary, parseSyncArgs, writerSetup,
} from '../tools/live-dc-sync.mjs';

const T0 = Date.parse('2026-09-25T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
const silent = { info() {}, log() {}, warn() {}, error() {} };
const workflowConfig = loadWorkflowConfig();
const { EVENTS, TICKETS, TASKS, WORK_ORDERS, INSPECTIONS, ASSET_STATUS } = LIVE_CLASS;

function fl511Event(itemId, { type = 'INCIDENT', longitude = -80.226583, latitude = 26.093417, title = 'Crash', description } = {}) {
  return {
    id: `FL511-${type}-${itemId}`, source: 'FL511', type, rawSourceId: itemId, latitude, longitude, title,
    description: description ?? `${title} on I-595 West at Davie Rd.`,
    detailsAvailable: true, nearestFacility: 'I595_WB', nearestFacilityLabel: 'I-595 Westbound', distanceToI595NetworkM: 4,
    liveOps: {
      carriageway: 'WB_GENERAL', direction: 'WB', sectionId: 'SECTION_04', sectionLabel: 'WB Section 4',
      segmentId: 'I595-WB-FDOT-006680-007350', laneImpact: { source: 'none' }, laneImpactLabel: 'Not stated',
      spatialMatch: { confidence: 'HIGH' },
    },
  };
}

const livePayload = events => ({
  sourceStatus: 'LIVE', events,
  diagnostics: { feeds: { incidents: { error: null }, closures: { error: null }, disabledVehicles: { error: null } } },
});

function toCurated(record) {
  const attributes = {};
  for (const [k, v] of Object.entries(record)) {
    if (k === 'keyInSource' || k === 'geometry' || v === '' || v === null || v === undefined) continue;
    attributes[k] = v;
  }
  // Real curated-data list items carry no geoDetails.
  return { id: 'x', keyInSource: record.keyInSource, attributes, valid: true };
}

/** Records every call; stores records with merge semantics and serves them back as curated items. */
function createFakeWriter({ assets = [] } = {}) {
  const dtos = new Map(LIVE_CLASS_NAMES.map((name, i) => [name, Object.freeze({
    id: placeholderObjectId(name), classId: 101 + i, className: name, classType: 'DATA_CLASS',
  })]));
  const store = new Map(LIVE_CLASS_NAMES.map(name => [name, new Map()]));
  const behaviour = { throwOn: new Set(), curationNull: new Set(), noopStats: false };
  const hidden = new Set();
  const calls = [];
  const lookups = [];
  return {
    store, hidden, behaviour, calls, lookups,
    submitted: () => calls.filter(c => c.records.length > 0),
    callsFor: name => calls.filter(c => c.className === name),
    async resolveLiveClasses() { return dtos; },
    async findClassByName(name) { lookups.push(name); return { id: 'assets-id', className: name }; },
    async readAll(dto) {
      if (dto.className === REF.ASSETS) return assets;
      return [...store.get(dto.className).values()].filter(r => !hidden.has(r.keyInSource)).map(toCurated);
    },
    async loadRecords(dto, records, { loadType = 'Incremental' } = {}) {
      calls.push({ className: dto.className, loadType, records: structuredClone(records) });
      if (behaviour.throwOn.has(dto.className)) throw new Error(`boom ${dto.className}`);
      if (records.length === 0) {
        return { skipped: true, className: dto.className, loadType, count: 0, process: null, curation: null, stats: null };
      }
      const stats = { new: 0, updated: 0, notChanged: 0 };
      const target = store.get(dto.className);
      for (const record of records) {
        const previous = target.get(record.keyInSource);
        if (previous) stats.updated++; else stats.new++;
        target.set(record.keyInSource, { ...previous, ...structuredClone(record) });
      }
      const finalStats = behaviour.noopStats ? { new: 0, updated: 0, notChanged: records.length } : stats;
      return {
        skipped: false, className: dto.className, loadType, count: records.length, process: { id: `p${calls.length}` },
        curation: behaviour.curationNull.has(dto.className) ? null : { status: 'Finished' }, stats: finalStats,
      };
    },
  };
}

function harness({ assets = [], events = [] } = {}) {
  const writer = createFakeWriter({ assets });
  const service = {
    payload: livePayload(events), refreshes: 0, schedules: 0,
    async refresh() { this.refreshes++; },
    /** The scheduling read: starts the service's own poller. */
    async getI595LiveEvents() { this.schedules++; return this.payload; },
    async snapshot() { return this.payload; },
  };
  const clock = { t: T0 };
  const now = () => clock.t;
  const memory = createCycleMemory();
  const assetCache = createAssetCache({ writer, now });
  const run = (extra = {}) => runLiveDcCycle({
    writer, service, now, workflowConfig, profileName: 'demo', memory, assetCache, logger: silent, ...extra,
  });
  return { writer, service, clock, memory, run };
}

const ATTENUATOR = {
  id: 'a1', keyInSource: 'H1', valid: false,
  attributes: { code: 'H1', name: 'H1', 'asset category': 'Attenuetors', 'system class': 'Roadway', x_coordinates: -80.2262, y_coordinates: 26.0932 },
};

/** A Live Events record for an incident first seen an hour ago and cleared 50 minutes ago. */
function seedClearedIncident(writer, itemId = '1') {
  const record = mapEventToRecord(fl511Event(itemId), { now: T0 - 3600_000 });
  writer.store.get(EVENTS).set(record.keyInSource, { ...record, status: 'cleared', cleared_at: iso(T0 - 3000_000) });
  return record.keyInSource;
}

describe('runLiveDcCycle', () => {
  test('loads classes in dependency order, Incremental only', async () => {
    const h = harness({ assets: [ATTENUATOR], events: [fl511Event('2', { type: 'DISABLED', title: 'Disabled Vehicle' })] });
    seedClearedIncident(h.writer);
    const report = await h.run();
    assert.deepEqual(report.errors, []);
    assert.deepEqual(h.writer.calls.map(c => c.className), LIVE_CLASS_NAMES);
    assert.ok(h.writer.calls.every(c => c.loadType === 'Incremental'));
    assert.ok(h.writer.calls.every(c => c.records.length > 0), 'every class had something to write');
    assert.equal(h.service.refreshes, 1);
    assert.equal(report.sourceStatus, 'LIVE');
    assert.equal(report.workflow.damaged, 1);
    assert.equal(report.loads[ASSET_STATUS].sent, 1);
    assert.equal(h.writer.store.get(ASSET_STATUS).get('AST-H1').status, 'Damaged');
    assert.deepEqual(h.writer.lookups, [REF.ASSETS]);
  });

  test('each cycle polls FL511 exactly once and never starts the service\'s own poller', async () => {
    const h = harness({ events: [fl511Event('1')] });
    await h.run();
    h.clock.t += 60_000;
    await h.run();
    assert.equal(h.service.refreshes, 2);
    assert.equal(h.service.schedules, 0, 'getI595LiveEvents (which schedules) is never called');
  });

  test('the FL511 service snapshot reads the last poll without polling or scheduling', async () => {
    const polls = [];
    const layer = name => async () => { polls.push(name); return []; };
    const client = {
      fetchIncidents: layer('incidents'), fetchClosures: layer('closures'), fetchConstruction: layer('construction'),
      fetchCongestion: layer('congestion'), fetchDisabledVehicles: layer('disabled'), fetchEventDetails: async () => null,
    };
    const service = createFl511Service({ config: { refreshSeconds: 60, staleAfterSeconds: 180, detailTtlSeconds: 60, bufferMeters: 250 },
      network: {}, client, logger: silent, now: () => T0 });
    const realSetInterval = globalThis.setInterval;
    let intervals = 0;
    globalThis.setInterval = (...args) => { intervals++; return realSetInterval(...args); };
    try {
      assert.equal((await service.snapshot()).sourceStatus, 'UNAVAILABLE', 'before any poll');
      assert.equal(polls.length, 0, 'a snapshot never polls');
      await service.refresh();
      assert.equal(polls.length, 5);
      assert.equal((await service.snapshot()).sourceStatus, 'LIVE');
      assert.equal(polls.length, 5);
      assert.equal(intervals, 0, 'no interval was started');
    } finally {
      globalThis.setInterval = realSetInterval;
      service.stop();
    }
  });

  test('a repeated identical poll skips every load', async () => {
    const h = harness({ events: [fl511Event('1')] });
    await h.run();
    const before = h.writer.submitted().length;
    assert.ok(before >= 3);
    h.clock.t += 30_000;
    const report = await h.run();
    assert.equal(h.writer.submitted().length, before);
    for (const name of LIVE_CLASS_NAMES.slice(0, 3)) assert.equal(report.loads[name].skipped, true, name);
    assert.equal(report.sync.stats.unchanged, 1);
  });

  test('a non-LIVE payload loads no events but the workflow still advances existing chains', async () => {
    const h = harness({ events: [fl511Event('1')] });
    await h.run();
    h.service.payload = { ...livePayload([]), sourceStatus: 'STALE' };
    h.clock.t += 150_000;
    const report = await h.run();
    assert.equal(report.sync.skipped, true);
    assert.equal(report.sync.reason, 'source_stale');
    assert.equal(h.writer.callsFor(EVENTS).at(-1).records.length, 0);
    assert.equal(h.writer.store.get(EVENTS).get('FL511-1').status, 'active', 'nothing cleared during an outage');
    assert.equal(h.writer.store.get(WORK_ORDERS).get('WO-FL511-1')['Work Order Status'], 'Open');
  });

  test('an Events load error stops the cycle before any workflow load', async () => {
    const h = harness({ events: [fl511Event('1')] });
    h.writer.behaviour.throwOn.add(EVENTS);
    const report = await h.run();
    assert.equal(report.workflow, null);
    assert.deepEqual(h.writer.calls.map(c => c.className), [EVENTS]);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0], /^SDNA Florida I595 Live Events: boom/);
    assert.equal(h.memory.overlay.get(EVENTS).size, 0, 'a failed load is not remembered as sent');
  });

  test('unconfirmed Events curation limits the workflow to events already curated', async () => {
    const h = harness({ events: [fl511Event('1')] });
    await h.run();
    h.service.payload = livePayload([fl511Event('1'), fl511Event('2')]);
    h.writer.behaviour.curationNull.add(EVENTS);
    h.clock.t += 30_000;
    const report = await h.run();
    assert.ok(report.warnings.some(w => /curation not confirmed for SDNA Florida I595 Live Events/.test(w)));
    assert.equal(h.writer.store.get(TICKETS).has('TIC-FL511-2'), false, 'no ticket for an event DataConnect has not curated');
    assert.equal(h.writer.store.get(TICKETS).has('TIC-FL511-1'), true);

    h.writer.behaviour.curationNull.clear();
    h.clock.t += 30_000;
    await h.run();
    assert.equal(h.writer.store.get(TICKETS).has('TIC-FL511-2'), true, 'the new incident gets its ticket next cycle');
  });

  test('an event whose curation stays unconfirmed gets no workflow records on later cycles either', async () => {
    const h = harness({ events: [fl511Event('9')] });
    h.writer.behaviour.curationNull.add(EVENTS);
    h.writer.hidden.add('FL511-9');
    const sentTickets = () => h.writer.callsFor(TICKETS).flatMap(c => c.records.map(r => r.keyInSource));
    await h.run();
    h.clock.t += 30_000;
    const report = await h.run();
    assert.equal(report.loads[EVENTS].skipped, true, 'the uncurated event is not re-sent');
    assert.deepEqual(sentTickets(), [], 'no ticket references an event DataConnect has not curated');
    assert.equal(h.writer.callsFor(TASKS).flatMap(c => c.records).length, 0);

    h.writer.hidden.delete('FL511-9');
    h.clock.t += 30_000;
    await h.run();
    assert.deepEqual(sentTickets(), ['TIC-FL511-9'], 'once curated, the chain starts');
  });

  test('dependants of an unconfirmed parent stay deferred on later cycles', async () => {
    const h = harness({ assets: [ATTENUATOR] });
    seedClearedIncident(h.writer);
    h.writer.behaviour.curationNull.add(TICKETS);
    h.writer.hidden.add('TIC-FL511-1');
    await h.run();
    h.clock.t += 30_000;
    const report = await h.run();
    assert.equal(report.loads[TICKETS].skipped, true, 'the uncurated ticket is not re-sent');
    for (const name of [TASKS, WORK_ORDERS, INSPECTIONS, ASSET_STATUS]) {
      assert.equal(h.writer.callsFor(name).flatMap(c => c.records).length, 0, `${name} waits for its parent`);
    }
    assert.ok(report.warnings.some(w => /SDNA Florida I595 Live Tasks.*not curated/.test(w)), report.warnings.join('; '));

    h.writer.hidden.delete('TIC-FL511-1');
    h.clock.t += 30_000;
    await h.run();
    assert.equal(h.writer.store.get(TASKS).size, 3, 'the tasks follow once the ticket is curated');
    assert.equal(h.writer.store.get(ASSET_STATUS).get('AST-H1').status, 'Damaged');
  });

  test('a Tasks load error stops Work Orders, Inspections and Asset Status', async () => {
    const h = harness({ assets: [ATTENUATOR] });
    seedClearedIncident(h.writer);
    h.writer.behaviour.throwOn.add(TASKS);
    const report = await h.run();
    assert.deepEqual(h.writer.calls.map(c => c.className), [EVENTS, TICKETS, TASKS]);
    assert.equal(report.errors.length, 1);
    assert.match(report.errors[0], /^SDNA Florida I595 Live Tasks: boom/);
    assert.ok(report.workflow, 'the workflow ran; only its loads stopped');
  });

  test('unconfirmed Tickets curation defers every dependant class', async () => {
    const h = harness({ assets: [ATTENUATOR] });
    seedClearedIncident(h.writer);
    h.writer.behaviour.curationNull.add(TICKETS);
    const report = await h.run();
    assert.deepEqual(h.writer.calls.map(c => c.className), [EVENTS, TICKETS]);
    assert.deepEqual(report.errors, []);
    assert.ok(report.warnings.includes('curation not confirmed for SDNA Florida I595 Live Tickets; deferring dependants'));
  });

  test('an event missing from the read-back keeps its ticket unchanged (firstSeenHints)', async () => {
    const h = harness({ events: [fl511Event('1')] });
    await h.run();
    const ticket = structuredClone(h.writer.store.get(TICKETS).get('TIC-FL511-1'));
    h.writer.hidden.add('FL511-1');
    h.clock.t += 30_000;
    const report = await runLiveDcCycle({
      writer: h.writer, service: h.service, now: () => h.clock.t, workflowConfig, profileName: 'demo',
      memory: createCycleMemory(), assetCache: createAssetCache({ writer: h.writer }), logger: silent,
    });
    assert.equal(report.sync.stats.new, 1, 'without memory the event looks new');
    const sentEvent = h.writer.callsFor(EVENTS).at(-1).records[0];
    assert.equal(sentEvent.first_seen_at, iso(T0), 'first_seen_at comes from the ticket, not from now');
    assert.equal(h.writer.callsFor(TICKETS).at(-1).records.length, 0, 'the ticket is not re-sent');
    const after = h.writer.store.get(TICKETS).get('TIC-FL511-1');
    assert.equal(after['Ticket Opened Time'], ticket['Ticket Opened Time']);
    assert.equal(after['Ticket Opened Date'], ticket['Ticket Opened Date']);
    assert.equal(after.created_at, ticket.created_at);
  });

  test('the overlay stops a record sent last cycle from looking new while the read-back lags', async () => {
    const h = harness({ events: [fl511Event('1')] });
    await h.run();
    for (const name of LIVE_CLASS_NAMES) for (const key of h.writer.store.get(name).keys()) h.writer.hidden.add(key);
    h.clock.t += 30_000;
    const submitted = h.writer.submitted().length;
    const report = await h.run();
    assert.equal(report.sync.stats.new, 0);
    assert.equal(report.sync.stats.unchanged, 1);
    assert.equal(h.writer.submitted().length, submitted, 'nothing is re-sent');
  });

  test('the loop detector warns when a load changed nothing', async () => {
    const h = harness({ events: [fl511Event('1')] });
    h.writer.behaviour.noopStats = true;
    const report = await h.run();
    assert.ok(report.warnings.includes('no-op load for SDNA Florida I595 Live Events (n=1): check Incremental merge semantics'));
  });

  test('the workflow receives assets from the cache, which reads Assets once per refresh window', async () => {
    const h = harness({ assets: [ATTENUATOR] });
    seedClearedIncident(h.writer);
    await h.run();
    h.clock.t += 60_000;
    await h.run();
    assert.deepEqual(h.writer.lookups, [REF.ASSETS]);
  });
});

describe('mergeReadBack', () => {
  const rec = (key, extra = {}) => ({ keyInSource: key, code: key, name: 'n', status: 'active', ...extra });

  test('an overlay entry replaces a lagging read-back and adds a missing one', () => {
    const overlay = new Map([
      ['A', { record: rec('A', { status: 'cleared' }), sentAt: T0 }],
      ['C', { record: rec('C'), sentAt: T0 }],
    ]);
    const merged = mergeReadBack([rec('A'), rec('B')], overlay, { now: T0 + 1000 });
    assert.deepEqual(merged.map(r => [r.keyInSource, r.status]), [['A', 'cleared'], ['B', 'active'], ['C', 'active']]);
    assert.equal(overlay.size, 2);
  });

  test('an entry the read-back has caught up with is evicted', () => {
    const overlay = new Map([['A', { record: rec('A', { comment: '' }), sentAt: T0 }]]);
    const readBack = [rec('A')];
    const merged = mergeReadBack(readBack, overlay, { now: T0 + 1000 });
    assert.equal(overlay.size, 0, "'' and absent compare equal, so the read-back has caught up");
    assert.equal(merged[0], readBack[0]);
  });

  test('an entry older than the ttl is evicted and ignored', () => {
    const overlay = new Map([['A', { record: rec('A', { status: 'cleared' }), sentAt: T0 }]]);
    const merged = mergeReadBack([rec('A')], overlay, { now: T0 + 11_000, ttlSeconds: 10 });
    assert.equal(merged[0].status, 'active');
    assert.equal(overlay.size, 0);
  });

  test('works without an overlay and never mutates the read-back', () => {
    const readBack = [rec('B'), rec('A')];
    const frozen = structuredClone(readBack);
    assert.deepEqual(mergeReadBack(readBack, undefined, { now: T0 }).map(r => r.keyInSource), ['A', 'B']);
    assert.deepEqual(readBack, frozen);
  });

  test('createCycleMemory has one overlay per Live class', () => {
    const memory = createCycleMemory({ ttlSeconds: 5 });
    assert.deepEqual([...memory.overlay.keys()], LIVE_CLASS_NAMES);
    assert.equal(memory.ttlSeconds, 5);
  });
});

describe('createAssetCache', () => {
  test('reads Assets by name, keeps valid=false items, and refreshes after the window', async () => {
    let t = T0;
    const writer = createFakeWriter({ assets: [ATTENUATOR] });
    const cache = createAssetCache({ writer, refreshSeconds: 60, now: () => t });
    const [first] = await Promise.all([cache.get(), cache.get()]);
    assert.equal(first.length, 1);
    assert.equal(first[0].code, 'H1');
    assert.equal(writer.lookups.length, 1, 'concurrent callers share one read');
    t += 59_000;
    await cache.get();
    assert.equal(writer.lookups.length, 1);
    t += 2000;
    await cache.get();
    assert.equal(writer.lookups.length, 2);
  });
});

describe('live-dc-sync runner helpers', () => {
  test('parseSyncArgs reads every flag and rejects unknown ones, including the removed --standin/--remote', () => {
    assert.deepEqual(parseSyncArgs(['--once', '--interval', '30', '--profile', 'realistic', '--feed', 'f.json']), {
      once: true, interval: 30, profile: 'realistic', feed: 'f.json',
    });
    assert.deepEqual(parseSyncArgs([]), { once: false, interval: null, profile: null, feed: null });
    assert.throws(() => parseSyncArgs(['--bogus']), UsageError);
    assert.throws(() => parseSyncArgs(['--interval', '0']), UsageError);
    assert.throws(() => parseSyncArgs(['--feed']), UsageError);
    for (const removed of ['--standin', '--remote']) {
      assert.throws(() => parseSyncArgs([removed]), error => error instanceof UsageError && /DC_WRITER_BASE_URL/.test(error.message));
    }
  });

  const refused = (env, pattern) => assert.throws(() => writerSetup({ env }), error => {
    assert.ok(error instanceof UsageError, String(error));
    assert.equal(error.exitCode, 2);
    assert.match(error.message, pattern);
    return true;
  });

  test('the runner refuses to start without DC_WRITER_BASE_URL: there is no default or local target', () => {
    refused({}, /DC_WRITER_BASE_URL/);
    refused({ DC_WRITER_ACCESS_TOKEN: 't' }, /DC_WRITER_BASE_URL/);
    refused({ DC_WRITER_BASE_URL: '', DC_WRITER_ACCESS_TOKEN_FILE: '/x' }, /DC_WRITER_BASE_URL/);
  });

  test('the runner also needs DC_WRITER_LOAD_BASE_URL: writes go through the load service', () => {
    refused({ DC_WRITER_BASE_URL: 'https://dataconnect.example.com', DC_WRITER_ACCESS_TOKEN: 't' }, /DC_WRITER_LOAD_BASE_URL/);
  });

  test('DataConnect needs a token, a token file or a client, and no DC_WRITER_ALLOW_REMOTE opt-in', () => {
    const target = { DC_WRITER_BASE_URL: 'https://dataconnect.example.com', DC_WRITER_LOAD_BASE_URL: 'https://dc-load.example.com' };
    refused(target, /DC_WRITER_ACCESS_TOKEN, DC_WRITER_ACCESS_TOKEN_FILE or DC_WRITER_CLIENT_ID\+DC_WRITER_CLIENT_SECRET/);
    refused({ ...target, DC_WRITER_ALLOW_REMOTE: 'true' }, /DC_WRITER_ACCESS_TOKEN_FILE/);
    for (const credentials of [
      { DC_WRITER_ACCESS_TOKEN_FILE: '/tmp/.dc-access-token' }, { DC_WRITER_ACCESS_TOKEN: 't' },
      { DC_WRITER_CLIENT_ID: 'id', DC_WRITER_CLIENT_SECRET: 's' },
    ]) {
      const setup = writerSetup({ env: { ...target, ...credentials } });
      assert.equal(setup.mode, 'DataConnect');
      assert.equal(setup.config.baseUrl, 'https://dataconnect.example.com');
      assert.equal(setup.config.loadBaseUrl, 'https://dc-load.example.com');
      assert.equal(setup.tokenProvider, undefined, 'the writer picks the credential itself');
    }
  });

  test('the fixture client serves feeds and per-item details', async () => {
    const client = createFixtureClient(() => ({
      incidents: [{ itemId: '1', latitude: 26.09, longitude: -80.22 }], disabledVehicles: [{ itemId: '2', latitude: 26.1, longitude: -80.3 }],
      details: { 1: { title: 'Crash', description: 'Crash', fields: [] } },
    }));
    assert.equal((await client.fetchIncidents()).length, 1);
    assert.deepEqual(await client.fetchClosures(), []);
    assert.equal((await client.fetchDisabledVehicles())[0].itemId, '2');
    assert.equal((await client.fetchEventDetails('Incidents', '1')).title, 'Crash');
    assert.equal(await client.fetchEventDetails('Incidents', '9'), null);
  });

  test('formatCycleSummary is one line of counts', () => {
    const line = formatCycleSummary({
      at: iso(T0), sourceStatus: 'LIVE',
      sync: { skipped: false, reason: null, stats: { seen: 2, new: 1, updated: 0, heartbeat: 0, reactivated: 0, cleared: 1, unchanged: 1 } },
      workflow: { chains: 1, tickets: 1, tasks: 3, workOrders: 1, inspections: 0, damaged: 0, passed: 0 },
      loads: { [EVENTS]: { sent: 2, skipped: false }, [TICKETS]: { sent: 0, skipped: true } },
      errors: [], warnings: ['w'],
    });
    assert.equal(line.includes('\n'), false);
    assert.match(line, /source=LIVE/);
    assert.match(line, /Events=2/);
    assert.match(line, /warnings=1/);
  });
});
