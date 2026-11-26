/**
 * Ask the Twin requests that produce deliverables: "Prepare a report of all transformers requiring
 * inspection and draft an email to the electrical maintenance team." One question can ask for several things:
 *
 *   ASSET_INSPECTION_QUERY      which assets require inspection (an evaluation; no files)
 *   ASSET_REPORT_GENERATION     a PDF report (with its Excel register)
 *   ASSET_REGISTER_GENERATION   an Excel register
 *   EMAIL_DRAFT_GENERATION      an email draft referencing the files
 *   COMPOSITE_ACTION_REQUEST    more than one of these at once
 *
 * The asset category comes from the question's own words (askSeagirt.typesIn, the twin's vocabulary); nothing
 * here knows a particular asset. Follow-ups ("make the email shorter", "include circuit breakers also") change
 * the last report: email-only changes edit the draft; selection changes make a new revision.
 */
import { TYPE_LABEL, typesIn } from '../seagirt/askSeagirt.js';

export const REPORT_INTENT = Object.freeze({
  INSPECTION_QUERY: 'ASSET_INSPECTION_QUERY', REPORT: 'ASSET_REPORT_GENERATION', REGISTER: 'ASSET_REGISTER_GENERATION',
  EMAIL: 'EMAIL_DRAFT_GENERATION', COMPOSITE: 'COMPOSITE_ACTION_REQUEST',
});

const INSPECTION = /\b(requir\w*|need\w*|due( for)?|overdue( for)?|pending)\s+(an?\s+)?(inspection|inspecting|examination)s?\b|\binspections?\s+(is\s+|are\s+)?(due|overdue|required|needed)\b|\bto be inspected\b|\bneed(s)? to be inspected\b/i;
const REPORT = /\breports?\b|\bpdf\b/i;
const REGISTER = /\bregisters?\b|\bexcel\b|\bspreadsheets?\b|\bxlsx\b|\bworkbook\b/i;
const EMAIL = /\be-?mails?\b|\bmail (draft|message)\b|\bdraft (a |an )?(message|note) to\b/i;
const MAKE = /\b(prepare|generate|create|produce|make|build|draft|write|compile|give me|export|send)\b/i;
const UNSUPPORTED = /\b(outage|simulat\w*|what if|fails?)\b|\b(changed?|changes|compare|comparison|differences?) (between|in|of)\b.*\bversions?\b|\bversions?\b.*\b(change|comparison)\b/i;
const DEGRADED = /\bdegraded\b/i;
const NO_POWER = /\b(no power|without power|unpowered|de-?energi[sz]ed|lost power)\b/i;
const RECURRING = /\brecurr\w*|\brepeated\b/i;
const SPECS = /\b(technical )?spec(ification)?s?\b/i;
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const numberOf = w => (/^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[String(w).toLowerCase()] ?? null);

/** "electrical maintenance team", "the operations manager": the group the email is for, as the user named it. */
export function recipientOf(q) {
  const m = /\b(?:e-?mail|draft|send|address|recipient)\b[^.?!]*?\b(?:to|for)\s+(?:the\s+)?((?:[a-z]+\s+){0,4}(?:team|group|department|manager|engineer|crew|supervisor|lead|contractor|operations|maintenance))\b/i.exec(q);
  if (!m) return null;
  return m[1].replace(/\s+/g, ' ').trim().replace(/\b[a-z]/g, c => c.toUpperCase());
}

/** The twin's types present in the network, with their words. */
export function typeLabels(types) {
  return types.map(t => { const [singular, plural] = TYPE_LABEL[t] ?? [t.toLowerCase().replaceAll('_', ' '), `${t.toLowerCase().replaceAll('_', ' ')}s`]; return { type: t, singular, plural }; });
}

/**
 * @param {string} question
 * @param {{knownTypes?: Set<string>}} o types the network has
 * @returns {null | {intent, intents, kind, types, typeLabels, outputs, recipientGroup, filters, options, evaluateOnly, unsupported?}}
 */
