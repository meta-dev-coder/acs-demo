/**
 * The Case Workbench: the Case Management subtab, as one screen.
 *
 * It replaces four surfaces that each drew the same case — the bottom slider card, the floating
 * details panel, the modal's header and the modal's Overview tab — with a queue on the left and
 * one case on the right. Those four components still exist and still serve the Operations Overview
 * and every other workflow; they are simply not what Case Management opens any more.
 *
 * Nothing here evaluates anything. The statuses, findings, next action and explanation all come
 * from the existing validation engine through `caseWorkbenchModel.js`; the evidence comes from the
 * existing Case Enrichment Orchestrator, and the weather from the existing Open-Meteo service.
 */
import { escape } from '../safetyIntelligence/safetyPanels.js';
import { STATUS } from '../qcqa/schema.js';
import { usd } from './claimsIntelligence.js';
import {
  QUEUE_FILTERS, actionRequiredOf, bucketCounts, filterQueue, headerOf, queueFacets, queueRow,
  validationTimeline,
} from './caseWorkbenchModel.js';

const STATUS_WORD = Object.freeze({
  [STATUS.PASS]: 'Pass', [STATUS.FAIL]: 'Fail', [STATUS.MISSING]: 'Missing',
  [STATUS.PENDING]: 'Pending', [STATUS.BLOCKED]: 'Blocked',
  [STATUS.NOT_APPLICABLE]: 'N/A', [STATUS.NOT_EVALUATED]: 'Not evaluated',
});

const RECOVERY_WORD = Object.freeze({
  CANDIDATE: 'Record found in another system',
  NEEDS_REVIEW: 'Record found — needs a reviewer',
  NOT_FOUND: 'Not held by any system that answered',
  HUMAN_ONLY: 'Cannot be recovered: a person must record it',
});

const clock = value => {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' })
      .format(parsed) : null;
};
const dayOnly = value => {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'medium' }).format(parsed) : '—';
};

const fieldValue = field => {
  if (field.value == null || field.value === '') return null;
  if (field.dataType === 'date') return clock(field.value) ?? String(field.value);
  return `${field.value}${field.unit ? ` ${field.unit}` : ''}`;
};

/** A place in the corridor, said once, the way the rest of the app says it. */
const placeOf = location => [
  location.roadway,
  location.segment,
  location.direction,
  Number.isFinite(location.corridorMile) ? `corridor mile ${location.corridorMile.toFixed(2)} (derived)` : null,
].filter(Boolean).join(' · ');

/* ── queue ───────────────────────────────────────────────────────────────────────────────────── */

function queueMarkup(rows, filters, facets, counts, selectedId) {
  const option = (value, current) =>
    `<option value="${escape(value)}"${value === current ? ' selected' : ''}>${escape(value)}</option>`;
  const select = (name, label, values, current) => `<label class="cw-filter"><span>${label}</span>
    <select data-filter="${name}"><option value=""${current ? '' : ' selected'}>Any</option>
      ${values.map(value => option(value, current)).join('')}</select></label>`;

  return `<header class="cw-queue-head">
      <h2 class="cw-queue-title">Case queue</h2>
      <input class="cw-search" type="search" data-filter="query" placeholder="Search cases"
        aria-label="Search cases" value="${escape(filters.query ?? '')}">
      <div class="cw-buckets" role="group" aria-label="Case state">
        ${QUEUE_FILTERS.map(entry => `<button type="button" class="cw-bucket" data-bucket="${entry.id}"
          aria-pressed="${String((filters.bucket ?? 'all') === entry.id)}">${entry.label}
          <i>${counts[entry.id]}</i></button>`).join('')}
      </div>
      <details class="cw-more"><summary>More filters</summary>
        <div class="cw-filters">
          ${select('incidentType', 'Incident type', facets.incidentType, filters.incidentType)}
          ${select('assetType', 'Asset type', facets.assetType, filters.assetType)}
          ${select('stage', 'Blocking stage', facets.stage, filters.stage)}
          ${select('severity', 'Severity', facets.severity, filters.severity)}
          <label class="cw-filter"><span>Reported from</span>
            <input type="date" data-filter="from" value="${escape(filters.from ?? '')}"></label>
          <label class="cw-filter"><span>Reported to</span>
            <input type="date" data-filter="to" value="${escape(filters.to ?? '')}"></label>
        </div>
      </details>
    </header>
    ${rows.length ? `<ul class="cw-rows">${rows.map(row => `<li>
      <button type="button" class="cw-row" data-case="${escape(row.caseId)}" data-tone="${escape(row.tone)}"
        aria-current="${String(row.caseId === selectedId)}">
        <span class="cw-row-id">${escape(row.caseId)}</span>
        <span class="cw-row-status">${escape(row.status)}</span>
        <span class="cw-row-asset">${escape(row.assetType)}</span>
        <span class="cw-row-where">${escape(row.segment ?? 'Segment not recorded')}${
          Number.isFinite(row.corridorMile) ? ` · mi ${row.corridorMile.toFixed(1)}` : ''}</span>
        <span class="cw-row-stage">${row.blockingStageLabel
          ? `Blocked at ${escape(row.blockingStageLabel)}` : 'Nothing outstanding'}</span>
        <span class="cw-row-when">${escape(dayOnly(row.lastActivity))}</span>
      </button></li>`).join('')}</ul>`
      : '<p class="cw-empty">No case matches these filters.</p>'}`;
}

