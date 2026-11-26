/**
 * The report snapshot: one structured result that the PDF, the Excel register and the email draft are all
 * generated from, so they cannot disagree. Built once per report revision from
 *   - the assets the request covers (the twin's inventory: id, type, position, operational status),
 *   - each asset's document analysis (docIntel.mjs, read through the existing ACC document cache),
 *   - the inspection rules (eligibility.mjs) and any policy or user assumption,
 * and kept with the model version and the ACC document versions it used. Documented facts, calculated values
 * and recommendations are kept apart (each carries its basis).
 */
import { CLASSIFICATION, CLASSIFICATION_LABEL, evaluateInspection, NO_POLICY, RULES } from './eligibility.mjs';

export const REPORT_KIND = Object.freeze({ INSPECTION: 'INSPECTION', ASSET_LIST: 'ASSET_LIST', MAINTENANCE: 'MAINTENANCE' });
const ILLUSTRATIVE = /illustrative|demo|mock|not as-built|not a real|fictional/i;

const titleCase = s => String(s ?? '').replace(/\b[a-z]/g, c => c.toUpperCase());
/** "transformers", "transformers and circuit breakers" */
export function typePhrase(request) {
  const names = (request.typeLabels ?? []).map(t => t.plural);
  return names.length ? (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]) : 'assets';
}

/** The report's title and file stem, from what was asked: "Transformer Inspection Report", "Transformer_Inspection_Report_2026-11-26". */
/**
 * Titles and file names from what was asked, built once here so the PDF, the register, the attachments and the
 * email subject agree: "Transformer Inspection Report", "Degraded Electrical Assets Report", "Lighting Circuit
 * Register", "Electrical Asset Inventory Report". One noun per title (never "Asset Asset").
 */
export function reportNames(request, generatedAt, { area = null } = {}) {
  const labels = request.typeLabels ?? [];
  const one = labels.length === 1;
  const noun = one ? titleCase(labels[0].singular) : 'Electrical Asset';
  const nouns = one ? titleCase(labels[0].plural) : 'Electrical Assets';
  const day = String(generatedAt).slice(0, 10);
  const f = request.filters ?? {};
  let report, register;
  if (request.kind === REPORT_KIND.INSPECTION) { report = `${noun} Inspection Report`; register = `${noun} Inspection Register`; }
  else if (request.kind === REPORT_KIND.MAINTENANCE) { report = one ? `${noun} Maintenance Report` : 'Maintenance Report'; register = 'Corrective Action Register'; }
  else if (f.status === 'DEGRADED') { report = `Degraded ${nouns} Report`; register = `Degraded ${nouns} Register`; }
  else if (f.status === 'NO_POWER') { report = `${nouns} Without Power Report`; register = `${nouns} Without Power Register`; }
  else if (f.status === 'OFFLINE') { report = `Offline ${nouns} Report`; register = `Offline ${nouns} Register`; }
  else if (f.recurring) { report = `${noun} Recurring Findings Report`; register = `${noun} Recurring Findings Register`; }
  else if (request.options?.includeSpecs) { report = `${noun} Specification Report`; register = `${noun} Specification Register`; }
  else { report = `${noun} Inventory Report`; register = `${noun} Register`; }
  // A selected area: said in the title ("Selected Area Transformer Inspection Report") and the file names.
  if (area) { report = `Selected Area ${report}`; register = `Selected Area ${register}`; }
  const stem = s => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return { reportTitle: report, registerTitle: register, pdfFile: `${stem(report)}_${day}.pdf`, xlsxFile: `${stem(register)}_${day}.xlsx`, emlFile: `${stem(report)}_Email_Draft_${day}.eml` };
}

