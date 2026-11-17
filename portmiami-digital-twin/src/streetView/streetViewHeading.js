/**
 * Which way to face a Street View panorama dropped on the PortMiami road network.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS IS NOT THE ACS VERSION
 *
 * The I-595 twin reads its heading from one continuous surveyed centreline and averages the
 * tangent over `BEARING_SPAN_VERTICES = 4` vertices either side of the drop, because that
 * centreline carries a vertex roughly every 75 m and a single vertex-to-vertex tangent jitters
 * enough to face the camera noticeably off the carriageway.
 *
 * The PortMiami network is a different shape of data, and the ACS rule would be wrong on it.
 * Measured over all 2,362 segments:
 *
 *   - 6,882 vertices in total, a MEDIAN OF 2 PER SEGMENT,
 *   - median segment length 298 ft (~91 m), median vertex spacing 18 m.
 *
 * Most segments are a straight city block defined by its two endpoints. There is no jitter to
 * average away, and averaging over four vertices would reach past the ends of the typical segment
 * into whatever came next in the file — a different block, or a different street.
 *
 * So the heading here is the tangent of the one EDGE the drop is actually beside: find the nearest
 * segment, find the nearest edge within it, use that edge's own direction. For a two-point segment
 * that is the block's own direction, which is exactly what is wanted.
 * ---------------------------------------------------------------------------------------------
 *
 * Pure and Cesium-free, so the arithmetic is testable without a viewer.
 */

/** How far from a centreline a drop may be and still take its bearing from the road. */
export const ROAD_BEARING_RANGE_M = 120;

const METRES_PER_DEGREE = 111_320;

/** Metres between two [lon, lat] points, flat-earth at the local latitude. Ample at this scale. */
export function metresBetween([lon1, lat1], [lon2, lat2]) {
  return Math.hypot((lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180), lat2 - lat1)
    * METRES_PER_DEGREE;
}

/** Bearing in degrees clockwise from north, from one [lon, lat] to another. */
export function bearingDegrees([lon1, lat1], [lon2, lat2]) {
  const dLon = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return ((Math.atan2(dLon, lat2 - lat1) * 180) / Math.PI + 360) % 360;
}

/**
 * Distance in metres from a point to the closed edge [a, b], and where along it the foot falls.
 * @returns {{distanceM: number, t: number}}  t is 0 at a, 1 at b
 */
function distanceToEdge(point, a, b) {
  const scale = Math.cos((point[1] * Math.PI) / 180);
  const px = point[0] * scale, py = point[1];
  const ax = a[0] * scale, ay = a[1], bx = b[0] * scale, by = b[1];
  const dx = bx - ax, dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0
    : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const distanceM = Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * METRES_PER_DEGREE;
  return { distanceM, t };
}

/**
 * The road edge nearest a dropped point, across the whole network.
 *
 * A linear sweep of 6,882 vertices, which runs in well under a millisecond and happens once per
 * user click — so there is no index to build, invalidate or keep in step with the GIS.
 *
 * @param {{objectId: number, name: string, coordinates: number[][]}[]} segments
 * @param {[number, number]} point  [lon, lat]
 * @returns {{segment: object, from: [number, number], to: [number, number], distanceM: number}|null}
 */
export function nearestRoadEdge(segments, point) {
  let best = null;
  for (const segment of segments ?? []) {
    const coordinates = segment.coordinates;
    for (let i = 0; i < coordinates.length - 1; i++) {
      const { distanceM } = distanceToEdge(point, coordinates[i], coordinates[i + 1]);
      if (!best || distanceM < best.distanceM) {
        best = { segment, from: coordinates[i], to: coordinates[i + 1], distanceM };
      }
    }
  }
  return best;
}

/**
 * Which way to face at a drop point, and what to call the place.
 *
 * The bearing is the nearest edge's own direction. Which of its two directions is a genuine
 * coin-toss — the source centrelines carry no direction of travel, and this is a two-way street
 * network, so there is no "the" way to face. The edge's stored direction is used, and the overlay
 * lets the viewer turn. Nothing here claims a direction of travel.
 *
 * @returns {{headingDeg: number|null, roadName: string|null, roadObjectId: number|null,
 *            distanceM: number|null, label: string}}
 */
export function streetViewPlacementAt(segments, [longitude, latitude], fallbackLabel = 'PortMiami study area') {
  const nearest = nearestRoadEdge(segments, [longitude, latitude]);
  if (!nearest || nearest.distanceM > ROAD_BEARING_RANGE_M) {
    // Too far from any centreline to say anything about a road. No heading is better than one
    // pointed down a street the viewer is not standing on.
    return { headingDeg: null, roadName: null, roadObjectId: null, distanceM: null, label: fallbackLabel };
  }
  const { segment, from, to, distanceM } = nearest;
  const name = segment.name || null;
  return {
    headingDeg: bearingDegrees(from, to),
    roadName: name,
    roadObjectId: segment.objectId,
    distanceM: Math.round(distanceM * 10) / 10,
    label: name ?? `Unnamed road · segment ${segment.objectId}`,
  };
}