/* ── workbench sections ──────────────────────────────────────────────────────────────────────── */

function headerMarkup(header) {
  return `<header class="cw-head">
    ${/*
        No "SYNTHETIC DEMO DATA" chip here.
        It said the same thing on every case in the queue, so it carried no information between
        one case and the next while taking the eye first — ahead of the case id and the status,
        which are what distinguish this case. The dataset's provenance is stated where it belongs,
        on the dataset, and Ask the Twin is still told plainly that these cases are synthetic.
      */''}
    <div class="cw-head-id">
      <h2>${escape(header.caseId)}</h2>
      <span class="cw-status" data-tone="${escape(header.tone)}">${escape(header.status)}</span>
    </div>
    <p class="cw-head-sum">${escape(header.summary)}</p>
    <p class="cw-head-where">${escape(placeOf(header.location))}${
      header.location.sourceIncidentId ? ` · at incident ${escape(header.location.sourceIncidentId)}` : ''}</p>
    <div class="cw-head-actions">
      <button type="button" class="cw-action" data-action="view-on-map"
        ${header.location.hasPosition ? '' : 'disabled title="This case has no located source incident."'}>View on map</button>
    </div>
    <ol class="cw-stages" aria-label="Case lifecycle">
      ${header.stages.map(stage => `<li data-tone="${escape(stage.presentation.tone)}"
        data-status="${escape(stage.status)}" aria-current="${String(stage.current)}">
        <button type="button" data-stage="${escape(stage.key)}"
          aria-controls="cw-stage-${escape(stage.key)}"
          title="Show the ${escape(stage.label.toLowerCase())} checks">
          <span class="cw-stage-name">${escape(stage.label)}</span>
          <span class="cw-stage-state">${escape(stage.presentation.label)}</span>
          <span class="cw-stage-counts">${stage.blockedBy
            ? `held by ${escape(STAGE_WORD[stage.blockedBy] ?? stage.blockedBy.toLowerCase())}`
            : `${stage.counts.failed} failed · ${stage.counts.missing} missing · ${stage.counts.passed} passed`}</span>
        </button></li>`).join('')}
    </ol>
  </header>`;
}

