/**
 * The QC/QA validation engine.
 *
 * Deterministic, and the same for every template: a checklist is data, so there is no per-document
 * validator anywhere in this file.
 *
 * The distinctions it exists to keep:
 *
 *  - MISSING is a gap in the paperwork. It is NOT a failed physical inspection, and the wording of
 *    every MISSING finding says so.
 *  - FAIL means a recorded response does not satisfy the question, judged by that question's own
 *    polarity — a NO is not automatically a failure, and 540.1 Q05 fails on YES.
 *  - NOT_EVALUATED means the engine has no rule or no mapping. It is never quietly folded into
 *    PASS or NOT_APPLICABLE.
 *  - NOT_APPLICABLE always carries the reason the section did not apply.
 */
import { CONFIDENCE, SEVERITY, STATUS, VALIDATION_TYPES, questionsOf } from './schema.js';
import { sectionApplies, selectTemplates, universal } from './applicability.js';
import { templateById } from './templateCatalog.js';

/** Read one question's recorded response, if any was supplied. */
function responseFor(canonicalCase, question) {
  const responses = canonicalCase?.qcInspection?.responses;
  if (!responses) return undefined;
  return responses[question.id];
}

/** Does this answer satisfy this question, given its polarity? */
export function satisfies(answer, polarity) {
  const value = String(answer ?? '').trim().toUpperCase();
  if (value === 'NA' || value === 'N/A') return null;
  if (polarity === 'INFORMATIONAL') return null;
  if (polarity === 'NO_IS_PASS') return value === 'NO' ? true : value === 'YES' ? false : null;
  return value === 'YES' ? true : value === 'NO' ? false : null;
}

const finding = fields => Object.freeze({
  evidence: Object.freeze([]), requiresHumanReview: false, ...fields,
});

/** Evaluate one question against the case. */
function evaluateQuestion(question, section, canonicalCase, context) {
  const base = {
    ruleId: question.id,
    question: question.text,
    sourceTemplate: context.templateId,
    sourcePage: question.sourcePage,
    section: section.title,
    expected: expectedLabel(question),
    mappedField: `qcInspection.responses.${question.id}`,
    validationType: question.validationType ?? VALIDATION_TYPES.CHECKLIST_RESPONSE,
  };

  // Conditional sections first: a question in a section that does not apply is not missing.
  const applies = sectionApplies(section, context.classification);
  if (applies.applies === false) {
    return finding({ ...base, status: STATUS.NOT_APPLICABLE, severity: SEVERITY.INFO,
      actual: null, reason: applies.reason, recommendedAction: null });
  }
  if (applies.applies === null) {
    return finding({ ...base, status: STATUS.NOT_EVALUATED, severity: SEVERITY.INFO, actual: null,
      reason: `${applies.reason} The section is neither applied nor dismissed.`,
      recommendedAction: 'Record the asset subtype so conditional sections can be resolved.',
      requiresHumanReview: true });
  }

  const answer = responseFor(canonicalCase, question);

  // MULTI_RESPONSE: each column is its own judgement (the PPE form's two per item).
  if (question.responses?.length) {
    const parts = question.responses.map(column => {
      const given = answer?.[column.key];
      const ok = satisfies(given, column.polarity);
      return { column, given, ok };
    });
    const unanswered = parts.filter(part => part.given == null);
    if (unanswered.length === parts.length) {
      return finding({ ...base, status: STATUS.MISSING, severity: SEVERITY.WARNING, actual: null,
        reason: 'No completed QC inspection response was found for either column of this item. '
          + 'This is an absent record, not an observed defect.',
        recommendedAction: 'Request the completed QC inspection response.',
        requiresHumanReview: true, columns: Object.freeze(parts.map(summariseColumn)) });
    }
    const failed = parts.filter(part => part.ok === false);
    if (failed.length) {
      return finding({ ...base, status: STATUS.FAIL, severity: SEVERITY.CRITICAL,
        actual: summariseAnswer(parts),
        reason: `${failed.map(part => part.column.label).join(' and ')} recorded as not satisfying `
          + 'the check.',
        recommendedAction: 'Raise a corrective action for the recorded failure.',
        requiresHumanReview: true, columns: Object.freeze(parts.map(summariseColumn)) });
    }
    if (unanswered.length) {
      return finding({ ...base, status: STATUS.NEEDS_VERIFICATION, severity: SEVERITY.WARNING,
        actual: summariseAnswer(parts),
        reason: `${unanswered.map(part => part.column.label).join(' and ')} left blank while the `
          + 'other column was answered.',
        recommendedAction: 'Complete the remaining column.', requiresHumanReview: true,
        columns: Object.freeze(parts.map(summariseColumn)) });
    }
    return finding({ ...base, status: STATUS.PASS, severity: SEVERITY.INFO,
      actual: summariseAnswer(parts), reason: 'Both columns recorded as satisfactory.',
      recommendedAction: null, columns: Object.freeze(parts.map(summariseColumn)) });
  }

  if (answer == null || String(answer).trim() === '') {
    return finding({ ...base, status: STATUS.MISSING, severity: SEVERITY.WARNING, actual: null,
      reason: 'No completed QC inspection response was found. This is an absent record, not an '
        + 'observed defect, and says nothing about the condition of the asset.',
      recommendedAction: 'Request the completed QC inspection response.',
      requiresHumanReview: true });
  }

  const value = String(answer).trim().toUpperCase();
  if (value === 'NA' || value === 'N/A') {
    return finding({ ...base, status: STATUS.NOT_APPLICABLE, severity: SEVERITY.INFO, actual: 'N/A',
      reason: 'Marked not applicable on the form.', recommendedAction: null });
  }

  const ok = satisfies(answer, question.polarity);
  if (ok === null) {
    return finding({ ...base, status: question.polarity === 'INFORMATIONAL' ? STATUS.PASS : STATUS.NEEDS_VERIFICATION,
      severity: SEVERITY.INFO, actual: String(answer),
      reason: question.polarity === 'INFORMATIONAL'
        ? 'Recorded for information; this question has no pass or fail answer.'
        : `"${answer}" is not a Yes/No answer to this question.`,
      recommendedAction: question.polarity === 'INFORMATIONAL' ? null : 'Clarify the recorded response.',
      requiresHumanReview: question.polarity !== 'INFORMATIONAL' });
  }
  if (ok) {
    return finding({ ...base, status: STATUS.PASS, severity: SEVERITY.INFO, actual: String(answer),
      reason: question.polarity === 'NO_IS_PASS'
        ? 'Recorded as NO, which is the satisfactory answer to this question.'
        : 'Recorded as satisfactory.',
      recommendedAction: null });
  }
  return finding({ ...base, status: STATUS.FAIL, severity: SEVERITY.CRITICAL, actual: String(answer),
    reason: question.polarity === 'NO_IS_PASS'
      ? 'Recorded as YES; for this question a YES is the defect.'
      : 'Recorded as NO against a question that requires YES.',
    recommendedAction: 'Raise a corrective action and re-inspect before QA approval.',
    requiresHumanReview: true });
}

