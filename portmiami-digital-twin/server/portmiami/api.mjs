/**
 * The PortMiami live-traffic read API.
 *
 * Framework-free, in the ACS twin's pattern (`cesium-poc/server/api.mjs`), so the same handlers
 * serve both hosts: Vite dev/preview middleware (vite.config.js) and the standalone node:http
 * server (server/index.mjs). The service is created on the FIRST REQUEST, which keeps a plain
 * `npm run dev` from contacting FL511 until the Live Traffic layer actually asks for data.
 *
 * Read-only. Nothing here mutates the GIS. Every response is JSON except the snapshot proxy,
 * which is a JPEG.
 *
 * One route takes a POST: `/api/portmiami/ask`, which classifies a free-form question into one of
 * Ask the Twin's fixed intents. It is still read-only — it writes nothing and reads no record; it
 * exists so the model API key stays on the server. See askInterpreter.mjs for why a model cannot
 * inject a fact through it.
 */
import { loadFl511Config } from '../fl511/config.mjs';
import { LAYERS } from '../fl511/client.mjs';
import { DEFAULT_REGION } from './region.mjs';
import { DEFAULT_ROADS_PATH, loadRoadNetwork } from './roadAssociation.mjs';
import { createLiveTrafficService } from './service.mjs';
import { describeCamera } from './cameras.mjs';
import { describeMessageSign, parseMessageSignDetail } from './messageSigns.mjs';
import { parseCarouselCameras } from '../fl511/tooltip.mjs';
import { interpretQuestion } from './askInterpreter.mjs';
import {
  GEOMETRY_SOURCE, VERIFICATION_STATUS, assetExists, createGeometryStore, validateGeometry,
} from './geometryStore.mjs';

export const API_BASE = '/api/portmiami';

/**
 * Which stored geometry the app should draw.
 *
 * The documented priority, in one place so the server and the browser cannot disagree:
 * authoritative first, then a reviewer-confirmed GIS footprint, then a reviewer-confirmed traced
 * outline, and a candidate only when nothing confirmed exists. A candidate can never displace a
 * confirmed record.
 */
export function pickActive(rows = []) {
  const rank = row => {
    if (row.verificationStatus === 'AUTHORITATIVE') return 0;
    if (row.verificationStatus === 'USER_CONFIRMED' && row.geometrySource === 'BUILDING_GEOJSON') return 1;
    if (row.verificationStatus === 'USER_CONFIRMED' && row.geometrySource === 'MANUALLY_DIGITIZED') return 2;
    if (row.verificationStatus === 'USER_CONFIRMED') return 3;
    return 4;
  };
  return [...rows].sort((a, b) => rank(a) - rank(b)
    || String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] ?? null;
}
const SNAPSHOT_BASE = `${API_BASE}/camera`;
const SNAPSHOT_RE = new RegExp(`^${SNAPSHOT_BASE}/(\\d+)/snapshot$`);
const IMAGE_TIMEOUT_MS = 5_000;
/** The still-image host DIVAS serves FL511's cameras from, as ACS's proxy already uses. */
const IMAGE_HOST = 'https://images-dis.divas.cloud/DGI';

/**
 * Geometry writes are OFF unless an operator turns them on, and then only from this machine.
 *
 * This application has no users, no sessions and no authentication. An earlier draft gated writes
 * on a token the browser sent — which would have meant shipping the server's own secret inside
 * the JavaScript bundle, where anyone who can load the page can read it. That is not authorisation;
 * it is a secret in public. It was removed.
 *
 * What replaces it carries no secret at all: `PORTMIAMI_GEOMETRY_EDIT=local` enables writing, and
 * the request must arrive from a loopback address. That is a trusted-local-environment switch — it
 * suits the demonstration this is built for and nothing more. On a shared host, leave it unset:
 * reads keep working, writes answer 403 with the reason, and the planner shows a read-only state.
 *
 * Editing on a shared deployment needs the sign-in this application does not have. Until then
 * there is no configuration here that makes it safe, and none is offered.
 */
export const EDIT_MODE = Object.freeze({ OFF: 'off', LOCAL: 'local' });

const editMode = (env = process.env) =>
  ((env.PORTMIAMI_GEOMETRY_EDIT ?? '').trim().toLowerCase() === EDIT_MODE.LOCAL
    ? EDIT_MODE.LOCAL : EDIT_MODE.OFF);

/** Loopback only: 127.0.0.0/8, ::1, and the IPv4-mapped form Node reports. */
export function isLoopback(address) {
  const value = String(address ?? '');
  return value === '::1'
    || value === '127.0.0.1'
    || /^::ffff:127\./.test(value)
    || /^127\./.test(value);
}

