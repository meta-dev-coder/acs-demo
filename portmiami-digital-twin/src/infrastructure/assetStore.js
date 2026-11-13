/**
 * Durable storage for links and review history.
 *
 * There is no backend in this project and no database: it is a static Vite SPA served as files.
 * Adding a server purely to hold a few hundred rows would be the "new database unnecessarily" the
 * brief warns against, so this uses `localStorage`, which survives refreshes and restarts.
 *
 * The honest limit, stated here because the UI says it too: localStorage is PER BROWSER. Links
 * confirmed on one machine are not visible on another and are lost if site data is cleared. When
 * this twin gains a backend, this module is the only thing that has to change — everything above
 * it talks to `load`/`save`, not to storage.
 *
 * The registry itself is NOT stored here. It is source code, reviewed in version control, because
 * a verified asset with a cited source should not be editable from a browser console.
 */
import { LINK_STATUS } from './assetLinks.js';

export const STORAGE_KEY = 'portmiami.infrastructure.links.v1';
export const SCHEMA_VERSION = 1;

const empty = () => ({ version: SCHEMA_VERSION, buildingLinks: [], roadLinks: [], history: [] });

/**
 * Read the store. Every failure mode — no storage, blocked storage, corrupt JSON, a future
 * schema — returns an empty store rather than throwing, because a demo must still open.
 */
export function loadLinks(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== SCHEMA_VERSION) return empty();
    return {
      version: SCHEMA_VERSION,
      buildingLinks: Array.isArray(parsed.buildingLinks) ? parsed.buildingLinks : [],
      roadLinks: Array.isArray(parsed.roadLinks) ? parsed.roadLinks : [],
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return empty();
  }
}

/** Write the store. Returns false when storage is unavailable, so the UI can say so. */
export function saveLinks(state, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ ...state, version: SCHEMA_VERSION }));
    return true;
  } catch {
    return false;
  }
}

export function clearLinks(storage = globalThis.localStorage) {
  try { storage?.removeItem(STORAGE_KEY); return true; } catch { return false; }
}

/**
 * Validate stored links against the registry and the GIS actually loaded.
 *
 * A link whose asset no longer exists is dropped — the registry is source code, so its ids are
 * authoritative. A link whose OBJECTID is no longer in the GIS is NOT reassigned to anything: it
 * is flagged NEEDS_REVIEW and kept, so a refreshed GIS surfaces as a review queue rather than as a
 * silent re-pointing at whatever feature inherited that id.
 *
 * @returns {{state: object, dropped: number, flagged: number, notes: string[]}}
 */
export function reconcileLinks(state, { assetIds, buildingIds, roadIds }) {
  const notes = [];
  let dropped = 0, flagged = 0;

  const reconcileOne = (links, idKey, known, kind) => links.flatMap(link => {
    if (!assetIds.has(link.assetId)) {
      dropped += 1;
      notes.push(`Dropped a ${kind} link: asset "${link.assetId}" is no longer in the registry.`);
      return [];
    }
    if (!known.has(link[idKey])) {
      if (link.status !== LINK_STATUS.NEEDS_REVIEW) {
        flagged += 1;
        notes.push(`Flagged a ${kind} link for ${link.assetId}: OBJECTID ${link[idKey]} is not in the loaded GIS.`);
      }
      return [{ ...link, status: LINK_STATUS.NEEDS_REVIEW, previousStatus: link.previousStatus ?? link.status }];
    }
    return [link];
  });

  return {
    state: {
      ...state,
      buildingLinks: reconcileOne(state.buildingLinks, 'buildingObjectId', buildingIds, 'building'),
      roadLinks: reconcileOne(state.roadLinks, 'roadObjectId', roadIds, 'road'),
    },
    dropped,
    flagged,
    notes,
  };
}
