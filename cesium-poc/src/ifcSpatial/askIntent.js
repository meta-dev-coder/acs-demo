/**
 * Ask the Twin: what a question asks for, separated into independent dimensions (seagirt_implementation.md §4–§9):
 *
 *   objective   the primary intent (and supporting intents): what the user wants to know or do
 *   target      which assets: named ids, a status filter ("degraded"), categories, or the conversation's previous
 *               collection / selected asset ("it", "these", "this transformer")
 *   scope       where: the selected area, the entire terminal, near / outside the area
 *   temporal    current status, latest or historical inspections, a version, the running simulation
 *   output      the response it expects (assessment, collection, report, email …)
 *
 * The objective is read first and is never overridden by a status word, an asset category or an active area:
 * "Which assets are degraded?" is ASSET_STATUS; "For degraded assets, what needs to be fixed?" is
 * CORRECTIVE_ACTIONS on the assets whose status is DEGRADED. Pure: the screen supplies the known asset ids,
 * the categories and the conversation context, and executes the plan (askOrchestrator.js).
 */

export const INTENT = Object.freeze({
  ASSET_INVENTORY: 'ASSET_INVENTORY', ASSET_LOCATION: 'ASSET_LOCATION', ASSET_STATUS: 'ASSET_STATUS', HISTORICAL_STATUS: 'HISTORICAL_STATUS',
  ASSET_DIAGNOSIS: 'ASSET_DIAGNOSIS', CORRECTIVE_ACTIONS: 'CORRECTIVE_ACTIONS', INSPECTION_HISTORY: 'INSPECTION_HISTORY', CONDITION_TREND: 'CONDITION_TREND',
  RECURRING_DEFECTS: 'RECURRING_DEFECTS', OUTSTANDING_ACTIONS: 'OUTSTANDING_ACTIONS', OPERATING_RESTRICTIONS: 'OPERATING_RESTRICTIONS',
  TECHNICAL_SPECIFICATIONS: 'TECHNICAL_SPECIFICATIONS', REPLACEMENT_ASSESSMENT: 'REPLACEMENT_ASSESSMENT', SUPPLY_DEPENDENCY: 'SUPPLY_DEPENDENCY',
  DOWNSTREAM_IMPACT: 'DOWNSTREAM_IMPACT', ALTERNATE_SUPPLY: 'ALTERNATE_SUPPLY', OUTAGE_IMPACT: 'OUTAGE_IMPACT', VERSION_COMPARISON: 'VERSION_COMPARISON',
  CONSTRUCTION_SCREENING: 'CONSTRUCTION_SCREENING', REPORT_GENERATION: 'REPORT_GENERATION', EMAIL_DRAFT: 'EMAIL_DRAFT', UNKNOWN: 'UNKNOWN',
});
/** Investigations answered from the assets' ACC documents (the maintenance assessment). */
export const MAINTENANCE_INTENTS = new Set([INTENT.CORRECTIVE_ACTIONS, INTENT.ASSET_DIAGNOSIS, INTENT.OUTSTANDING_ACTIONS, INTENT.RECURRING_DEFECTS,
  INTENT.CONDITION_TREND, INTENT.OPERATING_RESTRICTIONS, INTENT.HISTORICAL_STATUS, INTENT.INSPECTION_HISTORY]);
/** Intents that need exactly one asset (a clarification when several are possible). */
const SINGLE_ASSET = new Set([INTENT.OUTAGE_IMPACT, INTENT.REPLACEMENT_ASSESSMENT]);

// ---- normalisation: case, punctuation, a few spelling variants and one-letter typos in the words that decide intent ----

const VOCAB = ['degraded', 'fixed', 'fix', 'repair', 'repairs', 'repaired', 'inspection', 'inspections', 'defect', 'defects', 'outstanding', 'maintenance',
  'restriction', 'restrictions', 'replacement', 'replacing', 'replace', 'operating', 'recurring', 'alternate', 'condition', 'diagnose', 'problem', 'problems',
  'transformer', 'transformers', 'breaker', 'breakers', 'findings', 'finding', 'investigate', 'worse', 'worsening', 'occurred', 'corrective', 'issues', 'issue',
  'degradation', 'shutdown', 'outage', 'report', 'email', 'supply', 'powered', 'without', 'offline', 'actions', 'action'];
