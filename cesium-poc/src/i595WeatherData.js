export const HEIGHTS = [10, 80, 120, 180];
export const HOURLY = ['temperature_2m', 'relative_humidity_2m', 'precipitation', ...HEIGHTS.flatMap(h => [`wind_speed_${h}m`, `wind_direction_${h}m`])];
export const DAILY = ['temperature_2m_max', 'temperature_2m_min', 'sunrise', 'sunset', 'daylight_duration'];
export const WEATHER_URL = `https://api.open-meteo.com/v1/forecast?${new URLSearchParams({latitude:'26.0932',longitude:'-80.1243',hourly:HOURLY.join(','),daily:DAILY.join(','),timezone:'America/New_York',forecast_days:'8',temperature_unit:'celsius',wind_speed_unit:'kmh',precipitation_unit:'mm'})}`;
export function validateForecast(data) {
  if (!data?.daily?.time?.length || !data?.hourly?.time?.length || data.error) throw new Error('Incomplete forecast');
  for (const [group, keys] of [['daily',DAILY],['hourly',HOURLY]]) for (const key of keys) {
    if (!Array.isArray(data[group][key]) || data[group][key].length !== data[group].time.length) throw new Error('Incomplete forecast');
  }
  return data;
}
export const number = (v, digits = 0) => Number.isFinite(v) ? v.toFixed(digits) : '—';
export const direction = v => Number.isFinite(v) ? `${['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(v / 22.5) % 16]} · ${Math.round(v)}°` : '—';
export function localHour(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:00`;
}