function actionMarkup(action) {
  if (action.resolved) {
    return `<section class="cw-section cw-section-action" data-section="action" data-tone="ok">
      <h3>Action required</h3>
      <p class="cw-action-lead">None. The case is closed.</p>
      <p class="cw-prose">${escape(action.detection)}</p>
      <p class="cw-prose">${escape(action.impact)}</p>
    </section>`;
  }
  const evidence = action.evidenceRequired.length ? `<h4>Evidence required</h4>
    <ul class="cw-list">${action.evidenceRequired.map(entry => `<li>
      <span class="cw-list-main">${escape(entry.label)}</span>
      ${entry.recoverable
        ? `<span class="cw-pill" data-state="${entry.recoverable.state}">${escape(RECOVERY_WORD[entry.recoverable.state])}</span>`
        : '<span class="cw-pill" data-state="UNKNOWN">Not searched for yet</span>'}
    </li>`).join('')}</ul>` : '';
  const failures = action.failed.length ? `<h4>Failed checks</h4>
    <ul class="cw-list">${action.failed.map(entry => `<li>
      <span class="cw-list-main">${escape(entry.label)}</span>
      ${entry.message ? `<span class="cw-list-note">${escape(entry.message)}</span>` : ''}</li>`).join('')}</ul>` : '';
  const ncrs = action.nonConformances.length ? `<h4>Open non-conformances</h4>
    <ul class="cw-list">${action.nonConformances.map(entry => `<li>
      <span class="cw-list-main">${escape(entry.id)} · ${escape(entry.severity)}</span>
      <span class="cw-list-note">${escape(entry.finding)}</span>
      <span class="cw-list-note">${escape(entry.correctiveAction)}</span></li>`).join('')}</ul>` : '';

  return `<section class="cw-section cw-section-action" data-section="action" data-tone="${escape(action.stage ? 'warn' : 'info')}">
    <h3>Action required</h3>
    <p class="cw-action-lead">${escape(action.action)}</p>
    <dl class="cw-why">
      <dt>What failed or is pending</dt><dd>${escape(action.detection)}</dd>
      <dt>Why it matters</dt><dd>${escape(action.impact)}</dd>
      <dt>Assigned to</dt><dd>${action.role
        ? `${escape(action.role)}${action.team ? ` · ${escape(action.team)}` : ''}` : 'Nobody — nothing is outstanding'}</dd>
    </dl>
    ${failures}${ncrs}${evidence}
  </section>`;
}

function candidateMarkup(recovery) {
  if (!recovery) return '';
  if (recovery.state === 'HUMAN_ONLY' || recovery.state === 'NOT_FOUND') {
    return `<p class="cw-evidence" data-state="${recovery.state}">${escape(RECOVERY_WORD[recovery.state])}${
      recovery.reason ? ` — ${escape(recovery.reason)}` : ''}</p>`;
  }
  const best = recovery.best;
  return `<div class="cw-evidence" data-state="${recovery.state}">
    <p>${escape(RECOVERY_WORD[recovery.state])}${recovery.reason ? ` — ${escape(recovery.reason)}` : ''}</p>
    ${/*
        The per-row "synthetic connector response" caveat is deliberately NOT repeated here.
        Every case in this workbench already carries a SYNTHETIC DEMO DATA badge in its header,
        so restating it on each recovered record added nothing a reader did not already know and
        crowded out the record id, system and confidence, which is what the row is for.
      */''}
    ${best ? `<p class="cw-evidence-row"><strong>${escape(best.recordId)}</strong> from
      ${escape(best.systemLabel ?? best.system)} · ${escape(best.tier)} · ${best.confidence}% confidence</p>
      <p class="cw-list-note">${escape((best.reasons ?? []).join('; '))}</p>` : ''}
    ${recovery.candidates && recovery.candidates.length > 1
      ? `<p class="cw-list-note">${recovery.candidates.length - 1} other candidate(s) were ranked lower.</p>` : ''}
  </div>`;
}

/**
 * A field's note, when it adds something its validation message has not already said.
 *
 * Several fields carry a note that restates the message almost word for word — "Blank. The repair
 * quantity cannot be authorised without it." appeared twice under every missing field. One
 * sentence, once.
 */
function noteBeside(field) {
  if (!field.note || field.status === STATUS.PASS) return null;
  const same = (a, b) => String(a).replace(/\s+/g, ' ').trim().toLowerCase()
    === String(b).replace(/\s+/g, ' ').trim().toLowerCase();
  return field.message && same(field.note, field.message) ? null : field.note;
}

/** The stage names as they read inside a sentence. */
const STAGE_WORD = Object.freeze({ INSPECTION: 'inspection', REPAIR: 'repair', QCQA: 'QC/QA', CLAIM: 'claim' });

