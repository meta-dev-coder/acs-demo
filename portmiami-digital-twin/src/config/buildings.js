/**
 * Building footprint configuration — the source, how footprints are drawn, and the hook for a
 * future curated asset register. Cesium-free and geometry-free, like the other config modules.
 */

/**
 * The source file. Swapping in the complete 6,673-feature export is a change to these three
 * values and nothing else: nothing downstream hard-codes a count, and `expectedFeatureCount`
 * only drives a validation warning.
 */
export const BUILDING_SOURCE = Object.freeze({
  url: 'data/portmiami_buildings_partial_6000.geojson',
  label: 'portmiami_buildings_partial_6000.geojson',
  expectedFeatureCount: 6000,
  /** What the full ArcGIS layer holds, for the "partial dataset" notice. */
  completeFeatureCount: 6673,
});

/**
 * How footprints are drawn over Google Photorealistic 3D Tiles.
 *
 * `heightOffsetM` matches the road layer's, so the two layers sit in one plane and a building
 * outline meets the road at its door rather than hovering above or below it.
 */
export const BUILDING_RENDER = Object.freeze({
  heightOffsetM: 6,
  width: Object.freeze({ resting: 1.6, hovered: 3, selected: 4 }),
  colors: Object.freeze({
    resting: '#6b7a8f',
    hovered: '#2d86ff',
    selected: '#e8a317',
    depthFailAlpha: 0.22,
  }),
});

/**
 * The curated PortMiami asset register — cruise terminals, parking garages, warehouses,
 * administrative and maintenance buildings.
 *
 * EMPTY, deliberately. The source file carries no building names or functions: TYPE is a
 * single-letter code with no lookup table, and nothing in it says "Terminal F". Filling this in
 * from footprint size or position would be inventing the one thing this register exists to state
 * reliably.
 *
 * An entry links a curated record to a footprint by OBJECTID, which is this dataset's only stable
 * identifier (UNIQUEID is null for 1,574 features and repeats across the rest). Shape:
 *
 *   { 8123: { assetId: 'TERMINAL-F', name: 'Cruise Terminal F', category: 'CRUISE_TERMINAL',
 *             source: 'PortMiami facilities register, 2024-03' } }
 *
 * `source` is required by convention: a curated claim should say who made it.
 *
 * @type {Readonly<Record<number, {assetId: string, name: string, category: string, source: string}>>}
 */
export const BUILDING_ASSETS = Object.freeze({});

/** The categories a curated record may use. Names only — no building is assigned one yet. */
export const ASSET_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'CRUISE_TERMINAL', label: 'Cruise terminal' }),
  Object.freeze({ id: 'PARKING_GARAGE', label: 'Parking garage' }),
  Object.freeze({ id: 'WAREHOUSE', label: 'Warehouse' }),
  Object.freeze({ id: 'ADMINISTRATIVE', label: 'Administrative' }),
  Object.freeze({ id: 'MAINTENANCE', label: 'Maintenance facility' }),
]);

/**
 * Shape__Area and Shape__Length are WEB MERCATOR (EPSG:3857) units, not ground measurements.
 *
 * Measured, not assumed: across 5,986 footprints the ratio of Shape__Length to the ground
 * perimeter equals 1/cos(latitude) to five decimal places (median 1.00000), which is exactly the
 * Web Mercator scale distortion. At PortMiami's latitude that is 1.1106 for length and its square,
 * 1.2334, for area — so reading Shape__Area as square metres overstates a footprint by 23%.
 *
 * The panel therefore shows the source value as the source's own number AND a ground figure
 * computed from the geometry, each labelled for what it is.
 */
export const MERCATOR_NOTE = Object.freeze({
  lengthFactorAt: latitude => 1 / Math.cos((latitude * Math.PI) / 180),
});
