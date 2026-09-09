import { CustomDataSource, Cartesian3, Color, HeightReference, NearFarScalar, ScreenSpaceEventType, VerticalOrigin } from 'cesium';
import { createMapDetailsPanel } from './mapDetailsPanel.js';
import { focusMapPoints } from './bridgeCamera.js';

// Compact vector traffic-light symbol, with a white outline for satellite imagery.
const icon = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="56" viewBox="0 0 32 56"><path d="M14 48h4v7h-4z" fill="#152030" stroke="white"/><rect x="5" y="1" width="22" height="48" rx="6" fill="#111820" stroke="white" stroke-width="2"/><circle cx="16" cy="11" r="6" fill="#f44336"/><circle cx="16" cy="25" r="6" fill="#ffda16"/><circle cx="16" cy="39" r="6" fill="#07934c"/></svg>')}`;
const valid = value => value != null && String(value).trim() !== '' && String(value).toUpperCase() !== 'N/A';
export function signalDetails(p) {
  return [['Type', p.signal_type], ['Cross Street', p.cross_street], ['FDOT Signal ID', p.signal_id],
    ['FDOT Roadway', p.roadway_id], ['FDOT Reference Post', valid(p.begin_post) ? Number(p.begin_post).toFixed(3) : null],
    ['Status', p.section_status], ['Effective Date', p.effective_date], ['County', p.county],
    ['District', p.district], ['Source', p.source]].filter(([, value]) => valid(value));
}
export function installTrafficSignals(container, viewer) {
  const group = document.createElement('details'); group.className = 'signals-group';
  group.innerHTML = '<summary><input type="checkbox" id="signals-all" aria-label="Traffic Signals" disabled><span>Traffic Signals</span><span class="badge">…</span></summary><button class="signal-zoom" disabled>Zoom to Layer</button><div class="signal-list"></div><p class="ramp-status" role="status">Loading traffic signals…</p><button class="signal-retry" hidden>Retry traffic signals</button>';
  container.append(group);
  const parent = group.querySelector('input'), list = group.querySelector('.signal-list'), status = group.querySelector('[role="status"]'), zoom = group.querySelector('.signal-zoom'), retry = group.querySelector('.signal-retry');
  const trafficSignalById = new Map(), records = new Map(), rows = new Map();
  const source = new CustomDataSource('I-595 Corridor Traffic Signals');
  let selected, hovered, disposed = false, loading;
  const panel = createMapDetailsPanel({ title: 'Traffic Signal Details', className: 'signal-details', details: signalDetails,
    tooltipText: p => [p.signal_type || 'Traffic Signal', valid(p.cross_street) ? `Cross Street\n${p.cross_street}` : null, valid(p.signal_id) ? `FDOT Signal ID\n${p.signal_id}` : null].filter(Boolean).join('\n'), onClose: () => select(null) });
  function style(entity) {
    if (!entity) return;
    entity.billboard.scale = entity === selected ? 1.25 : entity === hovered ? 1.12 : 1;
    entity.billboard.color = entity === selected ? Color.fromCssColorString('#fff0a6') : Color.WHITE;
  }
  function select(entity) {
    const old = selected; selected = entity; style(old); style(entity);
    panel.select(entity ? records.get(entity) : null);
    if (entity) focusMapPoints(viewer, [entity.position.getValue(viewer.clock.currentTime)]);
    else if (old) viewer.camera.cancelFlight();
    viewer.scene.requestRender();
  }
  function hover(entity, position) {
    const old = hovered; hovered = entity; style(old); style(entity);
    panel.hover(entity ? records.get(entity) : null, position);
    if (entity) viewer.canvas.style.cursor = 'pointer';
    else if (old) viewer.canvas.style.cursor = '';
    viewer.scene.requestRender();
  }
  function sync() {
    let count = 0;
    for (const [id, entity] of trafficSignalById) { rows.get(id).checked = entity.show; if (entity.show) count++; }
    parent.checked = count > 0 && count === trafficSignalById.size;
    parent.indeterminate = count > 0 && count < trafficSignalById.size;
    status.textContent = `${count} of ${trafficSignalById.size} traffic signals visible`;
    if (selected && !selected.show) select(null);
    if (hovered && !hovered.show) hover(null);
    viewer.scene.requestRender();
  }
  parent.onclick = event => event.stopPropagation();
  parent.onchange = () => { for (const entity of trafficSignalById.values()) entity.show = parent.checked; sync(); };
  zoom.onclick = () => {
    for (const entity of trafficSignalById.values()) entity.show = true;
    sync(); select(null);
    focusMapPoints(viewer, [...trafficSignalById.values()].map(e => e.position.getValue(viewer.clock.currentTime)));
  };
  const handler = viewer.screenSpaceEventHandler;
  const oldMove = handler.getInputAction(ScreenSpaceEventType.MOUSE_MOVE), oldClick = handler.getInputAction(ScreenSpaceEventType.LEFT_CLICK);
  const pick = position => { const entity = viewer.scene.pick(position)?.id; return records.has(entity) && entity.show ? entity : null; };
  handler.setInputAction(movement => { oldMove?.(movement); hover(pick(movement.endPosition), movement.endPosition); }, ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction(movement => { const entity = pick(movement.position); oldClick?.(movement); select(entity); }, ScreenSpaceEventType.LEFT_CLICK);
  const leave = () => hover(null);
  viewer.canvas.addEventListener('mouseleave', leave);
  const removeMove = viewer.camera.moveStart.addEventListener(leave);
  function load() {
    loading ??= (async () => {
      retry.hidden = true;
      const response = await fetch(`${import.meta.env.BASE_URL}data/i595_corridor_traffic_signals.geojson`);
      if (!response.ok) throw new Error(`Traffic signals request failed: ${response.status}`);
      const data = await response.json(), ids = new Set();
      for (const f of data.features) {
        if (!f.properties.asset_id || ids.has(f.properties.asset_id) || f.geometry?.type !== 'Point') throw new Error('Invalid signal identity or geometry');
        ids.add(f.properties.asset_id);
      }
      if (disposed) return;
      for (const f of data.features) {
        const p = f.properties;
        const entity = source.entities.add({ id: p.asset_id, name: p.cross_street || p.signal_type, show: false,
          position: Cartesian3.fromDegrees(...f.geometry.coordinates), properties: p,
          billboard: { image: icon, width: 26, height: 46, verticalOrigin: VerticalOrigin.BOTTOM,
            heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new NearFarScalar(500, 1, 25000, 0.5) } });
        trafficSignalById.set(p.asset_id, entity); records.set(entity, p);
        const row = document.createElement('div'); row.className = 'segment-row';
        const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.signalId = p.asset_id;
        const label = `${p.cross_street || p.signal_type} · ${valid(p.signal_id) ? p.signal_id : p.roadway_id}`;
        input.setAttribute('aria-label', label);
        const button = document.createElement('button'); button.className = 'segment-select'; button.textContent = label; button.dataset.signalId = p.asset_id;
        input.onchange = () => { entity.show = input.checked; sync(); };
        button.onclick = () => { entity.show = true; sync(); select(entity); };
        rows.set(p.asset_id, input); row.append(input, button); list.append(row);
      }
      await viewer.dataSources.add(source);
      if (disposed) { viewer.dataSources.remove(source, true); return; }
      group.querySelector('.badge').textContent = String(trafficSignalById.size);
      parent.disabled = false; zoom.disabled = false; sync();
    })().catch(error => { loading = null; if (!disposed) { status.textContent = 'Traffic signals could not load.'; retry.hidden = false; console.error(error); } });
    return loading;
  }
  retry.onclick = load; load();
  return { trafficSignalById, destroy() {
    disposed = true; removeMove(); viewer.canvas.removeEventListener('mouseleave', leave);
    for (const [event, action] of [[ScreenSpaceEventType.MOUSE_MOVE, oldMove], [ScreenSpaceEventType.LEFT_CLICK, oldClick]]) {
      if (action) handler.setInputAction(action, event); else handler.removeInputAction(event);
    }
    viewer.dataSources.remove(source, true); panel.destroy(); group.remove();
  } };
}
