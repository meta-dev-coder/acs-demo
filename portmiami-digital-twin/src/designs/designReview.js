/**
 * Reading a road design alternative as a design REVIEW rather than as a list of records.
 *
 * WHY THIS EXISTS. The studio listed an alternative's elements one by one. An audit of the stored
 * alternatives showed what that hid:
 *
 *   - Design A held four records — a new road, a realignment, a closure and a widening — and all
 *     four were on, or drawn along, ONE road: S CRUISE BLVD, OBJECTID 40642. Listed flat they read
 *     as four roads. Grouped by the road they change, they read as what they are.
 *   - Design C held ten "Proposed Terminal Link" records. Every one is the same 179 m alignment:
 *     five share identical coordinates and the rest differ by under 0.1 m. Each press of Save on
 *     the New Road tool minted a fresh id for the same draft, so the alternative grew a copy per
 *     press and its new-road total read ten times the road's length.
 *
 * So this module groups changes by the baseline road they touch, finds duplicates by GEOMETRY and
 * stable id (never by name), and measures totals two ways — as a plain sum and as the unique area
 * on the ground — so overlapping surfaces are never presented as extra pavement.
 *
 * EVERYTHING HERE IS PURE. It reads designs and returns new values; it never edits a stored record.
 * Cleanup is a separate, previewed step the user confirms, and the server keeps the prior revision.
 */
import { enuToLonLat, lonLatToEnu } from '../scenarios/garagePlacement.js';
import { centrelineLengthM, cleanCentreline, roadCorridorRing } from './roadCorridor.js';
import { checkSiteConflicts } from '../scenarios/siteConflicts.js';
import {
  ROAD_OPERATION, isClosure, isRealignment, isWidening, roadMeasure, roadOperationOf,
  wideningMeasure,
} from './designQuantities.js';
import { CHANGE_TYPE, DESIGN_SOURCE, ELEMENT_TYPE, VERIFICATION, createDesign } from './designModel.js';
import { DESIGN_DOMAIN } from './designDomain.js';
import {
  measuresAlong, nearestMeasureTo, pointAtMeasure, sectionBetweenMeasures, wideningCorridor,
  wideningElement,
} from './roadWidening.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);

// ---- what an alternative is FOR -------------------------------------------------------------------

/**
 * The engineering question an alternative answers.
 *
 * Declared on the record (`purpose`), so an alternative keeps its meaning when it is renamed. A
 * record that never declared one is described from what it holds, and says it was inferred.
 */
export const DESIGN_PURPOSE = Object.freeze({
  WIDENING: 'WIDENING',
  NEW_ROAD: 'NEW_ROAD',
  REALIGNMENT: 'REALIGNMENT',
  MIXED: 'MIXED',
});

export const PURPOSE_INFO = Object.freeze({
  WIDENING: {
    label: 'Road widening',
    description: 'Widen a selected section of an existing PortMiami road and evaluate the physical changes.',
  },
  NEW_ROAD: {
    label: 'New access road',
    description: 'A new road between two defined locations, checked for endpoint connectivity and spatial conflicts.',
  },
  REALIGNMENT: {
    label: 'Road realignment',
    description: 'An alternative alignment for an existing road, compared with the original in length, geometry and what it affects.',
  },
  MIXED: {
    label: 'Mixed road changes',
    description: 'More than one kind of road change. Each is listed under the road it affects.',
  },
});

const PURPOSE_FOR_OPERATION = Object.freeze({
  [ROAD_OPERATION.WIDEN]: DESIGN_PURPOSE.WIDENING,
  [ROAD_OPERATION.CREATE]: DESIGN_PURPOSE.NEW_ROAD,
  [ROAD_OPERATION.REALIGN]: DESIGN_PURPOSE.REALIGNMENT,
});

/** `{ purpose, inferred }`, or a null purpose for an empty alternative that declared none. */
export function purposeOf(design) {
  if (DESIGN_PURPOSE[design?.purpose]) return { purpose: design.purpose, inferred: false };
  const operations = new Set((design?.elements ?? []).map(roadOperationOf).filter(Boolean));
  if (operations.size === 0) return { purpose: null, inferred: true };
  if (operations.size === 1) {
    const [only] = operations;
    return { purpose: PURPOSE_FOR_OPERATION[only] ?? DESIGN_PURPOSE.MIXED, inferred: true };
  }
  return { purpose: DESIGN_PURPOSE.MIXED, inferred: true };
}

// ---- grouping by the road a change affects ---------------------------------------------------------

/**
 * The alternative's road changes, organised by what they touch.
 *
 * Changes that reference a county road are grouped under its OBJECTID — a widening, a closure and
 * a realignment of S CRUISE BLVD are three operations on one road, not three roads. New roads
 * reference nothing existing and are listed on their own. Order within a group is the stored order.
 */
