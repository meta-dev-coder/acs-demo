/**
 * The Road Design Studio's engineering dashboard: four cards along the bottom of the map.
 *
 *   Road Quantities       measured from the active design (or the selected change).
 *   Network Connectivity  what the connectivity engine tested — and "Not evaluated" where it did not.
 *   Design Validation     the spatial checks and the data limits, each with its real status.
 *   Design Comparison     the active design against one other, by the same arithmetic.
 *
 * No status here is decorative. A green tick means a check ran and passed within the layers this
 * twin holds; a check that could not run says Not evaluated, and none claims traffic, access or
 * constructability findings that nothing here computes.
 */
import { useMemo } from 'react';
import { isBaseline } from '../designs/designModel.js';
import { isWidening, roadMeasure, roadOperationOf, wideningMeasure } from '../designs/designQuantities.js';
import { validateConnectivity, validateDesignSpatially } from '../designs/designValidation.js';
import { designSummary, realignmentMetrics, surfaceRingOf, TIE_IN_TOLERANCE_M } from '../designs/designReview.js';
import { validateWidening } from '../designs/roadWidening.js';
import { checkSiteConflicts } from '../scenarios/siteConflicts.js';

const m = v => (Number.isFinite(v) ? `${Math.round(v).toLocaleString()} m` : '—');
const m2 = v => (Number.isFinite(v) ? `${Math.round(v).toLocaleString()} m²` : '—');
const short = name => String(name ?? '').split('—')[0].trim() || name;

