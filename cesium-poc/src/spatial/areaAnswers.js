/**
 * Answering questions about the drawn area, from the resolved context alone.
 *
 * The spatial query has already decided what is in the box. This turns that into English. It is
 * deliberately not a language model's job: "are there any incidents here" has one correct answer,
 * it is already computed, and a model asked to infer it from coordinates would sometimes be wrong
 * in a way that reads exactly like being right.
 *
 * Every sentence below is countable from the context. Where the answer is nothing, it says nothing
 * — "no incidents in this area" is a real answer, and substituting the corridor's other incidents
 * for it would answer a question the operator did not ask.
 *
 * Pure: question and context in, text and offered actions out.
 */

import { CARRIAGEWAY_LABELS } from '../liveOps/carriagewayModel.js';
import { registerInstant } from '../tmc/registerIncidents.js';
import { isOpenRecord } from './spatialQuery.js';

/**
 * Wording that means "everywhere", which must win over the drawn area.
 *
 * An operator who has an area selected and then asks about the whole corridor means the whole
 * corridor. Silently scoping that to the box would be the single most misleading thing this feature
 * could do, so it is checked before anything else.
 */
const CORRIDOR_WIDE = /\b(entire|whole|all of|across the|corridor[- ]wide|anywhere)\b.*\b(corridor|i[- ]?595)\b|\b(corridor[- ]wide)\b/i;

/** The map-action vocabulary, as sources, so INTENTS and isMapInstruction cannot drift apart. */
const MAP_VERB_SRC = '\\b(show|display|highlight|plot|focus|zoom|fly|flies|locate|pin|mark|centre|center|take me|go to|jump to|navigate)\\b';
const MAP_WORD_SRC = '\\b(map|cesium|globe|3d view|on screen|on the view)\\b';

/** The area questions this answers, most specific first — "open work orders" before "work". */
const INTENTS = Object.freeze([
  { id: 'workOrders', match: /\bwork[- ]?orders?\b/i },
  { id: 'maintenance', match: /\b(maintenance|tickets?|tasks?|inspections?|repairs?)\b/i },
  // "Show them on the map" is an instruction, not a question, and must be recognised before the
  // matchers that would answer it in prose. It needs an explicit map word so that "show open work
  // orders" still means "list them".
  // Both orders, because "show it on the map" and "on the map, show it" are the same instruction.
  { id: 'showRecords', match: new RegExp(
    `(?:${MAP_VERB_SRC})[\\s\\S]*(?:${MAP_WORD_SRC})|(?:${MAP_WORD_SRC})[\\s\\S]*(?:${MAP_VERB_SRC})`, 'i') },
  // Weather first: "how are these incidents related in terms of weather" is a question about the
  // records' conditions, and the general incidents matcher would otherwise swallow it and return
  // the type-and-location breakdown instead.
  { id: 'incidentWeather', match: /\bweather|rain\w*|storm\w*|wet\b|fog\w*|overcast|humid|windy\b/i },
  // "historical", "past" and "before" route here too: a follow-up like "I am asking historical"
  // carries no incident word at all, and used to fall through to the remote model, which had no
  // idea what the previous question had been about.
  { id: 'incidents', match: /\bincidents?|crash(es)?|historical|histor(y|ic)|\bpast\b|previously|before\b/i },
  { id: 'closures', match: /\bclosures?|closed\b/i },
  { id: 'cameras', match: /\bcameras?\b|\bcctv\b/i },
  { id: 'signs', match: /\b(message signs?|dms|signs?)\b/i },
  { id: 'roadway', match: /\b(segments?|sections?|which road|what road|eastbound|westbound|express|carriageway|direction)\b/i },
  { id: 'assets', match: /\bassets?\b/i },
  { id: 'summary', match: /\b(happening|summary|overview|going on|tell me about|what.s here|status)\b/i },
]);

/** Words that mean "the area I drew". A question with none of them is not about the area. */
const AREA_WORDS = /\b(here|this area|the area|selected area|this region|this box|this rectangle|in here|this selection)\b/i;

