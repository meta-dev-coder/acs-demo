/**
 * What the operator is looking at, shared by every screen in the Construction demo.
 *
 * The journey this exists for: open Project Overview, click an activity that needs a BIM mapping,
 * land in Construction Lifecycle with that activity already selected, open Link BIM, pick the
 * elements, approve, come back to Execute and see them highlighted — without choosing the same
 * activity or the same element again at any point.
 *
 * Phase 9D solved exactly this problem for the two BIM subtabs with `bimWorkspace`, and the
 * lesson from that one is the reason this is a separate, smaller module: the BIM workspace owns a
 * Cesium viewer and a comparison cache, which no other screen wants. This holds IDENTIFIERS ONLY
 * — a handful of strings — so any screen can read or set them without taking on a 3D context.
 *
 * It is persisted to `sessionStorage`, not `localStorage`: a selection is about this sitting, and
 * an activity silently still selected a week later is a stale answer to a question nobody asked.
 * Every read is defensive — storage can be absent, full, or throw in a private window — and the
 * context works perfectly well with none of it.
 */

export const STORAGE_KEY = 'acs-construction-selection';

/** The identifiers a screen may need. All optional; a null means "nothing chosen". */
export const EMPTY = Object.freeze({
  /** OpenProject project id and the work package in focus. */
  projectId: null,
  workPackageId: null,
  /** Speckle model, the version being looked at, and one IFC element. */
  speckleModelId: null,
  versionId: null,
  ifcGuid: null,
  /** The date progress is being reported against. Defaults to today on first use. */
  reportingDate: null,
  /** An issue or approval being investigated, so a screen can open on it. */
  issueId: null,
  approvalId: null,
  /** Which lifecycle stage the workspace should open on. */
  stageId: null,
});

const KEYS = Object.freeze(Object.keys(EMPTY));

/** Today, as `YYYY-MM-DD`. The default reporting date. */
export const today = (now = new Date()) => now.toISOString().slice(0, 10);

function read(storage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Only known keys, only strings. A storage value is attacker-adjacent input in the sense
    // that it survives reloads and nobody re-checks it; a stray key would flow into a URL.
    return Object.fromEntries(KEYS
      .filter(key => typeof parsed?.[key] === 'string' && parsed[key])
      .map(key => [key, parsed[key]]));
  } catch {
    return {};
  }
}

export function createSelectionContext({ storage = globalThis.sessionStorage } = {}) {
  const listeners = new Set();
  const state = { ...EMPTY, ...read(storage), };
  state.reportingDate ??= today();

  function persist() {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(
        Object.fromEntries(Object.entries(state).filter(([, value]) => value != null))));
    } catch {
      // Private windows, cleared site data, quota. The context is authoritative in memory; the
      // storage copy is a convenience and losing it costs the operator one re-selection.
    }
  }

  const notify = changed => {
    for (const listener of listeners) {
      try { listener(state, changed); } catch { /* one bad subscriber must not stop the rest */ }
    }
  };

  /**
   * Change part of the selection.
   *
   * Only notifies when something ACTUALLY changed — a screen that re-asserts the current
   * selection on every render would otherwise drive an endless re-render loop through its own
   * subscription.
   */
  function set(patch = {}) {
    const changed = [];
    for (const key of KEYS) {
      if (!(key in patch)) continue;
      const next = patch[key] == null ? null : String(patch[key]);
      if (state[key] === next) continue;
      state[key] = next;
      changed.push(key);
    }
    if (!changed.length) return changed;
    persist();
    notify(changed);
    return changed;
  }

  return {
    get state() { return { ...state }; },
    get: key => state[key] ?? null,
    set,
    /** Clear everything except the reporting date, which is a view setting rather than a target. */
    reset() {
      set(Object.fromEntries(KEYS.filter(key => key !== 'reportingDate').map(key => [key, null])));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** For tests, and for a host tearing the demo down. */
    destroy() { listeners.clear(); },
  };
}

/**
 * The one context the application uses.
 *
 * A module-level singleton rather than something threaded through every factory: the whole point
 * is that unrelated screens agree, and an instance passed down a tree is one refactor away from
 * two screens holding different copies.
 */
let shared = null;
export function sharedSelection(options) {
  shared ??= createSelectionContext(options);
  return shared;
}

/** For tests: start from nothing without reaching into module state by hand. */
export function resetSharedSelection() {
  shared?.destroy();
  shared = null;
}
