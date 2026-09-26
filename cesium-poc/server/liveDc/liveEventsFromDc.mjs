/**
 * "SDNA Florida I595 Live Events" rows -> the event objects /api/i595/live-events serves, so Traffic,
 * Safety and Live Ops can read DataConnect without a second event shape.
 *
 * The rows carry FL511's coordinates and prose, so the corridor association and the Live Ops block
 * are rebuilt with the same functions the direct feed uses (normalizeEvent, enrichForLiveOps)
 * rather than trusted from stored copies. Only status=active rows are events; cleared ones count
 * for nothing.
 */
import { EVENT_TYPES, enrichForLiveOps, normalizeEvent } from '../liveEvents.mjs';
import { LIVE_CLASS } from './classes.mjs';
import { ENRICHMENT_FIELDS, NA } from './eventEnrichment.mjs';

export const DC_SOURCE = 'DataConnect';
export const DC_LIVE_EVENTS_LABEL = 'FL511 via DataConnect';
/** Slack past the sync heartbeat (LIVE_DC_HEARTBEAT_SECONDS) before an unchanged active record means the sync stopped. */
export const DC_STALE_MARGIN_SECONDS = 300;
export const DC_DEFAULT_HEARTBEAT_SECONDS = 900;
/**
 * The sync re-stamps every active record at least every `heartbeatSeconds`, so an active record older
 * than heartbeat + margin proves the sync has stopped. With heartbeat 0 an unchanged record is never
 * re-stamped and no sync status is readable here, so age alone proves nothing: null (never STALE).
 */
export const liveDcStaleAfterSeconds = (heartbeatSeconds = DC_DEFAULT_HEARTBEAT_SECONDS) =>
  (heartbeatSeconds > 0 ? heartbeatSeconds + DC_STALE_MARGIN_SECONDS : null);
export const DC_STALE_AFTER_SECONDS = liveDcStaleAfterSeconds(DC_DEFAULT_HEARTBEAT_SECONDS);

const attributesOf = row => (row?.attributes && typeof row.attributes === 'object' ? row.attributes : row ?? {});
const text = value => {
  const string = value == null ? '' : String(value).trim();
  return string || undefined;
};
const number = value => (value == null || value === '' || !Number.isFinite(Number(value)) ? undefined : Number(value));
const time = value => {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
};
/** The FL511 detail rows the sync keeps, under FL511's own labels; unmapped rows are not stored. */
const DETAIL_LABELS = Object.freeze([
  ['Severity', 'severity'], ['Region', 'region'], ['Start Time', 'start_time'], ['End Time', 'end_time'],
  ['Last Updated', 'last_updated'], ['Comment', 'comment'], ['Detour', 'detour'],
]);
const isActive = row => String(attributesOf(row).status ?? '').toLowerCase() === 'active';
const parsedSources = value => {
  try {
    const parsed = JSON.parse(value ?? '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
};

/** The SDNA enrichment fields as stored (snake_case, "NA" when absent) plus the parsed field_sources. */
export function sdnaFieldsOf(attributes) {
  return {
    ...Object.fromEntries(ENRICHMENT_FIELDS.map(name => [name, text(attributes[name]) ?? NA])),
    fieldSources: parsedSources(attributes.field_sources),
  };
}

/** One Live Events row -> a direct-feed event, or null when it is cleared, untyped, unplaceable or outside `bufferMeters`. */
export function liveDcRowToEvent(row, network, options = {}) {
  return convertRow(row, network, options).event;
}

/** `{event}` on success, else `{event: null, outsideBuffer}` saying whether only the corridor buffer rejected it. */
function convertRow(row, network, { bufferMeters = Infinity, segmentToleranceMeters } = {}) {
  const none = { event: null, outsideBuffer: false };
  if (!isActive(row)) return none;
  const a = attributesOf(row);
  const type = text(a.event_type);
  const latitude = number(a.latitude ?? a.y_coordinates), longitude = number(a.longitude ?? a.x_coordinates);
  const itemId = text(a.fl511_item_id) ?? text(row.keyInSource)?.replace(/^FL511-/, '');
  if (!EVENT_TYPES[type] || latitude == null || longitude == null || !itemId) return none;
  const secondaryLatitude = number(a.secondary_latitude), secondaryLongitude = number(a.secondary_longitude);
  const title = text(a.title);
  // The sync fills an absent description with the record name; that is not FL511's prose.
  const description = text(a.description) !== text(a.name) ? text(a.description) : undefined;

  const base = normalizeEvent(
    { itemId, latitude, longitude, secondaryLatitude, secondaryLongitude, title },
    type, network, { bufferMeters: bufferMeters ?? Infinity, segmentToleranceMeters },
  );
  if (!base) return { event: null, outsideBuffer: true };
  const details = {
    description,
    severity: text(a.severity), region: text(a.region), startTime: text(a.start_time), endTime: text(a.end_time),
    lastUpdated: text(a.last_updated), comment: text(a.comment), detour: text(a.detour),
  };
  const event = {
    ...base,
    id: text(a.event_id) ?? base.id,
    source: DC_LIVE_EVENTS_LABEL,
    ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)),
    detailsAvailable: Boolean(title || details.description),
    detailFields: DETAIL_LABELS.filter(([, name]) => text(a[name])).map(([label, name]) => ({ label, value: text(a[name]) })),
    dataConnect: {
      keyInSource: text(row.keyInSource) ?? text(a.code), status: 'active',
      firstSeenAt: text(a.first_seen_at) ?? null, lastSeenAt: text(a.last_seen_at) ?? null,
    },
    // Only the DataConnect source has these; the direct-feed fields above are unchanged.
    sdna: sdnaFieldsOf(a),
  };
  return { event: enrichForLiveOps(event, network, { sectionToleranceMeters: segmentToleranceMeters }), outsideBuffer: false };
}

