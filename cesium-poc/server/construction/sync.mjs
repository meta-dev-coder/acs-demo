/**
 * The inbound synchronisation engine.
 *
 * IDEMPOTENT BY KEY, not by timestamp. Every normalized row is keyed on
 * `(source_system, source_id)` — the identifier the source system itself publishes — so running a
 * sync twice updates the same rows rather than creating a second set. A row whose payload has not
 * changed is counted as `unchanged` and its `synced_at` is left alone, which is what makes "has
 * anything actually moved since Tuesday?" an answerable question.
 *
 * NOTHING IS RECORDED THAT DID NOT HAPPEN. A `sync_run` row is opened when a run starts and closed
 * when it ends, with the counts the upserts actually returned. A run that throws is closed as
 * FAILED with its error rows written. There is no code path that writes a successful run without
 * one having occurred, and the seed writes none at all.
 *
 * It knows nothing about P6, ACC or SAP: an adapter hands it batches naming a normalized entity,
 * and this upserts them.
 */
import { DIRECTION, INTERFACES, interfaceById, WRITE_BACK_STATUS } from './adapters.mjs';
import { PROJECT, SEEDED_SCENARIOS } from './seed.mjs';

export const RUN_STATUS = Object.freeze({
  RUNNING: 'RUNNING', SUCCESS: 'SUCCESS', PARTIAL: 'PARTIAL', FAILED: 'FAILED',
});

export const SEVERITY = Object.freeze({ ERROR: 'ERROR', WARNING: 'WARNING' });

/** The columns each normalized entity carries, besides the bookkeeping every one of them has. */
const ENTITY_COLUMNS = Object.freeze({
  wbs: ['parent_source_id', 'name', 'level'],
  activity: ['wbs_code', 'name', 'calendar', 'planned_start', 'planned_finish', 'baseline_start',
    'baseline_finish', 'actual_start', 'actual_finish', 'pct_complete', 'remaining_duration', 'data_date'],
  model_version: ['model_name', 'version', 'published_at', 'state'],
  element: ['model_version_id', 'category', 'level', 'zone', 'discipline', 'work_package',
    'quantity', 'unit', 'activity_ref', 'boq_ref'],
  boq_item: ['description', 'sap_wbs_code', 'quantity', 'unit', 'unit_rate'],
  cost: ['budget', 'planned_cost', 'actual_cost', 'currency'],
});

export const INBOUND_INTERFACES = Object.freeze(
  INTERFACES.filter(entry => entry.direction === DIRECTION.INBOUND).map(entry => entry.id));

const nowIso = () => new Date().toISOString();

/**
 * The audit trail. Written by whatever actually happened, never in advance.
 *
 * `subject`, `previous`, `next`, `result` and `correlationId` are COLUMNS rather than keys inside
 * `detail`, so the trail can be filtered by record and the before/after shown without the reader
 * parsing JSON. Anything absent stays null and is drawn as "Not recorded" — never guessed.
 */
