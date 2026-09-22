import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isLightingCategory, LIGHTING_CATEGORIES, lightingRecords } from '../src/lightingData.js';

const rows = JSON.parse(readFileSync(new URL('../public/dataconnect-data/asset_registry.json', import.meta.url)));

test('the configured categories are exactly the lighting categories DataConnect publishes', () => {
  const inSnapshot = new Set(rows.map(row => row['Asset Category']).filter(isLightingCategory));
  assert.deepEqual([...inSnapshot].sort(), LIGHTING_CATEGORIES.map(c => c.source).sort());
  // Labels are the source values, not renamed.
  for (const category of LIGHTING_CATEGORIES) assert.equal(category.label, category.source);
});

test('DataConnect lighting preserves IDs, coordinates and all six category counts', () => {
  const records = lightingRecords(rows);
  assert.equal(records.length, 2895);
  assert.deepEqual(LIGHTING_CATEGORIES.map(c => records.filter(r => r.categoryId === c.id).length), [2679, 182, 23, 8, 2, 1]);
  assert.equal(new Set(records.map(r => r.id)).size, 2895);
  for (const r of records) {
    assert.equal(r.longitude, r.source['X Coordinates']);
    assert.equal(r.latitude, r.source['Y Coordinates']);
    assert.equal(r.id, String(r.source['Asset ID']).trim());
    assert.equal(r.categoryLabel, r.source['Asset Category']);
  }
});

test('lighting ignores other assets and unusable coordinates, rejects duplicate IDs, reports unknown lighting categories', () => {
  const row = { 'Asset ID': 'L1', 'Asset Category': 'Lighting', 'X Coordinates': -80.3, 'Y Coordinates': 26.1 };
  assert.equal(lightingRecords([row, { ...row, 'Asset Category': 'Camera' }]).length, 1);
  assert.equal(lightingRecords([{ ...row, 'X Coordinates': null }]).length, 0);
  assert.throws(() => lightingRecords([row, row]), /duplicate/);
  const warnings = [];
  lightingRecords([{ ...row, 'Asset Category': 'Lighting - High Mast' }], { logger: { warn: m => warnings.push(m) } });
  assert.match(warnings[0], /High Mast/);
});

test('the Segment column is labelled for what it holds, from the record text alone', async () => {
  const { lightingPlace } = await import('../src/assetExplorer/assetTypes.js');
  assert.deepEqual(lightingPlace({ Segment: 'Central-West Segment' }), { label: 'Corridor section', value: 'Central-West Segment', card: 'Central-West Segment' });
  assert.deepEqual(lightingPlace({ Segment: 'A-6 -21-Z2 - Zone Z2' }), { label: 'Pole / zone', value: 'A-6 -21-Z2 - Zone Z2', card: 'Lighting zone Z2' });
  assert.deepEqual(lightingPlace({ Segment: '860384' }), { label: 'Bridge', value: '860384', card: 'Bridge 860384' });
  assert.equal(lightingPlace({ Segment: 'A1 5-Z6' }).label, 'Pole / structure');
  assert.equal(lightingPlace({ Segment: null }), null);
  // Every lighting record's Segment lands in one of the four readings.
  const records = lightingRecords(rows);
  assert.ok(records.every(r => lightingPlace(r.source)));
});
