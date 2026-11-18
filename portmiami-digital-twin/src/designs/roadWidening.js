/**
 * Widening an existing road: which part of it, how wide, and what that can honestly be said to mean.
 *
 * THE AUDIT FINDING THAT SHAPES THIS FILE. The Miami-Dade centreline file carries no width and no
 * lane count — its properties are CLASS, ST_NAME, the address ranges, and a shape length. So for
 * every road in this dataset the existing width is genuinely UNKNOWN, and three things follow:
 *
 *   - "Widen by N metres" cannot be computed. Only "propose a total width of N metres" can.
 *   - Incremental pavement area is NOT CALCULABLE, because the existing pavement is unknown.
 *   - Boundary-preserving widening (keep the left edge, push the right one out) is unavailable,
 *     because there is no known edge to preserve. A centreline does not imply where the kerb is.
 *
 * A user may supply a baseline width, and then all three become available — but it is carried as
 * `USER_ASSUMED` for the rest of its life and every figure derived from it says so. The one thing
 * this module will not do is infer a pavement edge from a centreline and present it as a measurement.
 *
 * MEASURES, NOT SCREEN COORDINATES. A section is stored as a start and end distance in metres
 * along the baseline centreline. Clicks are snapped to a measure at selection time; the stored
 * design holds the measure. A screen coordinate stored as a section would move when the camera did.
 */
import { enuToLonLat, lonLatToEnu } from '../scenarios/garagePlacement.js';
import { cleanCentreline, ringAreaM2, roadCorridorRing } from './roadCorridor.js';

/** The defaults a new widening proposal opens with. Both editable. */
export const DEFAULT_PROPOSED_WIDTH_M = 10;
export const DEFAULT_PROPOSED_LANES = 2;

/** Shorter than this is not a section anyone meant to draw. */
export const MIN_SECTION_M = 5;

export const WIDENING_SIDE = Object.freeze({ BOTH: 'BOTH', LEFT: 'LEFT', RIGHT: 'RIGHT' });

/** Where a number came from. Never collapsed into one "value" field. */
export const PROVENANCE = Object.freeze({
  MEASURED_GIS: 'MEASURED_GIS',
  CALCULATED: 'CALCULATED',
  USER_ASSUMED: 'USER_ASSUMED',
  UNKNOWN: 'UNKNOWN',
  NOT_CALCULABLE: 'NOT_CALCULABLE',
});

const finite = value => typeof value === 'number' && Number.isFinite(value);

/**
 * Cumulative distance to each vertex, in metres.
 *
 * The measure of vertex i is the ground distance from the start of the alignment, so a section is
 * stored as two numbers that survive a camera move, a reload and a different screen.
 */
export function measuresAlong(coordinates) {
  const points = cleanCentreline(coordinates);
  const measures = [0];
  for (let i = 1; i < points.length; i += 1) {
    const [east, north] = lonLatToEnu(points[i - 1], points[i]);
    measures.push(measures[i - 1] + Math.hypot(east, north));
  }
  return { points, measures, totalM: measures[measures.length - 1] ?? 0 };
}

/** The point at a given measure along the alignment, interpolated within its segment. */
export function pointAtMeasure(coordinates, measureM) {
  const { points, measures, totalM } = measuresAlong(coordinates);
  if (points.length === 0) return null;
  if (points.length === 1) return points[0];
  const target = Math.min(Math.max(measureM, 0), totalM);
  for (let i = 1; i < points.length; i += 1) {
    if (measures[i] < target) continue;
    const span = measures[i] - measures[i - 1];
    if (span <= 0) return points[i];
    const fraction = (target - measures[i - 1]) / span;
    const [east, north] = lonLatToEnu(points[i - 1], points[i]);
    return enuToLonLat(points[i - 1], east * fraction, north * fraction);
  }
  return points[points.length - 1];
}

/**
 * Where along the alignment a clicked point falls.
 *
 * Returns the measure of the closest point ON the centreline, not of the closest vertex: clicking
 * halfway down a 200 m straight should give 100 m, not 0 or 200.
 */
export function nearestMeasureTo(coordinates, point) {
  const { points, measures } = measuresAlong(coordinates);
  if (points.length < 2) return { measureM: 0, distanceM: null };
  let best = { measureM: 0, distanceM: Infinity };
  for (let i = 1; i < points.length; i += 1) {
    const origin = points[i - 1];
    const [ex, ey] = lonLatToEnu(origin, points[i]);
    const [px, py] = lonLatToEnu(origin, point);
    const lengthSquared = ex * ex + ey * ey;
    const t = lengthSquared === 0 ? 0
      : Math.max(0, Math.min(1, (px * ex + py * ey) / lengthSquared));
    const distance = Math.hypot(px - ex * t, py - ey * t);
    if (distance < best.distanceM) {
      best = { measureM: measures[i - 1] + Math.sqrt(lengthSquared) * t, distanceM: distance };
    }
  }
  return { measureM: best.measureM, distanceM: best.distanceM === Infinity ? null : best.distanceM };
}

