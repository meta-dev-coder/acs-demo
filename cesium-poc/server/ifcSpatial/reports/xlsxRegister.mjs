/**
 * The Excel register (ExcelJS), from the same report snapshot as the PDF and the email:
 *   1. Register   one row per included asset: evidence columns (generated) and tracking columns (blank, for
 *                 the maintenance team to fill in — never pre-filled with invented assignments or dates)
 *   2. Inspection History   one row per inspection record of those assets
 *   3. Sources and Criteria generation time, model version, criteria, coverage, documents, limitations
 * Frozen headers, filters, wrapped text, dates as dates, conditional formats; text from documents is written
 * as text and never starts with a formula character.
 */
import ExcelJS from 'exceljs';

const NAVY = 'FF12305A', EDIT = 'FFFFF6D6', HEAD_EDIT = 'FFB7791F';
const FILL = { INSPECTION_REQUIRED: 'FFFDE2E1', REVIEW_RECOMMENDED: 'FFFEF0C7', INSUFFICIENT_EVIDENCE: 'FFEAECF0', NO_REQUIREMENT_IDENTIFIED: 'FFDCFAE6' };

/** Text from documents as a literal: no leading "=", "+", "-", "@", tab or CR that a spreadsheet could read as a formula. */
export function safeCell(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date || typeof value === 'number' || typeof value === 'boolean') return value;
  const s = String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}
