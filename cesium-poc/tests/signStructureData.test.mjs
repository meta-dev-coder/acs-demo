import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIGN_STRUCTURE_TYPES, corridorBearingAt, readSignStructures,
  signStructureDetails, signStructureFromFeature, signStructureLabel, signStructureType,
} from '../src/signStructureData.js';

const overlane = signStructureType('overlane');
const feature = (properties, coordinates = [-80.31829158, 26.11533931]) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates },
  properties: { id: 'I595_GANTRY_001', structure_type: 'OVERLANE', fdot_objectid: 219099, hlid: '154728',
    milepost: 1, roadway_id: '86095000', light_count: 2, heading: null, height_m: null, verified: false, ...properties },
});

test('every registered structure type is addressable and complete', () => {
  for (const type of SIGN_STRUCTURE_TYPES) {
    for (const field of ['id', 'label', 'groupLabel', 'structureType', 'source', 'icon', 'control']) {
      assert.ok(type[field], `${type.id} needs ${field}`);
    }
    assert.equal(signStructureType(type.id), type);
    assert.ok(type.source.startsWith('data/'), 'sources resolve against BASE_URL, so no leading slash');
    // FDOT's dsigntype, or null where it records no classification — which is what UNCLASSIFIED is.
    assert.ok(type.fdotSignType === null || [1, 2, 3].includes(type.fdotSignType), 'fdotSignType is FDOT dsigntype or null');
    assert.ok(type.glyph.includes('<'), `${type.id} needs marker artwork`);
  }
  const ids = SIGN_STRUCTURE_TYPES.map(type => type.id);
  assert.equal(new Set(ids).size, ids.length, 'type ids are unique');
  // A type that looked like another on the map would be worse than no marker at all: a cantilever
  // is not a portal, and an unclassified structure is neither.
  for (const field of ['glyph', 'accent', 'icon', 'control', 'structureType']) {
    const values = SIGN_STRUCTURE_TYPES.map(type => type[field]);
    assert.equal(new Set(values).size, values.length, `every type needs its own ${field}`);
  }
});

test('a feature becomes a record, with the reserved fields left null rather than NaN', () => {
  const { record } = signStructureFromFeature(feature(), overlane);
  assert.equal(record.id, 'I595_GANTRY_001');
  assert.equal(record.longitude, -80.31829158);
  assert.equal(record.latitude, 26.11533931);
  assert.equal(record.milepost, 1);
  assert.equal(record.lightCount, 2);
  assert.equal(record.verified, false);
  // These three are null in every current file and must not become NaN or 0.
  assert.equal(record.heading, null);
  assert.equal(record.heightM, null);
  assert.equal(record.structureType, 'OVERLANE');
});

test('unplaceable features are reported rather than dropped in silence', () => {
  assert.match(signStructureFromFeature(feature({ id: null }), overlane).error.reason, /no id/);
  assert.match(signStructureFromFeature({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: { id: 'X' } }, overlane).error.reason, /not a Point/);
  // A reversed pair is caught only when it leaves the valid range — the named fields are the real guard.
  assert.match(signStructureFromFeature(feature({}, [-80.3, 126.1]), overlane).error.reason, /latitude/);
});

test('reading a collection separates what loaded from what did not', () => {
  const result = readSignStructures({ features: [
    feature(), feature({ id: 'I595_GANTRY_002' }), feature({ id: 'I595_GANTRY_002' }), feature({ id: null }),
  ] }, overlane);
  assert.equal(result.featureCount, 4, 'the file count is kept apart from the loaded count');
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.skipped.map(item => item.reason), ['duplicate id', 'feature has no id']);
  assert.deepEqual(readSignStructures(null, overlane), { records: [], skipped: [], featureCount: 0 });
});

test('an unclassified structure says so rather than borrowing another type’s name', () => {
  const unclassified = signStructureType('unclassified');
  assert.equal(unclassified.fdotSignType, null, 'FDOT records no dsigntype for these');
  const { record } = signStructureFromFeature({
    type: 'Feature', geometry: { type: 'Point', coordinates: [-80.35063387, 26.12024718] },
    properties: { id: 'I595_UNCLASSIFIED_001', structure_type: 'UNCLASSIFIED', fdot_sign_type: null, milepost: 1, light_count: 1, verified: false },
  }, unclassified);
  assert.equal(record.structureType, 'UNCLASSIFIED');
  assert.equal(signStructureDetails(record)[0][1], 'Unclassified Structure');
});

test('rows and labels stay readable when a value is missing', () => {
  assert.equal(signStructureLabel({ id: 'I595_GANTRY_003', milepost: 4 }), 'I595_GANTRY_003   MP 4');
  assert.equal(signStructureLabel({ id: 'I595_GANTRY_003', milepost: null }), 'I595_GANTRY_003');
  const rows = signStructureDetails({ ...signStructureFromFeature(feature({ hlid: null, light_count: null }), overlane).record });
  assert.deepEqual(rows.map(([name]) => name),
    ['Structure', 'ID', 'FDOT Object ID', 'HLID', 'Milepost', 'Roadway ID', 'Light Count', 'Latitude', 'Longitude', 'Verification Status']);
  assert.equal(rows[0][1], 'Overlane Structure', 'the panel says which kind of structure this is');
  assert.equal(rows.find(([name]) => name === 'HLID')[1], '—', 'a missing value shows a dash, not "null"');
  assert.equal(rows.find(([name]) => name === 'Verification Status')[1], 'Unverified');
  assert.equal(rows.every(([, value]) => typeof value === 'string'), true, 'panel values are already text');
});

test('the inspection camera falls back safely when the corridor cannot answer', () => {
  const centerline = [{ lon: -80.34, lat: 26.118 }, { lon: -80.33, lat: 26.1185 }, { lon: -80.32, lat: 26.119 }];
  const bearing = corridorBearingAt(centerline, -80.33, 26.1185);
  assert.ok(bearing > 80 && bearing < 100, `an east-west corridor reads about 90°, got ${bearing}`);
  assert.equal(corridorBearingAt([], -80.33, 26.1185), null);
  assert.equal(corridorBearingAt(null, -80.33, 26.1185), null);
  assert.equal(corridorBearingAt([{ lon: 1, lat: 1 }, { lon: 1, lat: 1 }], 1, 1), null, 'a degenerate span has no bearing');
});
