/**
 * Deterministic intent recognition.
 *
 * No model is required to answer a supported question. A small ordered rule set reads the question
 * and returns an intent plus its slots; anything it does not recognise comes back as UNSUPPORTED,
 * which the orchestrator answers by saying so. It never guesses an intent to have something to say.
 *
 * Two things the rules deliberately do NOT do:
 *
 *   They do not resolve "this", "it" or "here". A pronoun is recorded as a REFERENT slot and left
 *   for the session to resolve against the current selection or the last subject — so a question
 *   about "this terminal" with nothing selected asks the operator to pick one rather than guessing.
 *
 *   They do not infer a subject from a bare noun. "Show cameras" is a port-wide question; it is
 *   not quietly turned into "cameras near the thing you last mentioned".
 */
import { MAX_RADIUS_M, SEARCH_RADIUS_M } from '../config/askTwin.js';

export const INTENT = Object.freeze({
  FIND_ASSET: 'FIND_ASSET',
  ASSET_SUMMARY: 'ASSET_SUMMARY',
  NEARBY_ROADS: 'NEARBY_ROADS',
  NEARBY_BUILDINGS: 'NEARBY_BUILDINGS',
  NEARBY_CAMERAS: 'NEARBY_CAMERAS',
  CLOSURES: 'CLOSURES',
  INCIDENTS: 'INCIDENTS',
  CONGESTION: 'CONGESTION',
  CONSTRUCTION: 'CONSTRUCTION',
  NEARBY_ASSETS: 'NEARBY_ASSETS',
  SCENARIO_RESULT: 'SCENARIO_RESULT',
  SCENARIO_COMPARE: 'SCENARIO_COMPARE',
  SCENARIO_ASSUMPTIONS: 'SCENARIO_ASSUMPTIONS',
  SHOW_LAST: 'SHOW_LAST',
  SELECTION: 'SELECTION',
  UNSUPPORTED: 'UNSUPPORTED',
});

/** A pronoun with no antecedent in the sentence: resolve it from context, never from a guess. */
const REFERENT = /\b(this|that|it|here|the selected|currently selected|the current)\b/i;

/**
 * Where a question stops describing WHAT is wanted and starts describing WHERE.
 *
 * "parking garages near Terminal B" is two different nouns doing two different jobs: the category
 * being asked for is on the left of "near", and the place to measure from is on the right. Reading
 * the category from the whole sentence would make that question about cruise terminals.
 */
const ANCHOR_SPLIT = /\b(?:near(?:by|est)?(?:\s+to)?|around|close\s+to|next\s+to|beside|within|serving|for)\b/i;

const splitAtAnchor = question => {
  const match = ANCHOR_SPLIT.exec(question);
  return match
    ? { subject: question.slice(0, match.index), anchor: question.slice(match.index + match[0].length) }
    : { subject: question, anchor: null };
};

const CATEGORY_WORDS = Object.freeze([
  { pattern: /\b(cruise\s+)?terminals?\b/i, category: 'CRUISE_TERMINAL' },
  { pattern: /\b(parking\s+)?(garages?|car\s*parks?|surface\s+lots?)\b/i, category: 'PARKING' },
  { pattern: /\bcargo\s+terminals?\b/i, category: 'CARGO_TERMINAL' },
  { pattern: /\btransport(ation)?\b/i, category: 'TRANSPORTATION' },
]);

/** "within 200 metres", "within 1 km", "in a 500m radius". Clamped; a radius is a search setting. */
export function readRadius(question, fallback) {
  const match = /\b(?:within|inside|in a|radius of)\s+(\d{1,5})\s*(m|metres|meters|km|kilometres|kilometers)\b/i.exec(question)
    ?? /\b(\d{1,5})\s*(m|metres|meters|km|kilometres|kilometers)\s+(?:radius|of|from|around)\b/i.exec(question);
  if (!match) return { radiusM: fallback, explicit: false };
  const unit = match[2].toLowerCase();
  const raw = Number(match[1]) * (unit.startsWith('k') ? 1000 : 1);
  return { radiusM: Math.min(Math.max(raw, 1), MAX_RADIUS_M), explicit: true, clamped: raw > MAX_RADIUS_M };
}

