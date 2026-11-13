/**
 * Construction Lifecycle — one real OpenProject activity, from plan to close.
 *
 * ACTIVITY-CENTRIC, which is the change this workspace exists to make. Every other screen in the
 * demo is organised by SYSTEM — the schedule here, the model there, approvals somewhere else — so
 * following one piece of work meant visiting four screens and re-selecting it in each. This one
 * is organised by the work.
 *
 * Phase 10A builds the shell and the first two stages' worth of truth: the activity header from
 * the live OpenProject snapshot, a stepper whose every stage has an explicit rule, the issues
 * that fall out of those rules, and the model beside it. Stages 4–6 read NOT_STARTED because
 * their records genuinely do not exist yet — that is Phase 10D — and saying so is the point.
 *
 * What it will not do: it will not read a lifecycle out of `percentageDone`. The live instance is
 * the standing argument — 17 of its 18 activities report progress while their status is still
 * "New" — so a stepper driven by that number would be confidently wrong 17 times.
 */
import { escape, num, request, when } from './ciClient.js';
import { installBimViewer } from './bimViewer.js';
import { installCreateTaskDrawer } from './createTaskDrawer.js';

/** How each stage status reads. Every colour carries a word. */
export const STAGE_LABEL = Object.freeze({
  NOT_STARTED: { label: 'Not started', tone: 'info' },
  ACTION_REQUIRED: { label: 'Action required', tone: 'warn' },
  IN_PROGRESS: { label: 'In progress', tone: 'ok' },
  COMPLETED: { label: 'Completed', tone: 'ok' },
  BLOCKED: { label: 'Blocked', tone: 'bad' },
});

const SEVERITY_TONE = Object.freeze({ HIGH: 'bad', MEDIUM: 'warn', LOW: 'info' });

/** A value, or an honest statement of why there isn't one. Never a cheerful dash alone. */
const fact = (label, value, unavailable = null) => ({
  label,
  value: value == null || value === ''
    ? `<span class="cl-absent">${escape(unavailable ?? 'Not recorded')}</span>`
    : escape(value),
});

function headerMarkup(detail) {
  const a = detail.activity;
  const conflict = detail.lifecycle.stages.find(entry => entry.id === 'execute')?.conflict;
  return `<header class="cl-head">
      <div class="cl-head-main">
        <h3>#${escape(a.externalActivityId)} ${escape(a.activityName ?? '')}</h3>
        <p class="cl-head-sub">${escape(a.sourceProjectName ?? 'OpenProject')} ·
          ${escape(a.activityType ?? 'Work package')} ·
          last synchronised ${escape(when(detail.lastSynchronisedAt))}</p>
      </div>
      <div class="cl-head-side">
        <span class="ci-chip" data-tone="${conflict ? 'bad' : 'info'}"
          data-cl-status="${escape(a.status ?? '')}">${escape(a.status ?? 'Unknown')}</span>
        <span class="ci-chip" data-tone="info"
          data-cl-pct="${escape(a.reportedProgressPct ?? '')}">${
  a.reportedProgressPct == null ? '—' : `${escape(a.reportedProgressPct)}%`} reported</span>
        ${a.sourceUrl ? `<a class="cl-source" href="${escape(a.sourceUrl)}" target="_blank"
          rel="noreferrer noopener">Open in OpenProject</a>` : ''}
      </div>
    </header>`;
}

/**
 * The stepper.
 *
 * Six stages, each with its own rule and its own evidence. The caption under it is not decoration:
 * a stepper looks like a progress bar, and this one is not measuring the building.
 */
function stepperMarkup(lifecycle, activeStageId) {
  return `<ol class="cl-stepper" role="tablist" aria-label="Construction lifecycle">
      ${lifecycle.stages.map((entry, index) => {
    const spec = STAGE_LABEL[entry.status] ?? { label: entry.status, tone: 'info' };
    const on = entry.id === activeStageId;
    return `<li><button type="button" role="tab" class="cl-step"
        aria-selected="${on}" data-stage="${escape(entry.id)}" data-on="${on}"
        data-stage-status="${escape(entry.status)}">
        <span class="cl-step-n">${index + 1}</span>
        <span class="cl-step-label">${escape(entry.label)}</span>
        <span class="ci-chip" data-tone="${escape(spec.tone)}">${escape(spec.label)}</span>
      </button></li>`;
  }).join('')}
    </ol>
    <p class="ci-card-note cl-stepper-note">${escape(lifecycle.note)}</p>`;
}

