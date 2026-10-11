/**
 * The read-only tools the Ask the Twin orchestrator offers the model, and where each answer came from.
 *
 * Every tool returns `{output, source}`: `output` is what the model reads, `source` is the silo it
 * came from, set here by code. The answer's source chips are built from these, never from what the
 * model says it used. A tool that cannot answer returns a typed `{gap}` (not loaded, stale) or
 * `{error}` (bad input) — never an empty list that would read as "none".
 *
 * Inputs are checked against the store's own field lists; there is no write path, no free-form SQL
 * and no free-form URL.
 */
import DATA_GUIDE from '../../config/askTwin/dataGuide.json' with { type: 'json' };
import { createAskTools, fitResult } from '../liveDc/askTools.mjs';
import { ASK_LAYER_FILES } from '../liveDc/dataDictionary.mjs';
import { MAX_LIMIT, OPERATORS } from './twinStore.mjs';

const MAX_STRING = 300;
const EVENT_TYPES = ['INCIDENT', 'CLOSURE', 'CONSTRUCTION', 'CONGESTION', 'DISABLED'];
/** Weather only near the corridor, so the tool is not a general weather proxy. */
const WEATHER_BOX = { minLat: 25, maxLat: 27.5, minLon: -81.5, maxLon: -79.5 };

const FILTERS_SCHEMA = {
  type: 'array', maxItems: 5,
  items: {
    type: 'object', required: ['field', 'operator', 'value'],
    properties: { field: { type: 'string', description: "A field name exactly as describe_store lists it, or 'key'" },
      operator: { type: 'string', enum: [...OPERATORS] }, value: { type: 'string' } },
  },
};

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'describe_store',
    description: 'The records the twin holds: every class with its row count, load time and field names. With class_name, that class\'s fields and what it means. Call this before filtering when unsure of a field name.',
    input_schema: { type: 'object', properties: { class_name: { type: 'string' } } },
  },
  {
    name: 'query_records',
    description: 'Matching records of one class (newest first), e.g. work orders for an asset or incidents on a segment. Returns totalCount and up to `limit` records.',
    input_schema: {
      type: 'object', required: ['class_name'],
      properties: { class_name: { type: 'string' }, filters: FILTERS_SCHEMA,
        fields: { type: 'array', items: { type: 'string' }, description: 'Fields to return (default all)' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT } },
    },
  },
  {
    name: 'count_records',
    description: 'How many records of one class match, optionally grouped by a field (largest groups first). Use this for every "how many" or "which most" question instead of counting listed records.',
    input_schema: {
      type: 'object', required: ['class_name'],
      properties: { class_name: { type: 'string' }, filters: FILTERS_SCHEMA, group_by: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 25 } },
    },
  },
  {
    name: 'list_live_events',
    description: 'FL511 events on I-595 right now (incidents, closures, construction, congestion, disabled vehicles), with id, place and coordinates.',
    input_schema: { type: 'object', properties: { type: { type: 'string', enum: EVENT_TYPES }, limit: { type: 'integer', minimum: 1, maximum: 25 } } },
  },
  {
    name: 'find_corridor_features',
    description: 'Search a corridor layer (cameras, signals, bridges, express gantries, FDOT traffic segments, ramps) by text and/or distance from a point. Returns each feature with lon/lat — use these coordinates for map actions.',
    input_schema: {
      type: 'object', required: ['layer'],
      properties: { layer: { type: 'string', enum: [...ASK_LAYER_FILES] }, text: { type: 'string' },
        near: { type: 'object', required: ['lon', 'lat'], properties: { lon: { type: 'number' }, lat: { type: 'number' }, radius_m: { type: 'number', maximum: 10_000 } } },
        limit: { type: 'integer', minimum: 1, maximum: 20 } },
    },
  },
  {
    name: 'get_weather',
    description: 'Current weather (Open-Meteo) at a point on or near the corridor.',
    input_schema: { type: 'object', required: ['lon', 'lat'], properties: { lon: { type: 'number' }, lat: { type: 'number' } } },
  },
]);

const clip = value => (typeof value === 'string' && value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value);
const limitOf = (value, max, fallback = 10) => Math.min(max, Math.max(1, Number.parseInt(value ?? fallback, 10) || fallback));
const classSource = result => `DataConnect · ${result.className}${result.source?.startsWith('snapshot:') ? ' (snapshot)' : ''}`;

const compactEvent = e => ({
  id: e.id, type: e.type, title: clip(e.title), description: clip(e.description),
  near: e.nearestFacilityLabel || e.nearestSegmentLabel || null, lon: e.longitude, lat: e.latitude, start: e.startTime ?? null,
});

