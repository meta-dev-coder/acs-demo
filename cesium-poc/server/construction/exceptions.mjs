/**
 * Exceptions: one per finding, for the life of the project.
 *
 * STABLE IDENTITY is the whole design. The key is `(rule, subject)`, so synchronising fifty times
 * leaves one exception per real problem rather than fifty copies of it. `first_detected` never
 * moves; `last_detected` does.
 *
 * A RESOLVED EXCEPTION IS NEVER DELETED. If the same finding comes back, the original row reopens
 * with a new event in its history and `reopen_count` goes up — so "this has failed three times
 * since August" is a question the data can answer.
 *
 * Only ACTIONABLE findings become exceptions. A work-in-progress model is excluded by policy; it
 * is recorded as a validation result and shown as an exclusion, and nobody is asked to fix it.
 */
import { ruleById, SEVERITY } from './validation.mjs';

export const EXCEPTION_STATUS = Object.freeze({
  OPEN: 'OPEN',
  UNDER_REVIEW: 'UNDER_REVIEW',
  AWAITING_CORRECTION: 'AWAITING_CORRECTION',
  READY_FOR_REVALIDATION: 'READY_FOR_REVALIDATION',
  RESOLVED: 'RESOLVED',
});

/** Which transitions a person may make. Anything else is refused and says why. */
export const TRANSITIONS = Object.freeze({
  OPEN: ['UNDER_REVIEW', 'AWAITING_CORRECTION'],
  UNDER_REVIEW: ['AWAITING_CORRECTION', 'READY_FOR_REVALIDATION', 'OPEN'],
  AWAITING_CORRECTION: ['READY_FOR_REVALIDATION', 'UNDER_REVIEW'],
  // RESOLVED is reached by revalidation finding the problem gone, never by a person asserting it.
  READY_FOR_REVALIDATION: ['UNDER_REVIEW'],
  RESOLVED: [],
});

const OPEN_STATUSES = Object.freeze(['OPEN', 'UNDER_REVIEW', 'AWAITING_CORRECTION', 'READY_FOR_REVALIDATION']);

const nowIso = () => new Date().toISOString();

