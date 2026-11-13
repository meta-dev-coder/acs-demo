/**
 * The normalised case the validation engine sees.
 *
 * The engine never touches a DataConnect row, an Office Track payload or a spreadsheet. Adapters
 * translate each source into this shape, so replacing a source later changes an adapter and
 * nothing else.
 */
import { CONFIDENCE } from './schema.js';
import { normaliseAssetType, normaliseWorkActivity } from './applicability.js';

const attrs = record => record?.raw?.attributes ?? record?.raw ?? record?.attributes ?? record ?? {};
const text = value => {
  const out = String(value ?? '').trim();
  return out && !/^(n\/?a|none|unknown|null)$/i.test(out) ? out : null;
};

/** DD/MM/YYYY — the register's format — to ISO. Anything else is returned untouched. */
export function isoDate(value) {
  const raw = text(value);
  if (!raw) return null;
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(raw);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  return iso ? iso[0] : raw;
}

/**
 * The field mapping registry.
 *
 * Every canonical field states where it came from and how sure that is. A field with no source is
 * listed too, with `sourceField: null` — the absence is part of the record.
 */
export const FIELD_MAPPINGS = Object.freeze([
  { canonical: 'workOrder.id', source: 'DataConnect:workOrder', path: 'code', type: 'string', confidence: CONFIDENCE.HIGH },
  { canonical: 'workOrder.assetId', source: 'DataConnect:workOrder', path: 'Asset ID', type: 'string', confidence: CONFIDENCE.HIGH },
  { canonical: 'workOrder.assetType', source: 'DataConnect:workOrder', path: 'Asset Type', type: 'string', confidence: CONFIDENCE.HIGH, transformation: 'normaliseAssetType' },
  { canonical: 'workOrder.workActivity', source: 'DataConnect:workOrder', path: 'Work Type', type: 'string', confidence: CONFIDENCE.HIGH, transformation: 'normaliseWorkActivity' },
  { canonical: 'workOrder.repairCategory', source: 'DataConnect:workOrder', path: 'Repair Category', type: 'string', confidence: CONFIDENCE.HIGH },
  { canonical: 'workOrder.status', source: 'DataConnect:workOrder', path: 'Work Order Status', type: 'string', confidence: CONFIDENCE.HIGH },
  { canonical: 'workOrder.openedDate', source: 'DataConnect:workOrder', path: 'Work Order Open Date', type: 'date', confidence: CONFIDENCE.HIGH, transformation: 'isoDate' },
  { canonical: 'workOrder.closedDate', source: 'DataConnect:workOrder', path: 'Close Date', type: 'date', confidence: CONFIDENCE.HIGH, transformation: 'isoDate' },
  { canonical: 'inspection.id', source: 'DataConnect:inspection', path: 'code', type: 'string', confidence: CONFIDENCE.HIGH },
  { canonical: 'inspection.date', source: 'DataConnect:inspection', path: 'inspection_date', type: 'date', confidence: CONFIDENCE.HIGH, transformation: 'isoDate' },
  { canonical: 'inspection.inspector', source: 'DataConnect:inspection', path: 'inspector_name', type: 'string', confidence: CONFIDENCE.HIGH },
  { canonical: 'inspection.result', source: 'DataConnect:inspection', path: 'inspection_result', type: 'enum', confidence: CONFIDENCE.HIGH },
  { canonical: 'inspection.passFail', source: 'DataConnect:inspection', path: 'pass_fail', type: 'enum', confidence: CONFIDENCE.HIGH },
  { canonical: 'inspection.assetCondition', source: 'DataConnect:inspection', path: 'asset_condition', type: 'enum', confidence: CONFIDENCE.HIGH },
  { canonical: 'inspection.assetType', source: 'DataConnect:inspection', path: 'asset_type', type: 'string', confidence: CONFIDENCE.HIGH },
  { canonical: 'inspection.formFamily', source: 'DataConnect:inspection', path: 'inspection_form_family', type: 'string', confidence: CONFIDENCE.HIGH },
  { canonical: 'asset.id', source: 'DataConnect:assets', path: 'code', type: 'string', confidence: CONFIDENCE.HIGH },
  { canonical: 'asset.category', source: 'DataConnect:assets', path: 'asset category', type: 'string', confidence: CONFIDENCE.HIGH },
  { canonical: 'evidence.photoCount', source: 'ACS:repair form', path: 'Section_1:INSPECTION / Section_2:REPAIR', type: 'number', confidence: CONFIDENCE.HIGH,
    note: 'Counts only. The image files were not supplied with the export.' },
  // The fields the framework needs and no source provides. Listed so the gap is visible.
  { canonical: 'qcInspection.responses', source: null, path: null, type: 'map', confidence: CONFIDENCE.UNRESOLVED,
    note: 'No system in scope holds per-question ACS QC/QA responses. This is the single mapping '
      + 'that would turn most MISSING findings into PASS or FAIL.' },
  { canonical: 'approvals.qc', source: null, path: null, type: 'approval', confidence: CONFIDENCE.UNRESOLVED,
    note: 'No QC sign-off record exists in any class.' },
  { canonical: 'approvals.qa', source: null, path: null, type: 'approval', confidence: CONFIDENCE.UNRESOLVED,
    note: 'No QA sign-off record exists in any class.' },
  { canonical: 'asset.subtype', source: null, path: null, type: 'string', confidence: CONFIDENCE.UNRESOLVED,
    note: 'No class records an attenuator make or an end-treatment model, so model-specific '
      + 'sections cannot be resolved.' },
  { canonical: 'workOrder.laneDirection', source: null, path: null, type: 'string', confidence: CONFIDENCE.UNRESOLVED,
    note: 'The ACS form header asks for it; no maintenance class carries it.' },
].map(Object.freeze));

