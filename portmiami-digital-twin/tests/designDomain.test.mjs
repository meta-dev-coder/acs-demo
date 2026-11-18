/**
 * Domain classification and the store migration.
 *
 * The behaviour worth pinning down is not "a garage is parking" — it is that a ROAD belonging to
 * a parking scenario stays with that scenario, that classification only ever ADDS a field, and
 * that a migration which cannot account for every element writes nothing at all.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  DESIGN_DOMAIN, classifyDesign, designDomain, elementDomain, elementsInDomain, isRoadDesign,
  splitByDomain,
} from '../src/designs/designDomain.js';
import { migrateDesigns, needsMigration } from '../server/portmiami/designMigration.mjs';
import { syntheticDesigns } from '../src/designs/syntheticDesigns.js';
import { roadDesigns } from '../src/designs/designModel.js';

const road = (id, extra = {}) => ({ id, type: 'ROAD', changeType: 'NEW', ...extra });

test('an element declaring its domain is taken at its word', () => {
  assert.equal(
    elementDomain({ id: 'x', type: 'ROAD', domain: DESIGN_DOMAIN.PARKING_INFRASTRUCTURE }),
    DESIGN_DOMAIN.PARKING_INFRASTRUCTURE);
});

test('a user-drawn road is road infrastructure', () => {
  assert.equal(elementDomain(road('road-abc')), DESIGN_DOMAIN.ROAD_INFRASTRUCTURE);
});

test('a garage and a surface lot are parking infrastructure', () => {
  assert.equal(elementDomain({ id: 'g', type: 'PARKING_GARAGE' }),
    DESIGN_DOMAIN.PARKING_INFRASTRUCTURE);
  assert.equal(elementDomain({ id: 's', type: 'SURFACE_PARKING' }),
    DESIGN_DOMAIN.PARKING_INFRASTRUCTURE);
});

test('a legacy parking scenario keeps its own access road', () => {
  // The whole point of the id list: by type alone this is a road, and promoting it would
  // re-home half of Design B into a road workflow.
  assert.equal(elementDomain(road('design-b-road-01')), DESIGN_DOMAIN.PARKING_INFRASTRUCTURE);
  assert.equal(elementDomain(road('design-c-road-01')), DESIGN_DOMAIN.PARKING_INFRASTRUCTURE);
});

test('a building is neither road nor parking, and says so', () => {
  assert.equal(elementDomain({ id: 'b', type: 'BUILDING' }), DESIGN_DOMAIN.MIXED_INFRASTRUCTURE);
});

test('domain is never read off a design name', () => {
  // A record named for parking, holding nothing but user-drawn roads, is a road design.
  const design = { id: 'x', name: 'Surface Parking and Road Reconfiguration', elements: [road('road-1')] };
  assert.equal(designDomain(design), DESIGN_DOMAIN.ROAD_INFRASTRUCTURE);
});

test('an empty design with no declared domain is not claimed as a road design', () => {
  // Otherwise every blank record in the store would appear in the road studio.
  assert.equal(designDomain({ id: 'x', elements: [] }), DESIGN_DOMAIN.MIXED_INFRASTRUCTURE);
});

test('the three shipped alternatives are parking or mixed, never road', () => {
  for (const design of syntheticDesigns()) {
    assert.ok(!isRoadDesign(design), `${design.id} must not read as a road design`);
  }
});

test('the studio seeds road designs, and they are empty', () => {
  for (const design of roadDesigns()) {
    assert.ok(isRoadDesign(design));
    assert.equal(design.elements.length, 0);
  }
});

test('splitting a design loses nothing', () => {
  const design = {
    id: 'd',
    elements: [road('road-1'), { id: 'g', type: 'PARKING_GARAGE' }, { id: 'b', type: 'BUILDING' }],
  };
  const { road: roads, parking, mixed } = splitByDomain(design);
  assert.equal(roads.length + parking.length + mixed.length, design.elements.length);
  assert.deepEqual(roads.map(e => e.id), ['road-1']);
  assert.deepEqual(parking.map(e => e.id), ['g']);
  assert.deepEqual(mixed.map(e => e.id), ['b']);
});

test('elementsInDomain returns only that domain', () => {
  const design = { id: 'd', elements: [road('road-1'), { id: 'g', type: 'PARKING_GARAGE' }] };
  assert.deepEqual(
    elementsInDomain(design, DESIGN_DOMAIN.ROAD_INFRASTRUCTURE).map(e => e.id), ['road-1']);
});

test('classification adds a domain and changes nothing else', () => {
  const design = {
    id: 'd', name: 'n', revision: '07', elements: [road('road-1', { properties: { widthM: 10 } })],
  };
  const out = classifyDesign(design);
  assert.equal(out.domain, DESIGN_DOMAIN.ROAD_INFRASTRUCTURE);
  assert.equal(out.revision, '07');
  assert.equal(out.name, 'n');
  assert.equal(out.elements[0].properties.widthM, 10);
  // Additive: strip the added field and the record is what it was.
  const { domain, ...rest } = out;
  assert.deepEqual({ ...rest, elements: rest.elements.map(({ domain: d, ...e }) => e) }, design);
});

test('a design that already declares a domain is not reclassified', () => {
  const design = { id: 'd', domain: DESIGN_DOMAIN.PARKING_INFRASTRUCTURE, elements: [road('r')] };
  assert.equal(classifyDesign(design), design);
});

// ---- migration ---------------------------------------------------------------------------------

test('a store whose records all declare a domain needs no migration', () => {
  assert.equal(needsMigration([{ id: 'a', domain: DESIGN_DOMAIN.ROAD_INFRASTRUCTURE }]), false);
  assert.equal(needsMigration([{ id: 'a' }]), true);
});

test('migration re-homes user-drawn roads and leaves the parking scenario intact', () => {
  const stored = [{
    id: 'design-a', name: 'Design A — Garage Expansion', revision: '24',
    elements: [
      { id: 'design-a-garage-01', type: 'PARKING_GARAGE', changeType: 'MODIFIED' },
      road('widen-40642-0-30', { changeType: 'MODIFIED' }),
    ],
  }];
  const result = migrateDesigns(stored);
  assert.ok(result.ok);
  const parking = result.designs.find(d => d.id === 'design-a');
  const roads = result.designs.find(d => d.id === 'road-design-a');
  assert.equal(parking.domain, DESIGN_DOMAIN.PARKING_INFRASTRUCTURE);
  assert.deepEqual(parking.elements.map(e => e.id), ['design-a-garage-01']);
  assert.equal(parking.name, 'Design A — Garage Expansion', 'the legacy record keeps its name');
  assert.equal(roads.domain, DESIGN_DOMAIN.ROAD_INFRASTRUCTURE);
  assert.equal(roads.name, 'Design A');
  assert.deepEqual(roads.elements.map(e => e.id), ['widen-40642-0-30']);
  assert.equal(roads.migratedFrom, 'design-a');
});

test('migration keeps a legacy parking access road with its own scenario', () => {
  const result = migrateDesigns([{
    id: 'design-b', name: 'Design B', revision: '03',
    elements: [
      { id: 'design-b-garage-01', type: 'PARKING_GARAGE', changeType: 'NEW' },
      road('design-b-road-01'),
    ],
  }]);
  assert.ok(result.ok);
  // Nothing moves: both elements belong to the parking scenario.
  assert.equal(result.designs.length, 1);
  assert.equal(result.designs[0].id, 'design-b');
  assert.deepEqual(result.designs[0].elements.map(e => e.id),
    ['design-b-garage-01', 'design-b-road-01']);
});

test('migration never changes the total element count', () => {
  const stored = syntheticDesigns().map(design => ({
    ...design, domain: undefined, elements: [...design.elements, road(`road-${design.id}`)],
  }));
  const before = stored.reduce((total, d) => total + d.elements.length, 0);
  const result = migrateDesigns(stored);
  assert.ok(result.ok);
  assert.equal(result.designs.reduce((total, d) => total + d.elements.length, 0), before);
});

test('migration is idempotent', () => {
  const once = migrateDesigns([{
    id: 'design-c', name: 'Design C — Surface', revision: '08',
    elements: [{ id: 'design-c-surface-01', type: 'SURFACE_PARKING', changeType: 'MODIFIED' },
      road('road-xyz')],
  }]);
  const twice = migrateDesigns(once.designs);
  assert.equal(needsMigration(once.designs), false);
  assert.deepEqual(twice.designs, once.designs);
  assert.deepEqual(twice.moved, []);
});

test('a record with no mapping is classified in place, not moved', () => {
  const result = migrateDesigns([{ id: 'something-else', elements: [road('road-1')] }]);
  assert.ok(result.ok);
  assert.equal(result.designs.length, 1);
  assert.equal(result.designs[0].domain, DESIGN_DOMAIN.ROAD_INFRASTRUCTURE);
  assert.deepEqual(result.moved, []);
});
