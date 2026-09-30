import test from 'node:test';
import assert from 'node:assert/strict';
import { nearestOnPath, ribbonsFor, sliceAround, RIBBON_REACH_M } from '../src/safety/crashRibbon.js';
import { metresBetween } from '../src/safety/crashHotspots.js';

/** A straight run of road heading east, one vertex every ~50 m. 0.0005 deg lon ~= 50 m here. */
const road = Array.from({ length: 41 }, (_, i) => ({ longitude: -80.3 + i * 0.0005, latitude: 26.06 }));
const lengthOf = path => path.slice(1).reduce((total, point, i) => total + metresBetween(path[i], point), 0);

test('the closest point is found ON the road, not at its nearest vertex', () => {
  const near = nearestOnPath(road, { longitude: road[20].longitude, latitude: 26.0603 });
  // What matters is the point, not which leg it fell on: it is the crash's own place on the road.
  assert.ok(Math.abs(near.at.longitude - road[20].longitude) < 1e-9);
  assert.ok(near.metres < 40, `expected the offset across the carriageway, got ${Math.round(near.metres)} m`);
  assert.equal(nearestOnPath([], { longitude: 0, latitude: 0 }), null);

  // Halfway along a 2 km leg: to a vertex this is ~800 m away and out of reach, which used to make
  // the place paint nothing at all. On the leg it is a few metres off the road.
  const coarse = [{ longitude: -80.3, latitude: 26.06 }, { longitude: -80.28, latitude: 26.06 }];
  const mid = nearestOnPath(coarse, { longitude: -80.29, latitude: 26.0603 });
  assert.ok(mid.metres < 40, `expected to land on the leg, got ${Math.round(mid.metres)} m`);
});

test('a place is painted the length of road it claims, measured along the road', () => {
  const slice = sliceAround(road, road[20], 100);
  const length = lengthOf(slice);
  // 100 m each way, walked vertex to vertex, so the run is 200 m give or take one leg.
  assert.ok(length >= 200 && length <= 300, `expected ~200-300 m of road, got ${Math.round(length)} m`);
  assert.ok(slice.length > 1, 'a painted stretch is a line, never a single point');
});

test('a place off the corridor paints nothing rather than the nearest road it can find', () => {
  // Half a kilometre north: this crash was not on this road, and guessing would be a false claim.
  assert.deepEqual(sliceAround(road, { longitude: -80.295, latitude: 26.065 }, 100), []);
  assert.ok(RIBBON_REACH_M < 500);
});

test('the walk stops at the end of the road instead of wrapping to the other end', () => {
  const atEnd = sliceAround(road, road[road.length - 1], 300);
  assert.equal(atEnd[atEnd.length - 1].longitude, road[road.length - 1].longitude);
  assert.ok(atEnd.every(point => point.longitude <= road[road.length - 1].longitude),
    'nothing painted past the end of the corridor');
});

test('a coarse road is cut to the length claimed, not to its next vertex', () => {
  // The real corridor has legs up to 1.4 km. Taking whole legs painted 8.5 km of road for a 100 m
  // claim, which is how one crash turned half the map green.
  const coarse = [{ longitude: -80.3, latitude: 26.06 }, { longitude: -80.28, latitude: 26.06 }];
  assert.ok(lengthOf(coarse) > 1900, 'the fixture really is one huge leg');
  const slice = sliceAround(coarse, coarse[0], 100);
  const painted = lengthOf(slice);
  assert.ok(Math.abs(painted - 100) < 2, `expected ~100 m of road, got ${Math.round(painted)} m`);
});

test('the painted run is the claimed length however the road is drawn', () => {
  // Same 100 m either way, on a fine road and a coarse one: the answer must come from the request,
  // never from how the geometry happens to be published.
  const fine = Array.from({ length: 81 }, (_, i) => ({ longitude: -80.3 + i * 0.0002, latitude: 26.06 }));
  const coarse = [{ longitude: -80.3, latitude: 26.06 }, { longitude: -80.284, latitude: 26.06 }];
  const mid = { longitude: -80.292, latitude: 26.06 };
  for (const [name, road] of [['fine', fine], ['coarse', coarse]]) {
    const painted = lengthOf(sliceAround(road, mid, 100));
    assert.ok(Math.abs(painted - 200) < 5, `${name}: expected ~200 m, got ${Math.round(painted)} m`);
  }
});

test('overlapping places resolve towards the worse band, whatever order they arrive in', () => {
  const mild = { id: 'mild', longitude: road[20].longitude, latitude: 26.06, score: 2 };
  const bad = { id: 'bad', longitude: road[21].longitude, latitude: 26.06, score: 40 };
  for (const order of [[mild, bad], [bad, mild]]) {
    const ribbons = ribbonsFor(order, [road], 100);
    assert.equal(ribbons[ribbons.length - 1].place.id, 'bad', 'the worse place is drawn last, so it wins');
  }
});

test('each carriageway is painted in its own right', () => {
  const westbound = road.map(point => ({ ...point, latitude: 26.0604 }));
  const ribbons = ribbonsFor([{ id: 'x', longitude: road[20].longitude, latitude: 26.0602, score: 5 }],
    [road, westbound], 100);
  assert.equal(ribbons.length, 2, 'both carriageways carry the place');
});
