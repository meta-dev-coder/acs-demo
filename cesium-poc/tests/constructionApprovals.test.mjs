/**
 * Phase 5: approvals and controlled write-back.
 *
 * What is held here:
 *
 *  1. NOTHING POSTS WITHOUT APPROVAL, and the approver is decided by the SESSION, not by anything
 *     in the request body. A body that claims a role is ignored.
 *  2. NOTHING OVERWRITES A NEWER VALUE. If the source, the evidence or the mapping moved after
 *     approval, the proposal is held and the destination is not called.
 *  3. ONLY PERMITTED FIELDS. Baselines, logic, calendars, budgets, cost postings, rates and
 *     master data are never written, and a test reads them before and after.
 *  4. NOTHING IS POSTED THAT WAS NOT ACKNOWLEDGED. A failure stays visible and retryable.
 *  5. A PARTIAL VALUATION SAYS SO. An aggregate covering part of a WBS is never presented as the
 *     whole of it.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { openConstructionDb } from '../server/construction/db.mjs';
import { buildSeed, FULLY_PRICED_WBS, seedSourceSystems } from '../server/construction/seed.mjs';
import { createMockAdapters } from '../server/construction/adapters.mjs';
import { runInboundSync } from '../server/construction/sync.mjs';
import { buildMappings } from '../server/construction/mapping.mjs';
import { storeValidation, validate } from '../server/construction/validation.mjs';
import { syncExceptions } from '../server/construction/exceptions.mjs';
import { seedProgress } from '../server/construction/progressSeed.mjs';
import { prepareP6Draft } from '../server/construction/model.mjs';
import { APPROVER_ROLE, DEMO_AUTH, issueSession, may, sessionFor } from '../server/construction/auth.mjs';
import {
  PERMITTED_FIELDS, STATUS, TRANSITIONS, decide, preflight, proposeP6Update,
  proposeSapEarnedValue, submit, transition,
} from '../server/construction/outbound.mjs';
import {
  clearFailures, forceFailure, post, proposalDetail, writeBackReconciliation,
} from '../server/construction/destinations.mjs';

function fixture() {
  const db = openConstructionDb({ path: ':memory:' });
  seedSourceSystems(db);
  runInboundSync(db, createMockAdapters(db));
  buildMappings(db);
  const findings = validate(db);
  storeValidation(db, findings);
  syncExceptions(db, findings);
  seedProgress(db);
  clearFailures();
  const session = role => sessionFor(db, issueSession(db, { role, actor: `${role} (test)` }).token);
  return { db, session };
}

const count = (db, sql, ...params) => db.prepare(sql).get(...params).n;

/** Raise, submit and approve an INT-02 proposal for A-1020. */
function approvedP6(db, session) {
  const draft = prepareP6Draft(db, 'A-1020', { actor: 'test' });
  const raised = proposeP6Update(db, draft.draft.id, { actor: 'test', actorRole: 'planner' });
  submit(db, raised.proposal.id, { actor: 'test', actorRole: 'planner' });
  decide(db, raised.proposal.id, 'APPROVE', { session });
  return raised.proposal.id;
}

/* ── authorization ─────────────────────────────────────────────────────────────────────────── */

test('the demo authorization says plainly what it is not', () => {
  assert.equal(DEMO_AUTH.production, false);
  assert.match(DEMO_AUTH.note, /not authentication/);
  assert.match(DEMO_AUTH.note, /no credential check|no identity provider/);
});

