/**
 * The Cruise Parking Simulation: one question, asked of the selected garage or terminal —
 * WHEN DOES CRUISE-DRIVEN PARKING DEMAND EXCEED THE GARAGE CAPACITY IT CAN USE, AND WHICH DESIGN
 * RESOLVES THAT?
 *
 *   Cruise Activity      the day's calls, which are modelled, and what they bring
 *   Demand & Turnover    cars parking and leaving for each cruise, in one table
 *   Time Simulation      the decision view: demand against capacity through the day, the garage at
 *                        the selected time, one sentence on what is happening, and A/B/C side by side
 *   Compare Designs      the same demand through Existing, A, B and C for the selected garage
 *
 * Everything else — every assumption, the terminal → garage mapping, the per-cruise arithmetic,
 * the 15-minute inspector, capacity sources — sits one click away in the "Data & Assumptions"
 * drawer (CruiseDetailPanels.jsx). Nothing is computed here: all figures come from
 * `useCruiseDemand`, which reads the simulation.
 *
 * The map is the app's own Cesium viewer. "View on map" minimises the workspace to a bar, so the
 * selected garage, its terminals and the selected design's 3D geometry are seen full screen.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MapControlButtons } from './MapControls.jsx';
import { DEMAND_PROFILES } from '../cruise/cruiseAssumptions.js';
import { utcMsToLocal } from '../cruise/cruiseCalls.js';
import { CAPACITY_STATUS_LABEL } from '../cruise/vesselMaster.js';
import { DESIGN_RESULT, FOCUS, durationLabel } from '../cruise/demandCapacity.js';
import { PLAYBACK_SPEEDS, WORKSPACE_STEP } from '../hooks/useCruiseDemand.js';
import { UTILISATION_COLOUR, utilisationColour } from '../cesium/cruiseParkingLayer.js';
import {
  AssumptionsPanel, CalculationInspector, CapacityBreakdown, CruiseImpact, CruiseStrip, CruiseTable, EventList,
  GarageTable, Happening, MappingEditor, SourceKey, TimeFigures, TurnoverTable, hourTicks, useWidth,
} from './CruiseDetailPanels.jsx';
import { DesignEditor } from './CruiseDesignEditor.jsx';
import { RowEditor } from './CruiseRowEditor.jsx';

const fmt = v => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');
const pct = v => (Number.isFinite(v) ? `${Math.round(v)}%` : '—');
const dayLabel = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const local = iso => (iso ? iso.slice(11, 16) : '—');
const clock = ms => utcMsToLocal(ms).time;

const TABS = [
  [WORKSPACE_STEP.ACTIVITY, '1', 'Cruise Activity'],
  [WORKSPACE_STEP.TURNOVER, '2', 'Demand & Turnover'],
  [WORKSPACE_STEP.TIME, '3', 'Time Simulation'],
  [WORKSPACE_STEP.COMPARE, '4', 'Compare Designs'],
];

const RESULT_TONE = {
  RESOLVES: 'ok', REDUCES: 'warn', NO_CHANGE: 'bad', NO_SHORTAGE: 'muted', WORSE: 'bad', ASSIGNMENT_MISSING: 'bad', PROVIDES_ACCESS: 'warn',
};

/** Everything behind the dialog is inert while it is shown. */
function useInertBehind(active, keep) {
  useLayoutEffect(() => {
    if (!active) return undefined;
    const shell = document.querySelector('.cw-shell');
    const behind = [...document.querySelectorAll('.workspace-rail, .app-main > *, .app-viewport > *')]
      .filter(el => el !== shell && el !== keep && !el.contains(keep) && !el.classList.contains('cw-backdrop') && !el.contains(shell));
    const made = behind.filter(el => !el.inert);
    made.forEach(el => { el.inert = true; });
    document.documentElement.dataset.cruiseWorkspace = 'open';
    return () => { made.forEach(el => { el.inert = false; }); delete document.documentElement.dataset.cruiseWorkspace; };
  }, [active, keep]);
}

/**
 * Dock the app's own Cesium container onto the map slot in the Time Simulation view: fixed to the
 * slot's rectangle, clipped to the scrolling body, above the dialog. No second viewer is created;
 * the container goes back where it was when the slot goes.
 */