export function groupRoadChanges(design) {
  const byRoad = new Map();
  const newRoads = [];
  const other = [];
  for (const element of design?.elements ?? []) {
    if (element.type !== ELEMENT_TYPE.ROAD) { other.push(element); continue; }
    const ref = element.baselineRef;
    if (ref?.kind === 'ROAD' && finite(ref.objectId)) {
      if (!byRoad.has(ref.objectId)) {
        byRoad.set(ref.objectId, { objectId: ref.objectId, name: ref.name ?? null, operations: [] });
      }
      byRoad.get(ref.objectId).operations.push(element);
    } else if (element.changeType === CHANGE_TYPE.NEW) {
      newRoads.push(element);
    } else {
      // A modification with no county reference — an older sketch. Kept visible, never dropped.
      other.push(element);
    }
  }
  return { existingRoads: [...byRoad.values()], newRoads, other };
}

/** "Start 25.77341, -80.16835 → end 25.77321, -80.16677", for telling same-named roads apart. */
export function endpointsOf(element) {
  const coordinates = element?.geometry?.type === 'LineString' ? element.geometry.coordinates : null;
  if (!coordinates?.length) return null;
  const fmt = ([lon, lat]) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  return { start: fmt(coordinates[0]), end: fmt(coordinates[coordinates.length - 1]) };
}

/** The names used by more than one element, so the panel can show ids and endpoints for them. */
export function repeatedNames(design) {
  const counts = new Map();
  for (const element of design?.elements ?? []) {
    const name = element.properties?.name;
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name));
}

// ---- duplicates, by geometry ----------------------------------------------------------------------

const lineOf = element => (element?.geometry?.type === 'LineString' ? element.geometry.coordinates : null);

/** Distance in metres from a point to a segment, in a local frame about the point. */
function pointToSegmentM(point, a, b) {
  const [ax, ay] = lonLatToEnu(point, a);
  const [bx, by] = lonLatToEnu(point, b);
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / ((dx * dx + dy * dy) || 1)));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

const pointToLineM = (point, line) => {
  if (line.length === 1) return pointToSegmentM(point, line[0], line[0]);
  let best = Infinity;
  for (let i = 1; i < line.length; i += 1) best = Math.min(best, pointToSegmentM(point, line[i - 1], line[i]));
  return best;
};

/** The largest distance from either line to the other: 0 for identical alignments. */
export function hausdorffM(a, b) {
  if (!a?.length || !b?.length) return Infinity;
  let worst = 0;
  for (const point of a) worst = Math.max(worst, pointToLineM(point, b));
  for (const point of b) worst = Math.max(worst, pointToLineM(point, a));
  return worst;
}

/** Below this, two alignments are the same line drawn twice, not two roads. */
export const DUPLICATE_TOLERANCE_M = 0.5;

/** What has to match, besides the geometry, for two records to be the same proposal. */
const proposalKey = element => JSON.stringify([
  roadOperationOf(element),
  element.baselineRef?.objectId ?? null,
  element.properties?.widthM ?? null,
  element.properties?.lanes ?? null,
  element.section ? [Math.round(element.section.startMeasureM), Math.round(element.section.endMeasureM)] : null,
]);

const sameCoordinates = (a, b) => JSON.stringify(lineOf(a)) === JSON.stringify(lineOf(b));

/**
 * Records that are the same proposal stored more than once.
 *
 * Two elements are duplicates only when they are the same operation on the same road with the same
 * width, lanes and section, AND their alignments are within `toleranceM` of each other everywhere.
 * A shared name proves nothing and is not consulted. The first stored record in each group is the
 * one kept; the rest are listed with how far each deviates, so the preview shows the evidence.
 */
export function findDuplicates(design, { toleranceM = DUPLICATE_TOLERANCE_M } = {}) {
  const elements = (design?.elements ?? []).filter(element => lineOf(element)?.length >= 2);
  const claimed = new Set();
  const groups = [];
  for (let i = 0; i < elements.length; i += 1) {
    const keep = elements[i];
    if (claimed.has(keep.id)) continue;
    const copies = [];
    for (let j = i + 1; j < elements.length; j += 1) {
      const other = elements[j];
      if (claimed.has(other.id) || proposalKey(other) !== proposalKey(keep)) continue;
      const deviationM = hausdorffM(lineOf(keep), lineOf(other));
      if (deviationM <= toleranceM) {
        copies.push({ id: other.id, deviationM, exact: sameCoordinates(keep, other) });
        claimed.add(other.id);
      }
    }
    if (copies.length) groups.push({ keepId: keep.id, name: keep.properties?.name ?? keep.id, copies });
  }
  return groups;
}

