/**
 * Sync History & Audit — four subtabs over what the earlier phases persisted.
 *
 * Compact on purpose: a filter row, a table, a detail drawer. No KPI cards, because every figure
 * here belongs to a row rather than to a headline, and a card of totals above a table of the same
 * totals is the same information twice.
 *
 * NOTHING IS INVENTED. Where a stored row carries no actor or no correlation id, the cell reads
 * "Not recorded" — those columns did not exist when the row was written, and a plausible-looking
 * value in an audit trail is worse than a gap.
 */
import { escape, num, request, roleName, toneOf, when } from './ciClient.js';

const SUBTABS = Object.freeze([
  { id: 'sync', label: 'Synchronisation History' },
  { id: 'audit', label: 'Audit Trail' },
  { id: 'writeback', label: 'Write-back History' },
  { id: 'reconciliation', label: 'Reconciliation History' },
]);

/** An absent value is said, never guessed. */
const orNotRecorded = value => (value == null || value === ''
  ? '<span class="sh-absent">Not recorded</span>' : escape(String(value)));
const shortId = value => (value ? escape(String(value).slice(0, 8)) : '<span class="sh-absent">—</span>');

const STATUS_TONE = Object.freeze({
  SUCCESS: 'ok', POSTED: 'ok', ACKNOWLEDGED: 'ok', PASS: 'ok', APPROVED: 'ok',
  PARTIAL: 'warn', WARN: 'warn', PENDING_APPROVAL: 'warn', RUNNING: 'warn', POSTING: 'warn',
  FAILED: 'bad', FAIL: 'bad', HELD: 'bad', REJECTED: 'info', DRAFT: 'info',
});
const chip = value => `<span class="ci-chip" data-tone="${escape(STATUS_TONE[value] ?? 'info')}">${escape(String(value ?? '—'))}</span>`;

/* ── A. synchronisation history ────────────────────────────────────────────────────────────── */

function syncTable(data, selected) {
  if (!data.rows.length) return '<p class="ci-status">No run or posting attempt matches these filters.</p>';
  return `<table class="ci-table ci-table--rows"><thead><tr>
      <th scope="col">ID</th><th scope="col">Interface</th><th scope="col">Source → destination</th>
      <th scope="col">Started</th><th scope="col">Completed</th><th scope="col">Status</th>
      <th scope="col">Read</th><th scope="col">Created</th><th scope="col">Updated</th>
      <th scope="col">Unchanged</th><th scope="col">Failed</th><th scope="col">Correlation</th>
    </tr></thead><tbody>${data.rows.map(row => `<tr data-sh-run="${escape(row.kind)}:${row.rawId}"
        tabindex="0"${selected === `${row.kind}:${row.rawId}` ? ' class="is-selected"' : ''}>
      <th scope="row">${escape(row.id)}<small>${escape(row.kind === 'SYNC_RUN' ? 'inbound sync' : 'posting attempt')}</small></th>
      <td>${escape(row.interfaceId)}</td>
      <td>${escape(row.source)} → ${escape(row.destination)}${row.subjectId ? `<small>${escape(row.subjectId)}</small>` : ''}</td>
      <td>${escape(when(row.startedAt))}</td>
      <td>${row.completedAt ? escape(when(row.completedAt)) : '<span class="sh-absent">—</span>'}</td>
      <td>${chip(row.status)}</td>
      <td>${row.recordsRead == null ? '<span class="sh-absent">n/a</span>' : num(row.recordsRead)}</td>
      <td>${row.created == null ? '<span class="sh-absent">n/a</span>' : num(row.created)}</td>
      <td>${row.updated == null ? '<span class="sh-absent">n/a</span>' : num(row.updated)}</td>
      <td>${row.unchanged == null ? '<span class="sh-absent">n/a</span>' : num(row.unchanged)}</td>
      <td>${row.failed == null ? '<span class="sh-absent">n/a</span>' : num(row.failed)}</td>
      <td>${shortId(row.correlationId)}</td>
    </tr>`).join('')}</tbody>
    <caption>A posting attempt sends one record to one destination, so it has no read or created
      count — those cells say n/a rather than showing a figure that was never measured.</caption>
  </table>`;
}

