/**
 * Which carriageway of I-595 an FL511 event is on, read from FL511's own words.
 *
 * FL511 publishes no structured roadway, direction or facility field — only prose, in the marker's
 * title and detail description ("Incident Crash in Broward County on I-595 East, before Exit 1…").
 * Measured against the live feed, 83% of detail fragments state a direction, so prose is the
 * strongest evidence available and the only one that distinguishes the carriageways at all.
 *
 * It has to be prose rather than geometry because the carriageways are not separable by position:
 * from a point lying exactly on the eastbound line, the westbound line is a median of 40 m away and
 * as little as 17 m, against a 120 m segment tolerance. Choosing the nearest line would therefore
 * assign the wrong carriageway routinely, and a confident wrong answer is worse than no answer.
 *
 * So: classify from words, then let geometry resolve a section WITHIN the classified carriageway.
 * Anything this module is not sure of is UNKNOWN, which downstream keeps on the map and out of the
 * operational score.
 */

/** @typedef {'EB_GENERAL'|'WB_GENERAL'|'EXPRESS'|'UNKNOWN'} Carriageway */
export const CARRIAGEWAYS = Object.freeze({
  EB_GENERAL: 'EB_GENERAL', WB_GENERAL: 'WB_GENERAL', EXPRESS: 'EXPRESS', UNKNOWN: 'UNKNOWN',
});

export const CARRIAGEWAY_LABELS = Object.freeze({
  EB_GENERAL: 'Eastbound General Purpose',
  WB_GENERAL: 'Westbound General Purpose',
  EXPRESS: 'I-595 Express',
  UNKNOWN: 'Unresolved',
});

