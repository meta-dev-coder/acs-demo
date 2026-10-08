/**
 * The simulated dispatch lifecycle, its timeline, and the comparison between two dispatch delays.
 *
 * NOTHING HERE CALLS ANYTHING. There is no dispatch API, no network, no side effect — a "simulated
 * dispatch" is arithmetic over stated assumptions, and the only thing that changes is what the
 * screen shows.
 *
 * The durations are kept SEPARATE on purpose:
 *
 *   incident time → detection → dispatch → travel → on scene → scene work → clearance
 *
 * Collapsing them into one "response time" is what makes a demo impossible to argue with. Here an
 * operator can see that a better arrival came from an earlier dispatch rather than from faster
 * driving, and can change either one independently.
 *
 * What this deliberately does NOT do: convert any of it into a crash probability, a crash
 * reduction, or a monetary saving. Earlier arrival shortens the *exposure window* under these
 * assumptions. That is a scenario comparison, not a validated outcome, and the difference is
 * stated wherever a number is shown.
 *
 * Pure: assumptions in, timeline out.
 */
import { PATROL_CONFIG, PATROL_STATUS, PATROL_STATUS_LABELS } from './patrolConfig.js';
import { travelMinutes } from './patrolRouting.js';

const MINUTE = 60_000;

/** The lifecycle, in order. A simulated dispatch walks exactly these states. */
export const DISPATCH_LIFECYCLE = Object.freeze([
  PATROL_STATUS.DISPATCHED,
  PATROL_STATUS.EN_ROUTE,
  PATROL_STATUS.ON_SCENE,
  PATROL_STATUS.SCENE_WORK,
  PATROL_STATUS.CLEARED,
]);

/** Whether a state may follow another. Used to keep a simulated patrol's status self-consistent. */
export function canTransition(from, to) {
  if (from === PATROL_STATUS.AVAILABLE) return to === PATROL_STATUS.DISPATCHED;
  const at = DISPATCH_LIFECYCLE.indexOf(from);
  return at >= 0 && DISPATCH_LIFECYCLE[at + 1] === to;
}

/** The assumptions behind a scenario, defaults filled in and every one of them named. */
export function resolveAssumptions(overrides = {}) {
  const base = PATROL_CONFIG.dispatchDelayAssumptions;
  return Object.freeze({
    detectionMinutes: Number.isFinite(overrides.detectionMinutes) ? overrides.detectionMinutes : base.detectionMinutes,
    dispatchMinutes: Number.isFinite(overrides.dispatchMinutes) ? overrides.dispatchMinutes : base.dispatchMinutes,
    onSceneWorkMinutes: Number.isFinite(overrides.onSceneWorkMinutes) ? overrides.onSceneWorkMinutes : base.onSceneWorkMinutes,
    assumedSpeedKmh: PATROL_CONFIG.simulatedPatrolSpeedKmh,
  });
}

/**
 * One simulated response, as a timeline.
 *
 * The incident's own timestamp is the anchor and is marked REAL. Every other row is SIMULATED, and
 * the timeline carries that distinction per event so a renderer cannot blur it.
 *
 * @param {{incident: object, option: object, assumptions?: object}} input
 *   `option` is a DispatchOption from the provider: it carries the patrol and the route.
 * @returns {object|null} null when the option cannot support a scenario at all
 */
