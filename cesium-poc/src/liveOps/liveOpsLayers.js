/**
 * The Live Ops layers panel: what the operator can SEE.
 *
 * Deliberately separate from the explorer, which is what they are WORKING WITH. Several layers can
 * be on at once; only one category is ever in the bottom explorer. Toggling a layer here never
 * changes the explorer, and choosing a KPI never switches a layer off.
 *
 * It owns no layers of its own. Every event and infrastructure row drives the same Map Explorer
 * layer the rest of the app uses, through `layerStore`, so the two views of the corridor cannot
 * disagree. Operational Impact is the one row Live Ops owns, because it is a Live Ops overlay.
 */

import { opsIconMarkup } from './opsIcons.js';

const GROUPS = Object.freeze([
  Object.freeze({
    title: 'Corridor',
    rows: [Object.freeze({ id: 'operationalImpact', label: 'Operational Impact', owned: true })],
  }),
  Object.freeze({
    title: 'Events',
    rows: [
      Object.freeze({ id: 'incidents', label: 'Incidents', layerId: 'incidents', count: 'incidents' }),
      Object.freeze({ id: 'disabledVehicles', label: 'Disabled Vehicles', layerId: 'disabled-vehicles', count: 'disabledVehicles' }),
      Object.freeze({ id: 'closures', label: 'Closures', layerId: 'closures', count: 'closures' }),
      Object.freeze({ id: 'construction', label: 'Construction Zones', layerId: 'construction', count: 'construction' }),
      Object.freeze({ id: 'congestion', label: 'Congestion', layerId: 'congestion', count: 'congestion' }),
    ],
  }),
  Object.freeze({
    title: 'Infrastructure',
    rows: [
      Object.freeze({ id: 'cameras', label: 'Traffic Cameras', layerId: 'cameras' }),
      Object.freeze({ id: 'messageSigns', label: 'Message Signs', layerId: 'message-signs' }),
    ],
  }),
]);

/**
 * What Live Ops opens with: every operational event. An operator needs the
 * whole picture at once — that is the point of the workspace. Cameras and message signs stay off,
 * because 74 camera pins is the statewide-map clutter this view exists to avoid.
 */
export const DEFAULT_VISIBLE = Object.freeze([
  'incidents', 'closures', 'disabledVehicles', 'construction', 'congestion',
]);

export const LIVE_OPS_LAYER_GROUPS = GROUPS;
export const liveOpsRows = () => GROUPS.flatMap(group => group.rows);

/**
 * @param {HTMLElement} host
 * @param {{layerStore: object, onToggle: (id: string, on: boolean) => void,
 *          counts?: () => Record<string, number>}} deps
 */
export function installLiveOpsLayers(host, { layerStore, onToggle, counts = () => ({}) }) {
  // A button, not a panel: the map is the workspace, and a permanently open list of nine checkboxes
  // was taking a corner of it to say nothing most of the time.
  const root = document.createElement('div');
  root.className = 'liveops-layers';
  root.innerHTML = `
    <button class="liveops-layers-trigger" type="button" aria-expanded="false" aria-haspopup="dialog">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m10 3.2 6.6 3.4L10 10 3.4 6.6z"/><path d="m3.4 10 6.6 3.4L16.6 10"/><path d="m3.4 13.4 6.6 3.4 6.6-3.4"/></svg>
      <span>Layers</span><span class="liveops-layers-badge" data-liveops-active></span>
    </button>
    <div class="liveops-layers-panel" role="dialog" aria-label="Live layers" hidden>
      <div class="liveops-layers-head">
        <span>Live data layers <em>FDOT / FL511</em></span>
        <button class="liveops-layers-close" type="button" aria-label="Close layers">×</button>
      </div>
      ${GROUPS.map(group => `
        <div class="liveops-layer-group">
          <p class="liveops-layer-title">${group.title}</p>
          ${group.rows.map(row => `
            <label class="liveops-layer-row">
              <input type="checkbox" data-liveops-layer="${row.id}">
              <span class="liveops-layer-icon">${opsIconMarkup(row.id)}</span>
              <span class="liveops-layer-label">${row.label}</span>
              <span class="liveops-layer-count" data-liveops-count="${row.id}"></span>
            </label>`).join('')}
        </div>`).join('')}
    </div>`;
  host.append(root);

  const trigger = root.querySelector('.liveops-layers-trigger');
  const panel = root.querySelector('.liveops-layers-panel');

  const inputs = new Map([...root.querySelectorAll('[data-liveops-layer]')].map(input => [input.dataset.liveopsLayer, input]));
  const rowById = new Map(liveOpsRows().map(row => [row.id, row]));

  for (const [id, input] of inputs) {
    input.onchange = () => {
      const row = rowById.get(id);
      // A row that names a Map Explorer layer drives that layer; the panel keeps no private copy of
      // its state, so switching it off in the Map Explorer is reflected here too.
      if (row?.layerId) void layerStore.setVisible(row.layerId, input.checked);
      renderBadge();
      onToggle(id, input.checked);
    };
  }

  /** Open and shut. Layer choices survive both — the panel is a way in, not the state itself. */
  function setOpen(open) {
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  }
  trigger.onclick = event => { event.stopPropagation(); setOpen(panel.hidden); };
  root.querySelector('.liveops-layers-close').onclick = () => setOpen(false);
  panel.addEventListener('click', event => event.stopPropagation());
  const onDocumentClick = () => setOpen(false);
  const onKey = event => { if (event.key === 'Escape') setOpen(false); };
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKey);

  /** Reflect the layer store, so this panel and the Map Explorer always agree. */
  function syncFromLayers() {
    for (const [id, input] of inputs) {
      const row = rowById.get(id);
      if (!row?.layerId) continue;
      input.checked = ['on', 'partial'].includes(layerStore.stateOf(row.layerId));
    }
  }
  const unsubscribe = layerStore?.subscribe?.(() => { syncFromLayers(); renderBadge(); }) ?? (() => {});

  /** How many layers are on, so the closed button still says something. */
  function renderBadge() {
    const on = [...inputs.values()].filter(input => input.checked).length;
    root.querySelector('[data-liveops-active]').textContent = on ? String(on) : '';
  }

  return {
    root,
    setOpen,
    get isOpen() { return !panel.hidden; },
    syncFromLayers: () => { syncFromLayers(); renderBadge(); },
    /** Whether one row is ticked. Operational Impact has no layer, so the checkbox is the truth. */
    isOn: id => inputs.get(id)?.checked ?? false,
    set(id, on) {
      const input = inputs.get(id);
      if (!input || input.checked === on) return;
      input.checked = on;
      const row = rowById.get(id);
      if (row?.layerId) void layerStore.setVisible(row.layerId, on);
      renderBadge();
    },
    /** Live counts beside each row — blank rather than 0 while a feed has not answered. */
    renderCounts() {
      const values = counts() ?? {};
      for (const row of liveOpsRows()) {
        const element = root.querySelector(`[data-liveops-count="${row.id}"]`);
        if (!element) continue;
        const value = row.count ? values[row.count] : null;
        element.textContent = Number.isFinite(value) ? String(value) : '';
      }
    },
    destroy() {
      document.removeEventListener('click', onDocumentClick);
      document.removeEventListener('keydown', onKey);
      unsubscribe(); root.remove();
    },
  };
}
