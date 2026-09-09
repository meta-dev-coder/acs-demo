/**
 * The corridor's strategic interchanges — the anchor points for both the I-595 route shields and
 * the geographic context labels.
 *
 * Orientation aids, not labels for everything: eight interchanges across ~22 km, never one per FDOT
 * segment. Each anchor names a crossing and is snapped onto the existing corridor centerline, so a
 * marker always sits on the real road geometry rather than at a typed-in coordinate.
 *
 * Longitudes are cross-checked against the `interchange` clusters in
 * public/data/i595_ramps_connectors_classified.geojson — the ramp geometry is what actually defines
 * where each interchange is.
 */

/** Interstate/state route the shields advertise. */
export const SHIELD_ROUTE = 'I-595';
/** Marks these entities as display-only so picking can skip them. */
export const ROAD_SHIELD_ASSET_TYPE = 'ROAD_SHIELD';
/** Marks a geographic orientation label — display-only for the same reason. */
export const CONTEXT_LABEL_ASSET_TYPE = 'CONTEXT_LABEL';

/**
 * Strategic interchanges, west to east. `lon` selects the centerline vertex to snap to; the
 * position that reaches the map is the vertex's, never this value. `shield` marks the subset that
 * also carries a route shield — every interchange gets a context label.
 */
export const CORRIDOR_INTERCHANGES = Object.freeze([
  // The interchange core, not the corridor's bare western stub end: the centroid of the
  // WESTERN_I75_SAWGRASS ramp cluster.
  Object.freeze({ id: 'i75-sawgrass', interchange: 'I-75 / Sawgrass', lon: -80.3483, shield: true }),
  Object.freeze({ id: 'sw-136th-ave', interchange: 'SW 136th Ave', lon: -80.3346, shield: true }),
  // Label only: a shield here would crowd the two on either side of it.
  Object.freeze({ id: 'flamingo-rd', interchange: 'Flamingo Rd', lon: -80.3140, shield: false }),
  Object.freeze({ id: 'pine-island-rd', interchange: 'Pine Island Rd', lon: -80.2764, shield: true }),
  Object.freeze({ id: 'university-dr', interchange: 'University Dr', lon: -80.2497, shield: true }),
  Object.freeze({ id: 'floridas-turnpike', interchange: "Florida's Turnpike", lon: -80.2135, shield: true }),
  Object.freeze({ id: 'sr7-us441', interchange: 'SR 7 / US 441', lon: -80.2028, shield: true }),
  Object.freeze({ id: 'i95', interchange: 'I-95', lon: -80.1685, shield: true }),
]);

/** Snap every anchor to its nearest centerline vertex. */
function placements(centerline, prefix, filter) {
  if (!Array.isArray(centerline) || centerline.length === 0) throw new Error('Corridor centerline is required to place corridor markers.');
  return CORRIDOR_INTERCHANGES.filter(filter).map(anchor => {
    const vertex = centerline.reduce((best, point) => (Math.abs(point.lon - anchor.lon) < Math.abs(best.lon - anchor.lon) ? point : best));
    return Object.freeze({ id: `${prefix}-${anchor.id}`, interchange: anchor.interchange, route: SHIELD_ROUTE, lon: vertex.lon, lat: vertex.lat });
  });
}

/**
 * @param {{lon: number, lat: number}[]} centerline
 * @returns {{id: string, interchange: string, route: string, lon: number, lat: number}[]}
 */
export const shieldPlacements = centerline => placements(centerline, 'i595-shield', anchor => anchor.shield);

/** Every interchange gets a geographic orientation label, shields or not. */
export const contextLabelPlacements = centerline => placements(centerline, 'i595-label', () => true);
