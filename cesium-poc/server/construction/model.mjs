/**
 * The 3D model the viewer draws, and the draft P6 update.
 *
 * EVERY BOX IS A DATABASE ROW. The viewer is handed element ids with their stored geometry; it
 * never generates a shape of its own, so anything that can be clicked resolves to a record.
 *
 * Planned and actual are two separate flags on each element, not one blended state. "Scheduled to
 * be built by this date" comes from the activity's planned dates; "actually built" comes from a
 * verified observation. A date alone never makes an element built.
 */
import { activityProgress, plannedAt, verifiedObservations } from './progress.mjs';

/**
 * The model, optionally as at a date.
 *
 * @param {{onDate?, level?, zone?, discipline?, category?, activityId?}} filters
 */
export function buildModel(db, filters = {}) {
  const where = ["e.source_system = 'ACC'"];
  const params = [];
  const add = (sql, value) => { if (value) { where.push(sql); params.push(value); } };
  add('e.level = ?', filters.level);
  add('e.zone = ?', filters.zone);
  add('e.discipline = ?', filters.discipline);
  add('e.category = ?', filters.category);
  add('m.activity_id = ?', filters.activityId);

  const rows = db.prepare(
    `SELECT e.source_id AS elementId, e.category, e.level, e.zone, e.discipline,
            e.quantity, e.unit, m.activity_id AS activityId, m.p6_wbs_code AS wbs,
            m.boq_code AS boq, m.status AS mappingStatus,
            g.x, g.y, g.z, g.sx, g.sy, g.sz, g.level_index AS levelIndex, g.zone_index AS zoneIndex
       FROM element e
       JOIN element_geometry g ON g.element_id = e.source_id
       LEFT JOIN mapping m ON m.element_id = e.source_id
      WHERE ${where.join(' AND ')} ORDER BY e.source_id`).all(...params);

  const onDate = filters.onDate ?? null;
  const activities = new Map(db.prepare(
    "SELECT source_id, planned_start, planned_finish FROM activity WHERE source_system = 'P6'").all()
    .map(row => [row.source_id, row]));
  // One read of the verified set, rather than one per element.
  const verified = new Set(db.prepare(
    `SELECT element_id FROM progress_observation WHERE status = 'VERIFIED'
      ${onDate ? 'AND observed_on <= ?' : ''}`).all(...(onDate ? [onDate] : []))
    .map(row => row.element_id));

  const elements = rows.map(row => {
    const activity = row.activityId ? activities.get(row.activityId) ?? null : null;
    const planned = activity && onDate ? plannedAt(activity, onDate) : null;
    return {
      ...row,
      /** Scheduled to have been built by this date. A schedule expectation, not a fact. */
      plannedBuilt: onDate ? Boolean(activity && planned != null && planned >= 100) : null,
      plannedPct: planned,
      /** Verified built. Evidence, and the only thing that makes an element actually built. */
      actualBuilt: verified.has(row.elementId),
      unmapped: !row.activityId,
    };
  });

  return {
    onDate,
    elements,
    counts: {
      total: elements.length,
      plannedBuilt: onDate ? elements.filter(entry => entry.plannedBuilt).length : null,
      actualBuilt: elements.filter(entry => entry.actualBuilt).length,
      unmapped: elements.filter(entry => entry.unmapped).length,
    },
    note: 'Geometry is synthetic and generated from each element’s own level, zone and '
      + 'category. Every box corresponds to a row in the element table.',
  };
}

/** What the toolbar filters by, and the timeline's own bounds. All read from the data. */
export function modelFacets(db) {
  const distinct = column => db.prepare(
    `SELECT DISTINCT ${column} AS value FROM element WHERE source_system = 'ACC'
       AND ${column} IS NOT NULL ORDER BY ${column}`).all().map(row => row.value);
  const span = db.prepare(
    `SELECT MIN(planned_start) AS from_, MAX(planned_finish) AS to_
       FROM activity WHERE source_system = 'P6'`).get();
  return {
    level: distinct('level'),
    zone: distinct('zone'),
    discipline: distinct('discipline'),
    category: distinct('category'),
    timeline: { from: span.from_, to: span.to_ },
    dataDate: db.prepare("SELECT data_date FROM activity WHERE source_system = 'P6' LIMIT 1")
      .get()?.data_date ?? null,
  };
}