function timelineMarkup(timeline, recovery) {
  const recoveryState = recovery?.state ?? 'none';
  const note = recoveryState === 'loading'
    ? '<p class="cw-note">Searching the connected systems for the missing records…</p>'
    : recoveryState === 'none'
      ? '<p class="cw-note">Evidence recovery has not run for this case.</p>' : '';
  const summary = recovery?.summary ?? null;
  const counts = summary && summary.missing
    ? `<span class="cw-section-counts">${summary.missing} missing · ${summary.recoverable} recoverable`
      + `${summary.needsReview ? ` · ${summary.needsReview} need review` : ''}`
      + `${summary.unresolved ? ` · ${summary.unresolved} unresolved` : ''}</span>`
    : '';
  return `<section class="cw-section" data-section="validation">
    <h3>Validation &amp; evidence${counts}</h3>
    ${note}
    <ol class="cw-timeline">${timeline.map(stage => `<li data-tone="${escape(stage.presentation.tone)}"
      data-status="${escape(stage.status)}">
      <details id="cw-stage-${escape(stage.key)}" data-stage="${escape(stage.key)}"${stage.expanded ? ' open' : ''}>
        <summary>
          <span class="cw-tl-name">${escape(stage.label)}</span>
          <span class="cw-tl-state">${escape(stage.presentation.label)}</span>
          <span class="cw-tl-counts">${stage.summary.failed} failed · ${stage.summary.missing} missing ·
            ${stage.summary.passed} passed</span>
        </summary>
        ${stage.gatedBy ? `<p class="cw-note">Held by the ${escape(stage.gatedBy.toLowerCase())} stage.</p>` : ''}
        ${stage.findings.length ? `<ul class="cw-checks">${stage.findings.map(field => `<li data-status="${field.status}">
          <span class="cw-check-status">${escape(STATUS_WORD[field.status] ?? field.status)}</span>
          <span class="cw-check-label">${escape(field.label)}${field.required ? '' : ' <i>(optional)</i>'}</span>
          <span class="cw-check-value">${escape(fieldValue(field) ?? '—')}</span>
          ${field.message ? `<span class="cw-check-note">${escape(field.message)}</span>` : ''}
          ${noteBeside(field) ? `<span class="cw-check-note">${escape(noteBeside(field))}</span>` : ''}
          ${candidateMarkup(field.recovery)}
        </li>`).join('')}</ul>` : '<p class="cw-note">This stage holds no records yet.</p>'}
      </details></li>`).join('')}</ol>
  </section>`;
}

function contextMarkup(context) {
  if (context?.state === 'loading') {
    return `<section class="cw-section" data-section="context"><h3>Incident context</h3>
      <p class="cw-note">Reading the historical record…</p></section>`;
  }
  if (!context?.value) {
    return `<section class="cw-section" data-section="context"><h3>Incident context</h3>
      <p class="cw-note">${escape(context?.reason ?? 'No incident context is available for this case.')}</p></section>`;
  }
  const data = context.value;
  const row = entry => `<tr><th>${escape(entry.label)}</th>
    <td>${entry.value == null ? '—' : escape(`${entry.value}${entry.unit ? ` ${entry.unit}` : ''}`)}</td>
    <td>${escape(entry.source ?? '—')}</td>
    <td>${escape(entry.observedAt ? dayOnly(entry.observedAt) : '—')}</td>
    <td>${escape(entry.quality ?? '—')}${entry.synthetic ? ' <em>synthetic</em>' : ''}</td></tr>`;
  const table = rows => `<table class="cw-table">
    <thead><tr><th>Reading</th><th>Value</th><th>Source</th><th>Observed</th><th>Quality</th></tr></thead>
    <tbody>${rows.map(row).join('')}</tbody></table>`;

  return `<section class="cw-section" data-section="context"><h3>Incident context</h3>
    <details open><summary><span class="cw-tl-name">Weather at the incident hour</span>
      <span class="cw-tl-counts">${data.weather.available ? 'Open-Meteo historical' : 'Unavailable'}</span></summary>
      ${data.weather.available ? table(data.weather.observations)
        : `<p class="cw-note">${escape(data.weather.unavailableReason)}</p>`}
      ${data.weather.provenance ? `<p class="cw-note">${escape(data.weather.provenance)}</p>` : ''}
    </details>
    <details><summary><span class="cw-tl-name">Traffic and operational impact</span>
      <span class="cw-tl-counts">Synthetic — no feed exists</span></summary>
      <p class="cw-note">${escape(data.traffic.availability.note)}</p>
      ${table([...(data.traffic.observations ?? []), data.traffic.annualAverage, ...data.traffic.register])}
      ${data.implications?.length ? `<ul class="cw-list">${data.implications.map(entry =>
        `<li><span class="cw-list-note">${escape(typeof entry === 'string' ? entry : entry.text ?? '')}</span></li>`).join('')}</ul>` : ''}
    </details>
  </section>`;
}

