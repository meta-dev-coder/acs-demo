/**
 * The Mapping Workbench: one table, one contextual drawer.
 *
 * The table is the list of elements and where each one's chain stops. The drawer is the chain
 * itself, its findings, its candidates and its proposals — opened for the row the operator chose
 * and closed again, rather than a second page or a modal over a modal.
 *
 * Every figure comes from the server. Nothing here recomputes a status: the mapping layer decided
 * it, and a screen that reached a different conclusion would be a second opinion nobody asked for.
 */
import { escape, num, request, roleName, currentRole, toneOf, when } from './ciClient.js';

const BASIS_NOTE = Object.freeze({
  SOURCE: 'published by the source system',
  UNAMBIGUOUS: 'the only candidate, so there was nothing to choose',
  APPROVED: 'chosen by a reviewer and approved by its data owner',
  UNRESOLVED: 'several candidates and nobody has chosen',
  NONE: 'nothing to link to',
});

function summaryBar(summary) {
  const cell = (label, value, note = '') =>
    `<div><dt>${escape(label)}</dt><dd>${num(value)}</dd>${note ? `<small>${escape(note)}</small>` : ''}</div>`;
  return `<dl class="ci-summary">
      ${cell('Elements', summary.elements)}
      ${cell('Complete chain', summary.complete)}
      ${cell('Awaiting a BOQ choice', summary.needsSelection)}
      ${cell('Chain broken', summary.incomplete)}
      ${cell('Linked by approval', summary.activityApproved + summary.boqApproved, 'not by the source')}
    </dl>`;
}

function filterBar(facets, filters) {
  const select = (name, label, values) => `<label class="ci-filter">
      <span>${escape(label)}</span>
      <select data-filter="${escape(name)}">
        <option value="">All</option>
        ${values.map(value => `<option value="${escape(value)}"${filters[name] === value ? ' selected' : ''}>${escape(value)}</option>`).join('')}
      </select></label>`;
  return `<div class="ci-filters">
      <label class="ci-filter ci-filter--search"><span>Search</span>
        <input type="search" data-filter="query" value="${escape(filters.query ?? '')}"
               placeholder="Element, activity, WBS or BOQ"></label>
      ${select('level', 'Floor', facets.level)}
      ${select('zone', 'Zone', facets.zone)}
      ${select('discipline', 'Discipline', facets.discipline)}
      ${select('wbs', 'WBS', facets.wbs)}
      ${select('status', 'Status', facets.status)}
      ${select('rule', 'Exception', facets.rule)}
    </div>`;
}

function tableMarkup({ rows, total, limit }) {
  if (!rows.length) return '<p class="ci-status">No element matches these filters.</p>';
  return `<table class="ci-table ci-table--rows">
      <thead><tr>
        <th scope="col">Element</th><th scope="col">Activity</th><th scope="col">P6 WBS</th>
        <th scope="col">SAP WBS</th><th scope="col">BOQ</th><th scope="col">Floor / zone</th>
        <th scope="col">Status</th><th scope="col">Findings</th>
      </tr></thead>
      <tbody>${rows.map(row => `<tr data-element="${escape(row.element_id)}" tabindex="0">
        <th scope="row">${escape(row.element_id)}</th>
        <td>${escape(row.activity_id ?? '—')}</td>
        <td>${escape(row.p6_wbs_code ?? '—')}</td>
        <td>${escape(row.sap_wbs_code ?? '—')}</td>
        <td>${escape(row.boq_code ?? (row.boq_candidates > 1 ? `${row.boq_candidates} candidates` : '—'))}</td>
        <td>${escape(row.level ?? '')} · ${escape(row.zone ?? '')}</td>
        <td><span class="ci-chip" data-tone="${escape(toneOf(row.status))}">${escape(row.status.replace(/_/g, ' ').toLowerCase())}</span></td>
        <td>${row.errors ? `<span class="ci-chip" data-tone="bad">${row.errors} error</span>` : ''}
            ${row.warnings ? `<span class="ci-chip" data-tone="warn">${row.warnings} warning</span>` : ''}
            ${!row.errors && !row.warnings ? '—' : ''}</td>
      </tr>`).join('')}</tbody>
      <caption>${num(rows.length)} of ${num(total)} element(s)${total > limit ? ` · showing the first ${num(limit)}` : ''}</caption>
    </table>`;
}

function chainMarkup(detail) {
  return `<ol class="ci-chain">${detail.chain.map(step => `<li data-basis="${escape(step.basis)}">
      <span class="ci-chain-step">${escape(step.step)}</span>
      <span class="ci-chain-id">${escape(step.id ?? 'not linked')}</span>
      <small>${escape(step.system)} · ${escape(BASIS_NOTE[step.basis] ?? step.basis)}</small>
    </li>`).join('')}</ol>`;
}

