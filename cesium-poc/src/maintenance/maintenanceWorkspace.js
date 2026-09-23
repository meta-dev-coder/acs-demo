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
import { getCuratedData, isLive, MissingClassError, sourceLabel, debugEnabled } from './dataConnectService.js';
import { assetIndex, normalizeAll, resolveLocations, summarize } from './maintenanceRecords.js';

/** The classes the strip shows, in order. `assetType` is set for the ones the map can browse. */
export const KPI_CARDS = Object.freeze([
  Object.freeze({ key: 'incidents', label: 'Incidents', icon: 'incident', assetType: 'incidentRecord' }),
  Object.freeze({ key: 'tickets', label: 'Tickets', icon: 'ticket', assetType: 'ticket' }),
  Object.freeze({ key: 'tasks', label: 'Tasks', icon: 'task', assetType: 'task' }),
  Object.freeze({ key: 'workOrders', label: 'Work Orders', icon: 'workOrder', assetType: 'workOrder' }),
  Object.freeze({ key: 'inspections', label: 'Inspections', icon: 'inspection', assetType: 'inspection' }),
]);

/** URL slugs, so a view can be linked to and survive a refresh. */
export const TYPE_SLUGS = Object.freeze({ incidents: 'incidents', tickets: 'tickets', tasks: 'tasks', workOrders: 'work-orders', inspections: 'inspections' });
export const keyFromSlug = slug => Object.keys(TYPE_SLUGS).find(key => TYPE_SLUGS[key] === slug) ?? null;


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
      // A class the deployment does not carry is unavailable, not broken.
      const missing = error instanceof MissingClassError;
      Object.assign(entry, { state: missing ? 'unavailable' : 'error', error });
      console.warn(`[maintenance] ${key} ${missing ? 'unavailable' : 'failed'}`, error);
    }
    renderStrip();
    if (activeKey === key) applyRecords();
  }

  // ── KPI strip ───────────────────────────────────────────────────────────────────────────────
  function renderStrip() {
    for (const card of KPI_CARDS) {
      const entry = datasets.get(card.key);
      if (entry.state !== 'ready') { strip.set(card.key, { state: entry.state }); continue; }
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

  // ── URL, so a view survives a refresh ───────────────────────────────────────────────────────
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

  function readUrl() {
    const params = new URLSearchParams(window.location.search);
    return { key: keyFromSlug(params.get('maintenance')), selected: params.get('selected') };
  }

  // Only what the page was OPENED with restores a view. Coming back to Maintenance later starts on
  // the map with nothing chosen, rather than reopening whatever was last looked at.
  const openedWith = readUrl();
  let restored = false;

  function choose(key) {
    if (activeKey === key) { closeType(); return; }
    openType(key);
    writeUrl();
  }
  const unsubscribe = store.subscribe(onStoreChange);

  return {
    root,
    get activeKey() { return activeKey; },
    /** Diagnostics/tests: the normalized records for one class. */
    recordsOf: key => datasets.get(key)?.records ?? [],
    activate() {
      if (active) return;
      active = true;
      root.hidden = false;
      renderStrip();
      strip.measure();
      for (const card of KPI_CARDS) if (datasets.get(card.key).state === 'loading') void load(card.key);
      const wanted = restored ? { key: null, selected: null } : openedWith;
      restored = true;
      if (wanted.key) {
        openType(wanted.key);
        if (wanted.selected) {
          // The records may still be loading; take the selection when they arrive.
          const take = () => {
            const assetType = KPI_CARDS.find(card => card.key === wanted.key)?.assetType;
            const asset = (store.getState().assetsByType[assetType] ?? []).find(candidate => candidate.id === wanted.selected);
            if (asset) store.selectAsset(asset, SELECTION_SOURCES.SEARCH);
          };
          datasets.get(wanted.key).state === 'ready' ? take() : void Promise.resolve(load(wanted.key)).then(take);
        }
      }
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