/**
 * The name being asked about, when the question names one.
 *
 * Only the phrasings the registry can actually resolve: "Terminal A", "Garage B", "Surface Lot C",
 * and anything after show/find/locate/where is. A bare "show me the port" yields no name, and the
 * orchestrator then says it could not resolve a subject instead of searching for "the port".
 */
/** Words that mean the phrase is the question's own topic, not the name of a record. */
const NOT_A_NAME = /\b(event|events|closure|closures|camera|cameras|construction|roadwork|congestion|incident|incidents|building|buildings|road|roads|traffic|port|portmiami|map|them|those|these|it)\b/i;

export function readName(question) {
  const direct = /\b((?:cruise\s+)?terminal|(?:parking\s+)?garage|surface\s+lot)\s+([a-z]{1,2}|\d{1,2})\b/i.exec(question);
  if (direct) {
    const kind = /garage/i.test(direct[1]) ? 'Garage'
      : /surface/i.test(direct[1]) ? 'Surface Lot' : 'Terminal';
    return `${kind} ${direct[2].toUpperCase()}`;
  }
  const phrase = /\b(?:show|find|locate|open|where\s+is|where's)\s+(?:me\s+)?(?:the\s+)?([a-z0-9][a-z0-9 .'-]{2,40}?)\s*[?.!]?$/i.exec(question);
  if (phrase && !REFERENT.test(phrase[1]) && !NOT_A_NAME.test(phrase[1])) return phrase[1].trim();
  return null;
}

const categoryIn = question =>
  CATEGORY_WORDS.find(entry => entry.pattern.test(question))?.category ?? null;

/**
 * Route one question.
 * @returns {{intent: string, slots: object}}
 */