/**
 * Which area question this is, if any.
 *
 * @param {string} question
 * @param {boolean} hasArea whether an area is currently selected
 * @returns {string|null} the intent id, or null to let the normal routing handle it
 */
export function parseAreaQuestion(question, hasArea) {
  if (!hasArea || !question) return null;
  const text = String(question);
  // §40: an explicit corridor-wide scope overrides the selection rather than being narrowed by it.
  if (CORRIDOR_WIDE.test(text)) return null;
  const aboutArea = AREA_WORDS.test(text);
  const intent = INTENTS.find(entry => entry.match.test(text));
  if (!intent) return aboutArea ? 'summary' : null;
  // "Are there incidents?" with an area up means in the area; the words do not have to be there,
  // but a question that names somewhere else entirely is left alone.
  return intent.id;
}

const count = (n, singular, plural = `${singular}s`) => `${n} ${n === 1 ? singular : plural}`;
/**
 * Join the parts that have something to say.
 *
 * `null` and `undefined` are "nothing to say" and vanish; an empty string is a deliberate blank
 * line and survives. Filtering on truthiness dropped both, which collapsed a grouped answer into
 * one unreadable block.
 */
const lines = parts => parts.filter(part => part !== null && part !== undefined).join('\n');

/** "I-595 Eastbound · Section 03", the way the rest of the app writes a place. */
function segmentLine(segment) {
  return `• ${CARRIAGEWAY_LABELS[segment.carriageway] ?? segment.carriageway}${segment.sectionId ? ` — ${segment.sectionLabel}` : ''}`;
}

/** What the area covers, in the words §24 asks for — never just "I-595". */
export function describeRoadway(context) {
  const { roadway } = context;
  if (!roadway.intersectsI595) {
    return 'The selected area does not intersect the modelled I-595 corridor.';
  }
  const sections = roadway.segments.map(segmentLine);
  const express = roadway.includesExpress
    ? '• I-595 Express — operational sections are not defined for Express, so no section is named'
    : null;
  return lines(['The selected area intersects:', ...sections, express]);
}

/**
 * Incidents, both kinds, because the map shows both and they are not the same thing.
 *
 * The context carries `liveEvents.incidents` (happening now, from FL511) and
 * `maintenance.incidents` (the historical crash register, which the Safety layer clusters into the
 * numbered hotspot badges). Answering only from the first produced "No incidents are inside the
 * selected area" while a red "23" sat inside the box — both true, both about different data, and
 * no way for an operator to tell.
 *
 * So the answer always states the live position, and whenever historical records are present it
 * says so too, in their own words: records, not live incidents.
 */
export function describeIncidents(context) {
  const live = context.liveEvents.incidents ?? [];
  const historical = context.maintenance?.incidents ?? [];

  const liveBlock = live.length
    ? lines([`${count(live.length, 'live incident')} inside the selected area:`,
      ...live.map(event => `• ${event.title}${event.severity ? ` · ${event.severity}` : ''}${event.status ? ` · ${event.status}` : ''}${event.carriagewayLabel ? ` · ${event.carriagewayLabel}` : ''}`)])
    : 'No live incidents are inside the selected area.';

  const crashes = context.crashes ?? null;
  /**
   * The hotspot badges' own count, reconciled.
   *
   * The Safety layer clusters register crashes together with crashes derived from the live feed.
   * Reporting only the register made a "2 crashes" badge sit over an area the panel called empty.
   * Where the two differ, the difference is named rather than hidden.
   */
  const crashLine = crashes?.available && crashes.total
    ? lines([
      `${count(crashes.total, 'crash record')} inside the area on the Safety layer — the number its `
        + `hotspot badges count. ${crashes.fromRegister} from the incident register, `
        + `${crashes.fromFeed} derived from the live FL511 feed (not register records).`,
      ...crashPointers(crashes.records),
    ])
    : null;

  if (!historical.length) {
    /**
     * Two different empties, never conflated.
     *
     * The register loads lazily, so a question asked in the first seconds after the screen opens
     * found zero records and the answer said nothing at all about history — indistinguishable
     * from a genuinely quiet stretch of road. The corpus total settles it.
     */
    const corpus = context.maintenanceCorpus?.incidents ?? 0;
    return lines([
      liveBlock,
      '',
      corpus === 0
        ? 'Historical incident records cannot be counted yet — the incident register has not finished '
          + 'loading. Ask again in a moment.'
        : `None of the ${corpus} incident records in the register fall inside the selected area.`,
      ...(crashLine ? ['', crashLine] : []),
    ]);
  }
  return lines([liveBlock, '', ...historicalPointers(historical),
    ...(crashLine && crashes.total !== historical.length ? ['', crashLine] : [])]);
}

