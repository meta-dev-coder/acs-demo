/**
 * Phase 3: the mapping layer, the eleven rules, exceptions and reconciliation.
 *
 * Five things are held here:
 *
 *  1. The chain is DERIVED where the source publishes it and DECIDED only where it does not, and
 *     the worked example resolves end to end.
 *  2. Validation is DETERMINISTIC and its exceptions have a STABLE IDENTITY — running it ten times
 *     leaves one exception per problem, and a resolved one that comes back reopens rather than
 *     duplicating.
 *  3. A SUGGESTION IS NOT A MAPPING. Nothing is applied without an authorised approval.
 *  4. SOURCE RECORDS ARE NEVER WRITTEN.
 *  5. The reconciliation arithmetic is consistent, and excluded is not failed.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { openConstructionDb } from '../server/construction/db.mjs';
import { buildSeed, seedSourceSystems, REMOVED_IN_ARC_V4 } from '../server/construction/seed.mjs';
import { createMockAdapters } from '../server/construction/adapters.mjs';
import { runInboundSync } from '../server/construction/sync.mjs';
import {
  BASIS, MAPPING_STATUS, buildMappings, listMappings, mappingDetail, mappingSummary,
} from '../server/construction/mapping.mjs';
import { RULES, SEVERITY, ruleById, storeValidation, validate } from '../server/construction/validation.mjs';
import {
  EXCEPTION_STATUS, exceptionDetail, exceptionSummary, listExceptions, syncExceptions,
  transitionException,
} from '../server/construction/exceptions.mjs';
import { reconcile } from '../server/construction/reconciliation.mjs';
import {
  decideProposal, listProposals, proposeMapping, suggestActivities,
} from '../server/construction/proposals.mjs';

/** A database synced, mapped and validated — the state every route starts from. */
function fixture() {
  const db = openConstructionDb({ path: ':memory:' });
  seedSourceSystems(db);
  runInboundSync(db, createMockAdapters(db));
  buildMappings(db);
  const findings = validate(db);
  storeValidation(db, findings);
  syncExceptions(db, findings);
  return { db, findings };
}

const revalidate = db => {
  buildMappings(db);
  const findings = validate(db);
  storeValidation(db, findings);
  return { findings, exceptions: syncExceptions(db, findings) };
};

const count = (db, sql, ...params) => db.prepare(sql).get(...params).n;

/* ── the chain ─────────────────────────────────────────────────────────────────────────────── */

test('acceptance 1 — the COL-001 worked example resolves end to end', () => {
  const { db } = fixture();
  const detail = mappingDetail(db, 'COL-001');
  assert.deepEqual(detail.chain.map(step => step.id),
    ['COL-001', 'A-1020', '1.2.3', '1.2.3', 'CON-045']);
  assert.equal(detail.mapping.status, MAPPING_STATUS.COMPLETE);
  assert.equal(detail.chain[1].record.name, 'Cast Level 2 columns');
  assert.equal(detail.chain[4].record.description, 'Cast in-situ concrete columns, Grade M40');
});

test('the chain is derived from the source, not invented here', () => {
  const { db } = fixture();
  const detail = mappingDetail(db, 'COL-001');
  // Each link says where it came from. Three are published by a source system.
  assert.equal(detail.chain[1].basis, BASIS.SOURCE, 'the model names its activity');
  assert.equal(detail.chain[2].basis, BASIS.SOURCE, 'P6 names the activity\'s WBS');
  assert.equal(detail.chain[4].basis, BASIS.SOURCE, 'the model carries its own cost code');
  // The SAP correspondence is the one link no source publishes.
  assert.equal(detail.chain[3].basis, BASIS.UNAMBIGUOUS);
});

