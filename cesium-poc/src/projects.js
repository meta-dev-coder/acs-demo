/**
 * The projects this application can open.
 *
 * WHAT WAS HERE BEFORE: nothing. `entry.js` was a two-branch `if` on `?demo=i595`, with the legacy
 * SUMO toll-plaza page as its else. There was no registry, no router and no project switcher —
 * which is why this file exists rather than a new entry being "registered" with something.
 *
 * It is deliberately a LIST, not a framework. A project is an id, the words a human reads, and a
 * function that imports its page module. Adding a third is one entry.
 *
 * One project is open per document load, and switching navigates. That is not a limitation worked
 * around: a page module owns `document.body`, installs its own Cesium viewer, its own nav and its
 * own global listeners, and none of them can be torn down. A full load is the only way to
 * guarantee the isolation the brief asks for, and it is cheap.
 */

/** The query parameter that chooses the project. Unchanged: `?demo=i595` still opens I-595. */
export const PROJECT_PARAM = 'demo';

/**
 * The legacy page `entry.js` fell through to before this registry existed.
 *
 * It is not a project and is not offered in the switcher; it is what a URL with no project on it
 * has always opened, and it keeps opening it.
 */
export const LEGACY_PAGE = Object.freeze({
  id: null,
  label: 'SUMO toll-plaza flow',
  load: () => import('./main.js'),
});

export const PROJECTS = Object.freeze([
  Object.freeze({
    id: 'i595',
    label: 'I-595 Safety Twin',
    description: 'Corridor digital twin: live operations, TMC, safety intelligence and ACS asset operations.',
    /** What the pre-paint loader in index.html says while this one starts. */
    bootTitle: 'Loading I-595 Digital Twin',
    bootNote: 'Preparing the corridor map…',
    load: () => import('./i595Demo.js'),
  }),
  Object.freeze({
    id: 'construction-integration',
    label: 'Construction Integration Demo',
    description: 'SYNCHRO 4D integration with Primavera P6, ACC/Revit, and SAP.',
    bootTitle: 'Loading Construction Integration Demo',
    bootNote: 'Preparing the integration workspace…',
    /** Every record in this project is synthetic. The badge is part of the project, not the page. */
    synthetic: true,
    load: () => import('./construction/constructionDemo.js'),
  }),
  Object.freeze({
    id: 'seagirt',
    label: 'Seagirt Marine Terminal',
    description: 'Electrical digital twin: assets, connectivity, outage impact and Ask the Twin (illustrative electrical data).',
    bootTitle: 'Loading Seagirt Marine Terminal',
    bootNote: 'Preparing the electrical network…',
    /** The electrical network is illustrative until the terminal's own inventory arrives. */
    synthetic: true,
    load: () => import('./seagirt/seagirtDemo.js'),
  }),
]);

/** The project a search string asks for, or null for the legacy page. */
export function projectFor(search = typeof location === 'undefined' ? '' : location.search) {
  const wanted = new URLSearchParams(search).get(PROJECT_PARAM);
  return PROJECTS.find(project => project.id === wanted) ?? null;
}

/** The address that opens one project, keeping every other parameter the operator is carrying. */
export function urlForProject(id, search = typeof location === 'undefined' ? '' : location.search) {
  const params = new URLSearchParams(search);
  params.set(PROJECT_PARAM, id);
  return `?${params.toString()}`;
}
