import test from 'node:test';
import assert from 'node:assert/strict';
import { declutterHidden, nearFarScalarValue, MIN_GAP_PX } from '../src/mapMarkerDeclutter.js';

const marker = (id, x, y, distance) => ({ id, x, y, distance });

test('markers far enough apart on screen all survive', () => {
  const hidden = declutterHidden([marker('a', 100, 100, 500), marker('b', 100 + MIN_GAP_PX, 100, 900)]);
  assert.equal(hidden.size, 0);
});

test('the nearer marker keeps the screen when two collide', () => {
  const hidden = declutterHidden([marker('far', 200, 200, 15600), marker('near', 205, 203, 4490)]);
  assert.deepEqual([...hidden], ['far'], 'distance decides, not the order they arrive in');
});

test('the measured I-595 horizon pile-up resolves to legible spacing', () => {
  // Measured from a camera at Gantry 1 looking east down the corridor.
  const hidden = declutterHidden([
    marker('pine-island-rd', 766, 203, 4490),
    marker('university-dr', 793, 196, 7290),
    marker('floridas-turnpike', 793, 193, 11000),
    marker('sr7-us441', 823, 193, 12160),
    marker('i95', 770, 192, 15560),
  ]);
  assert.deepEqual([...hidden].sort(), ['floridas-turnpike', 'i95', 'university-dr']);
  // What is left must actually be readable, which is the whole point.
  const kept = [[766, 203], [823, 193]];
  assert.ok(Math.hypot(kept[0][0] - kept[1][0], kept[0][1] - kept[1][1]) >= MIN_GAP_PX);
});

test('a marker hidden behind a nearer one does not itself reserve screen space', () => {
  // b is hidden by a; c is far from a but close to b, so c must still be drawn.
  const hidden = declutterHidden([
    marker('a', 100, 100, 100),
    marker('b', 120, 100, 200),
    marker('c', 120 + MIN_GAP_PX - 1, 100, 300),
  ]);
  assert.deepEqual([...hidden], ['b'], 'only the marker that overlapped a drawn one stands down');
});

test('equal distances break on id so a frame does not flicker', () => {
  const one = declutterHidden([marker('b', 10, 10, 500), marker('a', 12, 10, 500)]);
  const two = declutterHidden([marker('a', 12, 10, 500), marker('b', 10, 10, 500)]);
  assert.deepEqual([...one], [...two]);
  assert.deepEqual([...one], ['b']);
});

test('an empty frame hides nothing', () => {
  assert.equal(declutterHidden([]).size, 0);
});

test('a wide label and a marker directly above it do not fight for the same box', () => {
  // A label is wide and short: 50 px of vertical separation clears it, 50 px of horizontal does not.
  const label = { id: 'turnpike', x: 400, y: 300, distance: 900, halfWidth: 55, halfHeight: 8 };
  const above = { id: 'shield', x: 400, y: 250, distance: 1200, halfWidth: 20, halfHeight: 20 };
  const beside = { id: 'sr7', x: 450, y: 300, distance: 1200, halfWidth: 20, halfHeight: 20 };
  assert.equal(declutterHidden([label, above]).size, 0, 'clear vertically');
  assert.deepEqual([...declutterHidden([label, beside])], ['sr7'], 'overlapping horizontally');
});

test('nearFarScalarValue matches the ramp Cesium applies', () => {
  const ramp = { near: 600, nearValue: 1, far: 22000, farValue: 0.8 };
  assert.equal(nearFarScalarValue(ramp, 100), 1, 'clamped below near');
  assert.equal(nearFarScalarValue(ramp, 30000), 0.8, 'clamped above far');
  assert.ok(Math.abs(nearFarScalarValue(ramp, 11300) - 0.9) < 1e-9, 'linear in between');
  assert.equal(nearFarScalarValue(undefined, 5000), 1, 'no ramp means full size');
});
