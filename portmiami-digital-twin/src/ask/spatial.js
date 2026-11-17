/**
 * The spatial query engine behind Ask the Twin.
 *
 * Two rules it exists to enforce.
 *
 * DISTANCES ARE IN METRES, NOT DEGREES. A degree of longitude at PortMiami is about 0.9 of a
 * degree of latitude, so sorting by `Math.hypot(dLon, dLat)` quietly stretches every answer
 * east-west. Everything here projects to a local equirectangular metre frame about the query
 * point first — the same approximation `buildingModel.groundMeasures` already uses, and far
 * inside any tolerance a 4 km-long port needs.
 *
 * DISTANCE TO A SHAPE IS NOT DISTANCE TO ITS NEAREST VERTEX. `assetCandidates.js` measures to
 * vertices, which is fine for offering a reviewer a shortlist but wrong for an answer that states
 * a number: a 200 m road segment drawn with two vertices reads as 140 m away from a point beside
 * its middle. These measure to the nearest point of the EDGE, and a point inside a footprint is
 * reported at 0.
 *
 * Nothing here reads application state. It takes geometry and returns numbers, so the tools that
 * use it can be tested against the real data files without a browser.
 */
import { distanceMetres } from '../infrastructure/assetGeocode.js';
import { footprintContains } from '../infrastructure/assetFrontage.js';

const EARTH_RADIUS_M = 6378137;
const RADIANS = Math.PI / 180;
const METRES_PER_DEGREE_LAT = EARTH_RADIUS_M * RADIANS;

export { distanceMetres };

/** A projection to metres about `origin`, so x and y can be compared and combined. */
export function metreFrame([lon0, lat0]) {
  const scaleLon = Math.cos(lat0 * RADIANS) * METRES_PER_DEGREE_LAT;
  return ([lon, lat]) => [(lon - lon0) * scaleLon, (lat - lat0) * METRES_PER_DEGREE_LAT];
}

/** Shortest distance from the origin of a metre frame to the segment a–b, both already projected. */
function originToSegment([x1, y1], [x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (-x1 * dx - y1 * dy) / lengthSq));
  return Math.hypot(x1 + dx * t, y1 + dy * t);
}

/** Shortest distance in metres from `point` to a polyline, measured to its edges. */
export function distanceToPolylineM(point, coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return Infinity;
  const project = metreFrame(point);
  if (coordinates.length === 1) return Math.hypot(...project(coordinates[0]));
  let best = Infinity;
  let previous = project(coordinates[0]);
  for (let i = 1; i < coordinates.length; i += 1) {
    const current = project(coordinates[i]);
    best = Math.min(best, originToSegment(previous, current));
    previous = current;
  }
  return best;
}

/**
 * Shortest distance in metres from `point` to a footprint: 0 when the point is inside it, and
 * otherwise the distance to the nearest edge of any of its rings.
 */
export function distanceToFootprintM(point, building) {
  if (!building?.rings?.length) return Infinity;
  if (footprintContains(point, building)) return 0;
  let best = Infinity;
  for (const ring of building.rings) best = Math.min(best, distanceToPolylineM(point, ring));
  return best;
}

/**
 * Does a bounding box come within `radiusM` of a point? A cheap reject run before any real
 * geometry, so a 250 m question does not measure 6,000 polygons edge by edge.
 */
export function boundsWithin(point, bounds, radiusM) {
  if (!bounds) return false;
  const [lon, lat] = point;
  const padLat = radiusM / METRES_PER_DEGREE_LAT;
  const padLon = radiusM / (Math.cos(lat * RADIANS) * METRES_PER_DEGREE_LAT);
  return bounds.west - padLon <= lon && bounds.east + padLon >= lon
    && bounds.south - padLat <= lat && bounds.north + padLat >= lat;
}

/** Is a lon/lat inside a bounding box? Used for "in the current view" filtering. */
export const pointInBounds = ([lon, lat], bounds) => Boolean(bounds)
  && lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north;

/**
 * Features within `radiusM` of a point, nearest first.
 *
 * `measure` returns the distance for one feature; `bounds` returns its box for the cheap reject.
 * `limit` caps the result because a chat answer that lists 400 buildings is not an answer.
 */
export function withinRadius(features, point, radiusM, { measure, bounds, limit = 25 } = {}) {
  if (!point || !Number.isFinite(radiusM)) return { within: [], total: 0 };
  const found = [];
  for (const feature of features ?? []) {
    if (bounds && !boundsWithin(point, bounds(feature), radiusM)) continue;
    const distanceM = measure(feature, point);
    if (!(distanceM <= radiusM)) continue;
    found.push({ feature, distanceM });
  }
  found.sort((a, b) => a.distanceM - b.distanceM);
  // `total` is every match; `within` is the page of them this answer will name.
  return { within: found.slice(0, limit), total: found.length };
}

/** A point feature's distance, for records that carry longitude/latitude rather than geometry. */
export const pointDistance = (feature, point) => (
  Number.isFinite(feature?.longitude) && Number.isFinite(feature?.latitude)
    ? distanceMetres(point, [feature.longitude, feature.latitude])
    : Infinity);

/** Metres, rounded the way an answer should state them: 10 m steps under a kilometre. */
export const readableMetres = value => (Number.isFinite(value)
  ? (value < 950 ? `${Math.round(value / 10) * 10} m` : `${(value / 1000).toFixed(1)} km`)
  : 'unknown');
