/**
 * What one failure means for the one piece of equipment it is applied to.
 *
 * Strictly capability, strictly about that device: "this antenna cannot read transponders" is
 * something the scenario itself establishes. What that does to a tolling zone, to revenue or to
 * traffic is NOT decided here — those depend on coverage, redundancy and systems the twin has no
 * data for, and are answered (or declined) by `equipmentDependencies` and `scenarioEngine`.
 *
 * Each statement is tied to what the equipment does, so a CCTV camera failing never implies that
 * tolls stopped being collected.
 */
import { FAILURE_MODES } from './scenarioState.js';

/** How certain a statement is — the thing that keeps a scenario readable as evidence. */
export const CERTAINTY = Object.freeze({
  /** Follows from the scenario itself: the equipment was told to fail. */
  CONFIRMED: 'CONFIRMED',
  /** Follows only if something unverified holds. */
  ASSUMED: 'ASSUMED',
  /** Cannot be determined from what is known. */
  UNKNOWN: 'UNKNOWN',
});

/** What each kind of device stops being able to do. One sentence, about that device only. */
const CAPABILITY = Object.freeze({
  RFID_ANTENNA: Object.freeze({
    capability: 'Transponder detection',
    lost: 'RFID transponder detection capability is unavailable for the selected antenna. '
      + 'Tolling-zone impact depends on other operational antennas and configured coverage.',
    reduced: 'RFID transponder detection is reduced for the selected antenna. '
      + 'Tolling-zone impact depends on other operational antennas and configured coverage.',
    disconnected: 'The antenna may still read transponders, but its reads are not reaching the '
      + 'monitoring or transaction system. Whether a read is lost depends on systems outside this twin.',
  }),
  VES_CAMERA: Object.freeze({
    capability: 'Video enforcement capture',
    lost: 'Video enforcement capture is unavailable for the selected camera. '
      + 'Recovery capability depends on other available cameras and transaction processing.',
    reduced: 'Video enforcement capture is reduced for the selected camera. '
      + 'Recovery capability depends on other available cameras and transaction processing.',
    disconnected: 'The camera may still capture images, but they are not reaching the transaction '
      + 'system. Whether an image is lost depends on systems outside this twin.',
  }),
  TOLL_CAMERA: Object.freeze({
    capability: 'Transaction image capture',
    lost: 'Image capture at the point of the toll transaction is unavailable for the selected camera.',
    reduced: 'Image capture at the point of the toll transaction is reduced for the selected camera.',
    disconnected: 'The camera may still capture images, but they are not reaching the transaction system.',
  }),
  CCTV_CAMERA: Object.freeze({
    capability: 'Surveillance coverage',
    // Said explicitly, because this is the inference people make: it is not a tolling outage.
    lost: 'Surveillance visibility is reduced for the camera\'s monitored area. '
      + 'Toll collection is not automatically considered unavailable.',
    reduced: 'Surveillance image quality is reduced for the camera\'s monitored area. '
      + 'Toll collection is not automatically considered unavailable.',
    disconnected: 'The camera may still see its area, but the view is not reaching the monitoring system. '
      + 'Toll collection is not automatically considered unavailable.',
  }),
  DIGITAL_SIGN: Object.freeze({
    capability: 'Traveller information display',
    lost: 'Traveler information display capability is unavailable for the selected sign.',
    reduced: 'Traveler information display capability is reduced for the selected sign.',
    disconnected: 'The sign may still display its last message, but it is no longer being updated.',
  }),
  UNCLASSIFIED: Object.freeze({
    capability: 'Unknown',
    // The model does not say what this equipment is, so nothing can be said about losing it.
    lost: 'This equipment is not identified in the 3D model, so the capability lost cannot be stated.',
    reduced: 'This equipment is not identified in the 3D model, so the effect of reduced performance cannot be stated.',
    disconnected: 'This equipment is not identified in the 3D model, so the effect of losing its link cannot be stated.',
  }),
});

/**
 * The same conclusion in an operator's words, for the top of the results.
 *
 * One sentence about the equipment, one about what it means operationally — and never a sentence
 * about revenue or a lane. The longer, more careful wording above stays available under the
 * panel's technical details; this is what is read first.
 */
