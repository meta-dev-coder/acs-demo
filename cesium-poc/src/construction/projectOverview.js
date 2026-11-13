/**
 * Project Overview — what needs attention today.
 *
 * The landing screen, and deliberately not a wall of KPI cards. Three questions in order:
 * where does the project stand, what is waiting on somebody, and are the sources actually
 * connected. Every number is a count of persisted records, and every actionable row opens the
 * workflow that clears it.
 *
 * Two things it refuses to do:
 *
 *   IT DOES NOT ESTIMATE A DELAY AGAINST A BASELINE. This OpenProject instance stores no
 *   baseline, so "overdue" is measured against the current planned finish and says so. A number
 *   captioned "days late" that was computed against a moving target is worse than no number.
 *
 *   IT DOES NOT SHOW FINANCIALS. There is no ERP adapter in this build, so the financial source
 *   reads "Not connected" rather than borrowing a figure from the synthetic demo data.
 */
import { escape, num, request, when } from './ciClient.js';

/** How a connected source reads. The same tone vocabulary as everywhere else. */
export const SOURCE_TONE = Object.freeze({
  IDLE: { label: 'Connected', tone: 'ok' },
  CHECKING: { label: 'Checking', tone: 'ok' },
  SYNCING: { label: 'Syncing', tone: 'ok' },
  CONVERTING: { label: 'Converting', tone: 'warn' },
  DISABLED: { label: 'Auto-sync off', tone: 'info' },
  NOT_CONFIGURED: { label: 'Not configured', tone: 'warn' },
  AUTH_PARKED: { label: 'Token rejected', tone: 'bad' },
  STOPPED: { label: 'Stopped', tone: 'warn' },
  NOT_CONNECTED: { label: 'Not connected', tone: 'info' },
  UNKNOWN: { label: 'Unknown', tone: 'info' },
});

