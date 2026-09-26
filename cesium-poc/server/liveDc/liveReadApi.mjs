/**
 * Read-only proxy for the "SDNA Florida I595 Live *" classes, same-origin at /api/live-dc.
 *
 * Forwards only the class list and curated-data reads to LIVE_DC_READ_BASE_URL (DataConnect; unset
 * means not configured). Classes are resolved by exact Live name; a historical or unknown class id is refused
 * before any upstream call. Tokens stay on this side and never reach a response or a log line.
 *
 *   GET  /api/live-dc/status                       -> {available, baseUrl, classes, missing}
 *   GET  /api/live-dc/classes                      -> {classes:[{id, classId, className, key}]}
 *   POST /api/live-dc/class/:id/curated-data       -> {data, totalCount}
 */
import { HISTORICAL_CLASS_IDS, HISTORICAL_NUMERIC_CLASS_IDS, LIVE_CLASS, isLiveClassName } from './classes.mjs';
import { createClientCredentialsTokenProvider, createStaticTokenProvider, createTokenFileProvider } from './dcWriter.mjs';

const BASE = '/api/live-dc';
const SAFE_PATH = /^\/[^@]*$/;
const KEY_BY_NAME = new Map(Object.entries(LIVE_CLASS).map(([key, name]) => [name, key]));
export const LIVE_DC_KEYS = Object.freeze(Object.keys(LIVE_CLASS));

const positive = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);

export function loadLiveDcReadConfig(env = process.env) {
  const dataMgmtPrefix = env.LIVE_DC_READ_DATA_MGMT_PREFIX || '/api/data-mgmt/v1';
  if (!SAFE_PATH.test(dataMgmtPrefix)) throw new Error("LIVE_DC_READ_DATA_MGMT_PREFIX must start with '/' and contain no '@'");
  return {
    baseUrl: (env.LIVE_DC_READ_BASE_URL || '').replace(/\/+$/, ''),
    dataMgmtPrefix,
    accessToken: env.LIVE_DC_READ_ACCESS_TOKEN || '',
    accessTokenFile: env.LIVE_DC_READ_ACCESS_TOKEN_FILE || '',
    clientId: env.LIVE_DC_READ_CLIENT_ID || '',
    clientSecret: env.LIVE_DC_READ_CLIENT_SECRET || '',
    scope: env.LIVE_DC_READ_SCOPE || 'itwin-platform',
    tokenUrl: env.LIVE_DC_READ_TOKEN_URL || 'https://ims.bentley.com/connect/token',
    timeoutMs: positive(env.LIVE_DC_READ_TIMEOUT_MS, 15_000),
    maxPageSize: positive(env.LIVE_DC_READ_MAX_PAGE_SIZE, 500),
    classCacheMs: positive(env.LIVE_DC_READ_CLASS_CACHE_MS, 60_000),
    // The sync's heartbeat (tools/live-dc-sync.mjs), which sets when DataConnect live events read as STALE.
    heartbeatSeconds: env.LIVE_DC_HEARTBEAT_SECONDS !== undefined && env.LIVE_DC_HEARTBEAT_SECONDS !== ''
      && Number(env.LIVE_DC_HEARTBEAT_SECONDS) >= 0 ? Number(env.LIVE_DC_HEARTBEAT_SECONDS) : 900,
  };
}

function tokenProviderFor(config, fetchImpl) {
  if (config.accessToken) return createStaticTokenProvider(config.accessToken);
  if (config.accessTokenFile) return createTokenFileProvider(config.accessTokenFile, { label: 'Live DataConnect' });
  if (config.clientId && config.clientSecret) {
    return createClientCredentialsTokenProvider({
      tokenUrl: config.tokenUrl, clientId: config.clientId, clientSecret: config.clientSecret, scope: config.scope, fetchImpl,
    });
  }
  return null;
}

const fail = (status, error, code) => Object.assign(new Error(error), { status, code });

