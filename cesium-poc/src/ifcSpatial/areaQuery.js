/**
 * Select Area for the Seagirt IFC Spatial Twin: which IFC elements a drawn area holds, in geographic
 * terms, and how Ask the Twin reads a question asked about it.
 *
 * Pure (no Cesium): the page and the server (server/ifcSpatial/api.mjs, POST /area) run the same code,
 * so the server resolves membership from its own elements rather than trusting ids from the page.
 *
 * Geometry. The area is a WGS84 polygon (EPSG:4326, [lon, lat]). Elements are placed with the same
 * IFC → world transform as the map (toLonLat: the model's placement), never compared in IFC metres
 * against degrees. The tests themselves run in a local metric frame (equirectangular about the area's
 * centre: well under a centimetre of error across a terminal), so "inside", "crosses" and distances
 * are in metres.
 *
 *   cable (IfcCableSegment with a modelled route)  LineString through its route points
 *   any other element with a bounding box          its footprint: the box's horizontal rectangle
 *   a facility (an IFC assembly, e.g. a substation)  the convex hull of its members' footprints
 *   no bounding box and no route                   UNKNOWN_LOCATION (reported, never dropped)
 *
 * Relations: WITHIN (all inside), INTERSECTS (a footprint partly inside), CROSSES (a route enters or
 * crosses the area, also with both ends outside), OUTSIDE, UNKNOWN_LOCATION.
 */

import { convexHull } from './spatialIndex.js';

export const AREA_RELATION = Object.freeze({ WITHIN: 'WITHIN', INTERSECTS: 'INTERSECTS', CROSSES: 'CROSSES', OUTSIDE: 'OUTSIDE', UNKNOWN_LOCATION: 'UNKNOWN_LOCATION' });
export const AREA_BASIS = Object.freeze({ ROUTE: 'MODELLED_ROUTE', FOOTPRINT: 'BOUNDING_BOX_FOOTPRINT', HULL: 'ASSEMBLY_HULL', NONE: 'NO_GEOMETRY' });
export const AREA_LIMITS = Object.freeze({ maxVertices: 200, minAreaM2: 20, maxSpanM: 25_000 });
/** Elements that are not assets: ports, the site, assemblies (the facilities stand for those). */
const NOT_ASSETS = new Set(['IfcDistributionPort', 'IfcSite', 'IfcElementAssembly', 'IfcBuilding', 'IfcBuildingStorey', 'IfcProject', 'IfcSpace']);
const INSIDE = new Set([AREA_RELATION.WITHIN, AREA_RELATION.INTERSECTS, AREA_RELATION.CROSSES]);
export const isInArea = relation => INSIDE.has(relation);

// ---- geometry in a local metric frame ----

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON = 111_320;

