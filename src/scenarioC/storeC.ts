/*---------------------------------------------------------------------------------------------
 * Scenario C — Dynamic Tolling store slice.
 *
 * Lightweight useSyncExternalStore-compatible store (same pattern as src/scenarioA/store.ts).
 * Holds: timeBlock, strategy, per-section overrides, computed priced sections, KPIs, safety flags.
 * All mutations recompute corridor pricing via computeCorridorPricing() so derived state
 * (pricedSections, kpi, safety flags) is always in sync with the latest inputs.
 *
 * M5 additions: traffic-feed CSV data source (sourceC, sourceErrorC, tableC, trafficTable).
 * The trafficTable overrides the V2X stub when set; loadDefaultTraffic() restores the stub.
 *
 * Imported in tests (node env) so this file MUST NOT import any React or DOM APIs.
 *--------------------------------------------------------------------------------------------*/
import { computeCorridorPricing } from "./pricing";
import type { TimeBlock, PricingStrategy, SectionPricingResult, CorridorPricingResult, TrafficState } from "./types";
import type { TableData } from "../scenarioA/store";

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
  // ---- M5: Bring-your-own traffic data ----
  /** Active traffic-feed data source id ("default" = built-in V2X stub). */
  sourceC: string;
  /** Inline error from the last CSV parse/upload, or null when healthy. */
  sourceErrorC: string | null;
  /** Table rows/columns for the currently active traffic dataset. */
  tableC: TableData;
  /**
   * Custom traffic table from a CSV upload / sample source.
   * When set, computeCorridorPricing uses these values instead of the V2X stub.
   * null means: use the built-in V2X stub (default).
   */
  trafficTable: Record<string, Record<string, TrafficState>> | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function recompute(
  timeBlock: TimeBlock,
  strategy: PricingStrategy,
  overrides: Partial<Record<string, number>>,
  trafficTable?: Record<string, Record<string, TrafficState>> | null
): Pick<StateC, "pricedSections" | "kpi"> {
  const result: CorridorPricingResult = computeCorridorPricing(
    timeBlock,
    strategy,
    overrides as Partial<Record<string, number>>,
    trafficTable
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

const EMPTY_TABLE_C: TableData = { columns: [], rows: [] };

function buildInitial(): StateC {
  const { pricedSections, kpi } = recompute(DEFAULT_TIME_BLOCK, DEFAULT_STRATEGY, DEFAULT_OVERRIDES, null);
  return {
    timeBlock: DEFAULT_TIME_BLOCK,
    strategy: DEFAULT_STRATEGY,
    colorMode: "los",
    overrides: { ...DEFAULT_OVERRIDES },
    pricedSections,
    kpi,
    inspectedSectionId: null,
    sourceC: "default",
    sourceErrorC: null,
    tableC: EMPTY_TABLE_C,
    trafficTable: null,
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
  const computed = recompute(next.timeBlock, next.strategy, next.overrides, state.trafficTable);
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

  // ---- M5: Traffic-feed CSV data source ----

  /**
   * Load a custom traffic table (from a CSV upload or sample source) into the store.
   * Immediately recomputes the corridor pricing with the new traffic state.
   *
   * @param trafficTable  sectionId → timeBlock → TrafficState lookup (from parseTrafficCsv)
   * @param sourceId      Source id to track in state.sourceC
   * @param table         Table rows/columns to populate the Data panel
   */
  loadTrafficTable(
    trafficTable: Record<string, Record<string, TrafficState>>,
    sourceId: string,
    table: TableData
  ): void {
    const computed = recompute(state.timeBlock, state.strategy, state.overrides, trafficTable);
    set({ trafficTable, sourceC: sourceId, tableC: table, sourceErrorC: null, ...computed });
  },

  /**
   * Reset to the built-in V2X synthetic feed (sourceC = "default").
   * Immediately recomputes with the stub values.
   *
   * @param table  Table rows for the default dataset (generated from the V2X stub values)
   */
  loadDefaultTrafficTable(table: TableData): void {
    const computed = recompute(state.timeBlock, state.strategy, state.overrides, null);
    set({ trafficTable: null, sourceC: "default", tableC: table, sourceErrorC: null, ...computed });
  },

  /** Record a data-source error (shown as an inline banner; previous state is unchanged). */
  setSourceErrorC(message: string | null): void {
    set({ sourceErrorC: message });
  },
};

/** Get the current Scenario C state snapshot (alias for storeC.getSnapshot()). */
export function storeCSnapshot(): StateC {
  return storeC.getSnapshot();
}
