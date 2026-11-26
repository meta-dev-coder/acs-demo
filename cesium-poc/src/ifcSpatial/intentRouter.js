/**
 * Ask the Twin intent routing for questions about relationships between assets, ahead of the
 * network engine (askSeagirt.js). The engine takes any question naming an asset as "locate it"; these
 * analytical questions must not end there:
 *
 *   SUPPLY_RELATIONSHIP     does A supply B? is B powered by A? is A upstream of B? does power flow from A to B?
 *   PHYSICAL_CONNECTIVITY   are A and B (physically / electrically) connected?
 *   ALTERNATE_SUPPLY        does X have an alternate supply if it shuts down? if A fails, can B still get power?
 *   ASSET_DETAILS           what is A? is A a substation or a ring main unit?
 *   CLARIFY                 "it" could be more than one asset of the conversation
 *
 * Everything else returns null and keeps its existing route (outage, upstream, downstream, path,
 * inventory, status, version comparison, documents). Assets are the model's own ids, matched whole;
 * "it" / "this" / "that" is the asset of the conversation when there is exactly one.
 */
import { namedIds } from './askCompare.js';

const PRONOUN = /\b(it|its|this|that|this asset|that asset)\b/i;
const FAILURE = /\b(fails?|failed|shuts? down|goes (down|offline|out)|is (offline|out|down|lost|tripped)|trips?|has no power|loses (power|supply)|is out of service)\b/i;
const ALTERNATE = /\b(alternat\w*|backup|back-up|other supply|another supply|redundan\w*|still (receive|get|have|be|stay) (power|supplied|energi[sz]ed|on|powered)|still (be )?powered|stay (powered|on|energi[sz]ed)|keep (power|its supply))\b/i;
const SUPPLY_VERB = /\b(suppl(y|ies|ying|ied)|feed(s|ing)?|fed|power(s|ing|ed)|upstream|downstream|flows?|energi[sz]e[sd]?)\b/i;
const CONNECTED = /\b(physically|electrically)\b.*\bconnect\w*\b|\bare\b.*\bconnected\b|\bconnection between\b|\bconnected (to|with)\b|\blinked\b/i;
const DETAILS = /^\s*(what|which kind of thing|what type of (asset|equipment)) (is|are) (the )?[\w-]+\s*\??\s*$|\bis [\w-]+ an? (substation|ring main unit|transformer|switchgear|breaker|cable|light|crane|load)\b/i;

/**
 * @param {string} question
 * @param {object} opts
 * @param {Set<string>} opts.assetIds the network's asset ids
 * @param {string[]} [opts.lastAssets] the assets of the conversation so far, most recent first
 * @returns {null | {intent: string, entities: object, clarify?: {options: string[], question: string}}}
 */
