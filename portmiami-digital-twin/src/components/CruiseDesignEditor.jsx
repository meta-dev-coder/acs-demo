/**
 * Editing a parking design inside the Cruise Parking Simulation.
 *
 * The design IS the Parking Scenario Planner's A, B or C: the editor changes a draft of that
 * scenario (useCruiseDemand → designDraft), every run is recomputed from it as soon as a value
 * changes, and Save writes it back to the planner — which then shows the same values, the same
 * facility and the same 3D geometry. Cancel and Reset never touch what is saved.
 *
 *   A  one registered garage, the spaces and floors added to it
 *   B  the proposed new garage: capacity, floors, footprint size, and the terminals it may serve
 *   C  existing surface lots, the spaces added to each, and the terminals they may serve
 */
import { useMemo, useState } from 'react';
import { PROPOSED_SCOPE } from '../cruise/cruiseAssumptions.js';
import { CHANGE, CHANGE_LABEL, CHECK, beforeAfter, checkExpansion, checkNewGarage, checkSurfaceLot } from '../cruise/designCheck.js';
import { capacityFeasibility } from '../scenarios/garagePlacement.js';
import { durationLabel } from '../cruise/demandCapacity.js';

const fmt = v => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');

/**
 * A whole-number input with − / + buttons. While it has focus it keeps what is typed (it can be
 * cleared and retyped); every complete number is applied as it is typed. Focusing it selects the
 * number, so typing replaces it.
 */
function Stepper({ value, onChange, step = 50, min = 0, max = 20000, label }) {
  const [text, setText] = useState(null);   // null: not being typed in; show `value`
  const clamp = v => Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
  const set = v => onChange(clamp(v));
  return (
    <span className="de-stepper">
      <button type="button" aria-label={`Decrease ${label}`} onClick={() => set(value - step)}>−</button>
      <input type="number" value={text ?? value} min={min} max={max} aria-label={label}
        onFocus={e => { setText(String(value)); e.target.select(); }}
        onChange={e => { setText(e.target.value); if (e.target.value !== '') set(e.target.value); }}
        onBlur={() => { if (text === '') set(0); setText(null); }} />
      <button type="button" aria-label={`Increase ${label}`} onClick={() => set(value + step)}>+</button>
    </span>
  );
}

/** Which terminals may use the added spaces. */
function TerminalAccess({ cruise, design, ownLabel }) {
  const codes = cruise.terminalCodes;
  const value = design.scope;
  const list = Array.isArray(value) ? value : value === PROPOSED_SCOPE.ANY_TERMINAL ? null : [];
  const own = value === undefined || value === PROPOSED_SCOPE.OWN_TERMINALS;
  return (
    <fieldset className="de-terminals">
      <legend>Terminals that may use these spaces</legend>
      {ownLabel && (
        <label><input type="radio" checked={own} onChange={() => cruise.editDesign(design.id, { scope: PROPOSED_SCOPE.OWN_TERMINALS })} /> {ownLabel}</label>
      )}
      <label><input type="radio" checked={!own && value !== PROPOSED_SCOPE.ANY_TERMINAL} onChange={() => cruise.editDesign(design.id, { scope: list ?? [] })} /> Selected terminals</label>
      {!own && value !== PROPOSED_SCOPE.ANY_TERMINAL && (
        <span className="de-checks">
          {codes.map(code => (
            <label key={code}><input type="checkbox" checked={(list ?? []).includes(code)}
              onChange={e => cruise.editDesign(design.id, { scope: e.target.checked ? [...(list ?? []), code].sort() : (list ?? []).filter(x => x !== code) })} /> {code}</label>
          ))}
        </span>
      )}
      <label><input type="radio" checked={value === PROPOSED_SCOPE.ANY_TERMINAL} onChange={() => cruise.editDesign(design.id, { scope: PROPOSED_SCOPE.ANY_TERMINAL })} /> Any terminal, as overflow (assumed)</label>
      {!own && Array.isArray(list) && !list.length && <small className="cw-bad">No terminal selected: no car can use these spaces.</small>}
    </fieldset>
  );
}