/** A local frame about a ring's centre: [lon, lat] ↔ [x, y] metres. */
export function makeFrame(ring) {
  const lon0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const kx = M_PER_DEG_LON * Math.cos((lat0 * Math.PI) / 180);
  return { lon0, lat0, toXY: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * M_PER_DEG_LAT], toLL: ([x, y]) => [lon0 + x / kx, lat0 + y / M_PER_DEG_LAT] };
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const onSegment = (p, a, b) => Math.min(a[0], b[0]) - 1e-9 <= p[0] && p[0] <= Math.max(a[0], b[0]) + 1e-9 && Math.min(a[1], b[1]) - 1e-9 <= p[1] && p[1] <= Math.max(a[1], b[1]) + 1e-9;
/** Whether segments ab and cd share a point (touching counts). */
export function segmentsIntersect(a, b, c, d) {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return (Math.abs(d1) < 1e-9 && onSegment(a, c, d)) || (Math.abs(d2) < 1e-9 && onSegment(b, c, d)) || (Math.abs(d3) < 1e-9 && onSegment(c, a, b)) || (Math.abs(d4) < 1e-9 && onSegment(d, a, b));
}
/** Point in polygon (even-odd); a point on the boundary counts as inside. */
export function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (Math.abs(cross(ring[j], ring[i], p)) < 1e-9 && onSegment(p, ring[j], ring[i])) return true;
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const edges = ring => ring.map((p, i) => [p, ring[(i + 1) % ring.length]]);
const lineEdges = coords => coords.slice(1).map((p, i) => [coords[i], p]);
const ringArea = ring => Math.abs(ring.reduce((s, p, i) => { const q = ring[(i + 1) % ring.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
const pointSegment = (p, a, b) => {
  const ab = [b[0] - a[0], b[1] - a[1]], len = ab[0] ** 2 + ab[1] ** 2;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / len)) : 0;
  return Math.hypot(p[0] - (a[0] + ab[0] * t), p[1] - (a[1] + ab[1] * t));
};
const crossesBoundary = (segs, area) => segs.some(([a, b]) => edges(area).some(([c, d]) => segmentsIntersect(a, b, c, d)));

/**
 * Validate a drawn area: a GeoJSON-like {type: 'Polygon', coordinates: [[[lon, lat], …]]}.
 * Returns {ok, ring (open, no repeated vertices), areaM2, spanM} or {ok: false, code, message}.
 */
export function validateAreaGeometry(geometry) {
  const bad = (code, message) => ({ ok: false, code, message });
  if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates?.[0])) return bad('NOT_A_POLYGON', 'The area must be a polygon.');
  const raw = geometry.coordinates[0];
  if (raw.length > AREA_LIMITS.maxVertices + 1) return bad('TOO_MANY_VERTICES', `An area can have at most ${AREA_LIMITS.maxVertices} corners.`);
  if (!raw.every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90)) return bad('INVALID_COORDINATES', 'The area has a corner without a valid longitude and latitude.');
  const ring = [];
  for (const p of raw) { const q = [Number(p[0]), Number(p[1])]; const last = ring.at(-1); if (!last || Math.abs(last[0] - q[0]) > 1e-10 || Math.abs(last[1] - q[1]) > 1e-10) ring.push(q); }
  if (ring.length > 1 && Math.abs(ring[0][0] - ring.at(-1)[0]) < 1e-10 && Math.abs(ring[0][1] - ring.at(-1)[1]) < 1e-10) ring.pop();
  if (ring.length < 3) return bad('TOO_FEW_POINTS', 'An area needs at least three distinct corners.');
  const frame = makeFrame(ring);
  const xy = ring.map(frame.toXY);
  const es = edges(xy);
  for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) {
    if (j === i + 1 || (i === 0 && j === es.length - 1)) continue; // neighbours share a corner
    if (segmentsIntersect(es[i][0], es[i][1], es[j][0], es[j][1])) return bad('SELF_INTERSECTING', 'The area’s edges cross each other. Draw it without crossing lines.');
  }
  const areaM2 = ringArea(xy);
  if (areaM2 < AREA_LIMITS.minAreaM2) return bad('TOO_SMALL', 'The area is too small (or its corners lie on one line).');
  const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
  const spanM = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (spanM > AREA_LIMITS.maxSpanM) return bad('TOO_LARGE', 'The area is larger than the terminal. Draw a smaller one.');
  return { ok: true, ring, areaM2, spanM };
}

/** Two corners of a drag ({lon, lat}) → the rectangle's ring (axis-aligned in longitude / latitude). */
export function rectangleRing(a, b) {
  const [w, e] = [Math.min(a.lon, b.lon), Math.max(a.lon, b.lon)], [s, n] = [Math.min(a.lat, b.lat), Math.max(a.lat, b.lat)];
  return [[w, s], [e, s], [e, n], [w, n]];
}
export const polygonOf = ring => ({ type: 'Polygon', coordinates: [[...ring, ring[0]].map(p => [p[0], p[1]])] });

