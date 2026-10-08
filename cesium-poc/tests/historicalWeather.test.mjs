/**
 * Historical weather for a past incident.
 *
 * The failure this guards against is not a crash — it is a plausible wrong answer. Reading an hour
 * from the wrong timezone, or treating a failed lookup as a dry afternoon, would both produce a
 * confident risk score built on weather that was never there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CORRIDOR_TIME_ZONE, createHistoricalWeatherService, HISTORICAL_HOURLY, historicalWeatherUrl,
  localClockLabel, matchHistoricalWeather, nearestHour, normaliseHourly, WEATHER_UNITS, weatherCacheKey,
} from '../src/weather/historicalWeather.js';

/** An Open-Meteo response as the historical-forecast endpoint returns it, in corridor local time. */
const payload = (hours, values = {}) => ({
  hourly: {
    time: hours,
    temperature_2m: hours.map((_, i) => values.temperature_2m?.[i] ?? 27.4),
    relative_humidity_2m: hours.map((_, i) => values.relative_humidity_2m?.[i] ?? 84),
    precipitation: hours.map((_, i) => values.precipitation?.[i] ?? 0),
    rain: hours.map((_, i) => values.rain?.[i] ?? 0),
    weather_code: hours.map((_, i) => values.weather_code?.[i] ?? 0),
    cloud_cover: hours.map((_, i) => values.cloud_cover?.[i] ?? 20),
    visibility: hours.map((_, i) => values.visibility?.[i] ?? 24_000),
    wind_speed_10m: hours.map((_, i) => values.wind_speed_10m?.[i] ?? 16),
    wind_gusts_10m: hours.map((_, i) => values.wind_gusts_10m?.[i] ?? 31),
  },
});

test('the nearest hour is a deterministic rule, not a rounding accident', () => {
  // 17:42 EDT on 18 September 2026 is 21:42 UTC. The nearest hour is 18:00 LOCAL.
  const at = Date.parse('2026-09-18T21:42:00Z');
  assert.deepEqual(nearestHour(at), { date: '2026-09-18', hour: 18, local: '2026-09-18T18:00' });
  // 17:18 rounds down.
  assert.equal(nearestHour(Date.parse('2026-09-18T21:18:00Z')).local, '2026-09-18T17:00');
  // Exactly half past rounds up, stated so two runs can never disagree.
  assert.equal(nearestHour(Date.parse('2026-09-18T21:30:00Z')).local, '2026-09-18T18:00');
  assert.equal(nearestHour(NaN), null);
});

test('rounding across midnight lands on the next day, and the request covers both', () => {
  // 23:42 local on 18 September is 03:42 UTC on the 19th; the nearest hour is midnight on the 19th.
  const at = Date.parse('2026-09-19T03:42:00Z');
  assert.deepEqual(nearestHour(at), { date: '2026-09-19', hour: 0, local: '2026-09-19T00:00' });
  const url = new URL(historicalWeatherUrl({ latitude: 26.1, longitude: -80.2, timestampMs: at }));
  assert.equal(url.searchParams.get('start_date'), '2026-09-18', 'the incident\'s own day');
  assert.equal(url.searchParams.get('end_date'), '2026-09-19', 'and the day the hour rounds into');
});

test('the request names the corridor timezone, so nothing compares local against UTC', () => {
  const url = new URL(historicalWeatherUrl({ latitude: 26.1058, longitude: -80.2054, timestampMs: Date.parse('2026-09-18T21:42:00Z') }));
  assert.equal(url.origin + url.pathname, 'https://historical-forecast-api.open-meteo.com/v1/forecast');
  assert.equal(url.searchParams.get('timezone'), CORRIDOR_TIME_ZONE);
  assert.equal(url.searchParams.get('hourly'), HISTORICAL_HOURLY.join(','));
  // Units are requested rather than assumed from provider defaults.
  assert.equal(url.searchParams.get('temperature_unit'), 'celsius');
  assert.equal(url.searchParams.get('wind_speed_unit'), 'kmh');
  assert.equal(url.searchParams.get('precipitation_unit'), 'mm');
  // The incident's own coordinate, not one fixed corridor point.
  assert.equal(url.searchParams.get('latitude'), '26.1058');
  assert.equal(url.searchParams.get('longitude'), '-80.2054');
});

test('a coordinate or a time that cannot be used produces no request at all', () => {
  const at = Date.parse('2026-09-18T21:42:00Z');
  assert.equal(historicalWeatherUrl({ latitude: null, longitude: -80.2, timestampMs: at }), null);
  assert.equal(historicalWeatherUrl({ latitude: 26.1, longitude: -80.2, timestampMs: NaN }), null);
  assert.equal(historicalWeatherUrl({ latitude: 991, longitude: -80.2, timestampMs: at }), null);
});

test('the cache key is the rounded place, the corridor date and the matched hour', () => {
  assert.equal(
    weatherCacheKey({ latitude: 26.10583, longitude: -80.20541, timestampMs: Date.parse('2026-09-18T22:42:00Z') }),
    '26.1058_-80.2054_2026-09-18_19');
  // Two incidents a few metres apart in the same hour share a reading.
  const a = weatherCacheKey({ latitude: 26.105811, longitude: -80.205412, timestampMs: Date.parse('2026-09-18T21:42:00Z') });
  const b = weatherCacheKey({ latitude: 26.105789, longitude: -80.205388, timestampMs: Date.parse('2026-09-18T21:50:00Z') });
  assert.equal(a, b);
  // A different hour does not.
  assert.notEqual(a, weatherCacheKey({ latitude: 26.1058, longitude: -80.2054, timestampMs: Date.parse('2026-09-18T23:42:00Z') }));
});

