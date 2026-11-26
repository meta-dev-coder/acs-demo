import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { convertIfc } from '../server/ifcSpatial/convert.mjs';
import { buildIfcNetwork } from '../src/ifcSpatial/ifcNetwork.js';
import { answerFacilityQuestion, buildFacilities, facilitiesIn } from '../src/ifcSpatial/facilities.js';
import { resolveSupplyPath } from '../src/ifcSpatial/topology.js';

// The real IFC V4: substations are IfcElementAssembly (ObjectType MAIN_SUBSTATION / UNIT_SUBSTATION),
// their equipment aggregated into them (IfcRelAggregates).
const r = await convertIfc(readFileSync(new URL('./fixtures/ifc/seagirt-compare-v4.ifc', import.meta.url)), {});
const toLonLat = (x, y, z) => ({ lon: -76.54 + x / 86000, lat: 39.256 + y / 111000, height: z });
const built = buildIfcNetwork({ elements: r.elements, connections: r.connections, toLonLat });
const registry = buildFacilities({ elements: r.elements, idOf: g => built.assetByGlobalId.get(g)?.id ?? null, toLonLat,
  mapLabels: [{ text: 'MAIN SUBSTATION', at: { lon: -76.54, lat: 39.25 } }, { text: 'CONTAINER YARD', at: { lon: -76.54, lat: 39.25 } }], version: 'seagirt_power_network.ifc v4' });
const ctx = (zoneOf = () => null) => ({ registry, assets: built.network.assets, zones: ['CONTAINER YARD'], zoneOf,
  supplyPath: id => resolveSupplyPath(built.topology, built.network, id).primary?.path ?? [] });

test('the converter records aggregation and containment: TX-M1 is part of MSS, HM-3 is in the site', () => {
  const by = new Map(r.elements.map(e => [e.globalId, e]));
  assert.equal(by.get(r.elements.find(e => e.networkId === 'TX-M1').aggregatedBy).tag, 'MSS');
  assert.equal(by.get(r.elements.find(e => e.networkId === 'TX-1').aggregatedBy).tag, 'USS-1');
  assert.equal(r.elements.find(e => e.networkId === 'HM-3').spatialContainer.ifcClass, 'IfcSite');
});

test('classification and counting: 8 substations (1 main, 7 unit), each once; transformers are never substations', () => {
  const { substations, facilities } = registry;
  assert.equal(substations.length, 8);
  assert.deepEqual(substations.map(f => f.id), ['MSS', 'USS-1', 'USS-2', 'USS-3', 'USS-4', 'USS-5', 'USS-6', 'USS-7']);
  assert.equal(substations.filter(f => f.type === 'MAIN_SUBSTATION').length, 1);
  assert.equal(substations.filter(f => f.type === 'UNIT_SUBSTATION').length, 7);
  assert.ok(facilities.some(f => f.type === 'REEFER_RACK_BLOCK' && !f.substation), 'other assemblies are facilities, not substations');
  assert.ok(!substations.some(f => f.ifcClass === 'IfcTransformer'));
  assert.equal(new Set(substations.map(f => f.globalId)).size, substations.length);
  const mss = substations[0];
  assert.deepEqual(mss.equipment.map(e => e.networkId ?? e.tag).sort(), ['BT-1', 'BUS-A', 'BUS-B', 'CB-M1P', 'CB-M2P', 'RTU-MSS', 'TX-M1', 'TX-M2']);
  assert.match(mss.source, /IfcElementAssembly.*MAIN_SUBSTATION.*IfcRelAggregates/);
  // On the map: each at the centre of its own equipment.
  for (const f of substations) assert.ok(Number.isFinite(f.location?.lon) && Number.isFinite(f.location?.lat), f.id);
  assert.equal(registry.mapLabels.find(l => l.id === 'MAIN SUBSTATION').type, 'MAP_LABEL');
});

test('questions: counts, members, the map label kept apart, "sub stations" as one word', () => {
  for (const q of ['How many substations are there?', 'Show all substations on the map', 'Show all sub stations', 'how many sub-stations?']) {
    const a = answerFacilityQuestion(q, ctx());
    assert.equal(a?.kind, 'list', q);
    assert.equal(a.facilities.length, 8);
    assert.match(a.say, /8 substations in the IFC model \(IFC V4\): 1 main substation \(MSS\) and 7 unit substations \(USS-1 to USS-7\)/);
    assert.match(a.say2, /“MAIN SUBSTATION” label on the map is drawn by the application, not an IFC entity/);
  }
  const tx = answerFacilityQuestion('Which transformers are inside the Main Substation?', ctx());
  assert.equal(tx.kind, 'members');
  assert.deepEqual(tx.members.map(e => e.networkId).sort(), ['TX-M1', 'TX-M2']);
  const uss1 = answerFacilityQuestion('What equipment belongs to USS-1?', ctx());
  assert.deepEqual(uss1.members.map(e => e.networkId ?? e.tag).sort(), ['CB-LV1', 'RTU-USS-1', 'TX-1', 'USS-1']);
  const diff = answerFacilityQuestion('What is the difference between Main Substation and USS-1?', ctx());
  assert.equal(diff.kind, 'compare');
  assert.deepEqual(diff.facilities.map(f => f.id), ['MSS', 'USS-1']);
  assert.deepEqual(facilitiesIn('Compare USS-1 with the main substation', { facilities: registry.facilities }).map(f => f.id), ['USS-1', 'MSS']);
  // Not facility questions: left to the network.
  for (const q of ['What does TX-M1 supply?', 'Show me USS-1', 'What if USS-2 has no power?']) assert.equal(answerFacilityQuestion(q, ctx()), null, q);
});

test('which substations supply an area: those whose transformer is on its supply route, with the area’s provenance', () => {
  const yard = new Set(['HM-1', 'HM-2', 'HM-3']);
  const a = answerFacilityQuestion('Which substations supply the container yard?', ctx(x => (yard.has(x.id) ? 'CONTAINER YARD' : null)));
  assert.equal(a.kind, 'supply');
  assert.deepEqual(a.facilities.map(f => f.id).sort(), ['MSS', 'USS-2'], 'TX-M1 in MSS and TX-2 in USS-2; USS-1 is only passed through on the ring');
  assert.match(a.say2, /map area drawn by the application, not an IFC space/);
});
