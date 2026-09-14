/**
 * Presentation model for FL511 live road events.
 *
 * The one rule this module enforces: rows come from values the backend actually received, and a
 * field FL511 did not publish produces no row at all — never a placeholder, a guess or a default.
 * Source rows (what FL511 said) and association rows (what our corridor geometry computed) are
 * built separately so the details panel can label them separately.
 */

/** @typedef {'INCIDENT'|'CLOSURE'} LiveRoadEventType */

export const LIVE_EVENT_TYPES = Object.freeze({ INCIDENT: 'INCIDENT', CLOSURE: 'CLOSURE' });
export const LIVE_EVENT_LABELS = Object.freeze({ INCIDENT: 'Incident', CLOSURE: 'Closure' });

const present = value => value != null && String(value).trim() !== '';
const rows = entries => entries.filter(([, value]) => present(value)).map(([label, value]) => [label, String(value)]);

/** FL511's own heading when it published one, otherwise the feed the event came from. */
export const liveEventLabel = event => present(event?.title) ? String(event.title) : LIVE_EVENT_LABELS[event?.type] ?? 'Live Event';

export const formatMeters = value => Number.isFinite(value)
  ? value < 1000 ? `${Math.round(value)} m` : `${(value / 1000).toFixed(1)} km`
  : null;

const coordinates = (latitude, longitude) => Number.isFinite(latitude) && Number.isFinite(longitude)
  ? `${latitude.toFixed(6)}, ${longitude.toFixed(6)}` : null;

/**
 * Hover text. With details it leads with FL511's own words; without them it says only what is
 * certain — which feed the marker came from and its FL511 id.
 */
export function liveEventTooltip(event) {
  const lines = [liveEventLabel(event)];
  if (present(event.description)) {
    const text = String(event.description);
    lines.push(text.length > 180 ? `${text.slice(0, 177)}…` : text);
  }
  lines.push(`FL511 Event ${event.rawSourceId}`);
  return lines.join('\n');
}

// Labels already promoted onto model fields; the passthrough below must not repeat them.
const MAPPED_DETAIL_LABELS = new Set(['severity', 'region', 'start time', 'end time', 'last updated', 'comment', 'detour']);

/** Rows FL511 published. Everything here is source data. */
export function liveEventSourceRows(event) {
  const extras = (event.detailFields ?? [])
    .filter(field => field && !MAPPED_DETAIL_LABELS.has(String(field.label).toLowerCase()))
    .map(field => [field.label, field.value]);
  return rows([
    ['Type', LIVE_EVENT_LABELS[event.type] ?? null],
    // Populated only if FL511 ever publishes them as structured values; today it does not.
    ['Road', event.roadway], ['Direction', event.direction],
    ['Description', event.description],
    ['Severity', event.severity], ['Status', event.status],
    ['Lanes Blocked', event.lanesBlocked],
    ['Started', event.startTime], ['Ends', event.endTime],
    ['Last Updated', event.lastUpdated],
    ['Detour', event.detour], ['Comment', event.comment], ['Region', event.region],
    ...extras,
    ['Location', coordinates(event.latitude, event.longitude)],
    ['Secondary Location', coordinates(event.secondaryLatitude, event.secondaryLongitude)],
    ['Source', event.source ?? 'FL511'],
    ['FL511 Event ID', event.rawSourceId],
  ]);
}

/**
 * Rows our own geometry derived. Proximity to a facility is not a claim that FL511 placed the
 * event on it — corridor closures routinely sit metres from an I-595 ramp while belonging to a
 * different road — so these are rendered under their own heading.
 */
export function liveEventAssociationRows(event) {
  return rows([
    ['Nearest Facility', event.nearestFacilityLabel],
    ['Distance', formatMeters(event.distanceToNearestFacilityM)],
    ['Nearest Segment', event.nearestSegmentLabel],
    ['Segment ID', event.nearestSegmentId],
    ['Segment Distance', formatMeters(event.distanceToSegmentM)],
    ['Secondary Point Distance', formatMeters(event.secondaryDistanceToI595NetworkM)],
  ]);
}

