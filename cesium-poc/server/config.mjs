/**
 * Every FL511 URL and tuning knob lives here so no endpoint string is scattered through the
 * codebase. FL511's map endpoints are publicly reachable but undocumented, so each one is
 * overridable by environment variable: if FL511 moves a path we re-point it without a code change.
 */
const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function loadConfig(env = process.env) {
  return {
    baseUrl: (env.FL511_BASE_URL || 'https://fl511.com').replace(/\/+$/, ''),
    incidentsPath: env.FL511_INCIDENTS_PATH || '/map/mapIcons/Incidents',
    closuresPath: env.FL511_CLOSURES_PATH || '/map/mapIcons/Closures',
    // Declared by FL511's own map markup as data-tooltipbaseurl; {layerId}/{id}/{lang} are theirs.
    detailPath: env.FL511_DETAIL_PATH || '/tooltip/{layerId}/{id}?lang={lang}',
    lang: env.FL511_LANG || 'en-US',
    // Identify ourselves honestly rather than imitating a browser.
    userAgent: env.FL511_USER_AGENT || 'i595-digital-twin/1.0 (live road-event viewer)',
    refreshSeconds: number(env.FL511_REFRESH_SECONDS, 60),
    requestTimeoutMs: number(env.FL511_TIMEOUT_MS, 10_000),
    // One retry after a short pause; a failed poll falls back to cache rather than hammering FL511.
    retryAttempts: number(env.FL511_RETRY_ATTEMPTS, 2),
    retryDelayMs: number(env.FL511_RETRY_DELAY_MS, 750),
    // Details change far more slowly than marker positions, and only corridor events are enriched.
    detailTtlSeconds: number(env.FL511_DETAIL_TTL_SECONDS, 300),
    // Cached data older than this is served but labelled STALE.
    staleAfterSeconds: number(env.FL511_STALE_AFTER_SECONDS, 180),
    bufferMeters: number(env.I595_LIVE_EVENT_BUFFER_METERS, 250),
    // An FDOT traffic section is only claimed when the event sits essentially on the mainline;
    // SR 84, ramp and interchange events legitimately belong to no traffic section.
    segmentToleranceMeters: number(env.I595_LIVE_EVENT_SEGMENT_TOLERANCE_METERS, 120),
    port: number(env.FL511_API_PORT || env.PORT, 5189),
  };
}

export function detailUrl(config, layerId, itemId) {
  const path = config.detailPath
    .replace('{layerId}', encodeURIComponent(layerId))
    .replace('{id}', encodeURIComponent(itemId))
    .replace('{lang}', encodeURIComponent(config.lang));
  return `${config.baseUrl}${path}`;
}
