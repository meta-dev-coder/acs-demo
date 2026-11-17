/**
 * The only module that talks to FL511.
 *
 * Ported from the ACS I-595 Safety Twin (`cesium-poc/server/fl511Client.mjs`). The request/retry
 * loop, the `parseMapIcons` validator and the "4xx is deliberate, stop asking" rule are that
 * file's, unchanged. These are publicly reachable but undocumented endpoints belonging to FL511's
 * own website, so every response is validated before it is trusted, a single malformed item never
 * fails the feed, and failures surface as thrown errors the service turns into cached/stale
 * answers instead of empty maps.
 *
 * Two things are added for PortMiami, both of them the SAME endpoint family and the same envelope:
 *   - `fetchCameras` (/map/mapIcons/Cameras), which ACS never polled.
 *   - `fetchMessageSigns`, which ACS has but reaches through a separate module.
 * `parseMapIcons` also now keeps `videoEnabled` and `iconUrl`, which the camera feed publishes and
 * the event feeds do not. Nothing is inferred from their absence.
 */
import { detailUrl } from './config.mjs';
import { isValidLatLon } from './geo.mjs';
import { parseTooltipHtml } from './tooltip.mjs';

/** FL511's own layer ids. These double as the {layerId} in the detail URL. */
export const LAYERS = Object.freeze({
  INCIDENT: 'Incidents', CLOSURE: 'Closures', CONSTRUCTION: 'Construction',
  CONGESTION: 'Congestion', DISABLED: 'DisabledVehicles',
  CAMERA: 'Cameras', MESSAGE_SIGN: 'MessageSigns',
});

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
    // Published only by the Cameras feed. `videoEnabled` is FL511's own boolean and is carried as
    // a tri-state: true, false, or absent when FL511 said nothing — never defaulted to false.
    const videoEnabled = entry.expando?.videoEnabled;
    const iconUrl = typeof entry.icon?.url === 'string' && entry.icon.url.trim() ? entry.icon.url.trim() : null;
    items.push({
      itemId,
      latitude: primary.latitude, longitude: primary.longitude,
      ...(secondary ? { secondaryLatitude: secondary.latitude, secondaryLongitude: secondary.longitude } : {}),
      ...(typeof entry.title === 'string' && entry.title.trim() ? { title: entry.title.trim() } : {}),
      ...(typeof videoEnabled === 'boolean' ? { videoEnabled } : {}),
      ...(iconUrl ? { iconUrl } : {}),
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
    fetchConstruction: () => fetchLayer(config.constructionPath, LAYERS.CONSTRUCTION),
    fetchCongestion: () => fetchLayer(config.congestionPath, LAYERS.CONGESTION),
    fetchDisabledVehicles: () => fetchLayer(config.disabledVehiclesPath, LAYERS.DISABLED),
    fetchCameras: () => fetchLayer(config.camerasPath, LAYERS.CAMERA),
    fetchMessageSigns: () => fetchLayer(config.messageSignsPath, LAYERS.MESSAGE_SIGN),
    /**
     * Marker detail, from the endpoint FL511's own map declares as data-tooltipbaseurl.
     * Returns null (never a partial guess) when the fragment cannot be recognised.
     */
    async fetchEventDetails(layerId, itemId) {
      const response = await request(detailUrl(config, layerId, itemId), 'text/html');
      return parseTooltipHtml(await response.text());
    },
    /** The raw detail fragment, for callers with their own parser (message signs). */
    async fetchDetailHtml(layerId, itemId) {
      const response = await request(detailUrl(config, layerId, itemId), 'text/html');
      return response.text();
    },
  };
}
