/**
 * Our own road-event model. FL511's JSON never reaches the browser.
 *
 * Ported from the ACS I-595 Safety Twin (`cesium-poc/server/liveEvents.mjs`), keeping its event
 * type set, its DETAIL_FIELDS mapping and its `attachDetails` behaviour. What was deliberately
 * LEFT BEHIND is every corridor-specific rule, because none of it is true of PortMiami:
 *
 *   - `enrichForLiveOps` and with it carriageway classification (EB / WB / Express), FDOT traffic
 *     sections, milepost ranges and `contributesToImpact`. PortMiami has no reversible express
 *     lanes, no SR 84 frontage roads and no FDOT segment grid.
 *   - `laneImpact` parsing, which reads lane counts out of I-595 prose against a known lane layout.
 *   - `nearestFacility` and the I595_EB / SR84_WB / RAMP_CONNECTOR facility vocabulary.
 *   - Severity and risk scoring. The I-595 model is calibrated on that corridor's own crash
 *     history; carrying the numbers over would be asserting something about PortMiami that was
 *     measured somewhere else.
 *
 * The rule the ACS file states, and the one worth keeping above all: every field below is either a
 * value FL511 actually published (`source`) or a distance our own geometry computed (association).
 * The two are kept in separate, differently named fields on purpose — an event 15 m from a port
 * road is routinely an event on a DIFFERENT road, so proximity is never allowed to become a
 * roadway or direction claim.
 */
import { LAYERS } from './client.mjs';

/** @typedef {'INCIDENT'|'CLOSURE'|'CONSTRUCTION'|'CONGESTION'|'DISABLED_VEHICLE'} LiveEventType */

export const EVENT_TYPES = Object.freeze({
  INCIDENT: 'INCIDENT', CLOSURE: 'CLOSURE', CONSTRUCTION: 'CONSTRUCTION',
  CONGESTION: 'CONGESTION', DISABLED_VEHICLE: 'DISABLED_VEHICLE',
});

/** Which FL511 layer each type's markers and detail fragments come from. */
const LAYER_BY_TYPE = Object.freeze({
  [EVENT_TYPES.INCIDENT]: LAYERS.INCIDENT,
  [EVENT_TYPES.CLOSURE]: LAYERS.CLOSURE,
  [EVENT_TYPES.CONSTRUCTION]: LAYERS.CONSTRUCTION,
  [EVENT_TYPES.CONGESTION]: LAYERS.CONGESTION,
  [EVENT_TYPES.DISABLED_VEHICLE]: LAYERS.DISABLED,
});
export const layerIdFor = type => LAYER_BY_TYPE[type] ?? LAYERS.INCIDENT;

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
 * GeoJSON for an event, from the points FL511 published and nothing else.
 *
 * A two-point event becomes a **MultiPoint**, not a LineString. That is the whole decision: a
 * LineString would assert a path between the two points, and FL511 publishes no path — only two
 * anchors. The UI draws a dashed connector between them precisely because a dashed line reads as
 * "these two are related" rather than "this is the closed stretch".
 */
const geometryFor = event => (event.secondaryLongitude == null
  ? { type: 'Point', coordinates: [event.longitude, event.latitude] }
  : { type: 'MultiPoint', coordinates: [[event.longitude, event.latitude],
                                        [event.secondaryLongitude, event.secondaryLatitude]] });

/**
 * One study-area FL511 marker as our event record. The caller has already decided the item is in
 * the region (see portmiami/studyArea.mjs), so nothing here filters.
 *
 * @param {object} item   a parseMapIcons item carrying areaMatch/geometryBasis
 * @param {LiveEventType} type
 * @param {{regionId: string}} context
 */
export function normalizeEvent(item, type, { regionId }) {
  return {
    id: `FL511-${type}-${item.itemId}`,
    source: 'FL511',
    sourceEventId: item.itemId,
    regionId,
    type,
    latitude: item.latitude,
    longitude: item.longitude,
    ...(item.secondaryLatitude != null
      ? { secondaryLatitude: item.secondaryLatitude, secondaryLongitude: item.secondaryLongitude } : {}),
    ...(item.title ? { title: item.title } : {}),
    geometry: geometryFor(item),
    // --- how this event came to be in the study area (our test, not FL511's words) -------------
    areaMatch: item.areaMatch,
    geometryBasis: item.geometryBasis,
    // --- filled in by the detail fragment, when there is one ----------------------------------
    detailsAvailable: false,
    detailFields: [],
    // --- filled in by roadAssociation.mjs -----------------------------------------------------
    roadAssociations: [],
  };
}

/** Fold a parsed FL511 detail fragment onto an event. Absent rows leave fields absent. */
export function attachDetails(event, detail) {
  if (!detail) return event;
  const enriched = { ...event, detailsAvailable: true, detailFields: detail.fields ?? [] };
  if (detail.title) enriched.title = detail.title;
  if (detail.description) enriched.description = detail.description;
  if (detail.cameras?.length) enriched.fl511Cameras = detail.cameras.map(camera => ({ ...camera }));
  for (const { label, value } of detail.fields ?? []) {
    const key = DETAIL_FIELDS.get(label.toLowerCase());
    if (key && !enriched[key]) enriched[key] = value;
  }
  // FL511 publishes roadway, direction and lanes blocked only inside the prose description, never
  // as structured values, so `roadway` / `direction` / `lanesBlocked` stay UNDEFINED rather than
  // being parsed out of prose. The road association is the evidenced answer to "which road"; it
  // does not pretend to be FL511's answer.
  return enriched;
}

/**
 * Normalize a whole feed. A single unusable item is logged and skipped; it never fails the feed.
 */
export function normalizeFeed(items, type, context, logger = console) {
  const events = [];
  for (const item of items) {
    try {
      events.push(normalizeEvent(item, type, context));
    } catch (error) {
      logger.warn?.(`FL511 ${type} ${item?.itemId}: skipped (${error.message})`);
    }
  }
  return events;
}
