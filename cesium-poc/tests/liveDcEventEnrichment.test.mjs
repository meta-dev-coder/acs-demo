/**
 * The extra "SDNA Florida I595 Live Events" fields: FL511 times in UTC, prose parsing, milepost,
 * nearby cameras, impact level, "NA" defaults and field_sources. All pure and deterministic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NA, ENRICHMENT_FIELDS, PENDING_FIELDS, SNAPSHOT_PATH, parseFl511Time, parseCrossStreet, parseIncidentSubtype,
  parseVehiclesInvolved, milepostAt, selectCameras, impactLevel, enrichEventFields, loadEnrichmentContext,
} from '../server/liveDc/eventEnrichment.mjs';

test('FL511 display times are America/New_York, converted to ISO UTC across DST', () => {
  assert.equal(parseFl511Time('Sep 26 2026, 12:26 AM'), '2026-09-26T04:26:00Z');
  assert.equal(parseFl511Time('Sep 8 2026, 9:15 PM'), '2026-09-09T01:15:00Z');
  assert.equal(parseFl511Time('Jan 5 2026, 12:00 PM'), '2026-01-05T17:00:00Z');
  // 2026 DST starts Sun Mar 8 at 2:00 AM and ends Sun Nov 1 at 2:00 AM.
  assert.equal(parseFl511Time('Mar 8 2026, 1:59 AM'), '2026-03-08T06:59:00Z');
  assert.equal(parseFl511Time('Mar 8 2026, 3:00 AM'), '2026-03-08T07:00:00Z');
  assert.equal(parseFl511Time('Nov 1 2026, 12:30 AM'), '2026-11-01T04:30:00Z');
  assert.equal(parseFl511Time('Nov 1 2026, 3:00 AM'), '2026-11-01T08:00:00Z');
  assert.equal(parseFl511Time('2026-09-25T11:58:00Z'), '2026-09-25T11:58:00Z');
  assert.equal(parseFl511Time('2026-09-26T08:11:41.238Z'), '2026-09-26T08:11:41Z', 'DataConnect DateTime cannot have milliseconds');
  assert.equal(parseFl511Time('2026-09-26T08:14:32.000+00:00'), '2026-09-26T08:14:32Z');
  for (const bad of [undefined, null, '', 'soon', 'Foo 1 2026, 1:00 AM', 'Sep 31 2026, 1:00 AM', 'Sep 1 2026, 13:00 PM']) {
    assert.equal(parseFl511Time(bad), null, String(bad));
  }
});

test('cross street from "at / beyond / near / before / past"', () => {
  assert.equal(parseCrossStreet('Crash in Broward County on SR-84 West, beyond SR-84/University Drive. 2 Right lanes blocked. Last updated at 12:30 AM.'),
    'SR-84/University Drive');
  assert.equal(parseCrossStreet('Crash on I-595 West at Davie Rd. 2 right lanes blocked.'), 'Davie Rd');
  assert.equal(parseCrossStreet('Disabled vehicle on I-595 East near  Pine Island Road , right shoulder'), 'Pine Island Road');
  assert.equal(parseCrossStreet('Construction on I-595 East before SR 7'), 'SR 7');
  assert.equal(parseCrossStreet('Debris on I-595 West past Exit 5'), 'Exit 5');
  assert.equal(parseCrossStreet('Crash on I-595 East. Last updated at 12:30 AM.'), null);
  assert.equal(parseCrossStreet('Congestion on I-595'), null);
  assert.equal(parseCrossStreet(''), null);
  assert.equal(parseCrossStreet(undefined), null);
});

test('incident subtype from keywords, most specific first', () => {
  const cases = [
    ['Vehicle fire in express lanes', 'Vehicle fire'],
    ['Multi-vehicle crash on I-595 East', 'Multi-vehicle crash'],
    ['Crash involving 3 vehicles on I-595 West', 'Multi-vehicle crash'],
    ['Crash with injuries on I-595 West', 'Crash with injuries'],
    ['Truck rollover in right lane', 'Rollover crash'],
    ['Crash on I-595 West at Davie Rd.', 'Crash'],
    ['Debris in roadway', 'Debris'],
    ['Disabled vehicle on I-595 East. Right shoulder blocked.', 'Disabled vehicle'],
    ['Lane closure on I-595 East. Left lane closed.', 'Lane closure'],
    ['Planned construction in Broward County on 95 Express South', 'Construction'],
    ['Congestion on I-595', 'Congestion'],
    ['Standing water on the ramp', 'Flooding'],
    ['Incident on I-595', null],
    ['', null],
  ];
  for (const [text, expected] of cases) assert.equal(parseIncidentSubtype(text), expected, text);
});

test('vehicles involved: explicit numbers, words, multi-vehicle; never lanes', () => {
  assert.equal(parseVehiclesInvolved('Crash involving 3 vehicles'), '3');
  assert.equal(parseVehiclesInvolved('2-vehicle crash on I-595'), '2');
  assert.equal(parseVehiclesInvolved('Two vehicles in the median'), '2');
  assert.equal(parseVehiclesInvolved('Multi-vehicle crash'), 'Multiple');
  assert.equal(parseVehiclesInvolved('Crash. 2 right lanes blocked.'), null);
  assert.equal(parseVehiclesInvolved('Disabled vehicle'), null);
  assert.equal(parseVehiclesInvolved(null), null);
});

const SEGMENT = { segmentId: 'S1', beginPost: 4, endPost: 5, coordinates: [[-80.30, 26.10], [-80.29, 26.10], [-80.28, 26.10]] };

test('milepost interpolates along the FDOT segment geometry', () => {
  assert.equal(milepostAt({ longitude: -80.30, latitude: 26.10 }, SEGMENT), 4);
  assert.equal(milepostAt({ longitude: -80.28, latitude: 26.10 }, SEGMENT), 5);
  assert.ok(Math.abs(milepostAt({ longitude: -80.29, latitude: 26.1001 }, SEGMENT) - 4.5) < 1e-6);
  assert.ok(Math.abs(milepostAt({ longitude: -80.285, latitude: 26.0999 }, SEGMENT) - 4.75) < 1e-3);
  assert.equal(milepostAt({ longitude: -80.40, latitude: 26.10 }, SEGMENT), 4, 'clamped to the segment');
  assert.equal(milepostAt({ longitude: NaN, latitude: 26.1 }, SEGMENT), null);
  assert.equal(milepostAt({ longitude: -80.29, latitude: 26.1 }, null), null);
});

const CAMERAS = [
  { cameraId: 'W1', divasChanId: '11', direction: 'W', longitude: -80.2900, latitude: 26.1000 },
  { cameraId: 'E1', divasChanId: null, direction: 'E', longitude: -80.2901, latitude: 26.1000 },
  { cameraId: 'N1', divasChanId: '33', direction: null, longitude: -80.2950, latitude: 26.1000 },
  { cameraId: 'FAR', divasChanId: '44', direction: 'W', longitude: -80.2000, latitude: 26.1000 },
];

test('cameras: within 2000 m, same direction first, then distance, at most 3', () => {
  const west = selectCameras({ longitude: -80.2902, latitude: 26.1, direction: 'WB' }, CAMERAS);
  assert.deepEqual(west.map(c => c.cameraId), ['W1', 'E1', 'N1']);
  assert.deepEqual(west.map(c => c.distanceM), [20, 10, 479]);
  const east = selectCameras({ longitude: -80.2902, latitude: 26.1, direction: 'EB' }, CAMERAS);
  assert.deepEqual(east.map(c => c.cameraId), ['E1', 'W1', 'N1']);
  const any = selectCameras({ longitude: -80.2902, latitude: 26.1, direction: '' }, CAMERAS);
  assert.deepEqual(any.map(c => c.cameraId), ['E1', 'W1', 'N1']);
  assert.deepEqual(selectCameras({ longitude: -80.25, latitude: 26.1, direction: 'WB' }, CAMERAS), []);
  assert.deepEqual(selectCameras({ longitude: null, latitude: 26.1 }, CAMERAS), []);
});

test('impact level reuses the Live Ops per-event score from record values', () => {
  assert.equal(impactLevel({ event_type: 'INCIDENT', severity: 'Major', blocked_lanes: '2', full_closure: 'No' }), 'High');
  assert.equal(impactLevel({ event_type: 'INCIDENT', severity: 'Major', blocked_lanes: '', full_closure: 'Yes' }), 'Severe');
  assert.equal(impactLevel({ event_type: 'INCIDENT', severity: '', full_closure: '' }), 'Moderate');
  assert.equal(impactLevel({ event_type: 'DISABLED', severity: '' }), 'Low');
  assert.equal(impactLevel({ event_type: 'CLOSURE', full_closure: 'Yes' }), 'High');
  assert.equal(impactLevel({ event_type: 'UNKNOWN' }), null);
});

const CONTEXT = { segments: [SEGMENT], cameras: CAMERAS };
const BASE = {
  event_type: 'INCIDENT', severity: 'Major', title: 'Incident', description: 'Multi-vehicle crash on I-595 West at Davie Rd. 2 right lanes blocked.',
  start_time: 'Sep 26 2026, 12:26 AM', end_time: 'Sep 26 2026, 3:00 AM', last_updated: 'Sep 26 2026, 12:30 AM',
  first_seen_at: '2026-09-26T04:31:00.000Z', last_seen_at: '2026-09-26T05:00:00.000Z',
  latitude: 26.1, longitude: -80.2902, direction: 'WB', fdot_segment_id: 'S1', blocked_lanes: '2', full_closure: 'No',
};

test('enrichEventFields fills every field, derived where possible', () => {
  const out = enrichEventFields(BASE, CONTEXT);
  assert.deepEqual(Object.keys(out), [...ENRICHMENT_FIELDS, 'field_sources']);
  assert.equal(out.reported_at, '2026-09-26T04:26:00Z');
  assert.equal(out.updated_at, '2026-09-26T04:30:00Z');
  assert.equal(out.est_clearance_at, '2026-09-26T07:00:00Z');
  assert.equal(out.milepost, '4.5');
  assert.equal(out.cross_street, 'Davie Rd');
  assert.equal(out.incident_subtype, 'Multi-vehicle crash');
  assert.equal(out.vehicles_involved, 'Multiple');
  assert.equal(out.impact_level, 'High');
  assert.equal(out.primary_camera_id, 'W1');
  assert.equal(out.nearby_camera_ids, 'W1@20m,E1@10m,N1@479m');
  assert.equal(out.camera_snapshot_url, `${SNAPSHOT_PATH}/11/snapshot`);
  assert.equal(SNAPSHOT_PATH, '/api/i595/camera');
  for (const name of PENDING_FIELDS) assert.equal(out[name], NA, name);
  const sources = JSON.parse(out.field_sources);
  assert.deepEqual(Object.keys(sources), ENRICHMENT_FIELDS);
  assert.equal(sources.reported_at, 'FL511');
  assert.equal(sources.updated_at, 'FL511');
  assert.equal(sources.est_clearance_at, 'FL511');
  assert.equal(sources.milepost, 'derived');
  assert.equal(sources.cross_street, 'derived');
  assert.equal(sources.primary_camera_id, 'derived');
  assert.equal(sources.injuries, 'NA');
});

test('NA everywhere a value is not available; times fall back to first/last seen', () => {
  const out = enrichEventFields({
    event_type: 'MYSTERY', description: 'Incident on I-595', first_seen_at: '2026-09-26T04:31:00.000Z', last_seen_at: '2026-09-26T05:00:00.000Z',
    latitude: 26.2, longitude: -80.0, direction: '', fdot_segment_id: '',
  }, CONTEXT);
  assert.equal(out.reported_at, '2026-09-26T04:31:00Z');
  assert.equal(out.updated_at, '2026-09-26T05:00:00Z');
  for (const name of ENRICHMENT_FIELDS.filter(n => !['reported_at', 'updated_at'].includes(n))) assert.equal(out[name], NA, name);
  const sources = JSON.parse(out.field_sources);
  assert.equal(sources.reported_at, 'derived');
  assert.equal(sources.updated_at, 'derived');
  assert.equal(sources.milepost, 'NA');
  for (const value of Object.values(out)) assert.equal(typeof value, 'string');
});

test('a camera without a DIVAS channel has no snapshot url', () => {
  const out = enrichEventFields({ ...BASE, direction: 'EB' }, CONTEXT);
  assert.equal(out.primary_camera_id, 'E1');
  assert.equal(out.camera_snapshot_url, NA);
  assert.equal(JSON.parse(out.field_sources).camera_snapshot_url, 'NA');
});

test('deterministic: same input, same output', () => {
  assert.deepEqual(enrichEventFields(BASE, CONTEXT), enrichEventFields({ ...BASE }, CONTEXT));
});

test('the default context reads the local corridor cameras and FDOT segments', () => {
  const context = loadEnrichmentContext();
  assert.equal(context, loadEnrichmentContext(), 'memoised');
  assert.equal(context.cameras.length, 74);
  assert.equal(context.segments.length, 16);
  const segment = context.segments.find(s => s.segmentId === 'I595-WB-FDOT-006680-007350');
  assert.deepEqual([segment.beginPost, segment.endPost], [6.68, 7.35]);
  const cam = context.cameras.find(c => c.cameraId === '2026');
  assert.deepEqual([cam.divasChanId, cam.direction], ['9545', 'E']);
});
