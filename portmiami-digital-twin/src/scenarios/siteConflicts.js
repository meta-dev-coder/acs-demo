/**
 * Does the proposed garage run into anything already on the map?
 *
 * WHAT THIS IS. A geometric overlap test between the proposed footprint and the layers this twin
 * actually holds: county building footprints and county road centrelines. It is a prompt to go
 * and look, nothing more.
 *
 * WHAT THIS IS NOT. It is not a constructability check. Finding no overlap does NOT mean a garage
 * can be built there: this twin holds no parcel boundaries, no ownership, no zoning, no easements,
 * no utilities, no setbacks, no environmental designations and no water layer. Those are reported
 * as NOT_EVALUATED, which is a different statement from "clear" and is kept visibly different in
 * the panel. A layer that has not loaded is also NOT_EVALUATED rather than silently clear — the
 * one failure mode this module exists to avoid is an empty result reading as a green light.
 *
 * Centrelines, not carriageways. The road file publishes a line down the middle of each segment
 * and no width, so a proposed footprint can cover a kerb or a verge without crossing a centreline
 * at all. The overlap test therefore uses a stated clearance either side of the line, and the
 * result says it is a centreline test.
 */
import { lonLatToEnu } from './garagePlacement.js';

/*
 * The predicates below are exported so the Design Alternatives module can reuse them. They are
 * the same tests, on the same metric-plane convention: callers project both shapes into one
 * local ENU frame first, because an overlap test on raw degrees is a test on a stretched plane.
 */

export const CONFLICT_STATUS = Object.freeze({
  CONFLICT: 'CONFLICT',
  CLEAR: 'CLEAR',
  NOT_EVALUATED: 'NOT_EVALUATED',
});

export const CONFLICT_SEVERITY = Object.freeze({
  WARNING: 'WARNING',
  INFO: 'INFO',
});

/**
 * Half-width assumed either side of a road centreline, in metres.
 *
 * ASSUMED. The county centreline file carries no carriageway width, lane count or right-of-way,
 * so a two-lane port road with shoulders is taken as about 12 m wide overall. It is here as a
 * named constant so a reviewer can see what the overlap test actually tested.
 */
export const ROAD_CLEARANCE_M = 6;

