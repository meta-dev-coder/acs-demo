/**
 * Does an asset require inspection? Deterministic rules over structured evidence — the asset's documents as
 * docIntel.mjs reads them, the twin's operational status, and an inspection policy only where one is
 * configured or the user stated an assumption. No model decides it; nothing is assumed when evidence is missing.
 *
 *   INSPECTION_REQUIRED         an inspection is required by the records: overdue against a documented due date
 *                               or interval (or a configured one), an inspection-type action raised in the latest
 *                               report or documented as not completed, a restriction that sets periodic testing
 *   REVIEW_RECOMMENDED          a candidate for engineering review: poor documented condition (unless a policy makes
 *                               it a requirement), worsening or recurring defects, inspection actions whose closure is
 *                               not verified, a degraded operational status
 *   NO_REQUIREMENT_IDENTIFIED   inspection records exist and none of the rules applies
 *   INSUFFICIENT_EVIDENCE       no inspection record could be read: inspection history cannot be established
 *
 * Every reason names its rule, the rule's source (DOCUMENTED, POLICY, USER_ASSUMPTION, DERIVED, OPERATIONAL) and
 * the citations it rests on.
 */
export const CLASSIFICATION = Object.freeze({
  INSPECTION_REQUIRED: 'INSPECTION_REQUIRED', REVIEW_RECOMMENDED: 'REVIEW_RECOMMENDED',
  NO_REQUIREMENT_IDENTIFIED: 'NO_REQUIREMENT_IDENTIFIED', INSUFFICIENT_EVIDENCE: 'INSUFFICIENT_EVIDENCE',
});
export const CLASSIFICATION_LABEL = Object.freeze({
  INSPECTION_REQUIRED: 'Inspection required', REVIEW_RECOMMENDED: 'Review recommended',
  NO_REQUIREMENT_IDENTIFIED: 'No requirement identified', INSUFFICIENT_EVIDENCE: 'Insufficient evidence',
});
const RANK = { INSPECTION_REQUIRED: 3, REVIEW_RECOMMENDED: 2, INSUFFICIENT_EVIDENCE: 1, NO_REQUIREMENT_IDENTIFIED: 0 };

/** The rules, as the report lists them under "Inspection criteria". */
export const RULES = Object.freeze({
  OVERDUE_DOCUMENTED_DATE: { source: 'DOCUMENTED', text: 'The next inspection date stated in the latest inspection report has passed.' },
  OVERDUE_DOCUMENTED_INTERVAL: { source: 'DOCUMENTED', text: 'The inspection interval stated in the records has elapsed since the latest inspection.' },
  OVERDUE_POLICY_INTERVAL: { source: 'POLICY', text: 'The configured inspection interval for this asset type has elapsed since the latest inspection.' },
  DUE_WITHIN_WINDOW: { source: 'USER_ASSUMPTION', text: 'The documented next inspection date falls within the window the request set.' },
  DOCUMENTED_INSPECTION_ACTION: { source: 'DOCUMENTED', text: 'An inspection, test or check action raised in the latest report, or documented as not completed.' },
  RESTRICTION_PERIODIC_TESTING: { source: 'DOCUMENTED', text: 'An operating restriction in force sets periodic inspection or testing.' },
  POOR_CONDITION_POLICY: { source: 'POLICY', text: 'The configured policy requires inspection when the latest documented condition is poor.' },
  POOR_CONDITION_REVIEW: { source: 'DERIVED', text: 'The latest documented condition is poor (review candidate; no policy makes it a requirement).' },
  WORSENING_OR_RECURRING: { source: 'DERIVED', text: 'A defect worsened between reports or recurs in the latest report.' },
  ACTION_CLOSURE_NOT_VERIFIED: { source: 'DERIVED', text: 'An earlier inspection action has no record of completion.' },
  DEGRADED_STATUS: { source: 'OPERATIONAL', text: 'The twin reports a degraded operational status (review candidate, not an inspection requirement).' },
  NO_INSPECTION_RECORDS: { source: 'DERIVED', text: 'No inspection record is available: inspection history cannot be established.' },
});

