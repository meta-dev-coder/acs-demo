import { useEffect, useMemo, useRef, useState } from 'react';
import { LOCATION } from '../config/portMiami.js';
import { FORECAST_STATE, useWeatherForecast } from '../hooks/useWeatherForecast.js';
import {
  clock, dateLabel, dayName, direction, duration, HEIGHTS, hoursOfDay, localHour, number,
  TIMEZONE, weatherCodeIcon, weatherCodeText,
} from '../weather/weatherData.js';
import { HourlyChart } from './HourlyChart.jsx';

/**
 * Today and the next seven days for PortMiami, from Open-Meteo — the same service and field set
 * the ACS I-595 twin uses, so the two projects read the same numbers.
 *
 * A real <dialog>, so Escape closes it and focus is trapped without any of that being rebuilt here.
 */
export function WeatherDialog({ open, onClose }) {
  const dialogRef = useRef(null);
  const { state, forecast, fetchedAt, error, refresh } = useWeatherForecast(open);
  const [dayIndex, setDayIndex] = useState(0);
  const [hourIndex, setHourIndex] = useState(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const daily = forecast?.daily;
  const hourly = forecast?.hourly;
  const days = useMemo(() => daily?.time ?? [], [daily]);
  const safeDay = Math.min(dayIndex, Math.max(0, days.length - 1));
  const indices = useMemo(
    () => (hourly && days[safeDay] ? hoursOfDay(hourly, days[safeDay]) : []), [hourly, days, safeDay]);

  // Opening on a day lands on the current hour, or that day's first. Re-picked whenever the day
  // changes, so switching to Friday does not leave the panel on an hour that is not in Friday.
  useEffect(() => {
    if (indices.length === 0) return;
    setHourIndex(current => {
      if (current != null && indices.includes(current)) return current;
      const now = localHour();
      return indices.find(i => hourly.time[i] >= now) ?? indices[0];
    });
  }, [indices, hourly]);

  const hour = hourIndex != null && indices.includes(hourIndex) ? hourIndex : indices[0];
  const at = key => (hour == null ? undefined : hourly?.[key]?.[hour]);
  const condition = weatherCodeText(at('weather_code'));

  return (
    <dialog ref={dialogRef} className="wx-dialog" aria-labelledby="wx-title" onClose={onClose}>
      <header className="wx-head">
        <div>
          <span className="wx-eyebrow">{LOCATION.label}</span>
          <h2 id="wx-title">Weather forecast</h2>
          <p>
            {LOCATION.latitude.toFixed(4)}° N, {Math.abs(LOCATION.longitude).toFixed(4)}° W ·
            {' '}Florida local time
          </p>
        </div>
        <button type="button" className="road-icon-btn" onClick={onClose} aria-label="Close weather">×</button>
      </header>

      <div className="wx-toolbar">
        <span className="wx-status" role="status">
          {state === FORECAST_STATE.LOADING && !forecast && 'Loading the eight-day forecast…'}
          {state === FORECAST_STATE.LOADING && forecast && 'Updating…'}
          {state === FORECAST_STATE.READY && !error
            && `Updated ${new Date(fetchedAt).toLocaleTimeString('en-US', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' })} · ${TIMEZONE}`}
          {error}
        </span>
        <button type="button" className="road-btn" onClick={refresh} disabled={state === FORECAST_STATE.LOADING}>
          ↻ Refresh
        </button>
      </div>

      {state === FORECAST_STATE.FAILED && (
        <p className="wx-empty">Unable to reach Open-Meteo. Try Refresh.</p>
      )}

      {forecast && (
        <div className="wx-body">
          <nav className="wx-days" aria-label="Forecast days">
            {days.map((date, index) => (
              <button
                key={date}
                type="button"
                aria-pressed={index === safeDay}
                onClick={() => { setDayIndex(index); setHourIndex(null); }}
              >
                <span>{dayName(date, index)}</span>
                <small>{dateLabel(date)}</small>
                <i aria-hidden="true">{weatherCodeIcon(daily.weather_code[index])}</i>
                <strong>
                  {number(daily.temperature_2m_max[index])}°
                  <em>{number(daily.temperature_2m_min[index])}°</em>
                </strong>
              </button>
            ))}
          </nav>

          <div className="wx-overview">
            <section className="wx-hero">
              <span className="wx-eyebrow">{dateLabel(days[safeDay])} · {clock(hourly.time[hour])}</span>
              <div className="wx-temp">{number(at('temperature_2m'), 1)}<span>°C</span></div>
              <p>{condition ?? 'Condition not reported'}</p>
              <div className="wx-range">
                High {number(daily.temperature_2m_max[safeDay])}°
                <span>Low {number(daily.temperature_2m_min[safeDay])}°</span>
              </div>
            </section>
            <section className="wx-metrics">
              <article>
                <span>Relative humidity · 2 m</span>
                <strong>{number(at('relative_humidity_2m'))}<small> %</small></strong>
              </article>
              <article>
                <span>Precipitation this hour</span>
                <strong>{number(at('precipitation'), 1)}<small> mm</small></strong>
              </article>
              <article>
                <span>Day total</span>
                <strong>{number(daily.precipitation_sum[safeDay], 1)}<small> mm</small></strong>
              </article>
              <article>
                <span>Wind · 10 m</span>
                <strong>{number(at('wind_speed_10m'), 1)}<small> km/h</small></strong>
                <small>From {direction(at('wind_direction_10m'))}</small>
              </article>
            </section>
          </div>

          <section className="wx-section">
            <div className="wx-section-head">
              <h3>Through the day</h3>
              <label>
                Forecast hour
                <select value={hour ?? ''} onChange={event => setHourIndex(Number(event.target.value))}>
                  {indices.map(index => (
                    <option key={index} value={index}>{clock(hourly.time[index])}</option>
                  ))}
                </select>
              </label>
            </div>
            <p className="wx-legend">
              <span><i style={{ background: '#c2410c' }} aria-hidden="true" />Temperature · °C</span>
              <span><i style={{ background: '#1862d0' }} aria-hidden="true" />Precipitation · mm</span>
            </p>
            <HourlyChart hourly={hourly} indices={indices} selectedIndex={hour} onSelectHour={setHourIndex} />
            <div className="wx-hours">
              {indices.map(index => (
                <button
                  key={index}
                  type="button"
                  aria-pressed={index === hour}
                  onClick={() => setHourIndex(index)}
                >
                  <small>{clock(hourly.time[index])}</small>
                  <strong>{number(hourly.temperature_2m[index])}°</strong>
                  <span>{number(hourly.precipitation[index], 1)} mm</span>
                </button>
              ))}
            </div>
          </section>

          <div className="wx-bottom">
            <section className="wx-section">
              <h3>Wind by height</h3>
              <p className="wx-note">{clock(hourly.time[hour])} · the direction the wind comes from</p>
              <div className="wx-wind">
                {HEIGHTS.map(height => (
                  <article key={height}>
                    <span>{height} m</span>
                    <strong>{number(at(`wind_speed_${height}m`), 1)}<small> km/h</small></strong>
                    <div>{direction(at(`wind_direction_${height}m`))}</div>
                  </article>
                ))}
              </div>
            </section>
            <section className="wx-section">
              <h3>Daylight</h3>
              <dl className="wx-sun">
                <div><dt>Sunrise</dt><dd>{clock(daily.sunrise[safeDay])}</dd></div>
                <div><dt>Sunset</dt><dd>{clock(daily.sunset[safeDay])}</dd></div>
                <div><dt>Daylight</dt><dd>{duration(daily.daylight_duration[safeDay])}</dd></div>
              </dl>
            </section>
          </div>
        </div>
      )}

      <footer className="wx-foot">
        Forecast model data · °C / km/h / mm ·{' '}
        <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Weather data by Open-Meteo</a>
      </footer>
    </dialog>
  );
}
