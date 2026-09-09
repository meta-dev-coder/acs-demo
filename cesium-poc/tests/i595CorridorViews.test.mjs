import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { corridorOverview, heroView, westernTerminus } from '../src/i595CorridorViews.js';
import { shieldPlacements } from '../src/i595ShieldData.js';

const corridor = JSON.parse(readFileSync(new URL('../config/corridorCenterline.json', import.meta.url)));
const METRES_PER_DEGREE = 111320;
const distance = (a, b) => Math.hypot((b.lon - a.lon) * Math.cos(a.lat * Math.PI / 180), b.lat - a.lat) * METRES_PER_DEGREE;

test('hero and reset frame different parts of the corridor', () => {
  const overview = corridorOverview(corridor), hero = heroView(corridor);
  assert.equal(overview.height, 24000);
  assert.equal(hero.height, 1000);
  const lons = corridor.map(p => p.lon), span = Math.max(...lons) - Math.min(...lons);
  // Reset frames the middle of the corridor; startup frames its western end. Different views.
  assert.ok(hero.focus.lon < Math.min(...lons) + span * 0.2, 'startup stays at the western end');
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

test('the hero view is a genuine oblique, turned off the corridor axis', () => {
  const hero = heroView(corridor);
  assert.ok(hero.pitchDeg >= -28 && hero.pitchDeg <= -20, `an oblique, not a plan view: ${hero.pitchDeg}`);
  assert.equal(hero.rollDeg, 0);
  // Looking broadly down-corridor (which runs ESE), but turned off-axis so I-595 crosses the frame
  // diagonally rather than pointing straight up it — and never forced to north-up.
  assert.ok(hero.headingDeg > 45 && hero.headingDeg < 100, `heading ${hero.headingDeg}`);
  assert.ok(Math.abs(hero.headingDeg) > 15, 'the hero view is deliberately not north-up');
});

test('the hero view and the reset view are different cameras', () => {
  const hero = heroView(corridor), overview = corridorOverview(corridor);
  assert.ok(overview.height > hero.height * 10, 'reset stays a corridor overview');
  assert.equal(overview.pitchDeg, -90);
  assert.ok(hero.pitchDeg > -30, 'the hero view is oblique where reset is straight down');
  assert.notEqual(hero.headingDeg, overview.headingDeg);
});

test('the hero view is built around the I-75 / Sawgrass interchange', () => {
  const hero = heroView(corridor), shields = shieldPlacements(corridor);
  assert.equal(shields[0].id, 'i595-shield-i75-sawgrass');
  assert.equal(hero.interchange.lon, shields[0].lon);
  assert.equal(hero.interchange.lat, shields[0].lat);
  // A real centerline vertex, never a typed-in point.
  assert.ok(corridor.some(p => p.lon === hero.interchange.lon && p.lat === hero.interchange.lat));
  assert.ok(distance(westernTerminus(corridor), hero.interchange) < 5000, 'the hero stays at the western end');
  // Aimed a little down-corridor, so the marked corridor is in frame alongside the ramps.
  assert.ok(hero.focus.lon > hero.interchange.lon, 'the aim point is east of the interchange');
  assert.ok(distance(hero.interchange, hero.focus) < 1500);
  // The camera stands back along its own heading by exactly the tilt's ground reach.
  const standoff = hero.height / Math.tan(-hero.pitchDeg * Math.PI / 180);
  assert.ok(Math.abs(distance(hero, hero.focus) - standoff) < 40, 'standoff must match the camera tilt');
  assert.ok(hero.lon < hero.focus.lon, 'the camera sits west of what it frames');
});

test('hero altitude stays low enough for structures to read, and is overridable', () => {
  assert.ok(heroView(corridor).height >= 600 && heroView(corridor).height <= 1400);
  assert.equal(heroView(corridor, { height: 1800 }).height, 1800);
});

test('both views reject an unusable centerline', () => {
  for (const view of [corridorOverview, heroView]) {
    assert.throws(() => view([]), /at least two points/);
    assert.throws(() => view(null), /at least two points/);
  }
});
