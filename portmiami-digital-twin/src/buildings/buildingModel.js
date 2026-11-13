/**
 * The building footprint domain model. Pure, Cesium-free, and it never mutates the source.
 *
 * Mirrors src/roads/roadModel.js on purpose: same shape of record, same validate-then-build flow,
 * same "the original properties object comes through by reference" rule.
 */
import { BUILDING_ASSETS } from '../config/buildings.js';

const EARTH_RADIUS_M = 6378137;
const RADIANS = Math.PI / 180;

const text = value => {
  const trimmed = String(value ?? '').trim();
  return trimmed === '' || trimmed.toLowerCase() === 'null' ? '' : trimmed;
};

/** A finite number, or null. `Number('')` is 0 and finite, so the blank check comes first. */
const numberOrNull = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Every ring of a Polygon or MultiPolygon, outer and holes alike, as flat arrays. */
export function ringsOf(geometry) {
  if (geometry?.type === 'Polygon') return geometry.coordinates ?? [];
  if (geometry?.type === 'MultiPolygon') return (geometry.coordinates ?? []).flat();
  return [];
}

/** Each part's outer ring: one for a Polygon, one per part for a MultiPolygon. */
const outerRings = geometry => {
  if (geometry?.type === 'Polygon') return geometry.coordinates?.slice(0, 1) ?? [];
  if (geometry?.type === 'MultiPolygon') return (geometry.coordinates ?? []).map(part => part[0]).filter(Boolean);
  return [];
};

/**
 * Ground area and perimeter in square metres and metres, computed from the geometry.
 *
 * A local equirectangular projection about the footprint's own latitude: over a building a few
 * tens of metres across the error is far below the precision anyone would read off this panel,
 * and it avoids claiming a geodesic rigour the display does not need. Holes are subtracted.
 */
export function groundMeasures(geometry) {
  const first = outerRings(geometry)[0]?.[0];
  if (!first) return { areaM2: null, perimeterM: null };
  const scale = Math.cos(first[1] * RADIANS) * EARTH_RADIUS_M * RADIANS;
  const metres = ([lon, lat]) => [lon * scale, lat * EARTH_RADIUS_M * RADIANS];

  const parts = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let areaM2 = 0, perimeterM = 0;
  for (const part of parts ?? []) {
    part.forEach((ring, index) => {
      const points = ring.map(metres);
      let twiceArea = 0;
      for (let i = 0; i < points.length - 1; i += 1) {
        const [x1, y1] = points[i], [x2, y2] = points[i + 1];
        twiceArea += x1 * y2 - x2 * y1;
        perimeterM += Math.hypot(x2 - x1, y2 - y1);
      }
      const ringArea = Math.abs(twiceArea) / 2;
      areaM2 += index === 0 ? ringArea : -ringArea;   // ring 0 is the outline, the rest are holes
    });
  }
  return { areaM2, perimeterM };
}

/**
 * Validation, reported rather than thrown.
 * @returns {{ok: boolean, errors: string[], warnings: string[], featureCount: number}}
 */
export function validateBuildingCollection(data, { expectedFeatureCount } = {}) {
  const errors = [], warnings = [];
  if (!data || typeof data !== 'object') {
    return { ok: false, errors: ['The file did not parse as a JSON object.'], warnings, featureCount: 0 };
  }
  if (data.type !== 'FeatureCollection') errors.push(`Expected a FeatureCollection, found "${data.type}".`);
  const features = Array.isArray(data.features) ? data.features : null;
  if (!features) {
    errors.push('The FeatureCollection has no "features" array.');
    return { ok: false, errors, warnings, featureCount: 0 };
  }

  const seen = new Set();
  let badGeometry = 0, missingId = 0, duplicateId = 0, shortRing = 0, outOfRange = 0, unclosed = 0;
  for (const feature of features) {
    const geometry = feature?.geometry;
    if (geometry?.type !== 'Polygon' && geometry?.type !== 'MultiPolygon') { badGeometry += 1; continue; }
    const objectId = feature?.properties?.OBJECTID;
    if (objectId === null || objectId === undefined) { missingId += 1; continue; }
    if (seen.has(objectId)) duplicateId += 1;
    seen.add(objectId);

    for (const ring of ringsOf(geometry)) {
      if (!Array.isArray(ring) || ring.length < 4) { shortRing += 1; continue; }
      const [fx, fy] = ring[0], [lx, ly] = ring[ring.length - 1];
      if (fx !== lx || fy !== ly) unclosed += 1;
      for (const point of ring) {
        const [lon, lat] = point ?? [];
        if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
          outOfRange += 1;
          break;
        }
      }
    }
  }
  if (badGeometry) errors.push(`${badGeometry} feature(s) are not Polygon or MultiPolygon and were not loaded.`);
  if (missingId) errors.push(`${missingId} feature(s) have no OBJECTID and cannot be identified.`);
  if (duplicateId) errors.push(`${duplicateId} duplicate OBJECTID(s) — the identifier is not unique.`);
  if (outOfRange) errors.push(`${outOfRange} ring(s) contain coordinates outside the valid longitude/latitude range.`);
  if (shortRing) warnings.push(`${shortRing} ring(s) have fewer than four positions and were skipped.`);
  if (unclosed) warnings.push(`${unclosed} ring(s) are not closed; they are closed on load.`);
  if (expectedFeatureCount != null && features.length !== expectedFeatureCount) {
    warnings.push(`Expected ${expectedFeatureCount} features, found ${features.length}.`);
  }
  return { ok: errors.length === 0, errors, warnings, featureCount: features.length };
}

