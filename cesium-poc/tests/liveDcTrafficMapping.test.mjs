/**
 * "SDNA Florida I595 Live Events" rows -> the exact event objects /api/i595/live-events serves, so the
 * Traffic, Safety and Live Ops workspaces read DataConnect without changing shape. Parity is proven
 * by running the real direct feed through the real sync mapping and back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadI595Network } from '../server/i595Network.mjs';
import { createFl511Service } from '../server/fl511Service.mjs';
import { loadConfig } from '../server/config.mjs';
import { LIVE_CLASS } from '../server/liveDc/classes.mjs';
import { syncLiveEvents } from '../server/liveDc/eventSync.mjs';
import { ENRICHMENT_FIELDS } from '../server/liveDc/eventEnrichment.mjs';
import {
  DC_LIVE_EVENTS_LABEL, DC_STALE_MARGIN_SECONDS, liveDcEventsPayload, liveDcRowToEvent, liveDcStaleAfterSeconds, readLiveDcEvents,
} from '../server/liveDc/liveEventsFromDc.mjs';
import { loadLiveDcReadConfig } from '../server/liveDc/liveReadApi.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const network = await loadI595Network(join(ROOT, 'public', 'data'));
const config = loadConfig({});
const silent = { info() {}, log() {}, warn() {}, error() {} };
const T0 = Date.parse('2026-09-25T12:00:00Z');
const EB = network.lines.find(line => line.facility === 'I595_EB').coordinates;

const FEED = {
  incidents: [{ itemId: '868702', latitude: 26.093417, longitude: -80.226583 }],
  closures: [{ itemId: '900010', latitude: EB[40][1], longitude: EB[40][0], secondaryLatitude: EB[44][1], secondaryLongitude: EB[44][0] }],
  construction: [{ itemId: '900002', latitude: EB[120][1], longitude: EB[120][0] }],
  disabledVehicles: [{ itemId: '900001', latitude: EB[60][1], longitude: EB[60][0] }],
};
const DETAILS = {
  868702: { title: 'Crash', description: 'Crash on I-595 West at Davie Rd. 2 right lanes blocked.', fields: [{ label: 'Severity', value: 'Major' }, { label: 'Start Time', value: '9/25/26, 7:55 AM' }] },
  900010: { title: 'Closure', description: 'Lane closure on I-595 East. Left lane closed.', fields: [] },
  900001: { title: 'Disabled Vehicle', description: 'Disabled vehicle on I-595 East. Right shoulder blocked.', fields: [] },
};

async function directPayload() {
  const layer = key => async () => FEED[key] ?? [];
  const client = {
    fetchIncidents: layer('incidents'), fetchClosures: layer('closures'), fetchConstruction: layer('construction'),
    fetchCongestion: async () => [], fetchDisabledVehicles: layer('disabledVehicles'),
    fetchEventDetails: async (_layer, itemId) => DETAILS[itemId] ?? null,
  };
  const service = createFl511Service({ config, network, client, logger: silent, now: () => T0 });
  try { return await service.getI595LiveEvents(); } finally { service.stop(); }
}

/** What a curated-data list read returns: attributes only, empty values and geometry dropped. */
const asCuratedRow = record => ({
  id: `obj-${record.keyInSource}`, className: LIVE_CLASS.EVENTS, keyInSource: record.keyInSource, valid: true,
  attributes: Object.fromEntries(Object.entries(record)
    .filter(([name, value]) => name !== 'keyInSource' && name !== 'geometry' && value !== '' && value != null)),
});

async function dcRows() {
  const direct = await directPayload();
  const { upserts } = syncLiveEvents({ payload: direct, existing: [], now: T0 });
  return { direct, rows: upserts.map(asCuratedRow) };
}

const options = { now: T0 + 30_000, bufferMeters: config.bufferMeters, segmentToleranceMeters: config.segmentToleranceMeters, refreshSeconds: config.refreshSeconds };

