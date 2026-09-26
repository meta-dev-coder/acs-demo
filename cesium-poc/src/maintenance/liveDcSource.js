/**
 * The "SDNA Florida I595 Live *" DataConnect classes, read through this app's own /api/live-dc proxy
 * (server/liveDc/liveReadApi.mjs) and normalised into the same record shapes maintenanceRecords.js
 * produces for the historical classes, flagged `live: true`.
 *
 * On when `?live=1` or `VITE_LIVE_DC=true`, or when the session reads DataConnect
 * (`?data=dataconnect` / `VITE_DATA_SOURCE=dataconnect`), or in dev. `?live=0` / `VITE_LIVE_DC=false`
 * turn it off. The browser never holds a token.
 */
import {
  MAINTENANCE_TYPES, assetKey, attributesOf, field, normalizeInspection, normalizeTask, normalizeTicket, normalizeWorkOrder,
} from './maintenanceRecords.js';
import EVENT_FIELDS from '../../config/liveDc/eventFields.json' with { type: 'json' };

const BASE = '/api/live-dc';
export const LIVE_SOURCE_LABEL = 'Live DataConnect';
export const LIVE_REFRESH_MS = 60_000;
/** Cleared events stay listed this long after they leave the FL511 feed. */
export const CLEARED_WINDOW_MS = 6 * 60 * 60 * 1000;
export const LIVE_TYPES = Object.freeze({ ASSET_STATUS: 'ASSET_STATUS' });

export const LIVE_DC_CLASSES = Object.freeze([
  Object.freeze({ key: 'EVENTS', className: 'SDNA Florida I595 Live Events', maintenanceKey: 'incidents' }),
  Object.freeze({ key: 'TICKETS', className: 'SDNA Florida I595 Live Tickets', maintenanceKey: 'tickets' }),
  Object.freeze({ key: 'TASKS', className: 'SDNA Florida I595 Live Tasks', maintenanceKey: 'tasks' }),
  Object.freeze({ key: 'WORK_ORDERS', className: 'SDNA Florida I595 Live Work Orders', maintenanceKey: 'workOrders' }),
  Object.freeze({ key: 'INSPECTIONS', className: 'SDNA Florida I595 Live Inspections', maintenanceKey: 'inspections' }),
  Object.freeze({ key: 'ASSET_STATUS', className: 'SDNA Florida I595 Live Asset Status', maintenanceKey: 'damagedAssets' }),
]);

/** The SDNA enrichment attributes of Live Events, shared with the server (config/liveDc/eventFields.json); "NA" when absent. */
export const LIVE_EVENT_FIELDS = Object.freeze(EVENT_FIELDS.enrichmentFields.map(entry => entry.name));
const NA = 'NA';

export const LIVE_EVENT_TYPE_LABELS = Object.freeze({ ...EVENT_FIELDS.typeLabels });
const TYPE_LABELS = LIVE_EVENT_TYPE_LABELS;

const flag = value => (/^(1|true|yes|on)$/i.test(value ?? '') ? true : /^(0|false|no|off)$/i.test(value ?? '') ? false : null);

export function liveDcEnabled({ search = globalThis.location?.search ?? '', env = import.meta.env ?? {} } = {}) {
  const params = new URLSearchParams(search);
  const asked = params.has('live') ? flag(params.get('live')) : null;
  if (asked !== null) return asked;
  const configured = flag(env.VITE_LIVE_DC);
  if (configured !== null) return configured;
  if (params.get('data') === 'dataconnect' || env.VITE_DATA_SOURCE === 'dataconnect') return true;
  return Boolean(env.DEV);
}

const text = value => {
  const string = value == null ? '' : String(value).trim();
  return string && string.toUpperCase() !== 'N/A' ? string : null;
};
const number = value => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
const capitalise = value => (value ? value.charAt(0).toUpperCase() + value.slice(1) : null);

