/**
 * The Safety Intelligence screen's markup, as pure functions.
 *
 * Every panel is `data -> HTML string`: no DOM reads, no fetches, no clock. That keeps the screen's
 * wiring (`safetyIntelligenceWorkspace.js`) free of presentation and makes each panel testable by
 * calling it, which is how the data-honesty rules are checked — an uncalculable KPI must render its
 * reason somewhere, a hotspot must render its asset-derived caveat, and a count must never render
 * as a rate.
 *
 * One rule runs through all of it: a number appears beside the words that say what it counts. There
 * is no bare figure anywhere on this screen.
 */
import { KPI_STATUS } from './analytics/safetyKpis.js';
import { DOMAIN_TONES } from './tones.js';

export const escape = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const number = value => (typeof value === 'number'
  ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : escape(value));

/* ============================================================================================
   Region 1 — the KPI header
   ============================================================================================ */

/**
 * One KPI.
 *
 * Only ever an AVAILABLE one. What cannot be calculated is not a tile: it is listed, with the
 * source each would need, in the footer's "What this screen is reading" disclosure, beside the
 * sources that ARE present. Keeping it out of the header stops a row of grey boxes crowding out the
 * numbers that exist; keeping it in the footer stops the screen looking complete when it is not.
 */
export const kpiTile = kpi => `<div class="si-kpi" data-kpi="${escape(kpi.id)}"
    title="${escape(kpi.basis ?? '')}">
    <span class="si-kpi-label">${escape(kpi.label)}</span>
    <span class="si-kpi-value">${number(kpi.value)}</span>
    <span class="si-kpi-unit">${escape(kpi.unit ?? '')}</span>
  </div>`;

/**
 * One domain's KPIs, as bare tiles over the map.
 *
 * No panel and no heading: each tile names what it counts, so a title above them only repeated the
 * tab already selected. Empty when nothing in the row can be calculated — true of the Outcomes row,
 * whose own panel says so in full.
 */
export const kpiRow = (kpis, { title } = {}) => {
  const available = kpis.filter(kpi => kpi.status === KPI_STATUS.AVAILABLE);
  if (!available.length) return '';
  return `<div class="si-kpi-strip" role="group" aria-label="${escape(title ?? 'Key figures')}">
    ${available.map(kpiTile).join('')}</div>`;
};

/* ============================================================================================
   Charts — plain inline SVG, because a bar whose height is its value needs no library
   ============================================================================================ */

/**
 * A bar series.
 *
 * Labels only where they fit (every nth tick), the maximum called out, and the count in the title
 * attribute of each bar so hovering answers "how many" exactly rather than approximately.
 */
export function barChart(rows, { height = 92, label = 'value', tone = '#F4A725', every = 1,
  /** Which end of a long tick label to keep: months read at the tail, weekday names at the head. */
  tick = 'tail' } = {}) {
  const ticked = value => {
    const text = String(value ?? '');
    return text.length <= 5 ? text : tick === 'head' ? text.slice(0, 3) : text.slice(-5);
  };
  if (!rows.length) return '<p class="si-empty">No records in this selection.</p>';
  const max = Math.max(...rows.map(row => row.count), 1);
  const width = Math.max(rows.length * 14, 120);
  const barWidth = width / rows.length;
  return `<svg class="si-chart" viewBox="0 0 ${width} ${height + 18}" preserveAspectRatio="none"
    role="img" aria-label="${escape(label)}">
    ${rows.map((row, index) => {
      const barHeight = Math.max(1, (row.count / max) * height);
      // `data-tip` rather than a native <title>: an SVG title shows once, needs the pointer to
      // leave the element before it will show again, and is destroyed whenever the panel re-renders
      // — which is every time anything is selected. The hover layer reads this instead.
      return `<rect x="${(index * barWidth + 1).toFixed(1)}" y="${(height - barHeight).toFixed(1)}"
        width="${Math.max(1, barWidth - 2).toFixed(1)}" height="${barHeight.toFixed(1)}" rx="1.5"
        fill="${tone}" opacity="${row.count ? 0.9 : 0.25}"
        data-tip="${escape(row.label)}: ${row.count} record${row.count === 1 ? '' : 's'}"></rect>`;
    }).join('')}
    ${rows.map((row, index) => (index % every === 0
      ? `<text class="si-chart-tick" x="${(index * barWidth + barWidth / 2).toFixed(1)}"
          y="${height + 13}" text-anchor="middle">${escape(ticked(row.label))}</text>`
      : '')).join('')}
  </svg>
  <p class="si-chart-note">Highest: ${max} records. ${escape(label)}.</p>`;
}

