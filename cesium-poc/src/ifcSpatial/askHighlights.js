/**
 * Ask the Twin results on the map: a highlight layer of its own, beside (never instead of) the
 * operational status markers (opsMarkers.js) and the network's own symbols.
 *
 *  - Each result asset: a cyan halo, a ground ring and a short vertical beam at its position (sets of up
 *    to `adaptive` assets; beyond that the halos alone), and a navy label with a cyan border on a leader
 *    line. One animation clock for all of them.
 *  - The selected one: brighter, and the others dimmed; its own beam, ring and label give way to the
 *    single-asset focus (focusEffects.js), so nothing is drawn twice.
 *  - Labels avoid each other and the status pills (`avoid`); an asset that already carries a NO POWER / DEGRADED pill (above it) gets
 *    its label below. Many results cluster by screen distance (thresholds are settings):
 *    up to `individual` labels each, up to `adaptive` grouped when close, more as counts.
 *  - Positions are the model's own (asset locations from the IFC); nothing is placed where the model
 *    has no position. One CustomDataSource, rebuilt only when the result set changes.
 */
import { CallbackProperty, Cartesian2, Cartesian3, Color, ColorMaterialProperty, PolygonHierarchy, PolylineDashMaterialProperty, ConstantProperty, CustomDataSource, HorizontalOrigin, ImageMaterialProperty, NearFarScalar, PolylineGlowMaterialProperty, SceneTransforms,
  VerticalOrigin } from 'cesium';

export const HIGHLIGHT_THRESHOLDS = Object.freeze({ individual: 15, adaptive: 50 });
export const ASK_COLOR = '#22d3ee';

/** How labels are shown for a result set of n assets. */
export function labelModeOf(n, t = HIGHLIGHT_THRESHOLDS) {
  return n <= t.individual ? 'individual' : n <= t.adaptive ? 'adaptive' : 'cluster';
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Arial, sans-serif';
let measurer = null;
const textWidth = (text, font) => {
  measurer ??= globalThis.document?.createElement('canvas')?.getContext('2d') ?? null;
  if (!measurer) return text.length * 8;
  measurer.font = font;
  return measurer.measureText(text).width;
};
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const ICONS = {
  transformer: '<circle cx="0" cy="-2.3" r="3.2" fill="none" stroke="#fff" stroke-width="1.5"/><circle cx="0" cy="2.3" r="3.2" fill="none" stroke="#fff" stroke-width="1.5"/>',
  switchgear: '<rect x="-4.5" y="-4" width="9" height="8" rx="1" fill="none" stroke="#fff" stroke-width="1.4"/><path d="M-1.8 -2v4M1.8 -2v4" stroke="#fff" stroke-width="1.3"/>',
  cable: '<path d="M-5 3 C-2 3 -2 -3 0 -3 S2 3 5 3" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>',
  light: '<circle r="2.4" fill="#fff"/><path d="M0 -5.5v1.6M0 5.5v-1.6M-5.5 0h1.6M5.5 0h-1.6" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/>',
  load: '<path d="M1 -5 -3 1h3l-1 4 4-6H0z" fill="#fff"/>',
  source: '<path d="M-4 0c1.3-3 2.7-3 4 0s2.7 3 4 0" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>',
  other: '<rect x="-3.2" y="-3.2" width="6.4" height="6.4" rx="1.2" fill="#fff"/>',
};

/** A label: [icon] text, on a pointer up (or down, `below`) to the asset; the anchor is the pointer's end. */
export function askLabelImage({ text, kind = 'other', selected = false, below = false, level = 0, dim = false }) {
  void kind;
  const size = selected ? 16 : 14;
  const font = `700 ${size}px ${FONT}`;
  const w = Math.ceil(textWidth(text, font));
  const width = w + 28;
  const h = selected ? 32 : 28;
  const stem = 14 + level * 30;
  const height = h + stem + 4;
  const border = selected ? '#ffffff' : ASK_COLOR;
  const pill = `<g transform="translate(0 ${below ? stem + 4 : 0})" opacity="${dim ? 0.55 : 1}"><rect x="2" y="2" width="${width - 4}" height="${h - 4}" rx="8" fill="#081a2e" fill-opacity=".92" stroke="${border}" stroke-width="${selected ? 2.5 : 1.8}"/>
    <text x="14" y="${h / 2 + size / 2 - 2}" font-family='${FONT}' font-size="${size}" font-weight="700" fill="#fff" textLength="${w}" lengthAdjust="spacingAndGlyphs">${esc(text)}</text></g>`;
  const pointer = dim ? '' : below
    ? `<line x1="${width / 2}" y1="3" x2="${width / 2}" y2="${stem + 5}" stroke="${border}" stroke-width="2"/><circle cx="${width / 2}" cy="3" r="3" fill="${ASK_COLOR}" stroke="#fff" stroke-width="1"/>`
    : `<line x1="${width / 2}" y1="${h - 1}" x2="${width / 2}" y2="${height - 4}" stroke="${border}" stroke-width="2"/><circle cx="${width / 2}" cy="${height - 3}" r="3" fill="${ASK_COLOR}" stroke="#fff" stroke-width="1"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><filter id="s"><feDropShadow dx="0" dy="1" stdDeviation="1.6" flood-opacity=".55"/></filter></defs><g filter="url(#s)">${pointer}${pill}</g></svg>`;
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width, height, pill: h };
}