function position(row, ...pairs) {
  for (const [lonKey, latKey] of pairs) {
    const longitude = number(field(row, lonKey)), latitude = number(field(row, latKey));
    if (longitude != null && latitude != null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      return { longitude, latitude, locationSource: 'record' };
    }
  }
  return { longitude: null, latitude: null, locationSource: null };
}

function liveRecord({ id, type, title, status, priority = null, assetId = null, assetType = null, systemClass = null,
  segmentName = null, createdDate = null, closedDate = null, description = null, related = {}, coordinates, raw }) {
  return Object.freeze({
    id: String(id), sourceId: String(id), type, title: title ?? String(id), status, priority, assetId, assetType, systemClass,
    segmentName, createdDate, closedDate, description, related: Object.freeze({ ...related }),
    latitude: coordinates.latitude, longitude: coordinates.longitude, locationSource: coordinates.locationSource,
    raw, live: true, sourceLabel: LIVE_SOURCE_LABEL,
  });
}

const idOf = row => assetKey(field(row, 'code')) ?? assetKey(row?.keyInSource);

function fieldSources(row) {
  try {
    const parsed = JSON.parse(field(row, 'field_sources') ?? '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.freeze({ ...parsed }) : Object.freeze({});
  } catch { return Object.freeze({}); }
}

function sdnaFields(row) {
  return Object.freeze({
    ...Object.fromEntries(LIVE_EVENT_FIELDS.map(name => [name, text(field(row, name)) ?? NA])),
    fieldSources: fieldSources(row),
  });
}

const available = value => (value && value !== NA ? value : null);

function normalizeLiveEvent(row) {
  const eventType = text(field(row, 'event_type'));
  const sdna = sdnaFields(row);
  return liveRecord({
    id: idOf(row), type: MAINTENANCE_TYPES.INCIDENT,
    title: text(field(row, 'name', 'title')) ?? TYPE_LABELS[eventType] ?? eventType,
    status: capitalise(text(field(row, 'status'))),
    priority: text(field(row, 'severity')),
    segmentName: text(field(row, 'section_label', 'segment name', 'nearest_facility_label')),
    createdDate: text(field(row, 'start_time', 'first_seen_at')),
    closedDate: text(field(row, 'cleared_at')),
    description: text(field(row, 'description')),
    related: {
      eventType, eventLabel: TYPE_LABELS[eventType] ?? eventType, laneClosure: text(field(row, 'full_closure')),
      laneImpact: text(field(row, 'lane_impact_label')), fl511ItemId: text(field(row, 'fl511_item_id')),
      lastSeenAt: text(field(row, 'last_seen_at')),
      injuries: sdna.injuries, fatalities: sdna.fatalities,
      cameraId: available(sdna.primary_camera_id), cameraSnapshotUrl: available(sdna.camera_snapshot_url),
      sdna,
    },
    coordinates: position(row, ['longitude', 'latitude'], ['x_coordinates', 'y_coordinates']),
    raw: row,
  });
}

function normalizeLiveAssetStatus(row) {
  return liveRecord({
    id: idOf(row), type: LIVE_TYPES.ASSET_STATUS,
    title: text(field(row, 'asset_category')) ?? text(field(row, 'name')),
    status: text(field(row, 'status')),
    assetId: assetKey(field(row, 'asset_id')), assetType: text(field(row, 'asset_category')),
    systemClass: text(field(row, 'system class')), createdDate: text(field(row, 'damaged_at', 'created_at')),
    description: text(field(row, 'description')),
    related: { inspectionId: text(field(row, 'source_inspection_id')), eventId: text(field(row, 'source_event_id')) },
    coordinates: position(row, ['x_coordinates', 'y_coordinates']),
    raw: row,
  });
}

/** A historical mapping, flagged live and linked to its event; a record with no position of its own takes x/y_coordinates. */
const viaHistorical = normalize => row => {
  const item = normalize(row);
  const own = Number.isFinite(item.latitude) ? null : position(row, ['x_coordinates', 'y_coordinates']);
  return Object.freeze({
    ...item,
    ...(own?.locationSource ? own : {}),
    related: Object.freeze({ ...item.related, eventId: text(field(row, 'source_event_id')) }),
    live: true, sourceLabel: LIVE_SOURCE_LABEL,
  });
};

const NORMALIZERS = Object.freeze({
  incidents: normalizeLiveEvent,
  tickets: viaHistorical(normalizeTicket),
  tasks: viaHistorical(normalizeTask),
  workOrders: viaHistorical(normalizeWorkOrder),
  inspections: viaHistorical(normalizeInspection),
  damagedAssets: normalizeLiveAssetStatus,
});

function recent(row, now, windowMs) {
  if (String(field(row, 'status') ?? '').toLowerCase() !== 'cleared') return true;
  const cleared = Date.parse(field(row, 'cleared_at') ?? '');
  return Number.isFinite(cleared) && now - cleared <= windowMs;
}

/** Rows of one Live class → records. Long-cleared events and rows with no identifier are dropped. */
export function normalizeLiveRows(maintenanceKey, rows, { now = Date.now(), clearedWindowMs = CLEARED_WINDOW_MS } = {}) {
  const normalize = NORMALIZERS[maintenanceKey];
  if (!normalize) throw new Error(`No Live normalizer for "${maintenanceKey}"`);
  return (rows ?? [])
    .filter(row => idOf(row) && Object.keys(attributesOf(row)).length)
    .filter(row => maintenanceKey !== 'incidents' || recent(row, now, clearedWindowMs))
    .map(normalize);
}

/** Live first, then the historical list untouched; a live id that clashes is suffixed rather than replacing. */
export function mergeLiveRecords(historical, live) {
  if (!live?.length) return historical;
  const used = new Set(historical.map(item => item.id));
  const renamed = live.map(item => {
    if (!used.has(item.id)) { used.add(item.id); return item; }
    let id = `${item.id} (live)`;
    for (let n = 2; used.has(id); n++) id = `${item.id} (live ${n})`;
    used.add(id);
    return Object.freeze({ ...item, id });
  });
  return [...renamed, ...historical];
}

export function liveCardNote(records, note) {
  const count = (records ?? []).filter(item => item.live).length;
  if (!count) return note ?? null;
  return note ? `${count} live · ${note}` : `${count} live`;
}

async function request(fetchImpl, path, options) {
  let response;
  try { response = await fetchImpl(`${BASE}${path}`, options); } catch { throw new Error('Live DataConnect is unreachable.'); }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `Live DataConnect returned ${response.status}.`);
  return body;
}