/** A proportion list: label, count, and a bar whose width is the share of the largest row. */
export function shareList(rows, { tone = '#F4A725', total = null, lift = false } = {}) {
  if (!rows.length) return '<p class="si-empty">No records in this selection.</p>';
  const max = Math.max(...rows.map(row => row.count), 1);
  return `<ul class="si-shares">${rows.map(row => `
    <li>
      <span class="si-share-label">${escape(row.label)}</span>
      <span class="si-share-bar"><i style="width:${((row.count / max) * 100).toFixed(1)}%;background:${tone}"></i></span>
      <span class="si-share-count">${row.count}${total ? ` <small>of ${total}</small>` : ''}</span>
      ${lift && row.lift != null
        ? `<span class="si-share-lift" title="Share of this selection against this value’s share of the whole register. An association in these records, never a cause.">${row.lift > 0 ? '+' : ''}${(row.lift * 100).toFixed(0)}%</span>`
        : ''}
    </li>`).join('')}</ul>`;
}

/* ============================================================================================
   Region 2 — the analysis column
   ============================================================================================ */

export const provenanceBlock = provenance => `
  <div class="si-provenance">
    <p><strong>${provenance.records}</strong> records, ${escape(provenance.firstMonth ?? '—')} to
      ${escape(provenance.lastMonth ?? '—')} (${provenance.months} months), from
      ${escape(provenance.source)}.</p>
    <p>${escape(provenance.locationBasis)}</p>
    <p>${provenance.confirmed} of ${provenance.records} carry a police report number.
      ${escape(provenance.confirmationBasis)}</p>
    <p class="si-warn">${escape(provenance.statisticalStanding)}</p>
  </div>`;

export function accidentPanel({ provenance, trend, hourly, weekday, severity, types, conditions, hotspots }) {
  return `
  ${provenanceBlock(provenance)}
  <div class="si-row si-row-3">
    <section><h4>Records by month</h4>
      ${barChart(trend, { label: 'Records per month', every: 3, tone: '#F4A725' })}</section>
    <section><h4>Records by hour of day</h4>
      ${barChart(hourly, { label: 'Records per hour (register’s own incident_time)', every: 3, tone: '#38BDF8' })}</section>
    <section><h4>Records by day of week</h4>
      ${barChart(weekday, { label: 'Records per weekday', tone: '#A78BFA', tick: 'head' })}</section>
  </div>
  <h4>How badly they went</h4>
  <ul class="si-facts">
    <li><strong>${severity.fatal}</strong> record${severity.fatal === 1 ? '' : 's'} with a fatality recorded</li>
    <li><strong>${severity.injury}</strong> with injuries recorded</li>
    <li><strong>${severity.propertyDamage}</strong> with neither recorded</li>
  </ul>
  <p class="si-note">The register’s own <code>injuries_y_n</code> and <code>fatalities</code> fields.
    Severity index ${severity.index ?? '—'} is a local weighting of these records (fatal 3, injury 2,
    otherwise 1), not a published index.</p>
  <div class="si-row si-row-2">
    <section><h4>Incident type</h4>
      ${shareList(types, { tone: '#F4A725', total: provenance.records })}</section>
    <section><h4>Weather written on the record</h4>
      ${shareList(conditions.weather, { tone: '#38BDF8', lift: true })}</section>
  </div>
  <div class="si-row si-row-2">
    <section><h4>Traffic conditions written on the record</h4>
      ${shareList(conditions.traffic, { tone: '#38BDF8', lift: true })}</section>
    <section><h4>Assigned root-cause category</h4>
      ${shareList(conditions.rootCauseCategory, { tone: '#A78BFA', lift: true })}</section>
  </div>
  <p class="si-warn">${escape(conditions.caveat)}</p>
  <h4>Where records concentrate</h4>
  ${hotspotList(hotspots)}`;
}

export function hotspotList(hotspots) {
  if (!hotspots?.clusters?.length) {
    return `<p class="si-empty">No concentration of ${hotspots?.minimumRecords ?? 3} or more records
      within ${hotspots?.radiusMeters ?? 250} m was found.</p>`;
  }
  return `
    <p class="si-note">Records within ${hotspots.radiusMeters} m of each other, ${hotspots.minimumRecords}
      or more to a group. ${hotspots.clustered} of ${hotspots.located} located records fell into one.</p>
    <ul class="si-list">${hotspots.clusters.map(cluster => `
      <li><button type="button" data-hotspot="${escape(cluster.id)}">
        <span class="si-list-title">${escape(cluster.label ?? 'Concentration')}</span>
        <span class="si-list-meta">${cluster.records} records ·
          ${cluster.facts.filter(fact => fact.severity.rank >= 2).length} with injury or worse ·
          ${Math.round(cluster.spreadMeters ?? 0)} m across</span>
      </button></li>`).join('')}</ul>
    <p class="si-warn">${escape(hotspots.caveat)}</p>`;
}