export function classifyQuestion(question, { assetIds, lastAssets = [] }) {
  const q = String(question ?? '');
  const named = namedIds(q, assetIds);
  const context = [...new Set(lastAssets.filter(id => assetIds.has(id)))];
  const usesPronoun = PRONOUN.test(q);
  /** The assets the question means: named ones, plus the conversation's for "it" (or a clarification). */
  const withPronoun = needed => {
    if (named.length >= needed || !usesPronoun) return { ids: named };
    const candidates = context.filter(id => !named.includes(id));
    if (candidates.length === 1) return { ids: insertPronoun(q, named, candidates[0]) };
    if (candidates.length > 1) return { clarify: candidates };
    return { ids: named };
  };
  const clarifying = (options, intent) => ({ intent: 'CLARIFY', entities: { for: intent }, clarify: { options, question: q } });

  // Alternate supply when something fails: before outage and before plain supply questions.
  // "Can TX-M2 supply the loads if TX-M1 fails?": TX-M2 as a candidate source for TX-M1's loads.
  const takeOver = FAILURE.test(q) && /\b(can|could|will|would)\b.*\b(suppl\w*|feed|pick up|carry|take over|back up)\b/i.test(q);
  if ((ALTERNATE.test(q) && (FAILURE.test(q) || /\balternat\w* supply|backup supply\b/i.test(q))) || takeOver) {
    const r = withPronoun(1);
    if (r.clarify) return clarifying(r.clarify, 'ALTERNATE_SUPPLY');
    if (!r.ids.length) return null;
    // The failing asset is the one in the "if/when … fails" clause; the other one is the asset asked about.
    const clause = /\b(?:if|when|once)\s+(?:the\s+)?([A-Za-z0-9][\w-]*)\b[^?.]*?\b(?:fails?|failed|shuts?|goes|is|trips?|has|loses)\b/i.exec(q);
    const fromClause = clause && r.ids.find(id => id.toLowerCase() === clause[1].toLowerCase());
    const failed = fromClause ?? (/\bif it\b|\bwhen it\b/i.test(q) && r.ids.length ? r.ids[0] : r.ids[0]);
    const other = r.ids.find(id => id !== failed) ?? null;
    // The other asset is the one asked about, unless it is offered as the supply ("can X supply …").
    const candidate = other && new RegExp(`\\b${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^?]*?\\b(suppl\\w*|feed|pick up|carry|take over|back up)`, 'i').test(q) ? other : null;
    return { intent: 'ALTERNATE_SUPPLY', entities: { failedAssetId: failed, targetAssetId: candidate ? null : other, candidateSourceId: candidate } };
  }

  // Two assets and a supply verb: the relationship between them, never "locate the first".
  if (SUPPLY_VERB.test(q) && !/^\s*what (does|do|will|would|can)\b/i.test(q) && !/^\s*what (supplies|feeds|powers)\b/i.test(q)) {
    const r = withPronoun(2);
    if (r.clarify) return clarifying(r.clarify, 'SUPPLY_RELATIONSHIP');
    if (r.ids.length >= 2) return { intent: 'SUPPLY_RELATIONSHIP', entities: direction(q, r.ids) };
  }

  if (CONNECTED.test(q) && !/\b(which|what) (cables?|feeders?)\b/i.test(q)) {
    const r = withPronoun(2);
    if (r.clarify) return clarifying(r.clarify, 'PHYSICAL_CONNECTIVITY');
    if (r.ids.length >= 2) return { intent: 'PHYSICAL_CONNECTIVITY', entities: { aAssetId: r.ids[0], bAssetId: r.ids[1] } };
  }

  if (DETAILS.test(q)) {
    const r = withPronoun(1);
    if (r.clarify) return clarifying(r.clarify, 'ASSET_DETAILS');
    if (r.ids.length === 1) return { intent: 'ASSET_DETAILS', entities: { assetId: r.ids[0] } };
  }

  // Any other question that says "it" while the conversation has several assets: ask which.
  if (usesPronoun && !named.length && context.length > 1 && /\b(fails?|shuts? down|supply|supplies|feeds?|offline|no power|connected|where|show)\b/i.test(q)) {
    return clarifying(context, 'UNKNOWN');
  }
  return null;
}

/** Source and target of a supply relationship, from how the question is phrased. */
export function direction(q, ids) {
  const [a, b] = ids;
  const pos = id => q.toLowerCase().indexOf(id.toLowerCase());
  const [first, second] = pos(a) <= pos(b) ? [a, b] : [b, a];
  // "B is powered / fed / supplied by A", "B downstream of A": the source is named second.
  if (new RegExp(`\\b(powered|fed|supplied|energi[sz]ed|served)\\s+(by|from)\\b`, 'i').test(q) || /\bdownstream of\b/i.test(q)) return { sourceAssetId: second, targetAssetId: first };
  return { sourceAssetId: first, targetAssetId: second };
}

/** Put the conversation's asset where the question said "it", so its order in the question is kept. */
function insertPronoun(q, named, id) {
  const at = q.search(PRONOUN);
  const before = named.filter(n => q.toLowerCase().indexOf(n.toLowerCase()) < at);
  return [...before, id, ...named.filter(n => !before.includes(n))];
}
