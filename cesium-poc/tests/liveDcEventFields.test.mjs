/**
 * The enrichment fields as part of "SDNA Florida I595 Live Events": declared on the class with the
 * right types, filled by the sync (never '' — "NA" instead), and stable across cycles.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadI595Network } from '../server/i595Network.mjs';
import { attachDetails, enrichForLiveOps, normalizeEvent } from '../server/liveEvents.mjs';
import {
  LIVE_CLASS, LIVE_CLASS_NAMES, diffRecords, liveClassDefinition, toDcDateTime, unknownAttributes, validateRecord,
} from '../server/liveDc/classes.mjs';
import { mapEventToRecord, syncLiveEvents } from '../server/liveDc/eventSync.mjs';
import { ENRICHMENT_FIELDS, NA, PENDING_FIELDS } from '../server/liveDc/eventEnrichment.mjs';

const network = await loadI595Network(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data'));
const EVENTS_DEF = liveClassDefinition(LIVE_CLASS.EVENTS);
const T0 = Date.parse('2026-09-26T05:00:00Z');
const DAVIE = { itemId: '868702', latitude: 26.093417, longitude: -80.226583 };
const DETAIL = {
  title: 'Incident',
  description: 'Crash on I-595 West at Davie Rd. 2 right lanes blocked.',
  fields: [{ label: 'Severity', value: 'Major' }, { label: 'Start Time', value: 'Sep 26 2026, 12:26 AM' },
    { label: 'Last Updated', value: 'Sep 26 2026, 12:30 AM' }],
};
const build = (detail = DETAIL, item = DAVIE) => enrichForLiveOps(
  attachDetails(normalizeEvent(item, 'INCIDENT', network, { bufferMeters: 250, segmentToleranceMeters: 120 }), detail),
  network, { sectionToleranceMeters: 120 });
const livePayload = events => ({
  sourceStatus: 'LIVE', events,
  diagnostics: { feeds: { incidents: { error: null } } },
});

test('the class declares the new attributes; times are DateTime, the rest String', () => {
  const byName = new Map(EVENTS_DEF.attributes.map(a => [a.name, a]));
  for (const name of [...ENRICHMENT_FIELDS, 'field_sources']) assert.ok(byName.has(name), name);
  assert.equal(byName.get('reported_at').type, 'DateTime');
  assert.equal(byName.get('updated_at').type, 'DateTime');
  for (const name of ENRICHMENT_FIELDS.filter(n => !['reported_at', 'updated_at'].includes(n))) assert.equal(byName.get(name).type, 'String', name);
  assert.equal(byName.get('field_sources').type, 'String');
  for (const name of ['event_id', 'start_time', 'blocked_lanes', 'spatial_confidence']) assert.ok(byName.has(name), `${name} kept`);
});

test('a real incident is enriched from FL511 and local corridor data', () => {
  const rec = mapEventToRecord(build(), { now: T0 });
  assert.equal(rec.reported_at, '2026-09-26T04:26:00Z');
  assert.equal(rec.updated_at, '2026-09-26T04:30:00Z');
  assert.equal(rec.cross_street, 'Davie Rd');
  assert.equal(rec.incident_subtype, 'Crash');
  assert.equal(rec.vehicles_involved, NA);
  assert.equal(rec.impact_level, 'High');
  assert.equal(rec.est_clearance_at, NA);
  assert.equal(rec.fdot_segment_id, 'I595-WB-FDOT-006680-007350');
  assert.match(rec.milepost, /^(6\.[7-9]|7\.[0-4])$/);
  assert.match(rec.primary_camera_id, /^\d+$/);
  assert.match(rec.nearby_camera_ids, /^\d+@\d+m(,\d+@\d+m){0,2}$/);
  assert.ok(rec.camera_snapshot_url === NA || /^\/api\/i595\/camera\/\d+\/snapshot$/.test(rec.camera_snapshot_url));
  for (const name of PENDING_FIELDS) assert.equal(rec[name], NA);
  assert.deepEqual(Object.keys(JSON.parse(rec.field_sources)), ENRICHMENT_FIELDS);
  assert.deepEqual(validateRecord(EVENTS_DEF, rec), { valid: true, failures: [] });
  assert.deepEqual(unknownAttributes(EVENTS_DEF, rec), []);
  for (const name of ENRICHMENT_FIELDS) assert.notEqual(rec[name], '', name);
});

test('without FL511 times the fallbacks are first/last seen', () => {
  const rec = mapEventToRecord(build({ ...DETAIL, fields: [] }), { now: T0, firstSeenAt: '2026-09-26T04:00:00.000Z' });
  assert.equal(rec.reported_at, '2026-09-26T04:00:00Z');
  assert.equal(rec.updated_at, '2026-09-26T05:00:00Z');
  assert.equal(JSON.parse(rec.field_sources).reported_at, 'derived');
});

test('re-running the same events writes nothing, even when updated_at falls back to last_seen_at', () => {
  for (const detail of [DETAIL, { ...DETAIL, fields: [] }]) {
    const first = syncLiveEvents({ payload: livePayload([build(detail)]), existing: [], now: T0 });
    assert.equal(first.upserts.length, 1);
    const again = syncLiveEvents({ payload: livePayload([build(detail)]), existing: first.upserts, now: T0 + 60_000 });
    assert.equal(again.upserts.length, 0);
    assert.equal(again.stats.unchanged, 1);
  }
});

test('a failed tooltip fetch keeps the derived fields stable', () => {
  const first = syncLiveEvents({ payload: livePayload([build()]), existing: [], now: T0 });
  const bare = syncLiveEvents({ payload: livePayload([build(null)]), existing: first.upserts, now: T0 + 60_000 });
  assert.equal(bare.upserts.length, 0);
});

test('legacy records without the new fields are upgraded once, then stable', () => {
  const legacy = Object.fromEntries(Object.entries(mapEventToRecord(build(), { now: T0 }))
    .filter(([name]) => !ENRICHMENT_FIELDS.includes(name) && name !== 'field_sources'));
  const upgrade = syncLiveEvents({ payload: livePayload([build()]), existing: [legacy], now: T0 + 60_000 });
  assert.equal(upgrade.stats.updated, 1);
  const after = syncLiveEvents({ payload: livePayload([build()]), existing: upgrade.upserts, now: T0 + 120_000 });
  assert.equal(after.upserts.length, 0);
});

test('a cleared legacy record is filled with NA rather than empty strings', () => {
  const legacy = Object.fromEntries(Object.entries(mapEventToRecord(build(), { now: T0 }))
    .filter(([name]) => !ENRICHMENT_FIELDS.includes(name) && name !== 'field_sources'));
  const cleared = syncLiveEvents({ payload: livePayload([]), existing: [legacy], now: T0 + 60_000 });
  assert.equal(cleared.stats.cleared, 1);
  const rec = cleared.upserts[0];
  assert.equal(rec.status, 'cleared');
  for (const name of PENDING_FIELDS) assert.equal(rec[name], NA);
  assert.equal(rec.cross_street, 'Davie Rd');
  assert.equal(validateRecord(EVENTS_DEF, rec).valid, true);
});

const DC_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

test('every DateTime attribute across the Live classes is emitted without milliseconds', () => {
  const dateTimes = LIVE_CLASS_NAMES.flatMap(name => liveClassDefinition(name).attributes.filter(a => a.type === 'DateTime')
    .map(a => `${name}.${a.name}`));
  assert.deepEqual(dateTimes, [`${LIVE_CLASS.EVENTS}.reported_at`, `${LIVE_CLASS.EVENTS}.updated_at`]);
  const odd = Date.parse('2026-09-26T08:11:41.238Z');
  for (const detail of [DETAIL, { ...DETAIL, fields: [] }]) {
    const rec = mapEventToRecord(build(detail), { now: odd, firstSeenAt: '2026-09-26T08:10:00.517Z' });
    assert.match(rec.reported_at, DC_DATETIME);
    assert.match(rec.updated_at, DC_DATETIME);
    assert.equal(validateRecord(EVENTS_DEF, rec).valid, true);
  }
  const cleared = syncLiveEvents({ payload: livePayload([]), existing: [mapEventToRecord(build(), { now: T0 })], now: odd }).upserts[0];
  assert.match(cleared.reported_at, DC_DATETIME);
  assert.match(cleared.updated_at, DC_DATETIME);
});

test('toDcDateTime drops milliseconds and normalises any zone to Z', () => {
  assert.equal(toDcDateTime('2026-09-26T08:11:41.238Z'), '2026-09-26T08:11:41Z');
  assert.equal(toDcDateTime('2026-09-26T08:14:32.000+00:00'), '2026-09-26T08:14:32Z');
  assert.equal(toDcDateTime('2026-09-26T04:14:32-04:00'), '2026-09-26T08:14:32Z');
  assert.equal(toDcDateTime(Date.parse('2026-09-26T08:11:41.999Z')), '2026-09-26T08:11:41Z');
  for (const bad of [null, undefined, '', 'NA', 'soon', NaN]) assert.equal(toDcDateTime(bad), null, String(bad));
});

test('DataConnect refuses milliseconds in DateTime attributes: validateRecord does the same', () => {
  const rec = mapEventToRecord(build(), { now: T0 });
  const { valid, failures } = validateRecord(EVENTS_DEF, { ...rec, reported_at: '2026-09-26T08:11:41.238Z' });
  assert.equal(valid, false);
  assert.deepEqual(failures, [{ attribute: 'reported_at', reasonCode: 'Type', reason: 'DateTime type cannot have milliseconds' }]);
  assert.equal(validateRecord(EVENTS_DEF, { ...rec, updated_at: '2026-09-26T08:11:41Z' }).valid, true);
  assert.equal(validateRecord(EVENTS_DEF, { ...rec, updated_at: '2026-09-26T08:14:32.000+00:00' }).valid, false);
  // String attributes may carry milliseconds.
  assert.equal(validateRecord(EVENTS_DEF, { ...rec, last_seen_at: '2026-09-26T08:11:41.238Z' }).valid, true);
});

test('a DataConnect read-back of a DateTime (.000+00:00) is not a change', () => {
  const rec = mapEventToRecord(build(), { now: T0 });
  const readBack = { ...rec, reported_at: rec.reported_at.replace('Z', '.000+00:00'), updated_at: rec.updated_at.replace('Z', '.000+00:00') };
  assert.deepEqual(diffRecords([rec], [readBack]), { upserts: [], unchanged: 1 });
  assert.equal(diffRecords([{ ...rec, reported_at: '2026-09-26T04:27:00Z' }], [readBack]).upserts.length, 1);
  const again = syncLiveEvents({ payload: livePayload([build()]), existing: [readBack], now: T0 + 60_000 });
  assert.equal(again.upserts.length, 0);
});
