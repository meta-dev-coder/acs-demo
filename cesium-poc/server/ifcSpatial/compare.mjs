/**
 * IFC version comparison: element-level differences between two converted versions of one IFC file.
 *
 * Input is each version's element index (convert.mjs: GlobalId, class, attributes, property sets,
 * placement origin in metres, a geometry signature in the element's own frame, cable routes) and its
 * georeference. Nothing is compared from pixels or whole-model boxes.
 *
 *  - Identity: IfcRoot.GlobalId. Elements left over on both sides get a secondary match (same class,
 *    then NetworkID, tag, name, shape, distance), which carries a confidence and is accepted only when
 *    it is strong and unambiguous; a weaker one is reported as a possible match, never applied.
 *  - Position: the placement origin (the bounding-box centre when an element has no placement), in
 *    projected grid metres through each version's own IfcMapConversion when both are georeferenced,
 *    so a changed map conversion is not an element move; in model metres otherwise. A displacement
 *    shared by most elements is a model origin shift, reported once and taken out of every element.
 *  - Change: MOVED beyond the tolerance; MODIFIED for geometry (signature or cable route), rotation,
 *    properties, attributes or ports. An element can be both; it keeps both.
 *  - Status is not a version change: the operational status properties (SuperDNA_AssetStatus,
 *    Pset_Condition) and a description that is a status note ("NO POWER: …") are set as the plant runs,
 *    not as the design changes. An element whose only differences are these is unchanged; its status
 *    update is listed separately (statusUpdates) for reference, not counted.
 *  - A property set added to (or dropped from) most elements at once is one model-wide change: it is
 *    reported once as a group, and an element whose only change it is stays out of the change list
 *    (still counted), so the elements that really changed are not buried under it.
 *  - Ports (IfcDistributionPort) are counted on the element they belong to, not listed on their own;
 *    spatial structure (site, building, storey) is not an asset and is left out.
 */

export const COMPARE_VERSION = 3;
export const DEFAULT_OPTIONS = Object.freeze({ moveToleranceM: 0.05, rotationToleranceDeg: 1, routeToleranceM: 0.05, numberTolerance: 1e-6 });

const SPATIAL = /^Ifc(Project|Site|Building|BuildingStorey|Space|SpatialZone|ExternalSpatialElement|Facility|FacilityPart|Bridge|BridgePart|Road|RoadPart|Railway|RailwayPart|MarineFacility|MarineFacilityPart|Annotation|Grid|VirtualElement)$/;
const isPort = e => Boolean(e.hostGlobalId) || /Port$/.test(e.ifcClass ?? '');
const ATTRIBUTES = ['name', 'ifcClass', 'predefinedType', 'objectType', 'tag', 'description'];

const STATUS_PSETS = new Set(['SuperDNA_AssetStatus', 'Pset_Condition']);
const STATUS_NOTE = /^\s*(NO POWER|POOR CONDITION|DEGRADED|OFFLINE|OUT OF SERVICE|POWERED|OK)\s*:/i;
/** A property change that is operational status, not design. */
export function isStatusChange(p) {
  if (p.group === 'property') return STATUS_PSETS.has(p.key.split('.')[0]);
  return p.key === 'description' && (STATUS_NOTE.test(String(p.before ?? '')) || STATUS_NOTE.test(String(p.after ?? '')));
}

const sub = (a, b) => a.map((v, i) => v - b[i]);
const norm = v => Math.hypot(...v);
const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

