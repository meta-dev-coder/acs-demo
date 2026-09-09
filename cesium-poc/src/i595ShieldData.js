/**
 * Where the I-595 route shields go.
 *
 * Orientation aids, not labels: seven strategic interchanges across ~22 km, never one per FDOT
 * segment. Each anchor names an interchange and is snapped onto the existing corridor centerline,
 * so a shield always sits on the real road geometry rather than at a typed-in coordinate.
 */

/** Interstate/state route the shields advertise. */
export const SHIELD_ROUTE = 'I-595';
/** Marks these entities as display-only so picking can skip them. */
export const ROAD_SHIELD_ASSET_TYPE = 'ROAD_SHIELD';

/**
 * Strategic interchanges, west to east. `lon` selects the centerline vertex to snap to; the
 * position that reaches the map is the vertex's, never this value.
 */
export const SHIELD_ANCHORS = Object.freeze([
  // The interchange core, not the corridor's bare western stub end: this is the centroid of the
  // WESTERN_I75_SAWGRASS ramps in i595_ramps_connectors_classified.geojson.
  Object.freeze({ id: 'i595-shield-i75-sawgrass', interchange: 'I-75 / Sawgrass Expressway', lon: -80.3483 }),
  Object.freeze({ id: 'i595-shield-sw-136th-ave', interchange: 'SW 136th Avenue', lon: -80.3346 }),
  Object.freeze({ id: 'i595-shield-pine-island-rd', interchange: 'Pine Island Road', lon: -80.2764 }),
  Object.freeze({ id: 'i595-shield-university-dr', interchange: 'University Drive', lon: -80.2497 }),
  Object.freeze({ id: 'i595-shield-floridas-turnpike', interchange: "Florida's Turnpike", lon: -80.2135 }),
  Object.freeze({ id: 'i595-shield-sr7-us441', interchange: 'SR 7 / US 441', lon: -80.2028 }),
  Object.freeze({ id: 'i595-shield-i95', interchange: 'I-95', lon: -80.1685 }),
]);

/**
 * Snap every anchor to its nearest centerline vertex.
 * @param {{lon: number, lat: number}[]} centerline
 * @returns {{id: string, interchange: string, route: string, lon: number, lat: number}[]}
 */
export function shieldPlacements(centerline) {
  if (!Array.isArray(centerline) || centerline.length === 0) throw new Error('Corridor centerline is required to place road shields.');
  return SHIELD_ANCHORS.map(anchor => {
    const vertex = centerline.reduce((best, point) => (Math.abs(point.lon - anchor.lon) < Math.abs(best.lon - anchor.lon) ? point : best));
    return Object.freeze({ id: anchor.id, interchange: anchor.interchange, route: SHIELD_ROUTE, lon: vertex.lon, lat: vertex.lat });
  });
}
