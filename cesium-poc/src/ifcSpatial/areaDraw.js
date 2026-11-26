/**
 * Select Area on the IFC Spatial Twin's map: a rectangle (press, drag, release) or a polygon (click the
 * corners; double-click or Finish to close it; Escape cancels), and the selected area drawn as a thin cyan
 * boundary over a faint fill, clamped to the ground, with a small "Selected area" label.
 *
 * Adapted from the I-595 twin's rectangle selection (src/spatial/rectangleSelection.js): the same ground
 * picking (the rendered surface first, then the globe) and the same borrowed camera inputs, given straight
 * back when drawing ends. Its own data source: clearing asset or network highlights never removes the area,
 * and clearing the area never touches them.
 *
 * Coordinates leave this module as [lon, lat] (EPSG:4326); the area is validated in areaQuery.js.
 */
import {
  CallbackProperty, Cartesian2, Cartesian3, Cartographic, ClassificationType, Color, ConstantPositionProperty, CustomDataSource,
  HorizontalOrigin, LabelStyle, Math as CMath, PolygonHierarchy, ScreenSpaceEventHandler, ScreenSpaceEventType, VerticalOrigin,
} from 'cesium';


const CYAN = '#3fd8f0';
const FILL = Color.fromCssColorString(CYAN).withAlpha(0.12);
const EDGE = Color.fromCssColorString(CYAN).withAlpha(0.95);
const CASING = Color.fromCssColorString('#04222b').withAlpha(0.7);

export const AREA_MODE = Object.freeze({ RECTANGLE: 'RECTANGLE', POLYGON: 'POLYGON' });

/**
 * @param {import('cesium').Viewer} viewer
 * @param {object} cb
 * @param {(ring: number[][], mode: string) => void} cb.onComplete a closed ring of [lon, lat] (not yet validated)
 * @param {(reason: string) => void} cb.onCancel 'cancelled' | 'no-ground' | 'too-few-points'
 * @param {(state: {mode, points: number}) => void} [cb.onProgress]
 */
