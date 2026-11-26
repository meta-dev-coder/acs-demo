import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { extractPdfText, layoutDocument, PAGE } from '../server/ifcSpatial/docExtract.mjs';
import { analyzeAssetDocuments, categoryOf, CLOSURE, documentDate, DOC_TYPE, formatQuantity, NOT_DOCUMENTED, normalizeDocument, operatingLoadOf, quantity, TREND } from '../server/ifcSpatial/docIntel.mjs';
import { createIfcSpatialApi } from '../server/ifcSpatial/api.mjs';
import { ApsError } from '../server/aps/oauth.mjs';
import { classifyDocumentQuestion, DOC_INTENT } from '../src/ifcSpatial/docQuestions.js';
import { docAnalysisHtml, docCompareAssetsHtml, docSay, fleetHtml, primaryCitation } from '../src/ifcSpatial/docAnswer.js';
import { documentPdf, inspectionReport, makePdf, specSheet } from './pdfFixtures.mjs';

// ---- controlled documents (known contents) ----

const SHEET = specSheet({ assetId: 'TX-A', globalId: 'GID-TXA', fields: [['VoltageLevel', '34.5 kV'], ['Rating', '34.5/13.8 kV, 12 MVA'], ['PrimaryVoltage', '34,500 V'],
  ['SecondaryVoltage', '13,800 V'], ['MaximumApparentPower', '12,000,000 VA'], ['Overall size L x W x H (m)', '8.40 x 4.50 x 4.20'], ['CapacitykW', '11,000']] });
const INS_2024 = inspectionReport({ assetId: 'TX-A', globalId: 'GID-TXA', date: '2024-03-14', number: 'INS-A-2024', condition: 'GOOD (4/5)', rating: '34.5/13.8 kV, 12 MVA',
  summary: ['Transformer in good condition. A light weep at radiator 3 was noted for monitoring.'],
  findings: [['Radiators and cooling fans', 'Attention', 'Light weep at radiator 3 lower flange.'], ['Bushings (HV and LV)', 'OK', 'Clean.'], ['On-load tap changer', 'OK', 'Counter 18,000.']],
  measures: [['Test', 'Result', 'Previous'], ['Moisture in oil (ppm)', '12', '11'], ['Dielectric breakdown (kV, 2 mm gap)', '52', '54']],
  actions: [['Re-check radiator 3 flange at next inspection', 'Low', '2025-03-14']] });
const INS_2025 = inspectionReport({ assetId: 'TX-A', globalId: 'GID-TXA', date: '2025-04-10', number: 'INS-A-2025', condition: 'FAIR (3/5)', rating: '34.5/13.8 kV, 12 MVA', conditions: 'Overcast, 14 deg C',
  summary: ['Condition downgraded to Fair. The radiator 3 weep has become an active drip and fan 4 has failed.'],
  findings: [['Radiators and cooling fans', 'Attention', 'Radiator 3 flange dripping. Fan 4 motor seized.'], ['Bushings (HV and LV)', 'OK', 'Clean.'], ['Conservator, breather and silica gel', 'Attention', 'Gel 60% saturated.']],
  measures: [['Test', 'Result', 'Previous (2024-03-14)'], ['Moisture in oil (ppm)', '18', '12'], ['Dielectric breakdown (kV, 2 mm gap)', '44', '52']],
  actions: [['Repair radiator 3 flange gasket', 'Medium', '2025-06-30'], ['Replace cooling fan 4 motor', 'Medium', '2025-06-30'], ['Re-sample oil for DGA', 'Medium', '2025-10-10']] });
const INS_2026 = inspectionReport({ assetId: 'TX-A', globalId: 'GID-TXA', date: '2026-10-28', number: 'INS-A-2026', condition: 'POOR (2/5)', rating: '34.5/13.8 kV, 12 MVA', conditions: 'Clear, 12 deg C',
  summary: ['Condition Poor. The radiator 3 valve is leaking and fan 4 is still out of service.', 'The 2025 repair actions were not completed.'],
  findings: [['Radiators and cooling fans', 'Defect', 'Fan 4 still failed (5 of 6 operate).'], ['Bushings (HV and LV)', 'Defect', 'Discolouration on LV X2 connector.'],
    ['Conservator, breather and silica gel', 'OK', 'Breather replaced 2025, gel dry.']],
  measures: [['Test', 'Result', 'Previous (2025-04-10)'], ['Moisture in oil (ppm)', '27', '18'], ['Dielectric breakdown (kV, 2 mm gap)', '33', '44']],
  actions: [['Prepare switching plan to carry Bus B loads during the outage', 'High', '2026-11-27']] });

const record = (fileName, n = 1, extra = {}) => ({ documentId: fileName.replace(/\W/g, '').slice(0, 24), fileName, versionNumber: n, accVersionId: `urn:v:${fileName}?version=${n}`, accItemId: `urn:i:${fileName}`, ...extra });
const read = async (fileName, bytes, opts) => normalizeDocument(record(fileName), await extractPdfText(bytes), opts);
const TX_A = { id: 'TX-A', name: 'Main transformer TX-A', ifcClass: 'IfcTransformer', globalId: 'GID-TXA' };
async function txA(docs = { sheet: SHEET, i24: INS_2024, i25: INS_2025, i26: INS_2026 }) {
  const out = [];
  for (const [name, bytes] of Object.entries(docs)) out.push(await read(`TX-A_${name}.pdf`, bytes, { assetId: 'TX-A' }));
  return out;
}

// ---- extraction ----

test('PDF text extraction: lines, bold labels, metadata; the text layer only', async () => {
  const ex = await extractPdfText(SHEET);
  assert.equal(ex.status, 'SUCCESS');
  assert.equal(ex.pageCount, 1);
  const label = ex.pages[0].lines.flatMap(l => l.cells).find(c => c.text === 'PrimaryVoltage');
  assert.equal(label.bold, true, 'Helvetica-Bold is a label');
  assert.equal(ex.pages[0].lines.flatMap(l => l.cells).find(c => c.text === '34,500 V').bold, false);
  assert.equal(ex.metadata.title, 'TX-A asset sheet');
  // A Buffer is accepted (the server reads into one).
  assert.equal((await extractPdfText(Buffer.from(SHEET))).status, 'SUCCESS');
});

test('multi-page documents: every item keeps its page; banners and page footers are not content', async () => {
  const blocks = [{ heading: 'Report' }, { kv: [['Inspection date', '2025-01-02']] }];
  for (let i = 0; i < 70; i += 1) blocks.push({ para: `Observation line ${i + 1}.` });
  blocks.push({ heading: 'Actions' }, { table: [['Action', 'Priority', 'Due'], ['Replace part 9', 'High', '2025-02-01']], xs: [48, 411, 474] });
  const ex = await extractPdfText(documentPdf(blocks));
  assert.ok(ex.pageCount >= 2);
  const layout = layoutDocument(ex);
  assert.ok(layout.banners.some(b => /FIXTURE DOCUMENT/.test(b.text)), 'the repeated banner is a banner');
  const all = JSON.stringify(layout.sections);
  assert.doesNotMatch(all, /Page \d of \d/, 'no footer in the content');
  assert.doesNotMatch(all, /FIXTURE DOCUMENT/);
  const actions = layout.sections.find(s => s.heading === 'Actions');
  assert.ok(actions.page > 1, 'a later section cites its own page');
  assert.equal(actions.tables[0].rows[0].page, ex.pageCount, 'the table row is on the last page');
  assert.ok(layout.sections.find(s => s.heading === 'Report').paragraphs.some(p => p.page === 2), 'paragraphs on page 2 cite page 2');
});

