/**
 * The only module that talks to FL511. These are publicly reachable but undocumented endpoints
 * belonging to FL511's own website, so every response is validated before it is trusted, a single
 * malformed item never fails the feed, and failures surface as thrown errors the service turns
 * into cached/stale answers instead of empty maps.
 */
import { detailUrl } from './config.mjs';
import { isValidLatLon } from './geo.mjs';
import { parseTooltipHtml } from './fl511Tooltip.mjs';

export const LAYERS = Object.freeze({ INCIDENT: 'Incidents', CLOSURE: 'Closures' });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** FL511 sends [latitude, longitude]; we keep lon/lat ordering internally, as our GeoJSON does. */
function readPoint(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const latitude = Number(value[0]), longitude = Number(value[1]);
  return isValidLatLon(latitude, longitude) ? { latitude, longitude } : null;
}

/**
 * Validate one mapIcons payload. Unknown extra keys are ignored so an FL511 schema addition is
 * harmless; a missing item2 array is a schema change we refuse to guess around.
 * @returns {{items: object[], skipped: {itemId?: string, reason: string}[]}}
 */
export function parseMapIcons(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('FL511 response was not a JSON object.');
  if (!Array.isArray(payload.item2)) throw new Error('FL511 response is missing the item2 array.');
  const items = [], skipped = [], seen = new Set();
  for (const entry of payload.item2) {
    if (!entry || typeof entry !== 'object') { skipped.push({ reason: 'entry is not an object' }); continue; }
    const itemId = entry.itemId == null ? '' : String(entry.itemId).trim();
    if (!itemId) { skipped.push({ reason: 'missing itemId' }); continue; }
    if (seen.has(itemId)) { skipped.push({ itemId, reason: 'duplicate itemId' }); continue; }
    const primary = readPoint(entry.location);
    if (!primary) { skipped.push({ itemId, reason: 'missing or invalid location' }); continue; }
    seen.add(itemId);
    const secondary = readPoint(entry.secondarylocation ?? entry.secondaryLocation);
    items.push({
      itemId,
      latitude: primary.latitude, longitude: primary.longitude,
      ...(secondary ? { secondaryLatitude: secondary.latitude, secondaryLongitude: secondary.longitude } : {}),
      ...(typeof entry.title === 'string' && entry.title.trim() ? { title: entry.title.trim() } : {}),
    });
  }
  return { items, skipped };
}

export function createFl511Client(config, { fetchImpl = fetch, logger = console } = {}) {
  async function request(url, accept) {
    let lastError;
    for (let attempt = 1; attempt <= config.retryAttempts; attempt++) {
      try {
        const response = await fetchImpl(url, {
          headers: { accept, 'user-agent': config.userAgent },
          signal: AbortSignal.timeout(config.requestTimeoutMs),
          redirect: 'follow',
        });
        // 4xx means FL511 is answering us deliberately (gone, blocked, rate limited): stop asking.
        if (response.status >= 400 && response.status < 500) {
          throw Object.assign(new Error(`FL511 responded ${response.status} for ${url}`), { fatal: true });
        }
        if (!response.ok) throw new Error(`FL511 responded ${response.status} for ${url}`);
        return response;
      } catch (error) {
        lastError = error;
        if (error.fatal || attempt === config.retryAttempts) break;
        await sleep(config.retryDelayMs);
      }
    }
    throw lastError;
  }

  async function fetchLayer(path, layerId) {
    const url = `${config.baseUrl}${path}`;
    const response = await request(url, 'application/json');
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`FL511 ${layerId} response was not valid JSON.`);
    }
    const { items, skipped } = parseMapIcons(payload);
    if (skipped.length) logger.warn?.(`FL511 ${layerId}: skipped ${skipped.length} malformed item(s)`, skipped.slice(0, 5));
    return items;
  }

  return {
    fetchIncidents: () => fetchLayer(config.incidentsPath, LAYERS.INCIDENT),
    fetchClosures: () => fetchLayer(config.closuresPath, LAYERS.CLOSURE),
    /**
     * Marker detail, from the endpoint FL511's own map declares as data-tooltipbaseurl.
     * Returns null (never a partial guess) when the fragment cannot be recognised.
     */
    async fetchEventDetails(layerId, itemId) {
      const response = await request(detailUrl(config, layerId, itemId), 'text/html');
      return parseTooltipHtml(await response.text());
    },
  };
}