const summariseColumn = part => Object.freeze({
  key: part.column.key, label: part.column.label,
  answer: part.given ?? null,
  status: part.given == null ? STATUS.MISSING : part.ok === false ? STATUS.FAIL
    : part.ok === true ? STATUS.PASS : STATUS.NEEDS_VERIFICATION,
});
const summariseAnswer = parts => parts
  .map(part => `${part.column.label} ${part.given ?? '—'}`).join(' · ');

function expectedLabel(question) {
  if (question.responses?.length) {
    return question.responses.map(column => `${column.label} YES`).join(' + ');
  }
  switch (question.polarity) {
    case 'NO_IS_PASS': return 'NO';
    case 'INFORMATIONAL': return 'Recorded (no pass/fail)';
    default: return question.responseType === 'YES_NO_NA' ? 'YES (or N/A)' : 'YES';
  }
}

/** Approvals (category F). An approval exists or it does not; it is never inferred. */
function evaluateApprovals(template, canonicalCase) {
  const out = [];
  for (const kind of ['qc', 'qa']) {
    if (!template.approvals?.[kind]) continue;
    const record = canonicalCase?.approvals?.[kind] ?? null;
    const signatory = record?.signatory ?? (kind === 'qc' ? canonicalCase?.acsTask?.qcSignatory : null);
    if (record?.approvedAt && record?.signatory) {
      out.push(finding({
        ruleId: `${template.templateId}-APPROVAL-${kind.toUpperCase()}`,
        question: `${kind.toUpperCase()} sign-off`,
        sourceTemplate: template.templateId, sourcePage: template.source.page,
        section: 'Signatures', validationType: VALIDATION_TYPES.APPROVAL_COMPLETENESS,
        expected: `${kind.toUpperCase()} signature and date`,
        actual: `${record.signatory} on ${record.approvedAt}`,
        mappedField: `approvals.${kind}`,
        status: STATUS.PASS, severity: SEVERITY.INFO,
        reason: 'A sign-off record exists.', recommendedAction: null,
      }));
      continue;
    }
    const partial = Boolean(signatory);
    out.push(finding({
      ruleId: `${template.templateId}-APPROVAL-${kind.toUpperCase()}`,
      question: `${kind.toUpperCase()} sign-off`,
      sourceTemplate: template.templateId, sourcePage: template.source.page,
      section: 'Signatures', validationType: VALIDATION_TYPES.APPROVAL_COMPLETENESS,
      expected: `${kind.toUpperCase()} signature and date`,
      actual: partial ? `Named on the repair form: ${signatory}` : null,
      mappedField: `approvals.${kind}`,
      status: partial ? STATUS.NEEDS_VERIFICATION : STATUS.MISSING,
      severity: SEVERITY.WARNING,
      reason: partial
        ? `${signatory} is named as QC on the ACS repair form, but there is no sign-off record `
          + 'with a date, so the checklist cannot be treated as approved.'
        : `No ${kind.toUpperCase()} sign-off record exists for this case.`,
      recommendedAction: `Obtain the ${kind.toUpperCase()} sign-off before closing the case.`,
      requiresHumanReview: true,
    }));
  }
  return out;
}

