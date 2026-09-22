import { CustomDataSource, Cartesian3, HeightReference, NearFarScalar, ScreenSpaceEventType, VerticalOrigin } from 'cesium';
import { assetDotMarker, assetIdMarker } from './assetIdMarker.js';
import { LIGHTING_CATEGORIES, lightingRecords } from './lightingData.js';

/**
 * How many lighting assets carry their ID marker at once, and how close they must be.
 *
 * Each ID marker is its own texture. Cameras can afford one per asset (47 of them); 2,895 lighting
 * assets cannot — measured, every marker drawn at once took the scene from ~57 to under 10 fps and
 * added ~370 MB. So every asset is always drawn as the marker's own location dot (one shared
 * texture), and only the nearest ones plus the selection carry the camera-style ID marker.
 *
 * One billboard per entity, whose image is swapped. A separate point graphic will not do: Cesium
 * draws a ground-clamped point as a billboard in the same per-entity cluster slot, so a point and a
 * billboard on one entity overwrite each other and the ID marker never appears.
 */
export const LABEL_BUDGET = 150;
export const LABEL_RANGE_M = 2500;

const BILLBOARD = Object.freeze({
  verticalOrigin: VerticalOrigin.BOTTOM, heightReference: HeightReference.CLAMP_TO_GROUND,
  disableDepthTestDistance: Number.POSITIVE_INFINITY, scaleByDistance: new NearFarScalar(400, 1, 12000, 0.7),
});

