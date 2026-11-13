/**
 * The control that moves between projects.
 *
 * It NAVIGATES rather than swapping modules in place, and that is the design rather than a
 * shortcut. A page module owns `document.body`, installs a Cesium viewer, a nav bar and document
 * listeners, and exposes no teardown — so an in-page swap would leave the previous project's
 * state behind, which is exactly what must not happen. A load gives complete isolation for free.
 *
 * It sits in the nav bar beside the role control, so a project is chosen where a role is chosen.
 */
import { PROJECTS, urlForProject } from './projects.js';

/**
 * @param {HTMLElement} nav     the bar `installAppNav` returned
 * @param {string} activeId     the project currently open
 * @param {(url: string) => void} [navigate]  overridable for tests; defaults to a real load
 */
export function installProjectSwitcher(nav, activeId, {
  navigate = url => { location.href = url; },
  projects = PROJECTS,
} = {}) {
  const label = document.createElement('label');
  label.className = 'app-project';
  label.innerHTML = `<span class="app-project-caption">Project</span>
    <select aria-label="Project">${projects.map(project =>
      `<option value="${project.id}"${project.id === activeId ? ' selected' : ''}>${project.label}</option>`).join('')}</select>`;
  const select = label.querySelector('select');
  select.onchange = () => {
    if (select.value === activeId) return;
    navigate(urlForProject(select.value));
  };
  // First child, so the project is read before the role that applies within it.
  nav.prepend(label);
  return { label, select, destroy() { label.remove(); } };
}
