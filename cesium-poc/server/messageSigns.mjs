/** FL511 message signs: same-origin, corridor-filtered markers and on-demand detail. */
import { fileURLToPath } from 'node:url';
import { loadConfig, detailUrl } from './config.mjs';
import { loadI595Network } from './i595Network.mjs';

const BASE = '/api/i595/message-signs';
const textOf = html => String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ')
  .replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (match, key) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (named[key.toLowerCase()]) return named[key.toLowerCase()];
    const code = key.toLowerCase().startsWith('#x') ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  }).replace(/\s+/g, ' ').trim();

export function parseMessageSignDetail(html) {
  const cells = [...String(html).matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)];
  const messageCell = cells.find(([ , attributes]) => /\bmsgContent\b/i.test(attributes));
  if (!messageCell) throw new Error('Unrecognized FL511 message sign detail.');
  const titleCell = cells.find(([, , body]) => /<b\b/i.test(body));
  const index = cells.indexOf(messageCell);
  return {
    title: titleCell ? textOf(titleCell[2]) : null,
    message: textOf(messageCell[2]),
    updatedAt: cells[index + 1] ? textOf(cells[index + 1][2]) : null,
  };
}

export function normalizeMessageSigns(payload, network, bufferMeters = 250) {
  if (!Array.isArray(payload?.item2)) throw new Error('Invalid FL511 message signs feed.');
  const seen = new Set();
  return payload.item2.flatMap(item => {
    const id = String(item.itemId ?? '');
    const [latitude, longitude] = item.location ?? [];
    if (!/^\d+$/.test(id) || seen.has(id) || !Number.isFinite(latitude) || !Number.isFinite(longitude)
      || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return [];
    seen.add(id);
    const association = network.associate(longitude, latitude);
    if (association.distanceToNetworkM == null || association.distanceToNetworkM > bufferMeters) return [];
    return [{ id, latitude, longitude, title: textOf(item.title || '') || `Message Sign ${id}`, ...association }];
  });
}

export function createMessageSignsApi({ config = loadConfig(), fetchImpl = fetch, network,
  dataDir = fileURLToPath(new URL('../public/data/', import.meta.url)), now = Date.now } = {}) {
  let networkPromise, cached, pending;
  const details = new Map(), detailPending = new Map();
  const ttl = config.refreshSeconds * 1000;
  async function request(url, json) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(config.requestTimeoutMs), headers: { 'user-agent': config.userAgent } });
    if (!response.ok) throw new Error(`FL511 returned ${response.status}`);
    return json ? response.json() : response.text();
  }
  async function getSigns() {
    if (cached && now() - cached.time < ttl) return { ...cached.payload, sourceStatus: 'LIVE' };
    pending ??= (async () => {
      networkPromise ??= network ? Promise.resolve(network) : loadI595Network(dataDir).catch(error => { networkPromise = null; throw error; });
      const geometry = await networkPromise;
      const raw = await request(`${config.baseUrl}${config.messageSignsPath || '/map/mapIcons/MessageSigns'}`, true);
      const signs = normalizeMessageSigns(raw, geometry, config.bufferMeters);
      const payload = { source: 'FL511', sourceStatus: 'LIVE', fetchedAt: new Date(now()).toISOString(), bufferMeters: config.bufferMeters, signs };
      cached = { time: now(), payload };
      return payload;
    })().catch(error => {
      if (cached) return { ...cached.payload, sourceStatus: 'STALE' };
      throw error;
    }).finally(() => { pending = null; });
    return pending;
  }
  async function getDetail(id) {
    const list = await getSigns();
    if (!list.signs.some(sign => sign.id === id)) return null;
    const previous = details.get(id);
    if (previous && now() - previous.time < ttl) return previous.payload;
    if (!detailPending.has(id)) {
      detailPending.set(id, request(detailUrl(config, 'MessageSigns', id), false).then(html => {
        const payload = { id, ...parseMessageSignDetail(html), source: 'FL511', sourceStatus: 'LIVE', fetchedAt: new Date(now()).toISOString() };
        details.set(id, { time: now(), payload });
        return payload;
      }).catch(error => {
        if (previous) return { ...previous.payload, sourceStatus: 'STALE' };
        throw error;
      }).finally(() => detailPending.delete(id)));
    }
    return detailPending.get(id);
  }
  async function handle(req, res) {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return false;
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(payload));
    };
    if (!['GET', 'HEAD'].includes(req.method)) { send(405, { error: 'Only GET is supported.' }); return true; }
    const id = pathname === BASE ? null : pathname.slice(BASE.length + 1);
    if (id !== null && !/^\d+$/.test(id)) { send(404, { error: 'Unknown message sign resource.' }); return true; }
    try {
      const payload = id === null ? await getSigns() : await getDetail(id);
      send(payload ? 200 : 404, payload ?? { error: 'Message sign is outside the corridor or unknown.' });
    } catch {
      send(503, { source: 'FL511', sourceStatus: 'UNAVAILABLE', error: 'FL511 message signs are unavailable. Please retry.' });
    }
    return true;
  }
  return { handle, middleware: (req, res, next) => { handle(req, res).then(handled => { if (!handled) next(); }, next); } };
}
