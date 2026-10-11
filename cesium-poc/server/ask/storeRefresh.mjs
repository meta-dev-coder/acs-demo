/**
 * Keeps the twin store current while the ask service runs.
 *
 * Live SDNA classes are re-pulled every few minutes (the FL511 sync writes them continuously);
 * historical classes once a day (they change by customer import, not by the minute). Each refresh
 * writes a new file and renames it into place, then the service reopens it, so a question never reads
 * a half-written store. A failed refresh logs and leaves the last good store serving; the committed
 * snapshot is only the first-start fallback when DataConnect cannot be read at all.
 */
import { buildStoreFromDataConnect } from './dataConnectPull.mjs';
import { openTwinStore } from './twinStore.mjs';

export const LIVE_EVERY_MS = 5 * 60_000;
export const HISTORICAL_EVERY_MS = 24 * 3_600_000;

/**
 * The store API (classes, check, query, count, rows) over whichever file is current. `reload()` opens
 * the renamed-in file and closes the old handle; `version` changes with each reload so callers can
 * drop anything they derived from the old classes (the cached system prompt).
 */
export function createReloadingStore(path, options = {}) {
  let current = openTwinStore(path, options);
  let version = 0;
  return {
    get version() { return version; },
    classes: (...args) => current.classes(...args),
    check: (...args) => current.check(...args),
    query: (...args) => current.query(...args),
    count: (...args) => current.count(...args),
    rows: (...args) => current.rows(...args),
    reload() {
      const next = openTwinStore(path, options);
      const old = current;
      current = next;
      version++;
      old.close();
    },
    close: () => current.close(),
  };
}

const isDataConnect = source => String(source ?? '').startsWith('dataconnect:');

/**
 * @param {{store: ReturnType<typeof createReloadingStore>, storePath: string, liveDc?: object|null,
 *   historical?: object|null, snapshotDir?: string|null, liveEveryMs?: number, historicalEveryMs?: number,
 *   now?: () => number, logger?: Console, build?: typeof buildStoreFromDataConnect,
 *   setInterval?: typeof setInterval, clearInterval?: typeof clearInterval}} options
 */
export function createStoreRefresher({ store, storePath, liveDc = null, historical = null, snapshotDir = null,
  liveEveryMs = LIVE_EVERY_MS, historicalEveryMs = HISTORICAL_EVERY_MS, now = Date.now, logger = console,
  build = buildStoreFromDataConnect, setInterval: every = setInterval, clearInterval: cancel = clearInterval }) {
  let running = null;
  let timers = [];
  const status = { lastRefresh: null, lastError: null, refreshes: 0 };

  /** Whether the store's historical classes came from DataConnect within the last `historicalEveryMs`. */
  function historicalFresh() {
    const loaded = store.classes().filter(c => c.source === 'dataconnect:historical');
    return loaded.length > 0 && loaded.every(c => now() - Date.parse(c.asOf) < historicalEveryMs);
  }

  /**
   * One refresh. Runs one at a time: a call while another runs waits for it instead of paging twice.
   * @param {{withHistorical?: boolean}} [options]
   */
  function refresh({ withHistorical = false } = {}) {
    if (running) return running;
    const includeHistorical = Boolean(historical) && withHistorical;
    if (!liveDc && !includeHistorical) return Promise.resolve({ written: false, skipped: 'nothing to pull' });
    const started = now();
    running = (async () => {
      try {
        const result = await build({ liveDc, historical: includeHistorical ? historical : null, outPath: storePath, keepFrom: storePath, snapshotDir });
        const errors = result.report.filter(r => r.error);
        if (result.written) {
          store.reload();
          status.refreshes++;
          status.lastRefresh = new Date(now()).toISOString();
        }
        status.lastError = errors.length ? errors.map(r => `${r.className}: ${r.error}`).join('; ') : (result.written ? null : 'DataConnect returned no class');
        const pulled = result.report.filter(r => r.kind === 'live' || r.kind === 'historical');
        logger.log?.(`ask-the-twin: store ${result.written ? 'refreshed' : 'NOT refreshed (kept the last good store)'}${includeHistorical ? ' with historical classes' : ''}`
          + ` in ${now() - started} ms: ${pulled.filter(r => !r.error).map(r => `${r.className} ${r.rows}`).join(', ') || 'no class read'}`
          + `${errors.length ? `; failed: ${errors.map(r => r.className).join(', ')}` : ''}`);
        return result;
      } catch (error) {
        status.lastError = String(error?.message ?? error).slice(0, 300);
        logger.warn?.(`ask-the-twin: store refresh failed, the last good store keeps serving: ${status.lastError}`);
        return { written: false, error: status.lastError };
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    status,
    refresh,
    /**
     * First refresh now (historical too, unless the store already holds a recent historical pull),
     * then live every `liveEveryMs` and historical every `historicalEveryMs`.
     */
    start() {
      const first = refresh({ withHistorical: !historicalFresh() });
      if (liveDc) timers.push(every(() => { refresh(); }, liveEveryMs));
      if (historical) timers.push(every(() => { refresh({ withHistorical: true }); }, historicalEveryMs));
      for (const t of timers) t?.unref?.();
      return first;
    },
    stop() {
      for (const t of timers) cancel(t);
      timers = [];
    },
    sources: () => store.classes().map(c => ({ className: c.className, source: c.source, asOf: c.asOf, fromDataConnect: isDataConnect(c.source) })),
  };
}

/**
 * Refresh settings from the environment: `ASK_TWIN_REFRESH=off` turns refreshing off,
 * `ASK_TWIN_LIVE_REFRESH_MIN` and `ASK_TWIN_HISTORICAL_REFRESH_H` set the intervals.
 * @returns {{liveEveryMs: number, historicalEveryMs: number} | false}
 */
export function refreshFromEnv(env = process.env) {
  if (/^(off|false|0|no)$/i.test(String(env.ASK_TWIN_REFRESH ?? '').trim())) return false;
  const positive = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  return {
    liveEveryMs: positive(env.ASK_TWIN_LIVE_REFRESH_MIN, LIVE_EVERY_MS / 60_000) * 60_000,
    historicalEveryMs: positive(env.ASK_TWIN_HISTORICAL_REFRESH_H, HISTORICAL_EVERY_MS / 3_600_000) * 3_600_000,
  };
}

/**
 * Only the DataConnect read clients that are configured: an unconfigured client would fail every
 * refresh with the same 503, which is noise, not a data gap.
 */
export function configuredClients({ liveDc = null, historical = null } = {}) {
  return {
    liveDc: liveDc?.config?.baseUrl ? liveDc : null,
    historical: historical && typeof historical.missing === 'function' && historical.missing().length === 0 ? historical : null,
  };
}
