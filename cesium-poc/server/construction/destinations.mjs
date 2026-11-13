/**
 * The mock destinations, and the posting that drives them.
 *
 * SEPARATE FROM INBOUND SYNC on purpose. The adapters in `adapters.mjs` read; these write. A
 * module that did both would be one refactor away from a sync run writing to a source.
 *
 * A destination writes ONLY its interface's permitted fields:
 *
 *   mock P6   pct_complete, remaining_duration, actual_start, actual_finish on src_p6_activity.
 *             Never a baseline, activity logic, a calendar or the WBS.
 *   mock SAP  earned_value, in src_sap_earned_value — its own table, so a slip cannot reach a
 *             budget, a cost posting, a unit rate or any master data.
 *
 * Every post is an ATTEMPT row written before the destination is called and closed with whatever
 * it answered. Nothing is reported posted that was not acknowledged.
 */
import { randomUUID } from 'node:crypto';
import { PERMITTED_FIELDS, STATUS, preflight, read, transition } from './outbound.mjs';

const nowIso = () => new Date().toISOString();

/**
 * Make the next post fail, for the demonstration's failure scenario.
 *
 * Deliberately explicit rather than random: a demo that fails unpredictably cannot be rehearsed,
 * and a failure nobody asked for looks like a bug.
 */
const forced = new Map();
export const forceFailure = (destination, reason) => forced.set(destination, reason);
export const clearFailures = () => forced.clear();

/** mock P6. Writes the four permitted columns and bumps the revision, as a real P6 would. */
export function mockP6(db, { activityId, fields, correlationId, now = nowIso }) {
  const failure = forced.get('P6');
  if (failure) { forced.delete('P6'); throw new Error(`mock P6 rejected the update: ${failure}`); }
  const before = db.prepare(
    'SELECT pct_complete, remaining_duration, actual_start, actual_finish, rev FROM src_p6_activity WHERE activity_id = ?')
    .get(activityId);
  if (!before) throw new Error(`mock P6 has no activity ${activityId}.`);
  const allowed = PERMITTED_FIELDS['INT-02'];
  const columns = Object.keys(fields).filter(key => allowed.includes(key));
  if (!columns.length) throw new Error('mock P6 was sent no permitted field.');
  db.prepare(`UPDATE src_p6_activity SET ${columns.map(column => `${column} = ?`).join(', ')},
      rev = rev + 1 WHERE activity_id = ?`)
    .run(...columns.map(column => fields[column]), activityId);
  const after = db.prepare(
    'SELECT pct_complete, remaining_duration, actual_start, actual_finish, rev FROM src_p6_activity WHERE activity_id = ?')
    .get(activityId);
  return {
    destination: 'P6', acknowledged: true, correlationId, at: now(),
    activityId, fieldsWritten: columns, before, after,
    note: 'Simulated Primavera P6 acknowledgment. No live P6 was contacted.',
  };
}

/** mock SAP. Writes earned value and nothing else — not a budget, not a cost posting. */
export function mockSap(db, { wbsCode, fields, coverage, correlationId, proposalId, now = nowIso }) {
  const failure = forced.get('SAP');
  if (failure) { forced.delete('SAP'); throw new Error(`mock SAP rejected the posting: ${failure}`); }
  const before = db.prepare('SELECT * FROM src_sap_earned_value WHERE sap_wbs_code = ?').get(wbsCode) ?? null;
  const at = now();
  db.prepare(`INSERT INTO src_sap_earned_value (sap_wbs_code, earned_value, currency, coverage,
      posted_at, correlation_id, proposal_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sap_wbs_code) DO UPDATE SET earned_value = excluded.earned_value,
       currency = excluded.currency, coverage = excluded.coverage, posted_at = excluded.posted_at,
       correlation_id = excluded.correlation_id, proposal_id = excluded.proposal_id`)
    .run(wbsCode, fields.earned_value, fields.currency ?? 'INR',
      coverage?.scope ?? 'COMPLETE', at, correlationId, proposalId);
  return {
    destination: 'SAP', acknowledged: true, correlationId, at,
    wbsCode, fieldsWritten: ['earned_value'], before,
    after: db.prepare('SELECT * FROM src_sap_earned_value WHERE sap_wbs_code = ?').get(wbsCode),
    note: 'Simulated SAP acknowledgment. Earned value only — no budget, cost posting, unit rate '
      + 'or master data was touched, and no live SAP was contacted.',
  };
}

/**
 * Post one approved proposal.
 *
 * The six pre-post checks run first. A conflict HOLDS the proposal and raises an exception rather
 * than overwriting whatever moved; a destination error FAILS it and leaves it visible and
 * retryable. Only an acknowledgment marks it POSTED.
 */
