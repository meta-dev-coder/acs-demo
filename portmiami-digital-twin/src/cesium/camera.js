/**
 * Camera maths. Degrees in, Cesium in radians out — this module is the only place the conversion
 * happens, so no other file has to remember which unit a number is in.
 *
 * Site-agnostic on purpose: nothing here names PortMiami. `zoomRange` and `cameraPivot` are taken
 * from the ACS project (cesium-poc/src/mapNavigationControls.js), where they were written to fix
 * two real problems that would recur here verbatim.
 */
import { Cartesian2, Cartesian3, Ellipsoid, HeadingPitchRange, Math as CMath, Matrix4, Transforms } from 'cesium';

/**
 * A camera pose, in the shape `camera.setView` and `camera.flyTo` both take.
 *
 * The view's longitude and latitude name the point you want to LOOK AT, not where the eye sits.
 * That distinction matters at an oblique angle: `destination` is the eye, so setting it to the
 * subject's own coordinates and then tilting 45 degrees puts the subject behind and below the
 * camera and fills the screen with whatever lies `height` metres beyond it. Here the eye is stepped
 * back along the reverse of the heading by `height / tan(|pitch|)` — the horizontal leg of the
 * triangle whose vertical leg is the eye's altitude — so the subject lands in the middle of the
 * view at any pitch, and `height` still means the altitude the camera flies at.
 *
 * At pitch -90 (straight down) the step back is zero and the eye is directly above the subject,
 * which is the degenerate case handled for free.
 *
 * @param {{longitude: number, latitude: number, height: number, heading?: number, pitch?: number, roll?: number}} view  degrees and metres
 */
export function cameraPose(view) {
  const headingDeg = view.heading ?? 0;
  const pitchDeg = clampPitchDeg(view.pitch ?? -45);
  const height = view.height;

  // How far back from the subject the eye has to stand to look down at it at this angle.
  const setbackM = height / Math.tan(Math.abs(CMath.toRadians(pitchDeg)));
  // Opposite the heading: looking north (0) means standing to the south.
  const bearingRad = CMath.toRadians(normalizeHeadingDeg(headingDeg + 180));
  const dNorthM = Math.cos(bearingRad) * setbackM;
  const dEastM = Math.sin(bearingRad) * setbackM;

  const latitude = view.latitude + dNorthM / METRES_PER_DEGREE_LAT;
  const metresPerDegreeLon = METRES_PER_DEGREE_LAT * Math.cos(CMath.toRadians(view.latitude));
  const longitude = view.longitude + dEastM / metresPerDegreeLon;

  return {
    destination: Cartesian3.fromDegrees(longitude, latitude, height),
    orientation: {
      heading: CMath.toRadians(headingDeg),
      pitch: CMath.toRadians(pitchDeg),
      roll: CMath.toRadians(view.roll ?? 0),
    },
  };
}

/**
 * Metres per degree of latitude, derived from Cesium's own ellipsoid rather than written as the
 * usual 111320 literal, so it cannot drift from the geometry the rest of the app measures with.
 * The setback above is a framing offset of a few kilometres; a spherical approximation is ample.
 */
const METRES_PER_DEGREE_LAT = (Ellipsoid.WGS84.maximumRadius * Math.PI) / 180;

/**
 * How far ahead the orbit centre may sit, relative to the camera's height. At a shallow tilt the
 * point under the screen centre can be kilometres away, and orbiting around that would fling the
 * camera across the bay; this keeps a rotation feeling like turning on the spot you are viewing.
 */
const PIVOT_RANGE_FACTOR = 4;
const MIN_PIVOT_RANGE_M = 400;

/**
 * Range after one proportional zoom step.
 *
 * Based on eye-to-target distance, not cartographic height: a close oblique camera over a quay can
 * have a near-zero height while it is still tens of metres from the wharf, and treating that height
 * as range makes zoom stop or reverse near the ground.
 */
export const zoomRange = (range, factor, minimum, maximum) =>
  Math.min(maximum, Math.max(minimum, range * factor));

/**
 * The ground point the camera is looking at — the pivot every orbit turns around. Falls back
 * outward: the depth buffer (which includes the photorealistic tiles), then the ellipsoid, then a
 * point straight ahead; whichever it finds is pulled in to a sensible range.
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
 * Pitch limits. Straight down (-90) gums up the orbit maths and looking above the horizon shows
 * nothing but sky, so the camera stays between a steep plan view and a shallow oblique.
 */
export const MIN_PITCH_DEG = -89;
export const MAX_PITCH_DEG = -5;
export const clampPitchDeg = pitchDeg =>
  Math.min(MAX_PITCH_DEG, Math.max(MIN_PITCH_DEG, Number.isFinite(pitchDeg) ? pitchDeg : MAX_PITCH_DEG));

/** Wrap a heading into [0, 360). */
export const normalizeHeadingDeg = headingDeg => ((headingDeg % 360) + 360) % 360;

/**
 * Turn the view around the point it is already looking at: borrow the pivot's reference frame, read
 * the current bearing and tilt inside it, apply `next`, then hand the frame straight back.
 *
 * Rotating the camera directly would swing it around the centre of the Earth, which at an oblique
 * 3.5 km over Dodge Island throws the view out over the Atlantic. This keeps a rotation feeling
 * like turning on the spot you are looking at.
 *
 * @param {import('cesium').Viewer} viewer
 * @param {(view: {headingDeg: number, pitchDeg: number}) => {headingDeg: number, pitchDeg: number}} next
 */
export function orbitAroundPivot(viewer, next) {
  const camera = viewer.camera;
  camera.cancelFlight();
  const pivot = cameraPivot(viewer);
  const range = Cartesian3.distance(camera.positionWC, pivot);
  const transform = Transforms.eastNorthUpToFixedFrame(pivot);
  try {
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

/** One orbit step: a bearing change, a tilt change, or both. */
export const orbit = (viewer, headingDeltaDeg, pitchDeltaDeg) =>
  orbitAroundPivot(viewer, ({ headingDeg, pitchDeg }) =>
    ({ headingDeg: headingDeg + headingDeltaDeg, pitchDeg: pitchDeg + pitchDeltaDeg }));

/**
 * A compass reset, not a view reset: stay exactly where you are and how steeply you are looking,
 * and turn to north.
 */
export function faceNorth(viewer, { durationSeconds = 0.45 } = {}) {
  const camera = viewer.camera;
  camera.cancelFlight();
  // Clone: `positionWC` is Cesium's own vector, and handing it back as a destination aliases the
  // value the camera is in the middle of recomputing.
  const destination = Cartesian3.clone(camera.positionWC, new Cartesian3());
  camera.flyTo({
    destination,
    orientation: { heading: 0, pitch: CMath.toRadians(clampPitchDeg(CMath.toDegrees(camera.pitch))), roll: 0 },
    duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : durationSeconds,
  });
  viewer.scene.requestRender();
}
