/**
 * The GLB models as corridor layers — toll gantries and lane barriers.
 *
 * Two layers, never one: a barrier arm is a different kind of asset from an overhead gantry, so it
 * gets its own control, its own pin and its own place on the quick rail.
 *
 * Structure follows the bridge layer: a checkbox group per layer with a row per asset, map pins for
 * finding them from a distance, and a click — on a pin, on the mesh or on a row — that selects the
 * asset and flies the camera to it. Which models exist, and which layer each belongs to, is read
 * from config/cesiumModels.json; nothing here names an individual asset.
 */
import { ScreenSpaceEventType } from 'cesium';
import { createMapDetailsPanel } from './mapDetailsPanel.js';
import { focusMapPoints } from './bridgeCamera.js';
import { installCorridorModelMarkers } from './corridorModelMarkers.js';

/** The layers model records may belong to. A record's `layer` decides which control owns it. */
export const MODEL_LAYERS = Object.freeze([
  // `viewOffsetDeg` turns the focus camera from the model's own heading to the side worth looking
  // at. A gantry's signage faces along its mesh's +Z, which is 90° from its heading, so the camera
  // stands opposite that face: heading + 90 + 180. A barrier is read across its boom instead, from
  // the direction traffic approaches: heading + 180.
  Object.freeze({
    id: 'gantries', label: 'Toll Gantries', control: 'gantries-all', title: 'Gantry Details',
    viewOffsetDeg: 270, framing: Object.freeze({ pitchDeg: -14, minimumHeight: 28 }),
  }),
  Object.freeze({
    id: 'lane-barriers', label: 'Lane Barriers', control: 'barriers-all', title: 'Lane Barrier Details',
    // A barrier arm is a third the size of a gantry, so it wants a closer view — but a shallow one
    // puts the camera at deck level, where roadside sign structures in the photogrammetry stand
    // between it and the asset. Steeper instead: close, and looking over them.
    viewOffsetDeg: 180, framing: Object.freeze({ pitchDeg: -25, minimumHeight: 35 }),
  }),
]);

/** Low and close: a structure that spans the road is read from its face, not from above it. */
const DEFAULT_FRAMING = Object.freeze({ pitchDeg: -16, minimumHeight: 40 });

/**
 * The compass bearing the focus camera should look along for this asset. Derived from the record's
 * own heading so a new model needs nothing extra, and overridable per record with `viewHeading`
 * for a gantry whose signs hang on the other face.
 */
export function focusHeadingFor(config, layers = MODEL_LAYERS) {
  if (Number.isFinite(config?.viewHeading)) return ((config.viewHeading % 360) + 360) % 360;
  const offset = layers.find(layer => layer.id === config?.layer)?.viewOffsetDeg ?? 0;
  return (((config?.heading ?? 0) + offset) % 360 + 360) % 360;
}

/** Panel rows, from the record itself — nothing derived, nothing invented. */
export function modelDetails(config) {
  return [
    ['Asset ID', config.id],
    ['Type', MODEL_LAYERS.find(layer => layer.id === config.layer)?.label ?? config.type],
    ['Location', `${config.latitude.toFixed(6)}, ${config.longitude.toFixed(6)}`],
    ['Heading', `${config.heading ?? 0}°`],
    ['Model', (config.modelKey ?? config.modelUrl ?? '').split('/').pop() || '—'],
  ];
}

/**
 * @param {HTMLElement} container  the existing Infrastructure group
 * @param {import('cesium').Viewer} viewer
 * @param {ReturnType<import('./cesiumModelService.js').createCesiumModelService>} service
 * @param {object[]} configs  the records from config/cesiumModels.json
 */