/**
 * Four distinct conditions, never conflated — the first three describe FL511 as seen by our own
 * service, the fourth describes our service as seen by this browser:
 *
 *   LIVE                our API answered and its FL511 data is current
 *   STALE               our API answered, but its latest FL511 refresh failed; cache is served
 *   UNAVAILABLE         our API answered, and it has never obtained FL511 data
 *   SERVICE_UNREACHABLE this page cannot reach /api/i595/live-events at all
 */
export const LIVE_EVENT_SOURCE_STATUS = Object.freeze({
  LIVE: 'LIVE', STALE: 'STALE', UNAVAILABLE: 'UNAVAILABLE', SERVICE_UNREACHABLE: 'SERVICE_UNREACHABLE',
});

const ageSuffix = payload => {
  const age = payload.dataFreshness?.ageSeconds;
  return Number.isFinite(age) ? ` from ${formatAge(age)} ago` : '';
};

/** One-line freshness summary for the layer's status row. */
export function liveEventStatusText(payload) {
  if (!payload) return 'Live events could not load.';
  const counts = payload.counts ?? {};
  if (payload.sourceStatus === LIVE_EVENT_SOURCE_STATUS.SERVICE_UNREACHABLE) {
    // Markers from an earlier response may still be on screen; say so instead of implying none.
    return counts.total
      ? `Live-event service unreachable · still showing ${counts.total} event${counts.total === 1 ? '' : 's'}${ageSuffix(payload)}`
      : 'Live-event service unreachable — no FL511 data received yet.';
  }
  if (payload.sourceStatus === LIVE_EVENT_SOURCE_STATUS.UNAVAILABLE) {
    return 'FL511 unavailable — no live events cached yet.';
  }
  const summary = `${counts.total ?? 0} live event${counts.total === 1 ? '' : 's'} within ${payload.bufferMeters} m`;
  if (payload.sourceStatus === LIVE_EVENT_SOURCE_STATUS.STALE) {
    const age = payload.dataFreshness?.ageSeconds;
    return `${summary} · cached data${Number.isFinite(age) ? ` from ${formatAge(age)} ago` : ''}`;
  }
  return `${summary} · live`;
}

/**
 * The banner shown under the feed toggles, or null when everything is current. Each condition
 * states what is actually true of the markers on screen — cached FL511 data is never described as
 * a service that is not running, and a stopped service is never described as an empty corridor.
 */
export function liveEventNotice(payload) {
  const status = payload?.sourceStatus;
  if (status === LIVE_EVENT_SOURCE_STATUS.LIVE) return null;
  if (status === LIVE_EVENT_SOURCE_STATUS.STALE) {
    return `FL511 is not responding; showing the last successful update${ageSuffix(payload)}.`;
  }
  if (status === LIVE_EVENT_SOURCE_STATUS.UNAVAILABLE) {
    return 'The live-event service is running but has not retrieved any FL511 data yet.';
  }
  const endpoint = payload?.endpoint ?? '/api/i595/live-events';
  return payload?.counts?.total
    ? `This map cannot reach ${endpoint}. The events shown were received${ageSuffix(payload)} and are no longer updating.`
    : `This map cannot reach ${endpoint}, so no FL511 data has been received.`;
}

export function formatAge(seconds) {
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

/**
 * Diff two snapshots by FL511 id so the layer can add, update and remove entities instead of
 * rebuilding them. `updated` holds only events whose rendered content actually changed.
 */
export function diffLiveEvents(previous, next) {
  const before = new Map((previous ?? []).map(event => [event.id, event]));
  const after = new Map((next ?? []).map(event => [event.id, event]));
  const added = [], updated = [];
  for (const [id, event] of after) {
    const old = before.get(id);
    if (!old) added.push(event);
    else if (fingerprint(old) !== fingerprint(event)) updated.push(event);
  }
  return { added, updated, removed: [...before.keys()].filter(id => !after.has(id)) };
}

const fingerprint = event => JSON.stringify([
  event.latitude, event.longitude, event.secondaryLatitude, event.secondaryLongitude,
  event.type, event.title, event.description, event.severity, event.status, event.startTime,
  event.endTime, event.lastUpdated, event.detour, event.comment, event.region,
  event.nearestFacility, event.nearestSegmentId, event.distanceToNearestFacilityM,
  event.distanceToSegmentM, event.detailFields,
]);