/** Evidence (category E). Photo counts are evidence that photos were taken, not the photos. */
function evaluateEvidence(template, canonicalCase) {
  const required = questionsOf(template)
    .filter(question => question.evidenceRequirements?.length);
  if (!required.length) return [];
  const photos = canonicalCase?.acsTask?.photoCount ?? 0;
  const filesSupplied = canonicalCase?.evidence?.length > 0;
  return required.map(question => finding({
    ruleId: `${question.id}-EVIDENCE`,
    question: `Evidence for: ${question.text}`,
    sourceTemplate: template.templateId, sourcePage: question.sourcePage,
    section: question.section.title, validationType: VALIDATION_TYPES.EVIDENCE_AVAILABILITY,
    expected: question.evidenceRequirements.join('; '),
    actual: filesSupplied ? `${canonicalCase.evidence.length} file(s) attached`
      : photos > 0 ? `${photos} photo(s) counted on the ACS form; no files supplied` : null,
    mappedField: 'evidence',
    status: filesSupplied ? STATUS.NEEDS_VERIFICATION : STATUS.MISSING,
    severity: SEVERITY.WARNING,
    reason: filesSupplied
      ? 'Files are attached to the case; whether they are the evidence this question requires has '
        + 'not been checked.'
      : photos > 0
        ? `The ACS form records ${photos} photo(s) but the image files were not supplied, so the `
          + 'required evidence cannot be produced.'
        : 'No evidence of any kind is attached to this case.',
    recommendedAction: `Attach: ${question.evidenceRequirements.join('; ')}.`,
    requiresHumanReview: true,
  }));
}

