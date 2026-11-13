/**
 * Construction Progress, as four subtabs.
 *
 * ENHANCED, NOT REPLACED. The existing Construction Progress screen — the synthetic P6 activity
 * hierarchy, its Tower A model, its planned-versus-verified progress — becomes one subtab and is
 * mounted unchanged. The three new ones sit beside it. Rebuilding that screen to add a timeline
 * would have risked a working feature to deliver a new one.
 *
 * The four answer different questions, and keeping them apart is the point:
 *
 *   Overview            where the design and the construction each stand, side by side and
 *                       labelled, so neither can be read as the other
 *   BIM Timeline        what the published design looked like at each version
 *   BIM Changes         what changed between any two versions, element by element
 *   Schedule & Progress the existing synthetic P6 screen, untouched
 *
 * The distinction the Overview exists to protect: DESIGN EVOLUTION IS NOT CONSTRUCTION PROGRESS.
 * A model version is something somebody drew. Verified construction comes from schedule
 * activities through an approved element mapping, and where no mapping has been approved the
 * screen says so rather than estimating a number.
 *
 * Subtabs are lazy: a tab builds its screen the first time it is shown, so opening Construction
 * Progress does not start a Cesium context for a timeline nobody looked at.
 */
import { escape, num, request, when } from './ciClient.js';
import { installConstructionProgress } from './constructionProgress.js';
import { installBimTimeline } from './bimTimeline.js';
import { installBimChanges } from './bimChanges.js';
import { RUN_LABEL, WORKER_LABEL, createBimWorkspace } from './bimWorkspace.js';

export const SUBTABS = Object.freeze([
  { id: 'overview', label: 'Overview' },
  { id: 'timeline', label: 'BIM Timeline' },
  { id: 'changes', label: 'BIM Changes' },
  { id: 'schedule', label: 'Schedule & Progress' },
]);

/* ── the Overview subtab ───────────────────────────────────────────────────────────────────── */

/**
 * Verified construction progress, or an honest refusal.
 *
 * The brief's sentence, and the right one: with no approved mapping between BIM elements and
 * construction activities there is no basis for an element-level completion figure, so none is
 * produced. A plausible-looking percentage with nothing behind it is the worst thing this screen
 * could show.
 */
function constructionMarkup(summary) {
  const mapped = summary?.mappings?.approved ?? 0;
  if (!mapped) {
    return `<section class="cpt-card" data-kind="construction">
        <h3>Verified construction progress
          <span class="ci-chip" data-tone="warn">UNAVAILABLE</span></h3>
        <p class="ci-status" data-state="error" data-cpt-unavailable="true">Construction progress
          unavailable — BIM elements are not yet linked to verified construction activities.</p>
        <p class="ci-card-note">${escape(summary?.mappings?.proposed ?? 0)} mapping(s) proposed and
          awaiting approval. Link elements to activities on <strong>BIM Changes</strong>, then
          approve them as the Project Planner. Until then no completion figure is calculated,
          because there would be nothing behind it.</p>
      </section>`;
  }
  const pct = summary.construction?.weightedPercent;
  return `<section class="cpt-card" data-kind="construction">
      <h3>Verified construction progress
        <span class="ci-chip" data-tone="ok">FROM SCHEDULE ACTIVITIES</span></h3>
      <dl class="ops-facts">
        <div><dt>Approved element links</dt><dd>${escape(num(mapped))}</dd></div>
        <div><dt>Completion across mapped elements</dt>
          <dd>${pct == null ? '—' : `${escape(pct)}%`}</dd></div>
        <div><dt>Mapped elements</dt><dd>${escape(num(summary.construction?.elements ?? 0))}</dd></div>
        <div><dt>Unmapped elements</dt><dd>${escape(num(summary.construction?.unmapped ?? 0))}</dd></div>
      </dl>
      <p class="ci-card-note"><strong>Weighting assumption:</strong>
        ${escape(summary.construction?.weighting ?? 'each mapped element counts equally; no '
  + 'quantities or weights exist in this model to weight by.')}
        Completion comes from each linked activity's own reported status, never from the model.</p>
    </section>`;
}

