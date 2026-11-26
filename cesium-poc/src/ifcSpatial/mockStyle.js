/**
 * The look of the Seagirt power-network what-if mock (the "Seagirt Terminal Power What-If" artifact):
 * its colours, its equipment symbols and its zone labels, so the IFC network draws the same way on
 * the globe. The symbols are that mock's own shapes, as standalone SVG coloured by state.
 *
 * Zone labels and the main-substation box are positions in the mock's reference image; they are
 * turned into IFC model metres with the relation the IFC was built from
 * (x = (px - 974) * 5/3, y = -(py - 456) * 5/3; see public/data/seagirt/ifc-reference-alignment.json)
 * and then placed like the model. They are presentation, not data from the IFC.
 */

export const COLORS = Object.freeze({
  hv: '#c08cff', mv: '#46c1ff', lv: '#38d996', ctl: '#b4c7db', backup: '#ffbf3c', fault: '#ff4f6d', dead: '#6f7a8a',
  node: '#0e161f', faultFill: '#3d1521', backupFill: '#3a2c0c', liveFill: '#0e2a21', casing: '#061019', select: '#ffffff',
});

/** Image pixel (the mock's reference image) → IFC model metres. */
export const mockPxToModel = ([px, py]) => [(px - 974) * 5 / 3, -(py - 456) * 5 / 3];

export const ZONES = Object.freeze([
  { text: 'ICTF RAIL YARD', px: [440, 440] }, { text: 'CONTAINER YARD', px: [880, 530] },
  { text: 'BERTH ZONE W', px: [545, 792] }, { text: 'BERTH ZONE C', px: [858, 816] }, { text: 'BERTH ZONE E', px: [1140, 816] },
  { text: 'TRUCK GATE', px: [1080, 300] }, { text: 'COLGATE CREEK', px: [1105, 128] }, { text: 'DUNDALK MARINE TERMINAL', px: [1335, 292] },
  { text: 'MAIN SUBSTATION', px: [986, 421] },
]);
/** The dashed outline the mock draws round the main substation (x, y, width, height in image px). */
export const MAIN_SUBSTATION_BOX = Object.freeze([930, 428, 88, 56]);

