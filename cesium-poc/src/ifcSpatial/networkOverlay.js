/**
 * The IFC network drawn the way the what-if mock draws it: cable routes from the IFC, clamped to the
 * ground and coloured by voltage and state; the mock's equipment symbols at each element's IFC
 * position; the SCADA fibre dashed; zone labels. One CustomDataSource in the IFC Spatial Twin's own
 * viewer, so nothing here can reach the electrical twin's map.
 *
 * `update(view)` restyles everything from one view: node and cable states (live, dead, backup =
 * on generator, off = failed or cut), open switches, the selection, and the assets an answer is
 * about (everything else is dimmed). Picks come back as asset ids via `assetAt(picked)`.
 *
 * Every asset is a status tile (mockStyle.tileImage): its symbol in a dark tile with a soft glow in
 * its status colour (voltage colour for powered equipment, green for powered loads, red without
 * power, amber degraded, grey standby). An outage investigation (`view.investigation`) draws
 * confirmed-affected cables red, potentially affected ones amber dashed, the supply path emphasised
 * and the rest muted. An asset with an alert marker (`view.markerIds`) carries its id on the marker.
 */
import {
  CallbackProperty, Cartesian2, Cartesian3, Color, ConstantProperty, CustomDataSource, DistanceDisplayCondition, HorizontalOrigin,
  LabelStyle, NearFarScalar, PolylineDashMaterialProperty, PolylineGlowMaterialProperty, PolylineOutlineMaterialProperty, VerticalOrigin,
} from 'cesium';
import { COLORS, MAIN_SUBSTATION_BOX, mockPxToModel, tileImage, TILE_SIZE, ZONES } from './mockStyle.js';
import { symbolOf, voltageClass } from './ifcNetwork.js';
import { FlowMaterialProperty } from '../seagirt/flowMaterial.js';

/** Wide enough for the flow chevrons to read, as on the electrical twin. */
const WIDTH = { hv: 8, mv: 6.5, lv: 5 };
/** An outage investigation: the hierarchy by voltage class, calm, so the affected lines stand out. */
const OPS_WIDTH = { hv: 5, mv: 4, lv: 2.6 };
const OPS_COLOR = { hv: '#b48cff', mv: '#3fc8ff', lv: '#58c9a6' };

const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
/** Symbols whose labels appear only closer in, as the mock shows them only when zoomed. */
const MINOR = new Set(['vault', 'mast', 'tx', 'ats']);
const SHORT = { R1: 'Reefers W', R2: 'Reefers E', GATE: 'Gate', OPS: 'Ops / SCADA', 'ICTF-OFF': 'ICTF office', WS: 'M&R shop' };

