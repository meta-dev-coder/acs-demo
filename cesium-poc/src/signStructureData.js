/**
 * FDOT sign structures along I-595 — the data side, with no Cesium and no DOM.
 *
 * One registry drives every structure type. Adding CANTILEVER or VERTICAL_TRUSS later means adding
 * an entry here and dropping its GeoJSON in `public/data/structures/`: the loader, the layer
 * service, the quick rail, the Map Explorer row, the count badge and the details panel all read
 * from this list, so none of them needs editing.
 */

export const SIGN_STRUCTURE_ASSET_TYPE = 'STRUCTURE';

/**
 * @typedef {object} SignStructureType
 * @property {string} id            layer id, e.g. 'overlane'
 * @property {string} label         full name, used on the rail and in the explorer
 * @property {string} groupLabel    short name, used where space is tight
 * @property {string} structureType FDOT structure class carried on every record
 * @property {number|null} fdotSignType  FDOT `dsigntype`: 1 OVERLANE, 2 CANTILEVER,
 *   3 VERTICAL_TRUSS, or null where FDOT records no classification
 * @property {string} glyph        marker artwork for this shape, drawn on the 38x44 marker plate
 * @property {string} source        path under BASE_URL
 * @property {string} control       id of the checkbox that owns this layer's visibility
 * @property {boolean} enabled      whether the layer starts switched on
 */

/** Marker artwork, in the 38x44 plate's coordinates. Dark ink; the plate supplies the colour. */
const ink = paths => `<g fill="none" stroke="#0b1729" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</g>`;

/**
 * The structure types this corridor has data for.
 *
 * `fdotSignType` is FDOT's `dsigntype`, kept so a record traces back to the source query
 * (lightingtype 3, lstateroad 862). VERTICAL_TRUSS is absent because no file for it exists yet — a
 * registry entry without data would put an empty layer in the interface.
 *
 * Each type draws its own shape: a portal, a cantilevered arm, or — where FDOT records no
 * classification at all — a plain sign panel that claims neither.
 */
export const SIGN_STRUCTURE_TYPES = Object.freeze([
  Object.freeze({
    id: 'overlane',
    label: 'Overlane Structures',
    groupLabel: 'Overlane',
    structureType: 'OVERLANE',
    fdotSignType: 1,
    source: 'data/structures/i595_overlane_gantries.geojson',
    icon: 'overlane',
    accent: '#7cc4ff',
    // A portal: uprights both sides of the road, carrying a span.
    glyph: `${ink('<path d="M10 29V13h18v16"/><path d="M10 15.5h18"/>')}<rect x="13" y="17.5" width="12" height="7" rx="1" fill="#0b1729"/>`,
    control: 'overlane-all',
    enabled: false,
  }),
  Object.freeze({
    id: 'cantilever',
    label: 'Cantilever Structures',
    groupLabel: 'Cantilever',
    structureType: 'CANTILEVER',
    fdotSignType: 2,
    source: 'data/structures/i595_cantilever_structures.geojson',
    icon: 'cantilever',
    accent: '#b79bff',
    // One upright with an arm reaching out over the road — not a portal.
    glyph: `${ink('<path d="M11 29V13"/><path d="M8 29h6"/><path d="M11 15.5h17"/>')}<rect x="16" y="17.5" width="11" height="7" rx="1" fill="#0b1729"/>`,
    control: 'cantilever-all',
    enabled: false,
  }),
  Object.freeze({
    id: 'unclassified',
    label: 'Unclassified Structures',
    groupLabel: 'Unclassified',
    structureType: 'UNCLASSIFIED',
    // FDOT records no `dsigntype` for these, which is exactly what makes them unclassified.
    fdotSignType: null,
    source: 'data/structures/i595_unclassified_structures.geojson',
    icon: 'unclassified',
    accent: '#9bb0c6',
    // A sign panel on a post: the shape is not known, so the marker claims neither portal nor arm.
    glyph: `${ink('<path d="M19 29V21"/><path d="M15 29h8"/>')}<rect x="10" y="12" width="18" height="8.5" rx="1.5" fill="#0b1729"/>`,
    control: 'unclassified-all',
    enabled: false,
  }),
]);

export const signStructureType = id => SIGN_STRUCTURE_TYPES.find(type => type.id === id) ?? null;

const text = value => (value == null || String(value).trim() === '' ? null : String(value).trim());
const number = value => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * One GeoJSON feature to a record.
 *
 * `heading`, `height_m` and `model` are null throughout the current files — those fields are
 * reserved for the calibration pass that attaches GLB models — so each is optional here and a
 * missing value never reaches the map as NaN.
 * @returns {{record: object}|{error: {id: string|null, reason: string}}}
 */