test('cardinality is never assumed to be one-to-one', () => {
  const { db } = fixture();
  const sharedActivity = count(db,
    `SELECT COUNT(*) AS n FROM (SELECT activity_id FROM mapping WHERE activity_id IS NOT NULL
        GROUP BY activity_id HAVING COUNT(*) > 1)`);
  assert.ok(sharedActivity > 0, 'several elements share one activity');
  const multiBoq = count(db,
    'SELECT COUNT(*) AS n FROM (SELECT sap_wbs_code FROM boq_item GROUP BY sap_wbs_code HAVING COUNT(*) > 1)');
  assert.ok(multiBoq > 0, 'a WBS carries several BOQ items');
  // Which is why some mappings legitimately await a choice rather than being broken.
  assert.ok(mappingSummary(db).needsSelection > 0);
});

test('acceptance 2 — every mapping count is a count of real rows', () => {
  const { db } = fixture();
  const summary = mappingSummary(db);
  assert.equal(summary.elements, count(db, 'SELECT COUNT(*) AS n FROM mapping'));
  assert.equal(summary.complete + summary.needsSelection + summary.incomplete, summary.elements);
  assert.equal(summary.withBoq, count(db, 'SELECT COUNT(*) AS n FROM mapping WHERE boq_code IS NOT NULL'));
  assert.equal(summary.elements, listMappings(db, { limit: 500 }).total);
});

/* ── validation ────────────────────────────────────────────────────────────────────────────── */

test('acceptance 3 — validation is deterministic', () => {
  const { db } = fixture();
  const first = validate(db).map(entry => entry.key).sort();
  const second = validate(db).map(entry => entry.key).sort();
  assert.deepEqual(first, second);
});

test('all eleven rules are declared, and each finding carries what the brief asks for', () => {
  const { db, findings } = fixture();
  assert.equal(RULES.length, 11);
  for (const entry of findings) {
    const rule = ruleById(entry.ruleId);
    assert.ok(rule, `${entry.ruleId} is not a declared rule`);
    for (const field of ['subjectId', 'severity', 'explanation', 'suggestedAction']) {
      assert.ok(entry[field], `${entry.ruleId} is missing ${field}`);
    }
    assert.ok([SEVERITY.ERROR, SEVERITY.WARNING, SEVERITY.EXCLUDED].includes(entry.severity));
  }
  const stored = db.prepare("SELECT * FROM validation_result WHERE status = 'OPEN'").all();
  for (const row of stored) {
    assert.ok(row.first_seen && row.last_seen && row.explanation);
    assert.ok(row.expected !== null || row.actual !== null, 'a finding states what it expected');
  }
});

test('an optional field that is simply absent is not a failure', () => {
  const { db, findings } = fixture();
  // Elements with no recorded quantity exist and must produce nothing on their own.
  const withoutQuantity = db.prepare(
    "SELECT source_id FROM element WHERE source_system = 'ACC' AND quantity IS NULL").all();
  for (const row of withoutQuantity) {
    const theirs = findings.filter(entry => entry.subjectId === row.source_id);
    assert.equal(theirs.some(entry => /quantity/i.test(entry.explanation)), false,
      `${row.source_id} was failed for an absent optional quantity`);
  }
});

test('a definite failure and a warning are kept apart', () => {
  const { findings } = fixture();
  const errors = new Set(findings.filter(e => e.severity === SEVERITY.ERROR).map(e => e.ruleId));
  const warnings = new Set(findings.filter(e => e.severity === SEVERITY.WARNING).map(e => e.ruleId));
  assert.ok(errors.has('R01_BIM_NO_ACTIVITY'), 'a broken chain is a failure');
  assert.ok(warnings.has('R06_UNIT_INCOMPATIBLE'), 'a unit difference is for a person to judge');
  assert.equal(errors.has('R09_UNPUBLISHED_MODEL'), false);
});

/* ── scenarios ─────────────────────────────────────────────────────────────────────────────── */

