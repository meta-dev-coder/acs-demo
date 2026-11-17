/**
 * Presentation model for FL511 live traffic.
 *
 * Ported from the ACS I-595 Safety Twin's `src/liveEventsData.js`, keeping the one rule that file
 * enforces: rows come from values the backend actually received, and a field FL511 did not publish
 * produces NO ROW AT ALL — never a placeholder, a guess or a default. Source rows (what FL511
 * said) and association rows (what our own geometry computed) are built separately so the details
 * panel can label them separately.
 *
 * Left behind with the rest of the corridor logic: the DataConnect `sdna` condition rows, the
 * cleared-event history windows and the carriageway/section vocabulary. PortMiami stores no event
 * history (see README) and has no carriageways.
 */
import { TRAFFIC_ICONS } from '../config/liveTraffic.js';

export const EVENT_TYPES = Object.freeze({
  INCIDENT: 'INCIDENT', CLOSURE: 'CLOSURE', CONSTRUCTION: 'CONSTRUCTION',
  CONGESTION: 'CONGESTION', DISABLED_VEHICLE: 'DISABLED_VEHICLE',
});

export const EVENT_LABELS = Object.freeze({
  INCIDENT: 'Incident', CLOSURE: 'Closure', CONSTRUCTION: 'Construction',
  CONGESTION: 'Congestion', DISABLED_VEHICLE: 'Disabled vehicle',
});

const present = value => value != null && String(value).trim() !== '';
const rows = entries => entries.filter(([, value]) => present(value)).map(([label, value]) => [label, String(value)]);

/** FL511's own heading when it published one, otherwise the feed the event came from. */
export const eventLabel = event => (present(event?.title) ? String(event.title)
  : EVENT_LABELS[event?.type] ?? 'Live event');

export const formatMeters = value => (Number.isFinite(value)
  ? value < 1000 ? `${Math.round(value)} m` : `${(value / 1000).toFixed(1)} km`
  : null);

const coordinates = (latitude, longitude) => (Number.isFinite(latitude) && Number.isFinite(longitude)
  ? `${latitude.toFixed(6)}, ${longitude.toFixed(6)}` : null);

/** Hover text: FL511's own words when there are any, and otherwise only what is certain. */
export function eventTooltip(event) {
  const lines = [eventLabel(event)];
  if (present(event.description)) {
    const text = String(event.description);
    lines.push(text.length > 180 ? `${text.slice(0, 177)}…` : text);
  }
  lines.push(`FL511 event ${event.sourceEventId}`);
  return lines.join('\n');
}

// Labels already promoted onto model fields; the passthrough below must not repeat them.
const MAPPED_DETAIL_LABELS = new Set(['severity', 'region', 'start time', 'end time', 'last updated', 'comment', 'detour']);

/** Rows FL511 published. Everything here is source data. */
export function eventSourceRows(event) {
  const extras = (event.detailFields ?? [])
    .filter(field => field && !MAPPED_DETAIL_LABELS.has(String(field.label).toLowerCase()))
    .map(field => [field.label, field.value]);
  return rows([
    ['Type', EVENT_LABELS[event.type] ?? null],
    // FL511 publishes roadway and direction only inside its prose, never as structured values, so
    // these stay empty rather than being parsed out of a sentence.
    ['Road', event.roadway], ['Direction', event.direction],
    ['Description', event.description],
    ['Severity', event.severity], ['Status', event.status],
    ['Lanes blocked', event.lanesBlocked],
    ['Started', event.startTime], ['Ends', event.endTime],
    ['Last updated', event.lastUpdated],
    ['Detour', event.detour], ['Comment', event.comment], ['Region', event.region],
    ...extras,
    ['Location', coordinates(event.latitude, event.longitude)],
    ['Second published point', coordinates(event.secondaryLatitude, event.secondaryLongitude)],
    ['Source', event.source ?? 'FL511'],
    ['FL511 event ID', event.sourceEventId],
  ]);
}

