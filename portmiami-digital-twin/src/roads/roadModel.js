/**
 * The road network domain model: source GeoJSON in, normalised segment records out.
 *
 * Pure, Cesium-free and side-effect-free. The parsed FeatureCollection is never mutated — selecting
 * and filtering happen on derived records that carry a reference to the original `properties`, so
 * the source stays exactly as it was read.
 *
 * The three layers the architecture keeps apart meet here and nowhere else:
 *   1. source geometry and attributes  → `segment.properties`, `segment.coordinates`
 *   2. derived classification          → `segment.isPortAccess`, `segment.isTunnel`
 *   3. UI selection and map state      → not in this file at all
 * A future operational overlay (closures, work zones) keys off `objectId` and adds a fourth layer
 * beside these without touching them.
 */
import {
  PORT_ACCESS_NAME_PATTERNS, PORT_ACCESS_OVERRIDES, PORT_ACCESS_STREET_NAMES, TUNNEL_NAME_PATTERNS,
} from '../config/roadNetwork.js';

/** `Shape.STLength()` is in FEET — see `lengthFeet` below for the evidence and the caveat. */
export const LENGTH_UNIT = 'ft';

const text = value => {
  const trimmed = String(value ?? '').trim();
  return trimmed === '' || trimmed.toLowerCase() === 'null' ? '' : trimmed;
};

/**
 * A readable name from the four name parts, in the order the source stores them.
 * Returns '' when the segment has no name at all; the caller supplies the fallback.
 */
export function readableName(properties) {
  return [properties?.PRE_DIR, properties?.ST_NAME, properties?.ST_TYPE, properties?.SUF_DIR]
    .map(text).filter(Boolean).join(' ');
}

/** What an unnamed segment is called. Its OBJECTID is the only identity it has. */
export const unnamedLabel = objectId => `Unnamed Road · ID ${objectId}`;

/** The name to show: the real one, or the fallback. */
export const displayName = segment => segment.name || unnamedLabel(segment.objectId);

/**
 * Port access, from the source attributes only. Order matters: a manual override wins over
 * everything, so a correction is always the last word.
 * @returns {{isPortAccess: boolean, reason: string}}
 */
export function classifyPortAccess(name, objectId) {
  const override = PORT_ACCESS_OVERRIDES[objectId];
  if (override !== undefined) {
    return { isPortAccess: override, reason: `Manual override for OBJECTID ${objectId}` };
  }
  const upper = name.toUpperCase();
  for (const rule of PORT_ACCESS_NAME_PATTERNS) {
    if (rule.pattern.test(upper)) return { isPortAccess: true, reason: rule.reason };
  }
  if (PORT_ACCESS_STREET_NAMES.includes(upper)) {
    return { isPortAccess: true, reason: 'Listed PortMiami terminal street' };
  }
  return { isPortAccess: false, reason: 'No port access rule matched' };
}

const isTunnel = name => TUNNEL_NAME_PATTERNS.some(pattern => pattern.test(name.toUpperCase()));

/** A finite number, or null. `Number('')` is 0 and finite, so the blank check has to come first. */
const numberOrNull = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Validation that runs before anything is drawn. It reports rather than throws, so the UI can say
 * what is wrong with a file instead of showing a blank map.
 *
 * @param {unknown} data  the parsed JSON
 * @param {{expectedFeatureCount?: number}} [options]
 * @returns {{ok: boolean, errors: string[], warnings: string[], featureCount: number}}
 */
export function validateRoadCollection(data, { expectedFeatureCount } = {}) {
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
  let badGeometry = 0, missingId = 0, duplicateId = 0, shortGeometry = 0;
  for (const feature of features) {
    const geometry = feature?.geometry;
    if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates)) { badGeometry += 1; continue; }
    if (geometry.coordinates.length < 2) shortGeometry += 1;
    const objectId = feature?.properties?.OBJECTID;
    if (objectId === null || objectId === undefined) { missingId += 1; continue; }
    if (seen.has(objectId)) duplicateId += 1;
    seen.add(objectId);
  }
  if (badGeometry) errors.push(`${badGeometry} feature(s) are not LineStrings and were not loaded.`);
  if (missingId) errors.push(`${missingId} feature(s) have no OBJECTID and cannot be identified.`);
  if (duplicateId) errors.push(`${duplicateId} duplicate OBJECTID(s) — the identifier is not unique.`);
  if (shortGeometry) warnings.push(`${shortGeometry} feature(s) have fewer than two coordinates.`);
  if (expectedFeatureCount != null && features.length !== expectedFeatureCount) {
    warnings.push(`Expected ${expectedFeatureCount} features, found ${features.length}.`);
  }
  return { ok: errors.length === 0, errors, warnings, featureCount: features.length };
}

