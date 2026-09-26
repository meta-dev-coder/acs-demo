/**
 * Framework-free request handler for the live-event API, so the same code serves both hosts:
 * Vite dev middleware (see vite.config.js) and the standalone node:http server (index.mjs).
 * The corridor network and the FL511 poller are created on the first request, which keeps a plain
 * `npm run dev` from contacting FL511 until the Live Events layer actually asks for data.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.mjs';
import { loadI595Network } from './i595Network.mjs';
import { createFl511Service, SOURCE_STATUS } from './fl511Service.mjs';
import { createLiveDcReadApi } from './liveDc/liveReadApi.mjs';
import { liveDcUnavailablePayload, readLiveDcEvents } from './liveDc/liveEventsFromDc.mjs';

export const API_BASE = '/api/i595/live-events';
const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');

export function createLiveEventsApi({ config = loadConfig(), dataDir = DEFAULT_DATA_DIR, logger = console, service, network, liveDc, now = Date.now } = {}) {
  let ready = null, networkReady = null, dcError = null;

  const loadNetwork = () => (networkReady ??= (network ? Promise.resolve(network) : loadI595Network(dataDir))
    .catch(error => { networkReady = null; throw error; }));
  const start = () => (ready ??= (async () => {
    const resolved = service ?? createFl511Service({ config, network: await loadNetwork(), logger });
    logger.log?.(`FL511 live events: ${config.baseUrl}, ${config.bufferMeters} m corridor buffer, ${config.refreshSeconds}s refresh`);
    return resolved;
  })().catch(error => { ready = null; throw error; }));

  /** `?source=dataconnect`: the Live Events class only. The direct FL511 feed is never a substitute. */
  async function fromDataConnect() {
    try {
      liveDc ??= createLiveDcReadApi({ logger });
      const payload = await readLiveDcEvents({ readApi: liveDc, network: await loadNetwork(), config, now: now() });
      dcError = null;
      return { status: 200, payload };
    } catch (error) {
      const reason = String(error?.message || 'DataConnect request failed.').slice(0, 200);
      if (dcError !== reason) logger.warn?.(`Live events: DataConnect unavailable (${reason})`);
      dcError = reason;
      return { status: 503, payload: liveDcUnavailablePayload(reason, { bufferMeters: config.bufferMeters }) };
    }
  }

  function send(response, statusCode, body) {
    const json = JSON.stringify(body);
    response.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(json),
      'cache-control': 'no-store',
      // Read-only, publicly derived corridor data; a separately hosted frontend must be able to read it.
      'access-control-allow-origin': '*',
    });
    response.end(json);
  }

  /** @returns {Promise<boolean>} whether this request belonged to the live-event API. */
  async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== API_BASE && !url.pathname.startsWith(`${API_BASE}/`)) return false;
    const type = url.pathname.slice(API_BASE.length).replace(/^\//, '');
    if (type && type !== 'incidents' && type !== 'closures') {
      send(response, 404, { error: 'Unknown live-events resource.' });
      return true;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, { error: 'Only GET is supported.' });
      return true;
    }
    try {
      const { status, payload } = url.searchParams.get('source') === 'dataconnect'
        ? await fromDataConnect() : { status: 200, payload: await (await start()).getI595LiveEvents() };
      if (!type) { send(response, status, payload); return true; }
      // Sub-resources are the same payload narrowed; the frontend uses the combined one.
      const wanted = type === 'incidents' ? 'INCIDENT' : 'CLOSURE';
      const events = payload.events.filter(event => event.type === wanted);
      send(response, status, { ...payload, counts: { ...payload.counts, total: events.length }, events });
    } catch (error) {
      logger.error?.('Live events request failed', error);
      // Never 500 into an empty map without saying why: the layer shows "unavailable", not "none".
      send(response, 503, {
        source: 'FL511', sourceStatus: SOURCE_STATUS.UNAVAILABLE, lastUpdated: null, lastSuccessfulUpdate: null,
        bufferMeters: config.bufferMeters, counts: { total: 0, incidents: 0, closures: 0 }, events: [],
        diagnostics: { lastError: error.message },
      });
    }
    return true;
  }

  return {
    handle,
    /** Express-style adapter for Vite's middleware stack. */
    middleware: (request, response, next) => { handle(request, response).then(handled => { if (!handled) next(); }, next); },
    async stop() { if (ready) (await ready).stop(); },
  };
}

