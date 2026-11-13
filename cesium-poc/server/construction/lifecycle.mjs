/**
 * The construction lifecycle of one real OpenProject work package.
 *
 * Plan → Link BIM → Execute → Verify Progress → Approve → Synchronise & Close.
 *
 * EVERY STAGE HAS AN EXPLICIT RULE, and none of them is "percentComplete". That is the whole
 * point of this module: OpenProject's `percentageDone` is one number a planner typed, and reading
 * a six-stage lifecycle out of it would invent five facts. Work package 38 on the live instance
 * is the standing proof — it reports **35% complete while its status is still "New"** — so the
 * number and the status do not even agree with each other, let alone with whether a BIM mapping
 * has been approved or a site measurement verified.
 *
 * Each stage answers a different question from a different record:
 *
 *   Plan        does the activity have the schedule information it needs?   (source fields)
 *   Link BIM    has a BIM Coordinator APPROVED a mapping?                   (speckle_element_activity)
 *   Execute     what does the source say about execution?                   (source fields)
 *   Verify      has a submission been verified?                             (progress records)
 *   Approve     has the Planner decided?                                    (outbound_proposal)
 *   Close       did the source confirm the update, and did it reconcile?    (outbound_attempt)
 *
 * A stage with no record says NOT_STARTED. It never says "complete" on the strength of another
 * stage's data, and it never reports a stage as done because the activity looks finished.
 */
import { MAPPING_STATUS } from './speckleStore.mjs';

/** What a stage can be. `BLOCKED` is reserved for a stage that cannot proceed, not one unstarted. */
export const STAGE_STATUS = Object.freeze({
  NOT_STARTED: 'NOT_STARTED',
  ACTION_REQUIRED: 'ACTION_REQUIRED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  BLOCKED: 'BLOCKED',
});

export const STAGES = Object.freeze([
  { id: 'plan', label: 'Plan' },
  { id: 'linkBim', label: 'Link BIM' },
  { id: 'execute', label: 'Execute' },
  { id: 'verify', label: 'Verify Progress' },
  { id: 'approve', label: 'Approve' },
  { id: 'close', label: 'Synchronise & Close' },
]);

/**
 * The fields OpenProject will actually accept, confirmed against the live instance's schema
 * rather than assumed.
 *
 *   GET /api/v3/work_packages/schemas/3-1  →  writable: percentageDone, status, startDate,
 *   dueDate, estimatedTime, remainingTime, subject, assignee, priority, parent …
 *   read-only: spentTime, derivedPercentageDone, lockVersion, createdAt, updatedAt
 *
 * `spentTime` is NOT writable — it is derived from time entries — so no proposal may ever carry
 * it. The lifecycle only ever proposes `percentageDone`; the rest are listed so a later phase can
 * widen the allowlist deliberately rather than by accident.
 */
export const OPENPROJECT_WRITABLE = Object.freeze([
  'percentageDone', 'status', 'startDate', 'dueDate', 'estimatedTime', 'remainingTime', 'subject',
]);
export const OPENPROJECT_READ_ONLY = Object.freeze([
  'spentTime', 'derivedPercentageDone', 'derivedEstimatedTime', 'derivedRemainingTime',
  'lockVersion', 'createdAt', 'updatedAt', 'author', 'id',
]);
/** What the lifecycle is allowed to propose today. Deliberately one field. */
export const PROPOSABLE_FIELDS = Object.freeze(['percentageDone']);

/**
 * OpenProject has no actual-start / actual-finish field.
 *
 * The schema has `startDate` and `dueDate` — both PLANNED — and nothing else. Reporting an
 * "actual finish" would mean inventing one, so the lifecycle reports it as unavailable and says
 * why. Same for a baseline: this instance stores no baseline, so a delay cannot be computed
 * against one.
 */
export const UNAVAILABLE = Object.freeze({
  actualDates: 'Not available — OpenProject has no actual-start or actual-finish field. '
    + 'startDate and dueDate are planned dates.',
  baseline: 'Not configured — no schedule baseline is stored in this OpenProject instance, so '
    + 'delay against a baseline cannot be calculated.',
  dependencies: 'Not available — no relations are published for this work package.',
});

/*
 * The same activity arrives under two field spellings — the normalized work package
 * (`workPackageId` / `subject`) and the stored snapshot row (`externalActivityId` /
 * `activityName`). Reading only one of them silently produced "this work package" in every
 * remedy on the overview, which is exactly the generic text this is meant to replace.
 */
