/**
 * Ask the Twin for the Seagirt electrical twin: question → deterministic tool → ONE result that
 * both the answer panel and the map are drawn from.
 *
 * NOTHING IS INVENTED. Every fact comes from the connectivity engine, the scenario session, the
 * inspection records or the GIS associations. Load, capacity, voltage drop and fault duty are not in
 * the inventory, so those questions answer what CAN be determined, what cannot, and the inputs an
 * engineering study would need — never a number composed from language.
 *
 * THE RESULT CONTRACT (`emptyResult`). One object per question: the assets it is about (targets),
 * the assets that explain it (related), paths and their edges, a downstream set split into normally
 * supplied and conditionally reachable, result groups for the panel, the scenario it ran, the
 * camera targets, the answer text, limitations and provenance, and the map actions it declares.
 * The page validates the result (`validateResult`) and then draws exactly that: the text and the map
 * cannot disagree, because neither is derived from the other.
 *
 * SCENARIOS. Outage and transfer questions RUN the scenario on the shared session (the one the map
 * colours). Any other question is answered from the baseline network; an active simulation is
 * cleared first and the answer says so, so a baseline answer is never drawn over a simulated state.
 *
 * CONTEXT. The last subject, result set and intent are kept, so "What about T2?", "Show its
 * downstream assets", "Highlight those cranes" and "Reset the simulation" work as follow-ups.
 */
import {
  allSupplyPaths, CONSUMER_TYPES, energize, findAlternativeSupplyPaths, getDownstreamAssets, pathEdges, STATE, SWITCH, SWITCHING_TYPES,
  switchState, traceSupplyPath, transformerDependence, upstreamOfType,
} from './electricalGraph.js';
import { answerProvenance, assetProvenance } from './provenance.js';

export const INTENT = Object.freeze({
  LOCATE: 'LOCATE', LIST: 'LIST', RELATED: 'RELATED', UPSTREAM_TYPE: 'UPSTREAM_TYPE', PATH: 'PATH', CONNECTIONS: 'CONNECTIONS',
  DOWNSTREAM: 'DOWNSTREAM', CONSUMERS: 'CONSUMERS', OUTAGE: 'OUTAGE', TRANSFER: 'TRANSFER', ALTERNATES: 'ALTERNATES',
  NO_REDUNDANCY: 'NO_REDUNDANCY', SINGLE_SOURCE: 'SINGLE_SOURCE', INSPECTION: 'INSPECTION', OVERDUE: 'OVERDUE', CONDITION: 'CONDITION',
  REPLACEMENT: 'REPLACEMENT', HISTORY: 'HISTORY', ENGINEERING: 'ENGINEERING', HIGHLIGHT: 'HIGHLIGHT', SWITCH: 'SWITCH', RESET: 'RESET',
  UNKNOWN: 'UNKNOWN',
});

/** The map actions a result may declare. The page runs only these, and only after validation. */
export const ACTION = Object.freeze({
  FOCUS_ASSET: 'FOCUS_ASSET', HIGHLIGHT_ASSETS: 'HIGHLIGHT_ASSETS', TRACE_UPSTREAM: 'TRACE_UPSTREAM', TRACE_DOWNSTREAM: 'TRACE_DOWNSTREAM',
  SHOW_SUPPLY_PATH: 'SHOW_SUPPLY_PATH', SHOW_FEEDERS: 'SHOW_FEEDERS', SHOW_ASSET_GROUP: 'SHOW_ASSET_GROUP', RUN_OUTAGE: 'RUN_OUTAGE',
  SET_SWITCH: 'SET_SWITCH', SHOW_OUTAGE_IMPACT: 'SHOW_OUTAGE_IMPACT', SHOW_ALTERNATIVE_PATH: 'SHOW_ALTERNATIVE_PATH',
  SHOW_MAINTENANCE_RESULTS: 'SHOW_MAINTENANCE_RESULTS', SHOW_ENGINEERING_LIMITATION: 'SHOW_ENGINEERING_LIMITATION',
  RESET_INVESTIGATION: 'RESET_INVESTIGATION',
});

/** Intents that run or change the simulated scenario; every other question is answered from the baseline. */
const SCENARIO_INTENTS = new Set([INTENT.OUTAGE, INTENT.TRANSFER, INTENT.SWITCH, INTENT.RESET, INTENT.HIGHLIGHT]);

export const SUGGESTIONS = Object.freeze([
  'What happens if Transformer T1 goes offline?',
  'Which transformer supplies power to Crane C1?',
  'Does Crane C2 have an alternative electrical supply?',
  'Show the complete electrical connection path from the main supply to Crane C3.',
  'Where are all the electrical substations and distribution panels located?',
]);

const CONNECTIVITY_ONLY = 'Connectivity model only: an energized path does not confirm adequate voltage, capacity, protection coordination or safe switching.';
const SIMULATED = 'A simulated scenario on the illustrative model — not the live operational state of the terminal, and not a basis for field switching.';
const SCHEMATIC = 'Connections are schematic between illustrative positions: no cable routes are recorded.';
const SYNTHETIC_RECORDS = 'Inspection and condition records are synthetic demonstration data, not Seagirt maintenance records.';

// ---- words → types -----------------------------------------------------------------------------------

const TYPE_WORDS = Object.freeze([
  [/\btransformers?\b/, ['TRANSFORMER']], [/\bcranes?\b/, ['CRANE']], [/\bswitchgears?\b/, ['SWITCHGEAR']],
  [/\b(circuit |tie )?breakers?\b/, ['CIRCUIT_BREAKER']], [/\bfeeders?\b/, ['FEEDER']], [/\bwarehouses?\b/, ['WAREHOUSE']],
  [/\bbuildings?\b/, ['WAREHOUSE', 'BUILDING']], [/\bsubstations?\b/, ['SUBSTATION']], [/\blighting( circuits?)?\b/, ['LIGHTING_CIRCUIT']],
  [/\bcharg(er|ers|ing)\b|\bev\b/, ['EV_CHARGING']], [/\b(distribution )?panels?\b/, ['DISTRIBUTION_PANEL']],
  // Words for equipment the IFC network names (src/ifcSpatial/ifcNetwork.js); absent from the original inventory.
  [/\bcables?\b/, ['FEEDER']], [/\b(tie |transfer )?switch(es)?\b/, ['SWITCH']], [/\bswitching stations?\b|\bbus(es)?\b(?!-)/, ['SWITCHGEAR']],
  [/\bring main units?\b|\bunit substations?\b/, ['SUBSTATION']], [/\b(power )?vaults?\b/, ['JUNCTION_BOX']], [/\breefers?\b/, ['OTHER_LOAD']],
  [/\b(light(ing)? )?masts?\b|\b(high[- ]mast )?lights\b/, ['LIGHTING_CIRCUIT']], [/\bgenerators?\b/, ['UTILITY_SUPPLY']],
]);
export const TYPE_LABEL = Object.freeze({
  TRANSFORMER: ['transformer', 'transformers'], CRANE: ['crane', 'cranes'], SWITCHGEAR: ['switchgear', 'switchgear'],
  CIRCUIT_BREAKER: ['circuit breaker', 'circuit breakers'], FEEDER: ['feeder', 'feeders'], WAREHOUSE: ['warehouse', 'warehouses'],
  BUILDING: ['building', 'buildings'], SUBSTATION: ['substation', 'substations'], LIGHTING_CIRCUIT: ['lighting circuit', 'lighting circuits'],
  EV_CHARGING: ['charging station', 'charging stations'], DISTRIBUTION_PANEL: ['distribution panel', 'distribution panels'],
  UTILITY_SUPPLY: ['main supply', 'supply points'],
  SWITCH: ['switch', 'switches'], JUNCTION_BOX: ['crane power vault', 'crane power vaults'], OTHER_LOAD: ['load', 'loads'],
});
const label = (type, n = 2) => (TYPE_LABEL[type] ?? [type.toLowerCase().replaceAll('_', ' '), `${type.toLowerCase().replaceAll('_', ' ')}s`])[n === 1 ? 0 : 1];
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
/** An asset's recorded condition as a word; an inventory without condition records (the IFC model) says so. */
const conditionWord = a => (a?.condition ? a.condition.toLowerCase() : 'not recorded');
/** "Buildings" are the inventory's warehouses and buildings. */
const CATEGORY = Object.freeze({ WAREHOUSE: 'BUILDING', BUILDING: 'BUILDING' });
const categoryOf = type => CATEGORY[type] ?? type;

/** "Transformer T1" → "T1", so the subject's own type word is not read as a filter. */
const stripTypedIds = q => q.replace(/\b(main supply|substation|transformer|switchgear|circuit breaker|tie breaker|breaker|alternate feeder|feeder|crane|warehouse|lighting circuit|distribution panel|panel|charging station|ring main unit|bus tie breaker|cable|apron cable|switch|tie switch|reefers?(?: east| west)?|truck gate)\s+(?=[a-z]{1,3}\d|[a-z]{1,5}-[a-z0-9])/g, '');

/** Every asset type named in a question, in the order named. */
export function typesIn(q) {
  const found = [];
  for (const [re, types] of TYPE_WORDS) {
    const m = q.match(re);
    if (m) found.push([m.index, types]);
  }
  return [...new Set(found.sort((a, b) => a[0] - b[0]).flatMap(([, t]) => t))];
}

/** Asset-id-like words that are NOT in the inventory ("X9"), so they are answered as missing. */
export function unknownIdsIn(question, network) {
  const ids = new Set([...network.assets.keys()].map(id => id.toLowerCase()));
  return [...String(question).toLowerCase().matchAll(/\b([a-z]{1,3}\d{1,2}[a-z]?)\b/g)].map(m => m[1])
    .filter(t => !ids.has(t) && !/^(i|a)\d/.test(t)).map(t => t.toUpperCase());
}

/** Asset ids named in a question (case-insensitive), in the order they appear, plus phrases. */
export function entitiesIn(question, network) {
  const q = question.toLowerCase();
  const ids = new Map([...network.assets.keys()].map(id => [id.toLowerCase(), id]));
  const found = [];
  const hits = [];
  for (const m of q.matchAll(/\b([a-z]{1,3}\d{1,2}[a-z]?(?:-[a-z]+)?)\b/g)) {
    const id = ids.get(m[1]);
    if (id) hits.push([m.index, id]);
  }
  // Ids the pattern above cannot see: hyphenated ones (TX-M1, USS-3, STS-05, AP-03) and plain words
  // (GATE, OPS). Matched whole, never inside a longer id ("STS-01" is not "STS-01-STRUCT").
  for (const [lower, id] of ids) {
    if (/^[a-z]{1,3}\d{1,2}[a-z]?(?:-[a-z]+)?$/.test(lower) || lower.length < 2) continue;
    const re = new RegExp(`(?<![a-z0-9-])${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`, 'g');
    for (const m of q.matchAll(re)) hits.push([m.index, id]);
  }
  for (const [, id] of hits.sort((a, b) => a[0] - b[0])) if (!found.includes(id)) found.push(id);
  if (/\bmain supply\b|\butility\b/.test(q) && ids.has('ms1') && !found.includes('MS1')) found.push('MS1');
  if (/\bsubstation\b/.test(q) && !found.some(id => network.assets.get(id)?.assetType === 'SUBSTATION')) {
    const subs = [...network.assets.values()].filter(a => a.assetType === 'SUBSTATION');
    if (subs.length === 1 && /\bthe substation\b|substation (lose|fail|go)|substation\b.*\?/.test(q)) found.push(subs[0].id);
  }
  return found;
}

