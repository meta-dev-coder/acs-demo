/**
 * Where the corridor's recorded crashes cluster.
 *
 * Every crash in the DataConnect incident register carries its own coordinates. Crashes standing
 * within `radiusMeters` of each other are one place, and every place is drawn — a lone crash as
 * Low, a pile of them as Severe — so nothing recorded is missing from the map.
 *
 * Deliberately NOT a colouring of the road. A segment painted end to end says "this mile is
 * dangerous" when the crashes are in fact piled at one interchange inside it; a circle says where.
 *
 * What this is NOT: a crash rate. Traffic volume is not in this data, so a busy place with many
 * crashes and a quiet one with the same number look alike here. It answers "where have crashes
 * happened", which is the question the register can answer, and the legend says so.
 */

const EARTH_RADIUS_M = 6_371_000;
const toRadians = degrees => (degrees * Math.PI) / 180;

/** Great-circle metres between two {longitude, latitude} points. */
export function metresBetween(a, b) {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, h)));
}

/**
 * How close two crashes must be to count as the same place.
 *
 * 100 m is a spot on the road rather than a stretch of it — a gore, a merge taper, one bridge span.
 * Wide enough that crashes recorded a little apart along the same manoeuvre still group; tight
 * enough that the circle is a claim about that spot and nothing further along.
 */
export const HOTSPOT_RADIUS_M = 100;
/**
 * Below this, a place is not drawn at all.
 *
 * One: every recorded crash appears somewhere. A lone crash is shown as Low rather than left off,
 * so an empty stretch on this map means "nothing recorded here" and not "something happened but it
 * did not meet a threshold".
 */
export const HOTSPOT_MIN_CRASHES = 1;

/**
 * The bands, in crashes inside one hotspot.
 *
 * Absolute rather than relative to the worst hotspot: a relative scale always paints something red,
 * even where nothing much has happened, and "the worst of these" is not the same claim as
 * "dangerous". The legend prints these numbers, so the colour is never a mystery.
 */
export const CRASH_BANDS = Object.freeze([
  Object.freeze({ id: 'SEVERE', label: 'Severe', from: 10, color: '#e66259' }),
  Object.freeze({ id: 'HIGH', label: 'High', from: 6, color: '#ee9148' }),
  Object.freeze({ id: 'MODERATE', label: 'Moderate', from: 3, color: '#e5bc57' }),
  Object.freeze({ id: 'LOW', label: 'Low', from: HOTSPOT_MIN_CRASHES, color: '#9ad97f' }),
]);
export const crashBandFor = count => CRASH_BANDS.find(band => count >= band.from) ?? null;

const placed = crash => Number.isFinite(crash?.longitude) && Number.isFinite(crash?.latitude);

/**
 * Group crashes into hotspots.
 *
 * Greedy and deterministic: the crash with the most neighbours within the radius seeds the first
 * hotspot and takes them with it, then the next densest of whatever is left, and so on. Ties break
 * on id, so the same records always produce the same hotspots — a map that rearranged itself
 * between two loads of identical data would be untrustworthy.
 *
 * @param {object[]} crashes incident records carrying longitude/latitude
 * @returns {{hotspots: object[], clustered: number, loose: number, unplaced: number}}
 */
export function clusterCrashes(crashes, { radiusMeters = HOTSPOT_RADIUS_M, minCrashes = HOTSPOT_MIN_CRASHES } = {}) {
  const points = (crashes ?? []).filter(placed)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const unplaced = (crashes ?? []).length - points.length;

  const neighbours = points.map(point =>
    points.filter(other => metresBetween(point, other) <= radiusMeters));
  const taken = new Set();
  const groups = [];

  for (;;) {
    let seed = -1, best = -1;
    for (let i = 0; i < points.length; i += 1) {
      if (taken.has(points[i].id)) continue;
      const free = neighbours[i].filter(other => !taken.has(other.id)).length;
      if (free > best) { best = free; seed = i; }
    }
    if (seed < 0 || best <= 0) break;
    const members = neighbours[seed].filter(other => !taken.has(other.id));
    for (const member of members) taken.add(member.id);
    groups.push(members);
  }

  const hotspots = groups
    .filter(members => members.length >= minCrashes)
    .map(members => {
      // The centre is the mean of its own crashes, so the circle sits where they actually are.
      const longitude = members.reduce((sum, m) => sum + m.longitude, 0) / members.length;
      const latitude = members.reduce((sum, m) => sum + m.latitude, 0) / members.length;
      const centre = { longitude, latitude };
      // Wide enough to contain every crash it claims, never smaller than the grouping radius.
      const reach = Math.max(radiusMeters, ...members.map(m => metresBetween(centre, m)));
      return Object.freeze({
        id: `hotspot:${members.map(m => m.id).sort()[0]}`,
        longitude, latitude, radiusMeters: Math.round(reach),
        count: members.length, band: crashBandFor(members.length), crashes: members,
      });
    })
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  const clustered = hotspots.reduce((sum, spot) => sum + spot.count, 0);
  return { hotspots, clustered, loose: points.length - clustered, unplaced };
}

/** The crash types in one hotspot, most common first — what its label and tooltip can say. */
export function crashBreakdown(hotspot) {
  const counts = new Map();
  for (const crash of hotspot?.crashes ?? []) {
    const title = crash.title ?? 'Crash';
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([title, count]) => ({ title, count }));
}
