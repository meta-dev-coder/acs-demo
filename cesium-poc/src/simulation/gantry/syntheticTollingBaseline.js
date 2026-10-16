/**
 * The synthetic tolling assumptions every financial figure in this twin rests on.
 *
 * There is no toll transaction history for this gantry, no published demand, and no approved rate.
 * So the money side of a what-if is built on a configuration an operator can read, argue with and
 * change — never on numbers buried in a calculation. Every value here is illustrative.
 *
 * Three rules it keeps:
 *
 *   1. `dataOrigin: SYNTHETIC` travels with the figures all the way to the screen. Nothing derived
 *      from this file may be presented as I-595 revenue.
 *   2. Demand is toll-ELIGIBLE crossings at the modelled point, not "traffic on I-595". The twin
 *      has no basis for the second, and conflating them would inflate every result.
 *   3. An assumption that is missing is missing. A null is never read as a zero — the zone it
 *      belongs to is reported as not assessed instead.
 */

/** What the figures are, wherever they appear. */
export const DATA_ORIGIN = 'SYNTHETIC';

/** Where the video-processing charge falls. Stated, because the two give different answers. */
export const VIDEO_CHARGE = Object.freeze({
  /** Every image handled costs, whether or not a toll is eventually collected. */
  PER_ATTEMPT: 'PER_ATTEMPT',
  /** Only a transaction that is successfully billed costs. */
  PER_RECOVERED: 'PER_RECOVERED',
});

/**
 * The demo defaults. Illustrative values, not I-595 measurements or approved toll rates.
 */
export const DEMO_BASELINE = Object.freeze({
  baselineId: 'I595_G01_DEMO_V1',
  dataOrigin: DATA_ORIGIN,
  gantryId: 'I595_G01',
  traffic: Object.freeze({
    /** Vehicles ELIGIBLE to be tolled at this point, per hour. Not a traffic count for I-595. */
    vehiclesPerHour: 1200,
    vehicleMix: Object.freeze({ passengerCar: 0.9, lightCommercial: 0.08, other: 0.02 }),
  }),
  tolling: Object.freeze({
    averageTollUSD: 2.5,
    /** Share of eligible vehicles carrying a transponder. */
    rfidEquippedShare: 0.85,
    /** How often a working antenna reads a transponder that is present. */
    rfidReadSuccessRate: 0.98,
    /** How often a working camera captures a usable plate image. */
    videoCaptureSuccessRate: 0.9,
    /** How often a captured image becomes a collected toll. */
    videoCollectionRecoveryRate: 0.85,
    rfidProcessingCostUSD: 0.03,
    videoProcessingCostUSD: 0.45,
    videoProcessingCharge: VIDEO_CHARGE.PER_ATTEMPT,
    /**
     * What reaches the back office from an antenna that is powered but disconnected.
     *
     * Null on purpose: nobody has told this twin whether a disconnected reader buffers and
     * forwards, or loses the read. A zone whose antenna is in that state is reported as NOT
     * ASSESSED rather than guessed at. Set it (0..1) to make such a scenario calculable.
     */
    communicationDeliveryShare: null,
  }),
});

const number = value => (Number.isFinite(Number(value)) ? Number(value) : null);
const inRange = (value, min, max) => number(value) !== null && Number(value) >= min && Number(value) <= max;

export const ASSUMPTION_ERRORS = Object.freeze({
  BAD_RATE: 'BAD_RATE', BAD_MONEY: 'BAD_MONEY', BAD_DEMAND: 'BAD_DEMAND', BAD_CHARGE: 'BAD_CHARGE',
});

/** Every assumption, with the bounds it must stay inside and the words the UI uses for it. */
export const ASSUMPTION_FIELDS = Object.freeze([
  Object.freeze({ path: 'traffic.vehiclesPerHour', label: 'Toll-eligible vehicles per hour',
    kind: 'count', min: 0, max: 20000, step: 50 }),
  Object.freeze({ path: 'tolling.averageTollUSD', label: 'Average toll', kind: 'money', min: 0, max: 100, step: 0.25 }),
  Object.freeze({ path: 'tolling.rfidEquippedShare', label: 'Transponder-equipped share', kind: 'share', min: 0, max: 1, step: 0.01 }),
  Object.freeze({ path: 'tolling.rfidReadSuccessRate', label: 'Transponder read success', kind: 'share', min: 0, max: 1, step: 0.01 }),
  Object.freeze({ path: 'tolling.videoCaptureSuccessRate', label: 'Image capture success', kind: 'share', min: 0, max: 1, step: 0.01 }),
  Object.freeze({ path: 'tolling.videoCollectionRecoveryRate', label: 'Video toll recovery', kind: 'share', min: 0, max: 1, step: 0.01 }),
  Object.freeze({ path: 'tolling.rfidProcessingCostUSD', label: 'Transponder processing cost', kind: 'money', min: 0, max: 10, step: 0.01 }),
  Object.freeze({ path: 'tolling.videoProcessingCostUSD', label: 'Video processing cost', kind: 'money', min: 0, max: 50, step: 0.05 }),
]);

export const readPath = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);

/** A copy of the baseline with one assumption changed. Frozen, like everything else here. */
export function withAssumption(baseline, path, value) {
  const [group, key] = path.split('.');
  return Object.freeze({
    ...baseline,
    [group]: Object.freeze({ ...baseline[group], [key]: value }),
  });
}

/**
 * Whether a set of assumptions can be calculated with at all.
 *
 * @returns {{valid: boolean, errors: {code: string, path: string, message: string}[]}}
 */
export function validateBaseline(baseline = DEMO_BASELINE) {
  const errors = [];
  for (const field of ASSUMPTION_FIELDS) {
    const value = readPath(baseline, field.path);
    if (inRange(value, field.min, field.max)) continue;
    errors.push({
      code: field.kind === 'share' ? ASSUMPTION_ERRORS.BAD_RATE
        : field.kind === 'money' ? ASSUMPTION_ERRORS.BAD_MONEY : ASSUMPTION_ERRORS.BAD_DEMAND,
      path: field.path,
      message: `${field.label} must be between ${field.min} and ${field.max}.`,
    });
  }
  const charge = baseline?.tolling?.videoProcessingCharge;
  if (charge && !Object.values(VIDEO_CHARGE).includes(charge)) {
    errors.push({ code: ASSUMPTION_ERRORS.BAD_CHARGE, path: 'tolling.videoProcessingCharge',
      message: 'The video processing charge must be per attempt or per recovered transaction.' });
  }
  const delivery = baseline?.tolling?.communicationDeliveryShare;
  if (delivery != null && !inRange(delivery, 0, 1)) {
    errors.push({ code: ASSUMPTION_ERRORS.BAD_RATE, path: 'tolling.communicationDeliveryShare',
      message: 'The communication delivery share must be between 0 and 1, or left unset.' });
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}