export function routeIntent(question) {
  const q = String(question ?? '').trim();
  if (!q) return { intent: INTENT.UNSUPPORTED, slots: {} };

  const { subject, anchor } = splitAtAnchor(q);
  const referent = REFERENT.test(anchor ?? q);
  // The anchor names the place; the subject names the kind being asked for.
  const name = (anchor ? readName(anchor) : null) ?? readName(q);
  const category = categoryIn(subject) ?? (anchor ? null : categoryIn(q));
  const slots = { referent, name, category, anchorText: anchor?.trim() || null, raw: q };

  // --- follow-up: act on what the last answer returned ----------------------------------------
  // "Show them on the map" carries no subject of its own; it is a request to act on the previous
  // result, and the session supplies that. It is NOT turned into a search for "them".
  if (/^(?:now\s+)?(?:show|highlight|display|map|plot)\s+(?:me\s+)?(?:them|those|these|it|that)\b/i.test(q)
    || /\b(?:show|highlight|put)\s+(?:them|those|these|it)\s+on\s+the\s+map\b/i.test(q)) {
    return { intent: INTENT.SHOW_LAST, slots };
  }

  // --- the scenario planner ---------------------------------------------------------------------
  // Checked first: "compare Scenario A and Scenario B" is a scenario question, not a request for
  // nearby assets called A and B, and "which scenario serves the most demand" is not a road query.
  const scenarioNamed = /\bscenario\s+([a-z])\b/i.exec(q);
  if (/\bproposed garage\b/i.test(q)) {
    return { intent: INTENT.SCENARIO_RESULT, slots: { ...slots, scenario: scenarioNamed?.[1]?.toUpperCase() ?? null } };
  }
  if (/\bscenario|simulation|simulated\b/i.test(q) || scenarioNamed) {
    const scenarioSlots = { ...slots, scenario: scenarioNamed ? scenarioNamed[1].toUpperCase() : null };
    if (/\bassumption|assumed|inputs?\b/i.test(q)) {
      return { intent: INTENT.SCENARIO_ASSUMPTIONS, slots: scenarioSlots };
    }
    if (/\bcompare|versus|vs\b|which (scenario|one|option)|rank|recommend|why is|best\b/i.test(q)) {
      return { intent: INTENT.SCENARIO_COMPARE, slots: scenarioSlots };
    }
    return { intent: INTENT.SCENARIO_RESULT, slots: scenarioSlots };
  }
  if (/\b(v\/c|volume.to.capacity)\b/i.test(q)) {
    return { intent: INTENT.SCENARIO_COMPARE, slots: { ...slots, scenario: null } };
  }

  // --- what is selected -----------------------------------------------------------------------
  if (/\bwhat\b.*\b(selected|currently selected)\b/i.test(q)
    || /\b(selected|selection)\b.*\b(details?|what|which|tell me)\b/i.test(q)
    || /^what is this\b/i.test(q)) {
    return { intent: INTENT.SELECTION, slots };
  }

  // --- live traffic ---------------------------------------------------------------------------
  // Checked before the spatial intents: "closures near Terminal A" is a closures question with a
  // place in it, not a "near Terminal A" question about closures.
  const radiusFor = key => readRadius(q, SEARCH_RADIUS_M[key]);
  if (/\bclosure|closed road|road closed|lane closure/i.test(q)) {
    return { intent: INTENT.CLOSURES, slots: { ...slots, ...radiusFor('events') } };
  }
  if (/\bconstruction|roadwork|road work|works?\b/i.test(q)) {
    return { intent: INTENT.CONSTRUCTION, slots: { ...slots, ...radiusFor('events') } };
  }
  if (/\bcongest|traffic jam|backed up|slow(down)?\b/i.test(q)) {
    return { intent: INTENT.CONGESTION, slots: { ...slots, ...radiusFor('events') } };
  }
  if (/\bincident|crash|accident|disabled vehicle|traffic events?\b/i.test(q)) {
    return { intent: INTENT.INCIDENTS, slots: { ...slots, ...radiusFor('events') } };
  }

  // --- spatial --------------------------------------------------------------------------------
  if (/\bcameras?\b/i.test(q)) {
    return { intent: INTENT.NEARBY_CAMERAS, slots: { ...slots, ...radiusFor('cameras') } };
  }
  if (/\bbuildings?|footprints?\b/i.test(q)) {
    return { intent: INTENT.NEARBY_BUILDINGS, slots: { ...slots, ...radiusFor('buildings') } };
  }
  if (/\broads?|streets?|access\b/i.test(q)) {
    return { intent: INTENT.NEARBY_ROADS, slots: { ...slots, ...radiusFor('roads') } };
  }

  // Assets of one kind near a place: "parking garages near Terminal B". Placed after the three
  // spatial intents above so "cameras near Terminal A" stays a camera question.
  if (slots.category && (anchor || referent)) {
    return { intent: INTENT.NEARBY_ASSETS, slots: { ...slots, ...readRadius(q, SEARCH_RADIUS_M.events) } };
  }

  // --- registry -------------------------------------------------------------------------------
  // A count or a list is a summary; a named subject is a find. "How many garages" must not be
  // routed to FIND_ASSET just because "garage" appears in it.
  if (/\bhow many\b|\bcount\b|\blist (all|every|the)\b|\ball (the )?(terminals?|garages?|assets?)\b/i.test(q)
    || /\bwithout (linked |confirmed )?(buildings?|footprints?|location)\b/i.test(q)) {
    return { intent: INTENT.ASSET_SUMMARY, slots };
  }
  if (name || /\b(show|find|locate|where)\b/i.test(q)) {
    return { intent: INTENT.FIND_ASSET, slots };
  }

  return { intent: INTENT.UNSUPPORTED, slots };
}

/** Which intents need a subject (a named asset, a selection or a remembered one). */
export const NEEDS_SUBJECT = Object.freeze(new Set([
  INTENT.NEARBY_ROADS, INTENT.NEARBY_BUILDINGS, INTENT.NEARBY_CAMERAS, INTENT.NEARBY_ASSETS,
  INTENT.FIND_ASSET,
]));
