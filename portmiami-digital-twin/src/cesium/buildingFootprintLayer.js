/**
 * Building footprints as a Cesium layer.
 *
 * ---------------------------------------------------------------------------------------------
 * Why outlines and not filled or extruded polygons
 *
 * A filled polygon needs a height to sit at, and over Google Photorealistic 3D Tiles every option
 * is wrong in a different way:
 *
 *   - `classificationType` (draping the fill on the surface) needs the surface to support
 *     classification. Google's tileset does not, and this app hides the globe, so there is nothing
 *     to drape onto — the same wall the road layer hit.
 *   - A fill at a fixed height is swallowed by the building it outlines: the mesh roof is tens of
 *     metres up, the polygon is at 6 m, so it renders INSIDE the building and is invisible, and
 *     invisible geometry cannot be picked either.
 *   - Extruding to HEIGHT would put a solid box over the photorealistic building — and HEIGHT is
 *     null for 5,423 of the 6,000 footprints, with no unit stated for the 577 that have it. Every
 *     extruded box would be a height this project invented.
 *
 * So a footprint is drawn as its OUTLINE: one polyline per ring, at the same 6 m offset the road
 * layer uses, with a `depthFailMaterial` so the part behind the building still reads, dimmed.
 * Nothing floats, because nothing is solid; a building reads as a footprint on the ground, which
 * is what the source actually contains.
 *
 * Limits, stated rather than hidden:
 *   - The outline is a plan trace at one height. On a building standing on a slope or a podium it
 *     will cut through the facade rather than follow the base.
 *   - Picking is on the line, not the area, so selecting means clicking the edge of a footprint.
 *     The line thickens on hover to make that easier.
 *   - Holes are drawn as their own outlines, so a courtyard shows as a second loop.
 * ---------------------------------------------------------------------------------------------
 */
import {
  BoundingSphere, Cartesian3, Color, CustomDataSource, HeadingPitchRange, Rectangle,
} from 'cesium';
import { BUILDING_RENDER } from '../config/buildings.js';

const { colors, width, heightOffsetM } = BUILDING_RENDER;
const MATERIALS = {
  resting: Color.fromCssColorString(colors.resting),
  hovered: Color.fromCssColorString(colors.hovered),
  selected: Color.fromCssColorString(colors.selected),
  // A footprint confirmed as an asset's own, and one merely proposed. Same hue, different weight,
  // so a candidate never reads as a decision.
  linkConfirmed: Color.fromCssColorString('#15822d'),
  linkCandidate: Color.fromCssColorString('#15822d').withAlpha(0.55),
};
const depthFail = color => color.withAlpha(colors.depthFailAlpha);

/**
 * @param {import('cesium').Viewer} viewer
 * @param {import('../buildings/buildingModel.js').Building[]} buildings
 * @param {{picker?: ReturnType<import('./mapPicking.js').createMapPicker>, visible?: boolean}} [options]
 */
export function installBuildingFootprintLayer(viewer, buildings, { picker, visible = false } = {}) {
  const source = new CustomDataSource('port-buildings');
  // A building is several entities when it has holes or several parts, so the map is id -> list.
  const byId = new Map();

  for (const building of buildings) {
    const entities = building.rings.map((ring, index) => source.entities.add({
      // The OBJECTID is in the id, so a pick needs no lookup table. The ring index keeps the id
      // unique without changing how it is parsed.
      id: `building-${building.objectId}:${index}`,
      polyline: {
        positions: Cartesian3.fromDegreesArrayHeights(ring.flatMap(([lon, lat]) => [lon, lat, heightOffsetM])),
        width: width.resting,
        material: MATERIALS.resting,
        depthFailMaterial: depthFail(MATERIALS.resting),
      },
    }));
    byId.set(building.objectId, { entities, building });
  }
  // Default OFF: 6,000 footprints over photorealistic buildings is clutter until asked for.
  source.show = visible;
  viewer.dataSources.add(source);

  let selectedId = null, hoveredId = null;
  /** OBJECTID -> 'CONFIRMED' | 'CANDIDATE', set by the Infrastructure explorer. */
  let emphasis = new Map();

  function paint(objectId) {
    const record = byId.get(objectId);
    if (!record) return;
    const isSelected = objectId === selectedId;
    const isHovered = objectId === hoveredId && !isSelected;
    const link = emphasis.get(objectId);
    const color = isSelected ? MATERIALS.selected
      : isHovered ? MATERIALS.hovered
      : link === 'CONFIRMED' ? MATERIALS.linkConfirmed
      : link === 'CANDIDATE' ? MATERIALS.linkCandidate
      : MATERIALS.resting;
    const lineWidth = isSelected ? width.selected
      : isHovered ? width.hovered
      : link ? width.hovered
      : width.resting;
    for (const entity of record.entities) {
      entity.polyline.width = lineWidth;
      entity.polyline.material = color;
      entity.polyline.depthFailMaterial = depthFail(color);
    }
  }

  const unregister = picker?.register({
    kind: 'building',
    idPrefix: 'building-',
    parseId: entityId => {
      const id = Number(entityId.slice('building-'.length).split(':')[0]);
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
    setVisible(nextVisible) {
      source.show = nextVisible;
      if (!nextVisible && hoveredId != null) { const previous = hoveredId; hoveredId = null; paint(previous); }
      viewer.scene.requestRender();
    },
    isVisible: () => source.show,

    select(objectId) {
      if (objectId === selectedId) return;
      const previous = selectedId;
      selectedId = objectId ?? null;
      if (previous != null) paint(previous);
      if (selectedId != null) paint(selectedId);
      viewer.scene.requestRender();
    },
    selected: () => selectedId,

    /** @param {Map<number, 'CONFIRMED'|'CANDIDATE'>} next */
    setEmphasis(next) {
      const touched = new Set([...emphasis.keys(), ...next.keys()]);
      emphasis = next;
      for (const objectId of touched) paint(objectId);
      viewer.scene.requestRender();
    },

    /** Frame one footprint, looking down steeply enough never to fly inside a neighbour. */
    flyTo(objectId, { duration = 1.6 } = {}) {
      const record = byId.get(objectId);
      if (!record || viewer.isDestroyed()) return;
      const { west, south, east, north } = record.building.bounds;
      const sphere = BoundingSphere.fromRectangle3D(Rectangle.fromDegrees(west, south, east, north));
      viewer.camera.cancelFlight();
      viewer.camera.flyToBoundingSphere(sphere, {
        duration,
        offset: new HeadingPitchRange(0, -Math.PI / 3.2, Math.max(sphere.radius * 4, 260)),
      });
    },

    destroy() {
      unregister?.();
      if (!viewer.isDestroyed()) viewer.dataSources.remove(source, true);
      byId.clear();
    },
  };
}