/** The Plan stage — real source fields, and "not available" where OpenProject has no field. */
function planMarkup(detail) {
  const a = detail.activity;
  const rows = [
    fact('Work package', `#${a.externalActivityId}`),
    fact('Status', a.status),
    fact('Reported complete', a.reportedProgressPct == null ? null : `${a.reportedProgressPct}%`),
    fact('Planned start', a.plannedStart),
    fact('Planned finish', a.plannedFinish),
    // OpenProject has no actual-start/finish field at all — the schema has startDate and dueDate
    // and both are planned. Inventing them is exactly what the brief forbids.
    fact('Actual start', null, detail.unavailable.actualDates),
    fact('Actual finish', null, detail.unavailable.actualDates),
    fact('Estimated work', a.estimatedTimeRaw),
    fact('Remaining work', a.remainingTimeRaw),
    fact('Time logged', a.spentTimeRaw, 'Not available'),
    fact('Parent', a.parentExternalId ? `#${a.parentExternalId} ${a.parentName ?? ''}` : null,
      'No parent package'),
    fact('Dependencies', Array.isArray(a.dependencies) && a.dependencies.length
      ? a.dependencies.map(d => `${d.type ?? 'relation'} → #${d.toExternalId ?? '?'}`).join(', ')
      : null, detail.unavailable.dependencies),
    fact('Baseline', null, detail.unavailable.baseline),
    fact('Source revision', a.sourceRevision == null ? null : `lockVersion ${a.sourceRevision}`),
    fact('Last source update', a.sourceUpdatedAt ? when(a.sourceUpdatedAt) : null),
  ];
  return `<dl class="cl-facts">${rows.map(row =>
    `<div><dt>${escape(row.label)}</dt><dd>${row.value}</dd></div>`).join('')}</dl>`;
}

function linkBimMarkup(detail) {
  const stage = detail.lifecycle.stages.find(entry => entry.id === 'linkBim');
  const mappings = detail.mappings ?? [];
  return `<div class="cl-stage-body">
      <p class="cl-stage-detail">${escape(stage.detail)}</p>
      ${mappings.length ? `<table class="ci-table ci-table--rows">
        <thead><tr><th scope="col">Status</th>
          <th scope="col" class="ci-col--text">IFC GlobalId</th>
          <th scope="col" class="ci-col--text">Decided by</th></tr></thead>
        <tbody>${mappings.map(entry => `<tr>
          <th scope="row">${escape(entry.status)}</th>
          <td class="ci-col--text"><code>${escape(entry.ifcGuid)}</code></td>
          <td class="ci-col--text">${escape(entry.decidedBy ?? entry.proposedBy ?? '—')}</td>
        </tr>`).join('')}</tbody></table>`
    : `<p class="ci-card-note">Linking elements to this activity is the next step in this
        workspace. Until a BIM Coordinator approves a mapping, this activity's progress cannot be
        shown on the model and no element-level reporting is possible.</p>`}
      <p class="ci-card-note"><strong>Nothing is linked automatically.</strong> A name match is
        not an identification — several elements may share a name, and some walls belong to other
        activities.</p>
    </div>`;
}

/** The three stages Phase 10D fills. Honest about being unbuilt rather than mocked. */
function pendingStageMarkup(detail, stageId) {
  const stage = detail.lifecycle.stages.find(entry => entry.id === stageId);
  const write = detail.writeBack;
  const extra = stageId === 'approve' || stageId === 'close'
    ? `<div class="cl-writeback">
        <h5>OpenProject write-back</h5>
        <p class="ci-card-note">The connected token <strong>does</strong> hold
          <code>updateImmediately</code> on this work package, so a write-back is possible.
          ${escape(write.note)}</p>
        <dl class="cl-facts cl-facts--tight">
          <div><dt>Method</dt><dd><code>${escape(write.method)}</code></dd></div>
          <div><dt>Proposable today</dt>
            <dd>${write.proposableFields.map(f => `<code>${escape(f)}</code>`).join(' ')}</dd></div>
          <div><dt>Writable in this instance</dt>
            <dd><small>${write.writableFields.map(escape).join(', ')}</small></dd></div>
          <div><dt>Read-only — never proposed</dt>
            <dd><small>${write.readOnlyFields.map(escape).join(', ')}</small></dd></div>
        </dl>
      </div>` : '';
  return `<div class="cl-stage-body">
      <p class="cl-stage-detail">${escape(stage.detail)}</p>
      <p class="ci-status" data-state="loading" data-cl-pending="${escape(stageId)}">
        This stage is not implemented yet. It is scheduled for Phase 10D, and shows
        <strong>${escape(STAGE_LABEL[stage.status]?.label ?? stage.status)}</strong> because no
        record exists — not because the work is done.</p>
      ${extra}
    </div>`;
}

