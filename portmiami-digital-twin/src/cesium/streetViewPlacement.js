/**
 * Street View placement — drop Street View onto the map, the way you drop pegman onto a road.
 *
 * Adapted from the ACS I-595 Safety Twin (`cesium-poc/src/streetViewPlacement.js`). Its reasoning
 * is kept: Cesium exposes no Street View coverage layer, and Google serves coverage tiles from the
 * Maps JavaScript API's own map — which this app does not render. Pre-probing the map for coverage
 * would mean dozens of Street View requests every time the tool is opened, so a drop is verified
 * against Google ONCE, when it is made. A drop is valid anywhere Google has imagery.
 *
 * Two things are done differently here, both forced by this app rather than chosen:
 *
 *   1. NO CORRIDOR RIBBON. ACS draws a clamped highlight along I-595 to show where the corridor
 *      runs. That is wrong here twice over. `clampToGround` drapes on the GLOBE, which this app
 *      hides, so the ribbon would sink to the ellipsoid ~25 m under Miami (the same finding
 *      documented at the head of roadNetworkLayer.js). And PortMiami already HAS a road layer the
 *      viewer can switch on — drawing a second set of road lines would be a competing copy of the
 *      network. Placement therefore draws only the drop marks, and the instruction says the drop
 *      is free rather than pointing at a line to aim for.
 *   2. The drop and snap marks are drawn at a fixed height with `disableDepthTestDistance`, not
 *      clamped, for the same reason.
 *
 * Everything this mode creates exists only while it is active: one data source, one handler, two
 * marks. Cancelling, or entering a panorama, removes all of it. It never touches the shared pick
 * dispatcher, so no existing layer's picking is displaced while placement is on.
 */
import {
  Cartesian3, Cartographic, Color, CustomDataSource, Math as CMath,
  PolylineDashMaterialProperty, ScreenSpaceEventHandler, ScreenSpaceEventType,
} from 'cesium';
import { streetViewPlacementAt } from '../streetView/streetViewHeading.js';

/** First ask Google close in; widen once rather than snapping the viewer far from their drop. */
export const PLACEMENT_RADII_M = Object.freeze([75, 250]);
/** The marks sit above the mesh, like the road layer's lines. */
const MARK_HEIGHT_M = 8;

/** Round to roughly a 10 m grid, so sweeping the same stretch reuses one answer. */
export const placementCacheKey = (lon, lat) => `${lon.toFixed(4)},${lat.toFixed(4)}`;

/**
 * @param {import('cesium').Viewer} viewer
 * @param {object} hooks
 * @param {() => object[]} hooks.segments    the loaded road records, for the heading
 * @param {(lon: number, lat: number, radius: number) => Promise<object>} hooks.findPanorama
 * @param {(place: object) => Promise<{ok: boolean, message?: string}>} hooks.onPlace
 * @param {(state: string, message: string|null) => void} [hooks.onState]
 */
export function createStreetViewPlacement(viewer, { segments, findPanorama, onPlace, onState } = {}) {
  const source = new CustomDataSource('portmiami-street-view-placement');
  let active = false, handler = null, added = false, busy = false;
  const cache = new Map();

  /** Where the pointer is on the ground, with the fallbacks the 3D tiles make necessary. */
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

  /**
   * A short-lived pair of marks: where you dropped, and where Google actually put you.
   *
   * The dashed line between them is the honest part — Google snaps a drop to its nearest
   * panorama, which can be tens of metres away, and showing the jump is better than silently
   * moving the viewer and letting them wonder why the street looks wrong.
   */
  function showSnap(dropped, panorama) {
    source.entities.removeById('street-view-drop');
    source.entities.removeById('street-view-snap');
    source.entities.add({
      id: 'street-view-drop',
      position: Cartesian3.fromDegrees(dropped[0], dropped[1], MARK_HEIGHT_M),
      point: {
        pixelSize: 9, color: Color.WHITE.withAlpha(0.95),
        outlineColor: Color.fromCssColorString('#0b1729'), outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    source.entities.add({
      id: 'street-view-snap',
      polyline: {
        positions: Cartesian3.fromDegreesArrayHeights([
          dropped[0], dropped[1], MARK_HEIGHT_M,
          panorama.longitude, panorama.latitude, MARK_HEIGHT_M,
        ]),
        width: 2,
        material: new PolylineDashMaterialProperty({
          color: Color.fromCssColorString('#2d86ff'), dashLength: 10,
        }),
      },
    });
    viewer.scene.requestRender();
  }

  async function drop(screenPosition) {
    if (busy) return;
    const dropped = pickGround(screenPosition);
    if (!dropped) {
      onState?.('unavailable', 'That point isn’t on the map. Try another location.');
      return;
    }
    busy = true;
    try {
      onState?.('searching', 'Finding Street View…');
      const key = placementCacheKey(dropped[0], dropped[1]);
      let found = cache.get(key);
      if (!found) {
        for (const radius of PLACEMENT_RADII_M) {
          found = await findPanorama(dropped[0], dropped[1], radius);
          if (found?.status === 'found') break;
        }
        cache.set(key, found);
      }
      if (found?.status !== 'found') {
        // Placement stays on, so the next click can simply be somewhere else.
        onState?.('unavailable', found?.message ?? 'Street View isn’t available near this location.');
        return;
      }
      showSnap(dropped, found);
      // The heading is read at the point GOOGLE put us, not where the click landed: a drop snapped
      // 40 m onto a different street should face along THAT street.
      const placement = streetViewPlacementAt(segments?.() ?? [], [found.longitude, found.latitude]);
      onState?.('loading', 'Loading Street View…');
      const result = await onPlace({
        longitude: found.longitude, latitude: found.latitude, panoId: found.panoId,
        headingDeg: placement.headingDeg ?? undefined,
        label: placement.label,
        roadName: placement.roadName,
        roadObjectId: placement.roadObjectId,
      });
      if (result?.ok) stop();
      else onState?.('unavailable', result?.message ?? 'Street View could not be opened.');
    } finally {
      busy = false;
    }
  }

  function start() {
    if (active || viewer.isDestroyed()) return;
    active = true;
    source.entities.removeAll();
    if (!added) { viewer.dataSources.add(source); added = true; }
    source.show = true;
    viewer.canvas.style.cursor = 'crosshair';
    // Its own handler, so the shared pick dispatcher is not touched or displaced.
    handler = new ScreenSpaceEventHandler(viewer.canvas);
    handler.setInputAction(movement => { void drop(movement.position); }, ScreenSpaceEventType.LEFT_CLICK);
    onState?.('placement', 'Click anywhere on the map to drop Street View');
    viewer.scene.requestRender();
  }

  function stop() {
    if (!active) return;
    active = false;
    handler?.destroy();
    handler = null;
    source.entities.removeAll();
    source.show = false;
    if (!viewer.isDestroyed()) {
      viewer.canvas.style.cursor = '';
      viewer.scene.requestRender();
    }
    onState?.('normal', null);
  }

  return {
    get active() { return active; },
    start,
    stop,
    toggle() { if (active) stop(); else start(); },
    destroy() {
      stop();
      if (!viewer.isDestroyed()) viewer.dataSources.remove(source, true);
      added = false;
      cache.clear();
    },
  };
}
