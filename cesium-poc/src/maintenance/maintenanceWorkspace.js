/**
 * The Maintenance workspace: a compact KPI strip over the map, and a list beside it.
 *
 * The map stays the workspace. This adds one strip at the top and one 340px list on the right, both
 * dismissible, and nothing else — selection, cards, details, fly-to and highlighting are the Asset
 * Explorer's, so a work order behaves exactly like a camera or a light on this map.
 *
 * Data comes from dataConnectService (live when ?dc= is set, the committed export otherwise). Each
 * class loads on its own: a slow or failing one shows its own state and never blocks the others.
 */
import { SELECTION_SOURCES } from '../assetExplorer/assetSelectionStore.js';
import { assetTypeConfig, maintenanceDate } from '../assetExplorer/assetTypes.js';
import { installWorkspaceStrip } from '../workspaceStrip.js';
import { clearCache, DataConnectError, getCuratedData, isLive, MissingClassError, needsSignIn, signIn, sourceLabel, debugEnabled } from './dataConnectService.js';
import { assetIndex, normalizeAll, resolveLocations, summarize } from './maintenanceRecords.js';
import { createLiveDcFeed, liveCardNote, liveDcConnection, liveDcEnabled, mergeLiveRecords } from './liveDcSource.js';
import { DC_NOT_CONNECTED } from '../liveEventsData.js';

/** The classes the strip shows, in order. `assetType` is set for the ones the map can browse. */
export const KPI_CARDS = Object.freeze([
  Object.freeze({ key: 'incidents', label: 'Incidents', icon: 'incident', assetType: 'incidentRecord' }),
  Object.freeze({ key: 'tickets', label: 'Tickets', icon: 'ticket', assetType: 'ticket' }),
  Object.freeze({ key: 'tasks', label: 'Tasks', icon: 'task', assetType: 'task' }),
  Object.freeze({ key: 'workOrders', label: 'Work Orders', icon: 'workOrder', assetType: 'workOrder' }),
  Object.freeze({ key: 'inspections', label: 'Inspections', icon: 'inspection', assetType: 'inspection' }),
]);

/** Live DataConnect damage status: shown only while the Live feed is on (see liveDcSource.js). */
export const LIVE_KPI_CARD = Object.freeze({ key: 'damagedAssets', label: 'Damaged (live)', icon: 'damagedAsset', assetType: 'damagedAsset', liveOnly: true });

/** URL slugs, so the current view is readable in the address bar. It is never replayed on load. */
export const TYPE_SLUGS = Object.freeze({ incidents: 'incidents', tickets: 'tickets', tasks: 'tasks', workOrders: 'work-orders', inspections: 'inspections', damagedAssets: 'damaged-assets' });

/** What a live card draws, so any change to it — not only id or status — redraws the card. */
export function liveSignature(records, error = '', connection = null) {
  return JSON.stringify((records ?? []).map(({ raw, ...item }) => item)) + (error ?? '') + JSON.stringify(connection);
}

/** A live-only card (Damaged (live)): a lost connection shows as a warning, never as cached records. */
export function liveOnlyCard({ records, error, connection }) {
  if (connection && !connection.connected) return { state: 'error', note: DC_NOT_CONNECTED, warning: true, title: connection.reason };
  if (records) return { state: 'ready', note: null };
  return error ? { state: 'error', note: 'Live feed unavailable', title: error } : { state: 'loading', note: null };
}

/** The strip's source label; while Live DataConnect is not connected it warns instead of claiming live. */
export function maintenanceSourceNote({ base, live, liveShown, connection }) {
  if (connection && !connection.connected) {
    return { text: `${base} · ${DC_NOT_CONNECTED}`, live: Boolean(live), warning: true, title: connection.reason };
  }
  return { text: liveShown ? `${base} + Live DataConnect` : base, live: Boolean(live || liveShown) };
}

/** A card's LIVE badge: only a ready card can show live records. */
export const liveBadge = entry => String(entry?.state === 'ready' && entry.records.some(item => item.live));

/** Polls while the workspace is shown and stops while it is hidden. */
export function liveFeedControl(feed, { onError = () => {} } = {}) {
  return {
    show: () => feed?.start().catch(onError),
    hide: () => feed?.stop(),
  };
}

/**
 * The live snapshot after one read. Connected: a class that failed this time keeps its last good
 * records. Not connected: no live record is kept, so cards, map and search fall back to historical.
 */
