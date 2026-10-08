/**
 * Route-constrained movement along the corridor, and the refusal to pretend when it is not possible.
 *
 * WHAT THE PUBLISHED GEOMETRY SUPPORTS, measured before this was written:
 *   • one shared mainline centerline, with cumulative distances (centerlineDistances)
 *   • a projection from any point onto it (corridorPositionOf → milepost)
 *   • direction of travel per carriageway, from the corridor's own travel_order (upstreamOffsetM)
 *
 * WHAT IT DOES NOT SUPPORT:
 *   • ramp and interchange topology — the 367 published lines carry geometry but no junctions,
 *     no turn legality and no connection table
 *   • a crossing between carriageways — I-595 is divided, and nothing published says where a
 *     vehicle may turn around
 *   • Express direction, which the corridor does not publish at all
 *
 * So a route is offered in exactly one case: the patrol is upstream of the incident on the SAME
 * general-purpose carriageway. Then the distance is measured along real centerline geometry and the
 * drawn route is the real centerline slice. In every other case this returns an unresolved route
 * with the reason, and no travel time whatsoever.
 *
 * Straight-line distance is never used as driving distance. It is not computed here at all, so it
 * cannot leak into a number an operator would read as an ETA.
 *
 * Pure: geometry in, route out. No Cesium, no DOM.
 */
import { centerlineDistances, corridorPositionOf } from '../../assetExplorer/corridorPosition.js';

import { CARRIAGEWAYS } from '../../liveOps/carriagewayModel.js';
import { upstreamOffsetM } from '../upstreamResolver.js';
import { PATROL_CONFIG, ROUTE_CONFIDENCE, travelSecondsFor } from './patrolConfig.js';

/**
 * corridorPositionOf reports TWO distances and they mean opposite things: `milepost` is distance
 * ALONG the corridor (in miles) and `offsetM` is the lateral distance OFF it. Only the first one
 * can be driven. tmcResources.js converts the same way.
 */
const METRES_PER_MILE = 1609.344;
const alongMetres = position =>
  (Number.isFinite(position?.milepost) ? position.milepost * METRES_PER_MILE : null);

/** Why a route could not be built. Each maps to a sentence the operator sees verbatim. */
export const ROUTE_UNRESOLVED = Object.freeze({
  NO_GEOMETRY: 'Corridor geometry unavailable',
  INCIDENT_CARRIAGEWAY: 'Incident carriageway unresolved — no approach direction to follow',
  EXPRESS: 'I-595 Express direction is not published, so an approach cannot be determined',
  OPPOSITE_CARRIAGEWAY: 'Patrol is on the opposite carriageway — no published crossing',
  DOWNSTREAM: 'Patrol is past the incident — a turnaround needs interchange topology we do not have',
  OFF_CORRIDOR: 'Patrol is beyond the modelled corridor',
  NOT_PROJECTED: 'Patrol or incident could not be placed on the corridor centerline',
});

const lonOf = point => point?.lon ?? point?.longitude ?? null;
const latOf = point => point?.lat ?? point?.latitude ?? null;

/** A centerline normalised to {lon, lat}, so either published spelling works. */
export const normaliseCenterline = centerline => (Array.isArray(centerline) ? centerline : [])
  .map(point => ({ lon: lonOf(point), lat: latOf(point) }))
  .filter(point => Number.isFinite(point.lon) && Number.isFinite(point.lat));

/**
 * The point that lies a given distance along the centerline.
 *
 * This is what puts a simulated patrol ON the road rather than at a plausible-looking coordinate:
 * a beat is expressed as a distance along the corridor, and the position is read back off the
 * published geometry.
 */
export function pointAtDistance(centerline, metres) {
  const path = normaliseCenterline(centerline);
  if (path.length < 2) return null;
  const along = centerlineDistances(path);
  const total = along[along.length - 1];
  const target = Math.max(0, Math.min(total, metres));
  for (let i = 1; i < path.length; i++) {
    if (along[i] < target) continue;
    const span = along[i] - along[i - 1];
    const t = span === 0 ? 0 : (target - along[i - 1]) / span;
    return {
      lon: path[i - 1].lon + (path[i].lon - path[i - 1].lon) * t,
      lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * t,
    };
  }
  return path[path.length - 1];
}

/**
 * The corridor's local bearing at a distance, in degrees clockwise from north.
 *
 * Used to point a patrol marker the way it is travelling. Westbound is the same geometry read
 * backwards, which is why the carriageway decides the sign rather than the geometry.
 */
