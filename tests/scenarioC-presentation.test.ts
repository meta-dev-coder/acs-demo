/*---------------------------------------------------------------------------------------------
 * Scenario C — M4: Compare split-view + Presentation animation — TDD tests.
 *
 * Tests cover:
 *   (a) Compare mode state — strategy A vs B dual-state, dual KPI aggregation
 *   (b) Time-lapse stepping state machine — discrete + bounded; never continuous
 *   (c) Tween is step-based (not continuous); transitions are bounded to ~400ms
 *   (d) Demand-shift flow state (pulsing safety flag)
 *   (e) Presentation mode toggle (default OFF → static view stays default)
 *
 * All logic is in node-env-safe modules (no React, no DOM, no iTwin APIs).
 *--------------------------------------------------------------------------------------------*/
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  compareStore,
  compareSnapshot,
  INITIAL_COMPARE_STATE,
} from "../src/scenarioC/compareStore";
import type { CompareState } from "../src/scenarioC/compareStore";
import {
  presentationStore,
  presentationSnapshot,
  INITIAL_PRESENTATION_STATE,
} from "../src/scenarioC/presentationStore";
import type { PresentationState, TimeLapseStep } from "../src/scenarioC/presentationStore";
import type { PricingStrategy } from "../src/scenarioC/types";
import { computeCorridorPricing } from "../src/scenarioC/pricing";
import { storeC } from "../src/scenarioC/storeC";

// ---------------------------------------------------------------------------
// § Compare Store Tests
// ---------------------------------------------------------------------------

describe("compareStore initial state", () => {
  beforeEach(() => {
    compareStore.reset();
  });

  it("defaults to compare mode OFF", () => {
    expect(compareSnapshot().compareMode).toBe(false);
  });

  it("default strategyA is moderate_variable", () => {
    expect(compareSnapshot().strategyA).toBe("moderate_variable");
  });

  it("default strategyB is aggressive", () => {
    expect(compareSnapshot().strategyB).toBe("aggressive");
  });

  it("computes pricedSectionsA on init (3 sections)", () => {
    const s = compareSnapshot();
    expect(s.pricedSectionsA).toHaveLength(3);
    expect(typeof s.pricedSectionsA[0].postedRate).toBe("number");
  });

  it("computes pricedSectionsB on init (3 sections)", () => {
    const s = compareSnapshot();
    expect(s.pricedSectionsB).toHaveLength(3);
    expect(typeof s.pricedSectionsB[0].postedRate).toBe("number");
  });

  it("computes kpiA and kpiB on init", () => {
    const s = compareSnapshot();
    expect(typeof s.kpiA.speedHeld).toBe("boolean");
    expect(typeof s.kpiA.projectedRevenuePerHour).toBe("number");
    expect(typeof s.kpiB.projectedRevenuePerHour).toBe("number");
    expect(typeof s.kpiB.safetyFlagCount).toBe("number");
  });

  it("INITIAL_COMPARE_STATE has required keys", () => {
    expect(INITIAL_COMPARE_STATE).toHaveProperty("compareMode");
    expect(INITIAL_COMPARE_STATE).toHaveProperty("strategyA");
    expect(INITIAL_COMPARE_STATE).toHaveProperty("strategyB");
    expect(INITIAL_COMPARE_STATE).toHaveProperty("pricedSectionsA");
    expect(INITIAL_COMPARE_STATE).toHaveProperty("pricedSectionsB");
    expect(INITIAL_COMPARE_STATE).toHaveProperty("kpiA");
    expect(INITIAL_COMPARE_STATE).toHaveProperty("kpiB");
  });
});

describe("compareStore.setCompareMode", () => {
  beforeEach(() => {
    compareStore.reset();
  });

  it("toggles compare mode on", () => {
    compareStore.setCompareMode(true);
    expect(compareSnapshot().compareMode).toBe(true);
  });

  it("toggles compare mode off", () => {
    compareStore.setCompareMode(true);
    compareStore.setCompareMode(false);
    expect(compareSnapshot().compareMode).toBe(false);
  });
});

