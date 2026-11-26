/**
 * Importing a real electrical inventory (Kimley-Horn's, when it arrives) into the Seagirt schema.
 *
 * THREE SEPARATE THINGS, kept separate: asset METADATA (what the equipment is), GEOMETRY (where it
 * is, if it has its own position) and TOPOLOGY (what connects to what). Each can be refreshed
 * without touching the others or the map code: the page reads the merged registry and connectivity
 * and draws whatever they contain.
 *
 * Sources: CSV (Excel exports included — save as CSV), GeoJSON (or a GIS feature service's GeoJSON
 * output) for positions, and connectivity rows (from, to, state). A field map translates incoming
 * column names onto the schema.
 *
 * The rule that matters most: a VERIFIED record is never overwritten by a synthetic or unverified
 * one. Merging reports what it kept, replaced and refused.
 */
import { validLonLat } from './geo.js';

export const PROVENANCE = Object.freeze(['VERIFIED_SURVEY', 'VERIFIED_DRAWING', 'IMPORTED_GIS', 'MANUALLY_ENTERED', 'SYNTHETIC_DEMO', 'UNKNOWN']);
export const VERIFIED = Object.freeze(new Set(['VERIFIED_SURVEY', 'VERIFIED_DRAWING']));
export const ASSET_TYPES = Object.freeze(['UTILITY_SUPPLY', 'SUBSTATION', 'TRANSFORMER', 'SWITCHGEAR', 'CIRCUIT_BREAKER', 'SWITCH', 'DISCONNECT',
  'DISTRIBUTION_PANEL', 'FEEDER', 'CABLE', 'CONDUIT', 'JUNCTION_BOX', 'CRANE', 'WAREHOUSE', 'BUILDING', 'LIGHTING_CIRCUIT', 'EV_CHARGING', 'OTHER_LOAD']);
export const REQUIRED = Object.freeze(['id', 'name', 'assetType']);

/** A default field map: incoming column → schema field. Extend per source. */
export const DEFAULT_FIELD_MAP = Object.freeze({
  id: 'id', asset_id: 'id', assetid: 'id', tag: 'id',
  name: 'name', description: 'name',
  type: 'assetType', asset_type: 'assetType', assettype: 'assetType',
  parent: 'parentAssetId', parent_id: 'parentAssetId', parentassetid: 'parentAssetId',
  longitude: 'longitude', lon: 'longitude', x: 'longitude', latitude: 'latitude', lat: 'latitude', y: 'latitude',
  building: 'buildingId', room: 'roomId', cabinet: 'cabinetId', panel: 'containerAssetId', container: 'containerAssetId', cubicle: 'cubicle',
  condition: 'condition', status: 'operationalStatus', last_inspection: 'lastInspectionDate', next_inspection: 'nextInspectionDate',
  provenance: 'dataProvenance', source: 'dataProvenance', verification: 'verificationStatus',
  rating: 'ratingValue', rating_unit: 'ratingUnit', primary_kv: 'primaryKv', secondary_kv: 'secondaryKv', normal_state: 'normalState',
});

