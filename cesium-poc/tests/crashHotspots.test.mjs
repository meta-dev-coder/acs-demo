import test from 'node:test';
import assert from 'node:assert/strict';
import { clusterCrashes, crashBandFor, crashBreakdown, metresBetween, HOTSPOT_RADIUS_M }
  from '../src/safety/crashHotspots.js';

/** ~111 m per 0.001 degrees of latitude, so offsets here read roughly as metres. */
const at = (id, lon, lat, title = 'Multi-vehicle crash') => ({ id, longitude: lon, latitude: lat, title });
const near = (id, n, title) => at(id, -80.2 + n * 0.0005, 26.06, title);   // ~50 m apart

test('metresBetween measures real ground distance', () => {
  const m = metresBetween({ longitude: -80.2, latitude: 26.06 }, { longitude: -80.2, latitude: 26.069 });
  assert.ok(Math.abs(m - 1000) < 30, `expected ~1 km, got ${Math.round(m)} m`);
});

test('crashes standing together become one hotspot', () => {
  const { hotspots, clustered } = clusterCrashes([near('A', 0), near('B', 1), near('C', 2)]);
  assert.equal(hotspots.length, 1);
  assert.equal(hotspots[0].count, 3);
  assert.equal(clustered, 3);
});

test('a lone crash is still a place, drawn as Low', () => {
  // Nothing recorded is left off the map: an empty stretch means "nothing happened here", never
  // "something happened but it did not clear a threshold".
  const { hotspots, clustered, loose } = clusterCrashes([near('A', 0), at('Z', -80.4, 26.06)]);
  assert.equal(hotspots.length, 2);
  assert.deepEqual(hotspots.map(spot => spot.band.id), ['LOW', 'LOW']);
  assert.equal(clustered, 2);
  assert.equal(loose, 0);
});

test('crashes further apart than the radius stay separate places', () => {
  // The radius is explicit: this is about the RULE, not about whatever the default happens to be,
  // so tightening HOTSPOT_RADIUS_M never silently changes what this proves. The two groups are
  // ~111 m tall and ~10 km apart.
  const far = [at('A', -80.2, 26.06), at('B', -80.2, 26.061), at('C', -80.2, 26.062),
    at('X', -80.3, 26.06), at('Y', -80.3, 26.061), at('Z', -80.3, 26.062)];
  const { hotspots } = clusterCrashes(far, { radiusMeters: 150 });
  assert.equal(hotspots.length, 2, '~10 km apart is two hotspots, not one');
  assert.ok(hotspots.every(spot => spot.count === 3));
  // At a radius tighter than the groups themselves they break apart into their own places.
  const tight = clusterCrashes(far, { radiusMeters: 50 }).hotspots;
  assert.equal(tight.length, 6, 'six crashes, six places');
  assert.ok(tight.every(spot => spot.band.id === 'LOW'));
});

test('the default radius is a spot on the road, not a stretch of it', () => {
  assert.equal(HOTSPOT_RADIUS_M, 100);
});

test('bands are absolute counts, from one crash upward', () => {
  assert.equal(crashBandFor(0), null, 'no crash is no place');
  assert.equal(crashBandFor(1).id, 'LOW');
  assert.equal(crashBandFor(2).id, 'LOW');
  assert.equal(crashBandFor(3).id, 'MODERATE');
  assert.equal(crashBandFor(6).id, 'HIGH');
  assert.equal(crashBandFor(10).id, 'SEVERE');
  assert.equal(crashBandFor(99).id, 'SEVERE');
});

test('the circle contains every crash it claims', () => {
  const [spot] = clusterCrashes(Array.from({ length: 4 }, (_, i) => near(`C${i}`, i))).hotspots;
  assert.ok(spot.radiusMeters >= HOTSPOT_RADIUS_M);
  for (const crash of spot.crashes) {
    assert.ok(metresBetween(spot, crash) <= spot.radiusMeters, `${crash.id} falls outside its own circle`);
  }
});

test('a crash with no coordinates is counted as unplaced, never at (0,0)', () => {
  const { hotspots, unplaced } = clusterCrashes([near('A', 0), near('B', 1), near('C', 2), { id: 'D' }]);
  assert.equal(unplaced, 1);
  assert.equal(hotspots[0].count, 3);
});

test('identical records always produce identical hotspots', () => {
  const crashes = [near('A', 0), near('B', 1), near('C', 2), at('X', -80.3, 26.06)];
  const once = clusterCrashes(crashes).hotspots.map(s => `${s.id}:${s.count}`);
  const twice = clusterCrashes([...crashes].reverse()).hotspots.map(s => `${s.id}:${s.count}`);
  assert.deepEqual(once, twice, 'ordering of the input must not move the hotspots');
});

test('the breakdown names the crash types, most common first', () => {
  const { hotspots } = clusterCrashes([near('A', 0, 'Vehicle fire'), near('B', 1, 'Vehicle fire'), near('C', 2, 'Attenuator hit')]);
  assert.deepEqual(crashBreakdown(hotspots[0]),
    [{ title: 'Vehicle fire', count: 2 }, { title: 'Attenuator hit', count: 1 }]);
});
