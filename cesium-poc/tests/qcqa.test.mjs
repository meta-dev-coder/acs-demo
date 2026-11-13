/**
 * The QC/QA validation framework.
 *
 * One engine over data-driven templates: these tests exercise the same `validateCase` for every
 * document, and there is no per-PDF validator for them to cover.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS, CONFIDENCE, questionsOf, validateTemplate } from '../src/qcqa/schema.js';
import { TEMPLATES, extractionAudit, extractionTotals, templateById } from '../src/qcqa/templateCatalog.js';
import { selectForAssets, selectTemplates, sectionApplies } from '../src/qcqa/applicability.js';
import { buildCase, FIELD_MAPPINGS, UNRESOLVED_MAPPINGS, isoDate } from '../src/qcqa/canonicalCase.js';
import { consistencyFindings, satisfies, summarise, validateCase } from '../src/qcqa/validationEngine.js';
import { assertProvider, apiProviderTemplate, PROVIDER_METHODS } from '../src/qcqa/providers/provider.js';
import { createLocalProvider } from '../src/qcqa/providers/localProvider.js';
import { reviewRecord } from '../src/qcqa/qcqaService.js';

const wo = fields => ({ id: fields.code ?? 'WO-1', raw: { attributes: {
  code: 'WO-1', 'Work Order ID': 'WO-1', ...fields } } });
const insp = fields => ({ id: fields.code ?? 'INSP-1', raw: { attributes: {
  code: 'INSP-1', inspection_form_family: 'Roadway Safety Inspection V3', ...fields } } });
const findingFor = (result, ruleId) => [...result.templates.flatMap(t => t.findings),
  ...result.consistency].find(f => f.ruleId === ruleId);

/* --- the catalogue ---------------------------------------------------------------------------- */

test('every extracted template is well formed and carries its source', () => {
  for (const template of TEMPLATES) {
    const check = validateTemplate(template);
    assert.ok(check.ok, `${template.templateId}: ${check.problems.join('; ')}`);
    assert.ok(template.source.file.endsWith('.pdf'), `${template.templateId} names its PDF`);
    for (const question of questionsOf(template)) {
      assert.equal(question.sourcePage, template.source.page,
        `${question.id} must point at a real page`);
    }
  }
});

test('the extraction audit reconciles with the supplied documents', () => {
  const totals = extractionTotals();
  assert.equal(totals.documents, 22, 'all 22 supplied PDFs are extracted');
  assert.equal(totals.unextracted, 0);
  assert.ok(totals.allValid);
  assert.equal(totals.questions, 240);
  // The things most easily lost in extraction.
  assert.ok(totals.multiResponseQuestions >= 6, 'the PPE two-column items survive');
  assert.ok(totals.noIsPassQuestions >= 5, 'questions a YES would fail survive');
  assert.ok(totals.conditionalSections >= 16, 'conditional sections survive');
  // Every row names a file and a page.
  for (const row of extractionAudit()) {
    assert.ok(row.file && Number.isInteger(row.page), `${row.templateId} has a source reference`);
  }
});

/* --- 1–3: template selection ------------------------------------------------------------------ */

test('1. an attenuator repair selects the attenuator checklist', () => {
  const selection = selectTemplates({
    incidentType: 'vehicle_collision', assetType: 'Attenuetors',
    assetSubtype: 'QuadGuard', workActivity: 'Corrective Repair', workOrderId: 'WO-001' });
  assert.deepEqual(selection.selectedTemplates, ['ACS-531.1']);
  assert.equal(selection.confidence, CONFIDENCE.HIGH);
  assert.equal(selection.requiresConfirmation, false);
  assert.match(selection.selectionReason, /QuadGuard/);
  // The reason and the basis are preserved (rule 8).
  assert.equal(selection.basis.assetType, 'attenuator');
  assert.equal(selection.basis.workActivity, 'repair');
});

test('2. a lighting repair selects the lighting checklists', () => {
  const pole = selectTemplates({ assetType: 'Lighting', workActivity: 'Corrective Repair' });
  assert.ok(pole.selectedTemplates.includes('ACS-787.1'));
  assert.ok(pole.selectedTemplates.includes('ACS-787.2'));
  // More than one match is reported as needing confirmation, not silently resolved.
  assert.equal(pole.confidence, CONFIDENCE.MEDIUM);
  assert.equal(pole.requiresConfirmation, true);

  const loadCentre = selectTemplates({
    assetType: 'Lighting - Load Center', workActivity: 'Preventive Maintenance' });
  assert.deepEqual(loadCentre.selectedTemplates, ['ACS-787.3']);
});