export const CONFIDENCE = Object.freeze({ HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' });

/**
 * How FL511 names the road an event is on: "… in Broward County on I-595 East, at Exit 1: …".
 *
 * The direction belongs to the road phrase BEFORE the comma. Everything after it is location, and
 * that is where other roads get named as landmarks — "on I-95 North, ramp to Exit 24: I-595" is an
 * I-95 event, and reading a free-floating "I-595" out of it would put an I-95 closure on our
 * corridor. So the subject is extracted, and only the subject is classified.
 */
const ON_ROAD = /\bon\s+([^,.;]{1,60}?)\s+(east|west|north|south)(?:bound)?\b/gi;
/** The terser form, with no "on": "I-595 EB at MM 4". */
const BARE = /\b(I-?\s?595|595)\b[^,.;]{0,24}?\b(east|west|eb|wb)(?:bound)?\b/i;

/**
 * Is this road phrase I-595, as the SUBJECT of the direction?
 *
 * The road name must be the last thing before the direction word. "I-595 East" and
 * "Reversible Lane - I595 West" qualify; "I-595 between the … eastbound" does not, because there
 * the direction describes a ramp between the carriageways rather than one of them.
 */
const FACILITY_SUFFIX = /(\s*[-–]?\s*(express(way)?|lanes?|managed|reversible|mainline|general\s+purpose|gp))*\s*$/i;
const isI595 = phrase => /\b(I-?\s?595|595)\s*$/i.test(String(phrase).trim().replace(FACILITY_SUFFIX, ''));

/**
 * Another named road. Checked against the ROAD PHRASE only, so that "75 Express", "95 Express" and
 * "Sawgrass Expressway" are recognised as other roads' express lanes rather than ours — all three
 * appear in the live feed and all three used to classify as I-595 Express.
 */
const OTHER_ROAD = /\b(I-?\s?(4|10|75|95|195|295|395)|SR-?\s?\d+|US-?\s?\d+|Turnpike|Tpk|Sawgrass|Palmetto|Dolphin|Airport Expressway)\b/i;

/**
 * The express facility, within a phrase already known to be I-595. FL511 calls it both
 * "595 Express" and "Reversible Lane - I595"; the corridor's own name, "Port Everglades
 * Expressway", is not a facility claim and is excluded.
 */
const EXPRESS = /\bexpress\b|\breversible\b|\bmanaged lanes?\b/i;
const EXPRESSWAY_NAME = /\bport everglades expressway\b/i;

const DIRECTION_OF = Object.freeze({ east: 'EB', eb: 'EB', west: 'WB', wb: 'WB' });

/** Everything FL511 might have written about one event, as one string. */
export function sourceText(event) {
  const parts = [event?.title, event?.description, event?.comment];
  for (const field of event?.detailFields ?? []) parts.push(`${field?.label} ${field?.value}`);
  return parts.filter(Boolean).join(' · ');
}

/**
 * Classify one event's carriageway from its own words.
 *
 * @param {object} event  a normalized live event, after its detail fragment has been attached
 * @returns {{carriageway: Carriageway, direction: 'EB'|'WB'|null, confidence: string,
 *            method: string, evidence: string|null}}
 */
export function classifyCarriageway(event) {
  const text = sourceText(event);
  const unknown = (method, evidence = null) =>
    ({ carriageway: CARRIAGEWAYS.UNKNOWN, direction: null, confidence: CONFIDENCE.LOW, method, evidence });

  if (!text.trim()) return unknown('no-source-text');

  // 1. The road the direction is attached to. There may be several "on …" phrases; ours is the one
  //    naming I-595, and another road's phrase is skipped rather than allowed to speak for us.
  const subjects = [...text.matchAll(ON_ROAD)].map(match => ({ phrase: match[1], word: match[2].toLowerCase() }));
  const ours = subjects.find(subject => isI595(subject.phrase) && !OTHER_ROAD.test(subject.phrase));
  if (ours) return classifyPhrase(ours.phrase, DIRECTION_OF[ours.word] ?? null, text, 'on-road-phrase');

  // A road phrase was found and none of them was ours. Either the event belongs to another road and
  // merely names I-595 as a landmark, or I-595 is named but not as the subject of the direction —
  // a ramp *between* the carriageways, say. Both are unresolved, but for different reasons.
  if (subjects.length) {
    return unknown(subjects.some(subject => /\b(I-?\s?595|595)\b/i.test(subject.phrase))
      ? 'i595-not-the-subject' : 'names-another-road', excerpt(text));
  }

  // 2. No "on <road> <direction>" phrasing. Fall back to the terse form, but only when no other
  //    road is named anywhere, so a landmark cannot be mistaken for the subject.
  if (OTHER_ROAD.test(text)) return unknown('names-another-road', excerpt(text));
  const bare = BARE.exec(text);
  if (bare) return classifyPhrase(text, DIRECTION_OF[bare[2].toLowerCase()] ?? null, text, 'bare-i595-direction');

  // 3. Express with no direction at all — legitimate, since the facility is reversible.
  if (isI595(text) && EXPRESS.test(text) && !onlyExpresswayName(text)) {
    return { carriageway: CARRIAGEWAYS.EXPRESS, direction: null, confidence: CONFIDENCE.HIGH,
      method: 'explicit-express', evidence: excerpt(text) };
  }
  return unknown(isI595(text) ? 'no-direction-stated' : 'no-i595-evidence', excerpt(text));
}

/**
 * Decide carriageway from the road phrase that owns the direction.
 * Express outranks the direction it states: the managed lanes are a separate facility whose
 * direction is operational, not fixed.
 */
function classifyPhrase(phrase, direction, text, method) {
  if (EXPRESS.test(phrase) && !onlyExpresswayName(phrase)) {
    return { carriageway: CARRIAGEWAYS.EXPRESS, direction, confidence: CONFIDENCE.HIGH,
      method: `${method}+express`, evidence: excerpt(text) };
  }
  if (!direction) return { carriageway: CARRIAGEWAYS.UNKNOWN, direction: null, confidence: CONFIDENCE.LOW,
    method: 'no-direction-stated', evidence: excerpt(text) };
  return {
    carriageway: direction === 'WB' ? CARRIAGEWAYS.WB_GENERAL : CARRIAGEWAYS.EB_GENERAL,
    direction,
    // The direction is explicit. That these are the general-purpose lanes rather than the express
    // ones is inferred from Express not being named — FL511's own convention, but the weaker half.
    confidence: CONFIDENCE.HIGH,
    method,
    evidence: excerpt(text),
  };
}

/** "Port Everglades Expressway" is I-595's name, not the express facility. */
function onlyExpresswayName(text) {
  if (!EXPRESSWAY_NAME.test(text)) return false;
  return !EXPRESS.test(text.replace(EXPRESSWAY_NAME, ' '));
}

/** A short, quotable piece of what was read — for diagnostics, never a token or a URL. */
function excerpt(text, limit = 140) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}