const asDate = iso => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00Z`) : iso ?? null);
const refs = list => (list?.length ? `[${list.join(', ')}]` : '');

export const REGISTER_COLUMNS = Object.freeze([
  ['Asset ID', 12], ['IFC GlobalId', 24], ['Asset Type', 16], ['Description', 26], ['Location', 22], ['Operational Status', 16], ['Status As Of', 14],
  ['Latest Inspection Date', 14], ['Condition Rating', 14], ['Inspection Classification', 22], ['Inspection Requirement Reason', 60], ['Key Findings', 60],
  ['Priority', 10], ['Priority Basis', 34], ['Recommended Follow-up', 48], ['Next Inspection Due', 14], ['Next Due Basis', 16],
  ['Assigned To', 18], ['Planned Inspection Date', 16], ['Inspection Tracking Status', 18], ['Maintenance Team Notes', 36], ['Source References', 22],
]);
const EDITABLE = new Set(['Assigned To', 'Planned Inspection Date', 'Inspection Tracking Status', 'Maintenance Team Notes']);

export async function renderRegisterXlsx(snap) {
  if (snap.kind === 'MAINTENANCE') return renderMaintenanceXlsx(snap);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Seagirt IFC Spatial Twin';
  wb.created = new Date(snap.generatedAt);
  wb.title = snap.names.registerTitle;
  wb.subject = snap.request.question;

  // ---- 1. Register ----
  const ws = wb.addWorksheet('Inspection Register', { views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
  ws.columns = REGISTER_COLUMNS.map(([header, width]) => ({ header, width }));
  for (const a of snap.assets) {
    const loc = a.location.zone ?? (Number.isFinite(a.location.lat) ? `${a.location.lat.toFixed(6)}, ${a.location.lon.toFixed(6)}` : 'Not positioned');
    ws.addRow([a.id, a.globalId, a.typeLabel, a.description, `${loc}${/illustrative/i.test(a.location.basis) ? ' (illustrative)' : ''}`,
      a.operationalStatus?.label ?? null, asDate(a.operationalStatus?.asOf ?? null), asDate(a.latestInspection?.date ?? null),
      a.condition ? `${a.condition.label ?? ''}${Number.isFinite(a.condition.score) ? ` (${a.condition.score}/${a.condition.scale})` : ''}`.trim() : null,
      a.inspection.label, a.inspection.reasons.map(r => `${r.text} ${refs(r.refs)}`.trim()).join('\n'),
      a.keyFindings.map(k => `${k.title}: ${k.text} ${refs(k.refs)}`.trim()).join('\n') || null,
      a.inspection.priority.level, a.inspection.priority.basis, a.inspection.followUps.map(f => `${f.text}${f.basis === 'DOCUMENTED' ? '' : ' (suggested)'}`).join('\n') || null,
      asDate(a.inspection.nextInspection.date), a.inspection.nextInspection.basis === 'UNKNOWN' ? 'Unknown' : a.inspection.nextInspection.basis === 'DOCUMENTED' ? 'Documented' : 'Calculated',
      null, null, null, null, refs([...new Set(snap.sources.filter(s => s.assetId === a.id).map(s => s.n))])].map(safeCell));
  }
  styleSheet(ws, { editable: EDITABLE });
  const classCol = REGISTER_COLUMNS.findIndex(([h]) => h === 'Inspection Classification') + 1;
  const condCol = REGISTER_COLUMNS.findIndex(([h]) => h === 'Condition Rating') + 1;
  const last = Math.max(ws.rowCount, 2);
  const col = n => ws.getColumn(n).letter;
  ws.addConditionalFormatting({ ref: `${col(classCol)}2:${col(classCol)}${last}`, rules: [
    ['Inspection required', FILL.INSPECTION_REQUIRED], ['Review recommended', FILL.REVIEW_RECOMMENDED], ['Insufficient evidence', FILL.INSUFFICIENT_EVIDENCE], ['No requirement', FILL.NO_REQUIREMENT_IDENTIFIED],
  ].map(([text, color], i) => ({ type: 'containsText', operator: 'containsText', text, priority: i + 1, style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: color } } } })) });
  ws.addConditionalFormatting({ ref: `${col(condCol)}2:${col(condCol)}${last}`, rules: [['Poor', FILL.INSPECTION_REQUIRED], ['Fair', FILL.REVIEW_RECOMMENDED], ['Good', FILL.NO_REQUIREMENT_IDENTIFIED]]
    .map(([text, color], i) => ({ type: 'containsText', operator: 'containsText', text, priority: 10 + i, style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: color } } } })) });
  const trackCol = REGISTER_COLUMNS.findIndex(([h]) => h === 'Inspection Tracking Status') + 1;
  for (let r = 2; r <= Math.max(ws.rowCount, 2); r += 1) {
    ws.getCell(r, trackCol).dataValidation = { type: 'list', allowBlank: true, formulae: ['"Not started,Scheduled,In progress,Completed,Not required"'], showErrorMessage: true };
  }
  ws.getCell(1, trackCol).note = 'User-maintained tracking field: not a verified operational status.';
  for (const h of ['Assigned To', 'Planned Inspection Date', 'Maintenance Team Notes']) ws.getCell(1, REGISTER_COLUMNS.findIndex(([x]) => x === h) + 1).note = 'For the maintenance team to fill in. Left blank: no assignment or schedule is recorded.';

  // ---- 2. History ----
  const hs = wb.addWorksheet('Inspection History', { views: [{ state: 'frozen', ySplit: 1 }] });
  hs.columns = [['Asset ID', 12], ['Inspection Date', 14], ['Inspection Type', 24], ['Condition Rating', 14], ['Key Findings', 70], ['Recommended Actions', 50], ['Closure Evidence', 50],
    ['ACC Document', 44], ['Document Version', 10], ['Page Reference', 12]].map(([header, width]) => ({ header, width }));
  for (const a of snap.assets) for (const h of a.inspections) {
    hs.addRow([a.id, asDate(h.date), h.type, h.condition, h.findings, h.actions, h.closure, h.fileName, h.version ? `V${h.version}` : null, h.pages.length ? `p.${h.pages.join(', ')}` : null].map(safeCell));
  }
  styleSheet(hs);

  // ---- 3. Sources and criteria ----
  const ss = wb.addWorksheet('Sources and Criteria');
  ss.columns = [{ header: 'Item', width: 30 }, { header: 'Value', width: 70 }, { header: 'Detail', width: 40 }, { header: 'Link', width: 30 }];
  const cov = snap.inventoryCoverage;
  const rows = [
    ['Report', snap.names.registerTitle, `Reference ${snap.reportId}${snap.revision > 1 ? ` rev ${snap.revision}` : ''}`],
    ['Generated (UTC)', new Date(snap.generatedAt), null], ['Request', snap.request.question, null],
    ['Project', snap.project.name, snap.project.id],
    ...(snap.area ? [['Scope', `Selected area: ${snap.area.label}`, `${Math.round(snap.area.areaM2 ?? 0)} m² · resolved ${snap.area.resolvedAt ?? ''} · ${snap.area.counts.within} within, ${snap.area.counts.intersects} partly inside, ${snap.area.counts.crosses} crossing`],
      ['Area boundary (WGS84 lon, lat)', snap.area.geometry.coordinates[0].map(p => `${p[0].toFixed(6)} ${p[1].toFixed(6)}`).join('; '), snap.area.selectionId]] : []),
    ['IFC model', `${snap.model.fileName ?? '—'}${snap.model.versionNumber ? ` v${snap.model.versionNumber}` : ''}`, null],
    ['Illustrative', snap.illustrative ? 'Yes — the source records are illustrative demonstration data, not actual inspections' : 'No', null],
    ['Assets evaluated', cov.evaluated, `${cov.inScope} in scope`], ['With ACC documents', cov.withDocuments, null], ['With inspection records', cov.withInspectionRecords, null],
    ['Inspection required', snap.summary.inspectionRequired, null], ['Review recommended', snap.summary.reviewRecommended, null], ['Insufficient evidence', snap.summary.insufficientEvidence, null],
    ...cov.failed.map(f => ['Could not be assessed', f.id, f.reason]),
    ...snap.evaluated.filter(e => e.classification === 'INSUFFICIENT_EVIDENCE').map(e => ['Missing inspection records', e.id, e.analysisError ?? (e.documents?.linked ? 'No readable inspection report' : 'No ACC documents linked')]),
    ...snap.appliedCriteria.map(c => ['Criterion', c.text, `${c.source} · ${c.assets} asset${c.assets === 1 ? '' : 's'}`]),
    ['Policy', snap.policy.name ?? 'None configured', snap.policy.dueWithinDays ? `Due within ${snap.policy.dueWithinDays} days (assumption from the request)` : null],
    ['Operational status source', 'IFC model status as evaluated by the twin when the report was requested', 'Not live telemetry'],
    ...snap.sources.map(s => [`Source [${s.n}]`, `${s.title ?? s.fileName} (${s.fileName})`, `V${s.version ?? '?'} · ${s.assetId}${s.pages.length ? ` · p.${s.pages.join(', ')}` : ''}`, s.webViewUrl ? { text: 'Open in ACC', hyperlink: s.webViewUrl } : null]),
    ...snap.limitations.map(l => ['Limitation', l, null]),
  ];
  for (const r of rows) ss.addRow(r.map(v => (v && typeof v === 'object' && !(v instanceof Date) ? v : safeCell(v))));
  styleSheet(ss, { filter: false });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function styleSheet(ws, { editable = new Set(), filter = true } = {}) {
  const header = ws.getRow(1);
  header.height = 30;
  header.eachCell((cell, n) => {
    const edit = editable.has(String(cell.value));
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: edit ? HEAD_EDIT : NAVY } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    if (edit) ws.getColumn(n).eachCell({ includeEmpty: true }, (c, r) => { if (r > 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EDIT } }; });
  });
  ws.eachRow((row, r) => {
    if (r === 1) return;
    row.eachCell({ includeEmpty: true }, cell => {
      cell.alignment = { vertical: 'top', wrapText: true };
      if (cell.value instanceof Date) cell.numFmt = cell.value.getUTCHours() || cell.value.getUTCMinutes() ? 'yyyy-mm-dd hh:mm' : 'yyyy-mm-dd';
    });
  });
  if (filter && ws.rowCount >= 1) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(ws.rowCount, 1), column: ws.columnCount } };
}

const CLOSURE_TEXT = { NOT_VERIFIED: 'No closure evidence', NOT_COMPLETED_WITH_EVIDENCE: 'Documented as not completed', COMPLETED_WITH_EVIDENCE: 'Documented as completed' };
const EVIDENCE_TEXT = { AVAILABLE: 'Findings available', NO_RELEVANT_FINDINGS: 'Inspected, no findings', NO_INSPECTION_RECORDS: 'No inspection report linked', NO_DOCUMENTS: 'No documents linked',
  RETRIEVAL_FAILED: 'Documents could not be retrieved', UNREADABLE: 'Documents could not be read', NOT_CHECKED: 'Not checked' };
export const MAINTENANCE_COLUMNS = Object.freeze([
  ['Asset ID', 12], ['Asset Type', 16], ['Asset Name', 24], ['Location', 22], ['Operational Status', 16], ['Latest Inspection Date', 14], ['Latest Condition Rating', 16],
  ['Finding', 30], ['Finding Detail', 44], ['Documented Severity', 14], ['First Reported', 14], ['Latest Reported', 14], ['Recurring or New', 14],
  ['Documented Corrective Action', 40], ['Additional Investigation Required', 36], ['Closure Status', 22], ['Source Document', 34], ['Source Page', 10],
  ['Evidence Availability', 22], ['Notes', 40], ['Assigned To', 18], ['Planned Date', 14], ['Tracking Status', 16],
]);

/** The corrective action register: asset summary, one row per finding / action, actions, sources and criteria. */
async function renderMaintenanceXlsx(snap) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Seagirt IFC Spatial Twin';
  wb.created = new Date(snap.generatedAt);
  wb.title = snap.names.registerTitle;
  wb.subject = snap.request.question;
  const loc = a => `${a.location.zone ?? (Number.isFinite(a.location.lat) ? `${a.location.lat.toFixed(6)}, ${a.location.lon.toFixed(6)}` : 'Not positioned')}${/illustrative/i.test(a.location.basis) ? ' (illustrative)' : ''}`;
  const cond = a => (a.latestInspection?.condition ? `${a.latestInspection.condition.label ?? ''}${Number.isFinite(a.latestInspection.condition.score) ? ` ${a.latestInspection.condition.score}/${a.latestInspection.condition.scale ?? 5}` : ''}`.trim() : null);
  const add = (ws, row) => ws.addRow(row.map(v => (v instanceof Date ? v : safeCell(v))));

  // ---- 1. Register: one row per documented finding or action (or one row for an asset without them) ----
  const ws = wb.addWorksheet('Corrective Action Register', { views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
  ws.columns = MAINTENANCE_COLUMNS.map(([header, width]) => ({ header, width }));
  const actionFor = (a, f) => a.documentedCorrectiveActions.find(x => String(x.text).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3).some(w => `${f.title} ${f.text ?? ''}`.toLowerCase().includes(w)));
  for (const a of snap.assets) {
    const base = [a.id, a.typeLabel, a.description, loc(a), a.statusLabel, asDate(a.latestInspection?.date), cond(a)];
    const used = new Set();
    for (const f of a.findings) {
      const x = actionFor(a, f);
      if (x) used.add(x);
      const extra = a.additionalInvestigations.find(i => i.basedOn === f.title);
      add(ws, [...base, f.title, f.text, f.severity === 'DEFECT' ? 'Defect' : f.severity === 'ATTENTION' ? 'Attention' : null, asDate(f.firstReported), asDate(f.latestReported),
        f.recurring ? 'Recurring' : f.trend === 'NEW_FINDING' ? 'New' : null, x?.text ?? null, extra ? extra.text : null, x ? CLOSURE_TEXT[x.closure] : null, f.ref?.fileName ?? null, f.ref?.page ?? null,
        EVIDENCE_TEXT[a.evidenceAvailability], null, null, null, null]);
    }
    for (const x of a.documentedCorrectiveActions.filter(y => !used.has(y))) {
      add(ws, [...base, null, null, x.priority, asDate(x.raisedOn), null, null, x.text, null, CLOSURE_TEXT[x.closure], x.ref?.fileName ?? null, x.ref?.page ?? null, EVIDENCE_TEXT[a.evidenceAvailability], x.due ? `Due ${x.due}` : null, null, null, null]);
    }
    if (!a.findings.length && !a.documentedCorrectiveActions.length) {
      add(ws, [...base, null, null, null, null, null, null, null, a.operationalStatus !== 'POWERED' ? 'Establish the cause of the reported status (no documented findings)' : null, null, null, null,
        EVIDENCE_TEXT[a.evidenceAvailability], a.limitations.join(' ') || null, null, null, null]);
    }
  }
  styleSheet(ws, { editable: new Set(['Assigned To', 'Planned Date', 'Tracking Status']) });

  // ---- 2. Asset summary ----
  const as = wb.addWorksheet('Asset Summary', { views: [{ state: 'frozen', ySplit: 1 }] });
  as.columns = [['Asset ID', 12], ['Asset Type', 16], ['Asset Name', 24], ['Location', 22], ['Operational Status', 16], ['Status As Of', 14], ['Latest Inspection Date', 14], ['Latest Condition Rating', 16],
    ['Condition Trend', 34], ['Documented Findings', 12], ['Actions Without Verified Closure', 14], ['Operating Restrictions', 12], ['Cause of Status', 22], ['Evidence Availability', 22], ['Limitations', 50]].map(([header, width]) => ({ header, width }));
  for (const a of snap.assets) add(as, [a.id, a.typeLabel, a.description, loc(a), a.statusLabel, asDate(a.statusAsOf), asDate(a.latestInspection?.date), cond(a),
    a.conditionTrend.map(p => `${p.date} ${p.score}/${p.scale}`).join(' -> ') || null, a.findings.length, a.documentedCorrectiveActions.length, a.operatingRestrictions.length,
    a.degradationCause.status === 'NOT_ESTABLISHED' ? 'Not established by the records' : a.degradationCause.status === 'VERIFIED' ? 'Documented' : 'Not applicable', EVIDENCE_TEXT[a.evidenceAvailability], a.limitations.join(' ') || null]);
  styleSheet(as);

  // ---- 3. Operating restrictions and closure evidence ----
  const rs = wb.addWorksheet('Restrictions and Closure');
  rs.columns = [['Asset ID', 12], ['Kind', 22], ['Text', 60], ['Applicability / basis', 50], ['Source Document', 34], ['Source Page', 10]].map(([header, width]) => ({ header, width }));
  for (const a of snap.assets) {
    for (const r of a.operatingRestrictions) add(rs, [a.id, 'Operating restriction', r.text, r.applicability, r.ref?.fileName ?? null, r.ref?.page ?? null]);
    for (const c of a.closureEvidence) add(rs, [a.id, 'Documented completion', c.text, c.basis, c.ref?.fileName ?? null, c.ref?.page ?? null]);
  }
  styleSheet(rs);

  // ---- 4. Sources and criteria ----
  const ss = wb.addWorksheet('Sources and Criteria');
  ss.columns = [{ header: 'Item', width: 30 }, { header: 'Value', width: 70 }, { header: 'Detail', width: 40 }, { header: 'Link', width: 30 }];
  const cov = snap.inventoryCoverage;
  const rows = [
    ['Report', snap.names.registerTitle, `Reference ${snap.reportId}${snap.revision > 1 ? ` rev ${snap.revision}` : ''}`],
    ['Generated (UTC)', new Date(snap.generatedAt), null], ['Request', snap.request.question, null],
    ['Investigation', snap.request.investigation?.question ?? snap.request.question, snap.maintenance?.scopeLabel ?? null],
    ['Project', snap.project.name, snap.project.id],
    ...(snap.area ? [['Scope', `Selected area: ${snap.area.label}`, `${Math.round(snap.area.areaM2 ?? 0)} m²`], ['Area boundary (WGS84 lon, lat)', snap.area.geometry.coordinates[0].map(p => `${p[0].toFixed(6)} ${p[1].toFixed(6)}`).join('; '), snap.area.selectionId]] : []),
    ['IFC model', `${snap.model.fileName ?? '—'}${snap.model.versionNumber ? ` v${snap.model.versionNumber}` : ''}`, null],
    ['Illustrative', snap.illustrative ? 'Yes — the source records are illustrative demonstration data, not actual inspections' : 'No', null],
    ['Assets investigated', cov.evaluated, null], ['With ACC documents', cov.withDocuments, null], ['With inspection records', cov.withInspectionRecords, null],
    ['With documented findings', snap.summary.withFindings, null], ['Actions without verified closure', snap.summary.openActions, null],
    ['Operational status source', 'IFC model status as evaluated by the twin when the report was requested', snap.maintenance?.statusAsOf ? `Records up to ${snap.maintenance.statusAsOf}` : 'Not live telemetry'],
    ...snap.sources.map(x => [`Source [${x.n}]`, `${x.title ?? x.fileName} (${x.fileName})`, `V${x.version ?? '?'} · ${x.assetId}${x.pages.length ? ` · p.${x.pages.join(', ')}` : ''}`, x.webViewUrl ? { text: 'Open in ACC', hyperlink: x.webViewUrl } : null]),
    ...snap.limitations.map(l => ['Limitation', l, null]),
  ];
  for (const r of rows) ss.addRow(r.map(v => (v && typeof v === 'object' && !(v instanceof Date) ? v : safeCell(v))));
  styleSheet(ss, { filter: false });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