const usesPronoun = q => /\b(it|its|it's|that|this|those|these|them|they)\b/.test(q);
const OUTAGE_WORDS = /what happens if|\bwhat if\b.*\b(no power|offline|down|out|fails?|trips?)\b|\bif\b.*\b(has|have|had|gets?|got) no power\b|\b(go|goes|went) offline\b|\bfails?\b|\bfailure\b|\btaken offline\b|\b(lose|loses|lost) power\b|\boutage\b|\bis opened\b|\bopened\b|\btrips?\b|\bout of service\b|\bde-?energi[sz]ed?\b|\bdisconnect(ed|ion)?\b/;

/** The intent of a question, its subject(s) and filters. Pure. */
export function parseQuestion(question, network, context = {}) {
  const q = ` ${String(question ?? '').toLowerCase().replace(/[?!.,;:]+/g, ' ').replace(/\s+/g, ' ')} `;
  const named = entitiesIn(q, network);
  const unknown = named.length ? [] : unknownIdsIn(q, network);
  const types = typesIn(stripTypedIds(q));
  const type = types[0] ?? null;
  // A named asset first; an id the inventory does not have is still the subject (it is answered as
  // missing, never swapped for the last subject); otherwise a pronoun or a bare question follows on.
  const subject = named[0] ?? unknown[0] ?? (usesPronoun(q) || !named.length ? context.lastSubject ?? context.selectedAssetId ?? null : null);
  const of = (intent, extra = {}) => ({ intent, subject, named, type, types, ...extra });
  const consumerTypes = types.filter(t => CONSUMER_TYPES.has(t) || t === 'BUILDING');

  if (/\b(reset|clear)\b.*\b(simulation|scenario|map|view)\b|\bback to (the )?baseline\b|^ reset /.test(q)) return of(INTENT.RESET);
  const imperative = q.match(/^ (?:please )?(close|open) (?:the )?(?:tie )?(?:breaker )?([a-z]+\d+)/);
  if (imperative) return of(INTENT.SWITCH, { subject: named[0], position: imperative[1] === 'close' ? SWITCH.CLOSED : SWITCH.OPEN });
  // A bare follow-up naming a new subject: "What about T2?" repeats the last question about it.
  if (/^ (what|how) about\b|^ and (for )?\b/.test(q) && named.length && context.lastIntent) {
    return { ...of(context.lastIntent), subject: named[0], filter: context.lastFilter ?? null, followUp: true };
  }
  // Engineering studies the connectivity model cannot answer: checked first, so "overload" or
  // "capacity" is never mistaken for an outage or a list.
  const engineering = /\bvoltage drop\b/.test(q) ? 'VOLTAGE_DROP'
    : /\bshort[- ]circuit\b|\binterrupting\b|\bfault current\b|\barc flash\b/.test(q) ? 'SHORT_CIRCUIT'
      : /\boverload\w*\b/.test(q) && /\btransfer\w*\b|\bto t\d\b/.test(q) ? 'TRANSFER_OVERLOAD'
        : /\b(current|present|measured|electrical|peak) load\b|\bloading\b|\butili[sz]ation\b/.test(q) && /\b(rated|rating|capacity)\b/.test(q) ? 'LOAD'
          : /\b(sufficient|enough|spare|available) capacity\b|\bcapacity\b.*\b(new|add|connect)|\b(new|add\w*)\b.*\bcapacity\b|\boverload\w*\b/.test(q) ? 'CAPACITY'
            : null;
  if (engineering) return of(INTENT.ENGINEERING, { study: engineering });
  if (/\breplace(ment|d)?\b/.test(q)) return of(INTENT.REPLACEMENT, { subject: named[0] ?? null });
  if (/\boverdue\b|\bpast due\b|\bdue for (an )?inspection\b/.test(q)) return of(INTENT.OVERDUE, { subject: named[0] ?? null });
  if (/\bmaintenance (history|records?)\b|\bwork orders?\b|\bhistory\b/.test(q)) return of(INTENT.HISTORY);
  if (/\b(last )?inspect(ed|ion)\b/.test(q) && named.length) return of(INTENT.INSPECTION);
  if (/\bcondition\b/.test(q) && !OUTAGE_WORDS.test(q)) {
    return of(INTENT.CONDITION, { condition: /\bpoor|bad\b/.test(q) ? 'POOR' : /\bfair\b/.test(q) ? 'FAIR' : /\bgood\b/.test(q) ? 'GOOD' : null, subject: named[0] ?? null });
  }
  if (OUTAGE_WORDS.test(q) && named.length >= 2 && /\b(supply|supplies|pick up|carry|take over|feed)\b/.test(q)) {
    return of(INTENT.TRANSFER, { failed: named[0], candidate: named[1] });
  }
  if (/\bno (redundan\w*|backup|alternative|second)\b|\bnot redundant\b|\bwithout (a )?(redundant|backup|alternative)\b|\bsingle points? of failure\b/.test(q)) {
    return of(INTENT.NO_REDUNDANCY, { subject: null });
  }
  if (/\bsingle (transformer|supply|source|point)\b|\bonly one (transformer|supply|source)\b|\bdepend\w* on (a|one) single\b/.test(q)) {
    // The consumers asked about, not the "transformer" they depend on.
    return of(INTENT.SINGLE_SOURCE, { subject: null, type: typesIn(q.replace(/\b(single|one|a) (transformer|supply|source)s?\b/g, ''))[0] ?? 'CRANE' });
  }
  if (/\b(alternative|alternate|backup|back-up|redundan\w*|second supply|another supply)\b/.test(q)) {
    return of(INTENT.ALTERNATES, { asksFeeder: /\b(alternat\w*|backup) feeder\b|\bwhich feeder\b/.test(q) });
  }
  if (/\b(remain|remains|stay|stays|still)\b.*\bpowered\b/.test(q) && named.length) return of(INTENT.OUTAGE, { filter: 'POWERED' });
  if (OUTAGE_WORDS.test(q) && (named.length || subject)) {
    const scope = consumerTypes.length ? 'CATEGORIES' : /\b(all|every)\b.*\bequipment\b|\bdownstream\b|\ball (electrical )?assets\b/.test(q) ? 'ALL' : null;
    return of(INTENT.OUTAGE, { filter: consumerTypes.length === 1 && consumerTypes[0] === 'CRANE' && !/\bbuildings?\b/.test(q) ? 'CRANE' : null, scope, categories: consumerTypes });
  }
  if (/\bwhich (transformer|breaker|circuit breaker|switchgear|feeder|substation|ring main unit|switch|cable|switching station)\b.*\b(supplies|supply|feeds|feed|controls|control|serves|powers|protects)\b/.test(q)) {
    return of(INTENT.UPSTREAM_TYPE, { upstreamType: typesIn(stripTypedIds(q).replace(/(supplies|supply|feeds|feed|controls|control|serves|powers|protects).*/, ''))[0] ?? 'TRANSFORMER' });
  }
  if (/\bwhich (transformer|breaker|circuit breaker|switchgear|feeder|substation|panel|ring main unit|switch|cable|switching station)s?\b.*\bconnected (to|with)\b/.test(q) && named.length) return of(INTENT.RELATED);
  if (/\b(path|trace|route)\b/.test(q)) {
    // The source end (a supply point) and the other end, whichever order they were named in.
    const from = named.find(id => network.assets.get(id)?.assetType === 'UTILITY_SUPPLY') ?? null;
    return of(INTENT.PATH, { from, subject: named.find(id => id !== from) ?? (from ? null : subject) });
  }
  if ((/\bdownstream\b|\bconnected (to|below|from)\b|\bfed (from|by)\b.*\bequipment\b/.test(q)) && (named.length || subject) && !/\bnetwork\b/.test(q)) {
    return of(INTENT.DOWNSTREAM, { typeFilter: types.length ? types : null });
  }
  // "Show all lights supplied by TX-2": what of those kinds is downstream of it.
  if (types.length && named.length && /\b(supplied|fed|powered|served) (by|from)\b/.test(q)) {
    return of(INTENT.DOWNSTREAM, { typeFilter: types.filter(t => t !== network.assets.get(named[0])?.assetType) });
  }
  // "What supplies STS-05?": its supply path, upstream to the source.
  if (/^ what (supplies|feeds|powers|serves|energi[sz]es)\b/.test(q) && (named.length || subject)) return of(INTENT.PATH, { from: null });
  // "What does TX-M1 supply?", "What does it feed?": what the asset supplies, never where it is.
  if (/\bwhat (does|do|will|would|can) (?:[a-z0-9-]+ ){1,4}(supply|feed|power|serve|energi[sz]e)\b|\bwhat (is|are|gets) (supplied|fed|powered|served) (by|from)\b/.test(q) && (named.length || subject)) {
    return of(INTENT.DOWNSTREAM, { typeFilter: null });
  }
  if (/\b(consumers|loads|equipment)\b.*\b(supplied|fed|served|powered) by\b|\bconnected loads\b/.test(q)) return of(INTENT.CONSUMERS);
  if (/\b(highlight|show|select)\b.*\b(those|these|them)\b/.test(q) && context.lastResultIds?.length) return of(INTENT.HIGHLIGHT, { filterType: type });
  if (types.length && !named.length && !unknown.length && /\b(all|every|list|where are)\b|\bshow (me )?(the )?\w+s\b/.test(q)) {
    return of(INTENT.LIST, { subject: null, listTypes: types, connected: /\bconnected\b/.test(q) });
  }
  if (/\b(where|locate|find|show|zoom|fly|highlight)\b/.test(q) && subject) return of(INTENT.LOCATE);
  if (named.length) return of(INTENT.LOCATE);
  return of(INTENT.UNKNOWN);
}

// ---- helpers over the network ----------------------------------------------------------------------------

const list = names => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
const uniq = ids => [...new Set(ids)];
const hasPoint = (network, id) => Number.isFinite(network.assets.get(id)?.location?.longitude);

/** Where an asset is on the map: its own point, or the equipment it sits inside. */
export function mapPositionOf(network, id) {
  const a = network.assets.get(id);
  if (!a) return null;
  if (Number.isFinite(a.location?.longitude)) return { assetId: id, lon: a.location.longitude, lat: a.location.latitude, own: true };
  const host = a.location?.containerAssetId ?? (a.assetType === 'FEEDER' ? a.to : null);
  return host && host !== id ? { ...mapPositionOf(network, host), own: false, via: host } : null;
}

/** The nearest positioned assets upstream and downstream of an unpositioned one (a feeder's two ends). */
function positionedEnds(network, id) {
  const walk = (start, dir) => {
    const seen = new Set([start]), queue = [start], out = [];
    while (queue.length) {
      const at = queue.shift();
      for (const e of (dir === 'up' ? network.in : network.out).get(at) ?? []) {
        const next = dir === 'up' ? e.fromAssetId : e.toAssetId;
        if (seen.has(next)) continue;
        seen.add(next);
        if (hasPoint(network, next)) out.push(next); else queue.push(next);
      }
    }
    return out;
  };
  return { up: walk(id, 'up'), down: walk(id, 'down') };
}

/** The positioned assets that show an asset on the map: itself, its switchgear, or a feeder's two ends. */
export function anchorsOf(network, id) {
  if (hasPoint(network, id)) return [id];
  const a = network.assets.get(id);
  if (!a) return [];
  if (a.location?.containerAssetId) return anchorsOf(network, a.location.containerAssetId);
  const { up, down } = positionedEnds(network, id);
  return uniq([...up, ...down]);
}

const pathEdgeIds = (network, path) => pathEdges(network, path).map(e => e.id);
const feedersOn = (network, ids) => ids.filter(id => network.assets.get(id)?.assetType === 'FEEDER');
const nodesNow = (network, session) => (session?.state().active ? session.state().result.after.nodes : energize(network).nodes);
const STATE_WORD = { [STATE.ENERGIZED]: 'energized', [STATE.DE_ENERGIZED]: 'no power', [STATE.OFFLINE]: 'offline', [STATE.UNKNOWN]: 'unknown' };
const fmt = v => (v?.value === null || v?.value === undefined ? null : `${v.value} ${v.unit ?? ''}`.trim());
const isoDay = d => (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** One result in the contract every question produces. */
export function emptyResult(intent, question = '') {
  return {
    intent, question, status: 'ANSWERED', subject: null,
    primaryAssetId: null, targetAssetIds: [], relatedAssetIds: [], contextAssetIds: [],
    pathAssetIds: [], pathEdgeIds: [], paths: [], downstream: null, feederIds: [],
    energizedAssetIds: [], deenergizedAssetIds: [], conditionalAssetIds: [], unknownAssetIds: [],
    cameraTargetAssetIds: [], resultGroups: [], scenarioId: null, scenario: null,
    answer: { title: '', summary: '', explanation: '', lines: [], limitations: [], determinable: [], missingInputs: [], followUps: [] },
    visualization: { mode: 'NONE', focus: 'NONE', animateEnergizedPaths: true },
    actions: [], provenance: null, resultIds: [],
  };
}

/** A path in the result: its asset ids, its edges, and how it is drawn (normal | alternate | restored | interrupted). */
const pathOf = (network, assetIds, style = 'normal') => ({ assetIds, edgeIds: pathEdgeIds(network, assetIds), style });

// ---- answers ------------------------------------------------------------------------------------------------

/**
 * Answer a parsed question against the network, the scenario session, the inspection records and
 * the GIS associations. Returns the result contract (`emptyResult`), not yet finalized.
 */
export function answerQuestion(parsed, { network, session, inspections = [], associations = [], today = new Date(), question = '' }) {
  // A network can describe its own sources (the IFC network's connections are modelled, and it has no records).
  const CONNECTION_NOTE = network.notes?.connections ?? SCHEMATIC;
  const RECORDS_NOTE = network.notes?.records ?? SYNTHETIC_RECORDS;
  const r = emptyResult(parsed.intent, question);
  r.subject = parsed.subject ?? null;
  const A = r.answer;
  const nameOf = id => network.assets.get(id)?.name ?? id;
  const names = ids => ids.map(nameOf);
  const subject = parsed.subject ? network.assets.get(parsed.subject) : null;
  const need = parsed.subject && !subject ? parsed.subject : null;
  const mode = (m, focus = m) => { r.visualization = { mode: m, focus, animateEnergizedPaths: true }; };
  const say = (title, summary, extra = {}) => { A.title = title; A.summary = summary; Object.assign(A, extra); return r; };
  const missing = id => {
    r.status = 'NOT_FOUND';
    return say('Not in the inventory', `${id ? `${id} is` : 'That asset is'} not in the Seagirt electrical inventory, so this cannot be determined. Try an asset such as T1, S2, CB3, F3 or C1.`);
  };
  const ask = (title, summary) => { r.status = 'NEEDS_SUBJECT'; return say(title, summary); };
  const today_ = isoDay(today);
  const consumersOf = id => getDownstreamAssets(network, id).filter(d => !d.viaNormallyOpen && CONSUMER_TYPES.has(network.assets.get(d.assetId)?.assetType)).map(d => d.assetId).sort();
  const nameplate = ids => ids.reduce((t, id) => t + (network.assets.get(id)?.rating?.unit === 'MW' ? network.assets.get(id).rating.value : 0), 0);

  switch (parsed.intent) {
    case INTENT.RESET: {
      session.reset();
      mode('NONE');
      r.actions = [{ type: ACTION.RESET_INVESTIGATION }];
      return say('Simulation reset', 'The simulated outage was cleared. The map shows the baseline network again.');
    }

    case INTENT.SWITCH: {
      if (!subject || !SWITCHING_TYPES.has(subject.assetType)) return say('Not a switching device', `${parsed.subject ?? 'That'} is not a breaker or switch in the inventory, so it cannot be opened or closed in a scenario.`);
      const state = session.setSwitch(subject.id, parsed.position);
      r.actions = [{ type: ACTION.SET_SWITCH, assetId: subject.id, position: parsed.position }, { type: ACTION.SHOW_OUTAGE_IMPACT }];
      return outageResult(r, network, state, { lead: `${subject.name} ${parsed.position === SWITCH.CLOSED ? 'closed' : 'opened'} in the simulation.`, subject });
    }

    case INTENT.LOCATE: {
      if (need) return missing(need);
      if (!subject) return ask('Which asset?', 'Name an asset (for example “Where is Transformer T1?”), or select one on the map.');
      const prov = assetProvenance(subject, { associations, records: inspections });
      const s = nodesNow(network, session).get(subject.id);
      r.primaryAssetId = subject.id;
      r.targetAssetIds = [subject.id];
      if (subject.location?.containerAssetId) r.relatedAssetIds = [subject.location.containerAssetId];
      if (subject.assetType === 'FEEDER') { r.feederIds = [subject.id]; r.contextAssetIds = anchorsOf(network, subject.id); }
      mode('ASSET');
      r.actions = [{ type: ACTION.FOCUS_ASSET, assetId: subject.id }];
      const v = subject.voltage ? [fmt(subject.voltage.primary), fmt(subject.voltage.secondary)].filter(Boolean).join(' / ') : null;
      return say(subject.name, `${cap(label(subject.assetType, 1))} ${subject.id}. ${prov.locationNote}`, {
        lines: [
          `Electrical state: ${STATE_WORD[s] ?? 'not evaluated'} (modelled)`,
          ...(v ? [`Voltage: ${v}`] : []), ...(fmt(subject.rating) ? [`Rating: ${fmt(subject.rating)}`] : []),
          ...(SWITCHING_TYPES.has(subject.assetType) ? [`Normal state: ${(subject.normalState ?? 'CLOSED').toLowerCase()}`] : []),
          `Recorded condition: ${conditionWord(subject)}`,
        ],
        limitations: ['The equipment and its position are illustrative, not a record of real Seagirt equipment.'],
      });
    }

    case INTENT.LIST: {
      let items = [...network.assets.values()].filter(a => parsed.listTypes.includes(a.assetType));
      if (parsed.connected) items = items.filter(a => traceSupplyPath(network, a.id).path.length);
      mode('GROUP');
      if (!items.length) { r.status = 'NO_RESULTS'; return say(`No ${list(parsed.listTypes.map(t => label(t)))}`, `The inventory has no ${list(parsed.listTypes.map(t => label(t)))}.`); }
      const ids = items.map(a => a.id);
      const nodes = nodesNow(network, session);
      r.targetAssetIds = ids;
      r.resultGroups = parsed.listTypes.map(t => ({ key: t, label: cap(label(t, items.filter(a => a.assetType === t).length)), assetIds: items.filter(a => a.assetType === t).map(a => a.id), tone: 'focus' }))
        .filter(g => g.assetIds.length);
      r.actions = [{ type: ACTION.SHOW_ASSET_GROUP, assetIds: ids }];
      const counts = r.resultGroups.map(g => `${g.assetIds.length} ${label(g.key, g.assetIds.length)}`);
      return say(cap(list(counts)), `${list(items.map(a => a.name))}${parsed.connected ? ', each with a supply path from the main supply' : ''}.`, {
        lines: items.map(a => {
          const prov = assetProvenance(a, { associations, records: inspections });
          return `${a.name} — ${STATE_WORD[nodes.get(a.id)] ?? 'not evaluated'}${a.condition && a.condition !== 'GOOD' ? ` · condition ${conditionWord(a)}` : ''} · ${prov.location === 'CANDIDATE_ASSOCIATION' ? `illustrative position (candidate OSM footprint ${prov.association.distanceM} m away, unverified)` : prov.locationNote.replace(/\.$/, '').toLowerCase()}`;
        }),
        limitations: [`This is the illustrative model’s inventory, not a verified list of every ${label(parsed.listTypes[0], 1)} installed at the terminal.`],
      });
    }

    case INTENT.RELATED: {
      if (need) return missing(need);
      if (!subject) return ask('Connected to what?', 'Name the equipment, for example “Which switchgear is connected to Transformer T2?”.');
      const type = parsed.types[0];
      // The nearest assets of that type in each direction: the topology, read both ways.
      const nearest = dir => {
        const out = [], seen = new Set([subject.id]), queue = [[subject.id]];
        while (queue.length) {
          const trail = queue.shift();
          for (const e of (dir === 'down' ? network.out : network.in).get(trail.at(-1)) ?? []) {
            const next = dir === 'down' ? e.toAssetId : e.fromAssetId;
            if (seen.has(next)) continue;
            seen.add(next);
            if (network.assets.get(next)?.assetType === type) out.push({ id: next, trail: [...trail, next] }); else queue.push([...trail, next]);
          }
        }
        return out;
      };
      const down = nearest('down'), up = nearest('up');
      mode('PATH');
      if (!down.length && !up.length) { r.status = 'NO_RESULTS'; r.targetAssetIds = [subject.id]; return say(`No ${label(type, 1)} is connected to ${subject.name}`, `The model has no ${label(type, 1)} connected to ${subject.name} in either direction.`); }
      r.paths = [...down.map(d => pathOf(network, d.trail)), ...up.map(u => pathOf(network, [...u.trail].reverse()))];
      r.targetAssetIds = [...down, ...up].map(x => x.id);
      r.primaryAssetId = r.targetAssetIds[0];
      r.relatedAssetIds = [subject.id];
      r.actions = [...down.map(d => ({ type: ACTION.TRACE_DOWNSTREAM, rootId: subject.id, assetIds: d.trail })), ...up.map(u => ({ type: ACTION.TRACE_UPSTREAM, rootId: subject.id, assetIds: u.trail }))];
      const rel = [...down.map(d => `${subject.name} supplies ${nameOf(d.id)} (${d.trail.join(' → ')}, direction of supply)`),
        ...up.map(u => `${nameOf(u.id)} supplies ${subject.name} (${[...u.trail].reverse().join(' → ')}, direction of supply)`)];
      return say(`${list(names(r.targetAssetIds))} ${r.targetAssetIds.length > 1 ? 'are' : 'is'} connected to ${subject.name}`, `${rel.join('; ')}.`, {
        limitations: [CONNECTION_NOTE],
      });
    }

    case INTENT.UPSTREAM_TYPE: {
      if (need) return missing(need);
      if (!subject) return ask('Which asset?', 'Name the equipment, for example “Which transformer supplies Crane C1?”.');
      const type = parsed.upstreamType ?? 'TRANSFORMER';
      const found = upstreamOfType(network, subject.id, type);
      const { path, live } = traceSupplyPath(network, subject.id);
      mode('PATH');
      if (!found) { r.status = 'NO_RESULTS'; r.targetAssetIds = [subject.id]; return say('Not found', `No ${label(type, 1)} is upstream of ${subject.name} in the inventory.`); }
      const verb = type === 'CIRCUIT_BREAKER' ? 'controls' : 'supplies';
      r.primaryAssetId = found;
      r.targetAssetIds = [found, subject.id];
      r.paths = [pathOf(network, path)];
      r.feederIds = feedersOn(network, path);
      r.actions = [{ type: ACTION.SHOW_SUPPLY_PATH, assetIds: path, edgeIds: r.paths[0].edgeIds }];
      const i = path.indexOf(found);
      const between = path.slice(i + 1, -1);
      const lines = [`Path: ${path.join(' → ')}`];
      if (type === 'CIRCUIT_BREAKER') {
        const b = network.assets.get(found);
        lines.push(`Breaker: ${found} in ${nameOf(b.location?.containerAssetId ?? b.parentAssetId)}${b.location?.cubicle ? `, cubicle ${b.location.cubicle}` : ''} · normally ${(b.normalState ?? 'CLOSED').toLowerCase()} · ${fmt(b.rating) ?? 'no rating'} continuous`);
        lines.push(`Feeder: ${list(feedersOn(network, path.slice(i)))}`);
        lines.push(`Upstream: ${path.slice(0, i).reverse().join(' ← ')}`, `Downstream: ${path.slice(i + 1).join(' → ')}`);
      }
      return say(`${nameOf(found)} ${verb} ${subject.name}`,
        `${nameOf(found)} ${verb} ${subject.name}${between.length ? ` through ${list(between.map(id => `${label(network.assets.get(id).assetType, 1)} ${id}`))}` : ''}, on its ${live ? 'normal, energized' : 'only recorded'} supply path.`, {
          lines, limitations: [CONNECTION_NOTE],
        });
    }

    case INTENT.PATH:
    case INTENT.CONNECTIONS: {
      if (need) return missing(need);
      if (!subject) return ask('Path to what?', 'Name the end of the path, for example “Show the electrical path from the main supply to Crane C3”.');
      const { path, live } = traceSupplyPath(network, subject.id, { sourceId: parsed.from && network.assets.get(parsed.from)?.assetType === 'UTILITY_SUPPLY' ? parsed.from : null });
      mode('PATH');
      if (!path.length) { r.status = 'NO_RESULTS'; r.targetAssetIds = [subject.id]; return say('No path', `No supply path to ${subject.name} is recorded in the inventory.`); }
      r.primaryAssetId = subject.id;
      r.targetAssetIds = [subject.id];
      r.paths = [pathOf(network, path)];
      r.feederIds = feedersOn(network, path);
      r.actions = [{ type: ACTION.SHOW_SUPPLY_PATH, assetIds: path, edgeIds: r.paths[0].edgeIds }];
      const lines = [path.join(' → ')];
      if (parsed.intent === INTENT.CONNECTIONS) {
        const all = getDownstreamAssets(network, subject.id);
        const normal = all.filter(d => !d.viaNormallyOpen).map(d => d.assetId), cond = all.filter(d => d.viaNormallyOpen).map(d => d.assetId);
        if (normal.length || cond.length) {
          r.downstream = { rootId: subject.id, normal, conditional: cond };
          r.feederIds = uniq([...r.feederIds, ...feedersOn(network, [...normal, ...cond])]);
          r.actions.push({ type: ACTION.TRACE_DOWNSTREAM, rootId: subject.id, assetIds: normal, conditionalIds: cond });
          const fed = normal.filter(id => CONSUMER_TYPES.has(network.assets.get(id).assetType));
          if (fed.length) lines.push(`Supplies ${list(fed)}${cond.length ? `; ${list(cond)} only through a normally-open device` : ''}.`);
        }
      }
      return say(parsed.intent === INTENT.CONNECTIONS ? `Connections of ${subject.name}` : `Supply path to ${subject.name}`,
        `${path.length - 1} connections from ${nameOf(path[0])} to ${subject.name}${live ? ', all closed and energized in the baseline' : ' — this path is not live in the baseline'}. Supply runs ${path[0]} → ${subject.id}.`, {
          lines, limitations: [CONNECTION_NOTE],
        });
    }

    case INTENT.DOWNSTREAM:
    case INTENT.CONSUMERS: {
      if (need) return missing(need);
      if (!subject) return ask('Downstream of what?', 'Name the equipment, for example “What equipment is connected downstream of Switchgear S2?”.');
      const all = getDownstreamAssets(network, subject.id);
      // A normally-open device below the root is energized on its line side but passes nothing on.
      const openDevices = all.filter(d => !d.viaNormallyOpen && switchState(network, null, d.assetId) === SWITCH.OPEN).map(d => d.assetId);
      const normal = all.filter(d => !d.viaNormallyOpen && !openDevices.includes(d.assetId)).map(d => d.assetId);
      const cond = all.filter(d => d.viaNormallyOpen).map(d => d.assetId);
      const consumersOnly = parsed.intent === INTENT.CONSUMERS;
      const filter = consumersOnly ? [...CONSUMER_TYPES] : parsed.typeFilter;
      const keep = id => !filter || filter.includes(network.assets.get(id).assetType);
      const nT = normal.filter(keep), oT = consumersOnly ? [] : openDevices.filter(keep), cT = consumersOnly ? [] : cond.filter(keep);
      mode('DOWNSTREAM');
      r.primaryAssetId = subject.id;
      r.relatedAssetIds = [subject.id];
      r.downstream = { rootId: subject.id, normal: consumersOnly ? normal : [...normal, ...openDevices], conditional: consumersOnly ? [] : cond };
      r.targetAssetIds = [...nT, ...oT];
      r.conditionalAssetIds = uniq([...oT, ...cT]);
      r.contextAssetIds = filter ? normal.filter(id => !keep(id) && hasPoint(network, id)) : [];
      r.feederIds = feedersOn(network, [...nT, ...oT, ...cT]);
      r.actions = [{ type: ACTION.TRACE_DOWNSTREAM, rootId: subject.id, assetIds: r.downstream.normal, conditionalIds: r.downstream.conditional },
        ...(r.feederIds.length ? [{ type: ACTION.SHOW_FEEDERS, assetIds: r.feederIds }] : [])];
      if (!nT.length && !oT.length && !cT.length) { r.status = 'NO_RESULTS'; return say(`Nothing ${consumersOnly ? 'supplied by' : 'downstream of'} ${subject.name}`, `${subject.name} supplies nothing${filter ? ' of that kind' : ''} in the inventory.`); }
      const tie = openDevices.length ? list(openDevices) : null;
      if (filter && !consumersOnly) {
        const shown = [...nT, ...oT, ...cT];
        const byType = filter.filter(t => shown.some(id => network.assets.get(id).assetType === t));
        r.resultGroups = byType.map(t => {
          const ids = shown.filter(id => network.assets.get(id).assetType === t);
          const special = ids.filter(id => oT.includes(id) || cT.includes(id));
          return { key: t, label: cap(label(t)), assetIds: ids, tone: 'focus',
            note: special.length ? `${list(special)} ${special.some(id => oT.includes(id)) ? 'normally open' : `reachable only if ${tie} is closed`}` : null };
        });
        const counts = byType.map(t => `${shown.filter(id => network.assets.get(id).assetType === t).length} ${label(t)}`);
        A.followUps = [{ label: 'Expand all downstream equipment', question: `What equipment is connected downstream of ${subject.name}?` }];
        return say(`${shown.length} ${list(byType.map(t => label(t)))} connected to ${subject.name}`, `${cap(list(counts))} are downstream of ${subject.name}.`, {
          explanation: `${oT.length ? `${list(oT)} ${oT.length > 1 ? 'are' : 'is'} normally open${cT.length ? `, so ${list(cT)} ${cT.length > 1 ? 'are' : 'is'} energized only if ${tie} is closed` : ''}. ` : ''}${subject.name} has ${all.length} downstream assets in total; the other ${all.length - shown.length} (switchgear, panels and consumers) are not counted because only ${list(filter.map(t => label(t)))} were asked for.`,
          limitations: [CONNECTIVITY_ONLY],
        });
      }
      r.resultGroups = [
        { key: 'normal', label: consumersOnly ? 'Supplied normally' : `Normally supplied from ${subject.id}`, assetIds: nT, tone: 'ok' },
        ...(oT.length ? [{ key: 'open', label: 'Normally-open device', assetIds: oT, tone: 'cond', note: 'energized on its line side; passes no power while open' }] : []),
        ...(cT.length ? [{ key: 'conditional', label: `Reachable only if ${tie ?? 'a normally-open device'} is closed`, assetIds: cT, tone: 'cond', note: 'not supplied from here in the normal configuration' }] : []),
      ];
      const consumers = nT.filter(id => CONSUMER_TYPES.has(network.assets.get(id).assetType));
      return say(consumersOnly ? `${subject.name} supplies ${consumers.length} consumer${consumers.length === 1 ? '' : 's'}` : `${nT.length} asset${nT.length === 1 ? '' : 's'} normally supplied from ${subject.name}`,
        consumersOnly ? `${subject.name} supplies ${list(names(consumers))}.` : `${list(nT)}${cT.length ? `. ${list(cT)} ${cT.length > 1 ? 'are' : 'is'} reachable only through normally-open ${tie}` : ''}.`, {
          explanation: cT.length ? `${tie} is normally open: ${list(names(cT))} ${cT.length > 1 ? 'are' : 'is'} not supplied from ${subject.name} unless ${tie} is closed.` : '',
          limitations: [CONNECTIVITY_ONLY],
        });
    }

    case INTENT.OUTAGE: {
      if (need) return missing(need);
      if (!subject) return ask('Which asset?', 'Name the equipment, for example “What happens if Transformer T1 goes offline?”.');
      session.reset();
      const state = session.outage(subject.id);
      r.actions = [{ type: ACTION.RUN_OUTAGE, assetId: subject.id }, { type: ACTION.SHOW_OUTAGE_IMPACT }];
      return outageResult(r, network, state, { filter: parsed.filter, scope: parsed.scope, categories: parsed.categories ?? [], subject });
    }

    case INTENT.TRANSFER: {
      const failed = network.assets.get(parsed.failed), cand = network.assets.get(parsed.candidate);
      if (!failed || !cand) return missing(!failed ? parsed.failed : parsed.candidate);
      session.reset();
      const outage = session.outage(failed.id);
      const affected = [...outage.result.consumersLost];
      const options = affected.flatMap(id => findAlternativeSupplyPaths(network, id, outage.scenario)
        .filter(p => !p.blocked.length && p.needsClosing.length && p.transformers.includes(cand.id)).map(p => ({ id, ...p })));
      const ties = uniq(options.flatMap(o => o.needsClosing));
      let state = outage;
      for (const t of ties) state = session.setSwitch(t, SWITCH.CLOSED);
      const restored = affected.filter(id => !state.result.consumersLost.includes(id));
      const still = state.result.consumersLost;
      const restoredPaths = restored.map(id => traceSupplyPath(network, id, { scenario: state.scenario }).path);
      r.actions = [{ type: ACTION.RUN_OUTAGE, assetId: failed.id },
        ...ties.map(t => ({ type: ACTION.SET_SWITCH, assetId: t, position: SWITCH.CLOSED })),
        ...restoredPaths.map(p => ({ type: ACTION.SHOW_ALTERNATIVE_PATH, assetIds: p })),
        { type: ACTION.SHOW_OUTAGE_IMPACT }];
      outageResult(r, network, state, { subject: failed });
      r.intent = INTENT.TRANSFER;
      r.paths = restoredPaths.map(p => pathOf(network, p, 'restored'));
      r.feederIds = uniq(feedersOn(network, r.paths.flatMap(p => p.assetIds)));
      r.relatedAssetIds = uniq([cand.id, ...r.relatedAssetIds]);
      r.resultGroups = [
        { key: 'restored', label: `Can be reached from ${cand.id}`, assetIds: restored, tone: 'ok', note: ties.length ? `by closing ${list(ties)} (normally open)` : null },
        { key: 'still', label: 'Still without power', assetIds: still, tone: 'bad', note: still.length ? `no connection to ${cand.id} in the model` : null },
        ...(ties.length ? [{ key: 'switching', label: 'Switching assumed in the simulation', assetIds: ties, tone: 'cond', note: 'hypothetical, not an approved switching instruction' }] : []),
      ];
      r.resultIds = restored;
      return say(restored.length ? `${cand.name} can reach ${restored.length} of ${affected.length} affected consumers in the model` : `${cand.name} cannot supply the affected equipment in the model`,
        `With ${failed.name} offline, ${list(names(affected))} lose power. ${restored.length
          ? `Closing the normally-open ${list(ties)} connects ${list(names(restored))} to ${cand.id}${options[0] ? ` through ${list(feedersOn(network, options[0].path))}` : ''}; ${still.length ? `${list(names(still))} ${still.length > 1 ? 'have' : 'has'} no connection to ${cand.id}.` : 'every affected consumer is reached.'}`
          : `None of them has a modelled connection to ${cand.id}.`}`, {
          explanation: `This shows connectivity, not feasibility: whether ${cand.id} (rated ${fmt(cand.rating) ?? 'unknown'}) can carry the extra load, the protection settings, and an approved switching procedure are not in the model.`,
          limitations: [SIMULATED, CONNECTIVITY_ONLY, 'No measured or modelled loads are recorded, so spare capacity on the alternate source is not assessed.'],
        });
    }

    case INTENT.ALTERNATES: {
      if (need) return missing(need);
      if (!subject) return ask('Which equipment?', 'Name a consumer, for example “Does Crane C2 have an alternative electrical supply?”.');
      const paths = findAlternativeSupplyPaths(network, subject.id);
      mode('ALTERNATE');
      if (!paths.length) { r.status = 'NO_RESULTS'; r.targetAssetIds = [subject.id]; return say('No supply recorded', `No supply path to ${subject.name} is recorded.`); }
      const live = paths.filter(p => p.live), alt = paths.filter(p => !p.live);
      const liveIds = new Set(live.flatMap(p => p.path));
      r.primaryAssetId = subject.id;
      r.targetAssetIds = [subject.id];
      r.paths = [...live.map(p => pathOf(network, p.path, 'normal')), ...alt.map(p => pathOf(network, p.path, 'alternate'))];
      // Conditional = what only the open device reaches (and the device), not normally energized equipment it passes.
      const base = energize(network).nodes;
      r.conditionalAssetIds = uniq(alt.flatMap(p => [...p.needsClosing, ...p.path.filter(id => !liveIds.has(id) && base.get(id) !== STATE.ENERGIZED)]));
      r.feederIds = feedersOn(network, uniq(paths.flatMap(p => p.path)));
      r.actions = [...live.map(p => ({ type: ACTION.SHOW_SUPPLY_PATH, assetIds: p.path })), ...alt.map(p => ({ type: ACTION.SHOW_ALTERNATIVE_PATH, assetIds: p.path, needsClosing: p.needsClosing }))];
      const normalVia = list(live.flatMap(p => p.transformers).map(nameOf)) || 'its feeder';
      const ties = uniq(alt.flatMap(p => p.needsClosing));
      r.resultGroups = [
        { key: 'normal', label: 'Normal supply', assetIds: live[0]?.path ?? [], tone: 'ok' },
        ...(alt.length ? [{ key: 'alternate', label: `Alternate (needs ${list(ties)} closed)`, assetIds: uniq(alt.flatMap(p => p.path).filter(id => !liveIds.has(id))), tone: 'cond' }] : []),
      ];
      const lines = paths.map(p => `${p.live ? 'Normal' : 'Alternate'}: ${p.path.join(' → ')}${p.needsClosing.length ? ` — needs ${list(p.needsClosing.map(nameOf))} closed (normally open)` : ''}`);
      const limitations = ['A modelled alternate path is not a verified, usable backup: capacity, protection and the switching procedure are not validated.', CONNECTIVITY_ONLY];
      if (parsed.asksFeeder) {
        const altFeeders = feedersOn(network, uniq(alt.flatMap(p => p.path))).filter(id => !liveIds.has(id));
        const normalFeeders = feedersOn(network, live[0]?.path ?? []);
        const spof = (live[0]?.path ?? []).filter(id => id !== subject.id && network.assets.get(id).assetType !== 'UTILITY_SUPPLY');
        if (!altFeeders.length) {
          r.status = 'NO_RESULTS';
          return say(`No modelled alternative feeder for ${subject.name}`,
            `${subject.name} is supplied only through ${list(normalFeeders)} (${(live[0]?.path ?? []).slice(-5).join(' → ')}). The model has no other feeder or tie that reaches it.`, {
              explanation: `During a planned shutdown of ${list(spof)}, ${subject.name} would be without power in the model. No alternative feeder is invented.`,
              lines, limitations,
            });
        }
        return say(`${list(altFeeders.map(nameOf))} could supply ${subject.name}`, `${subject.name} is normally supplied through ${list(normalFeeders)}. ${list(altFeeders)} reaches it if ${list(ties)} is closed.`, { lines, limitations });
      }
      if (!alt.length) {
        return say(`${subject.name} has one supply path`, `No. ${subject.name} has a single supply path in the model, through ${normalVia}.`, { lines, limitations });
      }
      return say(`${subject.name} has a normally-open alternate`,
        `Yes, in the model. ${subject.name} is normally supplied through ${normalVia}. ${alt.length > 1 ? `${alt.length} alternate paths` : 'An alternate path'} through ${list(uniq(alt.flatMap(p => p.transformers)).map(nameOf))} ${alt.length > 1 ? 'exist but are' : 'exists but is'} not energized: ${list(ties.map(nameOf))} ${ties.length > 1 ? 'are' : 'is'} normally open and ${ties.length > 1 ? 'stay' : 'stays'} open unless a scenario closes ${ties.length > 1 ? 'them' : 'it'}.`, {
          explanation: `Switching: ${list(ties)} would have to be closed. Closing ${ties.length > 1 ? 'them' : 'it'} while ${list(feedersOn(network, live[0]?.path ?? []))} is still live would parallel the ${list(uniq(live.flatMap(p => p.transformers)))} and ${list(uniq(alt.flatMap(p => p.transformers)))} branches at ${subject.id}; the model does not check whether that is permitted.`,
          lines, limitations,
        });
    }

    case INTENT.NO_REDUNDANCY: {
      const supplied = [...network.assets.values()].filter(a => a.assetType !== 'UTILITY_SUPPLY');
      const rows = supplied.map(a => ({ id: a.id, paths: allSupplyPaths(network, a.id) }));
      const single = rows.filter(x => x.paths.length <= 1).map(x => x.id);
      const multi = rows.filter(x => x.paths.length > 1).map(x => x.id);
      const consumerPaths = rows.filter(x => CONSUMER_TYPES.has(network.assets.get(x.id).assetType)).flatMap(x => x.paths);
      const common = consumerPaths.length ? consumerPaths[0].filter(id => consumerPaths.every(p => p.includes(id))) : [];
      const transformers = [...network.assets.values()].filter(a => a.assetType === 'TRANSFORMER').map(a => a.id);
      const branchOf = id => traceSupplyPath(network, id).path.find(x => transformers.includes(x)) ?? null;
      const unknownConn = single.filter(id => nodesNow(network, session).get(id) === STATE.UNKNOWN);
      mode('GROUP');
      r.targetAssetIds = single.filter(id => CONSUMER_TYPES.has(network.assets.get(id).assetType) && !unknownConn.includes(id));
      r.relatedAssetIds = uniq([...common, ...single.filter(id => !CONSUMER_TYPES.has(network.assets.get(id).assetType) && hasPoint(network, id)), ...multi]);
      r.resultGroups = [
        { key: 'common', label: 'Common to every supply path', assetIds: common, tone: 'bad', note: 'single points of failure for the whole terminal' },
        ...transformers.map(t => ({ key: t, label: `${t} branch — one supply path`, assetIds: single.filter(id => branchOf(id) === t && id !== t), tone: 'warn' })),
        ...(multi.length ? [{ key: 'redundant', label: 'Has a second supply path', assetIds: multi, tone: 'ok', note: `through ${list(uniq(multi.flatMap(id => findAlternativeSupplyPaths(network, id).flatMap(p => p.needsClosing))))} (normally open)` }] : []),
        ...(unknownConn.length ? [{ key: 'unknown', label: 'Connection undocumented', assetIds: unknownConn, tone: 'neutral' }] : []),
      ].filter(g => g.assetIds.length);
      r.actions = [{ type: ACTION.SHOW_ASSET_GROUP, assetIds: [...r.targetAssetIds, ...r.relatedAssetIds] }];
      r.resultIds = single;
      return say(`${single.length} of ${supplied.length} supplied assets have a single supply path`,
        `Only ${list(names(multi))} ${multi.length > 1 ? 'have' : 'has'} a second path. Every other asset — including ${list(names(r.targetAssetIds.filter(id => network.assets.get(id).assetType === 'CRANE')))} — has one supply path, and every path${multi.length ? `, ${list(multi)}’s included,` : ''} runs through ${list(common)}.`, {
          explanation: 'Scope: redundancy here means more than one supply path in the connectivity model, counting paths through normally-open devices. It does not assess whether an alternate is usable (capacity, protection, switching procedure).',
          limitations: [CONNECTIVITY_ONLY],
        });
    }

    case INTENT.SINGLE_SOURCE: {
      const type = parsed.type ?? 'CRANE';
      const rows = transformerDependence(network, { type });
      const single = rows.filter(x => x.single), multi = rows.filter(x => !x.single);
      mode('GROUP');
      r.targetAssetIds = single.map(x => x.assetId);
      r.relatedAssetIds = uniq(rows.flatMap(x => x.transformers));
      // The dependency, drawn: each consumer's path from its transformer (an alternate dashed).
      r.paths = rows.flatMap(x => findAlternativeSupplyPaths(network, x.assetId).map(p => {
        const from = p.path.findIndex(id => network.assets.get(id)?.assetType === 'TRANSFORMER');
        return pathOf(network, p.path.slice(Math.max(0, from)), p.live ? 'normal' : 'alternate');
      }));
      r.conditionalAssetIds = uniq(r.paths.filter(p => p.style === 'alternate').flatMap(p => p.assetIds)
        .filter(id => !r.paths.some(p => p.style === 'normal' && p.assetIds.includes(id))));
      r.feederIds = feedersOn(network, uniq(r.paths.flatMap(p => p.assetIds)));
      r.resultGroups = [
        { key: 'single', label: 'One transformer only', assetIds: r.targetAssetIds, tone: 'warn' },
        ...(multi.length ? [{ key: 'alternate', label: 'Second path through a normally-open tie', assetIds: multi.map(x => x.assetId), tone: 'cond' }] : []),
      ];
      r.actions = [{ type: ACTION.SHOW_ASSET_GROUP, assetIds: rows.map(x => x.assetId) }, ...r.paths.map(p => ({ type: p.style === 'alternate' ? ACTION.SHOW_ALTERNATIVE_PATH : ACTION.SHOW_SUPPLY_PATH, assetIds: p.assetIds }))];
      r.resultIds = r.targetAssetIds;
      return say(`${single.length} of ${rows.length} ${label(type)} depend on one transformer`,
        `${single.length ? `${list(single.map(x => `${nameOf(x.assetId)} (${x.transformers.join(', ')})`))} can only be supplied through one transformer.` : `No ${label(type, 1)} depends on a single transformer.`}${multi.length ? ` ${list(multi.map(x => nameOf(x.assetId)))} has a second path, but only through a normally-open device.` : ''}`, {
          lines: [...single.map(x => `${x.assetId}: ${x.transformers[0]} only`), ...multi.map(x => `${x.assetId}: normally ${x.normalTransformer}; alternate via ${x.alternates.map(a => `${a.transformers.join(', ')} (needs ${a.needsClosing.join(', ')} closed)`).join('; ')}`)],
          explanation: 'Baseline supply is the normally-closed path. A switched alternative counts only where a modelled normally-open device connects a second transformer.',
          limitations: [CONNECTIVITY_ONLY],
        });
    }

    case INTENT.INSPECTION: {
      if (need) return missing(need);
      if (!subject) return ask('Which asset?', 'Name the equipment, for example “When was Transformer T3 last inspected?”.');
      mode('MAINTENANCE');
      r.primaryAssetId = subject.id;
      r.targetAssetIds = [subject.id];
      r.actions = [{ type: ACTION.SHOW_MAINTENANCE_RESULTS, assetIds: [subject.id] }];
      if (!subject.lastInspectionDate) { r.status = 'NO_RESULTS'; return say('No inspection recorded', `No inspection is recorded for ${subject.name} in the current inventory.`, { limitations: [RECORDS_NOTE] }); }
      const last = inspections.filter(x => x.assetId === subject.id).sort((a, b) => b.date.localeCompare(a.date))[0];
      const due = subject.nextInspectionDate;
      const overdue = due && due < today_ ? daysBetween(due, today_) : 0;
      return say(`${subject.name} last inspected ${subject.lastInspectionDate} — ${conditionWord(subject)} condition`,
        `${subject.name} was last inspected on ${subject.lastInspectionDate}${last ? ` (${last.type.toLowerCase()}: ${last.result.replaceAll('_', ' ').toLowerCase()})` : ''}. Its recorded condition is ${conditionWord(subject)}.`, {
          lines: [
            ...(last?.notes ? [`Finding: ${last.notes}`] : []),
            ...(subject.conditionNote ? [`Condition note: ${subject.conditionNote.replace(/^Synthetic: /, '')}`] : []),
            due ? `Next inspection due ${due}${overdue ? ` — overdue by ${overdue} days (as of ${today_})` : ''}` : 'No next inspection scheduled.',
          ],
          limitations: [RECORDS_NOTE],
        });
    }

    case INTENT.OVERDUE: {
      const types = parsed.types.length ? parsed.types : null;
      const pool = [...network.assets.values()].filter(a => (!types || types.includes(a.assetType)) && (!parsed.subject || a.id === parsed.subject));
      const scheduled = pool.filter(a => a.nextInspectionDate);
      const overdue = scheduled.filter(a => a.nextInspectionDate < today_);
      const current = scheduled.filter(a => a.nextInspectionDate >= today_);
      const unscheduled = pool.filter(a => !a.nextInspectionDate);
      const kind = types ? label(types[0]) : 'assets';
      mode('MAINTENANCE');
      if (!scheduled.length) {
        r.status = 'DATA_UNAVAILABLE';
        r.relatedAssetIds = pool.map(a => a.id);
        r.actions = [{ type: ACTION.SHOW_MAINTENANCE_RESULTS, assetIds: pool.map(a => a.id) }];
        return say(`No inspection schedules for the ${kind}`, `None of the ${pool.length} ${kind} has an inspection schedule in the inventory, so overdue inspections cannot be identified. No dates are invented.`, {
          missingInputs: ['Inspection intervals and last-inspection dates, from the maintenance system.'], limitations: [RECORDS_NOTE] });
      }
      r.targetAssetIds = overdue.map(a => a.id);
      r.relatedAssetIds = current.map(a => a.id);
      r.resultGroups = [
        { key: 'overdue', label: 'Overdue', assetIds: overdue.map(a => a.id), tone: 'bad' },
        { key: 'current', label: 'Not yet due', assetIds: current.map(a => a.id), tone: 'ok' },
        ...(unscheduled.length ? [{ key: 'none', label: 'No inspection schedule recorded', assetIds: unscheduled.map(a => a.id), tone: 'neutral' }] : []),
      ];
      r.actions = [{ type: ACTION.SHOW_MAINTENANCE_RESULTS, assetIds: pool.map(a => a.id) }];
      r.resultIds = r.targetAssetIds;
      if (!overdue.length) r.status = 'NO_RESULTS';
      return say(overdue.length ? `${overdue.length} ${overdue.length === 1 ? (types ? label(types[0], 1) : 'asset') : kind} with an overdue inspection` : `No ${kind} have overdue inspections`,
        overdue.length ? `${list(overdue.map(a => `${a.name} (due ${a.nextInspectionDate}, ${daysBetween(a.nextInspectionDate, today_)} days overdue)`))}, as of ${today_}.` : `Every ${types ? label(types[0], 1) : 'asset'} with an inspection schedule is within its due date as of ${today_}.`, {
          lines: [...overdue, ...current].map(a => `${a.id} — next due ${a.nextInspectionDate}${a.nextInspectionDate < today_ ? ` · overdue by ${daysBetween(a.nextInspectionDate, today_)} days` : ''} · last inspected ${a.lastInspectionDate ?? '—'}`),
          limitations: [RECORDS_NOTE, `Due dates are compared with ${today_}.`],
        });
    }

    case INTENT.CONDITION: {
      if (parsed.subject && !parsed.condition) {
        if (need) return missing(need);
        mode('MAINTENANCE');
        r.primaryAssetId = subject.id;
        r.targetAssetIds = [subject.id];
        r.actions = [{ type: ACTION.SHOW_MAINTENANCE_RESULTS, assetIds: [subject.id] }];
        if (!subject.condition) { r.status = 'NO_RESULTS'; return say('No condition recorded', `No condition is recorded for ${subject.name}.`, { limitations: [RECORDS_NOTE] }); }
        return say(`${subject.name}: ${conditionWord(subject)}`, `${subject.name} is recorded in ${subject.condition.toLowerCase()} condition${subject.conditionNote ? ` — ${subject.conditionNote.replace(/^Synthetic: /, '')}` : ''}.`, { limitations: [RECORDS_NOTE] });
      }
      const type = parsed.types[0] ?? 'TRANSFORMER';
      const want = parsed.condition ?? 'POOR';
      const all = [...network.assets.values()].filter(a => a.assetType === type);
      const items = all.filter(a => a.condition === want);
      const nodes = nodesNow(network, session);
      mode('MAINTENANCE');
      if (!all.some(a => a.condition)) {
        r.status = 'DATA_UNAVAILABLE';
        r.relatedAssetIds = all.map(a => a.id);
        r.actions = [{ type: ACTION.SHOW_MAINTENANCE_RESULTS, assetIds: all.map(a => a.id) }];
        return say(`No condition records for the ${label(type)}`, `None of the ${all.length} ${label(type)} has a recorded condition, so none can be classified as ${want.toLowerCase()}.`, {
          missingInputs: ['Condition assessments from inspections.'], limitations: [RECORDS_NOTE] });
      }
      r.targetAssetIds = items.map(a => a.id);
      r.relatedAssetIds = all.filter(a => a.condition !== want).map(a => a.id);
      r.resultGroups = [
        { key: 'match', label: `${cap(want.toLowerCase())} condition`, assetIds: items.map(a => a.id), tone: 'warn' },
        { key: 'other', label: `Other ${label(type)}`, assetIds: r.relatedAssetIds, tone: 'neutral' },
      ];
      r.actions = [{ type: ACTION.SHOW_MAINTENANCE_RESULTS, assetIds: all.map(a => a.id) }];
      r.resultIds = r.targetAssetIds;
      if (!items.length) r.status = 'NO_RESULTS';
      return say(items.length ? `${items.length} ${label(type, items.length)} in ${want.toLowerCase()} condition` : `No ${label(type)} recorded in ${want.toLowerCase()} condition`,
        items.length ? `${list(items.map(a => `${a.name}${a.conditionNote ? ` (${a.conditionNote.replace(/^Synthetic: /, '')})` : ''}`))}.` : `None of the ${all.length} ${label(type)} in the inventory is recorded in ${want.toLowerCase()} condition.`, {
          lines: all.map(a => `${a.id} — ${conditionWord(a)}${a.lastInspectionDate ? ` · inspected ${a.lastInspectionDate}` : ''} · electrically ${STATE_WORD[nodes.get(a.id)] ?? 'not evaluated'}`),
          explanation: 'Condition is the recorded physical condition from inspections; it is independent of whether the equipment is energized.',
          limitations: [RECORDS_NOTE],
        });
    }

    case INTENT.REPLACEMENT: {
      const FIELDS = ['replacementPlannedDate', 'plannedReplacementDate', 'replacementDate'];
      const pool = [...network.assets.values()];
      const planned = pool.map(a => ({ a, date: FIELDS.map(f => a[f]).find(Boolean) })).filter(x => x.date);
      mode('LIMITATION');
      if (!planned.length) {
        r.status = 'DATA_UNAVAILABLE';
        const poor = pool.filter(a => a.condition === 'POOR').map(a => a.id);
        const fair = pool.filter(a => a.condition === 'FAIR').map(a => a.id);
        r.relatedAssetIds = poor;
        r.resultGroups = [{ key: 'condition', label: 'Poor condition (context, not a plan)', assetIds: poor, tone: 'warn' }];
        r.actions = [{ type: ACTION.SHOW_ENGINEERING_LIMITATION, assetIds: poor }];
        return say('No replacement-planning data in the inventory',
          'The inventory has no replacement-planning field (planned replacement date or capital plan), so which assets are scheduled for replacement cannot be determined. No dates are invented.', {
            determinable: [`Recorded condition: ${list(poor)} poor; ${list(fair)} fair.`, ...(poor.includes('T3') ? ['T3’s inspection is also overdue — a condition record, not a replacement plan.'] : [])],
            missingInputs: ['A planned replacement date or capital-plan entry per asset (from the asset-management system).'],
            limitations: [RECORDS_NOTE],
          });
      }
      const end = new Date(`${today_}T00:00:00Z`); end.setUTCFullYear(end.getUTCFullYear() + 1);
      const within = planned.filter(x => x.date >= today_ && x.date <= isoDay(end));
      r.targetAssetIds = within.map(x => x.a.id);
      mode('MAINTENANCE');
      r.actions = [{ type: ACTION.SHOW_MAINTENANCE_RESULTS, assetIds: r.targetAssetIds }];
      return say(`${within.length} assets scheduled for replacement by ${isoDay(end)}`, list(within.map(x => `${x.a.name} (${x.date})`)) || 'None in the window.');
    }

    case INTENT.HISTORY: {
      if (need) return missing(need);
      if (!subject) return ask('Which asset?', 'Name the equipment, for example “Show the maintenance history and open work orders for Circuit Breaker CB5”.');
      const rows = inspections.filter(x => x.assetId === subject.id).sort((a, b) => b.date.localeCompare(a.date));
      const host = subject.location?.containerAssetId ?? null;
      const hostRows = host ? inspections.filter(x => x.assetId === host).sort((a, b) => b.date.localeCompare(a.date)) : [];
      mode('MAINTENANCE');
      r.primaryAssetId = subject.id;
      r.targetAssetIds = [subject.id];
      r.relatedAssetIds = host ? [host] : [];
      r.actions = [{ type: ACTION.SHOW_MAINTENANCE_RESULTS, assetIds: [subject.id] }, { type: ACTION.FOCUS_ASSET, assetId: subject.id }];
      const feeds = getDownstreamAssets(network, subject.id).filter(d => !d.viaNormallyOpen).map(d => d.assetId);
      if (!rows.length) r.status = 'NO_RESULTS';
      return say(rows.length ? `${subject.name}: ${rows.length} maintenance records` : `${subject.name}: no maintenance records`,
        rows.length ? `Maintenance and inspection history for ${subject.name}.` : `No maintenance or inspection record exists for ${subject.name} in the records.`, {
          lines: [
            ...rows.map(x => `${x.date} — ${x.type}: ${x.result.replaceAll('_', ' ').toLowerCase()}. ${x.notes}`),
            'Open work orders: not available — no work-order or maintenance-management system is connected (this is unavailable data, not zero work orders).',
            ...(SWITCHING_TYPES.has(subject.assetType) ? [`Equipment: ${host ? `in ${nameOf(host)}${subject.location?.cubicle ? `, cubicle ${subject.location.cubicle}` : ''} · ` : ''}${fmt(subject.rating) ?? 'no rating'} · normally ${(subject.normalState ?? 'CLOSED').toLowerCase()}${feeds.length ? ` · feeds ${feeds.join(' → ')}` : ''}`] : []),
            ...hostRows.slice(0, 1).map(x => `Related: ${nameOf(host)} — ${x.date} ${x.type.toLowerCase()}: ${x.result.replaceAll('_', ' ').toLowerCase()} (a record for the switchgear, not for ${subject.id} specifically).`),
          ],
          limitations: [RECORDS_NOTE],
        });
    }

    case INTENT.ENGINEERING:
      return engineeringResult(r, parsed, { network, nameOf, consumersOf, nameplate, missing, ask, say, mode });

    case INTENT.HIGHLIGHT:
      return r;

    default:
      r.status = 'UNSUPPORTED';
      mode('NONE');
      return say('I can’t determine that from the current inventory',
        'This assistant answers from the Seagirt electrical inventory, its connectivity model and its records only. Try one of these:', { lines: [...SUGGESTIONS] });
  }
}

/** Load, capacity, voltage drop, transfer and fault-duty questions: what can and cannot be determined. */
/** The model's own demand figures (the IFC's DemandkW): kW, or null where a load has none. */
const demandOf = (network, ids) => {
  const values = ids.map(id => network.assets.get(id)?.demandKw);
  return values.length && values.every(v => Number.isFinite(v)) ? values.reduce((s, v) => s + v, 0) : null;
};
const MODELLED_DEMAND = 'Demand is the model’s assumed average demand per load (DemandkW in the IFC), not measured or peak load; capacity is the model’s stated usable capacity (CapacitykW).';
const mw = kw => `${(kw / 1000).toFixed(2)} MW`;

function engineeringResult(r, parsed, { network, nameOf, consumersOf, nameplate, missing, ask, say, mode }) {
  const A = r.answer;
  const subject = parsed.subject ? network.assets.get(parsed.subject) : null;
  if (parsed.subject && !subject) return missing(parsed.subject);
  mode('LIMITATION');
  r.status = 'LIMITED';
  const LOADFLOW = 'Load, capacity and voltage are not part of the connectivity model; they need measured data or a validated power-system model (for example an EasyPower or ETAP study).';
  switch (parsed.study) {
    case 'LOAD': {
      if (!subject) return ask('Which transformer?', 'Name it, for example “What is the current electrical load on Transformer T1?”.');
      const fed = consumersOf(subject.id);
      r.primaryAssetId = subject.id;
      r.targetAssetIds = [subject.id];
      r.downstream = { rootId: subject.id, normal: getDownstreamAssets(network, subject.id).filter(d => !d.viaNormallyOpen).map(d => d.assetId), conditional: [] };
      r.contextAssetIds = fed;
      r.actions = [{ type: ACTION.SHOW_ENGINEERING_LIMITATION, assetIds: [subject.id] }];
      const demand = demandOf(network, fed);
      if (Number.isFinite(subject.capacityKw) && demand !== null) {
        const share = Math.round(demand / subject.capacityKw * 100);
        return say(`${subject.id}: modelled demand ${mw(demand)} of ${mw(subject.capacityKw)} capacity (${share}%)`,
          `In normal running ${subject.name} supplies ${fed.length} loads whose modelled average demand totals ${mw(demand)}, ${share}% of its ${mw(subject.capacityKw)} usable capacity. This is the model’s assumed demand, not a measured load.`, {
            determinable: [`Capacity: ${mw(subject.capacityKw)}${subject.ratingText ? ` (${subject.ratingText})` : ''}.`, `Normally supplies ${list(fed)}.`],
            missingInputs: [`Metered or SCADA load for ${subject.id}, and peak (not average) demand.`],
            limitations: [MODELLED_DEMAND, LOADFLOW],
          });
      }
      return say(`${subject.name}’s current load is not available`, `The inventory holds ${subject.id}’s rating but no measured or modelled load, so its loading against capacity cannot be stated.`, {
        determinable: [`Rating: ${fmt(subject.rating) ?? 'not recorded'} (illustrative record)`, ...(subject.voltage ? [`Voltage: ${[fmt(subject.voltage.primary), fmt(subject.voltage.secondary)].filter(Boolean).join(' / ')}`] : []),
          `Normally supplies ${list(fed)} — connected nameplate ${nameplate(fed).toFixed(2)} MW (the sum of their recorded ratings; not a measured or diversified load).`],
        missingInputs: [`Metered or SCADA load for ${subject.id} (kVA, time-stamped), or a load study.`, 'Power factor and demand/diversity factors for the connected loads.'],
        limitations: [LOADFLOW],
      });
    }
    case 'CAPACITY': {
      if (!subject) return ask('Which feeder?', 'Name it, for example “If a new crane is connected to Feeder F3, is there capacity?”.');
      const { path } = traceSupplyPath(network, subject.id);
      const transformer = path.find(id => network.assets.get(id)?.assetType === 'TRANSFORMER');
      const breaker = path.find(id => network.assets.get(id)?.assetType === 'CIRCUIT_BREAKER');
      const fed = consumersOf(subject.id);
      r.primaryAssetId = subject.id;
      r.targetAssetIds = [subject.id];
      r.relatedAssetIds = path.filter(id => id !== subject.id);
      r.paths = [pathOf(network, [...path, ...fed.slice(0, 1)])];
      r.feederIds = [subject.id];
      r.actions = [{ type: ACTION.SHOW_SUPPLY_PATH, assetIds: r.paths[0].assetIds }, { type: ACTION.SHOW_ENGINEERING_LIMITATION, assetIds: [subject.id] }];
      const t = network.assets.get(transformer);
      return say(`Capacity on ${subject.id} cannot be confirmed from the model`,
        `${subject.name} is supplied from ${list(path.slice(0, -1))}. The model has no ampacity for ${subject.id}, no measured loads and no data for the new crane, so whether ${subject.id} and ${transformer} have sufficient capacity cannot be calculated.`, {
          determinable: [`${subject.id}: ${fmt(subject.voltage?.primary) ?? 'voltage not recorded'}; ampacity not recorded; supplies ${list(fed)} (${nameplate(fed).toFixed(2)} MW nameplate).`,
            ...(breaker ? [`Protected by ${breaker}: ${fmt(network.assets.get(breaker).rating) ?? 'no rating'} continuous (no interrupting rating recorded).`] : []),
            ...(t ? [`Upstream ${transformer}: rated ${fmt(t.rating)}; also supplies ${list(consumersOf(transformer).filter(id => !fed.includes(id)))}.`] : [])],
          missingInputs: ['The new crane’s demand (kW/kVA), power factor, and starting / regenerative profile.', `${subject.id} conductor size and ampacity, and its route length.`,
            `Measured peak loads on ${subject.id} and ${transformer}.`, 'Demand and diversity factors for the existing cranes.'],
          limitations: [LOADFLOW],
        });
    }
    case 'VOLTAGE_DROP': {
      if (!subject) return ask('At which equipment?', 'Name it, for example “What is the voltage drop at Crane C4?”.');
      const { path } = traceSupplyPath(network, subject.id);
      const feeder = feedersOn(network, path)[0];
      r.primaryAssetId = subject.id;
      r.targetAssetIds = [subject.id];
      r.paths = [pathOf(network, path)];
      r.feederIds = feedersOn(network, path);
      r.actions = [{ type: ACTION.SHOW_SUPPLY_PATH, assetIds: path }, { type: ACTION.SHOW_ENGINEERING_LIMITATION, assetIds: [subject.id] }];
      const tx = path.find(id => network.assets.get(id)?.assetType === 'TRANSFORMER');
      return say(`Voltage drop at ${subject.id} cannot be calculated`, `The model knows the path to ${subject.name} (${path.join(' → ')}) and its nominal voltage, but none of the impedance, length or load data a voltage-drop calculation needs.`, {
        determinable: [`Supply path: ${path.join(' → ')}.`, `Nominal voltage on ${feeder}: ${fmt(network.assets.get(feeder)?.voltage?.primary) ?? 'not recorded'}.`, `${subject.id} nameplate: ${fmt(subject.rating) ?? 'not recorded'}.`],
        missingInputs: [`${feeder} conductor size, impedance (R and X per length) and route length — no cable route is recorded.`, `${subject.id} peak demand and power factor (and motor starting current).`, `Source impedance at ${tx} (transformer %Z and tap) and upstream.`],
        limitations: [LOADFLOW],
      });
    }
    case 'TRANSFER_OVERLOAD': {
      const [from, to] = parsed.named;
      const a = network.assets.get(from), b = network.assets.get(to);
      if (!a || !b) return missing(!a ? from : to);
      const loads = consumersOf(from);
      const transferable = loads.filter(id => findAlternativeSupplyPaths(network, id).some(p => p.transformers.includes(to)));
      r.targetAssetIds = [from, to];
      r.relatedAssetIds = loads;
      r.actions = [{ type: ACTION.HIGHLIGHT_ASSETS, assetIds: [from, to, ...loads] }, { type: ACTION.SHOW_ENGINEERING_LIMITATION, assetIds: [from, to] }];
      A.followUps = [{ label: `Simulate ${from} offline`, question: `What happens if ${a.name} goes offline?` }];
      r.resultGroups = [
        { key: 'loads', label: `${from}’s loads`, assetIds: loads, tone: 'focus' },
        { key: 'transfer', label: `Transferable to ${to} in the model`, assetIds: transferable, tone: transferable.length ? 'cond' : 'neutral' },
      ];
      const ownLoads = consumersOf(to);
      const [moved, kept] = [demandOf(network, transferable), demandOf(network, ownLoads)];
      if (transferable.length && Number.isFinite(b.capacityKw) && moved !== null && kept !== null) {
        const total = moved + kept, over = total > b.capacityKw;
        return say(over ? `Transferring ${from}’s loads would overload ${to}: ${mw(total)} on ${mw(b.capacityKw)}` : `${to} can carry ${from}’s transferable loads: ${mw(total)} of ${mw(b.capacityKw)}`,
          `${to} already supplies ${mw(kept)} of modelled demand; ${list(transferable)} add ${mw(moved)}, ${mw(total)} in all against ${to}’s ${mw(b.capacityKw)} usable capacity (${Math.round(total / b.capacityKw * 100)}%).${over ? ' Some load would have to be shed or left off.' : ''}`, {
            determinable: [`${to}’s own loads: ${mw(kept)}. Transferable from ${from}: ${mw(moved)}.`, `Transfer paths need the normally-open devices on them closed (see the alternate paths).`],
            missingInputs: [`Measured peak loads on ${from} and ${to}.`, 'A load-flow model to check loading and voltage after the transfer.'],
            limitations: [MODELLED_DEMAND, LOADFLOW],
          });
      }
      return say(transferable.length ? `${list(transferable)} could transfer to ${to}; overload cannot be assessed` : `No modelled path transfers ${from}’s loads to ${to}`,
        transferable.length ? `Some of ${from}’s loads have a modelled path to ${to}, but without load data an overload cannot be assessed.`
          : `In the model ${from}’s loads (${list(loads)}) have no connection to ${to}: there is no tie between the ${from} and ${to} branches. With ${from} offline they would lose power rather than transfer, so an overload of ${to} does not arise in the model.`, {
          determinable: [`${from} rated ${fmt(a.rating) ?? '—'}; ${to} rated ${fmt(b.rating) ?? '—'}.`, `${to} normally supplies ${list(consumersOf(to))}.`, `${from}’s loads: ${list(loads)} — ${nameplate(loads).toFixed(2)} MW nameplate (not a measured load).`],
          missingInputs: [`Confirmation of whether a tie exists between the ${from} and ${to} branches (none is modelled).`, `Measured peak loads on ${from} and ${to}.`, 'A load-flow model to check loading and voltage after the transfer.'],
          limitations: [LOADFLOW],
        });
    }
    case 'SHORT_CIRCUIT': {
      const breakers = [...network.assets.values()].filter(a => a.assetType === 'CIRCUIT_BREAKER');
      const gear = uniq(breakers.map(b => b.location?.containerAssetId).filter(Boolean));
      const withRating = breakers.filter(b => b.rating);
      const interrupting = breakers.filter(b => b.interruptingRating);
      const studied = breakers.filter(b => Number.isFinite(b.shortCircuit?.dutykA) && Number.isFinite(b.shortCircuit?.ratingkA) && b.shortCircuit.ratingkA > 0);
      const ratingLine = withRating.length ? `${withRating.length} of ${breakers.length} breakers have a continuous current rating (${uniq(withRating.map(b => fmt(b.rating))).join(', ')}).`
        : `None of the ${breakers.length} breakers has a continuous current rating recorded.`;
      if (studied.length) {
        // The model records a short-circuit screening per breaker: modelled duty against the rating
        // (the nameplate where there is one, else the rating the screening assumed). Nothing is invented.
        const kA = v => `${Number(v.toFixed(2))} kA`;
        const rows = studied.map(b => ({ b, sc: b.shortCircuit, pct: b.shortCircuit.dutykA / b.shortCircuit.ratingkA * 100 }))
          .sort((x, y) => y.pct - x.pct);
        const over = rows.filter(x => x.pct > 100);
        const close = rows.filter(x => x.pct > 80 && x.pct <= 100);
        const within = rows.filter(x => x.pct <= 80);
        const assumed = rows.filter(x => x.sc.ratingAssumed);
        const top = rows[0];
        const describe = x => `${x.b.id}: ${kA(x.sc.dutykA)} duty, ${Math.round(x.pct)}% of ${x.sc.ratingAssumed ? 'an assumed' : 'its'} ${kA(x.sc.ratingkA)} rating`;
        const statedOver = rows.filter(x => /exceed|over|fail/i.test(x.sc.statedResult ?? ''));
        const cases = uniq(rows.map(x => x.sc.governingCase).filter(Boolean));
        const basis = uniq(rows.map(x => x.sc.assumedBasis).filter(Boolean));
        const status = uniq(rows.map(x => x.sc.dataStatus).filter(Boolean));
        const noAsym = rows.filter(x => (x.sc.asymmetry ?? 1) <= 1 && (x.sc.xr ?? 0) > 0);
        r.targetAssetIds = (over.length ? over : close.length ? close : rows.slice(0, 3)).map(x => x.b.id);
        r.relatedAssetIds = rows.map(x => x.b.id);
        r.resultGroups = [
          { key: 'over', label: 'May exceed the interrupting rating', assetIds: over.map(x => x.b.id), tone: 'bad' },
          { key: 'close', label: 'Above 80% of the rating', assetIds: close.map(x => x.b.id), tone: 'warn' },
          { key: 'within', label: 'Within the rating', assetIds: within.map(x => x.b.id), tone: 'ok' },
        ].filter(g => g.assetIds.length);
        r.actions = [{ type: ACTION.HIGHLIGHT_ASSETS, assetIds: r.targetAssetIds }, { type: ACTION.SHOW_ENGINEERING_LIMITATION, assetIds: rows.map(x => x.b.id) }];
        const ratingWord = assumed.length === rows.length ? 'assumed ratings' : assumed.length ? 'their ratings (some assumed)' : 'their nameplate ratings';
        const title = over.length ? `${over.length === 1 ? `${over[0].b.id} may` : `${over.length} breakers may`} exceed ${over.length === 1 ? 'its' : 'their'} interrupting rating${over.length === 1 ? '' : 's'}`
          : `No breaker exceeds its interrupting rating in the modelled screening`;
        const summary = over.length
          ? `Under the modelled fault, ${list(over.map(describe))}.${close.length ? ` ${close.length} more ${close.length === 1 ? 'is' : 'are'} above 80%: ${list(close.map(x => x.b.id))}.` : ''}`
          : `All ${rows.length} breakers with a modelled fault duty stay within ${ratingWord}. The highest duty is ${describe(top)}${close.length ? `; ${close.length} ${close.length === 1 ? 'breaker is' : 'breakers are'} above 80% (${list(close.map(x => x.b.id))})` : ''}.`;
        return say(title, `${summary}${assumed.length ? ` ${assumed.length === rows.length ? 'No' : `${rows.length - assumed.length} of ${rows.length}`} breaker${assumed.length === rows.length ? ' has' : 's have'} a nameplate interrupting rating in the model, so the check is against an assumed rating${assumed.length === rows.length ? '' : ' for the rest'}: a breaker with a lower real rating could still be over.` : ''}`, {
          determinable: [
            `Highest modelled duties: ${rows.slice(0, 5).map(describe).join('; ')}.`,
            `${over.length} over 100%, ${close.length} between 80% and 100%, ${within.length} at or below 80% of the rating.`,
            ...(cases.length ? [`Governing case in the study: ${list(cases)}.`] : []),
            ...(statedOver.length !== over.length ? [`The model's own screening result flags ${statedOver.length}; computed from its duty and rating values here: ${over.length}.`] : []),
            ...(breakers.length > rows.length ? [`${breakers.length - rows.length} of ${breakers.length} breakers have no modelled fault duty: ${list(breakers.filter(b => !studied.includes(b)).map(b => b.id))}.`] : []),
            ratingLine,
          ],
          missingInputs: [
            ...(assumed.length ? [`Nameplate interrupting (kA sym) ratings for ${assumed.length === rows.length ? 'all breakers' : list(assumed.map(x => x.b.id))}${basis.length && top.sc.assumedBasis ? ` (the screening assumes a rating per breaker; for ${top.b.id}: ${top.sc.assumedBasis})` : ''}.`] : []),
            'Close-and-latch (momentary) ratings, which this screening does not check.',
            ...(noAsym.length ? [`Asymmetry: the duty is symmetrical (multiplier 1.0) although X/R at the fault reaches ${Math.max(...noAsym.map(x => x.sc.xr)).toFixed(1)}; a full check applies an X/R adjustment (IEEE C37.010 for medium-voltage, C37.13 for low-voltage breakers).`] : []),
            'A validated short-circuit study with the utility source impedance, transformer impedances and motor contribution confirmed from records.',
          ],
          limitations: [`From the model's short-circuit screening${status.length ? ` (${status.join('; ')})` : ''}, not an engineering study of record.`],
        });
      }
      r.targetAssetIds = breakers.map(b => b.id);
      r.relatedAssetIds = gear;
      r.resultGroups = gear.map(g => ({ key: g, label: nameOf(g), assetIds: breakers.filter(b => b.location?.containerAssetId === g).map(b => b.id), tone: 'neutral' }));
      r.actions = [{ type: ACTION.HIGHLIGHT_ASSETS, assetIds: gear.length ? gear : breakers.map(b => b.id) }, { type: ACTION.SHOW_ENGINEERING_LIMITATION, assetIds: breakers.map(b => b.id) }];
      return say('Interrupting duty cannot be assessed', `No modelled short-circuit conditions exist and ${interrupting.length ? 'only some' : 'none'} of the ${breakers.length} breakers has an interrupting rating, so no breaker can be checked against its interrupting duty. No fault currents are invented.`, {
        determinable: [ratingLine, `Interrupting (kA) rating recorded for ${interrupting.length} of ${breakers.length}.`, ...(gear.length ? [`Breakers sit in ${list(gear)}.`] : [])],
        missingInputs: ['Interrupting (kA symmetrical) and close-and-latch ratings for each breaker.', `Available fault current${gear.length ? ` at the ${list(gear)} buses` : ' at each breaker'} from a validated short-circuit study: utility source impedance, transformer impedances, motor contribution from the crane drives, and X/R ratios.`],
        limitations: [LOADFLOW],
      });
    }
    default:
      r.status = 'UNSUPPORTED';
      return say('This needs an engineering study', LOADFLOW);
  }
}

/** The result of a scenario: every count and name read from the computed comparison. */
function outageResult(r, network, state, { filter = null, scope = null, categories = [], subject = null, lead = null } = {}) {
  const res = state.result;
  const A = r.answer;
  const nameOf = id => network.assets.get(id)?.name ?? id;
  const names = ids => ids.map(nameOf);
  const typeOf = id => network.assets.get(id).assetType;
  const failed = [...state.scenario.offline, ...Object.entries(state.scenario.switches).filter(([, s]) => s === SWITCH.OPEN).map(([id]) => id)];
  r.visualization = { mode: 'OUTAGE', focus: 'IMPACT', animateEnergizedPaths: true };
  r.primaryAssetId = subject?.id ?? failed[0] ?? null;
  r.subject = subject?.id ?? r.subject;
  const equipment = res.deEnergized.filter(id => !CONSUMER_TYPES.has(typeOf(id)));
  const wanted = uniq(categories.map(categoryOf));
  const lost = filter === 'CRANE' ? res.consumersLost.filter(id => typeOf(id) === 'CRANE')
    : wanted.length ? res.consumersLost.filter(id => wanted.includes(categoryOf(typeOf(id)))) : res.consumersLost;
  r.targetAssetIds = filter === 'POWERED' ? res.consumersPowered : uniq([...failed, ...(scope === 'ALL' ? res.lost : lost)]);
  r.relatedAssetIds = uniq(failed.map(id => network.assets.get(id)?.parentAssetId).filter(Boolean));
  r.feederIds = feedersOn(network, [...failed, ...res.deEnergized]);
  r.resultIds = filter === 'POWERED' ? res.consumersPowered : lost;
  // Groups by requested category (zero counts kept: "no buildings" is an answer), else by effect.
  r.resultGroups = wanted.length && filter !== 'CRANE'
    ? wanted.map(c => {
      const ids = res.consumersLost.filter(id => categoryOf(typeOf(id)) === c);
      return { key: c, label: cap(label(c, ids.length)), assetIds: ids, tone: ids.length ? 'bad' : 'neutral', count: ids.length };
    })
    : [
      { key: 'lost', label: filter === 'CRANE' ? 'Cranes without power' : 'Without power', assetIds: filter === 'POWERED' ? [] : lost, tone: 'bad' },
      ...(filter !== 'CRANE' ? [{ key: 'equipment', label: 'De-energized equipment', assetIds: [...res.offline, ...equipment], tone: 'bad' }] : []),
      { key: 'rerouted', label: 'Supplied through an alternate path', assetIds: res.rerouted, tone: 'ok' },
      { key: 'uncertain', label: 'State unknown (undocumented connection)', assetIds: res.consumersUncertain, tone: 'warn' },
      { key: 'powered', label: filter === 'CRANE' ? 'Cranes still powered' : 'Still powered', assetIds: filter === 'CRANE' ? res.consumersPowered.filter(id => typeOf(id) === 'CRANE') : res.consumersPowered, tone: 'ok' },
    ].filter(g => g.assetIds.length || g.key === 'lost');
  const lines = [];
  if (filter === 'POWERED') lines.push(`Still powered: ${list(names(res.consumersPowered)) || 'nothing'}.`);
  else {
    if (lost.length) lines.push(`No power: ${list(names(lost))}.`);
    if (equipment.length) lines.push(`De-energized equipment: ${list(equipment)}.`);
    if (res.rerouted.length) lines.push(`Powered through an alternate path: ${list(names(res.rerouted))}.`);
    if (res.consumersUncertain.length) lines.push(`State unknown (undocumented connection): ${list(names(res.consumersUncertain))}.`);
    lines.push(`Still powered: ${res.consumersPowered.length} consumers${res.consumersPowered.length ? ` (${list(names(res.consumersPowered))})` : ''}.`);
  }
  const cranes = lost.filter(id => typeOf(id) === 'CRANE');
  const title = filter === 'CRANE' ? (cranes.length ? `${list(names(cranes))} ${cranes.length > 1 ? 'lose' : 'loses'} power` : 'No cranes lose power')
    : filter === 'POWERED' ? `${res.consumersPowered.length} consumer${res.consumersPowered.length === 1 ? '' : 's'} stay powered`
      : wanted.length ? `${state.label}: ${list(r.resultGroups.map(g => `${g.count} ${label(g.key, g.count)}`))} affected`
        : scope === 'ALL' ? `${state.label}: ${res.consumersLost.length} consumer${res.consumersLost.length === 1 ? '' : 's'}${equipment.length ? ` and ${equipment.length} items of equipment` : ''} ${res.consumersLost.length === 1 && !equipment.length ? 'loses' : 'lose'} power`
          : `${state.label}: ${res.consumersLost.length} consumer${res.consumersLost.length === 1 ? '' : 's'} without power`;
  const causes = uniq(res.consumersLost.flatMap(id => traceSupplyPath(network, id).path.filter(x => failed.includes(x))));
  const rerouted = res.rerouted.length ? `${list(names(res.rerouted))} ${res.rerouted.length > 1 ? 'are' : 'is'} supplied through an alternate path in this scenario. ` : '';
  const why = res.consumersLost.length
    ? `${rerouted}${list(names(res.consumersLost))} ${res.consumersLost.length > 1 ? 'are' : 'is'} normally supplied through ${list(causes.map(nameOf)) || 'the failed equipment'}, and no energized alternative supply path reaches ${res.rerouted.length ? list(names(res.consumersLost)) : res.consumersLost.length > 1 ? 'them' : 'it'} in this scenario (normally-open ties stay open unless the scenario closes them).`
    : `${rerouted}Every consumer still has an energized supply path.`;
  A.title = title;
  A.summary = `${lead ? `${lead} ` : ''}${filter === 'CRANE' && !cranes.length && res.consumersLost.length ? `It interrupts ${list(names(res.consumersLost))}, but no crane. ` : ''}${filter === 'POWERED' ? `With ${state.label.toLowerCase()}, these stay energized.` : why}`;
  A.lines = lines;
  A.limitations = [SIMULATED, CONNECTIVITY_ONLY];
  r.scenario = state;
  return r;
}

/** Fill the derived fields: states of what the result is about, camera targets, provenance, ids. */
function finalize(r, { network, session, associations, inspections }) {
  const nodes = nodesNow(network, session);
  const about = uniq([...r.targetAssetIds, ...r.paths.flatMap(p => p.assetIds), ...r.conditionalAssetIds, ...r.relatedAssetIds]).filter(id => network.assets.has(id));
  r.energizedAssetIds = about.filter(id => nodes.get(id) === STATE.ENERGIZED);
  r.deenergizedAssetIds = about.filter(id => [STATE.DE_ENERGIZED, STATE.OFFLINE].includes(nodes.get(id)));
  r.unknownAssetIds = about.filter(id => nodes.get(id) === STATE.UNKNOWN);
  r.pathAssetIds = r.paths[0]?.assetIds ?? [];
  r.pathEdgeIds = uniq(r.paths.flatMap(p => p.edgeIds));
  if (session?.state().active) { r.scenario = session.state(); r.scenarioId = r.scenario.label; }
  if (!r.cameraTargetAssetIds.length) {
    const sc = r.scenario?.result;
    const pool = r.visualization.mode === 'OUTAGE' && sc
      ? [...r.relatedAssetIds, ...r.targetAssetIds, ...sc.lost, ...sc.rerouted, ...r.paths.flatMap(p => p.assetIds)]
      : [...r.targetAssetIds, ...r.paths.flatMap(p => p.assetIds), ...(r.downstream ? [r.downstream.rootId, ...r.downstream.normal, ...r.downstream.conditional] : []),
        ...r.conditionalAssetIds, ...(r.targetAssetIds.length ? [] : r.relatedAssetIds), ...r.contextAssetIds];
    r.cameraTargetAssetIds = uniq(pool.flatMap(id => anchorsOf(network, id)));
  }
  r.provenance = answerProvenance(about.map(id => network.assets.get(id)), { associations, records: inspections });
  if (!r.resultIds.length) r.resultIds = r.targetAssetIds;
  return r;
}

/** Run one question end to end: parse with context, answer, finalize, and the updated context. */
export function ask(question, { network, session, inspections = [], associations = [], context = {}, today = new Date() }) {
  const parsed = parseQuestion(question, network, context);
  const deps = { network, session, inspections, associations, today, question };
  if (parsed.intent === INTENT.HIGHLIGHT) {
    const pool = context.lastResultIds ?? [];
    const ids = parsed.filterType ? pool.filter(id => network.assets.get(id)?.assetType === parsed.filterType) : pool;
    const r = emptyResult(INTENT.HIGHLIGHT, question);
    r.targetAssetIds = ids;
    r.visualization = { mode: session.state().active ? 'OUTAGE' : 'GROUP', focus: 'GROUP', animateEnergizedPaths: true };
    r.resultGroups = [{ key: 'highlighted', label: 'Highlighted', assetIds: ids, tone: 'focus' }];
    r.actions = [{ type: ACTION.HIGHLIGHT_ASSETS, assetIds: ids }];
    r.answer.title = `Highlighted ${ids.length} ${parsed.filterType ? label(parsed.filterType, ids.length) : 'assets'}`;
    r.answer.summary = list(ids.map(id => network.assets.get(id)?.name ?? id)) || 'Nothing to highlight from the last answer.';
    if (!ids.length) r.status = 'NO_RESULTS';
    const answer = finalize(r, deps);
    return { parsed, answer, context: { ...context, lastResultIds: ids } };
  }
  // A baseline question never draws over a simulated state: the simulation is cleared, and said to be.
  const cleared = !SCENARIO_INTENTS.has(parsed.intent) && session?.state().active;
  if (cleared) session.reset();
  const answer = finalize(answerQuestion(parsed, deps), deps);
  if (cleared) answer.answer.lines.push('The simulated outage was cleared to answer this from the baseline network.');
  const next = {
    ...context,
    lastIntent: [INTENT.UNKNOWN, INTENT.RESET, INTENT.SWITCH].includes(parsed.intent) ? context.lastIntent : parsed.intent,
    lastFilter: parsed.filter ?? null,
    lastSubject: answer.subject ?? parsed.subject ?? context.lastSubject ?? null,
    lastResultIds: answer.resultIds?.length ? answer.resultIds : context.lastResultIds ?? [],
  };
  return { parsed, answer, context: next };
}

/**
 * The asset panel's actions (View Connections, Trace Upstream / Downstream, Highlight Connected
 * Loads, Simulate Outage) as results in the same contract, so they draw exactly like a question.
 */
export function investigate(kind, assetId, deps) {
  const a = deps.network.assets.get(assetId);
  const n = a?.name ?? assetId;
  const intent = { CONNECTIONS: INTENT.CONNECTIONS, UPSTREAM: INTENT.PATH, DOWNSTREAM: INTENT.DOWNSTREAM, LOADS: INTENT.CONSUMERS, OUTAGE: INTENT.OUTAGE }[kind];
  const question = { CONNECTIONS: `Connections of ${n}`, UPSTREAM: `Trace upstream from ${n}`, DOWNSTREAM: `Trace downstream from ${n}`,
    LOADS: `Loads connected to ${n}`, OUTAGE: `Simulate ${a?.assetType === 'FEEDER' ? 'disconnecting' : 'an outage of'} ${n}` }[kind];
  const parsed = { intent, subject: assetId, named: [assetId], type: null, types: [], typeFilter: null, categories: [] };
  const full = { inspections: [], associations: [], today: new Date(), ...deps, question };
  if (!SCENARIO_INTENTS.has(intent) && deps.session?.state().active) deps.session.reset();
  return finalize(answerQuestion(parsed, full), full);
}

const ID_FIELDS = ['primaryAssetId', 'targetAssetIds', 'relatedAssetIds', 'contextAssetIds', 'conditionalAssetIds', 'feederIds', 'cameraTargetAssetIds'];

/**
 * Keep only map actions that refer to assets and connections in the inventory, with paths that
 * actually run along recorded edges; drop the rest with a reason. The page runs nothing it has not
 * validated.
 */
export function validateActions(actions, network) {
  const ok = [], dropped = [];
  const edgeIds = new Set(network.edges.map(e => e.id));
  for (const a of actions ?? []) {
    const ids = [...(a.assetIds ?? []), ...(a.assetId ? [a.assetId] : []), ...(a.rootId ? [a.rootId] : []), ...(a.conditionalIds ?? [])];
    const unknown = ids.filter(id => !network.assets.has(id));
    if (unknown.length) { dropped.push({ action: a, reason: `unknown asset ${unknown.join(', ')}` }); continue; }
    const badEdges = (a.edgeIds ?? []).filter(id => !edgeIds.has(id));
    if (badEdges.length) { dropped.push({ action: a, reason: `unknown connection ${badEdges.join(', ')}` }); continue; }
    if ([ACTION.SHOW_SUPPLY_PATH, ACTION.SHOW_ALTERNATIVE_PATH].includes(a.type) && a.assetIds.length > 1 && pathEdges(network, a.assetIds).length !== a.assetIds.length - 1) {
      dropped.push({ action: a, reason: 'path does not follow recorded connections' }); continue;
    }
    ok.push(a);
  }
  return { ok, dropped };
}

/**
 * The whole result, validated: unknown asset ids and paths that do not follow recorded edges are
 * removed (and reported), so nothing unresolved can be drawn or left highlighted.
 */
export function validateResult(result, network) {
  const dropped = [];
  const keep = id => { const ok = network.assets.has(id); if (!ok) dropped.push(id); return ok; };
  const out = { ...result };
  for (const f of ID_FIELDS) out[f] = Array.isArray(result[f]) ? result[f].filter(keep) : result[f] && keep(result[f]) ? result[f] : null;
  out.paths = (result.paths ?? []).filter(p => p.assetIds.every(keep) && (p.assetIds.length < 2 || pathEdges(network, p.assetIds).length === p.assetIds.length - 1));
  out.downstream = result.downstream && keep(result.downstream.rootId)
    ? { rootId: result.downstream.rootId, normal: result.downstream.normal.filter(keep), conditional: result.downstream.conditional.filter(keep) } : null;
  out.resultGroups = (result.resultGroups ?? []).map(g => ({ ...g, assetIds: g.assetIds.filter(keep) }));
  const actions = validateActions(result.actions, network);
  out.actions = actions.ok;
  return { result: out, dropped: [...new Set(dropped)], droppedActions: actions.dropped };
}
