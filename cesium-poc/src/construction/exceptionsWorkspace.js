/**
 * Exceptions & Reconciliation — two subtabs over one workspace.
 *
 * Exceptions is the work: what is wrong, who owns it, and the route to its mapping. Reconciliation
 * is the arithmetic: what was checked, what matched, and what was excluded by policy rather than
 * failed. They are kept apart because they answer different questions, and together they would be
 * a page nobody finishes reading.
 */
import { escape, num, request, roleName, toneOf, when } from './ciClient.js';

const TABS = Object.freeze([
  { id: 'exceptions', label: 'Exceptions' },
  { id: 'reconciliation', label: 'Reconciliation' },
]);

/** The moves a person may make. RESOLVED is absent on purpose: revalidation decides that. */
const NEXT = Object.freeze({
  OPEN: ['UNDER_REVIEW', 'AWAITING_CORRECTION'],
  UNDER_REVIEW: ['AWAITING_CORRECTION', 'READY_FOR_REVALIDATION', 'OPEN'],
  AWAITING_CORRECTION: ['READY_FOR_REVALIDATION', 'UNDER_REVIEW'],
  READY_FOR_REVALIDATION: ['UNDER_REVIEW'],
  RESOLVED: [],
});

function summaryMarkup(summary) {
  return `<dl class="ci-summary">
      <div><dt>Open</dt><dd>${num(summary.open)}</dd></div>
      <div><dt>Errors</dt><dd>${num(summary.bySeverity.ERROR)}</dd></div>
      <div><dt>Warnings</dt><dd>${num(summary.bySeverity.WARNING)}</dd></div>
      <div><dt>Resolved</dt><dd>${num(summary.resolved)}</dd><small>kept, never deleted</small></div>
      <div><dt>Reopened</dt><dd>${num(summary.reopened)}</dd><small>came back after being resolved</small></div>
      <div><dt>Excluded by policy</dt><dd>${num(summary.excludedByPolicy)}</dd><small>not a failure</small></div>
    </dl>`;
}

function exceptionRows(rows) {
  if (!rows.length) return '<p class="ci-status">No exception matches these filters.</p>';
  return `<table class="ci-table ci-table--rows">
      <thead><tr><th scope="col">ID</th><th scope="col">Rule</th><th scope="col">Record</th>
        <th scope="col">Severity</th><th scope="col">Owner</th><th scope="col">Status</th>
        <th scope="col">Last detected</th></tr></thead>
      <tbody>${rows.map(row => `<tr data-exception="${row.id}" tabindex="0">
        <th scope="row">EXC-${String(row.id).padStart(4, '0')}</th>
        <td>${escape(row.rule_id)}</td>
        <td>${escape(row.subject_id)}<small> ${escape(row.subject_type)}</small></td>
        <td><span class="ci-chip" data-tone="${escape(toneOf(row.severity))}">${escape(row.severity)}</span></td>
        <td>${escape(roleName(row.owner_role))}</td>
        <td><span class="ci-chip" data-tone="${escape(toneOf(row.status))}">${escape(row.status.replace(/_/g, ' ').toLowerCase())}</span>
            ${row.reopen_count ? `<small> reopened ${row.reopen_count}×</small>` : ''}</td>
        <td>${escape(when(row.last_detected))}</td>
      </tr>`).join('')}</tbody></table>`;
}

