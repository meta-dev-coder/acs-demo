/**
 * The Road Design Studio panel: select a road, mark a section, propose a width, save it.
 *
 * Every number shown carries its provenance, because the audit finding behind this whole tool is
 * that the county centreline file publishes no width and no lane count. "Unknown" and "Not
 * calculable" appear often here, and that is the feature working rather than a gap in it.
 */
import { useState } from 'react';
import { PROVENANCE, WIDENING_SIDE, availableSides } from '../designs/roadWidening.js';
import { STUDIO_TOOLS } from '../hooks/useRoadWidening.js';
import { CONFLICT_STATUS } from '../scenarios/siteConflicts.js';

const m = v => (Number.isFinite(v) ? `${Math.round(v).toLocaleString()} m` : '—');
const m2 = v => (Number.isFinite(v) ? `${Math.round(v).toLocaleString()} m²` : '—');

const PROVENANCE_LABEL = {
  MEASURED_GIS: 'measured from GIS',
  CALCULATED: 'calculated',
  USER_ASSUMED: 'your assumption',
  UNKNOWN: 'unknown',
  NOT_CALCULABLE: 'not calculable',
};

/** A figure with where it came from. Never a bare number. */
function Figure({ entry, format = m }) {
  if (!entry) return <dd>—</dd>;
  const unknown = entry.value === null || entry.value === undefined;
  return (
    <dd className={unknown ? 'is-missing' : undefined}>
      {unknown
        ? (entry.provenance === PROVENANCE.NOT_CALCULABLE ? 'Not calculable' : 'Unknown')
        : format(entry.value)}
      <em className="design-provenance"> · {PROVENANCE_LABEL[entry.provenance] ?? entry.provenance}</em>
    </dd>
  );
}

function Collapsible({ title, summary, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`scenario-collapsible${open ? ' is-open' : ''}`}>
      <button type="button" className="scenario-collapsible-head"
        aria-expanded={open} onClick={() => setOpen(v => !v)}>
        <span className="scenario-collapsible-title">{title}</span>
        {summary && <span className="scenario-collapsible-summary">{summary}</span>}
        <span className="scenario-collapsible-chevron" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="scenario-collapsible-body">{children}</div>}
    </div>
  );
}

/**
 * Move, add and remove vertices on the map. Shared by the new-road and realignment editors, so the
 * two behave the same; locked tie-in ends can be selected but never moved or removed.
 */
function VertexTools({ studio }) {
  const editing = studio.picking() === 'EDIT';
  const { newRoad, selectedVertex } = studio;
  const locked = newRoad.lockedEnds && studio.studioMode === 'REALIGN'
    && (selectedVertex === 0 || selectedVertex === newRoad.points.length - 1);
  return (
    <div className="scenario-placement-actions rd-vertex-tools">
      <button type="button" className={editing ? 'scenario-primary' : 'scenario-secondary'}
        disabled={newRoad.points.length < 2} onClick={editing ? studio.stopEditing : studio.editVertices}>
        {editing ? 'Done editing' : 'Edit vertices'}
      </button>
      <button type="button" className="scenario-secondary"
        disabled={selectedVertex === null || locked || newRoad.points.length <= 2}
        title={locked ? 'A tie-in end stays on the original road' : undefined}
        onClick={studio.removeSelectedVertex}>Remove vertex</button>
      <button type="button" className="scenario-secondary" disabled={!studio.historyDepth}
        onClick={studio.undoVertex}>Undo</button>
    </div>
  );
}