export function buildResponseScenario({ incident, option, assumptions = {} } = {}) {
  const anchorMs = Number(incident?.anchorMs);
  if (!option?.patrol || !Number.isFinite(anchorMs)) return null;

  const settings = resolveAssumptions(assumptions);
  const minutes = travelMinutes(option.route);
  // No route, no arrival. The scenario still exists — it states what is missing — but it never
  // invents the one number the whole thing turns on.
  if (minutes === null) {
    return Object.freeze({
      patrolId: option.patrol.id,
      incidentId: incident.id,
      simulated: true,
      resolved: false,
      reason: option.ineligibleReason ?? option.route?.reason ?? 'No route to this incident',
      assumptions: settings,
      events: Object.freeze([
        Object.freeze({ id: 'incident', at: anchorMs, label: 'Historical incident timestamp', kind: 'REAL' }),
      ]),
      arrivalMs: null, exposureMinutes: null, clearanceMs: null,
    });
  }

  const detectedMs = anchorMs + settings.detectionMinutes * MINUTE;
  const dispatchedMs = detectedMs + settings.dispatchMinutes * MINUTE;
  const arrivalMs = dispatchedMs + minutes * MINUTE;
  const clearanceMs = arrivalMs + settings.onSceneWorkMinutes * MINUTE;

  return Object.freeze({
    patrolId: option.patrol.id,
    incidentId: incident.id,
    simulated: true,
    resolved: true,
    reason: null,
    assumptions: Object.freeze({ ...settings, travelMinutes: minutes, routeMeters: option.route.distanceMeters }),
    routeConfidence: option.route.confidence,
    events: Object.freeze([
      Object.freeze({ id: 'incident', at: anchorMs, label: 'Historical incident timestamp', kind: 'REAL' }),
      Object.freeze({ id: 'detected', at: detectedMs, kind: 'SIMULATED',
        label: 'Simulated detection', detail: `${settings.detectionMinutes} min detection assumption` }),
      Object.freeze({ id: 'dispatched', at: dispatchedMs, kind: 'SIMULATED',
        label: 'Simulated dispatch', detail: `${settings.dispatchMinutes} min dispatch assumption` }),
      Object.freeze({ id: 'arrived', at: arrivalMs, kind: 'SIMULATED',
        label: 'Simulated patrol arrival',
        detail: `${minutes} min travel · ${(option.route.distanceMeters / 1000).toFixed(1)} km at ${settings.assumedSpeedKmh} km/h` }),
      Object.freeze({ id: 'cleared', at: clearanceMs, kind: 'SIMULATED',
        label: 'Hypothetical lane reopening',
        detail: `${settings.onSceneWorkMinutes} min on-scene assumption — depends on tow and debris, which are not modelled` }),
    ]),
    arrivalMs,
    clearanceMs,
    /** Incident to arrival: the window this scenario is actually about. */
    exposureMinutes: Math.round((arrivalMs - anchorMs) / MINUTE),
    lifecycle: DISPATCH_LIFECYCLE,
  });
}

/**
 * Two scenarios that differ in ONE assumption, and the difference between them.
 *
 * Only the dispatch delay moves. Travel time and on-scene work are held constant, and the result
 * says so: assuming that an earlier dispatch also shortens the work at the scene would be inventing
 * the very thing the comparison is supposed to demonstrate.
 */
export function compareDispatchScenarios({ incident, option, baselineMinutes, fasterMinutes } = {}) {
  const base = resolveAssumptions();
  const slower = Number.isFinite(baselineMinutes) ? baselineMinutes : base.dispatchMinutes;
  const faster = Number.isFinite(fasterMinutes) ? fasterMinutes : PATROL_CONFIG.comparisonDispatchMinutes;
  const a = buildResponseScenario({ incident, option, assumptions: { dispatchMinutes: slower } });
  const b = buildResponseScenario({ incident, option, assumptions: { dispatchMinutes: faster } });
  if (!a?.resolved || !b?.resolved) {
    return Object.freeze({ resolved: false, reason: a?.reason ?? b?.reason ?? 'No route', scenarioA: a, scenarioB: b });
  }
  return Object.freeze({
    resolved: true,
    scenarioA: a,
    scenarioB: b,
    dispatchMinutesA: slower,
    dispatchMinutesB: faster,
    /** The only thing that changed, and therefore the only thing the difference can be about. */
    changedAssumption: 'dispatchMinutes',
    earlierByMinutes: slower - faster,
    arrivalEarlierByMinutes: Math.round((a.arrivalMs - b.arrivalMs) / MINUTE),
    exposureReducedByMinutes: a.exposureMinutes - b.exposureMinutes,
    held: Object.freeze(['travelMinutes', 'onSceneWorkMinutes']),
    caveat: 'Dispatch delay is the only changed assumption. Travel time and on-scene work are held '
      + 'constant, and clearance still depends on tow and debris removal, which are not modelled. '
      + 'This is a scenario comparison, not a predicted outcome.',
  });
}

/**
 * Walk a patrol through the lifecycle for a given moment in a scenario.
 *
 * Used to show the dispatched patrol's state on the map and in its card without storing a second
 * copy of the fleet: the status is derived from the timeline, so it cannot drift out of step.
 */
export function statusAt(scenario, atMs) {
  if (!scenario?.resolved || !Number.isFinite(atMs)) return null;
  const event = id => scenario.events.find(entry => entry.id === id)?.at ?? null;
  if (atMs >= scenario.clearanceMs) return PATROL_STATUS.CLEARED;
  if (atMs >= scenario.arrivalMs) return PATROL_STATUS.ON_SCENE;
  if (atMs >= event('dispatched')) return PATROL_STATUS.EN_ROUTE;
  return PATROL_STATUS.AVAILABLE;
}

export const statusLabel = status => PATROL_STATUS_LABELS[status] ?? status ?? 'Unknown';