test('tables: columns from the header, wrapped cells joined to their row, a paragraph after the table is not a row', async () => {
  const pdf = documentPdf([{ heading: 'Examination results' },
    { table: [['Area', 'Item', 'Result', 'Notes'], ['Mechanical', 'Main hoist wire ropes', 'Defect', ['9 broken wires near the drum on', 'rope 2; approaching discard.']],
      ['Electrical', ['Drives and motors (insulation', 'test)'], 'OK', 'Within limits.']], xs: [48, 116, 264, 320] },
    { para: 'Interpretation: rope wear is consistent with the hours run, a long sentence that runs across every column of the table above.' }]);
  const layout = layoutDocument(await extractPdfText(pdf));
  const section = layout.sections.find(x => x.heading === 'Examination results');
  assert.ok(!JSON.stringify(layout.sections).includes('FIXTURE DOCUMENT'), 'a one-page header is a banner, by position');
  const t = section.tables[0];
  assert.deepEqual(t.columns.map(c => c.name), ['Area', 'Item', 'Result', 'Notes']);
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0].cells.Notes, '9 broken wires near the drum on rope 2; approaching discard.');
  assert.equal(t.rows[1].cells.Item, 'Drives and motors (insulation test)');
  assert.match(section.paragraphs[0].text, /^Interpretation:/);
});

test('scanned pages: no text layer is reported as unreadable (no OCR here), never guessed; a scan-only PDF fails', async () => {
  const mixed = await extractPdfText(inspectionReport({ assetId: 'TX-A', date: '2025-05-01', scanPage: true }));
  assert.equal(mixed.status, 'PARTIAL');
  assert.deepEqual(mixed.pages.map(p => p.status), [PAGE.TEXT, PAGE.NO_TEXT_LAYER]);
  const scan = await extractPdfText(makePdf([{ image: true, items: [] }, { image: true, items: [] }]));
  assert.equal(scan.status, 'FAILED');
  assert.match(scan.errors[0], /scanned document\); OCR is not available/);
  const doc = normalizeDocument(record('scan.pdf'), scan);
  assert.equal(doc.extractionStatus, 'FAILED');
  assert.equal(doc.documentType, null);
});

test('unreadable files: not a PDF, empty, corrupt or too large are failures with a reason', async () => {
  assert.match((await extractPdfText(Buffer.from('hello'))).errors[0], /not a PDF/);
  assert.match((await extractPdfText(new Uint8Array())).errors[0], /empty/);
  assert.equal((await extractPdfText(Buffer.from('%PDF-1.4 garbage'))).status, 'FAILED');
  assert.match((await extractPdfText(SHEET, { maxBytes: 100 })).errors[0], /limit/);
});

// ---- normalising and specifications ----

test('document types come from contents; the inspection date only from the report, not the upload, file name or PDF dates', async () => {
  const [sheet, ins] = [await read('TX-A_Transformer.pdf', SHEET), await read('TX-A_Transformer_Inspection-9999-01-01.pdf', INS_2025)];
  assert.equal(sheet.documentType, DOC_TYPE.TECHNICAL_SPECIFICATION);
  assert.equal(ins.documentType, DOC_TYPE.INSPECTION);
  assert.equal(ins.inspectionDate, '2025-04-10', 'from "Inspection date", not the 9999 in the file name');
  assert.equal(ins.pdfCreatedAt, '2026-01-01T00:00:00Z', 'kept apart');
  const undated = await read('x.pdf', inspectionReport({ assetId: 'TX-A', date: null }), {});
  assert.equal(undated.documentType, DOC_TYPE.INSPECTION, 'an inspection report by its heading');
  assert.equal(undated.inspectionDate, null);
  const uploaded = normalizeDocument(record('y.pdf', 1, { createTime: '2026-11-25T10:00:00Z', lastModifiedTime: '2026-11-25T11:00:00Z' }), await extractPdfText(INS_2025));
  assert.equal(uploaded.uploadedAt, '2026-11-25T10:00:00Z');
  assert.equal(uploaded.accModifiedAt, '2026-11-25T11:00:00Z');
  assert.equal(uploaded.inspectionDate, '2025-04-10');
  assert.equal(documentDate('14 March 2024'), '2024-03-14');
  assert.equal(documentDate('n/a'), null);
});

test('technical specifications: documented values with sources, units compared, "Not documented" for the rest, nothing invented', async () => {
  const a = analyzeAssetDocuments({ asset: TX_A, docs: [await read('TX-A_Transformer.pdf', SHEET, { assetId: 'TX-A' })] });
  const f = Object.fromEntries(a.specifications.keyFields.map(x => [x.key, x]));
  assert.equal(f.ratedPower.value, '12,000,000 VA');
  assert.equal(f.ratedPower.conflict, false, '12 MVA in the rating and 12,000,000 VA agree');
  assert.equal(f.primaryVoltage.conflict, false, '34.5 kV and 34,500 V agree');
  assert.equal(f.primaryVoltage.source.page, 1);
  assert.match(f.primaryVoltage.source.evidenceText, /34,500 V|34\.5\/13\.8 kV/);
  for (const key of ['manufacturer', 'serial', 'impedance', 'weight', 'vectorGroup']) assert.equal(f[key].value, NOT_DOCUMENTED, key);
  assert.ok(a.specifications.missing.includes('Manufacturer'));
  // Every documented value is in the text it cites (or read from a rating it cites).
  for (const field of a.specifications.keyFields.filter(x => !x.missing)) {
    for (const v of field.values) for (const s of v.sources) assert.ok(s.evidenceText.includes(v.value) || s.derived, `${field.key}: "${v.value}" is in "${s.evidenceText}"`);
  }
  assert.deepEqual(quantity('12 MVA'), { kind: 'apparentPower', si: 12e6 });
  assert.deepEqual(quantity('11,000', 'CapacitykW'), { kind: 'realPower', si: 11e6 });
  // Fields that do not fit the category are not asked for.
  assert.equal(categoryOf({ ifcClass: 'IfcTransportElement' }), 'crane');
  const crane = analyzeAssetDocuments({ asset: { id: 'STS-1', ifcClass: 'IfcTransportElement' }, docs: [] });
  assert.ok(!crane.specifications.keyFields.some(k => k.key === 'primaryVoltage'));
  assert.ok(crane.specifications.keyFields.some(k => k.key === 'ratedLoad'));
});

