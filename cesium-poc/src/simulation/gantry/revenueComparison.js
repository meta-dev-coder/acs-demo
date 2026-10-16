/**
 * The baseline run, the scenario run, and the difference between them.
 *
 * Both runs use the same demand, the same rates, the same duration and the same costs. The ONLY
 * difference is the equipment: the baseline uses the synthetic condition each asset is already in
 * — which is not "everything works", since eight of them are failed before any scenario starts —
 * and the scenario applies the what-if on top of that.
 *
 * That is what makes "simulate a failure on something already failed" come out at zero rather than
 * at a fabricated loss: the asset is out in both runs, so the difference is nothing.
 */
import { runCase } from './combinedScenario.js';
import { assessmentStatus, FINANCIAL_STATUS, revenueFor } from './revenueEngine.js';
import { recoveryShift } from './transactionRecovery.js';
import { validateBaseline } from './syntheticTollingBaseline.js';

const money = value => `$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const whole = value => Math.round(value).toLocaleString('en-US');

/** The condition each asset is in before any scenario: its synthetic baseline, as it stands. */
export const baselineConditions = (inventory = []) => Object.fromEntries(inventory
  .map(asset => [asset.assetId, {
    simulatedStatus: asset.operationalStatus ?? 'OPERATIONAL',
    // Carried so a degraded asset has something to be degraded BY: the baseline states a condition
    // and a health score, never a performance percentage.
    healthScore: asset.health?.score ?? null,
  }]));

/** The same, with the scenario's effective states written over the assets it names. */
export function scenarioConditions(inventory, equipmentStates = []) {
  const conditions = { ...baselineConditions(inventory) };
  for (const state of equipmentStates) {
    conditions[state.assetId] = {
      simulatedStatus: state.simulatedStatus,
      availabilityPercent: state.availabilityPercent,
      performancePercent: state.performancePercent,
      // Kept, so an asset the scenario leaves degraded is still measured the baseline's way.
      healthScore: conditions[state.assetId]?.healthScore ?? null,
    };
  }
  return conditions;
}

/**
 * The financial half of a what-if.
 *
 * @param {{equipment: object[], durationMinutes: number}} scenarioResult the Phase 1 result
 * @param {{inventory: object[], zones: object[], baseline: object}} context
 */
/**
 * @param {object} scenarioResult the Phase 1 equipment result
 * @param {{inventory, zones, baseline, weather, incident, sensitivity}} context
 *   `weather` and `incident` are Phase 3. Without them this is exactly the Phase 2 calculation:
 *   the baseline case and the scenario case differ only in the equipment.
 */
export function financialImpact(scenarioResult, {
  inventory = [], zones = [], baseline, weather = null, incident = null, sensitivity = undefined,
} = {}) {
  const checked = validateBaseline(baseline);
  if (!checked.valid) {
    return Object.freeze({
      status: FINANCIAL_STATUS.NOT_ASSESSED,
      dataOrigin: baseline?.dataOrigin ?? 'SYNTHETIC',
      errors: checked.errors,
      missingAssumptions: Object.freeze(checked.errors.map(error => error.message)),
    });
  }

  const durationMinutes = scenarioResult.durationMinutes;
  // Both cases, over the same horizon, through the same bucket loop. The baseline is the gantry as
  // it stands: today's equipment conditions, clear weather and no incident — which is what makes
  // the difference attributable to the scenario and nothing else.
  const before = runCase({
    zones, baseline, conditions: baselineConditions(inventory), durationMinutes, sensitivity });
  const after = runCase({
    zones, baseline, durationMinutes, weather, incident, sensitivity,
    conditions: scenarioConditions(inventory, scenarioResult.equipment ?? []) });

  const baselineRun = revenueFor(before, baseline);
  const scenarioRun = revenueFor(after, baseline);
  const status = assessmentStatus(after);

  const shift = recoveryShift(before.totals, after.totals);
  const delta = Object.freeze({
    crossings: scenarioRun.transactions.crossings - baselineRun.transactions.crossings,
    rfidSuccess: scenarioRun.transactions.rfidSuccess - baselineRun.transactions.rfidSuccess,
    videoAttempts: scenarioRun.transactions.videoAttempts - baselineRun.transactions.videoAttempts,
    videoRecovered: scenarioRun.transactions.videoRecovered - baselineRun.transactions.videoRecovered,
    unrecovered: scenarioRun.transactions.unrecovered - baselineRun.transactions.unrecovered,
    collectedRevenueUSD: Number((scenarioRun.money.collectedRevenueUSD - baselineRun.money.collectedRevenueUSD).toFixed(2)),
    unrecoveredRevenueUSD: Number((scenarioRun.money.unrecoveredRevenueUSD - baselineRun.money.unrecoveredRevenueUSD).toFixed(2)),
    processingCostUSD: Number((scenarioRun.money.processingCostUSD - baselineRun.money.processingCostUSD).toFixed(2)),
    netContributionUSD: Number((scenarioRun.money.netContributionUSD - baselineRun.money.netContributionUSD).toFixed(2)),
  });

  // Vehicles that did not cross, and what that is worth — kept apart from revenue that was lost,
  // because a queued vehicle pays its toll a few minutes later.
  const toll = Number(baseline.tolling.averageTollUSD) || 0;
  const traffic = after.traffic;
  const trafficImpact = Object.freeze({
    policy: traffic.policy,
    plannedCrossings: Number(after.plannedCrossings.toFixed(1)),
    crossings: Number(traffic.crossed.toFixed(1)),
    deferredCrossings: Number(traffic.deferred.toFixed(1)),
    divertedCrossings: Number(traffic.diverted.toFixed(1)),
    lostCrossings: Number(traffic.lost.toFixed(1)),
    unresolvedCrossings: Number((traffic.unresolved ?? 0).toFixed(1)),
    conserved: traffic.conserved,
    buckets: traffic.buckets.length,
    bucketMinutes: after.bucketMinutes,
    /** Timing, not loss: this toll is expected after the horizon ends. */
    deferredRevenueUSD: Number((traffic.deferred * toll).toFixed(2)),
    divertedRevenueUSD: Number((traffic.diverted * toll).toFixed(2)),
    lostRevenueUSD: Number((traffic.lost * toll).toFixed(2)),
    unresolvedRevenueUSD: Number(((traffic.unresolved ?? 0) * toll).toFixed(2)),
  });

  // What the result cannot speak for, named rather than absorbed into the totals.
  const missing = [...after.missing];
  // Weather with no sensitivity model for a class does not change it — and that is an absence of
  // modelling, not a measured zero. Said, every time.
  if (weather && after.environment.unconfigured.length) {
    missing.push(`no weather sensitivity is configured for ${after.environment.unconfigured
      .map(type => type.toLowerCase().replace(/_/g, ' ')).join(' or ')}, so weather does not change them here`);
  }
  if (incident && traffic.policy === 'UNRESOLVED') {
    missing.push('the incident has no demand-handling policy, so the vehicles it holds back are '
      + 'neither counted as delayed nor as lost');
  }
  const unaffectedByModel = (scenarioResult.equipment ?? [])
    .filter(state => !zones.some(zone => zone.rfidAssetIds.includes(state.assetId)
      || zone.vesAssetIds.includes(state.assetId)))
    .map(state => state.assetId);

  return Object.freeze({
    status,
    dataOrigin: baseline.dataOrigin,
    baselineId: baseline.baselineId,
    durationMinutes: scenarioResult.durationMinutes,
    demand: Object.freeze({ basis: 'CONSTANT_RATE', total: Number(after.plannedCrossings.toFixed(1)),
      vehiclesPerHour: baseline.traffic.vehiclesPerHour }),
    baseline: baselineRun,
    scenario: scenarioRun,
    delta,
    traffic: trafficImpact,
    weather: weather ? Object.freeze({ ...weather, effectiveness: Object.freeze({
      capture: after.environment.capture, read: after.environment.read,
      surveillance: after.environment.surveillance }) }) : null,
    incident: incident ?? null,
    recovery: shift,
    videoProcessingCharge: scenarioRun.videoProcessingCharge,
    notAssessedZoneIds: scenarioRun.notAssessedZoneIds,
    excludedCrossings: scenarioRun.excludedCrossings,
    /** Equipment the scenario affected that no tolling zone depends on — CCTV, for instance. */
    outsideFinancialModel: Object.freeze(unaffectedByModel),
    missingAssumptions: Object.freeze([...new Set(missing)]),
    explanation: explain({ scenarioResult, delta, shift, status, scenarioRun, unaffectedByModel, zones,
      weather, incident, trafficImpact }),
  });
}

/**
 * Why the money moved, in the operator's words and with this scenario's own figures.
 *
 * Built from the numbers rather than chosen from a list of sentences, so it can never contradict
 * the table beside it — including the case where nothing changed at all.
 */
function explain({ scenarioResult, delta, shift, status, scenarioRun, unaffectedByModel, zones = [],
  weather = null, incident = null, trafficImpact = null }) {
  const states = scenarioResult.equipment ?? [];
  const lines = [];
  const named = states.length === 1 ? states[0].name : `${states.length} assets`;
  const duration = scenarioResult.durationMinutes === 60 ? 'one hour'
    : scenarioResult.durationMinutes === 120 ? 'two hours' : `${scenarioResult.durationMinutes} minutes`;

  if (status === FINANCIAL_STATUS.NOT_ASSESSED) {
    return ['No tolling zone in this scenario can be assessed with the assumptions configured, '
      + 'so no financial estimate is produced.'];
  }

  // Said BEFORE anything about the figures: when the affected equipment sits in a zone that could
  // not be assessed, the totals are unchanged because that zone is excluded — which is not the
  // same thing as the scenario having had no effect.
  const excludedZones = new Set(scenarioRun.notAssessedZoneIds);
  const affectedInExcluded = (scenarioResult.equipment ?? []).some(state => zones.some(zone =>
    excludedZones.has(zone.zoneId)
    && (zone.rfidAssetIds.includes(state.assetId) || zone.vesAssetIds.includes(state.assetId))));
  if (affectedInExcluded) {
    lines.push(`${named} was simulated for ${duration}, but the tolling zone it serves could not be `
      + 'assessed with the assumptions configured, so its financial effect is excluded from these figures.');
    lines.push(`${scenarioRun.notAssessedZoneIds.length} tolling zone(s) are excluded, covering about `
      + `${whole(scenarioRun.excludedCrossings)} crossings.`);
    return lines;
  }

  if (Math.abs(delta.videoAttempts) < 0.5 && Math.abs(delta.netContributionUSD) < 0.005) {
    lines.push(`${named} was simulated for ${duration}, and under the configured synthetic `
      + 'assumptions the tolling outcome is unchanged.');
    if (unaffectedByModel.length) {
      lines.push('No tolling zone depends on the affected equipment in this model, so toll '
        + 'collection is not reduced by it.');
    }
    return lines;
  }

  const conditions = [
    states.length ? named : null,
    weather ? (weather.label ?? weather.type).toLowerCase() : null,
    incident ? (incident.label ?? incident.type).toLowerCase() : null,
  ].filter(Boolean).join(' with ');
  lines.push(`${conditions || 'The scenario'} was simulated for ${duration}.`
    + (weather ? ' Weather reduces how much the cameras capture, so video recovery is less effective.' : '')
    + (delta.videoAttempts > 0.5 ? ' More vehicles fall back to video tolling.' : ''));
  if (incident && trafficImpact) {
    lines.push(`${whole(trafficImpact.plannedCrossings - trafficImpact.crossings)} crossings did not pass `
      + `during the assessment: ${whole(trafficImpact.deferredCrossings)} are still queued at the end `
      + `(${money(trafficImpact.deferredRevenueUSD)} deferred, not lost) and `
      + `${whole(trafficImpact.divertedCrossings)} are assumed to divert `
      + `(${money(trafficImpact.divertedRevenueUSD)}).`);
  }
  if (shift.additionalAttempts > 0) {
    lines.push(`An additional ${whole(shift.additionalAttempts)} transactions require video processing, `
      + `increasing estimated processing costs by ${money(delta.processingCostUSD)}.`);
  }
  if (shift.additionalRecovered > 0) {
    lines.push(`${whole(shift.additionalRecovered)} of those are still expected to be collected through `
      + 'video tolling.');
  }
  if (delta.unrecovered > 0.5) {
    lines.push(`${whole(delta.unrecovered)} transactions are expected to remain unrecovered, `
      + `about ${money(delta.unrecoveredRevenueUSD)} of toll value.`);
  }
  lines.push(`Net tolling contribution changes by ${delta.netContributionUSD < 0 ? '−' : '+'}`
    + `${money(delta.netContributionUSD)} over the scenario.`);
  if (status === FINANCIAL_STATUS.PARTIALLY_ASSESSED) {
    lines.push(`${scenarioRun.notAssessedZoneIds.length} tolling zone(s) could not be assessed and are `
      + 'excluded from these figures.');
  }
  return lines;
}
