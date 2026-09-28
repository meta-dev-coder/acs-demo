import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveEventConditionsRows, liveEventSnapshots, liveEventWeatherLine } from '../src/liveEventsData.js';

const sdna = {
  incident_time_local: '2026-09-27 9:16 PM EDT',
  weather_at_event: 'Partly cloudy · 22.7 °C · wind 6 km/h WNW',
  temperature_c: 22.7,
  relative_humidity_pct: 86,
  wind_speed_kmh: 6.4,
  wind_direction_deg: 292,
  precipitation_mm: 0,
  weather_observed_at: '2026-09-28T08:00:00Z',
  snapshot_first_url: 'https://d3syo4sqvwi009.cloudfront.net/snapshots/FL511-876573/20260928T081210Z_4267.jpg',
  snapshot_first_taken_at: '2026-09-28T08:12:10Z',
  snapshot_first_camera_id: '4267',
  snapshot_cleared_url: 'NA',
  camera_snapshot_url: 'https://d3syo4sqvwi009.cloudfront.net/api/i595/camera/8407/snapshot',
};

test('conditions rows come from the DataConnect enrichment, in operator order', () => {
  const rows = liveEventConditionsRows({ sdna });
  assert.deepEqual(rows.map(([label]) => label), ['Incident time', 'Weather', 'Temperature', 'Humidity', 'Wind', 'Precipitation', 'Weather observed']);
  assert.deepEqual(Object.fromEntries(rows).Temperature, '22.7 °C');
  assert.deepEqual(Object.fromEntries(rows).Humidity, '86 %');
  assert.deepEqual(Object.fromEntries(rows).Wind, '6.4 km/h WNW');
  assert.deepEqual(Object.fromEntries(rows).Precipitation, '0 mm');
  assert.deepEqual(Object.fromEntries(rows)['Weather observed'], 'Sep 28 2026, 4:00 AM EDT');
});

test('times are shown in Florida local time, whatever format DataConnect returns', () => {
  const rows = Object.fromEntries(liveEventConditionsRows({ sdna: { weather_observed_at: '2026-09-28T08:00:00.000+00:00' } }));
  assert.equal(rows['Weather observed'], 'Sep 28 2026, 4:00 AM EDT');
  const [shot] = liveEventSnapshots({ sdna: { snapshot_first_url: 'https://x.example/a.jpg', snapshot_first_taken_at: '2026-09-28T08:12:10.000+00:00' } });
  assert.equal(shot.takenAt, 'Sep 28 2026, 4:12 AM EDT');
});

test('one-line weather summary for the top of the panel, with the local incident time', () => {
  assert.equal(liveEventWeatherLine({ sdna }), 'Weather: Partly cloudy · 22.7 °C · wind 6 km/h WNW · incident 9:16 PM EDT');
  assert.equal(liveEventWeatherLine({ sdna: { weather_at_event: 'Clear · 27 °C' } }), 'Weather: Clear · 27 °C');
  assert.equal(liveEventWeatherLine({ sdna: { weather_at_event: 'NA', incident_time_local: '2026-09-27 9:16 PM EDT' } }), null);
  assert.equal(liveEventWeatherLine({}), null);
});

test('an active (e.g. reactivated) event never shows a stale "When cleared" photo', () => {
  const stale = { snapshot_first_url: 'https://x.example/a.jpg', snapshot_cleared_url: 'https://x.example/c.jpg' };
  assert.deepEqual(liveEventSnapshots({ status: 'active', sdna: stale }).map(s => s.label), ['When first seen']);
  assert.deepEqual(liveEventSnapshots({ sdna: { ...stale, status: 'active' } }).map(s => s.label), ['When first seen']);
  assert.deepEqual(liveEventSnapshots({ status: 'cleared', sdna: stale }).map(s => s.label), ['When first seen', 'When cleared']);
});

test('NA, empty and absent values are hidden, never shown as NA', () => {
  const rows = liveEventConditionsRows({ sdna: { weather_at_event: 'NA', temperature_c: undefined, incident_time_local: '' } });
  assert.deepEqual(rows, []);
  assert.deepEqual(liveEventConditionsRows({}), []);
  assert.deepEqual(liveEventConditionsRows(null), []);
});

test('snapshots: first and cleared images only when they are absolute http(s) URLs', () => {
  const shots = liveEventSnapshots({ sdna });
  assert.equal(shots.length, 1);
  assert.deepEqual(shots[0], {
    label: 'When first seen', url: sdna.snapshot_first_url, cameraId: '4267', takenAt: 'Sep 28 2026, 4:12 AM EDT',
  });
  const both = liveEventSnapshots({ status: 'cleared', sdna: { ...sdna, snapshot_cleared_url: 'https://x.example/c.jpg', snapshot_cleared_camera_id: '4267', snapshot_cleared_taken_at: '2026-09-28T09:00:00Z' } });
  assert.deepEqual(both.map(s => s.label), ['When first seen', 'When cleared']);
  assert.deepEqual(liveEventSnapshots({ sdna: { snapshot_first_url: 'javascript:alert(1)' } }), []);
  assert.deepEqual(liveEventSnapshots({ sdna: { snapshot_first_url: '/relative.jpg' } }), []);
  assert.deepEqual(liveEventSnapshots({}), []);
});

test('wind without a direction shows no compass point; the compass comes from weatherText.js', async () => {
  for (const wind_direction_deg of [null, '', 'NA', undefined]) {
    assert.equal(Object.fromEntries(liveEventConditionsRows({ sdna: { wind_speed_kmh: 6.4, wind_direction_deg } })).Wind, '6.4 km/h', String(wind_direction_deg));
  }
  assert.equal(Object.fromEntries(liveEventConditionsRows({ sdna: { wind_speed_kmh: 6.4, wind_direction_deg: '292' } })).Wind, '6.4 km/h WNW');
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/liveEventsData.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ compassPoint \} from '\.\/weather\/weatherText\.js';/);
  assert.doesNotMatch(source, /'NNE'/);
  assert.match(source, /different road — so these are rendered under their own heading\.\n \*\/\nexport function liveEventAssociationRows/);
});
