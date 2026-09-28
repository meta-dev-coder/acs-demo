/**
 * The SDNA enrichment fields in the browser: the Live Events normaliser carries them, and the Asset
 * Explorer detail rows of a live incident show each one (label + value, "NA" as "NA").
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_EVENT_FIELDS, normalizeLiveRows } from '../src/maintenance/liveDcSource.js';
import { normalizeIncident } from '../src/maintenance/maintenanceRecords.js';
import { LIVE_EVENT_DETAIL_LABELS, detailRows } from '../src/assetExplorer/assetTypes.js';
import { ENRICHMENT_FIELDS, PENDING_FIELDS } from '../server/liveDc/eventEnrichment.mjs';
import { TYPE_LABELS as SYNC_TYPE_LABELS } from '../server/liveDc/eventSync.mjs';
import { LIVE_EVENT_TYPE_LABELS } from '../src/maintenance/liveDcSource.js';
import { sdnaFieldsOf } from '../server/liveDc/liveEventsFromDc.mjs';
import EVENT_FIELDS from '../config/liveDc/eventFields.json' with { type: 'json' };

const NOW = Date.parse('2026-09-26T06:00:00Z');
const SNAPSHOT = '/api/i595/camera/9545/snapshot';
const FIRST_URL = 'https://d3syo4sqvwi009.cloudfront.net/snapshots/FL511-873964/20260926T042705Z_2026.jpg';
const attributes = {
  code: 'FL511-873964', name: 'Incident', event_type: 'INCIDENT', status: 'active', severity: 'Major',
  description: 'Crash on SR-84 West, beyond SR-84/University Drive.', latitude: 26.10065, longitude: -80.25594,
  ...Object.fromEntries(ENRICHMENT_FIELDS.map(name => [name, 'NA'])),
  reported_at: '2026-09-26T04:26:00.000Z', updated_at: '2026-09-26T04:30:00.000Z', milepost: '4.9',
  cross_street: 'SR-84/University Drive', incident_subtype: 'Crash', impact_level: 'High',
  primary_camera_id: '2026', nearby_camera_ids: '2026@120m,2034@300m', camera_snapshot_url: SNAPSHOT,
  incident_time_local: '2026-09-26 12:26 AM EDT', first_seen_at_dt: '2026-09-26T04:27:00.000+00:00',
  snapshot_first_url: FIRST_URL, snapshot_first_taken_at: '2026-09-26T04:27:05.000+00:00', snapshot_first_camera_id: '2026',
  snapshot_archive_url: FIRST_URL, weather_at_event: 'Clear · 27.4 °C · wind 12 km/h SE', weather_code: 0, temperature_c: 27.4,
  wind_direction_deg: 135, weather_source: 'Open-Meteo',
  field_sources: '{"reported_at":"FL511"}',
};
const row = { id: 'oid-1', className: 'SDNA Florida I595 Live Events', keyInSource: 'FL511-873964', attributes };
const [event] = normalizeLiveRows('incidents', [row], { now: NOW });
const rows = () => detailRows({ id: event.id, assetType: 'incidentRecord', source: event });

test('the browser field list matches the server enrichment fields', () => {
  assert.deepEqual([...LIVE_EVENT_FIELDS], [...ENRICHMENT_FIELDS]);
  assert.deepEqual(Object.keys(LIVE_EVENT_DETAIL_LABELS).sort(), [...ENRICHMENT_FIELDS].sort());
});

test('server and browser field names, labels and type labels all come from config/liveDc/eventFields.json', () => {
  const names = EVENT_FIELDS.enrichmentFields.map(entry => entry.name);
  assert.equal(names.length, 41);
  assert.deepEqual([...ENRICHMENT_FIELDS], names);
  assert.deepEqual([...LIVE_EVENT_FIELDS], names);
  assert.deepEqual([...PENDING_FIELDS], EVENT_FIELDS.enrichmentFields.filter(entry => entry.pending).map(entry => entry.name));
  assert.deepEqual({ ...LIVE_EVENT_DETAIL_LABELS }, Object.fromEntries(EVENT_FIELDS.enrichmentFields.map(entry => [entry.name, entry.label])));
  assert.deepEqual({ ...SYNC_TYPE_LABELS }, EVENT_FIELDS.typeLabels);
  assert.deepEqual({ ...LIVE_EVENT_TYPE_LABELS }, EVENT_FIELDS.typeLabels);
});

test('normalizeLiveEvent carries every enrichment field and the camera', () => {
  for (const name of ENRICHMENT_FIELDS) assert.equal(event.related.sdna[name], String(attributes[name]), name);
  assert.deepEqual(event.related.sdna.fieldSources, { reported_at: 'FL511' });
  assert.equal(event.related.cameraId, '2026');
  assert.equal(event.related.cameraSnapshotUrl, SNAPSHOT);
  assert.equal(event.related.injuries, 'NA');
  assert.equal(event.related.fatalities, 'NA');
  assert.ok(Object.isFrozen(event.related.sdna));
});

test('a legacy row without the fields shows NA and no snapshot url', () => {
  const [legacy] = normalizeLiveRows('incidents', [{ ...row, attributes: { code: 'FL511-1', event_type: 'INCIDENT', status: 'active', latitude: 26.1, longitude: -80.2 } }], { now: NOW });
  for (const name of ENRICHMENT_FIELDS) assert.equal(legacy.related.sdna[name], 'NA', name);
  assert.equal(legacy.related.cameraSnapshotUrl, null);
});

test('the Asset Explorer shows each field with its label, NA as NA, including Camera', () => {
  const byLabel = new Map(rows());
  assert.equal(byLabel.get('Camera'), '2026');
  assert.equal(byLabel.get('Camera snapshot'), SNAPSHOT);
  assert.equal(byLabel.get('Milepost'), '4.9');
  assert.equal(byLabel.get('Cross street'), 'SR-84/University Drive');
  assert.equal(byLabel.get('Reported'), '2026-09-26T04:26:00.000Z');
  assert.equal(byLabel.get('Impact level'), 'High');
  assert.equal(byLabel.get('Injuries'), 'NA');
  assert.equal(byLabel.get('Fatalities'), 'NA');
  assert.equal(byLabel.get('Weather'), 'Clear · 27.4 °C · wind 12 km/h SE');
  assert.equal(byLabel.get('Snapshot (first seen)'), FIRST_URL);
  assert.equal(byLabel.get('Snapshot archive'), FIRST_URL);
  assert.equal(byLabel.get('Snapshot (cleared)'), 'NA');
  assert.equal(byLabel.get('Incident time (local)'), '2026-09-26 12:26 AM EDT');
  assert.equal(byLabel.get('Weather code'), '0');
  assert.equal(byLabel.get('Temperature (°C)'), '27.4');
  assert.equal(byLabel.get('Wind direction (°)'), '135');
  assert.equal(byLabel.get('Precipitation (mm)'), 'NA');
  assert.equal(byLabel.get('Weather source'), 'Open-Meteo');
  assert.equal(byLabel.get('Recommended next action'), 'NA');
  for (const label of Object.values(LIVE_EVENT_DETAIL_LABELS)) assert.ok(byLabel.has(label), label);
  assert.equal(new Set(rows().map(([label]) => label)).size, rows().length, 'no duplicate labels');
});

test('the DataConnect live-events source passes the new fields on event.sdna', () => {
  const sdna = sdnaFieldsOf(attributes);
  assert.equal(sdna.snapshot_first_url, FIRST_URL);
  assert.equal(sdna.temperature_c, '27.4');
  assert.equal(sdna.weather_code, '0');
  assert.equal(sdna.cleared_at_dt, 'NA');
  assert.equal(sdna.first_seen_at_dt, '2026-09-26T04:27:00.000+00:00');
  for (const name of ENRICHMENT_FIELDS) assert.ok(name in sdna, name);
});

test('historical incidents get no SDNA rows', () => {
  const historical = normalizeIncident({ 'Incident ID': 'INC-1', 'Incident Type': 'Rear-end crash' });
  const labels = detailRows({ id: 'INC-1', assetType: 'incidentRecord', source: historical }).map(([label]) => label);
  assert.ok(!labels.includes('Camera'));
  assert.ok(!labels.includes('Milepost'));
});
