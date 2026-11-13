/**
 * What the Case Workbench shows, worked out once.
 *
 * The workbench replaced four surfaces that each rendered the same case — a slider card, a floating
 * details panel, a modal header and the modal's Overview tab. The rule that replaced them is
 * single-source-of-presentation, and it is enforced here rather than by remembering: a queue row
 * gets `queueRow()` and nothing else, the header gets `headerOf()`, and the sections get their own
 * slices. No function returns a field another one already owns.
 *
 * Pure: no DOM, no fetching. Everything is derived from the evaluation the existing validation
 * engine produced, so a status shown here is the same status the engine reached.
 */
import { STATUS } from '../qcqa/schema.js';
import { STAGE_LABELS, STAGE_ORDER, STAGE_STATUS } from '../qcqa/stageValidation.js';
import { OVERALL, STAGE_PRESENTATION } from '../acs/acsDemoCases.js';

/**
 * An asset name as a reader should see it.
 *
 * The demo fixtures carry a "(synthetic)" suffix on every asset name, which is true but is said
 * in the wrong place: it is a fact about the whole dataset, not about this attenuator, and
 * repeating it on every case line reads as though some assets were synthetic and others were not.
 * The provenance belongs with the dataset, and Ask the Twin is still told plainly that these
 * cases are synthetic (see assetOpsContext).
 */
export const plainName = value =>
  String(value ?? '').replace(/\s*\((?:synthetic|demo)\)\s*$/i, '').trim();

/** The four buckets the queue filters by, and what each one means in engine terms. */
export const QUEUE_FILTERS = Object.freeze([
  Object.freeze({ id: 'all', label: 'All' }),
  Object.freeze({ id: 'action', label: 'Needs action' }),
  Object.freeze({ id: 'progress', label: 'In progress' }),
  Object.freeze({ id: 'closed', label: 'Closed' }),
]);

/**
 * Which bucket a case is in.
 *
 * `blocked` in the presentation vocabulary means a failure is holding the case; `open` means work
 * is under way or waiting. A waiting case is never "needs action" — nobody is late, and the whole
 * point of the pending/failed distinction is that it survives into the queue.
 */
export function queueBucketOf(evaluation) {
  const group = evaluation?.presentation?.group ?? 'open';
  if (group === 'closed') return 'closed';
  return group === 'blocked' ? 'action' : 'progress';
}

/** The stage holding the case up, or null when nothing is. */
export function blockingStageOf(evaluation) {
  if (evaluation?.overall === OVERALL.CLOSED) return null;
  return STAGE_ORDER.find(stage => evaluation.statuses[stage] !== STAGE_STATUS.PASSED) ?? null;
}

/** When anything last happened on the case, from its own trail. */
export function lastActivityOf(demoCase) {
  const trail = demoCase?.auditTrail ?? [];
  return trail.length ? trail[trail.length - 1].at : null;
}

/**
 * One row of the queue.
 *
 * Deliberately six fields. The row used to carry the incident description and all four lifecycle
 * statuses; both are the workbench's job, and repeating them made a list nobody could scan.
 */
export function queueRow(record, { positionOf = null } = {}) {
  const evaluation = record.evaluation;
  const stage = blockingStageOf(evaluation);
  const location = evaluation.location;
  const position = positionOf && Number.isFinite(location.longitude)
    ? positionOf(location.longitude, location.latitude) : null;
  return Object.freeze({
    caseId: record.id,
    assetType: record.demoCase.asset.assetType,
    segment: location.segmentId,
    /** Measured along the corridor centerline. Not an FDOT milepost, and labelled as such. */
    corridorMile: Number.isFinite(position?.milepost) ? position.milepost : null,
    blockingStage: stage,
    blockingStageLabel: stage ? STAGE_LABELS[stage] : null,
    status: evaluation.presentation.label,
    tone: evaluation.presentation.tone,
    bucket: queueBucketOf(evaluation),
    lastActivity: lastActivityOf(record.demoCase),
    // Carried for the filters, never rendered on the row.
    incidentType: record.demoCase.incident.incidentType,
    severity: record.demoCase.incident.severity,
    reportedAt: record.demoCase.incident.reportedAt,
  });
}

const distinct = (rows, read) =>
  Object.freeze([...new Set(rows.map(read).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b))));

/** The filter choices the loaded cases actually offer — never a hard-coded list. */
export function queueFacets(rows) {
  return Object.freeze({
    incidentType: distinct(rows, row => row.incidentType),
    assetType: distinct(rows, row => row.assetType),
    stage: Object.freeze(STAGE_ORDER.filter(stage => rows.some(row => row.blockingStage === stage))),
    severity: distinct(rows, row => row.severity),
  });
}

const day = value => String(value ?? '').slice(0, 10);