/** Drawing a brand-new alignment: click points, set its properties, save it. */
function NewRoadTab({ studio, designName }) {
  const { newRoad, newRoadQuantities: q, newRoadValidation, newRoadConflicts, hint, saveState } = studio;
  return (
    <>
      {hint && <p className="scenario-hint">{hint}</p>}
      <div className="scenario-placement-actions">
        <button type="button" className="scenario-primary" onClick={studio.startDrawing}>
          {newRoad.points.length ? 'Add points at the end' : 'Draw on the map'}
        </button>
        <button type="button" className="scenario-secondary" onClick={studio.finishDrawing}
          disabled={newRoad.points.length < 2}>Finish</button>
      </div>
      <VertexTools studio={studio} />
      <p className="scenario-field-note">
        {newRoad.points.length === 0
          ? 'Click along the route. The corridor appears as soon as there are two points.'
          : `${newRoad.points.length} point${newRoad.points.length === 1 ? '' : 's'}. Use Edit vertices to move, add or remove them.`}
      </p>

      <Collapsible title="Road properties" defaultOpen
        summary={`${newRoad.widthM} m · ${newRoad.laneCount} lanes`}>
        <label className="scenario-field">
          <span className="scenario-field-label">Name</span>
          <input type="text" value={newRoad.name} placeholder="Proposed road"
            onChange={e => studio.setNewRoadField('name', e.target.value)} />
        </label>
        <div className="scenario-grid-2">
          <label className="scenario-field">
            <span className="scenario-field-label">Width (m)</span>
            <input type="number" value={newRoad.widthM} step="0.5" min="1"
              onChange={e => studio.setNewRoadField('widthM', e.target.value === '' ? '' : Number(e.target.value))} />
          </label>
          <label className="scenario-field">
            <span className="scenario-field-label">Lanes</span>
            <input type="number" value={newRoad.laneCount} step="1" min="1"
              onChange={e => studio.setNewRoadField('laneCount', e.target.value === '' ? '' : Number(e.target.value))} />
          </label>
        </div>
        <div className="scenario-grid-2">
          {[['startRole', 'Start connects to'], ['endRole', 'End connects to']].map(([field, label]) => (
            <label key={field} className="scenario-field">
              <span className="scenario-field-label">{label}</span>
              <select value={newRoad[field]} onChange={e => studio.setNewRoadField(field, e.target.value)}>
                <option value="ROAD_NETWORK_CONNECTION">Existing road</option>
                <option value="FACILITY_ENTRANCE">Facility entrance</option>
                <option value="FUTURE_CONNECTION">Future connection</option>
                <option value="DEAD_END">Dead end</option>
              </select>
            </label>
          ))}
        </div>
        <label className="scenario-field">
          <span className="scenario-field-label">Classification</span>
          <select value={newRoad.roadType}
            onChange={e => studio.setNewRoadField('roadType', e.target.value)}>
            {['ACCESS_ROAD', 'SERVICE_ROAD', 'INTERNAL_CIRCULATION', 'ARTERIAL'].map(type => (
              <option key={type} value={type}>{type.replace(/_/g, ' ').toLowerCase()}</option>
            ))}
          </select>
        </label>
      </Collapsible>

      <Collapsible title="Quantities" defaultOpen summary={q ? m(q.lengthM) : 'Nothing drawn'}>
        {q ? (
          <dl className="scenario-readout">
            <dt>Centreline length</dt><dd>{m(q.lengthM)}<em className="design-provenance"> · calculated</em></dd>
            <dt>Width</dt><dd>{q.widthM} m<em className="design-provenance"> · your assumption</em></dd>
            <dt>Surface area</dt><dd>{m2(q.surfaceAreaM2)}<em className="design-provenance"> · calculated</em></dd>
            <dt>Points</dt><dd>{q.vertices}</dd>
          </dl>
        ) : <p className="scenario-empty">Draw at least two points to measure the alignment.</p>}
      </Collapsible>

      <Collapsible title="Validation"
        summary={newRoadConflicts ? `${newRoadConflicts.conflicts} conflict${newRoadConflicts.conflicts === 1 ? '' : 's'}` : '—'}>
        {newRoadConflicts ? (
          <ul className="design-findings">
            {newRoadConflicts.checks.map(check => (
              <li key={check.id} className={`is-${check.status.toLowerCase()}`}>
                <strong>{check.label}</strong>
                <span>{check.detail}</span>
              </li>
            ))}
          </ul>
        ) : <p className="scenario-empty">Not evaluated — nothing is drawn yet.</p>}
        <p className="scenario-field-note">
          A new alignment crossing an existing road is usually a junction rather than a fault.
          Utilities, drainage and right-of-way are not available here and are not evaluated.
        </p>
      </Collapsible>

      {newRoadValidation.errors.map(e => <p key={e} className="scenario-error">{e}</p>)}
      {newRoadValidation.advisories.map(a => <p key={a} className="scenario-warn">{a}</p>)}
      {saveState && (
        <p className={saveState.ok ? 'scenario-ok' : saveState.conflict ? 'scenario-warn' : 'scenario-error'}>
          {saveState.ok
            ? `Saved to ${designName}${saveState.revision ? ` · revision ${saveState.revision}` : ''}.`
            : saveState.conflict
              ? `${saveState.reason} Press Save again to apply your change on top.`
              : `Not saved — ${saveState.reason} Your draft is still here.`}
        </p>
      )}
      <div className="scenario-placement-actions">
        <button type="button" className="scenario-primary" disabled={!newRoadValidation.ok}
          onClick={studio.saveNewRoad}>{studio.editingId ? 'Update change' : `Save to ${designName}`}</button>
        <button type="button" className="scenario-secondary" onClick={studio.reset}>Cancel</button>
      </div>
    </>
  );
}

