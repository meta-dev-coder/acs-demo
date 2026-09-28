/**
 * Extra "SDNA Florida I595 Live Events" fields derived from a Live Events record: FL511 times in
 * UTC, prose parsing, FDOT milepost, nearby CCTV cameras and the Live Ops impact level. A value
 * that cannot be derived is the literal "NA"; field_sources says where each value came from.
 *
 * Pure and deterministic given the record and the context; the only I/O is the memoised read of
 * two local GeoJSON files in loadEnrichmentContext(). No network.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversineMeters } from '../geo.mjs';
import { LIVE_CLASS, isHttpUrl, liveClassDefinition, toDcDateTime } from './classes.mjs';
import EVENT_FIELDS from '../../config/liveDc/eventFields.json' with { type: 'json' };
import { OPERATIONAL_IMPACT_WEIGHTS, OPERATIONAL_LEVELS, eventScore, levelFor } from '../../src/liveOps/operationalImpact.js';

export const NA = 'NA';
export const SNAPSHOT_PATH = '/api/i595/camera';
export const CAMERA_RADIUS_M = 2000;
export const PENDING_FIELDS = Object.freeze(EVENT_FIELDS.enrichmentFields.filter(entry => entry.pending).map(entry => entry.name));
export const ENRICHMENT_FIELDS = Object.freeze(EVENT_FIELDS.enrichmentFields.map(entry => entry.name));
export const SNAPSHOT_FIRST_FIELDS = Object.freeze(['snapshot_first_url', 'snapshot_first_taken_at', 'snapshot_first_camera_id']);
export const SNAPSHOT_CLEARED_FIELDS = Object.freeze(['snapshot_cleared_url', 'snapshot_cleared_taken_at', 'snapshot_cleared_camera_id']);
export const WEATHER_FIELDS = Object.freeze([
  'weather_at_event', 'weather_code', 'temperature_c', 'relative_humidity_pct', 'precipitation_mm', 'wind_speed_kmh',
  'wind_direction_deg', 'weather_observed_at', 'weather_source',
]);
/** Captured once (eventCapture.mjs) and then carried forward unchanged. */
export const STICKY_FIELDS = Object.freeze([...SNAPSHOT_FIRST_FIELDS, ...SNAPSHOT_CLEARED_FIELDS, ...WEATHER_FIELDS]);
export const CAPTURE_SOURCES = Object.freeze({
  ...Object.fromEntries([...SNAPSHOT_FIRST_FIELDS, ...SNAPSHOT_CLEARED_FIELDS, 'snapshot_archive_url'].map(name => [name, 'DIVAS'])),
  ...Object.fromEntries(WEATHER_FIELDS.map(name => [name, 'Open-Meteo'])),
});

const ATTRIBUTE_TYPES = new Map(liveClassDefinition(LIVE_CLASS.EVENTS).attributes.map(a => [a.name, a.type]));
const TEXT_TYPES = new Set(['String']);
const toNumber = value => (typeof value === 'number' ? value : value === '' || value == null ? NaN : Number(value));

/** A value in its DataConnect type (DateTime in whole seconds, URL absolute http(s)), or null when unset, "NA" or malformed. */
export function typedValue(name, value) {
  switch (ATTRIBUTE_TYPES.get(name)) {
    case 'DateTime': return toDcDateTime(value);
    case 'Integer': return Number.isInteger(toNumber(value)) ? toNumber(value) : null;
    case 'Decimal': return Number.isFinite(toNumber(value)) ? toNumber(value) : null;
    case 'URL': return isHttpUrl(value) ? value : null;
    default: return value === null || value === undefined || value === '' || value === NA ? null : String(value);
  }
}

/** The empty form of a field: "NA" for String, undefined (omitted, never sent) for URL, DateTime and numbers. */
const emptyValue = name => (TEXT_TYPES.has(ATTRIBUTE_TYPES.get(name) ?? 'String') ? NA : undefined);

const orderedSources = sources => JSON.stringify(Object.fromEntries(ENRICHMENT_FIELDS.map(name => [name, sources[name] ?? NA])));
const parseSources = text => {
  try {
    const parsed = JSON.parse(text ?? '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
};

/** Sets captured values (unset ones are skipped) on `record` in place and updates its field_sources. */
export function applyCaptured(record, fields) {
  const sources = parseSources(record.field_sources);
  for (const [name, value] of Object.entries(fields)) {
    const typed = typedValue(name, value);
    if (typed === null) continue;
    record[name] = typed;
    sources[name] = CAPTURE_SOURCES[name] ?? 'derived';
  }
  record.field_sources = orderedSources(sources);
  return record;
}

const NEW_YORK_LOCAL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true,
  timeZoneName: 'short',
});

