/**
 * Small, dependency-free geography for the Seagirt project: point-in-polygon, metre offsets and
 * interpolation on WGS84 longitude/latitude. Used by the data build, the tests and the page, so a
 * position that passes the tests is the position the map draws.
 *
 * Coordinates are always [longitude, latitude] in degrees (GeoJSON order).
 */

const EARTH_M = 6_371_008.8;
const RAD = Math.PI / 180;

/** Is [lon, lat] a finite position on Earth? */
export const validLonLat = p => Array.isArray(p) && p.length >= 2
  && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] >= -180 && p[0] <= 180 && p[1] >= -90 && p[1] <= 90;

/** Ray casting on one ring of [lon, lat] (closed or not). Points on an edge count as inside. */
export function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside a GeoJSON Polygon's coordinates (outer ring, minus holes). */
export const pointInPolygon = (p, rings) => pointInRing(p, rings[0]) && !rings.slice(1).some(h => pointInRing(p, h));

/** Distance in metres between two [lon, lat] points (haversine). */
export function distanceM([lon1, lat1], [lon2, lat2]) {
  const a = Math.sin(((lat2 - lat1) * RAD) / 2) ** 2
    + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(a));
}

/** [lon, lat] moved east and north by metres (local tangent-plane approximation, fine at terminal scale). */
export function offsetM([lon, lat], eastM, northM) {
  return [lon + eastM / (EARTH_M * Math.cos(lat * RAD) * RAD), lat + northM / (EARTH_M * RAD)];
}

/** The point a fraction `t` (0–1) of the way from a to b. */
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Centroid of a ring's vertices (adequate for labels and framing). */
export function ringCentroid(ring) {
  const pts = ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring;
  return [pts.reduce((t, p) => t + p[0], 0) / pts.length, pts.reduce((t, p) => t + p[1], 0) / pts.length];
}

/** [west, south, east, north] of a ring. */
export function ringBounds(ring) {
  const lons = ring.map(p => p[0]), lats = ring.map(p => p[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}
