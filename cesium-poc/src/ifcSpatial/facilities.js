/**
 * Facilities of an IFC model: substations and other modelled groupings of equipment, found from the
 * IFC itself, never from names.
 *
 *   IFC facilities    an IfcElementAssembly (or any element) that other elements are aggregated into
 *                     (IfcRelAggregates). Its kind is its own ObjectType / PredefinedType: MAIN_SUBSTATION,
 *                     UNIT_SUBSTATION, REEFER_RACK_BLOCK … A substation is one whose type says so. Its
 *                     equipment is exactly what is aggregated into it; its location is the centre of that
 *                     equipment's geometry.
 *   map labels        names the application draws on the map (mockStyle.js ZONES, "MAIN SUBSTATION"):
 *                     kept apart, with their provenance — they are not IFC entities.
 *
 * A transformer is never a substation, and a substation is one facility however much it contains.
 */

const SUBSTATION = /SUBSTATION/i;
const KIND_NAME = { MAIN_SUBSTATION: 'Main substation', UNIT_SUBSTATION: 'Unit substation' };
const humanize = t => String(t ?? '').toLowerCase().replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());

/**
 * @param {object} p
 * @param {Array} p.elements the converted IFC elements (with aggregatedBy, bbox)
 * @param {(globalId: string) => string|null} [p.idOf] the network id of an element, when it is a network asset
 * @param {(x: number, y: number, z: number) => {lon: number, lat: number}} [p.toLonLat]
 * @param {Array} [p.mapLabels] the application's map labels [{text, at: {lon, lat}}]
 * @param {string} [p.version] the model version ("seagirt_power_network.ifc v4")
 */
export function buildFacilities({ elements = [], idOf = () => null, toLonLat = null, mapLabels = [], version = '' } = {}) {
  const byGlobalId = new Map(elements.map(e => [e.globalId, e]));
  const members = new Map();
  for (const e of elements) {
    if (!e.aggregatedBy || !byGlobalId.has(e.aggregatedBy)) continue;
    if (!members.has(e.aggregatedBy)) members.set(e.aggregatedBy, []);
    members.get(e.aggregatedBy).push(e);
  }
  const facilities = [];
  for (const [globalId, parts] of members) {
    const whole = byGlobalId.get(globalId);
    // A grouping of its own (an assembly), not equipment carrying its own sub-parts (a board's breakers).
    if (whole.ifcClass !== 'IfcElementAssembly') continue;
    const type = whole.objectType || whole.predefinedType || 'ASSEMBLY';
    const boxes = parts.map(p => p.bbox).filter(Boolean);
    let location = null;
    if (boxes.length && toLonLat) {
      const c = [0, 1, 2].map(i => boxes.reduce((s, b) => s + (b.min[i] + b.max[i]) / 2, 0) / boxes.length);
      const at = toLonLat(...c);
      if (Number.isFinite(at?.lon)) location = { lon: at.lon, lat: at.lat };
    }
    facilities.push({
      id: whole.tag || whole.name, globalId, name: String(whole.name ?? '').replace(new RegExp(`^${(whole.tag ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`), '') || whole.name,
      type, kind: KIND_NAME[type] ?? humanize(type), substation: SUBSTATION.test(type), ifcClass: whole.ifcClass,
      equipment: parts.map(p => ({ globalId: p.globalId, networkId: idOf(p.globalId), tag: p.tag ?? null, name: p.name, ifcClass: p.ifcClass })),
      location, source: `IFC ${whole.ifcClass} (ObjectType ${type}); equipment by IfcRelAggregates`, version,
    });
  }
  facilities.sort((a, b) => Number(b.type === 'MAIN_SUBSTATION') - Number(a.type === 'MAIN_SUBSTATION') || a.id.localeCompare(b.id, undefined, { numeric: true }));
  const labels = mapLabels.map(l => ({ id: l.text, name: l.text, type: 'MAP_LABEL', location: l.at, source: 'Application map label (drawn by the app, not an IFC entity)' }));
  return { facilities, substations: facilities.filter(f => f.substation), mapLabels: labels };
}

