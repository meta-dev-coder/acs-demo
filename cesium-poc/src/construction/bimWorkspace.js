/**
 * The state BIM Timeline and BIM Changes share, and the single Cesium viewer they take turns with.
 *
 * WHY THIS EXISTS. Phase 9C mounted one screen into both subtabs, so "BIM Changes" was literally
 * the same screen as "BIM Timeline" — every comparison filter, the search box and the full change
 * table sat under the timeline's viewer, and the two questions a construction manager actually
 * asks got one muddled answer. Splitting them into two screens raises two problems this module
 * solves:
 *
 *   1. TWO SCREENS WOULD MEAN TWO CESIUM CONTEXTS for one model. The viewer is owned here and
 *      re-parented into whichever pane is showing. One context, one model in memory, one set of
 *      event handlers.
 *   2. THE TWO MUST AGREE. Selecting V4 and a wall in the Timeline and then opening Changes has
 *      to arrive at V3 → V4 with that wall still selected. One store, one source of truth for the
 *      selected version, the baseline and the selected IFC GlobalId.
 *
 * It owns no markup. The two views subscribe, read, and call back.
 */
import { request } from './ciClient.js';
import { installBimViewer } from './bimViewer.js';

export const BIM_API = '/speckle';

/** Which appearance the model is drawn in. The original is never destroyed, only overlaid. */
export const APPEARANCE = Object.freeze({
  ORIGINAL: 'ORIGINAL',
  CHANGES: 'CHANGES',
});

/**
 * Change kinds that are shown by default.
 *
 * UNCHANGED is on, deliberately: hiding it strips the building of the context that makes an added
 * wall legible as a wall rather than a floating rectangle. The brief asks for it to stay unless
 * the user says otherwise, and this is where that default lives.
 */
export const DEFAULT_VISIBLE_KINDS = Object.freeze([
  'ADDED', 'REMOVED', 'MODIFIED', 'RECLASSIFIED', 'UNCHANGED',
]);

/**
 * How the Speckle sync worker's state and its last run read.
 *
 * Lives here rather than in a screen because it outlived one: the Real BIM Model screen was
 * removed from the navigation and these labels are still needed by Construction Progress's
 * Overview. Keeping them in the deleted screen's module would have bundled it — and its Cesium
 * import — for the sake of two constants.
 */
export const WORKER_LABEL = Object.freeze({
  DISABLED: { label: 'Off', tone: 'info' },
  NOT_CONFIGURED: { label: 'Not configured', tone: 'warn' },
  IDLE: { label: 'On', tone: 'ok' },
  CHECKING: { label: 'Checking Speckle', tone: 'ok' },
  CONVERTING: { label: 'Converting model', tone: 'warn' },
  AUTH_PARKED: { label: 'Stopped — token rejected', tone: 'bad' },
  STOPPED: { label: 'Stopped', tone: 'warn' },
});

/** What became of the last check. UNCHANGED is the normal, healthy answer. */
export const RUN_LABEL = Object.freeze({
  CONVERTED: { label: 'New version converted', tone: 'ok' },
  UNCHANGED: { label: 'Unchanged', tone: 'info' },
  FAILED: { label: 'Failed', tone: 'bad' },
  SKIPPED: { label: 'Skipped', tone: 'info' },
});