export function createLiveDcReadApi({ config = loadLiveDcReadConfig(), fetchImpl = fetch, now = Date.now, logger = console } = {}) {
  const tokens = tokenProviderFor(config, fetchImpl);
  const origin = (() => { try { const { origin } = new URL(config.baseUrl); return origin === 'null' ? null : origin; } catch { return null; } })();
  let cache = null;

  async function upstream(path, { method = 'GET', json } = {}) {
    if (!tokens || !origin) throw fail(503, 'Live DataConnect read access is not configured on the server.', 'unconfigured');
    const url = `${config.baseUrl}${config.dataMgmtPrefix}${path}`;
    if (new URL(url).origin !== origin) throw fail(502, 'Refused a request outside the configured origin.');
    let response;
    try {
      response = await fetchImpl(url, {
        method, redirect: 'manual',
        headers: {
          authorization: `Bearer ${await tokens.getToken()}`, accept: 'application/json',
          ...(json ? { 'content-type': 'application/json' } : {}),
        },
        body: json ? JSON.stringify(json) : undefined,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      if (error?.status) throw error;
      throw fail(503, 'Live DataConnect is unavailable.', error?.name === 'TimeoutError' ? 'timeout' : 'unreachable');
    }
    if (response.status === 401) tokens.invalidate?.();
    if (!response.ok) throw fail(502, `Live DataConnect returned ${response.status}.`, 'upstream');
    return response.json();
  }

  /** Live classes by exact name; a name that matches twice, or a historical id, is left out. */
  async function liveClasses({ refresh = false } = {}) {
    if (!refresh && cache && now() - cache.at < config.classCacheMs) return cache.list;
    const payload = await upstream('/class');
    const all = Array.isArray(payload) ? payload : payload?.data ?? payload?.classes ?? [];
    const list = all
      .filter(c => isLiveClassName(c?.className) && typeof c.id === 'string')
      .filter(c => !HISTORICAL_CLASS_IDS.has(c.id) && !HISTORICAL_NUMERIC_CLASS_IDS.has(c.classId))
      .filter((c, _, kept) => kept.filter(o => o.className === c.className).length === 1)
      .map(c => ({ id: c.id, classId: c.classId ?? null, className: c.className, key: KEY_BY_NAME.get(c.className) }));
    cache = { at: now(), list };
    return list;
  }

  async function curatedData(id, body) {
    let target = (await liveClasses()).find(c => c.id === id);
    if (!target) target = (await liveClasses({ refresh: true })).find(c => c.id === id);
    if (!target) throw fail(403, 'Only the SDNA Florida I595 Live classes can be read here.', 'not_live');
    const page = Math.max(0, Number.parseInt(body?.page ?? 0, 10) || 0);
    const pageSize = Math.min(config.maxPageSize, Math.max(1, Number.parseInt(body?.pageSize ?? config.maxPageSize, 10) || config.maxPageSize));
    const filters = Array.isArray(body?.filters) ? body.filters : [];
    const sortField = typeof body?.sort?.field === 'string' ? body.sort.field.trim() : '';
    const sort = sortField ? { field: sortField, direction: String(body.sort.direction).toLowerCase() === 'desc' ? 'desc' : 'asc' } : null;
    const payload = await upstream(`/class/${encodeURIComponent(target.id)}/curated-data?includeDescendants=false`,
      { method: 'POST', json: { page, pageSize, filters, ...(sort ? { sort } : {}) } });
    const data = (Array.isArray(payload?.data) ? payload.data : []).filter(item => !item?.className || item.className === target.className);
    return { data, totalCount: Number(payload?.totalCount ?? data.length) };
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return false;
    const send = (status, payload) => {
      if (!req.readableEnded) req.resume();
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(payload));
    };
    const route = url.pathname.slice(BASE.length);
    const curated = /^\/class\/([^/]+)\/curated-data$/.exec(route);
    try {
      if (route === '/status' || route === '/classes') {
        if (req.method !== 'GET' && req.method !== 'HEAD') { send(405, { error: 'Live DataConnect is read-only.' }); return true; }
        if (route === '/classes') { send(200, { classes: await liveClasses() }); return true; }
        try {
          const classes = await liveClasses({ refresh: true });
          const found = new Set(classes.map(c => c.className));
          send(200, { available: true, baseUrl: origin, classes: classes.length, missing: [...KEY_BY_NAME.keys()].filter(n => !found.has(n)) });
        } catch (error) {
          send(200, { available: false, baseUrl: origin, error: error.message, code: error.code ?? null });
        }
        return true;
      }
      if (curated) {
        if (req.method !== 'POST') { send(405, { error: 'Live DataConnect is read-only.' }); return true; }
        let id;
        try { id = decodeURIComponent(curated[1]); } catch { throw fail(400, 'Malformed class id.', 'bad_request'); }
        send(200, await curatedData(id, await readJson(req)));
        return true;
      }
      send(req.method === 'GET' ? 404 : 405, { error: 'Unknown or non-read Live DataConnect route.' });
    } catch (error) {
      const status = Number(error?.status) || 502;
      logger.warn?.('[live-dc] request failed', { route, status, message: error?.message });
      send(status, { error: error?.message ?? 'Live DataConnect request failed.', code: error?.code ?? null });
    }
    return true;
  }

  return {
    config: Object.freeze({ ...config, accessToken: config.accessToken ? '***' : '', clientSecret: config.clientSecret ? '***' : '' }),
    liveClasses, curatedData, handle,
    middleware: (req, res, next) => { handle(req, res).then(handled => { if (!handled) next(); }, next); },
  };
}

const MAX_BODY_BYTES = 64 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    const onData = chunk => {
      raw += chunk;
      if (raw.length <= MAX_BODY_BYTES) return;
      raw = '';
      req.off('data', onData);
      reject(fail(413, 'Request body too large.', 'too_large'));
    };
    req.on('data', onData);
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
