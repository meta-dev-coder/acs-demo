/**
 * The guided end-to-end demonstration.
 *
 * IT CHECKS, IT DOES NOT PRETEND. Each step asks the database whether it has actually happened,
 * and reports `done`, `ready` or `blocked` with the reason. There is no hardcoded completed
 * workflow and no fabricated success: a step is done because the records say so.
 *
 * It drives nothing itself. Each step names the workspace and the action an operator performs, so
 * the demonstration is the real application being used — not a script replaying beside it.
 */

const one = (db, sql, ...params) => db.prepare(sql).get(...params);
const n = (db, sql, ...params) => one(db, sql, ...params)?.n ?? 0;

/** The worked example the whole demonstration is narrated around. */
export const SUBJECT = Object.freeze({ activityId: 'A-1020', elementId: 'COL-001' });

/**
 * The ten steps, each with a test it runs against real state.
 *
 * `check` returns `{ done, detail }`. `blockedBy` names the step that must happen first, so a
 * reader is told what is missing rather than left with a step that quietly does nothing.
 */
const STEPS = Object.freeze([
  {
    id: 'import', title: 'Import', workspace: 'integrationOverview',
    action: 'Run Demo Sync — INT-01, INT-03 and INT-04.',
    check(db) {
      const runs = db.prepare(
        `SELECT interface_id, MAX(status) AS status FROM sync_run
          WHERE status IN ('SUCCESS','PARTIAL') GROUP BY interface_id`).all();
      const got = runs.map(row => row.interface_id).sort();
      const want = ['INT-01', 'INT-03', 'INT-04'];
      return {
        done: want.every(id => got.includes(id)),
        detail: got.length
          ? `${got.join(', ')} have run. ${n(db, "SELECT COUNT(*) AS n FROM activity")} activities, `
            + `${n(db, "SELECT COUNT(*) AS n FROM element")} elements, `
            + `${n(db, "SELECT COUNT(*) AS n FROM boq_item")} BOQ items imported.`
          : 'No inbound interface has run yet.',
      };
    },
  },
  {
    id: 'validate', title: 'Validate', workspace: 'mappingWorkbench', blockedBy: 'import',
    action: 'The mapping layer is validated on every sync. Open the Mapping Workbench.',
    check(db) {
      const run = one(db, 'SELECT * FROM validation_run ORDER BY id DESC LIMIT 1');
      return {
        done: Boolean(run),
        detail: run
          ? `Run ${run.id}: ${run.failures} failure(s), ${run.warnings} warning(s), `
            + `${run.excluded} excluded by policy over ${run.subjects_checked} mapping(s).`
          : 'Validation has not run.',
      };
    },
  },
  {
    id: 'investigate', title: 'Investigate', workspace: 'exceptions', blockedBy: 'validate',
    action: 'Open an exception and follow it to the element, activity, WBS and BOQ it concerns.',
    check(db) {
      const open = n(db, "SELECT COUNT(*) AS n FROM exception WHERE status <> 'RESOLVED'");
      const reviewed = n(db,
        "SELECT COUNT(*) AS n FROM exception WHERE status IN ('UNDER_REVIEW','AWAITING_CORRECTION','READY_FOR_REVALIDATION')");
      return { done: reviewed > 0,
        detail: `${open} open exception(s); ${reviewed} have been picked up by a reviewer.` };
    },
  },
  {
    id: 'correct', title: 'Correct', workspace: 'mappingWorkbench', blockedBy: 'investigate',
    action: 'Propose a mapping for an unmapped element and have its data owner approve it.',
    check(db) {
      const applied = n(db, "SELECT COUNT(*) AS n FROM mapping_proposal WHERE status = 'APPLIED'");
      return { done: applied > 0,
        detail: applied
          ? `${applied} mapping correction(s) approved and applied, then revalidated.`
          : 'No mapping correction has been approved yet.' };
    },
  },
  {
    id: 'visualise', title: 'Visualise', workspace: 'constructionProgress', blockedBy: 'import',
    action: `Select ${SUBJECT.activityId} and isolate the elements it builds in the model.`,
    check(db) {
      const linked = n(db, 'SELECT COUNT(*) AS n FROM mapping WHERE activity_id = ?', SUBJECT.activityId);
      const placed = n(db,
        `SELECT COUNT(*) AS n FROM mapping m JOIN element_geometry g ON g.element_id = m.element_id
          WHERE m.activity_id = ?`, SUBJECT.activityId);
      return { done: placed > 0 && placed === linked,
        detail: `${SUBJECT.activityId} builds ${linked} element(s); ${placed} have geometry in the model.` };
    },
  },
  {
    id: 'verify', title: 'Verify progress', workspace: 'constructionProgress', blockedBy: 'visualise',
    action: `Compare what P6 claims for ${SUBJECT.activityId} with what the observations verify.`,
    check(db) {
      const activity = one(db,
        "SELECT pct_complete FROM activity WHERE source_system = 'P6' AND source_id = ?", SUBJECT.activityId);
      const total = n(db, 'SELECT COUNT(*) AS n FROM mapping WHERE activity_id = ?', SUBJECT.activityId);
      const verified = n(db,
        `SELECT COUNT(DISTINCT element_id) AS n FROM progress_observation
          WHERE activity_id = ? AND status = 'VERIFIED'`, SUBJECT.activityId);
      const pct = total ? Math.round((verified / total) * 100) : null;
      return { done: pct != null,
        detail: pct == null ? 'No measurable progress for this activity.'
          : `P6 reports ${activity?.pct_complete}%; ${verified} of ${total} elements are verified, `
            + `so ${pct}% — a ${pct - (activity?.pct_complete ?? 0)} point discrepancy. That is a `
            + 'claim against evidence, which is a different question from schedule variance.' };
    },
  },
  {
    id: 'propose', title: 'Approve — prepare', workspace: 'approvals', blockedBy: 'verify',
    action: 'Prepare the P6 update and raise it as an INT-02 proposal for the planner.',
    check(db) {
      const pending = n(db,
        `SELECT COUNT(*) AS n FROM outbound_proposal WHERE interface_id = 'INT-02'
          AND status IN ('PENDING_APPROVAL','APPROVED','POSTED')`);
      return { done: pending > 0,
        detail: pending ? `${pending} INT-02 proposal(s) raised.` : 'No INT-02 proposal exists.' };
    },
  },
  {
    id: 'post', title: 'Simulate write-back', workspace: 'approvals', blockedBy: 'propose',
    action: 'Approve as the planner, then post to the mock P6.',
    check(db) {
      const posted = one(db,
        `SELECT p.*, a.response FROM outbound_proposal p
           LEFT JOIN outbound_attempt a ON a.proposal_id = p.id AND a.outcome = 'ACKNOWLEDGED'
          WHERE p.interface_id = 'INT-02' AND p.status = 'POSTED' ORDER BY p.id DESC LIMIT 1`);
      const source = one(db, 'SELECT pct_complete, rev FROM src_p6_activity WHERE activity_id = ?',
        SUBJECT.activityId);
      return { done: Boolean(posted),
        detail: posted
          ? `Posted and acknowledged. mock P6 now holds ${source?.pct_complete}% at revision `
            + `${source?.rev}. Simulated — no live P6 was contacted.`
          : 'Nothing has been posted. A proposal must be approved by the planner first.' };
    },
  },
  {
    id: 'resync', title: 'Synchronise again', workspace: 'integrationOverview', blockedBy: 'post',
    action: 'Run INT-01 again so SYNCHRO 4D picks the posted value back up.',
    check(db) {
      const source = one(db, 'SELECT pct_complete FROM src_p6_activity WHERE activity_id = ?', SUBJECT.activityId);
      const copy = one(db, "SELECT pct_complete FROM activity WHERE source_system = 'P6' AND source_id = ?",
        SUBJECT.activityId);
      const matched = source && copy && source.pct_complete === copy.pct_complete;
      return { done: Boolean(matched),
        detail: !source || !copy ? 'The activity is not loaded.'
          : matched
            ? `SYNCHRO 4D's copy now reads ${copy.pct_complete}%, matching mock P6.`
            : `mock P6 holds ${source.pct_complete}% and SYNCHRO 4D's copy still reads `
              + `${copy.pct_complete}%. Run INT-01 to close the loop.` };
    },
  },
  {
    id: 'audit', title: 'Audit', workspace: 'auditHistory', blockedBy: 'post',
    action: `Open Sync History & Audit and filter the trail to ${SUBJECT.activityId}.`,
    check(db) {
      const events = n(db, 'SELECT COUNT(*) AS n FROM audit_event WHERE subject_id = ?', SUBJECT.activityId);
      const transitions = n(db,
        `SELECT COUNT(*) AS n FROM outbound_transition t JOIN outbound_proposal p ON p.id = t.proposal_id
          WHERE p.subject_id = ?`, SUBJECT.activityId);
      return { done: events + transitions > 0,
        detail: `${events + transitions} persisted event(s) mention ${SUBJECT.activityId}.` };
    },
  },
]);