const PLAIN = Object.freeze({
  RFID_ANTENNA: 'Transponder reading is unavailable or reduced for this antenna. '
    + 'Other antennas may provide coverage.',
  VES_CAMERA: 'Vehicle image capture is unavailable or reduced for this camera. '
    + 'Video toll recovery may be affected.',
  TOLL_CAMERA: 'Transaction image capture is unavailable or reduced for this camera.',
  CCTV_CAMERA: 'Operator surveillance is reduced. Toll collection is not automatically affected.',
  DIGITAL_SIGN: 'This sign cannot show traveller information.',
  UNCLASSIFIED: 'This equipment is not identified in the 3D model, so its operational effect cannot be stated.',
});

const PHRASE_BY_MODE = Object.freeze({
  COMPLETE_FAILURE: 'lost',
  POWER_FAILURE: 'lost',
  INTERMITTENT_FAILURE: 'reduced',
  DEGRADED_PERFORMANCE: 'reduced',
  COMMUNICATION_FAILURE: 'disconnected',
});

/** Simulated states in which the device cannot do its job at all. */
export const UNAVAILABLE_STATES = Object.freeze(['FAILED']);
/** States in which it still does some of it. */
export const IMPAIRED_STATES = Object.freeze(['INTERMITTENT', 'DEGRADED', 'COMMUNICATION_LOST']);

/**
 * How bad a state is, so a baseline and a failure mode can be compared at all.
 *
 * Three things were being run together before, and the result read as nonsense: a camera whose
 * baseline was DEGRADED, given an intermittent fault, reported "DEGRADED → INTERMITTENT", which
 * looks like a change of kind and might even read as an improvement. They are separate facts:
 *
 *   baseline status      what the twin says the asset's condition is
 *   failure mode         what the scenario does to it
 *   effective status     where that leaves it — never better than the baseline
 *
 * An asset already FAILED stays FAILED under any mode, and the scenario is reported as adding no
 * further outage. That distinction is not cosmetic: a revenue model that counted it as a new
 * failure would bill the same outage twice.
 */
export const STATUS_SEVERITY = Object.freeze({
  OPERATIONAL: 0,
  NOT_CONNECTED: 0,
  COMMUNICATION_LOST: 1,
  INTERMITTENT: 1,
  DEGRADED: 1,
  UNDER_MAINTENANCE: 1,
  FAILED: 2,
});

const severityOf = status => STATUS_SEVERITY[String(status ?? '').toUpperCase()] ?? 0;

/** Whether the scenario makes this asset worse than it already was. */
export const CHANGE = Object.freeze({ WORSE: 'WORSE', NO_CHANGE: 'NO_CHANGE' });

/**
 * The state an asset is actually left in: the worse of what it was and what the scenario does.
 *
 * Where both are impaired but differently named — a degraded camera given an intermittent fault —
 * the BASELINE's name is kept and the scenario's mode is reported alongside it, because the mode is
 * not a status and printing it as one is what made the result unreadable.
 */
export function effectiveStatusFor(baselineStatus, modeStatus) {
  const baseline = severityOf(baselineStatus);
  const mode = severityOf(modeStatus);
  if (mode > baseline) return { status: modeStatus, change: CHANGE.WORSE };
  if (mode < baseline) return { status: baselineStatus, change: CHANGE.NO_CHANGE };
  // Equal severity: already in this band, so the scenario adds nothing the baseline did not have.
  return { status: baselineStatus === 'NOT_CONNECTED' ? modeStatus : baselineStatus, change: baseline === 0 ? CHANGE.WORSE : CHANGE.NO_CHANGE };
}

/**
 * One asset's effective state under one failure.
 *
 * The baseline rides along untouched: a panel can show both, and nothing downstream has to go back
 * to the inventory to find out what the asset's real condition was.
 *
 * @param {object} asset the inventory record (with its synthetic baseline)
 * @param {object} failure
 */
