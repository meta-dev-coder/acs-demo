/*---------------------------------------------------------------------------------------------
 * M0 Scenario D — Registry and Types tests.
 *
 * ALL tests in this file go RED before production code is written, GREEN after.
 *
 * §Registry shape  — SCENARIO_REGISTRY["D"], ALL_SCENARIOS, ScenarioKey
 * §Config shape    — closureConfig.json structure and constraints
 * §Types check     — ClosureEvent, StateDKpi compile-time checks
 * §Regression      — A/B/C registry entries unchanged
 *--------------------------------------------------------------------------------------------*/
import { describe, it, expect } from "vitest";
import {
  SCENARIO_REGISTRY,
  type ScenarioKey,
  ALL_SCENARIOS,
} from "../src/app/scenarioRegistry";

// ── §Registry shape ────────────────────────────────────────────────────────────────────────

describe("M0 Scenario D — registry shape", () => {
  it("ALL_SCENARIOS contains 'D' as the fourth entry", () =>
    expect(ALL_SCENARIOS).toEqual(["A", "B", "C", "D"]));

  it("SCENARIO_REGISTRY['D'] has tabLabel 'Lane Closure'", () =>
    expect(SCENARIO_REGISTRY["D"].tabLabel).toBe("Lane Closure"));

  it("SCENARIO_REGISTRY['D'] has leftRailLabel 'CLOSURE'", () =>
    expect(SCENARIO_REGISTRY["D"].leftRailLabel).toBe("CLOSURE"));

  it("SCENARIO_REGISTRY['D'].inspectorEmptyText is non-empty", () =>
    expect(SCENARIO_REGISTRY["D"].inspectorEmptyText.length).toBeGreaterThan(10));

  // TypeScript compile check (vitest will catch type errors)
  it("ScenarioKey type accepts 'D'", () => {
    const _k: ScenarioKey = "D";
    expect(_k).toBe("D");
  });
});

// ── §Regression guards ─────────────────────────────────────────────────────────────────────

describe("M0 Scenario D — registry regression guards (A/B/C unchanged)", () => {
  it("ALL_SCENARIOS[0..2] are A, B, C unchanged", () =>
    expect(ALL_SCENARIOS.slice(0, 3)).toEqual(["A", "B", "C"]));

  it("SCENARIO_REGISTRY['A'].tabLabel === 'Asset Reliability'", () =>
    expect(SCENARIO_REGISTRY["A"].tabLabel).toBe("Asset Reliability"));

  it("SCENARIO_REGISTRY['C'].tabLabel === 'Dynamic Tolling'", () =>
    expect(SCENARIO_REGISTRY["C"].tabLabel).toBe("Dynamic Tolling"));
});

// ── §Type imports ──────────────────────────────────────────────────────────────────────────

describe("M0 Scenario D — type imports compile", () => {
  it("ClosureEvent type import compiles", () => {
    const evt: import("../src/scenarioD/typesD").ClosureEvent = {
      segment_id: "SEG-CONN",
      lanesClosed: 1,
      startMin: 0,
      durationMin: 60,
      timeOfDay: "pm_peak",
    };
    expect(evt.segment_id).toBe("SEG-CONN");
  });

  it("StateDKpi type has distinct delayCostUsd and expressRevenueProtectedUsd keys", () => {
    // Type-level check — if keys are missing the destructure errors at compile time
    const kpi: import("../src/scenarioD/typesD").StateDKpi = {
      maxQueueMi: 0,
      vehHrsDelay: 0,
      clearanceMin: 0,
      currentTollUsd: 0,
      pctDiverted: 0,
      delayCostUsd: 0,
      expressRevenueProtectedUsd: 0,
    };
    expect(kpi.delayCostUsd).toBe(0);
    expect(kpi.expressRevenueProtectedUsd).toBe(0);
  });
});

// ── §Config shape ──────────────────────────────────────────────────────────────────────────

describe("M0 Scenario D — closureConfig.json structure", () => {
  it("closureConfig.json has segments.SEG-CONN.lanes === 2", async () => {
    const cfg = await import("../src/scenarioD/closureConfig.json");
    expect(cfg.segments["SEG-CONN"].lanes).toBe(2);
  });

  it("closureConfig.json cafTable for SEG-CONN has exactly one entry (1-of-2, CAF 0.35)", async () => {
    const cfg = await import("../src/scenarioD/closureConfig.json");
    const connEntries = cfg.cafTable.filter(
      (e: { totalLanes: number }) => e.totalLanes === 2
    );
    expect(connEntries).toHaveLength(1);
    expect(connEntries[0].caf).toBe(0.35);
    // No 1-of-3 or 2-of-3 entry for a 2-lane segment:
    const badEntries = cfg.cafTable.filter(
      (e: { totalLanes: number; lanesClosed: number }) =>
        e.totalLanes === 2 && e.lanesClosed !== 1
    );
    expect(badEntries).toHaveLength(0);
  });

  it("closureConfig.json has weatherFactor 0.85 and NO mergeDerate key", async () => {
    const cfg = await import("../src/scenarioD/closureConfig.json");
    expect(cfg.weatherFactor).toBe(0.85);
    expect((cfg as Record<string, unknown>)["mergeDerate"]).toBeUndefined();
    expect((cfg as Record<string, unknown>)["rubberneckDerate"]).toBeUndefined();
  });

  it("closureConfig.json has queueDischargeFactor 0.93", async () => {
    const cfg = await import("../src/scenarioD/closureConfig.json");
    expect(cfg.queueDischargeFactor).toBe(0.93);
  });

  it("closureConfig.json has diversionThresholdMi 0.75", async () => {
    const cfg = await import("../src/scenarioD/closureConfig.json");
    expect(cfg.diversionThresholdMi).toBe(0.75);
  });

  it("closureConfig.json has diversionShedFraction 0.12", async () => {
    const cfg = await import("../src/scenarioD/closureConfig.json");
    expect(cfg.diversionShedFraction).toBe(0.12);
  });

  it("closureConfig.json has all required segment entries", async () => {
    const cfg = await import("../src/scenarioD/closureConfig.json");
    const expectedIds = ["SEG-CONN", "SEG-MN-W", "SEG-MN-C", "SEG-MN-E", "SEG-EXP-RVS", "SEG-SR84"];
    for (const id of expectedIds) {
      expect(cfg.segments[id], `Missing segment ${id}`).toBeDefined();
    }
  });

  it("closureConfig.json cafTable has 3-lane entries for 1-of-3 and 2-of-3", async () => {
    const cfg = await import("../src/scenarioD/closureConfig.json");
    const threeEntries = cfg.cafTable.filter(
      (e: { totalLanes: number }) => e.totalLanes === 3
    );
    expect(threeEntries).toHaveLength(2);
    const cafs = threeEntries.map((e: { caf: number }) => e.caf).sort();
    expect(cafs).toEqual([0.17, 0.49]);
  });
});
