/**
 * Mapping suggestions, proposals and the approval that applies them.
 *
 * A SUGGESTION IS NOT A MAPPING. `suggestActivities` ranks candidates and says, for each, exactly
 * which evidence it matched on. Nothing here applies one: a person chooses, a proposal is raised,
 * and an authorised owner approves it. There is no code path from a suggestion to the mapping
 * table that does not pass through a human decision.
 *
 * SOURCE RECORDS ARE NEVER WRITTEN. An approved proposal is applied to the integration-owned
 * mapping layer and nothing else — `src_p6_*`, `src_acc_*` and `src_sap_*` are read-only here, as
 * they are everywhere in this project.
 *
 * THE SOURCE IS RE-READ BEFORE APPLYING. If the record moved between the proposal and the
 * approval, the change is HELD and an exception is raised, rather than posted over a value nobody
 * reviewed. It is the same control INT-02 will use for write-back in Phase 5.
 */
import { buildMappings } from './mapping.mjs';
import { OWNER } from './validation.mjs';

export const PROPOSAL_STATUS = Object.freeze({
  PROPOSED: 'PROPOSED',
  PENDING_REVIEW: 'PENDING_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  APPLIED: 'APPLIED',
  /** The source moved under it. Nothing was applied. */
  HELD: 'HELD',
  WITHDRAWN: 'WITHDRAWN',
});

/** Which field a proposal may change, and who owns the decision. */
export const PROPOSABLE = Object.freeze({
  activity_id: Object.freeze({
    label: 'Linked P6 activity',
    /** The planner owns the schedule, so the planner approves what an element is built by. */
    approverRole: OWNER.PLANNER,
    note: 'Changes which P6 activity builds this element, in the integration layer only.',
  }),
  boq_code: Object.freeze({
    label: 'Linked BOQ item',
    /** The money is Finance's. */
    approverRole: OWNER.FINANCE,
    note: 'Chooses one of the BOQ items the SAP WBS carries. SAP is unchanged.',
  }),
});

const nowIso = () => new Date().toISOString();

/* ── suggestions ───────────────────────────────────────────────────────────────────────────── */

/**
 * Candidate activities for an element, with the evidence behind each.
 *
 * Deliberately additive and explainable: every point comes from a named match, and the reasons
 * travel with the candidate. A score with no reasons would be an opinion.
 */
export function suggestActivities(db, elementId, { limit = 5 } = {}) {
  const element = db.prepare(
    "SELECT * FROM element WHERE source_system = 'ACC' AND source_id = ?").get(String(elementId));
  if (!element) return { element: null, candidates: [], reason: `No element ${elementId}.` };

  const activities = db.prepare("SELECT * FROM activity WHERE source_system = 'P6'").all();
  const wbsNames = new Map(db.prepare("SELECT source_id, name FROM wbs WHERE source_system = 'P6'").all()
    .map(row => [row.source_id, row.name]));
  // What its neighbours are mapped to: the strongest evidence available, because a sibling in the
  // same package, level and zone is almost always built by the same activity.
  const neighbours = new Map(db.prepare(
    `SELECT m.activity_id, COUNT(*) AS n FROM mapping m JOIN element e ON e.source_id = m.element_id
      WHERE m.activity_id IS NOT NULL AND e.work_package = ? AND e.level = ? AND e.discipline = ?
        AND e.source_id <> ? GROUP BY m.activity_id`)
    .all(element.work_package, element.level, element.discipline, element.source_id)
    .map(row => [row.activity_id, row.n]));

  const words = String(element.category ?? '').toLowerCase().split(/\W+/).filter(word => word.length > 3);

  const scored = activities.map(activity => {
    const reasons = [];
    let score = 0;
    const wbsName = wbsNames.get(activity.wbs_code) ?? null;
    if (wbsName && element.work_package && wbsName === element.work_package) {
      score += 40; reasons.push(`Its WBS ${activity.wbs_code} is "${wbsName}", the element's own work package.`);
    }
    const siblings = neighbours.get(activity.source_id) ?? 0;
    if (siblings) {
      score += Math.min(35, 15 + siblings * 4);
      reasons.push(`${siblings} other ${element.discipline.toLowerCase()} element(s) on `
        + `${element.level} in ${element.work_package} are already built by it.`);
    }
    const name = String(activity.name ?? '').toLowerCase();
    if (element.level && name.includes(element.level.toLowerCase())) {
      score += 20; reasons.push(`Its description names ${element.level}, the element's own level.`);
    }
    const wordHit = words.find(word => name.includes(word));
    if (wordHit) { score += 12; reasons.push(`Its description mentions "${wordHit}".`); }
    if (element.zone && name.toLowerCase().includes(String(element.zone).toLowerCase())) {
      score += 8; reasons.push(`Its description names ${element.zone}.`);
    }
    return { activityId: activity.source_id, name: activity.name, wbsCode: activity.wbs_code,
      wbsName, plannedStart: activity.planned_start, plannedFinish: activity.planned_finish,
      score, reasons };
  }).filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.activityId.localeCompare(b.activityId))
    .slice(0, limit);

  return {
    element,
    candidates: scored.map(entry => ({
      ...entry,
      // Capped below certainty on purpose. Nothing here is ever a settled fact.
      confidence: Math.min(92, entry.score),
      /** Always. A suggestion is evidence for a person, not a decision. */
      requiresApproval: true,
    })),
    reason: scored.length ? null
      : 'No activity shares this element\'s work package, level, zone or vocabulary. A planner '
        + 'must identify the activity directly.',
  };
}

