/**
 * Approval Center — the two outbound gates, INT-02 and INT-05.
 *
 * Two subtabs, a compact queue and one contextual drawer. No stacked dialogs: a decision is made
 * in the drawer beside the queue, where the proposed values, the evidence and the pre-post checks
 * are all visible at once.
 *
 * THE ROLE IS THE SERVER'S. This screen asks for a demo session when the operator picks a role,
 * and sends only its token; a refusal comes back from the backend in its own words. Nothing here
 * decides what the operator may do — it could not, and a screen that pretended otherwise would be
 * describing authorization it does not have.
 */
import {
  escape, getSessionToken, num, request, roleName, setSessionToken, toneOf, when,
} from './ciClient.js';

const INTERFACES = Object.freeze([
  { id: 'INT-02', label: 'P6 Progress Approvals', destination: 'Primavera P6',
    approver: 'planner' },
  { id: 'INT-05', label: 'SAP Earned Value Approvals', destination: 'SAP',
    approver: 'financeController' },
]);

const QUEUES = Object.freeze(['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'HELD', 'POSTED']);
const QUEUE_LABEL = Object.freeze({
  PENDING_APPROVAL: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected',
  HELD: 'Held', POSTED: 'Posted', DRAFT: 'Draft', POSTING: 'Posting', FAILED: 'Failed',
});

const money = (value, currency) => (value == null ? '—'
  : `${currency ?? ''} ${Math.round(value).toLocaleString('en-US')}`.trim());

function sessionBar(session, demo) {
  return `<div class="ci-actions ap-session">
      <label class="ci-filter"><span>Acting as</span>
        <select data-ap="role">
          <option value="">No session</option>
          ${['integrationLead', 'planner', 'bimCoordinator', 'financeController'].map(role =>
    `<option value="${role}"${session?.role === role ? ' selected' : ''}>${escape(roleName(role))}</option>`).join('')}
        </select></label>
      <span class="ci-actions-note">${session
    ? `Session held as <strong>${escape(session.label)}</strong>.`
    : 'No session. The server takes the role from the session, not from the request.'}</span>
      <span class="ci-chip" data-tone="warn">Demo authorization</span>
    </div>
    <p class="ci-card-note">${escape(demo?.note ?? '')}</p>`;
}

function queueTable(proposals, selectedId) {
  if (!proposals.length) return '<p class="ci-status">Nothing in this queue.</p>';
  return `<table class="ci-table ci-table--rows"><thead><tr>
      <th scope="col">ID</th><th scope="col">Subject</th><th scope="col">Current</th>
      <th scope="col">Proposed</th><th scope="col">Coverage</th><th scope="col">Status</th>
      <th scope="col">Raised</th></tr></thead>
      <tbody>${proposals.map(row => {
    const proposed = row.payload.proposed;
    const current = row.payload.current ?? {};
    const headline = row.interface_id === 'INT-02'
      ? [`${current.pct_complete ?? '—'}%`, `${proposed.pct_complete}%`]
      : [money(current.earned_value, proposed.currency), money(proposed.earned_value, proposed.currency)];
    return `<tr data-ap-proposal="${row.id}" tabindex="0"${row.id === selectedId ? ' class="is-selected"' : ''}>
        <th scope="row">OUT-${String(row.id).padStart(4, '0')}</th>
        <td>${escape(row.subject_id)}</td>
        <td>${escape(headline[0])}</td>
        <td><strong>${escape(headline[1])}</strong></td>
        <td>${row.coverage ? `<span class="ci-chip" data-tone="${row.coverage.scope === 'COMPLETE' ? 'ok' : 'warn'}">${escape(row.coverage.scope)}</span>` : '—'}</td>
        <td><span class="ci-chip" data-tone="${escape(statusTone(row.status))}">${escape(QUEUE_LABEL[row.status] ?? row.status)}</span></td>
        <td>${escape(when(row.created_at))}</td>
      </tr>`;
  }).join('')}</tbody></table>`;
}

const statusTone = status => ({
  POSTED: 'ok', APPROVED: 'ok', PENDING_APPROVAL: 'warn', HELD: 'bad',
  REJECTED: 'info', FAILED: 'bad', DRAFT: 'info', POSTING: 'warn',
}[status] ?? 'info');

function fieldRows(proposal) {
  const proposed = proposal.payload.proposed;
  const current = proposal.payload.current ?? {};
  return Object.keys(proposed)
    .filter(key => key !== 'coverage')
    .map(key => `<tr>
      <th scope="row">${escape(key)}</th>
      <td>${escape(String(current[key] ?? '—'))}</td>
      <td><strong>${escape(String(proposed[key] ?? '—'))}</strong></td>
    </tr>`).join('');
}

function evidenceBlock(proposal) {
  const evidence = proposal.evidence;
  if (proposal.interface_id === 'INT-02') {
    return `<p class="ci-card-note">${escape(evidence.verifiedElements)} of
        ${escape(evidence.totalElements)} element(s) verified, measured by
        <strong>${escape(String(evidence.rule).replace(/_/g, ' ').toLowerCase())}</strong>.
        ${evidence.draftObservationsExcluded
    ? `${evidence.draftObservationsExcluded} unverified observation(s) were excluded.` : ''}</p>
      <ul class="ci-findings">${(evidence.observations ?? []).slice(0, 8).map(entry => `<li>
          <strong>${escape(entry.element)}</strong> ${escape(entry.observedOn)}
          <small>${escape(entry.evidence)} · ${escape(entry.reviewer)}</small></li>`).join('')}</ul>`;
  }
  const lines = evidence.lines ?? [];
  return `<table class="ci-table ci-table--rows"><thead><tr>
      <th scope="col">Element</th><th scope="col">BOQ</th><th scope="col">Approved qty</th>
      <th scope="col">Verified qty</th><th scope="col">Unit</th><th scope="col">Rate</th>
      <th scope="col">Value</th></tr></thead>
      <tbody>${lines.slice(0, 12).map(line => `<tr>
        <th scope="row">${escape(line.element)}</th><td>${escape(line.boq)}</td>
        <td>${num(line.approvedQuantity)}</td><td>${num(line.verifiedQuantity)}</td>
        <td>${escape(line.unit)}</td><td>${num(line.unitRate)}</td><td>${num(line.value)}</td>
      </tr>`).join('')}</tbody>
      <caption>${lines.length} priced line(s). Earned value is the verified quantity at the
        approved rate. SAP actual cost ${num(evidence.sapActualCost)} and budget
        ${num(evidence.sapBudget)} are shown for context and are never added to it.</caption></table>`;
}

function drawer(detail, session) {
  const { proposal, preflight, transitions, attempts, permittedFields, forbiddenNote } = detail;
  const canDecide = session?.may?.includes(`approve:${proposal.interface_id}`);
  return `<header class="ci-drawer-head"><div>
      <span class="ci-card-id">${escape(proposal.interface_id)} · OUT-${String(proposal.id).padStart(4, '0')}</span>
      <h2>${escape(proposal.subject_id)}</h2></div>
      <button type="button" class="ci-button ci-button--quiet" data-ap-action="close">Close</button>
    </header>
    <p class="ci-card-note">Status <span class="ci-chip" data-tone="${escape(statusTone(proposal.status))}">${escape(QUEUE_LABEL[proposal.status] ?? proposal.status)}</span>
      · correlation ${escape(String(proposal.correlation_id).slice(0, 8))}
      · validation ${escape(proposal.validation_status)}</p>

    <h3>What would change</h3>
    <table class="ci-table ci-table--rows"><thead><tr><th scope="col">Field</th>
      <th scope="col">Current in ${escape(proposal.interface_id === 'INT-02' ? 'P6' : 'SAP')}</th>
      <th scope="col">Proposed</th></tr></thead><tbody>${fieldRows(proposal)}</tbody>
      <caption>Permitted fields: ${escape(permittedFields.join(', '))}. ${escape(forbiddenNote)}</caption>
    </table>

    ${proposal.coverage ? `<h3>Coverage</h3>
      <p class="ci-card-note"><span class="ci-chip" data-tone="${proposal.coverage.scope === 'COMPLETE' ? 'ok' : 'warn'}">${escape(proposal.coverage.scope)}</span>
        ${escape(proposal.coverage.note)}</p>
      ${proposal.coverage.excludedElements.length ? `<p class="ci-card-note">Excluded:
        ${escape(proposal.coverage.excludedElements.slice(0, 12).join(', '))}${proposal.coverage.excludedElements.length > 12 ? '…' : ''}</p>` : ''}` : ''}

    <h3>Evidence</h3>
    ${evidenceBlock(proposal)}

    <h3>Pre-post checks</h3>
    <ul class="ci-findings">${preflight.checks.map(check => `<li data-tone="${check.ok ? 'ok' : 'bad'}">
        <strong>${check.ok ? '✓' : '✗'} ${escape(check.label)}</strong>
        <small>${escape(check.detail)}</small></li>`).join('')}</ul>

    <div class="ci-actions">
      ${proposal.status === 'DRAFT'
    ? '<button type="button" class="ci-button" data-ap-action="submit">Submit for approval</button>' : ''}
      ${proposal.status === 'PENDING_APPROVAL' ? `
        <button type="button" class="ci-button" data-ap-action="approve"${canDecide ? '' : ' disabled'}>Approve</button>
        <button type="button" class="ci-button ci-button--quiet" data-ap-action="reject"${canDecide ? '' : ' disabled'}>Reject</button>
        <button type="button" class="ci-button ci-button--quiet" data-ap-action="hold"${canDecide ? '' : ' disabled'}>Hold</button>` : ''}
      ${['APPROVED', 'FAILED'].includes(proposal.status)
    ? `<button type="button" class="ci-button" data-ap-action="post">${proposal.status === 'FAILED' ? 'Retry posting' : 'Post to'} ${escape(proposal.interface_id === 'INT-02' ? 'mock P6' : 'mock SAP')}</button>` : ''}
    </div>
    ${proposal.status === 'PENDING_APPROVAL' && !canDecide
    ? `<p class="ci-card-note">This session may not approve ${escape(proposal.interface_id)}. The
        server enforces it; the buttons above are disabled only so the refusal is not a surprise.</p>` : ''}
    ${proposal.hold_reason ? `<p class="ci-card-note">Held: ${escape(proposal.hold_reason)}</p>` : ''}
    ${proposal.failure_reason ? `<p class="ci-card-note">Failed: ${escape(proposal.failure_reason)}</p>` : ''}

    ${attempts.length ? `<h3>Posting attempts</h3>
      <ul class="ci-findings">${attempts.map(entry => `<li data-tone="${entry.outcome === 'ACKNOWLEDGED' ? 'ok' : 'bad'}">
          <strong>Attempt ${entry.attempt} · ${escape(entry.outcome)}</strong>
          <small>${escape(entry.destination)} · ${escape(when(entry.at))} · correlation ${escape(String(entry.correlation_id).slice(0, 8))}</small>
          ${entry.response ? `<small>${escape(JSON.stringify(entry.response).slice(0, 220))}</small>` : ''}
        </li>`).join('')}</ul>` : ''}

    <h3>Decision history</h3>
    <ol class="ci-history">${transitions.map(entry => `<li>
        <strong>${escape(entry.from_status ?? 'created')} → ${escape(entry.to_status)}</strong>
        <small>${escape(when(entry.at))} · ${escape(entry.actor)}${entry.actor_role ? ` (${escape(roleName(entry.actor_role))})` : ''}</small>
        ${entry.reason ? `<small>${escape(entry.reason)}</small>` : ''}</li>`).join('')}</ol>`;
}

export function installApprovalCenter(host) {
  const root = document.createElement('div');
  root.className = 'ci-approvals';
  host.append(root);

  let interfaceId = 'INT-02';
  let queue = 'PENDING_APPROVAL';
  let proposals = [];
  let reconciliation = null;
  let detail = null;
  let session = null;
  let demo = null;
  let message = '';

  function render() {
    const counts = reconciliation?.byInterface.find(entry => entry.interfaceId === interfaceId) ?? {};
    const countOf = status => ({
      PENDING_APPROVAL: counts.pending, APPROVED: counts.approvedNotPosted,
      REJECTED: counts.rejected, HELD: counts.held, POSTED: counts.posted,
    }[status] ?? 0);
    root.innerHTML = `
      ${sessionBar(session, demo)}
      <div class="aom-tabs ci-subtabs" role="tablist">${INTERFACES.map(entry =>
    `<button role="tab" type="button" data-ap-interface="${entry.id}" aria-selected="${entry.id === interfaceId}">
        ${escape(entry.label)}</button>`).join('')}</div>
      <p class="ci-card-note">Approved by <strong>${escape(roleName(INTERFACES.find(e => e.id === interfaceId).approver))}</strong>
        · destination <strong>mock ${escape(INTERFACES.find(e => e.id === interfaceId).destination)}</strong>
        · ${counts.failed ? `${counts.failed} failed posting(s)` : 'no failed postings'}</p>
      <div class="ci-filters">${QUEUES.map(status =>
    `<button type="button" class="ci-bucket${status === queue ? ' is-on' : ''}" data-ap-queue="${status}">
        ${escape(QUEUE_LABEL[status])} <small>${num(countOf(status))}</small></button>`).join('')}</div>
      ${message ? `<p class="ci-actions-note" role="status">${escape(message)}</p>` : ''}
      <div class="ci-split">
        <div class="ci-split-main">${queueTable(proposals, detail?.proposal.id)}</div>
        ${detail ? `<aside class="ci-drawer" aria-label="Proposal detail">${drawer(detail, session)}</aside>` : ''}
      </div>`;
  }

  async function loadSession() {
    const payload = await request('/session');
    session = payload.session;
    demo = payload.demo;
  }

  async function load() {
    try {
      const payload = await request(`/outbound?interfaceId=${interfaceId}&status=${queue}&limit=200`);
      proposals = payload.proposals;
      reconciliation = payload.reconciliation;
    } catch (error) { message = error.message; }
    render();
  }

  async function open(id) {
    try { detail = await request(`/outbound/${id}`); }
    catch (error) { message = error.message; detail = null; }
    render();
  }

  async function act(action) {
    const id = detail?.proposal.id;
    try {
      if (action === 'close') { detail = null; message = ''; render(); return; }
      const result = await request(`/outbound/${id}/${action}`, { method: 'POST', body: {} });
      message = action === 'post'
        ? `Posted. mock ${result.response.destination} acknowledged `
          + `${result.response.fieldsWritten.join(', ')} (correlation `
          + `${String(result.response.correlationId).slice(0, 8)}). The destination now holds the `
          + 'new value; SYNCHRO 4D\u2019s own copy refreshes on the next inbound sync.'
        : `${result.status ?? 'Done'}.`;
      queue = result.proposal?.status ?? queue;
      await load();
      await open(id);
    } catch (error) {
      // The server's own refusal, including a role refusal or a held conflict.
      message = error.message;
      await load();
      if (id) await open(id);
    }
  }

  root.onclick = event => {
    const tab = event.target.closest('[data-ap-interface]');
    if (tab) { interfaceId = tab.dataset.apInterface; detail = null; message = ''; void load(); return; }
    const bucket = event.target.closest('[data-ap-queue]');
    if (bucket) { queue = bucket.dataset.apQueue; detail = null; void load(); return; }
    const button = event.target.closest('[data-ap-action]');
    if (button) { void act(button.dataset.apAction); return; }
    const row = event.target.closest('[data-ap-proposal]');
    if (row) void open(row.dataset.apProposal);
  };

  root.onchange = async event => {
    if (event.target.dataset?.ap !== 'role') return;
    const role = event.target.value;
    if (!role) { setSessionToken(null); session = null; render(); return; }
    const issued = await request('/session', { method: 'POST', body: { role } });
    setSessionToken(issued.token);
    await loadSession();
    message = `Demo session issued as ${issued.label}. This is not authentication — see the note above.`;
    await load();
    if (detail) await open(detail.proposal.id);
  };

  render();
  // The session is read on every load, not only when a token exists: `demo` carries the banner
  // that says this is not authentication, and a screen that only warns you once you are holding
  // a session warns you too late.
  const ready = (async () => { await loadSession(); await load(); })();
  return { root, ready, reload: load, destroy() { root.remove(); } };
}