test('scenario C — an unpublished model is excluded, never failed', () => {
  const { db, findings } = fixture();
  const excluded = findings.filter(entry => entry.ruleId === 'R09_UNPUBLISHED_MODEL');
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].severity, SEVERITY.EXCLUDED);
  assert.equal(ruleById('R09_UNPUBLISHED_MODEL').actionable, false);
  // It raises no exception: nobody is asked to fix it.
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM exception WHERE rule_id = 'R09_UNPUBLISHED_MODEL'"), 0);
  // And it is still visible, with its reason.
  assert.match(excluded[0].explanation, /policy exclusion and not a failed import/);
  assert.equal(exceptionSummary(db).excludedByPolicy, 1);
});

test('scenario B — a SAP WBS with no P6 counterpart is reported to Finance, not corrected', () => {
  const { db, findings } = fixture();
  const mismatch = findings.filter(entry => entry.ruleId === 'R04_SAP_WBS_MISMATCH');
  assert.equal(mismatch.length, 1);
  assert.equal(mismatch[0].subjectId, '1.6');
  assert.equal(mismatch[0].owner, 'financeController');
  assert.match(mismatch[0].suggestedAction, /must not create a P6 node/);
  // The integration layer did not invent a counterpart.
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM wbs WHERE source_system = 'P6' AND source_id = '1.6'"), 0);
});

test('scenario D — a unit mismatch states both values', () => {
  const { findings } = fixture();
  const units = findings.filter(entry => entry.ruleId === 'R06_UNIT_INCOMPATIBLE');
  assert.ok(units.length > 0 && units.length < 20, `expected a handful, got ${units.length}`);
  for (const entry of units) {
    assert.match(entry.expected, /measured in \w+/);
    assert.match(entry.actual, /modelled in \w+/);
  }
});

test('scenario E — a newer published version flags the mappings it invalidates', () => {
  const { db, findings } = fixture();
  const removed = findings.filter(entry => entry.ruleId === 'R10_ELEMENT_REMOVED')
    .map(entry => entry.subjectId).sort();
  assert.deepEqual(removed, [...REMOVED_IN_ARC_V4].sort());
  // Their mappings survive rather than vanishing, so a person decides.
  for (const id of removed) assert.ok(mappingDetail(db, id), `${id} lost its mapping silently`);
});

/* ── exceptions ────────────────────────────────────────────────────────────────────────────── */

test('acceptance 4 — repeat validation never duplicates an exception', () => {
  const { db } = fixture();
  const after = () => count(db, 'SELECT COUNT(*) AS n FROM exception');
  const first = after();
  for (let run = 0; run < 5; run += 1) revalidate(db);
  assert.equal(after(), first, 'exception rows multiplied across runs');
  // And each one has exactly one DETECTED event.
  for (const row of db.prepare('SELECT id FROM exception').all()) {
    assert.equal(count(db,
      "SELECT COUNT(*) AS n FROM exception_event WHERE exception_id = ? AND event = 'DETECTED'", row.id), 1);
  }
});

test('only actionable findings become exceptions', () => {
  const { db, findings } = fixture();
  const actionable = findings.filter(entry => ruleById(entry.ruleId).actionable).length;
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM exception'), actionable);
});

