/**
 * Drawing the area an operator asks about: click, drag, release.
 *
 * Deliberately additive. It borrows the map's inputs for the length of one drag and gives them
 * straight back — the camera is never left disabled, no layer is switched off, nothing already
 * selected is dropped, and the rectangle it leaves behind sits over the scene rather than replacing
 * any of it. Drawing an area is a question, not a change of view.
 *
 * Screen pixels become geographic coordinates at the moment of the drag, not at the moment of the
 * query: the whole point is to ask about a place, and a place is a longitude and a latitude. Over
 * Google's photorealistic tiles the depth buffer gives a point on the actual roof or road surface,
 * which is what the operator pointed at; where it cannot, the globe is used instead, so a drag over
 * sky or off the horizon simply produces no corner rather than a wrong one.
 */
import {
  CallbackProperty, Cartesian3, Cartographic, Color, CustomDataSource, Math as CesiumMath,
  Rectangle, ScreenSpaceEventHandler, ScreenSpaceEventType,
} from 'cesium';
import { boundsFromCorners, isUsableBounds } from './areaGeometry.js';

/** Restrained enough to read the corridor through it — §4: never an opaque block over the 3D. */
const FILL = Color.fromCssColorString('#38c9bf').withAlpha(0.14);
const OUTLINE = Color.fromCssColorString('#38c9bf').withAlpha(0.95);
/** The halo added to a matched road section. Drawn under its own colour, never instead of it. */
const SEGMENT_HALO = Color.fromCssColorString('#38c9bf').withAlpha(0.55);

/**
 * @param {import('cesium').Viewer} viewer
 * @returns {{start: () => void, cancel: () => void, clear: () => void, active: () => boolean,
 *            highlightSegments: (lines: {coordinates: number[][]}[]) => void, destroy: () => void}}
 */
export function createRectangleSelection(viewer, { onComplete = () => {}, onStart = () => {}, onCancel = () => {} } = {}) {
  const source = new CustomDataSource('Ask the Twin Area');
  const added = viewer.dataSources.add(source);
  const handler = new ScreenSpaceEventHandler(viewer.canvas);
  let drawing = false, armed = false, disposed = false;
  let first = null, live = null, committed = null;

  /** Where on the ground the pointer is. The tiles first, the globe as the fallback. */
  function groundAt(position) {
    const scene = viewer.scene;
    let cartesian = null;
    if (scene.pickPositionSupported) {
      try { cartesian = scene.pickPosition(position); } catch { cartesian = null; }
    }
    if (!cartesian) {
      const ray = viewer.camera.getPickRay(position);
      cartesian = ray ? scene.globe.pick(ray, scene) : null;
    }
    if (!cartesian) cartesian = viewer.camera.pickEllipsoid(position, scene.globe.ellipsoid);
    if (!cartesian) return null;
    const carto = Cartographic.fromCartesian(cartesian);
    return carto ? { longitude: CesiumMath.toDegrees(carto.longitude), latitude: CesiumMath.toDegrees(carto.latitude) } : null;
  }

  /** The rectangle currently being drawn or already drawn, whichever exists. */
  const shownBounds = () => (drawing && first && live ? boundsFromCorners(first, live) : committed);

  source.entities.add({
    id: 'ask-twin-area',
    rectangle: {
      coordinates: new CallbackProperty(() => {
        const bounds = shownBounds();
        return isUsableBounds(bounds)
          ? Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north) : undefined;
      }, false),
      material: FILL,
      outline: true,
      outlineColor: OUTLINE,
      outlineWidth: 2,
      // Clamped so it reads as an area ON the corridor rather than a pane floating above it.
      height: undefined,
    },
  });

  /** The camera is borrowed for one drag and handed straight back. */
  function setMapInputs(enabled) {
    const controller = viewer.scene.screenSpaceCameraController;
    controller.enableRotate = enabled;
    controller.enableTranslate = enabled;
    controller.enableZoom = enabled;
    controller.enableTilt = enabled;
    controller.enableLook = enabled;
  }

  function finish(bounds) {
    drawing = false;
    armed = false;
    first = null; live = null;
    setMapInputs(true);
    viewer.canvas.style.cursor = '';
    viewer.scene.requestRender();
    if (isUsableBounds(bounds)) { committed = bounds; onComplete(bounds); }
    else { onCancel(); }
  }

  handler.setInputAction(({ position }) => {
    if (!armed) return;
    const corner = groundAt(position);
    // A press on sky or off the globe is not a corner; the mode stays armed for another try.
    if (!corner) return;
    first = corner; live = corner; drawing = true;
    setMapInputs(false);
    viewer.scene.requestRender();
  }, ScreenSpaceEventType.LEFT_DOWN);

  handler.setInputAction(({ endPosition }) => {
    if (!drawing) return;
    const corner = groundAt(endPosition);
    if (corner) { live = corner; viewer.scene.requestRender(); }
  }, ScreenSpaceEventType.MOUSE_MOVE);

  handler.setInputAction(({ position }) => {
    if (!drawing) return;
    finish(boundsFromCorners(first, groundAt(position) ?? live));
  }, ScreenSpaceEventType.LEFT_UP);

  return {
    active: () => armed || drawing,
    /** Arm the next drag. Drawing mode ends by itself when the drag does — §3. */
    start() {
      if (disposed) return;
      armed = true;
      viewer.canvas.style.cursor = 'crosshair';
      onStart();
    },
    /** Leave drawing mode without drawing; whatever was already selected stays. */
    cancel() {
      if (!armed && !drawing) return;
      drawing = false; armed = false; first = null; live = null;
      setMapInputs(true);
      viewer.canvas.style.cursor = '';
      viewer.scene.requestRender();
    },
    /** Remove the area and its section highlights. The map is otherwise untouched — §29. */
    clear() {
      committed = null;
      this.highlightSegments([]);
      viewer.scene.requestRender();
    },
    /**
     * Mark the road sections the area crosses.
     *
     * A wide translucent halo UNDER the corridor's own lines, never a recolour of them: a section
     * showing HIGH operational impact has to keep its red while also reading as selected, and
     * repainting it would trade the more important fact for the less important one.
     */
    highlightSegments(lines = []) {
      for (const entity of [...source.entities.values]) {
        if (entity.id !== 'ask-twin-area') source.entities.remove(entity);
      }
      for (const [index, line] of lines.entries()) {
        const positions = (line?.coordinates ?? [])
          .filter(point => Number.isFinite(point?.[0]) && Number.isFinite(point?.[1]))
          .map(([longitude, latitude]) => Cartesian3.fromDegrees(longitude, latitude));
        if (positions.length < 2) continue;
        source.entities.add({
          id: `ask-twin-area-segment-${index}`,
          polyline: { positions, width: 16, material: SEGMENT_HALO, clampToGround: true },
        });
      }
      viewer.scene.requestRender();
    },
    destroy() {
      disposed = true;
      handler.destroy();
      setMapInputs(true);
      viewer.canvas.style.cursor = '';
      void added.then(() => viewer.dataSources.remove(source, true)).catch(() => {});
    },
  };
}
