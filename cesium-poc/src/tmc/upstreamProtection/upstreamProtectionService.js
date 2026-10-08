/**
 * Upstream warning and queue protection: what an operator can actually establish about the
 * approach to an incident, and what they cannot.
 *
 * This is an OPERATIONAL ASSESSMENT, not a second risk score. It never feeds Secondary Incident
 * Risk, Operational Impact or the historical safety analysis, and it produces no probability of
 * anything. It answers five questions and refuses the ones the data cannot support:
 *
 *   1. Can the upstream approach be identified at all?
 *   2. Is traffic reported to be slowing upstream?
 *   3. How far does the queue reach?
 *   4. Is there a warning sign upstream, and was it warning about this?
 *   5. Is there a camera that could see the approach?
 *
 * WHAT THE CONNECTED DATA ACTUALLY CARRIES, measured across 98 loaded events before this was
 * written — not read off a config file:
 *
 *   CONGESTION events                                47 of 98   → traffic CAN be observed
 *   traffic_conditions, queue_length_mi,
 *   est_delay_min, recovery_eta                       0 of 98   → queue extent CANNOT be observed
 *   dms_message, nearby_dms_ids                       0 of 98   → activation CANNOT be confirmed
 *   responder_status, responding_units                0 of 98
 *   speed, occupancy, volume, travel time       not published
 *
 * So the three statuses below are genuinely different answers, and the whole point of this module
 * is to keep them apart: congestion upstream is an OBSERVATION, queue length is UNAVAILABLE, and
 * a DMS being nearby says nothing at all about whether it displayed a warning.
 *
 * Pure: incident and context in, assessment out. No Cesium, no DOM, no fetching.
 */
import { CARRIAGEWAYS } from '../../liveOps/carriagewayModel.js';
import { UPSTREAM_STATUS, upstreamSections } from '../upstreamResolver.js';
import { upstreamResources } from '../tmcResources.js';

/**
 * How well something is known.
 *
 * The distinction that matters most is NOT_OBSERVED versus UNKNOWN versus UNAVAILABLE:
 *   • NOT_OBSERVED — we could see, and there was nothing there
 *   • UNKNOWN      — we could not work out where to look
 *   • UNAVAILABLE  — the source does not publish this at all, for anyone, ever
 * Collapsing them is how a screen ends up reporting "no queue" when the truth is "no queue data".
 */
export const OBSERVATION = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  NOT_OBSERVED: 'NOT_OBSERVED',
  UNKNOWN: 'UNKNOWN',
  UNAVAILABLE: 'UNAVAILABLE',
  SIMULATED: 'SIMULATED',
});

export const OBSERVATION_LABELS = Object.freeze({
  CONFIRMED: 'Confirmed',
  NOT_OBSERVED: 'Not observed',
  UNKNOWN: 'Unknown',
  UNAVAILABLE: 'Unavailable',
  SIMULATED: 'Simulated',
});

/**
 * The fields that would answer the queue question, and the fact that none of them are published.
 *
 * Named individually rather than as "queue data" so an ACS conversation has something concrete to
 * point at: these are the fields to ask for.
 */
export const QUEUE_FIELDS_UNAVAILABLE = Object.freeze([
  Object.freeze({ field: 'queue_length_mi', label: 'Queue length' }),
  Object.freeze({ field: 'traffic_conditions', label: 'Traffic conditions' }),
  Object.freeze({ field: 'est_delay_min', label: 'Estimated delay' }),
  Object.freeze({ field: 'recovery_eta', label: 'Recovery ETA' }),
]);

/** The same, for the warning question. */
export const WARNING_FIELDS_UNAVAILABLE = Object.freeze([
  Object.freeze({ field: 'dms_message', label: 'DMS message content' }),
  Object.freeze({ field: 'dms_activated_at', label: 'DMS activation timestamp' }),
]);

const METRES_PER_MILE = 1609.344;
const milesOf = metres => Math.round((metres / METRES_PER_MILE) * 10) / 10;

/**
 * Whether traffic is reported to be slowing on the approach.
 *
 * Built from CONGESTION events that the existing upstream resolver places on the approach — a real
 * observation from the feed. It is deliberately NOT a speed and NOT a queue: the feed says a
 * congestion event was reported in an upstream section, and nothing more.
 */
function assessTraffic(upstream, upstreamCongestion) {
  if (upstream?.status !== UPSTREAM_STATUS.RESOLVED) {
    return Object.freeze({
      status: OBSERVATION.UNKNOWN,
      detail: `Upstream approach unresolved — ${String(upstream?.reason ?? 'direction unknown').toLowerCase()}`,
      events: Object.freeze([]),
      source: null,
    });
  }
  const events = upstreamCongestion ?? [];
  if (!events.length) {
    return Object.freeze({
      status: OBSERVATION.NOT_OBSERVED,
      detail: 'No congestion reported in the upstream sections at this time',
      events: Object.freeze([]),
      source: 'FL511 congestion events',
    });
  }
  return Object.freeze({
    status: OBSERVATION.CONFIRMED,
    detail: `${events.length} congestion event${events.length === 1 ? '' : 's'} reported upstream`,
    events: Object.freeze([...events]),
    source: 'FL511 congestion events',
  });
}

