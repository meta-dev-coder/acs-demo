/**
 * Maintenance records on the map.
 *
 * One data source for the whole workspace: only the type being browsed is drawn, so switching Work
 * Orders → Tickets swaps what is shown without touching the viewer, the terrain or the Google
 * tiles. Markers are the corridor's own ID markers (assetIdMarker.js) — charcoal for the rest,
 * the shared yellow for the selection — so a work order reads like every other asset on this map.
 *
 * Built the way the Lighting layer is: a location dot for every record, the ID marker for the ones
 * nearest the camera and for the selection, because a type can hold several hundred records.
 */
import { CustomDataSource, Cartesian3, HeightReference, NearFarScalar, ScreenSpaceEventType, VerticalOrigin } from 'cesium';
import { assetDotMarker, assetIdMarker } from '../assetIdMarker.js';

export const LABEL_BUDGET = 60;
export const LABEL_RANGE_M = 4000;

const BILLBOARD = Object.freeze({
  verticalOrigin: VerticalOrigin.BOTTOM, heightReference: HeightReference.CLAMP_TO_GROUND,
  disableDepthTestDistance: Number.POSITIVE_INFINITY, scaleByDistance: new NearFarScalar(400, 1, 12000, 0.7),
});

const entityId = (assetType, id) => `maintenance-${assetType}-${id}`;

/**
 * @param {import('cesium').Viewer} viewer
 * @returns {{setRecords: (assetType: string, records: object[]) => void, show: (assetType: string|null) => void,
 *            recordsFor: (assetType: string) => object[], highlightById: (id: string|null) => void,
 *            onSelection: (fn: ((id: string|null) => void)|null) => void, destroy: () => void}}
 */