const editDistance1 = (a, b) => {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i += 1; else if (b.length > a.length) j += 1;
    else if (a[i + 1] === b[j] && a[i] === b[j + 1]) { i += 2; j += 2; } // a swap counts once
    else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
};
/** The question with typos in deciding words corrected (only words of five letters or more, one edit). */
export function normalizeQuestion(question) {
  return String(question ?? '').replace(/\s+/g, ' ').trim().replace(/[A-Za-z]{5,}/g, w => {
    const lower = w.toLowerCase();
    if (VOCAB.includes(lower)) return w;
    const hit = VOCAB.find(v => v.length >= 5 && editDistance1(lower, v));
    return hit ?? w;
  });
}

// ---- objective: ordered from the most specific, so a status word or a category never decides it ----

const R = (re, intent, extra = {}) => ({ re, intent, ...extra });
const OBJECTIVES = [
  R(/\b(draft|write|prepare|compose|send)\b[^?]*\b(e-?mail|message)\b|\b(inform|notify|tell|let)\b[^?]*\b(team|engineer|engineers|maintenance|crew|manager)\b|\be-?mail (it|this|them|the team)\b/i, INTENT.EMAIL_DRAFT),
  R(/\b(prepare|generate|create|make|produce|build|export)\b[^?]*\b(report|register|spreadsheet|excel|pdf|xlsx)\b|\breport (of|on|for) (these|those|this|the)\b/i, INTENT.REPORT_GENERATION),
  R(/\b(what (happens|would happen|will happen)|what if|impact of|effect of|consequences? of)\b[^?]*\b(shut|switch(ed)? off|turn(ed)? off|take|taken|out of service|offline|fail|fails|failed|outage|lose|trip|isolat|de-?energi[sz])|\bif (we|i|you)\s+(shut|switch|turn|take|isolate)\b|\bwho (loses|would lose) power\b/i, INTENT.OUTAGE_IMPACT),
  R(/\b(alternate|alternative|backup|back-up|redundan\w*|second(ary)? (supply|feed)|standby supply|other (supply|feed))\b/i, INTENT.ALTERNATE_SUPPLY),
  R(/\b(before (replac|swapp|changing)|replacement (assessment|readiness|requirements?|checks?)|(need|needs|required|requirements?) (to be done )?(for|before) (a |the )?replace|ready (for|to) (be )?replac|should (we|it) be replaced|need(s)? (to be )?replac|immediate replacement)\w*/i, INTENT.REPLACEMENT_ASSESSMENT),
  R(/\b(continue (operating|to operate|running|in service)|keep (it |them )?(running|operating|in service)|remain in service|safe to (operate|run|use)|operating (restrictions?|limits?|limitations?)|restrictions?|derat\w*|can (we|it|they) (still )?(run|operate|be operated)|(can|could) (the )?maintenance be deferred|defer(red)? (the )?maintenance)\b/i, INTENT.OPERATING_RESTRICTIONS),
  R(/\bsince when\b|\bhow long (has|have|is|are)\b[^?]*\b(degraded|been|without power|offline|no power)\b|\bwhen did\b[^?]*\b(become|start|go|get)\b[^?]*\b(degraded|offline|lose|lost)\b/i, INTENT.HISTORICAL_STATUS),
  R(/\b(getting|got|becoming|become) (worse|better)\b|\bdeteriorat\w*|\bworsen\w*|\bcondition (trend|history|over time|changed)\b|\btrend\b|\bimprov(ed|ing)\b|\bwhat changed since\b[^?]*\binspection\b|\bbecome more serious\b/i, INTENT.CONDITION_TREND),
  R(/\b(occurred|happened|seen|reported|found|recorded|documented) (before|previously|earlier)\b|\brecurr\w*|\brepeat(ed|ing)?\b[^?]*\b(defects?|findings?|issues?|problems?)\b|\bsame (defect|issue|finding|problem)\b|\bfirst (reported|recorded|documented|seen)\b|\bhappened before\b/i, INTENT.RECURRING_DEFECTS),
  R(/\b(still )?(outstanding|open|unresolved|pending|not (yet )?(closed|completed|done|fixed|resolved))\b[^?]*\b(actions?|repairs?|work|items?|findings?|defects?)\b|\b(actions?|repairs?|work|defects?)\b[^?]*\b(still )?(outstanding|open|unresolved|pending)\b|\b(been|was|were) (fixed|repaired|resolved|closed) yet\b|\bstill (open|outstanding)\b/i, INTENT.OUTSTANDING_ACTIONS),
  R(/\b(what|which)\b[^?]*\b(needs?|need to be|has to be|have to be|must be|should be|to be)\s+(fixed|repaired|done|addressed|corrected|investigated|replaced|resolved)\b|\b(what|which) (repairs?|maintenance|corrective actions?|fixes|work)\b|\b(repairs?|corrective actions?|maintenance) (are |is )?(required|needed|recommended|necessary)\b|\bwhat should (the )?(maintenance team|we|they|engineers?) (do|investigate|fix|check|look at)\b|\bhow (do|can|should) (we|i) fix\b|\bfix(es)? (needed|required)\b|\brecommended (actions?|repairs?)\b/i, INTENT.CORRECTIVE_ACTIONS),
  R(/\bwhy (is|are|has|have|was|were|did)\b|\bwhat('?s| is| are) wrong\b|\bwhat('?s| is| are) the (problem|issue|cause|fault)s?\b|\bcause (of|for)\b[^?]*\b(degrad|fault|failure|problem|issue|status)|\breason (for|why)\b|\bdiagnos\w*|\broot cause\b|\bwhat (problems?|issues?|defects?|faults?) (does|do|is|are|has|have)\b/i, INTENT.ASSET_DIAGNOSIS),
  R(/\b(inspection|maintenance) (history|records?|reports?)\b|\binspected\b|\blast inspection\b|\blatest inspection\b|\bwhen was\b[^?]*\binspect/i, INTENT.INSPECTION_HISTORY),
  R(/\b(spec(ification)?s?|datasheet|data sheet|nameplate|rating|rated|capacity|dimensions?|weight)\b/i, INTENT.TECHNICAL_SPECIFICATIONS),
  R(/\b(v\d+|versions?)\b[^?]*\b(changed?|added|removed|moved|differ\w*|compare)\b|\b(changed?|added|removed|moved)\b[^?]*\b(v\d+|versions?|ifc)\b/i, INTENT.VERSION_COMPARISON),
  R(/\b(construction|excavat\w*|dig(ging)?|trench\w*|civil works?)\b|\bcables?\b[^?]*\b(cross(es|ing)?|run through|pass(es)? through)\b/i, INTENT.CONSTRUCTION_SCREENING),
  R(/\b(outside|elsewhere|beyond)\b[^?]*\b(depend\w*|supplied by|fed by|downstream|affect\w*)\b|\bdownstream\b|\bwhat does\b[^?]*\b(supply|feed)\b|\bwhat (is|are) (supplied|fed) by\b/i, INTENT.DOWNSTREAM_IMPACT),
  R(/\bwhere does\b[^?]*\b(power|supply|electricity)\b|\b(get|gets) (its|their) (power|supply)\b|\bpower(ed)? from\b|\bsupply path\b|\bupstream\b|\b(which|what) \w+ (supply|supplies|feed|feeds)\b|\bsupplied by\b|\bfed (by|from)\b/i, INTENT.SUPPLY_DEPENDENCY),
  R(/\b(degraded|no power|without power|unpowered|de-?energi[sz]ed|offline|power status|status|alerts?|alarms?|operational|energi[sz]ed|powered|have power|has power|working|healthy|attention)\b/i, INTENT.ASSET_STATUS),
  R(/\b(where is|where are|locate|find|show me|on the map|zoom to|focus on)\b/i, INTENT.ASSET_LOCATION),
  R(/\b(how many|count|list|show|which|what|any|all)\b/i, INTENT.ASSET_INVENTORY),
];
/** Supporting intents run with a primary one (§6: "what needs to be fixed" also diagnoses and reads the history). */
const SUPPORTING = {
  [INTENT.CORRECTIVE_ACTIONS]: [INTENT.ASSET_DIAGNOSIS, INTENT.INSPECTION_HISTORY],
  [INTENT.ASSET_DIAGNOSIS]: [INTENT.INSPECTION_HISTORY],
  [INTENT.OUTSTANDING_ACTIONS]: [INTENT.INSPECTION_HISTORY],
  [INTENT.RECURRING_DEFECTS]: [INTENT.INSPECTION_HISTORY],
  [INTENT.CONDITION_TREND]: [INTENT.INSPECTION_HISTORY],
  [INTENT.OPERATING_RESTRICTIONS]: [INTENT.INSPECTION_HISTORY, INTENT.ASSET_STATUS],
  [INTENT.HISTORICAL_STATUS]: [INTENT.ASSET_STATUS, INTENT.INSPECTION_HISTORY],
  [INTENT.REPLACEMENT_ASSESSMENT]: [INTENT.INSPECTION_HISTORY, INTENT.TECHNICAL_SPECIFICATIONS, INTENT.SUPPLY_DEPENDENCY, INTENT.OUTAGE_IMPACT],
  [INTENT.REPORT_GENERATION]: [], [INTENT.EMAIL_DRAFT]: [],
};

