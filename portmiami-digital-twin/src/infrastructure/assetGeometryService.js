/**
 * The one way the browser reads or writes asset geometry.
 *
 * The SERVER is authoritative. Before this, geometry lived in `localStorage`, which meant a
 * footprint traced in one browser did not exist in any other — the failure that made a traced
 * Garage A invisible everywhere except the tab it was drawn in. Nothing here reads localStorage
 * as a source of truth; the legacy store survives only so it can be offered for import once.
 *
 * Every consumer — the planner, the highlight, the massing, the details panel, Ask the Twin —
 * goes through this service and the resolver beside it, so there is one answer to "what is this
 * garage's footprint?" and one place that can be wrong.
 *
 * A small cache keeps a selection change from re-fetching, and every write invalidates it. The
 * cached copy carries the server's `updatedAt`, so a stale frontend value can be recognised
 * rather than silently drawn.
 */
import { GEOMETRY_API } from '../config/liveTraffic.js';

/** The states a consumer can be in. Each one is shown, never collapsed into "no geometry". */
export const GEOMETRY_STATE = Object.freeze({
  IDLE: 'IDLE',
  LOADING: 'LOADING',
  LOADED: 'LOADED',
  EMPTY: 'EMPTY',
  FAILED: 'FAILED',
});

const cache = new Map();

const url = (assetId, geometryId) => (geometryId
  ? `${GEOMETRY_API.base}/${encodeURIComponent(assetId)}/geometry/${encodeURIComponent(geometryId)}`
  : `${GEOMETRY_API.base}/${encodeURIComponent(assetId)}/geometry`);

/** No credential: the server decides whether this machine may write. */
const writeHeaders = () => ({ 'content-type': 'application/json' });

/** Drop the cached copy for an asset, or all of them. */
export const invalidate = assetId => (assetId ? cache.delete(assetId) : cache.clear());

/**
 * Everything stored for one asset, plus the row the app should draw.
 * @returns {Promise<{ok: boolean, geometries: Array, active: object|null, writable: boolean, reason?: string}>}
 */
export async function getGeometry(assetId, { force = false } = {}) {
  if (!assetId) return { ok: true, geometries: [], active: null, writable: false };
  if (!force && cache.has(assetId)) return cache.get(assetId);
  try {
    const response = await fetch(url(assetId), { headers: { accept: 'application/json' } });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) {
      // A failure is reported as a failure. It never becomes "this asset has no geometry",
      // because the app would then quietly fall back to an unconfirmed candidate.
      return { ok: false, geometries: [], active: null, writable: false,
        reason: payload?.reason ?? `The geometry service answered ${response.status}.` };
    }
    const result = {
      ok: true,
      geometries: payload.geometries ?? [],
      active: payload.active ?? null,
      writable: Boolean(payload.writable),
      readOnlyReason: payload.readOnlyReason ?? null,
    };
    cache.set(assetId, result);
    return result;
  } catch (error) {
    return { ok: false, geometries: [], active: null, writable: false,
      reason: `The geometry service could not be reached (${error.message}).` };
  }
}

/** Store a geometry against an asset. */
export async function saveGeometry(assetId, geometry, metadata = {}) {
  try {
    const response = await fetch(url(assetId), {
      method: 'POST',
      headers: writeHeaders(),
      body: JSON.stringify({
        geometry,
        geometrySource: metadata.geometrySource ?? 'MANUALLY_DIGITIZED',
        verificationStatus: metadata.verificationStatus ?? 'USER_CONFIRMED',
        heightM: metadata.heightM ?? null,
        heightSource: metadata.heightSource ?? null,
        buildingObjectIds: metadata.buildingObjectIds ?? [],
        sourceReference: metadata.sourceReference ?? null,
      }),
    });
    const payload = await response.json();
    invalidate(assetId);
    return response.ok && payload?.ok
      ? { ok: true, geometry: payload.geometry }
      : { ok: false, reason: payload?.reason ?? `The geometry service answered ${response.status}.` };
  } catch (error) {
    return { ok: false, reason: `The geometry service could not be reached (${error.message}).` };
  }
}

export async function updateGeometry(assetId, geometryId, updates) {
  try {
    const response = await fetch(url(assetId, geometryId), {
      method: 'PUT', headers: writeHeaders(), body: JSON.stringify(updates),
    });
    const payload = await response.json();
    invalidate(assetId);
    return response.ok && payload?.ok
      ? { ok: true, geometry: payload.geometry }
      : { ok: false, reason: payload?.reason ?? `The geometry service answered ${response.status}.` };
  } catch (error) {
    return { ok: false, reason: `The geometry service could not be reached (${error.message}).` };
  }
}

export async function deleteGeometry(assetId, geometryId) {
  try {
    const response = await fetch(url(assetId, geometryId), { method: 'DELETE', headers: writeHeaders() });
    const payload = await response.json();
    invalidate(assetId);
    return response.ok && payload?.ok
      ? { ok: true }
      : { ok: false, reason: payload?.reason ?? `The geometry service answered ${response.status}.` };
  } catch (error) {
    return { ok: false, reason: `The geometry service could not be reached (${error.message}).` };
  }
}
