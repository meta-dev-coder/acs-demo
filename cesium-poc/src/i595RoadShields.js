/**
 * I-595 route shields — a display-only orientation aid.
 *
 * Seven billboards on the corridor centerline, drawn from a local Interstate shield SVG in
 * public/icons — map labelling, not roadside furniture, and nothing hotlinked from a map provider.
 *
 * These are NOT assets. Every entity carries `assetType = ROAD_SHIELD` / `uiOnly = true` and is
 * registered as display-only map furniture, so no hit test can select one or be blocked by one.
 */
import { Color, CustomDataSource, Cartesian3, HeightReference, HorizontalOrigin, NearFarScalar, VerticalOrigin } from 'cesium';
import { ROAD_SHIELD_ASSET_TYPE, shieldPlacements } from './i595ShieldData.js';
import { registerUiOnlyEntities } from './uiOnlyMapEntities.js';

/** Local Interstate shield asset: red header, dark blue body, white border and numerals. */
export const SHIELD_ICON_URL = `${import.meta.env.BASE_URL}icons/interstate-595.svg`;

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{lon: number, lat: number}[]} centerline  the corridor geometry the shields are placed on
 */
export function installI595RoadShields(viewer, centerline) {
  const source = new CustomDataSource('I-595 Route Shields');
  const shields = new Set();
  const placements = shieldPlacements(centerline);
  for (const placement of placements) {
    const entity = source.entities.add({
      id: placement.id,
      name: `${placement.route} at ${placement.interchange}`,
      position: Cartesian3.fromDegrees(placement.lon, placement.lat),
      // Read by anything that needs to tell a route shield apart from a real corridor asset.
      properties: { assetType: ROAD_SHIELD_ASSET_TYPE, uiOnly: true, route: placement.route, interchange: placement.interchange },
      billboard: {
        image: SHIELD_ICON_URL, width: 40, height: 40,
        // Centred on the road it labels — a sign lying on the map, not a pin pointing at a place.
        verticalOrigin: VerticalOrigin.CENTER, horizontalOrigin: HorizontalOrigin.CENTER,
        // Clamped like every other corridor marker, so the shield follows Google's photogrammetry
        // surface, and depth-test-free so the mesh can never bury it. No invented Z offset.
        heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
        // Keep a readable 34px minimum even in the corridor overview.
        scaleByDistance: new NearFarScalar(800, 1, 22000, 0.85),
      },
    });
    shields.add(entity);
  }

  // Shields are map furniture: invisible to every hit test, and never blocking one.
  const unregister = registerUiOnlyEntities(viewer, shields);

  const added = viewer.dataSources.add(source).then(() => viewer.scene.requestRender());
  return {
    /** @type {Map<string, import('cesium').Entity>} */
    shieldById: new Map([...shields].map(entity => [entity.id, entity])),
    placements,
    ready: added,
    /** Shields ride with the road network; no separate checkbox in the layer tree. */
    setVisible(show) {
      source.show = show;
      viewer.scene.requestRender();
    },
    /**
     * Startup choreography hook: 0 = not drawn at all, 1 = fully opaque. Below full strength the
     * shields are tinted rather than merely faded, so a half-drawn shield never looks like an
     * asset in a muted state.
     */
    setOpacity(alpha) {
      const value = Math.min(1, Math.max(0, alpha));
      source.show = value > 0;
      for (const entity of shields) entity.billboard.color = Color.WHITE.withAlpha(value);
      viewer.scene.requestRender();
    },
    get visible() { return source.show; },
    destroy() {
      unregister();
      viewer.dataSources.remove(source, true);
      shields.clear();
    },
  };
}
