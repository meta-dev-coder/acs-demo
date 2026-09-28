/**
 * What is inside a drawn area — resolved deterministically, before Ask the Twin says a word.
 *
 * The division of labour matters here. This module does the GIS: which carriageways the box
 * crosses, which FDOT sections, which live events, which assets, which maintenance records. Ask the
 * Twin then explains that result in English. It is never handed a rectangle and asked to work out
 * what is in it — a language model guessing at containment would be a plausible-sounding answer
 * with nothing behind it, and an operator would act on it.
 *
 * Everything here reads data the application has already loaded: the corridor geometry the incident
 * panel loads, the live events the map is drawing, the assets the explorer can search, the
 * maintenance records the workspace holds. Nothing is fetched, and no record is invented — a box
 * over open water returns empty lists, not the nearest thing to it.
 *
 * Pure: data in, normalized context out.
 */

import { assetTypeConfig } from '../assetExplorer/assetTypes.js';
import { CARRIAGEWAYS } from '../liveOps/carriagewayModel.js';
import { liveEventLabel } from '../liveEventsData.js';
import { boundsCenter, boundsToPolygon, geometryIntersectsBounds, isUsableBounds, pointInBounds } from './areaGeometry.js';

/**
 * Section naming, mirroring Live Ops (liveOpsWorkspace.js) rather than re-deciding it: an area's
 * "Section 03" and the operational impact panel's "Section 03" must be the same words, or an
 * operator reading both will think they are two different things.
 */
export const sectionIdFor = index => (Number.isFinite(index) ? `SECTION_${String(index).padStart(2, '0')}` : null);
export const sectionLabelFor = (direction, index) =>
  `${direction === 'WB' ? 'Westbound' : 'Eastbound'} Section ${String(index ?? 0).padStart(2, '0')}`;

/** The live-event types the corridor draws, in the order the Live Ops strip lists them. */
const EVENT_GROUPS = Object.freeze({
  INCIDENT: 'incidents', CLOSURE: 'closures', DISABLED: 'disabledVehicles',
  CONGESTION: 'congestion', CONSTRUCTION: 'construction',
});
const EMPTY_EVENTS = Object.freeze(Object.fromEntries(Object.values(EVENT_GROUPS).map(key => [key, []])));

/** The maintenance classes an area reports on, and the key each is grouped under. */
export const MAINTENANCE_TYPES = Object.freeze({
  workOrder: 'workOrders', ticket: 'tickets', task: 'tasks',
  inspection: 'inspections', incidentRecord: 'incidents', damagedAsset: 'damagedAssets',
});

const text = value => {
  const string = value == null ? '' : String(value).trim();
  return string && string.toUpperCase() !== 'N/A' ? string : null;
};
const number = value => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null);

/** A corridor line's carriageway, from the properties FDOT publishes on it. */
function carriagewayOf(properties) {
  const direction = String(properties?.direction ?? '').toUpperCase();
  if (/express/i.test(properties?.facility ?? '') || direction === 'REVERSIBLE') return CARRIAGEWAYS.EXPRESS;
  if (direction === 'EB') return CARRIAGEWAYS.EB_GENERAL;
  if (direction === 'WB') return CARRIAGEWAYS.WB_GENERAL;
  return CARRIAGEWAYS.UNKNOWN;
}

/**
 * Which corridor geometry the box actually crosses.
 *
 * Every line is tested independently, because one box can span all three carriageways — they run
 * side by side for most of I-595, and picking the nearest one to the box's centre would report a
 * single carriageway for an area that plainly covers three.
 *
 * @param {object} bounds
 * @param {{properties: object, coordinates: number[][]}[]} lines corridor geometry (carriagewayLines)
 */
