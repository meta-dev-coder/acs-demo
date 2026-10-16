/**
 * How much a response strategy changes EXPOSURE to a secondary incident.
 *
 * The temptation here is to produce a probability. The TMC's risk engine returns a score out of 100
 * and it would be one line to call it a percentage — but it is an operational prioritisation score,
 * not a calibrated likelihood, and 62/100 is not a 62% chance of anything. No crash-modification
 * factor exists for any of these levers in this twin, so nothing here converts a score into
 * prevented accidents.
 *
 * What CAN be stated, and is:
 *
 *   • EXPOSURE, as a quantity. Vehicle-hours spent stationary in a queue on a live motorway is a
 *     real measure of how much opportunity for a rear-end collision the response created. It is
 *     computed from the queue model, not estimated.
 *   • The DURATION of elevated exposure — how long a queue stood at all.
 *   • WARNING LEAD — how long drivers were being warned before the back of the queue reached them.
 *     Negative lead means the queue arrived before the warning did.
 *   • A relative COMPARISON between scenarios, as a ratio against the baseline.
 *
 * The index at the end is ordinal, for sorting a list. It is labelled as such everywhere it is
 * shown, and `isProbability` is false so no caller can misread it.
 */

/** Queue growth rate above which the back of the queue is moving faster than drivers can react. */
const FAST_GROWTH_VEH_PER_MIN = 40;

/** Weather words the register uses that reduce how far a driver can see a queue. */
const LOW_VISIBILITY = /rain|fog|storm|smoke|humid/i;

/**
 * Exposure for one scenario.
 *
 * @param {{queue: object, timeline: object, baseline: object, hotspotRecords?: number}} input
 */
export function exposureFor({ queue, timeline, baseline, hotspotRecords = 0 } = {}) {
  if (!queue || !timeline) return null;

  /** The real quantity: vehicle-hours standing in a queue on a live carriageway. */
  const vehicleHoursExposed = queue.vehicleHoursOfDelay;
  const elevatedMinutes = queue.queueMinutes;

  /** When the back of the queue first existed, against when drivers were being warned. */
  const firstQueueBucket = queue.buckets.find(row => row.queued > 0.5);
  const queueStartMinute = firstQueueBucket?.fromMinute ?? null;
  const warningLeadMinutes = queueStartMinute == null ? null
    : Number((queueStartMinute - timeline.warningActive).toFixed(1));

  /** How fast the queue built in its worst five minutes. */
  let fastestGrowth = 0;
  for (let index = 1; index < queue.buckets.length; index += 1) {
    const growth = (queue.buckets[index].queued - queue.buckets[index - 1].queued) / queue.bucketMinutes;
    if (growth > fastestGrowth) fastestGrowth = growth;
  }

  const weather = baseline?.observed?.weather?.value ?? null;
  const lowVisibility = Boolean(weather && LOW_VISIBILITY.test(weather));

  /* The ordinal index. Each component is stated, weighted and bounded, so a reader can see what
     moved it — and none of it is a probability. */
  const components = Object.freeze([
    {
      id: 'queueExposure',
      label: 'Vehicle-hours stationary in the queue',
      value: vehicleHoursExposed,
      points: Math.min(40, vehicleHoursExposed / 25),
      note: 'The quantity of opportunity for a rear-end collision the response created.',
    },
    {
      id: 'duration',
      label: 'Minutes with a queue standing',
      value: elevatedMinutes,
      points: Math.min(20, elevatedMinutes / 10),
      note: 'How long the hazard existed at all.',
    },
    {
      id: 'growth',
      label: 'Fastest queue growth (vehicles/min)',
      value: Number(fastestGrowth.toFixed(1)),
      points: Math.min(15, (fastestGrowth / FAST_GROWTH_VEH_PER_MIN) * 15),
      note: 'A queue that builds faster than drivers can react is the classic secondary-collision '
        + 'situation.',
    },
    {
      id: 'warningLead',
      label: 'Warning lead before the queue formed (min)',
      value: warningLeadMinutes,
      points: warningLeadMinutes == null ? 0
        : warningLeadMinutes >= 10 ? 0 : warningLeadMinutes >= 0 ? 7 : 15,
      note: warningLeadMinutes != null && warningLeadMinutes < 0
        ? 'The queue formed before the warning was active.'
        : 'Time drivers were being warned before there was anything to warn them about.',
    },
    {
      id: 'visibility',
      label: 'Visibility on the record',
      value: weather ?? 'not recorded',
      points: lowVisibility ? 5 : 0,
      note: lowVisibility
        ? 'The register’s weather word suggests reduced visibility. A word, not a measurement.'
        : 'No reduced-visibility word on this record.',
    },
    {
      id: 'history',
      label: 'Records already concentrated here',
      value: hotspotRecords,
      points: Math.min(5, hotspotRecords / 4),
      note: 'Where incidents already recur, another one has more company.',
    },
  ].map(component => Object.freeze({ ...component, points: Number(component.points.toFixed(1)) })));

  const index = Number(components.reduce((sum, component) => sum + component.points, 0).toFixed(1));

  return Object.freeze({
    /** The quantity. Use this one for anything that matters. */
    vehicleHoursExposed,
    elevatedMinutes,
    maxQueueVehicles: queue.maxQueueVehicles,
    warningLeadMinutes,
    fastestQueueGrowthPerMinute: Number(fastestGrowth.toFixed(1)),
    lowVisibility,
    components,
    /** Ordinal only. 0–100, for ranking. */
    index,
    band: index >= 60 ? 'HIGH' : index >= 35 ? 'MODERATE' : 'LOW',
    isProbability: false,
    indexNote: 'An ordinal exposure index for ranking scenarios against each other. It is NOT a '
      + 'probability of a secondary incident, and it must not be read as a percentage. No '
      + 'calibrated secondary-collision model exists for this corridor.',
  });
}

/**
 * One scenario's exposure against the baseline's.
 *
 * Reported as a change in the quantity, with the index change beside it, and never as accidents
 * prevented.
 */
export function compareExposure(scenario, baseline) {
  if (!scenario || !baseline) return null;
  const change = (now, before) => (before > 0 ? Number((((now - before) / before) * 100).toFixed(1)) : null);
  return Object.freeze({
    vehicleHoursExposed: scenario.vehicleHoursExposed,
    baselineVehicleHoursExposed: baseline.vehicleHoursExposed,
    vehicleHoursChangePercent: change(scenario.vehicleHoursExposed, baseline.vehicleHoursExposed),
    elevatedMinutesChange: scenario.elevatedMinutes - baseline.elevatedMinutes,
    indexChange: Number((scenario.index - baseline.index).toFixed(1)),
    warningLeadChange: scenario.warningLeadMinutes != null && baseline.warningLeadMinutes != null
      ? Number((scenario.warningLeadMinutes - baseline.warningLeadMinutes).toFixed(1)) : null,
    direction: scenario.vehicleHoursExposed < baseline.vehicleHoursExposed ? 'LOWER'
      : scenario.vehicleHoursExposed > baseline.vehicleHoursExposed ? 'HIGHER' : 'UNCHANGED',
    claim: 'A change in modelled exposure, not a number of secondary incidents prevented. No '
      + 'crash-modification factor is applied anywhere in this simulation.',
  });
}
