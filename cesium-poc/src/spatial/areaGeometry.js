/**
 * Rectangle geometry for the Ask the Twin area selection.
 *
 * The one thing this corridor's existing utilities cannot do. `server/geo.mjs` measures distance
 * from a point to a polyline, `corridorPosition.js` projects a point onto the centerline, and
 * `i595Network.mjs` finds the nearest facility — all of which answer "how far", none of which
 * answers "does this line cross this box". A closure whose two endpoints both sit outside the
 * drawn area still runs straight through it, and a nearest-point test would miss it entirely.
 *
 * So: exact predicates, in geographic space, on the two shapes the data actually has — points and
 * LineStrings — plus polygons for the asset classes that carry one. No Turf: the whole of it is a
 * containment test and a Liang–Barsky clip, and a 500 kB dependency to get them would be a poor
 * trade in a bundle that already ships Cesium.
 *
 * Coordinates are GeoJSON order — [longitude, latitude] — everywhere, without exception.
 *
 * Longitudes are treated as a plain number line. I-595 spans 0.14° of longitude in Florida and the
 * antimeridian is a quarter of the planet away; a box that wrapped it would need a different model
 * for every function here, and building one for a corridor that cannot reach it would be inventing
 * a requirement.
 *
 * Pure — no Cesium, no DOM — so every rule below is unit-tested directly.
 */

/** @typedef {{west: number, south: number, east: number, north: number}} Bounds */

const finite = value => Number.isFinite(Number(value));

/**
 * The bounds of the box between two dragged corners, in any order.
 *
 * @returns {Bounds|null} null when either corner is not a usable coordinate — a drag that began or
 *   ended off the globe has no geographic box, and reporting one would be a guess.
 */
export function boundsFromCorners(a, b) {
  if (!finite(a?.longitude) || !finite(a?.latitude) || !finite(b?.longitude) || !finite(b?.latitude)) return null;
  return {
    west: Math.min(Number(a.longitude), Number(b.longitude)),
    east: Math.max(Number(a.longitude), Number(b.longitude)),
    south: Math.min(Number(a.latitude), Number(b.latitude)),
    north: Math.max(Number(a.latitude), Number(b.latitude)),
  };
}

/** True for a box with real edges. A click without a drag is a point, and selects nothing. */
export const isUsableBounds = bounds => Boolean(bounds)
  && finite(bounds.west) && finite(bounds.east) && finite(bounds.south) && finite(bounds.north)
  && bounds.east > bounds.west && bounds.north > bounds.south;

/** The box as a closed GeoJSON ring, counter-clockwise from its south-west corner. */
export function boundsToPolygon(bounds) {
  const { west, south, east, north } = bounds;
  return [[west, south], [east, south], [east, north], [west, north], [west, south]];
}

/** The middle of the box. Reported for context only — never used to decide what it contains. */
export const boundsCenter = bounds => ({
  longitude: (bounds.west + bounds.east) / 2,
  latitude: (bounds.south + bounds.north) / 2,
});

/** Is this point in the box? Edges count as inside, so a marker exactly on the line is included. */
export function pointInBounds(longitude, latitude, bounds) {
  if (!isUsableBounds(bounds) || !finite(longitude) || !finite(latitude)) return false;
  return Number(longitude) >= bounds.west && Number(longitude) <= bounds.east
    && Number(latitude) >= bounds.south && Number(latitude) <= bounds.north;
}

/**
 * The part of the segment a→b that lies in the box, as a parameter range along it.
 *
 * Liang–Barsky: clip the range against each of the four edges in turn and see what survives. This
 * is what catches the case a distance test cannot — a line whose endpoints are both outside the box
 * but which crosses it — and it needs no trigonometry, because the box is axis-aligned.
 *
 * @returns {{enter: number, exit: number}|null} null when no part of it is in the box
 */
export function clipSegmentToBounds(a, b, bounds) {
  if (!isUsableBounds(bounds)) return null;
  const [x0, y0] = a ?? [], [x1, y1] = b ?? [];
  if (!finite(x0) || !finite(y0) || !finite(x1) || !finite(y1)) return null;
  const dx = x1 - x0, dy = y1 - y0;
  let enter = 0, exit = 1;
  // One pass per edge: p is the segment's movement across it, q how far inside the box it starts.
  const edges = [[-dx, x0 - bounds.west], [dx, bounds.east - x0], [-dy, y0 - bounds.south], [dy, bounds.north - y0]];
  for (const [p, q] of edges) {
    if (p === 0) {
      // Parallel to this edge: it can only miss if it starts outside it, and then nothing helps.
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) { if (t > exit) return null; if (t > enter) enter = t; }
    else { if (t < enter) return null; if (t < exit) exit = t; }
  }
  return enter <= exit ? { enter, exit } : null;
}

