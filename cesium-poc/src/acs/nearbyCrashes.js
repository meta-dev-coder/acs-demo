/**
 * What else has happened at this spot.
 *
 * A case tells an operator about one event. The question it raises — "is this a bad place, or was
 * this bad luck?" — is answerable only from the record of everything else that happened nearby,
 * and the corridor already HAS that record: the DataConnect incident register, the same 178 crash
 * rows the Safety Intelligence screen counts and the Asset Explorer lists.
 *
 * SO NOTHING HERE IS INVENTED. The brief offered a choice between synthetic aggregate data and
 * using the real register by coordinate, and the register wins on every count: it is real, it is
 * already loaded for this screen, and it carries the three facts that make a history worth
 * reading — whether anyone was hurt, whether lanes closed, and what kind of event it was.
 *
 * Two things this module refuses to do:
 *
 *   IT DOES NOT RANK A PLACE AS "HIGH RISK". Counting crashes in a circle is exposure, not risk:
 *   a busy interchange has more crashes than a quiet ramp because more traffic passes through it,
 *   and without volume per location — which this corridor has no feed for — a rate cannot be
 *   computed. It reports the count and the radius and lets a person judge.
 *
 *   IT DOES NOT TREAT THE CASE'S OWN INCIDENT AS HISTORY. A demo case borrows a real incident's
 *   coordinates, so that incident sits at distance zero and would otherwise be reported back as
 *   "a previous crash at this spot", which it is not.
 */

const EARTH_RADIUS_M = 6_371_000;
const RADIANS = Math.PI / 180;
/**
 * Metres per degree of latitude, DERIVED from the same sphere the distance uses.
 *
 * The literal 111_320 is the usual figure and it disagrees with a 6371 km sphere by about one
 * part in a thousand — which is nothing on a map and everything in a bounding box, where it made
 * the box very slightly smaller than the radius it was built for and so able to clip a crash the
 * distance filter had just accepted. One constant, no disagreement.
 */
const METRES_PER_DEGREE_LAT = EARTH_RADIUS_M * RADIANS;

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than a flat approximation — not because the error matters at 500 m, but
 * because the same function is used for the radius filter and the per-crash distance shown on
 * screen, and a figure a reader can check against a map should be the real one.
 */