export function parseReportRequest(question, { knownTypes = null } = {}) {
  const q = String(question ?? '');
  const lower = q.toLowerCase();
  const wantsInspection = INSPECTION.test(q);
  const outputs = { pdf: REPORT.test(q), xlsx: REGISTER.test(q), email: EMAIL.test(q) };
  // "a report" brings its register; a register alone is only the register.
  if (outputs.pdf) outputs.xlsx = true;
  const deliverable = (outputs.pdf || outputs.xlsx || outputs.email) && (MAKE.test(q) || /\b(report|register)\s+(of|on|for)\b/i.test(q));
  const types = typesIn(lower).filter(t => !knownTypes || knownTypes.has(t));
  const allAssets = /\b(all )?assets\b|\bequipment\b/i.test(q) && !types.length;
  if (!deliverable && !(wantsInspection && (types.length || allAssets) && /\b(which|what|list|show|find|any|are there|how many)\b/i.test(q))) return null;
  if (deliverable && UNSUPPORTED.test(q) && !wantsInspection) return { unsupported: true, outputs };
  const filters = { status: DEGRADED.test(q) ? 'DEGRADED' : NO_POWER.test(q) ? 'NO_POWER' : null, recurring: RECURRING.test(q) && /\b(defects?|findings?|issues?)\b/i.test(q), condition: /\bpoor condition\b/i.test(q) ? 'POOR' : null,
    excludeNoRecords: /\b(exclude|without|skip)\b.*\bno inspection records?\b/i.test(q) };
  // "due within 30 days", "in the next 2 weeks": the user's own window (an assumption the report states as theirs).
  const within = wantsInspection ? /\b(?:within|in|over) (?:the next )?(\d+|[a-z]+) (day|week|month)s?\b/i.exec(q) : null;
  const options = { includeSpecs: SPECS.test(q), historyDepth: null,
    dueWithinDays: within && numberOf(within[1]) ? numberOf(within[1]) * { day: 1, week: 7, month: 30 }[within[2].toLowerCase()] : null };
  const kind = wantsInspection ? 'INSPECTION' : 'ASSET_LIST';
  const resolved = types.length ? types : allAssets && knownTypes ? [...knownTypes] : [];
  const intents = [wantsInspection && REPORT_INTENT.INSPECTION_QUERY, outputs.pdf && REPORT_INTENT.REPORT, outputs.xlsx && !outputs.pdf && REPORT_INTENT.REGISTER, outputs.email && REPORT_INTENT.EMAIL].filter(Boolean);
  return {
    intent: intents.filter(i => i !== REPORT_INTENT.INSPECTION_QUERY).length > 1 ? REPORT_INTENT.COMPOSITE : intents.find(i => i !== REPORT_INTENT.INSPECTION_QUERY) ?? REPORT_INTENT.INSPECTION_QUERY, intents, kind, types: resolved, typeLabels: typeLabels(resolved),
    outputs: deliverable ? outputs : { pdf: false, xlsx: false, email: false }, evaluateOnly: !deliverable, recipientGroup: outputs.email ? recipientOf(q) : null, filters, options, needsTypes: !resolved.length,
  };
}

/**
 * A follow-up on the last report. Email-only: {email: {...}}; a new revision: {revise: {request changes}}; or
 * {show: true} to show the included assets again. null when the question is not about the report.
 */
export function parseReportFollowUp(question, last, { knownTypes = null } = {}) {
  if (!last) return null;
  const q = String(question ?? '');
  if (/\b(show|list|which)\b.*\b(assets?|ones)\b.*\b(in|included in|on) (the|this) (report|register)\b|\bshow me the assets included\b/i.test(q)) return { show: true };
  if (/\bmake (the |this )?(e-?mail|draft|it) (shorter|more concise|briefer)\b|\bshorter (e-?mail|draft)\b|\bshorten the (e-?mail|draft)\b/i.test(q)) return { email: { regenerate: true, style: 'short' } };
  if (/\bmake (the |this )?(e-?mail|draft|it) (longer|more detailed)\b/i.test(q)) return { email: { regenerate: true, style: 'standard' } };
  const to = /\b(?:change|set|update) the recipient to (?:the )?(.+?)[.?!]*$|\b(?:send|address) (?:it|the e-?mail|the draft) to (?:the )?(.+?)[.?!]*$/i.exec(q);
  if (to) return { email: { regenerate: true, recipientGroup: (to[1] ?? to[2]).trim().replace(/\b[a-z]/g, c => c.toUpperCase()) } };
  const remove = /\bremove the (excel|spreadsheet|register|xlsx|pdf|report) attachment\b|\b(don't|do not) attach the (excel|spreadsheet|register|pdf|report)\b/i.exec(q);
  if (remove) return { email: { removeType: /pdf|report/i.test(remove[1] ?? remove[3]) ? 'PDF' : 'XLSX' } };
  if (/\bregenerate (the )?(e-?mail|draft)\b/i.test(q)) return { email: { regenerate: true } };
  if (/\bdraft (an |the )?e-?mail\b/i.test(q) && !/\breport of\b/i.test(q)) return { email: { regenerate: true, recipientGroup: recipientOf(q) ?? undefined } };
  // Changes to what the report covers: a new revision of the same request.
  const req = last.request;
  const named = typesIn(q.toLowerCase()).filter(t => !knownTypes || knownTypes.has(t));
  if (/\binclude\b.*\b(also|as well|too)\b|\balso include\b|\badd\b.*\b(to the report)\b/i.test(q) && named.length) return { revise: { types: [...new Set([...req.types, ...named])] } };
  if (/\bsame report for\b|\bthis report for\b|\bdo the same for\b|\bgenerate the same\b/i.test(q) && named.length) return { revise: { types: named } };
  if (/\bonly (include )?(assets )?(with |in )?poor condition\b/i.test(q)) return { revise: { filters: { ...req.filters, condition: 'POOR' } } };
  if (/\bexclude\b.*\bno inspection records?\b|\bonly (assets )?with inspection records\b/i.test(q)) return { revise: { filters: { ...req.filters, excludeNoRecords: true } } };
  const last3 = /\binclude the last (\d+|[a-z]+) inspections?\b/i.exec(q);
  if (last3 && numberOf(last3[1])) return { revise: { options: { ...req.options, historyDepth: numberOf(last3[1]) } } };
  if (/\badd (the )?(technical )?spec(ification)?s?\b|\binclude (the )?(technical )?spec(ification)?s?\b/i.test(q)) return { revise: { options: { ...req.options, includeSpecs: true } } };
  if (/\bregenerate\b|\bupdate the report\b|\blatest (ifc )?version\b.*\breport\b|\breport\b.*\blatest (ifc )?version\b/i.test(q)) return { revise: { regenerate: true } };
  return null;
}
