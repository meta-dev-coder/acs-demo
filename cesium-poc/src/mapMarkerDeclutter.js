/**
 * Screen-space decluttering for map furniture — route shields and context labels.
 *
 * Along a 22 km corridor viewed from road level, markers kilometres apart project into the same
 * few pixels near the horizon. They are drawn without a depth test so photogrammetry cannot bury
 * them, which means nothing occludes a distant marker either: five interchanges spanning 4.5 km to
 * 15.6 km collapsed into a 57 px band, two of them 3 px apart.
 *
 * Distance culling cannot fix this. The markers are useful in the corridor overview, where the
 * camera is 20 km up and *every* marker is far away — a range that clears the horizon pile-up also
 * empties the overview. So the test is screen proximity, not distance: nearest marker wins its
 * patch of screen, and anything that would land on top of it stands down until the camera moves.
 */
import { Cartesian3 } from 'cesium';

/** Roughly one icon width. Closer than this and two markers read as one smudge. */
export const MIN_GAP_PX = 48;

/** A marker with no stated footprint occupies a square icon's worth of screen. */
const DEFAULT_HALF = MIN_GAP_PX / 2;

/**
 * Cesium's own `NearFarScalar` ramp, so a footprint can account for the shrinking a marker is
 * already subject to rather than reserving its full-size box at 15 km.
 *
 * @param {{near: number, nearValue: number, far: number, farValue: number} | undefined} scalar
 * @param {number} distance
 */
export function nearFarScalarValue(scalar, distance) {
  if (!scalar) return 1;
  const { near, nearValue, far, farValue } = scalar;
  if (distance <= near) return nearValue;
  if (distance >= far) return farValue;
  const span = far - near;
  return span === 0 ? farValue : nearValue + ((distance - near) / span) * (farValue - nearValue);
}

/**
 * Do two markers want the same pixels? The test is a box rather than a radius because a text label
 * is wide and short: "Florida's Turnpike" clears a shield 50 px above it and collides with one
 * 50 px beside it, and a circular gap gets both of those wrong.
 */
function overlaps(a, b) {
  return Math.abs(a.x - b.x) < a.halfWidth + b.halfWidth
    && Math.abs(a.y - b.y) < a.halfHeight + b.halfHeight;
}

/**
 * Which markers lose their patch of screen. Pure, so the rule is testable without a scene.
 *
 * @param {{id: string, x: number, y: number, distance: number, halfWidth?: number, halfHeight?: number}[]} markers
 *   on-screen markers only; a missing footprint defaults to one icon.
 * @returns {Set<string>} ids to hide
 */
export function declutterHidden(markers) {
  const hidden = new Set();
  const kept = [];
  // Nearest first: the marker the viewer is closest to is the one they are most likely looking for,
  // and it is the one photogrammetry scale makes legible. Ties break on id so a frame is stable.
  const ordered = [...markers]
    .map(marker => ({ halfWidth: DEFAULT_HALF, halfHeight: DEFAULT_HALF, ...marker }))
    .sort((a, b) => a.distance - b.distance || String(a.id).localeCompare(String(b.id)));
  for (const marker of ordered) {
    if (kept.some(near => overlaps(near, marker))) hidden.add(marker.id);
    else kept.push(marker);
  }
  return hidden;
}

/**
 * Hide entities that would overlap a nearer one, re-evaluated as the camera moves.
 *
 * Owns `entity.show` and nothing else, so it composes with the `source.show` and colour changes the
 * startup choreography makes.
 *
 * @param {import('cesium').Viewer} viewer
 * @param {Iterable<import('cesium').Entity>} entities
 * @param {{graphic?: 'billboard' | 'label', footprint?: (entity: object) => {halfWidth: number, halfHeight: number}}} [options]
 *   `graphic` names the property carrying the entity's own `distanceDisplayCondition`, so a marker
 *   Cesium is already hiding by range does not claim screen space from one that is drawn.
 *   `footprint(entity, distance)` reports how much screen the entity actually covers at that
 *   range; the default is one icon.
 * @returns {{ hiddenIds: () => Set<string>, refresh: () => void, destroy: () => void }}
 */
export function installMarkerDeclutter(viewer, entities, { graphic = 'billboard', footprint } = {}) {
  const scene = viewer.scene;
  const markers = [...entities];
  const toMarker = new Cartesian3();
  let hidden = new Set();

  function measure(entity) {
    const position = entity.position?.getValue(viewer.clock.currentTime);
    if (!position) return null;
    Cartesian3.subtract(position, scene.camera.positionWC, toMarker);
    // Behind the camera still projects to a screen point, and it is a meaningless one.
    if (Cartesian3.dot(toMarker, scene.camera.directionWC) <= 0) return null;
    const distance = Cartesian3.magnitude(toMarker);
    const condition = entity[graphic]?.distanceDisplayCondition?.getValue(viewer.clock.currentTime);
    if (condition && (distance < condition.near || distance > condition.far)) return null;
    const point = scene.cartesianToCanvasCoordinates(position);
    if (!point) return null;
    // Off-canvas markers cannot collide with anything, and must not be hidden for the moment they
    // re-enter the frame.
    if (point.x < 0 || point.y < 0 || point.x > scene.canvas.clientWidth || point.y > scene.canvas.clientHeight) return null;
    return { id: entity.id, x: point.x, y: point.y, distance, ...footprint?.(entity, distance) };
  }

  function refresh() {
    const measured = [];
    for (const entity of markers) {
      const marker = measure(entity);
      if (marker) measured.push(marker);
    }
    hidden = declutterHidden(measured);
    let changed = false;
    for (const entity of markers) {
      const show = !hidden.has(entity.id);
      if (entity.show !== show) { entity.show = show; changed = true; }
    }
    if (changed) scene.requestRender();
  }

  const remove = scene.preRender.addEventListener(refresh);
  refresh();

  return {
    hiddenIds: () => new Set(hidden),
    refresh,
    destroy() {
      remove();
      // Leave the markers as they were found, not mid-declutter.
      for (const entity of markers) entity.show = true;
      hidden = new Set();
    },
  };
}
