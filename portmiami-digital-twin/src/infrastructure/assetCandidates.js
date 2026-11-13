/**
 * Candidate discovery: which footprints and which road segments MIGHT belong to an asset.
 *
 * Everything this module produces is a CANDIDATE. Nothing here confirms a relationship, because
 * nothing here can: a building 20 m from a derived street point is a building 20 m from a street
 * point, not a cruise terminal. Confirmation is a human act, recorded in the link store.
 */
import { distanceMetres } from './assetGeocode.js';

/** How far from an asset's point to look. Generous: a terminal is a big thing. */
export const BUILDING_SEARCH_RADIUS_M = 250;
export const ROAD_SEARCH_RADIUS_M = 200;
export const MAX_CANDIDATES = 12;

/** Distance from a point to a polyline, as the shortest distance to any of its vertices. */
const distanceToVertices = (point, coordinates) =>
  coordinates.reduce((best, vertex) => Math.min(best, distanceMetres(point, vertex)), Infinity);

/** Is the point inside the ring? Ray casting, in degrees — fine at a port's scale. */
function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Footprints at or near a point, nearest first. A footprint CONTAINING the point is reported with
 * distance 0 and `contains: true`, which is the strongest signal available — and still a candidate.
 *
 * @param {[number, number]|null} point
 * @param {import('../buildings/buildingModel.js').Building[]} buildings
 */
export function buildingCandidates(point, buildings, { radiusM = BUILDING_SEARCH_RADIUS_M, limit = MAX_CANDIDATES } = {}) {
  if (!point) return [];
  const found = [];
  for (const building of buildings) {
    // Cheap reject on the bounding box before any real geometry work.
    const { west, south, east, north } = building.bounds;
    const pad = radiusM / 100000;   // ~1 degree ≈ 111 km, so this is a loose degree padding
    if (point[0] < west - pad || point[0] > east + pad || point[1] < south - pad || point[1] > north + pad) continue;

    const contains = building.rings.length > 0 && pointInRing(point, building.rings[0]);
    const distance = contains ? 0 : Math.min(...building.rings.map(ring => distanceToVertices(point, ring)));
    if (distance > radiusM) continue;
    found.push({ building, objectId: building.objectId, distanceM: distance, contains });
  }
  return found.sort((a, b) => a.distanceM - b.distanceM).slice(0, limit);
}

/**
 * Road segments near a point, nearest first.
 * @param {[number, number]|null} point
 * @param {import('../roads/roadModel.js').RoadSegment[]} segments
 */
export function roadCandidates(point, segments, { radiusM = ROAD_SEARCH_RADIUS_M, limit = MAX_CANDIDATES } = {}) {
  if (!point) return [];
  const found = [];
  for (const segment of segments) {
    const { west, south, east, north } = segment.bounds;
    const pad = radiusM / 100000;
    if (point[0] < west - pad || point[0] > east + pad || point[1] < south - pad || point[1] > north + pad) continue;
    const distance = distanceToVertices(point, segment.coordinates);
    if (distance > radiusM) continue;
    found.push({ segment, objectId: segment.objectId, distanceM: distance });
  }
  return found.sort((a, b) => a.distanceM - b.distanceM).slice(0, limit);
}
