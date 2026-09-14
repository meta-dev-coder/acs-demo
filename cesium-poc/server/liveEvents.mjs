/**
 * Our own road-event model. FL511's JSON never reaches the browser: everything below is either a
 * value FL511 actually published (source) or a distance our own corridor geometry computed
 * (digital-twin association). The two are kept in separate, differently named fields on purpose —
 * a closure 15 m from an I-595 ramp is routinely an event on a *different* road, so proximity is
 * never allowed to become a roadway or direction claim.
 */
import { LAYERS } from './fl511Client.mjs';
import { FACILITY_LABELS } from './i595Network.mjs';

/** @typedef {'INCIDENT'|'CLOSURE'} LiveRoadEventType */

export const EVENT_TYPES = Object.freeze({ INCIDENT: 'INCIDENT', CLOSURE: 'CLOSURE' });
export const layerIdFor = type => type === EVENT_TYPES.CLOSURE ? LAYERS.CLOSURE : LAYERS.INCIDENT;

// FL511 prints these labels in its detail table; each maps to one model field. Anything else it
// prints is preserved verbatim in detailFields rather than dropped or reinterpreted.
const DETAIL_FIELDS = new Map([
  ['severity', 'severity'],
  ['region', 'region'],
  ['start time', 'startTime'],
  ['end time', 'endTime'],
  ['last updated', 'lastUpdated'],
  ['comment', 'comment'],
  ['detour', 'detour'],
]);

/**
 * One FL511 mapIcons item plus our spatial association. Returns null when the event is outside the
 * corridor buffer — statewide events are simply not ours.
 * @returns {object | null}
 */
export function normalizeEvent(item, type, network, { bufferMeters, segmentToleranceMeters }) {
  const primary = network.associate(item.longitude, item.latitude, { segmentToleranceMeters });
  const hasSecondary = Number.isFinite(item.secondaryLatitude) && Number.isFinite(item.secondaryLongitude);
  // A closure is ours when *either* published endpoint reaches the corridor; FL511 anchors long
  // closures at a point that can sit well off I-595 while the other end runs alongside it.
  const secondary = hasSecondary
    ? network.associate(item.secondaryLongitude, item.secondaryLatitude, { segmentToleranceMeters })
    : null;
  const primaryDistance = primary.distanceToNetworkM ?? Infinity;
  const secondaryDistance = secondary?.distanceToNetworkM ?? Infinity;
  if (Math.min(primaryDistance, secondaryDistance) > bufferMeters) return null;

  // Associate against whichever published endpoint is actually on the corridor.
  const closest = secondaryDistance < primaryDistance ? secondary : primary;
  return {
    id: `FL511-${type}-${item.itemId}`,
    source: 'FL511',
    type,
    latitude: item.latitude,
    longitude: item.longitude,
    ...(hasSecondary ? { secondaryLatitude: item.secondaryLatitude, secondaryLongitude: item.secondaryLongitude } : {}),
    ...(item.title ? { title: item.title } : {}),
    detailsAvailable: false,
    detailFields: [],
    // --- digital-twin derived association (our geometry, not FL511's words) ---
    distanceToI595NetworkM: round(Math.min(primaryDistance, secondaryDistance)),
    ...(hasSecondary ? { secondaryDistanceToI595NetworkM: round(secondaryDistance) } : {}),
    nearestFacility: closest.nearestFacility,
    nearestFacilityLabel: FACILITY_LABELS[closest.nearestFacility] ?? null,
    distanceToNearestFacilityM: round(closest.distanceToNearestFacilityM),
    nearestSegmentId: closest.nearestSegmentId,
    nearestSegmentLabel: closest.nearestSegmentLabel,
    distanceToSegmentM: round(closest.distanceToSegmentM),
    rawSourceId: item.itemId,
  };
}

/** Fold a parsed FL511 detail fragment onto an event. Absent rows leave fields absent. */
export function attachDetails(event, detail) {
  if (!detail) return event;
  const enriched = { ...event, detailsAvailable: true, detailFields: detail.fields ?? [] };
  if (detail.title) enriched.title = detail.title;
  if (detail.description) enriched.description = detail.description;
  for (const { label, value } of detail.fields ?? []) {
    const key = DETAIL_FIELDS.get(label.toLowerCase());
    if (key && !enriched[key]) enriched[key] = value;
  }
  // FL511 publishes roadway, direction and lanes blocked only inside the prose description, never
  // as structured values, so roadway/direction/lanesBlocked stay undefined rather than parsed.
  return enriched;
}

/**
 * Normalize a whole feed, dropping events outside the corridor. A single unusable item is logged
 * and skipped; it never fails the feed.
 */
export function normalizeFeed(items, type, network, options, logger = console) {
  const events = [];
  for (const item of items) {
    try {
      const event = normalizeEvent(item, type, network, options);
      if (event) events.push(event);
    } catch (error) {
      logger.warn?.(`FL511 ${type} ${item?.itemId}: skipped (${error.message})`);
    }
  }
  return events;
}

const round = value => Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
