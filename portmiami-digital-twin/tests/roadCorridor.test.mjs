/**
 * The proposed-road corridor: metres, not degrees.
 *
 * The test that matters most is the one about width. A corridor offset in degrees is wider
 * north-south than east-west at this latitude, by about a tenth, and it looks right only on a
 * north-up screenshot. So these tests measure the finished polygon on the ground and insist it
 * is the stated width whichever way the road runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MITRE_LIMIT, centrelineLengthM, cleanCentreline, ringAreaM2, roadCorridorRing, roadQuantities,
} from '../src/designs/roadCorridor.js';
import { enuToLonLat, lonLatToEnu } from '../src/scenarios/garagePlacement.js';

const ORIGIN = [-80.1731, 25.7795];
const at = (east, north) => enuToLonLat(ORIGIN, east, north);
const metresBetween = (a, b) => Math.hypot(...lonLatToEnu(a, b));

/** The corridor's width measured across the middle of a straight road. */
function measuredWidth(ring) {
  // A straight two-point road makes a 4-corner ring: left-start, left-end, right-end, right-start.
  return metresBetween(ring[0], ring[3]);
}

test('a straight road is exactly the stated width, running north', () => {
  const ring = roadCorridorRing([at(0, 0), at(0, 200)], 7.5);
  assert.equal(ring.length, 5, 'four corners, closed');
  assert.ok(Math.abs(measuredWidth(ring) - 7.5) < 0.02, `${measuredWidth(ring)}`);
});

test('and exactly the same width running east — the frame is metric, not angular', () => {
  const north = roadCorridorRing([at(0, 0), at(0, 200)], 7.5);
  const east = roadCorridorRing([at(0, 0), at(200, 0)], 7.5);
  const difference = Math.abs(measuredWidth(north) - measuredWidth(east));
  assert.ok(difference < 0.02, `north ${measuredWidth(north)} vs east ${measuredWidth(east)}`);
});

test('a road at an arbitrary bearing keeps its width', () => {
  for (const bearing of [17, 45, 123, 250, 310]) {
    const radians = bearing * Math.PI / 180;
    const ring = roadCorridorRing(
      [at(0, 0), at(Math.sin(radians) * 180, Math.cos(radians) * 180)], 12);
    assert.ok(Math.abs(measuredWidth(ring) - 12) < 0.03, `${bearing}: ${measuredWidth(ring)}`);
  }
});

test('centreline length is the ground distance, summed segment by segment', () => {
  assert.ok(Math.abs(centrelineLengthM([at(0, 0), at(0, 300)]) - 300) < 0.02);
  assert.ok(Math.abs(centrelineLengthM([at(0, 0), at(0, 100), at(100, 100)]) - 200) < 0.05);
  assert.equal(centrelineLengthM([at(0, 0)]), 0, 'one point is no road');
  assert.equal(centrelineLengthM([]), 0);
});

test('a curved alignment keeps its width through the bend', () => {
  // A quarter circle of radius 120 m, sampled every 10 degrees.
  const arc = [];
  for (let degrees = 0; degrees <= 90; degrees += 10) {
    const radians = degrees * Math.PI / 180;
    arc.push(at(120 * Math.sin(radians), 120 * (1 - Math.cos(radians))));
  }
  const ring = roadCorridorRing(arc, 10);
  const half = (ring.length - 1) / 2;
  // Each centreline vertex has a left and a right offset; they must stay 10 m apart.
  for (let i = 0; i < half; i += 1) {
    const width = metresBetween(ring[i], ring[ring.length - 2 - i]);
    assert.ok(Math.abs(width - 10) < 0.25, `vertex ${i}: ${width} m`);
  }
});

test('a hairpin bevels instead of spiking off to infinity', () => {
  // Doubling back almost on itself: an unlimited mitre would throw the corner kilometres away.
  const ring = roadCorridorRing([at(0, 0), at(0, 100), at(2, 0)], 10);
  for (const point of ring) {
    assert.ok(metresBetween(ORIGIN, point) < 100 + MITRE_LIMIT * 10,
      `a corner landed ${Math.round(metresBetween(ORIGIN, point))} m out`);
  }
});

test('an alignment that doubles back exactly still produces a polygon', () => {
  const ring = roadCorridorRing([at(0, 0), at(0, 100), at(0, 0)], 8);
  assert.ok(Array.isArray(ring) && ring.length >= 5);
  assert.ok(ring.every(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat)));
});

test('a road that cannot be built is null, never a sliver', () => {
  assert.equal(roadCorridorRing([at(0, 0)], 7), null, 'one point');
  assert.equal(roadCorridorRing([], 7), null, 'no points');
  assert.equal(roadCorridorRing([at(0, 0), at(0, 100)], 0), null, 'no width');
  assert.equal(roadCorridorRing([at(0, 0), at(0, 100)], Number.NaN), null, 'width NaN');
  assert.equal(roadCorridorRing(null, 7), null);
});

test('duplicate and non-finite vertices are dropped rather than breaking the normals', () => {
  const messy = [at(0, 0), at(0, 0), ['x', 'y'], at(0, 0.05), at(0, 200), null];
  assert.equal(cleanCentreline(messy).length, 2);
  const ring = roadCorridorRing(messy, 9);
  assert.ok(Math.abs(measuredWidth(ring) - 9) < 0.03);
});

test('ring area is ground area, so a square of 100 m is 10,000 m²', () => {
  const square = [at(0, 0), at(100, 0), at(100, 100), at(0, 100), at(0, 0)];
  assert.ok(Math.abs(ringAreaM2(square) - 10000) < 2, `${ringAreaM2(square)}`);
  assert.equal(ringAreaM2([at(0, 0), at(1, 1)]), 0, 'not a ring');
});

test('quantities report what they measured and how', () => {
  const q = roadQuantities({ coordinates: [at(0, 0), at(0, 400)], widthM: 7.5, lanes: 2 });
  assert.ok(Math.abs(q.lengthM - 400) < 0.05);
  assert.equal(q.widthM, 7.5);
  assert.equal(q.lanes, 2);
  assert.equal(q.areaBasis, 'CORRIDOR_POLYGON');
  // A straight road's polygon is its length x width, to within the mitre at the ends.
  assert.ok(Math.abs(q.surfaceAreaM2 - 3000) < 5, `${q.surfaceAreaM2}`);
  assert.equal(q.vertices, 2);
});

test('quantities fall back to length x width when no polygon can be made, and say so', () => {
  const q = roadQuantities({ coordinates: [at(0, 0)], widthM: 7.5 });
  assert.equal(q.lengthM, 0);
  assert.equal(q.areaBasis, 'LENGTH_X_WIDTH');
});
