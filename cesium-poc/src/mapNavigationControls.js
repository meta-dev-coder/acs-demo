/**
 * Bottom map navigation: zoom, orbit, tilt and Reset View.
 *
 * Every action orbits the point the camera is already looking at, so the view turns around what is
 * on screen instead of swinging the camera on the spot. Each one borrows Cesium's reference frame
 * for the duration of the move and hands it straight back — the camera is never left attached to a
 * transform, so mouse pan, orbit, tilt and wheel zoom stay free afterwards.
 *
 * Reset View shares the toolbar and retains its full-corridor action.
 */
import { Cartesian2, Cartesian3, HeadingPitchRange, Math as CMath, Matrix4, Transforms } from 'cesium';

/** Heading step per rotate press. */
export const ROTATE_STEP_DEG = 15;
/** Pitch step per tilt press. */
export const TILT_STEP_DEG = 8;
/** Keeps the camera the right way up: never past straight down, never below the horizon. */
export const MIN_PITCH_DEG = -85;
export const MAX_PITCH_DEG = -10;

/** Clamp a proposed pitch into the usable range. */
export const clampPitchDeg = pitchDeg =>
  Math.min(MAX_PITCH_DEG, Math.max(MIN_PITCH_DEG, Number.isFinite(pitchDeg) ? pitchDeg : MAX_PITCH_DEG));

/** Wrap a heading into [0, 360). */
export const normalizeHeadingDeg = headingDeg => ((headingDeg % 360) + 360) % 360;

const BUTTONS = [
  { id: 'zoom-in', label: 'Zoom in', text: '+', group: 'zoom' },
  { id: 'zoom-out', label: 'Zoom out', text: '−', group: 'zoom' },
  { id: 'rotate-left', label: 'Rotate left', text: '↺', group: 'rotate' },
  { id: 'rotate-right', label: 'Rotate right', text: '↻', group: 'rotate' },
  { id: 'tilt-up', label: 'Tilt up', text: '↑', group: 'tilt' },
  { id: 'tilt-down', label: 'Tilt down', text: '↓', group: 'tilt' },
];

/**
 * How far ahead the orbit centre may sit, relative to the camera's height. At a shallow tilt the
 * point under the screen centre can be kilometres away, and orbiting around that would fling the
 * camera across the county; this keeps a rotation feeling like turning on the spot you are viewing.
 */
const PIVOT_RANGE_FACTOR = 4;
const MIN_PIVOT_RANGE_M = 400;

/**
 * The ground point the camera is looking at — the pivot every orbit turns around. Falls back
 * outward: the depth buffer (which includes photorealistic tiles), then the ellipsoid, then a point
 * straight ahead; whichever it finds is pulled in to a sensible range.
 */
export function cameraPivot(viewer) {
  const scene = viewer.scene, camera = viewer.camera;
  const centre = new Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
  const picked = (scene.pickPositionSupported ? scene.pickPosition(centre) : undefined)
    ?? camera.pickEllipsoid(centre, scene.globe?.ellipsoid);
  const cap = Math.max(MIN_PIVOT_RANGE_M, camera.positionCartographic.height * PIVOT_RANGE_FACTOR);
  const range = picked && Number.isFinite(picked.x) ? Cartesian3.distance(camera.positionWC, picked) : Infinity;
  if (Number.isFinite(range) && range <= cap) return picked;
  // Nothing in view, or too far ahead to orbit around: take a point along the view direction.
  return Cartesian3.add(camera.positionWC,
    Cartesian3.multiplyByScalar(camera.directionWC, Math.min(range, cap), new Cartesian3()), new Cartesian3());
}

/**
 * @param {HTMLElement} container
 * @param {import('cesium').Viewer} viewer
 * @param {{zoom?: (factor: number) => void}} [hooks]  reuses the map's own proportional zoom
 */
export function installMapNavigationControls(container, viewer, { zoom } = {}) {
  const group = document.createElement('div');
  group.className = 'map-nav';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Map navigation');
  group.innerHTML = BUTTONS.map(button =>
    `<button id="${button.id}" class="map-nav-${button.group}" type="button" aria-label="${button.label}" title="${button.label}">${button.text}</button>`).join('');
  const reset = document.querySelector('#reset-view');
  if (reset) group.append(reset);
  container.append(group);

  const camera = viewer.camera;
  /**
   * Turn the view around the point it is already looking at: borrow the pivot's reference frame,
   * read the current bearing and tilt inside it, apply `next`, then hand the frame straight back.
   * @param {(view: {headingDeg: number, pitchDeg: number}) => {headingDeg: number, pitchDeg: number}} next
   */
  function orbitAroundPivot(next) {
    camera.cancelFlight();
    const pivot = cameraPivot(viewer);
    const range = Cartesian3.distance(camera.positionWC, pivot);
    const transform = Transforms.eastNorthUpToFixedFrame(pivot);
    try {
      // Inside the frame, heading and pitch are read relative to the pivot rather than the globe.
      camera.lookAtTransform(transform);
      const view = next({ headingDeg: CMath.toDegrees(camera.heading), pitchDeg: CMath.toDegrees(camera.pitch) });
      camera.lookAtTransform(transform, new HeadingPitchRange(
        CMath.toRadians(normalizeHeadingDeg(view.headingDeg)), CMath.toRadians(clampPitchDeg(view.pitchDeg)), range));
    } finally {
      // Always hand the frame back: a camera left on a transform cannot be panned or orbited.
      camera.lookAtTransform(Matrix4.IDENTITY);
    }
    viewer.scene.requestRender();
  }

  const orbit = (headingDeltaDeg, pitchDeltaDeg) => orbitAroundPivot(({ headingDeg, pitchDeg }) =>
    ({ headingDeg: headingDeg + headingDeltaDeg, pitchDeg: pitchDeg + pitchDeltaDeg }));

  const actions = {
    'zoom-in': () => zoom?.(0.75),
    'zoom-out': () => zoom?.(1 / 0.75),
    'rotate-left': () => orbit(-ROTATE_STEP_DEG, 0),
    'rotate-right': () => orbit(ROTATE_STEP_DEG, 0),
    // Tilting "up" raises the camera's eye towards straight down.
    'tilt-up': () => orbit(0, -TILT_STEP_DEG),
    'tilt-down': () => orbit(0, TILT_STEP_DEG),

  };
  for (const [id, action] of Object.entries(actions)) group.querySelector(`#${id}`).onclick = action;

  return {
    element: group,
    /** Exposed so the zoom buttons can be enabled once the viewer is ready. */
    setEnabled(enabled) { for (const button of group.querySelectorAll('button')) button.disabled = !enabled; },
    destroy() { group.remove(); },
  };
}