const TYPE_WORDS = [
  [/\btransformers?\b/i, ['IfcTransformer']],
  [/\b(breakers?|protective devices?)\b/i, ['IfcProtectiveDevice']],
  [/\b(switchgear|boards?|buses|bus|ring main units?|rmus?)\b/i, ['IfcElectricDistributionBoard']],
  [/\b(rtus?|controllers?|scada)\b/i, ['IfcController']],
  [/\bswitch(es)?\b/i, ['IfcSwitchingDevice']],
];

/** The facilities a question names: by tag (MSS, USS-1) or "main substation". */
export function facilitiesIn(question, { facilities }) {
  const q = String(question ?? '');
  const found = [];
  for (const f of facilities) {
    const tag = f.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const at = q.search(new RegExp(`(^|[^A-Za-z0-9-])${tag}(?![A-Za-z0-9-])`, 'i'));
    if (at >= 0) found.push([at, f]);
  }
  const main = /\bmain substation\b/i.exec(q);
  if (main) for (const f of facilities.filter(x => x.type === 'MAIN_SUBSTATION')) if (!found.some(([, x]) => x === f)) found.push([main.index, f]);
  return found.sort((a, b) => a[0] - b[0]).map(([, f]) => f);
}

/**
 * Answer a facility question, or null when it is not one. The result says what to show:
 *   { kind: 'list' | 'members' | 'supply' | 'compare', facilities?, members?, groups?, say, say2, notes }
 * @param {object} ctx
 * @param ctx.registry  buildFacilities()
 * @param ctx.assets    the network's assets (Map id → asset)
 * @param ctx.zones     the map's zone names (application-defined)
 * @param ctx.zoneOf    asset → zone name (by distance to the zone label: application-defined)
 * @param ctx.supplyPath asset id → its supply route in normal service ([] if none)
 */
