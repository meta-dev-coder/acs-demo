/**
 * OpenProject Live Schedule — a real external schedule, with its provenance on the face of it.
 *
 * The thing this screen exists to prevent: it sits one click away from five synthetic integration
 * cards and a synthetic P6 activity with almost the same name as a real one. A reader who comes
 * away thinking the P6 figures are live, or that OpenProject's 25% was copied into the demo, has
 * been misled by a screen that was technically accurate. So:
 *
 *  - every row carries LIVE — OpenProject Cloud, and the comparison names the other side
 *    SYNTHETIC — Primavera P6 demo data. Never a bare number next to a bare number.
 *  - "last read" and "right now" are different claims. Opening the tab shows the stored snapshot
 *    with its date; Refresh Schedule goes to OpenProject. A failed refresh keeps the rows and
 *    marks them STALE rather than showing them as fresh or blanking the screen.
 *  - returned and collection total are separate figures, side by side, because they can differ.
 *  - a work estimate is shown with its conversion basis attached. "40 h" alone is a claim about a
 *    project setting nobody on this screen has seen.
 *  - the OpenProject-versus-P6 difference always carries the reason it is not a finding.
 *
 * One contextual panel, no modals, no nested popups.
 */
import { API as API_BASE, escape, num, request, when } from './ciClient.js';

export const OP_API = '/openproject';

/** The six states the adapter reports, in the app's own tone vocabulary. */
export const OP_STATE = Object.freeze({
  NOT_CONFIGURED: { label: 'Not configured', tone: 'warn' },
  CONNECTED: { label: 'Connected', tone: 'ok' },
  PARTIAL: { label: 'Connected — incomplete', tone: 'warn' },
  AUTH_FAILED: { label: 'Authentication failed', tone: 'bad' },
  CONNECTION_FAILED: { label: 'Connection failed', tone: 'bad' },
  DATA_INVALID: { label: 'Unreadable response', tone: 'bad' },
  /** Configured and never read. An honest "we have not asked", not a connection claim. */
  NOT_READ: { label: 'Not read yet', tone: 'info' },
});
const stateOf = report => OP_STATE[report?.state] ?? { label: 'Unknown', tone: 'info' };

/** How each detected change reads, and how much it matters. */
export const CHANGE_LABEL = Object.freeze({
  NEW_ACTIVITY: { label: 'New activity', tone: 'info' },
  PROGRESS_CHANGED: { label: 'Progress changed', tone: 'ok' },
  SCHEDULE_CHANGED: { label: 'Schedule changed', tone: 'warn' },
  STATUS_CHANGED: { label: 'Status changed', tone: 'info' },
  WORK_ESTIMATE_CHANGED: { label: 'Work estimate changed', tone: 'info' },
  METADATA_ONLY: { label: 'Metadata only', tone: 'info' },
  SOURCE_CONFLICT: { label: 'Source conflict', tone: 'bad' },
  REMOVED: { label: 'No longer returned', tone: 'bad' },
  UNCHANGED: { label: 'Unchanged', tone: 'info' },
});
const changeLabel = kind => CHANGE_LABEL[kind] ?? { label: kind, tone: 'warn' };

/* ── Phase 8B: the automatic synchronisation worker ────────────────────────────────────────── */

export const SYNC_API = '/openproject/sync';
export const SYNC_EVENTS = '/openproject/events';
/** The event name the server publishes. One string, matched to openProjectSync.mjs by name. */
export const SYNC_EVENT = 'openproject-sync-completed';

/** What the worker is doing, in the app's tone vocabulary. */
export const WORKER_LABEL = Object.freeze({
  DISABLED: { label: 'Off', tone: 'info' },
  NOT_CONFIGURED: { label: 'Not configured', tone: 'warn' },
  IDLE: { label: 'On', tone: 'ok' },
  SYNCING: { label: 'Syncing now', tone: 'ok' },
  /** Stopped on purpose after a rejected token. A warning, not a cheerful "on". */
  AUTH_PARKED: { label: 'Stopped — token rejected', tone: 'bad' },
  STOPPED: { label: 'Stopped', tone: 'warn' },
});

/** What became of the last run. SKIPPED is deliberately not a failure. */
export const RUN_LABEL = Object.freeze({
  SUCCESS: { label: 'Success', tone: 'ok' },
  PARTIAL: { label: 'Incomplete', tone: 'warn' },
  FAILED: { label: 'Failed', tone: 'bad' },
  SKIPPED: { label: 'Skipped', tone: 'info' },
});

/**
 * "in 42 s", "3 min ago", or an honest absence.
 *
 * Signed on purpose: the status row shows both the last sync and the next one, and a reader should
 * not have to work out which side of now a timestamp is on.
 */
