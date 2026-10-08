/**
 * A simulated Road Ranger fleet, placed on the real corridor and reproducible forever.
 *
 * DETERMINISM IS THE WHOLE DESIGN. The TMC investigates historical incidents, so selecting the same
 * incident tomorrow must show the same scenario it showed today — otherwise a screenshot taken in a
 * client meeting stops matching the application. Every value below is derived from a hash of
 * (seed, configVersion, scenarioId, incidentId, anchor instant, patrol index). There is no
 * Math.random() in this file and no reference to the current clock.
 *
 * WHAT IS REAL HERE: the corridor geometry the patrols stand on, and the incident they respond to.
 * WHAT IS SIMULATED: that these vehicles exist, where they are, whether they are free, and how fast
 * they could arrive. Every record carries sourceType: 'SIMULATED' so no consumer has to be told.
 *
 * These are not FDOT patrol routes, not FDOT vehicle identifiers, and not ACS dispatch records.
 */
import { centerlineDistances } from '../../assetExplorer/corridorPosition.js';
import { CARRIAGEWAYS, CARRIAGEWAY_SHORT } from '../../liveOps/carriagewayModel.js';
import {
  DEFAULT_SCENARIO_ID, DISPATCHABLE_STATUSES, PATROL_CONFIG, PATROL_SOURCE_TYPES, PATROL_STATUS,
  PATROL_STATUS_LABELS,
} from './patrolConfig.js';
import { summariseAvailability } from './patrolProvider.js';
import { headingAtDistance, normaliseCenterline, pointAtDistance, routeToIncident } from './patrolRouting.js';
import { buildResponseScenario } from './patrolDispatch.js';

/**
 * A 32-bit string hash (FNV-1a), used to turn scenario identity into a seed.
 *
 * Chosen because it is tiny, dependency-free and stable across engines — the same string must
 * produce the same number in a browser, in Node and in a test, today and next year.
 */
