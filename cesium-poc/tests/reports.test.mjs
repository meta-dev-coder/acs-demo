import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { extractPdfText } from '../server/ifcSpatial/docExtract.mjs';
import { analyzeAssetDocuments, normalizeDocument } from '../server/ifcSpatial/docIntel.mjs';
import { createIfcSpatialApi } from '../server/ifcSpatial/api.mjs';
import { CLASSIFICATION, evaluateInspection, intervalDays } from '../server/ifcSpatial/reports/eligibility.mjs';
import { buildSnapshot } from '../server/ifcSpatial/reports/snapshot.mjs';
import { renderReportPdf } from '../server/ifcSpatial/reports/pdfReport.mjs';
import { renderRegisterXlsx, safeCell } from '../server/ifcSpatial/reports/xlsxRegister.mjs';
import { draftEmail, toEml } from '../server/ifcSpatial/reports/emailDraft.mjs';
import { ApsError } from '../server/aps/oauth.mjs';
import { inspectionReport, specSheet } from './pdfFixtures.mjs';

const NOW = Date.parse('2026-11-26T09:00:00Z');
const record = (fileName, n = 1) => ({ documentId: fileName.replace(/\W/g, '').slice(0, 24), fileName, versionNumber: n, accVersionId: `urn:v:${fileName}?version=${n}`, accItemId: `urn:i:${fileName}`, webViewUrl: `https://acc.example/${fileName}` });
const read = async (fileName, bytes) => normalizeDocument(record(fileName), await extractPdfText(bytes));
const TX = id => ({ id, name: `Transformer ${id}`, ifcClass: 'IfcTransformer', globalId: `G-${id}` });
async function analysis(id, docs) {
  const out = [];
  for (const [name, bytes] of Object.entries(docs)) out.push(await read(`${id}_${name}.pdf`, bytes));
  return analyzeAssetDocuments({ asset: TX(id), docs: out });
}
const input = (id, extra = {}) => ({ id, type: 'TRANSFORMER', typeLabel: 'Transformer', name: `Transformer ${id}`, globalId: `G-${id}`, location: { lon: -76.54, lat: 39.257 }, positionIllustrative: true,
  status: { code: 'POWERED', label: 'Powered', source: 'REPORTED', asOf: '2026-11-24' }, ...extra });

// Controlled records: one asset with an inspection action in its latest report, one overdue, one fine, one with none.
const LATEST_ACTION = { sheet: specSheet({ assetId: 'TX-A', fields: [['Rating', '34.5/13.8 kV, 12 MVA']] }),
  i25: inspectionReport({ assetId: 'TX-A', date: '2025-04-10', number: 'A25', condition: 'FAIR (3/5)', findings: [['Radiators and cooling fans', 'Attention', 'Weep.']], actions: [['Re-sample oil for DGA', 'Medium', '2025-10-10']] }),
  i26: inspectionReport({ assetId: 'TX-A', date: '2026-10-28', number: 'A26', condition: 'POOR (2/5)', summary: ['Condition Poor.'], findings: [['Radiators and cooling fans', 'Defect', '=HYPERLINK("http://x") still leaking.']],
    actions: [['Thermographic inspection of LV connections', 'High', '2026-12-15'], ['Repair radiator 3 valve', 'Medium', '2026-12-30']] }) };

test('eligibility: documented requirements, review candidates and missing evidence are kept apart', async () => {
  const a = await analysis('TX-A', LATEST_ACTION);
  const r = evaluateInspection(input('TX-A'), a, { now: NOW });
  assert.equal(r.classification, CLASSIFICATION.INSPECTION_REQUIRED);
  assert.ok(r.reasons.some(x => x.rule === 'DOCUMENTED_INSPECTION_ACTION' && /Thermographic inspection/.test(x.text) && x.citations[0].documentId));
  assert.ok(!r.reasons.some(x => /Repair radiator 3 valve/.test(x.text)), 'a repair is not an inspection requirement');
  assert.ok(r.reasons.some(x => x.rule === 'ACTION_CLOSURE_NOT_VERIFIED' && x.classification === 'REVIEW_RECOMMENDED'), 'an earlier test without a record of completion is for review');
  assert.ok(r.reasons.some(x => x.rule === 'POOR_CONDITION_REVIEW' && x.classification === 'REVIEW_RECOMMENDED'), 'poor condition is a review candidate without a policy');
  assert.deepEqual(r.priority, { level: 'High', basis: 'Highest priority stated on a triggering action in the inspection report.' });
  assert.equal(r.nextInspection.basis, 'UNKNOWN');
  assert.ok(r.limitations.some(l => /Overdue status cannot be established/.test(l)));
  // With a policy, poor condition is a requirement.
  assert.ok(evaluateInspection(input('TX-A'), a, { now: NOW, policy: { name: 'P', intervalsByType: {}, conditionRequiresInspection: true } }).reasons.some(x => x.rule === 'POOR_CONDITION_POLICY' && x.classification === 'INSPECTION_REQUIRED'));
});

