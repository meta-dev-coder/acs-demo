/**
 * Operations View alert markers: a high-contrast pill ("⚡ STS-06 | NO POWER") on a stem that points
 * at the asset's position, readable over containers, roads and water, and always drawn (critical
 * status is never hidden to avoid clutter).
 *
 * Collisions: when the camera stops, markers are laid out in screen space by priority; one that would
 * overlap a placed one is lifted on a longer stem (up to three levels), so each stays visible and
 * clickable and still points at its asset. One CustomDataSource in the screen's own viewer.
 */
import { Cartesian2, Cartesian3, CustomDataSource, HorizontalOrigin, NearFarScalar, SceneTransforms, VerticalOrigin } from 'cesium';

const TONE = {
  NO_POWER: { fill: '#4b0b14', border: '#ff3b4f', text: '#ffffff', icon: '#ff5a6c', word: 'NO POWER' },
  DEGRADED: { fill: '#3a2706', border: '#ffb020', text: '#fff6e0', icon: '#ffc24d', word: 'DEGRADED' },
  OFFLINE: { fill: '#232a33', border: '#9aa6b2', text: '#ffffff', icon: '#c3ccd5', word: 'OFFLINE' },
};
const STEP = 34;
const PILL_H = 28;
const FONT = 'system-ui, -apple-system, "Segoe UI", Arial, sans-serif';
let measurer = null;
/** Text width as the browser draws it (an SVG image cannot load web fonts, so both use system fonts). */
function textWidth(text, font) {
  measurer ??= globalThis.document?.createElement('canvas')?.getContext('2d') ?? null;
  if (!measurer) return text.length * 8.4;
  measurer.font = font;
  return measurer.measureText(text).width;
}
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/** The pill and its stem as one SVG; the image's bottom centre is the asset's position. */
export function markerImage({ id, status, level = 0, selected = false }) {
  const tone = TONE[status] ?? TONE.NO_POWER;
  const label = `${id}`;
  const idW = Math.ceil(textWidth(label, `700 13.5px ${FONT}`));
  const wordW = Math.ceil(textWidth(tone.word, `800 12px ${FONT}`) + tone.word.length * 0.4);
  const sep = 32 + idW + 11;
  const width = sep + 12 + wordW + 14;
  const stem = 12 + level * STEP;
  const height = PILL_H + stem + 6;
  const glow = selected ? `<rect x="1" y="1" width="${width - 2}" height="${PILL_H}" rx="8" fill="none" stroke="#ffffff" stroke-width="2"/>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><filter id="s" x="-20%" y="-40%" width="140%" height="200%"><feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-color="#000" flood-opacity="0.55"/></filter></defs>
  <line x1="${width / 2}" y1="${PILL_H}" x2="${width / 2}" y2="${height - 5}" stroke="${tone.border}" stroke-width="2"/>
  <circle cx="${width / 2}" cy="${height - 4}" r="3.5" fill="${tone.border}" stroke="#ffffff" stroke-width="1.2"/>
  <g filter="url(#s)"><rect x="2" y="2" width="${width - 4}" height="${PILL_H - 2}" rx="7" fill="${tone.fill}" stroke="${tone.border}" stroke-width="2"/></g>${glow}
  <circle cx="17" cy="${PILL_H / 2 + 1}" r="9" fill="${tone.border}"/>
  <path d="M18.6 ${PILL_H / 2 - 6} L13.4 ${PILL_H / 2 + 2} H17.2 L15.8 ${PILL_H / 2 + 8} L21 ${PILL_H / 2} H17.2 Z" fill="#ffffff"/>
  <text x="32" y="${PILL_H / 2 + 5.5}" font-family='${FONT}' font-size="13.5" font-weight="700" fill="${tone.text}" textLength="${idW}" lengthAdjust="spacingAndGlyphs">${esc(label)}</text>
  <line x1="${sep}" y1="7" x2="${sep}" y2="${PILL_H - 5}" stroke="${tone.border}" stroke-opacity="0.7" stroke-width="1.2"/>
  <text x="${sep + 12}" y="${PILL_H / 2 + 5}" font-family='${FONT}' font-size="12" font-weight="800" letter-spacing="0.4" fill="${tone.text}" textLength="${wordW}" lengthAdjust="spacingAndGlyphs">${tone.word}</text>
</svg>`;
  return { url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, width, height };
}

