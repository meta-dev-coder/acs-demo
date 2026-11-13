/**
 * The forecast: fetched on first open, cached for fifteen minutes, refreshable, and abortable.
 *
 * Nothing is requested until the dialog is opened — a map session that never asks about the
 * weather should not call Open-Meteo at all.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { localHour, validateForecast, WEATHER_URL } from '../weather/weatherData.js';

export const FORECAST_STATE = Object.freeze({
  IDLE: 'IDLE', LOADING: 'LOADING', READY: 'READY', FAILED: 'FAILED',
});

const CACHE_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 15000;

export function useWeatherForecast(active) {
  const [state, setState] = useState(FORECAST_STATE.IDLE);
  const [forecast, setForecast] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [error, setError] = useState('');
  const pendingRef = useRef(null);
  const forecastRef = useRef(null);
  const fetchedAtRef = useRef(0);
  const disposedRef = useRef(false);

  useEffect(() => () => { disposedRef.current = true; }, []);

  const load = useCallback(async (force = false) => {
    if (pendingRef.current) return pendingRef.current;
    // A cached forecast is still good unless it is stale OR the calendar day has rolled over —
    // "Today" must not keep pointing at yesterday.
    const fresh = forecastRef.current
      && Date.now() - fetchedAtRef.current < CACHE_MS
      && forecastRef.current.daily.time[0] === localHour().slice(0, 10);
    if (!force && fresh) { setState(FORECAST_STATE.READY); return undefined; }

    setState(FORECAST_STATE.LOADING);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    pendingRef.current = (async () => {
      try {
        const response = await fetch(WEATHER_URL, { signal: controller.signal });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const next = validateForecast(await response.json());
        if (disposedRef.current) return;
        forecastRef.current = next;
        fetchedAtRef.current = Date.now();
        setForecast(next);
        setFetchedAt(fetchedAtRef.current);
        setError('');
        setState(FORECAST_STATE.READY);
      } catch (failure) {
        if (disposedRef.current) return;
        // A failed refresh keeps the forecast already on screen; only a first failure is fatal.
        setError(forecastRef.current
          ? 'Update failed — showing the previous forecast.'
          : `Forecast unavailable (${failure.message}).`);
        setState(forecastRef.current ? FORECAST_STATE.READY : FORECAST_STATE.FAILED);
      } finally {
        clearTimeout(timer);
        pendingRef.current = null;
      }
    })();
    return pendingRef.current;
  }, []);

  // Load when opened, and keep it current for as long as it stays open.
  useEffect(() => {
    if (!active) return undefined;
    void load();
    const interval = setInterval(() => { void load(); }, CACHE_MS);
    return () => clearInterval(interval);
  }, [active, load]);

  return { state, forecast, fetchedAt, error, refresh: () => load(true) };
}