/** The primary and supporting intents of a question; several objectives in one question are all kept. */
export function resolveObjective(question) {
  const q = normalizeQuestion(question);
  const hits = OBJECTIVES.filter(o => o.re.test(q)).map(o => o.intent);
  // A report and an email together: the report is made first, the email attaches it.
  const primary = hits.includes(INTENT.REPORT_GENERATION) && hits[0] === INTENT.EMAIL_DRAFT ? INTENT.REPORT_GENERATION : hits[0] ?? INTENT.UNKNOWN;
  // "Prepare a report … and draft an email": the report first, the email depends on it.
  const also = hits.filter(i => [INTENT.EMAIL_DRAFT, INTENT.REPORT_GENERATION].includes(i) && i !== primary);
  return { primary, supporting: [...new Set([...(SUPPORTING[primary] ?? []), ...also])], all: [...new Set(hits)] };
}

// ---- asset filters: status words and categories are filters, never the objective ----

const STATUS_WORDS = [
  [/\bdegrad\w*/i, 'DEGRADED'],
  [/\b(no power|without power|unpowered|de-?energi[sz]ed|lost power|dark)\b/i, 'NO_POWER'],
  [/\boffline\b|\bout of service\b/i, 'OFFLINE'],
];
/** Status filters named in the question ("for degraded assets" → DEGRADED). */
export function statusFiltersOf(question, primary) {
  const q = normalizeQuestion(question);
  // "out of service" in an outage question is the action, not a filter.
  return STATUS_WORDS.filter(([re, code]) => re.test(q) && !(code === 'OFFLINE' && primary === INTENT.OUTAGE_IMPACT)).map(([, code]) => code);
}

