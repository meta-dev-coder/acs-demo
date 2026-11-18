/**
 * Does a proposed design run into anything, and does its road actually reach the network?
 *
 * TWO QUESTIONS, KEPT APART. A spatial conflict is geometry overlapping geometry. Connectivity is
 * whether a proposed road's ends meet the existing network. They have different answers and
 * different failure modes, so they are reported separately and neither is inferred from the other.
 *
 * A CROSSING IS NOT A CONFLICT. A proposed road crossing an existing road is usually an
 * intersection — the thing a road is for. So road-on-road is reported as an EXPECTED CONNECTION
 * where it happens at or near an end of the proposed alignment, and as a POTENTIAL CONFLICT only
 * where a proposed road runs along or through another without meeting it. Neither is called a
 * fault; both are prompts to go and look.
 *
 * ABSENCE IS NOT CLEARANCE. Parcels, ownership, zoning, utilities, right-of-way, environmental
 * designations and grade separation are not in this twin. They come back NOT_EVALUATED — which is
 * a different statement from CLEAR, and is kept visibly different everywhere it is shown.
 */
import { lonLatToEnu } from '../scenarios/garagePlacement.js';
import {
  distanceToSegment, lineNearRing, pointInRing, ringsOverlap, segmentsCross,
} from '../scenarios/siteConflicts.js';
import { CHANGE_TYPE, ELEMENT_TYPE } from './designModel.js';
import { elementRing, roadMeasure } from './designQuantities.js';
import { roadCorridorRing } from './roadCorridor.js';

export const FINDING = Object.freeze({
  CONFLICT: 'CONFLICT',
  EXPECTED: 'EXPECTED',
  CLEAR: 'CLEAR',
  NOT_EVALUATED: 'NOT_EVALUATED',
});

export const CONNECTIVITY = Object.freeze({
  CONNECTED: 'CONNECTED',
  POTENTIAL: 'POTENTIAL',
  DISCONNECTED: 'DISCONNECTED',
  NOT_EVALUATED: 'NOT_EVALUATED',
});

/**
 * What an alignment's end is FOR.
 *
 * An access road has two different kinds of end and judging both against the road network was
 * wrong: the garage end is supposed to stop at the building, so measuring its distance to a
 * centreline reported a correct design as "potentially disconnected". The role says which test
 * applies, and an unclassified end is tested against the network because that is the safer
 * assumption — it reports a problem that might not be one, rather than hiding one that is.
 */
export const ENDPOINT_ROLE = Object.freeze({
  ROAD_NETWORK_CONNECTION: 'ROAD_NETWORK_CONNECTION',
  FACILITY_ENTRANCE: 'FACILITY_ENTRANCE',
  DEAD_END: 'DEAD_END',
  FUTURE_CONNECTION: 'FUTURE_CONNECTION',
  UNCLASSIFIED: 'UNCLASSIFIED',
});

export const ENDPOINT_ROLE_LABEL = Object.freeze({
  ROAD_NETWORK_CONNECTION: 'Road network connection',
  FACILITY_ENTRANCE: 'Facility entrance',
  DEAD_END: 'Dead end',
  FUTURE_CONNECTION: 'Future connection',
  UNCLASSIFIED: 'Unclassified',
});

/**
 * How close a facility end must come to a DESIGNATED entrance point to count as meeting it.
 *
 * ASSUMED, and deliberately tight: an entrance is a specific place on a building, not the
 * building. Ending anywhere inside a 75 m footprint is not arriving at its entrance.
 */
export const ENTRANCE_TOLERANCE_M = 12;

/**
 * How close a proposed road's end must come to an existing centreline to count as connected.
 *
 * ASSUMED. The centreline file publishes no carriageway width, so "touching the road" has to be a
 * tolerance rather than a measurement. 8 m is about half a two-lane carriageway: close enough
 * that the ends are meeting the road rather than its verge.
 */
export const CONNECT_TOLERANCE_M = 8;