/**
 * The part of an alignment between two measures.
 *
 * Reversed measures are swapped rather than refused: dragging a section backwards is a normal
 * thing to do, and the stored record is normalised so start is always before end.
 */
export function sectionBetweenMeasures(coordinates, startM, endM) {
  const { points, measures, totalM } = measuresAlong(coordinates);
  if (points.length < 2) return null;
  const from = Math.max(0, Math.min(startM ?? 0, endM ?? totalM));
  const to = Math.min(totalM, Math.max(startM ?? 0, endM ?? totalM));
  if (to - from < 1e-6) return null;

  const section = [pointAtMeasure(coordinates, from)];
  for (let i = 0; i < points.length; i += 1) {
    if (measures[i] > from && measures[i] < to) section.push(points[i]);
  }
  section.push(pointAtMeasure(coordinates, to));
  return { coordinates: cleanCentreline(section), startM: from, endM: to, lengthM: to - from };
}

/**
 * An alignment shifted sideways by a fixed number of metres.
 *
 * Positive is to the LEFT of the direction of travel. Used to keep one edge where it is while the
 * other moves: widening on the left shifts the centreline left by half the increase, so the right
 * edge stays put. The joins are mitred the same way the corridor's are.
 */
export function offsetCentreline(coordinates, metres) {
  const points = cleanCentreline(coordinates);
  if (points.length < 2 || !finite(metres)) return points;
  if (Math.abs(metres) < 1e-9) return points;
  const origin = points[0];
  const local = points.map(point => lonLatToEnu(origin, point));
  const normals = [];
  for (let i = 1; i < local.length; i += 1) {
    const dx = local[i][0] - local[i - 1][0], dy = local[i][1] - local[i - 1][1];
    const length = Math.hypot(dx, dy) || 1;
    normals.push([-dy / length, dx / length]);
  }
  return local.map((point, index) => {
    const before = normals[index - 1], after = normals[index];
    let normal = before && after ? [before[0] + after[0], before[1] + after[1]] : (before ?? after);
    const length = Math.hypot(normal[0], normal[1]);
    normal = length < 1e-9 ? (after ?? before) : [normal[0] / length, normal[1] / length];
    const cos = after ? normal[0] * after[0] + normal[1] * after[1] : 1;
    const scale = Math.min(4, cos > 1e-6 ? 1 / cos : 4);
    return enuToLonLat(origin,
      point[0] + normal[0] * metres * scale, point[1] + normal[1] * metres * scale);
  });
}

/**
 * Can this widening side be offered?
 *
 * LEFT and RIGHT keep one existing edge where it is, which needs a known existing width. With
 * none, the only honest option is BOTH — a proposed corridor centred on the published centreline.
 */
export function availableSides(baselineWidthM) {
  return finite(baselineWidthM) && baselineWidthM > 0
    ? [WIDENING_SIDE.BOTH, WIDENING_SIDE.LEFT, WIDENING_SIDE.RIGHT]
    : [WIDENING_SIDE.BOTH];
}

export const sideAvailable = (side, baselineWidthM) =>
  availableSides(baselineWidthM).includes(side);

/**
 * The proposed corridor for a widening.
 *
 * Returns `{ ring, centreline, shiftM }` or null. `shiftM` is how far the proposed centreline was
 * moved from the published one, which is zero for BOTH and half the increase for a one-sided
 * widening — the number that explains why the drawn road is not centred on the original line.
 */
export function wideningCorridor({
  coordinates, startM = null, endM = null, totalWidthM = DEFAULT_PROPOSED_WIDTH_M,
  side = WIDENING_SIDE.BOTH, baselineWidthM = null,
}) {
  const section = startM === null && endM === null
    ? { coordinates: cleanCentreline(coordinates), startM: 0, endM: null, lengthM: null }
    : sectionBetweenMeasures(coordinates, startM, endM);
  if (!section?.coordinates?.length || section.coordinates.length < 2) return null;
  if (!finite(totalWidthM) || totalWidthM <= 0) return null;

  // A one-sided widening without a known baseline width is refused, not approximated.
  const oneSided = side === WIDENING_SIDE.LEFT || side === WIDENING_SIDE.RIGHT;
  if (oneSided && !sideAvailable(side, baselineWidthM)) return null;

  const increase = oneSided ? totalWidthM - baselineWidthM : 0;
  const shiftM = oneSided
    ? (side === WIDENING_SIDE.LEFT ? increase / 2 : -increase / 2)
    : 0;
  const centreline = shiftM === 0
    ? section.coordinates : offsetCentreline(section.coordinates, shiftM);
  const ring = roadCorridorRing(centreline, totalWidthM);
  return ring ? { ring, centreline, shiftM, section } : null;
}