test('3. guardrail and fence select their own checklists', () => {
  assert.deepEqual(
    selectTemplates({ assetType: 'guardrail', workActivity: 'repair' }).selectedTemplates
      .filter(id => id === 'ACS-526.1'), ['ACS-526.1']);
  assert.deepEqual(selectTemplates({ assetType: 'fence', workActivity: 'repair' }).selectedTemplates,
    ['ACS-527.1']);
});

test('the incident type alone never chooses a checklist', () => {
  const selection = selectTemplates({ incidentType: 'vehicle_collision' });
  assert.deepEqual(selection.selectedTemplates, []);
  assert.equal(selection.confidence, CONFIDENCE.UNRESOLVED);
  assert.equal(selection.unresolved, true);
  assert.equal(selection.requiresConfirmation, true);
});

test('the generic form is offered, never applied as a match', () => {
  const selection = selectTemplates({ assetType: 'Drainage', workActivity: 'Corrective Repair' });
  assert.deepEqual(selection.selectedTemplates, [], 'no checklist is claimed to cover drainage');
  assert.equal(selection.suggestedGeneric, 'ACS-996');
  assert.equal(selection.requiresConfirmation, true);
  assert.match(selection.selectionReason, /reviewer must confirm/);
});

/* --- 4–7: evaluation -------------------------------------------------------------------------- */

test('4. a missing required response is MISSING, never a failed inspection', () => {
  const result = validateCase(buildCase({ workOrder: wo({
    'Asset Type': 'guardrail', 'Work Type': 'Corrective Repair', 'Asset ID': 'G1' }) }));
  const found = findingFor(result, 'ACS-526.1-Q01');
  assert.equal(found.status, STATUS.MISSING);
  assert.equal(found.actual, null);
  assert.match(found.reason, /absent record, not an observed defect/);
  assert.ok(found.requiresHumanReview);
  assert.match(found.recommendedAction, /Request the completed QC inspection response/);
  // And it is not counted as a failure anywhere.
  assert.equal(result.summary.FAIL, 0);
  assert.equal(result.approved, false);
});

test('5. an explicit NO against a YES question is FAIL', () => {
  const result = validateCase(buildCase({
    workOrder: wo({ 'Asset Type': 'guardrail', 'Work Type': 'Corrective Repair' }),
    qcResponses: { 'ACS-526.1-Q01': 'NO', 'ACS-526.1-Q05': 'YES' },
  }));
  const failed = findingFor(result, 'ACS-526.1-Q01');
  assert.equal(failed.status, STATUS.FAIL);
  assert.equal(failed.actual, 'NO');
  assert.equal(failed.severity, 'CRITICAL');
  assert.equal(findingFor(result, 'ACS-526.1-Q05').status, STATUS.PASS);
});

test('6. a NO that means compliance is a PASS', () => {
  // 540.1 Q05: "Are remnants of graffiti visible through the covering material used?"
  const base = { workOrder: wo({ 'Asset Type': 'bridges', 'Work Type': 'graffiti removal' }) };
  const pass = validateCase(buildCase({ ...base, qcResponses: { 'ACS-540.1-Q05': 'NO' } }),
    { templateIds: ['ACS-540.1'] });
  const passFinding = findingFor(pass, 'ACS-540.1-Q05');
  assert.equal(passFinding.status, STATUS.PASS);
  assert.match(passFinding.reason, /NO, which is the satisfactory answer/);
  assert.equal(passFinding.expected, 'NO');

  const fail = validateCase(buildCase({ ...base, qcResponses: { 'ACS-540.1-Q05': 'YES' } }),
    { templateIds: ['ACS-540.1'] });
  const failFinding = findingFor(fail, 'ACS-540.1-Q05');
  assert.equal(failFinding.status, STATUS.FAIL);
  assert.match(failFinding.reason, /a YES is the defect/);

  // The polarity helper itself, both ways round.
  assert.equal(satisfies('NO', 'NO_IS_PASS'), true);
  assert.equal(satisfies('YES', 'NO_IS_PASS'), false);
  assert.equal(satisfies('YES', 'YES_IS_PASS'), true);
  assert.equal(satisfies('NA', 'YES_IS_PASS'), null);
});

