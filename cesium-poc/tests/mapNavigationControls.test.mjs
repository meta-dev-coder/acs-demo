import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  MAX_PITCH_DEG, MIN_PITCH_DEG, ROTATE_STEP_DEG, TILT_STEP_DEG, clampPitchDeg, normalizeHeadingDeg,
} from '../src/mapNavigationControls.js';

test('the tilt range keeps the camera the right way up', () => {
  assert.ok(MIN_PITCH_DEG < MAX_PITCH_DEG);
  assert.ok(MIN_PITCH_DEG >= -90 && MAX_PITCH_DEG < 0, 'never past straight down, never above the horizon');
  for (const [input, expected] of [[-90, MIN_PITCH_DEG], [-200, MIN_PITCH_DEG], [0, MAX_PITCH_DEG], [90, MAX_PITCH_DEG]]) {
    assert.equal(clampPitchDeg(input), expected);
  }
  // Inside the range the value is left alone.
  for (const pitch of [-84, -45, -23, -11]) assert.equal(clampPitchDeg(pitch), pitch);
  // A camera that has somehow lost its pitch lands somewhere usable rather than upside down.
  assert.equal(clampPitchDeg(NaN), MAX_PITCH_DEG);
  assert.equal(clampPitchDeg(undefined), MAX_PITCH_DEG);
});

test('repeated tilting settles at the limits instead of flipping over', () => {
  let pitch = -23;
  for (let i = 0; i < 40; i++) pitch = clampPitchDeg(pitch + TILT_STEP_DEG);
  assert.equal(pitch, MAX_PITCH_DEG);
  for (let i = 0; i < 40; i++) pitch = clampPitchDeg(pitch - TILT_STEP_DEG);
  assert.equal(pitch, MIN_PITCH_DEG);
});

test('headings wrap rather than run away', () => {
  assert.equal(normalizeHeadingDeg(0), 0);
  assert.equal(normalizeHeadingDeg(360), 0);
  assert.equal(normalizeHeadingDeg(-15), 345);
  assert.equal(normalizeHeadingDeg(375), 15);
  // A full circle of presses returns to where it started.
  let heading = 74;
  for (let i = 0; i < 360 / ROTATE_STEP_DEG; i++) heading = normalizeHeadingDeg(heading + ROTATE_STEP_DEG);
  assert.equal(heading, 74);
  assert.ok(Number.isInteger(360 / ROTATE_STEP_DEG), 'the rotate step must divide a full circle');
});

test('no map feature is ever camera-tracked', () => {
  // trackedEntity locks the camera to a moving target. Every corridor feature is static, and the
  // user must keep full manual navigation after focusing one, so camera.flyTo is used instead.
  const offenders = readdirSync(new URL('../src', import.meta.url))
    .filter(name => name.endsWith('.js') && name !== 'main.js')
    .filter(name => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8').includes('trackedEntity'));
  assert.deepEqual(offenders, []);
});
