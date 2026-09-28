/**
 * Live Events time fields (incident_time_local, first_seen_at_dt, cleared_at_dt), the "never NA in a
 * DateTime" rule, and the absolute live camera URL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_CLASS, completeRecord, diffRecords, liveClassDefinition, validateRecord,
} from '../server/liveDc/classes.mjs';
import { enrichEventFields, newYorkLocalTime } from '../server/liveDc/eventEnrichment.mjs';
import { mapEventToRecord, syncLiveEvents } from '../server/liveDc/eventSync.mjs';

const EVENTS_DEF = liveClassDefinition(LIVE_CLASS.EVENTS);
const DATE_TIMES = EVENTS_DEF.attributes.filter(a => a.type === 'DateTime').map(a => a.name);
const DC_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const T0 = Date.parse('2026-09-26T05:00:00.517Z');
const CONTEXT = Object.freeze({
  cameras: [{ cameraId: '2026', divasChanId: '9545', direction: 'W', longitude: -80.2266, latitude: 26.0934 }],
  segments: [],
});

function event(itemId = '1', extra = {}) {
  return {
    id: `FL511-INCIDENT-${itemId}`, source: 'FL511', type: 'INCIDENT', rawSourceId: itemId, latitude: 26.093417, longitude: -80.226583,
    title: 'Incident', description: 'Crash on I-595 West at Davie Rd.', detailsAvailable: true, startTime: 'Sep 26 2026, 12:26 AM',
    liveOps: { carriageway: 'WB_GENERAL', direction: 'WB', laneImpact: { source: 'none' }, spatialMatch: { confidence: 'HIGH' } },
    ...extra,
  };
}
const live = events => ({ sourceStatus: 'LIVE', events, diagnostics: { feeds: { incidents: { error: null } } } });
const sources = rec => JSON.parse(rec.field_sources);

test('incident_time_local is America/New_York wall time with the zone abbreviation, across DST', () => {
  assert.equal(newYorkLocalTime('2026-09-26T04:26:00Z'), '2026-09-26 12:26 AM EDT');
  assert.equal(newYorkLocalTime('2026-01-15T17:05:00Z'), '2026-01-15 12:05 PM EST');
  assert.equal(newYorkLocalTime('2026-03-08T06:59:00Z'), '2026-03-08 1:59 AM EST');
  assert.equal(newYorkLocalTime('2026-03-08T07:00:00Z'), '2026-03-08 3:00 AM EDT');
  assert.equal(newYorkLocalTime('2026-11-01T05:30:00Z'), '2026-11-01 1:30 AM EDT');
  assert.equal(newYorkLocalTime('2026-11-01T06:30:00Z'), '2026-11-01 1:30 AM EST');
  assert.equal(newYorkLocalTime('2026-09-26T18:05:00.000+00:00'), '2026-09-26 2:05 PM EDT');
  for (const bad of [null, undefined, '', 'NA', 'soon']) assert.equal(newYorkLocalTime(bad), null);
});

test('an active event: incident_time_local and first_seen_at_dt set, cleared_at_dt absent, no milliseconds', () => {
  const rec = mapEventToRecord(event(), { now: T0, enrichment: CONTEXT });
  assert.equal(rec.reported_at, '2026-09-26T04:26:00Z');
  assert.equal(rec.incident_time_local, '2026-09-26 12:26 AM EDT');
  assert.equal(rec.first_seen_at_dt, '2026-09-26T05:00:00Z');
  assert.equal('cleared_at_dt' in rec, false);
  assert.equal(sources(rec).incident_time_local, 'derived');
  assert.equal(sources(rec).first_seen_at_dt, 'derived');
  assert.equal(sources(rec).cleared_at_dt, 'NA');
  for (const name of DATE_TIMES) if (name in rec) assert.match(rec[name], DC_DATETIME, name);
  assert.deepEqual(validateRecord(EVENTS_DEF, rec), { valid: true, failures: [] });
});

test('a cleared event gets cleared_at_dt from cleared_at, in whole seconds', () => {
  const first = syncLiveEvents({ payload: live([event()]), existing: [], now: T0, enrichment: CONTEXT });
  const cleared = syncLiveEvents({ payload: live([]), existing: first.upserts, now: T0 + 600_250, enrichment: CONTEXT }).upserts[0];
  assert.equal(cleared.status, 'cleared');
  assert.equal(cleared.cleared_at_dt, '2026-09-26T05:10:00Z');
  assert.equal(sources(cleared).cleared_at_dt, 'derived');
  assert.equal(validateRecord(EVENTS_DEF, cleared).valid, true);
});

test('DateTime attributes are never "NA": without any time they are omitted', () => {
  const bare = enrichEventFields({ keyInSource: 'FL511-9' }, CONTEXT);
  for (const name of DATE_TIMES) assert.equal(bare[name], undefined, name);
  assert.equal(bare.incident_time_local, 'NA');
  assert.equal(sources(bare).reported_at, 'NA');
  const legacy = { ...mapEventToRecord(event(), { now: T0, enrichment: CONTEXT }), reported_at: 'NA', updated_at: 'NA', first_seen_at: '' };
  const out = completeRecord(EVENTS_DEF, { ...legacy, ...enrichEventFields({ ...legacy, start_time: '', last_updated: '', last_seen_at: '' }, CONTEXT) });
  for (const name of DATE_TIMES) assert.notEqual(out[name], 'NA', name);
});

test('validateRecord refuses a non-instant in a DateTime; completeRecord never fills a DateTime with ""', () => {
  const rec = mapEventToRecord(event(), { now: T0, enrichment: CONTEXT });
  assert.deepEqual(validateRecord(EVENTS_DEF, { ...rec, reported_at: 'NA' }).failures,
    [{ attribute: 'reported_at', reasonCode: 'Type', reason: 'Value does not match attribute type DateTime' }]);
  const filled = completeRecord(EVENTS_DEF, { keyInSource: 'k' });
  for (const name of DATE_TIMES) assert.equal(name in filled, false, name);
  assert.equal(filled.cleared_at, '');
});

test('a stale cleared_at_dt left behind by a merge-semantics reactivation is not a change', () => {
  const rec = mapEventToRecord(event(), { now: T0, enrichment: CONTEXT });
  const readBack = { ...rec, cleared_at_dt: '2026-09-26T04:50:00.000+00:00' };
  const again = syncLiveEvents({ payload: live([event()]), existing: [readBack], now: T0 + 60_000, enrichment: CONTEXT });
  assert.equal(again.upserts.length, 0);
});

test('camera_snapshot_url is absolute when a public API base is configured, else relative', () => {
  const point = { keyInSource: 'FL511-1', longitude: -80.226583, latitude: 26.093417 };
  assert.equal(enrichEventFields(point, CONTEXT).camera_snapshot_url, '/api/i595/camera/9545/snapshot');
  assert.equal(enrichEventFields(point, CONTEXT, { publicApiBase: 'https://d3syo4sqvwi009.cloudfront.net/' }).camera_snapshot_url,
    'https://d3syo4sqvwi009.cloudfront.net/api/i595/camera/9545/snapshot');
  assert.equal(enrichEventFields(point, CONTEXT, { publicApiBase: 'not a url' }).camera_snapshot_url, '/api/i595/camera/9545/snapshot');
  const synced = syncLiveEvents({
    payload: live([event()]), existing: [], now: T0, enrichment: CONTEXT, publicApiBase: 'https://d3syo4sqvwi009.cloudfront.net',
  });
  assert.equal(synced.upserts[0].camera_snapshot_url, 'https://d3syo4sqvwi009.cloudfront.net/api/i595/camera/9545/snapshot');
  const cleared = syncLiveEvents({
    payload: live([]), existing: synced.upserts, now: T0 + 60_000, enrichment: CONTEXT, publicApiBase: 'https://d3syo4sqvwi009.cloudfront.net',
  });
  assert.match(cleared.upserts[0].camera_snapshot_url, /^https:\/\/d3syo4sqvwi009\.cloudfront\.net\//);
});
