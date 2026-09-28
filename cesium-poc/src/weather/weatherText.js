/** WMO weather interpretation codes (as used by Open-Meteo `weather_code`) and compass points. Pure; shared by browser and server. */
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

export const weatherCodeText = code => (Number.isInteger(code) ? WMO_WEATHER_CODES[code] ?? null : null);

export const COMPASS_POINTS = Object.freeze(['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']);

/** 16-point compass name of a bearing in degrees (the direction wind comes from), null when not finite. */
export const compassPoint = degrees => (Number.isFinite(degrees) ? COMPASS_POINTS[((Math.round(degrees / 22.5) % 16) + 16) % 16] : null);