const readPage = (fetchImpl, id, body) => request(fetchImpl, `/class/${encodeURIComponent(id)}/curated-data`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

/** Every page of one filtered read; `enough(batch)` ends it early (not a truncation). */
async function readRows(fetchImpl, id, pageSize, maxPages, { filters = [], sort, enough = () => false } = {}) {
  const rows = [];
  let total = 0, done = false;
  // Paged by totalCount, not by a short page: the server may cap the page size below the one asked for.
  for (let page = 0; page < maxPages; page++) {
    const payload = await readPage(fetchImpl, id, { page, pageSize, filters, ...(sort ? { sort } : {}) });
    const batch = payload?.data ?? [];
    rows.push(...batch);
    total = Number(payload?.totalCount ?? rows.length);
    if (!batch.length || rows.length >= total || enough(batch)) { done = true; break; }
  }
  return { rows, truncated: !done && rows.length < total ? `Read ${rows.length} of ${total} rows` : null };
}

const ACTIVE_EVENTS = Object.freeze([{ field: 'attributes.status', operator: 'equals', value: 'active' }]);
const CLEARED_EVENTS = Object.freeze([{ field: 'attributes.status', operator: 'equals', value: 'cleared' }]);
const NEWEST_CLEARED_FIRST = Object.freeze({ field: 'attributes.cleared_at', direction: 'desc' });

/**
 * Live Events without the whole history: the active rows, then cleared rows newest-first until a page
 * reaches past the window. Curated-data filters are AND-only and cleared_at is a String attribute, so
 * the window is a sort, not a datetime filter; normalizeLiveRows still applies it exactly.
 */
async function readEvents(fetchImpl, id, pageSize, maxPages, now) {
  const since = now - CLEARED_WINDOW_MS;
  const active = await readRows(fetchImpl, id, pageSize, maxPages, { filters: ACTIVE_EVENTS });
  const cleared = await readRows(fetchImpl, id, pageSize, maxPages, {
    filters: CLEARED_EVENTS, sort: NEWEST_CLEARED_FIRST,
    enough: batch => Date.parse(field(batch.at(-1), 'cleared_at') ?? '') < since,
  });
  return { rows: [...active.rows, ...cleared.rows], truncated: active.truncated ?? cleared.truncated };
}

async function readClass(fetchImpl, entry, id, { pageSize, maxPages, now }) {
  return entry.key === 'EVENTS' ? readEvents(fetchImpl, id, pageSize, maxPages, now) : readRows(fetchImpl, id, pageSize, maxPages);
}

/**
 * One read of every Live class. `unavailable` carries the reason when /api/live-dc itself failed.
 * @returns {Promise<{byKey: Record<string, object[]>, errors: Record<string, string>, unavailable?: string}>}
 */
export async function fetchLiveDc({ fetchImpl = globalThis.fetch, now = Date.now(), pageSize = 500, maxPages = 50 } = {}) {
  const byKey = {}, errors = {};
  let classes;
  try {
    classes = (await request(fetchImpl, '/classes', { method: 'GET' }))?.classes ?? [];
  } catch (error) {
    for (const entry of LIVE_DC_CLASSES) errors[entry.maintenanceKey] = error.message;
    return { byKey, errors, unavailable: error.message };
  }
  await Promise.all(LIVE_DC_CLASSES.map(async entry => {
    const found = classes.find(c => c.className === entry.className);
    if (!found) { errors[entry.maintenanceKey] = `${entry.className} not found`; return; }
    try {
      const { rows, truncated } = await readClass(fetchImpl, entry, found.id, { pageSize, maxPages, now });
      byKey[entry.maintenanceKey] = normalizeLiveRows(entry.maintenanceKey, rows, { now });
      if (truncated) errors[entry.maintenanceKey] = truncated;
    } catch (error) {
      errors[entry.maintenanceKey] = error.message;
    }
  }));
  return { byKey, errors };
}

/**
 * Whether one fetchLiveDc result reached DataConnect: null before the first read, not connected when
 * the proxy failed or no Live class could be read, connected otherwise.
 */
export function liveDcConnection(result) {
  if (!result) return null;
  if (result.unavailable) return { connected: false, reason: result.unavailable };
  const failed = Object.values(result.errors ?? {});
  if (!Object.keys(result.byKey ?? {}).length && failed.length) return { connected: false, reason: failed[0] };
  return { connected: true, reason: null };
}

/** Polls the Live classes every `intervalMs`; reads never overlap. A failed tick (onUpdate included) goes to `onError`. */
export function createLiveDcFeed({ fetchImpl = globalThis.fetch, intervalMs = LIVE_REFRESH_MS, onUpdate, onError = () => {}, now = Date.now,
  setInterval: every = globalThis.setInterval, clearInterval: cancel = globalThis.clearInterval } = {}) {
  let timer = null, running = null;
  const refresh = () => {
    running ??= fetchLiveDc({ fetchImpl: (...args) => fetchImpl(...args), now: now() })
      .then(result => { onUpdate?.(result); return result; })
      .finally(() => { running = null; });
    return running;
  };
  return {
    refresh,
    async start() {
      if (timer === null) timer = every(() => refresh().catch(onError), intervalMs);
      return refresh();
    },
    stop() { if (timer !== null) cancel(timer); timer = null; },
  };
}
