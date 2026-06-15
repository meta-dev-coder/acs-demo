/*---------------------------------------------------------------------------------------------
 * Scenario C — Store slice tests (TDD, written before implementation).
 *
 * Covers: strategy toggle recomputes pricing, slider override changes rate + sheds demand,
 * safety-flag count, time-block changes recompute, setters for KPI + override round-trip.
 *--------------------------------------------------------------------------------------------*/
import { describe, it, expect, beforeEach } from "vitest";
import {
  storeCSnapshot,
  storeC,
  INITIAL_STATE_C,
} from "../src/scenarioC/storeC";
import type { TimeBlock, PricingStrategy } from "../src/scenarioC/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get a fresh snapshot after every test (store is module-level singleton). */
function snap() {
  return storeCSnapshot();
}

beforeEach(() => {
  // Reset to initial state before each test so tests are independent.
  storeC.reset();
});

// ---------------------------------------------------------------------------
// § Initial state
// ---------------------------------------------------------------------------
describe("storeC initial state", () => {
  it("defaults to morning_peak_eb time block", () => {
    expect(snap().timeBlock).toBe("morning_peak_eb");
  });

  it("defaults to moderate_variable strategy", () => {
    expect(snap().strategy).toBe("moderate_variable");
  });

  it("defaults to LOS color mode", () => {
    expect(snap().colorMode).toBe("los");
  });

  it("defaults to no per-section overrides", () => {
    expect(Object.keys(snap().overrides)).toHaveLength(0);
  });

  it("computes corridor pricing on init (pricedSections is non-empty)", () => {
    const s = snap();
    expect(s.pricedSections).toHaveLength(3);
    expect(s.pricedSections[0]).toBeDefined();
    expect(typeof s.pricedSections[0].postedRate).toBe("number");
  });

  it("computes KPIs on init", () => {
    const s = snap();
    expect(typeof s.kpi.speedHeld).toBe("boolean");
    expect(typeof s.kpi.projectedRevenuePerHour).toBe("number");
    expect(typeof s.kpi.corridorUtilization).toBe("number");
    expect(typeof s.kpi.safetyFlagCount).toBe("number");
    expect(typeof s.kpi.corridorTotalRate).toBe("number");
  });

  it("no section is inspected by default", () => {
    expect(snap().inspectedSectionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// § setTimeBlock — recomputes pricing
// ---------------------------------------------------------------------------
describe("storeC.setTimeBlock", () => {
  it("changes the time block", () => {
    storeC.setTimeBlock("evening_peak_wb");
    expect(snap().timeBlock).toBe("evening_peak_wb");
  });

  it("recomputes pricedSections after time block change", () => {
    const before = snap().pricedSections.map((s) => s.postedRate);
    storeC.setTimeBlock("off_peak");
    const after = snap().pricedSections.map((s) => s.postedRate);
    // Off-peak traffic is lighter → rates should differ from morning peak
    const anyDiff = before.some((r, i) => Math.abs(r - after[i]) > 0.001);
    expect(anyDiff).toBe(true);
  });

  it("clears overrides when time block changes", () => {
    storeC.setOverride("EXP-E", 5.00);
    expect(snap().overrides["EXP-E"]).toBe(5.00);
    storeC.setTimeBlock("evening_peak_wb");
    expect(snap().overrides["EXP-E"]).toBeUndefined();
  });

  it("all 4 time blocks are accepted", () => {
    const blocks: TimeBlock[] = ["morning_peak_eb", "evening_peak_wb", "off_peak", "weekend"];
    for (const b of blocks) {
      storeC.setTimeBlock(b);
      expect(snap().timeBlock).toBe(b);
      expect(snap().pricedSections).toHaveLength(3);
    }
  });
});

// ---------------------------------------------------------------------------
// § setStrategy — recomputes pricing and shifts KPIs
// ---------------------------------------------------------------------------
describe("storeC.setStrategy", () => {
  it("changes the strategy", () => {
    storeC.setStrategy("aggressive");
    expect(snap().strategy).toBe("aggressive");
  });

  it("recomputes pricedSections when strategy toggles", () => {
    storeC.setTimeBlock("morning_peak_eb");
    const moderate = snap().pricedSections.map((s) => s.postedRate);
    storeC.setStrategy("aggressive");
    const aggressive = snap().pricedSections.map((s) => s.postedRate);
    // At least one section should differ (aggressive uses a higher multiplier)
    const anyDiff = moderate.some((r, i) => Math.abs(r - aggressive[i]) > 0.001);
    expect(anyDiff).toBe(true);
  });

  it("aggressive produces higher or equal corridorTotalRate than moderate_variable", () => {
    storeC.setTimeBlock("morning_peak_eb");
    storeC.setStrategy("moderate_variable");
    const modTotal = snap().kpi.corridorTotalRate;
    storeC.setStrategy("aggressive");
    const aggTotal = snap().kpi.corridorTotalRate;
    expect(aggTotal).toBeGreaterThanOrEqual(modTotal - 0.001);
  });

  it("current_static produces the same rate across density changes", () => {
    storeC.setStrategy("current_static");
    const ratesA = snap().pricedSections.map((s) => s.postedRate);
    storeC.setTimeBlock("evening_peak_wb");
    const ratesB = snap().pricedSections.map((s) => s.postedRate);
    // current_static ignores LOS table — all section rates should be identical across
    // time blocks (same flat base rate)
    for (let i = 0; i < ratesA.length; i++) {
      expect(ratesA[i]).toBeCloseTo(ratesB[i], 2);
    }
  });

  it("all 3 strategies are accepted", () => {
    const strategies: PricingStrategy[] = ["current_static", "moderate_variable", "aggressive"];
    for (const strategy of strategies) {
      storeC.setStrategy(strategy);
      expect(snap().strategy).toBe(strategy);
      expect(snap().pricedSections).toHaveLength(3);
    }
  });
});

// ---------------------------------------------------------------------------
// § setOverride — per-section slider changes rate + sheds demand
// ---------------------------------------------------------------------------
describe("storeC.setOverride (per-section slider $0.50–$10.00)", () => {
  beforeEach(() => {
    storeC.setTimeBlock("morning_peak_eb");
    storeC.setStrategy("moderate_variable");
  });

  it("stores the override value for the given section", () => {
    storeC.setOverride("EXP-E", 5.00);
    expect(snap().overrides["EXP-E"]).toBe(5.00);
  });

  it("overridden section uses the override rate (not algorithm rate)", () => {
    storeC.setOverride("EXP-E", 5.00);
    const section = snap().pricedSections.find((s) => s.sectionId === "EXP-E");
    expect(section).toBeDefined();
    expect(section!.postedRate).toBeCloseTo(5.00, 2);
  });

  it("overriding a section above $3.00 still computes valid shed + revenue", () => {
    storeC.setOverride("EXP-E", 5.00);
    const section = snap().pricedSections.find((s) => s.sectionId === "EXP-E");
    expect(section!.shedVehicles).toBeGreaterThan(0); // at $5 more demand is shed
    expect(section!.revenuePerHour).toBeGreaterThan(0);
  });

  it("override at $10 sheds more demand than at $0.50", () => {
    storeC.setOverride("EXP-E", 0.50);
    const lowShed = snap().pricedSections.find((s) => s.sectionId === "EXP-E")!.shedVehicles;

    storeC.setOverride("EXP-E", 10.00);
    const highShed = snap().pricedSections.find((s) => s.sectionId === "EXP-E")!.shedVehicles;

    expect(highShed).toBeGreaterThan(lowShed);
  });

  it("override does not affect non-overridden sections", () => {
    const before = snap().pricedSections.find((s) => s.sectionId === "EXP-W")!.postedRate;
    storeC.setOverride("EXP-E", 5.00);
    const after = snap().pricedSections.find((s) => s.sectionId === "EXP-W")!.postedRate;
    expect(after).toBeCloseTo(before, 4);
  });

  it("clearOverride removes the override and restores algorithm rate", () => {
    const algorithmRate = snap().pricedSections.find((s) => s.sectionId === "EXP-E")!.postedRate;
    storeC.setOverride("EXP-E", 8.00);
    const overriddenRate = snap().pricedSections.find((s) => s.sectionId === "EXP-E")!.postedRate;
    expect(overriddenRate).toBeCloseTo(8.00, 2);

    storeC.clearOverride("EXP-E");
    const restoredRate = snap().pricedSections.find((s) => s.sectionId === "EXP-E")!.postedRate;
    expect(restoredRate).toBeCloseTo(algorithmRate, 2);
  });

  it("clamps override to $0.50 floor", () => {
    storeC.setOverride("EXP-E", 0.10); // below the $0.50 floor
    const section = snap().pricedSections.find((s) => s.sectionId === "EXP-E");
    expect(section!.postedRate).toBeGreaterThanOrEqual(0.50);
  });

  it("clamps override to $10.00 ceiling", () => {
    storeC.setOverride("EXP-E", 15.00); // above the $10.00 ceiling
    const section = snap().pricedSections.find((s) => s.sectionId === "EXP-E");
    expect(section!.postedRate).toBeLessThanOrEqual(10.00);
  });
});

// ---------------------------------------------------------------------------
// § Safety-flag count
// ---------------------------------------------------------------------------
describe("storeC safety flag count", () => {
  it("safety flag count is a non-negative integer", () => {
    const count = snap().kpi.safetyFlagCount;
    expect(count).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(count)).toBe(true);
  });

  it("pushing EXP-E rate to $10 triggers at least one safety flag", () => {
    // EXP-E at $10 should shed enough demand to push SEG-MN-E above 95%
    storeC.setTimeBlock("morning_peak_eb");
    storeC.setOverride("EXP-E", 10.00);
    const count = snap().kpi.safetyFlagCount;
    expect(count).toBeGreaterThan(0);
  });

  it("safetyFlagCount matches sections where safetyFlag is true", () => {
    storeC.setOverride("EXP-E", 10.00);
    const s = snap();
    const flagged = s.pricedSections.filter((sec) => sec.safetyFlag).length;
    expect(s.kpi.safetyFlagCount).toBe(flagged);
  });

  it("low rate / off-peak should have 0 or fewer safety flags than high rate", () => {
    storeC.setTimeBlock("off_peak");
    storeC.setStrategy("current_static");
    const lowFlags = snap().kpi.safetyFlagCount;

    storeC.setTimeBlock("morning_peak_eb");
    storeC.setStrategy("aggressive");
    storeC.setOverride("EXP-E", 10.00);
    const highFlags = snap().kpi.safetyFlagCount;

    expect(highFlags).toBeGreaterThanOrEqual(lowFlags);
  });
});

// ---------------------------------------------------------------------------
// § KPI aggregation correctness
// ---------------------------------------------------------------------------
describe("storeC KPI aggregation", () => {
  it("corridorTotalRate = sum of all section postedRates", () => {
    const s = snap();
    const sum = s.pricedSections.reduce((t, sec) => t + sec.postedRate, 0);
    expect(s.kpi.corridorTotalRate).toBeCloseTo(sum, 3);
  });

  it("projectedRevenuePerHour = sum of section revenues", () => {
    const s = snap();
    const sum = s.pricedSections.reduce((t, sec) => t + sec.revenuePerHour, 0);
    expect(s.kpi.projectedRevenuePerHour).toBeCloseTo(sum, 1);
  });

  it("corridorUtilization is between 0 and 2 (realistic range for a priced facility)", () => {
    const util = snap().kpi.corridorUtilization;
    expect(util).toBeGreaterThanOrEqual(0);
    expect(util).toBeLessThan(2.0);
  });

  it("speedHeld is true when all sections speed >= 45 mph", () => {
    const s = snap();
    const allFast = s.pricedSections.every((sec) => sec.speed >= 45);
    expect(s.kpi.speedHeld).toBe(allFast);
  });
});

// ---------------------------------------------------------------------------
// § inspectSection setter
// ---------------------------------------------------------------------------
describe("storeC.inspectSection", () => {
  it("sets inspectedSectionId", () => {
    storeC.inspectSection("EXP-E");
    expect(snap().inspectedSectionId).toBe("EXP-E");
  });

  it("clears inspectedSectionId when null is passed", () => {
    storeC.inspectSection("EXP-E");
    storeC.inspectSection(null);
    expect(snap().inspectedSectionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// § setColorMode
// ---------------------------------------------------------------------------
describe("storeC.setColorMode", () => {
  it("accepts 'los' and 'rate' modes", () => {
    storeC.setColorMode("los");
    expect(snap().colorMode).toBe("los");

    storeC.setColorMode("rate");
    expect(snap().colorMode).toBe("rate");
  });
});

// ---------------------------------------------------------------------------
// § Recompute on INITIAL_STATE_C export
// ---------------------------------------------------------------------------
describe("INITIAL_STATE_C exported shape", () => {
  it("has the required keys", () => {
    expect(INITIAL_STATE_C.timeBlock).toBeDefined();
    expect(INITIAL_STATE_C.strategy).toBeDefined();
    expect(INITIAL_STATE_C.colorMode).toBeDefined();
    expect(INITIAL_STATE_C.overrides).toBeDefined();
    expect(INITIAL_STATE_C.pricedSections).toBeDefined();
    expect(INITIAL_STATE_C.kpi).toBeDefined();
    expect(INITIAL_STATE_C.inspectedSectionId).toBeNull();
  });
});