const id = activity => activity?.workPackageId ?? activity?.externalActivityId ?? null;
const name = activity => String(activity?.subject ?? activity?.activityName ?? '').trim();

const asNumber = value => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Does the source contradict itself?
 *
 * The real case this exists for: WP 38 reports 35% done with status "New". Neither value is
 * changed — OpenProject is authoritative for both — but a screen that shows them side by side
 * without comment invites the reader to pick one.
 */
export function statusProgressConflict(activity) {
  const pct = asNumber(activity?.reportedProgressPct);
  const status = String(activity?.status ?? '').trim();
  if (pct == null || !status) return null;
  const lower = status.toLowerCase();
  const openish = ['new', 'to be scheduled', 'scheduled', 'on hold'].includes(lower);
  const closedish = ['closed', 'rejected'].includes(lower);
  /*
   * The remedy names THIS activity's two values, and names them FIRST.
   *
   * The attention list is mostly one issue kind — seventeen of eighteen activities on this
   * instance contradict themselves — so a shared sentence repeated down the column tells the
   * reader nothing the severity chip had not already said. What they need is which of the two
   * values in front of them to change, on which work package. The identifying part leads, so it
   * survives the column's truncation.
   */
  const ref = id(activity) ? `#${id(activity)}` : 'this work package';
  const called = name(activity) ? `"${name(activity)}"` : 'this activity';
  if (pct > 0 && openish) {
    return { kind: 'PROGRESS_WITHOUT_START',
      detail: `Reported ${pct}% complete while the OpenProject status is still "${status}". `
        + 'Status and progress require review.',
      remedy: pct >= 100
        ? `${called} (${ref}) is 100% but still "${status}" — close it in OpenProject, or lower `
          + 'the percentage if it is not finished.'
        : `${called} (${ref}) is ${pct}% but still "${status}" — move it to an in-progress `
          + `status in OpenProject, or clear the ${pct}% if work has not started.`,
    };
  }
  if (pct < 100 && closedish) {
    return { kind: 'CLOSED_WHILE_INCOMPLETE',
      detail: `The OpenProject status is "${status}" but progress is ${pct}%. `
        + 'Status and progress require review.',
      remedy: `${called} (${ref}) is "${status}" at ${pct}% — raise it to 100% in OpenProject if `
        + `it is finished, or reopen it for the remaining ${100 - pct}%.`,
    };
  }
  return null;
}

const stage = (id, label, status, detail, extra = {}) =>
  ({ id, label, status, detail, ...extra });

/**
 * Compute every stage for one activity.
 *
 * @param {object} activity the normalized OpenProject work package (from the live snapshot)
 * @param {object} records the persisted records that decide the later stages
 */
