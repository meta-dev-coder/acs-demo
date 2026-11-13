/**
 * The ACS demo cases, and the acceptance checks the brief asks for (Phase 10).
 *
 * The point of most of these is that nothing on screen is declared. The case file states a
 * `declaredStatus` per stage — the demonstration's own narrative — and the application never reads
 * it: the engines derive every status from the field data. These tests are where the two are put
 * side by side, so a narrative that drifts away from its own data fails here rather than being
 * drawn as if it were true.
 */
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OVERALL, STAGE_ORDER, buildDemoCases, canonicalFor, demoCasesEnabled, directionOf,
  evaluateDemoCase, kpiBreakdown, locationOf, overallStatusOf, resolveSourceIncidents,
  validateCaseSchema,
} from '../src/acs/acsDemoCases.js';
import { STAGE_STATUS, STATUS, SUBMISSION, evaluateStageField, validateStage } from '../src/qcqa/stageValidation.js';
import { templateById } from '../src/qcqa/templateCatalog.js';

const payload = JSON.parse(await readFile(new URL('../public/data/acs-demo-cases.json', import.meta.url), 'utf8'));

/** A stand-in incident register. Real coordinates are irrelevant to the logic; being located is not. */
const register = (count = 40) => Array.from({ length: count }, (unused, index) => ({
  id: `INC-${1000 + index}`,
  latitude: 26.06 + index * 0.0005,
  longitude: -80.35 + index * 0.004,
  segmentName: `${index % 2 ? 'I-595 EB' : 'I-595 WB'} segment ${index}`,
  title: index % 3 === 0 ? 'Vehicle collision' : 'Debris',
  createdDate: `0${1 + (index % 9)}/01/2026`,
}));

const built = () => buildDemoCases(payload, register());

/** The expected outcomes from the brief, as the overall state of each case. */
const EXPECTED_OVERALL = Object.freeze({
  'ACS-DEMO-001': OVERALL.BLOCKED_AT_INSPECTION,
  'ACS-DEMO-002': OVERALL.BLOCKED_AT_REPAIR,
  'ACS-DEMO-003': OVERALL.REWORK_REQUIRED,
  'ACS-DEMO-004': OVERALL.CLAIM_ACTION_REQUIRED,
  'ACS-DEMO-005': OVERALL.CLOSED,
  'ACS-DEMO-006': OVERALL.REPAIR_IN_PROGRESS,
  'ACS-DEMO-007': OVERALL.AWAITING_CLAIM,
});

test('the case file holds seven cases and every one validates against the schema', () => {
  assert.equal(payload.cases.length, 7);
  const problems = payload.cases.flatMap(validateCaseSchema);
  assert.deepEqual(problems, []);
});

test('every case is labelled as synthetic and carries no coordinates of its own', () => {
  for (const demoCase of payload.cases) {
    assert.equal(demoCase.isDemo, true, `${demoCase.demoCaseId} must be flagged as demo`);
    assert.match(demoCase.demoLabel, /SYNTHETIC/i);
    assert.equal(demoCase.sourceIncidentId, null);
    assert.equal(demoCase.incident.location, undefined,
      `${demoCase.demoCaseId} must take its location from the register, not from the file`);
  }
});

test('each case names a checklist that exists in the ACS catalogue', () => {
  for (const demoCase of payload.cases) {
    assert.ok(templateById(demoCase.qcqa.templateId),
      `${demoCase.demoCaseId}: ${demoCase.qcqa.templateId} is not a template`);
  }
});

test('every QC/QA response answers a question the named checklist actually asks', () => {
  for (const demoCase of payload.cases) {
    const template = templateById(demoCase.qcqa.templateId);
    const known = new Set(template.sections.flatMap(section => section.questions.map(q => q.id)));
    for (const id of Object.keys(demoCase.qualityAssurance.responses ?? {})) {
      assert.ok(known.has(id), `${demoCase.demoCaseId}: ${id} is not a question in ${template.templateId}`);
    }
  }
});

test('the derived overall status matches the brief for all seven cases', () => {
  for (const record of built().records) {
    assert.equal(record.evaluation.overall, EXPECTED_OVERALL[record.id], record.id);
  }
});