function historyRows(analysis, depth) {
  const t = (analysis?.inspections?.timeline ?? []).slice(0, depth ?? undefined);
  const closures = new Map((analysis?.inspections?.comparison?.actions ?? []).map(x => [`${x.raisedOn}|${x.action}`, x.closure]));
  return t.map(x => ({
    date: x.inspectionDate, type: x.type, condition: x.condition ? `${x.condition.label ?? ''}${Number.isFinite(x.condition.score) ? ` (${x.condition.score}/${x.condition.scale})` : ''}`.trim() : null,
    findings: x.findings.map(f => `${f.item}: ${f.notes ?? f.result}`).join('; ') || (x.mainFinding?.text ?? null),
    actions: x.actions.map(a => a.action).join('; ') || null,
    closure: x.actions.map(a => { const c = closures.get(`${x.inspectionDate}|${a.action}`); return c ? `${a.action}: ${c.status === 'COMPLETED_WITH_EVIDENCE' ? 'completion documented' : c.status === 'NOT_COMPLETED_WITH_EVIDENCE' ? 'documented as not completed' : 'no record of completion'}` : null; }).filter(Boolean).join('; ') || null,
    documentId: x.documentId, fileName: x.fileName, version: x.version, pages: [...new Set([x.dateCitation?.page, x.mainFinding?.citation?.page, ...x.findings.map(f => f.citation?.page)].filter(Boolean))].sort((a, b) => a - b),
  }));
}

function assetRecord(input, result, { request, now, policy }) {
  const a = result?.analysis ?? null;
  const latest = a?.inspections?.timeline?.find(t => t.inspectionDate) ?? null;
  const evaluation = evaluateInspection(input, a, { now, policy, analysisError: result?.error ?? null });
  const sources = (a?.sources ?? []).map(s => ({ documentId: s.documentId, fileName: s.fileName, title: s.title, version: s.version, documentType: s.documentType, status: s.status,
    inspectionDate: s.inspectionDate ?? null, webViewUrl: s.webViewUrl ?? null }));
  return {
    id: input.id, globalId: input.globalId ?? null, type: input.type, typeLabel: input.typeLabel ?? input.type, description: input.name ?? null, ifcClass: input.ifcClass ?? null,
    location: Number.isFinite(input.location?.lon) && Number.isFinite(input.location?.lat)
      ? { lon: input.location.lon, lat: input.location.lat, basis: input.positionIllustrative ? 'Illustrative model position, not surveyed' : 'IFC model position', zone: input.zone ?? null }
      : { lon: null, lat: null, basis: 'No position in the model', zone: input.zone ?? null },
    operationalStatus: input.status ? { code: input.status.code, label: input.status.label, source: input.status.source ?? null, asOf: input.status.asOf ?? null } : null,
    latestInspection: latest ? { date: latest.inspectionDate, type: latest.type, documentId: latest.documentId, citation: latest.dateCitation } : null,
    condition: latest?.condition ? { label: latest.condition.label, score: latest.condition.score, scale: latest.condition.scale, date: latest.inspectionDate, citation: latest.condition.citation, basis: 'DOCUMENTED' } : null,
    conditionTrend: a?.review?.conditionTrend ?? [],
    keyFindings: (a?.review?.concerns ?? []).map(k => ({ title: k.title, text: k.text, severity: k.severity, citations: k.citations })),
    recurring: (a?.review?.components ?? []).filter(c => c.recurring).map(c => c.item),
    inspection: { ...evaluation, label: CLASSIFICATION_LABEL[evaluation.classification] },
    inspections: historyRows(a, request.options?.historyDepth ?? null),
    actions: (a?.inspections?.comparison?.actions ?? []).map(x => ({ action: x.action, raisedOn: x.raisedOn, priority: x.priority ?? null, due: x.due ?? null, closure: x.closure.status, citation: x.citation })),
    specifications: request.options?.includeSpecs && a ? {
      documented: [...a.specifications.keyFields.filter(f => !f.missing), ...a.specifications.otherFields.filter(f => f.key)].map(f => ({ label: f.label, value: f.display ?? f.value, asWritten: f.value, conflict: f.conflict, citation: f.source })),
      missing: a.specifications.missing,
    } : null,
    documents: a ? { linked: a.documents.linked, analysed: a.documents.analysed, unreadable: a.documents.unreadable } : { linked: null, analysed: 0, unreadable: null },
    analysisError: result?.error ?? null,
    sources,
    illustrative: Boolean(a?.caveats?.some(c => ILLUSTRATIVE.test(c.text))),
  };
}

