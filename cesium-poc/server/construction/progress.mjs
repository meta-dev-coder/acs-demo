/**
 * Progress, variance and earned value — calculated, never assumed.
 *
 * THREE DISTINCTIONS THIS FILE EXISTS TO KEEP:
 *
 *  1. PLANNED IS A CLAIM, VERIFIED IS EVIDENCE. `activity.pct_complete` is what P6 says; actual
 *     progress comes only from VERIFIED observations. A draft observation is somebody's note and
 *     is never counted. The two are reported side by side and never merged.
 *
 *  2. A MEASUREMENT RULE IS DECLARED, NOT GUESSED. Equal-weight element counting is only right
 *     where the elements are comparable, so it applies only where `measurement_rule` says so.
 *
 *  3. A MISSING FIGURE IS NOT A ZERO. Where the BOQ mapping or the approved rate is absent, the
 *     money is `null` with a reason, so a screen prints "Not available — mapping incomplete"
 *     rather than a confident nothing.
 *
 * Nothing here writes. It reads the normalized records, the mapping layer and the observations.
 */
import { RULE } from './progressSeed.mjs';

/** Why a figure could not be produced. Carried instead of the figure. */
export const UNAVAILABLE = Object.freeze({
  NO_RULE: 'No measurement rule is configured for this activity.',
  NOT_MEASURABLE: 'Not available — no linked element or approved quantity to measure against.',
  NO_BOQ: 'Not available — mapping incomplete. No BOQ item is mapped, so there is no approved rate.',
  NO_BUDGET: 'Not available — SAP publishes no budget for this WBS.',
});

const round = (value, places = 1) =>
  (value == null || !Number.isFinite(value) ? null : Number(value.toFixed(places)));

/**
 * Planned progress at a date, from the activity's own planned dates.
 *
 * Straight-line between planned start and finish. It is a SCHEDULE expectation, not a claim about
 * the building, and it is labelled as such everywhere it is shown.
 */
