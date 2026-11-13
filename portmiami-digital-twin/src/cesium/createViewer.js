/**
 * The Cesium Viewer factory — one viewer, created once, destroyed once.
 *
 * Knows nothing about PortMiami: it takes a container, a key and camera limits, and hands back a
 * viewer plus the two things every caller needs (a proportional `zoom`, and `destroy`). The site's
 * geography is applied by the caller, from src/config/portMiami.js.
 *
 * Viewer options are the ACS project's, minus the widgets a map-only shell has no use for. The
 * animation and timeline widgets are off rather than hidden after the fact: this app has no clock.
 */
import {
  Cartesian3, CameraEventType, EllipsoidTerrainProvider, ImageryLayer, Ion, Terrain,
  UrlTemplateImageryProvider, Viewer,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { cameraPivot, zoomRange } from './camera.js';

/**
 * @param {HTMLElement} container
 * @param {{ionToken?: string, cameraLimits?: {minimumZoomDistance: number, maximumZoomDistance: number}}} [options]
 */
export function createPortViewer(container, { ionToken, cameraLimits } = {}) {
  const token = typeof ionToken === 'string' ? ionToken.trim() : '';
  if (token) Ion.defaultAccessToken = token;

  const viewer = new Viewer(container, {
    animation: false, timeline: false, baseLayerPicker: false, geocoder: false,
    homeButton: false, navigationHelpButton: false, sceneModePicker: false,
    fullscreenButton: false, infoBox: false, selectionIndicator: false,
    // The flat world under the photorealistic mesh. It is what remains visible if the tiles fail,
    // so it is a real basemap rather than a blue sphere.
    baseLayer: new ImageryLayer(new UrlTemplateImageryProvider({
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 19, credit: 'Imagery © Esri, Maxar, Earthstar Geographics',
    })),
    // World Terrain only when an ion token is configured; the photorealistic tiles carry their own
    // geometry, so the app is complete without one.
    ...(token ? { terrain: Terrain.fromWorldTerrain() } : { terrainProvider: new EllipsoidTerrainProvider() }),
  });

  viewer.scene.globe.enableLighting = false;

  // Manual navigation is always available: nothing in this app takes the camera away from the user.
  const controller = viewer.scene.screenSpaceCameraController;
  controller.enableRotate = true;
  controller.enableTranslate = true;
  controller.enableZoom = true;
  controller.enableTilt = true;
  controller.enableLook = true;
  controller.minimumZoomDistance = cameraLimits?.minimumZoomDistance ?? 1.5;
  controller.maximumZoomDistance = cameraLimits?.maximumZoomDistance ?? 20_000_000;
  // Wheel and trackpad deltas are handled below instead, so Cesium keeps only drag and pinch zoom.
  controller.zoomEventTypes = [CameraEventType.RIGHT_DRAG, CameraEventType.PINCH];

  /** Proportional zoom toward whatever is under the centre of the view, tiles included. */
  const zoom = factor => {
    if (viewer.isDestroyed()) return;
    viewer.camera.cancelFlight();
    const pivot = cameraPivot(viewer);
    const range = Cartesian3.distance(viewer.camera.positionWC, pivot);
    const target = zoomRange(range, factor, controller.minimumZoomDistance, controller.maximumZoomDistance);
    viewer.camera.zoomIn(range - target);
    viewer.scene.requestRender();
  };

  const onWheel = event => {
    event.preventDefault();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewer.canvas.clientHeight : 1);
    zoom(Math.exp(Math.max(-0.4, Math.min(0.4, pixels * 0.002))));
  };
  viewer.canvas.addEventListener('wheel', onWheel, { passive: false });

  return {
    viewer,
    zoom,
    /** Tears down the listener and the viewer together. Safe to call twice. */
    destroy() {
      if (viewer.isDestroyed()) return;
      viewer.canvas.removeEventListener('wheel', onWheel);
      viewer.destroy();
    },
  };
}
