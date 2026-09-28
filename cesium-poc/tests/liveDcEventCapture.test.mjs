/**
 * Camera snapshots (first seen / cleared) and weather captured once per Live Event: camera choice,
 * S3 key, stores, stickiness and failure handling. No network: fetch, spawn and S3 are fakes.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LIVE_CLASS, LIVE_CLASS_NAMES, REF, liveClassDefinition, placeholderObjectId, validateRecord } from '../server/liveDc/classes.mjs';
import { syncLiveEvents } from '../server/liveDc/eventSync.mjs';
import {
  chooseSnapshotCamera, createAwsCliSnapshotStore, createS3SnapshotStore, divasSnapshotUrl, fetchDivasSnapshot, snapshotKey,
  snapshotStoreFromEnv,
} from '../server/liveDc/eventSnapshots.mjs';
import { createEventCapture } from '../server/liveDc/eventCapture.mjs';
import { createCycleMemory, runLiveDcCycle } from '../server/liveDc/cycle.mjs';
import { loadWorkflowConfig } from '../server/liveDc/workflow.mjs';

const EVENTS_DEF = liveClassDefinition(LIVE_CLASS.EVENTS);
const T0 = Date.parse('2026-09-26T04:30:00Z');
const BASE = 'https://d3syo4sqvwi009.cloudfront.net';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const silent = { log() {}, info() {}, warn() {}, error() {} };
const CAMERAS = Object.freeze([
  { cameraId: '2026', divasChanId: '9545', direction: 'W', longitude: -80.2266, latitude: 26.0934 },
  { cameraId: '2034', divasChanId: '9560', direction: 'E', longitude: -80.2300, latitude: 26.0936 },
  { cameraId: '1837', divasChanId: null, direction: null, longitude: -80.2200, latitude: 26.0930 },
]);
const CONTEXT = Object.freeze({ cameras: CAMERAS, segments: [] });
const WEATHER = {
  current: {
    time: '2026-09-26T04:30', temperature_2m: 27.4, relative_humidity_2m: 81, precipitation: 0, weather_code: 0,
    wind_speed_10m: 12.2, wind_direction_10m: 135,
  },
};

function event(itemId = '1', extra = {}) {
  return {
    id: `FL511-INCIDENT-${itemId}`, source: 'FL511', type: 'INCIDENT', rawSourceId: itemId, latitude: 26.093417, longitude: -80.226583,
    title: 'Incident', description: 'Crash on I-595 West at Davie Rd.', detailsAvailable: true, startTime: 'Sep 26 2026, 12:26 AM',
    liveOps: { carriageway: 'WB_GENERAL', direction: 'WB', laneImpact: { source: 'none' }, spatialMatch: { confidence: 'HIGH' } },
    ...extra,
  };
}
const live = events => ({ sourceStatus: 'LIVE', events, diagnostics: { feeds: { incidents: { error: null } } } });

function fakeFetch({ image = () => new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } }), weather = () => Response.json(WEATHER) } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(String(url));
    if (String(url).startsWith('https://images-dis.divas.cloud/')) return image(url, init);
    if (String(url).startsWith('https://api.open-meteo.com/')) return weather(url, init);
    throw new Error(`unexpected ${url}`);
  };
  return { impl, calls, divas: () => calls.filter(u => u.includes('divas')), meteo: () => calls.filter(u => u.includes('open-meteo')) };
}

function fakeStore({ fail = false } = {}) {
  const puts = [];
  return {
    puts,
    async put(key, bytes, contentType) {
      if (fail) throw new Error('AccessDenied');
      puts.push({ key, bytes, contentType });
    },
    url: key => `${BASE}/${key}`,
  };
}

describe('snapshot key and DIVAS image', () => {
  test('snapshots/<eventKey>/<UTC compact ts>_<cameraId>.jpg', () => {
    assert.equal(snapshotKey('FL511-868702', Date.parse('2026-09-26T04:26:07.900Z'), '2026'), 'snapshots/FL511-868702/20260926T042607Z_2026.jpg');
    assert.equal(snapshotKey('FL511-1', T0, '../x y'), 'snapshots/FL511-1/20260926T043000Z_x_y.jpg');
    assert.throws(() => snapshotKey('../etc', T0, '1'), /event key/);
  });

  test('the DIVAS URL is the one the snapshot proxy uses', () => {
    assert.equal(divasSnapshotUrl('9545'), 'https://images-dis.divas.cloud/DGI/chan-9545_h.jpg');
    assert.equal(divasSnapshotUrl('95/45'), null);
  });

  test('fetchDivasSnapshot returns JPEG bytes, else null (non-image, HTTP error, network error, timeout)', async () => {
    const ok = fakeFetch();
    assert.deepEqual(await fetchDivasSnapshot('9545', { fetchImpl: ok.impl }), JPEG);
    assert.deepEqual(ok.calls, ['https://images-dis.divas.cloud/DGI/chan-9545_h.jpg']);
    for (const image of [
      () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      () => new Response(JPEG, { status: 404, headers: { 'content-type': 'image/jpeg' } }),
      () => new Response(new Uint8Array(0), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
      () => { throw new Error('offline'); },
      (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    ]) {
      assert.equal(await fetchDivasSnapshot('9545', { fetchImpl: fakeFetch({ image }).impl, timeoutMs: 20 }), null);
    }
  });
});

describe('camera choice', () => {
  const point = { longitude: -80.226583, latitude: 26.093417, direction: 'EB' };

  test('prefers the first FL511 carousel camera that maps to a corridor camera by id', () => {
    const fl511Cameras = [{ cameraId: '9999', divasChanId: null }, { cameraId: '2026', divasChanId: '9545' }];
    assert.deepEqual(chooseSnapshotCamera({ ...point, fl511Cameras, cameras: CAMERAS }), { cameraId: '2026', divasChanId: '9545', source: 'FL511' });
  });

  test('an id match without a corridor DIVAS channel uses the channel from FL511 video URL', () => {
    const fl511Cameras = [{ cameraId: '1837', divasChanId: '7001' }];
    assert.deepEqual(chooseSnapshotCamera({ ...point, fl511Cameras, cameras: CAMERAS }), { cameraId: '1837', divasChanId: '7001', source: 'FL511' });
  });

  test('else by DIVAS channel; carousel entries carry no position, so an unmatched one is skipped', async () => {
    assert.deepEqual(chooseSnapshotCamera({ ...point, fl511Cameras: [{ cameraId: '5555', divasChanId: '9560' }], cameras: CAMERAS }),
      { cameraId: '2034', divasChanId: '9560', source: 'FL511' });
    const unmatched = [{ cameraId: '5556', divasChanId: null, longitude: -80.2267, latitude: 26.0935 }];
    assert.deepEqual(chooseSnapshotCamera({ ...point, fl511Cameras: unmatched, cameras: CAMERAS }), { cameraId: '2034', divasChanId: '9560', source: 'derived' });
    const snapshots = await import('../server/liveDc/eventSnapshots.mjs');
    assert.equal('CAROUSEL_MATCH_RADIUS_M' in snapshots, false);
  });

  test('falls back to the nearest corridor camera with a DIVAS channel (same direction first)', () => {
    assert.deepEqual(chooseSnapshotCamera({ ...point, fl511Cameras: [], cameras: CAMERAS }), { cameraId: '2034', divasChanId: '9560', source: 'derived' });
    assert.deepEqual(chooseSnapshotCamera({ ...point, direction: 'WB', cameras: CAMERAS }), { cameraId: '2026', divasChanId: '9545', source: 'derived' });
    assert.equal(chooseSnapshotCamera({ longitude: -81, latitude: 27, cameras: CAMERAS }), null);
  });
});

describe('snapshot stores', () => {
  test('S3: PutObject with image/jpeg; the public URL is the CloudFront base + key', async () => {
    const sent = [];
    class PutObjectCommand { constructor(input) { this.input = input; } }
    const store = createS3SnapshotStore({ send: async command => { sent.push(command); }, PutObjectCommand, bucket: 'data-bucket', publicBase: `${BASE}/` });
    await store.put('snapshots/FL511-1/20260926T043000Z_2026.jpg', JPEG);
    assert.equal(sent.length, 1);
    assert.ok(sent[0] instanceof PutObjectCommand);
    assert.deepEqual({ ...sent[0].input, Body: [...sent[0].input.Body] }, {
      Bucket: 'data-bucket', Key: 'snapshots/FL511-1/20260926T043000Z_2026.jpg', Body: [...JPEG], ContentType: 'image/jpeg',
    });
    assert.equal(store.url('snapshots/a.jpg'), `${BASE}/snapshots/a.jpg`);
    await assert.rejects(() => store.put('status/x.json', JPEG), /snapshots\//);
  });

  function fakeSpawn({ code = 0 } = {}) {
    const calls = [];
    const spawnImpl = (command, args, options) => {
      const child = new EventEmitter();
      const chunks = [];
      child.stdin = { write: chunk => chunks.push(Buffer.from(chunk)), end: () => { setImmediate(() => child.emit('close', code)); }, on() {} };
      child.stderr = new EventEmitter();
      child.kill = () => {};
      calls.push({ command, args, options, stdin: chunks });
      return child;
    };
    return { spawnImpl, calls };
  }

  test('local: aws s3 cp - with the image on stdin', async () => {
    const spawn = fakeSpawn();
    const store = createAwsCliSnapshotStore({ bucket: 'data-bucket', publicBase: BASE, spawnImpl: spawn.spawnImpl });
    await store.put('snapshots/FL511-1/20260926T043000Z_2026.jpg', JPEG);
    assert.equal(spawn.calls[0].command, 'aws');
    assert.deepEqual(spawn.calls[0].args,
      ['s3', 'cp', '-', 's3://data-bucket/snapshots/FL511-1/20260926T043000Z_2026.jpg', '--content-type', 'image/jpeg', '--only-show-errors']);
    assert.deepEqual([...Buffer.concat(spawn.calls[0].stdin)], [...JPEG]);
    const failing = createAwsCliSnapshotStore({ bucket: 'data-bucket', publicBase: BASE, spawnImpl: fakeSpawn({ code: 1 }).spawnImpl });
    await assert.rejects(() => failing.put('snapshots/a.jpg', JPEG), /exit 1/);
  });

  test('from env: only with LIVE_DC_SNAPSHOT_BUCKET and an https LIVE_DC_SNAPSHOT_PUBLIC_BASE', () => {
    assert.equal(snapshotStoreFromEnv({}), null);
    assert.equal(snapshotStoreFromEnv({ LIVE_DC_SNAPSHOT_BUCKET: 'data-bucket' }), null);
    assert.equal(snapshotStoreFromEnv({ LIVE_DC_SNAPSHOT_BUCKET: 'Bad Bucket', LIVE_DC_SNAPSHOT_PUBLIC_BASE: BASE }), null);
    assert.equal(snapshotStoreFromEnv({ LIVE_DC_SNAPSHOT_BUCKET: 'data-bucket', LIVE_DC_SNAPSHOT_PUBLIC_BASE: 'ftp://x' }), null);
    const store = snapshotStoreFromEnv({ LIVE_DC_SNAPSHOT_BUCKET: 'data-bucket', LIVE_DC_SNAPSHOT_PUBLIC_BASE: BASE });
    assert.equal(store.url('snapshots/a.jpg'), `${BASE}/snapshots/a.jpg`);
  });
});

describe('capture', () => {
  const first = (events, now = T0) => syncLiveEvents({ payload: live(events), existing: [], now, enrichment: CONTEXT });

  test('first sight: one snapshot and the weather, stored in their columns with provenance', async () => {
    const fetch = fakeFetch();
    const store = fakeStore();
    const capture = createEventCapture({ snapshotStore: store, fetchImpl: fetch.impl, context: CONTEXT, logger: silent });
    const events = [event('1', { fl511Cameras: [{ cameraId: '2026', divasChanId: '9545' }] })];
    const { upserts } = first(events);
    const stats = await capture({ records: upserts, events, now: T0 + 1500 });
    const rec = upserts[0];
    assert.deepEqual(store.puts.map(p => p.key), ['snapshots/FL511-1/20260926T043001Z_2026.jpg']);
    assert.equal(store.puts[0].contentType, 'image/jpeg');
    assert.equal(rec.snapshot_first_url, `${BASE}/snapshots/FL511-1/20260926T043001Z_2026.jpg`);
    assert.equal(rec.snapshot_first_taken_at, '2026-09-26T04:30:01Z');
    assert.equal(rec.snapshot_first_camera_id, '2026');
    assert.equal(rec.snapshot_archive_url, rec.snapshot_first_url);
    assert.equal('snapshot_cleared_url' in rec, false, 'an unset URL is omitted, never "NA"');
    assert.equal('snapshot_cleared_taken_at' in rec, false);
    assert.equal(rec.weather_at_event, 'Clear · 27.4 °C · wind 12 km/h SE');
    assert.equal(rec.weather_code, 0);
    assert.equal(rec.temperature_c, 27.4);
    assert.equal(rec.weather_observed_at, '2026-09-26T04:30:00Z');
    assert.equal(rec.weather_source, 'Open-Meteo');
    const sources = JSON.parse(rec.field_sources);
    assert.equal(sources.snapshot_first_url, 'DIVAS');
    assert.equal(sources.snapshot_archive_url, 'DIVAS');
    assert.equal(sources.weather_at_event, 'Open-Meteo');
    assert.equal(sources.temperature_c, 'Open-Meteo');
    assert.equal(sources.snapshot_cleared_url, 'NA');
    assert.equal(stats.snapshots.first, 1);
    assert.equal(stats.weather.captured, 1);
    assert.deepEqual(validateRecord(EVENTS_DEF, rec), { valid: true, failures: [] });
  });

  test('sticky: a stored snapshot or weather is carried forward, never recaptured, and a re-run writes nothing', async () => {
    const fetch = fakeFetch();
    const capture = createEventCapture({ snapshotStore: fakeStore(), fetchImpl: fetch.impl, context: CONTEXT, logger: silent });
    const events = [event()];
    const { upserts } = first(events);
    await capture({ records: upserts, events, now: T0 });
    const stored = structuredClone(upserts[0]);
    // DataConnect reads DateTimes back with milliseconds and an offset.
    const readBack = { ...stored, snapshot_first_taken_at: stored.snapshot_first_taken_at.replace('Z', '.000+00:00') };
    const heartbeat = syncLiveEvents({ payload: live(events), existing: [readBack], now: T0 + 3600_000, enrichment: CONTEXT });
    assert.equal(heartbeat.stats.heartbeat, 1);
    const carried = heartbeat.upserts[0];
    assert.equal(carried.snapshot_first_url, stored.snapshot_first_url);
    assert.equal(carried.snapshot_first_taken_at, stored.snapshot_first_taken_at);
    assert.equal(carried.temperature_c, 27.4);
    const before = fetch.calls.length;
    await capture({ records: heartbeat.upserts, events, now: T0 + 3600_000 });
    assert.equal(fetch.calls.length, before);
    assert.equal(validateRecord(EVENTS_DEF, carried).valid, true);
    const again = syncLiveEvents({ payload: live(events), existing: [readBack], now: T0 + 60_000, enrichment: CONTEXT });
    assert.equal(again.upserts.length, 0);
  });

  test('cleared: one snapshot from the same camera when the event leaves the feed, then sticky', async () => {
    const fetch = fakeFetch();
    const store = fakeStore();
    const capture = createEventCapture({ snapshotStore: store, fetchImpl: fetch.impl, context: CONTEXT, logger: silent });
    const events = [event('1', { fl511Cameras: [{ cameraId: '1837', divasChanId: '7001' }] })];
    const opened = first(events);
    await capture({ records: opened.upserts, events, now: T0 });
    assert.equal(opened.upserts[0].snapshot_first_camera_id, '1837');
    const cleared = syncLiveEvents({ payload: live([]), existing: opened.upserts, now: T0 + 1800_000, enrichment: CONTEXT });
    assert.equal(cleared.upserts[0].snapshot_first_url, opened.upserts[0].snapshot_first_url);
    const stats = await capture({ records: cleared.upserts, events: [], now: T0 + 1800_000 });
    const rec = cleared.upserts[0];
    assert.equal(stats.snapshots.cleared, 1);
    assert.equal(rec.snapshot_cleared_camera_id, '1837');
    assert.equal(rec.snapshot_cleared_url, `${BASE}/snapshots/FL511-1/20260926T050000Z_1837.jpg`);
    assert.equal(rec.snapshot_cleared_taken_at, '2026-09-26T05:00:00Z');
    assert.equal(fetch.divas().at(-1), 'https://images-dis.divas.cloud/DGI/chan-7001_h.jpg');
    assert.equal(fetch.meteo().length, 1, 'weather is only taken at first sight');
    const before = fetch.calls.length;
    await capture({ records: [rec], events: [], now: T0 + 1900_000 });
    assert.equal(fetch.calls.length, before);
  });

  test('reactivation drops the old cleared snapshot; a later clear captures a fresh one', async () => {
    const capture = createEventCapture({ snapshotStore: fakeStore(), fetchImpl: fakeFetch().impl, context: CONTEXT, logger: silent });
    const events = [event()];
    const opened = first(events);
    await capture({ records: opened.upserts, events, now: T0 });
    const cleared = syncLiveEvents({ payload: live([]), existing: opened.upserts, now: T0 + 600_000, enrichment: CONTEXT });
    await capture({ records: cleared.upserts, events: [], now: T0 + 600_000 });
    const old = cleared.upserts[0];
    assert.match(old.snapshot_cleared_url, /20260926T044000Z/);
    const back = syncLiveEvents({ payload: live(events), existing: [old], now: T0 + 1200_000, enrichment: CONTEXT });
    assert.equal(back.stats.reactivated, 1);
    const re = back.upserts[0];
    await capture({ records: back.upserts, events, now: T0 + 1200_000 });
    for (const name of ['snapshot_cleared_url', 'snapshot_cleared_taken_at', 'cleared_at_dt']) assert.equal(re[name], undefined, name);
    assert.equal(re.snapshot_cleared_camera_id, 'NA');
    assert.equal(re.snapshot_first_url, opened.upserts[0].snapshot_first_url);
    // Merge semantics cannot erase a URL or DateTime, so DataConnect still reads the old ones back.
    const readBack = { ...re, snapshot_cleared_url: old.snapshot_cleared_url, snapshot_cleared_taken_at: old.snapshot_cleared_taken_at, cleared_at_dt: old.cleared_at_dt };
    const steady = syncLiveEvents({ payload: live(events), existing: [readBack], now: T0 + 1260_000, enrichment: CONTEXT });
    assert.equal(steady.upserts.length, 0, 'stale cleared values do not reload the record every cycle');
    const again = syncLiveEvents({ payload: live([]), existing: [readBack], now: T0 + 1800_000, enrichment: CONTEXT });
    assert.equal(again.upserts[0].snapshot_cleared_url, undefined);
    await capture({ records: again.upserts, events: [], now: T0 + 1800_000 });
    assert.match(again.upserts[0].snapshot_cleared_url, /20260926T050000Z/);
    assert.equal(again.upserts[0].snapshot_cleared_taken_at, '2026-09-26T05:00:00Z');
  });

  test('an uploaded snapshot is reused, not re-uploaded, while its load has not reached DataConnect', async () => {
    const fetch = fakeFetch();
    const store = fakeStore();
    const capture = createEventCapture({ snapshotStore: store, fetchImpl: fetch.impl, context: CONTEXT, logger: silent });
    const events = [event()];
    const { upserts } = first(events);
    await capture({ records: upserts, events, now: T0 });
    const url = upserts[0].snapshot_first_url;
    // The Events load was refused: the next cycle's record still has no snapshot.
    const retry = first(events, T0 + 60_000).upserts;
    await capture({ records: retry, events, now: T0 + 60_000 });
    assert.equal(store.puts.length, 1);
    assert.equal(fetch.divas().length, 1);
    assert.equal(retry[0].snapshot_first_url, url);
    assert.equal(retry[0].snapshot_first_taken_at, '2026-09-26T04:30:00Z');
    assert.equal(retry[0].snapshot_first_camera_id, upserts[0].snapshot_first_camera_id);
  });

  test('after an upload timeout the retry reuses the same S3 key, then the upload is remembered', async () => {
    const fetch = fakeFetch();
    const keys = [];
    let hang = true;
    const store = {
      put(key) { keys.push(key); return hang ? new Promise(() => {}) : Promise.resolve(); },
      url: key => `${BASE}/${key}`,
    };
    const capture = createEventCapture({ snapshotStore: store, fetchImpl: fetch.impl, context: CONTEXT, logger: silent, storeTimeoutMs: 20 });
    const events = [event()];
    const opened = first(events).upserts;
    const stats = await capture({ records: opened, events, now: T0 });
    assert.equal('snapshot_first_url' in opened[0], false);
    assert.equal(stats.snapshots.failed, 1);
    hang = false;
    const retry = first(events, T0 + 60_000).upserts;
    await capture({ records: retry, events, now: T0 + 60_000 });
    assert.deepEqual(keys, ['snapshots/FL511-1/20260926T043000Z_2026.jpg', 'snapshots/FL511-1/20260926T043000Z_2026.jpg']);
    assert.equal(retry[0].snapshot_first_url, `${BASE}/${keys[0]}`);
    assert.equal(retry[0].snapshot_first_taken_at, '2026-09-26T04:30:00Z');
    assert.equal(fetch.divas().length, 1, 'the same image is stored again, not a newer one');
    const third = first(events, T0 + 120_000).upserts;
    await capture({ records: third, events, now: T0 + 120_000 });
    assert.equal(keys.length, 2);
    assert.equal(third[0].snapshot_first_url, retry[0].snapshot_first_url);
  });

  test('the cleared snapshot uses the first-seen camera while it has a DIVAS still, before the carousel choice', async () => {
    const fetch = fakeFetch();
    const capture = createEventCapture({ snapshotStore: fakeStore(), fetchImpl: fetch.impl, context: CONTEXT, logger: silent });
    const plain = [event('1', { liveOps: { ...event().liveOps, direction: 'WB' } })];
    const opened = first(plain);
    await capture({ records: opened.upserts, events: plain, now: T0 });
    assert.equal(opened.upserts[0].snapshot_first_camera_id, '2026');
    // FL511 later lists another camera in the tooltip carousel.
    const listed = [{ ...plain[0], fl511Cameras: [{ cameraId: '2034', divasChanId: '9560' }] }];
    const later = syncLiveEvents({ payload: live(listed), existing: opened.upserts, now: T0 + 900_000, enrichment: CONTEXT });
    await capture({ records: later.upserts, events: listed, now: T0 + 900_000 });
    const cleared = syncLiveEvents({ payload: live([]), existing: opened.upserts, now: T0 + 1800_000, enrichment: CONTEXT });
    await capture({ records: cleared.upserts, events: [], now: T0 + 1800_000 });
    assert.equal(cleared.upserts[0].snapshot_cleared_camera_id, '2026');
    assert.equal(fetch.divas().at(-1), 'https://images-dis.divas.cloud/DGI/chan-9545_h.jpg');
  });

  test('camera choice and memory only for the records being captured; pruned when an event leaves the payload', async () => {
    const capture = createEventCapture({ snapshotStore: fakeStore(), fetchImpl: fakeFetch().impl, context: CONTEXT, logger: silent });
    const carousel = [{ cameraId: '2026', divasChanId: '9545' }];
    const events = [event('1', { fl511Cameras: carousel }), event('2', { fl511Cameras: carousel })];
    const { upserts } = first(events);
    await capture({ records: upserts.filter(r => r.keyInSource === 'FL511-1'), events, now: T0 });
    assert.deepEqual(capture.remembered(), ['FL511-1']);
    await capture({ records: [], events: [events[1]], now: T0 + 60_000 });
    assert.deepEqual(capture.remembered(), []);
  });

  test('at most 4 DIVAS / Open-Meteo requests at a time', async () => {
    let inFlight = 0, peak = 0;
    const slow = make => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return make();
    };
    const fetch = fakeFetch({
      image: slow(() => new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } })), weather: slow(() => Response.json(WEATHER)),
    });
    const capture = createEventCapture({ snapshotStore: fakeStore(), fetchImpl: fetch.impl, context: CONTEXT, logger: silent });
    const events = Array.from({ length: 10 }, (_, i) => event(String(i + 1)));
    const { upserts } = first(events);
    const stats = await capture({ records: upserts, events, now: T0 });
    assert.equal(stats.snapshots.first, 10);
    assert.equal(stats.weather.captured, 10);
    assert.ok(peak <= 4, `peak ${peak}`);
    assert.ok(peak > 1);
  });

  test('failures leave NA (strings) or nothing (URLs, numbers, DateTimes) and never throw', async () => {
    for (const setup of [
      { store: fakeStore({ fail: true }), fetch: fakeFetch({ weather: () => Response.json({ error: true, reason: 'x' }) }) },
      { store: fakeStore(), fetch: fakeFetch({ image: () => { throw new Error('offline'); }, weather: () => { throw new Error('offline'); } }) },
      { store: null, fetch: fakeFetch({ weather: () => new Response('x', { status: 500 }) }) },
    ]) {
      const capture = createEventCapture({ snapshotStore: setup.store, fetchImpl: setup.fetch.impl, context: CONTEXT, logger: silent });
      const events = [event()];
      const { upserts } = first(events);
      const stats = await capture({ records: upserts, events, now: T0 });
      const rec = upserts[0];
      for (const name of ['snapshot_first_camera_id', 'snapshot_archive_url', 'weather_at_event', 'weather_source']) {
        assert.equal(rec[name], 'NA', name);
      }
      assert.equal(JSON.parse(rec.field_sources).snapshot_first_url, 'NA');
      for (const name of ['snapshot_first_url', 'snapshot_cleared_url']) assert.equal(name in rec, false, name);
      for (const name of ['snapshot_first_taken_at', 'weather_code', 'temperature_c', 'weather_observed_at']) assert.equal(rec[name], undefined, name);
      assert.equal(validateRecord(EVENTS_DEF, rec).valid, true);
      assert.equal(stats.snapshots.first, 0);
      if (!setup.store) assert.equal(setup.fetch.divas().length, 0, 'no store, no DIVAS request');
    }
  });

  test('first-sight captures are only taken while the event is young', async () => {
    const fetch = fakeFetch();
    const capture = createEventCapture({ snapshotStore: fakeStore(), fetchImpl: fetch.impl, context: CONTEXT, logger: silent, maxFirstCaptureAgeMs: 3600_000 });
    const events = [event()];
    const { upserts } = first(events, T0 - 2 * 3600_000);
    await capture({ records: upserts, events, now: T0 });
    assert.equal(fetch.calls.length, 0);
    assert.equal('snapshot_first_url' in upserts[0], false);
  });
});

describe('cycle', () => {
  function fakeWriter() {
    const dtos = new Map(LIVE_CLASS_NAMES.map((name, i) => [name, { id: placeholderObjectId(name), classId: 101 + i, className: name }]));
    const store = new Map(LIVE_CLASS_NAMES.map(name => [name, new Map()]));
    const loads = [];
    return {
      store, loads,
      async resolveLiveClasses() { return dtos; },
      async findClassByName(name) { return { id: 'assets', className: name }; },
      async readAll(dto) {
        if (dto.className === REF.ASSETS) return [];
        return [...store.get(dto.className).values()].map(r => ({
          keyInSource: r.keyInSource,
          attributes: Object.fromEntries(Object.entries(r).filter(([k, v]) => k !== 'keyInSource' && k !== 'geometry' && v !== '')),
        }));
      },
      async loadRecords(dto, records) {
        loads.push({ className: dto.className, records: structuredClone(records) });
        if (!records.length) return { skipped: true, count: 0, curation: null, stats: null };
        for (const r of records) store.get(dto.className).set(r.keyInSource, { ...store.get(dto.className).get(r.keyInSource), ...structuredClone(r) });
        return { skipped: false, count: records.length, curation: { status: 'Finished' }, stats: { new: records.length, updated: 0, notChanged: 0 } };
      },
    };
  }

  test('captures before the Events load, reports it, and an unchanged re-run captures and writes nothing', async () => {
    const writer = fakeWriter();
    const fetch = fakeFetch();
    const events = [event('1', { fl511Cameras: [{ cameraId: '2026', divasChanId: '9545' }] })];
    const service = { async refresh() {}, async snapshot() { return live(events); } };
    const capture = createEventCapture({ snapshotStore: fakeStore(), fetchImpl: fetch.impl, context: CONTEXT, logger: silent });
    const clock = { t: T0 };
    const run = () => runLiveDcCycle({
      writer, service, now: () => clock.t, workflowConfig: loadWorkflowConfig(), profileName: 'demo', memory: createCycleMemory(),
      assetCache: { get: async () => [] }, logger: silent, capture, publicApiBase: BASE, enrichment: CONTEXT,
    });
    const report = await run();
    assert.deepEqual(report.errors, []);
    const sent = writer.loads.find(l => l.className === LIVE_CLASS.EVENTS).records[0];
    assert.match(sent.snapshot_first_url, /^https:\/\/d3syo4sqvwi009\.cloudfront\.net\/snapshots\/FL511-1\//);
    assert.equal(sent.camera_snapshot_url, `${BASE}/api/i595/camera/9545/snapshot`);
    assert.equal(report.capture.snapshots.first, 1);
    const calls = fetch.calls.length;
    clock.t += 60_000;
    writer.loads.length = 0;
    await run();
    assert.equal(fetch.calls.length, calls);
    assert.equal(writer.loads.find(l => l.className === LIVE_CLASS.EVENTS).records.length, 0);
  });

  test('a failed first-sight capture is retried while the event is young, and a filled value is loaded', async () => {
    const writer = fakeWriter();
    let weatherUp = false;
    const fetch = fakeFetch({ weather: () => (weatherUp ? Response.json(WEATHER) : new Response('x', { status: 503 })) });
    const events = [event()];
    const service = { async refresh() {}, async snapshot() { return live(events); } };
    const capture = createEventCapture({ snapshotStore: fakeStore(), fetchImpl: fetch.impl, context: CONTEXT, logger: silent });
    const clock = { t: T0 };
    const memory = createCycleMemory();
    const run = () => runLiveDcCycle({
      writer, service, now: () => clock.t, workflowConfig: loadWorkflowConfig(), profileName: 'demo', memory,
      assetCache: { get: async () => [] }, logger: silent, capture, publicApiBase: BASE, enrichment: CONTEXT,
    });
    const eventLoads = () => writer.loads.filter(l => l.className === LIVE_CLASS.EVENTS);
    await run();
    assert.equal(eventLoads()[0].records[0].weather_source, 'NA');
    const snapshots = fetch.divas().length;
    clock.t += 60_000;
    weatherUp = true;
    const report = await run();
    assert.deepEqual(report.errors, []);
    const sent = eventLoads().at(-1).records;
    assert.equal(sent.length, 1);
    assert.equal(sent[0].weather_source, 'Open-Meteo');
    assert.equal(sent[0].temperature_c, 27.4);
    assert.ok(sent[0].snapshot_first_url, 'the stored snapshot is carried along');
    assert.equal(fetch.divas().length, snapshots, 'the snapshot is not retaken');
    assert.equal(validateRecord(EVENTS_DEF, sent[0]).valid, true);
    clock.t += 60_000;
    const calls = fetch.calls.length;
    await run();
    assert.equal(eventLoads().at(-1).records.length, 0);
    assert.equal(fetch.calls.length, calls);
  });

  test('no retry once the first-capture window has passed', async () => {
    const writer = fakeWriter();
    const fetch = fakeFetch({ weather: () => new Response('x', { status: 503 }) });
    const service = { async refresh() {}, async snapshot() { return live([event()]); } };
    const capture = createEventCapture({ snapshotStore: null, fetchImpl: fetch.impl, context: CONTEXT, logger: silent });
    const clock = { t: T0 };
    const memory = createCycleMemory();
    const run = () => runLiveDcCycle({
      writer, service, now: () => clock.t, workflowConfig: loadWorkflowConfig(), profileName: 'demo', memory, heartbeatSeconds: 0,
      assetCache: { get: async () => [] }, logger: silent, capture, enrichment: CONTEXT,
    });
    await run();
    clock.t += 60_000;
    await run();
    assert.equal(fetch.meteo().length, 2);
    clock.t += 2 * 3600_000;
    await run();
    assert.equal(fetch.meteo().length, 2);
  });

  test('a throwing capture is a warning, not a failed cycle', async () => {
    const writer = fakeWriter();
    const service = { async refresh() {}, async snapshot() { return live([event()]); } };
    const report = await runLiveDcCycle({
      writer, service, now: () => T0, workflowConfig: loadWorkflowConfig(), profileName: 'demo', memory: createCycleMemory(),
      assetCache: { get: async () => [] }, logger: silent, enrichment: CONTEXT, capture: async () => { throw new Error('boom'); },
    });
    assert.deepEqual(report.errors, []);
    assert.ok(report.warnings.some(w => /capture/.test(w)));
    assert.equal(writer.loads.find(l => l.className === LIVE_CLASS.EVENTS).records.length, 1);
  });
});

test('the sync summary line reports captures only when there were some', async () => {
  const { formatCycleSummary } = await import('../tools/live-dc-sync.mjs');
  const base = { at: 'T', sourceStatus: 'LIVE', sync: null, workflow: null, loads: {}, errors: [], warnings: [] };
  assert.ok(!formatCycleSummary(base).includes('capture'));
  const line = formatCycleSummary({ ...base, capture: { snapshots: { first: 2, cleared: 1, failed: 1 }, weather: { captured: 2, failed: 0 } } });
  assert.match(line, /\| capture: first=2 cleared=1 failed=1 weather=2\/0 \|/);
});
