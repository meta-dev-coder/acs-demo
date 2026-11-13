/**
 * INT-02 and INT-05: approval-controlled write-back to mock P6 and mock SAP.
 *
 * THE ONE RULE EVERYTHING ELSE SERVES: nothing reaches a destination that an authorised owner has
 * not approved, and nothing overwrites a value that moved after they approved it.
 *
 * Six checks run immediately before every post, in this order, and any one of them stops it:
 *
 *   1. the proposal is APPROVED
 *   2. the source revision is the one the proposal was raised against
 *   3. the verified evidence is the evidence it was approved on
 *   4. the mapping behind it has not changed
 *   5. only permitted fields are changing
 *   6. it has not been posted already
 *
 * A proposal that fails 2, 3 or 4 is HELD with a conflict exception, never forced through. The
 * destination is called inside a transaction and its acknowledgment is stored; a post is reported
 * successful only once the destination has answered.
 */
import { createHash, randomUUID } from 'node:crypto';
import { APPROVER_ROLE } from './auth.mjs';
import { activityProgress, activityValue, verifiedObservations } from './progress.mjs';

export const STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  POSTING: 'POSTING',
  POSTED: 'POSTED',
  REJECTED: 'REJECTED',
  HELD: 'HELD',
  FAILED: 'FAILED',
});

/** The only moves the lifecycle allows. Everything else is refused and says why. */
export const TRANSITIONS = Object.freeze({
  DRAFT: ['PENDING_APPROVAL'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'HELD'],
  APPROVED: ['POSTING', 'HELD', 'REJECTED'],
  POSTING: ['POSTED', 'FAILED', 'HELD'],
  // Terminal. A posted proposal is never approved again, and never posted twice.
  POSTED: [],
  REJECTED: [],
  // A held proposal is re-raised, not resurrected: the thing it was approved on has changed.
  HELD: [],
  // A failure may be retried, because nothing reached the destination.
  FAILED: ['POSTING'],
});

/**
 * The fields each interface may change, and nothing else.
 *
 * Everything absent from these lists is a thing this application must never write: baselines,
 * activity logic, calendars and WBS structure in P6; budgets, actual cost postings, unit rates
 * and BOQ or WBS master data in SAP.
 */
export const PERMITTED_FIELDS = Object.freeze({
  'INT-02': Object.freeze(['pct_complete', 'remaining_duration', 'actual_start', 'actual_finish']),
  'INT-05': Object.freeze(['earned_value']),
});

export const FORBIDDEN_NOTE = Object.freeze({
  'INT-02': 'Baselines, activity logic, calendars and the WBS structure are never written.',
  'INT-05': 'Budgets, actual cost postings, unit rates and BOQ or WBS master data are never '
    + 'written. Earned value is stored in its own table so a slip cannot reach a cost ledger.',
});

const nowIso = () => new Date().toISOString();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/* ── fingerprints: what the proposal was raised against ───────────────────────────────────── */

/** The source record's own revision and the fields this interface may touch. */
export function sourceRevOf(db, interfaceId, subjectId) {
  if (interfaceId === 'INT-02') {
    const row = db.prepare('SELECT rev, pct_complete, remaining_duration, actual_start, actual_finish '
      + 'FROM src_p6_activity WHERE activity_id = ?').get(subjectId);
    return row ? `rev${row.rev}:${digest(row)}` : null;
  }
  // INT-05's subject is a SAP WBS. Its revision is the cost and BOQ data the value rests on.
  const rows = db.prepare(
    `SELECT b.code, b.quantity, b.unit_rate FROM src_sap_boq b
      WHERE b.sap_wbs_code = ? ORDER BY b.code`).all(subjectId);
  return rows.length ? `boq${rows.length}:${digest(rows)}` : null;
}

/** The verified evidence, as it stood. A changed fingerprint means a stale proposal. */
export function evidenceFingerprint(db, interfaceId, subjectId) {
  if (interfaceId === 'INT-02') {
    return digest(verifiedObservations(db, subjectId)
      .map(row => [row.element_id, row.observed_on, row.verified_quantity]));
  }
  const rows = db.prepare(
    `SELECT o.element_id, o.observed_on, o.verified_quantity FROM progress_observation o
       JOIN mapping m ON m.element_id = o.element_id
      WHERE m.sap_wbs_code = ? AND o.status = 'VERIFIED' ORDER BY o.element_id`).all(subjectId);
  return digest(rows);
}

