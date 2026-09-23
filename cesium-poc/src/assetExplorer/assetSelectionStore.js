/**
 * The one place an asset is selected.
 *
 * Eleven layers each grew their own `select(entity)`, their own details panel and their own
 * LEFT_CLICK handler. That was workable while a click on the map was the only way to select
 * anything; it stops being workable the moment a card, a mini-map marker and a Next button must all
 * mean the same thing. So selection moves here, and the layers become sources that report into it.
 *
 * Framework-free on purpose: Cesium layers write to it directly, and the React island subscribes
 * through useSyncExternalStore. Neither side owns it.
 *
 * Three operations are kept deliberately distinct, because collapsing them is what makes this kind
 * of UI feel like it is fighting the user:
 *   - a VISIBLE LAYER is a dataset drawn in the scene,
 *   - a SELECTED asset is highlighted and described, with at most a moderate camera move,
 *   - an INSPECTED asset is one the camera has flown in close to, which is always explicit.
 */

/** Where a selection came from. The originating surface skips its own echo. */
export const SELECTION_SOURCES = Object.freeze({
  CESIUM: 'cesium', CARD: 'card', MINIMAP: 'minimap', RAIL: 'rail', STEP: 'step', SEARCH: 'search', NONE: 'none',
});

const EMPTY = Object.freeze([]);

/** @returns {boolean} true when both refer to the same asset. */
export const sameAsset = (a, b) => a === b || (!!a && !!b && a.assetType === b.assetType && a.id === b.id);

