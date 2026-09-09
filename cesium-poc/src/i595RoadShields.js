/**
 * I-595 route shields — a display-only orientation aid.
 *
 * Seven billboards on the corridor centerline, drawn from a local Interstate shield SVG in
 * public/icons — map labelling, not roadside furniture, and nothing hotlinked from a map provider.
 *
 * These are NOT assets. Every entity carries `assetType = ROAD_SHIELD` / `uiOnly = true`, is absent
 * from every layer's picking allowlist, and — because a shield drawn on top of the road would
 * otherwise swallow the click meant for what is underneath — this module filters shields out of
 * `scene.pick` / `scene.drillPick` once, centrally, for every existing picking layer. Segment,
 * ramp, bridge, CCTV, signal and live-event picking therefore behave exactly as before.
 */
import { CustomDataSource, Cartesian3, HeightReference, HorizontalOrigin, NearFarScalar, VerticalOrigin } from 'cesium';
import { ROAD_SHIELD_ASSET_TYPE, shieldPlacements } from './i595ShieldData.js';

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
        image: SHIELD_ICON_URL, width: 38, height: 38,
        // Centred on the road it labels — a sign lying on the map, not a pin pointing at a place.
        verticalOrigin: VerticalOrigin.CENTER, horizontalOrigin: HorizontalOrigin.CENTER,
        // Clamped like every other corridor marker, so the shield follows Google's photogrammetry
        // surface, and depth-test-free so the mesh can never bury it. No invented Z offset.
        heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
        // Shrink with distance: legible over an interchange, unobtrusive across the whole corridor.
        scaleByDistance: new NearFarScalar(1000, 1, 25000, 0.45),
      },
    });
    shields.add(entity);
  }

  // Picking: make shields transparent to every existing hit test rather than editing six layers.
  const scene = viewer.scene;
  const owned = ['pick', 'drillPick'].map(name => [name, Object.getOwnPropertyDescriptor(scene, name)]);
  const basePick = scene.pick.bind(scene), baseDrillPick = scene.drillPick.bind(scene);
  const isShield = hit => shields.has(hit?.id);
  scene.pick = (position, width, height) => {
    const picked = basePick(position, width, height);
    if (!isShield(picked)) return picked;
    // Only ever reached when a shield is topmost: fall through to whatever it covers.
    return baseDrillPick(position, shields.size + 1, width, height).find(hit => !isShield(hit));
  };
  scene.drillPick = (position, limit, width, height) => {
    // Ask for the shields' worth of extra hits so filtering can never eat the caller's limit.
    const hits = baseDrillPick(position, limit == null ? undefined : limit + shields.size, width, height).filter(hit => !isShield(hit));
    return limit == null ? hits : hits.slice(0, limit);
  };

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
    get visible() { return source.show; },
    destroy() {
      for (const [name, descriptor] of owned) {
        if (descriptor) Object.defineProperty(scene, name, descriptor); else delete scene[name];
      }
      viewer.dataSources.remove(source, true);
      shields.clear();
    },
  };
}
