/**
 * The Tower A model viewer.
 *
 * CESIUM, not a new dependency. It is already in this repository with its build assets wired by
 * vite-plugin-cesium, and it gives orbit, zoom, pan and picking for nothing. Adding Three.js
 * would mean a second 3D stack for one screen. The globe, imagery, terrain, atmosphere and sky
 * are all switched OFF — this is a model viewer that happens to use Cesium's camera, not a map.
 *
 * I-595 is untouched by it: the two projects are separate page loads (see src/projects.js), so
 * this viewer and the corridor's never exist in the same document.
 *
 * EVERY BOX IS A DATABASE ROW. The server hands over element ids with their stored geometry; this
 * file generates no shape of its own, so anything that can be picked resolves to a record.
 */
import {
  BoxGeometry, Cartesian3, Color, ColorGeometryInstanceAttribute, GeometryInstance,
  HeadingPitchRange, Matrix4, PerInstanceColorAppearance, Primitive, ScreenSpaceEventHandler,
  ScreenSpaceEventType, Transforms, Viewer, Math as CesiumMath, BoundingSphere,
} from 'cesium';

/** Where the synthetic site sits. Arbitrary and flat; the building is in a local frame on it. */
const SITE = Object.freeze({ longitude: 72.8777, latitude: 19.076, height: 0 });

/**
 * How an element is coloured, by what is being asked of the view.
 *
 * Planned and actual are never blended into one colour: a mode shows one or the other, and
 * Variance shows where they disagree. Each state carries a word in the legend, so the view is
 * never colour alone.
 */
export const MODES = Object.freeze([
  { id: 'planned', label: 'Planned' },
  { id: 'actual', label: 'Verified actual' },
  { id: 'variance', label: 'Variance' },
]);

export const LEGEND = Object.freeze({
  planned: [
    { tone: '#4a8fd6', label: 'Scheduled built by this date' },
    { tone: '#2a3444', label: 'Not yet scheduled' },
  ],
  actual: [
    { tone: '#35c79a', label: 'Verified built' },
    { tone: '#2a3444', label: 'No verified observation' },
  ],
  variance: [
    { tone: '#35c79a', label: 'Built and scheduled' },
    { tone: '#e0a24e', label: 'Scheduled, not verified built' },
    { tone: '#7c6bd6', label: 'Built ahead of schedule' },
    { tone: '#2a3444', label: 'Neither' },
  ],
});

const PALETTE = Object.freeze({
  plannedBuilt: Color.fromCssColorString('#4a8fd6'),
  actualBuilt: Color.fromCssColorString('#35c79a'),
  behind: Color.fromCssColorString('#e0a24e'),
  ahead: Color.fromCssColorString('#7c6bd6'),
  idle: Color.fromCssColorString('#2a3444'),
  unmapped: Color.fromCssColorString('#ee6a6a'),
  selected: Color.fromCssColorString('#ffd166'),
  highlighted: Color.fromCssColorString('#67f4e2'),
});

function colourFor(element, { mode, selectedId, highlighted }) {
  if (element.elementId === selectedId) return PALETTE.selected;
  if (highlighted.has(element.elementId)) return PALETTE.highlighted;
  if (element.unmapped) return PALETTE.unmapped;
  if (mode === 'planned') return element.plannedBuilt ? PALETTE.plannedBuilt : PALETTE.idle;
  if (mode === 'actual') return element.actualBuilt ? PALETTE.actualBuilt : PALETTE.idle;
  // Variance: the point is where the two disagree.
  if (element.actualBuilt && element.plannedBuilt) return PALETTE.actualBuilt;
  if (element.plannedBuilt) return PALETTE.behind;
  if (element.actualBuilt) return PALETTE.ahead;
  return PALETTE.idle;
}

/**
 * Mount the viewer.
 *
 * @param {HTMLElement} host
 * @param {{onPick?: (elementId: string|null) => void}} [options]
 */
