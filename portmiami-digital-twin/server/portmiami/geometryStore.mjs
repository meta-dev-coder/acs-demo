/**
 * Server-side storage for asset geometry.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY A JSON FILE, AND NOT A DATABASE
 *
 * This project has no database. Its dependencies are cesium, react and react-dom; there is no
 * driver, no ORM and no migration tool, and the server is a framework-free node:http proxy that
 * until now was entirely read-only. Introducing PostgreSQL — or SQLite — to hold a handful of
 * polygons would add an installation step, a migration story and a backup story to an application
 * that is otherwise a static bundle plus one small process.
 *
 * So geometry is kept the way everything else in this project is kept: as JSON, written
 * atomically (temp file + rename, so a crash mid-write cannot truncate the store) and read back
 * on demand. The shape below is deliberately the shape a table would have, so moving to a real
 * database later is a port of this one file rather than a redesign.
 *
 * WHAT THIS IS NOT: it is not multi-writer safe across processes. One host writing one file is
 * the deployment this matches. A second writer needs the database this is standing in for.
 * ---------------------------------------------------------------------------------------------
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INFRASTRUCTURE_ASSETS } from '../../src/config/infrastructure.js';

export const SCHEMA_VERSION = 1;

/**
 * Where the store lives.
 *
 * The default sits inside the checkout (`server/data/asset-geometry.json`), which is right for a
 * local demonstration and WRONG for most production deployments: a container image, a read-only
 * filesystem or a fresh build directory would lose it. Set `PORTMIAMI_GEOMETRY_FILE` to a path on
 * a persistent volume before deploying, and back that file up — it is the only copy of any
 * geometry a reviewer has drawn.
 */
export const DEFAULT_STORE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)), '../data/asset-geometry.json');

export const storePathFrom = (env = process.env) =>
  ((env.PORTMIAMI_GEOMETRY_FILE ?? '').trim() || DEFAULT_STORE_PATH);

/** Where a geometry came from. */
export const GEOMETRY_SOURCE = Object.freeze({
  OFFICIAL_GIS: 'OFFICIAL_GIS',
  BUILDING_GEOJSON: 'BUILDING_GEOJSON',
  MANUALLY_DIGITIZED: 'MANUALLY_DIGITIZED',
});

/**
 * How firmly it is established. These are three different claims and the code keeps them apart:
 * a reviewer confirming a traced outline makes it USER_CONFIRMED, never AUTHORITATIVE.
 */
export const VERIFICATION_STATUS = Object.freeze({
  CANDIDATE: 'CANDIDATE',
  USER_CONFIRMED: 'USER_CONFIRMED',
  AUTHORITATIVE: 'AUTHORITATIVE',
});

/** A sane polygon for a port facility. Outside this, something has gone wrong upstream. */
export const MIN_AREA_M2 = 50;
export const MAX_AREA_M2 = 500_000;
/** The study area, generously padded. A polygon outside it is not a PortMiami footprint. */
const BOUNDS = Object.freeze({ west: -80.35, south: 25.65, east: -80.05, north: 25.90 });

const ASSET_IDS = new Set(INFRASTRUCTURE_ASSETS.map(asset => asset.id));

// ---- geometry validation ------------------------------------------------------------------

const ringsOf = geometry => (geometry?.type === 'Polygon'
  ? (geometry.coordinates ?? [])
  : (geometry?.coordinates ?? []).flat());

/** Shoelace area in m², via a local equirectangular frame. Holes subtract. */
export function geometryAreaM2(geometry) {
  const parts = geometry?.type === 'Polygon' ? [geometry.coordinates] : (geometry?.coordinates ?? []);
  const first = parts?.[0]?.[0]?.[0];
  if (!first) return 0;
  const mPerLon = Math.cos((first[1] * Math.PI) / 180) * 111320;
  const mPerLat = 110540;
  let total = 0;
  for (const part of parts) {
    (part ?? []).forEach((ring, index) => {
      let twice = 0;
      for (let i = 0; i < ring.length - 1; i += 1) {
        twice += (ring[i][0] * mPerLon) * (ring[i + 1][1] * mPerLat)
          - (ring[i + 1][0] * mPerLon) * (ring[i][1] * mPerLat);
      }
      const area = Math.abs(twice) / 2;
      total += index === 0 ? area : -area;
    });
  }
  return total;
}

