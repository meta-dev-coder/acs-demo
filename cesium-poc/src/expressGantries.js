import { corridorVisualConfig as config } from './corridorVisualConfig.js';
import { CustomDataSource, Cartesian3, Color, DistanceDisplayCondition, HeightReference, NearFarScalar, ScreenSpaceEventType, VerticalOrigin } from 'cesium';
import { createMapDetailsPanel } from './mapDetailsPanel.js';
import { focusMapPoints } from './bridgeCamera.js';

// Overhead portal-frame gantry — amber/orange for access nodes, 4× rasterisation size for crisp
// HiDPI rendering. Two vertical legs + horizontal toll beam, dark outline for satellite legibility.
const accessNodeIcon = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="112" viewBox="0 0 32 28">' +
  '<rect x="3" y="9" width="4" height="19" rx="1.5" fill="#F4A725" stroke="#0b1729" stroke-width="1"/>' +
  '<rect x="25" y="9" width="4" height="19" rx="1.5" fill="#F4A725" stroke="#0b1729" stroke-width="1"/>' +
  '<rect x="0" y="3" width="32" height="8" rx="3" fill="#0b1729" stroke="#F4A725" stroke-width="1.5"/>' +
  '<rect x="2" y="5" width="28" height="4" rx="2" fill="#F4A725"/>' +
  '</svg>'
)}`;

// Smaller portal-frame in teal for ORT mainline toll-only gantries (no lane access).
const ortMainlineIcon = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="80" viewBox="0 0 24 20">' +
  '<rect x="2" y="6" width="3" height="14" rx="1" fill="#1B8FA8" stroke="#0b1729" stroke-width="1"/>' +
  '<rect x="19" y="6" width="3" height="14" rx="1" fill="#1B8FA8" stroke="#0b1729" stroke-width="1"/>' +
  '<rect x="0" y="2" width="24" height="6" rx="2" fill="#0b1729" stroke="#1B8FA8" stroke-width="1.5"/>' +
  '<rect x="1" y="3" width="22" height="4" rx="1.5" fill="#1B8FA8"/>' +
  '</svg>'
)}`;

