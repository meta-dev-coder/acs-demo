/**
 * FDOT sign structures on the map — markers, selection, camera and explorer rows.
 *
 * One implementation serves every registered structure type. Each gets its own control, its own
 * marker colour and its own data source, but loading, rendering, picking, details and camera
 * behaviour are shared, so registering CANTILEVER or VERTICAL_TRUSS in signStructureData.js is all
 * a new type needs.
 *
 * Loading belongs to signStructureService.js, which caches per type. Each layer reads its file at
 * startup so its count and its rows are on screen before anyone switches it on — a count is a fact
 * about the corridor, not a reward for enabling a layer. The Cesium entities are a separate step,
 * made the first time a layer is actually shown: three types is over a hundred markers, and the map
 * should not carry them to display a number. After that, toggling only flips visibility.
 *
 * Markers only at this stage — no GLB models. `heading` and `height_m` are null in every current
 * record and nothing here depends on them.
 */
import { Cartesian3, CustomDataSource, DistanceDisplayCondition, HeightReference, NearFarScalar, ScreenSpaceEventType, VerticalOrigin } from 'cesium';
import { corridorVisualConfig as config } from './corridorVisualConfig.js';
import { createMapDetailsPanel } from './mapDetailsPanel.js';
import { assetIdMarker, MARKER_LABELS, OVERHEAD_STEM } from './assetIdMarker.js';
import { focusMapPoints } from './bridgeCamera.js';
import {
  SIGN_STRUCTURE_ASSET_TYPE, SIGN_STRUCTURE_TYPES, corridorBearingAt,
  signStructureDetails, signStructureLabel, signStructureTooltip,
} from './signStructureData.js';

/** Close enough to pick the physical gantry out of the photogrammetry, far enough to see it whole. */
export const INSPECTION_FRAMING = Object.freeze({ pitchDeg: -22, minimumHeight: 95 });

/**
 * A marker that looks like the structure it stands for: the plate carries the type's colour, and
 * the glyph — a portal, a cantilevered arm, an unclassified panel — comes from the registry, so a
 * type's map marker and its shape are one decision. Drawn at 4x so the glyph stays sharp.
 */
const marker = (type, selected) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="152" height="176" viewBox="0 0 38 44">
${selected ? '<rect x="0.5" y="0.5" width="37" height="37" rx="12" fill="none" stroke="#ffffff" stroke-width="3"/>' : ''}
<rect x="3" y="3" width="32" height="32" rx="9" fill="#0b1729" stroke="white" stroke-width="2"/>
<rect x="5.5" y="5.5" width="27" height="27" rx="7" fill="${selected ? '#ffffff' : type.accent}"/>
<path d="M19 40 15.5 34h7Z" fill="#0b1729"/>
${type.glyph}
</svg>`)}`;

const icons = new Map();
/** Selection is a variant of the image: a separate halo entity would collide with the billboard. */
function markerIcon(type, selected) {
  const key = `${type.id}|${selected}`;
  if (!icons.has(key)) icons.set(key, marker(type, selected));
  return icons.get(key);
}

/**
 * @param {HTMLElement} container  the existing "Structures" group in the layer tree
 * @param {import('cesium').Viewer} viewer
 * @param {ReturnType<import('./signStructureService.js').createSignStructureService>} service
 * @param {{types?: object[], centerline?: {lon: number, lat: number}[], logger?: Console}} [options]
 */
/** Structures are marked by the number in their id — I595_GANTRY_037 shows 037. */
function structureMarker(structureId, selected) {
  const { image, width, height } = assetIdMarker({ id: MARKER_LABELS.structureNumber(structureId), selected, stem: OVERHEAD_STEM });
  return { image, width, height };
}