/** The relation of one geometry (in the frame's metres) to the area (also in metres). */
export function classifyGeometry(g, area) {
  if (!g) return AREA_RELATION.UNKNOWN_LOCATION;
  if (g.type === 'Point') return pointInRing(g.xy, area) ? AREA_RELATION.WITHIN : AREA_RELATION.OUTSIDE;
  if (g.type === 'LineString') {
    const allIn = g.coords.every(p => pointInRing(p, area));
    const crosses = crossesBoundary(lineEdges(g.coords), area);
    if (allIn && !crosses) return AREA_RELATION.WITHIN;
    // A crossing (or a route that touches the boundary with a point inside) enters the area.
    if (crosses || g.coords.some(p => pointInRing(p, area))) return allIn ? AREA_RELATION.WITHIN : AREA_RELATION.CROSSES;
    return AREA_RELATION.OUTSIDE;
  }
  if (g.type === 'Polygon') {
    const allIn = g.ring.every(p => pointInRing(p, area));
    const crosses = crossesBoundary(edges(g.ring), area);
    if (allIn && !crosses) return AREA_RELATION.WITHIN;
    if (allIn) return AREA_RELATION.WITHIN; // on the boundary
    if (crosses || g.ring.some(p => pointInRing(p, area)) || area.some(p => pointInRing(p, g.ring))) return AREA_RELATION.INTERSECTS;
    return AREA_RELATION.OUTSIDE;
  }
  return AREA_RELATION.UNKNOWN_LOCATION;
}

/** Shortest horizontal distance (m) from a geometry to the area; 0 when it touches or is inside. */
export function distanceToArea(g, area) {
  if (!g) return null;
  if (classifyGeometry(g, area) !== AREA_RELATION.OUTSIDE) return 0;
  const pts = g.type === 'Point' ? [g.xy] : g.type === 'LineString' ? g.coords : g.ring;
  const segs = g.type === 'Point' ? [] : g.type === 'LineString' ? lineEdges(g.coords) : edges(g.ring);
  let best = Infinity;
  for (const p of pts) for (const [a, b] of edges(area)) best = Math.min(best, pointSegment(p, a, b));
  for (const p of area) for (const [a, b] of segs) best = Math.min(best, pointSegment(p, a, b));
  return best;
}

// ---- elements ----

/** The asset id an element answers to (its NetworkID, else its Tag), or null for what is not an asset. */
export const areaIdOf = e => (NOT_ASSETS.has(e?.ifcClass) ? null : e?.networkId ?? e?.tag ?? null);

/**
 * An element's geometry in longitude / latitude, from its route or its bounding box, through the map's
 * IFC → world transform: {geometry: {type, coords|ring|xy as [lon, lat]}, basis} or null.
 */
export function elementGeometry(e, toLonLat) {
  const ll = p => { const r = toLonLat(p[0], p[1], p[2] ?? 0); return Number.isFinite(r?.lon) && Number.isFinite(r?.lat) ? [r.lon, r.lat] : null; };
  if (Array.isArray(e?.route) && e.route.length >= 2) {
    const coords = e.route.map(ll);
    if (coords.every(Boolean)) return { geometry: { type: 'LineString', coords }, basis: AREA_BASIS.ROUTE };
  }
  const box = e?.bbox;
  if (box?.min && box?.max && [...box.min.slice(0, 2), ...box.max.slice(0, 2)].every(Number.isFinite)) {
    const z = box.min[2] ?? 0;
    const ring = [[box.min[0], box.min[1], z], [box.max[0], box.min[1], z], [box.max[0], box.max[1], z], [box.min[0], box.max[1], z]].map(ll);
    if (ring.every(Boolean)) return { geometry: { type: 'Polygon', ring }, basis: AREA_BASIS.FOOTPRINT };
  }
  return null;
}
const toFrame = (g, frame) => (g.type === 'LineString' ? { type: 'LineString', coords: g.coords.map(frame.toXY) } : g.type === 'Polygon' ? { type: 'Polygon', ring: g.ring.map(frame.toXY) } : { type: 'Point', xy: frame.toXY(g.coords ?? g.xy) });

