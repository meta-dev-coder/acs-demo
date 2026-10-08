/**
 * The weather that existed around a past incident.
 *
 * The application already talks to Open-Meteo in two places — the 8-day forecast panel
 * (`i595WeatherData.js`, one fixed corridor coordinate) and the server's current-conditions stamp
 * on a live event (`server/liveDc/eventWeather.mjs`, per point). Neither can answer "what was the
 * weather at this spot on 18 December 2025", so this adds the one endpoint that can and reuses
 * everything else: the same provider, the same units, the same WMO code table.
 *
 * ENDPOINT. Measured against both historical endpoints for 2025-12-18 at a corridor coordinate:
 *
 *   archive-api (ERA5)          visibility null for all 24 hours
 *   historical-forecast-api     visibility 15 800 m, every hour present
 *
 * Visibility is one of the three conditions the risk model weighs, so the archive cannot answer the
 * question being asked. historical-forecast-api covers 2022 to the present day, which spans the
 * whole incident corpus (May 2024 onward), so it is used throughout rather than switching endpoints
 * by age and producing two different answers for neighbouring dates.
 *
 * TIME. Open-Meteo is asked for `timezone=America/New_York` and returns local wall-clock stamps
 * ("2025-12-18T10:00"). The incident instant is converted to the SAME corridor wall clock before
 * matching, so nothing ever compares a local stamp against a UTC one. This is the corridor's own
 * timezone rule, the one `temporalContext` already applies to every other date in the application.
 *
 * Pure except for `createHistoricalWeatherService`, which is the only part that fetches.
 */
import { weatherCodeText } from './weatherText.js';
import { toLocalInputValue } from '../tmc/temporalContext.js';

export const HISTORICAL_WEATHER_URL = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
export const WEATHER_SOURCE = 'Open-Meteo';
export const CORRIDOR_TIME_ZONE = 'America/New_York';
export const HISTORICAL_WEATHER_TIMEOUT_MS = 8_000;

/** Exactly the hourly variables the risk model and the panel use — nothing requested unused. */
export const HISTORICAL_HOURLY = Object.freeze([
  'temperature_2m', 'relative_humidity_2m', 'precipitation', 'rain', 'weather_code',
  'cloud_cover', 'visibility', 'wind_speed_10m', 'wind_gusts_10m',
]);

/**
 * The unit every normalised reading is in, carried with the data rather than assumed.
 *
 * Requested explicitly from Open-Meteo below, so these are a contract and not a guess about
 * provider defaults. `visibility` is the one Open-Meteo does not let you choose: it is metres.
 */
export const WEATHER_UNITS = Object.freeze({
  temperature: '°C', humidity: '%', precipitation: 'mm', rain: 'mm',
  visibility: 'm', windSpeed: 'km/h', windGust: 'km/h', cloudCover: '%',
});

const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * "2025-06-08T16:00" as "4:00 PM".
 *
 * Formatted from the string, never through Date.parse: these stamps are already corridor wall
 * clock, and parsing one on a machine in another timezone re-interprets it and prints a different
 * hour than the one Open-Meteo was asked about.
 */
export function localClockLabel(stamp) {
  const match = /T(\d{2}):(\d{2})/.exec(String(stamp ?? ''));
  if (!match) return null;
  const hour = Number(match[1]);
  const suffix = hour < 12 ? 'AM' : 'PM';
  return `${((hour + 11) % 12) + 1}:${match[2]} ${suffix}`;
}
const pad = n => String(n).padStart(2, '0');

/** The corridor-local wall clock of an instant, as "YYYY-MM-DDTHH:MM". */
export const corridorLocal = timestampMs => toLocalInputValue(timestampMs) || null;

/**
 * The hour an incident's weather should be read from.
 *
 * Deterministic nearest hour: 17:42 rounds to 18:00, 17:18 to 17:00. A reading exactly on the half
 * hour rounds UP, stated here so two runs can never disagree. The result can cross midnight, which
 * is why the request below asks for a date range rather than a single day.
 *
 * @returns {{date: string, hour: number, local: string}|null}
 */
export function nearestHour(timestampMs) {
  const local = corridorLocal(timestampMs);
  if (!local) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  // Rounding is done on the calendar, not by adding milliseconds, so a daylight-saving change
  // cannot move the answer to a different wall-clock hour than the one being named.
  const rounded = new Date(Date.UTC(year, month - 1, day, hour + (minute >= 30 ? 1 : 0)));
  const date = `${rounded.getUTCFullYear()}-${pad(rounded.getUTCMonth() + 1)}-${pad(rounded.getUTCDate())}`;
  return { date, hour: rounded.getUTCHours(), local: `${date}T${pad(rounded.getUTCHours())}:00` };
}

/**
 * The cache key for one reading: coordinate rounded, plus the corridor-local date and hour.
 *
 * Four decimal places is about 11 m — far finer than the weather model's own grid, so two incidents
 * at the same spot share a reading while two genuinely different places never do.
 */