const TOOL_GLYPH = {
  CREATE: <><path d="M4 18L20 6" /><path d="M4 18h4M16 6h4" /></>,
  WIDEN: <><path d="M4 9h16M4 15h16" /><path d="M12 4v3M12 17v3" /></>,
  REALIGN: <><path d="M4 18c6 0 6-12 16-12" /><path d="M4 12h4" /></>,
  CLOSE: <><circle cx="12" cy="12" r="8" /><path d="M8.5 15.5l7-7" /></>,
};

/**
 * Realignment and closure: both start from an existing road, and both leave it where it is.
 *
 * A realignment adds a replacement line; a closure adds nothing but a marked stretch. Sharing one
 * component keeps the road-and-section half identical between them, which is the half a user has
 * to learn.
 */
function ReshapeTab({ studio, designName }) {
  const { draft, hint, saveState, quantities } = studio;
  const realign = studio.studioMode === 'REALIGN';
  const [reason, setReason] = useState('');

  if (!draft.road) {
    return (
      <>
        <p className="scenario-field-note">
          {realign
            ? 'Realign an existing road: select it, optionally mark the stretch being replaced, '
              + 'then draw the proposed line. The original stays in the dataset.'
            : 'Propose closing a stretch of existing road. It is marked as a change, not deleted '
              + 'from the county data.'}
        </p>
        <button type="button" className="scenario-primary" onClick={studio.pickRoad}>
          Select an existing road on the map
        </button>
        {hint && <p className="scenario-hint">{hint}</p>}
      </>
    );
  }

  const section = draft.startM !== null && draft.endM !== null;
  const supersededM = section ? quantities?.proposed.affectedLengthM.value ?? null : null;

  return (
    <>
      {hint && <p className="scenario-hint">{hint}</p>}
      <Collapsible title="Road" defaultOpen
        summary={`${draft.road.name || 'Unnamed'} · OBJECTID ${draft.road.objectId}`}>
        <dl className="scenario-readout">
          <dt>Name</dt><dd>{draft.road.name || 'Unnamed road'}</dd>
          <dt>OBJECTID</dt><dd>{draft.road.objectId}</dd>
          <dt>Centreline length</dt><Figure entry={quantities?.baseline.totalLengthM} />
        </dl>
        <div className="scenario-placement-actions">
          <button type="button" className="scenario-secondary" onClick={studio.pickRoad}>Select another</button>
          <button type="button" className="scenario-secondary" onClick={studio.frame}>Frame</button>
        </div>
      </Collapsible>

      <Collapsible title={realign ? 'Stretch being replaced' : 'Stretch being closed'} defaultOpen
        summary={section ? m(supersededM) : 'Entire road'}>
        <div className="scenario-placement-actions">
          <button type="button" className="scenario-secondary" onClick={studio.useEntireRoad}>Entire road</button>
          <button type="button" className="scenario-secondary" onClick={studio.markStart}>
            Set start{draft.startM !== null ? ` · ${Math.round(draft.startM)} m` : ''}
          </button>
          <button type="button" className="scenario-secondary" onClick={studio.markEnd}>
            Set end{draft.endM !== null ? ` · ${Math.round(draft.endM)} m` : ''}
          </button>
        </div>
      </Collapsible>

      {realign && (
        <Collapsible title="Proposed alignment" defaultOpen
          summary={studio.realignQuantities ? m(studio.realignQuantities.proposedLengthM) : 'Not created'}>
          {studio.newRoad.points.length < 2 ? (
            <>
              <p className="scenario-field-note">
                Starts as a copy of the stretch being replaced, tied into the road at both ends.
                Then drag its middle vertices to the new line.
              </p>
              <button type="button" className="scenario-primary" onClick={studio.proposeAlignment}>
                Create proposed alignment
              </button>
            </>
          ) : (
            <>
              <VertexTools studio={studio} />
              <label className="rd-check">
                <input type="checkbox" checked={studio.newRoad.lockedEnds}
                  onChange={e => studio.setNewRoadField('lockedEnds', e.target.checked)} />
                Keep both ends tied into the original road
              </label>
              <div className="scenario-grid-2">
                <label className="scenario-field">
                  <span className="scenario-field-label">Width (m)</span>
                  <input type="number" value={studio.newRoad.widthM} step="0.5" min="1"
                    onChange={e => studio.setNewRoadField('widthM', e.target.value === '' ? '' : Number(e.target.value))} />
                </label>
                <label className="scenario-field">
                  <span className="scenario-field-label">Lanes</span>
                  <input type="number" value={studio.newRoad.laneCount} step="1" min="1"
                    onChange={e => studio.setNewRoadField('laneCount', e.target.value === '' ? '' : Number(e.target.value))} />
                </label>
              </div>
              {studio.realignQuantities && (
                <dl className="scenario-readout">
                  <dt>Original affected length</dt><dd>{m(studio.realignQuantities.originalLengthM)}</dd>
                  <dt>Proposed length</dt><dd>{m(studio.realignQuantities.proposedLengthM)}<em className="design-provenance"> · calculated</em></dd>
                  <dt>Length difference</dt>
                  <dd>{`${studio.realignQuantities.lengthDifferenceM >= 0 ? '+' : ''}${studio.realignQuantities.lengthDifferenceM.toFixed(1)} m`}</dd>
                  <dt>Max lateral displacement</dt><dd>{studio.realignQuantities.maxLateralM.toFixed(1)} m</dd>
                  <dt>Start tie-in gap</dt><dd>{studio.realignQuantities.startTieM.toFixed(2)} m</dd>
                  <dt>End tie-in gap</dt><dd>{studio.realignQuantities.endTieM.toFixed(2)} m</dd>
                  <dt>Self-intersection</dt><dd>{studio.realignQuantities.selfIntersects ? 'Yes — fix before saving' : 'None'}</dd>
                </dl>
              )}
            </>
          )}
        </Collapsible>
      )}

      {!realign && (
        <label className="scenario-field">
          <span className="scenario-field-label">Reason (optional)</span>
          <input type="text" value={reason} placeholder="e.g. replaced by the proposed alignment"
            onChange={e => setReason(e.target.value)} />
        </label>
      )}

      <p className="scenario-field-note">
        {realign
          ? 'The original centreline stays in the county dataset and keeps being drawn. This is a '
            + 'proposed replacement, not an edit of the baseline.'
          : 'A closure marks the stretch as proposed for removal. Nothing is deleted from the '
            + 'county dataset, and the segment stays visible beneath the marking.'}
      </p>

      {saveState && (
        <p className={saveState.ok ? 'scenario-ok' : saveState.conflict ? 'scenario-warn' : 'scenario-error'}>
          {saveState.ok
            ? `Saved to ${designName}${saveState.revision ? ` · revision ${saveState.revision}` : ''}.`
            : saveState.conflict
              ? `${saveState.reason} Press Save again to apply your change on top.`
              : `Not saved — ${saveState.reason} Your draft is still here.`}
        </p>
      )}
      <div className="scenario-placement-actions">
        <button type="button" className="scenario-primary"
          disabled={realign && studio.newRoad.points.length < 2}
          title={realign && studio.newRoad.points.length < 2 ? 'Create the proposed alignment first' : undefined}
          onClick={() => (realign ? studio.saveRealignment() : studio.saveClosure({ reason }))}>
          {studio.editingId ? 'Update change' : `Save to ${designName}`}
        </button>
        <button type="button" className="scenario-secondary" onClick={studio.reset}>Cancel</button>
      </div>
    </>
  );
}

