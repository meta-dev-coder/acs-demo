/*---------------------------------------------------------------------------------------------
 * Scenario C — M4: Compare split-view store.
 *
 * Holds the dual-strategy compare state:
 *   - compareMode (boolean): whether the split-view is active
 *   - strategyA / strategyB: the two pricing strategies to compare
 *   - pricedSectionsA / pricedSectionsB: computed for both strategies
 *   - kpiA / kpiB: aggregated KPIs for both strategies
 *   - timeBlock: shared time block for both strategies
 *
 * This is the "A-left / B-right" split view from §4 Concept 3 / v2 brief.
 * Two viewer panes each render the full corridor under one strategy.
 *
 * Node-env safe — no React or DOM imports.
 *--------------------------------------------------------------------------------------------*/
import { computeCorridorPricing } from "./pricing";
import type { TimeBlock, PricingStrategy, SectionPricingResult } from "./types";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface CompareKpi {
  speedHeld: boolean;
  projectedRevenuePerHour: number;
  corridorUtilization: number;
  safetyFlagCount: number;
  corridorTotalRate: number;
}

export interface CompareState {
  /** Whether the split-view compare mode is active. Default OFF → single view. */
  compareMode: boolean;
  /** Shared time-of-day block for both strategies. */
  timeBlock: TimeBlock;
  /** Strategy for the left pane (Strategy A). */
  strategyA: PricingStrategy;
  /** Strategy for the right pane (Strategy B). */
  strategyB: PricingStrategy;
  /** Computed pricing results for Strategy A (all 3 sections). */
  pricedSectionsA: SectionPricingResult[];
  /** Computed pricing results for Strategy B (all 3 sections). */
  pricedSectionsB: SectionPricingResult[];
  /** Aggregated KPIs for Strategy A. */
  kpiA: CompareKpi;
  /** Aggregated KPIs for Strategy B. */
  kpiB: CompareKpi;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_TIME_BLOCK: TimeBlock = "morning_peak_eb";
const DEFAULT_STRATEGY_A: PricingStrategy = "moderate_variable";
const DEFAULT_STRATEGY_B: PricingStrategy = "aggressive";

function buildKpi(sections: SectionPricingResult[]): CompareKpi {
  return {
    speedHeld: sections.every((s) => s.speed >= 45),
    projectedRevenuePerHour: sections.reduce((t, s) => t + s.revenuePerHour, 0),
    corridorUtilization: sections.reduce((t, s) => t + s.utilization, 0) / sections.length,
    safetyFlagCount: sections.filter((s) => s.safetyFlag).length,
    corridorTotalRate: sections.reduce((t, s) => t + s.postedRate, 0),
  };
}

function recomputeCompare(
  timeBlock: TimeBlock,
  strategyA: PricingStrategy,
  strategyB: PricingStrategy
): Pick<CompareState, "pricedSectionsA" | "pricedSectionsB" | "kpiA" | "kpiB"> {
  const resultA = computeCorridorPricing(timeBlock, strategyA);
  const resultB = computeCorridorPricing(timeBlock, strategyB);

  return {
    pricedSectionsA: resultA.sections,
    pricedSectionsB: resultB.sections,
    kpiA: buildKpi(resultA.sections),
    kpiB: buildKpi(resultB.sections),
  };
}

function buildInitial(): CompareState {
  const computed = recomputeCompare(DEFAULT_TIME_BLOCK, DEFAULT_STRATEGY_A, DEFAULT_STRATEGY_B);
  return {
    compareMode: false,
    timeBlock: DEFAULT_TIME_BLOCK,
    strategyA: DEFAULT_STRATEGY_A,
    strategyB: DEFAULT_STRATEGY_B,
    ...computed,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const INITIAL_COMPARE_STATE: CompareState = buildInitial();

let state: CompareState = { ...INITIAL_COMPARE_STATE };

const listeners = new Set<() => void>();

function set(patch: Partial<CompareState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function setAndRecompute(
  patch: Partial<Pick<CompareState, "timeBlock" | "strategyA" | "strategyB">>
): void {
  const next = { ...state, ...patch };
  const computed = recomputeCompare(next.timeBlock, next.strategyA, next.strategyB);
  set({ ...patch, ...computed });
}

export const compareStore = {
  getSnapshot: (): CompareState => state,

  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },

  /** Reset to initial state (used in tests). */
  reset(): void {
    state = buildInitial();
    listeners.forEach((l) => l());
  },

  /** Toggle compare (split-view) mode on or off. */
  setCompareMode(compareMode: boolean): void {
    set({ compareMode });
  },

  /** Change the shared time block for both strategy panes. */
  setTimeBlock(timeBlock: TimeBlock): void {
    setAndRecompute({ timeBlock });
  },

  /** Change Strategy A (left pane) and recompute. */
  setStrategyA(strategyA: PricingStrategy): void {
    setAndRecompute({ strategyA });
  },

  /** Change Strategy B (right pane) and recompute. */
  setStrategyB(strategyB: PricingStrategy): void {
    setAndRecompute({ strategyB });
  },
};

/** Get the current Compare state snapshot. */
export function compareSnapshot(): CompareState {
  return compareStore.getSnapshot();
}