/* ── proposals ─────────────────────────────────────────────────────────────────────────────── */

/** The source revision a proposal was raised against, so a later change can be detected. */
function currentRev(db, elementId) {
  const row = db.prepare(
    `SELECT e.source_rev AS elementRev, a.source_rev AS activityRev
       FROM element e LEFT JOIN mapping m ON m.element_id = e.source_id
       LEFT JOIN activity a ON a.source_id = m.activity_id AND a.source_system = 'P6'
      WHERE e.source_system = 'ACC' AND e.source_id = ?`).get(String(elementId));
  return row ? `e${row.elementRev ?? 1}/a${row.activityRev ?? 0}` : null;
}

export function proposeMapping(db, {
  elementId, field, proposedValue, reason, requester, requesterRole, evidence = null,
  exceptionId = null, now = nowIso,
} = {}) {
  const spec = PROPOSABLE[field];
  if (!spec) {
    return { ok: false, error: `"${field}" is not a proposable mapping field. `
      + `The fields are: ${Object.keys(PROPOSABLE).join(', ')}.` };
  }
  const mapping = db.prepare('SELECT * FROM mapping WHERE element_id = ?').get(String(elementId));
  if (!mapping) return { ok: false, error: `There is no mapping for element ${elementId}.` };
  if (!String(reason ?? '').trim()) {
    return { ok: false, error: 'A proposal must carry a reason. A mapping change with no stated '
      + 'reason cannot be reviewed.' };
  }

  // The proposed value must name a record that exists, or it is not a mapping.
  if (field === 'activity_id') {
    const exists = db.prepare(
      "SELECT 1 AS ok FROM activity WHERE source_system = 'P6' AND source_id = ?").get(String(proposedValue));
    if (!exists) return { ok: false, error: `P6 has no activity ${proposedValue}.` };
  }
  if (field === 'boq_code') {
    const candidate = db.prepare('SELECT sap_wbs_code FROM boq_item WHERE source_id = ?').get(String(proposedValue));
    if (!candidate) return { ok: false, error: `There is no BOQ item ${proposedValue}.` };
    if (candidate.sap_wbs_code !== mapping.sap_wbs_code) {
      return { ok: false, error: `BOQ item ${proposedValue} sits under SAP WBS `
        + `${candidate.sap_wbs_code}, not ${mapping.sap_wbs_code}. Choosing it would cross the `
        + 'cost structure.' };
    }
  }

  const at = now();
  const id = db.prepare(
    `INSERT INTO mapping_proposal (element_id, field, current_value, proposed_value, reason,
        evidence, requester, requester_role, status, created_at, source_rev_at_proposal, exception_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_REVIEW', ?, ?, ?)`)
    .run(String(elementId), field, mapping[field] ?? null, String(proposedValue), String(reason),
      evidence == null ? null : JSON.stringify(evidence), requester, requesterRole, at,
      currentRev(db, elementId), exceptionId).lastInsertRowid;

  return { ok: true, proposal: db.prepare('SELECT * FROM mapping_proposal WHERE id = ?').get(id),
    approverRole: spec.approverRole };
}

