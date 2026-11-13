/**
 * Phase 6: history, the unified audit trail and the guided walkthrough.
 *
 * What is held:
 *
 *  1. THE TRAIL IS A MERGE, NOT A COPY. Every row traces back to the store it came from, and no
 *     second audit table exists to drift from the first.
 *  2. WHAT IS NOT RECORDED IS NULL. A historical row with no actor or correlation id keeps the
 *     gap; nothing is back-filled with a plausible value.
 *  3. INBOUND AND OUTBOUND ARE NOT CONFLATED. A posting attempt has no record counts, because it
 *     posts one record to one destination.
 *  4. READING CHANGES NOTHING. Refreshing a view twice adds no events.
 *  5. THE WALKTHROUGH CHECKS, IT DOES NOT PRETEND. A step is done because the records say so.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { openConstructionDb } from '../server/construction/db.mjs';
import { buildSeed, seedSourceSystems } from '../server/construction/seed.mjs';
import { createMockAdapters } from '../server/construction/adapters.mjs';
import { runInboundSync } from '../server/construction/sync.mjs';
import { buildMappings } from '../server/construction/mapping.mjs';
import { storeValidation, validate } from '../server/construction/validation.mjs';
import { syncExceptions, transitionException } from '../server/construction/exceptions.mjs';
import { reconcile, storeReconciliation } from '../server/construction/reconciliation.mjs';
import { seedProgress } from '../server/construction/progressSeed.mjs';
import { prepareP6Draft } from '../server/construction/model.mjs';
import { issueSession, sessionFor } from '../server/construction/auth.mjs';
import { decide, proposeP6Update, submit } from '../server/construction/outbound.mjs';
import { clearFailures, forceFailure, post } from '../server/construction/destinations.mjs';
import {
  auditTrail, reconciliationHistory, reconciliationRunDetail, syncHistory, syncRunDetail,
  writeBackDetail, writeBackHistory,
} from '../server/construction/history.mjs';
import { scenarios, SUBJECT, walkthrough } from '../server/construction/walkthrough.mjs';

function fixture() {
  const db = openConstructionDb({ path: ':memory:' });
  seedSourceSystems(db);
  runInboundSync(db, createMockAdapters(db));
  buildMappings(db);
  const findings = validate(db);
  storeValidation(db, findings);
  syncExceptions(db, findings);
  storeReconciliation(db, reconcile(db));
  seedProgress(db);
  clearFailures();
  const session = role => sessionFor(db, issueSession(db, { role, actor: `${role} (test)` }).token);
  return { db, session };
}

/** Raise, approve and post the A-1020 update. */
function postedP6(db, session) {
  const draft = prepareP6Draft(db, SUBJECT.activityId, { actor: 'test' });
  const raised = proposeP6Update(db, draft.draft.id, { actor: 'test', actorRole: 'planner' });
  submit(db, raised.proposal.id, { actor: 'test', actorRole: 'planner' });
  decide(db, raised.proposal.id, 'APPROVE', { session });
  post(db, raised.proposal.id, { session });
  return raised.proposal.id;
}

const count = (db, sql, ...params) => db.prepare(sql).get(...params).n;

/* ── A. synchronisation history ────────────────────────────────────────────────────────────── */

test('acceptance 2 — every stored run appears, with its real counts', () => {
  const { db } = fixture();
  const history = syncHistory(db);
  const runs = db.prepare('SELECT * FROM sync_run ORDER BY id').all();
  assert.equal(history.rows.filter(row => row.kind === 'SYNC_RUN').length, runs.length);
  for (const run of runs) {
    const row = history.rows.find(entry => entry.kind === 'SYNC_RUN' && entry.rawId === run.id);
    assert.ok(row, `run ${run.id} is missing from the history`);
    assert.equal(row.recordsRead, run.records_read);
    assert.equal(row.created, run.records_created);
    assert.equal(row.status, run.status);
    assert.ok(row.source && row.destination, 'a run names where it moved data between');
  }
});

test('an outbound posting is listed, and never given invented record counts', () => {
  const { db, session } = fixture();
  postedP6(db, session('planner'));
  const history = syncHistory(db);
  const posting = history.rows.find(row => row.kind === 'POSTING_ATTEMPT');
  assert.ok(posting);
  assert.equal(posting.interfaceId, 'INT-02');
  assert.equal(posting.status, 'SUCCESS');
  // A posting sends one record to one destination; a read count would be fabricated.
  for (const field of ['recordsRead', 'created', 'updated', 'unchanged', 'failed']) {
    assert.equal(posting[field], null, `${field} must be null on a posting attempt`);
  }
  assert.ok(posting.correlationId, 'a posting carries its correlation id');
  // An inbound run has none, and that is said rather than filled in.
  assert.equal(history.rows.find(row => row.kind === 'SYNC_RUN').correlationId, null);
});

