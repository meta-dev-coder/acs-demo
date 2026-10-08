/**
 * Every number the patrol simulation uses, in one place.
 *
 * This file exists so that no assumption is buried in a component. A reviewer who wants to know
 * "how fast do you assume a patrol drives, and who decided that" reads one file, and an operator
 * who disagrees changes one value. Nothing here is measured from ACS or FDOT operations — these are
 * stated assumptions for an illustrative scenario, and the UI shows them rather than hiding them.
 *
 * Bumping CONFIG_VERSION changes every simulated scenario, by design: the version is part of the
 * deterministic seed, so a changed assumption cannot silently keep producing the old positions.
 */

/** Part of the seed. Change this whenever a value below changes the meaning of a scenario. */
export const CONFIG_VERSION = 'patrol-sim-v2';

/** The default scenario. A second scenarioId produces a different, equally reproducible fleet. */
export const DEFAULT_SCENARIO_ID = 'BASELINE';

/**
 * Where simulated patrol data comes from, carried on every record.
 *
 * The UI reads this rather than a boolean, so a future real provider is distinguishable from the
 * simulation by inspecting the data itself and not by remembering which provider was installed.
 */
export const PATROL_SOURCE_TYPES = Object.freeze({
  SIMULATED: 'SIMULATED',
  REAL_AVL: 'REAL_AVL',
});

/** The lifecycle a patrol moves through. Ordered: each state follows the one before it. */
export const PATROL_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  BUSY: 'BUSY',
  DISPATCHED: 'DISPATCHED',
  EN_ROUTE: 'EN_ROUTE',
  ON_SCENE: 'ON_SCENE',
  SCENE_WORK: 'SCENE_WORK',
  CLEARED: 'CLEARED',
  OUT_OF_SERVICE: 'OUT_OF_SERVICE',
});

export const PATROL_STATUS_LABELS = Object.freeze({
  AVAILABLE: 'Available',
  BUSY: 'Busy',
  DISPATCHED: 'Dispatched',
  EN_ROUTE: 'En route',
  ON_SCENE: 'On scene',
  SCENE_WORK: 'Scene work',
  CLEARED: 'Cleared',
  OUT_OF_SERVICE: 'Out of service',
});

/**
 * Only AVAILABLE can be dispatched.
 *
 * A patrol already working an incident is not a candidate for this one, and neither is one out of
 * service. This is a hard rule, not a ranking penalty.
 */
export const DISPATCHABLE_STATUSES = Object.freeze([PATROL_STATUS.AVAILABLE]);

/**
 * Status colours, in addition to a distinct glyph.
 *
 * Colour alone never carries the meaning: the marker also changes shape and the list states the
 * status in words, so the distinction survives a colour-blind viewer and a greyscale print.
 */
export const PATROL_STATUS_COLORS = Object.freeze({
  AVAILABLE: '#14b8a6',
  BUSY: '#e5bc57',
  DISPATCHED: '#3b82f6',
  EN_ROUTE: '#3b82f6',
  ON_SCENE: '#8b5cf6',
  SCENE_WORK: '#8b5cf6',
  CLEARED: '#9ad97f',
  OUT_OF_SERVICE: '#8b95a3',
});

/**
 * How confident the route behind an ETA is.
 *
 * There is no HIGH. The corridor publishes a mainline centerline but no ramp or interchange
 * topology, so even the best route this simulation can produce is an along-corridor approximation.
 * Claiming a higher confidence than the geometry supports is the exact failure this grading exists
 * to prevent.
 */
export const ROUTE_CONFIDENCE = Object.freeze({
  APPROXIMATE: 'APPROXIMATE',
  UNRESOLVED: 'UNRESOLVED',
});

export const ROUTE_CONFIDENCE_LABELS = Object.freeze({
  APPROXIMATE: 'Approximate',
  UNRESOLVED: 'Unresolved',
});

export const PATROL_CONFIG = Object.freeze({
  /** The whole feature, off in one place. */
  simulationEnabled: true,

  /** Fixed string, never Date.now() — a clock in the seed would break reproducibility. */
  simulationSeed: 'i595-road-ranger-2026',

  configVersion: CONFIG_VERSION,
  scenarioVersion: CONFIG_VERSION,

  /**
   * Six, so each carriageway carries three.
   *
   * The beats alternate direction, and eligibility then requires the SAME carriageway as the
   * incident AND a position upstream of it. With five patrols that left two per direction, of
   * which the status mix usually disqualified one — so almost every incident had a single
   * candidate and "compare patrols" had nothing to compare. Six is the smallest fleet that makes
   * a comparison ordinarily possible while staying cheap to draw.
   */
  fleetSize: 6,

  /** Demonstration identifiers. Deliberately not shaped like real FDOT vehicle numbers. */
  idPrefix: 'SIM-RR-',

  /**
   * The assumed patrol cruise speed, used for every illustrative travel time.
   *
   * 45 mph (72 km/h) is a deliberately conservative freeway-response assumption: below the posted
   * limit, because a patrol responding into the back of a queue does not travel at free-flow speed.
   * It is not measured from ACS data, and the UI states it wherever a travel time is shown.
   */
  simulatedPatrolSpeedKmh: 72,

  /**
   * Response delay assumptions, kept SEPARATE so a scenario can change one without the others.
   *
   * Merging them into a single "response time" is what makes a demo untraceable: an operator
   * cannot tell whether a better number came from faster detection or faster driving.
   */
  dispatchDelayAssumptions: Object.freeze({
    /** Incident occurs → it is detected and confirmed. */
    detectionMinutes: 2,
    /** Detected → a patrol is actually assigned. The lever the comparison scenario moves. */
    dispatchMinutes: 4,
    /** Arrival → the scene is set up and protected. */
    onSceneWorkMinutes: 18,
  }),

  /** The faster alternative offered by the comparison. Also an assumption, also editable. */
  comparisonDispatchMinutes: 1,

  /**
   * Below this along-corridor distance a patrol is treated as effectively at the scene.
   *
   * Without a floor a patrol 40 m upstream yields a 2-second ETA, which reads as false precision.
   */
  minimumRouteMeters: 150,

  /** Beyond this the patrol is off the modelled corridor and no scenario is offered. */
  maximumRouteMeters: 30_000,

  /**
   * How the simulated fleet is distributed across statuses.
   *
   * Chosen to make the scenario worth looking at: more than one candidate so a comparison has
   * something to compare, and at least one ineligible patrol so the eligibility rules are visible
   * rather than theoretical. Applied deterministically, never sampled.
   */
  statusMix: Object.freeze([
    PATROL_STATUS.AVAILABLE,
    PATROL_STATUS.AVAILABLE,
    PATROL_STATUS.AVAILABLE,
    PATROL_STATUS.AVAILABLE,
    PATROL_STATUS.BUSY,
    PATROL_STATUS.OUT_OF_SERVICE,
  ]),

  /** Metres of corridor each patrol's beat covers either side of its anchor. Reported, not enforced. */
  serviceAreaHalfLengthMeters: 6_000,
});

/** Travel seconds for a route distance, at the stated assumed speed. */
export const travelSecondsFor = (metres, speedKmh = PATROL_CONFIG.simulatedPatrolSpeedKmh) =>
  (metres / 1000) / speedKmh * 3600;

/** The one sentence that must accompany any simulated patrol figure. */
export const SIMULATION_DISCLAIMER =
  'Illustrative Road Ranger positions and response scenarios. Not actual FDOT or ACS dispatch data.';

/** The shorter form, for a map chip or a card header where the full sentence will not fit. */
export const SIMULATION_BADGE = 'SIMULATED';
