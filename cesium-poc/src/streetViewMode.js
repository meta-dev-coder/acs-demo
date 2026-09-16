/**
 * Street View as a scene mode of the digital twin, not a separate page.
 *
 * Entering saves the twin's state — camera, navigation settings, and what was drawn — then hides
 * the scene's content and puts the camera inside a Street View cube map. The panorama is drawn
 * before everything else, so the photorealistic tileset and the corridor layers have to be hidden
 * or they would sit in front of it; nothing is destroyed, only `show` is flipped, and exiting puts
 * every one of them back exactly as it was.
 *
 * Returning restores the saved camera directly. It is deliberately not Reset View: you come back to
 * where you left, not to the corridor overview.
 */
import { Cartesian3, CameraEventType, Math as CMath } from 'cesium';

/** @typedef {'digital-twin'|'street-view'} MapExperienceMode */

/** Eye height above the panorama's ground position, so the view sits where a camera car would. */
const EYE_HEIGHT_M = 2.5;
/** Field of view limits for wheel zoom inside a panorama, in degrees. */
const MIN_FOV_DEG = 20, MAX_FOV_DEG = 100;

/**
 * @param {import('cesium').Viewer} viewer
 * @param {ReturnType<import('./streetViewService.js').createStreetViewService>} service
 * @param {{tilesets?: () => object[], onModeChange?: (mode: MapExperienceMode) => void, logger?: Console}} [options]
 */