test('7. a conditional section that does not apply is NOT_APPLICABLE with a reason', () => {
  const skt = { assetType: 'guardrail', assetSubtype: 'SKT 350', workActivity: 'installation' };
  const template = templateById('ACS-ET-350');
  const fleat = template.sections.find(section => section.id === 'fleat350');
  const verdict = sectionApplies(fleat, skt);
  assert.equal(verdict.applies, false);
  assert.match(verdict.reason, /FLEAT 350/);

  const result = validateCase(buildCase({
    workOrder: wo({ 'Asset Type': 'guardrail', 'Work Type': 'installation' }),
  }), { templateIds: ['ACS-ET-350'] });
  // With no subtype recorded, the model sections are NOT_EVALUATED rather than assumed either way.
  const unresolved = findingFor(result, 'ACS-ET-350-Q04');
  assert.equal(unresolved.status, STATUS.NOT_EVALUATED);
  assert.match(unresolved.reason, /neither applied nor dismissed/);
  // The unconditional common section still evaluates.
  assert.equal(findingFor(result, 'ACS-ET-350-Q01').status, STATUS.MISSING);
});

/* --- 8: several assets ------------------------------------------------------------------------ */

test('8. several damaged assets select several checklists', () => {
  const selection = selectForAssets([
    { assetType: 'Attenuetors', assetSubtype: 'QuadGuard', workActivity: 'Corrective Repair' },
    { assetType: 'guardrail', workActivity: 'Corrective Repair' },
    { assetType: 'Drainage', workActivity: 'Corrective Repair' },
  ]);
  assert.ok(selection.selectedTemplates.includes('ACS-531.1'));
  assert.ok(selection.selectedTemplates.includes('ACS-526.1'));
  assert.equal(selection.unresolvedCount, 1, 'drainage stays unresolved rather than being forced');
  assert.equal(selection.perAsset.length, 3);
});

/* --- 9–10: approvals -------------------------------------------------------------------------- */

test('9. a missing QC approval is reported and never assumed', () => {
  const result = validateCase(buildCase({
    workOrder: wo({ 'Asset Type': 'guardrail', 'Work Type': 'Corrective Repair' }) }),
  { templateIds: ['ACS-526.1'], includeUniversal: false });
  const qc = findingFor(result, 'ACS-526.1-APPROVAL-QC');
  assert.equal(qc.status, STATUS.MISSING);
  assert.match(qc.reason, /No QC sign-off record exists/);
  assert.equal(result.approved, false);
});

test('10. a missing QA approval is reported separately from QC', () => {
  const result = validateCase(buildCase({
    workOrder: wo({ 'Asset Type': 'guardrail', 'Work Type': 'Corrective Repair' }),
    approvals: { qc: { signatory: 'A. Egoavil', approvedAt: '2025-10-28' }, qa: null },
  }), { templateIds: ['ACS-526.1'], includeUniversal: false });
  assert.equal(findingFor(result, 'ACS-526.1-APPROVAL-QC').status, STATUS.PASS);
  assert.equal(findingFor(result, 'ACS-526.1-APPROVAL-QA').status, STATUS.MISSING);
  // A name with no date is not an approval.
  const named = validateCase(buildCase({
    workOrder: wo({ 'Asset Type': 'guardrail', 'Work Type': 'Corrective Repair' }),
    acsCase: { caseId: 'CASE-1', task: { taskNumber: '1' },
      stages: [{ qcBy: 'A. Egoavil', inspectionPhotos: 0, repairPhotos: 0 }] },
  }), { templateIds: ['ACS-526.1'], includeUniversal: false });
  const partial = findingFor(named, 'ACS-526.1-APPROVAL-QC');
  assert.equal(partial.status, STATUS.NEEDS_VERIFICATION);
  assert.match(partial.reason, /no sign-off record with a date/);
});

/* --- 11–13: consistency, provenance and evidence ---------------------------------------------- */

