/**
 * Road Network configuration — WHAT counts as a PortMiami access road, and how roads are drawn.
 *
 * Like src/config/portMiami.js this file imports nothing from Cesium and holds no geometry. It is
 * the rules, in one editable place, so a correction is a one-line edit here rather than a hunt
 * through the layer code.
 *
 * The classification is derived from the source attributes only — PRE_DIR / ST_NAME / ST_TYPE /
 * SUF_DIR — never from proximity to the port. A geographic test was checked and deliberately
 * rejected: a box drawn around Dodge Island also catches Star Island Dr, N/S Hibiscus Dr, Palm Ave
 * and Parrot Jungle Trl, which are MacArthur Causeway residential islands, not port access.
 */

/**
 * Name patterns that identify a port road from its own name. Matched against the readable name,
 * upper-cased, so "E PORT BLVD" and "PORT MIAMI TUNNEL" both hit the first rule.
 */
export const PORT_ACCESS_NAME_PATTERNS = Object.freeze([
  Object.freeze({ pattern: /\bPORT\b/, reason: 'Name contains PORT' }),
  Object.freeze({ pattern: /\bCRUISE\b/, reason: 'Name contains CRUISE' }),
]);

/**
 * PortMiami's internal terminal grid. These carry no "port" in their names — the port named its
 * streets after continents and oceans — so a pattern cannot find them and they are listed by name.
 * Each was confirmed to lie wholly on Dodge Island before being listed; the list is the rule, and
 * the geography was only the evidence for writing it.
 */
export const PORT_ACCESS_STREET_NAMES = Object.freeze([
  'AFRICA WAY', 'ASIA WAY', 'ATLANTIC WAY', 'AUSTRALIA WAY', 'CARIBBEAN WAY',
  'EUROPE WAY', 'FLORIDA WAY', 'N AMERICA WAY', 'S AMERICA WAY',
]);

/**
 * Per-segment corrections, by OBJECTID, applied last and winning over everything above. Empty on
 * purpose: nothing has been corrected yet, and inventing entries would be inventing data. This is
 * where a port engineer's "no, that ramp is ours" goes.
 *
 * @type {Readonly<Record<number, boolean>>}
 */
export const PORT_ACCESS_OVERRIDES = Object.freeze({});

/**
 * Known to be arguable, recorded so the next person does not have to re-derive it:
 *
 * - SR 887 (29 segments) runs beside Port Blvd but shares only 4 of its 87 vertices with it, so it
 *   is a separate alignment, not a second name for the same road. It is NOT classified as port
 *   access. If the source's state-road numbering turns out to designate the port approach, add its
 *   OBJECTIDs to PORT_ACCESS_OVERRIDES.
 * - MACARTHUR CSWY and its ramps carry traffic TO the port but are a state causeway serving
 *   Miami Beach as well. Not port access.
 * - TERMINAL ISLAND / TERMINAL ISLE sit at longitude -80.152 to -80.146, by the causeway, not on
 *   Dodge Island. The word "terminal" is a coincidence. Not port access.
 */
export const CLASSIFICATION_NOTES = Object.freeze(['SR 887', 'MACARTHUR CSWY', 'TERMINAL ISLAND']);

/**
 * Names whose geometry is an UNDERGROUND centreline. Drawn differently, because a tunnel drawn as
 * a surface road would claim the Port Tunnel runs across Dodge Island's container yard — which is
 * precisely what it was built to avoid.
 */
export const TUNNEL_NAME_PATTERNS = Object.freeze([/\bTUNNEL\b/]);

/**
 * How the layer is drawn over Google Photorealistic 3D Tiles.
 *
 * `heightOffsetM` is the one number to turn if the lines sit wrong. See the README for why a fixed
 * offset is used instead of clamping.
 */
export const ROAD_RENDER = Object.freeze({
  heightOffsetM: 6,
  width: Object.freeze({ surrounding: 2, portAccess: 3, tunnel: 3, selected: 5, hovered: 4 }),
  /**
   * Light-theme palette, picked to read on aerial photography rather than on a white panel.
   * `depthFail` is the colour the line takes where the photorealistic mesh is in front of it.
   */
  colors: Object.freeze({
    surrounding: '#5b7694',
    portAccess: '#1862d0',
    tunnel: '#7a5bbd',
    selected: '#e8a317',
    hovered: '#2d86ff',
    depthFailAlpha: 0.22,
  }),
});

/** The source file, served as a static asset rather than bundled into the JavaScript. */
export const ROAD_SOURCE = Object.freeze({
  url: 'data/portmiami_roads_merged.geojson',
  label: 'portmiami_roads_merged.geojson',
  expectedFeatureCount: 2362,
});
