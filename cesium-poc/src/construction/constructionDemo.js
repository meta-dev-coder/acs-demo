/**
 * Construction Integration Demo — the page module.
 *
 * Shaped like `i595Demo.js` on purpose: a module that owns `document.body`, mounts its chrome and
 * its workspaces, and exports nothing. One project is open per document load (see `projects.js`),
 * so this and I-595 never run together and cannot share state.
 *
 * It demonstrates the five pilot interfaces from the Bentley integration proposal — P6, ACC/Revit
 * and SAP into SYNCHRO 4D, and approval-gated progress back out to P6 and SAP. No API is
 * connected. Every record this project will show is synthetic, which is why the badge is part of
 * the chrome rather than something each screen remembers to add.
 *
 * Phase 1 is registration and structure. The nav, the workspace shells and the project switcher
 * are live; the data, the sync engine, the mapping chain, the approvals and the audit trail are
 * phases 2 to 6.
 */
import { installAppNav } from '../appNav.js';
import { installProjectSwitcher } from '../projectSwitcher.js';
import { createThemeMode } from '../themeMode.js';
import {
  CONSTRUCTION_ROLES, CONSTRUCTION_SECTIONS, DEFAULT_CONSTRUCTION_SECTION,
} from './constructionNav.js';
import { installConstructionWorkspaces } from './constructionWorkspaces.js';
import { installGuidedDemo } from './guidedDemo.js';
import '../theme.css';
import './constructionDemo.css';

document.title = 'Construction Integration Demo · Tower A';

// The page owns the body, as I-595's does. The pre-paint loader in index.html is kept through the
// replacement and removed once the chrome is up, so there is no flash of the legacy markup.
const bootLoader = document.querySelector('#i595-boot-loader')?.outerHTML ?? '';
document.body.innerHTML = `${bootLoader}<main id="ci-root" class="ci-root" aria-label="Construction Integration Demo"></main>`;
document.body.dataset.project = 'construction-integration';

const root = document.querySelector('#ci-root');

/*
 * The standing provenance banner was REMOVED at the user's request (Phase 9E).
 *
 * What it said is still said, but per screen rather than as a permanent strip: the
 * "REAL — Speckle Cloud" / "SYNTHETIC — this demo's own BIM, P6 and SYNCHRO data" chips on the
 * BIM screens, the "DESIGN, NOT CONSTRUCTION" chip on every model-evolution figure, the
 * "SYNTHETIC — Primavera P6 demo data" chip on the OpenProject comparison, and the SAP panels'
 * own sandbox labels. So no figure on any screen is unlabelled; the claim is simply made next to
 * the number it is about instead of once at the top of the window.
 */


const workspaceHost = document.createElement('div');
workspaceHost.className = 'ci-workspaces';
root.append(workspaceHost);
/**
 * Moving between workspaces with the record in hand.
 *
 * The six modules are one workflow — mapping → exception → proposal → approval → write-back →
 * audit — and a workspace cannot reach its sibling on its own. Every route goes through here, and
 * every one carries the record rather than dropping the operator on an unfiltered list.
 */
const go = (section, show) => {
  nav.select(section);
  const screen = workspaces.get(section)?.screen;
  if (show) void Promise.resolve(screen?.ready).then(() => show(screen));
};

/*
 * The cross-workspace routes, retargeted onto the Phase 10A areas.
 *
 * The screens are the same ones; what changed is which AREA holds each, so the mapping workbench
 * is reached through BIM Coordination and the approvals through Decisions. `area(id, subtab)`
 * opens the area and then its subtab, because a route that landed on the wrong subtab would drop
 * the operator one click short of the record they asked for.
 */
const area = (sectionId, subtabId, show) => {
  nav.select(sectionId);
  const workspace = workspaces.get(sectionId);
  const screen = subtabId ? workspace?.show?.(subtabId) : workspace?.screen;
  if (show) void Promise.resolve(screen?.ready).then(() => show(screen));
};

const workspaces = installConstructionWorkspaces(workspaceHost, undefined, {
  openMapping: elementId =>
    area('bimCoordination', 'mapping', screen => screen?.show?.(elementId)),
  openException: exceptionId =>
    area('decisions', 'exceptions', screen => screen?.show?.(exceptionId)),
  openApprovals: () => area('decisions', 'approvals'),
  openAudit: subject => area('integrationAudit', 'audit', screen => screen?.show?.(subject)),
  openSyncHistory: () => area('integrationAudit', 'audit'),
  /** A screen asking to be taken somewhere by area id — Project Overview's action links. */
  navigate: target => {
    const routes = { lifecycle: ['lifecycle'], bim: ['bimCoordination', 'bim'],
      approvals: ['decisions', 'approvals'], audit: ['integrationAudit', 'audit'],
      schedule: ['schedule4d'], overview: ['projectOverview'] };
    const [sectionId, subtabId] = routes[target] ?? [target];
    if (sectionId) area(sectionId, subtabId);
  },
});

/** Show exactly one workspace, the way the I-595 shell switches its own. */
import { clearSession } from './ciClient.js';

function show(section) {
  for (const [id, workspace] of workspaces) {
    if (id === section) workspace.activate(); else workspace.deactivate();
  }
}

// eslint-disable-next-line no-use-before-define -- the nav is created just below; the callback
// above only runs on a click, by which time it exists.
const nav = installAppNav(document.body, {
  section: DEFAULT_CONSTRUCTION_SECTION,
  sections: CONSTRUCTION_SECTIONS,
  roles: CONSTRUCTION_ROLES,
  // Its own key: a role chosen here must never change which screens I-595 offers.
  roleStorageKey: 'construction-integration-role',
  onSelect: show,
});
// The bar carries no map layers in this project, so its Explorer toggle is not offered.
nav.nav.querySelector('.app-nav-foot')?.remove();

/*
 * The role in the corner is the role the SERVER enforces.
 *
 * A gated action takes its role from a server-issued session, so changing the selector has to
 * discard the old session — otherwise a person who switched to BIM Coordinator would still be
 * acting as a Planner on the one route that writes to a live system. The next gated action mints
 * a session for whatever role is current, so nothing has to be issued eagerly here.
 */
nav.nav.querySelector('.app-role select')?.addEventListener('change', () => { clearSession(); });

installProjectSwitcher(nav.nav, 'construction-integration');

// Light/dark is the reader's preference, not the project's, so it reads and writes the same key
// I-595 does. I-595 hosts the switch in its map toolbar; this project has no map, so the bar does.
const themeMode = createThemeMode();
const themeButton = document.createElement('button');
themeButton.type = 'button';
themeButton.className = 'ci-theme-toggle';
const labelTheme = () => {
  themeButton.textContent = themeMode.isLight ? 'Dark' : 'Light';
  themeButton.setAttribute('aria-label', `Switch to ${themeMode.isLight ? 'dark' : 'light'} mode`);
};
themeButton.onclick = () => { themeMode.toggle(); labelTheme(); };
labelTheme();
nav.nav.append(themeButton);

/**
 * The guided demonstration. Collapsed by default and dismissible — it is an aid, not a mode, and
 * it must never sit between an operator and the six workspaces.
 */
const guided = installGuidedDemo(root, {
  onGo: (section, options = {}) => {
    go(section);
    if (options.reloaded) for (const workspace of workspaces.values()) void workspace.screen?.reload?.();
  },
});

show(nav.section);
document.querySelector('#i595-boot-loader')?.remove();
document.documentElement.classList.remove('i595-booting');
document.body.dataset.startup = 'ready';