/** Cross-record consistency (category D). Only where two records state the same thing. */
export function consistencyFindings(canonicalCase) {
  const out = [];
  const { workOrder, inspection, acsTask } = canonicalCase;
  const add = fields => out.push(finding({
    sourceTemplate: null, section: 'Cross-record consistency',
    validationType: VALIDATION_TYPES.CROSS_RECORD_CONSISTENCY, sourcePage: null,
    requiresHumanReview: true, ...fields,
  }));

  if (workOrder?.assetTypeRaw && inspection?.assetTypeRaw
    && workOrder.assetType !== inspection.assetType) {
    add({ ruleId: 'XREC-ASSET-TYPE', question: 'Do the work order and the inspection agree on the asset type?',
      expected: 'The same asset type on both records',
      actual: `work order "${workOrder.assetTypeRaw}" vs inspection "${inspection.assetTypeRaw}"`,
      mappedField: 'workOrder.assetType / inspection.assetType',
      status: STATUS.FAIL, severity: SEVERITY.WARNING,
      reason: 'The two records describe different asset types, so at least one is wrong and the '
        + 'checklist may have been chosen from the wrong one.',
      recommendedAction: 'Reconcile the asset type before relying on the selected checklist.' });
  }
  if (workOrder?.assetId && inspection?.assetId && workOrder.assetId !== inspection.assetId) {
    add({ ruleId: 'XREC-ASSET-ID', question: 'Do the work order and the inspection name the same asset?',
      expected: 'The same asset id on both records',
      actual: `work order "${workOrder.assetId}" vs inspection "${inspection.assetId}"`,
      mappedField: 'workOrder.assetId / inspection.assetId',
      status: STATUS.FAIL, severity: SEVERITY.WARNING,
      reason: 'The records name different assets.',
      recommendedAction: 'Confirm which asset the work was performed on.' });
  }
  if (inspection?.passFail?.toUpperCase() === 'FAIL' && workOrder?.closedDate) {
    add({ ruleId: 'XREC-FAIL-CLOSED', question: 'Was the work order closed while the inspection records a failure?',
      expected: 'A failed inspection resolved before the work order closes',
      actual: `inspection ${inspection.passFail}, work order closed ${workOrder.closedDate}`,
      mappedField: 'inspection.passFail / workOrder.closedDate',
      status: STATUS.NEEDS_VERIFICATION, severity: SEVERITY.WARNING,
      reason: 'The inspection on this case records a failure and the work order is closed. The two '
        + 'may refer to different moments — the inspection that raised the work, and the work that '
        + 'answered it — so this needs a human to read, not an automatic finding.',
      recommendedAction: 'Confirm the inspection predates the repair, or re-inspect.' });
  }
  if (acsTask?.linkEvidence === 'ILLUSTRATIVE') {
    add({ ruleId: 'XREC-ACS-LINK', question: 'Is the ACS repair task verifiably this case\'s repair?',
      expected: 'A shared identifier between the ACS form and the maintenance record',
      actual: 'None — the association is illustrative',
      mappedField: 'acsTask.linkEvidence',
      status: STATUS.NEEDS_VERIFICATION, severity: SEVERITY.WARNING,
      reason: 'The ACS repair task shown against this case carries no identifier that any '
        + 'maintenance record also holds, so the association is not evidence.',
      recommendedAction: 'Ask ACS for the Event # on each task so the records can be joined.' });
  }
  return out;
}

/**
 * Validate one case.
 *
 * @param {object} canonicalCase from `buildCase`
 * @param {{templateIds?: string[], includeUniversal?: boolean}} [options]
 *        `templateIds` is a reviewer's override; without it the selection engine chooses.
 */
export function validateCase(canonicalCase, { templateIds = null, includeUniversal = true } = {}) {
  const classification = canonicalCase?.classification ?? {};
  const selection = selectTemplates(classification);

  const ids = templateIds ?? selection.selectedTemplates;
  const chosen = ids.map(templateById).filter(Boolean);
  const universals = includeUniversal ? universal() : [];

  const perTemplate = [...chosen, ...universals].map(template => {
    const findings = [];
    for (const section of template.sections) {
      for (const question of section.questions) {
        findings.push(evaluateQuestion(question, section, canonicalCase,
          { templateId: template.templateId, classification }));
      }
    }
    findings.push(...evaluateEvidence(template, canonicalCase));
    findings.push(...evaluateApprovals(template, canonicalCase));
    return Object.freeze({
      templateId: template.templateId,
      title: template.title,
      version: template.version,
      source: template.source,
      scope: template.scope,
      /** Why this template is here: selected for the asset, or universal to every job. */
      inclusion: chosen.includes(template) ? 'SELECTED' : 'UNIVERSAL',
      findings: Object.freeze(findings),
      summary: summarise(findings),
    });
  });

  const consistency = consistencyFindings(canonicalCase);
  const all = [...perTemplate.flatMap(entry => entry.findings), ...consistency];

  return Object.freeze({
    caseId: canonicalCase?.caseId ?? null,
    selection,
    overridden: Boolean(templateIds),
    templates: Object.freeze(perTemplate),
    consistency: Object.freeze(consistency),
    summary: summarise(all),
    /** True only when every applicable check passed AND both approvals exist. */
    approved: all.length > 0 && all.every(entry =>
      entry.status === STATUS.PASS || entry.status === STATUS.NOT_APPLICABLE),
    evaluatedAt: null,
  });
}

/** Counts by status, for the header of the UI and for the tests. */
export function summarise(findings = []) {
  const counts = Object.fromEntries(Object.values(STATUS).map(status => [status, 0]));
  for (const entry of findings) counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  const applicable = findings.length - counts[STATUS.NOT_APPLICABLE];
  return Object.freeze({
    total: findings.length,
    applicable,
    ...counts,
    requiresHumanReview: findings.filter(entry => entry.requiresHumanReview).length,
    critical: findings.filter(entry => entry.severity === SEVERITY.CRITICAL).length,
  });
}

export { CONFIDENCE, SEVERITY, STATUS };
