/*---------------------------------------------------------------------------------------------
 * Scenario D — Lane Closure store slice (Concept A snapshot + Concept B playback).
 *
 * useSyncExternalStore-compatible singleton (same pattern as scenarioC/storeC.ts and
 * scenarioA/store.ts). Holds the active ClosureEvent, the pre-computed tickHistory from
 * computeClosureSim(), the Concept A before/after toggle, the Concept B playback state, and
 * the aggregated KPIs.
 *
 * setClosureEvent() runs the full deterministic sim ONCE and caches tickHistory; Concept A's
 * "after" snapshot is the tick at t = durationMin + evalTAfterOffsetMin; Concept B scrubbing is
 * an O(1) lookup into tickHistory. setConceptAMode() is display-only.
 *
 * Concept B (M6): play()/pause()/scrubTo()/advanceTick() drive tickIndex. advanceTick notifies
 * React listeners only on a COARSE cadence (every coarseKpiEveryNTicks, plus an unconditional
 * final-tick emit) so a 60–120-tick animation never triggers 60–120 full Shell re-renders. The
 * decorator is refreshed every tick by managerD's rAF loop via the decoratorNeedsUpdate flag —
 * this file makes NO animation-frame calls and NO decorator-invalidation calls (the rAF loop and
 * the cached-decoration invalidation both live in managerD.ts only).
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
  /** Concept B playback state. */
  playbackState: PlaybackState;
  /** Current playback tick index into tickHistory. */
  tickIndex: number;
  /** Last tick index of the cached simulation (tickHistory.length - 1). */
  maxTicks: number;
  /** Playback speed multiplier (1 / 2 / 4) applied to the ~30s window pacing. */
  playbackSpeed: number;
  /** Dynamic toll pricing ON (variable strategy) vs OFF (flat/static) — drives the net-revenue position. */
  dynamicPricing: boolean;
  /** Full pre-computed per-tick simulation history (empty when no event). */
  tickHistory: ClosureSimState[];
  /** True when the decorator needs a redraw — set every advanceTick, cleared by managerD's rAF. */
  decoratorNeedsUpdate: boolean;
}

const ZERO_KPI: StateDKpi = {
  maxQueueMi: 0,
  vehHrsDelay: 0,
  clearanceMin: 0,
  currentTollUsd: 0,
  pctDiverted: 0,
  delayCostUsd: 0,
  expressRevenueProtectedUsd: 0,
  travelTimeMin: 0,
  divertedVph: 0,
  secondaryIncidentRisk: 0,
  netRevenueUsd: 0,
};

const CONCEPT_A_TICKS = config.maxTicks as number; // 240 ticks = 2h at dt=30s (initial/default window)
const DT_MIN = (config.simDtSec as number) / 60;
const EVAL_T_AFTER_OFFSET_MIN = config.evalTAfterOffsetMin as number;
const COARSE_N = config.coarseKpiEveryNTicks as number; // React-notify cadence during playback
const SIM_TICKS_CAP = 1200; // ≤ 10h sim window guard (scope: closures span 1–8 hours)

/** Sim length for an event: the closure window + an equal recovery (off-peak taper drains the
 *  queue) + a 30-min margin, so the queue builds AND visibly clears for any 1–8h closure. */
function simTicksForEvent(event: ClosureEvent): number {
  const windowMin = event.durationMin * 2 + 30;
  return Math.min(SIM_TICKS_CAP, Math.max(120, Math.round(windowMin / DT_MIN)));
}

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
    playbackSpeed: 1,
    dynamicPricing: true,
    tickHistory: [],
    decoratorNeedsUpdate: false,
  };
}

/** Run the deterministic sim for an event under the chosen pricing mode, returning the derived
 *  tickHistory + Concept A snapshot index + final KPIs. Shared by setClosureEvent + setDynamicPricing. */