export function secondaryPanel({ observed, coOccurring, modelled }) {
  return `
  <h4>Recorded as secondary</h4>
  <p class="si-lede"><strong>${observed.count}</strong> of ${observed.corpus} records carry a
    secondary-collision category.</p>
  <ul class="si-facts">
    <li>A lane was closed on ${observed.laneClosureShare ?? '—'}% of them, against
      ${observed.laneClosureShareOthers ?? '—'}% of the other records</li>
    <li>${observed.severeShare ?? '—'}% recorded an injury or fatality, against
      ${observed.severeShareOthers ?? '—'}% of the others</li>
  </ul>
  <p class="si-note">${escape(observed.basis)}</p>
  <p class="si-warn">${escape(observed.caveat)}</p>
  ${observed.byType.length ? `<h4>What the secondary records were</h4>
    ${shareList(observed.byType, { tone: '#A78BFA' })}` : ''}
  <h4>Records close together in space and time</h4>
  <p class="si-lede"><strong>${coOccurring.count}</strong> pair${coOccurring.count === 1 ? '' : 's'}
    within ${coOccurring.window.withinMeters} m and ${coOccurring.window.withinMinutes} minutes;
    ${coOccurring.labelledSecondary} of them have the later record labelled secondary.</p>
  <p class="si-warn">${escape(coOccurring.caveat)}</p>
  ${modelled ? `
    <h4>Modelled risk — live incidents, not a count of past ones</h4>
    ${modelled.count
      ? `<p class="si-lede"><strong>${modelled.elevated}</strong> of ${modelled.count} incidents live on
          the corridor now score at high risk or above.</p>
        ${modelled.byLevel.length ? shareList(modelled.byLevel.map(row =>
          ({ label: row.level, count: row.count })), { tone: '#A78BFA' }) : ''}`
      : '<p class="si-empty">The TMC has no live incident to score at the moment, so the model '
        + 'reports nothing. That is an absence of live incidents, not a risk of zero.</p>'}
    <p class="si-note">${escape(modelled.basis)}</p>
    <p class="si-warn">${escape(modelled.caveat)}</p>` : ''}`;
}

export function assetPanel({ summary, defects, nearHotspots, targetNote, targetConflicts = [] }) {
  return `
  <p class="si-lede"><strong>${summary.openDefects}</strong> open work order${summary.openDefects === 1 ? '' : 's'}
    on safety-relevant assets, of ${summary.workOrders} read in this range.</p>
  <p class="si-note">${escape(targetNote)}
    ${summary.withTarget} of ${summary.workOrders} work orders are on an asset category that publishes
    a repair-time target; the rest are reported by age alone.</p>
  ${targetConflicts.length ? `<p class="si-warn">The published targets disagree with themselves for
    ${targetConflicts.map(conflict => `${escape(conflict.category)} (${conflict.published.join(' and ')} days)`)
      .join(', ')}. Those categories are treated as having no target rather than one of the two being
    chosen.</p>` : ''}
  <h4>Open the longest</h4>
  ${defects.length ? `<ul class="si-list">${defects.slice(0, 12).map(defect => `
    <li><button type="button" data-defect="${escape(defect.id)}">
      <span class="si-list-title">${escape(defect.assetType ?? 'Asset')} ${escape(defect.assetId ?? '')}</span>
      <span class="si-list-meta">${defect.ageDays ?? '—'} days open${defect.targetDays != null
        ? ` · ${defect.targetDays}-day target${defect.overdue ? ' · past target' : ''}`
        : ' · no target published'}${defect.priority ? ` · priority ${escape(defect.priority)}` : ''}</span>
    </button></li>`).join('')}</ul>` : '<p class="si-empty">No open work orders on safety-relevant assets.</p>'}
  <h4>Open defects inside a records concentration</h4>
  ${nearHotspots.length ? `<ul class="si-list">${nearHotspots.map(group => `
    <li><button type="button" data-hotspot="${escape(group.hotspotId)}">
      <span class="si-list-title">${escape(group.hotspot.label ?? 'Concentration')}</span>
      <span class="si-list-meta">${group.defects.length} open defect${group.defects.length === 1 ? '' : 's'}${group.overdue ? `, ${group.overdue} past target` : ''}</span>
    </button></li>`).join('')}</ul>
    <p class="si-warn">${escape(nearHotspots[0].caveat)}</p>`
    : '<p class="si-empty">No open safety-relevant defect sits inside a records concentration.</p>'}`;
}