test('active Live Events rows come back as the same event objects the direct feed serves', async () => {
  const { direct, rows } = await dcRows();
  assert.equal(direct.events.length, 4);
  const payload = liveDcEventsPayload(rows, network, options);
  assert.deepEqual(payload.events.map(event => event.id), direct.events.map(event => event.id));
  const same = ['id', 'type', 'latitude', 'longitude', 'secondaryLatitude', 'secondaryLongitude', 'title', 'description',
    'severity', 'startTime', 'distanceToI595NetworkM', 'secondaryDistanceToI595NetworkM', 'nearestFacility',
    'nearestFacilityLabel', 'distanceToNearestFacilityM', 'nearestSegmentId', 'nearestSegmentLabel', 'distanceToSegmentM',
    'rawSourceId', 'detailsAvailable', 'liveOps'];
  for (const expected of direct.events) {
    const actual = payload.events.find(event => event.id === expected.id);
    for (const key of same) assert.deepEqual(actual[key], expected[key], `${expected.id}.${key}`);
    assert.ok(Array.isArray(actual.detailFields));
    assert.equal(actual.source, DC_LIVE_EVENTS_LABEL);
    assert.equal(actual.dataConnect.keyInSource, `FL511-${expected.rawSourceId}`);
    assert.equal(actual.dataConnect.status, 'active');
  }
  assert.deepEqual(payload.counts, direct.counts);
});

test('the payload says it came from DataConnect and is live while the sync heartbeat is fresh', async () => {
  const { rows } = await dcRows();
  const payload = liveDcEventsPayload(rows, network, options);
  assert.equal(payload.source, 'DataConnect');
  assert.equal(payload.sourceLabel, DC_LIVE_EVENTS_LABEL);
  assert.equal(payload.sourceStatus, 'LIVE');
  assert.equal(payload.lastUpdated, new Date(T0).toISOString());
  assert.equal(payload.dataFreshness.ageSeconds, 30);
  assert.equal(payload.bufferMeters, config.bufferMeters);
  assert.equal(payload.diagnostics.lastError, null);
  assert.equal(payload.diagnostics.dataConnect.className, LIVE_CLASS.EVENTS);
});

test('cleared events are excluded from events and every count', async () => {
  const { rows } = await dcRows();
  const cleared = rows.map(row => (row.keyInSource === 'FL511-868702' || row.keyInSource === 'FL511-900010'
    ? { ...row, attributes: { ...row.attributes, status: 'cleared', cleared_at: new Date(T0).toISOString() } } : row));
  const payload = liveDcEventsPayload(cleared, network, options);
  assert.deepEqual(payload.events.map(event => event.type).sort(), ['CONSTRUCTION', 'DISABLED']);
  assert.equal(payload.counts.total, 2);
  assert.equal(payload.counts.incidents, 0);
  assert.equal(payload.counts.closures, 0);
  assert.equal(payload.diagnostics.dataConnect.cleared, 2);
  assert.equal(liveDcRowToEvent(cleared.find(row => row.keyInSource === 'FL511-868702'), network, options), null);
});

test('active records the sync has not refreshed within the heartbeat window are served STALE', async () => {
  const { rows } = await dcRows();
  const payload = liveDcEventsPayload(rows, network, { ...options, now: T0 + 3 * 3600_000 });
  assert.equal(payload.sourceStatus, 'STALE');
  assert.equal(payload.events.length, 4, 'stale records are still shown, labelled');
});

test('a quiet corridor (only cleared records) is a live zero, not stale', async () => {
  const { rows } = await dcRows();
  const allCleared = rows.map(row => ({ ...row, attributes: { ...row.attributes, status: 'cleared', cleared_at: new Date(T0).toISOString() } }));
  const payload = liveDcEventsPayload(allCleared, network, { ...options, now: T0 + 3 * 3600_000 });
  assert.equal(payload.sourceStatus, 'LIVE');
  assert.equal(payload.counts.total, 0);
  assert.deepEqual(payload.events, []);
});