export function effectiveState(asset, failure) {
  const mode = FAILURE_MODES[failure?.failureMode];
  const words = CAPABILITY[asset?.type] ?? CAPABILITY.UNCLASSIFIED;
  const phrase = PHRASE_BY_MODE[mode?.id] ?? 'lost';
  const parameter = mode?.parameter;
  const baselineStatus = asset.operationalStatus ?? 'NOT_CONNECTED';
  const modeStatus = mode?.simulatedStatus ?? 'FAILED';
  const effective = effectiveStatusFor(baselineStatus, modeStatus);
  const parameterValue = parameter ? failure?.[parameter.key] ?? parameter.default : null;
  const modeLabel = parameter ? `${mode.label} · ${parameterValue}${parameter.unit}` : mode?.label ?? modeStatus;
  return Object.freeze({
    assetId: asset.assetId,
    name: asset.name ?? asset.assetId,
    type: asset.type,
    laneGroup: asset.laneGroup ?? null,
    side: asset.side ?? null,
    baselineStatus,
    baselineHealth: asset.health ?? null,
    /** Where the asset is left: never better than it already was. */
    simulatedStatus: effective.status,
    /** What the mode alone would mean — kept apart from the status so neither reads as the other. */
    modeStatus,
    modeLabel,
    change: effective.change,
    failureMode: mode?.id ?? failure?.failureMode ?? null,
    ...(parameter ? { [parameter.key]: parameterValue } : {}),
    capability: words.capability,
    /** The scenario put this device in this state, so the device-level effect is certain. */
    impact: Object.freeze({
      /** The short answer, for the top of a result. */
      plain: effective.change === CHANGE.NO_CHANGE
        ? `This equipment was already ${baselineStatus.toLowerCase().replace(/_/g, ' ')} before the scenario, `
          + 'so this failure adds nothing further.'
        : PLAIN[asset?.type] ?? PLAIN.UNCLASSIFIED,
      /** The careful one, for the technical detail. */
      statement: effective.change === CHANGE.NO_CHANGE
        ? `${words[phrase]} This asset was already ${baselineStatus.toLowerCase().replace(/_/g, ' ')} `
          + 'in the baseline, so the scenario adds no further loss of capability.'
        : words[phrase],
      certainty: CERTAINTY.CONFIRMED,
    }),
    origin: 'DIRECT',
  });
}

/** An asset reached through a verified dependency rather than named in the scenario. */
export function indirectState(asset, { via, kind }) {
  const words = CAPABILITY[asset?.type] ?? CAPABILITY.UNCLASSIFIED;
  return Object.freeze({
    assetId: asset.assetId,
    name: asset.name ?? asset.assetId,
    type: asset.type,
    laneGroup: asset.laneGroup ?? null,
    side: asset.side ?? null,
    baselineStatus: asset.operationalStatus ?? 'NOT_CONNECTED',
    baselineHealth: asset.health ?? null,
    simulatedStatus: effectiveStatusFor(asset.operationalStatus ?? 'NOT_CONNECTED', 'FAILED').status,
    modeStatus: 'FAILED',
    modeLabel: kind === 'POWER' ? 'Power failure (dependency)' : 'Communication failure (dependency)',
    change: effectiveStatusFor(asset.operationalStatus ?? 'NOT_CONNECTED', 'FAILED').change,
    failureMode: kind === 'POWER' ? 'POWER_FAILURE' : 'COMMUNICATION_FAILURE',
    capability: words.capability,
    impact: Object.freeze({
      plain: `${PLAIN[asset?.type] ?? PLAIN.UNCLASSIFIED} It is affected through a verified `
        + `${kind.toLowerCase()} dependency on another asset.`,
      statement: `${words.lost} Reached through a verified ${kind.toLowerCase()} dependency on ${via}.`,
      certainty: CERTAINTY.CONFIRMED,
    }),
    origin: 'INDIRECT',
    via,
  });
}

/** Whether a simulated state means the device is out, impaired, or neither. */
export const isUnavailable = state => UNAVAILABLE_STATES.includes(state?.simulatedStatus);
export const isImpaired = state => IMPAIRED_STATES.includes(state?.simulatedStatus);
