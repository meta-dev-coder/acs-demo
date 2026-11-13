/**
 * Where the live schedule is remembered, and nothing else is touched.
 *
 * Every statement in this file names a `live_schedule_*` table. There is no INSERT or UPDATE here
 * against `activity`, `src_p6_activity`, `element`, `cost`, `sync_run` or any other table the
 * five pilot interfaces own — which is the isolation the phase asks for, checkable by reading the
 * SQL rather than by trusting a comment.
 *
 * The one thing it writes outside its own namespace is an `audit_event` row through the existing
 * `recordAudit`, because the audit trail is the place a reader looks to find out what the system
 * did. That event is labelled as a READ and carries no interface id, so it can never be mistaken
 * for a synchronisation.
 */
import { CHANGE, MAPPING, RUN_STATUS, SOURCE, TRIGGER } from './openProjectConfig.mjs';
import { diffActivity, eventful, summarize } from './openProjectChanges.mjs';
import { recordAudit } from './sync.mjs';

const nowIso = () => new Date().toISOString();

/**
 * Several related writes, or none of them.
 *
 * A synchronisation cycle writes one fetch row, up to N snapshot upserts and up to M change rows,
 * and they are one fact: a snapshot advanced to revision 4 with no change row explaining how is
 * a record that has lost its own history, and a change row pointing at a fetch id that was rolled
 * back is a dangling reference. `BEGIN IMMEDIATE` takes the write lock up front rather than
 * discovering a conflict at the first write and failing halfway.
 *
 * Deliberately not nestable. Nothing in this file calls another function here that transacts, and
 * a silent no-op on a nested call would turn a rollback into a partial commit — so a nested call
 * would raise, which is the failure we would want.
 */
export function transact(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  let out;
  try {
    out = fn();
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* the transaction is already gone */ }
    throw error;
  }
  db.exec('COMMIT');
  return out;
}

/**
 * The adapter's connection state, as a RUN outcome.
 *
 * Two different vocabularies on purpose. `state` answers "what happened on the wire" and is the
 * adapter's to define; `run_status` answers "what became of this cycle" and has one value the
 * wire cannot produce — SKIPPED, a cycle that never asked because another was still running.
 * PARTIAL survives the translation because a run that read half a collection is neither a success
 * nor a failure, and flattening it to either would be a lie in one direction or the other.
 */
export function runStatusFor(state) {
  if (state === 'CONNECTED') return RUN_STATUS.SUCCESS;
  if (state === 'PARTIAL') return RUN_STATUS.PARTIAL;
  return RUN_STATUS.FAILED;
}

/** The run columns, defaulted, so an older caller that passes nothing still writes a valid row. */
const runColumns = (run, { state, at }) => ({
  runId: run?.runId ?? null,
  trigger: run?.trigger ?? TRIGGER.MANUAL,
  runStatus: run?.runStatus ?? runStatusFor(state),
  startedAt: run?.startedAt ?? at,
  finishedAt: run?.finishedAt ?? at,
});

/** The stored snapshot for one project, keyed by external id. */
export function snapshotMap(db, projectId) {
  const rows = db.prepare(`SELECT * FROM live_schedule_snapshot
     WHERE source_system = ? AND project_id = ?`).all(SOURCE.system, String(projectId));
  return new Map(rows.map(row => [String(row.external_id), row]));
}

/** Every stored snapshot for one project, newest observation first. */
export function storedActivities(db, projectId) {
  return db.prepare(`SELECT * FROM live_schedule_snapshot
     WHERE source_system = ? AND project_id = ?
     ORDER BY CAST(external_id AS INTEGER), external_id`).all(SOURCE.system, String(projectId))
    .map(row => ({ ...JSON.parse(row.payload), firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at }));
  }

/**
 * The last fetch that actually ASKED, whatever its outcome. What "stale" is measured against.
 *
 * SKIPPED runs are excluded, and that exclusion is the whole correctness of the stale banner. A
 * skip is a cycle that never reached the wire, so it carries no connection result: counting one
 * as "the last fetch" would both put the word SKIPPED where the screen expects a connection state
 * and mark perfectly current data as stale because a tick coalesced.
 */
