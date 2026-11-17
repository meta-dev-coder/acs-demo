/**
 * The Parking Expansion Scenario Planner.
 *
 * Map-first: the Cesium view is the workspace, and everything here floats over it — the scenario
 * column on the right, the results strip along the bottom. Three internal tabs rather than three
 * sidebar entries, because Plan, Simulate and Compare are stages of one task.
 *
 * Every number shown comes from a saved ScenarioRun. Nothing is illustrative: before a scenario
 * has been run the cards say so instead of showing a shape.
 *
 * The badge is permanent and the assumptions panel is one click away, because the single most
 * important thing this screen can communicate is which figures are verified (the garages, their
 * footprints, the roads) and which are invented (everything the model produces).
 */
import { useState } from 'react';
import {
  ASSUMPTIONS, ASSUMPTION_GROUPS, RECOMMENDATION_METRICS, SCENARIO_TYPE, SCENARIO_TYPE_LABEL,
  SITE_KIND,
} from '../config/scenarioPlanner.js';
import { ASSET_SOURCES, CAPACITY_VERIFICATION_LABEL } from '../config/infrastructure.js';
import { BASE_HEIGHT_SOURCE_LABEL, NUDGE_STEPS_M, PLACEMENT_KIND } from '../scenarios/garagePlacement.js';
import { MapControlButtons, PANEL_CAMERA_KEYS } from './MapControls.jsx';
import { PLANNER_TAB, VIEW_MODE } from '../hooks/useScenarioPlanner.js';
import { compareRuns } from '../scenarios/comparison.js';
import { CapacityChart, DemandChart, TrafficChart } from './ScenarioCharts.jsx';

const fmt = value => (Number.isFinite(value) ? Math.round(value).toLocaleString() : 'Not calculated');
const pct = value => (Number.isFinite(value) ? `${value.toFixed(0)}%` : 'Not calculated');
const ratio = value => (Number.isFinite(value) ? value.toFixed(2) : 'Not calculated');

/**
 * A labelled control.
 *
 * `<label>` only when it actually wraps an input or a select. A button is a labelable element
 * too, so wrapping one takes its accessible name from the label text instead of its own words —
 * a screen reader then announces "Candidate site" for a button that says "Pick site on map", and
 * `getByRole('button', {name: 'Pick site on map'})` finds nothing. Buttons and groups use
 * `FieldGroup`, which is a plain div.
 */
function Field({ label, children, note }) {
  return (
    <label className="scenario-field">
      <span className="scenario-field-label">{label}</span>
      {children}
      {note && <span className="scenario-field-note">{note}</span>}
    </label>
  );
}

function FieldGroup({ label, children, note }) {
  return (
    <div className="scenario-field">
      <span className="scenario-field-label">{label}</span>
      {children}
      {note && <span className="scenario-field-note">{note}</span>}
    </div>
  );
}

/**
 * `ariaLabel` is for the cases where the input cannot sit inside its `<label>`.
 *
 * A `<label>` that wraps a button takes its accessible name from the label text, so a field with
 * buttons beside it has to use `FieldGroup` — a plain div — and the input then has no label to be
 * named by. Naming it directly keeps it reachable by name instead of by position.
 */
function NumberInput({ value, onChange, step = 1, min = 0, ariaLabel }) {
  return (
    <input
      type="number" value={value} step={step} min={min} aria-label={ariaLabel}
      onChange={event => {
        const next = event.target.value;
        onChange(next === '' ? '' : Number(next));
      }}
    />
  );
}

/**
 * A collapsible block.
 *
 * The placement editor adds four groups of controls to a panel that is already tall, and the map
 * is the thing the user is looking at. Collapsing keeps every control reachable without pushing
 * the scene off the screen.
 */
function Collapsible({ title, summary, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`scenario-collapsible${open ? ' is-open' : ''}`}>
      <button type="button" className="scenario-collapsible-head"
        aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className="scenario-collapsible-title">{title}</span>
        {summary && <span className="scenario-collapsible-summary">{summary}</span>}
        <span className="scenario-collapsible-chevron" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="scenario-collapsible-body">{children}</div>}
    </div>
  );
}

/** One assumption row, with the basis that makes it readable as an assumption. */
function AssumptionRow({ id, value, onChange }) {
  const meta = ASSUMPTIONS[id];
  if (!meta) return null;
  return (
    <div className="assumption-row">
      <div className="assumption-head">
        <span>{meta.label}</span>
        <span className="assumption-value">
          <NumberInput value={value} onChange={next => onChange(id, next)} step={meta.unit === '%' ? 1 : 0.1} />
          <em>{meta.unit}</em>
        </span>
      </div>
      <p className="assumption-basis">{meta.basis}</p>
    </div>
  );
}

function AssumptionsPanel({ scenario, setAssumption, onReset }) {
  return (
    <div className="scenario-assumptions">
      <div className="scenario-assumptions-head">
        <p>Every figure below is an assumption, with its basis. Change one and re-run to see every result move.</p>
        <button type="button" onClick={onReset}>Reset to defaults</button>
      </div>
      {ASSUMPTION_GROUPS.map(group => (
        <section key={group.id}>
          <h4>{group.label}</h4>
          {Object.entries(ASSUMPTIONS)
            .filter(([, meta]) => meta.group === group.id)
            .map(([id]) => (
              <AssumptionRow key={id} id={id} value={scenario.assumptions[id]} onChange={setAssumption} />
            ))}
        </section>
      ))}
    </div>
  );
}

/**
 * Choosing the geometry for a garage.
 *
 * Three states, and the UI never blurs them: a reviewer's confirmed link, a shape a reviewer
 * traced, or a candidate the twin merely suggests. Around Garage A the candidate is the TERMINAL's
 * polygon — the garage shares the terminal's published address — so the offer to confirm it is
 * deliberately the least prominent of the three paths.
 */
