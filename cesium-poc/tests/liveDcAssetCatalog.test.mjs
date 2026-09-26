import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EXCLUDED_CATEGORIES, assetsFromCurated, assetsFromRegistry, nearestAsset } from '../server/liveDc/assetCatalog.mjs';

const M_PER_DEG_LAT = 111_195;
const P = { longitude: -80.2266, latitude: 26.0934 };
const north = (meters) => P.latitude + meters / M_PER_DEG_LAT;

function asset(code, category, metersNorth, extra = {}) {
  return { code, category, systemClass: null, longitude: P.longitude, latitude: north(metersNorth), segmentCode: null, name: null, ...extra };
}

test('EXCLUDED_CATEGORIES is a frozen set of non-physical categories', () => {
  assert.deepEqual([...EXCLUDED_CATEGORIES].sort(), ['Accidents', 'Homeless']);
  assert.ok(Object.isFrozen(EXCLUDED_CATEGORIES));
});

test('assetsFromCurated maps curated items, keeps invalid ones, drops excluded/bad rows and dedupes', () => {
  const items = [
    { id: 'a', keyInSource: '1001', valid: false, attributes: { code: 1001, name: 'L-1', 'asset category': 'Lighting', 'system class': 'Lighting', x_coordinates: -80.2, y_coordinates: 26.09 } },
    { id: 'b', keyInSource: 'WGT-9', valid: true, attributes: { 'asset category': 'WGT', 'x coordinates': -80.21, 'y coordinates': 26.1, 'segment ID': '103E' } },
    { id: 'c', keyInSource: '1001', valid: true, attributes: { code: '1001', 'asset category': 'Drainage', x_coordinates: -80.3, y_coordinates: 26.0 } },
    { id: 'd', keyInSource: 'ACC', valid: true, attributes: { 'asset category': 'Accidents', x_coordinates: -80.2, y_coordinates: 26.09 } },
    { id: 'e', keyInSource: 'NOXY', valid: true, attributes: { 'asset category': 'Lighting' } },
    { id: 'f', keyInSource: 'NaN', valid: true, attributes: { 'asset category': 'Lighting', x_coordinates: 'abc', y_coordinates: 26.1 } },
    { id: 'g', keyInSource: 'NOCAT', valid: true, attributes: { x_coordinates: -80.2, y_coordinates: 26.09 } },
  ];
  assert.deepEqual(assetsFromCurated(items), [
    { code: '1001', category: 'Lighting', systemClass: 'Lighting', longitude: -80.2, latitude: 26.09, segmentCode: null, name: 'L-1' },
    { code: 'WGT-9', category: 'WGT', systemClass: null, longitude: -80.21, latitude: 26.1, segmentCode: '103E', name: null },
  ]);
});

test('assetsFromRegistry maps registry rows with numeric ids as strings', () => {
  const rows = [
    { 'Asset ID': 42, 'Asset Category': 'Attenuetors', 'System Class': 'Roadway', 'Asset Description': 'Crash cushion', 'X Coordinates': -80.22, 'Y Coordinates': 26.09 },
    { 'Asset ID': '42', 'Asset Category': 'Lighting', 'X Coordinates': -80.1, 'Y Coordinates': 26.1 },
    { 'Asset ID': 'H1', 'Asset Category': 'Homeless', 'X Coordinates': -80.1, 'Y Coordinates': 26.1 },
    { 'Asset ID': 'BAD', 'Asset Category': 'Lighting', 'X Coordinates': null, 'Y Coordinates': 26.1 },
  ];
  assert.deepEqual(assetsFromRegistry(rows), [
    { code: '42', category: 'Attenuetors', systemClass: 'Roadway', longitude: -80.22, latitude: 26.09, segmentCode: null, name: 'Crash cushion' },
  ]);
});

test('nearestAsset honours category priority over raw distance', () => {
  const assets = [asset('L1', 'Lighting', 50), asset('A1', 'Attenuetors', 300), asset('A2', 'Attenuetors', 200)];
  const hit = nearestAsset(assets, P, { categories: ['Attenuetors', 'Lighting'], radiusMeters: 400 });
  assert.equal(hit.asset.code, 'A2');
  assert.equal(hit.distanceM, Math.round(hit.distanceM * 10) / 10);
  assert.ok(Math.abs(hit.distanceM - 200) < 1);
});

test('nearestAsset falls back to the next category when the first has nothing in radius', () => {
  const assets = [asset('L1', 'Lighting', 50), asset('A1', 'Attenuetors', 900)];
  assert.equal(nearestAsset(assets, P, { categories: ['Attenuetors', 'Lighting'], radiusMeters: 400 }).asset.code, 'L1');
});

test('nearestAsset returns null beyond the radius or with no categories', () => {
  const assets = [asset('L1', 'Lighting', 500)];
  assert.equal(nearestAsset(assets, P, { categories: ['Lighting'], radiusMeters: 400 }), null);
  assert.equal(nearestAsset(assets, P, { categories: [], radiusMeters: 1000 }), null);
  assert.equal(nearestAsset(assets, { longitude: NaN, latitude: 26 }, { categories: ['Lighting'], radiusMeters: 1000 }), null);
});

test('nearestAsset breaks exact distance ties by code, independent of input order', () => {
  const a = asset('B7', 'Lighting', 100), b = asset('A9', 'Lighting', 100);
  assert.equal(nearestAsset([a, b], P, { categories: ['Lighting'], radiusMeters: 400 }).asset.code, 'A9');
  assert.equal(nearestAsset([b, a], P, { categories: ['Lighting'], radiusMeters: 400 }).asset.code, 'A9');
});

test('the real asset registry yields no excluded categories and string codes', async () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'dataconnect-data', 'asset_registry.json');
  const rows = JSON.parse(await readFile(path, 'utf8'));
  const assets = assetsFromRegistry(rows);
  assert.ok(assets.length > 4000);
  assert.ok(assets.every((a) => !EXCLUDED_CATEGORIES.has(a.category)));
  assert.ok(assets.every((a) => typeof a.code === 'string' && Number.isFinite(a.longitude) && Number.isFinite(a.latitude)));
  assert.equal(new Set(assets.map((a) => a.code)).size, assets.length);
  assert.ok(assets.some((a) => a.category === 'Attenuetors'));
});
