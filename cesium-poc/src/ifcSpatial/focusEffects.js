/**
 * The single-asset focus on the map (Ask the Twin "Show me TX-M1"): a locator beacon above the asset,
 * concentric rings at its base and one floating label, in the Ask the Twin cyan. Its own layer: the
 * status pills (opsMarkers.js), the result highlights (askHighlights.js) and the network are untouched.
 *
 *  - Everything is placed at the asset's position from the IFC model and sized from its geometry (the
 *    element's bounding box, or a cable's route); nothing is placed where the model has no position.
 *  - On focus: the beacon brightens and pulses a few times, the rings expand outwards; after about
 *    three seconds both settle to a quiet selected state. With reduced motion they are static.
 *  - One entity set, replaced on each focus and removed on clear.
 */
import { CallbackProperty, Cartesian2, Cartesian3, Color, ColorMaterialProperty, ConstantProperty, CustomDataSource, HorizontalOrigin, Matrix4, NearFarScalar, PolylineGlowMaterialProperty,
  SceneTransforms, Transforms, VerticalOrigin } from 'cesium';

export const FOCUS_COLOR = '#00e5ff';
const CYAN = Color.fromCssColorString(FOCUS_COLOR);
const SETTLE_S = 3.2;

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const FONT = 'Inter, "Segoe UI", system-ui, -apple-system, Arial, sans-serif';
let measurer = null;
const textWidth = (text, font) => {
  measurer ??= globalThis.document?.createElement('canvas')?.getContext('2d') ?? null;
  if (!measurer) return text.length * 11;
  measurer.font = font;
  return measurer.measureText(text).width;
};