export function installSignStructureLayers(container, viewer, service, { types = SIGN_STRUCTURE_TYPES, centerline = [], logger = console } = {}) {
  // ---- Asset Explorer bridge -------------------------------------------------------------------
  // These layers keep their own details panel and framing; the explorer adds browsing on top and
  // shares one selection with them.
  /**
   * Report selections to every listener, not one.
   *
   * A single module backs several asset types (gantries and lane barriers here; three structure
   * types elsewhere), and each registers its own listener. Holding one callback meant the last
   * registration silently replaced the others, so picks for every other type vanished.
   */
  const selectionListeners = new Set();
  const reportSelection = record => { for (const listener of [...selectionListeners]) listener(record); };

  const records = new Map();   // entity  -> record
  const layers = new Map();    // type id -> layer state
  let selected = null, hovered = null, disposed = false;

  const panel = createMapDetailsPanel({
    title: 'Structure Details', className: 'structure-details',
    details: signStructureDetails,
    tooltipText: signStructureTooltip,
    onClose: () => select(null),
  });

  for (const type of types) {
    const element = document.createElement('details');
    element.className = `structure-group ${type.id}-group`;
    element.style.setProperty('--road', type.accent);
    element.innerHTML = `<summary><input type="checkbox" id="${type.control}" aria-label="${type.label}"><span class="swatch"></span><span>${type.groupLabel}</span><span class="badge">…</span></summary>
      <div class="structure-list"></div><p class="ramp-status" role="status">Select to load</p><button class="structure-retry" hidden>Retry ${type.groupLabel} loading</button>`;
    container.append(element);
    const source = new CustomDataSource(`I-595 ${type.groupLabel} Sign Structures`);
    source.show = false;
    layers.set(type.id, {
      type, element, source,
      parent: element.querySelector('input'),
      list: element.querySelector('.structure-list'),
      status: element.querySelector('[role="status"]'),
      retry: element.querySelector('.structure-retry'),
      rows: new Map(), entities: new Map(), records: [],
      built: null, materialised: null,
    });
  }

  const ready = Promise.all([...layers.values()].map(layer => viewer.dataSources.add(layer.source)));

  function style(entity) {
    if (!entity?.billboard) return;
    const marker = structureMarker(records.get(entity)?.id, entity === selected);
    entity.billboard.image = marker.image;
    entity.billboard.width = marker.width;
    entity.billboard.height = marker.height;
    entity.billboard.scale = entity === selected ? 1.08 : entity === hovered ? 1.04 : 1;
  }

  /** Look along the road, so a structure is met the way a driver meets it. */
  function inspectionHeading(record) {
    // `heading` is reserved in the FDOT records and null in every current one; once a calibration
    // pass fills it in, the record's own value wins over the corridor's bearing.
    return record.heading ?? corridorBearingAt(centerline, record.longitude, record.latitude) ?? 0;
  }

  function select(entity) {
    // Only when actually selecting something here. A deselection must not close another
    // layer's panel — the shared selection clears every other layer on every pick.
    if (entity) document.querySelector('.camera-details')?.setAttribute('hidden', '');
    const previous = selected;
    selected = entity;
    style(previous); style(selected);
    panel.select(entity ? records.get(entity) : null);
    reportSelection(entity ? records.get(entity) : null);
    if (entity) {
      const record = records.get(entity);
      // One flight, never a tracked entity: pan, orbit and zoom stay with the user afterwards.
      focusMapPoints(viewer, [entity.position.getValue(viewer.clock.currentTime)], '.structure-details',
        { ...INSPECTION_FRAMING, headingDeg: inspectionHeading(record) });
    }
    viewer.scene.requestRender();
  }

  function hover(entity, position) {
    const previous = hovered;
    hovered = entity;
    style(previous); style(hovered);
    panel.hover(entity ? records.get(entity) : null, position);
    if (entity) viewer.canvas.style.cursor = 'pointer';
  }

  function sync() {
    for (const layer of layers.values()) {
      const total = layer.rows.size;
      let visible = 0;
      for (const [id, input] of layer.rows) {
        const entity = layer.entities.get(id);
        // Before a layer has ever been shown it has rows but no markers, and nothing is visible.
        input.checked = entity ? entity.show : false;
        if (entity?.show) visible++;
      }
      layer.parent.checked = total > 0 && visible === total;
      layer.parent.indeterminate = visible > 0 && visible < total;
      layer.source.show = visible > 0;
      if (total) layer.status.textContent = `${visible} of ${total} ${layer.type.groupLabel.toLowerCase()} structures visible`;
    }
    if (selected && !selected.show) select(null);
    if (hovered && !hovered.show) { hover(null); viewer.canvas.style.cursor = ''; }
    viewer.scene.requestRender();
  }

  /** Entities and explorer rows, built once from the service's cached records. */
  function build(layer) {
    layer.built ??= (async () => {
      layer.retry.hidden = true;
      layer.status.textContent = `Loading ${layer.type.groupLabel.toLowerCase()} structures…`;
      const { records: loaded, skipped, featureCount } = await service.load(layer.type);
      if (disposed) return;
      layer.records = loaded;
      logger.debug?.('[Sign Structures]', {
        type: layer.type.structureType, loaded: loaded.length, inFile: featureCount, skipped: skipped.length,
      });
      for (const record of [...loaded].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))) {
        const row = document.createElement('div'); row.className = 'segment-row';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', record.id); checkbox.dataset.structureId = record.id;
        const button = document.createElement('button');
        button.className = 'segment-select'; button.textContent = signStructureLabel(record);
        button.dataset.structureId = record.id;
        // A row can be clicked before the layer has ever been shown, so both paths make the markers
        // first and then act on them.
        checkbox.onchange = async () => {
          await materialise(layer);
          const entity = layer.entities.get(record.id);
          if (entity) entity.show = checkbox.checked;
          sync();
        };
        // Exactly the selection and flight a click on the marker gives.
        button.onclick = async () => {
          await materialise(layer);
          const entity = layer.entities.get(record.id);
          if (!entity) return;
          entity.show = true; sync(); select(entity);
        };
        row.append(checkbox, button); layer.list.append(row); layer.rows.set(record.id, checkbox);
      }
      layer.element.querySelector('.badge').textContent = String(loaded.length);
      // Nothing is drawn yet, so say what the layer holds rather than "0 of N visible".
      layer.status.textContent = `${loaded.length} ${layer.type.groupLabel.toLowerCase()} structures`;
    })().catch(error => {
      layer.built = null;
      if (disposed) return;
      layer.status.textContent = `${layer.type.groupLabel} structures could not load. Try again.`;
      layer.retry.hidden = false;
      logger.error?.('[Sign Structures] load failed', error);
      throw error;
    });
    return layer.built;
  }

  /**
   * Create this layer's markers, once. Deferred until a layer is first shown so the map is not
   * carrying a hundred hidden billboards just to display a count.
   */
  function materialise(layer) {
    layer.materialised ??= (async () => {
      await build(layer);
      if (disposed || layer.entities.size) return;
      for (const record of layer.records) {
        const entity = layer.source.entities.add({
          id: `${layer.type.id}-${record.id}`,
          name: record.id,
          position: Cartesian3.fromDegrees(record.longitude, record.latitude),
          // Everything the click handler needs, so selection never re-reads the GeoJSON.
          properties: {
            assetType: SIGN_STRUCTURE_ASSET_TYPE, structureType: record.structureType,
            id: record.id, fdotObjectId: record.fdotObjectId, hlid: record.hlid,
            milepost: record.milepost, roadwayId: record.roadwayId, lightCount: record.lightCount,
          },
          billboard: {
            ...structureMarker(record.id, false),
            verticalOrigin: VerticalOrigin.BOTTOM,
            // Stands on the road surface, and is never buried by the photogrammetry around it.
            heightReference: HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            // Readable close up without growing into the scene; small but present at corridor range.
            scaleByDistance: new NearFarScalar(250, 1, config.lod.overviewDistance, 0.4),
            distanceDisplayCondition: new DistanceDisplayCondition(0, config.lod.overviewDistance),
          },
        });
        entity.show = false;
        records.set(entity, record);
        layer.entities.set(record.id, entity);
      }
      viewer.scene.requestRender();
    })().catch(error => {
      layer.materialised = null;
      throw error;
    });
    return layer.materialised;
  }

  /** Commit a layer's visibility. Synchronous, so two callers cannot interleave mid-change. */
  function apply(layer, on) {
    for (const entity of layer.entities.values()) entity.show = on;
    layer.parent.checked = on;
    sync();
  }

  /**
   * Show or hide a whole type.
   *
   * Deliberately synchronous once the markers exist. The store drives layers by setting the
   * checkbox, awaiting its `onchange`, and then dispatching a second `change` event — so an async
   * handler can be re-entered with the intent of an earlier click still in flight, and the last
   * continuation to resolve wins. Awaiting only on the first show removes that window.
   */
  function setVisible(typeId, on) {
    const layer = layers.get(typeId);
    if (!layer) return Promise.resolve();
    if (layer.entities.size) { apply(layer, on); return Promise.resolve(); }
    return materialise(layer).then(() => { if (!disposed) apply(layer, on); })
      .catch(() => { layer.parent.checked = false; });
  }

  for (const layer of layers.values()) {
    layer.parent.addEventListener('click', event => event.stopPropagation());
    layer.parent.onchange = () => setVisible(layer.type.id, layer.parent.checked);
    layer.retry.onclick = () => setVisible(layer.type.id, layer.parent.checked);
    // Read now, drawn only when asked: the count badge is a fact about the corridor, not a
    // consequence of having switched the layer on.
    void build(layer).then(() => { if (layer.type.enabled) return setVisible(layer.type.id, true); }).catch(() => {});
  }

  // Chained, as every other picking layer here is: the previous handler still runs.
  const handler = viewer.screenSpaceEventHandler;
  const oldMove = handler.getInputAction(ScreenSpaceEventType.MOUSE_MOVE);
  const oldClick = handler.getInputAction(ScreenSpaceEventType.LEFT_CLICK);
  const pick = position => {
    const entity = viewer.scene.pick(position)?.id;
    return records.has(entity) && entity.show ? entity : null;
  };
  handler.setInputAction(movement => { oldMove?.(movement); hover(pick(movement.endPosition), movement.endPosition); }, ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction(movement => {
    const entity = pick(movement.position);
    oldClick?.(movement);
    // Only claim the click when one of these markers was actually under it.
    if (entity) select(entity);
  }, ScreenSpaceEventType.LEFT_CLICK);
  const leave = () => { if (hovered) { hover(null); viewer.canvas.style.cursor = ''; } };
  viewer.canvas.addEventListener('mouseleave', leave);

  return {
    ready,
    setVisible,
    /** Count badge and tests: how many structures this type has built. */
    countFor: typeId => layers.get(typeId)?.records.length ?? 0,
    entityFor: (typeId, id) => layers.get(typeId)?.entities.get(id) ?? null,
    recordFor: entity => records.get(entity) ?? null,
    /** Every structure of one type, for the Asset Explorer's card list. */
    recordsFor: typeId => layers.get(typeId)?.records ?? [],
    /** Select one structure by type and id — its own panel and framing, driven from the explorer. */
    selectById(typeId, id) {
      const entity = id == null ? null : layers.get(typeId)?.entities.get(String(id));
      if (id != null && !entity) return false;
      select(entity ?? null);
      return true;
    },
    clearSelection() { select(null); },
    onSelection(callback) {
      // null clears every listener, which is what teardown wants.
      if (!callback) { selectionListeners.clear(); return () => {}; }
      selectionListeners.add(callback);
      return () => selectionListeners.delete(callback);
    },
    select,
    destroy() {
      disposed = true;
      viewer.canvas.removeEventListener('mouseleave', leave);
      for (const [event, action] of [[ScreenSpaceEventType.MOUSE_MOVE, oldMove], [ScreenSpaceEventType.LEFT_CLICK, oldClick]]) {
        if (action) handler.setInputAction(action, event); else handler.removeInputAction(event);
      }
      for (const layer of layers.values()) { viewer.dataSources.remove(layer.source, true); layer.element.remove(); }
      panel.destroy();
      layers.clear(); records.clear();
    },
  };
}