/** The alternative with the listed element ids taken out. Pure: the stored record is untouched. */
export const withoutElements = (design, ids) => {
  const drop = new Set(ids);
  return { ...design, elements: (design?.elements ?? []).filter(element => !drop.has(element.id)) };
};

// ---- surfaces, and their union -------------------------------------------------------------------

/** The paved surface an element proposes, as a ring, or null where it proposes none. */
export function surfaceRingOf(element) {
  if (element?.type !== ELEMENT_TYPE.ROAD || isClosure(element)) return null;
  const line = lineOf(element);
  if (!line) return null;
  if (isWidening(element)) {
    const proposal = element.proposal ?? {};
    return wideningCorridor({
      coordinates: line, totalWidthM: proposal.totalWidthM, side: proposal.wideningSide,
      baselineWidthM: proposal.baselineWidthM ?? null,
    })?.ring ?? null;
  }
  return roadCorridorRing(line, element.properties?.widthM);
}

const inside = ([x, y], ring) => {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};

/**
 * The area on the ground covered by a set of rings, counting overlap once.
 *
 * No polygon-clipping library is carried, so it is estimated on a grid in metres: each cell centre
 * covered by any ring counts once. The step adapts to the extent so the work stays bounded, and is
 * returned so the panel can state the resolution of the estimate.
 */
export function unionAreaM2(rings, { maxCells = 250_000 } = {}) {
  const usable = (rings ?? []).filter(ring => ring?.length >= 4);
  if (usable.length === 0) return { areaM2: 0, stepM: null };
  const origin = usable[0][0];
  const local = usable.map(ring => ring.map(point => lonLatToEnu(origin, point)));
  const xs = local.flat().map(p => p[0]), ys = local.flat().map(p => p[1]);
  const west = Math.min(...xs), east = Math.max(...xs), south = Math.min(...ys), north = Math.max(...ys);
  const step = Math.max(0.5, Math.sqrt(((east - west) * (north - south)) / maxCells));
  const boxes = local.map(ring => ({
    ring,
    w: Math.min(...ring.map(p => p[0])), e: Math.max(...ring.map(p => p[0])),
    s: Math.min(...ring.map(p => p[1])), n: Math.max(...ring.map(p => p[1])),
  }));
  let cells = 0;
  for (let x = west + step / 2; x < east; x += step) {
    for (let y = south + step / 2; y < north; y += step) {
      if (boxes.some(b => x >= b.w && x <= b.e && y >= b.s && y <= b.n && inside([x, y], b.ring))) cells += 1;
    }
  }
  return { areaM2: cells * step * step, stepM: step };
}

// ---- the alternative's totals ---------------------------------------------------------------------

/**
 * What an alternative adds up to, with unique roads kept apart from operations.
 *
 * "1 existing road affected · 3 modification operations" is the honest statement for Design A;
 * "3 modified roads" was not. New-road length is reported as stored AND with duplicate copies set
 * aside, and proposed area as a sum AND as unique ground area, so a reader can see when the two
 * differ and why.
 */
export function designSummary(design) {
  const groups = groupRoadChanges(design);
  const duplicates = findDuplicates(design);
  const duplicateIds = new Set(duplicates.flatMap(group => group.copies.map(copy => copy.id)));

  const newRoads = groups.newRoads;
  const newLength = rows => rows.reduce((total, element) => total + (roadMeasure(element)?.lengthM ?? 0), 0);
  const widenings = (design?.elements ?? []).filter(isWidening);
  const surfaces = (design?.elements ?? [])
    .map(element => ({ element, ring: surfaceRingOf(element) }))
    .filter(row => row.ring);
  const areaOf = element => (isWidening(element)
    ? wideningMeasure(element)?.proposed.corridorAreaM2.value
    : roadMeasure(element)?.surfaceAreaM2) ?? 0;
  const summedAreaM2 = surfaces.reduce((total, row) => total + areaOf(row.element), 0);
  const union = unionAreaM2(surfaces.map(row => row.ring));

  return {
    existingRoadsAffected: groups.existingRoads.length,
    operationsOnExisting: groups.existingRoads.reduce((n, road) => n + road.operations.length, 0),
    newRoadCount: newRoads.length,
    uniqueNewRoadCount: newRoads.filter(element => !duplicateIds.has(element.id)).length,
    newRoadLengthM: newLength(newRoads),
    uniqueNewRoadLengthM: newLength(newRoads.filter(element => !duplicateIds.has(element.id))),
    widenedLengthM: widenings.reduce(
      (total, element) => total + (wideningMeasure(element)?.proposed.affectedLengthM.value ?? 0), 0),
    realignedCount: (design?.elements ?? []).filter(isRealignment).length,
    closedCount: (design?.elements ?? []).filter(isClosure).length,
    summedAreaM2,
    uniqueAreaM2: union.areaM2,
    areaGridM: union.stepM,
    /** True when surfaces overlap enough that the sum overstates the ground covered. */
    overlapping: summedAreaM2 - union.areaM2 > Math.max(5, summedAreaM2 * 0.02),
    duplicates,
    duplicateCount: duplicateIds.size,
    changeCount: (design?.elements ?? []).length,
  };
}