/** Cut on a word boundary, with an ellipsis, so a row never ends mid-word. */
export function clip(text, max) {
  const value = String(text ?? '').trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.]$/, '')}…`;
}

export const SEVERITY = Object.freeze({
  HIGH: { label: 'High', tone: 'bad' },
  MEDIUM: { label: 'Medium', tone: 'warn' },
  LOW: { label: 'Low', tone: 'info' },
});

/** A figure plus the workflow that clears it. A KPI nobody can act on is decoration. */
function metric(label, value, { go = null, tone = null, hint = null } = {}) {
  const body = `<dt>${escape(label)}${hint ? `<small>${escape(hint)}</small>` : ''}</dt>
      <dd${tone ? ` data-tone="${escape(tone)}"` : ''}>${escape(num(value))}</dd>`;
  return go
    ? `<div><button type="button" class="po-metric" data-go="${escape(go)}">${body}</button></div>`
    : `<div class="po-metric po-metric--static">${body}</div>`;
}

function statusMarkup(data) {
  const s = data.schedule;
  const b = data.bim;
  const w = data.workflow;
  return `<section class="po-card">
      <h3>Project status <small>${escape(num(s.total))} OpenProject activities</small></h3>
      <dl class="po-metrics">
        ${metric('Completed', s.completed, { hint: 'source reports 100%' })}
        ${metric('In progress', s.inProgress)}
        ${metric('Not started', s.notStarted)}
        ${metric('Past planned finish', s.overdue, { tone: s.overdue ? 'warn' : null,
    hint: 'no baseline stored' })}
      </dl>
      <h3>BIM coordination</h3>
      <dl class="po-metrics">
        ${metric('Need a BIM mapping', b.activitiesNeedingMapping,
    { go: 'lifecycle', tone: b.activitiesNeedingMapping ? 'warn' : null })}
        ${metric('Mapped and approved', b.activitiesWithApprovedMapping)}
        ${metric('Mappings awaiting a decision', b.mappingsAwaitingDecision,
    { go: 'lifecycle', tone: b.mappingsAwaitingDecision ? 'warn' : null })}
        ${metric('Accepted model', b.acceptedVersion?.elementCount ?? 0,
    { go: 'bim', hint: b.acceptedVersion ? `${b.acceptedVersion.label} elements` : 'none' })}
      </dl>
      <h3>Waiting on somebody</h3>
      <dl class="po-metrics">
        ${metric('Progress awaiting verification', w.progressAwaitingVerification,
    { go: 'approvals', tone: w.progressAwaitingVerification ? 'warn' : null })}
        ${metric('Approvals pending', w.approvalsPending,
    { go: 'approvals', tone: w.approvalsPending ? 'warn' : null })}
        ${metric('Status/progress conflicts', w.statusProgressConflicts,
    { go: 'lifecycle', tone: w.statusProgressConflicts ? 'bad' : null,
      hint: 'source disagrees with itself' })}
      </dl>
      <p class="ci-card-note">${escape(s.overdueBasis)}</p>
    </section>`;
}

function attentionMarkup(data) {
  const rows = data.needsAttention ?? [];
  if (!rows.length) {
    return `<section class="po-card">
        <h3>Needs attention</h3>
        <p class="ci-card-note">Nothing is waiting. Every activity has the schedule information
          it needs, an approved BIM mapping, and no pending verification or approval.</p>
      </section>`;
  }
  return `<section class="po-card po-attention">
      <h3>Needs attention
        <small>${escape(num(data.needsAttentionTotal))} item(s)${
  rows.length < data.needsAttentionTotal ? `, showing ${escape(rows.length)}` : ''}</small></h3>
      <table class="ci-table ci-table--rows po-table">
        <thead><tr>
          <th scope="col">Severity</th><th scope="col">Activity</th>
          <th scope="col" class="ci-col--text">Issue</th>
          <th scope="col" class="ci-col--text">Responsible</th>
          <th scope="col" class="ci-col--text">Next action</th>
        </tr></thead>
        <tbody>${rows.map(row => {
    const sev = SEVERITY[row.severity] ?? { label: row.severity, tone: 'info' };
    return `<tr data-wp="${escape(row.workPackageId)}" tabindex="0">
          <th scope="row"><span class="ci-chip" data-tone="${escape(sev.tone)}"
            data-severity="${escape(row.severity)}">${escape(sev.label)}</span></th>
          <td>#${escape(row.workPackageId)}
            <small>${escape(clip(row.subject, 40))}</small></td>
          <td class="ci-col--text">${escape(row.problem)}
            <small>${escape(clip(row.evidence, 90))}</small></td>
          <td class="ci-col--text">${escape(row.role)}</td>
          <td class="ci-col--text"><small>${escape(clip(row.action, 120))}</small></td>
        </tr>`;
  }).join('')}</tbody>
      </table>
      <p class="ci-card-note">Select a row to open that activity's lifecycle.</p>
    </section>`;
}

function sourcesMarkup(data) {
  const entries = [
    ['OpenProject', data.sources.openProject],
    ['Speckle', data.sources.speckle],
    ['Financial ERP', data.sources.financial],
  ];
  return `<section class="po-card">
      <h3>Connected sources</h3>
      <ul class="po-sources">${entries.map(([name, source]) => {
    const tone = SOURCE_TONE[source.state] ?? SOURCE_TONE.UNKNOWN;
    return `<li>
          <span class="ci-chip" data-tone="${escape(tone.tone)}"
            data-source-state="${escape(source.state)}">${escape(tone.label)}</span>
          <strong>${escape(name)}</strong>
          <small>${source.lastSuccessAt
    ? `last synchronised ${escape(when(source.lastSuccessAt))}`
    : escape(source.note ?? 'never synchronised')}</small>
          ${source.parked ? `<em>${escape(source.parked)}</em>` : ''}
        </li>`;
  }).join('')}</ul>
      <p class="ci-card-note">${escape(data.sources.financial.note ?? '')}</p>
    </section>`;
}

function decisionsMarkup(data) {
  const rows = data.recentDecisions ?? [];
  if (!rows.length) {
    return `<section class="po-card"><h3>Recent decisions</h3>
      <p class="ci-card-note">No mapping approvals, verifications or synchronisation outcomes
        have been recorded yet.</p></section>`;
  }
  return `<section class="po-card">
      <h3>Recent decisions</h3>
      <ul class="po-decisions">${rows.map(row => `<li>
        <span class="po-when">${escape(when(row.at))}</span>
        <strong>${escape(String(row.event).replace(/_/g, ' ').toLowerCase())}</strong>
        <small>${escape(row.subject ?? '')} — ${escape(clip(row.result, 70))}</small>
        <em>${escape(row.actor ?? '')}</em>
      </li>`).join('')}</ul>
    </section>`;
}

export function installProjectOverview(host, {
  fetchJson = request,
  onNavigate = null,
  selection = null,
} = {}) {
  const root = document.createElement('div');
  root.className = 'po-root';
  host.append(root);

  let data = null;
  let error = null;

  function render() {
    if (error) {
      root.innerHTML = `<p class="ci-status" data-state="error">${escape(error)}</p>`;
      return;
    }
    if (!data) {
      root.innerHTML = '<p class="ci-status" data-state="loading">Reading the project…</p>';
      return;
    }
    root.innerHTML = `
      ${statusMarkup(data)}
      ${attentionMarkup(data)}
      <div class="po-split">
        ${sourcesMarkup(data)}
        ${decisionsMarkup(data)}
      </div>`;
  }

  async function load() {
    try {
      data = await fetchJson('/lifecycle/overview');
      error = null;
    } catch (cause) {
      // Ours, not a source's: the construction API is what failed here.
      error = `The construction API could not be reached, so the project status is unknown: `
        + `${cause?.message ?? cause}`;
    }
    render();
  }

  root.onclick = event => {
    const row = event.target.closest('tr[data-wp]');
    if (row) {
      // The whole point of the shared context: the lifecycle opens on THIS activity.
      selection?.set({ workPackageId: row.dataset.wp });
      onNavigate?.('lifecycle');
      return;
    }
    const go = event.target.closest('[data-go]')?.dataset.go;
    if (go) onNavigate?.(go);
  };

  root.onkeydown = event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest?.('tr[data-wp]');
    if (!row) return;
    event.preventDefault();
    selection?.set({ workPackageId: row.dataset.wp });
    onNavigate?.('lifecycle');
  };

  render();
  const ready = load();
  return { root, get data() { return data; }, reload: load, ready,
    activate() { void load(); },
    destroy() { root.remove(); } };
}