/** How the event came to be in the study area. Our test, labelled as ours. */
export const AREA_MATCH_LABELS = Object.freeze({
  POINT_IN_AREA: 'Published point is inside the study area',
  ENDPOINT_IN_AREA: 'One of two published points is inside the study area',
  SPAN_CROSSES_AREA: 'Both published points are outside; the line between them crosses the study area',
});

/**
 * Match methods, in words a reader can weigh.
 *
 * Subject-free on purpose: the same labels appear under an event, a camera and a message sign, so
 * "the event names this road" would be wrong in two of the three places it is printed.
 */
export const MATCH_METHOD_LABELS = Object.freeze({
  NAME_AND_PROXIMITY: 'Named as the road this is on, and within range of it',
  CROSS_REFERENCE_AND_PROXIMITY: 'Named as a junction with this road, and within range of it',
  OFFSET_REFERENCE: 'Named as a road this is measured FROM, so it is not on it',
  PROXIMITY_ONLY: 'Nearby only — nothing in the source text names this road',
  NAME_AND_PROXIMITY_DIRECTION_CONFLICT:
    'Named as the road this is on, but the stated direction contradicts the segment’s',
});

export const LINK_STATUS_LABELS = Object.freeze({
  MATCHED: 'Matched', CANDIDATE: 'Candidate', UNMATCHED: 'No road matched',
});

/**
 * Five distinct conditions, never conflated — the first three describe FL511 as seen by our own
 * server, the last two describe our server as seen by this browser:
 *
 *   LIVE                our API answered and its FL511 data is current
 *   STALE               our API answered, but its latest FL511 refresh failed; cache is served
 *   UNAVAILABLE         our API answered, and it has never obtained FL511 data
 *   SERVICE_UNREACHABLE this page cannot reach /api/portmiami/* at all
 *   LOADING             the first request has not come back yet
 */
export const SOURCE_STATUS = Object.freeze({
  LIVE: 'LIVE', STALE: 'STALE', UNAVAILABLE: 'UNAVAILABLE',
  SERVICE_UNREACHABLE: 'SERVICE_UNREACHABLE', LOADING: 'LOADING',
});

export function formatAge(seconds) {
  if (!Number.isFinite(seconds)) return 'unknown';
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

const ageSuffix = payload => {
  const age = payload?.dataFreshness?.ageSeconds;
  return Number.isFinite(age) ? ` from ${formatAge(age)} ago` : '';
};

/** A short "FL511 · live" / "· stale" chip label with its tone. */
export function sourceNote(payload) {
  const status = String(payload?.sourceStatus ?? '').toUpperCase();
  if (status === SOURCE_STATUS.LIVE) return { text: 'FL511 · live', tone: 'live' };
  if (status === SOURCE_STATUS.STALE) return { text: 'FL511 · cached', tone: 'warn' };
  if (status === SOURCE_STATUS.LOADING) return { text: 'FL511 · loading', tone: 'muted' };
  if (status === SOURCE_STATUS.SERVICE_UNREACHABLE) return { text: 'Service unreachable', tone: 'warn' };
  return { text: 'FL511 · unavailable', tone: 'warn' };
}

/**
 * The banner under the layer toggles, or null when everything is current. Each condition states
 * what is actually true of the markers on screen — cached FL511 data is never described as a
 * service that is not running, and a stopped service is never described as an empty study area.
 */
export function statusNotice(payload) {
  const status = String(payload?.sourceStatus ?? '').toUpperCase();
  if (status === SOURCE_STATUS.LIVE) return null;
  if (status === SOURCE_STATUS.LOADING) return null;
  if (status === SOURCE_STATUS.STALE) {
    return `FL511 is not responding; showing the last successful update${ageSuffix(payload)}.`;
  }
  if (status === SOURCE_STATUS.UNAVAILABLE) {
    return 'The live-traffic service is running but has not retrieved any FL511 data yet.';
  }
  const total = payload?.counts?.total ?? payload?.count ?? 0;
  return total
    ? `This page cannot reach the live-traffic service. What is shown was received${ageSuffix(payload)} and is no longer updating.`
    : 'This page cannot reach the live-traffic service, so no FL511 data has been received.';
}

/**
 * The absence of events is NOT a statement that traffic is normal.
 *
 * This sentence exists because "0 incidents" invites exactly that reading. FL511 reports what has
 * been reported to it; an unreported incident is indistinguishable from no incident, and this twin
 * has no independent traffic measurement to fall back on.
 */
export const EMPTY_IS_NOT_NORMAL =
  'No reported events is not a statement that conditions are normal — FL511 shows only what has '
  + 'been reported to it, and this twin has no independent traffic measurement.';

export const NO_EVENTS_FOR_ROAD = 'No FL511 events currently associated with this road.';

/** The icon record for anything on the live-traffic layer. */
export const trafficIcon = key => TRAFFIC_ICONS[key] ?? null;

/**
 * Diff two event snapshots by id so the layer can add, update and remove entities instead of
 * rebuilding them. Ported from ACS. `updated` holds only events whose rendered content changed.
 */
export function diffEvents(previous, next) {
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
  event.type, event.title, event.description, event.severity, event.status,
  event.startTime, event.endTime, event.lastUpdated, event.detour, event.comment, event.region,
  event.detailFields, event.roadAssociationStatus,
  (event.roadAssociations ?? []).map(link => `${link.roadObjectId}:${link.status}`).join(','),
]);

