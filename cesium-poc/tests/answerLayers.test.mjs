/**
 * Which layers an Ask the Twin answer needs switched on.
 *
 * The complaint this covers: the camera flew to the closure it had just described and the corridor
 * was bare, because the layer that draws closures was off.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { eventLayersToShow, metresApart, NEAR_ANSWER_M } from '../src/safety/answerLayers.js';

/** The corridor's real closures, as the feed carries them. */
const closure = (id, lon = -80.168159, lat = 26.085694) => ({ id, type: 'CLOSURE', longitude: lon, latitude: lat });
const incident = (id, lon, lat) => ({ id, type: 'INCIDENT', longitude: lon, latitude: lat });

test('the layer for what is near the camera, and nothing else', () => {
  const events = [closure('a'), incident('b', -80.30, 26.07)];
  // Standing on the closure: the incident eight kilometres away is not what was asked about.
  assert.deepEqual(eventLayersToShow(events, { lon: -80.168, lat: 26.0857 }), ['closures']);
});

test('when nothing is near the camera, show what the corridor actually has', () => {
  // This is the case that failed in practice. The service answers with a coordinate for the
  // interchange it names — University Dr — while the closures themselves sit kilometres east, so a
  // distance rule alone found nothing and switched on nothing at all.
  const events = [closure('a'), closure('b')];
  const faraway = { lon: -80.25, lat: 26.09 };
  assert.ok(metresApart(faraway.lon, faraway.lat, -80.168159, 26.085694) > NEAR_ANSWER_M,
    'the fixture really is out of reach');
  assert.deepEqual(eventLayersToShow(events, faraway), ['closures'], 'still shows the closures');
});

test('it is bounded by what the feed is carrying, never all five layers on principle', () => {
  const events = [closure('a'), incident('b', -80.30, 26.07)];
  assert.deepEqual(eventLayersToShow(events, { lon: 0, lat: 0 }), ['incidents', 'closures']);
  assert.deepEqual(eventLayersToShow([], { lon: -80.2, lat: 26.08 }), [], 'a quiet corridor needs no layer');
  assert.deepEqual(eventLayersToShow(null), []);
});

test('an event with no coordinates cannot be flown to and is not counted', () => {
  assert.deepEqual(eventLayersToShow([{ id: 'x', type: 'CLOSURE' }], { lon: -80.2, lat: 26.08 }), []);
});

test('no target at all still shows what is out there', () => {
  // A high-confidence answer without coordinates never moves the camera, but the operator still
  // needs to see what is being talked about.
  assert.deepEqual(eventLayersToShow([closure('a')]), ['closures']);
  assert.deepEqual(eventLayersToShow([closure('a')], { lon: 'nonsense', lat: null }), ['closures']);
});

test('layers come back in the order the Explorer lists them, never the feed order', () => {
  const events = [{ id: 'c', type: 'CONGESTION', longitude: -80.2, latitude: 26.08 },
    { id: 'i', type: 'INCIDENT', longitude: -80.2, latitude: 26.08 }];
  assert.deepEqual(eventLayersToShow(events), ['incidents', 'congestion']);
});
