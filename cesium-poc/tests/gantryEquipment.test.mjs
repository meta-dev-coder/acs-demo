/**
 * The gantry's equipment, as the 3D model names it.
 *
 * These tests hold the line between what the GLB actually says and what it would be convenient to
 * assume: that a lane number is the modeller's grouping rather than a roadway lane, that Blender's
 * `.001` suffixes never become business identifiers, that an unnamed mesh stays unclassified, and
 * that the inventory is counted from the file rather than typed in here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildEquipmentAssets, classifyNode, EQUIPMENT_TYPES, IDENTIFICATION, initialSimulationState,
  inventoryOf, isEquipment, SIMULATION_STATES } from '../src/tolling/gantryEquipment.js';
import { buildManifest, readGlb } from '../tools/inspect-gantry-glb.mjs';

const manifest = JSON.parse(readFileSync(new URL('../config/gantryEquipment/i595-gantry-1-toll-plaza.json', import.meta.url)));

// ------------------------------------------------------------------ reading a node name

test('equipment is classified from what the node name states, and only that', () => {
  assert.deepEqual(classifyNode('RFID Lane 1 A'),
    { type: 'RFID_ANTENNA', lane: 1, side: 'A', identification: IDENTIFICATION.NAMED });
  assert.deepEqual(classifyNode('VES camera Lane 3 B'),
    { type: 'VES_CAMERA', lane: 3, side: 'B', identification: IDENTIFICATION.NAMED });
  // The modeller's duplicate suffix and the "-1"/"-2" variants do not change what a thing is.
  assert.deepEqual(classifyNode('Toll cameras Lane 3 B -1'),
    { type: 'TOLL_CAMERA', lane: 3, side: 'B', identification: IDENTIFICATION.NAMED });
  assert.deepEqual(classifyNode('RFID Lane 2 A.001'),
    { type: 'RFID_ANTENNA', lane: 2, side: 'A', identification: IDENTIFICATION.NAMED });
  // Trailing spaces survive a Blender export; they must not make a different asset.
  assert.deepEqual(classifyNode('Toll cameras Lane 3 A '),
    { type: 'TOLL_CAMERA', lane: 3, side: 'A', identification: IDENTIFICATION.NAMED });
});

test('a name that does not say where something is reports that, rather than guessing', () => {
  // "Toll cameras.002" is a toll camera; which group it serves is simply not stated.
  assert.deepEqual(classifyNode('Toll cameras.002'),
    { type: 'TOLL_CAMERA', lane: null, side: null, identification: IDENTIFICATION.GROUP_UNKNOWN });
  assert.deepEqual(classifyNode('CCTV camera B-2'),
    { type: 'CCTV_CAMERA', lane: null, side: 'B', identification: IDENTIFICATION.GROUP_UNKNOWN });
  // And a name that says nothing at all is unclassified, not forced into the nearest class.
  assert.deepEqual(classifyNode('Gantry assets.004'),
    { type: 'UNCLASSIFIED', lane: null, side: null, identification: IDENTIFICATION.UNCLASSIFIED });
  assert.equal(classifyNode('Cube.123').type, 'UNCLASSIFIED');
  assert.equal(classifyNode('').type, 'UNCLASSIFIED');
});

// ------------------------------------------------------------------ identifiers

test('asset ids are stable, and never built out of Blender suffixes', () => {
  const names = ['RFID Lane 1 B.001', 'RFID Lane 1 A', 'RFID Lane 1 B'];
  const first = buildEquipmentAssets(names, { gantryId: 'I595_G01' });
  assert.equal(first.find(a => a.nodeName === 'RFID Lane 1 A').assetId, 'I595_G01_L01_A_RFID_001');
  assert.equal(first.find(a => a.nodeName === 'RFID Lane 1 B').assetId, 'I595_G01_L01_B_RFID_001');
  assert.equal(first.find(a => a.nodeName === 'RFID Lane 1 B.001').assetId, 'I595_G01_L01_B_RFID_002');
  for (const asset of first) assert.ok(!/\.\d{3}/.test(asset.assetId), `${asset.assetId} carries a Blender suffix`);

  // The same nodes in a different order — which is how Cesium may hand them back — are the same ids.
  const shuffled = buildEquipmentAssets([...names].reverse(), { gantryId: 'I595_G01' });
  for (const asset of first) {
    assert.equal(shuffled.find(a => a.nodeName === asset.nodeName).assetId, asset.assetId);
  }
});

test('an id carries the group and side only when the model states them', () => {
  const [tollCamera, cctv] = buildEquipmentAssets(['Toll cameras', 'CCTV camera A-1'], { gantryId: 'I595_G01' });
  assert.equal(tollCamera.assetId, 'I595_G01_TOLL_CAM_001');
  assert.equal(tollCamera.laneGroup, null);
  assert.equal(cctv.assetId, 'I595_G01_A_CCTV_001');
  assert.equal(cctv.side, 'A');
  assert.equal(cctv.laneGroup, null);
});

// ------------------------------------------------------------------ the real model

test('the manifest is the GLB, counted rather than claimed', () => {
  const file = new URL('../public/models/i595/gantry-1-toll-plaza-v2.glb', import.meta.url);
  let buffer;
  try { buffer = readFileSync(file); } catch { return; } // the mesh is git-ignored; skip without it
  const built = buildManifest(buffer, { gantryId: 'I595_G01', modelId: 'i595-gantry-1-toll-plaza', file: 'x.glb' });
  assert.equal(built.assets.length, built.source.nodes, 'every node becomes exactly one asset');
  assert.equal(built.source.namedNodes, built.source.nodes, 'every node in this model is named');
  // The shipped manifest must still describe the shipped model.
  assert.deepEqual(built.assets.map(a => a.assetId), manifest.assets.map(a => a.assetId));
  assert.equal(readGlb(buffer).json.asset.version, '2.0');
});

test('the shipped manifest reports an inventory with nothing invented', () => {
  const byType = Object.fromEntries(manifest.inventory.map(row => [row.type, row.count]));
  assert.equal(manifest.assets.length, manifest.source.nodes);
  assert.equal(Object.values(byType).reduce((total, count) => total + count, 0), manifest.assets.length);
  // Exactly one structure node, and it is not offered as a piece of equipment.
  assert.equal(byType.STRUCTURE, 1);
  assert.equal(manifest.assets.filter(isEquipment).length, manifest.assets.length - 1);
  // Every asset id is unique and every one names the node it came from.
  assert.equal(new Set(manifest.assets.map(a => a.assetId)).size, manifest.assets.length);
  for (const asset of manifest.assets) {
    assert.ok(asset.nodeName, `${asset.assetId} has no node name`);
    assert.ok(Array.isArray(asset.centre) && asset.centre.length === 3, `${asset.assetId} has no bounds`);
    assert.ok(asset.halfSize.every(value => value > 0), `${asset.assetId} has an empty extent`);
  }
  // Counts come from the file. This asserts they agree with the file, not what they should be.
  assert.deepEqual(inventoryOf(manifest.assets), manifest.inventory);
});

test('equipment types each declare what the equipment does, and unclassified does not pretend to', () => {
  for (const [id, type] of Object.entries(EQUIPMENT_TYPES)) {
    assert.equal(type.id, id);
    assert.ok(type.code && type.label && type.singular);
  }
  assert.equal(EQUIPMENT_TYPES.UNCLASSIFIED.equipmentFunction, null);
  assert.match(EQUIPMENT_TYPES.RFID_ANTENNA.equipmentFunction, /transponder/i);
});

// ------------------------------------------------------------------ the simulation scaffold

test('simulation state starts normal and lives beside the asset, not in it', () => {
  const state = initialSimulationState();
  assert.deepEqual(state, { status: 'NORMAL', failureType: null, scenarioId: null });
  assert.ok(SIMULATION_STATES.includes(state.status));
  assert.deepEqual(SIMULATION_STATES, ['NORMAL', 'DEGRADED', 'FAILED', 'UNDER_MAINTENANCE']);
  // The manifest — what the model says — carries no simulation state at all.
  for (const asset of manifest.assets) assert.equal(asset.simulationState, undefined);
});