export function lifecycleFor(activity, records = {}) {
  const { mappings = [], submissions = [], proposals = [], attempts = [] } = records;
  const pct = asNumber(activity?.reportedProgressPct);

  /* Plan — does it have what a plan needs? Dates only; nothing is inferred. */
  const hasStart = Boolean(activity?.plannedStart);
  const hasFinish = Boolean(activity?.plannedFinish);
  const planMissing = [!hasStart && 'planned start', !hasFinish && 'planned finish']
    .filter(Boolean);
  const plan = stage('plan', 'Plan',
    planMissing.length ? STAGE_STATUS.ACTION_REQUIRED : STAGE_STATUS.COMPLETED,
    planMissing.length
      ? `Missing ${planMissing.join(' and ')} in OpenProject.`
      : `Planned ${activity.plannedStart} → ${activity.plannedFinish}.`,
    { missing: planMissing });

  /* Link BIM — an APPROVED mapping, decided by a person. Never inferred from a name match. */
  const approved = mappings.filter(entry => entry.status === MAPPING_STATUS.APPROVED);
  const proposed = mappings.filter(entry => entry.status === MAPPING_STATUS.PROPOSED);
  const linkBim = stage('linkBim', 'Link BIM',
    approved.length ? STAGE_STATUS.COMPLETED
      : proposed.length ? STAGE_STATUS.IN_PROGRESS
        : STAGE_STATUS.ACTION_REQUIRED,
    approved.length
      ? `${approved.length} approved BIM element mapping(s).`
      : proposed.length
        ? `${proposed.length} mapping(s) proposed and awaiting a BIM Coordinator's decision.`
        : 'No BIM elements are linked to this activity yet.',
    { approved: approved.length, proposed: proposed.length,
      rejected: mappings.filter(e => e.status === MAPPING_STATUS.REJECTED).length });

  /*
   * Execute — what the SOURCE reports, and nothing more.
   *
   * 100% here means OpenProject says 100%. It does not mean the work is verified, and it does
   * NOT close the activity: §6's rule is that nothing is auto-closed on the strength of a
   * percentage.
   */
  const conflict = statusProgressConflict(activity);
  const execute = stage('execute', 'Execute',
    conflict ? STAGE_STATUS.ACTION_REQUIRED
      : pct == null ? STAGE_STATUS.NOT_STARTED
        : pct <= 0 ? STAGE_STATUS.NOT_STARTED
          : pct >= 100 ? STAGE_STATUS.COMPLETED
            : STAGE_STATUS.IN_PROGRESS,
    conflict ? conflict.detail
      : pct == null ? 'OpenProject reports no progress figure.'
        : `OpenProject reports ${pct}% complete, status "${activity.status ?? 'unknown'}".`,
    { reportedPct: pct, sourceStatus: activity?.status ?? null, conflict });

  /* Verify — a site submission that somebody checked. */
  const verified = submissions.filter(entry => entry.status === 'VERIFIED');
  const pending = submissions.filter(entry => ['SUBMITTED', 'UNDER_REVIEW'].includes(entry.status));
  const verify = stage('verify', 'Verify Progress',
    verified.length ? STAGE_STATUS.COMPLETED
      : pending.length ? STAGE_STATUS.ACTION_REQUIRED
        : STAGE_STATUS.NOT_STARTED,
    verified.length
      ? `${verified.length} verified progress submission(s).`
      : pending.length
        ? `${pending.length} submission(s) awaiting verification.`
        : 'No field progress has been submitted for this activity.',
    { verified: verified.length, pending: pending.length, total: submissions.length });

  /* Approve — a Planner decision on a proposal. */
  const approvedProposals = proposals.filter(entry => entry.status === 'APPROVED'
    || entry.status === 'POSTED');
  const awaiting = proposals.filter(entry => entry.status === 'SUBMITTED');
  const approve = stage('approve', 'Approve',
    approvedProposals.length ? STAGE_STATUS.COMPLETED
      : awaiting.length ? STAGE_STATUS.ACTION_REQUIRED
        : STAGE_STATUS.NOT_STARTED,
    approvedProposals.length
      ? `${approvedProposals.length} approved progress proposal(s).`
      : awaiting.length
        ? `${awaiting.length} proposal(s) awaiting the Project Planner.`
        : 'No progress update has been proposed for this activity.',
    { approved: approvedProposals.length, awaiting: awaiting.length });

  /*
   * Close — the source CONFIRMED it, and the confirmation reconciled.
   *
   * A 2xx from the API is not enough. The rule (§11) is that the work package is re-read and the
   * value compared, so this stage only completes on a reconciled attempt.
   */
  const reconciled = attempts.filter(entry => entry.reconciled === true);
  const posted = attempts.filter(entry => entry.posted === true);
  const close = stage('close', 'Synchronise & Close',
    reconciled.length ? STAGE_STATUS.COMPLETED
      : posted.length ? STAGE_STATUS.IN_PROGRESS
        : approvedProposals.length ? STAGE_STATUS.ACTION_REQUIRED
          : STAGE_STATUS.NOT_STARTED,
    reconciled.length
      ? `Source updated and reconciled (${reconciled.length} attempt(s)).`
      : posted.length
        ? 'The update was sent but has not been confirmed against a re-read of the source.'
        : approvedProposals.length
          ? 'Approved and waiting to be written back to OpenProject.'
          : 'Nothing to synchronise.',
    { posted: posted.length, reconciled: reconciled.length });

  const stages = [plan, linkBim, execute, verify, approve, close];
  return {
    stages,
    /** The first stage that needs somebody to do something. What the screen should open on. */
    currentStageId: (stages.find(entry => entry.status === STAGE_STATUS.ACTION_REQUIRED)
      ?? stages.find(entry => entry.status === STAGE_STATUS.IN_PROGRESS)
      ?? stages.find(entry => entry.status === STAGE_STATUS.NOT_STARTED)
      ?? stages[stages.length - 1]).id,
    completedStages: stages.filter(entry => entry.status === STAGE_STATUS.COMPLETED).length,
    totalStages: stages.length,
    /** Said on every lifecycle, because the temptation is to read it as a completion bar. */
    note: 'Stage completion describes the WORKFLOW, not the building. "Execute completed" means '
      + 'OpenProject reports 100%; it does not mean the work has been verified on site.',
  };
}

