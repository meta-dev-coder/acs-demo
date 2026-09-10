import { corridorVisualConfig as config, corridorLOD, getTrafficColor, getFlowAnimationSpeed } from './corridorVisualConfig.js';
import { TrafficFlowMaterial } from './trafficFlowMaterial.js';
import { GeoJsonDataSource, Color, Cartographic, ScreenSpaceEventType } from 'cesium';
import { createMapDetailsPanel } from './mapDetailsPanel.js';
import { MAINLINE_COLORS, roadSegmentFromProperties, roadSegmentDetails, roadSegmentTooltip, segmentDirectionLabel } from './i595RoadSegmentData.js';

/** Extends the existing viewer/data-source/picking pattern; one combined FDOT source. */
export function createI595RoadSegmentLayer(viewer) {
  /** @type {Map<string, import('cesium').Entity>} */
  const segmentById = new Map();
  /** @type {Map<'EB'|'WB', import('cesium').Entity[]>} */
  const segmentsByDirection = new Map([['EB', []], ['WB', []]]);
  /** @type {Map<string, Readonly<import('./i595RoadSegmentData.js').RoadSegment>>} */
  const staticSegments = new Map();
  /** @type {Map<string, Readonly<import('./i595RoadSegmentData.js').RoadSegmentStatus>>} */
  const segmentStatus = new Map(); // Intentionally empty: no fabricated traffic observations.
  const records = new Map(), materials = new Map();
  let lod = 'overview', lastDistance = Infinity;
  function updateLOD() {
    const distance = viewer.camera.positionCartographic.height / Math.max(.2, Math.sin(-viewer.camera.pitch));
    if (Math.abs(distance-lastDistance) < lastDistance*config.lod.hysteresis) return;
    lastDistance=distance; const next=corridorLOD(distance);
    if(next===lod)return; lod=next;
    for(const entity of records.keys()) style(entity);
    viewer.scene.requestRender();
  }
  const removeLODChange=viewer.camera.changed.addEventListener(updateLOD);
  const removeLODEnd=viewer.camera.moveEnd.addEventListener(updateLOD);
  const animationTimer=setInterval(()=>{
    if(document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    if([...materials].some(([e,m])=>e.show && m.arrows))viewer.scene.requestRender();
  },33);
  const enabled = new Set();
  const visibleSegments = new Set();
  const colors = new Map(Object.entries(MAINLINE_COLORS).map(([direction, color]) => [direction, Color.fromCssColorString(color)]));
  let source, loading, disposed = false, selected = null, hovered = null, colorResolver = null;
  const panel = createMapDetailsPanel({
    title: 'Road Segment Details', className: 'segment-details', details: segment => roadSegmentDetails(segment, segmentsByDirection.get(segment.direction).length),
    tooltipText: roadSegmentTooltip, onClose: () => select(null),
  });
  // A route overlay, not a GIS trace: thin and part-transparent at rest so the physical roadway
  // stays visible through it, with brightness and weight reserved for hover and selection.
  function style(entity) {
    if (!entity) return;
    const segment = records.get(entity);
    const base = colorResolver?.(segment, segmentStatus.get(segment.segmentId)) ?? Color.fromCssColorString(getTrafficColor(segmentStatus.get(segment.segmentId), segment.direction));
    const emphasis = entity === selected ? 'SELECTED' : entity === hovered ? 'HOVERED' : 'RESTING';
    entity.polyline.width = config.lineWidth[lod] + (config.casing.enabled ? config.casing.pixels : 0);
    const glow = { SELECTED: 0.35, HOVERED: 0.22, RESTING: 0 }[emphasis];
    const opacity = { SELECTED: 1, HOVERED: 0.95, RESTING: 0.8 }[emphasis];
    const color = glow ? Color.lerp(base, Color.WHITE, glow, new Color()) : base;
    let material=materials.get(entity);
    if(!material){
      const points=entity.polyline.positions.getValue(viewer.clock.currentTime);
      const increasing=Cartographic.fromCartesian(points.at(-1)).longitude >= Cartographic.fromCartesian(points[0]).longitude;
      material=new TrafficFlowMaterial(increasing === (segment.direction==='EB') ? 1 : -1);
      materials.set(entity,material);entity.polyline.material=material;
    }
    material.tint=color.withAlpha(color.alpha*opacity);material.width=config.lineWidth[lod];
    material.speed=getFlowAnimationSpeed(segmentStatus.get(segment.segmentId));
    material.arrows=config.arrow.enabled && lod!=='overview';
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
  function applyVisibility() {
    for (const [direction, entities] of segmentsByDirection) {
      for (const entity of entities) entity.show = visibleSegments.has(entity.id);
    }
    if (selected && !selected.show) select(null);
    if (hovered && !hovered.show) { hover(null); viewer.canvas.style.cursor = ''; }
    viewer.scene.requestRender();
  }
  // Delegate existing actions, then use Cesium's actual topmost picked entity.
  // No mainline-priority picking or nearest-road substitution at interchanges.
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
      const response = await fetch(`${import.meta.env.BASE_URL}data/i595_fdot_traffic_segments.geojson`);
      if (!response.ok) throw new Error(`FDOT segment request failed: ${response.status}`);
      const data = await response.json();
      const ids = new Set();
      for (const feature of data.features) {
        const segment = roadSegmentFromProperties(feature.properties);
        if (ids.has(segment.segmentId) || feature.geometry?.type !== 'LineString') throw new Error('Duplicate or invalid FDOT geometry.');
        ids.add(segment.segmentId);
        feature.id = segment.segmentId;
      }
      // No cuts, joins, offsets or geometry simplification; retain supplied boundaries exactly.
      const loaded = await GeoJsonDataSource.load(data, { clampToGround: true, strokeWidth: 6 });
      if (disposed) return;
      loaded.name = 'I-595 FDOT Traffic Segments';
      for (const entity of loaded.entities.values) {
        const segment = roadSegmentFromProperties(entity.properties.getValue(viewer.clock.currentTime));
        entity.show = false;
        entity.name = `${segment.road} ${segmentDirectionLabel(segment.direction)}`;
        segmentById.set(segment.segmentId, entity);
        staticSegments.set(segment.segmentId, segment);
        records.set(entity, segment);
        segmentsByDirection.get(segment.direction).push(entity);
        if (enabled.has(segment.direction)) visibleSegments.add(segment.segmentId);
        style(entity);
      }
      for (const entities of segmentsByDirection.values()) entities.sort((a, b) => records.get(a).travelOrder - records.get(b).travelOrder);
      source = await viewer.dataSources.add(loaded);
      updateLOD();applyVisibility();
      return source;
    })().catch(error => { loading = null; throw error; });
    return loading;
  }
  return {
    segmentById, segmentsByDirection, staticSegments, segmentStatus, load,
    setFlowVisible(show) { config.arrow.enabled=show; for(const e of records.keys())style(e);viewer.scene.requestRender(); },
    setFocusEnabled(show) { config.casing.enabled=show;for(const e of records.keys())style(e);viewer.scene.requestRender(); },
    async setDirectionVisible(direction, show) {
      if (!segmentsByDirection.has(direction)) throw new Error('Unknown mainline direction.');
      if (show) enabled.add(direction); else enabled.delete(direction);
      try {
        if (show) await load();
        for (const entity of segmentsByDirection.get(direction)) {
          if (show) visibleSegments.add(entity.id); else visibleSegments.delete(entity.id);
        }
        if (!disposed) applyVisibility();
      } catch (error) { enabled.delete(direction); throw error; }
    },
    clearSelection() { select(null); },
    setSegmentVisible(id, show) {
      if (!segmentById.has(id)) throw new Error('Unknown FDOT segment.');
      if (show) visibleSegments.add(id); else visibleSegments.delete(id);
      applyVisibility();
    },
    selectSegment(id) {
      const entity = segmentById.get(id);
      if (!entity) throw new Error('Unknown FDOT segment.');
      select(entity);
    },
    hoverSegment(id) {
      const entity = segmentById.get(id);
      // Sidebar hover never turns on a hidden segment or opens a map tooltip.
      const previous = hovered;
      hovered = entity?.show ? entity : null;
      style(previous); style(hovered);
      panel.hover(null);
      viewer.scene.requestRender();
    },
    /** Future visualization hook: return a Cesium Color, or undefined to use the route color. */
    setColorResolver(resolver) {
      colorResolver = resolver;
      for (const entity of segmentById.values()) style(entity);
      viewer.scene.requestRender();
    },
    /** Update only dynamic state. Static metadata and source properties remain untouched. */
    updateStatus(status) {
      if (!segmentById.has(status.segmentId)) throw new Error('Unknown FDOT segment.');
      segmentStatus.set(status.segmentId, Object.freeze({ ...status }));
      style(segmentById.get(status.segmentId));
      viewer.scene.requestRender();
    },
    destroy() {
      disposed = true; clearInterval(animationTimer); removeLODChange(); removeLODEnd();
      removeMove(); viewer.canvas.removeEventListener('mouseleave', leave);
      for (const [event, action] of [[ScreenSpaceEventType.MOUSE_MOVE, oldMove], [ScreenSpaceEventType.LEFT_CLICK, oldClick]]) {
        if (action) handler.setInputAction(action, event); else handler.removeInputAction(event);
      }
      if (source) viewer.dataSources.remove(source, true);
      panel.destroy(); records.clear(); segmentById.clear(); segmentsByDirection.clear(); staticSegments.clear(); segmentStatus.clear();
    },
  };
}
