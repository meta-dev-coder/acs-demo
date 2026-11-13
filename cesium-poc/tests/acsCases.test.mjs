import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ABSENT_FIELDS, CASE_EVIDENCE, caseForIncident, caseIdFor, completenessFindings, hashOf,
  stageOf, stagesOf,
} from '../src/acs/acsCases.js';

const payload = JSON.parse(readFileSync('public/data/acs-repair-tasks.json', 'utf8'));

test('the task file is the real export, not a sample of it', () => {
  assert.equal(payload.taskCount, 23);
  assert.equal(payload.rowsInFile, 42);
  assert.equal(payload.tasks.length, 23);
  // Every task keeps its number, and they are unique — the whole point of the grouping.
  const numbers = payload.tasks.map(task => task.taskNumber);
  assert.equal(new Set(numbers).size, numbers.length);
  assert.ok(numbers.every(Boolean));
  // The counts the assessment reported, so a changed export fails here rather than silently.
  assert.equal(payload.tasks.filter(task => task.latitude != null).length, 7, 'tasks with coordinates');
  assert.equal(payload.tasks.filter(task => task.eventNumber).length, 6, 'tasks with an event number');
  assert.equal(payload.tasks.filter(task =>
    task.stages.some(stage => stage.thirdPartyCostUSD)).length, 3, 'tasks with any cost');
});

test('a case is stable for an incident and spread across the tasks', () => {
  const one = caseForIncident({ id: 'INC-200174' }, payload);
  assert.equal(one.caseId, caseForIncident({ id: 'INC-200174' }, payload).caseId,
    'the same incident must never show two different cases');
  assert.notEqual(one.caseId, caseForIncident({ id: 'INC-200031' }, payload).caseId);
  assert.match(one.caseId, /^CASE-\d{3}$/);
  // Not all on one task.
  const ids = new Set(payload.tasks.map((unused, index) =>
    caseForIncident({ id: `INC-2000${index}` }, payload).caseId));
  assert.ok(ids.size > 5, `expected a spread of cases, got ${ids.size}`);
});

test('a case says plainly that the pairing is not evidenced', () => {
  const found = caseForIncident({ id: 'INC-200174' }, payload);
  assert.equal(found.evidence, CASE_EVIDENCE.ILLUSTRATIVE);
  assert.match(found.evidenceNote, /illustration/i);
  assert.match(found.evidenceNote, /Nothing in either record links them/);
  // And it never claims the task itself is invented.
  assert.match(found.evidenceNote, /real ACS submission/);
});

test('no case is produced without tasks, rather than an empty one', () => {
  assert.equal(caseForIncident({ id: 'INC-1' }, null), null);
  assert.equal(caseForIncident({ id: 'INC-1' }, { tasks: [] }), null);
  assert.equal(caseForIncident(null, payload), null);
});

test('stages are ordered inspection, repair, QC whatever order they were filed', () => {
  const task = { stages: [{ stage: 'QC', date: '2025-01-03' }, { stage: 'REPAIR', date: '2025-01-02' },
    { stage: 'INSPECTION', date: '2025-01-01' }] };
  assert.deepEqual(stagesOf(task).map(stage => stage.stage), ['INSPECTION', 'REPAIR', 'QC']);
  assert.equal(stageOf(task, 'REPAIR').date, '2025-01-02');
  assert.equal(stageOf(task, 'MISSING'), null);
  assert.deepEqual(stagesOf(null), []);
});

test('the completeness check reports absent resources on every task', () => {
  // This is true of every task in the export and is the finding, not a quirk of one row.
  for (const task of payload.tasks) {
    const findings = completenessFindings(task);
    assert.ok(findings.some(finding => /were not included in the export/.test(finding.text)),
      `task ${task.taskNumber} should report the absent resource tables`);
    // A finding never states a number the form does not hold.
    assert.ok(!findings.some(finding => /\b0 hours\b|\$0\b/.test(finding.text)));
  }
});

test('a cost is reported only where one exists, and never called the task cost', () => {
  const withCost = payload.tasks.find(task => task.stages.some(stage => stage.thirdPartyCostUSD));
  const found = completenessFindings(withCost).find(finding => finding.kind === 'present');
  assert.ok(found, 'a task with an invoice should report it');
  assert.match(found.text, /not the cost of the task/);

  const withoutCost = payload.tasks.find(task => !task.stages.some(stage => stage.thirdPartyCostUSD));
  assert.ok(!completenessFindings(withoutCost).some(finding => /\$/.test(finding.text)));
});

test('absent fields are the four the export omits', () => {
  assert.deepEqual(ABSENT_FIELDS.map(field => field.key),
    ['labourHours', 'serviceVehicle', 'equipment', 'materials']);
});