/**
 * Pairs of changes that act on the same stretch of the same road in incompatible ways.
 *
 * Widening a section that the same alternative also closes, or realigns away, is a contradiction a
 * reviewer needs to see. Only stated where the sections genuinely overlap — an unsectioned change
 * covers the whole road.
 */
export function operationClashes(design) {
  const clashes = [];
  for (const road of groupRoadChanges(design).existingRoads) {
    const span = element => (element.section
      ? [element.section.startMeasureM, element.section.endMeasureM] : [0, Infinity]);
    const ops = road.operations;
    for (let i = 0; i < ops.length; i += 1) {
      for (let j = i + 1; j < ops.length; j += 1) {
        const [a, b] = [ops[i], ops[j]];
        const kinds = new Set([roadOperationOf(a), roadOperationOf(b)]);
        if (kinds.size < 2 || !(kinds.has(ROAD_OPERATION.CLOSE) || kinds.has(ROAD_OPERATION.REALIGN))) continue;
        const [as, ae] = span(a), [bs, be] = span(b);
        if (Math.min(ae, be) - Math.max(as, bs) <= 0) continue;
        clashes.push({
          objectId: road.objectId,
          ids: [a.id, b.id],
          text: `${a.properties?.name ?? a.id} and ${b.properties?.name ?? b.id} act on the same stretch of ${road.name ?? `road ${road.objectId}`}.`,
        });
      }
    }
  }
  return clashes;
}

// ---- managing alternatives ------------------------------------------------------------------------

/** A copy under a new id. Elements keep their ids, so a comparison can see what is shared. */
export function duplicateDesign(design, { id, name }) {
  const { revision, createdAt, updatedAt, archived, ...rest } = design;
  return {
    ...rest,
    id,
    name,
    source: DESIGN_SOURCE.USER_DRAWN,
    duplicatedFrom: { id: design.id, revision: revision ?? null },
    elements: (design.elements ?? []).map(element => ({ ...element })),
  };
}

// ---- one operation per alternative ------------------------------------------------------------------

/**
 * The operation an alternative is restricted to, when it declares one.
 *
 * Design A widens, Design B builds new road, Design C realigns — and nothing else. The restriction
 * is a field on the record (`allowedOperation`), checked here, by the editor before it offers a
 * tool, by `saveElement` before it writes, and again by the server, which is the authority. A
 * record that predates the field declares nothing and stays readable exactly as it was.
 */
export const ALLOWED_OPERATIONS = Object.freeze(['WIDEN', 'CREATE', 'REALIGN']);

export const OPERATION_NAME = Object.freeze({
  WIDEN: 'Road widening', CREATE: 'New road', REALIGN: 'Road realignment', CLOSE: 'Road closure',
});

/** Why an element may not be saved into a design, or null when it may. */
export function operationRejection(design, element) {
  const allowed = design?.allowedOperation;
  if (!allowed) return null;
  const op = roadOperationOf(element);
  if (op === allowed) return null;
  return `${design.name ?? 'This alternative'} holds ${OPERATION_NAME[allowed]?.toLowerCase() ?? allowed} only; `
    + `a ${(OPERATION_NAME[op] ?? 'mixed change').toLowerCase()} cannot be saved into it.`;
}

/** Every element of a design that breaks its declared operation. Reported, never converted. */
export const constraintViolations = design => (design?.allowedOperation
  ? (design.elements ?? []).filter(element => operationRejection(design, element)).map(element => element.id)
  : []);

// ---- realignment geometry ----------------------------------------------------------------------------

/** A proposed line's end must sit within this of the section end it ties into. */
export const TIE_IN_TOLERANCE_M = 1;

const segmentsCross = (a, b, c, d) => {
  const orient = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
};

/** Whether a line crosses itself, tested in metres about its first point. Adjacent segments are skipped. */
export function selfIntersects(line) {
  if (!line || line.length < 4) return false;
  const local = line.map(point => lonLatToEnu(line[0], point));
  for (let i = 0; i < local.length - 1; i += 1) {
    for (let j = i + 2; j < local.length - 1; j += 1) {
      if (segmentsCross(local[i], local[i + 1], local[j], local[j + 1])) return true;
    }
  }
  return false;
}

