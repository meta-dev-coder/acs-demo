/**
 * DataConnect rows → one maintenance record shape the whole workspace uses.
 *
 * Every field below was read off the actual I-595 classes; nothing is mapped that the records do
 * not carry. Where a class has no equivalent (a work order has no coordinates of its own, an
 * incident has no status) the field is simply null, and the UI says so rather than inventing one.
 *
 * Pure on purpose — no Cesium, no DOM, no fetch — so the mappings and the spatial resolution are
 * unit-tested directly against the committed export.
 */

/** @typedef {'WORK_ORDER'|'TICKET'|'TASK'|'INCIDENT'|'INSPECTION'} MaintenanceType */

export const MAINTENANCE_TYPES = Object.freeze({
  WORK_ORDER: 'WORK_ORDER', TICKET: 'TICKET', TASK: 'TASK', INCIDENT: 'INCIDENT', INSPECTION: 'INSPECTION',
});

const text = value => {
  const string = value == null ? '' : String(value).trim();
  return string && string.toUpperCase() !== 'N/A' && string.toLowerCase() !== 'unknown' ? string : null;
};
const number = value => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
/** Asset ids are numeric in some registry rows and strings in others — compare as text, always. */
export const assetKey = value => {
  const string = text(value);
  return string ? string : null;
};

/**
 * DataConnect wraps a record's fields in `attributes`; the committed export is the flat row itself.
 * Everything below reads through this, so one set of mappings serves both.
 *
 *   { id, classId, className, keyInSource, attributes: {...}, valid }   →  attributes
 *   { 'Work Order ID': 'WO-1', ... }                                    →  the row
 */
export const attributesOf = row => (row && typeof row === 'object' && row.attributes && typeof row.attributes === 'object' ? row.attributes : row ?? {});

/** Keys compare without case or separators: "Work Order ID", "work_order_id" and "workOrderId". */
const keyOf = name => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
const indexed = new WeakMap();
function fieldIndex(attributes) {
  let index = indexed.get(attributes);
  if (!index) {
    index = new Map(Object.entries(attributes).map(([name, value]) => [keyOf(name), value]));
    indexed.set(attributes, index);
  }
  return index;
}

/**
 * One field of a record, by the name the source gives it. Several names may be offered where the
 * classes genuinely differ (a roadway inspection's `inspection_id` vs a safety sheet's `record_id`);
 * spelling variants of the SAME name are handled by the comparison, not by listing them.
 */
