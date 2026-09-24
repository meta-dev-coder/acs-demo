/**
 * The Maintenance workspace's only source of records.
 *
 * One interface, two implementations, chosen explicitly and never silently:
 *
 *   dataconnect — the live API, through this app's own origin (server/dataConnect.mjs attaches the
 *                 credentials). Class ids are discovered from the instance, pages are followed to
 *                 `totalCount`, and every failure is reported as itself.
 *   mock        — the committed export under public/dataconnect-data/, for local development only.
 *                 It is used when it is ASKED for (`VITE_DATA_SOURCE=mock`, or `?data=mock`) and
 *                 never as a fallback: a DataConnect failure shows the failure, because believing
 *                 you are looking at live data when you are not is worse than an error.
 *
 * No token, credential or Authorization header passes through this module — they live on the
 * server — and the diagnostics print class, page and counts only.
 */
import { DataConnectError, DC_ERRORS, getCuratedData as fetchCuratedData, signIn, status } from './dataConnectClient.js';
import { dataConnectClass, discoverClasses } from './dataConnectClasses.js';

export { DataConnectError, DC_ERRORS, signIn };

/** Whether this failure is one a person can fix by signing in. */
export const needsSignIn = error =>
  error instanceof DataConnectError && (error.kind === DC_ERRORS.AUTH || error.kind === DC_ERRORS.EXPIRED);

export const DATA_SOURCES = Object.freeze({ DATA_CONNECT: 'dataconnect', MOCK: 'mock' });

const params = () => new URLSearchParams(globalThis.location?.search ?? '');

/**
 * Which source this session uses. `?data=` wins for a quick look, then the build's setting; the
 * default is spelled out here rather than implied.
 */
export function dataSource() {
  const asked = params().get('data');
  if (asked === DATA_SOURCES.DATA_CONNECT || asked === DATA_SOURCES.MOCK) return asked;
  const configured = import.meta.env?.VITE_DATA_SOURCE;
  return configured === DATA_SOURCES.DATA_CONNECT ? DATA_SOURCES.DATA_CONNECT : DATA_SOURCES.MOCK;
}

export const isLive = () => dataSource() === DATA_SOURCES.DATA_CONNECT;
export const debugEnabled = () => params().has('debug');

/** What the workspace shows as its source. Mock says so plainly; nothing claims to be live that is not. */
export function sourceLabel() {
  return isLive() ? 'DataConnect' : 'Mock data';
}

const cache = new Map();

function diagnose(label, detail) {
  if (!debugEnabled()) return;
  console.info(`[DataConnect][${label}]`, detail);
}

// ── mock: the committed export, only when asked for ───────────────────────────────────────────
/** The class is not in this deployment — as opposed to a request that failed and could be retried. */
export class MissingClassError extends Error {}

async function fetchSnapshotFile(file) {
  const url = `${import.meta.env.BASE_URL}dataconnect-data/${file}.json`;
  const response = await fetch(url);
  // A dev server answers a missing file with index.html rather than a 404, so "not JSON" and "404"
  // mean the same thing: this deployment does not carry the class.
  if (!response.ok) throw new MissingClassError(`${file}: ${response.status}`);
  let rows;
  try { rows = await response.json(); } catch { throw new MissingClassError(`${file}: not JSON`); }
  if (!Array.isArray(rows)) throw new MissingClassError(`${file}: not a list of records`);
  return rows;
}

async function loadMock(config) {
  const parts = await Promise.all(config.snapshot.map(fetchSnapshotFile));
  const rows = parts.flat();
  diagnose(config.label, { source: 'mock', files: config.snapshot, received: rows.length });
  return { rows, source: DATA_SOURCES.MOCK, totalCount: rows.length };
}

// ── dataconnect: the live API ─────────────────────────────────────────────────────────────────
async function loadLive(config, { pageSize }) {
  const { ids, missing } = await discoverClasses();
  const classIds = ids[config.key];
  if (!classIds?.length) {
    throw new DataConnectError(DC_ERRORS.NOT_FOUND,
      `DataConnect has no class matching ${config.label} (looked for: ${config.names.join(', ')}).`,
      { missing });
  }
  // A logical class can be several DataConnect classes — inspections are three form families.
  const pages = await Promise.all(classIds.map(async classId => {
    const { records, totalCount } = await fetchCuratedData(classId, {
      pageSize,
      onPage: info => diagnose(config.label, { classId, ...info }),
    });
    return { classId, records, totalCount };
  }));
  const rows = pages.flatMap(page => page.records);
  const totalCount = pages.reduce((sum, page) => sum + page.totalCount, 0);
  diagnose(config.label, { source: 'dataconnect', classIds, received: rows.length, totalCount });
  return { rows, source: DATA_SOURCES.DATA_CONNECT, totalCount };
}

/**
 * Every record of one configured class, from whichever source this session uses.
 *
 * @param {string} key  a key of DATA_CONNECT_CLASSES
 * @param {{pageSize?: number}} [options]
 * @returns {Promise<{rows: object[], source: string, totalCount: number}>}
 */
export function getCuratedData(key, { pageSize = 500 } = {}) {
  const config = dataConnectClass(key);
  if (!config) return Promise.reject(new Error(`Unknown DataConnect class "${key}"`));
  const cacheKey = `${dataSource()}:${key}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const load = (isLive() ? loadLive(config, { pageSize }) : loadMock(config))
    .catch(error => {
      // Retryable rather than remembered as broken; and never quietly replaced by the export.
      cache.delete(cacheKey);
      diagnose(config.label, { failed: error?.kind ?? error?.name ?? 'error', status: error?.status ?? null });
      throw error;
    });

  cache.set(cacheKey, load);
  return load;
}

export const getAssets = options => getCuratedData('assets', options);
export const getWorkOrders = options => getCuratedData('workOrders', options);
export const getTickets = options => getCuratedData('tickets', options);
export const getTasks = options => getCuratedData('tasks', options);
export const getIncidents = options => getCuratedData('incidents', options);
export const getInspections = options => getCuratedData('inspections', options);

/** Whether the server can reach DataConnect at all, for the source indicator. */
export const connectionStatus = () => (isLive() ? status() : Promise.resolve({ configured: true, mock: true }));

/** Test/diagnostic hook: forget what has been fetched. */
export function clearCache() { cache.clear(); }