export function nextLiveSnapshot(previous, result) {
  const connection = liveDcConnection(result);
  const errors = result?.errors ?? {};
  if (connection && !connection.connected) return { live: { byKey: {}, errors }, connection };
  return { live: { byKey: { ...previous?.byKey, ...result?.byKey }, errors }, connection };
}

/** One class's fields with the current live records merged beside its historical ones. */
export function mergeLiveEntry(entry, key, { live, connection, liveOnly = false, assets = new Map() }) {
  if (!entry.historical) return {};
  const records = mergeLiveRecords(entry.historical, resolveLocations(live.byKey[key] ?? [], assets));
  const merged = { records, summary: summarize(records, key) };
  if (!liveOnly) return merged;
  return { ...merged, warning: false, title: null, ...liveOnlyCard({ records: live.byKey[key], error: live.byKey[key] ? null : live.errors[key], connection }) };
}

/** Whether a live change to the card on screen must reach the map: any settled state, errors included. */
export const liveRedrawNeeded = entry => Boolean(entry) && entry.state !== 'loading';

/** One class's records with or without the live ones merged in. */
export function shownRecords(entry, { live = true } = {}) {
  return (live ? entry?.records : entry?.historical ?? (entry?.state === 'ready' ? entry.records : null)) ?? [];
}


/**
 * @param {import('cesium').Viewer} viewer
 * @param {{assetExplorer: object, maintenanceLayer: object, host?: HTMLElement}} deps
 */