export function plannedAt(activity, onDate) {
  const start = Date.parse(`${activity.planned_start}T00:00:00Z`);
  const finish = Date.parse(`${activity.planned_finish}T00:00:00Z`);
  const at = Date.parse(`${onDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || !Number.isFinite(at)) return null;
  if (at <= start) return 0;
  if (at >= finish) return 100;
  return round(((at - start) / (finish - start)) * 100);
}

/**
 * The verified observations for one activity. Only VERIFIED; a draft is not evidence.
 *
 * ONE PER ELEMENT, the latest. An element can be observed more than once — re-inspected, or
 * recorded twice — and counting the rows rather than the elements reported an activity as 70%
 * built when 13 of its 20 elements were. Progress is a count of things built, not of notes taken.
 */
export function verifiedObservations(db, activityId, { onOrBefore = null } = {}) {
  const clause = onOrBefore ? ' AND observed_on <= ?' : '';
  const params = onOrBefore ? [activityId, onOrBefore] : [activityId];
  const rows = db.prepare(
    `SELECT * FROM progress_observation WHERE activity_id = ? AND status = 'VERIFIED'${clause}
      ORDER BY observed_on, id`).all(...params);
  const latest = new Map();
  const unattached = [];
  for (const row of rows) {
    if (!row.element_id) { unattached.push(row); continue; }
    latest.set(row.element_id, row);
  }
  return [...latest.values(), ...unattached]
    .sort((a, b) => String(a.observed_on).localeCompare(String(b.observed_on)) || a.id - b.id);
}

/**
 * The two variances, which answer different questions and must not be collapsed.
 *
 *   variancePct               verified against WHAT P6 CLAIMS. This is the business question —
 *                             A-1020 reports 80% and 60% is verified, so -20 points.
 *   scheduleLineVariancePct   verified against where the straight-line schedule says the work
 *                             should be on this date. Useful, and a different thing entirely:
 *                             an activity whose planned finish has passed is at 100% on that line
 *                             whatever P6 reports.
 */
function variances(verifiedPct, plannedPct, activity) {
  const round1 = value => (value == null ? null : Number(value.toFixed(1)));
  return {
    variancePct: verifiedPct == null || activity.pct_complete == null
      ? null : round1(verifiedPct - activity.pct_complete),
    scheduleLineVariancePct: verifiedPct == null || plannedPct == null
      ? null : round1(verifiedPct - plannedPct),
  };
}

/**
 * One activity's progress, by its own declared rule.
 *
 * @returns {{rule, plannedPct, verifiedPct, variancePct, measured, total, unit, unavailable}}
 */
export function activityProgress(db, activityId, { onDate = null } = {}) {
  const activity = db.prepare(
    "SELECT * FROM activity WHERE source_system = 'P6' AND source_id = ?").get(activityId);
  if (!activity) return null;
  const ruleRow = db.prepare('SELECT * FROM measurement_rule WHERE activity_id = ?').get(activityId);
  const rule = ruleRow?.rule ?? RULE.NOT_MEASURABLE;
  const at = onDate ?? activity.data_date;

  const elements = db.prepare(
    `SELECT m.element_id, m.boq_code, e.quantity, e.unit FROM mapping m
       JOIN element e ON e.source_id = m.element_id
      WHERE m.activity_id = ? ORDER BY m.element_id`).all(activityId);
  const observations = verifiedObservations(db, activityId, { onOrBefore: at });
  const draft = db.prepare(
    "SELECT COUNT(*) AS n FROM progress_observation WHERE activity_id = ? AND status <> 'VERIFIED'")
    .get(activityId).n;

  const planned = plannedAt(activity, at);
  const base = {
    activityId,
    name: activity.name,
    rule,
    ruleNote: ruleRow?.note ?? UNAVAILABLE.NO_RULE,
    /** What P6 itself claims. Reported beside the evidence, never instead of it. */
    p6ReportedPct: activity.pct_complete,
    plannedPct: planned,
    totalElements: elements.length,
    verifiedElements: observations.filter(entry => entry.element_id).length,
    draftObservations: draft,
    plannedStart: activity.planned_start,
    plannedFinish: activity.planned_finish,
    actualStart: activity.actual_start,
    actualFinish: activity.actual_finish,
    remainingDuration: activity.remaining_duration,
    onDate: at,
  };

  if (rule === RULE.EQUAL_WEIGHT_ELEMENTS) {
    const verifiedPct = elements.length
      ? round((base.verifiedElements / elements.length) * 100) : null;
    return Object.freeze({ ...base, verifiedPct, ...variances(verifiedPct, planned, activity),
      measured: base.verifiedElements, total: elements.length, unit: 'elements',
      unavailable: elements.length ? null : UNAVAILABLE.NOT_MEASURABLE });
  }

  if (rule === RULE.QUANTITY) {
    const totalQuantity = elements.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
    const doneQuantity = observations.reduce((sum, row) => sum + (Number(row.verified_quantity) || 0), 0);
    const verifiedPct = totalQuantity > 0 ? round((doneQuantity / totalQuantity) * 100) : null;
    return Object.freeze({ ...base, verifiedPct, ...variances(verifiedPct, planned, activity),
      measured: round(doneQuantity, 2), total: round(totalQuantity, 2),
      unit: elements[0]?.unit ?? null,
      unavailable: totalQuantity > 0 ? null
        : 'Not available — no approved quantity is recorded on the linked elements.' });
  }

  return Object.freeze({ ...base, verifiedPct: null, variancePct: null,
    scheduleLineVariancePct: null,
    measured: null, total: null, unit: null, unavailable: UNAVAILABLE.NOT_MEASURABLE });
}

/**
 * The money for one activity.
 *
 * Earned value is Σ(verified quantity × the BOQ's approved unit rate) over the elements that
 * actually have a BOQ item. Where none has, there is no rate and no earned value — stated as an
 * absence rather than as zero. Actual cost is SAP's, and is never confused with earned value:
 * one is what the work is worth, the other is what has been spent.
 */
export function activityValue(db, activityId) {
  const activity = db.prepare(
    "SELECT * FROM activity WHERE source_system = 'P6' AND source_id = ?").get(activityId);
  if (!activity) return null;

  const priced = db.prepare(
    `SELECT m.element_id, b.source_id AS boq_code, b.unit, b.unit_rate, e.quantity
       FROM mapping m JOIN element e ON e.source_id = m.element_id
       JOIN boq_item b ON b.source_id = m.boq_code
      WHERE m.activity_id = ? ORDER BY m.element_id`).all(activityId);
  const total = db.prepare('SELECT COUNT(*) AS n FROM mapping WHERE activity_id = ?')
    .get(activityId).n;
  const verified = new Map(verifiedObservations(db, activityId)
    .filter(entry => entry.element_id).map(entry => [entry.element_id, entry]));

  // SAP's own ledger for the WBS this activity sits under. It is the WBS's, not the activity's,
  // and the response says so rather than implying the activity spent it.
  const cost = db.prepare("SELECT * FROM cost WHERE source_system = 'SAP' AND source_id = ?")
    .get(activity.wbs_code) ?? null;

  if (!priced.length) {
    return Object.freeze({
      activityId,
      boqItems: [],
      budgetValueUSD: null, earnedValueUSD: null,
      currency: cost?.currency ?? null,
      wbsActualCostUSD: cost?.actual_cost ?? null,
      wbsBudgetUSD: cost?.budget ?? null,
      wbsCode: activity.wbs_code,
      unavailable: total ? UNAVAILABLE.NO_BOQ
        : 'Not available — mapping incomplete. No element is linked to this activity.',
      pricedElements: 0, totalElements: total,
    });
  }

  let budgetValue = 0;
  let earnedValue = 0;
  for (const row of priced) {
    const quantity = Number(row.quantity) || 0;
    budgetValue += quantity * row.unit_rate;
    const observation = verified.get(row.element_id);
    if (observation) earnedValue += (Number(observation.verified_quantity) || quantity) * row.unit_rate;
  }
  const items = [...new Map(priced.map(row => [row.boq_code,
    { code: row.boq_code, unit: row.unit, unitRate: row.unit_rate }])).values()];

  return Object.freeze({
    activityId,
    boqItems: items,
    /** What the linked work is worth at the approved rates. */
    budgetValueUSD: Math.round(budgetValue),
    /** What has been verified built, at those same rates. */
    earnedValueUSD: Math.round(earnedValue),
    currency: cost?.currency ?? null,
    /** SAP's figure for the WHOLE WBS. Not this activity's spend, and not earned value. */
    wbsActualCostUSD: cost?.actual_cost ?? null,
    wbsBudgetUSD: cost?.budget ?? null,
    wbsCode: activity.wbs_code,
    pricedElements: priced.length,
    totalElements: total,
    // Partial pricing is reported rather than silently extrapolated over the unpriced elements.
    unavailable: priced.length < total
      ? `Partial — ${priced.length} of ${total} linked element(s) have a BOQ item. The figures `
        + 'cover only those; the rest have no approved rate.'
      : null,
  });
}

/** Schedule variance in days: where the verified work has reached against where it should be. */
export function scheduleVariance(db, activityId, { onDate = null } = {}) {
  const progress = activityProgress(db, activityId, { onDate });
  if (!progress || progress.verifiedPct == null || progress.plannedPct == null) {
    return { days: null, unavailable: progress?.unavailable ?? UNAVAILABLE.NOT_MEASURABLE };
  }
  const start = Date.parse(`${progress.plannedStart}T00:00:00Z`);
  const finish = Date.parse(`${progress.plannedFinish}T00:00:00Z`);
  const span = (finish - start) / 86400000;
  if (!Number.isFinite(span) || span <= 0) return { days: null, unavailable: 'No planned duration.' };
  return {
    days: round(((progress.scheduleLineVariancePct ?? 0) / 100) * span),
    note: 'Derived from the gap between verified and planned progress across the planned duration. '
      + 'Negative means the verified work is behind the schedule line.',
    unavailable: null,
  };
}

/** Everything one activity's detail panel shows, in one read. */
export function activityDetail(db, activityId, { onDate = null } = {}) {
  const progress = activityProgress(db, activityId, { onDate });
  if (!progress) return null;
  const activity = db.prepare(
    "SELECT * FROM activity WHERE source_system = 'P6' AND source_id = ?").get(activityId);
  const elements = db.prepare(
    `SELECT m.*, e.category, e.level, e.zone, e.discipline, e.quantity, e.unit,
       EXISTS (SELECT 1 FROM progress_observation o WHERE o.activity_id = m.activity_id
                 AND o.element_id = m.element_id AND o.status = 'VERIFIED') AS verified
       FROM mapping m JOIN element e ON e.source_id = m.element_id
      WHERE m.activity_id = ? ORDER BY m.element_id`).all(activityId);
  const elementIds = elements.map(row => row.element_id);
  const placeholders = elementIds.length ? elementIds.map(() => '?').join(',') : "''";

  return {
    activity,
    /** The SAP counterpart of the activity's P6 WBS, or the absence of one. */
    sapWbs: db.prepare("SELECT * FROM wbs WHERE source_system = 'SAP' AND source_id = ?")
      .get(activity.wbs_code) ?? null,
    progress,
    value: activityValue(db, activityId),
    scheduleVariance: scheduleVariance(db, activityId, { onDate }),
    elements,
    observations: db.prepare(
      'SELECT * FROM progress_observation WHERE activity_id = ? ORDER BY observed_on, id').all(activityId),
    /* Phase 3's results, reused. There is no second validation engine. */
    validation: db.prepare(
      `SELECT * FROM validation_result WHERE status = 'OPEN'
        AND (subject_id = ? OR subject_id IN (${placeholders}))
        ORDER BY severity, rule_id`).all(activity.wbs_code, ...elementIds),
    exceptions: db.prepare(
      `SELECT * FROM exception WHERE subject_id = ? OR subject_id IN (${placeholders})
        ORDER BY id DESC`).all(activity.wbs_code, ...elementIds),
    drafts: db.prepare('SELECT * FROM p6_update_draft WHERE activity_id = ? ORDER BY id DESC')
      .all(activityId),
  };
}

/** The activity list the left-hand tree draws, with each row's two progress figures. */
export function activityList(db, { onDate = null, level = null, zone = null, discipline = null } = {}) {
  const activities = db.prepare(
    `SELECT a.*, w.name AS wbs_name, r.rule FROM activity a
       LEFT JOIN wbs w ON w.source_system = 'P6' AND w.source_id = a.wbs_code
       LEFT JOIN measurement_rule r ON r.activity_id = a.source_id
      WHERE a.source_system = 'P6' ORDER BY a.wbs_code, a.planned_start, a.source_id`).all();
  const rows = [];
  for (const activity of activities) {
    const filters = [];
    const params = [activity.source_id];
    if (level) { filters.push('e.level = ?'); params.push(level); }
    if (zone) { filters.push('e.zone = ?'); params.push(zone); }
    if (discipline) { filters.push('e.discipline = ?'); params.push(discipline); }
    const linked = db.prepare(
      `SELECT COUNT(*) AS n FROM mapping m JOIN element e ON e.source_id = m.element_id
        WHERE m.activity_id = ?${filters.length ? ` AND ${filters.join(' AND ')}` : ''}`).get(...params).n;
    // A filter narrows the tree to the activities that touch it; an activity with no elements is
    // kept only when nothing is filtered, so an empty inspection does not vanish by accident.
    if ((level || zone || discipline) && linked === 0) continue;
    const progress = activityProgress(db, activity.source_id, { onDate });
    rows.push({
      activityId: activity.source_id,
      name: activity.name,
      wbsCode: activity.wbs_code,
      wbsName: activity.wbs_name,
      plannedStart: activity.planned_start,
      plannedFinish: activity.planned_finish,
      p6ReportedPct: activity.pct_complete,
      plannedPct: progress.plannedPct,
      verifiedPct: progress.verifiedPct,
      variancePct: progress.variancePct,
      rule: progress.rule,
      elements: progress.totalElements,
      verifiedElements: progress.verifiedElements,
      unavailable: progress.unavailable,
    });
  }
  return rows;
}

export { RULE };
