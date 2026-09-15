import test from 'node:test';
import assert from 'node:assert/strict';
import { PLACEMENT_FIELDS, PLACEMENT_REASONS, STEP_METRES, formatModelRecordJson, formatPlacementJson, placementReadiness } from '../src/modelPlacementEditor.js';

const config = {
  id: 'i595-gantry-1-toll-plaza', name: 'Gantry 1 — Toll Plaza', type: 'GLB_MODEL', layer: 'gantries',
  modelKey: 'Gantry1_TollPlaza.glb', latitude: 26.1153108, longitude: -80.3168131,
  heightOffset: 0, heading: 11.3, viewHeading: 101.3, pitch: 0, roll: 0, scale: 1, enabled: true,
  photorealisticReplacement: { enabled: true, clippingPolygon: [[-80.3169, 26.1154], [-80.3167, 26.1154], [-80.3167, 26.1152]] },
};
const moved = { latitude: 26.11533915, longitude: -80.31681742, heightOffset: 0.354, heading: 92.44, pitch: 0, roll: 0, scale: 1.0215 };

test('the placement block carries the edited values, not the originals', () => {
  const placement = JSON.parse(formatPlacementJson(moved));
  assert.equal(placement.latitude, 26.1153392);
  assert.equal(placement.longitude, -80.3168174);
  assert.equal(placement.heightOffset, 0.354);
  assert.equal(placement.heading, 92.44);
  assert.equal(placement.scale, 1.0215);
  assert.deepEqual(Object.keys(placement).sort(), [...PLACEMENT_FIELDS].sort());
});

test('the full record replaces placement and keeps everything else', () => {
  const record = JSON.parse(formatModelRecordJson(config, moved));
  // The reason this exists: pasting coordinates must not cost you the clipping polygon.
  assert.deepEqual(record.photorealisticReplacement, config.photorealisticReplacement);
  for (const field of ['id', 'name', 'type', 'layer', 'modelKey', 'enabled', 'viewHeading']) {
    assert.equal(record[field], config[field], `${field} survives`);
  }
  assert.equal(record.latitude, 26.1153392);
  assert.equal(record.heading, 92.44);
  assert.equal(record.modelUrl, undefined, 'no local path is reintroduced');
});

test('step sizes cover centimetre to metre work', () => {
  assert.deepEqual(STEP_METRES, [0.01, 0.05, 0.1, 0.25, 0.5, 1]);
});

test('readiness names the one thing that is missing', () => {
  const entity = { id: 'i595-gantry-1-toll-plaza' };
  const base = { id: config.id, config, entity };

  const ready = placementReadiness(base);
  assert.equal(ready.ready, true);
  assert.equal(ready.reasonCode, PLACEMENT_REASONS.READY);
  assert.match(ready.message, /Ready to place Gantry 1/);

  // The model is loaded after the intro, so this is the ordinary state for the first seconds —
  // and it must resolve by itself rather than waiting for the dropdown to be touched.
  const notYet = placementReadiness({ ...base, entity: null });
  assert.equal(notYet.reasonCode, PLACEMENT_REASONS.MODEL_ENTITY_NOT_FOUND);
  assert.match(notYet.message, /not on the map yet/);

  assert.equal(placementReadiness({ ...base, id: null, config: null }).reasonCode, PLACEMENT_REASONS.NO_MODEL_SELECTED);
  assert.equal(placementReadiness({ ...base, config: null }).reasonCode, PLACEMENT_REASONS.MODEL_CONFIG_NOT_FOUND);
  assert.equal(placementReadiness({ ...base, config: { ...config, enabled: false } }).reasonCode, PLACEMENT_REASONS.MODEL_DISABLED);
  assert.equal(placementReadiness({ ...base, viewerReady: false }).reasonCode, PLACEMENT_REASONS.VIEWER_NOT_READY);
  assert.equal(placementReadiness({ ...base, drawing: true }).reasonCode, PLACEMENT_REASONS.DRAWING_MODE_ACTIVE);
  assert.equal(placementReadiness({ ...base, placing: true }).reasonCode, PLACEMENT_REASONS.PLACEMENT_ALREADY_ACTIVE);
});

test('placement never depends on clipping configuration', () => {
  const entity = { id: config.id };
  // A replacement usually has to be aligned before its clipping polygon is drawn, so a record with
  // no photorealisticReplacement must still be placeable.
  const { photorealisticReplacement, ...withoutClipping } = config;
  assert.equal(placementReadiness({ id: config.id, config: withoutClipping, entity }).ready, true);
  assert.equal(placementReadiness({ id: config.id, config, entity }).ready, true);
});

test('every model in the configuration reaches the same readiness', () => {
  // The fix is not specific to Gantry 1: readiness is computed from the record and the registry
  // entry, both keyed by the same id, so the other three behave identically.
  for (const id of ['i595-gantry-2-toll-lane', 'i595-gantry-3-toll-lane', 'i595-lane-barrier-arm-1']) {
    const record = { ...config, id, name: id };
    assert.equal(placementReadiness({ id, config: record, entity: { id } }).ready, true, id);
    assert.equal(placementReadiness({ id, config: record, entity: null }).reasonCode,
      PLACEMENT_REASONS.MODEL_ENTITY_NOT_FOUND, id);
  }
});
