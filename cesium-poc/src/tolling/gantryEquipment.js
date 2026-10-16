/**
 * What the gantry's 3D model says is on it.
 *
 * The Blender model names every piece of equipment, and those names are the only thing that says
 * what a mesh IS — there is no feed, no asset register entry and no glTF `extras` behind them.
 * This module turns one node name into a classified asset, and nothing more: it reads names, it
 * does not read the corridor.
 *
 * Three rules it keeps, because the names are a modelling convention rather than a survey:
 *
 *   1. A lane number here is the modeller's equipment group, NOT a verified roadway lane. It is
 *      labelled "provisional" everywhere it is shown, and it never becomes a traffic lane id.
 *   2. Blender's own collision suffixes (`.001`) never become business identifiers. They order the
 *      assets within a group — deterministically, so the ids are the same on every reload — but the
 *      id itself is a sequence number this module assigns.
 *   3. A name that does not say what something is produces an UNCLASSIFIED asset, not a guess.
 *      "Gantry assets.004" is a real mesh on the gantry whose purpose the model does not state.
 *
 * Pure: strings in, records out. No Cesium, no DOM, no I/O — the same function builds the offline
 * manifest and answers a click in the browser.
 */

/** Equipment classes, with the code each one contributes to an asset id. */
export const EQUIPMENT_TYPES = Object.freeze({
  RFID_ANTENNA: Object.freeze({
    id: 'RFID_ANTENNA', code: 'RFID', label: 'RFID antennas', singular: 'RFID antenna',
    equipmentFunction: 'Reads compatible electronic toll transponders.',
  }),
  VES_CAMERA: Object.freeze({
    id: 'VES_CAMERA', code: 'VES', label: 'VES cameras', singular: 'VES camera',
    equipmentFunction: 'Video enforcement: images a vehicle whose toll is not read electronically.',
  }),
  TOLL_CAMERA: Object.freeze({
    id: 'TOLL_CAMERA', code: 'TOLL_CAM', label: 'Toll cameras', singular: 'Toll camera',
    equipmentFunction: 'Images the vehicle at the point of the toll transaction.',
  }),
  CCTV_CAMERA: Object.freeze({
    id: 'CCTV_CAMERA', code: 'CCTV', label: 'CCTV cameras', singular: 'CCTV camera',
    equipmentFunction: 'Surveillance of the gantry and the carriageway beneath it.',
  }),
  DIGITAL_SIGN: Object.freeze({
    id: 'DIGITAL_SIGN', code: 'DISPLAY', label: 'Digital screens', singular: 'Digital screen',
    equipmentFunction: 'Displays the toll rate or operational message to approaching traffic.',
  }),
  STATIC_SIGN: Object.freeze({
    id: 'STATIC_SIGN', code: 'SIGN', label: 'Signage', singular: 'Sign',
    equipmentFunction: 'Fixed signage mounted on the gantry.',
  }),
  STRUCTURE: Object.freeze({
    id: 'STRUCTURE', code: 'STRUCT', label: 'Gantry structure', singular: 'Structure',
    equipmentFunction: 'The gantry span and its supports.',
  }),
  UNCLASSIFIED: Object.freeze({
    id: 'UNCLASSIFIED', code: 'UNCL', label: 'Unclassified equipment', singular: 'Equipment',
    equipmentFunction: null,
  }),
});

/** How confident the classification is — shown to the operator rather than hidden. */
export const IDENTIFICATION = Object.freeze({
  /** The model names the type, the group and the side. */
  NAMED: 'NAMED',
  /** The model names the type but not which group it serves. */
  GROUP_UNKNOWN: 'GROUP_UNKNOWN',
  /** The model does not say what this is. */
  UNCLASSIFIED: 'UNCLASSIFIED',
});

/** The states a what-if scenario may later put an asset into. Nothing writes these yet. */
export const SIMULATION_STATES = Object.freeze(['NORMAL', 'DEGRADED', 'FAILED', 'UNDER_MAINTENANCE']);

/** Nothing is connected to these assets, and the UI says exactly that rather than inventing values. */
export const NOT_CONNECTED = 'Not connected';
export const NOT_AVAILABLE = 'Not available';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
/** Blender's duplicate suffix. Stripped for matching; never part of an id. */
const withoutSuffix = name => clean(name).replace(/\.\d{3}$/, '').trim();

const PATTERNS = [
  { type: 'RFID_ANTENNA', match: /^RFID\s+Lane\s+(\d+)\s*([AB])\b/i },
  { type: 'VES_CAMERA', match: /^VES\s+camera\s+Lane\s+(\d+)\s*([AB])\b/i },
  // "Toll cameras Lane 3 B -1": the trailing number is a modelling duplicate, not an identity.
  { type: 'TOLL_CAMERA', match: /^Toll\s+cameras?\s+Lane\s+(\d+)\s*([AB])\b/i },
  { type: 'CCTV_CAMERA', match: /^CCTV\s+camera\s*([AB])\b/i, sideOnly: true },
  { type: 'DIGITAL_SIGN', match: /^Digital\s+screen\s*([AB])\b/i, sideOnly: true },
  { type: 'TOLL_CAMERA', match: /^Toll\s+cameras?\b/i, unknownGroup: true },
  { type: 'STATIC_SIGN', match: /^Sun\s*pass\s+board\b/i, unknownGroup: true },
  { type: 'STRUCTURE', match: /^gantry\s+main\b/i, unknownGroup: true },
  { type: 'UNCLASSIFIED', match: /^Gantry\s+assets?\b/i, unclassified: true },
];