// ---- target: named ids, then references to the conversation, then filters over the scope ----

// "this area", "that zone" are the scope, never an asset reference.
const NOT_ASSET = '(?!\\s+(?:area|zone|selection|boundary|region|polygon|rectangle|terminal|site)\\b)';
const PLURAL_REF = new RegExp(`\\b(?:these|those)${NOT_ASSET}\\b|\\b(?:them|they|their)\\b|\\bthe (?:assets|ones|results|same assets)\\b|\\b(?:each|all) of them\\b`, 'i');
const SINGLE_REF = new RegExp(`\\b(?:it|its)\\b|\\b(?:this|that)${NOT_ASSET}(?:\\s+\\w+)?\\b|\\bthe asset\\b`, 'i');
const OBJECTIVE_NOUNS = /\b(?:alternate|alternative|backup|back-up|second(?:ary)?|standby|other|power|electrical)\s+(?:power\s+)?(?:supply|supplies|feed)\b|\bsupply (?:path|paths|dependenc\w*|chain|route)\b|\b(?:supplied|fed|powered) (?:by|from)\b|\b(?:maintenance|inspection|corrective action) (?:report|register|records?|history|team)\b|\b(?:report|register|e-?mail)\b/gi;
/** "for degraded assets", "all degraded …", "which … are degraded": the status word chooses assets (a filter). */
const FILTER_PHRASE = /\b(?:for|all|any|every|each|the|which|what)\s+(?:of the\s+)?(?:degrad\w*|unpowered|offline)\b|\b(?:degrad\w*|unpowered|offline)\s+(?:assets?|equipment|ones|transformers?|breakers?|cranes?|\w+s)\b|\bassets? (?:that are|which are|with)\b/i;