/**
 * @typedef {object} Building
 * @property {number} objectId
 * @property {string} uniqueId      '' when the source has none — it is null for 1,574 features
 * @property {string} globalId
 * @property {number|null} height   HEIGHT, verbatim. Its unit is NOT stated by the source.
 * @property {string} type          TYPE, as the code the source carries
 * @property {string} source        SOURCE, as the code the source carries
 * @property {number|null} yearUpdate
 * @property {number|null} sourceArea       Shape__Area — Web Mercator units
 * @property {number|null} sourceLength     Shape__Length — Web Mercator units
 * @property {number|null} groundAreaM2     computed from the geometry
 * @property {number|null} groundPerimeterM computed from the geometry
 * @property {'Polygon'|'MultiPolygon'} geometryType
 * @property {number} partCount
 * @property {number} holeCount
 * @property {number[][][]} rings       every ring, closed, [lon, lat]
 * @property {[number, number]} centroid
 * @property {{west: number, south: number, east: number, north: number}} bounds
 * @property {{assetId: string, name: string, category: string, source: string}|null} asset
 * @property {object} properties        the ORIGINAL properties object
 */

export function buildBuildings(collection) {
  const buildings = [];
  for (const feature of collection?.features ?? []) {
    const geometry = feature?.geometry;
    if (geometry?.type !== 'Polygon' && geometry?.type !== 'MultiPolygon') continue;
    const properties = feature.properties ?? {};
    const objectId = properties.OBJECTID;
    if (objectId === null || objectId === undefined) continue;

    const rings = [];
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const ring of ringsOf(geometry)) {
      const points = (ring ?? []).filter(
        p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
          && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90);
      if (points.length < 4) continue;
      // Close a ring the source left open, so the outline never shows a gap.
      const closed = (points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1])
        ? points : [...points, points[0]];
      rings.push(closed);
      for (const [lon, lat] of closed) {
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
    }
    if (rings.length === 0) continue;

    const parts = geometry.type === 'Polygon' ? 1 : (geometry.coordinates?.length ?? 1);
    const { areaM2, perimeterM } = groundMeasures(geometry);

    buildings.push({
      objectId,
      uniqueId: text(properties.UNIQUEID),
      globalId: text(properties.GlobalID),
      height: numberOrNull(properties.HEIGHT),
      type: text(properties.TYPE),
      source: text(properties.SOURCE),
      yearUpdate: numberOrNull(properties.YEARUPDATE),
      sourceArea: numberOrNull(properties.Shape__Area),
      sourceLength: numberOrNull(properties.Shape__Length),
      groundAreaM2: areaM2,
      groundPerimeterM: perimeterM,
      geometryType: geometry.type,
      partCount: parts,
      holeCount: Math.max(0, rings.length - parts),
      rings,
      centroid: [(west + east) / 2, (south + north) / 2],
      bounds: { west, south, east, north },
      asset: BUILDING_ASSETS[objectId] ?? null,
      properties,
    });
  }
  return buildings;
}

/** What a building is called. The source has no name field, so identity is the OBJECTID — unless
 *  a curated asset record supplies a real, sourced name. */
export const buildingLabel = building =>
  building.asset?.name || `Building · ID ${building.objectId}`;

export function summariseBuildings(buildings) {
  let withHeight = 0, multiPart = 0, curated = 0;
  for (const building of buildings) {
    if (building.height !== null) withHeight += 1;
    if (building.geometryType === 'MultiPolygon') multiPart += 1;
    if (building.asset) curated += 1;
  }
  return {
    total: buildings.length,
    withHeight,
    withoutHeight: buildings.length - withHeight,
    multiPart,
    curated,
  };
}

/** Counts per value of a field, sorted. Used for the YEARUPDATE and TYPE facets. */
function distribution(buildings, pick, { numeric = false } = {}) {
  const counts = new Map();
  for (const building of buildings) {
    const value = pick(building);
    const key = value === null || value === '' ? '' : String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en', { numeric }))
    .map(([value, count]) => ({ value, count }));
}

export const yearDistribution = buildings => distribution(buildings, b => b.yearUpdate, { numeric: true });
export const typeDistribution = buildings => distribution(buildings, b => b.type);

/** TYPE and SOURCE are single-letter codes and the file ships no lookup table for either. */
export const buildingTypeLabel = type => (type === '' ? 'No type' : `TYPE ${type}`);
export const buildingSourceLabel = source => (source === '' ? 'Not available' : `SOURCE ${source}`);
