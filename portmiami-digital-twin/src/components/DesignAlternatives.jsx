/**
 * The Road Design Studio panel, organised as a design review.
 *
 *   Selector   Existing Baseline and each alternative, compact. Archived ones are hidden, not lost.
 *   Header     what the selected alternative is FOR, its revision and state, and what you can do
 *              with it: edit, duplicate, rename, archive, reset a demo.
 *   Overview   its changes grouped by the county road they affect, then the new roads — each with
 *              View on map, Edit, Duplicate, Remove and its own validation.
 *   Edit Roads the road tools.
 *   Compare    two alternatives side by side, by what physically changes. No winner is declared.
 *
 * Every figure is derived from the stored geometry at render time. Destructive actions ask first,
 * and removing a change never touches the county road it referenced.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { COMPARE_VIEW, DESIGN_TAB, VIEW_MODE } from '../hooks/useDesignAlternatives.js';
import { DESIGN_SOURCE, SYNTHETIC_LABEL, isBaseline } from '../designs/designModel.js';
import { ENDPOINT_ROLE_LABEL } from '../designs/designValidation.js';
import {
  ROAD_OPERATION_LABEL, roadMeasure, roadOperationOf, wideningMeasure,
} from '../designs/designQuantities.js';
import {
  DESIGN_PURPOSE, OPERATION_NAME, PRIMARY_IDS, PURPOSE_INFO, constraintViolations, designSummary, endpointsOf, groupRoadChanges, isDemo, purposeOf, repeatedNames,
  surfaceRingOf,
} from '../designs/designReview.js';
import { ROAD_OPERATION_STYLE } from '../cesium/designOverlayLayer.js';
import { checkSiteConflicts } from '../scenarios/siteConflicts.js';
import { MapControlButtons, PANEL_CAMERA_KEYS } from './MapControls.jsx';
import { RoadDesignStudio } from './RoadDesignStudio.jsx';
import { DesignDashboard } from './DesignDashboard.jsx';
import { DesignThumbnail } from './DesignThumbnail.jsx';

const fmt = value => (Number.isFinite(value) ? Math.round(value).toLocaleString() : '—');
const m = value => (Number.isFinite(value) ? `${Math.round(value).toLocaleString()} m` : '—');
const m2 = value => (Number.isFinite(value) ? `${Math.round(value).toLocaleString()} m²` : '—');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const opOf = element => roadOperationOf(element) ?? 'MODIFY';
const opLabel = element => ROAD_OPERATION_LABEL[opOf(element)] ?? 'Change';
const opColour = element => ROAD_OPERATION_STYLE[opOf(element)]?.line ?? '#657184';

/** One line describing a change: its section, width and lanes, as stored. */
function changeDetail(element) {
  const bits = [];
  const op = opOf(element);
  if (op === 'WIDEN') {
    const w = wideningMeasure(element);
    bits.push(element.section ? `${m(element.section.lengthM)} section` : `entire road · ${m(w?.proposed.affectedLengthM.value)}`);
    bits.push(`${element.proposal?.totalWidthM ?? '—'} m proposed`);
    bits.push(plural(element.proposal?.laneCount ?? 0, 'lane'));
  } else if (op === 'CLOSE') {
    bits.push(element.section ? `${m(element.section.lengthM)} closed` : `entire road · ${m(roadMeasure(element)?.lengthM)}`);
    if (element.properties?.reason) bits.push(element.properties.reason);
  } else {
    bits.push(m(roadMeasure(element)?.lengthM));
    if (Number.isFinite(element.properties?.widthM)) bits.push(`${element.properties.widthM} m wide`);
    if (Number.isFinite(element.properties?.lanes)) bits.push(plural(element.properties.lanes, 'lane'));
    if (op === 'REALIGN') bits.push(element.section ? `replaces ${m(element.section.lengthM)}` : 'replaces the entire road');
  }
  return bits.join(' · ');
}

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

