/**
 * Spatial search for Ask the Twin: "assets within 100 m of the main substation", "the nearest five assets
 * to TX-M1", "the closest cable to TX-M1", "transformers near USS-1", "assets between USS-1 and USS-2".
 *
 * Coordinates are the IFC model's own, in metres (the converter scales the file's length unit): every
 * distance is horizontal, in that local metric frame — never from longitude / latitude degrees. The
 * map shows results through the same model → map projection as everything else (modelToLonLat).
 *
 * Geometry, as the model has it:
 *   Point       equipment: the centre of its bounding box
 *   LineString  cables: their modelled route
 *   Polygon     facilities: the convex hull of their equipment's footprints (IfcRelAggregates members)
 *               equipment's own footprint (its bounding box) when asked "inside"
 * Positions in this model are illustrative (DataStatus): distances are approximate, model-based, and
 * shown to the metre at most.
 *
 * Categories come from the model (each asset's type, or its IFC class), with plural and synonym forms;
 * nothing is a fixed list of what can be asked about.
 */

// ---- geometry (metres, the model's x/y) ----

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export function pointSegment(p, a, b) {
  const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  return dist(p, [a[0] + ab[0] * t, a[1] + ab[1] * t]);
}
const segments = g => (g.type === 'LineString' ? g.coords : g.type === 'Polygon' ? [...g.ring, g.ring[0]] : [g.xy]).map((p, i, all) => (i ? [all[i - 1], p] : null)).filter(Boolean);
const vertices = g => (g.type === 'Point' ? [g.xy] : g.type === 'LineString' ? g.coords : g.ring);
export function insidePolygon(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** The shortest horizontal distance between two geometries (0 when one is inside a polygon of the other). */
export function geometryDistance(a, b) {
  if (a.type === 'Polygon' && vertices(b).some(p => insidePolygon(p, a.ring))) return 0;
  if (b.type === 'Polygon' && vertices(a).some(p => insidePolygon(p, b.ring))) return 0;
  let best = Infinity;
  const sa = segments(a), sb = segments(b);
  for (const p of vertices(a)) for (const [s, t] of sb.length ? sb : [[vertices(b)[0], vertices(b)[0]]]) best = Math.min(best, pointSegment(p, s, t));
  for (const p of vertices(b)) for (const [s, t] of sa.length ? sa : [[vertices(a)[0], vertices(a)[0]]]) best = Math.min(best, pointSegment(p, s, t));
  return best;
}
/** Convex hull (monotone chain) of points. */
export function convexHull(points) {
  const pts = [...new Map(points.map(p => [`${p[0]},${p[1]}`, p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = list => { const h = []; for (const p of list) { while (h.length >= 2 && cross(h.at(-2), h.at(-1), p) <= 0) h.pop(); h.push(p); } h.pop(); return h; };
  return [...half(pts), ...half([...pts].reverse())];
}
/** The outline of everything within `r` metres of a geometry (its outline grown by r; convex hull of rounded vertices). */
export function bufferOutline(g, r, steps = 24) {
  const ring = [];
  for (const [x, y] of vertices(g)) for (let i = 0; i < steps; i += 1) { const t = (i / steps) * Math.PI * 2; ring.push([x + r * Math.cos(t), y + r * Math.sin(t)]); }
  return convexHull(ring);
}
const centroid = g => { const v = vertices(g); return [v.reduce((s, p) => s + p[0], 0) / v.length, v.reduce((s, p) => s + p[1], 0) / v.length]; };

// ---- the index ----

const plural = w => (/(s|x|ch|sh)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`);
const SYNONYMS = { light: ['lights', 'lighting', 'lamps', 'masts', 'light fixtures'], breaker: ['breakers', 'circuit breakers', 'protective devices'], cable: ['cables', 'feeders', 'cable segments'],
  switchgear: ['switchgear', 'boards', 'buses', 'distribution boards'], 'ring main unit': ['rmus', 'ring main units'], supply: ['supplies', 'supply points', 'generators', 'sources'],
  controller: ['controllers', 'rtus', 'scada'], crane: ['cranes'], transformer: ['transformers'], switch: ['switches'], building: ['buildings'], vault: ['vaults'] };

/**
 * @param {object} p
 * @param {Array} p.elements converted IFC elements (bbox, route in model metres)
 * @param {(e) => {id: string, category: string}|null} p.describe an element's asset id and category (null: not searchable)
 * @param {Array} [p.facilities] facilities.js (members by GlobalId)
 * @param {Array} [p.areas] the application's named areas [{name, xy}] (map labels, not IFC)
 */
export function buildSpatialIndex({ elements = [], describe, facilities = [], areas = [], version = '' }) {
  const byGlobal = new Map(elements.map(e => [e.globalId, e]));
  const entries = [];
  const seen = new Set();
  for (const e of elements) {
    const d = describe(e);
    if (!d || seen.has(d.id) || !e.bbox) continue;
    seen.add(d.id);
    const box = e.bbox;
    const footprint = [[box.min[0], box.min[1]], [box.max[0], box.min[1]], [box.max[0], box.max[1]], [box.min[0], box.max[1]]];
    const geometry = e.route?.length >= 2 ? { type: 'LineString', coords: e.route.map(p => [p[0], p[1]]) } : { type: 'Point', xy: [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2] };
    entries.push({ id: d.id, globalId: e.globalId, name: e.name, category: d.category, geometry, footprint: { type: 'Polygon', ring: footprint }, facility: false,
      provenance: /illustrative|mock/i.test(e.properties?.SuperDNA_PowerNetwork?.DataStatus ?? '') ? 'ILLUSTRATIVE' : 'IFC_MODEL' });
  }
  const facilityEntries = facilities.map(f => {
    const pts = f.equipment.map(m => byGlobal.get(m.globalId)?.bbox).filter(Boolean).flatMap(b => [[b.min[0], b.min[1]], [b.max[0], b.min[1]], [b.max[0], b.max[1]], [b.min[0], b.max[1]]]);
    const ring = convexHull(pts);
    return ring.length >= 3 ? { id: f.id, name: f.name, category: f.substation ? 'Substation' : f.kind, kind: f.kind, geometry: { type: 'Polygon', ring }, facility: true, members: f.equipment.map(m => m.networkId ?? m.tag), provenance: 'IFC_ASSEMBLY' } : null;
  }).filter(Boolean);
  const areaEntries = areas.map(a => ({ id: a.name, name: a.name, category: 'Area', geometry: { type: 'Point', xy: a.xy }, area: true, provenance: 'APP_LABEL' }));
  // Categories, as the model names them, with their plural and synonym forms.
  const categories = [...new Set([...entries.map(x => x.category), ...facilityEntries.map(x => x.category)])];
  const vocabulary = new Map();
  for (const c of categories) {
    const lower = c.toLowerCase(), last = lower.split(/\s+/).at(-1);
    for (const form of [lower, plural(lower), last, plural(last), ...(SYNONYMS[last] ?? []), ...(SYNONYMS[lower] ?? [])]) {
      if (!vocabulary.has(form)) vocabulary.set(form, new Set());
      vocabulary.get(form).add(c);
    }
  }
  // A coarse grid for radius queries (cells of 100 m).
  const CELL = 100, grid = new Map();
  const cellsOf = g => { const v = vertices(g); const xs = v.map(p => Math.floor(p[0] / CELL)), ys = v.map(p => Math.floor(p[1] / CELL)); const out = [];
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 1) for (let y = Math.min(...ys); y <= Math.max(...ys); y += 1) out.push(`${x},${y}`); return out; };
  for (const x of entries) for (const k of cellsOf(x.geometry)) { if (!grid.has(k)) grid.set(k, new Set()); grid.get(k).add(x); }
  const near = (g, r) => {
    const v = vertices(g); const out = new Set();
    const [x0, x1] = [Math.floor((Math.min(...v.map(p => p[0])) - r) / CELL), Math.floor((Math.max(...v.map(p => p[0])) + r) / CELL)];
    const [y0, y1] = [Math.floor((Math.min(...v.map(p => p[1])) - r) / CELL), Math.floor((Math.max(...v.map(p => p[1])) + r) / CELL)];
    for (let x = x0; x <= x1; x += 1) for (let y = y0; y <= y1; y += 1) for (const e of grid.get(`${x},${y}`) ?? []) out.add(e);
    return [...out];
  };
  return { entries, facilities: facilityEntries, areas: areaEntries, categories, vocabulary, near, version, byId: new Map(entries.map(x => [x.id, x])) };
}

// ---- questions ----

const SPATIAL = /\b(near(by|est)?|around|close (to|by)|closest|within|inside|located in|in the vicinity|surrounding|between|distance|metres?|meters?|km|kilomet(er|re)s?)\b/i;
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** The categories a question asks about, from the model's vocabulary; 'ALL' for assets / equipment / everything. */
export function categoriesIn(q, index) {
  const lower = ` ${q.toLowerCase().replace(/[?.,!]/g, ' ')} `;
  const hits = new Set();
  for (const [form, cats] of [...index.vocabulary.entries()].sort((a, b) => b[0].length - a[0].length)) {
    if (new RegExp(`\\s${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`).test(lower)) for (const c of cats) hits.add(c);
  }
  if (!hits.size && /\b(assets?|equipment|everything|anything|things|items)\b/i.test(q)) return 'ALL';
  return hits.size ? [...hits] : null;
}

/**
 * Parse a spatial question. Returns null when it is not one.
 * { op: 'WITHIN' | 'NEAREST' | 'INSIDE' | 'BETWEEN', radius, defaultRadius, count, targets ('ALL' | categories | null),
 *   unknownCategory, references: [{type, id}], everyFacility, filters: {status, documents, suppliedBy} }
 */
export function parseSpatialQuestion(question, { index, assetIds, facilityIds = [], selectedId = null, defaultRadius = 100 }) {
  const q = String(question ?? '').replace(/\bsub[\s-]+(stations?)\b/gi, 'sub$1');
  if (!SPATIAL.test(q) && !/\bhow far\b/i.test(q)) return null;
  // "The connection / supply / path between A and B" is about the network, not about space.
  if (/\bbetween\b/i.test(q) && /\b(connect\w*|suppl\w*|path|route|cables? (that )?connect|feeds?|powered)\b/i.test(q) && !/\b(near|within|around|closest|nearest)\b/i.test(q)) return null;
  const lower = q.toLowerCase();
  const m = /(\d+(?:\.\d+)?)\s*(km|kilomet(?:er|re)s?|m\b|meters?|metres?)/i.exec(q);
  const radius = m ? Number(m[1]) * (/^k/i.test(m[2]) ? 1000 : 1) : null;
  const nearest = /\b(nearest|closest)\b/i.test(q);
  const n = /\b(nearest|closest)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.exec(q) ?? /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(nearest|closest)\b/i.exec(q);
  const count = n ? Number(NUMBER_WORDS[(n[2] ?? n[1]).toLowerCase()] ?? (/\d/.test(n[2]) ? n[2] : n[1])) : nearest ? 1 : null;
  // References: assets, facilities ("main substation", MSS, USS-1), areas (map labels), "the selected one", "every substation".
  const refs = [];
  const add = (type, id, at) => { if (!refs.some(r => r.id === id)) refs.push({ type, id, at }); };
  for (const id of assetIds) { const at = q.search(new RegExp(`(^|[^A-Za-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`)); if (at >= 0) add('ASSET', id, at); }
  for (const f of index.facilities) {
    const at = q.search(new RegExp(`(^|[^A-Za-z0-9-])${f.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9-])`, 'i'));
    if (at >= 0) { const i = refs.findIndex(r => r.id === f.id); if (i >= 0) refs.splice(i, 1); add('FACILITY', f.id, at); }
  }
  if (/\bmain substation\b/i.test(q)) for (const f of index.facilities.filter(x => /main/i.test(x.kind ?? ''))) add('FACILITY', f.id, lower.indexOf('main substation'));
  // An application area whose name overlaps a facility already found ("main substation") is the same place: once.
  for (const a of index.areas) {
    const at = lower.indexOf(a.name.toLowerCase());
    if (at < 0) continue;
    if (refs.some(r => r.type === 'FACILITY' && r.at >= at - 4 && r.at <= at + a.name.length)) continue;
    add('AREA', a.id, at);
  }
  const everyFacility = /\b(every|each|all( the)?)\s+substations?\b/i.test(q) && /\b(near|around|within|close)\b[^?]*\bsubstations?\b/i.test(q) && !refs.some(r => r.type === 'FACILITY');
  if (everyFacility) for (const f of index.facilities.filter(x => x.category === 'Substation')) add('FACILITY', f.id, Infinity);
  if (!refs.length && selectedId && /\b(selected|this|that|here|it)\b/i.test(q)) add('ASSET', selectedId, 0);
  refs.sort((a, b) => a.at - b.at);
  // What is searched for: the words before the spatial word (so "transformers near USS-1" is transformers).
  const head = q.split(SPATIAL)[0];
  let targets = categoriesIn(head, index) ?? categoriesIn(q.replace(new RegExp(refs.map(r => r.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '$^', 'gi'), ' ').replace(/\bmain substation\b/ig, ' '), index);
  if (everyFacility && Array.isArray(targets)) targets = targets.filter(c => c !== 'Substation');
  if (Array.isArray(targets) && !targets.length) targets = 'ALL';
  const unknownCategory = !targets ? /\b(?:show|find|which|what|list|are there any|how many)\s+(?:all\s+|the\s+|any\s+)?([a-z][\w-]*?)s?\s+(?:near|around|within|close|inside|closest|nearest|between)\b/i.exec(q)?.[1] ?? null : null;
  const op = (/\bdistance\b|\bhow far\b/i.test(q) && refs.length >= 2) ? 'DISTANCE'
    : /\bbetween\b/i.test(q) && refs.length >= 2 ? 'BETWEEN'
    : /\b(inside|located in|contained in|within the)\b/i.test(q) && !radius && refs.some(r => r.type === 'FACILITY') ? 'INSIDE'
      : nearest ? 'NEAREST' : 'WITHIN';
  const filters = {
    status: /\b(no power|without power|unpowered|offline|de-?energi[sz]ed)\b/i.test(q) ? 'NO_POWER' : /\b(reported faults?|faults?|faulted|degraded)\b/i.test(q) ? 'DEGRADED' : /\b(energi[sz]ed|powered|live)\b/i.test(q) && !/\bpowered by\b/i.test(q) ? 'POWERED' : null,
    documents: /\b(linked |with )?documents?\b/i.test(q) ? true : null,
    recentChanges: /\brecent(ly)? chang\w*\b|\bchanged\b/i.test(q) ? true : null,
    suppliedBy: (/\b(supplied|powered|fed)\s+by\s+(it|this|that|[\w-]+)/i.exec(q)?.[2]) ?? null,
  };
  if (filters.suppliedBy && /^(it|this|that)$/i.test(filters.suppliedBy)) filters.suppliedBy = refs[0]?.id ?? null;
  return { op, radius: radius ?? (op === 'WITHIN' ? defaultRadius : null), defaultRadius: !radius && op === 'WITHIN', count, targets: targets ?? (unknownCategory ? null : 'ALL'), unknownCategory, references: refs, everyFacility, filters, countOnly: /\bhow many\b/i.test(q) };
}

/** The geometry of a reference: an asset's own, a facility's footprint, an area's label point. */
export function referenceGeometry(index, ref) {
  if (ref.type === 'FACILITY') return index.facilities.find(f => f.id === ref.id)?.geometry ?? null;
  if (ref.type === 'AREA') return index.areas.find(a => a.id === ref.id)?.geometry ?? null;
  return index.byId.get(ref.id)?.geometry ?? null;
}

/**
 * Run a parsed spatial question. Results: [{ entry, distance, near: [reference ids] }], unique, nearest first.
 * A facility reference searches from its footprint (0 inside it); BETWEEN searches a corridor of `radius`
 * (default 50 m) either side of the straight line joining the two references.
 */
export function querySpatial(index, parsed, { matches = () => true } = {}) {
  const refs = parsed.references.map(r => ({ ...r, geometry: referenceGeometry(index, r) })).filter(r => r.geometry);
  if (!refs.length) return { results: [], refs: [], missingGeometry: parsed.references.map(r => r.id) };
  const pool = (parsed.targets === 'ALL' ? index.entries : [...index.entries, ...index.facilities].filter(x => parsed.targets.includes(x.category))).filter(matches);
  // The references themselves are not results; what a facility contains is (inside it: 0 m).
  const self = new Set(refs.map(r => r.id));
  const out = new Map();
  if (parsed.op === 'DISTANCE') {
    const [a, b] = refs;
    return { results: [], refs, corridor: null, distance: b ? geometryDistance(a.geometry, b.geometry) : null };
  }
  if (parsed.op === 'INSIDE') {
    const f = index.facilities.find(x => x.id === refs[0].id);
    for (const x of pool.filter(e => f.members.includes(e.id))) out.set(x.id, { entry: x, distance: 0, near: [f.id], by: 'IfcRelAggregates' });
    return { results: [...out.values()], refs, corridor: null };
  }
  if (parsed.op === 'BETWEEN') {
    const [a, b] = refs.slice(0, 2).map(r => centroid(r.geometry));
    const width = parsed.radius && !parsed.defaultRadius ? parsed.radius : 50;
    const line = { type: 'LineString', coords: [a, b] };
    for (const x of pool) {
      if (self.has(x.id)) continue;
      const c = centroid(x.geometry); const ab = sub(b, a); const t = dot(sub(c, a), ab) / (dot(ab, ab) || 1);
      const d = geometryDistance(x.geometry, line);
      if (t >= 0 && t <= 1 && d <= width) out.set(x.id, { entry: x, distance: d, near: refs.slice(0, 2).map(r => r.id) });
    }
    return { results: [...out.values()].sort((p, q) => p.distance - q.distance), refs, corridor: { line, width } };
  }
  for (const r of refs) {
    const candidates = parsed.op === 'NEAREST' ? pool : [...index.near(r.geometry, parsed.radius), ...index.facilities].filter(x => pool.includes(x));
    for (const x of candidates) {
      if (self.has(x.id)) continue;
      const d = geometryDistance(r.geometry, x.geometry);
      if (parsed.op === 'WITHIN' && d > parsed.radius) continue;
      const prev = out.get(x.id);
      if (!prev) out.set(x.id, { entry: x, distance: d, near: [r.id] });
      else { prev.near.push(r.id); prev.distance = Math.min(prev.distance, d); }
    }
  }
  let results = [...out.values()].sort((p, q) => p.distance - q.distance);
  if (parsed.op === 'NEAREST') results = results.slice(0, parsed.count ?? 1);
  return { results, refs, corridor: null };
}

/** "≈ 40 m": model positions are illustrative; never finer than the metre, coarser further out. */
export const approxMetres = d => (d < 1 ? '0 m (touching or inside)' : d < 1000 ? `≈ ${d < 100 ? Math.round(d) : Math.round(d / 5) * 5} m` : `≈ ${(d / 1000).toFixed(1)} km`);
