/**
 * Which patrol responds, and what that is worth.
 *
 * The fleet itself is the TMC's — `simulateFleet` from `src/tmc/patrol/simulatedPatrolProvider.js`,
 * with the TMC's own configuration, seed and disclaimer. Nothing is re-modelled here: a second
 * fleet with its own positions would mean the two screens disagreed about where the patrols are.
 *
 * What this adds is the link to the response engine. The TMC asks "which patrol should I send to
 * this live incident?"; the Lab asks "if a patrol had been HERE, what would the incident have cost
 * instead?" — so each candidate's travel time is fed back in as `rangerTravelMinutes` and the whole
 * simulation is re-run for it. The comparison is then in the same units as everything else on the
 * screen: minutes to lanes open, vehicle-hours, dollars.
 *
 * Every figure here rests on a simulated fleet. There is no Road Ranger dataset on this instance —
 * no positions, no dispatch log, no response times — so the patrols are illustrative and the
 * disclaimer travels with them to every panel that shows one.
 */
import { simulateFleet } from '../../tmc/patrol/simulatedPatrolProvider.js';
import { DEFAULT_SCENARIO_ID, PATROL_CONFIG, PATROL_STATUS, PATROL_STATUS_COLORS,
  PATROL_STATUS_LABELS, SIMULATION_BADGE, SIMULATION_DISCLAIMER,
  travelSecondsFor } from '../../tmc/patrol/patrolConfig.js';
import { RESPONSE_BOUNDS } from './responseTimeline.js';

export { SIMULATION_BADGE, SIMULATION_DISCLAIMER, PATROL_STATUS_LABELS, PATROL_STATUS_COLORS };

/**
 * The response model will not accept a responder arrival below this.
 *
 * It is a sensible floor for a typed input — nobody is on scene in thirty seconds — but it silently
 * clamped the fleet: patrols within about 2.5 km all arrive in under two minutes, were all floored
 * to the same value, and the comparison showed four identical rows. The floor still applies; it is
 * now REPORTED, so a row that was floored says so instead of looking like a coincidence.
 */
export const ARRIVAL_FLOOR_MINUTES = RESPONSE_BOUNDS.rangerTravelMinutes[0];

/**
 * How many dispatchable patrols a scenario must offer.
 *
 * The TMC filters candidates to the same carriageway, upstream of the incident. This screen cannot:
 * an incident's position is its damaged asset's, and the carriageway is not verifiable from it — so
 * filtering by a direction the data does not establish would be inventing a constraint. Every
 * AVAILABLE patrol is a candidate here, and the status mix (four of six) guarantees enough of them
 * to compare.
 */
export const MINIMUM_CANDIDATES = 2;

/** Metres between two lon/lat points, near enough at corridor scale. */
const metresBetween = (a, b) => Math.hypot(
  (a.longitude - b.longitude) * 111_320 * Math.cos((a.latitude * Math.PI) / 180),
  (a.latitude - b.latitude) * 110_540);

/**
 * The fleet as it stands for one incident, with each patrol's distance and travel time to it.
 *
 * Deterministic: the seed is the incident and its own timestamp, so the same incident always shows
 * the same fleet in the same places, however many times it is opened.
 */
export function patrolOptionsFor(fact, { centerline = [], scenarioId = DEFAULT_SCENARIO_ID } = {}) {
  if (!fact || !Number.isFinite(fact.longitude)) return null;
  const fleet = simulateFleet({
    centerline,
    incidentId: fact.id,
    anchorMs: fact.when?.ms ?? 0,
    scenarioId,
  });
  if (!fleet.length) {
    return Object.freeze({
      available: false,
      reason: 'The corridor centreline is not loaded, so no patrol positions can be placed on it.',
      patrols: Object.freeze([]), candidates: Object.freeze([]),
    });
  }

  const patrols = fleet.map(patrol => {
    const metres = metresBetween(fact, patrol);
    // Straight-line distance along the ground, not a routed path: the Lab has no router, and
    // claiming a routed distance it did not compute would overstate what it knows.
    const rawMinutes = Number((travelSecondsFor(metres, PATROL_CONFIG.simulatedPatrolSpeedKmh) / 60)
      .toFixed(1));
    // What the model will actually use, and whether that differs from the drive itself.
    const travelMinutes = Math.max(ARRIVAL_FLOOR_MINUTES, rawMinutes);
    const dispatchable = patrol.status === PATROL_STATUS.AVAILABLE;
    return Object.freeze({
      id: patrol.id,
      status: patrol.status,
      statusLabel: PATROL_STATUS_LABELS[patrol.status] ?? patrol.status,
      serviceArea: patrol.serviceArea,
      carriageway: patrol.carriageway,
      // Carried through for the detail card, so this screen reports the same fields about a patrol
      // that the TMC screen does rather than a shorter version of them.
      assignedRoute: patrol.assignedRoute,
      simulationTimestamp: patrol.simulationTimestamp,
      speedKmh: patrol.speed,
      heading: patrol.heading,
      sourceType: patrol.sourceType,
      longitude: patrol.longitude,
      latitude: patrol.latitude,
      distanceMetres: Math.round(metres),
      travelMinutes,
      /** The drive alone, before the model's minimum arrival time is applied. */
      driveMinutes: rawMinutes,
      floored: rawMinutes < ARRIVAL_FLOOR_MINUTES,
      colour: PATROL_STATUS_COLORS[patrol.status] ?? '#8b95a3',
      dispatchable,
      ineligibleReason: dispatchable ? null
        : `${PATROL_STATUS_LABELS[patrol.status]} — not available for dispatch in this scenario.`,
    });
  });

  const candidates = patrols.filter(patrol => patrol.dispatchable)
    .sort((a, b) => a.travelMinutes - b.travelMinutes);

  return Object.freeze({
    available: candidates.length > 0,
    patrols: Object.freeze(patrols),
    candidates: Object.freeze(candidates),
    nearest: candidates[0] ?? null,
    furthest: candidates.at(-1) ?? null,
    fleetSize: patrols.length,
    meetsMinimum: candidates.length >= MINIMUM_CANDIDATES,
    speedKmh: PATROL_CONFIG.simulatedPatrolSpeedKmh,
    /** How many candidates the arrival floor made indistinguishable from each other. */
    flooredCandidates: candidates.filter(patrol => patrol.floored).length,
    arrivalFloorMinutes: ARRIVAL_FLOOR_MINUTES,
    disclaimer: SIMULATION_DISCLAIMER,
    basis: `Positions from the TMC's simulated fleet, seeded by this incident. Travel time is `
      + `straight-line distance at an assumed ${PATROL_CONFIG.simulatedPatrolSpeedKmh} km/h cruise — `
      + 'not a routed path, and not measured from any dispatch record.',
    /** Said plainly, because a patrol on a map looks like a fact. */
    standing: 'No Road Ranger dataset exists on this instance: no positions, no dispatch log, no '
      + 'response times. These patrols are illustrative and nothing here is evidence about the '
      + 'real fleet.',
  });
}