export function createAssetSelectionStore() {
  let state = Object.freeze({
    /** Every asset layer currently drawn in Cesium — independent of what the explorer browses. */
    visibleAssetLayers: EMPTY,
    /** The asset type the bottom explorer is browsing, or null when it is closed. */
    activeExplorerType: null,
    /** @type {Record<string, object[]>} normalized assets, by asset type. */
    assetsByType: Object.freeze({}),
    /** @type {Record<string, {loading: boolean, error: string | null}>} */
    statusByType: Object.freeze({}),
    selectedAsset: null,
    selectionSource: SELECTION_SOURCES.NONE,
    /** What the explorer is showing of the active type: a search, and at most one named filter. */
    filter: Object.freeze({ query: '', id: null }),
    explorerExpanded: true,
    detailsOpen: false,
    /** True while the camera is parked at an asset's close view, so Back can be offered. */
    inspectionViewActive: false,
  });

  const listeners = new Set();
  let notifying = false;

  function set(changes) {
    const next = Object.freeze({ ...state, ...changes });
    // Object identity is the change signal for useSyncExternalStore, so bail on a true no-op.
    if (Object.keys(changes).every(key => Object.is(state[key], changes[key]))) return;
    state = next;
    if (notifying) return;          // a listener that selects again must not re-enter the fan-out
    notifying = true;
    try { for (const listener of [...listeners]) listener(state); } finally { notifying = false; }
  }

  const assetsOf = type => state.assetsByType[type] ?? EMPTY;

  /**
   * How a type's search and filters are applied. Registered by the installer, which is the layer
   * that knows the asset registry; the store stays a plain state container.
   */
  let filterResolver = (type, assets) => assets;
  /** The assets on screen: the active type's, narrowed by the search and filter. */
  const visibleAssets = () => filterResolver(state.activeExplorerType, assetsOf(state.activeExplorerType), state.filter);

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },

    /** Replace the normalized assets for one type. Selection survives if the asset is still there. */
    setAssets(assetType, assets) {
      const next = Object.freeze({ ...state.assetsByType, [assetType]: Object.freeze([...assets]) });
      const selected = state.selectedAsset;
      const stillThere = selected?.assetType !== assetType
        || assets.some(asset => asset.id === selected.id);
      set({
        assetsByType: next,
        ...(stillThere ? {} : { selectedAsset: null, detailsOpen: false, inspectionViewActive: false }),
      });
    },

    setStatus(assetType, status) {
      set({ statusByType: Object.freeze({ ...state.statusByType, [assetType]: Object.freeze({ loading: false, error: null, ...status }) }) });
    },

    /** Layers drawn in Cesium. Several may be on while the explorer browses just one of them. */
    setVisibleAssetLayers(types) {
      const next = Object.freeze([...new Set(types)]);
      if (next.length === state.visibleAssetLayers.length
        && next.every((type, i) => type === state.visibleAssetLayers[i])) return;
      set({ visibleAssetLayers: next });
    },

    /**
     * Point the explorer at an asset type. Switching away from a type drops its selection, because
     * a details panel describing an asset the explorer is no longer showing is just confusing.
     */
    setActiveExplorerType(assetType) {
      if (assetType === state.activeExplorerType) return;
      const keepSelection = state.selectedAsset?.assetType === assetType;
      set({
        activeExplorerType: assetType,
        filter: Object.freeze({ query: '', id: null }),
        explorerExpanded: assetType ? state.explorerExpanded : true,
        ...(keepSelection ? {} : { selectedAsset: null, detailsOpen: false, inspectionViewActive: false }),
      });
    },

    /**
     * THE selection entry point. Cesium picks, cards, the mini-map, Next/Previous and search all
     * land here, so every surface stays in step by construction rather than by remembering to.
     */
    selectAsset(asset, source = SELECTION_SOURCES.NONE) {
      if (!asset) {
        set({ selectedAsset: null, selectionSource: source, detailsOpen: false, inspectionViewActive: false });
        return null;
      }
      // Selecting inside a type the explorer is not showing switches it, so the card list always
      // contains the selected asset.
      const activeExplorerType = state.assetsByType[asset.assetType] ? asset.assetType : state.activeExplorerType;
      set({
        selectedAsset: asset, selectionSource: source, detailsOpen: true,
        activeExplorerType,
        // Moving to a different asset leaves the close view behind; Back would be meaningless.
        inspectionViewActive: sameAsset(asset, state.selectedAsset) ? state.inspectionViewActive : false,
      });
      return asset;
    },

    setFilterResolver(resolver) { filterResolver = resolver ?? ((type, assets) => assets); },
    filteredAssets: visibleAssets,

    /**
     * Narrow what is shown. A selection the filter removes is dropped rather than left highlighted
     * on a card nobody can see — the same rule a hidden layer follows.
     */
    setFilter(changes) {
      const filter = Object.freeze({ ...state.filter, ...changes });
      if (filter.query === state.filter.query && filter.id === state.filter.id) return;
      set({ filter });
      const selected = state.selectedAsset;
      if (selected && selected.assetType === state.activeExplorerType
        && !visibleAssets().some(asset => asset.id === selected.id)) {
        set({ selectedAsset: null, detailsOpen: false, inspectionViewActive: false });
      }
    },

    /** Step through what is on screen. Returns the newly selected asset, or null at the ends. */
    step(delta) {
      const assets = visibleAssets();
      if (!assets.length) return null;
      const at = state.selectedAsset ? assets.findIndex(asset => asset.id === state.selectedAsset.id) : -1;
      // No selection yet: Next opens the list at its start rather than doing nothing.
      const index = at === -1 ? (delta > 0 ? 0 : assets.length - 1) : at + delta;
      if (index < 0 || index >= assets.length) return null;
      return this.selectAsset(assets[index], SELECTION_SOURCES.STEP);
    },

    activeAssets: () => assetsOf(state.activeExplorerType),
    activeStatus: () => state.statusByType[state.activeExplorerType] ?? { loading: false, error: null },
    setExplorerExpanded(expanded) { set({ explorerExpanded: Boolean(expanded) }); },
    setDetailsOpen(open) { set({ detailsOpen: Boolean(open) }); },
    setInspectionViewActive(active) { set({ inspectionViewActive: Boolean(active) }); },
    destroy() { listeners.clear(); },
  };
}