/** RFC 4180-style CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v !== '')) rows.push(row);
  const [header = [], ...body] = rows;
  return body.map(r => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const num = v => (v === '' || v === null || v === undefined ? null : Number(v));

/** One incoming row → an asset record in the schema (unknown columns kept under `extra`). */
export function mapRow(row, { fieldMap = DEFAULT_FIELD_MAP, defaults = {} } = {}) {
  const out = {}, extra = {};
  for (const [k, v] of Object.entries(row)) {
    const field = fieldMap[k.toLowerCase().replace(/\s+/g, '_')];
    if (field) out[field] = v; else extra[k] = v;
  }
  const lon = num(out.longitude), lat = num(out.latitude);
  return {
    id: out.id, name: out.name ?? out.id, assetType: String(out.assetType ?? '').toUpperCase().replace(/\s+/g, '_'),
    projectId: 'seagirt', parentAssetId: out.parentAssetId || null,
    location: { longitude: Number.isFinite(lon) ? lon : null, latitude: Number.isFinite(lat) ? lat : null, buildingId: out.buildingId || null,
      roomId: out.roomId || null, cabinetId: out.cabinetId || null, containerAssetId: out.containerAssetId || null, cubicle: out.cubicle || null },
    rating: out.ratingValue ? { value: num(out.ratingValue), unit: out.ratingUnit || null } : null,
    voltage: out.primaryKv || out.secondaryKv ? { primary: out.primaryKv ? { value: num(out.primaryKv), unit: 'kV' } : null, secondary: out.secondaryKv ? { value: num(out.secondaryKv), unit: 'kV' } : null } : null,
    operationalStatus: out.operationalStatus || 'UNKNOWN', condition: (out.condition || 'UNKNOWN').toUpperCase(),
    lastInspectionDate: out.lastInspectionDate || null, nextInspectionDate: out.nextInspectionDate || null,
    ...(out.normalState ? { normalState: out.normalState.toUpperCase() } : {}),
    dataProvenance: (out.dataProvenance || defaults.dataProvenance || 'UNKNOWN').toUpperCase(),
    verificationStatus: (out.verificationStatus || defaults.verificationStatus || 'UNVERIFIED').toUpperCase(),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

/** GeoJSON points → position updates { id, longitude, latitude, dataProvenance } (geometry only). */
export function positionsFromGeoJson(collection, { idProperty = 'id', dataProvenance = 'IMPORTED_GIS' } = {}) {
  return (collection?.features ?? []).filter(f => f?.geometry?.type === 'Point').map(f => ({
    id: String(f.properties?.[idProperty] ?? f.id ?? ''), longitude: f.geometry.coordinates[0], latitude: f.geometry.coordinates[1],
    dataProvenance: f.properties?.dataProvenance ?? dataProvenance,
  }));
}

/** Connectivity rows { from, to, state?, normally_closed? } → edges. */
export function edgesFromRows(rows, { dataProvenance = 'UNKNOWN' } = {}) {
  return rows.map(r => {
    const from = r.from ?? r.fromAssetId ?? r.from_asset, to = r.to ?? r.toAssetId ?? r.to_asset;
    const state = String(r.state ?? r.operationalState ?? 'CLOSED').toUpperCase();
    return { id: r.id || `EDGE-${from}-${to}`, fromAssetId: from, toAssetId: to, connectionType: 'ELECTRICAL', nominalVoltage: num(r.voltage),
      normallyClosed: r.normally_closed === undefined ? state !== 'OPEN' : !/^(false|0|no)$/i.test(String(r.normally_closed)),
      operationalState: ['OPEN', 'CLOSED', 'UNKNOWN'].includes(state) ? state : 'UNKNOWN', dataProvenance: String(r.provenance ?? dataProvenance).toUpperCase() };
  });
}

/**
 * Problems with an inventory, each naming the record. Nothing is fixed silently.
 * @returns {{ errors: object[], warnings: object[] }}
 */
export function validateInventory({ assets = [], edges = [] }, { bounds = null } = {}) {
  const errors = [], warnings = [];
  const ids = new Map();
  for (const a of assets) {
    for (const f of REQUIRED) if (!a[f]) errors.push({ kind: 'MISSING_FIELD', assetId: a.id ?? null, field: f, message: `${a.id ?? 'A record'} has no ${f}.` });
    if (a.id && ids.has(a.id)) errors.push({ kind: 'DUPLICATE_ID', assetId: a.id, message: `${a.id} appears more than once.` });
    if (a.id) ids.set(a.id, a);
    if (a.assetType && !ASSET_TYPES.includes(a.assetType)) errors.push({ kind: 'UNKNOWN_TYPE', assetId: a.id, message: `${a.id}: unknown asset type "${a.assetType}".` });
    if (!PROVENANCE.includes(a.dataProvenance)) errors.push({ kind: 'UNKNOWN_PROVENANCE', assetId: a.id, message: `${a.id}: unknown provenance "${a.dataProvenance}".` });
    if (VERIFIED.has(a.dataProvenance) && a.verificationStatus !== 'VERIFIED') warnings.push({ kind: 'PROVENANCE_STATUS', assetId: a.id, message: `${a.id} claims ${a.dataProvenance} but is not marked VERIFIED.` });
    const { longitude: lon, latitude: lat } = a.location ?? {};
    if (lon !== null && lon !== undefined || lat !== null && lat !== undefined) {
      if (!validLonLat([lon, lat])) errors.push({ kind: 'INVALID_COORDINATE', assetId: a.id, message: `${a.id}: ${lon}, ${lat} is not a valid longitude/latitude.` });
      else if (bounds && (lon < bounds[0] || lat < bounds[1] || lon > bounds[2] || lat > bounds[3])) warnings.push({ kind: 'OUTSIDE_TERMINAL', assetId: a.id, message: `${a.id} lies outside the terminal area.` });
    }
  }
  for (const a of assets) {
    if (a.parentAssetId && !ids.has(a.parentAssetId)) errors.push({ kind: 'MISSING_PARENT', assetId: a.id, message: `${a.id}: parent ${a.parentAssetId} is not in the inventory.` });
    if (a.location?.containerAssetId && !ids.has(a.location.containerAssetId)) errors.push({ kind: 'MISSING_CONTAINER', assetId: a.id, message: `${a.id}: container ${a.location.containerAssetId} is not in the inventory.` });
  }
  const edgeIds = new Set();
  for (const e of edges) {
    for (const end of [e.fromAssetId, e.toAssetId]) if (!ids.has(end)) errors.push({ kind: 'MISSING_REFERENCE', edgeId: e.id, message: `Connection ${e.id}: ${end} is not in the inventory.` });
    if (edgeIds.has(e.id)) errors.push({ kind: 'DUPLICATE_EDGE', edgeId: e.id, message: `Connection ${e.id} appears more than once.` });
    edgeIds.add(e.id);
  }
  return { errors, warnings };
}

/**
 * Merge incoming records into the registry. A verified record is never replaced by an unverified
 * or synthetic one; incoming verified data replaces anything synthetic. Returns the result and a
 * report of every decision.
 */
export function mergeInventory(existing, incoming) {
  const byId = new Map(existing.map(a => [a.id, a]));
  const report = { added: [], replaced: [], refused: [] };
  for (const a of incoming) {
    const prior = byId.get(a.id);
    if (!prior) { byId.set(a.id, a); report.added.push(a.id); continue; }
    if (VERIFIED.has(prior.dataProvenance) && !VERIFIED.has(a.dataProvenance)) {
      report.refused.push({ id: a.id, reason: `${a.id} is ${prior.dataProvenance}; an ${a.dataProvenance} record does not overwrite it.` });
      continue;
    }
    byId.set(a.id, a);
    report.replaced.push(a.id);
  }
  return { assets: [...byId.values()], report };
}

/** Apply position-only updates (geometry) without touching metadata, under the same rule. */
export function applyPositions(assets, positions) {
  const byId = new Map(assets.map(a => [a.id, a]));
  const report = { moved: [], refused: [], unknown: [] };
  for (const p of positions) {
    const a = byId.get(p.id);
    if (!a) { report.unknown.push(p.id); continue; }
    if (!validLonLat([p.longitude, p.latitude])) { report.refused.push({ id: p.id, reason: 'invalid coordinate' }); continue; }
    if (VERIFIED.has(a.locationProvenance ?? a.dataProvenance) && !VERIFIED.has(p.dataProvenance)) { report.refused.push({ id: p.id, reason: 'verified position kept' }); continue; }
    byId.set(p.id, { ...a, location: { ...a.location, longitude: p.longitude, latitude: p.latitude }, locationProvenance: p.dataProvenance });
    report.moved.push(p.id);
  }
  return { assets: [...byId.values()], report };
}