/** Which evaluated assets the report is about, by what was asked. */
function select(records, request) {
  const f = request.filters ?? {};
  let pool = records;
  if (f.excludeNoRecords) pool = pool.filter(r => r.inspections.length);
  if (f.condition === 'POOR') pool = pool.filter(r => r.condition?.label && /^(poor|very poor|bad|critical|unsatisfactory)$/i.test(r.condition.label));
  if (f.status) pool = pool.filter(r => r.operationalStatus?.code === f.status);
  if (f.recurring) pool = pool.filter(r => r.recurring.length);
  if (request.kind === REPORT_KIND.INSPECTION) {
    return { pool, selected: pool.filter(r => r.inspection.classification === CLASSIFICATION.INSPECTION_REQUIRED), review: pool.filter(r => r.inspection.classification === CLASSIFICATION.REVIEW_RECOMMENDED) };
  }
  return { pool, selected: pool, review: [] };
}

/** One number per cited document, report-wide. */
function sourceRegistry(assets) {
  const list = [];
  const byId = new Map();
  const cite = (assetId, c) => {
    if (!c?.documentId) return null;
    let s = byId.get(c.documentId);
    if (!s) {
      const doc = assets.find(a => a.id === assetId)?.sources.find(x => x.documentId === c.documentId);
      s = { n: list.length + 1, documentId: c.documentId, assetId, fileName: c.fileName ?? doc?.fileName ?? null, title: doc?.title ?? c.title ?? null, version: c.version ?? doc?.version ?? null,
        documentType: doc?.documentType ?? null, inspectionDate: doc?.inspectionDate ?? null, webViewUrl: doc?.webViewUrl ?? null, pages: [] };
      byId.set(c.documentId, s);
      list.push(s);
    }
    if (c.page && !s.pages.includes(c.page)) s.pages.push(c.page);
    return s.n;
  };
  return { list, cite };
}

/**
 * @param {object} o
 * @param {object} o.request {question, kind, types, typeLabels, outputs, recipientGroup, filters, options}
 * @param {object[]} o.assets the population the request covers (the twin's inventory for those types)
 * @param {Map<string, {analysis?: object, error?: string}>} o.results each asset's document analysis
 */