/**
 * Which assets a question is about.
 * @param {string} question
 * @param {object} ctx
 * @param {(q: string) => string[]} ctx.namedIds asset ids named in the question (validated by the caller)
 * @param {(q: string) => string[]|'ALL'|null} [ctx.categoriesIn] categories named in the question
 * @param {object} [ctx.conversation] {selectedAssetId, collection: {ids, label}, investigation: {ids}}
 * @returns {{kind: 'NAMED'|'PREVIOUS'|'SELECTED'|'FILTER'|'SCOPE', ids: string[]|null, statusFilters: string[], categories: string[]|null, reference: string|null}}
 */
export function resolveTarget(question, { namedIds = () => [], categoriesIn = () => null, conversation = {}, primary = INTENT.UNKNOWN } = {}) {
  const q = normalizeQuestion(question);
  const named = namedIds(q);
  // Words that state the objective are not asset categories ("alternate supply" is not the "Supply" category).
  const cats = categoriesIn(q.replace(OBJECTIVE_NOUNS, ' '));
  const categories = Array.isArray(cats) ? cats : null;
  const statusFilters = statusFiltersOf(q, primary);
  if (named.length) return { kind: 'NAMED', ids: named, statusFilters, categories, reference: null };
  const conv = conversation ?? {};
  const previous = conv.investigation?.ids?.length ? conv.investigation.ids : conv.collection?.ids ?? [];
  // An explicit reference ("this asset", "it", "these") wins over a status word that only describes it
  // ("Why is this asset degraded?"); a status word that selects assets ("for degraded assets") is a filter.
  const filtering = statusFilters.length > 0 && FILTER_PHRASE.test(q);
  // "these", "them": the previous collection. "it", "this asset": the selected asset, else a previous collection of one.
  if (PLURAL_REF.test(q) && previous.length && !filtering) return { kind: 'PREVIOUS', ids: [...previous], statusFilters: [], categories, reference: 'collection' };
  if (SINGLE_REF.test(q) && !filtering) {
    if (conv.selectedAssetId) return { kind: 'SELECTED', ids: [conv.selectedAssetId], statusFilters: [], categories, reference: 'selected' };
    if (previous.length) return { kind: 'PREVIOUS', ids: [...previous], statusFilters: [], categories, reference: 'collection' };
  }
  if (statusFilters.length || categories) return { kind: 'FILTER', ids: null, statusFilters, categories, reference: null };
  // No asset words at all ("What needs to be fixed?"): a follow-up on what the conversation was about.
  const noAssetWords = !/\b(assets?|equipment|everything|anything|all)\b/i.test(q);
  if (noAssetWords && conv.selectedAssetId && !previous.length) return { kind: 'SELECTED', ids: [conv.selectedAssetId], statusFilters, categories, reference: 'selected' };
  if (noAssetWords && previous.length) return { kind: 'PREVIOUS', ids: [...previous], statusFilters, categories, reference: 'collection' };
  if (noAssetWords && conv.selectedAssetId) return { kind: 'SELECTED', ids: [conv.selectedAssetId], statusFilters, categories, reference: 'selected' };
  return { kind: 'SCOPE', ids: null, statusFilters, categories, reference: null };
}

