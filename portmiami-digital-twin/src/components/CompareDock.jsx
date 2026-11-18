/**
 * The results dock while Compare is open: every simulated alternative side by side, at a glance.
 *
 * Three cards, drawn only from the runs that exist — the same numbers the Compare tab tabulates:
 *
 *   Parking capacity  a ring of each alternative's added spaces, with the selected one in the middle.
 *   Peak occupancy    forecast peak demand ÷ usable capacity, year by year, for the existing supply
 *                     and each alternative. Built from each run's own demand curve; above 100% the
 *                     demand does not fit.
 *   Key findings      the first three calculated findings for the top-ranked alternative (or the selected one
 *                     when nothing can be ranked). Never a claim the model did not produce.
 */
import { keyFindings, metricsOf } from '../scenarios/comparison.js';

const COLORS = ['#1862d0', '#0e9f6e', '#c2410c', '#6b46c1'];
const BASELINE_COLOR = '#94a3b8';
const fmt = value => (Number.isFinite(value) ? Math.round(value).toLocaleString() : '—');
const title = run => String(run.scenarioName ?? '').replace(/^[A-Z]\.\s*/, '');

const Icon = ({ children }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

function CapacityRing({ runs, selectedId }) {
  const R = 38, C = 2 * Math.PI * R, GAP = 3;
  const total = runs.reduce((sum, run) => sum + (metricsOf(run).addedSpaces ?? 0), 0);
  const centre = runs.find(run => run.scenarioId === selectedId) ?? runs[0];
  let offset = 0;
  return (
    <div className="compare-ring">
      <svg viewBox="0 0 100 100" width="104" height="104" role="img"
        aria-label={`Added spaces by alternative: ${runs.map(run => `${run.scenarioKey ?? title(run)} ${fmt(metricsOf(run).addedSpaces)}`).join(', ')}`}>
        <circle cx="50" cy="50" r={R} fill="none" stroke="var(--ui-border-soft)" strokeWidth="10" />
        {total > 0 && runs.map((run, i) => {
          const share = (metricsOf(run).addedSpaces ?? 0) / total;
          const length = Math.max(0, share * C - (runs.length > 1 ? GAP : 0));
          const arc = (
            <circle key={run.id} cx="50" cy="50" r={R} fill="none" stroke={COLORS[i % COLORS.length]}
              strokeWidth="10" strokeDasharray={`${length} ${C - length}`} strokeDashoffset={-offset}
              transform="rotate(-90 50 50)" />
          );
          offset += share * C;
          return arc;
        })}
        <text x="50" y="50" textAnchor="middle" fontSize="17" fontWeight="700" fill="var(--ui-text)">
          {fmt(metricsOf(centre).addedSpaces)}
        </text>
        <text x="50" y="63" textAnchor="middle" fontSize="8.5" fill="var(--ui-text-secondary)">
          spaces · {centre.scenarioKey ?? ''}
        </text>
      </svg>
      <ul className="compare-legend">
        {runs.map((run, i) => (
          <li key={run.id}>
            <i style={{ background: COLORS[i % COLORS.length] }} />
            <span title={title(run)}>{run.scenarioKey ? `Scenario ${run.scenarioKey}` : title(run)}</span>
            <b>{fmt(metricsOf(run).addedSpaces)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Demand ÷ usable capacity over the forecast years, one line per supply. */
function OccupancyChart({ runs }) {
  const occupancy = (curve, usable) => (usable > 0
    ? curve.map(p => ({ year: p.year, pct: (p.demand / usable) * 100 })) : []);

  const lines = runs.map((run, i) => ({
    id: run.id, label: run.scenarioKey ? `Scenario ${run.scenarioKey}` : title(run),
    color: COLORS[i % COLORS.length],
    points: occupancy(run.results?.demandCurve ?? [], run.results?.capacity?.usableCapacity),
  })).filter(line => line.points.length > 1);

  // The existing supply, at the same utilisation the alternatives assume.
  const first = runs.find(run => run.results?.capacity?.proposedTotalCapacity > 0);
  if (first) {
    const { existingCapacity, usableCapacity, proposedTotalCapacity } = first.results.capacity;
    const points = occupancy(first.results.demandCurve ?? [],
      existingCapacity * (usableCapacity / proposedTotalCapacity));
    if (points.length > 1) lines.unshift({ id: 'baseline', label: 'Existing', color: BASELINE_COLOR, points });
  }
  if (!lines.length) return <p className="scenario-empty">No demand forecast in these runs.</p>;

  const W = 300, H = 118, L = 34, B = 18, T = 8, Rp = 8;
  const years = lines.flatMap(line => line.points.map(p => p.year));
  const minYear = Math.min(...years), maxYear = Math.max(...years);
  const top = Math.max(100, Math.ceil(Math.max(...lines.flatMap(line => line.points.map(p => p.pct))) / 50) * 50);
  const x = year => L + ((year - minYear) / Math.max(1, maxYear - minYear)) * (W - L - Rp);
  const y = pct => T + (H - T - B) * (1 - pct / top);
  // 0, 100% and the top: a half-way tick would sit on top of the 100% line's label.
  const ticks = top === 100 ? [0, 50, 100] : [0, 100, top];

  return (
    <div className="compare-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`Forecast peak occupancy from ${minYear} to ${maxYear}: ${lines.map(line => `${line.label} ${Math.round(line.points[line.points.length - 1].pct)}%`).join(', ')}`}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={L} x2={W - Rp} y1={y(t)} y2={y(t)}
              stroke={t === 100 ? '#c2410c' : 'var(--ui-border)'} strokeDasharray={t === 100 ? '4 3' : undefined} />
            <text x={L - 5} y={y(t) + 3} textAnchor="end" fontSize="8.5" fill="var(--ui-text-muted)">{t}%</text>
          </g>
        ))}
        {lines.map(line => (
          <g key={line.id}>
            <polyline fill="none" stroke={line.color} strokeWidth="2"
              points={line.points.map(p => `${x(p.year).toFixed(1)},${y(p.pct).toFixed(1)}`).join(' ')} />
            {line.points.map(p => (
              <circle key={p.year} cx={x(p.year)} cy={y(p.pct)} r="2.3" fill={line.color} />
            ))}
          </g>
        ))}
        <text x={L} y={H - 4} fontSize="8.5" fill="var(--ui-text-secondary)">{minYear}</text>
        <text x={W - Rp} y={H - 4} textAnchor="end" fontSize="8.5" fill="var(--ui-text-secondary)">{maxYear}</text>
      </svg>
      <ul className="compare-legend is-compact">
        {lines.map(line => (
          <li key={line.id}><i style={{ background: line.color }} /><span>{line.label}</span></li>
        ))}
      </ul>
    </div>
  );
}

const TONE_GLYPH = {
  good: <path d="M6 12.5l4 4 8-9" />,
  warn: <><path d="M12 7v6" /><path d="M12 17h.01" /></>,
  bad: <><path d="M12 7v6" /><path d="M12 17h.01" /></>,
  neutral: <path d="M7 12h10" />,
};

export function CompareDock({ runs, recommendation, selectedId }) {
  const ranked = recommendation?.available ? recommendation.ranking : null;
  const focus = (ranked && runs.find(run => run.id === ranked[0].runId))
    ?? runs.find(run => run.scenarioId === selectedId) ?? runs[0];
  const findings = keyFindings(focus, ranked).slice(0, 3);

  return (
    <div className="scenario-dock-cards is-compare">
      <article className="scenario-card">
        <h3 className="compare-head">
          <Icon><path d="M5 17h14l-1.5-6.5a2 2 0 0 0-2-1.5h-7a2 2 0 0 0-2 1.5z" /><circle cx="8" cy="17" r="1.6" /><circle cx="16" cy="17" r="1.6" /></Icon>
          Parking Capacity
        </h3>
        <CapacityRing runs={runs} selectedId={selectedId} />
      </article>

      <article className="scenario-card">
        <h3 className="compare-head">
          <Icon><path d="M4 19h16" /><path d="M5 15l4-4 3 3 6-7" /></Icon>
          Peak Occupancy
        </h3>
        <OccupancyChart runs={runs} />
      </article>

      <article className="scenario-card">
        <h3 className="compare-head">
          <Icon><path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z" /><circle cx="12" cy="11" r="2" /></Icon>
          Key Findings
          <span className="compare-head-note">
            {focus.scenarioKey ? `Scenario ${focus.scenarioKey}` : title(focus)}{ranked ? ' · ranks first' : ''}
          </span>
        </h3>
        <ul className="compare-findings">
          {findings.map(finding => (
            <li key={finding.text} className={`is-${finding.tone}`}>
              <span aria-hidden="true">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                  strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">{TONE_GLYPH[finding.tone]}</svg>
              </span>
              {finding.text}
            </li>
          ))}
        </ul>
      </article>
    </div>
  );
}