export function signStructureFromFeature(feature, type) {
  const properties = feature?.properties ?? {};
  const id = text(properties.id);
  const coordinates = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
  if (!id) return { error: { id: null, reason: 'feature has no id' } };
  if (!Array.isArray(coordinates) || coordinates.length < 2) return { error: { id, reason: 'geometry is not a Point' } };
  const longitude = number(coordinates[0]), latitude = number(coordinates[1]);
  if (longitude == null || Math.abs(longitude) > 180) return { error: { id, reason: `longitude ${coordinates[0]} is out of range` } };
  if (latitude == null || Math.abs(latitude) > 90) return { error: { id, reason: `latitude ${coordinates[1]} is out of range` } };
  return {
    record: {
      id,
      typeId: type.id,
      structureType: text(properties.structure_type) ?? type.structureType,
      fdotObjectId: number(properties.fdot_objectid),
      hlid: text(properties.hlid),
      milepost: number(properties.milepost),
      roadwayId: text(properties.roadway_id),
      lightCount: number(properties.light_count),
      // Reserved for the model-calibration pass; null in every current record.
      heading: number(properties.heading),
      heightM: number(properties.height_m),
      verified: properties.verified === true,
      longitude, latitude,
    },
  };
}

/**
 * Every placeable record in a FeatureCollection, with what was left out and why.
 *
 * `featureCount` is a fact about the file, kept separate from `records.length` so a caller can tell
 * a complete layer from a short one — on the map they look identical.
 * @returns {{records: object[], skipped: {id: string|null, reason: string}[], featureCount: number}}
 */
export function readSignStructures(data, type) {
  const features = Array.isArray(data?.features) ? data.features : [];
  const records = [], skipped = [], seen = new Set();
  for (const feature of features) {
    const parsed = signStructureFromFeature(feature, type);
    if (parsed.error) { skipped.push(parsed.error); continue; }
    if (seen.has(parsed.record.id)) { skipped.push({ id: parsed.record.id, reason: 'duplicate id' }); continue; }
    seen.add(parsed.record.id);
    records.push(parsed.record);
  }
  return { records, skipped, featureCount: features.length };
}

/** Explorer row label: the structure and its milepost, e.g. "I595_GANTRY_001   MP 1". */
export function signStructureLabel(record) {
  return record.milepost == null ? record.id : `${record.id}   MP ${record.milepost}`;
}

/** What the record calls itself, e.g. "Overlane Structure" — from the registry where it is known. */
export function signStructureHeading(record) {
  const type = SIGN_STRUCTURE_TYPES.find(entry => entry.structureType === record.structureType || entry.id === record.typeId);
  return `${type?.groupLabel ?? record.structureType} Structure`;
}

/** Panel rows. A missing value shows an em dash rather than vanishing, so the row set is stable. */
export function signStructureDetails(record) {
  const show = value => (value == null || value === '' ? '—' : String(value));
  return [
    ['Structure', signStructureHeading(record)],
    ['ID', show(record.id)],
    ['FDOT Object ID', show(record.fdotObjectId)],
    ['HLID', show(record.hlid)],
    ['Milepost', show(record.milepost)],
    ['Roadway ID', show(record.roadwayId)],
    ['Light Count', show(record.lightCount)],
    ['Latitude', record.latitude.toFixed(6)],
    ['Longitude', record.longitude.toFixed(6)],
    ['Verification Status', record.verified ? 'Verified' : 'Unverified'],
  ];
}

export function signStructureTooltip(record) {
  return `${signStructureHeading(record)}\n${record.id}`
    + (record.milepost == null ? '' : ` · MP ${record.milepost}`);
}

const DEG = Math.PI / 180;
const eastOf = (from, to, lat) => (to.lon - from.lon) * 111320 * Math.cos(lat * DEG);
const northOf = (from, to) => (to.lat - from.lat) * 110540;

/**
 * Compass bearing of the corridor nearest a point, smoothed over a span of vertices — a single
 * segment's tangent on this centerline swings by tens of degrees.
 * @returns {number|null} null when there is no usable centerline
 */
export function corridorBearingAt(centerline, longitude, latitude, span = 3) {
  if (!Array.isArray(centerline) || centerline.length < 2) return null;
  const here = { lon: longitude, lat: latitude };
  let nearest = 0, best = Infinity;
  for (let index = 0; index < centerline.length; index++) {
    const east = eastOf(here, centerline[index], latitude), north = northOf(here, centerline[index]);
    const distance = east * east + north * north;
    if (distance < best) { best = distance; nearest = index; }
  }
  const from = centerline[Math.max(0, nearest - span)];
  const to = centerline[Math.min(centerline.length - 1, nearest + span)];
  const east = eastOf(from, to, latitude), north = northOf(from, to);
  if (east === 0 && north === 0) return null;
  return ((Math.atan2(east, north) / DEG) + 360) % 360;
}
