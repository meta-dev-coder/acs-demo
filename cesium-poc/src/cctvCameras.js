import { corridorVisualConfig as config } from './corridorVisualConfig.js';
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

// Returns the snapshot proxy URL for the DIVAS JPEG snapshot, or null when the
// camera has no divas_chan_id. Uses VITE_SNAPSHOT_BASE when set (e.g. CloudFront),
// otherwise falls back to the same-origin dev-server proxy.
const SNAPSHOT_BASE = (import.meta.env?.VITE_SNAPSHOT_BASE ?? '').replace(/\/$/, '');
export function getCameraStreamUrl(camera) {
  const id = camera?.divas_chan_id;
  if (typeof id !== 'string' || id.length === 0) return null;
  return SNAPSHOT_BASE ? `${SNAPSHOT_BASE}/${id}/snapshot` : `/api/i595/camera/${id}/snapshot`;
}
const snapshotLabel = p => p.divas_chan_id ? 'Live snapshot' : p.video_enabled === true ? 'No public feed' : 'Not available';
const valid = value => value != null && String(value).trim() !== '' && String(value).toUpperCase() !== 'N/A';

export function cameraDetails(p) {
  const distance = Number(p.distance_to_i595_network_m);
  return [
    ['Camera ID', p.camera_id],
    ['Location', p.description || null],
    ['Direction', p.direction ? { E: 'Eastbound', W: 'Westbound', N: 'Northbound', S: 'Southbound' }[p.direction] ?? p.direction : null],
    ['Snapshot Feed', snapshotLabel(p)],
    ['Coordinates', `${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}`],
    ['Dist. to I-595', valid(p.distance_to_i595_network_m) && Number.isFinite(distance) ? distance < 1000 ? `${Math.round(distance)} m` : `${(distance / 1000).toFixed(1)} km` : null],
    ['Source', 'FDOT / FL511'],
  ].filter(([, value]) => valid(value));
}

function cameraLabel(p) {
  return p.description || `Camera ${p.camera_id}`;
}

// Feed status: 'live' = has DIVAS chan id, 'enabled' = video_enabled but no DIVAS, 'none' = no video
function feedStatus(p) {
  if (p.divas_chan_id) return 'live';
  if (p.video_enabled) return 'enabled';
  return 'none';
}

function makeGroup(title, id, className) {
  const el = document.createElement('details');
  el.className = className;
  el.innerHTML = `<summary><input type="checkbox" id="${id}" aria-label="${title}" disabled><span>${title}</span><span class="badge">…</span></summary><div class="camera-list"></div><p class="ramp-status" role="status">Loading…</p><button class="camera-retry" hidden>Retry</button>`;
  return {
    el,
    parent: el.querySelector('input'),
    list: el.querySelector('.camera-list'),
    status: el.querySelector('[role="status"]'),
    retry: el.querySelector('.camera-retry'),
  };
}

/**
 * @param {{onStreetView?: (place: {longitude: number, latitude: number, label: string}) => void}} [hooks]
 *   When provided, the details panel offers Street View for the camera's own coordinates. Street
 *   View is Google's street-level photography, not this camera's feed — the panel keeps them apart.
 */
