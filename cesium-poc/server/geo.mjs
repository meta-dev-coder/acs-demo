/**
 * Distance helpers for corridor filtering. Over a ~15 km corridor an equirectangular projection
 * at the local latitude is sub-metre accurate, which is far finer than the 250 m buffer, and it
 * keeps the point-to-polyline sweep cheap enough to run over every FL511 event on every poll.
 */
const EARTH_RADIUS_M = 6_371_000; // Matches src/uc1Data.js so both spatial joins agree.
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