export function relative(iso, nowMs = Date.now()) {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const seconds = Math.round((at - nowMs) / 1000);
  const magnitude = Math.abs(seconds);
  const amount = magnitude < 60 ? `${magnitude} s`
    : magnitude < 3600 ? `${Math.round(magnitude / 60)} min`
      : `${Math.round(magnitude / 3600)} h`;
  if (magnitude < 5) return seconds >= 0 ? 'any moment' : 'just now';
  return seconds >= 0 ? `in ${amount}` : `${amount} ago`;
}

export const LINK_STATE = Object.freeze({
  UNMAPPED: { label: 'Unmapped', tone: 'info' },
  PROPOSED: { label: 'Proposed', tone: 'warn' },
  APPROVED: { label: 'Approved', tone: 'ok' },
  REJECTED: { label: 'Rejected', tone: 'info' },
  CONFLICT: { label: 'Conflict', tone: 'bad' },
});

/** A percentage, or an honest dash. `Number(null)` is 0 and finite, so the null check is first. */
export function pct(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${Number(value)}%`;
}

/**
 * A work amount: the converted hours AND the source string, never one without the other.
 *
 * `P1DT16H` is what OpenProject said; `40 h` is what that means on a stated basis. Showing only
 * the second would hide an assumption, and only the first would be unreadable.
 */
export function work(hours, raw) {
  if (hours == null && !raw) return '—';
  if (hours == null) return `${escape(raw)} <small>not convertible</small>`;
  const rounded = Math.round(Number(hours) * 100) / 100;
  return `${rounded} h${raw ? ` <small>${escape(raw)}</small>` : ''}`;
}

const day = iso => (iso ? new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' }) : '—');

/* ── the pieces ────────────────────────────────────────────────────────────────────────────── */

function headerMarkup(report) {
  const state = stateOf(report);
  const source = report.source ?? {};
  const project = report.project;
  const name = project ? `${project.name} (#${project.id})` : `Project ${report.projectId ?? '—'}`;
  return `<header class="ops-head">
      <div class="ops-head-main">
        <h2>${escape(name)}</h2>
        <p class="ops-head-sub">${escape(source.label ?? 'OpenProject')} ·
          API ${escape(report.apiVersion ?? 'v3')} ·
          ${escape(report.instance ?? '')}${project?.identifier ? ` · ${escape(project.identifier)}` : ''}</p>
      </div>
      <div class="ops-head-side">
        <span class="ci-chip" data-tone="${escape(state.tone)}"
          data-op-state="${escape(report.state ?? '')}">${escape(state.label)}</span>
        <button type="button" class="ci-button" data-action="refresh-schedule">Refresh Schedule</button>
      </div>
    </header>`;
}

/*
 * The standing provenance panel was REMOVED here at the user's request (Phase 9E).
 *
 * The claim it made is still made where it matters most: the read-only comparison table below
 * labels each row LIVE — OpenProject Cloud or SYNTHETIC — Primavera P6 demo data, and carries the
 * "Not a finding" caveat explaining why the difference between the two is not a measurement. So a
 * reader never sees a live number and a synthetic number side by side without being told which is
 * which — the statement simply sits next to the figures instead of above the whole screen.
 */

/**
 * The synchronisation status row.
 *
 * One line, six facts, and a button. It answers the question a reader of an auto-updating screen
 * actually has — "is this current, and how would I know?" — which is a different question from
 * "did the last request succeed".
 *
 * The distinctions it refuses to blur:
 *
 *  - AUTOMATIC SYNC OFF is not a failure. It is a configured choice, and it reads as one.
 *  - "last sync" is the last SUCCESSFUL one. A failed cycle changes "last result", never this.
 *  - "next sync" disappears when the worker is parked or off, rather than showing a time that
 *    will not arrive.
 *  - a SKIPPED run is reported as skipped. It is the honest answer to "why are there fewer runs
 *    than minutes" and it is not an error.
 */
export function syncRowMarkup(sync, nowMs) {
  if (!sync) {
    return `<div class="ops-sync" data-sync-state="unknown">
      <span class="ci-chip" data-tone="info">Sync status unknown</span>
      <span class="ops-sync-fact">The worker could not be asked. Refresh Schedule still
        reads OpenProject directly.</span></div>`;
  }
  const worker = WORKER_LABEL[sync.state] ?? { label: sync.state ?? 'Unknown', tone: 'info' };
  const last = sync.lastRun;
  const result = last?.runStatus ? RUN_LABEL[last.runStatus] ?? { label: last.runStatus, tone: 'info' }
    : null;
  /** Shown only while the worker will actually wake up again. */
  const nextDue = sync.enabled && sync.nextRunAt && !sync.parkedReason
    ? relative(sync.nextRunAt, nowMs) : null;
  const changed = last?.counts?.changed;

  const facts = [
    ['Automatic sync', sync.enabled
      ? `Every ${escape(sync.intervalSeconds)} s` : 'Disabled'],
    ['Last successful sync', sync.lastSuccessfulFetchAt
      ? `${escape(when(sync.lastSuccessfulFetchAt))}
         <small>${escape(relative(sync.lastSuccessfulFetchAt, nowMs) ?? '')}</small>`
      : 'Never'],
    ['Next scheduled sync', nextDue
      ? `${escape(nextDue)} <small>${escape(when(sync.nextRunAt))}</small>`
      : sync.enabled ? 'Not scheduled' : '—'],
    ['Last result', result
      ? `<span class="ci-chip" data-tone="${escape(result.tone)}"
           data-op-run="${escape(last.runStatus)}">${escape(result.label)}</span>
         <small>${escape(last.trigger ?? '')}${last.durationMs == null ? ''
    : ` · ${escape(last.durationMs)} ms`}</small>`
      : 'No run in this process'],
    ['Activities changed', changed == null
      ? '—' : `${escape(changed)} <small>last run</small>`],
  ];

  return `<div class="ops-sync" data-sync-state="${escape(sync.state ?? '')}"
      data-sync-enabled="${Boolean(sync.enabled)}">
      <div class="ops-sync-head">
        <span class="ci-chip" data-tone="${escape(worker.tone)}"
          data-op-worker="${escape(sync.state ?? '')}">Auto-sync: ${escape(worker.label)}</span>
        <button type="button" class="ci-button ci-button--quiet"
          data-action="sync-now">Sync Now</button>
      </div>
      <dl class="ops-sync-facts">${facts.map(([label, value]) =>
    `<div><dt>${escape(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>
      ${sync.parkedReason ? `<p class="ci-status" data-state="error"
        data-op-parked="true">${escape(sync.parkedReason)}</p>` : ''}
      ${sync.configuredReason ? `<p class="ci-status" data-state="error"
        >${escape(sync.configuredReason)}</p>` : ''}
      ${sync.intervalClamped ? `<p class="ci-card-note">${escape(sync.intervalClamped)}</p>` : ''}
      ${sync.enableHint ? `<p class="ci-card-note">${escape(sync.enableHint)}</p>` : ''}
      <p class="ci-card-note ops-sync-scope">${escape(sync.scope ?? '')}</p>
    </div>`;
}

/** Shown whenever the rows on screen are older than the last attempt to refresh them. */
function staleMarkup(report) {
  if (!report.stale) return '';
  return `<p class="ci-status" data-state="error" data-op-stale="true">
      <strong>Stale.</strong> ${escape(report.staleReason ?? '')}</p>`;
}

function summaryMarkup(report) {
  const basis = report.duration;
  /**
   * Written out rather than generated, because each figure means something different and two of
   * them look interchangeable until you read them: "activities shown" is what we hold, and
   * "collection total" is what OpenProject says exists. They can disagree.
   */
  const rows = [
    ['Activities shown', escape(num(report.activities?.length ?? null))],
    ['Collection total <small>reported by OpenProject</small>',
      escape(num(report.collectionTotal ?? report.total ?? null))],
    ['Last successful read', `${escape(when(report.lastSuccessfulFetchAt))}`],
    ['This request', report.httpStatus == null ? '—'
      : `HTTP ${escape(report.httpStatus)} <small>${escape(report.elapsedMs ?? '—')} ms${
        report.pages ? ` · ${escape(report.pages)} page(s)` : ''}</small>`],
    ...(basis ? [['Work conversion', `${escape(basis.hoursPerDay)} h/day
      <small>${escape(basis.note ?? '')}${basis.instanceNote
    ? ` ${basis.instanceNote}` : ''}</small>`]] : []),
    ...(report.counts ? [['Last refresh',
      `${escape(report.counts.new)} new · ${escape(report.counts.changed)} changed ·
       ${escape(report.counts.unchanged)} unchanged`]] : []),
  ];
  return `<dl class="ops-facts">${rows.map(([label, value]) =>
    `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
}

/** What was asked of OpenProject, and why. The default collection is filtered; that matters. */
function filtersMarkup(report) {
  const applied = report.filtersApplied ?? [];
  if (!applied.length) return '';
  return `<details class="ops-filters">
      <summary>${escape(applied.length)} explicit query parameter(s)</summary>
      <ul class="ci-ws-list">${applied.map(entry =>
    `<li><code>${escape(entry.name)}=${escape(entry.value)}</code> — ${escape(entry.reason)}</li>`).join('')}</ul>
    </details>`;
}

function activityTableMarkup(report, selected) {
  const activities = report.activities ?? [];
  if (!activities.length) {
    return `<p class="ci-card-note">No activities stored yet. <strong>Refresh Schedule</strong>
      reads the project from OpenProject. An empty result after a successful read would mean the
      project genuinely holds no work packages — which is a different statement from this one.</p>`;
  }
  const linkByActivity = new Map((report.links ?? [])
    .map(link => [String(link.externalId), link]));
  return `<table class="ci-table ci-table--rows ops-table">
      <caption>Every row read from OpenProject API v3. Select one for its detail.</caption>
      <thead><tr>
        <th scope="col">ID</th><th scope="col" class="ops-name">Activity</th>
        <th scope="col">Status</th>
        <th scope="col">Start</th><th scope="col">Finish</th><th scope="col">Progress</th>
        <th scope="col">Remaining work</th><th scope="col">Last updated</th><th scope="col">Link</th>
      </tr></thead>
      <tbody>${activities.map(entry => {
    const link = linkByActivity.get(String(entry.externalActivityId));
    const linkState = link ? LINK_STATE[link.status] ?? { label: link.status, tone: 'info' }
      : LINK_STATE.UNMAPPED;
    return `<tr data-activity="${escape(entry.externalActivityId)}" tabindex="0"
        class="${selected === String(entry.externalActivityId) ? 'is-selected' : ''}">
        <th scope="row">#${escape(entry.externalActivityId)}</th>
        <td class="ops-name">${escape(entry.activityName ?? '—')}
          <small>${escape(entry.activityType ?? '')}</small></td>
        <td>${escape(entry.status ?? '—')}</td>
        <td>${escape(entry.plannedStart ?? '—')}</td>
        <td>${escape(entry.plannedFinish ?? '—')}</td>
        <td>${escape(pct(entry.reportedProgressPct))}</td>
        <td>${work(entry.remainingHours, entry.remainingTimeRaw)}</td>
        <td>${escape(when(entry.sourceUpdatedAt))}
          <small>rev ${escape(entry.sourceRevision ?? '—')}</small></td>
        <td><span class="ci-chip" data-tone="${escape(linkState.tone)}">${escape(linkState.label)}</span></td>
      </tr>`;
  }).join('')}</tbody>
    </table>`;
}

/** One contextual panel. Not a modal, and never a second one on top of it. */
function detailMarkup(report, selected, detail) {
  if (!selected) {
    return `<p class="ci-card-note ops-detail-empty">Select an activity to see its detail,
      its change history, and the candidate link to a synthetic P6 activity.</p>`;
  }
  if (!detail) {
    return `<p class="ci-status" data-state="loading">Reading work package #${escape(selected)}…</p>`;
  }
  const activity = detail.activity;
  if (!activity) {
    return `<div class="ops-detail">
        <h3>#${escape(selected)}</h3>
        <p class="ci-status" data-state="error">${escape(detail.reason
      ?? 'This work package could not be read.')}</p></div>`;
  }
  const facts = [
    ['External activity ID', `#${escape(activity.externalActivityId)}`],
    ['Type', escape(activity.activityType ?? '—')],
    ['Status', escape(activity.status ?? '—')],
    ['Planned start', escape(activity.plannedStart ?? '—')],
    ['Planned finish', escape(activity.plannedFinish ?? '—')],
    ['Progress', escape(pct(activity.reportedProgressPct))],
    ['Estimated work', work(activity.estimatedHours, activity.estimatedTimeRaw)],
    ['Remaining work', work(activity.remainingHours, activity.remainingTimeRaw)],
    ['Source revision', `${escape(activity.sourceRevision ?? '—')}
      <small>lockVersion</small>`],
    ['Updated in OpenProject', escape(when(activity.sourceUpdatedAt))],
    ['Parent', activity.parentExternalId
      ? `#${escape(activity.parentExternalId)} ${escape(activity.parentName ?? '')}
         <small>from _links.parent</small>`
      : 'None <small>no _links.parent; not inferred from the name or the id</small>'],
    ['Dependencies', activity.dependencies == null
      ? 'Not known <small>the relations API could not be read</small>'
      : activity.dependencies.length === 0
        ? 'None <small>the relations API returned no relation</small>'
        : activity.dependencies.map(entry =>
          `${escape(entry.type ?? 'relation')} → #${escape(entry.toExternalId ?? '?')}`).join(', ')],
  ];
  const check = activity.durationCheck;
  return `<div class="ops-detail">
      <h3>#${escape(activity.externalActivityId)} ${escape(activity.activityName ?? '')}</h3>
      ${detail.fromSnapshot ? `<p class="ci-status" data-state="error">OpenProject could not be
        read just now, so this is the stored snapshot.</p>` : ''}
      ${activity.description ? `<p class="ops-description">${escape(activity.description)}</p>` : ''}
      <dl class="ops-detail-facts">${facts.map(([label, value]) =>
    `<div><dt>${escape(label)}</dt><dd>${value}</dd></div>`).join('')}</dl>
      ${check ? `<p class="ci-card-note ops-check" data-agrees="${check.agrees}">
        ${escape(check.note)}</p>` : ''}
      ${activity.sourcePath ? `<p class="ops-open"><a href="${escape(report.instance ?? '')}${
    escape(activity.sourcePath)}" target="_blank" rel="noreferrer noopener">Open #${
    escape(activity.externalActivityId)} in OpenProject</a></p>` : ''}
      ${mappingMarkup(detail)}
      ${changesMarkup(detail.changes ?? [])}
    </div>`;
}

/**
 * The candidate link, its evidence, and the comparison approval unlocks.
 *
 * The evidence is shown at the same rank as the candidate, because "the names match" is the whole
 * basis and a reviewer who cannot see that has nothing to review.
 */
function mappingMarkup(detail) {
  const link = detail.link;
  const candidates = detail.candidates ?? [];
  if (!link && !candidates.length) {
    return `<section class="ops-mapping">
        <h4>Mapping to synthetic P6</h4>
        <p class="ci-card-note">No candidate. Nothing in the synthetic P6 data resembles this
          activity closely enough to propose a link.</p></section>`;
  }
  const state = link ? LINK_STATE[link.status] ?? { label: link.status, tone: 'info' }
    : LINK_STATE.UNMAPPED;
  const comparison = detail.comparison;
  return `<section class="ops-mapping">
      <h4>Mapping to synthetic P6
        <span class="ci-chip" data-tone="${escape(state.tone)}">${escape(state.label)}</span></h4>
      <div class="ops-chain">
        <span class="ops-chain-node" data-kind="live">OpenProject #${escape(
    link?.externalId ?? detail.activity?.externalActivityId ?? '?')}</span>
        <span class="ops-chain-arrow" aria-hidden="true">↓</span>
        <span class="ops-chain-node" data-kind="candidate">Candidate mapping
          <small>${escape(link?.basis ?? candidates[0]?.basis ?? '')}</small></span>
        <span class="ops-chain-arrow" aria-hidden="true">↓</span>
        <span class="ops-chain-node" data-kind="synthetic">Synthetic P6 ${escape(
    link?.targetActivityId ?? candidates[0]?.targetActivityId ?? '?')}</span>
      </div>
      <p class="ci-card-note">${escape(link?.evidence?.detail ?? candidates[0]?.detail ?? '')}</p>
      <p class="ci-card-note"><strong>Effect of approval:</strong> ${escape(
    candidates[0]?.effect ?? 'A read-only comparison. No value is copied in either direction.')}</p>
      ${link?.status === 'PROPOSED' ? `<div class="ci-actions">
        <button type="button" class="ci-button" data-link-action="approve"
          data-link="${escape(link.id)}">Approve mapping</button>
        <button type="button" class="ci-button ci-button--quiet" data-link-action="reject"
          data-link="${escape(link.id)}">Reject</button>
        <span class="ci-actions-note" role="status"></span>
      </div>` : ''}
      ${link?.decidedAt ? `<p class="ci-card-note">${escape(link.status)} by
        ${escape(link.decidedBy ?? 'unknown')} on ${escape(when(link.decidedAt))}.
        ${escape(link.decisionNote ?? '')}</p>` : ''}
      ${comparisonMarkup(comparison)}
    </section>`;
}

/** The side-by-side. Each side names its own system and kind; the caveat is not optional. */
function comparisonMarkup(comparison) {
  if (!comparison) return '';
  const sign = comparison.differencePoints == null ? ''
    : comparison.differencePoints > 0 ? '+' : '';
  return `<div class="ops-comparison">
      <table class="ci-table">
        <caption>Read-only comparison. Neither system has been written to.</caption>
        <thead><tr><th scope="col">Source</th><th scope="col">Activity</th>
          <th scope="col">Progress</th><th scope="col">As of</th></tr></thead>
        <tbody>
          <tr><th scope="row"><span class="ci-chip" data-tone="ok">LIVE</span>
            ${escape(comparison.live.system)}</th>
            <td>#${escape(comparison.live.id)} ${escape(comparison.live.name ?? '')}</td>
            <td>${escape(pct(comparison.live.progressPct))}</td>
            <td>${escape(when(comparison.live.asOf))}</td></tr>
          <tr><th scope="row"><span class="ci-chip" data-tone="info">SYNTHETIC</span>
            ${escape(comparison.synthetic.system)}</th>
            <td>${escape(comparison.synthetic.id)} ${escape(comparison.synthetic.name ?? '')}</td>
            <td>${escape(pct(comparison.synthetic.progressPct))}</td>
            <td>${escape(comparison.synthetic.asOf ?? '—')}</td></tr>
        </tbody>
        <tfoot><tr><th scope="row">Difference</th><td></td>
          <td data-op-difference="${escape(comparison.differencePoints ?? '')}">${
    comparison.differencePoints == null ? 'Not comparable'
      : `${sign}${escape(comparison.differencePoints)} percentage points`}</td>
          <td></td></tr></tfoot>
      </table>
      <p class="ci-card-note ops-caveat"><strong>Not a finding.</strong>
        ${escape(comparison.caveat)}</p>
      <p class="ci-card-note">${escape(comparison.writeBack)}</p>
    </div>`;
}

/** The change history for one activity, newest first, with before and after. */
function changesMarkup(changes) {
  if (!changes.length) {
    return `<section class="ops-changes"><h4>Change history</h4>
      <p class="ci-card-note">No changes recorded. The first read of an activity establishes a
        baseline and is not reported as a change.</p></section>`;
  }
  return `<section class="ops-changes">
      <h4>Change history</h4>
      <table class="ci-table">
        <thead><tr><th scope="col">Detected</th><th scope="col">Change</th>
          <th scope="col">Field</th><th scope="col">Before</th><th scope="col">After</th>
          <th scope="col">Revision</th></tr></thead>
        <tbody>${changes.map(entry => {
    const label = changeLabel(entry.kind);
    return `<tr><td>${escape(when(entry.detectedAt))}</td>
        <td><span class="ci-chip" data-tone="${escape(label.tone)}"
          data-op-change="${escape(entry.kind)}">${escape(label.label)}</span></td>
        <td>${escape(entry.field ?? '—')}</td>
        <td>${escape(entry.previous ?? '—')}</td>
        <td>${escape(entry.current ?? '—')}</td>
        <td>${escape(entry.previousRevision ?? '—')} → ${escape(entry.currentRevision ?? '—')}</td>
      </tr>`;
  }).join('')}</tbody>
      </table>
    </section>`;
}

/** Warnings from the adapter: pagination, unreadable durations, unsafe links. */
function warningsMarkup(warnings) {
  if (!warnings?.length) return '';
  return `<ul class="ci-findings ops-warnings">${warnings.map(entry => `
      <li data-tone="warn"><strong>${escape(String(entry.kind).replace(/_/g, ' ').toLowerCase())}</strong>
        ${escape(entry.detail ?? '')}</li>`).join('')}</ul>`;
}

/* ── the screen ────────────────────────────────────────────────────────────────────────────── */

export function installOpenProjectSchedule(host, {
  fetchJson = request,
  /** Injected so a test can drive the stream and the clock without a browser or a server. */
  eventSourceImpl = globalThis.EventSource,
  setIntervalImpl = globalThis.setInterval, clearIntervalImpl = globalThis.clearInterval,
  /**
   * How often the STATUS row is refreshed.
   *
   * A local read of in-process state — it makes no OpenProject request — so it is cheap, and it
   * does two jobs: it keeps "next sync in 24 s" honest, and it is the fallback that catches a
   * completion this tab missed because its event stream was asleep (see `syncStatus`).
   */
  statusIntervalMs = 10_000,
} = {}) {
  const root = document.createElement('div');
  root.className = 'ops-root';
  host.append(root);

  let report = null;
  let error = null;
  let busy = false;
  let selected = null;
  let detail = null;
  let note = '';
  let sync = null;
  /** The last completion this tab has already loaded, so an event is never acted on twice. */
  let appliedRunAt = null;
  let stream = null;
  let statusTimer = null;
  let destroyed = false;

  /**
   * What the reader is in the middle of, captured before the markup is replaced.
   *
   * This screen renders by assigning `innerHTML`, which is fine for a click but wrong for a
   * BACKGROUND update: a refresh that arrives while somebody is reading halfway down a wide table
   * would otherwise jump them back to the top-left and close whatever they had expanded. The
   * selected activity survives already (it is state, not markup); these three do not.
   */
  function captureView() {
    const scroller = root.closest('.ci-workspaces');
    return {
      pageTop: scroller?.scrollTop ?? null,
      tableLeft: root.querySelector('.ops-table-pane')?.scrollLeft ?? null,
      filtersOpen: root.querySelector('.ops-filters')?.open ?? null,
    };
  }

  function restoreView(view) {
    if (!view) return;
    const scroller = root.closest('.ci-workspaces');
    if (view.pageTop != null && scroller) scroller.scrollTop = view.pageTop;
    const pane = root.querySelector('.ops-table-pane');
    if (view.tableLeft != null && pane) pane.scrollLeft = view.tableLeft;
    const filters = root.querySelector('.ops-filters');
    if (view.filtersOpen != null && filters) filters.open = view.filtersOpen;
  }

  function render() {
    if (!report && !error) {
      root.innerHTML = '<p class="ci-status" data-state="loading">Reading the stored OpenProject schedule…</p>';
      return;
    }
    if (error) {
      root.innerHTML = `<p class="ci-status" data-state="error">${escape(error)}</p>
        <div class="ci-actions"><button type="button" class="ci-button"
          data-action="refresh-schedule">Refresh Schedule</button></div>`;
      return;
    }
    // NOT_READ and NOT_CONFIGURED are states, not failures: neither has a reason worth printing
    // as an error, and NOT_READ has no reason at all.
    const broken = report.state
      && !['CONNECTED', 'PARTIAL', 'NOT_READ'].includes(report.state);
    const view = captureView();
    root.innerHTML = `
      ${headerMarkup(report)}
      ${syncRowMarkup(sync, Date.now())}
      ${staleMarkup(report)}
      ${report.reason && broken
    ? `<p class="ci-status" data-state="error">${escape(report.reason)}</p>` : ''}
      ${summaryMarkup(report)}
      ${filtersMarkup(report)}
      ${note ? `<p class="ci-actions-note" role="status">${escape(note)}</p>` : ''}
      ${warningsMarkup(report.warnings)}
      <div class="ops-body">
        <section class="ops-table-pane">${activityTableMarkup(report, selected)}</section>
        <section class="ops-detail-pane">${detailMarkup(report, selected, detail)}</section>
      </div>`;
    const button = root.querySelector('[data-action="refresh-schedule"]');
    if (button && busy) { button.disabled = true; button.textContent = 'Reading OpenProject…'; }
    const syncButton = root.querySelector('[data-action="sync-now"]');
    if (syncButton && (busy || sync?.running)) {
      syncButton.disabled = true;
      syncButton.textContent = 'Syncing…';
    }
    restoreView(view);
  }

  /**
   * The stored snapshot. Opening the tab must not poll an external system.
   *
   * `background: true` is a reload triggered by the worker rather than by the reader. It must not
   * render in between — the "Reading…" placeholder would flash the table away under somebody's
   * cursor — so the caller renders once, after.
   */
  async function load({ background = false } = {}) {
    try {
      report = await fetchJson(`${OP_API}/work-packages`);
      error = null;
      if (!appliedRunAt) appliedRunAt = report.lastSuccessfulFetchAt ?? null;
    } catch (cause) {
      // Ours, not OpenProject's: the construction API is what failed here, and blaming the
      // upstream for our own server being down is the mistake Phase 7A already made once.
      error = `The construction API could not be reached, so the OpenProject connection is `
        + `unknown: ${cause?.message ?? cause}`;
    }
    if (!background) render();
  }

  /** Go and read OpenProject now. */
  async function refresh() {
    busy = true;
    note = '';
    render();
    try {
      report = await fetchJson(`${OP_API}/refresh`, { method: 'POST', body: {} });
      error = null;
      const counts = report.counts;
      note = counts
        ? `${counts.new} new · ${counts.changed} changed · ${counts.unchanged} unchanged. `
          + 'A read only: nothing was written to SYNCHRO 4D, P6, SAP or ACC.'
        : '';
      if (selected) await loadDetail(selected);
    } catch (cause) {
      error = `The construction API could not be reached, so the OpenProject connection is `
        + `unknown: ${cause?.message ?? cause}`;
    }
    busy = false;
    render();
  }

  /**
   * Load one activity's detail.
   *
   * On a BACKGROUND reload the pane keeps showing the activity it has while the new copy arrives.
   * Blanking it to "Reading work package #38…" every 60 seconds would make the detail pane
   * unreadable on a screen that is supposed to update quietly.
   */
  async function loadDetail(id, { background = false } = {}) {
    selected = String(id);
    if (!background) { detail = null; render(); }
    try {
      detail = await fetchJson(`${OP_API}/work-packages/${selected}`);
    } catch (cause) {
      detail = { activity: null, reason: `Could not read work package #${selected}: `
        + `${cause?.message ?? cause}` };
    }
    if (!background) render();
  }

  async function decide(linkId, verb) {
    note = '';
    try {
      const result = await fetchJson(`${OP_API}/links/${linkId}/${verb}`,
        { method: 'POST', body: {} });
      note = `${result.link.status}. ${result.effect}`;
      if (selected) await loadDetail(selected);
      else render();
    } catch (cause) {
      // The server's own refusal, in its own words — including which role may do it instead.
      note = `${verb === 'approve' ? 'Approval' : 'Rejection'} refused: ${cause?.message ?? cause}`;
      render();
    }
  }

  /* ── Phase 8B: the live link to the worker ───────────────────────────────────────────────── */

  /**
   * Read the worker's status. No OpenProject request is made by this.
   *
   * It also acts as the FALLBACK for a missed notification. A browser whose event stream was
   * asleep — a backgrounded tab, a proxy that dropped an idle connection before the reconnect —
   * would otherwise sit on stale rows indefinitely. Comparing the server's last successful sync
   * against the one this tab has already applied catches that without a second poller and without
   * ever calling OpenProject from the browser.
   */
  async function syncStatus({ allowReload = true } = {}) {
    if (destroyed) return;
    let next;
    try {
      next = await fetchJson(`${SYNC_API}/status`);
    } catch {
      // Our own API, not OpenProject's. Nothing is claimed about the connection.
      sync = null;
      render();
      return;
    }
    sync = next;
    const serverAt = next.lastSuccessfulFetchAt ?? null;
    if (allowReload && serverAt && appliedRunAt && serverAt !== appliedRunAt) {
      await applyUpdate({ reason: 'caught up on a synchronisation this tab had not seen' });
      return;
    }
    if (serverAt && !appliedRunAt) appliedRunAt = report?.lastSuccessfulFetchAt ?? serverAt;
    render();
  }

  /**
   * Re-read the stored schedule after the backend synchronised.
   *
   * It re-reads OUR OWN endpoint, never OpenProject: the backend is the single source of
   * synchronised data and the browser has no business holding a credential. The selected activity
   * is reloaded if there is one, so the detail pane follows the table instead of going stale
   * behind it — and nothing here opens a dialog, moves a camera or steals focus.
   */
  async function applyUpdate({ reason = null } = {}) {
    await load({ background: true });
    if (selected) await loadDetail(selected, { background: true });
    appliedRunAt = report?.lastSuccessfulFetchAt ?? appliedRunAt;
    if (reason) note = `Updated automatically — ${reason}.`;
    render();
  }

  /**
   * Subscribe to the completion stream.
   *
   * `EventSource` and not a WebSocket: the traffic is one-directional and tiny, and the browser
   * reconnects by itself with backoff, so a dropped connection needs no code here. The events
   * carry ids and counts; the data comes from the read endpoint above.
   */
  function listen() {
    if (!eventSourceImpl || destroyed) return;
    try {
      stream = new eventSourceImpl(`${API_BASE}${SYNC_EVENTS}`);
    } catch {
      // No stream is not an error: the 10-second status poll above already catches up.
      stream = null;
      return;
    }
    stream.addEventListener(SYNC_EVENT, event => {
      if (destroyed) return;
      let payload = null;
      try { payload = JSON.parse(event.data); } catch { payload = null; }
      const changed = payload?.changedActivities ?? 0;
      const created = payload?.newActivities ?? 0;
      note = `Synchronised automatically at ${when(payload?.completedAt)} — `
        + `${created} new · ${changed} changed. A read only: nothing was written to SYNCHRO 4D, `
        + 'P6, SAP or ACC.';
      void applyUpdate();
      void syncStatus({ allowReload: false });
    });
    stream.addEventListener('openproject-sync-hello', event => {
      if (destroyed) return;
      try { sync = JSON.parse(event.data).status ?? sync; } catch { /* keep what we have */ }
      render();
    });
  }

  /** Sync Now. The SAME worker and the same lock the timer uses — the server guarantees that. */
  async function syncNow() {
    busy = true;
    note = '';
    render();
    try {
      const outcome = await fetchJson(`${SYNC_API}/run`, { method: 'POST', body: {} });
      sync = outcome.status ?? sync;
      const run = outcome.run ?? {};
      note = outcome.coalesced
        ? 'A synchronisation was already running, so this joined it rather than starting a '
          + 'second one.'
        : outcome.throttled || outcome.skipped
          ? run.reason ?? 'Nothing was run.'
          : run.counts
            ? `${run.counts.new} new · ${run.counts.changed} changed · `
              + `${run.counts.unchanged} unchanged. ${outcome.effect ?? ''}`
            : run.reason ?? 'The synchronisation reported no counts.';
      await applyUpdate();
    } catch (cause) {
      // The server's own refusal, in its own words — including which role may do it instead.
      note = `Sync Now refused: ${cause?.message ?? cause}`;
    }
    busy = false;
    render();
  }

  root.onclick = event => {
    const syncButton = event.target.closest('[data-action="sync-now"]');
    if (syncButton) { void syncNow(); return; }
    const refreshButton = event.target.closest('[data-action="refresh-schedule"]');
    if (refreshButton) { void refresh(); return; }
    const linkButton = event.target.closest('[data-link-action]');
    if (linkButton) {
      void decide(linkButton.dataset.link, linkButton.dataset.linkAction);
      return;
    }
    const row = event.target.closest('tr[data-activity]');
    if (row) void loadDetail(row.dataset.activity);
  };

  root.onkeydown = event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest?.('tr[data-activity]');
    if (!row) return;
    event.preventDefault();
    void loadDetail(row.dataset.activity);
  };

  render();
  /*
   * The stored view first, then the worker's status, then the stream.
   *
   * In that order on purpose: the rows and their date are what the reader came for, the status row
   * is an annotation on them, and neither should wait on a connection that may not be available.
   */
  const ready = load().then(() => syncStatus({ allowReload: false })).then(() => {
    listen();
    statusTimer = setIntervalImpl?.(() => { void syncStatus(); }, statusIntervalMs);
    statusTimer?.unref?.();
  });

  return {
    root,
    get report() { return report; },
    get detail() { return detail; },
    get selected() { return selected; },
    get sync() { return sync; },
    select: loadDetail,
    refresh,
    reload: load,
    syncNow,
    syncStatus,
    ready,
    /**
     * Hang up before leaving.
     *
     * An `EventSource` left open keeps reconnecting for the life of the page, and an interval left
     * running keeps asking a server for a panel nobody is looking at.
     */
    destroy() {
      destroyed = true;
      if (statusTimer != null) clearIntervalImpl?.(statusTimer);
      statusTimer = null;
      try { stream?.close(); } catch { /* already closed */ }
      stream = null;
      root.remove();
    },
  };
}