/**
 * What a widening measures, with where every number came from.
 *
 * Each figure is `{ value, provenance }` rather than a bare number, because the difference
 * between "measured from the county geometry", "computed from a shape someone drew" and "not
 * calculable" is the whole point of this panel.
 */
export function wideningQuantities({
  coordinates, startM = null, endM = null, totalWidthM = DEFAULT_PROPOSED_WIDTH_M,
  laneCount = DEFAULT_PROPOSED_LANES, side = WIDENING_SIDE.BOTH,
  baselineWidthM = null, baselineLanes = null, baselineWidthSource = PROVENANCE.UNKNOWN,
}) {
  const { totalM } = measuresAlong(coordinates);
  const section = startM === null && endM === null
    ? { lengthM: totalM, startM: 0, endM: totalM }
    : sectionBetweenMeasures(coordinates, startM, endM);
  const affectedLengthM = section?.lengthM ?? 0;

  const corridor = wideningCorridor({
    coordinates, startM, endM, totalWidthM, side, baselineWidthM,
  });
  const proposedAreaM2 = corridor ? ringAreaM2(corridor.ring) : null;

  const known = finite(baselineWidthM) && baselineWidthM > 0;
  const existingAreaM2 = known ? baselineWidthM * affectedLengthM : null;

  return {
    baseline: {
      /** The county file publishes no width, so this is Unknown unless someone supplied one. */
      widthM: known
        ? { value: baselineWidthM, provenance: baselineWidthSource }
        : { value: null, provenance: PROVENANCE.UNKNOWN },
      lanes: finite(baselineLanes)
        ? { value: baselineLanes, provenance: PROVENANCE.USER_ASSUMED }
        : { value: null, provenance: PROVENANCE.UNKNOWN },
      totalLengthM: { value: totalM, provenance: PROVENANCE.MEASURED_GIS },
      surfaceAreaM2: known
        ? { value: existingAreaM2, provenance: PROVENANCE.CALCULATED }
        : { value: null, provenance: PROVENANCE.UNKNOWN },
    },
    proposed: {
      totalWidthM: { value: totalWidthM, provenance: PROVENANCE.USER_ASSUMED },
      lanes: { value: laneCount, provenance: PROVENANCE.USER_ASSUMED },
      side: { value: side, provenance: PROVENANCE.USER_ASSUMED },
      affectedLengthM: { value: affectedLengthM, provenance: PROVENANCE.CALCULATED },
      corridorAreaM2: proposedAreaM2 === null
        ? { value: null, provenance: PROVENANCE.NOT_CALCULABLE }
        : { value: proposedAreaM2, provenance: PROVENANCE.CALCULATED },
      centrelineShiftM: { value: corridor?.shiftM ?? 0, provenance: PROVENANCE.CALCULATED },
    },
    difference: {
      /*
       * NOT CALCULABLE, not zero. Without a known existing width there is no way to say how much
       * pavement a 10 m corridor adds — it might add ten metres of it or none at all.
       */
      widthChangeM: known
        ? { value: totalWidthM - baselineWidthM, provenance: PROVENANCE.CALCULATED }
        : { value: null, provenance: PROVENANCE.NOT_CALCULABLE },
      laneChange: finite(baselineLanes)
        ? { value: laneCount - baselineLanes, provenance: PROVENANCE.CALCULATED }
        : { value: null, provenance: PROVENANCE.NOT_CALCULABLE },
      incrementalPavementM2: known && proposedAreaM2 !== null
        ? { value: Math.max(0, proposedAreaM2 - existingAreaM2), provenance: PROVENANCE.CALCULATED }
        : { value: null, provenance: PROVENANCE.NOT_CALCULABLE },
    },
  };
}

/**
 * Everything wrong with a proposal, as sentences.
 *
 * The lane advisory is explicitly an assumption, not a standard: this twin holds no design
 * manual, so it says what it assumed rather than citing an authority it does not have.
 */
export const ASSUMED_LANE_WIDTH_M = 3.3;