export function resolveRoadwayContext(bounds, lines = []) {
  const empty = { intersectsI595: false, carriageways: [], segments: [], includesExpress: false };
  if (!isUsableBounds(bounds)) return empty;
  const carriageways = new Set();
  const segments = [];
  let includesExpress = false;
  for (const line of lines) {
    if (!geometryIntersectsBounds({ type: 'LineString', coordinates: line.coordinates }, bounds)) continue;
    const properties = line.properties ?? {};
    const carriageway = carriagewayOf(properties);
    carriageways.add(carriageway);
    if (carriageway === CARRIAGEWAYS.EXPRESS) {
      // Express has no operational sections in this model yet, so it gets no section id. Inventing
      // one would put a label in an operator's hands that nothing else in the app could resolve.
      includesExpress = true;
      continue;
    }
    const index = number(properties.fdot_segment_index);
    const direction = String(properties.direction ?? '').toUpperCase();
    segments.push({
      carriageway,
      segmentId: text(properties.segment_id),
      fdotSegmentIndex: index,
      sectionId: sectionIdFor(index),
      sectionLabel: sectionLabelFor(direction, index),
      beginPost: number(properties.begin_post),
      endPost: number(properties.end_post),
      from: text(properties.desc_from),
      to: text(properties.desc_to),
    });
  }
  segments.sort((a, b) => a.carriageway.localeCompare(b.carriageway) || (a.fdotSegmentIndex ?? 0) - (b.fdotSegmentIndex ?? 0));
  // Reported in the order an operator reads the corridor: eastbound, express, westbound.
  const order = [CARRIAGEWAYS.EB_GENERAL, CARRIAGEWAYS.EXPRESS, CARRIAGEWAYS.WB_GENERAL, CARRIAGEWAYS.UNKNOWN];
  return {
    intersectsI595: carriageways.size > 0,
    carriageways: order.filter(carriageway => carriageways.has(carriageway)),
    segments,
    includesExpress,
  };
}

/** One live event, reduced to what an answer needs — never the raw FL511 payload. */
function normalizeEvent(event) {
  return {
    id: text(event.id),
    type: text(event.type),
    title: liveEventLabel(event),
    status: text(event.status),
    severity: text(event.severity),
    latitude: number(event.latitude),
    longitude: number(event.longitude),
    carriageway: text(event.liveOps?.carriageway),
    carriagewayLabel: text(event.liveOps?.carriagewayLabel),
    sectionId: text(event.liveOps?.sectionId),
    segmentId: text(event.nearestSegmentId),
    laneImpact: text(event.liveOps?.laneImpactLabel) ?? text(event.lanesBlocked),
    updatedAt: text(event.lastUpdated) ?? text(event.startTime),
  };
}

/**
 * The live events in the box.
 *
 * An event is in the area if its own point is, or — for the ones FL511 publishes with a second
 * endpoint — if the line between the two crosses it. A closure running the length of the box with
 * both ends outside it is the case that matters, and a point test alone would miss it.
 */
export function findLiveEvents(bounds, events = []) {
  const found = Object.fromEntries(Object.values(EVENT_GROUPS).map(key => [key, []]));
  if (!isUsableBounds(bounds)) return found;
  for (const event of events) {
    const group = EVENT_GROUPS[event?.type];
    if (!group) continue;
    const inside = pointInBounds(event.longitude, event.latitude, bounds)
      || (Number.isFinite(event.secondaryLatitude) && geometryIntersectsBounds({
        type: 'LineString',
        coordinates: [[event.longitude, event.latitude], [event.secondaryLongitude, event.secondaryLatitude]],
      }, bounds));
    if (inside) found[group].push(normalizeEvent(event));
  }
  return found;
}

/**
 * The assets in the box, from whatever types the application has loaded.
 *
 * Categories are discovered from the data rather than listed here: the explorer already knows what
 * a gantry, a camera and a bridge are, and hard-coding a second list would go stale the first time
 * a layer is added. An asset with a `geometry` of its own is tested against it — a bridge is a span,
 * not a dot — and one with neither point nor geometry is left out rather than assumed to be in.
 *
 * @param {{asset: object}[]|object[]} entries searchable entries, or bare assets
 */
export function findAssets(bounds, entries = []) {
  const records = [];
  if (!isUsableBounds(bounds)) return { total: 0, byCategory: {}, records };
  for (const entry of entries) {
    const asset = entry?.asset ?? entry;
    if (!asset?.assetType) continue;
    // Live events and maintenance records are reported in their own sections. Counting them here
    // too made "619 assets" out of an area holding 272 — the same work order appearing once as an
    // asset and once as maintenance — and an operator reading both would double the backlog.
    if (MAINTENANCE_TYPES[asset.assetType]) continue;
    if (EVENT_GROUPS[String(asset.source?.type ?? '').toUpperCase()] && asset.source?.rawSourceId) continue;
    const point = asset.coordinates;
    const inside = point ? pointInBounds(point.longitude, point.latitude, bounds)
      : asset.geometry?.type ? geometryIntersectsBounds(asset.geometry, bounds) : false;
    if (!inside) continue;
    const config = assetTypeConfig(asset.assetType);
    records.push({
      id: text(asset.id),
      assetType: asset.assetType,
      category: config?.label ?? asset.assetType,
      name: text(asset.name) ?? text(asset.id),
      latitude: point ? number(point.latitude) : null,
      longitude: point ? number(point.longitude) : null,
    });
  }
  const byCategory = {};
  for (const record of records) byCategory[record.category] = (byCategory[record.category] ?? 0) + 1;
  return { total: records.length, byCategory, records };
}

