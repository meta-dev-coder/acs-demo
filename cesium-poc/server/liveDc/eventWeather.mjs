/**
 * Weather at a Live Event's position when it is first seen: Open-Meteo current conditions (the
 * provider the browser weather panel uses; no key). Never throws: any failure resolves to null.
 */
import { toDcDateTime } from './classes.mjs';
import { compassPoint, weatherCodeText } from '../../src/weather/weatherText.js';

export const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const WEATHER_CURRENT = Object.freeze([
  'temperature_2m', 'relative_humidity_2m', 'precipitation', 'weather_code', 'wind_speed_10m', 'wind_direction_10m',
]);
export const WEATHER_SOURCE = 'Open-Meteo';
export const WEATHER_TIMEOUT_MS = 5_000;

/** fetch with an abort after `timeoutMs` (a ref'd timer, cleared once the body is read by `read`). */
export async function fetchWithTimeout(fetchImpl, url, init, timeoutMs, read) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    return await read(response);
  } finally {
    clearTimeout(timer);
  }
}

const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function eventWeatherUrl({ latitude, longitude } = {}) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const params = new URLSearchParams({
    latitude: latitude.toFixed(4), longitude: longitude.toFixed(4), current: WEATHER_CURRENT.join(','), timezone: 'UTC',
    temperature_unit: 'celsius', wind_speed_unit: 'kmh', precipitation_unit: 'mm',
  });
  return `${OPEN_METEO_FORECAST_URL}?${params}`;
}

/** "Clear · 27.4 °C · wind 12 km/h SE"; parts without a value are dropped; null when nothing is known. */
export function weatherSummary({ code, temperatureC, windSpeedKmh, windDirectionDeg } = {}) {
  const parts = [];
  const text = weatherCodeText(code);
  if (text) parts.push(text);
  if (finite(temperatureC) != null) parts.push(`${temperatureC.toFixed(1)} °C`);
  if (finite(windSpeedKmh) != null) parts.push(['wind', `${Math.round(windSpeedKmh)} km/h`, compassPoint(finite(windDirectionDeg))].filter(Boolean).join(' '));
  return parts.length ? parts.join(' · ') : null;
}

/** Open-Meteo `current` (timezone UTC) -> the Live Events weather attributes; readings it lacks are omitted. */
export function weatherFieldsFromCurrent(payload) {
  const current = payload && !payload.error ? payload.current : null;
  const observedAt = typeof current?.time === 'string' ? toDcDateTime(`${current.time}Z`) : null;
  if (!observedAt) return null;
  const code = Number.isInteger(current.weather_code) ? current.weather_code : null;
  const readings = {
    weather_code: code,
    temperature_c: finite(current.temperature_2m),
    relative_humidity_pct: finite(current.relative_humidity_2m),
    precipitation_mm: finite(current.precipitation),
    wind_speed_kmh: finite(current.wind_speed_10m),
    wind_direction_deg: finite(current.wind_direction_10m),
  };
  const summary = weatherSummary({
    code, temperatureC: readings.temperature_c, windSpeedKmh: readings.wind_speed_kmh, windDirectionDeg: readings.wind_direction_deg,
  });
  if (!summary) return null;
  const fields = { weather_at_event: summary };
  for (const [name, value] of Object.entries(readings)) if (value != null) fields[name] = value;
  return { ...fields, weather_observed_at: observedAt, weather_source: WEATHER_SOURCE };
}

export async function fetchEventWeather(point, { fetchImpl = fetch, timeoutMs = WEATHER_TIMEOUT_MS } = {}) {
  const url = eventWeatherUrl(point);
  if (!url) return null;
  try {
    return await fetchWithTimeout(fetchImpl, url, { headers: { accept: 'application/json' } }, timeoutMs,
      async response => (response.ok ? weatherFieldsFromCurrent(await response.json()) : null));
  } catch {
    return null;
  }
}
