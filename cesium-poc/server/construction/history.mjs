/**
 * Sync History & Audit — read-only views over what the earlier phases already persisted.
 *
 * NOTHING IS COPIED INTO A SECOND AUDIT TABLE. The unified trail is a query-time MERGE over five
 * stores, each of which stays its own source of truth:
 *
 *   audit_event ........... the application's own events
 *   exception_event ....... an exception's lifecycle, with from/to status
 *   outbound_transition ... a write-back proposal's lifecycle
 *   outbound_attempt ...... what a mock destination actually answered
 *   mapping_proposal ...... a mapping change and its decision
 *
 * A duplicate table would be a second version of the truth to drift from the first, and the brief
 * is explicit that existing records should be reused.
 *
 * WHAT IS NOT RECORDED IS SAID, NOT GUESSED. Where a historical row carries no actor or no
 * correlation id — because the column did not exist when it was written — the field is null and
 * the screen prints "Not recorded".
 */

const json = value => { try { return value ? JSON.parse(value) : null; } catch { return null; } };
/**
 * Positional parameters, built together with the clauses that use them.
 *
 * `node:sqlite` refuses a named parameter the statement does not reference, so an optional filter
 * left unset made the whole query throw rather than simply not filtering.
 */
function filters() {
  const clauses = [];
  const params = [];
  return {
    add(sql, value) { if (value) { clauses.push(sql); params.push(value); } return this; },
    range(column, from, to) {
      this.add(`${column} >= ?`, from);
      this.add(`${column} <= ?`, to ? `${to}\uffff` : null);
      return this;
    },
    get where() { return clauses.length ? clauses.join(' AND ') : '1 = 1'; },
    get params() { return params; },
  };
}

/* ── A. synchronisation history ────────────────────────────────────────────────────────────── */

const INTERFACE_ROUTE = Object.freeze({
  'INT-01': { source: 'Primavera P6', destination: 'SYNCHRO 4D', direction: 'INBOUND' },
  'INT-02': { source: 'SYNCHRO 4D', destination: 'mock Primavera P6', direction: 'OUTBOUND' },
  'INT-03': { source: 'ACC / Revit', destination: 'SYNCHRO 4D', direction: 'INBOUND' },
  'INT-04': { source: 'SAP', destination: 'SYNCHRO 4D', direction: 'INBOUND' },
  'INT-05': { source: 'SYNCHRO 4D', destination: 'mock SAP', direction: 'OUTBOUND' },
});

/**
 * Inbound runs and outbound posting attempts, in one list and never conflated.
 *
 * An outbound attempt has no "records read" — it posts one record to one destination — so those
 * columns are null rather than 1 or 0. Inventing a count for a posting would make the two kinds
 * of row look comparable when they are not.
 */
export function syncHistory(db, { interfaceId = null, status = null, from = null, to = null, limit = 200 } = {}) {
  const capped = Math.min(500, Math.max(1, Number(limit) || 200));
  const rows = [];

  const inbound = filters().add('interface_id = ?', interfaceId).add('status = ?', status)
    .range('started_at', from, to);
  for (const run of db.prepare(
    `SELECT * FROM sync_run WHERE ${inbound.where} ORDER BY id DESC LIMIT ?`)
    .all(...inbound.params, capped)) {
    rows.push({
      kind: 'SYNC_RUN',
      id: `RUN-${String(run.id).padStart(4, '0')}`,
      rawId: run.id,
      interfaceId: run.interface_id,
      ...INTERFACE_ROUTE[run.interface_id],
      startedAt: run.started_at,
      completedAt: run.finished_at,
      status: run.status,
      recordsRead: run.records_read,
      created: run.records_created,
      updated: run.records_updated,
      unchanged: run.records_unchanged,
      failed: run.records_skipped,
      errors: run.error_count,
      actor: run.actor,
      /* Inbound runs predate correlation ids and have none. Said, not invented. */
      correlationId: null,
    });
  }

  const outbound = filters().add('p.interface_id = ?', interfaceId).range('a.at', from, to);
  for (const attempt of db.prepare(
    `SELECT a.*, p.interface_id, p.subject_id, p.status AS proposal_status
       FROM outbound_attempt a JOIN outbound_proposal p ON p.id = a.proposal_id
      WHERE ${outbound.where} ORDER BY a.id DESC LIMIT ?`)
    .all(...outbound.params, capped)) {
    const outcome = attempt.outcome === 'ACKNOWLEDGED' ? 'SUCCESS'
      : attempt.outcome === 'FAILED' ? 'FAILED' : 'RUNNING';
    if (status && status !== outcome) continue;
    rows.push({
      kind: 'POSTING_ATTEMPT',
      id: `POST-${String(attempt.proposal_id).padStart(4, '0')}.${attempt.attempt}`,
      rawId: attempt.proposal_id,
      interfaceId: attempt.interface_id,
      ...INTERFACE_ROUTE[attempt.interface_id],
      subjectId: attempt.subject_id,
      startedAt: attempt.at,
      completedAt: attempt.finished_at,
      status: outcome,
      /* A posting is one record to one destination; a read count would be a fabricated figure. */
      recordsRead: null, created: null, updated: null, unchanged: null, failed: null,
      errors: attempt.outcome === 'FAILED' ? 1 : 0,
      actor: attempt.actor,
      correlationId: attempt.correlation_id,
      attempt: attempt.attempt,
    });
  }

  rows.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return {
    rows: rows.slice(0, capped),
    total: rows.length,
    interfaces: INTERFACE_ROUTE,
  };
}

