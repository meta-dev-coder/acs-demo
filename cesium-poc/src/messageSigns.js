import { CustomDataSource, Cartesian3, HeightReference, NearFarScalar, ScreenSpaceEventHandler, ScreenSpaceEventType, VerticalOrigin } from 'cesium';
import { assetIdMarker } from './assetIdMarker.js';
import { createMapDetailsPanel } from './mapDetailsPanel.js';

const endpoint = import.meta.env.VITE_MESSAGE_SIGNS_API || '/api/i595/message-signs';

export function installMessageSigns(container, viewer) {
  const group = document.createElement('details');
  group.className = 'cameras-group message-signs-group';
  group.innerHTML = '<summary><input type="checkbox" id="message-signs-all" aria-label="Message Signs"><span>Message Signs</span><span class="badge">…</span></summary><p class="ramp-status" role="status">FL511 signs along the I-595 corridor</p><button type="button" class="camera-retry message-signs-retry" hidden>Retry message signs</button>';
  container.append(group);
  const input = group.querySelector('input'), status = group.querySelector('[role="status"]'), retry = group.querySelector('button');
  const source = new CustomDataSource('I-595 Message Signs');
  source.show = false;
  const added = viewer.dataSources.add(source);
  const signById = new Map(), records = new Map(), listeners = new Set();
  let selected = null, disposed = false, pending = null, loaded = false, loadError = null, requestId = 0;
  const panel = createMapDetailsPanel({ title: 'Message Sign Details', className: 'signal-details message-sign-details',
    details: record => [
      ['Sign ID', record.id], ['Location', record.title],
      ['Message', record.detailError ? 'Message unavailable. Select this sign again to retry.' : record.detailLoading ? 'Loading message…' : record.message || 'No message displayed'],
      ['Updated (FL511)', record.updatedAt], ['Source', 'FL511'],
      ['Feed status', record.sourceStatus === 'STALE' ? 'Stale — showing last available data' : record.sourceStatus],
    ].filter(([, value]) => value != null && value !== ''),
    tooltipText: record => record.title,
    onClose: () => select(null),
  });
  const report = record => { for (const listener of listeners) listener(record); };
  function style(entity) {
    if (!entity) return;
    const marker = assetIdMarker({ id: records.get(entity).id, selected: entity === selected });
    entity.billboard.image = marker.image;
    entity.billboard.width = marker.width;
    entity.billboard.height = marker.height;
    entity.billboard.scale = entity === selected ? 1.08 : 1;
  }
  async function getJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Message signs request failed (${response.status})`);
    return response.json();
  }
  function select(entity) {
    if (disposed) return;
    const old = selected;
    selected = entity;
    style(old); style(entity);
    const serial = ++requestId;
    if (!entity) { panel.select(null); if (old) report(null); viewer.scene.requestRender(); return; }
    const record = records.get(entity);
    record.detailLoading = true; record.detailError = false;
    panel.select(record);
    // Report once; explorer-driven selection may synchronously call select again.
    if (old !== entity) report(record);
    if (serial !== requestId) return;
    viewer.scene.requestRender();
    void getJson(`${endpoint}/${encodeURIComponent(record.id)}`).then(detail => {
      if (disposed || serial !== requestId || selected !== entity) return;
      Object.assign(record, detail, { detailLoading: false, detailError: false });
      panel.select(record);
    }).catch(() => {
      if (disposed || serial !== requestId || selected !== entity) return;
      record.detailLoading = false; record.detailError = true;
      panel.select(record);
    });
  }
  async function load() {
    if (pending) return pending;
    status.textContent = 'Loading message signs…'; retry.hidden = true; loadError = null;
    pending = (async () => {
      const payload = await getJson(endpoint);
      if (!Array.isArray(payload.signs)) throw new Error('Invalid message signs response');
      await added;
      if (disposed) return;
      select(null); source.entities.removeAll(); signById.clear(); records.clear();
      for (const record of payload.signs) {
        const entity = source.entities.add({ id: `message-sign-${record.id}`, name: record.title,
          position: Cartesian3.fromDegrees(record.longitude, record.latitude),
          billboard: { ...assetIdMarker({ id: record.id }), verticalOrigin: VerticalOrigin.BOTTOM,
            heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Infinity,
            scaleByDistance: new NearFarScalar(400, 1, 12000, 0.7) } });
        signById.set(record.id, entity); records.set(entity, record);
      }
      loaded = true;
      group.querySelector('.badge').textContent = String(signById.size);
      status.textContent = `${signById.size} corridor message signs · FL511${payload.sourceStatus === 'STALE' ? ' · Stale data' : ''}`;
      retry.hidden = payload.sourceStatus !== 'STALE';
      source.show = input.checked;
      viewer.scene.requestRender();
    })().catch(error => {
      if (disposed) return;
      loadError = error;
      status.textContent = 'Message signs unavailable. Retry to load FL511 signs.';
      retry.hidden = false;
    }).finally(() => { pending = null; });
    return pending;
  }
  input.onclick = event => event.stopPropagation();
  input.onchange = async () => {
    source.show = input.checked;
    if (!input.checked) { select(null); panel.hover(null); }
    if (input.checked && !loaded) await load();
    if (!disposed) { source.show = input.checked; viewer.scene.requestRender(); }
  };
  retry.onclick = async () => { await load(); input.dispatchEvent(new Event('change', { bubbles: true })); };
  // A dedicated handler avoids replacing another asset's click listener during teardown.
  const handler = new ScreenSpaceEventHandler(viewer.canvas);
  const pick = position => {
    if (!source.show) return null;
    const entity = viewer.scene.pick(position)?.id;
    return records.has(entity) ? entity : null;
  };
  handler.setInputAction(event => {
    const entity = pick(event.position);
    if (entity || selected) select(entity);
  }, ScreenSpaceEventType.LEFT_CLICK);
  handler.setInputAction(event => {
    const entity = pick(event.endPosition);
    panel.hover(entity ? records.get(entity) : null, event.endPosition);
  }, ScreenSpaceEventType.MOUSE_MOVE);
  const leave = () => panel.hover(null);
  viewer.canvas.addEventListener('mouseleave', leave);
  return {
    signById, records,
    get error() { return loadError; },
    selectById(id) { const entity = signById.get(String(id)); if (entity) select(entity); },
    clearSelection() { if (selected) select(null); },
    onSelection(callback) { if (!callback) { listeners.clear(); return; } listeners.add(callback); return () => listeners.delete(callback); },
    destroy() {
      disposed = true; ++requestId; handler.destroy(); listeners.clear();
      viewer.canvas.removeEventListener('mouseleave', leave);
      void added.then(() => viewer.dataSources.remove(source, true));
      panel.destroy(); group.remove();
    },
  };
}
