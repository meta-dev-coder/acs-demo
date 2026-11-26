/**
 * The Seagirt map: real terminal geography, the illustrative electrical equipment, the schematic
 * supply links between them and the feeders they carry — drawn from the registry, styled from the
 * shared view model (`viewModel.js`), which the single-line diagram reads too.
 *
 * Nothing here decides a power state or what an investigation is about: `buildViewModel` does,
 * from engine results. This module only turns that model into entities and keeps them in step —
 * an entity's image, label or material is reassigned only when its own key changes.
 *
 * FEEDERS. A feeder has no position; the schematic link that carries it is its segment on the map.
 * The segment and the feeder's label (at the segment's midpoint) both select the feeder. Straight
 * lines between illustrative points are never cable routes, and the legend says so. When verified
 * cable geometry arrives, the same feeder id can be drawn along it instead.
 *
 * LABELS. Distance tiers decide which labels may show; a light collision pass after each render
 * then hides the lower-priority label wherever two would overlap (the investigation's assets first).
 *
 * GIS ASSOCIATION. The OpenStreetMap substation is drawn as public geography, with a dashed link to
 * the illustrative SS1 it may be: a CANDIDATE association, inspectable, never merged silently.
 * `setAnchor` can show SS1 at the footprint instead — a display choice that leaves the registry as is.
 */
import {
  Cartesian2, Cartesian3, Color, ColorMaterialProperty, ConstantProperty, ConstantPositionProperty, DistanceDisplayCondition, HeightReference,
  Cartographic, LabelStyle, Math as CMath, SceneTransforms, NearFarScalar, PolylineDashMaterialProperty, ScreenSpaceEventHandler, ScreenSpaceEventType,
  VerticalOrigin, BoundingSphere, HeadingPitchRange,
} from 'cesium';
import { energize } from './electricalGraph.js';
import { distanceM, lerp, offsetM, ringCentroid } from './geo.js';
import { FlowMaterialProperty } from './flowMaterial.js';
import { markerImage } from './seagirtIcons.js';
import { buildViewModel, schematicLinks } from './viewModel.js';

export { schematicLinks };

export const COLORS = Object.freeze({
  energized: Color.fromCssColorString('#2ea043'),
  lost: Color.fromCssColorString('#e5484d'),
  unknown: Color.fromCssColorString('#f5a623'),
  flow: Color.fromCssColorString('#38d6ff'),
  flowLive: Color.fromCssColorString('#3ddc84'),
  open: Color.fromCssColorString('#b9a3ff'),
  boundary: Color.fromCssColorString('#5fd4f4').withAlpha(0.7),
  osm: Color.fromCssColorString('#f5c451'),
});

const HEADING = CMath.toRadians(-28);
const SIZE = Object.freeze({ MAJOR: 38, DETAIL: 30 });
const LABEL_BG = Object.freeze({
  plain: Color.fromCssColorString('#0b1626').withAlpha(0.86),
  bad: Color.fromCssColorString('#5a1015').withAlpha(0.94),
  good: Color.fromCssColorString('#0f3d22').withAlpha(0.94),
  focus: Color.fromCssColorString('#123a6b').withAlpha(0.95),
  cond: Color.fromCssColorString('#2e2357').withAlpha(0.94),
  warn: Color.fromCssColorString('#4a3410').withAlpha(0.94),
  feeder: Color.fromCssColorString('#10303f').withAlpha(0.9),
});
const LABEL_FG = Object.freeze({ bad: '#ffd0d2', good: '#c9f5d6', cond: '#e2d8ff', warn: '#ffe2a8', feeder: '#bfefff' });
const DIM = Color.WHITE.withAlpha(0.32);
const WIDTH = Object.freeze({ selected: 11, strong: 8, normal: 6, soft: 5 });

