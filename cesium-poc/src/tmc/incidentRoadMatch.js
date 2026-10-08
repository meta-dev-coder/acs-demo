/**
 * Which piece of road an incident is actually on.
 *
 * The corridor is not one line. Alongside the sixteen FDOT mainline sections there are 165 ramps
 * and connectors, 185 frontage-road features and a reversible express carriageway, and an incident
 * reported a few metres off the mainline may belong to any of them. Highlighting a whole 1.5 km
 * FDOT section because the incident was nearest to it says something the coordinates do not: that
 * the whole section is affected, and that the incident was on the mainline at all.
 *
 * So this picks the nearest piece of road from EVERY published facility and paints only a short
 * stretch of it around the incident. What it will not do is guess: beyond `reachMeters` nothing is
 * matched, and a match on a ramp is reported as a ramp rather than promoted to the mainline section
 * it happens to run beside.
 *
 * The geometry work — projecting onto a leg rather than measuring to vertices, and cutting the last
 * leg part-way so the painted length is the length claimed — is already solved in `crashRibbon`,
 * which exists because the Safety screen needed exactly this. It is reused rather than rewritten.
 *
 * Pure: roads and a point in, a match out. No DOM, no Cesium, no fetching.
 */
import { nearestOnPath, sliceAround } from '../safety/crashRibbon.js';

/**
 * How much road to colour either side of the incident.
 *
 * Operational configuration. Long enough to read as a stretch of road at investigation zoom, short
 * enough that it is clearly a claim about the incident's immediate surroundings and not about a
 * whole section.
 */
export const ROAD_PAINT_CONFIG = Object.freeze({
  /** Painted each way from the incident, so the band is twice this. */
  halfLengthMeters: 75,
  /**
   * Beyond this, nothing is matched.
   *
   * An incident 200 m from every published line is not on a road this application knows about, and
   * the honest answer is to say so rather than to colour the closest thing.
   */
  reachMeters: 60,
  /** A match further than this is reported as approximate — the position may be off the roadway. */
  confidentWithinMeters: 25,
});

/** The facilities this can match, in the order a tie is broken. Narrower roads win. */
export const ROAD_KINDS = Object.freeze({
  RAMP: 'ramp',
  FRONTAGE: 'frontage',
  EXPRESS: 'express',
  MAINLINE_SECTION: 'section',
  MAINLINE: 'mainline',
});

/** Ties break towards the more specific facility: a ramp is a better answer than "the mainline". */
const SPECIFICITY = Object.freeze({
  [ROAD_KINDS.RAMP]: 0,
  [ROAD_KINDS.FRONTAGE]: 1,
  [ROAD_KINDS.EXPRESS]: 2,
  [ROAD_KINDS.MAINLINE_SECTION]: 3,
  [ROAD_KINDS.MAINLINE]: 4,
});

const text = value => (value == null ? '' : String(value).trim());
const asPoints = coordinates => (coordinates ?? [])
  .filter(pair => Array.isArray(pair) && Number.isFinite(pair[0]) && Number.isFinite(pair[1]))
  .map(([longitude, latitude]) => ({ longitude, latitude }));

/**
 * One GeoJSON FeatureCollection as candidate roads.
 *
 * Only LineStrings are taken; a MultiLineString is split into its parts so a projection is never
 * made across a gap between two disjoint pieces of road.
 */
export function roadsFromGeoJson(geojson, { kind, label, direction = null } = {}) {
  const out = [];
  for (const feature of geojson?.features ?? []) {
    const properties = feature?.properties ?? {};
    const lines = feature?.geometry?.type === 'LineString'
      ? [feature.geometry.coordinates]
      : feature?.geometry?.type === 'MultiLineString' ? feature.geometry.coordinates : [];
    lines.forEach((line, part) => {
      const path = asPoints(line);
      if (path.length < 2) return;
      out.push({
        id: `${text(properties.id) || text(properties['@id']) || text(properties.segment_id) || 'road'}${lines.length > 1 ? `#${part}` : ''}`,
        kind,
        label: label?.(properties) ?? (text(properties.name) || null),
        direction: direction?.(properties) ?? (text(properties.direction) || null),
        properties,
        path,
      });
    });
  }
  return out;
}