function CheckNote({ check }) {
  if (!check) return null;
  return <p className={`de-check is-${check.status === CHECK.CONSISTENT ? 'ok' : check.status === CHECK.EXCEEDS ? 'bad' : 'muted'}`}>{check.message}</p>;
}

/** Existing → proposed for the selected garage or terminal. */
export function BeforeAfter({ cruise, id }) {
  const out = useMemo(() => {
    const base = cruise.dvcs?.baseline, draft = cruise.dvcs?.[id], sim = cruise.sims?.[id];
    return base && draft && sim ? beforeAfter({ base, draft, sim }) : null;
  }, [cruise.dvcs, cruise.sims, id]);
  if (!out) return null;
  const row = (label, [b, a], better) => (
    <tr><th scope="row">{label}</th><td>{b ?? '—'}</td><td aria-hidden="true">→</td><td className={better === undefined ? undefined : better ? 'cw-ok' : 'cw-bad'}><b>{a ?? '—'}</b></td></tr>
  );
  const tone = out.change === CHANGE.ELIMINATED ? 'ok' : out.change === CHANGE.REDUCED ? 'warn' : out.change === CHANGE.NO_SHORTAGE ? 'muted' : 'bad';
  return (
    <section className="de-ba" aria-label="Before and after">
      <header><b>{cruise.dvc.label}</b> · Existing → this design</header>
      <table>
        <tbody>
          {row('Capacity', out.capacity.map(fmt))}
          {row('Peak demand', out.peakDemand.map(fmt))}
          {row('Maximum unmet demand', out.shortage.map(fmt), out.shortage[1] < out.shortage[0] || out.shortage[1] === 0)}
          {row('Cars denied parking', out.denied.map(fmt), out.denied[1] <= out.denied[0])}
          {row('Shortage duration', out.shortageIntervals.map(durationLabel), out.shortageIntervals[1] <= out.shortageIntervals[0])}
          {row('First shortage', out.firstShortage.map(t => t ?? 'none'))}
        </tbody>
      </table>
      <p className={`cw-outcome is-${tone}`}>{CHANGE_LABEL[out.change]}</p>
      {out.reason && <p className="de-reason">{out.reason}</p>}
    </section>
  );
}

/**
 * "Find minimum additional spaces": the fewest spaces A must add to the selected garage to leave
 * it no modelled shortage, found by running the full simulation (designSearch.js). Shown, never
 * applied until the user chooses Apply.
 */
function MinimumSpaces({ cruise, id }) {
  const r = cruise.minSearch?.designId === id || ['RUNNING', 'NO_GARAGE', 'UNKNOWN_CAPACITY'].includes(cruise.minSearch?.status) ? cruise.minSearch : null;
  const target = cruise.focus.kind === 'GARAGE' ? cruise.baseFacilities.find(f => f.id === cruise.focus.id) : null;
  return (
    <div className="de-min">
      <button type="button" className="cw-btn" disabled={r?.status === 'RUNNING'} onClick={() => cruise.findMinimumSpaces(id)}>
        {r?.status === 'RUNNING' ? 'Searching with the simulation…' : `Find minimum additional spaces${target ? ` for ${target.name}` : ''}`}
      </button>
      {r?.status === 'NO_GARAGE' && <p className="de-check is-muted">Select a garage (in the view or in this design) to search for.</p>}
      {r?.status === 'UNKNOWN_CAPACITY' && <p className="de-check is-muted">{r.garage.name} has no published capacity, so no minimum can be calculated against it.</p>}
      {r?.status === 'NONE_NEEDED' && <p className="de-check is-ok">{r.garage.name} has no modelled shortage on this date: no additional spaces are needed.</p>}
      {r?.status === 'INFEASIBLE' && (
        <p className="de-check is-bad">Even +{fmt(r.tried)} spaces at {r.garage.name} leave a shortage of {fmt(r.at?.maxShortage)}: those cars cannot be placed there under the terminal → garage mapping (its terminals, priorities or maximum shares). Change the mapping, or try B or C with access for the affected terminals.</p>
      )}
      {r?.status === 'FOUND' && (
        <div className="de-minresult">
          <dl>
            <div><dt>Existing capacity</dt><dd>{fmt(r.garage.capacity)}</dd></div>
            <div><dt>Minimum additional spaces</dt><dd><b>+{fmt(r.minimum)}</b></dd></div>
            <div><dt>Proposed total</dt><dd>{fmt(r.garage.capacity + r.minimum)}</dd></div>
            <div><dt>Shortage at {r.garage.name}</dt><dd className="cw-ok">eliminated</dd></div>
          </dl>
          <p className="de-hint">Found with {r.evaluations} full simulation runs{r.confirmed ? `; +${fmt(r.minimum - 1)} still leaves ${fmt(r.before?.maxShortage)} short` : ''}. Cars turned away earlier in the week stay away for their voyage, so this is more than today's peak minus capacity.</p>
          {r.others.length > 0 && <p className="de-check is-muted">Still short elsewhere (not reached by this garage): {r.others.map(o => `${o.name} ${fmt(o.short)}`).join(', ')}.</p>}
          <button type="button" className="cw-btn is-primary" onClick={cruise.applyMinimum}>Apply to design</button>
        </div>
      )}
    </div>
  );
}

