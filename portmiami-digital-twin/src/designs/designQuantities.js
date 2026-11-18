/**
 * What a design alternative MEASURES.
 *
 * Every figure here is computed from the design's own geometry at the moment it is asked for —
 * nothing is stored on the package and nothing is typed in. Change an element's width or drag a
 * vertex and the quantities move, because they are the same arithmetic run again.
 *
 * MEASURED AND ASSUMED ARE KEPT APART. Lengths, areas and counts come from geometry and are
 * reported as measured. Parking capacity does not: it is a target someone stated, or an estimate
 * from an area-per-space assumption, and the two are returned under different names so a screen
 * cannot show one as the other.
 */
import { ringAreaM2, roadQuantities } from './roadCorridor.js';
import { CHANGE_TYPE, ELEMENT_TYPE } from './designModel.js';
import { capacityFeasibility } from '../scenarios/garagePlacement.js';
import { wideningQuantities } from './roadWidening.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const sum = values => values.reduce((total, value) => total + (finite(value) ? value : 0), 0);

/** The outer ring of whatever geometry an element carries, or null. */
export function elementRing(element) {
  const geometry = element?.geometry;
  if (!geometry) return null;
  if (geometry.type === 'Polygon') return geometry.coordinates?.[0] ?? null;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates?.[0]?.[0] ?? null;
  return null;
}

/** Road operations that are counted on their own rather than as a plain new/modified road. */
export const ROAD_OPERATION = Object.freeze({
  CREATE: 'CREATE', WIDEN: 'WIDEN', REALIGN: 'REALIGN', CLOSE: 'CLOSE',
});

export const ROAD_OPERATION_LABEL = Object.freeze({
  CREATE: 'New road', WIDEN: 'Widening', REALIGN: 'Realignment', CLOSE: 'Closure',
  MODIFY: 'Modification',
});

/**
 * Which road operation an element represents.
 *
 * A declared `operation` wins. Older records — the shipped sketches, anything saved before the
 * four tools existed — carry only a change type, and a change type cannot tell a widening from a
 * realignment: both are MODIFIED. Rather than guess between them this returns the honest
 * `MODIFY`, so the map and the panel say "Modification" instead of asserting a tool that may
 * never have been used.
 */
export function roadOperationOf(element) {
  if (element?.type !== ELEMENT_TYPE.ROAD) return null;
  if (ROAD_OPERATION[element.operation]) return element.operation;
  if (element.changeType === CHANGE_TYPE.NEW) return ROAD_OPERATION.CREATE;
  if (element.changeType === CHANGE_TYPE.REMOVED) return ROAD_OPERATION.CLOSE;
  return 'MODIFY';
}

const isOperation = (element, operation) =>
  element?.type === ELEMENT_TYPE.ROAD && element?.operation === operation;

/** Is this element a widening proposal rather than a plain road? */
export const isWidening = element => isOperation(element, ROAD_OPERATION.WIDEN);
export const isRealignment = element => isOperation(element, ROAD_OPERATION.REALIGN);
export const isClosure = element => isOperation(element, ROAD_OPERATION.CLOSE);

/** One road element's measurements, or null when it is not a road with a drawable alignment. */
export function roadMeasure(element) {
  if (element?.type !== ELEMENT_TYPE.ROAD) return null;
  const coordinates = element.geometry?.type === 'LineString' ? element.geometry.coordinates : null;
  if (!coordinates) return null;
  return roadQuantities({
    coordinates,
    widthM: element.properties?.widthM,
    lanes: element.properties?.lanes,
  });
}

/**
 * A widening's own figures, computed from its stored parameters.
 *
 * The saved element carries the section and the proposal, not a frozen set of results, so this
 * recomputes from the geometry every time — the numbers in Compare and the numbers in the studio
 * are the same arithmetic and cannot drift.
 */
