/**
 * The planner's charts: plain SVG, drawn from the same run results the cards show.
 *
 * Built the way `HourlyChart` is — no chart library in this project — and under the same rules:
 * one measure per plot, never two y-scales; a series is labelled rather than carried by colour
 * alone; and every value plotted is also readable as text in the table beside or under it.
 *
 * Nothing here holds a number of its own. Pass it runs and it draws them; pass it nothing and it
 * says there is nothing to draw, rather than rendering an illustrative shape.
 */
const COLORS = ['#1862d0', '#0e9f6e', '#c2410c', '#6b46c1'];
const BASELINE_COLOR = '#64748b';

const fmt = value => (Number.isFinite(value) ? Math.round(value).toLocaleString() : '—');

/** Capacity against forecast demand, as grouped bars with the demand line across them. */
export function CapacityChart({ rows, demand }) {
  if (!rows?.length) return <p className="scenario-empty">Run a scenario to draw this.</p>;
  const W = 420, H = 150, PAD_L = 44, PAD_B = 26, PAD_T = 12;
  const max = Math.max(...rows.map(r => r.metrics.capacity ?? 0), demand ?? 0, 1);
  const plotH = H - PAD_B - PAD_T;
  const bandW = (W - PAD_L - 10) / rows.length;
  const y = value => PAD_T + plotH - (value / max) * plotH;

  return (
    <figure className="scenario-figure">
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`Proposed capacity by scenario against forecast demand of ${fmt(demand)} spaces`}>
        {[0, 0.5, 1].map(t => (
          <g key={t}>
            <line x1={PAD_L} x2={W - 6} y1={y(max * t)} y2={y(max * t)} stroke="var(--ui-border)" strokeWidth="1" />
            <text x={PAD_L - 6} y={y(max * t) + 3.5} textAnchor="end" fontSize="9" fill="var(--ui-text-muted)">
              {fmt(max * t)}
            </text>
          </g>
        ))}
        {rows.map((row, i) => {
          const value = row.metrics.capacity ?? 0;
          const x = PAD_L + i * bandW + bandW * 0.18;
          const w = bandW * 0.64;
          return (
            <g key={row.runId}>
              <rect x={x} y={y(value)} width={w} height={Math.max(1, PAD_T + plotH - y(value))}
                rx="3" fill={row.type === 'BASELINE' ? BASELINE_COLOR : COLORS[i % COLORS.length]} />
              <text x={x + w / 2} y={H - 14} textAnchor="middle" fontSize="9" fill="var(--ui-text-secondary)">
                {row.key ?? row.name.slice(0, 6)}
              </text>
              <text x={x + w / 2} y={y(value) - 4} textAnchor="middle" fontSize="9"
                fill="var(--ui-text)" fontWeight="600">{fmt(value)}</text>
            </g>
          );
        })}
        {Number.isFinite(demand) && (
          <g>
            <line x1={PAD_L} x2={W - 6} y1={y(demand)} y2={y(demand)}
              stroke="#c2410c" strokeWidth="2" strokeDasharray="5 3" />
            <text x={W - 8} y={y(demand) - 5} textAnchor="end" fontSize="9" fill="#c2410c" fontWeight="600">
              forecast demand {fmt(demand)}
            </text>
          </g>
        )}
      </svg>
      <figcaption>Proposed total capacity by scenario, against forecast peak demand. Modelled from the current assumptions.</figcaption>
    </figure>
  );
}

