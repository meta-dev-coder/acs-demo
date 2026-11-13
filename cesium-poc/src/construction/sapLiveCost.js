/**
 * SAP Live Cost — real S/4HANA project cost, read live, with its own arithmetic shown.
 *
 * Every number on this screen came from SAP in the request whose status is printed beside it.
 * Nothing is stored, nothing is cached across a reload, and when SAP cannot be reached the screen
 * says so instead of showing the last figure it saw. There is no synthetic fallback: a demo that
 * quietly substitutes a stored copy is a demo that cannot tell you the sandbox changed.
 *
 * It also shows the FILTERS, at the same rank as the total. The Phase 7B investigation found four
 * ways to produce a confident wrong number here — five parallel ledgers, server-side aggregation,
 * revenue accounts read as cost, and a hierarchy inferred from dotted codes — and in every case
 * the wrong figure looks perfectly reasonable on its own. So the ledger and the account list are
 * not configuration hidden in a file; they are the evidence, printed next to the answer.
 *
 * And it states, permanently, that RNG002 is a professional-services project. A client looking at
 * a construction demo will read any SAP cost on screen as construction cost unless told otherwise
 * every time.
 */
import { escape, request, when } from './ciClient.js';

export const SAP_COST_API = '/sap-cost';

/** How the three connection states read. The panel's own vocabulary, shared with Phase 7A. */
export const COST_STATE = Object.freeze({
  NOT_CONFIGURED: { label: 'Not configured', tone: 'warn' },
  CONNECTED: { label: 'Live from SAP', tone: 'ok' },
  FAILED: { label: 'Read failed', tone: 'bad' },
});

/**
 * A warning's severity.
 *
 * `info` is a fact worth printing; `warn` means the figure needs reading with care; `bad` means
 * the breakdown cannot be trusted. Anything unrecognised leans `warn` rather than `info`, because
 * an unknown warning is not a reassuring one.
 */
export const WARNING_TONE = Object.freeze({
  DOES_NOT_RECONCILE: 'bad',
  LEDGER_MISMATCH: 'bad',
  ACCOUNT_MISMATCH: 'bad',
  CYCLE: 'bad',
  DUPLICATE_UUID: 'bad',
  PROJECT_NOT_FOUND: 'bad',
  UNMATCHED_WBS: 'warn',
  UNRESOLVED_PARENT: 'warn',
  DETACHED: 'warn',
  MIXED_CURRENCY: 'warn',
  NO_SINGLE_TOTAL: 'warn',
  CREDIT_POSTINGS: 'warn',
  OBSOLETE_ITEMS: 'warn',
  MISSING_AMOUNT: 'warn',
  UNREADABLE_AMOUNT: 'warn',
  UNSIGNED_ROWS: 'warn',
  DUPLICATE_CODE: 'warn',
  FOREIGN_ELEMENT: 'warn',
  AMBIGUOUS_PROJECT: 'warn',
  COUNT_CHANGED: 'warn',
  DIFFERS_FROM_VERIFIED: 'warn',
  MISSING_UUID: 'warn',
  NO_SOURCE_COUNT: 'info',
});
export const warningTone = kind => WARNING_TONE[kind] ?? 'warn';

/**
 * An amount, as money.
 *
 * `null` is a dash, never a zero — `Number(null)` is 0 and finite, so the null check comes first.
 * A WBS element with no postings and one whose amount could not be read are different facts.
 */