function runSim(event: ClosureEvent, dynamicPricing: boolean) {
  const strategy = dynamicPricing ? "moderate_variable" : "current_static";
  const { tickHistory, finalKpi } = computeClosureSim(event, simTicksForEvent(event), strategy);
  const evalIdx = conceptAEvalIndex(event, tickHistory.length);
  return { tickHistory, finalKpi, evalIdx, conceptASnapshot: tickHistory[evalIdx] ?? null };
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
   * (throws for an invalid lanesClosed — §8-fix-2), runs the full deterministic simulation
   * ONCE, caches tickHistory, derives the Concept A "after" snapshot + aggregated KPIs, and
   * resets playback to tick 0. Passing null returns to the free-flow baseline. Notifies once.
   */
  setClosureEvent(event: ClosureEvent | null): void {
    if (event === null) {
      set({
        activeEvent: null,
        conceptASnapshot: null,
        kpi: { ...ZERO_KPI },
        tickHistory: [],
        tickIndex: 0,
        maxTicks: CONCEPT_A_TICKS,
        displayMode: "before",
        playbackState: "idle",
        decoratorNeedsUpdate: false,
      });
      return;
    }

    // Validate lane-closure configuration (throws on invalid lanesClosed for the segment).
    buildClosureSegment(event);

    const { tickHistory, finalKpi, conceptASnapshot } = runSim(event, state.dynamicPricing);

    set({
      activeEvent: event,
      tickHistory,
      conceptASnapshot,
      kpi: finalKpi,
      displayMode: "after",
      tickIndex: 0, // Concept B animation starts at t=0 (Concept A view reads conceptASnapshot)
      maxTicks: Math.max(0, tickHistory.length - 1),
      playbackState: "idle",
      decoratorNeedsUpdate: false,
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

  // ---- Concept B playback (M6) ----

  /** Start playback. Restarts from t=0 if currently at the end. Notifies once. */
  play(): void {
    const idx = state.tickIndex >= state.maxTicks ? 0 : state.tickIndex;
    set({ playbackState: "playing", tickIndex: idx, decoratorNeedsUpdate: true });
  },

  /** Pause playback. Notifies once. */
  pause(): void {
    set({ playbackState: "paused" });
  },

  /** Set the playback speed multiplier (1/2/4). The play loop re-reads this on (re)start. */
  setPlaybackSpeed(mult: number): void {
    set({ playbackSpeed: mult });
  },

  /** Toggle dynamic toll pricing (variable vs flat/static); re-runs the sim if a closure is active. */
  setDynamicPricing(on: boolean): void {
    if (!state.activeEvent) {
      set({ dynamicPricing: on });
      return;
    }
    const { tickHistory, finalKpi, conceptASnapshot } = runSim(state.activeEvent, on);
    set({
      dynamicPricing: on,
      tickHistory,
      conceptASnapshot,
      kpi: finalKpi,
      maxTicks: Math.max(0, tickHistory.length - 1),
      decoratorNeedsUpdate: true,
    });
  },

  /** Scrub to an absolute tick index (clamped). O(1) lookup into the cached tickHistory. Notifies. */
  scrubTo(n: number): void {
    const idx = Math.max(0, Math.min(state.maxTicks, Math.round(n)));
    set({ tickIndex: idx, playbackState: "paused", decoratorNeedsUpdate: true });
  },

  /**
   * Advance one tick. Always updates tickIndex + sets decoratorNeedsUpdate (so managerD's rAF
   * redraws the decorator every tick), but notifies React listeners only on the COARSE cadence
   * (every COARSE_N ticks) plus an UNCONDITIONAL final-tick emit. Stops playback at the end.
   */
  advanceTick(): void {
    const next = Math.min(state.tickIndex + 1, state.maxTicks);
    const atEnd = next >= state.maxTicks;
    // Mutate state directly (no notify) so the rAF loop can read the latest tick each frame.
    state = {
      ...state,
      tickIndex: next,
      decoratorNeedsUpdate: true,
      playbackState: atEnd && state.playbackState === "playing" ? "paused" : state.playbackState,
    };
    // Coarse React-notify cadence + unconditional final-tick emit.
    if (next % COARSE_N === 0 || atEnd) {
      listeners.forEach((l) => l());
    }
  },

  /** Clear the decorator-redraw flag WITHOUT notifying React (managerD's rAF calls this). */
  clearDecoratorFlag(): void {
    state = { ...state, decoratorNeedsUpdate: false };
  },
};

/** Get the current Scenario D state snapshot (alias for storeD.getSnapshot()). */
export function storeDSnapshot(): StateD {
  return storeD.getSnapshot();
}
