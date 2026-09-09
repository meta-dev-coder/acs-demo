import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { corridorOverview, westernGateway, westernTerminus } from '../src/i595CorridorViews.js';
import { shieldPlacements } from '../src/i595ShieldData.js';

const corridor = JSON.parse(readFileSync(new URL('../config/corridorCenterline.json', import.meta.url)));
const METRES_PER_DEGREE = 111320;
const distance = (a, b) => Math.hypot((b.lon - a.lon) * Math.cos(a.lat * Math.PI / 180), b.lat - a.lat) * METRES_PER_DEGREE;

test('startup and reset stay two different views', () => {
  const overview = corridorOverview(corridor), gateway = westernGateway(corridor);
  assert.equal(overview.height, 24000);
  assert.equal(gateway.height, 1500);
  const lons = corridor.map(p => p.lon), span = Math.max(...lons) - Math.min(...lons);
  // Reset frames the middle of the corridor; startup frames its western end. Different views.
  assert.ok(gateway.focus.lon < Math.min(...lons) + span * 0.2, 'startup stays at the western end');
  assert.ok(overview.lon > Math.min(...lons) + span * 0.4, 'reset stays on the whole corridor');
});

test('reset view keeps the full corridor extent, straight down', () => {
  const lons = corridor.map(p => p.lon), lats = corridor.map(p => p.lat);
  assert.deepEqual(corridorOverview(corridor), {
    lon: (Math.min(...lons) + Math.max(...lons)) / 2,
    lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    height: 24000, headingDeg: 0, pitchDeg: -90, rollDeg: 0,
  });
});

test('startup view is north-up, never turned down the corridor', () => {
  const gateway = westernGateway(corridor);
  assert.equal(gateway.headingDeg, 0, 'north stays at the top of the screen');
  assert.equal(gateway.rollDeg, 0);
  assert.ok(gateway.pitchDeg >= -85 && gateway.pitchDeg <= -70, 'near-nadir, like a road map');
});

test('startup centres the second route shield, on real corridor geometry', () => {
  const gateway = westernGateway(corridor), shields = shieldPlacements(corridor);
  assert.equal(gateway.focus.lon, shields[1].lon);
  assert.equal(gateway.focus.lat, shields[1].lat);
  assert.equal(shields[1].id, 'i595-shield-sw-136th-ave');
  // Which means the focus is a real centerline vertex, never a typed-in point.
  assert.ok(corridor.some(p => p.lon === gateway.focus.lon && p.lat === gateway.focus.lat));
  assert.ok(distance(westernTerminus(corridor), gateway.focus) < 5000, 'startup stays at the western end');
  // Looking due north, the camera stands south of its focus by exactly the tilt's ground reach.
  const standoff = gateway.height / Math.tan(-gateway.pitchDeg * Math.PI / 180);
  assert.ok(Math.abs(distance(gateway, gateway.focus) - standoff) < 25, 'standoff must match the camera tilt');
  assert.equal(gateway.lon, gateway.focus.lon, 'camera sits due south of its focus');
  assert.ok(gateway.lat < gateway.focus.lat);
});

test('startup height stays close in and is overridable', () => {
  assert.ok(westernGateway(corridor).height >= 1200 && westernGateway(corridor).height <= 2000);
  assert.equal(westernGateway(corridor, { height: 1800 }).height, 1800);
});

test('both views reject an unusable centerline', () => {
  for (const view of [corridorOverview, westernGateway]) {
    assert.throws(() => view([]), /at least two points/);
    assert.throws(() => view(null), /at least two points/);
  }
});