export function patrolPanel({ hazards, hints, gaps }) {
  return `
  <p class="si-lede"><strong>${hazards.hazards}</strong> hazard finding${hazards.hazards === 1 ? '' : 's'}
    across ${hazards.inspectionsWithHazards} of ${hazards.inspections} inspection records, at
    ${hazards.locations} location${hazards.locations === 1 ? '' : 's'}.</p>
  <p class="si-note">${escape(hazards.basis)}</p>
  <p class="si-warn">${escape(hazards.caveat)}</p>
  ${hazards.byHazard.length ? `<h4>What was found</h4>${shareList(hazards.byHazard, { tone: '#14B8A6' })}` : ''}
  <h4>Where to look, and why</h4>
  ${hints.hints.length ? `<ul class="si-list">${hints.hints.map(hint => `
    <li><button type="button" data-hint="${escape(hint.id)}">
      <span class="si-list-title">${escape(hint.place)}</span>
      <span class="si-list-meta">${escape(hint.statement)} ${escape(hint.evidence)}</span>
    </button></li>`).join('')}</ul>
    <p class="si-warn">${escape(hints.caveat)}</p>` : '<p class="si-empty">Nothing concentrates yet.</p>'}
  <h4>Roadside hazards and coverage — what this screen cannot tell you</h4>
  <ul class="si-gaps">${gaps.map(gap => `
    <li><strong>${escape(gap.metric)}</strong><span>Needs: ${escape(gap.requires)}</span></li>`).join('')}</ul>`;
}

/* ============================================================================================
   Region 4 — the Safety Priority Queue
   ============================================================================================ */

/** Short forms of the five kinds of attention, for the count line. */
const ACTION_WORDS = Object.freeze({
  IMMEDIATE_RESPONSE: 'to respond to',
  URGENT_INSPECTION: 'to inspect',
  OVERDUE_MAINTENANCE: 'overdue',
  PLANNED_ASSESSMENT: 'to assess',
  DATA_VALIDATION: 'to validate',
});

export function queuePanel(queue, { domain = null, selectedId = null, action = null,
  sectionId = null, sectionOnly = false, sectionLabel = null } = {}) {
  // CROSS is a filter, not a domain: it selects the entries more than one domain points at.
  const byDomain = !domain ? queue.entries
    : domain === 'CROSS' ? queue.entries.filter(entry => entry.agrees)
      : queue.entries.filter(entry => entry.domain.id === domain);
  const byAction = action ? byDomain.filter(entry => entry.actionUrgency?.id === action) : byDomain;
  // The whole corridor by default. Narrowing to the selected stretch is a control the reader can
  // see and undo, never something the selection does to the list behind their back.
  const entries = sectionOnly && sectionId
    ? byAction.filter(entry => entry.sectionId === sectionId) : byAction;
  return `
  <div class="si-queue-head">
    <h3>Safety priority queue</h3>
    <p class="si-note">${queue.total} findings${queue.byAction ? ` · ${
      Object.entries(queue.byAction).filter(([, count]) => count > 0)
        .map(([id, count]) => `${count} ${ACTION_WORDS[id] ?? id.toLowerCase()}`).join(' · ')}` : ''}</p>
    <div class="si-chips" role="group" aria-label="Filter by domain">
      <button type="button" class="si-chip${domain ? '' : ' is-on'}" data-domain="">All</button>
      ${Object.entries(queue.byDomain).filter(([, count]) => count > 0).map(([id, count]) => `
        <button type="button" class="si-chip${domain === id ? ' is-on' : ''}" data-domain="${id}"
          style="--chip:${DOMAIN_TONES[id] ?? '#94A3B8'}">${escape(id.toLowerCase())} ${count}</button>`).join('')}
      ${queue.agreeing ? `<button type="button" class="si-chip${domain === 'CROSS' ? ' is-on' : ''}"
        data-domain="CROSS" style="--chip:${DOMAIN_TONES.CROSS}"
        title="Entries another domain also points at, within 300 m">two domains ${queue.agreeing}</button>` : ''}
    </div>
    <div class="si-chips" role="group" aria-label="Filter by the kind of attention wanted">
      <button type="button" class="si-chip${action ? '' : ' is-on'}" data-action="">Any action</button>
      ${Object.entries(queue.byAction ?? {}).filter(([, count]) => count > 0).map(([id, count]) => `
        <button type="button" class="si-chip${action === id ? ' is-on' : ''}" data-action="${id}">
          ${escape(ACTION_WORDS[id] ?? id.toLowerCase())} ${count}</button>`).join('')}
    </div>
    ${sectionId ? `<div class="si-chips">
      <button type="button" class="si-chip${sectionOnly ? ' is-on' : ''}" data-section-only="${sectionOnly ? '' : '1'}">
        Only ${escape(sectionLabel ?? sectionId)} (${queue.bySection?.[sectionId] ?? 0})</button>
    </div>` : ''}
  </div>
  <ul class="si-queue">${entries.map(entry => `
    <li>
      <button type="button" class="si-queue-item${entry.id === selectedId ? ' is-on' : ''}"
        data-entry="${escape(entry.id)}" style="--tone:${DOMAIN_TONES[entry.domain.id] ?? '#94A3B8'}">
        <span class="si-queue-band si-band-${escape(entry.urgency.id)}">${escape(entry.actionUrgency?.label
          ?? entry.urgency.label)}</span>
        <span class="si-queue-title">${escape(entry.title)}</span>
        <span class="si-queue-meta">${escape(entry.domain.label)} ·
          ${number(entry.quantity)} ${escape(entry.quantityLabel)}${entry.owner
            ? ` · ${escape(entry.owner)}` : ''}${entry.confidence
            ? ` · ${escape(entry.confidence.label.toLowerCase())}` : ''}</span>
        <span class="si-queue-rule">${escape(entry.rule)}</span>
        ${entry.agrees ? `<span class="si-queue-agree">Nearby: ${entry.alsoFlaggedBy
          .map(other => `${other.findings} from ${escape(other.domain.toLowerCase())}`).join(', ')}</span>` : ''}
      </button>
    </li>`).join('')}</ul>
  ${entries.length ? '' : '<p class="si-empty">Nothing in this domain.</p>'}
  <details class="si-method"><summary>How this list is ordered</summary>
    <p>${escape(queue.methodology.summary)}</p>
    <p class="si-warn">${escape(queue.methodology.noCompositeScore)}</p>
    <p class="si-note">${escape(queue.methodology.crossDomain)}</p>
    <p class="si-note">${escape(queue.methodology.positions)}</p>
  </details>`;
}