/** The original stretch a realignment replaces: the marked section, or the whole road. */
export function replacedSection(element, road) {
  if (!road?.coordinates?.length) return null;
  const s = element?.section;
  return s && Number.isFinite(s.startMeasureM) && Number.isFinite(s.endMeasureM)
    ? sectionBetweenMeasures(road.coordinates, s.startMeasureM, s.endMeasureM)?.coordinates ?? null
    : cleanCentreline(road.coordinates);
}

/**
 * What a realignment changes, measured from its stored geometry against the county road.
 *
 * Lateral displacement is the furthest any point of the proposed line lies from the original
 * stretch, sampled every two metres — the figure a reviewer looks for to see how far it moves.
 */
export function realignmentMetrics(element, road) {
  const proposed = lineOf(element);
  const original = replacedSection(element, road);
  if (!proposed?.length || !original?.length) return null;
  const distance = (a, b) => Math.hypot(...lonLatToEnu(a, b));
  const proposedLengthM = centrelineLengthM(proposed);
  let maxLateralM = 0;
  for (let m = 0; m <= proposedLengthM; m += 2) {
    maxLateralM = Math.max(maxLateralM, pointToLineM(pointAtMeasure(proposed, m), original));
  }
  const startTieM = distance(proposed[0], original[0]);
  const endTieM = distance(proposed[proposed.length - 1], original[original.length - 1]);
  return {
    original,
    originalLengthM: centrelineLengthM(original),
    proposedLengthM,
    lengthDifferenceM: proposedLengthM - centrelineLengthM(original),
    maxLateralM,
    startTieM,
    endTieM,
    tiedIn: startTieM <= TIE_IN_TOLERANCE_M && endTieM <= TIE_IN_TOLERANCE_M,
    selfIntersects: selfIntersects(proposed),
  };
}

/** Reasons a proposed realignment cannot be saved, as sentences. Empty when it can. */
export function validateRealignmentGeometry({ points, original, tieInsLocked = true }) {
  const errors = [];
  const line = cleanCentreline(points ?? []);
  if (line.length < 2) errors.push('The proposed alignment needs at least two points.');
  if (line.length !== (points ?? []).length) errors.push('Two vertices sit on top of each other; remove one.');
  if (selfIntersects(line)) errors.push('The proposed alignment crosses itself.');
  if (original?.length >= 2 && line.length >= 2 && tieInsLocked) {
    const gap = (a, b) => Math.hypot(...lonLatToEnu(a, b));
    if (gap(line[0], original[0]) > TIE_IN_TOLERANCE_M) errors.push('The start no longer ties into the original road.');
    if (gap(line[line.length - 1], original[original.length - 1]) > TIE_IN_TOLERANCE_M) {
      errors.push('The end no longer ties into the original road.');
    }
  }
  if (original?.length >= 2 && line.length >= 2) {
    let moved = 0;
    for (const point of line) moved = Math.max(moved, pointToLineM(point, original));
    if (moved < 2) errors.push('The proposed alignment follows the original within 2 m; move a vertex to propose a change.');
  }
  return errors;
}

/** A section resampled into evenly spaced vertices, ends exactly on the section ends. */
export function resampleLine(line, segments = 5) {
  const total = centrelineLengthM(line);
  if (!(total > 0)) return line;
  return Array.from({ length: segments + 1 }, (_, i) => pointAtMeasure(line, (total * i) / segments));
}

// ---- the demonstration alternatives ---------------------------------------------------------------

/** Separate ids, so the demonstration set never overwrites an alternative someone already saved. */
export const DEMO_IDS = Object.freeze({
  WIDENING: 'road-demo-widening',
  NEW_ROAD: 'road-demo-new-access',
  REALIGNMENT: 'road-demo-realignment',
});

export const DEMO_WIDENING_ROAD = Object.freeze({ objectId: 40642, name: 'S CRUISE BLVD', sectionM: 60 });

/**
 * Where the demonstration looks: S CRUISE BLVD by the cruise terminals. Candidates nearer it rank
 * first, so all three alternatives can be seen from one camera position.
 */
export const DEMO_FOCUS = Object.freeze([-80.1672, 25.7735]);

const DEMO_WIDTH_M = 10;
const DEMO_LANES = 2;