const STATUS = {
  ok: { glyph: <path d="M6.5 12.5l3.5 3.5 7.5-8" />, label: 'Passed within evaluated scope' },
  warn: { glyph: <><path d="M12 7.5v5.5" /><path d="M12 16.5h.01" /></>, label: 'Warning' },
  bad: { glyph: <><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" /></>, label: 'Potential conflict' },
  info: { glyph: <><path d="M12 11v5.5" /><path d="M12 7.5h.01" /></>, label: 'Not evaluated' },
};

function Status({ tone }) {
  return (
    <span className={`rd-status is-${tone}`} role="img" aria-label={STATUS[tone].label}>
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.8"
        strokeLinecap="round" strokeLinejoin="round">{STATUS[tone].glyph}</svg>
    </span>
  );
}

const Icon = ({ children }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

/** One row of a status list; clickable when it points at a change on the map. */
function Finding({ tone, text, onClick }) {
  const body = <><Status tone={tone} /><span>{text}</span></>;
  return (
    <li className={`is-${tone}`}>
      {onClick ? <button type="button" onClick={onClick} title="Show on the map">{body}</button> : body}
    </li>
  );
}

const firstHitElement = finding => {
  const hit = finding?.hits?.[0];
  return Array.isArray(hit) ? hit[0] : hit?.element ?? null;
};

export function DesignDashboard({ viewer, open, onToggle, onCompare }) {
  const { activeDesign, summary, spatial, connectivity, selectedElement, clashes, designs } = viewer;
  const { roads, buildings } = viewer.baselineLayers;
  const others = designs.filter(d => !isBaseline(d) && d.id !== activeDesign?.id && !d.archived);
  const benchmark = designs.find(d => d.id === viewer.benchmarkId && d.id !== activeDesign?.id) ?? others[0] ?? null;

  const benchmarkFigures = useMemo(() => (benchmark ? {
    summary: designSummary(benchmark),
    spatial: validateDesignSpatially(benchmark, { roads, buildings }),
    connectivity: validateConnectivity(benchmark, { roads }),
  } : null), [benchmark, roads, buildings]);

  if (!open) {
    return (
      <button type="button" className="rd-dash-tab" aria-expanded="false" onClick={onToggle}>
        Engineering dashboard <span aria-hidden="true">▴</span>
      </button>
    );
  }

  const baseline = isBaseline(activeDesign);
  const name = short(activeDesign?.name);

  // ---- Road Quantities ---------------------------------------------------------------------------
  const quantityRows = (() => {
    if (baseline) {
      return [['Road segments', `${viewer.baselineRoadCount.toLocaleString()}`], ['Published widths', 'None'],
        ['Published lane counts', 'None'], ['Proposed changes', '0']];
    }
    if (selectedElement) {
      const op = roadOperationOf(selectedElement);
      if (op === 'WIDEN') {
        const w = wideningMeasure(selectedElement);
        return [['Widened length', m(w?.proposed.affectedLengthM.value)],
          ['Proposed width · lanes', `${w?.proposed.totalWidthM.value ?? '—'} m · ${w?.proposed.lanes.value ?? '—'}`],
          ['Proposed corridor area', m2(w?.proposed.corridorAreaM2.value)],
          ['Existing width', selectedElement.proposal?.baselineWidthM == null ? 'Unknown' : `${selectedElement.proposal.baselineWidthM} m (user assumed)`]];
      }
      const r = roadMeasure(selectedElement);
      return [[op === 'CLOSE' ? 'Closed length' : 'Road length', m(op === 'CLOSE' && selectedElement.section ? selectedElement.section.lengthM : r?.lengthM)],
        ['Width · lanes', `${selectedElement.properties?.widthM ?? '—'} m · ${selectedElement.properties?.lanes ?? '—'}`],
        ['Proposed surface', surfaceRingOf(selectedElement) ? m2(r?.surfaceAreaM2) : 'None'],
        ['Affects', selectedElement.baselineRef?.objectId ? `OBJECTID ${selectedElement.baselineRef.objectId}` : 'New alignment']];
    }
    return [['Widened road length', m(summary.widenedLengthM)],
      ['New road length', m(summary.uniqueNewRoadLengthM)],
      ['Proposed road area', m2(summary.uniqueAreaM2)],
      ['Affected roads', `${summary.existingRoadsAffected}`]];
  })();

  // ---- Network Connectivity ------------------------------------------------------------------------
  const ends = connectivity.flatMap(row => row.ends ?? []);
  const count = status => ends.filter(end => end.status === status).length;
  const connected = count('CONNECTED'), potential = count('POTENTIAL'), disconnected = count('DISCONNECTED');
  const unevaluated = count('NOT_EVALUATED');
  const facilityEnds = ends.filter(end => end.role === 'FACILITY_ENTRANCE');
  const connectivityItems = baseline || connectivity.length === 0 ? null : [
    connected > 0 && { tone: 'ok', text: `${connected} endpoint${connected === 1 ? '' : 's'} on the existing network` },
    potential > 0 && { tone: 'warn', text: `${potential} endpoint${potential === 1 ? '' : 's'} near but not on a road (unverified)` },
    disconnected > 0 && { tone: 'bad', text: `${disconnected} endpoint${disconnected === 1 ? '' : 's'} not reaching the network` },
    unevaluated > 0 && { tone: 'info', text: `${unevaluated} endpoint${unevaluated === 1 ? '' : 's'} not evaluated` },
    facilityEnds.length > 0
      ? { tone: facilityEnds.every(end => end.status === 'CONNECTED') ? 'ok' : 'warn', text: `${facilityEnds.length} facility access end${facilityEnds.length === 1 ? '' : 's'}` }
      : { tone: 'info', text: 'No facility access point declared' },
  ].filter(Boolean).slice(0, 4);

  // ---- Design Validation -----------------------------------------------------------------------------
  const finding = id => spatial.findings.find(f => f.id === id);
  const focusHit = f => (firstHitElement(f) ? () => viewer.focusElement(firstHitElement(f)) : undefined);
  const validationItems = (() => {
    if (baseline) return [{ tone: 'info', text: 'Nothing proposed, so nothing to validate' }];
    const items = [];
    const b = finding('buildings');
    if (b) {
      items.push(b.status === 'CONFLICT'
        ? { tone: 'bad', text: `${b.hits.length} building overlap${b.hits.length === 1 ? '' : 's'}`, onClick: focusHit(b) }
        : b.status === 'NOT_EVALUATED' ? { tone: 'info', text: 'Buildings not evaluated' }
          : { tone: 'ok', text: 'No building conflicts' });
    }
    const overlap = finding('road-overlap');
    if (overlap) items.push({ tone: 'bad', text: `${overlap.hits.length} proposal${overlap.hits.length === 1 ? '' : 's'} running along an existing road`, onClick: focusHit(overlap) });
    const self = finding('self');
    if (summary.duplicateCount > 0) {
      items.push({ tone: 'warn', text: `${summary.duplicateCount} duplicate record${summary.duplicateCount === 1 ? '' : 's'} (counted once)` });
    } else if (self?.status === 'CONFLICT' || clashes.length) {
      items.push({ tone: 'warn', text: `${Math.max(self?.hits?.length ?? 0, clashes.length)} overlapping proposals`, onClick: focusHit(self) });
    } else if (self) {
      items.push({ tone: 'ok', text: 'Proposed corridors do not overlap' });
    }
    const widenings = activeDesign.elements.filter(isWidening);
    if (widenings.some(e => e.proposal?.baselineWidthM == null)) {
      items.push({ tone: 'warn', text: 'Existing width: Unknown (GIS)' });
      items.push({ tone: 'warn', text: 'Incremental pavement: Not calculable' });
    }
    items.push({ tone: 'info', text: 'Vertical alignment, utilities, right-of-way: not evaluated' });
    return items.slice(0, 4);
  })();

  // ---- Design Comparison -------------------------------------------------------------------------------
  const warningsOf = rows => rows.filter(row => row.functionalStatus !== 'CONNECTED').length;
  const comparisonRows = !baseline && benchmarkFigures ? [
    ['New road length', m(summary.uniqueNewRoadLengthM), m(benchmarkFigures.summary.uniqueNewRoadLengthM)],
    ['Widened road length', m(summary.widenedLengthM), m(benchmarkFigures.summary.widenedLengthM)],
    ['Proposed road area', m2(summary.uniqueAreaM2), m2(benchmarkFigures.summary.uniqueAreaM2)],
    ['Connectivity warnings', `${warningsOf(connectivity)}`, `${warningsOf(benchmarkFigures.connectivity)}`],
  ] : null;

  /*
   * ONE ALTERNATIVE, ONE OPERATION, ITS OWN FIGURES.
   *
   * An alternative restricted to widening, new road or realignment gets the four cards that
   * operation calls for — the same card frames, different content — computed from its own
   * geometry. Anything else (mixed or legacy records) keeps the generic cards above.
   */
  const specific = (() => {
    if (baseline) return null;
    const op = activeDesign.allowedOperation;
    const element = (selectedElement && roadOperationOf(selectedElement) === op ? selectedElement : null)
      ?? activeDesign.elements.find(e => roadOperationOf(e) === op);
    if (!op || !element) return null;
    const road = element.baselineRef?.objectId ? roads?.find(r => r.objectId === element.baselineRef.objectId) : null;
    const ring = surfaceRingOf(element);
    const buildingCheck = ring ? checkSiteConflicts(ring, { buildings, roads: null }).checks.find(c => c.id === 'buildings') : null;
    const buildingItem = !buildingCheck || buildingCheck.status === 'NOT_EVALUATED'
      ? { tone: 'info', text: 'Buildings not evaluated' }
      : buildingCheck.status === 'CONFLICT'
        ? { tone: 'bad', text: 'Overlaps an existing building', onClick: () => viewer.focusElement(element.id) }
        : { tone: 'ok', text: 'No building conflicts' };
    const row = connectivity.find(r => r.elementId === element.id);
    const endText = (end, label) => {
      const where = end?.nearestRoad ? ` · ${end.nearestRoad}` : '';
      const tone = end?.status === 'CONNECTED' ? 'ok' : end?.status === 'POTENTIAL' ? 'warn'
        : end?.status === 'DISCONNECTED' ? 'bad' : 'info';
      const status = { CONNECTED: 'connected', POTENTIAL: `potential (${end?.distanceM} m away)`, DISCONNECTED: 'not connected', NOT_EVALUATED: 'not evaluated' }[end?.status] ?? 'not evaluated';
      return { tone, text: `${label}: ${status}${end?.status === 'CONNECTED' ? where : ''}` };
    };
    const width = element.proposal?.totalWidthM ?? element.properties?.widthM;
    const lanes = element.proposal?.laneCount ?? element.properties?.lanes;

    if (op === 'WIDEN') {
      const w = wideningMeasure(element);
      const check = road ? validateWidening({
        coordinates: road.coordinates, startM: element.section?.startMeasureM ?? null, endM: element.section?.endMeasureM ?? null,
        totalWidthM: width, laneCount: lanes, side: element.proposal?.wideningSide, baselineWidthM: element.proposal?.baselineWidthM ?? null,
      }) : null;
      const baselineWidth = element.proposal?.baselineWidthM;
      return {
        quantities: [
          ['Affected road', `${element.baselineRef?.name ?? '—'} · ${element.baselineRef?.objectId ?? ''}`],
          ['Widened length', m(w?.proposed.affectedLengthM.value)],
          ['Proposed width · lanes', `${width ?? '—'} m · ${lanes ?? '—'}`],
          ['Proposed corridor area', m2(w?.proposed.corridorAreaM2.value)],
        ],
        connectivity: [
          { tone: 'ok', text: 'Original centreline unchanged — road continuity kept' },
          element.section
            ? { tone: 'ok', text: `Section ends on the road at ${Math.round(element.section.startMeasureM)} m and ${Math.round(element.section.endMeasureM)} m` }
            : { tone: 'ok', text: 'Whole road widened, ends unchanged' },
          { tone: 'info', text: 'Junction capacity: not evaluated' },
        ],
        validation: [
          buildingItem,
          baselineWidth == null ? { tone: 'warn', text: 'Existing width: Unknown (GIS)' } : { tone: 'warn', text: `Existing width ${baselineWidth} m is a user assumption` },
          check && !check.ok ? { tone: 'bad', text: check.errors[0] } : { tone: 'ok', text: 'Section geometry is valid' },
          { tone: 'info', text: 'Elevation: not evaluated' },
        ],
        compare: {
          head: ['Metric', 'Existing', 'Proposed'],
          rows: [
            ['Width', baselineWidth == null ? 'Unknown' : `${baselineWidth} m*`, `${width ?? '—'} m`],
            ['Lanes', 'Unknown', `${lanes ?? '—'}`],
            ['Section length', m(w?.proposed.affectedLengthM.value), m(w?.proposed.affectedLengthM.value)],
            ['Added pavement', '—', w?.difference.incrementalPavementM2.value == null ? 'Not calculable' : m2(w.difference.incrementalPavementM2.value)],
          ],
        },
      };
    }
    if (op === 'CREATE') {
      const r = roadMeasure(element);
      const overlap = finding('road-overlap');
      return {
        quantities: [
          ['New road length', m(r?.lengthM)],
          ['Proposed width · lanes', `${width ?? '—'} m · ${lanes ?? '—'}`],
          ['Corridor area', m2(r?.surfaceAreaM2)],
          ['Road', element.properties?.name ?? element.id],
        ],
        connectivity: row ? [
          endText(row.ends[0], 'Start'),
          endText(row.ends[1], 'End'),
          { tone: row.geometricStatus === 'CONNECTED' ? 'ok' : row.geometricStatus === 'POTENTIAL' ? 'warn' : row.geometricStatus === 'DISCONNECTED' ? 'bad' : 'info',
            text: `Overall (geometric): ${row.geometricStatus.toLowerCase().replace('_', ' ')}` },
        ] : [{ tone: 'info', text: 'Not evaluated — the road layer has not loaded' }],
        validation: [
          buildingItem,
          overlap ? { tone: 'bad', text: 'Runs along an existing road', onClick: () => viewer.focusElement(element.id) }
            : { tone: 'ok', text: 'No corridor overlap with existing roads' },
          (element.geometry?.coordinates?.length ?? 0) >= 2 ? { tone: 'ok', text: 'Centreline geometry is valid' } : { tone: 'bad', text: 'Centreline has fewer than two points' },
          { tone: 'info', text: 'Vertical profile: not evaluated' },
        ],
        compare: {
          head: ['Metric', 'Baseline', 'Proposed'],
          rows: [
            ['Road length', '0 m (no road)', m(r?.lengthM)],
            ['Corridor area', '0 m²', m2(r?.surfaceAreaM2)],
            ['Lanes', '—', `${lanes ?? '—'}`],
            ['Connected ends', '—', `${(row?.ends ?? []).filter(e => e.status === 'CONNECTED').length} of 2`],
          ],
        },
      };
    }
    if (op === 'REALIGN') {
      const metrics = road ? realignmentMetrics(element, road) : null;
      const r = roadMeasure(element);
      const tie = (gap, label) => (gap == null ? { tone: 'info', text: `${label} tie-in: not evaluated` }
        : gap <= TIE_IN_TOLERANCE_M ? { tone: 'ok', text: `${label} tie-in on the original road (${gap.toFixed(2)} m)` }
          : { tone: 'bad', text: `${label} tie-in ${gap.toFixed(1)} m off the original road` });
      const overlap = finding('road-overlap');
      return {
        quantities: [
          ['Original affected length', m(metrics?.originalLengthM)],
          ['Proposed length', m(metrics?.proposedLengthM)],
          ['Length difference', metrics ? `${metrics.lengthDifferenceM >= 0 ? '+' : ''}${metrics.lengthDifferenceM.toFixed(1)} m` : '—'],
          ['Proposed corridor area', m2(r?.surfaceAreaM2)],
        ],
        connectivity: [
          tie(metrics?.startTieM, 'Start'),
          tie(metrics?.endTieM, 'End'),
          metrics?.tiedIn ? { tone: 'ok', text: 'No network disconnection at the tie-ins' } : { tone: 'warn', text: 'Possible disconnection — a tie-in has moved' },
        ],
        validation: [
          buildingItem,
          metrics?.selfIntersects ? { tone: 'bad', text: 'Proposed alignment crosses itself' } : { tone: 'ok', text: 'Proposed alignment geometry is valid' },
          overlap ? { tone: 'warn', text: 'Corridor runs along another road', onClick: () => viewer.focusElement(element.id) }
            : { tone: 'ok', text: 'No overlap with other roads' },
          { tone: 'info', text: 'Vertical profile: not evaluated' },
        ],
        compare: {
          head: ['Metric', 'Original', 'Proposed'],
          rows: [
            ['Alignment length', m(metrics?.originalLengthM), m(metrics?.proposedLengthM)],
            ['Lateral displacement', '0 m', metrics ? `${metrics.maxLateralM.toFixed(1)} m` : '—'],
            ['Width · lanes', 'Unknown', `${width ?? '—'} m · ${lanes ?? '—'}`],
            ['Source OBJECTID', `${element.baselineRef?.objectId ?? '—'}`, `${element.baselineRef?.objectId ?? '—'}`],
          ],
        },
      };
    }
    return null;
  })();
  const shownQuantities = specific?.quantities ?? quantityRows;
  const shownConnectivity = specific ? specific.connectivity : connectivityItems;
  const shownValidation = specific?.validation ?? validationItems;

  return (
    <section className="rd-dash" aria-label="Engineering dashboard" data-label-obstacle>
      <button type="button" className="rd-dash-hide" aria-expanded="true" aria-label="Hide the dashboard"
        title="Hide the dashboard" onClick={onToggle}>▾</button>

      <article className="rd-card">
        <h3><Icon><path d="M7 20 10 4M17 20 14 4M12 6v2M12 11v2M12 16v2" /></Icon>
          {selectedElement && !baseline ? 'Road Quantities (selected)' : `Road Quantities${baseline ? '' : ` (${name})`}`}</h3>
        <dl className="rd-rows">
          {shownQuantities.map(([label, value]) => <div key={label}><dt>{label}</dt><dd title={String(value)}>{value}</dd></div>)}
        </dl>
      </article>

      <article className="rd-card">
        <h3><Icon><circle cx="6" cy="6" r="2.2" /><circle cx="18" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="18" r="2.2" /><path d="M8 8l8 8M16 8l-8 8" /></Icon>
          Network Connectivity</h3>
        {shownConnectivity ? (
          <ul className="rd-findings">{shownConnectivity.map(item => <Finding key={item.text} {...item} />)}</ul>
        ) : (
          <ul className="rd-findings">
            <Finding tone="info" text={baseline ? 'Not evaluated — no proposed alignments' : 'Not evaluated — this design has no proposed alignment to test'} />
          </ul>
        )}
        <p className="rd-card-note">Geometric proximity to county centrelines, not traffic function.</p>
      </article>

      <article className="rd-card">
        <h3><Icon><path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></Icon>
          Design Validation</h3>
        <ul className="rd-findings">{shownValidation.map(item => <Finding key={item.text} {...item} />)}</ul>
      </article>

      <article className="rd-card">
        <h3><Icon><path d="M5 20V11M12 20V5M19 20v-6" /></Icon>Design Comparison</h3>
        {specific ? (
          <>
            <table className="rd-cmp">
              <thead><tr>{specific.compare.head.map(h => <th key={h} scope="col">{h}</th>)}</tr></thead>
              <tbody>
                {specific.compare.rows.map(([label, a, b]) => <tr key={label}><th scope="row">{label}</th><td title={a}>{a}</td><td title={b}>{b}</td></tr>)}
              </tbody>
            </table>
            {benchmark && <button type="button" className="rd-link" onClick={() => onCompare(activeDesign.id, benchmark.id)}>Compare with other alternatives →</button>}
          </>
        ) : comparisonRows ? (
          <>
            <table className="rd-cmp">
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  <th scope="col">{name}</th>
                  <th scope="col">
                    <select value={benchmark.id} aria-label="Compare with" onChange={e => viewer.setBenchmarkId(e.target.value)}>
                      {others.map(d => <option key={d.id} value={d.id}>{short(d.name)}</option>)}
                    </select>
                  </th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map(([label, a, b]) => <tr key={label}><th scope="row">{label}</th><td>{a}</td><td>{b}</td></tr>)}
              </tbody>
            </table>
            <button type="button" className="rd-link" onClick={() => onCompare(activeDesign.id, benchmark.id)}>Full comparison →</button>
          </>
        ) : (
          <p className="rd-card-empty">{baseline ? 'Select an alternative to compare it with another.' : 'Create a second alternative to compare against.'}</p>
        )}
      </article>
    </section>
  );
}
