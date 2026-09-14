/**
 * Street View placement — choose a spot on the corridor, the way you drop Street View onto a road.
 *
 * Cesium 1.143 exposes no Street View coverage layer (the only Street View export is the panorama
 * provider), and Google serves coverage tiles from the Maps JavaScript API, which this application
 * deliberately does not load. Pre-probing the corridor for coverage would mean dozens of Street View
 * requests every time the tool is opened, so placement marks where the corridor runs and verifies
 * the drop against Google once, when you make it. The highlight is orientation only: it says "here
 * is I-595", not "coverage is here" and not "you may only drop here" — a drop is valid anywhere
 * Google has imagery.
 *
 * Everything this mode creates exists only while it is active: one data source, one handler, one
 * marker. Cancelling or entering a panorama removes all of it.
 */
import { CallbackProperty, Cartesian2, Cartesian3, Cartographic, Color, CustomDataSource, Math as CMath, ScreenSpaceEventHandler, ScreenSpaceEventType } from 'cesium';

/** First ask Google close in; widen once rather than snapping the user far from their drop. */
export const PLACEMENT_RADII_M = Object.freeze([75, 250]);
/** How far from the corridor a drop may be and still take its bearing from the corridor. */
export const CORRIDOR_BEARING_RANGE_M = 250;
/**
 * Vertices either side of the drop used to read the road's direction. The centerline is surveyed
 * about every 75 m, and a single vertex-to-vertex tangent carries enough jitter to face Street View
 * noticeably off the carriageway; averaging over a few hundred metres tracks the road itself.
 */
export const BEARING_SPAN_VERTICES = 4;
const METRES_PER_DEGREE = 111320;

const metresBetween = (a, b) => Math.hypot(
  (b.lon - a.lon) * Math.cos((a.lat + b.lat) / 2 * Math.PI / 180), b.lat - a.lat) * METRES_PER_DEGREE;

/** Bearing in degrees clockwise from north. */
export function bearingDegrees(from, to) {
  const dLon = (to.lon - from.lon) * Math.cos((from.lat + to.lat) / 2 * Math.PI / 180);
  return (Math.atan2(dLon, to.lat - from.lat) * 180 / Math.PI + 360) % 360;
}

/**
 * The corridor vertex nearest a dropped point.
 * @returns {{index: number, point: {lon: number, lat: number}, distanceM: number}|null}
 */
export function nearestCorridorPoint(centerline, lon, lat) {
  if (!Array.isArray(centerline) || !centerline.length) return null;
  const target = { lon, lat };
  let best = null;
  for (const [index, point] of centerline.entries()) {
    const distanceM = metresBetween(target, point);
    if (!best || distanceM < best.distanceM) best = { index, point, distanceM };
  }
  return best;
}

/**
 * Which way traffic runs where the user dropped. The corridor is stored west to east, so the local
 * tangent is the eastbound bearing and westbound is its reverse.
 * @param {'EB'|'WB'} [direction]  from the carriageway under the pointer, when one is there
 * @returns {number|null} degrees, or null when the drop is too far from the corridor to say
 */
export function corridorHeadingAt(centerline, lon, lat, direction = 'EB') {
  const nearest = nearestCorridorPoint(centerline, lon, lat);
  if (!nearest || nearest.distanceM > CORRIDOR_BEARING_RANGE_M) return null;
  const ahead = centerline[Math.min(nearest.index + BEARING_SPAN_VERTICES, centerline.length - 1)];
  const behind = centerline[Math.max(nearest.index - BEARING_SPAN_VERTICES, 0)];
  if (ahead === behind) return null;
  const eastbound = bearingDegrees(behind, ahead);
  return direction === 'WB' ? (eastbound + 180) % 360 : eastbound;
}

/** Round to roughly a 50 m grid, so sweeping the same stretch reuses one answer. */
export const placementCacheKey = (lon, lat) => `${lon.toFixed(4)},${lat.toFixed(4)}`;

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{lon: number, lat: number}[]} centerline
 * @param {object} hooks
 * @param {(place: object) => Promise<{ok: boolean, message?: string}>} hooks.onPlace
 * @param {() => 'EB'|'WB'|undefined} [hooks.directionAt]
 * @param {(state: string, message: string|null) => void} [hooks.onState]
 */
