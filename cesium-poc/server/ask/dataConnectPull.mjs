/**
 * Read-only pull from Bentley DataConnect into the twin store: every SDNA live class
 * ("SDNA Florida I595 Live …", written by the FL511 sync) and every historical class ("Florida I595 …",
 * the customer's records), so Ask the Twin answers from both.
 *
 * Only reads: it pages each class through the same read clients the app already uses
 * (server/liveDc/liveReadApi.mjs for live classes, server/dataConnect.mjs for historical ones). It
 * never writes to DataConnect.
 *
 * Records are compacted on the way in: empty, "NA" and placeholder values are dropped, a geometry
 * becomes plain longitude/latitude, and very long text is clipped. The store keeps what an answer can
 * use, not the transport format.
 */
import { HISTORICAL_CLASSES } from '../liveDc/classes.mjs';

export const DEFAULT_PAGE_SIZE = 500;
export const MAX_ROWS_PER_CLASS = 50_000;
const MAX_TEXT = 2_000;
const EMPTY = new Set(['', 'NA', 'N/A', 'n/a', 'null', 'undefined', 'None']);

/** Field names that carry each indexed column, across the live classes, the historical classes and the snapshot. */
export const DATE_FIELDS = Object.freeze(['first_seen_at', 'reported_at', 'created_at', 'incident_date', 'Ticket Opened Date', 'Task Date',
  'Work Order Open Date', 'inspection_date', 'inspected_at', 'date', 'damaged_at', 'install date', 'Instal Date', 'last_seen_at', 'updated_at']);
export const LON_FIELDS = Object.freeze(['longitude', 'x_coordinates', 'x coordinates', 'x_coordinate', 'X Coordinate', 'X Coordinates',
  'x_coordinate (from asset)', 'x_coordinate (from roadway)']);
export const LAT_FIELDS = Object.freeze(['latitude', 'y_coordinates', 'y coordinates', 'y_coordinate', 'Y Coordinate', 'Y Coordinates',
  'y_coordinate (from asset)', 'y_coordinate (from roadway)']);
export const SEGMENT_FIELDS = Object.freeze(['segment name', 'Segment', 'segment', 'nearest_facility_label', 'Segment Name']);

/** A point from a geometry value: GeoJSON-like `{type, coordinates}`, a JSON string of one, or WKT `POINT (lon lat)`. */
export function pointOf(geometry) {
  if (!geometry) return null;
  let value = geometry;
  if (typeof value === 'string') {
    const wkt = /POINT\s*Z?\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/i.exec(value);
    if (wkt) return { lon: Number(wkt[1]), lat: Number(wkt[2]) };
    try { value = JSON.parse(value); } catch { return null; }
  }
  let coords = value?.coordinates;
  // A line or polygon is placed at its first vertex: good enough to put a record on a corridor section.
  while (Array.isArray(coords) && Array.isArray(coords[0])) coords = coords[0];
  const [lon, lat] = Array.isArray(coords) ? coords.map(Number) : [];
  return Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lon, lat } : null;
}

const numberFrom = (record, names) => {
  for (const name of names) {
    const n = Number(record[name]);
    if (record[name] !== undefined && record[name] !== null && record[name] !== '' && Number.isFinite(n) && n !== 0) return n;
  }
  return null;
};

/**
 * One DataConnect item as a compact store row: `{keyInSource, ...attributes}` without empty values or
 * the raw geometry, with `longitude`/`latitude` filled from the geometry when the record has no plain
 * coordinates of its own.
 * @returns {{row: object, droppedFields: number} | null}  null for an item with no key
 */
export function compactItem(item) {
  const attributes = item?.attributes ?? {};
  const key = item?.keyInSource ?? attributes.keyInSource ?? attributes.code ?? null;
  if (key === null || key === undefined || EMPTY.has(String(key).trim())) return null;
  const row = { keyInSource: String(key) };
  let droppedFields = 0;
  for (const [name, raw] of Object.entries(attributes)) {
    if (name === 'geometry' || name === 'keyInSource') continue;
    if (raw === null || raw === undefined || (typeof raw === 'string' && EMPTY.has(raw.trim()))) { droppedFields++; continue; }
    if (typeof raw === 'object') { droppedFields++; continue; }
    row[name] = typeof raw === 'string' && raw.length > MAX_TEXT ? `${raw.slice(0, MAX_TEXT)}…` : raw;
  }
  const lon = numberFrom(row, LON_FIELDS), lat = numberFrom(row, LAT_FIELDS);
  if (lon === null || lat === null) {
    const point = pointOf(attributes.geometry ?? item?.geometry);
    if (point) { row.longitude = point.lon; row.latitude = point.lat; }
  }
  return { row, droppedFields };
}

/** How a DataConnect class is indexed in the store. */
export const specFor = className => ({ className, key: ['keyInSource'], at: DATE_FIELDS, lon: LON_FIELDS, lat: LAT_FIELDS, segment: SEGMENT_FIELDS });

