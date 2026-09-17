import { GeoJsonDataSource, Color, PolylineDashMaterialProperty, ScreenSpaceEventType } from 'cesium';
import { createMapDetailsPanel } from './mapDetailsPanel.js';
import { bridgeMarker, installBridgeZoomMarkers, SELECTED_POLYLINE_WIDTH } from './bridgeZoomMarkers.js';
import { bridgesForDisplay } from './bridgeDisplayData.js';
import { focusBridge } from './bridgeCamera.js';
import { roadStructureFromProperties, structureOverlapsSegment, structureTooltip, bridgeDetails } from './roadStructureData.js';

/** Bridge overlay on the existing viewer, using its shared details and picking mechanisms. */
export function installBridgeStructures(container, viewer, mainlineSegments) {
  // ---- Asset Explorer handover -----------------------------------------------------------------
  // While the Asset Explorer is browsing bridges it owns selection: the panel and the camera move
  // below belong to the standalone behaviour, and running them too would put two details panels on
  // screen and fly the camera on every Next. The layer still highlights, and still reports what the
  // user picked, so one shared selection stays in charge.
  let externallyOwned = false;
  /**
   * Report selections to every listener, not one.
   *
   * A single module backs several asset types (gantries and lane barriers here; three structure
   * types elsewhere), and each registers its own listener. Holding one callback meant the last
   * registration silently replaced the others, so picks for every other type vanished.
   */
  const selectionListeners = new Set();
  const reportSelection = record => { for (const listener of [...selectionListeners]) listener(record); };

  // Open by default: this group now holds the sign-structure layers as well as bridges, and a
  // collapsed disclosure made them look absent.
  container.innerHTML = `<details open class="structures-group"><summary>Structures</summary>
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
    // The ID marker carries the selection, the same as every other asset layer: charcoal normally,
    // warm yellow for the selected bridge.
    if (entity.billboard) {
      const marker = bridgeMarker(entity, entity === selected);
      entity.billboard.image = marker.image;
      entity.billboard.width = marker.width;
      entity.billboard.height = marker.height;
    }
    entity.polyline.width = entity === selected ? SELECTED_POLYLINE_WIDTH : entity === hovered ? 6 : 4;
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
    if (externallyOwned) {
      panel.select(null);
      renderLocationMembers(null);
      viewer.scene.requestRender();
      reportSelection(entity ? records.get(entity) : null);
      return;
    }
    panel.select(entity ? records.get(entity) : null);
    renderLocationMembers(entity);
    if (entity) focusBridge(viewer, entity);
    else if (previous) viewer.camera.cancelFlight();
    viewer.scene.requestRender();
    reportSelection(entity ? records.get(entity) : null);
  }

  /** Highlight by bridge asset id without opening a panel or moving the camera. */
  function highlightById(id) {
    const entity = id == null ? null : bridgeById.get(String(id));
    const previous = selected; selected = entity; style(previous); style(selected);
    viewer.scene.requestRender();
    return Boolean(entity) || id == null;
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
    records, highlightById,
    setExternallyOwned(owned) { externallyOwned = Boolean(owned); },
    onSelection(callback) {
      // null clears every listener, which is what teardown wants.
      if (!callback) { selectionListeners.clear(); return () => {}; }
      selectionListeners.add(callback);
      return () => selectionListeners.delete(callback);
    },
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
