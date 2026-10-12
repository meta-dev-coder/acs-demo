/**
 * Running several capabilities to answer one question, safely.
 *
 * The problem this exists for: "Why is this incident high risk, which upstream resources are
 * available, and what would change if we dispatched five minutes earlier?" is three questions.
 * The deterministic layer recognised the first clause, answered it, and silently dropped the other
 * two. An operator got a confident partial answer with no sign that two thirds of what they asked
 * had been discarded.
 *
 * So a question is resolved to a PLAN of capabilities, the plan is executed under limits, and the
 * answer is composed from whatever actually succeeded — with anything that failed or was
 * unavailable reported rather than quietly omitted.
 *
 * Bounded by construction: a capped number of steps, one execution per capability per
 * investigation, a per-step timeout, and a failure in one step never loses the others.
 *
 * Pure orchestration. It knows nothing about Cesium, the DOM or the model.
 */
import { capabilityAvailable, PROVENANCE } from './capabilities.js';

export const ORCHESTRATION_LIMITS = Object.freeze({
  /** Enough for the compound questions this is built for; small enough to stay explainable. */
  maxSteps: 6,
  /** A capability runs once per investigation — asking twice cannot produce a different answer. */
  allowRepeats: false,
  perStepTimeoutMs: 10_000,
});

/**
 * Which capabilities a question needs.
 *
 * Matching is intentionally conservative and additive: each clause that is recognised adds a step,
 * so a three-clause question produces three steps rather than the first match winning. A question
 * that matches nothing produces an empty plan and the caller falls through to its existing
 * behaviour — this never swallows a question it cannot improve on.
 */
const CLAUSE_RULES = Object.freeze([
  // Stems end in \w* rather than \b: "dispatched", "contributing" and "responder" are the words
  // people actually type, and a trailing boundary rejected every one of them.
  { capability: 'get_incident_analysis',
    match: /\b(why|risk\w*|dangerous|factors?|contribut\w*|severity|score)\b/i },
  { capability: 'analyze_upstream_protection',
    match: /\b(upstream|approach\w*|dms|sign\w*|warn\w*|camera\w*|cctv|queue\w*|protect\w*)\b/i },
  { capability: 'get_patrol_response_options',
    match: /\b(patrol\w*|road ranger\w*|ranger\w*|respond\w*|responder\w*|dispatch\w*|eligib\w*)\b/i },
  { capability: 'compare_response_scenarios',
    match: /\b(what if|earlier|sooner|later|compare\w*|scenario\w*|instead of)\b/i },
  { capability: 'search_work_orders',
    match: /\b(work ?orders?|open work|maintenance work|overdue)\b/i },
  { capability: 'get_asset_history',
    match: /\b(asset history|history (for|of) (this |the )?asset|repeat\w*|previous (work|repairs?))\b/i },
]);

/**
 * A question about what a thing IS, rather than about the corridor.
 *
 * "What is a DMS?" mentions a DMS and would otherwise plan an upstream investigation, producing a
 * structured evidence report for a vocabulary question. The spec is explicit that simple questions
 * must not be forced into that shape, so definitional phrasing short-circuits planning entirely.
 */
const DEFINITIONAL = /^\s*(what|who)\s+(is|are|does|do)\s+(a|an|the)?\s*\w+\s*\??\s*$|^\s*(define|explain the term|meaning of)\b/i;

/**
 * Whether a question asks for more than one thing.
 *
 * Used only to decide that an investigation is worth running; the plan itself comes from the
 * clause rules. Deliberately not a general parser: it is looking for the shape of a compound
 * operational question, not trying to understand English.
 */
export function isCompoundQuestion(question) {
  const text = String(question ?? '');
  if (!text.trim()) return false;
  const joined = /\b(and|also|then|plus)\b|[;,]\s*(and\s+)?(what|which|how|why|where|show)\b/i.test(text);
  return joined && planFor(text).length > 1;
}

