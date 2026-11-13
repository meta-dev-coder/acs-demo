/**
 * What Ask the Twin knows about the Asset Operations & Maintenance screen.
 *
 * The assistant already received a "here" for the TMC — screen, mode, selected incident, resolved
 * resources (see `spatial/twinContext.js`). On this screen it received almost nothing: the subtab,
 * the selected case, the claim and the workflow stage were all invisible to it, so "why did
 * inspection fail?" had no case and "show it on the map" had no it.
 *
 * Two rules carried over from `twinContext.js`, because they are what make the context safe to act
 * on:
 *
 *  1. CONTEXT IS READ FROM THE APPLICATION. Every identifier here came out of the workspace's own
 *     selection state and the validation engine's own output. An id the model invents will not
 *     match anything this offered, so it can be refused.
 *
 *  2. A SYNTHETIC CASE IS NOT A REAL ONE. `isSynthetic` and the source incident's own identity
 *     travel in the context and in the sentences the model reads, so an answer cannot quietly
 *     present ACS-DEMO-005 as something that happened on the corridor.
 *
 * Deliberately LIGHTWEIGHT: identifiers, the current selection and stage statuses. The case file,
 * its findings, its evidence and its audit trail are reached through the capabilities in
 * `caseCapabilities.js`, not pushed into every request.
 *
 * Pure: state in, a serialisable snapshot out. No DOM, no Cesium, no fetching.
 */
import { STAGE_LABELS, STAGE_ORDER, STAGE_STATUS } from '../qcqa/stageValidation.js';
import { OVERALL } from '../acs/acsDemoCases.js';

/** The workspace, named once. */
export const ASSET_OPS_WORKSPACE = 'ASSET_OPERATIONS';

/** The subtab, in the contract's vocabulary rather than the DOM's. */
export const ACTIVE_TABS = Object.freeze({
  operations: 'OPERATIONS_OVERVIEW',
  cases: 'CASE_MANAGEMENT',
  claims: 'CLAIMS_INTELLIGENCE',
});

/** The stage keys the context publishes, beside the engine's own. */
const WORKFLOW_KEYS = Object.freeze({
  INSPECTION: 'inspection', REPAIR: 'repair', QCQA: 'qaQc', CLAIM: 'claim',
});

const text = value => {
  const string = value == null ? '' : String(value).trim();
  return string === '' ? null : string;
};

/**
 * One case, as little of it as the model needs to ask the right question.
 *
 * Everything is read from the evaluation the existing engine produced — no status is decided here,
 * which is what keeps an answer and the workbench from ever disagreeing.
 *
 * @param {object} record the built demo-case record (`demoCase` + `evaluation`)
 * @param {object} [claim] its claim record from `claimsIntelligence.js`, when one is to hand
 */
export function caseContextOf(record, claim = null) {
  if (!record?.evaluation) return null;
  const evaluation = record.evaluation;
  const demoCase = record.demoCase;
  const blocking = evaluation.overall === OVERALL.CLOSED
    ? null
    : STAGE_ORDER.find(stage => evaluation.statuses[stage] !== STAGE_STATUS.PASSED) ?? null;

  return Object.freeze({
    caseId: record.id,
    /** Never absent. Every case on this screen is synthetic, and an answer has to be able to say so. */
    isSynthetic: record.demo !== false,
    demoLabel: record.demoLabel ?? null,
    assetId: text(demoCase?.asset?.assetId),
    assetType: text(demoCase?.asset?.assetType),
    assetName: text(demoCase?.asset?.assetName),
    incidentType: text(demoCase?.incident?.incidentType),
    reportedAt: text(demoCase?.incident?.reportedAt),
    severity: text(demoCase?.incident?.severity),
    /** The real register row whose LOCATION the case reuses. The only non-synthetic id here. */
    sourceIncidentId: text(evaluation.location?.sourceIncidentId),
    sourceIncidentType: text(evaluation.location?.sourceIncidentType),
    segment: text(evaluation.location?.segmentId),
    overall: evaluation.overall,
    statusLabel: evaluation.presentation?.label ?? null,
    tone: evaluation.presentation?.tone ?? null,
    blockingStage: blocking,
    blockingStageLabel: blocking ? STAGE_LABELS[blocking] : null,
    /** The contract's four stages, as the engine derived them. */
    workflow: Object.freeze({
      ...Object.fromEntries(STAGE_ORDER.map(stage => [WORKFLOW_KEYS[stage], evaluation.statuses[stage]])),
      overall: evaluation.overall,
    }),
    /**
     * Which stage each stage is waiting on, where one is.
     *
     * Blocked is not failed: a stage held by an earlier failure has nothing wrong with it, and an
     * assistant that cannot tell the two apart will tell a crew their repair failed when the
     * inspection did.
     */
    blockedBy: Object.freeze(Object.fromEntries(STAGE_ORDER
      .filter(stage => evaluation.statuses[stage] === STAGE_STATUS.BLOCKED)
      .map(stage => [WORKFLOW_KEYS[stage], evaluation.stages[stage]?.gatedBy ?? null]))),
    nextAction: evaluation.nextAction?.text ?? null,
    claimStatus: claim?.status ?? null,
    claimStatusLabel: claim?.statusLabel ?? null,
    claimReference: claim?.claimReference ?? null,
  });
}

