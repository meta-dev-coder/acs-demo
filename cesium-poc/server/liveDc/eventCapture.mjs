/**
 * Captures, once per Live Event, a camera snapshot when it is first seen and when it clears, and the
 * weather at first sight. Runs on the records a cycle is about to load and fills their columns in
 * place. Sticky: a record that already holds a value (read back from DataConnect and carried forward
 * by eventSync) is never recaptured. Failures leave the columns unset and never fail the cycle.
 */
import { applyCaptured, loadEnrichmentContext, typedValue } from './eventEnrichment.mjs';
import { liveEventKey } from './eventSync.mjs';
import { chooseSnapshotCamera, fetchDivasSnapshot, snapshotKey, SNAPSHOT_TIMEOUT_MS } from './eventSnapshots.mjs';
import { fetchEventWeather, WEATHER_TIMEOUT_MS } from './eventWeather.mjs';

export const FIRST_CAPTURE_MAX_AGE_MS = 3600_000;
const STORE_TIMEOUT_MS = 15_000;

const has = (record, name) => typedValue(name, record[name]) !== null;
const numberOr = value => (value === '' || value == null ? NaN : Number(value));
const pointOf = record => ({
  longitude: numberOr(record.longitude ?? record.x_coordinates), latitude: numberOr(record.latitude ?? record.y_coordinates),
});
const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout')), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

/**
 * @param {{snapshotStore?: {put: Function, url: Function}|null, fetchImpl?: typeof fetch, context?: object,
 *   timeoutMs?: number, maxFirstCaptureAgeMs?: number, logger?: object}} options
 * @returns {(input: {records: object[], events?: object[], now: number}) => Promise<object>} capture
 */
export function createEventCapture({
  snapshotStore = null, fetchImpl = fetch, context = null, timeoutMs = SNAPSHOT_TIMEOUT_MS,
  maxFirstCaptureAgeMs = FIRST_CAPTURE_MAX_AGE_MS, logger = console,
} = {}) {
  // Carousel camera choice per event, remembered so the clearing snapshot (the event is gone from
  // the feed by then) can use the camera FL511 listed.
  const chosen = new Map();

  async function snapshot(record, camera, at) {
    const bytes = await fetchDivasSnapshot(camera.divasChanId, { fetchImpl, timeoutMs });
    if (!bytes) return null;
    const key = snapshotKey(record.keyInSource, at, camera.cameraId);
    await withTimeout(snapshotStore.put(key, bytes, 'image/jpeg'), STORE_TIMEOUT_MS);
    return { url: snapshotStore.url(key), takenAt: at, cameraId: camera.cameraId };
  }

  return async function capture({ records, events = [], now }) {
    const ctx = context ?? loadEnrichmentContext();
    const stats = { snapshots: { first: 0, cleared: 0, failed: 0 }, weather: { captured: 0, failed: 0 } };
    const carousels = new Map();
    for (const event of events ?? []) {
      if (!event?.fl511Cameras?.length) continue;
      const key = liveEventKey(event);
      carousels.set(key, event.fl511Cameras);
      const choice = chooseSnapshotCamera({
        longitude: event.longitude, latitude: event.latitude, fl511Cameras: event.fl511Cameras, cameras: ctx.cameras,
      });
      if (choice?.source === 'FL511') chosen.set(key, choice);
    }

    const cameraFor = record => {
      const point = pointOf(record);
      return chooseSnapshotCamera({
        ...point, direction: record.direction, fl511Cameras: carousels.get(record.keyInSource) ?? [], cameras: ctx.cameras,
      });
    };
    const clearedCamera = record => {
      const remembered = chosen.get(record.keyInSource);
      if (remembered) return remembered;
      const firstId = typedValue('snapshot_first_camera_id', record.snapshot_first_camera_id);
      const first = firstId && ctx.cameras.find(c => c.cameraId === firstId && c.divasChanId);
      return first ? { cameraId: first.cameraId, divasChanId: first.divasChanId } : cameraFor(record);
    };

    const tasks = (records ?? []).map(async record => {
      const firstSeen = Date.parse(record.first_seen_at ?? '');
      const young = record.status === 'active' && Number.isFinite(firstSeen) && now - firstSeen <= maxFirstCaptureAgeMs;
      const jobs = [];
      if (snapshotStore && young && !has(record, 'snapshot_first_url')) {
        jobs.push((async () => {
          const camera = cameraFor(record);
          const shot = camera && await snapshot(record, camera, now);
          if (!shot) { stats.snapshots.failed++; return; }
          applyCaptured(record, {
            snapshot_first_url: shot.url, snapshot_first_taken_at: shot.takenAt, snapshot_first_camera_id: shot.cameraId,
            snapshot_archive_url: shot.url,
          });
          stats.snapshots.first++;
        })());
      }
      if (snapshotStore && record.status === 'cleared' && !has(record, 'snapshot_cleared_url')) {
        jobs.push((async () => {
          const camera = clearedCamera(record);
          const shot = camera && await snapshot(record, camera, now);
          chosen.delete(record.keyInSource);
          if (!shot) { stats.snapshots.failed++; return; }
          applyCaptured(record, {
            snapshot_cleared_url: shot.url, snapshot_cleared_taken_at: shot.takenAt, snapshot_cleared_camera_id: shot.cameraId,
          });
          stats.snapshots.cleared++;
        })());
      }
      if (young && !has(record, 'weather_source')) {
        jobs.push((async () => {
          const weather = await fetchEventWeather(pointOf(record), { fetchImpl, timeoutMs: WEATHER_TIMEOUT_MS });
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
  };
}