/**
 * How far the queue reaches — which nothing in the connected data can say.
 *
 * Returns UNAVAILABLE unconditionally, and names the fields that would change that. This is not a
 * placeholder waiting to be filled in with an estimate: estimating a queue from an incident's
 * severity would be inventing the observation the operator is asking for.
 */
function assessQueue() {
  return Object.freeze({
    status: OBSERVATION.UNAVAILABLE,
    detail: 'Queue extent is not published by the connected feed',
    extentMeters: null,
    observedAt: null,
    missingFields: QUEUE_FIELDS_UNAVAILABLE,
    source: null,
  });
}

/** One resource, described by what is actually known about its relationship to the incident. */
const describeResource = (entry, kind) => Object.freeze({
  id: entry.id,
  kind,
  longitude: entry.resource.longitude,
  latitude: entry.resource.latitude,
  upstreamMeters: entry.upstreamMeters,
  upstreamMiles: milesOf(entry.upstreamMeters),
  // Resolved by construction: upstreamResources only returns things it could place upstream on
  // the incident's own carriageway.
  upstream: true,
  carriagewayResolved: true,
  record: entry.resource.record ?? null,
});

/**
 * The warning resources on the approach, and the limits of what their presence proves.
 *
 * A DMS 0.8 miles upstream is a DMS 0.8 miles upstream. It is not evidence that a warning was
 * displayed, that it mentioned this incident, or that anyone driving into the queue saw it. The
 * feed publishes no message content and no activation time, so `activation` is UNKNOWN for every
 * sign — not NOT_OBSERVED, because nobody looked.
 */
function assessWarningResources(signs, cameras, incident, upstream, centerline) {
  const dms = upstreamResources(signs, incident, upstream, { centerline }).map(e => describeResource(e, 'sign'));
  const cams = upstreamResources(cameras, incident, upstream, { centerline }).map(e => describeResource(e, 'camera'));
  return {
    dms: Object.freeze(dms),
    cameras: Object.freeze(cams),
    nearestDms: dms[0] ?? null,
    nearestCamera: cams[0] ?? null,
    activation: Object.freeze({
      // Unknown, always: there is no activation record to read, for any sign, at any time.
      status: OBSERVATION.UNKNOWN,
      detail: dms.length
        ? 'A sign is upstream, but the feed publishes no message content or activation time — '
          + 'its presence does not confirm a warning was shown for this incident'
        : 'No upstream sign resolved, and the feed publishes no activation records in any case',
      missingFields: WARNING_FIELDS_UNAVAILABLE,
    }),
    /**
     * Whether a camera could have seen the approach.
     *
     * Position only. The corridor serves LIVE snapshots; there is no historical image archive, so
     * for a past incident no footage can be claimed to exist.
     */
    cameraCoverage: Object.freeze({
      status: cams.length ? OBSERVATION.CONFIRMED : OBSERVATION.NOT_OBSERVED,
      detail: cams.length
        ? `${cams.length} camera${cams.length === 1 ? '' : 's'} positioned upstream`
        : 'No camera resolved upstream of this incident',
      historicalFootage: Object.freeze({
        status: OBSERVATION.UNAVAILABLE,
        detail: 'Camera snapshots are live only — no historical image archive is connected, '
          + 'so no footage of this incident can be claimed',
      }),
    }),
  };
}

/** How much of the picture this assessment actually had. Its OWN axis — never applied to risk. */
function coverageOf(parts) {
  const known = parts.filter(status => status === OBSERVATION.CONFIRMED || status === OBSERVATION.NOT_OBSERVED).length;
  const share = parts.length ? known / parts.length : 0;
  const level = share >= 0.6 ? 'HIGH' : share >= 0.35 ? 'MEDIUM' : 'LOW';
  return Object.freeze({
    level,
    label: level === 'HIGH' ? 'High' : level === 'MEDIUM' ? 'Medium' : 'Low',
    known,
    total: parts.length,
    share: Math.round(share * 100) / 100,
  });
}

/**
 * What an operator should consider doing about the approach.
 *
 * Each item names its evidence, and an item prompted by MISSING information is marked as a gap so
 * it is never read as an action already available.
 */
