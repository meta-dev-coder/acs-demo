/**
 * The detailed panels of the Cruise Parking Simulation, kept for audit behind "Data & Assumptions"
 * and "Calculation Details" in the workspace (CruiseWorkspace.jsx): the full cruise list with
 * capacity sources, the per-cruise passenger → car arithmetic, every assumption, the terminal →
 * garage mapping, the garage table, the selected cruise against its garages, and the 15-minute
 * calculation inspector. Every figure comes from `useCruiseDemand`; nothing here computes demand.
 */
import { useEffect, useLayoutEffect, useState } from 'react';
import {
  CRUISE_ASSUMPTIONS, EDIT_SCOPE, MODE_SHARE_KEYS, PROPOSED_SCOPE, RETURNING_COHORT_POLICY, RETURNING_COHORT_POLICY_LABEL,
  SOURCE_KIND, SOURCE_KIND_LABEL, VOYAGE_POLICY, VOYAGE_POLICY_LABEL, assumptionSourceKind, sideOfKey,
} from '../cruise/cruiseAssumptions.js';
import { utcMsToLocal } from '../cruise/cruiseCalls.js';
import { CAPACITY_STATUS_LABEL, CAPACITY_TYPE_LABEL } from '../cruise/vesselMaster.js';
import { utilisationColour } from '../cesium/cruiseParkingLayer.js';
import { ALLOCATION_POLICY_LABEL, MAPPING_SOURCE_LABEL } from '../cruise/parkingAllocation.js';
import { PARKING_OUTCOME_LABEL } from '../cruise/simulationInsight.js';