/** The default policy: none. Intervals, windows and condition rules apply only when configured or asked for. */
export const NO_POLICY = Object.freeze({ name: null, intervalsByType: {}, conditionRequiresInspection: false, dueWithinDays: null });

const INSPECTION_WORDS = /\b(inspect\w*|examin\w*|survey\w*|thermograph\w*|re-?check\w*|checks?|test(s|ing)?|sampl\w*|re-?sampl\w*|dga|monitor\w*|measur\w*)\b/i;
const PERIODIC = /\bevery\b|\binterval\b|\b(daily|weekly|monthly|quarterly|annually)\b|\bper (day|week|month|year)\b/i;
const POOR = /^(poor|very poor|bad|critical|unsatisfactory|unserviceable)$/i;
const DAY = 86_400_000;

/** "12 months", "1 year", "90 days", "annual" → days; null when it does not say. */
export function intervalDays(text) {
  const t = String(text ?? '').toLowerCase();
  if (/\bannual(ly)?\b|\byearly\b/.test(t)) return 365;
  if (/\bquarterly\b/.test(t)) return 91;
  if (/\bmonthly\b/.test(t)) return 30;
  const m = /(\d+(?:\.\d+)?)\s*(day|week|month|year)s?\b/.exec(t);
  if (!m) return null;
  return Math.round(Number(m[1]) * { day: 1, week: 7, month: 30.4375, year: 365.25 }[m[2]]);
}
const dayOf = iso => (iso ? Date.parse(`${iso}T00:00:00Z`) : NaN);
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

/**
 * @param {object} asset {id, type, typeLabel, status: {code, label, source, asOf}}
 * @param {object|null} analysis docIntel's analysis of the asset's documents (null when it could not be read)
 * @param {{now: number, policy?: object, analysisError?: string}} o
 */