function syncDrawer(detail) {
  if (detail.kind === 'SYNC_RUN') {
    const run = detail.run;
    return `<header class="ci-drawer-head"><div>
        <span class="ci-card-id">${escape(run.interface_id)} · inbound run</span>
        <h2>RUN-${String(run.id).padStart(4, '0')}</h2></div>
        <button type="button" class="ci-button ci-button--quiet" data-sh-action="close">Close</button></header>
      <p class="ci-card-note">${escape(detail.source)} → ${escape(detail.destination)} ·
        ${escape(when(run.started_at))} → ${escape(when(run.finished_at))} · ${escape(run.actor)}</p>
      <dl class="cp-facts">
        <div><dt>Status</dt><dd>${chip(run.status)}</dd></div>
        <div><dt>Read</dt><dd>${num(run.records_read)}</dd></div>
        <div><dt>Created</dt><dd>${num(run.records_created)}</dd></div>
        <div><dt>Updated</dt><dd>${num(run.records_updated)}</dd></div>
        <div><dt>Unchanged</dt><dd>${num(run.records_unchanged)}</dd></div>
        <div><dt>Skipped</dt><dd>${num(run.records_skipped)}</dd></div>
      </dl>
      ${detail.errors.length ? `<h3>Errors</h3><ul class="ci-findings">${detail.errors.map(entry =>
    `<li data-tone="bad"><strong>${escape(entry.severity)}</strong> ${escape(entry.record_ref ?? '')}
        <p>${escape(entry.message)}</p></li>`).join('')}</ul>`
    : '<p class="ci-card-note">No error was recorded for this run.</p>'}`;
  }
  return `<header class="ci-drawer-head"><div>
      <span class="ci-card-id">${escape(detail.interfaceId ?? '')} · posting</span>
      <h2>${escape(detail.subjectId)}</h2></div>
      <button type="button" class="ci-button ci-button--quiet" data-sh-action="close">Close</button></header>
    <p class="ci-card-note">${escape(detail.source)} → ${escape(detail.destination)} ·
      ${detail.attempts.length} attempt(s) · simulated, no live system was contacted.</p>
    <ul class="ci-findings">${detail.attempts.map(entry => `<li data-tone="${entry.outcome === 'ACKNOWLEDGED' ? 'ok' : 'bad'}">
        <strong>Attempt ${entry.attempt} · ${escape(entry.outcome)}</strong>
        <small>${escape(when(entry.at))} · ${escape(entry.actor)} · correlation ${shortId(entry.correlation_id)}</small>
        ${entry.response ? `<small>${escape(JSON.stringify(entry.response).slice(0, 300))}</small>` : ''}
      </li>`).join('')}</ul>`;
}

/* ── B. audit trail ────────────────────────────────────────────────────────────────────────── */

const SOURCE_LABEL = Object.freeze({
  audit_event: 'Application', exception_event: 'Exception',
  outbound_transition: 'Proposal', outbound_attempt: 'Posting', mapping_proposal: 'Mapping',
});

function auditTable(data) {
  if (!data.rows.length) return '<p class="ci-status">No event matches these filters.</p>';
  return `<table class="ci-table ci-table--rows"><thead><tr>
      <th scope="col">When</th><th scope="col">Event</th><th scope="col">Actor</th>
      <th scope="col">Interface</th><th scope="col">Record</th><th scope="col">Was</th>
      <th scope="col">Became</th><th scope="col">Result</th><th scope="col">Correlation</th>
      <th scope="col">From</th></tr></thead>
      <tbody>${data.rows.map(row => `<tr${row.link ? ` data-sh-link="${escape(row.link.kind)}:${escape(String(row.link.id))}"` : ''}>
        <td>${escape(when(row.at))}</td>
        <td><strong>${escape(row.event.replace(/_/g, ' ').toLowerCase())}</strong></td>
        <td>${orNotRecorded(row.actor)}</td>
        <td>${row.interfaceId ? escape(row.interfaceId) : '<span class="sh-absent">—</span>'}</td>
        <td>${row.subjectId ? escape(row.subjectId) : '<span class="sh-absent">—</span>'}</td>
        <td class="sh-state">${row.previous == null ? '<span class="sh-absent">—</span>' : escape(String(row.previous).slice(0, 60))}</td>
        <td class="sh-state">${row.next == null ? '<span class="sh-absent">—</span>' : escape(String(row.next).slice(0, 60))}</td>
        <td>${row.result ? escape(String(row.result).slice(0, 80)) : '<span class="sh-absent">—</span>'}</td>
        <td>${shortId(row.correlationId)}</td>
        <td><span class="ci-chip" data-tone="info">${escape(SOURCE_LABEL[row.source] ?? row.source)}</span></td>
      </tr>`).join('')}</tbody>
      <caption>${num(data.total)} event(s). Merged from five persisted stores; each row names the
        one it came from. "Not recorded" means the column did not exist when that row was written.</caption>
    </table>`;
}