export function installCctvCameras(container, viewer, { onStreetView } = {}) {
  // Express lane cameras (gantry-mounted on I-595 Express) shown first/top.
  const expressGroup = makeGroup('Express Lane Cameras', 'cameras-express', 'cameras-group cameras-express-group');
  const mainlineGroup = makeGroup('Mainline Cameras', 'cameras-mainline', 'cameras-group cameras-mainline-group');
  container.append(expressGroup.el, mainlineGroup.el);

  // All entities share one data source and one records/cameraById map so the click handler
  // can pick any camera regardless of which group it belongs to.
  const cameraById = new Map(), records = new Map(), rows = new Map();
  // Track which IDs belong to each group so the master checkboxes work independently.
  const expressIds = new Set(), mainlineIds = new Set();

  const source = new CustomDataSource('I-595 Corridor CCTV Cameras');
  let selected, hovered, disposed = false, loading;
  let snapshotInterval = null;

  function clearSnapshotInterval() {
    if (snapshotInterval !== null) { clearInterval(snapshotInterval); snapshotInterval = null; }
  }

  const panel = createMapDetailsPanel({ title: 'CCTV Camera Details', className: 'camera-details', details: cameraDetails,
    tooltipText: p => `CCTV Camera\nCamera ID: ${p.camera_id}\nSnapshot: ${snapshotLabel(p)}`, onClose: () => select(null) });

  function style(entity) {
    if (!entity) return;
    entity.billboard.distanceDisplayCondition = new DistanceDisplayCondition(0, entity === selected ? Number.MAX_VALUE : config.lod.corridorDistance);
    entity.billboard.scale = entity === selected ? 1.18 : entity === hovered ? 1.1 : 1;
    entity.billboard.color = Color.WHITE;
  }

  function buildSnapshotWidget(snapshotUrl) {
    const wrapper = document.createElement('div');
    wrapper.className = 'camera-stream-action';
    const img = document.createElement('img');
    img.alt = 'I-595 live snapshot';
    img.style.cssText = 'width:100%;display:block;border-radius:4px;';
    img.src = `${snapshotUrl}?t=${Date.now()}`;
    const statusLine = document.createElement('p');
    statusLine.style.cssText = 'font-size:0.75rem;color:#94a3b8;margin:4px 0 0;text-align:right;';
    const updateTimestamp = () => { statusLine.textContent = `Last refreshed: ${new Date().toLocaleTimeString()}`; };
    updateTimestamp();
    const errorMsg = document.createElement('div');
    errorMsg.hidden = true;
    errorMsg.style.cssText = 'padding:12px;background:#1e293b;border-radius:4px;font-size:0.85rem;color:#f87171;';
    errorMsg.textContent = 'Snapshot unavailable — camera may be offline or feed not yet active';
    const retryBtn = document.createElement('button');
    retryBtn.textContent = 'Retry';
    retryBtn.style.cssText = 'margin-top:8px;padding:4px 12px;font-size:0.8rem;cursor:pointer;';
    errorMsg.append(retryBtn);
    function loadSnapshot() { img.hidden = false; errorMsg.hidden = true; img.src = `${snapshotUrl}?t=${Date.now()}`; }
    img.onload = () => { img.hidden = false; errorMsg.hidden = true; updateTimestamp(); };
    img.onerror = () => { img.hidden = true; errorMsg.hidden = false; };
    retryBtn.onclick = loadSnapshot;
    clearSnapshotInterval();
    snapshotInterval = setInterval(loadSnapshot, 6_000);
    wrapper.append(img, errorMsg, statusLine);
    return wrapper;
  }

  function select(entity) {
    clearSnapshotInterval();
    const old = selected; selected = entity; style(old); style(entity);
    panel.select(entity ? records.get(entity) : null);
    document.querySelector('.camera-stream-action')?.remove();
    document.querySelector('.camera-street-view')?.remove();
    if (entity && onStreetView) {
      const record = records.get(entity);
      const action = document.createElement('button');
      action.className = 'camera-street-view';
      action.textContent = 'Street View';
      action.title = 'Google street-level imagery near this camera';
      action.onclick = () => onStreetView({
        longitude: record.longitude, latitude: record.latitude,
        label: `CCTV ${record.camera_id}`,
      });
      document.querySelector('.camera-details')?.append(action);
    }
    if (entity) {
      const p = records.get(entity);
      const url = getCameraStreamUrl(p);
      if (typeof url === 'string') {
        document.querySelector('.camera-details').append(buildSnapshotWidget(url));
      } else if (p.video_enabled === true) {
        const note = document.createElement('p');
        note.className = 'camera-stream-action camera-no-feed-note';
        note.textContent = 'Snapshot feed not available for this camera — no public DIVAS mapping.';
        document.querySelector('.camera-details').append(note);
      }
      focusMapPoints(viewer, [entity.position.getValue(viewer.clock.currentTime)], '.camera-details');
    } else if (old) {
      viewer.camera.cancelFlight();
    }
    viewer.scene.requestRender();
  }

  function hover(entity, position) {
    const old = hovered; hovered = entity; style(old); style(entity);
    panel.hover(entity ? records.get(entity) : null, position);
    if (entity) viewer.canvas.style.cursor = 'pointer';
    else if (old) viewer.canvas.style.cursor = '';
    viewer.scene.requestRender();
  }

  function syncGroup(idSet, grp) {
    let on = 0;
    for (const id of idSet) {
      const entity = cameraById.get(id);
      rows.get(id)?.classList.toggle('camera-row--hidden', !entity?.show);
      if (entity?.show) on++;
    }
    grp.parent.checked = on > 0 && on === idSet.size;
    grp.parent.indeterminate = on > 0 && on < idSet.size;
    grp.status.textContent = `${on} of ${idSet.size} cameras visible`;
  }

  function sync() {
    syncGroup(expressIds, expressGroup);
    syncGroup(mainlineIds, mainlineGroup);
    if (selected && !selected.show) select(null);
    if (hovered && !hovered.show) hover(null);
    viewer.scene.requestRender();
  }

  for (const grp of [expressGroup, mainlineGroup]) {
    grp.parent.onclick = e => e.stopPropagation();
    grp.parent.onchange = () => {
      const idSet = grp === expressGroup ? expressIds : mainlineIds;
      for (const id of idSet) { const e = cameraById.get(id); if (e) e.show = grp.parent.checked; }
      sync();
    };
  }

  const handler = viewer.screenSpaceEventHandler;
  const oldMove = handler.getInputAction(ScreenSpaceEventType.MOUSE_MOVE);
  const oldClick = handler.getInputAction(ScreenSpaceEventType.LEFT_CLICK);
  const pick = position => { const entity = viewer.scene.pick(position)?.id; return records.has(entity) && entity.show ? entity : null; };
  handler.setInputAction(movement => { oldMove?.(movement); hover(pick(movement.endPosition), movement.endPosition); }, ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction(movement => { const entity = pick(movement.position); if (entity) select(entity); else oldClick?.(movement); }, ScreenSpaceEventType.LEFT_CLICK);
  const leave = () => hover(null);
  viewer.canvas.addEventListener('mouseleave', leave);
  const removeMove = viewer.camera.moveStart.addEventListener(leave);

  function load() {
    loading ??= (async () => {
      expressGroup.retry.hidden = true; mainlineGroup.retry.hidden = true;
      const response = await fetch(`${import.meta.env.BASE_URL}data/i595_corridor_cameras.geojson`);
      if (!response.ok) throw new Error(`Cameras request failed: ${response.status}`);
      const data = await response.json(), ids = new Set();
      const onRoad = f => { const d = Number(f.properties.distance_to_i595_network_m); return Number.isFinite(d) ? d <= 150 : true; };
      const features = data.features.filter(onRoad);
      for (const f of features) {
        if (!valid(f.properties.camera_id) || ids.has(String(f.properties.camera_id)) || f.geometry?.type !== 'Point') throw new Error('Invalid camera identity or geometry');
        ids.add(String(f.properties.camera_id));
      }
      if (disposed) return;
      for (const f of features) {
        const p = { ...f.properties, latitude: f.geometry.coordinates[1], longitude: f.geometry.coordinates[0] };
        const isExpress = p.is_express_camera === true;
        const entity = source.entities.add({
          id: String(p.camera_id), name: cameraLabel(p), show: false,
          position: Cartesian3.fromDegrees(...f.geometry.coordinates), properties: p,
          billboard: { image: p.video_enabled === true ? icons.available : icons.unavailable, width: 34, height: 40, scale: 1,
            verticalOrigin: VerticalOrigin.BOTTOM, heightReference: HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new DistanceDisplayCondition(0, config.lod.corridorDistance),
            scaleByDistance: new NearFarScalar(400, 1, 12000, 0.7) },
        });
        cameraById.set(String(p.camera_id), entity); records.set(entity, p);
        if (isExpress) expressIds.add(String(p.camera_id)); else mainlineIds.add(String(p.camera_id));

        const row = document.createElement('div'); row.className = 'segment-row camera-row';
        row.dataset.cameraId = String(p.camera_id);
        const dot = document.createElement('span'); dot.className = `camera-feed-dot feed-${feedStatus(p)}`;
        dot.title = feedStatus(p) === 'live' ? 'Live snapshot available' : feedStatus(p) === 'enabled' ? 'Camera active, no public snapshot feed' : 'No snapshot feed';
        const button = document.createElement('button'); button.className = 'segment-select camera-select';
        button.textContent = cameraLabel(p); button.dataset.cameraId = String(p.camera_id);
        button.onclick = () => { entity.show = true; sync(); select(entity); };
        rows.set(String(p.camera_id), row); row.append(dot, button);
        (isExpress ? expressGroup.list : mainlineGroup.list).append(row);
      }
      await viewer.dataSources.add(source);
      if (disposed) { viewer.dataSources.remove(source, true); return; }
      expressGroup.el.querySelector('.badge').textContent = String(expressIds.size);
      mainlineGroup.el.querySelector('.badge').textContent = String(mainlineIds.size);
      expressGroup.parent.disabled = false; mainlineGroup.parent.disabled = false;
      sync();
    })().catch(error => {
      loading = null;
      if (!disposed) {
        const msg = 'Cameras could not load.';
        expressGroup.status.textContent = msg; expressGroup.retry.hidden = false;
        mainlineGroup.status.textContent = msg; mainlineGroup.retry.hidden = false;
        console.error(error);
      }
    });
    return loading;
  }

  const retryLoad = () => { loading = null; load(); };
  expressGroup.retry.onclick = retryLoad; mainlineGroup.retry.onclick = retryLoad;
  load();

  // Programmatically show + select a camera by ID (used by Ask the Twin)
  function selectCamera(id) {
    const entity = cameraById.get(String(id));
    if (!entity) return false;
    entity.show = true;
    sync();
    select(entity);
    return true;
  }

  return { cameraById, records, selectCamera, destroy() {
    clearSnapshotInterval();
    disposed = true; removeMove(); viewer.canvas.removeEventListener('mouseleave', leave);
    for (const [event, action] of [[ScreenSpaceEventType.MOUSE_MOVE, oldMove], [ScreenSpaceEventType.LEFT_CLICK, oldClick]]) {
      if (action) handler.setInputAction(action, event); else handler.removeInputAction(event);
    }
    viewer.dataSources.remove(source, true); panel.destroy();
    expressGroup.el.remove(); mainlineGroup.el.remove();
  } };
}