test('eligibility: overdue only from a documented date, a documented interval or a configured policy', async () => {
  const due = await analysis('TX-B', { i: inspectionReport({ assetId: 'TX-B', date: '2025-06-01', number: 'B1', condition: 'GOOD (4/5)', findings: [['Bushings', 'OK', 'Clean.']], nextDue: '2026-06-01' }) });
  const late = evaluateInspection(input('TX-B'), due, { now: NOW });
  assert.ok(due.inspections.timeline[0].nextDue, 'the due date is read from the report');
  {
    assert.equal(late.classification, 'INSPECTION_REQUIRED');
    assert.match(late.reasons[0].text, /overdue: the latest report set the next inspection for 2026-06-01 \(178 days ago\)/i);
    assert.equal(late.priority.level, 'High');
  }
  const plain = await analysis('TX-C', { i: inspectionReport({ assetId: 'TX-C', date: '2025-06-01', number: 'C1', condition: 'GOOD (4/5)', findings: [['Bushings', 'OK', 'Clean.']] }) });
  const none = evaluateInspection(input('TX-C'), plain, { now: NOW });
  assert.equal(none.classification, 'NO_REQUIREMENT_IDENTIFIED', 'no due date, no interval, no policy: not overdue');
  assert.equal(none.nextInspection.basis, 'UNKNOWN');
  const policy = evaluateInspection(input('TX-C'), plain, { now: NOW, policy: { name: 'Annual transformer inspection', intervalsByType: { TRANSFORMER: 365 }, conditionRequiresInspection: false } });
  assert.equal(policy.classification, 'INSPECTION_REQUIRED');
  assert.equal(policy.reasons[0].rule, 'OVERDUE_POLICY_INTERVAL');
  assert.equal(policy.reasons[0].source, 'POLICY');
  assert.equal(policy.nextInspection.date, '2026-06-01');
  assert.equal(intervalDays('12 months'), 365);
  assert.equal(intervalDays('Annual'), 365);
  assert.equal(intervalDays('every 90 days'), 90);
  assert.equal(intervalDays('as required'), null);
});

test('eligibility: degraded is a review candidate, never an inspection requirement; no records is insufficient evidence', async () => {
  const plain = await analysis('TX-C', { i: inspectionReport({ assetId: 'TX-C', date: '2025-06-01', number: 'C1', condition: 'GOOD (4/5)', findings: [['Bushings', 'OK', 'Clean.']] }) });
  const degraded = evaluateInspection(input('TX-C', { status: { code: 'DEGRADED', label: 'Degraded', source: 'REPORTED' } }), plain, { now: NOW });
  assert.equal(degraded.classification, 'REVIEW_RECOMMENDED');
  assert.equal(degraded.reasons[0].source, 'OPERATIONAL');
  const empty = analyzeAssetDocuments({ asset: TX('TX-D'), docs: [] });
  const none = evaluateInspection(input('TX-D'), empty, { now: NOW });
  assert.equal(none.classification, 'INSUFFICIENT_EVIDENCE');
  assert.match(none.reasons[0].text, /No ACC documents are linked/);
  assert.ok(none.limitations.some(l => /not evidence that the asset is healthy or overdue/.test(l)));
  assert.equal(evaluateInspection(input('TX-D'), null, { now: NOW, analysisError: 'Your ACC account cannot read it.' }).classification, 'INSUFFICIENT_EVIDENCE');
  const degradedNoRecords = evaluateInspection(input('TX-D', { status: { code: 'DEGRADED', label: 'Degraded' } }), empty, { now: NOW });
  assert.equal(degradedNoRecords.classification, 'REVIEW_RECOMMENDED');
});

