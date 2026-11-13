/**
 * Construction Progress — schedule, model, evidence and cost in one workspace.
 *
 * Laid out as the brief asks: a toolbar, the P6 hierarchy on the left, the model in the centre,
 * the selected record on the right, and four subtabs along the bottom. Each panel reads from the
 * server; none of them calculates a figure of its own.
 *
 * THE ONE RULE THE SCREEN ENFORCES: planned and verified are shown side by side and never merged.
 * A date on the timeline moves what is SCHEDULED; only a verified observation makes an element
 * built, and the legend says which colour means which.
 */
import { escape, num, request, when } from './ciClient.js';
import { installTowerModel, LEGEND, MODES } from './towerModel.js';

const pct = value => (value == null ? '—' : `${value}%`);
const money = (value, currency) => (value == null ? '—'
  : `${currency ?? ''} ${Math.round(value).toLocaleString('en-US')}`.trim());
const day = iso => (iso ? String(iso).slice(0, 10) : '—');

const SUBTABS = Object.freeze([
  { id: 'progress', label: 'Progress' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'cost', label: 'Quantities & Cost' },
  { id: 'mapping', label: 'Mapping & Exceptions' },
]);

/* ── markup ────────────────────────────────────────────────────────────────────────────────── */

function toolbar(facets, state) {
  const select = (name, label, values, current) => `<label class="ci-filter"><span>${escape(label)}</span>
      <select data-cp="${escape(name)}"><option value="">All</option>${values.map(value =>
    `<option value="${escape(value)}"${current === value ? ' selected' : ''}>${escape(value)}</option>`).join('')}
      </select></label>`;
  return `<div class="cp-toolbar">
      <div class="ci-filter"><span>Project</span><strong>Tower A</strong></div>
      <label class="ci-filter"><span>Date</span>
        <input type="date" data-cp="onDate" value="${escape(state.onDate)}"
          min="${escape(facets.timeline.from)}" max="${escape(facets.timeline.to)}"></label>
      ${select('level', 'Floor', facets.level, state.level)}
      ${select('zone', 'Zone', facets.zone, state.zone)}
      ${select('discipline', 'Discipline', facets.discipline, state.discipline)}
      <label class="ci-filter"><span>Visualisation</span>
        <select data-cp="mode">${MODES.map(entry =>
    `<option value="${entry.id}"${state.mode === entry.id ? ' selected' : ''}>${escape(entry.label)}</option>`).join('')}
        </select></label>
      <span class="ci-filter"><span>Data date</span><strong>${escape(facets.dataDate ?? '—')}</strong></span>
    </div>`;
}

function timeline(facets, state) {
  return `<div class="cp-timeline">
      <button type="button" class="ci-button ci-button--quiet" data-cp-action="step-back" aria-label="Step back">◀</button>
      <button type="button" class="ci-button" data-cp-action="play">${state.playing ? 'Pause' : 'Play'}</button>
      <button type="button" class="ci-button ci-button--quiet" data-cp-action="step-forward" aria-label="Step forward">▶</button>
      <input type="range" data-cp="slider" min="0" max="${state.totalDays}" value="${state.dayIndex}"
        aria-label="Project day">
      <label class="ci-filter"><span>Speed</span>
        <select data-cp="speed">${[1, 2, 4, 8].map(value =>
    `<option value="${value}"${state.speed === value ? ' selected' : ''}>${value}×</option>`).join('')}
        </select></label>
      <strong class="cp-date">${escape(state.onDate)}</strong>
      <span class="ci-chip" data-tone="info">Simulated 4D sequence</span>
    </div>`;
}

function legend(mode) {
  return `<ul class="cp-legend">${(LEGEND[mode] ?? []).map(entry =>
    `<li><span class="cp-swatch" style="background:${escape(entry.tone)}"></span>${escape(entry.label)}</li>`).join('')}
      <li><span class="cp-swatch" style="background:#ee6a6a"></span>Unmapped element</li>
    </ul>`;
}

