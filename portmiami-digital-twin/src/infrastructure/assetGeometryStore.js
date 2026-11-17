/**
 * Geometry a USER drew, kept apart from geometry the county published.
 *
 * The building extract does not contain a usable footprint for every asset. Around Garage A it is
 * worse than missing: the 2023 features there are fragments, and several of them lie over open
 * water and across a moored ship. No combination of them is the garage.
 *
 * So a reviewer can trace one. What they trace is stored HERE — never written into the building
 * GeoJSON, never given an OBJECTID, and never described as GIS data. It carries its own source
 * type so that every panel, label and export can say where the shape came from:
 *
 *   MANUALLY_DIGITIZED  someone traced it on the map. A user-defined shape, not a survey.
 *
 * Same storage architecture as the link store: localStorage, per browser, with every failure mode
 * returning an empty store rather than throwing.
 */

export const STORAGE_KEY = 'portmiami.infrastructure.geometry.v1';
export const SCHEMA_VERSION = 1;

export const GEOMETRY_SOURCE = Object.freeze({
  MANUALLY_DIGITIZED: 'MANUALLY_DIGITIZED',
});

/** What a traced shape is allowed to claim about itself. Never "VERIFIED". */
export const GEOMETRY_STATUS = Object.freeze({
  USER_DEFINED: 'USER_DEFINED',
});

export const GEOMETRY_SOURCE_LABEL = Object.freeze({
  MANUALLY_DIGITIZED: 'Traced on the map by a reviewer — a user-defined shape, not a surveyed footprint',
});

const empty = () => ({ version: SCHEMA_VERSION, shapes: [] });

export function loadGeometry(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== SCHEMA_VERSION) return empty();
    return { version: SCHEMA_VERSION, shapes: Array.isArray(parsed.shapes) ? parsed.shapes : [] };
  } catch {
    return empty();
  }
}

export function saveGeometry(state, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, shapes: state.shapes ?? [] }));
    return true;
  } catch {
    return false;
  }
}

/** A ring is closed and has enough distinct points to be a polygon at all. */
export function closeRing(points) {
  const cleaned = (points ?? []).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (cleaned.length < 3) return null;
  const [first] = cleaned;
  const last = cleaned[cleaned.length - 1];
  return (first[0] === last[0] && first[1] === last[1]) ? cleaned : [...cleaned, first];
}

/** Area in square metres of a closed ring, by the shoelace formula in a local metre frame. */
export function ringAreaM2(ring) {
  if (!ring || ring.length < 4) return 0;
  const lat0 = ring[0][1];
  const mPerLon = Math.cos((lat0 * Math.PI) / 180) * 111320;
  const mPerLat = 110540;
  let twice = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = [ring[i][0] * mPerLon, ring[i][1] * mPerLat];
    const [x2, y2] = [ring[i + 1][0] * mPerLon, ring[i + 1][1] * mPerLat];
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}

/**
 * Record a traced shape for an asset, replacing any previous one for the same asset.
 * @returns {{state: object, shape: object}|{state: object, shape: null, reason: string}}
 */
export function putShape(state, { assetId, points, label = null, now = null }) {
  const ring = closeRing(points);
  if (!ring) return { state, shape: null, reason: 'A footprint needs at least three points.' };
  const areaM2 = ringAreaM2(ring);
  if (areaM2 <= 0) return { state, shape: null, reason: 'The traced shape has no area.' };

  const timestamp = now ?? new Date().toISOString();
  const previous = (state.shapes ?? []).find(shape => shape.assetId === assetId);
  const shape = {
    id: previous?.id ?? `shape-${assetId}-${timestamp}`,
    assetId,
    rings: [ring],
    areaM2,
    label,
    source: GEOMETRY_SOURCE.MANUALLY_DIGITIZED,
    verificationStatus: GEOMETRY_STATUS.USER_DEFINED,
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  return {
    state: { ...state, shapes: [...(state.shapes ?? []).filter(s => s.assetId !== assetId), shape] },
    shape,
  };
}

export const removeShape = (state, assetId) => ({
  ...state, shapes: (state.shapes ?? []).filter(shape => shape.assetId !== assetId),
});

export const shapeFor = (state, assetId) =>
  (state.shapes ?? []).find(shape => shape.assetId === assetId) ?? null;

/**
 * A traced shape in the shape a building record has, so the highlight and the massing can take it
 * without knowing where it came from. `objectId` is null — it has no OBJECTID, because it is not
 * in the county file.
 */
export function asFootprint(shape) {
  if (!shape?.rings?.length) return null;
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [lon, lat] of shape.rings[0]) {
    west = Math.min(west, lon); east = Math.max(east, lon);
    south = Math.min(south, lat); north = Math.max(north, lat);
  }
  return {
    objectId: null,
    shapeId: shape.id,
    rings: shape.rings,
    groundAreaM2: shape.areaM2,
    partCount: 1,
    geometryType: 'Polygon',
    bounds: { west, south, east, north },
    centroid: [(west + east) / 2, (south + north) / 2],
    source: shape.source,
    verificationStatus: shape.verificationStatus,
  };
}