export function buildSnapshot({ reportId, revision = 1, revisionOf = null, request, assets, results, project, model, documentsIndex = null, now, policy = NO_POLICY, context = [], area = null }) {
  const records = assets.map(x => assetRecord(x, results.get(x.id), { request, now, policy }));
  const { pool, selected, review } = select(records, request);
  const included = [...selected, ...review];
  const reg = sourceRegistry(records);
  // Numbers for every citation the deliverables print.
  for (const r of included) {
    for (const reason of r.inspection.reasons) reason.refs = [...new Set(reason.citations.map(c => reg.cite(r.id, c)).filter(Boolean))].sort((x, y) => x - y);
    for (const k of r.keyFindings) k.refs = [...new Set(k.citations.map(c => reg.cite(r.id, c)).filter(Boolean))].sort((x, y) => x - y);
    for (const f of r.inspection.followUps) f.refs = [...new Set((f.citations ?? []).map(c => reg.cite(r.id, c)).filter(Boolean))].sort((x, y) => x - y);
    if (r.condition) r.condition.refs = [reg.cite(r.id, r.condition.citation)].filter(Boolean);
    if (r.inspection.nextInspection.citation) r.inspection.nextInspection.refs = [reg.cite(r.id, r.inspection.nextInspection.citation)].filter(Boolean);
    for (const h of r.inspections) h.ref = reg.cite(r.id, { documentId: h.documentId, fileName: h.fileName, version: h.version, page: h.pages[0] ?? null });
    for (const s of r.specifications?.documented ?? []) s.ref = reg.cite(r.id, s.citation);
  }
  for (const s of reg.list) s.pages.sort((x, y) => x - y);
  const count = c => pool.filter(r => r.inspection.classification === c).length;
  const illustrativeRecords = records.some(r => r.illustrative);
  const illustrativePositions = included.some(r => /illustrative/i.test(r.location.basis));
  const triggered = new Map();
  for (const r of pool) for (const reason of r.inspection.reasons) triggered.set(reason.rule, (triggered.get(reason.rule) ?? 0) + 1);
  const appliedCriteria = request.kind === REPORT_KIND.INSPECTION
    ? Object.entries(RULES).filter(([rule]) => (rule !== 'OVERDUE_POLICY_INTERVAL' || Object.keys(policy.intervalsByType ?? {}).length) && (rule !== 'DUE_WITHIN_WINDOW' || Number.isFinite(policy.dueWithinDays))
        && (rule !== 'POOR_CONDITION_POLICY' || policy.conditionRequiresInspection) && (rule !== 'POOR_CONDITION_REVIEW' || !policy.conditionRequiresInspection))
      .map(([rule, d]) => ({ rule, source: d.source, text: d.text, assets: triggered.get(rule) ?? 0,
        effect: rule === 'NO_INSPECTION_RECORDS' ? CLASSIFICATION.INSUFFICIENT_EVIDENCE : ['POOR_CONDITION_REVIEW', 'WORSENING_OR_RECURRING', 'ACTION_CLOSURE_NOT_VERIFIED', 'DEGRADED_STATUS'].includes(rule) ? CLASSIFICATION.REVIEW_RECOMMENDED : CLASSIFICATION.INSPECTION_REQUIRED }))
    : [{ rule: 'SELECTION', source: 'USER_REQUEST', text: describeFilters(request, area), assets: pool.length, effect: 'INCLUDED' }];
  const limitations = [];
  if (illustrativeRecords) limitations.push('The linked ACC documents describe themselves as illustrative demonstration records: the findings are not actual inspection results, and this report is illustrative.');
  if (illustrativePositions) limitations.push('Asset positions are illustrative model positions, not surveyed locations.');
  if (request.kind === REPORT_KIND.INSPECTION && !policy.name && !Number.isFinite(policy.dueWithinDays)) limitations.push('No inspection policy is configured: overdue status relies on due dates documented in the inspection reports, and condition-based criteria identify review candidates only.');
  const insufficient = pool.filter(r => r.inspection.classification === CLASSIFICATION.INSUFFICIENT_EVIDENCE);
  if (insufficient.length) limitations.push(`Inspection history could not be established for ${insufficient.length} of ${pool.length} assets (${insufficient.map(r => r.id).join(', ')}); they are not classified as healthy or overdue.`);
  const failed = records.filter(r => r.analysisError);
  if (failed.length) limitations.push(`${failed.length} asset${failed.length === 1 ? '' : 's'} could not be assessed because the documents could not be read: ${failed.map(r => `${r.id} (${r.analysisError})`).join('; ')}.`);
  if (included.some(r => r.actions.some(x => x.closure === 'NOT_VERIFIED'))) limitations.push('Closure of corrective actions is taken only from later inspection reports; no maintenance records are linked, so "no record of completion" does not mean the work was not done.');
  if (area) {
    limitations.push(`Scope: the ${area.label === 'Custom selected area' ? 'custom area' : `area "${area.label}"`} selected on the map (${Math.round(area.areaM2 ?? 0).toLocaleString('en-US')} m², WGS84). The server placed the assets in it from the IFC model (cable routes, equipment bounding-box footprints), not from surveyed positions; assets partly inside or crossing the boundary are included.`);
    if (area.counts?.unknown) limitations.push(`${area.counts.unknown} modelled asset${area.counts.unknown === 1 ? ' has' : 's have'} no position in the model and could not be placed inside or outside the area.`);
  }
  limitations.push(`Operational status is the IFC model's reported status as evaluated by the twin when the report was requested${assets[0]?.status?.evaluatedAt ? ` (${assets[0].status.evaluatedAt})` : ''}, not live telemetry.`);
  limitations.push('This report summarises records for review. It is not an authorized engineering inspection or a maintenance instruction.');

  return {
    reportId, revision, revisionOf, generatedAt: new Date(now).toISOString(), kind: request.kind,
    project: { id: project?.id ?? null, name: project?.name ?? null }, model: { fileName: model?.fileName ?? null, versionNumber: model?.versionNumber ?? null },
    documentsIndex: documentsIndex ? { lastSyncedAt: documentsIndex.lastSyncedAt ?? null } : null,
    request: { question: request.question, kind: request.kind, types: request.types, typeLabels: request.typeLabels, phrase: typePhrase(request), filters: request.filters ?? {}, options: request.options ?? {},
      outputs: request.outputs, recipientGroup: request.recipientGroup ?? null },
    names: reportNames(request, new Date(now).toISOString(), { area }),
    area: area ? structuredClone(area) : null,
    policy: { name: policy.name, dueWithinDays: policy.dueWithinDays ?? null, conditionRequiresInspection: Boolean(policy.conditionRequiresInspection), intervalsByType: policy.intervalsByType ?? {} },
    appliedCriteria,
    inventoryCoverage: {
      evaluated: records.length, inScope: pool.length, excluded: records.length - pool.length,
      withDocuments: records.filter(r => r.documents.linked).length, successfullyAnalyzed: records.filter(r => !r.analysisError && r.documents.analysed).length,
      withInspectionRecords: records.filter(r => r.inspections.length).length, insufficientEvidence: count(CLASSIFICATION.INSUFFICIENT_EVIDENCE),
      failed: failed.map(r => ({ id: r.id, reason: r.analysisError })),
    },
    summary: {
      included: included.length, selected: selected.length,
      inspectionRequired: count(CLASSIFICATION.INSPECTION_REQUIRED), reviewRecommended: count(CLASSIFICATION.REVIEW_RECOMMENDED),
      noRequirement: count(CLASSIFICATION.NO_REQUIREMENT_IDENTIFIED), insufficientEvidence: count(CLASSIFICATION.INSUFFICIENT_EVIDENCE),
      mainReasons: mainReasons(selected),
    },
    selectedIds: selected.map(r => r.id), reviewIds: review.map(r => r.id),
    assets: included, evaluated: records.map(r => ({ id: r.id, type: r.type, classification: r.inspection.classification, label: r.inspection.label, inScope: pool.includes(r),
      latestInspection: r.latestInspection?.date ?? null, condition: r.condition?.label ?? null, documents: r.documents, analysisError: r.analysisError })),
    sources: reg.list,
    documentVersions: [...new Map(records.flatMap(r => r.sources.map(s => [s.documentId, { documentId: s.documentId, fileName: s.fileName, version: s.version, assetId: r.id, status: s.status }]))).values()],
    context: context.slice(0, 2000),
    illustrative: illustrativeRecords,
    limitations,
  };
}

