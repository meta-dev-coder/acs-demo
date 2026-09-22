/**
 * Asset ID map markers — a label pill showing the asset's own identifier, on a stem above the point
 * it marks, instead of a pictogram.
 *
 * A pictogram tells you what KIND of thing is there, which the layer you switched on already told
 * you. On a corridor with 47 cameras the useful question is WHICH one, so the marker carries the
 * identifier the rest of the application uses for it.
 *
 * Drawn to a canvas rather than built from Cesium LabelGraphics: a label cannot carry a background
 * plate, a stem and a location dot as one anchored unit, and three stacked graphics per asset would
 * be three times the entities to keep in step.
 *
 * Images are cached by id and selection state, so a selection change swaps between two already-drawn
 * textures and nothing is redrawn per frame.
 */

/** Charcoal pill, white text — quiet enough to sit over photogrammetry without competing. */
export const MARKER_COLORS = Object.freeze({
  normal: Object.freeze({
    fill: '#343A40', text: '#FFFFFF', border: 'rgba(255,255,255,0.55)',
    stem: 'rgba(255,255,255,0.65)', dot: '#343A40', dotRing: '#FFFFFF',
  }),
  // Warm yellow for the selected asset: the one marker that should draw the eye.
  selected: Object.freeze({
    fill: '#F5B51B', text: '#172033', border: 'rgba(23,32,51,0.35)',
    stem: '#F5B51B', dot: '#F5B51B', dotRing: '#FFFFFF',
  }),
});

const FONT_PX = 12;
const PADDING_X = 8;
const PILL_HEIGHT = 20;
const STEM = 9;
/**
 * Overhead structures need a longer stem: the pill sits a fixed screen distance above the anchor,
 * and at 9px it lands on the gantry deck rather than above it. The dot stays on the ground point.
 */
export const OVERHEAD_STEM = 30;
const DOT_RADIUS = 3.5;
const RADIUS = 5;
/** Drawn oversized and scaled down by Cesium, so the text stays crisp on dense displays. */
const SUPERSAMPLE = 3;

const cache = new Map();

/** Cache key: the same id in the same state is the same texture. */
export const markerCacheKey = (id, selected, stem = STEM) => `${id}:${selected ? 'selected' : 'normal'}:${stem}`;

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

/**
 * A marker image for one asset id.
 *
 * @param {{id: string|number, selected?: boolean}} options
 * @returns {{image: HTMLCanvasElement, width: number, height: number}} CSS pixel size for the
 *   billboard, so the caller does not have to know about supersampling.
 */
export function assetIdMarker({ id, selected = false, stem = STEM }) {
  const label = String(id ?? '').trim();
  const key = markerCacheKey(label, selected, stem);
  const hit = cache.get(key);
  if (hit) return hit;

  const colors = selected ? MARKER_COLORS.selected : MARKER_COLORS.normal;
  const font = `600 ${FONT_PX}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  const textWidth = Math.ceil(measure.measureText(label).width);
  const pillWidth = textWidth + PADDING_X * 2;
  const width = Math.max(pillWidth, DOT_RADIUS * 2 + 4);
  const height = PILL_HEIGHT + stem + DOT_RADIUS * 2 + 2;

  const canvas = document.createElement('canvas');
  canvas.width = width * SUPERSAMPLE;
  canvas.height = height * SUPERSAMPLE;
  const ctx = canvas.getContext('2d');
  ctx.scale(SUPERSAMPLE, SUPERSAMPLE);

  const pillLeft = (width - pillWidth) / 2;
  roundedRect(ctx, pillLeft, 0, pillWidth, PILL_HEIGHT, RADIUS);
  ctx.fillStyle = colors.fill;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = colors.border;
  ctx.stroke();

  ctx.font = font;
  ctx.fillStyle = colors.text;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, width / 2, PILL_HEIGHT / 2 + 0.5);

  // Stem down to the point the marker belongs to.
  ctx.beginPath();
  ctx.moveTo(width / 2, PILL_HEIGHT);
  ctx.lineTo(width / 2, PILL_HEIGHT + stem);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = colors.stem;
  ctx.stroke();

  // The location dot sits at the very bottom, which is the billboard's anchor.
  const dotY = PILL_HEIGHT + stem + DOT_RADIUS;
  ctx.beginPath();
  ctx.arc(width / 2, dotY, DOT_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = colors.dot;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = colors.dotRing;
  ctx.stroke();

  const marker = Object.freeze({ image: canvas, width, height });
  cache.set(key, marker);
  return marker;
}

/**
 * Just the marker's location dot, with the same anchor: drawn at the bottom-anchored position the
 * full marker's dot occupies, so promoting a dot to an ID marker grows the pill above the same
 * point rather than shifting it. One shared texture, for layers too dense to label every asset.
 *
 * @returns {{image: HTMLCanvasElement, width: number, height: number}}
 */
export function assetDotMarker() {
  const key = 'dot:normal';
  const hit = cache.get(key);
  if (hit) return hit;
  const colors = MARKER_COLORS.normal;
  // The full marker's dot centre sits DOT_RADIUS + 2 above its bottom edge; so does this one's.
  const size = DOT_RADIUS * 2 + 4;
  const canvas = document.createElement('canvas');
  canvas.width = size * SUPERSAMPLE;
  canvas.height = size * SUPERSAMPLE;
  const ctx = canvas.getContext('2d');
  ctx.scale(SUPERSAMPLE, SUPERSAMPLE);
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, DOT_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = colors.dot;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = colors.dotRing;
  ctx.stroke();
  const marker = Object.freeze({ image: canvas, width: size, height: size });
  cache.set(key, marker);
  return marker;
}

/** Test/diagnostic hook: how many textures have been drawn. */
export const markerCacheSize = () => cache.size;
export function clearMarkerCache() { cache.clear(); }

/**
 * The short identifier a marker shows, per asset type.
 *
 * Markers are read at a glance over imagery, so they carry the part of the identifier that
 * distinguishes one asset from its neighbours — never a prefix every marker on the layer repeats.
 * "I595_GANTRY_037" is 037; "Bridge 860384" is 860384; "Gantry 2 — Toll Lane" is Gantry 2.
 *
 * Each rule is anchored to the real field, and falls back to the raw value rather than inventing
 * one when a record does not match the expected shape.
 */
export const MARKER_LABELS = Object.freeze({
  /** Trailing number of an underscore-delimited structure id: I595_GANTRY_037 -> 037. */
  structureNumber(id) {
    const text = String(id ?? '').trim();
    const tail = /_(\d+)$/.exec(text);
    return tail ? tail[1] : text;
  },
  /** "Bridge 860384" -> "860384"; a bare id is left as it is. */
  bridge(name, fallbackId) {
    const text = String(name ?? '').trim();
    const stripped = text.replace(/^bridge\s+/i, '').trim();
    return stripped || MARKER_LABELS.structureNumber(fallbackId);
  },
  /** "Gantry 2 — Toll Lane" -> "Gantry 2": the descriptor repeats across the layer. */
  gantry(name) {
    const text = String(name ?? '').trim();
    const head = /^(Gantry\s*\d+)/i.exec(text);
    if (head) return head[1].replace(/\s+/, ' ');
    // Anything else keeps its name minus a trailing dash-separated descriptor.
    return text.split(/\s+[—–-]\s+/)[0] || text;
  },
});
