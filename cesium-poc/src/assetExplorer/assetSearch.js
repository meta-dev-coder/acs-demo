/**
 * "Fly to <asset>" for Ask the Twin: recognise the request and find the asset it names.
 *
 * Resolved here, against the assets the app has actually loaded, rather than by the remote Ask
 * the Twin service: that service knows the live FL511 feed and general corridor facts, not the
 * 2,895 lighting IDs, the bridge numbers or the camera IDs on this map. Pure on purpose — no
 * Cesium, no DOM — so the matching rules are unit-tested directly.
 */

/** "fly to …", "highlight …", "where is …" — the phrases that mean "move the map to a thing". */
const FLY_INTENT = /^\s*(?:(?:please|pls|can you|could you|would you|i want to|i'd like to|i would like to|let me|let's|help me)\s+)*(?:fly|go|take me|zoom|navigate|jump|show(?:\s+me)?|highlight|display|isolate|select|view|find|locate|focus|where is|where's)\b\s*(?:(?:(?:in\s+)?to|into|onto|on|at)\b)?\s*(?:the\s+)?(.+?)\s*[?.!]*\s*$/i;

/**
 * Words that name an asset type. Checked in order, so "traffic light" is a signal before "light"
 * can claim it for lighting.
 */
const TYPE_WORDS = [
  [/\btraffic\s+(?:lights?|signals?)\b/, ['signal']],
  [/\bsignals?\b/, ['signal']],
  [/\b(?:cctv|cameras?|cams?)\b/, ['camera']],
  [/\bbridges?\b/, ['bridge']],
  [/\b(?:lighting|lights?|light\s*poles?|poles?|luminaires?)\b/, ['lighting']],
  [/\b(?:toll\s+)?gantr(?:y|ies)\b/, ['gantry']],
  [/\b(?:lane\s+)?barriers?\b/, ['laneBarrier']],
  [/\b(?:message\s+signs?|dms|vms)\b/, ['messageSign']],
  // Forgiving: "clousers", "closers", "incidnets" are what people actually type.
  [/\binc[a-z]{0,2}d[a-z]{0,2}n?ts?\b/, ['incident']],
  [/\bclou?s(?:u?re|er|or)s?\b/, ['closure']],
  [/\boverlane\b/, ['overlane']],
  [/\bcantilever\b/, ['cantilever']],
  [/\b(?:sign\s+)?structures?\b/, ['overlane', 'cantilever', 'unclassified']],
];

const STOPWORDS = new Set(['the', 'a', 'an', 'asset', 'id', 'number', 'no', 'called', 'named', 'with', 'of', 'at', 'near', 'on', 'in', 'to', 'please', 'map']);

/** Case, spacing and punctuation never decide a match: "A 1 3-Z4" and "a13z4" are one ID. */
export const squash = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Numbers compare by value, so "gantry 37" finds I595_GANTRY_037 and "MP 8.50" finds MP 8.5. */
const canonToken = token => (/^\d+(?:\.\d+)?$/.test(token) ? String(Number(token)) : token.replace(/\./g, ''));
/** A decimal stays one token: "MP 8.5" must not match "MP 5.5" on its 5 and some other 8. */
const tokensOf = value => (String(value ?? '').toLowerCase().match(/\d+\.\d+|[a-z0-9]+/g) ?? []).map(canonToken);

/**
 * @returns {{target: string, types: string[]} | null} what the user asked to fly to, and any asset
 *   types their wording names; null when the question is not a fly-to request.
 */
export function parseFlyRequest(question) {
  const match = FLY_INTENT.exec(String(question ?? ''));
  if (!match) return null;
  return { target: match[1], types: typeHints(match[1]) };
}

export function typeHints(text) {
  const lower = String(text ?? '').toLowerCase();
  for (const [pattern, types] of TYPE_WORDS) if (pattern.test(lower)) return types;
  return [];
}

/** The target minus the words that only named a type. */
function stripTypeWords(text) {
  let rest = String(text ?? '').toLowerCase();
  for (const [pattern] of TYPE_WORDS) rest = rest.replace(new RegExp(pattern.source, 'g'), ' ');
  return rest;
}

/**
 * One searchable entry per asset. `fields` are the record's own short text values — its
 * description, location, codes — so "the camera at MP 8.5" can match without a schema per type.
 *
 * @param {object} asset  a normalized asset
 * @param {{label?: string, subtitle?: string|null}} [context]
 */
export function searchEntry(asset, { label = '', subtitle = null } = {}) {
  const fields = [asset.name, subtitle, ...shortStrings(asset.source), ...shortStrings(asset.source?.record)]
    .filter(value => value != null && String(value).trim() !== '');
  return {
    asset,
    id: squash(asset.id),
    idTokens: tokensOf(asset.id),
    name: squash(asset.name),
    tokens: new Set(fields.flatMap(tokensOf).concat(tokensOf(asset.id), tokensOf(label))),
    text: fields.map(value => String(value).toLowerCase()).join(' '),
  };
}

function shortStrings(object) {
  if (!object || typeof object !== 'object') return [];
  return Object.values(object).filter(value => (typeof value === 'string' || typeof value === 'number')
    && String(value).length <= 80).map(String);
}

/**
 * Rank the entries against what the user asked for.
 *
 * An exact ID beats an exact name, which beats every query word appearing in the record. A word
 * that is only part of a longer word counts for half. Every word must be found somewhere, or the
 * asset is not a match at all — "fly to bridge 860384" must never land on bridge 860391.
 *
 * @returns {{asset: object, score: number, why: string}[]} best first
 */
export function searchAssets(entries, target, types = typeHints(target)) {
  const wanted = stripTypeWords(target);
  const whole = squash(wanted);
  const words = tokensOf(wanted).filter(word => !STOPWORDS.has(word));
  const inType = types.length ? entries.filter(entry => types.includes(entry.asset.assetType)) : entries;
  // A type word the corridor has no asset for is ignored rather than returning nothing.
  const pool = inType.length ? inType : entries;
  if (!whole) return [];

  const results = [];
  for (const entry of pool) {
    if (entry.id === whole) { results.push({ asset: entry.asset, score: 100, why: 'id' }); continue; }
    if (entry.name === whole) { results.push({ asset: entry.asset, score: 90, why: 'name' }); continue; }
    if (!words.length) continue;
    let found = 0, idHits = 0;
    for (const word of words) {
      if (entry.tokens.has(word)) { found += 1; if (entry.idTokens.includes(word)) idHits += 1; }
      else if (word.length >= 3 && entry.text.includes(word)) found += 0.5;
      else { found = -1; break; }
    }
    if (found <= 0) continue;
    // Words that are the asset's own ID outrank the same words found in a description.
    const score = Math.round(40 + 40 * (found / words.length) + (idHits ? 10 : 0));
    results.push({ asset: entry.asset, score, why: idHits ? 'id-part' : 'text' });
  }
  return results.sort((a, b) => b.score - a.score || a.asset.id.localeCompare(b.asset.id));
}

/**
 * What to do with a ranking: fly when one asset clearly wins, ask when several tie.
 *
 * @returns {{kind: 'fly', asset: object} | {kind: 'choose', assets: object[]} | {kind: 'none'}}
 */
export function resolveFlyTarget(results, { maxChoices = 6 } = {}) {
  if (!results.length) return { kind: 'none' };
  const best = results[0].score;
  const tied = results.filter(result => result.score === best);
  if (tied.length === 1) return { kind: 'fly', asset: tied[0].asset };
  return { kind: 'choose', assets: tied.slice(0, maxChoices).map(result => result.asset), total: tied.length };
}

const NUMBER_WORDS = Object.freeze({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8 });

/**
 * "segment 1", "section one", "where segment 3 ends", "westbound segment 2 start".
 *
 * Segments are the corridor's FDOT sections — the numbering the segment details panel shows
 * ("FDOT Section 1 of 8"). `part` is which end the user asked for; `direction` only when they said.
 *
 * @returns {{index: number, part: 'start'|'end'|'whole', direction: 'EB'|'WB'|null} | null}
 */
export function parseSegmentRequest(text) {
  const lower = String(text ?? '').toLowerCase();
  const match = /\b(?:fdot\s+)?(?:segment|section|seg)\s*(?:#|no\.?|number)?\s*(\d+|[a-z]+)\b/.exec(lower)
    ?? /\b(first|second|third|fourth|fifth|sixth|seventh|eighth)\s+(?:fdot\s+)?(?:segment|section)\b/.exec(lower);
  if (!match) return null;
  const index = /^\d+$/.test(match[1]) ? Number(match[1]) : NUMBER_WORDS[match[1]];
  if (!Number.isInteger(index)) return null;
  const part = /\b(?:end|ends|ending|finish|finishes|stop|stops)\b/.test(lower) ? 'end'
    : /\b(?:start|starts|begin|begins|beginning|origin)\b/.test(lower) ? 'start' : 'whole';
  const direction = /\b(?:west\s*bound|wb|westward)\b/.test(lower) ? 'WB'
    : /\b(?:east\s*bound|eb|eastward)\b/.test(lower) ? 'EB' : null;
  return { index, part, direction };
}

/**
 * Which point of a segment's geometry the user meant. FDOT geometry runs in milepost order (west
 * to east) in both directions, so "where it ends" is the east end eastbound and the west end
 * westbound.
 */
export function segmentPoint(positions, part, direction) {
  if (!positions?.length) return null;
  if (part === 'whole') return null;
  const eastEnd = positions[positions.length - 1], westEnd = positions[0];
  const travelEnd = direction === 'WB' ? westEnd : eastEnd, travelStart = direction === 'WB' ? eastEnd : westEnd;
  return part === 'end' ? travelEnd : travelStart;
}

/** Remote suggestions farther than this from the I-595 centerline are not flown to. */
export const MAX_REMOTE_OFFSET_M = 1500;

/**
 * A short follow-up to the last segment request: "westbound", "WB", "the other direction",
 * "where does it end?", "the start". Returns the request it amends, or null when the text is a new
 * question. Only a message made of these words counts, so "westbound incidents?" is still a question.
 *
 * @param {string} text
 * @param {{index: number, part: string, direction: 'EB'|'WB'|null} | null} last  the previous request
 */
export function parseSegmentFollowUp(text, last) {
  if (!last) return null;
  const lower = String(text ?? '').toLowerCase().replace(/[?.!,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!lower || lower.split(' ').length > 6) return null;
  const direction = /\b(?:west\s*bound|wb|west|westward)\b/.test(lower) ? 'WB'
    : /\b(?:east\s*bound|eb|east|eastward)\b/.test(lower) ? 'EB'
      : /\b(?:other|opposite)\s+(?:direction|carriageway|side|way)\b/.test(lower) ? ((last.direction ?? 'EB') === 'EB' ? 'WB' : 'EB') : null;
  const part = /\b(?:end|ends|ending|finish|finishes)\b/.test(lower) ? 'end'
    : /\b(?:start|starts|begin|begins|beginning)\b/.test(lower) ? 'start'
      : /\b(?:whole|entire|all of it|full)\b/.test(lower) ? 'whole' : null;
  if (!direction && !part) return null;
  // Anything left besides these words and filler means it is a different question.
  const filler = /\b(?:west\s*bound|east\s*bound|wb|eb|west|east|westward|eastward|other|opposite|direction|carriageway|side|way|end|ends|ending|finish|finishes|start|starts|begin|begins|beginning|whole|entire|all|of|it|full|the|what|about|and|now|please|show|me|where|does|do|is|go|to|fly|segment|section|that|this|one|instead|how|then|same)\b/g;
  if (lower.replace(filler, '').trim()) return null;
  return { index: last.index, part: part ?? last.part, direction: direction ?? last.direction };
}

/** Words that mean "only this, hide the rest". */
export const isolates = text => /\b(?:just|only|isolate|alone)\b/i.test(String(text ?? ''));

/**
 * "highlight westbound I-595", "show only eastbound", "show all of I-595", "both directions".
 * A request about a whole carriageway, not a numbered segment (those are parseSegmentRequest's).
 * `isolate` hides the other carriageway: asked to highlight one direction, showing it alone is what
 * makes it stand out.
 *
 * @returns {{direction: 'EB'|'WB'|null, isolate: boolean} | null}  direction null means both
 */
export function parseRoadRequest(question) {
  const request = parseFlyRequest(question);
  if (!request || parseSegmentRequests(request.target)) return null;
  const lower = String(question).toLowerCase();
  const road = /\b(?:i[\s-]?595|interstate\s*595|mainline|carriageways?|lanes?|road|highway|freeway|corridor|directions?)\b/.test(lower);
  const direction = /\b(?:west\s*bound|wb)\b/.test(lower) ? 'WB' : /\b(?:east\s*bound|eb)\b/.test(lower) ? 'EB' : null;
  const both = /\b(?:both|all)\b/.test(lower);
  // A direction on its own ("highlight westbound") is enough; otherwise it must be about the road.
  const rest = request.target.toLowerCase().replace(/\b(?:just|only|the|all|of|both|directions?|west\s*bound|east\s*bound|wb|eb|i[\s-]?595|interstate|595|mainline|carriageways?|lanes?|road|highway|freeway|corridor|again|back|please)\b/g, '').trim();
  if (rest) return null;                       // something else is named — not a road request
  if (!direction && !(road || both)) return null;
  return { direction: both ? null : direction, isolate: Boolean(direction) && (isolates(lower) || /\bhighlight\b/.test(lower)) };
}

const SEGMENT_WORDS = new Set(['segment', 'segments', 'section', 'sections', 'seg', 'segs']);
const LIST_GLUE = new Set(['and', 'or', 'plus', 'also', 'the', 'then', 'with', 'no', 'number', 'numbers', 'fdot', 'of']);
const RANGE_WORDS = new Set(['to', 'through', 'thru', 'till', 'until']);
/** Direction words, forgiving a slip of the keyboard: "easbound", "westboud", "eastbnd". */
const directionWord = token => (/^(?:w[a-z]{0,4}bo?u?n?d|wb|westward)$/.test(token) ? 'WB'
  : /^(?:e[a-z]{0,4}bo?u?n?d|eb|eastward)$/.test(token) ? 'EB' : null);
const numberOf = token => (/^\d+$/.test(token) ? Number(token) : NUMBER_WORDS[token] ?? null);

/**
 * Every segment a request names, each with its own direction:
 *   "eastbound segment 3"                          → EB 3
 *   "eastbound segment 2 and westbound segment 7"  → EB 2, WB 7
 *   "segment 2 eastbound and segment 7 westbound"  → EB 2, WB 7
 *   "westbound segments 2, 3 and 5" / "2 to 4"      → WB 2, 3, 5 / WB 2, 3, 4
 *   "segment 3 both directions"                    → EB 3, WB 3
 * A direction written before "segment" carries on to the next ones; one written straight after a
 * number belongs to that number. A segment with no direction anywhere has direction null.
 *
 * @returns {{segments: {index: number, direction: 'EB'|'WB'|null}[], part: 'start'|'end'|'whole'} | null}
 */
export function parseSegmentRequests(text) {
  const lower = String(text ?? '').toLowerCase().replace(/\b(west|east)\s+bound\b/g, '$1bound');
  const tokens = lower.match(/\d+|[a-z]+/g) ?? [];
  const found = [];
  // `from` records where a segment's direction came from: carried from a word before "segment",
  // or written straight after its number. Only the latter is final.
  let inList = false, carried = null, lastNumberAt = -2;
  const push = index => found.push({ index, direction: carried, from: carried ? 'carried' : null });
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const direction = directionWord(token);
    if (direction) {
      const last = found[found.length - 1];
      // "segment 2 eastbound": a direction right after a number is that number's alone.
      if (last && lastNumberAt === i - 1 && last.from !== 'after') { last.direction = direction; last.from = 'after'; continue; }
      carried = direction;
      continue;
    }
    if (SEGMENT_WORDS.has(token)) { inList = true; continue; }
    // "the third segment": an ordinal straight before the segment word.
    if (NUMBER_WORDS[token] && SEGMENT_WORDS.has(tokens[i + 1])) {
      push(NUMBER_WORDS[token]);
      i += 1; lastNumberAt = i; inList = true; continue;
    }
    const n = inList ? numberOf(token) : null;
    if (n != null) {
      const previous = found[found.length - 1];
      // "segments 2 to 4": fill the range in.
      if (previous && RANGE_WORDS.has(tokens[i - 1]) && n > previous.index && n - previous.index <= 16) {
        for (let k = previous.index + 1; k <= n; k++) found.push({ index: k, direction: previous.direction, from: previous.from });
      } else {
        push(n);
      }
      lastNumberAt = i;
      continue;
    }
    if (inList && !LIST_GLUE.has(token) && !RANGE_WORDS.has(token)) inList = false;
  }
  if (!found.length) return null;
  // A segment named before any direction takes the first direction written after it.
  for (const item of found) if (!item.direction) item.direction = found.find(other => other.direction)?.direction ?? null;
  let segments = found.map(({ index, direction }) => ({ index, direction }));
  if (/\bboth\s+(?:directions|ways|carriageways|sides)\b/.test(lower)) {
    segments = segments.flatMap(item => (item.direction ? [item] : [{ index: item.index, direction: 'EB' }, { index: item.index, direction: 'WB' }]));
  }
  // The same segment named twice is shown once.
  const seen = new Set();
  segments = segments.filter(item => { const key = `${item.index}:${item.direction}`; if (seen.has(key)) return false; seen.add(key); return true; });
  const part = segments.length > 1 ? 'whole'
    : /\b(?:end|ends|ending|finish|finishes|stop|stops)\b/.test(lower) ? 'end'
      : /\b(?:start|starts|begin|begins|beginning|origin)\b/.test(lower) ? 'start' : 'whole';
  return { segments, part };
}

/**
 * "eastbound segment 2 and westbound segment 7" with no verb in front: a message made only of
 * segment words is a request to show them. One that also asks something ("what is the AADT of
 * segment 3?") is a question for the remote service.
 */
export function isBareSegmentRequest(text) {
  const lower = String(text ?? '').toLowerCase().replace(/\b(west|east)\s+bound\b/g, '$1bound');
  if (!parseSegmentRequests(lower)) return false;
  const rest = (lower.match(/\d+|[a-z]+/g) ?? []).filter(token => !(
    SEGMENT_WORDS.has(token) || LIST_GLUE.has(token) || RANGE_WORDS.has(token) || directionWord(token) || numberOf(token) != null
    || /^(?:just|only|both|directions|ways|i|595|interstate|on|map|please|show|highlight|display|now|end|ends|start|begins?)$/.test(token)));
  return rest.length === 0;
}

/**
 * "fly to the closures", "show incidents", "take me to the cameras": a whole asset type, with
 * nothing more specific named. Returns the type, or null.
 */
export function parseTypeBrowse(question) {
  const request = parseFlyRequest(question) ?? (/^\s*(?:the\s+|all\s+(?:the\s+)?)?[a-z\s]+\??\s*$/i.test(String(question ?? '')) ? { target: String(question) } : null);
  if (!request) return null;
  const types = typeHints(request.target);
  if (types.length !== 1) return null;
  const rest = stripTypeWords(request.target).replace(/\b(?:all|the|of|on|map|every|each|current|active|now|right|please|them|those|these|me|i-?595|595)\b/g, '').replace(/[^a-z0-9]/g, '');
  return rest ? null : types[0];
}

/**
 * Stepping through a list the twin has shown: "next", "yes", "the previous one", "show all",
 * "number 2". Only a short message made of these words counts.
 *
 * @returns {{command: 'next'|'previous'|'all'|'goto', index?: number} | null}
 */
export function parseTourCommand(text) {
  const lower = String(text ?? '').toLowerCase().replace(/[?.!,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!lower || lower.split(' ').length > 6) return null;
  const numbered = /^(?:go to |take me to |show |fly to )?(?:the )?(?:number |no |#)?(\d+|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last)(?: one)?$/.exec(lower);
  if (numbered) {
    const word = numbered[1];
    return { command: 'goto', index: word === 'last' ? -1 : /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word] };
  }
  if (/^(?:yes|yeah|yep|sure|ok|okay|y|go|go on|continue|next|next one|the next one|go next|go to next|go to the next one|show next|show the next one|yes please|yes next|and the next)$/.test(lower)) return { command: 'next' };
  if (/^(?:previous|prev|the previous one|previous one|go back one|last one before|before that)$/.test(lower)) return { command: 'previous' };
  // "next closure please", "show the next incident", "ok the previous one".
  if (/^(?:(?:yes|ok|okay|sure)\s+)?(?:(?:go to|show|fly to|take me to)\s+)?(?:the\s+)?next\b/.test(lower)) return { command: 'next' };
  if (/^(?:(?:ok|okay)\s+)?(?:(?:go to|show|fly to|take me to)\s+)?(?:the\s+)?(?:previous|prev)\b/.test(lower)) return { command: 'previous' };
  if (/^(?:show all|show them all|all of them|overview|see all|show all of them)$/.test(lower)) return { command: 'all' };
  return null;
}

/**
 * A short place for a live event whose own name is generic ("Closure"): FL511's description reads
 * "Planned construction in Broward County on I-95 South, ramp to Exit 25: SR-84 …. Off-ramp closed.
 * Last updated at 11:03 PM." — the where and the what are its first two sentences.
 */
export function eventPlace(description) {
  const text = String(description ?? '').trim();
  if (!text) return null;
  const sentences = text.split(/\.\s+/).map(sentence => sentence.replace(/\.$/, '').trim()).filter(Boolean);
  const where = (/\bon\s+(.+)$/.exec(sentences[0] ?? '')?.[1] ?? sentences[0]);
  const what = sentences.slice(1).find(sentence => !/^last updated/i.test(sentence));
  return [where, what].filter(Boolean).join(' · ');
}
