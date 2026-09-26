/**
 * FL511 corridor payload -> "SDNA Florida I595 Live Events" records.
 *
 * Pure: no network and no clock reads (only the memoised local corridor GeoJSON read by
 * eventEnrichment.mjs), so the AWS poller lambda can import it. Takes the normalized
 * payload from fl511Service and the records already in DataConnect, and returns only the records
 * that must be (re)loaded. Events that leave the feed are marked cleared, never deleted.
 */
import {
  LIVE_CLASS, PROJECT_CODE, completeRecord, dcSegmentCodeFor, diffRecords, liveClassDefinition,
} from './classes.mjs';
import { enrichEventFields, loadEnrichmentContext } from './eventEnrichment.mjs';
import EVENT_FIELDS from '../../config/liveDc/eventFields.json' with { type: 'json' };

export const TYPE_PRIORITY = Object.freeze(['INCIDENT', 'CLOSURE', 'DISABLED', 'CONSTRUCTION', 'CONGESTION']);

export const TYPE_LABELS = Object.freeze({ ...EVENT_FIELDS.typeLabels });

/** Attributes placed from the coordinates (with the prose's direction when there is one). */
export const POSITION_ATTRIBUTES = Object.freeze([
  'carriageway', 'direction', 'section_id', 'section_label', 'fdot_segment_id', 'segment ID', 'segment name',
]);

/** Attributes that come from the FL511 tooltip or from prose parsed out of it. */
export const DETAIL_ATTRIBUTES = Object.freeze([
  'name', 'description', 'title', 'severity', 'region', 'start_time', 'end_time', 'last_updated', 'comment', 'detour',
  ...POSITION_ATTRIBUTES,
  'lane_impact_label', 'blocked_lanes', 'full_closure', 'ramp_closure', 'shoulder_only', 'spatial_confidence',
]);
const POSITION_SET = new Set(POSITION_ATTRIBUTES);
/** Re-stamped on every write; updated_at falls back to last_seen_at when FL511 gives no last_updated. */
const VOLATILE_ATTRIBUTES = Object.freeze(['last_seen_at', 'updated_at']);

const iso = ms => new Date(ms).toISOString();
const round = (value, dp) => {
  const factor = 10 ** dp;
  return Number.isFinite(value) ? Math.round(value * factor) / factor : null;
};
const yesNo = flag => (flag ? 'Yes' : 'No');

// Curated list reads carry no geoDetails, so a read-back record usually has no geometry to re-send.
function pointOf(record) {
  if (record.geometry) return record.geometry;
  const lon = record.longitude ?? record.x_coordinates;
  const lat = record.latitude ?? record.y_coordinates;
  return Number.isFinite(lon) && Number.isFinite(lat) ? { type: 'Point', coordinates: [lon, lat] } : undefined;
}
const byKey = (a, b) => (a.keyInSource < b.keyInSource ? -1 : a.keyInSource > b.keyInSource ? 1 : 0);
const priorityOf = type => {
  const index = TYPE_PRIORITY.indexOf(type);
  return index === -1 ? TYPE_PRIORITY.length : index;
};

/** Keyed by FL511 itemId only: FL511 re-types an item (incident -> closure) without a new id. */
export function liveEventKey(event) {
  return `FL511-${String(event.rawSourceId)}`;
}

/**
 * @param {object} event normalizeEvent + attachDetails + enrichForLiveOps output
 * @param {{now:number, previous?:object|null, firstSeenAt?:string|null, enrichment?:object}} options
 */
export function mapEventToRecord(event, { now, previous = null, firstSeenAt = null, enrichment = loadEnrichmentContext() }) {
  const key = liveEventKey(event);
  const liveOps = event.liveOps ?? {};
  const type = event.type;
  const name = event.title || `${TYPE_LABELS[type] ?? type} on I-595`;
  const latitude = round(event.latitude, 7);
  const longitude = round(event.longitude, 7);
  // A secondary endpoint cannot be unset once written (numeric attributes under merge semantics).
  const secondaryLatitude = round(event.secondaryLatitude, 7) ?? previous?.secondary_latitude;
  const secondaryLongitude = round(event.secondaryLongitude, 7) ?? previous?.secondary_longitude;
  const segmentCode = dcSegmentCodeFor({ longitude, carriageway: liveOps.carriageway });

  const rec = {
    keyInSource: key,
    code: key,
    name,
    description: event.description || name,
    geometry: longitude != null && latitude != null ? { type: 'Point', coordinates: [longitude, latitude] } : null,
    event_id: event.id,
    event_type: type,
    fl511_item_id: String(event.rawSourceId),
    source: 'FL511',
    status: 'active',
    title: event.title,
    severity: event.severity,
    region: event.region,
    start_time: event.startTime,
    end_time: event.endTime,
    last_updated: event.lastUpdated,
    comment: event.comment,
    detour: event.detour,
    first_seen_at: previous?.first_seen_at || firstSeenAt || iso(now),
    last_seen_at: iso(now),
    // Explicit '' so a merge-semantics load of a reactivated event wipes the old value.
    cleared_at: '',
    latitude,
    longitude,
    secondary_latitude: secondaryLatitude,
    secondary_longitude: secondaryLongitude,
    nearest_facility: event.nearestFacility,
    nearest_facility_label: event.nearestFacilityLabel,
    distance_to_network_m: round(event.distanceToI595NetworkM, 1),
    fdot_segment_id: liveOps.segmentId ?? event.nearestSegmentId,
    'segment ID': segmentCode ?? '',
    'segment name': segmentCode ? `Segment_${segmentCode}` : '',
    carriageway: liveOps.carriageway,
    direction: liveOps.direction,
    section_id: liveOps.sectionId,
    section_label: liveOps.sectionLabel,
    lane_impact_label: liveOps.laneImpactLabel,
    spatial_confidence: liveOps.spatialMatch?.confidence,
    x_coordinates: longitude,
    y_coordinates: latitude,
    project: PROJECT_CODE,
  };

  const impact = liveOps.laneImpact;
  if (impact?.source === 'parsed') {
    if (Number.isFinite(impact.blockedLanes)) rec.blocked_lanes = String(impact.blockedLanes);
    rec.full_closure = yesNo(impact.fullClosure);
    rec.ramp_closure = yesNo(impact.rampClosure);
    rec.shoulder_only = yesNo(impact.shoulderOnly);
  }

  // A failed tooltip fetch must not flip a record back and forth between detailed and bare. Placement
  // is only carried with it while the event has not moved; otherwise it follows the new coordinates.
  if (event.detailsAvailable !== true && previous) {
    const samePlace = Number(previous.latitude) === latitude && Number(previous.longitude) === longitude;
    for (const attr of DETAIL_ATTRIBUTES) {
      if (samePlace || !POSITION_SET.has(attr)) rec[attr] = previous[attr] ?? '';
    }
  }

  // Derived from the final record, so carried-forward details derive the same values.
  return completeRecord(liveClassDefinition(LIVE_CLASS.EVENTS), { ...rec, ...enrichEventFields(rec, enrichment) });
}

