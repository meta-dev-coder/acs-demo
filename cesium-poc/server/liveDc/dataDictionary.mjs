/**
 * The data dictionary Ask the Twin reasons with: every DataConnect class the app reads (live and
 * historical) with its full attribute list, the live chain, the corridor GeoJSON layers with their
 * properties and counts, the workflow and scoring rules. Built from the same config the code runs on,
 * plus config/askTwin/dataGuide.json for what each source means, so it cannot drift from the code.
 * The release writes it to data/data-dictionary.json; a missing file is rebuilt from public/data.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HISTORICAL_CLASSES, liveClassDefinitions } from './classes.mjs';
import { enrichmentDataPath } from './eventEnrichment.mjs';
import DATA_GUIDE from '../../config/askTwin/dataGuide.json' with { type: 'json' };
import WORKFLOW from '../../config/liveDc/workflow.json' with { type: 'json' };
import EVENT_FIELDS from '../../config/liveDc/eventFields.json' with { type: 'json' };
import SCORING from '../../src/scoringConfig.json' with { type: 'json' };

export const DICTIONARY_FILE = 'data-dictionary.json';
/** Corridor layers Ask the Twin can search; the release copies them next to the dictionary. */
export const ASK_LAYER_FILES = Object.freeze([
  'i595_corridor_cameras.geojson', 'i595_corridor_traffic_signals.geojson', 'i595_bridges.geojson',
  'i595_express_gantries.geojson', 'i595_fdot_traffic_segments.geojson', 'i595_ramps_connectors_classified.geojson',
]);
const MAX_LAYER_PROPERTIES = 60;

const attributeOf = spec => {
  if (typeof spec === 'string') return { name: spec };
  const out = { name: spec.name, type: spec.type ?? 'String' };
  const text = String(spec.description ?? '').trim();
  if (text && text !== spec.name && text !== spec.displayName) out.description = text;
  return out;
};

function classEntry(doc, className, kind, attributes, extra = {}) {
  const guide = doc.dataConnectClasses[className];
  if (!guide) throw new Error(`dataGuide.json has no entry for DataConnect class '${className}'`);
  return { className, kind, ...extra, purpose: guide.purpose, keyFields: guide.keyFields ?? [], ...(guide.links ? { links: guide.links } : {}),
    ...(guide.notes ? { notes: guide.notes } : {}), attributes: attributes.map(attributeOf) };
}

function layerEntry(doc, file, json) {
  const description = doc.corridorLayers[file];
  if (!description) throw new Error(`dataGuide.json has no entry for corridor layer '${file}'`);
  const features = Array.isArray(json?.features) ? json.features : Array.isArray(json) ? json : [];
  const names = new Set();
  for (const feature of features) for (const key of Object.keys(feature?.properties ?? feature ?? {})) names.add(key);
  const properties = [...names].filter(n => n !== 'geometry').slice(0, MAX_LAYER_PROPERTIES);
  return { file, description, featureCount: features.length, properties };
}

/**
 * @param {{readLayer?: (file:string)=>object|null, generatedAt?: string, doc?: object}} options
 */
export function buildDataDictionary({ readLayer = defaultReadLayer, generatedAt = new Date().toISOString(), doc = DATA_GUIDE } = {}) {
  const live = liveClassDefinitions().map(def => classEntry(doc, def.className, 'live', def.attributes));
  const historical = HISTORICAL_CLASSES.map(c => classEntry(doc, c.className, 'historical', c.attributes, { id: c.id }));
  const layers = ASK_LAYER_FILES.map(file => layerEntry(doc, file, readLayer(file)));
  return {
    generatedAt,
    overview: doc.overview,
    workspaces: doc.workspaces,
    dataConnect: { live, historical },
    chain: doc.chain,
    workflow: {
      timeZone: WORKFLOW.timeZone,
      defaultProfile: WORKFLOW.defaultProfile,
      profiles: WORKFLOW.profiles,
      tasksByEventType: WORKFLOW.tasks,
      damageSubtypes: (WORKFLOW.subtypes ?? []).map(s => ({ id: s.id, label: s.label, keywords: s.keywords, assetCategories: s.categories })),
    },
    eventTypes: EVENT_FIELDS.typeLabels ?? {},
    corridorLayers: layers,
    scoring: { summary: doc.scoring, weights: SCORING.weights, bands: SCORING.bands, recommendedActions: SCORING.recommendedActions },
    limits: doc.limits,
  };
}

function defaultReadLayer(file) {
  const path = enrichmentDataPath(file);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** The release's data/data-dictionary.json when present (EC2), else built from the repo (dev, tests). */
export function loadDataDictionary({ dataDir = process.env.LIVE_DC_DATA_DIR } = {}) {
  const file = dataDir ? join(dataDir, DICTIONARY_FILE) : null;
  if (file && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  return buildDataDictionary();
}

/** Short enough for every system prompt: what exists and where; details come from describe_data. */
export function dictionarySummary(dictionary) {
  const cls = c => `- ${c.className}: ${c.purpose}`;
  const layer = l => `- ${l.file} (${l.featureCount}): ${l.description}`;
  return [
    'DATA YOU CAN READ (use the tools; describe_data gives every attribute):',
    dictionary.overview,
    'Live DataConnect classes:', ...dictionary.dataConnect.live.map(cls),
    'Historical DataConnect classes:', ...dictionary.dataConnect.historical.map(cls),
    `Live chain: ${dictionary.chain}`,
    'Corridor layers (find_corridor_features):', ...dictionary.corridorLayers.map(layer),
    `Workspaces: ${Object.entries(dictionary.workspaces).map(([k, v]) => `${k} - ${v}`).join(' ')}`,
    `Scoring: ${dictionary.scoring.summary}`,
    dictionary.limits,
  ].join('\n');
}

/** One part of the dictionary for the describe_data tool: a class, a layer, or a named section. */
export function describeData(dictionary, topic) {
  const wanted = String(topic ?? '').trim().toLowerCase();
  const classes = [...dictionary.dataConnect.live, ...dictionary.dataConnect.historical];
  if (!wanted) {
    return { topics: [...classes.map(c => c.className), ...dictionary.corridorLayers.map(l => l.file), 'chain', 'workflow', 'eventTypes', 'scoring', 'workspaces'] };
  }
  const exact = classes.find(c => c.className.toLowerCase() === wanted) ?? dictionary.corridorLayers.find(l => l.file.toLowerCase() === wanted);
  if (exact) return exact;
  if (Object.hasOwn(dictionary, topic)) return { [topic]: dictionary[topic] };
  const section = Object.keys(dictionary).find(k => k.toLowerCase() === wanted);
  if (section) return { [section]: dictionary[section] };
  const loose = classes.filter(c => c.className.toLowerCase().includes(wanted))
    .concat(dictionary.corridorLayers.filter(l => l.file.toLowerCase().includes(wanted)));
  if (loose.length === 1) return loose[0];
  if (loose.length > 1) return { matches: loose.map(x => x.className ?? x.file) };
  return { error: `No topic '${topic}'. Call describe_data with no topic for the list.` };
}
