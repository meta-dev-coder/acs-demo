/**
 * The corridor cut into sections, with the exposure each one carries.
 *
 * This module exists because of a correction. The screen previously reported "Accidents per 100M
 * VMT" as impossible — "no exposure data exists in this twin". That was wrong: the app already
 * ships `data/i595_fdot_traffic_segments.geojson`, 16 FDOT mainline segments carrying published
 * `aadt` (2025) and milepost extents. With a length and a period, that is exposure, and a rate IS
 * calculable. Reporting it as unavailable was the honest answer to the wrong question.
 *
 * What the rate is, stated exactly, because the caveats decide whether it may be used:
 *
 *   • It counts RECORDS IN AN OPERATIONAL REGISTER, not reported crashes. It is a recorded-incident
 *     rate, never an FDOT crash rate, and the two must not be compared.
 *   • Exposure uses a 2025 annual average applied to a register spanning 2024-05 to 2026-04. The
 *     AADT is the same figure on both carriageways of each milepost range, which is how a two-way
 *     count is published, so it is counted ONCE per section rather than summed across directions.
 *     `EXPOSURE_ASSUMPTIONS` states this where the screen can show it.
 *   • A record is assigned to a section by distance from the section's own centreline, and the
 *     record's position is its damaged asset's. Carriageway cannot be verified — the two
 *     carriageways are tens of metres apart and the positions are not that good — so EB and WB of
 *     one milepost range are ONE section here, and direction is reported as unverified.
 *
 * Nothing here is interpolated: a section with no AADT published gets no rate, not an estimate.
 */

/** Metres per degree, near enough at this latitude for assigning a point to a line. */
const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320;

export const EXPOSURE_ASSUMPTIONS = Object.freeze({
  aadtIsTwoWay: true,
  aadtNote: 'Each milepost range publishes the same AADT on both carriageways, which is how a '
    + 'two-way count is reported. It is counted once per section, not summed across directions.',
  periodNote: 'AADT is a 2025 annual average applied across the whole register period. A section '
    + 'whose traffic changed within that period is not tracked.',
  countNote: 'The numerator counts records in an operational register, not reported crashes. This '
    + 'is a recorded-incident rate and must not be read as, or compared with, an FDOT crash rate.',
  directionNote: 'Carriageway is not verified: records are positioned at their damaged asset, so '
    + 'both directions of a milepost range are treated as one section.',
});

const metresBetweenPoints = (a, b) => Math.hypot(
  (a.longitude - b.longitude) * M_PER_DEG_LON * Math.cos((a.latitude * Math.PI) / 180),
  (a.latitude - b.latitude) * M_PER_DEG_LAT);

