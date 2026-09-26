/**
 * Guarded DataConnect client for the "SDNA Florida I595 Live *" classes. Reads any class through the
 * data-management API; writes only Incremental loads, through the load service (/v1/loads register ->
 * upload json-file -> process -> poll), into Live classes resolved from the server's own class list,
 * so a historical class can never be targeted by name, ObjectId or numeric classId. Deletion exists
 * only behind a confirmed resetLiveClass; Full is unreachable; purge-all, load groups and cancel are
 * refused by path. Tokens never reach a log line or an error.
 */
import { readFileSync } from 'node:fs';
import {
  LIVE_CLASS_NAMES, isLiveClassName, HISTORICAL_CLASS_IDS, HISTORICAL_NUMERIC_CLASS_IDS,
  validateRecord, unknownAttributes,
} from './classes.mjs';

export const WRITER_ERRORS = Object.freeze({
  NOT_ALLOWLISTED: 'not_allowlisted',
  HISTORICAL_CLASS: 'historical_class',
  LOAD_TYPE_REFUSED: 'load_type_refused',
  RESET_NOT_CONFIRMED: 'reset_not_confirmed',
  UNRESOLVED_CLASS: 'unresolved_class',
  DUPLICATE_KEYS: 'duplicate_keys',
  INVALID_RECORD: 'invalid_record',
  UNKNOWN_ATTRIBUTE: 'unknown_attribute',
  LOAD_FAILED: 'load_failed',
  PROCESS_TIMEOUT: 'process_timeout',
  HTTP_ERROR: 'http_error',
  LIVE_CLASS_MISSING: 'live_class_missing',
  AMBIGUOUS_CLASS: 'ambiguous_class',
  NOT_CONFIGURED: 'not_configured',
  LOAD_PATH_REFUSED: 'load_path_refused',
});

export class DcWriterError extends Error {
  constructor(code, message, { status, detail } = {}) {
    super(message);
    this.name = 'DcWriterError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (detail !== undefined) this.detail = detail;
  }
}

const E = WRITER_ERRORS;
const TERMINAL = new Set(['Finished', 'Failed']);
const MISSING_CREDENTIALS = 'DC_WRITER_ACCESS_TOKEN, DC_WRITER_ACCESS_TOKEN_FILE or DC_WRITER_CLIENT_ID+DC_WRITER_CLIENT_SECRET';

const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// URLs are baseUrl + path, so a path without a leading '/' or with '@' could move the authority
// ('https://dc.example' + '@evil.example/...' targets evil.example) past the origin guard.
const SAFE_PATH = /^\/[^@]*$/;

function assertSafePaths(config) {
  if (typeof config.dataMgmtPrefix !== 'string' || !SAFE_PATH.test(config.dataMgmtPrefix)) {
    throw new DcWriterError(WRITER_ERRORS.NOT_CONFIGURED, "DC_WRITER_DATA_MGMT_PREFIX must be an absolute path starting with '/' and without '@'");
  }
}

const LOADS = '/v1/loads';
const LOAD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RESERVED_LOAD_IDS = new Set(['purge-all', 'groups']);
const isLoadId = id => typeof id === 'string' && LOAD_ID.test(id) && !RESERVED_LOAD_IDS.has(id.toLowerCase());

/**
 * The only load-service calls the writer may make: register, upload a JSON array, process and read one
 * load. purge-all, load groups, cancel (DELETE) and everything else are refused.
 */
export function assertLoadServiceRequest(method, path) {
  const parts = typeof path === 'string' && path.startsWith(`${LOADS}/`) ? path.slice(LOADS.length + 1).split('/') : [];
  const [id, ...rest] = parts;
  const tail = rest.join('/');
  const allowed = (method === 'POST' && path === LOADS)
    || (isLoadId(id) && ((method === 'GET' && tail === '') || (method === 'POST' && (tail === 'upload/json-file' || tail === 'process'))));
  if (!allowed) throw new DcWriterError(E.LOAD_PATH_REFUSED, `load service ${method} ${path} is not permitted`);
}

