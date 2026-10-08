/**
 * Putting the thing you asked for in the middle of the screen.
 *
 * `camera.flyTo({destination})` places the EYE at the destination, so flying to a point and looking
 * down at a pitch puts that point behind you. At 1800 m and -40° the look-at ground point is about
 * 2.1 km ahead, which is how "View camera" could fly to exactly the right coordinates and still
 * show an operator a different stretch of road.
 *
 * A fixed latitude nudge does not fix it either: the error grows with height, so an offset tuned at
 * 900 m is four times too small at 3200 m. The offset is derived instead.
 *
 * Pure trigonometry: coordinates in, coordinates out, no Cesium.
 */

/** Metres per degree of latitude. Constant enough at any latitude for framing a camera. */
const METRES_PER_DEGREE_LAT = 110_540;

/** How far ahead of the eye the ground is, looking down at `pitchDegrees` from `height`. */
export function lookAheadMetres(height, pitchDegrees) {
  const pitch = Math.abs(Number(pitchDegrees));
  if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(pitch) || pitch <= 0 || pitch >= 90) return 0;
  return height / Math.tan((pitch * Math.PI) / 180);
}

/**
 * Where to put the eye so that `longitude`/`latitude` lands in the middle of the view.
 *
 * Assumes a north-facing camera (heading 0), which is what every fly in this application uses.
 *
 * @returns {{longitude: number, latitude: number, height: number}}
 */
export function framedDestination(longitude, latitude, height, pitchDegrees) {
  const ahead = lookAheadMetres(height, pitchDegrees);
  return { longitude, latitude: latitude - ahead / METRES_PER_DEGREE_LAT, height };
}