/**
 * The screen's context, assembled from the workspace's own state.
 *
 * Returns null when Asset Operations is not the screen in front of the operator, so nothing about
 * this workspace travels with a question asked somewhere else.
 *
 * @param {{tab, detail, selectedCaseId, selectedClaimId, selectedIncidentId, selectedAssetId,
 *   caseContext, caseCount, claimCount, claimsUnavailable, productionClaims}} state
 */
export function assetOpsContextOf(state = {}) {
  const tab = state.tab && tab_in(state.tab) ? state.tab : null;
  if (!tab) return null;
  return Object.freeze({
    workspace: ASSET_OPS_WORKSPACE,
    activeTab: ACTIVE_TABS[tab],
    tab,
    /** Which record surface owns the screen, so the assistant never offers to open a second one. */
    activeDetail: state.detail?.type ?? null,
    selectedCaseId: text(state.selectedCaseId),
    selectedClaimId: text(state.selectedClaimId),
    selectedIncidentId: text(state.selectedIncidentId),
    selectedAssetId: text(state.selectedAssetId),
    /** The selected case, or null — never a case the operator has not chosen. */
    case: state.caseContext ?? null,
    caseCount: Number.isFinite(state.caseCount) ? state.caseCount : null,
    claimCount: Number.isFinite(state.claimCount) ? state.claimCount : null,
    /** Stated rather than left as an absence: "no claims" and "no claims system" differ. */
    claimsUnavailable: text(state.claimsUnavailable),
    productionClaims: state.productionClaims ?? null,
  });
}

const tab_in = tab => Object.hasOwn(ACTIVE_TABS, tab);

/**
 * The context as the sentences a language model reads best.
 *
 * Prose rather than JSON, for the same reason `describeTwinContext` is: a labelled sentence is
 * harder to misread than a nested object, and anything absent is simply not mentioned.
 */
export function describeAssetOps(context) {
  if (!context) return [];
  const lines = [`Asset Operations & Maintenance is open, on the ${context.activeTab} subtab.`];
  const record = context.case;

  if (!record) {
    if (context.tab === 'cases') {
      lines.push(`No case is selected. ${context.caseCount ?? 0} case(s) are in the queue. `
        + 'Answer at the workspace level and do not assume a case.');
    }
    if (context.tab === 'claims') {
      lines.push(context.claimsUnavailable
        ? `No claim is selected and the claims list is unavailable: ${context.claimsUnavailable}`
        : `No claim is selected. ${context.claimCount ?? 0} claim(s) are listed.`);
    }
    if (context.selectedIncidentId) lines.push(`Selected incident record: ${context.selectedIncidentId}.`);
    return lines;
  }

  lines.push(`Selected case: ${record.caseId} — ${record.incidentType ?? 'incident'} affecting `
    + `${record.assetType ?? 'an asset'} (${record.assetName ?? record.assetId ?? 'unnamed'}). `
    + `Overall: ${record.statusLabel ?? record.overall}.`);
  if (record.isSynthetic) {
    lines.push(`${record.caseId} is SYNTHETIC demonstration data (${record.demoLabel ?? 'demo case'}). `
      + 'The damage, inspection, repair, QC/QA and claim it describes did not happen. Say so in any '
      + 'answer about it, and never present its figures as corridor or production data.');
  }
  lines.push('Workflow, as the validation engine derived it: '
    + STAGE_ORDER.map(stage => `${STAGE_LABELS[stage]} ${record.workflow[WORKFLOW_KEYS[stage]]}`).join(', ') + '.');
  for (const [key, gate] of Object.entries(record.blockedBy)) {
    if (gate) {
      lines.push(`The ${key} stage is BLOCKED, not failed: it is held by the ${gate} stage. `
        + 'Nothing is wrong with it and it has no findings of its own.');
    }
  }
  if (record.blockingStageLabel) lines.push(`The case is held at the ${record.blockingStageLabel} stage.`);
  if (record.nextAction) lines.push(`The engine's next action: ${record.nextAction}`);
  if (record.sourceIncidentId) {
    lines.push(`Its LOCATION is borrowed from real register incident ${record.sourceIncidentId}`
      + `${record.sourceIncidentType ? ` (a ${record.sourceIncidentType})` : ''}`
      + ' — a different event from this case. Use that id for anything on the map.');
  }
  if (record.claimStatusLabel) lines.push(`Claim ${record.claimReference ?? ''} status: ${record.claimStatusLabel}.`.replace('  ', ' '));
  return lines;
}

/**
 * The compact indicator the assistant's drawer shows: "ACS-DEMO-005 · Highway Lighting · Closed".
 *
 * The case's own three facts and nothing else. It is a reminder of what is being investigated, not
 * a second case dashboard.
 */