export function weatherCacheKey({ latitude, longitude, timestampMs }) {
  const when = nearestHour(timestampMs);
  if (when == null || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return `${latitude.toFixed(4)}_${longitude.toFixed(4)}_${when.date}_${pad(when.hour)}`;
}

/**
 * The request for one incident's weather.
 *
 * The range covers the incident's own date and the rounded hour's date, which differ only when an
 * incident just before midnight rounds into the next day.
 */
export function historicalWeatherUrl({ latitude, longitude, timestampMs }) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  const when = nearestHour(timestampMs);
  const local = corridorLocal(timestampMs);
  if (when == null || local == null) return null;
  const incidentDate = local.slice(0, 10);
  const params = new URLSearchParams({
    latitude: latitude.toFixed(4),
    longitude: longitude.toFixed(4),
    start_date: incidentDate < when.date ? incidentDate : when.date,
    end_date: incidentDate > when.date ? incidentDate : when.date,
    hourly: HISTORICAL_HOURLY.join(','),
    timezone: CORRIDOR_TIME_ZONE,
    temperature_unit: 'celsius', wind_speed_unit: 'kmh', precipitation_unit: 'mm',
  });
  return `${HISTORICAL_WEATHER_URL}?${params}`;
}

/**
 * One hour of an Open-Meteo response as a normalised reading.
 *
 * Raw provider shapes stop here: everything downstream sees named fields with declared units, so a
 * change of provider is a change to this file alone. A missing value stays null rather than
 * becoming zero — "no reading" and "no rain" are different facts and the risk model treats them
 * differently.
 */
export function normaliseHourly(hourly, index) {
  if (!hourly || !Array.isArray(hourly.time) || index < 0 || index >= hourly.time.length) return null;
  const at = key => finite(hourly[key]?.[index]);
  const code = Number.isInteger(hourly.weather_code?.[index]) ? hourly.weather_code[index] : null;
  return Object.freeze({
    timestamp: hourly.time[index],
    timeZone: CORRIDOR_TIME_ZONE,
    temperature: at('temperature_2m'),
    humidity: at('relative_humidity_2m'),
    precipitation: at('precipitation'),
    rain: at('rain'),
    visibility: at('visibility'),
    windSpeed: at('wind_speed_10m'),
    windGust: at('wind_gusts_10m'),
    cloudCover: at('cloud_cover'),
    weatherCode: code,
    condition: weatherCodeText(code),
    units: WEATHER_UNITS,
  });
}

/**
 * The reading nearest an incident's time, with what was asked for and what came back.
 *
 * Both stamps are kept because they are not always the same minute, and an operator reading
 * "Weather at incident time" is entitled to know which hour it actually is.
 */
export function matchHistoricalWeather(payload, timestampMs) {
  const hourly = payload && !payload.error ? payload.hourly : null;
  const when = nearestHour(timestampMs);
  if (!hourly?.time?.length || when == null) return null;
  let index = hourly.time.indexOf(when.local);
  if (index === -1) {
    // The exact hour is missing: fall back to the closest stamp the response does carry, rather
    // than reporting no weather for a response that plainly has some.
    let best = null;
    for (let i = 0; i < hourly.time.length; i += 1) {
      const apart = Math.abs(Date.parse(`${hourly.time[i]}:00`) - Date.parse(`${when.local}:00`));
      if (Number.isFinite(apart) && (best == null || apart < best.apart)) best = { i, apart };
    }
    if (best == null) return null;
    index = best.i;
  }
  const reading = normaliseHourly(hourly, index);
  if (!reading) return null;
  return Object.freeze({
    ...reading,
    source: WEATHER_SOURCE,
    endpoint: HISTORICAL_WEATHER_URL,
    requestedIncidentTime: corridorLocal(timestampMs),
    matchedWeatherTime: reading.timestamp,
  });
}

/**
 * The service the TMC uses. The only part that touches the network.
 *
 * One in-flight request per cache key, so selecting the same incident twice while the first request
 * is still running does not open a second one. A failure is cached as null for a short while only,
 * so a transient outage does not permanently blank the weather for that incident.
 */
export function createHistoricalWeatherService({
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = HISTORICAL_WEATHER_TIMEOUT_MS,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();

  async function weatherAt(point) {
    const key = weatherCacheKey(point);
    if (key == null) return null;
    if (cache.has(key)) return cache.get(key);
    if (inFlight.has(key)) return inFlight.get(key);

    const url = historicalWeatherUrl(point);
    if (url == null) return null;
    const request = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`Open-Meteo responded ${response.status}`);
        const matched = matchHistoricalWeather(await response.json(), point.timestampMs);
        // Only a real reading is cached. A null is a failure, and failures should be retried.
        if (matched) cache.set(key, matched);
        return matched;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, request);
    return request;
  }

  return {
    weatherAt,
    /** For tests and for the panel to tell a cached answer from a fetched one. */
    cached: point => cache.get(weatherCacheKey(point) ?? '') ?? null,
    get size() { return cache.size; },
  };
}
