/**
 * The compact KPI strip a workspace puts over the map.
 *
 * Shared by Maintenance and Safety so the two read as one application: same card, same states, same
 * place on screen. It owns no data — a workspace hands it counts and it renders them, including the
 * honest states (loading, unavailable, failed) rather than a zero standing in for "we do not know".
 *
 * Framework-free and styled from the theme tokens, like the rest of the map chrome.
 */
import { subscribeCloudSync } from './liveDcCloudSync.js';

/** Line icons, drawn to the weight the quick rail and the left bar already use. */
/** The strip's icon set, exported so the map can draw a record as the same shape as its card. */
export const WORKSPACE_ICONS = Object.freeze({
  incident: '<path d="M10 3 2 17h16L10 3Z"/><path d="M10 8v4M10 14.5v.5"/>',
  closure: '<path d="M3 6h14v8H3z"/><path d="m6 6 3 8M11 6l3 8"/>',
  construction: '<path d="M4 16h12"/><path d="M10 4 6.5 16h7L10 4Z"/><path d="M8.4 10h3.2"/>',
  congestion: '<path d="M4.5 5.5h7v3.5h-7z"/><path d="M4.5 12h7v3.5h-7z"/><path d="M14.5 6.5v8"/><path d="m12.8 12.8 1.7 1.7 1.7-1.7"/>',
  disabledVehicle: '<path d="M3.5 13.5h13v2.5h-13z"/><path d="M5 13.5 6.5 9h7l1.5 4.5"/><circle cx="6.5" cy="16" r="1.2"/><circle cx="13.5" cy="16" r="1.2"/><path d="M10 3v3M10 7.2v.3"/>',
  ticket: '<rect x="2.5" y="5" width="15" height="10" rx="2"/><path d="M7 5v10"/><path d="M11 8.5h4M11 11.5h4"/>',
  task: '<rect x="4" y="3" width="12" height="14" rx="2"/><path d="m7 9.5 2 2 4-4"/>',
  workOrder: '<path d="M12.6 3.4a3.8 3.8 0 0 0-4.9 4.8l-4 4a1.6 1.6 0 0 0 2.2 2.3l4-4a3.8 3.8 0 0 0 4.8-4.9l-2 2-1.8-.4-.4-1.8z"/>',
  damagedAsset: '<path d="M10 3 2 17h16L10 3Z"/><path d="m7.5 11 2-2 1 2 2-2"/>',
  inspection: '<rect x="4" y="3.5" width="12" height="13" rx="2"/><path d="M7.5 2.5h5v2.5h-5z"/><path d="M7.5 9h5M7.5 12h3"/>',
  // An asset the records show to be at risk: a shield with a warning stroke through it.
  assetRisk: '<path d="M10 2.6 4 5v4.4c0 3.5 2.5 6.6 6 7.9 3.5-1.3 6-4.4 6-7.9V5l-6-2.4Z"/><path d="M10 7.4v3.1M10 12.6v.4"/>',
  // Cleared: a clock, for something that was happening and is not any more.
  cleared: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4.3l2.8 1.7"/>',
});
const icon = name => `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">${WORKSPACE_ICONS[name] ?? WORKSPACE_ICONS.workOrder}</svg>`;

/** The warning mark the app already uses in status text (main.js), so a warning needs no new styling. */
export const WARNING_ICON = '⚠';
const warned = (text, warning) => (warning && text ? `${WARNING_ICON} ${text}` : text);

/** The source pill's text: a warning leads with the icon; a normal source ends in the live dot. */
export const sourceLabelText = (text, { warning = false } = {}) => (!text ? '' : warning ? warned(text, true) : `${text} ●`);

/**
 * @param {HTMLElement} host
 * @param {{cards: {key: string, label: string, icon: string}[], label: string,
 *          onSelect: (key: string) => void}} options
 */