/** The editor for one design; `compact` for the Time Simulation side panel. */
export function DesignEditor({ cruise, id, compact = false }) {
  const design = cruise.designDraft?.id === id ? cruise.designDraft : cruise.savedDesign(id);
  const planner = cruise.planner;
  const scenario = planner.scenarios.find(x => x.id === id);
  if (!design || !scenario) return null;
  const editing = cruise.designDraft?.id === id;
  const garages = cruise.baseFacilities.filter(f => f.kind === 'GARAGE');
  const lots = cruise.baseFacilities.filter(f => f.kind === 'SURFACE_LOT');
  const inFocus = new Set(cruise.dvc?.facilities.map(f => f.id) ?? []);
  const sortFocus = list => [...list].sort((a, b) => Number(inFocus.has(b.id)) - Number(inFocus.has(a.id)) || (b.capacity ?? -1) - (a.capacity ?? -1));
  const gross = Number(scenario.assumptions?.grossAreaPerSpaceM2) || 32;
  const surface = Number(scenario.assumptions?.surfaceAreaPerSpaceM2) || 28;
  const placingThis = planner.selected?.id === id && planner.placement?.draft;

  let body = null, check = null;
  if (design.type === 'EXPAND_EXISTING') {
    const target = garages.find(g => g.id === design.assetId);
    if (target) check = checkExpansion({ name: target.name, footprints: cruise.geometry.get(target.id), addedFloors: design.addedFloors, additionalSpaces: design.additionalSpaces, grossAreaPerSpaceM2: gross });
    body = (
      <>
        <p className="de-hint">Add spaces to one registered garage. Existing capacity is kept; the added spaces are on top.</p>
        <table className="de-rows">
          <tbody>
            {sortFocus(garages).map(g => {
              const v = design.assetId === g.id ? design.additionalSpaces : 0;
              return (
                <tr key={g.id} className={design.assetId === g.id ? 'is-on' : undefined}>
                  <th scope="row">{g.name}{inFocus.has(g.id) ? <span className="de-focus">in view</span> : null}</th>
                  <td><Stepper value={v} label={`spaces added to ${g.name}`} onChange={n => cruise.editDesign(id, n > 0 ? { assetId: g.id, additionalSpaces: n } : design.assetId === g.id ? { additionalSpaces: 0 } : {})} /></td>
                  <td className="de-total">{Number.isFinite(g.capacity) ? <>{fmt(g.capacity)}{v ? <> + {fmt(v)} = <b>{fmt(g.capacity + v)}</b></> : null}</> : <span className="cw-missing">capacity not published</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <label className="de-field">Added floors <Stepper value={design.addedFloors} step={1} max={20} label="added floors" onChange={n => cruise.editDesign(id, { addedFloors: n })} /></label>
        <MinimumSpaces cruise={cruise} id={id} />
      </>
    );
  } else if (design.type === 'NEW_GARAGE') {
    const p = placingThis ? planner.placement.draft : null;
    const cap = p ? capacityFeasibility(p, { targetSpaces: design.additionalSpaces, grossAreaPerSpaceM2: gross }) : null;
    check = checkNewGarage({ capacity: cap, placed: Boolean(p) });
    body = (
      <>
        <label className="de-field">Proposed capacity <Stepper value={design.additionalSpaces} step={100} label="new garage capacity" onChange={n => cruise.editDesign(id, { additionalSpaces: n })} /></label>
        <label className="de-field">Floors <Stepper value={design.addedFloors} step={1} max={20} label="new garage floors" onChange={n => { cruise.editDesign(id, { addedFloors: n }); if (p) planner.placement.setField('floors', Math.max(1, n)); }} /></label>
        {p ? (
          <div className="de-dims">
            <label className="de-field">Length (m) <Stepper value={Math.round(p.lengthM)} step={5} min={10} max={400} label="footprint length" onChange={n => { planner.placement.setField('lengthM', n); cruise.editDesign(id, {}); }} /></label>
            <label className="de-field">Width (m) <Stepper value={Math.round(p.widthM)} step={5} min={10} max={400} label="footprint width" onChange={n => { planner.placement.setField('widthM', n); cruise.editDesign(id, {}); }} /></label>
          </div>
        ) : (
          <p className="de-hint">
            Footprint size is edited on the placed garage.{' '}
            <button type="button" className="cw-linkbtn" onClick={() => planner.select(id)}>Load the B placement</button>
            {' '}— if none appears, place it in the Parking Scenario Planner first.
          </p>
        )}
        <TerminalAccess cruise={cruise} design={design} />
      </>
    );
  } else if (design.type === 'OPTIMIZE_SURFACE') {
    const amount = lotId => design.lotAdditions.find(l => l.assetId === lotId)?.additionalSpaces ?? 0;
    const setLot = (lotId, n) => cruise.editDesign(id, {
      lotAdditions: [...design.lotAdditions.filter(l => l.assetId !== lotId), ...(n > 0 ? [{ assetId: lotId, additionalSpaces: n }] : [])]
        .sort((a, b) => a.assetId.localeCompare(b.assetId)),
    });
    const checks = lots.filter(l => amount(l.id) > 0).map(l => checkSurfaceLot({ name: l.name, footprints: cruise.geometry.get(l.id), existing: l.capacity, added: amount(l.id), surfaceAreaPerSpaceM2: surface }));
    body = (
      <>
        <p className="de-hint">Add spaces to existing surface lots by reconfiguring them. Each lot keeps its existing spaces.</p>
        <table className="de-rows">
          <tbody>
            {sortFocus(lots).map(l => (
              <tr key={l.id} className={amount(l.id) ? 'is-on' : undefined}>
                <th scope="row">{l.name}{inFocus.has(l.id) ? <span className="de-focus">in view</span> : null}</th>
                <td><Stepper value={amount(l.id)} label={`spaces added to ${l.name}`} onChange={n => setLot(l.id, n)} /></td>
                <td className="de-total">{Number.isFinite(l.capacity) ? <>{fmt(l.capacity)}{amount(l.id) ? <> + {fmt(amount(l.id))} = <b>{fmt(l.capacity + amount(l.id))}</b></> : null}</> : <span className="cw-missing">capacity not published</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {checks.map(c => <CheckNote key={c.message} check={c} />)}
        <TerminalAccess cruise={cruise} design={design} ownLabel="Only the terminals each lot already serves" />
      </>
    );
  }

  return (
    <div className={`de-editor${compact ? ' is-compact' : ''}`}>
      {body}
      <CheckNote check={check} />
      <BeforeAfter cruise={cruise} id={id} />
      {editing && <p className="de-unsaved">Unsaved changes — already shown in every chart and comparison.</p>}
      <div className="de-actions">
        <button type="button" className="cw-btn is-primary" disabled={!cruise.designDirty} onClick={cruise.saveDesign}>Save design</button>
        <button type="button" className="cw-btn" disabled={!editing} onClick={cruise.cancelDesign}>Cancel changes</button>
        <button type="button" className="cw-btn" disabled={!editing} onClick={cruise.resetDesign}>Reset to saved design</button>
      </div>
    </div>
  );
}