/** The walkthrough's current state, computed from the database every time it is asked. */
export function walkthrough(db) {
  const results = new Map();
  const steps = STEPS.map(step => {
    const outcome = step.check(db);
    const blocked = step.blockedBy && !results.get(step.blockedBy);
    // A step cannot be done while its prerequisite is not. "Synchronise again" compared the
    // source with SYNCHRO's copy and found them equal before anything had been posted — which is
    // true, and is not the step having happened.
    const done = outcome.done && !blocked;
    results.set(step.id, done);
    return {
      id: step.id, title: step.title, workspace: step.workspace, action: step.action,
      state: done ? 'done' : blocked ? 'blocked' : 'ready',
      detail: outcome.detail,
      blockedBy: blocked ? step.blockedBy : null,
      blockedNote: blocked
        ? `Do "${STEPS.find(entry => entry.id === step.blockedBy).title}" first.` : null,
    };
  });
  return {
    subject: SUBJECT,
    steps,
    completed: steps.filter(step => step.state === 'done').length,
    total: steps.length,
    note: 'Every step is checked against the database when this is read. Nothing here is a '
      + 'recording of a workflow that happened once.',
  };
}

/**
 * The scenarios the demonstration can show, and whether each is currently in evidence.
 *
 * They are DISCOVERED, not re-implemented: each one points at the workspace where the existing
 * services already produce it.
 */
