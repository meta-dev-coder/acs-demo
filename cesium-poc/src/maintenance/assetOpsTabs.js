/**
 * The three subtabs of Asset Operations & Maintenance.
 *
 * Operations Overview, Case Management, Claims Intelligence. One screen, one map, one selection:
 * the tabs change which analysis is shown beside the corridor, never which corridor is on screen.
 * Built the way the Simulation Lab's sub-tabs are (a `role="tablist"` of plain buttons, arrow keys
 * between them), so the two read as one application.
 */

export const ASSET_OPS_TABS = Object.freeze([
  Object.freeze({ id: 'operations', label: 'Operations Overview' }),
  Object.freeze({ id: 'cases', label: 'Case Management' }),
  Object.freeze({ id: 'claims', label: 'Claims Intelligence' }),
]);

export const DEFAULT_TAB = 'operations';

/** A known tab id, otherwise the default. Never throws: this reads a URL among other things. */
export const resolveTab = (id, tabs = ASSET_OPS_TABS) =>
  (tabs.some(tab => tab.id === id) ? id : DEFAULT_TAB);

/**
 * @param {HTMLElement} host
 * @param {{tabs?: object[], active?: string, onSelect: (id: string) => void}} options
 */
export function installAssetOpsTabs(host, { tabs = ASSET_OPS_TABS, active = DEFAULT_TAB, onSelect }) {
  const root = document.createElement('nav');
  root.className = 'aom-tabs';
  root.setAttribute('role', 'tablist');
  root.setAttribute('aria-label', 'Asset Operations & Maintenance views');
  root.innerHTML = tabs.map(tab => `<button role="tab" type="button" data-aom-tab="${tab.id}"
    id="aom-tab-${tab.id}" aria-selected="false" tabindex="-1">${tab.label}</button>`).join('');
  host.append(root);

  const buttons = new Map([...root.querySelectorAll('[data-aom-tab]')].map(b => [b.dataset.aomTab, b]));
  let current = resolveTab(active, tabs);

  function render() {
    for (const [id, button] of buttons) {
      const selected = id === current;
      button.setAttribute('aria-selected', String(selected));
      // Roving tabindex: the tablist is one tab stop, and the arrows move within it.
      button.tabIndex = selected ? 0 : -1;
    }
  }

  function choose(id, { focus = false } = {}) {
    const next = resolveTab(id, tabs);
    if (next === current) return;
    current = next;
    render();
    if (focus) buttons.get(current)?.focus();
    onSelect?.(current);
  }

  for (const [id, button] of buttons) button.onclick = () => choose(id);

  root.onkeydown = event => {
    const order = tabs.map(tab => tab.id);
    const at = order.indexOf(current);
    if (event.key === 'ArrowRight') choose(order[(at + 1) % order.length], { focus: true });
    else if (event.key === 'ArrowLeft') choose(order[(at - 1 + order.length) % order.length], { focus: true });
    else if (event.key === 'Home') choose(order[0], { focus: true });
    else if (event.key === 'End') choose(order[order.length - 1], { focus: true });
    else return;
    event.preventDefault();
  };

  render();

  return {
    root,
    get active() { return current; },
    /** Change the tab without telling the caller about it — for restoring a view. */
    set(id) { const next = resolveTab(id, tabs); if (next === current) return; current = next; render(); },
    destroy() { root.remove(); },
  };
}