export function installMaintenanceWorkspace(viewer, { assetExplorer, maintenanceLayer, host = document.body }) {
  const store = assetExplorer.store;
  const liveOn = liveDcEnabled();
  const cards = liveOn ? [...KPI_CARDS, LIVE_KPI_CARD] : KPI_CARDS;
  const root = document.createElement('div');
  root.className = 'maintenance-workspace';
  root.hidden = true;
  host.append(root);
  const strip = installWorkspaceStrip(root, {
    cards, label: 'Maintenance summary', onSelect: key => choose(key),
  });

  /** key -> { state: 'loading'|'ready'|'error'|'unavailable', records, summary, error } */
  const datasets = new Map(cards.map(card => [card.key, { state: 'loading', records: [], summary: null }]));
  let assets = new Map();
  let activeKey = null, active = false, withLive = true;

  // ── data ────────────────────────────────────────────────────────────────────────────────────
  const assetsReady = getCuratedData('assets')
    .then(({ rows }) => { assets = assetIndex(rows); return assets; })
    .catch(error => { console.warn('[maintenance] assets unavailable', error); return assets; });

  // ── live DataConnect: merged beside the historical records, refreshed every 60 s ────────────
  let live = { byKey: {}, errors: {} };
  let connection = null;
  const liveSignatures = new Map();
  function mergeLive(key) {
    const entry = datasets.get(key);
    Object.assign(entry, mergeLiveEntry(entry, key, { live, connection, liveOnly: cards.find(card => card.key === key)?.liveOnly, assets }));
  }
  const onLiveError = error => console.warn('[maintenance] live DataConnect unavailable', error);
  const liveFeed = liveOn ? createLiveDcFeed({
    onUpdate: result => {
      ({ live, connection } = nextLiveSnapshot(live, result));
      for (const card of cards) {
        const signature = liveSignature(live.byKey[card.key], live.errors[card.key], card.liveOnly ? connection : null);
        if (liveSignatures.get(card.key) === signature) continue;
        liveSignatures.set(card.key, signature);
        mergeLive(card.key);
        if (activeKey === card.key && liveRedrawNeeded(datasets.get(card.key))) applyRecords();
      }
      renderStrip();
    },
    onError: onLiveError,
  }) : null;
  // Polled only while Maintenance is shown. Hidden, recordsForType (search, Safety) keeps the last
  // live snapshot (none while not connected); showing the workspace refreshes it at once.
  const liveControl = liveFeedControl(liveFeed, { onError: onLiveError });

  async function load(key) {
    const entry = datasets.get(key);
    try {
      if (cards.find(card => card.key === key)?.liveOnly) {
        await assetsReady;
        entry.historical = [];
        mergeLive(key);
        renderStrip();
        if (activeKey === key) applyRecords();
        return;
      }
      const [{ rows }] = await Promise.all([getCuratedData(key), assetsReady]);
      const records = resolveLocations(normalizeAll(key, rows), assets);
      Object.assign(entry, { state: 'ready', historical: records, records, summary: summarize(records, key) });
      mergeLive(key);
      if (debugEnabled()) {
        console.info(`[DataConnect][${key}]`, {
          total: rows.length, normalized: records.length,
          'asset-linked': entry.summary.linked, 'spatially-resolved': entry.summary.located,
          'without-location': records.length - entry.summary.located,
        });
      }
    } catch (error) {
      // A class the deployment does not carry is unavailable, not broken; a DataConnect failure
      // says which failure it was. Nothing falls back to the export.
      const missing = error instanceof MissingClassError;
      // A failure a sign-in would fix says so, because the card is also the button that fixes it.
      const note = needsSignIn(error) ? `${error.note} — click to sign in`
        : error instanceof DataConnectError ? error.note : null;
      Object.assign(entry, { state: missing ? 'unavailable' : 'error', error, note });
      console.warn(`[maintenance] ${key} ${missing ? 'unavailable' : 'failed'}:`, error?.message ?? error);
    }
    renderStrip();
    if (activeKey === key) applyRecords();
  }

  // ── KPI strip ───────────────────────────────────────────────────────────────────────────────
  function renderStrip() {
    for (const card of cards) {
      const entry = datasets.get(card.key);
      const button = strip.root.querySelector(`[data-kpi="${card.key}"]`);
      if (button) button.dataset.live = liveBadge(entry);
      if (entry.state !== 'ready') { strip.set(card.key, { state: entry.state, note: entry.note, warning: entry.warning, title: entry.title }); continue; }
      const unplaced = entry.records.length - entry.summary.located;
      strip.set(card.key, {
        state: 'ready',
        count: entry.summary.total,
        note: liveCardNote(entry.records, entry.summary.note ?? (entry.summary.total ? `${unplaced} without location` : 'None recorded')),
      });
    }
    strip.setActive(activeKey);
    const note = maintenanceSourceNote({ base: sourceLabel(), live: isLive(), liveShown: Object.keys(live.byKey).length > 0, connection });
    strip.setSource(note.text, note);
  }

  // ── list ────────────────────────────────────────────────────────────────────────────────────

  /** The map shows exactly what the browser is showing: same search, same filter, same records. */
  function syncMap() {
    const card = cards.find(item => item.key === activeKey);
    const entry = activeKey ? datasets.get(activeKey) : null;
    if (!card?.assetType || !entry) return;
    const shown = store.filteredAssets();
    maintenanceLayer.setVisibleIds(card.assetType,
      shown.length === shownRecords(entry, { live: withLive }).length ? null : shown.map(asset => asset.id));
  }

  // ── selection, shared with the map and the bottom explorer ──────────────────────────────────
  let lastFilter = '';
  function onStoreChange(state) {
    const signature = `${state.filter.query}|${state.filter.id}|${state.activeExplorerType}`;
    if (signature !== lastFilter) { lastFilter = signature; syncMap(); }
    writeUrl();
  }

  /** Put the records into the explorer and onto the map. */
  function applyRecords() {
    const card = cards.find(item => item.key === activeKey);
    const entry = datasets.get(activeKey);
    if (!card || !entry) return;
    if (card.assetType) {
      maintenanceLayer.setRecords(card.assetType, shownRecords(entry, { live: withLive }));
      maintenanceLayer.show(card.assetType);
      assetExplorer.refresh();
      store.setActiveExplorerType(card.assetType);
      store.setStatus(card.assetType, { loading: entry.state === 'loading', error: entry.state === 'ready' ? null : assetTypeConfig(card.assetType)?.errorMessage ?? 'Unavailable' });
    }
    syncMap();
    renderStrip();
  }

  function openType(key) {
    activeKey = key;
    const entry = datasets.get(key);
    if (entry.state === 'loading') { renderStrip(); return; }
    applyRecords();
  }

  function closeType() {
    activeKey = null;
    maintenanceLayer.show(null);
    store.setActiveExplorerType(null);
    renderStrip();
    writeUrl();
  }

  // ── URL: a readable record of the current view, never a source of one ───────────────────────
  function writeUrl() {
    if (!active) return;
    const url = new URL(window.location.href);
    const selected = store.getState().selectedAsset;
    const assetType = cards.find(card => card.key === activeKey)?.assetType;
    if (activeKey) url.searchParams.set('maintenance', TYPE_SLUGS[activeKey]); else url.searchParams.delete('maintenance');
    if (selected && assetType && selected.assetType === assetType) url.searchParams.set('selected', selected.id);
    else url.searchParams.delete('selected');
    window.history.replaceState(null, '', url);
  }

  /** Drop any view left in the URL by a previous visit, so a refresh cannot reopen it. */
  function clearUrl() {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('maintenance') && !url.searchParams.has('selected')) return;
    url.searchParams.delete('maintenance');
    url.searchParams.delete('selected');
    window.history.replaceState(null, '', url);
  }

  function choose(key) {
    const entry = datasets.get(key);
    // While a sign-in is what the card is asking for, that is what clicking it does.
    if (entry?.state === 'error' && needsSignIn(entry.error)) { void startSignIn(); return; }
    if (activeKey === key) { closeType(); return; }
    withLive = true;
    openType(key);
    writeUrl();
  }
  /**
   * Sign in, then reload every class that was blocked on it.
   *
   * The popup is opened here, synchronously inside the click, or the browser treats it as unsolicited.
   */
  let signingIn = false;
  async function startSignIn() {
    if (signingIn) return;
    signingIn = true;
    const popup = window.open('', 'dataconnect-signin', 'width=520,height=680');
    for (const card of cards) {
      if (datasets.get(card.key).state === 'error') strip.set(card.key, { state: 'error', note: 'Signing in…' });
    }
    try {
      await signIn(popup);
      // The cached rejections are what "failed" means to the service; drop them and ask again.
      clearCache();
      for (const card of cards) Object.assign(datasets.get(card.key), { state: 'loading', error: null, note: null });
      renderStrip();
      await Promise.all(cards.map(card => load(card.key)));
    } catch (error) {
      popup?.close();
      for (const card of cards) {
        const entry = datasets.get(card.key);
        if (entry.state === 'error') entry.note = `${error?.message ?? 'Sign-in failed'} — click to retry`;
      }
      renderStrip();
    } finally { signingIn = false; }
  }

  const unsubscribe = store.subscribe(onStoreChange);

  return {
    root,
    get activeKey() { return activeKey; },
    /** Diagnostics/tests: the normalized records for one class. */
    recordsOf: key => datasets.get(key)?.records ?? [],
    /** Every loaded record of one asset type, whether or not that type is the one on screen. */
    recordsForType: (assetType, options) => {
      const card = cards.find(item => item.assetType === assetType);
      return shownRecords(card ? datasets.get(card.key) : null, options);
    },
    /**
     * Make one maintenance type the workspace's current view, loading it first if need be.
     *
     * This is what "fly to WO-900461" needs: a maintenance type is drawn only while its card is
     * chosen, so searching across all five is useless unless the match can also be shown.
     *
     * `live: false` shows the historical records only, as Safety counts them.
     *
     * @returns {Promise<boolean>} whether the type is now the one on screen
     */
    async reveal(assetType, { live = true } = {}) {
      const card = cards.find(item => item.assetType === assetType);
      if (!card) return false;
      const entry = datasets.get(card.key);
      if (entry.state === 'loading') await load(card.key);
      if (datasets.get(card.key).state !== 'ready') return false;
      if (activeKey !== card.key || withLive !== live) { withLive = live; openType(card.key); writeUrl(); }
      return true;
    },
    /** Put away whatever this workspace is drawing, without changing which tab is open. */
    hide() { if (activeKey) closeType(); },
    /** Load every class without showing any of them, so a search can see records first. */
    preload() {
      return Promise.all(cards
        .filter(card => datasets.get(card.key).state === 'loading')
        .map(card => load(card.key)));
    },
    activate() {
      if (active) return;
      active = true;
      root.hidden = false;
      renderStrip();
      strip.measure();
      void liveControl.show();
      for (const card of cards) if (datasets.get(card.key).state === 'loading') void load(card.key);
      // Maintenance always opens on the map: the KPI strip, nothing chosen, no browser. The current
      // view is still written to the URL (below) so it can be read or shared, but it is never
      // replayed on load — arriving here, refreshing, or coming back later all start the same way.
      clearUrl();
    },
    deactivate() {
      if (!active) return;
      active = false;
      root.hidden = true;
      liveControl.hide();
      maintenanceLayer.show(null);
      if (activeKey) store.setActiveExplorerType(null);
      activeKey = null;
      renderStrip();
    },
    destroy() { liveFeed?.stop(); unsubscribe(); strip.destroy(); root.remove(); },
  };
}

export { maintenanceDate };