export function createElectricalLayer(viewer, { geography, network, associations = [], onSelect = () => {}, reducedMotion = false }) {
  const entities = viewer.entities;
  const own = [];
  const add = spec => { const e = entities.add(spec); own.push(e); return e; };
  const anchors = new Map();      // asset id → [lon, lat] shown instead of the registry position (display only)
  const lonlatOf = id => {
    if (anchors.has(id)) return anchors.get(id);
    const a = network.assets.get(id);
    return Number.isFinite(a?.location?.longitude) ? [a.location.longitude, a.location.latitude] : null;
  };
  const cart = ll => Cartesian3.fromDegrees(ll[0], ll[1]);
  const baseline = energize(network);

  // ---- geography (real, attributed) ----
  const geo = { boundary: [], building: [], road: [], berth: [], osmSubstation: [] };
  for (const f of geography.features) {
    const p = f.properties;
    if (f.geometry.type === 'Polygon') {
      const ring = f.geometry.coordinates[0].flat();
      if (p.layer === 'boundary') {
        geo.boundary.push(add({ id: 'geo:boundary', name: p.name, polyline: { positions: Cartesian3.fromDegreesArray(ring), width: 2, clampToGround: true,
          material: COLORS.boundary }, properties: { kind: 'geography', ...p } }));
      } else if (p.layer === 'building') {
        geo.building.push(add({ id: `geo:${f.id}`, polygon: { hierarchy: Cartesian3.fromDegreesArray(ring), material: Color.fromCssColorString('#9aa7b6').withAlpha(0.22),
          outline: false, heightReference: HeightReference.CLAMP_TO_GROUND }, properties: { kind: 'geography', ...p } }));
      } else if (p.layer === 'osmSubstation') {
        geo.osmSubstation.push(add({ id: 'geo:osm-substation', name: p.name, polygon: { hierarchy: Cartesian3.fromDegreesArray(ring), material: COLORS.osm.withAlpha(0.2),
          heightReference: HeightReference.CLAMP_TO_GROUND }, properties: { kind: 'geography', featureId: f.id, ...p } }));
        geo.osmSubstation.push(add({ id: 'geo:osm-substation-outline', polyline: { positions: Cartesian3.fromDegreesArray(ring), width: 2, clampToGround: true,
          material: new PolylineDashMaterialProperty({ color: COLORS.osm.withAlpha(0.9), dashLength: 10 }) }, properties: { kind: 'geography', featureId: f.id, ...p } }));
      }
    } else if (f.geometry.type === 'LineString') {
      const line = Cartesian3.fromDegreesArray(f.geometry.coordinates.flat());
      if (p.layer === 'road') geo.road.push(add({ id: `geo:${f.id}`, polyline: { positions: line, width: 1.5, clampToGround: true, material: Color.WHITE.withAlpha(0.3) }, properties: { kind: 'geography', ...p } }));
      if (p.layer === 'berth') geo.berth.push(add({ id: 'geo:berth', name: p.name, polyline: { positions: line, width: 3, clampToGround: true, material: Color.fromCssColorString('#5ec8f2').withAlpha(0.55) }, properties: { kind: 'geography', ...p } }));
    }
  }

  // ---- GIS ↔ electrical associations: a dashed link and a label saying what the footprint may be ----
  const assoc = associations.map(x => {
    const feature = geography.features.find(f => f.id === x.geographicFeatureId);
    const centroid = feature ? ringCentroid(feature.geometry.coordinates[0]) : [x.anchor.longitude, x.anchor.latitude];
    const line = add({ id: `assoc:${x.electricalAssetId}`, polyline: { positions: [cart(lonlatOf(x.electricalAssetId)), cart(centroid)], width: 2.5, clampToGround: true,
      material: new PolylineDashMaterialProperty({ color: COLORS.osm, dashLength: 12 }) }, properties: { kind: 'association', assetId: x.electricalAssetId } });
    const tag = add({ id: `assoc-label:${x.electricalAssetId}`, position: cart(centroid),
      label: { text: `OSM substation · candidate for ${x.electricalAssetId}`, font: '600 11.5px Inter, system-ui, sans-serif', fillColor: Color.fromCssColorString('#ffe7a8'),
        style: LabelStyle.FILL, showBackground: true, backgroundColor: Color.fromCssColorString('#3b2d0a').withAlpha(0.92), backgroundPadding: new Cartesian2(7, 4),
        heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new DistanceDisplayCondition(0, 3200) },
      properties: { kind: 'association', assetId: x.electricalAssetId } });
    return { ...x, centroid, line, tag, text: `OSM substation · candidate for ${x.electricalAssetId}`, wantLabel: true, collided: false };
  });
  geo.osmSubstation.push(...assoc.flatMap(a => [a.line, a.tag]));

  // ---- equipment markers ----
  const markers = new Map();
  for (const a of network.assets.values()) {
    if (!lonlatOf(a.id)) continue;
    const size = SIZE[a.mapTier] ?? SIZE.DETAIL;
    const entity = add({
      id: `asset:${a.id}`, name: a.name, position: cart(lonlatOf(a.id)),
      billboard: { image: markerImage(a.assetType, 'ENERGIZED'), width: size, height: size,
        heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new NearFarScalar(500, 1, 9000, 0.6) },
      label: { text: a.id, font: '600 12.5px Inter, system-ui, sans-serif', fillColor: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 0,
        style: LabelStyle.FILL, showBackground: true, backgroundColor: LABEL_BG.plain, backgroundPadding: new Cartesian2(7, 4),
        verticalOrigin: VerticalOrigin.BOTTOM, pixelOffset: new Cartesian2(0, -(size / 2 + 5)),
        heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new NearFarScalar(500, 1, 9000, 0.8) },
      properties: { kind: 'asset', assetId: a.id, tier: a.mapTier },
    });
    markers.set(a.id, { entity, asset: a, size, key: '', labelKey: '', wantLabel: false, collided: false, text: a.id, far: 0, priority: 0 });
  }

  // ---- schematic links (feeder segments where they carry a feeder) and feeder labels ----
  const flowSpeed = reducedMotion ? 0 : 0.012;
  const linkDefs = schematicLinks(network);
  const links = linkDefs.map(l => {
    const a = lonlatOf(l.fromAssetId), b = lonlatOf(l.toAssetId);
    const repeat = Math.max(2, distanceM(a, b) / 55);   // a chevron every ~55 m, whatever the link's length
    const entity = add({ id: `link:${l.id}`, polyline: { positions: [cart(a), cart(b)], width: 3, clampToGround: true, material: COLORS.flow },
      properties: { kind: 'link', linkId: l.id, ...(l.feederId ? { assetId: l.feederId } : {}) }, show: false });
    return { ...l, entity, key: '',
      mats: {
        flow: new FlowMaterialProperty({ color: COLORS.flow, speed: flowSpeed, repeat }),
        flowSoft: new FlowMaterialProperty({ color: COLORS.flow.withAlpha(0.95), speed: flowSpeed * 0.5, repeat: repeat * 0.8 }),
        live: new FlowMaterialProperty({ color: COLORS.flowLive, speed: flowSpeed, repeat }),
        liveSoft: new FlowMaterialProperty({ color: COLORS.flowLive.withAlpha(0.7), speed: flowSpeed * 0.5, repeat: repeat * 0.8 }),
        lost: new ColorMaterialProperty(COLORS.lost.withAlpha(0.95)),
        open: new PolylineDashMaterialProperty({ color: COLORS.open.withAlpha(0.75), dashLength: 14 }),
        conditional: new PolylineDashMaterialProperty({ color: COLORS.open, gapColor: COLORS.open.withAlpha(0.12), dashLength: 16 }),
        unknown: new PolylineDashMaterialProperty({ color: COLORS.unknown, dashLength: 14 }),
        dim: new PolylineDashMaterialProperty({ color: Color.fromCssColorString('#8b98a9').withAlpha(0.3), dashLength: 14 }),
      } };
  });
  const feederLabels = new Map();
  for (const l of links) {
    if (!l.feederId) continue;
    const mid = lerp(lonlatOf(l.fromAssetId), lonlatOf(l.toAssetId), 0.5);
    const entity = add({ id: `feeder:${l.feederId}`, position: cart(mid), show: false,
      label: { text: l.feederId, font: '700 11.5px Inter, system-ui, sans-serif', fillColor: Color.fromCssColorString(LABEL_FG.feeder), style: LabelStyle.FILL,
        showBackground: true, backgroundColor: LABEL_BG.feeder, backgroundPadding: new Cartesian2(6, 3),
        heightReference: HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new NearFarScalar(500, 1, 9000, 0.8), distanceDisplayCondition: new DistanceDisplayCondition(0, 7000) },
      properties: { kind: 'feeder', assetId: l.feederId } });
    feederLabels.set(l.feederId, { entity, link: l, mid, key: '', wantLabel: false, collided: false, text: l.feederId, priority: 0, far: 7000 });
  }

  // ---- view ----
  let view = { mode: 'overview', feedersLayer: false, selectedId: null, pinnedId: null, focus: null };
  let scenario = null;
  let model = null;
  const linkState = new Map();
  const geoVisible = { boundary: true, building: true, road: false, berth: true, osmSubstation: true };

  const labelShow = m => m.wantLabel && !m.collided;
  function setMarker(m, s) {
    const key = `${s.ring}|${s.role === 'selected'}|${s.dimmed}|${s.show}`;
    if (key !== m.key) {
      m.key = key;
      const sel = s.role === 'selected';
      m.entity.billboard.image = new ConstantProperty(markerImage(m.asset.assetType, s.ring, sel));
      m.entity.billboard.color = new ConstantProperty(s.dimmed ? DIM : Color.WHITE);
      m.entity.billboard.width = new ConstantProperty(m.size + (sel ? 8 : 0));
      m.entity.billboard.height = new ConstantProperty(m.size + (sel ? 8 : 0));
      m.entity.show = s.show;
    }
    m.wantLabel = s.labelShow && s.show;
    m.text = s.label; m.far = s.labelFar; m.priority = s.priority;
    const labelKey = `${s.label}|${s.labelStyle}|${s.labelFar}|${labelShow(m)}`;
    if (labelKey !== m.labelKey) {
      m.labelKey = labelKey;
      m.entity.label.text = new ConstantProperty(s.label);
      m.entity.label.backgroundColor = new ConstantProperty(LABEL_BG[s.labelStyle] ?? LABEL_BG.plain);
      m.entity.label.fillColor = new ConstantProperty(Color.fromCssColorString(LABEL_FG[s.labelStyle] ?? '#ffffff'));
      m.entity.label.pixelOffset = new ConstantProperty(new Cartesian2(0, -((m.size + (s.role === 'selected' ? 8 : 0)) / 2 + 5)));
      m.entity.label.show = new ConstantProperty(labelShow(m));
      m.entity.label.distanceDisplayCondition = new ConstantProperty(new DistanceDisplayCondition(0, s.labelFar));
    }
  }
  function setLink(l, s) {
    const key = `${s.kind}|${s.emphasis}`;
    linkState.set(l.id, s.kind);
    if (key === l.key) return;
    l.key = key;
    l.entity.show = s.kind !== 'hidden';
    if (s.kind === 'hidden') return;
    l.entity.polyline.material = s.kind === 'live' && s.emphasis === 'soft' ? l.mats.liveSoft : l.mats[s.kind];
    l.entity.polyline.width = new ConstantProperty(s.kind === 'lost' ? Math.max(5, WIDTH[s.emphasis] - 2)
      : ['open', 'conditional', 'unknown', 'dim'].includes(s.kind) ? (s.emphasis === 'strong' || s.kind === 'conditional' ? 5 : 3) : WIDTH[s.emphasis]);
  }
  function setFeeder(f, s) {
    f.wantLabel = s.show;
    f.text = s.text; f.priority = s.priority; f.far = s.priority >= 60 ? 30000 : 7000;
    const key = `${s.text}|${s.style}|${f.far}|${labelShow(f)}`;
    if (key === f.key) return;
    f.key = key;
    f.entity.show = labelShow(f);
    f.entity.label.text = new ConstantProperty(s.text);
    f.entity.label.backgroundColor = new ConstantProperty(LABEL_BG[s.style] ?? LABEL_BG.feeder);
    f.entity.label.fillColor = new ConstantProperty(Color.fromCssColorString(LABEL_FG[s.style] ?? '#ffffff'));
    f.entity.label.distanceDisplayCondition = new ConstantProperty(new DistanceDisplayCondition(0, f.far));
  }

  function render() {
    model = buildViewModel({ network, links: linkDefs, baseline, scenario, view });
    for (const [id, m] of markers) setMarker(m, model.assets.get(id));
    for (const l of links) setLink(l, model.links.get(l.id));
    for (const [id, f] of feederLabels) setFeeder(f, model.feeders.get(id));
    for (const a of assoc) { a.line.show = geoVisible.osmSubstation && !anchors.has(a.electricalAssetId); a.wantLabel = geoVisible.osmSubstation; a.tag.show = labelShow(a); }
    viewer.scene.requestRender();
    return model;
  }

  // ---- label collision: highest priority first; a label that would overlap one already placed waits ----
  // Sampled each time: the terrain under a point refines as tiles load, so an early height can be far off.
  const heightAt = ll => viewer.scene.globe.getHeight(Cartographic.fromDegrees(ll[0], ll[1])) ?? 0;
  const screen = (key, ll) => SceneTransforms.worldToWindowCoordinates(viewer.scene, Cartesian3.fromDegrees(ll[0], ll[1], heightAt(ll)));
  let lastCollision = 0;
  let occlude = { left: 0, right: 0, top: 0, bottom: 0 };   // map area covered by panels
  let lastBoxes = [];
  function resolveLabels() {
    const camPos = viewer.camera.positionWC;
    const items = [];
    for (const [id, m] of markers) {
      if (!m.wantLabel) { m.collided = false; continue; }
      const ll = lonlatOf(id);
      if (Cartesian3.distance(camPos, Cartesian3.fromDegrees(ll[0], ll[1])) > m.far) continue;
      const p = screen(id, ll);
      if (!p) continue;
      const w = m.text.length * 7.4 + 16, h = 21, up = m.size / 2 + 5;
      items.push({ m, box: [p.x - w / 2, p.y - up - h, p.x + w / 2, p.y - up], priority: m.priority });
    }
    // A feeder label may slide along its own segment to make room; it is hidden only if no spot is free.
    for (const [, f] of feederLabels) {
      if (!f.wantLabel) { f.collided = false; continue; }
      const a = lonlatOf(f.link.fromAssetId), b = lonlatOf(f.link.toAssetId);
      const w = f.text.length * 7 + 14;
      const spots = [0.5, 0.35, 0.65, 0.22, 0.78].map(t => {
        const ll = lerp(a, b, t), p = screen(`f:${f.link.feederId}`, ll);
        return p && { ll, box: [p.x - w / 2, p.y - 10, p.x + w / 2, p.y + 10] };
      }).filter(Boolean);
      if (spots.length) items.push({ m: f, box: spots[0].box, spots, priority: f.priority });
    }
    for (const a of assoc) {
      a.wantLabel = geoVisible.osmSubstation;
      if (!a.wantLabel || Cartesian3.distance(camPos, cart(a.centroid)) > 3200) continue;
      const p = screen(`assoc:${a.electricalAssetId}`, a.centroid);
      if (!p) continue;
      const w = a.text.length * 6.6 + 14;
      items.push({ m: a, box: [p.x - w / 2, p.y - 10, p.x + w / 2, p.y + 10], priority: 30 });
    }
    items.sort((a, b) => b.priority - a.priority);
    lastBoxes = items;
    const placed = [];
    let changed = false;
    const W = viewer.canvas.clientWidth, H = viewer.canvas.clientHeight;
    // Off the visible map (its edges, or under a panel) counts as a collision: a label is shown whole or not at all.
    const overlaps = ([x1, y1, x2, y2]) => x1 < occlude.left + 2 || y1 < occlude.top + 2 || x2 > W - occlude.right - 2 || y2 > H - occlude.bottom - 2
      || placed.some(([a1, b1, a2, b2]) => x1 < a2 && x2 > a1 && y1 < b2 && y2 > b1);
    for (const it of items) {
      const spot = it.spots ? it.spots.find(sp => !overlaps(sp.box)) : null;
      if (spot) {
        it.box = spot.box;
        if (spot.ll[0] !== it.m.mid[0] || spot.ll[1] !== it.m.mid[1]) { it.m.mid = spot.ll; it.m.entity.position = new ConstantPositionProperty(cart(spot.ll)); changed = true; }
      }
      const hit = it.spots ? !spot : overlaps(it.box);
      if (hit !== it.m.collided) { it.m.collided = hit; changed = true; }
      if (!hit) placed.push(it.box);
    }
    if (!changed) return;
    for (const [, m] of markers) { m.entity.label.show = new ConstantProperty(labelShow(m)); m.labelKey = ''; }
    for (const [, f] of feederLabels) { f.entity.show = labelShow(f); f.key = ''; }
    for (const a of assoc) a.tag.show = labelShow(a);
    viewer.scene.requestRender();
  }
  const onPostRender = () => {
    const now = performance.now();
    if (now - lastCollision < 160) return;
    lastCollision = now;
    resolveLabels();
  };
  viewer.scene.postRender.addEventListener(onPostRender);
  // A camera that stops between throttled passes still gets one last pass.
  const onMoveEnd = () => { lastCollision = 0; viewer.scene.requestRender(); };
  viewer.camera.moveEnd.addEventListener(onMoveEnd);

  // ---- picking ----
  const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
  const propsAt = position => {
    // Several entities can sit under a click (a feeder label over its own segment); the first that names something wins.
    for (const picked of viewer.scene.drillPick(position, 6)) {
      const props = picked?.id?.properties;
      const kind = props?.kind?.getValue?.();
      if (kind) return { kind, props };
    }
    return null;
  };
  handler.setInputAction(click => {
    const hit = propsAt(click.position);
    if (!hit) return onSelect(null);
    const { kind, props } = hit;
    if (kind === 'asset' || kind === 'feeder' || (kind === 'link' && props.assetId)) onSelect({ assetId: props.assetId.getValue() });
    else if (kind === 'association') onSelect({ association: props.assetId.getValue() });
    else if (kind === 'geography') onSelect({ geography: Object.fromEntries(props.propertyNames.map(n => [n, props[n].getValue()])) });
    else onSelect(null);
  }, ScreenSpaceEventType.LEFT_CLICK);
  handler.setInputAction(move => {
    const props = viewer.scene.pick(move.endPosition)?.id?.properties;
    const k = props?.kind?.getValue?.();
    viewer.canvas.style.cursor = k === 'asset' || k === 'feeder' || k === 'association' || (k === 'link' && props.assetId) ? 'pointer' : '';
  }, ScreenSpaceEventType.MOUSE_MOVE);

  // ---- camera ----
  const boundary = geography.features.find(f => f.properties.layer === 'boundary');
  let flights = 0;   // framing flights in progress (a re-fly to fit counts as its own flight)
  const inView = (ll, key, { right = 0, left = 0, bottom = 0, top = 0 }) => {
    const w = viewer.canvas.clientWidth || 1, h = viewer.canvas.clientHeight || 1;
    const p = screen(key, ll);
    return Boolean(p) && p.x > left + 30 && p.x < w - right - 30 && p.y > top + 70 && p.y < h - bottom - 20;
  };
  /**
   * Fly so `lonlats` fill the map area left uncovered by the panels: the range grows for the
   * narrower area and the target moves right, so the content sits centred in what is visible.
   */
  function frame(lonlats, { pitchDeg = -55, rangeScale = 2.4, minRange = 450, duration = 1.4, insets = {} } = {}, attempt = 0) {
    if (!lonlats.length) return;
    const { right = 0, left = 0, bottom = 0, top = 0 } = insets;
    const sphere = BoundingSphere.fromPoints(lonlats.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat)));
    const w = viewer.canvas.clientWidth || 1, h = viewer.canvas.clientHeight || 1;
    const visible = Math.max(0.3, Math.min((w - right - left) / w, (h - top - bottom) / h));
    const range = Math.max(minRange, sphere.radius * rangeScale) / visible;
    const fov = viewer.camera.frustum.fov ?? CMath.toRadians(60);
    const mpp = (2 * range * Math.tan(fov / 2)) / w;
    const shift = ((right - left) / 2) * mpp, up = ((bottom - top) / 2) * mpp;
    const c = [lonlats.reduce((s, p) => s + p[0], 0) / lonlats.length, lonlats.reduce((s, p) => s + p[1], 0) / lonlats.length];
    const target = offsetM(c, shift * Math.cos(HEADING) - up * Math.sin(HEADING), -shift * Math.sin(HEADING) - up * Math.cos(HEADING));
    // The far side of a pitched view is foreshortened, so the estimate can still leave a point under
    // a panel: check where everything landed and pull back a little until it all shows.
    const fits = () => lonlats.every((ll, i) => inView(ll, `frame:${i}:${ll}`, insets));
    flights += 1;
    viewer.camera.flyToBoundingSphere(new BoundingSphere(Cartesian3.fromDegrees(target[0], target[1]), 1), {
      duration, offset: new HeadingPitchRange(HEADING, CMath.toRadians(pitchDeg), range),
      complete: () => {
        flights -= 1;
        if (attempt < 3 && !fits()) frame(lonlats, { pitchDeg, rangeScale: rangeScale * 1.25, minRange: minRange * 1.25, duration: 0.5, insets }, attempt + 1);
      },
      cancel: () => { flights -= 1; },
    });
  }

  /** Move an asset's marker (and its links) to another position on the map — display only. */
  function setAnchor(id, ll) {
    if (ll) anchors.set(id, ll); else anchors.delete(id);
    const m = markers.get(id);
    if (m) m.entity.position = new ConstantPositionProperty(cart(lonlatOf(id)));
    for (const l of links) {
      if (l.fromAssetId !== id && l.toAssetId !== id) continue;
      l.entity.polyline.positions = new ConstantProperty([cart(lonlatOf(l.fromAssetId)), cart(lonlatOf(l.toAssetId))]);
      const f = l.feederId && feederLabels.get(l.feederId);
      if (f) { f.mid = lerp(lonlatOf(l.fromAssetId), lonlatOf(l.toAssetId), 0.5); f.entity.position = new ConstantPositionProperty(cart(f.mid)); }
    }
    render();
  }

  /** Where an asset (or a feeder's label) is drawn, as [lon, lat]. */
  const drawnAt = id => lonlatOf(id) ?? feederLabels.get(id)?.mid ?? null;

  render();
  return {
    links,
    render,
    /** The view model last drawn (the single-line diagram draws the same one). */
    model: () => model,
    view: () => view,
    setView(next) { view = { ...view, ...next }; return render(); },
    setScenario(result) { scenario = result; return render(); },
    status: () => Object.fromEntries([...markers.keys()].map(id => [id, model.assets.get(id).ring])),
    linkStates: () => Object.fromEntries(linkState),
    feederStates: () => Object.fromEntries([...feederLabels].map(([id, f]) => [id, { shown: labelShow(f), wanted: f.wantLabel, text: f.text, kind: model.links.get(f.link.id).kind }])),
    labelsShown: () => [...markers].filter(([, m]) => labelShow(m)).map(([id]) => id),
    /** The label boxes of the last collision pass (screen pixels), with whether each was hidden. */
    labelBoxes: () => lastBoxes.map(it => ({ text: it.m.text, box: it.box.map(Math.round), priority: it.priority, hidden: it.m.collided })),
    setLayerVisible(name, visible) {
      geoVisible[name] = visible;
      for (const e of geo[name] ?? []) e.show = visible;
      render();
    },
    layers: () => Object.fromEntries(Object.entries(geo).map(([k, v]) => [k, v.length])),
    setAnchor,
    anchorOf: id => anchors.get(id) ?? null,
    /** The map area the page's panels cover, where no label is placed. */
    setOcclusion(next) { occlude = { left: 0, right: 0, top: 0, bottom: 0, ...next }; lastCollision = 0; viewer.scene.requestRender(); },
    /** Is a framing flight still under way? */
    flying: () => flights > 0,
    drawnAt,
    /** Window position (CSS pixels within the canvas) of an asset marker or a feeder label. */
    screenOf(id) {
      const ll = drawnAt(id);
      return ll ? screen(feederLabels.has(id) ? `f:${id}` : id, ll) : null;
    },
    /** Is every one of these on screen, outside the panels? (So a click in a result list need not fly.) */
    isVisible(ids, insets = {}) {
      const pts = ids.map(id => [id, drawnAt(id)]).filter(([, ll]) => ll);
      return pts.length > 0 && pts.every(([id, ll]) => inView(ll, feederLabels.has(id) ? `f:${id}` : id, insets));
    },
    flyHome({ insets = {}, ...options } = {}) {
      frame(boundary.geometry.coordinates[0], { rangeScale: 2.05, pitchDeg: -58, insets: { bottom: 90, ...insets }, ...options });
    },
    /** Frame these assets (feeders by their segment) within the uncovered part of the map. */
    flyToAssets(ids, { insets = {}, ...options } = {}) {
      const pts = [...new Set(ids)].map(drawnAt).filter(Boolean);
      if (pts.length) frame(pts, { rangeScale: pts.length > 1 ? 1.9 : 1, minRange: pts.length > 1 ? 520 : 600, insets, ...options });
    },
    /** Every positioned asset: the electrical network, rather than the whole terminal outline. */
    flyToNetwork({ insets = {}, ...options } = {}) {
      frame([...markers.keys()].map(lonlatOf), { rangeScale: 1.7, pitchDeg: -55, insets, ...options });
    },
    destroy() {
      handler.destroy();
      viewer.scene.postRender.removeEventListener(onPostRender);
      viewer.camera.moveEnd.removeEventListener(onMoveEnd);
      for (const e of own) entities.remove(e);
    },
  };
}
