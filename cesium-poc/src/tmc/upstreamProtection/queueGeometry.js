/**
 * Where a simulated queue can actually be drawn, and how much of it cannot.
 *
 * This module exists because of a measured defect: `centerlineSliceBetween` clamps to the ends of
 * the published corridor, so a 5,000 m modelled queue near the west end rendered as 501 m while
 * the panel went on claiming 5 km. The map and the number disagreed and nothing said so.
 *
 * So the modelled length and the rendered length are now two different values, both reported:
 *
 *   modelledMeters   what the scenario's own arithmetic produced
 *   renderedMeters   how much of that fits on geometry we actually have
 *   clipped          whether those two differ, and by how much
 *
 * WHICH GEOMETRY THE QUEUE IS DRAWN ON — measured, then changed:
 *
 * The first version used the shared corridor centerline. Measured against the published section
 * geometry, that line sits a median of 143 m (up to 332 m) from the WESTBOUND carriageway and only
 * 38 m from the eastbound one — it tracks the EB side. So on a westbound incident the queue was
 * visibly drawn off the road the incident was on, which is exactly what it looked like.
 *
 * The corridor does publish per-carriageway section geometry (`I595-WB-FDOT-…`), so when the
 * incident's own carriageway sections are available the queue is drawn along THOSE, in travel
 * order. The band then follows the roadway the traffic is actually queueing on.
 *
 * The shared centerline remains the fallback when section geometry is missing, and only then is
 * the result a corridor-axis approximation. Either way this is still a LENGTH model: it says how
 * far back the queue reaches, never which lanes it occupies, and no lateral offset is invented.
 *
 * Deterministic and pure: distances in, distances out. No Cesium, no clock, no randomness.
 */
import { centerlineDistances, corridorPositionOf } from '../../assetExplorer/corridorPosition.js';
import { CARRIAGEWAYS } from '../../liveOps/carriagewayModel.js';
import { upstreamStep } from '../upstreamResolver.js';
import { centerlineSliceBetween, normaliseCenterline, pointAtDistance } from '../patrol/patrolRouting.js';

const METRES_PER_MILE = 1609.344;

/** Why no queue can be placed. Each maps to a sentence the operator reads verbatim. */
export const QUEUE_GEOMETRY_UNRESOLVED = Object.freeze({
  NO_GEOMETRY: 'Corridor geometry unavailable',
  CARRIAGEWAY: 'Upstream approach unresolved — no direction to place a queue along',
  NOT_PROJECTED: 'The incident could not be placed on the corridor centerline',
  NO_ROOM: 'The incident is at the end of the modelled corridor — no upstream extent to draw',
});

const unresolved = reason => Object.freeze({
  resolved: false, reason,
  modelledMeters: null, renderedMeters: null, availableMeters: null,
  clipped: false, clippedByMeters: 0,
  tail: null, path: Object.freeze([]),
});

/**
 * How much modelled corridor lies upstream of a point, before the published geometry runs out.
 *
 * This is the budget a queue has. Eastbound traffic arrives from the lower end, so its upstream
 * room is everything behind it; westbound is the mirror image on the same line.
 */
export function availableUpstreamMeters(incidentAlongM, corridorLengthM, carriageway) {
  const step = upstreamStep(carriageway);
  if (step === 0 || !Number.isFinite(incidentAlongM) || !Number.isFinite(corridorLengthM)) return null;
  // step -1 (eastbound): upstream is towards 0. step +1 (westbound): upstream is towards the far end.
  return step === -1 ? incidentAlongM : corridorLengthM - incidentAlongM;
}

/**
 * Place a simulated queue on the corridor.
 *
 * @param {{incident: object, centerline: object[], modelledMeters: number,
 *          upstreamResolved: boolean, elapsedMinutes: number|null}} input
 * @returns {object} the geometry, with the modelled and rendered lengths kept apart
 */
