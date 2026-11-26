import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AREA_RELATION, areaIntentOf, areaScopeOf, classifyGeometry, distanceToArea, elementGeometry, makeFrame, namedZoneOf,
  partitionByArea, pointInRing, polygonOf, rectangleRing, resolveAreaMembership, segmentsIntersect, selectionIdOf, validateAreaGeometry,
} from '../src/ifcSpatial/areaQuery.js';
import { defaultPlacement, modelMatrixFor, transformPoint } from '../src/ifcSpatial/placement.js';
import { geodeticToEcef } from '../src/ifcSpatial/placement.js';

// A model frame: x east, y north, metres from (-76.54, 39.25).
const LON0 = -76.54, LAT0 = 39.25;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
const toLonLat = (x, y) => ({ lon: LON0 + x / KX, lat: LAT0 + y / 110_574 });
const ll = (x, y) => { const r = toLonLat(x, y); return [r.lon, r.lat]; };
/** A square area from model metres. */
const square = (x0, y0, x1, y1) => [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1)];
const box = (x0, y0, x1, y1) => ({ min: [x0, y0, 0], max: [x1, y1, 2] });

test('point in polygon, boundary included, concave shape', () => {
  const ring = [[0, 0], [10, 0], [10, 10], [5, 4], [0, 10]];
  assert.equal(pointInRing([2, 2], ring), true);
  assert.equal(pointInRing([5, 8], ring), false); // in the notch
  assert.equal(pointInRing([10, 5], ring), true); // on an edge
  assert.equal(pointInRing([11, 5], ring), false);
});

test('segment intersection: crossing, touching, parallel, apart', () => {
  assert.equal(segmentsIntersect([0, 0], [10, 10], [0, 10], [10, 0]), true);
  assert.equal(segmentsIntersect([0, 0], [5, 0], [5, 0], [5, 5]), true);
  assert.equal(segmentsIntersect([0, 0], [5, 0], [0, 1], [5, 1]), false);
  assert.equal(segmentsIntersect([0, 0], [1, 1], [3, 3], [4, 5]), false);
});

test('validation: too few points, self-intersection, invalid coordinates, too small, closing point and duplicates', () => {
  assert.equal(validateAreaGeometry({ type: 'Polygon', coordinates: [[ll(0, 0), ll(10, 0), ll(0, 0)]] }).code, 'TOO_FEW_POINTS');
  assert.equal(validateAreaGeometry({ type: 'Polygon', coordinates: [[ll(0, 0), ll(100, 100), ll(100, 0), ll(0, 100)]] }).code, 'SELF_INTERSECTING');
  assert.equal(validateAreaGeometry({ type: 'Polygon', coordinates: [[[0, 0], [NaN, 1], [1, 1]]] }).code, 'INVALID_COORDINATES');
  assert.equal(validateAreaGeometry({ type: 'Polygon', coordinates: [[[0, 0], [200, 1], [1, 1]]] }).code, 'INVALID_COORDINATES');
  assert.equal(validateAreaGeometry({ type: 'Polygon', coordinates: [[ll(0, 0), ll(2, 0), ll(2, 2), ll(0, 2)]] }).code, 'TOO_SMALL');
  assert.equal(validateAreaGeometry({ type: 'Polygon', coordinates: [[ll(0, 0), ll(50, 0), ll(100, 0)]] }).code, 'TOO_SMALL'); // collinear
  assert.equal(validateAreaGeometry({ type: 'LineString', coordinates: [] }).code, 'NOT_A_POLYGON');
  assert.equal(validateAreaGeometry(null).code, 'NOT_A_POLYGON');
  const ok = validateAreaGeometry(polygonOf([ll(0, 0), ll(100, 0), ll(100, 0), ll(100, 50), ll(0, 50)]));
  assert.equal(ok.ok, true);
  assert.equal(ok.ring.length, 4, 'closing point and the repeated vertex are dropped');
  assert.ok(Math.abs(ok.areaM2 - 5000) < 5, `area ≈ 5000 m² (${ok.areaM2})`);
});

test('rectangle from two corners in any order', () => {
  const a = rectangleRing({ lon: 2, lat: 5 }, { lon: 1, lat: 3 });
  assert.deepEqual(a, [[1, 3], [2, 3], [2, 5], [1, 5]]);
});