/** Buildings near a line, so a check only looks at what it could hit. */
const buildingsNear = (buildings, line, padDeg = 0.002) => {
  const lons = line.map(p => p[0]), lats = line.map(p => p[1]);
  const w = Math.min(...lons) - padDeg, e = Math.max(...lons) + padDeg;
  const so = Math.min(...lats) - padDeg, n = Math.max(...lats) + padDeg;
  return (buildings ?? []).filter(b => !b.bounds || (b.bounds.east >= w && b.bounds.west <= e
    && b.bounds.north >= so && b.bounds.south <= n));
};

/** Whether a 10 m corridor along `line` overlaps any building footprint. */
function hitsBuilding(line, buildings) {
  const ring = roadCorridorRing(line, DEMO_WIDTH_M);
  if (!ring) return true;
  const check = checkSiteConflicts(ring, { buildings: buildingsNear(buildings, line), roads: null });
  return check.checks.some(c => c.id === 'buildings' && c.status === 'CONFLICT');
}

/** Distance from `point` to the nearest county centreline other than `exceptId`. */
function nearestOtherRoadM(point, roads, exceptIds = new Set()) {
  let best = Infinity;
  for (const road of roads) {
    if (exceptIds.has(road.objectId)) continue;
    const b = road.bounds;
    if (b && (point[0] < b.west - 0.001 || point[0] > b.east + 0.001 || point[1] < b.south - 0.001 || point[1] > b.north + 0.001)) continue;
    const { distanceM } = nearestMeasureTo(road.coordinates, point);
    if (distanceM !== null && distanceM < best) best = distanceM;
  }
  return best;
}

const fromFocus = point => Math.hypot(...lonLatToEnu(DEMO_FOCUS, point));

/**
 * Design B's road: a new link between two points ON the county network.
 *
 * Both ends are vertices sampled from port-access centrelines, so each end is connected by
 * construction rather than by assertion. A candidate is kept only if its 10 m corridor clears
 * every building footprint and its middle stays more than 8 m from every other centreline — a
 * new link, not a line drawn along a road that is already there. Candidates are ranked by how
 * close they are to S CRUISE BLVD and how near their length is to 150 m. Deterministic: the same
 * data always gives the same road. Returns null when nothing qualifies, and the alternative then
 * waits for the user to draw it.
 */
export function generateNewRoad({ roadsById, buildingsById }) {
  const roads = [...(roadsById?.values() ?? [])];
  const buildings = [...(buildingsById?.values() ?? [])];
  // Tunnel segments are underground: a surface road cannot tie into them.
  const port = roads.filter(road => road.isPortAccess && !road.isTunnel && road.coordinates?.length >= 2);
  const samples = [];
  for (const road of port) {
    const total = centrelineLengthM(road.coordinates);
    for (let m = 0; m <= total; m += 30) {
      const point = pointAtMeasure(road.coordinates, m);
      if (fromFocus(point) < 700) samples.push({ point, objectId: road.objectId, name: road.name });
    }
  }
  const pairs = [];
  for (let i = 0; i < samples.length; i += 1) {
    for (let j = i + 1; j < samples.length; j += 1) {
      if (samples[i].objectId === samples[j].objectId) continue;
      const length = Math.hypot(...lonLatToEnu(samples[i].point, samples[j].point));
      if (length < 90 || length > 240) continue;
      const mid = [(samples[i].point[0] + samples[j].point[0]) / 2, (samples[i].point[1] + samples[j].point[1]) / 2];
      pairs.push({ a: samples[i], b: samples[j], length, score: fromFocus(mid) + Math.abs(length - 150) * 2 });
    }
  }
  pairs.sort((x, y) => x.score - y.score);
  for (const { a, b } of pairs) {
    const [e, n] = lonLatToEnu(a.point, b.point);
    const len = Math.hypot(e, n);
    // A gentle curve where one fits — the midpoint pushed sideways by 6% of the length, either
    // way — and a straight link where neither does.
    for (const share of [0.06, -0.06, 0]) {
      const bend = len * share;
      const line = [0.25, 0.5, 0.75].map(t => enuToLonLat(a.point,
        e * t - (n / len) * bend * Math.sin(Math.PI * t), n * t + (e / len) * bend * Math.sin(Math.PI * t)));
      const points = [a.point, ...line, b.point];
      if (!line.every(point => nearestOtherRoadM(point, roads) > 8) || hitsBuilding(points, buildings)) continue;
      return {
        points,
        start: { objectId: a.objectId, name: a.name },
        end: { objectId: b.objectId, name: b.name },
      };
    }
  }
  return null;
}

/**
 * Design C's realignment: a real county road, its middle section, and a bowed replacement.
 *
 * The section runs from 20% to 80% of the road's length, so both tie-ins are on the road itself
 * and the rest of it is untouched. The replacement keeps those two tie-in points exactly and bows
 * sideways by 14–24 m in the middle, tried on both sides. It is kept only if its corridor clears
 * every building and its middle stays clear of other centrelines. S CRUISE BLVD is left to
 * Design A. Returns null when no road qualifies.
 */
