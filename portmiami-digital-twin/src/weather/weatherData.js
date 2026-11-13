/**
 * Weather forecast: the request, the validation and the formatting. Pure and Cesium-free.
 *
 * The forecast is Open-Meteo's, the same service and the same field set the ACS I-595 twin uses,
 * so the two projects read the same numbers. What is PortMiami-specific — the coordinates and the
 * place name — comes from src/config/portMiami.js rather than being written again here.
 */
import { LOCATION } from '../config/portMiami.js';

/** Wind is reported at these heights. 10 m is the met-standard reference; the rest matter to cranes. */
export const HEIGHTS = Object.freeze([10, 80, 120, 180]);

export const HOURLY = Object.freeze([
  'temperature_2m', 'relative_humidity_2m', 'precipitation', 'weather_code',
  ...HEIGHTS.flatMap(h => [`wind_speed_${h}m`, `wind_direction_${h}m`]),
]);
export const DAILY = Object.freeze([
  'weather_code', 'temperature_2m_max', 'temperature_2m_min',
  'precipitation_sum', 'sunrise', 'sunset', 'daylight_duration',
]);

/** Today plus the next seven days. */
export const FORECAST_DAYS = 8;
export const TIMEZONE = 'America/New_York';

export const WEATHER_URL = `https://api.open-meteo.com/v1/forecast?${new URLSearchParams({
  latitude: String(LOCATION.latitude),
  longitude: String(LOCATION.longitude),
  hourly: HOURLY.join(','),
  daily: DAILY.join(','),
  timezone: TIMEZONE,
  forecast_days: String(FORECAST_DAYS),
  temperature_unit: 'celsius',
  wind_speed_unit: 'kmh',
  precipitation_unit: 'mm',
})}`;

/**
 * WMO weather interpretation codes, as Open-Meteo reports them in `weather_code`.
 * Copied from the ACS project (cesium-poc/src/weather/weatherText.js) — it is the same standard.
 */
export const WMO_WEATHER_CODES = Object.freeze({
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Dense drizzle',
  56: 'Light freezing drizzle', 57: 'Dense freezing drizzle',
  61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
  66: 'Light freezing rain', 67: 'Heavy freezing rain',
  71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Slight rain showers', 81: 'Moderate rain showers', 82: 'Violent rain showers',
  85: 'Slight snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with slight hail', 99: 'Thunderstorm with heavy hail',
});

/** The condition in words, or null when the code is missing or unknown — never a guess. */
export const weatherCodeText = code =>
  (Number.isInteger(code) ? WMO_WEATHER_CODES[code] ?? null : null);

/**
 * A glyph for a condition. Grouped by the WMO code's own ranges, so an unknown code falls through
 * to a neutral mark rather than being drawn as fair weather.
 */
export function weatherCodeIcon(code) {
  if (!Number.isInteger(code)) return '•';
  if (code === 0) return '☀';
  if (code === 1 || code === 2) return '⛅';
  if (code === 3) return '☁';
  if (code === 45 || code === 48) return '≋';
  if (code >= 51 && code <= 57) return '🌦';
  if (code >= 61 && code <= 67) return '🌧';
  if (code >= 71 && code <= 77) return '❄';
  if (code >= 80 && code <= 82) return '🌧';
  if (code >= 85 && code <= 86) return '❄';
  if (code >= 95) return '⛈';
  return '•';
}

export const COMPASS_POINTS = Object.freeze(
  ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']);

/** 16-point compass name of a bearing in degrees, null when not finite. */
export const compassPoint = degrees =>
  (Number.isFinite(degrees) ? COMPASS_POINTS[((Math.round(degrees / 22.5) % 16) + 16) % 16] : null);

/**
 * Reject a response that is incomplete rather than render half of it. Every requested series must
 * be present and the same length as its own time axis, or a chart would silently align the wrong
 * hour to the wrong temperature.
 */
export function validateForecast(data) {
  if (!data?.daily?.time?.length || !data?.hourly?.time?.length || data.error) {
    throw new Error('Incomplete forecast');
  }
  for (const [group, keys] of [['daily', DAILY], ['hourly', HOURLY]]) {
    for (const key of keys) {
      const series = data[group][key];
      if (!Array.isArray(series) || series.length !== data[group].time.length) {
        throw new Error(`Incomplete forecast: ${group}.${key}`);
      }
    }
  }
  return data;
}

/** A number, or an em dash. Never 0 for a missing reading. */
export const number = (value, digits = 0) => (Number.isFinite(value) ? value.toFixed(digits) : '—');

/** The direction the wind comes FROM, named and in degrees. */
export const direction = value =>
  (Number.isFinite(value) ? `${compassPoint(value)} · ${Math.round(value)}°` : '—');

/** 'HH:MM' out of an Open-Meteo local timestamp. */
export const clock = value =>
  (typeof value === 'string' && value.includes('T') ? value.slice(11, 16) : '—');

/** 'Fri, Nov 13' for a 'YYYY-MM-DD' date, read as that calendar day rather than a UTC instant. */
export const dateLabel = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US',
  { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });

/** The current local hour at the port, as Open-Meteo writes its timestamps. */
export function localHour(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00`;
}

/** 'Today' / 'Tomorrow' / the weekday, for the day strip. */
export const dayName = (date, index) =>
  (index === 0 ? 'Today' : index === 1 ? 'Tomorrow' : dateLabel(date).split(',')[0]);

/** Seconds of daylight as '10h 42m'. */
export const duration = seconds => (Number.isFinite(seconds)
  ? `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m` : '—');

/** The hourly indices belonging to one forecast day. */
export const hoursOfDay = (hourly, date) =>
  hourly.time.reduce((indices, time, index) => {
    if (time.startsWith(date)) indices.push(index);
    return indices;
  }, []);
