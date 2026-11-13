/**
 * The Case Enrichment Orchestrator.
 *
 * One flow, used by every stage of every case:
 *
 *   1. read the validation result and list what is MISSING, with the evidence type each gap needs;
 *   2. ask every connected system for records that could fill those gaps;
 *   3. rank what comes back with the configurable matching rules;
 *   4. propose exact matches, and send everything else to a reviewer;
 *   5. attach only what a reviewer accepted — as an overlay, never over the original record;
 *   6. run the validation again and report what changed.
 *
 * THE SAFETY RULES, all enforced here rather than in the screen that draws the result:
 *
 *   - Only a MISSING field can be filled. A FAIL is a recorded value that did not satisfy its
 *     rule, and no amount of recovered paperwork turns it into a pass — that is the difference
 *     between finding a lost document and overturning a failed measurement.
 *   - A field the case marks as requiring a human act (a technician's confirmation, a QC
 *     signature) can never be satisfied by a recovered record, whatever is found.
 *   - Nothing is attached without an explicit decision. Exact matches are PRE-SELECTED for the
 *     reviewer, which is not the same as applied.
 *   - The original case is never mutated. Accepted evidence is an overlay the re-validation reads.
 */
import { STATUS } from '../../qcqa/stageValidation.js';
import { MATCH_RULES, MATCH_TIER, rankCandidates } from './matching.js';
import { AUDIT_EVENTS, createAuditLog } from './auditLog.js';
import { SEARCH_STATUS, SYSTEM_LABELS } from './connectors.js';

export { MATCH_TIER, SEARCH_STATUS, SYSTEM_LABELS, AUDIT_EVENTS };

/** What a gap needs, in words, by the field's own data type. */
const EVIDENCE_TYPES = Object.freeze({
  attachment: 'A document or photograph',
  approval: 'A signed approval record',
  currency: 'A cost figure with its backing document',
  date: 'A recorded date',
  number: 'A recorded measurement',
  enum: 'A recorded answer',
  checklist: 'A completed checklist response',
  text: 'A written record',
});

export const evidenceTypeOf = field => EVIDENCE_TYPES[field?.dataType] ?? EVIDENCE_TYPES.text;

/** The stage a field belongs to, for grouping the gaps. */
const STAGE_OF_FIELD = Object.freeze({ insp: 'INSPECTION', rep: 'REPAIR', clm: 'CLAIM' });
const stageOfFieldId = fieldId => STAGE_OF_FIELD[String(fieldId).split('_')[0]] ?? 'QCQA';

/**
 * Every gap in a case, from the validation result.
 *
 * Only MISSING. A PENDING field is not due yet and a BLOCKED one cannot exist, so searching for
 * either would be reporting a team as late for work nobody has asked them for.
 */
export function missingEvidence(evaluation) {
  const out = [];
  for (const [stage, evaluated] of Object.entries(evaluation?.stages ?? {})) {
    for (const field of evaluated.findings ?? []) {
      if (field.status !== STATUS.MISSING) continue;
      out.push(Object.freeze({
        stage,
        fieldId: field.fieldId,
        label: field.label,
        dataType: field.dataType ?? 'text',
        evidenceType: evidenceTypeOf(field),
        reason: field.message,
      }));
    }
  }
  return Object.freeze(out);
}

/** The identifiers a search is run on. Only things the case actually knows. */
export function searchContext(demoCase) {
  return Object.freeze({
    caseId: demoCase.demoCaseId,
    incidentId: demoCase.sourceIncident?.id ?? null,
    assetId: demoCase.asset?.assetId ?? null,
    workOrderId: demoCase.repair?.workOrderId ?? null,
    direction: demoCase.sourceIncident ? null : null,
    incidentAt: demoCase.incident?.reportedAt ?? null,
    latitude: demoCase.sourceIncident?.latitude ?? null,
    longitude: demoCase.sourceIncident?.longitude ?? null,
  });
}

/**
 * Fields no recovered record may ever satisfy, with the reason.
 *
 * Declared per case in the data, because which acts need a human is a policy question rather than
 * something the engine can work out from a field's type.
 */
export function humanOnlyFields(demoCase) {
  return new Map((demoCase?.evidenceRecovery?.notRecoverable ?? [])
    .map(entry => [entry.fieldId, entry]));
}

/**
 * Run the search and the ranking. No decision is taken and nothing is attached.
 *
 * @param {object} demoCase   the case, with its source incident resolved
 * @param {object} evaluation what `evaluateDemoCase` produced for it
 * @param {{connectors: object[], rules?: object[], audit?: object}} deps
 */
