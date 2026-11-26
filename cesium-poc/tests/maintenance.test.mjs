import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfText } from '../server/ifcSpatial/docExtract.mjs';
import { analyzeAssetDocuments, normalizeDocument } from '../server/ifcSpatial/docIntel.mjs';
import { inspectionReport, specSheet } from './pdfFixtures.mjs';
import { assessAsset, buildMaintenanceAssessment, CAUSE, EVIDENCE, groupRefs, maintenanceSay, rowSummary } from '../src/ifcSpatial/maintenance.js';
import { planQuestion } from '../src/ifcSpatial/askIntent.js';

const read = async (fileName, bytes) => normalizeDocument({ documentId: fileName.replace(/\W/g, '').slice(0, 24), fileName, versionNumber: 2, accVersionId: `urn:v:${fileName}?version=2`, accItemId: `urn:i:${fileName}`, webViewUrl: `https://acc.example/${fileName}` }, await extractPdfText(bytes));
async function analysis(id, docs) {
  const out = [];
  for (const [name, bytes] of Object.entries(docs)) out.push(await read(`${id}_${name}.pdf`, bytes));
  return analyzeAssetDocuments({ asset: { id, name: `Transformer ${id}`, ifcClass: 'IfcTransformer' }, docs: out });
}
const TXM2 = {
  sheet: specSheet({ assetId: 'TX-M2', fields: [['Rating', '34.5/13.8 kV, 12 MVA']] }),
  i24: inspectionReport({ assetId: 'TX-M2', date: '2024-03-12', number: 'M2-24', condition: 'GOOD (4/5)', findings: [['Bushings (HV and LV)', 'OK', 'Clean.']] }),
  i25: inspectionReport({ assetId: 'TX-M2', date: '2025-04-10', number: 'M2-25', condition: 'FAIR (3/5)', findings: [['Radiators and cooling fans', 'Attention', 'Weep at radiator 3 valve.']], actions: [['Re-sample oil for DGA', 'Medium', '2025-10-10']] }),
  i26: inspectionReport({ assetId: 'TX-M2', date: '2026-10-28', number: 'M2-26', condition: 'POOR (2/5)', findings: [['Radiators and cooling fans', 'Defect', 'Oil leaking at radiator 3 isolation valve.'], ['Cooling fans', 'Defect', 'Fan 4 failed.'], ['Bushings (HV and LV)', 'Attention', 'Discolouration on LV X2 connector.']],
    actions: [['Repair radiator 3 isolation valve', 'High', '2026-12-15']] }),
};
const ev = (id, analysisValue, status = 'DEGRADED', extra = {}) => ({ id, status: { status, monitored: true, flag: 'Overheating' }, category: 'Transformer', documents: { linked: analysisValue ? analysisValue.documents.linked : 0, index: true }, analysis: analysisValue, error: null, ...extra });
const inv = (assets, q = 'For degraded asset, what needs to be fixed?', extra = {}) => ({ plan: planQuestion(q, { knownIds: new Set(assets.map(a => a.id)), area: { selectionId: 's', versionKey: 'k' } }), targets: { ids: assets.map(a => a.id), how: 'FILTER', notAssets: [] }, assets, failures: [], partial: false, limited: null, ...extra });

test('one degraded asset with inspections: latest condition, actual trend, findings by severity, actions and closure, cited; cause not established', async () => {
  const a = assessAsset(ev('TX-M2', await analysis('TX-M2', TXM2)), { describe: () => ({ type: 'Transformer', name: 'Main transformer' }) });
  assert.equal(a.evidenceAvailability, EVIDENCE.AVAILABLE);
  assert.equal(a.latestInspection.date, '2026-10-28');
  assert.deepEqual(a.conditionTrend.map(t => [t.date, t.score]), [['2024-03-12', 4], ['2025-04-10', 3], ['2026-10-28', 2]], 'actual dated points, oldest first');
  assert.deepEqual(a.findings.map(f => f.severity), ['DEFECT', 'DEFECT', 'ATTENTION'], 'defects first');
  assert.ok(a.findings.every(f => f.ref?.documentId && f.ref.version === 2 && f.ref.inspectionDate === '2026-10-28'), 'every finding cited');
  assert.ok(a.findings.some(f => /Fan 4 failed/.test(f.text)));
  assert.ok(a.documentedCorrectiveActions.some(x => /Repair radiator 3 isolation valve/.test(x.text) && x.closure === 'NOT_VERIFIED'));
  assert.equal(a.degradationCause.status, CAUSE.NOT_ESTABLISHED, 'findings are not presented as the cause');
  assert.ok(a.limitations.some(l => /do not establish whether they cause/.test(l)));
  assert.equal(a.powerState, 'POWERED');
  assert.ok(a.sourceRefs.length >= 1 && a.sourceRefs.length <= 3, 'references grouped by document and page');
  const m = buildMaintenanceAssessment(inv([ev('TX-M2', await analysis('TX-M2', TXM2))]));
  const say = maintenanceSay(m);
  assert.match(say.say, /^I found one degraded transformer, TX-M2, in the selected area\. Its latest inspection \(2026-10-28\) documents 3 issues/);
  assert.match(say.say2, /do not establish/);
});

