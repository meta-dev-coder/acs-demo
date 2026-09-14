/**
 * Loads sign-structure GeoJSON — once per structure type, for the life of the page.
 *
 * Toggling a layer never reaches this module: the fetch is keyed by type id and the promise is
 * cached, so a second caller gets the first caller's result and a re-toggle gets nothing at all.
 * A failed load drops its cache entry so a retry can actually retry.
 */
import { readSignStructures, SIGN_STRUCTURE_TYPES } from './signStructureData.js';

/**
 * @param {{baseUrl?: string, fetch?: typeof globalThis.fetch, warn?: (message: string) => void}} [options]
 */
export function createSignStructureService({
  baseUrl = import.meta.env?.BASE_URL ?? '/',
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  warn = message => console.warn(message),
} = {}) {
  const cache = new Map();

  /**
   * @param {import('./signStructureData.js').SignStructureType} type
   * @returns {Promise<{type: object, records: object[], skipped: object[], featureCount: number}>}
   */
  function load(type) {
    if (!cache.has(type.id)) {
      const pending = (async () => {
        const response = await fetchImpl(`${baseUrl}${type.source}`);
        if (!response.ok) throw new Error(`${type.label} request failed: ${response.status}`);
        const data = await response.json();
        const { records, skipped, featureCount } = readSignStructures(data, type);
        // The count is a fact about the file, so a mismatch is reported rather than absorbed: a
        // silently short layer looks exactly like a complete one on the map.
        if (records.length !== featureCount) {
          warn(`${type.label}: loaded ${records.length} of ${featureCount} features; ${skipped.length} skipped — `
            + skipped.map(item => `${item.id ?? '(no id)'}: ${item.reason}`).join('; '));
        }
        return { type, records, skipped, featureCount };
      })().catch(error => { cache.delete(type.id); throw error; });
      cache.set(type.id, pending);
    }
    return cache.get(type.id);
  }

  return {
    load,
    /** Every registered type, loaded in parallel. Rejections stay with their own type. */
    loadAll: (types = SIGN_STRUCTURE_TYPES) => types.map(type => ({ type, loading: load(type) })),
    /** True once this type's file has been requested — nothing here ever fetches it twice. */
    isLoaded: id => cache.has(id),
  };
}