function describeFilters(request, area = null) {
  const f = request.filters ?? {};
  const bits = [`All ${typePhrase(request)} ${area ? `in the selected area (${area.label}) of the IFC model` : 'in the IFC model'}`];
  if (f.status === 'DEGRADED') bits.push('with a degraded operational status');
  if (f.status === 'NO_POWER') bits.push('with no power');
  if (f.recurring) bits.push('with a finding recorded in more than one inspection report');
  if (f.condition === 'POOR') bits.push('whose latest documented condition is poor');
  if (f.excludeNoRecords) bits.push('with inspection records');
  return `${bits.join(' ')}.`;
}

/** The reasons behind the selected assets, most common first: "Inspection action raised in the latest report (2)". */
function mainReasons(selected) {
  const label = { OVERDUE_DOCUMENTED_DATE: 'Overdue against the documented next inspection date', OVERDUE_DOCUMENTED_INTERVAL: 'Overdue against the documented interval',
    OVERDUE_POLICY_INTERVAL: 'Overdue against the configured interval', DUE_WITHIN_WINDOW: 'Due within the requested window', DOCUMENTED_INSPECTION_ACTION: 'Documented inspection or test action open',
    RESTRICTION_PERIODIC_TESTING: 'Operating restriction requiring periodic testing', POOR_CONDITION_POLICY: 'Poor documented condition (policy)' };
  const n = new Map();
  for (const r of selected) for (const rule of new Set(r.inspection.reasons.filter(x => x.classification === CLASSIFICATION.INSPECTION_REQUIRED).map(x => x.rule))) n.set(rule, (n.get(rule) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([rule, count]) => ({ rule, text: label[rule] ?? RULES[rule]?.text ?? rule, assets: count }));
}
