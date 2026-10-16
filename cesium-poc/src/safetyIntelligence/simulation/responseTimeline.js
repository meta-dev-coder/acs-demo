/**
 * The incident response lifecycle, as a timeline that can be argued with.
 *
 * Thirteen stages from occurrence to queue dissipation, computed from configurable durations with
 * explicit dependencies. Stages run in parallel where they really do — a tow can be rolling before
 * the first responder arrives, and lanes can reopen before the scene is fully cleared — so the
 * model does not simply add durations end to end.
 *
 * Two things it refuses to do, because both would make it dangerous:
 *
 *   • It will not let more responders drive clearance to zero. Every physical task has a floor, and
 *     past a point extra people are extra people to protect. The curve has diminishing returns and
 *     a hard minimum.
 *   • It will not reopen a lane before the scene is safe, before a required investigation is
 *     finished, or before a hazardous load is dealt with. Those are CONSTRAINTS, not penalties the
 *     optimizer may trade away.
 *
 * Deterministic: same configuration in, same timeline out, no clock read inside.
 */

/** Minutes, all of them. The simulation's unit throughout. */
export const DEFAULT_RESPONSE = Object.freeze({
  detectionMinutes: 6,
  verificationMinutes: 3,
  dispatchMinutes: 3,
  rangerTravelMinutes: 12,
  towTravelMinutes: 22,
  /** A tow can be rolling before anyone is on scene; negative means dispatched before verification. */
  towDispatchOffsetMinutes: 0,
  rangers: 1,
  towTrucks: 1,
  sceneProtectionMinutes: 10,
  assessmentMinutes: 5,
  vehicleRemovalMinutes: 25,
  debrisClearanceMinutes: 12,
  /** How long after the scene is protected a lane can be given back, where the scene allows it. */
  partialReopenAfterProtectionMinutes: 15,
  /** How long responders need to clear the shoulder after the lanes are open. */
  demobilisationMinutes: 8,
  warningActivationMinutes: 10,
});

export const RESPONSE_BOUNDS = Object.freeze({
  detectionMinutes: [1, 60],
  verificationMinutes: [1, 30],
  dispatchMinutes: [1, 30],
  rangerTravelMinutes: [2, 60],
  towTravelMinutes: [4, 90],
  towDispatchOffsetMinutes: [-15, 30],
  rangers: [1, 6],
  towTrucks: [1, 4],
  sceneProtectionMinutes: [5, 45],
  assessmentMinutes: [2, 30],
  vehicleRemovalMinutes: [8, 180],
  debrisClearanceMinutes: [3, 120],
  partialReopenAfterProtectionMinutes: [0, 120],
  demobilisationMinutes: [3, 45],
  warningActivationMinutes: [1, 60],
});

/**
 * What the incident itself demands, whatever the operator would prefer.
 *
 * These are the constraints the optimizer may not trade away. The figures are planning assumptions
 * — no instance data publishes them — but their EXISTENCE is not negotiable: a fatal crash is an
 * investigation scene before it is a traffic problem.
 */
export const SAFETY_CONSTRAINTS = Object.freeze({
  /** Investigation hold before a vehicle may be moved, by severity. */
  investigationHoldMinutes: Object.freeze({ FATAL: 90, INJURY: 30, PROPERTY_DAMAGE: 0 }),
  /** Nothing happens on a live carriageway until the scene is protected. */
  minimumSceneProtectionMinutes: 5,
  /** However many people turn up, a vehicle takes this long to shift. */
  minimumVehicleRemovalMinutes: 8,
  minimumDebrisClearanceMinutes: 3,
  /** A hazardous load is a specialist job and is not optimised away. */
  hazmatAdditionalMinutes: 60,
  /** Medical response holds the scene before anything else begins. */
  medicalHoldMinutes: Object.freeze({ FATAL: 25, INJURY: 15, PROPERTY_DAMAGE: 0 }),
  notes: Object.freeze([
    'An investigation hold applies before a vehicle may be moved where the incident was fatal or '
      + 'caused injury. The simulation cannot shorten it.',
    'Scene protection, vehicle removal and debris clearance each have a minimum duration no amount '
      + 'of extra resource can go below.',
    'Lanes are never reopened before the scene is protected and the hold, if any, has run.',
    'These durations are planning assumptions. Nothing in this twin publishes the real ones.',
  ]),
});

const clamp = (value, [low, high]) => Math.min(high, Math.max(low, value));