export function installTowerModel(host, { onPick = null } = {}) {
  const container = document.createElement('div');
  container.className = 'ci-viewer';
  host.append(container);

  const viewer = new Viewer(container, {
    // Everything a map needs and a model viewer does not.
    baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
    navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
    infoBox: false, selectionIndicator: false, baseLayer: false, shouldAnimate: false,
    requestRenderMode: true, maximumRenderTimeChange: Infinity,
  });
  viewer.scene.globe.show = false;
  viewer.scene.skyBox.show = false;
  viewer.scene.skyAtmosphere.show = false;
  viewer.scene.sun.show = false;
  viewer.scene.moon.show = false;
  viewer.scene.backgroundColor = Color.fromCssColorString('#0d1420');
  viewer.cesiumWidget.creditContainer.style.display = 'none';

  const frame = Transforms.eastNorthUpToFixedFrame(
    Cartesian3.fromDegrees(SITE.longitude, SITE.latitude, SITE.height));

  let elements = [];
  let primitive = null;
  let mode = 'planned';
  let selectedId = null;
  let highlighted = new Set();
  /** Element id by the primitive's own instance id, so a pick resolves to a record. */
  let hidden = new Set();

  function rebuild() {
    if (primitive) { viewer.scene.primitives.remove(primitive); primitive = null; }
    const visible = elements.filter(element => !hidden.has(element.category));
    if (!visible.length) { viewer.scene.requestRender(); return; }

    const instances = visible.map(element => new GeometryInstance({
      geometry: BoxGeometry.fromDimensions({
        vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
        dimensions: new Cartesian3(element.sx, element.sy, element.sz),
      }),
      modelMatrix: Matrix4.multiplyByTranslation(
        frame, new Cartesian3(element.x, element.y, element.z), new Matrix4()),
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(
          colourFor(element, { mode, selectedId, highlighted })),
      },
      // The id IS the element id, so picking needs no lookup table that could drift.
      id: element.elementId,
    }));
    primitive = viewer.scene.primitives.add(new Primitive({
      geometryInstances: instances,
      appearance: new PerInstanceColorAppearance({ translucent: false, closed: true }),
      asynchronous: false,
    }));
    viewer.scene.requestRender();
  }

  const picker = new ScreenSpaceEventHandler(viewer.canvas);
  picker.setInputAction(movement => {
    const picked = viewer.scene.pick(movement.position);
    const id = typeof picked?.id === 'string' ? picked.id : null;
    onPick?.(id);
  }, ScreenSpaceEventType.LEFT_CLICK);

  /** Frame a set of elements, or the whole building when none is given. */
  function fit(ids = null) {
    const chosen = ids?.length
      ? elements.filter(element => ids.includes(element.elementId)) : elements;
    if (!chosen.length) return;
    const points = chosen.map(element => Matrix4.multiplyByPoint(
      frame, new Cartesian3(element.x, element.y, element.z), new Cartesian3()));
    const sphere = BoundingSphere.fromPoints(points);
    viewer.camera.flyToBoundingSphere(sphere, {
      duration: 1.1,
      offset: new HeadingPitchRange(CesiumMath.toRadians(-40), CesiumMath.toRadians(-25),
        Math.max(70, sphere.radius * 3.4)),
    });
  }

  return {
    container,
    viewer,
    /** Replace the model. The server decides what it contains; this only draws it. */
    setElements(next) { elements = next ?? []; rebuild(); },
    setMode(next) { mode = next; rebuild(); },
    select(elementId) { selectedId = elementId ?? null; rebuild(); },
    /** Ring the elements one activity builds, without changing the selection. */
    highlight(ids) { highlighted = new Set(ids ?? []); rebuild(); },
    toggleCategory(category, show) {
      if (show) hidden.delete(category); else hidden.add(category);
      rebuild();
    },
    get hiddenCategories() { return [...hidden]; },
    fit,
    reset() {
      selectedId = null; highlighted = new Set(); hidden = new Set();
      rebuild(); fit();
    },
    destroy() {
      picker.destroy();
      if (!viewer.isDestroyed()) viewer.destroy();
      container.remove();
    },
  };
}
