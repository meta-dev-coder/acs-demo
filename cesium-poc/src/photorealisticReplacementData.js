/**
 * Photorealistic replacement: which corridor models stand in for Google's own photogrammetry.
 *
 * A record that carries a `photorealisticReplacement` polygon is saying "the mesh Google already
 * has here is the one my GLB replaces, so cut it out of the tileset". This module is the reading
 * and validating half — no Cesium, no DOM — so the rules are testable on their own.
 *
 * Polygons are stored as [longitude, latitude] pairs, the order Cartesian3.fromDegreesArray takes.
 * Storing them the other way round is the single easiest way to get this wrong, so the validator
 * rejects anything that cannot be a lon/lat pair.
 */

export const REPLACEMENT_KEY = 'photorealisticReplacement';

/**
 * How a model deals with the photogrammetry it replaces.
 *
 * CLIPPING_POLYGON cuts a geographic region out of the tileset. That removes the structure, but it
 * removes everything else in the column too — road surface, embankment, whatever is behind — which
 * is why an oblique view through a clipped region shows a hole rather than a road.
 *
 * OCCLUSION leaves the tileset alone and lets the replacement mesh hide the original by standing in
 * front of it. Nothing is deleted: how much of the original disappears depends entirely on how
 * completely the replacement covers it from the angle being looked at.
 *
 * NONE loads the model and leaves the photogrammetry visible, for a record not yet decided.
 */
export const REPLACEMENT_STRATEGIES = Object.freeze({
  CLIPPING_POLYGON: 'CLIPPING_POLYGON',
  OCCLUSION: 'OCCLUSION',
  NONE: 'NONE',
});

/**
 * A record's strategy. Records written before this field existed carry a polygon and meant to clip
 * with it, so that stays the default when a polygon is present.
 */
export function replacementStrategy(replacement) {
  const declared = replacement?.strategy;
  if (declared && Object.hasOwn(REPLACEMENT_STRATEGIES, declared)) return declared;
  // Presence of the key, not its validity: a record carrying a broken polygon meant to clip and
  // should be told so, rather than quietly reinterpreted as having chosen to do nothing.
  return Array.isArray(replacement?.clippingPolygon)
    ? REPLACEMENT_STRATEGIES.CLIPPING_POLYGON
    : REPLACEMENT_STRATEGIES.NONE;
}

/** A clipping polygon needs at least a triangle. */
export const MIN_POLYGON_POINTS = 3;

/** Roughly 11 mm at this latitude — far finer than the polygon needs, and stable to read. */
export const COORDINATE_PRECISION = 7;

export const roundCoordinate = value => Number(Number(value).toFixed(COORDINATE_PRECISION));

const isLongitude = value => Number.isFinite(value) && Math.abs(value) <= 180;
const isLatitude = value => Number.isFinite(value) && Math.abs(value) <= 90;

/**
 * Validate one polygon as stored in the config.
 * @returns {{ok: true, polygon: [number, number][]} | {ok: false, reason: string}}
 */
export function readClippingPolygon(value) {
  if (!Array.isArray(value)) return { ok: false, reason: 'clippingPolygon is not an array' };
  if (value.length < MIN_POLYGON_POINTS) {
    return { ok: false, reason: `clippingPolygon needs at least ${MIN_POLYGON_POINTS} points, has ${value.length}` };
  }
  const polygon = [];
  for (const [index, point] of value.entries()) {
    if (!Array.isArray(point) || point.length < 2) return { ok: false, reason: `point ${index + 1} is not a [longitude, latitude] pair` };
    const [longitude, latitude] = point.map(Number);
    // Latitude first would put a Florida longitude of -80 in the latitude slot, which still fits
    // ±90 — so this catches gross errors only. The field order is the real contract.
    if (!isLongitude(longitude)) return { ok: false, reason: `point ${index + 1} longitude ${point[0]} is out of range` };
    if (!isLatitude(latitude)) return { ok: false, reason: `point ${index + 1} latitude ${point[1]} is out of range` };
    polygon.push([roundCoordinate(longitude), roundCoordinate(latitude)]);
  }
  return { ok: true, polygon };
}

/**
 * Every model that declares how it handles the photogrammetry it replaces.
 *
 * A polygon is read and kept whatever the strategy: switching a model to OCCLUSION must not lose
 * coordinates that were drawn by hand, so returning to clipping later costs nothing.
 * @param {object[]} configs  records from cesiumModels.json
 * @returns {{records: {id, name, strategy, polygon}[], clipping: object[], skipped: {id, reason}[]}}
 */
export function replacementRecords(configs) {
  const records = [], skipped = [];
  for (const config of Array.isArray(configs) ? configs : []) {
    const replacement = config?.[REPLACEMENT_KEY];
    // No replacement block, or switched off, is the ordinary case and not worth reporting.
    if (!replacement || replacement.enabled !== true) continue;
    const strategy = replacementStrategy(replacement);
    const parsed = readClippingPolygon(replacement.clippingPolygon);
    if (!parsed.ok) {
      // A polygon is only required by the strategy that uses one.
      if (strategy === REPLACEMENT_STRATEGIES.CLIPPING_POLYGON) {
        skipped.push({ id: config.id ?? '(no id)', reason: parsed.reason });
        continue;
      }
      records.push({ id: config.id, name: config.name ?? config.id, strategy, polygon: null });
      continue;
    }
    records.push({ id: config.id, name: config.name ?? config.id, strategy, polygon: parsed.polygon });
  }
  return {
    records,
    // Only these reach the tileset; the rest keep their coordinates without cutting anything.
    clipping: records.filter(record => record.strategy === REPLACEMENT_STRATEGIES.CLIPPING_POLYGON && record.polygon),
    skipped,
  };
}

/** [[lon, lat], …] → [lon, lat, lon, lat, …], the shape Cartesian3.fromDegreesArray takes. */
export const flattenPolygon = polygon => polygon.flatMap(([longitude, latitude]) => [longitude, latitude]);

/**
 * The block to paste into a model's record in cesiumModels.json. Generated here rather than typed
 * by hand so the key names and the coordinate order cannot drift from what the loader reads.
 */
export function formatReplacementJson(polygon, strategy = REPLACEMENT_STRATEGIES.CLIPPING_POLYGON) {
  const points = polygon.map(([longitude, latitude]) => `      [${roundCoordinate(longitude)}, ${roundCoordinate(latitude)}]`).join(',\n');
  return `"${REPLACEMENT_KEY}": {\n  "enabled": true,\n  "strategy": "${strategy}",\n  "clippingPolygon": [\n${points}\n  ]\n}`;
}
