/*---------------------------------------------------------------------------------------------
 * Scenario C — Dynamic Tolling store slice.
 *
 * Lightweight useSyncExternalStore-compatible store (same pattern as src/scenarioA/store.ts).
 * Holds: timeBlock, strategy, per-section overrides, computed priced sections, KPIs, safety flags.
 * All mutations recompute corridor pricing via computeCorridorPricing() so derived state
 * (pricedSections, kpi, safety flags) is always in sync with the latest inputs.
 *
 * Imported in tests (node env) so this file MUST NOT import any React or DOM APIs.
 *--------------------------------------------------------------------------------------------*/
import { computeCorridorPricing } from "./pricing";
import type { TimeBlock, PricingStrategy, SectionPricingResult, CorridorPricingResult } from "./types";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export type ColorMode = "los" | "rate";

export interface StateCKpi {
  /** True when all express sections hold ≥ 45 mph (the mandated FDOT metric). */
  speedHeld: boolean;
  /** Σ section revenuePerHour across all sections ($/hr). */
  projectedRevenuePerHour: number;
  /** Average retained express volume / section capacity. */
  corridorUtilization: number;
  /** Number of sections where safetyFlag = true. */
  safetyFlagCount: number;
  /** Sum of all three section posted rates (the corridor-total trip price). */
  corridorTotalRate: number;
}

export interface StateC {
  /** Active time-of-day block (drives V2X stub lookups + directional reversal). */
  timeBlock: TimeBlock;
  /** Active pricing strategy preset. */
  strategy: PricingStrategy;
  /** Color-by mode for the decorator ribbon: 'los' (default) or 'rate'. */
  colorMode: ColorMode;
  /** Per-section operator override rates: sectionId → override rate ($0.50–$10.00). */
  overrides: Partial<Record<string, number>>;
  /** Computed pricing results for all 3 express sub-sections (recomputed on every mutation). */
  pricedSections: SectionPricingResult[];
  /** Aggregated corridor KPIs (recomputed on every mutation). */
  kpi: StateCKpi;
  /** Currently inspected express section id, or null. */
  inspectedSectionId: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function recompute(
  timeBlock: TimeBlock,
  strategy: PricingStrategy,
  overrides: Partial<Record<string, number>>
): Pick<StateC, "pricedSections" | "kpi"> {
  const result: CorridorPricingResult = computeCorridorPricing(
    timeBlock,
    strategy,
    overrides as Partial<Record<string, number>>
  );

  const kpi: StateCKpi = {
    speedHeld: result.speedHeld,
    projectedRevenuePerHour: result.projectedRevenuePerHour,
    corridorUtilization: result.corridorUtilization,
    safetyFlagCount: result.safetyFlagCount,
    corridorTotalRate: result.corridorTotalRate,
  };

  return { pricedSections: result.sections, kpi };
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

const DEFAULT_TIME_BLOCK: TimeBlock = "morning_peak_eb";
const DEFAULT_STRATEGY: PricingStrategy = "moderate_variable";
const DEFAULT_OVERRIDES: Partial<Record<string, number>> = {};

function buildInitial(): StateC {
  const { pricedSections, kpi } = recompute(DEFAULT_TIME_BLOCK, DEFAULT_STRATEGY, DEFAULT_OVERRIDES);
  return {
    timeBlock: DEFAULT_TIME_BLOCK,
    strategy: DEFAULT_STRATEGY,
    colorMode: "los",
    overrides: { ...DEFAULT_OVERRIDES },
    pricedSections,
    kpi,
    inspectedSectionId: null,
  };
}

export const INITIAL_STATE_C: StateC = buildInitial();

let state: StateC = { ...INITIAL_STATE_C, overrides: { ...INITIAL_STATE_C.overrides } };

const listeners = new Set<() => void>();

function set(patch: Partial<StateC>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function setAndRecompute(patch: Partial<Pick<StateC, "timeBlock" | "strategy" | "overrides">>): void {
  const next = { ...state, ...patch };
  const computed = recompute(next.timeBlock, next.strategy, next.overrides);
  set({ ...patch, ...computed });
}

// ---------------------------------------------------------------------------
// Public store API
// ---------------------------------------------------------------------------

export const storeC = {
  getSnapshot: (): StateC => state,

  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },

  /** Reset to initial state (used in tests). */
  reset(): void {
    const initial = buildInitial();
    state = { ...initial };
    listeners.forEach((l) => l());
  },

  /** Change the time-of-day block and clear overrides (direction reversal). */
  setTimeBlock(timeBlock: TimeBlock): void {
    setAndRecompute({ timeBlock, overrides: {} });
  },

  /** Change the pricing strategy and recompute. Overrides are preserved. */
  setStrategy(strategy: PricingStrategy): void {
    setAndRecompute({ strategy });
  },

  /** Set a per-section operator override ($0.50–$10.00 clamped). */
  setOverride(sectionId: string, rate: number): void {
    const clamped = Math.max(0.50, Math.min(10.00, rate));
    const overrides = { ...state.overrides, [sectionId]: clamped };
    setAndRecompute({ overrides });
  },

  /** Clear a per-section override (restores algorithm rate for that section). */
  clearOverride(sectionId: string): void {
    const overrides = { ...state.overrides };
    delete overrides[sectionId];
    setAndRecompute({ overrides });
  },

  /** Set the color-by mode for the express ribbon decorator. */
  setColorMode(colorMode: ColorMode): void {
    set({ colorMode });
  },

  /** Set the inspected express section id (or null to deselect). */
  inspectSection(sectionId: string | null): void {
    set({ inspectedSectionId: sectionId });
  },
};

/** Get the current Scenario C state snapshot (alias for storeC.getSnapshot()). */
export function storeCSnapshot(): StateC {
  return storeC.getSnapshot();
}