function attentionFor({ upstream, traffic, queue, resources }) {
  const out = [];
  if (upstream.status !== UPSTREAM_STATUS.RESOLVED) {
    out.push({
      action: 'Establish the upstream approach',
      priority: 'HIGH', gap: true,
      reason: `The approach cannot be identified — ${String(upstream.reason ?? 'direction unresolved').toLowerCase()}. `
        + 'Nothing downstream of this can be assessed until it is.',
      evidence: 'Corridor travel order',
    });
  } else if (traffic.status === OBSERVATION.CONFIRMED) {
    out.push({
      action: 'Protect the back of the queue',
      priority: 'HIGH', gap: false,
      reason: `${traffic.detail}. Approaching traffic is arriving into something it cannot see.`,
      evidence: traffic.source,
    });
  } else {
    out.push({
      action: 'Watch the upstream approach',
      priority: 'MEDIUM', gap: false,
      reason: `${traffic.detail}. Congestion is reported as events, so a queue that has not been `
        + 'reported would not appear here.',
      evidence: traffic.source ?? 'FL511 congestion events',
    });
  }

  if (resources.nearestDms) {
    out.push({
      action: `Confirm warning status on ${resources.nearestDms.id}`,
      priority: 'HIGH', gap: true,
      reason: `A sign is ${resources.nearestDms.upstreamMiles} mi upstream, but no message content or `
        + 'activation time is published — whether it warned about this incident cannot be established here.',
      evidence: 'Message sign locations',
    });
  } else if (upstream.status === UPSTREAM_STATUS.RESOLVED) {
    out.push({
      action: 'No upstream warning sign in range',
      priority: 'MEDIUM', gap: true,
      reason: 'No message sign resolved upstream on this carriageway, so no sign-based warning can be '
        + 'placed in front of this queue from the connected data.',
      evidence: 'Message sign locations',
    });
  }

  if (resources.nearestCamera) {
    out.push({
      action: `Observe the approach on ${resources.nearestCamera.id}`,
      priority: 'MEDIUM', gap: false,
      reason: `A camera is ${resources.nearestCamera.upstreamMiles} mi upstream. Snapshots are live only, `
        + 'so this supports watching the approach now rather than reviewing what happened.',
      evidence: 'Camera locations',
    });
  }

  out.push({
    action: 'Queue extent is not measurable here',
    priority: 'LOW', gap: true,
    reason: `${queue.detail}. The fields that would answer it are `
      + `${queue.missingFields.map(entry => entry.label).join(', ')}.`,
    evidence: 'Connected feed schema',
  });

  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return Object.freeze(out
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => order[a.priority] - order[b.priority] || a.index - b.index)
    .map(({ index, ...rest }) => Object.freeze(rest)));
}

/**
 * Assess the upstream approach to one incident.
 *
 * @param {object} incident                normalised, with carriageway and sectionIndex
 * @param {{sections, centerline, cameras, signs, upstream, upstreamCongestion, anchorMs}} context
 * @returns {object} the assessment — never a score, never a probability
 */
export function assessUpstreamProtection(incident, {
  sections = [], centerline = [], cameras = [], signs = [],
  upstream = null, upstreamCongestion = [], anchorMs = null,
} = {}) {
  if (!incident) return null;
  // Reuses the corridor's own direction logic rather than re-deriving it: one definition of
  // "upstream" for the risk engine, the resources and this.
  const approach = upstream ?? upstreamSections(incident, sections);
  const traffic = assessTraffic(approach, upstreamCongestion);
  const queue = assessQueue();
  const resources = assessWarningResources(signs, cameras, incident, approach, centerline);

  return Object.freeze({
    incidentId: incident.id,
    incidentTimestamp: anchorMs,
    carriageway: incident.carriageway ?? CARRIAGEWAYS.UNKNOWN,
    upstreamResolution: Object.freeze({
      status: approach.status,
      resolved: approach.status === UPSTREAM_STATUS.RESOLVED,
      reason: approach.reason,
    }),
    upstreamSections: Object.freeze([...(approach.sections ?? [])]),
    trafficObservationStatus: traffic.status,
    traffic,
    queueObservationStatus: queue.status,
    queue,
    cameraResources: resources.cameras,
    dmsResources: resources.dms,
    nearestDms: resources.nearestDms,
    nearestCamera: resources.nearestCamera,
    warningActivationStatus: resources.activation.status,
    warningActivation: resources.activation,
    cameraCoverage: resources.cameraCoverage,
    /** Patrol protection is the patrol module's answer; this only records whether it applies. */
    patrolProtectionApplies: approach.status === UPSTREAM_STATUS.RESOLVED,
    dataConfidence: coverageOf([
      traffic.status, queue.status, resources.activation.status, resources.cameraCoverage.status,
    ]),
    recommendedAttention: attentionFor({ upstream: approach, traffic, queue, resources }),
    sourceProvenance: Object.freeze({
      upstream: 'Corridor travel order (FDOT section geometry)',
      traffic: 'FL511 congestion events',
      queue: 'Not published by the connected feed',
      dms: 'Message sign locations — no message content or activation records published',
      camera: 'Camera locations — live snapshots only, no historical archive',
    }),
  });
}