export function post(db, proposalId, { session, now = nowIso } = {}) {
  const proposal = read(db, proposalId);
  if (!proposal) return { ok: false, error: `There is no proposal ${proposalId}.` };

  // Already posted is a refusal, not a conflict. Reporting it as "held" alongside a source
  // revision that this very posting bumped was three failures describing one fact.
  if (proposal.status === STATUS.POSTED) {
    return { ok: false, alreadyPosted: true, proposal,
      checks: preflight(db, proposal).checks,
      error: `${proposal.interface_id} proposal ${proposal.id} was already posted at `
        + `${proposal.posted_at}. It will not be posted again. Raise a new proposal to change `
        + `${proposal.subject_id} further.` };
  }

  const flight = preflight(db, proposal);
  if (!flight.ok) {
    const blocking = flight.failed.map(entry => `${entry.label}: ${entry.detail}`).join(' ');
    // Already posted, or never approved — not a conflict, just refused.
    const conflict = flight.failed.some(entry =>
      ['SOURCE_REVISION', 'EVIDENCE', 'MAPPING'].includes(entry.id));
    if (conflict && proposal.status !== STATUS.HELD) {
      transition(db, proposal, STATUS.HELD, { actor: session?.actor ?? 'system',
        actorRole: session?.role ?? null, reason: blocking, detail: flight.failed });
      db.prepare('UPDATE outbound_proposal SET hold_reason = ? WHERE id = ?').run(blocking, proposal.id);
      raiseConflictException(db, proposal, flight.failed, now());
    }
    return { ok: false, held: conflict, checks: flight.checks,
      error: conflict
        ? `Held, and nothing was written. ${blocking} Raise the proposal again against the current values.`
        : `Refused. ${blocking}`,
      proposal: read(db, proposal.id) };
  }

  const moving = transition(db, proposal, STATUS.POSTING, { actor: session?.actor ?? 'system',
    actorRole: session?.role ?? null, reason: 'Pre-post checks passed.' });
  if (!moving.ok) return moving;

  const correlationId = proposal.correlation_id ?? randomUUID();
  const attempt = db.prepare('SELECT COUNT(*) AS n FROM outbound_attempt WHERE proposal_id = ?')
    .get(proposal.id).n + 1;
  const request = proposal.interface_id === 'INT-02'
    ? { activityId: proposal.subject_id, fields: proposal.payload.proposed }
    : { wbsCode: proposal.subject_id, fields: proposal.payload.proposed, coverage: proposal.coverage };
  const attemptId = db.prepare(
    `INSERT INTO outbound_attempt (proposal_id, attempt, at, actor, destination, correlation_id,
        request, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, 'SENT')`)
    .run(proposal.id, attempt, now(), session?.actor ?? 'system',
      proposal.interface_id === 'INT-02' ? 'P6' : 'SAP', correlationId,
      JSON.stringify(request)).lastInsertRowid;

  // The destination call and the status change land together or not at all.
  db.exec('BEGIN');
  try {
    const response = proposal.interface_id === 'INT-02'
      ? mockP6(db, { ...request, correlationId, now })
      : mockSap(db, { ...request, correlationId, proposalId: proposal.id, now });
    const at = now();
    db.prepare(`UPDATE outbound_attempt SET response = ?, outcome = 'ACKNOWLEDGED', finished_at = ?
       WHERE id = ?`).run(JSON.stringify(response), at, attemptId);
    db.prepare("UPDATE outbound_proposal SET status = 'POSTED', posted_at = ? WHERE id = ?")
      .run(at, proposal.id);
    db.prepare(`INSERT INTO outbound_transition (proposal_id, at, actor, actor_role, from_status,
        to_status, reason, detail) VALUES (?, ?, ?, ?, 'POSTING', 'POSTED', ?, ?)`)
      .run(proposal.id, at, session?.actor ?? 'system', session?.role ?? null,
        'The destination acknowledged the write.', JSON.stringify(response));
    db.exec('COMMIT');
    return { ok: true, status: STATUS.POSTED, response, checks: flight.checks,
      proposal: read(db, proposal.id) };
  } catch (error) {
    db.exec('ROLLBACK');
    const at = now();
    const message = String(error?.message ?? error);
    db.prepare(`UPDATE outbound_attempt SET response = ?, outcome = 'FAILED', finished_at = ?
       WHERE id = ?`).run(JSON.stringify({ acknowledged: false, error: message }), at, attemptId);
    db.prepare("UPDATE outbound_proposal SET status = 'FAILED', failure_reason = ? WHERE id = ?")
      .run(message, proposal.id);
    db.prepare(`INSERT INTO outbound_transition (proposal_id, at, actor, actor_role, from_status,
        to_status, reason) VALUES (?, ?, ?, ?, 'POSTING', 'FAILED', ?)`)
      .run(proposal.id, at, session?.actor ?? 'system', session?.role ?? null, message);
    return { ok: false, failed: true, error: message, checks: flight.checks,
      proposal: read(db, proposal.id) };
  }
}