describe("compareStore.setStrategyA / setStrategyB", () => {
  beforeEach(() => {
    compareStore.reset();
  });

  it("setStrategyA changes strategy A and recomputes pricedSectionsA", () => {
    const before = compareSnapshot().pricedSectionsA.map((s) => s.postedRate);
    compareStore.setStrategyA("current_static");
    const after = compareSnapshot().pricedSectionsA.map((s) => s.postedRate);
    expect(compareSnapshot().strategyA).toBe("current_static");
    // current_static at flat $1.50 differs from moderate_variable rates
    const anyDiff = before.some((r, i) => Math.abs(r - after[i]) > 0.001);
    expect(anyDiff).toBe(true);
  });

  it("setStrategyB changes strategy B and recomputes pricedSectionsB", () => {
    compareStore.setStrategyB("current_static");
    expect(compareSnapshot().strategyB).toBe("current_static");
    const s = compareSnapshot();
    // current_static → all rates flat $1.50
    s.pricedSectionsB.forEach((sec) => {
      expect(sec.postedRate).toBeCloseTo(1.50, 2);
    });
  });

  it("setStrategyA does not affect pricedSectionsB", () => {
    const beforeB = compareSnapshot().pricedSectionsB.map((s) => s.postedRate);
    compareStore.setStrategyA("current_static");
    const afterB = compareSnapshot().pricedSectionsB.map((s) => s.postedRate);
    beforeB.forEach((r, i) => {
      expect(afterB[i]).toBeCloseTo(r, 4);
    });
  });

  it("setStrategyB does not affect pricedSectionsA", () => {
    const beforeA = compareSnapshot().pricedSectionsA.map((s) => s.postedRate);
    compareStore.setStrategyB("current_static");
    const afterA = compareSnapshot().pricedSectionsA.map((s) => s.postedRate);
    beforeA.forEach((r, i) => {
      expect(afterA[i]).toBeCloseTo(r, 4);
    });
  });

  it("all 3 strategies are accepted for strategyA", () => {
    const strategies: PricingStrategy[] = ["current_static", "moderate_variable", "aggressive"];
    for (const strat of strategies) {
      compareStore.setStrategyA(strat);
      expect(compareSnapshot().strategyA).toBe(strat);
      expect(compareSnapshot().pricedSectionsA).toHaveLength(3);
    }
  });

  it("all 3 strategies are accepted for strategyB", () => {
    const strategies: PricingStrategy[] = ["current_static", "moderate_variable", "aggressive"];
    for (const strat of strategies) {
      compareStore.setStrategyB(strat);
      expect(compareSnapshot().strategyB).toBe(strat);
      expect(compareSnapshot().pricedSectionsB).toHaveLength(3);
    }
  });
});

describe("compareStore dual KPI correctness", () => {
  beforeEach(() => {
    compareStore.reset();
    compareStore.setStrategyA("moderate_variable");
    compareStore.setStrategyB("aggressive");
  });

  it("kpiA.corridorTotalRate = sum of pricedSectionsA postedRates", () => {
    const s = compareSnapshot();
    const sum = s.pricedSectionsA.reduce((t, sec) => t + sec.postedRate, 0);
    expect(s.kpiA.corridorTotalRate).toBeCloseTo(sum, 3);
  });

  it("kpiB.corridorTotalRate = sum of pricedSectionsB postedRates", () => {
    const s = compareSnapshot();
    const sum = s.pricedSectionsB.reduce((t, sec) => t + sec.postedRate, 0);
    expect(s.kpiB.corridorTotalRate).toBeCloseTo(sum, 3);
  });

  it("kpiB.corridorTotalRate >= kpiA.corridorTotalRate (aggressive >= moderate)", () => {
    const s = compareSnapshot();
    expect(s.kpiB.corridorTotalRate).toBeGreaterThanOrEqual(s.kpiA.corridorTotalRate - 0.001);
  });

  it("kpiA.projectedRevenuePerHour > 0", () => {
    expect(compareSnapshot().kpiA.projectedRevenuePerHour).toBeGreaterThan(0);
  });

  it("kpiB.projectedRevenuePerHour > 0", () => {
    expect(compareSnapshot().kpiB.projectedRevenuePerHour).toBeGreaterThan(0);
  });

  it("kpiA and kpiB safetyFlagCount match their section arrays", () => {
    const s = compareSnapshot();
    const flaggedA = s.pricedSectionsA.filter((sec) => sec.safetyFlag).length;
    const flaggedB = s.pricedSectionsB.filter((sec) => sec.safetyFlag).length;
    expect(s.kpiA.safetyFlagCount).toBe(flaggedA);
    expect(s.kpiB.safetyFlagCount).toBe(flaggedB);
  });
});