export function createStreetViewMode(viewer, service, { tilesets = () => [], onModeChange, logger = console } = {}) {
  const overlay = document.createElement('section');
  overlay.className = 'street-view';
  overlay.hidden = true;
  overlay.setAttribute('aria-label', 'Street View');
  overlay.innerHTML = `
    <div class="street-view-google" aria-label="Google Street View panorama"></div>
    <div class="street-view-bar">
      <div class="street-view-identity">
        <p class="street-view-title">I-595 Street View</p>
        <p class="street-view-context"></p>
      </div>
      <p class="street-view-imagery" hidden></p>
      <button class="street-view-return" type="button">Return to Digital Twin</button>
    </div>
    <p class="street-view-status" role="status" hidden></p>`;
  document.body.append(overlay);

  const context = overlay.querySelector('.street-view-context');
  const imagery = overlay.querySelector('.street-view-imagery');
  const statusLine = overlay.querySelector('.street-view-status');
  const panoramaHost = overlay.querySelector('.street-view-google');

  /** @type {MapExperienceMode} */
  let mode = 'digital-twin';
  let panorama = null, googlePanorama = null, saved = null, busy = false;

  async function loadGoogleMaps() {
    if (window.google?.maps?.StreetViewPanorama) return window.google.maps;
    const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    if (!key) throw new Error('VITE_GOOGLE_MAPS_API_KEY is not configured.');
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}`;
      script.async = true; script.defer = true; script.onload = resolve; script.onerror = reject;
      document.head.append(script);
    });
    return window.google.maps;
  }

  const setMode = next => { if (next !== mode) { mode = next; onModeChange?.(mode); } };

  /** Everything the twin needs to come back unchanged. */
  function saveTwinState() {
    const camera = viewer.camera, controller = viewer.scene.screenSpaceCameraController;
    return {
      // Direction and up, not heading/pitch/roll: near a nadir view the angles are numerically
      // ill-conditioned, and a round trip through them comes back a degree or so rotated. The
      // vectors restore the view exactly.
      camera: {
        destination: Cartesian3.clone(camera.positionWC, new Cartesian3()),
        direction: Cartesian3.clone(camera.directionWC, new Cartesian3()),
        up: Cartesian3.clone(camera.upWC, new Cartesian3()),
      },
      navigation: {
        enableRotate: controller.enableRotate, enableTranslate: controller.enableTranslate,
        enableZoom: controller.enableZoom, enableTilt: controller.enableTilt, enableLook: controller.enableLook,
        lookEventTypes: controller.lookEventTypes,
      },
      globe: viewer.scene.globe.show,
      fov: viewer.camera.frustum.fov,
      tilesets: tilesets().filter(Boolean).map(tileset => ({ tileset, show: tileset.show })),
      dataSources: [...Array(viewer.dataSources.length).keys()]
        .map(index => viewer.dataSources.get(index)).map(source => ({ source, show: source.show })),
    };
  }

  /** Wheel zoom inside a panorama narrows the field of view, as a panorama viewer should. */
  function onPanoramaWheel(event) {
    if (mode !== 'street-view') return;
    event.preventDefault();
    const frustum = viewer.camera.frustum;
    if (!Number.isFinite(frustum.fov)) return;
    const next = CMath.toDegrees(frustum.fov) * Math.exp(Math.max(-0.3, Math.min(0.3, event.deltaY * 0.002)));
    frustum.fov = CMath.toRadians(Math.min(MAX_FOV_DEG, Math.max(MIN_FOV_DEG, next)));
    viewer.scene.requestRender();
  }

  /** Inside a panorama, first-person look is the only navigation that makes sense. */
  function applyPanoramaNavigation() {
    const controller = viewer.scene.screenSpaceCameraController;
    controller.enableRotate = false;
    controller.enableTranslate = false;
    controller.enableZoom = false;
    controller.enableTilt = false;
    controller.enableLook = true;
    controller.lookEventTypes = [CameraEventType.LEFT_DRAG];
  }

  function restoreTwinState() {
    if (!saved) return;
    for (const { source, show } of saved.dataSources) source.show = show;
    for (const { tileset, show } of saved.tilesets) tileset.show = show;
    viewer.scene.globe.show = saved.globe;
    if (Number.isFinite(saved.fov)) viewer.camera.frustum.fov = saved.fov;
    Object.assign(viewer.scene.screenSpaceCameraController, saved.navigation);
    viewer.camera.cancelFlight();
    // setView, never Reset View: the user returns to the view they left.
    viewer.camera.setView({
      destination: saved.camera.destination,
      orientation: { direction: saved.camera.direction, up: saved.camera.up },
    });
    saved = null;
  }

  function removePanorama() {
    if (!panorama) return;
    viewer.scene.primitives.remove(panorama);
    panorama = null;
    googlePanorama = null;
    panoramaHost.replaceChildren();
  }

  const showStatus = message => { statusLine.hidden = !message; statusLine.textContent = message ?? ''; };

  /**
   * @param {{longitude: number, latitude: number, label?: string, headingDeg?: number}} place
   * @returns {Promise<{ok: boolean, message?: string}>}
   */
  async function enter(place) {
    if (busy || mode === 'street-view') return { ok: false };
    busy = true;
    try {
      overlay.hidden = false;
      overlay.dataset.state = 'loading';
      context.textContent = place.label ?? '';
      imagery.hidden = true;
      showStatus('Finding Street View…');

      // Placement has already asked Google; don't ask twice for the same drop.
      const found = place.panoId
        ? { status: 'found', panoId: place.panoId, longitude: place.longitude, latitude: place.latitude }
        : await service.findPanorama(place.longitude, place.latitude);
      if (found.status !== 'found') {
        overlay.hidden = true;
        return { ok: false, message: found.message };
      }

      const maps = await loadGoogleMaps();

      // Only now commit: the twin is untouched if anything above failed.
      saved = saveTwinState();
      for (const { source } of saved.dataSources) source.show = false;
      for (const { tileset } of saved.tilesets) tileset.show = false;
      viewer.scene.globe.show = false;
      googlePanorama = new maps.StreetViewPanorama(panoramaHost, { pano: found.panoId, pov: { heading: place.headingDeg ?? 0, pitch: 0 }, zoom: 1, addressControl: false, fullscreenControl: false, motionTracking: false, linksControl: true });
      panoramaHost.hidden = false;

      overlay.dataset.state = 'active';
      showStatus(null);
      setMode('street-view');

      // Imagery date arrives after the view is up; it must never read as live.
      void service.describePanorama(found.panoId).then(({ date }) => {
        if (mode !== 'street-view') return;
        imagery.hidden = !date;
        imagery.textContent = date ? `Street View imagery: ${date}` : '';
      });
      return { ok: true };
    } catch (error) {
      logger.error?.('Street View could not start', error);
      removePanorama();
      restoreTwinState();
      overlay.hidden = true;
      return { ok: false, message: 'Street View could not be opened. Please try again.' };
    } finally {
      busy = false;
    }
  }

  function exit() {
    if (mode !== 'street-view') return;
    viewer.canvas.removeEventListener('wheel', onPanoramaWheel);
    removePanorama();
    restoreTwinState();
    overlay.hidden = true;
    overlay.dataset.state = '';
    showStatus(null);
    viewer.scene.requestRender();
    setMode('digital-twin');
  }

  overlay.querySelector('.street-view-return').onclick = exit;
  const onKeyDown = event => { if (event.key === 'Escape' && mode === 'street-view') exit(); };
  document.addEventListener('keydown', onKeyDown);

  return {
    element: overlay,
    get mode() { return mode; },
    isActive: () => mode === 'street-view',
    enter, exit,
    destroy() {
      document.removeEventListener('keydown', onKeyDown);
      exit();
      overlay.remove();
    },
  };
}
