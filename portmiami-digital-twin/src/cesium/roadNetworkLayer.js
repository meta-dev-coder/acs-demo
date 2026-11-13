/**
 * The Road Network as a Cesium layer. Imperative and outside React on purpose: 2,362 polylines are
 * built once, and selection or hover changes one entity's material rather than re-rendering a tree.
 * React never subscribes to the camera, so moving the map re-renders nothing.
 *
 * ---------------------------------------------------------------------------------------------
 * Drawing lines over Google Photorealistic 3D Tiles
 *
 * `clampToGround` was tried and does not work here, for a reason that is structural rather than a
 * bug: clamping drapes a line over the GLOBE's terrain, and this app hides the globe
 * (`scene.globe.show = false`) so the photorealistic mesh is not punched through by it. With no
 * globe there is nothing to clamp to, and the lines fall to the ellipsoid — about 25 m below the
 * Miami mesh, i.e. underneath the whole city.
 *
 * `GroundPolylinePrimitive` is the other clamping route, and it needs the surface it draws on to
 * support classification. Google's photorealistic tileset does not, so it drapes on the globe too.
 *
 * What is used instead: each line is drawn at a fixed height (ROAD_RENDER.heightOffsetM above the
 * ellipsoid) and given a `depthFailMaterial`, so where the mesh stands in front of the line — a
 * cruise terminal, a gantry crane, the causeway deck — the line still shows, dimmed, instead of
 * disappearing. The offset is one number in src/config/roadNetwork.js.
 *
 * Its limits, stated rather than hidden:
 *   - It is a single offset for the whole network. It suits PortMiami because Dodge Island and
 *     downtown Miami are 0-3 m above sea level; it would need rethinking for a hilly site.
 *   - The source centrelines are 2D. Nothing in them says a segment is on a bridge deck, so the
 *     MacArthur Causeway's elevated spans are drawn at the same height as the ground beside them
 *     and will sit below their real deck.
 *   - PORT MIAMI TUNNEL is an underground centreline. It is drawn dashed, in its own colour, and
 *     labelled as a tunnel wherever it appears, so it is not read as a road across the container
 *     yard. Its height is the same offset — it is a plan-view trace, not a depth.
 * ---------------------------------------------------------------------------------------------
 */
import {
  BoundingSphere, Cartesian3, Color, CustomDataSource, HeadingPitchRange,
  PolylineDashMaterialProperty, Rectangle,
} from 'cesium';
import { ROAD_RENDER } from '../config/roadNetwork.js';

const css = hex => Color.fromCssColorString(hex);
const { colors, width, heightOffsetM } = ROAD_RENDER;

/** One material per style bucket, shared by every entity in it, so Cesium batches them. */
const MATERIALS = {
  surrounding: css(colors.surrounding),
  portAccess: css(colors.portAccess),
  tunnel: css(colors.tunnel),
  selected: css(colors.selected),
  hovered: css(colors.hovered),
  // Asset access roads. Confirmed is a solid green that cannot be mistaken for the port-access
  // blue (which says "this road serves the port", not "this road serves THIS asset"); candidate
  // is the same hue, thinner and half-strength, so an unreviewed guess never looks decided.
  linkConfirmed: css('#15822d'),
  linkCandidate: css('#15822d').withAlpha(0.5),
};
const depthFail = color => color.withAlpha(colors.depthFailAlpha);

/** The style a segment has when nothing is selected or hovered. */
const restingStyle = segment => {
  if (segment.isTunnel) return { color: MATERIALS.tunnel, width: width.tunnel, dashed: true };
  if (segment.isPortAccess) return { color: MATERIALS.portAccess, width: width.portAccess, dashed: false };
  return { color: MATERIALS.surrounding, width: width.surrounding, dashed: false };
};

/**
 * @param {import('cesium').Viewer} viewer
 * @param {import('../roads/roadModel.js').RoadSegment[]} segments
 * @param {{picker?: ReturnType<import('./mapPicking.js').createMapPicker>}} [hooks]
 */