// ---- scope and time ----

const TERMINAL = /\b(?:across|throughout|in|for|of|over)\s+(?:all\s+of\s+)?(?:the\s+)?(?:whole\s+|entire\s+)?(?:seagirt|terminal|site|port)\b|\b(?:entire|whole|full)\s+(?:terminal|site|port|network|model)\b|\ball of seagirt\b|\beverywhere\b|\bterminal[- ]wide\b/i;
const AREA_REF = /\b(?:in|within|inside|across|for|of|from)\s+(?:the\s+)?(?:this|that|selected|the selected|my)\s+(?:area|zone|selection|boundary)\b|\b(?:this|that|the selected)\s+(?:area|zone|selection)\b/i;
/** Where the question applies: the selected area (when one is active, by default), or the whole terminal. */
export function resolveScope(question, { area = null } = {}) {
  const q = normalizeQuestion(question);
  if (TERMINAL.test(q) && !AREA_REF.test(q)) return { type: 'TERMINAL', explicit: true, selectionId: null, ifcVersionId: area?.versionKey ?? null };
  if (area) return { type: 'SELECTED_AREA', explicit: AREA_REF.test(q), selectionId: area.selectionId, ifcVersionId: area.versionKey ?? null };
  if (AREA_REF.test(q)) return { type: 'NO_AREA_SELECTED', explicit: true, selectionId: null, ifcVersionId: null };
  return { type: 'TERMINAL', explicit: false, selectionId: null, ifcVersionId: null };
}
export function resolveTemporal(question, primary) {
  const q = normalizeQuestion(question);
  if (primary === INTENT.HISTORICAL_STATUS) return 'HISTORICAL_STATUS';
  if (/\b(previous|earlier|last time|before|history|historical|over time)\b/i.test(q) || [INTENT.CONDITION_TREND, INTENT.RECURRING_DEFECTS].includes(primary)) return 'HISTORICAL_INSPECTIONS';
  if (MAINTENANCE_INTENTS.has(primary)) return 'LATEST_INSPECTION';
  if (/\bsimulat\w*\b/i.test(q)) return 'SIMULATED';
  return 'CURRENT';
}

// ---- the plan ----

const STEPS = {
  MAINTENANCE: ['RESOLVE_SCOPE', 'RESOLVE_TARGETS', 'FILTER_ASSETS_BY_STATUS', 'RETRIEVE_OPERATIONAL_STATUS', 'RETRIEVE_LINKED_DOCUMENTS', 'ANALYSE_INSPECTIONS', 'EXTRACT_CORRECTIVE_ACTIONS', 'BUILD_MAINTENANCE_ASSESSMENT', 'HIGHLIGHT_MATCHING_ASSETS'],
};
const RESPONSE = {
  [INTENT.CORRECTIVE_ACTIONS]: 'MAINTENANCE_ASSESSMENT', [INTENT.ASSET_DIAGNOSIS]: 'MAINTENANCE_ASSESSMENT', [INTENT.OUTSTANDING_ACTIONS]: 'MAINTENANCE_ASSESSMENT',
  [INTENT.RECURRING_DEFECTS]: 'MAINTENANCE_ASSESSMENT', [INTENT.CONDITION_TREND]: 'MAINTENANCE_ASSESSMENT', [INTENT.OPERATING_RESTRICTIONS]: 'MAINTENANCE_ASSESSMENT',
  [INTENT.HISTORICAL_STATUS]: 'MAINTENANCE_ASSESSMENT', [INTENT.INSPECTION_HISTORY]: 'MAINTENANCE_ASSESSMENT',
  [INTENT.ASSET_STATUS]: 'ASSET_COLLECTION', [INTENT.ASSET_INVENTORY]: 'ASSET_COLLECTION', [INTENT.ASSET_LOCATION]: 'ASSET_COLLECTION',
  [INTENT.OUTAGE_IMPACT]: 'OUTAGE_SIMULATION', [INTENT.ALTERNATE_SUPPLY]: 'ALTERNATE_SUPPLY', [INTENT.SUPPLY_DEPENDENCY]: 'SUPPLY_PATH', [INTENT.DOWNSTREAM_IMPACT]: 'SUPPLY_PATH',
  [INTENT.REPLACEMENT_ASSESSMENT]: 'REPLACEMENT_ASSESSMENT', [INTENT.TECHNICAL_SPECIFICATIONS]: 'DOCUMENT_REVIEW', [INTENT.VERSION_COMPARISON]: 'VERSION_COMPARISON',
  [INTENT.CONSTRUCTION_SCREENING]: 'CONSTRUCTION_SCREENING', [INTENT.REPORT_GENERATION]: 'REPORT', [INTENT.EMAIL_DRAFT]: 'EMAIL_DRAFT',
};

