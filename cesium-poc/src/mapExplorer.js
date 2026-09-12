/**
 * Map Explorer — an operations control panel rather than a GIS layer tree.
 *
 * Four levels, in the order a demo actually uses them:
 *   1. a quick tool rail — the one-click surface, on screen whether or not the panel is open,
 *   2. category views (Traffic / Roads / Infrastructure) one click deep,
 *   3. the complete existing hierarchy, kept intact under "All layers".
 *
 * View presets still live in the store and are covered by its tests; they simply have no panel of
 * their own at the moment.
 *
 * Every one of those writes through the same store, so none of them can drift out of step.
 */
import { RAIL_LAYER_IDS } from './mapLayerStore.js';

/** Line icons, drawn to the same weight so the rail reads as one set. */
const ICONS = {
  explorer: '<path d="M3 6h14M3 10h14M3 14h14"/>',
  road: '<path d="M6 17 8 3M14 17 12 3M10 5v3M10 11v3"/>',
  direction: '<path d="M3 10h12M11 6l4 4-4 4"/>',
  incident: '<path d="M10 3 2 17h16L10 3Z"/><path d="M10 8v4M10 14.5v.5"/>',
  signal: '<rect x="6" y="2" width="8" height="13" rx="3"/><path d="M10 15v3"/><circle cx="10" cy="5.5" r="1.2"/><circle cx="10" cy="9" r="1.2"/><circle cx="10" cy="12.5" r="1.2"/>',
  camera: '<path d="M2.6 6.4h3l1.3-2h6.2l1.3 2h3a1.1 1.1 0 0 1 1.1 1.1v7.4a1.1 1.1 0 0 1-1.1 1.1H2.6a1.1 1.1 0 0 1-1.1-1.1V7.5a1.1 1.1 0 0 1 1.1-1.1Z"/><circle cx="10" cy="11.2" r="3.1"/>',
  bridge: '<path d="M2 8v7M18 8v7M2 11c5-5 11-5 16 0"/><path d="M7 11v4M13 11v4"/>',
  gantry: '<path d="M3 17V6h14v11"/><path d="M3 8.5h14"/><path d="M7 8.5v3M10 8.5v3M13 8.5v3"/><path d="M1.5 17h3M15.5 17h3"/>',
  barrier: '<path d="M4 17V4"/><path d="M2 17h4"/><path d="M4 8h14"/><path d="M8 8v2.5M12 8v2.5M16 8v2.5"/>',
  weather: '<circle cx="10" cy="10" r="3.4"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.5 4.5l1.5 1.5M14 14l1.5 1.5M15.5 4.5 14 6M6 14l-1.5 1.5"/>',
};
const icon = name => `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">${ICONS[name] ?? ICONS.road}</svg>`;

/**
 * @param {HTMLElement} panel  the existing `.layers` aside
 * @param {ReturnType<import('./mapLayerStore.js').createMapLayerStore>} store
 * @param {{onOpenWeather?: () => void, isExpanded?: () => boolean, onTogglePanel?: () => void}} [hooks]
 */
export function installMapExplorer(panel, store, { onOpenWeather, onTogglePanel } = {}) {
  const rail = document.createElement('div');
  rail.className = 'quick-rail';
  rail.setAttribute('role', 'toolbar');
  rail.setAttribute('aria-label', 'Quick map layers');

  const railLayers = RAIL_LAYER_IDS.map(id => store.get(id)).filter(Boolean);
  rail.innerHTML = [
    `<button id="menu-toggle" class="quick-rail-button quick-rail-explorer" type="button" aria-expanded="true" aria-controls="layer-content" title="Map explorer">${icon('explorer')}<span class="quick-rail-tip">Map explorer</span></button>`,
    '<div class="quick-rail-divider" role="separator"></div>',
    ...railLayers.map(layer =>
      `<button class="quick-rail-button" type="button" data-layer="${layer.id}" aria-pressed="false" title="${layer.label}">${icon(layer.icon)}<span class="quick-rail-tip">${layer.label}</span></button>`),
    onOpenWeather ? `<div class="quick-rail-divider" role="separator"></div><button class="quick-rail-button" type="button" data-action="weather" title="Weather">${icon('weather')}<span class="quick-rail-tip">Weather</span></button>` : '',
  ].join('');
  panel.prepend(rail);

  const content = panel.querySelector('#layer-content');
  const header = document.createElement('div');
  header.className = 'explorer-header';
  header.innerHTML = '<h2>Map Explorer</h2>';
  const categories = document.createElement('section');
  categories.className = 'layer-categories';
  categories.innerHTML = store.categories.map(category => `
    <details class="layer-category" data-category="${category.id}">
      <summary>${category.label}<span class="layer-category-count"></span></summary>
      <div class="layer-category-items">${
        store.layers.filter(layer => layer.category === category.id && !layer.members).map(layer => `
          <button class="layer-row" type="button" data-layer="${layer.id}" aria-pressed="false">
            <span class="layer-row-swatch" data-route="${layer.route ?? ''}"${layer.accent ? ` style="--road:${layer.accent}"` : ''}></span>
            <span class="layer-row-label">${layer.label}</span>
            <span class="layer-row-count" data-count="${layer.id}"></span>
            <span class="quick-layer-state" aria-hidden="true"></span>
          </button>`).join('')
      }</div>
    </details>`).join('');

  // Level 4: the complete existing hierarchy, moved wholesale rather than rebuilt.
  const advanced = document.createElement('details');
  advanced.className = 'all-layers';
  advanced.innerHTML = '<summary>All layers</summary>';
  const advancedBody = document.createElement('div');
  advancedBody.className = 'all-layers-body';
  advanced.append(advancedBody);
  while (content.firstChild) advancedBody.append(content.firstChild);
  content.append(header, categories, advanced);

  const railButtons = [...rail.querySelectorAll('[data-layer]')];
  const layerButtons = [...content.querySelectorAll('[data-layer]')];

  function render() {
    for (const button of [...railButtons, ...layerButtons]) {
      const state = store.stateOf(button.dataset.layer);
      const ready = store.isReady(button.dataset.layer);
      button.setAttribute('aria-pressed', String(state === 'on'));
      button.dataset.state = state;
      button.disabled = state === 'unavailable' || !ready;
    }
    for (const cell of content.querySelectorAll('[data-count]')) {
      const count = store.countOf(cell.dataset.count);
      cell.textContent = count == null ? '' : count.toLocaleString('en-US');
    }
    for (const category of categories.querySelectorAll('.layer-category')) {
      const ids = store.layers.filter(layer => layer.category === category.dataset.category && !layer.members).map(layer => layer.id);
      const on = ids.filter(id => store.stateOf(id) === 'on').length;
      category.querySelector('.layer-category-count').textContent = on ? `${on}` : '';
    }
  }

  for (const button of [...railButtons, ...layerButtons]) {
    button.onclick = async () => { await store.toggle(button.dataset.layer); render(); };
  }
  rail.querySelector('[data-action="weather"]')?.addEventListener('click', () => onOpenWeather?.());
  rail.querySelector('#menu-toggle').addEventListener('click', () => onTogglePanel?.());

  const unsubscribe = store.subscribe(render);
  render();

  return {
    rail, render,
    destroy() { unsubscribe(); rail.remove(); },
  };
}