/** A confirmation step for anything destructive. Nothing happens until Confirm is pressed. */
function ConfirmDialog({ confirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!confirm) return null;
  const run = async () => {
    setBusy(true);
    const result = await confirm.onConfirm();
    setBusy(false);
    if (result?.ok === false) setError(result.reason ?? 'It did not complete.');
    else onClose();
  };
  return (
    <div className="rd-confirm" role="alertdialog" aria-modal="true" aria-labelledby="rd-confirm-title">
      <div className="rd-confirm-card">
        <h4 id="rd-confirm-title">{confirm.title}</h4>
        <div className="rd-confirm-body">{confirm.body}</div>
        {error && <p className="scenario-error">{error}</p>}
        <div className="scenario-placement-actions">
          <button type="button" className={confirm.danger ? 'rd-danger' : 'scenario-primary'}
            disabled={busy} onClick={run}>{busy ? 'Working…' : confirm.action}</button>
          <button type="button" className="scenario-secondary" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/** The validation for ONE change: its own surface against the county layers, and its ends. */
function ChangeValidation({ element, viewer }) {
  const { roads, buildings } = viewer.baselineLayers;
  const result = useMemo(() => {
    const ring = surfaceRingOf(element);
    if (!ring) return null;
    const own = element.baselineRef?.objectId;
    return checkSiteConflicts(ring, {
      buildings, roads: roads ? roads.filter(road => road.objectId !== own) : null,
    });
  }, [element, roads, buildings]);
  const connection = viewer.connectivity.find(row => row.elementId === element.id);
  const clashes = viewer.clashes.filter(clash => clash.ids.includes(element.id));
  return (
    <div className="rd-validation">
      {clashes.map(clash => <p key={clash.text} className="scenario-warn">{clash.text}</p>)}
      {result ? (
        <ul className="design-findings">
          {result.checks.map(check => (
            <li key={check.id} className={`is-${check.status.toLowerCase()}`}>
              <strong>{check.label}</strong><span>{check.detail}</span>
            </li>
          ))}
        </ul>
      ) : <p className="scenario-field-note">A closure proposes no new surface, so there is nothing to check for overlaps.</p>}
      {connection && (
        <p className="scenario-field-note">
          <b>Connectivity: {connection.functionalStatus.toLowerCase().replace('_', ' ')}</b> — {connection.detail}
          {connection.ends.map(end => (
            <span key={end.end} className="rd-end">
              {end.end} · {ENDPOINT_ROLE_LABEL[end.role] ?? end.role}: {end.status.toLowerCase().replace('_', ' ')}
              {end.distanceM !== null && end.distanceM !== undefined ? ` (${end.distanceM} m from ${end.nearestRoad})` : ''}
            </span>
          ))}
        </p>
      )}
      <p className="scenario-field-note">
        Overlap with the layers this twin holds only. Utilities, drainage and right-of-way are not evaluated.
      </p>
    </div>
  );
}

/** One change, with everything that can be done to it. */
function ChangeRow({ element, viewer, onEdit, onDuplicate, onRemove, showId }) {
  const [open, setOpen] = useState(false);
  const selected = viewer.selectedElementId === element.id;
  const ends = showId ? endpointsOf(element) : null;
  return (
    <li className={`rd-change${selected ? ' is-selected' : ''}`}>
      <button type="button" className="rd-change-head" aria-pressed={selected}
        onClick={() => viewer.setSelectedElementId(selected ? null : element.id)}>
        <span className="rd-op" style={{ color: opColour(element), background: `${opColour(element)}1F` }}>
          <i aria-hidden="true" style={{ background: opColour(element) }} />{opLabel(element)}
        </span>
        <span className="rd-change-name">{element.properties?.name ?? element.id}</span>
        <span className="rd-change-meta">{changeDetail(element)}</span>
        {showId && (
          <span className="rd-change-id">
            ID {element.id}{ends ? ` · ${ends.start} → ${ends.end}` : ''}
          </span>
        )}
      </button>
      <div className="rd-change-actions">
        <button type="button" onClick={() => viewer.focusElement(element.id)}>View on map</button>
        <button type="button" onClick={() => onEdit(element)}>Edit</button>
        <button type="button" onClick={() => onDuplicate(element)}>Duplicate</button>
        <button type="button" onClick={() => onRemove(element)}>Remove</button>
        <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
          {open ? 'Hide validation' : 'Validation'}
        </button>
      </div>
      {open && <ChangeValidation element={element} viewer={viewer} />}
    </li>
  );
}

// ---- Overview ------------------------------------------------------------------------------------

function OverviewTab({ viewer, studio, askConfirm }) {
  const { activeDesign, summary, spatial } = viewer;
  const groups = useMemo(() => groupRoadChanges(activeDesign), [activeDesign]);
  const repeated = useMemo(() => repeatedNames(activeDesign), [activeDesign]);
  const [copyFrom, setCopyFrom] = useState('');

  if (isBaseline(activeDesign)) {
    return (
      <div className="scenario-tab">
        <p className="scenario-empty">
          The port as the county GIS records it today: {fmt(viewer.baselineRoadCount)} road segments.
          No proposed changes are drawn.
        </p>
        <p className="scenario-field-note">
          Choose an alternative above to review what it changes, or create one.
        </p>
      </div>
    );
  }

  const edit = element => {
    const result = studio.loadElement(element);
    if (result.ok) { viewer.setSelectedElementId(element.id); viewer.setTab(DESIGN_TAB.EDIT); }
    return result;
  };
  const duplicate = element => {
    const result = studio.loadElement(element, { copy: true });
    if (result.ok) viewer.setTab(DESIGN_TAB.EDIT);
  };
  const remove = element => askConfirm({
    title: 'Remove this change from the design?',
    body: <p>“{element.properties?.name ?? element.id}” ({element.id}) will be removed from {activeDesign.name}.
      The county road it references is not changed. The previous revision is kept in the store’s history.</p>,
    action: 'Remove change',
    danger: true,
    onConfirm: () => viewer.removeElement(element.id),
  });

  if (activeDesign.elements.length === 0) {
    const others = viewer.designs.filter(d => !isBaseline(d) && d.id !== activeDesign.id && d.elements.length);
    return (
      <div className="scenario-tab">
        <div className="rd-empty">
          <h4>No road changes in this design</h4>
          <p>Create your first road proposal.</p>
          <div className="scenario-placement-actions">
            {(!activeDesign.allowedOperation || activeDesign.allowedOperation === 'WIDEN') && (
              <button type="button" className="scenario-primary"
                onClick={() => { studio.chooseMode('WIDEN'); viewer.setTab(DESIGN_TAB.EDIT); }}>
                Widen Existing Road
              </button>
            )}
            {(!activeDesign.allowedOperation || activeDesign.allowedOperation === 'CREATE') && (
              <button type="button" className="scenario-primary"
                onClick={() => { studio.chooseMode('CREATE'); viewer.setTab(DESIGN_TAB.EDIT); }}>
                Draw New Road
              </button>
            )}
            {activeDesign.allowedOperation === 'REALIGN' && (
              <button type="button" className="scenario-primary"
                onClick={() => { studio.chooseMode('REALIGN'); viewer.setTab(DESIGN_TAB.EDIT); }}>
                Realign Existing Road
              </button>
            )}
          </div>
          {others.length > 0 && (
            <div className="rd-copy-from">
              <select value={copyFrom} onChange={e => setCopyFrom(e.target.value)} aria-label="Design to duplicate">
                <option value="">Duplicate an existing design…</option>
                {others.map(d => <option key={d.id} value={d.id}>{d.name} · {plural(d.elements.length, 'change')}</option>)}
              </select>
              <button type="button" className="scenario-secondary" disabled={!copyFrom}
                onClick={() => viewer.duplicateAlternative(copyFrom)}>Duplicate</button>
            </div>
          )}
          {activeDesign.limitation && <p className="scenario-field-note">{activeDesign.limitation}</p>}
        </div>
      </div>
    );
  }

  const cleanup = () => askConfirm({
    title: `Remove ${plural(summary.duplicateCount, 'duplicate copy', 'duplicate copies')}?`,
    body: (
      <>
        <p>These records repeat a change that is already in {activeDesign.name}: same operation, road,
          width and lanes, and an alignment within 0.5 m. The first record of each group is kept.</p>
        <ul className="rd-dupes">
          {summary.duplicates.map(group => (
            <li key={group.keepId}>
              <b>Keep {group.name}</b> <code>{group.keepId}</code>
              <ul>
                {group.copies.map(copy => (
                  <li key={copy.id}>Remove <code>{copy.id}</code> — {copy.exact ? 'identical coordinates'
                    : `differs by at most ${copy.deviationM.toFixed(2)} m`}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        <p className="scenario-field-note">Saved as a new revision. The current revision is kept in the store’s history file and can be restored.</p>
      </>
    ),
    action: `Remove ${plural(summary.duplicateCount, 'copy', 'copies')}`,
    danger: true,
    onConfirm: () => viewer.removeDuplicates(summary.duplicates.flatMap(g => g.copies.map(c => c.id))),
  });

  return (
    <div className="scenario-tab">
      {summary.duplicateCount > 0 && (
        <div className="rd-alert">
          <p><b>{plural(summary.duplicateCount, 'record repeats', 'records repeat')} an existing change.</b>{' '}
            The same alignment was stored more than once. Totals below count it once.</p>
          <button type="button" className="scenario-secondary" onClick={cleanup}>Review duplicates…</button>
        </div>
      )}
      {viewer.clashes.length > 0 && (
        <div className="rd-alert">
          <p><b>{plural(viewer.clashes.length, 'pair', 'pairs')} of changes act on the same stretch of road.</b></p>
          <ul>{viewer.clashes.map(clash => <li key={clash.text}>{clash.text}</li>)}</ul>
        </div>
      )}

      {groups.existingRoads.length > 0 && (
        <section className="rd-group">
          <h4 className="rd-group-title">Existing roads affected · {groups.existingRoads.length}</h4>
          {groups.existingRoads.map(road => (
            <div key={road.objectId} className="rd-road">
              <div className="rd-road-head">
                <b>{road.name || 'Unnamed road'}</b>
                <span>OBJECTID {road.objectId} · {plural(road.operations.length, 'operation')}</span>
              </div>
              <ul className="rd-changes">
                {road.operations.map(element => (
                  <ChangeRow key={element.id} element={element} viewer={viewer} showId={repeated.has(element.properties?.name)}
                    onEdit={edit} onDuplicate={duplicate} onRemove={remove} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {groups.newRoads.length > 0 && (
        <section className="rd-group">
          <h4 className="rd-group-title">New roads · {groups.newRoads.length}</h4>
          <ul className="rd-changes">
            {groups.newRoads.map(element => (
              <ChangeRow key={element.id} element={element} viewer={viewer} showId={repeated.has(element.properties?.name)}
                onEdit={edit} onDuplicate={duplicate} onRemove={remove} />
            ))}
          </ul>
        </section>
      )}

      {groups.other.length > 0 && (
        <section className="rd-group">
          <h4 className="rd-group-title">Other changes · {groups.other.length}</h4>
          <p className="scenario-field-note">Older records that reference no county road. Shown so nothing is hidden; they cannot be edited with the road tools.</p>
          <ul className="rd-changes">
            {groups.other.map(element => (
              <li key={element.id} className="rd-change">
                <div className="rd-change-head">
                  <span className="rd-change-name">{element.properties?.name ?? element.id}</span>
                  <span className="rd-change-meta">{changeDetail(element)}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ul className="design-legend" aria-label="Map colours">
        {['CREATE', 'WIDEN', 'REALIGN', 'CLOSE'].map(operation => (
          <li key={operation}>
            <i aria-hidden="true" style={{ background: ROAD_OPERATION_STYLE[operation].line }} />
            {ROAD_OPERATION_LABEL[operation]}
          </li>
        ))}
        <li><i aria-hidden="true" style={{ background: '#8A94A6' }} />Existing alignment</li>
      </ul>

      <Collapsible title="Design-wide checks"
        summary={`${plural(spatial.conflicts, 'potential conflict')} · ${spatial.findings.length - spatial.evaluated} not evaluated`}>
        <ul className="design-findings">
          {spatial.findings.map(finding => (
            <li key={finding.id} className={`is-${finding.status.toLowerCase()}`}>
              <strong>{finding.label}</strong><span>{finding.detail}</span>
            </li>
          ))}
        </ul>
        <p className="scenario-field-note">
          A geometric overlap test against the layers this twin holds. Parcels, utilities, right-of-way
          and traffic are not available and are not evaluated.
        </p>
      </Collapsible>
    </div>
  );
}

// ---- Compare -------------------------------------------------------------------------------------

function CompareTab({ viewer }) {
  const { designs, comparison, compareLeftId, setCompareLeftId, compareRightId, setCompareRightId,
    compareView } = viewer;
  const options = designs.filter(design => !isBaseline(design));
  /** "Design A — Road Widening" reads as "Design A" where width is short; the full name is the tooltip. */
  const shortName = name => String(name ?? '').split('—')[0].trim() || name;
  const sides = [comparison.left, comparison.right];
  const warnings = side => side?.connectivity?.filter(row => row.functionalStatus !== 'CONNECTED').length ?? 0;
  const rows = [
    ['Purpose', s => {
      const p = s.purpose?.purpose;
      return p ? `${PURPOSE_INFO[p].label}${s.purpose.inferred ? ' (inferred)' : ''}` : 'Not stated';
    }],
    ['Existing roads affected', s => fmt(s.summary.existingRoadsAffected)],
    ['Operations on existing roads', s => fmt(s.summary.operationsOnExisting)],
    ['New roads', s => (s.summary.duplicateCount && s.summary.newRoadCount !== s.summary.uniqueNewRoadCount
      ? `${s.summary.uniqueNewRoadCount} unique (${s.summary.newRoadCount} stored)` : fmt(s.summary.newRoadCount))],
    ['New road length', s => m(s.summary.uniqueNewRoadLengthM)],
    ['Widened road length', s => m(s.summary.widenedLengthM)],
    ['Proposed road area', s => (s.summary.overlapping
      ? `${m2(s.summary.uniqueAreaM2)} unique` : m2(s.summary.uniqueAreaM2))],
    ['Connectivity warnings', s => fmt(warnings(s))],
    ['Potential conflicts', s => fmt(s.spatial.conflicts)],
    ['Status', s => (s.design?.source === DESIGN_SOURCE.SYNTHETIC_DEMO ? 'Conceptual · demo' : 'Conceptual')],
  ];
  return (
    <div className="scenario-tab">
      <header className="scenario-compare-head">
        <h4>What physically changes</h4>
        <p>Every figure is measured from each design’s stored geometry</p>
      </header>
      <div className="scenario-grid-2">
        <label className="scenario-field">
          <span className="scenario-field-label">First</span>
          <select value={compareLeftId} title={designs.find(d => d.id === compareLeftId)?.name} onChange={e => setCompareLeftId(e.target.value)}>
            {options.map(d => <option key={d.id} value={d.id} title={d.name}>{shortName(d.name)}{d.archived ? ' (archived)' : ''}</option>)}
          </select>
        </label>
        <label className="scenario-field">
          <span className="scenario-field-label">Second</span>
          <select value={compareRightId} title={designs.find(d => d.id === compareRightId)?.name} onChange={e => setCompareRightId(e.target.value)}>
            {options.map(d => <option key={d.id} value={d.id} title={d.name}>{shortName(d.name)}{d.archived ? ' (archived)' : ''}</option>)}
          </select>
        </label>
      </div>
      <p className="scenario-field-note">Use the bar above the map to show the first design, the second, both, or only what differs.</p>
      {compareView === COMPARE_VIEW.DIFF && (
        <p className="scenario-field-note">Changes stored identically in both designs are drawn once, in grey. Everything in colour differs.</p>
      )}
      <table className="scenario-table rd-compare">
        <thead>
          <tr>
            <th scope="col">Metric</th>
            {sides.map((side, i) => <th key={i} scope="col" title={side.name}>{shortName(side.name)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, read]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {sides.map((side, i) => <td key={i}>{side.summary ? read(side) : '—'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="scenario-field-note">
        No design is ranked above the other. Different proposals can solve different engineering
        problems, and nothing here measures how either performs. Every design is conceptual.
      </p>
    </div>
  );
}

/**
 * Open the editor for an alternative. One restricted to an operation opens THAT editor, loaded with
 * its proposal when it has one — the selected change if any, else its first — so Edit Design on
 * the widening alternative is the widening editor, and so on.
 */
export function openEditorFor(design, viewer, studio) {
  const allowed = design?.allowedOperation;
  if (allowed) {
    const target = design.elements.find(e => e.id === viewer.selectedElementId) ?? design.elements[0];
    if (target) studio.loadElement(target);
    else studio.chooseMode(allowed);
  }
  viewer.setTab(DESIGN_TAB.EDIT);
}

// ---- one alternative, as a card ----------------------------------------------------------------------

/** One sentence saying what the alternative actually proposes, read from its changes. */
function cardSummary(design, purpose) {
  const elements = design.elements ?? [];
  if (!elements.length) {
    return {
      NEW_ROAD: 'Empty draft — draw the new alignment to begin.',
      REALIGNMENT: 'Empty draft — select a road and draw its new line.',
      WIDENING: 'Empty draft — select a road to widen.',
    }[purpose.purpose] ?? 'Empty draft. No road changes yet.';
  }
  const groups = groupRoadChanges(design);
  if (elements.length === 1) {
    const [only] = elements;
    const op = opOf(only);
    const road = only.baselineRef?.name ?? only.properties?.name ?? only.id;
    if (op === 'WIDEN') {
      return `Widen ${road} to ${only.proposal?.totalWidthM ?? '—'} m (${plural(only.proposal?.laneCount ?? 0, 'lane')}) over ${m(only.section?.lengthM ?? wideningMeasure(only)?.proposed.affectedLengthM.value)}.`;
    }
    if (op === 'CREATE') return `${road}: a new ${m(roadMeasure(only)?.lengthM)} road, ${only.properties?.widthM ?? '—'} m wide.`;
    if (op === 'REALIGN') return `Realign ${road} on a new ${m(roadMeasure(only)?.lengthM)} alignment.`;
    if (op === 'CLOSE') return `Close ${only.section ? m(only.section.lengthM) : 'all'} of ${road}.`;
  }
  const bits = [];
  if (groups.existingRoads.length) {
    const ops = groups.existingRoads.reduce((n, r) => n + r.operations.length, 0);
    bits.push(`${plural(ops, 'change')} on ${groups.existingRoads.map(r => r.name ?? `road ${r.objectId}`).slice(0, 2).join(', ')}`);
  }
  if (groups.newRoads.length) bits.push(plural(groups.newRoads.length, 'new road record'));
  return `${bits.join(' · ')}.`;
}

function AlternativeCard({ design, active, onSelect, roadsById }) {
  const purpose = purposeOf(design);
  const info = purpose.purpose ? PURPOSE_INFO[purpose.purpose] : null;
  const summary = useMemo(() => designSummary(design), [design]);
  const roadsTouched = summary.existingRoadsAffected + summary.uniqueNewRoadCount;
  const stored = Boolean(design.updatedAt);
  const title = /—/.test(design.name) || !info ? design.name : `${design.name} — ${info.label}`;
  const ops = [...new Set(design.elements.map(opOf))];
  return (
    <li className={`rd-card-alt${active ? ' is-active' : ''}`}>
      <button type="button" role="radio" aria-checked={active} className="rd-card-alt-main" onClick={onSelect}
        title={`${design.name} · ${stored ? `revision ${design.revision}` : 'not stored yet'}${design.source === DESIGN_SOURCE.SYNTHETIC_DEMO ? ` · ${SYNTHETIC_LABEL}` : ''}`}>
        <span className="rd-radio" aria-hidden="true" />
        <DesignThumbnail design={design} roadsById={roadsById} />
        <span className="rd-card-alt-body">
          <b>{title}</b>
          <span className="rd-card-alt-desc">{cardSummary(design, purpose)}</span>
          <span className="rd-chips">
            <i className="rd-chip is-count">{plural(roadsTouched, 'road')}</i>
            {ops.slice(0, 2).map(op => (
              <i key={op} className="rd-chip" style={{ color: ROAD_OPERATION_STYLE[op]?.line, background: `${ROAD_OPERATION_STYLE[op]?.line}1F` }}>
                {ROAD_OPERATION_LABEL[op]}
              </i>
            ))}
            {!ops.length && <i className="rd-chip is-draft">Empty draft</i>}
            {summary.duplicateCount > 0 && <i className="rd-chip is-warn">{summary.duplicateCount} duplicates</i>}
            {constraintViolations(design).length > 0 && (
              <i className="rd-chip is-warn" title={`Holds changes other than ${OPERATION_NAME[design.allowedOperation]?.toLowerCase()}; shown as stored, not converted.`}>
                {constraintViolations(design).length} incompatible
              </i>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

/** Rename, duplicate, purpose, archive and reset for the selected alternative. */
function AlternativeActions({ viewer, studio, askConfirm }) {
  const { activeDesign } = viewer;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(activeDesign.name);
  const [more, setMore] = useState(false);
  const [notice, setNotice] = useState(null);
  useEffect(() => { setName(activeDesign.name); setRenaming(false); setMore(false); setNotice(null); },
    [activeDesign.id, activeDesign.name]);
  const report = result => setNotice(result?.ok === false ? result.reason : null);
  const purpose = purposeOf(activeDesign);
  const commitRename = async () => {
    const result = await viewer.renameDesign(activeDesign.id, name);
    if (result.ok) setRenaming(false);
    report(result);
  };

  return (
    <div className="rd-card-actions">
      {renaming ? (
        <div className="rd-rename">
          <input type="text" value={name} autoFocus aria-label="Alternative name"
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(false); }} />
          <button type="button" className="scenario-primary" onClick={commitRename}>Save</button>
          <button type="button" className="scenario-secondary" onClick={() => setRenaming(false)}>Cancel</button>
        </div>
      ) : (
        <div className="rd-card-buttons">
          <button type="button" onClick={() => viewer.setTab(DESIGN_TAB.REVIEW)}>Changes ({activeDesign.elements.length})</button>
          <button type="button" onClick={() => openEditorFor(activeDesign, viewer, studio)}>Edit Design</button>
          <button type="button" disabled={!activeDesign.elements.length} onClick={viewer.frame}>Focus</button>
          <button type="button" aria-expanded={more} onClick={() => setMore(v => !v)}>More {more ? '▴' : '▾'}</button>
        </div>
      )}
      {more && !renaming && (
        <div className="rd-more">
          <div className="rd-card-buttons">
            <button type="button" onClick={() => setRenaming(true)}>Rename</button>
            <button type="button" onClick={async () => report(await viewer.duplicateAlternative(activeDesign.id))}>Duplicate</button>
            <button type="button" onClick={() => askConfirm({
              title: activeDesign.archived ? 'Restore this alternative?' : 'Archive this alternative?',
              body: <p>{activeDesign.archived
                ? `${activeDesign.name} will appear in the list again.`
                : `${activeDesign.name} will be hidden from the list. It stays stored with all its changes; “Show archived” brings it back.`}</p>,
              action: activeDesign.archived ? 'Restore' : 'Archive',
              onConfirm: () => viewer.setArchived(activeDesign.id, !activeDesign.archived),
            })}>{activeDesign.archived ? 'Restore' : 'Archive'}</button>
            {isDemo(activeDesign) && (
              <button type="button" onClick={() => askConfirm({
                title: 'Reset this demo alternative?',
                body: <p>{activeDesign.name} goes back to its template. Revision {activeDesign.revision} is kept in the store’s history file.</p>,
                action: 'Reset to template',
                danger: true,
                onConfirm: () => viewer.resetDemo(activeDesign.id),
              })}>Reset demo</button>
            )}
          </div>
          <label className="scenario-field">
            <span className="scenario-field-label">Purpose</span>
            <select value={activeDesign.purpose ?? ''}
              onChange={async e => report(await viewer.setPurpose(activeDesign.id, e.target.value))}>
              <option value="">Not stated{purpose.inferred && purpose.purpose ? ` (reads as ${PURPOSE_INFO[purpose.purpose].label.toLowerCase()})` : ''}</option>
              {Object.values(DESIGN_PURPOSE).map(p => <option key={p} value={p}>{PURPOSE_INFO[p].label}</option>)}
            </select>
          </label>
        </div>
      )}

      {notice && <p className="scenario-error">{notice}</p>}
    </div>
  );
}

/** The demo-set confirmation, with the opt-in to archive the original A, B and C. */
function DemoSetBody({ choice }) {
  const [archive, setArchive] = useState(choice.current.archive);
  return (
    <>
      <p>Three alternatives are added under their own ids. Nothing you have saved is renamed, overwritten or deleted, and one that already exists is left as it is.</p>
      <ul>
        <li><b>Design A — Road Widening</b>: S CRUISE BLVD (OBJECTID 40642), a 60 m section at 10 m and 2 lanes. Existing width stays Unknown.</li>
        <li><b>Design B — New Access Road</b>: empty until you draw it. No route is invented.</li>
        <li><b>Design C — Road Realignment</b>: empty until you select a road and draw its replacement.</li>
      </ul>
      <label className="rd-check">
        <input type="checkbox" checked={archive} onChange={e => { setArchive(e.target.checked); choice.current.archive = e.target.checked; }} />
        Also archive the existing “Design A”, “Design B” and “Design C” so only the demonstration set shows.
        They keep all their changes and “Show archived” restores them.
      </label>
    </>
  );
}

// ---- the workspace ---------------------------------------------------------------------------------

export function DesignAlternatives({ viewer, studio, cameraHandlers, roadsById, presenting = false }) {
  const { visibleDesigns, designs, activeDesign, activeId, tab, setTab } = viewer;
  const [confirm, setConfirm] = useState(null);
  const [notice, setNotice] = useState(null);
  const [dashOpen, setDashOpen] = useState(true);
  const demoChoice = useRef({ archive: true });
  const archivedCount = designs.filter(design => design.archived).length;
  // The primary three in A, B, C order; anything else after them, by name.
  const rank = design => (PRIMARY_IDS.includes(design.id) ? PRIMARY_IDS.indexOf(design.id) : 10);
  const alternatives = visibleDesigns.filter(design => !isBaseline(design))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const primaryMissing = PRIMARY_IDS.some(id => !designs.some(d => d.id === id));
  const otherCount = viewer.otherDesigns?.length ?? 0;
  const baselineActive = isBaseline(activeDesign);

  // A draft belongs to the alternative it was started in: switching drops it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { studio.reset(); }, [activeId]);
  // Leaving the editor takes its draft preview off the map; the saved design is drawn by the overlay.
  useEffect(() => {
    if (tab !== DESIGN_TAB.EDIT) studio.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  // Presenting hides editing: the panel returns to the cards and any draft leaves the map.
  useEffect(() => {
    if (!presenting) return;
    studio.reset();
    if (tab === DESIGN_TAB.EDIT || tab === DESIGN_TAB.REVIEW) setTab(DESIGN_TAB.ALTERNATIVES);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenting]);

  const loadDemos = () => setConfirm({
    title: 'Set up the demonstration alternatives?',
    body: <DemoSetBody choice={demoChoice} />,
    action: 'Set up demo alternatives',
    onConfirm: async () => {
      const result = await viewer.loadDemoTemplates({ archiveLegacy: demoChoice.current.archive });
      setNotice(result.ok
        ? `Added ${result.created.length}${result.skipped.length ? `, ${result.skipped.length} already existed` : ''}${result.archived.length ? `; archived ${result.archived.length}` : ''}.`
        : `Some were not stored: ${result.failed.join('; ')}`);
      return result.ok ? { ok: true } : { ok: false, reason: result.failed.join('; ') };
    },
  });

  const openCompare = (leftId, rightId) => {
    if (leftId) viewer.setCompareLeftId(leftId);
    if (rightId) viewer.setCompareRightId(rightId);
    viewer.setCompareView(COMPARE_VIEW.OVERLAY);
    setTab(DESIGN_TAB.COMPARE);
  };
  const startCompare = () => {
    const pool = alternatives.length >= 2 ? alternatives : designs.filter(d => !isBaseline(d));
    const left = baselineActive ? pool[0] : activeDesign;
    const right = pool.find(d => d.id !== left?.id);
    openCompare(left?.id, right?.id);
  };
  const back = (
    <button type="button" className="rd-back" onClick={() => setTab(DESIGN_TAB.ALTERNATIVES)}>← All alternatives</button>
  );

  return (
    <div className={`rd-root${dashOpen ? ' has-dash' : ''}${presenting ? ' is-presenting' : ''}`}>
      {/* ---- over the map ---- */}
      <div className="rd-mapbar" role="group" aria-label="Map view" data-label-obstacle>
        {tab === DESIGN_TAB.COMPARE ? (
          [[COMPARE_VIEW.LEFT, 'First'], [COMPARE_VIEW.RIGHT, 'Second'], [COMPARE_VIEW.OVERLAY, 'Overlay'], [COMPARE_VIEW.DIFF, 'Differences']].map(([id, label]) => (
            <button key={id} type="button" aria-pressed={viewer.compareView === id} onClick={() => viewer.setCompareView(id)}>{label}</button>
          ))
        ) : (
          [[VIEW_MODE.EXISTING, 'Existing'], [VIEW_MODE.PROPOSED, 'Proposed'], [VIEW_MODE.OVERLAY, 'Overlay']].map(([id, label]) => (
            <button key={id} type="button" aria-pressed={viewer.viewMode === id} onClick={() => viewer.setViewMode(id)}>{label}</button>
          ))
        )}
      </div>

      <div className="rd-maptools" data-label-obstacle>
        <button type="button" className="rd-compass" title="Focus the road network" aria-label="Focus the road network"
          onClick={viewer.focusRoadNetwork}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 2.5l2.4 7.1L21.5 12l-7.1 2.4L12 21.5l-2.4-7.1L2.5 12l7.1-2.4z" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" />
          </svg>
        </button>
        <button type="button" className="rd-tool" disabled={baselineActive || !activeDesign.elements.length}
          onClick={viewer.frame}>Focus design</button>
        <label className="rd-tool rd-tool-check">
          <input type="checkbox" checked={viewer.labelsVisible} onChange={e => viewer.setLabelsVisible(e.target.checked)} />
          Labels
        </label>
        {!presenting && (
          <div className="rd-camera" role="group" aria-label="Map navigation">
            <MapControlButtons handlers={cameraHandlers ?? {}} keys={PANEL_CAMERA_KEYS} grouped={false} />
          </div>
        )}
      </div>

      <ul className="rd-legend" aria-label="Map legend" data-label-obstacle>
        <li><i style={{ background: '#8A94A6' }} />Existing road</li>
        {['WIDEN', 'CREATE', 'REALIGN'].map(op => (
          <li key={op}><i style={{ background: ROAD_OPERATION_STYLE[op].line }} />{ROAD_OPERATION_LABEL[op]}</li>
        ))}
        <li><i className="is-dashed" style={{ color: ROAD_OPERATION_STYLE.CLOSE.line }} />Closure</li>
        <li><i className="is-outline" />Potential conflict</li>
      </ul>

      {/* ---- the right-hand panel ---- */}
      <section className="rd-studio-panel" aria-label="Design alternatives" data-label-obstacle>
        <header className="rd-studio-head">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3 21 8l-9 5-9-5z" /><path d="M3 12.5l9 5 9-5" /><path d="M3 17l9 5 9-5" />
          </svg>
          <div>
            <h2>Design Alternatives</h2>
            <p>Compare road infrastructure proposals</p>
          </div>
        </header>

        {tab === DESIGN_TAB.ALTERNATIVES && (
          <div className="rd-studio-body">
            <button type="button" className={`rd-baseline-row${baselineActive ? ' is-active' : ''}`}
              role="radio" aria-checked={baselineActive} onClick={() => viewer.chooseDesign('baseline')}>
              <span className="rd-radio" aria-hidden="true" />
              <b>Existing Baseline</b>
              <span>{viewer.baselineRoadCount.toLocaleString()} county road segments · no changes</span>
            </button>
            {alternatives.length === 0 ? (
              <div className="rd-empty">
                <h4>No road alternatives yet</h4>
                <p>Create one, or set up the demonstration alternatives.</p>
              </div>
            ) : (
              <ul className="rd-cards" role="radiogroup" aria-label="Design alternative">
                {alternatives.map(design => (
                  <AlternativeCard key={design.id} design={design} active={design.id === activeId}
                    roadsById={roadsById} onSelect={() => viewer.chooseDesign(design.id)} />
                ))}
              </ul>
            )}
            {/* The selected alternative's actions sit under the list, so every card stays compact. */}
            {!presenting && !baselineActive && (
              <AlternativeActions viewer={viewer} studio={studio} askConfirm={setConfirm} />
            )}
            {!presenting && (
              <div className="rd-panel-links">
                <button type="button" className="rd-link" onClick={async () => {
                  const result = await viewer.createRoadDesign();
                  setNotice(result.ok ? null : result.reason);
                }}>+ New alternative</button>
                {primaryMissing && (
                  <button type="button" className="rd-link" onClick={loadDemos}>Set up demo alternatives…</button>
                )}
                {(primaryMissing ? archivedCount : otherCount) > 0 && (
                  <label><input type="checkbox" checked={viewer.showArchived}
                    onChange={e => viewer.setShowArchived(e.target.checked)} />
                    {primaryMissing ? ` Show archived (${archivedCount})` : ` Other alternatives (${otherCount})`}</label>
                )}
              </div>
            )}
            {(notice || viewer.demoNotice) && <p className="scenario-field-note">{notice ?? viewer.demoNotice}</p>}
            {!viewer.persistence.writable && viewer.persistence.state === 'READY' && !presenting && (
              <p className="scenario-warn">Saving is switched off on this host.</p>
            )}
          </div>
        )}

        {tab === DESIGN_TAB.REVIEW && (
          <div className="rd-studio-body">
            {back}
            <h3 className="rd-pane-title">{activeDesign.name}<span>{plural(activeDesign.elements.length, 'road change')}</span></h3>
            {activeDesign.source === DESIGN_SOURCE.SYNTHETIC_DEMO && <p className="rd-synthetic">{SYNTHETIC_LABEL}</p>}
            <OverviewTab viewer={viewer} studio={studio} askConfirm={setConfirm} />
          </div>
        )}

        {tab === DESIGN_TAB.EDIT && (
          <div className="rd-studio-body">
            {back}
            {baselineActive
              ? <p className="scenario-empty">The baseline is read-only. Choose or create an alternative to propose a change.</p>
              : <RoadDesignStudio studio={studio} designName={activeDesign.name}
                allowedOperation={activeDesign.allowedOperation ?? null}
                editingName={studio.editingId
                  ? activeDesign.elements.find(e => e.id === studio.editingId)?.properties?.name ?? studio.editingId
                  : null} />}
          </div>
        )}

        {tab === DESIGN_TAB.COMPARE && (
          <div className="rd-studio-body">
            {back}
            <CompareTab viewer={viewer} />
          </div>
        )}

        {tab === DESIGN_TAB.ALTERNATIVES && (
          <div className="rd-studio-foot">
            <button type="button" className="rd-compare-btn" onClick={startCompare}
              disabled={designs.filter(d => !isBaseline(d)).length < 2}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12-7.5z" /></svg>
              Compare Alternatives
            </button>
          </div>
        )}
        <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
      </section>

      <DesignDashboard viewer={viewer} open={dashOpen}
        onToggle={() => setDashOpen(v => !v)} onCompare={openCompare} />
    </div>
  );
}