export function createAreaDraw(viewer, { onComplete = () => {}, onCancel = () => {}, onProgress = () => {} } = {}) {
  const source = new CustomDataSource('Ask the Twin selected area');
  void viewer.dataSources.add(source);
  const handler = new ScreenSpaceEventHandler(viewer.canvas);
  let mode = null; // drawing mode, null when idle
  let points = []; // polygon corners, [lon, lat]
  let start = null, rect = null; // the rectangle: its first screen corner, and its four ground corners now
  let hover = null; // the pointer on the ground, [lon, lat]
  let dragging = false;
  let committed = null; // the selected area's ring
  let savedDouble = null;
  let lastClickAt = 0;

  /** Where on the ground the pointer is: the rendered surface (tiles, model), else the globe, else the ellipsoid. */
  function groundAt(position) {
    const scene = viewer.scene;
    let c = null;
    if (scene.pickPositionSupported) { try { c = scene.pickPosition(position); } catch { c = null; } }
    if (!c) { const ray = viewer.camera.getPickRay(position); c = ray ? scene.globe.pick(ray, scene) : null; }
    if (!c) c = viewer.camera.pickEllipsoid(position, scene.globe.ellipsoid);
    if (!c) return null;
    const g = Cartographic.fromCartesian(c);
    if (!g || !Number.isFinite(g.longitude) || !Number.isFinite(g.latitude)) return null;
    return [CMath.toDegrees(g.longitude), CMath.toDegrees(g.latitude)];
  }

  /**
   * The rectangle as dragged on the screen: its four screen corners, each placed on the ground (so on a turned
   * or tilted map the area is the one the user sees). Null when a corner is off the ground (sky, horizon).
   */
  function screenRect(a, b) {
    // Cartesian2, not plain objects: Cesium caches pickPosition by the position's string form.
    const corners = [[a.x, a.y], [b.x, a.y], [b.x, b.y], [a.x, b.y]].map(([x, y]) => groundAt(new Cartesian2(x, y)));
    return corners.every(Boolean) ? corners : null;
  }
  const draftRing = () => {
    if (mode === AREA_MODE.RECTANGLE) return dragging ? rect : null;
    if (mode === AREA_MODE.POLYGON) return hover ? [...points, hover] : points;
    return null;
  };
  const shownRing = () => (mode ? draftRing() : committed);
  const toCart = ring => ring.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat));

  // The fill: only for a ring of three or more corners.
  source.entities.add({
    id: 'area:fill',
    polygon: {
      hierarchy: new CallbackProperty(() => { const r = shownRing(); return r && r.length >= 3 ? new PolygonHierarchy(toCart(r)) : undefined; }, false),
      material: FILL, classificationType: ClassificationType.BOTH,
    },
  });
  // The boundary: a dark casing under a thin cyan line, so it reads over pale concrete and dark water alike.
  for (const [id, material, width] of [['area:casing', CASING, 5], ['area:edge', EDGE, 2]]) {
    source.entities.add({
      id,
      polyline: {
        positions: new CallbackProperty(() => { const r = shownRing(); if (!r || r.length < 2) return []; return toCart(mode === AREA_MODE.POLYGON ? r : [...r, r[0]]); }, false),
        width, material, clampToGround: true, classificationType: ClassificationType.BOTH,
      },
    });
  }
  // Corner dots while drawing a polygon.
  const dots = [];
  const label = source.entities.add({
    id: 'area:label', show: false, position: new ConstantPositionProperty(Cartesian3.fromDegrees(0, 0)),
    label: { text: 'Selected area', font: '600 11px "IBM Plex Sans", system-ui, sans-serif', fillColor: Color.fromCssColorString('#d9f7fc'),
      outlineColor: Color.fromCssColorString('#04222b'), outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE,
      showBackground: true, backgroundColor: Color.fromCssColorString('#04222b').withAlpha(0.72), backgroundPadding: new Cartesian2(6, 3),
      horizontalOrigin: HorizontalOrigin.LEFT, verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(4, -4), disableDepthTestDistance: Number.POSITIVE_INFINITY },
  });
  function redrawDots() {
    for (const d of dots.splice(0)) source.entities.remove(d);
    if (mode !== AREA_MODE.POLYGON) return;
    for (const [lon, lat] of points) dots.push(source.entities.add({ position: Cartesian3.fromDegrees(lon, lat), point: { pixelSize: 7, color: EDGE, outlineColor: CASING, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY } }));
  }

  /** The camera inputs are borrowed while drawing (zoom stays) and handed straight back. */
  function setInputs(enabled) {
    const c = viewer.scene.screenSpaceCameraController;
    c.enableRotate = enabled; c.enableTranslate = enabled; c.enableTilt = enabled; c.enableLook = enabled;
    // The viewer's own double-click (fly to / track an entity) would take the polygon's closing double-click.
    const own = viewer.cesiumWidget?.screenSpaceEventHandler;
    if (own) {
      if (!enabled) { savedDouble = own.getInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK) ?? null; own.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK); }
      else if (savedDouble) { own.setInputAction(savedDouble, ScreenSpaceEventType.LEFT_DOUBLE_CLICK); savedDouble = null; }
    }
    viewer.canvas.style.cursor = enabled ? '' : 'crosshair';
  }
  const progress = () => onProgress({ mode, points: points.length });
  function end() {
    mode = null; points = []; hover = null; dragging = false; start = null; rect = null;
    redrawDots();
    setInputs(true);
    window.removeEventListener('keydown', onKey, true);
    viewer.scene.requestRender();
  }
  function onKey(e) {
    if (!mode) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.cancel(); }
    else if (e.key === 'Enter' && mode === AREA_MODE.POLYGON) { e.preventDefault(); api.finish(); }
    else if (e.key === 'Backspace' && mode === AREA_MODE.POLYGON && points.length && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '')) { e.preventDefault(); points.pop(); redrawDots(); progress(); viewer.scene.requestRender(); }
  }

  handler.setInputAction(({ position }) => {
    if (mode !== AREA_MODE.RECTANGLE) return;
    if (!groundAt(position)) return; // sky or off the globe: not a corner; still armed
    start = { x: position.x, y: position.y }; rect = null; dragging = true;
    viewer.scene.requestRender();
  }, ScreenSpaceEventType.LEFT_DOWN);
  handler.setInputAction(({ endPosition }) => {
    if (!mode) return;
    if (mode === AREA_MODE.RECTANGLE) { if (dragging) { rect = screenRect(start, endPosition) ?? rect; viewer.scene.requestRender(); } return; }
    const p = groundAt(endPosition);
    if (p) { hover = p; viewer.scene.requestRender(); }
  }, ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction(({ position }) => {
    if (mode !== AREA_MODE.RECTANGLE || !dragging) return;
    const ring = screenRect(start, position) ?? rect;
    end();
    if (!ring) { onCancel('no-ground'); return; }
    onComplete(ring, AREA_MODE.RECTANGLE);
  }, ScreenSpaceEventType.LEFT_UP);
  handler.setInputAction(({ position }) => {
    if (mode !== AREA_MODE.POLYGON) return;
    const now = performance.now();
    const p = groundAt(position);
    if (!p) return;
    // The two clicks of a double-click add one corner, not two.
    if (now - lastClickAt < 320 && points.length && Math.hypot(points.at(-1)[0] - p[0], points.at(-1)[1] - p[1]) < 1e-5) return;
    lastClickAt = now;
    points.push(p);
    redrawDots(); progress();
    viewer.scene.requestRender();
  }, ScreenSpaceEventType.LEFT_CLICK);
  handler.setInputAction(() => { if (mode === AREA_MODE.POLYGON) api.finish(); }, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

  const api = {
    /** Start drawing; whatever area is shown stays until a new one is completed. */
    start(next) {
      if (mode) end();
      mode = next === AREA_MODE.POLYGON ? AREA_MODE.POLYGON : AREA_MODE.RECTANGLE;
      points = []; hover = null; dragging = false;
      setInputs(false);
      window.addEventListener('keydown', onKey, true);
      progress();
      viewer.scene.requestRender();
    },
    /** Close the polygon being drawn. */
    finish() {
      if (mode !== AREA_MODE.POLYGON) return;
      const ring = [...points];
      end();
      if (ring.length < 3) { onCancel('too-few-points'); return; }
      onComplete(ring, AREA_MODE.POLYGON);
    },
    cancel() { if (!mode) return; end(); onCancel('cancelled'); },
    drawing: () => Boolean(mode),
    mode: () => mode,
    /** Show a selected area (validated ring), or nothing. */
    show(ring) {
      committed = ring?.length >= 3 ? ring.map(p => [p[0], p[1]]) : null;
      label.show = Boolean(committed);
      if (committed) {
        // The label at the area's north-west corner.
        const nw = [...committed].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
        label.position = new ConstantPositionProperty(Cartesian3.fromDegrees(nw[0], nw[1]));
      }
      viewer.scene.requestRender();
    },
    shown: () => committed,
    /** Testing / diagnostics: the screen position of a [lon, lat] (null when off screen). */
    toScreen([lon, lat]) { const p = viewer.scene.cartesianToCanvasCoordinates(Cartesian3.fromDegrees(lon, lat)); return p ? { x: p.x, y: p.y } : null; },
    destroy() { end(); handler.destroy(); viewer.dataSources.remove(source, true); },
  };
  return api;
}
