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
import { boundsFromCorners, boundsToPolygon, clipLineStringToBounds, isUsableBounds } from './areaGeometry.js';

/** Restrained enough to read the corridor through it — §4: never an opaque block over the 3D. */
const FILL = Color.fromCssColorString('#38c9bf').withAlpha(0.16);
/**
 * The border is drawn as its own ground polyline rather than with `rectangle.outline`.
 *
 * Cesium ignores `outlineWidth` for clamped geometry on virtually all hardware — WebGL will not
 * draw a line wider than 1px — so the boundary came out as a hairline that vanished over bright
 * imagery. A polyline is a ground primitive with real width, and it gets a dark casing underneath
 * so the edge stays visible over pale concrete as well as over dark water.
 */
const EDGE = Color.fromCssColorString('#5FF2E6');
const EDGE_CASING = Color.fromCssColorString('#04222B').withAlpha(0.85);
const EDGE_WIDTH = 3;
const CASING_WIDTH = 7;
/** The halo added to a matched road section, over the part inside the area only. */
const SEGMENT_HALO = Color.fromCssColorString('#5FF2E6').withAlpha(0.6);

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
      // Clamped so it reads as an area ON the corridor rather than a pane floating above it.
      height: undefined,
    },
  });

  /** The boundary ring, as ground positions — recomputed while the drag is live. */
  const edgePositions = () => {
    const bounds = shownBounds();
    if (!isUsableBounds(bounds)) return [];
    return boundsToPolygon(bounds).map(([longitude, latitude]) => Cartesian3.fromDegrees(longitude, latitude));
  };
  // Casing first so the bright edge sits on top of it.
  for (const [id, material, width] of [['ask-twin-area-casing', EDGE_CASING, CASING_WIDTH], ['ask-twin-area-edge', EDGE, EDGE_WIDTH]]) {
    source.entities.add({
      id,
      polyline: {
        positions: new CallbackProperty(edgePositions, false),
        width, material, clampToGround: true,
      },
    });
  }

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
    highlightSegments(lines = [], bounds = committed) {
      for (const entity of [...source.entities.values]) {
        if (entity.id?.startsWith('ask-twin-area-segment-')) source.entities.remove(entity);
      }
      let index = 0;
      for (const line of lines) {
        // Only the stretch inside the area. Highlighting the whole matched section lit four miles
        // of corridor for a box a few hundred metres across, and the highlight then swamped the
        // very thing it was meant to point at.
        for (const path of clipLineStringToBounds(line?.coordinates ?? [], bounds)) {
          const positions = path.map(([longitude, latitude]) => Cartesian3.fromDegrees(longitude, latitude));
          if (positions.length < 2) continue;
          source.entities.add({
            id: `ask-twin-area-segment-${index++}`,
            polyline: { positions, width: 14, material: SEGMENT_HALO, clampToGround: true },
          });
        }
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