/*
 * The queue's detail pane is gone.
 *
 * It sat under the priority list and, in practice, only ever said "Choose an entry to see what it
 * rests on" — because choosing an entry switches the panel to the investigation, which answers the
 * same questions in more depth. A permanent empty box costing half the column's height.
 */

/* ============================================================================================
   Region 5 — replay and coverage
   ============================================================================================ */

/**
 * The replay controls.
 *
 * Controls only. What the dwell window means is a statement about the data rather than a reading of
 * it, so it lives in the coverage disclosure beside the other such statements.
 */
export function replayBar(timeline, frame, { playing = false } = {}) {
  if (timeline.empty) return '<p class="si-empty">No records to replay.</p>';
  return `
  <div class="si-replay">
    <button class="si-play" type="button" data-replay="${playing ? 'pause' : 'play'}"
      aria-label="${playing ? 'Pause replay' : 'Play replay'}">${playing ? '❙❙' : '▶'}</button>
    <input class="si-scrub" type="range" min="0" max="${timeline.steps}" value="${frame.step}"
      aria-label="Replay position" />
    <span class="si-replay-read">
      <strong>${escape(frame.label)}</strong>
      ${frame.activeCount} record${frame.activeCount === 1 ? '' : 's'} in the week to this point ·
      ${frame.cumulativeCount} to date
    </span>
    <label class="si-speed">Step
      <select aria-label="Replay step">
        ${['day', 'week', 'month'].map(id => `<option value="${id}"${id === timeline.speedId ? ' selected' : ''}>
          ${id === 'day' ? 'a day' : id === 'week' ? 'a week' : 'a month'}</option>`).join('')}
      </select>
    </label>
    <button class="si-action si-action-quiet" type="button" data-replay="reset">Reset</button>
  </div>`;
}

/**
 * What the screen is reading, and what it cannot read.
 *
 * This is where the uncalculable KPIs live now that the header carries only real numbers, and where
 * the replay's dwell window is explained now that the footer carries only controls. Both are
 * statements about the data rather than readings of it, which is what this disclosure is for.
 *
 * @param {object} coverage from dataCoverage()
 * @param {{unavailable?: {label: string, requires: string}[], notes?: string[]}} [extra]
 */
export function coveragePanel(coverage, { unavailable = [], notes = [] } = {}) {
  return `
  <h4>What this screen is reading</h4>
  <ul class="si-coverage">${coverage.rows.map(row => `
    <li class="${row.available ? '' : 'is-out'}">
      <span>${escape(row.label)}</span>
      <strong>${row.available ? `${row.records} records` : 'not available'}</strong>
      ${row.note ? `<em>${escape(row.note)}</em>` : ''}
    </li>`).join('')}</ul>
  <p class="si-note">${coverage.availableSets} of ${coverage.totalSets} sources are available.</p>
  ${unavailable.length ? `<h4>What cannot be calculated from them</h4>
    <ul class="si-gaps">${unavailable.map(kpi => `
      <li><strong>${escape(kpi.label)}</strong><span>Needs: ${escape(kpi.requires)}</span></li>`).join('')}</ul>`
    : ''}
  ${notes.map(note => `<p class="si-note">${escape(note)}</p>`).join('')}`;
}

/**
 * Performance & Outcomes.
 *
 * This panel is mostly a refusal, and deliberately so. Measuring an outcome needs a record of an
 * intervention and an after-period; the twin has neither, so the honest version of this region is
 * what the register CAN compare (counts in two equal windows) plus a list of what an outcomes
 * programme would have to start recording.
 */
