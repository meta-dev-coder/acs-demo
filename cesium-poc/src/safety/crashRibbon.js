/**
 * Painting a hotspot onto the road itself, instead of drawing a circle over it.
 *
 * A circle says "somewhere in this disc". Crashes happen ON the carriageway, so the honest mark is
 * the carriageway: the stretch of road within the grouping radius of the place, coloured by that
 * place's risk band. It also stops the corridor disappearing under overlapping translucent discs
 * once the whole history is on screen.
 *
 * This module is the geometry only — given a road's own vertices it returns the piece of it that
 * belongs to a place. It knows nothing about Cesium, so it can be reasoned about and tested on its
 * own; `safetyWorkspace.js` turns what comes back into a polyline.
 */
import { metresBetween } from './crashHotspots.js';

/**
 * How far off a road a place may sit and still be painted onto it.
 *
 * Crash coordinates are reported to a few metres and the corridor centreline is one line down a
 * carriageway that is tens of metres wide, so a place almost never lands exactly on it. Beyond this
 * the nearest road is not the road the crash was on — a service road beside the corridor, or the
 * far carriageway — and painting it would be a claim the data does not support.
 */
export const RIBBON_REACH_M = 120;

/**
 * Where a path passes closest to a point, ON the line rather than at a vertex.
 *
 * Projecting onto each leg, not just measuring to its ends. The corridor is published with legs up
 * to 1.4 km, so a crash halfway along one is the better part of a kilometre from the nearest
 * vertex — measuring to vertices put it out of reach and painted nothing at all, silently.
 *
 * @param {{longitude: number, latitude: number}[]} path
 * @param {{longitude: number, latitude: number}} point
 * @returns {{index: number, metres: number, at: {longitude, latitude}}|null} `index` is the leg's
 *   first vertex and `at` the closest point on it; null for an empty path.
 */
export function nearestOnPath(path, point) {
  if (!path?.length) return null;
  if (path.length === 1) return { index: 0, metres: metresBetween(path[0], point), at: path[0] };
  let best = null;
  for (let index = 0; index < path.length - 1; index++) {
    const at = closestOnLeg(path[index], path[index + 1], point);
    const metres = metresBetween(at, point);
    if (!best || metres < best.metres) best = { index, metres, at };
  }
  return best;
}

/**
 * The point on the leg a→b closest to p.
 *
 * Longitude is scaled by cos(latitude) so a degree east counts for what it is worth on the ground;
 * without it the projection leans north-south and lands off the road.
 */
function closestOnLeg(a, b, p) {
  const k = Math.cos((a.latitude * Math.PI) / 180);
  const ax = a.longitude * k, ay = a.latitude;
  const bx = b.longitude * k, by = b.latitude;
  const dx = bx - ax, dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return a;
  const t = Math.max(0, Math.min(1, (((p.longitude * k) - ax) * dx + (p.latitude - ay) * dy) / lengthSq));
  return pointAlong(a, b, t);
}

/**
 * The run of road within `metres` either side of where the path passes closest to `point`.
 *
 * Measured ALONG the road, not as the crow flies, so a hotspot on a curve gets the same length of
 * carriageway as one on a straight. The last leg is cut part-way, so the run is the length claimed
 * however coarsely the road happens to be drawn. The walk stops at the ends of the path rather than
 * wrapping, so a place at the end of the corridor is painted short instead of jumping to the other
 * end.
 *
 * @param {{longitude: number, latitude: number}[]} path   one carriageway, in travel order
 * @param {{longitude: number, latitude: number}} point    the hotspot's centre
 * @param {number} metres                                  half-length, each way
 * @param {{reachMeters?: number}} [options]
 * @returns {{longitude: number, latitude: number}[]} the slice, or [] when the path is out of reach
 */
export function sliceAround(path, point, metres, { reachMeters = RIBBON_REACH_M } = {}) {
  const near = nearestOnPath(path, point);
  if (!near || near.metres > reachMeters) return [];

  // Walk out to EXACTLY `metres` each way from where the road passes the crash, cutting the last
  // leg part-way rather than taking all of it. Snapping to whole vertices looked right until it met
  // the real corridor: FDOT publishes legs up to 1.4 km, so one step past the budget painted
  // kilometres of road for a 100 m claim — a single crash coloured half the map.
  const back = [];
  let from = near.at;
  for (let i = near.index, walked = 0; ; i--) {
    const leg = metresBetween(from, path[i]);
    if (walked + leg >= metres) { back.push(pointAlong(from, path[i], (metres - walked) / leg)); break; }
    walked += leg;
    back.push(path[i]);
    if (i === 0) break;
    from = path[i];
  }
  const forward = [];
  let ahead = near.at;
  for (let i = near.index + 1, walked = 0; ; i++) {
    const leg = metresBetween(ahead, path[i]);
    if (walked + leg >= metres) { forward.push(pointAlong(ahead, path[i], (metres - walked) / leg)); break; }
    walked += leg;
    forward.push(path[i]);
    if (i === path.length - 1) break;
    ahead = path[i];
  }
  // The projected point can BE a vertex (a crash opposite one), which would otherwise be pushed
  // twice and leave a zero-length step in the drawn line.
  const same = (a, b) => a.longitude === b.longitude && a.latitude === b.latitude;
  const slice = [...back.reverse(), near.at, ...forward].filter(
    (pt, i, all) => i === 0 || !same(pt, all[i - 1]));
  return slice.length > 1 ? slice : [];
}

/** A point a fraction of the way from `a` to `b`. Straight in lon/lat, which over 100 m is exact enough. */
export function pointAlong(a, b, fraction) {
  const t = Math.max(0, Math.min(1, fraction));
  return {
    longitude: a.longitude + (b.longitude - a.longitude) * t,
    latitude: a.latitude + (b.latitude - a.latitude) * t,
  };
}

/**
 * Every painted stretch, ordered so the worst band is drawn last.
 *
 * Neighbouring places overlap — 100 m apart on a corridor is common — and whichever is drawn last
 * is the colour the operator sees. Sorting by score means the overlap always resolves towards the
 * more dangerous reading, never away from it, whatever order the places arrived in.
 *
 * @param {object[]} places   hotspots, each with `score`
 * @param {{longitude: number, latitude: number}[][]} paths   the carriageways
 * @param {number} metres
 * @returns {{place: object, path: {longitude: number, latitude: number}[]}[]}
 */
export function ribbonsFor(places, paths, metres) {
  const ribbons = [];
  for (const place of [...places].sort((a, b) => (a.score ?? 0) - (b.score ?? 0))) {
    for (const path of paths) {
      const slice = sliceAround(path, place, metres);
      if (slice.length > 1) ribbons.push({ place, path: slice });
    }
  }
  return ribbons;
}