test('classification: point, footprint within / intersecting, cable within / crossing with both ends outside / outside', () => {
  const area = [[0, 0], [100, 0], [100, 100], [0, 100]];
  assert.equal(classifyGeometry({ type: 'Point', xy: [50, 50] }, area), AREA_RELATION.WITHIN);
  assert.equal(classifyGeometry({ type: 'Point', xy: [150, 50] }, area), AREA_RELATION.OUTSIDE);
  assert.equal(classifyGeometry({ type: 'Polygon', ring: [[10, 10], [20, 10], [20, 20], [10, 20]] }, area), AREA_RELATION.WITHIN);
  // A building footprint partly over the boundary: intersects even though its centre is outside.
  assert.equal(classifyGeometry({ type: 'Polygon', ring: [[90, 40], [140, 40], [140, 60], [90, 60]] }, area), AREA_RELATION.INTERSECTS);
  // The area entirely inside a large footprint.
  assert.equal(classifyGeometry({ type: 'Polygon', ring: [[-50, -50], [150, -50], [150, 150], [-50, 150]] }, area), AREA_RELATION.INTERSECTS);
  assert.equal(classifyGeometry({ type: 'LineString', coords: [[10, 10], [90, 90]] }, area), AREA_RELATION.WITHIN);
  assert.equal(classifyGeometry({ type: 'LineString', coords: [[-50, 50], [150, 50]] }, area), AREA_RELATION.CROSSES, 'both ends outside, crosses');
  assert.equal(classifyGeometry({ type: 'LineString', coords: [[-50, 150], [150, 150]] }, area), AREA_RELATION.OUTSIDE);
  assert.equal(classifyGeometry(null, area), AREA_RELATION.UNKNOWN_LOCATION);
});

test('distance to the area (metres), zero inside', () => {
  const area = [[0, 0], [100, 0], [100, 100], [0, 100]];
  assert.equal(distanceToArea({ type: 'Point', xy: [50, 50] }, area), 0);
  assert.equal(distanceToArea({ type: 'Point', xy: [130, 50] }, area), 30);
  assert.equal(Math.round(distanceToArea({ type: 'LineString', coords: [[120, -50], [120, 150]] }, area)), 20);
});

test('element geometry through the IFC → world transform: route, bounding-box footprint, none', () => {
  const cable = elementGeometry({ route: [[0, 0, 0], [100, 0, 0]] }, toLonLat);
  assert.equal(cable.geometry.type, 'LineString');
  assert.deepEqual(cable.geometry.coords[1].map(v => +v.toFixed(6)), ll(100, 0).map(v => +v.toFixed(6)));
  const tx = elementGeometry({ bbox: box(0, 0, 4, 2) }, toLonLat);
  assert.equal(tx.geometry.type, 'Polygon');
  assert.equal(tx.basis, 'BOUNDING_BOX_FOOTPRINT');
  assert.equal(elementGeometry({}, toLonLat), null);
  assert.equal(elementGeometry({ bbox: box(0, 0, 1, 1) }, () => ({ lon: NaN, lat: NaN })), null);
});

test('membership: within, intersecting, crossing cable, outside, unknown, deduplicated, ports skipped, facilities, near', () => {
  const elements = [
    { networkId: 'TX-1', ifcClass: 'IfcTransformer', bbox: box(10, 10, 14, 14) },
    { networkId: 'TX-1', ifcClass: 'IfcTransformer', bbox: box(500, 500, 504, 504) }, // the same id twice: counted once
    { networkId: 'BLD', ifcClass: 'IfcBuildingElementProxy', bbox: box(90, 40, 140, 60) },
    { networkId: 'CB-1', ifcClass: 'IfcCableSegment', bbox: box(-50, 49, 150, 51), route: [[-50, 50, 0], [150, 50, 0]] },
    { networkId: 'FAR', ifcClass: 'IfcTransformer', bbox: box(300, 300, 304, 304) },
    { networkId: 'NEAR', ifcClass: 'IfcTransformer', bbox: box(120, 10, 124, 14) },
    { networkId: 'NOGEO', ifcClass: 'IfcTransformer' },
    { networkId: 'PORT', ifcClass: 'IfcDistributionPort', bbox: box(10, 10, 11, 11) },
    { tag: 'MAST-1', ifcClass: 'IfcLightFixture', bbox: box(60, 60, 61, 61) },
  ];
  const m = resolveAreaMembership({ elements, ring: square(0, 0, 100, 100), toLonLat, nearM: 30,
    facilities: [{ id: 'USS-1', ring: square(70, 70, 130, 130) }] });
  assert.deepEqual(m.within.sort(), ['MAST-1', 'TX-1']);
  assert.deepEqual(m.intersects.sort(), ['BLD', 'USS-1']);
  assert.deepEqual(m.crosses, ['CB-1']);
  assert.deepEqual(m.unknown, ['NOGEO']);
  assert.equal(m.relations.PORT, undefined);
  assert.equal(m.relations['USS-1'].kind, 'facility');
  assert.deepEqual(m.near.map(n => n.id), ['NEAR']);
  assert.ok(Math.abs(m.near[0].distanceM - 20) < 0.5);
  assert.equal(m.outside, 2);
});

test('partition by area keeps unknown locations apart and deduplicates', () => {
  const relations = { A: { relation: 'WITHIN' }, B: { relation: 'CROSSES' }, C: { relation: 'OUTSIDE' }, D: { relation: 'UNKNOWN_LOCATION' } };
  assert.deepEqual(partitionByArea(['A', 'B', 'C', 'D', 'E', 'A'], relations), { inside: ['A', 'B'], outside: ['C'], unknown: ['D', 'E'] });
});

