/*---------------------------------------------------------------------------------------------
 * Scenario C — M4: Presentation mode animation store.
 *
 * Manages the optional Presentation mode (default OFF → static operator view stays default):
 *   - presentationMode: opt-in toggle (OFF by default)
 *   - isPlaying: "Play AM Peak" time-lapse playing flag
 *   - currentStepIndex: which step of the time-lapse the demo is on
 *   - timeLapseSteps: the discrete AM Peak step sequence (density climbs, tolls step up)
 *   - tweenActive: true during a ~400ms step transition (cleared after tweenDurationMs)
 *   - tweenDurationMs: transition duration in ms (~400ms per spec §4.5)
 *   - stepIntervalMs: how long each step is shown in the demo loop (~10s / N steps)
 *   - demandFlowActive: demand-shift flow animation on/off
 *   - safetyFlagPulsing: safety flag pulse animation on/off
 *
 * Key design constraints (§4.5 + spec):
 *   - Price stays DISCRETE on 15-min beat — only visual transitions animate
 *   - Steps are bounded (no infinite loop — stops at last step unless reset)
 *   - tweenActive auto-clears after tweenDurationMs
 *   - Default OFF → turning it off restores the exact static operator-accurate view
 *
 * Node-env safe — no React or DOM imports. Uses globalThis.setTimeout / clearTimeout.
 *--------------------------------------------------------------------------------------------*/
import type { TimeBlock } from "./types";

// ---------------------------------------------------------------------------
// Step definition — one discrete 15-min beat in the AM Peak time-lapse
// ---------------------------------------------------------------------------

export interface TimeLapseStep {
  /** Human-readable label for this step (e.g. "06:00 — Low demand"). */
  label: string;
  /** Time block for this step (all AM Peak steps use "morning_peak_eb"). */
  timeBlock: TimeBlock;
  /**
   * Density multiplier applied to the base traffic state for this step.
   * Density = baseDensity × densityMultiplier.
   * Multiplier > 1 simulates rising demand (later in AM Peak).
   * This is the only mechanism — prices come from the LOS table, never interpolated.
   */
  densityMultiplier: number;
}

