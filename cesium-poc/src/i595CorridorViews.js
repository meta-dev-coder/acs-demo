/**
 * Camera views derived from the corridor centerline — no hand-placed coordinates.
 *
 * Two distinct, deliberately separate concepts:
 *   corridorOverview() — "Reset view": the whole I-595 extent, straight down.
 *   westernGateway()   — startup: the western corridor, north-up and centred on the route shield
 *                        at SW 136th Avenue, close enough to read individual carriageways.
 *
 * Pure functions over `[{lon, lat}, …]`, so both views stay correct if the centerline changes.
 */
import { shieldPlacements } from './i595ShieldData.js';

/** Startup altitude (m): close enough to read individual carriageways and the crossing arterial. */
const GATEWAY_HEIGHT_M = 1500;
/** Startup tilt (deg): near-nadir, so the corridor reads as a road map rather than a fly-by. */
const GATEWAY_PITCH_DEG = -80;
/** Which route shield the startup view frames. 1 = the second shield, at SW 136th Avenue. */
const GATEWAY_SHIELD_INDEX = 1;
const METRES_PER_DEGREE = 111320;

const assertCenterline = centerline => {
  if (!Array.isArray(centerline) || centerline.length < 2) throw new Error('Corridor centerline needs at least two points.');
  return centerline;
};

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
 * Startup view: the western corridor centred on its second route shield, at SW 136th Avenue.
 *
 * North-up, like a conventional roadway map — the heading is fixed at 0 rather than turned down the
 * corridor, so I-595 reads west-to-east across the screen. The focus is the shield's own placement,
 * so the marker sits in the middle of the opening view by construction; the camera then stands south
 * of it by exactly the tilt's ground reach, rather than directly overhead.
 */
export function westernGateway(centerline, { height = GATEWAY_HEIGHT_M, pitchDeg = GATEWAY_PITCH_DEG } = {}) {
  const shields = shieldPlacements(assertCenterline(centerline));
  const { lon, lat } = shields[GATEWAY_SHIELD_INDEX] ?? shields.at(-1);
  const focus = { lon, lat };
  // Heading 0 means the camera looks due north, so it sets up due south of what it should frame.
  const eye = offsetBy(focus, 180, height / Math.tan(-pitchDeg * Math.PI / 180));
  return { lon: eye.lon, lat: eye.lat, height, headingDeg: 0, pitchDeg, rollDeg: 0, focus };
}
