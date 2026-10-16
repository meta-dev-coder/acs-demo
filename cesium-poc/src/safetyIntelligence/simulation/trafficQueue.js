/**
 * What a blocked lane does to the traffic behind it, five minutes at a time.
 *
 * The gantry what-if already has a bucketed queue with a conservation identity
 * (`src/simulation/gantry/trafficImpact.js`), and this shares its vocabulary deliberately — the same
 * bucket length, the same demand policy, the same "demand = crossed + queued + diverted + lost".
 * What it cannot share is the capacity model: there, capacity is a percentage reduction at a gantry
 * for a fixed window; here it is a LANE COUNT that changes three times as the response runs, and
 * the horizon has to keep going until the queue is gone rather than stopping at a configured
 * duration. Two different physical situations, one accounting discipline.
 *
 * Everything is deterministic. Nothing reads a clock.
 */
import { BUCKET_MINUTES, DEMAND_POLICY } from '../../simulation/gantry/trafficImpact.js';

export { BUCKET_MINUTES, DEMAND_POLICY };

/** Stop even if the queue has not cleared: a 12-hour queue means the inputs are wrong. */
export const MAX_HORIZON_MINUTES = 12 * 60;

/**
 * Capacity while the incident is on the road.
 *
 * Blocking a lane costs more than that lane's share: drivers slow to look, and the merge itself
 * eats capacity. The penalty is applied once, for as long as anything is blocked.
 */
export function capacityFor({ lanes, blockedLanes, capacityPerLaneVph, penalty }) {
  const open = Math.max(0, lanes - Math.max(0, blockedLanes));
  if (open === 0) return 0;
  const clean = open * capacityPerLaneVph;
  return blockedLanes > 0 ? clean * (1 - penalty) : clean;
}

/**
 * How many lanes are blocked at a given minute.
 *
 * Three phases: everything blocked until the partial reopening, one lane back from then to full
 * reopening, nothing blocked after. "One lane back" is the model's reading of a partial reopening —
 * it is what the word means operationally, and it is stated rather than configurable so the
 * optimizer cannot invent a partial reopening that gives back more than it should.
 */
export const blockedAt = (minute, { blockedLanes, partialReopen, fullReopen }) => {
  if (minute >= fullReopen) return 0;
  if (minute >= partialReopen) return Math.max(0, blockedLanes - 1);
  return blockedLanes;
};

/**
 * Run the queue.
 *
 * @param {{demandVph: number, lanes: number, blockedLanes: number, capacityPerLaneVph: number,
 *          penalty: number, partialReopen: number, fullReopen: number,
 *          divertedShare: number, lostShare: number, horizonMinutes?: number}} input
 */