export function distanceMetres(a, b) {
  if (![a?.longitude, a?.latitude, b?.longitude, b?.latitude].every(Number.isFinite)) return null;
  const dLat = (b.latitude - a.latitude) * RADIANS;
  const dLon = (b.longitude - a.longitude) * RADIANS;
  const lat1 = a.latitude * RADIANS;
  const lat2 = b.latitude * RADIANS;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The radii offered. 150 m is "this spot"; 1 km is "this stretch of road". */
export const RADII_M = Object.freeze([150, 400, 1000]);
export const DEFAULT_RADIUS_M = 400;

const text = value => {
  const out = String(value ?? '').trim();
  return out && out.toLowerCase() !== 'null' ? out : null;
};
/** The register writes these as "Y"/"N" strings, not booleans. */
const isYes = value => /^y(es)?$/i.test(String(value ?? '').trim());
const yearOf = value => {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? new Date(ms).getUTCFullYear() : null;
};

/** One crash, reduced to what a history needs, plus how far away it is. */
function shape(crash, metres) {
  const fatalities = Number(crash?.related?.fatalities);
  return Object.freeze({
    id: text(crash?.id),
    type: text(crash?.title) ?? 'Incident type not recorded',
    date: text(crash?.createdDate),
    year: yearOf(crash?.createdDate),
    distanceM: Math.round(metres),
    segment: text(crash?.segmentName),
    description: text(crash?.description),
    assetId: text(crash?.assetId),
    assetType: text(crash?.assetType),
    rootCause: text(crash?.related?.rootCause),
    injuries: isYes(crash?.related?.injuries),
    fatalities: Number.isFinite(fatalities) ? fatalities : 0,
    laneClosure: isYes(crash?.related?.laneClosure),
    longitude: crash?.longitude,
    latitude: crash?.latitude,
    /** The register's own ids are not FL511-shaped; the live feed's are. */
    source: /^FL511-/i.test(String(crash?.id ?? '')) ? 'FL511 live feed' : 'Incident register',
  });
}

/**
 * Every recorded incident within `radiusM` of a point, nearest first.
 *
 * @param {{longitude: number, latitude: number}} point the case's own location
 * @param {object[]} crashes the loaded incident register (and live events merged into it)
 * @param {{radiusM?: number, excludeIds?: Iterable<string>, limit?: number}} [options]
 *   `excludeIds` drops the case's OWN source incident, which sits at distance zero.
 */
export function crashesNear(point, crashes, { radiusM = DEFAULT_RADIUS_M, excludeIds = [],
  limit = 200 } = {}) {
  if (!Number.isFinite(point?.longitude) || !Number.isFinite(point?.latitude)) {
    return Object.freeze({ available: false, radiusM, records: Object.freeze([]),
      reason: 'This case has no located source incident, so there is no point to search around.' });
  }
  const skip = new Set([...excludeIds].filter(Boolean).map(String));
  const found = [];
  for (const crash of Array.isArray(crashes) ? crashes : []) {
    if (skip.has(String(crash?.id ?? ''))) continue;
    const metres = distanceMetres(point, crash);
    if (metres == null || metres > radiusM) continue;
    found.push(shape(crash, metres));
  }
  found.sort((a, b) => a.distanceM - b.distanceM);
  return Object.freeze({
    available: true,
    radiusM,
    /** Everything inside the radius, before `limit` — so "showing 50 of 61" can be said. */
    total: found.length,
    records: Object.freeze(found.slice(0, limit)),
    reason: null,
  });
}

const countBy = (records, pick) => {
  const counts = new Map();
  for (const record of records) {
    const key = pick(record);
    if (key == null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([key, count]) => ({ key, count }));
};

/**
 * The aggregate, over whatever was found.
 *
 * Counts only. No rate, no score, no "risk level" — see the note at the top of this file: without
 * traffic volume per location, a count in a circle cannot become a rate, and a score invented
 * from one would be the kind of number this application refuses to draw.
 */
export function summarise(found) {
  const records = found?.records ?? [];
  const years = records.map(record => record.year).filter(Number.isFinite);
  return Object.freeze({
    total: found?.total ?? records.length,
    withInjuries: records.filter(record => record.injuries).length,
    fatalities: records.reduce((sum, record) => sum + record.fatalities, 0),
    withLaneClosure: records.filter(record => record.laneClosure).length,
    byType: countBy(records, record => record.type),
    byYear: countBy(records, record => record.year).sort((a, b) => b.key - a.key),
    earliestYear: years.length ? Math.min(...years) : null,
    latestYear: years.length ? Math.max(...years) : null,
    nearestM: records.length ? records[0].distanceM : null,
    /** Said on screen beside every count, because a count in a circle is exposure, not risk. */
    caveat: 'Counts of recorded incidents within the radius. This is exposure, not a crash rate: '
      + 'no traffic volume is published per location, so these counts cannot be turned into a '
      + 'rate and must not be read as one.',
  });
}

/** Metres, as a person reads them. */
export const distanceLabel = metres =>
  (metres == null ? 'distance unknown' : metres < 950 ? `${metres} m away` : `${(metres / 1000).toFixed(1)} km away`);

/** A rough bounding box, for callers that want to frame the map around the history. */
export function boundsOf(point, radiusM) {
  if (!Number.isFinite(point?.longitude) || !Number.isFinite(point?.latitude)) return null;
  const dLat = radiusM / METRES_PER_DEGREE_LAT;
  const dLon = radiusM / (METRES_PER_DEGREE_LAT * Math.cos(point.latitude * RADIANS));
  return Object.freeze({ west: point.longitude - dLon, east: point.longitude + dLon,
    south: point.latitude - dLat, north: point.latitude + dLat });
}