/** Count by type, for the Overview tab. Computed, never typed in. */
export function summariseTraffic(events = [], cameras = [], signs = []) {
  const byType = type => events.filter(event => event.type === type).length;
  return {
    incidents: byType(EVENT_TYPES.INCIDENT),
    closures: byType(EVENT_TYPES.CLOSURE),
    congestion: byType(EVENT_TYPES.CONGESTION),
    construction: byType(EVENT_TYPES.CONSTRUCTION),
    disabledVehicles: byType(EVENT_TYPES.DISABLED_VEHICLE),
    events: events.length,
    cameras: cameras.length,
    camerasWithVideo: cameras.filter(camera => camera.videoEnabled === true).length,
    messageSigns: signs.length,
    /** Events with at least one MATCHED road association. */
    eventsOnKnownRoads: events.filter(event => event.roadAssociationStatus === 'MATCHED').length,
    eventsOnPortAccessRoads: events.filter(event => (event.roadAssociations ?? [])
      .some(link => link.status === 'MATCHED' && link.isPortAccess)).length,
  };
}

/**
 * Every event associated with one road segment, split by how good the evidence is.
 *
 * `matched` is what the event's own words support. `candidates` is proximity only, and is kept
 * SEPARATE rather than merged in, because a road details panel that lists both together would be
 * telling a reader that an event 140 m away on a different street is happening on this one.
 */
export function eventsForRoad(events, roadObjectId) {
  const matched = [], candidates = [];
  for (const event of events ?? []) {
    const link = (event.roadAssociations ?? []).find(entry => entry.roadObjectId === roadObjectId);
    if (!link) continue;
    (link.status === 'MATCHED' ? matched : candidates).push({ event, link });
  }
  const byDistance = (a, b) => a.link.distanceMeters - b.link.distanceMeters;
  return { matched: matched.sort(byDistance), candidates: candidates.sort(byDistance) };
}

/** The same, for a set of road ids — an asset's confirmed access roads. */
export function eventsForRoads(events, roadObjectIds) {
  const ids = new Set(roadObjectIds ?? []);
  const seen = new Map();
  for (const event of events ?? []) {
    for (const link of event.roadAssociations ?? []) {
      if (!ids.has(link.roadObjectId)) continue;
      const existing = seen.get(event.id);
      // Keep the strongest link this event has to any of the roads asked about.
      if (!existing || (existing.link.status !== 'MATCHED' && link.status === 'MATCHED')) {
        seen.set(event.id, { event, link });
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.link.distanceMeters - b.link.distanceMeters);
}