export function runQueue({
  demandVph = 0, lanes = 4, blockedLanes = 0, capacityPerLaneVph = 1900, penalty = 0.14,
  partialReopen = 0, fullReopen = 0, divertedShare = 0.15, lostShare = 0.02,
  horizonMinutes = null,
} = {}) {
  const perBucket = (demandVph / 60) * BUCKET_MINUTES;
  const cleanCapacityPerBucket = (lanes * capacityPerLaneVph / 60) * BUCKET_MINUTES;
  const limit = Math.min(MAX_HORIZON_MINUTES,
    horizonMinutes ?? Math.ceil((fullReopen + 240) / BUCKET_MINUTES) * BUCKET_MINUTES);

  let queue = 0;
  let diverted = 0;
  let lost = 0;
  let crossed = 0;
  let demand = 0;
  /** Vehicle-minutes spent waiting: the queue standing through each bucket. */
  let vehicleMinutesQueued = 0;
  let queueClearedAt = null;
  let maxQueue = 0;
  let maxQueueAt = 0;
  const rows = [];

  for (let from = 0; from < limit; from += BUCKET_MINUTES) {
    const to = from + BUCKET_MINUTES;
    const blocked = blockedAt(from, { blockedLanes, partialReopen, fullReopen });
    const capacityVph = capacityFor({ lanes, blockedLanes: blocked, capacityPerLaneVph, penalty });
    const capacity = (capacityVph / 60) * BUCKET_MINUTES;

    const arrivals = perBucket;
    demand += arrivals;
    const offered = arrivals + queue;
    const served = Math.min(offered, capacity);
    let held = offered - served;

    // Only THIS bucket's new arrivals can decide to leave. Charging the whole standing queue a
    // diversion share every five minutes is the bug the gantry model already had to fix: it turned
    // a 15% assumption into most of the corridor.
    const newlyHeld = Math.min(held, arrivals);
    let bucketDiverted = 0;
    let bucketLost = 0;
    if (newlyHeld > 0) {
      bucketDiverted = newlyHeld * divertedShare;
      bucketLost = newlyHeld * lostShare;
      held -= bucketDiverted + bucketLost;
    }
    diverted += bucketDiverted;
    lost += bucketLost;
    crossed += served;
    queue = held;

    // The queue standing through the bucket is what the vehicles in it actually wait.
    vehicleMinutesQueued += queue * BUCKET_MINUTES;
    if (queue > maxQueue) { maxQueue = queue; maxQueueAt = to; }
    if (queue <= 0.5 && queueClearedAt === null && from >= fullReopen) queueClearedAt = to;

    rows.push(Object.freeze({
      fromMinute: from,
      toMinute: to,
      blockedLanes: blocked,
      capacity,
      arrivals,
      crossed: served,
      queued: queue,
      diverted: bucketDiverted,
      lost: bucketLost,
      /** Capacity as a share of what the stretch would carry with nothing on it. */
      capacityShare: cleanCapacityPerBucket ? Number((capacity / cleanCapacityPerBucket).toFixed(3)) : 0,
    }));

    // Nothing left to model: the queue is gone and the incident is over.
    if (queue <= 0.5 && from >= fullReopen && from > fullReopen + BUCKET_MINUTES) break;
  }

  const unresolved = queue;
  return Object.freeze({
    buckets: Object.freeze(rows),
    bucketMinutes: BUCKET_MINUTES,
    demand,
    crossed,
    /** Still queued when the horizon ended. DEFERRED, not lost — they are still on the road. */
    deferred: unresolved,
    diverted,
    lost,
    /** demand = crossed + deferred + diverted + lost, to within rounding. Asserted in tests. */
    conserved: Math.abs(demand - (crossed + unresolved + diverted + lost)) < 1e-6,
    vehicleHoursOfDelay: Number((vehicleMinutesQueued / 60).toFixed(1)),
    maxQueueVehicles: Math.round(maxQueue),
    maxQueueAtMinute: maxQueueAt,
    /** Queue length in metres, at 7.5 m per vehicle per lane. A planning conversion. */
    maxQueueMetres: Math.round((maxQueue / Math.max(1, lanes)) * 7.5),
    queueClearedAtMinute: queueClearedAt,
    queueDissipationMinutes: queueClearedAt == null ? null
      : Number(Math.max(0, queueClearedAt - fullReopen).toFixed(0)),
    horizonMinutes: rows.length * BUCKET_MINUTES,
    queueMinutes: rows.filter(row => row.queued > 0.5).length * BUCKET_MINUTES,
    /** True when the horizon ran out with vehicles still waiting: the result is a floor, not a total. */
    truncated: unresolved > 0.5,
    delayBasis: 'Vehicle-hours are the queue standing through each five-minute bucket, summed. The '
      + 'baseline is free-flow: a vehicle that never queues incurs no modelled delay.',
  });
}

/** What the queue would have been with nothing blocking it — usually nothing, and that is the point. */
export const freeFlowQueue = input => runQueue({ ...input, blockedLanes: 0, partialReopen: 0, fullReopen: 0 });

/**
 * Is the stretch already over capacity before the incident?
 *
 * If it is, a queue model will report enormous delays for reasons that have nothing to do with the
 * incident, and the result must not be read as the incident's doing.
 */
export function saturationCheck({ demandVph, lanes, capacityPerLaneVph }) {
  const ratio = demandVph / (lanes * capacityPerLaneVph);
  return Object.freeze({
    volumeToCapacity: Number(ratio.toFixed(2)),
    oversaturated: ratio >= 1,
    warning: ratio >= 0.95
      ? 'The assumed demand is at or above the assumed capacity before anything blocks a lane. The '
        + 'queue below is then a result of the ASSUMPTIONS, not of the incident. Correct the lane '
        + 'count or the demand before reading these numbers.'
      : null,
  });
}
