/**
 * IFC georeferencing, read from the STEP text itself and applied without guessing.
 *
 * IFC4 georeferences a model with IfcMapConversion (a 2D Helmert transform from the model's
 * engineering x/y to a projected CRS's easting/northing, plus a height) and IfcProjectedCRS (which
 * CRS). IfcSite RefLatitude / RefLongitude / RefElevation are a coarser, independent statement of
 * where the site is, used here only as a cross-check.
 *
 * Only CRSs whose projection is implemented below are converted; any other is reported as
 * unsupported, and the model then needs a user calibration. Nothing here falls back to a bounding
 * box centre or to any other made-up location.
 */

const GRS80 = { a: 6378137, f: 1 / 298.257222101 };
const DEG = Math.PI / 180;

/**
 * Projected CRSs this module can invert. EPSG:26985 is NAD83 / Maryland (metres): Lambert Conformal
 * Conic, two standard parallels, on GRS80 (EPSG registry parameters).
 */
export const SUPPORTED_CRS = Object.freeze({
  'EPSG:26985': Object.freeze({ name: 'NAD83 / Maryland', method: 'LCC_2SP', ellipsoid: GRS80,
    lat1: 39.45, lat2: 38.3, lat0: 37 + 40 / 60, lon0: -77, falseEasting: 400000, falseNorthing: 0, unit: 1 }),
});

// ---- a minimal STEP reader: enough for the georeferencing entities ----

/** Split one entity's argument list, respecting quotes and nested parentheses. */
export function stepArgs(text) {
  const out = [];
  let depth = 0, quote = false, current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === "'" && text[i + 1] === "'") { current += "'"; i += 1; } else if (ch === "'") quote = false;
      continue;
    }
    if (ch === "'") { quote = true; current += ch; continue; }
    if (ch === '(') { depth += 1; if (depth === 1) continue; }
    if (ch === ')') { depth -= 1; if (depth === 0) { out.push(current.trim()); break; } }
    if (ch === ',' && depth === 1) { out.push(current.trim()); current = ''; continue; }
    if (depth >= 1) current += ch;
  }
  return out;
}

const stepString = value => (value && value.startsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : null);
const stepNumber = value => (value && value !== '$' && value !== '*' ? Number(value) : null);
/** IfcCompoundPlaneAngleMeasure: (degrees, minutes, seconds, millionths of a second), all of one sign. */
export const compoundAngle = value => {
  const parts = (value ?? '').replace(/[()]/g, '').split(',').map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  const [d, m, s, us = 0] = parts;
  return d + m / 60 + (s + us / 1e6) / 3600;
};

function entities(text, type) {
  const re = new RegExp(`^#(\\d+)\\s*=\\s*${type}\\s*(\\(.*\\));\\s*$`, 'gim');
  const found = [];
  for (const match of text.matchAll(re)) found.push({ id: `#${match[1]}`, args: stepArgs(match[2]) });
  return found;
}

/** Everything the file says about where it is. */
export function readGeoreference(stepText) {
  const text = String(stepText);
  const crs = entities(text, 'IFCPROJECTEDCRS')[0];
  const conversion = entities(text, 'IFCMAPCONVERSION')[0];
  const site = entities(text, 'IFCSITE')[0];
  const lengthUnit = entities(text, 'IFCSIUNIT').find(unit => unit.args[1] === '.LENGTHUNIT.');
  const context = entities(text, 'IFCGEOMETRICREPRESENTATIONCONTEXT')[0];
  const result = {
    schema: /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(text)?.[1] ?? null,
    lengthUnit: lengthUnit ? `${lengthUnit.args[2] !== '$' ? lengthUnit.args[2].replace(/\./g, '') : ''}${lengthUnit.args[3].replace(/\./g, '')}` : null,
    trueNorth: context?.args[5] && context.args[5] !== '$' ? context.args[5] : null,
    projectedCrs: crs ? { name: stepString(crs.args[0]), description: stepString(crs.args[1]), geodeticDatum: stepString(crs.args[2]),
      verticalDatum: stepString(crs.args[3]) } : null,
    mapConversion: conversion ? { eastings: stepNumber(conversion.args[2]), northings: stepNumber(conversion.args[3]),
      orthogonalHeight: stepNumber(conversion.args[4]), xAxisAbscissa: stepNumber(conversion.args[5]) ?? 1,
      xAxisOrdinate: stepNumber(conversion.args[6]) ?? 0, scale: stepNumber(conversion.args[7]) ?? 1 } : null,
    site: site ? { globalId: stepString(site.args[0]), name: stepString(site.args[2]), refLatitude: compoundAngle(site.args[9]),
      refLongitude: compoundAngle(site.args[10]), refElevation: stepNumber(site.args[11]) } : null,
  };
  result.supported = Boolean(result.mapConversion && result.projectedCrs && SUPPORTED_CRS[result.projectedCrs.name]);
  return result;
}

// ---- Lambert Conformal Conic (2SP), EPSG Guidance Note 7-2 §3.1.1 ----