test('acceptance 10 — a resolved exception stays, and a returning one reopens it', () => {
  const { db } = fixture();
  const target = db.prepare(
    "SELECT * FROM exception WHERE rule_id = 'R01_BIM_NO_ACTIVITY' ORDER BY id LIMIT 1").get();
  const elementId = target.subject_id;

  // Correct it, which resolves the exception.
  const proposal = proposeMapping(db, { elementId, field: 'activity_id', proposedValue: 'A-1020',
    reason: 'Test correction.', requester: 'tester', requesterRole: 'bimCoordinator' });
  decideProposal(db, proposal.proposal.id, 'APPROVE', { actor: 'planner', actorRole: 'planner' });
  revalidate(db);
  let row = db.prepare('SELECT * FROM exception WHERE id = ?').get(target.id);
  assert.equal(row.status, EXCEPTION_STATUS.RESOLVED);
  assert.ok(row.resolved_at);

  // Withdraw the correction: the same problem returns.
  db.prepare("UPDATE mapping_proposal SET status = 'WITHDRAWN' WHERE id = ?").run(proposal.proposal.id);
  revalidate(db);
  row = db.prepare('SELECT * FROM exception WHERE id = ?').get(target.id);
  assert.equal(row.status, EXCEPTION_STATUS.OPEN);
  assert.equal(row.reopen_count, 1);
  assert.equal(row.first_detected, target.first_detected, 'the original first-detected survived');
  assert.equal(row.resolved_at, null);
  // Exactly one row for this problem, with its whole history.
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM exception WHERE subject_id = ? AND rule_id = ?',
    elementId, 'R01_BIM_NO_ACTIVITY'), 1);
  const history = exceptionDetail(db, target.id).history.map(entry => entry.event);
  assert.deepEqual(history, ['DETECTED', 'RESOLVED_BY_REVALIDATION', 'REOPENED']);
});

test('an exception cannot be declared resolved by hand', () => {
  const { db } = fixture();
  const row = db.prepare('SELECT * FROM exception LIMIT 1').get();
  const result = transitionException(db, row.id, 'RESOLVED', { actor: 'tester' });
  assert.equal(result.ok, false);
  assert.match(result.error, /resolved by revalidation/);
});

test('the exception lifecycle refuses a move it does not allow', () => {
  const { db } = fixture();
  const row = db.prepare("SELECT * FROM exception WHERE status = 'OPEN' LIMIT 1").get();
  assert.equal(transitionException(db, row.id, 'READY_FOR_REVALIDATION', { actor: 't' }).ok, false);
  assert.equal(transitionException(db, row.id, 'UNDER_REVIEW', { actor: 't' }).ok, true);
  assert.equal(transitionException(db, row.id, 'READY_FOR_REVALIDATION', { actor: 't' }).ok, true);
  assert.deepEqual(exceptionDetail(db, row.id).history.map(e => e.to_status),
    ['OPEN', 'UNDER_REVIEW', 'READY_FOR_REVALIDATION']);
});

test('an exception names the mapping it is about', () => {
  const { db } = fixture();
  const row = db.prepare("SELECT * FROM exception WHERE subject_type = 'element' LIMIT 1").get();
  assert.equal(exceptionDetail(db, row.id).elementId, row.subject_id);
  assert.ok(mappingDetail(db, row.subject_id));
});

/* ── suggestions and approval ──────────────────────────────────────────────────────────────── */

test('acceptance 5 — every candidate explains its evidence', () => {
  const { db } = fixture();
  const unmapped = db.prepare('SELECT element_id FROM mapping WHERE activity_id IS NULL LIMIT 1').get();
  const result = suggestActivities(db, unmapped.element_id);
  assert.ok(result.candidates.length > 0);
  for (const candidate of result.candidates) {
    assert.ok(candidate.reasons.length > 0, `${candidate.activityId} gives no reason`);
    for (const reason of candidate.reasons) assert.ok(reason.length > 15);
    assert.ok(candidate.confidence > 0 && candidate.confidence <= 92, 'never certain');
    assert.equal(candidate.requiresApproval, true);
  }
});

test('acceptance 6 — a suggestion changes nothing on its own', () => {
  const { db } = fixture();
  const unmapped = db.prepare('SELECT element_id FROM mapping WHERE activity_id IS NULL LIMIT 1').get();
  const before = db.prepare('SELECT * FROM mapping WHERE element_id = ?').get(unmapped.element_id);
  suggestActivities(db, unmapped.element_id);
  const after = db.prepare('SELECT * FROM mapping WHERE element_id = ?').get(unmapped.element_id);
  assert.deepEqual(after, before);
  assert.equal(listProposals(db, { elementId: unmapped.element_id }).length, 0);
});

