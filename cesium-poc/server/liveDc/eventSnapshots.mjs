/**
 * Camera snapshots for Live Events. DataConnect has no binary type, so the JPEG is stored in the
 * data bucket under snapshots/ (served by CloudFront's default behaviour) and only its URL goes into
 * DataConnect. A SnapshotStore is `{ put(key, bytes, contentType?): Promise<void>, url(key): string }`.
 */
import { spawn } from 'node:child_process';
import { haversineMeters } from '../geo.mjs';
import { selectCameras } from './eventEnrichment.mjs';
import { fetchWithTimeout } from './eventWeather.mjs';

export const DIVAS_SNAPSHOT_BASE = 'https://images-dis.divas.cloud/DGI';
export const SNAPSHOT_PREFIX = 'snapshots/';
export const SNAPSHOT_CONTENT_TYPE = 'image/jpeg';
export const SNAPSHOT_TIMEOUT_MS = 5_000;
export const CAROUSEL_MATCH_RADIUS_M = 300;

const CHAN_ID = /^\d{1,10}$/;
const EVENT_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** The DIVAS still the /api/i595/camera/:chanId/snapshot proxy serves; null for a malformed channel. */
export const divasSnapshotUrl = chanId => (CHAN_ID.test(String(chanId ?? '')) ? `${DIVAS_SNAPSHOT_BASE}/chan-${chanId}_h.jpg` : null);

/** 20260926T042607Z (UTC, whole seconds). */
export const compactUtc = ms => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/[-:]/g, '').replace('.000Z', 'Z');

/** snapshots/<eventKey>/<UTC compact ts>_<cameraId>.jpg */
export function snapshotKey(eventKey, atMs, cameraId) {
  if (!EVENT_KEY.test(String(eventKey ?? ''))) throw new Error(`invalid event key for a snapshot: '${eventKey}'`);
  const camera = String(cameraId ?? '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'camera';
  return `${SNAPSHOT_PREFIX}${eventKey}/${compactUtc(atMs)}_${camera}.jpg`;
}

/** The JPEG bytes of a DIVAS channel's current still, or null (never throws). */
export async function fetchDivasSnapshot(chanId, { fetchImpl = fetch, timeoutMs = SNAPSHOT_TIMEOUT_MS } = {}) {
  const url = divasSnapshotUrl(chanId);
  if (!url) return null;
  try {
    return await fetchWithTimeout(fetchImpl, url, { headers: { accept: 'image/jpeg' } }, timeoutMs, async response => {
      if (!response.ok || !/^image\//i.test(response.headers.get('content-type') ?? '')) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      return bytes.length > 0 ? bytes : null;
    });
  } catch {
    return null;
  }
}

/** The corridor camera an FL511 carousel camera is: same id, else same DIVAS channel, else nearest within 300 m. */
function corridorCameraFor(fl511Camera, cameras) {
  const byId = cameras.find(c => c.cameraId === String(fl511Camera.cameraId));
  if (byId) return byId;
  if (fl511Camera.divasChanId) {
    const byChan = cameras.find(c => c.divasChanId && c.divasChanId === String(fl511Camera.divasChanId));
    if (byChan) return byChan;
  }
  const { longitude, latitude } = fl511Camera;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  let best = null;
  for (const camera of cameras) {
    const distance = haversineMeters(longitude, latitude, camera.longitude, camera.latitude);
    if (distance <= CAROUSEL_MATCH_RADIUS_M && (!best || distance < best.distance)) best = { camera, distance };
  }
  return best?.camera ?? null;
}

/**
 * The camera to photograph an event with: the first camera FL511 lists in its tooltip carousel that is
 * one of our corridor cameras and has a DIVAS channel (ours, else the one in FL511's video URL);
 * otherwise the nearest corridor camera with a channel (same direction first, within 2000 m).
 * @returns {{cameraId: string, divasChanId: string, source: 'FL511'|'derived'} | null}
 */
export function chooseSnapshotCamera({ longitude, latitude, direction, fl511Cameras = [], cameras = [] } = {}) {
  for (const fl511Camera of fl511Cameras ?? []) {
    const match = corridorCameraFor(fl511Camera, cameras);
    const divasChanId = match?.divasChanId ?? fl511Camera.divasChanId ?? null;
    if (match && divasChanId) return { cameraId: match.cameraId, divasChanId: String(divasChanId), source: 'FL511' };
  }
  const nearest = selectCameras({ longitude, latitude, direction }, cameras.filter(c => c.divasChanId), { limit: 1 })[0];
  return nearest ? { cameraId: nearest.cameraId, divasChanId: nearest.divasChanId, source: 'derived' } : null;
}

const assertSnapshotKey = key => {
  if (typeof key !== 'string' || !key.startsWith(SNAPSHOT_PREFIX) || key.includes('..')) {
    throw new Error(`snapshot keys must be under ${SNAPSHOT_PREFIX}`);
  }
};

const publicUrl = publicBase => {
  const base = String(publicBase ?? '').replace(/\/+$/, '');
  return key => `${base}/${key}`;
};

/** Lambda: PutObject through the caller's S3 client (`send`) and command class, so this module has no SDK import. */
export function createS3SnapshotStore({ send, PutObjectCommand, bucket, publicBase }) {
  return {
    async put(key, bytes, contentType = SNAPSHOT_CONTENT_TYPE) {
      assertSnapshotKey(key);
      await send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }));
    },
    url: publicUrl(publicBase),
  };
}

/** Local sync: `aws s3 cp - s3://<bucket>/<key>` with the image on stdin, using the caller's AWS CLI credentials. */
export function createAwsCliSnapshotStore({ bucket, publicBase, spawnImpl = spawn, timeoutMs = 20_000 }) {
  return {
    put(key, bytes, contentType = SNAPSHOT_CONTENT_TYPE) {
      assertSnapshotKey(key);
      return new Promise((resolve, reject) => {
        const child = spawnImpl('aws', ['s3', 'cp', '-', `s3://${bucket}/${key}`, '--content-type', contentType, '--only-show-errors'],
          { stdio: ['pipe', 'ignore', 'pipe'] });
        let stderr = '';
        let settled = false;
        const finish = error => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error); else resolve();
        };
        const timer = setTimeout(() => { child.kill?.('SIGKILL'); finish(new Error('aws s3 cp timed out')); }, timeoutMs);
        child.stderr?.on?.('data', chunk => { stderr = (stderr + chunk).slice(-500); });
        child.on('error', error => finish(error));
        child.on('close', code => finish(code === 0 ? null : new Error(`aws s3 cp exit ${code}${stderr ? `: ${stderr.trim()}` : ''}`)));
        child.stdin.on?.('error', () => {});
        child.stdin.write(Buffer.from(bytes));
        child.stdin.end();
      });
    },
    url: publicUrl(publicBase),
  };
}

/** The local-sync store: only with LIVE_DC_SNAPSHOT_BUCKET and an https LIVE_DC_SNAPSHOT_PUBLIC_BASE; else null (columns stay "NA"). */
export function snapshotStoreFromEnv(env = process.env, { spawnImpl } = {}) {
  const bucket = String(env.LIVE_DC_SNAPSHOT_BUCKET ?? '').trim();
  const base = String(env.LIVE_DC_SNAPSHOT_PUBLIC_BASE ?? '').trim();
  if (!BUCKET.test(bucket) || !/^https:\/\/[^\s/?#]+/i.test(base)) return null;
  return createAwsCliSnapshotStore({ bucket, publicBase: base, ...(spawnImpl ? { spawnImpl } : {}) });
}
