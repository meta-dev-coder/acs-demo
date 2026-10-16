/**
 * What a crash does to the vehicles that would have crossed — and what it does NOT do.
 *
 * The distinction this module exists for: a blocked vehicle is not a lost toll. Most of them are
 * still on the corridor and cross a few minutes later. Treating reduced throughput as revenue loss
 * is the easiest way to produce a frightening number that no operator would recognise, so the
 * demand that cannot pass is classified explicitly instead:
 *
 *   DELAYED     queues and crosses later — revenue deferred, not lost
 *   DIVERTED    leaves the modelled toll point — revenue not collected here
 *   LOST        does not cross within the horizon at all
 *   UNRESOLVED  nobody has said which; reported as unresolved, never folded into a loss
 *
 * Vehicles are conserved: demand = crossings + still queued + diverted + lost. Asserted in tests.
 *
 * Deterministic five-minute buckets. This is a capacity model, not traffic physics — no shockwaves,
 * no car-following, no queue spill-back. That is Phase 4's SUMO work, and the limitations say so.
 */

/** Synthetic incident types. The reductions are demo assumptions, not FL511 observations. */
export const INCIDENT_PRESETS = Object.freeze([
  Object.freeze({ id: 'MINOR_CRASH', label: 'Minor crash', severity: 'MINOR',
    throughputReductionPercent: 25, durationMinutes: 30 }),
  Object.freeze({ id: 'MAJOR_CRASH', label: 'Major crash', severity: 'MAJOR',
    throughputReductionPercent: 50, durationMinutes: 90 }),
  Object.freeze({ id: 'DISABLED_VEHICLE', label: 'Disabled vehicle', severity: 'MINOR',
    throughputReductionPercent: 15, durationMinutes: 25 }),
  Object.freeze({ id: 'LANE_RESTRICTION', label: 'Lane restriction', severity: 'MINOR',
    throughputReductionPercent: 30, durationMinutes: 60 }),
  Object.freeze({ id: 'ROAD_CLOSURE', label: 'Temporary closure', severity: 'MAJOR',
    throughputReductionPercent: 100, durationMinutes: 20 }),
  Object.freeze({ id: 'CONGESTION', label: 'Congestion event', severity: 'MINOR',
    throughputReductionPercent: 20, durationMinutes: 45 }),
]);

export const incidentPreset = id => INCIDENT_PRESETS.find(preset => preset.id === id) ?? null;

/** What happens to demand that cannot pass. */
export const DEMAND_POLICY = Object.freeze({
  DELAYED: 'DELAYED', DIVERTED: 'DIVERTED', LOST: 'LOST', UNRESOLVED: 'UNRESOLVED',
});

/**
 * The default handling: most of it waits, some of it turns off, none of it simply disappears.
 *
 * Synthetic, and the single most consequential assumption in an incident scenario — which is why
 * it is one editable object rather than a constant inside the arithmetic.
 */
export const DEMO_DEMAND_HANDLING = Object.freeze({
  policy: DEMAND_POLICY.DELAYED,
  /** Of the demand held back, the share that leaves the corridor rather than waiting. */
  divertedShare: 0.15,
  /** The share that does not cross within the horizon at all. */
  lostShare: 0,
});

/** Five minutes: fine enough for onset and clearance, coarse enough to stay readable. */
export const BUCKET_MINUTES = 5;

const clamp01 = value => Math.min(1, Math.max(0, Number(value) || 0));

/** An incident input, normalised from a preset id or explicit values. */
export function normaliseIncident(input) {
  if (!input) return null;
  const preset = typeof input === 'string' ? incidentPreset(input) : incidentPreset(input.type);
  const handling = { ...DEMO_DEMAND_HANDLING, ...(input?.demandHandling ?? {}) };
  return Object.freeze({
    type: (typeof input === 'string' ? input : input.type) ?? 'CUSTOM',
    label: preset?.label ?? 'Custom incident',
    severity: input?.severity ?? preset?.severity ?? 'MINOR',
    startOffsetMinutes: Math.max(0, Number(input?.startOffsetMinutes ?? 0)),
    durationMinutes: Math.max(0, Number(input?.durationMinutes ?? preset?.durationMinutes ?? 30)),
    throughputReductionPercent: Math.min(100, Math.max(0,
      Number(input?.throughputReductionPercent ?? preset?.throughputReductionPercent ?? 0))),
    affectedZoneIds: Object.freeze(input?.affectedZoneIds ? [...input.affectedZoneIds] : []),
    demandHandling: Object.freeze(handling),
    /** Where it is said to be. A demo position, never a recorded event. */
    location: input?.location ?? null,
    verificationStatus: 'SYNTHETIC_ASSUMPTION',
    dataOrigin: 'SYNTHETIC',
  });
}

