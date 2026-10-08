/**
 * What to look at first, and what we actually know about the response so far.
 *
 * Two jobs, both presentational and both deterministic.
 *
 * RANKING. The mitigation engine already decides WHAT to suggest; this decides what order an
 * operator should read it in, from the evidence each line cites. Nothing is invented: a suggestion
 * resting on a stated lane closure outranks one resting on a recurring historical pattern, because
 * the first is about the road now and the second is about the place in general.
 *
 * SEPARATING THE GAP FROM THE ACTION. "Upstream cannot be assessed" is not something an operator
 * can do. It is a reason to do something — establish the upstream picture — and a data gap. Listing
 * it as a mitigation step made the list read as though the system had suggested doing nothing. Each
 * entry therefore carries an ACTION, a REASON, and optionally the GAP behind it.
 *
 * TIMELINE. Populated only from stages the data actually evidences. Every other stage of the
 * operational motion is listed as unavailable rather than quietly dropped, so the shape of what is
 * NOT instrumented is visible — which is itself the point of the exercise.
 *
 * Pure: an assessment in, a plan out.
 */
import { UPSTREAM_STATUS } from './upstreamResolver.js';

/** How urgently a recommendation should be read. Not a risk score. */
export const ATTENTION_PRIORITY = Object.freeze({ HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' });

/**
 * What each kind of evidence earns, and how it reads as an instruction.
 *
 * Demo configuration like the risk weights: ordered by how directly the evidence bears on the road
 * right now, and open to argument in one place.
 */
const BY_BASIS = Object.freeze({
  LANE_CLOSURE: { priority: 'HIGH', action: 'Verify lane-closure status' },
  UPSTREAM_CONGESTION: { priority: 'HIGH', action: 'Verify upstream queue and warning coverage' },
  WEATHER: { priority: 'HIGH', action: 'Review conditions on the approach' },
  MONITORING: { priority: 'MEDIUM', action: 'Check the upstream approach' },
  OPERATIONAL_IMPACT: { priority: 'MEDIUM', action: 'Monitor the affected section' },
  INCIDENT_DURATION: { priority: 'MEDIUM', action: 'Re-establish upstream conditions' },
  HISTORICAL_LOCATION: { priority: 'MEDIUM', action: 'Review historical context for this location' },
  UPSTREAM_UNRESOLVED: { priority: 'HIGH', action: 'Establish upstream conditions', gap: true },
  UNAVAILABLE: { priority: 'LOW', action: 'Verify response status', gap: true },
});

const ORDER = Object.freeze({ HIGH: 0, MEDIUM: 1, LOW: 2 });

/**
 * The mitigation list, as ranked recommendations.
 *
 * A stable sort within each priority, so the order the mitigation engine chose is preserved among
 * equals rather than shuffled by the ranking.
 */
export function recommendedAttention(mitigation, { upstream = null } = {}) {
  const entries = (mitigation ?? []).map((item, index) => {
    const rule = BY_BASIS[item.basis] ?? { priority: 'LOW', action: 'Review' };
    // A line that only reports an absence is a gap with an action attached, never an action alone.
    const isGap = Boolean(rule.gap);
    return {
      id: item.id,
      action: rule.action,
      priority: rule.priority,
      reason: item.text,
      basis: item.basis,
      /** The missing information behind this recommendation, where that is what prompted it. */
      gap: isGap ? item.text : null,
      index,
    };
  });
  // An unresolved upstream raises everything that depends on seeing upstream.
  if (upstream && upstream.status !== UPSTREAM_STATUS.RESOLVED) {
    for (const entry of entries) {
      if (entry.basis === 'INCIDENT_DURATION') entry.priority = 'HIGH';
    }
  }
  return Object.freeze(entries
    .sort((a, b) => ORDER[a.priority] - ORDER[b.priority] || a.index - b.index)
    .map(({ index, ...rest }) => Object.freeze(rest)));
}

/**
 * The operational motion — detect, assess, warn, respond, protect, clear — with only the stages the
 * connected data can evidence.
 *
 * Shaped so that a future feed carrying dispatch, arrival or DMS activation times fills in the
 * blanks rather than needing a new component. Nothing is inferred: a stage with no source is
 * `unavailable`, which is visibly different from a stage that is known not to have happened.
 */
export function responseTimeline({ incident, risk, resources, upstream, analysedAtMs = null } = {}) {
  const reportedAt = incident?.reportedAtMs ?? null;
  const stages = [];
  const stage = (id, label, state, at, detail) => stages.push({ id, label, state, atMs: at ?? null, detail });

  stage('detected', 'Incident recorded', reportedAt == null ? 'unavailable' : 'known', reportedAt,
    reportedAt == null ? 'Start time not published' : null);

  stage('assessed', 'Assessed by the twin', analysedAtMs == null ? 'unavailable' : 'known', analysedAtMs,
    incident?.activeMinutes == null ? null : `Active ${incident.activeMinutes} min at this point`);

  // Warning: the feed publishes no sign message, so this can never be confirmed from here.
  stage('warned', 'Upstream warning', 'unavailable', null,
    resources?.sign
      ? `Nearest upstream sign ${resources.sign.id} resolved — message content is not published with the feed`
      : 'No upstream sign resolved, and message content is not published with the feed');

  stage('responded', 'Responder status', 'unavailable', null, 'Not available from the connected data');

  stage('protected', 'Lane protection', incident?.lanes?.stated ? 'known' : 'unavailable',
    null,
    incident?.lanes?.stated
      ? `${risk?.factors?.find(f => f.type === 'LANE_CLOSURE')?.detail ?? 'Lane closure recorded'} — timing not published`
      : 'Lane impact not stated by the source');

  const clearedAt = incident?.clearedAtMs ?? null;
  stage('cleared', 'Cleared', clearedAt == null ? 'unavailable' : 'known', clearedAt,
    clearedAt == null ? 'Clear time not published' : null);

  return Object.freeze({
    stages: Object.freeze(stages.map(Object.freeze)),
    knownStages: stages.filter(entry => entry.state === 'known').length,
    totalStages: stages.length,
    /** True when upstream could not be resolved, which is why the warning stage is blind. */
    upstreamUnresolved: upstream ? upstream.status !== UPSTREAM_STATUS.RESOLVED : null,
  });
}