/** The capabilities a question calls for, in a stable order, each at most once. */
export function planFor(question) {
  const text = String(question ?? '');
  if (DEFINITIONAL.test(text)) return [];
  const steps = [];
  for (const rule of CLAUSE_RULES) {
    if (rule.match.test(text) && !steps.includes(rule.capability)) steps.push(rule.capability);
  }
  return steps.slice(0, ORCHESTRATION_LIMITS.maxSteps);
}

const withTimeout = (work, ms) => new Promise(resolve => {
  let settled = false;
  const finish = value => { if (!settled) { settled = true; resolve(value); } };
  const timer = setTimeout(() => finish({ timedOut: true }), ms);
  Promise.resolve()
    .then(work)
    .then(value => { clearTimeout(timer); finish({ value }); })
    .catch(error => { clearTimeout(timer); finish({ error }); });
});

/**
 * Run a plan.
 *
 * Every step is reported — succeeded, unavailable, failed or skipped — because an investigation
 * that quietly ran four of six steps is indistinguishable from one that ran all six.
 *
 * @returns {Promise<{steps, results, actions, limitations, provenance, grounded}>}
 */
export async function runInvestigation(plan, registry, context, {
  limits = ORCHESTRATION_LIMITS, trace = null,
} = {}) {
  const steps = [];
  const results = {};
  const actions = [];
  const limitations = [];
  const seen = new Set();
  const provenances = new Set();

  for (const name of plan.slice(0, limits.maxSteps)) {
    if (!limits.allowRepeats && seen.has(name)) {
      steps.push({ capability: name, status: 'skipped', reason: 'Already run in this investigation.' });
      continue;
    }
    seen.add(name);
    const capability = registry?.[name];
    if (!capability) {
      steps.push({ capability: name, status: 'unknown', reason: 'No such capability.' });
      continue;
    }
    const { available, reason } = capabilityAvailable(capability, context);
    if (!available) {
      // Reported, not hidden: "only on a historical date" is useful to an operator.
      steps.push({ capability: name, status: 'unavailable', reason });
      limitations.push(`${name}: ${reason}`);
      continue;
    }

    const started = Date.now();
    const outcome = await withTimeout(() => capability.handler(context?.capabilityInput?.[name] ?? {}, context),
      limits.perStepTimeoutMs);
    const ms = Date.now() - started;

    if (outcome.timedOut) {
      steps.push({ capability: name, status: 'timeout', ms });
      limitations.push(`${name}: timed out after ${limits.perStepTimeoutMs} ms.`);
      continue;
    }
    if (outcome.error) {
      // One failing capability must not lose the others' evidence.
      steps.push({ capability: name, status: 'error', ms, reason: String(outcome.error?.message ?? outcome.error) });
      limitations.push(`${name}: failed to run.`);
      continue;
    }
    const result = outcome.value;
    steps.push({ capability: name, status: result?.status ?? 'ok', ms,
      records: Array.isArray(result?.evidence) ? result.evidence.length : 0 });
    results[name] = result;
    if (result?.status === 'unavailable') {
      limitations.push(`${name}: ${result.reason}`);
      continue;
    }
    provenances.add(result?.provenance ?? PROVENANCE.OBSERVED);
    for (const limitation of result?.limitations ?? []) limitations.push(limitation);
    for (const action of result?.actions ?? []) actions.push(action);
  }

  trace?.({ plan, steps });

  return Object.freeze({
    steps: Object.freeze(steps),
    results,
    actions: Object.freeze(dedupeActions(actions)),
    limitations: Object.freeze([...new Set(limitations)]),
    // A mixed investigation says so rather than inheriting the first step's label.
    provenance: provenances.size === 0 ? PROVENANCE.UNAVAILABLE
      : provenances.size === 1 ? [...provenances][0] : PROVENANCE.MIXED,
    /** Whether anything at all came back with evidence behind it. */
    grounded: Object.values(results).some(result => result?.status === 'ok' && result.evidence.length > 0),
  });
}

/** The same action offered by two capabilities is still one action. */
function dedupeActions(actions) {
  const seen = new Set();
  const out = [];
  for (const action of actions) {
    const key = JSON.stringify([action.type, action.incidentId ?? action.patrolId ?? action.assetId ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(action);
  }
  return out;
}