export function createNetworkOverlay(viewer, { built, modelToLonLat, scadaRoutes = [], baseHeight = 0 }) {
  const source = new CustomDataSource('ifc-network');
  void viewer.dataSources.add(source);
  const control = new CustomDataSource('ifc-control');
  void viewer.dataSources.add(control);
  const zones = new CustomDataSource('ifc-zones');
  void viewer.dataSources.add(zones);

  const color = (hex, alpha = 1) => Color.fromCssColorString(hex).withAlpha(alpha);
  // Lines sit just above the ground at the model's base height (not clamped: ground-clamped polylines
  // need terrain tiles to draw, and the drawing should not depend on them).
  const lift = baseHeight + 1.5;
  const position = asset => Cartesian3.fromDegrees(asset.location.longitude, asset.location.latitude, lift + 0.5);
  const line = points => points.map(p => Cartesian3.fromDegrees(p.lon, p.lat, lift));
  const images = new Map();
  const imageFor = (kind, opts) => {
    const key = `${kind}|${opts.state}|${opts.kv}|${opts.selected}|${opts.open}|${opts.degraded}|${opts.tint}`;
    if (!images.has(key)) images.set(key, tileImage(kind, opts));
    return images.get(key);
  };

  const routes = new Map(), nodes = new Map();
  for (const asset of built.assets) {
    if (asset.route?.length >= 2) {
      const kv = voltageClass(asset) ?? 'mv';
      const forward = line(asset.route);
      const lengthM = asset.route.slice(1).reduce((sum, p, i) => sum + Cartesian3.distance(forward[i], forward[i + 1]), 0);
      const entity = source.entities.add({
        id: `route:${asset.id}`,
        polyline: { positions: line(asset.route), width: WIDTH[kv], arcType: 0,
          material: new PolylineOutlineMaterialProperty({ color: color(COLORS[kv]), outlineColor: color(COLORS.casing, 0.75), outlineWidth: 1.2 }),
          // Drawn over the 3D IFC geometry too: where the model hides a line, it shows through, fainter.
          depthFailMaterial: color(COLORS[kv], 0.55) },
      });
      routes.set(asset.id, { entity, kv, forward, reverse: [...forward].reverse(), lengthM, dir: 'forward', flows: new Map() });
      continue;
    }
    const kind = symbolOf(asset);
    // Unit transformers sit inside their ring main unit's symbol, as the mock draws them; circuit breakers
    // are not drawn (they stay in the network, the answers and the inspector).
    if (!kind || kind === 'tx' || asset.assetType === 'CIRCUIT_BREAKER' || !Number.isFinite(asset.location?.longitude)) continue;
    const size = TILE_SIZE[kind] ?? 30;
    const entity = source.entities.add({
      id: `node:${asset.id}`, position: position(asset),
      billboard: { image: imageFor(kind, { state: 'live', kv: voltageClass(asset) ?? 'mv' }), width: size, height: size,
        disableDepthTestDistance: Number.POSITIVE_INFINITY, scaleByDistance: new NearFarScalar(300, 1.35, 6000, 0.85) },
      label: { text: SHORT[asset.id] ?? asset.id, font: '500 12px "IBM Plex Mono", ui-monospace, monospace', fillColor: Color.fromCssColorString('#edf3f8'),
        outlineColor: color('#071019'), outlineWidth: 3.5, style: LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: kind === 'sts' ? HorizontalOrigin.CENTER : HorizontalOrigin.LEFT, verticalOrigin: kind === 'sts' ? VerticalOrigin.TOP : VerticalOrigin.CENTER,
        pixelOffset: kind === 'sts' ? new Cartesian2(0, 14) : new Cartesian2(size / 2 + 4, 0),
        disableDepthTestDistance: Number.POSITIVE_INFINITY, scaleByDistance: new NearFarScalar(300, 1.15, 6000, 0.85),
        distanceDisplayCondition: MINOR.has(kind) || kind === 'sts' ? new DistanceDisplayCondition(0, 1100) : undefined },
    });
    nodes.set(asset.id, { entity, kind, kv: voltageClass(asset) ?? 'mv', size, text: SHORT[asset.id] ?? asset.id, ddc: entity.label.distanceDisplayCondition });
  }

  // The SCADA fibre: control, not power, dashed as the mock draws it.
  for (const route of scadaRoutes) {
    control.entities.add({ id: `ctl:${route.id}`, polyline: { positions: line(route.points), width: 1.6, arcType: 0,
      material: new PolylineDashMaterialProperty({ color: color(COLORS.ctl, 0.8), dashLength: 10 }) } });
  }

  // Zone labels and the main-substation box, from the mock's reference image (see mockStyle.js).
  for (const zone of ZONES) {
    const at = modelToLonLat(...mockPxToModel(zone.px), 0);
    zones.entities.add({ position: Cartesian3.fromDegrees(at.lon, at.lat, lift + 1), label: { text: zone.text, font: '600 11px "IBM Plex Sans Condensed", system-ui, sans-serif',
      fillColor: color('#d6e5f2', 0.85), outlineColor: color('#071019'), outlineWidth: 3, style: LabelStyle.FILL_AND_OUTLINE, disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new NearFarScalar(400, 1.1, 5000, 0.7) } });
  }
  {
    const [x, y, w, h] = MAIN_SUBSTATION_BOX;
    const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]].map(p => modelToLonLat(...mockPxToModel(p), 0));
    zones.entities.add({ polyline: { positions: line(corners), width: 1.4, arcType: 0,
      material: new PolylineDashMaterialProperty({ color: color('#9fd8ff', 0.6), dashLength: 8 }) } });
  }

  let last = null;
  let labelsOn = true;
  function update(view) {
    last = view;
    const { nodeState, openSwitches, selectedId = null, focus = null } = view;
    const inv = view.investigation ?? null;
    const dim = id => (focus && !focus.has(id)) || (inv && !inv.all.has(id));
    // view.highlight: asset id → colour, or {hex, weak} (a version comparison's changes; weak: a
    // property-only change, drawn thin and without glow); view.dimAlpha: how faint the rest is.
    const hlOf = id => { const v = view.highlight?.get(id); return v == null ? null : typeof v === 'string' ? v : v.hex; };
    const weakOf = id => Boolean(view.highlight?.get(id)?.weak);
    const faint = view.dimAlpha ?? 0.3;
    for (const [id, n] of nodes) {
      const raw = nodeState.get(id) ?? 'live';
      const hl = hlOf(id);
      n.entity.billboard.image = new ConstantProperty(imageFor(n.kind, { state: raw, kv: n.kv, selected: id === selectedId, open: openSwitches.has(id), degraded: Boolean(view.degraded?.has(id)) && raw === 'live', tint: hl }));
      n.entity.billboard.color = new ConstantProperty(Color.WHITE.withAlpha(dim(id) ? (hl ? 0.55 : faint) : 1));
      // During a simulation, what lost power says so on the map, as on the electrical twin.
      // Outside one, what the IFC model itself leaves unpowered (view.alert) is flagged and pulses.
      const alerted = Boolean(view.alert?.has(id));
      const flagged = (view.stateLabels || alerted) && (raw === 'dead' || raw === 'off') && !['vault'].includes(n.kind);
      if (alerted !== Boolean(n.pulsing)) {
        n.pulsing = alerted;
        n.entity.billboard.scale = alerted && !reducedMotion
          ? new CallbackProperty(() => 1 + 0.22 * (0.5 + 0.5 * Math.sin(performance.now() / 260)), false)
          : new ConstantProperty(alerted ? 1.2 : 1);
      }
      n.entity.label.text = new ConstantProperty(flagged ? `${n.text} · ${raw === 'off' ? 'OFFLINE' : 'NO POWER'}` : n.text);
      n.entity.label.showBackground = new ConstantProperty(flagged);
      n.entity.label.backgroundColor = new ConstantProperty(color('#7a1626', 0.92));
      n.entity.label.distanceDisplayCondition = flagged || id === selectedId ? undefined : n.ddc;
      // An asset with an alert marker carries its id on the marker instead.
      n.entity.label.show = new ConstantProperty(labelsOn && !view.markerIds?.has(id));
      n.entity.label.fillColor = new ConstantProperty(color(flagged ? '#ffffff' : '#edf3f8', dim(id) && !flagged ? Math.min(0.35, faint + 0.1) : 1));
    }
    for (const [id, r] of routes) {
      const state = nodeState.get(id) ?? 'live';
      const alpha = dim(id) ? Math.min(faint, 0.28) : 1;
      const hl = hlOf(id);
      const width = WIDTH[r.kv] * (id === selectedId || (focus?.has(id) && view.emphasise) ? 1.35 : 1);
      // Chevrons run from the first point to the last: draw the route from the end power arrives at.
      const dir = view.flowDir?.get(id) ?? 'forward';
      if (dir !== r.dir) { r.dir = dir; r.entity.polyline.positions = new ConstantProperty(dir === 'reverse' ? r.reverse : r.forward); }
      if (hl && weakOf(id)) {
        r.entity.polyline.width = new ConstantProperty(WIDTH[r.kv] * 0.55);
        r.entity.polyline.material = new PolylineOutlineMaterialProperty({ color: color(hl, dim(id) ? 0.35 : 0.7), outlineColor: color(COLORS.casing, 0.5), outlineWidth: 1 });
        r.entity.polyline.depthFailMaterial = color(hl, 0.3);
        continue;
      }
      if (hl) {
        const strong = !dim(id);
        r.entity.polyline.width = new ConstantProperty(WIDTH[r.kv] + (strong ? 4 : 1));
        r.entity.polyline.material = new PolylineGlowMaterialProperty({ color: color(hl, strong ? 0.95 : 0.5), glowPower: strong ? 0.2 : 0.1, taperPower: 1 });
        r.entity.polyline.depthFailMaterial = color(hl, 0.5);
        continue;
      }
      if (inv) { drawOps(id, r, state, alpha, inv, selectedId); continue; }
      r.entity.polyline.width = new ConstantProperty(width);
      r.entity.polyline.depthFailMaterial = color(state === 'off' ? COLORS.fault : state === 'dead' || state === 'standby' ? COLORS.dead : state === 'backup' ? COLORS.backup : COLORS[r.kv], 0.5 * alpha);
      if (state === 'off') { r.entity.polyline.material = new PolylineDashMaterialProperty({ color: color(COLORS.fault, Math.max(alpha, 0.85)), dashLength: 10 }); continue; }
      // Lost in a simulation: solid red, as the electrical twin draws lost supply. Standby: grey, dashed.
      if (state === 'dead') { r.entity.polyline.material = new PolylineOutlineMaterialProperty({ color: color(COLORS.fault, Math.max(alpha, 0.8)), outlineColor: color(COLORS.casing, 0.6), outlineWidth: 1 }); continue; }
      if (state === 'standby') { r.entity.polyline.material = new PolylineDashMaterialProperty({ color: color(COLORS.dead, alpha * 0.95), dashLength: 14 }); continue; }
      // Live (or on the generator): the electrical twin's animated flow, one chevron about every 40 m.
      const hex = state === 'backup' ? COLORS.backup : id === selectedId ? COLORS.select : COLORS[r.kv];
      const key = `${hex}|${alpha}`;
      if (!r.flows.has(key)) r.flows.set(key, new FlowMaterialProperty({ color: color(hex, alpha), speed: reducedMotion ? 0 : 0.012, repeat: Math.max(2, Math.round(r.lengthM / 40)) }));
      r.entity.polyline.material = r.flows.get(key);
    }
  }

  /** One cable in the Operations View. */
  function drawOps(id, r, state, alpha, inv, selectedId) {
    const p = r.entity.polyline;
    const base = OPS_WIDTH[r.kv];
    if (inv?.confirmed.has(id) || (state === 'dead' && !inv)) {
      p.width = new ConstantProperty(base + 6);
      p.material = new PolylineGlowMaterialProperty({ color: color(COLORS.fault, 0.95), glowPower: 0.22, taperPower: 1 });
      p.depthFailMaterial = color(COLORS.fault, 0.6);
      return;
    }
    if (inv?.potential.has(id)) {
      p.width = new ConstantProperty(base + 1.5);
      p.material = new PolylineDashMaterialProperty({ color: color(COLORS.backup, 0.95), dashLength: 12 });
      p.depthFailMaterial = color(COLORS.backup, 0.5);
      return;
    }
    if (inv?.path.has(id) || id === selectedId) {
      p.width = new ConstantProperty(base + 3);
      p.material = new PolylineGlowMaterialProperty({ color: color(OPS_COLOR[r.kv], 0.95), glowPower: 0.16, taperPower: 1 });
      p.depthFailMaterial = color(OPS_COLOR[r.kv], 0.6);
      return;
    }
    p.width = new ConstantProperty(base);
    p.depthFailMaterial = color(state === 'live' || state === 'backup' ? OPS_COLOR[r.kv] : COLORS.dead, 0.35 * alpha);
    if (state === 'off') { p.material = new PolylineDashMaterialProperty({ color: color(COLORS.fault, Math.max(alpha, 0.85)), dashLength: 10 }); return; }
    if (state === 'dead') { p.material = new PolylineOutlineMaterialProperty({ color: color(COLORS.fault, alpha), outlineColor: color(COLORS.casing, 0.6), outlineWidth: 1 }); return; }
    // Standby or not determinable: grey, dashed.
    if (state !== 'live' && state !== 'backup') { p.material = new PolylineDashMaterialProperty({ color: color(COLORS.dead, alpha * 0.9), dashLength: 14 }); return; }
    p.material = new PolylineOutlineMaterialProperty({ color: color(state === 'backup' ? COLORS.backup : OPS_COLOR[r.kv], 0.88 * alpha), outlineColor: color(COLORS.casing, 0.7 * alpha), outlineWidth: 1 });
  }

  return {
    update,
    /** The asset id behind a pick on this layer, or null. */
    assetAt(picked) {
      const id = picked?.id?.id ?? '';
      const m = /^(?:node|route):(.+)$/.exec(id);
      return m ? m[1] : null;
    },
    setVisible({ network, control: ctl, zones: z, labels } = {}) {
      if (network !== undefined) source.show = network;
      if (ctl !== undefined) control.show = ctl;
      if (z !== undefined) zones.show = z;
      if (labels !== undefined) { labelsOn = labels; for (const n of nodes.values()) n.entity.label.show = new ConstantProperty(labels); if (last) update(last); }
    },
    /** Every drawn position, for framing the network. */
    positions: () => [...nodes.values()].map(n => n.entity.position.getValue()),
    counts: () => ({ symbols: nodes.size, routes: routes.size, control: control.entities.values.length, zones: ZONES.length }),
    /** A route as drawn (diagnosis and tests): its points, width, material and visibility. */
    routeInfo(id) {
      const r = routes.get(id);
      if (!r) return null;
      const time = viewer.clock.currentTime;
      const positions = r.entity.polyline.positions.getValue(time) ?? [];
      const first = positions[0] ? viewer.scene.globe.ellipsoid.cartesianToCartographic(positions[0]) : null;
      return { points: positions.length, first: first && [first.longitude * 180 / Math.PI, first.latitude * 180 / Math.PI, first.height],
        width: r.entity.polyline.width.getValue(time), material: r.entity.polyline.material?.constructor?.name, showing: r.entity.isShowing, sourceShow: source.show };
    },
    last: () => last,
    destroy() {
      for (const ds of [source, control, zones]) if (!viewer.isDestroyed()) viewer.dataSources.remove(ds, true);
    },
  };
}