function tree(activities, selectedId) {
  if (!activities.length) return '<p class="ci-status">No activity matches these filters.</p>';
  const groups = new Map();
  for (const row of activities) {
    const key = `${row.wbsCode} ${row.wbsName ?? ''}`.trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return `<ul class="cp-tree">${[...groups].map(([wbs, rows]) => `<li>
      <details open><summary>${escape(wbs)} <small>${rows.length}</small></summary>
        <ul>${rows.map(row => `<li>
          <button type="button" data-cp-activity="${escape(row.activityId)}"
            class="cp-activity${row.activityId === selectedId ? ' is-selected' : ''}">
            <span class="cp-activity-id">${escape(row.activityId)}</span>
            <span class="cp-activity-name">${escape(row.name)}</span>
            <span class="cp-bars" title="Planned ${pct(row.plannedPct)} · verified ${pct(row.verifiedPct)}">
              <span class="cp-bar cp-bar--planned" style="width:${Math.min(100, row.plannedPct ?? 0)}%"></span>
              <span class="cp-bar cp-bar--actual" style="width:${Math.min(100, row.verifiedPct ?? 0)}%"></span>
            </span>
            <span class="cp-activity-pct">${row.verifiedPct == null ? 'n/a' : pct(row.verifiedPct)}</span>
          </button></li>`).join('')}</ul>
      </details></li>`).join('')}</ul>`;
}

function detailPanel(detail) {
  if (!detail) {
    return '<p class="ci-card-note">Choose an activity on the left, or click an element in the model.</p>';
  }
  const { activity, progress, value, scheduleVariance: variance, sapWbs } = detail;
  const row = (label, body) => `<div><dt>${escape(label)}</dt><dd>${body}</dd></div>`;
  return `<header class="ci-drawer-head"><div>
      <span class="ci-card-id">${escape(activity.source_id)}</span>
      <h2>${escape(activity.name)}</h2></div></header>
    <dl class="cp-facts">
      ${row('P6 WBS', escape(activity.wbs_code))}
      ${row('SAP WBS', sapWbs ? escape(sapWbs.source_id)
    : '<span class="ci-chip" data-tone="bad">no counterpart</span>')}
      ${row('Planned', `${escape(day(activity.planned_start))} → ${escape(day(activity.planned_finish))}`)}
      ${row('Actual', `${escape(day(activity.actual_start))} → ${escape(day(activity.actual_finish))}`)}
      ${row('P6 reports', pct(progress.p6ReportedPct))}
      ${row('Verified', `<strong>${pct(progress.verifiedPct)}</strong>`)}
      ${row('Variance', progress.variancePct == null ? '—'
    : `<span class="ci-chip" data-tone="${progress.variancePct < 0 ? 'warn' : 'ok'}">${progress.variancePct > 0 ? '+' : ''}${progress.variancePct} pp</span>`)}
      ${row('Remaining', progress.remainingDuration == null ? '—' : `${progress.remainingDuration} d`)}
    </dl>
    <p class="ci-card-note">Measured by <strong>${escape(progress.rule.replace(/_/g, ' ').toLowerCase())}</strong>.
      ${escape(progress.ruleNote)}</p>
    ${progress.unavailable ? `<p class="ci-card-note">${escape(progress.unavailable)}</p>` : ''}
    <p class="ci-card-note">Verified against what P6 claims. Against the straight-line schedule it
      is ${progress.scheduleLineVariancePct == null ? '—'
    : `${progress.scheduleLineVariancePct} pp${variance.days == null ? '' : `, about ${variance.days} day(s)`}`}.</p>
    <div class="ci-actions">
      <button type="button" class="ci-button" data-cp-action="isolate">Isolate its elements</button>
      <button type="button" class="ci-button ci-button--quiet" data-cp-action="prepare-p6">Prepare P6 update</button>
    </div>`;
}

function progressTab(detail) {
  if (!detail) return '<p class="ci-card-note">No activity selected.</p>';
  const { progress, observations } = detail;
  const verified = observations.filter(entry => entry.status === 'VERIFIED');
  const other = observations.filter(entry => entry.status !== 'VERIFIED');
  return `<p class="ci-card-note">${escape(String(progress.measured ?? '—'))} of
      ${escape(String(progress.total ?? '—'))} ${escape(progress.unit ?? '')} verified —
      ${pct(progress.verifiedPct)}. P6 reports ${pct(progress.p6ReportedPct)}.
      ${other.length ? `${other.length} unverified observation(s) exist and are NOT counted.` : ''}</p>
    <table class="ci-table ci-table--rows"><thead><tr>
      <th scope="col">Element</th><th scope="col">Observed</th><th scope="col">Quantity</th>
      <th scope="col">Source</th><th scope="col">Reviewer</th><th scope="col">Evidence</th>
      <th scope="col">Status</th></tr></thead>
      <tbody>${observations.map(entry => `<tr>
        <th scope="row">${escape(entry.element_id ?? '—')}</th>
        <td>${escape(day(entry.observed_on))}</td>
        <td>${num(entry.verified_quantity)}</td>
        <td>${escape(entry.source)}</td>
        <td>${escape(entry.reviewer)}</td>
        <td>${escape(entry.evidence_ref)}</td>
        <td><span class="ci-chip" data-tone="${entry.status === 'VERIFIED' ? 'ok' : 'info'}">${escape(entry.status)}</span></td>
      </tr>`).join('')}</tbody>
      <caption>${verified.length} verified observation(s) contribute to actual progress. A draft is
        somebody's note and contributes nothing.</caption></table>`;
}

function scheduleTab(detail) {
  if (!detail) return '<p class="ci-card-note">No activity selected.</p>';
  const { activity, progress, scheduleVariance: variance } = detail;
  return `<dl class="cp-facts">
      <div><dt>Planned start</dt><dd>${escape(day(activity.planned_start))}</dd></div>
      <div><dt>Planned finish</dt><dd>${escape(day(activity.planned_finish))}</dd></div>
      <div><dt>Baseline</dt><dd>${escape(day(activity.baseline_start))} → ${escape(day(activity.baseline_finish))}</dd></div>
      <div><dt>Actual start</dt><dd>${escape(day(activity.actual_start))}</dd></div>
      <div><dt>Actual finish</dt><dd>${escape(day(activity.actual_finish))}</dd></div>
      <div><dt>Calendar</dt><dd>${escape(activity.calendar ?? '—')}</dd></div>
      <div><dt>Data date</dt><dd>${escape(day(activity.data_date))}</dd></div>
      <div><dt>Schedule line at ${escape(progress.onDate)}</dt><dd>${pct(progress.plannedPct)}</dd></div>
    </dl>
    <p class="ci-card-note">${variance.days == null ? escape(variance.unavailable ?? '')
    : `Schedule variance ${variance.days} day(s). ${escape(variance.note)}`}</p>`;
}

function costTab(detail) {
  if (!detail) return '<p class="ci-card-note">No activity selected.</p>';
  const { value } = detail;
  if (!value.boqItems.length) {
    return `<p class="ci-card-note">${escape(value.unavailable)}</p>
      <p class="ci-card-note">SAP's own ledger for WBS ${escape(value.wbsCode)}:
        budget ${money(value.wbsBudgetUSD, value.currency)},
        actual cost ${money(value.wbsActualCostUSD, value.currency)}. That is the whole WBS, not
        this activity, and it is not earned value.</p>`;
  }
  return `<dl class="cp-facts">
      <div><dt>BOQ items</dt><dd>${value.boqItems.map(item =>
    `${escape(item.code)} (${escape(item.unit)} @ ${num(item.unitRate)})`).join('<br>')}</dd></div>
      <div><dt>Budget value of linked work</dt><dd>${money(value.budgetValueUSD, value.currency)}</dd></div>
      <div><dt>Earned value (verified × approved rate)</dt><dd><strong>${money(value.earnedValueUSD, value.currency)}</strong></dd></div>
      <div><dt>SAP actual cost (whole WBS ${escape(value.wbsCode)})</dt><dd>${money(value.wbsActualCostUSD, value.currency)}</dd></div>
      <div><dt>SAP budget (whole WBS)</dt><dd>${money(value.wbsBudgetUSD, value.currency)}</dd></div>
    </dl>
    <p class="ci-card-note">Earned value is what the verified work is worth at the approved rates.
      SAP's actual cost is what has been spent against the whole WBS. They are different figures
      and are never added together.
      ${value.unavailable ? escape(value.unavailable) : ''}</p>`;
}

function mappingTab(detail, elementId) {
  if (!detail) return '<p class="ci-card-note">No activity selected.</p>';
  const { elements, validation, exceptions } = detail;
  return `${validation.length ? `<ul class="ci-findings">${validation.map(entry => `<li data-tone="${entry.severity === 'ERROR' ? 'bad' : 'warn'}">
      <strong>${escape(entry.rule_id)}</strong> ${escape(entry.subject_id)}
      <p>${escape(entry.explanation)}</p>
      <small>Expected ${escape(entry.expected ?? '—')} · found ${escape(entry.actual ?? '—')}</small>
      ${entry.rule_id === 'R11_SEQUENCE_INCONSISTENT'
    ? '<small>A sequence warning is a question for the planner, not a confirmed construction error.</small>' : ''}
    </li>`).join('')}</ul>`
    : '<p class="ci-card-note">No open finding against this activity or its elements.</p>'}
    <table class="ci-table ci-table--rows"><thead><tr>
      <th scope="col">Element</th><th scope="col">Category</th><th scope="col">Floor / zone</th>
      <th scope="col">BOQ</th><th scope="col">Mapping</th><th scope="col">Verified</th>
      <th scope="col"></th></tr></thead>
      <tbody>${elements.map(row => `<tr${row.element_id === elementId ? ' class="is-selected"' : ''}>
        <th scope="row">${escape(row.element_id)}</th>
        <td>${escape(row.category)}</td>
        <td>${escape(row.level)} · ${escape(row.zone)}</td>
        <td>${escape(row.boq_code ?? '—')}</td>
        <td><span class="ci-chip" data-tone="${row.status === 'COMPLETE' ? 'ok' : row.status === 'INCOMPLETE' ? 'bad' : 'warn'}">${escape(row.status.replace(/_/g, ' ').toLowerCase())}</span></td>
        <td>${row.verified ? '<span class="ci-chip" data-tone="ok">yes</span>' : '—'}</td>
        <td><button type="button" class="ci-button ci-button--quiet"
              data-cp-action="open-mapping" data-element="${escape(row.element_id)}">Mapping Workbench</button></td>
      </tr>`).join('')}</tbody></table>
    ${exceptions.length ? `<p class="ci-card-note">${exceptions.length} exception(s) touch this
      activity. They are Phase 3's, reused — progress never resolves one.</p>` : ''}`;
}

/* ── the workspace ─────────────────────────────────────────────────────────────────────────── */

export function installConstructionProgress(host, { openMapping = null } = {}) {
  const root = document.createElement('div');
  root.className = 'cp-root';
  host.append(root);

  const state = {
    onDate: null, level: '', zone: '', discipline: '', mode: 'planned',
    subtab: 'progress', playing: false, speed: 2, dayIndex: 0, totalDays: 0, message: '',
  };
  let facets = null;
  let activities = [];
  let detail = null;
  let selectedActivity = null;
  let selectedElement = null;
  let model = null;
  let shell = null;
  let timer = null;

  const dayOf = index => new Date(Date.parse(`${facets.timeline.from}T00:00:00Z`) + index * 86400000)
    .toISOString().slice(0, 10);

  function renderShell() {
    root.innerHTML = `
      ${toolbar(facets, state)}
      ${timeline(facets, state)}
      <p class="ci-actions-note cp-message" role="status"${state.message ? '' : ' hidden'}>${escape(state.message)}</p>
      <div class="cp-grid">
        <section class="cp-tree-panel" aria-label="P6 activities"></section>
        <section class="cp-model" aria-label="Tower A model">
          <div class="cp-model-tools">
            <button type="button" class="ci-button ci-button--quiet" data-cp-action="fit">Fit to selection</button>
            <button type="button" class="ci-button ci-button--quiet" data-cp-action="reset-view">Reset view</button>
            <span class="cp-categories">${facets.category.map(entry =>
    `<label><input type="checkbox" data-cp-category="${escape(entry)}" checked> ${escape(entry)}</label>`).join('')}</span>
          </div>
          <div class="cp-canvas"></div>
          ${legend(state.mode)}
        </section>
        <aside class="cp-detail" aria-label="Selected record"></aside>
      </div>
      <div class="cp-bottom">
        <div class="aom-tabs ci-subtabs" role="tablist">${SUBTABS.map(entry =>
    `<button role="tab" type="button" data-cp-subtab="${entry.id}" aria-selected="${entry.id === state.subtab}">${escape(entry.label)}</button>`).join('')}</div>
        <div class="cp-bottom-body"></div>
      </div>`;
    shell = {
      tree: root.querySelector('.cp-tree-panel'),
      canvas: root.querySelector('.cp-canvas'),
      detail: root.querySelector('.cp-detail'),
      bottom: root.querySelector('.cp-bottom-body'),
    };
    model = installTowerModel(shell.canvas, { onPick: id => { void pickElement(id); } });
  }

  function renderPanels() {
    if (!shell) return;
    shell.tree.innerHTML = tree(activities, selectedActivity);
    shell.detail.innerHTML = detailPanel(detail);
    shell.bottom.innerHTML = state.subtab === 'progress' ? progressTab(detail)
      : state.subtab === 'schedule' ? scheduleTab(detail)
        : state.subtab === 'cost' ? costTab(detail) : mappingTab(detail, selectedElement);
  }

  function renderChrome() {
    const bar = root.querySelector('.cp-toolbar');
    if (bar) bar.outerHTML = toolbar(facets, state);
    const line = root.querySelector('.cp-timeline');
    if (line) line.outerHTML = timeline(facets, state);
    const key = root.querySelector('.cp-legend');
    if (key) key.outerHTML = legend(state.mode);
    // The message has a permanent slot. Rendering it conditionally meant there was no element to
    // update the first time something had to be said, so the Prepare-P6 result never appeared.
    const note = root.querySelector('.cp-message');
    if (note) { note.textContent = state.message; note.hidden = !state.message; }
  }

  async function loadModel() {
    const query = new URLSearchParams();
    for (const key of ['onDate', 'level', 'zone', 'discipline']) {
      if (state[key]) query.set(key, state[key]);
    }
    const payload = await request(`/model?${query}`);
    facets ??= payload.facets;
    model?.setElements(payload.elements);
    model?.setMode(state.mode);
  }

  async function loadActivities() {
    const query = new URLSearchParams();
    for (const key of ['onDate', 'level', 'zone', 'discipline']) {
      if (state[key]) query.set(key, state[key]);
    }
    activities = (await request(`/progress/activities?${query}`)).activities;
  }

  async function loadDetail() {
    if (!selectedActivity) { detail = null; return; }
    detail = await request(
      `/progress/activity/${encodeURIComponent(selectedActivity)}?onDate=${encodeURIComponent(state.onDate)}`);
  }

  async function refresh({ chrome = false } = {}) {
    try {
      await Promise.all([loadModel(), loadActivities()]);
      await loadDetail();
      if (chrome) renderChrome();
      renderPanels();
      model?.select(selectedElement);
      model?.highlight(detail?.elements.map(row => row.element_id) ?? []);
    } catch (error) {
      state.message = error.message;
      renderChrome();
    }
  }

  async function chooseActivity(activityId) {
    selectedActivity = activityId;
    selectedElement = null;
    state.message = '';
    await loadDetail();
    renderPanels();
    model?.select(null);
    model?.highlight(detail?.elements.map(row => row.element_id) ?? []);
  }

  async function pickElement(elementId) {
    if (!elementId) return;
    selectedElement = elementId;
    // Selecting an element shows the activity that builds it — the chain the brief asks for.
    const owner = await request(`/mappings/${encodeURIComponent(elementId)}`).catch(() => null);
    const activityId = owner?.mapping?.activity_id ?? null;
    state.message = activityId ? ''
      : `${elementId} is not linked to any activity. Open it in the Mapping Workbench to propose one.`;
    if (activityId && activityId !== selectedActivity) {
      selectedActivity = activityId;
      await loadDetail();
    }
    renderChrome();
    renderPanels();
    model?.select(elementId);
    model?.highlight(detail?.elements.map(row => row.element_id) ?? []);
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } state.playing = false; }

  function play() {
    stop();
    state.playing = true;
    timer = setInterval(() => {
      state.dayIndex = Math.min(state.totalDays, state.dayIndex + 7);
      state.onDate = dayOf(state.dayIndex);
      if (state.dayIndex >= state.totalDays) stop();
      void refresh({ chrome: true });
    }, Math.max(150, 1200 / state.speed));
    renderChrome();
  }

  root.onclick = event => {
    const activity = event.target.closest('[data-cp-activity]');
    if (activity) { void chooseActivity(activity.dataset.cpActivity); return; }
    const subtab = event.target.closest('[data-cp-subtab]');
    if (subtab) { state.subtab = subtab.dataset.cpSubtab; renderPanels();
      for (const button of root.querySelectorAll('[data-cp-subtab]')) {
        button.setAttribute('aria-selected', String(button.dataset.cpSubtab === state.subtab));
      }
      return; }
    const button = event.target.closest('[data-cp-action]');
    if (!button) return;
    const action = button.dataset.cpAction;
    if (action === 'fit') model?.fit(detail?.elements.map(row => row.element_id) ?? null);
    if (action === 'reset-view') { model?.reset(); selectedElement = null; renderPanels(); }
    if (action === 'isolate') {
      const ids = detail?.elements.map(row => row.element_id) ?? [];
      model?.highlight(ids); model?.fit(ids);
    }
    if (action === 'open-mapping') openMapping?.(button.dataset.element);
    if (action === 'step-back' || action === 'step-forward') {
      stop();
      state.dayIndex = Math.max(0, Math.min(state.totalDays,
        state.dayIndex + (action === 'step-forward' ? 7 : -7)));
      state.onDate = dayOf(state.dayIndex);
      void refresh({ chrome: true });
    }
    if (action === 'play') { if (state.playing) { stop(); renderChrome(); } else play(); }
    if (action === 'prepare-p6') void prepareDraft();
  };

  async function prepareDraft() {
    try {
      const result = await request('/p6-drafts', { method: 'POST',
        body: { activityId: selectedActivity } });
      state.message = `Draft ${result.draft.id} prepared: ${result.draft.current_pct}% → `
        + `${result.draft.proposed_pct}% verified. ${result.note}`;
    } catch (error) { state.message = error.message; }
    renderChrome();
  }

  root.onchange = event => {
    const category = event.target.dataset?.cpCategory;
    if (category) { model?.toggleCategory(category, event.target.checked); return; }
    const name = event.target.dataset?.cp;
    if (!name) return;
    if (name === 'slider') {
      stop();
      state.dayIndex = Number(event.target.value);
      state.onDate = dayOf(state.dayIndex);
      void refresh({ chrome: true });
      return;
    }
    if (name === 'speed') { state.speed = Number(event.target.value); if (state.playing) play(); return; }
    if (name === 'mode') { state.mode = event.target.value; model?.setMode(state.mode); renderChrome(); return; }
    if (name === 'onDate') {
      stop();
      state.onDate = event.target.value;
      state.dayIndex = Math.round((Date.parse(`${state.onDate}T00:00:00Z`)
        - Date.parse(`${facets.timeline.from}T00:00:00Z`)) / 86400000);
    } else {
      state[name] = event.target.value;
    }
    void refresh({ chrome: true });
  };

  async function start() {
    const payload = await request('/model');
    facets = payload.facets;
    state.onDate = facets.dataDate ?? facets.timeline.from;
    state.totalDays = Math.round((Date.parse(`${facets.timeline.to}T00:00:00Z`)
      - Date.parse(`${facets.timeline.from}T00:00:00Z`)) / 86400000);
    state.dayIndex = Math.round((Date.parse(`${state.onDate}T00:00:00Z`)
      - Date.parse(`${facets.timeline.from}T00:00:00Z`)) / 86400000);
    renderShell();
    await refresh();
    model?.fit();
  }

  root.innerHTML = '<p class="ci-status">Building the model…</p>';
  const ready = start().catch(error => {
    root.innerHTML = `<p class="ci-status" data-state="error">${escape(error.message)}</p>`;
  });

  return {
    root, ready,
    reload: () => refresh({ chrome: true }),
    /** Open one activity from elsewhere — the scenarios and the tests use it. */
    show: activityId => chooseActivity(activityId),
    get state() { return { ...state }; },
    destroy() { stop(); model?.destroy(); root.remove(); },
  };
}
