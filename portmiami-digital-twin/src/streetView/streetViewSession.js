/**
 * Street View as a mode of the twin, not a separate page.
 *
 * Adapted from the ACS I-595 Safety Twin (`cesium-poc/src/streetViewMode.js`). The behaviour that
 * matters is that file's and is kept exactly: entering SAVES the twin's state — camera, navigation
 * settings and what was drawn — then hides the scene's content and shows a Google panorama over
 * it; nothing is destroyed, only `show` is flipped; and exiting puts every one of them back as it
 * was. Returning restores the saved camera directly, deliberately NOT Reset View: you come back to
 * where you left, not to the opening PortMiami view.
 *
 * Three differences from the ACS module, each deliberate:
 *
 *   1. It owns no DOM chrome. ACS builds its overlay with innerHTML and appends it to
 *      document.body; this app is React, so the overlay is a component
 *      (src/components/StreetViewOverlay.jsx) and this module is handed the element to mount the
 *      panorama into. Appending to body would put the overlay outside React's tree and make the
 *      panel-hiding rules depend on DOM order.
 *   2. The vestigial cube-map code is not carried over. The ACS module still holds a `panorama`
 *      primitive, a `removePanorama` that removes it from `scene.primitives`, and a wheel/FOV
 *      handler — none of which runs, because the live path renders the panorama with the Google
 *      Maps JS SDK in an element that covers the canvas. Porting dead code would have invited the
 *      next reader to maintain it.
 *   3. The twin's own tileset is read from the caller rather than from a corridor-wide registry.
 *
 * The one thing to understand about which Google product does what: the Cesium provider in
 * streetViewService.js answers "IS there a panorama here, and when was it taken". The panorama a
 * viewer actually looks at and walks through is the Maps JavaScript SDK's StreetViewPanorama,
 * loaded on first use. Both use the same VITE_GOOGLE_MAPS_API_KEY.
 */
import { Cartesian3, Cesium3DTileset, GoogleMaps } from 'cesium';

/**
 * Every 3D tileset currently in the scene.
 *
 * Read off the scene rather than handed in, so nothing has to expose the photorealistic tileset
 * just for Street View's benefit: `basePhotorealistic3D.js` keeps it private, as it should, and
 * this still finds it. A tileset added later is found too, with no wiring to remember.
 */
export function sceneTilesets(viewer) {
  const primitives = viewer.scene.primitives;
  const found = [];
  for (let index = 0; index < primitives.length; index++) {
    const primitive = primitives.get(index);
    if (primitive instanceof Cesium3DTileset) found.push(primitive);
  }
  return found;
}

/**
 * Loads the Maps JS SDK once per page, and never at application start-up.
 *
 * The key defaults to `GoogleMaps.defaultApiKey` — the one src/cesium/basePhotorealistic3D.js sets
 * from VITE_GOOGLE_MAPS_API_KEY, and the same one streetViewService.js reads. One key, resolved in
 * one place, read at use time: there is no second place for it to be missing from.
 */
let mapsPromise = null;
export function loadGoogleMaps(apiKey) {
  if (globalThis.google?.maps?.StreetViewPanorama) return Promise.resolve(globalThis.google.maps);
  const configured = apiKey ?? GoogleMaps.defaultApiKey;
  const key = typeof configured === 'string' ? configured.trim() : '';
  if (!key) return Promise.reject(new Error('VITE_GOOGLE_MAPS_API_KEY is not configured.'));
  mapsPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(globalThis.google.maps);
    script.onerror = () => { mapsPromise = null; reject(new Error('The Google Maps script could not be loaded.')); };
    document.head.append(script);
  }).catch(error => { mapsPromise = null; throw error; });
  return mapsPromise;
}

/**
 * Everything the twin needs to come back unchanged.
 *
 * Camera direction and up, not heading/pitch/roll: near a nadir view the angles are numerically
 * ill-conditioned and a round trip through them comes back a degree or so rotated. The vectors
 * restore the view exactly. (This is the ACS module's finding, kept.)
 */