export function lastFetch(db, projectId) {
  return db.prepare(`SELECT * FROM live_schedule_fetch
     WHERE source_system = ? AND project_id = ?
       AND (run_status IS NULL OR run_status != ?)
     ORDER BY id DESC LIMIT 1`)
    .get(SOURCE.system, String(projectId), RUN_STATUS.SKIPPED) ?? null;
}

/** The last SUCCESSFUL fetch. A screen showing stored rows must date them from this, not the above. */
export function lastSuccessfulFetch(db, projectId) {
  return db.prepare(`SELECT * FROM live_schedule_fetch
     WHERE source_system = ? AND project_id = ? AND state IN ('CONNECTED', 'PARTIAL')
     ORDER BY id DESC LIMIT 1`).get(SOURCE.system, String(projectId)) ?? null;
}

/** The change log, newest first. */
export function changeLog(db, projectId, { externalId = null, limit = 200 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 200, 1), 1_000);
  const rows = externalId
    ? db.prepare(`SELECT * FROM live_schedule_change
         WHERE source_system = ? AND project_id = ? AND external_id = ?
         ORDER BY id DESC LIMIT ?`).all(SOURCE.system, String(projectId), String(externalId), capped)
    : db.prepare(`SELECT * FROM live_schedule_change
         WHERE source_system = ? AND project_id = ? ORDER BY id DESC LIMIT ?`)
      .all(SOURCE.system, String(projectId), capped);
  return rows.map(row => ({
    id: row.id,
    externalId: row.external_id,
    kind: row.kind,
    field: row.field,
    previous: row.previous_value,
    current: row.current_value,
    previousRevision: row.previous_revision,
    currentRevision: row.current_revision,
    previousUpdatedAt: row.previous_updated_at,
    currentUpdatedAt: row.current_updated_at,
    detectedAt: row.detected_at,
    fetchId: row.fetch_id,
  }));
}

/** The read log, newest first. Not sync runs — see the schema comment. */
export function fetchLog(db, projectId, { limit = 50, includeSkipped = true } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const rows = includeSkipped
    ? db.prepare(`SELECT * FROM live_schedule_fetch
         WHERE source_system = ? AND project_id = ? ORDER BY id DESC LIMIT ?`)
      .all(SOURCE.system, String(projectId), capped)
    : db.prepare(`SELECT * FROM live_schedule_fetch
         WHERE source_system = ? AND project_id = ? AND (run_status IS NULL OR run_status != ?)
         ORDER BY id DESC LIMIT ?`)
      .all(SOURCE.system, String(projectId), RUN_STATUS.SKIPPED, capped);
  return rows.map(shapeRun);
}

/**
 * One row of the read log, as a run.
 *
 * `durationMs` is computed from the bracket rather than taken from `elapsed_ms`, because they
 * measure different things: `elapsedMs` is time spent in HTTP and `durationMs` is the whole cycle
 * including the diff and the writes. Both are reported; neither stands in for the other.
 */
const shapeRun = row => ({
  id: row.id,
  runId: row.run_id,
  trigger: row.trigger,
  /** SUCCESS | PARTIAL | FAILED | SKIPPED. Null on a row written before Phase 8B. */
  runStatus: row.run_status,
  at: row.at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  durationMs: row.started_at && row.finished_at
    ? Math.max(0, Date.parse(row.finished_at) - Date.parse(row.started_at)) : null,
  state: row.state,
  failure: row.failure,
  httpStatus: row.http_status,
  /** Already sanitized by the adapter: `scrub()` runs over every upstream reason before storage. */
  reason: row.reason,
  elapsedMs: row.elapsed_ms,
  collectionTotal: row.collection_total,
  received: row.records_received,
  new: row.records_new,
  changed: row.records_changed,
  unchanged: row.records_unchanged,
  actor: row.actor,
});

/** The synchronisation history, newest first, skips included. */
export function syncHistory(db, projectId, { limit = 50 } = {}) {
  return fetchLog(db, projectId, { limit, includeSkipped: true });
}

/** The last run of any outcome, SKIPPED included. For "when did the worker last wake up?". */
export function lastRun(db, projectId) {
  const row = db.prepare(`SELECT * FROM live_schedule_fetch
     WHERE source_system = ? AND project_id = ? ORDER BY id DESC LIMIT 1`)
    .get(SOURCE.system, String(projectId));
  return row ? shapeRun(row) : null;
}

