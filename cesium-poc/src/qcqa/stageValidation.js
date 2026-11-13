/**
 * Stage-level validation: the lifecycle half of the common QC/QA framework.
 *
 * `validationEngine.js` answers "does this recorded response satisfy this checklist question".
 * This file answers the question one level up — "is this stage's record complete enough for the
 * work to advance" — and it does it the same way: the rules are data on the field, and there is
 * one evaluator for every field of every stage of every case. There is no per-case code here and
 * none anywhere else.
 *
 * The distinctions it exists to keep (Phase 8 of the brief, and the same honesty rule the
 * checklist engine follows):
 *
 *  - MISSING is a mandatory record that should exist and does not.
 *  - PENDING is a mandatory record that is not due yet. A repair in progress has no completion
 *    photograph, and calling that MISSING would mark a crew late for work they have not finished.
 *  - BLOCKED is a record that cannot be produced at all because an earlier stage has not passed.
 *  - FAIL is a recorded value that does not satisfy its acceptance rule — a judgement about data
 *    that exists, never about data that is absent.
 *  - NOT_APPLICABLE is an optional field with nothing in it.
 *  - A stage passes only when every mandatory field is satisfied, and never because it is empty.
 */
import { STATUS, VALIDATION_TYPES } from './schema.js';

/** Whether a stage's record has been handed in, which is a fact about the record, not a judgement. */
export const SUBMISSION = Object.freeze({
  NOT_SUBMITTED: 'NOT_SUBMITTED',
  IN_PROGRESS: 'IN_PROGRESS',
  SUBMITTED: 'SUBMITTED',
});

/**
 * What a whole stage amounts to.
 *
 * There is no NOT_STARTED here on purpose. A stage with no record is either waiting its turn, which
 * is PENDING, or held up by a failure behind it, which is BLOCKED; "no record yet" on its own says
 * nothing a reader can act on, and collapsing the two would lose the one distinction that matters.
 */
export const STAGE_STATUS = Object.freeze({
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  IN_PROGRESS: 'IN_PROGRESS',
  PENDING: 'PENDING',
  BLOCKED: 'BLOCKED',
});

/** The lifecycle, in order. Each stage is gated by the one before it. */
export const STAGE_ORDER = Object.freeze(['INSPECTION', 'REPAIR', 'QCQA', 'CLAIM']);

export const STAGE_LABELS = Object.freeze({
  INSPECTION: 'Inspection',
  REPAIR: 'Repair',
  QCQA: 'QC/QA',
  CLAIM: 'Claim',
});

const blank = value => value === null || value === undefined
  || (typeof value === 'string' && value.trim() === '');

/**
 * Does a recorded value satisfy its acceptance rule?
 *
 * @returns {{ok: boolean, expected: string, detail: string|null}}
 */
export function satisfiesAcceptance(field, value, fieldsById) {
  const rule = field.acceptance ?? null;
  if (!rule) return { ok: true, expected: 'Recorded', detail: null };

  if (rule.oneOf) {
    const ok = rule.oneOf.some(option => String(option).toLowerCase() === String(value).toLowerCase()
      || String(value).toLowerCase().startsWith(`${String(option).toLowerCase()} `));
    return {
      ok,
      expected: `One of: ${rule.oneOf.join(', ')}`,
      detail: ok ? null : `"${value}" is not one of the answers this field offers.`,
    };
  }
  if (rule.equalsField) {
    const other = fieldsById?.get(rule.equalsField) ?? null;
    if (!other || blank(other.value)) {
      return { ok: false, expected: `Equal to ${rule.equalsField}`,
        detail: `The field this is reconciled against (${rule.equalsField}) is not recorded, so the two cannot be compared.` };
    }
    const ok = Number(value) === Number(other.value);
    return {
      ok,
      expected: `Equal to ${other.label}`,
      detail: ok ? null
        : `Recorded ${formatValue(value, field)} against ${other.label} of ${formatValue(other.value, other)} — a difference of ${formatValue(Math.abs(Number(value) - Number(other.value)), field)}.`,
    };
  }
  if (rule.min !== undefined || rule.max !== undefined) {
    const number = Number(value);
    const ok = Number.isFinite(number)
      && (rule.min === undefined || number >= rule.min)
      && (rule.max === undefined || number <= rule.max);
    const bounds = [rule.min !== undefined ? `min ${rule.min}` : null,
      rule.max !== undefined ? `max ${rule.max}` : null].filter(Boolean).join(', ');
    return { ok, expected: `${bounds}${field.unit ? ` ${field.unit}` : ''}`,
      detail: ok ? null : `Recorded ${formatValue(value, field)}, outside ${bounds}.` };
  }
  // `notEmpty` and anything else: having a value is the whole requirement.
  return { ok: true, expected: 'Recorded', detail: null };
}

const formatValue = (value, field) => (field?.unit ? `${value} ${field.unit}` : String(value));

/**
 * Evaluate one field of one stage.
 *
 * @param {object} field      the field as the case records it
 * @param {{submission: string, gated: boolean}} context
 * @param {Map<string, object>} fieldsById  the stage's own fields, for cross-field rules
 */