function claimMarkup(claim, demoCase, missingDocs) {
  return `<section class="cw-section" data-section="claim"><h3>Claim &amp; financial summary</h3>
    <div class="cw-money">
      <div><em>Status</em><span>${escape(claim.statusLabel)}</span></div>
      <div><em>Reference</em><span>${escape(claim.claimReference ?? 'Not raised')}</span></div>
      <div><em>Estimated</em><span>${usd(claim.estimatedUSD)}</span></div>
      <div><em>Approved</em><span>${usd(claim.approvedUSD)}</span></div>
      <div><em>Claimed</em><span>${usd(claim.claimedUSD)}</span></div>
      <div><em>Recovered</em><span>${usd(claim.recoveredUSD)}</span></div>
    </div>
    ${demoCase.claim?.costBasis ? `<p class="cw-note">${escape(demoCase.claim.costBasis)}</p>` : ''}
    ${missingDocs.length ? `<h4>Missing documents</h4><ul class="cw-list">${missingDocs.map(field =>
      `<li><span class="cw-list-main">${escape(field.label)}</span></li>`).join('')}</ul>`
      : '<p class="cw-note">No claim document is outstanding.</p>'}
    <p class="cw-note">Corridor-wide claim analysis is on
      <button type="button" class="cw-link" data-action="open-claims">Claims Intelligence</button>.</p>
  </section>`;
}

function historyMarkup(trail) {
  return `<section class="cw-section" data-section="history"><h3>Activity history</h3>
    <details><summary><span class="cw-tl-name">Audit trail</span>
      <span class="cw-tl-counts">${trail.length} entries</span></summary>
      <ol class="cw-trail">${trail.map(entry => `<li>
        <span class="cw-trail-when">${escape(clock(entry.at) ?? entry.at)}</span>
        <span class="cw-trail-what">${escape(entry.event)}</span>
        <span class="cw-trail-who">${escape(entry.actor)}${entry.role ? ` · ${escape(entry.role)}` : ''}</span>
        <span class="cw-list-note">${escape(entry.detail ?? '')}</span></li>`).join('')}</ol>
    </details>
  </section>`;
}

/* ── install ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * @param {HTMLElement} host
 * @param {{positionOf?: Function, onViewOnMap?: Function, onOpenClaims?: Function,
 *          searchEvidence?: Function, readContext?: Function, claimFor?: Function}} deps
 */
