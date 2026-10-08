/**
 * What the map should draw for a location's history.
 *
 * The right panel answers what the data MEANS — the concentration, the percentages, the twin's
 * conclusion. This answers where it IS, and it is the only place that knows the difference between
 * a record and a mapped location.
 *
 * That difference is the thing the map was failing to explain. Measured on the connected register
 * for one incident: 31 records resolve to 20 coordinates, because these positions are the locations
 * of DAMAGED ASSETS and several records are filed against the same asset. A map showing 20 symbols
 * beside a panel saying 31 looks broken unless it says so.
 *
 * CORRIDOR CONCENTRATION. Records are placed along one corridor axis by perpendicular projection —
 * a longitudinal position only, never an EB/WB assignment, because `segment ID` is stated on just
 * 20 of 31 records and the carriageway cannot be inferred from proximity. Measured across the whole
 * register, 156 of 178 records sit within 100 m of the centreline (median 39 m), so the projection
 * is meaningful for the great majority; the remainder are reported as unplaced rather than snapped.
 *
 * Pure: records in, drawable facts out. No DOM, no Cesium, no fetching.
 */
import { clusterMatchesByPlace } from './historicalLocationSafety.js';

/**
 * How far off the corridor axis a record may be and still be placed along it.
 *
 * Operational configuration. Beyond this the perpendicular projection stops describing a position
 * on this corridor and starts describing a point on some other road, so the record is counted as
 * unplaced and the map says how many it could not place.
 */
export const CONCENTRATION_CONFIG = Object.freeze({
  corridorReachMeters: 150,
  /** Bin length along the corridor. Short enough to localise, long enough not to be noise. */
  binMeters: 400,
  /** Bands are relative to the busiest bin, so the ribbon reads within its own corridor. */
  bands: Object.freeze([
    Object.freeze({ id: 'HIGH', label: 'Higher', fromShare: 0.66 }),
    Object.freeze({ id: 'MEDIUM', label: 'Moderate', fromShare: 0.33 }),
    Object.freeze({ id: 'LOW', label: 'Lower', fromShare: 0 }),
  ]),
});

/**
 * The marker families, derived from the register's own `incident_type` values.
 *
 * Grouping is presentation only — the record keeps its own wording, and the panel reports the
 * source categories unchanged. Anything unrecognised becomes OTHER rather than being forced into a
 * family it does not belong to.
 */
export const PATTERN_FAMILIES = Object.freeze({
  // `icon` is a key into the workspace icon set and `color` a tone from the maintenance palette,
  // so a history marker is drawn by the SAME pin the asset screens use. One pin style across the
  // application means an operator learns the vocabulary once.
  MERGE: Object.freeze({ id: 'MERGE', label: 'Merge / sideswipe', icon: 'congestion', color: '#8b5cf6' }),
  REAR_END: Object.freeze({ id: 'REAR_END', label: 'Rear-end', icon: 'incident', color: '#f97316' }),
  PEDESTRIAN: Object.freeze({ id: 'PEDESTRIAN', label: 'Pedestrian-related', icon: 'disabledVehicle', color: '#14b8a6' }),
  ASSET: Object.freeze({ id: 'ASSET', label: 'Asset impact', icon: 'damagedAsset', color: '#eab308' }),
  DEPARTURE: Object.freeze({ id: 'DEPARTURE', label: 'Lane departure / rollover', icon: 'closure', color: '#e5484d' }),
  OTHER: Object.freeze({ id: 'OTHER', label: 'Other / unknown', icon: 'cleared', color: '#3b82f6' }),
});