async function sampleSnapshot(extra = {}) {
  const results = new Map([['TX-A', { analysis: await analysis('TX-A', LATEST_ACTION) }], ['TX-C', { analysis: await analysis('TX-C', { i: inspectionReport({ assetId: 'TX-C', date: '2025-06-01', number: 'C1', condition: 'GOOD (4/5)', findings: [['Bushings', 'OK', 'Clean.']] }) }) }],
    ['TX-D', { analysis: analyzeAssetDocuments({ asset: TX('TX-D'), docs: [] }) }], ['TX-E', { error: 'Your ACC account cannot read this document.' }]]);
  return buildSnapshot({ reportId: 'RPT-20261126-abcdefgh', request: { question: 'Prepare a report of all transformers requiring inspection and draft an email to the electrical maintenance team.', kind: 'INSPECTION', types: ['TRANSFORMER'],
    typeLabels: [{ singular: 'transformer', plural: 'transformers' }], outputs: { pdf: true, xlsx: true, email: true }, recipientGroup: 'Electrical Maintenance Team', filters: {}, options: {}, ...extra },
  assets: ['TX-A', 'TX-C', 'TX-D', 'TX-E'].map(id => input(id)), results, project: { id: 'b.p', name: 'Seagirt Electrical Digital Twin POC' }, model: { fileName: 'net.ifc', versionNumber: 3 }, now: NOW,
  context: [{ id: 'X', lon: -76.541, lat: 39.256 }] });
}

test('snapshot: one consistent result for every deliverable; coverage and limitations said', async () => {
  const s = await sampleSnapshot();
  assert.deepEqual(s.selectedIds, ['TX-A']);
  assert.deepEqual([s.summary.inspectionRequired, s.summary.reviewRecommended, s.summary.noRequirement, s.summary.insufficientEvidence], [1, 0, 1, 2]);
  assert.deepEqual([s.inventoryCoverage.evaluated, s.inventoryCoverage.withInspectionRecords, s.inventoryCoverage.failed.map(f => f.id)], [4, 2, ['TX-E']]);
  assert.ok(s.limitations.some(l => /could not be established for 2 of 4 assets \(TX-D, TX-E\)/.test(l)));
  assert.ok(s.limitations.some(l => /No inspection policy is configured/.test(l)));
  assert.ok(s.limitations.some(l => /not an authorized engineering inspection/.test(l)));
  assert.ok(s.sources.length >= 1 && s.sources.every(x => x.n && x.documentId && x.version));
  const a = s.assets[0];
  assert.ok(a.inspection.reasons.every(r => Array.isArray(r.refs)));
  assert.equal(s.names.pdfFile, 'Transformer_Inspection_Report_2026-11-26.pdf');
  assert.equal(s.names.xlsxFile, 'Transformer_Inspection_Register_2026-11-26.xlsx');
  assert.equal(s.generatedAt, '2026-11-26T09:00:00.000Z');
  // Filters for follow-ups ("only poor condition", "exclude no records").
  assert.equal((await sampleSnapshot({ filters: { excludeNoRecords: true } })).inventoryCoverage.inScope, 2);
  assert.deepEqual((await sampleSnapshot({ filters: { condition: 'POOR' } })).evaluated.filter(e => e.inScope).map(e => e.id), ['TX-A']);
});

test('PDF: a real PDF that parses, with the same assets, counts, sources and limitations as the snapshot', async () => {
  const s = await sampleSnapshot();
  const pdf = await renderReportPdf(s, { now: NOW });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const ex = await extractPdfText(pdf);
  assert.equal(ex.status, 'SUCCESS');
  assert.ok(ex.pageCount >= 2);
  const text = ex.pages.flatMap(p => p.lines.map(l => l.cells.map(c => c.text).join(' '))).join('\n');
  for (const needle of ['Transformer Inspection Report', 'Executive summary', 'Inspection criteria', 'TX-A', 'Inspection required', 'Source references', 'Limitations', 'Asset locations', 'Thermographic inspection of LV connections', `Page 1 of ${ex.pageCount}`, 'RPT-20261126-abcdefgh'])
    assert.ok(text.includes(needle), needle);
  assert.ok(text.includes('TX_A_i26.pdf') || text.includes('TX-A_i26.pdf'), 'the source document is listed');
  assert.match(text, /Other evaluated assets/);
  assert.match(text, /TX-E/);
  assert.match(text, /could not be read/);
});

