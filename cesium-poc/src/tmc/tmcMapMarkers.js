/**
 * The things the TMC draws on the corridor, as images.
 *
 * Cesium labels are quick but cannot do a bordered card with a coloured rule and three type sizes,
 * and the alternative — a DOM overlay tracked against the camera — drifts during a fly and fights
 * the depth buffer. A canvas billboard is attached to the world like any other marker, stays sharp
 * at device pixel ratio, and is one draw call.
 *
 * Everything is cached by its own content: the same callout for the same incident is built once,
 * which matters because `draw()` runs on every refresh, tab change and map filter.
 *
 * Pure drawing. No Cesium types, no state, no data access — it is handed strings and returns
 * {image, width, height}.
 */

const cache = new Map();
const DPR = () => Math.min(3, Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));

/** The corridor's risk ramp, shared with the panel so one level is one colour everywhere. */
export const RISK_INK = Object.freeze({
  LOW: '#9ad97f', MODERATE: '#e5bc57', HIGH: '#ee9148', SEVERE: '#e66259',
});

const INK = '#eaf0f7';
const DIM = '#9fb0c4';
const SURFACE = 'rgba(12, 19, 31, 0.93)';
const BORDER = 'rgba(148, 170, 196, 0.45)';

function canvasOf(width, height) {
  const ratio = DPR();
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * ratio);
  canvas.height = Math.ceil(height * ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  return { canvas, ctx };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * The selected incident's card, with the stem that ties it to its own point on the road.
 *
 * The stem is drawn INTO the image rather than added as a separate polyline, because a
 * ground-clamped line is a classification primitive and would be painted over by the road colouring
 * it is meant to sit above.
 */
export function incidentCallout({ id, level, levelLabel, lines = [] }) {
  const key = `callout:${id}:${level}:${levelLabel}:${lines.join('|')}:${DPR()}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const padding = 10;
  const stem = 26;
  const titleFont = '600 13px system-ui, sans-serif';
  const riskFont = '700 11px system-ui, sans-serif';
  const lineFont = '11px system-ui, sans-serif';

  const probe = canvasOf(10, 10).ctx;
  probe.font = titleFont;
  let width = probe.measureText(id).width;
  probe.font = riskFont;
  width = Math.max(width, probe.measureText(`${levelLabel.toUpperCase()} SECONDARY RISK`).width);
  probe.font = lineFont;
  for (const line of lines) width = Math.max(width, probe.measureText(line).width);
  width = Math.ceil(Math.min(290, width) + padding * 2 + 10);

  const bodyHeight = padding + 16 + 14 + (lines.length ? lines.length * 14 + 2 : 0) + padding - 4;
  const height = bodyHeight + stem;
  const { canvas, ctx } = canvasOf(width, height);

  // Card.
  ctx.fillStyle = SURFACE;
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  roundRect(ctx, 0.5, 0.5, width - 1, bodyHeight - 1, 7);
  ctx.fill();
  ctx.stroke();

  // The risk rule down the left edge: colour, but never colour alone — the word is below it.
  ctx.fillStyle = RISK_INK[level] ?? DIM;
  roundRect(ctx, 0.5, 0.5, 3, bodyHeight - 1, 2);
  ctx.fill();

  let y = padding + 2;
  ctx.textBaseline = 'top';
  ctx.fillStyle = INK;
  ctx.font = titleFont;
  ctx.fillText(id, padding + 4, y);
  y += 16;
  ctx.fillStyle = RISK_INK[level] ?? DIM;
  ctx.font = riskFont;
  ctx.fillText(`${levelLabel.toUpperCase()} SECONDARY RISK`, padding + 4, y);
  y += 15;
  ctx.fillStyle = DIM;
  ctx.font = lineFont;
  for (const line of lines) { ctx.fillText(line, padding + 4, y); y += 14; }

  // Stem, from the card down to the anchor point.
  ctx.strokeStyle = RISK_INK[level] ?? DIM;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(width / 2, bodyHeight);
  ctx.lineTo(width / 2, height - 4);
  ctx.stroke();
  ctx.fillStyle = RISK_INK[level] ?? DIM;
  ctx.beginPath();
  ctx.arc(width / 2, height - 3, 3, 0, Math.PI * 2);
  ctx.fill();

  const made = { image: canvas, width, height };
  cache.set(key, made);
  return made;
}

/**
 * The glyphs that say what KIND of record a mapped location holds.
 *
 * Drawn as simple strokes rather than imported icons: these render at 14 px on a satellite image,
 * where a detailed icon becomes a smudge. Each one is a sketch of the movement it names, so the
 * vocabulary can be learned from the legend in a second.
 */
const GLYPHS = {
  // Two lanes converging — a merge or sideswipe.
  merge(ctx, size) {
    const s = size;
    ctx.beginPath();
    ctx.moveTo(s * 0.22, s * 0.74); ctx.lineTo(s * 0.5, s * 0.42); ctx.lineTo(s * 0.5, s * 0.24);
    ctx.moveTo(s * 0.78, s * 0.74); ctx.lineTo(s * 0.5, s * 0.42);
    ctx.stroke();
  },
  // One behind another.
  rearEnd(ctx, size) {
    const s = size;
    ctx.strokeRect(s * 0.3, s * 0.2, s * 0.4, s * 0.22);
    ctx.strokeRect(s * 0.3, s * 0.56, s * 0.4, s * 0.22);
  },
  // A figure beside the road.
  pedestrian(ctx, size) {
    const s = size;
    ctx.beginPath();
    ctx.arc(s * 0.5, s * 0.28, s * 0.09, 0, Math.PI * 2);
    ctx.moveTo(s * 0.5, s * 0.37); ctx.lineTo(s * 0.5, s * 0.62);
    ctx.moveTo(s * 0.5, s * 0.62); ctx.lineTo(s * 0.36, s * 0.8);
    ctx.moveTo(s * 0.5, s * 0.62); ctx.lineTo(s * 0.64, s * 0.8);
    ctx.moveTo(s * 0.32, s * 0.46); ctx.lineTo(s * 0.68, s * 0.46);
    ctx.stroke();
  },
  // A struck roadside object.
  asset(ctx, size) {
    const s = size;
    ctx.beginPath();
    ctx.moveTo(s * 0.5, s * 0.18); ctx.lineTo(s * 0.8, s * 0.5);
    ctx.lineTo(s * 0.5, s * 0.82); ctx.lineTo(s * 0.2, s * 0.5);
    ctx.closePath();
    ctx.stroke();
  },
  // Leaving the running lane.
  departure(ctx, size) {
    const s = size;
    ctx.beginPath();
    ctx.moveTo(s * 0.22, s * 0.3); ctx.lineTo(s * 0.52, s * 0.3);
    ctx.quadraticCurveTo(s * 0.8, s * 0.32, s * 0.76, s * 0.76);
    ctx.stroke();
  },
  other(ctx, size) {
    const s = size;
    ctx.beginPath();
    ctx.moveTo(s * 0.5, s * 0.24); ctx.lineTo(s * 0.5, s * 0.56);
    ctx.moveTo(s * 0.5, s * 0.68); ctx.lineTo(s * 0.5, s * 0.72);
    ctx.stroke();
  },
};

/** A camera body with its lens, and a sign face — the shapes the corridor's own icons use. */
const RESOURCE_GLYPHS = {
  camera(ctx, s) {
    ctx.fillRect(s * 0.18, s * 0.3, s * 0.42, s * 0.36);
    ctx.beginPath();
    ctx.moveTo(s * 0.64, s * 0.4);
    ctx.lineTo(s * 0.84, s * 0.28);
    ctx.lineTo(s * 0.84, s * 0.68);
    ctx.lineTo(s * 0.64, s * 0.56);
    ctx.closePath();
    ctx.fill();
  },
  sign(ctx, s) {
    ctx.fillRect(s * 0.16, s * 0.22, s * 0.68, s * 0.46);
    ctx.fillRect(s * 0.45, s * 0.68, s * 0.1, s * 0.16);
  },
};

/**
 * An upstream camera or sign, lifted off the road on a leader.
 *
 * Pinned at the resource's exact position but drawn above it, because the nearest camera is often
 * a couple of hundred metres from the incident and at corridor zoom its pin landed on top of the
 * incident's. The leader keeps the claim precise while the badge gets out of the way, and it is
 * smaller than a full map pin for the same reason.
 */
export function resourceMarker({ kind = 'camera', stem = 30, selected = false }) {
  const key = `resource:${kind}:${stem}:${selected}:${DPR()}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const radius = 11;
  const width = radius * 2 + 8;
  const height = stem + radius * 2 + 6;
  const { canvas, ctx } = canvasOf(width, height);
  const x = width / 2;
  const cy = radius + 2;
  const face = kind === 'camera' ? '#2563eb' : '#16a34a';
  const ring = selected ? '#F5B51B' : 'rgba(255,255,255,0.92)';

  ctx.strokeStyle = `${face}cc`;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x, cy + radius);
  ctx.lineTo(x, height - 3);
  ctx.stroke();
  ctx.fillStyle = `${face}cc`;
  ctx.beginPath();
  ctx.arc(x, height - 3, 2.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = face;
  ctx.strokeStyle = ring;
  ctx.lineWidth = selected ? 2.5 : 1.8;
  ctx.beginPath();
  ctx.arc(x, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.save();
  ctx.translate(x - 7, cy - 7);
  ctx.fillStyle = '#fff';
  (RESOURCE_GLYPHS[kind] ?? RESOURCE_GLYPHS.camera)(ctx, 14);
  ctx.restore();

  const made = { image: canvas, width, height };
  cache.set(key, made);
  return made;
}

/** The legend's own copy of a glyph, for the map key. */
export function patternGlyph(glyph, { size = 16, color = DIM } = {}) {
  const key = `glyph:${glyph}:${size}:${color}:${DPR()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { canvas, ctx } = canvasOf(size, size);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  (GLYPHS[glyph] ?? GLYPHS.other)(ctx, size);
  const made = { image: canvas, width: size, height: size };
  cache.set(key, made);
  return made;
}

/**
 * A cluster of historical records at one place: the count, what kind they are, and a leader.
 *
 * The leader heights are staggered by the caller so neighbouring clusters do not stack their
 * labels — the oldest trick for this, and the only one that works without a layout engine.
 *
 * The count means RECORDS AT THIS MAPPED LOCATION. It is not a score and not a rank, and the map
 * legend says so, because a bare number beside a risk screen will otherwise be read as one.
 */
export function historyLocation({ count, glyph = 'other', stem = 22, emphasis = 'normal' }) {
  const key = `histloc:${count}:${glyph}:${stem}:${emphasis}:${DPR()}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const radius = 13;
  const width = radius * 2 + 16;
  const height = stem + radius * 2 + 6;
  const { canvas, ctx } = canvasOf(width, height);
  const x = width / 2;
  const cy = radius + 2;
  const bright = emphasis === 'filtered';
  const face = bright ? 'rgba(110, 168, 255, 0.95)' : 'rgba(199, 210, 224, 0.92)';
  const ink = '#0b1220';

  // Leader down to the mapped point.
  ctx.strokeStyle = bright ? 'rgba(110, 168, 255, 0.85)' : 'rgba(199, 210, 224, 0.6)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(x, cy + radius);
  ctx.lineTo(x, height - 3);
  ctx.stroke();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.beginPath();
  ctx.arc(x, height - 3, 2.2, 0, Math.PI * 2);
  ctx.fill();

  // The bubble, carrying the pattern glyph.
  ctx.fillStyle = face;
  ctx.strokeStyle = 'rgba(11, 18, 32, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.save();
  ctx.translate(x - 8, cy - 8);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  (GLYPHS[glyph] ?? GLYPHS.other)(ctx, 16);
  ctx.restore();

  // The count rides on the shoulder of the bubble, so the glyph stays readable.
  if (count > 1) {
    ctx.fillStyle = ink;
    ctx.strokeStyle = face;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x + radius - 2, cy - radius + 3, 7.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fill();
    ctx.fillStyle = face;
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(count), x + radius - 2, cy - radius + 4);
  }

  const made = { image: canvas, width, height };
  cache.set(key, made);
  return made;
}

/** @deprecated kept for the plain-count cluster; superseded by historyLocation. */
export function historyCluster({ count, stem = 22, dimmed = false }) {
  const key = `cluster:${count}:${stem}:${dimmed}:${DPR()}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const label = String(count);
  const radius = count > 1 ? 10 : 6;
  const width = Math.max(30, radius * 2 + 10);
  const height = stem + radius * 2 + 6;
  const { canvas, ctx } = canvasOf(width, height);
  const alpha = dimmed ? 0.3 : 1;
  const x = width / 2;

  ctx.globalAlpha = alpha;
  // Leader down to the anchor.
  ctx.strokeStyle = 'rgba(199, 210, 224, 0.7)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, radius * 2 + 2);
  ctx.lineTo(x, height - 2);
  ctx.stroke();
  // Anchor foot.
  ctx.fillStyle = 'rgba(199, 210, 224, 0.8)';
  ctx.beginPath();
  ctx.arc(x, height - 2, 2, 0, Math.PI * 2);
  ctx.fill();
  // The bubble.
  ctx.fillStyle = dimmed ? 'rgba(120, 136, 156, 0.55)' : 'rgba(199, 210, 224, 0.92)';
  ctx.strokeStyle = 'rgba(11, 18, 32, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, radius + 2, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (count > 1) {
    ctx.fillStyle = '#0b1220';
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, radius + 3);
  }
  ctx.globalAlpha = 1;

  const made = { image: canvas, width, height };
  cache.set(key, made);
  return made;
}

/** A small chevron pointing along the direction of travel. Rotated by the caller to the heading. */
export function travelChevron(color = '#9fb0c4') {
  const key = `chevron:${color}:${DPR()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const size = 18;
  const { canvas, ctx } = canvasOf(size, size);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Points up; Cesium rotation turns it to the heading.
  ctx.beginPath();
  ctx.moveTo(size * 0.26, size * 0.62);
  ctx.lineTo(size * 0.5, size * 0.34);
  ctx.lineTo(size * 0.74, size * 0.62);
  ctx.stroke();
  const made = { image: canvas, width: size, height: size };
  cache.set(key, made);
  return made;
}

/**
 * A quiet text chip pinned to the road: a section name, a lane-closure note, a resource label.
 *
 * `tone` only shifts the accent; the words carry the meaning, so nothing here depends on colour.
 */
export function mapChip(text, { tone = null, sub = null } = {}) {
  const key = `chip:${text}:${tone}:${sub}:${DPR()}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const font = '600 11px system-ui, sans-serif';
  const subFont = '10px system-ui, sans-serif';
  const probe = canvasOf(10, 10).ctx;
  probe.font = font;
  let width = probe.measureText(text).width;
  if (sub) { probe.font = subFont; width = Math.max(width, probe.measureText(sub).width); }
  width = Math.ceil(width + 18);
  const height = sub ? 32 : 20;
  const { canvas, ctx } = canvasOf(width, height);

  ctx.fillStyle = SURFACE;
  ctx.strokeStyle = tone ? `${tone}99` : BORDER;
  ctx.lineWidth = 1;
  roundRect(ctx, 0.5, 0.5, width - 1, height - 1, 5);
  ctx.fill();
  ctx.stroke();
  ctx.textBaseline = 'top';
  ctx.fillStyle = tone ?? INK;
  ctx.font = font;
  ctx.fillText(text, 9, sub ? 5 : 4);
  if (sub) {
    ctx.fillStyle = DIM;
    ctx.font = subFont;
    ctx.fillText(sub, 9, 19);
  }
  const made = { image: canvas, width, height };
  cache.set(key, made);
  return made;
}

/** Drop everything, for a role change or teardown. */
export const clearMarkerCache = () => cache.clear();

/**
 * Which of several candidate spots is furthest from everything already placed.
 *
 * Map labels were each positioned by their own fixed rule — the section name a tenth of the way
 * along its line, the road name at the middle of the painted band — and both rules put the label on
 * the incident whenever the incident happened to be at that spot. For the road band that was every
 * time, because the band is centred on the incident by construction.
 *
 * A candidate is only as good as its NEAREST neighbour, so the winner is the one whose closest
 * obstacle is furthest away. Ties keep the first candidate, which is the caller's preferred spot.
 *
 * Geometry-agnostic: the caller supplies the distance function, so this works on screen or world
 * coordinates without importing either.
 */
export function pickClearSpot(candidates, avoid, distance) {
  const options = (candidates ?? []).filter(point => point != null);
  if (!options.length) return null;
  if (!avoid?.length) return options[0];
  let best = null;
  for (const candidate of options) {
    const nearest = Math.min(...avoid.map(point => distance(candidate, point)));
    if (!best || nearest > best.nearest) best = { candidate, nearest };
  }
  return best.candidate;
}

/**
 * The "3" on a pin that stands for three records.
 *
 * Its own billboard rather than drawn into the pin, because the pin itself is the shared
 * `assetPinMarker` used across the asset screens and is not ours to change.
 */
export function countBadge(count, { tone = '#0b1220' } = {}) {
  const key = `count:${count}:${tone}:${DPR()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const size = 18;
  const { canvas, ctx } = canvasOf(size, size);
  ctx.fillStyle = tone;
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = '700 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(count), size / 2, size / 2 + 0.5);
  const made = { image: canvas, width: size, height: size };
  cache.set(key, made);
  return made;
}

/**
 * The thread between a lifted marker and the spot it is really at.
 *
 * Its own billboard rather than part of the marker, because the markers above it are the shared
 * `assetPinMarker` — the same pin every asset screen draws — and compositing onto that would mean
 * loading its SVG asynchronously and keeping a second copy of the artwork. A line anchored at the
 * point, with the pin offset above it, gets the same result and leaves the shared pin untouched.
 */
export function leaderLine({ height = 40, color = 'rgba(199, 210, 224, 0.75)' } = {}) {
  const key = `leader:${height}:${color}:${DPR()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const width = 9;
  const { canvas, ctx } = canvasOf(width, height);
  const x = width / 2;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height - 3);
  ctx.stroke();
  // A foot at the true position, so the line reads as pointing rather than floating.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, height - 2.5, 2.5, 0, Math.PI * 2);
  ctx.fill();
  const made = { image: canvas, width, height };
  cache.set(key, made);
  return made;
}

/**
 * A simulated patrol vehicle.
 *
 * Status is carried by SHAPE as well as colour — a bar for busy, a slash for out of service, a
 * chevron for moving — so the distinction survives a colour-blind viewer, a greyscale print and
 * the washed-out contrast of photoreal imagery under direct sun.
 *
 * The body is small by design: five of these sit on a corridor already carrying an incident, its
 * camera and its sign, and a large vehicle icon would bury the thing being investigated.
 */
export function patrolMarker({ status = 'AVAILABLE', color = '#14b8a6', selected = false, simulated = true }) {
  const key = `patrol:${status}:${color}:${selected}:${simulated}:${DPR()}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const width = 30;
  const height = 24;
  const { canvas, ctx } = canvasOf(width, height);
  const bodyW = 22, bodyH = 14;
  const x = (width - bodyW) / 2, y = 3;

  if (selected) {
    ctx.fillStyle = 'rgba(245, 181, 27, 0.28)';
    roundRect(ctx, x - 3, y - 3, bodyW + 6, bodyH + 6, 6);
    ctx.fill();
  }

  // The vehicle body.
  ctx.fillStyle = color;
  ctx.strokeStyle = selected ? '#F5B51B' : 'rgba(255,255,255,0.92)';
  ctx.lineWidth = selected ? 2.2 : 1.5;
  roundRect(ctx, x, y, bodyW, bodyH, 3.5);
  ctx.fill();
  // A dashed outline says "not a real vehicle" before any label is read.
  if (simulated) { ctx.save(); ctx.setLineDash([3, 2]); ctx.stroke(); ctx.restore(); } else ctx.stroke();

  // The status glyph, in the body.
  ctx.save();
  ctx.strokeStyle = '#0b1220';
  ctx.fillStyle = '#0b1220';
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  const cx = width / 2, cy = y + bodyH / 2;
  if (status === 'BUSY') {
    ctx.beginPath(); ctx.moveTo(cx - 3, cy - 3.5); ctx.lineTo(cx - 3, cy + 3.5);
    ctx.moveTo(cx + 3, cy - 3.5); ctx.lineTo(cx + 3, cy + 3.5); ctx.stroke();
  } else if (status === 'OUT_OF_SERVICE') {
    ctx.beginPath(); ctx.moveTo(cx - 4, cy + 4); ctx.lineTo(cx + 4, cy - 4); ctx.stroke();
  } else if (status === 'ON_SCENE' || status === 'SCENE_WORK') {
    ctx.beginPath(); ctx.arc(cx, cy, 3.2, 0, Math.PI * 2); ctx.fill();
  } else if (status === 'DISPATCHED' || status === 'EN_ROUTE') {
    ctx.beginPath(); ctx.moveTo(cx - 4, cy - 3.5); ctx.lineTo(cx + 2, cy); ctx.lineTo(cx - 4, cy + 3.5);
    ctx.moveTo(cx + 1, cy - 3.5); ctx.lineTo(cx + 5, cy); ctx.lineTo(cx + 1, cy + 3.5); ctx.stroke();
  } else {
    // Available: a tick, the only glyph that reads as "ready".
    ctx.beginPath(); ctx.moveTo(cx - 4, cy); ctx.lineTo(cx - 1, cy + 3); ctx.lineTo(cx + 4.5, cy - 3.5); ctx.stroke();
  }
  ctx.restore();

  // The stem down to the road surface.
  ctx.strokeStyle = `${color}cc`;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(width / 2, y + bodyH);
  ctx.lineTo(width / 2, height - 2);
  ctx.stroke();

  const made = { image: canvas, width, height };
  cache.set(key, made);
  return made;
}

/**
 * The upstream end of a simulated queue.
 *
 * Deliberately unlike the incident marker: a hollow ring with a back-pointing chevron, amber, on a
 * stem. An operator must never confuse "where the crash is" with "how far back the traffic is
 * stopped", and those are the two most important points on this map.
 */
export function queueTailMarker({ label = null, sub = null, selected = false }) {
  const key = `queuetail:${label}:${sub}:${selected}:${DPR()}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const radius = 13;
  const stem = 26;
  const width = radius * 2 + 10;
  const height = stem + radius * 2 + 8;
  const { canvas, ctx } = canvasOf(width, height);
  const x = width / 2;
  const cy = radius + 3;
  const tone = '#F5B51B';

  // The stem down to the road.
  ctx.strokeStyle = `${tone}cc`;
  ctx.lineWidth = 1.6;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(x, cy + radius);
  ctx.lineTo(x, height - 3);
  ctx.stroke();
  ctx.setLineDash([]);

  // A hollow ring, not a filled disc: the incident owns the filled disc.
  ctx.fillStyle = 'rgba(12, 19, 31, 0.92)';
  ctx.beginPath();
  ctx.arc(x, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = selected ? '#ffffff' : tone;
  ctx.lineWidth = selected ? 3 : 2.4;
  ctx.stroke();

  // A chevron pointing back upstream — the direction the queue is growing.
  ctx.strokeStyle = tone;
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x + 3.5, cy - 4.5);
  ctx.lineTo(x - 3, cy);
  ctx.lineTo(x + 3.5, cy + 4.5);
  ctx.stroke();

  const made = { image: canvas, width, height };
  cache.set(key, made);
  return made;
}

/**
 * A small directional arrow for the upstream approach.
 *
 * Drawn as repeated billboards along the resolved sections rather than as one long polyline arrow,
 * so the direction reads at every zoom instead of only where the arrowhead happens to be.
 */
export function approachArrow({ color = '#3b82f6', size = 16 } = {}) {
  const key = `approach:${color}:${size}:${DPR()}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { canvas, ctx } = canvasOf(size, size);
  const half = size / 2;
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(half + half * 0.62, half);
  ctx.lineTo(half - half * 0.5, half - half * 0.62);
  ctx.lineTo(half - half * 0.2, half);
  ctx.lineTo(half - half * 0.5, half + half * 0.62);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  const made = { image: canvas, width: size, height: size };
  cache.set(key, made);
  return made;
}
