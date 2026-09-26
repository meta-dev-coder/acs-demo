/**
 * TEST DOUBLE ONLY: never a runtime target. Tests start it in-process on port 0 and point the writer
 * and reader at it with their own URL and token; the app and the sync talk only to DataConnect.
 *
 * An in-memory copy of the DataConnect data-management API plus the load service. It mimics the real
 * hosts where their behaviour is known (class/curated-data/process reads, the /v1/loads register ->
 * upload json-file -> process -> get flow, async processing then curation, DEPENDENCY_UPDATED
 * re-curation, DateTime validation and read-back) and refuses every other mutation. Only the Live classes
 * are writable; the historical classes are seeded read-only references.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVE_CLASS_NAMES, liveClassDefinition, placeholderObjectId, toClassDto, HISTORICAL_CLASSES,
  DC_SEGMENT_CODES, validateRecord, PROJECT_CODE, toDcDateTime,
} from './classes.mjs';

export const LIVE_STANDIN_CLASS_IDS = Object.freeze(Object.fromEntries(LIVE_CLASS_NAMES.map((name, i) => [name, 101 + i])));

const DEFAULT_ASSET_REGISTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'dataconnect-data', 'asset_registry.json');
const DM_PREFIXES = Object.freeze(['/api/data-mgmt/v1', '/api/v1']);
const LOAD_SERVICE = '/v1/loads';
const LOAD_TYPES = Object.freeze(['Full', 'Incremental', 'Deletion']);
const FILTER_OPERATORS = Object.freeze(['equals', 'isAnyOf', 'contains', 'startsWith']);
const PROCESS_STATUSES = Object.freeze(['Pending', 'Deferred', 'InProgress', 'Finished', 'Failed']);
const NOT_PERMITTED = 'Not permitted in the DataConnect stand-in';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const ASSET_COPY = Object.freeze([
  ['asset category', 'Asset Category'], ['system class', 'System Class'], ['location category', 'Location Category'],
  ['segment', 'Segment'], ['notes', 'Notes'], ['status', 'Status'],
]);

const isEmpty = value => value === undefined || value === null || value === '';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const dcTimestamp = ms => new Date(ms).toISOString().slice(0, -1);
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** One asset_registry.json row -> a Florida I595 Assets load record (no segment ID, no geometry, like the real rows). */
export function registryRowToAssetRecord(row) {
  if (!row || isEmpty(row['Asset ID'])) return null;
  const code = String(row['Asset ID']);
  const record = {
    keyInSource: code, code, name: code,
    description: row['Asset Description'] || row['Asset Category'] || code,
  };
  for (const [attribute, column] of ASSET_COPY) {
    if (!isEmpty(row[column])) record[attribute] = row[column];
  }
  if (finite(row['X Coordinates'])) record.x_coordinates = row['X Coordinates'];
  if (finite(row['Y Coordinates'])) record.y_coordinates = row['Y Coordinates'];
  record.project = PROJECT_CODE;
  return record;
}

function segmentRecord(code) {
  const n = Number.parseInt(code, 10);
  const trafficDirection = code.endsWith('E') ? 'i595 East' : code.endsWith('W') ? 'i595 West' : 'i595 Express';
  return {
    keyInSource: code, code, name: `Segment_${code}`, description: '-', roadway: 'i595',
    traffic_direction: trafficDirection, west_end_marker_id: `mmk_${n - 100}`, east_end_marker_id: `mmk_${n - 99}`,
  };
}

function historicalDto(h) {
  // Real ObjectIds embed their creation second, which is the closest thing to a creation date we have.
  const created = dcTimestamp(Number.parseInt(h.id.slice(0, 8), 16) * 1000);
  return {
    id: h.id, classId: h.classId, className: h.className, classType: 'DATA_CLASS',
    description: h.description ?? '', status: 'Published', owners: [], createdBy: 'dataconnect',
    lastModifiedBy: 'dataconnect', createdOn: created, lastUpdated: created,
    geometryAttributeName: h.geometryAttributeName ?? 'geometry', displayInExplorer: true,
    includeSecuritySettings: false, securityLevel: 0, parentId: null, attributes: clone(h.attributes),
  };
}