test('acceptance 4 — the role comes from the session, never from the request', () => {
  const { db, session } = fixture();
  const id = (() => {
    const draft = prepareP6Draft(db, 'A-1020', { actor: 'test' });
    const raised = proposeP6Update(db, draft.draft.id, { actor: 'test', actorRole: 'planner' });
    submit(db, raised.proposal.id, { actor: 'test', actorRole: 'planner' });
    return raised.proposal.id;
  })();

  // Every wrong role is refused, however it describes itself.
  for (const role of ['bimCoordinator', 'financeController', 'integrationLead']) {
    const refused = decide(db, id, 'APPROVE', { session: session(role) });
    assert.equal(refused.ok, false, `${role} must not approve INT-02`);
    assert.equal(refused.forbidden, true);
  }
  // No session at all.
  assert.equal(decide(db, id, 'APPROVE', { session: null }).ok, false);
  // A forged session object is still only a role the server reads; the body never carried one.
  assert.equal(db.prepare('SELECT status FROM outbound_proposal WHERE id = ?').get(id).status,
    STATUS.PENDING_APPROVAL);
  assert.equal(decide(db, id, 'APPROVE', { session: session('planner') }).ok, true);
});

test('the two approvals are separate and no role holds both', () => {
  assert.equal(APPROVER_ROLE['INT-02'], 'planner');
  assert.equal(APPROVER_ROLE['INT-05'], 'financeController');
  const { session } = fixture();
  assert.equal(may(session('planner'), 'approve:INT-05'), false);
  assert.equal(may(session('financeController'), 'approve:INT-02'), false);
  // The Integration Lead may watch and retry, and approve nothing.
  const lead = session('integrationLead');
  assert.equal(may(lead, 'retry'), true);
  assert.equal(may(lead, 'approve:INT-02'), false);
  assert.equal(may(lead, 'approve:INT-05'), false);
});

/* ── the lifecycle ─────────────────────────────────────────────────────────────────────────── */

test('acceptance 1 — a draft cannot post', () => {
  const { db, session } = fixture();
  const draft = prepareP6Draft(db, 'A-1020', { actor: 'test' });
  const raised = proposeP6Update(db, draft.draft.id, { actor: 'test', actorRole: 'planner' });
  const refused = post(db, raised.proposal.id, { session: session('planner') });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /The proposal is approved: Status is DRAFT/);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM outbound_attempt'), 0, 'nothing was attempted');
  assert.equal(db.prepare("SELECT pct_complete AS p FROM src_p6_activity WHERE activity_id = 'A-1020'").get().p, 80);
});

test('acceptance 2 and 8 — approved, posted once, and never again', () => {
  const { db, session } = fixture();
  const id = approvedP6(db, session('planner'));
  const posted = post(db, id, { session: session('planner') });
  assert.equal(posted.ok, true);
  assert.equal(posted.status, STATUS.POSTED);
  assert.equal(posted.response.acknowledged, true);

  const again = post(db, id, { session: session('planner') });
  assert.equal(again.ok, false);
  assert.equal(again.alreadyPosted, true);
  assert.match(again.error, /was already posted/);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM outbound_attempt WHERE outcome = 'ACKNOWLEDGED'"), 1);
  // And the destination moved exactly once.
  assert.equal(db.prepare("SELECT rev AS r FROM src_p6_activity WHERE activity_id = 'A-1020'").get().r, 2);
});

test('the state machine refuses a move it does not allow', () => {
  const { db, session } = fixture();
  const id = approvedP6(db, session('planner'));
  post(db, id, { session: session('planner') });
  const proposal = db.prepare('SELECT * FROM outbound_proposal WHERE id = ?').get(id);
  assert.deepEqual(TRANSITIONS.POSTED, []);
  for (const to of ['APPROVED', 'PENDING_APPROVAL', 'POSTING']) {
    const moved = transition(db, proposal, to, { actor: 'test' });
    assert.equal(moved.ok, false, `POSTED must not move to ${to}`);
    assert.match(moved.error, /it is final/);
  }
  // Approval after posting is refused too.
  assert.equal(decide(db, id, 'APPROVE', { session: session('planner') }).ok, false);
});

