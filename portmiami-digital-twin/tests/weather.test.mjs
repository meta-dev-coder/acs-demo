/** Tests for the weather module's pure layer: the request, the validation and the formatting. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clock, compassPoint, dateLabel, dayName, DAILY, direction, duration, FORECAST_DAYS, HEIGHTS,
  HOURLY, hoursOfDay, localHour, number, TIMEZONE, validateForecast, weatherCodeIcon,
  weatherCodeText, WEATHER_URL,
} from '../src/weather/weatherData.js';
import { LOCATION } from '../src/config/portMiami.js';

test('the request asks Open-Meteo for PortMiami, today plus seven days', () => {
  const url = new URL(WEATHER_URL);
  assert.equal(url.origin + url.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(url.searchParams.get('latitude'), String(LOCATION.latitude));
  assert.equal(url.searchParams.get('longitude'), String(LOCATION.longitude));
  assert.equal(url.searchParams.get('forecast_days'), '8');
  assert.equal(FORECAST_DAYS, 8, 'today + 7');
  assert.equal(url.searchParams.get('timezone'), TIMEZONE);
  assert.equal(url.searchParams.get('temperature_unit'), 'celsius');
  assert.equal(url.searchParams.get('wind_speed_unit'), 'kmh');
  assert.equal(url.searchParams.get('precipitation_unit'), 'mm');
});

test('the coordinates come from the project config, not a second copy', () => {
  assert.equal(new URL(WEATHER_URL).searchParams.get('latitude'), '25.778');
  assert.equal(new URL(WEATHER_URL).searchParams.get('longitude'), '-80.162');
});

test('every field the UI reads is requested', () => {
  const url = new URL(WEATHER_URL);
  const hourly = url.searchParams.get('hourly').split(',');
  const daily = url.searchParams.get('daily').split(',');
  for (const key of ['temperature_2m', 'relative_humidity_2m', 'precipitation', 'weather_code']) {
    assert.ok(hourly.includes(key), `hourly.${key}`);
  }
  for (const height of HEIGHTS) {
    assert.ok(hourly.includes(`wind_speed_${height}m`));
    assert.ok(hourly.includes(`wind_direction_${height}m`));
  }
  for (const key of ['weather_code', 'temperature_2m_max', 'temperature_2m_min',
    'precipitation_sum', 'sunrise', 'sunset', 'daylight_duration']) {
    assert.ok(daily.includes(key), `daily.${key}`);
  }
});

/** A response shaped like Open-Meteo's, with `hours` hourly readings over `days` days. */
function fakeForecast({ days = 2, hours = 24 } = {}) {
  const dates = Array.from({ length: days }, (_, d) => `2026-11-${String(13 + d).padStart(2, '0')}`);
  const times = dates.flatMap(date =>
    Array.from({ length: hours }, (_, h) => `${date}T${String(h).padStart(2, '0')}:00`));
  const daily = { time: dates };
  for (const key of DAILY) daily[key] = dates.map((_, i) => (key.includes('sun') ? `${dates[i]}T06:30` : i + 1));
  const hourly = { time: times };
  for (const key of HOURLY) hourly[key] = times.map((_, i) => i % 30);
  return { daily, hourly };
}

test('a complete response passes validation unchanged', () => {
  const data = fakeForecast();
  assert.equal(validateForecast(data), data);
});

test('an incomplete response is rejected rather than half-rendered', () => {
  assert.throws(() => validateForecast(null), /Incomplete forecast/);
  assert.throws(() => validateForecast({ error: true, reason: 'x' }), /Incomplete forecast/);
  assert.throws(() => validateForecast({ daily: { time: [] }, hourly: { time: [] } }), /Incomplete forecast/);

  const missing = fakeForecast();
  delete missing.hourly.precipitation;
  assert.throws(() => validateForecast(missing), /hourly\.precipitation/);

  const ragged = fakeForecast();
  ragged.daily.temperature_2m_max = [1];     // shorter than daily.time
  assert.throws(() => validateForecast(ragged), /daily\.temperature_2m_max/);
});

test('hoursOfDay returns only that calendar day', () => {
  const { hourly } = fakeForecast({ days: 3, hours: 24 });
  const first = hoursOfDay(hourly, '2026-11-13');
  const second = hoursOfDay(hourly, '2026-11-14');
  assert.equal(first.length, 24);
  assert.equal(second.length, 24);
  assert.equal(first.at(-1) + 1, second[0], 'the days are contiguous and do not overlap');
  assert.deepEqual(hoursOfDay(hourly, '2026-12-25'), []);
});

test('a missing reading is an em dash, never zero', () => {
  assert.equal(number(undefined), '—');
  assert.equal(number(null), '—');
  assert.equal(number(NaN), '—');
  assert.equal(number(0), '0', 'a real zero still reads as zero');
  assert.equal(number(21.46, 1), '21.5');
  assert.equal(direction(undefined), '—');
  assert.equal(clock(undefined), '—');
  assert.equal(clock('not-a-time'), '—');
  assert.equal(duration(undefined), '—');
});

test('compass points wrap correctly at both ends', () => {
  assert.equal(compassPoint(0), 'N');
  assert.equal(compassPoint(360), 'N');
  assert.equal(compassPoint(359), 'N');
  assert.equal(compassPoint(-1), 'N');
  assert.equal(compassPoint(90), 'E');
  assert.equal(compassPoint(180), 'S');
  assert.equal(compassPoint(270), 'W');
  assert.equal(compassPoint(326), 'NW');
  assert.equal(compassPoint(null), null);
  assert.equal(direction(326), 'NW · 326°');
});

test('an unknown weather code is never drawn as fair weather', () => {
  assert.equal(weatherCodeText(0), 'Clear');
  assert.equal(weatherCodeText(95), 'Thunderstorm');
  assert.equal(weatherCodeText(7), null, 'an undefined code has no words');
  assert.equal(weatherCodeText(null), null);
  assert.equal(weatherCodeIcon(0), '☀');
  assert.equal(weatherCodeIcon(3), '☁');
  assert.equal(weatherCodeIcon(95), '⛈');
  assert.equal(weatherCodeIcon(7), '•', 'unknown falls through to a neutral mark');
  assert.equal(weatherCodeIcon(null), '•');
  assert.notEqual(weatherCodeIcon(7), weatherCodeIcon(0));
});

test('dates and day names read as calendar days, not UTC instants', () => {
  assert.equal(dateLabel('2026-11-13'), 'Fri, Nov 13');
  assert.equal(dayName('2026-11-13', 0), 'Today');
  assert.equal(dayName('2026-11-14', 1), 'Tomorrow');
  assert.equal(dayName('2026-11-15', 2), 'Sun');
});

test('clock reads the local hour out of an Open-Meteo timestamp', () => {
  assert.equal(clock('2026-11-13T07:00'), '07:00');
  assert.equal(clock('2026-11-13T07:00:00'), '07:00');
});

test('duration formats daylight seconds', () => {
  assert.equal(duration(38520), '10h 42m');
  assert.equal(duration(0), '0h 0m');
});

test('localHour is a port-local timestamp Open-Meteo would recognise', () => {
  const value = localHour(new Date('2026-11-13T12:34:00Z'));
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:00$/);
  // Miami is UTC-5 in November, so 12:34 UTC is 07:00 local.
  assert.equal(value, '2026-11-13T07:00');
});
