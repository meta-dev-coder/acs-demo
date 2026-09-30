/**
 * Read-only tools Ask the Twin may call: the data dictionary, live events, a live event's response
 * chain, filtered reads of any DataConnect class in the dictionary, the corridor GeoJSON layers and the
 * current weather. Every input is validated against the dictionary; there is no write path and no
 * free-form URL. Results are trimmed so one call cannot flood the model's context.
 */
import { haversineMeters } from '../geo.mjs';
import { describeData, ASK_LAYER_FILES } from './dataDictionary.mjs';
import { EVENT_WINDOWS } from './liveEventsFromDc.mjs';
import { LIVE_CLASS } from './classes.mjs';

const MAX_RESULT_CHARS = 12_000;
const MAX_LIMIT = 25;
const MAX_STRING = 300;
const OPERATORS = new Set(['equals', 'contains']);
const CHAIN_CLASSES = ['TICKETS', 'TASKS', 'WORK_ORDERS', 'INSPECTIONS', 'ASSET_STATUS'];
/** Weather only for points in South Florida, so the tool cannot be used as a general weather proxy. */
const WEATHER_BOX = { minLat: 25, maxLat: 27.5, minLon: -81.5, maxLon: -79.5 };

export const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'describe_data',
    description: 'The data dictionary: every attribute of a DataConnect class or corridor layer, or a section (chain, workflow, eventTypes, scoring, workspaces). No topic lists the topics.',
    input_schema: { type: 'object', properties: { topic: { type: 'string', description: 'Class name, layer file or section name' } } },
  },
  {
    name: 'list_live_events',
    description: 'Live FL511 events stored in DataConnect. window "active" is what is open now; 1h/2h/6h/24h/all also include events cleared in that period.',
    input_schema: {
      type: 'object',
      properties: {
        window: { type: 'string', enum: Object.keys(EVENT_WINDOWS) },
        type: { type: 'string', enum: ['INCIDENT', 'CLOSURE', 'CONSTRUCTION', 'CONGESTION', 'DISABLED'] },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      },
    },
  },
  {
    name: 'get_live_chain',
    description: "A live event's full response chain: the event, its ticket, tasks, work order, inspection and damaged-asset status records.",
    input_schema: { type: 'object', properties: { event_id: { type: 'string', description: 'e.g. FL511-876564 or FL511-CLOSURE-876564' } }, required: ['event_id'] },
  },
  {
    name: 'query_records',
    description: 'Filtered read of one DataConnect class from the data dictionary (live or historical). Filters use attribute names exactly as describe_data lists them, or keyInSource.',
    input_schema: {
      type: 'object',
      properties: {
        class_name: { type: 'string' },
        filters: {
          type: 'array', maxItems: 5,
          items: { type: 'object', properties: { field: { type: 'string' }, operator: { type: 'string', enum: [...OPERATORS] }, value: { type: 'string' } }, required: ['field', 'operator', 'value'] },
        },
        fields: { type: 'array', items: { type: 'string' }, description: 'Attributes to return (default: all)' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      },
      required: ['class_name'],
    },
  },
  {
    name: 'find_corridor_features',
    description: 'Search a corridor GeoJSON layer (cameras, signals, bridges, express gantries, FDOT traffic segments, ramps) by text in any property and/or distance from a point.',
    input_schema: {
      type: 'object',
      properties: {
        layer: { type: 'string', enum: [...ASK_LAYER_FILES] },
        text: { type: 'string' },
        near: { type: 'object', properties: { lon: { type: 'number' }, lat: { type: 'number' }, radius_m: { type: 'number', maximum: 10_000 } }, required: ['lon', 'lat'] },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['layer'],
    },
  },
  {
    name: 'get_weather',
    description: 'Current weather (Open-Meteo) at a point on or near the corridor.',
    input_schema: { type: 'object', properties: { lon: { type: 'number' }, lat: { type: 'number' } }, required: ['lon', 'lat'] },
  },
]);

const clip = value => (typeof value === 'string' && value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value);
const limitOf = (value, max = MAX_LIMIT, fallback = 10) => Math.min(max, Math.max(1, Number.parseInt(value ?? fallback, 10) || fallback));
const toolError = message => ({ error: message });

/** FL511-CLOSURE-876564, fl511-876564 and 876564 are all the Live Events key FL511-876564. */
export function liveEventKey(eventId) {
  const match = /^(?:FL511-)?(?:[A-Z]+-)?(\d+)$/i.exec(String(eventId ?? '').trim());
  return match ? `FL511-${match[1]}` : null;
}

