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

import { crashSeverityTier } from '../assetExplorer/incidentTypes.js';

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
 * How bad one crash was.
 *
 * The register carries no severity column — the incident class records what HAPPENED instead, and
 * the normaliser says so: "severity is expressed by injuries, fatalities and closures". So severity
 * is read from those three, in that order of seriousness, and nothing is inferred from the crash's
 * wording or its type.
 */
export const CRASH_SEVERITY_WEIGHTS = Object.freeze({ severe: 10, high: 5, intermediate: 3, minor: 1 });

/** The tier itself lives with the incident taxonomy, so the panel and the map cannot disagree. */
export const crashSeverity = crashSeverityTier;

/**
 * How hot one place is: every crash on it, weighted by how bad it was.
 *
 * Count alone cannot separate twenty scrapes from ten crashes that put people in hospital — both
 * read as "a lot happened here", and only one of them is a place to send a crew. Ten high-severity
 * crashes score 50 and twenty minor ones score 20, which is the ordering an operator means.
 */
export const hotspotScore = crashes =>
  (crashes ?? []).reduce((total, crash) => total + CRASH_SEVERITY_WEIGHTS[crashSeverity(crash)], 0);

/**
 * The bands, in weighted score rather than raw count.
 *
 * Absolute rather than relative to the worst place: a relative scale always paints something red,
 * even where nothing much has happened, and "the worst of these" is not the same claim as
 * "dangerous". The legend names the bands without printing the numbers, because the number an
 * operator should read is the crash COUNT on the circle, not the score behind its colour.
 */
export const CRASH_BANDS = Object.freeze([
  Object.freeze({ id: 'SEVERE', label: 'Severe', from: 40, color: '#e66259' }),
  Object.freeze({ id: 'HIGH', label: 'High', from: 25, color: '#ee9148' }),
  Object.freeze({ id: 'MODERATE', label: 'Moderate', from: 8, color: '#e5bc57' }),
  Object.freeze({ id: 'LOW', label: 'Low', from: 1, color: '#9ad97f' }),
]);
/** @param {number} score the weighted score, NOT the crash count. */
export const crashBandFor = score => CRASH_BANDS.find(band => score >= band.from) ?? null;

/**
 * The floor a single crash of each severity puts under its place's band.
 *
 * The score alone answers "how much harm has happened here", which is the right question for a
 * place where crashes pile up — but it made one serious crash green, because one crash can never
 * reach a threshold built for a pile. A fatality on an otherwise quiet stretch is not a low-risk
 * stretch. So severity sets a floor and the score can only raise it: twenty scrapes still climb to
 * Moderate on weight of numbers, and a single injury crash is never painted as if nothing happened.
 */
const BAND_FLOOR_BY_TIER = Object.freeze({
  severe: 'SEVERE', high: 'HIGH', intermediate: 'MODERATE', minor: 'LOW',
});

/**
 * The band for a place: whichever is worse, what its crashes add up to or the worst one in it.
 *
 * @param {number} score    the weighted score
 * @param {object[]} crashes the crashes at that place
 */
export function crashBandForPlace(score, crashes) {
  const byScore = crashBandFor(score);
  let worstIndex = CRASH_BANDS.length;
  for (const crash of crashes ?? []) {
    const floor = BAND_FLOOR_BY_TIER[crashSeverity(crash)] ?? 'LOW';
    worstIndex = Math.min(worstIndex, CRASH_BANDS.findIndex(band => band.id === floor));
  }
  const byWorst = CRASH_BANDS[worstIndex] ?? null;
  if (!byScore) return byWorst;
  if (!byWorst) return byScore;
  // Lower index is the hotter band, and the hotter of the two readings is the honest one.
  return CRASH_BANDS.indexOf(byScore) <= worstIndex ? byScore : byWorst;
}

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
      const score = hotspotScore(members);
      return Object.freeze({
        id: `hotspot:${members.map(m => m.id).sort()[0]}`,
        longitude, latitude, radiusMeters: Math.round(reach),
        // `count` is what the circle prints; `score` is what decides its colour.
        count: members.length, score, band: crashBandForPlace(score, members), crashes: members,
      });
    })
    .sort((a, b) => b.score - a.score || b.count - a.count || a.id.localeCompare(b.id));

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
