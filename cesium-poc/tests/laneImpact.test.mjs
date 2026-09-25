/**
 * Lane impact read from FL511 prose. Every string here is a real phrasing from the live feed.
 *
 * The property under test is restraint: what the source states is recorded, and nothing else is
 * inferred — least of all a total lane count, which this data never carries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { laneImpactLabel, parseLaneImpact } from '../server/laneImpact.mjs';

test('a stated lane count is read, in digits or words', () => {
  assert.equal(parseLaneImpact('2 Right lanes blocked.').blockedLanes, 2);
  assert.equal(parseLaneImpact('Left lane blocked.').blockedLanes, 1, 'no number means one lane');
  assert.equal(parseLaneImpact('Two lanes closed ahead.').blockedLanes, 2);
  // Several mentions: the worst one is the impact.
  assert.equal(parseLaneImpact('2 left lanes blocked and the right lane blocked.').blockedLanes, 2);
});

test('closures and ramps are distinguished from lane counts', () => {
  const full = parseLaneImpact('All lanes closed.');
  assert.equal(full.fullClosure, true);
  assert.equal(full.blockedLanes, null, 'a full closure does not invent a lane count');
  assert.equal(parseLaneImpact('Road closed.').fullClosure, true);
  const ramp = parseLaneImpact('Off-ramp closed. Last updated at 10:58 PM.');
  assert.equal(ramp.rampClosure, true);
  assert.equal(ramp.fullClosure, false, 'a ramp is not the carriageway');
  assert.equal(parseLaneImpact('Disabled vehicle on the right shoulder.').shoulderOnly, true);
});

test('prose with no lane information yields none, not a guess', () => {
  for (const text of ['Crash in Broward County. Last updated at 09:42 PM.', 'Delays expected.', '']) {
    const impact = parseLaneImpact(text);
    assert.equal(impact.source, 'none', text);
    assert.equal(impact.blockedLanes, null);
    assert.equal(impact.fullClosure, false);
  }
  // Nothing to say is said as nothing, not as "0 lanes blocked".
  assert.equal(laneImpactLabel(parseLaneImpact('Delays expected.')), null);
});

test('the label reads the way an operator would say it', () => {
  assert.equal(laneImpactLabel(parseLaneImpact('2 Right lanes blocked.')), '2 lanes blocked');
  assert.equal(laneImpactLabel(parseLaneImpact('Left lane blocked.')), '1 lane blocked');
  assert.equal(laneImpactLabel(parseLaneImpact('All lanes closed.')), 'All lanes closed');
  assert.equal(laneImpactLabel(parseLaneImpact('Ramp closed.')), 'Ramp closed');
});