test('XLSX: a valid workbook with the register, history and sources; tracking fields blank; no formulas from documents', async () => {
  const s = await sampleSnapshot();
  const buf = await renderRegisterXlsx(s);
  assert.equal(buf.subarray(0, 2).toString(), 'PK', 'a zip container');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  assert.deepEqual(wb.worksheets.map(w => w.name), ['Inspection Register', 'Inspection History', 'Sources and Criteria']);
  const reg = wb.getWorksheet('Inspection Register');
  const header = reg.getRow(1).values.slice(1);
  for (const h of ['Asset ID', 'IFC GlobalId', 'Inspection Classification', 'Inspection Requirement Reason', 'Assigned To', 'Planned Inspection Date', 'Inspection Tracking Status', 'Maintenance Team Notes', 'Source References']) assert.ok(header.includes(h), h);
  assert.equal(reg.rowCount - 1, s.summary.included, 'one row per included asset');
  const row = Object.fromEntries(header.map((h, i) => [h, reg.getRow(2).getCell(i + 1).value]));
  assert.equal(row['Asset ID'], 'TX-A');
  assert.equal(row['Inspection Classification'], 'Inspection required');
  assert.ok(row['Latest Inspection Date'] instanceof Date);
  for (const h of ['Assigned To', 'Planned Inspection Date', 'Inspection Tracking Status', 'Maintenance Team Notes']) assert.equal(row[h], null, `${h} left blank`);
  assert.equal(reg.views[0].state, 'frozen');
  assert.ok(reg.autoFilter);
  const all = [];
  for (const w of wb.worksheets) w.eachRow(r => r.eachCell(c => all.push(c)));
  assert.ok(!all.some(c => c.formula || c.type === ExcelJS.ValueType.Formula), 'no formulas');
  assert.ok(!all.some(c => typeof c.value === 'string' && /^[=+\-@]/.test(c.value)), 'no cell starts with a formula character');
  assert.equal(safeCell('=HYPERLINK("x")'), '\'=HYPERLINK("x")');
  const hist = wb.getWorksheet('Inspection History');
  assert.equal(hist.rowCount - 1, s.assets.reduce((n, a) => n + a.inspections.length, 0));
  const src = wb.getWorksheet('Sources and Criteria');
  const items = []; src.eachRow(r => items.push(String(r.getCell(1).value)));
  for (const k of ['Assets evaluated', 'Criterion', 'Missing inspection records', 'Could not be assessed', 'Limitation']) assert.ok(items.includes(k), k);
});

