/**
 * Google Photorealistic 3D Tiles as a *base environment*, not a data layer.
 *
 * The tileset is created lazily on first activation, cached for the life of the viewer and only
 * ever shown or hidden afterwards — switching base environment never rebuilds it, never touches the
 * viewer, and never touches the corridor's data sources, entities or their visibility. On any
 * failure the existing Esri basemap stays active and the caller is told why.
 */
import { GoogleMaps, createGooglePhotorealistic3DTileset } from 'cesium';

/** @typedef {'SATELLITE'|'GOOGLE_PHOTOREALISTIC_3D'} BaseEnvironment */
export const BASE_ENVIRONMENTS = Object.freeze({
  SATELLITE: 'SATELLITE',
  GOOGLE_PHOTOREALISTIC_3D: 'GOOGLE_PHOTOREALISTIC_3D',
});
export const DEFAULT_BASE_ENVIRONMENT = BASE_ENVIRONMENTS.SATELLITE;

/** @typedef {'IDLE'|'LOADING'|'READY'|'ERROR'} TilesetLoadState */
export const LOAD_STATES = Object.freeze({ IDLE: 'IDLE', LOADING: 'LOADING', READY: 'READY', ERROR: 'ERROR' });

export const MISSING_KEY_MESSAGE = 'Google Photorealistic 3D needs VITE_GOOGLE_MAPS_API_KEY. Showing the satellite basemap.';
export const LOAD_FAILED_MESSAGE = 'Google Photorealistic 3D could not be loaded. Showing the satellite basemap.';

/**
 * @param {import('cesium').Viewer} viewer  the existing viewer — never recreated
 * @param {{apiKey?: string, createTileset?: () => Promise<object>, logger?: Console}} [options]
 */
export function createGooglePhotorealistic3DService(viewer, { apiKey, createTileset, logger = console } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const factory = createTileset ?? (() => createGooglePhotorealistic3DTileset({
    // This viewer is built with `geocoder: false`, so no non-Google geocoder is in use; the flag
    // only silences Cesium's one-time warning about pairing the tiles with another geocoder.
    onlyUsingWithGoogleGeocoder: true,
  }));

  let tileset = null, pending = null, state = LOAD_STATES.IDLE, error = null, destroyed = false;

  /** Lazy, single-flight, cached: at most one tileset instance is ever created for this viewer. */
  async function load() {
    if (tileset) return tileset;
    if (!key) {
      state = LOAD_STATES.ERROR;
      error = new Error('VITE_GOOGLE_MAPS_API_KEY is not configured.');
      throw error;
    }
    pending ??= (async () => {
      state = LOAD_STATES.LOADING;
      error = null;
      GoogleMaps.defaultApiKey = key;
      const created = await factory();
      if (destroyed) return created;
      // Added to the scene once; from here on the toggle only flips `show`.
      viewer.scene.primitives.add(created);
      created.show = false;
      tileset = created;
      state = LOAD_STATES.READY;
      return created;
    })().catch(failure => {
      // A failed attempt may be retried later (key added, quota reset, network back).
      pending = null;
      state = LOAD_STATES.ERROR;
      error = failure;
      throw failure;
    });
    return pending;
  }

  return {
    BASE_ENVIRONMENTS,
    isLoaded: () => tileset != null,
    /** @returns {TilesetLoadState} */
    loadState: () => state,
    lastError: () => error,
    hasApiKey: () => key !== '',
    tileset: () => tileset,
    load,

    /**
     * Show the photorealistic tiles. The globe is hidden only after the tileset exists, so a
     * failure leaves the satellite basemap exactly as it was.
     * @returns {Promise<{ok: boolean, reason?: 'MISSING_API_KEY'|'LOAD_FAILED', message?: string}>}
     */
    async enable() {
      if (!key) {
        logger.error?.('Google Photorealistic 3D: VITE_GOOGLE_MAPS_API_KEY is not configured.');
        return { ok: false, reason: 'MISSING_API_KEY', message: MISSING_KEY_MESSAGE };
      }
      try {
        const loaded = await load();
        if (destroyed) return { ok: false, reason: 'LOAD_FAILED', message: LOAD_FAILED_MESSAGE };
        loaded.show = true;
        // The ellipsoid/imagery globe would otherwise punch through the photogrammetry mesh.
        viewer.scene.globe.show = false;
        viewer.scene.requestRender();
        return { ok: true };
      } catch (failure) {
        logger.error?.('Google Photorealistic 3D could not be loaded', failure);
        return { ok: false, reason: 'LOAD_FAILED', message: LOAD_FAILED_MESSAGE };
      }
    },

    /** Back to the existing basemap. The tileset is hidden and kept, never destroyed or reloaded. */
    disable() {
      if (tileset) tileset.show = false;
      viewer.scene.globe.show = true;
      viewer.scene.requestRender();
    },

    /** Only for tearing down the whole map (HMR dispose), never for an ordinary base-layer toggle. */
    destroy() {
      destroyed = true;
      viewer.scene.globe.show = true;
      if (tileset && !viewer.isDestroyed?.()) viewer.scene.primitives.remove(tileset);
      tileset = null; pending = null; state = LOAD_STATES.IDLE;
    },
  };
}