/**
 * What each candidate would be worth, in the engine's own units.
 *
 * Each patrol's travel time replaces `rangerTravelMinutes` and the simulation is re-run, so the
 * comparison is between full results rather than between travel times — a patrol five minutes
 * closer does not necessarily clear the road five minutes sooner, and this is what shows that.
 *
 * @param {object} options from patrolOptionsFor()
 * @param {(response: object) => object} run the simulation, injected so nothing is modelled here
 * @param {object} baselineRun the run everything is measured against
 */
export function comparePatrols(options, run, baselineRun) {
  if (!options?.candidates.length || !baselineRun) return null;
  const base = baselineRun.inputs.response;
  const rows = options.candidates.map(patrol => {
    const result = run({ ...base, rangerTravelMinutes: patrol.travelMinutes });
    return Object.freeze({
      patrol,
      result,
      // One decimal, not the headline's whole minutes: two patrols thirty seconds apart produced
      // clearance times that differed by half a minute and rounded to the same integer, so the
      // table showed identical rows for genuinely different answers.
      roadwayClearanceMinutes: Number(result.timeline.roadwayClearanceMinutes.toFixed(1)),
      vehicleHoursOfDelay: result.headline.vehicleHoursOfDelay,
      totalModelledCostUSD: result.headline.totalModelledCostUSD,
      // Against the run the operator is looking at, not against the best candidate: the question is
      // "what would this change", and the answer has to be in the same frame as the rest of the Lab.
      clearanceChange: Number((result.timeline.roadwayClearanceMinutes
        - baselineRun.timeline.roadwayClearanceMinutes).toFixed(1)),
      delayChange: Number((result.headline.vehicleHoursOfDelay
        - baselineRun.headline.vehicleHoursOfDelay).toFixed(1)),
      costChange: result.headline.totalModelledCostUSD - baselineRun.headline.totalModelledCostUSD,
    });
  }).sort((a, b) => a.totalModelledCostUSD - b.totalModelledCostUSD
    || a.roadwayClearanceMinutes - b.roadwayClearanceMinutes);

  const best = rows[0];
  const worst = rows.at(-1);
  return Object.freeze({
    rows: Object.freeze(rows),
    best,
    worst,
    /** The spread across the fleet: what the CHOICE is worth, as distinct from what a patrol is worth. */
    clearanceSpreadMinutes: rows.length > 1
      ? Number((worst.roadwayClearanceMinutes - best.roadwayClearanceMinutes).toFixed(1)) : 0,
    costSpreadUSD: rows.length > 1 ? worst.totalModelledCostUSD - best.totalModelledCostUSD : 0,
    delaySpreadHours: rows.length > 1
      ? Number((worst.vehicleHoursOfDelay - best.vehicleHoursOfDelay).toFixed(1)) : 0,
    baselineClearanceMinutes: Number(baselineRun.timeline.roadwayClearanceMinutes.toFixed(1)),
    flooredCandidates: options.flooredCandidates,
    arrivalFloorMinutes: options.arrivalFloorMinutes,
    baselineCostUSD: baselineRun.headline.totalModelledCostUSD,
    /**
     * Whether the choice changes anything at all.
     *
     * On an incident whose clearance is gated by an investigation hold, every patrol arrives before
     * the gate opens and the whole comparison is worth nothing in minutes — which is a finding, not
     * a failure, and the panel says so rather than showing a column of identical numbers without
     * comment.
     */
    choiceMatters: rows.length > 1 && (worst.roadwayClearanceMinutes - best.roadwayClearanceMinutes) >= 0.1,
    note: 'Each row is a full re-run of the simulation with that patrol’s travel time. A patrol five '
      + 'minutes closer does not necessarily open the lanes five minutes sooner — it depends on what '
      + 'is binding.',
  });
}