export function evaluateStageField(field, { submission, gated = false }, fieldsById = null) {
  const base = Object.freeze({
    fieldId: field.fieldId,
    label: field.label,
    required: Boolean(field.required),
    dataType: field.dataType ?? 'text',
    validationType: field.validationType ?? VALIDATION_TYPES.REQUIRED_FIELD,
    value: field.value ?? null,
    unit: field.unit ?? null,
    note: field.note ?? null,
  });

  if (!blank(field.value)) {
    const verdict = satisfiesAcceptance(field, field.value, fieldsById);
    return Object.freeze({ ...base,
      status: verdict.ok ? STATUS.PASS : STATUS.FAIL,
      expected: verdict.expected,
      message: verdict.ok
        ? 'Recorded and within the rule for this field.'
        : verdict.detail ?? 'The recorded value does not satisfy this field\'s rule.' });
  }

  const expected = field.acceptance?.oneOf ? `One of: ${field.acceptance.oneOf.join(', ')}`
    : field.acceptance?.equalsField ? `Equal to ${field.acceptance.equalsField}` : 'Recorded';

  if (!field.required) {
    return Object.freeze({ ...base, status: STATUS.NOT_APPLICABLE, expected,
      message: field.note ?? 'Optional on this form and not recorded.' });
  }
  if (gated) {
    return Object.freeze({ ...base, status: STATUS.BLOCKED, expected,
      message: field.note ?? 'Cannot be produced: an earlier stage has not passed.' });
  }
  if (field.notYetDue || submission === SUBMISSION.NOT_SUBMITTED) {
    return Object.freeze({ ...base, status: STATUS.PENDING, expected,
      message: field.note ?? 'Required, not yet due. This is pending, not missing.' });
  }
  return Object.freeze({ ...base, status: STATUS.MISSING, expected,
    message: field.note ?? 'Required and not recorded. This is an absent record, not an observed defect.' });
}

/** Counts by status over a list of evaluated fields. */
export function summariseFields(fields = []) {
  const counts = Object.fromEntries(Object.values(STATUS).map(status => [status, 0]));
  for (const field of fields) counts[field.status] = (counts[field.status] ?? 0) + 1;
  return Object.freeze({
    total: fields.length,
    required: fields.filter(field => field.required).length,
    ...counts,
    passed: counts[STATUS.PASS],
    failed: counts[STATUS.FAIL],
    missing: counts[STATUS.MISSING],
    pending: counts[STATUS.PENDING],
    blocked: counts[STATUS.BLOCKED],
    notApplicable: counts[STATUS.NOT_APPLICABLE],
  });
}

/**
 * Evaluate one stage.
 *
 * `gatedBy` is the name of the earlier stage holding this one up, or null. A gated stage can never
 * be PASSED, and a stage with no record can never be PASSED either — that is the "a downstream
 * stage must not pass merely because it contains no records" rule, enforced in one place.
 *
 * @param {{submission: string, fields: object[], extraFindings?: object[]}} stage
 * @param {{gatedBy: string|null, declaredStatus?: string|null}} context
 */
export function validateStage(stage, { gatedBy = null, extraFindings = [] } = {}) {
  const submission = stage?.submission ?? SUBMISSION.NOT_SUBMITTED;
  const own = stage?.fields ?? [];
  const fieldsById = new Map(own.map(field => [field.fieldId, field]));
  const gated = Boolean(gatedBy) && submission === SUBMISSION.NOT_SUBMITTED;
  const fields = own.map(field => evaluateStageField(field, { submission, gated }, fieldsById));
  const findings = [...fields, ...extraFindings];
  const summary = summariseFields(findings);

  const blocking = findings.filter(field =>
    field.required && (field.status === STATUS.FAIL || field.status === STATUS.MISSING));

  const status = (() => {
    if (submission === SUBMISSION.SUBMITTED) {
      return blocking.length ? STAGE_STATUS.FAILED : STAGE_STATUS.PASSED;
    }
    if (submission === SUBMISSION.IN_PROGRESS) {
      // A failure or a genuine gap in what HAS been recorded still fails the stage; a field that is
      // simply not due yet does not.
      return blocking.length ? STAGE_STATUS.FAILED : STAGE_STATUS.IN_PROGRESS;
    }
    return gatedBy ? STAGE_STATUS.BLOCKED : STAGE_STATUS.PENDING;
  })();

  return Object.freeze({
    submission,
    status,
    gatedBy: gatedBy ?? null,
    fields: Object.freeze(fields),
    findings: Object.freeze(findings),
    summary,
    blocking: Object.freeze(blocking.map(field => field.label)),
  });
}

/**
 * Which stage, if any, holds up each later stage.
 *
 * The gate is the nearest earlier stage that did not pass. It is reported per stage so the UI can
 * say WHY a stage cannot advance instead of only that it has not.
 */
export function gateFor(stageKey, statuses) {
  const index = STAGE_ORDER.indexOf(stageKey);
  for (let step = index - 1; step >= 0; step -= 1) {
    const earlier = STAGE_ORDER[step];
    if (statuses[earlier] && statuses[earlier] !== STAGE_STATUS.PASSED) return earlier;
  }
  return null;
}

export { STATUS, VALIDATION_TYPES };
