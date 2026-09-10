# I-595 weather

Open `/?demo=i595` and click **Weather** at the upper right.

The display requests today's forecast and the next seven days for 26.0932, -80.1243 from Open-Meteo's forecast endpoint. All displayed times use America/New_York, independent of the browser's timezone. Units are Celsius, km/h, millimetres, and degrees for wind direction (the direction wind comes from).

The hourly fields are temperature and relative humidity at 2 m, precipitation, and wind speed/direction at 10, 80, 120 and 180 m. Daily fields are maximum/minimum temperature, sunrise, sunset, and daylight duration. Select a day and hour to explore all readings. Values are forecasts, not sensor observations; missing values display a dash.

Data loads on first opening, is cached in memory for 15 minutes, and refreshes while the dialog is open. Refresh also allows retrying immediately. Failed refreshes retain the previous forecast with an explicit status. Closing the dialog does not recreate or alter Cesium layers. The request is browser-side and requires access to api.open-meteo.com.

Reference: https://open-meteo.com/en/docs

Browser regression: `node cesium-poc/e2e/i595-weather.smoke.mjs` from the repository root, with the Vite server running on port 5188. The test uses deterministic forecast responses; a separate live endpoint check verified eight daily and 192 hourly entries.