test('acceptance 7 — only the field’s own data owner may approve it', () => {
  const { db } = fixture();
  const unmapped = db.prepare('SELECT element_id FROM mapping WHERE activity_id IS NULL LIMIT 1').get();
  const candidate = suggestActivities(db, unmapped.element_id).candidates[0];
  const proposal = proposeMapping(db, { elementId: unmapped.element_id, field: 'activity_id',
    proposedValue: candidate.activityId, reason: 'Siblings are built by it.',
    requester: 'B. Shah', requesterRole: 'bimCoordinator' });
  assert.equal(proposal.ok, true);
  assert.equal(proposal.approverRole, 'planner');

  for (const role of ['bimCoordinator', 'financeController', 'integrationLead', undefined]) {
    const refused = decideProposal(db, proposal.proposal.id, 'APPROVE', { actor: 'x', actorRole: role });
    assert.equal(refused.ok, false, `${role} must not approve a schedule link`);
    assert.match(refused.error, /approved by the planner role/);
  }
  assert.equal(db.prepare('SELECT status FROM mapping_proposal WHERE id = ?')
    .get(proposal.proposal.id).status, 'PENDING_REVIEW');

  const approved = decideProposal(db, proposal.proposal.id, 'APPROVE',
    { actor: 'R. Nair', actorRole: 'planner' });
  assert.equal(approved.ok, true);
  assert.equal(approved.status, 'APPLIED');
});

test('a proposal must name a record that exists and carry a reason', () => {
  const { db } = fixture();
  const element = db.prepare('SELECT element_id FROM mapping LIMIT 1').get().element_id;
  assert.match(proposeMapping(db, { elementId: element, field: 'activity_id',
    proposedValue: 'A-NOPE', reason: 'why', requester: 'x', requesterRole: 'bimCoordinator' }).error,
  /no activity A-NOPE/);
  assert.match(proposeMapping(db, { elementId: element, field: 'activity_id',
    proposedValue: 'A-1020', reason: '  ', requester: 'x', requesterRole: 'bimCoordinator' }).error,
  /must carry a reason/);
  assert.match(proposeMapping(db, { elementId: element, field: 'budget',
    proposedValue: '1', reason: 'why', requester: 'x', requesterRole: 'bimCoordinator' }).error,
  /not a proposable mapping field/);
});

test('acceptance 8 — approving a mapping change writes no source record', () => {
  const { db } = fixture();
  const snapshot = () => JSON.stringify({
    elements: db.prepare('SELECT * FROM src_acc_element ORDER BY element_id, version_id').all(),
    activities: db.prepare('SELECT * FROM src_p6_activity ORDER BY activity_id').all(),
    sap: db.prepare('SELECT * FROM src_sap_boq ORDER BY code').all(),
    wbs: db.prepare('SELECT * FROM src_p6_wbs ORDER BY code').all(),
  });
  const before = snapshot();
  const unmapped = db.prepare('SELECT element_id FROM mapping WHERE activity_id IS NULL LIMIT 1').get();
  const candidate = suggestActivities(db, unmapped.element_id).candidates[0];
  const proposal = proposeMapping(db, { elementId: unmapped.element_id, field: 'activity_id',
    proposedValue: candidate.activityId, reason: 'Test.', requester: 'x', requesterRole: 'bimCoordinator' });
  decideProposal(db, proposal.proposal.id, 'APPROVE', { actor: 'y', actorRole: 'planner' });
  revalidate(db);
  assert.equal(snapshot(), before, 'a source table was modified by a mapping correction');
  // The change lives in the integration layer, and says so.
  assert.equal(db.prepare('SELECT activity_basis FROM mapping WHERE element_id = ?')
    .get(unmapped.element_id).activity_basis, BASIS.APPROVED);
});

