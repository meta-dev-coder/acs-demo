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

/** The classes the strip shows, in order. `assetType` is set for the ones the map can browse. */
export const KPI_CARDS = Object.freeze([
  Object.freeze({ key: 'incidents', label: 'Incidents', icon: 'incident', assetType: 'incidentRecord' }),
  Object.freeze({ key: 'tickets', label: 'Tickets', icon: 'ticket', assetType: 'ticket' }),
  Object.freeze({ key: 'tasks', label: 'Tasks', icon: 'task', assetType: 'task' }),
  Object.freeze({ key: 'workOrders', label: 'Work Orders', icon: 'workOrder', assetType: 'workOrder' }),
  Object.freeze({ key: 'inspections', label: 'Inspections', icon: 'inspection', assetType: 'inspection' }),
]);

/** URL slugs, so the current view is readable in the address bar. It is never replayed on load. */
export const TYPE_SLUGS = Object.freeze({ incidents: 'incidents', tickets: 'tickets', tasks: 'tasks', workOrders: 'work-orders', inspections: 'inspections' });


/**
 * @param {import('cesium').Viewer} viewer
 * @param {{assetExplorer: object, maintenanceLayer: object, host?: HTMLElement}} deps
 */
export function installMaintenanceWorkspace(viewer, { assetExplorer, maintenanceLayer, host = document.body }) {
  const store = assetExplorer.store;
  const root = document.createElement('div');
  root.className = 'maintenance-workspace';
  root.hidden = true;
  host.append(root);
  const strip = installWorkspaceStrip(root, {
    cards: KPI_CARDS, label: 'Maintenance summary', onSelect: key => choose(key),
  });

  /** key -> { state: 'loading'|'ready'|'error'|'unavailable', records, summary, error } */
  const datasets = new Map(KPI_CARDS.map(card => [card.key, { state: 'loading', records: [], summary: null }]));
  let assets = new Map();
  let activeKey = null, active = false;

  // ── data ────────────────────────────────────────────────────────────────────────────────────
  const assetsReady = getCuratedData('assets')
    .then(({ rows }) => { assets = assetIndex(rows); return assets; })
    .catch(error => { console.warn('[maintenance] assets unavailable', error); return assets; });

  async function load(key) {
    const entry = datasets.get(key);
    try {
      const [{ rows }] = await Promise.all([getCuratedData(key), assetsReady]);
      const records = resolveLocations(normalizeAll(key, rows), assets);
      Object.assign(entry, { state: 'ready', records, summary: summarize(records, key) });
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
    for (const card of KPI_CARDS) {
      const entry = datasets.get(card.key);
      if (entry.state !== 'ready') { strip.set(card.key, { state: entry.state, note: entry.note }); continue; }
      const unplaced = entry.records.length - entry.summary.located;
      strip.set(card.key, {
        state: 'ready',
        count: entry.summary.total,
        note: entry.summary.note ?? (entry.summary.total ? `${unplaced} without location` : 'None recorded'),
      });
    }
    strip.setActive(activeKey);
    strip.setSource(sourceLabel(), { live: isLive() });
  }

  // ── list ────────────────────────────────────────────────────────────────────────────────────

  /** The map shows exactly what the browser is showing: same search, same filter, same records. */
  function syncMap() {
    const card = KPI_CARDS.find(item => item.key === activeKey);
    const entry = activeKey ? datasets.get(activeKey) : null;
    if (!card?.assetType || !entry) return;
    const shown = store.filteredAssets();
    maintenanceLayer.setVisibleIds(card.assetType,
      shown.length === entry.records.length ? null : shown.map(asset => asset.id));
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
    const card = KPI_CARDS.find(item => item.key === activeKey);
    const entry = datasets.get(activeKey);
    if (!card || !entry) return;
    if (card.assetType) {
      maintenanceLayer.setRecords(card.assetType, entry.records);
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
    const assetType = KPI_CARDS.find(card => card.key === activeKey)?.assetType;
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
    for (const card of KPI_CARDS) {
      if (datasets.get(card.key).state === 'error') strip.set(card.key, { state: 'error', note: 'Signing in…' });
    }
    try {
      await signIn(popup);
      // The cached rejections are what "failed" means to the service; drop them and ask again.
      clearCache();
      for (const card of KPI_CARDS) Object.assign(datasets.get(card.key), { state: 'loading', error: null, note: null });
      renderStrip();
      await Promise.all(KPI_CARDS.map(card => load(card.key)));
    } catch (error) {
      popup?.close();
      for (const card of KPI_CARDS) {
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
    recordsForType: assetType => {
      const card = KPI_CARDS.find(item => item.assetType === assetType);
      return card ? datasets.get(card.key)?.records ?? [] : [];
    },
    /**
     * Make one maintenance type the workspace's current view, loading it first if need be.
     *
     * This is what "fly to WO-900461" needs: a maintenance type is drawn only while its card is
     * chosen, so searching across all five is useless unless the match can also be shown.
     *
     * @returns {Promise<boolean>} whether the type is now the one on screen
     */
    async reveal(assetType) {
      const card = KPI_CARDS.find(item => item.assetType === assetType);
      if (!card) return false;
      const entry = datasets.get(card.key);
      if (entry.state === 'loading') await load(card.key);
      if (datasets.get(card.key).state !== 'ready') return false;
      if (activeKey !== card.key) { openType(card.key); writeUrl(); }
      return true;
    },
    /** Load every class without showing any of them, so a search can see records first. */
    preload() {
      return Promise.all(KPI_CARDS
        .filter(card => datasets.get(card.key).state === 'loading')
        .map(card => load(card.key)));
    },
    activate() {
      if (active) return;
      active = true;
      root.hidden = false;
      renderStrip();
      strip.measure();
      for (const card of KPI_CARDS) if (datasets.get(card.key).state === 'loading') void load(card.key);
      // Maintenance always opens on the map: the KPI strip, nothing chosen, no browser. The current
      // view is still written to the URL (below) so it can be read or shared, but it is never
      // replayed on load — arriving here, refreshing, or coming back later all start the same way.
      clearUrl();
    },
    deactivate() {
      if (!active) return;
      active = false;
      root.hidden = true;
      maintenanceLayer.show(null);
      if (activeKey) store.setActiveExplorerType(null);
      activeKey = null;
      renderStrip();
    },
    destroy() { unsubscribe(); strip.destroy(); root.remove(); },
  };
}

export { maintenanceDate };