test('the sync history filters by interface, status and date', () => {
  const { db } = fixture();
  assert.equal(syncHistory(db, { interfaceId: 'INT-01' }).rows.every(r => r.interfaceId === 'INT-01'), true);
  assert.equal(syncHistory(db, { status: 'SUCCESS' }).rows.every(r => r.status === 'SUCCESS'), true);
  assert.equal(syncHistory(db, { status: 'FAILED' }).rows.length, 0);
  assert.equal(syncHistory(db, { from: '2099-01-01' }).rows.length, 0);
  // An unset filter must not break the query — node:sqlite refuses an unused named parameter.
  assert.ok(syncHistory(db, {}).rows.length > 0);
});

test('a run detail carries its errors; a posting detail carries the acknowledgment', () => {
  const { db, session } = fixture();
  const proposalId = postedP6(db, session('planner'));
  const run = db.prepare('SELECT id FROM sync_run ORDER BY id LIMIT 1').get();
  const runDetail = syncRunDetail(db, 'SYNC_RUN', run.id);
  assert.equal(runDetail.run.id, run.id);
  assert.ok(Array.isArray(runDetail.errors));
  const posting = syncRunDetail(db, 'POSTING_ATTEMPT', proposalId);
  assert.equal(posting.attempts[0].outcome, 'ACKNOWLEDGED');
  assert.equal(posting.attempts[0].response.acknowledged, true);
});

/* ── B. the unified audit trail ────────────────────────────────────────────────────────────── */

test('acceptance 3 — the trail merges the five stores and names each row’s source', () => {
  const { db, session } = fixture();
  postedP6(db, session('planner'));
  transitionException(db,
    db.prepare("SELECT id FROM exception WHERE status = 'OPEN' LIMIT 1").get().id,
    'UNDER_REVIEW', { actor: 'test' });

  const trail = auditTrail(db, { limit: 1000 });
  const sources = new Set(trail.rows.map(row => row.source));
  for (const store of ['audit_event', 'exception_event', 'outbound_transition', 'outbound_attempt']) {
    assert.ok(sources.has(store), `${store} is not represented in the trail`);
  }
  // Nothing was copied into a second table: the trail's size is bounded by the stores themselves.
  const stored = count(db, 'SELECT COUNT(*) AS n FROM audit_event')
    + count(db, 'SELECT COUNT(*) AS n FROM exception_event')
    + count(db, 'SELECT COUNT(*) AS n FROM outbound_transition')
    + count(db, 'SELECT COUNT(*) AS n FROM outbound_attempt')
    + count(db, 'SELECT COUNT(*) AS n FROM mapping_proposal');
  assert.equal(trail.total, stored);
});

test('every event carries the fields the brief lists, or an honest null', () => {
  const { db, session } = fixture();
  postedP6(db, session('planner'));
  for (const row of auditTrail(db, { limit: 1000 }).rows) {
    assert.ok(row.at, 'an event must have a time');
    assert.ok(row.event, 'an event must have a type');
    for (const field of ['actor', 'interfaceId', 'subjectId', 'previous', 'next', 'result',
      'correlationId']) {
      assert.ok(field in row, `${row.event} is missing the ${field} field`);
    }
  }
  // Inbound sync runs predate correlation ids, and the gap is kept rather than back-filled.
  const sync = auditTrail(db, { event: 'SYNC_RUN' }).rows[0];
  assert.equal(sync.correlationId, null);
});

test('acceptance 7 — the trail filters and searches', () => {
  const { db, session } = fixture();
  postedP6(db, session('planner'));
  assert.ok(auditTrail(db, { subject: SUBJECT.activityId }).rows.length > 0);
  assert.equal(auditTrail(db, { subject: SUBJECT.activityId }).rows
    .every(row => row.subjectId === SUBJECT.activityId), true);
  assert.equal(auditTrail(db, { event: 'SYNC_RUN' }).rows.every(row => row.event === 'SYNC_RUN'), true);
  assert.equal(auditTrail(db, { interfaceId: 'INT-02' }).rows
    .every(row => row.interfaceId === 'INT-02'), true);
  // Case-insensitive, over actor, record, result and correlation id.
  const actor = db.prepare("SELECT actor FROM audit_event WHERE actor IS NOT NULL LIMIT 1").get().actor;
  assert.ok(auditTrail(db, { query: actor.toUpperCase() }).rows.length > 0, 'search ignores case');
  assert.ok(auditTrail(db, { query: SUBJECT.activityId.toLowerCase() }).rows.length > 0,
    'search reaches the record id');
  assert.equal(auditTrail(db, { query: 'no-such-thing-anywhere' }).rows.length, 0);
});