export function installWorkspaceStrip(host, { cards, label, onSelect }) {
  const root = document.createElement('section');
  root.className = 'ws-kpis';
  root.setAttribute('aria-label', label);
  // Icon on the left in its own tinted chip, then label, value and note stacked beside it — the
  // arrangement reads as one figure with a heading rather than three loose lines.
  // The cards scroll as a group; the source pills sit outside that scroller so "where these numbers
  // came from" is never the thing that gets scrolled off the end.
  root.innerHTML = `<div class="ws-kpi-cards">${cards.map(card => `
    <button class="ws-kpi" type="button" data-kpi="${card.key}" aria-pressed="false"
      ${card.color ? `style="--kpi-tone:${card.color}"` : ''}>
      <span class="ws-kpi-icon">${icon(card.icon)}</span>
      <span class="ws-kpi-body">
        <span class="ws-kpi-label">${card.label}</span>
        <span class="ws-kpi-number"><span class="ws-kpi-count" data-count>…</span><span class="ws-kpi-count-label" data-count-label hidden></span></span>
        <span class="ws-kpi-note" data-note>Loading…</span>
      </span>
      <span class="ws-kpi-chevron" aria-hidden="true">›</span>
    </button>`).join('')}</div>
    <span class="ws-source" data-source role="status"></span>
    <span class="ws-source" data-cloud-sync role="status" hidden></span>`;
  host.append(root);

  const buttons = new Map([...root.querySelectorAll('[data-kpi]')].map(button => [button.dataset.kpi, button]));
  for (const [key, button] of buttons) button.onclick = () => onSelect(key);

  /** Keep clear of the map toolbar, whose height and position belong to the map, not to us. */
  function measure() {
    const toolbar = document.querySelector('.map-nav')?.getBoundingClientRect();
    if (!toolbar?.width) return;
    const role = document.querySelector('.app-role')?.getBoundingClientRect();
    const controlsLeft = Math.min(toolbar.left, role?.width ? role.left : toolbar.left);
    root.style.maxWidth = `${Math.max(240, Math.round(controlsLeft) - Math.round(root.getBoundingClientRect().left) - 16)}px`;
  }
  const onResize = () => measure();
  window.addEventListener('resize', onResize);

  // Next to the source pill: whether the AWS poller is writing Live DataConnect (hidden when unknown).
  const cloudSync = root.querySelector('[data-cloud-sync]');
  const unsubscribeCloudSync = subscribeCloudSync(note => {
    cloudSync.hidden = !note;
    cloudSync.textContent = note ? sourceLabelText(note.text, note) : '';
    cloudSync.dataset.warning = String(Boolean(note?.warning));
    // The pill truncates when the strip is narrow, so its full text always stays reachable.
    const cloudTitle = note?.title ?? cloudSync.textContent;
    if (cloudTitle) cloudSync.title = cloudTitle; else cloudSync.removeAttribute('title');
  });

  return {
    root,
    measure,
    /**
     * @param {string} key
     * @param {{state: 'loading'|'ready'|'unavailable'|'error', count?: number, note?: string|null,
     *          warning?: boolean, title?: string|null}} card
     */
    set(key, { state, count, countLabel, note, warning = false, title = null }) {
      const button = buttons.get(key);
      if (!button) return;
      button.dataset.state = state;
      button.dataset.warning = String(warning);
      if (title) button.title = title; else button.removeAttribute('title');
      const countEl = button.querySelector('[data-count]');
      const noteEl = button.querySelector('[data-note]');
      const labelEl = button.querySelector('[data-count-label]');
      labelEl.textContent = countLabel ?? '';
      labelEl.hidden = state !== 'ready' || !countLabel;
      if (state === 'loading') { countEl.textContent = '…'; noteEl.textContent = 'Loading…'; return; }
      if (state !== 'ready') {
        countEl.textContent = '—';
        // A failure says what actually happened — "Sign-in required" is not "Unavailable".
        noteEl.textContent = warned(note ?? (state === 'unavailable' ? 'Unavailable' : 'Failed to load'), warning);
        return;
      }
      countEl.textContent = Number(count ?? 0).toLocaleString('en-US');
      noteEl.textContent = note ?? '';
    },
    /** Which card is being browsed, or null when the workspace is showing nothing. */
    setActive(key) {
      for (const [id, button] of buttons) button.setAttribute('aria-pressed', String(id === key));
    },
    /** Where the numbers came from. Live sources say so; nothing claims to be live that is not. */
    setSource(text, { live = false, warning = false, title = null } = {}) {
      const source = root.querySelector('[data-source]');
      source.textContent = sourceLabelText(text, { warning });
      source.hidden = !source.textContent;
      source.dataset.live = String(live);
      source.dataset.warning = String(warning);
      const full = title ?? source.textContent;
      if (full) source.title = full; else source.removeAttribute('title');
    },
    destroy() { window.removeEventListener('resize', onResize); unsubscribeCloudSync(); root.remove(); },
  };
}
