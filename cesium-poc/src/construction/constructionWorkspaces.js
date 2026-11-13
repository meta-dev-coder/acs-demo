/**
 * The six workspaces, and the existing screens mounted underneath them.
 *
 * PHASE 10A REGROUPED, IT DID NOT REBUILD. Every screen below is the one that was already there —
 * the Integration Overview with its five interface cards, the Mapping Workbench, the Approval
 * Center, Sync History, the BIM Timeline and Changes, the synthetic Construction Progress — now
 * reached through the area that matches the question being asked rather than through a section
 * per integration. Two screens are new: Project Overview and Construction Lifecycle.
 *
 * Subtabs are LAZY. Several of these mount a Cesium context, and building all of them up front
 * would start three for screens nobody has opened; browsers cap how many a page may hold.
 *
 * `activate`/`deactivate`/`destroy` is the contract `constructionDemo.js` already uses, so the
 * page switches between areas exactly as it did before.
 */
import { CONSTRUCTION_SECTIONS } from './constructionNav.js';
import { installProjectOverview } from './projectOverview.js';
import { installConstructionLifecycle } from './constructionLifecycle.js';
import { installConstructionProgressTabs } from './constructionProgressTabs.js';
import { installIntegrationOverview } from './integrationOverview.js';
import { installMappingWorkbench } from './mappingWorkbench.js';
import { installExceptionsWorkspace } from './exceptionsWorkspace.js';
import { installApprovalCenter } from './approvalCenter.js';
import { installSyncHistory } from './syncHistory.js';
import { sharedSelection } from './selectionContext.js';