/** Distance from a point to a line segment, in metres. */
function metresToSegment(point, from, to) {
  const scale = Math.cos((point.latitude * Math.PI) / 180);
  const px = point.longitude * M_PER_DEG_LON * scale;
  const py = point.latitude * M_PER_DEG_LAT;
  const ax = from[0] * M_PER_DEG_LON * scale;
  const ay = from[1] * M_PER_DEG_LAT;
  const bx = to[0] * M_PER_DEG_LON * scale;
  const by = to[1] * M_PER_DEG_LAT;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Nearest distance from a point to a whole polyline, in metres. */
export function metresToLine(point, coordinates = []) {
  let best = Infinity;
  for (let index = 0; index + 1 < coordinates.length; index += 1) {
    best = Math.min(best, metresToSegment(point, coordinates[index], coordinates[index + 1]));
    if (best === 0) break;
  }
  return best;
}

/**
 * Build the sections from the FDOT segment collection.
 *
 * One section per milepost range, carrying both carriageways' geometry.
 *
 * @param {object} geojson the FDOT traffic segments FeatureCollection
 */
export function buildSections(geojson) {
  const byRange = new Map();
  for (const feature of geojson?.features ?? []) {
    const properties = feature?.properties ?? {};
    const begin = Number(properties.begin_post);
    const end = Number(properties.end_post);
    if (!Number.isFinite(begin) || !Number.isFinite(end) || end <= begin) continue;
    const key = `${begin.toFixed(3)}-${end.toFixed(3)}`;
    const entry = byRange.get(key) ?? {
      id: `MP${begin.toFixed(1)}-${end.toFixed(1)}`,
      beginPost: begin,
      endPost: end,
      lengthMiles: Number((end - begin).toFixed(3)),
      directions: [],
      lines: [],
      aadt: null,
      aadtYear: null,
      descriptionFrom: properties.desc_from ?? null,
      descriptionTo: properties.desc_to ?? null,
      segmentIds: [],
    };
    entry.directions.push(properties.direction);
    entry.segmentIds.push(String(properties.segment_id));
    if (feature.geometry?.type === 'LineString') entry.lines.push(feature.geometry.coordinates);
    const aadt = Number(properties.aadt);
    if (Number.isFinite(aadt)) {
      // Published per carriageway but identical on both: a two-way count, taken once.
      entry.aadt = entry.aadt == null ? aadt : Math.max(entry.aadt, aadt);
      entry.aadtYear = Number(properties.aadt_year) || entry.aadtYear;
    }
    byRange.set(key, entry);
  }
  return Object.freeze([...byRange.values()]
    .sort((a, b) => a.beginPost - b.beginPost)
    .map(entry => Object.freeze({
      ...entry,
      directions: Object.freeze([...new Set(entry.directions)]),
      segmentIds: Object.freeze(entry.segmentIds),
      lines: Object.freeze(entry.lines),
      label: `MP ${entry.beginPost.toFixed(1)}–${entry.endPost.toFixed(1)}`,
      where: entry.descriptionFrom && entry.descriptionTo
        ? `${entry.descriptionFrom} to ${entry.descriptionTo}` : null,
      /** Both carriageways, because the records cannot tell them apart. */
      carriageway: 'BOTH',
      carriagewayBasis: EXPOSURE_ASSUMPTIONS.directionNote,
    })));
}

/**
 * Which section a positioned record belongs to.
 *
 * By distance to the centreline, with a limit: a record more than `withinMeters` from every section
 * is off the mainline (a ramp, a frontage road, an asset set back from the road) and is left
 * UNASSIGNED rather than pulled onto the nearest line.
 *
 * @returns {{section: object, metres: number}|null}
 */
export function sectionFor(point, sections = [], { withinMeters = 400 } = {}) {
  if (!Number.isFinite(point?.longitude) || !Number.isFinite(point?.latitude)) return null;
  let best = null;
  for (const section of sections) {
    for (const line of section.lines) {
      const metres = metresToLine(point, line);
      if (!best || metres < best.metres) best = { section, metres };
    }
  }
  return best && best.metres <= withinMeters ? best : null;
}

/**
 * Exposure for one section over a period, in vehicle-miles.
 *
 * @param {object} section
 * @param {number} days the register period, in days
 */
export const exposureOf = (section, days) => (Number.isFinite(section?.aadt) && days > 0
  ? section.aadt * section.lengthMiles * days : null);

/**
 * Assign every record to a section and compute what each section carries.
 *
 * @param {{sections: object[], facts: object[], defects: object[], hazards: object[], days: number}} input
 */
export function sectionProfiles({ sections = [], facts = [], defects = [], hazards = [], days = 0 } = {}) {
  const profiles = new Map(sections.map(section => [section.id, {
    section,
    facts: [],
    defects: [],
    hazards: [],
  }]));
  const unassigned = { facts: [], defects: [], hazards: [] };
  const assign = (items, key) => {
    for (const item of items) {
      const found = sectionFor(item, sections);
      if (found) profiles.get(found.section.id)[key].push(item);
      else unassigned[key].push(item);
    }
  };
  assign(facts, 'facts');
  assign(defects, 'defects');
  assign(hazards.flatMap(place => place.observations ?? []).map(observation => observation), 'hazards');

  const rows = [...profiles.values()].map(entry => {
    const exposure = exposureOf(entry.section, days);
    const severe = entry.facts.filter(fact => fact.severity.rank >= 2).length;
    return Object.freeze({
      id: entry.section.id,
      section: entry.section,
      records: entry.facts.length,
      severeRecords: severe,
      facts: Object.freeze(entry.facts),
      defects: Object.freeze(entry.defects),
      openDefects: entry.defects.filter(defect => defect.open).length,
      hazards: Object.freeze(entry.hazards),
      hazardFindings: entry.hazards.reduce((sum, observation) => sum + (observation.hazardCount ?? 0), 0),
      secondaryRecords: entry.facts.filter(fact => /secondary/i.test(fact.rootCauseCategory ?? '')).length,
      exposureVehicleMiles: exposure,
      /**
       * Recorded incidents per 100 million vehicle-miles.
       *
       * Null where no AADT is published. Never called a crash rate: see EXPOSURE_ASSUMPTIONS.
       */
      perHundredMillionVmt: exposure
        ? Number(((entry.facts.length / exposure) * 100_000_000).toFixed(1)) : null,
      severePerHundredMillionVmt: exposure
        ? Number(((severe / exposure) * 100_000_000).toFixed(1)) : null,
    });
  });
  const totalExposure = rows.reduce((sum, row) => sum + (row.exposureVehicleMiles ?? 0), 0);
  const counted = rows.reduce((sum, row) => sum + row.records, 0);
  return Object.freeze({
    rows: Object.freeze(rows.sort((a, b) => (b.perHundredMillionVmt ?? -1) - (a.perHundredMillionVmt ?? -1)
      || b.records - a.records)),
    byId: new Map(rows.map(row => [row.id, row])),
    unassigned: Object.freeze({
      facts: Object.freeze(unassigned.facts),
      defects: Object.freeze(unassigned.defects),
      hazards: Object.freeze(unassigned.hazards),
    }),
    days,
    totalExposure: totalExposure || null,
    assignedRecords: counted,
    corridorPerHundredMillionVmt: totalExposure
      ? Number(((counted / totalExposure) * 100_000_000).toFixed(1)) : null,
    assumptions: EXPOSURE_ASSUMPTIONS,
  });
}

/** Days between the first and last record, for the exposure denominator. */
export const periodDays = (facts = []) => {
  if (facts.length < 2) return 0;
  const sorted = [...facts].sort((a, b) => a.when.ms - b.when.ms);
  return Math.max(1, Math.round((sorted.at(-1).when.ms - sorted[0].when.ms) / 86_400_000));
};

export { metresBetweenPoints };

/**
 * The stretch of road a set of findings actually occupies.
 *
 * Selecting "Segment_102W — 25 records" should light up THAT piece of road, not the whole four-mile
 * milepost range it happens to fall in. The register's own segment names carry no geometry, so the
 * stretch is derived: every finding is projected onto the section's centreline, and the line is cut
 * between the first and last projection with a margin either side.
 *
 * The result is as approximate as its inputs — the positions are asset-derived — so the margin is
 * generous rather than tight, and the screen says what the highlight is: where the records sit, not
 * a surveyed extent.
 *
 * @param {number[][]} line the section centreline, [lon, lat] pairs
 * @param {{longitude: number, latitude: number}[]} points the findings
 * @param {{paddingMeters?: number}} [options]
 * @returns {number[][]|null} the clipped line, or null when nothing projects onto it
 */
export function clipLineToPoints(line = [], points = [], { paddingMeters = 120 } = {}) {
  if (line.length < 2 || !points.length) return null;
  /** Distance along the line to each vertex, so a projection can be measured in metres. */
  const cumulative = [0];
  for (let index = 1; index < line.length; index += 1) {
    cumulative.push(cumulative[index - 1] + metresBetweenPoints(
      { longitude: line[index - 1][0], latitude: line[index - 1][1] },
      { longitude: line[index][0], latitude: line[index][1] }));
  }
  const total = cumulative.at(-1);

  /** Where along the line a point falls, in metres from its start. */
  const alongFor = point => {
    let best = { distance: Infinity, along: 0 };
    for (let index = 0; index + 1 < line.length; index += 1) {
      const [ax, ay] = line[index];
      const [bx, by] = line[index + 1];
      const scale = Math.cos((point.latitude * Math.PI) / 180);
      const px = (point.longitude - ax) * M_PER_DEG_LON * scale;
      const py = (point.latitude - ay) * M_PER_DEG_LAT;
      const dx = (bx - ax) * M_PER_DEG_LON * scale;
      const dy = (by - ay) * M_PER_DEG_LAT;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengthSquared)) : 0;
      const distance = Math.hypot(px - t * dx, py - t * dy);
      if (distance < best.distance) {
        best = { distance, along: cumulative[index] + t * Math.sqrt(lengthSquared) };
      }
    }
    return best;
  };

  const alongs = points
    .filter(point => Number.isFinite(point?.longitude) && Number.isFinite(point?.latitude))
    .map(alongFor)
    // A finding half a kilometre off this line belongs to another part of the corridor.
    .filter(found => found.distance <= 500)
    .map(found => found.along);
  if (!alongs.length) return null;

  const from = Math.max(0, Math.min(...alongs) - paddingMeters);
  const to = Math.min(total, Math.max(...alongs) + paddingMeters);

  /** The point at a given distance along the line. */
  const pointAt = distance => {
    for (let index = 0; index + 1 < line.length; index += 1) {
      if (distance > cumulative[index + 1]) continue;
      const span = cumulative[index + 1] - cumulative[index];
      const t = span ? (distance - cumulative[index]) / span : 0;
      return [line[index][0] + (line[index + 1][0] - line[index][0]) * t,
        line[index][1] + (line[index + 1][1] - line[index][1]) * t];
    }
    return line.at(-1);
  };

  const clipped = [pointAt(from)];
  for (let index = 0; index < line.length; index += 1) {
    if (cumulative[index] > from && cumulative[index] < to) clipped.push(line[index]);
  }
  clipped.push(pointAt(to));
  return clipped.length >= 2 ? clipped : null;
}

