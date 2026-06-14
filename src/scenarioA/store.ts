/*---------------------------------------------------------------------------------------------
 * Tiny external store for Scenario A + B UI state (no extra deps; React via useSyncExternalStore).
 *--------------------------------------------------------------------------------------------*/
import { useSyncExternalStore } from "react";
import { Point3d } from "@itwin/core-geometry";
import type { ScoredAsset } from "./types";
import type { ScoredSegment } from "../scenarioB/types";

export type Scenario = "A" | "B";

export interface ScenarioState {
  scenario: Scenario;
  // Scenario A — ITS asset reliability
  assets: ScoredAsset[];
  worldByTag: Map<string, Point3d>;
  inspectedTag: string | null;
  packageTags: string[];
  packageOpen: boolean;
  placementMode: "gcs" | "extents" | "pending";
  // Scenario B — safety hotspots
  segments: ScoredSegment[];
  segmentMidById: Map<string, Point3d>;
  inspectedSegmentId: string | null;
  treatedSegmentIds: string[];
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
};

const listeners = new Set<() => void>();
function set(patch: Partial<ScenarioState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
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