/** Only a fully healthy LIVE poll is proof that a missing event has really gone. */
export function canClear(payload) {
  if (!payload || payload.sourceStatus !== 'LIVE') return false;
  const feeds = payload.diagnostics?.feeds;
  if (!feeds || typeof feeds !== 'object') return false;
  const entries = Object.values(feeds);
  return entries.length > 0 && entries.every(feed => !feed?.error);
}

const emptyStats = () => ({
  seen: 0, merged: 0, new: 0, updated: 0, heartbeat: 0, reactivated: 0, cleared: 0, unchanged: 0, clearingSuppressed: false,
});

/**
 * @param {{payload:object, existing:object[], now:number, heartbeatSeconds?:number, firstSeenHints?:Map<string,string>,
 *   enrichment?:object}} input
 * @returns {{skipped:boolean, reason:string|null, upserts:object[], state:object[], stats:object}}
 */
export function syncLiveEvents({
  payload, existing, now, heartbeatSeconds = 900, firstSeenHints = new Map(), enrichment = loadEnrichmentContext(),
}) {
  const existingByKey = new Map();
  for (const record of existing ?? []) {
    if (record?.keyInSource && !existingByKey.has(record.keyInSource)) existingByKey.set(record.keyInSource, record);
  }
  const stats = emptyStats();
  const skip = reason => ({ skipped: true, reason, upserts: [], state: [...existingByKey.values()].sort(byKey), stats });

  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.events)) return skip('invalid_payload');
  if (payload.sourceStatus !== 'LIVE') return skip(`source_${String(payload.sourceStatus).toLowerCase()}`);

  const kept = new Map();
  for (const event of payload.events) {
    const key = liveEventKey(event);
    const current = kept.get(key);
    if (!current) { kept.set(key, event); continue; }
    stats.merged++;
    const rank = priorityOf(event.type) - priorityOf(current.type);
    if (rank < 0 || (rank === 0 && String(event.id) < String(current.id))) kept.set(key, event);
  }
  stats.seen = kept.size;

  const upserts = [];
  for (const [key, event] of kept) {
    const previous = existingByKey.get(key) ?? null;
    const candidate = mapEventToRecord(event, { now, previous, firstSeenAt: firstSeenHints.get(key) ?? null, enrichment });
    if (!previous) {
      stats.new++;
      upserts.push(candidate);
    } else if (previous.status === 'cleared') {
      stats.reactivated++;
      upserts.push(candidate);
    } else if (diffRecords([candidate], [previous], { ignore: VOLATILE_ATTRIBUTES }).upserts.length > 0) {
      stats.updated++;
      upserts.push(candidate);
    } else if (heartbeatSeconds > 0 && !(now - Date.parse(previous.last_seen_at) < heartbeatSeconds * 1000)) {
      // A missing/unparsable last_seen_at also counts as due, so the record heals itself.
      stats.heartbeat++;
      upserts.push(candidate);
    } else {
      stats.unchanged++;
    }
  }

  const gone = [...existingByKey.values()].filter(record => record.status === 'active' && !kept.has(record.keyInSource));
  if (gone.length > 0) {
    if (canClear(payload)) {
      const def = liveClassDefinition(LIVE_CLASS.EVENTS);
      for (const previous of gone) {
        const cleared = { ...previous, geometry: pointOf(previous), status: 'cleared', cleared_at: iso(now) };
        upserts.push(completeRecord(def, { ...cleared, ...enrichEventFields(cleared, enrichment) }));
        stats.cleared++;
      }
    } else {
      stats.clearingSuppressed = true;
    }
  }

  upserts.sort(byKey);
  const state = new Map(existingByKey);
  for (const record of upserts) state.set(record.keyInSource, record);
  return { skipped: false, reason: null, upserts, state: [...state.values()].sort(byKey), stats };
}