test('email: written from the snapshot, a draft only; .eml with the real attachments and the group as recipient', async () => {
  const s = await sampleSnapshot();
  const files = [{ artifactId: 'aaaaaaaaaaaa', filename: s.names.pdfFile }, { artifactId: 'bbbbbbbbbbbb', filename: s.names.xlsxFile }];
  const d = draftEmail(s, { attachments: files });
  assert.equal(d.status, 'DRAFT_NEEDS_REVIEW');
  assert.equal(d.recipientGroup, 'Electrical Maintenance Team');
  assert.deepEqual(d.recipientAddresses, [], 'no address invented');
  assert.equal(d.subject, 'Seagirt — Transformers requiring inspection');
  assert.match(d.body, /^Hi Team,/);
  assert.match(d.body, /1 transformer has been identified as requiring inspection: TX-A\./);
  assert.match(d.body, /attached report and register/);
  assert.match(d.body, /Inspection history could not be established for 2 assets/);
  assert.deepEqual(d.attachmentIds, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  const short = draftEmail(s, { attachments: files, style: 'short' });
  assert.ok(short.body.length < d.body.length);
  assert.match(short.body, /1 transformer has been identified/);
  const pdf = Buffer.from('%PDF-1.4 test');
  const eml = toEml(d, [{ filename: s.names.pdfFile, mime: 'application/pdf', bytes: pdf }], { now: NOW }).toString();
  assert.match(eml, /^To: Electrical Maintenance Team:;\r\n/);
  assert.match(eml, /X-Unsent: 1/);
  assert.match(eml, /Content-Disposition: attachment; filename="Transformer_Inspection_Report_2026-11-26.pdf"/);
  assert.ok(eml.includes(pdf.toString('base64')));
});

// ---- the endpoint: one job, real ACC reads through the document cache, owner-only files ----

const MODEL = readFileSync(new URL('./fixtures/ifc/seagirt-compare-v2.ifc', import.meta.url));
function harness(pdfs) {
  const tree = { top: { folders: [{ id: 'docs', name: 'Asset Documentation' }], files: [] }, docs: { folders: [{ id: 'f2', name: '02_Transformers' }], files: [] }, f2: { folders: [], files: Object.keys(pdfs) } };
  const client = {
    async getAll(path) {
      const folderId = decodeURIComponent(/folders\/([^/]+)\/contents/.exec(path)[1]);
      const node = tree[folderId] ?? { folders: [], files: [] };
      const id = f => `urn:item:${folderId}/${f}?version=1`;
      return { data: [...node.folders.map(f => ({ type: 'folders', id: f.id, attributes: { displayName: f.name } })),
        ...node.files.map(f => ({ type: 'items', id: `urn:item:${folderId}/${f}`, attributes: { displayName: f }, relationships: { tip: { data: { id: id(f) } } }, links: { webView: { href: `https://acc.autodesk.com/${f}` } } }))],
        included: node.files.map(f => ({ type: 'versions', id: id(f), attributes: { name: f, versionNumber: 1, fileType: 'pdf', storageSize: 1000, lastModifiedTime: '2026-11-25T08:00:00Z' } })) };
    },
    async get() { return { data: {} }; },
  };
  const files = { hub: { id: 'h' }, project: { id: 'b.p', name: 'Seagirt Electrical Digital Twin POC' }, topFolders: [{ id: 'top', name: 'top' }],
    files: [{ fileName: 'net.ifc', itemId: 'urn:i', tipVersionId: 'urn:model?version=2', versions: [{ id: 'urn:model?version=2', versionNumber: 2 }] }] };
  const streamed = [];
  const api = createIfcSpatialApi({ aps: { dataClient: () => client, projectFiles: async () => files, sessionId: req => req.headers.sid ?? null }, cacheDir: mkdtempSync(join(tmpdir(), 'reports-api-')),
    logger: { info() {}, warn() {}, error() {} }, download: async () => ({ bytes: MODEL }), now: () => NOW,
    openStream: async (c, p, versionId) => {
      const name = decodeURIComponent(versionId.split('/').pop().split('?')[0]);
      streamed.push(name);
      if (/DENY/.test(name)) throw new ApsError('FORBIDDEN', 403, 'You do not have permission to view this file in ACC.');
      return { body: Readable.from([Buffer.from(pdfs[name])]), contentLength: pdfs[name].length, fileName: name };
    } });
  async function call(method, path, body = null, sid = 's1') {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url: path, headers: sid ? { sid } : {} });
    let status, headers; const parts = [];
    await api.handle(req, { writeHead(s, h) { status = s; headers = h; }, write(c) { parts.push(Buffer.from(c)); }, end(b) { if (b) parts.push(Buffer.from(b)); } });
    const buf = Buffer.concat(parts);
    return { status, headers, buf, json: /json/.test(headers?.['content-type'] ?? '') ? JSON.parse(buf.toString() || 'null') : null };
  }
  return { api, call, streamed };
}
const until = async (h, id, sid = 's1') => {
  for (let i = 0; i < 400; i += 1) {
    const r = await h.call('GET', `/api/ifc-spatial/reports/${id}?file=net.ifc`, null, sid);
    if (!['PENDING', 'ANALYZING', 'GENERATING'].includes(r.json.status)) return r.json;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('report did not finish');
};

test('endpoint: a report job reads the documents once, writes a PDF, an XLSX and a draft with the same counts; only its owner can open them', async () => {
  const h = harness({
    'TX-M1_Transformer.pdf': specSheet({ assetId: 'TX-M1', fields: [['Rating', '34.5/13.8 kV, 12 MVA']] }),
    'TX-M1_Transformer_Inspection-2025-001_2025-04-10.pdf': inspectionReport({ assetId: 'TX-M1', date: '2025-04-10', number: 'M1-25', condition: 'FAIR (3/5)', findings: [['Radiators and cooling fans', 'Attention', 'Weep.']], actions: [['Re-sample oil for DGA', 'Medium', '2025-10-10']] }),
    'TX-M1_Transformer_Inspection-2026-001_2026-10-28.pdf': inspectionReport({ assetId: 'TX-M1', date: '2026-10-28', number: 'M1-26', condition: 'POOR (2/5)', findings: [['Radiators and cooling fans', 'Defect', 'Leaking.']],
      actions: [['Thermographic inspection of LV connections', 'High', '2026-12-15']] }),
    'TX-M2_Transformer.pdf': specSheet({ assetId: 'TX-M2', fields: [['Rating', '34.5/13.8 kV, 12 MVA']] }),
  });
  const body = { request: { question: 'Prepare a report of all transformers requiring inspection and draft an email to the electrical maintenance team.', kind: 'INSPECTION', types: ['TRANSFORMER'],
    typeLabels: [{ singular: 'transformer', plural: 'transformers' }], outputs: { pdf: true, xlsx: true, email: true }, recipientGroup: 'Electrical Maintenance Team' },
  assets: ['TX-M1', 'TX-M2', 'NOT-AN-ASSET'].map(id => input(id)), context: [] };
  assert.equal((await h.call('POST', '/api/ifc-spatial/reports?file=net.ifc', body)).json.error.code, 'MODEL_NOT_READY', 'no converted model: refused, not empty');
  await h.call('POST', '/api/ifc-spatial/prepare?file=net.ifc');
  const created = await h.call('POST', '/api/ifc-spatial/reports?file=net.ifc', body);
  assert.equal(created.status, 202);
  assert.match(created.json.reportId, /^RPT-20261126-[a-z0-9]{8}$/);
  const r = await until(h, created.json.reportId);
  assert.equal(r.status, 'COMPLETED', JSON.stringify(r.error ?? r.steps));
  assert.deepEqual(r.steps.map(s => [s.id, s.state]), [['select', 'done'], ['documents', 'done'], ['evaluate', 'done'], ['pdf', 'done'], ['xlsx', 'done'], ['email', 'done']]);
  assert.deepEqual(r.selectedIds, ['TX-M1']);
  assert.equal(r.summary.inspectionRequired, 1);
  assert.equal(r.coverage.evaluated, 2, 'the unknown id is left out, and said');
  assert.ok(r.limitations.some(l => /NOT-AN-ASSET/.test(l)));
  assert.equal(h.streamed.filter(n => /^TX-M1_/.test(n)).length, 3, 'each document read once');
  const [pdf, xlsx] = r.artifacts;
  assert.deepEqual([pdf.type, xlsx.type, pdf.filename, xlsx.filename], ['PDF', 'XLSX', 'Transformer_Inspection_Report_2026-11-26.pdf', 'Transformer_Inspection_Register_2026-11-26.xlsx']);
  // The files, parsed; the same asset in all three deliverables.
  const pdfRes = await h.call('GET', pdf.url);
  assert.equal(pdfRes.status, 200);
  assert.equal(pdfRes.headers['content-type'], 'application/pdf');
  const text = (await extractPdfText(pdfRes.buf)).pages.flatMap(p => p.lines.map(l => l.cells.map(c => c.text).join(' '))).join('\n');
  assert.ok(text.includes('TX-M1') && text.includes('Thermographic inspection of LV connections'));
  const xRes = await h.call('GET', `${xlsx.url}&download=1`);
  assert.match(xRes.headers['content-disposition'], /^attachment; filename="Transformer_Inspection_Register_2026-11-26.xlsx"/);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xRes.buf);
  assert.equal(wb.getWorksheet('Inspection Register').rowCount - 1, r.summary.included);
  assert.equal(wb.getWorksheet('Inspection Register').getRow(2).getCell(1).value, 'TX-M1');
  assert.match(r.emailDraft.body, /1 transformer has been identified as requiring inspection: TX-M1\./);
  assert.deepEqual(r.emailDraft.attachmentIds, [pdf.artifactId, xlsx.artifactId]);
  // Another session (or none) cannot see the report or its files.
  assert.equal((await h.call('GET', `/api/ifc-spatial/reports/${r.reportId}?file=net.ifc`, null, 's2')).status, 404);
  assert.equal((await h.call('GET', pdf.url, null, 's2')).status, 404);
  assert.equal((await h.call('GET', '/api/ifc-spatial/reports/RPT-20261126-../../x?file=net.ifc')).status, 404);
  // The same request again: the same report, nothing regenerated.
  const again = await h.call('POST', '/api/ifc-spatial/reports?file=net.ifc', body);
  assert.equal(again.json.reportId, r.reportId);
  assert.equal(again.json.reused, true);
  // "Make the email shorter": only the draft changes; the files are the same ones.
  const shorter = await h.call('PUT', `/api/ifc-spatial/reports/${r.reportId}/email?file=net.ifc`, { regenerate: true, style: 'short' });
  assert.ok(shorter.json.emailDraft.body.length < r.emailDraft.body.length);
  assert.deepEqual(shorter.json.artifacts.map(a => [a.artifactId, a.createdAt]), r.artifacts.map(a => [a.artifactId, a.createdAt]));
  // Edits are kept; removing the register leaves one attachment; the .eml carries exactly the attachments.
  const edited = await h.call('PUT', `/api/ifc-spatial/reports/${r.reportId}/email?file=net.ifc`, { recipientGroup: 'Operations Manager', subject: 'Edited subject', attachmentIds: [pdf.artifactId] });
  assert.deepEqual([edited.json.emailDraft.recipientGroup, edited.json.emailDraft.subject, edited.json.emailDraft.attachmentIds], ['Operations Manager', 'Edited subject', [pdf.artifactId]]);
  const eml = (await h.call('GET', r.emlUrl)).buf.toString();
  assert.match(eml, /^To: Operations Manager:;/);
  assert.match(eml, /filename="Transformer_Inspection_Report_2026-11-26.pdf"/);
  assert.doesNotMatch(eml, /\.xlsx"/);
  // A revision with a changed selection: a new report, the earlier one kept; no document downloaded again.
  const before = h.streamed.length;
  const rev = await h.call('POST', '/api/ifc-spatial/reports?file=net.ifc', { ...body, request: { ...body.request, filters: { condition: 'POOR' } }, revisionOf: r.reportId });
  const r2 = await until(h, rev.json.reportId);
  assert.notEqual(r2.reportId, r.reportId);
  assert.deepEqual([r2.revision, r2.revisionOf], [2, r.reportId]);
  assert.equal(h.streamed.length, before, 'the extraction cache is reused');
  assert.equal((await h.call('GET', `/api/ifc-spatial/reports/${r.reportId}?file=net.ifc`)).json.status, 'COMPLETED', 'the earlier revision stays');
});

test('endpoint: no matching assets: no empty files are generated; a draft says so', async () => {
  const h = harness({ 'TX-M2_Transformer.pdf': specSheet({ assetId: 'TX-M2', fields: [['Rating', '34.5/13.8 kV, 12 MVA']] }) });
  await h.call('POST', '/api/ifc-spatial/prepare?file=net.ifc');
  const created = await h.call('POST', '/api/ifc-spatial/reports?file=net.ifc', { request: { question: 'q', kind: 'INSPECTION', types: ['TRANSFORMER'], typeLabels: [{ singular: 'transformer', plural: 'transformers' }],
    outputs: { pdf: true, xlsx: true, email: true } }, assets: [input('TX-M2')] });
  const r = await until(h, created.json.reportId);
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.summary.inspectionRequired, 0);
  assert.deepEqual(r.artifacts, []);
  assert.deepEqual(r.steps.filter(s => ['pdf', 'xlsx'].includes(s.id)).map(s => s.state), ['skipped', 'skipped']);
  assert.match(r.emailDraft.body, /no transformers meet the inspection-required criteria/);
  assert.equal(r.coverage.insufficientEvidence, 1);
  // Not signed in: refused.
  assert.equal((await h.call('POST', '/api/ifc-spatial/reports?file=net.ifc', { request: { types: ['TRANSFORMER'] }, assets: [] }, null)).status, 401);
});