/**
 * The investigation plan for a question: objective, target, scope, time, steps and the response type. Validated:
 * only known intents, only asset ids the model has, the active selection's id. `clarify` is set when the
 * question needs one asset and several are possible (never chosen arbitrarily).
 */
export function planQuestion(question, { knownIds = new Set(), namedIds = () => [], categoriesIn = () => null, conversation = {}, area = null } = {}) {
  const objective = resolveObjective(question);
  const target = resolveTarget(question, { namedIds: q => namedIds(q).filter(id => knownIds.has(id)), categoriesIn, conversation, primary: objective.primary });
  const scope = resolveScope(question, { area });
  const plan = {
    question: String(question ?? ''), primaryIntent: objective.primary, supportingIntents: objective.supporting,
    scope, target, assetFilters: { operationalStatus: target.statusFilters, assetTypes: target.categories ?? [] },
    temporal: resolveTemporal(question, objective.primary),
    steps: MAINTENANCE_INTENTS.has(objective.primary) ? STEPS.MAINTENANCE : [],
    responseType: RESPONSE[objective.primary] ?? 'ANSWER', clarify: null,
  };
  if (SINGLE_ASSET.has(objective.primary) && target.ids && target.ids.length > 1 && target.kind !== 'NAMED') plan.clarify = { reason: 'ONE_ASSET_NEEDED', options: target.ids.slice(0, 8) };
  return validatePlan(plan, { knownIds });
}

/** A plan only names intents, steps and asset ids that exist; anything else is dropped (and said). */
export function validatePlan(plan, { knownIds = new Set() } = {}) {
  const intents = new Set(Object.values(INTENT));
  const problems = [];
  if (!intents.has(plan.primaryIntent)) { problems.push(`unknown intent ${plan.primaryIntent}`); plan.primaryIntent = INTENT.UNKNOWN; }
  plan.supportingIntents = plan.supportingIntents.filter(i => intents.has(i));
  if (plan.target.ids) {
    const unknown = plan.target.ids.filter(id => !knownIds.has(id));
    if (unknown.length) problems.push(`not in the model: ${unknown.join(', ')}`);
    plan.target = { ...plan.target, ids: plan.target.ids.filter(id => knownIds.has(id)) };
  }
  const allowed = new Set(Object.values(STEPS).flat());
  plan.steps = plan.steps.filter(s => allowed.has(s));
  plan.problems = problems;
  return plan;
}

/** Whether a plan is a maintenance investigation (answered by the orchestrator from the assets' ACC documents). */
export const isMaintenancePlan = plan => MAINTENANCE_INTENTS.has(plan.primaryIntent) && plan.scope.type !== 'NO_AREA_SELECTED';