/** Do segments ab and cd cross? Shared endpoints do not count. */
function crosses([ax, ay], [bx, by], [cx, cy], [dx, dy]) {
  const side = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  const d1 = side(ax, ay, bx, by, cx, cy), d2 = side(ax, ay, bx, by, dx, dy);
  const d3 = side(cx, cy, dx, dy, ax, ay), d4 = side(cx, cy, dx, dy, bx, by);
  return d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}

/** Does a ring cross itself? O(n²), which is nothing at a footprint's vertex count. */
export function selfIntersects(ring) {
  for (let i = 0; i < ring.length - 1; i += 1) {
    for (let j = i + 2; j < ring.length - 1; j += 1) {
      // Adjacent segments share an endpoint, and the first and last close the ring.
      if (i === 0 && j === ring.length - 2) continue;
      if (crosses(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
    }
  }
  return false;
}

/**
 * Validate a GeoJSON geometry for storage.
 * @returns {{ok: true, areaM2: number}|{ok: false, reason: string}}
 */
export function validateGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object') return { ok: false, reason: 'No geometry supplied.' };
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
    return { ok: false, reason: `Unsupported geometry type ${JSON.stringify(geometry.type)}; Polygon or MultiPolygon only.` };
  }
  const rings = ringsOf(geometry);
  if (rings.length === 0) return { ok: false, reason: 'The geometry has no rings.' };

  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 4) {
      return { ok: false, reason: 'A ring needs at least three corners and a closing point.' };
    }
    for (const position of ring) {
      if (!Array.isArray(position) || position.length < 2
        || !Number.isFinite(position[0]) || !Number.isFinite(position[1])) {
        return { ok: false, reason: 'A coordinate is not a finite [longitude, latitude] pair.' };
      }
      const [lon, lat] = position;
      if (Math.abs(lon) > 180 || Math.abs(lat) > 90) {
        return { ok: false, reason: `Coordinate ${lon}, ${lat} is out of range.` };
      }
      // Longitude/latitude order: a PortMiami footprint has a negative longitude near -80 and a
      // positive latitude near 25. Swapped pairs land outside the box below and are refused.
      if (lon < BOUNDS.west || lon > BOUNDS.east || lat < BOUNDS.south || lat > BOUNDS.north) {
        return {
          ok: false,
          reason: `Coordinate ${lon}, ${lat} is outside the PortMiami study area. `
            + 'Check the longitude/latitude order.',
        };
      }
    }
    const [first] = ring;
    const last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      return { ok: false, reason: 'A ring must be closed: its last position must equal its first.' };
    }
    if (selfIntersects(ring)) return { ok: false, reason: 'The outline crosses itself.' };
  }

  const areaM2 = geometryAreaM2(geometry);
  if (!(areaM2 >= MIN_AREA_M2)) {
    return { ok: false, reason: `The outline encloses ${Math.round(areaM2)} m², under the ${MIN_AREA_M2} m² minimum.` };
  }
  if (areaM2 > MAX_AREA_M2) {
    return { ok: false, reason: `The outline encloses ${Math.round(areaM2)} m², over the ${MAX_AREA_M2} m² maximum.` };
  }
  return { ok: true, areaM2 };
}

export const assetExists = assetId => ASSET_IDS.has(assetId);

// ---- the store ----------------------------------------------------------------------------

const empty = () => ({ version: SCHEMA_VERSION, geometries: [] });