test('acceptance 9 — an approved change is revalidated and its exception closes', () => {
  const { db } = fixture();
  const target = db.prepare(
    "SELECT * FROM exception WHERE rule_id = 'R01_BIM_NO_ACTIVITY' ORDER BY id LIMIT 1").get();
  const candidate = suggestActivities(db, target.subject_id).candidates[0];
  const proposal = proposeMapping(db, { elementId: target.subject_id, field: 'activity_id',
    proposedValue: candidate.activityId, reason: 'Test.', requester: 'x',
    requesterRole: 'bimCoordinator', exceptionId: target.id });
  decideProposal(db, proposal.proposal.id, 'APPROVE', { actor: 'y', actorRole: 'planner' });
  const after = revalidate(db);
  assert.ok(after.exceptions.resolved >= 1);
  assert.equal(db.prepare('SELECT status FROM exception WHERE id = ?').get(target.id).status,
    EXCEPTION_STATUS.RESOLVED);
  assert.equal(db.prepare('SELECT activity_id FROM mapping WHERE element_id = ?')
    .get(target.subject_id).activity_id, candidate.activityId);
});

test('a proposal is held when the source moved under it', () => {
  const { db } = fixture();
  const unmapped = db.prepare('SELECT element_id FROM mapping WHERE activity_id IS NULL LIMIT 1').get();
  const candidate = suggestActivities(db, unmapped.element_id).candidates[0];
  const proposal = proposeMapping(db, { elementId: unmapped.element_id, field: 'activity_id',
    proposedValue: candidate.activityId, reason: 'Test.', requester: 'x', requesterRole: 'bimCoordinator' });
  // P6 republishes the element's own record between the proposal and the approval.
  db.prepare("UPDATE element SET source_rev = source_rev + 1 WHERE source_id = ? AND source_system = 'ACC'")
    .run(unmapped.element_id);

  const held = decideProposal(db, proposal.proposal.id, 'APPROVE', { actor: 'y', actorRole: 'planner' });
  assert.equal(held.ok, false);
  assert.equal(held.held, true);
  assert.match(held.error, /changed after this proposal was raised/);
  assert.equal(db.prepare('SELECT status FROM mapping_proposal WHERE id = ?')
    .get(proposal.proposal.id).status, 'HELD');
  // Nothing was applied.
  assert.equal(db.prepare('SELECT activity_id FROM mapping WHERE element_id = ?')
    .get(unmapped.element_id).activity_id, null);
});

test('a BOQ choice may not cross the cost structure', () => {
  const { db } = fixture();
  const row = db.prepare(
    "SELECT * FROM mapping WHERE status = 'NEEDS_SELECTION' AND sap_wbs_code IS NOT NULL LIMIT 1").get();
  const elsewhere = db.prepare('SELECT source_id FROM boq_item WHERE sap_wbs_code <> ? LIMIT 1')
    .get(row.sap_wbs_code);
  const refused = proposeMapping(db, { elementId: row.element_id, field: 'boq_code',
    proposedValue: elsewhere.source_id, reason: 'Test.', requester: 'x', requesterRole: 'financeController' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /would cross the cost structure/);
});

/* ── reconciliation ────────────────────────────────────────────────────────────────────────── */

test('acceptance 12 — every reconciliation total is internally consistent', () => {
  const { db } = fixture();
  const checks = reconcile(db);
  assert.equal(checks.length, 10);
  for (const entry of checks) {
    assert.equal(entry.checked, entry.matched + entry.unmatched + entry.excluded,
      `${entry.id}: checked != matched + unmatched + excluded`);
    assert.ok(entry.warnings <= entry.unmatched, `${entry.id}: warnings must be a subset of unmatched`);
    assert.ok(entry.detail.length > 20, `${entry.id} explains nothing`);
  }
});

test('acceptance 11 — the WIP version is excluded, and counted as excluded', () => {
  const { db } = fixture();
  const checks = reconcile(db);
  const versions = checks.find(entry => entry.id === 'MODEL_VERSION_STATE');
  assert.equal(versions.excluded, 1);
  assert.equal(versions.unmatched, 0, 'an excluded version is not an unmatched one');
  assert.equal(versions.status, 'PASS');
  // And nothing from it was imported.
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM model_version WHERE source_id = 'TOWERA-STR-v6'"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM element WHERE model_version_id = 'TOWERA-STR-v6'"), 0);
});

