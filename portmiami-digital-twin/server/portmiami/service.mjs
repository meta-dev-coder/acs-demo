/**
 * The PortMiami live-traffic cache.
 *
 * Ported from the ACS I-595 Safety Twin's `createFl511Service` (`cesium-poc/server/fl511Service.mjs`)
 * and it keeps that service's contract exactly: ONE poller per process so browser traffic never
 * reaches FL511, the last successful answer kept per feed so one feed failing never blanks the
 * others, refreshes that cannot overlap, and degradation in one direction only — a failed poll
 * serves the previous result labelled STALE rather than emptying the map.
 *
 * Changed for PortMiami:
 *   - Two clocks instead of one. Events refresh every `refreshSeconds` (60 s, as on I-595).
 *     Cameras and message signs refresh every `assetRefreshSeconds` (300 s) because they are
 *     infrastructure positions rather than events, and the Cameras feed is 814 KB — re-fetching
 *     that every minute to watch ten cameras that have not moved would waste FL511's bandwidth
 *     for nothing. Both ages are published separately, so the UI can never describe a five-minute
 *     camera list as a one-minute one.
 *   - The region filter replaces the corridor buffer, and detail enrichment runs only on the
 *     handful of events the filter kept — the same economy ACS applies to the corridor.
 *   - No Live Ops enrichment: see server/fl511/normalize.mjs for what was left behind and why.
 */
import { createFl511Client, LAYERS } from '../fl511/client.mjs';
import { EVENT_TYPES, attachDetails, layerIdFor, normalizeFeed } from '../fl511/normalize.mjs';
import { filterToStudyArea } from './studyArea.mjs';
import { associateEvents } from './roadAssociation.mjs';
import { buildCameras } from './cameras.mjs';
import { buildMessageSigns } from './messageSigns.mjs';

export const SOURCE_STATUS = Object.freeze({ LIVE: 'LIVE', STALE: 'STALE', UNAVAILABLE: 'UNAVAILABLE' });

/** Event type -> the client method that fetches its feed. */
const EVENT_FEEDS = Object.freeze({
  [EVENT_TYPES.INCIDENT]: 'fetchIncidents',
  [EVENT_TYPES.CLOSURE]: 'fetchClosures',
  [EVENT_TYPES.CONSTRUCTION]: 'fetchConstruction',
  [EVENT_TYPES.CONGESTION]: 'fetchCongestion',
  [EVENT_TYPES.DISABLED_VEHICLE]: 'fetchDisabledVehicles',
});

const iso = ms => (ms == null ? null : new Date(ms).toISOString());