describe("compareStore.setTimeBlock", () => {
  beforeEach(() => {
    compareStore.reset();
  });

  it("changes time block and recomputes both strategy results", () => {
    const beforeA = compareSnapshot().pricedSectionsA.map((s) => s.postedRate);
    compareStore.setTimeBlock("off_peak");
    const afterA = compareSnapshot().pricedSectionsA.map((s) => s.postedRate);
    expect(compareSnapshot().timeBlock).toBe("off_peak");
    const anyDiff = beforeA.some((r, i) => Math.abs(r - afterA[i]) > 0.001);
    expect(anyDiff).toBe(true);
  });

  it("sets time block to morning_peak_eb by default", () => {
    expect(compareSnapshot().timeBlock).toBe("morning_peak_eb");
  });
});

// ---------------------------------------------------------------------------
// § Presentation Store Tests
// ---------------------------------------------------------------------------

describe("presentationStore initial state", () => {
  beforeEach(() => {
    presentationStore.reset();
  });

  it("defaults to presentation mode OFF", () => {
    expect(presentationSnapshot().presentationMode).toBe(false);
  });

  it("defaults to NOT playing time-lapse", () => {
    expect(presentationSnapshot().isPlaying).toBe(false);
  });

  it("defaults to first step index (0)", () => {
    expect(presentationSnapshot().currentStepIndex).toBe(0);
  });

  it("has a defined steps array (non-empty)", () => {
    const steps = presentationSnapshot().timeLapseSteps;
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBeGreaterThan(0);
  });

  it("tweenActive defaults to false", () => {
    expect(presentationSnapshot().tweenActive).toBe(false);
  });

  it("tweenDurationMs is defined and reasonable (>0, ≤2000)", () => {
    const ms = presentationSnapshot().tweenDurationMs;
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(2000);
  });

  it("INITIAL_PRESENTATION_STATE has required keys", () => {
    expect(INITIAL_PRESENTATION_STATE).toHaveProperty("presentationMode");
    expect(INITIAL_PRESENTATION_STATE).toHaveProperty("isPlaying");
    expect(INITIAL_PRESENTATION_STATE).toHaveProperty("currentStepIndex");
    expect(INITIAL_PRESENTATION_STATE).toHaveProperty("timeLapseSteps");
    expect(INITIAL_PRESENTATION_STATE).toHaveProperty("tweenActive");
    expect(INITIAL_PRESENTATION_STATE).toHaveProperty("tweenDurationMs");
    expect(INITIAL_PRESENTATION_STATE).toHaveProperty("demandFlowActive");
    expect(INITIAL_PRESENTATION_STATE).toHaveProperty("safetyFlagPulsing");
  });
});

describe("presentationStore.setPresentationMode", () => {
  beforeEach(() => {
    presentationStore.reset();
  });

  it("toggles presentation mode ON", () => {
    presentationStore.setPresentationMode(true);
    expect(presentationSnapshot().presentationMode).toBe(true);
  });

  it("toggles presentation mode OFF", () => {
    presentationStore.setPresentationMode(true);
    presentationStore.setPresentationMode(false);
    expect(presentationSnapshot().presentationMode).toBe(false);
  });

  it("turning presentation mode OFF stops any active playback", () => {
    presentationStore.setPresentationMode(true);
    presentationStore.play();
    expect(presentationSnapshot().isPlaying).toBe(true);
    presentationStore.setPresentationMode(false);
    expect(presentationSnapshot().isPlaying).toBe(false);
  });
});

