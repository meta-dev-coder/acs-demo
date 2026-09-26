import test from 'node:test';
import assert from 'node:assert/strict';
import { eventPulseStyle, pulseSeverity } from '../src/liveOps/eventPulseModel.js';
test('uses reported severity without inventing missing values', () => {
  assert.equal(pulseSeverity('Major'), 'major');
  assert.equal(pulseSeverity('High'), 'high');
  assert.equal(pulseSeverity('Intermediate'), 'moderate');
  assert.equal(pulseSeverity('Minor'), 'low');
  assert.equal(pulseSeverity(null), 'unknown');
});
test('nearby cameras or signs enlarge the circle; distant assets do not', () => {
  const event = { latitude: 26.1, longitude: -80.3 };
  assert.equal(eventPulseStyle(event, []).radius, 150);
  for (const type of ['camera', 'messageSign']) {
    const style = eventPulseStyle(event, [{ ...event, latitude: 26.104, type }]);
    assert.equal(style.nearby.length, 1);
    assert.ok(style.radius >= style.nearby[0].distance);
  }
  assert.equal(eventPulseStyle(event, [{ latitude: 27, longitude: -80.3 }]).radius, 150);
});