export function installCorridorModelLayers(container, viewer, service, configs) {
  // ---- Asset Explorer handover -----------------------------------------------------------------
  // While the Asset Explorer is browsing this type it owns selection: the panel and the camera move
  // below belong to the standalone behaviour, and running them too would put two details panels on
  // screen and fly the camera on every Next. The layer still highlights, and still reports what the
  // user picked, so one shared selection stays in charge.
  let externallyOwned = false;
  /**
   * Report selections to every listener, not one.
   *
   * A single module backs several asset types (gantries and lane barriers here; three structure
   * types elsewhere), and each registers its own listener. Holding one callback meant the last
   * registration silently replaced the others, so picks for every other type vanished.
   */
  const selectionListeners = new Set();
  const reportSelection = record => { for (const listener of [...selectionListeners]) listener(record); };

  const records = new Map();          // entity  -> config
  const entityById = new Map();       // model id -> entity
  const layerOf = new Map();          // entity  -> layer id
  const groups = new Map();           // layer id -> { parent, rows, status, configs }
  let markers = null, selected = null, hovered = null, disposed = false;

  const panel = createMapDetailsPanel({
    title: 'Asset Details', className: 'model-details',
    details: modelDetails,
    tooltipText: config => `${MODEL_LAYERS.find(layer => layer.id === config.layer)?.label ?? 'Model'}\n${config.name}`,
    onClose: () => select(null),
  });

  for (const layer of MODEL_LAYERS) {
    const owned = configs.filter(config => config.layer === layer.id && config.enabled !== false);
    if (!owned.length) continue;
    const group = document.createElement('details');
    group.className = `model-group ${layer.id}-group`;
    group.innerHTML = `<summary><input type="checkbox" id="${layer.control}" aria-label="${layer.label}" disabled><span>${layer.label}</span><span class="badge">${owned.length}</span></summary>
      <div class="model-list"></div><p class="ramp-status" role="status">Loading ${layer.label.toLowerCase()}…</p>`;
    container.append(group);
    groups.set(layer.id, {
      layer, group, configs: owned,
      parent: group.querySelector('input'),
      list: group.querySelector('.model-list'),
      status: group.querySelector('[role="status"]'),
      rows: new Map(),
    });
  }

  function positionOf(entity) {
    const value = entity.position?.getValue(viewer.clock.currentTime);
    return value ? [value] : [];
  }

  function style() {
    markers?.setSelected(selected);
  }

  function select(entity) {
    selected = entity;
    style();
    if (externallyOwned) {
      // Highlight only. The Asset Explorer opens its own panel and decides what the camera does.
      panel.select(null);
      viewer.scene.requestRender();
      reportSelection(entity ? records.get(entity) : null);
      return;
    }
    panel.select(entity ? records.get(entity) : null);
    if (entity) {
      const config = records.get(entity);
      const framing = MODEL_LAYERS.find(layer => layer.id === config.layer)?.framing ?? DEFAULT_FRAMING;
      focusMapPoints(viewer, positionOf(entity), '.model-details', { ...framing, headingDeg: focusHeadingFor(config) });
    }
    viewer.scene.requestRender();
    reportSelection(entity ? records.get(entity) : null);
  }

  /** Highlight by model id without opening a panel or moving the camera. */
  function highlightById(id) {
    const entity = id == null ? null : entityById.get(String(id));
    selected = entity;
    style();
    viewer.scene.requestRender();
    return Boolean(entity) || id == null;
  }

  function hover(entity, position) {
    hovered = entity;
    panel.hover(entity ? records.get(entity) : null, position);
    if (entity) viewer.canvas.style.cursor = 'pointer';
  }

  function sync() {
    for (const state of groups.values()) {
      let visible = 0;
      for (const [id, input] of state.rows) {
        const entity = entityById.get(id);
        if (!entity) continue;
        input.checked = entity.show;
        if (entity.show) visible++;
      }
      state.parent.checked = visible === state.rows.size && visible > 0;
      state.parent.indeterminate = visible > 0 && visible < state.rows.size;
      state.status.textContent = `${visible} of ${state.rows.size} ${state.layer.label.toLowerCase()} visible`;
    }
    if (selected && !selected.show) select(null);
    if (hovered && !hovered.show) { hover(null); viewer.canvas.style.cursor = ''; }
    viewer.scene.requestRender();
  }

  for (const state of groups.values()) {
    state.parent.addEventListener('click', event => event.stopPropagation());
    state.parent.onchange = () => {
      for (const id of state.rows.keys()) {
        const entity = entityById.get(id);
        if (entity) entity.show = state.parent.checked;
      }
      sync();
    };
  }

  // Chained, exactly as the bridge, camera and signal layers do it: the previous handler still runs,
  // so no existing picking behaviour is displaced.
  const handler = viewer.screenSpaceEventHandler;
  const oldMove = handler.getInputAction(ScreenSpaceEventType.MOUSE_MOVE);
  const oldClick = handler.getInputAction(ScreenSpaceEventType.LEFT_CLICK);
  const pick = position => {
    const entity = viewer.scene.pick(position)?.id;
    return records.has(entity) && entity.show ? entity : null;
  };
  handler.setInputAction(movement => {
    oldMove?.(movement);
    hover(pick(movement.endPosition), movement.endPosition);
  }, ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction(movement => {
    const entity = pick(movement.position);
    oldClick?.(movement);
    // Only claim the click when one of these assets was actually under it.
    if (entity) select(entity);
  }, ScreenSpaceEventType.LEFT_CLICK);
  const leave = () => { if (hovered) { hover(null); viewer.canvas.style.cursor = ''; } };
  viewer.canvas.addEventListener('mouseleave', leave);

  /** Place the models, then light up the controls. Called once the world they sit on is drawn. */
  async function place() {
    const entities = await service.loadModels(configs);
    if (disposed) return [];
    const placed = [];
    for (const entity of entities) {
      const config = configs.find(record => record.id === entity.id);
      if (!config) continue;
      records.set(entity, config);
      entityById.set(config.id, entity);
      layerOf.set(entity, config.layer);
      placed.push({ entity, layer: config.layer });
    }
    // The map opens clean: like every other data layer here, these start switched off and the user
    // turns them on from the rail. The service places a model shown, so visibility is set once here
    // rather than the service guessing at layer policy.
    for (const { entity } of placed) entity.show = false;
    markers = installCorridorModelMarkers(viewer, placed);
    for (const state of groups.values()) {
      for (const config of state.configs) {
        const entity = entityById.get(config.id);
        if (!entity) continue;
        const row = document.createElement('div'); row.className = 'segment-row';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', config.name); checkbox.dataset.modelId = config.id;
        const button = document.createElement('button');
        button.className = 'segment-select'; button.textContent = config.name; button.dataset.modelId = config.id;
        checkbox.onchange = () => { entity.show = checkbox.checked; sync(); };
        button.onclick = () => { entity.show = true; sync(); select(entity); };
        row.append(checkbox, button); state.list.append(row); state.rows.set(config.id, checkbox);
      }
      state.group.querySelector('.badge').textContent = String(state.rows.size);
      state.parent.disabled = state.rows.size === 0;
    }
    sync();
    return entities;
  }

  return {
    records,
    highlightById,
    setExternallyOwned(owned) { externallyOwned = Boolean(owned); },
    onSelection(callback) {
      // null clears every listener, which is what teardown wants.
      if (!callback) { selectionListeners.clear(); return () => {}; }
      selectionListeners.add(callback);
      return () => selectionListeners.delete(callback);
    },
    place,
    entityById,
    /** Test/diagnostic hook: how many assets each layer owns. */
    countFor: layerId => groups.get(layerId)?.rows.size ?? 0,
    select,
    destroy() {
      disposed = true;
      viewer.canvas.removeEventListener('mouseleave', leave);
      markers?.destroy();
      for (const [event, action] of [[ScreenSpaceEventType.MOUSE_MOVE, oldMove], [ScreenSpaceEventType.LEFT_CLICK, oldClick]]) {
        if (action) handler.setInputAction(action, event); else handler.removeInputAction(event);
      }
      panel.destroy();
      for (const state of groups.values()) state.group.remove();
      groups.clear(); records.clear(); entityById.clear();
    },
  };
}