test('the derived stage statuses agree with each case\'s own declared narrative, or differ only '
  + 'where the narrative says "not started" and the engine says the stage is blocked', () => {
  // The one licensed difference: the brief's narrative calls a stage with no record "NOT_STARTED"
  // even where an earlier stage has FAILED. The engine reports BLOCKED there, because "nobody has
  // started this" and "nobody can start this" are different facts, and the brief's own overall
  // status for those cases is BLOCKED_AT_<stage>.
  const licensed = new Set(['NOT_STARTED->BLOCKED', 'PENDING->BLOCKED']);
  for (const record of built().records) {
    for (const stage of STAGE_ORDER) {
      const { declaredStatus, status } = record.evaluation.stages[stage];
      if (declaredStatus === status) continue;
      assert.ok(licensed.has(`${declaredStatus}->${status}`),
        `${record.id}/${stage}: declared ${declaredStatus}, derived ${status}`);
    }
  }
});

test('a stage passes only when every mandatory field is satisfied', () => {
  for (const record of built().records) {
    for (const stage of STAGE_ORDER) {
      const evaluated = record.evaluation.stages[stage];
      if (evaluated.status !== STAGE_STATUS.PASSED) continue;
      assert.equal(evaluated.summary.failed, 0, `${record.id}/${stage} passed with a failure`);
      assert.equal(evaluated.summary.missing, 0, `${record.id}/${stage} passed with a missing record`);
      assert.ok(evaluated.summary.passed > 0, `${record.id}/${stage} passed with nothing recorded`);
    }
  }
});

test('a downstream stage never passes merely because it holds no records', () => {
  const stage = validateStage({ submission: SUBMISSION.NOT_SUBMITTED, fields: [] }, { gatedBy: null });
  assert.notEqual(stage.status, STAGE_STATUS.PASSED);
  assert.equal(stage.status, STAGE_STATUS.PENDING);
});

test('failed, missing, blocked and pending stay distinct', () => {
  const records = built().records;
  const of = id => records.find(record => record.id === id).evaluation;

  // FAILED, from a recorded value and from absent records.
  assert.equal(of('ACS-DEMO-001').statuses.INSPECTION, STAGE_STATUS.FAILED);
  const inspection = of('ACS-DEMO-001').stages.INSPECTION;
  assert.ok(inspection.fields.some(field => field.status === STATUS.MISSING), 'a missing record');
  assert.ok(inspection.fields.some(field => field.status === STATUS.FAIL), 'an invalid value');
  assert.ok(inspection.fields.some(field => field.status === STATUS.NOT_APPLICABLE), 'an optional blank');

  // BLOCKED: the stage after the failure cannot produce its records.
  assert.equal(of('ACS-DEMO-002').statuses.QCQA, STAGE_STATUS.BLOCKED);
  assert.equal(of('ACS-DEMO-002').stages.QCQA.gatedBy, 'REPAIR');

  // PENDING, and not missing: a repair in progress has records that are not due yet.
  const repair = of('ACS-DEMO-006').stages.REPAIR;
  assert.equal(repair.status, STAGE_STATUS.IN_PROGRESS);
  assert.ok(repair.summary.pending > 0, 'fields not yet due are pending');
  assert.equal(repair.summary.missing, 0, 'and none of them is reported as missing');

  // PENDING at stage level is not a failure either.
  assert.equal(of('ACS-DEMO-007').statuses.CLAIM, STAGE_STATUS.PENDING);
  assert.equal(of('ACS-DEMO-007').overall, OVERALL.AWAITING_CLAIM);
});

test('the physical repair and its documentation are judged separately', () => {
  const record = built().records.find(entry => entry.id === 'ACS-DEMO-002');
  assert.equal(record.demoCase.repair.physicalWorkComplete, true);
  assert.equal(record.evaluation.statuses.REPAIR, STAGE_STATUS.FAILED);
  assert.match(record.evaluation.explanation.impact, /physical work is recorded as complete/i);
});

test('QC/QA failure comes from the real checklist engine, not from the case file', () => {
  const record = built().records.find(entry => entry.id === 'ACS-DEMO-003');
  const review = record.evaluation.review;
  assert.ok(review, 'a submitted QC/QA record is evaluated');
  const findings = review.templates.flatMap(entry => entry.findings);
  const failed = findings.filter(finding => finding.status === STATUS.FAIL).map(finding => finding.ruleId);
  assert.deepEqual(failed.sort(), ['ACS-537.1-Q05', 'ACS-537.1-Q08']);
  assert.equal(review.approved, false);
  assert.equal(record.evaluation.statuses.QCQA, STAGE_STATUS.FAILED);
});

