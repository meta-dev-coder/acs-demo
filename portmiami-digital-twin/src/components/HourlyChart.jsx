import { useCallback, useMemo, useRef, useState } from 'react';
import { clock, number } from '../weather/weatherData.js';

/**
 * The day's hourly temperature and precipitation.
 *
 * Two panels, one x axis, never one plot with two y scales: temperature is degrees and
 * precipitation is millimetres, and overlaying them would invite reading a crossing as an event.
 * Stacked small multiples share the time axis, so the hours still line up by eye.
 *
 * Each panel carries ONE series, so neither needs a legend — its own heading names it. The colours
 * were checked with the dataviz palette validator against this light surface: #c2410c and #1862d0
 * pass the lightness band, chroma floor, CVD separation (ΔE 27.9 protan) and contrast.
 *
 * The hour cards under the chart are the table view: every plotted value is also readable as text,
 * so nothing here is carried by colour or position alone.
 */
const W = 760;
const PAD_L = 34, PAD_R = 12;
const TEMP_TOP = 10, TEMP_H = 104;
const RAIN_TOP = 148, RAIN_H = 52;
const AXIS_Y = RAIN_TOP + RAIN_H;
const H = AXIS_Y + 22;

const TEMP_COLOR = '#c2410c';
const RAIN_COLOR = '#1862d0';

/** A nice-ish rounded domain with a little headroom, so the line never touches the frame. */
function temperatureScale(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return null;
  const min = Math.min(...finite), max = Math.max(...finite);
  const lo = Math.floor(min - 1), hi = Math.ceil(max + 1);
  const span = Math.max(4, hi - lo);
  return { lo, hi: lo + span, span };
}

export function HourlyChart({ hourly, indices, selectedIndex, onSelectHour }) {
  const svgRef = useRef(null);
  const [hoverSlot, setHoverSlot] = useState(null);

  const temps = useMemo(() => indices.map(i => hourly.temperature_2m[i]), [hourly, indices]);
  const rain = useMemo(() => indices.map(i => hourly.precipitation[i]), [hourly, indices]);
  const scale = useMemo(() => temperatureScale(temps), [temps]);
  const rainMax = useMemo(() => Math.max(1, ...rain.filter(Number.isFinite)), [rain]);

  const step = (W - PAD_L - PAD_R) / Math.max(1, indices.length - 1);
  const x = slot => PAD_L + slot * step;
  const tempY = value => TEMP_TOP + TEMP_H - ((value - scale.lo) / scale.span) * TEMP_H;

  // One path per run of readings. A gap in the data breaks the line instead of being bridged,
  // which would draw a temperature that was never forecast.
  const paths = useMemo(() => {
    if (!scale) return [];
    const runs = [];
    let run = [];
    temps.forEach((value, slot) => {
      if (Number.isFinite(value)) run.push(`${x(slot)},${tempY(value)}`);
      else { if (run.length > 1) runs.push(run); run = []; }
    });
    if (run.length > 1) runs.push(run);
    return runs.map(points => `M${points.join(' L')}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [temps, scale, step]);

  const slotFromEvent = useCallback(event => {
    const svg = svgRef.current;
    if (!svg) return null;
    const box = svg.getBoundingClientRect();
    const local = ((event.clientX - box.left) / box.width) * W;
    const slot = Math.round((local - PAD_L) / step);
    return slot >= 0 && slot < indices.length ? slot : null;
  }, [indices.length, step]);

  if (!scale) return <p className="wx-empty">No hourly readings for this day.</p>;

  const activeSlot = hoverSlot ?? indices.indexOf(selectedIndex);
  const active = activeSlot >= 0 ? activeSlot : null;
  // Ticks every three hours; an axis label per hour would collide at this width.
  const tickEvery = Math.max(1, Math.ceil(indices.length / 8));
  const barWidth = Math.max(3, step - 2);   // a 2px surface gap between neighbouring bars

  return (
    <div className="wx-chart">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Hourly temperature in degrees Celsius and precipitation in millimetres, ${indices.length} hours`}
        onMouseMove={event => setHoverSlot(slotFromEvent(event))}
        onMouseLeave={() => setHoverSlot(null)}
        onClick={event => { const slot = slotFromEvent(event); if (slot != null) onSelectHour(indices[slot]); }}
      >
        {/* Recessive frame: two baselines and three gridlines, nothing more. */}
        {[0, 0.5, 1].map(fraction => (
          <line
            key={fraction}
            x1={PAD_L} x2={W - PAD_R}
            y1={TEMP_TOP + TEMP_H * fraction} y2={TEMP_TOP + TEMP_H * fraction}
            className={fraction === 1 ? 'wx-axis' : 'wx-grid'}
          />
        ))}
        <text className="wx-tick" x={PAD_L - 6} y={TEMP_TOP + 4} textAnchor="end">{scale.hi}°</text>
        <text className="wx-tick" x={PAD_L - 6} y={TEMP_TOP + TEMP_H} textAnchor="end">{scale.lo}°</text>

        {active != null && (
          <line className="wx-crosshair" x1={x(active)} x2={x(active)} y1={TEMP_TOP} y2={AXIS_Y} />
        )}

        {paths.map((d, index) => (
          <path key={index} d={d} fill="none" stroke={TEMP_COLOR} strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {active != null && Number.isFinite(temps[active]) && (
          <circle cx={x(active)} cy={tempY(temps[active])} r="4.5"
                  fill={TEMP_COLOR} stroke="var(--ui-surface)" strokeWidth="2" />
        )}

        {/* Precipitation: bars from their own baseline, rounded at the data end only. */}
        <line className="wx-axis" x1={PAD_L} x2={W - PAD_R} y1={AXIS_Y} y2={AXIS_Y} />
        <text className="wx-tick" x={PAD_L - 6} y={RAIN_TOP + 4} textAnchor="end">{rainMax.toFixed(1)}</text>
        {rain.map((value, slot) => {
          if (!Number.isFinite(value) || value <= 0) return null;
          const height = Math.max(2, (value / rainMax) * RAIN_H);
          return (
            <rect
              key={slot}
              x={x(slot) - barWidth / 2} y={AXIS_Y - height}
              width={barWidth} height={height} rx="2"
              fill={RAIN_COLOR} opacity={active == null || active === slot ? 1 : 0.55}
            />
          );
        })}

        {indices.map((index, slot) => (slot % tickEvery === 0 ? (
          <text key={index} className="wx-tick" x={x(slot)} y={H - 6} textAnchor="middle">
            {clock(hourly.time[index])}
          </text>
        ) : null))}
      </svg>

      {active != null && (
        <div
          className="wx-tooltip"
          style={{ left: `${(x(active) / W) * 100}%` }}
          role="status"
        >
          <strong>{clock(hourly.time[indices[active]])}</strong>
          <span><i style={{ background: TEMP_COLOR }} aria-hidden="true" />{number(temps[active], 1)} °C</span>
          <span><i style={{ background: RAIN_COLOR }} aria-hidden="true" />{number(rain[active], 1)} mm</span>
        </div>
      )}
    </div>
  );
}