export function createOpsMarkers(viewer, { baseHeight = 0 } = {}) {
  const source = new CustomDataSource('ifc-ops-alerts');
  void viewer.dataSources.add(source);
  const images = new Map();
  const imageOf = opts => {
    const key = `${opts.id}|${opts.status}|${opts.level}|${opts.selected}`;
    if (!images.has(key)) images.set(key, markerImage(opts));
    return images.get(key);
  };
  let items = [];
  let selected = null;
  let shown = [];

  function set(alerts) {
    source.entities.removeAll();
    items = alerts.filter(a => Number.isFinite(a.lon) && Number.isFinite(a.lat)).map((a, rank) => {
      const position = Cartesian3.fromDegrees(a.lon, a.lat, baseHeight + 2);
      const img = imageOf({ id: a.id, status: a.status, level: 0, selected: a.id === selected });
      const entity = source.entities.add({
        id: `alert:${a.id}`, position,
        billboard: { image: img.url, width: img.width, height: img.height, verticalOrigin: VerticalOrigin.BOTTOM, horizontalOrigin: HorizontalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY, scaleByDistance: new NearFarScalar(250, 1, 8000, 0.82), eyeOffset: new Cartesian3(0, 0, -5) },
      });
      return { ...a, rank, position, entity, level: 0 };
    });
    layout();
  }

  /** Greedy layout by priority: lift a marker that would overlap one already placed. */
  function layout() {
    const placed = [];
    shown = [];
    const scene = viewer.scene;
    for (const item of [...items].sort((x, y) => Number(y.id === selected) - Number(x.id === selected) || x.rank - y.rank)) {
      const p = SceneTransforms.worldToWindowCoordinates(scene, item.position, new Cartesian2());
      let level = 0;
      if (p) {
        const w = imageOf({ id: item.id, status: item.status, level: 0, selected: false }).width;
        for (; level < 3; level += 1) {
          const top = p.y - (PILL_H + 12 + level * STEP + 6);
          const box = { x0: p.x - w / 2, x1: p.x + w / 2, y0: top, y1: top + PILL_H };
          if (!placed.some(b => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) { placed.push(box); break; }
        }
        if (level === 3) level = 2;
      }
      if (p && source.show) {
        const top = p.y - (PILL_H + 12 + level * STEP + 6);
        const w = imageOf({ id: item.id, status: item.status, level: 0, selected: false }).width;
        shown.push({ x0: p.x - w / 2, x1: p.x + w / 2, y0: top, y1: top + PILL_H });
      }
      const img = imageOf({ id: item.id, status: item.status, level, selected: item.id === selected });
      if (item.level !== level || item.shownSelected !== (item.id === selected)) {
        item.level = level;
        item.shownSelected = item.id === selected;
        item.entity.billboard.image = img.url;
        item.entity.billboard.width = img.width;
        item.entity.billboard.height = img.height;
      }
    }
    viewer.scene.requestRender();
  }
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(layout);

  return {
    set,
    setSelected(id) { selected = id; layout(); },
    setVisible(show) { source.show = show; },
    /** The asset id behind a pick on a marker, or null. */
    idAt(picked) { const m = /^alert:(.+)$/.exec(picked?.id?.id ?? ''); return m ? m[1] : null; },
    screenPosition(id) {
      const item = items.find(x => x.id === id);
      if (!item) return null;
      const p = SceneTransforms.worldToWindowCoordinates(viewer.scene, item.position, new Cartesian2());
      const box = viewer.canvas.getBoundingClientRect();
      // The middle of the pill, where a user would click.
      return p && { x: box.left + p.x, y: box.top + p.y - (PILL_H / 2 + 12 + item.level * STEP + 6) };
    },
    state: () => items.map(x => ({ id: x.id, status: x.status, level: x.level })),
    /** The pills as last laid out, in canvas pixels (for other labels to keep clear of). */
    boxes: () => shown,
    destroy() { removeMoveEnd(); if (!viewer.isDestroyed()) viewer.dataSources.remove(source, true); },
  };
}

export const MARKER_COLORS = Object.freeze(Object.fromEntries(Object.entries(TONE).map(([k, v]) => [k, v.border])));