/**
 * The stretch to highlight for a selection, across both carriageways of its section.
 *
 * @returns {{lines: number[][][], metres: number, basis: string}|null}
 */
export function highlightStretch(section, points, options) {
  if (!section?.lines?.length) return null;
  const lines = section.lines.map(line => clipLineToPoints(line, points, options)).filter(Boolean);
  if (!lines.length) return null;
  const metres = Math.round(Math.max(...lines.map(line => line.reduce((sum, point, index) =>
    (index ? sum + metresBetweenPoints(
      { longitude: line[index - 1][0], latitude: line[index - 1][1] },
      { longitude: point[0], latitude: point[1] }) : 0), 0))));
  return Object.freeze({
    lines: Object.freeze(lines),
    metres,
    basis: 'The stretch these findings occupy, projected onto the section centreline. Their positions '
      + 'are asset-derived, so this is where the records sit — not a surveyed extent.',
  });
}

/**
 * The stretch of road a modelled queue would occupy, upstream of an incident.
 *
 * Used only to draw the SIMULATED queue extent. It takes the incident's position along the section
 * centreline and walks back along it by the modelled queue length, so the overlay covers real road
 * rather than a straight line drawn across whatever is behind the incident.
 *
 * Which way is upstream cannot be known from the record — the carriageway is not verifiable — so
 * the direction is given by the caller and the overlay is labelled as modelled, not observed.
 *
 * @param {number[][]} line the section centreline
 * @param {{longitude: number, latitude: number}} point the incident
 * @param {number} metres how far back the queue reaches
 * @param {{towardsStart?: boolean}} [options] which way along the line counts as upstream
 */
