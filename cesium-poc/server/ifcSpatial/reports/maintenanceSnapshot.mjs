/**
 * The snapshot of a maintenance report (seagirt_implementation.md §20): the maintenance investigation — the same
 * assessment Ask the Twin shows (src/ifcSpatial/maintenance.js) — built here from the server's own reading of
 * each asset's linked ACC documents, with the operational status the page recorded when the report was asked
 * for. The PDF, the corrective action register and the email are drawn from this one object, so they agree.
 */
import { assessAsset, buildMaintenanceAssessment, EVIDENCE, rowSummary } from '../../../src/ifcSpatial/maintenance.js';
import { reportNames, REPORT_KIND } from './snapshot.mjs';

const ILLUSTRATIVE = /illustrative|demo|mock|not as-built|not a real|fictional/i;
const STATUS_LABEL = { POWERED: 'Powered', DEGRADED: 'Degraded', NO_POWER: 'No power', OFFLINE: 'Offline', UNKNOWN: 'Unknown' };

/**
 * @param {object} o
 * @param {object[]} o.assets the request's assets (id, type, typeLabel, name, location, status {code, label, source, asOf})
 * @param {Map<string, {analysis?: object, error?: string}>} o.results the document analysis per asset
 */
export function buildMaintenanceSnapshot({ reportId, revision = 1, revisionOf = null, request, assets, results, project, model, documentsIndex = null, now, context = [], area = null }) {
  const evidence = assets.map(x => {
    const r = results.get(x.id) ?? {};
    return { id: x.id, category: x.typeLabel ?? x.type, analysis: r.analysis ?? null, error: r.error ?? null,
      status: x.status ? { status: x.status.code, monitored: true, date: x.status.asOf ?? null, source: x.status.source ?? null, flag: null } : null,
      documents: { linked: r.analysis ? r.analysis.documents.linked : r.error ? null : 0, index: true } };
  });
  const describe = id => { const x = assets.find(a => a.id === id); return x ? { type: x.typeLabel ?? x.type, name: x.name ?? null } : {}; };
  const inv = { plan: { question: request.question, primaryIntent: request.investigation?.primaryIntent ?? 'CORRECTIVE_ACTIONS', scope: { type: area ? 'SELECTED_AREA' : 'TERMINAL', explicit: !area },
    assetFilters: { operationalStatus: request.investigation?.statusFilters ?? [], assetTypes: [] } },
  targets: { ids: assets.map(a => a.id), how: 'PREVIOUS', notAssets: [] }, assets: evidence,
  failures: evidence.filter(e => e.error).map(e => ({ id: e.id, error: e.error })), partial: evidence.some(e => e.error), limited: null };
  const m = buildMaintenanceAssessment(inv, { describe, scopeLabel: area ? `Selected area · ${area.label}` : request.investigation?.scopeLabel ?? null });
  // Each assessed asset with the report's own fields: where it is, its status label, its row summary.
  const byId = new Map(assets.map(a => [a.id, a]));
  const included = m.assets.map(a => {
    const x = byId.get(a.assetId) ?? {};
    return { ...a, id: a.assetId, globalId: x.globalId ?? null, typeLabel: x.typeLabel ?? x.type ?? a.assetType, description: x.name ?? null,
      location: Number.isFinite(x.location?.lon) && Number.isFinite(x.location?.lat) ? { lon: x.location.lon, lat: x.location.lat, zone: x.zone ?? null,
        basis: x.positionIllustrative ? 'Illustrative model position, not surveyed' : 'IFC model position' } : { lon: null, lat: null, zone: x.zone ?? null, basis: 'Not positioned in the model' },
      statusLabel: x.status?.label ?? STATUS_LABEL[a.operationalStatus] ?? a.operationalStatus, statusAsOf: x.status?.asOf ?? null, row: rowSummary(a) };
  });
  // Source references: one per document, with the pages cited for this report.
  const reg = new Map();
  for (const a of included) for (const r of [...a.sourceRefs, ...a.findings.map(f => f.ref), ...a.documentedCorrectiveActions.map(x => x.ref)].filter(Boolean)) {
    if (!reg.has(r.documentId)) reg.set(r.documentId, { n: reg.size + 1, documentId: r.documentId, fileName: r.fileName, title: r.title ?? r.fileName, version: r.version, assetId: a.id, pages: new Set(), webViewUrl: r.webViewUrl ?? null, inspectionDate: r.inspectionDate ?? null });
    if (r.page) reg.get(r.documentId).pages.add(r.page);
  }
  const sources = [...reg.values()].map(s => ({ ...s, pages: [...s.pages].sort((x, y) => x - y) }));
  const numberOf = ref => (ref?.documentId ? reg.get(ref.documentId)?.n ?? null : null);
  for (const a of included) {
    for (const f of a.findings) f.n = numberOf(f.ref);
    for (const x of [...a.documentedCorrectiveActions, ...a.completedActions]) x.n = numberOf(x.ref);
    for (const r of a.operatingRestrictions) r.n = numberOf(r.ref);
  }
  const illustrative = evidence.some(e => (e.analysis?.caveats ?? []).some(c => ILLUSTRATIVE.test(c.text ?? '')));
  const withFindings = included.filter(a => a.evidenceAvailability === EVIDENCE.AVAILABLE);
  const statusAsOf = [...new Set(assets.map(a => a.status?.asOf).filter(Boolean))].sort().at(-1) ?? null;
  const limitations = [...m.limitations];
  if (area) limitations.push(`Scope: the ${area.label === 'Custom selected area' ? 'custom area' : `area "${area.label}"`} selected on the map, resolved by the server from the IFC model (cable routes, equipment bounding-box footprints), not surveyed positions.`);
  if (m.summary.assetsWithUnknownDegradationCause) limitations.push(`The records do not establish the cause of the reported status for ${m.summary.assetsWithUnknownDegradationCause} of ${m.summary.matchingAssets} assets: documented findings are not presented as the cause.`);
  limitations.push('Actions without closure evidence are not known to be done or not done: only later inspection reports were checked, and maintenance records are not read for completed work.');
  limitations.push(`Operational status is the IFC model's reported status as evaluated by the twin when the report was requested${statusAsOf ? ` (status records up to ${statusAsOf})` : ''}, not live telemetry.`);
  limitations.push('This report summarises records for review. It is not an authorized engineering inspection, a repair or isolation instruction, or an approval to keep equipment in service.');
  const generatedAt = new Date(now).toISOString();
  return {
    reportId, revision, revisionOf, generatedAt, kind: REPORT_KIND.MAINTENANCE,
    project: { id: project?.id ?? null, name: project?.name ?? null }, model: { fileName: model?.fileName ?? null, versionNumber: model?.versionNumber ?? null },
    documentsIndex: documentsIndex ? { lastSyncedAt: documentsIndex.lastSyncedAt ?? null } : null,
    request: { question: request.question, kind: request.kind, types: request.types, typeLabels: request.typeLabels, phrase: request.typeLabels.map(l => l.plural).join(' and ') || 'assets',
      filters: request.filters ?? {}, options: request.options ?? {}, outputs: request.outputs, recipientGroup: request.recipientGroup ?? null, investigation: request.investigation ?? null },
    names: reportNames(request, generatedAt, { area }), area: area ? structuredClone(area) : null,
    maintenance: { summary: m.summary, scopeLabel: m.scope.label, statusAsOf, primaryIntent: m.primaryIntent },
    appliedCriteria: [{ rule: 'SELECTION', source: 'USER_REQUEST', text: `The assets of the maintenance investigation "${request.investigation?.question ?? request.question}"${area ? ` in the selected area (${area.label})` : ''}.`, assets: included.length, effect: 'INCLUDED' }],
    inventoryCoverage: { evaluated: included.length, inScope: included.length, excluded: 0, withDocuments: included.filter(a => (a.documents.linked ?? 0) > 0).length,
      successfullyAnalyzed: included.filter(a => a.documents.analysed > 0).length, withInspectionRecords: included.filter(a => a.inspectionCount > 0).length,
      insufficientEvidence: included.length - withFindings.length, failed: included.filter(a => a.evidenceAvailability === EVIDENCE.RETRIEVAL_FAILED).map(a => ({ id: a.id, reason: a.limitations[0] ?? 'Not retrieved' })) },
    // Kept for the job view and the email: "selected" are the assets with documented findings.
    summary: { included: included.length, selected: withFindings.length, inspectionRequired: 0, reviewRecommended: 0, noRequirement: 0, insufficientEvidence: included.length - withFindings.length, mainReasons: [],
      withFindings: withFindings.length, withoutFindings: included.length - withFindings.length, openActions: included.reduce((n, a) => n + a.documentedCorrectiveActions.length, 0),
      restrictions: included.reduce((n, a) => n + a.operatingRestrictions.length, 0), unknownCause: m.summary.assetsWithUnknownDegradationCause, partialEvidence: m.summary.partialEvidence },
    selectedIds: withFindings.map(a => a.id), reviewIds: [],
    assets: included, evaluated: included.map(a => ({ id: a.id, type: a.typeLabel, classification: a.evidenceAvailability, label: a.row.text, inScope: true, latestInspection: a.latestInspection?.date ?? null,
      condition: a.latestInspection?.condition?.label ?? null, documents: a.documents, analysisError: a.evidenceAvailability === EVIDENCE.RETRIEVAL_FAILED ? a.limitations[0] : null })),
    sources, documentVersions: sources.map(s => ({ documentId: s.documentId, fileName: s.fileName, version: s.version, assetId: s.assetId, status: 'SUCCESS' })),
    context: context.slice(0, 2000), illustrative, limitations,
  };
}
void assessAsset;