export function recordAudit(db, {
  actor, event, interfaceId = null, syncRunId = null, detail = null, at = nowIso(),
  subject = null, previous = null, next = null, result = null, correlationId = null,
}) {
  const text = value => (value == null ? null
    : typeof value === 'object' ? JSON.stringify(value) : String(value));
  db.prepare(`INSERT INTO audit_event (at, actor, event, interface_id, sync_run_id, detail,
      subject_id, previous_state, new_state, result, correlation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(at, actor, event, interfaceId, syncRunId,
      detail == null ? null : JSON.stringify(detail),
      text(subject), text(previous), text(next), text(result), text(correlationId));
}

/** Is this row different from the one already stored? Compared field by field, never by clock. */
function changed(existing, record, columns) {
  if (!existing) return true;
  if (Number(existing.source_rev ?? 1) !== Number(record.source_rev ?? 1)) return true;
  return columns.some(column => {
    const before = existing[column] ?? null;
    const after = record[column] ?? null;
    // SQLite gives numbers back as numbers; compare loosely so 80 and 80.0 are one value.
    if (typeof before === 'number' || typeof after === 'number') return Number(before) !== Number(after);
    return String(before) !== String(after);
  });
}

/**
 * Write one batch.
 *
 * @returns {{read, created, updated, unchanged, skipped, errors}}
 */
export function upsertBatch(db, { entity, records }, { system, syncRunId, at = nowIso() }) {
  const columns = ENTITY_COLUMNS[entity];
  if (!columns) throw new Error(`Unknown entity "${entity}"`);
  const all = [...columns, 'source_rev', 'synced_at', 'sync_run_id'];
  const select = db.prepare(`SELECT * FROM ${entity} WHERE source_system = ? AND source_id = ?`);
  const insert = db.prepare(
    `INSERT INTO ${entity} (source_system, source_id, ${all.join(', ')})
     VALUES (?, ?, ${all.map(() => '?').join(', ')})`);
  const update = db.prepare(
    `UPDATE ${entity} SET ${all.map(column => `${column} = ?`).join(', ')}
     WHERE source_system = ? AND source_id = ?`);

  const counts = { read: 0, created: 0, updated: 0, unchanged: 0, skipped: 0 };
  const errors = [];
  for (const record of records) {
    counts.read += 1;
    if (!record.source_id) {
      counts.skipped += 1;
      errors.push({ severity: SEVERITY.ERROR, record_ref: null,
        message: `${entity}: a record arrived with no source identifier and was not stored.` });
      continue;
    }
    try {
      const existing = select.get(system, String(record.source_id));
      if (!changed(existing, record, columns)) { counts.unchanged += 1; continue; }
      const values = [...columns.map(column => record[column] ?? null),
        Number(record.source_rev ?? 1), at, syncRunId];
      if (existing) { update.run(...values, system, String(record.source_id)); counts.updated += 1; }
      else { insert.run(system, String(record.source_id), ...values); counts.created += 1; }
    } catch (error) {
      counts.skipped += 1;
      errors.push({ severity: SEVERITY.ERROR, record_ref: String(record.source_id),
        message: `${entity} ${record.source_id}: ${error?.message ?? error}` });
    }
  }
  return { ...counts, errors };
}

/**
 * Run one inbound interface.
 *
 * Everything is inside one transaction: a run either lands completely or not at all, so a failure
 * halfway through cannot leave the normalized side holding part of a batch.
 */
export function runInterface(db, adapter, { actor = 'Demo operator', now = nowIso } = {}) {
  const definition = interfaceById(adapter.interfaceId);
  if (!definition) throw new Error(`Unknown interface ${adapter.interfaceId}`);
  if (definition.direction === DIRECTION.OUTBOUND) {
    // Said out loud rather than skipped quietly: an outbound interface has an approval gate and no
    // write-back until Phase 5, and a caller asking for one deserves to be told that.
    throw new Error(`${definition.id} is outbound and approval-controlled. ${adapter.writeBack.reason}`);
  }

  const startedAt = now();
  const runId = db.prepare(
    'INSERT INTO sync_run (interface_id, started_at, status, actor) VALUES (?, ?, ?, ?)')
    .run(definition.id, startedAt, RUN_STATUS.RUNNING, actor).lastInsertRowid;

  const totals = { records_read: 0, records_created: 0, records_updated: 0,
    records_unchanged: 0, records_skipped: 0 };
  const errors = [];
  let status = RUN_STATUS.SUCCESS;

  db.exec('BEGIN');
  try {
    for (const batch of adapter.fetch()) {
      const result = upsertBatch(db, batch, { system: adapter.system, syncRunId: runId, at: startedAt });
      totals.records_read += result.read;
      totals.records_created += result.created;
      totals.records_updated += result.updated;
      totals.records_unchanged += result.unchanged;
      totals.records_skipped += result.skipped;
      errors.push(...result.errors);
    }
    if (errors.length) status = RUN_STATUS.PARTIAL;
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    status = RUN_STATUS.FAILED;
    errors.push({ severity: SEVERITY.ERROR, record_ref: null,
      message: `${definition.id} failed and nothing was written: ${error?.message ?? error}` });
  }

  const finishedAt = now();
  const writeError = db.prepare(
    'INSERT INTO sync_error (sync_run_id, interface_id, severity, record_ref, message, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const entry of errors) {
    writeError.run(runId, definition.id, entry.severity, entry.record_ref, entry.message, finishedAt);
  }
  db.prepare(`UPDATE sync_run SET finished_at = ?, status = ?, records_read = ?, records_created = ?,
      records_updated = ?, records_unchanged = ?, records_skipped = ?, error_count = ? WHERE id = ?`)
    .run(finishedAt, status, totals.records_read, totals.records_created, totals.records_updated,
      totals.records_unchanged, totals.records_skipped, errors.length, runId);

  recordAudit(db, { at: finishedAt, actor, event: 'SYNC_RUN', interfaceId: definition.id,
    syncRunId: Number(runId), subject: definition.id, result: status,
    detail: { status, ...totals, errors: errors.length } });

  return Object.freeze({ runId: Number(runId), interfaceId: definition.id, status,
    startedAt, finishedAt, ...totals, errors: Object.freeze(errors) });
}

/** Run every inbound interface, in the order the pilot numbers them. */
export function runInboundSync(db, adapters, { actor = 'Demo operator', only = null, now = nowIso } = {}) {
  const wanted = only
    ? [only].flat().filter(id => INBOUND_INTERFACES.includes(id))
    : INBOUND_INTERFACES;
  if (only && !wanted.length) {
    throw new Error(`No inbound interface matches ${[only].flat().join(', ')}. `
      + `The inbound interfaces are ${INBOUND_INTERFACES.join(', ')}.`);
  }
  return wanted.map(id => runInterface(db, adapters.get(id), { actor, now }));
}

/* ── what the Integration Overview reads ───────────────────────────────────────────────────── */

const ENTITY_FOR = Object.freeze({
  'INT-01': ['wbs', 'activity'],
  'INT-03': ['model_version', 'element'],
  'INT-04': ['wbs', 'cost', 'boq_item'],
});

/** The latest run of each interface, whatever its status. */
export function latestRuns(db) {
  return new Map(db.prepare(`SELECT r.* FROM sync_run r
      JOIN (SELECT interface_id, MAX(id) AS id FROM sync_run GROUP BY interface_id) latest
        ON latest.id = r.id`).all().map(row => [row.interface_id, row]));
}

/**
 * The Integration Overview, derived entirely from what is in the database.
 *
 * An interface that has never run says so. There is no default timestamp, no assumed health and
 * no count that is not a `COUNT(*)`.
 */
export function overview(db, { adapters = null } = {}) {
  const runs = latestRuns(db);
  const lastSuccess = new Map(db.prepare(
    `SELECT interface_id, MAX(finished_at) AS at FROM sync_run
      WHERE status IN ('SUCCESS', 'PARTIAL') GROUP BY interface_id`).all()
    .map(row => [row.interface_id, row.at]));
  const openErrors = new Map(db.prepare(
    'SELECT interface_id, COUNT(*) AS n FROM sync_error GROUP BY interface_id').all()
    .map(row => [row.interface_id, row.n]));

  /** The outbound queues, so the two write-back cards report their real state. */
  const outboundCounts = new Map(db.prepare(
    `SELECT interface_id,
            SUM(status = 'PENDING_APPROVAL') AS pending,
            SUM(status = 'APPROVED') AS approved,
            SUM(status = 'POSTED') AS posted,
            SUM(status = 'HELD') AS held,
            SUM(status = 'FAILED') AS failed,
            MAX(CASE WHEN status = 'POSTED' THEN posted_at END) AS lastPostedAt
       FROM outbound_proposal GROUP BY interface_id`).all()
    .map(row => [row.interface_id, row]));

  const interfaces = INTERFACES.map(definition => {
    const run = runs.get(definition.id) ?? null;
    const outbound = definition.direction === DIRECTION.OUTBOUND;
    const queue = outbound ? outboundCounts.get(definition.id) ?? null : null;
    return {
      ...definition,
      /** Four states, and "never run" is one of them rather than a zero. */
      health: outbound
        ? (queue?.failed ? 'FAILED'
          : queue?.held ? 'PARTIAL'
            : queue?.pending || queue?.approved ? 'AWAITING_APPROVAL'
              : queue?.posted ? 'HEALTHY' : 'NOTHING_PROPOSED')
        : !run ? 'NEVER_RUN'
          : run.status === RUN_STATUS.SUCCESS ? 'HEALTHY'
            : run.status === RUN_STATUS.PARTIAL ? 'PARTIAL' : 'FAILED',
      lastRunStatus: run?.status ?? null,
      lastSuccessAt: lastSuccess.get(definition.id) ?? null,
      recordsRead: run?.records_read ?? null,
      recordsCreated: run?.records_created ?? null,
      recordsUpdated: run?.records_updated ?? null,
      recordsUnchanged: run?.records_unchanged ?? null,
      errorCount: openErrors.get(definition.id) ?? 0,
      /** Phase 5. Stated per interface so the screen never has to assume it. */
      writeBack: outbound ? adapters?.get(definition.id)?.writeBack ?? null : null,
      pendingApprovals: outbound ? queue?.pending ?? 0 : null,
      approvedNotPosted: outbound ? queue?.approved ?? 0 : null,
      postedCount: outbound ? queue?.posted ?? 0 : null,
      heldCount: outbound ? queue?.held ?? 0 : null,
      lastRunAt: outbound ? queue?.lastPostedAt ?? null : run?.finished_at ?? null,
      entities: ENTITY_FOR[definition.id] ?? [],
      adapter: adapters?.get(definition.id)?.describe?.() ?? null,
    };
  });

  const count = table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return {
    project: PROJECT,
    synthetic: true,
    interfaces,
    /**
     * Carried by every caller, not only `GET /overview`.
     *
     * It used to be added by that one route, so the screen's "deliberate inconsistencies" panel
     * vanished the moment a sync returned a fresh overview — and a reader would reasonably have
     * concluded the seeded flaws had been fixed by syncing.
     */
    seededScenarios: SEEDED_SCENARIOS,
    writeBack: WRITE_BACK_STATUS,
    totals: {
      wbs: count('wbs'), activities: count('activity'), modelVersions: count('model_version'),
      elements: count('element'), boqItems: count('boq_item'), costRecords: count('cost'),
      syncRuns: count('sync_run'), errors: count('sync_error'), auditEvents: count('audit_event'),
    },
    /** What the mock source systems hold, so "did everything arrive?" is answerable. */
    source: {
      wbs: count('src_p6_wbs'), activities: count('src_p6_activity'),
      modelVersions: count('src_acc_model_version'), elements: count('src_acc_element'),
      sapWbs: count('src_sap_wbs'), boqItems: count('src_sap_boq'), costRecords: count('src_sap_cost'),
    },
    generatedAt: nowIso(),
  };
}