/** Mappings with no source, for the limitations report. */
export const UNRESOLVED_MAPPINGS = Object.freeze(
  FIELD_MAPPINGS.filter(mapping => mapping.source === null));

/* --- adapters --------------------------------------------------------------------------------
 * One per source. Each returns a slice of the canonical case and never reaches into another.
 */

export function adaptWorkOrder(record) {
  if (!record) return null;
  const a = attrs(record);
  return Object.freeze({
    id: text(a.code) ?? text(a['Work Order ID']) ?? record.id ?? null,
    assetId: text(a['Asset ID']),
    assetType: normaliseAssetType(text(a['Asset Type'])),
    assetTypeRaw: text(a['Asset Type']),
    workActivity: normaliseWorkActivity(text(a['Work Type'])),
    workActivityRaw: text(a['Work Type']),
    repairCategory: text(a['Repair Category']),
    status: text(a['Work Order Status']),
    priority: text(a.Priority),
    openedDate: isoDate(a['Work Order Open Date']),
    closedDate: isoDate(a['Close Date']),
    description: text(a['Work Description']) ?? text(a.description),
    segment: text(a.Segment) ?? text(a['segment name']),
    relatedTicketId: text(a['Related Ticket ID']),
    sourceEventId: text(a.source_event_id),
    source: 'DataConnect:workOrder',
  });
}

export function adaptInspection(record) {
  if (!record) return null;
  const a = attrs(record);
  return Object.freeze({
    id: text(a.code) ?? record.id ?? null,
    date: isoDate(a.inspection_date),
    inspector: text(a.inspector_name),
    result: text(a.inspection_result),
    passFail: text(a.pass_fail),
    assetCondition: text(a.asset_condition),
    assetId: text(a.asset_id),
    assetType: normaliseAssetType(text(a.asset_type)),
    assetTypeRaw: text(a.asset_type),
    formFamily: text(a.inspection_form_family),
    recommendedAction: text(a.recommended_action),
    issueSummary: text(a.issue_summary),
    relatedWorkOrderId: text(a.related_work_order_id),
    /**
     * The V3 roadway-condition fields, OK/Issue.
     *
     * These are a DIFFERENT checklist from the ACS QC/QA forms — a generic roadway survey — so
     * they are carried as `conditionObservations` and never presented as answers to an ACS
     * question. The engine may use them for consistency checks, not as checklist responses.
     */
    conditionObservations: Object.freeze(Object.fromEntries(
      Object.entries(a).filter(([key, value]) =>
        /^(guardrail_|crash_attenuator_|debris_|edge_|signs_|markings_|standing_|inlets_|outfalls_|erosion_|scour_|potholes_|raveling_|shoulder_|missing_or_|visible_spalls_|clear_zone_)/.test(key)
        && /^(ok|issue)$/i.test(String(value ?? '')))
        .map(([key, value]) => [key, String(value).toUpperCase()]))),
    source: 'DataConnect:inspection',
  });
}

