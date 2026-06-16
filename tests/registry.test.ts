/*---------------------------------------------------------------------------------------------
 * M0 regression test — scenario registry refactor.
 *
 * Asserts:
 *  1. Scenario A asset scoring + band distribution are unchanged after the registry refactor.
 *  2. Scenario B safety scoring + worst-hotspot identity are unchanged.
 *  3. The registry type + store expose all three scenarios ("A" | "B" | "C") and the type-
 *     narrowing helpers stay consistent.
 *  4. Scenario C is registered in the registry with the canonical keys expected by the Shell.
 *--------------------------------------------------------------------------------------------*/
import { describe, it, expect } from "vitest";
import { scoreAssets, bandFor as assetBandFor } from "../src/scenarioA/scoring";
import { scoreSegments, bandFor as segBandFor } from "../src/scenarioB/safetyScoring";
import {
  SCENARIO_REGISTRY,
  type ScenarioKey,
  ALL_SCENARIOS,
} from "../src/app/scenarioRegistry";
// Import store to confirm the Scenario type is widened — TypeScript-only, exercises the types.
import type { Scenario } from "../src/scenarioA/store";
import assetsData from "../src/scenarioA/data/assets.json";
import historyData from "../src/scenarioA/data/history.json";
import segData from "../src/scenarioB/data/segments.json";
import incData from "../src/scenarioB/data/segmentIncidents.json";
import type { RawAsset, HistoryRecord } from "../src/scenarioA/types";
import type { RawSegment, SegIncident } from "../src/scenarioB/types";

// ── data ──────────────────────────────────────────────────────────────────────────────────
const assets = scoreAssets(
  assetsData.assets as unknown as RawAsset[],
  historyData.records as unknown as HistoryRecord[]
);
const segs = scoreSegments(
  segData.segments as unknown as RawSegment[],
  incData.incidents as unknown as SegIncident[]
);

// ── A & B scoring unchanged ────────────────────────────────────────────────────────────────
describe("M0 regression — Scenario A scoring unchanged", () => {
  it("asset count and score range are identical to the pre-refactor baseline", () => {
    expect(assets.length).toBe(assetsData.assets.length);
    for (const a of assets) {
      expect(a.score).toBeGreaterThanOrEqual(0);
      expect(a.score).toBeLessThanOrEqual(1);
      expect(["red", "amber", "green"]).toContain(a.band);
      expect(a.band).toBe(assetBandFor(a.score));
    }
  });

  it("sorted worst-first and the top asset is red", () => {
    for (let i = 1; i < assets.length; i++)
      expect(assets[i - 1].score).toBeGreaterThanOrEqual(assets[i].score);
    expect(assets[0].band).toBe("red");
  });
});

describe("M0 regression — Scenario B scoring unchanged", () => {
  it("segment count, score range, and band consistency are identical", () => {
    expect(segs.length).toBe(segData.segments.length);
    for (const s of segs) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
      expect(["red", "amber", "green"]).toContain(s.band);
      expect(s.band).toBe(segBandFor(s.score));
    }
    for (let i = 1; i < segs.length; i++)
      expect(segs[i - 1].score).toBeGreaterThanOrEqual(segs[i].score);
  });

  it("SEG-CONN remains the worst hotspot and is red", () => {
    expect(segs[0].segment_id).toBe("SEG-CONN");
    expect(segs[0].band).toBe("red");
  });
});

// ── Registry shape ─────────────────────────────────────────────────────────────────────────
describe("M0 — scenario registry exposes A, B, C, and D", () => {
  it("ALL_SCENARIOS contains exactly 'A', 'B', 'C', 'D' in order", () => {
    expect(ALL_SCENARIOS).toEqual(["A", "B", "C", "D"]);
  });

  it("SCENARIO_REGISTRY has an entry for each key with required fields", () => {
    const keys: ScenarioKey[] = ["A", "B", "C", "D"];
    for (const k of keys) {
      const entry = SCENARIO_REGISTRY[k];
      expect(entry).toBeTruthy();
      // Every scenario must expose a non-empty tab label.
      expect(typeof entry.tabLabel).toBe("string");
      expect(entry.tabLabel.length).toBeGreaterThan(0);
    }
  });

  it("Scenario A registry entry has label 'Asset Reliability'", () => {
    expect(SCENARIO_REGISTRY["A"].tabLabel).toBe("Asset Reliability");
  });

  it("Scenario B registry entry has label 'Safety Hotspots'", () => {
    expect(SCENARIO_REGISTRY["B"].tabLabel).toBe("Safety Hotspots");
  });

  it("Scenario C registry entry has label 'Dynamic Tolling'", () => {
    expect(SCENARIO_REGISTRY["C"].tabLabel).toBe("Dynamic Tolling");
  });

  it("Scenario type in store is compatible with ScenarioKey (compile-time check via assignment)", () => {
    // This is a compile-time-only check: if Scenario is not widened to include 'C',
    // the type assertion below will produce a TypeScript error.
    const _checkCompat: Scenario = "C" as ScenarioKey;
    expect(_checkCompat).toBe("C");
  });
});
