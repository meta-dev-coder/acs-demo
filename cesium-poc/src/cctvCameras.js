import { CustomDataSource, Cartesian3, Color, DistanceDisplayCondition, HeightReference, NearFarScalar, ScreenSpaceEventType, VerticalOrigin } from 'cesium';
import { createMapDetailsPanel } from './mapDetailsPanel.js';
import { focusMapPoints } from './bridgeCamera.js';

// Rasterize the vector at 4× display size so Cesium's billboard texture stays crisp
// on high-density screens. The solid badge keeps the glyph readable over imagery.
const cameraIcon = muted => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="176" height="208" viewBox="0 0 44 52">
<path d="M17 40 22 49 27 40" fill="#0b1729" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>
<rect x="2" y="2" width="40" height="40" rx="12" fill="#0b1729" stroke="white" stroke-width="2.5"/>
<rect x="5" y="5" width="34" height="34" rx="9" fill="${muted ? '#25364b' : '#103d53'}"/>
<g fill="none" stroke="${muted ? '#e2e8f0' : '#67f4e2'}" stroke-width="2.5" stroke-linejoin="round">
<path d="M17 15h6l2 3h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V20a2 2 0 0 1 2-2h4Z"/>
<circle cx="22" cy="25" r="5"/>
</g></svg>`)}`;
const icons = { available: cameraIcon(false), unavailable: cameraIcon(true) };
// Extension point: return a verified stream URL when a real provider is integrated.
export function getCameraStreamUrl(cameraId) { return null; }
const videoLabel = p => p.video_enabled === true ? 'Available' : 'Not Available';
const valid = value => value != null && String(value).trim() !== '' && String(value).toUpperCase() !== 'N/A';
export function cameraDetails(p) {
  const distance = Number(p.distance_to_i595_network_m);
  return [['Camera ID', p.camera_id], ['Video Stream', videoLabel(p)],
    ['Location', `${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}`],
    ['Distance to I-595 Network', valid(p.distance_to_i595_network_m) && Number.isFinite(distance) ? distance < 1000 ? `${Math.round(distance)} m` : `${(distance / 1000).toFixed(1)} km` : null],
    ['Source', 'FDOT / FL511 Camera Feed Data']].filter(([, value]) => valid(value));
}
export function installCctvCameras(container, viewer) {
  const group = document.createElement('details'); group.className = 'cameras-group';
  group.innerHTML = '<summary><input type="checkbox" id="cameras-all" aria-label="CCTV Cameras" disabled><span>CCTV Cameras</span><span class="badge">…</span></summary><button class="camera-zoom" disabled>Zoom to CCTV Cameras</button><div class="camera-list"></div><p class="ramp-status" role="status">Loading cameras…</p><button class="camera-retry" hidden>Retry cameras</button>';
  container.append(group);
  const parent = group.querySelector('input'), list = group.querySelector('.camera-list'), status = group.querySelector('[role="status"]'), zoom = group.querySelector('.camera-zoom'), retry = group.querySelector('.camera-retry');
  const cameraById = new Map(), records = new Map(), rows = new Map();
  const source = new CustomDataSource('I-595 Corridor CCTV Cameras');
  let selected, hovered, disposed = false, loading;
  const panel = createMapDetailsPanel({ title: 'CCTV Camera Details', className: 'camera-details', details: cameraDetails,
    tooltipText: p => `CCTV Camera\nCamera ID: ${p.camera_id}\nVideo: ${videoLabel(p)}`, onClose: () => select(null) });
  function style(entity) {
    if (!entity) return;
    entity.billboard.scale = entity === selected ? 1.18 : entity === hovered ? 1.1 : 1;
    entity.billboard.color = Color.WHITE;
  }
  function select(entity) {
    const old = selected; selected = entity; style(old); style(entity);
    panel.select(entity ? records.get(entity) : null);
    document.querySelector('.camera-stream-action')?.remove();
    if (entity && records.get(entity).video_enabled === true) {
      const button = document.createElement('button'); button.className = 'camera-stream-action'; button.textContent = 'View Camera';
      const url = getCameraStreamUrl(entity.id);
      const usable = typeof url === 'string' && /^https:\/\//i.test(url);
      button.disabled = !usable; button.title = usable ? 'View camera' : 'Video integration is not configured';
      if (usable) button.onclick = () => window.open(url, '_blank', 'noopener,noreferrer');
      document.querySelector('.camera-details').append(button);
    }
    if (entity) focusMapPoints(viewer, [entity.position.getValue(viewer.clock.currentTime)], '.camera-details');
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
    for (const [id, entity] of cameraById) { rows.get(id).checked = entity.show; if (entity.show) count++; }
    parent.checked = count > 0 && count === cameraById.size;
    parent.indeterminate = count > 0 && count < cameraById.size;
    status.textContent = `${count} of ${cameraById.size} cameras visible`;
    if (selected && !selected.show) select(null);
    if (hovered && !hovered.show) hover(null);
    viewer.scene.requestRender();
  }
  parent.onclick = event => event.stopPropagation();
  parent.onchange = () => { for (const entity of cameraById.values()) entity.show = parent.checked; sync(); };
  zoom.onclick = () => {
    for (const entity of cameraById.values()) entity.show = true;
    sync(); select(null);
    focusMapPoints(viewer, [...cameraById.values()].map(e => e.position.getValue(viewer.clock.currentTime)), '.camera-details');
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
      const response = await fetch(`${import.meta.env.BASE_URL}data/i595_corridor_cameras.geojson`);
      if (!response.ok) throw new Error(`Cameras request failed: ${response.status}`);
      const data = await response.json(), ids = new Set();
      for (const f of data.features) {
        if (!valid(f.properties.camera_id) || ids.has(String(f.properties.camera_id)) || f.geometry?.type !== 'Point') throw new Error('Invalid camera identity or geometry');
        ids.add(String(f.properties.camera_id));
      }
      if (disposed) return;
      for (const f of data.features) {
        const p = { ...f.properties, latitude: f.geometry.coordinates[1], longitude: f.geometry.coordinates[0] };
        const entity = source.entities.add({ id: String(p.camera_id), name: `Camera ${p.camera_id}`, show: false,
          position: Cartesian3.fromDegrees(...f.geometry.coordinates), properties: p,
          // Deliberately subordinate to the corridor: a small marker up close, shrinking away with
          // distance and gone entirely at corridor scale, so cameras never dominate the freeway.
          billboard: { image: p.video_enabled === true ? icons.available : icons.unavailable, width: 24, height: 28, scale: 1, verticalOrigin: VerticalOrigin.BOTTOM,
            heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new DistanceDisplayCondition(0, 18000),
            scaleByDistance: new NearFarScalar(400, 1, 12000, 0.25) } });
        cameraById.set(String(p.camera_id), entity); records.set(entity, p);
        const row = document.createElement('div'); row.className = 'segment-row';
        const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.cameraId = String(p.camera_id);
        const label = `Camera ${p.camera_id}`;
        input.setAttribute('aria-label', label);
        const button = document.createElement('button'); button.className = 'segment-select'; button.textContent = label; button.dataset.cameraId = String(p.camera_id);
        input.onchange = () => { entity.show = input.checked; sync(); };
        button.onclick = () => { entity.show = true; sync(); select(entity); };
        rows.set(String(p.camera_id), input); row.append(input, button); list.append(row);
      }
      await viewer.dataSources.add(source);
      if (disposed) { viewer.dataSources.remove(source, true); return; }
      group.querySelector('.badge').textContent = String(cameraById.size);
      parent.disabled = false; zoom.disabled = false; sync();
    })().catch(error => { loading = null; if (!disposed) { status.textContent = 'Cameras could not load.'; retry.hidden = false; console.error(error); } });
    return loading;
  }
  retry.onclick = load; load();
  return { cameraById, destroy() {
    disposed = true; removeMove(); viewer.canvas.removeEventListener('mouseleave', leave);
    for (const [event, action] of [[ScreenSpaceEventType.MOUSE_MOVE, oldMove], [ScreenSpaceEventType.LEFT_CLICK, oldClick]]) {
      if (action) handler.setInputAction(action, event); else handler.removeInputAction(event);
    }
    viewer.dataSources.remove(source, true); panel.destroy(); group.remove();
  } };
}