test('rows that cannot be placed or typed are skipped rather than invented', () => {
  const base = { keyInSource: 'FL511-1', attributes: { status: 'active', event_type: 'INCIDENT', fl511_item_id: '1', latitude: 26.09, longitude: -80.22 } };
  assert.ok(liveDcRowToEvent(base, network, options));
  assert.equal(liveDcRowToEvent({ ...base, attributes: { ...base.attributes, latitude: '' } }, network, options), null);
  assert.equal(liveDcRowToEvent({ ...base, attributes: { ...base.attributes, event_type: 'WEATHER' } }, network, options), null);
  // String numbers, as some DataConnect reads return them, are still placed.
  const stringy = liveDcRowToEvent({ ...base, attributes: { ...base.attributes, latitude: '26.09', longitude: '-80.22' } }, network, options);
  assert.equal(stringy.latitude, 26.09);
  assert.equal(stringy.id, 'FL511-INCIDENT-1', 'event_id missing -> the direct feed id format');
});

test('a description the sync filled from the name is not shown as FL511 prose', () => {
  const row = { keyInSource: 'FL511-2', attributes: {
    status: 'active', event_type: 'CONGESTION', fl511_item_id: '2', event_id: 'FL511-CONGESTION-2',
    name: 'Congestion on I-595', description: 'Congestion on I-595', latitude: EB[80][1], longitude: EB[80][0],
  } };
  const event = liveDcRowToEvent(row, network, options);
  assert.equal(event.description, undefined);
  assert.equal(event.title, undefined);
  assert.equal(event.detailsAvailable, false);
});

// ---- readLiveDcEvents: paging, status filter, cache -------------------------------------------

/** A read proxy over `rows` that applies `equals` filters and caps the page size like a real server may. */
function fakeReadApi(rows, { cap = 500 } = {}) {
  const api = {
    calls: [],
    liveClasses: async () => [{ id: 'events-id', className: LIVE_CLASS.EVENTS }],
    curatedData: async (id, body) => {
      api.calls.push(body);
      await new Promise(done => setImmediate(done));
      const matching = rows.filter(row => (body.filters ?? []).every(f => f.operator === 'equals'
        && String(f.field.startsWith('attributes.') ? row.attributes[f.field.slice(11)] : row[f.field]) === String(f.value)));
      const size = Math.min(cap, body.pageSize);
      return { data: matching.slice(body.page * size, (body.page + 1) * size), totalCount: matching.length };
    },
  };
  return api;
}
const clearedCopy = (row, n) => ({ ...row, keyInSource: `${row.keyInSource}-old${n}`,
  attributes: { ...row.attributes, status: 'cleared', fl511_item_id: `${row.attributes.fl511_item_id}${n}` } });
const readOptions = { network, config, now: T0 + 30_000, logger: silent };

test('paging follows totalCount when the server caps the page below the requested size', async () => {
  const { direct, rows } = await dcRows();
  const readApi = fakeReadApi(rows, { cap: 2 });
  const payload = await readLiveDcEvents({ ...readOptions, readApi, pageSize: 500 });
  assert.equal(payload.events.length, direct.events.length);
});

test('only status=active records are requested from DataConnect; cleared history is not read', async () => {
  const { direct, rows } = await dcRows();
  const history = Array.from({ length: 30 }, (_, n) => clearedCopy(rows[0], n));
  const readApi = fakeReadApi([...rows, ...history], { cap: 5 });
  const payload = await readLiveDcEvents({ ...readOptions, readApi });
  assert.equal(payload.events.length, direct.events.length);
  const paged = readApi.calls.filter(body => body.pageSize > 1);
  assert.ok(paged.length > 0);
  for (const body of paged) {
    assert.deepEqual(body.filters, [{ field: 'attributes.status', operator: 'equals', value: 'active' }]);
  }
  assert.equal(paged.length, 1, 'four active records fit one capped page');
  assert.equal(payload.diagnostics.dataConnect.records, rows.length + history.length);
  assert.equal(payload.diagnostics.dataConnect.cleared, history.length);
});