function GeometryPicker({ planner, buildingsById, onLinkFootprint }) {
  const { footprints, geometryMode, picked, tracePoints, selected, geometryState, migration } = planner;
  const tier = footprints.tier;
  const combinedAreaM2 = footprints.areaM2
    ?? footprints.footprints.reduce((total, f) => total + (f.groundAreaM2 ?? 0), 0);

  // The read's own state. A failure is shown as a failure: the app does not quietly fall back to
  // an unconfirmed candidate because the geometry service was unreachable.
  if (geometryState === 'LOADING') {
    return <div className="scenario-geometry"><h4>Garage geometry</h4>
      <p className="scenario-empty">Loading garage geometry…</p></div>;
  }
  if (geometryState === 'FAILED') {
    return <div className="scenario-geometry"><h4>Garage geometry</h4>
      <p className="scenario-warn">Geometry could not be loaded: {planner.geometryError}</p>
      <p className="scenario-field-note">Nothing is drawn from a stale or guessed shape while the
        service is unreachable.</p></div>;
  }

  if (geometryMode === 'SELECT') {
    const chosen = picked.map(objectId => buildingsById.get(objectId)).filter(Boolean);
    const area = chosen.reduce((total, b) => total + (b.groundAreaM2 ?? 0), 0);
    return (
      <div className="scenario-geometry is-active">
        <h4>Click the garage’s footprints on the map</h4>
        <p className="scenario-field-note">
          Several are allowed — a garage is often more than one feature. Click a chosen one again
          to take it off.
        </p>
        {chosen.length === 0
          ? <p className="scenario-empty">Nothing picked yet.</p>
          : <ul className="scenario-picked">
            {chosen.map(building => (
              <li key={building.objectId}>
                <span>OBJECTID {building.objectId}</span>
                <span>{fmt(building.groundAreaM2)} m²</span>
                <button type="button" onClick={() => planner.togglePicked(building.objectId)}>Remove</button>
              </li>
            ))}
            <li className="scenario-picked-total">
              <span>Combined</span><span>{fmt(area)} m²</span><span />
            </li>
          </ul>}
        <div className="scenario-geometry-actions">
          <button type="button" className="scenario-run" disabled={picked.length === 0}
            onClick={planner.confirmPicked}>Confirm {picked.length || ''} footprint{picked.length === 1 ? '' : 's'}</button>
          <button type="button" className="scenario-secondary" onClick={() => planner.setMode(null)}>Cancel</button>
        </div>
      </div>
    );
  }

  if (geometryMode === 'DRAW') {
    return (
      <div className="scenario-geometry is-active">
        <h4>Trace the garage outline</h4>
        <p className="scenario-field-note">
          Click each corner on the map. What you trace is stored as a user-defined shape — not a
          surveyed footprint, and never written into the county GeoJSON.
        </p>
        <p className="scenario-empty">{tracePoints.length} point{tracePoints.length === 1 ? '' : 's'} placed.</p>
        <div className="scenario-geometry-actions">
          <button type="button" className="scenario-run" disabled={tracePoints.length < 3}
            onClick={planner.finishTrace}>Finish outline</button>
          <button type="button" className="scenario-secondary" disabled={tracePoints.length === 0}
            onClick={planner.undoTracePoint}>Undo point</button>
          <button type="button" className="scenario-secondary" onClick={() => planner.setMode(null)}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="scenario-geometry">
      <h4>Garage geometry</h4>

      {/* A write that failed is shown here. Without this the panel would quietly keep displaying
          the unconfirmed candidate as though nothing had been attempted. */}
      {planner.geometryError && (
        <p className="scenario-warn">Geometry was not saved: {planner.geometryError}</p>
      )}

      {/* A shape this browser traced before the server store existed. Offered, never imported
          silently, and reported as a conflict when the server already holds one. */}
      {migration && (
        <div className="scenario-candidate">
          <p>
            This browser holds a footprint traced for {selected.site.label ?? 'this asset'} before
            geometry was stored on the server — {migration.areaM2.toLocaleString()} m²,{' '}
            {migration.source === 'MANUALLY_DIGITIZED' ? 'manually digitised' : migration.source},{' '}
            {migration.verificationStatus}.
            {migration.conflict
              ? ` The server already holds a ${migration.serverAreaM2?.toLocaleString()} m² record for it — importing would replace what every other browser sees.`
              : ' Import it so every browser sees it?'}
          </p>
          <div className="scenario-geometry-actions">
            <button type="button" className="scenario-secondary" onClick={planner.importLegacy}>
              {migration.conflict ? 'Replace the server record' : 'Import to server'}
            </button>
            <button type="button" className="scenario-secondary" onClick={planner.dismissMigration}>
              Keep it local
            </button>
          </div>
        </div>
      )}

      {(tier === 'AUTHORITATIVE' || tier === 'CONFIRMED_GIS') && (
        <p className="scenario-geometry-state is-verified">
          {footprints.footprints.length} confirmed footprint{footprints.footprints.length === 1 ? '' : 's'} ·{' '}
          {fmt(combinedAreaM2)} m² combined ·{' '}
          {footprints.footprints.map(f => f.objectId).join(', ')}
        </p>
      )}
      {tier === 'CONFIRMED_TRACED' && (
        <p className="scenario-geometry-state is-assumed">
          Traced by a reviewer · {fmt(combinedAreaM2)} m² · user-defined shape, not a survey
        </p>
      )}
      {/* The record's own metadata, so provenance travels with the shape. */}
      {footprints.geometryAvailable && (
        <dl className="scenario-geometry-meta">
          <dt>Source</dt><dd>{footprints.geometrySource}</dd>
          <dt>Status</dt><dd>{footprints.verificationStatus}</dd>
          {footprints.buildingObjectIds?.length > 0 && (
            <>
              <dt>Building OBJECTIDs</dt><dd>{footprints.buildingObjectIds.join(', ')}</dd>
            </>
          )}
          <dt>Height source</dt>
          <dd>{selected.heightSource === 'ESTIMATED_FROM_3D_TILES'
            ? 'Estimated from the rendered 3D tiles — a visualisation estimate, not a survey'
            : selected.heightSource === 'OPERATOR'
              ? 'Set by hand — an assumption'
              : 'Placeholder assumption'}</dd>
          {footprints.updatedAt && (<><dt>Updated</dt><dd>{new Date(footprints.updatedAt).toLocaleString()}</dd></>)}
        </dl>
      )}
      {tier === 'CANDIDATE' && (
        <>
          <p className="scenario-geometry-state is-assumed">
            Not confirmed. The shape on the map is OBJECTID {footprints.candidate.objectId}
            {' '}({fmt(footprints.candidate.groundAreaM2)} m²) — the footprint this address fronts
            onto, shown in amber as evidence.
          </p>
          <p className="scenario-field-note">
            This garage shares its published address with a cruise terminal, so the address alone
            cannot tell them apart. Pick the real footprints, or trace them.
          </p>
        </>
      )}
      {tier === 'NONE' && (
        <p className="scenario-geometry-state is-missing">
          {selected.site.label ?? 'This garage'} does not yet have a confirmed footprint.
          Pick one on the map, or trace it.
        </p>
      )}
      {!planner.geometryWritable && (
        <p className="scenario-readonly">
          <strong>Read-only.</strong> {planner.readOnlyReason
            ?? 'Geometry editing is disabled on this deployment.'} Saved footprints still load and
          render; they just cannot be changed from here.
        </p>
      )}
      {/* The geometry TOOLS are not in the demo panel: a footprint is established once, by a
          reviewer, and then it is a fact about the port rather than a control someone needs in
          front of them. The state above still says which footprint is in use and how firm it is. */}
    </div>
  );
}

// ---- the proposed garage's placement -----------------------------------------------------------

/**
 * Move, rotate, resize and check a proposed garage.
 *
 * Shown for the NEW GARAGE alternative only, because it is the only one that proposes a building
 * where none exists. Everything here describes a PROPOSAL: a rectangle someone dragged into
 * position over the tiles. It is not a site, a design, a permission or a survey, and each block
 * says which of its numbers are measured, which are assumed, and which were simply not checked.
 */
function PlacementSection({ planner }) {
  const { placement } = planner;
  const { draft, saved, editing, validation, capacity, conflicts } = placement;
  const surface = draft?.kind === PLACEMENT_KIND.SURFACE_LOT;
  const noun = surface ? 'surface lot' : 'garage';
  const [saveNote, setSaveNote] = useState(null);
  /** How far one press of an arrow moves the building. */
  const [nudgeStep, setNudgeStep] = useState(5);

  const onSave = () => {
    const result = placement.save();
    setSaveNote(result.ok
      ? { tone: result.warning ? 'warn' : 'ok', text: result.warning ?? 'Placement saved.' }
      : { tone: 'error', text: result.reason });
  };

  const onReset = () => {
    // Destructive and not obviously undoable, so it asks first.
    if (!globalThis.confirm?.('Discard this proposed garage and its saved placement?')) return;
    placement.reset();
    setSaveNote(null);
  };

  const field = (key, step = 1) => ({
    value: draft?.[key] ?? '',
    onChange: next => { setSaveNote(null); placement.setField(key, next === '' ? '' : next); },
    step,
  });

  if (!draft) {
    return (
      <div className="scenario-placement">
        <FieldGroup label="Proposed placement"
          note="Pick a location on the map to create the proposal. It is a conceptual shape you position yourself — not a site, a design or a permission.">
          <button type="button" className={`scenario-pick${planner.sitePicker.active ? ' is-armed' : ''}`}
            onClick={planner.sitePicker.toggle}>
            {planner.sitePicker.active ? 'Click the map…' : 'Pick location'}
          </button>
        </FieldGroup>
      </div>
    );
  }

  const areaM2 = draft.lengthM * draft.widthM;
  const totalHeight = draft.floors * draft.floorHeightM;
  const dimensionsSummary = `${Math.round(draft.lengthM)} × ${Math.round(draft.widthM)} m · `
    + (surface ? `${fmt(areaM2)} m²` : `${draft.floors} floors`);

  return (
    <div className="scenario-placement">
      <div className="scenario-placement-actions">
        <button type="button" className={`scenario-pick${planner.sitePicker.active ? ' is-armed' : ''}`}
          onClick={planner.sitePicker.toggle}>
          {planner.sitePicker.active ? 'Click the map…' : 'Pick location'}
        </button>
        {editing ? (
          <>
            <button type="button" className="scenario-primary" onClick={onSave}>Save placement</button>
            <button type="button" className="scenario-secondary" onClick={placement.cancelEditing}>Cancel</button>
          </>
        ) : (
          <button type="button" className="scenario-secondary" onClick={placement.startEditing}>
            Edit placement
          </button>
        )}
        <button type="button" className="scenario-secondary" onClick={placement.frame}>Frame</button>
        <button type="button" className="scenario-secondary is-danger" onClick={onReset}>Reset</button>
      </div>

      {editing && (
        <p className="scenario-hint">
          {`Drag the white handle ${surface ? 'in the middle' : 'on the roof'} to move it, the amber arm `}
          to rotate it, and the handles on the footprint to change its length and width.
          Escape stops editing.
        </p>
      )}
      {surface && (
        <p className="scenario-field-note">
          A surface reconfiguration proposes <strong>no structure</strong>: this is the area being
          re-laid out, drawn flat on the ground, with no floors and no height.
        </p>
      )}
      {saveNote && <p className={`scenario-${saveNote.tone === 'error' ? 'error' : saveNote.tone === 'warn' ? 'warn' : 'ok'}`}>{saveNote.text}</p>}
      {!validation.ok && validation.errors.map(error => (
        <p className="scenario-error" key={error}>{error}</p>
      ))}

      <Collapsible title="Placement" defaultOpen
        summary={`${draft.centerLatitude?.toFixed(5)}, ${draft.centerLongitude?.toFixed(5)} · ${Math.round(draft.headingDegrees)}°`}>
        <div className="scenario-grid-2">
          <Field label="Latitude"><NumberInput {...field('centerLatitude', 0.00001)} min={-90} /></Field>
          <Field label="Longitude"><NumberInput {...field('centerLongitude', 0.00001)} min={-180} /></Field>
        </div>
        {/* Arrows move the building in ITS OWN frame: forward is down the length axis, so a
            rotated garage still slides along its own walls rather than diagonally across them. */}
        <FieldGroup label="Move"
          note={`Exact metres, along the ${noun}'s own axes. Forward follows the rotation above.`}>
          <div className="scenario-nudge">
            <div className="scenario-nudge-pad">
              <button type="button" className="is-up" title={`Forward ${nudgeStep} m`}
                aria-label={`Move forward ${nudgeStep} metres`}
                onClick={() => placement.nudgeBy(nudgeStep, 0)}>↑</button>
              <button type="button" className="is-left" title={`Left ${nudgeStep} m`}
                aria-label={`Move left ${nudgeStep} metres`}
                onClick={() => placement.nudgeBy(0, -nudgeStep)}>←</button>
              <button type="button" className="is-right" title={`Right ${nudgeStep} m`}
                aria-label={`Move right ${nudgeStep} metres`}
                onClick={() => placement.nudgeBy(0, nudgeStep)}>→</button>
              <button type="button" className="is-down" title={`Back ${nudgeStep} m`}
                aria-label={`Move back ${nudgeStep} metres`}
                onClick={() => placement.nudgeBy(-nudgeStep, 0)}>↓</button>
            </div>
            <div className="scenario-nudge-steps" role="group" aria-label="Step size">
              {NUDGE_STEPS_M.map(step => (
                <button type="button" key={step}
                  className={step === nudgeStep ? 'is-selected' : undefined}
                  aria-pressed={step === nudgeStep}
                  onClick={() => setNudgeStep(step)}>{step} m</button>
              ))}
            </div>
          </div>
        </FieldGroup>
        <Field label="Rotation (° clockwise from north)">
          <NumberInput {...field('headingDegrees', 1)} min={-360} />
        </Field>
        <div className="scenario-placement-rotate">
          <button type="button" onClick={() => placement.rotateBy(-15)}>−15°</button>
          <button type="button" onClick={() => placement.rotateBy(15)}>+15°</button>
          <button type="button" onClick={() => placement.setField('headingDegrees', 0)}>Reset to 0°</button>
        </div>
        <label className="scenario-checkline">
          <input type="checkbox" checked={placement.snapping}
            onChange={event => placement.setSnapping(event.target.checked)} />
          <span>Snap rotation to 15° steps while dragging</span>
        </label>
        <FieldGroup label="Base elevation"
          note={BASE_HEIGHT_SOURCE_LABEL[draft.baseHeightSource]}>
          <div className="scenario-grid-2">
            <NumberInput {...field('baseHeightM', 0.1)} min={-100} ariaLabel="Base elevation (m)" />
            <button type="button" className="scenario-secondary" onClick={placement.resample}>
              Re-sample ground
            </button>
          </div>
        </FieldGroup>
      </Collapsible>

      <Collapsible title={surface ? 'Lot dimensions' : 'Building dimensions'} defaultOpen
        summary={dimensionsSummary}>
        <div className="scenario-grid-2">
          <Field label="Length (m)"><NumberInput {...field('lengthM', 1)} /></Field>
          <Field label="Width (m)"><NumberInput {...field('widthM', 1)} /></Field>
          {/* No floors control for a surface lot: there is no storey to add, and a disabled
              input holding a number would still look like one that could be changed. */}
          {!surface && (
            <>
              <FieldGroup label="Floors">
                <div className="scenario-stepper">
                  <button type="button" aria-label="Remove a floor"
                    disabled={draft.floors <= placement.limits.floors.min}
                    onClick={() => placement.changeFloorsBy(-1)}>−</button>
                  <NumberInput {...field('floors', 1)} min={1} ariaLabel="Floors" />
                  <button type="button" aria-label="Add a floor"
                    disabled={draft.floors >= placement.limits.floors.max}
                    onClick={() => placement.changeFloorsBy(1)}>+</button>
                </div>
              </FieldGroup>
              <Field label="Floor height (m)"><NumberInput {...field('floorHeightM', 0.1)} /></Field>
            </>
          )}
        </div>
        <dl className="scenario-readout">
          <dt>{surface ? 'Lot area' : 'Footprint area'}</dt><dd>{fmt(areaM2)} m²</dd>
          {surface
            ? <><dt>Structure proposed</dt><dd>None</dd></>
            : <><dt>Total conceptual height</dt><dd>{areaM2 ? totalHeight.toFixed(1) : '—'} m</dd></>}
        </dl>
      </Collapsible>

      <Collapsible title="Parking capacity"
        summary={capacity?.estimatedSpaces === null || capacity === null
          ? 'Not evaluated'
          : `${fmt(capacity.estimatedSpaces)} of ${fmt(capacity.targetSpaces)} spaces`}>
        {capacity?.reason ? <p className="scenario-empty">{capacity.reason}</p> : (
          <>
            <dl className="scenario-readout">
              <dt>Target capacity (requested)</dt><dd>{fmt(capacity.targetSpaces)} spaces</dd>
              <dt>Estimated capacity (this geometry)</dt><dd>{fmt(capacity.estimatedSpaces)} spaces</dd>
              <dt>Difference</dt>
              <dd className={capacity.meetsTarget ? 'is-verified' : 'is-missing'}>
                {capacity.differenceSpaces > 0 ? '+' : ''}{fmt(capacity.differenceSpaces)} spaces
              </dd>
              <dt>{surface ? 'Lot area' : 'Gross floor area'}</dt>
              <dd>{fmt(capacity.grossFloorAreaM2)} m²</dd>
              <dt>{surface ? 'Surface area per space (assumed)' : 'Gross area per space (assumed)'}</dt>
              <dd>{capacity.grossAreaPerSpaceM2} m²</dd>
            </dl>
            {/* The one thing that must never be quietly reconciled: the simulation runs on the
                REQUESTED figure, so a geometry that cannot hold it is a warning about the model's
                own input, not something the model has allowed for. */}
            {capacity.meetsTarget === false && (
              <p className="scenario-warn">
                This geometry supports about {fmt(capacity.estimatedSpaces)} spaces at{' '}
                {capacity.grossAreaPerSpaceM2} m² per space, which is{' '}
                {fmt(Math.abs(capacity.differenceSpaces))} short of the {fmt(capacity.targetSpaces)}{' '}
                requested. The simulation still runs on the requested figure. Either enlarge the
                {` ${noun}`}, lower the target in Assumptions, or record that the shortfall is
                accepted — the planner will not change your target for you.
              </p>
            )}
          </>
        )}
      </Collapsible>

      <Collapsible title="Site constraints"
        summary={conflicts
          ? `${conflicts.conflicts} conflict${conflicts.conflicts === 1 ? '' : 's'} · ${conflicts.checks.length - conflicts.evaluated} not evaluated`
          : 'Not evaluated'}>
        {conflicts ? (
          <ul className="scenario-conflicts">
            {conflicts.checks.map(check => (
              <li key={check.id} className={`is-${check.status.toLowerCase()}`}>
                <strong>{check.label}</strong>
                <span>{check.detail}</span>
              </li>
            ))}
          </ul>
        ) : <p className="scenario-empty">Not evaluated — there is no placement yet.</p>}
        <p className="scenario-field-note">
          A geometric overlap test against the layers this twin holds. Finding no overlap does not
          mean a garage can be built here.
        </p>
      </Collapsible>

      <p className="scenario-field-note">
        {saved
          ? `Saved placement from ${new Date(saved.updatedAt).toLocaleString()}. It is restored when you reopen this scenario.`
          : 'Not saved yet — this proposal will be lost on reload until you save it.'}
      </p>
    </div>
  );
}

// ---- Plan -------------------------------------------------------------------------------------

function PlanTab({ planner, garages, roadsById, onLinkFootprint, buildingsById }) {
  const { selected, setGarage, setAccessRoad, sitePicker, viewMode, setViewMode } = planner;
  if (!selected) return <p className="scenario-empty">Add a scenario to begin.</p>;

  const isExpand = selected.type === SCENARIO_TYPE.EXPAND_EXISTING;
  /** Both of the alternatives that propose something where the registry has nothing. */
  const isPlaceable = selected.type === SCENARIO_TYPE.NEW_GARAGE
    || selected.type === SCENARIO_TYPE.OPTIMIZE_SURFACE;
  const footprint = planner.footprintFor(selected);
  /**
   * The one line that stands in for the block when it is closed.
   *
   * Identity, then how firm the geometry is, then whether the capacity is published or assumed —
   * the three things someone would otherwise have to open the block to find out.
   */
  const provenanceSummary = [
    selected.site.label ?? (selected.site.point ? 'Candidate site' : 'Not selected'),
    isPlaceable
      ? (planner.placement?.draft ? 'placed by you' : 'nothing placed')
      : footprint?.verified
        ? ((footprint.buildings?.length ?? 1) > 1
          ? `${footprint.buildings.length} confirmed footprints` : 'confirmed footprint')
        : 'footprint not confirmed',
    selected.capacitySource
      ? `${fmt(selected.capacitySource.spaces)} spaces published`
      : `${fmt(selected.assumptions.existingCapacity)} spaces assumed`,
  ].join(' · ');

  const roadOptions = selected.site.assetId
    ? (planner.selected ? (garages.find(g => g.id === selected.site.assetId)?.candidates?.roads ?? []) : [])
    : [];

  return (
    <div className="scenario-tab">
      {isExpand ? (
        <Field label="Registered garage"
          note="From the infrastructure registry. Verified name and address; no coordinate is published by the source.">
          <select value={selected.site.assetId ?? ''} onChange={e => setGarage(e.target.value || null)}>
            <option value="">Select a garage…</option>
            {garages.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
          </select>
        </Field>
      ) : isPlaceable ? (
        <PlacementSection planner={planner} />
      ) : (
        <FieldGroup label="Candidate site"
          note="A point you pick on the map. It carries no claim about ownership, zoning, utilities or constructability.">
          <button type="button" className={`scenario-pick${sitePicker.active ? ' is-armed' : ''}`}
            onClick={sitePicker.toggle}>
            {sitePicker.active ? 'Click the map…' : selected.site.point ? 'Pick a different site' : 'Pick site on map'}
          </button>
        </FieldGroup>
      )}

      {/* The data-provenance block: what is verified, what is assumed, kept visibly apart. */}
      {/* Collapsible, but its SUMMARY still carries the claim: who this is, how firm the
          footprint is, and whether the capacity is published or assumed. Collapsing hides the
          detail, never the fact that a figure is an assumption. */}
      <Collapsible title="What this scenario is built on" summary={provenanceSummary} defaultOpen>
      <div className="scenario-provenance">
        <dl>
          <dt>Garage identity</dt>
          <dd className={selected.site.assetId ? 'is-verified' : 'is-missing'}>
            {selected.site.label ?? (selected.site.point ? 'Candidate site — not a registered asset' : 'Not selected')}
          </dd>
          <dt>Building footprint</dt>
          {/* A new garage has no footprint to find — it has a proposal someone positioned, and
              saying "not linked" about it reads as a missing fact rather than a design choice. */}
          {isPlaceable ? (
            <dd className="is-assumed">
              {planner.placement?.draft
                ? `${planner.placement.draft.kind === PLACEMENT_KIND.SURFACE_LOT
                  ? 'Proposed surface area' : 'Proposed garage'} — `
                  + `${Math.round(planner.placement.draft.lengthM)} × `
                  + `${Math.round(planner.placement.draft.widthM)} m, `
                  + (planner.placement.draft.kind === PLACEMENT_KIND.SURFACE_LOT
                    ? 'no structure, ' : `${Math.max(1, Math.round(planner.placement.draft.floors))} floors, `)
                  + `${Math.round(planner.placement.draft.headingDegrees)}° — a shape you placed, `
                  + 'not a surveyed footprint'
                : 'Nothing proposed yet — pick a location on the map'}
            </dd>
          ) : (
          <dd className={footprint?.verified ? 'is-verified' : 'is-assumed'}>
            {footprint?.verified
              ? (footprint.buildings?.length ?? 1) > 1
                // A garage the county file splits into several parts: say so and give the
                // combined area, rather than naming the first part as if it were the whole.
                ? `${footprint.buildings.length} confirmed footprints · ${fmt(footprint.areaM2)} m² combined`
                : `Confirmed footprint OBJECTID ${footprint.building.objectId} · ${fmt(footprint.areaM2 ?? footprint.building.groundAreaM2)} m²`
              : footprint
                ? `Indicative pad, ${fmt(footprint.areaM2)} m², sized from your own spaces/floors assumptions`
                : planner.footprints.candidate
                  ? `Not linked — candidate OBJECTID ${planner.footprints.candidate.objectId} shown in amber`
                  : 'Garage footprint not linked'}
          </dd>
          )}
          <dt>Existing capacity</dt>
          {/* A published figure and a placeholder are different claims, and look different. */}
          {selected.capacitySource ? (
            <dd className={selected.capacitySource.verification === 'VERIFIED' ? 'is-verified' : 'is-assumed'}>
              {fmt(selected.capacitySource.spaces)} spaces — published,{' '}
              {CAPACITY_VERIFICATION_LABEL[selected.capacitySource.verification].toLowerCase()}
              {ASSET_SOURCES[selected.capacitySource.sourceId]
                && ` (${ASSET_SOURCES[selected.capacitySource.sourceId].publisher}, ${selected.capacitySource.asOf})`}
            </dd>
          ) : (
            <dd className="is-assumed">{fmt(selected.assumptions.existingCapacity)} spaces — assumed; no source publishes one</dd>
          )}
          <dt>Proposed addition</dt>
          <dd className="is-assumed">{fmt(selected.assumptions.additionalSpaces)} spaces — editable assumption</dd>
        </dl>
        {isExpand && selected.site.assetId && (
          <GeometryPicker planner={planner} buildingsById={buildingsById} onLinkFootprint={onLinkFootprint} />
        )}
        {planner.highlightNotes.map(note => (
          <p key={note} className="scenario-scope">{note}</p>
        ))}
      </div>
      </Collapsible>

      <div className="scenario-row">
        <Field label="Additional spaces">
          <NumberInput value={selected.assumptions.additionalSpaces}
            onChange={v => planner.setAssumption('additionalSpaces', v)} step={50} />
        </Field>
        <Field label="Added floors">
          <NumberInput value={selected.assumptions.addedFloors}
            onChange={v => planner.setAssumption('addedFloors', v)} />
        </Field>
      </div>

      <FieldGroup label="3D view">
        <div className="scenario-toggle" role="group" aria-label="Existing or proposed">
          {[VIEW_MODE.EXISTING, VIEW_MODE.PROPOSED, VIEW_MODE.BOTH].map(mode => (
            <button key={mode} type="button" aria-pressed={viewMode === mode}
              onClick={() => setViewMode(mode)}>
              {mode === VIEW_MODE.BOTH ? 'Both' : mode === VIEW_MODE.EXISTING ? 'Existing' : 'Proposed'}
            </button>
          ))}
        </div>
      </FieldGroup>
      <button type="button" className="scenario-secondary" onClick={planner.flyToScenario}>
        Frame on map
      </button>
    </div>
  );
}

// ---- Simulate ----------------------------------------------------------------------------------

function SimulateTab({ planner }) {
  const { selected, validation, latest, busy } = planner;
  const [showAssumptions, setShowAssumptions] = useState(false);
  if (!selected) return <p className="scenario-empty">Add a scenario to begin.</p>;
  const r = latest?.results;

  return (
    <div className="scenario-tab">
      {validation?.blocking?.length > 0 && (
        <ul className="scenario-blocking">
          {validation.blocking.map(reason => <li key={reason}>{reason}</li>)}
        </ul>
      )}
      {validation?.warnings?.map(warning => (
        <p key={warning} className="scenario-warn">{warning}</p>
      ))}

      <button type="button" className="scenario-run" disabled={!validation?.ok || busy}
        onClick={planner.run}>
        {busy ? 'Running…' : '▶  Run Simulation'}
      </button>

      {latest ? (
        <>
          <p className="scenario-runmeta">
            Run {latest.id} · model {latest.modelVersion} · {new Date(latest.executedAt).toLocaleString()} · {latest.dataMode}
          </p>
          <dl className="scenario-results">
            <dt>Existing capacity</dt>
            <dd>{fmt(r.capacity.existingCapacity)}
              <em> · {latest.inputSnapshot.capacitySource
                ? `published, ${CAPACITY_VERIFICATION_LABEL[latest.inputSnapshot.capacitySource.verification].toLowerCase()}`
                : 'placeholder assumption'}</em>
            </dd>
            <dt>Additional spaces</dt><dd>{fmt(r.capacity.additionalSpaces)}</dd>
            <dt>Proposed total capacity</dt><dd>{fmt(r.capacity.proposedTotalCapacity)}</dd>
            <dt>Increase</dt><dd>{pct(r.capacity.increasePct)}</dd>
            <dt>Usable at {fmt(selected.assumptions.utilisationPct)}%</dt><dd>{fmt(r.capacity.usableCapacity)}</dd>
            <dt>Added floors / height</dt>
            <dd>{r.capacity.addedFloors} floors · {Number.isFinite(r.capacity.addedHeightM) ? `${r.capacity.addedHeightM.toFixed(1)} m added` : 'n/a'}
              {r.capacity.existingHeightM === null && <em> · existing height not published, so no total is reported</em>}
            </dd>
            <dt>Forecast demand {selected.assumptions.forecastYear}</dt><dd>{fmt(r.demand.forecastDemand)}</dd>
            <dt>Demand served</dt><dd>{fmt(r.demand.served)} ({pct(r.demand.coveragePct)})</dd>
            <dt>Unmet demand</dt><dd>{fmt(r.demand.unmet)}</dd>
            <dt>Added peak-hour vehicles</dt><dd>{fmt(r.trips.total)} ({fmt(r.trips.arrivals)} in, {fmt(r.trips.departures)} out)</dd>
            <dt>Access road</dt><dd>{r.traffic.road?.name ?? 'None nominated'}</dd>
            <dt>Modelled V/C</dt><dd>{ratio(r.traffic.vcRatio)}</dd>
            <dt>Peak queue</dt>
            <dd>{Number.isFinite(r.traffic.queue?.peakQueue) ? `${Math.round(r.traffic.queue.peakQueue)} veh` : 'Not calculated'}</dd>
            <dt>Clearance</dt>
            <dd>{r.traffic.queue?.clearanceMinutes === null ? 'Does not clear — demand ≥ capacity'
              : Number.isFinite(r.traffic.queue?.clearanceMinutes) ? `${r.traffic.queue.clearanceMinutes.toFixed(0)} min` : 'Not calculated'}</dd>
          </dl>
          {r.traffic.scope && <p className="scenario-scope">{r.traffic.scope}</p>}
          {r.geometryCheck?.additionalSpaces != null && (
            <p className="scenario-scope">
              Cross-check: this footprint over {selected.assumptions.addedFloors} floors would hold about{' '}
              {fmt(r.geometryCheck.additionalSpaces)} spaces at {selected.assumptions.grossAreaPerSpaceM2} m² gross each.
            </p>
          )}
          {latest.warnings.map(warning => <p key={warning} className="scenario-warn">{warning}</p>)}
        </>
      ) : (
        <p className="scenario-empty">Not run yet. Nothing is shown until the model has produced it.</p>
      )}

      <button type="button" className="scenario-secondary" onClick={() => setShowAssumptions(v => !v)}
        aria-expanded={showAssumptions}>
        {showAssumptions ? 'Hide assumptions' : 'Show assumptions'}
      </button>
      {showAssumptions && (
        <AssumptionsPanel scenario={selected} setAssumption={planner.setAssumption} onReset={planner.reset} />
      )}
    </div>
  );
}

// ---- Compare ------------------------------------------------------------------------------------

function CompareTab({ planner }) {
  const rows = compareRuns(planner.comparable);
  const { recommendation } = planner;
  if (rows.length === 0) return <p className="scenario-empty">Run at least one scenario to compare.</p>;
  const demand = rows.find(r => Number.isFinite(r.metrics.forecastDemand))?.metrics.forecastDemand ?? null;

  return (
    <div className="scenario-tab">
      <div className="scenario-recommend">
        <h4>Recommendation</h4>
        {recommendation.available
          ? <>
            <p className="scenario-rec-line">{recommendation.reason}</p>
            <ol className="scenario-ranking">
              {recommendation.ranking.map((row, i) => (
                <li key={row.runId}>
                  <span className="scenario-rank">{i + 1}</span>
                  <span className="scenario-rank-name">{row.name}</span>
                  <span className="scenario-rank-score">{row.score.toFixed(3)}</span>
                </li>
              ))}
            </ol>
            <details>
              <summary>How this was scored</summary>
              <ul className="scenario-weights">
                {recommendation.metricsUsed.map(metric => (
                  <li key={metric.id}>
                    <strong>{metric.label}</strong> · weight {metric.weight} · {metric.direction} is better — {metric.why}
                  </li>
                ))}
              </ul>
              <p className="scenario-excluded-head">Not counted:</p>
              <ul className="scenario-weights">
                {recommendation.excluded.map(reason => <li key={reason}>{reason}</li>)}
              </ul>
            </details>
          </>
          : <p className="scenario-warn">{recommendation.reason}</p>}
      </div>

      <table className="scenario-table">
        <thead>
          <tr>
            <th scope="col">Metric</th>
            {rows.map(row => <th key={row.runId} scope="col">{row.key ?? row.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {[
            ['Parking capacity', row => fmt(row.metrics.capacity)],
            ['Added spaces', row => fmt(row.metrics.addedSpaces)],
            ['Peak demand served', row => fmt(row.metrics.demandServed)],
            ['Unmet demand', row => fmt(row.metrics.unmetDemand)],
            ['Added peak-hour vehicles', row => fmt(row.metrics.addedVehicles)],
            ['Access road V/C', row => ratio(row.metrics.accessVc)],
            ['Peak queue (veh)', row => (Number.isFinite(row.metrics.peakQueue) ? Math.round(row.metrics.peakQueue).toLocaleString() : 'Not modelled')],
            ['Construction disruption index', row => (Number.isFinite(row.metrics.constructionDisruption) ? row.metrics.constructionDisruption.toFixed(1) : '—')],
          ].map(([label, read]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {rows.map(row => <td key={row.runId}>{read(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>

      <CapacityChart rows={rows} demand={demand} />
      <DemandChart run={planner.latest ?? planner.comparable[0]} rows={rows} />
      <TrafficChart rows={rows} />
    </div>
  );
}

// ---- the workspace --------------------------------------------------------------------------------

export function ScenarioPlanner({
  planner, garages, roadsById, buildingsById, onOpenAssistant, onLinkFootprint,
  open, onOpenChange, cameraHandlers,
}) {
  const { tab, setTab, selected, scenarios, findings, latest } = planner;
  /** Closed on arrival: the workspace opens on the map, not on a form. Owned by App, because the
      map-control column has to step aside while it is open. */
  const setOpen = onOpenChange;
  const r = latest?.results;

  return (
    <>
      {/* The planner opens from a button rather than sitting over the map permanently, so the
          3D view is the default state of this workspace. */}
      {!open && (
      <button
        type="button"
        className="scenario-open"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        Plan &amp; simulate
      </button>
      )}

      {open && (
      <>
      {/* While picking or tracing, the panel narrows and the results strip steps out of the way:
          the map is the thing being worked on, and a 360px column over it is in the way. */}
      <section className={`scenario-panel${planner.geometryMode ? ' is-compact' : ''}`}
        aria-label="Scenario configuration">
        <header className="scenario-panel-head">
          {/* The map-control column is hidden while this panel is open — the panel is where it
              used to be — so the camera buttons live here instead, and go on working on the map
              behind. Same definitions and same handlers as the column: see `MapControls.jsx`. */}
          <div className="scenario-panel-camera" role="group" aria-label="Map navigation">
            <MapControlButtons handlers={cameraHandlers ?? {}} keys={PANEL_CAMERA_KEYS} grouped={false} />
          </div>
          <button type="button" className="road-icon-btn" aria-label="Close planner"
            onClick={() => setOpen(false)}>×</button>
        </header>
        <div className="scenario-tabs" role="tablist">
          {[[PLANNER_TAB.PLAN, 'Plan'], [PLANNER_TAB.SIMULATE, 'Simulate'], [PLANNER_TAB.COMPARE, 'Compare']].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>

        <ul className="scenario-list">
          {scenarios.map(scenario => (
            <li key={scenario.id}>
              <label className={`scenario-choice${selected?.id === scenario.id ? ' is-selected' : ''}`}>
                <input type="radio" name="scenario" checked={selected?.id === scenario.id}
                  onChange={() => planner.select(scenario.id)} />
                <span className="scenario-choice-body">
                  <span className="scenario-choice-name">{scenario.name}</span>
                  <span className="scenario-choice-meta">
                    +{Number(scenario.assumptions.additionalSpaces).toLocaleString()} spaces · assumption
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>

        <div className="scenario-tabbody">
          {tab === PLANNER_TAB.PLAN && (
            <PlanTab planner={planner} garages={garages} roadsById={roadsById}
              onLinkFootprint={onLinkFootprint} buildingsById={buildingsById} />
          )}
          {tab === PLANNER_TAB.SIMULATE && <SimulateTab planner={planner} />}
          {tab === PLANNER_TAB.COMPARE && <CompareTab planner={planner} />}
        </div>

        {planner.sitePicker.hint && <p className="scenario-hint">{planner.sitePicker.hint}</p>}
        {planner.massingWarning && <p className="scenario-warn">{planner.massingWarning}</p>}
      </section>

      {/* The results strip. Only drawn once a run exists; before that it says so. Hidden while
          geometry is being chosen, so the map is clear to work on. */}
      {!planner.geometryMode && !planner.placement?.editing && (
      <section className="scenario-results-bar" aria-label="Scenario results">
        <article className="scenario-card">
          <h3>Parking Capacity</h3>
          {r ? (
            <>
              <p className="scenario-big">{fmt(r.capacity.proposedTotalCapacity)}<span>spaces proposed</span></p>
              <ul className="scenario-mini">
                <li>
                  <em>{latest.inputSnapshot.capacitySource ? 'Existing (published)' : 'Existing (assumed)'}</em>
                  <b>{fmt(r.capacity.existingCapacity)}</b>
                </li>
                <li><em>Added</em><b>{fmt(r.capacity.additionalSpaces)}</b></li>
                <li><em>Usable at peak</em><b>{fmt(r.capacity.usableCapacity)}</b></li>
              </ul>
            </>
          ) : <p className="scenario-empty">Not run yet.</p>}
        </article>

        <article className="scenario-card">
          <h3>Traffic Impact</h3>
          {r ? (
            <>
              <p className="scenario-big">{fmt(r.trips.total)}<span>added peak-hour vehicles</span></p>
              <ul className="scenario-mini">
                <li><em>Access road</em><b>{r.traffic.road?.name ?? 'None'}</b></li>
                <li><em>Modelled V/C</em><b>{ratio(r.traffic.vcRatio)}</b></li>
                <li><em>Peak queue</em><b>{Number.isFinite(r.traffic.queue?.peakQueue) ? `${Math.round(r.traffic.queue.peakQueue)} veh` : '—'}</b></li>
              </ul>
            </>
          ) : <p className="scenario-empty">Not run yet.</p>}
        </article>

        <article className="scenario-card is-findings">
          <h3>Key Findings</h3>
          {findings.length ? (
            <ul className="scenario-findings">
              {findings.map(finding => (
                <li key={finding.text} className={`is-${finding.tone}`}>{finding.text}</li>
              ))}
            </ul>
          ) : <p className="scenario-empty">Run a scenario to produce findings.</p>}
          {onOpenAssistant && (
            <button type="button" className="scenario-secondary" onClick={onOpenAssistant}>
              Ask the Twin about this
            </button>
          )}
        </article>
      </section>
      )}
      </>
      )}
    </>
  );
}
