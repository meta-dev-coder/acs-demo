/*---------------------------------------------------------------------------------------------
 * Scenario registry — additive config that drives the Shell tab switcher and panel routing.
 *
 * Adding a new scenario (C, D, …) is ONLY an addition here and in the Shell's
 * import list — no binary ternaries to touch in Shell.tsx. A/B behavior is unchanged.
 *
 * Imported in tests (node env) so this file MUST NOT import any React or DOM APIs.
 *--------------------------------------------------------------------------------------------*/

export type ScenarioKey = "A" | "B" | "C" | "D";

export const ALL_SCENARIOS: ScenarioKey[] = ["A", "B", "C", "D"];

export interface ScenarioRegistryEntry {
  /** Label shown on the tab button in the top bar. */
  tabLabel: string;
  /** Rail label shown when the left panel is collapsed. */
  leftRailLabel: string;
  /** Placeholder text shown in the left list when there is no content yet. */
  leftEmptyText: string;
  /** Placeholder text shown in the inspector panel when nothing is selected. */
  inspectorEmptyText: string;
}

/** Registry: keyed by ScenarioKey, one entry per scenario. */
export const SCENARIO_REGISTRY: Record<ScenarioKey, ScenarioRegistryEntry> = {
  A: {
    tabLabel: "Asset Reliability",
    leftRailLabel: "ASSETS",
    leftEmptyText: "Search assets…",
    inspectorEmptyText:
      "Select an ITS asset — on the model or in the list — to see its failure risk, drivers, and recommended action.",
  },
  B: {
    tabLabel: "Safety Hotspots",
    leftRailLabel: "SEGMENTS",
    leftEmptyText: "Search segments…",
    inspectorEmptyText:
      "Select a corridor segment to see its incident profile and test a countermeasure.",
  },
  C: {
    tabLabel: "Dynamic Tolling",
    leftRailLabel: "EXPRESS SECTIONS",
    leftEmptyText: "Search express sections…",
    inspectorEmptyText:
      "Select an express section to see its LOS, posted rate, density, and override controls.",
  },
  D: {
    tabLabel: "Lane Closure",
    leftRailLabel: "CLOSURE",
    leftEmptyText: "Configure closure event…",
    inspectorEmptyText:
      "Build a closure event — select segment, lanes, time of day, and weather — then click Simulate to see queue buildup, shockwave, LOS impact, and toll response.",
  },
};
