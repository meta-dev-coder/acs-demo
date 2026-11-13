/**
 * Address geocoding against the county's OWN road centreline file.
 *
 * This is the only way an asset in this registry acquires a position, and it is worth being exact
 * about what it is and is not. The county parking page publishes a street address for each
 * facility ("921 N America Way"); the road file carries L_ADD_FROM/L_ADD_TO and R_ADD_FROM/R_ADD_TO
 * on each segment. Matching the house number into one of those ranges yields the segment that
 * addresses that number, and interpolating along it yields a point ON THE STREET.
 *
 * That point is the front of the property, not the building, and certainly not a survey position.
 * Everything derived from it is marked DERIVED and treated as provisional: it is good enough to
 * fly the camera to the right block and to offer nearby footprints for a human to review, and it
 * is not good enough to confirm anything by itself.
 */
import { displayName } from '../roads/roadModel.js';

const EARTH_RADIUS_M = 6378137;
const RADIANS = Math.PI / 180;
const METRES_PER_DEGREE_LAT = EARTH_RADIUS_M * RADIANS;

/** Great-circle-ish distance in metres. Flat-earth over a port is well inside any useful tolerance. */
export function distanceMetres([lon1, lat1], [lon2, lat2]) {
  const dLat = (lat2 - lat1) * METRES_PER_DEGREE_LAT;
  const dLon = (lon2 - lon1) * METRES_PER_DEGREE_LAT * Math.cos(((lat1 + lat2) / 2) * RADIANS);
  return Math.hypot(dLat, dLon);
}

/** Does `house` fall inside this side's range? Ranges can run either way, and 0/null means none. */
function inRange(house, from, to) {
  if (from == null || to == null) return false;
  if (from === 0 && to === 0) return false;        // the file's "no range assigned" sentinel
  return house >= Math.min(from, to) && house <= Math.max(from, to);
}

/** A point `fraction` of the way along a LineString, by length rather than by vertex count. */
export function interpolateAlong(coordinates, fraction) {
  if (coordinates.length === 0) return null;
  if (coordinates.length === 1) return coordinates[0];
  const spans = [];
  let total = 0;
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    const length = distanceMetres(coordinates[i], coordinates[i + 1]);
    spans.push(length);
    total += length;
  }
  if (total === 0) return coordinates[0];
  let target = Math.min(1, Math.max(0, fraction)) * total;
  for (let i = 0; i < spans.length; i += 1) {
    if (target <= spans[i] || i === spans.length - 1) {
      const t = spans[i] === 0 ? 0 : target / spans[i];
      const [x1, y1] = coordinates[i], [x2, y2] = coordinates[i + 1];
      return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
    }
    target -= spans[i];
  }
  return coordinates[coordinates.length - 1];
}

/**
 * Geocode one address.
 *
 * @param {{house: number, street: string}} address
 * @param {import('../roads/roadModel.js').RoadSegment[]} segments
 * @returns {{matched: boolean, roadObjectId: number|null, roadName: string, side: 'L'|'R'|null,
 *            point: [number, number]|null, range: [number, number]|null, reason: string}}
 */
export function geocodeAddress(address, segments) {
  const street = String(address?.street ?? '').trim().toUpperCase();
  const house = Number(address?.house);
  if (!street || !Number.isFinite(house)) {
    return { matched: false, roadObjectId: null, roadName: '', side: null, point: null, range: null,
      reason: 'The asset has no street address to geocode.' };
  }

  const onStreet = segments.filter(segment => displayName(segment).toUpperCase() === street);
  if (onStreet.length === 0) {
    return { matched: false, roadObjectId: null, roadName: street, side: null, point: null, range: null,
      reason: `No road segment in the GIS file is named "${street}".` };
  }

  for (const segment of onStreet) {
    const p = segment.properties;
    for (const side of ['L', 'R']) {
      const from = p[`${side}_ADD_FROM`], to = p[`${side}_ADD_TO`];
      if (!inRange(house, from, to)) continue;
      const lo = Math.min(from, to), hi = Math.max(from, to);
      // Where in the block the number falls. A single-number range sits at its midpoint.
      const fraction = hi === lo ? 0.5 : (house - lo) / (hi - lo);
      return {
        matched: true,
        roadObjectId: segment.objectId,
        roadName: displayName(segment),
        side,
        point: interpolateAlong(segment.coordinates, fraction),
        range: [lo, hi],
        reason: `House number ${house} falls in the ${side === 'L' ? 'left' : 'right'}-side range ${lo}–${hi} of ${displayName(segment)} (OBJECTID ${segment.objectId}).`,
      };
    }
  }

  const withRanges = onStreet.filter(segment => ['L', 'R'].some(side =>
    inRange(1, segment.properties[`${side}_ADD_FROM`], segment.properties[`${side}_ADD_TO`])
    || (segment.properties[`${side}_ADD_FROM`] ?? 0) !== 0));
  return {
    matched: false, roadObjectId: null, roadName: street, side: null, point: null, range: null,
    reason: withRanges.length === 0
      ? `The ${onStreet.length} segment(s) named "${street}" carry no address ranges in the GIS file.`
      : `No segment of "${street}" has an address range containing ${house}.`,
  };
}