export { shapeRun };

/**
 * Record a fetch that did not come back with data.
 *
 * The snapshots are left exactly as they were — the brief's rule, and the right one: the last
 * thing OpenProject told us is still the last thing it told us, and discarding it would leave the
 * screen with nothing to show and no way to say when it last worked. The caller marks it stale.
 */
export function recordFailedFetch(db, { projectId, result, actor = 'Demo operator', run = null }) {
  const at = nowIso();
  const columns = runColumns(run, { state: result.state, at });
  const info = db.prepare(`INSERT INTO live_schedule_fetch (source_system, project_id, at, state,
      failure, http_status, reason, elapsed_ms, collection_total, records_received, records_new,
      records_changed, records_unchanged, actor, run_id, trigger, run_status, started_at,
      finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?)`)
    .run(SOURCE.system, String(projectId), at, result.state, result.failure ?? null,
      result.httpStatus ?? null, result.reason ?? null, result.elapsedMs ?? null, actor,
      columns.runId, columns.trigger, columns.runStatus, columns.startedAt, columns.finishedAt);
  recordAudit(db, { actor, event: 'LIVE_SCHEDULE_READ_FAILED', subject: `OPENPROJECT:${projectId}`,
    result: `${result.state}${result.failure ? ` (${result.failure})` : ''}`,
    detail: { source: SOURCE.system, projectId: String(projectId), reason: result.reason ?? null,
      runId: columns.runId, trigger: columns.trigger,
      note: 'A failed read. No snapshot was changed and nothing was written to any integration '
        + 'table.' } });
  return { fetchId: Number(info.lastInsertRowid), at, runId: columns.runId,
    runStatus: columns.runStatus };
}

/**
 * A cycle that never asked, recorded as SKIPPED.
 *
 * Written for a SCHEDULED tick that found a run already in flight — which is the single most
 * useful row in this table when somebody asks why a 60-second poller produced 40 reads in an
 * hour. It has no `state`, because there was no connection: `state` carries the run status word
 * so a reader of the `state` column is never shown a connection result that did not happen.
 *
 * No audit event. A skip changed nothing, and an audit trail that records non-events buries the
 * ones that matter.
 */
export function recordSkippedRun(db, { projectId, run, reason, actor = 'Integration service' }) {
  const at = nowIso();
  const info = db.prepare(`INSERT INTO live_schedule_fetch (source_system, project_id, at, state,
      failure, http_status, reason, elapsed_ms, collection_total, records_received, records_new,
      records_changed, records_unchanged, actor, run_id, trigger, run_status, started_at,
      finished_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?)`)
    .run(SOURCE.system, String(projectId), at, RUN_STATUS.SKIPPED, reason, actor,
      run?.runId ?? null, run?.trigger ?? TRIGGER.SCHEDULED, RUN_STATUS.SKIPPED,
      run?.startedAt ?? at, at);
  return { fetchId: Number(info.lastInsertRowid), at, runStatus: RUN_STATUS.SKIPPED };
}

/**
 * Apply a successful read: diff every activity, store the new snapshot, log the findings.
 *
 * IDEMPOTENT. Refreshing twice with no change in OpenProject writes one more `live_schedule_fetch`
 * row — which is true, a read did happen — and no new snapshot values and no new change rows. The
 * `UNIQUE` constraint on `(external_id, current_revision, kind, field)` is what guarantees the
 * last part even if a caller asked twice concurrently.
 *
 * @returns the per-activity diffs, the counts, and the ids written
 */
