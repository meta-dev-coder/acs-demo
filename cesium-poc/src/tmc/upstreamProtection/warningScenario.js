/**
 * The hypothetical warning scenario: an explicitly simulated queue, and two activation delays.
 *
 * This exists BECAUSE the queue cannot be observed. The connected feed publishes no queue length,
 * no speed and no DMS activation time, so an operator asking "would an earlier warning have
 * reached the back of the queue" has nothing to work from. Rather than estimating a queue inside
 * the real-data assessment — which would quietly turn an assumption into an observation — the
 * scenario is a separate thing the operator switches on, and everything it produces is labelled
 * SIMULATED.
 *
 * The arithmetic is deliberately simple and entirely visible:
 *
 *   queue length at time T = initial length + growth rate × minutes since the incident
 *   warning reaches the tail  ⟺  the sign is further upstream than the tail is
 *
 * CRUCIALLY, the queue model does NOT depend on the warning. Scenario A and scenario B share one
 * queue: at any given minute the simulated extent is the same number in both. Activating earlier
 * does not shorten the queue, and nothing here may be read as saying it does — there is no
 * validated mechanism in this POC by which a warning changes traffic flow.
 *
 * What it will NOT do: convert any of this into a crash probability, a number of secondary
 * collisions avoided, or a monetary saving. An earlier warning reaches the tail sooner under these
 * assumptions. That is a scenario comparison, not an outcome.
 *
 * Deterministic: the same incident and the same assumptions always produce the same result. There
 * is no randomness here at all — the queue is a straight line, not a sample.
 *
 * Pure: assumptions in, scenario out.
 */

/** Bumping this changes every scenario, which is the point — an assumption cannot change silently. */
export const WARNING_SCENARIO_VERSION = 'warning-sim-v1';

const MINUTE = 60_000;
const METRES_PER_MILE = 1609.344;

/**
 * Every assumption, named, with its unit in the key.
 *
 * None of these is measured from ACS or FDOT operations. They are stated starting points an
 * operator can change, and the UI shows the values it used beside every number it derives.
 */
export const WARNING_ASSUMPTIONS = Object.freeze({
  /** Scenario A: the baseline the comparison moves away from. */
  warningActivationDelayMinutes: 10,
  /** Scenario B: the faster alternative. */
  fasterActivationDelayMinutes: 4,
  /** Queue already present when the incident is recorded. A lane blockage does not start empty. */
  initialQueueMeters: 200,
  /** How fast the tail travels back upstream while the blockage persists. */
  queueGrowthMetersPerMinute: 120,
  /** Free-flow approach speed, for how long a driver has between seeing a sign and the tail. */
  approachSpeedKmh: 100,
  /** How long the blockage is assumed to persist. Caps the queue rather than growing it forever. */
  incidentDurationMinutes: 45,
});

export const WARNING_ASSUMPTION_LABELS = Object.freeze({
  warningActivationDelayMinutes: 'Warning activation delay (min)',
  fasterActivationDelayMinutes: 'Faster activation delay (min)',
  initialQueueMeters: 'Initial queue length (m)',
  queueGrowthMetersPerMinute: 'Queue growth (m/min)',
  approachSpeedKmh: 'Approach speed (km/h)',
  incidentDurationMinutes: 'Incident duration (min)',
});

/** The caller's overrides, over the defaults, with anything non-numeric ignored. */
export function resolveWarningAssumptions(overrides = {}) {
  const out = { ...WARNING_ASSUMPTIONS };
  for (const key of Object.keys(WARNING_ASSUMPTIONS)) {
    if (Number.isFinite(overrides?.[key])) out[key] = overrides[key];
  }
  return Object.freeze(out);
}

/**
 * How far back the simulated queue tail reaches, a given number of minutes after the incident.
 *
 * Capped at the assumed incident duration: once the blockage clears the queue stops growing, and
 * a queue that grew linearly for ever would reach absurd lengths on a long incident.
 */
export function simulatedQueueMetersAt(minutesSinceIncident, assumptions = WARNING_ASSUMPTIONS) {
  const settings = resolveWarningAssumptions(assumptions);
  if (!Number.isFinite(minutesSinceIncident) || minutesSinceIncident < 0) return null;
  const growing = Math.min(minutesSinceIncident, settings.incidentDurationMinutes);
  return Math.round(settings.initialQueueMeters + settings.queueGrowthMetersPerMinute * growing);
}

/**
 * One warning activation, and what it would have reached.
 *
 * `reachesTail` is only answered when a sign was actually resolved upstream — the distance from
 * the incident to the sign is what the queue tail is compared against, and without a sign there
 * is no comparison to make. Guessing a sign position would be the whole claim.
 */