/**
 * Which elements (and facilities) the area holds.
 * @param {object} o
 * @param {object[]} o.elements IFC elements (elements.json)
 * @param {[number, number][]} o.ring the validated area ring ([lon, lat])
 * @param {(x, y, z) => {lon, lat}} o.toLonLat the model's IFC → world transform
 * @param {{id: string, ring: [number, number][]}[]} [o.facilities] facility outlines in [lon, lat]
 * @param {number} [o.nearM] also list what lies outside within this distance (m)
 * @returns {{relations: Object<string, {relation, basis, kind, distanceM?}>, within: string[], intersects: string[], crosses: string[], unknown: string[], near: {id, distanceM}[], outside: number}}
 */
export function resolveAreaMembership({ elements = [], ring, toLonLat, facilities = [], nearM = null, idOf = areaIdOf }) {
  const frame = makeFrame(ring);
  const area = ring.map(frame.toXY);
  const relations = {};
  const out = { within: [], intersects: [], crosses: [], unknown: [], near: [], outside: 0 };
  const add = (id, relation, basis, kind, g) => {
    relations[id] = { relation, basis, kind };
    if (relation === AREA_RELATION.WITHIN) out.within.push(id);
    else if (relation === AREA_RELATION.INTERSECTS) out.intersects.push(id);
    else if (relation === AREA_RELATION.CROSSES) out.crosses.push(id);
    else if (relation === AREA_RELATION.UNKNOWN_LOCATION) out.unknown.push(id);
    else {
      out.outside += 1;
      if (nearM > 0 && g) { const d = distanceToArea(g, area); if (d !== null && d <= nearM) { relations[id].distanceM = d; out.near.push({ id, distanceM: d }); } }
    }
  };
  const seen = new Set();
  for (const e of elements) {
    const id = idOf(e);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const geo = elementGeometry(e, toLonLat);
    if (!geo) { add(id, AREA_RELATION.UNKNOWN_LOCATION, AREA_BASIS.NONE, 'element', null); continue; }
    const g = toFrame(geo.geometry, frame);
    add(id, classifyGeometry(g, area), geo.basis, 'element', g);
  }
  for (const f of facilities) {
    if (!f?.id || seen.has(f.id) || !(f.ring?.length >= 3)) continue;
    seen.add(f.id);
    const g = { type: 'Polygon', ring: f.ring.map(frame.toXY) };
    add(f.id, classifyGeometry(g, area), AREA_BASIS.HULL, 'facility', g);
  }
  out.near.sort((a, b) => a.distanceM - b.distanceM);
  return { relations, ...out };
}

/**
 * Facilities (IFC assemblies, e.g. a substation): their id (Tag, else name) and outline in [lon, lat],
 * the convex hull of their members' footprints, as the spatial search draws them.
 */
export function facilityOutlines(elements = [], toLonLat) {
  const byGlobal = new Map(elements.map(e => [e.globalId, e]));
  const members = new Map();
  for (const e of elements) {
    const whole = e.aggregatedBy ? byGlobal.get(e.aggregatedBy) : null;
    if (whole?.ifcClass !== 'IfcElementAssembly' || !e.bbox) continue;
    if (!members.has(whole.globalId)) members.set(whole.globalId, []);
    members.get(whole.globalId).push(e.bbox);
  }
  const out = [];
  for (const [globalId, boxes] of members) {
    const whole = byGlobal.get(globalId);
    const hull = convexHull(boxes.flatMap(b => [[b.min[0], b.min[1]], [b.max[0], b.min[1]], [b.max[0], b.max[1]], [b.min[0], b.max[1]]]));
    if (hull.length < 3) continue;
    const ring = hull.map(([x, y]) => { const r = toLonLat(x, y, 0); return [r.lon, r.lat]; });
    if (ring.every(p => Number.isFinite(p[0]) && Number.isFinite(p[1]))) out.push({ id: whole.tag || whole.name, ring });
  }
  return out;
}