const countsOf = events => {
  const of = type => events.filter(event => event.type === type).length;
  return {
    total: events.length, incidents: of(EVENT_TYPES.INCIDENT), closures: of(EVENT_TYPES.CLOSURE),
    construction: of(EVENT_TYPES.CONSTRUCTION), congestion: of(EVENT_TYPES.CONGESTION), disabledVehicles: of(EVENT_TYPES.DISABLED),
  };
};

/** Every Live Events row -> the /api/i595/live-events payload, labelled as DataConnect. */
export function liveDcEventsPayload(rows, network, {
  now = Date.now(), bufferMeters, segmentToleranceMeters, refreshSeconds = 60, staleAfterSeconds = DC_STALE_AFTER_SECONDS, totalRecords,
} = {}) {
  const all = rows ?? [];
  const active = all.filter(isActive);
  const records = Math.max(totalRecords ?? all.length, active.length);
  // Clipped to the corridor buffer exactly as the direct feed is.
  const converted = active.map(row => convertRow(row, network, { bufferMeters, segmentToleranceMeters }));
  const outsideBuffer = converted.filter(result => result.outsideBuffer).length;
  const events = converted.map(result => result.event).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
  // Freshness is proven only by active records: the sync writes nothing while the corridor is quiet.
  const newest = Math.max(-Infinity, ...active.map(row => time(attributesOf(row).last_seen_at)).filter(ms => ms != null));
  const at = Number.isFinite(newest) ? newest : null;
  const ageSeconds = at == null ? null : Math.round((now - at) / 1000);
  const stale = ageSeconds != null && staleAfterSeconds != null && ageSeconds > staleAfterSeconds;
  const stamp = at == null ? null : new Date(at).toISOString();
  return {
    source: DC_SOURCE,
    sourceLabel: DC_LIVE_EVENTS_LABEL,
    sourceStatus: stale ? 'STALE' : 'LIVE',
    lastUpdated: stamp,
    lastSuccessfulUpdate: stamp,
    dataFreshness: { ageSeconds, refreshSeconds, staleAfterSeconds },
    bufferMeters,
    segmentToleranceMeters,
    counts: countsOf(events),
    events,
    diagnostics: {
      lastError: null,
      dataConnect: {
        className: LIVE_CLASS.EVENTS, records, active: active.length, cleared: records - active.length,
        skipped: active.length - events.length - outsideBuffer, outsideBuffer,
      },
    },
  };
}

