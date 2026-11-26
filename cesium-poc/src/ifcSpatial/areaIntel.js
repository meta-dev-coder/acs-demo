/**
 * Spatial electrical intelligence over a selected area (Ask the Twin, Select Area): what the area holds,
 * its power status, where its power comes from, what depends on it, and what an outage or construction
 * would touch. Pure: the caller passes the area membership (areaQuery.js, resolved by the server) and the
 * twin's existing engines as functions — the supply-path resolver (topology.js), the status engine
 * (operations.js), the simulation's result. Nothing here infers connectivity from position: the area only
 * says where an asset is; every electrical relationship comes from the network's own supply paths, which
 * run through the whole network, inside the area or not.
 */
import { isInArea, makeFrame, pointInRing } from './areaQuery.js';

const uniq = list => [...new Set(list)];

/** Assets inside the area (within, intersecting, crossing), in a stable order. */
export const insideIds = membership => uniq([...(membership?.within ?? []), ...(membership?.intersects ?? []), ...(membership?.crosses ?? [])]);

/**
 * Inventory by category: {total, categories: [{category, ids}]} largest first; `filter` keeps only the
 * categories asked for (null: all). Unknown categories are "Other".
 */
export function inventoryOf(ids, categoryOf, { filter = null } = {}) {
  const by = new Map();
  for (const id of uniq(ids)) {
    const c = categoryOf(id) ?? 'Other';
    if (filter && !filter.includes(c)) continue;
    by.set(c, [...(by.get(c) ?? []), id]);
  }
  const categories = [...by.entries()].map(([category, list]) => ({ category, ids: list })).sort((a, b) => b.ids.length - a.ids.length || a.category.localeCompare(b.category));
  return { total: categories.reduce((n, c) => n + c.ids.length, 0), categories };
}

/**
 * Power status in the area: each monitored asset counted once in its one status (degraded is a status of
 * its own, not also "powered"); assets the status engine does not monitor (cables) are left out of the
 * counts and said so.
 * @param {string[]} ids
 * @param {(id) => {status, monitored}|null} statusOf
 */
export function statusOfArea(ids, statusOf) {
  const counts = { POWERED: 0, NO_POWER: 0, DEGRADED: 0, OFFLINE: 0, UNKNOWN: 0 };
  const lists = { POWERED: [], NO_POWER: [], DEGRADED: [], OFFLINE: [], UNKNOWN: [] };
  let unmonitored = 0;
  for (const id of uniq(ids)) {
    const s = statusOf(id);
    if (!s || !s.monitored) { unmonitored += 1; continue; }
    const k = s.status in counts ? s.status : 'UNKNOWN';
    counts[k] += 1;
    lists[k].push(id);
  }
  const monitored = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts, lists, monitored, unmonitored, attention: [...lists.NO_POWER, ...lists.DEGRADED, ...lists.OFFLINE] };
}

/**
 * Where the area's power comes from: for each consumer in the area, its normal supply path (source first)
 * as the supply resolver gives it — through the whole network. Upstream equipment is deduplicated, with how
 * many of the area's consumers it supplies and whether it is itself in the area.
 * @param {object} o
 * @param {string[]} o.consumers the area's consumers (or its equipment when it has no consumers)
 * @param {(id) => {primary: {path: string[], inferred?: number}|null, alternatives?: object[], verification?: string}} o.supplyOf
 * @param {(id) => string} o.roleOf electrical role (SOURCE, TRANSFORMER, DISTRIBUTION, PROTECTION, SWITCH, JUNCTION, LOAD, CABLE…)
 * @param {Object<string, {relation}>} o.relations area membership relations
 * @param {string[]} [o.roles] the upstream roles asked about (default: sources, transformers, distribution)
 */