/** Narrow the queue. An unset filter removes nothing; a search matches the row's own fields only. */
export function filterQueue(rows, filters = {}) {
  const query = String(filters.query ?? '').trim().toLowerCase();
  return Object.freeze(rows.filter(row => {
    if (filters.bucket && filters.bucket !== 'all' && row.bucket !== filters.bucket) return false;
    if (filters.incidentType && row.incidentType !== filters.incidentType) return false;
    if (filters.assetType && row.assetType !== filters.assetType) return false;
    if (filters.stage && row.blockingStage !== filters.stage) return false;
    if (filters.severity && row.severity !== filters.severity) return false;
    if (filters.from && day(row.reportedAt) < filters.from) return false;
    if (filters.to && day(row.reportedAt) > filters.to) return false;
    if (query && ![row.caseId, row.assetType, row.incidentType, row.segment, row.status]
      .some(value => String(value ?? '').toLowerCase().includes(query))) return false;
    return true;
  }));
}

/** How many cases sit in each bucket, for the filter chips. Counted, never written down. */
export function bucketCounts(rows) {
  return Object.freeze(Object.fromEntries(QUEUE_FILTERS.map(filter =>
    [filter.id, filter.id === 'all' ? rows.length : rows.filter(row => row.bucket === filter.id).length])));
}

/* ── the workbench ───────────────────────────────────────────────────────────────────────────── */

/** The header. The only place the case's identity, location and overall status are stated. */
export function headerOf(record, { positionOf = null } = {}) {
  const evaluation = record.evaluation;
  const location = evaluation.location;
  const position = positionOf && Number.isFinite(location.longitude)
    ? positionOf(location.longitude, location.latitude) : null;
  const stage = blockingStageOf(evaluation);
  return Object.freeze({
    caseId: record.id,
    demoLabel: record.demoLabel,
    summary: `${record.demoCase.incident.incidentType} · ${plainName(record.demoCase.asset.assetName)}`,
    assetId: record.demoCase.asset.assetId,
    reportedAt: record.demoCase.incident.reportedAt,
    location: Object.freeze({
      roadway: location.roadway,
      segment: location.segmentId,
      direction: location.direction,
      corridorMile: Number.isFinite(position?.milepost) ? position.milepost : null,
      sourceIncidentId: location.sourceIncidentId,
      note: location.note,
      hasPosition: Number.isFinite(location.longitude),
    }),
    status: evaluation.presentation.label,
    tone: evaluation.presentation.tone,
    blockingStage: stage,
    blockingStageLabel: stage ? STAGE_LABELS[stage] : null,
    nextAction: evaluation.nextAction.text,
    /** The four-stage strip. The only lifecycle summary in the workbench. */
    stages: Object.freeze(STAGE_ORDER.map(key => Object.freeze({
      key, label: STAGE_LABELS[key],
      status: evaluation.statuses[key],
      presentation: STAGE_PRESENTATION[evaluation.statuses[key]],
      current: key === stage,
      /**
       * Blocked is not failed.
       *
       * A blocked stage has no findings of its own and nothing wrong with it — an earlier stage
       * does. Carrying the gate lets the tile say "held by repair" instead of "0 failed · 0
       * missing · 0 passed", which reads as a stage that was checked and found empty.
       */
      blockedBy: evaluation.statuses[key] === STAGE_STATUS.BLOCKED
        ? evaluation.stages[key].gatedBy ?? null : null,
      /** So a tile says what is behind it before it is opened — passed stages included. */
      counts: Object.freeze({
        failed: evaluation.stages[key].summary.failed,
        missing: evaluation.stages[key].summary.missing,
        passed: evaluation.stages[key].summary.passed,
      }),
    }))),
  });
}

/**
 * The Action Required section.
 *
 * Assembled from the engine's own explanation and findings. Nothing here is written per case: the
 * seven outcomes the brief lists all fall out of `explainDemoCase`, the stage findings and the
 * recovery outlook.
 */