function useDockedViewer(mapRef, slot) {
  useLayoutEffect(() => {
    const host = mapRef?.current;
    if (!host || !slot) return undefined;
    const body = slot.closest('.cd-body');
    const apply = () => {
      const r = slot.getBoundingClientRect(), clip = body?.getBoundingClientRect() ?? r;
      const top = Math.max(r.top, clip.top), bottom = Math.min(r.bottom, clip.bottom);
      host.style.inset = 'auto';
      Object.assign(host.style, {
        position: 'fixed', left: `${r.left}px`, top: `${top}px`, width: `${r.width}px`, height: `${Math.max(0, bottom - top)}px`,
        zIndex: '63', borderRadius: '12px', overflow: 'hidden', display: bottom - top > 20 ? '' : 'none',
      });
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(slot);
    body?.addEventListener('scroll', apply, { passive: true });
    window.addEventListener('resize', apply);
    host.inert = false;
    return () => {
      ro.disconnect();
      body?.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
      for (const k of ['position', 'left', 'top', 'width', 'height', 'inset', 'zIndex', 'borderRadius', 'overflow', 'display']) host.style[k] = '';
    };
  }, [mapRef, slot]);
}

/**
 * Camera controls on the docked map — the same handlers as the full-screen column (zoom, orbit,
 * tilt, north, home) plus "Focus garage". Rendered INTO the Cesium container, so they stay above
 * the map wherever it is docked.
 */
function DockedMapControls({ host, handlers, onFocus, label }) {
  if (!host) return null;
  return createPortal(
    <div className="cd-mapctl" role="group" aria-label="Map navigation">
      <button type="button" className="cd-mapctl-focus" onClick={onFocus} title={`Focus the camera on ${label}`}>⌖ Focus {label}</button>
      <div className="map-controls is-docked">
        <MapControlButtons handlers={{
          onZoomIn: handlers.onZoomIn, onZoomOut: handlers.onZoomOut,
          onRotateLeft: handlers.onRotateLeft, onRotateRight: handlers.onRotateRight,
          onTiltUp: handlers.onTiltUp, onTiltDown: handlers.onTiltDown,
          onNorthUp: handlers.onNorthUp, onReset: handlers.onReset,
        }} />
      </div>
    </div>,
    host,
  );
}

// ---- the decision view -----------------------------------------------------------------------------------

/** Demand (blue) against capacity (amber), shortage in red; click or drag to choose a time. */
function DemandChart({ cruise }) {
  const ref = useRef(null);
  const W = useWidth(ref), H = 250;
  const P = { l: 56, r: 16, t: 26, b: 28 };
  const d = cruise.dvc;
  const t = d.series;
  const n = t.length;
  const [hover, setHover] = useState(null);
  const dragging = useRef(false);
  const line = d.missingAssignment ? t.map(s => s.unallocated) : t.map(s => s.required);
  const max = Math.max(1, d.capacity, ...line) * 1.12;
  const x = i => P.l + (i / Math.max(1, n)) * (W - P.l - P.r);
  const y = v => P.t + (H - P.t - P.b) * (1 - v / max);
  const step = (vals, close) => `M${x(0)},${y(close ? 0 : vals[0])} ${vals.map((v, i) => `L${x(i)},${y(v)} L${x(i + 1)},${y(v)}`).join(' ')}${close ? ` L${x(n)},${y(0)} Z` : ''}`;
  const indexAt = e => {
    const box = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - box.left) - P.l) / ((W - P.l - P.r) / n))));
  };
  const i = cruise.timeIndex;
  const peak = d.peak, first = d.firstShortage;
  const h = hover ?? i;
  const hs = t[h];
  // The selected cruise's own share of the demand line: part of the total, drawn inside it.
  const mine = cruise.contribution?.series ?? null;
  const who = cruise.selectedCall ? `${cruise.selectedCall.shipName} (${cruise.selectedDirection === 'RETURNING' ? 'returning' : 'departing'})` : null;
  return (
    <div ref={ref} className="cd-chart">
      <svg width={W} height={H} role="img" aria-label={`Parking demand against capacity through the day for ${d.label}. Click or drag to choose a time.`}
        onPointerDown={e => { dragging.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); cruise.setTimeIndex(indexAt(e)); }}
        onPointerMove={e => { const k = indexAt(e); setHover(k); if (dragging.current) cruise.setTimeIndex(k); }}
        onPointerUp={() => { dragging.current = false; }}
        onPointerLeave={() => { dragging.current = false; setHover(null); }}>
        {[0, 0.25, 0.5, 0.75, 1].map(f => (
          <g key={f}>
            <line x1={P.l} x2={W - P.r} y1={y((max / 1.12) * f)} y2={y((max / 1.12) * f)} stroke="#eef1f5" />
            <text x={P.l - 8} y={y((max / 1.12) * f) + 4} textAnchor="end" className="cw-axis">{fmt((max / 1.12) * f)}</text>
          </g>
        ))}
        {hourTicks(t).map(({ h: hh, i: k }) => <text key={hh} x={x(k)} y={H - 8} textAnchor="middle" className="cw-axis">{String(hh).padStart(2, '0')}:00</text>)}
        {!d.missingAssignment && <path d={step(t.map(s => s.occupied), true)} fill="#1769e014" stroke="none" />}
        {/* Red: demand above capacity. Where cars are without parking while spaces stand free, the band sits on the demand line instead. */}
        {t.map((s, k) => {
          if (!s.shortage) return null;
          const top = Math.max(s.required, s.capacity + Math.min(s.shortage, s.pooledShortage));
          const bottom = s.pooledShortage > 0 ? s.capacity : s.required - s.shortage;
          return <rect key={k} x={x(k)} y={y(top)} width={x(k + 1) - x(k) + 0.5} height={Math.max(1, y(bottom) - y(top))} fill="#d9302540" />;
        })}
        {mine && !d.missingAssignment && <path d={step(mine.map(m => m.total), true)} fill="#8e44ad40" stroke="#8e44ad" strokeWidth="1.5" />}
        {d.capacity > 0 && <line x1={P.l} x2={W - P.r} y1={y(d.capacity)} y2={y(d.capacity)} stroke="#f29900" strokeWidth="2" strokeDasharray="7 5" />}
        <path d={step(line, false)} fill="none" stroke={d.missingAssignment ? '#8a5a00' : '#1769e0'} strokeWidth="2.5" strokeDasharray={d.missingAssignment ? '5 4' : undefined} />
        {!d.missingAssignment && t.some(s => s.unallocated) && <path d={step(t.map(s => s.unallocated), false)} fill="none" stroke="#8a5a00" strokeWidth="1.5" strokeDasharray="5 4" />}
        {peak && !d.missingAssignment && (
          <g>
            <circle cx={x(peak.index + 0.5)} cy={y(peak.value)} r="4" fill="#1769e0" />
            <text x={Math.min(W - P.r - 4, x(peak.index + 0.5) + 6)} y={y(peak.value) - 8} textAnchor={x(peak.index) > W - 160 ? 'end' : 'start'} className="cd-mark">Peak demand {fmt(peak.value)} · {peak.time}</text>
          </g>
        )}
        {first && <line x1={x(first.index)} x2={x(first.index)} y1={P.t} y2={H - P.b} stroke="#d93025" strokeDasharray="2 3" />}
        <line x1={x(i + 0.5)} x2={x(i + 0.5)} y1={P.t - 10} y2={H - P.b} stroke="#0f1b33" strokeWidth="1.5" />
        <circle cx={x(i + 0.5)} cy={y(line[i] ?? 0)} r="5" fill="#fff" stroke="#0f1b33" strokeWidth="2" />
        {hs && (
          <g transform={`translate(${Math.min(W - P.r - 190, Math.max(P.l, x(h + 0.5) + 10))}, ${P.t})`} pointerEvents="none">
            <rect width="182" height={(hs.shortage ? 70 : 56) + (mine ? 14 : 0)} rx="6" fill="#fff" stroke="#e3e8ef" />
            <text x="10" y="18" className="cd-tip is-strong">{hs.time}</text>
            <text x="10" y="34" className="cd-tip">{d.missingAssignment ? `No garage: ${fmt(hs.unallocated)} cars` : `Demand ${fmt(hs.required)} · capacity ${fmt(d.capacity)}`}</text>
            <text x="10" y="50" className="cd-tip">{d.missingAssignment ? '' : `Parked ${fmt(hs.occupied)} · free ${fmt(hs.free)}`}</text>
            {hs.shortage > 0 && <text x="10" y="64" className="cd-tip is-bad">Unmet {fmt(hs.shortage)}</text>}
            {mine && <text x="10" y={hs.shortage ? 78 : 64} className="cd-tip" fill="#8e44ad">Selected cruise {fmt(mine[h]?.total)}</text>}
          </g>
        )}
      </svg>
      <p className="cw-legend">
        <span><i style={{ background: '#1769e0' }} />{d.missingAssignment ? 'Cars with no garage assigned' : 'Total parking demand (all cruises)'}</span>
        {mine && !d.missingAssignment && <span><i style={{ background: '#8e44ad80' }} />{who} — included in the total</span>}
        {d.capacity > 0 && <span><i className="is-amber" />Capacity {fmt(d.capacity)}</span>}
        {!d.missingAssignment && <span><i style={{ background: '#1769e030' }} />Cars parked</span>}
        <span><i style={{ background: '#d9302560' }} />Unmet demand</span>
        {!d.missingAssignment && t.some(s => s.unallocated) && <span><i className="is-amber-dash" />No garage assigned (not a shortage)</span>}
      </p>
    </div>
  );
}

