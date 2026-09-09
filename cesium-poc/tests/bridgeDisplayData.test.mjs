import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bridgesForDisplay } from '../src/bridgeDisplayData.js';

test('keeps 14 original geometries and removes the eight matching L records', () => {
  const features = JSON.parse(readFileSync(new URL('../public/data/i595_bridges.geojson', import.meta.url))).features;
  const before = JSON.stringify(features);
  const displayed = bridgesForDisplay(features);
  assert.equal(displayed.length, 14);
  const removed = features.filter(f => !displayed.includes(f));
  assert.equal(removed.length, 8);
  for (const f of removed) {
    assert.equal(f.properties.road_side, 'L');
    assert.ok(displayed.some(r => r.properties.road_side === 'R' && JSON.stringify(r.geometry) === JSON.stringify(f.geometry)));
  }
  assert.equal(JSON.stringify(features), before);
});

test('preserves different geometry and roadway, and matches reversed geometry', () => {
  const feature = (side, coordinates, roadway = '1') => ({ properties: { road_side: side, roadway }, geometry: { type: 'LineString', coordinates } });
  const right = feature('R', [[0, 0], [1, 1]]);
  const reversedLeft = feature('L', [[1, 1], [0, 0]]);
  const distinctLeft = feature('L', [[0, 0.001], [1, 1]]);
  const otherRoad = feature('L', [[0, 0], [1, 1]], '2');
  assert.deepEqual(bridgesForDisplay([reversedLeft, distinctLeft, right, otherRoad]), [distinctLeft, right, otherRoad]);
});
