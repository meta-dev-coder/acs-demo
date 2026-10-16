/**
 * What happens to the vehicles crossing one tolling zone, under one set of equipment conditions.
 *
 * An expected-value model, not a vehicle-by-vehicle one: with no transaction history to calibrate
 * against, simulating ten thousand individual vehicles would add arithmetic, not knowledge. The
 * outcomes are mutually exclusive by construction, so nothing is counted twice:
 *
 *     crossings = read by transponder + sent to video
 *     sent to video = recovered on video + unrecovered
 *
 * Equipment enters only through two multipliers — how well the zone can read, and how well it can
 * capture an image — and those come from configured coverage assumptions, never from the failure
 * mode directly. "60% available" is not "40% of tolls lost", and this is the file that keeps the
 * two apart.
 *
 * Pure and deterministic: same inputs, same numbers, every time.
 */
import { COVERAGE_MODEL } from './tollingZones.js';

/** Why a zone could not be assessed. Reported; never rounded down to zero impact. */
export const ZONE_STATUS = Object.freeze({
  CALCULATED: 'CALCULATED_SYNTHETIC',
  NOT_ASSESSED: 'NOT_ASSESSED',
});

/**
 * How much of its job a single device can still do, from its effective condition.
 *
 * The scenario's own parameters are used where they exist, because they are what the operator
 * chose. A disconnected device is the one case with no default: whether a buffered read still
 * reaches the back office is not something this twin knows, so it returns null and the zone says
 * so rather than inventing a number.
 */
export function deviceEffectiveness(state, { communicationDeliveryShare = null } = {}) {
  if (!state) return 1;
  switch (state.simulatedStatus ?? state.status) {
    case 'FAILED': return 0;
    case 'INTERMITTENT': return clamp01((state.availabilityPercent ?? 0) / 100);
    case 'DEGRADED': {
      // A scenario states how degraded it is. The BASELINE does not — it only says "degraded" and
      // carries a health score — and reading the absent percentage as zero made an asset that was
      // merely degraded behave as if it were dead, which silently moved the baseline itself. The
      // health score is the one figure the twin has for "how well is this working".
      if (state.performancePercent != null) return clamp01(state.performancePercent / 100);
      return state.healthScore == null ? null : clamp01(state.healthScore / 100);
    }
    // Being worked on: out of service for the duration, which is what maintenance means here.
    case 'UNDER_MAINTENANCE': return 0;
    case 'COMMUNICATION_LOST': return communicationDeliveryShare == null ? null : clamp01(communicationDeliveryShare);
    default: return 1;
  }
}

const clamp01 = value => Math.min(1, Math.max(0, Number(value) || 0));
const mean = values => (values.length ? values.reduce((total, value) => total + value, 0) / values.length : 1);

/**
 * A zone's capability, from the devices serving it.
 *
 * The rule, stated plainly because it is an assumption and not a measurement:
 *   • every device fully working  → 1
 *   • every device fully out      → the configured all-failed multiplier (0 by default)
 *   • exactly one of several fully out, the rest fully working → the configured single-failure
 *     multiplier (0.6 for reading by default, i.e. redundancy carries most of the load)
 *   • anything else → the mean effectiveness of the devices, which is linear and explainable
 */
export function zoneCapability(states, { single, allFailed }) {
  if (!states.length) return 1;
  if (states.some(value => value == null)) return null;
  const working = states.filter(value => value === 1).length;
  const out = states.filter(value => value === 0).length;
  if (working === states.length) return 1;
  if (out === states.length) return clamp01(allFailed);
  if (out === 1 && working === states.length - 1) return clamp01(single);
  return clamp01(mean(states));
}

/**
 * One zone's transactions.
 *
 * @param {object} zone synthetic zone
 * @param {number} crossings toll-eligible crossings in the scenario window
 * @param {{tolling: object}} baseline the synthetic assumptions
 * @param {Record<string, object>} conditions assetId -> effective state (baseline or scenario)
 */
