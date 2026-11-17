/**
 * Street View tests.
 *
 * The service tests are ported from the ACS I-595 twin (`cesium-poc/tests/streetViewService.test.mjs`)
 * because the module they cover is ported unchanged. The placement/heading tests are NOT ported:
 * the ACS ones exercise a single surveyed corridor centreline with a 4-vertex bearing average, and
 * that is the rule this project deliberately does not use — see the header of
 * src/streetView/streetViewHeading.js. These run against the real 2,362-segment road network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { classifyLookupFailure, formatImageryDate, PANORAMA_SEARCH_RADIUS_M } from '../src/streetView/streetViewService.js';
import {
  ROAD_BEARING_RANGE_M, bearingDegrees, metresBetween, nearestRoadEdge, streetViewPlacementAt,
} from '../src/streetView/streetViewHeading.js';
import { PLACEMENT_RADII_M, placementCacheKey } from '../src/cesium/streetViewPlacement.js';
import { buildRoadSegments } from '../src/roads/roadModel.js';

const ROADS = fileURLToPath(new URL('../public/data/portmiami_roads_merged.geojson', import.meta.url));
let cached;
const segments = () => (cached ??= buildRoadSegments(JSON.parse(readFileSync(ROADS, 'utf8'))));

const failure = status =>
  new Error(`GoogleStreetViewCubeMapPanoramaProvider metadata error: ${status}`);

// =============================================================================================
// The lookup service (ported from ACS, covering a module ported unchanged)
// =============================================================================================

test('service: "no panorama here" is an answer, not a fault', () => {
  for (const status of ['ZERO_RESULTS', 'NOT_FOUND']) {
    const result = classifyLookupFailure(failure(status));
    assert.equal(result.status, 'none', `${status} means there simply is no imagery there`);
    assert.match(result.message, /isn’t available near this location/);
    // Nothing raw from Google reaches the viewer.
    assert.ok(!result.message.includes(status));
  }
});

test('service: key, quota and request problems are told apart and explained plainly', () => {
  const denied = classifyLookupFailure(failure('REQUEST_DENIED'));
  assert.equal(denied.status, 'unavailable');
  assert.match(denied.message, /not enabled for this map key/);
  const quota = classifyLookupFailure(failure('OVER_QUERY_LIMIT'));
  assert.equal(quota.status, 'unavailable');
  assert.match(quota.message, /quota/);
  // Each keeps the technical status for the log, without putting it on screen.
  assert.equal(denied.reason, 'REQUEST_DENIED');
  assert.equal(quota.reason, 'OVER_QUERY_LIMIT');
});

test('service: an unrecognised or network failure still yields a usable message', () => {
  for (const error of [failure('UNKNOWN_ERROR'), new Error('NetworkError when fetching'), undefined, null]) {
    const result = classifyLookupFailure(error);
    assert.equal(result.status, 'unavailable');
    assert.ok(result.message.length > 0);
    assert.ok(!/undefined|null|\[object/.test(result.message));
  }
});

test('service: imagery dates read as dates, and never as a live timestamp', () => {
  assert.equal(formatImageryDate('2016-12'), 'Dec 2016');
  assert.equal(formatImageryDate('2026-02'), 'Feb 2026');
  for (const value of ['', undefined, null, '2016', 'yesterday', '2016-13-99']) {
    assert.equal(formatImageryDate(value), null, `"${value}" must not be presented as a date`);
  }
});

test('service: the default search radius is a street width, not a neighbourhood', () => {
  assert.ok(PANORAMA_SEARCH_RADIUS_M > 0 && PANORAMA_SEARCH_RADIUS_M <= 100);
});

// =============================================================================================
// Bearing arithmetic
// =============================================================================================

test('heading: bearings are measured clockwise from north', () => {
  const origin = [-80.17, 25.78];
  assert.ok(Math.abs(bearingDegrees(origin, [-80.17, 25.88]) - 0) < 0.001, 'north');
  assert.ok(Math.abs(bearingDegrees(origin, [-80.07, 25.78]) - 90) < 0.5, 'east');
  assert.ok(Math.abs(bearingDegrees(origin, [-80.17, 25.68]) - 180) < 0.001, 'south');
  assert.ok(Math.abs(bearingDegrees(origin, [-80.27, 25.78]) - 270) < 0.5, 'west');
});

test('heading: distances are metres, and match a hand-checked value', () => {
  // 0.001 degrees of latitude is ~111 m.
  assert.ok(Math.abs(metresBetween([-80.17, 25.78], [-80.17, 25.781]) - 111.3) < 1);
  assert.equal(metresBetween([-80.17, 25.78], [-80.17, 25.78]), 0);
});

// =============================================================================================
// Placement against the REAL PortMiami road network
// =============================================================================================

test('[fixture] heading: a drop on a road takes that road’s own name and bearing', () => {
  // The midpoint of OBJECTID 14302, PORT BLVD.
  const placement = streetViewPlacementAt(segments(), [-80.164243, 25.771415]);
  assert.equal(placement.roadName, 'PORT BLVD');
  assert.equal(placement.roadObjectId, 14302);
  assert.ok(placement.distanceM < 1, `on the line: ${placement.distanceM} m`);
  assert.ok(Number.isFinite(placement.headingDeg));
  assert.equal(placement.label, 'PORT BLVD');
});

test('[fixture] heading: the bearing follows the road it was read from', () => {
  // PORT BLVD runs broadly east-west here, so its bearing is in an east or west quadrant.
  const { headingDeg } = streetViewPlacementAt(segments(), [-80.164243, 25.771415]);
  const eastOrWest = (headingDeg > 60 && headingDeg < 130) || (headingDeg > 240 && headingDeg < 310);
  assert.ok(eastOrWest, `PORT BLVD bearing was ${headingDeg}`);
});

test('[fixture] heading: different roads give different bearings', () => {
  const headings = [
    [-80.164243, 25.771415],   // PORT BLVD
    [-80.177956, 25.777708],   // N AMERICA WAY
    [-80.177674, 25.775051],   // CARIBBEAN WAY
  ].map(point => Math.round(streetViewPlacementAt(segments(), point).headingDeg));
  assert.ok(headings.every(Number.isFinite));
  assert.ok(new Set(headings).size > 1, 'the bearing must track the road, not be a constant');
});

test('[fixture] heading: a drop far from every centreline claims no direction', () => {
  // Well out in Biscayne Bay, past the range any road may speak for.
  const placement = streetViewPlacementAt(segments(), [-80.12, 25.73]);
  assert.equal(placement.headingDeg, null, 'no road near: no claim about which way to face');
  assert.equal(placement.roadName, null);
  assert.equal(placement.roadObjectId, null);
  assert.equal(placement.label, 'PortMiami study area');
});

test('heading: the range a road may speak for is bounded', () => {
  // On a one-road network, so the boundary is actually reachable. Against the REAL network this
  // cannot be tested by stepping away from a road: downtown Miami has another street roughly
  // every 100 m, so a drop 180 m off Port Blvd is legitimately within range of a different one.
  const network = [{ objectId: 1, name: 'LONE ST', coordinates: [[-80.170, 25.780], [-80.160, 25.780]] }];
  const north = metres => [-80.165, 25.780 + metres / 111_320];
  assert.ok(Number.isFinite(streetViewPlacementAt(network, north(ROAD_BEARING_RANGE_M - 20)).headingDeg));
  assert.equal(streetViewPlacementAt(network, north(ROAD_BEARING_RANGE_M + 20)).headingDeg, null);
  assert.equal(streetViewPlacementAt(network, north(ROAD_BEARING_RANGE_M + 20)).label, 'PortMiami study area');
});

test('[fixture] heading: on the real network a drop is attributed to the road it is nearest', () => {
  // Stepping north from Port Blvd eventually reaches a DIFFERENT street rather than nothing,
  // which is the correct answer in a dense grid: the attribution changes, it does not vanish.
  const onPortBlvd = streetViewPlacementAt(segments(), [-80.164243, 25.771415]);
  const stepped = streetViewPlacementAt(segments(), [-80.164243, 25.771415 + 180 / 111_320]);
  assert.equal(onPortBlvd.roadName, 'PORT BLVD');
  assert.ok(stepped.roadObjectId !== onPortBlvd.roadObjectId || stepped.headingDeg === null,
    'a drop 180 m away belongs to another segment, or to none');
  if (stepped.roadObjectId != null) assert.ok(stepped.distanceM <= ROAD_BEARING_RANGE_M);
});

test('[fixture] heading: an unnamed segment is labelled by its OBJECTID, never invented', () => {
  const unnamed = segments().find(segment => !segment.name);
  assert.ok(unnamed, 'the network contains unnamed segments');
  const placement = streetViewPlacementAt(segments(), unnamed.midpoint);
  assert.equal(placement.roadName, null);
  assert.match(placement.label, /^Unnamed road · segment \d+$/);
});

test('heading: the nearest EDGE is used, not the nearest whole segment', () => {
  // An L-shaped segment: the drop sits beside its second leg, which runs north. Averaging across
  // the whole segment — the ACS rule — would return something between the two legs.
  const network = [{
    objectId: 1, name: 'ELBOW ST',
    coordinates: [[-80.170, 25.780], [-80.160, 25.780], [-80.160, 25.790]],
  }];
  const placement = streetViewPlacementAt(network, [-80.16005, 25.7850]);
  assert.ok(Math.abs(placement.headingDeg - 0) < 1 || Math.abs(placement.headingDeg - 360) < 1,
    `the northward leg, got ${placement.headingDeg}`);
  const edge = nearestRoadEdge(network, [-80.16005, 25.7850]);
  assert.deepEqual(edge.from, [-80.160, 25.780]);
  assert.deepEqual(edge.to, [-80.160, 25.790]);
});

test('heading: a two-point segment uses its own direction, which is the common case here', () => {
  // Median vertices per segment in this dataset is 2, which is why the edge IS the road direction.
  const twoPoint = segments().filter(segment => segment.coordinates.length === 2);
  assert.ok(twoPoint.length > segments().length / 2, 'most segments are two-point');
  const segment = twoPoint.find(s => s.name);
  const placement = streetViewPlacementAt([segment], segment.midpoint);
  assert.ok(Math.abs(placement.headingDeg - bearingDegrees(segment.coordinates[0], segment.coordinates[1])) < 0.001);
});

test('heading: an empty or missing network is handled, not thrown on', () => {
  assert.equal(nearestRoadEdge([], [-80.17, 25.78]), null);
  assert.equal(nearestRoadEdge(undefined, [-80.17, 25.78]), null);
  assert.equal(streetViewPlacementAt([], [-80.17, 25.78]).headingDeg, null);
});

// =============================================================================================
// Placement policy (ported from ACS — the reasoning is unchanged)
// =============================================================================================

test('placement: lookups widen once rather than snapping the viewer far away', () => {
  assert.deepEqual([...PLACEMENT_RADII_M].sort((a, b) => a - b), [...PLACEMENT_RADII_M]);
  assert.ok(PLACEMENT_RADII_M[0] >= 50 && PLACEMENT_RADII_M[0] <= 100, 'starts close in');
  assert.ok(PLACEMENT_RADII_M.at(-1) <= 300, 'never drags the drop hundreds of metres');
  assert.equal(PLACEMENT_RADII_M.length, 2, 'one widening, not an escalating series of requests');
});

test('placement: nearby drops share one cached answer, distant ones do not', () => {
  // Roughly a 10 m grid: sweeping the same stretch must not re-ask Google for every pixel.
  assert.equal(placementCacheKey(-80.17001, 25.78001), placementCacheKey(-80.170012, 25.780013));
  assert.notEqual(placementCacheKey(-80.17, 25.78), placementCacheKey(-80.18, 25.78));
});