test('requests: compound intents and categories from the question; plain questions are not reports; follow-ups', async () => {
  const { parseReportRequest: p, parseReportFollowUp: f, REPORT_INTENT } = await import('../src/ifcSpatial/reportRequest.js');
  const K = new Set(['TRANSFORMER', 'CIRCUIT_BREAKER', 'CRANE', 'LIGHTING_CIRCUIT', 'SUBSTATION']);
  const full = p('Prepare a report of all transformers requiring inspection and draft an email to the electrical maintenance team.', { knownTypes: K });
  assert.deepEqual([full.intent, full.kind, full.types, full.outputs, full.recipientGroup], [REPORT_INTENT.COMPOSITE, 'INSPECTION', ['TRANSFORMER'], { pdf: true, xlsx: true, email: true }, 'Electrical Maintenance Team']);
  const which = p('Which transformers require inspection?', { knownTypes: K });
  assert.deepEqual([which.intent, which.evaluateOnly, which.outputs.email], [REPORT_INTENT.INSPECTION_QUERY, true, false], 'an evaluation, no files, no email');
  const report = p('Prepare a report of transformers requiring inspection.', { knownTypes: K });
  assert.deepEqual([report.intent, report.outputs.email], [REPORT_INTENT.REPORT, false], 'no email unless asked');
  assert.deepEqual(p('Prepare a report of all circuit breakers requiring inspection.', { knownTypes: K }).types, ['CIRCUIT_BREAKER']);
  const cranes = p('Generate a maintenance register for degraded cranes.', { knownTypes: K });
  assert.deepEqual([cranes.intent, cranes.kind, cranes.types, cranes.filters.status, cranes.outputs.pdf], [REPORT_INTENT.REGISTER, 'ASSET_LIST', ['CRANE'], 'DEGRADED', false]);
  assert.equal(p('Prepare a report of lighting assets with no power.', { knownTypes: K }).filters.status, 'NO_POWER');
  assert.equal(p('Create an Excel register of all substations and their technical specifications.', { knownTypes: K }).options.includeSpecs, true);
  assert.equal(p('Prepare a report of transformers due for inspection within 30 days.', { knownTypes: K }).options.dueWithinDays, 30);
  assert.equal(p('Generate a report of assets affected by a simulated transformer outage.', { knownTypes: K }).unsupported, true, 'said, not faked');
  for (const q of ['Show me all transformers', 'What does TX-M1 supply?', 'Before we replace TX-M2, summarize its inspection history and technical specifications.', 'Which assets have recurring inspection issues?', 'Summarize TX-M1 inspection history'])
    assert.equal(p(q, { knownTypes: K }), null, q);
  const last = { request: { types: ['TRANSFORMER'], filters: {}, options: {} } };
  const g = q => f(q, last, { knownTypes: K });
  assert.deepEqual(g('Make the email shorter.'), { email: { regenerate: true, style: 'short' } });
  assert.deepEqual(g('Change the recipient to the operations manager.'), { email: { regenerate: true, recipientGroup: 'Operations Manager' } });
  assert.deepEqual(g('Remove the Excel attachment.'), { email: { removeType: 'XLSX' } });
  assert.deepEqual(g('Include circuit breakers also.'), { revise: { types: ['TRANSFORMER', 'CIRCUIT_BREAKER'] } });
  assert.deepEqual(g('Generate the same report for lighting assets.'), { revise: { types: ['LIGHTING_CIRCUIT'] } });
  assert.deepEqual(g('Only include assets with poor condition.'), { revise: { filters: { condition: 'POOR' } } });
  assert.deepEqual(g('Exclude assets with no inspection records.'), { revise: { filters: { excludeNoRecords: true } } });
  assert.deepEqual(g('Include the last three inspections for each asset.'), { revise: { options: { historyDepth: 3 } } });
  assert.deepEqual(g('Add technical specifications to the report.'), { revise: { options: { includeSpecs: true } } });
  assert.deepEqual(g('Show me the assets included in the report.'), { show: true });
  assert.deepEqual(g('Regenerate using the latest IFC version.'), { revise: { regenerate: true } });
  assert.equal(g('What does TX-M1 supply?'), null);
});
