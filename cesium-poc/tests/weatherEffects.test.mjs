import test from 'node:test';
import assert from 'node:assert/strict';
import { WEATHER_EFFECT_PRESETS } from '../src/safety/weatherEffects.js';

test('animated weather buckets have an effect and excluded buckets do not', () => {
  assert.equal(WEATHER_EFFECT_PRESETS.Humid.kind, 'mist');
  assert.equal(WEATHER_EFFECT_PRESETS.Windy.kind, 'wind');
  assert.equal(WEATHER_EFFECT_PRESETS.Overcast.kind, 'cloud');
  assert.equal(WEATHER_EFFECT_PRESETS['Light Rain'].kind, 'rain');
  assert.equal(WEATHER_EFFECT_PRESETS.Rain.kind, 'rain');
  assert.equal(WEATHER_EFFECT_PRESETS.Clear, undefined);
  assert.equal(WEATHER_EFFECT_PRESETS['Storm Recovery'], undefined);
  assert.ok(WEATHER_EFFECT_PRESETS.Rain.particles > WEATHER_EFFECT_PRESETS['Light Rain'].particles);
  assert.ok(WEATHER_EFFECT_PRESETS.Rain.speed > WEATHER_EFFECT_PRESETS['Light Rain'].speed);
});
