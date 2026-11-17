/**
 * Distance and intersection helpers.
 *
 * Ported from the ACS I-595 Safety Twin (`cesium-poc/server/geo.mjs`) and kept byte-compatible in
 * behaviour, so both apps measure distance the same way. `segmentIntersectsRectangle` is new: the
 * I-595 twin only ever asked "how far is this point from the corridor", whereas a study-area box
 * also has to answer "does this line cross the box" (see server/portmiami/studyArea.mjs).
 *
 * Over a ~7 km study area an equirectangular projection at the local latitude is sub-metre
 * accurate, which is far finer than any tolerance here, and it keeps the point-to-polyline sweep
 * cheap enough to run over every FL511 event against 2,362 road segments on every poll.
 */
const EARTH_RADIUS_M = 6_371_000; // Same constant as the ACS twin, so both spatial joins agree.
const DEG_TO_M = (Math.PI / 180) * EARTH_RADIUS_M;

/** FL511 sends [latitude, longitude]; anything outside Earth's range is a schema surprise. */
export function isValidLatLon(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    && !(latitude === 0 && longitude === 0);
}

/** Metres between two lon/lat points. */
export function haversineMeters(lon1, lat1, lon2, lat2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Metres from a point to the closed segment [a, b], each given as [lon, lat]. */
export function distanceToSegmentMeters(lon, lat, a, b) {
  const scale = Math.cos(lat * Math.PI / 180);
  const px = lon * scale, py = lat;
  const ax = a[0] * scale, ay = a[1], bx = b[0] * scale, by = b[1];
  const dx = bx - ax, dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * DEG_TO_M;
}

/** Metres from a point to a polyline given as [[lon, lat], …]. Infinity for degenerate input. */
export function distanceToPolylineMeters(lon, lat, coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return Infinity;
  if (coordinates.length === 1) return haversineMeters(lon, lat, coordinates[0][0], coordinates[0][1]);
  let best = Infinity;
  for (let i = 0; i < coordinates.length - 1; i++) {
    const distance = distanceToSegmentMeters(lon, lat, coordinates[i], coordinates[i + 1]);
    if (distance < best) best = distance;
  }
  return best;
}

/** Every LineString in a GeoJSON geometry, flattened; other geometry types contribute nothing. */
export function lineStringsOf(geometry) {
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

const inside = (point, box) => point[0] >= box.west && point[0] <= box.east
  && point[1] >= box.south && point[1] <= box.north;

/**
 * Whether the closed segment [a, b] touches the axis-aligned box — endpoints inside included.
 *
 * Liang-Barsky clipping on the lon/lat plane. A study-area box is small enough that treating
 * lon/lat as planar is exact for this purpose: the box edges ARE lines of constant lon and lat,
 * so no projection can change which side of one a point falls on.
 *
 * @param {[number, number]} a  [lon, lat]
 * @param {[number, number]} b  [lon, lat]
 * @param {{west: number, south: number, east: number, north: number}} box
 */
export function segmentIntersectsRectangle(a, b, box) {
  if (inside(a, box) || inside(b, box)) return true;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = 0, t1 = 1;
  // One pass per edge: p is the parameter's coefficient, q the signed room left before the edge.
  for (const [p, q] of [[-dx, a[0] - box.west], [dx, box.east - a[0]],
                        [-dy, a[1] - box.south], [dy, box.north - a[1]]]) {
    if (p === 0) {
      if (q < 0) return false;   // Parallel to this edge and wholly outside it.
      continue;
    }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

/** Whether a polyline [[lon, lat], …] touches the box. A single-point line is a containment test. */
export function polylineIntersectsRectangle(coordinates, box) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return false;
  if (coordinates.length === 1) return inside(coordinates[0], box);
  for (let i = 0; i < coordinates.length - 1; i++) {
    if (segmentIntersectsRectangle(coordinates[i], coordinates[i + 1], box)) return true;
  }
  return false;
}

export { inside as pointInRectangle };
