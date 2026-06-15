/*---------------------------------------------------------------------------------------------
 * Tiny external store for Scenario A + B UI state (no extra deps; React via useSyncExternalStore).
 *--------------------------------------------------------------------------------------------*/
import { useSyncExternalStore } from "react";
import { Point3d } from "@itwin/core-geometry";
import type { ScoredAsset } from "./types";
import type { ScoredSegment } from "../scenarioB/types";

export type Scenario = "A" | "B";

/** Parsed CSV (or built-in) rows backing the active dataset, for the "Data" table view. */
export interface TableData {
  columns: string[];
  rows: Record<string, string>[];
}

export interface ScenarioState {
  scenario: Scenario;
  // Scenario A — ITS asset reliability
  assets: ScoredAsset[];
  worldByTag: Map<string, Point3d>;
  inspectedTag: string | null;
  packageTags: string[];
  packageOpen: boolean;
  placementMode: "gcs" | "extents" | "road" | "pending";
  // Scenario B — safety hotspots
  segments: ScoredSegment[];
  segmentMidById: Map<string, Point3d>;
  inspectedSegmentId: string | null;
  treatedSegmentIds: string[];
  // ---- Bring-your-own-data (per scenario) ----
  /** Active data-source id per scenario ("default" = built-in JSON, shown as today). */
  sourceA: string;
  sourceB: string;
  /** Table rows/columns for the currently active dataset of each scenario. */
  tableA: TableData;
  tableB: TableData;
  /** Inline error from the last CSV parse/upload (per scenario), or null when healthy. */
  sourceErrorA: string | null;
  sourceErrorB: string | null;
}

let state: ScenarioState = {
  scenario: "A",
  assets: [],
  worldByTag: new Map(),
  inspectedTag: null,
  packageTags: [],
  packageOpen: false,
  placementMode: "pending",
  segments: [],
  segmentMidById: new Map(),
  inspectedSegmentId: null,
  treatedSegmentIds: [],
  sourceA: "default",
  sourceB: "default",
  tableA: { columns: [], rows: [] },
  tableB: { columns: [], rows: [] },
  sourceErrorA: null,
  sourceErrorB: null,
};

const listeners = new Set<() => void>();
function set(patch: Partial<ScenarioState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

/* The scene wires a re-placement callback here on first viewport configure, so swapping the
 * active dataset re-runs the existing placement pipeline (markers/ribbons re-placed on the
 * corridor) and re-frames. Decoupled so the store stays free of iTwin imports + DOM. */
let reDecorate: ((scenario: Scenario) => void) | null = null;
export function registerReDecorate(fn: (scenario: Scenario) => void): void {
  reDecorate = fn;
}

export const store = {
  getSnapshot: () => state,
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },

  setScenario(scenario: Scenario) {
    set({
      scenario,
      inspectedTag: null,
      packageOpen: false,
      inspectedSegmentId: null,
    });
  },

  // ---- Bring-your-own-data ----
  /** Replace Scenario A's dataset with a freshly-scored set, set the table + source id, then
   *  re-run placement/decoration so the viewer, list, and KPI bar all update together. */
  loadAssets(args: {
    assets: ScoredAsset[];
    sourceId: string;
    table: TableData;
  }) {
    set({
      assets: args.assets,
      sourceA: args.sourceId,
      tableA: args.table,
      sourceErrorA: null,
      inspectedTag: null,
      packageTags: [],
      packageOpen: false,
    });
    reDecorate?.("A");
  },
  /** Replace Scenario B's dataset (segments already scored) + table + source id, then re-place. */
  loadSegments(args: {
    segments: ScoredSegment[];
    sourceId: string;
    table: TableData;
  }) {
    set({
      segments: args.segments,
      sourceB: args.sourceId,
      tableB: args.table,
      sourceErrorB: null,
      inspectedSegmentId: null,
      treatedSegmentIds: [],
    });
    reDecorate?.("B");
  },
  setSourceError(scenario: Scenario, message: string | null) {
    set(scenario === "A" ? { sourceErrorA: message } : { sourceErrorB: message });
  },
  /** Publish a table view without re-scoring (used by the built-in default load path). */
  setTable(scenario: Scenario, table: TableData) {
    set(scenario === "A" ? { tableA: table } : { tableB: table });
  },

  // ---- Scenario A ----
  setAssets(assets: ScoredAsset[]) {
    set({ assets });
  },
  setWorldLocations(worldByTag: Map<string, Point3d>, placementMode: ScenarioState["placementMode"]) {
    set({ worldByTag, placementMode });
  },
  inspect(tag: string | null) {
    set({ inspectedTag: tag });
  },
  togglePackage(tag: string) {
    const has = state.packageTags.includes(tag);
    set({
      packageTags: has
        ? state.packageTags.filter((t) => t !== tag)
        : [...state.packageTags, tag],
    });
  },
  openPackage() {
    if (state.packageTags.length > 0) set({ packageOpen: true });
  },
  closePackage() {
    set({ packageOpen: false });
  },
  clearPackage() {
    set({ packageTags: [], packageOpen: false });
  },

  // ---- Scenario B ----
  setSegments(segments: ScoredSegment[]) {
    set({ segments });
  },
  setSegmentMids(segmentMidById: Map<string, Point3d>) {
    set({ segmentMidById });
  },
  inspectSegment(id: string | null) {
    set({ inspectedSegmentId: id });
  },
  toggleTreated(id: string) {
    const has = state.treatedSegmentIds.includes(id);
    set({
      treatedSegmentIds: has
        ? state.treatedSegmentIds.filter((t) => t !== id)
        : [...state.treatedSegmentIds, id],
    });
  },
  isTreated(id: string) {
    return state.treatedSegmentIds.includes(id);
  },
};

export function useScenarioState(): ScenarioState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