function drawerMarkup(detail, { suggestions, busy }) {
  const mapping = detail.mapping;
  const version = detail.modelVersion;
  const findings = detail.validation;
  const candidates = detail.boqCandidates;
  return `<header class="ci-drawer-head">
      <div>
        <span class="ci-card-id">BIM element</span>
        <h2>${escape(mapping.element_id)}</h2>
      </div>
      <button type="button" class="ci-button ci-button--quiet" data-action="close">Close</button>
    </header>
    <p class="ci-card-note">${escape(version
      ? `${version.model_name} v${version.version} · ${version.state} · published ${when(version.published_at)}`
      : 'No model version recorded.')}</p>

    <h3>Identifier chain</h3>
    ${chainMarkup(detail)}

    <h3>Validation</h3>
    ${findings.length ? `<ul class="ci-findings">${findings.map(entry => `<li data-tone="${escape(toneOf(entry.severity))}">
        <strong>${escape(entry.rule_id)}</strong> ${escape(entry.severity)}
        <p>${escape(entry.explanation)}</p>
        <small>Expected ${escape(entry.expected ?? '—')} · found ${escape(entry.actual ?? '—')}
          · first seen ${escape(when(entry.first_seen))}</small>
      </li>`).join('')}</ul>`
    : '<p class="ci-card-note">No open finding against this mapping.</p>'}

    ${!mapping.activity_id ? `<h3>Candidate activities</h3>
      ${busy ? '<p class="ci-card-note">Looking for candidates…</p>'
    : suggestions
      ? (suggestions.candidates.length
        ? `<ul class="ci-candidates">${suggestions.candidates.map(entry => `<li>
                <label><input type="radio" name="candidate" value="${escape(entry.activityId)}">
                  <strong>${escape(entry.activityId)}</strong> ${escape(entry.name)}
                  <span class="ci-chip" data-tone="info">${entry.confidence}% confidence</span></label>
                <ul class="ci-why">${entry.reasons.map(reason => `<li>${escape(reason)}</li>`).join('')}</ul>
              </li>`).join('')}</ul>
              <p class="ci-card-note">A suggestion is evidence for a reviewer. Nothing is applied
                until an authorised owner approves a proposal.</p>
              <label class="ci-filter"><span>Reason for the change</span>
                <input type="text" data-field="reason" placeholder="Why this activity?"></label>
              <button type="button" class="ci-button" data-action="propose-activity">Propose this mapping</button>`
        : `<p class="ci-card-note">${escape(suggestions.reason ?? 'No candidate found.')}</p>`)
      : '<button type="button" class="ci-button" data-action="suggest">Find candidate activities</button>'}`
    : ''}

    ${mapping.sap_wbs_code && !mapping.boq_code && candidates.length > 1 ? `<h3>BOQ item</h3>
      <p class="ci-card-note">SAP WBS ${escape(mapping.sap_wbs_code)} carries ${candidates.length}
        measured items. The model names none of them, so the choice is a reviewer's.</p>
      <ul class="ci-candidates">${candidates.map(item => `<li>
          <label><input type="radio" name="boq" value="${escape(item.source_id)}">
            <strong>${escape(item.source_id)}</strong> ${escape(item.description)}
            <small>${num(item.quantity)} ${escape(item.unit)} @ ${num(item.unit_rate)}</small></label>
        </li>`).join('')}</ul>
      <label class="ci-filter"><span>Reason for the change</span>
        <input type="text" data-field="boq-reason" placeholder="Why this item?"></label>
      <button type="button" class="ci-button" data-action="propose-boq">Propose this BOQ item</button>` : ''}

    ${detail.proposals.length ? `<h3>Mapping history</h3>
      <ul class="ci-findings">${detail.proposals.map(entry => `<li data-tone="${escape(entry.status === 'APPLIED' ? 'ok' : entry.status === 'HELD' ? 'warn' : 'info')}">
          <strong>${escape(entry.field)}</strong> ${escape(entry.current_value ?? 'none')} →
          ${escape(entry.proposed_value)} · ${escape(entry.status)}
          <p>${escape(entry.reason)}</p>
          <small>${escape(entry.requester)} (${escape(roleName(entry.requester_role))}) ${escape(when(entry.created_at))}${
  entry.approver ? ` · decided by ${escape(entry.approver)} (${escape(roleName(entry.approver_role))}) ${escape(when(entry.decided_at))}` : ''}</small>
          ${entry.status === 'PENDING_REVIEW' ? `<div class="ci-actions">
            <button type="button" class="ci-button" data-action="approve" data-proposal="${entry.id}">Approve as ${escape(roleName(currentRole()))}</button>
            <button type="button" class="ci-button ci-button--quiet" data-action="reject" data-proposal="${entry.id}">Reject</button>
          </div>` : ''}
          ${entry.validation_outcome && entry.status === 'HELD' ? `<p class="ci-card-note">${escape(entry.validation_outcome)}</p>` : ''}
        </li>`).join('')}</ul>` : ''}`;
}