function addEvent(db, exceptionId, { at, actor, event, from = null, to = null, detail = null }) {
  db.prepare(`INSERT INTO exception_event (exception_id, at, actor, event, from_status, to_status, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(exceptionId, at, actor, event, from, to, detail == null ? null : JSON.stringify(detail));
}

/**
 * Reconcile the exception list against this run's findings.
 *
 * @returns {{created, reopened, updated, resolved}}
 */
export function syncExceptions(db, findings, { actor = 'Integration service', now = nowIso } = {}) {
  const at = now();
  const actionable = findings.filter(entry => ruleById(entry.ruleId)?.actionable);
  const seen = new Set(actionable.map(entry => entry.key));
  const counts = { created: 0, reopened: 0, updated: 0, resolved: 0 };

  const select = db.prepare('SELECT * FROM exception WHERE exception_key = ?');
  const insert = db.prepare(
    `INSERT INTO exception (exception_key, rule_id, interface_id, subject_type, subject_id,
        severity, owner_role, description, suggested_action, status, first_detected, last_detected)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`);

  db.exec('BEGIN');
  try {
    for (const entry of actionable) {
      const existing = select.get(entry.key);
      if (!existing) {
        const id = insert.run(entry.key, entry.ruleId, entry.interfaceId, entry.subjectType,
          entry.subjectId, entry.severity, entry.owner, entry.explanation, entry.suggestedAction,
          at, at).lastInsertRowid;
        addEvent(db, id, { at, actor, event: 'DETECTED', to: EXCEPTION_STATUS.OPEN,
          detail: { expected: entry.expected, actual: entry.actual } });
        counts.created += 1;
        continue;
      }
      if (existing.status === EXCEPTION_STATUS.RESOLVED) {
        // It came back. The original row reopens; a new row would lose everything it has been.
        db.prepare(`UPDATE exception SET status = 'OPEN', last_detected = ?, resolved_at = NULL,
            reopen_count = reopen_count + 1, description = ?, severity = ? WHERE id = ?`)
          .run(at, entry.explanation, entry.severity, existing.id);
        addEvent(db, existing.id, { at, actor, event: 'REOPENED',
          from: EXCEPTION_STATUS.RESOLVED, to: EXCEPTION_STATUS.OPEN,
          detail: { reopenCount: existing.reopen_count + 1, actual: entry.actual } });
        counts.reopened += 1;
        continue;
      }
      // Still open. Only the detection time and the wording move; its status is a person's.
      db.prepare('UPDATE exception SET last_detected = ?, description = ?, severity = ? WHERE id = ?')
        .run(at, entry.explanation, entry.severity, existing.id);
      counts.updated += 1;
    }

    // Open exceptions this run did not find again are genuinely resolved.
    for (const row of db.prepare(
      `SELECT * FROM exception WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')})`)
      .all(...OPEN_STATUSES)) {
      if (seen.has(row.exception_key)) continue;
      db.prepare("UPDATE exception SET status = 'RESOLVED', resolved_at = ? WHERE id = ?").run(at, row.id);
      addEvent(db, row.id, { at, actor, event: 'RESOLVED_BY_REVALIDATION',
        from: row.status, to: EXCEPTION_STATUS.RESOLVED,
        detail: { note: 'The finding no longer occurs. Resolved by revalidation, not by assertion.' } });
      counts.resolved += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return Object.freeze(counts);
}

/** Move one exception along its lifecycle. Refuses anything the table above does not allow. */
export function transitionException(db, id, to, { actor, note = null, now = nowIso } = {}) {
  const row = db.prepare('SELECT * FROM exception WHERE id = ?').get(Number(id));
  if (!row) return { ok: false, error: `There is no exception ${id}.` };
  if (to === EXCEPTION_STATUS.RESOLVED) {
    return { ok: false,
      error: 'An exception is resolved by revalidation finding the problem gone, not by being '
        + 'marked resolved. Correct the mapping and revalidate.' };
  }
  const allowed = TRANSITIONS[row.status] ?? [];
  if (!allowed.includes(to)) {
    return { ok: false,
      error: `${row.status} cannot move to ${to}. From ${row.status} the moves are: ${allowed.join(', ') || 'none'}.` };
  }
  const at = now();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE exception SET status = ? WHERE id = ?').run(to, row.id);
    addEvent(db, row.id, { at, actor, event: 'STATUS_CHANGED', from: row.status, to,
      detail: note ? { note } : null });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { ok: true, exception: db.prepare('SELECT * FROM exception WHERE id = ?').get(row.id) };
}

/** The exception list, filtered. Resolved ones are included only when asked for. */
export function listExceptions(db, filters = {}) {
  const where = [];
  const params = [];
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }
  else if (!filters.includeResolved) { where.push(`status IN (${OPEN_STATUSES.map(() => '?').join(',')})`); params.push(...OPEN_STATUSES); }
  if (filters.rule) { where.push('rule_id = ?'); params.push(filters.rule); }
  if (filters.severity) { where.push('severity = ?'); params.push(filters.severity); }
  if (filters.owner) { where.push('owner_role = ?'); params.push(filters.owner); }
  if (filters.interface) { where.push('interface_id = ?'); params.push(filters.interface); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(500, Math.max(1, Number(filters.limit) || 100));
  return {
    total: db.prepare(`SELECT COUNT(*) AS n FROM exception ${clause}`).get(...params).n,
    rows: db.prepare(
      `SELECT * FROM exception ${clause}
        ORDER BY CASE severity WHEN 'ERROR' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END,
                 last_detected DESC, id DESC LIMIT ?`).all(...params, limit),
  };
}

/** One exception with everything behind it: its history, its finding and its mapping. */
export function exceptionDetail(db, id) {
  const row = db.prepare('SELECT * FROM exception WHERE id = ?').get(Number(id));
  if (!row) return null;
  return {
    exception: row,
    rule: ruleById(row.rule_id),
    history: db.prepare('SELECT * FROM exception_event WHERE exception_id = ? ORDER BY id')
      .all(row.id).map(event => ({ ...event, detail: event.detail ? JSON.parse(event.detail) : null })),
    validation: db.prepare('SELECT * FROM validation_result WHERE result_key = ?').get(row.exception_key) ?? null,
    proposals: db.prepare('SELECT * FROM mapping_proposal WHERE exception_id = ? ORDER BY id DESC').all(row.id),
    /** The element whose mapping this is about, where the subject is one. */
    elementId: row.subject_type === 'element' ? row.subject_id : null,
  };
}

/** Counts by status and severity, for the workspace header. All counted, none written down. */
export function exceptionSummary(db) {
  const byStatus = Object.fromEntries(Object.values(EXCEPTION_STATUS).map(status =>
    [status, db.prepare('SELECT COUNT(*) AS n FROM exception WHERE status = ?').get(status).n]));
  const bySeverity = Object.fromEntries([SEVERITY.ERROR, SEVERITY.WARNING].map(severity =>
    [severity, db.prepare(
      `SELECT COUNT(*) AS n FROM exception WHERE severity = ?
        AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`).get(severity, ...OPEN_STATUSES).n]));
  return {
    byStatus,
    bySeverity,
    open: OPEN_STATUSES.reduce((total, status) => total + byStatus[status], 0),
    resolved: byStatus.RESOLVED,
    reopened: db.prepare('SELECT COUNT(*) AS n FROM exception WHERE reopen_count > 0').get().n,
    /** Excluded by policy — shown, never counted as a failure. */
    excludedByPolicy: db.prepare(
      "SELECT COUNT(*) AS n FROM validation_result WHERE severity = 'EXCLUDED' AND status = 'OPEN'").get().n,
  };
}

export { OPEN_STATUSES };