function designMarkup(summary) {
  const latest = summary?.latest;
  const baseline = summary?.baseline;
  const since = summary?.sinceBaseline;
  if (!latest) {
    return `<section class="cpt-card" data-kind="design">
        <h3>Design evolution</h3>
        <p class="ci-card-note">No Speckle version has been converted yet. Use
          <strong>Sync Now</strong> on the Real BIM Model screen.</p></section>`;
  }
  return `<section class="cpt-card" data-kind="design">
      <h3>Design evolution
        <span class="ci-chip" data-tone="info">MODEL, NOT CONSTRUCTION</span></h3>
      <dl class="ops-facts">
        <div><dt>Selected version</dt>
          <dd>${escape(latest.label ?? '—')} <small>${escape(latest.versionId)}</small></dd></div>
        <div><dt>Latest available</dt>
          <dd>${escape(summary.latestAvailable?.label ?? '—')}
            <small>${escape(stampOf(summary.latestAvailable?.sourceCreatedAt))}</small></dd></div>
        <div><dt>Elements in this version</dt><dd>${escape(num(latest.elementCount))}</dd></div>
        <div><dt>Versions published</dt><dd>${escape(num(summary.versionCount))}</dd></div>
        ${since ? `
        <div><dt>Added since ${escape(baseline?.label ?? 'baseline')}</dt>
          <dd data-kind="ADDED">${escape(num(since.added))}</dd></div>
        <div><dt>Removed since ${escape(baseline?.label ?? 'baseline')}</dt>
          <dd data-kind="REMOVED">${escape(num(since.removed))}</dd></div>
        <div><dt>Changed shape or position</dt>
          <dd data-kind="MODIFIED">${escape(num(since.geometryChanged ?? 0))}</dd></div>
        <div><dt>Metadata only</dt>
          <dd>${escape(num((since.propertiesChanged ?? 0) + (since.reclassified ?? 0)))}</dd></div>` : ''}
      </dl>
      <p class="ci-card-note">These count what has been <strong>drawn</strong>. A version
        publication is not a construction event, and no percentage here is a completion figure.</p>
    </section>`;
}