/* ── C. write-back history ─────────────────────────────────────────────────────────────────── */

function writeBackTable(rows, selected) {
  if (!rows.length) return '<p class="ci-status">No write-back proposal has been raised yet.</p>';
  const headline = row => (row.interfaceId === 'INT-02'
    ? [`${row.previousValue?.pct_complete ?? '—'}%`, `${row.proposedValue?.pct_complete ?? '—'}%`]
    : [row.previousValue?.earned_value ?? '—', row.proposedValue?.earned_value ?? '—']);
  return `<table class="ci-table ci-table--rows"><thead><tr>
      <th scope="col">Proposal</th><th scope="col">Interface</th><th scope="col">Record</th>
      <th scope="col">Was</th><th scope="col">Proposed</th><th scope="col">Approver</th>
      <th scope="col">Attempts</th><th scope="col">Status</th><th scope="col">Correlation</th>
    </tr></thead><tbody>${rows.map(row => {
    const [was, proposed] = headline(row);
    return `<tr data-sh-writeback="${row.proposalId}" tabindex="0"${selected === row.proposalId ? ' class="is-selected"' : ''}>
      <th scope="row">${escape(row.reference)}</th>
      <td>${escape(row.interfaceId)}<small>${escape(row.destination ?? '')}</small></td>
      <td>${escape(row.subjectId)}</td>
      <td>${escape(String(was))}</td>
      <td><strong>${escape(String(proposed))}</strong></td>
      <td>${row.approver ? `${escape(row.approver)}<small>${escape(roleName(row.approverRole))}</small>` : '<span class="sh-absent">Not approved</span>'}</td>
      <td>${num(row.attemptCount)}</td>
      <td>${chip(row.status)}</td>
      <td>${shortId(row.correlationId)}</td>
    </tr>`;
  }).join('')}</tbody>
    <caption>Every posting here is simulated against a mock destination. None of it is a P6 or SAP
      transaction.</caption></table>`;
}