function executeMarkup(detail) {
  const stage = detail.lifecycle.stages.find(entry => entry.id === 'execute');
  const late = detail.overdue;
  return `<div class="cl-stage-body">
      <p class="cl-stage-detail">${escape(stage.detail)}</p>
      ${stage.conflict ? `<p class="ci-status" data-state="error" data-cl-conflict="true">
        <strong>Status and progress require review.</strong> ${escape(stage.conflict.detail)}
        Neither value has been changed — OpenProject is authoritative for both.</p>` : ''}
      ${late ? `<p class="ci-card-note"><strong>${escape(late.days)} day(s)</strong> past the
        planned finish of ${escape(late.plannedFinish)} with ${escape(late.reportedPct)}% reported.
        <small>${escape(late.basis)}</small></p>` : ''}
      <p class="ci-card-note">Reported completion is what a planner typed in OpenProject. It is
        not a verified site measurement, and it says nothing about whether any individual BIM
        element has been built.</p>
    </div>`;
}

function issuesMarkup(detail) {
  const issues = detail.issues ?? [];
  if (!issues.length) {
    return '<p class="ci-card-note">No issues detected for this activity.</p>';
  }
  return `<ul class="cl-issues">${issues.map(issue => `<li>
      <span class="ci-chip" data-tone="${escape(SEVERITY_TONE[issue.severity] ?? 'info')}"
        data-severity="${escape(issue.severity)}">${escape(issue.severity)}</span>
      <strong>${escape(issue.problem)}</strong>
      <small>${escape(issue.evidence)}</small>
      <em>${escape(issue.role)} — ${escape(issue.action)}</em>
    </li>`).join('')}</ul>`;
}

/* ── the screen ────────────────────────────────────────────────────────────────────────────── */