export function simulatedQueueGeometry({
  incident, centerline = [], carriagewayPath = [], modelledMeters, upstreamResolved = false,
  elapsedMinutes = null,
} = {}) {
  /**
   * The incident's own carriageway when it is published, the shared centerline otherwise.
   *
   * `onCarriageway` is carried through to the caller so the UI can say which one it got rather
   * than claiming carriageway accuracy it may not have.
   */
  const lane = normaliseCenterline(carriagewayPath);
  const onCarriageway = lane.length >= 2;
  const path = onCarriageway ? lane : normaliseCenterline(centerline);
  if (path.length < 2) return unresolved(QUEUE_GEOMETRY_UNRESOLVED.NO_GEOMETRY);
  // No direction, no queue. A queue drawn without a resolved approach would be pointing at a guess.
  const carriageway = incident?.carriageway ?? CARRIAGEWAYS.UNKNOWN;
  if (!upstreamResolved || upstreamStep(carriageway) === 0) {
    return unresolved(QUEUE_GEOMETRY_UNRESOLVED.CARRIAGEWAY);
  }
  if (!Number.isFinite(modelledMeters) || modelledMeters <= 0) {
    return unresolved(QUEUE_GEOMETRY_UNRESOLVED.NO_ROOM);
  }

  const distances = centerlineDistances(path);
  const corridorLengthM = distances[distances.length - 1];
  const here = corridorPositionOf(incident.longitude, incident.latitude, path, distances);
  // `milepost` is distance ALONG the path; `offsetM` is the lateral distance OFF it. Only the
  // first one can be travelled back along.
  const incidentAlongM = Number.isFinite(here?.milepost) ? here.milepost * METRES_PER_MILE : null;
  if (!Number.isFinite(incidentAlongM)) return unresolved(QUEUE_GEOMETRY_UNRESOLVED.NOT_PROJECTED);

  /**
   * Upstream is backwards along whichever path we are on.
   *
   * A carriageway path is already built in TRAVEL order, so upstream is simply towards its start.
   * The shared centerline is published west-to-east regardless of direction, so there the
   * carriageway decides the sign — which is what upstreamStep encodes.
   */
  const step = onCarriageway ? -1 : upstreamStep(carriageway);
  const available = step === -1 ? incidentAlongM : corridorLengthM - incidentAlongM;
  if (!Number.isFinite(available) || available < 1) return unresolved(QUEUE_GEOMETRY_UNRESOLVED.NO_ROOM);

  // The clip. The scenario keeps its own number; the map only ever draws what exists.
  const rendered = Math.min(modelledMeters, available);
  const clipped = rendered < modelledMeters - 1;
  const tailAlongM = step === -1 ? incidentAlongM - rendered : incidentAlongM + rendered;
  const tailPoint = pointAtDistance(path, tailAlongM);

  return Object.freeze({
    resolved: true,
    reason: null,
    carriageway,
    /** What the scenario's arithmetic produced. Reported even when it cannot all be drawn. */
    modelledMeters: Math.round(modelledMeters),
    /** What fits on published geometry. This is what the map draws. */
    renderedMeters: Math.round(rendered),
    availableMeters: Math.round(available),
    clipped,
    clippedByMeters: clipped ? Math.round(modelledMeters - rendered) : 0,
    /**
     * The tail: the upstream end of the queue, which is the thing an operator is looking for.
     * Its distance is measured along the corridor, not as the crow flies.
     */
    tail: Object.freeze({
      longitude: tailPoint.lon,
      latitude: tailPoint.lat,
      alongM: tailAlongM,
      /** Distance upstream of the incident, along modelled geometry. */
      upstreamMeters: Math.round(rendered),
      upstreamKm: Math.round((rendered / 1000) * 100) / 100,
      elapsedMinutes,
      simulated: true,
    }),
    incidentAlongM,
    /** Which geometry this was drawn on, so the caption can be honest about it. */
    onCarriageway,
    path: Object.freeze(centerlineSliceBetween(path, incidentAlongM, tailAlongM)),
    approximation: onCarriageway
      ? `Drawn along the published ${carriageway === CARRIAGEWAYS.WB_GENERAL ? 'westbound' : 'eastbound'} `
        + 'carriageway sections. A length model, not a lane-level footprint — it shows how far back '
        + 'the simulated queue reaches, not which lanes it occupies.'
      : 'Corridor-axis approximation — no carriageway section geometry was available, so this falls '
        + 'back to the centerline shared by both directions. It shows how far back along the corridor '
        + 'the simulated queue reaches, not which lanes it occupies.',
    clipNotice: clipped
      ? 'Simulated queue exceeds mapped upstream extent. Visible extent clipped to available geometry.'
      : null,
  });
}

/**
 * Where a resource sits relative to the simulated queue tail, along the same corridor axis.
 *
 * Deliberately returns geometry and nothing else. Whether a sign upstream of the tail actually
 * warned anybody depends on activation, visibility, driver exposure and compliance — none of which
 * is published — so this says where things are and refuses to say what that achieved.
 */
export function resourceVersusQueueTail({ resourceUpstreamMeters, queue } = {}) {
  if (!queue?.resolved || !Number.isFinite(resourceUpstreamMeters)) {
    return Object.freeze({ comparable: false, reason: 'No resolved queue or resource position to compare' });
  }
  const tailMeters = queue.tail.upstreamMeters;
  const beyondTail = resourceUpstreamMeters > tailMeters;
  return Object.freeze({
    comparable: true,
    resourceUpstreamMeters,
    tailUpstreamMeters: tailMeters,
    separationMeters: Math.abs(resourceUpstreamMeters - tailMeters),
    /** True when the sign is further upstream than the queue has reached. Geometry only. */
    upstreamOfTail: beyondTail,
    statement: beyondTail
      ? 'DMS lies upstream of simulated queue tail. Warning activation unknown.'
      : 'Simulated queue tail extends beyond this DMS position. Warning activation unknown.',
    caveat: 'Geometric relationship only. A sign\'s position does not establish message activation, '
      + 'visibility, driver exposure, compliance or any change in collision likelihood.',
  });
}
