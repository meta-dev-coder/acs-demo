/**
 * The site-conflict check.
 *
 * The test that matters most is the one about absence: a layer that has not loaded must come back
 * NOT_EVALUATED, never CLEAR. An empty result reading as a green light is the failure this module
 * exists to prevent, so it is asserted from both directions — a missing layer is not clear, and a
 * clear layer is not silently treated as evaluated for the things nobody checked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFLICT_STATUS, ROAD_CLEARANCE_M, checkSiteConflicts } from '../src/scenarios/siteConflicts.js';
import { createPlacement, enuToLonLat, placementRing } from '../src/scenarios/garagePlacement.js';

const SITE = [-80.1731, 25.7795];
const ring = (patch = {}) => placementRing(createPlacement({ point: SITE, lengthM: 60, widthM: 40, ...patch }));
const find = (report, id) => report.checks.find(check => check.id === id);

/** A square building footprint `offsetM` metres east of the site. */
const buildingAt = (offsetEastM, sideM = 20, objectId = 1) => ({
  properties: { OBJECTID: objectId },
  geometry: {
    type: 'Polygon',
    coordinates: [[
      enuToLonLat(SITE, offsetEastM - sideM / 2, -sideM / 2),
      enuToLonLat(SITE, offsetEastM + sideM / 2, -sideM / 2),
      enuToLonLat(SITE, offsetEastM + sideM / 2, sideM / 2),
      enuToLonLat(SITE, offsetEastM - sideM / 2, sideM / 2),
      enuToLonLat(SITE, offsetEastM - sideM / 2, -sideM / 2),
    ]],
  },
});

/** A north-south road `offsetM` metres east of the site. */
const roadAt = (offsetEastM, name = 'N CRUISE BLVD', objectId = 7) => ({
  objectId, name,
  coordinates: [enuToLonLat(SITE, offsetEastM, -200), enuToLonLat(SITE, offsetEastM, 200)],
});

test('a building under the footprint is reported as a conflict, by OBJECTID', () => {
  const report = checkSiteConflicts(ring(), { buildings: [buildingAt(0, 20, 794643)], roads: [] });
  const buildings = find(report, 'buildings');
  assert.equal(buildings.status, CONFLICT_STATUS.CONFLICT);
  assert.match(buildings.detail, /794643/);
  assert.ok(report.conflicts >= 1);
});

test('a building well clear of the footprint is not', () => {
  const report = checkSiteConflicts(ring(), { buildings: [buildingAt(300)], roads: [] });
  assert.equal(find(report, 'buildings').status, CONFLICT_STATUS.CLEAR);
});

test('a footprint entirely inside a larger building still conflicts', () => {
  const report = checkSiteConflicts(ring(), { buildings: [buildingAt(0, 400)], roads: [] });
  assert.equal(find(report, 'buildings').status, CONFLICT_STATUS.CONFLICT);
});

test('a road through the footprint is reported, and named', () => {
  const report = checkSiteConflicts(ring(), { buildings: [], roads: [roadAt(0)] });
  const roads = find(report, 'roads');
  assert.equal(roads.status, CONFLICT_STATUS.CONFLICT);
  assert.match(roads.detail, /N CRUISE BLVD/);
});

test('a road just outside the assumed clearance is clear; just inside is not', () => {
  // The footprint is 40 m wide, so its edge is 20 m east of the centre.
  const inside = checkSiteConflicts(ring(), { buildings: [], roads: [roadAt(20 + ROAD_CLEARANCE_M - 2)] });
  const outside = checkSiteConflicts(ring(), { buildings: [], roads: [roadAt(20 + ROAD_CLEARANCE_M + 5)] });
  assert.equal(find(inside, 'roads').status, CONFLICT_STATUS.CONFLICT);
  assert.equal(find(outside, 'roads').status, CONFLICT_STATUS.CLEAR);
});