/** Beyond this an end is simply not near the network; between the two it is a maybe. */
export const POTENTIAL_TOLERANCE_M = 40;

const finite = value => typeof value === 'number' && Number.isFinite(value);

/** Everything a design draws on the ground, as rings in one local frame. */
function footprintsOf(design) {
  const shapes = [];
  for (const element of design?.elements ?? []) {
    if (element.changeType === CHANGE_TYPE.REMOVED) continue;
    if (element.type === ELEMENT_TYPE.ROAD) {
      const ring = element.geometry?.type === 'LineString'
        ? roadCorridorRing(element.geometry.coordinates, element.properties?.widthM) : null;
      if (ring) shapes.push({ element, ring, isRoad: true });
      continue;
    }
    const ring = elementRing(element);
    if (ring) shapes.push({ element, ring, isRoad: false });
  }
  return shapes;
}

const finding = (id, label, status, detail, hits = []) => ({ id, label, status, detail, hits });

/**
 * Check one design against the baseline and against itself.
 *
 * @param {object} design
 * @param {object} layers
 * @param {Array|null} layers.buildings  county building records, or null if not loaded
 * @param {Array|null} layers.roads      road segments with `coordinates`, or null if not loaded
 */
export function validateDesignSpatially(design, { buildings = null, roads = null } = {}) {
  const shapes = footprintsOf(design);
  const findings = [];

  if (shapes.length === 0) {
    findings.push(finding('empty', 'Proposed geometry', FINDING.NOT_EVALUATED,
      'This alternative proposes no geometry on the ground, so there is nothing to test.'));
  }

  // ---- proposed against existing buildings ----------------------------------------------------
  if (!Array.isArray(buildings)) {
    findings.push(finding('buildings', 'Existing buildings', FINDING.NOT_EVALUATED,
      'The county building-footprint layer has not loaded, so no overlap could be tested.'));
  } else {
    const hits = [], onItsOwnSite = [];
    for (const shape of shapes) {
      const origin = shape.ring[0];
      const local = shape.ring.map(point => lonLatToEnu(origin, point));
      // The baseline feature this element DECLARES it replaces. Overlapping the thing you said
      // you are replacing is the proposal, not a collision — a garage proposed on an existing
      // surface lot necessarily covers it.
      const replaces = shape.element.baselineRef?.kind === 'BUILDING'
        ? shape.element.baselineRef.objectId : null;
      for (const building of buildings) {
        const rings = Array.isArray(building.rings) ? building.rings : [];
        for (const outer of rings) {
          if (!Array.isArray(outer) || outer.length < 4) continue;
          const other = outer.map(point => lonLatToEnu(origin, point));
          // A cheap reject first: anything over 400 m away cannot touch this shape.
          if (other.every(([x, y]) => Math.hypot(x, y) > 400)) continue;
          if (ringsOverlap(local, other)) {
            (building.objectId === replaces ? onItsOwnSite : hits)
              .push({ element: shape.element.id, objectId: building.objectId });
            break;
          }
        }
      }
    }
    if (onItsOwnSite.length) {
      findings.push(finding('site-replaced', 'Proposed on an existing site', FINDING.EXPECTED,
        `${onItsOwnSite.length} proposed element${onItsOwnSite.length === 1 ? '' : 's'} cover the `
        + `baseline feature they name as their site `
        + `(${onItsOwnSite.map(h => `${h.element} \u2192 OBJECTID ${h.objectId}`).join('; ')}). `
        + 'Replacing what it declares it replaces is the proposal, not a collision.', onItsOwnSite));
    }
    findings.push(hits.length
      ? finding('buildings', 'Existing buildings', FINDING.CONFLICT,
        `${hits.length} proposed element${hits.length === 1 ? '' : 's'} overlap an existing `
        + `building footprint (${hits.slice(0, 4).map(h => `${h.element} → OBJECTID ${h.objectId}`).join('; ')}`
        + `${hits.length > 4 ? '; …' : ''}).`, hits)
      : finding('buildings', 'Existing buildings', FINDING.CLEAR,
        'No proposed element overlaps a county building footprint.'));
  }

  // ---- proposed roads against the existing network ----------------------------------------------
  if (!Array.isArray(roads)) {
    findings.push(finding('roads', 'Existing road network', FINDING.NOT_EVALUATED,
      'The county road-centreline layer has not loaded, so no interaction could be tested.'));
  } else {
    const crossings = [], along = [];
    for (const shape of shapes.filter(s => s.isRoad)) {
      const centreline = shape.element.geometry.coordinates;
      const origin = centreline[0];
      const localLine = centreline.map(point => lonLatToEnu(origin, point));
      const corridor = shape.ring.map(point => lonLatToEnu(origin, point));
      const endIndices = [0, localLine.length - 1];
      for (const road of roads) {
        const other = (road.coordinates ?? []).map(point => lonLatToEnu(origin, point));
        if (other.length < 2) continue;
        if (other.every(([x, y]) => Math.hypot(x, y) > 800)) continue;
        let crossed = false, nearEnd = false;
        for (let i = 0; i < localLine.length - 1 && !crossed; i += 1) {
          for (let j = 0; j < other.length - 1; j += 1) {
            if (segmentsCross(localLine[i], localLine[i + 1], other[j], other[j + 1])) {
              crossed = true;
              // A crossing AT an end of the proposed road is the junction it was drawn to make.
              if (endIndices.includes(i) || endIndices.includes(i + 1)) nearEnd = true;
              break;
            }
          }
        }
        if (!crossed) continue;
        // Does the existing road run THROUGH the corridor for a distance, rather than across it?
        const inside = other.filter(point => pointInRing(point, corridor)).length;
        if (nearEnd || inside <= 1) {
          along.push({ element: shape.element.id, road: road.name || `Unnamed road · ${road.objectId}` });
        } else {
          crossings.push({ element: shape.element.id, road: road.name || `Unnamed road · ${road.objectId}` });
        }
      }
    }
    if (crossings.length) {
      findings.push(finding('road-overlap', 'Proposed road over existing road', FINDING.CONFLICT,
        `A proposed alignment runs along ${crossings.length} existing centreline`
        + `${crossings.length === 1 ? '' : 's'} rather than crossing it `
        + `(${[...new Set(crossings.map(c => c.road))].slice(0, 4).join(', ')}). `
        + 'Worth checking whether a realignment was intended.', crossings));
    }
    if (along.length) {
      findings.push(finding('road-junction', 'Road junctions', FINDING.EXPECTED,
        `${along.length} junction${along.length === 1 ? '' : 's'} with the existing network `
        + `(${[...new Set(along.map(a => a.road))].slice(0, 4).join(', ')}). `
        + 'A crossing at an alignment end reads as an intended junction, not a conflict.', along));
    }
    if (!crossings.length && !along.length) {
      findings.push(finding('road-junction', 'Road junctions', FINDING.CLEAR,
        'No proposed alignment meets an existing centreline.'));
    }

    // Non-road elements sitting on a carriageway.
    const onRoad = [];
    for (const shape of shapes.filter(s => !s.isRoad)) {
      const origin = shape.ring[0];
      const ring = shape.ring.map(point => lonLatToEnu(origin, point));
      for (const road of roads) {
        const other = (road.coordinates ?? []).map(point => lonLatToEnu(origin, point));
        if (other.length < 2 || other.every(([x, y]) => Math.hypot(x, y) > 600)) continue;
        if (lineNearRing(other, ring, 0)) {
          onRoad.push({ element: shape.element.id, road: road.name || `Unnamed road · ${road.objectId}` });
          break;
        }
      }
    }
    if (onRoad.length) {
      findings.push(finding('building-on-road', 'Proposed building over a road', FINDING.CONFLICT,
        `${onRoad.length} proposed structure${onRoad.length === 1 ? '' : 's'} sit over an existing `
        + `centreline (${[...new Set(onRoad.map(o => o.road))].slice(0, 3).join(', ')}).`, onRoad));
    }
  }

  // ---- proposed against proposed ----------------------------------------------------------------
  /*
   * A proposed access road MEETING the garage it serves is the point of drawing it, so a road
   * whose END lies in a proposed building is an expected connection. A road that runs THROUGH one
   * — more than an end inside it — is not, and that is what gets reported.
   */
  const selfHits = [], selfExpected = [];
  for (let i = 0; i < shapes.length; i += 1) {
    for (let j = i + 1; j < shapes.length; j += 1) {
      // Two roads meeting is a junction, handled with the network above.
      if (shapes[i].isRoad && shapes[j].isRoad) continue;
      const origin = shapes[i].ring[0];
      const a = shapes[i].ring.map(point => lonLatToEnu(origin, point));
      const b = shapes[j].ring.map(point => lonLatToEnu(origin, point));
      if (!ringsOverlap(a, b)) continue;
      const road = shapes[i].isRoad ? shapes[i] : (shapes[j].isRoad ? shapes[j] : null);
      const building = road === shapes[i] ? shapes[j] : shapes[i];
      if (road) {
        const ring = building.ring.map(point => lonLatToEnu(origin, point));
        const centreline = road.element.geometry.coordinates.map(point => lonLatToEnu(origin, point));
        /*
         * EXACTLY ONE END INSIDE means the alignment terminates at the structure — the access
         * road arriving at the garage it serves. Both ends outside with the middle inside is a
         * road running THROUGH the building; both ends inside is a road buried in it. Counting
         * interior vertices instead was too strict: a road that enters and stops has several
         * vertices inside, and that is the normal case, not a fault.
         */
        const endsInside = [centreline[0], centreline[centreline.length - 1]]
          .filter(point => pointInRing(point, ring)).length;
        if (endsInside === 1) {
          selfExpected.push([road.element.id, building.element.id]);
          continue;
        }
      }
      selfHits.push([shapes[i].element.id, shapes[j].element.id]);
    }
  }
  if (selfExpected.length) {
    findings.push(finding('self-served', 'Proposed road serving a proposed building', FINDING.EXPECTED,
      `${selfExpected.length} proposed road${selfExpected.length === 1 ? '' : 's'} end at the `
      + `structure they serve (${selfExpected.map(pair => pair.join(' \u2192 ')).join('; ')}). `
      + 'An alignment ending inside the building it serves reads as the connection it was drawn '
      + 'to make, not an overlap.', selfExpected));
  }
  findings.push(selfHits.length
    ? finding('self', 'Within this alternative', FINDING.CONFLICT,
      `${selfHits.length} pair${selfHits.length === 1 ? '' : 's'} of proposed elements overlap `
      + `(${selfHits.slice(0, 3).map(pair => pair.join(' ↔ ')).join('; ')}).`, selfHits)
    : finding('self', 'Within this alternative', FINDING.CLEAR,
      'No two proposed elements overlap each other.'));

  // ---- what this twin simply does not hold --------------------------------------------------------
  for (const [id, label, detail] of [
    ['parcels', 'Parcels and right-of-way', 'Not evaluated. No parcel or right-of-way layer is '
      + 'loaded, so whether a proposal sits on developable land is unknown.'],
    ['utilities', 'Utilities', 'Not evaluated. No utility network is loaded.'],
    ['environment', 'Environmental designations', 'Not evaluated. None are loaded.'],
    ['grade', 'Grade separation', 'Not evaluated. The road file carries no elevation, so a '
      + 'crossing cannot be told from a bridge over or a tunnel under.'],
  ]) {
    findings.push(finding(id, label, FINDING.NOT_EVALUATED, detail));
  }

  return {
    findings,
    conflicts: findings.filter(f => f.status === FINDING.CONFLICT).length,
    evaluated: findings.filter(f => f.status !== FINDING.NOT_EVALUATED).length,
  };
}