test('conflicting specifications: both values kept with their sources and flagged', async () => {
  const other = inspectionReport({ assetId: 'TX-A', globalId: 'GID-TXA', date: '2025-01-01', rating: '34.5/13.8 kV, 10 MVA' });
  const a = analyzeAssetDocuments({ asset: TX_A, docs: [await read('sheet.pdf', SHEET, { assetId: 'TX-A' }), await read('ins.pdf', other, { assetId: 'TX-A' })] });
  const power = a.specifications.keyFields.find(k => k.key === 'ratedPower');
  assert.equal(power.conflict, true);
  assert.deepEqual(power.values.map(v => v.value), ['12,000,000 VA', '10 MVA']);
  assert.equal(power.values[1].sources[0].documentId, 'inspdf');
  assert.ok(a.checks.some(c => /conflicting rated power: 12,000,000 VA vs 10 MVA/.test(c.text)));
  assert.match(a.summary, /differ between documents/);
});

// ---- inspections, trends and closure ----

test('inspection history: dates from the reports, latest first; condition, findings, measurements, actions', async () => {
  const a = analyzeAssetDocuments({ asset: TX_A, docs: await txA() });
  assert.deepEqual(a.inspections.timeline.map(t => t.inspectionDate), ['2026-10-28', '2025-04-10', '2024-03-14']);
  const latest = a.inspections.timeline[0];
  assert.deepEqual([latest.condition.label, latest.condition.score, latest.condition.scale], ['Poor', 2, 5]);
  assert.deepEqual(latest.counts, { defects: 2, attention: 0, ok: 1, actions: 1 });
  assert.match(latest.mainFinding.text, /^Condition Poor\./);
  assert.equal(a.inspections.comparison.condition.trend, TREND.WORSENING_WITH_EVIDENCE);
  assert.deepEqual(a.inspections.comparison.condition.history.map(h => h.score), [4, 3, 2]);
});

test('recurring, worsening, new and resolved findings: only from two dated reports, each with both citations', async () => {
  const a = analyzeAssetDocuments({ asset: TX_A, docs: await txA() });
  const by = Object.fromEntries(a.inspections.comparison.findings.map(f => [f.item, f]));
  assert.equal(by['Radiators and cooling fans'].trend, TREND.WORSENING_WITH_EVIDENCE, 'Attention in 2025, Defect in 2026');
  assert.equal(by['Radiators and cooling fans'].recurring, true);
  assert.deepEqual(by['Radiators and cooling fans'].history.map(h => h.date), ['2024-03-14', '2025-04-10', '2026-10-28']);
  assert.ok(by['Radiators and cooling fans'].history.every(h => h.citation.documentId && h.citation.page === 1));
  assert.equal(by['Bushings (HV and LV)'].trend, TREND.NEW_FINDING, 'OK in 2025, Defect in 2026');
  assert.equal(by['Conservator, breather and silica gel'].trend, TREND.RESOLVED_WITH_EVIDENCE, 'recorded OK later');
  // Measurements: worsening by the usual reading of the test (marked derived), with the different conditions said.
  const moisture = a.inspections.comparison.measurements.find(m => /Moisture/.test(m.name));
  assert.equal(moisture.trend, TREND.WORSENING_WITH_EVIDENCE);
  assert.deepEqual([moisture.change.from, moisture.change.to], ['18', '27']);
  assert.match(moisture.basis, /derived/);
  assert.equal(a.inspections.comparison.measurements.find(m => /Dielectric/.test(m.name)).trend, TREND.WORSENING_WITH_EVIDENCE, 'lower breakdown is worse');
  assert.ok(a.inspections.comparison.caveats.some(c => /different conditions/.test(c.text)));
  // One report alone: no trend.
  const one = analyzeAssetDocuments({ asset: TX_A, docs: await txA({ i26: INS_2026 }) });
  assert.ok(one.inspections.comparison.findings.every(f => f.trend === TREND.INSUFFICIENT_EVIDENCE));
  assert.equal(one.inspections.comparison.condition, null);
});

test('closure: completed only when a later document says so; a statement about earlier repairs; otherwise not verified', async () => {
  const a = analyzeAssetDocuments({ asset: TX_A, docs: await txA() });
  const by = Object.fromEntries(a.inspections.comparison.actions.map(x => [x.action, x.closure]));
  assert.equal(by['Repair radiator 3 flange gasket'].status, CLOSURE.NOT_COMPLETED_WITH_EVIDENCE);
  assert.match(by['Repair radiator 3 flange gasket'].citation.evidenceText, /2025 repair actions were not completed|radiator 3 valve is leaking/);
  assert.equal(by['Replace cooling fan 4 motor'].status, CLOSURE.NOT_COMPLETED_WITH_EVIDENCE, '"fan 4 is still out of service"');
  assert.equal(by['Re-sample oil for DGA'].status, CLOSURE.NOT_VERIFIED, 'not a repair: the "repair actions" statement does not cover it');
  assert.equal(by['Re-check radiator 3 flange at next inspection'].status, CLOSURE.NOT_VERIFIED, 'a later inspection existing is not proof it was done');
  assert.equal(by['Prepare switching plan to carry Bus B loads during the outage'].status, CLOSURE.NOT_VERIFIED);
  const open = a.outstanding.filter(o => o.kind === 'ACTION');
  assert.ok(open.every(o => ['Closure not verified', 'Not completed (documented)'].includes(o.status)));
  // A later "replaced" for the same item is completion evidence.
  const fixed = inspectionReport({ assetId: 'TX-A', globalId: 'GID-TXA', date: '2025-09-01', number: 'INS-A-2025b', findings: [['Radiators and cooling fans', 'OK', 'Fan 4 motor replaced, all fans operate.']] });
  const b = analyzeAssetDocuments({ asset: TX_A, docs: await txA({ i25: INS_2025, fix: fixed }) });
  assert.equal(b.inspections.comparison.actions.find(x => x.action === 'Replace cooling fan 4 motor').closure.status, CLOSURE.COMPLETED_WITH_EVIDENCE);
});