export function applyFetch(db, { projectId, result, actor = 'Demo operator', run = null }) {
  const at = nowIso();
  const previous = snapshotMap(db, projectId);
  const activities = result.activities ?? [];

  const diffs = [];
  for (const activity of activities) {
    if (!activity.externalActivityId) continue;
    diffs.push(diffActivity(previous.get(String(activity.externalActivityId)) ?? null, activity));
  }

  /**
   * An activity we have a snapshot for that OpenProject no longer returns.
   *
   * Reported as REMOVED, and the snapshot is KEPT. It may have been deleted, moved to another
   * project, or filtered out by something we did not anticipate — and deleting our record of it
   * would destroy the evidence needed to tell those apart.
   */
  const seen = new Set(activities.map(entry => String(entry.externalActivityId)));
  const removed = [];
  if (result.state === 'CONNECTED') {
    for (const [externalId, row] of previous) {
      if (seen.has(externalId)) continue;
      removed.push({ externalId, previousRevision: row.source_revision, currentRevision: null,
        previousUpdatedAt: row.source_updated_at, currentUpdatedAt: null,
        baseline: false, revisionMoved: false, kinds: [CHANGE.REMOVED],
        findings: [{ kind: CHANGE.REMOVED, field: null, label: 'No longer returned',
          previous: row.activity_name, current: null, externalId,
          previousRevision: row.source_revision, currentRevision: null,
          previousUpdatedAt: row.source_updated_at, currentUpdatedAt: null,
          detail: 'This activity was in an earlier read and OpenProject no longer returns it. The '
            + 'stored snapshot is kept — it may have been deleted, moved, or excluded by a filter, '
            + 'and discarding it would remove the evidence needed to tell those apart.' }] });
    }
  }
  const allDiffs = [...diffs, ...removed];
  const counts = summarize(allDiffs);

  const columns = runColumns(run, { state: result.state, at });

  /*
   * ONE TRANSACTION from here to the audit event.
   *
   * The fetch row, the snapshot upserts and the change rows are one fact about one cycle, and a
   * crash between them would leave a snapshot that had moved on with nothing recording how. It
   * also makes the whole cycle atomic against a concurrent reader: a screen loading
   * `/work-packages` sees the state before this run or the state after it, never a half-applied
   * one where three activities have advanced and the rest have not.
   */
  const written = transact(db, () => {
    const fetchInfo = db.prepare(`INSERT INTO live_schedule_fetch (source_system, project_id, at,
        state, failure, http_status, reason, elapsed_ms, collection_total, records_received,
        records_new, records_changed, records_unchanged, actor, run_id, trigger, run_status,
        started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(SOURCE.system, String(projectId), at, result.state, result.failure ?? null,
        result.httpStatus ?? null, result.reason ?? null, result.elapsedMs ?? null,
        result.total ?? null, activities.length, counts.new, counts.changed, counts.unchanged, actor,
        columns.runId, columns.trigger, columns.runStatus, columns.startedAt, columns.finishedAt);
    const fetchId = Number(fetchInfo.lastInsertRowid);

    const upsert = db.prepare(SNAPSHOT_UPSERT);
    const logChange = db.prepare(`INSERT OR IGNORE INTO live_schedule_change (source_system,
        project_id, external_id, kind, field, previous_value, current_value, previous_revision,
        current_revision, previous_updated_at, current_updated_at, detected_at, fetch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    let changeRows = 0;
    for (const activity of activities) {
      if (!activity.externalActivityId) continue;
      const existing = previous.get(String(activity.externalActivityId));
      upsert.run(SOURCE.system, String(projectId), String(activity.externalActivityId),
        activity.activityName, activity.activityType, activity.status,
        activity.plannedStart, activity.plannedFinish, activity.reportedProgressPct,
        activity.estimatedTimeRaw, activity.estimatedHours,
        activity.remainingTimeRaw, activity.remainingHours,
        activity.parentExternalId, activity.sourceRevision, activity.sourceUpdatedAt,
        JSON.stringify(activity), existing?.first_seen_at ?? at, at, fetchId);
    }
    for (const diff of allDiffs) {
      for (const finding of diff.findings) {
        if (!eventful(finding.kind)) continue;
        const info = logChange.run(SOURCE.system, String(projectId), String(finding.externalId),
          finding.kind, finding.field ?? null, finding.previous ?? null, finding.current ?? null,
          finding.previousRevision ?? null, finding.currentRevision ?? null,
          finding.previousUpdatedAt ?? null, finding.currentUpdatedAt ?? null, at, fetchId);
        changeRows += info.changes;
      }
    }

    recordAudit(db, { actor, event: 'LIVE_SCHEDULE_READ', subject: `OPENPROJECT:${projectId}`,
      result: `${activities.length} work package(s) read; ${counts.new} new, `
        + `${counts.changed} changed, ${counts.unchanged} unchanged`,
      detail: { source: SOURCE.system, projectId: String(projectId), fetchId,
        state: result.state, collectionTotal: result.total ?? null,
        runId: columns.runId, trigger: columns.trigger, runStatus: columns.runStatus,
        byKind: counts.byKind, changeRowsWritten: changeRows,
        note: 'A READ of an external system. No synchronisation run was opened, no write-back was '
          + 'proposed, and no SYNCHRO 4D, P6, SAP or ACC record was created or updated.' } });

    return { fetchId, changeRows };
  });

  return { fetchId: written.fetchId, at, diffs: allDiffs, counts, changeRows: written.changeRows,
    runId: columns.runId, trigger: columns.trigger, runStatus: columns.runStatus };
}

/* ── one work package, cached without pretending a sync ran ───────────────────────────────── */

/**
 * The upsert, in ONE place.
 *
 * Phase 10B gave this table a second writer - a work package we just created - and two copies of
 * this statement would be two definitions of what a cached activity is. The conflict target is
 * the primary key, so the same work package arriving from a create and then again from the next
 * background sync is one row either way. That is what stops a created task from appearing twice.
 */
const SNAPSHOT_UPSERT = `INSERT INTO live_schedule_snapshot (source_system, project_id,
    external_id, activity_name, activity_type, status, planned_start, planned_finish,
    progress_pct, estimated_raw, estimated_hours, remaining_raw, remaining_hours,
    parent_external_id, source_revision, source_updated_at, payload, first_seen_at,
    last_seen_at, last_fetch_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT (source_system, project_id, external_id) DO UPDATE SET
     activity_name = excluded.activity_name, activity_type = excluded.activity_type,
     status = excluded.status, planned_start = excluded.planned_start,
     planned_finish = excluded.planned_finish, progress_pct = excluded.progress_pct,
     estimated_raw = excluded.estimated_raw, estimated_hours = excluded.estimated_hours,
     remaining_raw = excluded.remaining_raw, remaining_hours = excluded.remaining_hours,
     parent_external_id = excluded.parent_external_id,
     source_revision = excluded.source_revision,
     source_updated_at = excluded.source_updated_at, payload = excluded.payload,
     last_seen_at = excluded.last_seen_at, last_fetch_id = excluded.last_fetch_id`;

/**
 * Cache ONE work package that we have just read back from OpenProject.
 *
 * Deliberately NOT `applyFetch` with a one-element list. That function writes a
 * `live_schedule_fetch` row, and a fetch row saying "1 work package read" would misreport a
 * create as a synchronisation cycle and would make the next real cycle's "new / changed /
 * unchanged" counts measured against a snapshot that no sync produced. This writes the row and
 * nothing else, so the activity is visible immediately and the sync history stays truthful.
 *
 * No change rows either: the first sighting of a work package is not a change to one.
 */
export function cacheActivity(db, { projectId, activity, actor = 'Demo operator',
  at = new Date().toISOString() }) {
  if (!activity?.externalActivityId) return { ok: false, error: 'The activity has no id.' };
  const externalId = String(activity.externalActivityId);
  /*
   * `undefined` is not a SQLite value and binding one throws.
   *
   * `applyFetch` never meets this because every row it writes came through
   * `normalizeWorkPackage`, which fills each field. This function is also fed activities found by
   * a marker search during reconciliation, and a field absent there is "not known", which is
   * null - not a reason to abandon caching a work package that demonstrably exists.
   */
  const value = key => (activity[key] === undefined ? null : activity[key]);
  return transact(db, () => {
    const existing = db.prepare(`SELECT first_seen_at FROM live_schedule_snapshot
       WHERE source_system = ? AND project_id = ? AND external_id = ?`)
      .get(SOURCE.system, String(projectId), externalId);
    db.prepare(SNAPSHOT_UPSERT).run(SOURCE.system, String(projectId), externalId,
      value('activityName'), value('activityType'), value('status'),
      value('plannedStart'), value('plannedFinish'), value('reportedProgressPct'),
      value('estimatedTimeRaw'), value('estimatedHours'),
      value('remainingTimeRaw'), value('remainingHours'),
      value('parentExternalId'), value('sourceRevision'), value('sourceUpdatedAt'),
      JSON.stringify(activity), existing?.first_seen_at ?? at, at, null);
    return { ok: true, externalId, firstSeen: !existing };
  });
}

/* ── the candidate link to a synthetic P6 activity ─────────────────────────────────────────── */

/**
 * Propose a link. Never applies one.
 *
 * `basis` and `evidence` are stored because a link that cannot say why it was proposed is a link
 * nobody can review. A name match is recorded AS a name match — weak evidence, named as weak —
 * rather than presented as an identification.
 */
export function proposeLink(db, {
  projectId, externalId, targetActivityId, targetSystem = 'P6', basis, evidence = null,
  actor = 'Integration service',
}) {
  const at = nowIso();
  const existing = db.prepare(`SELECT * FROM live_schedule_link
     WHERE source_system = ? AND project_id = ? AND external_id = ? AND target_system = ?
       AND target_activity_id = ?`)
    .get(SOURCE.system, String(projectId), String(externalId), targetSystem,
      String(targetActivityId));
  if (existing) return { ok: true, created: false, link: shapeLink(existing) };

  const info = db.prepare(`INSERT INTO live_schedule_link (source_system, project_id, external_id,
      target_system, target_activity_id, status, basis, evidence, proposed_at, proposed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(SOURCE.system, String(projectId), String(externalId), targetSystem,
      String(targetActivityId), MAPPING.PROPOSED, basis,
      evidence == null ? null : JSON.stringify(evidence), at, actor);
  recordAudit(db, { actor, event: 'LIVE_SCHEDULE_LINK_PROPOSED',
    subject: `OPENPROJECT:${externalId}`, next: MAPPING.PROPOSED,
    result: `Candidate ${targetSystem} ${targetActivityId}`,
    detail: { basis, evidence,
      note: 'A proposal only. Nothing is compared and no synthetic record is altered until a '
        + 'reviewer approves it.' } });
  return { ok: true, created: true,
    link: shapeLink(db.prepare('SELECT * FROM live_schedule_link WHERE id = ?')
      .get(Number(info.lastInsertRowid))) };
}

/** Approve or reject a proposed link. The decision and who made it are both stored. */
export function decideLink(db, { linkId, decision, actor, note = null }) {
  if (decision !== MAPPING.APPROVED && decision !== MAPPING.REJECTED) {
    return { ok: false, error: `A link decision must be ${MAPPING.APPROVED} or ${MAPPING.REJECTED}.` };
  }
  const row = db.prepare('SELECT * FROM live_schedule_link WHERE id = ?').get(Number(linkId));
  if (!row) return { ok: false, error: `No candidate link with id ${linkId}.` };
  if (row.status !== MAPPING.PROPOSED) {
    return { ok: false,
      error: `That link is ${row.status}, not ${MAPPING.PROPOSED}, so it cannot be decided again.` };
  }
  const at = nowIso();
  db.prepare(`UPDATE live_schedule_link SET status = ?, decided_at = ?, decided_by = ?,
      decision_note = ? WHERE id = ?`)
    .run(decision, at, actor, note, Number(linkId));
  recordAudit(db, { actor, event: 'LIVE_SCHEDULE_LINK_DECIDED',
    subject: `OPENPROJECT:${row.external_id}`, previous: MAPPING.PROPOSED, next: decision,
    result: `${decision} for ${row.target_system} ${row.target_activity_id}`,
    detail: { note,
      warning: 'Approval unlocks a READ-ONLY comparison. No synthetic P6 progress is written, and '
        + 'no value is copied in either direction.' } });
  return { ok: true, link: shapeLink(db.prepare('SELECT * FROM live_schedule_link WHERE id = ?')
    .get(Number(linkId))) };
}

const shapeLink = row => (!row ? null : {
  id: row.id,
  externalId: row.external_id,
  targetSystem: row.target_system,
  targetActivityId: row.target_activity_id,
  status: row.status,
  basis: row.basis,
  evidence: row.evidence == null ? null : JSON.parse(row.evidence),
  proposedAt: row.proposed_at,
  proposedBy: row.proposed_by,
  decidedAt: row.decided_at,
  decidedBy: row.decided_by,
  decisionNote: row.decision_note,
});

/** Every candidate link for a project. */
export function links(db, projectId) {
  return db.prepare(`SELECT * FROM live_schedule_link
     WHERE source_system = ? AND project_id = ? ORDER BY id`)
    .all(SOURCE.system, String(projectId)).map(shapeLink);
}

export { shapeLink };