function writeBackDrawer(detail, onOpenException) {
  return `<header class="ci-drawer-head"><div>
      <span class="ci-card-id">${escape(detail.interfaceId)} · ${escape(detail.destination ?? '')}</span>
      <h2>${escape(detail.reference)} · ${escape(detail.subjectId)}</h2></div>
      <button type="button" class="ci-button ci-button--quiet" data-sh-action="close">Close</button></header>

    <h3>Lifecycle</h3>
    <ol class="sh-timeline">${detail.transitions.map(entry => `<li data-tone="${toneOf(entry.to_status)}">
        <span class="sh-state-name">${escape(entry.to_status)}</span>
        <small>${escape(when(entry.at))} · ${orNotRecorded(entry.actor)}${entry.actor_role ? ` (${escape(roleName(entry.actor_role))})` : ''}</small>
        ${entry.reason ? `<small>${escape(entry.reason)}</small>` : ''}</li>`).join('')}</ol>

    <h3>What changed</h3>
    <dl class="cp-facts">
      <div><dt>Source revision at proposal</dt><dd>${orNotRecorded(detail.sourceRev)}</dd></div>
      <div><dt>Previous value</dt><dd>${escape(JSON.stringify(detail.previousValue ?? null))}</dd></div>
      <div><dt>Proposed value</dt><dd><strong>${escape(JSON.stringify(detail.proposedValue ?? null))}</strong></dd></div>
      <div><dt>Approved</dt><dd>${detail.approvedAt ? `${escape(when(detail.approvedAt))} · ${escape(detail.approver)}` : '<span class="sh-absent">Not approved</span>'}</dd></div>
      <div><dt>Posted</dt><dd>${detail.postedAt ? escape(when(detail.postedAt)) : '<span class="sh-absent">Not posted</span>'}</dd></div>
    </dl>
    ${detail.coverage ? `<p class="ci-card-note"><span class="ci-chip" data-tone="${detail.coverage.scope === 'COMPLETE' ? 'ok' : 'warn'}">${escape(detail.coverage.scope)}</span>
      ${escape(detail.coverage.note)}</p>` : ''}

    ${detail.holdReason ? `<h3>Held</h3><p class="ci-card-note">${escape(detail.holdReason)}</p>
      ${detail.conflictException ? `<button type="button" class="ci-button"
        data-sh-action="open-exception" data-exception="${detail.conflictException.id}">
        Open exception EXC-${String(detail.conflictException.id).padStart(4, '0')}</button>` : ''}` : ''}
    ${detail.failureReason ? `<h3>Failed</h3><p class="ci-card-note">${escape(detail.failureReason)}</p>` : ''}

    <h3>Posting attempts</h3>
    ${detail.attempts.length ? `<ul class="ci-findings">${detail.attempts.map(entry => `<li data-tone="${entry.outcome === 'ACKNOWLEDGED' ? 'ok' : 'bad'}">
        <strong>Attempt ${entry.attempt} · ${escape(entry.outcome)}</strong>
        <small>${escape(when(entry.at))} · correlation ${shortId(entry.correlation_id)}</small>
        ${entry.response?.note ? `<small>${escape(entry.response.note)}</small>` : ''}
        ${entry.response?.error ? `<small>${escape(entry.response.error)}</small>` : ''}
      </li>`).join('')}</ul>` : '<p class="ci-card-note">No posting has been attempted.</p>'}
    <p class="ci-card-note">${escape(detail.note)}</p>`;
}

/* ── D. reconciliation history ─────────────────────────────────────────────────────────────── */

function reconciliationTable(runs, selected) {
  if (!runs.length) return '<p class="ci-status">Reconciliation has not run yet.</p>';
  return `<table class="ci-table ci-table--rows"><thead><tr>
      <th scope="col">Run</th><th scope="col">When</th><th scope="col">Actor</th>
      <th scope="col">Checks</th><th scope="col">Passed</th><th scope="col">Warnings</th>
      <th scope="col">Failed</th><th scope="col">Result</th></tr></thead>
      <tbody>${runs.map(run => `<tr data-sh-recon="${run.runId}" tabindex="0"${selected === run.runId ? ' class="is-selected"' : ''}>
        <th scope="row">REC-${String(run.runId).padStart(4, '0')}</th>
        <td>${escape(when(run.at))}</td><td>${orNotRecorded(run.actor)}</td>
        <td>${num(run.checks)}</td><td>${num(run.passed)}</td>
        <td>${num(run.warnings)}</td><td>${num(run.failed)}</td>
        <td>${chip(run.result)}</td></tr>`).join('')}</tbody></table>`;
}

function reconciliationDrawer(detail) {
  return `<header class="ci-drawer-head"><div>
      <span class="ci-card-id">Reconciliation</span>
      <h2>REC-${String(detail.run.id).padStart(4, '0')}</h2></div>
      <button type="button" class="ci-button ci-button--quiet" data-sh-action="close">Close</button></header>
    <p class="ci-card-note">${escape(when(detail.run.at))} · ${orNotRecorded(detail.run.actor)}</p>
    <table class="ci-table ci-table--rows"><thead><tr>
      <th scope="col">Check</th><th scope="col">Checked</th><th scope="col">Matched</th>
      <th scope="col">Unmatched</th><th scope="col">Warnings</th>
      <th scope="col">Excluded by policy</th><th scope="col">Result</th></tr></thead>
      <tbody>${detail.checks.map(row => `<tr>
        <th scope="row">${escape(row.label)}<small>${escape(row.detail)}</small></th>
        <td>${num(row.checked)}</td><td>${num(row.matched)}</td><td>${num(row.unmatched)}</td>
        <td>${num(row.warnings)}</td><td>${num(row.excluded)}</td><td>${chip(row.status)}</td>
      </tr>`).join('')}</tbody>
      <caption>${escape(detail.note)}</caption></table>`;
}