test('missing evidence: no documents, failed retrieval, unreadable, no inspection report, no findings — kept apart, nothing invented', async () => {
  const none = assessAsset(ev('STS-02', null));
  assert.equal(none.evidenceAvailability, EVIDENCE.NO_DOCUMENTS);
  assert.deepEqual([none.findings, none.documentedCorrectiveActions], [[], []]);
  const m1 = buildMaintenanceAssessment(inv([ev('STS-02', null)]));
  assert.match(maintenanceSay(m1).say, /available records do not establish the cause: no supporting inspection or maintenance documents are linked/);
  const failed = assessAsset(ev('TX-3', null, 'DEGRADED', { documents: { linked: 2, index: true }, error: 'ACC refused' }));
  assert.equal(failed.evidenceAvailability, EVIDENCE.RETRIEVAL_FAILED);
  const specOnly = assessAsset(ev('TX-4', await analysis('TX-4', { sheet: specSheet({ assetId: 'TX-4', fields: [['Rating', '1 MVA']] }) })));
  assert.equal(specOnly.evidenceAvailability, EVIDENCE.NO_INSPECTION_RECORDS);
  const clean = assessAsset(ev('TX-5', await analysis('TX-5', { i: inspectionReport({ assetId: 'TX-5', date: '2026-09-01', number: 'T5', condition: 'GOOD (4/5)', findings: [['Bushings', 'OK', 'Clean.']] }) })));
  assert.equal(clean.evidenceAvailability, EVIDENCE.NO_RELEVANT_FINDINGS);
});

test('several assets: counts that add up and do not overlap; partial evidence flagged; rows summarised', async () => {
  const assets = [ev('TX-M2', await analysis('TX-M2', TXM2)), ev('STS-02', null), ev('TX-3', null, 'DEGRADED', { documents: { linked: 1, index: true }, error: 'timeout' })];
  const m = buildMaintenanceAssessment(inv(assets, 'For all degraded assets, what needs to be fixed?', { failures: [{ id: 'TX-3', error: 'timeout' }], partial: true }));
  assert.deepEqual(m.summary, { matchingAssets: 3, assetsWithDocumentedFindings: 1, assetsWithoutDocumentedFindings: 2, assetsWithVerifiedDegradationCause: 0, assetsWithUnknownDegradationCause: 3, partialEvidence: true });
  assert.equal(m.summary.assetsWithDocumentedFindings + m.summary.assetsWithoutDocumentedFindings, m.summary.matchingAssets);
  assert.match(maintenanceSay(m).say, /^I found 3 degraded assets in the selected area\. Inspection evidence is available for 1 of them\./);
  assert.ok(m.limitations.some(l => /could not be retrieved/.test(l)));
  assert.deepEqual(m.mapActions, [{ type: 'HIGHLIGHT_ASSETS', assetIds: ['TX-M2', 'TX-3', 'STS-02'] }], 'findings first, then failed reads, then no documents');
  assert.equal(rowSummary(m.assets[2]).text, 'Cause of degradation not documented');
  assert.equal(rowSummary({ ...m.assets[2], operationalStatus: 'NO_POWER' }).text, 'Cause of power loss not documented');
  assert.equal(rowSummary(m.assets[0]).evidence, 'Findings available');
});

test('source references are grouped and never guessed', () => {
  const r = groupRefs([{ documentId: 'd', page: 1, inspectionDate: '2026-10-28' }, { documentId: 'd', page: 1, inspectionDate: '2026-10-28' }, { documentId: 'd', page: 2, inspectionDate: '2026-10-28' }, null]);
  assert.equal(r.length, 2);
});