const FX = '<path d="M-8 -8 L8 8 M8 -8 L-8 8" fill="none" stroke="{fault}" stroke-width="2.4" stroke-linecap="round"/>';
/** Each symbol as SVG markup in a -16..16 box; {c} is the state colour, {f} the fill. */
const SHAPES = {
  src: '<circle r="10" fill="{f}" stroke="{c}" stroke-width="1.8"/><path d="M-6 0 C-4 -5 -2 -5 0 0 S4 5 6 0" fill="none" stroke="{c}" stroke-width="1.6" stroke-linecap="round"/>',
  gen: '<circle r="10" fill="{f}" stroke="{c}" stroke-width="1.8"/><text y="3.5" text-anchor="middle" font-family="monospace" font-weight="700" font-size="9.5" fill="{c}">G</text>',
  mtx: '<circle cy="-4.5" r="7" fill="{f}"/><circle cy="4.5" r="7" fill="{f}"/><circle cy="-4.5" r="7" fill="none" stroke="{c}" stroke-width="1.8"/><circle cy="4.5" r="7" fill="none" stroke="{c}" stroke-width="1.8"/>',
  tx: '<circle cy="-3.2" r="5" fill="{f}"/><circle cy="3.2" r="5" fill="{f}"/><circle cy="-3.2" r="5" fill="none" stroke="{c}" stroke-width="1.6"/><circle cy="3.2" r="5" fill="none" stroke="{c}" stroke-width="1.6"/>',
  bus: '<rect x="-12" y="-2.6" width="24" height="5.2" rx="1.5" fill="{c}"/>',
  sw: '<rect x="-5.5" y="-5.5" width="11" height="11" rx="1.5" fill="{sf}" stroke="{c}" stroke-width="1.8"/>{slash}',
  qss: '<rect x="-11" y="-7.5" width="22" height="15" rx="2" fill="{f}" stroke="{c}" stroke-width="1.8"/><path d="M-5 -3.5 V3.5 M0 -3.5 V3.5 M5 -3.5 V3.5" fill="none" stroke="{c}" stroke-width="1.6" stroke-linecap="round"/>',
  vault: '<rect x="-3.6" y="-3.6" width="7.2" height="7.2" fill="{f}" stroke="{c}" stroke-width="1.8"/>',
  sts: '<rect x="-4.5" y="-10.5" width="9" height="5.5" rx="1" fill="{f}" stroke="{c}" stroke-width="1.8"/><path d="M-7 8 L-4.5 -5 M7 8 L4.5 -5 M-9.5 -5 H9.5 M-5.5 2 H5.5" fill="none" stroke="{c}" stroke-width="1.9" stroke-linecap="round"/>',
  rmu: '<rect x="-9.5" y="-9.5" width="19" height="19" rx="3" fill="{f}" stroke="{c}" stroke-width="1.8"/><circle cy="-2.6" r="4" fill="none" stroke="{tx}" stroke-width="1.5"/><circle cy="2.6" r="4" fill="none" stroke="{tx}" stroke-width="1.5"/>',
  reefer: '<rect x="-12.5" y="-7.5" width="25" height="15" rx="2" fill="{f}" stroke="{c}" stroke-width="1.8"/><path d="M0 -4.6 V4.6 M-4 -2.3 L4 2.3 M-4 2.3 L4 -2.3" fill="none" stroke="{c}" stroke-width="1.6" stroke-linecap="round"/>',
  mast: '<circle r="3.8" fill="{f}" stroke="{c}" stroke-width="1.8"/><path d="M0 -8.5 V-6 M0 8.5 V6 M-8.5 0 H-6 M8.5 0 H6 M-6 -6 L-4.4 -4.4 M6 6 L4.4 4.4 M-6 6 L-4.4 4.4 M6 -6 L4.4 -4.4" fill="none" stroke="{c}" stroke-width="1.6" stroke-linecap="round"/>',
  gate: '<rect x="-11.5" y="-7.5" width="23" height="15" rx="2" fill="{f}" stroke="{c}" stroke-width="1.8"/><path d="M-4 -7.5 V7.5 M4 -7.5 V7.5" fill="none" stroke="{c}" stroke-width="1.6"/>',
  ops: '<rect x="-10.5" y="-8.5" width="21" height="17" rx="2" fill="{f}" stroke="{c}" stroke-width="1.8"/><path d="M-6 -3.5 H6 M-6 0.5 H6 M-6 4.5 H2" fill="none" stroke="{c}" stroke-width="1.6" stroke-linecap="round"/>',
  office: '<path d="M-9 7.5 V-2 L0 -8.5 L9 -2 V7.5 Z" fill="{f}" stroke="{c}" stroke-width="1.8"/>',
  shop: '<path d="M-9 7.5 V-2 L0 -8.5 L9 -2 V7.5 Z" fill="{f}" stroke="{c}" stroke-width="1.8"/><path d="M-3.5 7.5 V2 H3.5 V7.5" fill="none" stroke="{c}" stroke-width="1.6"/>',
  ats: '<circle r="7.5" fill="{f}" stroke="{c}" stroke-width="1.8"/><text y="3.3" text-anchor="middle" font-family="monospace" font-weight="700" font-size="9.5" fill="{c}">A</text>',
};
/** Loads show their own state in the fill (the mock's green / amber / red tiles). */
const LOADS = new Set(['sts', 'reefer', 'mast', 'gate', 'ops', 'office', 'shop']);

/**
 * A symbol as an SVG data URL.
 * @param {string} kind      symbolOf(asset)
 * @param {object} o
 * @param {string} o.state   live | dead | backup | off | open
 * @param {string} o.kv      hv | mv | lv (the line colour of equipment that is not a load)
 * @param {boolean} [o.selected]
 */