/**
 * Does each proposed road reach the existing network?
 *
 * Both ends are tested, because a road connected at one end and floating at the other is not a
 * connection — it is a cul-de-sac somebody did not mean to draw.
 */
export function validateConnectivity(design, { roads = null } = {}) {
  const proposed = (design?.elements ?? []).filter(element =>
    element.type === ELEMENT_TYPE.ROAD
    && element.changeType !== CHANGE_TYPE.REMOVED
    && element.geometry?.type === 'LineString');

  if (!Array.isArray(roads)) {
    return proposed.map(element => ({
      elementId: element.id, name: element.properties?.name ?? element.id,
      status: CONNECTIVITY.NOT_EVALUATED, ends: [],
      detail: 'The county road-centreline layer has not loaded, so connectivity was not tested.',
    }));
  }

  /** Entrance points any element in this design declares, as [lon, lat]. */
  const entrances = new Map();
  for (const element of design?.elements ?? []) {
    const point = element.properties?.accessPoint;
    if (Array.isArray(point) && point.length === 2) entrances.set(element.id, point);
  }

  return proposed.map(element => {
    const centreline = element.geometry.coordinates;
    const measure = roadMeasure(element);
    /** Declared roles, start then end. Anything not stated is UNCLASSIFIED. */
    const roles = [
      element.properties?.startRole ?? ENDPOINT_ROLE.UNCLASSIFIED,
      element.properties?.endRole ?? ENDPOINT_ROLE.UNCLASSIFIED,
    ];
    const servesId = element.properties?.servesElementId ?? null;
    const ends = [centreline[0], centreline[centreline.length - 1]].map((end, index) => {
      let nearest = Infinity, nearestRoad = null, nearestObjectId = null;
      for (const road of roads) {
        const points = (road.coordinates ?? []).map(point => lonLatToEnu(end, point));
        if (points.length < 2) continue;
        if (points.every(([x, y]) => Math.hypot(x, y) > 500)) continue;
        for (let i = 0; i < points.length - 1; i += 1) {
          const distance = distanceToSegment([0, 0], points[i], points[i + 1]);
          if (distance < nearest) {
            nearest = distance;
            nearestRoad = road.name || `Unnamed road · ${road.objectId}`;
            nearestObjectId = road.objectId;
          }
        }
      }
      const role = roles[index];
      const networkStatus = !finite(nearest) || nearest === Infinity ? CONNECTIVITY.DISCONNECTED
        : nearest <= CONNECT_TOLERANCE_M ? CONNECTIVITY.CONNECTED
          : nearest <= POTENTIAL_TOLERANCE_M ? CONNECTIVITY.POTENTIAL
            : CONNECTIVITY.DISCONNECTED;

      const base = {
        end: index === 0 ? 'start' : 'end',
        role,
        nearestRoad,
        nearestObjectId,
        distanceM: nearest === Infinity ? null : Math.round(nearest * 10) / 10,
      };

      if (role === ENDPOINT_ROLE.FACILITY_ENTRANCE) {
        // Tested against a DECLARED entrance point, never against the footprint. A road ending
        // inside a garage is not evidence that the garage has an entrance there.
        const entrance = servesId ? entrances.get(servesId) : null;
        if (!entrance) {
          return { ...base, status: CONNECTIVITY.NOT_EVALUATED, entranceDistanceM: null,
            detail: 'This end is a facility entrance, but the facility declares no access point, '
              + 'so there is nothing to test it against.' };
        }
        const [east, north] = lonLatToEnu(end, entrance);
        const distance = Math.hypot(east, north);
        return {
          ...base,
          entranceDistanceM: Math.round(distance * 10) / 10,
          status: distance <= ENTRANCE_TOLERANCE_M ? CONNECTIVITY.CONNECTED
            : distance <= ENTRANCE_TOLERANCE_M * 3 ? CONNECTIVITY.POTENTIAL
              : CONNECTIVITY.DISCONNECTED,
          detail: `${Math.round(distance)} m from the declared access point.`,
        };
      }
      if (role === ENDPOINT_ROLE.DEAD_END || role === ENDPOINT_ROLE.FUTURE_CONNECTION) {
        // Neither is a defect. A dead end is finished; a future connection is declared unfinished.
        return { ...base, status: CONNECTIVITY.NOT_EVALUATED,
          detail: role === ENDPOINT_ROLE.DEAD_END
            ? 'Declared a dead end, so no connection is expected here.'
            : 'Declared a future connection, so none is expected in this alternative.' };
      }
      return { ...base, status: networkStatus };
    });

    /*
     * TWO STATUSES, NOT ONE.
     *
     * `geometricStatus` is the worst of the ends that were actually tested — whether the geometry
     * meets what it was supposed to meet. `functionalStatus` asks the different question: does
     * this alignment do its job? An access road does when its network end is connected AND its
     * facility end reaches a declared entrance. Ends that are not expected to connect (a dead
     * end, a future connection, a facility end with no declared entrance) are excluded from the
     * geometric reading rather than counted as failures.
     */
    const order = [CONNECTIVITY.DISCONNECTED, CONNECTIVITY.POTENTIAL, CONNECTIVITY.CONNECTED];
    const tested = ends.filter(end => end.status !== CONNECTIVITY.NOT_EVALUATED);
    const geometricStatus = tested.length === 0 ? CONNECTIVITY.NOT_EVALUATED : tested.reduce(
      (worst, end) => (order.indexOf(end.status) < order.indexOf(worst) ? end.status : worst),
      CONNECTIVITY.CONNECTED);

    const networkEnd = ends.find(end => end.role === ENDPOINT_ROLE.ROAD_NETWORK_CONNECTION);
    const facilityEnd = ends.find(end => end.role === ENDPOINT_ROLE.FACILITY_ENTRANCE);
    const functionalStatus = (() => {
      if (!networkEnd && !facilityEnd) return CONNECTIVITY.NOT_EVALUATED;
      if (networkEnd && networkEnd.status !== CONNECTIVITY.CONNECTED) return networkEnd.status;
      if (facilityEnd && facilityEnd.status !== CONNECTIVITY.CONNECTED) return facilityEnd.status;
      return CONNECTIVITY.CONNECTED;
    })();

    const unclassified = ends.filter(end => end.role === ENDPOINT_ROLE.UNCLASSIFIED).length;

    return {
      elementId: element.id,
      name: element.properties?.name ?? element.id,
      lengthM: measure?.lengthM ?? null,
      status: geometricStatus,
      geometricStatus,
      functionalStatus,
      ends,
      detail: (() => {
        if (functionalStatus === CONNECTIVITY.CONNECTED) {
          return 'Network end on an existing centreline and facility end at the declared access '
            + 'point. Geometric proximity only — no grade separation, turning movement or '
            + 'operational capacity has been checked.';
        }
        if (unclassified > 0) {
          return `${unclassified} end${unclassified === 1 ? ' is' : 's are'} unclassified, so `
            + `${unclassified === 1 ? 'it is' : 'they are'} tested against the road network. Give `
            + 'each end a role to say what it is meant to meet.';
        }
        if (geometricStatus === CONNECTIVITY.POTENTIAL) {
          return `An end is within ${POTENTIAL_TOLERANCE_M} m of what it should meet but not on `
            + 'it. It may need snapping, or a junction may be intended that this geometry does '
            + 'not yet make.';
        }
        if (geometricStatus === CONNECTIVITY.DISCONNECTED) {
          return 'An end does not reach what it was meant to meet. As drawn, this alignment does '
            + 'not connect.';
        }
        return 'No end of this alignment is expected to connect, so nothing was tested.';
      })(),
    };
  });
}