export function RoadDesignStudio({ studio, designName, editingName = null, allowedOperation = null }) {
  const { draft, candidates, hint, saveState, quantities, validation, conflicts } = studio;
  const sides = availableSides(draft.baselineWidthM);

  /** Four operations, four records. Each one is live; none is a button that does nothing. */
  const modeSwitch = (
    <>
    {/* Whether Save adds a change or updates one is stated before it is pressed, not after. */}
    <div className={`rd-editing${studio.editingId ? ' is-editing' : ''}`}>
      {studio.editingId
        ? <>Editing <b>{editingName}</b> in {designName}. Save updates this change.</>
        : <>New change in <b>{designName}</b>. Save adds it to the design.</>}
      {studio.editingId && (
        <button type="button" className="rd-link" onClick={studio.startAnother}>Start another</button>
      )}
    </div>
    {/* An alternative restricted to one operation gets that one editor and no other tools. */}
    {!allowedOperation && <div className="road-tools" role="group" aria-label="Road design tools">
      {STUDIO_TOOLS.map(tool => (
        <button key={tool.id} type="button" aria-pressed={studio.studioMode === tool.id}
          title={`Needs ${tool.needs}`} onClick={() => studio.chooseMode(tool.id)}>
          <span className="road-tool-glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
              strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              {TOOL_GLYPH[tool.id]}
            </svg>
          </span>
          {tool.label}
        </button>
      ))}
    </div>}
    </>
  );

  if (studio.studioMode === 'CREATE') {
    return (
      <div className="scenario-tab">
        {modeSwitch}
        <NewRoadTab studio={studio} designName={designName} />
      </div>
    );
  }

  if (studio.studioMode === 'REALIGN' || studio.studioMode === 'CLOSE') {
    return (
      <div className="scenario-tab">
        {modeSwitch}
        <ReshapeTab studio={studio} designName={designName} />
      </div>
    );
  }

  if (!draft.road) {
    return (
      <div className="scenario-tab">
        {modeSwitch}
        <p className="scenario-field-note">
          Widen an existing PortMiami road. The proposal is saved to {designName} as a change
          against the county centreline — the original data is never altered.
        </p>
        <button type="button" className="scenario-primary" onClick={studio.pickRoad}>
          Select a road on the map
        </button>
        {hint && <p className="scenario-hint">{hint}</p>}
      </div>
    );
  }

  return (
    <div className="scenario-tab">
      {modeSwitch}
      {hint && <p className="scenario-hint">{hint}</p>}

      <Collapsible title="Road selection" defaultOpen
        summary={`${draft.road.name || 'Unnamed'} · OBJECTID ${draft.road.objectId}`}>
        <dl className="scenario-readout">
          <dt>Name</dt><dd>{draft.road.name || 'Unnamed road'}</dd>
          <dt>OBJECTID</dt><dd>{draft.road.objectId}</dd>
          <dt>Classification</dt><dd>{draft.road.classCode || 'Not published'}</dd>
          <dt>Centreline length</dt>
          <Figure entry={quantities?.baseline.totalLengthM} />
          <dt>Existing width</dt><Figure entry={quantities?.baseline.widthM} />
          <dt>Existing lanes</dt>
          <Figure entry={quantities?.baseline.lanes} format={v => `${v}`} />
          <dt>Source</dt><dd>Miami-Dade GIS</dd>
        </dl>
        {/* The whole reason this tool behaves as it does. */}
        <p className="scenario-field-note">
          The county centreline file publishes no width and no lane count, so both read Unknown
          until you state one. Nothing here infers a kerb line from a centreline.
        </p>
        <div className="scenario-placement-actions">
          <button type="button" className="scenario-secondary" onClick={studio.pickRoad}>
            Select another
          </button>
          <button type="button" className="scenario-secondary" onClick={studio.frame}>Frame</button>
        </div>
        {candidates.length > 1 && (
          <>
            <p className="scenario-field-note">
              {candidates.length} centrelines were within reach of that click:
            </p>
            <ul className="design-elements">
              {candidates.map(({ road, distanceM }) => (
                <li key={road.objectId}
                  className={road.objectId === draft.road.objectId ? 'is-selected' : undefined}>
                  <button type="button" onClick={() => studio.chooseCandidate(road)}>
                    <span className="design-element-name">{road.name || `Road ${road.objectId}`}</span>
                    <span className="design-element-meta">
                      OBJECTID {road.objectId} · {distanceM.toFixed(1)} m from the click
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </Collapsible>

      <Collapsible title="Section to widen" defaultOpen
        summary={draft.startM === null || draft.endM === null ? 'Entire road'
          : `${m(quantities?.proposed.affectedLengthM.value)} section`}>
        <div className="scenario-toggle" role="group" aria-label="Section mode">
          <button type="button" aria-pressed={draft.startM === null && draft.endM === null}
            onClick={studio.useEntireRoad}>Entire road</button>
          <button type="button" aria-pressed={draft.startM !== null || draft.endM !== null}
            onClick={studio.markStart}>Selected section</button>
        </div>
        <div className="scenario-placement-actions">
          <button type="button" className="scenario-secondary" onClick={studio.markStart}>
            Set start{draft.startM !== null ? ` · ${Math.round(draft.startM)} m` : ''}
          </button>
          <button type="button" className="scenario-secondary" onClick={studio.markEnd}>
            Set end{draft.endM !== null ? ` · ${Math.round(draft.endM)} m` : ''}
          </button>
        </div>
        <p className="scenario-field-note">
          Clicks snap onto the selected road and are stored as distances along it, so a section
          survives a reload and a different screen.
        </p>
      </Collapsible>

      <Collapsible title="Proposed widening" defaultOpen
        summary={`${draft.totalWidthM} m · ${draft.laneCount} lanes · ${draft.side.toLowerCase()}`}>
        <div className="scenario-grid-2">
          <label className="scenario-field">
            <span className="scenario-field-label">Proposed width (m)</span>
            <input type="number" value={draft.totalWidthM} step="0.5" min="1"
              onChange={e => studio.setField('totalWidthM', e.target.value === '' ? '' : Number(e.target.value))} />
          </label>
          <label className="scenario-field">
            <span className="scenario-field-label">Proposed lanes</span>
            <input type="number" value={draft.laneCount} step="1" min="1"
              onChange={e => studio.setField('laneCount', e.target.value === '' ? '' : Number(e.target.value))} />
          </label>
        </div>
        <div className="scenario-toggle" role="group" aria-label="Widening side">
          {[WIDENING_SIDE.BOTH, WIDENING_SIDE.LEFT, WIDENING_SIDE.RIGHT].map(side => (
            <button key={side} type="button" aria-pressed={draft.side === side}
              disabled={!sides.includes(side)}
              title={sides.includes(side) ? undefined
                : 'Needs a stated existing width — one edge has to stay where it is'}
              onClick={() => studio.setField('side', side)}>
              {side.charAt(0) + side.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
        <label className="scenario-field">
          <span className="scenario-field-label">Existing width, if you know it (m)</span>
          <input type="number" value={draft.baselineWidthM ?? ''} step="0.5" min="0"
            placeholder="Unknown"
            onChange={e => studio.setField('baselineWidthM',
              e.target.value === '' ? null : Number(e.target.value))} />
          <span className="scenario-field-note">
            Carried as your assumption, not a measurement. Stating it unlocks one-sided widening
            and the incremental pavement figure.
          </span>
        </label>
      </Collapsible>

      <Collapsible title="Quantities" defaultOpen
        summary={m2(quantities?.proposed.corridorAreaM2.value)}>
        <dl className="scenario-readout">
          <dt>Affected length</dt><Figure entry={quantities?.proposed.affectedLengthM} />
          <dt>Proposed total width</dt><Figure entry={quantities?.proposed.totalWidthM} />
          <dt>Proposed corridor area</dt>
          <Figure entry={quantities?.proposed.corridorAreaM2} format={m2} />
          <dt>Centreline shift</dt><Figure entry={quantities?.proposed.centrelineShiftM} />
          <dt>Width change</dt><Figure entry={quantities?.difference.widthChangeM} />
          <dt>Lane change</dt>
          <Figure entry={quantities?.difference.laneChange} format={v => (v > 0 ? `+${v}` : `${v}`)} />
          <dt>Incremental pavement</dt>
          <Figure entry={quantities?.difference.incrementalPavementM2} format={m2} />
        </dl>
      </Collapsible>

      <Collapsible title="Validation"
        summary={conflicts ? `${conflicts.conflicts} conflict${conflicts.conflicts === 1 ? '' : 's'}` : '—'}>
        {conflicts ? (
          <ul className="design-findings">
            {conflicts.checks.map(check => (
              <li key={check.id} className={`is-${check.status.toLowerCase()}`}>
                <strong>{check.label}</strong>
                <span>{check.detail}</span>
              </li>
            ))}
          </ul>
        ) : <p className="scenario-empty">Not evaluated — there is no corridor yet.</p>}
        <p className="scenario-field-note">
          A geometric overlap test against the layers this twin holds. No conflict found does not
          mean the widening is constructible: utilities, drainage, right-of-way and structural
          clearance are not available here.
        </p>
      </Collapsible>

      {validation.errors.map(error => <p key={error} className="scenario-error">{error}</p>)}
      {validation.advisories.map(advice => <p key={advice} className="scenario-warn">{advice}</p>)}
      {saveState && (
        <p className={saveState.ok ? 'scenario-ok' : saveState.conflict ? 'scenario-warn' : 'scenario-error'}>
          {saveState.ok
            ? `Saved to ${designName}${saveState.revision ? ` · revision ${saveState.revision}` : ''}.`
            : saveState.conflict
              // A conflict is not a failure of the draft: both pieces of work still exist.
              ? `${saveState.reason} The panel now shows what is stored; press Save again to `
                + 'apply your change on top of it.'
              : `Not saved — ${saveState.reason} Your draft is still here.`}
        </p>
      )}

      <div className="scenario-placement-actions">
        <button type="button" className="scenario-primary" disabled={!validation.ok}
          onClick={studio.save}>{studio.editingId ? 'Update change' : `Save to ${designName}`}</button>
        <button type="button" className="scenario-secondary" onClick={studio.reset}>Cancel</button>
      </div>
    </div>
  );
}