/**
 * The piece of road an incident is on, or null.
 *
 * @param {{longitude: number, latitude: number}} point
 * @param {object[]} roads  from roadsFromGeoJson
 * @returns {{road, metres, at, kind, label, direction, confidence}|null}
 */
export function matchIncidentRoad(point, roads, {
  reachMeters = ROAD_PAINT_CONFIG.reachMeters,
  confidentWithinMeters = ROAD_PAINT_CONFIG.confidentWithinMeters,
} = {}) {
  if (!Number.isFinite(point?.longitude) || !Number.isFinite(point?.latitude)) return null;
  let best = null;
  for (const road of roads ?? []) {
    const near = nearestOnPath(road.path, point);
    if (!near || near.metres > reachMeters) continue;
    // A clearly closer road wins outright; within a metre of each other the more specific one does,
    // because "on the ramp" is a better answer than "beside the mainline that the ramp leaves".
    const better = !best
      || near.metres < best.metres - 1
      || (Math.abs(near.metres - best.metres) <= 1 && SPECIFICITY[road.kind] < SPECIFICITY[best.road.kind]);
    if (better) best = { road, metres: near.metres, at: near.at };
  }
  if (!best) return null;
  return {
    road: best.road,
    metres: Math.round(best.metres),
    at: best.at,
    kind: best.road.kind,
    label: best.road.label,
    direction: best.road.direction,
    // Said plainly, because a 50 m offset from a published line is not a lane-level fix.
    confidence: best.metres <= confidentWithinMeters ? 'HIGH' : 'APPROXIMATE',
  };
}

/**
 * The stretch of the matched road to colour: `halfLengthMeters` each way from the incident.
 *
 * Returns [] rather than the whole road when the incident is out of reach, so nothing is ever
 * painted on a road the incident was not matched to.
 */
export function roadPaintSlice(match, point, {
  halfLengthMeters = ROAD_PAINT_CONFIG.halfLengthMeters,
  reachMeters = ROAD_PAINT_CONFIG.reachMeters,
} = {}) {
  if (!match?.road?.path?.length) return [];
  return sliceAround(match.road.path, point, halfLengthMeters, { reachMeters });
}

/** How the matched road reads on screen. Never more specific than the data. */
/**
 * A road's name, as a label rather than as a data field.
 *
 * Ramp destinations are published as semicolon-separated lists of everywhere the ramp leads —
 * "Port Everglades;Fort Lauderdale-Hollywood International Airport" is 63 characters and 10 of the
 * 25 distinct values carry more than one. On a map chip that becomes a banner across the corridor,
 * so the first destination is used and the rest are dropped. The full value stays on the entity for
 * anyone who hovers.
 */
export function roadLabelText(label, { maxLength = 24 } = {}) {
  const first = text(label).split(';')[0].trim();
  if (!first) return null;
  return first.length > maxLength ? `${first.slice(0, maxLength - 1).trimEnd()}…` : first;
}

export function describeRoadMatch(match) {
  if (!match) return null;
  const kindLabel = {
    [ROAD_KINDS.RAMP]: 'Ramp / connector',
    [ROAD_KINDS.FRONTAGE]: 'Frontage road',
    [ROAD_KINDS.EXPRESS]: 'I-595 Express',
    [ROAD_KINDS.MAINLINE_SECTION]: 'I-595 mainline',
    [ROAD_KINDS.MAINLINE]: 'I-595 mainline',
  }[match.kind] ?? 'Roadway';
  const parts = [roadLabelText(match.label) || kindLabel];
  if (match.label && match.label !== kindLabel) parts.push(kindLabel);
  if (match.direction) parts.push(match.direction);
  return {
    kindLabel,
    title: parts[0],
    detail: `${parts.slice(1).join(' · ')}${parts.length > 1 ? ' · ' : ''}${match.metres} m from the reported position`,
    confidence: match.confidence,
  };
}
