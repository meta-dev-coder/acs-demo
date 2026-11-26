/**
 * Adaptive change visualization for IFC version comparison: how a change set (server/ifcSpatial/
 * compare.mjs, unchanged) is classified, grouped and sized for the screen. Presentation only: the
 * counts and records are the engine's.
 *
 *  - Modification classes, from each change's own modification records:
 *      placement (moved), geometry (shape, cable route, rotation), connectivity (ports),
 *      properties (attributes, property sets).
 *    Status updates and model-wide property sets are already separated by the engine.
 *  - Significant: added, removed, moved, or a geometry / connectivity modification. A property-only
 *    modification is not significant: listed, not painted across the map by default.
 *  - Groups: added / removed / moved by asset category ("New Circuit Breakers"); modified elements
 *    in two groups, "Modified Network" (geometry or connectivity) and "Modified Properties" (only
 *    properties). Every change is in exactly one group; one element with several modification
 *    classes stays one element and carries all its tags.
 *  - Density: small (≤ 10 changes), medium (≤ 30), large; the thresholds are settings.
 */

export const DENSITY_THRESHOLDS = Object.freeze({ small: 10, medium: 30 });

export function densityOf(total, thresholds = DENSITY_THRESHOLDS) {
  if (total <= thresholds.small) return 'small';
  return total <= thresholds.medium ? 'medium' : 'large';
}

/** The modification classes of one change (a set of 'placement' | 'geometry' | 'connectivity' | 'properties'). */
export function modificationClasses(c) {
  const out = new Set();
  if (c.status === 'MOVED' || c.moved) out.add('placement');
  for (const m of c.modifications ?? []) {
    if (m.kind === 'geometry' || m.kind === 'route' || m.kind === 'rotation') out.add('geometry');
    else if (m.kind === 'ports') out.add('connectivity');
    else if (m.kind === 'properties') out.add('properties');
  }
  return out;
}

export function isSignificant(c) {
  if (c.status !== 'MODIFIED') return true;
  const classes = modificationClasses(c);
  return classes.has('geometry') || classes.has('connectivity') || classes.has('placement');
}

/** Asset categories by IFC class (then network role), with names for one and for many. */
const CATEGORIES = [
  { key: 'breaker', test: c => /ProtectiveDevice|CircuitBreaker/.test(c.ifcClass) || /breaker/i.test(c.networkRole ?? ''), one: 'Circuit Breaker', many: 'Circuit Breakers', icon: 'breaker' },
  { key: 'light', test: c => /LightFixture|Lamp/.test(c.ifcClass) || /light/i.test(c.networkRole ?? ''), one: 'Light', many: 'Lights', icon: 'light' },
  { key: 'cable', test: c => /CableSegment|CableCarrier/.test(c.ifcClass) || /cable|feeder|fibre/i.test(c.networkRole ?? ''), one: 'Cable', many: 'Cables', icon: 'cable' },
  { key: 'transformer', test: c => /Transformer/.test(c.ifcClass), one: 'Transformer', many: 'Transformers', icon: 'transformer' },
  { key: 'crane', test: c => /TransportElement/.test(c.ifcClass) || /crane/i.test(c.networkRole ?? ''), one: 'Crane', many: 'Cranes', icon: 'crane' },
  { key: 'control', test: c => /Controller|Sensor|Alarm|Communications/.test(c.ifcClass) || /scada|rtu/i.test(c.networkRole ?? ''), one: 'Control Device', many: 'Control Devices', icon: 'control' },
  { key: 'switchgear', test: c => /DistributionBoard|Switching|Junction|ElectricDistribution/.test(c.ifcClass), one: 'Switchgear', many: 'Switchgear', icon: 'switchgear' },
  { key: 'other', test: () => true, one: 'Element', many: 'Elements', icon: 'other' },
];
export const categoryOf = c => CATEGORIES.find(k => k.test(c));

const VERB = { ADDED: ['New', 'added'], REMOVED: ['Removed', 'removed'], MOVED: ['Relocated', 'moved'] };

/**
 * The groups of a change set, in display order: added, moved, removed (by category, largest first),
 * then Modified Network, then Modified Properties. Each: {id, status, label, line, icon, members,
 * significant, one, many}.
 */
export function buildGroups(changes) {
  const groups = new Map();
  const add = (id, make, c) => { if (!groups.has(id)) groups.set(id, { ...make(), id, members: [] }); groups.get(id).members.push(c); };
  for (const c of changes) {
    if (c.status === 'MODIFIED') {
      const network = isSignificant(c);
      add(network ? 'modified-network' : 'modified-properties', () => (network
        ? { status: 'MODIFIED', label: 'Modified Network', icon: 'network', significant: true, one: 'Modified Network Element', many: 'Modified Network Elements', order: 3 }
        : { status: 'MODIFIED', label: 'Modified Properties', icon: 'properties', significant: false, one: 'Modified Property Set', many: 'Modified Properties', order: 4 }), c);
      continue;
    }
    const k = categoryOf(c);
    const [word] = VERB[c.status];
    add(`${c.status.toLowerCase()}-${k.key}`, () => ({ status: c.status, label: `${word} ${k.many}`, icon: k.icon, significant: true, one: `${word} ${k.one}`, many: `${word} ${k.many}`,
      order: { ADDED: 0, MOVED: 1, REMOVED: 2 }[c.status] }), c);
  }
  return [...groups.values()].map(g => ({ ...g, line: groupLine(g) }))
    .sort((a, b) => a.order - b.order || b.members.length - a.members.length || a.label.localeCompare(b.label));
}

function groupLine(g) {
  const n = g.members.length;
  const assets = `${n} ${n === 1 ? 'asset' : 'assets'}`;
  if (g.id === 'modified-network') {
    const tags = new Set(g.members.flatMap(c => [...modificationClasses(c)].filter(t => t !== 'properties')));
    return `${assets} (${[...tags].join('/') || 'network'})`;
  }
  if (g.id === 'modified-properties') return `${assets} (attributes/property sets)`;
  return `${assets} ${VERB[g.status][1]}`;
}

/** The label of a cluster of n members of a group: "+12 New Circuit Breakers", "3 Modified Network Elements". */
export function clusterLabel(g, n) {
  if (n === 1) return g.one;
  return g.status === 'MODIFIED' ? `${n} ${g.many}` : `+${n} ${g.many}`;
}

/**
 * Points worth framing: without far outliers (more than three times the median distance from the
 * median point, and at least 400 m), so one distant change does not zoom the whole view out.
 */
export function robustPoints(points) {
  if (points.length < 4) return points;
  const med = values => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const c = { lon: med(points.map(p => p.lon)), lat: med(points.map(p => p.lat)) };
  const k = Math.cos(c.lat * Math.PI / 180) * 111320;
  const d = points.map(p => Math.hypot((p.lon - c.lon) * k, (p.lat - c.lat) * 110540));
  const limit = Math.max(med(d) * 3, 400);
  const kept = points.filter((p, i) => d[i] <= limit);
  return kept.length >= Math.ceil(points.length * 0.6) ? kept : points;
}
