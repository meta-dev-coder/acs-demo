/**
 * Captures, once per Live Event, a camera snapshot when it is first seen and when it clears, and the
 * weather at first sight. Runs on the records a cycle is about to load and fills their columns in
 * place. Sticky: a record that already holds a value (read back from DataConnect and carried forward
 * by eventSync) is never recaptured. Failures leave the columns unset and never fail the cycle.
 */
import { applyCaptured, loadEnrichmentContext, pointOf, typedValue } from './eventEnrichment.mjs';
import { liveEventKey } from './eventSync.mjs';
import { SNAPSHOT_CONTENT_TYPE, SNAPSHOT_TIMEOUT_MS, chooseSnapshotCamera, fetchDivasSnapshot, snapshotKey } from './eventSnapshots.mjs';
import { fetchEventWeather, WEATHER_TIMEOUT_MS } from './eventWeather.mjs';
import { withDeadline } from './timeouts.mjs';

export const FIRST_CAPTURE_MAX_AGE_MS = 3600_000;
export const UPSTREAM_CONCURRENCY = 4;
const STORE_TIMEOUT_MS = 15_000;
const MEMORY_LIMIT = 1000;

const has = (record, name) => typedValue(name, record[name]) !== null;

/** Runs at most `max` tasks at a time, in call order. */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    Promise.resolve().then(task).then(resolve, reject).finally(() => { active--; next(); });
  };
  return task => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); next(); });
}

/**
 * @param {{snapshotStore?: {put: Function, url: Function}|null, fetchImpl?: typeof fetch, context?: object,
 *   timeoutMs?: number, storeTimeoutMs?: number, maxFirstCaptureAgeMs?: number, concurrency?: number, logger?: object}} options
 * @returns {((input: {records: object[], events?: object[], now: number}) => Promise<object>)
 *   & {needsCapture: (record: object, now: number) => boolean, remembered: () => string[]}} capture
 */
