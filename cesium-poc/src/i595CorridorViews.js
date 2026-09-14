/**
 * Camera views derived from the corridor centerline — no hand-placed coordinates.
 *
 * Two distinct, deliberately separate concepts:
 *   corridorOverview() — "Reset view": the whole I-595 extent, straight down.
 *   heroView()         — startup: a low oblique over the I-75 / Sawgrass interchange, composed so
 *                        the multi-level ramps and the buildings beside them read as 3D.
 *
 * Pure functions over `[{lon, lat}, …]`, so both views stay correct if the centerline changes.
 */
import { shieldPlacements } from './i595ShieldData.js';

/**
 * Hero altitude (m): low enough that ramp decks, overpasses and buildings have visible height
 * against the ground, rather than reading as a plan drawing.
 */
const HERO_HEIGHT_M = 1000;
/**
 * Hero tilt (deg): a genuine oblique. Shallow enough to see the sides of structures and the sky
 * beyond the corridor — the whole point of the photorealistic base.
 */
const HERO_PITCH_DEG = -23;
/**
 * How far the camera is turned off the corridor's own bearing, so I-595 runs diagonally across the
 * frame and into the distance instead of straight up the middle of it.
 */
const HERO_YAW_OFFSET_DEG = -25;
/** Which interchange the hero view is built around. 0 = I-75 / Sawgrass, at the western end. */
const HERO_INTERCHANGE_INDEX = 0;
/**
 * How far east of that interchange the camera actually aims. The FDOT segment and express-lane
 * geometry both begin east of I-75, so aiming a little down-corridor keeps the interchange's ramps
 * in the near field while bringing the marked corridor itself into the frame.
 */
const HERO_FOCUS_ADVANCE_M = 900;
/** Look-ahead (m) used to read the corridor's local bearing at the hero interchange. */
const HERO_BEARING_SPAN_M = 4000;
const METRES_PER_DEGREE = 111320;

const assertCenterline = centerline => {
  if (!Array.isArray(centerline) || centerline.length < 2) throw new Error('Corridor centerline needs at least two points.');
  return centerline;
};

function metresBetween(a, b) {
  const dLon = (b.lon - a.lon) * Math.cos((a.lat + b.lat) / 2 * Math.PI / 180);
  return Math.hypot(dLon, b.lat - a.lat) * METRES_PER_DEGREE;
}

/** Bearing in degrees clockwise from north; a flat-earth approximation, ample over a 20 km corridor. */
function bearingDegrees(from, to) {
  const dLon = (to.lon - from.lon) * Math.cos((from.lat + to.lat) / 2 * Math.PI / 180);
  return (Math.atan2(dLon, to.lat - from.lat) * 180 / Math.PI + 360) % 360;
}

/** Move `metres` from `origin` along a compass bearing. Flat-earth step; exact enough at ~2 km. */
function offsetBy(origin, bearingDeg, metres) {
  const radians = bearingDeg * Math.PI / 180;
  const lat = origin.lat + Math.cos(radians) * metres / METRES_PER_DEGREE;
  return { lon: origin.lon + Math.sin(radians) * metres / (METRES_PER_DEGREE * Math.cos(origin.lat * Math.PI / 180)), lat };
}

/** The corridor's western-most vertex — the beginning of I-595 at the I-75 / Sawgrass interchange. */
export function westernTerminus(centerline) {
  return assertCenterline(centerline).reduce((west, point) => (point.lon < west.lon ? point : west));
}

/**
 * Reset view: the full corridor extent seen from directly above.
 * Unchanged behaviour — the same centroid and altitude the demo has always reset to.
 */
export function corridorOverview(centerline) {
  const lons = assertCenterline(centerline).map(point => point.lon), lats = centerline.map(point => point.lat);
  return {
    lon: (Math.min(...lons) + Math.max(...lons)) / 2,
    lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    height: 24000, headingDeg: 0, pitchDeg: -90, rollDeg: 0,
  };
}

/**
 * Hero view: a low oblique over the I-75 / Sawgrass interchange at the western end of I-595.
 *
 * That interchange is chosen deliberately — its stacked ramps give far more perceptible elevation
 * than a straight run of freeway, which is what makes the photorealistic base worth showing.
 *
 * Everything but the tilt is derived from the geometry: the focus is the interchange's own
 * centerline vertex, and the heading comes from the corridor's local bearing there, turned off-axis
 * so I-595 crosses the frame diagonally and recedes rather than pointing straight up it. The camera
 * then stands back along that heading by the tilt's ground reach, so the interchange sits in the
 * middle distance with sky and skyline beyond it.
 *
 * Deliberately not north-up, and deliberately not the Reset view.
 */
export function heroView(centerline, { height = HERO_HEIGHT_M, pitchDeg = HERO_PITCH_DEG } = {}) {
  const shields = shieldPlacements(assertCenterline(centerline));
  const { lon, lat } = shields[HERO_INTERCHANGE_INDEX] ?? shields[0];
  const interchange = { lon, lat };
  const ahead = centerline.find(point => point.lon > interchange.lon && metresBetween(interchange, point) >= HERO_BEARING_SPAN_M)
    ?? centerline.reduce((far, point) => (metresBetween(interchange, point) > metresBetween(interchange, far) ? point : far));
  const corridorBearingDeg = bearingDegrees(interchange, ahead);
  const focus = offsetBy(interchange, corridorBearingDeg, HERO_FOCUS_ADVANCE_M);
  const headingDeg = (corridorBearingDeg + HERO_YAW_OFFSET_DEG + 360) % 360;
  const eye = offsetBy(focus, (headingDeg + 180) % 360, height / Math.tan(-pitchDeg * Math.PI / 180));
  return { lon: eye.lon, lat: eye.lat, height, headingDeg, pitchDeg, rollDeg: 0, focus, interchange };
}