test('11. conflicting work-order and inspection values are reported', () => {
  const canonical = buildCase({
    workOrder: wo({ 'Asset Type': 'Attenuetors', 'Asset ID': 'H1', 'Work Type': 'Corrective Repair' }),
    inspection: insp({ asset_type: 'Lighting', asset_id: 'L9' }),
  });
  const findings = consistencyFindings(canonical);
  const type = findings.find(entry => entry.ruleId === 'XREC-ASSET-TYPE');
  const id = findings.find(entry => entry.ruleId === 'XREC-ASSET-ID');
  assert.equal(type.status, STATUS.FAIL);
  assert.match(type.actual, /Attenuetors.*Lighting/);
  assert.equal(id.status, STATUS.FAIL);
});

test('12. an unverified incident-to-repair association is surfaced, not trusted', () => {
  const canonical = buildCase({
    workOrder: wo({ 'Asset Type': 'guardrail', 'Work Type': 'Corrective Repair' }),
    acsCase: { caseId: 'CASE-1', evidence: 'ILLUSTRATIVE', task: { taskNumber: '1222' }, stages: [] },
  });
  const found = consistencyFindings(canonical).find(entry => entry.ruleId === 'XREC-ACS-LINK');
  assert.equal(found.status, STATUS.NEEDS_VERIFICATION);
  assert.match(found.reason, /carries no identifier/);
  assert.match(found.recommendedAction, /Event #/);
});

test('13. absent evidence is reported without declaring a technical failure', () => {
  const result = validateCase(buildCase({
    workOrder: wo({ 'Asset Type': 'raised pavement marker', 'Work Type': 'installation' }),
    acsCase: { caseId: 'CASE-1', task: { taskNumber: '1' },
      stages: [{ inspectionPhotos: 4, repairPhotos: 0 }] },
  }), { templateIds: ['ACS-537.1'], includeUniversal: false });
  const evidence = findingFor(result, 'ACS-537.1-Q01-EVIDENCE');
  assert.equal(evidence.status, STATUS.MISSING);
  assert.match(evidence.reason, /image files were not supplied/);
  // Crucially: the evidence gap must not make the question itself a FAIL.
  assert.equal(findingFor(result, 'ACS-537.1-Q01').status, STATUS.MISSING);
  assert.equal(result.summary.FAIL, 0);
});

/* --- 14: two responses per item --------------------------------------------------------------- */

test('14. the PPE checklist keeps its two independent responses per item', () => {
  const base = { workOrder: wo({ 'Asset Type': 'guardrail', 'Work Type': 'Corrective Repair' }) };
  const result = validateCase(buildCase({ ...base, qcResponses: {
    'ACS-PPE-Q01': { wornProperly: 'YES', conditionOk: 'NO' },
    'ACS-PPE-Q02': { wornProperly: 'YES', conditionOk: 'YES' },
    'ACS-PPE-Q03': { wornProperly: 'YES' },
  } }), { templateIds: ['ACS-PPE'], includeUniversal: false });

  const mixed = findingFor(result, 'ACS-PPE-Q01');
  assert.equal(mixed.status, STATUS.FAIL, 'one failing column fails the item');
  assert.match(mixed.reason, /Condition ok\?/);
  assert.equal(mixed.columns.length, 2);
  assert.equal(mixed.columns.find(c => c.key === 'wornProperly').status, STATUS.PASS);
  assert.equal(mixed.columns.find(c => c.key === 'conditionOk').status, STATUS.FAIL);

  assert.equal(findingFor(result, 'ACS-PPE-Q02').status, STATUS.PASS);

  const partial = findingFor(result, 'ACS-PPE-Q03');
  assert.equal(partial.status, STATUS.NEEDS_VERIFICATION, 'one blank column is not a pass');
  assert.equal(findingFor(result, 'ACS-PPE-Q04').status, STATUS.MISSING, 'both blank is missing');
});

/* --- 15: providers ---------------------------------------------------------------------------- */

test('15. the engine runs unchanged against any conforming provider', async () => {
  const maintenance = {
    recordsOf: key => (key === 'workOrders' ? [wo({ 'Asset Type': 'guardrail',
      'Work Type': 'Corrective Repair', 'Asset ID': 'G1' })] : []),
    assetIndex: () => new Map(),
  };
  const local = createLocalProvider({ maintenance });
  assert.equal(local.name, 'local:DataConnect');

  const record = await local.getCase('WO-1');
  const viaLocal = await reviewRecord(record, { provider: local });
  assert.ok(viaLocal.result.summary.total > 0);
  // A guardrail repair matches the guardrail form and both end-treatment forms, because an end
  // treatment is part of a guardrail run. The engine offers all three at MEDIUM and asks a
  // reviewer rather than picking one.
  assert.ok(viaLocal.result.selection.selectedTemplates.includes('ACS-526.1'));
  assert.equal(viaLocal.result.selection.confidence, CONFIDENCE.MEDIUM);
  assert.equal(viaLocal.result.selection.requiresConfirmation, true);

  // A second provider with the same interface produces the same review from the same case.
  const swapped = { ...local, name: 'swapped' };
  assertProvider(swapped, 'swapped');
  const viaSwapped = await reviewRecord(record, { provider: swapped });
  assert.deepEqual(viaSwapped.result.summary, viaLocal.result.summary);

  // And an API provider with no client refuses rather than returning an empty case.
  const api = apiProviderTemplate({ name: 'OfficeTrack' });
  assert.deepEqual(Object.keys(api).sort(), [...PROVIDER_METHODS].sort());
  await assert.rejects(() => api.getCase('x'), /no client is configured/);
  assert.throws(() => assertProvider({ getCase: () => {} }, 'partial'), /missing provider methods/);
});

/* --- the guarantees that hold across every template ------------------------------------------- */

test('no response is ever invented, for any template in the catalogue', () => {
  for (const template of TEMPLATES) {
    const result = validateCase(buildCase({
      workOrder: wo({ 'Asset Type': 'guardrail', 'Work Type': 'Corrective Repair' }) }),
    { templateIds: [template.templateId], includeUniversal: false });
    for (const found of result.templates[0].findings) {
      assert.notEqual(found.status, STATUS.PASS,
        `${found.ruleId} passed with no response supplied`);
      if (found.status === STATUS.MISSING) assert.equal(found.actual, null);
      assert.ok(found.reason, `${found.ruleId} must say why`);
      assert.ok(found.expected, `${found.ruleId} must state what was expected`);
    }
  }
});

test('a case is never approved without the approval records', () => {
  const answered = Object.fromEntries(questionsOf(templateById('ACS-526.1'))
    .map(question => [question.id, 'YES']));
  const result = validateCase(buildCase({
    workOrder: wo({ 'Asset Type': 'guardrail', 'Work Type': 'Corrective Repair' }),
    qcResponses: answered,
  }), { templateIds: ['ACS-526.1'], includeUniversal: false });
  assert.equal(result.summary.PASS, 12, 'all twelve questions pass');
  assert.equal(result.approved, false, 'but the case is not approved: no sign-off exists');

  const signed = validateCase(buildCase({
    workOrder: wo({ 'Asset Type': 'guardrail', 'Work Type': 'Corrective Repair' }),
    qcResponses: answered,
    approvals: { qc: { signatory: 'A', approvedAt: '2025-01-01' },
      qa: { signatory: 'B', approvedAt: '2025-01-02' } },
  }), { templateIds: ['ACS-526.1'], includeUniversal: false });
  assert.equal(signed.approved, true);
});

test('the field mapping registry declares what has no source', () => {
  for (const mapping of FIELD_MAPPINGS) {
    assert.ok(mapping.canonical && mapping.type && mapping.confidence);
    if (mapping.source === null) assert.ok(mapping.note, `${mapping.canonical} must say why`);
  }
  const names = UNRESOLVED_MAPPINGS.map(mapping => mapping.canonical);
  assert.ok(names.includes('qcInspection.responses'));
  assert.ok(names.includes('approvals.qc'));
  assert.ok(names.includes('approvals.qa'));
});

test('summarise counts every status and never loses a finding', () => {
  const counts = summarise([
    { status: STATUS.PASS, severity: 'INFO' }, { status: STATUS.FAIL, severity: 'CRITICAL' },
    { status: STATUS.NOT_APPLICABLE, severity: 'INFO' },
  ]);
  assert.equal(counts.total, 3);
  assert.equal(counts.applicable, 2);
  assert.equal(counts.PASS, 1);
  assert.equal(counts.critical, 1);
});

test('dates are normalised from the register\'s own format', () => {
  assert.equal(isoDate('26/09/2026'), '2026-09-26');
  assert.equal(isoDate('2026-09-26'), '2026-09-26');
  assert.equal(isoDate(null), null);
  assert.equal(isoDate('N/A'), null);
});