export function generateRealignment({ roadsById, buildingsById }) {
  const roads = [...(roadsById?.values() ?? [])];
  const buildings = [...(buildingsById?.values() ?? [])];
  const candidates = roads
    .filter(road => road.isPortAccess && !road.isTunnel && road.objectId !== DEMO_WIDENING_ROAD.objectId
      && road.coordinates?.length >= 2)
    .map(road => ({ road, total: centrelineLengthM(road.coordinates) }))
    .filter(({ total }) => total >= 150 && total <= 500)
    .map(row => ({ ...row, distance: fromFocus(pointAtMeasure(row.road.coordinates, row.total / 2)) }))
    .filter(row => row.distance < 900)
    .sort((x, y) => x.distance - y.distance);
  for (const { road, total } of candidates.slice(0, 40)) {
    const startM = Math.round(total * 0.2), endM = Math.round(total * 0.8);
    const original = sectionBetweenMeasures(road.coordinates, startM, endM)?.coordinates;
    if (!original || original.length < 2) continue;
    const length = centrelineLengthM(original);
    for (const offset of [18, -18, 24, -24, 14, -14]) {
      const points = [];
      const steps = 6;
      for (let i = 0; i <= steps; i += 1) {
        const m = (length * i) / steps;
        const at = pointAtMeasure(original, m);
        if (i === 0 || i === steps) { points.push(at); continue; }
        const ahead = pointAtMeasure(original, Math.min(length, m + 2));
        const [te, tn] = lonLatToEnu(at, ahead);
        const tl = Math.hypot(te, tn) || 1;
        const lateral = offset * Math.sin((Math.PI * i) / steps);
        points.push(enuToLonLat(at, (-tn / tl) * lateral, (te / tl) * lateral));
      }
      const interior = points.slice(2, -2);
      const clear = interior.every(point => nearestOtherRoadM(point, roads, new Set([road.objectId])) > 10);
      if (!clear || selfIntersects(points) || hitsBuilding(points, buildings)) continue;
      return { road, startM, endM, points };
    }
  }
  return null;
}

const demo = ({ id, name, purpose, allowedOperation, description, elements = [], limitation = null }) => ({
  ...createDesign({
    id, name, description, source: DESIGN_SOURCE.SYNTHETIC_DEMO,
    verificationStatus: VERIFICATION.CONCEPTUAL, domain: DESIGN_DOMAIN.ROAD_INFRASTRUCTURE, elements,
  }),
  purpose,
  allowedOperation,
  demoTemplate: purpose,
  limitation,
});

const provenance = basis => ({ source: 'SYNTHETIC_DEMO_GENERATED', status: 'CONCEPTUAL', basis });

/**
 * The three demonstration alternatives: one operation each, all on real county geometry.
 *
 * A — S CRUISE BLVD (OBJECTID 40642), widened to 10 m and 2 lanes over a measured section. The
 *     30 m section someone already saved in the original Design A is reused when it is present.
 * B — a new 10 m, 2-lane link generated between two points on the port network (see
 *     `generateNewRoad`), with the roads at each end recorded.
 * C — a realignment of a real road's middle section, tied in at both ends (`generateRealignment`).
 *
 * Any of the three that cannot be built from the loaded data is returned EMPTY with the reason, so
 * nothing is invented to fill a card.
 */