test('missing evidence is said: no inspections, no datasheet, unreadable documents; another asset\'s document is not used', async () => {
  const noIns = analyzeAssetDocuments({ asset: TX_A, docs: await txA({ sheet: SHEET }) });
  assert.match(noIns.summary, /No inspection reports are among TX-A's linked documents/);
  assert.equal(docSay(noIns, { intent: 'ASSET_INSPECTION_HISTORY' }), 'No inspection reports were found among TX-A\'s linked documents.');
  assert.ok(noIns.checks.some(c => /No inspection report is linked/.test(c.text)));
  const noSheet = analyzeAssetDocuments({ asset: TX_A, docs: await txA({ i26: INS_2026 }) });
  assert.match(noSheet.summary, /No technical datasheet or asset sheet is among the linked documents/);
  assert.match(docAnalysisHtml(noSheet, { intent: 'ASSET_TECHNICAL_SPECIFICATIONS' }), /do not include a readable technical datasheet/);
  const bad = analyzeAssetDocuments({ asset: TX_A, docs: [...await txA({ sheet: SHEET }), await read('TX-A_broken.pdf', Buffer.from('%PDF-1.4 broken'), { assetId: 'TX-A' })],
    failures: [{ documentId: 'denied', fileName: 'TX-A_secret.pdf', code: 'ACCESS_DENIED', message: 'Your ACC account cannot read this document.' }] });
  assert.equal(bad.documents.unreadable, 2);
  assert.match(bad.summary, /2 could not be read/);
  assert.deepEqual(bad.sources.filter(s => !['SUCCESS', 'PARTIAL'].includes(s.status)).map(s => s.status).sort(), ['ACCESS_DENIED', 'FAILED']);
  const wrong = await read('TX-A_x.pdf', inspectionReport({ assetId: 'TX-A', statedAssetId: 'TX-B', date: '2025-01-01', findings: [['Tank', 'Defect', 'Leak.']] }), { assetId: 'TX-A' });
  const notUsed = analyzeAssetDocuments({ asset: TX_A, docs: [wrong] });
  assert.equal(notUsed.documents.notUsed, 1);
  assert.equal(notUsed.inspections.count, 0, 'TX-B\'s report is not read as TX-A\'s');
});

test('citations are structured and real: each cites a document, version, page and a line that is in that page', async () => {
  const docs = await txA();
  const a = analyzeAssetDocuments({ asset: TX_A, docs });
  const lines = new Map(docs.map(d => [d.documentId, d]));
  const all = [...a.outstanding.map(o => o.citation), ...a.inspections.timeline.map(t => t.dateCitation), ...a.specifications.keyFields.filter(f => f.source).map(f => f.source),
    ...a.inspections.comparison.findings.flatMap(f => f.history.map(h => h.citation))];
  assert.ok(all.length > 15);
  for (const c of all) {
    assert.ok(lines.has(c.documentId), 'a retrieved document');
    assert.equal(c.version, 1);
    assert.ok(Number.isInteger(c.page) && c.page >= 1);
    const doc = lines.get(c.documentId);
    const text = JSON.stringify(doc.layout.sections.filter(s => s.page <= c.page));
    assert.ok(c.evidenceText.split(/[:|]/).every(part => text.includes(part.trim().slice(0, 20))), `"${c.evidenceText}" is extracted text`);
  }
});

test('replacement readiness: facts, derived observations and checks kept apart; no unconditional recommendation', async () => {
  const a = analyzeAssetDocuments({ asset: TX_A, docs: await txA() });
  assert.deepEqual([...new Set(a.checks.map(c => c.basis))].sort(), ['CHECK_REQUIRED', 'DERIVED', 'DOCUMENTED', 'NETWORK']);
  assert.ok(a.checks.some(c => /switching plan/.test(c.text) && c.basis === 'DOCUMENTED'));
  assert.ok(a.checks.some(c => /Weight is not documented/.test(c.text)));
  assert.match(a.boundary, /warrant engineering review/);
  assert.doesNotMatch(JSON.stringify({ ...a, boundary: null }), /must be replaced|should be replaced|recommend(ed)? replac/i, 'only the boundary sentence mentions it, to say it is not established');
  assert.match(a.boundary, /do not by themselves establish/);
});

// ---- the answer card ----

test('the review workspace: three tabs over one analysis, a question-specific Overview; numbered citations; nothing asset-specific', async () => {
  const a = analyzeAssetDocuments({ asset: TX_A, docs: await txA() });
  const impact = { assetId: 'TX-A', lost: ['L1', 'L2', 'L3'], rerouted: 0, candidates: [{ switchId: 'BT-1', restored: 3, overloads: [], capacity: 'OK' }, { switchId: 'AT-2', restored: 2, overloads: ['TX-B'], capacity: 'OVERLOAD' }],
    upstream: 'CB-1', downstream: ['CB-2'], pathVerified: true };
  const html = docAnalysisHtml(a, { intent: 'ASSET_REPLACEMENT_READINESS', impact, status: { label: 'Degraded', tone: 'warn' } });
  const tabs = [...html.matchAll(/role="tab"[^>]*data-doc-tab="(\w+)" aria-selected="(\w+)"/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(tabs, [['overview', 'true'], ['inspections', 'false'], ['specifications', 'false']]);
  assert.doesNotMatch(html, /data-doc-panel="replacement"|data-doc-tab="replacement"/, 'no Replacement tab');
  for (const k of ['inspections', 'specifications']) assert.match(html, new RegExp(`data-doc-panel="${k}" hidden`));
  // Overview: the summary first, the documented trend, three metrics, at most three findings, then the next steps.
  const ov = html.slice(html.indexOf('data-doc-panel="overview"'), html.indexOf('data-doc-panel="inspections"'));
  assert.ok(ov.indexOf('Engineering review required') < ov.indexOf('tw-ct'));
  assert.match(ov, /aria-label="Documented condition rating: 2024-03-14: Good 4\/5, 2025-04-10: Fair 3\/5, 2026-10-28: Poor 2\/5"/);
  assert.equal((ov.match(/class="tw-rmetric is-/g) ?? []).length, 3);
  assert.match(ov, /<b>2<\/b><span>Latest defects/);
  assert.ok(ov.includes(`<b>${a.review.counts.actionsWithoutVerifiedClosure}</b><span>Actions not verified closed`));
  assert.ok((ov.match(/class="tw-concern"/g) ?? []).length <= 3);
  // "Before replacement": the checks by purpose, the missing specs referred to (not listed again), the electrical model as candidates.
  assert.match(ov, /<h5 class="tw-rh">Recommended next steps<\/h5>\s*<details class="tw-rstep" data-next-steps="replacement"><summary><span>Before replacement<\/span><small>\d+ checks · 3 consumers affected in the model<\/small>/, 'collapsed until opened');
  assert.doesNotMatch(ov, /<details class="tw-rstep"[^>]* open/);
  for (const g of ['Electrical compatibility', 'Physical requirements', 'Maintenance readiness', 'Operational impact']) assert.ok(ov.includes(g), g);
  assert.doesNotMatch(ov, /manufacturer, model, serial number/i);
  assert.match(ov, /data-doc-tab="specifications" data-doc-open="missing"/);
  assert.match(ov, /Modeled overload: TX-B/);
  assert.match(ov, /Operational availability is not verified/);
  assert.match(ov, /data-act="docSimulate" data-asset-id="TX-A"/);
  assert.match(ov, /not an authorization to replace/);
  assert.doesNotMatch(html, /\bClose BT-1\b|Isolate upstream at/);
  assert.match(html, /Illustrative demo records · Not real inspections/);
  assert.match(html, /tw-rev-status is-warn[^>]*>Degraded/);
  // The next steps follow the question.
  const overviewOf = o => { const h = docAnalysisHtml(a, o); return h.slice(h.indexOf('data-doc-panel="overview"'), h.indexOf('data-doc-panel="inspections"')); };
  const maint = overviewOf({ intent: 'ASSET_MAINTENANCE_HISTORY' });
  assert.match(maint, />Maintenance considerations</);
  assert.match(maint, /Repair radiator 3 flange gasket \(raised 2025-04-10, due 2025-06-30\): documented as not completed/);
  assert.match(maint, /Actions not verified closed[\s\S]*Documented as not completed/);
  assert.doesNotMatch(maint, /Before replacement|docSimulate/, 'the electrical model is for replacement questions');
  const cond = overviewOf({ intent: 'ASSET_CONDITION_TREND', focus: 'TREND' });
  assert.match(cond, />Condition assessment</);
  assert.match(cond, /Assess the worsening radiators and cooling fans/);
  assert.match(cond, /Worsening finding/);
  assert.match(overviewOf({ intent: 'ASSET_DOCUMENT_SUMMARY' }), /Recommended next steps<\/h5>\s*<details class="tw-rstep" data-next-steps="general"><summary><span>General review</);
  const specOv = overviewOf({ intent: 'ASSET_TECHNICAL_SPECIFICATIONS' });
  assert.match(specOv, /Specification gaps/);
  assert.doesNotMatch(specOv, /tw-ct"|Key findings/);
  // Citations: numbers per document, each pointing at an analysed source and keeping its page and line.
  const refs = [...html.matchAll(/data-ref-doc="([^"]+)"(?: data-ref-page="(\d+)")?/g)];
  assert.ok(refs.length > 20);
  assert.ok(refs.every(([, id]) => a.sources.some(s => s.documentId === id)));
  assert.ok(refs.every(([, , page]) => page), 'every reference keeps its page');
  const sheet = a.sources.find(s => s.documentType === 'TECHNICAL_SPECIFICATION');
  assert.match(html, new RegExp(`data-src-doc="${sheet.documentId}" data-src-n="1"`), 'the asset sheet is [1]');
  assert.doesNotMatch(html, /class="tw-cite"/, 'no large citation chips');
  // Inspections: findings and corrective actions with separate counts.
  const ins = html.slice(html.indexOf('data-doc-panel="inspections"'), html.indexOf('data-doc-panel="specifications"'));
  assert.match(ins, /Latest defects[\s\S]*Unique historical findings[\s\S]*Corrective actions[\s\S]*Verified closed[\s\S]*Without verified closure/);
  // Specifications: readable units; missing fields grouped once.
  const sp = html.slice(html.indexOf('data-doc-panel="specifications"'));
  assert.match(sp, /<b>12 MVA<\/b>/);
  assert.match(sp, /Voltage ratio<\/small><b>34\.5 \/ 13\.8 kV/);
  assert.match(sp, /\d+ key specifications missing/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /TX-M2/, 'nothing about another asset');
  // Which tab a question opens.
  const tabOf = o => /data-doc-tab="(\w+)" aria-selected="true"/.exec(docAnalysisHtml(a, o))[1];
  assert.equal(tabOf({ intent: 'ASSET_TECHNICAL_SPECIFICATIONS' }), 'specifications');
  assert.equal(tabOf({ intent: 'ASSET_INSPECTION_HISTORY', focus: 'HISTORY' }), 'inspections');
  assert.equal(tabOf({ intent: 'ASSET_CONDITION_TREND', focus: 'CLOSURE' }), 'overview');
  assert.match(docAnalysisHtml(a, { intent: 'ASSET_CONDITION_TREND', focus: 'CLOSURE' }), /<details class="tw-rsub tw-racts" open>/, 'the actions list opened for a closure question');
  assert.match(docAnalysisHtml(a, { intent: 'ASSET_INSPECTION_HISTORY', focus: 'LATEST' }), /<details class="tw-insp" open>/, 'the latest inspection opened when asked for');
  assert.doesNotMatch(docAnalysisHtml(a, { intent: 'ASSET_INSPECTION_HISTORY', focus: 'HISTORY' }), /<details class="tw-insp" open>/, 'collapsed by default');
  // No ratings, no electrical model: no empty chart, no empty impact.
  const sheetOnly = analyzeAssetDocuments({ asset: TX_A, docs: await txA({ sheet: SHEET }) });
  const plain = docAnalysisHtml(sheetOnly, { intent: 'ASSET_REPLACEMENT_READINESS' });
  assert.doesNotMatch(plain, /tw-ct"/);
  assert.doesNotMatch(plain, /Operational impact|docSimulate/);
  assert.equal(primaryCitation(a, 'ASSET_REPLACEMENT_READINESS').documentId, a.outstanding[0].citation.documentId);
  assert.match(docSay(a, { intent: 'ASSET_TECHNICAL_SPECIFICATIONS', field: 'ratedPower' }), /^TX-A's rated power: 12,000,000 VA\.$/);
  // Comparison and fleet cards keep their layout.
  const b = analyzeAssetDocuments({ asset: { ...TX_A, id: 'TX-B' }, docs: [] });
  const cmp = docCompareAssetsHtml([a, b]);
  assert.match(cmp, /TX-A vs TX-B/);
  assert.match(cmp, /No inspection report/);
  assert.match(fleetHtml({ checkedAssets: 2, withInspections: 1, assets: [{ assetId: 'TX-A', inspections: 3, recurring: [{ item: 'Radiators', trend: 'RECURRING_FINDING', basis: 'x', citations: [{ documentId: 'd', page: 1 }] }], worsening: 2 }] }), /data-doc-cite="d"/);
});

test('next steps are derived for any asset: a crane with one report and no datasheet', async () => {
  const pdf = inspectionReport({ assetId: 'STS-02', date: '2026-02-01', number: 'C1', condition: 'FAIR (3/5)', summary: ['Hoist ropes worn.'],
    findings: [['Main hoist wire ropes', 'Defect', '9 broken wires near the drum.']], actions: [['Replace main hoist ropes', 'High', '2026-03-01']] });
  const doc = normalizeDocument(record('crane.pdf'), await extractPdfText(pdf));
  const a = analyzeAssetDocuments({ asset: { id: 'STS-02', ifcClass: 'IfcTransportElement', name: 'Ship-to-shore crane' }, docs: [doc] });
  const steps = a.review.nextSteps;
  assert.ok(steps.condition.some(x => /further inspection is needed to establish a trend/.test(x.text)));
  assert.ok(steps.maintenance.some(x => /Replace main hoist ropes \(raised 2026-02-01, due 2026-03-01\): no record of completion/.test(x.text)));
  assert.ok(steps.specifications.some(x => /technical datasheet/.test(x.text)));
  assert.ok(steps.general.length >= 2 && steps.general.length <= 3);
  for (const m of ['general', 'maintenance', 'condition', 'specifications']) for (const x of steps[m]) assert.ok(['DOCUMENTED', 'DERIVED', 'CHECK_REQUIRED'].includes(x.basis), `${m}: ${x.text}`);
  assert.doesNotMatch(JSON.stringify(a.review), /transformer|MVA|kV/i, 'nothing from another category');
  const html = docAnalysisHtml(a, { intent: 'ASSET_MAINTENANCE_HISTORY' });
  assert.match(html, /Crane · Actions and maintenance/);
  assert.match(html, />Maintenance considerations</);
});

test('review data: distinct counts, one issue per component, the documented trend, MW is not divided by MVA', async () => {
  const a = analyzeAssetDocuments({ asset: TX_A, docs: await txA() });
  const r = a.review;
  assert.deepEqual([r.counts.latestDefects, r.counts.latestAttention], [2, 0]);
  assert.equal(r.counts.actions, 5, 'every action any report raised');
  assert.equal(r.counts.actionsClosedVerified + r.counts.actionsWithoutVerifiedClosure, r.counts.actions);
  assert.equal(r.counts.uniqueFindings, new Set(a.inspections.comparison.findings.map(f => f.item)).size);
  assert.equal(r.counts.outstandingItems, a.outstanding.length);
  assert.match(r.counts.outstandingExplained, /latest-report findings \+ \d+ operating restrictions? \+ \d+ actions without verified closure/);
  // Radiators across three reports: one component, three observations.
  const rad = r.components.filter(c => c.item === 'Radiators and cooling fans');
  assert.equal(rad.length, 1);
  assert.deepEqual(rad[0].observations.map(o => o.date), ['2024-03-14', '2025-04-10', '2026-10-28']);
  assert.ok(rad[0].actions.some(x => /fan 4/i.test(x.action)), 'its related actions');
  assert.deepEqual(r.conditionTrend.map(p => [p.date, p.score]), [['2024-03-14', 4], ['2025-04-10', 3], ['2026-10-28', 2]]);
  assert.ok(r.concerns.length <= 3);
  assert.ok(r.concerns.every(c => c.citations.length && c.citations.every(x => a.sources.some(s => s.documentId === x.documentId))));
  assert.equal(r.conclusion.title, 'Engineering review required');
  assert.doesNotMatch(r.conclusion.text, /must be replaced|should be replaced/i);
  assert.deepEqual(r.checkGroups.map(g => g.purpose), ['ELECTRICAL', 'PHYSICAL', 'MAINTENANCE', 'OPERATIONAL']);
  // Units for reading; the source value kept.
  const power = a.specifications.keyFields.find(f => f.key === 'ratedPower');
  assert.deepEqual([power.value, power.display, power.unitKind], ['12,000,000 VA', '12 MVA', 'apparentPower']);
  assert.equal(formatQuantity(quantity('11,000', 'CapacitykW')), '11 MW', 'real power stays real power');
  assert.equal(formatQuantity(quantity('13,800 V')), '13.8 kV');
  // A report's "X MW (about N% of nameplate)": kept as stated, flagged, never recomputed as a loading.
  const load = operatingLoadOf({ value: 'In service. Load at inspection 5.4 MW (about 45% of nameplate).', citation: { documentId: 'd', page: 1 } });
  assert.deepEqual([load.value, load.kind, load.statedPercent], ['5.4 MW', 'realPower', 45]);
  assert.match(load.note, /unity power factor/);
  assert.equal(operatingLoadOf({ value: 'Load 7 MVA (58%)' }).note, null, 'apparent power against an MVA nameplate is a like-for-like ratio');
});

test('observations: a bare grading ("Serious.") qualifies the sentence before it', async () => {
  const pdf = documentPdf([{ heading: 'Report' }, { kv: [['Inspection date', '2026-01-02']] }, { heading: 'Infrared thermography' }, { para: 'LV bushing X2 connector 38 °C above adjacent phases. Serious.' }]);
  const doc = normalizeDocument(record('ir.pdf'), await extractPdfText(pdf));
  const ins = analyzeAssetDocuments({ asset: TX_A, docs: [doc] }).inspections.timeline[0];
  assert.deepEqual(ins.observations.map(o => [o.text, o.severity]), [['LV bushing X2 connector 38 °C above adjacent phases. Serious.', 'DEFECT']]);
});

// ---- routing ----

test('routing: document questions go to document analysis, not "locate the asset"; follow-ups use the conversation\'s asset', () => {
  const ids = new Set(['TX-M1', 'TX-M2', 'USS-1', 'STS-02']);
  const r = (q, o = {}) => classifyDocumentQuestion(q, { assetIds: ids, ...o });
  assert.deepEqual([r('Before we replace TX-M1, summarize its inspection history and technical specifications.').intent, r('Before we replace TX-M1, summarize its inspection history and technical specifications.').assetId], [DOC_INTENT.REPLACEMENT_READINESS, 'TX-M1']);
  assert.equal(r('Summarize TX-M1 inspection history.').intent, DOC_INTENT.INSPECTION_HISTORY);
  assert.equal(r('Show technical specifications for TX-M2.').intent, DOC_INTENT.TECHNICAL_SPECIFICATIONS);
  assert.equal(r('What defects were reported for USS-1?').focus, 'DEFECTS');
  assert.equal(r("Has TX-M1's condition deteriorated over time?").intent, DOC_INTENT.CONDITION_TREND);
  assert.equal(r('What should we verify before replacing TX-M1?').intent, DOC_INTENT.REPLACEMENT_READINESS);
  assert.deepEqual([r('Compare the latest two inspection reports for TX-M1.').intent, r('Compare the latest two inspection reports for TX-M1.').compare], [DOC_INTENT.DOCUMENT_COMPARISON, 'REPORTS']);
  assert.deepEqual(r('Compare the latest inspections of TX-M1 and TX-M2.').assetIds, ['TX-M1', 'TX-M2']);
  assert.equal(r('Which assets have recurring inspection issues?').intent, DOC_INTENT.FLEET);
  // Follow-ups: the asset of the conversation; switching assets when another is named.
  const ctx = { contextAssetId: 'TX-M1', lastAnalysis: {} };
  assert.deepEqual([r('What is the rated capacity?', ctx).assetId, r('What is the rated capacity?', ctx).field], ['TX-M1', 'ratedPower']);
  assert.equal(r('Was the same defect reported in earlier inspections?', ctx).intent, DOC_INTENT.CONDITION_TREND);
  assert.equal(r('Has that issue been resolved?', ctx).focus, 'CLOSURE');
  assert.equal(r('Which inspection recommended corrective action?', ctx).intent, DOC_INTENT.MAINTENANCE_HISTORY);
  assert.equal(r('Show the document where this was mentioned', ctx).intent, DOC_INTENT.SHOW_SOURCE);
  assert.equal(r('Which downstream assets would be affected during replacement?', ctx).intent, DOC_INTENT.REPLACEMENT_IMPACT);
  assert.equal(r('Create a replacement checklist based on the available documents.', ctx).intent, DOC_INTENT.REPLACEMENT_READINESS);
  assert.equal(r('Summarize TX-M2 inspection history', ctx).assetId, 'TX-M2', 'a named asset replaces the conversation\'s');
  // Follow-ups on a document review: answered from the analysis already read, on the right tab.
  const last = { asset: { id: 'TX-M2' }, review: { components: [{ item: 'Radiators and cooling fans', latestNote: 'Fan 4 still failed', observations: [{}, {}, {}] }, { item: 'Bushings (HV and LV)', observations: [{}] }] } };
  const m2 = { contextAssetId: 'TX-M2', lastAnalysis: last };
  assert.deepEqual([r('Show the latest inspection.', m2).intent, r('Show the latest inspection.', m2).focus], [DOC_INTENT.INSPECTION_HISTORY, 'LATEST']);
  assert.equal(r('Which defects are recurring?', m2).intent, DOC_INTENT.CONDITION_TREND);
  assert.deepEqual([r('What specifications are missing?', m2).intent, r('What specifications are missing?', m2).focus], [DOC_INTENT.TECHNICAL_SPECIFICATIONS, 'MISSING']);
  assert.deepEqual([r('Which actions are not verified closed?', m2).intent, r('Which actions are not verified closed?', m2).focus], [DOC_INTENT.CONDITION_TREND, 'CLOSURE']);
  const ev = r('Show the evidence for the cooling system issue.', m2);
  assert.deepEqual([ev.intent, ev.openItem, ev.assetId], [DOC_INTENT.EVIDENCE, 'Radiators and cooling fans', 'TX-M2']);
  const vs = r('Compare this transformer with TX-M1.', m2);
  assert.deepEqual([vs.intent, vs.compare, vs.assetIds], [DOC_INTENT.DOCUMENT_COMPARISON, 'ASSETS', ['TX-M2', 'TX-M1']]);
  // Not document questions: their routes are kept.
  for (const q of ['Show me TX-M1', 'What happens if TX-M1 fails?', 'Does USS-1 supply USS-2?', 'Show all transformers', 'Which assets have no power?', 'Show documents for USS-1', 'Compare V3 and V4', 'What does TX-M1 supply?']) assert.equal(r(q), null, q);
  assert.equal(r('Summarize the inspection history').needsAsset, true);
});

// ---- the endpoint: ACC retrieval, versions, cache, access ----

const MODEL = readFileSync(new URL('./fixtures/ifc/seagirt-compare-v2.ifc', import.meta.url));
function harness({ pdfs, failOnce = new Set(), deny = new Set(), denyGet = new Set() }) {
  const tree = { top: { folders: [{ id: 'docs', name: 'Asset Documentation' }], files: [] }, docs: { folders: [{ id: 'f2', name: '02_Transformers' }], files: [] },
    f2: { folders: [], files: Object.keys(pdfs).map(name => ({ name, version: pdfs[name].version ?? 1 })) } };
  const gets = [];
  const client = {
    async getAll(path) {
      const folderId = decodeURIComponent(/folders\/([^/]+)\/contents/.exec(path)[1]);
      const node = tree[folderId] ?? { folders: [], files: [] };
      const id = (f, n) => `urn:item:${folderId}/${f}?version=${n}`;
      return { data: [...node.folders.map(f => ({ type: 'folders', id: f.id, attributes: { displayName: f.name } })),
        ...node.files.map(f => ({ type: 'items', id: `urn:item:${folderId}/${f.name}`, attributes: { displayName: f.name }, relationships: { tip: { data: { id: id(f.name, f.version) } } }, links: { webView: { href: 'https://acc.autodesk.com/x' } } }))],
        included: node.files.map(f => ({ type: 'versions', id: id(f.name, f.version), attributes: { name: f.name, versionNumber: f.version, fileType: 'pdf', storageSize: 1000, lastModifiedTime: '2026-11-25T08:00:00Z', createTime: '2026-11-25T07:00:00Z' } })) };
    },
    async get(path) { gets.push(path); for (const name of denyGet) if (decodeURIComponent(path).includes(name)) throw new ApsError('FORBIDDEN', 403, 'You do not have permission.'); return { data: {} }; },
  };
  const files = { hub: { id: 'h' }, project: { id: 'b.p', name: 'Seagirt' }, topFolders: [{ id: 'top', name: 'top' }],
    files: [{ fileName: 'net.ifc', itemId: 'urn:i', tipVersionId: 'urn:model?version=2', versions: [{ id: 'urn:model?version=2', versionNumber: 2 }] }] };
  const streamed = [];
  const failed = new Set();
  const cacheDir = mkdtempSync(join(tmpdir(), 'docintel-api-'));
  const api = createIfcSpatialApi({ aps: { dataClient: () => client, projectFiles: async () => files }, cacheDir, logger: { info() {}, warn() {}, error() {} },
    download: async () => ({ bytes: MODEL }),
    openStream: async (c, p, versionId) => {
      const name = decodeURIComponent(versionId.split('/').pop().split('?')[0]);
      streamed.push(versionId);
      if (deny.has(name)) throw new ApsError('FORBIDDEN', 403, 'You do not have permission to view this file in ACC.');
      if (failOnce.has(name) && !failed.has(name)) { failed.add(name); throw new ApsError('DOWNLOAD_FAILED', 502, 'The file download answered 503.'); }
      return { body: Readable.from([Buffer.from(pdfs[name].bytes)]), contentLength: pdfs[name].bytes.length, fileName: name };
    } });
  async function call(method, path) {
    const req = Readable.from([]);
    Object.assign(req, { method, url: path, headers: {} });
    let status, headers; const parts = [];
    await api.handle(req, { writeHead(s, h) { status = s; headers = h; }, write(c) { parts.push(Buffer.from(c)); }, end(b) { if (b) parts.push(Buffer.from(b)); } });
    return { status, json: JSON.parse(Buffer.concat(parts).toString() || 'null') };
  }
  const extractions = () => readdirSync(join(cacheDir, 'documents')).flatMap(d => readdirSync(join(cacheDir, 'documents', d, 'extract')).filter(f => f !== 'index.json'));
  return { api, call, streamed, gets, pdfs, tree, extractions };
}
const asM2 = bytes => bytes;
const M2 = {
  'TX-M2_Transformer.pdf': { bytes: specSheet({ assetId: 'TX-M2', fields: [['Rating', '34.5/13.8 kV, 12 MVA']] }) },
  'TX-M2_Transformer_Inspection-2025-001_2025-04-10.pdf': { bytes: asM2(inspectionReport({ assetId: 'TX-M2', date: '2025-04-10', number: 'I25', findings: [['Radiators and cooling fans', 'Attention', 'Weep.']], actions: [['Repair radiator 3 flange gasket', 'Medium', '2025-06-30']] })) },
  'TX-M2_Transformer_Inspection-2026-001_2026-10-28.pdf': { bytes: inspectionReport({ assetId: 'TX-M2', date: '2026-10-28', number: 'I26', summary: ['The 2025 repair actions were not completed.'], findings: [['Radiators and cooling fans', 'Defect', 'Dripping.']] }) },
  'TX-M1_Transformer.pdf': { bytes: specSheet({ assetId: 'TX-M1', fields: [['Rating', '34.5/13.8 kV, 12 MVA']] }) },
};

test('endpoint: the asset\'s linked ACC documents are downloaded once, read, cached; a recurring finding with citations', async () => {
  const h = harness({ pdfs: M2 });
  await h.call('POST', '/api/ifc-spatial/prepare?file=net.ifc');
  await h.call('POST', '/api/ifc-spatial/documents/sync?file=net.ifc');
  // Two questions at once: one download per document.
  const [a, b] = await Promise.all([h.call('GET', '/api/ifc-spatial/documents/analysis?file=net.ifc&asset=TX-M2'), h.call('GET', '/api/ifc-spatial/documents/analysis?file=net.ifc&asset=TX-M2&type=INSPECTION_HISTORY')]);
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(h.streamed.length, 3, 'three TX-M2 documents, each downloaded once');
  assert.ok(h.streamed.every(v => /TX-M2_.*\?version=1$/.test(v)), 'the indexed version, and only TX-M2\'s');
  assert.equal(a.json.documents.analysed, 3);
  assert.deepEqual(a.json.inspections.timeline.map(t => t.inspectionDate), ['2026-10-28', '2025-04-10']);
  assert.equal(a.json.inspections.comparison.findings[0].trend, TREND.WORSENING_WITH_EVIDENCE);
  assert.equal(a.json.inspections.comparison.actions[0].closure.status, CLOSURE.NOT_COMPLETED_WITH_EVIDENCE);
  assert.equal(b.json.analysisType, 'INSPECTION_HISTORY');
  assert.doesNotMatch(JSON.stringify(a.json), /signeds3download|Bearer|token/i, 'no ACC credentials or download links');
  // Asked again: from the cache, after an ACC access check per document, with no download.
  const again = await h.call('GET', '/api/ifc-spatial/documents/analysis?file=net.ifc&asset=TX-M2');
  assert.equal(again.status, 200);
  assert.equal(h.streamed.length, 3);
  assert.equal(h.api.documentStats().cacheHits, 3);
  assert.equal(h.gets.filter(g => /versions/.test(g)).length, 3);
  // TX-M1: only its own sheet; TX-M2's reports are not substituted.
  const m1 = (await h.call('GET', '/api/ifc-spatial/documents/analysis?file=net.ifc&asset=TX-M1')).json;
  assert.equal(m1.documents.linked, 1);
  assert.equal(m1.inspections.count, 0);
  assert.match(m1.summary, /No inspection reports are among TX-M1's linked documents/);
  assert.ok(m1.sources.every(s => s.fileName.startsWith('TX-M1_')));
  assert.equal((await h.call('GET', '/api/ifc-spatial/documents/analysis?file=net.ifc&asset=NOPE')).json.error.code, 'UNKNOWN_ASSET');
  assert.equal((await h.call('GET', '/api/ifc-spatial/documents/analysis?file=net.ifc&asset=TX-M2&type=BOGUS')).status, 400);
});

test('endpoint: a new ACC version of a document is read again and the old extraction removed', async () => {
  const h = harness({ pdfs: { ...M2 } });
  await h.call('POST', '/api/ifc-spatial/prepare?file=net.ifc');
  await h.call('POST', '/api/ifc-spatial/documents/sync?file=net.ifc');
  await h.call('GET', '/api/ifc-spatial/documents/analysis?file=net.ifc&asset=TX-M1');
  assert.equal(h.streamed.length, 1);
  // V2 of the sheet in ACC, with a different rating.
  h.pdfs['TX-M1_Transformer.pdf'] = { version: 2, bytes: specSheet({ assetId: 'TX-M1', fields: [['Rating', '34.5/13.8 kV, 15 MVA']] }) };
  h.tree.f2.files = Object.keys(h.pdfs).map(name => ({ name, version: h.pdfs[name].version ?? 1 }));
  await h.call('POST', '/api/ifc-spatial/documents/sync?file=net.ifc');
  const after = (await h.call('GET', '/api/ifc-spatial/documents/analysis?file=net.ifc&asset=TX-M1')).json;
  assert.equal(h.streamed.length, 2);
  assert.match(h.streamed[1], /\?version=2$/);
  assert.equal(after.specifications.keyFields.find(k => k.key === 'ratedPower').value, '15 MVA');
  assert.equal(after.sources[0].version, 2);
  assert.equal(h.extractions().length, 1, 'the V1 extraction was deleted');
});

test('endpoint: transient download failures are retried once; access denied and permanent failures are reported, not hidden', async () => {
  const h = harness({ pdfs: M2, failOnce: new Set(['TX-M2_Transformer.pdf']), deny: new Set(['TX-M2_Transformer_Inspection-2026-001_2026-10-28.pdf']) });
  await h.call('POST', '/api/ifc-spatial/prepare?file=net.ifc');
  await h.call('POST', '/api/ifc-spatial/documents/sync?file=net.ifc');
  const a = (await h.call('GET', '/api/ifc-spatial/documents/analysis?file=net.ifc&asset=TX-M2')).json;
  assert.equal(a.sources.find(s => s.fileName === 'TX-M2_Transformer.pdf').status, 'SUCCESS', 'retried after a 502');
  const denied = a.sources.find(s => s.fileName.includes('2026'));
  assert.equal(denied.status, 'ACCESS_DENIED');
  assert.equal(a.documents.unreadable, 1);
  assert.deepEqual(a.inspections.timeline.map(t => t.inspectionDate), ['2025-04-10'], 'the unread report contributes nothing');
});

test('endpoint: a cached extraction is not served to a user ACC refuses', async () => {
  const h = harness({ pdfs: M2 });
  await h.call('POST', '/api/ifc-spatial/prepare?file=net.ifc');
  await h.call('POST', '/api/ifc-spatial/documents/sync?file=net.ifc');
  await h.call('GET', '/api/ifc-spatial/documents/analysis?file=net.ifc&asset=TX-M1');
  // Same cache, but ACC now refuses this user the document version.
  const h2 = { ...h };
  void h2;
  const refused = harness({ pdfs: M2, denyGet: new Set(['TX-M1_Transformer.pdf']) });
  await refused.call('POST', '/api/ifc-spatial/prepare?file=net.ifc');
  await refused.call('POST', '/api/ifc-spatial/documents/sync?file=net.ifc');
  await refused.call('GET', '/api/ifc-spatial/documents/analysis?file=net.ifc&asset=TX-M1');
  const second = (await refused.call('GET', '/api/ifc-spatial/documents/analysis?file=net.ifc&asset=TX-M1')).json;
  assert.equal(second.sources[0].status, 'ACCESS_DENIED');
  assert.equal(second.specifications.fromDocuments.length, 0, 'nothing from the cached text');
});

test('endpoint: the model version asked for is the one the asset is checked against', async () => {
  const h = harness({ pdfs: M2 });
  await h.call('POST', '/api/ifc-spatial/prepare?file=net.ifc');
  await h.call('POST', '/api/ifc-spatial/documents/sync?file=net.ifc');
  const a = (await h.call('GET', '/api/ifc-spatial/documents/analysis?file=net.ifc&asset=TX-M2&version=2')).json;
  assert.equal(a.modelVersion, 'net.ifc v2');
  // The fixture documents state GlobalId GID-1, not the model's: said, not hidden.
  assert.ok(a.identityNotes.length >= 1);
  assert.match(a.identityNotes[0].text, /GID-1/);
});