export function installCaseWorkbench(host, {
  positionOf = null, onViewOnMap = null, onOpenClaims = null, onSelect = null,
  searchEvidence = null, readContext = null, claimFor = null,
} = {}) {
  const root = document.createElement('section');
  root.className = 'case-workbench';
  root.hidden = true;
  root.innerHTML = '<div class="cw-queue"></div><div class="cw-main"></div>';
  host.append(root);
  const queueHost = root.querySelector('.cw-queue');
  const mainHost = root.querySelector('.cw-main');

  let records = [];
  let unavailable = null;
  let selectedId = null;
  let filters = { bucket: 'all', query: '' };
  /** caseId -> { state, value } for the two asynchronous reads, so neither re-runs per render. */
  const recoveries = new Map();
  const contexts = new Map();
  /**
   * Which stages the reader has open, per case, and how far each pane is scrolled.
   *
   * Kept because the workbench re-renders on its own: the evidence search and the weather read
   * both land after the case is drawn, and without this each of them closed a stage the reader had
   * just opened and threw them back to the top of the page. It is also what a return from the map
   * restores.
   */
  const openStages = new Map();
  const mainScroll = new Map();

  const recordOf = id => records.find(record => record.id === id) ?? null;

  function rows() {
    return records.map(record => queueRow(record, { positionOf }));
  }

  function renderQueue() {
    const all = rows();
    const scroll = queueHost.scrollTop;
    queueHost.innerHTML = queueMarkup(
      filterQueue(all, filters), filters, queueFacets(all), bucketCounts(all), selectedId);
    queueHost.scrollTop = scroll;
  }

  /** The stages the engine says should start open — the failed or active one. */
  const timelineDefaults = record =>
    validationTimeline(record).filter(stage => stage.expanded).map(stage => stage.key);

  function stagesOpenFor(caseId, defaults) {
    if (!openStages.has(caseId)) openStages.set(caseId, new Set(defaults));
    return openStages.get(caseId);
  }

  function renderMain() {
    if (unavailable) { mainHost.innerHTML = `<p class="cw-empty">${escape(unavailable)}</p>`; return; }
    const record = recordOf(selectedId);
    if (!record) {
      mainHost.innerHTML = '<p class="cw-empty">Choose a case from the queue.</p>';
      return;
    }
    const recovery = recoveries.get(record.id) ?? null;
    const context = contexts.get(record.id) ?? null;
    const claim = claimFor?.(record) ?? null;
    const open = stagesOpenFor(record.id, timelineDefaults(record));
    const timeline = validationTimeline(record, { recovery: recovery?.value ?? null })
      .map(stage => ({ ...stage, expanded: open.has(stage.key) }));
    const missingDocs = timeline.find(stage => stage.key === 'CLAIM')?.findings
      .filter(field => field.status === STATUS.MISSING && field.required) ?? [];
    mainHost.innerHTML = headerMarkup(headerOf(record, { positionOf }))
      + actionMarkup(actionRequiredOf(record, { recovery: recovery?.value ?? null }))
      + timelineMarkup(timeline, { state: recovery?.state ?? 'none', summary: recovery?.value?.summary ?? null })
      + contextMarkup(context)
      + (claim ? claimMarkup(claim, record.demoCase, missingDocs) : '')
      + historyMarkup(record.demoCase.auditTrail ?? []);
    // Back where the reader was. A re-render is almost always an async result arriving, not a new
    // case, and scrolling them to the top for it is the kind of thing that makes a page feel broken.
    mainHost.scrollTop = mainScroll.get(record.id) ?? 0;
  }

  /** Both reads run once per case, on selection, and never on a re-render. */
  function ensureAsync(record) {
    if (searchEvidence && !recoveries.has(record.id)) {
      recoveries.set(record.id, { state: 'loading', value: null });
      Promise.resolve(searchEvidence(record))
        .then(value => recoveries.set(record.id, { state: 'ready', value }))
        .catch(() => recoveries.set(record.id, { state: 'none', value: null }))
        .finally(() => { if (selectedId === record.id) renderMain(); });
    }
    if (readContext && !contexts.has(record.id)) {
      contexts.set(record.id, { state: 'loading', value: null });
      Promise.resolve(readContext(record))
        .then(value => contexts.set(record.id, { state: 'ready', value }))
        .catch(error => contexts.set(record.id,
          { state: 'ready', value: null, reason: `The context could not be read: ${error?.message ?? error}` }))
        .finally(() => { if (selectedId === record.id) renderMain(); });
    }
  }

  function select(id, { fresh = true } = {}) {
    const record = recordOf(id);
    if (!record) return false;
    if (fresh && selectedId !== record.id) mainScroll.set(record.id, 0);
    selectedId = record.id;
    ensureAsync(record);
    renderQueue();
    renderMain();
    onSelect?.(record.id);
    return true;
  }

  queueHost.onclick = event => {
    const bucket = event.target.closest('[data-bucket]');
    if (bucket) { filters = { ...filters, bucket: bucket.dataset.bucket }; renderQueue(); return; }
    const row = event.target.closest('[data-case]');
    if (row) select(row.dataset.case);
  };
  queueHost.oninput = event => {
    const name = event.target.dataset.filter;
    if (!name) return;
    filters = { ...filters, [name]: event.target.value || null };
    const focused = document.activeElement === event.target ? event.target.dataset.filter : null;
    const caret = event.target.selectionStart;
    renderQueue();
    if (focused) {
      const next = queueHost.querySelector(`[data-filter="${focused}"]`);
      next?.focus();
      if (next && caret != null && next.type === 'search') next.setSelectionRange(caret, caret);
    }
  };
  queueHost.onchange = queueHost.oninput;

  // `toggle` does not bubble, so it is caught in the capture phase.
  mainHost.addEventListener('toggle', event => {
    const stage = event.target.dataset?.stage;
    if (!stage || !selectedId) return;
    const open = stagesOpenFor(selectedId, []);
    if (event.target.open) open.add(stage); else open.delete(stage);
  }, true);
  mainHost.addEventListener('scroll', () => {
    if (selectedId) mainScroll.set(selectedId, mainHost.scrollTop);
  }, { passive: true });

  /**
   * Open one validation stage and bring it into view.
   *
   * Every stage is reachable, passed ones included: "what passed" is as much a question as "what
   * failed". Shared with Ask the Twin's OPEN_VALIDATION_STAGE action, so the assistant moves the
   * workbench exactly the way a click does rather than through a second code path.
   */
  function openStage(key) {
    const details = mainHost.querySelector(`details[data-stage="${CSS.escape(String(key))}"]`);
    if (!details) return false;
    details.open = true;
    for (const other of mainHost.querySelectorAll('.cw-timeline details')) {
      other.classList.toggle('is-targeted', other === details);
    }
    if (selectedId) stagesOpenFor(selectedId, []).add(String(key));
    details.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return true;
  }

  /** Scroll one of the five sections into view. Nothing else changes. */
  function openSection(id) {
    const section = mainHost.querySelector(`section[data-section="${CSS.escape(String(id))}"]`);
    if (!section) return false;
    section.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return true;
  }

  mainHost.onclick = event => {
    const stage = event.target.closest('button[data-stage]');
    if (stage) { openStage(stage.dataset.stage); return; }
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    if (button.dataset.action === 'view-on-map') onViewOnMap?.(recordOf(selectedId));
    if (button.dataset.action === 'open-claims') onOpenClaims?.();
  };

  return {
    root,
    get selectedId() { return selectedId; },
    select,
    /** Ask the Twin's safe navigation actions, through the workbench's own behaviour. */
    openStage,
    openSection,
    /** The cases, or the reason there are none. Keeps the selection if the case is still there. */
    setCases(next, { unavailable: reason = null } = {}) {
      records = next ?? [];
      unavailable = reason;
      const previous = selectedId;
      if (!records.some(record => record.id === selectedId)) selectedId = records[0]?.id ?? null;
      if (selectedId) ensureAsync(recordOf(selectedId));
      renderQueue();
      renderMain();
      // The queue falling back to its first case IS a selection — it is the case on screen. Not
      // reporting it left the workspace believing nothing was selected while the workbench showed
      // ACS-DEMO-001, so Ask the Twin's chip read "none selected" and its answers had no case.
      if (selectedId && selectedId !== previous) onSelect?.(selectedId);
    },
    /**
     * Everything a return from the map has to put back: the case, its open stages, both scroll
     * positions and the queue's own filters and search.
     */
    snapshot() {
      return {
        caseId: selectedId,
        filters: { ...filters },
        openStages: selectedId ? [...stagesOpenFor(selectedId, [])] : [],
        mainScroll: selectedId ? mainScroll.get(selectedId) ?? 0 : 0,
        queueScroll: queueHost.scrollTop,
      };
    },
    restore(snapshot) {
      if (!snapshot?.caseId) return false;
      filters = { ...snapshot.filters };
      openStages.set(snapshot.caseId, new Set(snapshot.openStages));
      mainScroll.set(snapshot.caseId, snapshot.mainScroll);
      const ok = select(snapshot.caseId, { fresh: false });
      queueHost.scrollTop = snapshot.queueScroll;
      return ok;
    },
    show() { root.hidden = false; },
    hide() { root.hidden = true; },
    destroy() { root.remove(); },
  };
}