export function outcomesPanel({ comparison, requirements }) {
  return `
  <h4>Two equal windows, compared</h4>
  ${comparison ? `
    <ul class="si-facts">
      <li>${comparison.earlier.records} records in the earlier ${comparison.spanDays} days
        (${comparison.earlier.severe} with injury or worse)</li>
      <li>${comparison.later.records} in the later ${comparison.spanDays} days
        (${comparison.later.severe} with injury or worse)</li>
      <li>Difference: ${comparison.difference > 0 ? '+' : ''}${comparison.difference} records</li>
    </ul>
    <p class="si-warn">${escape(comparison.caveat)}</p>`
    : '<p class="si-empty">Not enough range to compare two windows.</p>'}
  <h4>What an outcome measurement would need</h4>
  <ul class="si-gaps">${requirements.map(item => `
    <li><strong>${escape(item.metric)}</strong><span>Needs: ${escape(item.requires)}</span></li>`).join('')}</ul>`;
}

/** Stated once, on the screen, so no reader has to infer it. */
export const OUTCOME_REQUIREMENTS = Object.freeze([
  Object.freeze({ metric: 'Did an intervention reduce incidents?',
    requires: 'A record of each intervention and when it was implemented. Nothing in the twin records one, '
      + 'so there is no before-and-after to measure.' }),
  Object.freeze({ metric: 'Crash reduction, or a benefit-cost ratio',
    requires: 'Exposure data (traffic volume), intervention costs, and a validated crash-modification '
      + 'factor. None of the three is present, and no reduction is claimed anywhere on this screen.' }),
  Object.freeze({ metric: 'Response and clearance performance',
    requires: 'Detection, dispatch, arrival and clearance timestamps per incident.' }),
  Object.freeze({ metric: 'Whether the register is complete over time',
    requires: 'A reporting-completeness statement from the data owner. Without it, a fall in records '
      + 'cannot be distinguished from a fall in reporting.' }),
]);

/* ============================================================================================
   The contextual investigation — the right panel's second mode
   ============================================================================================ */

const RECORD_KIND_LABELS = Object.freeze({
  incident: 'Incident record', workOrder: 'Work order', asset: 'Asset', inspection: 'Inspection',
});

/** A source record, as a row that can be opened. */
const sourceRow = record => `<li><button type="button" class="si-source"
  data-source-kind="${escape(record.kind)}" data-source-id="${escape(record.id)}">
  <span class="si-source-kind">${escape(RECORD_KIND_LABELS[record.kind] ?? record.kind)}</span>
  <span class="si-source-label">${escape(record.label ?? record.id)}</span>
</button></li>`;

/**
 * One recommendation, with everything a reader needs to argue with it.
 *
 * The evidence and the records come with it, not behind a link to somewhere else: a recommendation
 * whose basis is one click away is a recommendation most people will take on trust.
 */
export const recommendationCard = (item, { expanded = false } = {}) => `
  <article class="si-rec" data-rec="${escape(item.id)}">
    <header>
      <span class="si-rec-urgency si-urgency-${escape(item.urgency.id)}">${escape(item.urgency.label)}</span>
      <span class="si-rec-confidence" title="How well the evidence supports this">${escape(item.confidence.label)}</span>
    </header>
    <h5>${escape(item.concern)}</h5>
    <dl>
      <dt>Evidence</dt><dd>${escape(item.evidence)}</dd>
      <dt>Why it matters</dt><dd>${escape(item.whyItMatters)}</dd>
      <dt>Recommended action</dt><dd>${escape(item.action)}</dd>
      <dt>Who should review it</dt><dd>${escape(item.owner)}</dd>
      <dt>How the result could be measured</dt><dd>${escape(item.successMeasure)}</dd>
      ${item.caveat ? `<dt>Read with care</dt><dd class="si-warn">${escape(item.caveat)}</dd>` : ''}
    </dl>
    ${item.sourceRecords.length ? `<details class="si-rec-sources"${expanded ? ' open' : ''}>
      <summary>${item.sourceRecords.length} supporting record${item.sourceRecords.length === 1 ? '' : 's'}</summary>
      <ul class="si-sources">${item.sourceRecords.map(sourceRow).join('')}</ul>
    </details>` : ''}
  </article>`;

