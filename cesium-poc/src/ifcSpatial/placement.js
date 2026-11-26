/**
 * Where a converted IFC model sits on the globe: the model matrix (column-major 4×4, model metres →
 * Earth-fixed metres) for one of two placements.
 *
 *  - IFC_GEOREFERENCED: the file's own IfcMapConversion. The server projects the model origin and
 *    two points 100 m along +x and +y to longitude/latitude (server/ifcSpatial/georef.mjs); the
 *    axes are built from those points, so grid rotation, meridian convergence and scale are carried
 *    exactly. Only the vertical is set here (see `height`).
 *  - USER_CALIBRATED: longitude, latitude, heading and scale chosen by the user, for a file without
 *    georeferencing or to override it. Always labelled as such.
 *
 * Height: Cesium works in ellipsoidal heights, the IFC states its origin height against a vertical
 * datum (NAVD88 here) and no geoid model is loaded, so the model origin (IFC z = 0) is placed on
 * the terrain surface sampled under it, plus the user's elevation offset. This is reported as
 * terrain-relative, not as a datum transformation.
 *
 * Pure: no Cesium import, so it is unit-tested directly; the page wraps the arrays in Matrix4.
 */
const WGS84 = { a: 6378137, e2: 0.00669437999014 };
const DEG = Math.PI / 180;

export const PLACEMENT_MODE = Object.freeze({ GEOREFERENCED: 'IFC_GEOREFERENCED', CALIBRATED: 'USER_CALIBRATED' });

export function geodeticToEcef(lon, lat, height = 0) {
  const [l, p] = [lon * DEG, lat * DEG];
  const n = WGS84.a / Math.sqrt(1 - WGS84.e2 * Math.sin(p) ** 2);
  return [(n + height) * Math.cos(p) * Math.cos(l), (n + height) * Math.cos(p) * Math.sin(l), (n * (1 - WGS84.e2) + height) * Math.sin(p)];
}

/** East, north and up unit vectors at a point. */
export function enuBasis(lon, lat) {
  const [l, p] = [lon * DEG, lat * DEG];
  return {
    east: [-Math.sin(l), Math.cos(l), 0],
    north: [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)],
    up: [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)],
  };
}

const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scaleV = (a, s) => a.map(v => v * s);
const norm = a => Math.hypot(...a);
const unit = a => scaleV(a, 1 / (norm(a) || 1));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const columns = (x, y, z, t) => [...x, 0, ...y, 0, ...z, 0, ...t, 1];

/** The file's georeferencing, with the origin at `height` (ellipsoidal metres). */
export function georeferencedMatrix(georef, height) {
  const { origin, xAxis, yAxis, step } = georef;
  const c0 = geodeticToEcef(origin.lon, origin.lat, height);
  const cx = geodeticToEcef(xAxis.lon, xAxis.lat, height);
  const cy = geodeticToEcef(yAxis.lon, yAxis.lat, height);
  const { up } = enuBasis(origin.lon, origin.lat);
  const dx = sub(cx, c0), dy = sub(cy, c0);
  // Horizontal axes in the tangent plane at the origin (the 100 m chords dip by ~1 mm of curvature).
  const ex = unit(sub(dx, scaleV(up, dot(dx, up))));
  const ey = cross(up, ex);
  const sx = norm(dx) / step, sy = dot(dy, ey) / step;
  return columns(scaleV(ex, sx), scaleV(ey, sy), up, c0);
}

/** A user calibration: model +x along heading (clockwise from east), uniform scale. */
export function calibratedMatrix({ lon, lat, height, headingDeg = 0, scale = 1 }) {
  const { east, north, up } = enuBasis(lon, lat);
  const h = headingDeg * DEG;
  const ex = sub(scaleV(east, Math.cos(h)), scaleV(north, Math.sin(h)));
  const ey = [north[0] * Math.cos(h) + east[0] * Math.sin(h), north[1] * Math.cos(h) + east[1] * Math.sin(h), north[2] * Math.cos(h) + east[2] * Math.sin(h)];
  return columns(scaleV(ex, scale), scaleV(ey, scale), scaleV(up, scale), geodeticToEcef(lon, lat, height));
}

/** The placement the panel starts from: the file's own, or nothing to start from. */
export function defaultPlacement(georef) {
  if (georef?.mode !== PLACEMENT_MODE.GEOREFERENCED) return null;
  return { mode: PLACEMENT_MODE.GEOREFERENCED, lon: georef.origin.lon, lat: georef.origin.lat, heightOffset: 0, headingDeg: georef.headingDeg ?? 0, scale: georef.scale ?? 1 };
}

/**
 * A panel edit: changing only the elevation offset keeps the file's georeferencing; changing the
 * position, heading or scale makes the placement USER_CALIBRATED.
 */
export function classifyEdit(georef, edited) {
  const base = defaultPlacement(georef);
  if (!base) return { ...edited, mode: PLACEMENT_MODE.CALIBRATED };
  const same = Math.abs(edited.lon - base.lon) < 1e-9 && Math.abs(edited.lat - base.lat) < 1e-9
    && Math.abs(edited.headingDeg - base.headingDeg) < 1e-6 && Math.abs(edited.scale - base.scale) < 1e-9;
  return { ...edited, mode: same ? PLACEMENT_MODE.GEOREFERENCED : PLACEMENT_MODE.CALIBRATED };
}

/** The model matrix for a placement, with the terrain height under its origin. */
export function modelMatrixFor(placement, georef, terrainHeight = 0) {
  const height = terrainHeight + (placement.heightOffset ?? 0);
  if (placement.mode === PLACEMENT_MODE.GEOREFERENCED && georef?.mode === PLACEMENT_MODE.GEOREFERENCED) return georeferencedMatrix(georef, height);
  return calibratedMatrix({ ...placement, height });
}

/** Apply a column-major 4×4 to a point. */
export const transformPoint = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