export const ACTIVE_FILTER = Object.freeze({ field: 'attributes.status', operator: 'equals', value: 'active' });
/** Browser tabs poll every refresh; this many ms of reuse keeps N tabs to one upstream read. */
export const DC_EVENTS_CACHE_MS = 20_000;
const rowCache = new WeakMap();

async function fetchActiveRows(readApi, { pageSize, maxPages, logger }) {
  const target = (await readApi.liveClasses()).find(entry => entry.className === LIVE_CLASS.EVENTS);
  if (!target) throw new Error(`${LIVE_CLASS.EVENTS} not found`);
  // Record count for diagnostics; never left unhandled.
  const everything = readApi.curatedData(target.id, { page: 0, pageSize: 1 }).then(result => ({ result }), error => ({ error }));
  const rows = [];
  let truncated = false, total = NaN;
  for (let page = 0; ; page++) {
    if (page >= maxPages) { truncated = rows.length < total; break; }
    const { data, totalCount } = await readApi.curatedData(target.id, { page, pageSize, filters: [ACTIVE_FILTER] });
    rows.push(...data);
    total = totalCount == null || totalCount === '' ? NaN : Number(totalCount);
    // A server may cap pageSize below the request: only totalCount says when the read is done.
    if (!data.length || (Number.isFinite(total) ? rows.length >= total : data.length < pageSize)) break;
  }
  const counted = await everything;
  if (counted.error) throw counted.error;
  const totalRecords = Number(counted.result?.totalCount);
  if (truncated) logger.warn?.(`Live events: DataConnect read truncated at ${rows.length} of ${total} active records (maxPages=${maxPages})`);
  return { rows, totalRecords: Number.isFinite(totalRecords) ? totalRecords : undefined, truncated, total };
}

/**
 * Read the active Live Events records through the in-process read proxy (liveReadApi.mjs), shared
 * across callers for `cacheMs`. An empty class is a live zero. Throws when DataConnect or the class
 * is unavailable; the caller answers UNAVAILABLE and never substitutes the direct feed.
 */
/** The /api/i595/live-events shape for "DataConnect was asked for and could not answer". */
export function liveDcUnavailablePayload(reason, { bufferMeters } = {}) {
  return {
    source: DC_SOURCE, sourceStatus: 'UNAVAILABLE', lastUpdated: null, lastSuccessfulUpdate: null, bufferMeters,
    counts: { total: 0, incidents: 0, closures: 0, construction: 0, congestion: 0, disabledVehicles: 0 }, events: [],
    diagnostics: { lastError: reason, dataConnect: { className: LIVE_CLASS.EVENTS } },
  };
}

export async function readLiveDcEvents({
  readApi, network, config, now = Date.now(), pageSize = 500, maxPages = 50, cacheMs = DC_EVENTS_CACHE_MS, clock = Date.now,
  logger = console,
}) {
  let entry = rowCache.get(readApi);
  if (!entry || (entry.at != null && clock() - entry.at >= cacheMs)) {
    entry = { at: null, read: fetchActiveRows(readApi, { pageSize, maxPages, logger }) };
    rowCache.set(readApi, entry);
    entry.read.then(() => { entry.at = clock(); }, () => { if (rowCache.get(readApi) === entry) rowCache.delete(readApi); });
  }
  const { rows, totalRecords, truncated, total } = await entry.read;
  const payload = liveDcEventsPayload(rows, network, {
    now, bufferMeters: config.bufferMeters, segmentToleranceMeters: config.segmentToleranceMeters, refreshSeconds: config.refreshSeconds,
    totalRecords, staleAfterSeconds: liveDcStaleAfterSeconds(readApi.config?.heartbeatSeconds ?? DC_DEFAULT_HEARTBEAT_SECONDS),
  });
  if (!truncated) return payload;
  return {
    ...payload,
    diagnostics: {
      ...payload.diagnostics,
      lastError: `DataConnect read truncated: ${rows.length} of ${total} active records`,
      dataConnect: { ...payload.diagnostics.dataConnect, truncated: true, activeTotal: total },
    },
  };
}
