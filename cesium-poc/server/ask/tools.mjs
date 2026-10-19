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
import { haversineMeters } from '../geo.mjs';
import { MAX_LIMIT, OPERATORS, originOf } from './twinStore.mjs';

const MAX_STRING = 300;
const EVENT_TYPES = ['INCIDENT', 'CLOSURE', 'CONSTRUCTION', 'CONGESTION', 'DISABLED'];
/** Weather only near the corridor, so the tool is not a general weather proxy. */
const WEATHER_BOX = { minLat: 25, maxLat: 27.5, minLon: -81.5, maxLon: -79.5 };

/** records_near: the largest radius, and how many anchor features a place may resolve to. */
const MAX_NEAR_M = 3_000;
const MAX_ANCHORS = 40;

const FILTERS_SCHEMA = {
  type: 'array', maxItems: 5,
  items: {
    type: 'object', required: ['field', 'operator', 'value'],
    properties: { field: { type: 'string', description: "A field name exactly as describe_store lists it, 'key', or 'date' (the class's indexed date, for before/after)" },
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
    description: 'Matching records of one class, newest first or oldest first (order: "oldest" for first-in-first-out), e.g. open work orders for cameras. Filters: equals / not_equals (case-insensitive), contains, before / after (dates, e.g. field "date"). Returns totalCount and up to `limit` records.',
    input_schema: {
      type: 'object', required: ['class_name'],
      properties: { class_name: { type: 'string' }, filters: FILTERS_SCHEMA, order: { type: 'string', enum: ['newest', 'oldest'] },
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
    name: 'records_near',
    description: 'Records of one class within a radius of a point or of a named place (e.g. every ramp whose text matches "Turnpike" in the ramps layer), with the total, optional groups and the nearest records. Use this for any question about a place — an interchange, road, bridge or camera — instead of the coarse Segment field.',
    input_schema: {
      type: 'object', required: ['class_name'],
      properties: { class_name: { type: 'string' },
        place: { type: 'object', required: ['layer', 'text'], properties: { layer: { type: 'string', enum: [...ASK_LAYER_FILES] }, text: { type: 'string' } } },
        near: { type: 'object', required: ['lon', 'lat'], properties: { lon: { type: 'number' }, lat: { type: 'number' } } },
        radius_m: { type: 'number', minimum: 50, maximum: MAX_NEAR_M, description: 'Default 500' },
        group_by: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } },
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
const classSource = result => {
  const origin = originOf(result.source);
  if (origin === 'synthetic') return `SYNTHETIC demo data · ${result.className}`;
  if (origin === 'imported') return `Imported file · ${result.className}`;
  return `DataConnect · ${result.className}${origin === 'snapshot' ? ' (snapshot)' : ''}`;
};

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
    describe_store({ class_name } = {}, { scope = null } = {}) {
      const classes = store.classes().filter(c => !scope || scope.allowsClass(c.className));
      if (!classes.length) return { output: { gap: { type: 'not_ready', detail: 'The twin store has not been built yet.' } }, source: null };
      if (!class_name) {
        return { output: { classes: classes.map(({ className, rowCount, asOf, source }) => ({ className, origin: originOf(source), rowCount, asOf })),
          ...(scope && !scope.all ? { toggledOff: scope.excluded } : {}) }, source: 'Twin store' };
      }
      const entry = sourceOf(class_name);
      if (!entry) return { output: { gap: { type: 'not_ready', className: class_name, detail: `Unknown class. Classes: ${classes.map(c => c.className).join(', ')}.` } }, source: null };
      const guide = DATA_GUIDE.dataConnectClasses[entry.className] ?? {};
      return { output: { ...entry, origin: originOf(entry.source), purpose: guide.purpose ?? null, notes: guide.notes ?? null }, source: classSource(entry) };
    },

    query_records({ class_name, filters = [], fields, limit, order } = {}) {
      const result = store.query(class_name, { filters, fields, limit: limitOf(limit, MAX_LIMIT), order });
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

    async records_near({ class_name, place, near, radius_m, group_by, limit } = {}) {
      const radius = Math.min(MAX_NEAR_M, Math.max(50, Number(radius_m) || 500));
      let anchors = [], anchorLabel = null;
      if (place?.layer && String(place.text ?? '').trim()) {
        const found = JSON.parse(await layerTools.run('find_corridor_features', { layer: place.layer, text: place.text, limit: MAX_ANCHORS }));
        if (found.error) return { output: { error: found.error }, source: null };
        anchors = (found.features ?? []).filter(f => Number.isFinite(f.lon) && Number.isFinite(f.lat)).map(f => ({ lon: f.lon, lat: f.lat }));
        anchorLabel = `${anchors.length} feature(s) in ${place.layer} matching "${place.text}"${found.total > anchors.length ? ` (first ${anchors.length} of ${found.total})` : ''}`;
        if (!anchors.length) return { output: { error: `No feature in ${place.layer} matches "${place.text}". Try another layer or a shorter text.` }, source: null };
      } else if (Number.isFinite(Number(near?.lon)) && Number.isFinite(Number(near?.lat))) {
        anchors = [{ lon: Number(near.lon), lat: Number(near.lat) }];
        anchorLabel = `point ${anchors[0].lon}, ${anchors[0].lat}`;
      } else {
        return { output: { error: 'Give place {layer, text} or near {lon, lat}.' }, source: null };
      }
      const result = store.rows(class_name);
      if (result.gap) return { output: result, source: null };
      const fields = sourceOf(result.className)?.fields ?? [];
      if (group_by && !fields.includes(group_by)) return { output: { error: `'${group_by}' is not a field of ${result.className}. Fields: ${fields.join(', ')}` }, source: null };
      let unplaced = 0;
      const hits = [];
      for (const record of result.records) {
        if (!Number.isFinite(record._lon) || !Number.isFinite(record._lat) || record._lon === null) { unplaced++; continue; }
        let best = Infinity;
        for (const a of anchors) best = Math.min(best, haversineMeters(a.lon, a.lat, record._lon, record._lat));
        if (best <= radius) hits.push({ record, distance: Math.round(best) });
      }
      hits.sort((a, b) => a.distance - b.distance);
      const groups = new Map();
      if (group_by) for (const { record } of hits) { const v = record[group_by] ?? '(none)'; groups.set(v, (groups.get(v) ?? 0) + 1); }
      const strip = ({ _lon, _lat, _segment, _at, ...rest }) => Object.fromEntries(Object.entries({ ...rest, lon: _lon, lat: _lat }).map(([k, v]) => [k, clip(v)]));
      return {
        output: {
          className: result.className, asOf: result.asOf, anchor: anchorLabel, anchorPoint: anchors[0], radius_m: radius,
          totalCount: hits.length, ...(group_by ? { groupBy: group_by, groups: [...groups].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([value, count]) => ({ value, count })) } : {}),
          nearest: hits.slice(0, limitOf(limit, 20)).map(({ record, distance }) => ({ distance_m: distance, ...strip(record) })),
          ...(unplaced ? { gaps: [`${unplaced} of ${result.records.length} ${result.className} records have no coordinates and could not be placed.`] } : {}),
          ...(result.truncated ? { truncated: true } : {}),
        },
        source: classSource({ ...result, source: sourceOf(result.className)?.source }),
        summary: `${hits.length} within ${radius} m`,
      };
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
    async run(name, input, { scope = null } = {}) {
      const handler = Object.hasOwn(handlers, name) ? handlers[name] : null;
      let result;
      try {
        // A source the user toggled off is refused here, the one place every lookup passes through.
        const refused = handler && scope ? scope.refusal(name, input ?? {}) : null;
        result = refused ? { output: refused, source: null }
          : handler ? await handler(input ?? {}, { scope }) : { output: { error: `Unknown tool '${name}'.` }, source: null };
      } catch (error) {
        result = { output: { error: String(error?.message ?? error).slice(0, 300) }, source: null };
      }
      return { ...result, text: fitResult(result.output) };
    },
  };
}