/** "2026-09-26 12:26 AM EDT": an instant as America/New_York wall time; null when not an instant. */
export function newYorkLocalTime(value) {
  const instant = toDcDateTime(value);
  if (!instant) return null;
  const p = Object.fromEntries(NEW_YORK_LOCAL.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.dayPeriod.toUpperCase()} ${p.timeZoneName}`;
}

/** An http(s) base URL without a trailing slash, or '' when unusable. */
export function publicBaseUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '';
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch { return ''; }
}

const MONTHS = Object.freeze({ jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 });
const DISPLAY_TIME = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i;
const NEW_YORK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
});

/** Local New York wall time minus UTC, in ms, at the instant `utcMs`. */
function newYorkOffsetMs(utcMs) {
  const parts = Object.fromEntries(NEW_YORK.formatToParts(new Date(utcMs)).map(p => [p.type, Number(p.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - Math.floor(utcMs / 60000) * 60000;
}

/** FL511's "Sep 26 2026, 12:26 AM" (America/New_York, DST aware) or a zoned ISO string -> DataConnect DateTime (UTC, whole seconds); null otherwise. */
export function parseFl511Time(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const iso = toDcDateTime(text);
  if (iso) return iso;
  const match = DISPLAY_TIME.exec(text);
  if (!match) return null;
  const month = MONTHS[match[1].toLowerCase()];
  const [day, year, hour12, minute] = [match[2], match[3], match[4], match[5]].map(Number);
  if (month === undefined || hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (match[6].toLowerCase() === 'p' ? 12 : 0);
  const wall = Date.UTC(year, month, day, hour, minute);
  if (new Date(wall).getUTCDate() !== day) return null;
  let utc = wall - newYorkOffsetMs(wall);
  const corrected = newYorkOffsetMs(utc);
  if (corrected !== newYorkOffsetMs(wall)) utc = wall - corrected;
  return toDcDateTime(utc);
}

const squash = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const TIME_LIKE = /^\d{1,2}(:\d{2})?\s*[ap]\.?m\b/i;
const CROSS_STREET = /\b(?:at|beyond|near|before|past)\s+([^.;,()]+)/gi;

export function parseCrossStreet(description) {
  const text = squash(description).replace(/\blast updated at\b[^.]*\.?/gi, '');
  for (const match of text.matchAll(CROSS_STREET)) {
    const street = squash(match[1]);
    if (street && !TIME_LIKE.test(street)) return street;
  }
  return null;
}

const WORD_NUMBERS = Object.freeze({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 });
const VEHICLE_COUNT = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)[- ](?:vehicles?|cars?)\b/i;
const MULTI_VEHICLE = /\bmulti(?:ple)?[- ]?(?:vehicles?|cars?)\b/i;

export function parseVehiclesInvolved(text) {
  const source = squash(text);
  const count = VEHICLE_COUNT.exec(source);
  if (count) return String(WORD_NUMBERS[count[1].toLowerCase()] ?? Number(count[1]));
  return MULTI_VEHICLE.test(source) ? 'Multiple' : null;
}

const SUBTYPES = Object.freeze([
  [/\b(?:fire|burning|smoke)\b/i, 'Vehicle fire'],
  [/\binjur/i, 'Crash with injuries'],
  [/\b(?:rollover|overturned|rolled over)\b/i, 'Rollover crash'],
  [/\b(?:crash|collision|accident)\b/i, 'Crash'],
  [/\bdebris\b/i, 'Debris'],
  [/\b(?:disabled|stalled|broken[- ]down)\b/i, 'Disabled vehicle'],
  [/\b(?:flood\w*|standing water|high water)\b/i, 'Flooding'],
  [/\b(?:construction|work zone|road ?work|maintenance)\b/i, 'Construction'],
  [/\blane closure\b|\b(?:lanes?|ramp|road)\s+(?:is\s+|are\s+)?closed\b/i, 'Lane closure'],
  [/\b(?:congestion|heavy traffic|slow traffic|delays)\b/i, 'Congestion'],
]);

export function parseIncidentSubtype(text) {
  const source = squash(text);
  if (!source) return null;
  const vehicles = parseVehiclesInvolved(source);
  if (vehicles === 'Multiple' || Number(vehicles) >= 2) return 'Multi-vehicle crash';
  return SUBTYPES.find(([pattern]) => pattern.test(source))?.[1] ?? null;
}

/** Linear-referenced milepost of a point along an FDOT segment (begin_post at the first vertex). */
export function milepostAt({ longitude, latitude } = {}, segment) {
  const coords = segment?.coordinates;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || !Array.isArray(coords) || coords.length < 2) return null;
  const scale = Math.cos(latitude * Math.PI / 180);
  let total = 0, best = { distance: Infinity, along: 0 };
  for (let i = 0; i < coords.length - 1; i++) {
    const [ax, ay] = [coords[i][0] * scale, coords[i][1]], [bx, by] = [coords[i + 1][0] * scale, coords[i + 1][1]];
    const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy);
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((longitude * scale - ax) * dx + (latitude - ay) * dy) / (length * length)));
    const distance = Math.hypot(longitude * scale - (ax + t * dx), latitude - (ay + t * dy));
    if (distance < best.distance) best = { distance, along: total + t * length };
    total += length;
  }
  if (!(total > 0)) return null;
  return segment.beginPost + (best.along / total) * (segment.endPost - segment.beginPost);
}

const CAMERA_DIRECTION = Object.freeze({ EB: 'E', WB: 'W' });

/** Cameras within `maxDistanceM`, same direction first, then nearest; at most `limit`. */
export function selectCameras({ longitude, latitude, direction } = {}, cameras, { maxDistanceM = CAMERA_RADIUS_M, limit = 3 } = {}) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return [];
  const wanted = CAMERA_DIRECTION[direction] ?? null;
  return (cameras ?? [])
    .map(camera => ({ camera, distance: haversineMeters(longitude, latitude, camera.longitude, camera.latitude) }))
    .filter(({ distance }) => distance <= maxDistanceM)
    .map(entry => ({ ...entry, rank: wanted && entry.camera.direction !== wanted ? 1 : 0 }))
    .sort((a, b) => a.rank - b.rank || a.distance - b.distance || (a.camera.cameraId < b.camera.cameraId ? -1 : 1))
    .slice(0, limit)
    .map(({ camera, distance }) => ({ ...camera, distanceM: Math.round(distance) }));
}

const yes = value => String(value ?? '').toLowerCase() === 'yes';
const filled = value => value !== undefined && value !== null && value !== '';

/** The Live Ops per-event operational level, from the record's own type, severity and lane flags. */
export function impactLevel(record) {
  const type = record?.event_type;
  if (!OPERATIONAL_IMPACT_WEIGHTS[type]) return null;
  const parsed = ['full_closure', 'ramp_closure', 'shoulder_only', 'blocked_lanes'].some(name => filled(record[name]));
  const blocked = Number(record.blocked_lanes);
  const laneImpact = parsed
    ? {
      source: 'parsed', blockedLanes: Number.isFinite(blocked) && filled(record.blocked_lanes) ? blocked : null,
      fullClosure: yes(record.full_closure), rampClosure: yes(record.ramp_closure), shoulderOnly: yes(record.shoulder_only),
    }
    : { source: 'none' };
  const id = levelFor(eventScore({ type, severity: record.severity, liveOps: { laneImpact } }));
  return OPERATIONAL_LEVELS.find(level => level.id === id)?.label ?? null;
}

const numberOr = value => (value === '' || value == null ? NaN : Number(value));
/** The record's position as numbers (NaN when missing), from longitude/latitude or x/y_coordinates. */
export const pointOf = record => ({
  longitude: numberOr(record.longitude ?? record.x_coordinates), latitude: numberOr(record.latitude ?? record.y_coordinates),
});

/**
 * Every ENRICHMENT_FIELDS value plus field_sources, in a fixed order. A String is "NA" when unavailable;
 * URL, DateTime and numeric fields are then undefined (omitted). Captured fields (STICKY_FIELDS) are
 * carried from `record` as they are.
 */
export function enrichEventFields(record, context = loadEnrichmentContext(), { publicApiBase = '' } = {}) {
  const values = {}, sources = {};
  const put = (name, value, source) => {
    const typed = typedValue(name, value);
    values[name] = typed === null ? emptyValue(name) : typed;
    sources[name] = typed === null ? NA : source;
  };
  const timed = (name, raw, fallback) => {
    const parsed = parseFl511Time(raw);
    if (parsed) put(name, parsed, 'FL511');
    else put(name, parseFl511Time(fallback), 'derived');
  };

  timed('reported_at', record.start_time, record.first_seen_at);
  timed('updated_at', record.last_updated, record.last_seen_at);
  put('incident_time_local', newYorkLocalTime(values.reported_at), 'derived');
  put('first_seen_at_dt', record.first_seen_at, 'derived');
  put('cleared_at_dt', record.status === 'cleared' ? record.cleared_at : null, 'derived');
  const point = pointOf(record);
  const segment = filled(record.fdot_segment_id) ? context.segments.find(s => s.segmentId === record.fdot_segment_id) : null;
  const milepost = milepostAt(point, segment);
  put('milepost', milepost == null ? null : milepost.toFixed(1), 'derived');
  const prose = [record.title, record.description].filter(filled).join('. ');
  put('cross_street', parseCrossStreet(record.description), 'derived');
  put('incident_subtype', parseIncidentSubtype(prose), 'derived');
  put('vehicles_involved', parseVehiclesInvolved(prose), 'derived');
  put('impact_level', impactLevel(record), 'derived');
  put('est_clearance_at', parseFl511Time(record.end_time), 'FL511');
  const cameras = selectCameras({ ...point, direction: record.direction }, context.cameras);
  const primary = cameras[0];
  put('primary_camera_id', primary?.cameraId, 'derived');
  put('nearby_camera_ids', cameras.map(c => `${c.cameraId}@${c.distanceM}m`).join(','), 'derived');
  const snapshotPath = primary?.divasChanId ? `${SNAPSHOT_PATH}/${encodeURIComponent(primary.divasChanId)}/snapshot` : null;
  put('camera_snapshot_url', snapshotPath && `${publicBaseUrl(publicApiBase)}${snapshotPath}`, 'derived');
  for (const name of STICKY_FIELDS) put(name, record[name], CAPTURE_SOURCES[name]);
  put('snapshot_archive_url', record.snapshot_first_url, CAPTURE_SOURCES.snapshot_archive_url);
  for (const name of PENDING_FIELDS) put(name, null, NA);

  const ordered = Object.fromEntries(ENRICHMENT_FIELDS.map(name => [name, Object.hasOwn(values, name) ? values[name] : emptyValue(name)]));
  return { ...ordered, field_sources: orderedSources(sources) };
}

/** LIVE_DC_DATA_DIR lets the bundled poller lambda point at its own copy of public/data. */
export const enrichmentDataPath = (name, env = process.env) => (env.LIVE_DC_DATA_DIR
  ? join(env.LIVE_DC_DATA_DIR, name)
  : fileURLToPath(new URL(`../../public/data/${name}`, import.meta.url)));
const readGeoJson = name => JSON.parse(readFileSync(enrichmentDataPath(name), 'utf8'));
let defaultContext = null;

/** Corridor cameras and FDOT traffic segments from public/data, read once. */
export function loadEnrichmentContext() {
  if (defaultContext) return defaultContext;
  const cameras = readGeoJson('i595_corridor_cameras.geojson').features
    .filter(f => f.geometry?.type === 'Point' && f.properties?.camera_id != null)
    .map(({ geometry: { coordinates: [longitude, latitude] }, properties: p }) => Object.freeze({
      cameraId: String(p.camera_id), divasChanId: p.divas_chan_id == null ? null : String(p.divas_chan_id),
      direction: p.direction ?? null, longitude, latitude,
    }));
  const segments = readGeoJson('i595_fdot_traffic_segments.geojson').features
    .filter(f => f.geometry?.type === 'LineString' && f.properties?.segment_id)
    .map(({ geometry, properties: p }) => Object.freeze({
      segmentId: String(p.segment_id), beginPost: Number(p.begin_post), endPost: Number(p.end_post), coordinates: geometry.coordinates,
    }));
  defaultContext = Object.freeze({ cameras: Object.freeze(cameras), segments: Object.freeze(segments) });
  return defaultContext;
}