test('a fully answered checklist with both sign-offs is approved by the engine', () => {
  for (const id of ['ACS-DEMO-004', 'ACS-DEMO-005', 'ACS-DEMO-007']) {
    const record = built().records.find(entry => entry.id === id);
    assert.equal(record.evaluation.review.approved, true, `${id} should be approved`);
    assert.equal(record.evaluation.statuses.QCQA, STAGE_STATUS.PASSED);
  }
});

test('an unsubmitted QC/QA record is not evaluated at all, so it cannot read as failed', () => {
  for (const id of ['ACS-DEMO-001', 'ACS-DEMO-002', 'ACS-DEMO-006']) {
    const record = built().records.find(entry => entry.id === id);
    assert.equal(record.evaluation.review, null, `${id} has no checklist to evaluate`);
    assert.notEqual(record.evaluation.statuses.QCQA, STAGE_STATUS.FAILED);
  }
});

test('the checklist the case declares is one the selection engine would also choose', () => {
  for (const record of built().records) {
    assert.equal(record.evaluation.checklist.agrees, true,
      `${record.id}: the engine would not choose ${record.evaluation.checklist.declared}`);
  }
});

test('the claim reconciliation failure is derived by comparing two recorded amounts', () => {
  const record = built().records.find(entry => entry.id === 'ACS-DEMO-004');
  const claim = record.evaluation.stages.CLAIM;
  const reconciliation = claim.fields.find(field => field.fieldId === 'clm_cost_reconciliation');
  assert.equal(reconciliation.status, STATUS.FAIL);
  assert.match(reconciliation.message, /34,?250|34250/);
  assert.match(reconciliation.message, /31,?800|31800/);
});

test('an internal claim failure is never presented as an insurer\'s rejection', () => {
  const failed = payload.cases.find(entry => entry.demoCaseId === 'ACS-DEMO-004');
  assert.equal(failed.claim.insurerDecision, null);
  assert.match(failed.claim.note, /No insurer/i);
  // The one case that does carry an insurer decision says it is synthetic.
  const closed = payload.cases.find(entry => entry.demoCaseId === 'ACS-DEMO-005');
  assert.match(closed.claim.insurerDecision.insurer, /synthetic/i);
});

test('the KPI breakdown is counted from the data and matches the brief', () => {
  const breakdown = built().breakdown;
  const { total, blocked, open, closed } = breakdown;
  assert.deepEqual({ total, blocked, open, closed }, { total: 7, blocked: 4, open: 2, closed: 1 });
  // The evidence indicators are counted the same way: from the cases, never written in.
  assert.equal(breakdown.missingEvidence, breakdown.recoverableEvidence + breakdown.unresolvedEvidence);
  assert.ok(breakdown.missingEvidence > 0 && breakdown.recoverableEvidence > 0);
  assert.equal(breakdown.contextAvailable, 7, 'all seven cases have a located source incident');
  assert.deepEqual(kpiBreakdown([], []), {
    total: 0, blocked: 0, open: 0, closed: 0,
    missingEvidence: 0, recoverableEvidence: 0, unresolvedEvidence: 0, contextAvailable: 0,
  });
});

test('locations come from the register, are distinct, and are stable across rebuilds', () => {
  const first = built().records;
  const second = built().records;
  const ids = first.map(record => record.related.sourceIncidentId);
  assert.equal(new Set(ids).size, 7, 'seven distinct source incidents');
  for (const id of ids) assert.match(String(id), /^INC-/);
  assert.deepEqual(ids, second.map(record => record.related.sourceIncidentId), 'stable across refreshes');
  for (const record of first) {
    assert.ok(Number.isFinite(record.latitude) && Number.isFinite(record.longitude));
    assert.match(record.evaluation.location.note, /did not happen here/i);
  }
});

test('a register with too few located incidents is reported, never filled in', () => {
  const short = buildDemoCases(payload, register(3));
  assert.ok(short.problems.length > 0, 'the shortfall is reported');
  assert.match(short.problems[0], /No coordinate has been invented/);
  const placed = short.records.filter(record => Number.isFinite(record.latitude));
  assert.ok(placed.length <= 3);
  for (const record of short.records.filter(entry => !Number.isFinite(entry.latitude))) {
    assert.equal(record.evaluation.location.sourceIncidentId, null);
    assert.match(record.evaluation.location.note, /Nothing has been invented/);
  }
});

test('an empty register places nothing and still builds every case', () => {
  const none = buildDemoCases(payload, []);
  assert.equal(none.records.length, 7);
  for (const record of none.records) assert.equal(record.latitude, null);
});