/**
 * The issues worth a person's attention for one activity.
 *
 * Each carries its evidence and the role that can act, because a list of problems with no owner
 * is a list nobody clears.
 */
export function issuesFor(activity, records = {}, lifecycle = null) {
  const cycle = lifecycle ?? lifecycleFor(activity, records);
  const byId = Object.fromEntries(cycle.stages.map(entry => [entry.id, entry]));
  const issues = [];

  const conflict = byId.execute.conflict;
  if (conflict) {
    issues.push({
      kind: conflict.kind, severity: 'HIGH',
      problem: 'Status and progress disagree',
      evidence: conflict.detail,
      role: 'Project Planner (P6)',
      // The specific remedy, not a generic one. Nothing here writes to OpenProject.
      action: conflict.remedy,
      status: 'OPEN',
    });
  }
  if (byId.linkBim.status === STAGE_STATUS.ACTION_REQUIRED) {
    issues.push({
      kind: 'MISSING_BIM_MAPPING', severity: 'MEDIUM',
      problem: 'No BIM elements are linked',
      evidence: 'No approved mapping exists between this activity and any IFC element, so its '
        + 'progress cannot be shown on the model and no element-level reporting is possible.',
      role: 'BIM Coordinator',
      action: `Open Link BIM on ${id(activity) ? `#${id(activity)}` : 'this activity'} and `
        + `approve the IFC elements that build ${name(activity)
          ? `"${name(activity)}"` : 'it'}.`,
      status: 'OPEN',
    });
  }
  if (byId.linkBim.status === STAGE_STATUS.IN_PROGRESS) {
    issues.push({
      kind: 'MAPPING_AWAITING_DECISION', severity: 'LOW',
      problem: 'BIM mapping awaiting approval',
      evidence: `${byId.linkBim.proposed} proposed mapping(s) have not been decided.`,
      role: 'BIM Coordinator', action: 'Approve or reject the proposed mappings.', status: 'OPEN',
    });
  }
  if (byId.verify.status === STAGE_STATUS.ACTION_REQUIRED) {
    issues.push({
      kind: 'PROGRESS_AWAITING_VERIFICATION', severity: 'MEDIUM',
      problem: 'Field progress awaiting verification',
      evidence: `${byId.verify.pending} submission(s) are waiting to be checked.`,
      role: 'Project Planner (P6)', action: 'Review the submission and its evidence.',
      status: 'OPEN',
    });
  }
  if (byId.approve.status === STAGE_STATUS.ACTION_REQUIRED) {
    issues.push({
      kind: 'APPROVAL_PENDING', severity: 'MEDIUM',
      problem: 'Progress proposal awaiting the Planner',
      evidence: `${byId.approve.awaiting} proposal(s) submitted and not decided.`,
      role: 'Project Planner (P6)', action: 'Approve, reject or request clarification.',
      status: 'OPEN',
    });
  }
  if (byId.plan.status === STAGE_STATUS.ACTION_REQUIRED) {
    issues.push({
      kind: 'INCOMPLETE_PLAN', severity: 'LOW',
      problem: 'Schedule information is incomplete',
      evidence: byId.plan.detail,
      role: 'Project Planner (P6)',
      action: 'Set the missing dates in OpenProject.', status: 'OPEN',
    });
  }
  return issues;
}

/**
 * Is a date in the past relative to the reporting date, with work outstanding?
 *
 * The closest thing to "delayed" this data supports. There is NO baseline in this OpenProject
 * instance, so this is measured against the CURRENT planned finish and is labelled as such —
 * calling it "delay against baseline" would be a claim the data cannot support.
 */
export function overdue(activity, onDate) {
  const finish = activity?.plannedFinish;
  const pct = asNumber(activity?.reportedProgressPct) ?? 0;
  if (!finish || pct >= 100) return null;
  const asOf = onDate ? new Date(onDate) : new Date();
  const due = new Date(`${finish}T23:59:59Z`);
  if (Number.isNaN(due.getTime()) || due >= asOf) return null;
  const days = Math.floor((asOf - due) / 86_400_000);
  return { days, plannedFinish: finish, reportedPct: pct,
    basis: 'measured against the CURRENT planned finish, not a baseline — this OpenProject '
      + 'instance stores no baseline' };
}