/** DataConnect's committed export: every lighting asset, split into its six source categories. */
export function installLighting(container, viewer) {
  const group = document.createElement('details');
  group.className = 'cameras-group lighting-group';
  group.innerHTML = '<summary>Lighting · DataConnect</summary><div class="lighting-controls"></div><p role="status" class="ramp-status">DataConnect asset inventory snapshot</p><button type="button" class="camera-retry" hidden>Retry lighting</button>';
  container.append(group);
  const status = group.querySelector('[role="status"]'), retry = group.querySelector('button');
  const inputs = new Map(), entities = new Map(), listeners = new Set(), counts = new Map();
  const source = new CustomDataSource('DataConnect Lighting');
  const added = viewer.dataSources.add(source);
  let records = [], selected = null, pending = null, loaded = false, error = null, disposed = false;
  /** Ids currently promoted to an ID marker by distance (the selection is handled separately). */
  let labelled = new Set();
  const abort = new AbortController();

  /** What each asset currently draws — 'dot', 'id' or 'selected' — so unchanged ones are left alone. */
  const drawn = new Map();
  function present(id) {
    const entity = entities.get(id);
    if (!entity) return;
    const state = id === selected ? 'selected' : labelled.has(id) ? 'id' : 'dot';
    if (drawn.get(id) === state) return;
    drawn.set(id, state);
    const marker = state === 'dot' ? assetDotMarker() : assetIdMarker({ id, selected: state === 'selected' });
    entity.billboard.image = marker.image;
    entity.billboard.width = marker.width; entity.billboard.height = marker.height;
    entity.billboard.scale = state === 'selected' ? 1.08 : 1;
  }

  function highlight(id) {
    const old = selected;
    selected = id == null || !entities.has(String(id)) ? null : String(id);
    if (old === selected) return;
    present(old); present(selected);
    viewer.scene.requestRender();
  }

  /** Promote the nearest visible assets to ID markers. Cheap: distances only, no entity churn. */
  function updateLabels() {
    if (!loaded || disposed) return;
    const eye = viewer.camera.positionWC;
    const near = [];
    for (const record of records) {
      if (!entities.get(record.id).show) continue;
      const distance = Cartesian3.distance(eye, record.position);
      if (distance <= LABEL_RANGE_M) near.push([distance, record.id]);
    }
    near.sort((a, b) => a[0] - b[0]);
    const next = new Set(near.slice(0, LABEL_BUDGET).map(([, id]) => id));
    const changed = [...labelled].filter(id => !next.has(id)).concat([...next].filter(id => !labelled.has(id)));
    if (!changed.length) return;
    labelled = next;
    for (const id of changed) present(id);
    viewer.scene.requestRender();
  }
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(updateLabels);
  const removeChanged = viewer.camera.changed.addEventListener(updateLabels);

  function sync() {
    for (const record of records) entities.get(record.id).show = inputs.get(record.categoryId).checked;
    if (selected && !entities.get(selected)?.show) {
      highlight(null); for (const fn of listeners) fn(null);
    }
    updateLabels();
    viewer.scene.requestRender();
  }
  function load() {
    if (loaded) return Promise.resolve();
    if (pending) return pending;
    error = null; status.textContent = 'Loading lighting assets…'; retry.hidden = true;
    pending = (async () => {
      const response = await fetch(`${import.meta.env.BASE_URL}dataconnect-data/asset_registry.json`, { signal: abort.signal });
      if (!response.ok) throw new Error(`Lighting request failed (${response.status})`);
      const next = lightingRecords(await response.json())
        .map(record => ({ ...record, position: Cartesian3.fromDegrees(record.longitude, record.latitude) }));
      await added;
      if (disposed) return;
      source.entities.suspendEvents();
      try {
        for (const record of next) {
          entities.set(record.id, source.entities.add({ id: `lighting-${record.id}`, name: `Lighting ${record.id}`, show: false,
            position: record.position, billboard: { ...BILLBOARD, ...assetDotMarker() } }));
          drawn.set(record.id, 'dot');
        }
      } finally { source.entities.resumeEvents(); }
      records = next; loaded = true;
      counts.clear();
      for (const record of records) counts.set(record.categoryId, (counts.get(record.categoryId) ?? 0) + 1);
      status.textContent = `${records.length.toLocaleString()} lighting assets · DataConnect snapshot`;
      sync();
    })().catch(reason => {
      if (disposed || reason?.name === 'AbortError') return;
      source.entities.removeAll(); entities.clear(); drawn.clear(); records = [];
      error = reason; status.textContent = 'Lighting could not load. Retry to load the inventory.'; retry.hidden = false;
      console.error(reason);
    }).finally(() => { pending = null; });
    return pending;
  }
  for (const category of LIGHTING_CATEGORIES) {
    const label = document.createElement('label');
    const input = document.createElement('input'); input.type = 'checkbox'; input.id = `${category.id}-toggle`;
    input.setAttribute('aria-label', category.label); inputs.set(category.id, input);
    label.append(input, document.createTextNode(category.label)); group.querySelector('.lighting-controls').append(label);
    input.onchange = async () => { if (input.checked) await load(); if (!disposed) sync(); };
  }
  retry.onclick = async () => {
    await load(); if (!disposed) inputs.values().next().value.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // Chained into the viewer's shared handler, as the camera layer is, and a lighting hit is NOT
  // passed on: the bridge and signal handlers further down the chain report "nothing selected" for
  // any click that is not theirs, which wiped the lighting pick the moment it was made.
  const handler = viewer.screenSpaceEventHandler;
  const oldClick = handler.getInputAction(ScreenSpaceEventType.LEFT_CLICK);
  handler.setInputAction(event => {
    const entity = viewer.scene.pick(event.position)?.id;
    const id = typeof entity?.id === 'string' && entity.id.startsWith('lighting-') ? entity.id.slice('lighting-'.length) : null;
    if (!id || !entity.show || entities.get(id) !== entity) { oldClick?.(event); return; }
    highlight(id); for (const fn of listeners) fn(id);
  }, ScreenSpaceEventType.LEFT_CLICK);

  // Loaded up front, like the camera layer, so the Map Explorer can show real per-category counts
  // before anything is switched on. Entities start hidden; nothing is drawn until a category is.
  void load();

  return {
    get error() { return error; },
    get loading() { return !!pending; },
    visibleRecords: () => records.filter(record => inputs.get(record.categoryId).checked),
    allRecords: () => records,
    /** Source counts, or null until the inventory has loaded — never a misleading 0. */
    countFor: id => (!loaded ? null : id === 'lighting' ? records.length : counts.get(id) ?? 0),
    highlightById: highlight,
    onSelection(fn) { if (!fn) listeners.clear(); else listeners.add(fn); },
    destroy() {
      disposed = true; abort.abort(); removeMoveEnd(); removeChanged(); listeners.clear();
      if (oldClick) handler.setInputAction(oldClick, ScreenSpaceEventType.LEFT_CLICK); else handler.removeInputAction(ScreenSpaceEventType.LEFT_CLICK);
      group.remove(); void added.then(() => viewer.dataSources.remove(source, true));
    },
  };
}
