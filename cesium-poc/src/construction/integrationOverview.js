/**
 * Integration Overview — the five pilot interfaces, as the backend actually reports them.
 *
 * Every number on this screen is a `COUNT(*)` the server ran, and every timestamp is one a real
 * synchronisation wrote. An interface that has never run says "Never run"; it does not show zero
 * records, because zero records read is a different statement from no run at all, and an operator
 * acting on the first when the second is true has been misled.
 *
 * Run Demo Sync calls the real engine. The screen does not compute a result and then ask the
 * server to agree with it.
 */
import { installSapSandboxPanel } from './sapSandboxPanel.js';
import { installSapLiveCost } from './sapLiveCost.js';
import { installOpenProjectSchedule } from './openProjectSchedule.js';

const escape = value => String(value ?? '').replace(/[&<>"]/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));

export const API = '/api/construction';

/** How each health state reads, and which way it leans. The app's own tone vocabulary. */
export const HEALTH = Object.freeze({
  HEALTHY: { label: 'Healthy', tone: 'ok' },
  PARTIAL: { label: 'Completed with errors', tone: 'warn' },
  FAILED: { label: 'Failed', tone: 'bad' },
  NEVER_RUN: { label: 'Never run', tone: 'info' },
  AWAITING_APPROVAL: { label: 'Awaiting approval', tone: 'warn' },
  NOTHING_PROPOSED: { label: 'Nothing proposed', tone: 'info' },
});

/** An absent figure is a dash, never a zero: `Number(null)` is 0 and finite. */
export const num = value => (value == null || !Number.isFinite(Number(value))
  ? '—' : Number(value).toLocaleString('en-US'));

/** A timestamp as the operator reads it, or an honest absence. */
export function when(iso) {
  if (!iso) return 'Never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function interfaceCard(entry) {
  const health = HEALTH[entry.health] ?? { label: entry.health, tone: 'info' };
  const outbound = entry.direction === 'OUTBOUND';
  const counts = outbound
    ? `<dl class="ci-card-counts">
         <div><dt>Pending</dt><dd>${num(entry.pendingApprovals)}</dd></div>
         <div><dt>Approved, not posted</dt><dd>${num(entry.approvedNotPosted)}</dd></div>
         <div><dt>Posted</dt><dd>${num(entry.postedCount)}</dd></div>
         <div><dt>Held</dt><dd>${num(entry.heldCount)}</dd></div>
       </dl>
       <p class="ci-card-note">Approval by <strong>${escape(entry.approver)}</strong>.
         ${escape(entry.writeBack?.reason ?? '')}</p>`
    : `<dl class="ci-card-counts">
         <div><dt>Last run</dt><dd>${escape(when(entry.lastRunAt))}</dd></div>
         <div><dt>Records read</dt><dd>${num(entry.recordsRead)}</dd></div>
         <div><dt>Created</dt><dd>${num(entry.recordsCreated)}</dd></div>
         <div><dt>Updated</dt><dd>${num(entry.recordsUpdated)}</dd></div>
         <div><dt>Unchanged</dt><dd>${num(entry.recordsUnchanged)}</dd></div>
         <div><dt>Errors</dt><dd>${num(entry.errorCount)}</dd></div>
       </dl>`;
  return `<article class="ci-card" data-interface="${escape(entry.id)}" data-tone="${escape(health.tone)}">
      <header>
        <span class="ci-card-id">${escape(entry.id)}</span>
        <span class="ci-card-health" data-tone="${escape(health.tone)}">${escape(health.label)}</span>
      </header>
      <h3>${escape(entry.label)}</h3>
      <p class="ci-card-moves">${escape(entry.moves)}</p>
      ${counts}
      <p class="ci-card-control">${escape(entry.control)}</p>
      <div class="ci-actions">
        <button type="button" class="ci-button ci-button--quiet" data-action="history"
          data-interface="${escape(entry.id)}">Sync history</button>
        ${outbound ? `<button type="button" class="ci-button ci-button--quiet" data-action="approvals">
          Approval Center</button>` : ''}
      </div>
    </article>`;
}

function totalsMarkup(report) {
  const rows = [
    ['WBS nodes', report.totals.wbs, report.source.wbs + report.source.sapWbs],
    ['Activities', report.totals.activities, report.source.activities],
    ['Model versions', report.totals.modelVersions, report.source.modelVersions],
    ['BIM elements', report.totals.elements, report.source.elements],
    ['BOQ items', report.totals.boqItems, report.source.boqItems],
    ['Cost records', report.totals.costRecords, report.source.costRecords],
  ];
  return `<table class="ci-table">
      <caption>In SYNCHRO 4D, against what the source systems hold</caption>
      <thead><tr><th scope="col">Record</th><th scope="col">Synced</th><th scope="col">In source</th></tr></thead>
      <tbody>${rows.map(([label, synced, source]) =>
    `<tr><th scope="row">${escape(label)}</th><td>${num(synced)}</td><td>${num(source)}</td></tr>`).join('')}</tbody>
    </table>`;
}

function scenarioMarkup(scenarios) {
  if (!scenarios?.length) return '';
  return `<section class="ci-ws-body">
      <h2>Deliberate inconsistencies in the seed data</h2>
      <p class="ci-card-note">Seeded on purpose, so the mapping and approval phases have something
        real to detect. None of these is a defect.</p>
      <ul class="ci-ws-list">${scenarios.map(entry =>
    `<li><strong>Scenario ${escape(entry.scenario)}</strong> — ${escape(entry.detail)}</li>`).join('')}</ul>
    </section>`;
}

/**
 * Mount the screen.
 *
 * @param {HTMLElement} host
 * @param {{fetchJson?: Function}} [deps] overridable so a test can drive it without a server
 */
export function installIntegrationOverview(host, {
  fetchJson = defaultFetch, onOpenHistory = null, onOpenApprovals = null,
} = {}) {
  /**
   * Three subtabs (Phase 7C, extended in Phase 8A).
   *
   * The pilot interfaces and the live reads are different kinds of claim — one is a local
   * `COUNT(*)` over synthetic records, the others are real external systems — and interleaving
   * them on one scroll is how a viewer comes away thinking the synthetic figures are live. They
   * are separated, and each is reachable in one click.
   *
   * The two live sources also get a tab EACH rather than one "live data" tab: SAP cost and the
   * OpenProject schedule are unrelated systems holding unrelated records, and a single tab would
   * invite exactly the inference — that the cost belongs to the schedule — that neither supports.
   *
   * Panes are hidden with `hidden`, not unmounted: an in-flight SAP request must survive a tab
   * switch, and remounting would re-read SAP every time someone looked at it.
   */
  const tabs = document.createElement('div');
  tabs.className = 'ci-subtabs';
  tabs.setAttribute('role', 'tablist');
  host.append(tabs);

  const panes = document.createElement('div');
  panes.className = 'ci-subtab-panes';
  host.append(panes);

  const overviewPane = document.createElement('div');
  overviewPane.className = 'ci-subtab-pane';
  overviewPane.id = 'ci-pane-overview';
  overviewPane.setAttribute('role', 'tabpanel');
  panes.append(overviewPane);

  const costPane = document.createElement('div');
  costPane.className = 'ci-subtab-pane';
  costPane.id = 'ci-pane-sap-cost';
  costPane.setAttribute('role', 'tabpanel');
  costPane.hidden = true;
  panes.append(costPane);

  const schedulePane = document.createElement('div');
  schedulePane.className = 'ci-subtab-pane';
  schedulePane.id = 'ci-pane-openproject';
  schedulePane.setAttribute('role', 'tabpanel');
  schedulePane.hidden = true;
  panes.append(schedulePane);

  const root = document.createElement('div');
  root.className = 'ci-overview';
  overviewPane.append(root);

  /**
   * SAP sandbox connectivity, as its own node.
   *
   * A SIBLING of `root`, not a child: `render()` below replaces `root.innerHTML` wholesale on
   * every reload, which would destroy the panel and its in-flight request. It stays on the
   * Integration Overview tab, where Phase 7A put it.
   */
  const sandbox = installSapSandboxPanel(overviewPane);

  /** The live S/4HANA read. Mounted once; it reads SAP on first show, then on demand. */
  const liveCost = installSapLiveCost(costPane);

  /**
   * The live OpenProject schedule (Phase 8A).
   *
   * Mounted once, like the other two. On mount it reads the STORED snapshot from our own database
   * and not OpenProject — opening a tab should not poll somebody else's server, and the screen has
   * to be able to show what was last seen and when. Refresh Schedule is the live read.
   */
  const schedule = installOpenProjectSchedule(schedulePane);

  const SUBTABS = [
    { id: 'overview', label: 'Pilot Interfaces', pane: overviewPane },
    { id: 'sapCost', label: 'SAP Live Cost', pane: costPane },
    { id: 'openProject', label: 'OpenProject Live Schedule', pane: schedulePane },
  ];
  let activeTab = 'overview';

  function renderTabs() {
    tabs.innerHTML = SUBTABS.map(tab => `<button type="button" role="tab"
      class="ci-subtab" data-subtab="${escape(tab.id)}"
      aria-selected="${tab.id === activeTab}" aria-controls="${escape(tab.pane.id)}"
      ${tab.id === activeTab ? 'aria-current="page"' : ''}>${escape(tab.label)}</button>`).join('');
  }

  function showTab(id) {
    if (!SUBTABS.some(tab => tab.id === id)) return;
    activeTab = id;
    for (const tab of SUBTABS) tab.pane.hidden = tab.id !== id;
    renderTabs();
  }

  tabs.onclick = event => {
    const button = event.target.closest('button[data-subtab]');
    if (button) showTab(button.dataset.subtab);
  };

  let report = null;
  let status = { state: 'loading', message: 'Reading the integration database…' };

  function render() {
    if (status.state !== 'ready') {
      root.innerHTML = `<p class="ci-status" data-state="${escape(status.state)}">${escape(status.message)}</p>`;
      return;
    }
    root.innerHTML = `
      <div class="ci-actions">
        <button type="button" class="ci-button" data-action="sync">Run Demo Sync</button>
        <button type="button" class="ci-button ci-button--quiet" data-action="reset">Reset demo data</button>
        <span class="ci-actions-note" role="status">${escape(status.note ?? '')}</span>
      </div>
      <div class="ci-cards">${report.interfaces.map(interfaceCard).join('')}</div>
      <section class="ci-ws-body">
        <h2>Records</h2>
        ${totalsMarkup(report)}
        <p class="ci-card-note">${num(report.totals.syncRuns)} synchronisation run(s) recorded,
          ${num(report.totals.errors)} error(s), ${num(report.totals.auditEvents)} audit event(s).
          Every figure here is counted from the database; nothing is written down.</p>
      </section>
      ${scenarioMarkup(report.seededScenarios)}`;
  }

  async function load() {
    try {
      report = await fetchJson(`${API}/overview`);
      status = { state: 'ready', note: status.note };
    } catch (error) {
      status = { state: 'error',
        message: `The integration database could not be read: ${error?.message ?? error}` };
    }
    render();
  }

  async function act(action, button) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = action === 'sync' ? 'Syncing…' : 'Resetting…';
    try {
      const result = await fetchJson(`${API}/${action}`, { method: 'POST', body: {} });
      report = result.overview ?? report;
      // What actually came back, not a cheerful summary of it.
      status = { state: 'ready', note: action === 'sync'
        ? (result.runs ?? []).map(run => `${run.interfaceId} ${run.status.toLowerCase()}: `
            + `${run.records_created} created, ${run.records_updated} updated, `
            + `${run.records_unchanged} unchanged`).join(' · ')
        : 'Demo data reset. The source systems are reseeded and nothing has been synced yet.' };
    } catch (error) {
      status = { state: 'ready', note: `${label} failed: ${error?.message ?? error}` };
    }
    render();
  }

  root.onclick = event => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    // The overview is where an operator starts, so it routes to where the detail lives rather
    // than restating it here.
    if (button.dataset.action === 'history') { onOpenHistory?.(button.dataset.interface); return; }
    if (button.dataset.action === 'approvals') { onOpenApprovals?.(); return; }
    void act(button.dataset.action, button);
  };

  renderTabs();
  render();
  const ready = load();
  return {
    root,
    /** Exposed so a probe can read each panel's state without reaching into the DOM. */
    sandbox,
    liveCost,
    schedule,
    showTab,
    get activeTab() { return activeTab; },
    // Reloading re-tests the connection and re-reads SAP: a stale "Connected" from ten minutes
    // ago on a screen the operator has just refreshed is the wrong claim to leave standing.
    // Reloading the schedule re-reads OUR snapshot, not OpenProject: a page refresh must not
    // issue a live request to an external system behind the operator's back.
    reload: () => Promise.all([load(), sandbox.reload(), liveCost.reload(), schedule.reload()])
      .then(() => undefined),
    get report() { return report; },
    ready: Promise.all([ready, sandbox.ready, liveCost.ready, schedule.ready])
      .then(() => undefined),
    destroy() { schedule.destroy(); liveCost.destroy(); sandbox.destroy(); root.remove(); },
  };
}

async function defaultFetch(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}
