/**
 * Trace a footprint on the map.
 *
 * Used when the county extract has no usable polygon for an asset — around Garage A it has
 * fragments, several of which lie over open water and across a moored ship, so no combination of
 * them is the garage.
 *
 * The ground-picking fallback chain is the one the Street View placement tool already works out
 * over Google's tiles: `scene.pickPosition` against the rendered mesh, the ellipsoid second, and
 * nothing rather than a guess. Its own ScreenSpaceEventHandler, so the shared pick dispatcher that
 * owns road, building and traffic clicks is untouched while tracing.
 *
 * What comes out is a user-defined shape. It is stored as MANUALLY_DIGITIZED, drawn in the
 * provisional amber while it is being traced, and never described as a surveyed footprint.
 */
import {
  CallbackProperty, Cartesian3, Cartographic, Color, CustomDataSource, Math as CMath,
  PolygonHierarchy, ScreenSpaceEventHandler, ScreenSpaceEventType,
} from 'cesium';

const DRAW_COLOR = '#e0952f';
/** Drawn a little above the apron so the trace is not swallowed by the mesh. */
const DRAW_HEIGHT_M = 4;

export function createFootprintDraw(viewer, { onChange, onState } = {}) {
  const source = new CustomDataSource('portmiami-footprint-draw');
  viewer.dataSources.add(source);
  let handler = null, active = false;
  let points = [];

  const colour = alpha => Color.fromCssColorString(DRAW_COLOR).withAlpha(alpha);

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

  /** The live trace: a closed outline once there are three points, plus a dot per vertex. */
  function repaint() {
    source.entities.removeAll();
    if (points.length === 0) { viewer.scene.requestRender(); return; }
    points.forEach(([lon, lat], i) => {
      source.entities.add({
        id: `draw-vertex-${i}`,
        position: Cartesian3.fromDegrees(lon, lat, DRAW_HEIGHT_M),
        point: {
          pixelSize: 10, color: colour(1), outlineColor: Color.WHITE, outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    });
    if (points.length >= 2) {
      const ring = points.length >= 3 ? [...points, points[0]] : points;
      source.entities.add({
        id: 'draw-line',
        polyline: {
          positions: Cartesian3.fromDegreesArrayHeights(ring.flatMap(([lon, lat]) => [lon, lat, DRAW_HEIGHT_M])),
          width: 3,
          material: colour(1),
          depthFailMaterial: colour(0.45),
        },
      });
    }
    if (points.length >= 3) {
      source.entities.add({
        id: 'draw-fill',
        polygon: {
          hierarchy: new PolygonHierarchy(Cartesian3.fromDegreesArrayHeights(
            [...points, points[0]].flatMap(([lon, lat]) => [lon, lat, DRAW_HEIGHT_M]))),
          height: DRAW_HEIGHT_M,
          material: colour(0.22),
          outline: false,
        },
      });
    }
    viewer.scene.requestRender();
  }

  const announce = () => {
    onChange?.([...points]);
    onState?.(points.length < 3
      ? `Tracing: ${points.length} point${points.length === 1 ? '' : 's'}. Click at least three corners.`
      : `Tracing: ${points.length} points. Click more, undo the last, or finish.`);
  };

  function start() {
    if (active || viewer.isDestroyed()) return;
    active = true;
    points = [];
    repaint();
    viewer.canvas.style.cursor = 'crosshair';
    handler = new ScreenSpaceEventHandler(viewer.canvas);
    handler.setInputAction(movement => {
      const point = pickGround(movement.position);
      if (!point) { onState?.('Nothing to trace there — try a spot on the ground.'); return; }
      points.push(point);
      repaint();
      announce();
    }, ScreenSpaceEventType.LEFT_CLICK);
    announce();
  }

  function undo() {
    if (!active || points.length === 0) return;
    points.pop();
    repaint();
    announce();
  }

  /** Finish, returning the traced points. The caller stores them; this tool keeps nothing. */
  function finish() {
    const traced = [...points];
    stop();
    return traced.length >= 3 ? traced : null;
  }

  function stop() {
    if (!active) return;
    active = false;
    handler?.destroy();
    handler = null;
    points = [];
    source.entities.removeAll();
    if (!viewer.isDestroyed()) {
      viewer.canvas.style.cursor = '';
      viewer.scene.requestRender();
    }
    onChange?.([]);
    onState?.(null);
  }

  return {
    get active() { return active; },
    get pointCount() { return points.length; },
    start, stop, undo, finish,
    destroy() {
      stop();
      if (!viewer.isDestroyed()) viewer.dataSources.remove(source, true);
    },
  };
}
