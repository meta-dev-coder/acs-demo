/**
 * "Click the map to choose a candidate site."
 *
 * The ground-picking fallback chain is the one `createStreetViewPlacement` already works out over
 * Google's tiles: `scene.pickPosition` against the rendered mesh first, the ellipsoid second, and
 * nothing at all rather than a guess if neither answers. Its own ScreenSpaceEventHandler, so the
 * shared pick dispatcher that owns road, building and traffic clicks is never touched.
 *
 * A picked point is a point someone clicked. It carries no claim about ownership, zoning,
 * utilities or whether anything could be built there, and every label the planner puts on one
 * says "candidate site".
 */
import { Cartographic, Math as CMath, ScreenSpaceEventHandler, ScreenSpaceEventType } from 'cesium';

export function createSitePicker(viewer, { onPick, onState } = {}) {
  let handler = null, active = false;

  function pickGround(screenPosition) {
    const scene = viewer.scene;
    let cartesian = scene.pickPositionSupported ? scene.pickPosition(screenPosition) : undefined;
    if (!cartesian || !Number.isFinite(cartesian.x)) {
      cartesian = viewer.camera.pickEllipsoid(screenPosition, scene.globe?.ellipsoid);
    }
    if (!cartesian || !Number.isFinite(cartesian.x)) return null;
    const carto = Cartographic.fromCartesian(cartesian);
    if (!carto || !Number.isFinite(carto.longitude)) return null;
    return [CMath.toDegrees(carto.longitude), CMath.toDegrees(carto.latitude)];
  }

  function start() {
    if (active || viewer.isDestroyed()) return;
    active = true;
    viewer.canvas.style.cursor = 'crosshair';
    handler = new ScreenSpaceEventHandler(viewer.canvas);
    handler.setInputAction(movement => {
      const point = pickGround(movement.position);
      if (!point) { onState?.('Nothing to pick there — try a spot on the ground.'); return; }
      stop();
      onPick?.(point);
    }, ScreenSpaceEventType.LEFT_CLICK);
    onState?.('Click the map to place the candidate site.');
  }

  function stop() {
    if (!active) return;
    active = false;
    handler?.destroy();
    handler = null;
    if (!viewer.isDestroyed()) viewer.canvas.style.cursor = '';
    onState?.(null);
  }

  return {
    get active() { return active; },
    start, stop,
    toggle() { if (active) stop(); else start(); },
    destroy() { stop(); },
  };
}
