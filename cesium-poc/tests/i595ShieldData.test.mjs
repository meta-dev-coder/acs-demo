import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONTEXT_LABEL_ASSET_TYPE, CORRIDOR_INTERCHANGES, ROAD_SHIELD_ASSET_TYPE, SHIELD_ROUTE, contextLabelPlacements, shieldPlacements } from '../src/i595ShieldData.js';

const corridor = JSON.parse(readFileSync(new URL('../config/corridorCenterline.json', import.meta.url)));
const placements = shieldPlacements(corridor);
const labels = contextLabelPlacements(corridor);

test('orientation aids, not labels: 5-7 shields for the whole corridor', () => {
  assert.ok(placements.length >= 5 && placements.length <= 7, `got ${placements.length}`);
  assert.equal(new Set(placements.map(p => p.id)).size, placements.length);
  const segments = JSON.parse(readFileSync(new URL('../public/data/i595_fdot_traffic_segments.geojson', import.meta.url))).features.length;
  assert.ok(placements.length < segments, 'never one shield per FDOT segment');
  assert.equal(ROAD_SHIELD_ASSET_TYPE, 'ROAD_SHIELD');
  assert.equal(CONTEXT_LABEL_ASSET_TYPE, 'CONTEXT_LABEL');
});

test('every shield sits on an existing centerline vertex', () => {
  const vertices = new Set(corridor.map(p => `${p.lon},${p.lat}`));
  for (const placement of placements) {
    assert.ok(vertices.has(`${placement.lon},${placement.lat}`), `${placement.id} is off the corridor geometry`);
    assert.equal(placement.route, SHIELD_ROUTE);
    assert.ok(placement.interchange.length > 0);
  }
});

test('shields snap to the nearest vertex and stay ordered west to east', () => {
  for (const anchor of CORRIDOR_INTERCHANGES.filter(item => item.shield)) {
    const placement = placements.find(p => p.id === `i595-shield-${anchor.id}`);
    const nearest = Math.min(...corridor.map(p => Math.abs(p.lon - anchor.lon)));
    assert.equal(Math.abs(placement.lon - anchor.lon), nearest);
    assert.ok(nearest < 0.001, `${anchor.id} snapped ${nearest} deg away`);
  }
  const lons = placements.map(p => p.lon);
  assert.deepEqual(lons, [...lons].sort((a, b) => a - b));
});

test('shields span the corridor rather than clustering at one end', () => {
  const lons = corridor.map(p => p.lon), span = Math.max(...lons) - Math.min(...lons);
  // The first shield marks the western I-75 / Sawgrass interchange, close to the corridor's start.
  assert.ok(placements[0].lon - Math.min(...lons) < span * 0.1, 'first shield marks the western end');
  assert.ok(Math.max(...placements.map(p => p.lon)) - placements[0].lon > span * 0.8);
});

test('no two shields crowd each other', () => {
  const gaps = placements.slice(1).map((p, i) => (p.lon - placements[i].lon) * 111320 * Math.cos(p.lat * Math.PI / 180));
  assert.ok(Math.min(...gaps) > 800, `shields must stay apart, closest pair ${Math.round(Math.min(...gaps))} m`);
});

test('placement needs real geometry', () => {
  assert.throws(() => shieldPlacements([]), /centerline is required/);
  assert.throws(() => shieldPlacements(undefined), /centerline is required/);
});

test('context labels name every interchange, shield or not', () => {
  assert.equal(labels.length, CORRIDOR_INTERCHANGES.length);
  assert.ok(labels.length > placements.length, 'more labels than shields: some crossings are label-only');
  assert.deepEqual(labels.map(label => label.interchange), [
    'I-75 / Sawgrass', 'SW 136th Ave', 'Flamingo Rd', 'Pine Island Rd',
    'University Dr', "Florida's Turnpike", 'SR 7 / US 441', 'I-95',
  ]);
  const vertices = new Set(corridor.map(p => `${p.lon},${p.lat}`));
  for (const label of labels) assert.ok(vertices.has(`${label.lon},${label.lat}`), `${label.id} is off the corridor`);
  // Ordered west to east, and every shield has a label at exactly the same place.
  const lons = labels.map(label => label.lon);
  assert.deepEqual(lons, [...lons].sort((a, b) => a - b));
  for (const shield of placements) {
    const label = labels.find(item => item.id === shield.id.replace('i595-shield-', 'i595-label-'));
    assert.ok(label && label.lon === shield.lon && label.lat === shield.lat, `no label for ${shield.id}`);
  }
});

test('shields and labels never share an id', () => {
  const ids = [...placements, ...labels].map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(placements.every(item => item.id.startsWith('i595-shield-')));
  assert.ok(labels.every(item => item.id.startsWith('i595-label-')));
});

test('label placement needs real geometry too', () => {
  assert.throws(() => contextLabelPlacements([]), /centerline is required/);
  assert.throws(() => contextLabelPlacements(undefined), /centerline is required/);
});