/** The floating label: the id over the type, on a connector to the asset (bottom-left, or bottom-right when `flip`). */
export function focusLabelImage({ id, type, iconSvg = '', flip = false, color = FOCUS_COLOR }) {
  const idFont = `700 24px ${FONT}`, typeFont = `500 16px ${FONT}`;
  const w = Math.ceil(Math.max(textWidth(id, idFont), textWidth(type, typeFont) + 28)) + 36;
  const h = 76, lead = 46, rise = 54;
  const width = w + lead, height = h + rise;
  const x0 = flip ? 0 : lead;
  const ax = flip ? width - 3 : 3, ay = height - 3;
  const cx = flip ? x0 + w - 18 : x0 + 18, cy = h;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><filter id="g" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="4"/></filter></defs>
  <line x1="${ax}" y1="${ay}" x2="${cx}" y2="${cy}" stroke="${color}" stroke-width="2.2" stroke-opacity=".9"/>
  <circle cx="${ax}" cy="${ay}" r="3" fill="${color}"/>
  <rect x="${x0 + 3}" y="3" width="${w - 6}" height="${h - 6}" rx="12" fill="none" stroke="${color}" stroke-width="5" opacity=".45" filter="url(#g)"/>
  <rect x="${x0 + 2}" y="2" width="${w - 4}" height="${h - 4}" rx="12" fill="#081a2e" fill-opacity=".94" stroke="${color}" stroke-width="2"/>
  <text x="${x0 + 18}" y="34" font-family='${FONT}' font-size="24" font-weight="700" fill="#ffffff">${esc(id)}</text>
  <g transform="translate(${x0 + 16} 44)" color="#cfeffd">${iconSvg.replace(/width="\d+"/, 'width="20"').replace(/height="\d+"/, 'height="20"')}</g>
  <text x="${x0 + 44}" y="60" font-family='${FONT}' font-size="16" font-weight="500" fill="#e6f3ff">${esc(type)}</text></svg>`;
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width, height };
}

const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const now = () => performance.now() / 1000;

/**
 * @param viewer Cesium viewer
 * @param {object} opts
 * @param {() => {left:number,right:number}|null} [opts.freeSpan] the map's free span in canvas pixels, to keep the label between the panels
 */
export function createFocusEffects(viewer, { freeSpan = () => null } = {}) {
  const source = new CustomDataSource('ifc-ask-focus');
  void viewer.dataSources.add(source);
  let current = null;

  /** A circle of radius r (metres) around the centre, in its local east-north plane. */
  const circle = (frame, r, n = 72) => Array.from({ length: n + 1 }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return Matrix4.multiplyByPoint(frame, new Cartesian3(Math.cos(t) * r, Math.sin(t) * r, 0), new Cartesian3());
  });

  /**
   * Focus one asset. `at` {lon, lat, height}; `radius` metres (its geometry); `label` {id, type, iconSvg}.
   * Returns false when there is no position to place it at.
   */
  function show({ at, radius = 10, label, alarm = false }) {
    clear();
    if (!Number.isFinite(at?.lon) || !Number.isFinite(at?.lat)) return false;
    // An alarm (a simulated failure): the label alone, in red; no beacon or rings.
    if (alarm) {
      const base = Cartesian3.fromDegrees(at.lon, at.lat, at.height ?? 0);
      const right = focusLabelImage({ ...label, color: '#ff4d5b' }), left = focusLabelImage({ ...label, flip: true, color: '#ff4d5b' });
      const tag = source.entities.add({ id: 'focus:label', position: base, billboard: { image: right.url, width: right.width, height: right.height, horizontalOrigin: HorizontalOrigin.LEFT,
        verticalOrigin: VerticalOrigin.BOTTOM, disableDepthTestDistance: Number.POSITIVE_INFINITY, scaleByDistance: new NearFarScalar(150, 1, 6000, 0.75), eyeOffset: new Cartesian3(0, 0, -8) } });
      current = { base, tag, right, left };
      layout();
      viewer.scene.requestRender();
      return true;
    }
    const base = Cartesian3.fromDegrees(at.lon, at.lat, at.height ?? 0);
    const frame = Transforms.eastNorthUpToFixedFrame(base);
    const R = Math.min(Math.max(radius * 1.5, 9), 140);
    const H = Math.min(Math.max(radius * 5, 60), 220);
    const top = Matrix4.multiplyByPoint(frame, new Cartesian3(0, 0, H), new Cartesian3());
    const t0 = now();
    const still = reducedMotion();
    const age = () => (still ? SETTLE_S + 1 : now() - t0);
    // Beacon: rises with the focus, three soft pulses, then a quiet line.
    const intensity = () => {
      const t = age();
      if (t >= SETTLE_S) return 0.32;
      const pulse = 0.5 + 0.5 * Math.cos((t / 0.9) * Math.PI * 2);
      const env = Math.min(1, t / 0.35) * (1 - Math.max(0, t - 2.2) / (SETTLE_S - 2.2));
      return 0.32 + (0.68 * env) * (0.55 + 0.45 * pulse);
    };
    const beamTop = new CallbackProperty(() => [base, Cartesian3.lerp(base, top, Math.min(1, age() / 0.45), new Cartesian3())], false);
    source.entities.add({ id: 'focus:beam-glow', polyline: { positions: beamTop, width: 18, arcType: 0,
      material: new PolylineGlowMaterialProperty({ glowPower: new CallbackProperty(() => 0.18 + 0.12 * intensity(), false), taperPower: 0.6,
        color: new CallbackProperty(() => CYAN.withAlpha(0.95 * intensity()), false) }) } });
    source.entities.add({ id: 'focus:beam-core', polyline: { positions: beamTop, width: 3, arcType: 0,
      material: new ColorMaterialProperty(new CallbackProperty(() => Color.WHITE.withAlpha(Math.min(1, 0.35 + intensity())), false)) } });
    // Rings: outwards one after another, then three faint circles.
    [0, 1, 2].forEach(i => {
      const final = R * (1 + i * 0.55);
      const radiusAt = () => { const t = age() - i * 0.3; return t >= 1.4 ? final : Math.max(0.15, t / 1.4) * final; };
      const alphaAt = () => { const t = age(); return t >= SETTLE_S ? [0.42, 0.26, 0.14][i] : Math.min(0.9, 0.25 + 0.65 * Math.max(0, 1 - Math.abs(t - i * 0.3 - 0.7))) ; };
      source.entities.add({ id: `focus:ring${i}`, polyline: { positions: still ? circle(frame, final) : new CallbackProperty(() => circle(frame, radiusAt()), false),
        width: i === 0 ? 4 : 3, arcType: 0,
        material: new PolylineGlowMaterialProperty({ glowPower: 0.25, taperPower: 1, color: new CallbackProperty(() => CYAN.withAlpha(alphaAt()), false) }) } });
    });
    source.entities.add({ id: 'focus:disc', position: base, ellipse: { semiMajorAxis: R * 0.9, semiMinorAxis: R * 0.9, height: at.height ?? 0,
      material: CYAN.withAlpha(0.07) } });
    const right = focusLabelImage({ ...label }), left = focusLabelImage({ ...label, flip: true });
    const tag = source.entities.add({ id: 'focus:label', position: Matrix4.multiplyByPoint(frame, new Cartesian3(0, 0, Math.min(H * 0.25, 14)), new Cartesian3()),
      billboard: { image: right.url, width: right.width, height: right.height, horizontalOrigin: HorizontalOrigin.LEFT, verticalOrigin: VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY, scaleByDistance: new NearFarScalar(150, 1, 6000, 0.75), eyeOffset: new Cartesian3(0, 0, -8) } });
    current = { base, tag, right, left };
    layout();
    viewer.scene.requestRender();
    return true;
  }

  /** The label on the side with room, between the panels. */
  function layout() {
    if (!current) return;
    const p = SceneTransforms.worldToWindowCoordinates(viewer.scene, current.base, new Cartesian2());
    const span = freeSpan();
    if (!p) return;
    const flip = span ? p.x + current.right.width > span.right - 8 && p.x - current.left.width > span.left + 8 : false;
    const img = flip ? current.left : current.right;
    current.tag.billboard.image = new ConstantProperty(img.url);
    current.tag.billboard.width = new ConstantProperty(img.width);
    current.tag.billboard.height = new ConstantProperty(img.height);
    current.tag.billboard.horizontalOrigin = new ConstantProperty(flip ? HorizontalOrigin.RIGHT : HorizontalOrigin.LEFT);
    current.flip = flip;
  }
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(layout);

  function clear() {
    current = null;
    source.entities.removeAll();
    viewer.scene.requestRender();
  }

  return {
    show,
    clear,
    layout,
    active: () => Boolean(current),
    /** The asset under a pick on the focus graphics (its label), or false. */
    isOwn: picked => /^focus:/.test(picked?.id?.id ?? ''),
    state: () => ({ active: Boolean(current), entities: source.entities.values.length, flip: current?.flip ?? false }),
    destroy() { removeMoveEnd(); if (!viewer.isDestroyed()) viewer.dataSources.remove(source, true); },
  };
}

/**
 * A short, quiet locator tone (two soft sine notes), with the Web Audio API. Created on first use,
 * which is after the user turned the sound on (a click), so browsers allow it.
 */
export function createLocatorSound() {
  let ctx = null;
  let nodes = [];
  function stop() {
    for (const n of nodes) { try { n.stop(); } catch { /* already stopped */ } }
    nodes = [];
  }
  function play() {
    const AudioCtx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AudioCtx) return false;
    ctx ??= new AudioCtx();
    if (ctx.state === 'suspended') void ctx.resume();
    stop();
    const t = ctx.currentTime + 0.02;
    [[1174.7, 0, 0.16], [1760, 0.13, 0.26]].forEach(([freq, at, len]) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t + at);
      gain.gain.setValueAtTime(0.0001, t + at);
      gain.gain.exponentialRampToValueAtTime(0.06, t + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + at + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t + at);
      osc.stop(t + at + len + 0.02);
      nodes.push(osc);
    });
    return true;
  }
  return { play, stop };
}
