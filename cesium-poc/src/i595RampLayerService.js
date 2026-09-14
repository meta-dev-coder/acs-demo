import { GeoJsonDataSource, Color, ScreenSpaceEventType } from 'cesium';
import { RAMP_CATEGORIES, rampFromProperties, matchesRamp } from './i595RampData.js';

export const RAMP_INTERACTION_HEIGHT = 12000;

/** One source, stable entity references and property indexes for the lifetime of this viewer. */
export function createI595RampLayerService(viewer, { onSelect, onHover, onChange }) {
  let source, loading, selected = null, hovered = null, near = false, disposed = false;
  let enabledTypes = new Set(), interchange = '';
  const byType = new Map(RAMP_CATEGORIES.map(category => [category.type, []]));
  const byInterchange = new Map();
  /** @type {Map<import('cesium').Entity, import('./i595RampData.js').I595Ramp>} */
  const records = new Map();
  const colors = new Map(RAMP_CATEGORIES.map(category => [category.type, Color.fromCssColorString(category.color)]));
  const restyle = entity => {
    if (!entity) return;
    const base = colors.get(records.get(entity).rampType);
    entity.polyline.width = entity === selected ? 6 : entity === hovered ? 5 : near ? 3 : 2;
    entity.polyline.material = entity === selected || entity === hovered ? Color.lerp(base, Color.WHITE, 0.5, new Color()) : base;
  };
  function hover(entity, position) {
    const previous = hovered; hovered = entity; restyle(previous); restyle(hovered);
    viewer.canvas.style.cursor = entity ? 'pointer' : '';
    onHover(entity ? records.get(entity) : null, position);
  }
  function select(entity) {
    const previous = selected; selected = entity; restyle(previous); restyle(selected);
    onSelect(entity ? records.get(entity) : null);
    viewer.scene.requestRender();
  }
  function applyFilters() {
    let visible = 0;
    for (const [type, entities] of byType) {
      for (const entity of entities) {
        entity.show = enabledTypes.has(type) && matchesRamp(records.get(entity), enabledTypes, interchange);
        if (entity.show) visible++;
      }
    }
    if (selected && !selected.show) select(null);
    if (hovered && !hovered.show) hover(null);
    onChange({ total: records.size, visible, near });
    viewer.scene.requestRender();
  }
  const handler = viewer.screenSpaceEventHandler;
  const oldMove = handler.getInputAction(ScreenSpaceEventType.MOUSE_MOVE);
  const oldClick = handler.getInputAction(ScreenSpaceEventType.LEFT_CLICK);
  function pick(position) {
    if (!near || !source) return null;
    const entity = viewer.scene.pick(position)?.id;
    return records.has(entity) && entity.show ? entity : null;
  }
  handler.setInputAction(movement => hover(pick(movement.endPosition), movement.endPosition), ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction(movement => select(pick(movement.position)), ScreenSpaceEventType.LEFT_CLICK);
  const leave = () => hover(null);
  viewer.canvas.addEventListener('mouseleave', leave);
  const removeMoveStart = viewer.camera.moveStart.addEventListener(leave);
  const removeRender = viewer.scene.postRender.addEventListener(() => {
    const next = viewer.camera.positionCartographic.height < RAMP_INTERACTION_HEIGHT;
    if (near === next) return;
    near = next;
    if (!near) hover(null);
    for (const entity of records.keys()) restyle(entity);
    onChange({ total: records.size, visible: [...records.keys()].filter(entity => entity.show).length, near });
  });
  return {
    byType, byInterchange, records,
    load() {
      loading ??= (async () => {
        const response = await fetch(`${import.meta.env.BASE_URL}data/i595_ramps_connectors_classified.geojson`);
        if (!response.ok) throw new Error(`Ramp data request failed: ${response.status}`);
        const data = await response.json();
        const ids = new Set();
        // Preserve every coordinate and source property; assign IDs from OSM, never array order.
        for (const feature of data.features) {
          const ramp = rampFromProperties(feature.properties);
          if (ids.has(ramp.id) || feature.geometry?.type !== 'LineString') throw new Error('Invalid or duplicate ramp feature.');
          ids.add(ramp.id);
          feature.id = `i595-ramp:${ramp.id}`;
        }
        const loaded = await GeoJsonDataSource.load(data, { clampToGround: true, strokeWidth: 3 });
        if (disposed) return;
        loaded.name = 'I-595 Ramps & Connectors';
        for (const entity of loaded.entities.values) {
          const ramp = rampFromProperties(entity.properties.getValue(viewer.clock.currentTime));
          entity.show = false;
          records.set(entity, ramp);
          byType.get(ramp.rampType).push(entity);
          if (!byInterchange.has(ramp.interchange)) byInterchange.set(ramp.interchange, []);
          byInterchange.get(ramp.interchange).push(entity);
          restyle(entity);
        }
        source = await viewer.dataSources.add(loaded);
        applyFilters();
        return source;
      })().catch(error => { loading = null; throw error; });
      return loading;
    },
    setFilters(types, value) { enabledTypes = new Set(types); interchange = value; applyFilters(); },
    clearSelection() { select(null); },
    destroy() {
      disposed = true;
      removeRender(); removeMoveStart();
      viewer.canvas.removeEventListener('mouseleave', leave);
      for (const [event, action] of [[ScreenSpaceEventType.MOUSE_MOVE, oldMove], [ScreenSpaceEventType.LEFT_CLICK, oldClick]]) {
        if (action) handler.setInputAction(action, event); else handler.removeInputAction(event);
      }
      if (source) viewer.dataSources.remove(source, true);
      records.clear(); byType.clear(); byInterchange.clear();
      viewer.canvas.style.cursor = '';
    },
  };
}