export function stretchUpstream(line = [], point, metres = 0, { towardsStart = true } = {}) {
  if (line.length < 2 || !point || metres <= 0) return null;
  const cumulative = [0];
  for (let index = 1; index < line.length; index += 1) {
    cumulative.push(cumulative[index - 1] + metresBetweenPoints(
      { longitude: line[index - 1][0], latitude: line[index - 1][1] },
      { longitude: line[index][0], latitude: line[index][1] }));
  }
  const total = cumulative.at(-1);

  /** Where the incident sits along the line. */
  let anchor = null;
  let best = Infinity;
  for (let index = 0; index + 1 < line.length; index += 1) {
    const distance = metresToLine(point, [line[index], line[index + 1]]);
    if (distance < best) { best = distance; anchor = cumulative[index]; }
  }
  if (anchor == null || best > 500) return null;

  const from = towardsStart ? Math.max(0, anchor - metres) : anchor;
  const to = towardsStart ? anchor : Math.min(total, anchor + metres);
  if (to - from < 1) return null;

  const pointAt = distance => {
    for (let index = 0; index + 1 < line.length; index += 1) {
      if (distance > cumulative[index + 1]) continue;
      const span = cumulative[index + 1] - cumulative[index];
      const t = span ? (distance - cumulative[index]) / span : 0;
      return [line[index][0] + (line[index + 1][0] - line[index][0]) * t,
        line[index][1] + (line[index + 1][1] - line[index][1]) * t];
    }
    return line.at(-1);
  };

  const coordinates = [pointAt(from)];
  for (let index = 0; index < line.length; index += 1) {
    if (cumulative[index] > from && cumulative[index] < to) coordinates.push(line[index]);
  }
  coordinates.push(pointAt(to));
  return coordinates.length >= 2 ? Object.freeze(coordinates) : null;
}
