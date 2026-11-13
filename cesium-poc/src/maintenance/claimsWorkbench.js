/**
 * Claims Intelligence, as a two-column workbench.
 *
 * Same shape and same CSS as the Case Workbench: a list on the left, one record on the right.
 * Choosing a claim changes the right column and nothing else — it does not open a case popup, an
 * incident card or a bottom browser, which is what it used to do.
 *
 * Opening the linked case and opening the linked incident are separate, explicit actions. Each
 * hands over to the one surface that owns that kind of record: the Case Workbench for a case, the
 * Asset Explorer for an incident. Neither is opened as a side effect of selecting a claim.
 */
import { escape } from '../safetyIntelligence/safetyPanels.js';
import { STATUS } from '../qcqa/schema.js';
import { STAGE_LABELS } from '../qcqa/stageValidation.js';
import {
  CLAIM_DIMENSIONS, CLAIM_STATUS_LABELS, PRODUCTION_CLAIMS, claimDimensionById, claimDossier,
  claimsBy, claimsKpis, repeatedClaims, usd,
} from './claimsIntelligence.js';
import { plainName } from './caseWorkbenchModel.js';

const STATUS_WORD = Object.freeze({ [STATUS.FAIL]: 'Fail', [STATUS.MISSING]: 'Missing' });

const TONE = Object.freeze({
  SETTLED: 'ok', APPROVED: 'ok', PENDING: 'info', NEEDS_DOCUMENTATION: 'bad', BLOCKED: 'warn',
});

const dayOnly = value => {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime())
    ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'medium' }).format(parsed) : '—';
};

/* ── the list ────────────────────────────────────────────────────────────────────────────────── */

function listMarkup(claims, filters, facets, totals, selectedId) {
  const option = (value, current) =>
    `<option value="${escape(value)}"${value === current ? ' selected' : ''}>${escape(value)}</option>`;
  return `<header class="cw-queue-head">
      <h2 class="cw-queue-title">Claims</h2>
      <input class="cw-search" type="search" data-claim-filter="query" placeholder="Search claims"
        aria-label="Search claims" value="${escape(filters.query ?? '')}">
      <div class="cw-buckets" role="group" aria-label="Claim status">
        <button type="button" class="cw-bucket" data-claim-status=""
          aria-pressed="${String(!filters.status)}">All <i>${totals.all}</i></button>
        ${Object.entries(CLAIM_STATUS_LABELS).map(([key, label]) => (totals[key]
          ? `<button type="button" class="cw-bucket" data-claim-status="${key}"
              aria-pressed="${String(filters.status === key)}">${escape(label)} <i>${totals[key]}</i></button>`
          : '')).join('')}
      </div>
      <details class="cw-more"><summary>More filters</summary>
        <div class="cw-filters">
          <label class="cw-filter"><span>Asset category</span>
            <select data-claim-filter="assetType"><option value=""${filters.assetType ? '' : ' selected'}>Any</option>
              ${facets.assetType.map(value => option(value, filters.assetType)).join('')}</select></label>
          <label class="cw-filter"><span>Incident type</span>
            <select data-claim-filter="incidentType"><option value=""${filters.incidentType ? '' : ' selected'}>Any</option>
              ${facets.incidentType.map(value => option(value, filters.incidentType)).join('')}</select></label>
        </div>
      </details>
    </header>
    ${claims.length ? `<ul class="cw-rows">${claims.map(claim => `<li>
      <button type="button" class="cw-row" data-claim="${escape(claim.demoCaseId)}"
        data-tone="${escape(TONE[claim.status] ?? 'info')}" aria-current="${String(claim.demoCaseId === selectedId)}">
        <span class="cw-row-id">${escape(claim.claimReference ?? 'Not raised')}</span>
        <span class="cw-row-status">${escape(claim.statusLabel)}</span>
        <span class="cw-row-asset">${escape(claim.assetName ?? 'Asset not recorded')}</span>
        <span class="cw-row-where">${claim.sourceIncidentId
          ? `incident ${escape(claim.sourceIncidentId)}` : 'No linked incident'} · ${escape(claim.demoCaseId)}</span>
        <span class="cw-row-when">claimed ${usd(claim.claimedUSD)} · recovered ${usd(claim.recoveredUSD)}</span>
      </button></li>`).join('')}</ul>`
      : '<p class="cw-empty">No claim matches these filters.</p>'}`;
}