/**
 * One normalised road segment.
 *
 * @typedef {object} RoadSegment
 * @property {number} objectId        OBJECTID — the primary identifier, used everywhere
 * @property {string} globalId        GlobalID, verbatim
 * @property {string} name            readable name, '' when the source has none
 * @property {string} classCode       CLASS as the source stores it; see roadClassLabel
 * @property {number|null} lengthFeet Shape.STLength()
 * @property {string} municipality    LMUNIC_NAME, or L/R when they differ
 * @property {boolean} isPortAccess
 * @property {string} classificationReason
 * @property {boolean} isTunnel
 * @property {number[][]} coordinates [lon, lat] pairs, as read
 * @property {[number, number]} midpoint
 * @property {{west: number, south: number, east: number, north: number}} bounds
 * @property {object} properties      the ORIGINAL properties object, untouched
 */

/** Build the records. The source object is read, never written. */
export function buildRoadSegments(collection) {
  const segments = [];
  for (const feature of collection?.features ?? []) {
    const geometry = feature?.geometry;
    if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates)) continue;
    const properties = feature.properties ?? {};
    const objectId = properties.OBJECTID;
    if (objectId === null || objectId === undefined) continue;

    const coordinates = geometry.coordinates.filter(
      c => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]));
    if (coordinates.length < 2) continue;

    const name = readableName(properties);
    const { isPortAccess, reason } = classifyPortAccess(name, objectId);
    const left = text(properties.LMUNIC_NAME), right = text(properties.RMUNIC_NAME);

    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const [lon, lat] of coordinates) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }

    segments.push({
      objectId,
      globalId: text(properties.GlobalID),
      name,
      classCode: text(properties.CLASS),
      lengthFeet: numberOrNull(properties['Shape.STLength()']),
      municipality: left && right && left !== right ? `${left} / ${right}` : (left || right),
      isPortAccess,
      classificationReason: reason,
      isTunnel: isTunnel(name),
      coordinates,
      midpoint: coordinates[Math.floor(coordinates.length / 2)],
      bounds: { west, south, east, north },
      properties,
    });
  }
  return segments;
}

/** Counts for the explorer's summary, computed from the records rather than typed in. */
export function summariseRoads(segments) {
  let portAccess = 0, named = 0, tunnels = 0;
  for (const segment of segments) {
    if (segment.isPortAccess) portAccess += 1;
    if (segment.name) named += 1;
    if (segment.isTunnel) tunnels += 1;
  }
  return {
    total: segments.length,
    portAccess,
    surrounding: segments.length - portAccess,
    named,
    unnamed: segments.length - named,
    tunnels,
  };
}

/** The CLASS codes present, with their counts, sorted by code. The source ships no lookup table. */
export function roadClasses(segments) {
  const counts = new Map();
  for (const segment of segments) counts.set(segment.classCode, (counts.get(segment.classCode) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en', { numeric: true }))
    .map(([code, count]) => ({ code, count }));
}

/** The municipalities present, with counts. */
export function roadMunicipalities(segments) {
  const counts = new Map();
  for (const segment of segments) {
    if (!segment.municipality) continue;
    counts.set(segment.municipality, (counts.get(segment.municipality) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}

/**
 * CLASS as a label. The source file carries the code and no lookup table for it, so the code is
 * shown as the code. Guessing that "5" means "local street" would be inventing data.
 */
export const roadClassLabel = classCode => (classCode === '' ? 'No class' : `CLASS ${classCode}`);