/**
 * Twenty-three record ids are not an answer.
 *
 * The first version listed eight of them and said "…and 15 more", which told an operator nothing
 * about what the records had in common — which is the only reason they were asked about. These
 * are the things that actually correlate them: what kind of event, which asset they cluster on,
 * and over what period. Source wording is counted as-is and never rewritten into a tidier label.
 */
export function summariseHistoricalRecords(records = []) {
  const tally = (list, keyOf) => {
    const counts = new Map();
    for (const item of list) {
      const key = keyOf(item);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  };
  const byType = tally(records, record => record.title);
  const byAsset = tally(records, record => record.assetId);
  const times = records
    .map(record => registerInstant(record.reported))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  // Only where the register actually said so: a record with no coordinates of its own is placed
  // at its damaged asset, and that is a different claim about where it happened.
  const viaAsset = records.filter(record => record.locatedVia === 'asset').length;
  return Object.freeze({
    total: records.length,
    byType, byAsset,
    distinctTypes: byType.length,
    distinctAssets: byAsset.length,
    from: times.length ? times[0] : null,
    to: times.length ? times[times.length - 1] : null,
    datedRecords: times.length,
    viaAsset,
  });
}

const monthYear = ms => new Date(ms).toLocaleDateString('en-US',
  { month: 'short', year: 'numeric', timeZone: 'America/New_York' });

/**
 * What the crashes in an area have in common.
 *
 * "How are these correlated?" was answered with a count, because the count was all the context
 * carried. These are the only relations the records actually support — what kind of event, where
 * they sit, and when — and each is stated as a grouping, never as a cause.
 */
function crashPointers(records = []) {
  if (records.length < 2) {
    // One record has nothing to correlate with; list it rather than imply a pattern.
    return records.length === 1
      ? ['', `The one record is ${records[0].id}${records[0].title ? ` · ${records[0].title}` : ''}.`]
      : [];
  }
  const tally = keyOf => {
    const counts = new Map();
    for (const record of records) { const key = keyOf(record); if (key) counts.set(key, (counts.get(key) ?? 0) + 1); }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  };
  const byType = tally(record => record.title);
  const bySeverity = tally(record => record.severity);
  const times = records.map(record => record.reportedAtMs).filter(Number.isFinite).sort((a, b) => a - b);
  const out = ['', 'What they have in common'];
  if (byType.length) {
    out.push(byType.length === records.length
      ? `• Type: all different — ${byType.map(([title]) => title).join(', ')}`
      : `• Type: ${byType.map(([title, n]) => `${n} × ${title}`).join(', ')}`);
  }
  if (bySeverity.length) out.push(`• Severity: ${bySeverity.map(([value, n]) => `${n} × ${value}`).join(', ')}`);
  if (times.length > 1) {
    const span = Math.round((times[times.length - 1] - times[0]) / 86_400_000);
    out.push(`• Reported ${span === 0 ? 'on the same day' : `${span} day${span === 1 ? '' : 's'} apart`}`);
  } else if (!times.length) {
    out.push('• No reported times are published on these records, so they cannot be ordered in time.');
  }
  out.push(`• Source: ${tally(record => record.source).map(([value, n]) => `${n} × ${value}`).join(', ')}`);
  out.push('');
  out.push('They share a location because they fall in the area you drew — that is proximity, not a '
    + 'common cause. Nothing in these records links one to another.');
  return out;
}

/** The summary as the bullets an operator can read in one pass. */
function historicalPointers(records) {
  const summary = summariseHistoricalRecords(records);
  const TOP = 4;
  const typeLines = summary.byType.slice(0, TOP).map(([title, n]) => `• ${n} × ${title}`);
  if (summary.byType.length > TOP) {
    const rest = summary.byType.slice(TOP).reduce((sum, [, n]) => sum + n, 0);
    typeLines.push(`• ${rest} across ${summary.byType.length - TOP} other `
      + `${summary.byType.length - TOP === 1 ? 'type' : 'types'}`);
  }
  const assetLines = summary.byAsset.slice(0, 3).map(([assetId, n]) => `• ${n} at asset ${assetId}`);
  if (summary.distinctAssets > 3) {
    assetLines.push(`• spread across ${summary.distinctAssets} distinct asset locations in all`);
  }
  const when = summary.from
    ? (monthYear(summary.from) === monthYear(summary.to)
      ? `• All in ${monthYear(summary.from)}`
      : `• ${monthYear(summary.from)} – ${monthYear(summary.to)}`)
    : '• No reported dates on these records';

  return [
    `The register holds ${count(summary.total, 'historical incident record')} inside the area — past `
      + 'records, not current conditions, and the number the Safety layer\'s hotspot badges count.',
    '',
    'What they are',
    ...typeLines,
    '',
    'Where they cluster',
    ...assetLines,
    '',
    'When',
    when,
    summary.datedRecords && summary.datedRecords < summary.total
      ? `• ${summary.total - summary.datedRecords} without a reported date` : null,
    '',
    'How to read this',
    summary.viaAsset
      ? `• ${summary.viaAsset === summary.total ? `All ${summary.total}` : `${summary.viaAsset} of ${summary.total}`} `
        + 'are positioned at the damaged asset rather than at surveyed coordinates, so they group by '
        + 'asset, not by an exact spot.'
      : '• Positions come from the records themselves.',
    '• "Records" is deliberate — the register does not confirm every one as a crash.',
    '• A count in one place is a concentration of reports, not a measured crash rate.',
  ];
}

/**
 * The conditions the records were logged in.
 *
 * A correlation and nothing more. The register writes a condition on each record; counting them
 * says how many fell in each, not that the weather had anything to do with it — a tall "Rain"
 * count may only mean it rains often here. That caveat is part of the answer, not a footnote.
 */
export function describeIncidentWeather(context) {
  const records = context.maintenance?.incidents ?? [];
  const corpus = context.maintenanceCorpus?.incidents ?? 0;
  if (!records.length) {
    return corpus === 0
      ? 'Historical incident records cannot be grouped by weather yet — the incident register has '
        + 'not finished loading. Ask again in a moment.'
      : `None of the ${corpus} incident records in the register fall inside the selected area, so `
        + 'there is nothing to group by weather.';
  }
  const counts = new Map();
  let unknown = 0;
  for (const record of records) {
    const condition = record.weather;
    if (!condition) { unknown += 1; continue; }
    counts.set(condition, (counts.get(condition) ?? 0) + 1);
  }
  if (!counts.size) {
    return lines([
      `${count(records.length, 'historical incident record')} fall inside the selected area, but none `
        + 'of them carries a recorded weather condition — so they cannot be grouped by weather.',
      'The register writes the condition per record; where it is absent nothing is inferred from the date.',
    ]);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const known = records.length - unknown;
  const share = n => `${Math.round((n / known) * 100)}%`;
  return lines([
    `${count(records.length, 'historical incident record')} inside the area. `
      + `${known} carry a recorded weather condition${unknown ? `, ${unknown} do not` : ''}. `
      + `Shares below are of those ${known}:`,
    '',
    // The denominator is stated once above rather than repeated on every line.
    ...ranked.map(([condition, n]) => `• ${n} × ${condition} — ${share(n)}`),
    '',
    'How to read this',
    `• ${ranked[0][0]} is the most common condition here, which is not the same as the most dangerous: `
      + 'a large count may only mean those conditions are common on this corridor.',
    '• This is a correlation between a record and the condition written on it. It does not establish '
      + 'that the weather contributed to any of them.',
    '• No exposure denominator is available — there is no count of how much traffic ran in each '
      + 'condition — so these cannot be turned into per-condition rates.',
  ]);
}

/**
 * The ways an operator asks for something to be put on the map.
 *
 * "fly" was missing from the first version, which is the phrasing this application uses in its own
 * buttons — so "fly to the windy incidents on the cesium map" matched nothing and was answered in
 * prose. The vocabulary is kept in one place because two matchers below need it.
 */
const MAP_VERB = new RegExp(MAP_VERB_SRC, 'i');
const MAP_WORD = new RegExp(MAP_WORD_SRC, 'i');

/**
 * Whether a question is asking for a map action rather than an explanation.
 *
 * Two shapes count. An explicit map word with a verb is unambiguous. A verb alone counts only when
 * the question also names a subset the records actually contain — "show me the 6 windy incidents"
 * is an instruction, while "show me the incidents here" is a request to list them.
 *
 * Allowing a map word to stand in for an unrecognised verb is deliberate: "fky to … on cesium mao"
 * should still work, and guessing at spellings is a worse answer than reading the noun.
 */
export function isMapInstruction(question, { qualified = false } = {}) {
  const text = String(question ?? '');
  const verb = MAP_VERB.test(text);
  const place = MAP_WORD.test(text);
  /**
   * A question ABOUT the map is not an instruction TO it.
   *
   * "What does the cesium map show?" carries both a verb and a map word and would otherwise draw
   * every record in the area. A leading interrogative marks it as a question — unless it also
   * names a subset, because "which windy incidents can you show on the map?" is an instruction
   * wearing a question mark.
   */
  const asksAbout = /^\s*(what|which|how|why|does|do|did|is|are|can|could|should)\b/i.test(text);
  if (verb && place) return qualified || !asksAbout;
  if (verb && qualified) return true;
  // A map word plus a named subset, where the verb was mistyped or left out.
  return place && qualified;
}

/**
 * Which of the area's records a "show these" instruction means.
 *
 * The filter is read from the conditions and types the records ACTUALLY carry, never from a fixed
 * vocabulary: "the one with light rain" is resolved by finding a weather value present in this
 * set, so a condition the register has never used cannot be matched and a new one needs no code
 * change. An instruction naming nothing selects everything, which is what "show them" means.
 *
 * @returns {{records: object[], label: string, matched: boolean, reason: string|null}}
 */
export function filterAreaRecords(context, question) {
  const all = context?.maintenance?.incidents ?? [];
  const text = String(question ?? '').toLowerCase();
  if (!all.length) {
    const corpus = context?.maintenanceCorpus?.incidents ?? 0;
    return { records: [], label: 'historical incident records', matched: false,
      reason: corpus === 0
        ? 'the incident register has not finished loading'
        : 'no incident records fall inside the selected area' };
  }

  // Weather, matched against the values present here.
  const conditions = [...new Set(all.map(record => record.weather).filter(Boolean))]
    .sort((a, b) => b.length - a.length);   // longest first: "light rain" before "rain"
  const condition = conditions.find(value => text.includes(value.toLowerCase()));
  if (condition) {
    const records = all.filter(record => record.weather === condition);
    return { records, label: `recorded in ${condition}`, matched: true, reason: null };
  }

  // Failing that, an incident type.
  const types = [...new Set(all.map(record => record.title).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  const type = types.find(value => text.includes(value.toLowerCase()));
  if (type) {
    return { records: all.filter(record => record.title === type), label: type, matched: true, reason: null };
  }

  return { records: all, label: 'historical incident records', matched: false, reason: null };
}

/** One class of live event, or an honest nothing. */
function eventSection(context, group, label) {
  const found = context.liveEvents[group] ?? [];
  if (!found.length) return `No ${label} are inside the selected area.`;
  return lines([`${count(found.length, label.replace(/s$/, ''))} inside the selected area:`,
    ...found.map(event => `• ${event.title}${event.severity ? ` · ${event.severity}` : ''}${event.status ? ` · ${event.status}` : ''}${event.carriagewayLabel ? ` · ${event.carriagewayLabel}` : ''}`)]);
}

/** The assets, grouped by the category the explorer already names them with. */
export function describeAssets(context) {
  const { assets } = context;
  if (!assets.total) return 'No assets from the loaded layers fall inside the selected area.';
  const byCategory = Object.entries(assets.byCategory).sort((a, b) => b[1] - a[1]);
  return lines([`${count(assets.total, 'asset')} inside the selected area:`,
    ...byCategory.map(([category, n]) => `• ${n} × ${category}`)]);
}

/** Maintenance, stating plainly when a record is here because its ASSET is here. */
export function describeMaintenance(context, { openOnly = false, group = null } = {}) {
  // Keyed by the context's own field, labelled in the words an operator uses for it — the two are
  // not the same string, and printing the field name gave "8 open workOrders".
  const LABELS = { workOrders: ['work order', 'work orders'], tickets: ['ticket', 'tickets'],
    tasks: ['task', 'tasks'], inspections: ['inspection', 'inspections'],
    damagedAssets: ['damaged asset', 'damaged assets'], incidents: ['incident', 'incidents'] };
  const groups = group ? [group] : ['workOrders', 'tickets', 'tasks', 'inspections', 'damagedAssets'];
  const blocks = [];
  for (const key of groups) {
    const [singular, plural] = LABELS[key] ?? [key, key];
    const all = context.maintenance[key] ?? [];
    const found = openOnly ? all.filter(isOpenRecord) : all;
    if (!found.length) continue;
    blocks.push(lines([`${count(found.length, openOnly ? `open ${singular}` : singular, openOnly ? `open ${plural}` : plural)}:`,
      ...found.slice(0, 8).map(record => `• ${record.id}${record.title ? ` · ${record.title}` : ''}${record.status ? ` · ${record.status}` : ''}${record.priority ? ` · priority ${record.priority}` : ''}${record.locatedVia === 'asset' && record.assetId ? ` · via asset ${record.assetId}` : ''}`),
      found.length > 8 ? `…and ${found.length - 8} more.` : null]));
  }
  if (!blocks.length) {
    return openOnly
      ? 'No open work is recorded against anything in the selected area.'
      : 'No maintenance records are associated with the selected area.';
  }
  return blocks.join('\n\n');
}

/** The whole picture — §23. */
export function describeSummary(context) {
  const events = context.liveEvents;
  const historical = context.maintenance?.incidents ?? [];
  const operations = [
    `• ${count(events.incidents.length, 'live incident')}`,
    `• ${count(events.closures.length, 'closure')}`,
    `• ${count(events.disabledVehicles.length, 'disabled vehicle')}`,
    `• ${count(events.congestion.length, 'congestion report')}`,
    `• ${count(events.construction.length, 'construction zone')}`,
  ];
  const open = context.totals.openWorkOrders;
  const maintenance = context.totals.maintenance
    ? `• ${count(context.totals.maintenance, 'maintenance record')}${open ? `, ${count(open, 'open work order')}` : ''}`
      + (historical.length
        ? `\n• ${count(historical.length, 'historical incident record')} (past records, not current conditions)`
        : '')
    : '• No maintenance records';
  return lines([
    describeRoadway(context),
    '',
    'Current operations:',
    ...operations,
    '',
    'Assets in the area:',
    context.assets.total
      ? Object.entries(context.assets.byCategory).sort((a, b) => b[1] - a[1]).map(([category, n]) => `• ${n} × ${category}`).join('\n')
      : '• None from the loaded layers',
    '',
    'Maintenance:',
    maintenance,
  ]);
}

/**
 * The answer for one area question.
 *
 * @returns {string|null} null when the intent is not one this answers
 */
export function answerAreaQuestion(intent, context) {
  if (!context) return null;
  switch (intent) {
    case 'summary': return describeSummary(context);
    case 'roadway': return describeRoadway(context);
    // showRecords is executed by the caller, which owns the map; the text is produced there too.
    case 'showRecords': return null;
    case 'incidentWeather': return describeIncidentWeather(context);
    case 'incidents': return describeIncidents(context);
    case 'closures': return eventSection(context, 'closures', 'closures');
    case 'assets': return describeAssets(context);
    case 'cameras': return describeAssetCategory(context, /camera/i, 'traffic cameras');
    case 'signs': return describeAssetCategory(context, /sign/i, 'message signs');
    case 'workOrders': return describeMaintenance(context, { openOnly: true, group: 'workOrders' });
    case 'maintenance': return describeMaintenance(context);
    default: return null;
  }
}

/** One category of asset, by the explorer's own label for it. */
function describeAssetCategory(context, pattern, label) {
  const found = context.assets.records.filter(record => pattern.test(record.category));
  if (!found.length) return `No ${label} are inside the selected area.`;
  return lines([`${count(found.length, label.replace(/s$/, ''))} inside the selected area:`,
    ...found.slice(0, 10).map(record => `• ${record.name}`),
    found.length > 10 ? `…and ${found.length - 10} more.` : null]);
}

/** The short line the panel shows while an area is up — §38. */
export function areaIndicatorText(context) {
  if (!context) return '';
  const parts = [`${context.totals.sections || 'no'} ${context.totals.sections === 1 ? 'section' : 'sections'}`,
    `${context.totals.assets} ${context.totals.assets === 1 ? 'asset' : 'assets'}`];
  if (context.totals.events) parts.push(`${context.totals.events} live`);
  if (context.totals.openWorkOrders) parts.push(`${context.totals.openWorkOrders} open WO`);
  return `Selected area · ${parts.join(' · ')}`;
}

/** The summary block shown as soon as the area is drawn — §18, before any question is asked. */
export function areaSummaryLines(context) {
  if (!context) return [];
  const { roadway, totals, liveEvents } = context;
  const historical = context.maintenance?.incidents ?? [];
  const corpus = context.maintenanceCorpus?.incidents ?? 0;
  const crashes = context.crashes ?? null;
  const where = roadway.intersectsI595
    ? [...roadway.segments.map(segment => `${CARRIAGEWAY_LABELS[segment.carriageway]} · ${segment.sectionLabel}`),
      ...(roadway.includesExpress ? ['I-595 Express'] : [])]
    : ['Does not intersect the modelled I-595 corridor'];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /**
   * One fact per row.
   *
   * These were already separate lines; the bubble's CSS collapsed them into a paragraph, so the
   * whole summary arrived as a wall of words. Headed groups and bullets make it scannable now
   * that the line breaks actually survive.
   */
  return [
    'Roadway',
    ...where.map(line => `• ${line}`),
    '',
    'In this area',
    `• ${plural(totals.sections, 'roadway section', 'roadway sections')}`,
    `• ${plural(totals.assets, 'asset', 'assets')}`,
    `• ${plural(liveEvents.closures.length, 'closure', 'closures')}`,
    // "live" is not decoration: an area can hold zero live incidents and dozens of historical
    // records, and the unqualified word made those two read as a contradiction.
    `• ${plural(liveEvents.incidents.length, 'live incident', 'live incidents')}`,
    historical.length
      ? `• ${plural(historical.length, 'historical incident record', 'historical incident records')}`
      : (corpus === 0
        ? '• Historical incident records — register still loading'
        : '• 0 historical incident records'),
    // What the map's hotspot badges count, whenever it differs from the register alone.
    ...(crashes?.available && crashes.total !== historical.length
      ? [`• ${plural(crashes.total, 'crash record', 'crash records')} on the Safety layer`
        + ` (${crashes.fromFeed} from the live feed)`]
      : []),
    `• ${plural(totals.openWorkOrders, 'open work order', 'open work orders')}`,
  ];
}

/** What to offer once an area exists — §22. */
export const AREA_SUGGESTIONS = Object.freeze([
  'What is happening in this area?',
  'Are there any incidents here?',
  'Have there been crashes here before?',
  'What weather were these incidents recorded in?',
  'What closures affect this area?',
  'Which roadway segments are selected?',
  'What assets are here?',
  'Are there open work orders here?',
]);
