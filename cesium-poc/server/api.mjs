/**
 * Framework-free request handler for the live-event API, so the same code serves both hosts:
 * Vite dev middleware (see vite.config.js) and the standalone node:http server (index.mjs).
 * The corridor network and the FL511 poller are created on the first request, which keeps a plain
 * `npm run dev` from contacting FL511 until the Live Events layer actually asks for data.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.mjs';
import { loadI595Network } from './i595Network.mjs';
import { createFl511Service, SOURCE_STATUS } from './fl511Service.mjs';

export const API_BASE = '/api/i595/live-events';
const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');

export function createLiveEventsApi({ config = loadConfig(), dataDir = DEFAULT_DATA_DIR, logger = console, service } = {}) {
  let ready = null;

  const start = () => (ready ??= (async () => {
    const resolved = service ?? createFl511Service({ config, network: await loadI595Network(dataDir), logger });
    logger.log?.(`FL511 live events: ${config.baseUrl}, ${config.bufferMeters} m corridor buffer, ${config.refreshSeconds}s refresh`);
    return resolved;
  })().catch(error => { ready = null; throw error; }));

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
      const payload = await (await start()).getI595LiveEvents();
      if (!type) { send(response, 200, payload); return true; }
      // Sub-resources are the same payload narrowed; the frontend uses the combined one.
      const wanted = type === 'incidents' ? 'INCIDENT' : 'CLOSURE';
      const events = payload.events.filter(event => event.type === wanted);
      send(response, 200, { ...payload, counts: { ...payload.counts, total: events.length }, events });
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