export function symbolImage(kind, { state = 'live', kv = 'mv', selected = false, open = false } = {}) {
  const isLoad = LOADS.has(kind);
  const colour = state === 'off' ? COLORS.fault : state === 'dead' ? (isLoad ? COLORS.fault : COLORS.dead)
    : state === 'backup' ? COLORS.backup : isLoad ? COLORS.lv : COLORS[kv] ?? COLORS.mv;
  const fill = !isLoad ? COLORS.node : state === 'dead' || state === 'off' ? COLORS.faultFill : state === 'backup' ? COLORS.backupFill : COLORS.liveFill;
  const body = (SHAPES[kind] ?? SHAPES.vault)
    .replaceAll('{c}', colour).replaceAll('{f}', fill).replaceAll('{tx}', state === 'live' ? COLORS.lv : colour)
    .replaceAll('{sf}', open ? COLORS.node : colour)
    .replace('{slash}', open ? `<path d="M-3.6 3.6 L3.6 -3.6" stroke="${colour}" stroke-width="1.6" stroke-linecap="round"/>` : '');
  const ring = selected ? `<circle r="14.5" fill="none" stroke="${COLORS.select}" stroke-width="1.8"/>` : '';
  const fault = state === 'off' ? FX.replace('{fault}', COLORS.fault) : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="-16 -16 32 32">${ring}${body}${fault}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** On-screen size of each symbol (px), roughly the mock's relative sizes. */
export const SYMBOL_SIZE = Object.freeze({ src: 26, gen: 26, mtx: 28, tx: 20, bus: 28, sw: 20, qss: 28, vault: 16, sts: 26, rmu: 26, reefer: 30, mast: 20, gate: 28, ops: 26, office: 24, shop: 24, ats: 20 });

/** Status colours for the tiles: the Power Status panel's own. */
export const STATUS_TILE = Object.freeze({ dead: '#ff3b4f', degraded: '#ffb020', standby: '#8593a3', backup: '#ffbf3c', load: '#2fbf71' });

/**
 * An asset as a status tile: its symbol in a dark rounded tile with a soft glow in its status colour
 * (voltage colour for powered equipment, green for a powered load, red without power, amber degraded
 * or on generator, grey standby), with a small badge for no power or degraded.
 * @param {string} kind   symbolOf(asset)
 * @param {object} o      state (live | dead | backup | standby | off), kv, selected, open, degraded
 */
export function tileImage(kind, { state = 'live', kv = 'mv', selected = false, open = false, degraded = false, tint = null } = {}) {
  const isLoad = LOADS.has(kind);
  const dead = !tint && (state === 'dead' || state === 'off');
  // A tint (a version comparison's change colour) replaces the status colour.
  const statusColour = dead ? STATUS_TILE.dead : degraded ? STATUS_TILE.degraded : state === 'backup' ? STATUS_TILE.backup
    : state === 'standby' ? STATUS_TILE.standby : isLoad ? STATUS_TILE.load : COLORS[kv] ?? COLORS.mv;
  const colour = tint ?? statusColour;
  const fill = tint ? '#0a1622' : dead ? '#3d0a13' : degraded || state === 'backup' ? '#3a2706' : '#0a1622';
  const body = (SHAPES[kind] ?? SHAPES.vault)
    .replaceAll('{c}', colour).replaceAll('{f}', fill).replaceAll('{tx}', colour)
    .replaceAll('{sf}', open ? fill : colour)
    .replace('{slash}', open ? `<path d="M-3.6 3.6 L3.6 -3.6" stroke="${colour}" stroke-width="1.6" stroke-linecap="round"/>` : '');
  const badge = dead
    ? `<circle cx="13" cy="-13" r="6.2" fill="${STATUS_TILE.dead}" stroke="#fff" stroke-width="1.2"/><path d="M13.9 -17.4 L10.9 -12.4 H13.1 L12.3 -8.8 L15.4 -13.6 H13.2 Z" fill="#fff"/>`
    : degraded && !tint ? `<circle cx="13" cy="-13" r="6.2" fill="${STATUS_TILE.degraded}" stroke="#fff" stroke-width="1.2"/><path d="M13 -16.4 V-12.6" stroke="#2a1a00" stroke-width="1.8" stroke-linecap="round"/><circle cx="13" cy="-10.2" r="1" fill="#2a1a00"/>` : '';
  const ring = selected ? '<rect x="-19.5" y="-19.5" width="39" height="39" rx="10" fill="none" stroke="#ffffff" stroke-width="2"/>' : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="-24 -24 48 48">
  <defs><filter id="g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${dead || degraded ? 2.6 : 1.8}"/></filter></defs>
  <rect x="-16" y="-16" width="32" height="32" rx="8" fill="none" stroke="${colour}" stroke-width="${dead || degraded ? 4 : 3}" opacity="${dead || degraded ? 0.95 : 0.7}" filter="url(#g)"/>
  <rect x="-16" y="-16" width="32" height="32" rx="8" fill="${fill}" fill-opacity="0.94" stroke="${colour}" stroke-width="1.8"/>
  <g transform="scale(0.82)">${body}</g>${state === 'off' ? FX.replace('{fault}', COLORS.fault) : ''}${badge}${ring}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** On-screen size of each status tile (px). */
export const TILE_SIZE = Object.freeze({ src: 32, gen: 30, mtx: 34, tx: 26, bus: 32, sw: 26, qss: 34, vault: 22, sts: 32, rmu: 32, reefer: 34, mast: 26, gate: 32, ops: 32, office: 30, shop: 30, ats: 26 });