/**
 * Approve or reject. Only the field's own data owner may approve it.
 *
 * On approval the source revision is read again: if it has moved, the proposal is HELD and
 * nothing is applied. Otherwise the change is applied to the mapping layer, the layer is rebuilt
 * and the caller is expected to revalidate.
 */
export function decideProposal(db, id, decision, { actor, actorRole, note = null, now = nowIso } = {}) {
  const proposal = db.prepare('SELECT * FROM mapping_proposal WHERE id = ?').get(Number(id));
  if (!proposal) return { ok: false, error: `There is no proposal ${id}.` };
  if (proposal.status !== PROPOSAL_STATUS.PENDING_REVIEW && proposal.status !== PROPOSAL_STATUS.HELD) {
    return { ok: false, error: `Proposal ${id} is ${proposal.status} and cannot be decided again.` };
  }
  const spec = PROPOSABLE[proposal.field];
  if (actorRole !== spec.approverRole) {
    return { ok: false, error: `${spec.label} is approved by the ${spec.approverRole} role. `
      + `${actorRole ?? 'an unauthenticated caller'} may not approve it.` };
  }

  const at = now();
  if (decision === 'REJECT') {
    db.prepare(`UPDATE mapping_proposal SET status = 'REJECTED', approver = ?, approver_role = ?,
        decided_at = ?, validation_outcome = ? WHERE id = ?`)
      .run(actor, actorRole, at, note ?? null, proposal.id);
    return { ok: true, status: PROPOSAL_STATUS.REJECTED,
      proposal: db.prepare('SELECT * FROM mapping_proposal WHERE id = ?').get(proposal.id) };
  }
  if (decision !== 'APPROVE') return { ok: false, error: `Unknown decision "${decision}".` };

  // The conflict check: has the source moved since this was raised?
  const rev = currentRev(db, proposal.element_id);
  if (rev !== proposal.source_rev_at_proposal) {
    db.prepare(`UPDATE mapping_proposal SET status = 'HELD', validation_outcome = ? WHERE id = ?`)
      .run(`Held: the source moved from ${proposal.source_rev_at_proposal} to ${rev} after the `
        + 'proposal was raised. Nothing was applied.', proposal.id);
    return { ok: false, held: true,
      error: `The source record changed after this proposal was raised `
        + `(${proposal.source_rev_at_proposal} → ${rev}). Nothing has been applied. Review the `
        + 'current value and raise the proposal again.',
      proposal: db.prepare('SELECT * FROM mapping_proposal WHERE id = ?').get(proposal.id) };
  }

  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE mapping_proposal SET status = 'APPLIED', approver = ?, approver_role = ?,
        decided_at = ?, applied_at = ? WHERE id = ?`).run(actor, actorRole, at, at, proposal.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  // Rebuild the integration layer from the sources plus the approved overrides. No src_* table is
  // touched; the override is what changes the chain.
  const build = buildMappings(db, { actor });
  return { ok: true, status: PROPOSAL_STATUS.APPLIED, build,
    proposal: db.prepare('SELECT * FROM mapping_proposal WHERE id = ?').get(proposal.id) };
}

/** Record that a proposal's change has been revalidated, and what came of it. */
export function markRevalidated(db, id, outcome, { now = nowIso } = {}) {
  db.prepare('UPDATE mapping_proposal SET revalidated_at = ?, validation_outcome = ? WHERE id = ?')
    .run(now(), JSON.stringify(outcome), Number(id));
}

export function listProposals(db, { status = null, elementId = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (elementId) { where.push('element_id = ?'); params.push(elementId); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM mapping_proposal ${clause} ORDER BY id DESC LIMIT ?`)
    .all(...params, Math.min(200, Math.max(1, Number(limit) || 100)));
}