export function loadDcWriterConfig(env = process.env) {
  const baseUrl = (env.DC_WRITER_BASE_URL || '').replace(/\/+$/, '');
  const paths = { dataMgmtPrefix: env.DC_WRITER_DATA_MGMT_PREFIX || '/api/data-mgmt/v1' };
  assertSafePaths(paths);
  return {
    baseUrl,
    loadBaseUrl: (env.DC_WRITER_LOAD_BASE_URL || '').replace(/\/+$/, ''),
    ...paths,
    accessToken: env.DC_WRITER_ACCESS_TOKEN || '',
    accessTokenFile: env.DC_WRITER_ACCESS_TOKEN_FILE || '',
    tokenUrl: env.DC_WRITER_TOKEN_URL || 'https://ims.bentley.com/connect/token',
    clientId: env.DC_WRITER_CLIENT_ID || '',
    clientSecret: env.DC_WRITER_CLIENT_SECRET || '',
    scope: env.DC_WRITER_SCOPE || 'itwin-platform',
    timeoutMs: number(env.DC_WRITER_TIMEOUT_MS, 30_000),
    pollIntervalMs: number(env.DC_WRITER_POLL_INTERVAL_MS, 1000),
    processTimeoutMs: number(env.DC_WRITER_PROCESS_TIMEOUT_MS, 120_000),
    curationTimeoutMs: number(env.DC_WRITER_CURATION_TIMEOUT_MS, 120_000),
    pageSize: number(env.DC_WRITER_PAGE_SIZE, 500),
  };
}

export function missingWriterConfig(config) {
  const missing = [];
  if (!config?.baseUrl) missing.push('DC_WRITER_BASE_URL');
  if (!config?.loadBaseUrl) missing.push('DC_WRITER_LOAD_BASE_URL');
  if (!config?.accessToken && !config?.accessTokenFile && !(config?.clientId && config?.clientSecret)) missing.push(MISSING_CREDENTIALS);
  return missing;
}

/** Re-read on every call: `npm run dc:login` rewrites the file about hourly and nothing should need a restart. */
export function createTokenFileProvider(file, { label = 'DataConnect' } = {}) {
  return {
    renewable: false,
    invalidate() {},
    async getToken() {
      let token = '';
      try { token = readFileSync(file, 'utf8').trim(); } catch { /* reported below without the path's contents */ }
      if (!token) throw new DcWriterError(E.NOT_CONFIGURED, `${label} access token file is missing or empty`);
      return token;
    },
  };
}

export function formClassId(classDto) {
  const classId = classDto?.classId;
  if (!Number.isInteger(classId) || classId <= 0) {
    throw new DcWriterError(E.NOT_ALLOWLISTED, `class has no valid numeric classId (${JSON.stringify(classId ?? null)})`);
  }
  return `CL${String(classId).padStart(6, '0')}`;
}

/** Steps 1-4 of the guard: the class itself is a writable Live data class. */
function assertLiveClass(dto) {
  if (!isLiveClassName(dto?.className)) {
    throw new DcWriterError(E.NOT_ALLOWLISTED, `class '${dto?.className}' is not a Live class; refusing to write`);
  }
  if (HISTORICAL_CLASS_IDS.has(dto.id)) {
    throw new DcWriterError(E.HISTORICAL_CLASS, `class '${dto.className}' carries historical ObjectId ${dto.id}`);
  }
  // The load service resolves its target only by CL0000NN, so the numeric id matters as much as the name.
  if (HISTORICAL_NUMERIC_CLASS_IDS.has(dto.classId)) {
    throw new DcWriterError(E.HISTORICAL_CLASS, `class '${dto.className}' carries historical classId ${dto.classId}`);
  }
  if (dto.classType !== 'DATA_CLASS') {
    throw new DcWriterError(E.NOT_ALLOWLISTED, `class '${dto.className}' is not a DATA_CLASS`);
  }
  formClassId(dto);
}