export function evaluateInspection(asset, analysis, { now, policy = NO_POLICY, analysisError = null } = {}) {
  const reasons = [];
  const limitations = [];
  const add = (rule, classification, text, citations = [], extra = {}) => reasons.push({ rule, source: RULES[rule].source, classification, text, citations: citations.filter(Boolean), ...extra });
  const evalDay = Date.parse(`${isoDay(now)}T00:00:00Z`);
  const timeline = analysis?.inspections?.timeline ?? [];
  const latest = timeline.find(t => t.inspectionDate) ?? null;
  let next = { date: null, basis: 'UNKNOWN', citation: null, text: 'No due date or inspection interval is documented or configured.' };

  if (analysisError) limitations.push(`The asset's documents could not be analysed: ${analysisError}`);
  if (analysis && analysis.documents.unreadable) limitations.push(`${analysis.documents.unreadable} linked document${analysis.documents.unreadable === 1 ? '' : 's'} could not be read.`);

  // Due date: the latest report's own date first; else an interval (documented, then configured) from its date.
  if (latest?.nextDue?.value && !Number.isNaN(dayOf(latest.nextDue.value))) {
    const due = dayOf(latest.nextDue.value);
    next = { date: latest.nextDue.value, basis: 'DOCUMENTED', citation: latest.nextDue.citation, text: `Next inspection due ${latest.nextDue.value}, as the latest report states.` };
    if (due < evalDay) add('OVERDUE_DOCUMENTED_DATE', 'INSPECTION_REQUIRED', `Inspection overdue: the latest report set the next inspection for ${latest.nextDue.value} (${Math.round((evalDay - due) / DAY)} days ago).`, [latest.nextDue.citation], { overdueDays: Math.round((evalDay - due) / DAY) });
    else if (Number.isFinite(policy.dueWithinDays) && due - evalDay <= policy.dueWithinDays * DAY) add('DUE_WITHIN_WINDOW', 'INSPECTION_REQUIRED', `Next inspection due ${latest.nextDue.value}, within the ${policy.dueWithinDays} days the request set.`, [latest.nextDue.citation]);
  } else if (latest) {
    const documented = latest.interval?.value ? intervalDays(latest.interval.value) : null;
    const configured = policy.intervalsByType?.[asset.type] ?? null;
    const days = documented ?? configured;
    if (days) {
      const dueMs = dayOf(latest.inspectionDate) + days * DAY;
      const rule = documented ? 'OVERDUE_DOCUMENTED_INTERVAL' : 'OVERDUE_POLICY_INTERVAL';
      next = { date: isoDay(dueMs), basis: 'CALCULATED', citation: documented ? latest.interval.citation : latest.dateCitation,
        text: `Calculated: ${latest.inspectionDate} + ${documented ? `the documented interval (${latest.interval.value})` : `the configured ${days}-day interval${policy.name ? ` (${policy.name})` : ''}`}.` };
      if (dueMs < evalDay) add(rule, 'INSPECTION_REQUIRED', `Inspection overdue: ${next.text.replace(/^Calculated: /, '')} = ${next.date}.`, [latest.dateCitation, documented ? latest.interval.citation : null]);
    }
  }

  // Inspection-type actions: raised in the latest report, or documented as not completed, are requirements;
  // earlier ones without a record of completion are review items.
  const actions = analysis?.inspections?.comparison?.actions ?? [];
  for (const x of actions) {
    // An action conditional on a future change ("If a larger transformer is fitted, re-check …") is not a current requirement.
    if (!INSPECTION_WORDS.test(x.action) || /^\s*(if|when|should|in case)\b/i.test(x.action) || x.closure.status === 'COMPLETED_WITH_EVIDENCE') continue;
    if (x.closure.status === 'NOT_COMPLETED_WITH_EVIDENCE') add('DOCUMENTED_INSPECTION_ACTION', 'INSPECTION_REQUIRED', `Documented as not completed: "${x.action}" (raised ${x.raisedOn}).`, [x.citation, x.closure.citation], { action: x, closure: 'CONFIRMED_OPEN' });
    else if (latest && x.raisedOn === latest.inspectionDate) add('DOCUMENTED_INSPECTION_ACTION', 'INSPECTION_REQUIRED', `Raised in the latest report (${x.raisedOn}): "${x.action}"${x.due ? `, due ${x.due}` : ''}.`, [x.citation], { action: x, closure: 'OPEN_LATEST' });
    else add('ACTION_CLOSURE_NOT_VERIFIED', 'REVIEW_RECOMMENDED', `No record of completion: "${x.action}" (raised ${x.raisedOn}).`, [x.citation], { action: x, closure: 'NOT_VERIFIED' });
  }
  for (const r of latest?.restrictions ?? []) {
    if (INSPECTION_WORDS.test(r.text) && PERIODIC.test(r.text)) add('RESTRICTION_PERIODIC_TESTING', 'INSPECTION_REQUIRED', `Operating restriction in force: ${r.text}`, [r.citation]);
  }

  // Condition: a requirement only under a configured policy.
  if (latest?.condition?.label && POOR.test(latest.condition.label)) {
    const c = `${latest.condition.label}${Number.isFinite(latest.condition.score) ? ` (${latest.condition.score}/${latest.condition.scale})` : ''}`;
    if (policy.conditionRequiresInspection) add('POOR_CONDITION_POLICY', 'INSPECTION_REQUIRED', `Latest documented condition ${c} on ${latest.inspectionDate}; the configured policy requires inspection.`, [latest.condition.citation]);
    else add('POOR_CONDITION_REVIEW', 'REVIEW_RECOMMENDED', `Latest documented condition ${c} on ${latest.inspectionDate}.`, [latest.condition.citation]);
  }
  for (const c of analysis?.review?.components ?? []) {
    if (!c.open || !(c.trend === 'WORSENING_WITH_EVIDENCE' || (c.recurring && c.severity === 'DEFECT'))) continue;
    add('WORSENING_OR_RECURRING', 'REVIEW_RECOMMENDED', `${c.item}: ${c.trend === 'WORSENING_WITH_EVIDENCE' ? 'worsening' : 'recurring defect'} (${c.basis})`, c.observations.filter(o => o.severity && o.severity !== 'OK').map(o => o.citation));
  }
  if (asset.status?.code === 'DEGRADED') add('DEGRADED_STATUS', 'REVIEW_RECOMMENDED', `Operational status degraded${asset.status.source ? ` (${asset.status.source.toLowerCase()})` : ''}${asset.status.asOf ? ` as of ${asset.status.asOf}` : ''}.`, []);

  const records = analysis?.inspections?.count ?? 0;
  if (!records) {
    add('NO_INSPECTION_RECORDS', 'INSUFFICIENT_EVIDENCE', analysisError ? 'The documents could not be analysed, so inspection history cannot be established.'
      : analysis?.documents?.linked ? 'None of the linked documents is a readable inspection report: inspection history cannot be established.' : 'No ACC documents are linked: inspection history cannot be established.', []);
    limitations.push('Inspection history could not be established from the available records; this is not evidence that the asset is healthy or overdue.');
  }
  if (next.basis === 'UNKNOWN' && records) limitations.push('Overdue status cannot be established: no due date or inspection interval is documented or configured.');

  const classification = reasons.reduce((best, r) => (RANK[r.classification] > RANK[best] ? r.classification : best), 'NO_REQUIREMENT_IDENTIFIED');
  // The reasons behind the classification first, then the others (stable within each).
  reasons.sort((x, y) => RANK[y.classification] - RANK[x.classification]);
  return { classification, reasons, nextInspection: next, priority: priorityOf(classification, reasons), limitations, evaluatedAt: new Date(now).toISOString(),
    followUps: followUpsOf(classification, reasons) };
}

