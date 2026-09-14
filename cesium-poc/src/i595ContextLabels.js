import { corridorVisualConfig as config } from './corridorVisualConfig.js';
/**
 * Geographic orientation labels along the corridor — "I-75 / Sawgrass", "Pine Island Rd", and so on.
 *
 * Map furniture, not assets: plain text set on the corridor centerline at the interchanges defined
 * in i595ShieldData.js, with no pin, no billboard and no marker of any kind. They are held back by a
 * distance condition so a zoomed-out corridor is not papered with names, and they are excluded from
 * picking for the same reasons the route shields are.
 */
import { Cartesian2, Cartesian3, Color, CustomDataSource, DistanceDisplayCondition, LabelStyle, NearFarScalar, VerticalOrigin } from 'cesium';
import { CONTEXT_LABEL_ASSET_TYPE, contextLabelPlacements } from './i595ShieldData.js';
import { registerUiOnlyEntities } from './uiOnlyMapEntities.js';

/** Beyond this the corridor is a line on a map and individual crossings stop being useful. */
export const LABEL_VISIBLE_TO_M = config.lod.overviewDistance;

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{lon: number, lat: number}[]} centerline  the corridor geometry the labels are placed on
 */
export function installI595ContextLabels(viewer, centerline) {
  const source = new CustomDataSource('I-595 Context Labels');
  const labels = new Set();
  const placements = contextLabelPlacements(centerline);
  for (const placement of placements) {
    const entity = source.entities.add({
      id: placement.id,
      name: placement.interchange,
      position: Cartesian3.fromDegrees(placement.lon, placement.lat),
      properties: { assetType: CONTEXT_LABEL_ASSET_TYPE, uiOnly: true, interchange: placement.interchange },
      label: {
        text: placement.interchange,
        font: '600 13px system-ui, -apple-system, "Segoe UI", sans-serif',
        fillColor: Color.WHITE,
        // An outline rather than a background plate, so the label reads over bright and dark
        // photogrammetry alike without becoming a POI chip.
        style: LabelStyle.FILL_AND_OUTLINE, outlineColor: Color.fromCssColorString('#0b1729'), outlineWidth: 4,
        verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, -16),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new DistanceDisplayCondition(0, LABEL_VISIBLE_TO_M),
        scaleByDistance: new NearFarScalar(600, 1, LABEL_VISIBLE_TO_M, 0.8),
        // Fades with distance, but never so far that a label in frame is unreadable.
        translucencyByDistance: new NearFarScalar(600, 1, LABEL_VISIBLE_TO_M, 0.6),
      },
    });
    labels.add(entity);
  }

  const unregister = registerUiOnlyEntities(viewer, labels);
  const added = viewer.dataSources.add(source).then(() => viewer.scene.requestRender());

  return {
    /** @type {Map<string, import('cesium').Entity>} */
    labelById: new Map([...labels].map(entity => [entity.id, entity])),
    placements,
    ready: added,
    /** Startup choreography hook: 0 = not drawn at all, 1 = fully opaque. */
    setOpacity(alpha) {
      const value = Math.min(1, Math.max(0, alpha));
      source.show = value > 0;
      for (const entity of labels) {
        entity.label.fillColor = Color.WHITE.withAlpha(value);
        entity.label.outlineColor = Color.fromCssColorString('#0b1729').withAlpha(value);
      }
      viewer.scene.requestRender();
    },
    destroy() {
      unregister();
      viewer.dataSources.remove(source, true);
      labels.clear();
    },
  };
}