// AM Peak time-lapse: 5 discrete 15-min beats from 7:00 to 8:00
// Density climbs from low to LOS-E; the LOS table steps tolls up accordingly.
export const AM_PEAK_STEPS: TimeLapseStep[] = [
  { label: "07:00 — Light demand",    timeBlock: "morning_peak_eb", densityMultiplier: 0.60 },
  { label: "07:15 — Demand building", timeBlock: "morning_peak_eb", densityMultiplier: 0.75 },
  { label: "07:30 — Peak onset",      timeBlock: "morning_peak_eb", densityMultiplier: 0.90 },
  { label: "07:45 — Full peak",       timeBlock: "morning_peak_eb", densityMultiplier: 1.00 },
  { label: "08:00 — Peak+",           timeBlock: "morning_peak_eb", densityMultiplier: 1.10 },
];

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface PresentationState {
  /**
   * Whether Presentation mode is active (opt-in, default OFF).
   * When OFF → the static operator-accurate view is shown, no animation.
   */
  presentationMode: boolean;
  /** Whether the AM Peak time-lapse is currently auto-playing. */
  isPlaying: boolean;
  /** Index into timeLapseSteps of the currently displayed step. */
  currentStepIndex: number;
  /** The discrete steps in the AM Peak time-lapse. */
  timeLapseSteps: TimeLapseStep[];
  /**
   * True during a visual step transition (~400ms tween).
   * Auto-clears after tweenDurationMs. Price is already at the new discrete level;
   * tweenActive only drives the visual highlight (ribbon recolor transition).
   */
  tweenActive: boolean;
  /** Duration of the step-transition visual tween in ms (target: ~400ms). */
  tweenDurationMs: number;
  /** Interval between auto-play steps in ms (target: ~10s loop / N steps). */
  stepIntervalMs: number;
  /** Whether the demand-shift flow animation is active on the ribbon. */
  demandFlowActive: boolean;
  /** Whether the safety flag is pulsing red (fires when SEG-MN-E > ~95%). */
  safetyFlagPulsing: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TWEEN_DURATION_MS = 400; // ~400ms per spec §4.5(a)
const STEP_INTERVAL_MS = 1800; // ~1.8s per step = ~9s for 5-step loop

function buildInitial(): PresentationState {
  return {
    presentationMode: false,
    isPlaying: false,
    currentStepIndex: 0,
    timeLapseSteps: AM_PEAK_STEPS,
    tweenActive: false,
    tweenDurationMs: TWEEN_DURATION_MS,
    stepIntervalMs: STEP_INTERVAL_MS,
    demandFlowActive: false,
    safetyFlagPulsing: false,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const INITIAL_PRESENTATION_STATE: PresentationState = buildInitial();

let state: PresentationState = buildInitial();

const listeners = new Set<() => void>();

// Timer handles for tween auto-clear and playback
let tweenTimer: ReturnType<typeof setTimeout> | null = null;
let playTimer: ReturnType<typeof setTimeout> | null = null;

function set(patch: Partial<PresentationState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

/** Clear any pending tween timer. */
function clearTweenTimer(): void {
  if (tweenTimer !== null) {
    clearTimeout(tweenTimer);
    tweenTimer = null;
  }
}

/** Clear any pending play timer. */
function clearPlayTimer(): void {
  if (playTimer !== null) {
    clearTimeout(playTimer);
    playTimer = null;
  }
}

/** Advance to the given step index, setting tweenActive + scheduling its clearance. */
function advanceToStep(stepIndex: number): void {
  const clampedIdx = Math.min(stepIndex, state.timeLapseSteps.length - 1);
  clearTweenTimer();
  set({ currentStepIndex: clampedIdx, tweenActive: true });
  // Auto-clear tween after tweenDurationMs
  tweenTimer = setTimeout(() => {
    set({ tweenActive: false });
    tweenTimer = null;
  }, state.tweenDurationMs);
}

/** Schedule the next auto-play step. Stops when last step reached. */
function scheduleNextStep(): void {
  clearPlayTimer();
  if (!state.isPlaying) return;
  const nextIdx = state.currentStepIndex + 1;
  if (nextIdx >= state.timeLapseSteps.length) {
    // Reached last step — stop auto-play (bounded, not a loop)
    set({ isPlaying: false });
    return;
  }
  playTimer = setTimeout(() => {
    advanceToStep(nextIdx);
    scheduleNextStep();
  }, state.stepIntervalMs);
}

export const presentationStore = {
  getSnapshot: (): PresentationState => state,

  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },

  /** Reset to initial state (clears all timers). Used in tests. */
  reset(): void {
    clearTweenTimer();
    clearPlayTimer();
    state = buildInitial();
    listeners.forEach((l) => l());
  },

  /** Enable or disable Presentation mode (opt-in, default OFF).
   *  Turning OFF stops any active playback. */
  setPresentationMode(presentationMode: boolean): void {
    if (!presentationMode) {
      clearPlayTimer();
      set({ presentationMode, isPlaying: false });
    } else {
      set({ presentationMode });
    }
  },

  /** Start the AM Peak time-lapse auto-play.
   *  No-op if presentation mode is OFF (static view stays default). */
  play(): void {
    if (!state.presentationMode) return;
    if (state.isPlaying) return;
    set({ isPlaying: true });
    scheduleNextStep();
  },

  /** Pause the time-lapse auto-play. */
  pause(): void {
    clearPlayTimer();
    set({ isPlaying: false });
  },

  /** Manually advance one step (discrete beat, not continuous). */
  stepForward(): void {
    const nextIdx = state.currentStepIndex + 1;
    if (nextIdx >= state.timeLapseSteps.length) return; // bounded at last step
    advanceToStep(nextIdx);
  },

  /** Reset the time-lapse to step 0 (without clearing presentation mode). */
  resetTimeLapse(): void {
    clearPlayTimer();
    clearTweenTimer();
    set({ isPlaying: false, currentStepIndex: 0, tweenActive: false });
  },

  /** Enable or disable the demand-shift flow animation cue. */
  setDemandFlowActive(demandFlowActive: boolean): void {
    set({ demandFlowActive });
  },

  /** Enable or disable the pulsing safety flag animation. */
  setSafetyFlagPulsing(safetyFlagPulsing: boolean): void {
    set({ safetyFlagPulsing });
  },
};

/** Get the current Presentation state snapshot. */
export function presentationSnapshot(): PresentationState {
  return presentationStore.getSnapshot();
}