const fmt = v => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');
const pct = v => (Number.isFinite(v) ? `${Math.round(v)}%` : '—');
const dayLabel = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const local = iso => (iso ? iso.slice(11, 16) : '—');
const clock = ms => utcMsToLocal(ms).time;
const shortDate = ms => new Date(`${utcMsToLocal(ms).date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const otherDay = (iso, date) => (iso && iso.slice(0, 10) !== date ? ` (${new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })})` : '');

// ---- small shared pieces ------------------------------------------------------------------------------

/** Where a figure comes from: reported, published, assumption, configured, modelled or calculated. */
export function Src({ kind }) {
  return <span className={`cw-src is-${String(kind).toLowerCase()}`} title={SOURCE_KIND_LABEL[kind]}>{SOURCE_KIND_LABEL[kind]}</span>;
}

export function SourceKey() {
  return (
    <p className="cw-srckey">
      {[SOURCE_KIND.REPORTED, SOURCE_KIND.PUBLISHED, SOURCE_KIND.ASSUMED, SOURCE_KIND.MODELLED, SOURCE_KIND.CALCULATED].map(k => <Src key={k} kind={k} />)}
    </p>
  );
}

/** Width of an element, for charts drawn in real pixels. */
export function useWidth(ref) {
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

// ---- the calculation inspector (reusable) --------------------------------------------------------------

/** One cohort's passenger → vehicle arithmetic, as Input / Formula / Output / Source rows. */
export function CalcSteps({ calc }) {
  if (!calc) return null;
  return (
    <div className="cw-calc">
      {calc.steps.map(step => (
        <table key={step.title} className="cw-calc-table">
          <caption>{step.title}</caption>
          <tbody>
            {step.inputs.map(i => (
              <tr key={i.label} title={i.note}>
                <th scope="row">{i.label}</th>
                <td>{typeof i.value === 'number' ? (Number.isInteger(i.value) ? fmt(i.value) : i.value) : i.value ?? '—'} <span className="cw-unit">{i.unit}</span></td>
                <td><Src kind={i.source} /></td>
              </tr>
            ))}
            <tr className="cw-calc-formula"><th scope="row">Formula</th><td colSpan="2"><code>{step.formula}</code></td></tr>
            <tr className="cw-calc-out"><th scope="row">Output</th><td><b>{fmt(step.output.value)}</b> <span className="cw-unit">{step.output.unit}</span></td><td><Src kind={step.output.source} /></td></tr>
          </tbody>
        </table>
      ))}
      {calc.timing.map(t => (
        <p key={t.kind} className="cw-calc-note"><b>{t.title}:</b> {t.text} <Src kind={t.source} /></p>
      ))}
      <p className="cw-calc-note"><b>{calc.kind === 'ESTIMATED_RETURN' ? 'Where these cars come from' : 'Return'}:</b> {calc.basis.text} <Src kind={calc.basis.source} /></p>
      {!calc.check && <p className="scenario-error">This restatement does not match the simulated cohort — please report it.</p>}
    </div>
  );
}

/**
 * Drill-down for one 15-minute interval:
 * total occupancy → a facility → a cruise's contribution → its passenger and vehicle arithmetic →
 * the share of its window that fell in this interval and where those cars went.
 */
export function CalculationInspector({ inspection, onClose }) {
  const [path, setPath] = useState({ facilityId: null, cohortId: null });
  useEffect(() => { setPath({ facilityId: null, cohortId: null }); }, [inspection?.index]);
  if (!inspection) return null;
  const { totals, equation } = inspection;
  const facility = inspection.facilities.find(f => f.id === path.facilityId) ?? null;
  const entry = path.cohortId ? inspection.cohorts.find(c => c.cohort.id === path.cohortId) : null;
  const crumbs = [
    ['Total occupancy', () => setPath({ facilityId: null, cohortId: null })],
    ...(facility ? [[facility.name, () => setPath({ facilityId: facility.id, cohortId: null })]] : []),
    ...(entry ? [[entry.cohort.shipName, null]] : []),
  ];
  return (
    <section className="cw-inspector" aria-label="How was this calculated?">
      <header>
        <h3>How was this calculated? <span>{inspection.time}–{inspection.endTime}</span></h3>
        <button type="button" className="cw-icon" onClick={onClose} aria-label="Close the calculation">×</button>
      </header>
      <nav className="cw-crumbs" aria-label="Drill-down">
        {crumbs.map(([label, go], i) => (
          <span key={label}>{i > 0 && ' › '}{go && i < crumbs.length - 1 ? <button type="button" onClick={go}>{label}</button> : <b>{label}</b>}</span>
        ))}
      </nav>

      {!facility && !entry && (
        <>
          <p className="cw-eq">
            Ending occupancy = Starting occupancy + Served entries − Exits<br />
            <b>{fmt(equation.end)}</b> = {fmt(equation.start)} + {fmt(equation.served)} − {fmt(equation.exits)}
            <span className={equation.ok ? 'cw-ok' : 'cw-bad'}>{equation.ok ? ' ✓ balances' : ' ✗ does not balance'}</span>
          </p>
          <table className="cw-table">
            <thead><tr><th>Facility</th><th>Start</th><th>Cars in</th><th>Cars out</th><th>End</th><th>Capacity</th><th>Turned away</th></tr></thead>
            <tbody>
              {inspection.facilities.map(f => (
                <tr key={f.id} className="is-link" onClick={() => setPath({ facilityId: f.id, cohortId: null })}>
                  <td><button type="button" className="cw-linkbtn">{f.name}</button>{f.addedSpaces > 0 && <span className="cw-tag">+{fmt(f.addedSpaces)}</span>}</td>
                  <td>{fmt(f.start)}</td><td>{f.served ? `+${fmt(f.served)}` : '0'}</td><td>{f.exits ? `−${fmt(f.exits)}` : '0'}</td>
                  <td><b>{fmt(f.end)}</b></td><td>{Number.isFinite(f.capacity) ? fmt(f.capacity) : 'not published'}</td><td>{fmt(f.unserved)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><th>Total</th><td>{fmt(totals.start)}</td><td>+{fmt(totals.served)}</td><td>−{fmt(totals.exits)}</td><td><b>{fmt(totals.end)}</b></td><td>{fmt(totals.capacity)}</td><td>{fmt(totals.unserved)}</td></tr></tfoot>
          </table>
          <p className="cw-hint">Start and end are modelled cars parked; cars in and out are the movements of this 15 minutes. Choose a facility to see which cruises moved them.</p>
        </>
      )}

      {facility && !entry && (
        <>
          <p className="cw-eq">
            {facility.name}: <b>{fmt(facility.end)}</b> = {fmt(facility.start)} + {fmt(facility.served)} − {fmt(facility.exits)}
            {Number.isFinite(facility.capacity) && <> · {fmt(facility.remaining)} of {fmt(facility.capacity)} free ({pct(facility.utilisationPct)} used)</>}
          </p>
          {facility.moves.length === 0 ? <p className="cw-empty">No cruise moved a car here in this interval.</p> : (
            <table className="cw-table">
              <thead><tr><th>Cruise</th><th>Movement</th><th>Cars</th></tr></thead>
              <tbody>
                {facility.moves.map((m, i) => {
                  const c = inspection.cohorts.find(x => x.cohort.id === m.cohortId);
                  return (
                    <tr key={i} className="is-link" onClick={() => setPath({ facilityId: facility.id, cohortId: m.cohortId })}>
                      <td><button type="button" className="cw-linkbtn">{c.cohort.shipName}</button>{c.cohort.kind === 'ESTIMATED_RETURN' && <span className="cw-tag is-est">estimate</span>}</td>
                      <td>{{ OUT: 'Leaving after disembarkation', IN: 'Parking for departure', OVERFLOW: 'Parking (overflow)', UNSERVED: 'Turned away — no space' }[m.type] ?? m.type}</td>
                      <td>{m.type === 'OUT' ? '−' : m.type === 'UNSERVED' ? '' : '+'}{fmt(m.n)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}

      {entry && (
        <>
          <h4 className="cw-sub">Cruise contribution · {entry.cohort.shipName} · Terminal {entry.cohort.terminalCode}</h4>
          <CalcSteps calc={entry.calc} />
          <h4 className="cw-sub">15-minute allocation</h4>
          {entry.entry && (
            <table className="cw-calc-table">
              <tbody>
                <tr><th scope="row">Parking window</th><td>{entry.calc.timing.find(t => t.kind === 'ENTRY')?.text}</td><td><Src kind={SOURCE_KIND.ASSUMED} /></td></tr>
                <tr><th scope="row">Share of window in {inspection.time}–{inspection.endTime}</th><td>{entry.entry.weightPct.toFixed(2)}% of {fmt(entry.cohort.vehicles)} = {entry.entry.exact.toFixed(2)} → <b>{fmt(entry.entry.vehicles)} cars</b> (whole cars, largest remainder)</td><td><Src kind={SOURCE_KIND.MODELLED} /></td></tr>
                <tr><th scope="row">Terminal {entry.cohort.terminalCode} allocation</th><td>{entry.entry.allocation.map(r => `${r.name} ${r.sharePct}%`).join(' · ') || 'No facility linked'}</td><td><Src kind={SOURCE_KIND.CONFIGURED} /></td></tr>
                {entry.entry.placed.map((m, i) => (
                  <tr key={i}><th scope="row">{{ IN: 'Parked at', OVERFLOW: 'Overflow to', UNSERVED: 'No space at', UNALLOCATED: 'Unallocated' }[m.type]}</th><td>{m.name ?? '—'}: <b>{fmt(m.n)}</b></td><td><Src kind={SOURCE_KIND.MODELLED} /></td></tr>
                ))}
              </tbody>
            </table>
          )}
          {entry.exit && (
            <table className="cw-calc-table">
              <tbody>
                <tr><th scope="row">Exit window</th><td>{entry.calc.timing.find(t => t.kind === 'EXIT')?.text}</td><td><Src kind={SOURCE_KIND.ASSUMED} /></td></tr>
                {entry.exit.map(x => (
                  <tr key={x.facilityId}><th scope="row">{x.name}</th><td>{x.weightPct.toFixed(2)}% of the {fmt(x.parked)} cars parked here = {x.exact.toFixed(2)} → <b>{fmt(x.vehicles)} leave</b></td><td><Src kind={SOURCE_KIND.MODELLED} /></td></tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

// ---- charts -------------------------------------------------------------------------------------------

/**
 * Tick positions for 00:00, 06:00, 12:00, 18:00 and 24:00, read from the timeline's own local times
 * — on November 1 the clocks go back and the day has 100 intervals, not 96.
 */
export const hourTicks = timeline => [0, 6, 12, 18].map(h => ({ h, i: Math.max(0, timeline.findIndex(t => t.time === `${String(h).padStart(2, '0')}:00`)) }))
  .concat({ h: 24, i: timeline.length });


const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; } };

/** Capacity with its definition: validated figures plainly, others greyed with why they are not used. */
export function CapacityCell({ call }) {
  if (call.passengerCapacity) {
    return <>{fmt(call.passengerCapacity)} <span className="cw-captype">{CAPACITY_TYPE_LABEL[call.capacityType] ?? 'validated'}</span></>;
  }
  if (call.publishedCapacity) {
    return <span className="cw-missing" title={CAPACITY_STATUS_LABEL[call.capacityStatus]}>{fmt(call.publishedCapacity)} <span className="cw-captype is-warn">{CAPACITY_TYPE_LABEL[call.capacityType] ?? '?'}</span></span>;
  }
  return <span className="cw-missing">{CAPACITY_STATUS_LABEL[call.capacityStatus] ?? CAPACITY_STATUS_LABEL.NOT_YET_SOURCED}</span>;
}

/** Where the capacity comes from: the source's host, linked, with its title. */
export function CapacitySource({ call }) {
  const src = call.passengerCapacitySource;
  if (!src) return <span className="cw-missing">—</span>;
  const host = hostOf(src.url);
  const label = host ?? src.title ?? 'source';
  return src.url
    ? <a href={src.url} target="_blank" rel="noreferrer" title={`${src.title ?? ''}${src.source_date ? ` · ${src.source_date}` : ''} · checked ${src.verified_on ?? '—'}`}>{label}</a>
    : <span title={src.title ?? ''}>{label}</span>;
}

export function CompletenessTag({ level, label }) {
  return <span className={`cw-complete is-${level.toLowerCase()}`}>{label}</span>;
}

export function CruiseTable({ cruise }) {
  const rows = cruise.cruises;
  if (!rows.length) return <p className="cw-empty">No vessel calls are in the Dock Report for {dayLabel(cruise.date)}. Choose another date above.</p>;
  return (
    <table className="cw-table cw-cruises">
      <thead>
        <tr>
          <th>Ship</th><th>Cruise line</th><th>Terminal</th><th>Arrives</th><th>Departs</th>
          <th title="The ship's published passenger capacity — not the number of passengers on board">Passenger capacity*</th>
          <th>Capacity source</th>
          <th title="Modelled cars leaving after this ship's passengers disembark">Cars leaving</th>
          <th title="Modelled cars parking for this ship's departing voyage">Cars parking</th>
          <th>Data</th>
        </tr>
      </thead>
      <tbody>
        <tr aria-selected={!cruise.selectedCallId} className="is-link cw-allrow" onClick={() => cruise.setSelectedCallId(null)}>
          <td colSpan="7"><b>All cruises</b> · {rows.length} call{rows.length === 1 ? '' : 's'}, {rows.filter(r => r.call.passengerCapacity).length} modelled</td>
          <td>≈ {fmt(rows.reduce((t, r) => t + (r.leavingVehicles ?? 0), 0))}</td>
          <td>≈ {fmt(rows.reduce((t, r) => t + (r.enteringVehicles ?? 0), 0))}</td>
          <td />
        </tr>
        {rows.map(r => (
          <tr key={r.call.id} aria-selected={cruise.selectedCallId === r.call.id}
            className={`is-link${r.call.passengerCapacity ? '' : ' is-excluded'}`}
            onClick={() => cruise.setSelectedCallId(cruise.selectedCallId === r.call.id ? null : r.call.id)}>
            <td><b>{r.call.shipName}</b></td>
            <td>{r.call.cruiseLine ?? <span className="cw-missing" title="No cruise line is given for this call in the Dock Report file">—</span>}</td>
            <td>{r.call.terminalCode}</td>
            <td>{local(r.call.arrivalLocal)}{otherDay(r.call.arrivalLocal, cruise.date)}</td>
            <td>{local(r.call.departureLocal)}{otherDay(r.call.departureLocal, cruise.date)}</td>
            <td><CapacityCell call={r.call} /></td>
            <td><CapacitySource call={r.call} /></td>
            <td>{r.leavingVehicles === null ? '—' : <>≈ {fmt(r.leavingVehicles)}{r.returningSource.kind === 'ESTIMATED'
              ? <span className="cw-tag is-est">estimate</span>
              : <span className="cw-tag" title={r.returningSource.label}>stored {shortDate(r.returning.entryEndMs)}</span>}</>}</td>
            <td>{r.enteringVehicles === null ? '—' : `≈ ${fmt(r.enteringVehicles)}`}</td>
            <td><CompletenessTag {...r.completeness} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CruiseDetail({ cruise }) {
  const r = cruise.cruises.find(x => x.call.id === cruise.selectedCallId);
  if (!r) {
    const rows = cruise.cruises;
    const modelled = rows.filter(x => x.call.passengerCapacity);
    return (
      <>
        <h3 className="cw-h">{dayLabel(cruise.date)} at a glance</h3>
        <dl className="cw-kpis">
          <div><dt>Vessel calls</dt><dd>{rows.length}</dd><Src kind={SOURCE_KIND.REPORTED} /></div>
          <div><dt>Modelled (capacity published)</dt><dd>{modelled.length}</dd><Src kind={SOURCE_KIND.PUBLISHED} /></div>
          <div><dt>Cars leaving</dt><dd>≈ {fmt(cruise.current?.exits)}</dd><Src kind={SOURCE_KIND.MODELLED} /></div>
          <div><dt>Cars parking</dt><dd>≈ {fmt(cruise.current?.entries)}</dd><Src kind={SOURCE_KIND.MODELLED} /></div>
        </dl>
        <p className="cw-note">Choose a cruise in the table to see its reported times, published capacity and the parking calculation behind its numbers.</p>
        {rows.length > modelled.length && (
          <p className="cw-note"><b>Not modelled:</b> {rows.filter(x => !x.call.passengerCapacity).map(x => `${x.call.shipName} (${x.call.terminalCode})`).join(', ')} — their passenger capacity is not yet validated, so no parking demand is estimated for them. Demand shown is therefore a floor.</p>
        )}
        <p className="cw-note">* Passenger capacity is the ship's published berth count, not a count of the passengers actually sailing.</p>
      </>
    );
  }
  const { call } = r;
  const drawn = !cruise.undrawn.terminals.includes(call.terminalCode);
  return (
    <>
      <h3 className="cw-h">{call.shipName} <span>{call.cruiseLine ?? ''}</span></h3>
      <dl className="cw-facts">
        <div><dt>Terminal</dt><dd>{call.terminalCode}</dd><Src kind={SOURCE_KIND.REPORTED} /></div>
        <div><dt>Arrives</dt><dd>{call.arrivalLocal.replace('T', ' ').slice(0, 16)}</dd><Src kind={SOURCE_KIND.REPORTED} /></div>
        <div><dt>Departs</dt><dd>{call.departureLocal.replace('T', ' ').slice(0, 16)}</dd><Src kind={SOURCE_KIND.REPORTED} /></div>
        <div><dt>Passenger capacity</dt><dd><CapacityCell call={call} /></dd><Src kind={SOURCE_KIND.PUBLISHED} /></div>
        <div><dt>Capacity source</dt><dd><CapacitySource call={call} />{call.passengerCapacitySource?.source_date ? ` · ${call.passengerCapacitySource.source_date}` : ''}</dd></div>
        <div><dt>Capacity status</dt><dd>{CAPACITY_STATUS_LABEL[call.capacityStatus] ?? '—'}</dd></div>
        <div><dt>IMO</dt><dd>{call.vesselImo ?? <span className="cw-missing">not identified</span>}</dd></div>
        <div><dt>Dock request</dt><dd>{call.dockRequestNumber ?? '—'}</dd><Src kind={SOURCE_KIND.REPORTED} /></div>
        <div><dt>Data completeness</dt><dd><CompletenessTag {...r.completeness} /></dd></div>
      </dl>
      {call.voyageOptions?.length > 0 && (
        <p className="cw-note"><b>Itinerary options:</b> {call.voyageOptions.map(o => `${o.nights ?? '?'} nights${o.name ? ` (${o.name})` : ''}${o.returnsToMiami ? `, returns ${o.scheduledReturnDate ?? '?'}` : `, ends in ${o.endsIn ?? 'another port'}`}`).join(' · ')}</p>
      )}
      {!drawn && <p className="cw-note is-warn">Terminal {call.terminalCode} has no confirmed footprint in the twin, so it is not highlighted on the map. Its activity is shown in the tables and charts.</p>}
      {r.skipped && <p className="cw-note is-warn">{r.skipped.reason}</p>}
      {!call.passengerCapacity && (
        <p className="cw-note is-warn">
          {CAPACITY_STATUS_LABEL[call.capacityStatus] ?? CAPACITY_STATUS_LABEL.NOT_YET_SOURCED}
          {call.publishedCapacity && call.capacityStatus === 'DEFINITION_NOT_COMPARABLE' ? ` (${fmt(call.publishedCapacity)}, ${CAPACITY_TYPE_LABEL[call.capacityType]?.toLowerCase()}). The occupancy assumptions are percentages of double-occupancy capacity, so this figure is not used.` : '.'}
          {' '}No parking demand is modelled for this call.
        </p>
      )}
      {r.returningCalc && (
        <details className="cw-fold" open>
          <summary>Returning passengers · ≈ {fmt(r.leavingVehicles)} cars leave · {r.returningSource.kind === 'RECONSTRUCTED' ? 'reconstructed cohort' : 'estimate'}</summary>
          {r.returningSource.kind === 'RECONSTRUCTED' ? (
            <p className="cw-note">{r.returningSource.label} (dock request {r.returningSource.originDockRequest ?? '—'}). The {fmt(r.returningCohortVehicles)} cars were counted when they parked, with that date's departing assumptions, and are carried — not recalculated from today's values <Src kind={SOURCE_KIND.MODELLED} />.</p>
          ) : (
            <p className="cw-note">No departure in the report accounts for these cars: they are estimated from the returning assumptions for {dayLabel(cruise.date)} <Src kind={SOURCE_KIND.ASSUMED} />.</p>
          )}
          {r.returningWithoutSpace > 0 && <p className="cw-note is-warn">{fmt(r.returningWithoutSpace)} of the cohort's {fmt(r.returningCohortVehicles)} cars found no space when they arrived, so only {fmt(r.leavingVehicles)} leave a garage.</p>}
          <CalcSteps calc={r.returningCalc} />
        </details>
      )}
      {r.departingCalc && (
        <details className="cw-fold" open>
          <summary>Departing passengers · ≈ {fmt(r.enteringVehicles)} cars park</summary>
          <CalcSteps calc={r.departingCalc} />
        </details>
      )}
    </>
  );
}

// ---- step 2: turnover ---------------------------------------------------------------------------------

export function FlowDiagram({ title, steps, tone }) {
  return (
    <figure className={`cw-flow is-${tone}`}>
      <figcaption>{title}</figcaption>
      <ol>{steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
    </figure>
  );
}

/**
 * One row per flow per cruise, showing the inputs the ENGINE used for that cohort (its stored
 * `inputs`), not the current panel values. A returning row for cars parked by an earlier departure
 * shows that departure's date and values, marked as a reconstructed cohort.
 */
export function TurnoverTable({ cruise }) {
  const [open, setOpen] = useState(() => new Set());
  const rows = cruise.cruises.filter(r => r.returningCalc || r.departingCalc);
  if (!rows.length) return <p className="cw-empty">No modelled cruise moves cars on {dayLabel(cruise.date)}.</p>;
  const toggle = id => setOpen(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const line = (r, calc, flow) => {
    const id = `${r.call.id}-${flow}`;
    const x = calc.inputs;
    const returning = flow === 'RETURNING';
    const reconstructed = returning && r.returningSource?.kind === 'RECONSTRUCTED';
    const edited = k => x.editedForDate.includes(`${x.side}${k}`);
    const cell = (v, k) => <span className={edited(k) ? 'cw-edited' : undefined} title={edited(k) ? `Edited for ${x.assumptionDate} only` : undefined}>{v}</span>;
    const window = calc.timing.find(t => t.kind === (returning ? 'EXIT' : 'ENTRY'));
    return [
      <tr key={id} className={`cw-flowrow is-${returning ? 'returning' : 'departing'}${reconstructed ? ' is-reconstructed' : ''}`}>
        <td>
          <button type="button" className="cw-expander" aria-expanded={open.has(id)} aria-label={`Calculation details: ${r.call.shipName} ${returning ? 'returning' : 'departing'}`} onClick={() => toggle(id)}>{open.has(id) ? '▾' : '▸'}</button>
          <b>{r.call.shipName}</b>
        </td>
        <td>{r.call.terminalCode}</td>
        <td className={returning ? 'cw-out' : 'cw-in'}>{returning ? '↓ Returning' : '↑ Departing'}</td>
        <td>{fmt(x.capacity)}</td>
        <td>{cell(`${x.occupancyPct}%`, 'OccupancyPct')}</td>
        <td>{fmt(x.passengers)}</td>
        <td>{cell(`${x.longStayPct}%`, 'LongStayPct')}</td>
        <td>{cell(x.passengersPerVehicle, 'PassengersPerVehicle')}</td>
        <td><b>{fmt(x.vehicles)}</b>{returning && r.returningWithoutSpace > 0 && <span className="cw-tag is-est" title="Cars of this cohort that found no space when they arrived">{fmt(r.returningWithoutSpace)} had no space</span>}</td>
        <td>
          {!returning && <span className="cw-source is-estimate">Estimate · departing assumptions of {shortDate(r.departing.entryEndMs)}</span>}
          {returning && reconstructed && <span className="cw-source is-reconstructed" title={`Dock request ${r.returningSource.originDockRequest ?? '—'}`}>Reconstructed cohort · stored when {r.returning.shipName} departed {shortDate(r.returning.entryEndMs)} (request {r.returningSource.originDockRequest ?? '—'})</span>}
          {returning && !reconstructed && <span className="cw-source is-estimate">Estimate · returning assumptions of {shortDate(r.call.arrivalMs)}</span>}
        </td>
        <td className="cw-dim">{window ? `${clock(window.startMs)}–${clock(window.endMs)}${shortDate(window.startMs) !== dayLabel(cruise.date).slice(5) ? ` ${shortDate(window.startMs)}` : ''}` : 'after Nov 30'}</td>
      </tr>,
      open.has(id) && (
        <tr key={`${id}-details`} className={`cw-detailrow is-${returning ? 'returning' : 'departing'}`}>
          <td colSpan="11">
            <h4 className="cw-sub">Calculation details</h4>
            {reconstructed && <p className="cw-note">These cars were counted when they parked for the {shortDate(r.returning.entryEndMs)} departure, with that date's departing assumptions. The count is carried, not recalculated: changing assumptions for {dayLabel(cruise.date)} does not change it.</p>}
            {returning && !reconstructed && <p className="cw-note">No departure in the report accounts for these cars, so they are estimated from the returning assumptions in force on the arrival date.</p>}
            <CalcSteps calc={calc} />
          </td>
        </tr>
      ),
    ];
  };
  return (
    <table className="cw-table cw-turnover">
      <thead>
        <tr>
          <th>Cruise</th><th>Terminal</th><th>Flow</th><th>Capacity</th><th>Occupancy</th><th>Passengers</th>
          <th>Long-stay share</th><th>Per car</th><th>Parked cars</th><th>Calculation source</th><th>Window</th>
        </tr>
      </thead>
      <tbody>
        {rows.flatMap(r => [
          ...(r.returningCalc ? line(r, r.returningCalc, 'RETURNING') : []),
          ...(r.departingCalc ? line(r, r.departingCalc, 'DEPARTING') : []),
        ]).filter(Boolean)}
      </tbody>
    </table>
  );
}

function AssumptionField({ cruise, k }) {
  const spec = CRUISE_ASSUMPTIONS[k];
  const a = cruise.assumptions;
  const forDate = k in cruise.dateEdits;
  const bad = cruise.assumptionIssues.some(i => i.keys.includes(k) && (!i.date || i.date === cruise.date));
  const monthValue = cruise.monthAssumptions[k];
  return (
    <label className={`cw-field${bad ? ' is-invalid' : ''}`} title={spec.basis}>
      <span>{spec.label}</span>
      <span className="cw-field-input">
        <input type="number" step="any" value={a[k]} aria-invalid={bad || undefined} aria-label={`${sideOfKey(k) ?? ''} ${spec.label}`.trim()}
          onChange={e => cruise.setAssumption(k, e.target.value === '' ? '' : Number(e.target.value))} />
        <em>{spec.unit}</em>
      </span>
      <span className="cw-field-src">
        {forDate
          ? <button type="button" className="cw-src is-configured" title={`Edited for ${cruise.date} only. Click to use the November value (${monthValue}).`} onClick={e => { e.preventDefault(); cruise.clearDateAssumption(k); }}>{dayLabel(cruise.date).slice(5)} only ✕</button>
          : Number(a[k]) !== spec.value && cruise.profile === 'CUSTOM' ? <span className="cw-src is-configured">Edited</span> : <Src kind={assumptionSourceKind(k)} />}
      </span>
      <small>{spec.basis}</small>
    </label>
  );
}

/** One side's mode shares, with their total checked against 100%. */
function ModeShares({ cruise, who }) {
  const keys = MODE_SHARE_KEYS[who];
  const total = keys.reduce((t, k) => t + Number(cruise.assumptions[k] || 0), 0);
  const ok = Math.abs(total - 100) < 0.001;
  return (
    <fieldset className={`cw-group cw-modes${ok ? '' : ' is-invalid'}`}>
      <legend>{who === 'departing' ? 'Departing' : 'Returning'} mode shares <span className="cw-dim">— a distribution: must total 100%</span></legend>
      {keys.map(k => <AssumptionField key={k} cruise={cruise} k={k} />)}
      <p className={`cw-total ${ok ? 'cw-ok' : 'cw-bad'}`}>Total {Math.round(total * 100) / 100}% {ok ? '✓' : '— must be exactly 100%'}</p>
      <p className="cw-note">Only long-stay parking occupies a garage space. The other modes are short-stay or no-car trips and are not added to garage occupancy.</p>
    </fieldset>
  );
}

export function AssumptionsPanel({ cruise }) {
  const a = cruise.assumptions;
  const group = (title, keys, note) => (
    <fieldset className="cw-group">
      <legend>{title}</legend>
      {note && <p className="cw-note">{note}</p>}
      {keys.map(k => <AssumptionField key={k} cruise={cruise} k={k} />)}
    </fieldset>
  );
  return (
    <div className="cw-assumptions">
      <div className="cw-assumptions-head">
        <h3 className="cw-h">Assumptions</h3>
        <button type="button" className="cw-btn" onClick={cruise.resetAssumptions}>Reset all to defaults</button>
      </div>
      <p className="cw-note">Every value is an illustrative planning assumption, not an observation — no passenger counts, mode-share survey or garage transactions were supplied. Departing and returning passengers have separate, independent values.</p>
      <div className="cw-scope" role="group" aria-label="Where edits apply">
        <span>Edits apply to</span>
        <div className="cw-seg">
          <button type="button" aria-pressed={cruise.editScope === EDIT_SCOPE.DATE} onClick={() => cruise.setEditScope(EDIT_SCOPE.DATE)}>{dayLabel(cruise.date)} only</button>
          <button type="button" aria-pressed={cruise.editScope === EDIT_SCOPE.MONTH} onClick={() => cruise.setEditScope(EDIT_SCOPE.MONTH)}>All of November</button>
        </div>
      </div>
      <p className="cw-note">
        {cruise.editScope === EDIT_SCOPE.DATE
          ? `Departing values apply to sailings departing ${dayLabel(cruise.date)}; returning values and the exit window to ships arriving that day. Cars already parked by earlier departures keep the count stored when they parked.`
          : 'Month-wide edits recalculate every November sailing, including cars already parked by earlier departures. Dates with their own edits keep them.'}
      </p>
      {cruise.datesWithEdits.length > 0 && (
        <p className="cw-note">Dates with their own edits: {cruise.datesWithEdits.map(d => (
          <button key={d} type="button" className="cw-chip" title="Remove this date's edits" onClick={() => cruise.clearDate(d)}>{dayLabel(d).slice(5)} ✕</button>
        ))}</p>
      )}
      {Object.keys(cruise.cruiseEdits).length > 0 && (
        <p className="cw-note">Cruises with their own values (set in Demand &amp; Turnover): {Object.entries(cruise.cruiseEdits).map(([callId, edits]) => {
          const call = cruise.data.calls.find(c => c.id === callId);
          return <button key={callId} type="button" className="cw-chip" title="Remove this cruise's own values"
            onClick={() => cruise.resetRow({ callId, date: null, keys: Object.keys(edits) })}>{call ? `${call.shipName} ${dayLabel(call.arrivalDate).slice(5)}` : callId} ✕</button>;
        })}</p>
      )}
      {cruise.overrideAudit.length > 0 && (
        <details className="cd-override">
          <summary>Override audit record ({cruise.overrideAudit.length}) · {Object.keys(cruise.cohortOverrides).length} active</summary>
          <ol className="cd-audit">
            {cruise.overrideAudit.map(a => <li key={`${a.at}-${a.cohortId}-${a.action}`}>{a.at.slice(0, 16).replace('T', ' ')} · {a.ship} · {a.kind === 'RECONCILIATION' ? 'reconciliation' : 'manual estimate'} {a.action === 'SET' ? 'set' : 'removed'} · {a.from ?? '—'} → {a.to ?? '—'} cars · {a.reason}</li>)}
          </ol>
          <p className="cw-note">Overrides are not assumptions: "Reset all to defaults" keeps them. Remove one from its row in Demand &amp; Turnover.</p>
        </details>
      )}
      {cruise.assumptionIssues.map(i => <p key={i.message} className="scenario-error" role="alert">{i.message}</p>)}
      {cruise.allocationErrors.map(e => <p key={e} className="scenario-error">{e}</p>)}
      <div className="cw-sides">
        <div className="cw-side is-departing">
          <h4 className="cw-sidehead">↑ Departing passengers</h4>
          {group('Ship and party', ['departingOccupancyPct', 'departingPassengersPerVehicle'])}
          <ModeShares cruise={cruise} who="departing" />
          {group('Embarkation arrival window', ['entryStartBeforeDepartureMin', 'entryEndBeforeDepartureMin', 'entryPeakFraction'])}
        </div>
        <div className="cw-side is-returning">
          <h4 className="cw-sidehead">↓ Returning passengers</h4>
          <p className="cw-note">Used for estimated returning cars only. Cars from a departure in the report return exactly as they were counted when they parked.</p>
          {group('Ship and party', ['returningOccupancyPct', 'returningPassengersPerVehicle'])}
          <ModeShares cruise={cruise} who="returning" />
          {group('Disembarkation exit window', ['exitStartAfterArrivalMin', 'exitEndAfterArrivalMin', 'exitPeakFraction'], 'Applies to every ship arriving on the date, reconstructed or estimated.')}
        </div>
      </div>
      <fieldset className="cw-group">
        <legend>Initial occupancy and returning cohorts</legend>
        <AssumptionField cruise={cruise} k="backgroundOccupancyPct" />
        <label className="cw-field">
          <span>Returning-cohort estimation</span>
          <select value={a.returningCohortPolicy} onChange={e => cruise.setAssumption('returningCohortPolicy', e.target.value)}>
            {Object.values(RETURNING_COHORT_POLICY).map(p => <option key={p} value={p}>{RETURNING_COHORT_POLICY_LABEL[p]}</option>)}
          </select>
          <span className="cw-field-src"><Src kind={SOURCE_KIND.CONFIGURED} /></span>
          <small>For a ship whose earlier departure is not in the report. Cars parked before November 1 are already in the garage when the simulation starts — occupancy is carried day to day, never reset at midnight.</small>
        </label>
        <label className="cw-field">
          <span>Unknown voyage return</span>
          <select value={a.voyagePolicy} onChange={e => cruise.setAssumption('voyagePolicy', e.target.value)}>
            {Object.values(VOYAGE_POLICY).map(p => <option key={p} value={p}>{VOYAGE_POLICY_LABEL[p]}</option>)}
          </select>
          <span className="cw-field-src"><Src kind={SOURCE_KIND.CONFIGURED} /></span>
          <small>When a departing ship's itinerary does not name a single return to Miami. The same-day arrival and departure is a port call, never a voyage length.</small>
        </label>
        <AssumptionField cruise={cruise} k="assumedVoyageNights" />
        <label className="cw-check"><input type="checkbox" checked={a.oneWayVoyagesPark} onChange={e => cruise.setAssumption('oneWayVoyagesPark', e.target.checked)} /> Passengers on one-way voyages park at Miami</label>
      </fieldset>
      <fieldset className="cw-group">
        <legend>Map colours</legend>
        {['utilisationAmberPct', 'utilisationRedPct'].map(k => <AssumptionField key={k} cruise={cruise} k={k} />)}
      </fieldset>
    </div>
  );
}

// ---- garages: the selected cruise against registered capacity ------------------------------------------------

const OUTCOME_TONE = { ALL: 'ok', PARTIAL: 'warn', NONE: 'bad', ASSIGNMENT_MISSING: 'bad', CAPACITY_DATA_UNAVAILABLE: 'warn', NOT_MODELLED: 'muted', NO_PARKING_DEMAND: 'muted', NOT_USED: 'muted' };

export function OutcomeChip({ outcome }) {
  if (!outcome) return null;
  return <span className={`cw-outcome is-${OUTCOME_TONE[outcome]}`}>{PARKING_OUTCOME_LABEL[outcome]}</span>;
}

export function UtilBar({ pct: value, cruise }) {
  if (!Number.isFinite(value)) return <span className="cw-missing">capacity not published</span>;
  const colour = utilisationColour(value, { amber: cruise.assumptions.utilisationAmberPct, red: cruise.assumptions.utilisationRedPct });
  return (
    <span className="cw-utilbar" title={`${value.toFixed(1)}% occupied`}>
      <span><i style={{ width: `${Math.min(100, value)}%`, background: colour }} /></span>
      <b>{Math.round(value)}%</b>
    </span>
  );
}

/** The cruise selector and the selected cruise in one line, shared by steps 2 and 3. */
export function CruiseStrip({ cruise }) {
  const rows = cruise.cruises;
  const i = cruise.impact;
  return (
    <div className="cw-cruisestrip" role="group" aria-label="Cruise and garage availability">
      <label className="cw-control">Cruise
        <select value={cruise.selectedCallId ?? ''} onChange={e => cruise.setSelectedCallId(e.target.value || null)} aria-label="Selected cruise">
          <option value="">All cruises — port-wide view</option>
          {rows.map(r => (
            <option key={r.call.id} value={r.call.id}>
              {r.call.shipName} · Terminal {r.call.terminalCode} · departs {local(r.call.departureLocal)}{otherDay(r.call.departureLocal, cruise.date)}{r.call.passengerCapacity ? '' : ' — not modelled'}
            </option>
          ))}
        </select>
      </label>
      {i ? (
        <dl className="cw-strip-facts">
          <div><dt>Terminal</dt><dd>{i.terminalCode}</dd></div>
          <div><dt>Time</dt><dd>{cruise.atTime?.time}</dd></div>
          <div><dt>Cars requiring parking</dt><dd className="cw-in">{i.requested ? `≈ ${fmt(i.requested)}` : '—'}<small>{i.windowStart ? ` ${i.windowStart}–${i.windowEnd}` : ''}</small></dd></div>
          <div><dt>Returning cars leaving</dt><dd className="cw-out">{i.returning ? `≈ ${fmt(i.releasing)}` : '—'}</dd></div>
          <div><dt>Garage availability</dt><dd><OutcomeChip outcome={i.outcome} /></dd></div>
        </dl>
      ) : <p className="cw-hint">Choose a cruise to see where its cars park and whether they fit.</p>}
    </div>
  );
}

/** Garage | Capacity | Occupied | Leaving | Entering | Available | Unserved | Utilization, at the selected interval. */
export function GarageTable({ cruise }) {
  const s = cruise.current, at = cruise.atTime;
  const order = new Map((cruise.impact?.garages ?? []).map((g, k) => [g.id, k]));
  const rows = [...s.facilities].sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99)
    || (b.capacity ?? -1) - (a.capacity ?? -1) || a.name.localeCompare(b.name));
  const known = rows.filter(f => Number.isFinite(f.capacity));
  const tot = key => rows.reduce((t, f) => t + (at.facilities[f.id]?.[key] ?? 0), 0);
  const occupiedKnown = known.reduce((t, f) => t + at.facilities[f.id].end, 0);
  return (
    <>
      <table className="cw-table cw-garages">
        <caption>At {at.time}–{cruise.inspection?.endTime} · occupied is cars parked at the end of these 15 minutes{cruise.impact ? ` · garages ${cruise.impact.call.shipName} may use are listed first` : ''}</caption>
        <thead>
          <tr><th>Garage</th><th>Capacity</th><th>Occupied</th><th>Leaving</th><th>Entering</th><th>Available</th><th>Unserved</th><th>Utilization</th></tr>
        </thead>
        <tbody>
          {rows.map(f => {
            const r = at.facilities[f.id];
            const capKnown = Number.isFinite(f.capacity);
            const eligible = order.has(f.id);
            return (
              <tr key={f.id} className={`is-link${eligible ? ' is-eligible' : ''}`} aria-selected={cruise.selectedGarageId === f.id}
                onClick={() => cruise.setSelectedGarageId(cruise.selectedGarageId === f.id ? null : f.id)}>
                <td><b>{f.name}</b>{f.addedSpaces > 0 && <span className="cw-tag">+{fmt(f.addedSpaces)}</span>}{eligible && <span className="cw-tag is-eligible">{cruise.impact.garages[order.get(f.id)].role === 'OVERFLOW' ? 'overflow' : `priority ${cruise.impact.garages[order.get(f.id)].priority}`}</span>}</td>
                <td>{capKnown ? fmt(f.capacity) : <span className="cw-missing">not published</span>}</td>
                <td>{fmt(r.end)}</td>
                <td className={r.exits ? 'cw-out' : undefined}>{r.exits ? `−${fmt(r.exits)}` : '0'}</td>
                <td className={r.served ? 'cw-in' : undefined}>{r.served ? `+${fmt(r.served)}` : '0'}</td>
                <td>{capKnown ? fmt(Math.max(0, f.capacity - r.end)) : '—'}</td>
                <td className={r.unserved ? 'cw-bad' : undefined}>{fmt(r.unserved)}{r.noData ? <span className="cw-tag is-est" title="Cars meant for a garage with no published capacity">{fmt(r.noData)} unchecked</span> : null}</td>
                <td><UtilBar pct={capKnown && f.capacity ? (r.end / f.capacity) * 100 : NaN} cruise={cruise} /></td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th>{rows.length} garages, each counted once</th>
            <td>{fmt(s.capacity)}</td><td>{fmt(tot('end'))}</td><td>−{fmt(tot('exits'))}</td><td>+{fmt(tot('served'))}</td>
            <td>{fmt(Math.max(0, s.capacity - occupiedKnown))}</td><td>{fmt(tot('unserved'))}</td>
            <td><UtilBar pct={s.capacity ? (occupiedKnown / s.capacity) * 100 : NaN} cruise={cruise} /></td>
          </tr>
        </tfoot>
      </table>
      {s.unknownCapacity.length > 0 && <p className="cw-hint">No published capacity: {s.unknownCapacity.join(', ')} — not added to the total, and no car is placed there.</p>}
    </>
  );
}

/** The selected cruise's parking, in six answers and an explanation built from the run. */
export function CruiseImpact({ cruise }) {
  const i = cruise.impact;
  if (!i) {
    const s = cruise.current;
    return (
      <>
        <h3 className="cw-h">Port-wide on {dayLabel(cruise.date)}</h3>
        <dl className="cw-kpis">
          <div><dt>Cars entering today</dt><dd className="cw-in">+{fmt(s.entries)}</dd></div>
          <div><dt>Cars leaving today</dt><dd className="cw-out">−{fmt(s.exits)}</dd></div>
          <div><dt>Cars with no space today</dt><dd className={s.unserved ? 'cw-bad' : undefined}>{fmt(s.unserved)}</dd></div>
          <div><dt>Garages reaching capacity</dt><dd>{s.garagesAtCapacity}</dd></div>
        </dl>
        <p className="cw-note">Choose a cruise above to see which garages its cars may use, how full they are when its cars arrive, and how many fit.</p>
      </>
    );
  }
  if (i.outcome === 'NOT_MODELLED') {
    return <><h3 className="cw-h">{i.call.shipName}</h3><p className="cw-note is-warn">{CAPACITY_STATUS_LABEL[i.call.capacityStatus] ?? 'Passenger capacity not validated'}: no parking demand is modelled for this call. It is not treated as zero demand — it is simply not in the forecast.</p></>;
  }
  const at = cruise.atTime?.time;
  const answer = g => {
    if (!g.now) return '—';
    if (!Number.isFinite(g.capacity)) return PARKING_OUTCOME_LABEL.CAPACITY_DATA_UNAVAILABLE;
    if (!g.now.cruiseRequested) return `No ${i.call.shipName} cars arrive here at ${at}`;
    if (!g.now.cruiseUnserved) return `Yes — all ${fmt(g.now.cruiseAccommodated)} fit`;
    return g.now.cruiseAccommodated ? `Partly — ${fmt(g.now.cruiseAccommodated)} fit, ${fmt(g.now.cruiseUnserved)} do not` : `No — ${fmt(g.now.cruiseUnserved)} find no space`;
  };
  return (
    <>
      <h3 className="cw-h">{i.call.shipName} — parking impact <OutcomeChip outcome={i.outcome} /></h3>
      <ol className="cw-answers">
        <li><span>Estimated cars requiring parking</span><b>{fmt(i.requested)}</b></li>
        <li><span>Eligible garages</span><b>{i.garages.length ? i.garages.map(g => `${g.name}${g.role === 'OVERFLOW' ? ' (overflow)' : ''}`).join(', ') : 'None — assignment missing'}</b></li>
        <li><span>Spaces free when its cars begin to arrive ({i.windowStart ?? '—'})</span><b>{i.garages.some(g => g.availableBefore !== null) ? fmt(i.garages.reduce((t, g) => t + (g.availableBefore ?? 0), 0)) : '—'}</b></li>
        <li><span>Cars accommodated</span><b className="cw-in">{fmt(i.accommodated)}{i.overflow ? ` (${fmt(i.overflow)} overflow)` : ''}</b></li>
        <li><span>Cars without parking</span><b className={i.unserved + i.unallocated + i.noData ? 'cw-bad' : undefined}>{fmt(i.unserved + i.unallocated)}{i.noData ? ` + ${fmt(i.noData)} unchecked` : ''}</b></li>
      </ol>
      <div className="cw-why-box">
        <h4 className="cw-sub">6. Why</h4>
        {i.explanation.map(line => <p key={line}>{line}</p>)}
      </div>
      {i.garages.length > 0 && (
        <table className="cw-table cw-impact">
          <thead><tr><th>Garage</th><th>Free at {i.windowStart}</th><th>Taken</th><th>No space</th><th>Outcome</th></tr></thead>
          <tbody>
            {i.garages.map(g => (
              <tr key={g.id} className="is-link" aria-selected={cruise.selectedGarageId === g.id} onClick={() => cruise.setSelectedGarageId(g.id)}>
                <td>{g.name}<span className="cw-dim"> · {g.role === 'OVERFLOW' ? 'overflow' : `p${g.priority}${g.sharePct !== null && cruise.allocationPolicy === 'PROPORTIONAL' ? `, ${g.sharePct}%` : ''}`}</span></td>
                <td>{g.availableBefore === null ? '—' : `${fmt(g.availableBefore)} / ${fmt(g.capacity)}`}</td>
                <td>{fmt(g.accommodated)}</td>
                <td className={g.unserved ? 'cw-bad' : undefined}>{fmt(g.unserved)}</td>
                <td><OutcomeChip outcome={g.outcome} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4 className="cw-sub">Can each garage accommodate {i.call.shipName}'s cars at {at}?</h4>
      <ul className="cw-now-answers">
        {i.garages.map(g => <li key={g.id}><b>{g.name}:</b> {answer(g)}{g.now && Number.isFinite(g.capacity) ? ` · ${fmt(g.now.available)} free after this interval` : ''}</li>)}
        {!i.garages.length && <li>{PARKING_OUTCOME_LABEL.ASSIGNMENT_MISSING}: Terminal {i.terminalCode} has no garage in the mapping.</li>}
      </ul>
    </>
  );
}

/** Review and edit the terminal → garage mapping and the allocation policy. */
export function MappingEditor({ cruise }) {
  const rows = cruise.garageMapping;
  const nameOf = id => cruise.baseFacilities.find(f => f.id === id)?.name ?? id;
  const codes = cruise.terminalCodes;
  return (
    <div className="cw-mapping">
      <div className="cw-assumptions-head">
        <h3 className="cw-h">Terminal → garage mapping</h3>
        <button type="button" className="cw-btn" onClick={cruise.resetMapping}>Reset to county mapping</button>
      </div>
      <p className="cw-note">Defaults come only from the county parking page <Src kind={SOURCE_KIND.PUBLISHED} />, never from proximity. Any change is marked as configured and unverified. A terminal with no allowed garage has its cars reported as unallocated — they do not borrow the rest of the port's spaces.</p>
      <label className="cw-field">
        <span>Allocation policy</span>
        <select value={cruise.allocationPolicy} onChange={e => cruise.setAllocationPolicy(e.target.value)}>
          {Object.entries(ALLOCATION_POLICY_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
        <span className="cw-field-src"><Src kind={SOURCE_KIND.CONFIGURED} /></span>
        <small>Each interval: returning cars leave first, then arriving cars are placed — earliest-departing cruise first. A garage's maximum share caps how many of one cruise's cars it takes.</small>
      </label>
      {cruise.allocationErrors.map(e => <p key={e} className="scenario-error" role="alert">{e}</p>)}
      <table className="cw-table cw-maptable">
        <thead><tr><th>Terminal</th><th>Garage</th><th>Access</th><th>Priority</th><th>Share %</th><th>Max %</th><th>Access route</th><th>Source</th><th /></tr></thead>
        <tbody>
          {codes.map(code => {
            const mine = rows.filter(r => r.terminal_code === code).sort((a, b) => a.allocation_priority - b.allocation_priority || a.garage_id.localeCompare(b.garage_id));
            const addable = cruise.baseFacilities.filter(f => !mine.some(r => r.garage_id === f.id));
            return [
              ...mine.map((r, k) => (
                <tr key={`${code}-${r.garage_id}`} className={r.access_allowed ? undefined : 'is-excluded'}>
                  <td>{k === 0 ? <b>{code}</b> : ''}</td>
                  <td>{nameOf(r.garage_id)}</td>
                  <td><input type="checkbox" checked={r.access_allowed} aria-label={`Terminal ${code} may use ${nameOf(r.garage_id)}`} onChange={e => cruise.setMappingField(code, r.garage_id, 'access_allowed', e.target.checked)} /></td>
                  <td><input type="number" min="1" value={r.allocation_priority} aria-label={`Priority of ${nameOf(r.garage_id)} for terminal ${code}`} onChange={e => cruise.setMappingField(code, r.garage_id, 'allocation_priority', Number(e.target.value))} /></td>
                  <td><input type="number" min="0" max="100" value={r.share_pct} disabled={cruise.allocationPolicy !== 'PROPORTIONAL'} aria-label={`Share of terminal ${code} to ${nameOf(r.garage_id)}`} onChange={e => cruise.setMappingField(code, r.garage_id, 'share_pct', Number(e.target.value))} /></td>
                  <td><input type="number" min="1" max="100" placeholder="—" value={r.max_share_pct ?? ''} aria-label={`Maximum share for ${nameOf(r.garage_id)} from terminal ${code}`} onChange={e => cruise.setMappingField(code, r.garage_id, 'max_share_pct', e.target.value === '' ? null : Number(e.target.value))} /></td>
                  <td className="cw-dim">{r.access_route_id ?? 'none configured'}</td>
                  <td><span className={`cw-src ${r.mapping_source === 'USER_CONFIGURED' ? 'is-configured' : 'is-published'}`}>{MAPPING_SOURCE_LABEL[r.mapping_source]}</span></td>
                  <td>{r.mapping_source === 'USER_CONFIGURED' && !cruise.garageMapping.some(x => x.terminal_code === code && x.garage_id === r.garage_id && x.mapping_source === 'COUNTY_PARKING_PAGE')
                    ? <button type="button" className="cw-linkbtn" onClick={() => cruise.removeMapping(code, r.garage_id)}>Remove</button> : null}</td>
                </tr>
              )),
              <tr key={`${code}-add`} className="cw-addrow">
                <td>{mine.length ? '' : <b>{code}</b>}</td>
                <td colSpan="8">
                  {!mine.some(r => r.access_allowed) && <span className="cw-bad">No garage — cars from Terminal {code} are unallocated. </span>}
                  <select value="" aria-label={`Add a garage for terminal ${code}`} onChange={e => e.target.value && cruise.addMapping(code, e.target.value)}>
                    <option value="">+ Allow another registered garage…</option>
                    {addable.map(f => <option key={f.id} value={f.id}>{f.name}{Number.isFinite(f.capacity) ? ` (${fmt(f.capacity)})` : ' (capacity not published)'}</option>)}
                  </select>
                </td>
              </tr>,
            ];
          })}
        </tbody>
      </table>
      <h4 className="cw-sub">Which terminals can use each design's added spaces</h4>
      {[['EXPAND_EXISTING', 'A · Expand existing garage'], ['NEW_GARAGE', 'B · New garage'], ['OPTIMIZE_SURFACE', 'C · Surface lots']].map(([type, label]) => {
        const v = cruise.scopeFor[type] ?? (type === 'EXPAND_EXISTING' ? PROPOSED_SCOPE.OWN_TERMINALS : PROPOSED_SCOPE.ANY_TERMINAL);
        const list = Array.isArray(v) ? v : null;
        return (
          <div key={type} className="cw-field">
            <span>{label}</span>
            <select value={list ? 'LIST' : v} onChange={e => cruise.setScope(type, e.target.value === 'LIST' ? [] : e.target.value)}>
              <option value={PROPOSED_SCOPE.OWN_TERMINALS}>Only the terminals its garage already serves</option>
              <option value={PROPOSED_SCOPE.ANY_TERMINAL}>Any terminal, as overflow (assumed)</option>
              <option value="LIST">Selected terminals only</option>
            </select>
            <span className="cw-field-src"><Src kind={SOURCE_KIND.CONFIGURED} /></span>
            {list && (
              <small className="cw-termchecks">
                {codes.map(code => (
                  <label key={code}><input type="checkbox" checked={list.includes(code)}
                    onChange={e => cruise.setScope(type, e.target.checked ? [...list, code].sort() : list.filter(x => x !== code))} /> {code}</label>
                ))}
              </small>
            )}
          </div>
        );
      })}
      <p className="cw-note">No source says which terminals a garage that does not exist yet would serve. A terminal not given access cannot use a design's spaces, so they cannot solve its shortage.</p>
    </div>
  );
}

/** Where the capacity figure comes from: every garage in it, once, with its source and reason. */
export function CapacityBreakdown({ cruise, onClose }) {
  const s = cruise.current;
  return (
    <div className="cw-popover" role="dialog" aria-label="Capacity breakdown" data-label-obstacle>
      <header><b>{fmt(s.capacity)} spaces in play on {dayLabel(cruise.date)}</b><button type="button" className="cw-icon" onClick={onClose} aria-label="Close">×</button></header>
      <table className="cw-table">
        <thead><tr><th>Garage</th><th>Capacity</th><th>Why it counts</th><th>Source</th></tr></thead>
        <tbody>
          {s.facilities.map(f => (
            <tr key={f.id}><td>{f.name}</td><td>{Number.isFinite(f.capacity) ? fmt(f.capacity) : <span className="cw-missing">not published — not added</span>}</td><td>{f.inPlayBecause}</td><td className="cw-dim">{f.capacitySource ?? '—'}</td></tr>
          ))}
        </tbody>
        <tfoot><tr><th>Total, each garage once</th><td>{fmt(s.capacity)}</td><td colSpan="2" /></tr></tfoot>
      </table>
      <p className="cw-hint">Only garages the day's modelled terminals may use (by the mapping and each design's access), plus any still holding parked cars. Registered garages serving no modelled terminal today are not counted.</p>
    </div>
  );
}

// ---- step 3: time ------------------------------------------------------------------------------------

export function TimeFigures({ cruise, onInspect }) {
  const i = cruise.inspection;
  if (!i) return null;
  const t = i.totals;
  return (
    <section className="cw-now" aria-label="Selected interval">
      <h3 className="cw-h">{i.time}–{i.endTime} <span>{dayLabel(cruise.date)} · {cruise.viewName}</span></h3>
      <dl className="cw-kpis is-six">
        <div><dt>Starting occupied</dt><dd>{fmt(t.start)}</dd></div>
        <div><dt>Cars entering</dt><dd className="cw-in">+{fmt(t.served)}</dd></div>
        <div><dt>Cars leaving</dt><dd className="cw-out">−{fmt(t.exits)}</dd></div>
        <div><dt>Ending occupied</dt><dd>{fmt(t.end)}</dd></div>
        <div><dt>Remaining capacity</dt><dd>{fmt(t.remaining)}</dd></div>
        <div><dt>Cars with no space</dt><dd className={t.unserved ? 'cw-bad' : undefined}>{fmt(t.unserved)}</dd></div>
      </dl>
      <p className="cw-eq">
        Ending occupancy = Starting occupancy + Served entries − Exits:&nbsp;
        <b>{fmt(i.equation.end)} = {fmt(i.equation.start)} + {fmt(i.equation.served)} − {fmt(i.equation.exits)}</b>
        <span className={i.equation.ok ? 'cw-ok' : 'cw-bad'}>{i.equation.ok ? ' ✓' : ' ✗'}</span>
      </p>
      <button type="button" className="cw-btn is-primary" onClick={onInspect}>How was this calculated?</button>
    </section>
  );
}

export function Happening({ cruise }) {
  return (
    <section className="cw-happening" aria-label="What's happening at this time?">
      <h3 className="cw-h">What's happening at this time?</h3>
      <ul>
        {cruise.explanation.map((e, k) => <li key={k} className={`is-${e.kind.toLowerCase()}`}><span>{e.text}</span><Src kind={e.source} /></li>)}
      </ul>
    </section>
  );
}

const EVENT_ICON = { ARRIVAL: '⚓', DEPARTURE: '⛴', EXITS_START: '↓', EXITS_END: '↓', ENTRIES_START: '↑', ENTRIES_END: '↑', PEAK: '▲', NEAR_CAPACITY: '!', CAPACITY: '■' };

export function EventList({ cruise }) {
  const list = cruise.events;
  if (!list.length) return <p className="cw-empty">No cruise events on {dayLabel(cruise.date)}.</p>;
  return (
    <ol className="cw-events">
      {list.map(e => (
        <li key={e.id} className={`is-${e.kind.toLowerCase()}${e.index === cruise.timeIndex ? ' is-now' : ''}${e.modelled === false ? ' is-unmodelled' : ''}`}>
          <button type="button" onClick={() => cruise.setTimeIndex(e.index)}>
            <time>{e.time}</time><i aria-hidden="true">{EVENT_ICON[e.kind]}</i><span>{e.text}{e.estimated ? ' (estimate)' : ''}{e.modelled === false ? ' — not modelled' : ''}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

