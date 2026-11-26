import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alternateCoverage, constructionScreen, dependentsOutside, insideIds, inventoryOf, outageByArea, statusOfArea, supplyOfArea } from '../src/ifcSpatial/areaIntel.js';

// A small network: GRID → TX-OUT (outside) → SWB (inside) → CR-1, CR-2 (inside); SWB → CR-9 (outside);
// GRID → TX-IN (inside) → CR-3 (inside). CR-1 has an alternate route through NO-1.
const relations = {
  GRID: { relation: 'OUTSIDE' }, 'TX-OUT': { relation: 'OUTSIDE' }, SWB: { relation: 'WITHIN' }, 'TX-IN': { relation: 'INTERSECTS' },
  'CR-1': { relation: 'WITHIN' }, 'CR-2': { relation: 'WITHIN' }, 'CR-3': { relation: 'WITHIN' }, 'CR-9': { relation: 'OUTSIDE' }, 'CB-X': { relation: 'CROSSES' },
};
const PATHS = { 'CR-1': ['GRID', 'TX-OUT', 'SWB', 'CR-1'], 'CR-2': ['GRID', 'TX-OUT', 'SWB', 'CR-2'], 'CR-3': ['GRID', 'TX-IN', 'CR-3'], 'CR-9': ['GRID', 'TX-OUT', 'SWB', 'CR-9'] };
const supplyOf = id => (PATHS[id] ? { primary: { path: PATHS[id] }, alternatives: id === 'CR-1' ? [{ needsClosing: ['NO-1'] }] : [], verification: id === 'CR-3' ? 'PARTIAL' : 'VERIFIED' } : { primary: null, alternatives: [] });
const ROLES = { GRID: 'SOURCE', 'TX-OUT': 'TRANSFORMER', 'TX-IN': 'TRANSFORMER', SWB: 'DISTRIBUTION' };
const roleOf = id => ROLES[id] ?? 'LOAD';

test('inside ids: within, intersecting and crossing, once each', () => {
  assert.deepEqual(insideIds({ within: ['A', 'B'], intersects: ['C'], crosses: ['D', 'A'] }), ['A', 'B', 'C', 'D']);
});

test('inventory by category, largest first, with a category filter', () => {
  const cat = id => ({ A: 'Transformer', B: 'Crane', C: 'Crane', D: null })[id];
  assert.deepEqual(inventoryOf(['A', 'B', 'C', 'D', 'A'], cat), { total: 4, categories: [{ category: 'Crane', ids: ['B', 'C'] }, { category: 'Other', ids: ['D'] }, { category: 'Transformer', ids: ['A'] }] });
  assert.equal(inventoryOf(['A', 'B', 'C'], cat, { filter: ['Transformer'] }).total, 1);
});

test('status in the area: each asset once, degraded not double-counted as powered, unmonitored apart', () => {
  const S = { A: { status: 'POWERED', monitored: true }, B: { status: 'DEGRADED', monitored: true }, C: { status: 'NO_POWER', monitored: true }, D: { status: 'POWERED', monitored: false } };
  const s = statusOfArea(['A', 'B', 'C', 'D', 'E', 'B'], id => S[id] ?? null);
  assert.deepEqual(s.counts, { POWERED: 1, NO_POWER: 1, DEGRADED: 1, OFFLINE: 0, UNKNOWN: 0 });
  assert.equal(s.monitored, 3);
  assert.equal(s.unmonitored, 2);
  assert.deepEqual(s.attention, ['C', 'B']);
});

test('upstream traversal reaches equipment outside the area, deduplicated, inside/outside marked', () => {
  const s = supplyOfArea({ consumers: ['CR-1', 'CR-2', 'CR-3'], supplyOf, roleOf, relations });
  assert.deepEqual(s.upstream.map(u => u.id), ['GRID', 'TX-OUT', 'TX-IN', 'SWB']);
  const tx = Object.fromEntries(s.upstream.map(u => [u.id, u]));
  assert.equal(tx['TX-OUT'].inside, false);
  assert.deepEqual(tx['TX-OUT'].consumers, ['CR-1', 'CR-2']);
  assert.equal(tx['TX-IN'].inside, true);
  assert.equal(tx.GRID.consumers.length, 3, 'a shared source counted once, with every consumer it supplies');
  assert.deepEqual(s.unverified, ['CR-3']);
  const onlyTx = supplyOfArea({ consumers: ['CR-1', 'CR-3', 'NOPATH'], supplyOf, roleOf, relations, roles: ['TRANSFORMER'] });
  assert.deepEqual(onlyTx.upstream.map(u => u.id), ['TX-IN', 'TX-OUT'], 'one consumer each: by id');
  assert.deepEqual(onlyTx.unsupplied, ['NOPATH']);
});

