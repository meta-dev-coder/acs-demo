import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CORRIDOR_LAYERS, MAP_VIEW_PRESETS, PRESET_SCOPE, RAIL_LAYER_IDS,
  combineStates, matchingPreset,
} from '../src/mapLayerStore.js';

const byId = new Map(CORRIDOR_LAYERS.map(layer => [layer.id, layer]));

test('every rail tool and preset names a layer that actually exists', () => {
  for (const id of RAIL_LAYER_IDS) assert.ok(byId.has(id), `rail tool "${id}" must exist`);
  assert.ok(RAIL_LAYER_IDS.includes('structures'), 'bridges are reachable from the rail');
  assert.ok(RAIL_LAYER_IDS.includes('gantries'), 'toll gantries are reachable from the rail');
  // A barrier arm is not a gantry: it must have its own tool, not hide inside the gantry layer.
  assert.ok(RAIL_LAYER_IDS.includes('lane-barriers'), 'lane barriers are a rail tool of their own');
  assert.notEqual(byId.get('gantries').icon, byId.get('lane-barriers').icon, 'the two model layers are told apart by their icons');
  for (const preset of MAP_VIEW_PRESETS) {
    for (const id of preset.on) assert.ok(byId.has(id), `preset "${preset.id}" names unknown layer "${id}"`);
  }
  // Mile markers are absent on purpose: the corridor has no such layer, so the UI must not offer one.
  assert.ok(!CORRIDOR_LAYERS.some(layer => /mile/i.test(layer.id + layer.label)));
});

test('every layer is reachable through a control or through its members', () => {
  for (const layer of CORRIDOR_LAYERS) {
    if (layer.members) {
      assert.ok(layer.members.every(id => byId.has(id)), `${layer.id} members must exist`);
      assert.ok(!layer.control, 'a composite layer has no control of its own');
    } else {
      assert.match(layer.control, /^#[\w-]+$/, `${layer.id} must name a control`);
    }
    assert.ok(layer.category, `${layer.id} must belong to a category`);
  }
  // Exactly one control per layer: no layer is driven from two places.
  const controls = CORRIDOR_LAYERS.map(layer => layer.control).filter(Boolean);
  assert.equal(new Set(controls).size, controls.length);
});

test('composite state folds its members', () => {
  assert.equal(combineStates(['on', 'on', 'on']), 'on');
  assert.equal(combineStates(['off', 'off']), 'off');
  assert.equal(combineStates(['on', 'off']), 'partial');
  assert.equal(combineStates(['on', 'partial']), 'partial');
  // A layer whose module has not loaded yet does not drag the composite down.
  assert.equal(combineStates(['on', 'unavailable']), 'on');
  assert.equal(combineStates(['unavailable', 'unavailable']), 'unavailable');
  assert.equal(combineStates([]), 'unavailable');
});

/** A fake map: every preset-governed layer off unless listed. */
const stateFrom = on => id => (PRESET_SCOPE.includes(id) ? (on.includes(id) ? 'on' : 'off') : 'off');

test('each preset is recognised from the layer states it produces', () => {
  for (const preset of MAP_VIEW_PRESETS) {
    assert.equal(matchingPreset(stateFrom(preset.on)), preset.id, `${preset.id} must round-trip`);
  }
});

test('presets differ from one another', () => {
  const signatures = MAP_VIEW_PRESETS.map(preset => [...preset.on].sort().join(','));
  assert.equal(new Set(signatures).size, signatures.length, 'two presets must not produce the same map');
});

test('customising a layer after a preset leaves the preset rather than resetting the map', () => {
  const operations = MAP_VIEW_PRESETS.find(preset => preset.id === 'operations');
  assert.equal(matchingPreset(stateFrom(operations.on)), 'operations');
  // Turning the corridor off is not any preset, so the panel shows Custom — and, crucially, no
  // other layer is moved back: the preset is identified from the state, never enforced onto it.
  assert.equal(matchingPreset(stateFrom(operations.on.filter(id => id !== 'traffic-flow'))), null);
  // Turning it back on returns to the preset, because the state is what identifies it.
  assert.equal(matchingPreset(stateFrom(operations.on)), 'operations');
  // A change that happens to describe another preset exactly is reported as that preset, not as
  // Custom — the label always tells the truth about what is on the map.
  const traffic = MAP_VIEW_PRESETS.find(preset => preset.id === 'traffic');
  assert.equal(matchingPreset(stateFrom(operations.on.filter(id => id !== 'signals'))), traffic.id);
});

test('a preset states the whole map, so switching presets cannot leave a layer behind', () => {
  for (const preset of MAP_VIEW_PRESETS) {
    for (const id of PRESET_SCOPE) {
      assert.ok(preset.on.includes(id) || !preset.on.includes(id), 'every governed layer has a defined position');
    }
  }
  // Clean really is the quietest view.
  const clean = MAP_VIEW_PRESETS.find(preset => preset.id === 'clean');
  const operations = MAP_VIEW_PRESETS.find(preset => preset.id === 'operations');
  assert.ok(clean.on.length < operations.on.length);
  assert.ok(clean.on.includes('traffic-flow'), 'the corridor itself stays visible in every preset');
  for (const preset of MAP_VIEW_PRESETS) assert.ok(preset.on.includes('traffic-flow'));
});

test('layers whose module reports no count simply have none', () => {
  const counted = CORRIDOR_LAYERS.filter(layer => layer.count).map(layer => layer.id);
  assert.deepEqual(counted.sort(), ['cameras', 'gantries', 'incidents', 'lane-barriers', 'signals', 'structures']);
  // Ramps and frontage roads expose no count API, so the UI shows no number for them.
  for (const id of ['ramps', 'frontage', 'mainline-eb']) assert.equal(byId.get(id).count, undefined);
});