export function assertWritable(classDto, loadType) {
  assertLiveClass(classDto);
  if (loadType !== 'Incremental') {
    throw new DcWriterError(E.LOAD_TYPE_REFUSED, `load type '${loadType}' refused; only Incremental loads are allowed`);
  }
}

export function createStaticTokenProvider(token) {
  return { getToken: async () => token, invalidate() {}, renewable: false };
}

export function createClientCredentialsTokenProvider({ tokenUrl, clientId, clientSecret, scope, fetchImpl = fetch, now = Date.now }) {
  let cached = null;
  let pending = null;
  async function request() {
    const response = await fetchImpl(tokenUrl, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope }),
    });
    if (!response.ok) {
      // Only the standard OAuth error code is read; the body may echo credentials back.
      const code = await response.json().then(p => p?.error, () => null);
      const safe = typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : null;
      throw new DcWriterError(E.HTTP_ERROR, `token request failed (${response.status}${safe ? ': ' + safe : ''})`, { status: response.status });
    }
    const payload = await response.json();
    if (!payload?.access_token) throw new DcWriterError(E.HTTP_ERROR, 'token request returned no access token');
    const lifetime = Math.max(0, (Number(payload.expires_in) || 3600) - 60);
    cached = { token: payload.access_token, expiresAt: now() + lifetime * 1000 };
    return cached.token;
  }
  return {
    renewable: true,
    async getToken() {
      if (cached && now() < cached.expiresAt) return cached.token;
      pending ??= request().finally(() => { pending = null; });
      return pending;
    },
    invalidate() { cached = null; },
  };
}

const listOf = payload => (Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : null);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function defaultTokenProvider(config, fetchImpl, now) {
  if (config.accessToken) return createStaticTokenProvider(config.accessToken);
  if (config.accessTokenFile) return createTokenFileProvider(config.accessTokenFile, { label: 'DataConnect writer' });
  if (config.clientId && config.clientSecret) {
    return createClientCredentialsTokenProvider({
      tokenUrl: config.tokenUrl, clientId: config.clientId, clientSecret: config.clientSecret, scope: config.scope, fetchImpl, now,
    });
  }
  throw new DcWriterError(E.NOT_CONFIGURED, `DataConnect writer needs ${MISSING_CREDENTIALS} for ${new URL(config.baseUrl).origin}`);
}

function checkRecords(dto, records) {
  if (!Array.isArray(records)) throw new DcWriterError(E.INVALID_RECORD, 'records must be an array');
  records.forEach((rec, i) => {
    const key = rec?.keyInSource;
    if (!rec || typeof rec !== 'object' || Array.isArray(rec) || typeof key !== 'string' || key === '' || rec.code !== key) {
      throw new DcWriterError(E.INVALID_RECORD, `record ${i}: keyInSource must be a non-empty string equal to code`);
    }
  });
  const counts = new Map();
  for (const rec of records) counts.set(rec.keyInSource, (counts.get(rec.keyInSource) ?? 0) + 1);
  const dupes = [...counts].filter(([, n]) => n > 1).map(([k]) => k);
  if (dupes.length) {
    throw new DcWriterError(E.DUPLICATE_KEYS, `duplicate keyInSource in ${dto.className}: ${dupes.slice(0, 5).join(', ')}${dupes.length > 5 ? ', …' : ''}`);
  }
  for (const rec of records) {
    const unknown = unknownAttributes(dto, rec);
    if (unknown.length) {
      throw new DcWriterError(E.UNKNOWN_ATTRIBUTE, `${rec.keyInSource}: attributes not defined on ${dto.className}: ${unknown.join(', ')}`);
    }
  }
  for (const rec of records) {
    const { valid, failures } = validateRecord(dto, rec);
    if (!valid) {
      const summary = failures.slice(0, 3).map(f => `${f.attribute} ${f.reasonCode}`).join('; ');
      throw new DcWriterError(E.INVALID_RECORD, `${rec.keyInSource} is invalid for ${dto.className}: ${summary}`);
    }
  }
}

