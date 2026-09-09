/**
 * 595 Express managed lanes — the same load/style/pick/details treatment the mainline, ramps and
 * frontage roads already have, so the corridor's third roadway is not the one layer on the map that
 * stays silent on hover and click.
 *
 * Reuses the existing viewer, its screen-space handler chain and the shared details panel; the
 * geometry in express-way.geojson is loaded and drawn unchanged.
 */
import { GeoJsonDataSource, Color, ScreenSpaceEventType } from 'cesium';
import { createMapDetailsPanel } from './mapDetailsPanel.js';
import { EXPRESS_COLOR, expressDetails, expressFromProperties, expressName, expressTooltip } from './i595ExpressData.js';

/**
 * @param {import('cesium').Viewer} viewer
 * @param {HTMLInputElement} input  the existing "595 Express" checkbox in the layer tree
 * @param {{onVisibilityChange?: () => void, onStatus?: (message: string) => void}} [hooks]
 */
export function installI595ExpressLanes(viewer, input, { onVisibilityChange, onStatus } = {}) {
  const records = new Map();
  const base = Color.fromCssColorString(EXPRESS_COLOR);
  let source, loading, disposed = false, selected = null, hovered = null;
  const panel = createMapDetailsPanel({
    title: 'Express Lane Details', className: 'express-details',
    details: expressDetails, tooltipText: expressTooltip, onClose: () => select(null),
  });
  function style(entity) {
    if (!entity) return;
    entity.polyline.width = entity === selected ? 9 : entity === hovered ? 8 : 6;
    entity.polyline.material = entity === selected || entity === hovered ? Color.lerp(base, Color.WHITE, 0.45, new Color()) : base;
  }
  function select(entity) {
    const previous = selected; selected = entity; style(previous); style(selected);
    panel.select(entity ? records.get(entity) : null);
    viewer.scene.requestRender();
  }
  function hover(entity, position) {
    const previous = hovered; hovered = entity; style(previous); style(hovered);
    panel.hover(entity ? records.get(entity) : null, position);
    if (entity) viewer.canvas.style.cursor = 'pointer';
  }
  // Delegate the existing actions first, then apply this layer's own topmost pick — the same
  // chaining every other corridor layer uses, so no layer's picking is displaced.
  const handler = viewer.screenSpaceEventHandler;
  const oldMove = handler.getInputAction(ScreenSpaceEventType.MOUSE_MOVE);
  const oldClick = handler.getInputAction(ScreenSpaceEventType.LEFT_CLICK);
  const pick = position => {
    if (!source) return null;
    const entity = viewer.scene.pick(position)?.id;
    return records.has(entity) && entity.show ? entity : null;
  };
  handler.setInputAction(movement => { oldMove?.(movement); hover(pick(movement.endPosition), movement.endPosition); }, ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction(movement => { const entity = pick(movement.position); oldClick?.(movement); select(entity); }, ScreenSpaceEventType.LEFT_CLICK);
  const leave = () => { if (hovered) { hover(null); viewer.canvas.style.cursor = ''; } };
  viewer.canvas.addEventListener('mouseleave', leave);
  const removeMove = viewer.camera.moveStart.addEventListener(leave);

  function load() {
    loading ??= (async () => {
      const loaded = await GeoJsonDataSource.load(`${import.meta.env.BASE_URL}data/express-way.geojson`, {
        stroke: base, strokeWidth: 6, clampToGround: true,
      });
      if (disposed) return;
      loaded.name = '595 Express';
      for (const entity of loaded.entities.values) {
        const lanes = expressFromProperties(entity.properties.getValue(viewer.clock.currentTime));
        entity.name = expressName();
        entity.show = false;
        records.set(entity, lanes);
        style(entity);
      }
      source = await viewer.dataSources.add(loaded);
      return source;
    })().catch(error => { loading = null; throw error; });
    return loading;
  }

  function apply() {
    for (const entity of records.keys()) entity.show = input.checked;
    if (selected && !selected.show) select(null);
    if (hovered && !hovered.show) { hover(null); viewer.canvas.style.cursor = ''; }
    onVisibilityChange?.();
    viewer.scene.requestRender();
  }

  input.disabled = false;
  input.onchange = async () => {
    try {
      if (input.checked) { onStatus?.('Loading road geometry…'); await load(); }
      if (disposed) return;
      apply();
    } catch (error) {
      input.checked = false;
      onStatus?.('Unable to load this road. Check your connection and select it to retry.');
      console.error(error);
    }
  };

  return {
    records, load,
    async setVisible(show) { input.checked = show; await input.onchange(); },
    clearSelection() { select(null); },
    destroy() {
      disposed = true;
      removeMove(); viewer.canvas.removeEventListener('mouseleave', leave);
      for (const [event, action] of [[ScreenSpaceEventType.MOUSE_MOVE, oldMove], [ScreenSpaceEventType.LEFT_CLICK, oldClick]]) {
        if (action) handler.setInputAction(action, event); else handler.removeInputAction(event);
      }
      if (source) viewer.dataSources.remove(source, true);
      panel.destroy(); records.clear();
    },
  };
}