/** One run or attempt, with its errors or its destination's answer. */
export function syncRunDetail(db, kind, id) {
  if (kind === 'SYNC_RUN') {
    const run = db.prepare('SELECT * FROM sync_run WHERE id = ?').get(Number(id));
    if (!run) return null;
    return {
      kind, run, ...INTERFACE_ROUTE[run.interface_id],
      errors: db.prepare('SELECT * FROM sync_error WHERE sync_run_id = ? ORDER BY id').all(run.id),
      audit: db.prepare('SELECT * FROM audit_event WHERE sync_run_id = ? ORDER BY id').all(run.id)
        .map(row => ({ ...row, detail: json(row.detail) })),
    };
  }
  const attempts = db.prepare(
    `SELECT a.*, p.interface_id, p.subject_id, p.payload FROM outbound_attempt a
       JOIN outbound_proposal p ON p.id = a.proposal_id WHERE a.proposal_id = ? ORDER BY a.attempt`)
    .all(Number(id));
  if (!attempts.length) return null;
  return {
    kind, ...INTERFACE_ROUTE[attempts[0].interface_id],
    proposalId: Number(id),
    subjectId: attempts[0].subject_id,
    payload: json(attempts[0].payload),
    attempts: attempts.map(row => ({ ...row,
      request: json(row.request), response: json(row.response) })),
  };
}

/* ── B. the unified audit trail ────────────────────────────────────────────────────────────── */

const SOURCES = Object.freeze({
  AUDIT: 'audit_event', EXCEPTION: 'exception_event',
  OUTBOUND: 'outbound_transition', POSTING: 'outbound_attempt', MAPPING: 'mapping_proposal',
});

/**
 * Every persisted event, merged chronologically.
 *
 * Each row names the store it came from, so a reader can go back to the record itself, and the
 * five shapes are normalised into one without any of them being rewritten.
 */