export function createStreetViewPlacement(viewer, centerline, { onPlace, directionAt, onState, findPanorama } = {}) {
  const source = new CustomDataSource('Street View placement');
  let active = false, handler = null, added = null, busy = false;
  let pointer = null;
  const cache = new Map();

  const corridorPositions = centerline.map(point => Cartesian3.fromDegrees(point.lon, point.lat));

  function buildOverlay() {
    source.entities.removeAll();
    // A temporary ribbon over the corridor: its own entity, in its own source, touching nothing
    // the traffic layer owns.
    source.entities.add({
      id: 'street-view-corridor',
      polyline: {
        positions: corridorPositions, clampToGround: true, width: 7,
        material: Color.fromCssColorString('#67f4e2').withAlpha(0.55),
      },
    });
  }

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
    return { lon: CMath.toDegrees(carto.longitude), lat: CMath.toDegrees(carto.latitude) };
  }

  /** A short-lived pair of marks: where you dropped, and where Google actually put you. */
  function showSnap(dropped, panorama) {
    source.entities.removeById('street-view-drop');
    source.entities.removeById('street-view-snap');
    source.entities.add({
      id: 'street-view-drop',
      position: Cartesian3.fromDegrees(dropped.lon, dropped.lat),
      point: { pixelSize: 8, color: Color.WHITE.withAlpha(0.9), outlineColor: Color.fromCssColorString('#0b1729'), outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    });
    source.entities.add({
      id: 'street-view-snap',
      polyline: {
        positions: [Cartesian3.fromDegrees(dropped.lon, dropped.lat), Cartesian3.fromDegrees(panorama.longitude, panorama.latitude)],
        clampToGround: true, width: 2, material: Color.fromCssColorString('#67f4e2').withAlpha(0.8),
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
      const key = placementCacheKey(dropped.lon, dropped.lat);
      let found = cache.get(key);
      if (!found) {
        for (const radius of PLACEMENT_RADII_M) {
          found = await findPanorama(dropped.lon, dropped.lat, radius);
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
      const headingDeg = corridorHeadingAt(centerline, found.longitude, found.latitude, directionAt?.(screenPosition));
      onState?.('loading', 'Loading Street View…');
      const result = await onPlace({
        longitude: found.longitude, latitude: found.latitude, panoId: found.panoId,
        headingDeg: headingDeg ?? undefined,
        label: headingDeg == null ? 'I-595 corridor' : `I-595 ${directionAt?.(screenPosition) === 'WB' ? 'westbound' : 'eastbound'}`,
      });
      if (result?.ok) stop();
      else onState?.('unavailable', result?.message ?? 'Street View could not be opened.');
    } finally {
      busy = false;
    }
  }

  function start() {
    if (active) return;
    active = true;
    buildOverlay();
    added ??= viewer.dataSources.add(source);
    source.show = true;
    viewer.canvas.style.cursor = 'crosshair';
    // Its own handler, so no existing layer's picking is touched or displaced.
    handler = new ScreenSpaceEventHandler(viewer.canvas);
    handler.setInputAction(movement => { void drop(movement.position); }, ScreenSpaceEventType.LEFT_CLICK);
    handler.setInputAction(movement => { pointer = movement.endPosition; }, ScreenSpaceEventType.MOUSE_MOVE);
    // The highlight shows where the corridor runs; it is a hint, not a boundary. A drop is valid
    // anywhere Google has imagery — a frontage road, a ramp, a side street — so the instruction
    // must not send people hunting for a highlighted line to aim at.
    onState?.('placement', 'Click anywhere to drop Street View');
    viewer.scene.requestRender();
  }

  function stop() {
    if (!active) return;
    active = false;
    handler?.destroy();
    handler = null;
    pointer = null;
    source.entities.removeAll();
    source.show = false;
    viewer.canvas.style.cursor = '';
    onState?.('normal', null);
    viewer.scene.requestRender();
  }

  return {
    get active() { return active; },
    start, stop,
    toggle() { if (active) stop(); else start(); },
    destroy() {
      stop();
      viewer.dataSources.remove(source, true);
      added = null;
      cache.clear();
    },
  };
}