export function installConstructionLifecycle(host, {
  fetchJson = request,
  selection = null,
  viewerFactory = installBimViewer,
  onNavigate = null,
} = {}) {
  const root = document.createElement('div');
  root.className = 'cl-root';
  host.append(root);

  const chrome = document.createElement('div');
  chrome.className = 'cl-chrome';
  const stage = document.createElement('div');
  stage.className = 'cl-stage-view';
  const panel = document.createElement('div');
  panel.className = 'cl-panel';
  root.append(chrome, stage, panel);

  let activities = [];
  let detail = null;
  let activeStageId = null;
  let search = '';
  let error = null;
  let viewer = null;
  let loadedVersion = null;
  let unsubscribe = null;
  let searchTimer = null;

  const selectedId = () => selection?.get('workPackageId') ?? null;

  function render() {
    const panelTop = panel.scrollTop;
    if (error) {
      chrome.innerHTML = `<p class="ci-status" data-state="error">${escape(error)}</p>`;
      return;
    }
    const needle = search.trim().toLowerCase();
    const visible = activities.filter(entry => !needle
      || String(entry.subject ?? '').toLowerCase().includes(needle)
      || String(entry.workPackageId).includes(needle));

    chrome.innerHTML = `
      <div class="cl-picker">
        <label>Activity
          <select data-action="activity">
            ${visible.map(entry => `<option value="${escape(entry.workPackageId)}"
              ${String(entry.workPackageId) === selectedId() ? 'selected' : ''}>
              #${escape(entry.workPackageId)} · ${escape(String(entry.subject ?? '').slice(0, 54))}
              ${entry.issueCount ? ` · ${escape(entry.issueCount)} issue(s)` : ''}</option>`).join('')}
          </select>
        </label>
        <label>Search
          <input type="search" data-action="search" value="${escape(search)}"
            placeholder="subject or work package id">
        </label>
        <span class="cl-count">${escape(num(visible.length))} of
          ${escape(num(activities.length))} activities</span>
        <button type="button" class="ci-button ci-button--primary cl-create"
          data-action="create-task">+ Create Task</button>
      </div>
      ${detail ? headerMarkup(detail) : ''}
      ${detail ? stepperMarkup(detail.lifecycle, activeStageId) : ''}`;

    if (!detail) {
      panel.innerHTML = '<p class="ci-status" data-state="loading">Reading the activity…</p>';
      return;
    }
    const body = activeStageId === 'plan' ? planMarkup(detail)
      : activeStageId === 'linkBim' ? linkBimMarkup(detail)
        : activeStageId === 'execute' ? executeMarkup(detail)
          : pendingStageMarkup(detail, activeStageId);
    panel.innerHTML = `
      <section class="cl-section">
        <h4>${escape(detail.lifecycle.stages.find(e => e.id === activeStageId)?.label ?? '')}</h4>
        ${body}
      </section>
      <section class="cl-section">
        <h4>Issues <small>${escape((detail.issues ?? []).length)}</small></h4>
        ${issuesMarkup(detail)}
      </section>`;
    panel.scrollTop = panelTop;
  }

  async function loadActivities() {
    try {
      const payload = await fetchJson('/lifecycle/activities');
      activities = payload.activities ?? [];
      error = null;
      if (!selectedId() && activities.length) {
        // Open on the one that most needs attention rather than the first in the list.
        const worst = [...activities].sort((a, b) => b.issueCount - a.issueCount)[0];
        selection?.set({ workPackageId: worst.workPackageId });
      }
    } catch (cause) {
      error = `The construction API could not be reached, so the activity list is unknown: `
        + `${cause?.message ?? cause}`;
    }
    render();
  }

  async function loadDetail() {
    const id = selectedId();
    if (!id) { detail = null; render(); return; }
    try {
      detail = await fetchJson(`/lifecycle/activity/${encodeURIComponent(id)}`);
      // Open on whatever needs doing, unless the operator has picked a stage.
      activeStageId = selection?.get('stageId') ?? detail.lifecycle.currentStageId;
      error = null;
    } catch (cause) {
      detail = null;
      error = `Work package ${id} could not be read: ${cause?.message ?? cause}`;
    }
    render();
    await ensureModel();
  }

  /** The accepted model, beside the activity. Loaded once and kept across activity changes. */
  async function ensureModel() {
    try {
      const model = await fetchJson('/speckle/model');
      if (!model?.active || !model.glbUrl) return;
      if (!viewer) viewer = viewerFactory(stage, { onPick: guid => {
        // A pick updates the SHARED selection, so BIM Changes opens on the same element.
        if (guid) selection?.set({ ifcGuid: guid });
      } });
      if (loadedVersion !== model.active.versionId) {
        await viewer.load(model.glbUrl, model.placement);
        loadedVersion = model.active.versionId;
        selection?.set({ versionId: model.active.versionId, speckleModelId: model.active.modelId });
        const entry = await fetchJson('/speckle/timeline').catch(() => null);
        const current = entry?.versions?.find(v => v.versionId === model.active.versionId);
        if (current?.focusBounds) viewer.fitBounds(current.focusBounds); else viewer.fit();
      }
      // Highlight the elements this activity owns, when it has any.
      const guids = (detail?.mappings ?? [])
        .filter(entry => entry.status === 'APPROVED').map(entry => entry.ifcGuid);
      viewer.setChanges(guids.length
        ? Object.fromEntries(guids.map(guid => [guid, 'ADDED'])) : null);
      viewer.select(selection?.get('ifcGuid') ?? null);
    } catch {
      // The model is context, not the subject. A failure here must not blank the activity.
    }
  }

  chrome.onchange = event => {
    const action = event.target.dataset.action;
    if (action === 'activity') {
      selection?.set({ workPackageId: event.target.value, stageId: null });
    }
  };
  chrome.oninput = event => {
    if (event.target.dataset.action !== 'search') return;
    search = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 200);
  };
  chrome.onclick = event => {
    if (event.target.closest('[data-action="create-task"]')) { openCreateDrawer(); return; }
    const step = event.target.closest('[data-stage]')?.dataset.stage;
    if (step) { activeStageId = step; selection?.set({ stageId: step }); render(); }
  };

  /**
   * The create drawer, opened from here and from the BIM screen, never from both at once.
   *
   * One drawer instance, torn down on close. A second would be a second draft key in play, and
   * the whole duplicate guard rests on there being one key per intended task.
   */
  let drawer = null;
  function openCreateDrawer(bim = null) {
    drawer?.destroy();
    drawer = installCreateTaskDrawer(root, {
      fetchJson,
      bim,
      onClose() { drawer?.destroy(); drawer = null; root.dataset.drawer = 'closed'; },
      onCreated(created, { open = false } = {}) {
        // The new activity is already cached server-side, so the list is re-read rather than
        // guessed at, and the selection moves to the task that was just created.
        void loadActivities().then(() => {
          selection?.set({ workPackageId: created.workPackageId, stageId: null });
        });
        if (open) { drawer?.destroy(); drawer = null; root.dataset.drawer = 'closed'; }
      },
    });
    root.dataset.drawer = 'open';
  }
  panel.onclick = event => {
    const go = event.target.closest('[data-go]')?.dataset.go;
    if (go) onNavigate?.(go);
  };

  // Any screen changing the selected activity re-renders this one.
  unsubscribe = selection?.subscribe((_, changed) => {
    if (changed.includes('workPackageId')) void loadDetail();
    else if (changed.includes('ifcGuid')) viewer?.select(selection.get('ifcGuid'));
  });

  render();
  const ready = loadActivities().then(loadDetail);

  return {
    root,
    openCreateDrawer,
    get drawer() { return drawer; },
    get activities() { return activities; },
    get detail() { return detail; },
    get activeStageId() { return activeStageId; },
    ready,
    activate() {
      try { viewer?.viewer.resize(); } catch { /* not built yet */ }
      void loadDetail();
    },
    destroy() {
      clearTimeout(searchTimer);
      unsubscribe?.();
      drawer?.destroy();
      viewer?.destroy();
      root.remove();
    },
  };
}