/** Priority only from the records: overdue, or the highest documented priority of a triggering action. */
function priorityOf(classification, reasons) {
  if (classification !== 'INSPECTION_REQUIRED') return { level: null, basis: classification === 'REVIEW_RECOMMENDED' ? 'Review candidate: priority to be set by engineering.' : 'Not applicable.' };
  const overdue = reasons.find(r => r.overdueDays !== undefined);
  if (overdue) return { level: 'High', basis: `Overdue by ${overdue.overdueDays} days (documented due date).` };
  const order = ['high', 'medium', 'low'];
  const stated = reasons.filter(r => r.classification === 'INSPECTION_REQUIRED' && r.action?.priority).map(r => r.action.priority)
    .sort((a, b) => order.indexOf(String(a).toLowerCase()) - order.indexOf(String(b).toLowerCase()));
  if (stated.length) return { level: stated[0][0].toUpperCase() + stated[0].slice(1).toLowerCase(), basis: 'Highest priority stated on a triggering action in the inspection report.' };
  return { level: null, basis: 'No priority is stated in the records.' };
}

/** What to do next: the documented actions themselves, or a review (labelled as a suggestion). */
function followUpsOf(classification, reasons) {
  const out = [];
  for (const r of reasons) {
    if (r.action && r.classification === 'INSPECTION_REQUIRED') out.push({ text: r.action.action, basis: 'DOCUMENTED', due: r.action.due ?? null, citations: r.citations });
  }
  if (reasons.some(r => r.rule.startsWith('OVERDUE') || r.rule === 'DUE_WITHIN_WINDOW')) out.push({ text: 'Schedule the overdue inspection.', basis: 'DERIVED', citations: reasons.find(r => r.rule.startsWith('OVERDUE') || r.rule === 'DUE_WITHIN_WINDOW').citations });
  for (const r of reasons.filter(x => x.rule === 'RESTRICTION_PERIODIC_TESTING')) out.push({ text: 'Keep to the periodic testing the operating restriction sets.', basis: 'DOCUMENTED', citations: r.citations });
  if (classification === 'REVIEW_RECOMMENDED') out.push({ text: 'Engineering review of the findings listed, to decide whether an inspection is needed.', basis: 'SUGGESTED', citations: [] });
  if (classification === 'INSUFFICIENT_EVIDENCE') out.push({ text: 'Locate or link the asset\'s inspection records in ACC.', basis: 'SUGGESTED', citations: [] });
  return out.filter((x, i) => out.findIndex(y => y.text === x.text) === i);
}