export function zoneTransactions(zone, crossings, baseline, conditions = {}, environment = null) {
  const tolling = baseline.tolling;
  const share = { communicationDeliveryShare: tolling.communicationDeliveryShare };
  const readStates = zone.rfidAssetIds.map(id => deviceEffectiveness(conditions[id], share));
  const captureStates = zone.vesAssetIds.map(id => deviceEffectiveness(conditions[id], share));
  const coverage = zone.rfidCoverageModel;

  const missing = [];
  if (!coverage || coverage.type === COVERAGE_MODEL.UNKNOWN) missing.push('coverage rule for this zone');
  // Why a device could not be scored, from the device itself. Saying "disconnected" about one that
  // is merely degraded would send someone looking for the wrong missing assumption.
  const unscored = (ids, states, noun) => ids.forEach((id, index) => {
    if (states[index] != null) return;
    const status = conditions[id]?.simulatedStatus ?? conditions[id]?.status;
    missing.push(status === 'COMMUNICATION_LOST'
      ? `what a disconnected ${noun} still delivers`
      : `how well a degraded ${noun} still performs`);
  });
  unscored(zone.rfidAssetIds, readStates, 'antenna');
  unscored(zone.vesAssetIds, captureStates, 'camera');

  if (missing.length) {
    return Object.freeze({
      zoneId: zone.zoneId, status: ZONE_STATUS.NOT_ASSESSED, missing: Object.freeze(missing),
      crossings, rfidSuccess: 0, videoAttempts: 0, videoRecovered: 0, unrecovered: 0,
      readCapability: null, captureCapability: null,
    });
  }

  // Equipment first, environment second, and the environment applied ONCE here — never per device
  // and then again at the zone, which would count the same rain twice on its way to the money.
  const equipmentRead = zoneCapability(readStates, {
    single: coverage.singleFailureReadSuccessMultiplier, allFailed: coverage.allFailedReadSuccessMultiplier });
  const equipmentCapture = zoneCapability(captureStates, {
    single: coverage.singleFailureCaptureMultiplier, allFailed: coverage.allFailedCaptureMultiplier });
  const readCapability = clamp01(equipmentRead * clamp01(environment?.read ?? 1));
  const captureCapability = clamp01(equipmentCapture * clamp01(environment?.capture ?? 1));

  // Mutually exclusive from here down.
  const equipped = crossings * clamp01(tolling.rfidEquippedShare);
  const rfidSuccess = equipped * clamp01(tolling.rfidReadSuccessRate) * readCapability;
  // Everything not read by transponder goes to video: the misses, and every vehicle without one.
  const videoAttempts = crossings - rfidSuccess;
  const captured = videoAttempts * clamp01(tolling.videoCaptureSuccessRate) * captureCapability;
  const videoRecovered = captured * clamp01(tolling.videoCollectionRecoveryRate);
  const unrecovered = videoAttempts - videoRecovered;

  return Object.freeze({
    zoneId: zone.zoneId,
    status: ZONE_STATUS.CALCULATED,
    missing: Object.freeze([]),
    crossings,
    rfidSuccess,
    videoAttempts,
    videoCaptured: captured,
    videoRecovered,
    unrecovered,
    readCapability,
    captureCapability,
    equipmentReadCapability: equipmentRead,
    equipmentCaptureCapability: equipmentCapture,
    environment: environment ? Object.freeze({ read: environment.read ?? 1, capture: environment.capture ?? 1 }) : null,
  });
}

/** Every zone, plus the totals that reconcile against the crossings. */
export function runTransactions({ zones = [], demand, baseline, conditions = {}, environment = null } = {}) {
  const perZone = zones.map(zone =>
    zoneTransactions(zone, demand.byZone[zone.zoneId] ?? 0, baseline, conditions, environment));
  const assessed = perZone.filter(zone => zone.status === ZONE_STATUS.CALCULATED);
  const total = key => assessed.reduce((sum, zone) => sum + zone[key], 0);
  return Object.freeze({
    zones: Object.freeze(perZone),
    assessedZoneIds: Object.freeze(assessed.map(zone => zone.zoneId)),
    notAssessedZoneIds: Object.freeze(perZone.filter(zone => zone.status !== ZONE_STATUS.CALCULATED)
      .map(zone => zone.zoneId)),
    totals: Object.freeze({
      crossings: total('crossings'),
      rfidSuccess: total('rfidSuccess'),
      videoAttempts: total('videoAttempts'),
      videoRecovered: total('videoRecovered'),
      unrecovered: total('unrecovered'),
    }),
    /** Crossings in zones that could not be assessed — excluded from every total above. */
    excludedCrossings: perZone.filter(zone => zone.status !== ZONE_STATUS.CALCULATED)
      .reduce((sum, zone) => sum + zone.crossings, 0),
  });
}
