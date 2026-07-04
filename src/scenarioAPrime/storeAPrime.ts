/*---------------------------------------------------------------------------------------------
 * Scenario A′ (Asset Reliability — DataConnect) store slice.
 *
 * Lightweight useSyncExternalStore-compatible singleton (same pattern as scenarioC/storeC.ts and
 * scenarioD/storeD.ts). Scenario A′ gets its OWN store — separate from scenarioA/store.ts's
 * shared A+B store — because A′'s dataset is fetched over the network with a three-tier fallback
 * (dataSource.ts) rather than the built-in JSON / shipped-CSV sources Scenario A already handles.
 *
 * Imported in tests (node env) so this file MUST NOT import any React or DOM APIs.
 *--------------------------------------------------------------------------------------------*/
import type { Point3d } from "@itwin/core-geometry";
import type { DcTier } from "./dataSource";
import type { ScoredAssetPrime } from "./types";

export type SourceTierPrime = DcTier | "none";

/** How A′'s pins were placed on the model: "gcs" — DataConnect's native WGS84 lon/lat converted
 *  to spatial via the iModel's GCS/ecefLocation (scene/geo.ts's wgs84ToSpatial), snapped to the
 *  nearest road element (the expected path — the export carries real-world coordinates); "road"/
 *  "extents"/"pending" mirror Scenario A's fallback ladder for when the model isn't geolocated. */
export type PlacementModePrime = "gcs" | "road" | "extents" | "pending";

export interface BandCounts {
  red: number;
  amber: number;
  green: number;
}

export interface StateAPrime {
  /** Scored assets from the last successful load (empty until the first load completes). */
  assets: ScoredAssetPrime[];
  /** Which tier last supplied `assets`: "live" (DataConnect API), "snapshot" (deployed
   *  twin/dataconnect-data), "local" (dev-root dataconnect-data), or "none" before any load. */
  tier: SourceTierPrime;
  /** True while a load is in flight. */
  loading: boolean;
  /** Inline error from the last failed load, or null when healthy. Previous `assets`/`tier` are
   *  left untouched on failure (keep-previous-on-failure, matching src/data/loader.ts). */
  sourceError: string | null;
  /** Currently inspected asset tag, or null. */
  inspectedTag: string | null;
  /** Red/amber/green counts over `assets`, recomputed on every successful load. */
  bandCounts: BandCounts;
  /** World (spatial) location of each placed pin, keyed by asset_tag — set by
   *  scenarioAPrime/manager.ts after scene placement (empty until the first placement runs). */
  worldByTag: Map<string, Point3d>;
  /** How `worldByTag` was computed (see PlacementModePrime). */
  placementMode: PlacementModePrime;
}

function countBands(assets: ScoredAssetPrime[]): BandCounts {
  const counts: BandCounts = { red: 0, amber: 0, green: 0 };
  for (const a of assets) {
    if (a.band === "red" || a.band === "amber" || a.band === "green") counts[a.band]++;
  }
  return counts;
}

function buildInitial(): StateAPrime {
  return {
    assets: [],
    tier: "none",
    loading: false,
    sourceError: null,
    inspectedTag: null,
    bandCounts: { red: 0, amber: 0, green: 0 },
    worldByTag: new Map(),
    placementMode: "pending",
  };
}

export const INITIAL_STATE_A_PRIME: StateAPrime = buildInitial();

let state: StateAPrime = buildInitial();
const listeners = new Set<() => void>();

function set(patch: Partial<StateAPrime>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export const storeAPrime = {
  getSnapshot: (): StateAPrime => state,

  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },

  /** Reset to initial state (used in tests). */
  reset(): void {
    state = buildInitial();
    listeners.forEach((l) => l());
  },

  setLoading(loading: boolean): void {
    set({ loading });
  },

  /** Replace the dataset with a freshly-fetched, freshly-scored set. Clears any previous error. */
  loadAssets(assets: ScoredAssetPrime[], tier: DcTier): void {
    set({
      assets,
      tier,
      loading: false,
      sourceError: null,
      inspectedTag: null,
      bandCounts: countBands(assets),
    });
  },

  /** Record a load failure. Keeps the previous assets/tier untouched (keep-previous-on-failure) —
   *  only the error banner and loading flag change. */
  setSourceError(message: string | null): void {
    set({ sourceError: message, loading: false });
  },

  inspect(tag: string | null): void {
    set({ inspectedTag: tag });
  },

  /** Publish freshly-placed pin locations (scenarioAPrime/manager.ts, after scene placement). */
  setWorldLocations(worldByTag: Map<string, Point3d>, placementMode: PlacementModePrime): void {
    set({ worldByTag, placementMode });
  },
};

export function storeAPrimeSnapshot(): StateAPrime {
  return storeAPrime.getSnapshot();
}