/** Readable kind of element for labels ("New light"), from its network role or class. */
export function kindOf(e) {
  const role = String(e.networkRole ?? '');
  if (/light/i.test(role) || /LightFixture|Lamp/.test(e.ifcClass)) return 'light';
  if (e.ifcClass === 'IfcCableSegment' || /cable|feeder/i.test(role)) return 'cable';
  if (/Transformer/.test(e.ifcClass)) return 'transformer';
  if (/crane/i.test(role) || /TransportElement/.test(e.ifcClass)) return 'crane';
  if (/switch|intake|board|breaker/i.test(role) || /DistributionBoard|Switching|ProtectiveDevice/.test(e.ifcClass)) return 'switchgear';
  return String(e.ifcClass ?? 'element').replace(/^Ifc/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/** The point halfway along a route, by length. */
function routeMidpoint(route) {
  const half = routeLength(route) / 2;
  let walked = 0;
  for (let i = 1; i < route.length; i += 1) {
    const step = norm(sub(route[i], route[i - 1]));
    if (walked + step >= half) { const t = step ? (half - walked) / step : 0; return route[i - 1].map((v, k) => v + t * (route[i][k] - v)); }
    walked += step;
  }
  return route[0];
}

/**
 * Where the element is, in its version's model metres: halfway along a cable's route (cables are often
 * placed at the model origin, their route carries where they are), else the placement origin, else
 * the box centre.
 */
function modelPosition(e) {
  if (e.route?.length >= 2) return { point: routeMidpoint(e.route), from: 'route' };
  if (e.placement?.origin) return { point: e.placement.origin, from: 'placement' };
  if (e.bbox) return { point: e.bbox.min.map((m, i) => (m + e.bbox.max[i]) / 2), from: 'bbox' };
  return null;
}

/**
 * The frame positions are compared in. PROJECTED: both versions are georeferenced, each converted
 * with its own IfcMapConversion (model metres → grid metres; the conversion's scale is per model unit).
 */
function frameFor(base, target) {
  const mc = v => v.georeference?.mapConversion ?? null;
  const [a, b] = [mc(base), mc(target)];
  const notes = [];
  if (a && b) {
    const changed = ['eastings', 'northings', 'orthogonalHeight', 'xAxisAbscissa', 'xAxisOrdinate', 'scale'].filter(k => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) > 1e-9);
    if (changed.length) notes.push(`The georeference (IfcMapConversion) changed between the versions (${changed.join(', ')}); positions are compared on the map grid, so this alone is not reported as movement.`);
    if ((base.georeference?.projectedCrs?.name ?? null) !== (target.georeference?.projectedCrs?.name ?? null)) {
      notes.push(`The versions name different projected CRSs (${base.georeference?.projectedCrs?.name ?? 'none'} vs ${target.georeference?.projectedCrs?.name ?? 'none'}); positions cannot be compared reliably.`);
      return { frame: 'INCOMPATIBLE', notes, toWorld: null };
    }
    const grid = (conversion, unitScale) => ([x, y, z]) => {
      const length = Math.hypot(conversion.xAxisAbscissa, conversion.xAxisOrdinate) || 1;
      const [ca, cb] = [conversion.xAxisAbscissa / length, conversion.xAxisOrdinate / length];
      const s = (conversion.scale ?? 1) / (unitScale || 1);
      return [conversion.eastings + s * (ca * x - cb * y), conversion.northings + s * (cb * x + ca * y), (conversion.orthogonalHeight ?? 0) + z];
    };
    return { frame: 'PROJECTED', notes, toWorld: [grid(a, base.lengthUnitScale), grid(b, target.lengthUnitScale)] };
  }
  if (a || b) notes.push(`Only version ${a ? base.versionNumber : target.versionNumber} is georeferenced; positions are compared in model coordinates, which assumes both versions share one engineering origin.`);
  return { frame: 'MODEL', notes, toWorld: [p => p, p => p] };
}

function flattenProperties(e) {
  const out = new Map();
  for (const [pset, props] of Object.entries(e.properties ?? {})) for (const [key, value] of Object.entries(props ?? {})) out.set(`${pset}.${key}`, value);
  return out;
}
const normalise = (value, tolerance) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Math.round(value / tolerance) * tolerance;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().replace(/\s+/g, ' ');
  return /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(text) ? Math.round(Number(text) / tolerance) * tolerance : text;
};

function propertyChanges(a, b, tolerance) {
  const changes = [];
  for (const key of ATTRIBUTES) {
    if (normalise(a[key], tolerance) !== normalise(b[key], tolerance)) changes.push({ key, group: 'attribute', before: a[key] ?? null, after: b[key] ?? null });
  }
  const [pa, pb] = [flattenProperties(a), flattenProperties(b)];
  for (const key of [...new Set([...pa.keys(), ...pb.keys()])].sort()) {
    if (normalise(pa.get(key), tolerance) !== normalise(pb.get(key), tolerance)) changes.push({ key, group: 'property', before: pa.get(key) ?? null, after: pb.get(key) ?? null });
  }
  return changes;
}