test('direction is read from the source incident and never guessed', () => {
  assert.equal(directionOf({ segmentName: 'I-595 EB segment 4' }), 'EB');
  assert.equal(directionOf({ description: 'westbound shoulder' }), 'WB');
  assert.equal(directionOf({ segmentName: 'Segment 4' }), null);
  assert.equal(locationOf({ sourceIncident: { id: 'X', segmentName: 'Segment 4' } }).direction, null);
});

test('the register publishes no milepost, so no case claims one', () => {
  for (const record of built().records) assert.equal(record.evaluation.location.milepost, null);
});

test('every record is marked as demo, so no surface can draw one unlabelled', () => {
  for (const record of built().records) {
    assert.equal(record.demo, true);
    assert.match(record.demoLabel, /SYNTHETIC/i);
    assert.equal(record.type, 'ACS_DEMO_CASE');
  }
});

test('the explanation is generated from the findings and names the stage at fault', () => {
  const records = built().records;
  for (const record of records) {
    const { detection, impact, action } = record.evaluation.explanation;
    for (const part of [detection, impact, action]) {
      assert.equal(typeof part, 'string');
      assert.ok(part.length > 20, `${record.id}: "${part}" is too short to be an explanation`);
    }
  }
  const qc = records.find(record => record.id === 'ACS-DEMO-003').evaluation.explanation;
  assert.match(qc.detection, /QC\/QA failed/);
  assert.match(qc.action, /ACS-537\.1/);
  const closed = records.find(record => record.id === 'ACS-DEMO-005').evaluation.explanation;
  assert.match(closed.action, /^None/);
});

test('the next action names outstanding records rather than a canned phrase', () => {
  const records = built().records;
  const first = records.find(record => record.id === 'ACS-DEMO-001').evaluation.nextAction;
  assert.match(first.text, /Damage photographs/);
  const third = records.find(record => record.id === 'ACS-DEMO-003').evaluation.nextAction;
  assert.match(third.text, /3 open non-conformances/);
  const closed = records.find(record => record.id === 'ACS-DEMO-005').evaluation.nextAction;
  assert.match(closed.text, /Nothing outstanding/);
});

test('every case carries an audit trail in chronological order', () => {
  for (const demoCase of payload.cases) {
    assert.ok(demoCase.auditTrail.length >= 5, `${demoCase.demoCaseId} needs a usable trail`);
    const times = demoCase.auditTrail.map(entry => new Date(entry.at).getTime());
    for (const time of times) assert.ok(Number.isFinite(time));
    assert.deepEqual(times, [...times].sort((a, b) => a - b), `${demoCase.demoCaseId} is out of order`);
  }
});

test('identifiers and personnel are visibly fictional', () => {
  for (const demoCase of payload.cases) {
    const text = JSON.stringify(demoCase);
    for (const match of text.match(/"(DEMO-[A-Z0-9-]+)"/g) ?? []) assert.match(match, /DEMO-/);
    if (demoCase.claim.claimReference) assert.match(demoCase.claim.claimReference, /^DEMO-CLM-/);
    if (demoCase.repair.workOrderId) assert.match(demoCase.repair.workOrderId, /^DEMO-WO-/);
    for (const field of demoCase.inspection.fields) {
      if (field.fieldId === 'insp_police_report' && field.value) assert.match(field.value, /^DEMO-PD-/);
    }
  }
});

test('any threshold the ACS checklist does not state is marked as an assumption', () => {
  const quoted = payload.cases.flatMap(entry => entry.qualityAssurance.measurements ?? []);
  assert.ok(quoted.length > 0, 'there are measurements to check');
  for (const measurement of quoted) {
    assert.equal(typeof measurement.demonstrationOnly, 'boolean');
    if (measurement.demonstrationOnly) {
      assert.match(measurement.note, /assumption/i,
        `${measurement.label} invents a figure without saying so`);
    }
  }
});

