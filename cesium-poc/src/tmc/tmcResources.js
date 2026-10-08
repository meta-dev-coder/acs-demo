/**
 * The cameras and signs that can see or warn the traffic approaching one incident.
 *
 * Upstream, not nearby. A camera 200 m past the incident shows traffic that has already gone by; a
 * sign on the far carriageway warns the wrong drivers. So resources are chosen by position ALONG
 * the corridor in the direction traffic is coming from, and anything downstream is dropped however
 * close it is.
 *
 * Two things this is careful never to claim:
 *
 *   - A camera being near an incident does NOT mean it is pointed at it. It is offered as somewhere
 *     to look, never as evidence about the incident.
 *   - A sign being upstream does NOT mean it is warning about this incident. The feed does not
 *     publish sign messages (`dms_message` is 0/61 and marked `pending` in the event field config),
 *     so nothing here may say a warning is active. It says "nearest upstream sign" and stops.
 *
 * Pure: resources and a corridor position in, the relevant ones out.
 */
import { corridorPositionOf } from '../assetExplorer/corridorPosition.js';
import { upstreamOffsetM, UPSTREAM_STATUS } from './upstreamResolver.js';

/** Beyond this an upstream resource is too far back to be about this incident. */
export const UPSTREAM_RESOURCE_REACH_M = 4_000;

const METRES_PER_MILE = 1609.344;
export const milesFrom = metres => (Number.isFinite(metres) ? metres / METRES_PER_MILE : null);

/**
 * The nearest resources upstream of an incident, nearest first.
 *
 * @param {object[]} resources   each with longitude/latitude and an id
 * @param {object} incident      normalised, with longitude/latitude and carriageway
 * @param {object} upstream      from upstreamSections()
 * @param {{centerline: number[][], reachMeters?: number}} options
 * @returns {{id, upstreamMeters, upstreamMiles, resource}[]}
 */
export function upstreamResources(resources, incident, upstream, { centerline, reachMeters = UPSTREAM_RESOURCE_REACH_M } = {}) {
  // Without a resolved direction there is no upstream, and offering "nearest" would be offering
  // whatever happens to be close — including things the traffic has already passed.
  if (upstream?.status !== UPSTREAM_STATUS.RESOLVED) return [];
  if (!centerline?.length) return [];

  // `milepost` is the distance ALONG the corridor; `offsetM` is how far off it the point lies —
  // the two are easy to confuse and only the first one orders anything upstream or downstream.
  const here = corridorPositionOf(incident.longitude, incident.latitude, centerline);
  if (!Number.isFinite(here?.milepost)) return [];

  return (resources ?? [])
    .map(resource => {
      if (!Number.isFinite(resource?.longitude) || !Number.isFinite(resource?.latitude)) return null;
      const at = corridorPositionOf(resource.longitude, resource.latitude, centerline);
      if (!Number.isFinite(at?.milepost)) return null;
      const metres = upstreamOffsetM(here.milepost * METRES_PER_MILE, at.milepost * METRES_PER_MILE, incident.carriageway);
      // Negative is downstream — the traffic has already passed it.
      if (metres == null || metres <= 0 || metres > reachMeters) return null;
      return { id: resource.id, resource, upstreamMeters: Math.round(metres), upstreamMiles: milesFrom(metres) };
    })
    .filter(Boolean)
    .sort((a, b) => a.upstreamMeters - b.upstreamMeters);
}

/** The nearest one, or null — what the panel shows when it shows a single resource. */
export const nearestUpstream = (...args) => upstreamResources(...args)[0] ?? null;

/**
 * How far upstream something is, as an operator would read it.
 *
 * Always says "upstream" rather than just a distance, because the direction is the whole point of
 * the number.
 */
export function upstreamLabel(entry) {
  if (!entry) return null;
  const miles = entry.upstreamMiles;
  if (miles != null && miles >= 0.1) return `${miles.toFixed(1)} mi upstream`;
  return `${entry.upstreamMeters} m upstream`;
}
