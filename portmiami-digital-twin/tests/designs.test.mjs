/**
 * Design alternatives: the model, the quantities, the validation.
 *
 * Two properties matter more than the rest and are tested from both sides. The baseline must stay
 * immutable — a design is changes AGAINST it, never a copy of it. And absence must never read as
 * clearance: a layer that has not loaded comes back NOT_EVALUATED, not CLEAR.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASELINE_ID, CHANGE_TYPE, DESIGN_SOURCE, ELEMENT_TYPE, SYNTHETIC_LABEL, VERIFICATION,
  baselineDesign, baselineRefs, createDesign, elementsOfChange, elementsOfType, inStudyArea,
  isBaseline, validateDesign,
} from '../src/designs/designModel.js';
import { compareDesigns, designQuantities, roadMeasure } from '../src/designs/designQuantities.js';
import {
  CONNECTIVITY, ENDPOINT_ROLE, FINDING, validateConnectivity, validateDesignSpatially,
} from '../src/designs/designValidation.js';
import { ANCHORS, designA, designB, designC, syntheticDesigns } from '../src/designs/syntheticDesigns.js';
import { enuToLonLat } from '../src/scenarios/garagePlacement.js';

const at = (anchor, east, north) => enuToLonLat(anchor, east, north);

// ---- the model -----------------------------------------------------------------------------------

test('the baseline is a design package with no elements', () => {
  const baseline = baselineDesign();
  assert.equal(isBaseline(baseline), true);
  assert.equal(baseline.id, BASELINE_ID);
  assert.deepEqual(baseline.elements, []);
  assert.equal(validateDesign(baseline).ok, true);
});

test('the three synthetic alternatives are valid and say what they are', () => {
  for (const design of syntheticDesigns()) {
    const check = validateDesign(design);
    assert.equal(check.ok, true, `${design.id}: ${check.errors.join(' | ')}`);
    assert.equal(design.source, DESIGN_SOURCE.SYNTHETIC_DEMO);
    assert.equal(design.verificationStatus, VERIFICATION.CONCEPTUAL,
      'a synthetic sketch is never APPROVED');
    assert.ok(design.elements.length > 0);
  }
  assert.match(SYNTHETIC_LABEL, /Not an Approved Engineering Proposal/);
});

test('a design never carries a copy of the baseline', () => {
  // Design A changes a registered garage; it references the asset and holds no footprint.
  const [garage] = elementsOfType(designA(), ELEMENT_TYPE.PARKING_GARAGE);
  assert.equal(garage.changeType, CHANGE_TYPE.MODIFIED);
  assert.equal(garage.geometry, null, 'the footprint stays with the asset');
  assert.deepEqual(garage.baselineRef, { kind: 'ASSET', assetId: 'parking-garage-k' });
  assert.deepEqual([...baselineRefs(designA()).assets], ['parking-garage-k']);
});

test('a MODIFIED or REMOVED element must name what it changes', () => {
  const bad = createDesign({
    id: 'x', name: 'x',
    elements: [{ id: 'x-1', type: ELEMENT_TYPE.ROAD, changeType: CHANGE_TYPE.REMOVED }],
  });
  const check = validateDesign(bad);
  assert.equal(check.ok, false);
  assert.ok(check.errors.some(e => /names no baseline feature/.test(e)), check.errors.join(' | '));
});

test('duplicate element ids are refused', () => {
  const bad = createDesign({
    id: 'x', name: 'x',
    elements: [
      { id: 'dup', type: ELEMENT_TYPE.BUILDING, changeType: CHANGE_TYPE.NEW },
      { id: 'dup', type: ELEMENT_TYPE.BUILDING, changeType: CHANGE_TYPE.NEW },
    ],
  });
  assert.ok(validateDesign(bad).errors.some(e => /Duplicate element id/.test(e)));
});

test('unreferenced CAD coordinates are not silently accepted as degrees', () => {
  const cad = createDesign({
    id: 'x', name: 'x',
    elements: [{
      id: 'x-1', type: ELEMENT_TYPE.ROAD, changeType: CHANGE_TYPE.NEW,
      geometry: { type: 'LineString', coordinates: [[912345.6, 528431.2], [912500, 528600]] },
      properties: { widthM: 7 },
    }],
  });
  const check = validateDesign(cad);
  assert.equal(check.ok, false);
  assert.ok(check.errors.some(e => /outside the PortMiami study area/.test(e)), check.errors.join(' | '));
});

test('a projected CRS is refused rather than read as degrees', () => {
  const projected = createDesign({ id: 'x', name: 'x', crs: 'EPSG:2236' });
  assert.ok(validateDesign(projected).errors.some(e => /EPSG:4326 only/.test(e)));
});

test('swapped latitude and longitude are named as such', () => {
  const swapped = createDesign({
    id: 'x', name: 'x',
    elements: [{
      id: 'x-1', type: ELEMENT_TYPE.BUILDING, changeType: CHANGE_TYPE.NEW,
      geometry: { type: 'Polygon', coordinates: [[[25.77, -80.17], [25.78, -80.17], [25.78, -80.16], [25.77, -80.17]]] },
    }],
  });
  assert.ok(validateDesign(swapped).errors.some(e => /longitude first/.test(e)));
});

test('a road with no width warns rather than silently drawing nothing', () => {
  const noWidth = createDesign({
    id: 'x', name: 'x',
    elements: [{
      id: 'x-1', type: ELEMENT_TYPE.ROAD, changeType: CHANGE_TYPE.NEW,
      geometry: { type: 'LineString', coordinates: [at(ANCHORS.southLot, 0, 0), at(ANCHORS.southLot, 100, 0)] },
      properties: {},
    }],
  });
  const check = validateDesign(noWidth);
  assert.equal(check.ok, true, 'it is a warning, not a blocker');
  assert.ok(check.warnings.some(w => /states no width/.test(w)));
});

test('the study-area test accepts the port and rejects elsewhere', () => {
  assert.equal(inStudyArea(ANCHORS.southLot), true);
  assert.equal(inStudyArea([-0.12, 51.5]), false);
  assert.equal(inStudyArea([]), false);
});

// ---- quantities -----------------------------------------------------------------------------------

test('the baseline measures nothing, rather than reporting zeros as findings', () => {
  const q = designQuantities(baselineDesign());
  assert.equal(q.elementCount, 0);
  assert.equal(q.roads.newLengthM, 0);
  assert.equal(q.parking.targetSpaces, null, 'no target is stated, so none is reported');
});

test("Design B's road is measured from its geometry, not stated", () => {
  const road = designB().elements.find(e => e.type === ELEMENT_TYPE.ROAD);
  const measure = roadMeasure(road);
  // The alignment is laid out in metres; its length is the sum of its segments.
  // A short connector from the garage entrance to the Port Blvd centreline.
  assert.ok(measure.lengthM > 15 && measure.lengthM < 400, `${measure.lengthM} m`);
  assert.equal(measure.widthM, 7.5);
  assert.equal(measure.lanes, 2);
  assert.equal(measure.areaBasis, 'CORRIDOR_POLYGON');
  assert.ok(Math.abs(measure.surfaceAreaM2 - measure.lengthM * 7.5) < measure.lengthM * 0.1);
});

test("Design B's garage is measured, and its target is reported as a target", () => {
  const q = designQuantities(designB());
  assert.ok(Math.abs(q.buildings.newFootprintAreaM2 - 75 * 42) < 40, `${q.buildings.newFootprintAreaM2}`);
  assert.ok(Math.abs(q.buildings.addedGrossFloorAreaM2 - 75 * 42 * 6) < 250);
  assert.equal(q.parking.targetSpaces, 2000, 'stated');
  assert.ok(q.parking.geometrySupportedSpaces > 0, 'estimated from geometry');
  assert.notEqual(q.parking.targetSpaces, q.parking.geometrySupportedSpaces,
    'the two are different claims and are kept apart');
});

test('roads are split by change type, never summed into one number', () => {
  const b = designQuantities(designB());
  assert.ok(b.roads.newLengthM > 0);
  assert.equal(b.roads.modifiedLengthM, 0);
  const c = designQuantities(designC());
  assert.equal(c.roads.newLengthM, 0, 'Design C widens; it adds nothing');
  assert.ok(c.roads.modifiedLengthM > 0);
});

test('Design C proposes no structure, so it adds no storeys', () => {
  const c = designC();
  assert.equal(elementsOfType(c, ELEMENT_TYPE.PARKING_GARAGE).length, 0);
  const surface = elementsOfType(c, ELEMENT_TYPE.SURFACE_PARKING)[0];
  assert.equal(surface.properties.floors, undefined, 'a lot has no floors');
  const q = designQuantities(c);
  // Its "floor area" is its ground area: a lot does not stack.
  assert.ok(Math.abs(q.buildings.addedGrossFloorAreaM2 - 210 * 96) < 200);
});

test('a lane change is only counted where both before and after are stated', () => {
  assert.equal(designQuantities(designC()).roads.laneChange, 1, '2 lanes to 3');
  assert.equal(designQuantities(designB()).roads.laneChange, 0, 'a new road replaces nothing');
});

test('comparing two designs reports per-metric differences, not subtracted totals', () => {
  const result = compareDesigns(designA(), designB());
  assert.equal(result.left.id, 'design-a');
  assert.equal(result.right.id, 'design-b');
  assert.ok(result.differences.newLengthM > 0, 'B adds road, A does not');
  assert.equal(result.differences.targetSpaces, 1000, '2,000 against 1,000');
});

test('a metric missing on one side compares as null, never as a zero that favours the other', () => {
  const empty = createDesign({ id: 'empty', name: 'Empty' });
  const result = compareDesigns(empty, designB());
  assert.equal(result.differences.targetSpaces, null,
    'the empty design states no target, so there is no difference to report');
});

// ---- spatial validation ---------------------------------------------------------------------------

test('a layer that has not loaded is Not evaluated, never clear', () => {
  const report = validateDesignSpatially(designB(), { buildings: null, roads: null });
  const byId = Object.fromEntries(report.findings.map(f => [f.id, f]));
  assert.equal(byId.buildings.status, FINDING.NOT_EVALUATED);
  assert.equal(byId.roads.status, FINDING.NOT_EVALUATED);
  assert.equal(report.conflicts, 0,
    `nothing is claimed as a conflict either: ${report.findings.filter(f => f.status === FINDING.CONFLICT).map(f => f.id)}`);
});

test('what this twin does not hold is always stated, even when everything loaded is clear', () => {
  const report = validateDesignSpatially(designB(), { buildings: [], roads: [] });
  const byId = Object.fromEntries(report.findings.map(f => [f.id, f]));
  for (const id of ['parcels', 'utilities', 'environment', 'grade']) {
    assert.equal(byId[id].status, FINDING.NOT_EVALUATED, id);
  }
});

test('a proposed garage over an existing building is a conflict, named by OBJECTID', () => {
  const garage = designB().elements.find(e => e.type === ELEMENT_TYPE.PARKING_GARAGE);
  const ring = garage.geometry.coordinates[0];
  const building = { objectId: 424242, rings: [ring] };   // exactly under the proposal
  const report = validateDesignSpatially(designB(), { buildings: [building], roads: [] });
  const buildings = report.findings.find(f => f.id === 'buildings');
  assert.equal(buildings.status, FINDING.CONFLICT);
  assert.match(buildings.detail, /424242/);
});

test('a road crossing an existing road at its end is an expected junction, not a conflict', () => {
  const road = designB().elements.find(e => e.type === ELEMENT_TYPE.ROAD);
  const end = road.geometry.coordinates[road.geometry.coordinates.length - 1];
  // An existing centreline running across the proposed road's far end.
  // Short on purpose: long enough to cross the alignment's end, not so long that it also runs
  // under the proposed garage — that would be a different finding, tested separately below.
  const crossing = {
    objectId: 1, name: 'PORT BLVD',
    coordinates: [enuToLonLat(end, -12, 12), enuToLonLat(end, 12, -12)],
  };
  const report = validateDesignSpatially(designB(), { buildings: [], roads: [crossing] });
  const junction = report.findings.find(f => f.id === 'road-junction');
  assert.equal(junction.status, FINDING.EXPECTED, junction.detail);
  assert.match(junction.detail, /PORT BLVD/);
  assert.equal(report.conflicts, 0, 'a junction is not a fault');
});

test('two proposed elements overlapping each other is reported', () => {
  const design = designB();
  const garage = design.elements.find(e => e.type === ELEMENT_TYPE.PARKING_GARAGE);
  design.elements.push({
    ...garage, id: 'design-b-garage-02', properties: { ...garage.properties, name: 'Overlapping' },
  });
  const report = validateDesignSpatially(design, { buildings: [], roads: [] });
  const self = report.findings.find(f => f.id === 'self');
  assert.equal(self.status, FINDING.CONFLICT);
  assert.match(self.detail, /design-b-garage-01/);
});

// ---- connectivity -----------------------------------------------------------------------------------

test('a road whose ends sit on the network reads as connected', () => {
  const road = designB().elements.find(e => e.type === ELEMENT_TYPE.ROAD);
  const points = road.geometry.coordinates;
  const touching = [
    { objectId: 1, name: 'START RD', coordinates: [enuToLonLat(points[0], -60, 0), enuToLonLat(points[0], 60, 0)] },
    { objectId: 2, name: 'CARIBBEAN WAY', coordinates: [enuToLonLat(points.at(-1), -60, 0), enuToLonLat(points.at(-1), 60, 0)] },
  ];
  const [result] = validateConnectivity(designB(), { roads: touching });
  assert.equal(result.status, CONNECTIVITY.CONNECTED, JSON.stringify(result.ends));
  assert.equal(result.ends.length, 2, 'both ends are tested');
  assert.match(result.detail, /Geometric proximity only|unclassified/);
});

test('a road connected at one end only is NOT connected', () => {
  const road = designB().elements.find(e => e.type === ELEMENT_TYPE.ROAD);
  const points = road.geometry.coordinates;
  const oneEnd = [{
    objectId: 1, name: 'START RD',
    coordinates: [enuToLonLat(points[0], -60, 0), enuToLonLat(points[0], 60, 0)],
  }];
  const [result] = validateConnectivity(designB(), { roads: oneEnd });
  assert.notEqual(result.status, CONNECTIVITY.CONNECTED);
  assert.equal(result.ends.find(e => e.end === 'start').status, CONNECTIVITY.CONNECTED);
});

test('an end near but not on the network is a potential connection, not a claim', () => {
  const road = designB().elements.find(e => e.type === ELEMENT_TYPE.ROAD);
  const points = road.geometry.coordinates;
  const near = [0, -1].map((index, i) => ({
    objectId: i, name: `R${i}`,
    coordinates: [enuToLonLat(points.at(index), -60, 25), enuToLonLat(points.at(index), 60, 25)],
  }));
  const [result] = validateConnectivity(designB(), { roads: near });
  assert.equal(result.status, CONNECTIVITY.POTENTIAL, JSON.stringify(result.ends));
  assert.match(result.detail, /unclassified|may need snapping/);
});

test('no road layer means connectivity is Not evaluated, not disconnected', () => {
  const [result] = validateConnectivity(designB(), { roads: null });
  assert.equal(result.status, CONNECTIVITY.NOT_EVALUATED);
});

test('a design with no proposed roads has nothing to connect', () => {
  assert.deepEqual(validateConnectivity(designA(), { roads: [] }), []);
});

test('removed elements are not tested for connectivity or overlap', () => {
  const design = createDesign({
    id: 'r', name: 'r',
    elements: [{
      id: 'r-1', type: ELEMENT_TYPE.ROAD, changeType: CHANGE_TYPE.REMOVED,
      baselineRef: { kind: 'ROAD', objectId: 99 },
      geometry: { type: 'LineString', coordinates: [at(ANCHORS.southLot, 0, 0), at(ANCHORS.southLot, 200, 0)] },
      properties: { widthM: 7 },
    }],
  });
  assert.deepEqual(validateConnectivity(design, { roads: [] }), []);
  assert.equal(elementsOfChange(design, CHANGE_TYPE.REMOVED).length, 1);
});

test('a proposed structure sitting over an existing centreline is reported', () => {
  const garage = designB().elements.find(e => e.type === ELEMENT_TYPE.PARKING_GARAGE);
  const ring = garage.geometry.coordinates[0];
  const through = {
    objectId: 2, name: 'ATLANTIC WAY',
    coordinates: [enuToLonLat(ring[0], -200, -200), enuToLonLat(ring[0], 200, 200)],
  };
  const report = validateDesignSpatially(designB(), { buildings: [], roads: [through] });
  const finding = report.findings.find(f => f.id === 'building-on-road');
  assert.equal(finding?.status, FINDING.CONFLICT, JSON.stringify(finding));
});

// ---- endpoint roles ---------------------------------------------------------------------------------

test('an access road is judged by what each end is FOR, not by one rule for both', () => {
  const road = designB().elements.find(e => e.type === ELEMENT_TYPE.ROAD);
  assert.equal(road.properties.startRole, ENDPOINT_ROLE.FACILITY_ENTRANCE);
  assert.equal(road.properties.endRole, ENDPOINT_ROLE.ROAD_NETWORK_CONNECTION);

  const end = road.geometry.coordinates.at(-1);
  const portBlvd = [{
    objectId: 1, name: 'PORT BLVD',
    coordinates: [enuToLonLat(end, -60, 0), enuToLonLat(end, 60, 0)],
  }];
  const [result] = validateConnectivity(designB(), { roads: portBlvd });
  assert.equal(result.functionalStatus, CONNECTIVITY.CONNECTED, JSON.stringify(result.ends));
  assert.equal(result.geometricStatus, CONNECTIVITY.CONNECTED);
  const facility = result.ends.find(e => e.role === ENDPOINT_ROLE.FACILITY_ENTRANCE);
  assert.equal(facility.entranceDistanceM, 0, 'it starts at the declared access point');
});

test('a facility end with no declared entrance is Not evaluated, never assumed connected', () => {
  const design = designB();
  const garage = design.elements.find(e => e.type === ELEMENT_TYPE.PARKING_GARAGE);
  delete garage.properties.accessPoint;
  const [result] = validateConnectivity(design, { roads: [] });
  const facility = result.ends.find(e => e.role === ENDPOINT_ROLE.FACILITY_ENTRANCE);
  assert.equal(facility.status, CONNECTIVITY.NOT_EVALUATED);
  assert.match(facility.detail, /declares no access point/);
});

test('a dead end and a future connection are not defects', () => {
  const design = createDesign({
    id: 'd', name: 'd',
    elements: [{
      id: 'd-1', type: ELEMENT_TYPE.ROAD, changeType: CHANGE_TYPE.NEW,
      geometry: { type: 'LineString', coordinates: [at(ANCHORS.southLot, 0, 0), at(ANCHORS.southLot, 150, 0)] },
      properties: { widthM: 7, startRole: ENDPOINT_ROLE.DEAD_END, endRole: ENDPOINT_ROLE.FUTURE_CONNECTION },
    }],
  });
  const [result] = validateConnectivity(design, { roads: [] });
  assert.equal(result.geometricStatus, CONNECTIVITY.NOT_EVALUATED);
  assert.ok(result.ends.every(e => e.status === CONNECTIVITY.NOT_EVALUATED));
  assert.match(result.detail, /no end of this alignment is expected to connect/i);
});

test('an unclassified end is still tested against the network, and says so', () => {
  const design = createDesign({
    id: 'u', name: 'u',
    elements: [{
      id: 'u-1', type: ELEMENT_TYPE.ROAD, changeType: CHANGE_TYPE.NEW,
      geometry: { type: 'LineString', coordinates: [at(ANCHORS.southLot, 0, 0), at(ANCHORS.southLot, 150, 0)] },
      properties: { widthM: 7 },
    }],
  });
  const [result] = validateConnectivity(design, { roads: [] });
  assert.ok(result.ends.every(e => e.role === ENDPOINT_ROLE.UNCLASSIFIED));
  assert.equal(result.geometricStatus, CONNECTIVITY.DISCONNECTED, 'the safer assumption');
  assert.match(result.detail, /unclassified/);
});

// ---- widening in the design totals -------------------------------------------------------------

test('a widening is counted apart from new and modified roads, never summed with them', () => {
  const widening = {
    id: 'w1', type: ELEMENT_TYPE.ROAD, changeType: CHANGE_TYPE.MODIFIED, operation: 'WIDEN',
    baselineRef: { kind: 'ROAD', objectId: 42, name: 'S CRUISE BLVD' },
    geometry: { type: 'LineString', coordinates: [at(ANCHORS.southLot, 0, 0), at(ANCHORS.southLot, 0, 200)] },
    proposal: { totalWidthM: 10, laneCount: 2, wideningSide: 'BOTH', baselineWidthM: null },
    properties: { name: 'S CRUISE BLVD — proposed widening', widthM: 10, lanes: 2 },
  };
  const q = designQuantities(createDesign({ id: 'w', name: 'W', elements: [widening] }));
  assert.equal(q.widening.count, 1);
  assert.ok(Math.abs(q.widening.affectedLengthM - 200) < 1, `${q.widening.affectedLengthM}`);
  assert.ok(q.widening.proposedCorridorAreaM2 > 1900);
  assert.equal(q.widening.maxProposedWidthM, 10);
  // Not added to the plain modified-road totals.
  assert.equal(q.roads.modifiedLengthM, 0, 'a widening is not also a modified road length');
  assert.equal(q.roads.newLengthM, 0);
});

test('incremental pavement across a design is null when any widening lacks a baseline width', () => {
  const road = (id, baselineWidthM) => ({
    id, type: ELEMENT_TYPE.ROAD, changeType: CHANGE_TYPE.MODIFIED, operation: 'WIDEN',
    baselineRef: { kind: 'ROAD', objectId: 1 },
    geometry: { type: 'LineString', coordinates: [at(ANCHORS.southLot, 0, 0), at(ANCHORS.southLot, 0, 150)] },
    proposal: { totalWidthM: 10, laneCount: 2, wideningSide: 'BOTH', baselineWidthM },
    properties: { widthM: 10 },
  });
  const known = designQuantities(createDesign({ id: 'k', name: 'K', elements: [road('a', 7)] }));
  assert.ok(known.widening.incrementalPavementM2 > 400, `${known.widening.incrementalPavementM2}`);

  const mixed = designQuantities(createDesign({
    id: 'm', name: 'M', elements: [road('a', 7), road('b', null)],
  }));
  assert.equal(mixed.widening.incrementalPavementM2, null,
    'one unknown makes the total unknowable — a partial sum would understate it');
});

test('comparing two alternatives reports widening differences', () => {
  const road = (width, lanes) => ({
    id: 'w', type: ELEMENT_TYPE.ROAD, changeType: CHANGE_TYPE.MODIFIED, operation: 'WIDEN',
    baselineRef: { kind: 'ROAD', objectId: 1 },
    geometry: { type: 'LineString', coordinates: [at(ANCHORS.southLot, 0, 0), at(ANCHORS.southLot, 0, 200)] },
    proposal: { totalWidthM: width, laneCount: lanes, wideningSide: 'BOTH', baselineWidthM: null },
    properties: { widthM: width, lanes },
  });
  const result = compareDesigns(
    createDesign({ id: 'a', name: 'A', elements: [road(10, 2)] }),
    createDesign({ id: 'b', name: 'B', elements: [road(12, 3)] }));
  assert.equal(result.differences.maxProposedWidthM, 2);
  assert.equal(result.differences.maxProposedLanes, 1);
  assert.ok(result.differences.wideningCorridorAreaM2 > 0);
  assert.equal(result.differences.incrementalPavementM2, null, 'neither states a baseline width');
});