export function createEventCapture({
  snapshotStore = null, fetchImpl = fetch, context = null, timeoutMs = SNAPSHOT_TIMEOUT_MS, storeTimeoutMs = STORE_TIMEOUT_MS,
  maxFirstCaptureAgeMs = FIRST_CAPTURE_MAX_AGE_MS, concurrency = UPSTREAM_CONCURRENCY, logger = console,
} = {}) {
  // Per event key: the camera of the first-seen snapshot (the event is gone from the feed when it
  // clears) and uploads not yet confirmed in DataConnect, so a refused or timed-out load reuses the
  // same object instead of storing another one. Pruned to the keys of the current cycle.
  const memory = new Map();
  const limit = createLimiter(concurrency);

  const young = (record, now) => {
    const firstSeen = Date.parse(record.first_seen_at ?? '');
    return record.status === 'active' && Number.isFinite(firstSeen) && now - firstSeen <= maxFirstCaptureAgeMs;
  };
  const wantsFirstSnapshot = (record, now) => Boolean(snapshotStore) && young(record, now) && !has(record, 'snapshot_first_url');
  const wantsWeather = (record, now) => young(record, now) && !has(record, 'weather_source');

  const entryFor = key => {
    if (!memory.has(key)) {
      memory.set(key, { camera: null, first: null, cleared: null });
      while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value);
    }
    return memory.get(key);
  };

  /** The upload for `slot`, made once (fetch + deterministic key) and stored until it succeeds; null when no image. */
  async function snapshot(record, slot, pickCamera, now) {
    const entry = entryFor(record.keyInSource);
    if (!entry[slot]) {
      const camera = pickCamera(entry);
      const bytes = camera && await limit(() => fetchDivasSnapshot(camera.divasChanId, { fetchImpl, timeoutMs }));
      if (!bytes) return null;
      const key = snapshotKey(record.keyInSource, now, camera.cameraId);
      entry[slot] = { key, url: snapshotStore.url(key), takenAt: now, camera, bytes, stored: false };
      if (slot === 'first') entry.camera = camera;
    }
    const upload = entry[slot];
    if (!upload.stored) {
      await withDeadline(snapshotStore.put(upload.key, upload.bytes, SNAPSHOT_CONTENT_TYPE), storeTimeoutMs);
      upload.stored = true;
      upload.bytes = null;
    }
    return upload;
  }

  async function capture({ records, events = [], now }) {
    const ctx = context ?? loadEnrichmentContext();
    const stats = { snapshots: { first: 0, cleared: 0, failed: 0 }, weather: { captured: 0, failed: 0 } };
    const carousels = new Map();
    for (const event of events ?? []) if (event?.fl511Cameras?.length) carousels.set(liveEventKey(event), event.fl511Cameras);
    const current = new Set([...(events ?? []).filter(Boolean).map(liveEventKey), ...(records ?? []).map(r => r.keyInSource)]);
    for (const key of [...memory.keys()]) if (!current.has(key)) memory.delete(key);

    const cameraFor = record => chooseSnapshotCamera({
      ...pointOf(record), direction: record.direction, fl511Cameras: carousels.get(record.keyInSource) ?? [], cameras: ctx.cameras,
    });
    const clearedCamera = (record, entry) => {
      const firstId = typedValue('snapshot_first_camera_id', record.snapshot_first_camera_id);
      const first = firstId && ctx.cameras.find(c => c.cameraId === firstId && c.divasChanId);
      if (first) return { cameraId: first.cameraId, divasChanId: first.divasChanId };
      if (firstId && entry.camera?.cameraId === firstId) return entry.camera;
      return entry.camera ?? cameraFor(record);
    };

    const tasks = (records ?? []).map(async record => {
      const entry = memory.get(record.keyInSource);
      // A value read back (or carried) from DataConnect is confirmed: its upload is no longer needed.
      if (entry && has(record, 'snapshot_first_url')) entry.first = null;
      // An active record has no clearing to photograph: an earlier one's upload is obsolete.
      if (entry && (has(record, 'snapshot_cleared_url') || record.status !== 'cleared')) entry.cleared = null;
      const jobs = [];
      if (wantsFirstSnapshot(record, now)) {
        jobs.push((async () => {
          const shot = await snapshot(record, 'first', () => cameraFor(record), now);
          if (!shot) { stats.snapshots.failed++; return; }
          applyCaptured(record, {
            snapshot_first_url: shot.url, snapshot_first_taken_at: shot.takenAt, snapshot_first_camera_id: shot.camera.cameraId,
            snapshot_archive_url: shot.url,
          });
          stats.snapshots.first++;
        })());
      }
      if (snapshotStore && record.status === 'cleared' && !has(record, 'snapshot_cleared_url')) {
        jobs.push((async () => {
          const shot = await snapshot(record, 'cleared', e => clearedCamera(record, e), now);
          if (!shot) { stats.snapshots.failed++; return; }
          applyCaptured(record, {
            snapshot_cleared_url: shot.url, snapshot_cleared_taken_at: shot.takenAt, snapshot_cleared_camera_id: shot.camera.cameraId,
          });
          stats.snapshots.cleared++;
        })());
      }
      if (wantsWeather(record, now)) {
        jobs.push((async () => {
          const weather = await limit(() => fetchEventWeather(pointOf(record), { fetchImpl, timeoutMs: WEATHER_TIMEOUT_MS }));
          if (!weather) { stats.weather.failed++; return; }
          applyCaptured(record, weather);
          stats.weather.captured++;
        })());
      }
      const results = await Promise.allSettled(jobs);
      for (const result of results) {
        if (result.status === 'rejected') {
          stats.snapshots.failed++;
          logger.warn?.(`live-dc: snapshot for ${record.keyInSource} not stored (${result.reason?.message ?? result.reason})`);
        }
      }
    });
    await Promise.all(tasks);
    return stats;
  }

  /** A record the cycle would not load but whose first-sight capture is still missing and due. */
  capture.needsCapture = (record, now) => wantsFirstSnapshot(record, now) || wantsWeather(record, now);
  capture.remembered = () => [...memory.keys()];
  return capture;
}
