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

/** Coordinates a row carries itself. Column names differ per class, so each caller names its own. */
const ownCoordinates = (row, lonKey, latKey) => {
  const longitude = number(row[lonKey]), latitude = number(row[latKey]);
  return Number.isFinite(longitude) && Number.isFinite(latitude) && Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90
    ? { longitude, latitude, locationSource: 'record' } : NO_LOCATION;
};

export function normalizeWorkOrder(row) {
  return record({
    id: row['Work Order ID'], type: MAINTENANCE_TYPES.WORK_ORDER,
    title: text(row['Work Type']), status: text(row['Work Order Status']), priority: text(row.Priority),
    assetId: assetKey(row['Asset ID']), assetType: text(row['Asset Type']), systemClass: text(row['System Class']),
    segmentName: text(row.Segment), createdDate: text(row['Work Order Open Date']), closedDate: text(row['Close Date']),
    description: text(row['Work Description']),
    related: { ticketId: assetKey(row['Related Ticket ID']), taskId: assetKey(row['Related Task ID']),
      repairCategory: text(row['Repair Category']) },
    raw: row,
  });
}

export function normalizeTicket(row) {
  return record({
    id: row['Ticket ID'], type: MAINTENANCE_TYPES.TICKET,
    title: text(row['Issue Summary']) ?? text(row['Issue Category']), status: text(row['Ticket Status']), priority: text(row.Priority),
    assetId: assetKey(row['Asset ID']), assetType: text(row['Asset Type']), systemClass: text(row['System Class']),
    segmentName: text(row.Segment), createdDate: text(row['Ticket Opened Date']),
    description: text(row['Detailed Notes']),
    related: { issueCategory: text(row['Issue Category']), sourceSignal: text(row['Source Signal']) },
    coordinates: ownCoordinates(row, 'X Coordinate', 'Y Coordinate'),
    raw: row,
  });
}

export function normalizeTask(row) {
  return record({
    id: row['Task ID'], type: MAINTENANCE_TYPES.TASK,
    title: text(row['Task Type']), status: text(row['Task Status']), priority: null,
    assetId: assetKey(row['Asset ID']), assetType: text(row['Asset Type']), systemClass: text(row['System Class']),
    segmentName: text(row.Segment), createdDate: text(row['Task Date']),
    description: text(row['Task Notes']),
    related: { ticketId: assetKey(row['Related Ticket ID']), assignedTeam: text(row['Assigned Team']) },
    coordinates: ownCoordinates(row, 'X Coordinate', 'Y Coordinate'),
    raw: row,
  });
}

export function normalizeIncident(row) {
  return record({
    id: row.incident_id, type: MAINTENANCE_TYPES.INCIDENT,
    // Incidents carry no status field; severity is expressed by injuries, fatalities and closures.
    title: text(row.incident_type), status: null, priority: null,
    assetId: assetKey(row.damaged_asset_id), assetType: text(row.damaged_asset_description),
    segmentName: text(row.Segment), createdDate: text(row.incident_date),
    description: text(row.location_notes) ?? text(row.notes),
    related: { rootCause: text(row.root_cause_category), laneClosure: text(row.lane_closure_y_n),
      injuries: text(row.injuries_y_n), fatalities: number(row.fatalities) },
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
  const id = row.record_id ?? row.inspection_id;
  const coordinates = row.x_coordinate != null ? ownCoordinates(row, 'x_coordinate', 'y_coordinate')
    : row.x_coordinates != null ? ownCoordinates(row, 'x_coordinates', 'y_coordinates')
      : ownCoordinates(row, 'x_coordinate (from roadway)', 'y_coordinate (from roadway)');
  return record({
    id, type: MAINTENANCE_TYPES.INSPECTION,
    title: text(row.inspection_form_family) ?? text(row.asset_type),
    status: text(row.pass_fail) ?? text(row.pass_or_fail) ?? text(row.inspection_result),
    // Risk 1–5 is the inspections' own ranking; kept as the record's priority so one list can sort.
    priority: number(row.risk_rating_1_5_v3) ?? number(row.risk_rating_1_5) ?? null,
    assetId: assetKey(row.asset_id), assetType: text(row.asset_type),
    segmentName: text(row.segment) ?? text(row.Segment),
    createdDate: text(row.inspection_date) ?? text(row.date),
    description: text(row.safety_issue_description_v3) ?? text(row.issue_summary) ?? text(row.observed_condition),
    related: { inspectionRef: row.record_id && row.inspection_id ? text(row.inspection_id) : null,
      inspector: text(row.inspector_name), recommendedAction: text(row.recommended_action_standardized) ?? text(row.recommended_action),
      riskReason: text(row.risk_reason_standardized) ?? text(row.risk_reason) },
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
    ? row => assetKey(row?.record_id) || assetKey(row?.inspection_id)
    : row => assetKey(row?.[idColumn(key)]);
  return (rows ?? []).filter(identifies).map(normalize);
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
    const id = assetKey(row['Asset ID']);
    if (!id || index.has(id)) continue;
    index.set(id, Object.freeze({
      id,
      category: text(row['Asset Category']),
      systemClass: text(row['System Class']),
      segment: text(row.Segment),
      longitude: number(row['X Coordinates']),
      latitude: number(row['Y Coordinates']),
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