export function scenarios(db) {
  const rows = [
    { id: 'inbound-sync', title: 'Successful inbound synchronisation', workspace: 'integrationOverview',
      how: 'Run Demo Sync. Running it again shows the idempotency — everything unchanged.',
      evidence: () => n(db, "SELECT COUNT(*) AS n FROM sync_run WHERE status = 'SUCCESS'") },
    { id: 'missing-mapping', title: 'BIM element with no P6 activity', workspace: 'mappingWorkbench',
      how: 'Filter the workbench by R01, pick an element, review the candidates and propose one.',
      evidence: () => n(db, "SELECT COUNT(*) AS n FROM exception WHERE rule_id = 'R01_BIM_NO_ACTIVITY' AND status <> 'RESOLVED'") },
    { id: 'wbs-mismatch', title: 'SAP WBS with no P6 counterpart', workspace: 'exceptions',
      how: 'Open the R04 exception. It belongs to Finance; the integration layer must not invent a node.',
      evidence: () => n(db, "SELECT COUNT(*) AS n FROM exception WHERE rule_id = 'R04_SAP_WBS_MISMATCH'") },
    { id: 'unpublished-model', title: 'Unpublished model version excluded', workspace: 'exceptions',
      how: 'Reconciliation subtab: the WIP version is counted as excluded, never as a failed import.',
      evidence: () => n(db, "SELECT COUNT(*) AS n FROM validation_result WHERE rule_id = 'R09_UNPUBLISHED_MODEL' AND status = 'OPEN'") },
    { id: 'version-change', title: 'A newer published version drops elements', workspace: 'mappingWorkbench',
      how: 'Filter by R10. Their mappings survive so a person decides, rather than vanishing.',
      evidence: () => n(db, "SELECT COUNT(*) AS n FROM exception WHERE rule_id = 'R10_ELEMENT_REMOVED'") },
    { id: 'planned-vs-verified', title: 'Planned against verified progress', workspace: 'constructionProgress',
      how: `Select ${SUBJECT.activityId}: P6 claims 80%, twelve of twenty columns are verified.`,
      evidence: () => n(db, `SELECT COUNT(DISTINCT element_id) AS n FROM progress_observation
        WHERE activity_id = ? AND status = 'VERIFIED'`, SUBJECT.activityId) },
    { id: 'p6-write-back', title: 'Planner approval and simulated P6 posting', workspace: 'approvals',
      how: 'Raise the INT-02 proposal, approve it as the planner, post it to mock P6.',
      evidence: () => n(db, "SELECT COUNT(*) AS n FROM outbound_proposal WHERE interface_id = 'INT-02' AND status = 'POSTED'") },
    { id: 'source-conflict', title: 'Source changed after approval', workspace: 'approvals',
      how: 'Approve a proposal, change the P6 source, then post. It is held and an exception is raised.',
      evidence: () => n(db, "SELECT COUNT(*) AS n FROM outbound_proposal WHERE status = 'HELD'") },
    { id: 'sap-earned-value', title: 'Finance approval and simulated SAP posting', workspace: 'approvals',
      how: 'Raise an INT-05 proposal for a WBS, approve as Finance, post. Only earned value moves.',
      evidence: () => n(db, "SELECT COUNT(*) AS n FROM outbound_proposal WHERE interface_id = 'INT-05' AND status = 'POSTED'") },
    { id: 'posting-failure', title: 'Simulated posting failure and retry', workspace: 'approvals',
      how: 'Arm a destination failure, post, then retry. Both attempts are kept.',
      evidence: () => n(db, "SELECT COUNT(*) AS n FROM outbound_attempt WHERE outcome = 'FAILED'") },
  ];
  return rows.map(row => {
    const { evidence, ...rest } = row;
    const count = evidence();
    return { ...rest, inEvidence: count > 0, count };
  });
}