const stampOf = iso => (iso
  ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/**
 * Speckle synchronisation, with the manual trigger.
 *
 * MOVED HERE from the Real BIM Model screen when that menu item was removed. It was the only
 * place a Speckle sync could be started by hand, and dropping the screen without bringing this
 * with it would have left no way to pull a newly published version without waiting out the
 * 60-second poll.
 */
function syncMarkup(sync, busy) {
  if (!sync) {
    return `<section class="cpt-card" data-kind="sync">
        <h3>Speckle sync <span class="ci-chip" data-tone="info">Unknown</span></h3>
        <p class="ci-card-note">The worker could not be asked.</p></section>`;
  }
  const worker = WORKER_LABEL[sync.state] ?? { label: sync.state ?? 'Unknown', tone: 'info' };
  const last = sync.lastSync;
  const result = last?.status ? RUN_LABEL[last.status] ?? { label: last.status, tone: 'info' } : null;
  return `<section class="cpt-card" data-kind="sync">
      <h3>Speckle sync
        <span class="ci-chip" data-tone="${escape(worker.tone)}"
          data-bim-worker="${escape(sync.state ?? '')}">${escape(worker.label)}</span></h3>
      <dl class="ops-facts">
        <div><dt>Automatic check</dt>
          <dd>${sync.enabled ? `Every ${escape(sync.intervalSeconds)} s` : 'Disabled'}</dd></div>
        <div><dt>Last checked</dt><dd>${last ? escape(when(last.finishedAt)) : 'Never'}</dd></div>
        <div><dt>Last result</dt><dd>${result
    ? `<span class="ci-chip" data-tone="${escape(result.tone)}"
         data-bim-run="${escape(last.status)}">${escape(result.label)}</span>` : '—'}</dd></div>
        <div><dt>Versions cached</dt><dd>${escape(num(sync.versionsCached ?? 0))}</dd></div>
      </dl>
      <div class="ci-actions">
        <button type="button" class="ci-button" data-action="speckle-sync"
          ${busy ? 'disabled' : ''}>${busy ? 'Checking…' : 'Sync Now'}</button>
      </div>
      <p class="ci-card-note">${escape(sync.cache ?? '')}</p>
    </section>`;
}

function scheduleMarkup(summary) {
  const schedule = summary?.schedule;
  if (!schedule) return '';
  return `<section class="cpt-card" data-kind="schedule">
      <h3>Schedule <span class="ci-chip" data-tone="info">${escape(schedule.sourceLabel ?? '')}</span></h3>
      <dl class="ops-facts">
        <div><dt>Live work packages</dt><dd>${escape(num(schedule.openProjectCount ?? 0))}
          <small>OpenProject, read live</small></dd></div>
        <div><dt>Synthetic P6 activities</dt><dd>${escape(num(schedule.p6Count ?? 0))}
          <small>demo data</small></dd></div>
        <div><dt>Last schedule read</dt><dd>${escape(when(schedule.lastReadAt))}</dd></div>
      </dl>
      <p class="ci-card-note">The live schedule is OpenProject; the P6 activities are this demo's
        own synthetic data and are labelled as such wherever they appear.</p>
    </section>`;
}

function installOverview(host, { fetchJson = request, onNavigate = null } = {}) {
  const root = document.createElement('div');
  root.className = 'cpt-overview';
  host.append(root);
  let summary = null;
  let error = null;
  let sync = null;
  let busy = false;
  let note = '';

  function render() {
    if (error) {
      root.innerHTML = `<p class="ci-status" data-state="error">${escape(error)}</p>`;
      return;
    }
    if (!summary) {
      root.innerHTML = '<p class="ci-status" data-state="loading">Reading the model and schedule…</p>';
      return;
    }
    root.innerHTML = `
      <p class="ops-provenance" role="note">
        <span class="ci-chip" data-tone="ok">REAL — Speckle Cloud design</span>
        <span class="ci-chip" data-tone="info">SYNTHETIC — this demo's P6 and SYNCHRO data</span>
        Design evolution and construction completion are different measurements and are never
        combined into one figure.
      </p>
      <div class="cpt-grid">
        ${designMarkup(summary)}
        ${constructionMarkup(summary)}
        ${syncMarkup(sync, busy)}
        ${scheduleMarkup(summary)}
      </div>
      ${note ? `<p class="ci-actions-note" role="status">${escape(note)}</p>` : ''}
      <div class="ci-actions cpt-actions">
        <button type="button" class="ci-button" data-go="timeline">Explore BIM Timeline</button>
        <button type="button" class="ci-button ci-button--quiet" data-go="changes">Investigate changes</button>
        <button type="button" class="ci-button ci-button--quiet" data-go="schedule">View Schedule &amp; Progress</button>
      </div>`;
    root.onclick = event => {
      const go = event.target.closest('[data-go]')?.dataset.go;
      if (go) { onNavigate?.(go); return; }
      if (event.target.closest('[data-action="speckle-sync"]')) void syncNow();
    };
  }

  async function load() {
    try {
      const [timeline, mappings, openProject, speckleSync] = await Promise.all([
        fetchJson('/speckle/timeline'),
        fetchJson('/speckle/mappings'),
        fetchJson('/openproject/work-packages').catch(() => null),
        fetchJson('/speckle/status').catch(() => null),
      ]);
      const converted = (timeline.versions ?? []).filter(entry => entry.status === 'CONVERTED');
      if (speckleSync) sync = { ...speckleSync, versionsCached: converted.length };
      const latest = converted[converted.length - 1] ?? null;
      const baseline = converted[0] ?? null;
      let sinceBaseline = null;
      if (latest && baseline && latest.versionId !== baseline.versionId) {
        const compare = await fetchJson(
          `/speckle/compare?from=${encodeURIComponent(baseline.versionId)}`
          + `&to=${encodeURIComponent(latest.versionId)}&limit=1`).catch(() => null);
        sinceBaseline = compare?.counts ?? null;
      }
      const approved = (mappings.mappings ?? []).filter(entry => entry.status === 'APPROVED');
      const proposed = (mappings.mappings ?? []).filter(entry => entry.status === 'PROPOSED');
      summary = {
        latest, baseline, latestAvailable: latest, sinceBaseline,
        versionCount: converted.length,
        mappings: { approved: approved.length, proposed: proposed.length },
        construction: approved.length ? {
          elements: approved.length,
          unmapped: Math.max(0, (latest?.elementCount ?? 0) - approved.length),
          // Stated, not hidden: with no quantities in the model there is nothing to weight by.
          weighting: 'each mapped element counts equally; this model carries no quantities or '
            + 'weights to weight by',
          weightedPercent: null,
        } : null,
        schedule: {
          sourceLabel: 'OpenProject + synthetic P6',
          openProjectCount: openProject?.activities?.length ?? 0,
          p6Count: (mappings.candidates?.p6 ?? []).length,
          lastReadAt: openProject?.lastSuccessfulFetchAt ?? null,
        },
      };
      error = null;
    } catch (cause) {
      error = `The construction API could not be reached: ${cause?.message ?? cause}`;
    }
    render();
  }

  /** Check Speckle now. The SAME worker and lock the 60-second timer uses. */
  async function syncNow() {
    busy = true;
    note = '';
    render();
    try {
      const outcome = await fetchJson('/speckle/sync', { method: 'POST', body: {} });
      sync = { ...(outcome.status ?? {}), lastSync: outcome.run ?? null };
      const run = outcome.run ?? {};
      note = outcome.unchanged
        ? 'Checked Speckle: every published version is already converted, so nothing was '
          + 'downloaded.'
        : run.versionsConverted
          ? `Converted ${run.versionsConverted} new version(s). ${outcome.effect ?? ''}`
          : run.reason ?? 'Nothing was run.';
      await load();
    } catch (cause) {
      // The server's own refusal, in its own words — including which role may do it instead.
      note = `Sync Now refused: ${cause?.message ?? cause}`;
    }
    busy = false;
    render();
  }

  render();
  const ready = load();
  return { root, get summary() { return summary; }, get sync() { return sync; },
    syncNow, reload: load, ready,
    destroy() { root.remove(); } };
}

/* ── the shell ─────────────────────────────────────────────────────────────────────────────── */

export function installConstructionProgressTabs(host, {
  openMapping = null,
  onNavigate = null,
  fetchJson = request,
  progressFactory = installConstructionProgress,
  timelineFactory = installBimTimeline,
  changesFactory = installBimChanges,
  overviewFactory = installOverview,
  workspaceFactory = createBimWorkspace,
} = {}) {
  const root = document.createElement('div');
  root.className = 'cpt-root';
  host.append(root);

  const bar = document.createElement('div');
  bar.className = 'ci-subtabs';
  bar.setAttribute('role', 'tablist');
  const panes = document.createElement('div');
  panes.className = 'ci-subtab-panes';
  root.append(bar, panes);

  /**
   * ONE store and ONE Cesium viewer for the two BIM subtabs.
   *
   * Phase 9C mounted a single screen into both panes, which is why "BIM Changes" showed the
   * timeline's controls. The screens are separate now; what they share is this — the selected
   * version, the comparison baseline, the selected IFC GlobalId and the viewer itself.
   */
  const workspace = workspaceFactory({ fetchJson });
  let workspaceLoaded = null;

  const mounted = new Map();
  const paneFor = new Map();
  for (const tab of SUBTABS) {
    const pane = document.createElement('div');
    pane.className = 'ci-subtab-pane';
    pane.id = `cpt-pane-${tab.id}`;
    pane.setAttribute('role', 'tabpanel');
    pane.hidden = true;
    panes.append(pane);
    paneFor.set(tab.id, pane);
  }

  let active = 'overview';

  bar.innerHTML = SUBTABS.map(tab => `<button type="button" role="tab"
      class="ci-subtab" data-cpt-subtab="${escape(tab.id)}"
      aria-controls="cpt-pane-${escape(tab.id)}">${escape(tab.label)}</button>`).join('');

  /**
   * Build a subtab's screen the first time it is SHOWN.
   *
   * Lazily, because the two BIM tabs drive a Cesium context. Building them up front would start
   * one for screens nobody has opened.
   */
  function ensure(id) {
    if (mounted.has(id)) return mounted.get(id);
    const pane = paneFor.get(id);
    let screen = null;
    if (id === 'overview') {
      screen = overviewFactory(pane, { fetchJson, onNavigate: show });
    } else if (id === 'timeline') {
      workspaceLoaded ??= workspace.load();
      screen = timelineFactory(pane, { workspace,
        onInvestigate: handoff => { show('changes'); void mounted.get('changes')?.focus(handoff); } });
    } else if (id === 'changes') {
      workspaceLoaded ??= workspace.load();
      screen = changesFactory(pane, { workspace, onNavigate });
    } else if (id === 'schedule') {
      screen = progressFactory(pane, { openMapping });
    }
    mounted.set(id, screen);
    return screen;
  }

  function show(id) {
    const tab = SUBTABS.find(entry => entry.id === id) ?? SUBTABS[0];
    active = tab.id;
    for (const entry of SUBTABS) {
      const pane = paneFor.get(entry.id);
      const on = entry.id === active;
      pane.hidden = !on;
      bar.querySelector(`[data-cpt-subtab="${entry.id}"]`)?.setAttribute('aria-selected', String(on));
    }
    // The Changes screen is built eagerly once the Timeline exists, so a hand-off has something
    // to focus. It costs no Cesium context — the viewer is the workspace's, not the screen's.
    if (active === 'timeline') ensure('changes');
    const screen = ensure(active);
    root.dataset.cptActive = active;
    screen?.activate?.();
  }

  bar.onclick = event => {
    const button = event.target.closest('[data-cpt-subtab]');
    if (button) show(button.dataset.cptSubtab);
  };

  show('overview');

  // Same dev-only hook the I-595 demo uses for its viewer (see i595Demo.js). It is stripped from
  // the production bundle and exists so the camera can be measured in a browser test rather than
  // eyeballed from a screenshot.
  if (import.meta.env?.DEV) window.__bim = workspace;

  return {
    root,
    show,
    get active() { return active; },
    get screens() { return mounted; },
    get workspace() { return workspace; },
    destroy() {
      for (const screen of new Set(mounted.values())) screen?.destroy?.();
      mounted.clear();
      workspace.destroy();
      root.remove();
    },
  };
}

export { installOverview };
