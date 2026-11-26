import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { convertIfc } from '../server/ifcSpatial/convert.mjs';
import { buildIfcNetwork } from '../src/ifcSpatial/ifcNetwork.js';
import { buildFacilities } from '../src/ifcSpatial/facilities.js';
import { approxMetres, bufferOutline, buildSpatialIndex, geometryDistance, insidePolygon, parseSpatialQuestion, querySpatial } from '../src/ifcSpatial/spatialIndex.js';

const P = (x, y) => ({ type: 'Point', xy: [x, y] });
test('distances in metres: point–point, point–line (its nearest part, not its middle), point–polygon (0 inside), line–line', () => {
  assert.equal(geometryDistance(P(0, 0), P(3, 4)), 5);
  const line = { type: 'LineString', coords: [[0, 0], [100, 0]] };
  assert.equal(geometryDistance(P(90, 7), line), 7, 'to the line itself, not to its midpoint (50, 0)');
  const square = { type: 'Polygon', ring: [[0, 0], [10, 0], [10, 10], [0, 10]] };
  assert.equal(geometryDistance(P(5, 5), square), 0);
  assert.equal(geometryDistance(P(13, 14), square), 5);
  assert.ok(insidePolygon([5, 5], square.ring) && !insidePolygon([11, 5], square.ring));
  assert.equal(geometryDistance(line, { type: 'LineString', coords: [[50, 20], [50, 30]] }), 20);
  const ring = bufferOutline(P(0, 0), 100);
  assert.ok(ring.every(([x, y]) => Math.abs(Math.hypot(x, y) - 100) < 1e-6), 'a point reference: a circle of the radius');
  assert.equal(approxMetres(0.2), '0 m (touching or inside)');
  assert.equal(approxMetres(42.37), '≈ 42 m', 'no false precision from illustrative positions');
  assert.equal(approxMetres(1234), '≈ 1.2 km');
});

// The real IFC V4.
const conv = async f => convertIfc(readFileSync(new URL(`./fixtures/ifc/${f}`, import.meta.url)), {});
const indexOf = r => {
  const b = buildIfcNetwork({ elements: r.elements, connections: r.connections, toLonLat: (x, y, z) => ({ lon: x / 1e5, lat: y / 1e5, height: z }) });
  const reg = buildFacilities({ elements: r.elements, idOf: g => b.assetByGlobalId.get(g)?.id ?? null });
  const idx = buildSpatialIndex({ elements: r.elements, facilities: reg.facilities, areas: [{ name: 'Container Yard', xy: [-400, -200] }], describe: e => {
    const a = b.assetByGlobalId.get(e.globalId);
    if (a) return { id: a.id, category: { TRANSFORMER: 'Transformer', CIRCUIT_BREAKER: 'Breaker', FEEDER: 'Cable', SWITCHGEAR: 'Switchgear', SUBSTATION: 'Ring main unit', LIGHTING_CIRCUIT: 'High-mast light' }[a.assetType] ?? a.assetType };
    if ((!e.networkId && !e.tag) || ['IfcDistributionPort', 'IfcSite', 'IfcElementAssembly'].includes(e.ifcClass)) return null;
    return { id: e.networkId ?? e.tag, category: e.ifcClass === 'IfcCableSegment' ? 'Fibre cable (SCADA)' : e.ifcClass.replace(/^Ifc/, '') };
  } });
  return { idx, ids: new Set(b.network.assets.keys()) };
};
const { idx, ids } = indexOf(await conv('seagirt-compare-v4.ifc'));
const ask = (q, extra = {}) => { const p = parseSpatialQuestion(q, { index: idx, assetIds: ids, ...extra }); return { p, r: p?.targets ? querySpatial(idx, p) : null }; };

test('parsing: radius (default, metres, km), nearest N in words, categories from the model, unknown categories, the selected asset', () => {
  assert.equal(ask('Show assets near TX-M1').p.radius, 100);
  assert.equal(ask('Show assets near TX-M1').p.defaultRadius, true);
  assert.equal(ask('Find transformers within 0.5 km of USS-1').p.radius, 500);
  assert.equal(ask('Find the nearest five assets to TX-M1.').p.count, 5);
  assert.deepEqual(ask('Show transformers near USS-1.').p.targets, ['Transformer']);
  assert.ok(ask('Show all lights near the main substation').p.targets.includes('High-mast light'), 'lights: the model’s high-mast lights');
  assert.equal(ask('Show all widgets near TX-M1').p.targets, null);
  assert.equal(ask('Show all widgets near TX-M1').p.unknownCategory, 'widget');
  assert.deepEqual(ask('Show all assets near the selected equipment', { selectedId: 'HM-3' }).p.references.map(r => r.id), ['HM-3']);
  assert.equal(ask('What does TX-M1 supply?').p, null, 'not spatial');
  assert.equal(ask('Show the connection between USS-1 and USS-2').p, null, 'a network question');
});

test('the real V4: 100 m of the main substation, nearest five to TX-M1, closest cable, inside, every substation once, substations near TX-1', () => {
  const near = ask('Show all assets within 100 meters of Main Substation.').r;
  const cats = new Set(near.results.map(x => x.entry.category));
  assert.ok(near.results.length > 20 && cats.size >= 4, 'all eligible categories, not one');
  assert.ok(near.results.every(x => x.distance <= 100));
  assert.ok(['TX-M1', 'TX-M2', 'BUS-A'].every(id => near.results.find(x => x.entry.id === id)?.distance === 0), 'its own equipment: inside, 0 m');
  const five = ask('Find the nearest five assets to TX-M1.').r.results;
  assert.equal(five.length, 5);
  assert.equal(new Set(five.map(x => x.entry.id)).size, 5);
  assert.ok(five.every((x, i) => !i || five[i - 1].distance <= x.distance));
  assert.ok(!five.some(x => x.entry.id === 'TX-M1'));
  assert.equal(ask('Show the closest cable to TX-M1.').r.results[0].entry.category, 'Cable');
  assert.deepEqual(ask('Show transformers near USS-1.').r.results.map(x => x.entry.id), ['TX-1']);
  assert.equal(ask('Which assets are inside Main Substation?').r.results.length, 8);
  const every = ask('Show all equipment near every substation.');
  assert.equal(every.r.refs.length, 8);
  assert.equal(new Set(every.r.results.map(x => x.entry.id)).size, every.r.results.length, 'each asset once');
  assert.ok(every.r.results.some(x => x.near.length > 1) || every.r.results.length > 0);
  assert.ok(ask('Which substations are within 500 meters of TX-1?').r.results.every(x => x.entry.category === 'Substation'));
  const between = ask('Show assets between USS-1 and USS-2').r;
  assert.ok(between.corridor.width === 50 && between.results.some(x => x.entry.id === 'RY-2'), 'a stated corridor; the ring cable between them');
  assert.ok(ask('Show all assets within 5 km of TX-M1').r.results.length > 150, 'large sets');
  const dist = ask('How far is TX-M1 from TX-M2?');
  assert.equal(dist.p.op, 'DISTANCE');
  assert.ok(dist.r.distance > 0 && dist.r.distance < 200);
});

test('model version: each version has its own index (V3 has none of V4’s added breakers)', async () => {
  const v3 = indexOf(await conv('seagirt-compare-v3.ifc'));
  const added = [...idx.byId.keys()].filter(id => !v3.idx.byId.has(id));
  assert.ok(added.length > 0);
});