export function saveTwinState(viewer, tilesets = []) {
  const camera = viewer.camera;
  const controller = viewer.scene.screenSpaceCameraController;
  return {
    camera: {
      destination: Cartesian3.clone(camera.positionWC, new Cartesian3()),
      direction: Cartesian3.clone(camera.directionWC, new Cartesian3()),
      up: Cartesian3.clone(camera.upWC, new Cartesian3()),
    },
    navigation: {
      enableRotate: controller.enableRotate, enableTranslate: controller.enableTranslate,
      enableZoom: controller.enableZoom, enableTilt: controller.enableTilt,
      enableLook: controller.enableLook,
    },
    globe: viewer.scene.globe.show,
    tilesets: tilesets.filter(Boolean).map(tileset => ({ tileset, show: tileset.show })),
    dataSources: [...Array(viewer.dataSources.length).keys()]
      .map(index => viewer.dataSources.get(index))
      .map(source => ({ source, show: source.show })),
  };
}

/** Put back exactly what `saveTwinState` recorded. */
export function restoreTwinState(viewer, saved) {
  if (!saved || viewer.isDestroyed()) return;
  for (const { source, show } of saved.dataSources) source.show = show;
  for (const { tileset, show } of saved.tilesets) { if (!tileset.isDestroyed?.()) tileset.show = show; }
  viewer.scene.globe.show = saved.globe;
  Object.assign(viewer.scene.screenSpaceCameraController, saved.navigation);
  viewer.camera.cancelFlight();
  // setView, never a reset: the viewer returns to the view they left.
  viewer.camera.setView({
    destination: saved.camera.destination,
    orientation: { direction: saved.camera.direction, up: saved.camera.up },
  });
  viewer.scene.requestRender();
}

/**
 * One Street View session over a viewer.
 *
 * @param {import('cesium').Viewer} viewer
 * @param {ReturnType<import('./streetViewService.js').createStreetViewService>} service
 * @param {{tilesets?: () => object[], apiKey?: string, logger?: Console}} [options]
 */
export function createStreetViewSession(viewer, service, { tilesets, apiKey, logger = console } = {}) {
  const allTilesets = tilesets ?? (() => sceneTilesets(viewer));
  let saved = null, panorama = null, host = null, busy = false, active = false;

  /**
   * Enter a panorama.
   *
   * Nothing is committed until the lookup AND the SDK have both succeeded, so a failure anywhere
   * above leaves the twin untouched rather than half-hidden.
   *
   * @param {{longitude: number, latitude: number, panoId?: string, headingDeg?: number}} place
   * @param {HTMLElement} mountElement
   * @returns {Promise<{ok: boolean, message?: string, panoId?: string}>}
   */
  async function enter(place, mountElement) {
    if (busy || active) return { ok: false };
    busy = true;
    try {
      // Placement has already asked Google; don't ask twice for the same drop.
      const found = place.panoId
        ? { status: 'found', panoId: place.panoId, longitude: place.longitude, latitude: place.latitude }
        : await service.findPanorama(place.longitude, place.latitude);
      if (found.status !== 'found') return { ok: false, message: found.message };

      const maps = await loadGoogleMaps(apiKey);
      if (!mountElement) return { ok: false, message: 'Street View had nowhere to render.' };

      saved = saveTwinState(viewer, allTilesets());
      for (const { source } of saved.dataSources) source.show = false;
      for (const { tileset } of saved.tilesets) tileset.show = false;
      viewer.scene.globe.show = false;
      viewer.scene.requestRender();

      host = mountElement;
      panorama = new maps.StreetViewPanorama(host, {
        pano: found.panoId,
        pov: { heading: place.headingDeg ?? 0, pitch: 0 },
        zoom: 1,
        addressControl: false,
        fullscreenControl: false,
        motionTracking: false,
        // Left on: walking the arrows is most of what Street View is for.
        linksControl: true,
      });
      active = true;
      return { ok: true, panoId: found.panoId };
    } catch (error) {
      logger.error?.('Street View could not start', error);
      exit();
      return { ok: false, message: 'Street View could not be opened. Please try again.' };
    } finally {
      busy = false;
    }
  }

  /** Leave, restoring the twin. Safe to call when not active. */
  function exit() {
    panorama = null;
    host?.replaceChildren();
    host = null;
    restoreTwinState(viewer, saved);
    saved = null;
    active = false;
  }

  return {
    enter,
    exit,
    isActive: () => active,
    /** The imagery date for a panorama, or null. Never presented as a live timestamp. */
    describe: panoId => service.describePanorama(panoId),
    destroy() { exit(); },
  };
}