export function validateWidening({
  coordinates, startM = null, endM = null, totalWidthM, laneCount, side = WIDENING_SIDE.BOTH,
  baselineWidthM = null,
}) {
  const errors = [], advisories = [];
  const { totalM } = measuresAlong(coordinates ?? []);
  if (!coordinates || totalM <= 0) errors.push('No road is selected.');
  if (!finite(totalWidthM)) errors.push('Proposed width must be a number.');
  else if (totalWidthM <= 0) errors.push('Proposed width must be greater than zero.');
  else if (totalWidthM > 60) errors.push('Proposed width is above the 60 m maximum this tool allows.');
  if (!Number.isInteger(laneCount) || laneCount < 1) errors.push('Lane count must be a whole number of at least 1.');
  else if (laneCount > 12) errors.push('Lane count is above the 12 this tool allows.');

  if (startM !== null && endM !== null) {
    const section = sectionBetweenMeasures(coordinates, startM, endM);
    if (!section) errors.push('The selected section is empty.');
    else if (section.lengthM < MIN_SECTION_M) {
      errors.push(`The selected section is ${section.lengthM.toFixed(1)} m; the minimum is ${MIN_SECTION_M} m.`);
    }
  }

  if ((side === WIDENING_SIDE.LEFT || side === WIDENING_SIDE.RIGHT)
    && !sideAvailable(side, baselineWidthM)) {
    errors.push('One-sided widening needs a stated existing width — the county file publishes '
      + 'none, and a kerb line cannot be inferred from a centreline.');
  }
  if (finite(baselineWidthM) && finite(totalWidthM) && totalWidthM < baselineWidthM) {
    advisories.push(`The proposed width is narrower than the stated existing ${baselineWidthM} m. `
      + 'That is a narrowing, not a widening.');
  }
  if (finite(totalWidthM) && Number.isInteger(laneCount) && laneCount > 0) {
    const perLane = totalWidthM / laneCount;
    if (perLane < ASSUMED_LANE_WIDTH_M) {
      advisories.push(`${totalWidthM} m over ${laneCount} lanes is ${perLane.toFixed(1)} m each. `
        + `This tool assumes ${ASSUMED_LANE_WIDTH_M} m per lane before shoulders and medians; it `
        + 'holds no design standard, so treat this as an arithmetic note rather than a code check.');
    }
  }
  return { ok: errors.length === 0, errors, advisories };
}

/** A short, stable fingerprint of a baseline alignment, to detect the dataset changing. */
export function alignmentFingerprint(coordinates) {
  const { totalM, points } = measuresAlong(coordinates ?? []);
  if (points.length < 2) return null;
  const round = value => Math.round(value * 1e5) / 1e5;
  const [first, last] = [points[0], points[points.length - 1]];
  return `${points.length}:${Math.round(totalM)}:${round(first[0])},${round(first[1])}`
    + `:${round(last[0])},${round(last[1])}`;
}

/**
 * The saved record for a widening: a MODIFIED road element referencing the county OBJECTID.
 *
 * One builder for every caller — the studio's Save and the demo template — so a template can
 * never be a different shape from a widening someone drew. `id` overrides the derived one when
 * an existing change is being edited, so editing replaces the record instead of adding another.
 */
export function wideningElement({
  road, startM = null, endM = null, totalWidthM = DEFAULT_PROPOSED_WIDTH_M,
  laneCount = DEFAULT_PROPOSED_LANES, side = WIDENING_SIDE.BOTH, baselineWidthM = null, id = null,
}) {
  const section = startM === null || endM === null
    ? null : sectionBetweenMeasures(road.coordinates, startM, endM);
  return {
    id: id ?? `widen-${road.objectId}-${section ? `${Math.round(section.startM)}-${Math.round(section.endM)}` : 'all'}`,
    type: 'ROAD',
    changeType: 'MODIFIED',
    operation: 'WIDEN',
    baselineRef: {
      kind: 'ROAD',
      source: 'MIAMI_DADE_ROADS',
      objectId: road.objectId,
      name: road.name ?? null,
      fingerprint: alignmentFingerprint(road.coordinates),
    },
    section: section
      ? { startMeasureM: section.startM, endMeasureM: section.endM, lengthM: section.lengthM }
      : null,
    // The corridor is REGENERATED from these on load; the geometry below is a cached preview.
    proposal: {
      totalWidthM,
      laneCount,
      wideningSide: side,
      baselineWidthM,
      baselineWidthSource: baselineWidthM === null ? PROVENANCE.UNKNOWN : PROVENANCE.USER_ASSUMED,
    },
    geometry: {
      type: 'LineString',
      coordinates: (section ?? { coordinates: road.coordinates }).coordinates,
    },
    properties: {
      name: `${road.name || `Road ${road.objectId}`} — proposed widening`,
      widthM: totalWidthM,
      lanes: laneCount,
      roadType: 'WIDENING',
    },
    provenance: { source: 'USER_CONCEPTUAL_DESIGN', status: 'DRAFT' },
  };
}