const halo = (() => {
  const make = selected => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="-48 -48 96 96">
    <defs><filter id="g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${selected ? 5 : 3.5}"/></filter></defs>
    <circle r="${selected ? 34 : 28}" fill="none" stroke="${selected ? '#ffffff' : ASK_COLOR}" stroke-width="${selected ? 7 : 6}" opacity=".75" filter="url(#g)"/>
    <circle r="${selected ? 32 : 26}" fill="${ASK_COLOR}" fill-opacity=".12" stroke="${selected ? '#ffffff' : ASK_COLOR}" stroke-width="${selected ? 3.5 : 2.5}"/></svg>`)}`;
  return { normal: make(false), selected: make(true) };
})();
const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export function createAskHighlights(viewer, { baseHeight = 0, thresholds = HIGHLIGHT_THRESHOLDS, avoid = () => [] } = {}) {
  const source = new CustomDataSource('ifc-ask-results');
  void viewer.dataSources.add(source);
  let items = [];
  let selected = null;
  let total = 0;
  let labelsOn = true;
  let noun = 'results';
  let t0 = performance.now();
  // One clock for every locator: rings breathe and beams pulse together, then settle.
  const pulse = () => (reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin((performance.now() - t0) / 520));
  const strength = it => (selected && it.id !== selected ? 0.35 : 1);
  const ringImage = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="-64 -64 128 128">
    <circle r="58" fill="none" stroke="#fff" stroke-width="5"/><circle r="40" fill="none" stroke="#fff" stroke-width="3" opacity=".7"/><circle r="40" fill="#fff" opacity=".12"/></svg>`)}`;
  const images = new Map();
  const imageOf = opts => { const k = JSON.stringify(opts); if (!images.has(k)) images.set(k, askLabelImage(opts)); return images.get(k); };

  /**
   * Replace the result set: [{id, label, kind, lon, lat, alert}] (alert: it carries a status pill).
   * `size`: the whole result set (cables included, which have no label), which sets the label mode.
   */
  function set(list, { size = list.length, noun: kindNoun = 'results' } = {}) {
    source.entities.removeAll();
    total = size;
    noun = kindNoun;
    t0 = performance.now();
    const located = list.filter(x => Number.isFinite(x.lon) && Number.isFinite(x.lat));
    const effects = located.length <= thresholds.adaptive;
    items = located.map((x, rank) => {
      const position = Cartesian3.fromDegrees(x.lon, x.lat, baseHeight + 2.5);
      const haloEntity = source.entities.add({ id: `askhalo:${x.id}`, position,
        billboard: { image: halo.normal, width: 46, height: 46, disableDepthTestDistance: Number.POSITIVE_INFINITY, scaleByDistance: new NearFarScalar(250, 1.2, 6000, 0.7),
          color: new CallbackProperty(() => Color.WHITE.withAlpha(strength(items[rank] ?? x)), false) } });
      const item = { ...x, rank };
      if (effects) {
        // A ring on the ground and a short beam, at the asset's own position.
        const ground = Cartesian3.fromDegrees(x.lon, x.lat, baseHeight + 0.4);
        item.ring = source.entities.add({ id: `askring:${x.id}`, position: ground, ellipse: { semiMajorAxis: 16, semiMinorAxis: 16, height: baseHeight + 0.4,
          material: new ImageMaterialProperty({ image: ringImage, transparent: true, color: new CallbackProperty(() => Color.fromCssColorString(ASK_COLOR).withAlpha((0.45 + 0.4 * pulse()) * strength(item)), false) }) } });
        const top = Cartesian3.fromDegrees(x.lon, x.lat, baseHeight + 55);
        item.beam = source.entities.add({ id: `askbeam:${x.id}`, polyline: { positions: [ground, top], width: 9, arcType: 0,
          material: new PolylineGlowMaterialProperty({ glowPower: 0.25, taperPower: 0.35, color: new CallbackProperty(() => Color.fromCssColorString(ASK_COLOR).withAlpha((0.55 + 0.3 * pulse()) * strength(item)), false) }) } });
        item.core = source.entities.add({ id: `askcore:${x.id}`, polyline: { positions: [ground, top], width: 1.5, arcType: 0,
          material: new ColorMaterialProperty(new CallbackProperty(() => Color.WHITE.withAlpha(0.7 * strength(item)), false)) } });
      }
      const tag = source.entities.add({ id: `ask:${x.id}`, position, show: false,
        billboard: { image: imageOf({ text: x.label ?? x.id, kind: x.kind }).url, verticalOrigin: VerticalOrigin.BOTTOM, horizontalOrigin: HorizontalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY, eyeOffset: new Cartesian3(0, 0, -6), scaleByDistance: new NearFarScalar(250, 1, 7000, 0.85) } });
      return Object.assign(item, { position, haloEntity, tag });
    });
    applySelected();
    layout();
  }

  function applySelected() {
    for (const it of items) {
      const on = it.id === selected;
      // The selected asset's locator is the focus's (beacon, rings, label): its own steps aside.
      for (const e of [it.ring, it.beam, it.core]) if (e) e.show = !on;
      it.haloEntity.billboard.image = new ConstantProperty(on ? halo.selected : halo.normal);
      it.haloEntity.billboard.scale = on && !reducedMotion
        ? new CallbackProperty(() => 1.25 + 0.12 * Math.sin(performance.now() / 300), false) : new ConstantProperty(on ? 1.3 : 1);
    }
  }

  /** Labels by priority (the selected first), clustered by mode, kept apart, kept inside the view. */
  function layout() {
    const scene = viewer.scene;
    const box = viewer.canvas.getBoundingClientRect();
    const mode = labelModeOf(Math.max(total, items.length), thresholds);
    const visible = [];
    for (const it of [...items].sort((a, b) => Number(b.id === selected) - Number(a.id === selected) || a.rank - b.rank)) {
      it.tag.show = false;
      if (!labelsOn) continue;
      const p = SceneTransforms.worldToWindowCoordinates(scene, it.position, new Cartesian2());
      if (p && p.x > -20 && p.y > -20 && p.x < box.width + 20 && p.y < box.height + 20) visible.push({ it, p });
    }
    // Clusters: none for a few results; close ones for more; everything near for many.
    // Clusters: labels that would overlap on screen merge; more of them merge for larger sets.
    const radius = mode === 'individual' ? 44 : mode === 'adaptive' ? 70 : 150;
    const clusters = [];
    for (const v of visible) {
      const c = radius && v.it.id !== selected && clusters.find(k => k.lead.it.id !== selected && Math.hypot(k.lead.p.x - v.p.x, k.lead.p.y - v.p.y) < radius);
      if (c) c.members.push(v); else clusters.push({ lead: v, members: [v] });
    }
    // Kept clear of the status pills (avoid: their canvas boxes) as well as of each other.
    const placed = [...avoid()];
    for (const c of clusters) {
      const { it, p } = c.lead;
      const n = c.members.length;
      const text = n === 1 ? (it.label ?? it.id) : mode === 'cluster' || n > 3 ? `${n} ${noun}` : `${it.label ?? it.id} +${n - 1}`;
      const isSel = it.id === selected;
      if (isSel) continue;   // labelled by the focus
      const dim = Boolean(selected);
      const order = it.alert ? [true, false] : [false, true];
      let done = false;
      for (let level = 0; level < 3 && !done; level += 1) {
        for (const below of order) {
          const img = imageOf({ text, kind: n === 1 ? it.kind : 'other', selected: isSel, below, level, dim });
          const y0 = below ? p.y + 12 + level * 30 : p.y - img.height;
          const r = { x0: p.x - img.width / 2, x1: p.x + img.width / 2, y0, y1: y0 + img.pill };
          if (r.x0 < 4 || r.x1 > box.width - 4 || r.y0 < 4 || r.y1 > box.height - 4) continue;
          if (placed.some(q => q.x0 < r.x1 + 4 && r.x0 < q.x1 + 4 && q.y0 < r.y1 + 4 && r.y0 < q.y1 + 4)) continue;
          placed.push(r);
          it.tag.billboard.image = new ConstantProperty(img.url);
          it.tag.billboard.verticalOrigin = new ConstantProperty(below ? VerticalOrigin.TOP : VerticalOrigin.BOTTOM);
          it.tag.show = true;
          it.shownText = text;
          done = true;
          break;
        }
      }
    }
    viewer.scene.requestRender();
  }
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(layout);

  return {
    set,
    clear() { items = []; total = 0; selected = null; source.entities.removeAll(); viewer.scene.requestRender(); },
    /** A spatial search's boundary (rings of {lon, lat}): a faint fill and a dashed outline, on the ground. */
    setBoundary(rings = []) {
      for (const e of source.entities.values.filter(x => /^askzone:/.test(x.id))) source.entities.remove(e);
      rings.forEach((ring, i) => {
        if (ring.length < 3) return;
        const pts = ring.map(p => Cartesian3.fromDegrees(p.lon, p.lat, baseHeight + 0.3));
        source.entities.add({ id: `askzone:${i}`, polygon: { hierarchy: new PolygonHierarchy(pts), height: baseHeight + 0.3, material: Color.fromCssColorString(ASK_COLOR).withAlpha(0.08) } });
        source.entities.add({ id: `askzone:${i}:edge`, polyline: { positions: [...pts, pts[0]], width: 2, arcType: 0, material: new PolylineDashMaterialProperty({ color: Color.fromCssColorString(ASK_COLOR).withAlpha(0.75), dashLength: 14 }) } });
      });
      viewer.scene.requestRender();
    },
    setSelected(id) { selected = id; applySelected(); layout(); },
    /** Hide the labels (the halos stay) while one asset is focused, so it has the only label. */
    setLabelsVisible(on) { if (labelsOn === on) return; labelsOn = on; layout(); },
    /** The asset id behind a pick on a result label or halo, or null. */
    idAt(picked) { const m = /^ask(?:halo|ring|beam|core)?:(.+)$/.exec(picked?.id?.id ?? ''); return m ? m[1] : null; },
    screenPosition(id) {
      const it = items.find(x => x.id === id);
      if (!it) return null;
      const p = SceneTransforms.worldToWindowCoordinates(viewer.scene, it.position, new Cartesian2());
      const box = viewer.canvas.getBoundingClientRect();
      return p && { x: box.left + p.x, y: box.top + p.y };
    },
    state: () => ({ count: items.length, selected, effects: items.filter(x => x.ring).length, mode: labelModeOf(Math.max(total, items.length), thresholds), labels: items.filter(x => x.tag.show).map(x => x.shownText) }),
    destroy() { removeMoveEnd(); if (!viewer.isDestroyed()) viewer.dataSources.remove(source, true); },
  };
}