/** The record open beside its stretch of corridor — never instead of it. */
export const incidentCard = assessment => {
  if (!assessment) return '';
  const recorded = assessment.recorded;
  return `
  <section class="si-record">
    <h4>Selected record</h4>
    <p class="si-lede">${escape(recorded.type)} · ${escape(recorded.severity.label)} ·
      ${escape(recorded.when.dayKey)} ${String(recorded.when.hour).padStart(2, '0')}:00</p>
    <dl class="si-detail">
      ${recorded.laneClosure ? `<dt>Lane closure</dt><dd>Yes${recorded.laneClosureHours != null
        ? `, ${recorded.laneClosureHours} hours recorded` : ', duration not recorded'}</dd>` : ''}
      ${recorded.weather ? `<dt>Weather on the record</dt><dd>${escape(recorded.weather)}</dd>` : ''}
      ${recorded.trafficConditions ? `<dt>Traffic on the record</dt><dd>${escape(recorded.trafficConditions)}</dd>` : ''}
      ${recorded.rootCauseCategory ? `<dt>Assigned category</dt><dd>${escape(recorded.rootCauseCategory)}
        <span class="si-note">An assigned category, not an investigated cause.</span></dd>` : ''}
      <dt>Police report</dt><dd>${recorded.confirmed ? escape(recorded.policeReport) : 'None on this record'}</dd>
      ${recorded.recommendedNextAction ? `<dt>Next action on the record</dt>
        <dd>${escape(recorded.recommendedNextAction)}</dd>` : ''}
      <dt>Records nearby</dt><dd>${assessment.nearbyRecords} within 300 m${assessment.followedBy.length
        ? `, ${assessment.followedBy.length} within two hours after it` : ''}</dd>
    </dl>
    <p class="si-warn">${escape(assessment.scopeNote)}</p>
    <details class="si-method"><summary>What cannot be assessed for a past record</summary>
      <ul class="si-gaps">${assessment.unavailable.map(gap => `
        <li><strong>${escape(gap.field)}</strong><span>${escape(gap.reason)}</span></li>`).join('')}</ul>
    </details>
  </section>`;
};

/**
 * Mode 2 — the selected location.
 *
 * Context, then what is supported, then the four domains, then what to do, then the records. The
 * order is the investigation's: what is this, what do we know, what does it mean, what next.
 */
export function investigationPanel(investigation) {
  if (!investigation) return '';
  const { context, summary, domains, recommendations, record } = investigation;
  const count = (value, word) => `${value} ${word}${value === 1 ? '' : 's'}`;
  return `
  <div class="si-investigation">
    <header class="si-inv-head">
      <button class="si-action si-action-quiet" type="button" data-mode="priorities">‹ Corridor priorities</button>
      <button class="si-action si-action-quiet" type="button" data-clear-selection>Clear selection</button>
    </header>
    <h3>${escape(context.label)}</h3>
    <p class="si-note">${escape(context.scopeLabel)}${context.sectionWhere
      ? ` · ${escape(context.sectionWhere)}` : ''}${context.carriageway
      ? ` · ${escape(context.carriageway === 'BOTH' ? 'both carriageways' : context.carriageway)}` : ''}</p>
    <p class="si-note">${escape(context.scopeBasis ?? '')}</p>

    <h4>What the records show here</h4>
    <ul class="si-facts">
      <li>${count(summary.records, 'incident record')}, ${summary.severeRecords} with injury or worse${summary.fatalRecords
        ? `, ${summary.fatalRecords} fatal` : ''}</li>
      <li>${summary.confirmedRecords} carry a police report number</li>
      <li>${count(summary.laneClosures, 'record')} closed a lane</li>
      ${summary.secondaryRecords ? `<li>${count(summary.secondaryRecords, 'record')} categorised as a secondary collision</li>` : ''}
      ${summary.openDefects ? `<li>${count(summary.openDefects, 'open work order')} on safety-relevant assets${summary.overdueDefects
        ? `, ${summary.overdueDefects} past the published target` : ''}</li>` : ''}
      ${summary.hazardFindings ? `<li>${count(summary.hazardFindings, 'hazard finding')} from inspections</li>` : ''}
      ${summary.perHundredMillionVmt != null
        ? `<li><strong>${summary.perHundredMillionVmt}</strong> recorded incidents per 100 million vehicle-miles
            ${summary.severePerHundredMillionVmt != null
              ? `(${summary.severePerHundredMillionVmt} with injury or worse)` : ''}</li>`
        : ''}
    </ul>
    ${summary.perHundredMillionVmt != null ? `<p class="si-warn">A recorded-incident rate from an
      operational register against published AADT — not an FDOT crash rate, and not comparable with one.</p>` : ''}
    <p class="si-note">${escape(context.locationConfidence)}</p>

    ${record ? incidentCard(record) : ''}

    <h4>Related safety concerns</h4>
    ${domainBlock('Accident patterns', domains.accidents.byType, domains.accidents.records.length, 'incident')}
    ${domains.secondary.labelled.length ? `
      <section class="si-domain">
        <h5>Secondary-incident exposure</h5>
        <p>${count(domains.secondary.labelled.length, 'record')} carry a secondary-collision category.</p>
        <p class="si-warn">${escape(domains.secondary.verifiedPairsNote)}</p>
      </section>` : ''}
    ${domains.hazards.places.length ? `
      <section class="si-domain">
        <h5>Roadside hazards</h5>
        <ul class="si-list">${domains.hazards.places.slice(0, 5).map(place => `
          <li><button type="button" data-hazard="${escape(place.key)}">
            <span class="si-list-title">${escape(place.label)}</span>
            <span class="si-list-meta">${count(place.hazards, 'finding')} across
              ${count(place.observations.length, 'inspection')}</span>
          </button></li>`).join('')}</ul>
      </section>` : ''}
    ${domains.assets.defects.length ? `
      <section class="si-domain">
        <h5>Asset condition</h5>
        <ul class="si-list">${domains.assets.defects.slice(0, 6).map(defect => `
          <li><button type="button" data-asset="${escape(defect.assetId ?? defect.id)}">
            <span class="si-list-title">${escape(defect.assetType ?? 'Asset')} ${escape(defect.assetId ?? '')}</span>
            <span class="si-list-meta">${defect.open ? 'open' : 'closed'} ·
              ${defect.ageDays ?? '—'} days${defect.targetDays != null
                ? ` · ${defect.targetDays}-day target${defect.overdue ? ' · past target' : ''}`
                : ' · no target published'}</span>
          </button></li>`).join('')}</ul>
      </section>` : ''}

    <h4>What to investigate next</h4>
    ${recommendations.length
      ? recommendations.map(item => recommendationCard(item)).join('')
      : '<p class="si-empty">Nothing here meets the evidence threshold for a recommendation.</p>'}
    ${recommendations.length ? '<p class="si-note">Candidate actions for review, each tied to the '
      + 'records above. No reduction in incidents is predicted for any of them.</p>' : ''}

    <h4>The records behind this</h4>
    <ul class="si-list si-list-plain">${domains.accidents.records.slice(0, 12).map(fact => `
      <li><button type="button" data-incident="${escape(fact.id)}">
        <span class="si-list-title">${escape(fact.type)} · ${escape(fact.severity.label)}</span>
        <span class="si-list-meta">${escape(fact.when.dayKey)} ·
          ${fact.confirmed ? 'police report on file' : 'no police report number'}</span>
      </button></li>`).join('')}</ul>
  </div>`;
}

