/**
 * One row of the Demand & Turnover table, selected: what the row's cars are made of, and the
 * inputs that make them, editable for THIS DIRECTION ONLY.
 *
 * A departing row edits the departing occupancy, long-stay share, party size and arrival window; a
 * returning row the returning ones and the exit window. Nothing is copied across. Edits are a draft
 * until applied to this cruise, its date, or every cruise in the demand profile
 * (`applyRowEdit`); "Reset to defaults" drops this cruise's and this date's values for the row.
 *
 * A RECONSTRUCTED returning row is the cars an earlier departure parked. Their count was fixed when
 * they parked, so only the exit window can be changed here; the panel says so and links to the
 * departure whose inputs made them.
 */
import { useMemo, useState } from 'react';
import {
  CRUISE_ASSUMPTIONS, MODE_SHARE_KEYS, ROW_KEYS, ROW_SCOPE, WINDOW_KEYS, assumptionIssues, balanceLongStay, cruiseAssumptions,
} from '../cruise/cruiseAssumptions.js';
import { parkedVehicles } from '../cruise/turnaroundModel.js';
import { utcMsToLocal } from '../cruise/cruiseCalls.js';
import { CAPACITY_TYPE_LABEL } from '../cruise/vesselMaster.js';
import { OVERRIDE_KIND, overrideIssues } from '../cruise/cohortOverrides.js';

const fmt = v => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');
const clock = ms => utcMsToLocal(ms).time;
const dayShort = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The row's identity for editing: which call, which date's values, which keys. */
export function rowTarget(row) {
  const returning = row.flow === 'Returning';
  const side = returning ? 'returning' : 'departing';
  const cohort = returning ? row.r.returning : row.r.departing;
  const reconstructed = returning && row.r.returningSource?.kind === 'RECONSTRUCTED';
  return {
    side, returning, reconstructed, cohort,
    callId: row.r.call.id,
    // The date the engine reads this row's values from: the departure date for a departing
    // cohort, the arrival date (its exit window) for a returning one.
    date: returning ? cohort.exitWindowInputs?.date ?? row.r.call.arrivalDate : cohort.inputs.assumptionDate,
    keys: reconstructed ? WINDOW_KEYS.returning : ROW_KEYS[side],
  };
}