test('acceptance 12 — reading the trail does not create events', () => {
  const { db, session } = fixture();
  postedP6(db, session('planner'));
  const before = auditTrail(db, { limit: 1000 }).total;
  for (let read = 0; read < 5; read += 1) {
    auditTrail(db, { limit: 1000 });
    syncHistory(db);
    writeBackHistory(db);
    reconciliationHistory(db);
    walkthrough(db);
  }
  assert.equal(auditTrail(db, { limit: 1000 }).total, before);
});

test('the gaps closed in this phase are actually recorded', () => {
  const { db } = fixture();
  const events = db.prepare('SELECT DISTINCT event FROM audit_event').all().map(row => row.event);
  // Reconciliation and validation left no trace before Phase 6.
  assert.ok(events.includes('RECONCILIATION'), 'a reconciliation must leave a trace');
  assert.ok(events.includes('VALIDATION_RUN'), 'a validation run must leave a trace');
  // And the new columns are populated, not silently dropped.
  const sync = db.prepare("SELECT * FROM audit_event WHERE event = 'SYNC_RUN' LIMIT 1").get();
  assert.ok(sync.subject_id, 'the subject column is written');
  assert.ok(sync.result, 'the result column is written');
});

test('a session token fragment is never recorded as an actor', () => {
  const { db } = fixture();
  const issued = issueSession(db, { role: 'planner', actor: 'R. Nair' });
  const tokens = db.prepare('SELECT token FROM demo_session').all().map(row => row.token);
  for (const row of db.prepare('SELECT actor FROM audit_event').all()) {
    for (const token of tokens) {
      assert.equal(token.startsWith(row.actor), false, 'an audit actor looks like a token fragment');
    }
  }
  assert.ok(issued.ok);
});

/* ── C. write-back history ─────────────────────────────────────────────────────────────────── */