export function supplyOfArea({ consumers, supplyOf, roleOf, relations, roles = ['SOURCE', 'TRANSFORMER', 'DISTRIBUTION'] }) {
  const upstream = new Map();
  const unsupplied = [], unverified = [];
  const pathIds = new Set();
  for (const c of uniq(consumers)) {
    const sup = supplyOf(c);
    const path = sup?.primary?.path ?? [];
    if (!path.length) { unsupplied.push(c); continue; }
    if (sup.verification && sup.verification !== 'VERIFIED') unverified.push(c);
    for (const id of path) pathIds.add(id);
    for (const id of path) {
      if (id === c || !roles.includes(roleOf(id))) continue;
      if (!upstream.has(id)) upstream.set(id, { id, role: roleOf(id), inside: isInArea(relations?.[id]?.relation), relation: relations?.[id]?.relation ?? 'UNKNOWN_LOCATION', consumers: [] });
      upstream.get(id).consumers.push(c);
    }
  }
  const list = [...upstream.values()].sort((a, b) => roles.indexOf(a.role) - roles.indexOf(b.role) || b.consumers.length - a.consumers.length || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { upstream: list, inside: list.filter(u => u.inside), outside: list.filter(u => !u.inside), unsupplied, unverified, pathIds: [...pathIds] };
}

/**
 * Alternate supply coverage over the area's consumers: those with a modelled alternate route (and the
 * normally-open devices it needs closed), those without, and those with no supply path at all. Coverage
 * is per consumer: the area has backup only if every consumer does.
 */
export function alternateCoverage(consumers, supplyOf) {
  const covered = [], without = [], unknown = [];
  for (const c of uniq(consumers)) {
    const sup = supplyOf(c);
    if (!sup?.primary) { unknown.push(c); continue; }
    const alts = sup.alternatives ?? [];
    if (alts.length) covered.push({ id: c, needsClosing: uniq(alts.flatMap(a => a.needsClosing ?? [])) });
    else without.push(c);
  }
  const total = covered.length + without.length + unknown.length;
  return { covered, without, unknown, total, all: total > 0 && covered.length === total, none: covered.length === 0 };
}

/**
 * What outside the area depends on equipment inside it: every consumer outside whose normal supply path
 * passes through an asset in the area (the area's own consumers excluded).
 */
export function dependentsOutside({ consumers, supplyOf, relations }) {
  const out = [];
  for (const c of uniq(consumers)) {
    if (isInArea(relations?.[c]?.relation)) continue;
    const path = supplyOf(c)?.primary?.path ?? [];
    const via = path.filter(id => id !== c && isInArea(relations?.[id]?.relation));
    if (via.length) out.push({ id: c, via, unknownLocation: !relations?.[c] || relations[c].relation === 'UNKNOWN_LOCATION' });
  }
  return out;
}

/**
 * A simulated outage partitioned by the area: the affected consumers inside it, outside it, and with no
 * position in the model (never guessed into either). Consumers are counted once however many paths reach them.
 */
export function outageByArea(affected, relations) {
  const inside = [], outside = [], unknown = [];
  for (const id of uniq(affected)) {
    const r = relations?.[id]?.relation;
    if (!r || r === 'UNKNOWN_LOCATION') unknown.push(id);
    else if (isInArea(r)) inside.push(id);
    else outside.push(id);
  }
  return { total: inside.length + outside.length + unknown.length, inside, outside, unknown };
}

/**
 * Preliminary construction screening: assets in the boundary, assets partly in it, cable routes crossing it,
 * and (only with a distance given) assets within that buffer — kept apart, because a geometric intersection
 * with a modelled route is not the same as a proximity conflict.
 */
export function constructionScreen({ membership, kindOf, nearM = null }) {
  const within = membership.within ?? [], intersects = membership.intersects ?? [], crosses = membership.crosses ?? [];
  const cables = [...within, ...crosses].filter(id => kindOf(id) === 'CABLE');
  return {
    within: within.filter(id => kindOf(id) !== 'CABLE'), intersects,
    cablesCrossing: crosses.filter(id => kindOf(id) === 'CABLE'), cablesWithin: within.filter(id => kindOf(id) === 'CABLE'), cables,
    near: nearM ? (membership.near ?? []).filter(n => n.distanceM <= nearM) : [], nearM,
    unknown: membership.unknown ?? [],
  };
}

/**
 * IFC version changes in an area: the same boundary tested against each version's own position of every
 * changed element (the comparison's position: a cable's route midpoint, else the placement origin, else the box
 * centre), placed with the map's IFC → world transform. So an asset removed in the newer version is found by
 * where it was in the older one, and moving out of the area is told apart from being removed.
 * @param {object[]} changes the comparison's changes ({status, before?.model, after?.model, modifications, …})
 * @param {object} o
 * @param {[number, number][]} o.ring the area
 * @param {(x, y, z) => {lon, lat}} o.toLonLat
 * @param {(change) => boolean} [o.matches] a category filter
 */
export function changesInArea(changes, { ring, toLonLat, matches = () => true }) {
  const frame = makeFrame(ring);
  const area = ring.map(frame.toXY);
  const inside = p => { if (!Array.isArray(p?.model)) return null; const r = toLonLat(p.model[0], p.model[1], p.model[2] ?? 0); return Number.isFinite(r?.lon) ? pointInRing(frame.toXY([r.lon, r.lat]), area) : null; };
  const out = { added: [], removed: [], movedIn: [], movedOut: [], movedWithin: [], modified: [], connectivity: [], unplaced: [] };
  for (const c of changes ?? []) {
    if (!matches(c)) continue;
    const before = c.before ? inside(c.before) : null, after = c.after ? inside(c.after) : null;
    if (before === null && after === null) { out.unplaced.push(c); continue; }
    if (c.status === 'ADDED') { if (after) out.added.push(c); continue; }
    if (c.status === 'REMOVED') { if (before) out.removed.push(c); continue; }
    if (c.moved && before && after) out.movedWithin.push(c);
    else if (c.moved && !before && after) out.movedIn.push(c);
    else if (c.moved && before && !after) out.movedOut.push(c);
    if (c.modified && (before || after)) out.modified.push(c);
    if ((before || after) && (c.modifications ?? []).some(m => m.kind === 'ports')) out.connectivity.push(c);
  }
  out.total = new Set([...out.added, ...out.removed, ...out.movedIn, ...out.movedOut, ...out.movedWithin, ...out.modified].map(c => c.globalId)).size;
  return out;
}