export function createDcWriter({
  config, fetchImpl = fetch, tokenProvider, now = Date.now,
  sleep = ms => new Promise(r => setTimeout(r, ms)), logger = console,
}) {
  assertSafePaths(config);
  const cfg = { ...config };
  const origin = (() => { try { return new URL(cfg.baseUrl).origin; } catch { return null; } })();
  if (!origin || origin === 'null') throw new DcWriterError(E.NOT_CONFIGURED, 'DataConnect writer needs DC_WRITER_BASE_URL');
  const loadBase = (() => {
    try {
      const u = new URL(cfg.loadBaseUrl);
      const plain = ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
      return plain ? { origin: u.origin, prefix: u.pathname.replace(/\/+$/, '') } : null;
    } catch { return null; }
  })();
  if (!loadBase) throw new DcWriterError(E.NOT_CONFIGURED, 'DataConnect writer needs DC_WRITER_LOAD_BASE_URL (the load service, http(s) without credentials)');
  const tokens = tokenProvider ?? defaultTokenProvider(cfg, fetchImpl, now);
  const resolved = new WeakSet();
  const info = (logger.info ?? logger.log)?.bind(logger) ?? (() => {});
  const warn = (logger.warn ?? info).bind(logger);
  const dm = path => `${cfg.baseUrl}${cfg.dataMgmtPrefix}${path}`;
  const classPath = (dto, suffix) => dm(`/class/${encodeURIComponent(dto.id)}/${suffix}`);

  async function request(url, { method = 'GET', json } = {}, retry = true) {
    // Defence in depth for the path check: every request stays on a configured origin.
    const target = new URL(url);
    if (![origin, loadBase.origin].includes(target.origin) || target.username || target.password) {
      throw new DcWriterError(E.NOT_CONFIGURED, 'request URL left the configured DataConnect origins');
    }
    const onLoadService = target.origin === loadBase.origin
      && (origin !== loadBase.origin || target.pathname.startsWith(`${loadBase.prefix}${LOADS}`));
    if (onLoadService) {
      assertLoadServiceRequest(method, target.pathname.slice(loadBase.prefix.length));
    }
    const headers = { authorization: `Bearer ${await tokens.getToken()}` };
    if (json !== undefined) headers['content-type'] = 'application/json';
    // fetch follows 307/308 with the full POST body by default; the origin check above covers one hop only.
    const response = await fetchImpl(url, {
      method, headers, redirect: 'manual',
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (response.redirected || response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new DcWriterError(E.HTTP_ERROR, `DataConnect ${method} ${target.pathname} redirected; redirects are not followed`,
        { status: response.status || undefined });
    }
    if (response.status === 401 && retry && tokens.renewable) {
      tokens.invalidate();
      return request(url, { method, json }, false);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let detail = text.slice(0, 300);
      try {
        const problem = JSON.parse(text);
        if (typeof problem?.detail === 'string') detail = problem.detail;
      } catch { /* not JSON */ }
      throw new DcWriterError(E.HTTP_ERROR, `DataConnect ${method} ${new URL(url).pathname} returned ${response.status}`,
        { status: response.status, detail });
    }
    return response;
  }
  const getJson = async (url, options) => (await request(url, options)).json();
  const loadUrl = path => `${loadBase.origin}${loadBase.prefix}${path}`;

  async function listClasses() {
    const payload = await getJson(dm('/class'));
    return Array.isArray(payload) ? payload : payload?.data ?? payload?.classes ?? [];
  }

  function exactlyOne(all, name) {
    const matches = all.filter(c => c?.className === name);
    if (matches.length === 0) throw new DcWriterError(E.LIVE_CLASS_MISSING, `DataConnect class not found: '${name}'`);
    if (matches.length > 1) throw new DcWriterError(E.AMBIGUOUS_CLASS, `${matches.length} DataConnect classes are named '${name}'`);
    return matches[0];
  }

  async function findClassByName(name) {
    return exactlyOne(await listClasses(), name);
  }

  async function resolveLiveClasses() {
    const all = await listClasses();
    const missing = LIVE_CLASS_NAMES.filter(name => !all.some(c => c?.className === name));
    if (missing.length) {
      throw new DcWriterError(E.LIVE_CLASS_MISSING, `Live classes missing in DataConnect: ${missing.map(n => `'${n}'`).join(', ')}`);
    }
    const map = new Map();
    const ids = new Set();
    for (const name of LIVE_CLASS_NAMES) {
      const dto = exactlyOne(all, name);
      assertLiveClass(dto);
      // classIds are numbered per class type (CL/TS/IC); an untyped entry is treated as a data class.
      const sameNumeric = all.filter(c => c?.classId === dto.classId && (c.classType ?? 'DATA_CLASS') === 'DATA_CLASS');
      if (sameNumeric.length !== 1 || sameNumeric[0].id !== dto.id || sameNumeric[0].className !== name) {
        throw new DcWriterError(E.AMBIGUOUS_CLASS, `classId ${dto.classId} of '${name}' is not unique across DataConnect classes`);
      }
      if (ids.has(dto.id)) throw new DcWriterError(E.AMBIGUOUS_CLASS, `ObjectId ${dto.id} is shared by several Live classes`);
      ids.add(dto.id);
      const frozen = deepFreeze(structuredClone(dto));
      resolved.add(frozen);
      map.set(name, frozen);
    }
    return map;
  }

  async function readAll(classDto, { filters = [], pageSize = cfg.pageSize, maxPages = 1000 } = {}) {
    const out = [];
    const seen = new Set();
    let received = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const payload = await getJson(classPath(classDto, 'curated-data?includeDescendants=false'), {
        method: 'POST', json: { page, pageSize, filters, sort: { field: 'attributes.code', direction: 'asc' } },
      });
      const data = listOf(payload) ?? [];
      received += data.length;
      let added = 0;
      for (const item of data) {
        const key = item?.keyInSource;
        if (typeof key === 'string') {
          if (seen.has(key)) continue;
          seen.add(key);
        }
        out.push(item);
        added += 1;
      }
      const total = payload?.totalCount == null || payload.totalCount === '' ? NaN : Number(payload.totalCount);
      if (data.length === 0 || added === 0) break;
      // The server may cap pageSize below the request, so a short page only ends the read without a totalCount.
      if (Number.isFinite(total) ? received >= total : data.length < pageSize) break;
    }
    return out;
  }

  async function rawProcessForLoad(classDto, loadId) {
    if (loadId == null) return null;
    const list = listOf(await getJson(classPath(classDto, 'raw-data-process'))) ?? [];
    return list.find(p => p?.loadId === loadId) ?? null;
  }

  // The real endpoint ignores `latest` and its ordering is undocumented, so the whole list is scanned.
  async function findCurationForLoad(classDto, loadId) {
    if (loadId == null) return null;
    const list = listOf(await getJson(classPath(classDto, 'curated-data-process'))) ?? [];
    return list.find(p => p?.curationType === 'RAW_DATA_LOAD' && p.loadId === loadId) ?? null;
  }

  function assertResolved(dto) {
    if (!resolved.has(dto)) {
      throw new DcWriterError(E.UNRESOLVED_CLASS, `class '${dto.className}' was not obtained from resolveLiveClasses() on this writer`);
    }
  }

  const result = (dto, loadType, count, { load = null, process = null, curation = null } = {}) => ({
    skipped: load === null, className: dto.className, loadType, count, load, process, curation, stats: process?.stats ?? null,
  });

  async function submitLoad(dto, payload, loadType, { waitForCuration = true } = {}) {
    const registered = await getJson(loadUrl(LOADS), {
      method: 'POST', json: { classId: formClassId(dto), classType: 'DATA_CLASS', loadType },
    });
    const id = registered?.id;
    if (!isLoadId(id)) {
      throw new DcWriterError(E.LOAD_PATH_REFUSED, `load service returned an unusable load id ${JSON.stringify(id ?? null).slice(0, 80)}`);
    }
    const one = suffix => loadUrl(`${LOADS}/${id}${suffix}`);
    await request(one('/upload/json-file'), { method: 'POST', json: payload });
    await request(one('/process'), { method: 'POST' });

    const started = now();
    let load;
    for (;;) {
      load = await getJson(one(''));
      if (TERMINAL.has(load?.status)) break;
      if (now() - started >= cfg.processTimeoutMs) {
        throw new DcWriterError(E.PROCESS_TIMEOUT, `${loadType} load ${id} into ${dto.className} not finished after ${cfg.processTimeoutMs} ms`);
      }
      await sleep(cfg.pollIntervalMs);
    }
    if (load.status === 'Failed') {
      throw new DcWriterError(E.LOAD_FAILED, `${loadType} load ${id} into ${dto.className} failed`, { detail: JSON.stringify(load.log ?? null) });
    }

    // Stats are a nicety: the load itself already finished.
    const process = await rawProcessForLoad(dto, id).catch(error => {
      warn(`live-dc stats of ${dto.className} load ${id} unavailable: ${error.message}`);
      return null;
    });

    let curation = null;
    let curationLabel = 'skipped';
    if (waitForCuration) {
      const curationStarted = now();
      for (;;) {
        const c = await findCurationForLoad(dto, id);
        if (c && TERMINAL.has(c.status)) { curation = c; curationLabel = c.status; break; }
        if (now() - curationStarted >= cfg.curationTimeoutMs) {
          curationLabel = 'timeout';
          warn(`live-dc curation of ${dto.className} load ${id} not confirmed after ${cfg.curationTimeoutMs} ms`);
          break;
        }
        await sleep(cfg.pollIntervalMs);
      }
    }
    const s = process?.stats;
    const stats = s ? `new=${s.new ?? 0} updated=${s.updated ?? 0} notChanged=${s.notChanged ?? 0} invalid=${s.invalidRecords ?? 0}` : 'stats=n/a';
    info(`live-dc load ${dto.className} ${loadType} id=${id} n=${payload.length} ${stats} curation=${curationLabel}`);
    return result(dto, loadType, payload.length, { load, process, curation });
  }

  async function loadRecords(classDto, records, { loadType = 'Incremental', waitForCuration = true } = {}) {
    assertWritable(classDto, loadType);
    assertResolved(classDto);
    checkRecords(classDto, records);
    if (records.length === 0) return result(classDto, loadType, 0);
    return submitLoad(classDto, records, loadType, { waitForCuration });
  }

  async function resetLiveClass(classDto, { confirm } = {}) {
    assertWritable(classDto, 'Incremental');
    assertResolved(classDto);
    if (confirm !== classDto.className) {
      throw new DcWriterError(E.RESET_NOT_CONFIRMED, `reset of '${classDto.className}' needs confirm set to the exact class name`);
    }
    const keys = (await readAll(classDto)).map(item => item?.keyInSource).filter(k => typeof k === 'string' && k !== '');
    if (keys.length === 0) return result(classDto, 'Deletion', 0);
    return submitLoad(classDto, keys.map(keyInSource => ({ keyInSource })), 'Deletion');
  }

  const safeConfig = Object.freeze({
    ...cfg,
    accessToken: cfg.accessToken ? '***' : cfg.accessToken ?? '',
    clientSecret: cfg.clientSecret ? '***' : cfg.clientSecret ?? '',
  });

  return {
    config: safeConfig,
    listClasses, findClassByName, resolveLiveClasses, readAll, rawProcessForLoad, findCurationForLoad,
    loadRecords, resetLiveClass,
  };
}