/** The mapping the figures were computed over. */
export function mappingFingerprint(db, interfaceId, subjectId) {
  const rows = interfaceId === 'INT-02'
    ? db.prepare(`SELECT element_id, activity_id, p6_wbs_code, sap_wbs_code, boq_code, status
         FROM mapping WHERE activity_id = ? ORDER BY element_id`).all(subjectId)
    : db.prepare(`SELECT element_id, activity_id, boq_code, status
         FROM mapping WHERE sap_wbs_code = ? ORDER BY element_id`).all(subjectId);
  return digest(rows);
}

/* ── transitions ───────────────────────────────────────────────────────────────────────────── */

function record(db, proposalId, { at, actor, actorRole = null, from, to, reason = null, detail = null }) {
  db.prepare(`INSERT INTO outbound_transition (proposal_id, at, actor, actor_role, from_status,
      to_status, reason, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(proposalId, at, actor, actorRole, from, to, reason,
      detail == null ? null : JSON.stringify(detail));
}

/** Move a proposal, refusing anything the table above does not allow. */
export function transition(db, proposal, to, { actor, actorRole = null, reason = null, detail = null, now = nowIso }) {
  const allowed = TRANSITIONS[proposal.status] ?? [];
  if (!allowed.includes(to)) {
    return { ok: false,
      error: `${proposal.interface_id} proposal ${proposal.id} is ${proposal.status}; it cannot `
        + `move to ${to}. From ${proposal.status} the moves are: ${allowed.join(', ') || 'none — it is final'}.` };
  }
  const at = now();
  db.prepare('UPDATE outbound_proposal SET status = ? WHERE id = ?').run(to, proposal.id);
  record(db, proposal.id, { at, actor, actorRole, from: proposal.status, to, reason, detail });
  return { ok: true, at };
}

/* ── raising a proposal ────────────────────────────────────────────────────────────────────── */

/**
 * An INT-02 proposal, from a Phase 4 draft.
 *
 * The draft already holds the verified figure and its evidence; this binds it to the three
 * fingerprints and puts it in the lifecycle. The progress is re-read rather than trusted from the
 * draft, so a draft prepared last week cannot carry a figure that is no longer true.
 */
export function proposeP6Update(db, draftId, { actor, actorRole, now = nowIso } = {}) {
  const draft = db.prepare('SELECT * FROM p6_update_draft WHERE id = ?').get(Number(draftId));
  if (!draft) return { ok: false, error: `There is no draft ${draftId}.` };
  const activityId = draft.activity_id;
  const progress = activityProgress(db, activityId);
  if (progress.verifiedPct == null) {
    return { ok: false, error: `${activityId} has no verified progress: ${progress.unavailable}` };
  }
  if (progress.verifiedPct !== draft.proposed_pct) {
    return { ok: false,
      error: `Draft ${draftId} proposes ${draft.proposed_pct}% but the verified evidence now says `
        + `${progress.verifiedPct}%. Prepare the update again so the approver sees the current figure.` };
  }

  const current = db.prepare(
    'SELECT pct_complete, remaining_duration, actual_start, actual_finish FROM src_p6_activity WHERE activity_id = ?')
    .get(activityId);
  const payload = {
    pct_complete: progress.verifiedPct,
    remaining_duration: draft.remaining_duration,
    // An actual start only where P6 has none. The first verified observation is evidence that
    // work had begun, not evidence of the day it began — overwriting a date the planner already
    // recorded with an inferred earlier one is the silent overwrite this interface exists to
    // prevent.
    actual_start: current.actual_start ?? draft.actual_start,
    // An actual finish only where the work is finished. A date is not a completion.
    actual_finish: progress.verifiedPct >= 100 ? draft.actual_finish : current.actual_finish,
  };

  return insertProposal(db, {
    interfaceId: 'INT-02', subjectType: 'activity', subjectId: activityId, draftId: draft.id,
    payload, current,
    evidence: {
      rule: progress.rule, ruleNote: progress.ruleNote,
      verifiedElements: progress.verifiedElements, totalElements: progress.totalElements,
      draftObservationsExcluded: progress.draftObservations,
      observations: verifiedObservations(db, activityId).map(row => ({
        element: row.element_id, observedOn: row.observed_on, evidence: row.evidence_ref,
        reviewer: row.reviewer })),
    },
    validationStatus: draft.validation_status,
    coverage: null,
    actor, actorRole, now,
  });
}

/**
 * An INT-05 proposal: earned value for one SAP WBS.
 *
 * Grouped by WBS and built only from elements that have an approved BOQ rate. Where the WBS is
 * only partly mapped the proposal says so, in a coverage block, and is marked PARTIAL — an
 * aggregate that covers part of a WBS must never be posted as if it covered all of it.
 */
export function proposeSapEarnedValue(db, wbsCode, { actor, actorRole, now = nowIso } = {}) {
  const wbs = db.prepare("SELECT * FROM wbs WHERE source_system = 'SAP' AND source_id = ?").get(String(wbsCode ?? ''));
  if (!wbs) return { ok: false, error: `SAP carries no WBS ${wbsCode}.` };

  const elements = db.prepare(
    `SELECT m.element_id, m.boq_code, e.quantity, e.unit,
            b.unit_rate, b.unit AS boq_unit, b.quantity AS boq_quantity,
            EXISTS (SELECT 1 FROM progress_observation o WHERE o.element_id = m.element_id
                      AND o.status = 'VERIFIED') AS verified
       FROM mapping m JOIN element e ON e.source_id = m.element_id
       LEFT JOIN boq_item b ON b.source_id = m.boq_code
      WHERE m.sap_wbs_code = ? ORDER BY m.element_id`).all(wbs.source_id);
  if (!elements.length) {
    return { ok: false, error: `No element is mapped to SAP WBS ${wbs.source_id}, so there is `
      + 'nothing to value.' };
  }

  const priced = elements.filter(row => row.boq_code && row.unit_rate != null);
  if (!priced.length) {
    return { ok: false,
      error: `Not available — mapping incomplete. None of the ${elements.length} element(s) under `
        + `SAP WBS ${wbs.source_id} has a BOQ item, so there is no approved rate to value them at.` };
  }
  const unitMismatch = priced.filter(row => row.unit && row.boq_unit && row.unit !== row.boq_unit);
  const earned = priced.filter(row => row.verified)
    .reduce((sum, row) => sum + (Number(row.quantity) || 0) * row.unit_rate, 0);
  const budgetValue = priced.reduce((sum, row) => sum + (Number(row.quantity) || 0) * row.unit_rate, 0);
  const cost = db.prepare("SELECT * FROM cost WHERE source_system = 'SAP' AND source_id = ?")
    .get(wbs.source_id) ?? null;
  const existing = db.prepare('SELECT * FROM src_sap_earned_value WHERE sap_wbs_code = ?')
    .get(wbs.source_id) ?? null;

  const complete = priced.length === elements.length;
  const coverage = {
    scope: complete ? 'COMPLETE' : 'PARTIAL',
    elementsInWbs: elements.length,
    priced: priced.length,
    unpriced: elements.length - priced.length,
    includedElements: priced.map(row => row.element_id),
    excludedElements: elements.filter(row => !row.boq_code || row.unit_rate == null)
      .map(row => row.element_id),
    unitMismatches: unitMismatch.map(row => ({ element: row.element_id,
      modelled: row.unit, measured: row.boq_unit })),
    note: complete
      ? 'Every element under this WBS has an approved BOQ rate, so the value covers the whole WBS.'
      : `${elements.length - priced.length} of ${elements.length} element(s) under this WBS have `
        + 'no BOQ item. The value below covers only the priced ones and is a PARTIAL figure; it '
        + 'must not be read as the whole WBS.',
  };

  return insertProposal(db, {
    interfaceId: 'INT-05', subjectType: 'sapWbs', subjectId: wbs.source_id, draftId: null,
    payload: { earned_value: Math.round(earned), currency: cost?.currency ?? 'INR',
      coverage: coverage.scope },
    current: { earned_value: existing?.earned_value ?? null, currency: existing?.currency ?? null },
    evidence: {
      lines: priced.map(row => ({ element: row.element_id, boq: row.boq_code,
        approvedQuantity: row.boq_quantity, verifiedQuantity: row.verified ? row.quantity : 0,
        unit: row.boq_unit, unitRate: row.unit_rate,
        value: row.verified ? Math.round((Number(row.quantity) || 0) * row.unit_rate) : 0 })),
      budgetValueOfPricedWork: Math.round(budgetValue),
      /* Reported beside the earned value so nobody reads one as the other. */
      sapActualCost: cost?.actual_cost ?? null,
      sapBudget: cost?.budget ?? null,
      note: 'Earned value is what the verified work is worth at the approved rates. It is not '
        + 'actual cost, and posting it changes neither the budget nor any cost posting.',
    },
    validationStatus: unitMismatch.length
      ? `WARNING: ${unitMismatch.length} element(s) are modelled in a different unit from their BOQ item.`
      : 'VALIDATED',
    coverage,
    actor, actorRole, now,
  });
}

function insertProposal(db, {
  interfaceId, subjectType, subjectId, draftId, payload, current, evidence, validationStatus,
  coverage, actor, actorRole, now,
}) {
  const at = now();
  const sourceRev = sourceRevOf(db, interfaceId, subjectId);
  if (!sourceRev) {
    return { ok: false, error: `No source record for ${subjectId} in ${interfaceId}'s destination.` };
  }
  // Stable per subject and payload: submitting the same change twice is the same proposal, which
  // is what stops a double click becoming two postings.
  const idempotencyKey = `${interfaceId}:${subjectId}:${digest(payload)}`;
  const existing = db.prepare('SELECT * FROM outbound_proposal WHERE idempotency_key = ?')
    .get(idempotencyKey);
  if (existing && !['REJECTED', 'HELD', 'FAILED'].includes(existing.status)) {
    return { ok: true, reused: true, proposal: read(db, existing.id),
      note: `An identical proposal already exists (${existing.status}). It has not been duplicated.` };
  }

  const correlationId = randomUUID();
  const id = db.prepare(
    `INSERT INTO outbound_proposal (interface_id, subject_type, subject_id, draft_id, status,
        payload, evidence, source_rev, evidence_fingerprint, mapping_fingerprint,
        validation_status, coverage, idempotency_key, correlation_id, created_at, created_by)
     VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(interfaceId, subjectType, subjectId, draftId,
      JSON.stringify({ proposed: payload, current }), JSON.stringify(evidence), sourceRev,
      evidenceFingerprint(db, interfaceId, subjectId),
      mappingFingerprint(db, interfaceId, subjectId),
      validationStatus, coverage ? JSON.stringify(coverage) : null,
      // A re-raised proposal gets its own key, so the old rejected one is not resurrected.
      existing ? `${idempotencyKey}:${Date.parse(at)}` : idempotencyKey,
      correlationId, at, actor).lastInsertRowid;
  record(db, id, { at, actor, actorRole, from: null, to: 'DRAFT',
    reason: 'Proposal raised from verified evidence.' });
  return { ok: true, proposal: read(db, id) };
}

export const read = (db, id) => {
  const row = db.prepare('SELECT * FROM outbound_proposal WHERE id = ?').get(Number(id));
  if (!row) return null;
  return {
    ...row,
    payload: JSON.parse(row.payload),
    evidence: JSON.parse(row.evidence),
    coverage: row.coverage ? JSON.parse(row.coverage) : null,
  };
};

/* ── submit, decide ────────────────────────────────────────────────────────────────────────── */

export function submit(db, id, { actor, actorRole, now = nowIso } = {}) {
  const proposal = db.prepare('SELECT * FROM outbound_proposal WHERE id = ?').get(Number(id));
  if (!proposal) return { ok: false, error: `There is no proposal ${id}.` };
  const moved = transition(db, proposal, STATUS.PENDING_APPROVAL, { actor, actorRole, now,
    reason: `Submitted for ${APPROVER_ROLE[proposal.interface_id]} approval.` });
  if (!moved.ok) return moved;
  db.prepare('UPDATE outbound_proposal SET submitted_at = ? WHERE id = ?').run(moved.at, proposal.id);
  return { ok: true, proposal: read(db, proposal.id) };
}

/**
 * Approve or reject.
 *
 * The role comes from the caller's SESSION, never from the request body — see auth.mjs. The two
 * interfaces have different approvers and no role holds both.
 */
export function decide(db, id, decision, { session, note = null, now = nowIso } = {}) {
  const proposal = db.prepare('SELECT * FROM outbound_proposal WHERE id = ?').get(Number(id));
  if (!proposal) return { ok: false, error: `There is no proposal ${id}.` };
  const wanted = APPROVER_ROLE[proposal.interface_id];
  if (session?.role !== wanted) {
    return { ok: false, forbidden: true,
      error: `${proposal.interface_id} is approved by the ${wanted} role. `
        + `This session is acting as ${session?.role ?? 'nobody'}.` };
  }
  const to = decision === 'APPROVE' ? STATUS.APPROVED
    : decision === 'REJECT' ? STATUS.REJECTED
      : decision === 'HOLD' ? STATUS.HELD : null;
  if (!to) return { ok: false, error: `Unknown decision "${decision}".` };

  const moved = transition(db, proposal, to, { actor: session.actor, actorRole: session.role, now,
    reason: note ?? `${decision} by ${session.role}.` });
  if (!moved.ok) return moved;
  db.prepare(`UPDATE outbound_proposal SET decided_at = ?, approver = ?, approver_role = ?,
      decision_note = ?${to === STATUS.HELD ? ', hold_reason = ?' : ''} WHERE id = ?`)
    .run(...[moved.at, session.actor, session.role, note ?? null,
      ...(to === STATUS.HELD ? [note ?? 'Held by the approver.'] : []), proposal.id]);
  return { ok: true, status: to, proposal: read(db, proposal.id) };
}

/* ── the six pre-post checks ───────────────────────────────────────────────────────────────── */

/**
 * Everything that must still be true before anything is written.
 *
 * Returned as a list rather than a boolean, so a refusal can say exactly which check failed and
 * what moved — "conflict" on its own tells an operator nothing they can act on.
 */
export function preflight(db, proposal) {
  const checks = [];
  const add = (id, label, ok, detail) => checks.push({ id, label, ok, detail });

  add('APPROVED', 'The proposal is approved',
    [STATUS.APPROVED, STATUS.POSTING, STATUS.FAILED].includes(proposal.status),
    `Status is ${proposal.status}.`);

  const sourceRev = sourceRevOf(db, proposal.interface_id, proposal.subject_id);
  add('SOURCE_REVISION', 'The source has not changed', sourceRev === proposal.source_rev,
    sourceRev === proposal.source_rev ? `Unchanged at ${proposal.source_rev}.`
      : `Changed from ${proposal.source_rev} to ${sourceRev} after the proposal was raised.`);

  const evidence = evidenceFingerprint(db, proposal.interface_id, proposal.subject_id);
  add('EVIDENCE', 'The verified evidence has not changed',
    evidence === proposal.evidence_fingerprint,
    evidence === proposal.evidence_fingerprint ? 'The same observations the approver saw.'
      : 'The verified observations changed after the proposal was approved.');

  const mapping = mappingFingerprint(db, proposal.interface_id, proposal.subject_id);
  add('MAPPING', 'The mapping has not changed', mapping === proposal.mapping_fingerprint,
    mapping === proposal.mapping_fingerprint ? 'The same mapping the figures were computed over.'
      : 'The mapping changed after the proposal was approved, so the figures may no longer hold.');

  const permitted = PERMITTED_FIELDS[proposal.interface_id] ?? [];
  const payload = typeof proposal.payload === 'string' ? JSON.parse(proposal.payload) : proposal.payload;
  const fields = Object.keys(payload.proposed ?? {}).filter(key => key !== 'currency' && key !== 'coverage');
  const forbidden = fields.filter(field => !permitted.includes(field));
  add('PERMITTED_FIELDS', 'Only permitted fields change', forbidden.length === 0,
    forbidden.length ? `Refused: ${forbidden.join(', ')}. ${FORBIDDEN_NOTE[proposal.interface_id]}`
      : `${fields.join(', ')}. ${FORBIDDEN_NOTE[proposal.interface_id]}`);

  const posted = db.prepare(
    `SELECT COUNT(*) AS n FROM outbound_attempt WHERE proposal_id = ? AND outcome = 'ACKNOWLEDGED'`)
    .get(proposal.id).n;
  add('NOT_POSTED', 'It has not been posted already', posted === 0,
    posted ? `${posted} acknowledged posting(s) already exist for this proposal.` : 'No prior posting.');

  return { checks, ok: checks.every(entry => entry.ok),
    failed: checks.filter(entry => !entry.ok) };
}
