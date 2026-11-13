/**
 * Every ACS QC/QA template, indexed.
 *
 * The catalogue is data. Adding a document means adding a template object — never a new validator,
 * a new UI branch or a new selection rule.
 */
import { questionsOf, validateTemplate } from './schema.js';
import { ROADSIDE_TEMPLATES } from './templates/roadside.js';
import { MARKING_TEMPLATES } from './templates/markings.js';
import { LIGHTING_TEMPLATES } from './templates/lighting.js';
import { STRUCTURE_TEMPLATES } from './templates/structures.js';
import { OPERATIONS_TEMPLATES } from './templates/operations.js';
import { SAFETY_TEMPLATES } from './templates/safety.js';

export const TEMPLATES = Object.freeze([
  ...ROADSIDE_TEMPLATES,
  ...MARKING_TEMPLATES,
  ...LIGHTING_TEMPLATES,
  ...STRUCTURE_TEMPLATES,
  ...OPERATIONS_TEMPLATES,
  ...SAFETY_TEMPLATES,
]);

const BY_ID = new Map(TEMPLATES.map(template => [template.templateId, template]));

export const templateById = id => BY_ID.get(id) ?? null;

/**
 * Documents supplied but not extracted.
 *
 * Empty today. A document that cannot be read reliably belongs here rather than being silently
 * omitted, so the count in the audit always reconciles against the folder.
 */
export const UNEXTRACTED_DOCUMENTS = Object.freeze([]);

/** Per-document extraction counts, for the audit in the deliverables. */
export function extractionAudit() {
  return Object.freeze(TEMPLATES.map(template => {
    const questions = questionsOf(template);
    const check = validateTemplate(template);
    return Object.freeze({
      templateId: template.templateId,
      title: template.title,
      file: template.source.file,
      page: template.source.page,
      version: template.version,
      scope: template.scope,
      sections: template.sections.length,
      questions: questions.length,
      conditionalSections: template.sections.filter(section => section.applicabilityRule
        || section.conditionalNote).length,
      multiResponseQuestions: questions.filter(question => question.responses?.length).length,
      /** Questions a YES would fail. The thing most easily got wrong. */
      noIsPassQuestions: questions.filter(question => question.polarity === 'NO_IS_PASS').length,
      informationalQuestions: questions.filter(question => question.polarity === 'INFORMATIONAL').length,
      thresholds: questions.filter(question => question.threshold).length,
      evidenceRequirements: questions.reduce((total, question) =>
        total + (question.evidenceRequirements?.length ?? 0), 0),
      referencedStandards: [...new Set(questions.map(question => question.referencedStandard)
        .filter(Boolean))],
      /** Questions QC/QA can only answer from site attendance — never inferable from a record. */
      siteAttendanceOnly: questions.filter(question => question.verifiabilityNote).length,
      extractionNote: template.extractionNote ?? null,
      valid: check.ok,
      problems: check.problems,
    });
  }));
}

/** The totals line of the audit. */
export function extractionTotals() {
  const rows = extractionAudit();
  return Object.freeze({
    documents: rows.length,
    unextracted: UNEXTRACTED_DOCUMENTS.length,
    sections: rows.reduce((total, row) => total + row.sections, 0),
    questions: rows.reduce((total, row) => total + row.questions, 0),
    conditionalSections: rows.reduce((total, row) => total + row.conditionalSections, 0),
    multiResponseQuestions: rows.reduce((total, row) => total + row.multiResponseQuestions, 0),
    noIsPassQuestions: rows.reduce((total, row) => total + row.noIsPassQuestions, 0),
    thresholds: rows.reduce((total, row) => total + row.thresholds, 0),
    siteAttendanceOnly: rows.reduce((total, row) => total + row.siteAttendanceOnly, 0),
    allValid: rows.every(row => row.valid),
  });
}
