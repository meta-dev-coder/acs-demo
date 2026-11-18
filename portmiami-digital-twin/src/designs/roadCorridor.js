/**
 * A proposed road as a SURFACE, not a line.
 *
 * A centreline and a width in metres become a corridor polygon: the two offset edges, joined at
 * each vertex, closed back on itself. Everything is computed in metres in a local East-North-Up
 * frame centred on the alignment and converted back through the WGS-84 ellipsoid — the same pair
 * `garagePlacement.js` uses and the same frame Cesium draws in. Offsetting a road by adding
 * degrees to its coordinates would make it wider north-south than east-west, by about a tenth at
 * this latitude, and the error grows with the road's length.
 *
 * WHAT THE SHAPE IS, AND IS NOT. The joins are mitred, with the mitre limited so a sharp turn
 * produces a bevel rather than a spike shooting off to infinity. That is enough for a conceptual
 * corridor seen from above. It is NOT a highway design: there are no transition curves, no
 * superelevation, no verges, no kerb returns and no intersection geometry, and the result is
 * labelled an indicative surface everywhere it is reported.
 */
import { enuToLonLat, lonLatToEnu } from '../scenarios/garagePlacement.js';

/** Past this, a mitred join is replaced by a bevel. 4 x the half-width is a common limit. */
export const MITRE_LIMIT = 4;

/** Vertices closer together than this are treated as one: a zero-length segment has no normal. */
export const MIN_SEGMENT_M = 0.25;

const finite = value => typeof value === 'number' && Number.isFinite(value);

/** A centreline cleaned of anything that cannot take part in the geometry. */
export function cleanCentreline(coordinates) {
  const points = (coordinates ?? []).filter(
    point => Array.isArray(point) && finite(point[0]) && finite(point[1]));
  if (points.length < 2) return points.length ? [points[0]] : [];
  const origin = points[0];
  const kept = [points[0]];
  for (const point of points.slice(1)) {
    const [east, north] = lonLatToEnu(origin, point);
    const [lastEast, lastNorth] = lonLatToEnu(origin, kept[kept.length - 1]);
    if (Math.hypot(east - lastEast, north - lastNorth) >= MIN_SEGMENT_M) kept.push(point);
  }
  return kept;
}

/** The centreline's ground length in metres, summed segment by segment. */
export function centrelineLengthM(coordinates) {
  const points = cleanCentreline(coordinates);
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const [east, north] = lonLatToEnu(points[i - 1], points[i]);
    total += Math.hypot(east, north);
  }
  return total;
}

/**
 * The corridor polygon for a centreline of a given width.
 *
 * Returns a closed ring of [lon, lat], or null when the alignment cannot make one. Null rather
 * than an empty or degenerate polygon: a caller that draws "nothing" is correct, and one that
 * draws a sliver is a lie about where the road is.
 */
export function roadCorridorRing(coordinates, widthM) {
  const points = cleanCentreline(coordinates);
  if (points.length < 2 || !finite(widthM) || widthM <= 0) return null;

  // One frame for the whole road, anchored on its first point.
  const origin = points[0];
  const local = points.map(point => lonLatToEnu(origin, point));
  const half = widthM / 2;

  /** The unit normal, 90 degrees left of the direction of travel. */
  const normalOf = (from, to) => {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const length = Math.hypot(dx, dy) || 1;
    return [-dy / length, dx / length];
  };

  const normals = [];
  for (let i = 1; i < local.length; i += 1) normals.push(normalOf(local[i - 1], local[i]));

  /**
   * The offset point at a vertex.
   *
   * At the ends there is one segment, so the offset is its own normal. In the middle the two
   * segments' normals are averaged and the result scaled by 1/cos(half the turn), which is what
   * keeps the corridor's width constant through a bend instead of pinching it. The scale is
   * capped so a hairpin bevels rather than spiking.
   */
  const offsetAt = (index, side) => {
    const before = normals[index - 1], after = normals[index];
    const normal = before && after
      ? (() => {
        const sum = [before[0] + after[0], before[1] + after[1]];
        const length = Math.hypot(sum[0], sum[1]);
        // Exactly reversed: a doubling-back alignment has no sensible mitre.
        if (length < 1e-9) return after;
        const unit = [sum[0] / length, sum[1] / length];
        const cos = unit[0] * after[0] + unit[1] * after[1];
        const scale = Math.min(MITRE_LIMIT, cos > 1e-6 ? 1 / cos : MITRE_LIMIT);
        return [unit[0] * scale, unit[1] * scale];
      })()
      : (before ?? after);
    return [
      local[index][0] + normal[0] * half * side,
      local[index][1] + normal[1] * half * side,
    ];
  };

  const left = local.map((_, index) => offsetAt(index, +1));
  const right = local.map((_, index) => offsetAt(index, -1));
  const ring = [...left, ...right.reverse()];
  const geographic = ring.map(([east, north]) => enuToLonLat(origin, east, north));
  return [...geographic, geographic[0]];
}

/** The corridor as the one-ring-set shape the Cesium layers already take. */
export const roadCorridorRings = (coordinates, widthM) => {
  const ring = roadCorridorRing(coordinates, widthM);
  return ring ? [ring] : null;
};

/**
 * The area of a closed ring, in square metres.
 *
 * The shoelace formula in the ring's own local frame, so it measures ground area rather than
 * an area in degrees. Signed area's absolute value, so winding does not matter.
 */
export function ringAreaM2(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return 0;
  const origin = ring[0];
  const local = ring.map(point => lonLatToEnu(origin, point));
  let twice = 0;
  for (let i = 0, j = local.length - 1; i < local.length; j = i++) {
    twice += local[j][0] * local[i][1] - local[i][0] * local[j][1];
  }
  return Math.abs(twice / 2);
}

/**
 * What a proposed road measures.
 *
 * `surfaceAreaM2` is the corridor polygon's own area where one could be built, and the simple
 * length x width product otherwise — the two differ at bends, and which was used is stated so a
 * reader is not left guessing why a number moved.
 */
export function roadQuantities({ coordinates, widthM, lanes = null }) {
  const lengthM = centrelineLengthM(coordinates);
  const ring = roadCorridorRing(coordinates, widthM);
  const polygonArea = ring ? ringAreaM2(ring) : null;
  return {
    lengthM,
    widthM: finite(widthM) ? widthM : null,
    lanes: finite(lanes) ? lanes : null,
    surfaceAreaM2: polygonArea ?? (finite(widthM) ? lengthM * widthM : null),
    areaBasis: polygonArea === null ? 'LENGTH_X_WIDTH' : 'CORRIDOR_POLYGON',
    vertices: cleanCentreline(coordinates).length,
  };
}