const routeLength = route => (route ?? []).reduce((sum, p, i, all) => (i ? sum + norm(sub(p, all[i - 1])) : 0), 0);

/** A secondary match's confidence (0..1) for two elements of the same class. */
function similarity(a, b, distance) {
  let score = 0;
  const reasons = [];
  if (a.networkId && a.networkId === b.networkId) { score += 0.6; reasons.push('same NetworkID'); }
  if (a.tag && a.tag === b.tag) { score += 0.2; reasons.push('same tag'); }
  if (a.name && a.name === b.name) { score += 0.2; reasons.push('same name'); }
  if (a.geometry?.signature && a.geometry.signature === b.geometry?.signature) { score += 0.2; reasons.push('same shape'); }
  if (Number.isFinite(distance) && distance < 1) { score += 0.2; reasons.push('within 1 m'); } else if (Number.isFinite(distance) && distance < 10) { score += 0.1; reasons.push('within 10 m'); }
  return { confidence: round(Math.min(1, score), 2), reasons };
}

/**
 * Compare two versions. Each is `{versionNumber, versionId, elements, georeference, lengthUnitScale}`.
 * Returns the change set: a summary, one entry per changed element, the frame used and any caveats.
 */
export function compareVersions(base, target, options = {}) {
  const opt = { ...DEFAULT_OPTIONS, ...options };
  const warnings = [];
  const frame = frameFor(base, target);
  const assets = version => {
    const list = [], ports = new Map();
    let missing = 0;
    for (const e of version.elements ?? []) {
      if (!e.globalId) { missing += 1; continue; }
      if (isPort(e)) { if (e.hostGlobalId) ports.set(e.hostGlobalId, (ports.get(e.hostGlobalId) ?? 0) + 1); continue; }
      if (SPATIAL.test(e.ifcClass ?? '')) continue;
      list.push(e);
    }
    if (missing) warnings.push(`${missing} elements of version ${version.versionNumber} have no GlobalId and cannot be compared.`);
    return { list, ports, byId: new Map(list.map(e => [e.globalId, e])) };
  };
  const [A, B] = [assets(base), assets(target)];
  const world = (e, side) => {
    const at = modelPosition(e);
    return at && frame.toWorld ? { model: at.point, world: frame.toWorld[side](at.point), from: at.from } : at ? { model: at.point, world: null, from: at.from } : null;
  };

  // ---- identity: GlobalId, then a cautious secondary match ----
  const pairs = [];
  for (const [id, a] of A.byId) if (B.byId.has(id)) pairs.push({ a, b: B.byId.get(id), match: { by: 'GLOBAL_ID', confidence: 1 } });
  const onlyA = [...A.byId.values()].filter(e => !B.byId.has(e.globalId));
  const onlyB = [...B.byId.values()].filter(e => !A.byId.has(e.globalId));
  const candidates = [];
  for (const a of onlyA) for (const b of onlyB) {
    if (a.ifcClass !== b.ifcClass) continue;
    const [pa, pb] = [world(a, 0), world(b, 1)];
    const distance = pa?.world && pb?.world ? norm(sub(pa.world, pb.world)) : NaN;
    const s = similarity(a, b, distance);
    if (s.confidence >= 0.4) candidates.push({ a, b, ...s });
  }
  const best = (list, key, other) => list.filter(c => c[key] === other).sort((x, y) => y.confidence - x.confidence);
  const usedA = new Set(), usedB = new Set(), possible = new Map();
  for (const c of [...candidates].sort((x, y) => y.confidence - x.confidence)) {
    if (usedA.has(c.a) || usedB.has(c.b)) continue;
    const rivals = [...best(candidates, 'a', c.a), ...best(candidates, 'b', c.b)].filter(r => r !== c && Math.abs(r.confidence - c.confidence) < 0.15);
    if (c.confidence >= 0.8 && !rivals.length) {
      usedA.add(c.a); usedB.add(c.b);
      pairs.push({ a: c.a, b: c.b, match: { by: 'SECONDARY', confidence: c.confidence, reasons: c.reasons } });
    } else {
      const note = { confidence: c.confidence, reasons: c.reasons, ambiguous: rivals.length > 0 };
      if (!possible.has(c.a.globalId)) possible.set(c.a.globalId, { ...note, globalId: c.b.globalId, networkId: c.b.networkId, name: c.b.name });
      if (!possible.has(c.b.globalId)) possible.set(c.b.globalId, { ...note, globalId: c.a.globalId, networkId: c.a.networkId, name: c.a.name });
    }
  }
  const secondary = pairs.filter(p => p.match.by === 'SECONDARY').length;
  if (secondary) warnings.push(`${secondary} element${secondary === 1 ? '' : 's'} changed GlobalId between the versions and ${secondary === 1 ? 'was' : 'were'} matched by NetworkID, name and shape (confidence shown on each).`);

  // ---- a model origin shift: one displacement shared by most matched elements ----
  const displaced = pairs.map(p => ({ p, a: world(p.a, 0), b: world(p.b, 1) })).filter(x => x.a?.world && x.b?.world).map(x => ({ ...x, d: sub(x.b.world, x.a.world) }));
  let originShift = null;
  if (displaced.length >= 3) {
    const groups = [];
    for (const x of displaced) {
      const g = groups.find(group => norm(sub(group.d, x.d)) <= opt.moveToleranceM);
      if (g) g.n += 1; else groups.push({ d: x.d, n: 1 });
    }
    const top = groups.sort((x, y) => y.n - x.n)[0];
    if (top && norm(top.d) > opt.moveToleranceM && top.n >= 0.6 * displaced.length) {
      originShift = { vector: top.d.map(n => round(n)), distanceM: round(norm(top.d)), elements: top.n, of: displaced.length };
      warnings.push(`${top.n} of ${displaced.length} elements moved by the same ${round(norm(top.d), 2)} m: read as a change of model origin, not as ${top.n} moved assets. Movement is measured after removing it.`);
    }
  }
  if (frame.frame === 'INCOMPATIBLE') warnings.push('Positions are not compared: the versions are not in a common coordinate system.');

  // ---- per element ----
  const changes = [];
  const statusUpdates = [];
  let unchanged = 0;
  const lonLat = (side, point) => (options.toGeographic && point ? options.toGeographic(side, point) : null);
  const where = (side, e) => {
    const at = world(e, side);
    if (!at) return null;
    return { model: at.model.map(n => round(n)), grid: at.world?.map(n => round(n)) ?? null, from: at.from, geographic: lonLat(side, at.model) };
  };
  for (const { a, b, match } of pairs) {
    const [wa, wb] = [world(a, 0), world(b, 1)];
    let displacement = null;
    if (wa?.world && wb?.world && frame.frame !== 'INCOMPATIBLE') {
      const d = sub(sub(wb.world, wa.world), originShift?.vector ?? [0, 0, 0]);
      displacement = { vector: d.map(n => round(n)), distanceM: round(norm(d)), horizontalM: round(Math.hypot(d[0], d[1])), verticalM: round(d[2]) };
    }
    let moved = Boolean(displacement && displacement.distanceM > opt.moveToleranceM);
    const modifications = [];
    const sa = a.geometry?.signature, sb = b.geometry?.signature;
    if (a.route?.length >= 2 || b.route?.length >= 2) {
      const [la, lb] = [routeLength(a.route), routeLength(b.route)];
      const shift = originShift?.vector ?? [0, 0, 0];
      const toA = p => frame.toWorld?.[0]?.(p) ?? p, toB = p => sub(frame.toWorld?.[1]?.(p) ?? p, shift);
      const rerouted = (a.route?.length ?? 0) !== (b.route?.length ?? 0) || a.route.some((p, i) => norm(sub(toB(b.route[i]), toA(p))) > opt.routeToleranceM);
      // The same route shifted as a whole is a move; a route of a different shape is a re-route, not a move.
      const offset = rerouted && a.route?.length === b.route?.length ? sub(toB(b.route[0]), toA(a.route[0])) : null;
      const translated = offset && a.route.every((p, i) => norm(sub(sub(toB(b.route[i]), toA(p)), offset)) <= opt.routeToleranceM);
      if (rerouted && !translated) moved = false;
      if (rerouted && !translated) modifications.push({ kind: 'route', label: 'Cable route changed', before: `${round(la, 1)} m, ${a.route?.length ?? 0} points`, after: `${round(lb, 1)} m, ${b.route?.length ?? 0} points`, lengthChangeM: round(lb - la, 2) });
    } else if (sa && sb && sa !== sb) {
      modifications.push({ kind: 'geometry', label: 'Geometry changed', before: { triangles: a.geometry.triangles, extent: a.geometry.localExtent }, after: { triangles: b.geometry.triangles, extent: b.geometry.localExtent } });
    } else if (Boolean(sa) !== Boolean(sb)) {
      modifications.push({ kind: 'geometry', label: sa ? 'Geometry removed' : 'Geometry added', before: sa ?? null, after: sb ?? null });
    }
    const [xa, xb] = [a.placement?.xAxis, b.placement?.xAxis];
    if (xa && xb) {
      const angle = Math.acos(Math.max(-1, Math.min(1, xa[0] * xb[0] + xa[1] * xb[1] + xa[2] * xb[2]))) * 180 / Math.PI;
      if (angle > opt.rotationToleranceDeg) modifications.push({ kind: 'rotation', label: 'Rotated', before: xa, after: xb, angleDeg: round(angle, 1) });
    }
    const all = propertyChanges(a, b, opt.numberTolerance);
    const statusProps = all.filter(isStatusChange);
    const props = all.filter(p => !isStatusChange(p));
    if (statusProps.length) statusUpdates.push({ globalId: b.globalId, networkId: b.networkId, name: b.name, ifcClass: b.ifcClass, changes: statusProps });
    if (props.length) modifications.push({ kind: 'properties', label: `${props.length} propert${props.length === 1 ? 'y' : 'ies'} changed`, changes: props });
    const [na, nb] = [A.ports.get(a.globalId) ?? 0, B.ports.get(b.globalId) ?? 0];
    if (na !== nb) modifications.push({ kind: 'ports', label: `Ports ${na} → ${nb}`, before: na, after: nb });
    if (!moved && !modifications.length && match.by === 'GLOBAL_ID') { unchanged += 1; continue; }
    changes.push({
      status: moved ? 'MOVED' : 'MODIFIED', moved, modified: modifications.length > 0,
      globalId: b.globalId, baseGlobalId: a.globalId, ifcClass: b.ifcClass, kind: kindOf(b), name: b.name, networkId: b.networkId, networkRole: b.networkRole,
      match, before: where(0, a), after: where(1, b), displacement, modifications,
    });
  }
  for (const b of onlyB.filter(e => !usedB.has(e))) {
    changes.push({ status: 'ADDED', globalId: b.globalId, ifcClass: b.ifcClass, kind: kindOf(b), name: b.name, networkId: b.networkId, networkRole: b.networkRole,
      after: where(1, b), ports: B.ports.get(b.globalId) ?? 0, possibleMatch: possible.get(b.globalId) ?? null });
  }
  for (const a of onlyA.filter(e => !usedA.has(e))) {
    changes.push({ status: 'REMOVED', globalId: a.globalId, ifcClass: a.ifcClass, kind: kindOf(a), name: a.name, networkId: a.networkId, networkRole: a.networkRole,
      before: where(0, a), ports: A.ports.get(a.globalId) ?? 0, possibleMatch: possible.get(a.globalId) ?? null });
  }

  // ---- model-wide changes: one property set added to / dropped from most elements ----
  const psetShift = c => {
    const mod = c.modifications?.find(m => m.kind === 'properties');
    if (!mod) return [];
    const byPset = new Map();
    for (const p of mod.changes) {
      if (p.group !== 'property') continue;
      const pset = p.key.split('.')[0];
      if (!byPset.has(pset)) byPset.set(pset, []);
      byPset.get(pset).push(p);
    }
    const out = [];
    for (const [pset, list] of byPset) {
      if (list.every(p => p.before === null)) out.push(`added:${pset}`);
      else if (list.every(p => p.after === null)) out.push(`removed:${pset}`);
    }
    return out;
  };
  const tally = new Map();
  for (const c of changes) if (c.status === 'MODIFIED' || c.status === 'MOVED') for (const k of psetShift(c)) tally.set(k, (tally.get(k) ?? 0) + 1);
  const bulk = [...tally].filter(([, n]) => n >= Math.max(10, 0.5 * pairs.length)).map(([k]) => k);
  const bulkGroups = bulk.map(k => {
    const [how, pset] = k.split(':');
    const keys = new Set();
    let count = 0;
    const members = changes.filter(c => psetShift(c).includes(k));
    // The value most elements got, per property: an element with another value keeps that change.
    const common = new Map();
    for (const c of members) for (const p of c.modifications.find(m => m.kind === 'properties').changes) {
      if (!p.key.startsWith(`${pset}.`)) continue;
      const v = JSON.stringify(how === 'added' ? p.after : p.before);
      if (!common.has(p.key)) common.set(p.key, new Map());
      common.get(p.key).set(v, (common.get(p.key).get(v) ?? 0) + 1);
    }
    const usual = new Map([...common].map(([key, values]) => {
      const [value, n] = [...values].sort((x, y) => y[1] - x[1])[0];
      return [key, n >= 0.5 * members.length ? value : null];
    }));
    for (const c of members) {
      count += 1;
      const mod = c.modifications.find(m => m.kind === 'properties');
      const mine = mod.changes.filter(p => p.group === 'property' && p.key.startsWith(`${pset}.`)
        && (usual.get(p.key) === null || JSON.stringify(how === 'added' ? p.after : p.before) === usual.get(p.key)));
      for (const p of mine) keys.add(p.key.slice(pset.length + 1));
      mod.changes = mod.changes.filter(p => !mine.includes(p));
      mod.label = `${mod.changes.length} propert${mod.changes.length === 1 ? 'y' : 'ies'} changed`;
      (c.modelWide ??= []).push(k);
    }
    return { kind: how === 'added' ? 'PSET_ADDED' : 'PSET_REMOVED', pset, elements: count, properties: [...keys].sort(),
      label: `Property set ${pset} ${how === 'added' ? 'added to' : 'removed from'} ${count} elements (${keys.size} properties)` };
  });
  for (const c of changes) {
    if (!c.modelWide) continue;
    c.modifications = c.modifications.filter(m => m.kind !== 'properties' || m.changes.length);
    c.modified = c.modifications.length > 0;
    c.onlyModelWide = !c.moved && !c.modified;
  }
  const listed = changes.filter(c => !c.onlyModelWide);

  // Changed elements connected to each other (a moved intake and its re-routed cable) point at each other.
  const changedIds = new Set(listed.map(c => c.globalId));
  const links = new Map();
  for (const c of [...(base.connections ?? []), ...(target.connections ?? [])]) {
    if (!changedIds.has(c.from) || !changedIds.has(c.to)) continue;
    for (const [x, y] of [[c.from, c.to], [c.to, c.from]]) { if (!links.has(x)) links.set(x, new Set()); links.get(x).add(y); }
  }
  const order = { ADDED: 0, MOVED: 1, MODIFIED: 2, REMOVED: 3 };
  for (const c of listed) c.relatedChanges = [...(links.get(c.globalId) ?? [])];
  listed.sort((x, y) => order[x.status] - order[y.status] || String(x.networkId ?? x.name).localeCompare(String(y.networkId ?? y.name)));

  const count = status => changes.filter(c => c.status === status).length;
  const onlyModelWide = changes.length - listed.length;
  return {
    compareVersion: COMPARE_VERSION,
    base: { versionNumber: base.versionNumber ?? null, versionId: base.versionId ?? null, elements: A.list.length },
    target: { versionNumber: target.versionNumber ?? null, versionId: target.versionId ?? null, elements: B.list.length },
    frame: frame.frame, tolerance: { moveM: opt.moveToleranceM, rotationDeg: opt.rotationToleranceDeg, routeM: opt.routeToleranceM },
    originShift, notes: frame.notes,
    summary: { added: count('ADDED'), removed: count('REMOVED'), moved: count('MOVED'), modified: count('MODIFIED'),
      movedAndModified: changes.filter(c => c.moved && c.modified).length, unchanged, total: changes.length, listed: listed.length, onlyModelWide,
      statusOnly: statusUpdates.filter(u => !changes.some(c => c.globalId === u.globalId)).length },
    statusUpdates,
    modelWide: bulkGroups,
    changes: listed, warnings,
  };
}