/**
 * What extra crews actually buy.
 *
 * Two rangers are not twice as fast as one: the work partly parallelises and partly does not. A
 * square-root curve is the usual planning shape for that, and it is floored by the task's own
 * minimum so the model can never claim an instant clearance.
 */
export const crewSpeedup = (count, { minimum = 1 } = {}) =>
  1 / Math.sqrt(Math.max(minimum, count));

/**
 * Build the timeline.
 *
 * @param {object} baseline from buildIncidentBaseline()
 * @param {object} response a partial DEFAULT_RESPONSE
 * @param {{hazmat?: boolean, investigationRequired?: boolean}} [situation]
 * @returns {object} every stage, in minutes from the incident
 */
export function buildTimeline(baseline, response = {}, { hazmat = false,
  investigationRequired = null } = {}) {
  const input = { ...DEFAULT_RESPONSE, ...response };
  const settings = Object.fromEntries(Object.entries(input).map(([key, value]) =>
    [key, RESPONSE_BOUNDS[key] ? clamp(value, RESPONSE_BOUNDS[key]) : value]));

  const severity = baseline?.fact?.severity?.level ?? 'PROPERTY_DAMAGE';
  const holdRequired = investigationRequired ?? severity !== 'PROPERTY_DAMAGE';
  const investigationHold = holdRequired ? SAFETY_CONSTRAINTS.investigationHoldMinutes[severity] ?? 0 : 0;
  const medicalHold = SAFETY_CONSTRAINTS.medicalHoldMinutes[severity] ?? 0;

  /* --- the response chain ------------------------------------------------------------------ */
  const detected = settings.detectionMinutes;
  const verified = detected + settings.verificationMinutes;
  const dispatched = verified + settings.dispatchMinutes;
  // A tow can be rolled on the first report rather than after verification: that is what the
  // offset is for, and it is why tow arrival is not simply "after dispatch".
  const towDispatched = Math.max(detected, dispatched + settings.towDispatchOffsetMinutes);

  const rangerArrival = dispatched + settings.rangerTravelMinutes;
  const towArrival = towDispatched + settings.towTravelMinutes;
  const warningActive = detected + settings.warningActivationMinutes;

  const rangerFactor = crewSpeedup(settings.rangers);
  const towFactor = crewSpeedup(settings.towTrucks);

  const protectionDuration = Math.max(SAFETY_CONSTRAINTS.minimumSceneProtectionMinutes,
    settings.sceneProtectionMinutes * rangerFactor);
  const sceneProtected = rangerArrival + protectionDuration;
  const assessed = sceneProtected + settings.assessmentMinutes * rangerFactor;

  // Nothing is moved until the scene is assessed, the medical hold has run, any investigation hold
  // has run, and a tow is actually there.
  /**
   * Which of the four gates actually decides when removal can start.
   *
   * Worth naming, because it is the difference between a lever that helps and a lever that does
   * nothing: pulling the tow forward ten minutes changes nothing at all while an investigation hold
   * is the binding constraint, and an operator told only "no change" would reasonably think the
   * model was broken.
   */
  const gates = [
    { id: 'assessment', label: 'scene assessment', at: assessed },
    { id: 'tow', label: 'tow arrival', at: towArrival },
    { id: 'medical', label: 'medical hold', at: rangerArrival + medicalHold },
    { id: 'investigation', label: 'investigation hold', at: sceneProtected + investigationHold },
  ];
  const binding = gates.reduce((latest, gate) => (gate.at > latest.at ? gate : latest), gates[0]);
  const removalStart = binding.at;
  const removalDuration = Math.max(SAFETY_CONSTRAINTS.minimumVehicleRemovalMinutes,
    settings.vehicleRemovalMinutes * towFactor) + (hazmat ? SAFETY_CONSTRAINTS.hazmatAdditionalMinutes : 0);
  const removalDone = removalStart + removalDuration;

  const debrisDuration = Math.max(SAFETY_CONSTRAINTS.minimumDebrisClearanceMinutes,
    settings.debrisClearanceMinutes * rangerFactor);
  const debrisDone = removalDone + debrisDuration;

  /**
   * Partial reopening.
   *
   * A lane can come back before the scene is finished — that is the single biggest lever an
   * operator has — but never before the scene is protected and any hold has run, and never later
   * than full reopening.
   */
  const partialEarliest = Math.max(sceneProtected, sceneProtected + investigationHold);
  const partialReopen = Math.min(debrisDone,
    Math.max(partialEarliest, sceneProtected + settings.partialReopenAfterProtectionMinutes));
  const fullReopen = debrisDone;

  /** Lanes open to traffic. */
  const roadwayClearance = fullReopen;
  /** Everyone and everything off the road. The two are different, and operators report both. */
  const incidentClearance = fullReopen + settings.demobilisationMinutes;

  return Object.freeze({
    settings: Object.freeze(settings),
    severity,
    constraintsApplied: Object.freeze([
      ...(investigationHold ? [`Investigation hold of ${investigationHold} min before any vehicle `
        + `could be moved (${severity.toLowerCase().replace('_', ' ')}).`] : []),
      ...(medicalHold ? [`Medical response held the scene for ${medicalHold} min.`] : []),
      ...(hazmat ? [`Hazardous load added ${SAFETY_CONSTRAINTS.hazmatAdditionalMinutes} min of `
        + 'specialist work.'] : []),
      ...(settings.vehicleRemovalMinutes * towFactor < SAFETY_CONSTRAINTS.minimumVehicleRemovalMinutes
        ? [`Vehicle removal floored at ${SAFETY_CONSTRAINTS.minimumVehicleRemovalMinutes} min: extra `
          + 'tow trucks cannot shorten it further.'] : []),
    ]),
    stages: Object.freeze([
      { id: 'occurred', label: 'Incident occurred', at: 0 },
      { id: 'detected', label: 'Detected', at: detected },
      { id: 'verified', label: 'Verified', at: verified },
      { id: 'dispatched', label: 'Dispatched', at: dispatched },
      { id: 'warning', label: 'Upstream warning active', at: warningActive, parallel: true },
      { id: 'rangerArrival', label: 'First responder on scene', at: rangerArrival },
      { id: 'sceneProtected', label: 'Scene protected', at: sceneProtected },
      { id: 'towArrival', label: 'Tow on scene', at: towArrival, parallel: true },
      { id: 'assessed', label: 'Scene assessed', at: assessed },
      { id: 'removalStart', label: 'Vehicle removal begins', at: removalStart },
      { id: 'partialReopen', label: 'Partial lane reopening', at: partialReopen },
      { id: 'removalDone', label: 'Vehicles removed', at: removalDone },
      { id: 'fullReopen', label: 'All lanes reopened', at: fullReopen },
      { id: 'incidentClearance', label: 'Incident cleared (scene vacated)', at: incidentClearance },
    ].map(stage => Object.freeze(stage))),
    /** The milestones everything downstream reads. */
    detected,
    verified,
    dispatched,
    rangerArrival,
    towArrival,
    warningActive,
    sceneProtected,
    removalStart,
    partialReopen,
    fullReopen,
    roadwayClearance,
    incidentClearance,
    investigationHold,
    medicalHold,
    /** What vehicle removal is waiting on, and by how much it beats the next gate. */
    bindingConstraint: Object.freeze({
      id: binding.id,
      label: binding.label,
      atMinute: Number(binding.at.toFixed(1)),
      slackMinutes: Number((binding.at - Math.max(...gates.filter(gate => gate !== binding)
        .map(gate => gate.at))).toFixed(1)),
      note: `Vehicle removal could not begin until ${binding.label} was complete. Pulling anything `
        + 'else forward does not move it until that changes.',
    }),
    gates: Object.freeze(gates.map(gate => Object.freeze({ ...gate, at: Number(gate.at.toFixed(1)) }))),
    /** Minutes from the incident to lanes open — the number operators call roadway clearance. */
    roadwayClearanceMinutes: roadwayClearance,
    incidentClearanceMinutes: incidentClearance,
    clearanceNote: 'Roadway clearance is when the lanes are open. Incident clearance is when the '
      + 'scene is vacated. They are different numbers and both are reported.',
  });
}

/** Each stage's own duration, for the timeline chart. */
export const stageSpans = timeline => Object.freeze(timeline.stages.slice(1).map((stage, index) =>
  Object.freeze({
    id: stage.id,
    label: stage.label,
    from: timeline.stages[index].at,
    to: stage.at,
    minutes: Number((stage.at - timeline.stages[index].at).toFixed(1)),
    parallel: Boolean(stage.parallel),
  })));

/** Anything the configuration cannot mean. */
export function validateResponse(response = {}) {
  const problems = [];
  for (const [key, bounds] of Object.entries(RESPONSE_BOUNDS)) {
    const value = response[key];
    if (value == null) continue;
    if (!Number.isFinite(value)) problems.push(`${key} is not a number.`);
    else if (value < bounds[0] || value > bounds[1]) {
      problems.push(`${key} must be between ${bounds[0]} and ${bounds[1]}; got ${value}.`);
    }
  }
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) });
}