export function money(value, currency) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const text = Number(value).toLocaleString('en-US',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${text} ${currency}` : text;
}

const stateOf = report => COST_STATE[report?.state] ?? { label: 'Unknown', tone: 'info' };

/** A date as the operator reads it. */
const day = iso => (iso ? new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' }) : '—');

/* ── the pieces ────────────────────────────────────────────────────────────────────────────── */

function headerMarkup(report) {
  const state = stateOf(report);
  const source = report.source ?? {};
  const project = report.project;
  return `<header class="slc-head">
      <div class="slc-head-main">
        <h2>${escape(project ? `${project.project} — ${project.description}` : source.projectId ?? 'SAP project')}</h2>
        <p class="slc-head-sub">${escape(source.system ?? 'SAP')} · ${escape(source.environment ?? '')}
          ${project ? `· ${escape(project.companyCode)} / ${escape(project.controllingArea)}
            · ${escape(day(project.start))} to ${escape(day(project.end))}` : ''}</p>
      </div>
      <div class="slc-head-side">
        <span class="ci-chip" data-tone="${escape(state.tone)}"
          data-cost-state="${escape(report.state)}">${escape(state.label)}</span>
        <button type="button" class="ci-button" data-action="refresh-sap">Refresh from SAP</button>
      </div>
    </header>`;
}

/** The permanent caveat. Not a footnote: the thing a viewer is most likely to get wrong. */
function caveatMarkup(source) {
  return `<p class="slc-caveat" role="note">
      <strong>Professional-services sample project — not construction data.</strong>
      ${escape(source?.notConstruction ?? '')} ${escape(source?.notLinked ?? '')}</p>`;
}

/**
 * The figures, as a compact row of facts rather than a wall of cards.
 *
 * Aggregated rows and source line items sit side by side on purpose: they differ because
 * `A_JournalEntryItemBasic` aggregates server-side, and a viewer who sees only one of them has no
 * way to know that.
 */
function summaryMarkup(report) {
  const r = report.reconciliation;
  if (!r) return '';
  const facts = [
    ['Actual cost', `<strong class="slc-total">${escape(money(r.total, r.currency))}</strong>`],
    ['WBS elements', `${escape(r.counts.wbsElements)}`],
    ['With expense', `${escape(r.counts.wbsWithExpense)}`],
    ['Unmatched references', `${escape(r.counts.unmatchedReferences)}`],
    ['Fiscal periods', escape(r.fiscalPeriods.join(', ') || '—')],
    ['Rows returned <small>aggregated by SAP</small>', `${escape(report.aggregatedRowCount ?? '—')}`],
    ['Source line items <small>SAP $count</small>',
      report.sourceRowCount == null ? 'Not reported' : `${escape(report.sourceRowCount)}`],
    ['Retrieved', `${escape(when(report.retrievedAt))}
      <small>HTTP ${escape(report.httpStatus ?? '—')} · ${escape(report.elapsedMs ?? '—')} ms</small>`],
  ];
  return `<dl class="slc-facts">${facts.map(([label, value]) =>
    `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
}

/** What was asked of SAP. Shown, not hidden, because it is what makes the total defensible. */
function filtersMarkup(filters) {
  if (!filters) return '';
  const chip = (text, tone = 'info') =>
    `<span class="ci-chip" data-tone="${tone}">${escape(text)}</span>`;
  return `<section class="slc-filters">
      <div class="slc-filter-row">
        <span class="slc-filter-label">Ledger</span>
        <span class="slc-filter-value">${chip(filters.ledger, 'ok')}
          <small>${escape(filters.ledgerReason ?? '')}</small></span>
      </div>
      <div class="slc-filter-row">
        <span class="slc-filter-label">Expense accounts</span>
        <span class="slc-filter-value">${(filters.expenseAccounts ?? [])
    .map(a => chip(`${a.account} ${a.name}`, 'ok')).join(' ')}
          <small>${escape(filters.excludedReason ?? '')}</small></span>
      </div>
      <details class="slc-excluded">
        <summary>${escape((filters.excludedAccounts ?? []).length)} account(s) deliberately excluded</summary>
        <table class="ci-table">
          <thead><tr><th scope="col">Account</th>
            <th scope="col" class="ci-col--text">Name</th>
            <th scope="col" class="ci-col--text">Why</th></tr></thead>
          <tbody>${(filters.excludedAccounts ?? []).map(a => `<tr>
            <th scope="row">${escape(a.account)}</th>
            <td class="ci-col--text">${escape(a.name)}</td>
            <td class="ci-col--text">${escape(a.reason)}</td></tr>`).join('')}</tbody>
        </table>
        <p class="ci-card-note">OData filter sent: <code>${escape(filters.odataFilter ?? '')}</code></p>
        <p class="ci-card-note">${escape(filters.paging ?? '')}</p>
      </details>
    </section>`;
}

/**
 * The WBS tree.
 *
 * Indented by `depth`, which the backend derived from `ParentObjectUUID` — never from the dotted
 * code. The parent column is shown precisely because the codes disagree with the hierarchy:
 * `RNG002.1.3` sits under `RNG002.0.2`, and seeing that is the point.
 */
function treeMarkup(report, selected, collapsed) {
  const totals = new Map((report.reconciliation?.elementTotals ?? []).map(e => [e.wbs, e]));
  const currency = report.reconciliation?.currency ?? null;
  const elements = report.elements ?? [];
  const hiddenUnder = code => {
    // An element is hidden when any ancestor is collapsed.
    let node = elements.find(e => e.code === code);
    while (node?.parentCode) {
      if (collapsed.has(node.parentCode)) return true;
      node = elements.find(e => e.code === node.parentCode);
    }
    return false;
  };
  const hasChildren = code => elements.some(e => e.parentCode === code);

  const rows = elements.filter(e => !hiddenUnder(e.code)).map(element => {
    const total = totals.get(element.code);
    const open = !collapsed.has(element.code);
    const twisty = hasChildren(element.code)
      ? `<button type="button" class="slc-twisty" data-toggle="${escape(element.code)}"
           aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${escape(element.code)}">${open ? '▾' : '▸'}</button>`
      : '<span class="slc-twisty slc-twisty--leaf"></span>';
    return `<tr data-wbs="${escape(element.code)}" tabindex="0"
        class="${selected === element.code ? 'is-selected' : ''}${total ? '' : ' slc-no-cost'}">
        <th scope="row" style="--depth:${escape(element.depth)}">
          ${twisty}<span class="slc-code">${escape(element.code)}</span>
          <small>${escape(element.description ?? '')}</small></th>
        <td class="slc-parent">${escape(element.parentCode ?? 'root')}</td>
        <td>${total ? escape(money(total.amount, currency)) : '—'}</td>
        <td>${total ? escape(total.rows) : '—'}</td>
      </tr>`;
  }).join('');

  return `<table class="ci-table ci-table--rows slc-tree">
      <caption>Hierarchy from <code>ParentObjectUUID</code>, never from the dotted code — the two
        disagree in this project. Select a row for its expense breakdown.</caption>
      <thead><tr>
        <th scope="col">WBS element</th><th scope="col" class="slc-parent">Parent</th>
        <th scope="col">Actual cost</th><th scope="col">Rows</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/** The selected element's own rows, at the level SAP aggregated them. */
function detailMarkup(report, selected) {
  if (!selected) {
    return `<p class="ci-card-note slc-detail-empty">Select a WBS element to see the journal rows
      behind its figure.</p>`;
  }
  const rows = (report.rows ?? []).filter(row => row.wbs === selected);
  const element = (report.elements ?? []).find(e => e.code === selected);
  const total = (report.reconciliation?.elementTotals ?? []).find(e => e.wbs === selected);
  const currency = report.reconciliation?.currency ?? null;
  if (!rows.length) {
    return `<div class="slc-detail">
        <h3>${escape(selected)} <small>${escape(element?.description ?? '')}</small></h3>
        <p class="ci-card-note">No expense postings on this element under the filters above. That
          is an absence of cost, not a missing read.</p>
      </div>`;
  }
  return `<div class="slc-detail">
      <h3>${escape(selected)} <small>${escape(element?.description ?? '')}</small></h3>
      <table class="ci-table">
        <thead><tr>
          <th scope="col">GL account</th><th scope="col">Period</th>
          <th scope="col">D/C</th><th scope="col">Amount</th>
        </tr></thead>
        <tbody>${rows.map(row => `<tr>
          <th scope="row">${escape(row.glAccount)}
            <small>${escape(row.glAccountName ?? '')}</small></th>
          <td>${escape(row.fiscalPeriod ?? 'Not recorded')}</td>
          <td>${escape(row.debitCredit || 'Not recorded')}</td>
          <td>${escape(money(row.amount, row.currency))}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr>
          <th scope="row">Total</th><td></td><td></td>
          <td>${escape(money(total?.amount, currency))}</td>
        </tr></tfoot>
      </table>
    </div>`;
}

function warningsMarkup(warnings) {
  if (!warnings?.length) {
    return `<p class="ci-card-note slc-clean">No warnings: the hierarchy resolved, one currency,
      one ledger, every expense row matched a WBS element, and the breakdown reconciles to the
      total.</p>`;
  }
  return `<ul class="ci-findings slc-warnings">${warnings.map(w => `
      <li data-tone="${escape(warningTone(w.kind))}">
        <strong>${escape(w.kind.replace(/_/g, ' ').toLowerCase())}</strong>
        ${escape(w.detail ?? '')}</li>`).join('')}</ul>`;
}

/* ── the screen ────────────────────────────────────────────────────────────────────────────── */

export function installSapLiveCost(host, { fetchJson = request } = {}) {
  const root = document.createElement('div');
  root.className = 'slc-root';
  host.append(root);

  let report = null;
  let error = null;
  let busy = false;
  let selected = null;
  /** Collapsed by code. Everything starts open — 13 elements fit without scrolling. */
  const collapsed = new Set();

  function render() {
    if (!report && !error) {
      root.innerHTML = '<p class="ci-status" data-state="loading">Reading project RNG002 from SAP…</p>';
      return;
    }
    if (error) {
      root.innerHTML = `<p class="ci-status" data-state="error">${escape(error)}</p>
        <div class="ci-actions"><button type="button" class="ci-button"
          data-action="refresh-sap">Refresh from SAP</button></div>`;
      return;
    }
    const failed = report.state !== 'CONNECTED';
    root.innerHTML = `
      ${headerMarkup(report)}
      ${caveatMarkup(report.source)}
      ${report.reason ? `<p class="ci-status" data-state="error">${escape(report.reason)}</p>` : ''}
      ${failed ? '' : `
        ${summaryMarkup(report)}
        ${filtersMarkup(report.filters)}
        <div class="slc-body">
          <section class="slc-tree-pane">${treeMarkup(report, selected, collapsed)}</section>
          <section class="slc-detail-pane">${detailMarkup(report, selected)}</section>
        </div>`}
      <section class="slc-foot">
        <h3>Reconciliation</h3>
        ${warningsMarkup(report.warnings)}
      </section>`;
    const button = root.querySelector('[data-action="refresh-sap"]');
    if (button && busy) { button.disabled = true; button.textContent = 'Reading SAP…'; }
  }

  async function load() {
    busy = true;
    render();
    try {
      report = await fetchJson(`${SAP_COST_API}/reconciliation`);
      error = null;
      // A selection that no longer exists must not keep a stale detail pane on screen.
      if (selected && !(report.elements ?? []).some(e => e.code === selected)) selected = null;
    } catch (failure) {
      // The endpoint answers 200 for every reported SAP state, so reaching here means our own
      // server could not be reached — which says nothing about SAP.
      report = null;
      error = `The construction API could not be reached: ${failure?.message ?? failure}. `
        + 'This is our own server, not SAP — the state of the SAP connection is unknown.';
    }
    busy = false;
    render();
  }

  root.onclick = event => {
    if (event.target.closest('[data-action="refresh-sap"]')) { void load(); return; }
    const twisty = event.target.closest('[data-toggle]');
    if (twisty) {
      const code = twisty.dataset.toggle;
      if (collapsed.has(code)) collapsed.delete(code); else collapsed.add(code);
      render();
      return;
    }
    const row = event.target.closest('tr[data-wbs]');
    if (!row) return;
    selected = selected === row.dataset.wbs ? null : row.dataset.wbs;
    render();
  };

  root.onkeydown = event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest?.('tr[data-wbs]');
    if (!row) return;
    event.preventDefault();
    selected = selected === row.dataset.wbs ? null : row.dataset.wbs;
    render();
  };

  render();
  const ready = load();
  return { root, reload: load, ready, get report() { return report; },
    destroy() { root.remove(); } };
}
