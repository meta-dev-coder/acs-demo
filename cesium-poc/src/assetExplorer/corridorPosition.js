/**
 * Where an asset sits along the corridor, measured from the real centerline geometry.
 *
 * Several datasets publish a milepost and several do not. Rather than drop the position rail for
 * the ones that don't — or worse, scrape "I-595 ~MP 8.5" out of a camera's prose description, which
 * would turn an explicit approximation into false precision — the position is measured: project the
 * asset onto the nearest centerline segment and accumulate the distance to that point.
 *
 * The result is a distance along the published corridor geometry, reported in miles so it is
 * comparable with the datasets that do carry mileposts. It is not an FDOT milepost, and
 * `mileposted` on the normalized asset records which of the two a given value is.
 */

const EARTH_RADIUS_M = 6371008.8;
const METRES_PER_MILE = 1609.344;
const toRad = degrees => (degrees * Math.PI) / 180;

/**
 * Equirectangular metres between two lon/lat pairs. Over a 22 km corridor at 26°N the error against
 * a full haversine is centimetres — far below the precision anything here claims.
 */
export function metresBetween(aLon, aLat, bLon, bLat) {
  const meanLat = toRad((aLat + bLat) / 2);
  const x = toRad(bLon - aLon) * Math.cos(meanLat);
  const y = toRad(bLat - aLat);
  return Math.hypot(x, y) * EARTH_RADIUS_M;
}

/** Cumulative along-corridor distance in metres at each centerline vertex. */
export function centerlineDistances(centerline) {
  const distances = new Float64Array(centerline.length);
  for (let i = 1; i < centerline.length; i++) {
    distances[i] = distances[i - 1]
      + metresBetween(centerline[i - 1].lon, centerline[i - 1].lat, centerline[i].lon, centerline[i].lat);
  }
  return distances;
}

/** Total corridor length in miles, for the rail's end labels. */
export function corridorLengthMiles(centerline) {
  if (!Array.isArray(centerline) || centerline.length < 2) return 0;
  const distances = centerlineDistances(centerline);
  return distances[distances.length - 1] / METRES_PER_MILE;
}

/**
 * Project one point onto the centerline.
 *
 * @returns {{milepost: number | null, offsetM: number | null, fraction: number | null}}
 *   `milepost` is miles along the corridor, `offsetM` how far the asset lies off it — which is what
 *   tells a caller whether the projection is meaningful at all.
 */
export function corridorPositionOf(longitude, latitude, centerline, distances = null) {
  if (!Array.isArray(centerline) || centerline.length < 2
    || !Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    return { milepost: null, offsetM: null, fraction: null };
  }
  const along = distances ?? centerlineDistances(centerline);
  const meanLat = toRad(latitude);
  // Work in a local metre plane so the projection is a plain 2-D one.
  const px = toRad(longitude) * Math.cos(meanLat) * EARTH_RADIUS_M;
  const py = toRad(latitude) * EARTH_RADIUS_M;
  let best = { distanceSq: Infinity, milepost: null, offsetM: null, fraction: null };

  for (let i = 1; i < centerline.length; i++) {
    const a = centerline[i - 1], b = centerline[i];
    const ax = toRad(a.lon) * Math.cos(meanLat) * EARTH_RADIUS_M, ay = toRad(a.lat) * EARTH_RADIUS_M;
    const bx = toRad(b.lon) * Math.cos(meanLat) * EARTH_RADIUS_M, by = toRad(b.lat) * EARTH_RADIUS_M;
    const dx = bx - ax, dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    // A duplicated vertex has no direction to project onto; the neighbouring segments cover it.
    if (lengthSq === 0) continue;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
    const cx = ax + t * dx, cy = ay + t * dy;
    const distanceSq = (px - cx) ** 2 + (py - cy) ** 2;
    if (distanceSq >= best.distanceSq) continue;
    const metres = along[i - 1] + t * Math.sqrt(lengthSq);
    best = {
      distanceSq,
      milepost: metres / METRES_PER_MILE,
      offsetM: Math.sqrt(distanceSq),
      fraction: metres / (along[along.length - 1] || 1),
    };
  }
  const { distanceSq, ...position } = best;
  return position;
}