test('the overall-status table is a rule, not a per-case lookup', () => {
  const all = key => Object.fromEntries(STAGE_ORDER.map(stage => [stage, key]));
  assert.equal(overallStatusOf(all(STAGE_STATUS.PASSED)), OVERALL.CLOSED);
  assert.equal(overallStatusOf({ ...all(STAGE_STATUS.PASSED), INSPECTION: STAGE_STATUS.FAILED }),
    OVERALL.BLOCKED_AT_INSPECTION);
  assert.equal(overallStatusOf({ ...all(STAGE_STATUS.PASSED), QCQA: STAGE_STATUS.FAILED }),
    OVERALL.REWORK_REQUIRED);
  assert.equal(overallStatusOf({ ...all(STAGE_STATUS.PASSED), CLAIM: STAGE_STATUS.FAILED }),
    OVERALL.CLAIM_ACTION_REQUIRED);
  assert.equal(overallStatusOf({ ...all(STAGE_STATUS.PASSED), REPAIR: STAGE_STATUS.IN_PROGRESS }),
    OVERALL.REPAIR_IN_PROGRESS);
  assert.equal(overallStatusOf({ ...all(STAGE_STATUS.PASSED), CLAIM: STAGE_STATUS.PENDING }),
    OVERALL.AWAITING_CLAIM);
});

test('one field evaluator serves every stage, driven by the field\'s own rule', () => {
  const ctx = { submission: SUBMISSION.SUBMITTED };
  const required = { fieldId: 'a', label: 'A', required: true, acceptance: { notEmpty: true } };
  assert.equal(evaluateStageField({ ...required, value: 'x' }, ctx).status, STATUS.PASS);
  assert.equal(evaluateStageField({ ...required, value: null }, ctx).status, STATUS.MISSING);
  assert.equal(evaluateStageField({ ...required, required: false, value: null }, ctx).status, STATUS.NOT_APPLICABLE);
  assert.equal(evaluateStageField({ ...required, value: null, notYetDue: true }, ctx).status, STATUS.PENDING);
  assert.equal(evaluateStageField({ ...required, value: null }, { ...ctx, gated: true }).status, STATUS.BLOCKED);
  assert.equal(evaluateStageField(
    { fieldId: 'b', label: 'B', required: true, value: 'Maybe', acceptance: { oneOf: ['Yes', 'No'] } }, ctx).status,
  STATUS.FAIL);
  assert.equal(evaluateStageField(
    { fieldId: 'c', label: 'C', required: true, value: 29, unit: 'in', acceptance: { min: 27, max: 31 } }, ctx).status,
  STATUS.PASS);
  assert.equal(evaluateStageField(
    { fieldId: 'd', label: 'D', required: true, value: 33, unit: 'in', acceptance: { min: 27, max: 31 } }, ctx).status,
  STATUS.FAIL);
});

test('the canonical case handed to the checklist engine carries no production source', () => {
  for (const demoCase of resolveSourceIncidents(payload.cases, register()).cases) {
    const canonical = canonicalFor(demoCase);
    assert.match(canonical.asset.source, /synthetic/i);
    assert.equal(canonical.acsTask.linkEvidence, 'DEMO',
      'a demo case must not claim an illustrative link to a real ACS task');
    assert.equal(canonical.evidence.length, 0, 'no evidence file is ever claimed to exist');
  }
});

test('the feature flag switches the demonstration off without touching anything else', () => {
  assert.equal(demoCasesEnabled({ search: '', env: {} }), true, 'on by default');
  assert.equal(demoCasesEnabled({ search: '?acsDemo=off', env: {} }), false);
  assert.equal(demoCasesEnabled({ search: '?acsDemo=on', env: { VITE_ACS_DEMO_CASES: 'off' } }), true);
  assert.equal(demoCasesEnabled({ search: '', env: { VITE_ACS_DEMO_CASES: 'false' } }), false);
  assert.equal(demoCasesEnabled({ search: '', env: { VITE_ACS_DEMO_CASES: 'on' } }), true);
});

test('a malformed case takes the whole file out rather than being drawn half-formed', () => {
  const broken = { ...payload.cases[0], demoCaseId: 'NOT-A-DEMO-ID' };
  assert.ok(validateCaseSchema(broken).length > 0);
  const noFlag = { ...payload.cases[0], isDemo: false };
  assert.ok(validateCaseSchema(noFlag).some(problem => /isDemo/.test(problem)));
  const withCoords = { ...payload.cases[0], incident: { ...payload.cases[0].incident, location: { latitude: 26 } } };
  assert.ok(validateCaseSchema(withCoords).some(problem => /coordinates/.test(problem)));
});

test('evaluateDemoCase is pure: the same case always evaluates the same way', () => {
  const [demoCase] = resolveSourceIncidents(payload.cases, register()).cases;
  const once = evaluateDemoCase(demoCase);
  const twice = evaluateDemoCase(demoCase);
  assert.deepEqual(once.statuses, twice.statuses);
  assert.equal(once.overall, twice.overall);
  assert.equal(once.nextAction.text, twice.nextAction.text);
});
