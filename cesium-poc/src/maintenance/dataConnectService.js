/**
 * The Maintenance workspace's only way to DataConnect.
 *
 * Map and UI code never fetches: it asks this service for a class and gets rows plus the tier they
 * came from. The tiers are the ones this repository already uses (src/scenarioAPrime/dataSource.ts):
 *
 *   live     — ?dc=<base> is present, so the existing DataConnect client is used, with whatever
 *              credentials that client already understands (?dctoken= for a pre-acquired bearer,
 *              ?dcuser=/?dcpass= for the local shim). No token is read, stored or logged here.
 *   snapshot — the committed export under public/dataconnect-data/, which is what the deployed
 *              demos serve today.
 *
 * Each class is fetched once and cached, so switching Work Orders → Tickets → Work Orders does not
 * re-download anything, and each class loads independently: one failing must not hold up the rest.
 */
import { fetchClass, getBaseUrl } from '../dataconnect.js';
import { dataConnectClass } from './dataConnectClasses.js';

const params = () => new URLSearchParams(globalThis.location?.search ?? '');
/** Live only when a base URL was asked for; otherwise the committed export. */
export const isLive = () => Boolean(params().get('dc'));
export const debugEnabled = () => params().has('debug');

/** What the workspace shows as its source. Never "snapshot" while live data is in use. */
export function sourceLabel() {
  return isLive() ? `DataConnect · ${getBaseUrl().replace(/^https?:\/\//, '')}` : 'DataConnect export';
}

const cache = new Map();

/** Never log a token, a URL with credentials, or record contents — counts and classes only. */
function diagnose(key, detail) {
  if (!debugEnabled()) return;
  console.info(`[DataConnect][${key}]`, detail);
}

async function fetchSnapshot(file) {
  const url = `${import.meta.env.BASE_URL}dataconnect-data/${file}.json`;
  const response = await fetch(url);
  // A dev server answers a missing file with the app's index.html rather than a 404, so "not JSON"
  // and "404" both mean the same thing: this deployment does not carry the class.
  if (!response.ok) throw new MissingClassError(`${file}: ${response.status}`);
  let rows;
  try { rows = await response.json(); } catch { throw new MissingClassError(`${file}: not JSON`); }
  if (!Array.isArray(rows)) throw new MissingClassError(`${file}: not a list of records`);
  return rows;
}

/** The class is not here — as opposed to a request that failed and could be retried. */
export class MissingClassError extends Error {}

/**
 * Rows of one configured class.
 *
 * @param {string} key  a key of DATA_CONNECT_CLASSES
 * @param {{pageSize?: number}} [options]
 * @returns {Promise<{rows: object[], tier: 'live'|'snapshot', key: string}>}
 */
export function getCuratedData(key, { pageSize = 500 } = {}) {
  const config = dataConnectClass(key);
  if (!config) return Promise.reject(new Error(`Unknown DataConnect class "${key}"`));
  if (cache.has(key)) return cache.get(key);

  const load = (async () => {
    const started = Date.now();
    if (isLive()) {
      // The by-name endpoint the repository's client already speaks. When a class id is configured,
      // the id-based endpoint can be used instead; neither is guessed here.
      const rows = await fetchClass(config.className, { pageSize });
      diagnose(config.label, { tier: 'live', class: config.classId ?? config.className, pageSize, received: rows.length, ms: Date.now() - started });
      return { rows, tier: 'live', key };
    }
    const parts = await Promise.all(config.snapshot.map(fetchSnapshot));
    const rows = parts.flat();
    diagnose(config.label, { tier: 'snapshot', files: config.snapshot, received: rows.length, ms: Date.now() - started });
    return { rows, tier: 'snapshot', key };
  })().catch(error => {
    // A failed class must be retryable rather than cached as broken for the session.
    cache.delete(key);
    diagnose(config.label, { failed: String(error?.message ?? error) });
    throw error;
  });

  cache.set(key, load);
  return load;
}

export const getAssets = options => getCuratedData('assets', options);
export const getWorkOrders = options => getCuratedData('workOrders', options);
export const getTickets = options => getCuratedData('tickets', options);
export const getTasks = options => getCuratedData('tasks', options);
export const getIncidents = options => getCuratedData('incidents', options);
export const getInspections = options => getCuratedData('inspections', options);

/** Test/diagnostic hook: forget what has been fetched. */
export function clearCache() { cache.clear(); }