// Inject panel-specific styles once per page load. Keeps the module self-contained without
// requiring a companion CSS file — mirrors the approach taken by cctvCameras and trafficSignals.
let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
.gantry-status-chip{display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;letter-spacing:.06em;margin:8px 0 4px}
.gantry-status-chip.open{background:#0e3d25;color:#4ade80;border:1px solid #16a34a}
.gantry-status-chip.closed{background:#3d0e0e;color:#f87171;border:1px solid #dc2626}
.gantry-dms{margin:10px 0 4px;padding:8px 12px;background:#0b1115;border:2px solid #404040;border-radius:4px;font-family:monospace;font-size:13px;font-weight:600;letter-spacing:.08em;color:#F4A725;white-space:pre-wrap;line-height:1.5}
.gantry-dms.ort{color:#1B8FA8}
.gantry-dms-label{font-size:10px;color:#8b9ab0;margin-bottom:2px}
.gantry-access-note{margin-top:10px;padding:7px 10px;background:#0d1f2e;border-left:3px solid #F4A725;border-radius:0 4px 4px 0;font-size:11px;color:#c9d5e0;line-height:1.5}
`;
  document.head.append(style);
}

const valid = value => value != null && String(value).trim() !== '' && String(value).toUpperCase() !== 'N/A';

export function gantryDetails(p) {
  return [
    ['Gantry ID', p.gantry_id],
    ['Name', p.name],
    ['Type', p.type === 'access_node' ? 'Express Access Node' : 'Open Road Tolling — Mainline'],
    ['Milepost', `MP ${Number(p.milepost).toFixed(1)}`],
    ['Lane Count', p.lane_count != null ? String(p.lane_count) : null],
    ['Direction', p.direction],
    ['Source', 'FDOT / 595 Express Operations'],
  ].filter(([, v]) => valid(v));
}

export function installExpressGantries(container, viewer) {
  ensureStyles();
  const group = document.createElement('details'); group.className = 'gantries-group';
  group.innerHTML = '<summary><input type="checkbox" id="express-gantries-all" aria-label="595 Express Gantries" disabled><span>595 Express Gantries</span><span class="badge">…</span></summary><div class="gantry-list"></div><p class="ramp-status" role="status">Loading gantries…</p><button class="gantry-retry" hidden>Retry gantries</button>';
  container.append(group);
  const parent = group.querySelector('input'), list = group.querySelector('.gantry-list'), status = group.querySelector('[role="status"]'), retry = group.querySelector('.gantry-retry');
  const gantryById = new Map(), records = new Map(), rows = new Map();
  const source = new CustomDataSource('I-595 Express Gantries');
  let selected, hovered, disposed = false, loading;
  const panel = createMapDetailsPanel({ title: '595 Express Gantry', className: 'gantry-details', details: gantryDetails,
    tooltipText: p => [p.type === 'access_node' ? 'Express Access Node' : 'ORT Mainline Gantry', `${p.gantry_id} · ${p.name}`, `MP ${Number(p.milepost).toFixed(1)}`].join('\n'), onClose: () => select(null) });

  function styleEntity(entity) {
    if (!entity) return;
    entity.billboard.distanceDisplayCondition = new DistanceDisplayCondition(0, entity === selected ? Number.MAX_VALUE : config.lod.corridorDistance);
    entity.billboard.scale = entity === selected ? 1.18 : entity === hovered ? 1.1 : 1;
    entity.billboard.color = Color.WHITE;
  }

  // Remove any custom panel content injected by the previous selection.
  function clearCustomPanelContent() {
    document.querySelectorAll('.gantry-panel-extra').forEach(el => el.remove());
  }

  function select(entity) {
    document.querySelector('.camera-details')?.setAttribute('hidden', '');
    const old = selected; selected = entity; styleEntity(old); styleEntity(entity);
    panel.select(entity ? records.get(entity) : null);
    clearCustomPanelContent();
    if (entity) {
      const p = records.get(entity);
      const panelEl = document.querySelector('.gantry-details');
      // Status chip — injected directly after the <dl> heading block.
      const chipWrap = document.createElement('div'); chipWrap.className = 'gantry-panel-extra';
      const chip = document.createElement('span');
      chip.className = `gantry-status-chip ${p.status === 'open' ? 'open' : 'closed'}`;
      chip.textContent = p.status.toUpperCase();
      chipWrap.append(chip);
      panelEl.append(chipWrap);
      // DMS sign box.
      const dmsWrap = document.createElement('div'); dmsWrap.className = 'gantry-panel-extra';
      if (p.dms_text) {
        const lbl = document.createElement('div'); lbl.className = 'gantry-dms-label'; lbl.textContent = 'DMS MESSAGE';
        const box = document.createElement('div'); box.className = `gantry-dms${p.type === 'ort_mainline' ? ' ort' : ''}`;
        box.textContent = p.dms_text;
        dmsWrap.append(lbl, box);
      } else {
        const empty = document.createElement('div'); empty.className = 'gantry-dms-label'; empty.textContent = '— No DMS on this structure';
        dmsWrap.append(empty);
      }
      panelEl.append(dmsWrap);
      // Access node note.
      if (p.type === 'access_node') {
        const note = document.createElement('div'); note.className = 'gantry-panel-extra gantry-access-note';
        note.textContent = 'Express lane access point — click nearby cameras for live feeds';
        panelEl.append(note);
      }
    }
    if (entity) focusMapPoints(viewer, [entity.position.getValue(viewer.clock.currentTime)], '.gantry-details');
    else if (old) viewer.camera.cancelFlight();
    viewer.scene.requestRender();
  }

  function hover(entity, position) {
    const old = hovered; hovered = entity; styleEntity(old); styleEntity(entity);
    panel.hover(entity ? records.get(entity) : null, position);
    if (entity) viewer.canvas.style.cursor = 'pointer';
    else if (old) viewer.canvas.style.cursor = '';
    viewer.scene.requestRender();
  }

  function sync() {
    let count = 0;
    for (const [id, entity] of gantryById) { rows.get(id).checked = entity.show; if (entity.show) count++; }
    parent.checked = count > 0 && count === gantryById.size;
    parent.indeterminate = count > 0 && count < gantryById.size;
    status.textContent = `${count} of ${gantryById.size} gantries visible`;
    if (selected && !selected.show) select(null);
    if (hovered && !hovered.show) hover(null);
    viewer.scene.requestRender();
  }

  parent.onclick = event => event.stopPropagation();
  parent.onchange = () => { for (const entity of gantryById.values()) entity.show = parent.checked; sync(); };

  const handler = viewer.screenSpaceEventHandler;
  const oldMove = handler.getInputAction(ScreenSpaceEventType.MOUSE_MOVE), oldClick = handler.getInputAction(ScreenSpaceEventType.LEFT_CLICK);
  const pick = position => { const entity = viewer.scene.pick(position)?.id; return records.has(entity) && entity.show ? entity : null; };
  handler.setInputAction(movement => { oldMove?.(movement); hover(pick(movement.endPosition), movement.endPosition); }, ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction(movement => { const entity = pick(movement.position); if (entity) select(entity); else oldClick?.(movement); }, ScreenSpaceEventType.LEFT_CLICK);

  const leave = () => hover(null);
  viewer.canvas.addEventListener('mouseleave', leave);
  const removeMove = viewer.camera.moveStart.addEventListener(leave);

  function load() {
    loading ??= (async () => {
      retry.hidden = true;
      const response = await fetch(`${import.meta.env.BASE_URL}data/i595_express_gantries.geojson`);
      if (!response.ok) throw new Error(`Gantries request failed: ${response.status}`);
      const data = await response.json(), ids = new Set();
      for (const f of data.features) {
        if (!valid(f.properties.gantry_id) || ids.has(String(f.properties.gantry_id)) || f.geometry?.type !== 'Point') throw new Error('Invalid gantry identity or geometry');
        ids.add(String(f.properties.gantry_id));
      }
      if (disposed) return;
      for (const f of data.features) {
        const p = f.properties;
        const isAccess = p.type === 'access_node';
        const entity = source.entities.add({ id: String(p.gantry_id), name: p.name, show: false,
          position: Cartesian3.fromDegrees(...f.geometry.coordinates), properties: p,
          billboard: {
            image: isAccess ? accessNodeIcon : ortMainlineIcon,
            width: isAccess ? 32 : 24, height: isAccess ? 28 : 20,
            scale: 1, verticalOrigin: VerticalOrigin.BOTTOM,
            heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new DistanceDisplayCondition(0, config.lod.corridorDistance),
            scaleByDistance: new NearFarScalar(400, 1, 12000, 0.7),
          } });
        gantryById.set(String(p.gantry_id), entity); records.set(entity, p);
        const row = document.createElement('div'); row.className = 'segment-row';
        const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.gantryId = String(p.gantry_id);
        const label = `${p.name} · ${p.gantry_id}`;
        input.setAttribute('aria-label', label);
        const button = document.createElement('button'); button.className = 'segment-select'; button.textContent = label; button.dataset.gantryId = String(p.gantry_id);
        input.onchange = () => { entity.show = input.checked; sync(); };
        button.onclick = () => { entity.show = true; sync(); select(entity); };
        rows.set(String(p.gantry_id), input); row.append(input, button); list.append(row);
      }
      await viewer.dataSources.add(source);
      if (disposed) { viewer.dataSources.remove(source, true); return; }
      group.querySelector('.badge').textContent = String(gantryById.size);
      parent.disabled = false; sync();
    })().catch(error => { loading = null; if (!disposed) { status.textContent = 'Gantries could not load.'; retry.hidden = false; console.error(error); } });
    return loading;
  }
  retry.onclick = load; load();
  return { gantryById, destroy() {
    disposed = true; clearCustomPanelContent(); removeMove(); viewer.canvas.removeEventListener('mouseleave', leave);
    for (const [event, action] of [[ScreenSpaceEventType.MOUSE_MOVE, oldMove], [ScreenSpaceEventType.LEFT_CLICK, oldClick]]) {
      if (action) handler.setInputAction(action, event); else handler.removeInputAction(event);
    }
    viewer.dataSources.remove(source, true); panel.destroy(); group.remove();
  } };
}
