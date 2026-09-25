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

/**
 * The live-event cards, each naming the Map Explorer layer that already draws it.
 *
 * They are split across two workspaces by what an operator is doing, not by where the data comes
 * from — all three are one FL511 feed. Safety is what is happening TO the corridor; Traffic is
 * planned work that is restricting it.
 */
const INCIDENT_CARD = Object.freeze({ key: 'incidents', label: 'Active incidents', icon: 'incident', layerId: 'incidents', type: LIVE_EVENT_TYPES.INCIDENT });
const CLOSURE_CARD = Object.freeze({ key: 'closures', label: 'Lane closures', icon: 'closure', layerId: 'closures', type: LIVE_EVENT_TYPES.CLOSURE });
const CONSTRUCTION_CARD = Object.freeze({ key: 'construction', label: 'Construction', icon: 'construction', layerId: 'construction', type: LIVE_EVENT_TYPES.CONSTRUCTION });

/**
 * The recorded crash history, which is not a live event at all: it comes from DataConnect and is
 * drawn by the Maintenance workspace. It sits here because it answers a safety question — what has
 * happened on this corridor — beside the one about what is happening now.
 */
const CRASH_CARD = Object.freeze({
  key: 'crashes', label: 'Recorded crashes', icon: 'incident', assetType: 'incidentRecord', source: 'maintenance',
});

const DISABLED_CARD = Object.freeze({ key: 'disabledVehicles', label: 'Disabled vehicles', icon: 'disabledVehicle', layerId: 'disabled-vehicles', type: LIVE_EVENT_TYPES.DISABLED });

export const SAFETY_CARDS = Object.freeze([INCIDENT_CARD, DISABLED_CARD, CRASH_CARD]);
const CONGESTION_CARD = Object.freeze({ key: 'congestion', label: 'Congestion', icon: 'congestion', layerId: 'congestion', type: LIVE_EVENT_TYPES.CONGESTION });

export const TRAFFIC_CARDS = Object.freeze([CLOSURE_CARD, CONSTRUCTION_CARD, CONGESTION_CARD]);

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
  // Planned roadwork has no useful severity, so it reports when the feed last spoke instead.
  const note = card.type !== LIVE_EVENT_TYPES.CONSTRUCTION && severe ? `${severe} major`
    : updated ? `Updated ${updated}` : 'On I-595 now';
  return { state: 'ready', count: mine.length, note };
}

/**
 * A card counting a DataConnect class rather than the live feed.
 *
 * The note says what a safety reader wants first — how many of those crashes hurt somebody — and a
 * class that has not loaded says so rather than showing a zero it does not know to be true.
 */
export function maintenanceCard(maintenance, card) {
  const records = maintenance?.recordsForType?.(card.assetType) ?? [];
  if (!records.length) return { state: 'loading' };
  const harmed = records.filter(item =>
    /^y/i.test(item.related?.injuries ?? '') || Number(item.related?.fatalities) > 0).length;
  const fatal = records.reduce((total, item) => total + (Number(item.related?.fatalities) || 0), 0);
  const note = fatal ? `${harmed} with injuries · ${fatal} fatal`
    : harmed ? `${harmed} with injuries` : 'None with injuries';
  return { state: 'ready', count: records.length, note };
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
 * One live-event workspace: a KPI strip whose cards switch the map layers that already draw them.
 *
 * Safety and Traffic are the same thing over different cards, so they share this rather than
 * diverging — a fix to one is a fix to both.
 *
 * @param {{cards: object[], className: string, label: string, assetExplorer: object,
 *          liveEvents: object, layerStore: object, host?: HTMLElement}} deps
 */
export function installLiveEventsWorkspace({ cards, className, label, assetExplorer, liveEvents, layerStore, maintenance = null, host = document.body }) {
  const store = assetExplorer.store;
  const root = document.createElement('div');
  root.className = className;
  root.hidden = true;
  host.append(root);

  const strip = installWorkspaceStrip(root, {
    cards, label, onSelect: key => void choose(key),
  });

  let activeKey = null, active = false;

  function render() {
    const events = liveEvents?.events ?? [];
    const payload = liveEvents?.payload ?? {};
    for (const card of cards) {
      strip.set(card.key, card.source === 'maintenance'
        ? maintenanceCard(maintenance, card)
        : safetyCard(events, card, payload));
    }
    strip.setActive(activeKey);
    const note = sourceNote(payload);
    strip.setSource(note.text, { live: note.live });
  }

  /**
   * Choosing a card shows what it counts. A live-event card switches its map layer on — the same
   * control the Map Explorer offers — while a DataConnect card asks the Maintenance workspace to
   * put its class on the map, because those records have no layer of their own.
   */
  async function choose(key) {
    const card = cards.find(item => item.key === key);
    if (!card) return;
    const put = async on => {
      if (card.source === 'maintenance') {
        if (on) await maintenance?.reveal(card.assetType); else maintenance?.hide();
        return;
      }
      await layerStore.setVisible(card.layerId, on);
    };
    if (activeKey === key) {
      activeKey = null;
      await put(false);
      render();
      return;
    }
    // One card at a time: whatever the last one put on the map comes off first.
    const previous = cards.find(item => item.key === activeKey);
    activeKey = key;
    render();
    if (previous) {
      if (previous.source === 'maintenance') maintenance?.hide();
      else await layerStore.setVisible(previous.layerId, false);
    }
    await put(true);
    render();
  }

  // The feed refreshes on its own schedule; the cards follow it without being asked.
  const stopUpdates = liveEvents?.onUpdate?.(() => render()) ?? (() => {});
  // The Map Explorer can switch these same layers off, so the cards read the layer, not their memory.
  const unsubscribeLayers = layerStore?.subscribe?.(() => {
    const on = cards.find(card => card.layerId && ['on', 'partial'].includes(layerStore.stateOf(card.layerId)));
    // A DataConnect card is not in the layer store, so its choice is this workspace's to remember.
    const active = cards.find(card => card.key === activeKey);
    if (!on && active?.source === 'maintenance') return;
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
      // A DataConnect class may still be loading when this opens; show its count as soon as it has one.
      if (cards.some(card => card.source === 'maintenance')) void maintenance?.whenReady?.().then(() => { if (active) render(); });
      strip.measure();
    },
    deactivate() {
      if (!active) return;
      active = false;
      root.hidden = true;
      // The layers belong to the map, not to this panel: switching workspace puts back what it drew.
      const card = cards.find(item => item.key === activeKey);
      activeKey = null;
      if (card?.source === 'maintenance') maintenance?.hide();
      else if (card) void layerStore.setVisible(card.layerId, false);
      if (store.getState().activeExplorerType) store.setActiveExplorerType(null);
      render();
    },
    destroy() { stopUpdates(); unsubscribeLayers(); strip.destroy(); root.remove(); },
  };
}

/** Safety: what is happening to the corridor right now. */
export const installSafetyWorkspace = deps =>
  installLiveEventsWorkspace({ ...deps, cards: SAFETY_CARDS, className: 'safety-workspace', label: 'Corridor safety' });

/** Traffic: the planned work restricting it. */
export const installTrafficWorkspace = deps =>
  installLiveEventsWorkspace({ ...deps, cards: TRAFFIC_CARDS, className: 'traffic-workspace', label: 'Corridor traffic' });