test('case ids are one-based and padded', () => {
  assert.equal(caseIdFor(0), 'CASE-001');
  assert.equal(caseIdFor(22), 'CASE-023');
});

test('the hash is stable and non-negative', () => {
  assert.equal(hashOf('INC-200174'), hashOf('INC-200174'));
  assert.ok(hashOf('') >= 0 && hashOf('a-very-long-incident-identifier') >= 0);
});

/* --- Repair, QC/QA and Claims ---------------------------------------------------------------- */

const withRepair = payload.tasks.find(task => task.stages.some(stage => stage.stage === 'REPAIR'));
const withoutRepair = payload.tasks.find(task => !task.stages.some(stage => stage.stage === 'REPAIR'));

test('the repair summary reads the filed stage and never claims verification it lacks', async () => {
  const { repairSummary } = await import('../src/acs/acsCases.js');
  const summary = repairSummary(withRepair);
  assert.equal(summary.taskNumber, withRepair.taskNumber);
  assert.ok(summary.completedDate, 'a filed repair has a date');
  // Filed is not verified: with no QC stage the panel must say so.
  const hasQc = withRepair.stages.some(stage => stage.stage === 'QC');
  assert.equal(summary.statusIsFiledNotVerified, !hasQc);

  const none = repairSummary(withoutRepair);
  assert.equal(none.workPerformed, null);
  assert.equal(none.completedDate, null);
});

test('a work order id is used only when the record really is one', async () => {
  const { repairSummary } = await import('../src/acs/acsCases.js');
  assert.equal(repairSummary(withRepair, { id: 'WO-FL511-890791' }).workOrderId, 'WO-FL511-890791');
  assert.equal(repairSummary(withRepair, { id: 'TIC-FL511-890791' }).workOrderId, null,
    'a ticket is not a work order');
  assert.equal(repairSummary(withRepair, null).workOrderId, null);
});

test('QC never fabricates a checklist', async () => {
  const { qcStatus } = await import('../src/acs/acsCases.js');
  for (const task of payload.tasks) {
    const qc = qcStatus(task);
    assert.equal(qc.checklist, null, `task ${task.taskNumber} must not carry invented checklist rows`);
    assert.match(qc.checklistNote, /no checklist items/);
  }
  // The states it does report are read off the stages.
  const signed = payload.tasks.find(task => task.stages.some(stage => stage.qcBy));
  assert.ok(['FILED', 'SIGNED_NOT_FILED'].includes(qcStatus(signed).qcState));
  assert.ok(qcStatus(signed).signatory);
  const unsigned = payload.tasks.find(task =>
    !task.stages.some(stage => stage.qcBy || stage.stage === 'QC'));
  assert.equal(qcStatus(unsigned).qcState, 'NOT_FILED');
  assert.equal(qcStatus(unsigned).signatory, null);
});

test('claim readiness counts documents and refuses to price what is missing', async () => {
  const { claimReadiness, DOC_STATE } = await import('../src/acs/acsCases.js');
  const review = claimReadiness(withRepair);
  assert.equal(review.rows.length, 9);
  assert.ok(review.rows.every(row => Object.values(DOC_STATE).includes(row.state)));
  assert.ok(review.rows.every(row => row.note), 'every row says why it is in that state');

  // The three resource rows are missing on every task in this export — that is the finding.
  for (const task of payload.tasks) {
    const rows = claimReadiness(task).rows;
    for (const label of ['Labor documentation', 'Service vehicle documentation',
      'Equipment and traffic control']) {
      assert.equal(rows.find(row => row.label === label).state, DOC_STATE.MISSING,
        `${label} must be missing on task ${task.taskNumber}`);
    }
    // No task can be claim-ready while those are absent.
    assert.equal(claimReadiness(task).ready, false);
    // And no row, note or summary may contain an invented dollar figure.
    assert.ok(!/\$\d/.test(claimReadiness(task).undocumentedCostNote));
  }
  assert.match(review.undocumentedCostNote, /Not quantifiable/);
});

test('documented cost is the form\'s own invoice total, not an estimate', async () => {
  const { claimReadiness } = await import('../src/acs/acsCases.js');
  const withCost = payload.tasks.find(task => task.stages.some(stage => stage.thirdPartyCostUSD));
  const expected = withCost.stages.reduce((sum, stage) => sum + (stage.thirdPartyCostUSD ?? 0), 0);
  assert.equal(claimReadiness(withCost).documentedUSD, expected);

  const noCost = payload.tasks.find(task => !task.stages.some(stage => stage.thirdPartyCostUSD));
  assert.equal(claimReadiness(noCost).documentedUSD, 0);
});