test('a class holding only cleared records is a live zero', async () => {
  const { rows } = await dcRows();
  const readApi = fakeReadApi(rows.map((row, n) => clearedCopy(row, n)));
  const payload = await readLiveDcEvents({ ...readOptions, readApi });
  assert.equal(payload.sourceStatus, 'LIVE');
  assert.deepEqual(payload.events, []);
});

test('an empty Live Events class is a valid live zero too, not an error', async () => {
  const payload = await readLiveDcEvents({ ...readOptions, readApi: fakeReadApi([]) });
  assert.equal(payload.source, 'DataConnect');
  assert.equal(payload.sourceStatus, 'LIVE');
  assert.deepEqual(payload.events, []);
  assert.equal(payload.counts.total, 0);
  assert.equal(payload.diagnostics.dataConnect.records, 0);
});

test('a missing Live Events class is still an error', async () => {
  const readApi = { liveClasses: async () => [], curatedData: async () => { throw new Error('unexpected'); } };
  await assert.rejects(readLiveDcEvents({ ...readOptions, readApi }), /not found/);
});

test('concurrent and repeated reads within the cache window share one upstream read', async () => {
  const { direct, rows } = await dcRows();
  const readApi = fakeReadApi(rows);
  let clock = 1_000_000;
  const read = () => readLiveDcEvents({ ...readOptions, readApi, clock: () => clock, cacheMs: 20_000 });
  const results = await Promise.all([read(), read(), read()]);
  for (const payload of results) assert.equal(payload.events.length, direct.events.length);
  const first = readApi.calls.length;
  clock += 10_000;
  await read();
  assert.equal(readApi.calls.length, first, 'served from cache');
  clock += 15_000;
  await read();
  assert.ok(readApi.calls.length > first, 'refreshed after the cache window');
});

test('hitting maxPages is surfaced as truncated, not silently dropped', async () => {
  const { rows } = await dcRows();
  const warnings = [];
  const readApi = fakeReadApi(rows, { cap: 1 });
  const payload = await readLiveDcEvents({ ...readOptions, readApi, maxPages: 2, logger: { ...silent, warn: (...a) => warnings.push(a.join(' ')) } });
  assert.equal(payload.events.length, 2);
  assert.equal(payload.diagnostics.dataConnect.truncated, true);
  assert.match(payload.diagnostics.lastError, /truncated/i);
  assert.equal(warnings.length, 1);
});

test('each event carries the SDNA enrichment fields under event.sdna, "NA" where unavailable', async () => {
  const { direct, rows } = await dcRows();
  const payload = liveDcEventsPayload(rows, network, options);
  for (const event of payload.events) {
    assert.deepEqual(Object.keys(event.sdna), [...ENRICHMENT_FIELDS, 'fieldSources']);
    for (const name of ENRICHMENT_FIELDS) assert.equal(typeof event.sdna[name], 'string', `${event.id}.${name}`);
    assert.deepEqual(Object.keys(event.sdna.fieldSources), ENRICHMENT_FIELDS);
    assert.equal(event.sdna.injuries, 'NA');
    assert.equal(direct.events.find(e => e.id === event.id).sdna, undefined, 'the direct feed shape is unchanged');
  }
  const davie = payload.events.find(event => event.rawSourceId === '868702');
  assert.equal(davie.sdna.cross_street, 'Davie Rd');
  assert.equal(davie.sdna.incident_subtype, 'Crash');
  assert.equal(davie.sdna.fieldSources.cross_street, 'derived');
});

test('a legacy row without the enrichment fields still gets a complete sdna block of "NA"', async () => {
  const { rows } = await dcRows();
  const legacy = { ...rows[0], attributes: Object.fromEntries(Object.entries(rows[0].attributes)
    .filter(([name]) => !ENRICHMENT_FIELDS.includes(name) && name !== 'field_sources')) };
  const event = liveDcRowToEvent(legacy, network, { segmentToleranceMeters: config.segmentToleranceMeters });
  for (const name of ENRICHMENT_FIELDS) assert.equal(event.sdna[name], 'NA', name);
  assert.deepEqual(event.sdna.fieldSources, {});
});

