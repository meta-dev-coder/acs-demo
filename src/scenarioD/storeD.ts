/*---------------------------------------------------------------------------------------------
 * Scenario D — Lane Closure store slice (Concept A snapshot foundation).
 *
 * useSyncExternalStore-compatible singleton (same pattern as scenarioC/storeC.ts and
 * scenarioA/store.ts). Holds the active ClosureEvent, the pre-computed tickHistory from
 * computeClosureSim(), the Concept A before/after display toggle, and the aggregated KPIs.
 *
 * setClosureEvent() runs the full deterministic sim ONCE and caches tickHistory; Concept A's
 * "after" snapshot is the tick at t = durationMin + evalTAfterOffsetMin; Concept B scrubbing
 * (M6) is an O(1) lookup into tickHistory. setConceptAMode() is a display-only state change
 * (set(), never a recompute).
 *
 * Imported in tests (node env) so this file MUST NOT import any React or DOM APIs.
 *--------------------------------------------------------------------------------------------*/
import config from "./closureConfig.json";
import { computeClosureSim, buildClosureSegment } from "./closurePhysics";
import type { ClosureEvent, ClosureSimState, StateDKpi, PlaybackState } from "./typesD";

export type DisplayMode = "before" | "after";

export interface StateD {
  /** The active operator-defined closure event, or null (free-flow baseline). */
  activeEvent: ClosureEvent | null;
  /** Concept A "after" snapshot: the sim state at t = durationMin + evalTAfterOffsetMin. */
  conceptASnapshot: ClosureSimState | null;
  /** Before/After toggle for the Concept A view. */
  displayMode: DisplayMode;
  /** Aggregated final KPIs for the active closure (zeroed when no event). */
  kpi: StateDKpi;
  /** Currently inspected segment id, or null. */
  inspectedSegmentId: string | null;
  /** Concept B playback state (M6). */
  playbackState: PlaybackState;
  /** Current playback tick index into tickHistory (M6). */
  tickIndex: number;
  /** Total ticks in the cached simulation. */
  maxTicks: number;
  /** Full pre-computed per-tick simulation history (empty when no event). */
  tickHistory: ClosureSimState[];
}

const ZERO_KPI: StateDKpi = {
  maxQueueMi: 0,
  vehHrsDelay: 0,
  clearanceMin: 0,
  currentTollUsd: 0,
  pctDiverted: 0,
  delayCostUsd: 0,
  expressRevenueProtectedUsd: 0,
};

const CONCEPT_A_TICKS = config.maxTicks as number; // 240 ticks = 2h at dt=30s
const DT_MIN = (config.simDtSec as number) / 60;
const EVAL_T_AFTER_OFFSET_MIN = config.evalTAfterOffsetMin as number;

function buildInitial(): StateD {
  return {
    activeEvent: null,
    conceptASnapshot: null,
    displayMode: "before",
    kpi: { ...ZERO_KPI },
    inspectedSegmentId: null,
    playbackState: "idle",
    tickIndex: 0,
    maxTicks: CONCEPT_A_TICKS,
    tickHistory: [],
  };
}

export const INITIAL_STATE_D: StateD = buildInitial();

let state: StateD = buildInitial();

const listeners = new Set<() => void>();

function set(patch: Partial<StateD>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

/** Index into tickHistory for the Concept A "after" snapshot (peak + recovery offset). */
function conceptAEvalIndex(event: ClosureEvent, historyLen: number): number {
  const tMin = event.durationMin + EVAL_T_AFTER_OFFSET_MIN;
  const idx = Math.round(tMin / DT_MIN);
  return Math.max(0, Math.min(historyLen - 1, idx));
}

export const storeD = {
  getSnapshot: (): StateD => state,

  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },

  /** Reset to initial free-flow state (used in tests and on tab teardown). */
  reset(): void {
    state = buildInitial();
    listeners.forEach((l) => l());
  },

  /**
   * Set (or clear) the active closure event. Validates the lane-closure configuration
   * (throws for an invalid lanesClosed on the segment — §8-fix-2), runs the full
   * deterministic simulation ONCE, caches tickHistory, and derives the Concept A "after"
   * snapshot + aggregated KPIs. Passing null returns to the free-flow baseline.
   * Notifies subscribers exactly once.
   */
  setClosureEvent(event: ClosureEvent | null): void {
    if (event === null) {
      set({
        activeEvent: null,
        conceptASnapshot: null,
        kpi: { ...ZERO_KPI },
        tickHistory: [],
        tickIndex: 0,
        displayMode: "before",
        playbackState: "idle",
      });
      return;
    }

    // Validate lane-closure configuration (throws on invalid lanesClosed for the segment).
    buildClosureSegment(event);

    const { tickHistory, finalKpi } = computeClosureSim(event, CONCEPT_A_TICKS);
    const evalIdx = conceptAEvalIndex(event, tickHistory.length);
    const conceptASnapshot = tickHistory[evalIdx] ?? null;

    set({
      activeEvent: event,
      tickHistory,
      conceptASnapshot,
      kpi: finalKpi,
      displayMode: "after",
      tickIndex: evalIdx,
      playbackState: "idle",
    });
  },

  /**
   * Concept A before/after toggle. Display-only — does NOT recompute the simulation
   * (tickHistory is already cached). Notifies subscribers once.
   */
  setConceptAMode(showAfter: boolean): void {
    set({ displayMode: showAfter ? "after" : "before" });
  },

  /** Set the inspected segment id (or null to deselect). */
  inspectClosure(segmentId: string | null): void {
    set({ inspectedSegmentId: segmentId });
  },
};

/** Get the current Scenario D state snapshot (alias for storeD.getSnapshot()). */
export function storeDSnapshot(): StateD {
  return storeD.getSnapshot();
}
