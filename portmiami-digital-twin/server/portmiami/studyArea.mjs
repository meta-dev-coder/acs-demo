/**
 * The geographic filter: statewide FL511 markers in, study-area markers out.
 *
 * This is the one module that replaces the ACS twin's corridor test. ACS asked "is this point
 * within 250 m of I-595 geometry"; here the question is "does this event touch the study-area
 * box". The box is a rectangle, so the test is exact rather than a buffer, and the reason each
 * event was kept is recorded on it (`areaMatch`) instead of being thrown away.
 *
 * FL511 publishes POINTS, never geometry. A closure carries at most two of them — `location` and
 * `secondarylocation`. Three consequences, each handled explicitly rather than papered over:
 *
 *   1. A two-point event is tested as the SEGMENT between its endpoints, not as a centroid and not
 *      as its primary point alone. A closure anchored north of the box with its far end inside it
 *      is ours; a centroid test would miss it and an endpoints-only test would miss a closure that
 *      runs straight through the box with both ends outside. `segmentIntersectsRectangle` catches
 *      all three cases.
 *   2. That segment is a straight line between two published points. It is NOT the closure's real
 *      alignment and is never presented as the length of closed road — see `geometryBasis`, which
 *      the UI prints verbatim.
 *   3. An event with no usable coordinates cannot be placed. It is counted and listed under
 *      `unplaceable`, never given a position, and never drawn.
 */
import { pointInRectangle, segmentIntersectsRectangle } from '../fl511/geo.mjs';

/** How an item's position was established, and therefore how much it can be said to mean. */
export const AREA_MATCH = Object.freeze({
  /** FL511's single published point falls inside the box. */
  POINT_IN_AREA: 'POINT_IN_AREA',
  /** One of the two published points falls inside the box. */
  ENDPOINT_IN_AREA: 'ENDPOINT_IN_AREA',
  /** Neither point is inside, but the straight line between them crosses the box. */
  SPAN_CROSSES_AREA: 'SPAN_CROSSES_AREA',
});

const GEOMETRY_BASIS = Object.freeze({
  [AREA_MATCH.POINT_IN_AREA]: 'FL511 published a single point for this event.',
  [AREA_MATCH.ENDPOINT_IN_AREA]:
    'FL511 published two points. The line between them is a straight line between those two '
    + 'points, not the alignment or length of the affected road.',
  [AREA_MATCH.SPAN_CROSSES_AREA]:
    'FL511 published two points, both outside the study area, with the line between them crossing '
    + 'it. That line is a straight line between the two points, not the affected road.',
});

/**
 * Where an FL511 item sits relative to the study area, or null when it is not in it at all.
 * @param {{latitude: number, longitude: number, secondaryLatitude?: number, secondaryLongitude?: number}} item
 * @param {{west: number, south: number, east: number, north: number}} bbox
 * @returns {{areaMatch: string, geometryBasis: string, hasSpan: boolean} | null}
 */
export function locateInStudyArea(item, bbox) {
  const primary = [item.longitude, item.latitude];
  const hasSpan = Number.isFinite(item.secondaryLatitude) && Number.isFinite(item.secondaryLongitude);
  const secondary = hasSpan ? [item.secondaryLongitude, item.secondaryLatitude] : null;

  const primaryInside = pointInRectangle(primary, bbox);
  const secondaryInside = Boolean(secondary) && pointInRectangle(secondary, bbox);

  let areaMatch = null;
  if (!hasSpan) areaMatch = primaryInside ? AREA_MATCH.POINT_IN_AREA : null;
  else if (primaryInside || secondaryInside) areaMatch = AREA_MATCH.ENDPOINT_IN_AREA;
  else if (segmentIntersectsRectangle(primary, secondary, bbox)) areaMatch = AREA_MATCH.SPAN_CROSSES_AREA;

  return areaMatch ? { areaMatch, geometryBasis: GEOMETRY_BASIS[areaMatch], hasSpan } : null;
}

/**
 * Split a validated feed into what belongs to the study area and what cannot be placed at all.
 *
 * `parseMapIcons` has already dropped items whose coordinates are missing or out of range, so
 * `unplaceable` collects what it reported: ids FL511 published with no usable position. They are
 * reported as a count and a list so the UI can say "3 events could not be located" instead of
 * quietly showing 3 fewer events — but they are never given a position.
 *
 * @param {object[]} items    output of parseMapIcons
 * @param {{bbox: object}} region
 * @param {{itemId?: string, reason: string}[]} [skipped]
 */
export function filterToStudyArea(items, region, skipped = []) {
  const kept = [];
  for (const item of items) {
    const located = locateInStudyArea(item, region.bbox);
    if (located) kept.push({ ...item, ...located });
  }
  return {
    kept,
    unplaceable: skipped
      .filter(entry => /location/i.test(entry.reason))
      .map(entry => ({ itemId: entry.itemId ?? null, reason: entry.reason })),
  };
}