export function wideningMeasure(element) {
  if (!isWidening(element)) return null;
  const coordinates = element.geometry?.type === 'LineString' ? element.geometry.coordinates : null;
  if (!coordinates) return null;
  const proposal = element.proposal ?? {};
  return wideningQuantities({
    coordinates,
    totalWidthM: proposal.totalWidthM,
    laneCount: proposal.laneCount,
    side: proposal.wideningSide,
    baselineWidthM: proposal.baselineWidthM ?? null,
    baselineWidthSource: proposal.baselineWidthSource,
  });
}

/** One building-like element's measurements. */
export function buildingMeasure(element) {
  const ring = elementRing(element);
  if (!ring) return null;
  const footprintAreaM2 = ringAreaM2(ring);
  const floors = finite(element.properties?.floors) ? element.properties.floors : null;
  return {
    footprintAreaM2,
    floors,
    // A surface lot does not stack, so its "floor area" is its ground area.
    grossFloorAreaM2: element.type === ELEMENT_TYPE.SURFACE_PARKING
      ? footprintAreaM2
      : (floors === null ? null : footprintAreaM2 * floors),
    heightM: finite(element.properties?.floorHeightM) && floors !== null
      ? floors * element.properties.floorHeightM : null,
  };
}

const BUILDING_TYPES = new Set([
  ELEMENT_TYPE.BUILDING, ELEMENT_TYPE.PARKING_GARAGE,
  ELEMENT_TYPE.SURFACE_PARKING, ELEMENT_TYPE.TERMINAL,
]);

/**
 * Everything a design alternative adds up to.
 *
 * Roads are split by change type because "2 km of road" means three different things depending on
 * whether it is new, widened or being taken out, and adding them together would say none of them.
 */