export function installRoadNetworkLayer(viewer, segments, { picker } = {}) {
  const source = new CustomDataSource('port-roads');
  const byId = new Map();

  for (const segment of segments) {
    const positions = Cartesian3.fromDegreesArrayHeights(
      segment.coordinates.flatMap(([lon, lat]) => [lon, lat, heightOffsetM]));
    const style = restingStyle(segment);
    const entity = source.entities.add({
      // The OBJECTID is the entity's identity too, so a pick needs no lookup table.
      id: `road-${segment.objectId}`,
      polyline: {
        positions,
        width: style.width,
        material: style.dashed
          ? new PolylineDashMaterialProperty({ color: style.color, dashLength: 14 })
          : style.color,
        depthFailMaterial: style.dashed
          ? new PolylineDashMaterialProperty({ color: depthFail(style.color), dashLength: 14 })
          : depthFail(style.color),
      },
    });
    byId.set(segment.objectId, { entity, segment });
  }
  viewer.dataSources.add(source);

  let selectedId = null, hoveredId = null;
  /** OBJECTID -> 'CONFIRMED' | 'CANDIDATE', set by the Infrastructure explorer. */
  let emphasis = new Map();

  /** Re-apply one segment's style from the current selection and hover state. */
  function paint(objectId) {
    const record = byId.get(objectId);
    if (!record) return;
    const style = restingStyle(record.segment);
    const isSelected = objectId === selectedId;
    const isHovered = objectId === hoveredId && !isSelected;
    // Selection always wins — it is the thing the user just pointed at.
    const link = emphasis.get(objectId);
    const color = isSelected ? MATERIALS.selected
      : isHovered ? MATERIALS.hovered
      : link === 'CONFIRMED' ? MATERIALS.linkConfirmed
      : link === 'CANDIDATE' ? MATERIALS.linkCandidate
      : style.color;
    const lineWidth = isSelected ? width.selected
      : isHovered ? width.hovered
      : link === 'CONFIRMED' ? width.selected
      : link === 'CANDIDATE' ? width.portAccess
      : style.width;
    const polyline = record.entity.polyline;
    polyline.width = lineWidth;
    polyline.material = style.dashed
      ? new PolylineDashMaterialProperty({ color, dashLength: 14 })
      : color;
    polyline.depthFailMaterial = style.dashed
      ? new PolylineDashMaterialProperty({ color: depthFail(color), dashLength: 14 })
      : depthFail(color);
  }

  // Picking is the shared dispatcher's job; this layer only says what it owns and how to paint it.
  const unregister = picker?.register({
    kind: 'road',
    idPrefix: 'road-',
    parseId: entityId => {
      const id = Number(entityId.slice(5));
      return Number.isFinite(id) && byId.has(id) ? id : null;
    },
    isPickable: () => source.show,
    setHovered(objectId) {
      if (objectId === hoveredId) return;
      const previous = hoveredId;
      hoveredId = objectId;
      if (previous != null) paint(previous);
      if (objectId != null) paint(objectId);
    },
  });

  return {
    /** Show or hide the whole layer. Selection survives being hidden. */
    setVisible(visible) {
      source.show = visible;
      if (!visible) {
        viewer.scene.canvas.style.cursor = '';
        hoveredId = null;
      }
      viewer.scene.requestRender();
    },
    isVisible: () => source.show,

    /**
     * Highlight a segment. Repaints only the segment leaving and the one arriving, and never
     * moves the camera — flying is `flyTo`, a separate, explicit action.
     */
    select(objectId) {
      if (objectId === selectedId) return;
      const previous = selectedId;
      selectedId = objectId ?? null;
      if (previous != null) paint(previous);
      if (selectedId != null) paint(selectedId);
      viewer.scene.requestRender();
    },
    selected: () => selectedId,

    /**
     * Mark the roads linked to the selected asset. Repaints only what changed, so switching asset
     * touches a handful of entities rather than 2,362.
     * @param {Map<number, 'CONFIRMED'|'CANDIDATE'>} next
     */
    setEmphasis(next) {
      const touched = new Set([...emphasis.keys(), ...next.keys()]);
      emphasis = next;
      for (const objectId of touched) paint(objectId);
      viewer.scene.requestRender();
    },

    /**
     * Frame one segment. The camera is placed by the segment's own extent, with a floor on the
     * range so a short kerb-length segment is not approached from 10 m — which would put the eye
     * inside a terminal building — and looking down at 50 degrees so it never flies underground.
     */
    flyTo(objectId, { duration = 1.6 } = {}) {
      const record = byId.get(objectId);
      if (!record || viewer.isDestroyed()) return;
      const { west, south, east, north } = record.segment.bounds;
      const sphere = BoundingSphere.fromRectangle3D(Rectangle.fromDegrees(west, south, east, north));
      viewer.camera.cancelFlight();
      viewer.camera.flyToBoundingSphere(sphere, {
        duration,
        offset: new HeadingPitchRange(0, -Math.PI / 3.6, Math.max(sphere.radius * 3.2, 320)),
      });
    },

    destroy() {
      unregister?.();
      if (!viewer.isDestroyed()) viewer.dataSources.remove(source, true);
      byId.clear();
    },
  };
}