export function headingAtDistance(centerline, metres, carriageway) {
  const ahead = pointAtDistance(centerline, metres + 50);
  const behind = pointAtDistance(centerline, Math.max(0, metres - 50));
  if (!ahead || !behind) return null;
  const forward = carriageway === CARRIAGEWAYS.WB_GENERAL ? -1 : 1;
  const dLon = (ahead.lon - behind.lon) * forward * Math.cos((ahead.lat + behind.lat) / 2 * Math.PI / 180);
  const dLat = (ahead.lat - behind.lat) * forward;
  if (dLon === 0 && dLat === 0) return null;
  return (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
}

/** The centerline vertices between two along-corridor distances, inclusive of both ends. */
export function centerlineSliceBetween(centerline, fromMeters, toMeters) {
  const path = normaliseCenterline(centerline);
  if (path.length < 2) return [];
  const low = Math.min(fromMeters, toMeters);
  const high = Math.max(fromMeters, toMeters);
  const along = centerlineDistances(path);
  const out = [pointAtDistance(path, low)];
  for (let i = 0; i < path.length; i++) {
    if (along[i] > low && along[i] < high) out.push(path[i]);
  }
  out.push(pointAtDistance(path, high));
  return out.filter(Boolean);
}

const unresolved = reason => Object.freeze({
  resolved: false,
  reason,
  confidence: ROUTE_CONFIDENCE.UNRESOLVED,
  distanceMeters: null,
  travelSeconds: null,
  path: Object.freeze([]),
});

/**
 * The route a patrol would drive to reach an incident, or a stated refusal.
 *
 * @param {{longitude: number, latitude: number, carriageway: string, corridorAlongM: number|null}} patrol
 * @param {{longitude: number, latitude: number, carriageway: string}} incident
 * @param {{centerline: object[]}} context
 * @returns {{resolved: boolean, reason: string|null, confidence: string,
 *            distanceMeters: number|null, travelSeconds: number|null, path: object[]}}
 */
export function routeToIncident(patrol, incident, { centerline = [] } = {}) {
  const path = normaliseCenterline(centerline);
  if (path.length < 2) return unresolved(ROUTE_UNRESOLVED.NO_GEOMETRY);

  const carriageway = incident?.carriageway ?? CARRIAGEWAYS.UNKNOWN;
  // Express reverses direction by time of day and the corridor does not publish which way it is
  // running; guessing would be inventing the approach.
  if (carriageway === CARRIAGEWAYS.EXPRESS) return unresolved(ROUTE_UNRESOLVED.EXPRESS);
  if (carriageway === CARRIAGEWAYS.UNKNOWN) return unresolved(ROUTE_UNRESOLVED.INCIDENT_CARRIAGEWAY);
  // A divided highway with no published crossing: the patrol cannot simply drive across.
  if (patrol?.carriageway !== carriageway) return unresolved(ROUTE_UNRESOLVED.OPPOSITE_CARRIAGEWAY);

  const distances = centerlineDistances(path);
  const incidentAlongM = alongMetres(corridorPositionOf(incident.longitude, incident.latitude, path, distances));
  const patrolAlongM = Number.isFinite(patrol.corridorAlongM)
    ? patrol.corridorAlongM
    : alongMetres(corridorPositionOf(patrol.longitude, patrol.latitude, path, distances));
  if (!Number.isFinite(incidentAlongM) || !Number.isFinite(patrolAlongM)) {
    return unresolved(ROUTE_UNRESOLVED.NOT_PROJECTED);
  }

  // Positive means the patrol is behind the incident in the direction traffic travels, which is
  // the only case where driving forward reaches the scene.
  const metres = upstreamOffsetM(incidentAlongM, patrolAlongM, carriageway);
  if (!Number.isFinite(metres)) return unresolved(ROUTE_UNRESOLVED.NOT_PROJECTED);
  if (metres <= 0) return unresolved(ROUTE_UNRESOLVED.DOWNSTREAM);
  if (metres > PATROL_CONFIG.maximumRouteMeters) return unresolved(ROUTE_UNRESOLVED.OFF_CORRIDOR);

  // A floor, so a patrol a few metres upstream does not produce a two-second ETA that reads as
  // precision the model does not have.
  const distanceMeters = Math.max(PATROL_CONFIG.minimumRouteMeters, Math.round(metres));
  return Object.freeze({
    resolved: true,
    reason: null,
    // Never better than approximate: this follows the mainline centerline, and no ramp or
    // interchange topology exists to refine it.
    confidence: ROUTE_CONFIDENCE.APPROXIMATE,
    distanceMeters,
    travelSeconds: Math.round(travelSecondsFor(distanceMeters)),
    assumedSpeedKmh: PATROL_CONFIG.simulatedPatrolSpeedKmh,
    path: Object.freeze(centerlineSliceBetween(path, patrolAlongM, incidentAlongM)),
    fromAlongM: patrolAlongM,
    toAlongM: incidentAlongM,
  });
}

/** Minutes, rounded, or null — never a number when the route is unresolved. */
export const travelMinutes = route =>
  route?.resolved && Number.isFinite(route.travelSeconds) ? Math.max(1, Math.round(route.travelSeconds / 60)) : null;