test('a reading is normalised with its units, and a missing value stays missing', () => {
  const hours = ['2026-09-18T17:00', '2026-09-18T18:00'];
  const reading = normaliseHourly(payload(hours, {
    precipitation: [0, 2.4], rain: [0, 2.4], visibility: [24_000, 2_100], weather_code: [0, 61],
  }).hourly, 1);
  assert.equal(reading.timestamp, '2026-09-18T18:00');
  assert.equal(reading.precipitation, 2.4);
  assert.equal(reading.visibility, 2_100);
  assert.equal(reading.condition, 'Slight rain', 'the WMO table the rest of the app already uses');
  assert.equal(reading.units, WEATHER_UNITS);
  assert.equal(reading.timeZone, CORRIDOR_TIME_ZONE);

  // A null from the provider is a null here, never a zero. The archive endpoint returns exactly
  // this for visibility, which is why it is not the endpoint used.
  const sparse = normaliseHourly({ ...payload(hours).hourly, visibility: [null, null] }, 1);
  assert.equal(sparse.visibility, null);
  assert.notEqual(sparse.visibility, 0);
});

test('the matched reading records both the time asked for and the time used', () => {
  const at = Date.parse('2026-09-18T21:42:00Z');   // 17:42 local
  const matched = matchHistoricalWeather(payload(['2026-09-18T17:00', '2026-09-18T18:00', '2026-09-18T19:00'],
    { precipitation: [0, 2.4, 1.0] }), at);
  assert.equal(matched.requestedIncidentTime, '2026-09-18T17:42');
  assert.equal(matched.matchedWeatherTime, '2026-09-18T18:00', 'nearest hour to 17:42');
  assert.equal(matched.precipitation, 2.4, 'the 18:00 value, not 17:00');
  assert.equal(matched.source, 'Open-Meteo');
});

test('an error or an empty response is no reading, never an invented one', () => {
  const at = Date.parse('2026-09-18T21:42:00Z');
  assert.equal(matchHistoricalWeather({ error: true, reason: 'out of range' }, at), null);
  assert.equal(matchHistoricalWeather({ hourly: { time: [] } }, at), null);
  assert.equal(matchHistoricalWeather(null, at), null);
});

test('the same incident is not fetched twice', async () => {
  let calls = 0;
  const service = createHistoricalWeatherService({
    fetchImpl: async () => { calls += 1; return { ok: true, json: async () => payload(['2026-09-18T18:00']) }; },
  });
  const point = { latitude: 26.1058, longitude: -80.2054, timestampMs: Date.parse('2026-09-18T21:42:00Z') };
  const first = await service.weatherAt(point);
  assert.equal(first.matchedWeatherTime, '2026-09-18T18:00');
  await service.weatherAt(point);
  await service.weatherAt({ ...point, timestampMs: Date.parse('2026-09-18T21:50:00Z') });  // same hour
  assert.equal(calls, 1, 'one request for one place and hour');
  assert.equal(service.cached(point).matchedWeatherTime, '2026-09-18T18:00');
});

test('two selections of the same incident while the first is still in flight share one request', async () => {
  let calls = 0;
  let release;
  const service = createHistoricalWeatherService({
    fetchImpl: async () => { calls += 1; await new Promise(done => { release = done; }); return { ok: true, json: async () => payload(['2026-09-18T18:00']) }; },
  });
  const point = { latitude: 26.1058, longitude: -80.2054, timestampMs: Date.parse('2026-09-18T21:42:00Z') };
  const both = Promise.all([service.weatherAt(point), service.weatherAt(point)]);
  release();
  const [a, b] = await both;
  assert.equal(calls, 1);
  assert.equal(a, b);
});

test('a failure is null and is not cached, so the next selection tries again', async () => {
  let calls = 0;
  const service = createHistoricalWeatherService({
    fetchImpl: async () => { calls += 1; return calls === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => payload(['2026-09-18T18:00']) }; },
  });
  const point = { latitude: 26.1058, longitude: -80.2054, timestampMs: Date.parse('2026-09-18T21:42:00Z') };
  assert.equal(await service.weatherAt(point), null, 'a failure is null, never a fabricated reading');
  assert.ok(await service.weatherAt(point), 'and is retried rather than cached as nothing');
  assert.equal(calls, 2);
});

test('a network error resolves to null rather than throwing into the screen', async () => {
  const service = createHistoricalWeatherService({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await service.weatherAt({ latitude: 26.1, longitude: -80.2, timestampMs: Date.parse('2026-09-18T21:42:00Z') }), null);
});

test('a matched stamp is formatted as the wall clock it already is', () => {
  // It read "6:30 AM" for a 16:00 reading: Date.parse treated the corridor-local stamp as the
  // machine's local time and then converted it again. The stamp is already corridor time.
  assert.equal(localClockLabel('2025-06-08T16:00'), '4:00 PM');
  assert.equal(localClockLabel('2025-06-08T00:00'), '12:00 AM');
  assert.equal(localClockLabel('2025-06-08T12:00'), '12:00 PM');
  assert.equal(localClockLabel('2025-06-08T09:30'), '9:30 AM');
  assert.equal(localClockLabel(null), null);
});
