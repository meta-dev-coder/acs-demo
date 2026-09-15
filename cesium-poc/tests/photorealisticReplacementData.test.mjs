import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_POLYGON_POINTS, REPLACEMENT_STRATEGIES, flattenPolygon, formatReplacementJson,
  readClippingPolygon, replacementRecords, replacementStrategy, roundCoordinate,
} from '../src/photorealisticReplacementData.js';

const square = [[-80.3168501, 26.1153302], [-80.3167803, 26.115331], [-80.3167798, 26.1152854], [-80.3168497, 26.1152849]];
const model = (extra = {}) => ({ id: 'i595-gantry-1-toll-plaza', name: 'Gantry 1', ...extra });

test('a polygon is read only when it could actually clip something', () => {
  assert.equal(readClippingPolygon(square).ok, true);
  assert.match(readClippingPolygon(square.slice(0, 2)).error ?? readClippingPolygon(square.slice(0, 2)).reason, /at least 3/);
  assert.match(readClippingPolygon('nope').reason, /not an array/);
  assert.match(readClippingPolygon([[-80.3, 26.1], [-80.3], [-80.29, 26.1]]).reason, /point 2 is not a \[longitude, latitude\] pair/);
  assert.match(readClippingPolygon([[-80.3, 26.1], [-80.29, 126.1], [-80.29, 26.11]]).reason, /point 2 latitude/);
  assert.equal(MIN_POLYGON_POINTS, 3);
});

test('coordinates keep longitude first — the order fromDegreesArray expects', () => {
  const { polygon } = readClippingPolygon(square);
  assert.ok(polygon.every(([longitude, latitude]) => longitude < -80 && latitude > 26),
    'a Florida polygon reads as negative longitude, positive latitude');
  assert.deepEqual(flattenPolygon([[1, 2], [3, 4], [5, 6]]), [1, 2, 3, 4, 5, 6]);
});

test('only records that ask to replace photogrammetry are clipped', () => {
  const { records, clipping, skipped } = replacementRecords([
    model({ photorealisticReplacement: { enabled: true, clippingPolygon: square } }),
    model({ id: 'off', photorealisticReplacement: { enabled: false, clippingPolygon: square } }),
    model({ id: 'plain' }),
    model({ id: 'short', photorealisticReplacement: { enabled: true, clippingPolygon: square.slice(0, 2) } }),
  ]);
  assert.deepEqual(records.map(record => record.id), ['i595-gantry-1-toll-plaza']);
  assert.deepEqual(clipping.map(record => record.id), ['i595-gantry-1-toll-plaza']);
  // A disabled or absent block is ordinary; a broken polygon is worth reporting.
  assert.deepEqual(skipped.map(item => item.id), ['short']);
  assert.deepEqual(replacementRecords(null), { records: [], clipping: [], skipped: [] });
});

test('a strategy decides whether a polygon reaches the tileset — and never discards it', () => {
  // The reason this exists: a clipping polygon removes everything in its column, road included, so
  // a model may need to stop clipping without losing coordinates that were traced by hand.
  const { records, clipping } = replacementRecords([
    model({ photorealisticReplacement: { enabled: true, strategy: 'OCCLUSION', clippingPolygon: square } }),
    model({ id: 'clipper', photorealisticReplacement: { enabled: true, strategy: 'CLIPPING_POLYGON', clippingPolygon: square } }),
    model({ id: 'undecided', photorealisticReplacement: { enabled: true, strategy: 'NONE', clippingPolygon: square } }),
  ]);
  assert.deepEqual(clipping.map(record => record.id), ['clipper'], 'only the clipping strategy cuts tiles');
  assert.equal(records.length, 3, 'every declared record is still reported');
  const occluding = records.find(record => record.id === 'i595-gantry-1-toll-plaza');
  assert.equal(occluding.strategy, REPLACEMENT_STRATEGIES.OCCLUSION);
  assert.deepEqual(occluding.polygon, square, 'its coordinates survive the switch');
});

test('records written before strategies existed keep clipping', () => {
  assert.equal(replacementStrategy({ enabled: true, clippingPolygon: square }), REPLACEMENT_STRATEGIES.CLIPPING_POLYGON);
  assert.equal(replacementStrategy({ enabled: true }), REPLACEMENT_STRATEGIES.NONE);
  assert.equal(replacementStrategy({ strategy: 'OCCLUSION' }), REPLACEMENT_STRATEGIES.OCCLUSION);
  assert.equal(replacementStrategy({ strategy: 'nonsense', clippingPolygon: square }), REPLACEMENT_STRATEGIES.CLIPPING_POLYGON);
});

test('an occlusion record may have no polygon at all', () => {
  const { records, clipping, skipped } = replacementRecords([
    model({ photorealisticReplacement: { enabled: true, strategy: 'OCCLUSION' } }),
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].polygon, null);
  assert.deepEqual(clipping, [], 'nothing to clip');
  assert.deepEqual(skipped, [], 'and nothing to complain about — a polygon was never required');
});

test('the generated JSON is what the loader reads back', () => {
  const text = formatReplacementJson(square);
  const parsed = JSON.parse(`{${text}}`);
  const { clipping } = replacementRecords([model({ photorealisticReplacement: parsed.photorealisticReplacement })]);
  assert.equal(clipping.length, 1, 'the copied block round-trips into an applied polygon');
  assert.deepEqual(clipping[0].polygon, square);
  assert.equal(parsed.photorealisticReplacement.strategy, REPLACEMENT_STRATEGIES.CLIPPING_POLYGON,
    'the generated block states its strategy rather than relying on a default');
  assert.equal(roundCoordinate(-80.31685013333), -80.3168501, 'seven decimal places');
});
