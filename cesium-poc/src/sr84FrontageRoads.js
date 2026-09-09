import { GeoJsonDataSource, Color, ScreenSpaceEventType } from 'cesium';
import { FRONTAGE_DIRECTIONS, frontageFromProperties, frontageDetails, frontageName } from './sr84FrontageData.js';
import { createMapDetailsPanel } from './mapDetailsPanel.js';

/** Extends the current viewer and picking actions; no second viewer or independent event handler. */
export function installFrontageRoads(container, viewer) {
  container.innerHTML = `<details class="frontage-group"><summary><input id="frontage-all" type="checkbox" aria-label="Frontage Roads" disabled> Frontage Roads</summary>
    <div class="frontage-categories">${FRONTAGE_DIRECTIONS.map(item => `<label style="--road:${item.color}"><input id="${item.id}" type="checkbox" value="${item.direction}" disabled><span class="swatch"></span><span>${item.label}</span></label>`).join('')}</div>
    </details><p class="frontage-status ramp-status" role="status">Loading frontage roads…</p><button class="ramp-retry" hidden>Retry frontage loading</button>`;
  const group = container.querySelector('details'), parent = container.querySelector('#frontage-all');
  const children = [...container.querySelectorAll('.frontage-categories input')];
  const status = container.querySelector('.frontage-status'), retry = container.querySelector('button');
  const byDirection = new Map(FRONTAGE_DIRECTIONS.map(item => [item.direction, []]));
  const records = new Map();
  const colors = new Map(FRONTAGE_DIRECTIONS.map(item => [item.direction, Color.fromCssColorString(item.color).withAlpha(0.9)]));
  let source, loading, selected = null, hovered = null, disposed = false;
  const panel = createMapDetailsPanel({ title: 'Road details', className: 'road-details', details: frontageDetails, tooltipText: frontageName, onClose: () => select(null) });
  function style(entity) {
    if (!entity) return;
    const base = colors.get(records.get(entity).direction);
    entity.polyline.width = entity === selected ? 5 : entity === hovered ? 4 : 2.5;
    entity.polyline.material = entity === selected || entity === hovered ? Color.lerp(base, Color.WHITE, 0.4, new Color()) : base;
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
  function apply() {
    let visible = 0;
    for (const input of children) for (const entity of byDirection.get(input.value)) {
      entity.show = input.checked;
      if (entity.show) visible++;
    }
    const count = children.filter(input => input.checked).length;
    parent.checked = count === children.length;
    parent.indeterminate = count > 0 && count < children.length;
    if (selected && !selected.show) select(null);
    if (hovered && !hovered.show) { hover(null); viewer.canvas.style.cursor = ''; }
    status.textContent = `${count} of 2 frontage layers visible · ${visible} segments`;
    viewer.scene.requestRender();
  }
  parent.addEventListener('click', event => event.stopPropagation());
  parent.onchange = () => {
    children.forEach(input => { input.checked = parent.checked; });
    if (parent.checked) group.open = true;
    apply();
  };
  children.forEach(input => { input.onchange = apply; });

  // Chain the existing ramp actions so selecting one feature clears the other panel,
  // and ramp picking/filtering retains its original implementation.
  const handler = viewer.screenSpaceEventHandler;
  const oldMove = handler.getInputAction(ScreenSpaceEventType.MOUSE_MOVE);
  const oldClick = handler.getInputAction(ScreenSpaceEventType.LEFT_CLICK);
  function pick(position) {
    if (!source) return null;
    const entity = viewer.scene.pick(position)?.id;
    return records.has(entity) && entity.show ? entity : null;
  }
  handler.setInputAction(movement => {
    oldMove?.(movement);
    hover(pick(movement.endPosition), movement.endPosition);
  }, ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction(movement => {
    oldClick?.(movement);
    select(pick(movement.position));
  }, ScreenSpaceEventType.LEFT_CLICK);
  const leave = () => { if (hovered) { hover(null); viewer.canvas.style.cursor = ''; } };
  viewer.canvas.addEventListener('mouseleave', leave);
  const removeMove = viewer.camera.moveStart.addEventListener(leave);

  function load() {
    loading ??= (async () => {
      retry.hidden = true;
      status.textContent = 'Loading frontage roads…';
      const response = await fetch(`${import.meta.env.BASE_URL}data/sr84_frontage_roads.geojson`);
      if (!response.ok) throw new Error(`Frontage request failed: ${response.status}`);
      const data = await response.json();
      const ids = new Set();
      for (const feature of data.features) {
        const p = feature.properties;
        frontageFromProperties(p);
        const id = p['@id'] || p.osm_way_id || feature.id;
        if (!id || ids.has(id) || feature.geometry?.type !== 'LineString') throw new Error('Invalid frontage feature.');
        ids.add(id);
        feature.id = `sr84-frontage:${id}`;
      }
      // GeoJSON coordinates and original properties pass straight through to Cesium.
      const loaded = await GeoJsonDataSource.load(data, { clampToGround: true, strokeWidth: 2.5 });
      if (disposed) return;
      loaded.name = 'SR 84 Frontage Roads';
      for (const entity of loaded.entities.values) {
        const road = frontageFromProperties(entity.properties.getValue(viewer.clock.currentTime));
        entity.show = false;
        entity.name = frontageName(road);
        records.set(entity, road);
        byDirection.get(road.direction).push(entity);
        style(entity);
      }
      source = await viewer.dataSources.add(loaded);
      [parent, ...children].forEach(input => { input.disabled = false; });
      apply();
    })().catch(error => {
      loading = null;
      if (disposed) return;
      status.textContent = 'Frontage roads could not load. Try again.';
      retry.hidden = false;
      console.error(error);
    });
    return loading;
  }
  retry.onclick = load;
  load();
  return {
    destroy() {
      disposed = true;
      removeMove(); viewer.canvas.removeEventListener('mouseleave', leave);
      for (const [event, action] of [[ScreenSpaceEventType.MOUSE_MOVE, oldMove], [ScreenSpaceEventType.LEFT_CLICK, oldClick]]) {
        if (action) handler.setInputAction(action, event); else handler.removeInputAction(event);
      }
      if (source) viewer.dataSources.remove(source, true);
      panel.destroy(); container.replaceChildren(); records.clear(); byDirection.clear();
    },
  };
}