test('reconciliation is computed from the records, not from a counter', () => {
  const { db } = fixture();
  const before = reconcile(db).find(entry => entry.id === 'ELEMENT_ACTIVITY_COVERAGE');
  db.prepare("UPDATE mapping SET activity_id = NULL WHERE element_id = 'COL-002'").run();
  const after = reconcile(db).find(entry => entry.id === 'ELEMENT_ACTIVITY_COVERAGE');
  assert.equal(after.unmatched, before.unmatched + 1);
  assert.equal(after.matched, before.matched - 1);
});

/* ── end to end ────────────────────────────────────────────────────────────────────────────── */

test('the whole correction workflow, from exception to revalidation', () => {
  const { db } = fixture();
  const open = listExceptions(db, { rule: 'R01_BIM_NO_ACTIVITY' });
  assert.ok(open.total > 0);
  const exception = open.rows[0];

  // 1. candidates, with evidence
  const suggestion = suggestActivities(db, exception.subject_id);
  assert.ok(suggestion.candidates[0].reasons.length);

  // 2. a proposal, which changes nothing yet
  const proposal = proposeMapping(db, { elementId: exception.subject_id, field: 'activity_id',
    proposedValue: suggestion.candidates[0].activityId, reason: 'Matches its siblings.',
    requester: 'B. Shah', requesterRole: 'bimCoordinator', exceptionId: exception.id });
  assert.equal(db.prepare('SELECT activity_id FROM mapping WHERE element_id = ?')
    .get(exception.subject_id).activity_id, null);

  // 3. the wrong role is refused, the right one approves
  assert.equal(decideProposal(db, proposal.proposal.id, 'APPROVE',
    { actor: 'B. Shah', actorRole: 'bimCoordinator' }).ok, false);
  assert.equal(decideProposal(db, proposal.proposal.id, 'APPROVE',
    { actor: 'R. Nair', actorRole: 'planner' }).ok, true);

  // 4. revalidation closes it, and the mapping now shows an approved link
  revalidate(db);
  assert.equal(db.prepare('SELECT status FROM exception WHERE id = ?').get(exception.id).status,
    EXCEPTION_STATUS.RESOLVED);
  const detail = mappingDetail(db, exception.subject_id);
  assert.equal(detail.chain[1].basis, BASIS.APPROVED);
  assert.equal(detail.proposals[0].status, 'APPLIED');
  assert.equal(detail.proposals[0].approver_role, 'planner');
});

test('acceptance 14 — reset clears Phase 3 state and the seed rebuilds identically', async () => {
  const { db } = fixture();
  const { clearConstructionDb } = await import('../server/construction/db.mjs');
  const before = mappingSummary(db);
  proposeMapping(db, { elementId: 'COL-001', field: 'activity_id', proposedValue: 'A-1030',
    reason: 'Test.', requester: 'x', requesterRole: 'bimCoordinator' });

  clearConstructionDb(db);
  for (const table of ['mapping', 'exception', 'validation_result', 'mapping_proposal',
    'reconciliation_run']) {
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM ${table}`), 0, `${table} survived the reset`);
  }
  seedSourceSystems(db, buildSeed());
  runInboundSync(db, createMockAdapters(db));
  buildMappings(db);
  const after = mappingSummary(db);
  assert.equal(after.elements, before.elements);
  assert.equal(after.complete, before.complete);
  assert.equal(after.incomplete, before.incomplete);
});
