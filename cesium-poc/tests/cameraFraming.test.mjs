/**
 * Framing a fly so the subject is on screen.
 *
 * The bug these cover: flying to a camera's exact coordinates put the eye on top of it, pitched
 * forward, so the camera itself was about 2 km behind the view centre — the map moved, and the
 * thing the operator asked to see was not in it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { framedDestination, lookAheadMetres } from '../src/cameraFraming.js';

test('the look-ahead distance is the height over the tangent of the pitch', () => {
  assert.equal(Math.round(lookAheadMetres(1800, -40)), 2145);
  assert.equal(Math.round(lookAheadMetres(900, -35)), 1285);
  assert.equal(Math.round(lookAheadMetres(3200, -35)), 4570);
  // Straight down sees what is directly below, so there is nothing to compensate for.
  assert.equal(lookAheadMetres(1800, -90), 0);
});

test('nonsense inputs frame nothing rather than throwing or flying to NaN', () => {
  for (const [h, p] of [[0, -35], [-10, -35], [1800, 0], [1800, NaN], [NaN, -35]]) {
    assert.equal(lookAheadMetres(h, p), 0, `${h}/${p}`);
  }
  const unchanged = framedDestination(-80.26, 26.1, NaN, -35);
  assert.equal(unchanged.latitude, 26.1);
});

test('the eye is placed south of the subject, by the distance it looks ahead', () => {
  const target = { lon: -80.259976, lat: 26.101342 };
  const eye = framedDestination(target.lon, target.lat, 1800, -40);
  assert.equal(eye.longitude, target.lon, 'a north-facing fly never moves sideways');
  assert.ok(eye.latitude < target.lat, 'the eye sits behind the subject, not on it');
  const metres = (target.lat - eye.latitude) * 110_540;
  assert.ok(Math.abs(metres - 2145) < 1, `${metres} m south`);
});

test('the offset grows with height, which a fixed nudge could not do', () => {
  const close = framedDestination(-80.26, 26.1, 900, -35).latitude;
  const far = framedDestination(-80.26, 26.1, 3200, -35).latitude;
  assert.ok(far < close, 'a higher view must sit further back');
  // The old hard-coded 0.012 deg was about right at 900 m and badly short at 3200 m.
  assert.ok(Math.abs((26.1 - close) - 0.0116) < 0.0005);
  assert.ok((26.1 - far) > 0.04);
});