/** Ids split by where they are: inside (within / intersecting / crossing), outside, unknown location. */
export function partitionByArea(ids, relations) {
  const out = { inside: [], outside: [], unknown: [] };
  for (const id of new Set(ids)) {
    const r = relations?.[id]?.relation;
    if (!r || r === AREA_RELATION.UNKNOWN_LOCATION) out.unknown.push(id);
    else if (isInArea(r)) out.inside.push(id);
    else out.outside.push(id);
  }
  return out;
}

/**
 * The name of the area, only when it is reliable: exactly one of the map's named zones has its label
 * point inside the area. Otherwise null ("Custom selected area"): no zone name is guessed.
 */
export function namedZoneOf(ring, zones = []) {
  const frame = makeFrame(ring);
  const area = ring.map(frame.toXY);
  const hits = zones.filter(z => Number.isFinite(z.lon) && Number.isFinite(z.lat) && pointInRing(frame.toXY([z.lon, z.lat]), area));
  return hits.length === 1 ? hits[0].name : null;
}

/** A stable id for an area on one model version (FNV-1a over the rounded ring and the version key). */
export function selectionIdOf(ring, versionKey = '') {
  const text = `${versionKey}|${ring.map(p => `${p[0].toFixed(7)},${p[1].toFixed(7)}`).join(';')}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `area-${h.toString(16).padStart(8, '0')}`;
}

// ---- questions ----

const AREA_WORDS = '(?:area|zone|selection|boundary|region|polygon|rectangle)';
const EXPLICIT_AREA = new RegExp(`\\b(?:in|within|inside|across|for|of|from|at)\\s+(?:the\\s+)?(?:this|that|selected|the selected|my)\\s+${AREA_WORDS}\\b|\\b(?:this|that|the selected|selected)\\s+${AREA_WORDS}\\b|\\bthese assets\\b|\\bhere\\b`, 'i');
const TERMINAL = /\b(?:across|throughout|in|for|of|over)\s+(?:all\s+of\s+)?(?:the\s+)?(?:whole\s+|entire\s+)?(?:seagirt|terminal|site|port)(?:\s+(?:terminal|marine terminal))?\b|\b(?:entire|whole|full)\s+(?:terminal|site|port|network|model)\b|\ball of seagirt\b|\beverywhere\b|\bterminal[- ]wide\b|\bsite[- ]wide\b/i;
const OUTSIDE = new RegExp(`\\boutside\\s+(?:of\\s+)?(?:the\\s+)?(?:this|that|selected|the selected)?\\s*${AREA_WORDS}\\b`, 'i');
const NEAR = new RegExp(`\\b(?:near|around|close to|nearby|surrounding|within\\s+[\\d.]+\\s*(?:m|metres?|meters?|km|kilomet(?:er|re)s?)\\s+of|buffer(?:ed)?)\\b[^?]*?\\b(?:this|that|the selected|selected)\\s+${AREA_WORDS}\\b|\\bnear(?:by)?\\s+(?:the\\s+)?proposed\\b`, 'i');
const DISTANCE = /(\d+(?:\.\d+)?)\s*(km|kilomet(?:er|re)s?|m|metres?|meters?)\b/i;

/**
 * The scope a question asks about while an area is selected:
 *   AREA (default), TERMINAL ("across Seagirt", "the entire terminal"), OUTSIDE ("outside this area"),
 *   NEAR ("within 50 m of this area"; distanceM null when no distance is given: ask, never assume one).
 */
export function areaScopeOf(question) {
  const q = String(question ?? '');
  const explicit = EXPLICIT_AREA.test(q);
  if (OUTSIDE.test(q) && !/\b(?:supply|supplies|supplied|feed|feeds|fed|depend\w*)\b/i.test(q)) return { scope: 'OUTSIDE', explicit: true, distanceM: null };
  if (NEAR.test(q)) {
    const d = DISTANCE.exec(q);
    const distanceM = d ? Number(d[1]) * (/^k/i.test(d[2]) ? 1000 : 1) : null;
    return { scope: 'NEAR', explicit: true, distanceM: distanceM > 0 ? distanceM : null };
  }
  if (TERMINAL.test(q) && !explicit) return { scope: 'TERMINAL', explicit: true, distanceM: null };
  return { scope: 'AREA', explicit, distanceM: null };
}

/** Whether the question is about a selected area at all (used when none is selected). */
export const mentionsArea = question => EXPLICIT_AREA.test(String(question ?? '')) || OUTSIDE.test(String(question ?? '')) || NEAR.test(String(question ?? ''));

/**
 * What an area question asks for, so the screen can answer it from the right engine:
 *   SUPPLY      where its power comes from / which transformers or substations supply it / supplied by X
 *   DOWNSTREAM  what outside depends on equipment inside it
 *   ALTERNATE   backup / alternate supply for what is in it
 *   OUTAGE      "what happens if X fails / shuts down" (the simulation, partitioned by the area)
 *   CONSTRUCTION excavation / construction / cables crossing it
 *   STATUS      degraded / no power / alerts / operational / issues
 *   INSPECTION  inspections, findings, defects, missing documents or specifications
 *   VERSIONS    what changed between versions in it
 *   INVENTORY   how many / show / which assets or categories (the default)
 */
export function areaIntentOf(question) {
  const q = String(question ?? '');
  if (/\b(?:v\d+|versions?|changed|changes|added|removed|moved|deleted)\b/i.test(q) && /\b(?:v\d+|versions?|ifc|between|since|changed|added|removed|moved)\b/i.test(q) && !/\bsupply|power from\b/i.test(q)) return 'VERSIONS';
  if (/\b(?:what happens if|what would happen if|if\s+\S+\s+(?:fails?|shuts? down|trips?|is (?:taken )?out of service|goes down)|(?:fails?|shuts? down|out of service|outage|lose power|loses power|lost power if|taking .+ out of service|maintenance on)\b)/i.test(q) && /\b(?:if|would|when|maintenance|taking|outage)\b/i.test(q) && !/\b(?:has|have|are|is)\s+no power\b/i.test(q)) return 'OUTAGE';
  if (/\b(?:alternate|alternative|backup|back-up|redundan\w*|second(?:ary)? supply|standby supply)\b/i.test(q)) return 'ALTERNATE';
  if (/\b(?:construction|excavat\w*|dig(?:ging)?|trench\w*|civil works?|planning works?|before .*works?)\b/i.test(q) || (/\bcables?\b/i.test(q) && /\b(?:cross(?:es|ing)?|run through|pass(?:es)? through)\b/i.test(q))) return 'CONSTRUCTION';
  if (/\b(?:outside|elsewhere|beyond)\b/i.test(q) && /\b(?:depend\w*|supplied by|fed by|feeds?|downstream|affect\w*|impact\w*)\b/i.test(q)) return 'DOWNSTREAM';
  if (/\b(?:where does .* (?:power|supply|electricity)|get(?:s)? (?:its|their) (?:power|supply)|power(?:ed)? from|supply(?:ing)?|supplied|supplies|feeds?|fed (?:by|from)|upstream|source of (?:power|supply))\b/i.test(q)) return 'SUPPLY';
  if (/\b(?:inspect\w*|findings?|defects?|recurring|deteriorat\w*|condition|maintenance (?:history|records?|requirements?)|documents?|datasheets?|specifications?|specs?|records?)\b/i.test(q)) return 'INSPECTION';
  if (/\b(?:degraded|no power|without power|unpowered|de-?energi[sz]ed|offline|alerts?|alarms?|issues?|problems?|faults?|status|operational|working|healthy|attention|powered)\b/i.test(q)) return 'STATUS';
  return 'INVENTORY';
}

/** A distance phrase in a question, in metres (null when none). */
export function distanceIn(question) {
  const d = DISTANCE.exec(String(question ?? ''));
  return d ? Number(d[1]) * (/^k/i.test(d[2]) ? 1000 : 1) : null;
}