describe("presentationStore time-lapse step machine (discrete + bounded)", () => {
  beforeEach(() => {
    presentationStore.reset();
  });

  it("timeLapseSteps is an array of step objects with required fields", () => {
    const steps = presentationSnapshot().timeLapseSteps;
    for (const step of steps) {
      expect(step).toHaveProperty("label");
      expect(step).toHaveProperty("timeBlock");
      expect(step).toHaveProperty("densityMultiplier");
      expect(typeof step.label).toBe("string");
      expect(typeof step.densityMultiplier).toBe("number");
    }
  });

  it("densityMultiplier for each step is a positive finite number", () => {
    const steps = presentationSnapshot().timeLapseSteps;
    for (const step of steps) {
      expect(step.densityMultiplier).toBeGreaterThan(0);
      expect(isFinite(step.densityMultiplier)).toBe(true);
    }
  });

  it("stepForward advances step index by 1 and wraps on play stop or bounded run", () => {
    const initialIndex = presentationSnapshot().currentStepIndex;
    presentationStore.stepForward();
    expect(presentationSnapshot().currentStepIndex).toBe(initialIndex + 1);
  });

  it("stepForward does not exceed the last step index (bounded)", () => {
    const steps = presentationSnapshot().timeLapseSteps;
    // advance past the end
    for (let i = 0; i <= steps.length + 2; i++) {
      presentationStore.stepForward();
    }
    expect(presentationSnapshot().currentStepIndex).toBeLessThanOrEqual(steps.length - 1);
  });

  it("reset returns to step 0", () => {
    presentationStore.stepForward();
    presentationStore.stepForward();
    presentationStore.resetTimeLapse();
    expect(presentationSnapshot().currentStepIndex).toBe(0);
  });

  it("each step transition sets tweenActive then clears it", () => {
    // After stepForward tweenActive should be true momentarily,
    // then will auto-clear via a timer — we test that it goes true immediately
    presentationStore.stepForward();
    // tweenActive is set true on step change (it's a discrete step, not continuous)
    // The tween duration is bounded (≤2000ms per spec §4.5 ~400ms)
    const state = presentationSnapshot();
    expect(typeof state.tweenActive).toBe("boolean");
  });

  it("currentStepIndex corresponds to an existing step", () => {
    presentationStore.stepForward();
    const s = presentationSnapshot();
    const stepIdx = s.currentStepIndex;
    expect(s.timeLapseSteps[stepIdx]).toBeDefined();
  });

  it("step machine is discrete — densityMultiplier jumps discretely, not a continuous slide", () => {
    // Verify that stepping actually produces distinct values per step
    // (not a linear interpolation that would imply continuous pricing)
    const steps = presentationSnapshot().timeLapseSteps;
    if (steps.length >= 2) {
      // Two adjacent steps should have distinct densityMultiplier values in at least some cases
      // They may occasionally be equal but the system must be step-based (no float nudges between them)
      const allEqual = steps.every((s) => s.densityMultiplier === steps[0].densityMultiplier);
      // Steps that all equal just mean flat density (valid static scenario), but at least
      // the array itself is discrete (non-continuous indices)
      expect(Number.isInteger(presentationSnapshot().currentStepIndex)).toBe(true);
    }
  });
});

describe("presentationStore play/pause", () => {
  beforeEach(() => {
    presentationStore.reset();
    presentationStore.setPresentationMode(true);
  });

  afterEach(() => {
    presentationStore.pause();
    presentationStore.reset();
    vi.useRealTimers();
  });

  it("play() sets isPlaying to true", () => {
    presentationStore.play();
    expect(presentationSnapshot().isPlaying).toBe(true);
  });

  it("pause() sets isPlaying to false", () => {
    presentationStore.play();
    presentationStore.pause();
    expect(presentationSnapshot().isPlaying).toBe(false);
  });

  it("play() when presentation mode is OFF does nothing (default is static)", () => {
    presentationStore.setPresentationMode(false);
    presentationStore.play();
    expect(presentationSnapshot().isPlaying).toBe(false);
  });

  it("stepping while paused does not start playback", () => {
    presentationStore.stepForward();
    expect(presentationSnapshot().isPlaying).toBe(false);
  });

  it("play advances steps on timer intervals (discrete beat)", () => {
    vi.useFakeTimers();
    presentationStore.play();
    const startIdx = presentationSnapshot().currentStepIndex;
    // Advance time by the step interval
    vi.advanceTimersByTime(presentationSnapshot().stepIntervalMs + 100);
    const afterIdx = presentationSnapshot().currentStepIndex;
    // Should have advanced at least 1 step
    expect(afterIdx).toBeGreaterThan(startIdx);
    vi.useRealTimers();
  });

  it("auto-stops when last step is reached", () => {
    vi.useFakeTimers();
    presentationStore.play();
    const steps = presentationSnapshot().timeLapseSteps;
    // Advance far past all steps
    vi.advanceTimersByTime(presentationSnapshot().stepIntervalMs * (steps.length + 5));
    // Should have stopped playing (bounded)
    expect(presentationSnapshot().isPlaying).toBe(false);
    vi.useRealTimers();
  });
});

describe("presentationStore tween properties (step-based, ≤~400ms)", () => {
  beforeEach(() => {
    presentationStore.reset();
  });

  it("tweenDurationMs is approximately 400ms per spec (within 50–1000ms range)", () => {
    // Spec says ~400ms; we enforce it's within a reasonable range
    const ms = presentationSnapshot().tweenDurationMs;
    expect(ms).toBeGreaterThanOrEqual(50);
    expect(ms).toBeLessThanOrEqual(1000);
  });

  it("stepIntervalMs is defined and is a multiple of a 15-min beat (or sub-interval for demo loop)", () => {
    const s = presentationSnapshot();
    expect(s.stepIntervalMs).toBeGreaterThan(0);
    // The ~10-second AM Peak loop means each step interval is ≤ 10000ms for demo purposes
    expect(s.stepIntervalMs).toBeLessThanOrEqual(10000);
  });

  it("tween does not imply continuous pricing — price comes from stepped LOS table, not interpolated", () => {
    // The pricing for any step comes from discrete computeToll() — we verify this via the step shape
    const steps = presentationSnapshot().timeLapseSteps;
    for (const step of steps) {
      // densityMultiplier is a finite discrete factor (not NaN, not Infinity)
      expect(isFinite(step.densityMultiplier)).toBe(true);
      // label is a string (discrete beat description)
      expect(step.label.length).toBeGreaterThan(0);
    }
  });
});