/**
 * @param {{store: ReturnType<import('./twinStore.mjs').openTwinStore>, getLiveEvents?: () => Promise<object|null>,
 *   readLayer?: (file: string) => object|null, fetchWeather?: (point: {latitude: number, longitude: number}) => Promise<object|null>,
 *   insights?: {definitions: object[], handlers: object}|null}} deps
 *   `insights` adds the computed tools (insights.mjs) beside the read tools.
 */
export function createTools({ store, getLiveEvents = null, readLayer = null, fetchWeather = null, insights = null }) {
  // The corridor-layer search is shared with the EC2 tools, not copied.
  const layerTools = createAskTools({ dictionary: { dataConnect: { live: [], historical: [] } }, readLayer });
  const sourceOf = className => store.classes().find(c => c.className.toLowerCase() === String(className ?? '').toLowerCase());

  const handlers = {
    describe_store({ class_name } = {}) {
      const classes = store.classes();
      if (!classes.length) return { output: { gap: { type: 'not_ready', detail: 'The twin store has not been built yet.' } }, source: null };
      if (!class_name) {
        return { output: { classes: classes.map(({ className, rowCount, asOf }) => ({ className, rowCount, asOf })) }, source: 'Twin store' };
      }
      const entry = sourceOf(class_name);
      if (!entry) return { output: { gap: { type: 'not_ready', className: class_name, detail: `Unknown class. Classes: ${classes.map(c => c.className).join(', ')}.` } }, source: null };
      const guide = DATA_GUIDE.dataConnectClasses[entry.className] ?? {};
      return { output: { ...entry, purpose: guide.purpose ?? null, notes: guide.notes ?? null }, source: classSource(entry) };
    },

    query_records({ class_name, filters = [], fields, limit } = {}) {
      const result = store.query(class_name, { filters, fields, limit: limitOf(limit, MAX_LIMIT) });
      if (result.gap) return { output: result, source: null };
      return { output: { ...result, records: result.records.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clip(v)]))) },
        source: classSource({ ...result, source: sourceOf(result.className)?.source }) };
    },

    count_records({ class_name, filters = [], group_by, limit } = {}) {
      const result = store.count(class_name, { filters, groupBy: group_by || null, limit: limitOf(limit, 25) });
      if (result.gap) return { output: result, source: null };
      return { output: result, source: classSource({ ...result, source: sourceOf(result.className)?.source }) };
    },

    async list_live_events({ type, limit } = {}) {
      if (!getLiveEvents) return { output: { gap: { type: 'not_ready', detail: 'Live events are not connected on this host.' } }, source: null };
      const payload = await getLiveEvents();
      if (!payload) return { output: { gap: { type: 'not_ready', detail: 'The live feed could not be read just now.' } }, source: null };
      const events = (payload.events ?? []).filter(e => !type || e.type === type);
      return { output: { asOf: payload.lastUpdated ?? null, total: events.length, events: events.slice(0, limitOf(limit, 25)).map(compactEvent) },
        source: payload.source === 'DataConnect' ? 'DataConnect · Live Events' : 'FL511 live events' };
    },

    async find_corridor_features(input = {}) {
      const output = JSON.parse(await layerTools.run('find_corridor_features', input));
      return { output, source: output.error ? null : `Corridor layer · ${input.layer}` };
    },

    async get_weather({ lon, lat } = {}) {
      if (!fetchWeather) return { output: { gap: { type: 'not_ready', detail: 'Weather is not connected on this host.' } }, source: null };
      const x = Number(lon), y = Number(lat);
      if (!(y >= WEATHER_BOX.minLat && y <= WEATHER_BOX.maxLat && x >= WEATHER_BOX.minLon && x <= WEATHER_BOX.maxLon)) {
        return { output: { error: 'Weather is only available for points in South Florida.' }, source: null };
      }
      const weather = await fetchWeather({ latitude: y, longitude: x });
      return weather ? { output: weather, source: 'Open-Meteo' } : { output: { gap: { type: 'not_ready', detail: 'The weather service did not answer.' } }, source: null };
    },
  };

  if (insights) Object.assign(handlers, insights.handlers);
  const definitions = insights ? [...TOOL_DEFINITIONS, ...insights.definitions] : TOOL_DEFINITIONS;

  return {
    definitions,
    /**
     * Run one tool. Never throws: bad input becomes `{error}` the model can correct.
     * @returns {Promise<{text: string, output: object, source: string|null, summary?: string}>}
     */
    async run(name, input) {
      const handler = Object.hasOwn(handlers, name) ? handlers[name] : null;
      let result;
      try {
        result = handler ? await handler(input ?? {}) : { output: { error: `Unknown tool '${name}'.` }, source: null };
      } catch (error) {
        result = { output: { error: String(error?.message ?? error).slice(0, 300) }, source: null };
      }
      return { ...result, text: fitResult(result.output) };
    },
  };
}
