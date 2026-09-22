/**
 * Mounts the Asset Explorer island into the otherwise framework-free app.
 *
 * This is the only file that knows both worlds exist: it owns the React root, the selection store,
 * the Cesium navigation and the subscription that keeps the 3D scene in step with the UI.
 * Everything it touches is disposed in destroy(), including the React root — a Cesium page that
 * survives HMR must not accumulate roots or listeners.
 */
import { Cartographic, Math as CMath } from 'cesium';
import { createRoot } from 'react-dom/client';
import { AssetExplorer } from './AssetExplorer.jsx';
import { createAssetSelectionStore, SELECTION_SOURCES } from './assetSelectionStore.js';
import { createAssetNavigation } from './cesiumAssetNavigation.js';
import { bindCartographic, connectAssetSources, createAssetSources, refreshAssets } from './assetSources.js';
import { LAYER_TO_ASSET_TYPE, nextExplorerType } from './explorerRouting.js';
import { assetTypeConfig } from './assetTypes.js';
import { searchEntry } from './assetSearch.js';

export { LAYER_TO_ASSET_TYPE, nextExplorerType };


export function installAssetExplorer(container, viewer, {
  store = createAssetSelectionStore(),
  centerline = [],
  layerStore = null,
  corridorModels = null,
  cameras = null,
  messageSigns = null,
  lighting = null,
  bridges = null,
  signals = null,
  liveEvents = null,
  signStructures = null,
  modelConfigs = [],
  onViewCamera = null,
  corridorStatus = null,
  roadShields = null,
  themeMode = null,
  logger = console,
} = {}) {
  bindCartographic(position => {
    const carto = Cartographic.fromCartesian(position);
    return carto
      ? { longitude: CMath.toDegrees(carto.longitude), latitude: CMath.toDegrees(carto.latitude) }
      : null;
  });

  const sources = createAssetSources({ corridorModels, cameras, bridges, signals, messageSigns, lighting, liveEvents, signStructures, centerline, modelConfigs });
  const navigation = createAssetNavigation(viewer, { logger });
  const disconnect = connectAssetSources(store, sources, { logger });

  const host = document.createElement('div');
  host.className = 'asset-explorer-host';
  container.append(host);
  const root = createRoot(host);

  /** The explicit close view (§26 C), and the only thing that flies the camera in. */
  /** Narrow screens: an open Map Explorer covers most of the map, so inspecting closes it —
   *  the same courtesy the existing focus helper already does for its own camera moves. */
  function clearNarrowScreenPanels() {
    if (window.innerWidth > 700) return;
    const toggle = document.querySelector('#menu-toggle');
    if (toggle?.getAttribute('aria-expanded') === 'true') toggle.click();
  }

  function inspect(asset) {
    clearNarrowScreenPanels();
    const wasExpanded = store.getState().explorerExpanded;
    const flew = navigation.inspect(asset, { alreadyInspecting: store.getState().inspectionViewActive });
    if (!flew) return;
    store.setInspectionViewActive(true);
    // §27: the close view is where the 3D matters most, and an expanded carousel eats the bottom
    // third of it — enough to push the far end of a long bridge underneath itself. The explorer
    // collapses to a header for the duration and comes back when the user returns.
    if (wasExpanded) {
      restoreExpandedOnReturn = true;
      store.setExplorerExpanded(false);
    }
  }

  let restoreExpandedOnReturn = false;

  function returnFromInspection() {
    if (!navigation.returnToSaved()) return;
    store.setInspectionViewActive(false);
    if (restoreExpandedOnReturn) {
      restoreExpandedOnReturn = false;
      store.setExplorerExpanded(true);
    }
  }

  // §19: the overlays have to be aware of each other. The Map Explorer is an existing DOM panel
  // that expands and collapses, so its width is measured rather than assumed, and the island keeps
  // clear of it instead of sliding underneath.
  const explorerPanel = document.querySelector('.map-explorer, #map-explorer, .explorer-panel');
  let leftInset = 16;
  function measureInsets() {
    const rect = explorerPanel?.getBoundingClientRect();
    const nextLeft = rect && rect.width > 0 && rect.right > 0 && !explorerPanel.classList.contains('collapsed')
      ? Math.round(rect.right) + 16 : 16;
    if (nextLeft === leftInset) return;
    leftInset = nextLeft;
    render();
  }

  function render() {
    root.render(
      <AssetExplorer
        store={store}
        centerline={centerline}
        leftInset={leftInset}
        themeMode={themeMode?.mode ?? 'dark'}
        onInspect={inspect}
        onReturn={returnFromInspection}
        onViewCamera={onViewCamera}
      />);
  }
  render();

  const panelObserver = explorerPanel
    ? new MutationObserver(() => measureInsets()) : null;
  panelObserver?.observe(explorerPanel, { attributes: true, attributeFilter: ['class', 'style'] });
  // Switching theme re-renders the island with the matching MUI theme — no reload.
  const unsubscribeTheme = themeMode?.subscribe?.(() => render()) ?? null;
  const onResize = () => measureInsets();
  window.addEventListener('resize', onResize);
  measureInsets();
  // Neighbouring furniture mounts on its own schedule, so re-measure once the frame has settled
  // rather than trusting whatever existed at install time.
  const settleMeasure = requestAnimationFrame(() => measureInsets());

  // The corridor status strip and this explorer want the same edge of the map. The strip yields
  // while an explorer is open and comes straight back when it closes — it is hidden, not destroyed,
  // so its own toggle and refresh survive untouched.
  let stripSuppressed = null;
  const unsubscribeStrip = corridorStatus
    ? store.subscribe(state => {
      const suppress = state.activeExplorerType !== null;
      if (suppress === stripSuppressed) return;
      stripSuppressed = suppress;
      corridorStatus.setSuppressed?.(suppress);
    })
    : null;

  // Route shields are map furniture and sit exactly where assets do — on the corridor. While an
  // asset is selected they step aside, so the marker naming it is never competing with a shield.
  // They come straight back when the selection is cleared.
  let shieldsHidden = null;
  const unsubscribeShields = roadShields
    ? store.subscribe(state => {
      const hide = state.selectedAsset !== null;
      if (hide === shieldsHidden) return;
      shieldsHidden = hide;
      roadShields.setVisible?.(!hide);
    })
    : null;

  // A selection gets at most a moderate look, and only when the user did not make it by clicking
  // the map — they are already looking at what they just clicked.
  let lastFocusKey = null;
  const unsubscribeSelection = store.subscribe(state => {
    const asset = state.selectedAsset;
    const key = asset ? `${asset.assetType}:${asset.id}` : null;
    if (key === lastFocusKey) return;
    lastFocusKey = key;
    if (!asset || state.selectionSource === SELECTION_SOURCES.CESIUM) return;
    if (state.inspectionViewActive) { inspect(asset); return; }
    navigation.focusSelection(asset);
  });

  // Which layers are drawn, and which type the explorer browses, are separate facts (§17).
  // mapLayerStore reports a state *string* per layer; a grouped layer such as Traffic Cameras
  // reports 'partial' when only one of its groups is on, which still means it is drawn.
  const VISIBLE_STATES = new Set(['on', 'partial']);
  let previousTypes = [];

  // Asset layers are exclusive: switching to Gantries switches Cameras off, so the Map Explorer
  // shows one asset tool active at a time. This is enforced here rather than in the store — the
  // store still keeps visibility, the browsed type and the selection as three separate facts, and
  // non-asset layers (traffic flow, the road network) are untouched by it.
  let enforcing = false;

  function syncLayers() {
    // Re-entrant guard: switching layers off below makes the layer store notify again.
    if (enforcing) return;
    const visibleTypes = Object.entries(LAYER_TO_ASSET_TYPE)
      .filter(([layerId]) => VISIBLE_STATES.has(layerStore.stateOf(layerId)))
      .map(([, assetType]) => assetType);
    const next = nextExplorerType(visibleTypes, previousTypes, store.getState().activeExplorerType);

    const strays = Object.entries(LAYER_TO_ASSET_TYPE)
      .filter(([layerId, assetType]) => assetType !== next && VISIBLE_STATES.has(layerStore.stateOf(layerId)));
    if (strays.length) {
      enforcing = true;
      // setVisible is async — a layer may still be loading — so the state is re-read afterwards
      // rather than assumed.
      void Promise.all(strays.map(([layerId]) => layerStore.setVisible(layerId, false)))
        .catch(error => logger.warn?.('[asset-explorer] could not switch a layer off', error))
        .then(() => {
          enforcing = false;
          previousTypes = next ? [next] : [];
          syncLayers();
        });
      return;
    }

    store.setVisibleAssetLayers(visibleTypes);
    previousTypes = visibleTypes;
    store.setActiveExplorerType(next);
    // Only the browsed type hands its selection over — and only if it does not keep its own
    // details panel, which is a capability the explorer does not reproduce.
    for (const source of sources) source.own(source.assetType === next && !source.usesLegacyPanel);
    if (next) refreshAssets(store, sources.filter(source => source.assetType === next), { logger });
  }

  // subscribe() only fires on change, so the first read has to happen here or a layer that is
  // already on at startup would never open the explorer.
  const unsubscribeLayers = layerStore ? layerStore.subscribe(syncLayers) : null;
  if (layerStore) syncLayers();

  // ── Fly to an asset by name (Ask the Twin) ────────────────────────────────────────────────────
  /**
   * Every asset the app has loaded, as search entries — whether or not its layer is switched on.
   * A layer that fails to read is skipped rather than failing the whole search.
   */
  function searchableAssets() {
    const entries = [];
    for (const source of sources) {
      let assets = [];
      try { assets = (source.readAll ?? source.read)(); } catch (error) { logger.warn?.(`[asset-explorer] ${source.assetType} not searchable`, error); }
      const config = assetTypeConfig(source.assetType);
      for (const asset of assets) {
        if (!asset.coordinates) continue;
        entries.push(searchEntry(asset, { label: `${config?.label ?? ''} ${config?.singular ?? ''}`, subtitle: config?.getSubtitle?.(asset) ?? null }));
      }
    }
    return entries;
  }

  /** Resolves once `predicate(state)` holds, or null after `timeoutMs`. */
  function waitForState(predicate, timeoutMs) {
    return new Promise(resolve => {
      const hit = predicate(store.getState());
      if (hit) { resolve(hit); return; }
      const timer = setTimeout(() => { unsubscribe(); resolve(null); }, timeoutMs);
      const unsubscribe = store.subscribe(state => {
        const found = predicate(state);
        if (!found) return;
        clearTimeout(timer); unsubscribe(); resolve(found);
      });
    });
  }

  /**
   * Exactly what a user would do by hand: switch the asset's layer on (which opens its explorer and
   * switches the other asset layers off), select it, then take the close "View on map" look — so
   * the details panel, the highlight, the mini-map and Back all behave as they always do.
   *
   * @returns {Promise<object|null>} the asset flown to, or null if its layer never delivered it
   */
  async function flyToAsset(asset) {
    const source = sources.find(candidate => candidate.assetType === asset.assetType);
    const layerId = source?.layerFor?.(asset) ?? assetTypeConfig(asset.assetType)?.layerId;
    if (!layerId || !layerStore) return null;
    await layerStore.setVisible(layerId, true);
    const live = await waitForState(state => (state.assetsByType[asset.assetType] ?? []).find(candidate => candidate.id === asset.id), 10000);
    if (!live) { logger.warn?.(`[asset-explorer] ${asset.assetType} ${asset.id} did not appear after enabling ${layerId}`); return null; }
    store.selectAsset(live, SELECTION_SOURCES.SEARCH);
    inspect(live);
    return live;
  }

  /**
   * Fly to a place that is not an asset — the end of a road segment, or a whole segment — with the
   * same saved-camera close view, so "Back" returns from it exactly as from an asset. The explorer's
   * selection is left alone: nothing was selected.
   *
   * @param {{longitude: number, latitude: number, positions?: import('cesium').Cartesian3[]}} place
   */
  function flyToPlace({ longitude, latitude, positions = null }) {
    clearNarrowScreenPanels();
    const place = { assetType: 'place', id: 'place', coordinates: { longitude, latitude },
      geometry: positions?.length ? { positions } : null };
    return navigation.inspect(place, { alreadyInspecting: false });
  }

  /**
   * Switch one asset type's layer on — its markers appear and its explorer opens, exactly as the
   * rail button does — and hand back its assets in corridor order.
   *
   * @returns {Promise<object[]>} the type's assets; empty when it has none or its layer failed
   */
  async function showAssetType(assetType) {
    const layerId = assetTypeConfig(assetType)?.layerId;
    if (!layerId || !layerStore) return [];
    await layerStore.setVisible(layerId, true);
    // The explorer switches type before it reads the type's assets, so an empty list at that moment
    // means "not read yet", not "none". Its status is only set once the read has happened.
    const assets = await waitForState(state => (state.activeExplorerType === assetType && state.statusByType[assetType]
      ? state.assetsByType[assetType] : null), 10000);
    return assets ?? [];
  }

  return {
    store,
    navigation,
    sources,
    searchableAssets,
    flyToAsset,
    flyToPlace,
    showAssetType,
    /** Re-read every layer's records, e.g. once an async layer has finished loading. */
    refresh: () => refreshAssets(store, sources, { logger }),
    /** Test/diagnostic hook. */
    inspect,
    returnFromInspection,
    destroy() {
      unsubscribeTheme?.();
      panelObserver?.disconnect();
      cancelAnimationFrame(settleMeasure);
      window.removeEventListener('resize', onResize);
      unsubscribeSelection();
      unsubscribeShields?.();
      // Never leave the corridor without its shields because this island went away.
      roadShields?.setVisible?.(true);
      unsubscribeStrip?.();
      // Never leave the strip hidden because this island went away.
      corridorStatus?.setSuppressed?.(false);
      unsubscribeLayers?.();
      disconnect();
      // Unmounting synchronously inside a React event would warn; this only ever runs from the
      // app's own teardown, so a microtask is enough to stay outside React's render phase.
      queueMicrotask(() => root.unmount());
      host.remove();
      store.destroy();
    },
  };
}