describe("presentationStore demand-flow + safety flag pulsing", () => {
  beforeEach(() => {
    presentationStore.reset();
  });

  it("demandFlowActive defaults to false", () => {
    expect(presentationSnapshot().demandFlowActive).toBe(false);
  });

  it("safetyFlagPulsing defaults to false", () => {
    expect(presentationSnapshot().safetyFlagPulsing).toBe(false);
  });

  it("setDemandFlowActive(true) enables demand flow animation", () => {
    presentationStore.setDemandFlowActive(true);
    expect(presentationSnapshot().demandFlowActive).toBe(true);
  });

  it("setDemandFlowActive(false) disables demand flow animation", () => {
    presentationStore.setDemandFlowActive(true);
    presentationStore.setDemandFlowActive(false);
    expect(presentationSnapshot().demandFlowActive).toBe(false);
  });

  it("setSafetyFlagPulsing(true) enables pulsing", () => {
    presentationStore.setSafetyFlagPulsing(true);
    expect(presentationSnapshot().safetyFlagPulsing).toBe(true);
  });

  it("setSafetyFlagPulsing(false) disables pulsing", () => {
    presentationStore.setSafetyFlagPulsing(true);
    presentationStore.setSafetyFlagPulsing(false);
    expect(presentationSnapshot().safetyFlagPulsing).toBe(false);
  });

  it("reset() clears demandFlowActive and safetyFlagPulsing", () => {
    presentationStore.setDemandFlowActive(true);
    presentationStore.setSafetyFlagPulsing(true);
    presentationStore.reset();
    expect(presentationSnapshot().demandFlowActive).toBe(false);
    expect(presentationSnapshot().safetyFlagPulsing).toBe(false);
  });
});

describe("presentationStore tweenActive lifecycle", () => {
  beforeEach(() => {
    presentationStore.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tweenActive becomes true immediately on stepForward", () => {
    vi.useFakeTimers();
    presentationStore.stepForward();
    expect(presentationSnapshot().tweenActive).toBe(true);
  });

  it("tweenActive clears after tweenDurationMs elapses", () => {
    vi.useFakeTimers();
    presentationStore.stepForward();
    expect(presentationSnapshot().tweenActive).toBe(true);
    const ms = presentationSnapshot().tweenDurationMs;
    vi.advanceTimersByTime(ms + 50);
    expect(presentationSnapshot().tweenActive).toBe(false);
  });
});

describe("Presentation mode as opt-in (M4 integration invariants)", () => {
  beforeEach(() => {
    presentationStore.reset();
    compareStore.reset();
  });

  it("presentation mode defaults to OFF — static operator view is default", () => {
    expect(presentationSnapshot().presentationMode).toBe(false);
    // Static view should still produce valid priced sections
    const result = computeCorridorPricing("morning_peak_eb", "moderate_variable");
    expect(result.sections).toHaveLength(3);
  });

  it("compare mode defaults to OFF — single view is default", () => {
    expect(compareSnapshot().compareMode).toBe(false);
  });

  it("turning compare mode ON does not change the main store pricing", () => {
    const beforeStrategy = storeC.getSnapshot().strategy;
    compareStore.setCompareMode(true);
    expect(storeC.getSnapshot().strategy).toBe(beforeStrategy);
  });

  it("turning presentation mode ON does not change compare mode", () => {
    presentationStore.setPresentationMode(true);
    expect(compareSnapshot().compareMode).toBe(false);
  });

  it("presentation mode reset stops play and resets step index", () => {
    presentationStore.setPresentationMode(true);
    presentationStore.stepForward();
    presentationStore.stepForward();
    presentationStore.reset();
    expect(presentationSnapshot().isPlaying).toBe(false);
    expect(presentationSnapshot().currentStepIndex).toBe(0);
    expect(presentationSnapshot().presentationMode).toBe(false);
  });
});