export function auditTrail(db, {
  query = null, event = null, interfaceId = null, subject = null, source = null,
  from = null, to = null, limit = 300,
} = {}) {
  const capped = Math.min(1000, Math.max(1, Number(limit) || 300));
  const out = [];

  for (const row of db.prepare('SELECT * FROM audit_event ORDER BY id DESC LIMIT 2000').all()) {
    out.push({
      source: SOURCES.AUDIT, id: `AE-${row.id}`, at: row.at, event: row.event,
      actor: row.actor, interfaceId: row.interface_id, subjectId: row.subject_id,
      previous: row.previous_state, next: row.new_state, result: row.result,
      correlationId: row.correlation_id, detail: json(row.detail),
      link: row.subject_id ? { kind: 'record', id: row.subject_id } : null,
    });
  }

  for (const row of db.prepare(
    `SELECT e.*, x.subject_id, x.rule_id, x.interface_id FROM exception_event e
       JOIN exception x ON x.id = e.exception_id ORDER BY e.id DESC LIMIT 2000`).all()) {
    out.push({
      source: SOURCES.EXCEPTION, id: `EX-${row.id}`, at: row.at,
      event: `EXCEPTION_${row.event}`, actor: row.actor, interfaceId: row.interface_id,
      subjectId: row.subject_id, previous: row.from_status, next: row.to_status,
      result: row.to_status, correlationId: null, detail: json(row.detail),
      link: { kind: 'exception', id: row.exception_id, rule: row.rule_id },
    });
  }

  for (const row of db.prepare(
    `SELECT t.*, p.interface_id, p.subject_id, p.correlation_id FROM outbound_transition t
       JOIN outbound_proposal p ON p.id = t.proposal_id ORDER BY t.id DESC LIMIT 2000`).all()) {
    out.push({
      source: SOURCES.OUTBOUND, id: `OT-${row.id}`, at: row.at,
      event: `PROPOSAL_${row.to_status}`, actor: row.actor, interfaceId: row.interface_id,
      subjectId: row.subject_id, previous: row.from_status, next: row.to_status,
      result: row.reason, correlationId: row.correlation_id, detail: json(row.detail),
      link: { kind: 'proposal', id: row.proposal_id },
    });
  }

  for (const row of db.prepare(
    `SELECT a.*, p.interface_id, p.subject_id FROM outbound_attempt a
       JOIN outbound_proposal p ON p.id = a.proposal_id ORDER BY a.id DESC LIMIT 1000`).all()) {
    const response = json(row.response);
    out.push({
      source: SOURCES.POSTING, id: `OA-${row.id}`, at: row.at,
      event: `POSTING_${row.outcome}`, actor: row.actor, interfaceId: row.interface_id,
      subjectId: row.subject_id,
      previous: response?.before ? JSON.stringify(response.before) : null,
      next: response?.after ? JSON.stringify(response.after) : null,
      result: row.outcome === 'ACKNOWLEDGED'
        ? 'Acknowledged by the mock destination' : response?.error ?? row.outcome,
      correlationId: row.correlation_id, detail: { attempt: row.attempt, request: json(row.request) },
      link: { kind: 'proposal', id: row.proposal_id },
    });
  }

  for (const row of db.prepare('SELECT * FROM mapping_proposal ORDER BY id DESC LIMIT 1000').all()) {
    out.push({
      source: SOURCES.MAPPING, id: `MP-${row.id}`, at: row.decided_at ?? row.created_at,
      event: `MAPPING_${row.status}`, actor: row.approver ?? row.requester,
      interfaceId: null, subjectId: row.element_id,
      previous: row.current_value, next: row.proposed_value,
      result: row.validation_outcome ?? row.status, correlationId: null,
      detail: { field: row.field, reason: row.reason, requesterRole: row.requester_role,
        approverRole: row.approver_role },
      link: { kind: 'mapping', id: row.element_id },
    });
  }

  const wanted = String(query ?? '').trim().toLowerCase();
  const filtered = out.filter(row => {
    if (event && row.event !== event) return false;
    if (interfaceId && row.interfaceId !== interfaceId) return false;
    if (source && row.source !== source) return false;
    if (subject && String(row.subjectId ?? '') !== subject) return false;
    if (from && String(row.at) < from) return false;
    if (to && String(row.at) > `${to}￿`) return false;
    if (wanted) {
      const haystack = [row.event, row.actor, row.subjectId, row.result, row.correlationId,
        row.previous, row.next].join(' ').toLowerCase();
      if (!haystack.includes(wanted)) return false;
    }
    return true;
  });
  filtered.sort((a, b) => String(b.at).localeCompare(String(a.at)) || b.id.localeCompare(a.id));

  return {
    rows: filtered.slice(0, capped),
    total: filtered.length,
    /** The facets the screen filters by, read from what is actually there. */
    facets: {
      event: [...new Set(out.map(row => row.event))].sort(),
      interfaceId: [...new Set(out.map(row => row.interfaceId).filter(Boolean))].sort(),
      source: Object.values(SOURCES),
    },
    sources: SOURCES,
  };
}

/* ── C. write-back history ─────────────────────────────────────────────────────────────────── */

