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
/** How long the compass takes to swing the view back to north. */
export const NORTH_UP_MS = 600;

/** Clamp a proposed pitch into the usable range. */
export const clampPitchDeg = pitchDeg =>
  Math.min(MAX_PITCH_DEG, Math.max(MIN_PITCH_DEG, Number.isFinite(pitchDeg) ? pitchDeg : MAX_PITCH_DEG));

/** Wrap a heading into [0, 360). */
export const normalizeHeadingDeg = headingDeg => ((headingDeg % 360) + 360) % 360;

/** Material's light/dark mode glyphs, on the same 20x20 grid as the Street View figure. */
export const THEME_ICONS = Object.freeze({
  light: '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="3.2"/><path d="M10 3.2v1.6M10 15.2v1.6M3.2 10h1.6M15.2 10h1.6M5.2 5.2l1.1 1.1M13.7 13.7l1.1 1.1M14.8 5.2l-1.1 1.1M6.3 13.7l-1.1 1.1"/></svg>',
  dark: '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M16 11.4A6.4 6.4 0 0 1 8.6 4a6.4 6.4 0 1 0 7.4 7.4Z"/></svg>',
});

const BUTTONS = [
  { id: 'zoom-in', label: 'Zoom in', text: '+', group: 'zoom' },
  { id: 'zoom-out', label: 'Zoom out', text: '−', group: 'zoom' },
  { id: 'rotate-left', label: 'Rotate left', text: '↺', group: 'rotate' },
  { id: 'rotate-right', label: 'Rotate right', text: '↻', group: 'rotate' },
  { id: 'tilt-up', label: 'Tilt up', text: '↑', group: 'tilt' },
  { id: 'tilt-down', label: 'Tilt down', text: '↓', group: 'tilt' },
  // The needle turns with the camera, so the button doubles as a heading readout.
  { id: 'north-up', label: 'Face north', text: '<span class="map-nav-needle" aria-hidden="true">▲</span><span class="map-nav-cardinal">N</span>', group: 'north' },
  // A generic street-level figure: a viewer at eye level, not Google's Pegman.
  { id: 'street-view', label: 'Street View', group: 'street-view',
    text: '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle cx="10" cy="4.4" r="2.4"/><path d="M6.6 17v-4.2a3.4 3.4 0 0 1 3.4-3.4 3.4 3.4 0 0 1 3.4 3.4V17"/><path d="M8.4 17v-3M11.6 17v-3"/></svg>' },
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
export function installMapNavigationControls(container, viewer, { zoom, onStreetView, themeMode, onToggleTheme } = {}) {
  const group = document.createElement('div');
  group.className = 'map-nav';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Map navigation');
  group.innerHTML = BUTTONS.map(button =>
    `<button id="${button.id}" class="map-nav-${button.group}" type="button" aria-label="${button.label}" title="${button.label}">${button.text}</button>`).join('');
  // The theme switch belongs with the other view controls rather than in the layer rail: it
  // changes how the application looks, not which data is on the map. Its own group, so the
  // divider separates it from the camera controls.
  let themeButton = null;
  let unsubscribeTheme = null;
  if (onToggleTheme) {
    themeButton = document.createElement('button');
    themeButton.id = 'theme-toggle';
    themeButton.className = 'map-nav-theme';
    themeButton.type = 'button';
    group.append(themeButton);
  }

  const reset = document.querySelector('#reset-view');
  if (reset) group.append(reset);
  container.append(group);

  function renderTheme() {
    if (!themeButton) return;
    const toLight = !themeMode?.isLight;
    const label = toLight ? 'Switch to light theme' : 'Switch to dark theme';
    // The control advertises where it takes you, so it shows the mode it switches TO.
    themeButton.innerHTML = toLight ? THEME_ICONS.light : THEME_ICONS.dark;
    themeButton.title = label;
    themeButton.setAttribute('aria-label', label);
    themeButton.setAttribute('aria-pressed', String(Boolean(themeMode?.isLight)));
  }
  renderTheme();
  themeButton?.addEventListener('click', () => { onToggleTheme(); renderTheme(); });
  unsubscribeTheme = themeMode?.subscribe?.(renderTheme) ?? null;

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
    'street-view': () => onStreetView?.(),
    // A compass reset, not Reset View: keep exactly where you are and how steeply you are looking,
    // and turn to north smoothly rather than snapping.
    'north-up': () => {
      camera.cancelFlight();
      // Clone: `positionWC` is Cesium's own vector, and handing it back as a destination aliases
      // the value the camera is in the middle of recomputing.
      const destination = Cartesian3.clone(camera.positionWC, new Cartesian3());
      const orientation = { heading: 0, pitch: CMath.toRadians(clampPitchDeg(CMath.toDegrees(camera.pitch))), roll: 0 };
      const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : NORTH_UP_MS / 1000;
      camera.flyTo({ destination, orientation, duration, complete: syncCompass, cancel: syncCompass });
      viewer.scene.requestRender();
    },
  };
  // Turn the compass needle with the camera. Driven by the camera's own change events, never per
  // frame, and written straight to the element's style so no framework state churns.
  const needle = group.querySelector('.map-nav-needle');
  const compass = group.querySelector('#north-up');
  let shownHeading = null;
  function syncCompass() {
    const headingDeg = Math.round(normalizeHeadingDeg(CMath.toDegrees(camera.heading)));
    if (headingDeg === shownHeading) return;
    shownHeading = headingDeg;
    if (needle) needle.style.transform = `rotate(${-headingDeg}deg)`;
    compass?.setAttribute('title', headingDeg === 0 ? 'Facing north' : `Heading ${headingDeg}° — click to face north`);
    compass?.setAttribute('aria-label', headingDeg === 0 ? 'Facing north' : `Heading ${headingDeg} degrees, face north`);
    compass?.toggleAttribute('data-aligned', headingDeg === 0);
  }
  const removeChanged = camera.changed.addEventListener(syncCompass);
  const removeMoveEnd = camera.moveEnd.addEventListener(syncCompass);
  syncCompass();
  for (const [id, action] of Object.entries(actions)) group.querySelector(`#${id}`).onclick = action;

  return {
    element: group,
    /** Current compass bearing in degrees, for tests and for anything that mirrors the heading. */
    get headingDeg() { return shownHeading; },
    /** Reflect placement mode on the toolbar, so the tool reads as on. */
    setStreetViewActive(on) {
      const button = group.querySelector('#street-view');
      button?.setAttribute('aria-pressed', String(!!on));
      button?.setAttribute('title', on ? 'Cancel Street View placement' : 'Street View');
    },
    /** Exposed so the zoom buttons can be enabled once the viewer is ready. */
    setEnabled(enabled) { for (const button of group.querySelectorAll('button')) button.disabled = !enabled; },
    destroy() { removeChanged(); removeMoveEnd(); unsubscribeTheme?.(); group.remove(); },
  };
}