export function contextIndicatorOf(context) {
  if (!context) return null;
  const record = context.case;
  if (!record) {
    const tab = Object.entries(ACTIVE_TABS).find(([, value]) => value === context.activeTab)?.[0];
    return tab === 'cases' ? `Case Management · ${context.caseCount ?? 0} cases · none selected`
      : tab === 'claims' ? `Claims Intelligence · ${context.claimCount ?? 0} claims · none selected`
        : 'Operations Overview';
  }
  return [record.caseId, record.assetType, record.statusLabel ?? record.overall]
    .filter(Boolean).join(' · ');
}

/** Every identifier this screen legitimately offers, so an action can be checked against it. */
export function assetOpsIds(context) {
  const ids = [];
  const add = value => { if (text(value)) ids.push(String(value)); };
  add(context?.selectedCaseId);
  add(context?.selectedClaimId);
  add(context?.selectedIncidentId);
  add(context?.selectedAssetId);
  add(context?.case?.caseId);
  add(context?.case?.assetId);
  add(context?.case?.sourceIncidentId);
  add(context?.case?.claimReference);
  return ids;
}

/* ── contextual suggestions ──────────────────────────────────────────────────────────────────── */

const CLAIMS_SUGGESTIONS = Object.freeze([
  'Which claims need attention?',
  'Which assets have repeated claims?',
  'Show outstanding financial exposure.',
  'Which claims are missing supporting documents?',
]);

const OPERATIONS_SUGGESTIONS = Object.freeze([
  'How many incidents are linked to a corridor asset?',
  'Which assets have repeated damage?',
  'How many repairs are still open?',
  'Which inspections are unresolved?',
]);

const QUEUE_SUGGESTIONS = Object.freeze([
  'Which cases need action?',
  'Which cases are blocked, and by what?',
  'Which stage holds up the most cases?',
  'Which cases are closed?',
]);

/** Per failed stage, the four questions that stage actually raises. */
const FAILED_STAGE_SUGGESTIONS = Object.freeze({
  INSPECTION: Object.freeze([
    'Why did inspection fail?',
    'What evidence is missing?',
    'Can you find the missing inspection records?',
    'What is the next required action?',
  ]),
  REPAIR: Object.freeze([
    'Why did repair validation fail?',
    'Which work order is associated?',
    'What documentation is missing?',
    'Can you locate related repair evidence?',
  ]),
  QCQA: Object.freeze([
    'Which checks failed?',
    'What acceptance criteria were violated?',
    'What corrective work is required?',
    'Is reinspection needed?',
  ]),
  CLAIM: Object.freeze([
    'Why is this claim blocked?',
    'Which supporting documents are missing?',
    'What has been claimed and recovered?',
    'What is the next required action?',
  ]),
});

const CLOSED_SUGGESTIONS = Object.freeze([
  'Summarize the complete case.',
  'Was every validation stage completed?',
  'What was the final claim recovery?',
  'Show the audit history.',
]);

/**
 * The questions worth offering, for the case actually open.
 *
 * Derived, never a fixed list: a case blocked at repair by a failed inspection is offered the
 * inspection's questions, because that is the stage with something wrong with it. Two cases in
 * different states never get the same four chips.
 */
export function caseSuggestionsFor(context) {
  if (!context) return [];
  const record = context.case;
  if (!record) {
    return context.tab === 'claims' ? CLAIMS_SUGGESTIONS
      : context.tab === 'cases' ? QUEUE_SUGGESTIONS : OPERATIONS_SUGGESTIONS;
  }
  if (record.overall === OVERALL.CLOSED) return CLOSED_SUGGESTIONS;

  // The stage with a failure in it, which is not necessarily the stage the case is held at.
  const failed = STAGE_ORDER.find(stage => record.workflow[WORKFLOW_KEYS[stage]] === STAGE_STATUS.FAILED);
  if (failed) return FAILED_STAGE_SUGGESTIONS[failed];

  const held = record.blockingStage;
  const waiting = held ? record.workflow[WORKFLOW_KEYS[held]] : null;
  if (held && waiting === STAGE_STATUS.IN_PROGRESS) {
    return Object.freeze([
      `What remains to complete the ${STAGE_LABELS[held].toLowerCase()} stage?`,
      'What evidence is still missing?',
      'Can you find the missing records?',
      'Is this case ready for claim submission?',
    ]);
  }
  if (held) {
    return Object.freeze([
      `Why is the ${STAGE_LABELS[held].toLowerCase()} stage ${String(waiting ?? 'waiting').toLowerCase()}?`,
      'What is the next required action?',
      'What evidence is missing?',
      'Summarize the complete case.',
    ]);
  }
  return CLOSED_SUGGESTIONS;
}

export { WORKFLOW_KEYS, CLAIMS_SUGGESTIONS, OPERATIONS_SUGGESTIONS, QUEUE_SUGGESTIONS };