export function validateIncident(incident) {
  const errors = [];
  if (!incident) return Object.freeze({ valid: true, errors: Object.freeze([]) });
  if (!(incident.throughputReductionPercent >= 0 && incident.throughputReductionPercent <= 100)) {
    errors.push({ code: 'BAD_INCIDENT', path: 'throughputReductionPercent',
      message: 'Throughput reduction must be between 0 and 100%.' });
  }
  if (!(incident.durationMinutes > 0 && incident.durationMinutes <= 10080)) {
    errors.push({ code: 'BAD_INCIDENT', path: 'durationMinutes',
      message: 'Incident duration must be between 1 minute and a week.' });
  }
  const handling = incident.demandHandling ?? {};
  if (!Object.values(DEMAND_POLICY).includes(handling.policy)) {
    errors.push({ code: 'BAD_INCIDENT', path: 'demandHandling.policy',
      message: 'The demand-handling policy must be delayed, diverted, lost or unresolved.' });
  }
  const shares = (Number(handling.divertedShare) || 0) + (Number(handling.lostShare) || 0);
  if (shares > 1) {
    errors.push({ code: 'BAD_INCIDENT', path: 'demandHandling',
      message: 'The diverted and lost shares cannot add to more than all of the held-back demand.' });
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

/** Whether an interval overlaps a condition's window. */
export const activeIn = (condition, startMinute, endMinute) => {
  if (!condition) return false;
  const from = condition.startOffsetMinutes ?? 0;
  const to = from + (condition.durationMinutes ?? 0);
  return startMinute < to && endMinute > from;
};

/**
 * Crossings bucket by bucket, with the queue carried forward.
 *
 * Capacity is the baseline arrival rate reduced by the incident while it is running: the model has
 * no independent measure of the gantry's capacity, so "normal throughput" is what would have
 * crossed. Once the incident clears, the queue drains at the configured recovery multiple of the
 * normal rate until it is gone.
 *
 * @param {{totalCrossings: number, durationMinutes: number, incident: object|null,
 *          recoveryCapacityMultiple?: number}} input
 */
export function crossingsOverTime({
  totalCrossings = 0, durationMinutes = 0, incident = null, recoveryCapacityMultiple = 1.3,
} = {}) {
  const buckets = Math.max(1, Math.ceil(durationMinutes / BUCKET_MINUTES));
  const perBucketDemand = totalCrossings / buckets;
  const handling = incident?.demandHandling ?? DEMO_DEMAND_HANDLING;
  const unresolved = handling.policy === DEMAND_POLICY.UNRESOLVED;

  let queue = 0;
  let diverted = 0;
  let lost = 0;
  const rows = [];
  for (let index = 0; index < buckets; index++) {
    const from = index * BUCKET_MINUTES;
    const to = from + BUCKET_MINUTES;
    const blocked = activeIn(incident, from, to);
    const reduction = blocked ? clamp01(incident.throughputReductionPercent / 100) : 0;
    // While the incident runs, capacity is what gets past it. Afterwards there is spare capacity to
    // work the queue off; without an incident the two are simply equal.
    const capacity = blocked
      ? perBucketDemand * (1 - reduction)
      : perBucketDemand * (queue > 0 ? recoveryCapacityMultiple : 1);
    const offered = perBucketDemand + queue;
    const crossed = Math.min(offered, capacity);
    let held = offered - crossed;

    // The held-back demand is classified now, not at the end: a vehicle that turns off is gone from
    // the queue, and only what stays can cross later.
    //
    // The shares apply to THIS bucket's arrivals only. Applying them to the whole queue charged
    // every waiting vehicle a diversion probability again in each five-minute step, which turned a
    // 15% diversion assumption into 30% of all demand leaving the corridor.
    const newlyHeld = Math.min(held, perBucketDemand);
    let bucketDiverted = 0;
    let bucketLost = 0;
    if (newlyHeld > 0 && !unresolved) {
      if (handling.policy === DEMAND_POLICY.DIVERTED) { bucketDiverted = newlyHeld; }
      else if (handling.policy === DEMAND_POLICY.LOST) { bucketLost = newlyHeld; }
      else {
        bucketDiverted = newlyHeld * clamp01(handling.divertedShare);
        bucketLost = newlyHeld * clamp01(handling.lostShare);
      }
      held -= bucketDiverted + bucketLost;
    }
    diverted += bucketDiverted;
    lost += bucketLost;
    queue = held;
    rows.push(Object.freeze({
      fromMinute: from, toMinute: Math.min(to, durationMinutes),
      demand: perBucketDemand, crossed, queued: queue, diverted: bucketDiverted, lost: bucketLost,
      incidentActive: blocked,
    }));
  }

  const crossed = rows.reduce((total, row) => total + row.crossed, 0);
  return Object.freeze({
    buckets: Object.freeze(rows),
    bucketMinutes: BUCKET_MINUTES,
    demand: totalCrossings,
    crossed,
    /** Still waiting when the horizon ends: deferred, not lost. */
    deferred: queue,
    diverted,
    lost,
    unresolved: unresolved ? totalCrossings - crossed : 0,
    policy: handling.policy,
    /** demand = crossed + deferred + diverted + lost. Checked in tests. */
    conserved: Math.abs(totalCrossings - (crossed + queue + diverted + lost)) < 1e-6,
  });
}