test('every transition is stored', () => {
  const { db, session } = fixture();
  const id = approvedP6(db, session('planner'));
  post(db, id, { session: session('planner') });
  const states = db.prepare('SELECT to_status FROM outbound_transition WHERE proposal_id = ? ORDER BY id')
    .all(id).map(row => row.to_status);
  assert.deepEqual(states, ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTING', 'POSTED']);
});

/* ── the P6 write-back ─────────────────────────────────────────────────────────────────────── */

test('the A-1020 example: 80% in P6 becomes 60% verified, and only permitted fields move', () => {
  const { db, session } = fixture();
  const before = db.prepare("SELECT * FROM src_p6_activity WHERE activity_id = 'A-1020'").get();
  assert.equal(before.pct_complete, 80);

  const id = approvedP6(db, session('planner'));
  const detail = proposalDetail(db, id);
  assert.equal(detail.proposal.payload.proposed.pct_complete, 60);
  assert.equal(detail.proposal.evidence.verifiedElements, 12);
  assert.equal(detail.proposal.evidence.totalElements, 20);
  assert.equal(detail.proposal.evidence.rule, 'EQUAL_WEIGHT_ELEMENTS');

  const posted = post(db, id, { session: session('planner') });
  const after = db.prepare("SELECT * FROM src_p6_activity WHERE activity_id = 'A-1020'").get();
  assert.equal(after.pct_complete, 60);
  assert.equal(posted.response.fieldsWritten.every(f => PERMITTED_FIELDS['INT-02'].includes(f)), true);

  // Everything outside the permitted list is untouched.
  for (const field of ['wbs_code', 'name', 'calendar', 'planned_start', 'planned_finish',
    'baseline_start', 'baseline_finish', 'data_date']) {
    assert.equal(after[field], before[field], `${field} was written and must never be`);
  }
  // And a recorded actual start is not replaced by an inferred one.
  assert.equal(after.actual_start, before.actual_start);
});

/* ── conflicts ─────────────────────────────────────────────────────────────────────────────── */

test('acceptance 5 — a changed source revision holds the proposal and writes nothing', () => {
  const { db, session } = fixture();
  const id = approvedP6(db, session('planner'));
  db.prepare("UPDATE src_p6_activity SET pct_complete = 44, rev = rev + 1 WHERE activity_id = 'A-1020'").run();

  const held = post(db, id, { session: session('planner') });
  assert.equal(held.ok, false);
  assert.equal(held.held, true);
  assert.equal(held.checks.find(c => c.id === 'SOURCE_REVISION').ok, false);
  assert.equal(db.prepare('SELECT status FROM outbound_proposal WHERE id = ?').get(id).status, STATUS.HELD);
  // The newer value survives.
  assert.equal(db.prepare("SELECT pct_complete AS p FROM src_p6_activity WHERE activity_id = 'A-1020'").get().p, 44);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM outbound_attempt WHERE outcome = 'ACKNOWLEDGED'"), 0);
  // And a conflict exception appears where every other exception does.
  const exception = db.prepare(
    "SELECT * FROM exception WHERE rule_id = 'R12_WRITEBACK_CONFLICT'").get();
  assert.ok(exception);
  assert.equal(exception.severity, 'ERROR');
  assert.equal(exception.owner_role, 'planner');
  assert.match(exception.suggested_action, /Nothing was written/);
});

test('acceptance 6 — changed evidence holds a stale proposal', () => {
  const { db, session } = fixture();
  const id = approvedP6(db, session('planner'));
  // A thirteenth column is verified after the approver signed off on twelve.
  const spare = db.prepare(
    `SELECT element_id FROM mapping WHERE activity_id = 'A-1020'
       AND element_id NOT IN (SELECT element_id FROM progress_observation
                               WHERE activity_id = 'A-1020' AND status = 'VERIFIED') LIMIT 1`).get();
  db.prepare(`INSERT INTO progress_observation (activity_id, element_id, observed_on,
      verified_quantity, completion, source, reviewer, evidence_ref, status, created_at)
    VALUES ('A-1020', ?, '2026-05-02', 1, 'COMPLETE', 'test', 'test', 'test', 'VERIFIED', '2026-05-02')`)
    .run(spare.element_id);

  const held = post(db, id, { session: session('planner') });
  assert.equal(held.held, true);
  assert.equal(held.checks.find(c => c.id === 'EVIDENCE').ok, false);
  assert.equal(db.prepare("SELECT pct_complete AS p FROM src_p6_activity WHERE activity_id = 'A-1020'").get().p, 80);
});

test('acceptance 7 — a changed mapping holds the proposal', () => {
  const { db, session } = fixture();
  const id = approvedP6(db, session('planner'));
  db.prepare("UPDATE mapping SET boq_code = NULL WHERE element_id = 'COL-001'").run();
  const held = post(db, id, { session: session('planner') });
  assert.equal(held.held, true);
  assert.equal(held.checks.find(c => c.id === 'MAPPING').ok, false);
});

test('a proposal whose verified figure has moved cannot even be raised from a stale draft', () => {
  const { db } = fixture();
  const draft = prepareP6Draft(db, 'A-1020', { actor: 'test' });
  const spare = db.prepare(
    `SELECT element_id FROM mapping WHERE activity_id = 'A-1020'
       AND element_id NOT IN (SELECT element_id FROM progress_observation
                               WHERE activity_id = 'A-1020' AND status = 'VERIFIED') LIMIT 1`).get();
  db.prepare(`INSERT INTO progress_observation (activity_id, element_id, observed_on,
      verified_quantity, completion, source, reviewer, evidence_ref, status, created_at)
    VALUES ('A-1020', ?, '2026-05-02', 1, 'COMPLETE', 't', 't', 't', 'VERIFIED', '2026-05-02')`)
    .run(spare.element_id);
  const refused = proposeP6Update(db, draft.draft.id, { actor: 'test', actorRole: 'planner' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /the verified evidence now says 65%/);
});

/* ── failure and retry ─────────────────────────────────────────────────────────────────────── */

test('acceptance 9 and 10 — a failed posting stays visible, and a retry is safe', () => {
  const { db, session } = fixture();
  const id = approvedP6(db, session('planner'));
  forceFailure('P6', 'Destination unavailable (simulated).');

  const failed = post(db, id, { session: session('planner') });
  assert.equal(failed.ok, false);
  assert.equal(failed.failed, true);
  assert.equal(db.prepare('SELECT status FROM outbound_proposal WHERE id = ?').get(id).status, STATUS.FAILED);
  assert.equal(db.prepare("SELECT pct_complete AS p FROM src_p6_activity WHERE activity_id = 'A-1020'").get().p, 80,
    'a failed post must leave the destination untouched');
  const attempt = db.prepare('SELECT * FROM outbound_attempt WHERE proposal_id = ?').get(id);
  assert.equal(attempt.outcome, 'FAILED');
  assert.match(attempt.response, /Destination unavailable/);

  // Retry, now that the fault has cleared.
  const retried = post(db, id, { session: session('planner') });
  assert.equal(retried.ok, true);
  assert.equal(db.prepare("SELECT pct_complete AS p FROM src_p6_activity WHERE activity_id = 'A-1020'").get().p, 60);
  const attempts = db.prepare('SELECT outcome FROM outbound_attempt WHERE proposal_id = ? ORDER BY attempt')
    .all(id).map(row => row.outcome);
  assert.deepEqual(attempts, ['FAILED', 'ACKNOWLEDGED'], 'both attempts are kept');
});

test('a destination acknowledgment is stored, with its correlation id', () => {
  const { db, session } = fixture();
  const id = approvedP6(db, session('planner'));
  post(db, id, { session: session('planner') });
  const detail = proposalDetail(db, id);
  const attempt = detail.attempts[0];
  assert.equal(attempt.outcome, 'ACKNOWLEDGED');
  assert.equal(attempt.response.acknowledged, true);
  assert.equal(attempt.correlation_id, detail.proposal.correlation_id);
  assert.ok(attempt.response.before && attempt.response.after);
  assert.match(attempt.response.note, /No live P6 was contacted/);
});

/* ── SAP earned value ──────────────────────────────────────────────────────────────────────── */

test('acceptance 3 and 11 — Finance approves, and no SAP cost record moves', () => {
  const { db, session } = fixture();
  const snapshot = () => JSON.stringify({
    cost: db.prepare('SELECT * FROM src_sap_cost ORDER BY sap_wbs_code').all(),
    boq: db.prepare('SELECT * FROM src_sap_boq ORDER BY code').all(),
    wbs: db.prepare('SELECT * FROM src_sap_wbs ORDER BY code').all(),
  });
  const before = snapshot();

  const raised = proposeSapEarnedValue(db, FULLY_PRICED_WBS, { actor: 't', actorRole: 'financeController' });
  assert.equal(raised.ok, true);
  submit(db, raised.proposal.id, { actor: 't', actorRole: 'financeController' });
  // The planner may not approve money.
  assert.equal(decide(db, raised.proposal.id, 'APPROVE', { session: session('planner') }).ok, false);
  assert.equal(decide(db, raised.proposal.id, 'APPROVE', { session: session('financeController') }).ok, true);

  const posted = post(db, raised.proposal.id, { session: session('financeController') });
  assert.equal(posted.ok, true);
  assert.deepEqual(posted.response.fieldsWritten, ['earned_value']);
  assert.equal(snapshot(), before, 'a SAP cost, BOQ or WBS record was written');

  const stored = db.prepare('SELECT * FROM src_sap_earned_value WHERE sap_wbs_code = ?').get(FULLY_PRICED_WBS);
  assert.ok(stored.earned_value > 0);
  assert.equal(stored.coverage, 'COMPLETE');
});

test('acceptance 12 — partial coverage is disclosed and never presented as the whole WBS', () => {
  const { db } = fixture();
  const raised = proposeSapEarnedValue(db, '1.2.3', { actor: 't', actorRole: 'financeController' });
  const coverage = raised.proposal.coverage;
  assert.equal(coverage.scope, 'PARTIAL');
  assert.ok(coverage.unpriced > 0);
  assert.equal(coverage.priced + coverage.unpriced, coverage.elementsInWbs);
  assert.equal(coverage.excludedElements.length, coverage.unpriced);
  assert.match(coverage.note, /must not be read as the whole WBS/);
  // The flag travels in the payload, so the destination records the scope it was given.
  assert.equal(raised.proposal.payload.proposed.coverage, 'PARTIAL');
});

test('a WBS with no priced element is refused rather than valued at zero', () => {
  const { db } = fixture();
  db.prepare("UPDATE mapping SET boq_code = NULL WHERE sap_wbs_code = '1.4.1'").run();
  const refused = proposeSapEarnedValue(db, '1.4.1', { actor: 't', actorRole: 'financeController' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Not available — mapping incomplete/);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM outbound_proposal WHERE subject_id = '1.4.1'"), 0);
});

test('earned value is reported beside SAP actual cost, never merged with it', () => {
  const { db } = fixture();
  const raised = proposeSapEarnedValue(db, FULLY_PRICED_WBS, { actor: 't', actorRole: 'financeController' });
  const evidence = raised.proposal.evidence;
  assert.ok(evidence.sapActualCost != null);
  assert.notEqual(raised.proposal.payload.proposed.earned_value, evidence.sapActualCost);
  assert.match(evidence.note, /not actual cost/);
});

/* ── idempotency, audit, reconciliation ────────────────────────────────────────────────────── */

test('an identical proposal is not duplicated', () => {
  const { db } = fixture();
  const draft = prepareP6Draft(db, 'A-1020', { actor: 't' });
  const first = proposeP6Update(db, draft.draft.id, { actor: 't', actorRole: 'planner' });
  const second = proposeP6Update(db, draft.draft.id, { actor: 't', actorRole: 'planner' });
  assert.equal(second.reused, true);
  assert.equal(second.proposal.id, first.proposal.id);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM outbound_proposal'), 1);
});

test('acceptance 13 — the audit trail carries everything the brief lists', () => {
  const { db, session } = fixture();
  const id = approvedP6(db, session('planner'));
  const posted = post(db, id, { session: session('planner') });
  const detail = proposalDetail(db, id);

  assert.ok(detail.proposal.id);
  assert.equal(detail.proposal.interface_id, 'INT-02');
  assert.equal(detail.proposal.approver_role, 'planner');
  assert.ok(detail.proposal.source_rev);
  assert.ok(detail.proposal.correlation_id);
  assert.equal(detail.proposal.payload.current.pct_complete, 80);
  assert.equal(detail.proposal.payload.proposed.pct_complete, 60);
  assert.equal(detail.attempts.length, 1);
  assert.equal(detail.proposal.status, 'POSTED');
  assert.ok(detail.proposal.posted_at);
  assert.equal(posted.response.correlationId, detail.proposal.correlation_id);
  for (const entry of detail.transitions) assert.ok(entry.at && entry.actor);
});

test('reconciliation keeps the five write-back states apart', () => {
  const { db, session } = fixture();
  // One posted, one approved-not-posted, one held.
  post(db, approvedP6(db, session('planner')), { session: session('planner') });

  const sap = proposeSapEarnedValue(db, FULLY_PRICED_WBS, { actor: 't', actorRole: 'financeController' });
  submit(db, sap.proposal.id, { actor: 't', actorRole: 'financeController' });
  decide(db, sap.proposal.id, 'APPROVE', { session: session('financeController') });

  const report = writeBackReconciliation(db);
  const p6 = report.byInterface.find(entry => entry.interfaceId === 'INT-02');
  const sapRow = report.byInterface.find(entry => entry.interfaceId === 'INT-05');
  assert.equal(p6.posted, 1);
  assert.equal(sapRow.approvedNotPosted, 1);
  assert.equal(sapRow.posted, 0);
  assert.ok(report.attempts.some(entry => entry.outcome === 'ACKNOWLEDGED'));
  assert.match(report.note, /Nothing is reported posted that the destination did not acknowledge/);
});

test('the six pre-post checks all report, pass or fail', () => {
  const { db, session } = fixture();
  const id = approvedP6(db, session('planner'));
  const flight = preflight(db, db.prepare('SELECT * FROM outbound_proposal WHERE id = ?').get(id));
  assert.deepEqual(flight.checks.map(entry => entry.id),
    ['APPROVED', 'SOURCE_REVISION', 'EVIDENCE', 'MAPPING', 'PERMITTED_FIELDS', 'NOT_POSTED']);
  for (const check of flight.checks) {
    assert.ok(check.detail.length > 5, `${check.id} explains nothing`);
  }
  assert.equal(flight.ok, true);
});

test('acceptance 14 — reset clears the outbound state', async () => {
  const { db, session } = fixture();
  post(db, approvedP6(db, session('planner')), { session: session('planner') });
  const { clearConstructionDb } = await import('../server/construction/db.mjs');
  clearConstructionDb(db);
  for (const table of ['outbound_proposal', 'outbound_transition', 'outbound_attempt',
    'demo_session', 'src_sap_earned_value']) {
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM ${table}`), 0, `${table} survived the reset`);
  }
  seedSourceSystems(db, buildSeed());
  assert.equal(db.prepare("SELECT pct_complete AS p FROM src_p6_activity WHERE activity_id = 'A-1020'").get().p, 80,
    'the synthetic baseline is restored');
});
