import { GeoJsonDataSource, Color, PolylineDashMaterialProperty, ScreenSpaceEventType } from 'cesium';
import { createMapDetailsPanel } from './mapDetailsPanel.js';
import { installBridgeZoomMarkers } from './bridgeZoomMarkers.js';
import { bridgesForDisplay } from './bridgeDisplayData.js';
import { focusBridge } from './bridgeCamera.js';
import { roadStructureFromProperties, structureOverlapsSegment, structureTooltip, bridgeDetails } from './roadStructureData.js';

/** Bridge overlay on the existing viewer, using its shared details and picking mechanisms. */
export function installBridgeStructures(container, viewer, mainlineSegments) {
  container.innerHTML = `<details class="structures-group"><summary>Structures</summary>
    <details class="bridges-group" style="--road:#e7cf96"><summary><input id="bridges-all" type="checkbox" aria-label="Bridges" disabled><span class="swatch"></span><span>Bridges</span><span class="badge">…</span></summary>
      <div class="bridge-list"></div><p class="bridge-hint">Select a bridge to zoom to its location.</p>
    </details><p class="bridge-status ramp-status" role="status">Loading bridges…</p><button class="ramp-retry" hidden>Retry bridge loading</button>
  </details>`;
  const parent = container.querySelector('#bridges-all'), list = container.querySelector('.bridge-list');
  const status = container.querySelector('.bridge-status'), retry = container.querySelector('.ramp-retry');
  const bridgeById = new Map(), records = new Map(), rows = new Map();
  const segmentsByBridge = new Map(), bridgesBySegment = new Map();
  let source, loading, zoomMarkers, disposed = false, selected = null, hovered = null, cycleKey = '';
  const normal = Color.fromCssColorString('#e7cf96');
  const panel = createMapDetailsPanel({
    title: 'Bridge Details', className: 'bridge-details',
    details: structure => bridgeDetails(structure, segmentsByBridge.get(structure.assetId)),
    tooltipText: structureTooltip, onClose: () => select(null),
  });
  function style(entity) {
    if (!entity) return;
    entity.polyline.width = entity === selected ? 7 : entity === hovered ? 6 : 4;
    entity.polyline.material = new PolylineDashMaterialProperty({
      color: entity === selected || entity === hovered ? Color.lerp(normal, Color.WHITE, 0.5, new Color()) : normal,
      gapColor: Color.BLACK.withAlpha(0.65), dashLength: 12,
    });
    // Ground-polyline ordering keeps the infrastructure overlay visible over roads.
    entity.polyline.zIndex = entity === selected ? 21 : 20;
    if (entity.billboard) entity.billboard.scale = entity === selected || entity === hovered ? 1.12 : 1;
  }
  function select(entity) {
    const previous = selected; selected = entity; style(previous); style(selected);
    panel.select(entity ? records.get(entity) : null);
    renderLocationMembers(entity);
    if (entity) focusBridge(viewer, entity);
    else if (previous) viewer.camera.cancelFlight();
    viewer.scene.requestRender();
  }
  function renderLocationMembers(entity) {
    document.querySelector('.bridge-location-members')?.remove();
    const members = entity ? zoomMarkers?.membersFor(entity) || [] : [];
    if (members.length > 1) {
      const section = document.createElement('div'); section.className = 'bridge-location-members';
      const title = document.createElement('p'); title.textContent = `${members.length} FDOT structures share this location`; section.append(title);
      for (const member of members) {
        const structure = records.get(member), button = document.createElement('button');
        button.textContent = `${structure.displayName} · FDOT side ${structure.roadSide}`;
        button.setAttribute('aria-pressed', String(member === entity));
        button.onclick = () => select(member); section.append(button);
      }
      document.querySelector('.bridge-details').append(section);
    }
  }
  function hover(entity, position) {
    const previous = hovered; hovered = entity; style(previous); style(hovered);
    panel.hover(entity ? { ...records.get(entity), locationCount: zoomMarkers?.membersFor(entity).length || 1 } : null, position);
    if (entity) viewer.canvas.style.cursor = 'pointer';
  }
  function sync() {
    let visible = 0;
    for (const [id, input] of rows) { input.checked = bridgeById.get(id).show; if (input.checked) visible++; }
    parent.checked = visible === bridgeById.size && visible > 0;
    parent.indeterminate = visible > 0 && visible < bridgeById.size;
    status.textContent = `${visible} of ${bridgeById.size} bridges visible`;
    if (selected && !selected.show) select(null);
    else if (selected) renderLocationMembers(selected);
    if (hovered && !hovered.show) { hover(null); viewer.canvas.style.cursor = ''; }
    viewer.scene.requestRender();
  }
  parent.addEventListener('click', event => event.stopPropagation());
  parent.onchange = () => { for (const entity of bridgeById.values()) entity.show = parent.checked; sync(); };
  const handler = viewer.screenSpaceEventHandler;
  const oldMove = handler.getInputAction(ScreenSpaceEventType.MOUSE_MOVE), oldClick = handler.getInputAction(ScreenSpaceEventType.LEFT_CLICK);
  function hits(position) {
    if (!source) return [];
    const picked = viewer.scene.drillPick(position);
    if (!records.has(picked[0]?.id)) return [];
    return [...new Set(picked.flatMap(hit => records.has(hit.id) ? zoomMarkers?.membersFor(hit.id) || [hit.id] : []).filter(entity => entity.show))].sort((a, b) => a.id.localeCompare(b.id));
  }
  handler.setInputAction(movement => {
    oldMove?.(movement);
    const candidates = hits(movement.endPosition);
    hover(candidates.includes(selected) ? selected : candidates[0] || null, movement.endPosition);
  }, ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction(movement => {
    // Read selection before delegated actions clear other panels.
    const candidates = hits(movement.position), key = candidates.map(entity => entity.id).join('|');
    const next = key === cycleKey ? (candidates.indexOf(selected) + 1) % candidates.length : 0;
    oldClick?.(movement);
    cycleKey = key;
    select(candidates[next] || null);
    hover(candidates[next] || null, movement.position);
  }, ScreenSpaceEventType.LEFT_CLICK);
  const leave = () => { if (hovered) { hover(null); viewer.canvas.style.cursor = ''; } };
  viewer.canvas.addEventListener('mouseleave', leave);
  const removeMove = viewer.camera.moveStart.addEventListener(leave);
  function load() {
    loading ??= (async () => {
      retry.hidden = true;
      const response = await fetch(`${import.meta.env.BASE_URL}data/i595_bridges.geojson`);
      if (!response.ok) throw new Error(`Bridge request failed: ${response.status}`);
      const data = await response.json(), ids = new Set();
      for (const feature of data.features) {
        const structure = roadStructureFromProperties(feature.properties);
        if (ids.has(structure.assetId) || feature.geometry?.type !== 'LineString') throw new Error('Invalid or duplicate bridge asset ID.');
        ids.add(structure.assetId); feature.id = structure.assetId;
      }
      const loaded = await GeoJsonDataSource.load({ ...data, features: bridgesForDisplay(data.features) }, { clampToGround: true, strokeWidth: 4 });
      // Shared promise: this never fetches a second copy of the traffic-section file.
      await mainlineSegments.load();
      if (disposed) return;
      loaded.name = 'I-595 FDOT Bridges';
      for (const entity of loaded.entities.values) {
        const structure = roadStructureFromProperties(entity.properties.getValue());
        entity.show = false; entity.name = structure.displayName;
        bridgeById.set(structure.assetId, entity); records.set(entity, structure); style(entity);
        const overlaps = [...mainlineSegments.staticSegments.values()].filter(segment => structureOverlapsSegment(structure, segment));
        segmentsByBridge.set(structure.assetId, overlaps);
        for (const segment of overlaps) {
          if (!bridgesBySegment.has(segment.segmentId)) bridgesBySegment.set(segment.segmentId, []);
          bridgesBySegment.get(segment.segmentId).push(structure);
        }
      }
      source = await viewer.dataSources.add(loaded);
      zoomMarkers = installBridgeZoomMarkers(viewer, [...bridgeById.values()]);
      for (const [id, entity] of [...bridgeById].sort(([a], [b]) => a.localeCompare(b))) {
        const row = document.createElement('div'); row.className = 'segment-row';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', entity.name); checkbox.dataset.bridgeId = id;
        const button = document.createElement('button'); button.className = 'segment-select'; button.textContent = entity.name; button.dataset.bridgeId = id;
        checkbox.onchange = () => { entity.show = checkbox.checked; sync(); };
        button.onclick = () => { entity.show = true; sync(); select(entity); };
        row.append(checkbox, button); list.append(row); rows.set(id, checkbox);
      }
      container.querySelector('.badge').textContent = String(bridgeById.size);
      parent.disabled = false; sync();
    })().catch(error => { loading = null; if (!disposed) { status.textContent = 'Bridges could not load. Try again.'; retry.hidden = false; console.error(error); } });
    return loading;
  }
  retry.onclick = load; load();
  return {
    bridgeById, segmentsByBridge, bridgesBySegment,
    destroy() {
      disposed = true; removeMove(); viewer.canvas.removeEventListener('mouseleave', leave);
      zoomMarkers?.destroy();
      for (const [event, action] of [[ScreenSpaceEventType.MOUSE_MOVE, oldMove], [ScreenSpaceEventType.LEFT_CLICK, oldClick]]) {
        if (action) handler.setInputAction(action, event); else handler.removeInputAction(event);
      }
      if (source) viewer.dataSources.remove(source, true);
      panel.destroy(); container.replaceChildren();
    },
  };
}
