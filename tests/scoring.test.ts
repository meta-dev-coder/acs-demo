/*---------------------------------------------------------------------------------------------
 * Risk-scoring unit tests — Scenario A (asset failure) + Scenario B (safety) + work package.
 * Pure functions over the demo's synthetic data; guards the numbers the demo shows.
 *--------------------------------------------------------------------------------------------*/
import { describe, it, expect } from "vitest";
import { scoreAssets, bandFor } from "../src/scenarioA/scoring";
import { computeWorkPackage } from "../src/scenarioA/workPackage";
import { scoreSegments, computeDelta } from "../src/scenarioB/safetyScoring";
import assetsData from "../src/scenarioA/data/assets.json";
import historyData from "../src/scenarioA/data/history.json";
import segData from "../src/scenarioB/data/segments.json";
import incData from "../src/scenarioB/data/segmentIncidents.json";
import type { RawAsset, HistoryRecord } from "../src/scenarioA/types";
import type { RawSegment, SegIncident } from "../src/scenarioB/types";

const assets = scoreAssets(
  assetsData.assets as unknown as RawAsset[],
  historyData.records as unknown as HistoryRecord[]
);
const segs = scoreSegments(
  segData.segments as unknown as RawSegment[],
  incData.incidents as unknown as SegIncident[]
);

describe("Scenario A — asset failure scoring", () => {
  it("scores every asset with a valid band in [0,1], sorted worst-first", () => {
    expect(assets.length).toBe(assetsData.assets.length);
    for (const a of assets) {
      expect(a.score).toBeGreaterThanOrEqual(0);
      expect(a.score).toBeLessThanOrEqual(1);
      expect(["red", "amber", "green"]).toContain(a.band);
      expect(a.band).toBe(bandFor(a.score));
    }
    for (let i = 1; i < assets.length; i++)
      expect(assets[i - 1].score).toBeGreaterThanOrEqual(assets[i].score);
  });

  it("has act-now (red) assets and the worst-ranked asset is red", () => {
    expect(assets.filter((a) => a.band === "red").length).toBeGreaterThanOrEqual(1);
    expect(assets[0].band).toBe("red");
  });

  it("red assets expose risk drivers and a recommended action", () => {
    for (const a of assets.filter((a) => a.band === "red")) {
      expect(a.drivers.length).toBeGreaterThan(0);
      expect(a.recommendedAction).toBeTruthy();
    }
  });
});

describe("Scenario A — proactive work package", () => {
  it("bundling N at-risk assets avoids N-1 closures and never invents negative savings", () => {
    const reds = assets.filter((a) => a.band === "red");
    const wp = computeWorkPackage(reds);
    expect(wp.count).toBe(reds.length);
    expect(wp.closuresAvoided).toBe(Math.max(0, reds.length - 1));
    expect(wp.revenueProtected).toBeGreaterThanOrEqual(0);
    expect(wp.crewHoursSaved).toBeGreaterThanOrEqual(0);
  });
});

describe("Scenario B — safety hotspot scoring", () => {
  it("scores every segment with a valid band in [0,1], sorted worst-first", () => {
    expect(segs.length).toBe(segData.segments.length);
    for (const s of segs) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
      expect(["red", "amber", "green"]).toContain(s.band);
    }
    for (let i = 1; i < segs.length; i++)
      expect(segs[i - 1].score).toBeGreaterThanOrEqual(segs[i].score);
  });

  it("the Express<->Turnpike connector is the worst hotspot and is red", () => {
    expect(segs[0].segment_id).toBe("SEG-CONN");
    expect(segs[0].band).toBe("red");
  });

  it("a countermeasure lowers the score and never claims savings beyond the incidents", () => {
    const worst = segs[0];
    expect(worst.recommended).toBeTruthy();
    const d = computeDelta(worst, worst.recommended!);
    expect(d.afterScore).toBeLessThanOrEqual(worst.score);
    expect(d.crashesAvoided).toBeGreaterThanOrEqual(0);
    expect(d.crashesAvoided).toBeLessThanOrEqual(worst.incidents.length);
    expect(d.revenueProtected).toBeGreaterThanOrEqual(0);
    expect(["red", "amber", "green"]).toContain(d.afterBand);
  });
});