/**
 * What one glTF node name says about the thing it draws.
 *
 * @param {string} nodeName  the name exactly as the GLB carries it
 * @returns {{type: string, lane: number|null, side: 'A'|'B'|null, identification: string}}
 */
export function classifyNode(nodeName) {
  const name = clean(nodeName);
  for (const rule of PATTERNS) {
    const found = rule.match.exec(name);
    if (!found) continue;
    if (rule.unclassified) {
      return { type: 'UNCLASSIFIED', lane: null, side: null, identification: IDENTIFICATION.UNCLASSIFIED };
    }
    if (rule.unknownGroup) {
      return { type: rule.type, lane: null, side: null, identification: IDENTIFICATION.GROUP_UNKNOWN };
    }
    if (rule.sideOnly) {
      return { type: rule.type, lane: null, side: found[1].toUpperCase(),
        identification: IDENTIFICATION.GROUP_UNKNOWN };
    }
    return { type: rule.type, lane: Number(found[1]), side: found[2].toUpperCase(),
      identification: IDENTIFICATION.NAMED };
  }
  // A name nobody wrote a rule for is unclassified, not forced into the nearest class.
  return { type: 'UNCLASSIFIED', lane: null, side: null, identification: IDENTIFICATION.UNCLASSIFIED };
}

/** A readable name for the operator, built only from what the node name actually says. */
export function displayNameFor({ type, lane, side }) {
  const singular = EQUIPMENT_TYPES[type]?.singular ?? 'Equipment';
  const where = [lane == null ? null : `Lane ${lane}`, side ? `Side ${side}` : null].filter(Boolean).join(', ');
  return where ? `${singular} — ${where}` : singular;
}

/** `A` is the front face of the gantry, `B` the back. Stated by the modeller, not measured. */
export const sideLabel = side => (side === 'A' ? 'A — Front' : side === 'B' ? 'B — Back' : NOT_AVAILABLE);

const pad = (value, width) => String(value).padStart(width, '0');

/**
 * Stable asset ids for a whole model, in one deterministic pass.
 *
 * The sequence number within a (gantry, type, lane, side) bucket comes from sorting the node names,
 * so the same GLB always produces the same ids — including after a reload, and including when the
 * nodes come back from Cesium in a different order than the file lists them.
 *
 * @param {string[]} nodeNames  every node name in the model
 * @param {{gantryId: string}} options
 * @returns {object[]} one record per node, in the order given
 */
export function buildEquipmentAssets(nodeNames, { gantryId } = {}) {
  const gantry = clean(gantryId) || 'GANTRY';
  const classified = nodeNames.map(nodeName => ({ nodeName: clean(nodeName), ...classifyNode(nodeName) }));
  const buckets = new Map();
  for (const item of classified) {
    const key = [item.type, item.lane ?? '-', item.side ?? '-'].join('|');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  }
  const sequence = new Map();
  for (const [, items] of buckets) {
    // Sorted by the node name, suffix included: `.001` orders the group without ever naming it.
    [...items].sort((a, b) => a.nodeName.localeCompare(b.nodeName, 'en'))
      .forEach((item, index) => sequence.set(item.nodeName, index + 1));
  }
  return classified.map(item => {
    const code = EQUIPMENT_TYPES[item.type]?.code ?? 'UNCL';
    const parts = [gantry];
    if (item.lane != null) parts.push(`L${pad(item.lane, 2)}`);
    if (item.side) parts.push(item.side);
    parts.push(code, pad(sequence.get(item.nodeName) ?? 1, 3));
    return Object.freeze({
      assetId: parts.join('_'),
      gantryId: gantry,
      nodeName: item.nodeName,
      type: item.type,
      typeLabel: EQUIPMENT_TYPES[item.type]?.singular ?? 'Equipment',
      /** The modeller's equipment group. NOT a verified roadway lane — see the module comment. */
      laneGroup: item.lane,
      side: item.side,
      name: displayNameFor(item),
      equipmentFunction: EQUIPMENT_TYPES[item.type]?.equipmentFunction ?? null,
      identification: item.identification,
    });
  });
}

/** Counts by equipment type, for an inventory that reports what the model holds. */
export function inventoryOf(assets) {
  const counts = new Map();
  for (const asset of assets ?? []) counts.set(asset.type, (counts.get(asset.type) ?? 0) + 1);
  return Object.keys(EQUIPMENT_TYPES)
    .filter(type => counts.has(type))
    .map(type => ({ type, label: EQUIPMENT_TYPES[type].label, count: counts.get(type) }));
}

/** The equipment an operator would browse: the structure itself is not a piece of equipment. */
export const isEquipment = asset => asset?.type !== 'STRUCTURE';

/**
 * The simulation state an asset starts in.
 *
 * Kept beside the asset rather than in it: a what-if scenario must never write over what the model
 * and the (absent) operational feeds actually say. Nothing sets this yet; the shape is fixed now so
 * the scenario work has somewhere to put its answer.
 */
export const initialSimulationState = () => Object.freeze({ status: 'NORMAL', failureType: null, scenarioId: null });