export function designQuantities(design, { grossAreaPerSpaceM2 = 32 } = {}) {
  const elements = design?.elements ?? [];

  const roads = elements
    .filter(element => element.type === ELEMENT_TYPE.ROAD)
    .map(element => ({ element, measure: roadMeasure(element) }));
  // Widenings, realignments and closures are each counted on their own below; lumping them into
  // "modified road length" would say three different things with one number.
  const roadsOf = change => roads.filter(row => row.element.changeType === change
    && !isWidening(row.element) && !isRealignment(row.element) && !isClosure(row.element));
  const lengthOf = rows => sum(rows.map(row => row.measure?.lengthM));
  const areaOf = rows => sum(rows.map(row => row.measure?.surfaceAreaM2));

  const buildings = elements
    .filter(element => BUILDING_TYPES.has(element.type))
    .map(element => ({ element, measure: buildingMeasure(element) }));
  const buildingsOf = change => buildings.filter(row => row.element.changeType === change);

  // Parking: the stated target, and what the geometry would support at the stated assumption.
  const parking = elements.filter(element =>
    element.type === ELEMENT_TYPE.PARKING_GARAGE || element.type === ELEMENT_TYPE.SURFACE_PARKING);
  const targetSpaces = parking.some(element => finite(element.properties?.targetSpaces))
    ? sum(parking.map(element => element.properties?.targetSpaces))
    : null;
  const geometrySupported = parking.reduce((total, element) => {
    const measure = buildingMeasure(element);
    if (!measure || !finite(measure.grossFloorAreaM2)) return total;
    const feasibility = capacityFeasibility(
      { lengthM: 1, widthM: measure.grossFloorAreaM2, floors: 1, kind: 'BUILDING' },
      { targetSpaces: null, grossAreaPerSpaceM2 });
    return total === null
      ? feasibility.estimatedSpaces
      : total + (feasibility.estimatedSpaces ?? 0);
  }, null);

  /*
   * Widenings are counted SEPARATELY from other modified roads.
   *
   * A widening's length is the stretch being widened, and its area is a proposed corridor that
   * includes pavement which already exists. Adding it to "new road surface" would count existing
   * carriageway as something the design builds. Incremental pavement is summed only where every
   * widening in the design states a baseline width — one unknown makes the total unknowable, and
   * a partial sum would understate it.
   */
  const widenings = elements.filter(isWidening).map(element => ({
    element, measure: wideningMeasure(element),
  }));
  const incrementKnown = widenings.length > 0 && widenings.every(
    row => Number.isFinite(row.measure?.difference.incrementalPavementM2.value));

  /*
   * A REALIGNMENT replaces a stretch of road with a different line. Its proposed length is the
   * new alignment; the length it supersedes is the section it replaces, and the difference is
   * the figure a planner looks for. Where the superseded length is not recorded the difference
   * is null, not zero.
   */
  const realignments = elements.filter(isRealignment).map(element => ({
    element,
    proposedLengthM: roadMeasure(element)?.lengthM ?? null,
    supersededLengthM: Number.isFinite(element.section?.lengthM) ? element.section.lengthM : null,
  }));
  const supersededKnown = realignments.length > 0
    && realignments.every(row => Number.isFinite(row.supersededLengthM));

  /*
   * A CLOSURE removes a stretch from service. It carries no new geometry — the baseline segment
   * stays in the dataset and is simply marked — so its length comes from the section it covers.
   */
  const closures = elements.filter(isClosure).map(element => ({
    element,
    lengthM: Number.isFinite(element.section?.lengthM)
      ? element.section.lengthM : (roadMeasure(element)?.lengthM ?? null),
  }));

  return {
    designId: design?.id ?? null,
    realignment: {
      count: realignments.length,
      proposedLengthM: sum(realignments.map(row => row.proposedLengthM)),
      supersededLengthM: supersededKnown
        ? sum(realignments.map(row => row.supersededLengthM)) : null,
      netLengthChangeM: supersededKnown
        ? sum(realignments.map(row => row.proposedLengthM)) - sum(realignments.map(row => row.supersededLengthM))
        : null,
      roads: realignments.map(row => ({
        elementId: row.element.id,
        name: row.element.baselineRef?.name ?? row.element.properties?.name ?? row.element.id,
        objectId: row.element.baselineRef?.objectId ?? null,
        proposedLengthM: row.proposedLengthM,
        supersededLengthM: row.supersededLengthM,
      })),
    },
    closure: {
      count: closures.length,
      lengthM: sum(closures.map(row => row.lengthM)),
      roads: closures.map(row => ({
        elementId: row.element.id,
        name: row.element.baselineRef?.name ?? row.element.properties?.name ?? row.element.id,
        objectId: row.element.baselineRef?.objectId ?? null,
        lengthM: row.lengthM,
        reason: row.element.properties?.reason ?? null,
      })),
    },
    widening: {
      count: widenings.length,
      affectedLengthM: sum(widenings.map(row => row.measure?.proposed.affectedLengthM.value)),
      proposedCorridorAreaM2: sum(widenings.map(row => row.measure?.proposed.corridorAreaM2.value)),
      /** null, not zero, when any widening has no stated existing width. */
      incrementalPavementM2: incrementKnown
        ? sum(widenings.map(row => row.measure.difference.incrementalPavementM2.value))
        : null,
      /** The widest proposal in the design, for a like-for-like comparison between alternatives. */
      maxProposedWidthM: widenings.length
        ? Math.max(...widenings.map(row => row.measure?.proposed.totalWidthM.value ?? 0)) : null,
      maxProposedLanes: widenings.length
        ? Math.max(...widenings.map(row => row.measure?.proposed.lanes.value ?? 0)) : null,
      roads: widenings.map(row => ({
        elementId: row.element.id,
        name: row.element.baselineRef?.name ?? row.element.properties?.name ?? row.element.id,
        objectId: row.element.baselineRef?.objectId ?? null,
        widthM: row.measure?.proposed.totalWidthM.value ?? null,
        lanes: row.measure?.proposed.lanes.value ?? null,
        lengthM: row.measure?.proposed.affectedLengthM.value ?? null,
      })),
    },
    roads: {
      newLengthM: lengthOf(roadsOf(CHANGE_TYPE.NEW)),
      modifiedLengthM: lengthOf(roadsOf(CHANGE_TYPE.MODIFIED)),
      removedLengthM: lengthOf(roadsOf(CHANGE_TYPE.REMOVED)),
      newSurfaceAreaM2: areaOf(roadsOf(CHANGE_TYPE.NEW)),
      modifiedSurfaceAreaM2: areaOf(roadsOf(CHANGE_TYPE.MODIFIED)),
      count: roads.length,
      /** Lanes before and after, where both are stated. Null entries are not counted as zero. */
      laneChange: sum(roads.map(row => {
        const after = row.element.properties?.lanes;
        const before = row.element.properties?.baselineLanes;
        return finite(after) && finite(before) ? after - before : 0;
      })),
    },
    buildings: {
      newFootprintAreaM2: sum(buildingsOf(CHANGE_TYPE.NEW).map(row => row.measure?.footprintAreaM2)),
      modifiedFootprintAreaM2: sum(buildingsOf(CHANGE_TYPE.MODIFIED).map(row => row.measure?.footprintAreaM2)),
      addedGrossFloorAreaM2: sum(buildings.map(row => row.measure?.grossFloorAreaM2)),
      newCount: buildingsOf(CHANGE_TYPE.NEW).length,
      modifiedCount: buildingsOf(CHANGE_TYPE.MODIFIED).length,
    },
    parking: {
      /** STATED, not measured: the capacity the design asks for. */
      targetSpaces,
      /** ESTIMATED from geometry at the stated area-per-space assumption. */
      geometrySupportedSpaces: geometrySupported,
      grossAreaPerSpaceM2,
      difference: finite(targetSpaces) && finite(geometrySupported)
        ? geometrySupported - targetSpaces : null,
    },
    elementCount: elements.length,
  };
}

