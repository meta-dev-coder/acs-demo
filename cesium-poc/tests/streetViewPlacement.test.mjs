import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BEARING_SPAN_VERTICES, CORRIDOR_BEARING_RANGE_M, PLACEMENT_RADII_M, bearingDegrees, corridorHeadingAt,
  nearestCorridorPoint, placementCacheKey,
} from '../src/streetViewPlacement.js';

const corridor = JSON.parse(readFileSync(new URL('../config/corridorCenterline.json', import.meta.url)));

test('the drop snaps to the nearest corridor vertex', () => {
  const vertex = corridor[120];
  const near = nearestCorridorPoint(corridor, vertex.lon + 0.0002, vertex.lat + 0.0002);
  assert.equal(near.index, 120);
  assert.ok(near.distanceM < 40, `${near.distanceM} m`);
  assert.deepEqual(near.point, vertex);
  assert.equal(nearestCorridorPoint([], -80, 26), null);
  assert.equal(nearestCorridorPoint(undefined, -80, 26), null);
});

test('heading follows the road, and reverses for the other carriageway', () => {
  const point = corridor[120];
  const eastbound = corridorHeadingAt(corridor, point.lon, point.lat, 'EB');
  const westbound = corridorHeadingAt(corridor, point.lon, point.lat, 'WB');
  // I-595 runs broadly east here, so eastbound points into the eastern quadrant.
  assert.ok(eastbound > 60 && eastbound < 130, `eastbound ${eastbound}`);
  const apart = (((westbound - eastbound) % 360) + 360) % 360;
  assert.ok(Math.abs(apart - 180) < 0.001, `westbound is the reverse, was ${apart.toFixed(3)}° apart`);
  // No direction given is treated as travelling east, matching the stored geometry order.
  assert.equal(corridorHeadingAt(corridor, point.lon, point.lat), eastbound);
});

test('the heading varies along the corridor rather than being one constant', () => {
  const headings = [20, 80, 140, 200, 260].map(index =>
    corridorHeadingAt(corridor, corridor[index].lon, corridor[index].lat, 'EB'));
  assert.ok(headings.every(Number.isFinite));
  assert.ok(new Set(headings.map(h => Math.round(h))).size > 1, 'the bearing must track the road');
  // And every one of them still points broadly east, because the corridor does.
  // Smoothed over several vertices, every bearing tracks the carriageway rather than survey jitter.
  for (const heading of headings) assert.ok(heading > 60 && heading < 130, `heading ${heading}`);
  assert.ok(Math.max(...headings) - Math.min(...headings) < 30, 'the corridor does not swing wildly');
});

test('a drop far from the corridor takes no bearing from it', () => {
  assert.equal(corridorHeadingAt(corridor, -80.42, 26.28, 'EB'), null, 'miles away: no claim about direction');
  const point = corridor[120];
  // Just outside the range the corridor is allowed to speak for.
  const offset = (CORRIDOR_BEARING_RANGE_M + 200) / 111320;
  assert.equal(corridorHeadingAt(corridor, point.lon, point.lat + offset, 'EB'), null);
  assert.ok(Number.isFinite(corridorHeadingAt(corridor, point.lon, point.lat + offset / 8, 'EB')));
});

test('bearings are measured clockwise from north', () => {
  const origin = { lon: -80.25, lat: 26.1 };
  assert.ok(Math.abs(bearingDegrees(origin, { lon: -80.25, lat: 26.2 }) - 0) < 0.001, 'north');
  assert.ok(Math.abs(bearingDegrees(origin, { lon: -80.15, lat: 26.1 }) - 90) < 0.5, 'east');
  assert.ok(Math.abs(bearingDegrees(origin, { lon: -80.25, lat: 26.0 }) - 180) < 0.001, 'south');
  assert.ok(Math.abs(bearingDegrees(origin, { lon: -80.35, lat: 26.1 }) - 270) < 0.5, 'west');
});

test('lookups widen once rather than snapping the user far away', () => {
  assert.deepEqual([...PLACEMENT_RADII_M].sort((a, b) => a - b), [...PLACEMENT_RADII_M]);
  assert.ok(PLACEMENT_RADII_M[0] >= 50 && PLACEMENT_RADII_M[0] <= 100, 'starts close in');
  assert.ok(PLACEMENT_RADII_M.at(-1) <= 300, 'never drags the drop hundreds of metres, let alone kilometres');
  assert.equal(PLACEMENT_RADII_M.length, 2, 'one widening, not an escalating series of requests');
});

test('nearby drops share one cached answer, distant ones do not', () => {
  // Roughly a 10 m grid: sweeping the same stretch must not re-ask Google for every pixel.
  assert.equal(placementCacheKey(-80.25001, 26.10001), placementCacheKey(-80.250012, 26.100013));
  assert.notEqual(placementCacheKey(-80.25, 26.1), placementCacheKey(-80.26, 26.1));
});

test('the bearing is read over enough road to ignore survey jitter', () => {
  assert.ok(BEARING_SPAN_VERTICES >= 2, 'a single vertex-to-vertex tangent is too noisy to face a camera by');
  const point = corridor[20];
  // This vertex has a local jog; smoothing keeps the heading on the carriageway.
  assert.ok(Math.abs(corridorHeadingAt(corridor, point.lon, point.lat, 'EB') - 109) < 12);
});