function activationAt(delayMinutes, { anchorMs, dmsUpstreamMeters, assumptions }) {
  const settings = resolveWarningAssumptions(assumptions);
  const queueMeters = simulatedQueueMetersAt(delayMinutes, settings);
  const known = Number.isFinite(dmsUpstreamMeters);
  // A warning only helps a driver who has not yet reached the tail: the sign must be further
  // upstream than the tail has travelled.
  const reachesTail = known ? dmsUpstreamMeters > queueMeters : null;
  // How long a driver passing the sign has before reaching the tail, at the assumed speed.
  const gapMeters = known ? dmsUpstreamMeters - queueMeters : null;
  const warningSeconds = known && gapMeters > 0
    ? Math.round((gapMeters / 1000) / settings.approachSpeedKmh * 3600)
    : null;
  return Object.freeze({
    delayMinutes,
    atMs: Number.isFinite(anchorMs) ? anchorMs + delayMinutes * MINUTE : null,
    simulatedQueueMeters: queueMeters,
    simulatedQueueMiles: Math.round((queueMeters / METRES_PER_MILE) * 100) / 100,
    /** null, not false, when no sign was resolved — "we cannot say" is not "no". */
    reachesQueueTail: reachesTail,
    marginMeters: gapMeters,
    warningLeadSeconds: warningSeconds,
    simulated: true,
  });
}

/**
 * Two activation delays against the same simulated queue.
 *
 * Only the delay changes. The queue model, the approach speed and the sign position are held, and
 * the result says so — attributing a better outcome to an earlier warning when three things moved
 * at once is exactly the sleight of hand this comparison is meant to avoid.
 *
 * @param {{anchorMs: number, dmsUpstreamMeters: number|null, dmsId: string|null,
 *          assumptions?: object}} input
 */
export function compareWarningScenarios({
  anchorMs, dmsUpstreamMeters = null, dmsId = null, assumptions = {},
} = {}) {
  const settings = resolveWarningAssumptions(assumptions);
  if (!Number.isFinite(anchorMs)) {
    return Object.freeze({ resolved: false, reason: 'No incident timestamp to anchor the scenario to' });
  }
  const context = { anchorMs, dmsUpstreamMeters, assumptions: settings };
  const a = activationAt(settings.warningActivationDelayMinutes, context);
  const b = activationAt(settings.fasterActivationDelayMinutes, context);

  return Object.freeze({
    resolved: true,
    simulated: true,
    version: WARNING_SCENARIO_VERSION,
    dmsId,
    /** Null when no sign was resolved: the queue still grows, but nothing warns about it. */
    dmsUpstreamMeters,
    scenarioA: a,
    scenarioB: b,
    changedAssumption: 'warningActivationDelayMinutes',
    earlierByMinutes: a.delayMinutes - b.delayMinutes,
    /**
     * The queue extent AT EACH ACTIVATION MOMENT — not a benefit of the warning.
     *
     * This was previously published as `queueShorterByMeters`, which read as though activating
     * earlier made the queue shorter. It does not: the queue model is identical in both scenarios
     * and at any common time the extent is the same number. What differs is only how far the
     * queue had grown at the moment the sign lit up. The field is named for what it measures so
     * the misreading is not available to a caller.
     */
    queueAtActivationA: a.simulatedQueueMeters,
    queueAtActivationB: b.simulatedQueueMeters,
    /** Explicit, so no consumer has to infer it: the warning does not act on the queue. */
    queueModelUnchanged: true,
    held: Object.freeze([
      'initialQueueMeters', 'queueGrowthMetersPerMinute', 'approachSpeedKmh', 'dms position',
      'the queue model itself — identical in both scenarios',
    ]),
    assumptions: settings,
    caveat: dmsUpstreamMeters === null
      ? 'No upstream sign was resolved, so whether a warning would reach the back of the queue cannot be '
        + 'answered — only the simulated queue length is shown. The queue itself is hypothetical: the '
        + 'connected feed publishes no queue observations.'
      : 'Activation delay is the only changed assumption. The queue model is IDENTICAL in both '
        + 'scenarios — at any given time the simulated queue is the same length, and activating earlier '
        + 'does not shorten it. What changes is when the sign lights up relative to how far the queue '
        + 'has grown. Both the queue and the activation times are hypothetical: no queue observations '
        + 'and no DMS activation records are published. Effect on actual collisions: not estimated.',
  });
}

/**
 * Where the simulated queue tail sits along the corridor, for drawing it.
 *
 * Returned as a distance back from the incident, in metres, so the map layer can slice the real
 * centerline rather than inventing geometry. Null when there is no direction to measure back
 * along — a queue with no known direction cannot be drawn anywhere honest.
 */
export function simulatedQueueExtent({ minutesSinceIncident, assumptions = {}, upstreamResolved = false } = {}) {
  if (!upstreamResolved) return null;
  const metres = simulatedQueueMetersAt(minutesSinceIncident, assumptions);
  return Number.isFinite(metres) ? Object.freeze({ metres, simulated: true }) : null;
}