/* ── the detail ──────────────────────────────────────────────────────────────────────────────── */

function kpiStrip(kpis) {
  const figure = (label, value) => `<div><em>${escape(label)}</em><span>${value}</span></div>`;
  return `<section class="cw-section"><h3>Corridor totals
      <span class="cw-section-counts">${kpis.total} claims · all synthetic</span></h3>
    <div class="cw-money">
      ${figure('Claimed', usd(kpis.claimedUSD))}
      ${figure('Recovered', usd(kpis.recoveredUSD))}
      ${figure('Outstanding', usd(kpis.outstandingUSD))}
      ${figure('Settled', String(kpis.settled))}
      ${figure('Needs documents', String(kpis.needsDocumentation))}
      ${figure('Pending', String(kpis.pending))}
    </div>
    <p class="cw-note">${escape(PRODUCTION_CLAIMS.reason)}</p>
  </section>`;
}

function dossierMarkup(dossier, { groups, dimension, repeated }) {
  const { claim, links, financial, evidence, findings, outstanding } = dossier;
  return `<header class="cw-head">
      <div class="cw-head-id">
        <h2>${escape(claim.claimReference ?? 'No claim reference yet')}</h2>
        <span class="cw-status" data-tone="${escape(TONE[claim.status] ?? 'info')}">${escape(claim.statusLabel)}</span>
      </div>
      <p class="cw-head-sum">${escape(plainName(links.assetName) || 'Asset not recorded')}</p>
      <p class="cw-head-where">${escape(claim.segment ?? 'Segment not recorded')} · case reported ${escape(dayOnly(claim.reportedAt))}</p>
      <div class="cw-head-actions">
        <button type="button" class="cw-action" data-action="open-linked-case">Open linked case ${escape(links.caseId)}</button>
        <button type="button" class="cw-action cw-action-quiet" data-action="open-linked-incident"
          ${links.sourceIncidentId ? '' : 'disabled title="This claim has no linked incident."'}>
          View linked incident${links.sourceIncidentId ? ` ${escape(links.sourceIncidentId)}` : ''}</button>
      </div>
    </header>
    <section class="cw-section"><h3>Financial breakdown</h3>
      <div class="cw-money">
        <div><em>Estimated</em><span>${usd(financial.estimatedUSD)}</span></div>
        <div><em>Approved</em><span>${usd(financial.approvedUSD)}</span></div>
        <div><em>Claimed</em><span>${usd(financial.claimedUSD)}</span></div>
        <div><em>Recovered</em><span>${usd(financial.recoveredUSD)}</span></div>
        <div><em>Outstanding</em><span>${usd(financial.outstandingUSD)}</span></div>
        <div><em>Claimed vs approved</em><span>${financial.varianceUSD == null ? '—'
          : `${financial.varianceUSD > 0 ? '+' : ''}${usd(financial.varianceUSD)}`}</span></div>
      </div>
      ${financial.basis ? `<p class="cw-note">${escape(financial.basis)}</p>` : ''}
    </section>
    <section class="cw-section"><h3>Related records</h3>
      <table class="cw-table"><tbody>
        <tr><th>ACS case</th><td>${escape(links.caseId)} <em>synthetic</em></td></tr>
        <tr><th>Asset</th><td>${escape(links.assetId ?? '—')} · ${escape(links.assetName ?? '—')} <em>synthetic</em></td></tr>
        <tr><th>Case incident</th><td>${escape(links.incidentType ?? '—')} <em>synthetic</em></td></tr>
        <tr><th>Linked real incident</th><td>${links.sourceIncidentId
          ? `${escape(links.sourceIncidentId)}${links.sourceIncidentType ? ` · ${escape(links.sourceIncidentType)}` : ''}`
          : 'None'}</td></tr>
      </tbody></table>
      <p class="cw-note">The case supplies the claim; the linked incident is a real register row whose
        location the case reuses${links.sourceIncidentType && links.incidentType
          && links.sourceIncidentType.toLowerCase() !== links.incidentType.toLowerCase()
          ? ` — and it is a different kind of event (${escape(links.sourceIncidentType)}) from this case`
          : ''}. They are not the same record.</p>
    </section>
    <section class="cw-section"><h3>Supporting evidence
        <span class="cw-section-counts">${evidence.length} held · ${findings.length} outstanding</span></h3>
      ${evidence.length ? `<ul class="cw-list">${evidence.map(entry => `<li>
        <span class="cw-list-main">${escape(entry.label)}</span>
        <span class="cw-list-note">${escape(entry.value == null ? 'Recorded' : String(entry.value))}</span></li>`).join('')}</ul>`
        : '<p class="cw-note">The claim stage holds no accepted records yet.</p>'}
    </section>
    <section class="cw-section"><h3>Claim validation findings</h3>
      ${findings.length ? `<ul class="cw-list">${findings.map(entry => `<li>
        <span class="cw-list-main">${escape(STATUS_WORD[entry.status] ?? entry.status)} · ${escape(entry.label)}</span>
        ${entry.message ? `<span class="cw-list-note">${escape(entry.message)}</span>` : ''}</li>`).join('')}</ul>
        <p class="cw-note">These are findings of this application's own validation. No insurer has
          assessed or rejected anything; the demonstration carries no insurer.</p>`
        : '<p class="cw-note">The claim stage raised no findings.</p>'}
    </section>
    <section class="cw-section"><h3>Outstanding actions</h3>
      ${outstanding.isClaimStage
        ? `<p class="cw-action-lead">${escape(outstanding.action ?? 'Nothing outstanding.')}</p>`
        : `<p class="cw-note">Nothing is outstanding on the claim itself. The case is held at the
            ${escape(STAGE_LABELS[outstanding.blockingStage] ?? 'earlier')} stage, and that is where the
            work is.</p><p class="cw-action-lead">${escape(outstanding.action ?? 'Nothing outstanding.')}</p>`}
      ${outstanding.role ? `<p class="cw-note">Assigned to ${escape(outstanding.role)}${
        outstanding.team ? ` · ${escape(outstanding.team)}` : ''}.</p>` : ''}
    </section>
    <section class="cw-section"><h3>Corridor analysis</h3>
      <label class="cw-filter cw-filter-wide"><span>Group by</span>
        <select data-claim-dimension>${CLAIM_DIMENSIONS.map(entry =>
          `<option value="${entry.id}"${entry.id === dimension.id ? ' selected' : ''}>${escape(entry.label)}</option>`).join('')}
        </select></label>
      <table class="cw-table">
        <thead><tr><th>${escape(dimension.label)}</th><th>Claims</th><th>Claimed</th><th>Recovered</th></tr></thead>
        <tbody>${groups.map(group => `<tr><th>${escape(group.value)}</th><td>${group.count}</td>
          <td>${usd(group.claimedUSD)}</td><td>${usd(group.recoveredUSD)}</td></tr>`).join('')}</tbody>
      </table>
      <p class="cw-note">${repeated.length
        ? `${repeated.length} asset(s) carry more than one claim.`
        : 'No asset in the demonstration set carries more than one claim.'}</p>
    </section>`;
}