export function createBimWorkspace({
  fetchJson = request,
  viewerFactory = installBimViewer,
} = {}) {
  const listeners = new Set();

  const state = {
    loaded: false,
    error: null,
    timeline: [],
    placement: {},
    selectedVersionId: null,
    /** The LEFT side of a comparison. Defaults to the version before the selected one. */
    baselineVersionId: null,
    selectedGuid: null,
    /**
     * The MULTI-selection, for creating one task from several elements (Phase 10B).
     *
     * Kept beside `selectedGuid` rather than replacing it: the timeline and changes panels are
     * built around one element at a time and read `selectedGuid`, so widening the model did not
     * have to disturb them. `selectedGuid` is the last element picked; this is everything picked.
     */
    selectedGuids: [],
    /** When on, a plain click adds to the selection instead of replacing it. */
    multiSelect: false,
    comparison: null,
    appearance: APPEARANCE.CHANGES,
    hiddenKinds: new Set(),
    note: '',
  };

  /** Comparisons are immutable for a version pair, so they are cached for the session. */
  const comparisonCache = new Map();
  const detailCache = new Map();

  let viewer = null;
  let viewerHost = null;
  let loadedVersionId = null;
  /** Guards against a slow load finishing after a newer one — the stale-model flash. */
  let loadToken = 0;
  let framedOnce = false;

  const notify = () => { for (const listener of listeners) listener(); };
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };

  const versionAt = index => state.timeline[index] ?? null;
  const indexOf = versionId => state.timeline.findIndex(entry => entry.versionId === versionId);
  const selected = () => state.timeline.find(e => e.versionId === state.selectedVersionId) ?? null;
  const baseline = () => state.timeline.find(e => e.versionId === state.baselineVersionId) ?? null;

  /** The version before this one, which is the default comparison baseline. */
  function previousOf(versionId) {
    const index = indexOf(versionId);
    return index > 0 ? state.timeline[index - 1] : null;
  }

  /* ── data ────────────────────────────────────────────────────────────────────────────────── */

  async function load() {
    try {
      const payload = await fetchJson(`${BIM_API}/timeline`);
      state.timeline = (payload.versions ?? []).filter(entry => entry.status === 'CONVERTED');
      state.placement = payload.placement ?? {};
      if (!state.selectedVersionId || indexOf(state.selectedVersionId) < 0) {
        state.selectedVersionId = payload.activeVersionId
          ?? state.timeline[state.timeline.length - 1]?.versionId ?? null;
      }
      if (!state.baselineVersionId || indexOf(state.baselineVersionId) < 0) {
        state.baselineVersionId = previousOf(state.selectedVersionId)?.versionId ?? null;
      }
      state.error = null;
      state.loaded = true;
    } catch (cause) {
      // Ours, not Speckle's: the construction API is what failed.
      state.error = `The construction API could not be reached, so the BIM timeline is unknown: `
        + `${cause?.message ?? cause}`;
      state.loaded = true;
    }
    notify();
    /*
     * SHOW THE VERSION, don't just compare it.
     *
     * A screen's `activate()` runs the moment its tab is shown, which is BEFORE this async load
     * has resolved — so `showVersion(selectedVersionId)` was called with null, returned early,
     * and nothing ever loaded the GLB. Whichever of the two finishes last does the showing, so
     * the order no longer matters.
     */
    if (viewer) await showVersion(state.selectedVersionId);
    else await refreshComparison();
  }

  /**
   * The comparison for the current pair, from cache when possible.
   *
   * Always fetched UNFILTERED. Filtering is a view concern — doing it server-side would mean the
   * 3D colouring and the list disagreed the moment somebody typed in the search box.
   */
  async function refreshComparison() {
    const from = state.baselineVersionId;
    const to = state.selectedVersionId;
    if (!from || !to || from === to) {
      state.comparison = null;
      viewer?.setChanges(null);
      notify();
      return null;
    }
    const key = `${from}→${to}`;
    if (comparisonCache.has(key)) {
      state.comparison = comparisonCache.get(key);
    } else {
      try {
        const payload = await fetchJson(
          `${BIM_API}/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
        comparisonCache.set(key, payload);
        state.comparison = payload;
      } catch (cause) {
        state.comparison = null;
        state.note = `The comparison could not be read: ${cause?.message ?? cause}`;
      }
    }
    applyAppearance();
    notify();
    return state.comparison;
  }

  /** ifcGuid → change kind, for the viewer. Built from the WHOLE comparison, never the filtered view. */
  function changeMap() {
    if (!state.comparison) return null;
    const map = {};
    for (const entry of state.comparison.elements ?? []) map[entry.ifcGuid] = entry.kind;
    return map;
  }

  /** The change record for one element, if the current comparison has one. */
  const changeFor = guid => (state.comparison?.elements ?? [])
    .find(entry => entry.ifcGuid === guid) ?? null;

  async function elementDetail(guid) {
    if (!guid) return null;
    if (detailCache.has(guid)) return detailCache.get(guid);
    try {
      const payload = await fetchJson(`${BIM_API}/elements/${encodeURIComponent(guid)}`);
      detailCache.set(guid, payload);
      return payload;
    } catch (cause) {
      // A REMOVED element is genuinely not in the active version. That is an answer, not an error.
      const miss = { element: null,
        reason: 'This element is not in the version currently loaded — it exists in the earlier '
          + `version only. ${cause?.message ?? ''}`.trim() };
      detailCache.set(guid, miss);
      return miss;
    }
  }

  /* ── the viewer ──────────────────────────────────────────────────────────────────────────── */

  /**
   * Hand the viewer to a pane.
   *
   * The container is MOVED, not re-created: `append` of an existing node re-parents it, so the
   * WebGL context, the loaded model and the camera all survive the tab switch. Cesium needs a
   * resize nudge afterwards because the canvas has changed box.
   */
  function attach(host, { onPick } = {}) {
    if (!viewer) {
      viewer = viewerFactory(host, {
        onPick: (guid, feature, { additive = false } = {}) => {
          // ONE source of truth: a pick sets the shared selection, and both views read it.
          if (guid && (additive || state.multiSelect)) void toggle(guid);
          else if (guid) void select(guid);
          onPick?.(guid);
        },
      });
      viewerHost = host;
      // The timeline may already have loaded while there was no viewer to draw into.
      if (state.selectedVersionId && loadedVersionId !== state.selectedVersionId) {
        void showVersion(state.selectedVersionId);
      }
      return viewer;
    }
    if (viewerHost !== host) {
      host.append(viewer.container);
      viewerHost = host;
      // The canvas moved into a differently-sized box; without this the scene keeps the old
      // aspect ratio and the model sits squashed until something else forces a resize.
      try { viewer.viewer.resize(); } catch { /* the widget is gone */ }
      viewer.viewer.scene.requestRender();
    }
    return viewer;
  }

  /**
   * Show a version's geometry.
   *
   * PRESERVES THE CAMERA. The pose is captured before the swap and restored after, so stepping
   * through versions keeps the angle and zoom the operator chose. Only the first load frames the
   * model, and only an explicit request reframes it afterwards.
   */
  async function showVersion(versionId, { reframe = false } = {}) {
    if (!versionId || indexOf(versionId) < 0) return false;
    const changed = state.selectedVersionId !== versionId;
    state.selectedVersionId = versionId;
    if (changed) {
      // The baseline follows the selection unless the operator pinned one explicitly.
      if (!state.baselinePinned) {
        state.baselineVersionId = previousOf(versionId)?.versionId ?? null;
      }
    }
    notify();

    const entry = state.timeline[indexOf(versionId)];
    if (!viewer || !entry?.glbUrl) { await refreshComparison(); return false; }

    if (loadedVersionId !== versionId) {
      const token = ++loadToken;
      const pose = viewer.cameraPose();
      try {
        // The GLB is served with an immutable cache header and keyed by version id, so stepping
        // back and forth hits the browser cache and NEVER reaches Speckle.
        await viewer.load(entry.glbUrl, state.placement);
      } catch (cause) {
        if (token === loadToken) {
          state.note = `Version ${entry.label} could not be displayed: ${cause?.message ?? cause}`;
          notify();
        }
        return false;
      }
      // A newer request overtook this one. Dropping the result is what stops a stale model
      // flashing up mid-playback.
      if (token !== loadToken) return false;
      loadedVersionId = versionId;
      if (!framedOnce || reframe) {
        // The BUILDING, not the whole model: `focusBounds` excludes the survey markers that
        // otherwise triple the bounding radius and leave the house a speck.
        frameTo(entry, { animate: true });
        framedOnce = true;
      } else if (pose) {
        viewer.restorePose(pose);
      }
    } else if (reframe) {
      frameTo(entry, { animate: true });
    }

    await refreshComparison();
    /*
     * The selection survives a version change when the element is still there, and is dropped
     * with a word when it is not.
     *
     * This prunes the WHOLE selection, element by element. It used to clear the single
     * `selectedGuid` only, which after Phase 10B left `selectedGuids` holding elements the
     * viewer had stopped highlighting — the strip said three were chosen while the model showed
     * none, and the create drawer would have carried elements the current version does not have.
     */
    if (state.selectedGuids.length && state.comparison) {
      const present = new Set((state.comparison.elements ?? []).map(entry_ => entry_.ifcGuid));
      const kept = state.selectedGuids.filter(guid => present.has(guid));
      if (kept.length !== state.selectedGuids.length) {
        const dropped = state.selectedGuids.length - kept.length;
        state.note = dropped === state.selectedGuids.length
          ? 'The element(s) you had selected are not in this version, so the selection was cleared.'
          : `${dropped} selected element(s) are not in this version, so they were dropped from `
            + 'the selection.';
        state.selectedGuids = kept;
        state.selectedGuid = kept.includes(state.selectedGuid) ? state.selectedGuid
          : kept.at(-1) ?? null;
        viewer?.selectMany(kept);
      }
    }
    applyAppearance();
    notify();
    return true;
  }

  /** Frame a version's building, falling back to the whole model when no focus is known. */
  function frameTo(entry, options = {}) {
    if (!viewer) return false;
    if (entry?.focusBounds && viewer.fitBounds(entry.focusBounds, options)) return true;
    return viewer.fit(options);
  }

  /** Paint the model in its original materials, or by change kind. */
  function applyAppearance() {
    if (!viewer) return;
    if (state.appearance === APPEARANCE.ORIGINAL) {
      // The original materials are never replaced — the style is simply removed, so this is a
      // toggle rather than a destructive recolour.
      viewer.setChanges(null);
      viewer.setHiddenKinds(null);
      return;
    }
    viewer.setChanges(changeMap());
    viewer.setHiddenKinds(state.hiddenKinds);
  }

  /* ── actions ─────────────────────────────────────────────────────────────────────────────── */

  async function select(guid, { zoom = false } = {}) {
    state.selectedGuid = guid ?? null;
    state.selectedGuids = guid ? [String(guid)] : [];
    viewer?.select(state.selectedGuid);
    notify();
    if (!guid) return null;
    const detail = await elementDetail(guid);
    if (zoom && detail?.element?.bounds) viewer?.fitElement(detail.element.bounds);
    notify();
    return detail;
  }

  /** Add or remove one element. The building block of a create-from-geometry selection. */
  async function toggle(guid) {
    if (!guid) return null;
    const key = String(guid);
    const next = state.selectedGuids.includes(key)
      ? state.selectedGuids.filter(entry => entry !== key)
      : [...state.selectedGuids, key];
    state.selectedGuids = next;
    state.selectedGuid = next.includes(key) ? key : next.at(-1) ?? null;
    viewer?.selectMany(next);
    notify();
    return state.selectedGuid ? elementDetail(state.selectedGuid) : null;
  }

  function clearSelection() {
    state.selectedGuids = [];
    state.selectedGuid = null;
    viewer?.clearSelection();
    notify();
  }

  function setMultiSelect(on) {
    state.multiSelect = Boolean(on);
    viewer?.setMultiSelect(state.multiSelect);
    notify();
  }

  /**
   * The selected elements with their IFC identity, for a task created from them.
   *
   * Resolved through `elementDetail`, which reads the stored Speckle element — so what is sent is
   * the IFC GlobalId and class as PUBLISHED, never a viewer feature id or a label scraped off the
   * screen. An element the active version does not have is dropped rather than sent as a guess.
   */
  async function selectedElements() {
    const resolved = await Promise.all(state.selectedGuids.map(async guid => {
      const detail = await elementDetail(guid);
      const element = detail?.element ?? null;
      if (!element) return null;
      return { ifcGuid: guid, ifcType: element.ifcType ?? null, name: element.name ?? null,
        storey: element.storey ?? null };
    }));
    return resolved.filter(Boolean);
  }

  function setBaseline(versionId, { pinned = true } = {}) {
    state.baselineVersionId = versionId ?? null;
    state.baselinePinned = pinned;
    return refreshComparison();
  }

  function setAppearance(next) {
    state.appearance = next === APPEARANCE.ORIGINAL ? APPEARANCE.ORIGINAL : APPEARANCE.CHANGES;
    applyAppearance();
    notify();
  }

  function toggleKind(kind) {
    if (state.hiddenKinds.has(kind)) state.hiddenKinds.delete(kind);
    else state.hiddenKinds.add(kind);
    applyAppearance();
    notify();
  }

  function step(delta) {
    const index = indexOf(state.selectedVersionId);
    const next = Math.min(Math.max(index + delta, 0), state.timeline.length - 1);
    if (next === index || next < 0) return false;
    void showVersion(state.timeline[next].versionId);
    return true;
  }

  function swap() {
    const from = state.baselineVersionId;
    const to = state.selectedVersionId;
    if (!from || !to) return false;
    state.baselinePinned = true;
    state.baselineVersionId = to;
    void showVersion(from);
    return true;
  }

  return {
    state,
    subscribe,
    /** "Zoom to building" — the focus bounds, not the raw sphere. */
    frame(options) { return frameTo(selected(), options); },
    load,
    attach,
    showVersion,
    select,
    toggle,
    clearSelection,
    setMultiSelect,
    selectedElements,
    setBaseline,
    setAppearance,
    toggleKind,
    step,
    swap,
    refreshComparison,
    elementDetail,
    changeFor,
    changeMap,
    previousOf,
    versionAt,
    indexOf,
    selected,
    baseline,
    get viewer() { return viewer; },
    get loadedVersionId() { return loadedVersionId; },
    clearNote() { state.note = ''; },
    destroy() {
      listeners.clear();
      viewer?.destroy();
      viewer = null;
      viewerHost = null;
    },
  };
}
