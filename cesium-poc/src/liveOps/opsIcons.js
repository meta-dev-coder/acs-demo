/**
 * One icon per operational layer, used in two places: the Live Ops layers panel and the map pins.
 *
 * Defined once so a closure looks like a closure wherever it appears — the panel row an operator
 * ticks and the marker they then look for on the map are the same orange cone, not two unrelated
 * drawings. Each glyph is authored on a 24×24 grid and scaled into whichever host needs it.
 *
 * Colours are saturated on purpose. These are operational categories an operator scans for at a
 * glance, and the previous dark badges with thin strokes all read the same from a distance.
 */

/** @typedef {{color: string, glyph: string, label: string}} OpsIcon */

/**
 * Filled glyphs, 24×24. Filled rather than stroked because a stroke thins out when the pin is
 * rasterised small, which is what made the old markers hard to tell apart.
 */
export const OPS_ICONS = Object.freeze({
  operationalImpact: Object.freeze({
    label: 'Operational Impact', color: '#0f8d82',
    glyph: '<path d="M2 15.5h20v2.2H2z"/><path d="M4.6 11.2h3.2v3.1H4.6zM10.4 8.4h3.2v5.9h-3.2zM16.2 5.2h3.2v9.1h-3.2z"/>',
  }),
  incidents: Object.freeze({
    label: 'Incidents', color: '#e5484d',
    glyph: '<path d="M12 2.8 23 21.2H1z"/><path d="M11 9h2v6h-2zM11 16.4h2v2h-2z" fill="#fff"/>',
  }),
  disabledVehicles: Object.freeze({
    label: 'Disabled Vehicles', color: '#3b82f6',
    glyph: '<path d="M3.4 13.2 5.6 7.4A2 2 0 0 1 7.5 6h9a2 2 0 0 1 1.9 1.4l2.2 5.8v5.3a1 1 0 0 1-1 1h-1.5a1 1 0 0 1-1-1v-1H6.9v1a1 1 0 0 1-1 1H4.4a1 1 0 0 1-1-1z"/><circle cx="7.1" cy="15.1" r="1.4" fill="#fff"/><circle cx="16.9" cy="15.1" r="1.4" fill="#fff"/>',
  }),
  closures: Object.freeze({
    label: 'Lane Closures', color: '#dc2626',
    // A striped barrier: an unmistakable silhouette next to the incident triangle and the cone.
    glyph: '<path d="M2 7.6h20v8.8H2z"/><path d="m6.2 7.6-3 8.8H5l3-8.8zM12.2 7.6l-3 8.8H11l3-8.8zM18.2 7.6l-3 8.8H17l3-8.8z" fill="#fff"/><path d="M2.6 4.4h2.2v15.2H2.6zM19.2 4.4h2.2v15.2h-2.2z"/>',
  }),
  construction: Object.freeze({
    label: 'Construction Zones', color: '#f97316',
    // A cone, not a second warning triangle — the triangle belongs to incidents.
    glyph: '<path d="M10.7 2.8h2.6l5.1 15.6H5.6z"/><path d="M8.6 9.4h6.8l.8 2.5H7.8z" fill="#fff"/><path d="M2.4 18.4h19.2v2.8H2.4z"/>',
  }),
  congestion: Object.freeze({
    label: 'Congestion', color: '#eab308',
    glyph: '<path d="M3 5.2h13v3.4H3zM3 10.3h13v3.4H3zM3 15.4h13v3.4H3z"/><path d="M19.4 4.8h2.2v11.4h-2.2z"/><path d="m16.6 15.2 3.9 4.2 3.9-4.2z"/>',
  }),
  cameras: Object.freeze({
    label: 'Traffic Cameras', color: '#334155',
    glyph: '<path d="M2.6 6.4h12.2a1.6 1.6 0 0 1 1.6 1.6v8a1.6 1.6 0 0 1-1.6 1.6H2.6A1.6 1.6 0 0 1 1 16V8a1.6 1.6 0 0 1 1.6-1.6z"/><path d="m18 9.6 4.4-2.6v10l-4.4-2.6z"/>',
  }),
  messageSigns: Object.freeze({
    label: 'Message Signs', color: '#1e293b',
    glyph: '<path d="M2.4 4.6h19.2a1.4 1.4 0 0 1 1.4 1.4v9.2a1.4 1.4 0 0 1-1.4 1.4H2.4A1.4 1.4 0 0 1 1 15.2V6a1.4 1.4 0 0 1 1.4-1.4z"/><path d="M4.2 7.6h8v1.6h-8zM4.2 11.2h12v1.6h-12z" fill="#fff"/><path d="M11 17.4h2v3.4h-2z"/>',
  }),
});

/** A live event's type, as the feed names it, to the icon that represents it. */
export const ICON_FOR_EVENT_TYPE = Object.freeze({
  INCIDENT: 'incidents', CLOSURE: 'closures', CONSTRUCTION: 'construction',
  CONGESTION: 'congestion', DISABLED: 'disabledVehicles',
});

export const opsIcon = id => OPS_ICONS[id] ?? null;

/** The icon as inline SVG, for a panel row or a legend. */
export function opsIconMarkup(id, size = 18) {
  const icon = OPS_ICONS[id];
  if (!icon) return '';
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false" fill="${icon.color}">${icon.glyph}</svg>`;
}

/**
 * The same icon as a Cesium billboard: a rounded badge in the icon's own colour with the glyph in
 * white, on the corridor's existing pin shape so Live Ops markers stay part of the family.
 *
 * Rasterised at 4× like the other corridor pins, so it stays sharp when the camera is close.
 */
export function opsPinDataUrl(id) {
  const icon = OPS_ICONS[id];
  if (!icon) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="176" height="208" viewBox="0 0 44 52">
<path d="M17 40 22 49 27 40" fill="${icon.color}" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/>
<rect x="2" y="2" width="40" height="40" rx="12" fill="#fff"/>
<rect x="4" y="4" width="36" height="36" rx="10" fill="${icon.color}"/>
<g transform="translate(10 10)" fill="#fff">${cutouts(icon.glyph, icon.color)}</g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * The glyph is drawn white on a coloured badge, so the parts that are white on a white panel row —
 * the bar of an exclamation mark, a cone's stripe — have to become the badge colour to stay
 * visible. Rendering them translucent instead made every marker read as a muddy blob.
 */
function cutouts(glyph, color) {
  return glyph.replaceAll('fill="#fff"', `fill="${color}"`);
}