/* ── install ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * @param {HTMLElement} host
 * @param {{onOpenCase?: Function, onOpenIncident?: Function}} deps
 */
export function installClaimsWorkbench(host, { onOpenCase = null, onOpenIncident = null, onSelect = null } = {}) {
  const root = document.createElement('section');
  root.className = 'case-workbench case-workbench--claims';
  root.hidden = true;
  root.innerHTML = '<div class="cw-queue"></div><div class="cw-main"></div>';
  host.append(root);
  const listHost = root.querySelector('.cw-queue');
  const mainHost = root.querySelector('.cw-main');

  let claims = [];
  let records = new Map();
  let unavailable = null;
  let selectedId = null;
  let filters = { query: '', status: null, assetType: null, incidentType: null };
  let dimension = 'assetType';

  const distinct = read => [...new Set(claims.map(read).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));

  function shown() {
    const query = String(filters.query ?? '').trim().toLowerCase();
    return claims.filter(claim => {
      if (filters.status && claim.status !== filters.status) return false;
      if (filters.assetType && claim.assetType !== filters.assetType) return false;
      if (filters.incidentType && claim.incidentType !== filters.incidentType) return false;
      if (query && ![claim.claimReference, claim.demoCaseId, claim.assetName, claim.sourceIncidentId, claim.statusLabel]
        .some(value => String(value ?? '').toLowerCase().includes(query))) return false;
      return true;
    });
  }

  function renderList() {
    const totals = { all: claims.length };
    for (const key of Object.keys(CLAIM_STATUS_LABELS)) totals[key] = claims.filter(c => c.status === key).length;
    const scroll = listHost.scrollTop;
    listHost.innerHTML = listMarkup(shown(), filters,
      { assetType: distinct(c => c.assetType), incidentType: distinct(c => c.incidentType) },
      totals, selectedId);
    listHost.scrollTop = scroll;
  }

  function renderMain() {
    if (unavailable) { mainHost.innerHTML = `<p class="cw-empty">${escape(unavailable)}</p>`; return; }
    const claim = claims.find(entry => entry.demoCaseId === selectedId) ?? null;
    const kpis = claimsKpis(claims);
    if (!claim) {
      mainHost.innerHTML = kpiStrip(kpis) + '<p class="cw-empty">Choose a claim from the list.</p>';
      return;
    }
    const chosen = claimDimensionById(dimension);
    mainHost.innerHTML = kpiStrip(kpis) + dossierMarkup(
      claimDossier(records.get(claim.demoCaseId) ?? null, claim),
      { groups: claimsBy(claims, chosen), dimension: chosen, repeated: repeatedClaims(claims) });
    mainHost.scrollTop = 0;
  }

  listHost.onclick = event => {
    const bucket = event.target.closest('[data-claim-status]');
    if (bucket) { filters = { ...filters, status: bucket.dataset.claimStatus || null }; renderList(); return; }
    const row = event.target.closest('[data-claim]');
    if (row) select(row.dataset.claim);
  };
  const onFilterInput = event => {
    const name = event.target.dataset.claimFilter;
    if (!name) return;
    filters = { ...filters, [name]: event.target.value || null };
    const caret = event.target.selectionStart;
    renderList();
    const next = listHost.querySelector(`[data-claim-filter="${name}"]`);
    next?.focus();
    if (next && caret != null && next.type === 'search') next.setSelectionRange(caret, caret);
  };
  listHost.oninput = onFilterInput;
  listHost.onchange = onFilterInput;

  mainHost.onclick = event => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const claim = claims.find(entry => entry.demoCaseId === selectedId);
    if (button.dataset.action === 'open-linked-case') onOpenCase?.(claim?.demoCaseId ?? null);
    if (button.dataset.action === 'open-linked-incident') onOpenIncident?.(claim?.sourceIncidentId ?? null);
  };
  mainHost.onchange = event => {
    if (!event.target.matches('[data-claim-dimension]')) return;
    dimension = event.target.value;
    renderMain();
  };

  function select(id) {
    if (!claims.some(claim => claim.demoCaseId === id)) return false;
    selectedId = id;
    renderList();
    renderMain();
    onSelect?.(id);
    return true;
  }

  return {
    root,
    get selectedId() { return selectedId; },
    select,
    setClaims(nextClaims, nextRecords, { unavailable: reason = null } = {}) {
      claims = nextClaims ?? [];
      records = new Map((nextRecords ?? []).map(record => [record.id, record]));
      unavailable = reason;
      if (!claims.some(claim => claim.demoCaseId === selectedId)) selectedId = null;
      renderList();
      renderMain();
    },
    show() { root.hidden = false; },
    hide() { root.hidden = true; },
    destroy() { root.remove(); },
  };
}