const escape = value => String(value ?? '').replace(/[&<>"]/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[character]));

/**
 * What each area is for, and which existing screens answer it.
 *
 * An area with ONE subtab renders without a tab bar — showing a lone tab is just chrome.
 */
export const AREAS = Object.freeze({
  projectOverview: {
    purpose: 'What needs attention today: schedule standing, BIM coordination, work waiting on '
      + 'somebody, and whether the connected sources are actually current.',
    subtabs: [{ id: 'overview', label: 'Overview' }],
  },
  lifecycle: {
    purpose: 'One real OpenProject activity from plan to close — its schedule, the BIM elements '
      + 'it builds, what the source reports, and what is waiting on a decision.',
    subtabs: [{ id: 'activity', label: 'Activity' }],
  },
  schedule4d: {
    purpose: 'Construction sequencing and reported progress against the model, beside the '
      + 'synthetic P6 hierarchy the demo ships with.',
    subtabs: [{ id: 'progress', label: 'Schedule & Progress' }],
  },
  bimCoordination: {
    purpose: 'Published BIM versions, what changed between any two, and the identifier chain '
      + 'every mapping rests on.',
    subtabs: [
      { id: 'bim', label: 'BIM Timeline & Changes' },
      { id: 'mapping', label: 'Mapping Workbench' },
    ],
  },
  decisions: {
    purpose: 'Investigate what did not reconcile, review the evidence, and make the approvals '
      + 'the proposal reserves for a named role.',
    subtabs: [
      { id: 'approvals', label: 'Approval Center' },
      { id: 'exceptions', label: 'Exceptions & Reconciliation' },
    ],
  },
  integrationAudit: {
    purpose: 'The five pilot interfaces, the live source connections, and the record of what ran, '
      + 'what moved and who decided.',
    subtabs: [
      // Not "Integration Overview": the screen inside this subtab has a tab of its own by that
      // name, and two nested bars carrying the same word told the reader nothing about either.
      { id: 'integration', label: 'Interfaces & Live Sources' },
      { id: 'audit', label: 'Sync History & Audit' },
    ],
  },
});

/** Which screen builds each subtab. The only place a screen is named. */
function mount(areaId, subtabId, pane, options) {
  const { openMapping, openException, openAudit, openApprovals, openSyncHistory,
    navigate, selection } = options;
  switch (`${areaId}/${subtabId}`) {
    case 'projectOverview/overview':
      return installProjectOverview(pane, { onNavigate: navigate, selection });
    case 'lifecycle/activity':
      return installConstructionLifecycle(pane, { selection, onNavigate: navigate });
    case 'schedule4d/progress':
    case 'bimCoordination/bim':
      return installConstructionProgressTabs(pane, { openMapping,
        /* A task created from geometry opens in the lifecycle, on that activity. */
        onNavigate(area, patch = null) {
          if (patch) selection?.set(patch);
          navigate?.(area);
        } });
    case 'bimCoordination/mapping':
      return installMappingWorkbench(pane);
    case 'decisions/approvals':
      return installApprovalCenter(pane);
    case 'decisions/exceptions':
      return installExceptionsWorkspace(pane,
        { onOpenMapping: openMapping, onOpenAudit: openAudit });
    case 'integrationAudit/integration':
      return installIntegrationOverview(pane,
        { onOpenHistory: openSyncHistory, onOpenApprovals: openApprovals });
    case 'integrationAudit/audit':
      return installSyncHistory(pane,
        { onOpenException: openException, onOpenMapping: openMapping });
    default:
      return null;
  }
}

/** One area: a heading, an optional subtab bar, and its panes. */
export function installConstructionWorkspace(host, section, options = {}) {
  const area = AREAS[section.id];
  const root = document.createElement('div');
  root.className = 'ci-workspace';
  root.dataset.workspace = section.id;
  root.hidden = true;

  const heading = document.createElement('div');
  heading.className = 'ci-workspace-head';
  heading.innerHTML = `<h2>${escape(section.label)}</h2>
    <p class="ci-workspace-purpose">${escape(area?.purpose ?? '')}</p>`;
  root.append(heading);

  const subtabs = area?.subtabs ?? [];
  const bar = document.createElement('div');
  bar.className = 'ci-subtabs';
  bar.setAttribute('role', 'tablist');
  const panes = document.createElement('div');
  panes.className = 'ci-subtab-panes';
  if (subtabs.length > 1) root.append(bar);
  root.append(panes);
  host.append(root);

  const paneFor = new Map();
  for (const tab of subtabs) {
    const pane = document.createElement('div');
    pane.className = 'ci-subtab-pane';
    pane.id = `ci-pane-${section.id}-${tab.id}`;
    pane.setAttribute('role', 'tabpanel');
    pane.hidden = true;
    panes.append(pane);
    paneFor.set(tab.id, pane);
  }
  bar.innerHTML = subtabs.map(tab => `<button type="button" role="tab" class="ci-subtab"
      data-area-subtab="${escape(tab.id)}"
      aria-controls="ci-pane-${escape(section.id)}-${escape(tab.id)}">${escape(tab.label)}</button>`)
    .join('');

  const mounted = new Map();
  let active = subtabs[0]?.id ?? null;

  /** Built on first SHOW, so an unopened subtab never starts a 3D context. */
  function ensure(id) {
    if (mounted.has(id)) return mounted.get(id);
    const screen = mount(section.id, id, paneFor.get(id), options);
    mounted.set(id, screen);
    return screen;
  }

  function show(id) {
    const tab = subtabs.find(entry => entry.id === id) ?? subtabs[0];
    if (!tab) return null;
    active = tab.id;
    for (const entry of subtabs) {
      paneFor.get(entry.id).hidden = entry.id !== active;
      bar.querySelector(`[data-area-subtab="${entry.id}"]`)
        ?.setAttribute('aria-selected', String(entry.id === active));
    }
    const screen = ensure(active);
    screen?.activate?.();
    return screen;
  }

  bar.onclick = event => {
    const button = event.target.closest('[data-area-subtab]');
    if (button) show(button.dataset.areaSubtab);
  };

  return {
    root,
    id: section.id,
    section,
    show,
    get active() { return active; },
    /** The screen the demo shell reaches for when routing between areas. */
    get screen() { return mounted.get(active) ?? null; },
    activate() {
      root.hidden = false;
      show(active);
    },
    deactivate() { root.hidden = true; },
    destroy() {
      for (const screen of new Set(mounted.values())) screen?.destroy?.();
      mounted.clear();
      root.remove();
    },
  };
}

/** Every area, by section id, in nav order. */
export function installConstructionWorkspaces(host, sections = CONSTRUCTION_SECTIONS,
  options = {}) {
  const selection = options.selection ?? sharedSelection();
  // `navigate` is resolved late so a screen can route to another area that does not exist yet
  // at the moment this map is built.
  const shared = { ...options, selection, navigate: target => options.navigate?.(target) };
  return new Map(sections.map(section =>
    [section.id, installConstructionWorkspace(host, section, shared)]));
}

export { AREAS as WORKSPACE_BRIEF };