test('the road result says it tested a centreline against an assumed clearance', () => {
  const conflict = find(checkSiteConflicts(ring(), { buildings: [], roads: [roadAt(0)] }), 'roads');
  assert.match(conflict.detail, /centreline/i);
  assert.match(conflict.detail, /no carriageway width/i);
  const clear = find(checkSiteConflicts(ring(), { buildings: [], roads: [roadAt(300)] }), 'roads');
  assert.match(clear.detail, /not published/i, 'even a clear result states what it could not test');
});

test('a layer that has not loaded is Not evaluated, never clear', () => {
  const report = checkSiteConflicts(ring(), { buildings: null, roads: null });
  assert.equal(find(report, 'buildings').status, CONFLICT_STATUS.NOT_EVALUATED);
  assert.equal(find(report, 'roads').status, CONFLICT_STATUS.NOT_EVALUATED);
  assert.equal(report.conflicts, 0, 'nothing is claimed as a conflict either');
  assert.equal(report.evaluated, 0, 'and nothing is claimed as evaluated');
});

test('the things this twin does not hold are always stated, even when both layers are clear', () => {
  const report = checkSiteConflicts(ring(), { buildings: [], roads: [] });
  for (const id of ['boundaries', 'water', 'utilities', 'tenure']) {
    assert.equal(find(report, id).status, CONFLICT_STATUS.NOT_EVALUATED, id);
  }
  assert.equal(report.conflicts, 0);
  assert.equal(report.evaluated, 2, 'only the two layers that exist count as evaluated');
});

test('no placement yet is Not evaluated, not clear', () => {
  const report = checkSiteConflicts(null, { buildings: [], roads: [] });
  assert.equal(report.checks[0].status, CONFLICT_STATUS.NOT_EVALUATED);
  assert.equal(report.evaluated, 0);
});

test('rotating a footprint onto a road finds the road the un-rotated one missed', () => {
  // A long thin building pointing north misses a road 40 m east; turned east, it reaches it.
  const road = roadAt(40);
  const northwards = checkSiteConflicts(ring({ lengthM: 120, widthM: 20, headingDeg: 0 }),
    { buildings: [], roads: [road] });
  const eastwards = checkSiteConflicts(ring({ lengthM: 120, widthM: 20, headingDeg: 90 }),
    { buildings: [], roads: [road] });
  assert.equal(find(northwards, 'roads').status, CONFLICT_STATUS.CLEAR);
  assert.equal(find(eastwards, 'roads').status, CONFLICT_STATUS.CONFLICT);
});

test('a MultiPolygon building is tested part by part', () => {
  const far = buildingAt(300).geometry.coordinates;
  const near = buildingAt(0).geometry.coordinates;
  const report = checkSiteConflicts(ring(), {
    buildings: [{ properties: { OBJECTID: 5 }, geometry: { type: 'MultiPolygon', coordinates: [far, near] } }],
    roads: [],
  });
  assert.equal(find(report, 'buildings').status, CONFLICT_STATUS.CONFLICT);
});

test("the app's own building record shape is accepted, not only GeoJSON", () => {
  // `useBuildings` hands over `{objectId, rings, bounds}`, not a GeoJSON feature.
  const feature = buildingAt(0, 20, 991);
  const outer = feature.geometry.coordinates[0];
  const lons = outer.map(([lon]) => lon), lats = outer.map(([, lat]) => lat);
  const record = {
    objectId: 991,
    rings: [outer],
    bounds: {
      west: Math.min(...lons), east: Math.max(...lons),
      south: Math.min(...lats), north: Math.max(...lats),
    },
  };
  const report = checkSiteConflicts(ring(), { buildings: [record], roads: [] });
  assert.equal(find(report, 'buildings').status, CONFLICT_STATUS.CONFLICT);
  assert.match(find(report, 'buildings').detail, /991/);
});

test('a building whose bounding box is far away is skipped, not mis-reported', () => {
  const record = {
    objectId: 7, rings: [buildingAt(0, 20).geometry.coordinates[0]],
    bounds: { west: -80.3, east: -80.29, south: 25.6, north: 25.61 },
  };
  const report = checkSiteConflicts(ring(), { buildings: [record], roads: [] });
  assert.equal(find(report, 'buildings').status, CONFLICT_STATUS.CLEAR);
});
