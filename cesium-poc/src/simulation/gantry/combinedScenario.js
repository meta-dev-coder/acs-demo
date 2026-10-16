/**
 * Running one scenario's conditions over time, whatever those conditions are.
 *
 * Equipment failures, weather and an incident can all be in force at once, and they need not cover
 * the same minutes. So a case is evaluated in five-minute buckets: each bucket knows which
 * conditions apply to it, and the totals are the sum of the buckets rather than the worst minute
 * multiplied by the duration.
 *
 * Composition is deliberately simple and stated: within a bucket,
 *
 *     effective capability = equipment capability × weather effectiveness
 *
 * applied once, at the zone. Weather impairs; equipment fails; the two are independent factors in
 * this model and neither is applied twice.
 *
 * With no weather and no incident this reduces exactly to the Phase 2 calculation — every bucket
 * carries an equal share of demand and the arithmetic is linear in it — so Phase 2's results are
 * unchanged. That is asserted in the tests rather than assumed.
 */
import { runTransactions } from './transactionEngine.js';
import { activeIn, BUCKET_MINUTES, crossingsOverTime } from './trafficImpact.js';
import { weatherEffectiveness } from './weatherImpact.js';
import { demandForDuration } from './vehicleDemand.js';

/** The capability multipliers the weather implies for a zone's readers and cameras. */
export function environmentFor(weather, sensitivity) {
  const effect = weatherEffectiveness(weather, sensitivity);
  return {
    read: effect.byType.RFID_ANTENNA ?? 1,
    capture: effect.byType.VES_CAMERA ?? 1,
    surveillance: effect.byType.CCTV_CAMERA ?? 1,
    unconfigured: effect.unconfigured,
    clear: effect.clear,
  };
}

const addTotals = (into, from) => {
  for (const key of Object.keys(from)) into[key] = (into[key] ?? 0) + from[key];
  return into;
};

/**
 * One case — a set of conditions — over the whole horizon.
 *
 * @param {{zones, baseline, conditions, durationMinutes, weather, incident, sensitivity}} input
 */
export function runCase({
  zones = [], baseline, conditions = {}, durationMinutes = 0, weather = null, incident = null,
  sensitivity = undefined,
} = {}) {
  // How many vehicles reach the gantry at all, bucket by bucket: the incident decides that, and it
  // is settled before any transaction is considered.
  const planned = demandForDuration({
    zones, vehiclesPerHour: baseline.traffic.vehiclesPerHour, durationMinutes });
  const traffic = crossingsOverTime({
    totalCrossings: planned.total, durationMinutes, incident });
  const environment = environmentFor(weather, sensitivity);

  const totals = {};
  const zoneTotals = new Map();
  const notAssessed = new Set();
  const missing = new Set();
  let excludedCrossings = 0;

  for (const bucket of traffic.buckets) {
    const active = !weather || activeIn(weather, bucket.fromMinute, bucket.toMinute);
    const bucketEnvironment = active ? environment : null;
    // The crossings that actually passed in this bucket, split by the zones' configured shares.
    const byZone = {};
    for (const zone of zones) byZone[zone.zoneId] = bucket.crossed * (Number(zone.demandShare) || 0);
    const run = runTransactions({
      zones, demand: { byZone }, baseline, conditions, environment: bucketEnvironment });
    addTotals(totals, run.totals);
    excludedCrossings += run.excludedCrossings;
    for (const zone of run.zones) {
      if (zone.status !== 'CALCULATED_SYNTHETIC') {
        notAssessed.add(zone.zoneId);
        for (const item of zone.missing ?? []) missing.add(`${zone.zoneId}: ${item}`);
        continue;
      }
      const carried = zoneTotals.get(zone.zoneId) ?? { crossings: 0, rfidSuccess: 0, videoAttempts: 0, videoRecovered: 0, unrecovered: 0 };
      zoneTotals.set(zone.zoneId, addTotals(carried, {
        crossings: zone.crossings, rfidSuccess: zone.rfidSuccess, videoAttempts: zone.videoAttempts,
        videoRecovered: zone.videoRecovered, unrecovered: zone.unrecovered,
      }));
    }
  }

  return Object.freeze({
    totals: Object.freeze({
      crossings: totals.crossings ?? 0,
      rfidSuccess: totals.rfidSuccess ?? 0,
      videoAttempts: totals.videoAttempts ?? 0,
      videoRecovered: totals.videoRecovered ?? 0,
      unrecovered: totals.unrecovered ?? 0,
    }),
    traffic,
    environment,
    bucketMinutes: BUCKET_MINUTES,
    zones: Object.freeze([...zoneTotals.entries()].map(([zoneId, values]) => Object.freeze({ zoneId, ...values }))),
    assessedZoneIds: Object.freeze([...zoneTotals.keys()]),
    notAssessedZoneIds: Object.freeze([...notAssessed]),
    missing: Object.freeze([...missing]),
    excludedCrossings,
    /** What was planned to cross before any incident held it back. */
    plannedCrossings: planned.total,
  });
}