test('focused answers: since when, getting worse, occurred before, outstanding, restrictions, why — each from the evidence, with its limits', async () => {
  const { focusedSay } = await import('../src/ifcSpatial/maintenance.js');
  const a = assessAsset({ ...ev('TX-M2', await analysis('TX-M2', TXM2)), status: { status: 'DEGRADED', monitored: true, date: '2026-11-24', flag: 'POOR CONDITION' } });
  const since = focusedSay(a, 'HISTORICAL_STATUS');
  assert.match(since.say, /^TX-M2 is reported degraded \(status record dated 24 Nov 2026\)\. The available operational records do not establish when the degraded status began\./);
  assert.match(since.say2, /latest inspection recorded Poor condition on 28 Oct 2026; an inspection date is not the start/i);
  assert.equal(focusedSay(a, 'CONDITION_TREND').say, "Yes: TX-M2's documented condition has worsened, from Good 4/5 (Mar 2024) to Poor 2/5 (Oct 2026).");
  assert.match(focusedSay(a, 'CONDITION_TREND').say2, /not the live operational status/);
  const rec = focusedSay(a, 'RECURRING_DEFECTS');
  assert.match(rec.say, /^Yes: \d of TX-M2's latest findings (was|were) also reported in earlier inspections: Radiators and cooling fans \(first reported 10 Apr 2025\)/);
  const out = focusedSay(a, 'OUTSTANDING_ACTIONS');
  assert.match(out.say, /^2 documented actions have no verified closure for TX-M2/);
  assert.match(out.say2, /not known to be done or not done/);
  assert.match(focusedSay(a, 'OPERATING_RESTRICTIONS').say2, /being energized does not show it is safe to operate: continued operation needs engineering approval/);
  assert.match(focusedSay(a, 'ASSET_DIAGNOSIS').say, /^The records do not establish why TX-M2 is degraded\. Its latest inspection \(28 Oct 2026\) documents /);
  assert.equal(focusedSay(a, 'CORRECTIVE_ACTIONS'), null, 'the general assessment');
  // Not enough evidence: said, nothing inferred.
  const one = assessAsset(ev('TX-5', await analysis('TX-5', { i: inspectionReport({ assetId: 'TX-5', date: '2026-09-01', number: 'T5', condition: 'FAIR (3/5)', findings: [['Bushings', 'Attention', 'Dust.']] }) })));
  assert.match(focusedSay(one, 'CONDITION_TREND').say, /cannot be established: only one dated condition rating/);
  assert.match(focusedSay(one, 'RECURRING_DEFECTS').say, /cannot be established for TX-5: only one inspection report/);
  const none = assessAsset(ev('STS-02', null));
  assert.match(focusedSay(none, 'ASSET_DIAGNOSIS').say, /do not establish why STS-02 is degraded: no supporting inspection or maintenance findings were found/);
});

test('HTML: the focus first, evidence on request, no placeholder actions', async () => {
  const { maintenanceHtml } = await import('../src/ifcSpatial/maintenanceAnswer.js');
  const m = buildMaintenanceAssessment(inv([ev('TX-M2', await analysis('TX-M2', TXM2))], 'Which repairs are still outstanding?'));
  const html = maintenanceHtml(m);
  assert.ok(html.indexOf('Documented actions') < html.indexOf('What needs to be fixed or investigated'), 'the focus first, the findings folded');
  assert.match(html, /tw-mfold/);
  assert.match(html, /Closure not verified/);
  assert.match(html, /<details class="tw-mev"><summary>Evidence<\/summary>/);
  assert.doesNotMatch(html, /maintenance report/i, 'no report button before it works');
  const general = maintenanceHtml(buildMaintenanceAssessment(inv([ev('TX-M2', await analysis('TX-M2', TXM2))])));
  assert.match(general, /<h5 class="tw-mh">What needs to be fixed or investigated<\/h5>/);
});

test('a powered asset without documents: no "cause" is mentioned (there is no problem to explain)', () => {
  const m = buildMaintenanceAssessment({ ...inv([ev('TX-M1', null, 'POWERED')], 'What needs to be fixed on TX-M1?'), targets: { ids: ['TX-M1'], how: 'NAMED', notAssets: [] } });
  const s = maintenanceSay({ ...m, targetKind: 'NAMED' });
  assert.match(s.say, /^TX-M1 \(transformer\) is reported powered\. No inspection or maintenance documents are linked to it/);
  assert.doesNotMatch(s.say, /cause/);
});
