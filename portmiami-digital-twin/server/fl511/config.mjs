/**
 * Every FL511 URL and tuning knob, in one place.
 *
 * Ported from the ACS I-595 Safety Twin (`cesium-poc/server/config.mjs`). The five event paths,
 * the message-sign path, the detail path and the retry/stale knobs are that file's, unchanged —
 * FL511's map endpoints are publicly reachable but undocumented, so each stays overridable by
 * environment variable: if FL511 moves a path we re-point it without a code change.
 *
 * FL511 needs no authentication and issues no credentials. There is no API key to keep server-side
 * because there is none to hold; what IS kept server-side is FL511 itself — the browser only ever
 * talks to this app's own /api/portmiami/* endpoints, so one poller serves every viewer.
 *
 * Added here, and NOT in the ACS file:
 *   - `camerasPath`. ACS does not poll this feed: its 74 corridor cameras are a frozen GeoJSON
 *     extract with DIVAS channel ids already resolved. PortMiami has no such extract, so it reads
 *     the same `mapIcons` endpoint live. Verified 2026-11-16: HTTP 200, the identical `item2`
 *     envelope, 4,978 statewide items, and `icon.url` pointing at the same
 *     /Generated/Content/Images/511/map_camera*.svg assets the ACS extract recorded as its
 *     `source_icon` — i.e. the extract came from this feed.
 *   - `assetRefreshSeconds`. The cameras feed is 814 KB and its contents are infrastructure
 *     positions, not events; re-fetching that every minute to watch 10 cameras that have not moved
 *     would be a waste of FL511's bandwidth. Cameras and signs refresh on their own slower clock.
 */
const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function loadFl511Config(env = process.env) {
  return {
    baseUrl: (env.FL511_BASE_URL || 'https://fl511.com').replace(/\/+$/, ''),
    incidentsPath: env.FL511_INCIDENTS_PATH || '/map/mapIcons/Incidents',
    closuresPath: env.FL511_CLOSURES_PATH || '/map/mapIcons/Closures',
    constructionPath: env.FL511_CONSTRUCTION_PATH || '/map/mapIcons/Construction',
    congestionPath: env.FL511_CONGESTION_PATH || '/map/mapIcons/Congestion',
    disabledVehiclesPath: env.FL511_DISABLED_VEHICLES_PATH || '/map/mapIcons/DisabledVehicles',
    messageSignsPath: env.FL511_MESSAGE_SIGNS_PATH || '/map/mapIcons/MessageSigns',
    camerasPath: env.FL511_CAMERAS_PATH || '/map/mapIcons/Cameras',
    // Declared by FL511's own map markup as data-tooltipbaseurl; {layerId}/{id}/{lang} are theirs.
    detailPath: env.FL511_DETAIL_PATH || '/tooltip/{layerId}/{id}?lang={lang}',
    lang: env.FL511_LANG || 'en-US',
    // Identify ourselves honestly rather than imitating a browser.
    userAgent: env.FL511_USER_AGENT || 'portmiami-digital-twin/1.0 (live road-event viewer)',
    /** Events: the same one-minute cadence the I-595 twin polls on. */
    refreshSeconds: number(env.FL511_REFRESH_SECONDS, 60),
    /** Cameras and message signs: positions, not events. Five minutes. */
    assetRefreshSeconds: number(env.FL511_ASSET_REFRESH_SECONDS, 300),
    requestTimeoutMs: number(env.FL511_TIMEOUT_MS, 10_000),
    // One retry after a short pause; a failed poll falls back to cache rather than hammering FL511.
    retryAttempts: number(env.FL511_RETRY_ATTEMPTS, 2),
    retryDelayMs: number(env.FL511_RETRY_DELAY_MS, 750),
    detailTtlSeconds: number(env.FL511_DETAIL_TTL_SECONDS, 60),
    /**
     * Cached data older than this is served but labelled STALE. One threshold per clock, because
     * a single one cannot be right for both: at 180 s (three event polls) a camera list on its own
     * 300 s cadence would be labelled "cached" from the moment it was three minutes old, i.e. for
     * two minutes out of every five, while nothing was wrong with it. Each threshold is three
     * refreshes of its own clock, so "stale" means the same thing in both places: the source has
     * missed several polls in a row.
     */
    staleAfterSeconds: number(env.FL511_STALE_AFTER_SECONDS, 180),
    assetStaleAfterSeconds: number(env.FL511_ASSET_STALE_AFTER_SECONDS, 900),
    port: number(env.PORTMIAMI_API_PORT || env.PORT, 5201),
  };
}

export function detailUrl(config, layerId, itemId) {
  const path = config.detailPath
    .replace('{layerId}', encodeURIComponent(layerId))
    .replace('{id}', encodeURIComponent(itemId))
    .replace('{lang}', encodeURIComponent(config.lang));
  return `${config.baseUrl}${path}`;
}