// ---------------------------------------------------------------------------
// CCTV snapshot proxy  GET /api/i595/camera/:chanId/snapshot
// ---------------------------------------------------------------------------
// Scope guard: the Set of known divas_chan_ids is built at startup from the
// GeoJSON.  This means the endpoint can only serve cameras that are already
// in the I-595 corridor GeoJSON — it cannot be used as a general DIVAS proxy.
// ---------------------------------------------------------------------------

export const SNAPSHOT_BASE = '/api/i595/camera';
const SNAPSHOT_PATH_RE = /^\/api\/i595\/camera\/(\d+)\/snapshot$/;
const DIVAS_TIMEOUT_MS = 5_000;

/**
 * @param {{ dataDir?: string, logger?: typeof console }} options
 */
export function createSnapshotApi({ dataDir = DEFAULT_DATA_DIR, logger = console } = {}) {
  // Build the allowed-chanId Set from the GeoJSON at startup.
  // If the file is unreadable we fall back to an empty set (all requests → 503).
  let knownChanIds = new Set();
  try {
    const geojson = JSON.parse(readFileSync(join(dataDir, 'i595_corridor_cameras.geojson'), 'utf-8'));
    for (const f of geojson.features) {
      const id = f.properties?.divas_chan_id;
      if (typeof id === 'string' && /^\d+$/.test(id)) knownChanIds.add(id);
    }
    logger.log?.(`CCTV snapshot proxy: loaded ${knownChanIds.size} known DIVAS channel IDs from GeoJSON`);
  } catch (err) {
    logger.error?.('CCTV snapshot proxy: could not read GeoJSON — all snapshot requests will return 503', err);
  }

  function sendError(response, statusCode, message) {
    const body = JSON.stringify({ error: message });
    response.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    response.end(body);
  }

  /** @returns {Promise<boolean>} whether this request was handled */
  async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const match = SNAPSHOT_PATH_RE.exec(url.pathname);
    if (!match) return false;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendError(response, 405, 'Only GET is supported.');
      return true;
    }

    const chanId = match[1];

    // 1. Validate: digits only (already guaranteed by regex, but be explicit)
    if (!/^\d+$/.test(chanId)) {
      sendError(response, 400, 'Invalid channel ID.');
      return true;
    }

    // 2. Validate: must be a known I-595 camera (scope guard)
    if (!knownChanIds.has(chanId)) {
      sendError(response, 400, 'Unknown channel ID.');
      return true;
    }

    // 3. Proxy the JPEG snapshot from DIVAS with a 5 s timeout
    const divasUrl = `https://images-dis.divas.cloud/DGI/chan-${chanId}_h.jpg`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DIVAS_TIMEOUT_MS);
      let upstream;
      try {
        upstream = await fetch(divasUrl, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      if (!upstream.ok) {
        logger.warn?.(`CCTV snapshot: DIVAS returned ${upstream.status} for chan-${chanId}`);
        sendError(response, 502, 'snapshot unavailable');
        return true;
      }

      // Stream bytes through — avoid buffering the whole JPEG in memory
      const bytes = new Uint8Array(await upstream.arrayBuffer());
      response.writeHead(200, {
        'content-type': 'image/jpeg',
        'content-length': bytes.byteLength,
        'cache-control': 'no-store',
      });
      if (request.method !== 'HEAD') response.end(Buffer.from(bytes));
      else response.end();
    } catch (err) {
      logger.warn?.(`CCTV snapshot: fetch failed for chan-${chanId}: ${err.message}`);
      sendError(response, 502, 'snapshot unavailable');
    }
    return true;
  }

  return {
    handle,
    /** Express-style adapter for Vite's middleware stack. */
    middleware: (request, response, next) => { handle(request, response).then(handled => { if (!handled) next(); }, next); },
  };
}