export function field(row, ...names) {
  const index = fieldIndex(attributesOf(row));
  for (const name of names) {
    const value = index.get(keyOf(name));
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

/** Attribute names a normalizer did not read — printed in debug so mappings can be pinned. */
export function unmappedFields(row, mapped) {
  const used = new Set(mapped.map(keyOf));
  return Object.keys(attributesOf(row)).filter(name => !used.has(keyOf(name)));
}

/** A record with no usable position: shown in the list, never placed on the map. */
const NO_LOCATION = Object.freeze({ latitude: null, longitude: null, locationSource: null });

function record({ id, type, title, status, priority, assetId, assetType, systemClass, segmentName,
  createdDate, closedDate, description, related = {}, coordinates = NO_LOCATION, raw }) {
  return Object.freeze({
    id: String(id),
    sourceId: String(id),
    type,
    title: title ?? String(id),
    status: status ?? null,
    priority: priority ?? null,
    assetId: assetId ?? null,
    assetType: assetType ?? null,
    systemClass: systemClass ?? null,
    segmentName: segmentName ?? null,
    createdDate: createdDate ?? null,
    closedDate: closedDate ?? null,
    description: description ?? null,
    related: Object.freeze({ ...related }),
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    /** 'record' when the row carried its own coordinates, 'asset' when the registry supplied them. */
    locationSource: coordinates.locationSource,
    raw,
  });
}

/**
 * The corridor's own neighbourhood, generously drawn: south Florida, not a tight box round I-595.
 * Used only to tell one reading of a coordinate pair from the other, never to reject a record for
 * being somewhere unexpected.
 */
const FLORIDA = Object.freeze({ minLon: -88, maxLon: -79, minLat: 24, maxLat: 31 });
const inFlorida = (longitude, latitude) =>
  longitude >= FLORIDA.minLon && longitude <= FLORIDA.maxLon && latitude >= FLORIDA.minLat && latitude <= FLORIDA.maxLat;

/** How many records arrived with their two coordinate columns the wrong way round. */
let swappedCount = 0;
export const coordinateSwaps = () => swappedCount;
export const resetCoordinateSwaps = () => { swappedCount = 0; };

/**
 * A record's own position.
 *
 * One live class ships x and y the wrong way round — the roadway inspections hold latitude in
 * `x_coordinates` and longitude in `y_coordinates`, while the safety and ITS classes hold them
 * correctly. Both readings are valid coordinates, so a range check cannot tell them apart: taken as
 * written those 251 inspections sit off Antarctica, and taken swapped they sit on I-595. The pair is
 * therefore read as written whenever that lands in Florida, and swapped only when swapping is the
 * only reading that does. A pair that makes sense both ways, or neither, is never second-guessed.
 */
const ownCoordinates = (row, lonKey, latKey) => {
  const longitude = number(field(row, lonKey)), latitude = number(field(row, latKey));
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return NO_LOCATION;
  if (Math.abs(latitude) <= 90 && inFlorida(longitude, latitude)) return { longitude, latitude, locationSource: 'record' };
  if (Math.abs(longitude) <= 90 && inFlorida(latitude, longitude)) {
    swappedCount += 1;
    return { longitude: latitude, latitude: longitude, locationSource: 'record' };
  }
  // Neither reading puts the record near the corridor this application covers, so the pair is
  // unusable rather than merely surprising. The committed export contains such rows — a safety
  // inspection whose longitude lost a digit, -8.33 instead of -80.33 — and placing one puts a
  // Broward inspection in the Gulf of Guinea. The record is kept and listed; only its position is
  // dropped, which is how every other unplaceable record behaves.
  return NO_LOCATION;
};

export const WORK_ORDER_FIELDS = Object.freeze(['Work Order ID', 'Work Type', 'Work Order Status', 'Priority',
  'Asset ID', 'Asset Type', 'System Class', 'Segment', 'Work Order Open Date', 'Close Date', 'Work Description',
  'Related Ticket ID', 'Related Task ID', 'Repair Category']);

export function normalizeWorkOrder(row) {
  return record({
    id: field(row, 'Work Order ID') ?? row?.keyInSource ?? row?.id, type: MAINTENANCE_TYPES.WORK_ORDER,
    title: text(field(row, 'Work Type')), status: text(field(row, 'Work Order Status')), priority: text(field(row, 'Priority')),
    assetId: assetKey(field(row, 'Asset ID')), assetType: text(field(row, 'Asset Type')), systemClass: text(field(row, 'System Class')),
    segmentName: text(field(row, 'Segment')), createdDate: text(field(row, 'Work Order Open Date')), closedDate: text(field(row, 'Close Date')),
    description: text(field(row, 'Work Description')),
    related: { ticketId: assetKey(field(row, 'Related Ticket ID')), taskId: assetKey(field(row, 'Related Task ID')),
      repairCategory: text(field(row, 'Repair Category')) },
    raw: row,
  });
}

export function normalizeTicket(row) {
  return record({
    id: field(row, 'Ticket ID') ?? row?.keyInSource ?? row?.id, type: MAINTENANCE_TYPES.TICKET,
    title: text(field(row, 'Issue Summary')) ?? text(field(row, 'Issue Category')), status: text(field(row, 'Ticket Status')), priority: text(field(row, 'Priority')),
    assetId: assetKey(field(row, 'Asset ID')), assetType: text(field(row, 'Asset Type')), systemClass: text(field(row, 'System Class')),
    segmentName: text(field(row, 'Segment')), createdDate: text(field(row, 'Ticket Opened Date')),
    description: text(field(row, 'Detailed Notes')),
    related: { issueCategory: text(field(row, 'Issue Category')), sourceSignal: text(field(row, 'Source Signal')) },
    coordinates: ownCoordinates(row, 'X Coordinate', 'Y Coordinate'),
    raw: row,
  });
}

export function normalizeTask(row) {
  return record({
    id: field(row, 'Task ID') ?? row?.keyInSource ?? row?.id, type: MAINTENANCE_TYPES.TASK,
    title: text(field(row, 'Task Type')), status: text(field(row, 'Task Status')), priority: null,
    assetId: assetKey(field(row, 'Asset ID')), assetType: text(field(row, 'Asset Type')), systemClass: text(field(row, 'System Class')),
    segmentName: text(field(row, 'Segment')), createdDate: text(field(row, 'Task Date')),
    description: text(field(row, 'Task Notes')),
    related: { ticketId: assetKey(field(row, 'Related Ticket ID')), assignedTeam: text(field(row, 'Assigned Team')) },
    coordinates: ownCoordinates(row, 'X Coordinate', 'Y Coordinate'),
    raw: row,
  });
}

export function normalizeIncident(row) {
  return record({
    id: field(row, 'incident_id') ?? row?.keyInSource ?? row?.id, type: MAINTENANCE_TYPES.INCIDENT,
    // Incidents carry no status field; severity is expressed by injuries, fatalities and closures.
    title: text(field(row, 'incident_type')), status: null, priority: null,
    assetId: assetKey(field(row, 'damaged_asset_id')), assetType: text(field(row, 'damaged_asset_description')),
    segmentName: text(field(row, 'Segment')), createdDate: text(field(row, 'incident_date')),
    description: text(field(row, 'location_notes')) ?? text(field(row, 'notes')),
    related: { rootCause: text(field(row, 'root_cause_category')), laneClosure: text(field(row, 'lane_closure_y_n')),
      injuries: text(field(row, 'injuries_y_n')), fatalities: number(field(row, 'fatalities')) },
    coordinates: ownCoordinates(row, 'x_coordinate (from asset)', 'y_coordinate (from asset)'),
    raw: row,
  });
}

export function normalizeInspection(row) {
  // Three inspection sheets, three spellings of the same few columns.
  //
  // The identifier is each sheet's own record id (SAFE-…, ITSV3-…): `inspection_id` is a reference
  // that the roadway and ITS sheets share, so 133 of them name two different inspections. The shared
  // reference is kept as a field rather than used as the identity.
  // `record_id` exists only on the ITS sheet. The roadway and safety classes identify a record by
  // `code` (== the envelope's `keyInSource`), so leaving it out drops them entirely — 502 of the
  // instance's 1,548 inspections. Codes are unique within a class but not across them, which
  // `normalizeAll` resolves.
  const id = field(row, 'record_id', 'inspection_id', 'code') ?? row?.keyInSource ?? row?.id;
  const coordinates = field(row, 'x_coordinate') != null ? ownCoordinates(row, 'x_coordinate', 'y_coordinate')
    : field(row, 'x_coordinates') != null ? ownCoordinates(row, 'x_coordinates', 'y_coordinates')
      : ownCoordinates(row, 'x_coordinate (from roadway)', 'y_coordinate (from roadway)');
  return record({
    id, type: MAINTENANCE_TYPES.INSPECTION,
    title: text(field(row, 'inspection_form_family')) ?? text(field(row, 'asset_type')),
    status: text(field(row, 'pass_fail', 'pass_or_fail', 'inspection_result')),
    // Risk 1–5 is the inspections' own ranking; kept as the record's priority so one list can sort.
    priority: number(field(row, 'risk_rating_1_5_v3', 'risk_rating_1_5')),
    assetId: assetKey(field(row, 'asset_id')), assetType: text(field(row, 'asset_type')),
    segmentName: text(field(row, 'segment')),
    createdDate: text(field(row, 'inspection_date', 'date')),
    description: text(field(row, 'safety_issue_description_v3', 'issue_summary', 'observed_condition')),
    related: { inspectionRef: field(row, 'record_id') && field(row, 'inspection_id') ? text(field(row, 'inspection_id')) : null,
      inspector: text(field(row, 'inspector_name')),
      recommendedAction: text(field(row, 'recommended_action_standardized', 'recommended_action')),
      riskReason: text(field(row, 'risk_reason_standardized', 'risk_reason')) },
    coordinates,
    raw: row,
  });
}

export const NORMALIZERS = Object.freeze({
  workOrders: normalizeWorkOrder, tickets: normalizeTicket, tasks: normalizeTask,
  incidents: normalizeIncident, inspections: normalizeInspection,
});

/** Rows of one class → records, dropping only rows with no identifier at all. */
export function normalizeAll(key, rows) {
  const normalize = NORMALIZERS[key];
  if (!normalize) throw new Error(`No normalizer for "${key}"`);
  const identifies = key === 'inspections'
    ? row => assetKey(field(row, 'record_id', 'inspection_id', 'code')) || assetKey(row?.keyInSource)
    : row => assetKey(field(row, idColumn(key))) || assetKey(row?.keyInSource);
  return ensureUniqueIds((rows ?? []).filter(identifies).map(normalize));
}

/**
 * Make every record's `id` unique within its list.
 *
 * Two records may legitimately print the same reference: the inspection sheets number their forms
 * per class, so 115 roadway codes repeat in the ITS class. The map keys entities by id, and a
 * repeated key silently replaces a marker — or throws. The shared reference stays visible as
 * `sourceId`; only the key is made distinct, and only for the records that actually clash, so the
 * common case is untouched.
 */
function ensureUniqueIds(records) {
  const counts = new Map();
  for (const item of records) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  if (![...counts.values()].some(n => n > 1)) return records;
  const used = new Set();
  return records.map(item => {
    if (counts.get(item.id) === 1) return item;
    // `title` is the form family for an inspection — a meaningful discriminator, not a counter.
    const base = item.title && item.title !== item.id ? `${item.id} · ${item.title}` : item.id;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base} (${n})`;
    used.add(id);
    return Object.freeze({ ...item, id });
  });
}

const ID_COLUMNS = Object.freeze({
  workOrders: 'Work Order ID', tickets: 'Ticket ID', tasks: 'Task ID', incidents: 'incident_id', inspections: 'inspection_id',
});
function idColumn(key) {
  return ID_COLUMNS[key];
}

/** The asset registry, indexed for lookup. Ids are compared as text (some rows store numbers). */
export function assetIndex(rows) {
  const index = new Map();
  for (const row of rows ?? []) {
    // The export names this column "Asset ID"; DataConnect's asset class calls it "code" and repeats
    // it as the envelope's `keyInSource`. All three are the same identifier, and it is what a work
    // order's own "Asset ID" points at — verified against the instance: 854/854 records join.
    const id = assetKey(field(row, 'Asset ID', 'code') ?? row?.keyInSource);
    if (!id || index.has(id)) continue;
    index.set(id, Object.freeze({
      id,
      category: text(field(row, 'Asset Category')),
      systemClass: text(field(row, 'System Class')),
      segment: text(field(row, 'Segment')),
      longitude: number(field(row, 'X Coordinates', 'longitude')),
      latitude: number(field(row, 'Y Coordinates', 'latitude')),
      raw: row,
    }));
  }
  return index;
}

/**
 * Give a record a position from its asset when it has none of its own.
 *
 * The registry is authoritative for asset-related work, so it is preferred: a work order's location
 * IS its asset's location. A record that carries its own coordinate (a ticket, a task, an incident)
 * keeps it. Anything left unresolved stays in the list with no position at all.
 */
export function resolveLocations(records, assets) {
  return records.map(item => {
    const asset = item.assetId ? assets.get(item.assetId) : null;
    const fromAsset = asset && Number.isFinite(asset.longitude) && Number.isFinite(asset.latitude);
    if (fromAsset && (item.locationSource !== 'record' || item.type === MAINTENANCE_TYPES.WORK_ORDER)) {
      return Object.freeze({ ...item, longitude: asset.longitude, latitude: asset.latitude, locationSource: 'asset',
        assetType: item.assetType ?? asset.category, segmentName: item.segmentName ?? asset.segment });
    }
    return item;
  });
}

export const hasLocation = item => Number.isFinite(item?.longitude) && Number.isFinite(item?.latitude);

/**
 * What a KPI card shows: the total, and a second line counted from the records themselves.
 * @returns {{total: number, note: string|null, located: number, linked: number}}
 */
export function summarize(records, key) {
  const total = records.length;
  const located = records.filter(hasLocation).length;
  const linked = records.filter(item => item.assetId).length;
  const count = predicate => records.filter(predicate).length;
  const closed = new Set(['closed', 'completed', 'resolved', 'cancelled']);
  const open = count(item => item.status && !closed.has(item.status.toLowerCase()));
  const note = key === 'workOrders' ? `${open} open · ${count(item => item.priority === 'High')} high priority`
    : key === 'tickets' ? `${open} open`
      : key === 'tasks' ? `${count(item => /in progress/i.test(item.status ?? ''))} in progress`
        : key === 'inspections' ? `${count(item => /fail/i.test(item.status ?? ''))} failed`
          : key === 'incidents' ? `${count(item => /^y/i.test(item.related?.laneClosure ?? ''))} with lane closure`
            : null;
  return { total, note: total ? note : null, located, linked };
}

/**
 * Everything on one asset, for the detail view and the Safety Twin later.
 *
 * Joined on identifiers the records actually carry — asset id, and a work order's own ticket and
 * task ids — never on similar-looking text.
 *
 * @param {string} assetId
 * @param {{assets?: Map<string, object>, records?: Record<string, object[]>}} sources
 */
export function getAssetActivity(assetId, { assets = new Map(), records = {} } = {}) {
  const id = assetKey(assetId);
  const of = key => (records[key] ?? []).filter(item => item.assetId === id);
  return Object.freeze({
    asset: assets.get(id) ?? null,
    incidents: of('incidents'),
    tickets: of('tickets'),
    tasks: of('tasks'),
    workOrders: of('workOrders'),
    inspections: of('inspections'),
  });
}

/** The records a work order names directly, so its details can offer them. */
export function relatedRecords(item, records = {}) {
  const ticketId = item?.related?.ticketId, taskId = item?.related?.taskId;
  return Object.freeze({
    ticket: ticketId ? (records.tickets ?? []).find(candidate => candidate.id === ticketId) ?? null : null,
    task: taskId ? (records.tasks ?? []).find(candidate => candidate.id === taskId) ?? null : null,
  });
}
