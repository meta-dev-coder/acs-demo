/**
 * One icon per asset type, shared by the map markers (SVG billboards) and the page (inline SVG),
 * so an asset looks the same on the map, in the asset list and in the path summary.
 *
 * TYPE COLOUR IS NOT STATUS. The glyph and its rim say what the equipment is; the outer ring of a
 * map marker says its electrical state (energized, no power, unknown, not evaluated). Condition
 * (good / fair / poor) is a third, separate thing and is never drawn on the marker.
 */
export const TYPE_STYLE = Object.freeze({
  UTILITY_SUPPLY: { color: '#f5b83d', label: 'Main supply',
    glyph: '<path d="M13.2 3 6 13.4h5.1L10 21l7.6-10.6h-5.2z" fill="currentColor" stroke-width="1"/>' },
  SUBSTATION: { color: '#a78bfa', label: 'Substation',
    glyph: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M12.9 7.6 9.7 12.3h2.6l-1 4.1 3.3-4.9H12z" fill="currentColor" stroke-width="1"/>' },
  TRANSFORMER: { color: '#22d3ee', label: 'Transformer',
    glyph: '<circle cx="9" cy="12" r="5.2"/><circle cx="15" cy="12" r="5.2"/>' },
  SWITCHGEAR: { color: '#4f8ff7', label: 'Switchgear',
    glyph: '<rect x="5" y="3.5" width="14" height="17" rx="1.5"/><path d="M8.5 8h7M8.5 12h7M8.5 16h7"/>' },
  CIRCUIT_BREAKER: { color: '#4f8ff7', label: 'Breaker',
    glyph: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9.5 14.5l5-5"/>' },
  FEEDER: { color: '#7d8fa8', label: 'Feeder',
    glyph: '<path d="M3 12h18M7 8.5v7M17 8.5v7"/>' },
  CRANE: { color: '#2dd4bf', label: 'Crane',
    glyph: '<path d="M6 21V9M12 21V9M6 14.5h6M2.5 9h19M8 9l2.5-5h3L12 9M18.5 9v4"/><path d="M17 13h3v2.4h-3z"/>' },
  WAREHOUSE: { color: '#94a3b8', label: 'Warehouse',
    glyph: '<path d="M3 10.5 12 5l9 5.5V20H3z"/><path d="M7 20v-6h10v6M7 17h10"/>' },
  LIGHTING_CIRCUIT: { color: '#fcd34d', label: 'Lighting',
    glyph: '<path d="M12 21V10M9 21h6M7.5 4h9l-1.8 4.5H9.3z"/><path d="M9.3 11.6 7.8 13.6M14.7 11.6l1.5 2"/>' },
  EV_CHARGING: { color: '#4ade80', label: 'EV charging',
    glyph: '<rect x="4.5" y="3.5" width="10" height="17" rx="2"/><path d="M10.3 7 7.9 11.5h2.8l-1 4"/><path d="M14.5 9h2.2a1.3 1.3 0 0 1 1.3 1.3V17a1.5 1.5 0 0 0 3 0V8"/>' },
  DISTRIBUTION_PANEL: { color: '#94a3b8', label: 'Distribution panel',
    glyph: '<rect x="6" y="4" width="12" height="16" rx="1.5"/><path d="M9 8h6M9 11h6M12 14v3"/>' },
});
const FALLBACK = { color: '#94a3b8', label: 'Equipment', glyph: '<circle cx="12" cy="12" r="5"/>' };
export const typeStyle = type => TYPE_STYLE[type] ?? FALLBACK;

/** Electrical state of a marker ring. OFFLINE is drawn like NO_POWER; its label says which. */
export const STATUS_COLOR = Object.freeze({
  ENERGIZED: '#2ea043', NO_POWER: '#e5484d', OFFLINE: '#e5484d', UNKNOWN: '#f5a623', NOT_EVALUATED: '#6b7a90',
});

/** An inline icon for the page (list rows, path chips). */
export function iconSvg(type, size = 18) {
  const s = typeStyle(type);
  return `<svg class="sg-icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="color:${s.color}" aria-hidden="true">${s.glyph}</svg>`;
}

const markerCache = new Map();
/**
 * A map marker as a data URI: a dark disc with the type glyph and rim, a status ring outside it,
 * and, when selected, a light halo. Cached by its three inputs, so a re-render never re-encodes.
 */
export function markerImage(type, status, selected = false) {
  const key = `${type}|${status}|${selected}`;
  let uri = markerCache.get(key);
  if (!uri) {
    const s = typeStyle(type);
    const ring = STATUS_COLOR[status] ?? STATUS_COLOR.NOT_EVALUATED;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <defs><filter id="d" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="1.5" stdDeviation="1.6" flood-color="#000" flood-opacity=".6"/></filter></defs>
      ${selected ? '<circle cx="32" cy="32" r="29.5" fill="#8ec5ff33" stroke="#cfe6ff" stroke-width="2.5"/>' : ''}
      <g filter="url(#d)"><circle cx="32" cy="32" r="24" fill="#0b1626" stroke="${ring}" stroke-width="4"/></g>
      <circle cx="32" cy="32" r="19.5" fill="none" stroke="${s.color}" stroke-opacity=".45" stroke-width="1.4"/>
      <g transform="translate(18 18) scale(1.1667)" fill="none" stroke="${s.color}" color="${s.color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${s.glyph}</g>
    </svg>`;
    uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    markerCache.set(key, uri);
  }
  return uri;
}