test('downstream traversal: consumers outside that depend on equipment inside', () => {
  const d = dependentsOutside({ consumers: ['CR-1', 'CR-2', 'CR-3', 'CR-9'], supplyOf, relations });
  assert.deepEqual(d, [{ id: 'CR-9', via: ['SWB'], unknownLocation: false }]);
});

test('alternate supply coverage is per consumer: partial coverage is not "the area has backup"', () => {
  const c = alternateCoverage(['CR-1', 'CR-2', 'NOPATH'], supplyOf);
  assert.deepEqual(c.covered, [{ id: 'CR-1', needsClosing: ['NO-1'] }]);
  assert.deepEqual(c.without, ['CR-2']);
  assert.deepEqual(c.unknown, ['NOPATH']);
  assert.equal(c.all, false);
  assert.equal(c.none, false);
  assert.equal(alternateCoverage(['CR-1'], supplyOf).all, true);
});

test('outage impact partitioned inside / outside / unknown, each consumer once', () => {
  assert.deepEqual(outageByArea(['CR-1', 'CR-9', 'CR-1', 'GHOST'], relations), { total: 3, inside: ['CR-1'], outside: ['CR-9'], unknown: ['GHOST'] });
});

test('construction screening separates crossing cables, footprints partly inside and a buffer only when given', () => {
  const m = { within: ['TX-IN', 'CB-W'], intersects: ['BLD'], crosses: ['CB-X'], unknown: ['N'], near: [{ id: 'TX-OUT', distanceM: 12 }, { id: 'FAR', distanceM: 80 }] };
  const kind = id => (id.startsWith('CB') ? 'CABLE' : 'EQUIPMENT');
  const s = constructionScreen({ membership: m, kindOf: kind, nearM: 50 });
  assert.deepEqual(s.cablesCrossing, ['CB-X']);
  assert.deepEqual(s.cablesWithin, ['CB-W']);
  assert.deepEqual(s.within, ['TX-IN']);
  assert.deepEqual(s.near.map(n => n.id), ['TX-OUT']);
  assert.deepEqual(constructionScreen({ membership: m, kindOf: kind }).near, [], 'no distance given: no buffer assumed');
});

test('version changes in an area: added, removed by its old position, moved in / out / within, modified, connections; elsewhere ignored', async () => {
  const { changesInArea } = await import('../src/ifcSpatial/areaIntel.js');
  const toLonLat = (x, y) => ({ lon: -76.54 + x / 86_000, lat: 39.25 + y / 110_574 });
  const ring = [[0, 0], [100, 0], [100, 100], [0, 100]].map(([x, y]) => { const r = toLonLat(x, y); return [r.lon, r.lat]; });
  const at = (x, y) => ({ model: [x, y, 0] });
  const changes = [
    { globalId: 'a', status: 'ADDED', after: at(50, 50) }, { globalId: 'a2', status: 'ADDED', after: at(500, 50) },
    { globalId: 'r', status: 'REMOVED', before: at(10, 10) }, { globalId: 'r2', status: 'REMOVED', before: at(300, 10) },
    { globalId: 'in', status: 'MOVED', moved: true, before: at(200, 50), after: at(60, 50) },
    { globalId: 'out', status: 'MOVED', moved: true, before: at(60, 50), after: at(200, 50) },
    { globalId: 'w', status: 'MOVED', moved: true, before: at(20, 20), after: at(30, 30) },
    { globalId: 'm', status: 'MODIFIED', modified: true, before: at(40, 40), after: at(40, 40), modifications: [{ kind: 'ports' }] },
    { globalId: 'far', status: 'MODIFIED', modified: true, before: at(900, 900), after: at(900, 900) },
    { globalId: 'nopos', status: 'MODIFIED', modified: true },
  ];
  const r = changesInArea(changes, { ring, toLonLat });
  const ids = list => list.map(c => c.globalId);
  assert.deepEqual([ids(r.added), ids(r.removed), ids(r.movedIn), ids(r.movedOut), ids(r.movedWithin), ids(r.modified), ids(r.connectivity), ids(r.unplaced)],
    [['a'], ['r'], ['in'], ['out'], ['w'], ['m'], ['m'], ['nopos']]);
  assert.equal(r.total, 6);
  assert.equal(changesInArea(changes, { ring, toLonLat, matches: c => c.globalId === 'r' }).total, 1);
});
