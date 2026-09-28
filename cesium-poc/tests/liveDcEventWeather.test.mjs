import test from 'node:test';
import assert from 'node:assert/strict';
import { compassPoint, weatherCodeText } from '../src/weather/weatherText.js';
import { direction } from '../src/i595WeatherData.js';
import {
  WEATHER_SOURCE, eventWeatherUrl, fetchEventWeather, weatherFieldsFromCurrent, weatherSummary,
} from '../server/liveDc/eventWeather.mjs';

const CURRENT = {
  latitude: 26.09, longitude: -80.23, timezone: 'UTC',
  current_units: { time: 'iso8601', temperature_2m: '°C' },
  current: {
    time: '2026-09-26T04:30', interval: 900, temperature_2m: 27.4, relative_humidity_2m: 81,
    precipitation: 0, weather_code: 0, wind_speed_10m: 12.2, wind_direction_10m: 135,
  },
};
const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

test('WMO weather codes read as text; unknown codes are null', () => {
  assert.equal(weatherCodeText(0), 'Clear');
  assert.equal(weatherCodeText(3), 'Overcast');
  assert.equal(weatherCodeText(63), 'Moderate rain');
  assert.equal(weatherCodeText(95), 'Thunderstorm');
  assert.equal(weatherCodeText(99), 'Thunderstorm with heavy hail');
  assert.equal(weatherCodeText(4), null);
  assert.equal(weatherCodeText(null), null);
});

test('compass point is shared with the browser weather panel', () => {
  assert.equal(compassPoint(135), 'SE');
  assert.equal(compassPoint(359), 'N');
  assert.equal(compassPoint(Number.NaN), null);
  assert.equal(direction(135), 'SE · 135°');
});

test('the request is Open-Meteo current conditions at the event, UTC, metric', () => {
  const url = new URL(eventWeatherUrl({ latitude: 26.093417, longitude: -80.226583 }));
  assert.equal(`${url.origin}${url.pathname}`, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(url.searchParams.get('latitude'), '26.0934');
  assert.equal(url.searchParams.get('longitude'), '-80.2266');
  assert.equal(url.searchParams.get('current'),
    'temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m');
  assert.equal(url.searchParams.get('timezone'), 'UTC');
  assert.equal(url.searchParams.get('temperature_unit'), 'celsius');
  assert.equal(url.searchParams.get('wind_speed_unit'), 'kmh');
  assert.equal(url.searchParams.get('precipitation_unit'), 'mm');
  assert.equal(eventWeatherUrl({ latitude: Number.NaN, longitude: -80 }), null);
});

test('summary and typed fields from the current block', () => {
  assert.equal(weatherSummary({ code: 0, temperatureC: 27.4, windSpeedKmh: 12.2, windDirectionDeg: 135 }), 'Clear · 27.4 °C · wind 12 km/h SE');
  assert.equal(weatherSummary({ code: 61, temperatureC: 20 }), 'Slight rain · 20.0 °C');
  assert.equal(weatherSummary({}), null);
  assert.deepEqual(weatherFieldsFromCurrent(CURRENT), {
    weather_at_event: 'Clear · 27.4 °C · wind 12 km/h SE', weather_code: 0, temperature_c: 27.4, relative_humidity_pct: 81,
    precipitation_mm: 0, wind_speed_kmh: 12.2, wind_direction_deg: 135, weather_observed_at: '2026-09-26T04:30:00Z',
    weather_source: WEATHER_SOURCE,
  });
  assert.equal(WEATHER_SOURCE, 'Open-Meteo');
});

test('missing readings are omitted, never NaN; no current block means no weather', () => {
  const partial = weatherFieldsFromCurrent({ current: { time: '2026-09-26T04:30', temperature_2m: 25, weather_code: null } });
  assert.deepEqual(partial, {
    weather_at_event: '25.0 °C', temperature_c: 25, weather_observed_at: '2026-09-26T04:30:00Z', weather_source: WEATHER_SOURCE,
  });
  assert.equal(weatherFieldsFromCurrent({}), null);
  assert.equal(weatherFieldsFromCurrent({ error: true, reason: 'bad' }), null);
  assert.equal(weatherFieldsFromCurrent({ current: { time: 'soon', temperature_2m: 25 } }), null);
});

test('fetchEventWeather: one GET with a timeout signal; failures resolve to null', async () => {
  const seen = [];
  const ok = await fetchEventWeather({ latitude: 26.09, longitude: -80.23 }, {
    fetchImpl: async (url, init) => { seen.push({ url: String(url), signal: init?.signal }); return json(CURRENT); },
  });
  assert.equal(ok.temperature_c, 27.4);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].signal instanceof AbortSignal);
  for (const fetchImpl of [
    async () => { throw new Error('offline'); },
    async () => json({ error: true, reason: 'x' }, { status: 400 }),
    async () => new Response('not json', { status: 200 }),
    async (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
  ]) {
    assert.equal(await fetchEventWeather({ latitude: 26.09, longitude: -80.23 }, { fetchImpl, timeoutMs: 20 }), null);
  }
  assert.equal(await fetchEventWeather({ latitude: null, longitude: -80 }, { fetchImpl: async () => { throw new Error('no call'); } }), null);
});