/* ── the workspace ─────────────────────────────────────────────────────────────────────────── */

export function installSyncHistory(host, { onOpenException = null, onOpenMapping = null } = {}) {
  const root = document.createElement('div');
  root.className = 'ci-history';
  host.append(root);

  let tab = 'sync';
  let filters = {};
  let data = null;
  let detail = null;
  let selected = null;
  let message = '';
  let loading = true;

  function filterBar() {
    if (tab === 'sync') {
      return `<div class="ci-filters">
        <label class="ci-filter"><span>Interface</span><select data-sh="interfaceId">
          <option value="">All</option>${['INT-01', 'INT-02', 'INT-03', 'INT-04', 'INT-05'].map(id =>
    `<option value="${id}"${filters.interfaceId === id ? ' selected' : ''}>${id}</option>`).join('')}
        </select></label>
        <label class="ci-filter"><span>Status</span><select data-sh="status">
          <option value="">All</option>${['SUCCESS', 'PARTIAL', 'FAILED'].map(value =>
    `<option value="${value}"${filters.status === value ? ' selected' : ''}>${value}</option>`).join('')}
        </select></label>
        <label class="ci-filter"><span>From</span><input type="date" data-sh="from" value="${escape(filters.from ?? '')}"></label>
        <label class="ci-filter"><span>To</span><input type="date" data-sh="to" value="${escape(filters.to ?? '')}"></label>
      </div>`;
    }
    if (tab === 'audit') {
      const facets = data?.facets ?? { event: [], interfaceId: [] };
      return `<div class="ci-filters">
        <label class="ci-filter ci-filter--search"><span>Search</span>
          <input type="search" data-sh="query" value="${escape(filters.query ?? '')}"
            placeholder="Record, actor, result or correlation id"></label>
        <label class="ci-filter"><span>Event</span><select data-sh="event">
          <option value="">All</option>${facets.event.map(value =>
    `<option value="${escape(value)}"${filters.event === value ? ' selected' : ''}>${escape(value)}</option>`).join('')}
        </select></label>
        <label class="ci-filter"><span>Interface</span><select data-sh="interfaceId">
          <option value="">All</option>${facets.interfaceId.map(value =>
    `<option value="${escape(value)}"${filters.interfaceId === value ? ' selected' : ''}>${escape(value)}</option>`).join('')}
        </select></label>
        <label class="ci-filter"><span>Record</span>
          <input type="search" data-sh="subject" value="${escape(filters.subject ?? '')}" placeholder="e.g. A-1020"></label>
      </div>`;
    }
    if (tab === 'writeback') {
      return `<div class="ci-filters">
        <label class="ci-filter"><span>Interface</span><select data-sh="interfaceId">
          <option value="">All</option><option value="INT-02"${filters.interfaceId === 'INT-02' ? ' selected' : ''}>INT-02</option>
          <option value="INT-05"${filters.interfaceId === 'INT-05' ? ' selected' : ''}>INT-05</option></select></label>
        <label class="ci-filter"><span>Status</span><select data-sh="status">
          <option value="">All</option>${['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'HELD', 'FAILED', 'REJECTED'].map(value =>
    `<option value="${value}"${filters.status === value ? ' selected' : ''}>${value}</option>`).join('')}
        </select></label>
      </div>`;
    }
    return '';
  }

  function body() {
    if (loading) return '<p class="ci-status">Reading the recorded history…</p>';
    if (tab === 'sync') return syncTable(data, selected);
    if (tab === 'audit') return auditTable(data);
    if (tab === 'writeback') return writeBackTable(data.proposals, selected);
    return reconciliationTable(data.runs, selected);
  }

  function drawerMarkup() {
    if (!detail) return '';
    if (tab === 'sync') return syncDrawer(detail);
    if (tab === 'writeback') return writeBackDrawer(detail);
    if (tab === 'reconciliation') return reconciliationDrawer(detail);
    return '';
  }

  function render() {
    root.innerHTML = `
      <div class="aom-tabs ci-subtabs" role="tablist">${SUBTABS.map(entry =>
    `<button role="tab" type="button" data-sh-tab="${entry.id}" aria-selected="${entry.id === tab}">${escape(entry.label)}</button>`).join('')}</div>
      ${filterBar()}
      ${message ? `<p class="ci-actions-note" role="status">${escape(message)}</p>` : ''}
      <div class="ci-split">
        <div class="ci-split-main">${body()}</div>
        ${detail ? `<aside class="ci-drawer" aria-label="Detail">${drawerMarkup()}</aside>` : ''}
      </div>`;
  }

  const query = () => new URLSearchParams(
    Object.entries(filters).filter(([, value]) => value).map(([key, value]) => [key, String(value)]));

  async function load() {
    loading = true;
    render();
    try {
      if (tab === 'sync') data = await request(`/history/sync?${query()}`);
      else if (tab === 'audit') data = await request(`/history/audit?${query()}`);
      else if (tab === 'writeback') data = await request(`/history/writeback?${query()}`);
      else data = await request('/history/reconciliation');
      message = '';
    } catch (error) { message = error.message; data = { rows: [], proposals: [], runs: [] }; }
    loading = false;
    render();
  }

  async function open(kind, id) {
    try {
      if (kind === 'sync') { detail = await request(`/history/sync/${id}`); selected = id; }
      if (kind === 'writeback') { detail = await request(`/history/writeback/${id}`); selected = Number(id); }
      if (kind === 'recon') { detail = await request(`/history/reconciliation/${id}`); selected = Number(id); }
    } catch (error) { message = error.message; detail = null; }
    render();
  }

  root.onclick = event => {
    const chosen = event.target.closest('[data-sh-tab]');
    if (chosen) {
      tab = chosen.dataset.shTab; detail = null; selected = null; filters = {};
      void load();
      return;
    }
    const action = event.target.closest('[data-sh-action]');
    if (action) {
      if (action.dataset.shAction === 'close') { detail = null; selected = null; render(); }
      if (action.dataset.shAction === 'open-exception') onOpenException?.(action.dataset.exception);
      return;
    }
    const run = event.target.closest('[data-sh-run]');
    if (run) { void open('sync', run.dataset.shRun.replace(':', '/')); return; }
    const writeback = event.target.closest('[data-sh-writeback]');
    if (writeback) { void open('writeback', writeback.dataset.shWriteback); return; }
    const recon = event.target.closest('[data-sh-recon]');
    if (recon) { void open('recon', recon.dataset.shRecon); return; }
    const link = event.target.closest('[data-sh-link]');
    if (link) {
      const [kind, id] = link.dataset.shLink.split(':');
      if (kind === 'exception') onOpenException?.(id);
      if (kind === 'mapping') onOpenMapping?.(id);
    }
  };

  let typing = null;
  root.oninput = event => {
    const name = event.target.dataset?.sh;
    if (!name) return;
    filters = { ...filters, [name]: event.target.value || undefined };
    // Typed filters settle before refetching; a select applies at once.
    if (event.target.tagName === 'INPUT' && event.target.type !== 'date') {
      clearTimeout(typing);
      typing = setTimeout(() => {
        const focused = document.activeElement?.dataset?.sh;
        const caret = document.activeElement?.selectionStart;
        void load().then(() => {
          const next = root.querySelector(`[data-sh="${focused}"]`);
          if (next) { next.focus(); if (caret != null && next.type === 'search') next.setSelectionRange(caret, caret); }
        });
      }, 280);
      return;
    }
    void load();
  };
  root.onchange = event => { if (event.target.dataset?.sh && event.target.tagName === 'SELECT') void load(); };

  render();
  const ready = load();
  return {
    root, ready, reload: load,
    /** Open the trail filtered to one record — the route every other workspace uses. */
    async show(subject) {
      tab = 'audit';
      filters = { subject };
      detail = null;
      await load();
    },
    destroy() { clearTimeout(typing); root.remove(); },
  };
}
