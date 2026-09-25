/**
 * The application's left navigation bar.
 *
 * Four workspaces — Overview, Traffic, Maintenance, Safety — and, kept apart at the bottom, Layers,
 * which opens the Map Explorer. The separation is the point: the four choose WHAT the app is showing
 * you, Layers changes HOW MUCH of the map is drawn, and the map itself stays put underneath.
 *
 * Every workspace currently opens the same I-595 Cesium view; each will grow its own content later,
 * so the bar reports the choice (`onSelect`, plus `data-section` on <body>) rather than knowing what
 * any workspace means.
 *
 * Framework-free and styled entirely from the theme tokens in i595Demo.css, so light and dark come
 * from the same variables the rest of the chrome uses.
 */

/** Line icons drawn to the weight the quick rail already uses, so the two read as one set. */
const ICONS = Object.freeze({
  overview: '<path d="M3 9.5 10 4l7 5.5V16a1 1 0 0 1-1 1h-3v-5H7v5H4a1 1 0 0 1-1-1z"/>',
  traffic: '<path d="M3.5 13.5h13M4.5 13.5V10l1.8-3.6A1 1 0 0 1 7.2 6h5.6a1 1 0 0 1 .9.6L15.5 10v3.5"/><path d="M3.5 10h13"/><circle cx="6.5" cy="15.5" r="1.2"/><circle cx="13.5" cy="15.5" r="1.2"/>',
  maintenance: '<path d="M12.6 3.4a3.8 3.8 0 0 0-4.9 4.8l-4 4a1.6 1.6 0 0 0 2.2 2.3l4-4a3.8 3.8 0 0 0 4.8-4.9l-2 2-1.8-.4-.4-1.8z"/>',
  safety: '<path d="M10 3.2 4.6 5.4v4.1c0 3.2 2.2 6.1 5.4 7.3 3.2-1.2 5.4-4.1 5.4-7.3V5.4z"/><path d="m7.8 10.2 1.6 1.6 3-3.4"/>',
  // A radar sweep over the corridor: live watching, distinct from Traffic's road glyph.
  liveOps: '<circle cx="10" cy="10" r="6.8"/><circle cx="10" cy="10" r="2.6"/><path d="M10 10 14.8 5.2"/><path d="M10 3.2v1.6M10 15.2v1.6M3.2 10h1.6M15.2 10h1.6"/>',
  layers: '<path d="m10 3.2 6.6 3.4L10 10 3.4 6.6z"/><path d="m3.4 10 6.6 3.4L16.6 10"/><path d="m3.4 13.4 6.6 3.4 6.6-3.4"/>',
});

/** The workspaces, in the order they are shown. */
export const NAV_SECTIONS = Object.freeze([
  Object.freeze({ id: 'overview', label: 'Overview', icon: 'overview' }),
  Object.freeze({ id: 'traffic', label: 'Traffic', icon: 'traffic' }),
  Object.freeze({ id: 'maintenance', label: 'Maintenance', icon: 'maintenance' }),
  Object.freeze({ id: 'safety', label: 'Safety', icon: 'safety' }),
  Object.freeze({ id: 'liveOps', label: 'Live Ops', icon: 'liveOps' }),
]);

export const DEFAULT_SECTION = NAV_SECTIONS[0].id;

/** @returns {string} the section to open — a known id, otherwise the default. */
export function resolveSection(id, sections = NAV_SECTIONS) {
  return sections.some(section => section.id === id) ? id : sections[0].id;
}

const icon = name => `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">${ICONS[name] ?? ICONS.overview}</svg>`;
const item = (id, label, name, attributes) =>
  `<button class="app-nav-item" type="button" data-section="${id}" ${attributes}>${icon(name)}<span class="app-nav-label">${label}</span></button>`;

/**
 * @param {HTMLElement} host  where the bar is mounted, normally document.body
 * @param {{section?: string, layersOpen?: boolean, sections?: object[],
 *          onSelect?: (id: string) => void, onToggleLayers?: (open: boolean) => void}} [options]
 */
export function installAppNav(host, {
  section = DEFAULT_SECTION,
  layersOpen = false,
  sections = NAV_SECTIONS,
  onSelect = null,
  onToggleLayers = null,
} = {}) {
  const nav = document.createElement('nav');
  nav.className = 'app-nav';
  nav.setAttribute('aria-label', 'Workspaces');
  nav.innerHTML = `
    <div class="app-nav-sections">${sections.map(entry => item(entry.id, entry.label, entry.icon, 'aria-current="false"')).join('')}</div>
    <div class="app-nav-foot">${item('layers', 'Layers', 'layers', 'data-action="layers" aria-pressed="false" aria-controls="layer-content"')}</div>`;
  host.append(nav);

  const buttons = new Map([...nav.querySelectorAll('[data-section]')].map(button => [button.dataset.section, button]));
  // The bar mounts before the map does, so listeners are added rather than passed in at install.
  const listeners = new Set(onSelect ? [onSelect] : []);
  const layersButton = buttons.get('layers');
  let current = resolveSection(section, sections);
  let open = Boolean(layersOpen);

  function render() {
    for (const [id, button] of buttons) {
      if (id === 'layers') continue;
      button.setAttribute('aria-current', id === current ? 'page' : 'false');
    }
    layersButton.setAttribute('aria-pressed', String(open));
    // Written on <body> so panels and future workspace content can style or query the choice
    // without this module knowing about any of them.
    document.body.dataset.section = current;
    document.body.dataset.layersOpen = String(open);
  }

  function select(id, { notify = true } = {}) {
    const next = resolveSection(id, sections);
    if (next === current) { if (notify) announce(next); return next; }
    current = next;
    render();
    if (notify) announce(next);
    return next;
  }

  const announce = section => { for (const listener of [...listeners]) listener(section); };

  function setLayersOpen(next, { notify = true } = {}) {
    const wanted = Boolean(next);
    if (wanted === open) return open;
    open = wanted;
    render();
    if (notify) onToggleLayers?.(open);
    return open;
  }

  for (const [id, button] of buttons) {
    button.onclick = () => { if (id === 'layers') setLayersOpen(!open); else select(id); };
  }
  render();

  return {
    nav,
    get section() { return current; },
    get layersOpen() { return open; },
    select,
    setLayersOpen,
    /** Called whenever a workspace is chosen. Returns an unsubscribe. */
    onSelect(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { nav.remove(); delete document.body.dataset.section; delete document.body.dataset.layersOpen; },
  };
}