function detailMarkup(detail) {
  const exception = detail.exception;
  const moves = NEXT[exception.status] ?? [];
  return `<header class="ci-drawer-head">
      <div><span class="ci-card-id">Exception</span>
        <h2>EXC-${String(exception.id).padStart(4, '0')}</h2></div>
      <button type="button" class="ci-button ci-button--quiet" data-action="close">Close</button>
    </header>
    <p class="ci-card-note">${escape(exception.rule_id)} · ${escape(detail.rule?.label ?? '')}
      · interface ${escape(exception.interface_id ?? 'n/a')}</p>
    <p>${escape(exception.description)}</p>
    ${detail.validation ? `<p class="ci-card-note">Expected ${escape(detail.validation.expected ?? '—')};
      found ${escape(detail.validation.actual ?? '—')}.</p>` : ''}
    <h3>Suggested action</h3>
    <p>${escape(exception.suggested_action)}</p>
    <p class="ci-card-note">Owner: ${escape(roleName(exception.owner_role))} ·
      first detected ${escape(when(exception.first_detected))} ·
      last ${escape(when(exception.last_detected))}${
  exception.reopen_count ? ` · reopened ${exception.reopen_count} time(s)` : ''}</p>

    <div class="ci-actions">
      ${detail.elementId ? `<button type="button" class="ci-button" data-action="open-mapping"
          data-element="${escape(detail.elementId)}">Open ${escape(detail.elementId)} in the Mapping Workbench</button>` : ''}
      <button type="button" class="ci-button ci-button--quiet" data-action="open-audit"
        data-subject="${escape(exception.subject_id)}">View audit trail</button>
    </div>

    ${moves.length ? `<h3>Move it on</h3><div class="ci-actions">${moves.map(status =>
    `<button type="button" class="ci-button ci-button--quiet" data-action="transition" data-to="${escape(status)}">
        ${escape(status.replace(/_/g, ' ').toLowerCase())}</button>`).join('')}</div>
      <p class="ci-card-note">An exception is resolved by revalidation finding the problem gone,
        never by being marked resolved.</p>` : ''}

    <h3>History</h3>
    <ol class="ci-history">${detail.history.map(event => `<li>
        <strong>${escape(event.event.replace(/_/g, ' ').toLowerCase())}</strong>
        ${event.from_status ? `${escape(event.from_status)} → ${escape(event.to_status)}` : ''}
        <small>${escape(when(event.at))} · ${escape(event.actor)}</small>
        ${event.detail ? `<small>${escape(JSON.stringify(event.detail))}</small>` : ''}
      </li>`).join('')}</ol>`;
}

function reconciliationMarkup(latest) {
  if (!latest) {
    return '<p class="ci-status">Reconciliation has never run. Synchronise, or run it below.</p>';
  }
  return `<p class="ci-card-note">Run ${latest.run.id} · ${escape(when(latest.run.at))} ·
      ${num(latest.run.passed)} passed, ${num(latest.run.warnings)} warning, ${num(latest.run.failed)} failed.
      Every figure is counted from the database at the moment the check ran.</p>
    <table class="ci-table ci-table--rows">
      <thead><tr><th scope="col">Check</th><th scope="col">Checked</th><th scope="col">Matched</th>
        <th scope="col">Unmatched</th><th scope="col">Of those, warnings</th>
        <th scope="col">Excluded by policy</th><th scope="col">Result</th></tr></thead>
      <tbody>${latest.checks.map(row => `<tr>
        <th scope="row">${escape(row.label)}<small>${escape(row.detail)}</small></th>
        <td>${num(row.checked)}</td><td>${num(row.matched)}</td><td>${num(row.unmatched)}</td>
        <td>${num(row.warnings)}</td><td>${num(row.excluded)}</td>
        <td><span class="ci-chip" data-tone="${escape(toneOf(row.status))}">${escape(row.status)}</span></td>
      </tr>`).join('')}</tbody>
      <caption>Checked = matched + unmatched + excluded, on every row. Warnings are a subset of
        unmatched, not a third bucket. A record excluded by policy is not a failed one.</caption>
    </table>`;
}

