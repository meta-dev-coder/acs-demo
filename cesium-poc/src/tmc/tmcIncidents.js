/**
 * The TMC's view of one live event: an incident, with what the corridor already knows about it.
 *
 * The feed carries five event types and the TMC answers a question about one of them — "how are we
 * responding to incidents, and can we reduce the risk of a secondary incident". So incidents are
 * what this screen is about; closures, congestion and the rest are context around them, never the
 * primary object.
 *
 * Nothing is derived that the feed does not state. Where a field has no source — a responder's
 * status, a queue length — it is absent here too, and the risk engine reports it as unavailable
 * rather than scoring a guess.
 *
 * Pure: events in, normalised incidents out. No DOM, no Cesium, no fetching.
 */
import { CARRIAGEWAYS } from '../liveOps/carriagewayModel.js';

/** The event type the TMC treats as its primary object. */
export const TMC_PRIMARY_TYPE = 'INCIDENT';

const known = value => value != null && String(value).trim() !== '' && !/^na$/i.test(String(value).trim());
const placed = event => Number.isFinite(event?.longitude) && Number.isFinite(event?.latitude);

/**
 * When an incident was first reported, as a timestamp.
 *
 * `sdna.reported_at` is an ISO instant and present on every record measured; `startTime` is a
 * display string ("Sep 29 2026, 4:25 PM") and is the fallback. Returns null rather than "now" when
 * neither parses — an unknown start is not a zero-minute incident.
 */
export function reportedAtMs(event) {
  for (const value of [event?.sdna?.reported_at, event?.startTime, event?.lastUpdated]) {
    if (!known(value)) continue;
    const at = Date.parse(String(value));
    if (Number.isFinite(at)) return at;
  }
  return null;
}

/** How long an incident has been running, in minutes, or null when its start is unknown. */
export function activeMinutes(event, now = Date.now()) {
  const from = reportedAtMs(event);
  if (from == null) return null;
  return Math.max(0, Math.round((now - from) / 60_000));
}

/**
 * What the feed says this incident is blocking.
 *
 * `liveOps.laneImpact` is parsed from FL511's prose by the server, and says so: `source` is
 * 'parsed' or 'none'. A `none` is "the source did not say", NOT "nothing is blocked", and the two
 * must not be confused by anything scoring risk.
 *
 * The incident register is a third source ('register'). It answers whether lanes were closed and
 * never how many, so it sets `closureStated` and leaves `blockedLanes` null — a stated closure of
 * unknown size, which is neither "two lanes blocked" nor "nothing stated".
 */
const STATED_SOURCES = new Set(['parsed', 'register']);

export function laneImpactOf(event) {
  const impact = event?.liveOps?.laneImpact;
  if (!impact || !STATED_SOURCES.has(impact.source)) {
    return { stated: false, closureStated: false, blockedLanes: null, fullClosure: false, rampClosure: false, shoulderOnly: false };
  }
  return {
    stated: true,
    closureStated: Boolean(impact.closureStated),
    blockedLanes: Number.isFinite(impact.blockedLanes) ? impact.blockedLanes : null,
    fullClosure: Boolean(impact.fullClosure),
    rampClosure: Boolean(impact.rampClosure),
    shoulderOnly: Boolean(impact.shoulderOnly),
  };
}

/** Whether this incident blocks running lanes — a ramp or a shoulder is not the carriageway. */
export const blocksTravelLanes = impact =>
  Boolean(impact?.stated) && (impact.fullClosure || (impact.blockedLanes ?? 0) > 0 || Boolean(impact.closureStated));

/**
 * How much the corridor's own classifier trusts where it put this event.
 *
 * It lives at `liveOps.spatialMatch.confidence`, not on `liveOps` itself. Operational Impact
 * already refuses to score a LOW match; the TMC surfaces the same value rather than hiding it,
 * because an operator deciding about a lane closure should see how sure the placement is.
 */
export const placementConfidence = event => event?.liveOps?.spatialMatch?.confidence ?? null;

/**
 * One incident, in the shape the TMC's own services read.
 *
 * `event` is kept whole so the panel, the map and Ask the Twin all read one object rather than a
 * copy that can drift from the feed.
 */
export function normaliseIncident(event, now = Date.now()) {
  const liveOps = event?.liveOps ?? {};
  const lanes = laneImpactOf(event);
  return Object.freeze({
    id: event.id,
    event,
    title: event.title ?? 'Incident',
    severity: known(event.severity) ? String(event.severity).trim() : null,
    longitude: event.longitude,
    latitude: event.latitude,
    carriageway: liveOps.carriageway ?? CARRIAGEWAYS.UNKNOWN,
    direction: liveOps.direction ?? null,
    sectionId: liveOps.sectionId ?? null,
    sectionIndex: Number.isFinite(liveOps.sectionIndex) ? liveOps.sectionIndex : null,
    sectionLabel: liveOps.sectionLabel ?? null,
    segmentId: liveOps.segmentId ?? null,
    confidence: placementConfidence(event),
    lanes,
    blocksTravelLanes: blocksTravelLanes(lanes),
    reportedAtMs: reportedAtMs(event),
    activeMinutes: activeMinutes(event, now),
  });
}

/**
 * The active incidents on the corridor, newest first.
 *
 * Active means the feed has not cleared it. A cleared incident is history and belongs to Safety's
 * crash picture, not to a screen asking what is happening now. An incident with no coordinates is
 * dropped: every TMC answer is about a place on the road.
 */
export function activeIncidents(events, now = Date.now()) {
  return incidentsIn((events ?? []).filter(event => !event?.cleared), now);
}

/**
 * The incidents in an already-scoped set of events.
 *
 * Deliberately does NOT re-check `cleared`: in a historical replay every record has since cleared,
 * and reading that flag would empty the screen. What counts as current is the temporal context's
 * decision (see temporalContext.eventsFor), made once, before this.
 */
export function incidentsIn(events, now = Date.now(), { clockFor = null } = {}) {
  return (events ?? [])
    .filter(event => event?.type === TMC_PRIMARY_TYPE && placed(event))
    // `clockFor` lets a caller measure each incident against its OWN end rather than one shared
    // instant. Without it, a crash from December 2025 reads as "active 418,584 minutes" — true of
    // the wall clock, and nonsense about the incident.
    .map(event => normaliseIncident(event, clockFor?.(event) ?? now))
    .sort((a, b) => (b.reportedAtMs ?? 0) - (a.reportedAtMs ?? 0));
}

/** Live events of one type that are still running — the context an incident is judged against. */
export const activeOfType = (events, type) =>
  (events ?? []).filter(event => event?.type === type && !event.cleared && placed(event));

/** Events of one type within an already-scoped set, for the same reason as `incidentsIn`. */
export const ofType = (events, type) =>
  (events ?? []).filter(event => event?.type === type && placed(event));