export function actionRequiredOf(record, { recovery = null } = {}) {
  const evaluation = record.evaluation;
  const stage = blockingStageOf(evaluation);
  const explanation = evaluation.explanation;
  const findings = stage ? evaluation.stages[stage].findings : [];
  const failed = findings.filter(field => field.status === STATUS.FAIL);
  const missing = findings.filter(field => field.status === STATUS.MISSING && field.required);
  const ncrs = (record.demoCase.qualityAssurance?.nonConformances ?? []).filter(entry => entry.status === 'OPEN');
  const outlook = record.outlook ?? null;

  return Object.freeze({
    resolved: evaluation.overall === OVERALL.CLOSED,
    stage,
    stageLabel: stage ? STAGE_LABELS[stage] : null,
    /** What failed or is pending. */
    detection: explanation.detection,
    /** Why it matters. */
    impact: explanation.impact,
    /** The one thing to do next. */
    action: evaluation.nextAction.text,
    recommended: explanation.action,
    role: record.demoCase.workflow?.assignedRole?.replace(/_/g, ' ') ?? null,
    team: record.demoCase.workflow?.assignedTeam ?? null,
    failed: Object.freeze(failed.map(field => Object.freeze({
      fieldId: field.fieldId, label: field.label, message: field.message ?? null,
    }))),
    /**
     * The evidence required, and whether another system looks likely to hold it.
     *
     * `recoverable` is only ever a prospect. A document found is not a document checked, and
     * nothing here changes the stage's status.
     */
    evidenceRequired: Object.freeze(missing.map(field => Object.freeze({
      fieldId: field.fieldId, label: field.label,
      recoverable: recoveryStateFor(field.fieldId, recovery),
    }))),
    nonConformances: Object.freeze(ncrs),
    counts: Object.freeze({
      failed: failed.length, missing: missing.length,
      recoverable: outlook?.recoverable ?? 0, unresolved: outlook?.unresolved ?? 0,
    }),
  });
}

/** What the recovery search has to say about one missing field, if it has run. */
export function recoveryStateFor(fieldId, recovery) {
  if (!recovery) return null;
  const gap = recovery.gaps.find(entry => entry.fieldId === fieldId);
  if (!gap) return null;
  if (gap.humanOnly) return Object.freeze({ state: 'HUMAN_ONLY', reason: gap.humanOnly.reason });
  if (!gap.resolvable) {
    return Object.freeze({ state: 'NOT_FOUND',
      reason: 'No system that answered holds a record for this field.' });
  }
  return Object.freeze({
    state: gap.requiresReview ? 'NEEDS_REVIEW' : 'CANDIDATE',
    reason: gap.reviewReason ?? null,
    best: gap.best,
    candidates: gap.candidates,
  });
}

/**
 * Which stages the Validation & Evidence timeline opens on.
 *
 * The failed or active stage, because that is what the operator came for. A passed stage is
 * collapsed — it has nothing outstanding — and so is a stage that cannot start yet.
 */
export function openStagesFor(evaluation) {
  const open = STAGE_ORDER.filter(stage =>
    evaluation.statuses[stage] === STAGE_STATUS.FAILED
    || evaluation.statuses[stage] === STAGE_STATUS.IN_PROGRESS);
  if (open.length) return Object.freeze(open);
  // Nothing failed and nothing is running: open the stage the case is waiting on, if any.
  const blocking = blockingStageOf(evaluation);
  return Object.freeze(blocking ? [blocking] : []);
}

/** Findings worst first, so a reader never scrolls past twenty passes to find the one failure. */
const FINDING_ORDER = Object.freeze([STATUS.FAIL, STATUS.MISSING, STATUS.PENDING, STATUS.BLOCKED,
  STATUS.PASS, STATUS.NOT_APPLICABLE, STATUS.NOT_EVALUATED]);

export function orderedFindings(stage) {
  const rank = status => {
    const at = FINDING_ORDER.indexOf(status);
    return at < 0 ? FINDING_ORDER.length : at;
  };
  return Object.freeze([...(stage?.findings ?? [])].sort((a, b) =>
    rank(a.status) - rank(b.status) || String(a.label).localeCompare(String(b.label))));
}

/** One timeline entry per stage, with its findings and the evidence offered against each gap. */
export function validationTimeline(record, { recovery = null } = {}) {
  const evaluation = record.evaluation;
  const open = new Set(openStagesFor(evaluation));
  return Object.freeze(STAGE_ORDER.map(key => {
    const stage = evaluation.stages[key];
    return Object.freeze({
      key, label: STAGE_LABELS[key],
      status: stage.status,
      presentation: STAGE_PRESENTATION[stage.status],
      summary: stage.summary,
      gatedBy: stage.gatedBy,
      expanded: open.has(key),
      findings: Object.freeze(orderedFindings(stage).map(field => Object.freeze({
        ...field, recovery: field.status === STATUS.MISSING ? recoveryStateFor(field.fieldId, recovery) : null,
      }))),
    });
  }));
}

/** Only the sections that have something to say. An empty section is not drawn. */
export const WORKBENCH_SECTIONS = Object.freeze([
  Object.freeze({ id: 'action', label: 'Action required' }),
  Object.freeze({ id: 'validation', label: 'Validation & evidence' }),
  Object.freeze({ id: 'context', label: 'Incident context' }),
  Object.freeze({ id: 'claim', label: 'Claim & financial summary' }),
  Object.freeze({ id: 'history', label: 'Activity history' }),
]);