function attributeType(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'double';
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function problem(status, title, detail, instance) {
  return { type: 'about:blank', title, status, detail, instance };
}

export function createDcStandin({
  now = Date.now, processingDelayMs = 5, curationDelayMs = 5,
  tokens = null,
  writableClassNames = LIVE_CLASS_NAMES,
  linkMode = 'live',
  incrementalMode = 'replace',
  seedHistorical = true, assetRows = undefined,
  dataFile = null,
  logger = console,
} = {}) {
  if (incrementalMode !== 'replace' && incrementalMode !== 'merge') throw new Error(`unknown incrementalMode '${incrementalMode}'`);
  const writable = new Set(writableClassNames);
  const classes = new Map();
  const byNumericId = new Map();
  const byName = new Map();
  const timers = new Set();
  const idleWaiters = [];
  const requests = [];
  const loads = new Map();
  let counter = 0;
  let closed = false;

  const objectId = () => Math.floor(now() / 1000).toString(16).padStart(8, '0').slice(-8) + (++counter).toString(16).padStart(16, '0');

  function register(dto, live) {
    const state = { dto, live, raw: new Map(), curated: new Map(), rawProcesses: [], curatedProcesses: [], queue: [], busy: false };
    classes.set(dto.id, state);
    byNumericId.set(dto.classId, state);
    byName.set(dto.className, state);
    return state;
  }

  const historicalIds = new Map(HISTORICAL_CLASSES.map(h => [h.className, h.id]));
  const resolveClassId = name => {
    if (historicalIds.has(name)) return historicalIds.get(name);
    if (LIVE_CLASS_NAMES.includes(name)) return placeholderObjectId(name);
    throw new Error(`unknown relationship target '${name}'`);
  };

  // ---- curation -------------------------------------------------------------------------------

  function curate(state, entry) {
    const startedAt = now();
    const codeCache = new Map();
    const codesFor = attr => {
      const target = classes.get(attr.relatedClassId);
      if (!target) return null;
      if (!codeCache.has(target)) {
        codeCache.set(target, new Set([...target.curated.values()].map(c => String(c.record.code ?? c.keyInSource))));
      }
      return codeCache.get(target);
    };
    const next = new Map();
    let valid = 0;
    for (const [key, record] of state.raw) {
      const { valid: ok, failures } = validateRecord(state.dto, record, { codesFor });
      if (ok) valid++;
      const entry = { id: state.curated.get(key)?.id ?? objectId(), keyInSource: key, valid: ok, record: clone(record) };
      if (!ok) entry.failures = failures;
      next.set(key, entry);
    }
    let deleted = 0;
    for (const key of state.curated.keys()) if (!next.has(key)) deleted++;
    state.curated = next;
    if (!entry) return;
    const finished = dcTimestamp(now());
    state.curatedProcesses.push({
      id: objectId(), classId: state.dto.id, classType: 'DATA_CLASS', curationType: entry.curationType,
      status: 'Finished', loadType: entry.loadType ?? null, loadId: entry.loadId ?? null,
      startedAt: dcTimestamp(startedAt), processingAt: dcTimestamp(startedAt), finishedAt: finished, lastUpdatedAt: finished,
      triggeredBy: 'standin', stats: { valid, invalid: next.size - valid, deleted },
    });
  }

  function recurateDependants(origin) {
    const visited = new Set([origin.dto.id]);
    const pending = [origin];
    while (pending.length) {
      const changed = pending.shift();
      for (const dependant of classes.values()) {
        if (visited.has(dependant.dto.id) || dependant.raw.size === 0) continue;
        if (!dependant.dto.attributes.some(a => a.relatedClassId === changed.dto.id)) continue;
        visited.add(dependant.dto.id);
        curate(dependant, { curationType: 'DEPENDENCY_UPDATED' });
        pending.push(dependant);
      }
    }
  }

  // ---- load processing ------------------------------------------------------------------------

  function applyLoad(state, loadType, rows) {
    const stats = { totalRecords: rows.length, invalidRecords: 0, duplicateRecords: 0, new: 0, updated: 0, notChanged: 0, deleted: 0, notFound: 0 };
    const keyOf = row => {
      if (loadType === 'Deletion' && typeof row === 'string') return row;
      return row && typeof row === 'object' && !Array.isArray(row) ? row.keyInSource : undefined;
    };
    const valid = rows.map(row => {
      const key = keyOf(row);
      return typeof key === 'string' && key !== '' ? key : null;
    });
    const occurrences = new Map();
    for (const key of valid) if (key !== null) occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
    const duplicateKeys = [...occurrences].filter(([, count]) => count > 1).map(([key, count]) => ({ key, count }));
    const metaKeys = [];
    const metaTypes = {};
    const payloadKeys = new Set(occurrences.keys());

    rows.forEach((row, i) => {
      const key = valid[i];
      if (key === null) { stats.invalidRecords++; return; }
      if (occurrences.get(key) > 1) { stats.duplicateRecords++; return; }
      if (typeof row === 'object') {
        for (const [name, value] of Object.entries(row)) {
          if (!(name in metaTypes)) { metaKeys.push(name); metaTypes[name] = attributeType(value); }
        }
      }
      if (loadType === 'Deletion') {
        if (state.raw.delete(key)) stats.deleted++; else stats.notFound++;
        return;
      }
      const previous = state.raw.get(key);
      if (!previous) { state.raw.set(key, clone(row)); stats.new++; return; }
      const merged = loadType === 'Incremental' && incrementalMode === 'merge' ? { ...previous, ...clone(row) } : clone(row);
      if (canonical(merged) === canonical(previous)) { stats.notChanged++; return; }
      state.raw.set(key, merged);
      stats.updated++;
    });
    if (loadType === 'Full') {
      for (const key of [...state.raw.keys()]) {
        if (!payloadKeys.has(key)) { state.raw.delete(key); stats.deleted++; }
      }
    }
    return { stats, duplicateKeys, attributeMetadata: { keys: metaKeys, types: metaTypes } };
  }

  function schedule(ms, fn) {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timer.unref?.();
    timers.add(timer);
  }

  const isIdle = () => [...classes.values()].every(s => !s.busy && s.queue.length === 0);
  function notifyIdle() {
    if (!closed && !isIdle()) return;
    while (idleWaiters.length) idleWaiters.shift()();
  }

  function pump(state) {
    if (closed || state.busy || state.queue.length === 0) return;
    state.busy = true;
    const { process, rows, load } = state.queue.shift();
    schedule(processingDelayMs, () => {
      process.status = 'InProgress';
      process.processingAt = process.lastUpdatedAt = dcTimestamp(now());
      loadEvent(load, 'Loading', 'Running');
      try {
        Object.assign(process, applyLoad(state, process.loadType, rows));
        process.status = 'Finished';
      } catch (error) {
        process.status = 'Failed';
        logger.error?.(`DataConnect stand-in: load ${process.loadId} failed: ${error.message}`);
      }
      process.finishedAt = process.lastUpdatedAt = dcTimestamp(now());
      loadEvent(load, 'Loading', process.status);
      const s = process.stats;
      logger.info?.(`stand-in load ${state.dto.className} ${process.loadType} ${process.status} total=${s.totalRecords} new=${s.new} updated=${s.updated} notChanged=${s.notChanged} deleted=${s.deleted} notFound=${s.notFound} invalid=${s.invalidRecords} duplicate=${s.duplicateRecords}`);
      if (process.status !== 'Finished') { state.busy = false; pump(state); notifyIdle(); return; }
      schedule(curationDelayMs, () => {
        curate(state, { curationType: 'RAW_DATA_LOAD', loadId: process.loadId, loadType: process.loadType });
        recurateDependants(state);
        persist();
        state.busy = false;
        pump(state);
        notifyIdle();
      });
    });
  }

  function loadEvent(load, event, status) {
    const time = new Date(now()).toISOString();
    load.status = status;
    load.lastUpdated = time;
    load.log.push({ loadEvent: event, status, time });
  }

  function submitLoad(state, load, rows) {
    const at = dcTimestamp(now());
    const { loadType } = load;
    loadEvent(load, 'Loading', 'Pending');
    const process = {
      id: objectId(), classId: state.dto.id, classType: 'DATA_CLASS', loadId: load.id, loadType,
      triggeredBy: 'standin', status: 'Pending', payloadIds: [...load.payloadIds], lastUpdatedAt: at, startedAt: at,
      processingAt: null, finishedAt: null,
      stats: { totalRecords: rows.length, invalidRecords: 0, duplicateRecords: 0, new: 0, updated: 0, notChanged: 0, deleted: 0, notFound: 0 },
      duplicateKeys: [], attributeMetadata: { keys: [], types: {} },
    };
    state.rawProcesses.push(process);
    state.queue.push({ process, rows, load });
    pump(state);
  }

  // ---- persistence (Live classes only) --------------------------------------------------------

  function persist() {
    if (!dataFile) return;
    const out = { version: 1, classes: {}, counter };
    for (const state of classes.values()) {
      if (!state.live) continue;
      out.classes[state.dto.id] = {
        raw: [...state.raw.values()],
        curated: [...state.curated.values()],
        rawProcesses: state.rawProcesses,
        curatedProcesses: state.curatedProcesses,
      };
    }
    mkdirSync(dirname(dataFile), { recursive: true });
    const tmp = `${dataFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(out));
    renameSync(tmp, dataFile);
  }

  function restore() {
    if (!dataFile || !existsSync(dataFile)) return new Set();
    const saved = JSON.parse(readFileSync(dataFile, 'utf8'));
    if (saved?.version !== 1) throw new Error(`unsupported stand-in data file version in ${dataFile}`);
    counter = Math.max(counter, Number(saved.counter) || 0);
    const restored = new Set();
    for (const [id, data] of Object.entries(saved.classes ?? {})) {
      const state = classes.get(id);
      if (!state?.live) continue;
      state.raw = new Map((data.raw ?? []).map(r => [r.keyInSource, r]));
      state.curated = new Map((data.curated ?? []).map(c => [c.keyInSource, c]));
      // Work that was queued when the previous process stopped can never finish now.
      state.rawProcesses = (data.rawProcesses ?? []).map(p => (
        p.status === 'Finished' || p.status === 'Failed' ? p : { ...p, status: 'Failed', lastUpdatedAt: dcTimestamp(now()) }
      ));
      state.curatedProcesses = data.curatedProcesses ?? [];
      restored.add(id);
    }
    return restored;
  }

  // ---- seeding --------------------------------------------------------------------------------

  if (seedHistorical) {
    for (const h of HISTORICAL_CLASSES) register(historicalDto(h), false);
    const segments = byName.get('Florida i595 Roadway Segments');
    if (segments) {
      for (const code of DC_SEGMENT_CODES) segments.raw.set(code, segmentRecord(code));
      curate(segments, null);
    }
    const assets = byName.get('Florida I595 Assets');
    if (assets) {
      const rows = assetRows ?? JSON.parse(readFileSync(DEFAULT_ASSET_REGISTRY, 'utf8'));
      for (const row of rows) {
        const record = registryRowToAssetRecord(row);
        if (record && !assets.raw.has(record.code)) assets.raw.set(record.code, record);
      }
      curate(assets, null);
    }
  }
  for (const name of LIVE_CLASS_NAMES) {
    const def = liveClassDefinition(name, { linkMode });
    register(toClassDto(def, { id: placeholderObjectId(name), classId: LIVE_STANDIN_CLASS_IDS[name], resolveClassId, now: now() }), true);
  }
  const restored = restore();
  for (const name of LIVE_CLASS_NAMES) {
    const state = byName.get(name);
    if (!restored.has(state.dto.id)) curate(state, { curationType: 'CLASS_UPDATE' });
  }

  // ---- HTTP -----------------------------------------------------------------------------------

  function send(res, status, body) {
    if (body === null) {
      res.writeHead(status, { 'content-length': 0, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json), 'cache-control': 'no-store' });
    res.end(json);
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Payload too large'), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function readJson(req) {
    const buf = await readBody(req);
    if (buf.length === 0) return {};
    try { return JSON.parse(buf.toString('utf8')); } catch { return undefined; }
  }

  const dateTimeNames = state => new Set(state.dto.attributes.filter(a => a.type === 'DateTime').map(a => a.name));

  function curatedItem(state, entry, dateTimes = dateTimeNames(state)) {
    const attributes = {};
    for (const [name, value] of Object.entries(entry.record)) {
      if (name === 'keyInSource' || name === 'geometry' || isEmpty(value)) continue;
      // The real host reads a DateTime back as 2026-09-26T08:14:32.000+00:00.
      const instant = dateTimes.has(name) ? toDcDateTime(value) : null;
      attributes[name] = instant ? instant.replace(/Z$/, '.000+00:00') : value;
    }
    // Real curated-data LIST items carry no geoDetails (only the single-record read does).
    return { id: entry.id, classId: state.dto.id, className: state.dto.className, keyInSource: entry.keyInSource, attributes, valid: entry.valid };
  }

  function fieldValue(item, field) {
    if (field === 'keyInSource' || field === 'valid' || field === 'id') return item[field];
    const name = field.startsWith('attributes.') ? field.slice('attributes.'.length) : field;
    return item.attributes[name];
  }

  function matches(item, { field, operator, value }) {
    const actual = fieldValue(item, String(field ?? ''));
    if (actual === undefined || actual === null) return false;
    const text = String(actual);
    switch (operator) {
      case 'equals': return text === String(value);
      case 'isAnyOf': return (Array.isArray(value) ? value : [value]).map(String).includes(text);
      case 'contains': return text.toLowerCase().includes(String(value).toLowerCase());
      case 'startsWith': return text.toLowerCase().startsWith(String(value).toLowerCase());
      default: return false;
    }
  }

  function compare(a, b) {
    if (a === b) return 0;
    if (a === undefined || a === null) return 1;
    if (b === undefined || b === null) return -1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    const x = String(a); const y = String(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }

  function curatedData(state, body, path) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return [400, problem(400, 'Bad Request', 'Invalid request body', path)];
    const filters = body.filters ?? [];
    if (!Array.isArray(filters)) return [400, problem(400, 'Bad Request', 'filters must be an array', path)];
    const unsupported = filters.find(f => !FILTER_OPERATORS.includes(f?.operator));
    if (unsupported) return [400, problem(400, 'Bad Request', `Unsupported filter operator '${unsupported?.operator}'`, path)];
    const page = Math.max(0, Number.parseInt(body.page ?? 0, 10) || 0);
    const pageSize = Math.max(1, Number.parseInt(body.pageSize ?? 500, 10) || 500);
    const dateTimes = dateTimeNames(state);
    let items = [...state.curated.values()].map(entry => curatedItem(state, entry, dateTimes));
    items = items.filter(item => filters.every(f => matches(item, f)));
    const byId = (a, b) => compare(a.id, b.id);
    if (body.sort?.field) {
      const sign = String(body.sort.direction ?? 'asc').toLowerCase() === 'desc' ? -1 : 1;
      items.sort((a, b) => sign * compare(fieldValue(a, body.sort.field), fieldValue(b, body.sort.field)) || byId(a, b));
    } else {
      items.sort(byId);
    }
    return [200, { data: items.slice(page * pageSize, page * pageSize + pageSize), totalCount: items.length }];
  }

  const ascending = list => [...list].sort((a, b) => compare(a.startedAt, b.startedAt) || compare(a.id, b.id));

  function registerLoad(body, path, log) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return [400, problem(400, 'Bad Request', 'Invalid request body', path)];
    const { classId, classType = 'DATA_CLASS', loadType } = body;
    if (typeof classId === 'string') log.classId = classId;
    if (typeof loadType === 'string') log.loadType = loadType;
    const match = typeof classId === 'string' ? /^CL(\d{6})$/.exec(classId) : null;
    const state = match ? byNumericId.get(Number(match[1])) : null;
    if (!state) return [400, problem(400, 'Bad Request', 'Class not found', path)];
    if (classType !== 'DATA_CLASS') return [400, problem(400, 'Bad Request', 'classType must be DATA_CLASS', path)];
    if (!LOAD_TYPES.includes(loadType)) return [400, problem(400, 'Bad Request', `loadType must be one of ${LOAD_TYPES.join(', ')}`, path)];
    if (!writable.has(state.dto.className)) {
      return [403, problem(403, 'Forbidden', `You do not have permission to load data into class '${state.dto.className}'`, path)];
    }
    const at = new Date(now()).toISOString();
    const load = {
      id: objectId(), classId, loadType, status: 'Init', createdBy: 'standin', createdOn: at, lastUpdated: at,
      payloadIds: [], log: [{ loadEvent: 'Registered', status: 'Finished', time: at }],
    };
    loads.set(load.id, { load, state, rows: [], processed: false });
    return [200, clone(load)];
  }

  async function uploadJson(req, entry, path) {
    if (entry.processed) return [409, problem(409, 'Conflict', 'Load has already started, payload cannot be added to load', path)];
    let rows;
    try { rows = JSON.parse((await readBody(req)).toString('utf8')); } catch { rows = undefined; }
    if (!Array.isArray(rows)) return [400, problem(400, 'Bad Request', 'Payload must be a JSON array', path)];
    entry.rows.push(...rows);
    entry.load.payloadIds.push(randomUUID());
    loadEvent(entry.load, 'LoadJSONFile', 'Finished');
    return [200, null];
  }

  function processLoad(entry, path) {
    if (entry.processed) return [409, problem(409, 'Conflict', 'Load has already been processed', path)];
    if (entry.load.payloadIds.length === 0) return [400, problem(400, 'Bad Request', 'Load does not have any payloads to process', path)];
    entry.processed = true;
    submitLoad(entry.state, entry.load, entry.rows);
    return [202, null];
  }

  async function loadService(req, path, method, log, forbidden) {
    const parts = path.slice(LOAD_SERVICE.length).split('/').filter(Boolean).map(decodeURIComponent);
    // Purge-all and load groups exist on the real service; nothing here may ever reach them.
    if (parts[0] === 'purge-all' || parts[0] === 'groups') return forbidden();
    if (parts.length === 0) return method === 'POST' ? registerLoad(await readJson(req), path, log) : forbidden();
    const route = parts.length === 1 && method === 'GET' ? 'get'
      : parts.length === 2 && parts[1] === 'process' && method === 'POST' ? 'process'
        : parts.length === 3 && parts[1] === 'upload' && parts[2] === 'json-file' && method === 'POST' ? 'upload' : null;
    if (!route) return forbidden();
    const entry = loads.get(parts[0]);
    if (!entry) return [404, problem(404, 'Not Found', 'No load found for provided id', path)];
    log.classId = entry.load.classId;
    log.loadType = entry.load.loadType;
    if (route === 'get') return [200, clone(entry.load)];
    return route === 'upload' ? uploadJson(req, entry, path) : processLoad(entry, path);
  }

  async function route(req, url, log) {
    const path = url.pathname;
    const method = req.method;
    const forbidden = () => [403, problem(403, 'Forbidden', NOT_PERMITTED, path)];
    if (path === LOAD_SERVICE || path.startsWith(`${LOAD_SERVICE}/`)) return loadService(req, path, method, log, forbidden);
    // The multipart gateway path is WAF-blocked for API clients; writes go through the load service.
    if (path === '/api/loads' || path.startsWith('/api/loads/')) return forbidden();

    const prefix = DM_PREFIXES.find(p => path === p || path.startsWith(`${p}/`));
    if (!prefix) return [404, problem(404, 'Not Found', 'No such resource', path)];
    const parts = path.slice(prefix.length).split('/').filter(Boolean).map(decodeURIComponent);
    const [area, id, sub, ...rest] = parts;
    if (area === 'admin' || area === 'relationship-types') return forbidden();
    if (area !== 'class') return [404, problem(404, 'Not Found', 'No such resource', path)];

    if (method === 'GET' && parts.length === 1) return [200, [...classes.values()].map(s => clone(s.dto))];
    if (method === 'GET' && id === 'search' && parts.length === 2) {
      const term = (url.searchParams.get('searchTerm') ?? '').toLowerCase();
      return [200, [...classes.values()].filter(s => s.dto.className.toLowerCase().includes(term)).map(s => clone(s.dto))];
    }
    const state = id ? classes.get(id) : null;
    const known = method === 'GET' ? (parts.length === 2 || (parts.length === 3 && ['raw-data-process', 'curated-data-process'].includes(sub)))
      : method === 'POST' && parts.length === 3 && sub === 'curated-data';
    if (!known || rest.length) return forbidden();
    if (!state) return [404, problem(404, 'Not Found', `No class found for id ${id}`, path)];

    if (!sub) return [200, clone(state.dto)];
    if (sub === 'curated-data') {
      const body = await readJson(req);
      return curatedData(state, body, path);
    }
    if (sub === 'raw-data-process') {
      const status = url.searchParams.get('status');
      if (status && !PROCESS_STATUSES.includes(status)) return [400, problem(400, 'Bad Request', `Unknown status '${status}'`, path)];
      let list = ascending(state.rawProcesses).filter(p => !status || p.status === status);
      if (url.searchParams.get('latest') === 'true') list = list.slice(-1);
      return [200, clone(list)];
    }
    // The real host has no `latest` for curated processes; it is ignored on purpose.
    return [200, clone(ascending(state.curatedProcesses))];
  }

  function authorize(req) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers?.authorization ?? '');
    if (!match) return null;
    if (!tokens) return 'admin';
    const role = tokens[match[1]];
    return role === 'admin' || role === 'read' ? role : null;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const ours = ['/api', LOAD_SERVICE].some(p => path === p || path.startsWith(`${p}/`));
    if (!ours) return false;
    const log = { method: req.method, path };
    let status;
    let body;
    try {
      const role = authorize(req);
      const readAllowed = req.method === 'GET' || (req.method === 'POST' && /\/curated-data$/.test(path));
      if (!role) [status, body] = [401, problem(401, 'Unauthorized', 'A bearer token is required', path)];
      else if (role === 'read' && !readAllowed) [status, body] = [403, problem(403, 'Forbidden', 'The read role cannot modify data', path)];
      else [status, body] = await route(req, url, log);
    } catch (error) {
      status = error.status ?? 500;
      body = problem(status, status === 500 ? 'Internal Server Error' : 'Error', error.message, path);
      if (status === 500) logger.error?.(`DataConnect stand-in: ${req.method} ${path} failed: ${error.message}`);
    }
    if (!res.writableEnded && !res.headersSent) {
      // Drain an unread body so the connection can be reused.
      if (!req.readableEnded) req.resume();
      send(res, status, body);
    }
    requests.push({ ...log, status });
    return true;
  }

  function listen(port = 0, host = '127.0.0.1') {
    const server = createServer((req, res) => {
      handle(req, res).then(handled => {
        if (!handled) send(res, 404, problem(404, 'Not Found', 'No such resource', new URL(req.url, 'http://localhost').pathname));
      }).catch(() => { if (!res.headersSent) send(res, 500, problem(500, 'Internal Server Error', 'Unexpected error', req.url)); });
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        const { port: actual } = server.address();
        const shownHost = host.includes(':') ? `[${host}]` : host;
        resolve({
          url: `http://${shownHost}:${actual}`,
          port: actual,
          close: () => new Promise(done => {
            closed = true;
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
            notifyIdle();
            server.close(() => done());
            server.closeAllConnections?.();
          }),
        });
      });
    });
  }

  const idle = () => (isIdle() || closed ? Promise.resolve() : new Promise(resolve => idleWaiters.push(resolve)));

  return {
    handle,
    listen,
    idle,
    classByName: name => clone(byName.get(name)?.dto) ?? null,
    snapshot: className => {
      const state = byName.get(className);
      if (!state) return [];
      return [...state.curated.values()]
        .map(c => ({ keyInSource: c.keyInSource, valid: c.valid, record: clone(c.record) }))
        .sort((a, b) => compare(a.keyInSource, b.keyInSource));
    },
    processes: className => {
      const state = byName.get(className);
      return state ? { raw: clone(ascending(state.rawProcesses)), curated: clone(ascending(state.curatedProcesses)) } : { raw: [], curated: [] };
    },
    invalidReasons: className => {
      const state = byName.get(className);
      return Object.fromEntries([...(state?.curated.values() ?? [])].filter(c => !c.valid && c.failures)
        .sort((a, b) => compare(a.keyInSource, b.keyInSource)).map(c => [c.keyInSource, clone(c.failures)]));
    },
    requests,
  };
}