test('acceptance 4 — write-back history shows the attempt and the acknowledgment', () => {
  const { db, session } = fixture();
  const id = postedP6(db, session('planner'));
  const [row] = writeBackHistory(db, { subject: SUBJECT.activityId });
  assert.equal(row.proposalId, id);
  assert.equal(row.status, 'POSTED');
  assert.equal(row.previousValue.pct_complete, 80);
  assert.equal(row.proposedValue.pct_complete, 60);
  assert.equal(row.approverRole, 'planner');
  assert.equal(row.attemptCount, 1);
  assert.equal(row.acknowledgement.acknowledged, true);
  assert.equal(row.simulated, true, 'a simulated posting always says so');

  const detail = writeBackDetail(db, id);
  assert.deepEqual(detail.transitions.map(entry => entry.to_status),
    ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTING', 'POSTED']);
  assert.match(detail.note, /no live system has been contacted/);
});

test('acceptance 5 — a held proposal shows its conflict and links to the exception', () => {
  const { db, session } = fixture();
  const draft = prepareP6Draft(db, SUBJECT.activityId, { actor: 'test' });
  const raised = proposeP6Update(db, draft.draft.id, { actor: 'test', actorRole: 'planner' });
  submit(db, raised.proposal.id, { actor: 'test', actorRole: 'planner' });
  decide(db, raised.proposal.id, 'APPROVE', { session: session('planner') });
  db.prepare("UPDATE src_p6_activity SET pct_complete = 44, rev = rev + 1 WHERE activity_id = ?")
    .run(SUBJECT.activityId);
  post(db, raised.proposal.id, { session: session('planner') });

  const [row] = writeBackHistory(db, { status: 'HELD' });
  assert.ok(row.holdReason, 'a held proposal says why');
  assert.ok(row.conflictException, 'and links to the exception it raised');
  assert.equal(row.conflictException.rule_id, 'R12_WRITEBACK_CONFLICT');
});

test('acceptance 5 — a failed proposal shows every attempt', () => {
  const { db, session } = fixture();
  const draft = prepareP6Draft(db, SUBJECT.activityId, { actor: 'test' });
  const raised = proposeP6Update(db, draft.draft.id, { actor: 'test', actorRole: 'planner' });
  submit(db, raised.proposal.id, { actor: 'test', actorRole: 'planner' });
  decide(db, raised.proposal.id, 'APPROVE', { session: session('planner') });
  forceFailure('P6', 'Destination unavailable (simulated).');
  post(db, raised.proposal.id, { session: session('planner') });
  post(db, raised.proposal.id, { session: session('planner') });

  const detail = writeBackDetail(db, raised.proposal.id);
  assert.deepEqual(detail.attempts.map(entry => entry.outcome), ['FAILED', 'ACKNOWLEDGED']);
  assert.match(detail.attempts[0].response.error, /Destination unavailable/);
  assert.equal(detail.status, 'POSTED');
});

/* ── D. reconciliation history ─────────────────────────────────────────────────────────────── */

test('acceptance 6 — reconciliation history keeps every run, not only the latest', () => {
  const { db } = fixture();
  storeReconciliation(db, reconcile(db));
  storeReconciliation(db, reconcile(db));
  const runs = reconciliationHistory(db);
  assert.equal(runs.length, 3);
  assert.ok(runs[0].runId > runs[1].runId, 'newest first');
  for (const run of runs) assert.ok(run.checks > 0 && run.at);
});

test('a reconciliation run’s checks keep policy exclusions apart from failures', () => {
  const { db } = fixture();
  const latest = reconciliationHistory(db)[0];
  const detail = reconciliationRunDetail(db, latest.runId);
  const versions = detail.checks.find(row => row.check_id === 'MODEL_VERSION_STATE');
  assert.equal(versions.excluded, 1);
  assert.equal(versions.unmatched, 0);
  assert.equal(versions.status, 'PASS');
  for (const row of detail.checks) {
    assert.equal(row.checked, row.matched + row.unmatched + row.excluded, `${row.check_id}`);
  }
  assert.match(detail.note, /excluded by policy .* is not a failed one/);
});

/* ── the guided walkthrough ────────────────────────────────────────────────────────────────── */

test('acceptance 9 — the walkthrough reflects real state, step by step', () => {
  const { db, session } = fixture();
  const before = walkthrough(db);
  const post_ = before.steps.find(step => step.id === 'post');
  assert.equal(post_.state, 'blocked');
  assert.match(post_.blockedNote, /Approve — prepare/);

  postedP6(db, session('planner'));
  const after = walkthrough(db);
  assert.equal(after.steps.find(step => step.id === 'post').state, 'done');
  assert.match(after.steps.find(step => step.id === 'post').detail, /mock P6 now holds 60%/);
  assert.ok(after.completed > before.completed);
});

test('a step cannot be done while its prerequisite is not', () => {
  const { db } = fixture();
  for (const step of walkthrough(db).steps) {
    if (step.state === 'done') {
      assert.equal(step.blockedBy, null, `${step.id} is done while blocked by ${step.blockedBy}`);
    }
  }
});

test('the walkthrough explains what is missing rather than failing silently', () => {
  const { db } = fixture();
  for (const step of walkthrough(db).steps) {
    assert.ok(step.detail && step.detail.length > 10, `${step.id} says nothing about its state`);
    assert.ok(['done', 'ready', 'blocked'].includes(step.state));
    if (step.state === 'blocked') assert.ok(step.blockedNote);
  }
});

test('the scenarios point at real evidence and are not re-implemented', () => {
  const { db, session } = fixture();
  postedP6(db, session('planner'));
  const list = scenarios(db);
  assert.equal(list.length, 10);
  for (const entry of list) {
    assert.ok(entry.workspace && entry.how.length > 20, `${entry.id} does not say how to run it`);
    assert.equal(typeof entry.inEvidence, 'boolean');
  }
  assert.equal(list.find(entry => entry.id === 'p6-write-back').inEvidence, true);
  assert.equal(list.find(entry => entry.id === 'source-conflict').inEvidence, false);
});

/* ── reset ─────────────────────────────────────────────────────────────────────────────────── */

test('acceptance 13 — reset clears the history and restores the baseline', async () => {
  const { db, session } = fixture();
  postedP6(db, session('planner'));
  const { clearConstructionDb } = await import('../server/construction/db.mjs');
  clearConstructionDb(db);
  assert.equal(auditTrail(db, { limit: 1000 }).total, 0);
  assert.equal(syncHistory(db).rows.length, 0);
  assert.equal(writeBackHistory(db).length, 0);
  assert.equal(reconciliationHistory(db).length, 0);

  seedSourceSystems(db, buildSeed());
  assert.equal(db.prepare('SELECT pct_complete AS p FROM src_p6_activity WHERE activity_id = ?')
    .get(SUBJECT.activityId).p, 80, 'the deterministic baseline is back');
  assert.equal(walkthrough(db).completed, 0);
});
