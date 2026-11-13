/**
 * The QC/QA validation framework's vocabulary.
 *
 * One schema for every ACS checklist. There is no per-document validator: a template is data, and
 * the engine in `validationEngine.js` is the only thing that evaluates it.
 */

/** How a question is answered on the paper form. */
export const RESPONSE_TYPES = Object.freeze({
  YES_NO: 'YES_NO',
  YES_NO_NA: 'YES_NO_NA',
  TEXT: 'TEXT',
  NUMBER: 'NUMBER',
  DATE: 'DATE',
  MULTI_RESPONSE: 'MULTI_RESPONSE',
  DOCUMENT_REFERENCE: 'DOCUMENT_REFERENCE',
  APPROVAL: 'APPROVAL',
});

/**
 * Which answer satisfies the question.
 *
 * Not every question is satisfied by YES. 540.1 asks "Are remnants of graffiti visible through the
 * covering material used?" — a YES there is a defect. Polarity is carried per question so the
 * engine never assumes.
 */
export const POLARITY = Object.freeze({
  YES_IS_PASS: 'YES_IS_PASS',
  NO_IS_PASS: 'NO_IS_PASS',
  /** Recorded for information; neither answer is a finding on its own. */
  INFORMATIONAL: 'INFORMATIONAL',
});

/**
 * The outcome of evaluating one question or one field.
 *
 * PENDING and BLOCKED were added for the lifecycle stages (`stageValidation.js`), which have to
 * say two things a checklist question never needed to. They are deliberately separate statuses
 * rather than shades of MISSING: a record that is not due yet, and a record that cannot be
 * produced because an earlier stage failed, are both absent, and neither is a defect.
 */
export const STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  MISSING: 'MISSING',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  NEEDS_VERIFICATION: 'NEEDS_VERIFICATION',
  NOT_EVALUATED: 'NOT_EVALUATED',
  /** Required, not recorded, and not yet due. Absent on purpose. */
  PENDING: 'PENDING',
  /** Cannot be produced or judged because an earlier stage has not passed. */
  BLOCKED: 'BLOCKED',
});

/** What a finding costs. Severity is about the finding, not about the question. */
export const SEVERITY = Object.freeze({
  CRITICAL: 'CRITICAL',
  WARNING: 'WARNING',
  INFO: 'INFO',
});

/** The kinds of check the engine performs (Phase 5, categories A–G). */
export const VALIDATION_TYPES = Object.freeze({
  REQUIRED_FIELD: 'REQUIRED_FIELD',
  CHECKLIST_RESPONSE: 'CHECKLIST_RESPONSE',
  CONDITIONAL_APPLICABILITY: 'CONDITIONAL_APPLICABILITY',
  CROSS_RECORD_CONSISTENCY: 'CROSS_RECORD_CONSISTENCY',
  EVIDENCE_AVAILABILITY: 'EVIDENCE_AVAILABILITY',
  APPROVAL_COMPLETENESS: 'APPROVAL_COMPLETENESS',
  TECHNICAL_THRESHOLD: 'TECHNICAL_THRESHOLD',
});

/** How confident a template selection or a field mapping is. */
export const CONFIDENCE = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  UNRESOLVED: 'UNRESOLVED',
});

/** Universal checklists apply to the crew and the paperwork, not to a kind of asset. */
export const TEMPLATE_SCOPE = Object.freeze({
  ASSET_SPECIFIC: 'ASSET_SPECIFIC',
  UNIVERSAL: 'UNIVERSAL',
});

/** Every question id is `<templateId>-Q<nn>`, so a finding can always be traced to its source. */
export const questionId = (templateId, index) =>
  `${templateId}-Q${String(index).padStart(2, '0')}`;

/**
 * A template is well formed.
 *
 * Run over the whole catalogue by the tests, so a hand-written template cannot ship with a missing
 * source reference, an unknown response type or a duplicate question id.
 */
export function validateTemplate(template) {
  const problems = [];
  const need = (cond, message) => { if (!cond) problems.push(message); };

  need(template?.templateId, 'templateId is required');
  need(template?.title, `${template?.templateId}: title is required`);
  need(template?.version, `${template?.templateId}: version is required`);
  need(template?.source?.file, `${template?.templateId}: source.file is required`);
  need(Number.isInteger(template?.source?.page), `${template?.templateId}: source.page is required`);
  need(Object.values(TEMPLATE_SCOPE).includes(template?.scope),
    `${template?.templateId}: scope must be a TEMPLATE_SCOPE`);
  need(Array.isArray(template?.sections) && template.sections.length > 0,
    `${template?.templateId}: at least one section is required`);

  const seen = new Set();
  for (const section of template?.sections ?? []) {
    need(section.id, `${template.templateId}: a section is missing an id`);
    need(section.title, `${template.templateId}/${section.id}: title is required`);
    need(Array.isArray(section.questions) && section.questions.length > 0,
      `${template.templateId}/${section.id}: at least one question is required`);
    for (const question of section.questions ?? []) {
      need(question.id, `${template.templateId}/${section.id}: a question is missing an id`);
      need(!seen.has(question.id), `${template.templateId}: duplicate question id ${question.id}`);
      seen.add(question.id);
      need(typeof question.text === 'string' && question.text.length > 3,
        `${question.id}: text is required and must be the form's own wording`);
      need(Object.values(RESPONSE_TYPES).includes(question.responseType),
        `${question.id}: responseType ${question.responseType} is not a RESPONSE_TYPE`);
      need(Object.values(POLARITY).includes(question.polarity),
        `${question.id}: polarity is required`);
      need(Number.isInteger(question.sourcePage), `${question.id}: sourcePage is required`);
      if (question.responseType === RESPONSE_TYPES.MULTI_RESPONSE) {
        need(Array.isArray(question.responses) && question.responses.length > 1,
          `${question.id}: a MULTI_RESPONSE question needs its response columns`);
      }
    }
  }
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) });
}

/** Every question in a template, flattened, each carrying the section it came from. */
export function questionsOf(template) {
  return (template?.sections ?? []).flatMap(section =>
    section.questions.map(question => Object.freeze({ ...question, section })));
}
