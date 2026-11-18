/**
 * Reading an alternative as a design review.
 *
 * The fixtures reproduce the two stored alternatives the audit found confusing: a "Design A" whose
 * four records are operations on one road, and a "Design C" holding the same new road saved many
 * times. What is pinned down is that duplicates are found by geometry rather than by name, that
 * totals never count the same ground twice, and that the demo templates never invent an alignment.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  DEMO_IDS, DESIGN_PURPOSE, demoTemplates, designSummary, duplicateDesign, findDuplicates,
  groupRoadChanges, hausdorffM, operationClashes, purposeOf, repeatedNames, unionAreaM2,
  withoutElements,
} from '../src/designs/designReview.js';
import { roadCorridorRing } from '../src/designs/roadCorridor.js';
import { enuToLonLat } from '../src/scenarios/garagePlacement.js';

const ORIGIN = [-80.1675, 25.7735];
const line = offsets => offsets.map(([e, n]) => enuToLonLat(ORIGIN, e, n));
const STRAIGHT = line([[0, 0], [60, 0], [120, 0]]);

const newRoad = (id, coordinates = STRAIGHT, extra = {}) => ({
  id, type: 'ROAD', changeType: 'NEW', operation: 'CREATE',
  geometry: { type: 'LineString', coordinates },
  properties: { name: 'Proposed Terminal Link', widthM: 9, lanes: 2 },
  ...extra,
});

const ROAD_40642 = { objectId: 40642, name: 'S CRUISE BLVD', coordinates: line([[0, 0], [80, -30], [170, -60]]) };
const ref = { kind: 'ROAD', source: 'MIAMI_DADE_ROADS', objectId: 40642, name: 'S CRUISE BLVD' };

const designA = {
  id: 'road-design-a',
  elements: [
    newRoad('road-new', line([[0, 10], [120, 10]]), { properties: { name: 'Proposed road', widthM: 10, lanes: 2 } }),
    { id: 'realign-40642-all', type: 'ROAD', changeType: 'MODIFIED', operation: 'REALIGN', baselineRef: ref,
      section: null, geometry: { type: 'LineString', coordinates: line([[0, 10], [120, 10]]) },
      properties: { name: 'S CRUISE BLVD — proposed realignment', widthM: 10, lanes: 2 } },
    { id: 'close-40642-all', type: 'ROAD', changeType: 'REMOVED', operation: 'CLOSE', baselineRef: ref,
      section: null, geometry: { type: 'LineString', coordinates: ROAD_40642.coordinates },
      properties: { name: 'S CRUISE BLVD — proposed closure' } },
    { id: 'widen-40642-0-30', type: 'ROAD', changeType: 'MODIFIED', operation: 'WIDEN', baselineRef: ref,
      section: { startMeasureM: 0, endMeasureM: 30, lengthM: 30 },
      proposal: { totalWidthM: 10, laneCount: 2, wideningSide: 'BOTH', baselineWidthM: null },
      geometry: { type: 'LineString', coordinates: ROAD_40642.coordinates.slice(0, 2) },
      properties: { name: 'S CRUISE BLVD — proposed widening', widthM: 10, lanes: 2 } },
  ],
};

test('changes are grouped under the road they affect, not listed as separate roads', () => {
  const groups = groupRoadChanges(designA);
  assert.equal(groups.existingRoads.length, 1);
  assert.equal(groups.existingRoads[0].objectId, 40642);
  assert.deepEqual(groups.existingRoads[0].operations.map(e => e.operation), ['REALIGN', 'CLOSE', 'WIDEN']);
  assert.equal(groups.newRoads.length, 1);
});

test('the summary counts one affected road and three operations, not three modified roads', () => {
  const summary = designSummary(designA);
  assert.equal(summary.existingRoadsAffected, 1);
  assert.equal(summary.operationsOnExisting, 3);
  assert.equal(summary.newRoadCount, 1);
});

test('operations on the same stretch of one road are reported as clashing', () => {
  const clashes = operationClashes(designA);
  assert.equal(clashes.length, 3);
  assert.ok(clashes.every(clash => clash.objectId === 40642));
});

test('a mixed alternative says so; a declared purpose wins over its contents', () => {
  assert.equal(purposeOf(designA).purpose, DESIGN_PURPOSE.MIXED);
  assert.equal(purposeOf(designA).inferred, true);
  assert.deepEqual(purposeOf({ purpose: 'NEW_ROAD', elements: designA.elements }),
    { purpose: 'NEW_ROAD', inferred: false });
  assert.equal(purposeOf({ elements: [] }).purpose, null);
});

// ---- duplicates --------------------------------------------------------------------------------

const nudged = line([[0, 0.05], [60, 0.05], [120, -0.05]]);
const designC = {
  id: 'road-design-c',
  elements: [newRoad('road-1'), newRoad('road-2'), newRoad('road-3', nudged), newRoad('road-4')],
};

test('the same alignment saved repeatedly is found, with the first record kept', () => {
  const [group, ...rest] = findDuplicates(designC);
  assert.equal(rest.length, 0);
  assert.equal(group.keepId, 'road-1');
  assert.deepEqual(group.copies.map(c => c.id), ['road-2', 'road-3', 'road-4']);
  assert.equal(group.copies.find(c => c.id === 'road-2').exact, true);
  assert.equal(group.copies.find(c => c.id === 'road-3').exact, false);
  assert.ok(group.copies.find(c => c.id === 'road-3').deviationM < 0.1);
});

test('a shared name is not enough: different alignments are not duplicates', () => {
  const apart = { elements: [newRoad('a'), newRoad('b', line([[0, 40], [120, 40]]))] };
  assert.deepEqual(findDuplicates(apart), []);
  assert.ok(repeatedNames(apart).has('Proposed Terminal Link'));
});

test('different widths on the same line are different proposals', () => {
  const widths = { elements: [newRoad('a'), newRoad('b', STRAIGHT, { properties: { name: 'x', widthM: 12, lanes: 2 } })] };
  assert.deepEqual(findDuplicates(widths), []);
});

test('totals set duplicate copies aside instead of multiplying the road', () => {
  const summary = designSummary(designC);
  assert.equal(summary.newRoadCount, 4);
  assert.equal(summary.uniqueNewRoadCount, 1);
  assert.ok(Math.abs(summary.uniqueNewRoadLengthM - 120) < 0.5);
  assert.ok(Math.abs(summary.newRoadLengthM - 480) < 2);
  assert.equal(summary.overlapping, true);
  // The unique ground area is one road's worth, not four.
  assert.ok(summary.uniqueAreaM2 < summary.summedAreaM2 / 3);
});

test('cleanup is pure and keeps everything it was not told to remove', () => {
  const ids = findDuplicates(designC)[0].copies.map(c => c.id);
  const cleaned = withoutElements(designC, ids);
  assert.deepEqual(cleaned.elements.map(e => e.id), ['road-1']);
  assert.equal(designC.elements.length, 4);
});

test('hausdorff distance is zero for identical lines and grows with offset', () => {
  assert.equal(hausdorffM(STRAIGHT, STRAIGHT), 0);
  assert.ok(Math.abs(hausdorffM(STRAIGHT, line([[0, 5], [120, 5]])) - 5) < 0.01);
});

test('union area counts overlap once and matches a single ring on its own', () => {
  const ring = roadCorridorRing(STRAIGHT, 10);
  const single = unionAreaM2([ring]).areaM2;
  assert.ok(Math.abs(single - 1200) < 30, `single ${single}`);
  assert.ok(Math.abs(unionAreaM2([ring, ring]).areaM2 - single) < 1);
  const apart = roadCorridorRing(line([[0, 50], [120, 50]]), 10);
  assert.ok(Math.abs(unionAreaM2([ring, apart]).areaM2 - 2 * single) < 30);
});

// ---- managing alternatives ------------------------------------------------------------------------

test('duplicating an alternative gives a new id and drops the stored revision', () => {
  const copy = duplicateDesign({ ...designA, name: 'Design A', revision: '30', createdAt: 'x', updatedAt: 'y', archived: true },
    { id: 'road-design-copy', name: 'Copy of Design A' });
  assert.equal(copy.id, 'road-design-copy');
  assert.equal(copy.revision, undefined);
  assert.equal(copy.archived, undefined);
  assert.deepEqual(copy.duplicatedFrom, { id: 'road-design-a', revision: '30' });
  assert.equal(copy.elements.length, designA.elements.length);
  assert.notEqual(copy.elements[0], designA.elements[0]);
});

test('demo templates use their own ids and invent no alignment', () => {
  const templates = demoTemplates({ roadsById: new Map([[40642, ROAD_40642]]) });
  assert.deepEqual(Object.keys(templates).sort(), Object.values(DEMO_IDS).sort());
  for (const id of ['road-design-a', 'road-design-b', 'road-design-c']) assert.equal(templates[id], undefined);

  const widening = templates[DEMO_IDS.WIDENING];
  assert.equal(widening.purpose, 'WIDENING');
  assert.equal(widening.elements.length, 1);
  const [element] = widening.elements;
  assert.equal(element.baselineRef.objectId, 40642);
  assert.equal(element.proposal.totalWidthM, 10);
  assert.equal(element.proposal.laneCount, 2);
  assert.equal(element.proposal.baselineWidthM, null);
  assert.equal(element.proposal.baselineWidthSource, 'UNKNOWN');
  assert.ok(Math.abs(element.section.lengthM - 60) < 0.01);

  assert.equal(templates[DEMO_IDS.NEW_ROAD].elements.length, 0);
  assert.equal(templates[DEMO_IDS.REALIGNMENT].elements.length, 0);
});

test('without the road loaded, the widening template is empty and says why', () => {
  const widening = demoTemplates({ roadsById: new Map() })[DEMO_IDS.WIDENING];
  assert.equal(widening.elements.length, 0);
  assert.match(widening.limitation, /not in the loaded road data/);
});

// ---- one operation per alternative, realignment, generated demonstrations -------------------------

import {
  DEMO_FOCUS, constraintViolations, generateNewRoad, generateRealignment, operationRejection,
  realignmentMetrics, resampleLine, validateRealignmentGeometry,
} from '../src/designs/designReview.js';

const at = (e, n) => enuToLonLat(DEMO_FOCUS, e, n);
const portRoad = (objectId, offsets, extra = {}) => {
  const coordinates = offsets.map(([e, n]) => at(e, n));
  const lons = coordinates.map(c => c[0]), lats = coordinates.map(c => c[1]);
  return {
    objectId, name: `ROAD ${objectId}`, isPortAccess: true, isTunnel: false, coordinates,
    bounds: { west: Math.min(...lons), east: Math.max(...lons), south: Math.min(...lats), north: Math.max(...lats) },
    ...extra,
  };
};

test('a restricted alternative rejects another operation and reports what it already holds', () => {
  const widening = { id: 'w', type: 'ROAD', operation: 'WIDEN' };
  const created = { id: 'n', type: 'ROAD', changeType: 'NEW', operation: 'CREATE' };
  const a = { name: 'Design A — Road Widening', allowedOperation: 'WIDEN', elements: [widening, created] };
  assert.equal(operationRejection(a, widening), null);
  assert.match(operationRejection(a, created), /road widening only/);
  assert.deepEqual(constraintViolations(a), ['n']);
  assert.equal(operationRejection({ elements: [] }, created), null);
});

test('realignment metrics: tie-ins, length difference and lateral displacement', () => {
  const road = portRoad(1, [[0, 0], [200, 0]]);
  const proposed = [at(50, 0), at(100, 20), at(150, 0)];
  const element = { geometry: { type: 'LineString', coordinates: proposed }, section: { startMeasureM: 50, endMeasureM: 150 } };
  const metrics = realignmentMetrics(element, road);
  assert.ok(Math.abs(metrics.originalLengthM - 100) < 0.5);
  assert.ok(metrics.startTieM < 0.01 && metrics.endTieM < 0.01 && metrics.tiedIn);
  assert.ok(Math.abs(metrics.maxLateralM - 20) < 1);
  assert.ok(metrics.lengthDifferenceM > 7);
  assert.equal(metrics.selfIntersects, false);
});

test('a realignment is refused when it unties, crosses itself or changes nothing', () => {
  const original = [at(0, 0), at(100, 0)];
  assert.deepEqual(validateRealignmentGeometry({ points: [at(0, 0), at(50, 20), at(100, 0)], original }), []);
  assert.ok(validateRealignmentGeometry({ points: [at(0, 5), at(50, 20), at(100, 0)], original })
    .some(e => /start no longer ties/.test(e)));
  assert.equal(validateRealignmentGeometry({ points: [at(0, 5), at(50, 20), at(100, 0)], original, tieInsLocked: false })
    .some(e => /ties/.test(e)), false);
  assert.ok(validateRealignmentGeometry({ points: [at(0, 0), at(60, 20), at(60, -20), at(30, 10), at(100, 0)], original })
    .some(e => /crosses itself/.test(e)));
  assert.ok(validateRealignmentGeometry({ points: resampleLine(original, 4), original })
    .some(e => /within 2 m/.test(e)));
});

test('the generated new road joins two roads, clear of buildings and of other centrelines', () => {
  const roadsById = new Map([
    [1, portRoad(1, [[-150, 0], [150, 0]])],
    [2, portRoad(2, [[-150, 150], [150, 150]])],
  ]);
  const link = generateNewRoad({ roadsById, buildingsById: new Map() });
  assert.ok(link);
  assert.deepEqual(new Set([link.start.objectId, link.end.objectId]), new Set([1, 2]));
  const blocked = new Map([[9, { objectId: 9, rings: [[at(-160, 20), at(160, 20), at(160, 130), at(-160, 130), at(-160, 20)]],
    bounds: { west: at(-160, 0)[0], east: at(160, 0)[0], south: at(0, 20)[1], north: at(0, 130)[1] } }]]);
  assert.equal(generateNewRoad({ roadsById, buildingsById: blocked }), null);
});

test('the generated realignment keeps both tie-ins on the road and never uses S CRUISE BLVD', () => {
  const roadsById = new Map([
    [40642, portRoad(40642, [[-300, -300], [-100, -300]], { name: 'S CRUISE BLVD' })],
    [7, portRoad(7, [[0, 0], [300, 0]])],
  ]);
  const result = generateRealignment({ roadsById, buildingsById: new Map() });
  assert.ok(result);
  assert.equal(result.road.objectId, 7);
  const metrics = realignmentMetrics({ geometry: { type: 'LineString', coordinates: result.points },
    section: { startMeasureM: result.startM, endMeasureM: result.endM } }, result.road);
  assert.ok(metrics.tiedIn);
  assert.ok(metrics.maxLateralM >= 13);
});