/** A conflict is an exception, in Phase 3's own table, so it appears where every other one does. */
function raiseConflictException(db, proposal, failed, at) {
  const key = `R12_WRITEBACK_CONFLICT:${proposal.interface_id}:${proposal.subject_id}:${proposal.id}`;
  const existing = db.prepare('SELECT * FROM exception WHERE exception_key = ?').get(key);
  const description = `${proposal.interface_id} write-back for ${proposal.subject_id} was held: `
    + failed.map(entry => entry.detail).join(' ');
  if (existing) {
    db.prepare('UPDATE exception SET last_detected = ?, description = ? WHERE id = ?')
      .run(at, description, existing.id);
    return existing.id;
  }
  const id = db.prepare(
    `INSERT INTO exception (exception_key, rule_id, interface_id, subject_type, subject_id,
        severity, owner_role, description, suggested_action, status, first_detected, last_detected)
     VALUES (?, 'R12_WRITEBACK_CONFLICT', ?, ?, ?, 'ERROR', ?, ?, ?, 'OPEN', ?, ?)`)
    .run(key, proposal.interface_id, proposal.subject_type, proposal.subject_id,
      proposal.interface_id === 'INT-02' ? 'planner' : 'financeController', description,
      'Review the current source values and raise the proposal again. Nothing was written.',
      at, at).lastInsertRowid;
  db.prepare(`INSERT INTO exception_event (exception_id, at, actor, event, to_status, detail)
     VALUES (?, ?, 'Write-back service', 'DETECTED', 'OPEN', ?)`)
    .run(id, at, JSON.stringify(failed));
  return id;
}

/* ── queues and reconciliation ─────────────────────────────────────────────────────────────── */

export function listProposals(db, { interfaceId = null, status = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (interfaceId) { where.push('interface_id = ?'); params.push(interfaceId); }
  if (status) { where.push('status = ?'); params.push(status); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM outbound_proposal ${clause} ORDER BY id DESC LIMIT ?`)
    .all(...params, Math.min(200, Math.max(1, Number(limit) || 100)))
    .map(row => ({ ...row, payload: JSON.parse(row.payload),
      coverage: row.coverage ? JSON.parse(row.coverage) : null }));
}

export function proposalDetail(db, id) {
  const proposal = read(db, id);
  if (!proposal) return null;
  return {
    proposal,
    preflight: preflight(db, proposal),
    transitions: db.prepare('SELECT * FROM outbound_transition WHERE proposal_id = ? ORDER BY id')
      .all(proposal.id).map(row => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : null })),
    attempts: db.prepare('SELECT * FROM outbound_attempt WHERE proposal_id = ? ORDER BY attempt')
      .all(proposal.id).map(row => ({ ...row,
        request: row.request ? JSON.parse(row.request) : null,
        response: row.response ? JSON.parse(row.response) : null })),
    permittedFields: PERMITTED_FIELDS[proposal.interface_id],
    forbiddenNote: proposal.interface_id === 'INT-02'
      ? 'Baselines, activity logic, calendars and the WBS structure are never written.'
      : 'Budgets, actual cost postings, unit rates and BOQ or WBS master data are never written.',
  };
}

/** Write-back reconciliation: the five states kept apart, each counted from the table. */
export function writeBackReconciliation(db) {
  const count = (sql, ...params) => db.prepare(`SELECT COUNT(*) AS n FROM outbound_proposal ${sql}`)
    .get(...params).n;
  const byInterface = ['INT-02', 'INT-05'].map(interfaceId => ({
    interfaceId,
    approvedNotPosted: count("WHERE interface_id = ? AND status = 'APPROVED'", interfaceId),
    posted: count("WHERE interface_id = ? AND status = 'POSTED'", interfaceId),
    failed: count("WHERE interface_id = ? AND status = 'FAILED'", interfaceId),
    held: count("WHERE interface_id = ? AND status = 'HELD'", interfaceId),
    pending: count("WHERE interface_id = ? AND status = 'PENDING_APPROVAL'", interfaceId),
    rejected: count("WHERE interface_id = ? AND status = 'REJECTED'", interfaceId),
    draft: count("WHERE interface_id = ? AND status = 'DRAFT'", interfaceId),
  }));
  return {
    byInterface,
    sourceConflicts: db.prepare(
      "SELECT COUNT(*) AS n FROM exception WHERE rule_id = 'R12_WRITEBACK_CONFLICT' AND status <> 'RESOLVED'")
      .get().n,
    attempts: db.prepare(
      `SELECT outcome, COUNT(*) AS n FROM outbound_attempt GROUP BY outcome`).all(),
    note: 'Approved-but-not-posted, posted, failed, held and source conflicts are counted '
      + 'separately. Nothing is reported posted that the destination did not acknowledge.',
  };
}