// ---- corridor buffer and staleness ------------------------------------------------------------

/** An active record placed ~10 km south of the corridor: the direct feed would never serve it. */
const farRow = rows => ({ ...rows[0], keyInSource: 'FL511-777', attributes: {
  ...rows[0].attributes, code: 'FL511-777', fl511_item_id: '777', event_id: 'FL511-INCIDENT-777',
  latitude: 26.0, longitude: -80.226583, x_coordinates: -80.226583, y_coordinates: 26.0,
} });

test('rows outside the configured corridor buffer are clipped like the direct feed, and counted', async () => {
  const { direct, rows } = await dcRows();
  const payload = liveDcEventsPayload([...rows, farRow(rows)], network, options);
  assert.deepEqual(payload.events.map(event => event.id), direct.events.map(event => event.id));
  assert.equal(payload.counts.total, direct.events.length);
  assert.equal(payload.bufferMeters, config.bufferMeters);
  assert.equal(payload.diagnostics.dataConnect.outsideBuffer, 1);
  assert.equal(payload.diagnostics.dataConnect.skipped, 0, 'clipped rows are not "unplaceable"');
  for (const event of payload.events) {
    assert.ok(Math.min(event.distanceToI595NetworkM, event.secondaryDistanceToI595NetworkM ?? Infinity) <= config.bufferMeters, event.id);
  }
  assert.equal(liveDcRowToEvent(farRow(rows), network, { bufferMeters: config.bufferMeters }), null);
  assert.ok(liveDcRowToEvent(farRow(rows), network, {}), 'no buffer given -> not clipped');
});

test('the STALE threshold follows the sync heartbeat; heartbeat 0 never marks an unchanged record STALE', async () => {
  assert.equal(liveDcStaleAfterSeconds(900), 900 + DC_STALE_MARGIN_SECONDS);
  assert.equal(liveDcStaleAfterSeconds(3600), 3600 + DC_STALE_MARGIN_SECONDS);
  assert.equal(liveDcStaleAfterSeconds(0), null);
  const { rows } = await dcRows();
  const quiet = liveDcEventsPayload(rows, network, { ...options, now: T0 + 3 * 3600_000, staleAfterSeconds: null });
  assert.equal(quiet.sourceStatus, 'LIVE');
  assert.equal(quiet.dataFreshness.staleAfterSeconds, null);
  assert.equal(quiet.dataFreshness.ageSeconds, 3 * 3600);
});

test('readLiveDcEvents takes the heartbeat from the read proxy config (LIVE_DC_HEARTBEAT_SECONDS)', async () => {
  assert.equal(loadLiveDcReadConfig({}).heartbeatSeconds, 900);
  assert.equal(loadLiveDcReadConfig({ LIVE_DC_HEARTBEAT_SECONDS: '0' }).heartbeatSeconds, 0);
  assert.equal(loadLiveDcReadConfig({ LIVE_DC_HEARTBEAT_SECONDS: '7200' }).heartbeatSeconds, 7200);
  assert.equal(loadLiveDcReadConfig({ LIVE_DC_HEARTBEAT_SECONDS: '-5' }).heartbeatSeconds, 900);
  const { rows } = await dcRows();
  const at = T0 + 2 * 3600_000;
  const withHeartbeat = heartbeatSeconds => Object.assign(fakeReadApi(rows), { config: { heartbeatSeconds } });
  assert.equal((await readLiveDcEvents({ ...readOptions, now: at, readApi: fakeReadApi(rows) })).sourceStatus, 'STALE', 'default 900 s');
  const slow = await readLiveDcEvents({ ...readOptions, now: at, readApi: withHeartbeat(7200) });
  assert.equal(slow.sourceStatus, 'LIVE');
  assert.equal(slow.dataFreshness.staleAfterSeconds, 7200 + DC_STALE_MARGIN_SECONDS);
  assert.equal((await readLiveDcEvents({ ...readOptions, now: at + 86400_000, readApi: withHeartbeat(0) })).sourceStatus, 'LIVE');
});