/** The demand curve from base year to forecast year, with each scenario's capacity as a line. */
export function DemandChart({ run, rows }) {
  const curve = run?.results?.demandCurve ?? [];
  if (curve.length < 2) return <p className="scenario-empty">Run a scenario to draw this.</p>;
  const W = 420, H = 150, PAD_L = 44, PAD_B = 26, PAD_T = 12;
  const plotH = H - PAD_B - PAD_T;
  const capacities = (rows ?? []).map(r => r.metrics.capacity).filter(Number.isFinite);
  const max = Math.max(...curve.map(p => p.demand), ...capacities, 1);
  const years = curve.map(p => p.year);
  const minYear = Math.min(...years), maxYear = Math.max(...years);
  const x = year => PAD_L + ((year - minYear) / Math.max(1, maxYear - minYear)) * (W - PAD_L - 12);
  const y = value => PAD_T + plotH - (value / max) * plotH;
  const path = curve.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.year).toFixed(1)},${y(p.demand).toFixed(1)}`).join(' ');

  return (
    <figure className="scenario-figure">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Forecast peak parking demand against scenario capacity">
        {[0, 0.5, 1].map(t => (
          <line key={t} x1={PAD_L} x2={W - 6} y1={y(max * t)} y2={y(max * t)} stroke="var(--ui-border)" />
        ))}
        {(rows ?? []).filter(r => Number.isFinite(r.metrics.capacity)).map((row, i) => (
          <g key={row.runId}>
            <line x1={PAD_L} x2={W - 6} y1={y(row.metrics.capacity)} y2={y(row.metrics.capacity)}
              stroke={row.type === 'BASELINE' ? BASELINE_COLOR : COLORS[i % COLORS.length]}
              strokeWidth="1.5" strokeDasharray="4 3" />
            <text x={PAD_L + 3} y={y(row.metrics.capacity) - 3} fontSize="8.5"
              fill={row.type === 'BASELINE' ? BASELINE_COLOR : COLORS[i % COLORS.length]}>
              {row.key ?? row.name.slice(0, 8)} capacity
            </text>
          </g>
        ))}
        <path d={path} fill="none" stroke="#c2410c" strokeWidth="2.5" />
        <text x={PAD_L - 6} y={y(max) + 3.5} textAnchor="end" fontSize="9" fill="var(--ui-text-muted)">{fmt(max)}</text>
        <text x={PAD_L} y={H - 10} fontSize="9" fill="var(--ui-text-secondary)">{minYear}</text>
        <text x={W - 10} y={H - 10} textAnchor="end" fontSize="9" fill="var(--ui-text-secondary)">{maxYear}</text>
      </svg>
      <figcaption>
        Forecast peak demand (orange) against each scenario’s capacity. Synthetic growth assumption —
        not a cruise-passenger forecast.
      </figcaption>
    </figure>
  );
}

/** Access-road loading: added vehicles over the baseline, with the assumed capacity marked. */
export function TrafficChart({ rows }) {
  const usable = (rows ?? []).filter(r => Number.isFinite(r.metrics.accessVc));
  if (!usable.length) return <p className="scenario-empty">No access road nominated, so no road loading was modelled.</p>;
  const W = 420, H = 150, PAD_L = 44, PAD_B = 26, PAD_T = 12;
  const plotH = H - PAD_B - PAD_T;
  const max = Math.max(...usable.map(r => Math.max(r.metrics.accessVc, 1.2)), 1.2);
  const bandW = (W - PAD_L - 10) / usable.length;
  const y = value => PAD_T + plotH - (value / max) * plotH;

  return (
    <figure className="scenario-figure">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Modelled volume-to-capacity ratio by scenario">
        <line x1={PAD_L} x2={W - 6} y1={y(1)} y2={y(1)} stroke="#c2410c" strokeWidth="2" strokeDasharray="5 3" />
        <text x={W - 8} y={y(1) - 5} textAnchor="end" fontSize="9" fill="#c2410c" fontWeight="600">
          assumed capacity (V/C 1.0)
        </text>
        {usable.map((row, i) => {
          const value = row.metrics.accessVc;
          const x = PAD_L + i * bandW + bandW * 0.18;
          const w = bandW * 0.64;
          return (
            <g key={row.runId}>
              <rect x={x} y={y(value)} width={w} height={Math.max(1, PAD_T + plotH - y(value))} rx="3"
                fill={row.type === 'BASELINE' ? BASELINE_COLOR : value >= 1 ? '#c2410c' : COLORS[i % COLORS.length]} />
              <text x={x + w / 2} y={H - 14} textAnchor="middle" fontSize="9" fill="var(--ui-text-secondary)">
                {row.key ?? row.name.slice(0, 6)}
              </text>
              <text x={x + w / 2} y={y(value) - 4} textAnchor="middle" fontSize="9" fontWeight="600" fill="var(--ui-text)">
                {value.toFixed(2)}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption>
        Modelled peak volume ÷ assumed capacity on the nominated approach. A ratio, not a measured
        speed or delay.
      </figcaption>
    </figure>
  );
}