export function RowEditor({ cruise, row, onOpenOrigin, nested = false }) {
  const [showOrigin, setShowOrigin] = useState(false);
  const t = rowTarget(row);
  const x = t.cohort.inputs;
  const current = useMemo(
    () => cruiseAssumptions(cruise.monthAssumptions, cruise.monthByDate, cruise.cruiseEdits, t.date, t.callId),
    [cruise.monthAssumptions, cruise.monthByDate, cruise.cruiseEdits, t.date, t.callId]);
  const saved = useMemo(() => Object.fromEntries(t.keys.map(k => [k, current[k]])), [t.keys, current]);
  const [draft, setDraft] = useState(saved);
  const [lastSaved, setLastSaved] = useState(saved);
  // A new row, or values applied from elsewhere, replace the draft.
  if (JSON.stringify(saved) !== JSON.stringify(lastSaved)) { setLastSaved(saved); setDraft(saved); }

  const longKey = `${t.side}LongStayPct`;
  const balance = !t.reconstructed && Number(draft[longKey]) !== Number(current[longKey])
    ? balanceLongStay(current, t.side, draft[longKey]) : null;
  const values = useMemo(() => {
    const v = Object.fromEntries(t.keys.filter(k => Number(draft[k]) !== Number(saved[k]) || draft[k] === '').map(k => [k, draft[k] === '' ? '' : Number(draft[k])]));
    return balance ? { ...v, ...balance.values } : v;
  }, [draft, saved, t.keys, balance]);
  const dirty = Object.keys(values).length > 0;
  const issues = [
    ...(balance?.issue ? [balance.issue] : []),
    ...assumptionIssues({ ...current, ...values })
      .filter(i => i.keys.some(k => t.keys.includes(k) || MODE_SHARE_KEYS[t.side].includes(k))).map(i => i.message),
  ];
  const preview = t.reconstructed ? null : parkedVehicles(x.capacity, {
    occupancyPct: Number(draft[`${t.side}OccupancyPct`]), longStayPct: Number(draft[longKey]),
    passengersPerVehicle: Number(draft[`${t.side}PassengersPerVehicle`]),
  });

  const edits = cruise.cruiseEdits[t.callId] ?? {};
  const dateEdits = cruise.monthByDate[t.date] ?? {};
  const own = k => (k in edits ? 'This cruise' : k in dateEdits ? dayShort(t.date) : null);
  const hasOwn = t.keys.some(k => own(k)) || (k => k in edits || k in dateEdits)(MODE_SHARE_KEYS[t.side][3]);
  const apply = scope => cruise.applyRow({ callId: t.callId, date: t.date, values, scope });
  const reset = () => cruise.resetRow({ callId: t.callId, date: t.date, keys: [...t.keys, ...(t.reconstructed ? [] : [MODE_SHARE_KEYS[t.side][3]])] });

  const field = k => {
    const spec = CRUISE_ASSUMPTIONS[k];
    const label = /Min$/.test(k) ? spec.label : spec.label.replace(/^(Departing|Returning) /, '');
    return (
      <label key={k} className={`cw-field${issues.length && values[k] !== undefined ? ' is-invalid' : ''}`} title={spec.basis}>
        <span>{label[0].toUpperCase() + label.slice(1)}</span>
        <span className="cw-field-input">
          <input type="number" step="any" value={draft[k]} aria-label={`${t.side} ${label}`}
            onChange={e => setDraft(d => ({ ...d, [k]: e.target.value === '' ? '' : e.target.value }))} />
          <em>{spec.unit}</em>
        </span>
        <span className="cw-field-src">{own(k) ? <span className="cw-src is-configured">{own(k)}</span> : <span className="cw-src">Profile</span>}</span>
      </label>
    );
  };

  const window = t.returning
    ? { label: 'Exit window', start: t.cohort.exitStartMs, end: t.cohort.exitEndMs }
    : { label: 'Arrival window', start: t.cohort.entryStartMs, end: t.cohort.entryEndMs };
  const facts = [
    ['Published passenger capacity', `${fmt(x.capacity)} berths`],
    ['Capacity basis', `${CAPACITY_TYPE_LABEL[x.capacityBasis] ?? 'Not stated'} · max ${x.occupancyLimitPct ?? 100}%`],
    ['Assumed ship occupancy', x.occupancyCappedFrom ? `${x.occupancyPct}% (capped from ${x.occupancyCappedFrom}%)` : `${x.occupancyPct}%`],
    ['Estimated passengers', x.manifestPassengers ? `${fmt(x.passengers)} (manifest ${fmt(x.manifestPassengers)})` : fmt(x.passengers)],
    ['Long-stay parking share', `${x.longStayPct}%`],
    ['Passengers per car', x.passengersPerVehicle],
    [t.returning ? 'Cars in the cohort' : 'Estimated parking vehicles', t.cohort.calculatedVehicles !== undefined ? `${fmt(t.cohort.vehicles)} (calculated ${fmt(t.cohort.calculatedVehicles)}, overridden)` : fmt(t.cohort.vehicles)],
    ...(t.returning ? [
      ['Parked — these leave the garages', fmt(row.r.leavingVehicles)],
      ...(row.r.returningWithoutSpace ? [['Turned away when they arrived', `${fmt(row.r.returningWithoutSpace)} — never parked, so never leave a garage`]] : []),
      ...(row.r.returningNoData ? [['Meant for a garage of unknown capacity', fmt(row.r.returningNoData)]] : []),
    ] : []),
    [window.label, Number.isFinite(window.start) ? `${clock(window.start)}–${clock(window.end)} ${dayShort(utcMsToLocal(window.start).date)}` : 'after Nov 30'],
  ];

  return (
    <section className="cd-card cd-roweditor" aria-label={`${row.r.call.shipName} ${t.side}`}>
      <header>
        <h3>{row.r.call.shipName} <span className="cw-dim">· Terminal {row.r.call.terminalCode}</span></h3>
        <span className={`cw-dir ${t.returning ? 'cw-out' : 'cw-in'}`}>{t.returning ? '↓ Returning' : '↑ Departing'}</span>
      </header>

      <p className={`cw-source ${t.cohort.override ? 'is-manual' : t.reconstructed ? 'is-reconstructed' : 'is-estimate'}`}>
        {t.cohort.provenance === 'MANUAL_ESTIMATE' ? `Source: manually estimated — ${t.cohort.override.reason}`
          : t.cohort.provenance === 'RECONCILED' ? `Source: ${t.reconstructed ? 'reconstructed cohort, ' : ''}reconciled manually (${fmt(t.cohort.calculatedVehicles)} → ${fmt(t.cohort.vehicles)} cars) — ${t.cohort.override.reason}`
          : t.reconstructed
          ? `Source: reconstructed cohort — parked by ${t.cohort.shipName} departing ${dayShort(t.cohort.departureDate)} (request ${row.r.returningSource.originDockRequest ?? '—'})`
          : t.returning ? `Source: estimated from the returning assumptions of ${dayShort(t.date)} — no departure in the report parked these cars`
            : `Source: estimated from the departing assumptions of ${dayShort(t.date)}`}
      </p>
      <dl className="cd-facts">
        {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <p className="cd-note">Passengers are an estimate (capacity × assumed occupancy), not a manifest count. Occupancy above 100% is allowed only on a double-occupancy (lower-berth) capacity, up to 110%.</p>
      {t.returning && row.r.returningParkedByGarage.length > 0 && (
        <p className="cw-note">Leaving from: {row.r.returningParkedByGarage.map(g => `${g.name} ${fmt(g.n)}`).join(' · ')} — the garages these cars were parked in.</p>
      )}

      {t.reconstructed && (
        <div className="cd-locked" role="note">
          <b>These cars were parked by an earlier departure, so today's assumptions cannot change them.</b>
          <dl className="cd-facts">
            <div><dt>Previous departure</dt><dd>{dayShort(t.cohort.departureDate)} {row.r.originCall?.departureLocal?.slice(11, 16) ?? ''}</dd></div>
            <div><dt>Originating call</dt><dd>{t.cohort.shipName} · request {row.r.returningSource.originDockRequest ?? '—'}</dd></div>
            <div><dt>Original passenger capacity</dt><dd>{fmt(x.capacity)}</dd></div>
            <div><dt>Occupancy · share · per car</dt><dd>{x.occupancyPct}% · {x.longStayPct}% · {x.passengersPerVehicle}</dd></div>
            <div><dt>Original cars parked</dt><dd>{fmt(row.r.leavingVehicles)} of {fmt(t.cohort.vehicles)}</dd></div>
            <div><dt>Garage allocation</dt><dd>{row.r.returningParkedByGarage.map(g => `${g.name} ${fmt(g.n)}`).join(' · ') || 'none — no space'}</dd></div>
          </dl>
          <div className="cd-rowactions">
            <button type="button" className="cw-btn" aria-expanded={showOrigin} onClick={() => setShowOrigin(v => !v)}>{showOrigin ? 'Hide original departure' : 'Edit original departure'}</button>
            <button type="button" className="cw-linkbtn" onClick={() => onOpenOrigin(row.r.returningSource.originCallId, t.cohort.departureDate)}>Open {dayShort(t.cohort.departureDate)}</button>
          </div>
          <p className="cd-note">Editing the original departure recalculates its cars from that sailing, and so the cars returning here; no other voyage changes. Only the exit window below belongs to today.</p>
        </div>
      )}
      {t.reconstructed && showOrigin && row.r.originCall && (
        <div className="cd-origin">
          <RowEditor cruise={cruise} nested onOpenOrigin={onOpenOrigin}
            row={{ id: `${row.r.originCall.id}-d`, flow: 'Departing', r: { call: row.r.originCall, departing: t.cohort, returning: null, returningSource: null } }} />
        </div>
      )}

      <fieldset className="cw-group cd-rowfields">
        <legend>{t.reconstructed ? 'Exit window' : `${t.returning ? 'Returning' : 'Departing'} inputs`}</legend>
        {t.keys.map(field)}
        {balance && !balance.issue && <p className="cw-note">Other modes (transfer, coach, walk-on) become {balance.otherPct}% so this side's shares still total 100%.</p>}
        {preview && dirty && <p className="cw-note"><b>{fmt(preview.vehicles)}</b> cars with these values (now {fmt(x.vehicles)}).</p>}
        {issues.map(m => <p key={m} className="scenario-error" role="alert">{m}</p>)}
      </fieldset>

      <div className="cd-rowactions">
        <button type="button" className="cw-btn is-primary" disabled={!dirty || issues.length > 0} onClick={() => apply(ROW_SCOPE.CRUISE)}>Apply to this cruise</button>
        <button type="button" className="cw-btn" disabled={!dirty || issues.length > 0} onClick={() => apply(ROW_SCOPE.DATE)}>Apply to {dayShort(t.date)}</button>
        <button type="button" className="cw-btn" disabled={!dirty || issues.length > 0} onClick={() => apply(ROW_SCOPE.PROFILE)}
          title="Changes the November values every cruise uses, including earlier departures whose cars return later. Cruises and dates with their own values keep them.">
          Apply to all cruises in this demand profile
        </button>
        <button type="button" className="cw-btn" disabled={!hasOwn && !dirty} onClick={() => { setDraft(saved); reset(); }}
          title="Remove this cruise's and this date's values for these inputs: the demand profile's values apply again.">
          Reset to defaults
        </button>
      </div>
      {t.returning && !nested && <OverrideForm cruise={cruise} cohort={t.cohort} reconstructed={t.reconstructed} />}
      <p className="cd-note">
        {nested
          ? `This changes the cars ${row.r.call.shipName} parked when it departed on ${dayShort(t.date)}, and so the same cars when they return. No other voyage changes.`
          : t.returning
          ? 'Only the returning side changes. Departing cars, including those parked today, are not affected.'
          : `Only the departing side changes. Returning cars are not affected — today's returning cars were parked by earlier departures. "All cruises" also changes those earlier departures.`}
      </p>
    </section>
  );
}

/**
 * Option B for a returning row. An ESTIMATED cohort (no departure in the report) can be manually
 * estimated: cars and exit window, with a reason. A RECONSTRUCTED cohort cannot simply be
 * overwritten: a reconciliation adjustment changes the cars its departure parked — they enter
 * then and leave here, so none is created or destroyed — and needs an acknowledgement as well as a
 * reason. Both are kept in the audit record.
 */
function OverrideForm({ cruise, cohort, reconstructed }) {
  const kind = reconstructed ? OVERRIDE_KIND.RECONCILIATION : OVERRIDE_KIND.MANUAL_ESTIMATE;
  const current = cruise.cohortOverrides[cohort.id] ?? null;
  const w = cohort.exitWindowInputs ?? {};
  const [form, setForm] = useState({ vehicles: cohort.vehicles, exitStartMin: w.startMin ?? 45, exitEndMin: w.endMin ?? 270, reason: '', acknowledged: false });
  const [errors, setErrors] = useState([]);
  const audit = cruise.overrideAudit.filter(a => a.cohortId === cohort.id);
  const input = { cohort, kind, vehicles: form.vehicles === '' ? NaN : Number(form.vehicles), reason: form.reason, acknowledged: form.acknowledged,
    ...(reconstructed ? {} : { exitStartMin: Number(form.exitStartMin), exitEndMin: Number(form.exitEndMin) }) };
  const live = overrideIssues(input);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  return (
    <details className="cd-override" open={Boolean(current) || undefined}>
      <summary>{reconstructed ? 'Reconciliation adjustment' : 'Override returning estimate'}{current ? ` · ${current.kind === 'MANUAL_ESTIMATE' ? 'manually estimated' : 'reconciled'}` : ''}</summary>
      {current && (
        <p className="cw-note">Active: {fmt(current.vehicles)} cars{current.exitStartMin !== undefined ? `, leaving ${current.exitStartMin}–${current.exitEndMin} min after arrival` : ''} — “{current.reason}”.{' '}
          <button type="button" className="cw-linkbtn" onClick={() => cruise.removeOverride(cohort)}>Remove override</button></p>
      )}
      {reconstructed && <p className="cd-alert is-warn">This changes a calculated cohort. The adjusted number of cars parks at the {dayShort(cohort.departureDate)} departure and leaves on this return, so garage occupancy stays consistent in between. Use it only to reconcile with a known count.</p>}
      <div className="cd-rowfields">
        <label className="cw-field"><span>{reconstructed ? 'Cars parked by the departure' : 'Estimated returning parked cars'}</span>
          <span className="cw-field-input"><input type="number" min="0" step="1" value={form.vehicles} aria-label="Override cars" onChange={e => set('vehicles', e.target.value)} /><em>cars</em></span></label>
        {!reconstructed && <>
          <label className="cw-field"><span>Return exit start</span><span className="cw-field-input"><input type="number" value={form.exitStartMin} aria-label="Override exit start" onChange={e => set('exitStartMin', e.target.value)} /><em>min after arrival</em></span></label>
          <label className="cw-field"><span>Return exit end</span><span className="cw-field-input"><input type="number" value={form.exitEndMin} aria-label="Override exit end" onChange={e => set('exitEndMin', e.target.value)} /><em>min after arrival</em></span></label>
        </>}
        <label className="cw-field cd-reason"><span>Reason (kept in the audit record)</span>
          <textarea rows="2" value={form.reason} aria-label="Override reason" onChange={e => set('reason', e.target.value)} /></label>
        {reconstructed && <label className="cd-ack"><input type="checkbox" checked={form.acknowledged} onChange={e => set('acknowledged', e.target.checked)} /> I understand this adjusts a calculated cohort from its departure onward.</label>}
      </div>
      {errors.map(m => <p key={m} className="scenario-error" role="alert">{m}</p>)}
      <button type="button" className="cw-btn is-primary" disabled={live.length > 0}
        title={live[0]} onClick={() => setErrors(cruise.setOverride(input))}>{reconstructed ? 'Record reconciliation adjustment' : 'Save manual estimate'}</button>
      {audit.length > 0 && (
        <ol className="cd-audit" aria-label="Override audit record">
          {audit.map(a => <li key={`${a.at}-${a.action}`}>{a.at.slice(0, 16).replace('T', ' ')} · {a.action === 'SET' ? 'set' : 'removed'} · {fmt(a.from)} → {fmt(a.to)} cars · {a.reason}</li>)}
        </ol>
      )}
    </details>
  );
}