/** Does the segment a→b touch the box? */
export const segmentIntersectsBounds = (a, b, bounds) => clipSegmentToBounds(a, b, bounds) !== null;

/**
 * The parts of a LineString that lie inside the box, as separate paths.
 *
 * Used to draw the selection highlight. Highlighting the whole of every matched line instead made
 * a small box over the corridor light up four miles of road in each direction — the highlight then
 * says "everything here is selected", which is the opposite of what the operator drew.
 *
 * Contiguous pieces are joined, so a line crossing many vertices inside the box comes back as one
 * path rather than as one per vertex pair.
 *
 * @returns {number[][][]} zero or more [lon, lat] paths
 */
export function clipLineStringToBounds(coordinates, bounds) {
  const paths = [];
  if (!Array.isArray(coordinates) || coordinates.length < 2 || !isUsableBounds(bounds)) return paths;
  const at = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  let current = null;
  for (let i = 1; i < coordinates.length; i++) {
    const a = coordinates[i - 1], b = coordinates[i];
    const clip = clipSegmentToBounds(a, b, bounds);
    if (!clip) { if (current) { paths.push(current); current = null; } continue; }
    const start = at(a, b, clip.enter), end = at(a, b, clip.exit);
    // A piece that begins where the last one ended continues it; anything else starts a new path.
    if (current && current[current.length - 1][0] === start[0] && current[current.length - 1][1] === start[1]) current.push(end);
    else { if (current) paths.push(current); current = [start, end]; }
    // The segment left the box part-way along, so whatever follows is a new path.
    if (clip.exit < 1) { paths.push(current); current = null; }
  }
  if (current) paths.push(current);
  return paths.filter(path => path.length >= 2);
}

/** Does any part of this LineString touch the box? A single vertex inside is enough. */
export function lineStringIntersectsBounds(coordinates, bounds) {
  if (!Array.isArray(coordinates) || !isUsableBounds(bounds)) return false;
  if (coordinates.length === 1) return pointInBounds(coordinates[0]?.[0], coordinates[0]?.[1], bounds);
  for (let i = 1; i < coordinates.length; i++) {
    if (segmentIntersectsBounds(coordinates[i - 1], coordinates[i], bounds)) return true;
  }
  return false;
}

/** Is the point inside this ring? Ray casting, used only for a box drawn wholly inside a polygon. */
function pointInRing(longitude, latitude, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > latitude) !== (yj > latitude)
      && longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Does this polygon touch the box?
 *
 * Three ways it can, and all three are needed: the polygon has a vertex in the box, one of its
 * edges crosses the box, or the box sits entirely within the polygon and touches none of its edges.
 * Only the outer ring is tested — a box that falls in a hole is a refinement no asset here needs.
 */
export function polygonIntersectsBounds(rings, bounds) {
  const outer = rings?.[0];
  if (!Array.isArray(outer) || outer.length < 3 || !isUsableBounds(bounds)) return false;
  if (lineStringIntersectsBounds([...outer, outer[0]], bounds)) return true;
  return pointInRing(bounds.west, bounds.south, outer);
}

/**
 * Does this GeoJSON geometry touch the box?
 *
 * @param {{type: string, coordinates: any}|null} geometry
 * @returns {boolean} false for a geometry with no recognised type — an unknown shape is not
 *   assumed to be in the area.
 */
export function geometryIntersectsBounds(geometry, bounds) {
  if (!geometry || !isUsableBounds(bounds)) return false;
  const { type, coordinates } = geometry;
  switch (type) {
    case 'Point': return pointInBounds(coordinates?.[0], coordinates?.[1], bounds);
    case 'MultiPoint': return (coordinates ?? []).some(point => pointInBounds(point?.[0], point?.[1], bounds));
    case 'LineString': return lineStringIntersectsBounds(coordinates, bounds);
    case 'MultiLineString': return (coordinates ?? []).some(line => lineStringIntersectsBounds(line, bounds));
    case 'Polygon': return polygonIntersectsBounds(coordinates, bounds);
    case 'MultiPolygon': return (coordinates ?? []).some(rings => polygonIntersectsBounds(rings, bounds));
    case 'GeometryCollection': return (geometry.geometries ?? []).some(part => geometryIntersectsBounds(part, bounds));
    default: return false;
  }
}

/** Metres per degree of latitude; longitude shrinks with the cosine. Used only for readable sizes. */
const METRES_PER_DEGREE = 111_320;

/** Roughly how big the box is, for the summary line. Not used in any containment decision. */
export function boundsSizeMetres(bounds) {
  if (!isUsableBounds(bounds)) return null;
  const meanLat = ((bounds.south + bounds.north) / 2) * (Math.PI / 180);
  return {
    widthM: (bounds.east - bounds.west) * METRES_PER_DEGREE * Math.cos(meanLat),
    heightM: (bounds.north - bounds.south) * METRES_PER_DEGREE,
  };
}