export function createGeometryStore({
  path = storePathFrom(), now = () => new Date().toISOString(),
} = {}) {
  /** Serialises writes within this process; see the file header on the multi-writer limit. */
  let queue = Promise.resolve();

  async function read() {
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== SCHEMA_VERSION) return empty();
      return { version: SCHEMA_VERSION, geometries: Array.isArray(parsed.geometries) ? parsed.geometries : [] };
    } catch (error) {
      if (error.code === 'ENOENT') return empty();
      throw error;
    }
  }

  /** Temp file then rename, so a crash mid-write cannot leave a truncated store behind. */
  async function write(state) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  }

  const serialise = task => {
    const next = queue.then(task, task);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };

  return {
    /** The resolved path, so the host can log it and an operator can find the file. */
    path,

    /** Can this process actually write there? Checked once, reported rather than discovered later. */
    async writable() {
      try {
        await mkdir(dirname(path), { recursive: true });
        const probe = `${path}.${process.pid}.probe`;
        await writeFile(probe, '{}', 'utf8');
        await rename(probe, probe);
        const { unlink } = await import('node:fs/promises');
        await unlink(probe);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error.message };
      }
    },

    /** Every geometry recorded for one asset, newest first. */
    async list(assetId) {
      const state = await read();
      return state.geometries
        .filter(row => row.assetId === assetId)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },

    async get(assetId, geometryId) {
      const state = await read();
      return state.geometries.find(row => row.assetId === assetId && row.id === geometryId) ?? null;
    },

    /**
     * Record a geometry. Replaces this asset's previous row of the same source, so tracing twice
     * updates rather than accumulating, while a GIS row and a traced row can coexist.
     */
    async save(assetId, { geometry, geometrySource, verificationStatus, heightM = null,
      heightSource = null, buildingObjectIds = [], sourceReference = null }) {
      return serialise(async () => {
        const state = await read();
        const timestamp = now();
        const previous = state.geometries.find(
          row => row.assetId === assetId && row.geometrySource === geometrySource);
        const row = {
          id: previous?.id ?? `geom-${assetId}-${geometrySource}-${timestamp}`,
          assetId,
          geometryType: geometry.type,
          geometry,
          geometrySource,
          verificationStatus,
          areaM2: Math.round(geometryAreaM2(geometry)),
          heightM,
          heightSource,
          buildingObjectIds,
          sourceReference,
          createdAt: previous?.createdAt ?? timestamp,
          updatedAt: timestamp,
        };
        await write({
          version: SCHEMA_VERSION,
          geometries: [...state.geometries.filter(r => r.id !== row.id), row],
        });
        return row;
      });
    },

    /** Update a stored row. Geometry, status, height and source metadata only. */
    async update(assetId, geometryId, updates) {
      return serialise(async () => {
        const state = await read();
        const row = state.geometries.find(r => r.assetId === assetId && r.id === geometryId);
        if (!row) return null;
        const next = {
          ...row,
          ...(updates.geometry ? { geometry: updates.geometry, geometryType: updates.geometry.type, areaM2: Math.round(geometryAreaM2(updates.geometry)) } : {}),
          ...(updates.verificationStatus ? { verificationStatus: updates.verificationStatus } : {}),
          ...(updates.heightM !== undefined ? { heightM: updates.heightM } : {}),
          ...(updates.heightSource !== undefined ? { heightSource: updates.heightSource } : {}),
          ...(updates.buildingObjectIds ? { buildingObjectIds: updates.buildingObjectIds } : {}),
          ...(updates.sourceReference !== undefined ? { sourceReference: updates.sourceReference } : {}),
          updatedAt: now(),
        };
        await write({
          version: SCHEMA_VERSION,
          geometries: state.geometries.map(r => (r.id === next.id ? next : r)),
        });
        return next;
      });
    },

    /**
     * Remove a user-defined row.
     *
     * An AUTHORITATIVE record is refused: those stand for official GIS, and deleting one through
     * a demo endpoint is not a thing this should make easy.
     */
    async remove(assetId, geometryId) {
      return serialise(async () => {
        const state = await read();
        const row = state.geometries.find(r => r.assetId === assetId && r.id === geometryId);
        if (!row) return { ok: false, reason: 'NOT_FOUND' };
        if (row.verificationStatus === VERIFICATION_STATUS.AUTHORITATIVE) {
          return { ok: false, reason: 'PROTECTED' };
        }
        await write({
          version: SCHEMA_VERSION,
          geometries: state.geometries.filter(r => r.id !== row.id),
        });
        return { ok: true, removed: row };
      });
    },
  };
}