export function demoTemplates({ roadsById, buildingsById, legacyDesigns = [] } = {}) {
  const road = roadsById?.get?.(DEMO_WIDENING_ROAD.objectId) ?? null;
  const totalM = road ? measuresAlong(road.coordinates).totalM : 0;
  const saved = legacyDesigns.flatMap(d => d?.elements ?? [])
    .find(e => e.operation === 'WIDEN' && e.baselineRef?.objectId === DEMO_WIDENING_ROAD.objectId && e.section);
  const section = saved && saved.section.endMeasureM <= totalM + 0.5
    ? [saved.section.startMeasureM, saved.section.endMeasureM]
    : [0, Math.min(DEMO_WIDENING_ROAD.sectionM, totalM)];
  const widening = road && totalM > 10 ? {
    ...wideningElement({ road, startM: section[0], endM: section[1], totalWidthM: DEMO_WIDTH_M, laneCount: DEMO_LANES }),
    provenance: provenance(saved ? `Section reused from ${saved.id}` : 'Measured section of the county centreline'),
    domain: DESIGN_DOMAIN.ROAD_INFRASTRUCTURE,
  } : null;

  const link = roadsById && buildingsById ? generateNewRoad({ roadsById, buildingsById }) : null;
  const newRoad = link ? {
    id: 'demo-new-access-road',
    type: ELEMENT_TYPE.ROAD,
    changeType: CHANGE_TYPE.NEW,
    operation: 'CREATE',
    domain: DESIGN_DOMAIN.ROAD_INFRASTRUCTURE,
    geometry: { type: 'LineString', coordinates: link.points },
    properties: {
      name: 'New Terminal Access Road', widthM: DEMO_WIDTH_M, lanes: DEMO_LANES, roadType: 'ACCESS_ROAD',
      // Both ends were generated ON county centrelines, so both are network connections — and the
      // connectivity check still measures them rather than taking this at its word.
      startRole: 'ROAD_NETWORK_CONNECTION', endRole: 'ROAD_NETWORK_CONNECTION',
      connects: { start: link.start, end: link.end },
    },
    provenance: provenance(`Generated between ${link.start.name || link.start.objectId} and ${link.end.name || link.end.objectId}`),
  } : null;

  const realign = roadsById && buildingsById ? generateRealignment({ roadsById, buildingsById }) : null;
  const realignment = realign ? {
    id: `realign-${realign.road.objectId}-${realign.startM}`,
    type: ELEMENT_TYPE.ROAD,
    changeType: CHANGE_TYPE.MODIFIED,
    operation: 'REALIGN',
    domain: DESIGN_DOMAIN.ROAD_INFRASTRUCTURE,
    baselineRef: {
      kind: 'ROAD', source: 'MIAMI_DADE_ROADS', objectId: realign.road.objectId, name: realign.road.name ?? null,
    },
    section: {
      startMeasureM: realign.startM, endMeasureM: realign.endM,
      lengthM: centrelineLengthM(sectionBetweenMeasures(realign.road.coordinates, realign.startM, realign.endM).coordinates),
    },
    tieIns: { locked: true },
    geometry: { type: 'LineString', coordinates: realign.points },
    properties: {
      name: `${realign.road.name || `Road ${realign.road.objectId}`} — proposed realignment`,
      widthM: DEMO_WIDTH_M, lanes: DEMO_LANES, roadType: 'REALIGNMENT',
      startRole: 'ROAD_NETWORK_CONNECTION', endRole: 'ROAD_NETWORK_CONNECTION',
    },
    provenance: provenance('Middle section bowed sideways, tied in at both ends'),
  } : null;

  return {
    [DEMO_IDS.WIDENING]: demo({
      id: DEMO_IDS.WIDENING,
      name: 'Design A — Road Widening',
      purpose: DESIGN_PURPOSE.WIDENING,
      allowedOperation: 'WIDEN',
      description: 'Widen an existing access road.',
      elements: widening ? [widening] : [],
      limitation: widening ? 'Existing width and lanes are Unknown: the county file publishes neither.'
        : `${DEMO_WIDENING_ROAD.name} (OBJECTID ${DEMO_WIDENING_ROAD.objectId}) is not in the loaded road data, so no widening was added.`,
    }),
    [DEMO_IDS.NEW_ROAD]: demo({
      id: DEMO_IDS.NEW_ROAD,
      name: 'Design B — New Access Road',
      purpose: DESIGN_PURPOSE.NEW_ROAD,
      allowedOperation: 'CREATE',
      description: 'Create a new road connection.',
      elements: newRoad ? [newRoad] : [],
      limitation: newRoad ? 'Generated between two points on the county network; not an engineering alignment.'
        : 'No building-free link between two port roads was found in the loaded data. Draw one with Edit Design.',
    }),
    [DEMO_IDS.REALIGNMENT]: demo({
      id: DEMO_IDS.REALIGNMENT,
      name: 'Design C — Road Realignment',
      purpose: DESIGN_PURPOSE.REALIGNMENT,
      allowedOperation: 'REALIGN',
      description: 'Modify an existing road alignment.',
      elements: realignment ? [realignment] : [],
      limitation: realignment ? 'Generated: the section is bowed sideways and tied in at both ends. Conceptual only.'
        : 'No road section could be realigned clear of buildings in the loaded data. Create one with Edit Design.',
    }),
  };
}

export const isDemo = design => Boolean(design?.demoTemplate);

/** The primary alternatives, in card order. */
export const PRIMARY_IDS = Object.freeze([DEMO_IDS.WIDENING, DEMO_IDS.NEW_ROAD, DEMO_IDS.REALIGNMENT]);

/** The original road alternatives the demonstration set stands in front of. */
export const LEGACY_ROAD_IDS = Object.freeze(['road-design-a', 'road-design-b', 'road-design-c']);