export function createLiveTrafficApi({
  config = loadFl511Config(), region = DEFAULT_REGION, roadsPath = DEFAULT_ROADS_PATH,
  service, network, logger = console, fetchImpl = fetch,
  geometryStore = createGeometryStore(), env = process.env,
} = {}) {
  let ready = null, roadNetwork = network ?? null;
  /** camera id -> its detail, once read. Also the snapshot proxy's scope guard. */
  const cameraDetails = new Map();
  const signDetails = new Map();
  /** Only channels FL511 itself published, for cameras inside the study area, may be proxied. */
  const allowedChannels = new Set();

  const start = () => (ready ??= (async () => {
    if (service) return service;
    const roads = roadNetwork ?? await loadRoadNetwork(roadsPath);
    roadNetwork = roads;
    const probe = await geometryStore.writable?.();
    logger.log?.(`[PortMiami] asset geometry: ${geometryStore.path}`
      + ` (editing ${editMode(env)}${probe && !probe.ok ? `, NOT WRITABLE: ${probe.reason}` : ''})`);
    logger.log?.(`[PortMiami] live traffic: ${config.baseUrl}, study area `
      + `${JSON.stringify(region.bbox)}, ${roads.count} road segments, `
      + `${config.refreshSeconds}s events / ${config.assetRefreshSeconds}s cameras+signs`);
    return createLiveTrafficService({ config, region, network: roads, logger });
  })().catch(error => { ready = null; throw error; }));

  function sendJson(response, status, body) {
    const json = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(json),
      'cache-control': 'no-store',
      // Read-only, publicly derived data; a separately hosted frontend must be able to read it.
      'access-control-allow-origin': '*',
    });
    response.end(json);
  }

  /** One camera's detail fragment, cached for the detail TTL. */
  async function cameraDetail(id) {
    const list = await (await start()).getCameras();
    const camera = list.cameras.find(entry => entry.id === id);
    if (!camera) return null;
    const cached = cameraDetails.get(id);
    if (cached && Date.now() - cached.at < config.detailTtlSeconds * 1000) return cached.payload;
    let payload;
    try {
      const { createFl511Client } = await import('../fl511/client.mjs');
      const client = createFl511Client(config, { fetchImpl, logger });
      const html = await client.fetchDetailHtml(LAYERS.CAMERA, id);
      payload = describeCamera(camera, parseCarouselCameras(html),
        { snapshotBase: SNAPSHOT_BASE, network: roadNetwork });
    } catch (error) {
      logger.warn?.(`[PortMiami] camera detail ${id} failed: ${error.message}`);
      // The camera is still real and still placeable; only its feed is unknown.
      return cached?.payload ?? { ...camera, detailError: 'FL511 did not return this camera’s details.' };
    }
    if (payload.divasChannel) allowedChannels.add(String(payload.divasChannel));
    cameraDetails.set(id, { at: Date.now(), payload });
    return payload;
  }

  /** One sign's current message. */
  async function signDetail(id) {
    const list = await (await start()).getMessageSigns();
    const sign = list.signs.find(entry => entry.id === id);
    if (!sign) return null;
    const cached = signDetails.get(id);
    if (cached && Date.now() - cached.at < config.detailTtlSeconds * 1000) return cached.payload;
    try {
      const { createFl511Client } = await import('../fl511/client.mjs');
      const client = createFl511Client(config, { fetchImpl, logger });
      const html = await client.fetchDetailHtml(LAYERS.MESSAGE_SIGN, id);
      const payload = describeMessageSign(sign, parseMessageSignDetail(html), { network: roadNetwork });
      signDetails.set(id, { at: Date.now(), payload });
      return payload;
    } catch (error) {
      logger.warn?.(`[PortMiami] message sign detail ${id} failed: ${error.message}`);
      return cached?.payload
        ?? { ...sign, detailError: 'FL511 did not return this sign’s current message.' };
    }
  }

  /**
   * The snapshot proxy. Scope-guarded exactly as the ACS one is, but the allowed set is built from
   * channels FL511 published for cameras CURRENTLY IN THE STUDY AREA and already resolved through
   * the detail endpoint — so this cannot be used as a general image proxy for arbitrary channels.
   */
  async function snapshot(request, response, channel) {
    if (!allowedChannels.has(channel)) {
      // Resolving every study-area camera is ten requests at most, and only on a cold first ask.
      const list = await (await start()).getCameras();
      await Promise.all(list.cameras.map(camera => cameraDetail(camera.id).catch(() => null)));
    }
    if (!allowedChannels.has(channel)) {
      sendJson(response, 400, { error: 'Unknown camera channel for this study area.' });
      return;
    }
    try {
      const upstream = await fetchImpl(`${IMAGE_HOST}/chan-${channel}_h.jpg`,
        { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
      const type = upstream.headers.get('content-type') ?? '';
      // A 404 or an HTML error page is a genuinely unavailable feed, which the UI must show as
      // unavailable rather than as a broken image.
      if (!upstream.ok || !type.startsWith('image/')) {
        logger.warn?.(`[PortMiami] snapshot chan-${channel}: ${upstream.status} ${type}`);
        sendJson(response, 502, { error: 'This camera’s image feed is not available from the source.' });
        return;
      }
      const bytes = Buffer.from(await upstream.arrayBuffer());
      response.writeHead(200, {
        'content-type': 'image/jpeg', 'content-length': bytes.byteLength, 'cache-control': 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      logger.warn?.(`[PortMiami] snapshot chan-${channel} failed: ${error.message}`);
      sendJson(response, 502, { error: 'This camera’s image feed could not be reached.' });
    }
  }

  const unavailable = reason => ({
    source: 'FL511', sourceStatus: 'UNAVAILABLE', region: { id: region.id, name: region.name, bbox: region.bbox },
    lastSuccessfulUpdate: null, counts: { total: 0 }, events: [], cameras: [], signs: [],
    diagnostics: { lastError: reason },
  });

  /** @returns {Promise<boolean>} whether this request belonged to the live-traffic API. */
  /** Read a small JSON body. Capped, because this endpoint only ever receives one sentence. */
  async function readBody(request, { maxBytes = 4096 } = {}) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maxBytes) return null;
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
  }

  /** Is this request allowed to change geometry? */
  function mayWrite(request) {
    if (editMode(env) !== EDIT_MODE.LOCAL) {
      return {
        ok: false, status: 403,
        reason: 'Geometry editing is disabled. This deployment has no user accounts, so writes stay '
          + 'off until an operator sets PORTMIAMI_GEOMETRY_EDIT=local on a trusted machine. '
          + 'Reading geometry is unaffected.',
      };
    }
    const address = request.socket?.remoteAddress;
    if (!isLoopback(address)) {
      return {
        ok: false, status: 403,
        reason: 'Geometry editing is enabled for this machine only; this request came from '
          + `${address ?? 'an unknown address'}.`,
      };
    }
    return { ok: true };
  }

  /** What the UI should say about its own permissions. */
  const writeStatus = request => {
    const allowed = mayWrite(request);
    return {
      writable: allowed.ok,
      readOnlyReason: allowed.ok ? null : allowed.reason,
      editMode: editMode(env),
    };
  };

  /** GET / POST / PUT / DELETE for one asset's geometry. */
  async function handleGeometry(request, response, assetId, geometryId) {
    if (!assetExists(assetId)) {
      sendJson(response, 404, { ok: false, reason: `No infrastructure asset "${assetId}".` });
      return;
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      const rows = await geometryStore.list(assetId);
      sendJson(response, 200, {
        ok: true,
        assetId,
        geometries: rows,
        // The one the app should draw, by the documented priority.
        active: pickActive(rows),
        ...writeStatus(request),
      });
      return;
    }

    const allowed = mayWrite(request);
    if (!allowed.ok) {
      sendJson(response, allowed.status, { ok: false, reason: allowed.reason });
      return;
    }

    if (request.method === 'DELETE') {
      if (!geometryId) {
        sendJson(response, 400, { ok: false, reason: 'A geometry id is required to delete one.' });
        return;
      }
      const result = await geometryStore.remove(assetId, geometryId);
      if (!result.ok) {
        sendJson(response, result.reason === 'PROTECTED' ? 409 : 404, {
          ok: false,
          reason: result.reason === 'PROTECTED'
            ? 'That record is AUTHORITATIVE and is not deletable through this endpoint.'
            : 'No such geometry for this asset.',
        });
        return;
      }
      sendJson(response, 200, { ok: true, removed: result.removed.id });
      return;
    }

    const body = await readBody(request, { maxBytes: 512 * 1024 });
    if (!body) {
      sendJson(response, 400, { ok: false, reason: 'A JSON body is required.' });
      return;
    }

    if (request.method === 'POST') {
      const check = validateGeometry(body.geometry);
      if (!check.ok) { sendJson(response, 422, { ok: false, reason: check.reason }); return; }
      const source = GEOMETRY_SOURCE[body.geometrySource] ?? null;
      const status = VERIFICATION_STATUS[body.verificationStatus] ?? null;
      if (!source || !status) {
        sendJson(response, 422, {
          ok: false,
          reason: 'geometrySource and verificationStatus must be among '
            + `${Object.keys(GEOMETRY_SOURCE).join('/')} and ${Object.keys(VERIFICATION_STATUS).join('/')}.`,
        });
        return;
      }
      const row = await geometryStore.save(assetId, {
        geometry: body.geometry,
        geometrySource: source,
        verificationStatus: status,
        heightM: Number.isFinite(Number(body.heightM)) ? Number(body.heightM) : null,
        heightSource: typeof body.heightSource === 'string' ? body.heightSource.slice(0, 120) : null,
        buildingObjectIds: Array.isArray(body.buildingObjectIds)
          ? body.buildingObjectIds.map(Number).filter(Number.isInteger).slice(0, 50) : [],
        sourceReference: typeof body.sourceReference === 'string' ? body.sourceReference.slice(0, 500) : null,
      });
      sendJson(response, 201, { ok: true, geometry: row });
      return;
    }

    if (request.method === 'PUT') {
      if (!geometryId) {
        sendJson(response, 400, { ok: false, reason: 'A geometry id is required to update one.' });
        return;
      }
      if (body.geometry) {
        const check = validateGeometry(body.geometry);
        if (!check.ok) { sendJson(response, 422, { ok: false, reason: check.reason }); return; }
      }
      if (body.verificationStatus && !VERIFICATION_STATUS[body.verificationStatus]) {
        sendJson(response, 422, { ok: false, reason: 'Unknown verificationStatus.' });
        return;
      }
      const row = await geometryStore.update(assetId, geometryId, body);
      if (!row) { sendJson(response, 404, { ok: false, reason: 'No such geometry for this asset.' }); return; }
      sendJson(response, 200, { ok: true, geometry: row });
      return;
    }

    sendJson(response, 405, { ok: false, reason: 'Geometry supports GET, POST, PUT and DELETE.' });
  }

  async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const { pathname } = url;
    if (pathname !== API_BASE && !pathname.startsWith(`${API_BASE}/`)) return false;

    // The one POST: question in, intent out. No data, no map action, no write.
    if (pathname === `${API_BASE}/ask`) {
      if (request.method !== 'POST') {
        sendJson(response, 405, { ok: false, reason: 'Ask the Twin interpretation is a POST.' });
        return true;
      }
      const body = await readBody(request);
      const { status, body: payload } = await interpretQuestion(body?.question, { fetchImpl });
      sendJson(response, status, payload);
      return true;
    }

    // ---- asset geometry: the only read/write resource this API has ---------------------------
    // The segments are matched loosely and decoded, because a geometry id carries an ISO
    // timestamp whose colons arrive percent-encoded. Matching the raw path against a character
    // class silently missed every DELETE and PUT, which then fell through to "only GET".
    const geometryRoute = /^\/api\/portmiami\/assets\/([^/]{1,200})\/geometry(?:\/([^/]{1,300}))?$/
      .exec(pathname);
    if (geometryRoute) {
      const decode = value => {
        if (value === undefined) return null;
        try { return decodeURIComponent(value); } catch { return value; }
      };
      await handleGeometry(request, response, decode(geometryRoute[1]), decode(geometryRoute[2]));
      return true;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: 'Only GET is supported.' });
      return true;
    }

    const snapshotMatch = SNAPSHOT_RE.exec(pathname);
    try {
      if (snapshotMatch) {
        await snapshot(request, response, snapshotMatch[1]);
        return true;
      }
      const route = pathname.slice(API_BASE.length).replace(/^\//, '');
      const api = await start();

      if (route === 'live-events') { sendJson(response, 200, await api.getEvents()); return true; }
      if (route === 'cameras') { sendJson(response, 200, await api.getCameras()); return true; }
      if (route === 'message-signs') { sendJson(response, 200, await api.getMessageSigns()); return true; }

      const camera = /^cameras\/(\d+)$/.exec(route);
      if (camera) {
        const payload = await cameraDetail(camera[1]);
        sendJson(response, payload ? 200 : 404,
          payload ?? { error: 'This camera is not in the PortMiami study area.' });
        return true;
      }
      const sign = /^message-signs\/(\d+)$/.exec(route);
      if (sign) {
        const payload = await signDetail(sign[1]);
        sendJson(response, payload ? 200 : 404,
          payload ?? { error: 'This message sign is not in the PortMiami study area.' });
        return true;
      }
      sendJson(response, 404, { error: 'Unknown live-traffic resource.' });
    } catch (error) {
      logger.error?.('[PortMiami] live-traffic request failed', error);
      // Never 503 into an empty map without saying why: the layer shows "unavailable", not "none".
      sendJson(response, 503, unavailable(error.message));
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