export function adaptIncident(record) {
  if (!record) return null;
  const a = attrs(record);
  return Object.freeze({
    id: text(a.code) ?? record.id ?? null,
    type: text(a.incident_type) ?? text(record.title),
    date: isoDate(a.incident_date),
    damagedAssetId: text(a.damaged_asset_id),
    policeReportNumber: text(a.police_report_number),
    laneClosure: text(a.lane_closure_y_n),
    source: record.live ? 'DataConnect:live' : 'DataConnect:incidentRecord',
  });
}

export function adaptAsset(assetId, assetIndex) {
  const asset = assetId && assetIndex ? assetIndex.get(String(assetId)) : null;
  if (!asset) return null;
  return Object.freeze({
    id: String(assetId),
    category: asset.category ?? null,
    assetType: normaliseAssetType(asset.category),
    systemClass: asset.systemClass ?? null,
    description: asset.description ?? null,
    longitude: asset.longitude ?? null,
    latitude: asset.latitude ?? null,
    /** No class records a make or model, so model-specific sections stay unresolved. */
    subtype: null,
    source: 'DataConnect:assets',
  });
}

/** The ACS repair task, where one has been associated with the case. */
export function adaptAcsTask(acsCase) {
  if (!acsCase?.task) return null;
  const task = acsCase.task;
  const photos = (acsCase.stages ?? []).reduce((total, stage) =>
    total + (stage.inspectionPhotos ?? 0) + (stage.repairPhotos ?? 0), 0);
  return Object.freeze({
    caseId: acsCase.caseId,
    taskNumber: task.taskNumber,
    date: task.date,
    siteLocation: task.siteLocationText,
    laneDirection: task.laneDirection,
    stateRoad: task.stateRoad,
    qcSignatory: (acsCase.stages ?? []).map(stage => stage.qcBy).find(Boolean) ?? null,
    photoCount: photos,
    evidenceFilesSupplied: false,
    linkEvidence: acsCase.evidence,
    source: 'ACS:repair form',
  });
}

/**
 * Assemble one normalised case.
 *
 * Nothing here joins records by proximity or by date. A relationship is carried only where a
 * record states it (`related_work_order_id`, `Related Ticket ID`, `damaged_asset_id`).
 */
export function buildCase({ caseId, incident = null, workOrder = null, inspection = null,
  assetIndex = null, acsCase = null, qcResponses = null, approvals = null, evidence = null } = {}) {
  const wo = adaptWorkOrder(workOrder);
  const insp = adaptInspection(inspection);
  const inc = adaptIncident(incident);
  const assetId = wo?.assetId ?? insp?.assetId ?? inc?.damagedAssetId ?? null;
  const asset = adaptAsset(assetId, assetIndex);
  const acs = adaptAcsTask(acsCase);

  return Object.freeze({
    caseId: caseId ?? wo?.id ?? insp?.id ?? inc?.id ?? null,
    incident: inc,
    workOrder: wo,
    inspection: insp,
    asset,
    acsTask: acs,
    /** Per-question ACS responses. Null means none were supplied — never an empty pass. */
    qcInspection: qcResponses ? Object.freeze({ responses: qcResponses }) : null,
    approvals: approvals ?? Object.freeze({ qc: null, qa: null }),
    evidence: Object.freeze(evidence ?? []),
    /** What the selection engine needs, resolved once. */
    classification: Object.freeze({
      assetType: wo?.assetType ?? insp?.assetType ?? asset?.assetType ?? null,
      assetSubtype: asset?.subtype ?? null,
      workActivity: wo?.workActivity ?? (insp ? 'inspection' : null),
      incidentType: inc?.type ?? null,
      workOrderId: wo?.id ?? null,
    }),
  });
}