/* ── the draft P6 update ───────────────────────────────────────────────────────────────────── */

/**
 * Prepare an update for P6 from the verified evidence. A DRAFT, and only that.
 *
 * There is no approval here and no write-back: both are Phase 5. The row records what WOULD be
 * proposed, the evidence behind it and the source revision it was prepared against, so Phase 5's
 * conflict check has something to compare with.
 */
export function prepareP6Draft(db, activityId, {
  actor = 'Demo operator', now = () => new Date().toISOString(),
} = {}) {
  const activity = db.prepare(
    "SELECT * FROM activity WHERE source_system = 'P6' AND source_id = ?").get(String(activityId ?? ''));
  if (!activity) return { ok: false, error: `There is no activity ${activityId}.` };

  const progress = activityProgress(db, activity.source_id);
  if (progress.verifiedPct == null) {
    return { ok: false,
      error: `${activity.source_id} has no verified progress to propose: ${progress.unavailable}` };
  }
  const observations = verifiedObservations(db, activity.source_id);
  const span = (Date.parse(`${activity.planned_finish}T00:00:00Z`)
    - Date.parse(`${activity.planned_start}T00:00:00Z`)) / 86400000;
  const remaining = Number.isFinite(span)
    ? Number((span * (1 - progress.verifiedPct / 100)).toFixed(1)) : null;
  const at = now();

  const id = db.prepare(
    `INSERT INTO p6_update_draft (activity_id, current_pct, proposed_pct, actual_start,
        actual_finish, remaining_duration, evidence, source_rev, validation_status, status,
        created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?)`)
    .run(activity.source_id, activity.pct_complete, progress.verifiedPct,
      observations[0]?.observed_on ?? activity.actual_start,
      // An actual finish only where the work is actually finished. A date is not a completion.
      progress.verifiedPct >= 100 ? observations[observations.length - 1]?.observed_on ?? null : null,
      remaining,
      JSON.stringify({
        rule: progress.rule, ruleNote: progress.ruleNote,
        verifiedElements: progress.verifiedElements, totalElements: progress.totalElements,
        observations: observations.map(entry => ({ element: entry.element_id,
          observedOn: entry.observed_on, evidence: entry.evidence_ref, reviewer: entry.reviewer })),
        /* Said explicitly: drafts were seen and deliberately left out of the figure. */
        draftObservationsExcluded: progress.draftObservations,
      }),
      `a${activity.source_rev}`,
      progress.unavailable ? `INCOMPLETE: ${progress.unavailable}` : 'VALIDATED',
      at, actor).lastInsertRowid;

  return {
    ok: true,
    draft: readDraft(db, id),
    note: 'Draft only. Nothing has been posted to P6. Raise it as an INT-02 proposal in the '
      + 'Approval Center, where the planner must approve it before the simulated write-back runs.',
  };
}

const readDraft = (db, id) => {
  const row = db.prepare('SELECT * FROM p6_update_draft WHERE id = ?').get(id);
  return row ? { ...row, evidence: row.evidence ? JSON.parse(row.evidence) : null } : null;
};

export function listDrafts(db, { activityId = null, limit = 100 } = {}) {
  const clause = activityId ? 'WHERE activity_id = ?' : '';
  const params = activityId ? [activityId] : [];
  const capped = Math.min(200, Math.max(1, Number(limit) || 100));
  return db.prepare(`SELECT * FROM p6_update_draft ${clause} ORDER BY id DESC LIMIT ?`)
    .all(...params, capped)
    .map(row => ({ ...row, evidence: row.evidence ? JSON.parse(row.evidence) : null }));
}