export function installMaintenanceLayer(viewer) {
  const source = new CustomDataSource('Maintenance Records');
  const added = viewer.dataSources.add(source);
  // Records often share an asset — two work orders on one drainage structure sit at exactly the same
  // point. These markers are drawn without a depth test, so the one drawn last wins and nothing about
  // the selection would put it there. The selected marker is therefore drawn from its own data
  // source, added after the first, which is always on top and always the one a click finds.
  const selectionSource = new CustomDataSource('Maintenance Selection');
  const selectionAdded = viewer.dataSources.add(selectionSource);
  /** assetType -> { records, entities: Map<id, Entity>, drawn: Map<id, state> } */
  const layers = new Map();
  const listeners = new Set();
  let active = null, selected = null, labelled = new Set(), disposed = false;

  const layerOf = assetType => layers.get(assetType) ?? null;

  function present(assetType, id) {
    const layer = layerOf(assetType);
    const entity = layer?.entities.get(id);
    if (!entity) return;
    const isSelected = id === selected && assetType === active;
    const state = isSelected ? 'selected' : labelled.has(id) && assetType === active ? 'id' : 'dot';
    if (layer.drawn.get(id) === state) return;
    layer.drawn.set(id, state);
    // The selected one is drawn by the selection source instead, so it cannot end up behind a marker
    // it shares a position with.
    entity.show = !isSelected && assetType === active && !hiddenBySelection(layer, id)
      && (!layer.visible || layer.visible.has(id));
    const tone = layer.tones.get(id);
    const marker = state === 'dot' ? assetDotMarker(tone) : assetIdMarker({ id, selected: false, tone });
    entity.billboard.image = marker.image;
    entity.billboard.width = marker.width;
    entity.billboard.height = marker.height;
  }

  /**
   * True for a marker standing on exactly the same point as the selected one. Drawn without a depth
   * test, two markers at one point are decided by draw order, which nothing here controls — so the
   * coincident ones stand down while the selection is there. They stay in the list either way.
   */
  function hiddenBySelection(layer, id) {
    if (!selected || id === selected) return false;
    const key = [...(layer.atPoint ?? new Map())].find(([, ids]) => ids.includes(selected))?.[0];
    return Boolean(key && layer.atPoint.get(key)?.includes(id));
  }

  /** The one marker that is always on top: the selection, redrawn wherever it moves to. */
  function drawSelection() {
    selectionSource.entities.removeAll();
    const layer = layerOf(active);
    const position = selected ? layer?.positions.get(selected) : null;
    if (!position) return;
    const marker = assetIdMarker({ id: selected, selected: true });
    selectionSource.entities.add({
      id: `maintenance-${active}-${selected}`, name: selected, show: true, position,
      billboard: { ...BILLBOARD, ...marker, scale: 1.08 },
    });
  }

  /** The nearest records carry their ID; the rest stay dots, so a dense corridor stays readable. */
  function updateLabels() {
    const layer = layerOf(active);
    if (!layer || disposed) return;
    const eye = viewer.camera.positionWC;
    const near = [];
    for (const record of layer.records) {
      const position = layer.positions.get(record.id);
      if (!position) continue;
      const distance = Cartesian3.distance(eye, position);
      if (!layer.entities.get(record.id)?.show && record.id !== selected) continue;
      if (distance <= LABEL_RANGE_M) near.push([distance, record.id]);
    }
    near.sort((a, b) => a[0] - b[0]);
    const next = new Set(near.slice(0, LABEL_BUDGET).map(([, id]) => id));
    const changed = [...labelled].filter(id => !next.has(id)).concat([...next].filter(id => !labelled.has(id)));
    if (!changed.length) return;
    labelled = next;
    for (const id of changed) present(active, id);
    viewer.scene.requestRender();
  }
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(updateLabels);
  const removeChanged = viewer.camera.changed.addEventListener(updateLabels);

  /** Replace one type's records. Entities are rebuilt only for the type that changed. */
  function setRecords(assetType, records) {
    const previous = layerOf(assetType);
    if (previous) for (const entity of previous.entities.values()) source.entities.remove(entity);
    const entities = new Map(), positions = new Map(), drawn = new Map(), atPoint = new Map(), tones = new Map();
    source.entities.suspendEvents();
    try {
      for (const item of records) {
        if (!Number.isFinite(item.longitude) || !Number.isFinite(item.latitude)) continue;   // stays in the list only
        if (entities.has(item.id)) continue;   // an id the source repeats: one marker, not a crash
        tones.set(item.id, item.type === 'ASSET_STATUS' ? 'damaged' : item.live ? 'live' : 'normal');
        const position = Cartesian3.fromDegrees(item.longitude, item.latitude);
        const entity = source.entities.add({
          id: entityId(assetType, item.id), name: item.id, show: assetType === active,
          position, billboard: { ...BILLBOARD, ...assetDotMarker(tones.get(item.id)) },
        });
        entities.set(item.id, entity);
        positions.set(item.id, position);
        drawn.set(item.id, 'dot');
        // Records commonly share an asset, so their markers land on exactly the same point.
        const key = `${item.longitude},${item.latitude}`;
        atPoint.set(key, [...(atPoint.get(key) ?? []), item.id]);
      }
    } finally { source.entities.resumeEvents(); }
    layers.set(assetType, { records, entities, positions, drawn, atPoint, tones });
    if (assetType === active) { labelled = new Set(); updateLabels(); drawSelection(); }
    viewer.scene.requestRender();
  }

  /**
   * Show only these ids of a type (null means all of them) — what the browser's search and filter
   * leave on screen. Visibility only: no entity is created or destroyed by filtering.
   */
  function setVisibleIds(assetType, ids) {
    const layer = layerOf(assetType);
    if (!layer) return;
    layer.visible = ids ? new Set(ids) : null;
    for (const [id, entity] of layer.entities) {
      entity.show = assetType === active && (!layer.visible || layer.visible.has(id)) && id !== selected;
    }
    if (assetType === active) { labelled = new Set(); updateLabels(); drawSelection(); }
    viewer.scene.requestRender();
  }

  /** Draw one type and nothing else. */
  function show(assetType) {
    if (active === assetType) return;
    active = assetType;
    selected = null;
    labelled = new Set();
    for (const [type, layer] of layers) {
      for (const entity of layer.entities.values()) entity.show = type === assetType;
      if (type !== assetType) layer.drawn.clear();
    }
    selectionSource.entities.removeAll();
    if (active) { for (const id of layerOf(active)?.drawn.keys() ?? []) present(active, id); updateLabels(); }
    viewer.scene.requestRender();
  }

  function highlightById(id) {
    const next = id == null ? null : String(id);
    if (next === selected) return;
    const previous = selected;
    const layer = layerOf(active);
    const siblings = id => (layer ? [...layer.atPoint].find(([, ids]) => ids.includes(id))?.[1] ?? [] : []);
    const touched = new Set([previous, next, ...siblings(previous), ...siblings(next)].filter(Boolean));
    selected = next;
    for (const id of touched) { layer?.drawn.delete(id); present(active, id); }
    drawSelection();
    viewer.scene.requestRender();
  }

  // Chained into the shared handler like the camera and lighting layers: a hit is not passed on,
  // because the layers further down report "nothing selected" for a click that is not theirs.
  const handler = viewer.screenSpaceEventHandler;
  const oldClick = handler.getInputAction(ScreenSpaceEventType.LEFT_CLICK);
  handler.setInputAction(event => {
    const entity = viewer.scene.pick(event.position)?.id;
    const prefix = active ? `maintenance-${active}-` : null;
    const id = prefix && typeof entity?.id === 'string' && entity.id.startsWith(prefix) ? entity.id.slice(prefix.length) : null;
    // `show` is only meaningful on the records source; the selection source draws one entity that is
    // always visible.
    if (!id || entity.show === false) { oldClick?.(event); return; }
    highlightById(id);
    for (const fn of listeners) fn(active, id);
  }, ScreenSpaceEventType.LEFT_CLICK);

  return {
    setRecords,
    setVisibleIds,
    show,
    get activeType() { return active; },
    recordsFor: assetType => layerOf(assetType)?.records ?? [],
    /** Records the map can actually place — the list still shows the others. */
    placedFor: assetType => (layerOf(assetType)?.records ?? []).filter(item => layerOf(assetType).entities.has(item.id)),
    highlightById,
    onSelection(fn) { if (!fn) listeners.clear(); else listeners.add(fn); },
    destroy() {
      disposed = true;
      removeMoveEnd(); removeChanged(); listeners.clear();
      if (oldClick) handler.setInputAction(oldClick, ScreenSpaceEventType.LEFT_CLICK);
      else handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
      void added.then(() => viewer.dataSources.remove(source, true));
      void selectionAdded.then(() => viewer.dataSources.remove(selectionSource, true));
    },
  };
}