export function answerFacilityQuestion(question, { registry, assets, zones = [], zoneOf = () => null, supplyPath = () => [] }) {
  // "sub stations", "sub-station": the same word.
  const q = String(question ?? '').replace(/\bsub[\s-]+(stations?)\b/gi, 'sub$1');
  const { facilities, substations, mapLabels } = registry;
  const named = facilitiesIn(q, { facilities });
  const aboutSubstations = /\bsubstations?\b/i.test(q);
  const version = facilities[0]?.version ?? '';
  const vtag = /\bv(\d+)\b/i.exec(version)?.[1] ?? null;

  // "What is the difference between Main Substation and USS-1?"
  if (named.length >= 2 && /\b(differen\w*|differ|compare|comparison|versus|vs\.?)\b/i.test(q)) {
    const [a, b] = named;
    const line = f => {
      const classes = countBy(f.equipment.map(e => e.ifcClass.replace(/^Ifc/, '')));
      const volts = [...new Set(f.equipment.map(e => assets.get(e.networkId)?.voltageLevel).filter(Boolean))];
      return `${f.id} — ${f.kind.toLowerCase()} (${f.name}): ${f.equipment.length} items (${classes}); voltages ${volts.join(', ') || 'not recorded'}.`;
    };
    return { kind: 'compare', facilities: [a, b], say: `${a.id} is a ${a.kind.toLowerCase()}; ${b.id} is a ${b.kind.toLowerCase()}.`,
      say2: `${a.id} has ${a.equipment.length} items of equipment, ${b.id} has ${b.equipment.length}.`, bullets: [line(a), line(b)], notes: [a.source] };
  }

  // "Which transformers are inside the Main Substation?", "What equipment belongs to USS-1?"
  if (named.length === 1 && (aboutSubstations || /\b(equipment|belongs?|inside|contain\w*|part of|members?|in (the )?|what(?:'s| is) (in|at))\b/i.test(q))
    && !/\bsuppl(y|ies|ied)|feeds?\b/i.test(q)) {
    const f = named[0];
    const filter = TYPE_WORDS.find(([re]) => re.test(q.replace(/\bsubstations?\b/ig, '')));
    const list = filter ? f.equipment.filter(e => filter[1].includes(e.ifcClass)) : f.equipment;
    const noun = filter ? q.match(filter[0])[0].toLowerCase().replace(/s?$/, 's') : 'items of equipment';
    return { kind: 'members', facilities: [f], members: list,
      say: list.length ? `${f.id} (${f.kind.toLowerCase()}) contains ${list.length} ${list.length === 1 ? noun.replace(/s$/, '') : noun}${filter ? `: ${list.map(e => e.networkId ?? e.tag).join(', ')}` : ''}.`
        : `${f.id} (${f.kind.toLowerCase()}) contains no ${noun} in the model.`,
      say2: `From the IFC: what is aggregated into ${f.id} (IfcRelAggregates).`, notes: [f.source] };
  }

  // "Which substations supply the container yard?"
  if (aboutSubstations && /\bsuppl(y|ies|ied)|feeds?|serves?\b/i.test(q)) {
    const zone = zones.find(z => new RegExp(`\\b${z.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(q)) ?? null;
    const targets = zone ? [...assets.values()].filter(a => (zoneOf(a) ?? '').toLowerCase() === zone.toLowerCase()) : [...assets.values()].filter(a => new RegExp(`\\b${a.id}\\b`).test(q));
    if (!targets.length) return null;
    const by = new Map();
    for (const t of targets) {
      const path = new Set(supplyPath(t.id));
      for (const f of substations) {
        if (f.equipment.some(e => e.networkId === t.id)) continue;      // its own equipment
        // It supplies the asset when its own transformer is on the asset's route (passing through its
        // ring main unit on the way to another substation is not supplying).
        if (f.equipment.some(e => e.ifcClass === 'IfcTransformer' && e.networkId && path.has(e.networkId))) { if (!by.has(f)) by.set(f, []); by.get(f).push(t.id); }
      }
    }
    const list = [...by.keys()];
    return { kind: 'supply', facilities: list, groups: list.map(f => ({ facility: f, assets: by.get(f) })),
      say: list.length ? `${list.length} ${list.length === 1 ? 'substation supplies' : 'substations supply'} ${zone ? `the ${zone.toLowerCase()}` : targets.map(t => t.id).join(', ')}: ${list.map(f => f.id).join(', ')}.`
        : `No substation is on the normal supply route of ${zone ? `the ${zone.toLowerCase()}` : 'it'} in the model.`,
      say2: zone ? `The ${zone.toLowerCase()} is a map area drawn by the application, not an IFC space: its assets are those nearest its label (${targets.length}). Supply follows the IFC connectivity under normal switch states.`
        : 'Supply follows the IFC connectivity under normal switch states.',
      notes: ['Facility equipment from IfcRelAggregates; supply routes from IfcRelConnectsPorts'] };
  }

  // "How many substations are there?", "Show all substations on the map"
  if (aboutSubstations && !named.length) {
    const main = substations.filter(f => f.type === 'MAIN_SUBSTATION'), unit = substations.filter(f => f.type === 'UNIT_SUBSTATION');
    const other = substations.filter(f => !main.includes(f) && !unit.includes(f));
    const parts = [main.length && `${main.length} main ${main.length === 1 ? 'substation' : 'substations'} (${main.map(f => f.id).join(', ')})`,
      unit.length && `${unit.length} unit ${unit.length === 1 ? 'substation' : 'substations'} (${range(unit.map(f => f.id))})`, other.length && `${other.length} other (${other.map(f => f.id).join(', ')})`].filter(Boolean);
    const labels = mapLabels.filter(l => SUBSTATION.test(l.name));
    return { kind: 'list', facilities: substations,
      say: substations.length ? `There are ${substations.length} substations in the IFC model${vtag ? ` (IFC V${vtag})` : ''}: ${parts.join(' and ')}.` : 'The IFC model has no substation assembly.',
      say2: labels.length ? `The ${labels.map(l => `“${l.name}”`).join(', ')} label on the map is drawn by the application, not an IFC entity; the IFC’s main substation is ${main.map(f => f.id).join(', ') || 'not modelled'}.` : null,
      notes: ['IfcElementAssembly with ObjectType MAIN_SUBSTATION / UNIT_SUBSTATION; equipment by IfcRelAggregates'] };
  }
  return null;
}

const countBy = list => Object.entries(list.reduce((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {})).map(([k, n]) => `${n} ${k}`).join(', ');
/** "USS-1 to USS-7" when the ids run on, else a list. */
function range(ids) {
  const m = ids.map(id => /^(.*?)(\d+)$/.exec(id));
  if (ids.length > 2 && m.every(x => x && x[1] === m[0][1]) && m.every((x, i) => Number(x[2]) === Number(m[0][2]) + i)) return `${ids[0]} to ${ids.at(-1)}`;
  return ids.join(', ');
}