function lccConstants(p) {
  const e = Math.sqrt(p.ellipsoid.f * (2 - p.ellipsoid.f));
  const m = phi => Math.cos(phi) / Math.sqrt(1 - e * e * Math.sin(phi) ** 2);
  const t = phi => Math.tan(Math.PI / 4 - phi / 2) / ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2);
  const [phi1, phi2, phi0] = [p.lat1 * DEG, p.lat2 * DEG, p.lat0 * DEG];
  const n = (Math.log(m(phi1)) - Math.log(m(phi2))) / (Math.log(t(phi1)) - Math.log(t(phi2)));
  const F = m(phi1) / (n * t(phi1) ** n);
  const r0 = p.ellipsoid.a * F * t(phi0) ** n;
  return { e, n, F, r0, t };
}

export function lccForward(p, lon, lat) {
  const { n, F, r0, t } = lccConstants(p);
  const r = p.ellipsoid.a * F * t(lat * DEG) ** n;
  const theta = n * (lon - p.lon0) * DEG;
  return { easting: p.falseEasting + r * Math.sin(theta), northing: p.falseNorthing + r0 - r * Math.cos(theta) };
}

export function lccInverse(p, easting, northing) {
  const { e, n, F, r0 } = lccConstants(p);
  const dE = easting - p.falseEasting, dN = r0 - (northing - p.falseNorthing);
  const r = Math.sign(n) * Math.sqrt(dE * dE + dN * dN);
  const tPrime = (r / (p.ellipsoid.a * F)) ** (1 / n);
  const theta = Math.atan2(dE, dN);
  let phi = Math.PI / 2 - 2 * Math.atan(tPrime);
  for (let i = 0; i < 12; i += 1) {
    const next = Math.PI / 2 - 2 * Math.atan(tPrime * ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2));
    if (Math.abs(next - phi) < 1e-14) { phi = next; break; }
    phi = next;
  }
  return { lon: theta / n / DEG + p.lon0, lat: phi / DEG };
}

/** Model engineering coordinates (metres) → projected grid, through IfcMapConversion. */
export function modelToGrid(mapConversion, x, y) {
  const { eastings, northings, xAxisAbscissa: a0, xAxisOrdinate: b0, scale } = mapConversion;
  const length = Math.hypot(a0, b0) || 1;
  const [a, b] = [a0 / length, b0 / length];
  return { easting: eastings + scale * (a * x - b * y), northing: northings + scale * (b * x + a * y) };
}

/** Model coordinates → longitude, latitude (degrees, on the CRS's datum) and orthometric height. */
export function modelToGeographic(georef, x, y, z = 0) {
  const crs = SUPPORTED_CRS[georef.projectedCrs?.name];
  if (!crs || !georef.mapConversion) return null;
  const grid = modelToGrid(georef.mapConversion, x, y);
  const { lon, lat } = lccInverse(crs, grid.easting / crs.unit, grid.northing / crs.unit);
  return { lon, lat, height: georef.mapConversion.orthogonalHeight + z };
}

const haversine = (a, b) => {
  const R = 6371008.8, dLat = (b.lat - a.lat) * DEG, dLon = (b.lon - a.lon) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/**
 * The placement the file states, as three geographic points (model origin, +x and +y at `step`
 * metres) from which the client builds the model matrix on the globe. Building it from points,
 * not from an angle, carries the grid rotation, the meridian convergence and the scale exactly.
 */
export function georeferencedPlacement(georef, { step = 100 } = {}) {
  if (!georef?.supported) {
    return { mode: 'UNGEOREFERENCED', reason: georef?.mapConversion
      ? `Projected CRS ${georef.projectedCrs?.name ?? '(unnamed)'} is not supported by this converter.`
      : 'The IFC has no IfcMapConversion.' };
  }
  const origin = modelToGeographic(georef, 0, 0, 0);
  const xAxis = modelToGeographic(georef, step, 0, 0);
  const yAxis = modelToGeographic(georef, 0, step, 0);
  // Heading of the model's +y axis from true north, clockwise (for display and as the calibration start).
  const east = (xAxis.lon - origin.lon) * Math.cos(origin.lat * DEG), north = xAxis.lat - origin.lat;
  const xBearing = Math.atan2(east, north) / DEG;
  const siteCheck = georef.site?.refLatitude !== null && georef.site?.refLatitude !== undefined && georef.site?.refLongitude !== null
    ? { refLatitude: georef.site.refLatitude, refLongitude: georef.site.refLongitude,
      metresFromMapOrigin: Math.round(haversine(origin, { lat: georef.site.refLatitude, lon: georef.site.refLongitude }) * 100) / 100 }
    : null;
  return {
    mode: 'IFC_GEOREFERENCED',
    crs: georef.projectedCrs.name, crsDescription: georef.projectedCrs.description,
    geodeticDatum: georef.projectedCrs.geodeticDatum, verticalDatum: georef.projectedCrs.verticalDatum,
    origin, xAxis, yAxis, step,
    headingDeg: Math.round((xBearing - 90) * 1e6) / 1e6,
    scale: georef.mapConversion.scale,
    siteCheck,
  };
}