export async function searchForEvidence(demoCase, evaluation, { connectors, rules = MATCH_RULES, audit = createAuditLog() } = {}) {
  const context = { ...searchContext(demoCase), direction: evaluation?.location?.direction ?? null };
  const gaps = missingEvidence(evaluation);
  const humanOnly = humanOnlyFields(demoCase);

  audit.record(AUDIT_EVENTS.SEARCH_STARTED, demoCase.demoCaseId,
    `Searching ${connectors.length} system(s) for ${gaps.length} missing record(s).`,
    { systems: connectors.map(connector => connector.system), gaps: gaps.map(gap => gap.fieldId) });

  const responses = await Promise.all(connectors.map(async connector => {
    try {
      return await connector.search({ demoCase, evaluation, context });
    } catch (error) {
      return Object.freeze({
        system: connector.system, status: SEARCH_STATUS.UNAVAILABLE, origin: connector.origin,
        records: Object.freeze([]), queriedAt: null, error: String(error?.message ?? error),
      });
    }
  }));

  for (const result of responses) {
    audit.record(AUDIT_EVENTS.SOURCE_RESPONSE, demoCase.demoCaseId,
      result.status === SEARCH_STATUS.UNAVAILABLE
        ? `${SYSTEM_LABELS[result.system] ?? result.system} did not answer: ${result.error}`
        : `${SYSTEM_LABELS[result.system] ?? result.system} returned ${result.records.length} record(s).`,
      { system: result.system, status: result.status, origin: result.origin, count: result.records.length });
  }

  const all = responses.flatMap(result => result.records);

  // One group per gap, each ranked on its own: a record can only ever be proposed for the field it
  // says it resolves.
  const groups = gaps.map(gap => {
    const blocked = humanOnly.get(gap.fieldId) ?? null;
    const forGap = all.filter(record => record.resolves === gap.fieldId);
    const ranked = rankCandidates(forGap, context, rules);
    if (blocked) {
      audit.record(AUDIT_EVENTS.BLOCKED_BY_POLICY, demoCase.demoCaseId,
        `${gap.label} cannot be satisfied by a recovered record: ${blocked.reason}`,
        { fieldId: gap.fieldId });
    }
    for (const candidate of ranked.candidates) {
      audit.record(AUDIT_EVENTS.MATCH_PROPOSED, demoCase.demoCaseId,
        `${candidate.recordId} from ${SYSTEM_LABELS[candidate.system] ?? candidate.system} proposed for `
        + `"${gap.label}" — ${candidate.tier}, ${candidate.confidence}% confidence.`,
        { fieldId: gap.fieldId, recordId: candidate.recordId, tier: candidate.tier,
          system: candidate.system, origin: candidate.origin });
    }
    return Object.freeze({
      ...gap,
      ...ranked,
      /** Policy, not confidence: no record may fill this field at all. */
      humanOnly: blocked,
      /** What the reviewer is offered as already ticked. Never applied on its own. */
      preselected: Object.freeze(!blocked && ranked.best && ranked.best.tier === MATCH_TIER.EXACT
        && !ranked.requiresReview ? [ranked.best.recordId] : []),
      resolvable: Boolean(!blocked && ranked.best),
    });
  });

  // Records that fill no gap but say something about the case — the real DataConnect hits, and any
  // synthetic record a case marks as enrichment.
  const enrichment = all.filter(record => !record.resolves && record.enriches);

  return Object.freeze({
    caseId: demoCase.demoCaseId,
    context,
    gaps: Object.freeze(groups),
    searches: Object.freeze(responses.map(result => Object.freeze({
      system: result.system,
      label: SYSTEM_LABELS[result.system] ?? result.system,
      status: result.status,
      origin: result.origin,
      count: result.records.length,
      error: result.error,
      queriedAt: result.queriedAt,
    }))),
    enrichment: Object.freeze(enrichment),
    /** The provenance of evidence a closed case already holds, where the case records it. */
    lineage: Object.freeze(demoCase.evidenceRecovery?.lineage ?? []),
    unresolved: Object.freeze(groups.filter(group => !group.resolvable)),
    summary: Object.freeze({
      missing: groups.length,
      recoverable: groups.filter(group => group.resolvable).length,
      needsReview: groups.filter(group => group.resolvable && group.requiresReview).length,
      humanOnly: groups.filter(group => group.humanOnly).length,
      unresolved: groups.filter(group => !group.resolvable).length,
      enrichment: enrichment.length,
      systemsQueried: responses.length,
      systemsUnavailable: responses.filter(result => result.status === SEARCH_STATUS.UNAVAILABLE).length,
    }),
  });
}

/**
 * Turn a reviewer's accepted record ids into field values the re-validation can read.
 *
 * The result is an OVERLAY. The case is frozen and is never written to; `evaluateDemoCase` reads
 * the overlay beside it, so the original record and the recovered one are both still visible and
 * the recovery can be undone by dropping the overlay.
 *
 * @param {object} recovery  what `searchForEvidence` returned
 * @param {Record<string, string>} decisions  fieldId → accepted recordId ('' or absent = rejected)
 */
