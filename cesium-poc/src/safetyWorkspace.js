/**
 * The Safety workspace: what is happening on the corridor right now.
 *
 * Two cards over the map — active incidents and lane closures — counted from the FL511 live feed the
 * app already runs, and nothing else. Choosing one switches on that existing layer, which puts its
 * markers on the map and opens the bottom browser exactly as the rail button does: no second copy of
 * the feed, no second map layer, no second selection.
 *
 * The feed is live, so zero is an answer ("none on the corridor now"), never an error or a blank.
 */
import { LIVE_EVENT_TYPES } from './liveEventsData.js';
import { installWorkspaceStrip } from './workspaceStrip.js';

/** The two cards, each naming the Map Explorer layer that already draws it. */
export const SAFETY_CARDS = Object.freeze([
  Object.freeze({ key: 'incidents', label: 'Active incidents', icon: 'incident', layerId: 'incidents', type: LIVE_EVENT_TYPES.INCIDENT }),
  Object.freeze({ key: 'closures', label: 'Lane closures', icon: 'closure', layerId: 'closures', type: LIVE_EVENT_TYPES.CLOSURE }),
]);

const time = value => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : null;
};

/**
 * What one card shows, counted from the events themselves.
 *
 * The note says something the feed actually carries: how many FL511 called out by severity, else
 * when the feed last spoke. With nothing on the corridor it says so rather than showing a bare 0.
 *
 * @param {object[]} events   the live events currently on the corridor
 * @param {{type: string}} card
 * @param {{lastUpdated?: string, sourceStatus?: string}} [payload]
 */
export function safetyCard(events, card, payload = {}) {
  const mine = (events ?? []).filter(event => event?.type === card.type);
  if (!mine.length) return { state: 'ready', count: 0, note: 'None on the corridor now' };
  const severe = mine.filter(event => /major|severe|high/i.test(String(event.severity ?? ''))).length;
  const updated = time(payload.lastUpdated);
  const note = severe ? `${severe} major` : updated ? `Updated ${updated}` : `On I-595 now`;
  return { state: 'ready', count: mine.length, note };
}

/** "FL511 · live" while the feed is current; what it really is otherwise. */
export function sourceNote(payload = {}) {
  const source = payload.source ?? 'FL511';
  const status = String(payload.sourceStatus ?? '').toUpperCase();
  if (status === 'LIVE') return { text: `${source} · live`, live: true };
  if (status === 'STALE') return { text: `${source} · stale`, live: false };
  return { text: source, live: false };
}

/**
 * @param {{assetExplorer: object, liveEvents: object, layerStore: object, host?: HTMLElement}} deps
 */
export function installSafetyWorkspace({ assetExplorer, liveEvents, layerStore, host = document.body }) {
  const store = assetExplorer.store;
  const root = document.createElement('div');
  root.className = 'safety-workspace';
  root.hidden = true;
  host.append(root);

  const strip = installWorkspaceStrip(root, {
    cards: SAFETY_CARDS, label: 'Corridor safety', onSelect: key => void choose(key),
  });

  let activeKey = null, active = false;

  function render() {
    const events = liveEvents?.events ?? [];
    const payload = liveEvents?.payload ?? {};
    for (const card of SAFETY_CARDS) strip.set(card.key, safetyCard(events, card, payload));
    strip.setActive(activeKey);
    const note = sourceNote(payload);
    strip.setSource(note.text, { live: note.live });
  }

  /** Choosing a card is switching its layer on — the same control the Map Explorer offers. */
  async function choose(key) {
    const card = SAFETY_CARDS.find(item => item.key === key);
    if (!card) return;
    if (activeKey === key) {
      activeKey = null;
      await layerStore.setVisible(card.layerId, false);
      render();
      return;
    }
    activeKey = key;
    render();
    await layerStore.setVisible(card.layerId, true);
    render();
  }

  // The feed refreshes on its own schedule; the cards follow it without being asked.
  const stopUpdates = liveEvents?.onUpdate?.(() => render()) ?? (() => {});
  // The Map Explorer can switch these same layers off, so the cards read the layer, not their memory.
  const unsubscribeLayers = layerStore?.subscribe?.(() => {
    const on = SAFETY_CARDS.find(card => ['on', 'partial'].includes(layerStore.stateOf(card.layerId)));
    const next = on?.key ?? null;
    if (next === activeKey) return;
    activeKey = next;
    render();
  }) ?? (() => {});

  return {
    root,
    get activeKey() { return activeKey; },
    choose,
    activate() {
      if (active) return;
      active = true;
      root.hidden = false;
      render();
      strip.measure();
    },
    deactivate() {
      if (!active) return;
      active = false;
      root.hidden = true;
      // The layers belong to the map, not to this panel: switching workspace puts back what it drew.
      const card = SAFETY_CARDS.find(item => item.key === activeKey);
      activeKey = null;
      if (card) void layerStore.setVisible(card.layerId, false);
      if (store.getState().activeExplorerType) store.setActiveExplorerType(null);
      render();
    },
    destroy() { stopUpdates(); unsubscribeLayers(); strip.destroy(); root.remove(); },
  };
}