/** A curated-data item as a flat record, without geometry, long strings clipped, optionally only `fields`. */
export function flatRecord(item, fields = null) {
  const record = { keyInSource: item?.keyInSource, ...(item?.attributes ?? {}) };
  delete record.geometry;
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (fields && key !== 'keyInSource' && !fields.includes(key)) continue;
    if (value === null || value === undefined || value === '' || value === 'NA') continue;
    out[key] = clip(value);
  }
  return out;
}

const compactEvent = e => ({
  id: e.id, key: e.dataConnect?.keyInSource, type: e.type, status: e.dataConnect?.status ?? 'active', title: clip(e.title),
  description: clip(e.description), near: e.nearestFacilityLabel || e.nearestSegmentLabel || null, lon: e.longitude, lat: e.latitude,
  start: e.startTime, firstSeenAt: e.dataConnect?.firstSeenAt, clearedAt: e.dataConnect?.clearedAt ?? null,
  impact: e.sdna?.impact_level, subtype: e.sdna?.incident_subtype, weather: e.sdna?.weather_at_event, camera: e.sdna?.primary_camera_id,
});

/** Trim an array-bearing result until its JSON fits, saying how much was left out. */
export function fitResult(result, max = MAX_RESULT_CHARS) {
  let text = JSON.stringify(result);
  if (text.length <= max) return text;
  const key = Object.keys(result).find(k => Array.isArray(result[k]));
  if (!key) return `${text.slice(0, max)}…`;
  const copy = { ...result, [key]: [...result[key]] };
  while (copy[key].length > 1 && JSON.stringify(copy).length > max) copy[key].pop();
  copy.truncated = `${result[key].length - copy[key].length} of ${result[key].length} ${key} left out to fit; narrow the query`;
  text = JSON.stringify(copy);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function featurePoint(geometry) {
  const coords = geometry?.coordinates;
  if (!coords) return null;
  if (geometry.type === 'Point') return coords;
  const flat = coords.flat(3).filter(Number.isFinite);
  const pairs = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
  return pairs.length ? pairs[Math.floor(pairs.length / 2)] : null;
}

/**
 * @param {{dictionary:object, liveEvents?:{dataConnectEvents:(window?:string)=>Promise<object|null>},
 *   liveDc?:{liveClasses:()=>Promise<object[]>, curatedData:(id:string, body:object)=>Promise<object>},
 *   historical?:{curatedData:(id:string, body:object)=>Promise<object>}, readLayer?:(file:string)=>object|null,
 *   fetchWeather?:(point:{latitude:number, longitude:number})=>Promise<object|null>}} deps
 */
export function createAskTools({ dictionary, liveEvents, liveDc, historical, readLayer, fetchWeather }) {
  const classes = new Map([...dictionary.dataConnect.live, ...dictionary.dataConnect.historical].map(c => [c.className.toLowerCase(), c]));
  const layers = new Map();
  const layer = file => {
    if (!layers.has(file)) layers.set(file, readLayer?.(file) ?? null);
    return layers.get(file);
  };

  async function read(entry, filters, pageSize) {
    if (entry.kind === 'live') {
      if (!liveDc) throw new Error('Live DataConnect is not configured on this host.');
      const target = (await liveDc.liveClasses()).find(c => c.className === entry.className);
      if (!target) throw new Error(`${entry.className} was not found in DataConnect.`);
      return liveDc.curatedData(target.id, { page: 0, pageSize, filters });
    }
    if (!historical) throw new Error('Historical DataConnect is not configured on this host.');
    return historical.curatedData(entry.id, { page: 0, pageSize, filters });
  }

  const handlers = {
    describe_data: ({ topic } = {}) => describeData(dictionary, topic),

    async list_live_events({ window = 'active', type, limit } = {}) {
      if (!liveEvents) return toolError('Live events are not configured on this host.');
      const payload = await liveEvents.dataConnectEvents(Object.hasOwn(EVENT_WINDOWS, window) ? window : 'active');
      if (!payload) return toolError('DataConnect could not be read just now.');
      const events = (payload.events ?? []).filter(e => !type || e.type === type);
      return { window, total: events.length, events: events.slice(0, limitOf(limit)).map(compactEvent) };
    },

    async get_live_chain({ event_id } = {}) {
      const key = liveEventKey(event_id);
      if (!key) return toolError(`'${event_id}' is not an FL511 event id.`);
      const byKey = { field: 'keyInSource', operator: 'equals', value: key };
      const bySource = { field: 'attributes.source_event_id', operator: 'equals', value: key };
      const [event, ...chain] = await Promise.all([
        read(classes.get(LIVE_CLASS.EVENTS.toLowerCase()), [byKey], 1),
        ...CHAIN_CLASSES.map(k => read(classes.get(LIVE_CLASS[k].toLowerCase()), [bySource], MAX_LIMIT)),
      ]);
      const records = payload => (payload?.data ?? []).map(item => flatRecord(item));
      if (!records(event).length) return toolError(`No live event ${key} in DataConnect.`);
      return {
        event: records(event)[0],
        ...Object.fromEntries(CHAIN_CLASSES.map((k, i) => [k.toLowerCase(), records(chain[i])])),
      };
    },

    async query_records({ class_name, filters = [], fields, limit } = {}) {
      const entry = classes.get(String(class_name ?? '').trim().toLowerCase());
      if (!entry) return toolError(`Unknown class '${class_name}'. Use a class name from describe_data.`);
      const known = new Set(entry.attributes.map(a => a.name));
      if (!Array.isArray(filters) || filters.length > 5) return toolError('Give at most 5 filters.');
      const upstream = [];
      for (const f of filters) {
        if (!OPERATORS.has(f?.operator)) return toolError(`Operator must be one of: ${[...OPERATORS].join(', ')}.`);
        if (f.field !== 'keyInSource' && !known.has(f.field)) return toolError(`'${f.field}' is not an attribute of ${entry.className}. See describe_data.`);
        upstream.push({ field: f.field === 'keyInSource' ? 'keyInSource' : `attributes.${f.field}`, operator: f.operator, value: String(f.value ?? '') });
      }
      const wanted = Array.isArray(fields) && fields.length ? fields.filter(f => known.has(f)) : null;
      const payload = await read(entry, upstream, limitOf(limit));
      const data = payload?.data ?? [];
      return { className: entry.className, totalCount: Number(payload?.totalCount ?? data.length), records: data.map(item => flatRecord(item, wanted)) };
    },

    find_corridor_features({ layer: file, text, near, limit } = {}) {
      if (!ASK_LAYER_FILES.includes(file)) return toolError(`Unknown layer '${file}'.`);
      const json = layer(file);
      if (!json) return toolError(`${file} is not available on this host.`);
      const needle = String(text ?? '').trim().toLowerCase();
      const origin = near && Number.isFinite(near.lon) && Number.isFinite(near.lat) ? near : null;
      const radius = origin ? Math.min(10_000, Number(near.radius_m) > 0 ? Number(near.radius_m) : 1_000) : null;
      const found = [];
      for (const feature of json.features ?? []) {
        const props = feature.properties ?? {};
        if (needle && !Object.values(props).some(v => String(v ?? '').toLowerCase().includes(needle))) continue;
        const point = featurePoint(feature.geometry);
        const distance = origin && point ? Math.round(haversineMeters(origin.lon, origin.lat, point[0], point[1])) : null;
        if (origin && (distance === null || distance > radius)) continue;
        found.push({ ...Object.fromEntries(Object.entries(props).filter(([, v]) => v !== null && v !== '').map(([k, v]) => [k, clip(v)])),
          lon: point?.[0] ?? null, lat: point?.[1] ?? null, ...(distance !== null ? { distance_m: distance } : {}) });
      }
      if (origin) found.sort((a, b) => a.distance_m - b.distance_m);
      return { layer: file, total: found.length, features: found.slice(0, limitOf(limit, 20)) };
    },

    async get_weather({ lon, lat } = {}) {
      if (!fetchWeather) return toolError('Weather is not configured on this host.');
      const x = Number(lon), y = Number(lat);
      if (!(y >= WEATHER_BOX.minLat && y <= WEATHER_BOX.maxLat && x >= WEATHER_BOX.minLon && x <= WEATHER_BOX.maxLon)) {
        return toolError('Weather is only available for points in South Florida.');
      }
      const weather = await fetchWeather({ latitude: y, longitude: x });
      return weather ?? toolError('Weather service did not answer.');
    },
  };

  /** Runs one tool call; failures come back as {error}, never as a thrown exception. Returns JSON text. */
  async function run(name, input) {
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : null;
    if (!handler) return JSON.stringify(toolError(`Unknown tool '${name}'.`));
    try {
      return fitResult(await handler(input ?? {}));
    } catch (error) {
      return JSON.stringify(toolError(String(error?.message ?? error).slice(0, 200)));
    }
  }

  return { definitions: TOOL_DEFINITIONS, run };
}