/** Segment-against-segment intersection in a plane. */
export function segmentsCross([ax, ay], [bx, by], [cx, cy], [dx, dy]) {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Even-odd point-in-ring, in a plane. */
export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The shortest distance from a point to a segment, in a plane. */
export function distanceToSegment([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0
    : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Two rings overlap if an edge crosses an edge or either contains the other.
 *
 * Both are projected into the SAME local metric frame first — the proposed footprint's own ENU
 * frame — because an overlap test on raw degrees is a test on a stretched plane, and at this
 * latitude a degree of longitude is about a tenth shorter than a degree of latitude.
 */
export function ringsOverlap(a, b) {
  for (let i = 0; i < a.length - 1; i += 1) {
    for (let j = 0; j < b.length - 1; j += 1) {
      if (segmentsCross(a[i], a[i + 1], b[j], b[j + 1])) return true;
    }
  }
  // Containment is probed with an INTERIOR point, not a vertex. Two identical rings — a
  // copy-pasted footprint, say — have no strictly crossing edges, and every vertex of one lies
  // exactly on the boundary of the other, where even-odd containment is a coin toss. A centroid
  // is unambiguous for the convex shapes this module deals in.
  return pointInRing(centroidOf(a), b) || pointInRing(centroidOf(b), a);
}

/** The mean of a ring's distinct vertices. */
function centroidOf(ring) {
  const points = ring.slice(0, Math.max(1, ring.length - 1));
  const sum = points.reduce((total, [x, y]) => [total[0] + x, total[1] + y], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

/** Does a polyline come within `clearance` of a ring, or run through it? */
export function lineNearRing(line, ring, clearance) {
  for (const point of line) if (pointInRing(point, ring)) return true;
  for (let i = 0; i < line.length - 1; i += 1) {
    for (let j = 0; j < ring.length - 1; j += 1) {
      if (segmentsCross(line[i], line[i + 1], ring[j], ring[j + 1])) return true;
    }
    for (const corner of ring) {
      if (distanceToSegment(corner, line[i], line[i + 1]) <= clearance) return true;
    }
  }
  return false;
}

/**
 * Every outer ring a building contributes.
 *
 * Takes either the app's own building record (`rings`, as `useBuildings` builds them) or a raw
 * GeoJSON feature, because the conflict check is called from the planner with the former and
 * from tests and any future caller with the latter. A hole is not an outer ring and is skipped:
 * a courtyard is not a place the footprint can safely sit.
 */
const outerRings = building => {
  if (Array.isArray(building?.rings)) {
    // `rings` is flat: every ring of every part. Only the ones that are not holes matter, and
    // the model does not mark them, so all are tested — a false positive here is a warning to
    // look at, which is the right way for this check to be wrong.
    return building.rings.filter(ring => Array.isArray(ring) && ring.length >= 4);
  }
  const geometry = building?.geometry;
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates[0]];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(part => part[0]);
  return [];
};

const buildingId = building => building?.objectId ?? building?.properties?.OBJECTID ?? null;

const result = (id, label, status, detail, severity = CONFLICT_SEVERITY.WARNING,
  hits = []) => ({ id, label, status, detail, severity, hits });

/**
 * Check one proposed footprint.
 *
 * @param {Array} ring              the proposed footprint, closed, as [lon, lat]
 * @param {object} layers
 * @param {Array|null} layers.buildings   county footprint features, or null if not loaded
 * @param {Array|null} layers.roads       road segments with `coordinates`, or null if not loaded
 * @param {string|null} layers.excludeAssetId  not used today; reserved for a scenario that
 *                                             proposes a replacement on an asset's own site
 * @returns {{checks: Array, conflicts: number, evaluated: number}}
 */
export function checkSiteConflicts(ring, { buildings = null, roads = null } = {}) {
  const checks = [];
  if (!ring?.length) {
    return { checks: [result('placement', 'Proposed footprint', CONFLICT_STATUS.NOT_EVALUATED,
      'No placement has been made yet.')], conflicts: 0, evaluated: 0 };
  }

  // Everything is compared in metres in the footprint's own frame.
  const origin = ring[0];
  const toLocal = point => lonLatToEnu(origin, point);
  const local = ring.map(toLocal);
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [x, y] of local) {
    west = Math.min(west, x); east = Math.max(east, x);
    south = Math.min(south, y); north = Math.max(north, y);
  }
  // A generous box: anything whose own box misses this one cannot touch the footprint, and
  // skipping it keeps the check cheap enough to run on every edit. It is a box-against-box test,
  // not "does any vertex fall inside" — a long road or a large building can straddle the
  // footprint with every one of its vertices far outside it.
  const pad = ROAD_CLEARANCE_M + 20;
  const boxOverlaps = points => {
    let w = Infinity, s2 = Infinity, e = -Infinity, n = -Infinity;
    for (const [x, y] of points) {
      w = Math.min(w, x); e = Math.max(e, x); s2 = Math.min(s2, y); n = Math.max(n, y);
    }
    return e >= west - pad && w <= east + pad && n >= south - pad && s2 <= north + pad;
  };

  // A degree box around the footprint, generous enough that nothing near it is skipped.
  const ringLons = ring.map(([lon]) => lon), ringLats = ring.map(([, lat]) => lat);
  const degPad = 0.004;   // roughly 400 m, far beyond anything this check can reach
  const lonMin = Math.min(...ringLons) - degPad, lonMax = Math.max(...ringLons) + degPad;
  const latMin = Math.min(...ringLats) - degPad, latMax = Math.max(...ringLats) + degPad;
  const boundsCouldReach = b =>
    b.east >= lonMin && b.west <= lonMax && b.north >= latMin && b.south <= latMax;

  if (!Array.isArray(buildings)) {
    checks.push(result('buildings', 'Existing buildings', CONFLICT_STATUS.NOT_EVALUATED,
      'The county building-footprint layer has not loaded, so no overlap could be tested.'));
  } else {
    const hits = [];
    for (const feature of buildings) {
      // The model already carries a lon/lat bounding box; use it to skip the far-away ones
      // before converting a single coordinate.
      if (feature.bounds && !boundsCouldReach(feature.bounds)) continue;
      for (const outer of outerRings(feature)) {
        const other = outer.map(toLocal);
        if (!boxOverlaps(other)) continue;
        if (ringsOverlap(local, other)) { hits.push(buildingId(feature)); break; }
      }
    }
    checks.push(hits.length
      ? result('buildings', 'Existing buildings', CONFLICT_STATUS.CONFLICT,
        `The proposed footprint intersects ${hits.length} existing building footprint`
        + `${hits.length === 1 ? '' : 's'} (OBJECTID ${hits.slice(0, 6).join(', ')}`
        + `${hits.length > 6 ? ', …' : ''}).`, CONFLICT_SEVERITY.WARNING, hits)
      : result('buildings', 'Existing buildings', CONFLICT_STATUS.CLEAR,
        'No county building footprint overlaps the proposed footprint.'));
  }

  if (!Array.isArray(roads)) {
    checks.push(result('roads', 'Mapped roads', CONFLICT_STATUS.NOT_EVALUATED,
      'The county road-centreline layer has not loaded, so no overlap could be tested.'));
  } else {
    const hits = [];
    for (const segment of roads) {
      const line = (segment.coordinates ?? []).map(toLocal);
      if (line.length < 2 || !boxOverlaps(line)) continue;
      if (lineNearRing(line, local, ROAD_CLEARANCE_M)) {
        hits.push(segment.name || `Unnamed road · ${segment.objectId}`);
      }
    }
    const unique = [...new Set(hits)];
    checks.push(unique.length
      ? result('roads', 'Mapped roads', CONFLICT_STATUS.CONFLICT,
        `The proposed footprint overlaps ${unique.length} mapped road centreline`
        + `${unique.length === 1 ? '' : 's'} within ${ROAD_CLEARANCE_M} m `
        + `(${unique.slice(0, 4).join(', ')}${unique.length > 4 ? ', …' : ''}). `
        + 'The file publishes no carriageway width, so this is a centreline test against an '
        + 'assumed clearance, not a right-of-way check.', CONFLICT_SEVERITY.WARNING, unique)
      : result('roads', 'Mapped roads', CONFLICT_STATUS.CLEAR,
        `No mapped road centreline comes within ${ROAD_CLEARANCE_M} m of the proposed footprint. `
        + 'Carriageway width is not published, so a kerb or verge could still be affected.'));
  }

  // The things this twin simply does not hold. Stated, never inferred from their absence.
  for (const [id, label, detail] of [
    ['boundaries', 'Site boundaries', 'Not evaluated. This twin holds no parcel boundaries, so '
      + 'whether the footprint sits inside a developable site is unknown.'],
    ['water', 'Water and shoreline', 'Not evaluated. No shoreline or water-body layer is loaded, '
      + 'so a footprint over the basin would not be caught here.'],
    ['utilities', 'Utility clearance', 'Not evaluated. No utility network is loaded.'],
    ['tenure', 'Ownership and zoning', 'Not assessed. No ownership, zoning or easement data is '
      + 'available to this twin.'],
  ]) {
    checks.push(result(id, label, CONFLICT_STATUS.NOT_EVALUATED, detail, CONFLICT_SEVERITY.INFO));
  }

  return {
    checks,
    conflicts: checks.filter(check => check.status === CONFLICT_STATUS.CONFLICT).length,
    evaluated: checks.filter(check => check.status !== CONFLICT_STATUS.NOT_EVALUATED).length,
  };
}
