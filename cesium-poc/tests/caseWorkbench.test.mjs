/**
 * The Case Workbench model.
 *
 * Two things are being held here. The first is that the workbench says each thing once: a queue
 * row carries six fields and not the lifecycle, the header owns the lifecycle, and the action
 * section owns the next step. The second is that it says the same thing the validation engine
 * said — these tests run the real seven cases through the real engine, so a status asserted here
 * is the status the engine reached.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { STATUS } from '../src/qcqa/schema.js';
import { STAGE_ORDER, STAGE_STATUS } from '../src/qcqa/stageValidation.js';
import { buildDemoCases, loadDemoCases, resetDemoCases } from '../src/acs/acsDemoCases.js';
import {
  QUEUE_FILTERS, WORKBENCH_SECTIONS, actionRequiredOf, blockingStageOf, bucketCounts, filterQueue,
  headerOf, lastActivityOf, openStagesFor, orderedFindings, queueBucketOf, queueFacets, queueRow,
  recoveryStateFor, validationTimeline,
} from '../src/maintenance/caseWorkbenchModel.js';

const fileFetcher = async path => {
  const body = await readFile(new URL(`../public/${path}`, import.meta.url), 'utf8');
  return { ok: true, json: async () => JSON.parse(body) };
};

const incidents = Array.from({ length: 12 }, (unused, index) => ({
  id: `INC-${900 + index}`, title: 'Vehicle collision',
  longitude: -80.4 + index * 0.02, latitude: 26.07,
  segmentName: index % 2 ? 'Central Segment' : 'East Segment', createdDate: '2026-01-10', related: {},
}));

resetDemoCases();
const built = buildDemoCases(await loadDemoCases(fileFetcher), incidents);
const records = built.records;
const byId = Object.fromEntries(records.map(record => [record.id, record]));
const rows = records.map(record => queueRow(record));

test('all seven cases survive the redesign with the statuses the engine gives them', () => {
  assert.equal(records.length, 7);
  assert.deepEqual(Object.fromEntries(records.map(r => [r.id, r.evaluation.presentation.label])), {
    'ACS-DEMO-001': 'Blocked at inspection',
    'ACS-DEMO-002': 'Blocked at repair',
    'ACS-DEMO-003': 'Rework required',
    'ACS-DEMO-004': 'Claim action required',
    'ACS-DEMO-005': 'Closed',
    'ACS-DEMO-006': 'Repair in progress',
    'ACS-DEMO-007': 'Awaiting claim',
  });
});

test('a queue row carries six facts and no lifecycle', () => {
  const row = rows[0];
  assert.deepEqual(
    ['caseId', 'assetType', 'segment', 'corridorMile', 'blockingStage', 'status', 'lastActivity']
      .filter(key => key in row).length, 7);
  // The things the old slider card repeated and the row must not.
  for (const key of ['description', 'incidentDescription', 'statuses', 'stages', 'nextAction', 'explanation']) {
    assert.equal(key in row, false, `a queue row must not carry ${key}`);
  }
});

test('a waiting case is "in progress", never "needs action"', () => {
  assert.equal(queueBucketOf(byId['ACS-DEMO-007'].evaluation), 'progress');
  assert.equal(queueBucketOf(byId['ACS-DEMO-006'].evaluation), 'progress');
  assert.equal(queueBucketOf(byId['ACS-DEMO-001'].evaluation), 'action');
  assert.equal(queueBucketOf(byId['ACS-DEMO-005'].evaluation), 'closed');
});

test('the bucket counts add up to the queue, and every filter is offered', () => {
  const counts = bucketCounts(rows);
  assert.equal(counts.all, 7);
  assert.equal(counts.action + counts.progress + counts.closed, 7);
  assert.deepEqual(QUEUE_FILTERS.map(filter => filter.id), ['all', 'action', 'progress', 'closed']);
});

test('the facets are the values the loaded cases actually have', () => {
  const facets = queueFacets(rows);
  assert.ok(facets.assetType.length > 1);
  assert.ok(facets.stage.every(stage => STAGE_ORDER.includes(stage)));
  assert.ok(facets.severity.every(value => rows.some(row => row.severity === value)));
});

test('an unset filter removes nothing and the search reads only the row\'s own fields', () => {
  assert.equal(filterQueue(rows, {}).length, 7);
  assert.equal(filterQueue(rows, { bucket: 'all' }).length, 7);
  assert.deepEqual(filterQueue(rows, { query: 'demo-003' }).map(row => row.caseId), ['ACS-DEMO-003']);
  // The incident description is not on the row, so it is not searchable from the queue.
  assert.equal(filterQueue(rows, { query: 'cartridges are crushed' }).length, 0);
});

test('the date filter reads the reported date, inclusive at both ends', () => {
  const reported = rows[0].reportedAt.slice(0, 10);
  assert.ok(filterQueue(rows, { from: reported, to: reported }).some(row => row.caseId === rows[0].caseId));
  assert.equal(filterQueue(rows, { from: '2099-01-01' }).length, 0);
});

test('the blocking stage is the first stage that has not passed, and a closed case has none', () => {
  assert.equal(blockingStageOf(byId['ACS-DEMO-001'].evaluation), 'INSPECTION');
  assert.equal(blockingStageOf(byId['ACS-DEMO-003'].evaluation), 'QCQA');
  assert.equal(blockingStageOf(byId['ACS-DEMO-004'].evaluation), 'CLAIM');
  assert.equal(blockingStageOf(byId['ACS-DEMO-005'].evaluation), null);
});

test('the header owns the lifecycle, the location and the overall status', () => {
  const header = headerOf(byId['ACS-DEMO-002']);
  assert.equal(header.caseId, 'ACS-DEMO-002');
  assert.equal(header.stages.length, 4);
  assert.deepEqual(header.stages.map(stage => stage.key), STAGE_ORDER);
  assert.equal(header.stages.filter(stage => stage.current).length, 1);
  assert.ok(header.status);
  assert.ok(header.location.roadway);
});

test('every stage tile carries its own counts, so a passed stage says what passed', () => {
  const header = headerOf(byId['ACS-DEMO-002']);
  const inspection = header.stages.find(stage => stage.key === 'INSPECTION');
  assert.equal(inspection.status, STAGE_STATUS.PASSED);
  assert.ok(inspection.counts.passed > 0, 'a passed stage is reachable and says how much passed');
  assert.equal(inspection.counts.failed, 0);
  for (const stage of header.stages) {
    const summary = byId['ACS-DEMO-002'].evaluation.stages[stage.key].summary;
    assert.deepEqual(stage.counts,
      { failed: summary.failed, missing: summary.missing, passed: summary.passed }, stage.key);
  }
});

test('a blocked stage names its gate instead of reporting zero checks of its own', () => {
  const header = headerOf(byId['ACS-DEMO-001']);
  const repair = header.stages.find(stage => stage.key === 'REPAIR');
  assert.equal(repair.status, STAGE_STATUS.BLOCKED);
  assert.equal(repair.blockedBy, 'INSPECTION');
  assert.deepEqual(repair.counts, { failed: 0, missing: 0, passed: 0 },
    'it has no findings — which is why it must not be drawn as a failure');
  const inspection = header.stages.find(stage => stage.key === 'INSPECTION');
  assert.equal(inspection.status, STAGE_STATUS.FAILED);
  assert.equal(inspection.blockedBy, null, 'a failed stage is not blocked by anything');
});

test('no stage is both failed and blocked, across all seven cases', () => {
  for (const record of records) {
    for (const stage of headerOf(record).stages) {
      if (stage.blockedBy) assert.equal(stage.status, STAGE_STATUS.BLOCKED, `${record.id} ${stage.key}`);
      if (stage.status === STAGE_STATUS.FAILED) assert.equal(stage.blockedBy, null, `${record.id} ${stage.key}`);
    }
  }
});

test('the corridor mile is only reported when there is a position to measure', () => {
  const withPosition = headerOf(byId['ACS-DEMO-001'], { positionOf: () => ({ milepost: 4.25 }) });
  assert.equal(withPosition.location.corridorMile, 4.25);
  assert.equal(headerOf(byId['ACS-DEMO-001']).location.corridorMile, null);
});

test('each case\'s action section names what failed, why it matters and who owns it', () => {
  for (const record of records) {
    const action = actionRequiredOf(record);
    assert.ok(action.detection, `${record.id} detection`);
    assert.ok(action.impact, `${record.id} impact`);
    assert.ok(action.action, `${record.id} action`);
    if (record.id === 'ACS-DEMO-005') assert.equal(action.resolved, true);
    else assert.equal(action.resolved, false, `${record.id} is not closed`);
  }
});

test('the seven outcomes the brief lists come out of the engine, not out of a per-case string', () => {
  assert.match(actionRequiredOf(byId['ACS-DEMO-001']).detection, /inspection record failed validation/i);
  assert.match(actionRequiredOf(byId['ACS-DEMO-002']).detection, /repair record failed validation/i);
  assert.match(actionRequiredOf(byId['ACS-DEMO-003']).detection, /QC\/QA failed/i);
  assert.match(actionRequiredOf(byId['ACS-DEMO-004']).detection, /claim record failed validation/i);
  assert.match(actionRequiredOf(byId['ACS-DEMO-005']).detection, /All four stages passed/i);
  assert.match(actionRequiredOf(byId['ACS-DEMO-006']).detection, /under way/i);
  assert.match(actionRequiredOf(byId['ACS-DEMO-007']).detection, /no claim record exists yet/i);
});

test('ACS-DEMO-003 reports its open non-conformances, which is the QA/QC failure', () => {
  const action = actionRequiredOf(byId['ACS-DEMO-003']);
  assert.ok(action.nonConformances.length > 0);
  assert.ok(action.nonConformances.every(entry => entry.status === 'OPEN'));
});

test('evidence required lists only the missing mandatory fields of the blocking stage', () => {
  const action = actionRequiredOf(byId['ACS-DEMO-001']);
  assert.ok(action.evidenceRequired.length > 0);
  const findings = byId['ACS-DEMO-001'].evaluation.stages.INSPECTION.findings;
  for (const entry of action.evidenceRequired) {
    const field = findings.find(item => item.fieldId === entry.fieldId);
    assert.equal(field.status, STATUS.MISSING);
    assert.equal(field.required, true);
  }
});

test('without a recovery search, no field claims anything about another system', () => {
  for (const entry of actionRequiredOf(byId['ACS-DEMO-001']).evidenceRequired) {
    assert.equal(entry.recoverable, null);
  }
  assert.equal(recoveryStateFor('anything', null), null);
});

test('a recovery result is reported as a prospect, with review and policy kept apart', () => {
  const recovery = { gaps: [
    { fieldId: 'a', resolvable: true, requiresReview: false, best: { recordId: 'R1' }, candidates: [] },
    { fieldId: 'b', resolvable: true, requiresReview: true, reviewReason: 'two identifier matches', best: {}, candidates: [] },
    { fieldId: 'c', resolvable: false },
    { fieldId: 'd', humanOnly: { reason: 'a person must sign it' } },
  ] };
  assert.equal(recoveryStateFor('a', recovery).state, 'CANDIDATE');
  assert.equal(recoveryStateFor('b', recovery).state, 'NEEDS_REVIEW');
  assert.equal(recoveryStateFor('c', recovery).state, 'NOT_FOUND');
  assert.equal(recoveryStateFor('d', recovery).state, 'HUMAN_ONLY');
});

test('the failed or active stage is the one that opens; passed and blocked stages stay shut', () => {
  for (const record of records) {
    const open = openStagesFor(record.evaluation);
    for (const stage of open) {
      assert.notEqual(record.evaluation.statuses[stage], STAGE_STATUS.PASSED,
        `${record.id}: a passed stage must not open`);
    }
    const failedOrRunning = STAGE_ORDER.filter(stage =>
      [STAGE_STATUS.FAILED, STAGE_STATUS.IN_PROGRESS].includes(record.evaluation.statuses[stage]));
    if (failedOrRunning.length) assert.deepEqual(open, failedOrRunning, record.id);
  }
});

test('a closed case opens no stage: there is nothing outstanding to read', () => {
  assert.deepEqual(openStagesFor(byId['ACS-DEMO-005'].evaluation), []);
});

test('exactly one stage opens for each of the six cases that are not closed', () => {
  for (const record of records) {
    if (record.id === 'ACS-DEMO-005') continue;
    assert.equal(openStagesFor(record.evaluation).length, 1, record.id);
  }
});

test('findings are ordered worst first, so a failure is never below twenty passes', () => {
  const stage = byId['ACS-DEMO-001'].evaluation.stages.INSPECTION;
  const ordered = orderedFindings(stage);
  const first = ordered.findIndex(field => field.status === STATUS.PASS);
  const lastBad = ordered.map(field => field.status)
    .lastIndexOf(STATUS.MISSING);
  assert.ok(first === -1 || lastBad < first, 'every fail and miss comes before the first pass');
});

test('the timeline carries all four stages and attaches recovery only to missing fields', () => {
  const recovery = { gaps: [{ fieldId: 'insp_damage_photos', resolvable: true, requiresReview: false, best: {}, candidates: [] }] };
  const timeline = validationTimeline(byId['ACS-DEMO-001'], { recovery });
  assert.deepEqual(timeline.map(stage => stage.key), STAGE_ORDER);
  for (const stage of timeline) {
    for (const field of stage.findings) {
      if (field.status !== STATUS.MISSING) assert.equal(field.recovery, null, field.fieldId);
    }
  }
  const photos = timeline[0].findings.find(field => field.fieldId === 'insp_damage_photos');
  assert.equal(photos.recovery.state, 'CANDIDATE', 'evidence sits beside the field it would fill');
});

test('last activity comes from the case\'s own trail', () => {
  const record = byId['ACS-DEMO-005'];
  assert.equal(lastActivityOf(record.demoCase),
    record.demoCase.auditTrail[record.demoCase.auditTrail.length - 1].at);
  assert.equal(lastActivityOf({}), null);
});

test('the workbench has the five sections the redesign calls for, in order', () => {
  assert.deepEqual(WORKBENCH_SECTIONS.map(section => section.id),
    ['action', 'validation', 'context', 'claim', 'history']);
});