test('named zone only when exactly one zone label is inside the area', () => {
  const zones = [{ name: 'Container Yard', lon: ll(50, 50)[0], lat: ll(50, 50)[1] }, { name: 'Berth Zone W', lon: ll(400, 50)[0], lat: ll(400, 50)[1] }];
  assert.equal(namedZoneOf(square(0, 0, 100, 100), zones), 'Container Yard');
  assert.equal(namedZoneOf(square(0, 0, 500, 100), zones), null, 'two zones: not named');
  assert.equal(namedZoneOf(square(200, 200, 300, 300), zones), null);
});

test('selection id: stable for the same ring and version, different for another version or ring', () => {
  const r = square(0, 0, 100, 100);
  assert.equal(selectionIdOf(r, 'k1'), selectionIdOf(r.map(p => [...p]), 'k1'));
  assert.notEqual(selectionIdOf(r, 'k1'), selectionIdOf(r, 'k2'));
  assert.notEqual(selectionIdOf(r, 'k1'), selectionIdOf(square(0, 0, 100, 101), 'k1'));
});

test('scope: the area by default, the entire terminal, outside, near with and without a distance', () => {
  assert.deepEqual(areaScopeOf('Which assets are degraded?'), { scope: 'AREA', explicit: false, distanceM: null });
  assert.equal(areaScopeOf('How many assets are in this area?').explicit, true);
  assert.equal(areaScopeOf('Show all degraded assets across Seagirt.').scope, 'TERMINAL');
  assert.equal(areaScopeOf('How many transformers in the entire terminal?').scope, 'TERMINAL');
  assert.equal(areaScopeOf('Which assets are outside this area?').scope, 'OUTSIDE');
  assert.deepEqual(areaScopeOf('Show electrical assets within 50 metres of this area'), { scope: 'NEAR', explicit: true, distanceM: 50 });
  assert.deepEqual(areaScopeOf('Which transformers are near this area?'), { scope: 'NEAR', explicit: true, distanceM: null });
  assert.equal(areaScopeOf('Which assets outside this area depend on equipment inside it?').scope, 'AREA', 'a dependency question, not a filter');
});

test('intent: inventory, status, supply, downstream, alternate, outage, inspection, construction, versions', () => {
  const cases = {
    'How many electrical assets are in this area?': 'INVENTORY', 'Show all transformers in this area': 'INVENTORY', 'Are there any substations in this area?': 'INVENTORY',
    'Which assets are degraded or without power?': 'STATUS', 'Show the electrical alerts in this area': 'STATUS', 'Are all cranes operational in this area?': 'STATUS',
    'Where does this area get its power from?': 'SUPPLY', 'Which transformers supply this area?': 'SUPPLY', 'Are any assets in this area supplied by TX-M1?': 'SUPPLY',
    'Which assets outside this area depend on equipment inside it?': 'DOWNSTREAM', 'Do the cranes in this area have an alternate power supply?': 'ALTERNATE',
    'What happens if TX-M2 shuts down?': 'OUTAGE', 'Which assets in this area would lose power if TX-M1 fails?': 'OUTAGE',
    'Which assets in this area require inspection?': 'INSPECTION', 'Which assets have no linked inspection documents?': 'INSPECTION',
    'Which cables cross this area?': 'CONSTRUCTION', 'We are planning construction in this area. Which electrical assets could be affected?': 'CONSTRUCTION',
    'What changed in this area between IFC V4 and V5?': 'VERSIONS', 'Were any transformers added in this area?': 'VERSIONS',
  };
  for (const [q, want] of Object.entries(cases)) assert.equal(areaIntentOf(q), want, q);
});

test('membership with the real fixture and the model placement: every networked element is classified once', () => {
  const net = JSON.parse(readFileSync(new URL('./fixtures/ifc-network.json', import.meta.url), 'utf8'));
  const placement = { mode: 'USER_CALIBRATED', lon: -76.5394, lat: 39.2569, heightOffset: 0, headingDeg: 0, scale: 1 };
  const m = modelMatrixFor(placement, null, 0);
  const toLL = (x, y, z = 0) => {
    const [X, Y, Z] = transformPoint(m, [x, y, z]);
    const lon = Math.atan2(Y, X) * 180 / Math.PI, p = Math.hypot(X, Y);
    const lat = Math.atan2(Z, p * (1 - 0.00669437999014)) * 180 / Math.PI;
    return { lon, lat };
  };
  const frame = makeFrame([[placement.lon, placement.lat]]);
  const ring = [[-2000, -2000], [2000, -2000], [2000, 2000], [-2000, 2000]].map(frame.toLL);
  const all = resolveAreaMembership({ elements: net.elements, ring, toLonLat: toLL });
  const ids = new Set(net.elements.map(e => (['IfcDistributionPort', 'IfcSite', 'IfcElementAssembly'].includes(e.ifcClass) ? null : e.networkId ?? e.tag)).filter(Boolean));
  assert.equal(Object.keys(all.relations).length, ids.size);
  assert.equal(all.outside, 0, 'a 4 km square around the origin holds the whole fixture');
  void geodeticToEcef; void defaultPlacement;
});