export function buildAttachments(recovery, decisions = {}, { audit = createAuditLog(), caseId = null } = {}) {
  const attachments = {};
  const rejected = [];

  for (const gap of recovery.gaps) {
    const chosen = decisions[gap.fieldId];
    if (!chosen) {
      if (chosen === '') rejected.push(gap.fieldId);
      continue;
    }
    if (gap.humanOnly) {
      audit.record(AUDIT_EVENTS.BLOCKED_BY_POLICY, caseId,
        `${gap.label}: a record was accepted but cannot be attached — ${gap.humanOnly.reason}`,
        { fieldId: gap.fieldId, recordId: chosen });
      continue;
    }
    const candidate = gap.candidates.find(entry => entry.recordId === chosen);
    if (!candidate) continue;
    attachments[gap.fieldId] = Object.freeze({
      value: candidate.value,
      recordId: candidate.recordId,
      system: candidate.system,
      origin: candidate.origin,
      synthetic: Boolean(candidate.synthetic),
      tier: candidate.tier,
      confidence: candidate.confidence,
      capturedAt: candidate.capturedAt ?? null,
    });
    audit.record(AUDIT_EVENTS.REVIEWER_DECISION, caseId,
      `Accepted ${candidate.recordId} from ${SYSTEM_LABELS[candidate.system] ?? candidate.system} for "${gap.label}".`,
      { fieldId: gap.fieldId, recordId: candidate.recordId, decision: 'ACCEPTED' });
    audit.record(AUDIT_EVENTS.EVIDENCE_ATTACHED, caseId,
      `"${gap.label}" now carries ${candidate.recordId}. The original record is unchanged; the `
      + 'recovered value is held as an overlay beside it.',
      { fieldId: gap.fieldId, recordId: candidate.recordId });
  }
  for (const fieldId of rejected) {
    audit.record(AUDIT_EVENTS.REVIEWER_DECISION, caseId,
      `Rejected every candidate for "${fieldId}". The gap stands.`,
      { fieldId, decision: 'REJECTED' });
  }
  return Object.freeze(attachments);
}

/** What the re-validation changed, stage by stage. */
export function validationDelta(before, after, { audit = null, caseId = null } = {}) {
  const changes = Object.entries(after.statuses)
    .filter(([stage, status]) => before.statuses[stage] !== status)
    .map(([stage, status]) => Object.freeze({ stage, from: before.statuses[stage], to: status }));
  if (audit) {
    for (const change of changes) {
      audit.record(AUDIT_EVENTS.VALIDATION_CHANGED, caseId,
        `${change.stage} moved from ${change.from} to ${change.to} after the accepted evidence was attached.`,
        change);
    }
    if (!changes.length) {
      audit.record(AUDIT_EVENTS.VALIDATION_CHANGED, caseId,
        'Re-validation produced no change of stage status. The accepted evidence closed gaps but '
        + 'did not clear everything holding the case.', { stage: null });
    }
  }
  return Object.freeze({
    changes: Object.freeze(changes),
    overallBefore: before.overall,
    overallAfter: after.overall,
    overallChanged: before.overall !== after.overall,
    /** Gaps the attachments closed, whether or not a stage flipped. */
    closed: Object.freeze(Object.keys(after.attachments ?? {})),
  });
}

/**
 * The orchestrator a screen talks to.
 *
 * @param {{connectors: object[], rules?: object[], audit?: object,
 *          evaluate: (demoCase: object, options: object) => object}} deps
 *   `evaluate` is injected rather than imported so this module stays independent of the demo-case
 *   evaluator and can be pointed at the production one later.
 */
export function createCaseEnrichmentOrchestrator({ connectors, evaluate, rules = MATCH_RULES,
  audit = createAuditLog() } = {}) {
  return {
    audit,
    connectors,
    /** Step 1-4: find and rank. Nothing is attached. */
    search: (demoCase, evaluation) => searchForEvidence(demoCase, evaluation, { connectors, rules, audit }),

    /**
     * Step 5-6: attach what the reviewer accepted and validate again.
     *
     * @returns {{attachments: object, evaluation: object, delta: object}}
     */
    apply(demoCase, evaluation, recovery, decisions) {
      const attachments = buildAttachments(recovery, decisions, { audit, caseId: demoCase.demoCaseId });
      const revalidated = evaluate(demoCase, { attachments });
      const delta = validationDelta(evaluation, { ...revalidated, attachments },
        { audit, caseId: demoCase.demoCaseId });
      return Object.freeze({ attachments, evaluation: revalidated, delta });
    },
  };
}
