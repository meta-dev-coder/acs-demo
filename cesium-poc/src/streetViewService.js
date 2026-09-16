/**
 * Google Street View panoramas, through Cesium's own provider.
 *
 * Cesium 1.143 ships GoogleStreetViewCubeMapPanoramaProvider, which renders a panorama as a
 * primitive inside the existing scene — no second renderer, no Maps JavaScript SDK, no iframe.
 *
 * It takes no key of its own: by default it uses `GoogleMaps.defaultApiKey`, the same key the
 * photorealistic tileset already sets from VITE_GOOGLE_MAPS_API_KEY. Reading that at use time
 * rather than at construction also means Street View is correctly unavailable whenever the tileset
 * is — there is one key, configured in one place.
 *
 * The provider is created on first use, so nothing here touches application start-up.
 *
 * Google API used: Map Tiles API — Street View Tiles (panorama metadata and cube faces). Billable.
 */
import { Cartographic, GoogleMaps, GoogleStreetViewCubeMapPanoramaProvider, Math as CMath } from 'cesium';

/** How far from the requested point Google may look for a panorama. */
export const PANORAMA_SEARCH_RADIUS_M = 60;

/**
 * Street View metadata statuses that mean "there simply isn't one here", as opposed to a problem
 * with the request or the key. @see https://developers.google.com/maps/documentation/streetview
 */
const ABSENT_STATUSES = new Set(['ZERO_RESULTS', 'NOT_FOUND']);

/** @typedef {'found'|'none'|'unavailable'} PanoramaLookup */

/**
 * Turn the provider's thrown metadata error into something the UI can act on. The provider throws
 * for every non-OK status, including the ordinary "no panorama near here" case.
 * @returns {{status: PanoramaLookup, reason: string|null, message: string}}
 */
export function classifyLookupFailure(error) {
  const text = String(error?.message ?? error ?? '');
  const status = /metadata error:\s*([A-Z_]+)/.exec(text)?.[1] ?? null;
  if (status && ABSENT_STATUSES.has(status)) {
    return { status: 'none', reason: status, message: 'Street View isn’t available near this location.' };
  }
  if (status === 'OVER_QUERY_LIMIT') {
    return { status: 'unavailable', reason: status, message: 'Street View is temporarily unavailable (Google quota reached).' };
  }
  if (status === 'REQUEST_DENIED') {
    return { status: 'unavailable', reason: status, message: 'Street View is not enabled for this map key.' };
  }
  return { status: 'unavailable', reason: status, message: 'Street View could not be reached. Please try again.' };
}

/** Google returns "2016-12"; show it as text a viewer can read, and never as a live timestamp. */
export function formatImageryDate(date) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(date ?? ''));
  if (!match) return null;
  const month = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return `${month.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${match[1]}`;
}

/**
 * @param {{apiKey?: string, radiusM?: number, createProvider?: () => Promise<object>, logger?: Console}} [options]
 */
export function createStreetViewService({ apiKey, radiusM = PANORAMA_SEARCH_RADIUS_M, createProvider, logger = console } = {}) {
  /** Resolved when needed, so the tileset has had its chance to configure the shared key. */
  const currentKey = () => {
    const value = apiKey ?? GoogleMaps.defaultApiKey;
    return typeof value === 'string' ? value.trim() : '';
  };
  const factory = createProvider ?? (() => GoogleStreetViewCubeMapPanoramaProvider.fromUrl({ key: currentKey() }));
  let provider = null, pending = null;

  /** Lazy and single-flight: at most one provider is ever created. */
  async function ready() {
    if (provider) return provider;
    if (!currentKey()) throw new Error('VITE_GOOGLE_MAPS_API_KEY is not configured.');
    pending ??= factory().then(created => { provider = created; return created; }).catch(error => { pending = null; throw error; });
    return pending;
  }

  return {
    hasApiKey: () => currentKey() !== '',
    isReady: () => provider != null,

    /**
     * Find the nearest panorama to a point.
     * @returns {Promise<{status: PanoramaLookup, panoId?: string, longitude?: number, latitude?: number, message?: string}>}
     */
    async findPanorama(longitude, latitude, radius = radiusM) {
      if (!currentKey()) return { status: 'unavailable', message: 'Street View needs VITE_GOOGLE_MAPS_API_KEY.' };
      try {
        const found = await (await ready()).getNearestPanoId(Cartographic.fromDegrees(longitude, latitude), radius);
        return { status: 'found', panoId: found.panoId, longitude: found.longitude, latitude: found.latitude };
      } catch (error) {
        const classified = classifyLookupFailure(error);
        // "No panorama here" is an answer, not a fault; only report the rest as problems.
        if (classified.status !== 'none') logger.error?.('Street View lookup failed', error);
        return classified;
      }
    },

    /** Imagery date and copyright for a panorama, or null when Google does not supply them. */
    async describePanorama(panoId) {
      try {
        const metadata = await (await ready()).getPanoIdMetadata(panoId);
        return {
          date: formatImageryDate(metadata?.date ?? metadata?.imageDate),
          copyright: metadata?.copyright ?? null,
        };
      } catch (error) {
        logger.warn?.('Street View metadata unavailable', error);
        return { date: null, copyright: null };
      }
    },

    /** The panorama primitive itself, ready to add to the scene. */
    async loadPanorama({ longitude, latitude, height = 0, panoId }) {
      return (await ready()).loadPanorama({
        cartographic: Cartographic.fromDegrees(longitude, latitude, height), panoId,
      });
    },

    /** Bearing in degrees from one lon/lat to another — used to face along the road. */
    bearingBetween(from, to) {
      const dLon = (to.longitude - from.longitude) * Math.cos(CMath.toRadians((from.latitude + to.latitude) / 2));
      return (Math.atan2(dLon, to.latitude - from.latitude) * 180 / Math.PI + 360) % 360;
    },
  };
}