/** Every outbound proposal with its approval, its attempts and its conflict, if it has one. */
export function writeBackHistory(db, { interfaceId = null, status = null, subject = null, limit = 200 } = {}) {
  const where = filters().add('interface_id = ?', interfaceId).add('status = ?', status)
    .add('subject_id = ?', subject);
  const rows = db.prepare(
    `SELECT * FROM outbound_proposal WHERE ${where.where} ORDER BY id DESC LIMIT ?`)
    .all(...where.params, Math.min(500, Math.max(1, Number(limit) || 200)));

  return rows.map(row => {
    const payload = json(row.payload) ?? {};
    const attempts = db.prepare(
      'SELECT * FROM outbound_attempt WHERE proposal_id = ? ORDER BY attempt').all(row.id);
    const acknowledged = attempts.find(entry => entry.outcome === 'ACKNOWLEDGED');
    return {
      proposalId: row.id,
      reference: `OUT-${String(row.id).padStart(4, '0')}`,
      interfaceId: row.interface_id,
      destination: INTERFACE_ROUTE[row.interface_id]?.destination ?? null,
      subjectId: row.subject_id,
      status: row.status,
      approver: row.approver,
      approverRole: row.approver_role,
      approvedAt: row.decided_at,
      sourceRev: row.source_rev,
      previousValue: payload.current ?? null,
      proposedValue: payload.proposed ?? null,
      attemptCount: attempts.length,
      acknowledgement: acknowledged ? json(acknowledged.response) : null,
      postedAt: row.posted_at,
      holdReason: row.hold_reason,
      failureReason: row.failure_reason,
      correlationId: row.correlation_id,
      coverage: json(row.coverage),
      /* A held proposal's conflict lives in the exception table, where every exception lives. */
      conflictException: row.status === 'HELD'
        ? db.prepare(
          `SELECT id, rule_id, status, description FROM exception
            WHERE rule_id = 'R12_WRITEBACK_CONFLICT' AND subject_id = ? ORDER BY id DESC LIMIT 1`)
          .get(row.subject_id) ?? null
        : null,
      /** Said on every row, because a simulated acknowledgment is not a transaction. */
      simulated: true,
    };
  });
}

/** One proposal's complete timeline: every transition and every attempt, in order. */
export function writeBackDetail(db, proposalId) {
  const row = db.prepare('SELECT * FROM outbound_proposal WHERE id = ?').get(Number(proposalId));
  if (!row) return null;
  const [summary] = writeBackHistory(db, { subject: row.subject_id, limit: 500 })
    .filter(entry => entry.proposalId === row.id);
  return {
    ...summary,
    payload: json(row.payload),
    evidence: json(row.evidence),
    transitions: db.prepare(
      'SELECT * FROM outbound_transition WHERE proposal_id = ? ORDER BY id').all(row.id)
      .map(entry => ({ ...entry, detail: json(entry.detail) })),
    attempts: db.prepare('SELECT * FROM outbound_attempt WHERE proposal_id = ? ORDER BY attempt')
      .all(row.id).map(entry => ({ ...entry,
        request: json(entry.request), response: json(entry.response) })),
    note: 'Every posting here is simulated against a mock destination. None of it is a P6 or SAP '
      + 'transaction, and no live system has been contacted.',
  };
}

/* ── D. reconciliation history ─────────────────────────────────────────────────────────────── */

/** Every reconciliation run, not only the latest. */
export function reconciliationHistory(db, { limit = 100 } = {}) {
  return db.prepare('SELECT * FROM reconciliation_run ORDER BY id DESC LIMIT ?')
    .all(Math.min(200, Math.max(1, Number(limit) || 100)))
    .map(run => ({
      runId: run.id, at: run.at, actor: run.actor,
      checks: run.checks, passed: run.passed, warnings: run.warnings, failed: run.failed,
      result: run.failed ? 'FAIL' : run.warnings ? 'WARN' : 'PASS',
    }));
}

/** One run's checks, with the policy exclusions kept apart from the failures. */
export function reconciliationRunDetail(db, runId) {
  const run = db.prepare('SELECT * FROM reconciliation_run WHERE id = ?').get(Number(runId));
  if (!run) return null;
  const checks = db.prepare('SELECT * FROM reconciliation_check WHERE run_id = ? ORDER BY id')
    .all(run.id);
  return {
    run,
    checks,
    totals: {
      checked: checks.reduce((sum, row) => sum + row.checked, 0),
      matched: checks.reduce((sum, row) => sum + row.matched, 0),
      unmatched: checks.reduce((sum, row) => sum + row.unmatched, 0),
      warnings: checks.reduce((sum, row) => sum + row.warnings, 0),
      excluded: checks.reduce((sum, row) => sum + row.excluded, 0),
    },
    note: 'Checked = matched + unmatched + excluded on every row. A record excluded by policy — '
      + 'an unpublished model version — is not a failed one.',
  };
}

export { INTERFACE_ROUTE };