function hashString(text) {
  let h = 0x811c9dc5;
  const value = String(text);
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32: a small, well-distributed PRNG from a 32-bit seed. Deterministic by construction. */
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The seed for one scenario.
 *
 * Exported so a test can assert that the same inputs produce the same seed, and that changing any
 * one of them changes it.
 */
export function scenarioSeed({
  incidentId, anchorMs, scenarioId = DEFAULT_SCENARIO_ID,
  seed = PATROL_CONFIG.simulationSeed, configVersion = PATROL_CONFIG.configVersion,
} = {}) {
  return hashString([seed, configVersion, scenarioId, incidentId ?? 'NO_INCIDENT', anchorMs ?? 0].join('|'));
}

const padId = index => `${PATROL_CONFIG.idPrefix}${String(index + 1).padStart(2, '0')}`;

/**
 * Where each patrol's beat sits along the corridor.
 *
 * The fleet is spread evenly end to end so the corridor is covered rather than clustered, and the
 * carriageways alternate so both directions are represented. This is a plausible deployment, not
 * a published FDOT one.
 */
function beatFor(index, fleetSize, corridorLengthM) {
  const band = corridorLengthM / fleetSize;
  const anchor = band * (index + 0.5);
  return {
    anchorM: anchor,
    fromM: Math.max(0, anchor - PATROL_CONFIG.serviceAreaHalfLengthMeters),
    toM: Math.min(corridorLengthM, anchor + PATROL_CONFIG.serviceAreaHalfLengthMeters),
    carriageway: index % 2 === 0 ? CARRIAGEWAYS.EB_GENERAL : CARRIAGEWAYS.WB_GENERAL,
  };
}

/**
 * Build the fleet for one scenario.
 *
 * @param {{centerline: object[], incidentId: string, anchorMs: number, scenarioId?: string}} context
 * @returns {object[]} patrol records, provider-neutral
 */
export function simulateFleet({
  centerline = [], incidentId = null, anchorMs = null, scenarioId = DEFAULT_SCENARIO_ID,
  fleetSize = PATROL_CONFIG.fleetSize,
} = {}) {
  const path = normaliseCenterline(centerline);
  if (path.length < 2 || !Number.isFinite(anchorMs)) return [];
  const along = centerlineDistances(path);
  const corridorLengthM = along[along.length - 1];
  if (!(corridorLengthM > 0)) return [];

  const random = seededRandom(scenarioSeed({ incidentId, anchorMs, scenarioId }));
  // Drawn once per patrol, in order, so adding a patrol never reshuffles the ones before it.
  const draws = Array.from({ length: fleetSize }, () => ({ place: random(), status: random() }));

  // The status mix is assigned by rotation rather than sampled, so a scenario always contains the
  // intended spread — some available, at least one not — however the seed falls.
  const mix = PATROL_CONFIG.statusMix;
  const rotation = Math.floor(random() * mix.length);

  return Object.freeze(draws.map((draw, index) => {
    const beat = beatFor(index, fleetSize, corridorLengthM);
    // Position: somewhere within its own beat, decided by the seed. Read off the published
    // centerline, so the vehicle is on the road rather than at an invented coordinate.
    const offsetM = beat.fromM + (beat.toM - beat.fromM) * draw.place;
    const point = pointAtDistance(path, offsetM);
    const status = mix[(index + rotation) % mix.length];
    return Object.freeze({
      id: padId(index),
      displayName: padId(index),
      serviceArea: `I-595 ${CARRIAGEWAY_SHORT[beat.carriageway]} · beat ${index + 1} of ${fleetSize}`,
      assignedRoute: `I-595 mainline ${CARRIAGEWAY_SHORT[beat.carriageway]}`,
      status,
      statusLabel: PATROL_STATUS_LABELS[status] ?? status,
      latitude: point.lat,
      longitude: point.lon,
      heading: headingAtDistance(path, offsetM, beat.carriageway),
      // The assumed cruise speed, stated rather than invented per vehicle.
      speed: status === PATROL_STATUS.AVAILABLE ? PATROL_CONFIG.simulatedPatrolSpeedKmh : 0,
      simulationTimestamp: anchorMs,
      sourceType: PATROL_SOURCE_TYPES.SIMULATED,
      scenarioId,
      carriageway: beat.carriageway,
      corridorAlongM: offsetM,
      serviceAreaFromM: beat.fromM,
      serviceAreaToM: beat.toM,
    });
  }));
}

/** Why a patrol cannot be sent, or null when it can. Checked in the order an operator would. */
function ineligibility(patrol, route) {
  if (!DISPATCHABLE_STATUSES.includes(patrol.status)) {
    return patrol.status === PATROL_STATUS.OUT_OF_SERVICE
      ? 'Out of service — not eligible for dispatch'
      : `${PATROL_STATUS_LABELS[patrol.status] ?? patrol.status} — already assigned, not eligible for dispatch`;
  }
  if (!route.resolved) return route.reason;
  return null;
}

/**
 * The simulated provider.
 *
 * @param {{centerline: object[], scenarioId?: string}} options
 */
export function createSimulatedPatrolProvider({ centerline = [], scenarioId = DEFAULT_SCENARIO_ID } = {}) {
  const fleetFor = (anchorMs, context = {}) => simulateFleet({
    centerline: context.centerline ?? centerline,
    incidentId: context.incidentId ?? null,
    anchorMs,
    scenarioId: context.scenarioId ?? scenarioId,
  });

  const provider = {
    sourceType: PATROL_SOURCE_TYPES.SIMULATED,
    scenarioId,

    getPatrolsAt: (timestamp, context) => fleetFor(timestamp, context),

    getPatrolPositionsAt: (timestamp, context) => fleetFor(timestamp, context).map(patrol => Object.freeze({
      id: patrol.id, latitude: patrol.latitude, longitude: patrol.longitude,
      heading: patrol.heading, simulationTimestamp: patrol.simulationTimestamp,
      sourceType: patrol.sourceType,
    })),

    getPatrolAvailabilityAt: (timestamp, context) => summariseAvailability(fleetFor(timestamp, context)),

    /**
     * Every patrol considered for this incident, eligible or not, with the reason.
     *
     * The ineligible ones are returned rather than filtered out: an operator who cannot see that
     * SIM-RR-03 was excluded for being busy has to take the ranking on trust.
     */
    getDispatchOptions(incident, timestamp, context = {}) {
      const line = context.centerline ?? centerline;
      const patrols = fleetFor(timestamp, { ...context, incidentId: incident?.id });
      const options = patrols.map(patrol => {
        const route = routeToIncident(patrol, incident, { centerline: line });
        const reason = ineligibility(patrol, route);
        return Object.freeze({
          patrol,
          eligible: reason === null,
          ineligibleReason: reason,
          route,
          travelSeconds: reason === null && route.resolved ? route.travelSeconds : null,
        });
      });
      // Fastest first among the eligible; everything else keeps fleet order so the list is stable.
      const eligible = options.filter(option => option.eligible)
        .sort((a, b) => a.travelSeconds - b.travelSeconds);
      const rest = options.filter(option => !option.eligible);
      return Object.freeze({
        options: Object.freeze([...eligible, ...rest]),
        eligible: Object.freeze(eligible),
        // Only a defensible ranking produces a suggestion: one candidate, or a clear fastest.
        suggested: eligible.length === 1 || (eligible.length > 1 && eligible[0].travelSeconds < eligible[1].travelSeconds)
          ? eligible[0] : null,
        tied: eligible.length > 1 && eligible[0].travelSeconds === eligible[1].travelSeconds
          ? Object.freeze(eligible.filter(option => option.travelSeconds === eligible[0].travelSeconds))
          : Object.freeze([]),
        availability: summariseAvailability(patrols),
        sourceType: PATROL_SOURCE_TYPES.SIMULATED,
      });
    },

    /**
     * The scenario for one patrol against one incident.
     *
     * Resolves the dispatch option itself rather than taking one, so a caller cannot hand in an
     * option built against a different incident or a different moment.
     */
    getResponseScenario(incident, patrolId, assumptions = {}, context = {}) {
      const anchorMs = Number(incident?.anchorMs);
      if (!Number.isFinite(anchorMs)) return null;
      const { options } = provider.getDispatchOptions(incident, anchorMs, context);
      const option = options.find(entry => entry.patrol.id === patrolId);
      if (!option) return null;
      return buildResponseScenario({ incident, option, assumptions });
    },
  };

  return Object.freeze(provider);
}