export function installMappingWorkbench(host) {
  const root = document.createElement('div');
  root.className = 'ci-workbench';
  host.append(root);

  let data = null;
  let detail = null;
  let suggestions = null;
  let filters = {};
  let message = '';
  let busy = false;

  function render() {
    if (!data) { root.innerHTML = '<p class="ci-status">Reading the mapping layer…</p>'; return; }
    root.innerHTML = `
      ${summaryBar(data.summary)}
      ${filterBar(data.facets, filters)}
      ${message ? `<p class="ci-actions-note" role="status">${escape(message)}</p>` : ''}
      <div class="ci-split">
        <div class="ci-split-main">${tableMarkup(data)}</div>
        ${detail ? `<aside class="ci-drawer" aria-label="Mapping detail">${drawerMarkup(detail, { suggestions, busy })}</aside>` : ''}
      </div>`;
  }

  async function load() {
    const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    try { data = await request(`/mappings?${query}`); }
    catch (error) { message = `Could not read the mappings: ${error.message}`; }
    render();
  }

  async function open(elementId) {
    suggestions = null;
    try { detail = await request(`/mappings/${encodeURIComponent(elementId)}`); }
    catch (error) { message = error.message; detail = null; }
    render();
  }

  async function act(action, button) {
    const chosen = name => root.querySelector(`input[name="${name}"]:checked`)?.value ?? null;
    const field = name => root.querySelector(`[data-field="${name}"]`)?.value ?? '';
    try {
      if (action === 'close') { detail = null; suggestions = null; message = ''; render(); return; }
      if (action === 'suggest') {
        busy = true; render();
        suggestions = await request(`/suggestions?element=${encodeURIComponent(detail.mapping.element_id)}`);
        busy = false; render(); return;
      }
      if (action === 'propose-activity' || action === 'propose-boq') {
        const isActivity = action === 'propose-activity';
        const value = chosen(isActivity ? 'candidate' : 'boq');
        const reason = field(isActivity ? 'reason' : 'boq-reason').trim();
        if (!value) { message = 'Choose a candidate first. Nothing is proposed automatically.'; render(); return; }
        if (!reason) { message = 'A proposal needs a reason — it is what the approver reviews.'; render(); return; }
        const result = await request('/proposals', { method: 'POST', body: {
          elementId: detail.mapping.element_id,
          field: isActivity ? 'activity_id' : 'boq_code',
          proposedValue: value, reason,
          requester: 'Demo reviewer (this session)', requesterRole: currentRole(),
        } });
        message = `Proposed. ${isActivity ? 'A planner' : 'The Finance controller'} must approve it `
          + `(${roleName(result.approverRole)}).`;
        await open(detail.mapping.element_id);
        return;
      }
      if (action === 'approve' || action === 'reject') {
        const id = button.dataset.proposal;
        const result = await request(`/proposals/${id}/${action}`, { method: 'POST', body: {
          actor: 'Demo reviewer (this session)', actorRole: currentRole() } });
        message = action === 'approve'
          ? `Applied and revalidated: ${result.revalidation?.exceptions?.resolved ?? 0} exception(s) resolved.`
          : 'Proposal rejected. The mapping is unchanged.';
        await load();
        await open(detail.mapping.element_id);
        return;
      }
    } catch (error) {
      // The server's own words, including a refusal by role or a held proposal.
      message = error.message;
      busy = false;
      if (detail) await open(detail.mapping.element_id); else render();
    }
  }

  root.onclick = event => {
    const button = event.target.closest('button[data-action]');
    if (button) { void act(button.dataset.action, button); return; }
    const row = event.target.closest('tr[data-element]');
    if (row) void open(row.dataset.element);
  };
  root.onchange = event => {
    const name = event.target.dataset?.filter;
    if (!name) return;
    filters = { ...filters, [name]: event.target.value || undefined };
    void load();
  };

  render();
  const ready = load();
  return {
    root, ready, reload: load,
    get data() { return data; },
    /**
     * Open one element's drawer, whatever the table is currently filtered to.
     *
     * Arriving from an exception used to click the matching row — which found nothing whenever a
     * filter excluded it, leaving the previous element's drawer on screen as though it were the
     * one asked for. Clearing the filters and fetching the element directly cannot miss.
     */
    async show(elementId) {
      filters = {};
      message = '';
      await load();
      await open(elementId);
    },
    destroy() { root.remove(); },
  };
}