/** Every item of one class, page by page, up to `maxRows`. */
async function readClass(read, { pageSize, maxRows }) {
  const items = [];
  let pages = 0, total = null;
  for (let page = 0; items.length < maxRows; page++) {
    const payload = await read({ page, pageSize, filters: [] });
    pages++;
    const data = Array.isArray(payload?.data) ? payload.data : [];
    total = Number.isFinite(Number(payload?.totalCount)) ? Number(payload.totalCount) : total;
    items.push(...data);
    if (data.length < pageSize || (total !== null && items.length >= total)) break;
  }
  return { items: items.slice(0, maxRows), pages, total, truncated: items.length >= maxRows && (total === null || total > maxRows) };
}

/**
 * Pull every SDNA live class and every historical class.
 *
 * A class that fails to read is reported and left out, so the store holds what could be read and the
 * tools say plainly which class is missing (a typed gap), rather than one failure emptying the store.
 *
 * @param {{liveDc?: {liveClasses: Function, curatedData: Function}|null, historical?: {curatedData: Function}|null,
 *   historicalClasses?: {id: string, className: string}[], pageSize?: number, maxRows?: number}} clients
 * @returns {Promise<{classes: {spec, rows, source}[], report: object[]}>}
 */
export async function pullDataConnect({ liveDc = null, historical = null, historicalClasses = HISTORICAL_CLASSES,
  pageSize = DEFAULT_PAGE_SIZE, maxRows = MAX_ROWS_PER_CLASS } = {}) {
  const targets = [];
  const report = [];
  if (liveDc) {
    try {
      for (const c of await liveDc.liveClasses({ refresh: true })) {
        targets.push({ kind: 'live', className: c.className, read: body => liveDc.curatedData(c.id, body) });
      }
    } catch (error) {
      report.push({ className: 'SDNA live classes', kind: 'live', error: `class list could not be read: ${String(error?.message ?? error).slice(0, 200)}` });
    }
  }
  if (historical) {
    for (const c of historicalClasses) targets.push({ kind: 'historical', className: c.className, read: body => historical.curatedData(c.id, body) });
  }

  const classes = [];
  for (const target of targets) {
    try {
      const { items, pages, total, truncated } = await readClass(target.read, { pageSize, maxRows });
      let dropped = 0, rawBytes = 0;
      const rows = [];
      for (const item of items) {
        rawBytes += JSON.stringify(item).length;
        const compacted = compactItem(item);
        if (!compacted) continue;
        dropped += compacted.droppedFields;
        rows.push(compacted.row);
      }
      classes.push({ spec: specFor(target.className), rows, source: `dataconnect:${target.kind}` });
      report.push({ className: target.className, kind: target.kind, items: items.length, rows: rows.length, pages, totalCount: total,
        truncated, droppedFields: dropped, rawBytes, compactBytes: rows.reduce((n, r) => n + JSON.stringify(r).length, 0) });
    } catch (error) {
      report.push({ className: target.className, kind: target.kind, error: String(error?.message ?? error).slice(0, 200) });
    }
  }
  return { classes, report };
}

/**
 * Build the store from DataConnect. A class this pull did not return is kept from the previous store
 * at `keepFrom` (its own load time and source unchanged), and only a class neither has comes from the
 * committed snapshot (marked `snapshot:` in store_meta, so answers say where it came from). So a
 * live-only refresh (`historical: null`) or a class that failed to read keeps its last good rows.
 * Nothing is written when DataConnect returned no class at all: the caller keeps the store it has.
 *
 * @param {{liveDc?: object, historical?: object, outPath: string, keepFrom?: string|null, snapshotDir?: string|null,
 *   asOf?: string, pageSize?: number, maxRows?: number}} options
 * @returns {Promise<{written: boolean, report: object[], outPath: string, bytes?: number}>}
 */
export async function buildStoreFromDataConnect({ liveDc = null, historical = null, outPath, keepFrom = null, snapshotDir = null,
  asOf, pageSize, maxRows }) {
  const { writeTwinStore, snapshotClasses, openTwinStore } = await import('./twinStore.mjs');
  const { existsSync, statSync } = await import('node:fs');
  const { classes, report } = await pullDataConnect({ liveDc, historical, ...(pageSize ? { pageSize } : {}), ...(maxRows ? { maxRows } : {}) });
  if (!classes.length) return { written: false, report, outPath };
  const pulled = new Set(classes.map(c => c.spec.className.toLowerCase()));
  let previous = [];
  if (keepFrom && existsSync(keepFrom)) {
    const store = openTwinStore(keepFrom);
    try { previous = store.classes().filter(c => !pulled.has(c.className.toLowerCase())); } finally { store.close(); }
  }
  for (const c of previous) report.push({ className: c.className, kind: 'kept', rows: c.rowCount, asOf: c.asOf, note: `kept from the previous store (${c.source})` });
  const have = new Set([...pulled, ...previous.map(c => c.className.toLowerCase())]);
  const fallback = snapshotDir ? snapshotClasses(snapshotDir).filter(c => !have.has(c.spec.className.toLowerCase())) : [];
  for (const c of fallback) report.push({ className: c.spec.className, kind: 'snapshot', rows: c.rows.length, note: 'not returned by DataConnect; loaded from the committed snapshot' });
  writeTwinStore({ outPath, classes: [...classes, ...fallback], ...(asOf ? { asOf } : {}),
    keep: previous.length ? { path: keepFrom, classNames: previous.map(c => c.className) } : null });
  return { written: true, report, outPath, bytes: statSync(outPath).size };
}