/** Which family a source incident type belongs to. Source wording is never rewritten. */
export function patternFamily(incidentType) {
  const text = String(incidentType ?? '').toLowerCase();
  if (!text) return PATTERN_FAMILIES.OTHER;
  if (/sideswipe|merge|lane.?change/.test(text)) return PATTERN_FAMILIES.MERGE;
  if (/rear.?end/.test(text)) return PATTERN_FAMILIES.REAR_END;
  if (/pedestrian/.test(text)) return PATTERN_FAMILIES.PEDESTRIAN;
  if (/attenuator|guardrail|barrier|device strike|sign/.test(text)) return PATTERN_FAMILIES.ASSET;
  if (/departure|rollover|spinout|wrong.?way/.test(text)) return PATTERN_FAMILIES.DEPARTURE;
  return PATTERN_FAMILIES.OTHER;
}

const attributesOf = record => record?.raw?.attributes ?? record?.raw ?? {};
const isYes = value => /^y(es)?$/i.test(String(value ?? '').trim());
const text = value => String(value ?? '').trim();

/**
 * The mapped locations for a set of matched records.
 *
 * Each carries what an operator needs at a glance — how many records, which family dominates — and
 * what they need on click, without the map having to re-read the register.
 */
export function mappedLocations(matches) {
  return clusterMatchesByPlace(matches).map(place => {
    const records = (matches ?? []).filter(match =>
      match.record.latitude.toFixed(5) === String(place.latitude.toFixed(5))
      && match.record.longitude.toFixed(5) === String(place.longitude.toFixed(5)));

    const families = new Map();
    const patterns = new Map();
    const circumstances = new Map();
    let injury = 0; let hospitalisation = 0; let fatality = 0; let latest = null;
    for (const match of records) {
      const attributes = attributesOf(match.record);
      const family = patternFamily(attributes.incident_type);
      families.set(family.id, (families.get(family.id) ?? 0) + 1);
      const type = text(attributes.incident_type);
      if (type) patterns.set(type, (patterns.get(type) ?? 0) + 1);
      const circumstance = text(attributes.root_cause_category);
      if (circumstance) circumstances.set(circumstance, (circumstances.get(circumstance) ?? 0) + 1);
      if (isYes(attributes.injuries_y_n)) injury += 1;
      if (isYes(attributes.hospitalizations)) hospitalisation += 1;
      if (isYes(attributes.fatalities)) fatality += 1;
      const at = match.atMs;
      if (Number.isFinite(at) && (latest == null || at > latest)) latest = at;
    }

    // The family that most records belong to. A tie reports as mixed rather than picking one.
    const ranked = [...families.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const mixed = ranked.length > 1 && ranked[0][1] === ranked[1][1];
    const dominant = ranked.length && !mixed
      ? Object.values(PATTERN_FAMILIES).find(family => family.id === ranked[0][0])
      : null;

    return Object.freeze({
      key: place.key,
      longitude: place.longitude,
      latitude: place.latitude,
      count: records.length,
      dominant,
      mixed,
      /** Source categories with their own wording, for the popover. */
      patterns: [...patterns.entries()].map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
      contributingCircumstances: [...circumstances.entries()].map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
      outcomes: Object.freeze({ injury, hospitalisation, fatality }),
      latestMs: latest,
      records: records.map(match => Object.freeze({
        id: match.record.id,
        atMs: match.atMs,
        type: text(attributesOf(match.record).incident_type) || null,
        severity: match.record.severity ?? null,
        circumstance: text(attributesOf(match.record).root_cause_category) || null,
        assetId: text(attributesOf(match.record).damaged_asset_id) || null,
      })),
    });
  });
}

/** The one line the map owes the operator: how many records, how many symbols. */
export const locationSummary = (matches, locations) => Object.freeze({
  records: (matches ?? []).length,
  mappedLocations: (locations ?? []).length,
  sharing: (matches ?? []).length - (locations ?? []).length,
});

/**
 * Where along the corridor the records sit, as counted bins.
 *
 * One axis, taken from the supplied centreline. A record beyond `corridorReachMeters` of it is not
 * placed — the count of those is returned so the map can say what it left out rather than quietly
 * dropping them.
 */
export function corridorConcentration(matches, centerline, {
  corridorReachMeters = CONCENTRATION_CONFIG.corridorReachMeters,
  binMeters = CONCENTRATION_CONFIG.binMeters,
} = {}) {
  const line = (centerline ?? []).map(point => (Array.isArray(point)
    ? point : [point?.longitude ?? point?.lon, point?.latitude ?? point?.lat]))
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  if (line.length < 2) return { bins: [], placed: 0, unplaced: (matches ?? []).length, reason: 'No corridor centreline available' };

  // Cumulative length at each vertex, so a projection yields a position along the whole line.
  const metres = (aLon, aLat, bLon, bLat) => {
    const k = Math.cos(((aLat + bLat) / 2) * Math.PI / 180);
    return Math.hypot((bLon - aLon) * k, bLat - aLat) * 111_320;
  };
  const runs = [0];
  for (let i = 1; i < line.length; i += 1) {
    runs.push(runs[i - 1] + metres(line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]));
  }
  const total = runs.at(-1);

  const project = (lon, lat) => {
    let best = null;
    for (let i = 1; i < line.length; i += 1) {
      const [ax, ay] = line[i - 1];
      const [bx, by] = line[i];
      const k = Math.cos(((ay + by) / 2) * Math.PI / 180);
      const dx = (bx - ax) * k;
      const dy = by - ay;
      const lengthSq = dx * dx + dy * dy;
      const t = lengthSq ? Math.max(0, Math.min(1, (((lon - ax) * k) * dx + (lat - ay) * dy) / lengthSq)) : 0;
      const offset = metres(lon, lat, ax + (bx - ax) * t, ay + (by - ay) * t);
      if (!best || offset < best.offset) best = { offset, along: runs[i - 1] + Math.sqrt(lengthSq) * 111_320 * t };
    }
    return best;
  };

  const counts = new Map();
  let placed = 0; let unplaced = 0;
  for (const match of matches ?? []) {
    const at = project(match.record.longitude, match.record.latitude);
    if (!at || at.offset > corridorReachMeters) { unplaced += 1; continue; }
    placed += 1;
    const bin = Math.floor(at.along / binMeters);
    counts.set(bin, (counts.get(bin) ?? 0) + 1);
  }
  if (!counts.size) return { bins: [], placed, unplaced, reason: placed ? null : 'No records fall on this corridor' };

  const peak = Math.max(...counts.values());
  const bins = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([bin, count]) => {
    const share = count / peak;
    const band = CONCENTRATION_CONFIG.bands.find(entry => share >= entry.fromShare) ?? CONCENTRATION_CONFIG.bands.at(-1);
    return Object.freeze({
      bin,
      count,
      share,
      band: band.id,
      bandLabel: band.label,
      fromMeters: bin * binMeters,
      toMeters: Math.min(total, (bin + 1) * binMeters),
    });
  });
  return { bins, placed, unplaced, peak, reason: null, corridorMeters: total };
}

/** The positions along a centreline between two distances, for drawing one bin. */
export function centerlineSlice(centerline, fromMeters, toMeters) {
  const line = (centerline ?? []).map(point => (Array.isArray(point)
    ? point : [point?.longitude ?? point?.lon, point?.latitude ?? point?.lat]))
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  if (line.length < 2) return [];
  const metres = (a, b) => {
    const k = Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
    return Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * 111_320;
  };
  const out = [];
  let run = 0;
  for (let i = 1; i < line.length; i += 1) {
    const step = metres(line[i - 1], line[i]);
    const start = run;
    const end = run + step;
    if (end >= fromMeters && start <= toMeters && step > 0) {
      const lerp = fraction => [
        line[i - 1][0] + (line[i][0] - line[i - 1][0]) * fraction,
        line[i - 1][1] + (line[i][1] - line[i - 1][1]) * fraction,
      ];
      const from = Math.max(0, (fromMeters - start) / step);
      const to = Math.min(1, (toMeters - start) / step);
      if (!out.length) out.push(lerp(from));
      out.push(lerp(to));
    }
    run = end;
  }
  return out.map(([longitude, latitude]) => ({ longitude, latitude }));
}