/** The selected garage or garage group at the selected time. */
function GaragePanel({ cruise }) {
  const d = cruise.dvc, s = d.series[cruise.timeIndex];
  const amber = cruise.assumptions.utilisationAmberPct, red = cruise.assumptions.utilisationRedPct;
  if (d.missingAssignment) {
    return (
      <aside className="cd-garage">
        <h3>Terminal {d.focus.id} at {s.time}</h3>
        <div className="cd-alert is-warn">No garage is assigned to Terminal {d.focus.id} in the county parking mapping. {fmt(s.unallocated)} modelled cars need parking but cannot be tested against any capacity. Assign a garage under Data &amp; Assumptions.</div>
      </aside>
    );
  }
  const utilisation = d.capacity ? (s.occupied / d.capacity) * 100 : null;
  const carried = Math.max(0, s.shortage - s.rejectedNow);
  return (
    <aside className="cd-garage">
      <h3>{d.label} at {s.time}</h3>
      {/* Every quantity separately: what is parked, what moved, and what is unmet — never one number. */}
      <dl className="cd-breakdown">
        <div><dt>Garage capacity</dt><dd>{d.capacity ? fmt(d.capacity) : '—'}</dd></div>
        <div><dt>Cars parked at {s.time} (start)</dt><dd>{fmt(s.startOccupied)}</dd></div>
        <div><dt>+ New cars admitted</dt><dd className="cw-in">{fmt(s.entries)}</dd></div>
        <div><dt>− Cars leaving</dt><dd className="cw-out">{fmt(s.exits)}</dd></div>
        <div className="is-total"><dt>= Cars actually parked</dt><dd>{fmt(s.occupied)}</dd></div>
        <div><dt>Free spaces</dt><dd>{fmt(s.free)}</dd></div>
        <div><dt>Utilization</dt><dd style={{ color: utilisationColour(utilisation, { amber, red }) }}>{pct(utilisation)}</dd></div>
        <div className={s.rejectedNow ? 'is-bad' : undefined}><dt>Turned away this interval</dt><dd>{fmt(s.rejectedNow)}</dd></div>
        <div className={carried ? 'is-bad' : undefined}><dt>Turned away earlier, still unmet</dt><dd>{fmt(carried)}</dd></div>
        <div className={s.shortage ? 'is-bad' : undefined}><dt>Unmet parking demand</dt><dd>{fmt(s.shortage)}</dd></div>
        {s.unallocated > 0 && <div className="is-warn"><dt>No garage mapped (not a shortage)</dt><dd>{fmt(s.unallocated)}</dd></div>}
        {s.unchecked > 0 && <div className="is-warn"><dt>Garage capacity unverified</dt><dd>{fmt(s.unchecked)}</dd></div>}
        <div className="is-total"><dt>Spaces required</dt><dd>{fmt(s.required)}</dd></div>
      </dl>
      <p className="cd-equation">
        Parked: {fmt(s.startOccupied)} + {fmt(s.entries)} − {fmt(s.exits)} = {fmt(s.occupied)} · Free: max(0, {fmt(d.capacity)} − {fmt(s.occupied)}) = {fmt(s.free)} · Required: {fmt(s.occupied)} parked + {fmt(s.shortage)} unmet{s.unchecked ? ` + ${fmt(s.unchecked)} unverified` : ''} = {fmt(s.required)}
      </p>
      {s.shortage > 0
        ? (
          <div className="cd-alert is-bad">
            {s.rejectedNow > 0 ? `${fmt(s.rejectedNow)} cars are turned away at ${s.time}. ` : `No car is turned away at ${s.time}. `}
            {carried > 0 ? `${fmt(carried)} cars denied ${d.deniedToday ? 'earlier' : 'before today'} are still unmet until their ship returns. ` : ''}
            {s.free > 0 ? `${fmt(s.free)} spaces are free now: turned-away cars do not retry, so free spaces do not reduce unmet demand${d.facilities.length > 1 ? ', and some may be in a garage these cars may not use' : ''}.` : 'Turned-away cars never occupy a space.'}
          </div>
        )
        : <div className="cd-alert is-ok">{d.maxShortage.value ? `No shortage at ${s.time}. The largest shortage today is ${fmt(d.maxShortage.value)} at ${d.maxShortage.time}.` : 'No shortage under current modelled demand and assumptions.'}</div>}
      {d.facilities.length > 1 && (
        <ul className="cd-garagelist">
          {d.facilities.map(f => {
            const g = s.garages[f.id];
            const u = Number.isFinite(f.capacity) && f.capacity ? (g.end / f.capacity) * 100 : null;
            return (
              <li key={f.id}>
                <span>{f.name}{f.proposed ? ' (proposed)' : f.addedSpaces ? ` (+${fmt(f.addedSpaces)})` : ''}</span>
                <span className="cw-utilbar"><span><i style={{ width: `${Math.min(100, u ?? 0)}%`, background: utilisationColour(u, { amber, red }) }} /></span><b>{Number.isFinite(f.capacity) ? `${fmt(g.end)}/${fmt(f.capacity)}` : 'capacity not published'}</b></span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="cd-meta">
        Serves {d.terminals.length ? `Terminal ${d.terminals.join(', ')}` : 'no modelled terminal'} · peak demand {fmt(d.peak?.value)} at {d.peak?.time ?? '—'}
        {d.maxShortage.value ? ` · largest shortage ${fmt(d.maxShortage.value)}` : ''}
      </p>
    </aside>
  );
}

/** The day's modelled cruises, each direction separately, for "Change cruise". */
function cruiseChoices(cruise) {
  return cruise.cruises.flatMap(r => [
    r.returning && { value: `${r.call.id}|RETURNING`, label: `${r.call.shipName} · Terminal ${r.call.terminalCode} · ↓ returning` },
    r.departing && { value: `${r.call.id}|DEPARTING`, label: `${r.call.shipName} · Terminal ${r.call.terminalCode} · ↑ departing` },
  ].filter(Boolean));
}

/**
 * The selected cruise as the focal point: cruise → terminal → garage → date, with the profile,
 * design and time, and "Change cruise" / "Clear cruise focus". Choosing another garage never
 * changes the cruise; it says whether the cruise's cars may use that garage.
 */
function CruiseBreadcrumb({ cruise }) {
  const c = cruise.selectedCall, d = cruise.dvc;
  const dir = cruise.selectedDirection === 'RETURNING' ? 'returning' : 'departing';
  const el = cruise.eligibility;
  const choices = cruiseChoices(cruise);
  const value = c ? `${c.id}|${cruise.selectedDirection}` : '';
  const garage = d.missingAssignment ? <b className="cw-bad">Garage assignment missing</b> : <b>{d.label}</b>;
  return (
    <section className="cd-crumb" aria-label="Selected cruise">
      <nav className="cd-crumb-path" aria-label="Selection">
        {c ? <><b>⛴ {c.shipName}</b> <span className={dir === 'returning' ? 'cw-out' : 'cw-in'}>({dir === 'returning' ? '↓' : '↑'} {dir})</span><i>→</i><b>Terminal {c.terminalCode}</b><i>→</i></>
          : <><span className="cw-dim">No cruise selected</span><i>→</i></>}
        {garage}<i>→</i><b>{dayLabel(cruise.date)}</b>
        <span className="cd-crumb-meta">{cruise.profile === 'CUSTOM' ? 'Custom' : DEMAND_PROFILES[cruise.profile].label} demand · {cruise.viewName} · {cruise.atTime?.time}</span>
      </nav>
      <div className="cd-crumb-actions">
        <label className="cw-control">Change cruise
          <select value={value} aria-label="Change cruise" onChange={e => { const [id, way] = e.target.value.split('|'); if (id) cruise.viewInTime(id, way); }}>
            <option value="">Choose a cruise…</option>
            {choices.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        {c && <button type="button" className="cw-btn is-small" onClick={cruise.clearCruiseFocus}>Clear cruise focus</button>}
      </div>
      {c && el && el.eligible === false && (
        <p className="cd-alert is-warn" role="status">
          {c.shipName}'s cars (Terminal {c.terminalCode}) cannot use {d.label}{el.mapped.length ? ` — they may use ${el.mapped.map(f => f.name).join(', ')}` : ` — Terminal ${c.terminalCode} has no garage assigned`}. The chart shows {d.label}'s demand from other cruises; this cruise adds none of it.
        </p>
      )}
    </section>
  );
}

/** What the selected cruise asks of the garage at the selected time — not the garage total. */
function CruiseContribution({ cruise }) {
  const c = cruise.selectedCall, k = cruise.selectedCohort, st = cruise.cruiseStatus;
  if (!c) return null;
  const returning = cruise.selectedDirection === 'RETURNING';
  if (!k || !st) return <section className="cd-card cd-contrib"><p className="cw-hint">{c.shipName} has no modelled {returning ? 'returning' : 'departing'} parking cohort{c.passengerCapacity ? '' : ' (passenger capacity not validated)'}.</p></section>;
  const el = cruise.eligibility;
  const share = cruise.contribution?.series[cruise.timeIndex]?.total ?? 0;
  const names = id => cruise.current?.facilities.find(f => f.id === id)?.name ?? id;
  return (
    <section className="cd-card cd-contrib" aria-label="Selected cruise contribution">
      <header><h3>{c.shipName} — {returning ? 'returning cars' : 'new departing cars'}</h3><span className="cd-chip">{share > 0 ? `${fmt(share)} of the ${fmt(cruise.dvc.series[cruise.timeIndex]?.required)} spaces required now` : 'none of the demand shown now'}</span></header>
      <dl className="cd-facts">
        <div><dt>{returning ? 'Cars in the cohort' : 'Cars required by this cruise'}</dt><dd>{fmt(st.required)}</dd></div>
        {returning ? <>
          <div><dt>Parked (these can leave)</dt><dd>{fmt(st.admitted)}</dd></div>
          <div><dt>Already left</dt><dd>{fmt(st.left)}</dd></div>
          <div><dt>Still parked</dt><dd>{fmt(st.stillParked)}</dd></div>
        </> : <>
          <div><dt>Cars already admitted</dt><dd>{fmt(st.admitted)}</dd></div>
          <div><dt>Cars waiting to arrive</dt><dd>{fmt(st.waiting)}</dd></div>
        </>}
        <div className={st.denied ? 'is-bad' : undefined}><dt>Cars denied parking</dt><dd>{fmt(st.denied)}</dd></div>
        {st.unchecked > 0 && <div className="is-warn"><dt>Garage capacity unverified</dt><dd>{fmt(st.unchecked)}</dd></div>}
        <div><dt>Eligible garages</dt><dd>{el ? [...el.mapped, ...el.overflow].map(f => f.name).join(', ') || 'none mapped' : '—'}</dd></div>
        {Object.keys(st.byGarage).length > 0 && <div><dt>Parked in</dt><dd>{Object.entries(st.byGarage).map(([id, n]) => `${names(id)} ${fmt(n)}`).join(' · ')}</dd></div>}
      </dl>
    </section>
  );
}

/** One sentence on the selected cruise, from the run's own values. */
function cruiseSentence(cruise) {
  const c = cruise.selectedCall, k = cruise.selectedCohort;
  if (!c || !k || cruise.dvc.missingAssignment) return '';
  const returning = cruise.selectedDirection === 'RETURNING';
  const [a, b] = returning ? [k.exitStartMs, k.exitEndMs] : [k.entryStartMs, k.entryEndMs];
  // Other cruises' demand in this garage at the selected time: the total less this cruise's share.
  const s = cruise.dvc.series[cruise.timeIndex];
  const others = s ? s.required - (cruise.contribution?.series[cruise.timeIndex]?.total ?? 0) : 0;
  return returning
    ? `${c.shipName}'s ${fmt(k.servedTotal)} parked cars leave between ${clock(a)} and ${clock(b)}${k.unserved ? ` (${fmt(k.unserved)} more were denied parking when they arrived and never parked)` : ''}.`
    : `${c.shipName} requires ${fmt(k.vehicles)} parking spaces between ${clock(a)} and ${clock(b)}${others > 0 ? `; ${cruise.dvc.label} also holds ${fmt(others)} spaces of other cruises' demand at ${s.time}` : ''}.`;
}

/** Every garage in play at the selected time; choosing one makes it the focus. */
function GarageStatus({ cruise }) {
  const s = cruise.current, at = cruise.atTime;
  const amber = cruise.assumptions.utilisationAmberPct, red = cruise.assumptions.utilisationRedPct;
  const rows = [...s.facilities].sort((a, b) => (b.capacity ?? -1) - (a.capacity ?? -1));
  return (
    <section className="cd-card cd-status">
      <header><h3>Garage status at {at.time}</h3></header>
      <table className="cd-table is-tight">
        <thead><tr><th>Garage</th><th>Terminal</th><th>Capacity</th><th>Occupied</th><th>Available</th><th>Utilization</th></tr></thead>
        <tbody>
          {rows.map(f => {
            const r = at.facilities[f.id];
            const known = Number.isFinite(f.capacity);
            const u = known && f.capacity ? (r.end / f.capacity) * 100 : null;
            const short = r.shortActive > 0;
            return (
              <tr key={f.id} className={`is-link${cruise.focus.kind === 'GARAGE' && cruise.focus.id === f.id ? ' is-selected' : ''}${short ? ' is-short' : ''}`}
                onClick={() => cruise.setFocus({ kind: FOCUS.GARAGE, id: f.id })}>
                <td><b>{f.name}</b>{f.addedSpaces ? <span className="cw-tag">+{fmt(f.addedSpaces)}</span> : null}</td>
                <td>{f.servesTerminals.join(', ') || '—'}</td>
                <td>{known ? fmt(f.capacity) : '—'}</td>
                <td>{fmt(r.end)}</td>
                <td>{known ? fmt(Math.max(0, f.capacity - r.end)) : '—'}</td>
                <td><span className="cw-utilbar"><span><i style={{ width: `${Math.min(100, u ?? 0)}%`, background: utilisationColour(u, { amber, red }) }} /></span><b>{known ? pct(u) : 'n/p'}</b></span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function RecommendationSection({ cruise, onMap, onEdit }) {
  const v = cruise.designs?.verdict;
  if (!v) return null;
  // The design to act on: the one recommended, else the most efficient or first feasible, else A.
  const target = cruise.designs.cards.find(c => c.id === (v.best ?? v.fewest ?? v.options?.[0]))
    ?? (['NONE', 'REDUCES', 'TIE'].includes(v.kind) ? cruise.designs.cards.find(c => c.id !== 'baseline') : null);
  const preview = cruise.designDraft ? cruise.alternatives.find(a => a.id === cruise.designDraft.id) : null;
  return (
    <section className={`cd-reco cx-reco is-${v.tone ?? 'neutral'}`} aria-label="Recommendation">
      <div className="cd-reco-main">
        <p className="cd-reco-basis">{preview ? `Based on preview inputs — ${preview.name} has unsaved changes` : 'Based on saved designs'} · {cruise.dvc.label} · {dayLabel(cruise.date)} · {cruise.profile === 'CUSTOM' ? 'custom assumptions' : `${DEMAND_PROFILES[cruise.profile].label} demand`}</p>
        <h3>{v.headline}</h3>
        <p>{v.text}</p>
        {v.why?.length > 0 && (
          <>
            <h4 className="cd-reco-why">{v.kind === 'ONLY' || v.kind === 'FEASIBLE' ? 'Why recommended?' : 'Why this result?'}</h4>
            <ul className="cx-why">{v.why.map(w => <li key={w}>{w}</li>)}</ul>
          </>
        )}
        {v.needs?.length > 0 && (
          <>
            <h4 className="cd-reco-why">Data needed</h4>
            <ul className="cx-why">{v.needs.map(w => <li key={w}>{w}</li>)}</ul>
          </>
        )}
      </div>
      {v.before !== undefined && (
        <dl className="cd-reco-figs">
          <div><dt>Unmet before</dt><dd className={v.before ? 'cw-bad' : undefined}>{fmt(v.before)}</dd></div>
          <div><dt>Unmet after</dt><dd className={v.after ? 'cw-bad' : 'cw-ok'}>{fmt(v.after)}</dd></div>
          <div><dt>Added spaces</dt><dd>{v.added > 0 ? `+${fmt(v.added)}` : '0'}</dd></div>
        </dl>
      )}
      <div className="cd-reco-actions">
        {target && onEdit && <button type="button" className="cw-btn is-primary" onClick={() => onEdit(target.id)}>Edit {target.name.split('.')[0]} capacity</button>}
        <button type="button" className="cw-btn" onClick={() => onMap(target?.id)}>View {target ? `${target.name.split('.')[0]} ` : ''}on map</button>
      </div>
    </section>
  );
}

// ---- Time Simulation: the decision screen ----------------------------------------------------------------

/** The three headline numbers for the day: peak need, usable capacity, and what is left unmet. */
function HeadlineMetrics({ cruise }) {
  const d = cruise.dvc;
  if (d.missingAssignment) {
    return (
      <div className="cx-metrics">
        <div><span>Peak spaces required</span><b>{fmt(d.maxUnallocated)}</b><small>cars from Terminal {d.focus.id}</small></div>
        <div className="is-warn"><span>Eligible parking capacity</span><b>None</b><small>Garage assignment missing</small></div>
        <div className="is-warn"><span>Cars with no garage</span><b>{fmt(d.maxUnallocated)}</b><small>a mapping gap, not a capacity shortage</small></div>
      </div>
    );
  }
  const unmet = d.maxShortage.value;
  const sub = d.deniedToday > 0
    ? `${fmt(d.deniedToday)} cars denied today, first at ${d.firstDenial.time}`
    : d.backlogAtStart > 0 ? `none denied today — ${fmt(d.backlogAtStart)} still unmet from earlier days` : 'no car denied parking';
  return (
    <div className="cx-metrics">
      <div><span>Peak spaces required</span><b>{fmt(d.peak?.value)}</b><small>at {d.peak?.time ?? '—'}</small></div>
      <div><span>Eligible parking capacity</span><b>{d.capacity ? fmt(d.capacity) : '—'}</b><small>{d.facilities.filter(f => Number.isFinite(f.capacity)).map(f => f.name).join(', ') || 'capacity not published'}{d.unknownCapacity.length ? ` · ${d.unknownCapacity.join(', ')} unverified` : ''}</small></div>
      <div className={unmet ? 'is-bad' : 'is-ok'}><span>Maximum unmet demand</span><b>{fmt(unmet)}</b><small>{sub}{d.maxGap.value ? ` · peak capacity gap ${fmt(d.maxGap.value)}` : ''}</small></div>
    </div>
  );
}

function TimeTab({ cruise, onDetails, onCompare, setSlot, details, setDetails }) {
  const d = cruise.dvc;
  return (
    <div className="cx-time">
      <CruiseBreadcrumb cruise={cruise} />
      <HeadlineMetrics cruise={cruise} />
      <section className="cd-card cx-chart">
        <header>
          <h3>{d.missingAssignment ? `Terminal ${d.focus.id} — cars with no garage` : `Parking spaces required vs capacity — ${d.label}`}</h3>
          <span className="cd-design-pill">{cruise.viewName}</span>
        </header>
        <DemandChart cruise={cruise} />
      </section>
      <Playback cruise={cruise} inline />
      <p className="cd-explain cx-explain" aria-live="polite">{cruiseSentence(cruise)} {cruise.demandExplanation}</p>
      <div className="cx-actions">
        <button type="button" className="cw-btn is-primary" onClick={onCompare}>Compare solutions →</button>
        <button type="button" className="cw-btn" onClick={() => onDetails('CALC')}>How was this calculated?</button>
        <button type="button" className="cw-btn" onClick={() => cruise.viewOnMap()}>View on map</button>
        <button type="button" className="cw-btn" aria-expanded={details} onClick={() => setDetails(!details)}>{details ? 'Hide garage details' : 'Garage details'}</button>
      </div>
      {details && (
        <section className="cx-garage-details" aria-label="Garage details">
          <div className="cx-gd-map"><div className="cd-t-map" ref={setSlot} aria-label="Map: garages and terminals" /></div>
          <GaragePanel cruise={cruise} />
          <div className="cx-gd-side">
            {cruise.selectedCall ? <section className="cd-card"><CruiseContribution cruise={cruise} /></section>
              : <section className="cd-card"><p className="cw-hint">Select a cruise to see its share of this garage's demand.</p></section>}
          </div>
          <GarageStatus cruise={cruise} />
        </section>
      )}
    </div>
  );
}

// ---- Cruise Activity -------------------------------------------------------------------------------------

function ActivityTab({ cruise }) {
  const rows = cruise.cruises;
  const modelled = rows.filter(r => r.call.passengerCapacity);
  const departing = rows.reduce((t, r) => t + (r.enteringVehicles ?? 0), 0);
  const returning = rows.reduce((t, r) => t + (r.leavingVehicles ?? 0), 0);
  const pick = r => cruise.selectCruise(r.call.id, r.departing ? 'DEPARTING' : 'RETURNING');
  return (
    <div className="cx-stack">
      <div className="cx-stats">
        <div><b>{rows.length}</b><span>Cruise calls</span></div>
        <div><b>{modelled.length}</b><span>Modelled calls</span></div>
        <div><b>{fmt(departing)}</b><span>Departing parking vehicles (est.)</span></div>
        <div><b>{fmt(returning)}</b><span>Returning parking vehicles (est.)</span></div>
      </div>
      <section className="cd-card">
        <header><h3>Cruise calls — {dayLabel(cruise.date)}</h3><span className="cw-dim">Select a cruise to follow it through every tab.</span></header>
        {!rows.length ? <p className="cw-empty">No vessel calls on this date.</p> : (
          <table className="cd-table cx-calls">
            <thead><tr><th>Cruise</th><th>Terminal</th><th>Arrival</th><th>Departure</th><th>Passenger capacity</th><th>Modelled</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.call.id} className={`is-link${r.call.passengerCapacity ? '' : ' is-muted'}`} tabIndex={0}
                  aria-selected={cruise.selectedCallId === r.call.id} onClick={() => pick(r)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(r); } }}>
                  <td><b>{r.call.shipName}</b></td>
                  <td>{r.call.terminalCode}</td>
                  <td>{local(r.call.arrivalLocal)}</td>
                  <td>{local(r.call.departureLocal)}{r.call.departureDate !== r.call.arrivalDate ? ` (${r.call.departureDate.slice(5).replace('-', '/')})` : ''}</td>
                  <td>{r.call.passengerCapacity ? fmt(r.call.passengerCapacity) : '—'}</td>
                  <td>{r.call.passengerCapacity ? <span className="cd-yes">✓ Modelled</span> : <span className="cd-no">Not modelled</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <details className="cw-fold">
        <summary>Data sources and missing data</summary>
        <p className="cw-note">Calls come from the PortMiami November 2026 Dock Report (reported times). Only calls with a validated published passenger capacity are modelled ({modelled.length} of {rows.length} today). Passenger capacity is a ship's capacity, not a passenger count; cars are estimated from it with the stated assumptions.</p>
        <ul className="cd-list">
          {rows.map(r => (
            <li key={r.call.id}><b>{r.call.shipName}</b> — {r.call.passengerCapacity
              ? `${fmt(r.call.passengerCapacity)} (${r.call.passengerCapacitySource?.title ?? 'published capacity'})`
              : CAPACITY_STATUS_LABEL[r.call.capacityStatus] ?? 'capacity not validated — not modelled'}{r.completeness ? ` · ${r.completeness.label}` : ''}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

// ---- Demand & Turnover ------------------------------------------------------------------------------------

/** Where a row's cars come from, in the table's Source column. */
function sourceTag(x, reconstructed) {
  const cohort = x.flow === 'Returning' ? x.r.returning : x.r.departing;
  if (cohort?.provenance === 'MANUAL_ESTIMATE') return <span className="cw-tag is-manual">manually estimated</span>;
  if (cohort?.provenance === 'RECONCILED') return <span className="cw-tag is-manual">{reconstructed ? 'reconstructed · reconciled' : 'reconciled'}</span>;
  return reconstructed ? <span className="cw-tag is-rec">reconstructed</span> : <span className="cw-tag is-est">estimated</span>;
}

/** Every cruise's cars, one row per direction: a drill-down, not the default view. */
function AllCruisesTable({ cruise, rows }) {
  const selected = cruise.selectedCallId ? `${cruise.selectedCallId}-${cruise.selectedDirection === 'RETURNING' ? 'r' : 'd'}` : null;
  const window = x => x.calc.timing.find(w => w.kind === (x.flow === 'Returning' ? 'EXIT' : 'ENTRY'));
  const pick = x => cruise.selectCruise(x.r.call.id, x.flow === 'Returning' ? 'RETURNING' : 'DEPARTING');
  return (
    <table className="cd-table cd-rows">
      <thead><tr><th>Cruise</th><th>Terminal</th><th>Direction</th><th>Passengers</th><th>Long-stay %</th><th>Cars</th><th>Window</th><th>Source</th></tr></thead>
      <tbody>
        {rows.map(x => {
          const w = window(x);
          const ret = x.flow === 'Returning';
          const cars = ret ? x.r.leavingVehicles : x.calc.vehicles;
          const edited = Object.keys(cruise.cruiseEdits[x.r.call.id] ?? {}).some(k => (ret ? ['returning', 'exit'] : ['departing', 'entry']).some(p => k.startsWith(p)));
          return (
            <tr key={x.id} className="is-link" tabIndex={0} aria-selected={selected === x.id} onClick={() => pick(x)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(x); } }}>
              <td><b>{x.r.call.shipName}</b>{edited && <span className="cw-tag" title="This cruise has its own values">edited</span>}</td>
              <td>{x.r.call.terminalCode}</td>
              <td className={ret ? 'cw-out' : 'cw-in'}>{ret ? '↓ Returning' : '↑ Departing'}</td>
              <td>{fmt(x.calc.inputs.passengers)}</td>
              <td>{x.calc.inputs.longStayPct}%</td>
              <td><b>{fmt(cars)}</b>{ret && cars !== x.calc.vehicles && <small className="cw-dim" title="Cars in the cohort. The rest never parked: turned away, or meant for a garage whose capacity is unknown"> of {fmt(x.calc.vehicles)}</small>}</td>
              <td>{w ? `${clock(w.startMs)}–${clock(w.endMs)}` : 'after Nov 30'}</td>
              <td>{sourceTag(x, ret && x.r.returningSource?.kind === 'RECONSTRUCTED')}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TurnoverTab({ cruise }) {
  const rows = cruise.cruises.flatMap(r => [
    r.returningCalc && { id: `${r.call.id}-r`, r, calc: r.returningCalc, flow: 'Returning' },
    r.departingCalc && { id: `${r.call.id}-d`, r, calc: r.departingCalc, flow: 'Departing' },
  ].filter(Boolean));
  const modelled = cruise.cruises.filter(r => r.returning || r.departing);
  const r = cruise.cruises.find(x => x.call.id === cruise.selectedCallId) ?? null;
  const dir = cruise.selectedDirection;
  const editRow = r && (rows.find(x => x.id === `${r.call.id}-${dir === 'RETURNING' ? 'r' : 'd'}`) ?? rows.find(x => x.r.call.id === r.call.id));
  // A reconstructed returning row links to the departure that parked its cars.
  const openOrigin = (callId, date) => { cruise.setDate(date); cruise.selectCruise(callId, 'DEPARTING'); };
  const win = (a, b) => (Number.isFinite(a) ? `${clock(a)}–${clock(b)}` : 'after Nov 30');
  // Entering: the cars that need parking; parked: those that found a space. Only parked cars occupy
  // a space, so the net change is parked in less parked out — never cars that were denied.
  const leaving = r?.leavingVehicles ?? 0, entering = r?.enteringVehicles ?? 0;
  const parked = r?.departing ? r.departing.servedTotal : 0, denied = r?.departing ? r.departing.unserved + r.departing.noData : 0;
  const net = parked - leaving;
  const src = r?.returningSource?.kind === 'RECONSTRUCTED' ? `parked by its ${dayLabel(r.returning.departureDate).slice(5)} departure`
    : r?.returning?.provenance === 'MANUAL_ESTIMATE' ? 'manually estimated' : r?.returning ? 'estimated (no earlier departure in the report)' : null;
  return (
    <div className="cx-stack">
      <div className="cx-pickbar">
        <label className="cw-control">Cruise
          <select value={r?.call.id ?? ''} aria-label="Cruise" onChange={e => { const x = cruise.cruises.find(c => c.call.id === e.target.value); if (x) cruise.selectCruise(x.call.id, x.departing ? 'DEPARTING' : 'RETURNING'); }}>
            <option value="">Choose a cruise…</option>
            {modelled.map(x => <option key={x.call.id} value={x.call.id}>{x.call.shipName} · Terminal {x.call.terminalCode}</option>)}
          </select>
        </label>
        {r && <button type="button" className="cw-btn is-primary" onClick={() => cruise.viewInTime(r.call.id, dir)}>View impact on garage →</button>}
      </div>
      {!r ? <section className="cd-card"><p className="cw-hint">Choose a cruise to see the cars it moves in and out of parking.</p></section> : (
        <section className="cd-card cx-flow-card" aria-label={`${r.call.shipName} parking turnover`}>
          <header><h3>{r.call.shipName} <span className="cw-dim">· Terminal {r.call.terminalCode} · {dayLabel(cruise.date)}</span></h3></header>
          <div className="cx-flowstats">
            <div className="cw-out"><span>Returning cars leaving</span><b>{r.returning ? fmt(leaving) : '—'}</b><small>{r.returning ? `exit ${win(r.returning.exitStartMs, r.returning.exitEndMs)}` : 'no returning cars modelled'}</small></div>
            <div className="cw-in"><span>New departing cars entering</span><b>{r.departing ? fmt(entering) : '—'}</b><small>{r.departing ? `arrive ${win(r.departing.entryStartMs, r.departing.entryEndMs)}` : 'no departing cars modelled'}</small>
              {denied > 0 && <small className="cw-bad">only {fmt(parked)} find a space — {fmt(denied)} denied parking</small>}</div>
            <div><span>Net parking change</span><b>{net > 0 ? `+${fmt(net)}` : fmt(net)}</b><small>{net > 0 ? 'more spaces occupied' : net < 0 ? 'spaces freed' : 'no change'}</small></div>
          </div>
          <ol className="cx-flow" aria-label="How cars move">
            <li className="is-out"><b>Returning passengers</b><i>→</i>collect parked cars<i>→</i><b>{fmt(leaving)} garage spaces freed</b>{src && <small> · {src}</small>}</li>
            <li className="is-in"><b>Departing passengers</b><i>→</i>park cars<i>→</i><b>{fmt(parked)} garage spaces occupied</b><small> · stay until the ship returns{denied > 0 ? ` · ${fmt(denied)} more cars find no space` : ''}</small></li>
          </ol>
          <p className="cd-note">Returning and departing cars are separate groups: the returning cars were parked for an earlier sailing, so the two numbers need not match.</p>
        </section>
      )}
      {editRow && (
        <details className="cw-fold cx-edit">
          <summary>Edit assumptions — {editRow.flow.toLowerCase()} cars</summary>
          <div className="cw-seg cx-dirseg" role="group" aria-label="Direction">
            {r.returning && <button type="button" aria-pressed={editRow.flow === 'Returning'} onClick={() => cruise.selectCruise(r.call.id, 'RETURNING')}>↓ Returning</button>}
            {r.departing && <button type="button" aria-pressed={editRow.flow === 'Departing'} onClick={() => cruise.selectCruise(r.call.id, 'DEPARTING')}>↑ Departing</button>}
          </div>
          <RowEditor key={editRow.id} cruise={cruise} row={editRow} onOpenOrigin={openOrigin} />
        </details>
      )}
      <details className="cw-fold">
        <summary>Cars for every cruise on {dayLabel(cruise.date)} ({rows.length} rows)</summary>
        {rows.length ? <AllCruisesTable cruise={cruise} rows={rows} /> : <p className="cw-empty">No modelled cruise moves cars on this date.</p>}
      </details>
    </div>
  );
}

// ---- Compare Designs ----------------------------------------------------------------------------------------

const OUTCOME = c => (c.result === DESIGN_RESULT.ASSIGNMENT_MISSING ? { tone: 'warn', label: 'Garage assignment missing' }
  : c.result === DESIGN_RESULT.NO_SHORTAGE ? { tone: 'ok', label: 'No shortage' }
    : c.resolved && c.id !== 'baseline' ? { tone: 'ok', label: 'Shortage resolved' }
      : c.result === DESIGN_RESULT.REDUCES ? { tone: 'warn', label: 'Partly reduced' }
        : { tone: 'bad', label: c.id === 'baseline' ? 'Shortage' : 'Not resolved' });

function CompareTab({ cruise, onMap, onEdit }) {
  const { cards, verdict } = cruise.designs ?? { cards: [], verdict: null };
  return (
    <div className="cx-stack">
      <RecommendationSection cruise={cruise} onMap={onMap} onEdit={onEdit} />
      <div className="cx-cards" role="list" aria-label="Parking designs">
        {cards.map(c => {
          const o = OUTCOME(c);
          const tag = verdict?.best === c.id ? (verdict.kind === 'ONLY' ? 'Recommended' : 'Largest reduction')
            : verdict?.fewest === c.id ? 'Most capacity-efficient' : verdict?.options?.includes(c.id) ? 'Feasible' : null;
          return (
            <article key={c.id} role="listitem" className={`cx-card tone-${o.tone}${cruise.viewId === c.id ? ' is-selected' : ''}`} aria-label={c.id === 'baseline' ? 'Existing parking' : c.name}>
              <header>
                <h3>{c.id === 'baseline' ? 'Existing parking' : c.name}{cruise.designDraft?.id === c.id ? <em className="cd-draft"> · unsaved</em> : null}</h3>
                {tag && <span className="cx-tag">{tag}</span>}
              </header>
              <p className={`cx-outcome is-${o.tone}`}>{o.label}</p>
              <dl>
                <div><dt>Added parking spaces</dt><dd>{c.id === 'baseline' ? '—' : c.addedCapacity > 0 ? `+${fmt(c.addedCapacity)}` : '0'}</dd></div>
                <div><dt>Total eligible capacity</dt><dd>{fmt(c.capacity)}</dd></div>
                <div><dt>Peak demand</dt><dd>{fmt(c.peakDemand)}</dd></div>
                <div><dt>Maximum unmet demand</dt><dd className={c.maxShortage ? 'cw-bad' : 'cw-ok'}>{fmt(c.maxShortage)}</dd></div>
              </dl>
              <div className="cx-card-actions">
                {/* The chart is in Time Simulation: show this design there. */}
                <button type="button" className="cw-btn is-small" onClick={() => { cruise.setViewId(c.id); cruise.setStep(WORKSPACE_STEP.TIME); }}>Show in chart</button>
                <button type="button" className="cw-btn is-small" onClick={() => onMap(c.id)}>View on map</button>
                {c.id !== 'baseline' && <button type="button" className="cw-btn is-small" onClick={() => onEdit(c.id)}>Edit capacity</button>}
              </div>
            </article>
          );
        })}
      </div>
      <details className="cw-fold">
        <summary>Detailed comparison</summary>
        <table className="cd-table cd-cmp">
          <thead><tr><th>Design</th><th>Eligible capacity</th><th>Added</th><th>Peak demand</th><th>Max unmet</th><th>Cars denied</th><th>First shortage</th><th>Shortage duration</th><th>Peak utilization</th></tr></thead>
          <tbody>
            {cards.map(c => (
              <tr key={c.id} className={`is-link${cruise.viewId === c.id ? ' is-selected' : ''}`} onClick={() => cruise.setViewId(c.id)}>
                <td><b>{c.id === 'baseline' ? 'Existing' : c.name}</b></td>
                <td>{fmt(c.capacity)}</td>
                <td>{c.id === 'baseline' ? '—' : c.addedCapacity > 0 ? `+${fmt(c.addedCapacity)}` : '0'}</td>
                <td>{fmt(c.peakDemand)}</td>
                <td className={c.maxShortage ? 'cw-bad' : 'cw-ok'}>{fmt(c.maxShortage)}</td>
                <td>{fmt(c.turnedAway)}</td>
                <td>{c.firstShortage ?? '—'}</td>
                <td>{durationLabel(c.shortageIntervals)}</td>
                <td>{pct(c.peakUtilisationPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="cd-note">Every design is tested against identical cruise demand, assumptions, initial occupancy and terminal → garage eligibility{cruise.comparison?.sameDemand ? '' : ' — warning: the demand was not identical'}. Capacity counts only spaces these terminals may use. Cars denied earlier stay unmet until their ship returns, so a day can start with unmet demand.</p>
      </details>
    </div>
  );
}

/** A spacious editor for one design, over the Compare Designs view. */
function EditPanel({ cruise, id, onClose }) {
  const alt = cruise.alternatives.find(a => a.id === id);
  if (!alt) return null;
  const close = () => { if (cruise.designDraft?.id === id && cruise.designDirty) cruise.cancelDesign(); onClose(); };
  return (
    <aside className="cd-drawer cd-editpanel" aria-label={`Edit ${alt.name}`}>
      <header>
        <h3>Edit design — {alt.name}</h3>
        <button type="button" className="cw-icon" onClick={close} aria-label="Close the design editor">×</button>
      </header>
      <div className="cd-drawer-body">
        <p className="cw-note">This is the Parking Scenario Planner's {alt.key ?? alt.name}: saved changes appear there, with the same facility and 3D geometry. Every number in the simulation follows the edit as you type; nothing is saved until you choose Save design.</p>
        <DesignEditor cruise={cruise} id={id} />
        <div className="de-actions"><button type="button" className="cw-btn" onClick={() => cruise.viewOnMap(id)}>View on map</button></div>
      </div>
    </aside>
  );
}

// ---- the drawer: Data & Assumptions, Calculation Details ------------------------------------------------------

function Drawer({ cruise, tab, setTab, onClose, section }) {
  const [inspecting, setInspecting] = useState(false);
  const unvalidated = useMemo(() => {
    const seen = new Map();
    for (const c of cruise.calls) if (!c.passengerCapacity && !seen.has(c.shipName)) seen.set(c.shipName, CAPACITY_STATUS_LABEL[c.capacityStatus] ?? '—');
    return [...seen];
  }, [cruise.calls]);
  const s = cruise.current;
  return (
    <aside className="cd-drawer" aria-label="Data, assumptions and calculation details">
      <header>
        <div className="cw-seg" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'DATA'} onClick={() => setTab('DATA')}>Data &amp; Assumptions</button>
          <button type="button" role="tab" aria-selected={tab === 'CALC'} onClick={() => setTab('CALC')}>Calculation Details</button>
        </div>
        <button type="button" className="cw-icon" onClick={onClose} aria-label="Close details">×</button>
      </header>
      <div className="cd-drawer-body">
        {tab === 'DATA' && (
          <>
            <h3 className="cw-h">Data coverage</h3>
            <p className="cw-note">{cruise.coverage.withCapacity} of {cruise.coverage.totalCalls} November calls ({cruise.coverage.modelledVessels} of {cruise.coverage.totalVessels} ships) have a validated passenger capacity and are modelled. The others are not zero-demand; they are not in the forecast.</p>
            {unvalidated.length > 0 && <details className="cw-fold" {...section('ships')}><summary>Ships not modelled ({unvalidated.length})</summary><ul className="cd-list">{unvalidated.map(([ship, why]) => <li key={ship}><b>{ship}</b> — {why}</li>)}</ul></details>}
            {[...cruise.assumptionErrors, ...cruise.allocationErrors].length > 0 && <p className="cd-alert is-bad">The simulation is paused until the assumptions below are valid.</p>}
            <h3 className="cw-h">Data quality on {dayLabel(cruise.date)}</h3>
            <ul className="cd-list">
              {s && s.unknownCapacity.length > 0 && <li>No published capacity: {s.unknownCapacity.join(', ')} — not counted as capacity; cars meant for it are "unchecked".</li>}
              {s && s.unallocatedTerminals.length > 0 && <li>No garage assigned: Terminal {s.unallocatedTerminals.join(', ')} — its cars are reported separately, never as a capacity shortage.</li>}
              <li>Initial occupancy: cars parked before November 1 come from estimated returning cohorts{Number(cruise.assumptions.backgroundOccupancyPct) ? `, plus ${cruise.assumptions.backgroundOccupancyPct}% assumed non-cruise occupancy` : '; no non-cruise background occupancy is assumed'}.</li>
              <li>All passenger and parking values are illustrative planning assumptions.</li>
            </ul>
            <details className="cw-fold" {...section('assumptions')}><summary>Passenger and parking assumptions</summary><SourceKey /><AssumptionsPanel cruise={cruise} /></details>
            <details className="cw-fold" {...section('mapping')}><summary>Terminal → garage mapping and allocation policy</summary><MappingEditor cruise={cruise} /></details>
            <details className="cw-fold" {...section('calls')}><summary>All calls on this date, with capacity sources</summary><CruiseTable cruise={cruise} /></details>
          </>
        )}
        {tab === 'CALC' && !s && <p className="cw-empty">The calculation is shown once the assumptions are valid again.</p>}
        {tab === 'CALC' && s && (
          <>
            {inspecting
              ? <CalculationInspector inspection={cruise.inspection} onClose={() => setInspecting(false)} />
              : <TimeFigures cruise={cruise} onInspect={() => setInspecting(true)} />}
            <Happening cruise={cruise} />
            <details className="cw-fold"><summary>Passenger → car calculation for each cruise</summary><TurnoverTable cruise={cruise} /></details>
            <details className="cw-fold"><summary>A cruise against its garages</summary><CruiseStrip cruise={cruise} /><CruiseImpact cruise={cruise} /></details>
            <details className="cw-fold"><summary>Every garage at {cruise.atTime?.time}</summary><GarageTable cruise={cruise} /></details>
            <details className="cw-fold"><summary>Where the capacity comes from</summary><CapacityBreakdown cruise={cruise} onClose={() => {}} /></details>
            <details className="cw-fold"><summary>Events on {dayLabel(cruise.date)}</summary><EventList cruise={cruise} /></details>
          </>
        )}
      </div>
    </aside>
  );
}

// ---- the playback bar -----------------------------------------------------------------------------------

function Playback({ cruise, inline = false }) {
  const t = cruise.current?.timeline ?? [];
  const d = cruise.dvc;
  if (!t.length) return null;
  return (
    <div className={`cw-playback cd-playback${inline ? ' is-inline' : ''}`} role="group" aria-label="Simulation time">
      <div className="cw-clock" aria-live="polite"><b>{cruise.atTime?.time ?? '—'}</b><span>{dayLabel(cruise.date)}</span></div>
      <div className="cw-transport">
        <button type="button" className="cw-icon" onClick={cruise.resetTime} title="Reset to 00:00" aria-label="Reset to 00:00">⟲</button>
        <button type="button" className="cw-icon" onClick={() => cruise.stepTime(-1)} aria-label="Previous 15 minutes" title="Previous 15 minutes" disabled={cruise.timeIndex <= 0}>⏮</button>
        <button type="button" className="cw-icon is-play" onClick={cruise.togglePlay} aria-label={cruise.playing ? 'Pause' : 'Play'}>{cruise.playing ? '❚❚' : '▶'}</button>
        <button type="button" className="cw-icon" onClick={() => cruise.stepTime(1)} aria-label="Next 15 minutes" title="Next 15 minutes" disabled={cruise.timeIndex >= cruise.lastIndex}>⏭</button>
        <label className="cw-speed">Speed
          <select value={cruise.speed} onChange={e => cruise.setSpeed(Number(e.target.value))} aria-label="Playback speed">
            {PLAYBACK_SPEEDS.map(s => <option key={s} value={s}>{s}× ({s * 15} min/s)</option>)}
          </select>
        </label>
      </div>
      <div className="cw-scrub">
        <input type="range" min="0" max={t.length - 1} value={cruise.timeIndex} aria-label="Simulation time slider" onChange={e => cruise.setTimeIndex(Number(e.target.value))} />
        <div className="cw-scrub-ticks" aria-hidden="true">
          {hourTicks(t).map(({ h, i }) => <span key={h} style={{ left: `${(i / Math.max(1, t.length - 1)) * 100}%` }}>{String(h).padStart(2, '0')}:00</span>)}
        </div>
      </div>
      <div className="cd-jumps">
        {cruise.selectedCall && <button type="button" className="cw-btn is-small" disabled={cruise.cruiseWindowIndex === null} title={cruise.cruiseWindowIndex === null ? 'The selected cruise\'s parking window is not on this date' : undefined} onClick={() => cruise.setTimeIndex(cruise.cruiseWindowIndex)}>{cruise.selectedDirection === 'RETURNING' ? 'Cruise exit window' : 'Cruise arrival window'}</button>}
        <button type="button" className="cw-btn is-small" disabled={!d?.peak} onClick={() => cruise.setTimeIndex(d.peak.index)}>Peak demand</button>
        <button type="button" className="cw-btn is-small" disabled={!d?.firstShortage} title={d?.firstDenial ? `First car denied parking at ${d.firstDenial.time}` : d?.firstShortage ? 'No car is denied today: unmet demand carried from earlier days' : 'No shortage on this date'}
          onClick={() => cruise.setTimeIndex((d.firstDenial ?? d.firstShortage).index)}>First shortage</button>
      </div>
    </div>
  );
}

// ---- the workspace -------------------------------------------------------------------------------------------

export default function CruiseWorkspace({ cruise, mapRef, cameraHandlers = {}, onLocateAsset }) {
  const closeRef = useRef(null);
  const [drawer, setDrawer] = useState(null);   // null | 'DATA' | 'CALC'
  const [editing, setEditing] = useState(null); // the design open in the Compare Designs editor
  const [garageDetails, setGarageDetails] = useState(false);   // Time Simulation drill-down, with the map
  // The map slot is state, not a ref, so the viewer re-docks whenever the slot is rendered again.
  const [slot, setSlot] = useState(null);
  // Open drawer sections, kept here so they survive the drawer closing while an edit is invalid.
  const [openSections, setOpenSections] = useState(() => new Set());
  const section = id => ({
    open: openSections.has(id),
    onToggle: e => {
      const isOpen = e.currentTarget.open;
      setOpenSections(prev => { const next = new Set(prev); if (isOpen) next.add(id); else next.delete(id); return next; });
    },
  });
  const open = cruise.workspaceOpen;
  const minimised = cruise.mapMode;
  // The map opens on demand: docked inside "Garage details", or full screen with "View on map".
  const showMap = cruise.step === WORKSPACE_STEP.TIME && garageDetails;
  useInertBehind(open && !minimised, showMap ? mapRef?.current : null);
  // While the simulation is open — docked or on the full map — the planner's own garage card is
  // hidden: the simulation's garage labels say what matters here.
  useEffect(() => {
    if (!open) return undefined;
    document.documentElement.dataset.cruiseSimulation = 'open';
    return () => { delete document.documentElement.dataset.cruiseSimulation; };
  }, [open]);
  const docked = open && !minimised && showMap ? slot : null;
  useDockedViewer(mapRef, docked);
  // Whenever the map docks or the garage in view changes, the camera goes to that garage. A short
  // wait lets the container take its new size and the layer draw the garage first.
  const focusKey = `${cruise.focus.kind}:${cruise.focus.id ?? ''}:${cruise.dvc?.facilities.map(f => f.id).join(',') ?? ''}`;
  const { focusMap } = cruise;
  useEffect(() => {
    if (!docked) return undefined;
    const t = setTimeout(() => focusMap(onLocateAsset), 400);
    return () => clearTimeout(t);
  }, [docked, focusKey, focusMap, onLocateAsset]);

  const close = useCallback(() => cruise.setWorkspaceOpen(false), [cruise]);
  // Focus the Close button once, when the workspace opens — not on every update, or each keystroke in
  // an input (which updates the simulation) would move the cursor out of it.
  useEffect(() => { if (open) closeRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = e => { if (e.key === 'Escape') (drawer ? setDrawer(null) : close()); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close, drawer]);

  const viewName = useMemo(() => {
    const row = cruise.comparison?.rows.find(r => r.id === cruise.viewId);
    return !row || row.id === 'baseline' ? 'Existing parking' : row.name;
  }, [cruise.comparison, cruise.viewId]);
  if (!open) return null;
  const c = { ...cruise, viewName };
  const ready = Boolean(cruise.current && cruise.dvc);
  const step = cruise.step;
  const focusValue = `${cruise.focus.kind}:${cruise.focus.id ?? ''}`;
  const setFocusValue = v => {
    if (v === 'AUTO') return cruise.setFocus(null);
    const [kind, id] = v.split(':');
    cruise.setFocus(kind === FOCUS.ALL ? { kind } : { kind, id });
  };

  if (minimised) {
    const s = cruise.dvc?.series[cruise.timeIndex];
    return (
      <div className="cd-mapbar" role="region" aria-label="Cruise Parking Simulation, minimised">
        <div>
          <b>{cruise.dvc?.label} · {viewName} · {cruise.atTime?.time}</b>
          <span>{s ? (cruise.dvc.missingAssignment ? `${fmt(s.unallocated)} cars with no garage assigned` : `${fmt(s.occupied)} parked of ${fmt(cruise.dvc.capacity)} · ${s.shortage ? `${fmt(s.shortage)} short` : 'no shortage'}`) : ''}</span>
          <span className="cd-maplegend">
            <i style={{ background: UTILISATION_COLOUR.GREEN }} />under {cruise.assumptions.utilisationAmberPct}%
            <i style={{ background: UTILISATION_COLOUR.AMBER }} />{cruise.assumptions.utilisationAmberPct}–{cruise.assumptions.utilisationRedPct}%
            <i style={{ background: UTILISATION_COLOUR.RED }} />over {cruise.assumptions.utilisationRedPct}%
          </span>
          {(cruise.undrawn.facilities.length > 0) && <small>Not drawn (no confirmed footprint): {cruise.undrawn.facilities.join(', ')}</small>}
        </div>
        <button type="button" className="cw-btn is-primary" onClick={() => cruise.setMapMode(false)}>Back to simulation</button>
      </div>
    );
  }

  return (
    <>
      <div className="cw-backdrop" onClick={close} />
      <div className="cw-shell cd-shell" role="dialog" aria-modal="true" aria-labelledby="cw-title">
        <header className="cw-header">
          <div className="cw-title">
            <h2 id="cw-title">Cruise Parking Simulation</h2>
          </div>
          <label className="cw-control">Date
            <select value={cruise.date} onChange={e => cruise.setDate(e.target.value)} aria-label="Simulation date">
              {cruise.daysWithCalls.map(d => <option key={d.date} value={d.date}>{dayLabel(d.date)} · {d.simulable} of {d.calls} modelled</option>)}
            </select>
          </label>
          <div className="cw-control">Demand profile
            <div className="cw-seg" role="group" aria-label="Demand profile">
              {Object.entries(DEMAND_PROFILES).map(([id, p]) => (
                <button key={id} type="button" aria-pressed={cruise.profile === id} title={`${p.label}: ${p.description}`} onClick={() => cruise.setProfile(id)}>{p.label}</button>
              ))}
              {cruise.profile === 'CUSTOM' && <span className="cw-custom">Custom</span>}
            </div>
          </div>
          <label className="cw-control">Garage or terminal
            <select value={cruise.focusIsAuto ? 'AUTO' : focusValue} onChange={e => setFocusValue(e.target.value)} aria-label="Garage or terminal">
              <option value="AUTO">{cruise.focusFollowsCruise ? `${cruise.dvc?.label ?? '—'} (cruise)` : `Most affected garage${cruise.focusIsAuto ? ` (${cruise.dvc?.label ?? '—'})` : ''}`}</option>
              <option value={`${FOCUS.ALL}:`}>All mapped garages</option>
              <optgroup label="Garages">
                {cruise.focusOptions.garages.map(g => <option key={g.id} value={`${FOCUS.GARAGE}:${g.id}`}>{g.name}{Number.isFinite(g.capacity) ? ` · ${fmt(g.capacity)}` : ' · capacity unknown'}</option>)}
              </optgroup>
              <optgroup label="Terminals with a call today">
                {cruise.focusOptions.terminals.map(t => <option key={t.code} value={`${FOCUS.TERMINAL}:${t.code}`}>Terminal {t.code}{t.garages.length ? ` · ${t.garages.join(', ')}` : ' · no garage assigned'}</option>)}
              </optgroup>
            </select>
          </label>
          <label className="cw-control">Design
            <select value={cruise.viewId} onChange={e => cruise.setViewId(e.target.value)} aria-label="Parking design">
              {(cruise.comparison?.rows ?? [{ id: 'baseline', name: 'Existing' }]).map(r => <option key={r.id} value={r.id}>{r.id === 'baseline' ? 'Existing parking' : r.name}</option>)}
            </select>
          </label>
          <button type="button" className="cw-btn" onClick={() => setDrawer(drawer ? null : 'DATA')} aria-expanded={Boolean(drawer)}>Data &amp; Assumptions</button>
          <button type="button" ref={closeRef} className="cw-close" onClick={close} aria-label="Close the Cruise Parking Simulation">✕ Close</button>
        </header>

        <nav className="cw-steps" role="tablist" aria-label="Simulation views">
          {TABS.map(([id, n, label]) => (
            <button key={id} type="button" role="tab" aria-selected={step === id} onClick={() => cruise.setStep(id)}>
              <span className="cw-stepnum">{n}</span>{label}
            </button>
          ))}
        </nav>


        <div className="cd-body">
          {!ready ? (
            <div className="cd-empty">
              <p className="cw-empty">{cruise.data.state === 'LOADING' ? 'Loading the November Dock Report…'
                : cruise.data.state === 'FAILED' ? `The cruise data could not be loaded: ${cruise.data.error}`
                  : 'The simulation cannot run with the current assumptions:'}</p>
              {cruise.data.state === 'READY' && !drawer && <><AssumptionsPanel cruise={c} /><MappingEditor cruise={c} /></>}
              {cruise.data.state === 'READY' && drawer && <p className="cw-note">Correct the highlighted values in the Data &amp; Assumptions panel.</p>}
            </div>
          ) : (
            <>
              {step === WORKSPACE_STEP.ACTIVITY && <ActivityTab cruise={c} />}
              {step === WORKSPACE_STEP.TURNOVER && <TurnoverTab cruise={c} />}
              {step === WORKSPACE_STEP.TIME && <TimeTab cruise={c} onDetails={setDrawer} setSlot={setSlot} details={garageDetails} setDetails={setGarageDetails} onCompare={() => cruise.setStep(WORKSPACE_STEP.COMPARE)} />}
              {step === WORKSPACE_STEP.COMPARE && <CompareTab cruise={c} onMap={id => cruise.viewOnMap(id)} onEdit={id => { setEditing(id); cruise.setViewId(id); }} />}
              {step === WORKSPACE_STEP.COMPARE && editing && <EditPanel cruise={c} id={editing} onClose={() => setEditing(null)} />}
            </>
          )}
          {docked && <DockedMapControls host={mapRef?.current} handlers={cameraHandlers} onFocus={() => focusMap(onLocateAsset)} label={cruise.dvc?.label ?? 'garage'} />}
          {cruise.data.state === 'READY' && drawer && <Drawer cruise={c} tab={drawer} setTab={setDrawer} onClose={() => setDrawer(null)} section={section} />}
        </div>
      </div>
    </>
  );
}

