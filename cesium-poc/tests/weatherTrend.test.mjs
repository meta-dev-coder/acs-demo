/**
 * Crashes grouped by the weather they happened in.
 *
 * Two sources spell weather differently and the chart has to read both, without inventing a
 * category that the data never used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { weatherOf, weatherTrend, WEATHER_GROUPS } from '../src/safety/weatherTrend.js';

/** A register record, as DataConnect hands it over: the column lives under raw.attributes. */
const registerCrash = weather => ({ id: `R-${weather}`, raw: { attributes: { weather } } });
/** A live FL511 crash, which writes a sentence instead of a category. */
const liveCrash = sentence => ({ id: 'FL511-1', related: { sdna: { weather_at_event: sentence } } });

test('the register writes the category outright', () => {
  for (const group of WEATHER_GROUPS) assert.equal(weatherOf(registerCrash(group)), group);
  // Whatever case the column arrives in, it lands in the group the chart already has a bar for.
  assert.equal(weatherOf(registerCrash('storm recovery')), 'Storm Recovery');
  assert.equal(weatherOf(registerCrash('LIGHT RAIN')), 'Light Rain');
});

test("the feed writes a sentence, and only its condition is the weather", () => {
  assert.equal(weatherOf(liveCrash('Overcast · 24.4 °C · wind 5 km/h N')), 'Overcast');
  assert.equal(weatherOf(liveCrash('Clear · 19 °C')), 'Clear');
});

test('a condition the register has never used is kept, not forced into a known group', () => {
  // Inventing a synonym would put a word in the data's mouth. A new condition gets its own bar.
  assert.equal(weatherOf(liveCrash('Partly cloudy · 22.7 °C · wind 6 km/h WNW')), 'Partly cloudy');
  const { points } = weatherTrend([liveCrash('Partly cloudy · 22.7 °C')]);
  const extra = points.find(point => point.label === 'Partly cloudy');
  assert.equal(extra.count, 1);
  assert.equal(points.indexOf(extra), points.length - 1, 'appended after the known groups');
});

test('a crash with no weather is counted as unknown, never guessed at', () => {
  assert.equal(weatherOf({ id: 'x' }), null);
  assert.equal(weatherOf(registerCrash('')), null);
  assert.equal(weatherOf(registerCrash('NA')), null, 'NA is not a condition');
  assert.equal(weatherOf(liveCrash('NA')), null);
  const { unknown, total } = weatherTrend([registerCrash('Rain'), { id: 'y' }]);
  assert.equal(unknown, 1);
  assert.equal(total, 1, 'the unknown one is not counted into any bar');
});

test('every known group is present even at zero', () => {
  // A missing bar reads as "no data"; the truthful answer is "none in that weather".
  const { points } = weatherTrend([registerCrash('Rain')]);
  assert.deepEqual(points.map(point => point.label), WEATHER_GROUPS);
  assert.equal(points.find(point => point.label === 'Clear').count, 0);
});

test('the bars run from fair weather to foul, not by which was commonest', () => {
  assert.deepEqual(WEATHER_GROUPS,
    ['Clear', 'Humid', 'Windy', 'Overcast', 'Light Rain', 'Rain', 'Storm Recovery']);
});

test('the counts are the corridor’s own', () => {
  // The instance's real distribution, so the shape of the chart is pinned to real data.
  const crashes = [
    ...Array.from({ length: 35 }, () => registerCrash('Clear')),
    ...Array.from({ length: 34 }, () => registerCrash('Humid')),
    ...Array.from({ length: 33 }, () => registerCrash('Windy')),
    ...Array.from({ length: 29 }, () => registerCrash('Overcast')),
    ...Array.from({ length: 19 }, () => registerCrash('Storm Recovery')),
    ...Array.from({ length: 14 }, () => registerCrash('Light Rain')),
    ...Array.from({ length: 14 }, () => registerCrash('Rain')),
  ];
  const { points, total, peak } = weatherTrend(crashes);
  assert.equal(total, 178);
  assert.equal(peak, 35);
  assert.deepEqual(points.map(point => point.count), [35, 34, 33, 29, 14, 14, 19]);
});