/**
 * Where a maintenance record actually is.
 *
 * Its own coordinates when it has them; otherwise the asset it names. A work order rarely carries a
 * position of its own — the position of the work IS the position of the asset — and discarding it
 * for that reason would hide most of the backlog from every area an operator draws.
 *
 * @returns {{longitude: number, latitude: number, via: 'record'|'asset'}|null}
 */
export function locateMaintenanceRecord(record, assetIndex) {
  if (Number.isFinite(record?.longitude) && Number.isFinite(record?.latitude)) {
    return { longitude: record.longitude, latitude: record.latitude, via: record.locationSource === 'asset' ? 'asset' : 'record' };
  }
  const asset = record?.assetId ? assetIndex?.get?.(String(record.assetId).trim()) : null;
  if (asset && Number.isFinite(asset.longitude) && Number.isFinite(asset.latitude)) {
    return { longitude: asset.longitude, latitude: asset.latitude, via: 'asset' };
  }
  return null;
}

/**
 * The maintenance records whose work lies in the box.
 *
 * @param {object} bounds
 * @param {(assetType: string) => object[]} lookup every loaded record of one maintenance class
 * @param {Map<string, {longitude: number, latitude: number}>} [assetIndex] the asset registry
 */
export function findMaintenance(bounds, lookup, assetIndex = new Map()) {
  const found = Object.fromEntries(Object.values(MAINTENANCE_TYPES).map(key => [key, []]));
  if (!isUsableBounds(bounds) || typeof lookup !== 'function') return found;
  for (const [assetType, group] of Object.entries(MAINTENANCE_TYPES)) {
    for (const record of lookup(assetType) ?? []) {
      const place = locateMaintenanceRecord(record, assetIndex);
      if (!place || !pointInBounds(place.longitude, place.latitude, bounds)) continue;
      found[group].push({
        id: text(record.id),
        title: text(record.title),
        status: text(record.status),
        priority: record.priority == null ? null : String(record.priority),
        assetId: text(record.assetId),
        assetType: text(record.assetType),
        reported: text(record.createdDate),
        live: record.live === true,
        // Said plainly, because it is the difference between "the work is here" and "the thing the
        // work is about is here".
        locatedVia: place.via,
      });
    }
  }
  return found;
}

/** Records an operator would still act on — anything a class has not marked as finished. */
const OPEN = /^(?!.*(closed|completed|resolved|cancelled|cleared|cleared)).+$/i;
export const isOpenRecord = record => Boolean(record?.status) && OPEN.test(record.status);

/**
 * Everything the drawn area contains, as one serializable object.
 *
 * No Cesium types cross this boundary: what comes out is what can be shown in a summary, sent with
 * a question, and asserted in a test.
 */
export function buildSpatialContext({ bounds, lines = [], liveEvents = [], assetEntries = [], maintenanceLookup = null, assetIndex = new Map(), selectedAt = null } = {}) {
  if (!isUsableBounds(bounds)) return null;
  const roadway = resolveRoadwayContext(bounds, lines);
  const events = findLiveEvents(bounds, liveEvents);
  const assets = findAssets(bounds, assetEntries);
  const maintenance = maintenanceLookup
    ? findMaintenance(bounds, maintenanceLookup, assetIndex)
    : Object.fromEntries(Object.values(MAINTENANCE_TYPES).map(key => [key, []]));
  return {
    selection: {
      type: 'RECTANGLE',
      bounds: { ...bounds },
      polygon: boundsToPolygon(bounds),
      center: boundsCenter(bounds),
      selectedAt: selectedAt ?? new Date().toISOString(),
    },
    roadway,
    liveEvents: events,
    assets,
    maintenance,
    totals: {
      events: Object.values(events).reduce((sum, list) => sum + list.length, 0),
      assets: assets.total,
      maintenance: Object.values(maintenance).reduce((sum, list) => sum + list.length, 0),
      openWorkOrders: maintenance.workOrders.filter(isOpenRecord).length,
      sections: roadway.segments.length,
    },
  };
}

export { EMPTY_EVENTS, EVENT_GROUPS };
