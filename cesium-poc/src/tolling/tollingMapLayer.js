/**
 * The Tolling screen's own markers.
 *
 * The corridor already has a `gantries` layer, but it draws placed 3D models with a pin that only
 * appears beyond 900 m — so framing a gantry closely, which is exactly what this screen does, left
 * the map with nothing on it at all. This layer is billboards, visible at the distance the screen
 * actually uses, and it is the Tolling screen's alone: it is added on activate and removed on
 * leave, so no other workspace inherits it.
 *
 * Toll and express gantries are drawn as different marks because they are different assets — a
 * toll gantry charges, an express access node admits traffic to the managed lanes.
 */
import { Cartesian2, Cartesian3, Color, CustomDataSource, DistanceDisplayCondition, HeightReference, LabelStyle,
  NearFarScalar, ScreenSpaceEventType, VerticalOrigin } from 'cesium';
import { GANTRY_KINDS } from './tollingGantries.js';

/** Amber for a toll gantry, teal for an express one — the tones the corridor already uses. */
const TONES = Object.freeze({ [GANTRY_KINDS.TOLL]: '#F4A725', [GANTRY_KINDS.EXPRESS]: '#1B8FA8' });

/** A portal frame: two legs and the beam the readers hang from, at 4× for HiDPI. */
const gantryIcon = (fill, selected) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="136" height="120" viewBox="0 0 34 30">
    <rect x="3" y="9" width="4" height="20" rx="1.5" fill="${fill}" stroke="#0b1729" stroke-width="1"/>
    <rect x="27" y="9" width="4" height="20" rx="1.5" fill="${fill}" stroke="#0b1729" stroke-width="1"/>
    <rect x="0" y="2" width="34" height="9" rx="3" fill="#0b1729" stroke="${selected ? '#ffffff' : fill}" stroke-width="${selected ? 2.5 : 1.5}"/>
    <rect x="2" y="4" width="30" height="5" rx="2" fill="${fill}"/>
  </svg>`)}`;

/** Far enough to find a gantry from the corridor view, close enough not to clutter the whole state. */
const VISIBLE_TO_M = 60_000;
/**
 * Closer than this, a gantry that has a 3D model is the model.
 *
 * The marker is there to say where a structure is from a distance. Standing in front of the mesh
 * it is in the way — it was drawn over the middle of the gantry it marks — so it stands down for
 * the model, exactly as the corridor's own model pins do. A gantry with no mesh keeps its marker
 * at every distance: there would be nothing else to see.
 */
const MODEL_TAKES_OVER_M = 250;

/**
 * @param {import('cesium').Viewer} viewer
 */
export function installTollingMapLayer(viewer) {
  const source = new CustomDataSource('I-595 Tolling');
  const added = viewer ? viewer.dataSources.add(source) : Promise.resolve();
  const byId = new Map();
  let selectedId = null;
  let report = null;

  const style = (id, entity) => {
    const record = byId.get(id);
    if (!record || !entity) return;
    const selected = id === selectedId;
    entity.billboard.image = gantryIcon(TONES[record.kind] ?? TONES.TOLL, selected);
    entity.billboard.scale = selected ? 1.25 : 1;
    entity.label.fillColor = Color.fromCssColorString(selected ? '#ffffff' : '#dce6f2');
  };

  /** Replace what is drawn. Records are few (a handful), so this is a straight rebuild. */
  function setRecords(records) {
    source.entities.removeAll();
    byId.clear();
    for (const record of records ?? []) {
      if (!Number.isFinite(record?.longitude) || !Number.isFinite(record?.latitude)) continue;
      byId.set(record.id, record);
      const near = record.modelId ? MODEL_TAKES_OVER_M : 0;
      const entity = source.entities.add({
        id: record.id,
        name: record.name,
        position: Cartesian3.fromDegrees(record.longitude, record.latitude),
        billboard: {
          image: gantryIcon(TONES[record.kind] ?? TONES.TOLL, false),
          width: 34, height: 30, verticalOrigin: VerticalOrigin.BOTTOM,
          heightReference: HeightReference.CLAMP_TO_GROUND,
          // Photogrammetry would otherwise bury a marker standing on the road deck.
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new DistanceDisplayCondition(near, VISIBLE_TO_M),
          scaleByDistance: new NearFarScalar(400, 1, 20_000, 0.6),
        },
        label: {
          text: record.name,
          font: '500 13px system-ui, sans-serif',
          fillColor: Color.fromCssColorString('#dce6f2'),
          outlineColor: Color.fromCssColorString('#0b1729'), outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: VerticalOrigin.BOTTOM,
          pixelOffset: new Cartesian2(0, -34),
          heightReference: HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          // The label is the one thing that would crowd a corridor-wide view, so it stops sooner
          // than the marker does.
          distanceDisplayCondition: new DistanceDisplayCondition(near, 6_000),
        },
      });
      style(record.id, entity);
    }
    viewer?.scene?.requestRender?.();
  }

  /** Which marker reads as chosen. The explorer drives this; it is not a camera move. */
  function highlightById(id) {
    const next = id == null ? null : String(id);
    if (next === selectedId) return;
    const previous = selectedId;
    selectedId = next;
    for (const key of [previous, next]) {
      if (key) style(key, source.entities.getById(key));
    }
    viewer?.scene?.requestRender?.();
  }

  // A click on a marker is a selection like any other: it is reported, and the explorer decides.
  const handler = viewer?.screenSpaceEventHandler ?? null;
  const previousClick = handler?.getInputAction(ScreenSpaceEventType.LEFT_CLICK) ?? null;
  if (handler) {
    handler.setInputAction(movement => {
      // `pick().id` is the ENTITY, and the entity's own `id` is the record's — reading the first
      // as an identifier stringifies an object and matches nothing, so a marker click did nothing.
      const entity = viewer.scene.pick(movement.position)?.id;
      const id = entity?.id != null && byId.has(String(entity.id)) ? String(entity.id) : null;
      if (id) report?.(id); else previousClick?.(movement);
    }, ScreenSpaceEventType.LEFT_CLICK);
  }

  return {
    whenReady: () => added,
    setRecords,
    highlightById,
    /** @param {(id: string) => void} callback */
    onSelection(callback) { report = callback; },
    clear() { setRecords([]); highlightById(null); },
    destroy() {
      if (handler) {
        if (previousClick) handler.setInputAction(previousClick, ScreenSpaceEventType.LEFT_CLICK);
        else handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
      }
      viewer?.dataSources?.remove(source, true);
    },
  };
}