export function installExceptionsWorkspace(host, { onOpenMapping = null, onOpenAudit = null } = {}) {
  const root = document.createElement('div');
  root.className = 'ci-exceptions';
  host.append(root);

  let tab = 'exceptions';
  let list = null;
  let detail = null;
  let reconciliation = null;
  let filters = { includeResolved: false };
  let message = '';

  function render() {
    const tabs = `<div class="aom-tabs ci-subtabs" role="tablist">${TABS.map(entry =>
      `<button role="tab" type="button" data-subtab="${entry.id}"
         aria-selected="${entry.id === tab}">${escape(entry.label)}</button>`).join('')}</div>`;
    if (tab === 'reconciliation') {
      root.innerHTML = `${tabs}
        <div class="ci-actions">
          <button type="button" class="ci-button" data-action="reconcile">Run reconciliation</button>
          <span class="ci-actions-note" role="status">${escape(message)}</span>
        </div>
        ${reconciliationMarkup(reconciliation)}`;
      return;
    }
    if (!list) { root.innerHTML = `${tabs}<p class="ci-status">Reading the exception list…</p>`; return; }
    root.innerHTML = `${tabs}
      ${summaryMarkup(list.summary)}
      <div class="ci-filters">
        <label class="ci-filter"><span>Severity</span>
          <select data-filter="severity"><option value="">All</option>
            <option value="ERROR"${filters.severity === 'ERROR' ? ' selected' : ''}>Error</option>
            <option value="WARNING"${filters.severity === 'WARNING' ? ' selected' : ''}>Warning</option>
          </select></label>
        <label class="ci-filter"><span>Rule</span>
          <select data-filter="rule"><option value="">All</option>${list.rules.map(rule =>
    `<option value="${escape(rule.id)}"${filters.rule === rule.id ? ' selected' : ''}>${escape(rule.id)}</option>`).join('')}
          </select></label>
        <label class="ci-filter"><span>Include resolved</span>
          <select data-filter="includeResolved"><option value="">No</option>
            <option value="true"${filters.includeResolved ? ' selected' : ''}>Yes</option>
          </select></label>
      </div>
      ${message ? `<p class="ci-actions-note" role="status">${escape(message)}</p>` : ''}
      <div class="ci-split">
        <div class="ci-split-main">${exceptionRows(list.rows)}</div>
        ${detail ? `<aside class="ci-drawer" aria-label="Exception detail">${detailMarkup(detail)}</aside>` : ''}
      </div>`;
  }

  async function load() {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) query.set(key, String(value));
    try { list = await request(`/exceptions?${query}`); }
    catch (error) { message = error.message; }
    render();
  }

  async function loadReconciliation() {
    try { reconciliation = (await request('/reconciliation')).latest; }
    catch (error) { message = error.message; }
    render();
  }

  async function act(action, button) {
    try {
      if (action === 'close') { detail = null; render(); return; }
      if (action === 'reconcile') {
        const result = await request('/reconciliation', { method: 'POST', body: {} });
        message = `Reconciliation run ${result.runId} completed.`;
        await loadReconciliation();
        return;
      }
      if (action === 'transition') {
        await request(`/exceptions/${detail.exception.id}/transition`, { method: 'POST',
          body: { to: button.dataset.to, actor: 'Demo reviewer (this session)' } });
        message = '';
        detail = await request(`/exceptions/${detail.exception.id}`);
        await load();
        return;
      }
      if (action === 'open-mapping') { onOpenMapping?.(button.dataset.element); return; }
      if (action === 'open-audit') { onOpenAudit?.(button.dataset.subject); return; }
    } catch (error) {
      message = error.message;
      render();
    }
  }

  root.onclick = event => {
    const subtab = event.target.closest('[data-subtab]');
    if (subtab) {
      tab = subtab.dataset.subtab;
      message = '';
      if (tab === 'reconciliation' && !reconciliation) void loadReconciliation(); else render();
      return;
    }
    const button = event.target.closest('button[data-action]');
    if (button) { void act(button.dataset.action, button); return; }
    const row = event.target.closest('tr[data-exception]');
    if (row) {
      void request(`/exceptions/${row.dataset.exception}`)
        .then(value => { detail = value; render(); })
        .catch(error => { message = error.message; render(); });
    }
  };
  root.onchange = event => {
    const name = event.target.dataset?.filter;
    if (!name) return;
    filters = { ...filters, [name]: name === 'includeResolved'
      ? event.target.value === 'true' : event.target.value || undefined };
    void load();
  };

  render();
  const ready = load();
  return {
    root, ready, reload: load,
    get list() { return list; },
    showTab(next) { tab = next; render(); },
    /** Open one exception from elsewhere, clearing any filter that would hide it. */
    async show(exceptionId) {
      tab = 'exceptions';
      filters = { includeResolved: true };
      await load();
      try { detail = await request(`/exceptions/${exceptionId}`); }
      catch (error) { message = error.message; detail = null; }
      render();
    },
    destroy() { root.remove(); } };
}