/**
 * Two designs side by side.
 *
 * Differences are computed per metric rather than by subtracting totals, so a metric missing on
 * one side comes back null instead of being read as a zero that favours the other.
 */
export function compareDesigns(left, right, options) {
  const a = designQuantities(left, options);
  const b = designQuantities(right, options);
  const delta = (x, y) => (finite(x) && finite(y) ? y - x : null);
  return {
    left: { id: left?.id ?? null, name: left?.name ?? null, quantities: a },
    right: { id: right?.id ?? null, name: right?.name ?? null, quantities: b },
    differences: {
      realignedLengthM: delta(a.realignment.proposedLengthM, b.realignment.proposedLengthM),
      netLengthChangeM: delta(a.realignment.netLengthChangeM, b.realignment.netLengthChangeM),
      closedLengthM: delta(a.closure.lengthM, b.closure.lengthM),
      newLengthM: delta(a.roads.newLengthM, b.roads.newLengthM),
      modifiedLengthM: delta(a.roads.modifiedLengthM, b.roads.modifiedLengthM),
      removedLengthM: delta(a.roads.removedLengthM, b.roads.removedLengthM),
      newSurfaceAreaM2: delta(a.roads.newSurfaceAreaM2, b.roads.newSurfaceAreaM2),
      wideningLengthM: delta(a.widening.affectedLengthM, b.widening.affectedLengthM),
      wideningCorridorAreaM2: delta(a.widening.proposedCorridorAreaM2, b.widening.proposedCorridorAreaM2),
      incrementalPavementM2: delta(a.widening.incrementalPavementM2, b.widening.incrementalPavementM2),
      maxProposedWidthM: delta(a.widening.maxProposedWidthM, b.widening.maxProposedWidthM),
      maxProposedLanes: delta(a.widening.maxProposedLanes, b.widening.maxProposedLanes),
      newFootprintAreaM2: delta(a.buildings.newFootprintAreaM2, b.buildings.newFootprintAreaM2),
      addedGrossFloorAreaM2: delta(a.buildings.addedGrossFloorAreaM2, b.buildings.addedGrossFloorAreaM2),
      targetSpaces: delta(a.parking.targetSpaces, b.parking.targetSpaces),
      geometrySupportedSpaces: delta(a.parking.geometrySupportedSpaces, b.parking.geometrySupportedSpaces),
    },
  };
}
