import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRampImpact, nearestRamp, RAMP_MATCH_METERS } from '../src/liveOps/rampImpact.js';

/** ~111 m per 0.001 degrees of latitude, so offsets here are readable as metres. */
const ramp = (id, lon, lat) => ({
  id, rampType: 'ENTRY_RAMP', label: `ramp ${id}`,
  path: [{ lon, lat }, { lon: lon + 0.002, lat }],
});
const event = (id, type, lon, lat, severity) => ({ id, type, longitude: lon, latitude: lat, severity });

test('nearestRamp picks the closest ramp and ignores anything past the tolerance', () => {
  const ramps = [ramp('near', -80.2, 26.06), ramp('far', -80.2, 26.09)];
  const hit = nearestRamp(event('E1', 'INCIDENT', -80.199, 26.0602), ramps);
  assert.equal(hit.ramp.id, 'near');
  assert.ok(hit.metres < RAMP_MATCH_METERS);

  // ~3.3 km from either ramp: matched to neither rather than to the nearest thing on screen.
  assert.equal(nearestRamp(event('E2', 'INCIDENT', -80.199, 26.12), ramps), null);
});

test('an event with no coordinates is unmeasurable, not at (0,0)', () => {
  const ramps = [ramp('r1', -80.2, 26.06)];
  assert.equal(nearestRamp({ id: 'E', type: 'INCIDENT' }, ramps), null);
  assert.equal(nearestRamp(event('E', 'INCIDENT', null, null), ramps), null);
});

test('severity drives the level: a major closure outscores a minor one on the same ramp', () => {
  const ramps = [ramp('r1', -80.2, 26.06), ramp('r2', -80.3, 26.06)];
  const { byRampId, matched, unmatched } = aggregateRampImpact([
    event('major', 'CLOSURE', -80.1995, 26.0601, 'Major'),
    event('minor', 'CLOSURE', -80.2995, 26.0601, 'Minor'),
  ], ramps);

  assert.equal(matched, 2);
  assert.equal(unmatched, 0);
  assert.ok(byRampId.get('r1').operationalScore > byRampId.get('r2').operationalScore);
  assert.equal(byRampId.get('r1').operationalLevel, 'MODERATE');
  assert.equal(byRampId.get('r2').operationalLevel, 'LOW');
});

test('a ramp with nothing on it stays NORMAL and scores zero', () => {
  const { byRampId } = aggregateRampImpact([], [ramp('quiet', -80.2, 26.06)]);
  assert.equal(byRampId.get('quiet').operationalLevel, 'NORMAL');
  assert.equal(byRampId.get('quiet').operationalScore, 0);
  assert.deepEqual(byRampId.get('quiet').events, []);
});

test('events on one ramp accumulate, and an unmatched event is counted rather than dropped', () => {
  const ramps = [ramp('r1', -80.2, 26.06)];
  const { byRampId, matched, unmatched } = aggregateRampImpact([
    event('a', 'INCIDENT', -80.1995, 26.0601, 'Major'),
    event('b', 'CONGESTION', -80.1994, 26.0601, 'Moderate'),
    event('miles-away', 'INCIDENT', -80.9, 26.5, 'Major'),
  ], ramps);

  assert.equal(matched, 2);
  assert.equal(unmatched, 1);
  assert.equal(byRampId.get('r1').events.length, 2);
  assert.equal(byRampId.get('r1').operationalLevel, 'HIGH');
  assert.equal(byRampId.get('r1').byType.INCIDENT, 1);
  assert.equal(byRampId.get('r1').byType.CONGESTION, 1);
});

test('an unweighted event type contributes nothing to a ramp score', () => {
  const ramps = [ramp('r1', -80.2, 26.06)];
  const { byRampId } = aggregateRampImpact([event('x', 'SOMETHING_ELSE', -80.1995, 26.0601)], ramps);
  assert.equal(byRampId.get('r1').operationalScore, 0);
  assert.equal(byRampId.get('r1').operationalLevel, 'NORMAL');
});