export function createLiveTrafficService({
  config, region, network, client = createFl511Client(config), logger = console, now = Date.now,
}) {
  /** Last successful raw feed per layer; one feed failing must not blank another. */
  const feeds = {};
  for (const key of [...Object.keys(EVENT_FEEDS), 'CAMERA', 'MESSAGE_SIGN']) {
    feeds[key] = { items: null, at: null, error: null };
  }
  const details = new Map();      // sourceEventId -> { detail, at }
  let events = null, cameras = null, signs = null;
  let lastEventUpdate = null, lastAssetUpdate = null, lastError = null;
  let eventTimer = null, assetTimer = null;
  let eventRun = null, assetRun = null, disposed = false;

  /** Fetch one layer, remembering the last good answer. Never throws. */
  async function fetchFeed(key, method) {
    const feed = feeds[key];
    try {
      feed.items = typeof client[method] === 'function' ? await client[method]() : [];
      feed.at = now();
      feed.error = null;
    } catch (error) {
      feed.error = error.message;
      lastError = error.message;
      logger.warn?.(`FL511 ${key} feed failed: ${error.message}${feed.items ? ' — serving cached items' : ''}`);
    }
    return feed.items;
  }

  /**
   * Detail fragments, for study-area events only — a handful, not the statewide feed — and reused
   * until their TTL lapses. A detail failure keeps the event: mapIcons already gave us a real,
   * placeable marker.
   */
  async function enrich(list) {
    const ttlMs = config.detailTtlSeconds * 1000;
    return Promise.all(list.map(async event => {
      const cached = details.get(event.sourceEventId);
      if (cached && now() - cached.at < ttlMs) return attachDetails(event, cached.detail);
      try {
        const detail = await client.fetchEventDetails(layerIdFor(event.type), event.sourceEventId);
        details.set(event.sourceEventId, { detail, at: now() });
        return attachDetails(event, detail);
      } catch (error) {
        logger.warn?.(`FL511 detail ${event.sourceEventId} failed: ${error.message}`);
        return cached ? attachDetails(event, cached.detail) : event;
      }
    }));
  }

  async function refreshEvents() {
    const raw = {};
    await Promise.all(Object.entries(EVENT_FEEDS)
      .map(async ([type, method]) => { raw[type] = await fetchFeed(type, method); }));
    // Nothing has ever been fetched; keep whatever we last served rather than publishing zero.
    if (Object.values(raw).every(items => !items)) return;

    const unplaceable = [];
    let normalized = [];
    for (const [type, items] of Object.entries(raw)) {
      const { kept, unplaceable: lost } = filterToStudyArea(items ?? [], region);
      unplaceable.push(...lost.map(entry => ({ ...entry, type })));
      normalized.push(...normalizeFeed(kept, type, { regionId: region.id }, logger));
    }
    normalized = associateEvents(await enrich(normalized), network);
    normalized.sort((a, b) => a.id.localeCompare(b.id));

    // Forget details for events that have left the study area, so the cache cannot grow forever.
    const live = new Set(normalized.map(event => event.sourceEventId));
    for (const key of details.keys()) if (!live.has(key)) details.delete(key);

    events = { list: normalized, unplaceable };
    if (Object.keys(EVENT_FEEDS).every(key => !feeds[key].error)) {
      lastEventUpdate = now();
      lastError = null;
    }
    logger.log?.(`[PortMiami] live events: ${normalized.length} in study area `
      + `(${Object.entries(counts(normalized)).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(' ') || 'none'})`);
  }

  async function refreshAssets() {
    const [cameraItems, signItems] = await Promise.all([
      fetchFeed('CAMERA', 'fetchCameras'), fetchFeed('MESSAGE_SIGN', 'fetchMessageSigns'),
    ]);
    if (!cameraItems && !signItems) return;
    if (cameraItems) cameras = buildCameras(filterToStudyArea(cameraItems, region).kept, network, region);
    if (signItems) signs = buildMessageSigns(filterToStudyArea(signItems, region).kept, network, region);
    if (!feeds.CAMERA.error && !feeds.MESSAGE_SIGN.error) lastAssetUpdate = now();
    logger.log?.(`[PortMiami] cameras: ${cameras?.length ?? 0}, message signs: ${signs?.length ?? 0} in study area`);
  }

  const counts = list => ({
    incidents: list.filter(e => e.type === EVENT_TYPES.INCIDENT).length,
    closures: list.filter(e => e.type === EVENT_TYPES.CLOSURE).length,
    construction: list.filter(e => e.type === EVENT_TYPES.CONSTRUCTION).length,
    congestion: list.filter(e => e.type === EVENT_TYPES.CONGESTION).length,
    disabledVehicles: list.filter(e => e.type === EVENT_TYPES.DISABLED_VEHICLE).length,
  });

  /** Runs never overlap: a second caller joins the one in flight. */
  const runEvents = () => (eventRun ??= refreshEvents()
    .catch(error => { lastError = error.message; logger.error?.('[PortMiami] event refresh failed', error); })
    .finally(() => { eventRun = null; }));
  const runAssets = () => (assetRun ??= refreshAssets()
    .catch(error => { lastError = error.message; logger.error?.('[PortMiami] asset refresh failed', error); })
    .finally(() => { assetRun = null; }));

  function schedule() {
    if (disposed) return;
    if (!eventTimer) {
      eventTimer = setInterval(() => { void runEvents(); }, config.refreshSeconds * 1000);
      eventTimer.unref?.();   // Never hold the dev server (or a test run) open on our behalf.
    }
    if (!assetTimer) {
      assetTimer = setInterval(() => { void runAssets(); }, config.assetRefreshSeconds * 1000);
      assetTimer.unref?.();
    }
  }

  /** LIVE / STALE / UNAVAILABLE for one clock, against that clock's OWN stale threshold. */
  function statusOf(at, haveData, staleAfterSeconds) {
    if (!haveData || at == null) return SOURCE_STATUS.UNAVAILABLE;
    return (now() - at) / 1000 > staleAfterSeconds ? SOURCE_STATUS.STALE : SOURCE_STATUS.LIVE;
  }

  const freshness = (at, refreshSeconds, staleAfterSeconds) => ({
    ageSeconds: at == null ? null : Math.round((now() - at) / 1000),
    refreshSeconds,
    staleAfterSeconds,
  });

  const diagnosticsFor = keys => Object.fromEntries(keys.map(key => [key, {
    itemCount: feeds[key].items?.length ?? null,
    lastSuccess: iso(feeds[key].at),
    error: feeds[key].error,
  }]));

  const regionBlock = {
    id: region.id, name: region.name, bbox: region.bbox,
    boundaryKind: region.boundaryKind, boundaryNote: region.boundaryNote,
  };

  function eventsPayload() {
    const list = events?.list ?? [];
    return {
      source: 'FL511',
      sourceStatus: statusOf(lastEventUpdate, Boolean(events), config.staleAfterSeconds),
      region: regionBlock,
      lastSuccessfulUpdate: iso(lastEventUpdate),
      lastUpdated: iso(lastEventUpdate),
      dataFreshness: freshness(lastEventUpdate, config.refreshSeconds, config.staleAfterSeconds),
      counts: { total: list.length, ...counts(list) },
      events: list,
      /** FL511 ids with no usable position. Counted, never placed on the map. */
      unplaceable: events?.unplaceable ?? [],
      roadNetwork: { segmentCount: network.count, searchRadiusMeters: 150 },
      /**
       * No traffic-speed feed is published through the endpoint family this integration uses.
       * Stated on every response so the UI never has to assume it.
       */
      trafficSpeeds: {
        available: false,
        reason: 'FL511 publishes no point-marker speed feed. /map/mapIcons/TrafficSpeeds answers '
          + 'HTTP 200 with zero items; the colours on fl511.com\'s own map are rendered from a '
          + 'separate tile service that this integration does not read.',
      },
      diagnostics: { lastError, feeds: diagnosticsFor(Object.keys(EVENT_FEEDS)) },
    };
  }

  function assetsPayload(kind) {
    const list = (kind === 'cameras' ? cameras : signs) ?? [];
    return {
      source: 'FL511',
      sourceStatus: statusOf(lastAssetUpdate, Boolean(kind === 'cameras' ? cameras : signs), config.assetStaleAfterSeconds),
      region: regionBlock,
      lastSuccessfulUpdate: iso(lastAssetUpdate),
      dataFreshness: freshness(lastAssetUpdate, config.assetRefreshSeconds, config.assetStaleAfterSeconds),
      count: list.length,
      [kind]: list,
      diagnostics: { lastError, feeds: diagnosticsFor([kind === 'cameras' ? 'CAMERA' : 'MESSAGE_SIGN']) },
    };
  }

  return {
    /** Poll both clocks now and start the intervals. Safe to call repeatedly. */
    async start() { schedule(); await Promise.all([runEvents(), runAssets()]); },
    stop() {
      disposed = true;
      if (eventTimer) clearInterval(eventTimer);
      if (assetTimer) clearInterval(assetTimer);
      eventTimer = assetTimer = null;
    },

    async getEvents() { schedule(); if (!events) await runEvents(); return eventsPayload(); },
    async getCameras() { schedule(); if (!cameras) await runAssets(); return assetsPayload('cameras'); },
    async getMessageSigns() { schedule(); if (!signs) await runAssets(); return assetsPayload('signs'); },
    /** The study-area camera ids, for the snapshot proxy's scope guard. */
    async cameraIds() { schedule(); if (!cameras) await runAssets(); return new Set((cameras ?? []).map(c => c.id)); },
    refreshEvents: runEvents,
    refreshAssets: runAssets,
  };
}

export { LAYERS };