const domainBlock = (title, rows, total, noun) => (rows.length ? `
  <section class="si-domain">
    <h5>${escape(title)}</h5>
    <p>${total} ${escape(noun)} record${total === 1 ? '' : 's'}, most often
      ${escape(rows[0].label.toLowerCase())} (${rows[0].count}).</p>
    ${shareList(rows.slice(0, 6), { tone: '#F4A725' })}
  </section>` : '');

/* ============================================================================================
   Segment comparison — where exposure makes counts comparable
   ============================================================================================ */

/**
 * The corridor's sections, ranked.
 *
 * This is the panel that justifies where attention goes: a count alone ranks the busiest stretch
 * first every time, and against exposure a short or quiet section with the same count moves up to
 * where it belongs.
 */
export function sectionComparison(sections, { selectedId = null } = {}) {
  if (!sections?.rows?.length) return '<p class="si-empty">No corridor sections are available.</p>';
  const max = Math.max(...sections.rows.map(row => row.perHundredMillionVmt ?? 0), 1);
  return `
  <p class="si-note">Eight FDOT milepost ranges, each with its own published AADT. A record is
    assigned to the range whose centreline it is nearest, within 400 m.</p>
  <ul class="si-sections">${sections.rows.map(row => `
    <li><button type="button" class="si-section-row${row.id === selectedId ? ' is-on' : ''}"
      data-section="${escape(row.id)}">
      <span class="si-section-label">${escape(row.section.label)}</span>
      <span class="si-section-bar"><i style="width:${(((row.perHundredMillionVmt ?? 0) / max) * 100).toFixed(1)}%"></i></span>
      <span class="si-section-rate">${row.perHundredMillionVmt ?? '—'}</span>
      <span class="si-section-meta">${row.records} records${row.severeRecords
        ? ` · ${row.severeRecords} injury+` : ''}${row.openDefects ? ` · ${row.openDefects} open defects` : ''}</span>
    </button></li>`).join('')}</ul>
  <p class="si-chart-note">Recorded incidents per 100 million vehicle-miles. Corridor overall:
    ${sections.corridorPerHundredMillionVmt ?? '—'}.</p>
  <p class="si-warn">${escape(sections.assumptions.countNote)} ${escape(sections.assumptions.aadtNote)}
    ${escape(sections.assumptions.periodNote)} ${escape(sections.assumptions.directionNote)}</p>
  ${sections.unassigned.facts.length ? `<p class="si-note">${sections.unassigned.facts.length} records
    sit more than 400 m from any mainline section — a ramp, a frontage road or an asset set back from
    the road — and are left out of these rates rather than pulled onto the nearest one.</p>` : ''}`;
}
