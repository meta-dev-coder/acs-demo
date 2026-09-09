/**
 * Fl511Service — the corridor's live-event cache. It polls FL511 on a fixed interval so browser
 * traffic never reaches FL511, keeps the last successful answer for each feed, and degrades in
 * one direction only: a failed poll serves the previous result labelled STALE rather than
 * emptying the map. Nothing here touches the simulation; live events are visualisation only.
 */
import { createFl511Client } from './fl511Client.mjs';
import { EVENT_TYPES, attachDetails, layerIdFor, normalizeFeed } from './liveEvents.mjs';

export const SOURCE_STATUS = Object.freeze({ LIVE: 'LIVE', STALE: 'STALE', UNAVAILABLE: 'UNAVAILABLE' });

export function createFl511Service({ config, network, client = createFl511Client(config), logger = console, now = Date.now }) {
  /** Last successful raw feed per layer, so one feed failing does not blank the other. */
  const feeds = {
    [EVENT_TYPES.INCIDENT]: { items: null, at: null, error: null },
    [EVENT_TYPES.CLOSURE]: { items: null, at: null, error: null },
  };
  const details = new Map(); // itemId -> { detail, at }
  let result = null;         // last successfully composed payload body
  let lastSuccessfulUpdate = null;
  let timer = null, inFlight = null, disposed = false, lastError = null;

  async function fetchFeed(type) {
    const feed = feeds[type];
    try {
      feed.items = type === EVENT_TYPES.INCIDENT ? await client.fetchIncidents() : await client.fetchClosures();
      feed.at = now(); feed.error = null;
    } catch (error) {
      feed.error = error.message;
      lastError = error.message;
      logger.warn?.(`FL511 ${type} feed failed: ${error.message}${feed.items ? ' — serving cached items' : ''}`);
    }
    return feed.items;
  }

  /** Details are fetched only for corridor events (a handful), and re-used until their TTL lapses. */
  async function enrich(events) {
    const ttlMs = config.detailTtlSeconds * 1000;
    return Promise.all(events.map(async event => {
      const cached = details.get(event.rawSourceId);
      if (cached && now() - cached.at < ttlMs) return attachDetails(event, cached.detail);
      try {
        const detail = await client.fetchEventDetails(layerIdFor(event.type), event.rawSourceId);
        details.set(event.rawSourceId, { detail, at: now() });
        return attachDetails(event, detail);
      } catch (error) {
        logger.warn?.(`FL511 detail ${event.rawSourceId} failed: ${error.message}`);
        // Keep the event: mapIcons already gave us a real, placeable marker.
        return cached ? attachDetails(event, cached.detail) : event;
      }
    }));
  }

  async function refresh() {
    const [incidents, closures] = await Promise.all([fetchFeed(EVENT_TYPES.INCIDENT), fetchFeed(EVENT_TYPES.CLOSURE)]);
    if (!incidents && !closures) return; // Nothing ever fetched; keep whatever we last served.
    const options = { bufferMeters: config.bufferMeters, segmentToleranceMeters: config.segmentToleranceMeters };
    const corridor = [
      ...normalizeFeed(incidents ?? [], EVENT_TYPES.INCIDENT, network, options, logger),
      ...normalizeFeed(closures ?? [], EVENT_TYPES.CLOSURE, network, options, logger),
    ];
    const events = await enrich(corridor);
    events.sort((a, b) => a.id.localeCompare(b.id));
    // Drop detail entries for events that have left the corridor so the cache cannot grow forever.
    const live = new Set(events.map(event => event.rawSourceId));
    for (const key of details.keys()) if (!live.has(key)) details.delete(key);

    result = {
      events,
      counts: {
        total: events.length,
        incidents: events.filter(event => event.type === EVENT_TYPES.INCIDENT).length,
        closures: events.filter(event => event.type === EVENT_TYPES.CLOSURE).length,
      },
    };
    // Only a poll where both feeds answered counts as fully up to date.
    if (!feeds[EVENT_TYPES.INCIDENT].error && !feeds[EVENT_TYPES.CLOSURE].error) {
      lastSuccessfulUpdate = now();
      lastError = null;
    }
  }

  function schedule() {
    if (timer || disposed) return;
    timer = setInterval(() => { void run(); }, config.refreshSeconds * 1000);
    timer.unref?.(); // Never hold the dev server (or a test run) open on our behalf.
  }

  function run() {
    inFlight ??= refresh()
      .catch(error => { lastError = error.message; logger.error?.('FL511 refresh failed', error); })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  function status() {
    if (!result || lastSuccessfulUpdate == null) return SOURCE_STATUS.UNAVAILABLE;
    const ageSeconds = (now() - lastSuccessfulUpdate) / 1000;
    return ageSeconds > config.staleAfterSeconds ? SOURCE_STATUS.STALE : SOURCE_STATUS.LIVE;
  }

  return {
    /** Poll now and start the interval. Safe to call repeatedly; refreshes never overlap. */
    async start() { schedule(); await run(); },
    stop() { disposed = true; if (timer) clearInterval(timer); timer = null; },
    refresh: run,

    /** Normalized corridor view. The first caller waits for the first poll; later ones read cache. */
    async getI595LiveEvents() {
      schedule();
      if (!result) await run();
      const sourceStatus = status();
      return {
        source: 'FL511',
        sourceStatus,
        lastUpdated: lastSuccessfulUpdate == null ? null : new Date(lastSuccessfulUpdate).toISOString(),
        lastSuccessfulUpdate: lastSuccessfulUpdate == null ? null : new Date(lastSuccessfulUpdate).toISOString(),
        dataFreshness: {
          ageSeconds: lastSuccessfulUpdate == null ? null : Math.round((now() - lastSuccessfulUpdate) / 1000),
          refreshSeconds: config.refreshSeconds,
          staleAfterSeconds: config.staleAfterSeconds,
        },
        bufferMeters: config.bufferMeters,
        segmentToleranceMeters: config.segmentToleranceMeters,
        counts: result?.counts ?? { total: 0, incidents: 0, closures: 0 },
        events: result?.events ?? [],
        diagnostics: {
          lastError,
          feeds: {
            incidents: feedDiagnostics(feeds[EVENT_TYPES.INCIDENT]),
            closures: feedDiagnostics(feeds[EVENT_TYPES.CLOSURE]),
          },
        },
      };
    },
  };
}

const feedDiagnostics = feed => ({
  itemCount: feed.items?.length ?? null,
  lastSuccess: feed.at == null ? null : new Date(feed.at).toISOString(),
  error: feed.error,
});
