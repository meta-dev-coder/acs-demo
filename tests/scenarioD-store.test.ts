/*---------------------------------------------------------------------------------------------
 * Scenario D — store slice (Concept A snapshot foundation) tests.
 * Mirrors tests/scenarioC-store.test.ts. Validates setClosureEvent recompute, the Concept A
 * before/after toggle (display-only, no recompute), the two distinct economics lines (§8-fix-6),
 * narrative-viability ordering (pm_peak > off_peak, rain > clear), and notification discipline.
 *--------------------------------------------------------------------------------------------*/
import { describe, it, expect } from "vitest";
import { storeD, storeDSnapshot, INITIAL_STATE_D } from "../src/scenarioD/storeD";
import { getLaneMenu, computeClosureSim } from "../src/scenarioD/closurePhysics";
import { SCHEMATIC_LABEL } from "../src/scenarioD/placeClosure";

const PM_EVENT = {
  segment_id: "SEG-CONN",
  lanesClosed: 1,
  startMin: 0,
  durationMin: 60,
  timeOfDay: "pm_peak",
} as const;

describe("Scenario D store — initial state", () => {
  it("storeD initial state: closureEvent=null, conceptASnapshot=null, displayMode='before'", () => {
    storeD.reset();
    const s = storeD.getSnapshot();
    expect(s.activeEvent).toBeNull();
    expect(s.conceptASnapshot).toBeNull();
    expect(s.displayMode).toBe("before");
    expect(s.playbackState).toBe("idle");
    expect(s.tickIndex).toBe(0);
  });

  it("INITIAL_STATE_D export has all required fields", () => {
    expect(INITIAL_STATE_D).toMatchObject({
      activeEvent: null,
      conceptASnapshot: null,
      displayMode: "before",
      playbackState: "idle",
      tickIndex: 0,
      kpi: expect.any(Object),
    });
  });

  it("storeDSnapshot() alias returns same object as storeD.getSnapshot()", () => {
    expect(storeDSnapshot()).toBe(storeD.getSnapshot());
  });
});

describe("Scenario D store — setClosureEvent", () => {
  it("setClosureEvent triggers recompute and conceptASnapshot is non-null", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    const s = storeD.getSnapshot();
    expect(s.activeEvent).not.toBeNull();
    expect(s.conceptASnapshot).not.toBeNull();
  });

  it("conceptASnapshot.kpis.maxQueueMi > 0 for 1-of-2 SEG-CONN PM peak", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    expect(storeD.getSnapshot().conceptASnapshot!.kpis.maxQueueMi).toBeGreaterThan(0);
  });

  it("conceptASnapshot.kpis.currentTollUsd > 0 (pricing response fires)", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    expect(storeD.getSnapshot().conceptASnapshot!.kpis.currentTollUsd).toBeGreaterThan(0);
  });

  it("§8-fix-6: delayCostUsd and expressRevenueProtectedUsd exist and are NOT equal", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    const kpi = storeD.getSnapshot().kpi;
    expect(kpi.delayCostUsd).toBeGreaterThan(0);
    expect(kpi.expressRevenueProtectedUsd).toBeGreaterThan(0);
    expect(kpi.delayCostUsd).not.toBeCloseTo(kpi.expressRevenueProtectedUsd, 0);
  });

  it("§8-fix-6: kpi.delayCostUsd / kpi.vehHrsDelay is in [18, 25]", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    const kpi = storeD.getSnapshot().kpi;
    const ratio = kpi.delayCostUsd / kpi.vehHrsDelay;
    expect(ratio).toBeGreaterThanOrEqual(18);
    expect(ratio).toBeLessThanOrEqual(25);
  });

  it("setClosureEvent(null) resets to initial free-flow state", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    storeD.setClosureEvent(null);
    const s = storeD.getSnapshot();
    expect(s.activeEvent).toBeNull();
    expect(s.conceptASnapshot).toBeNull();
  });

  it("off_peak closure produces lower maxQueueMi than pm_peak (narrative viability)", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    const pmQueue = storeD.getSnapshot().kpi.maxQueueMi;
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT, timeOfDay: "off_peak" });
    const offQueue = storeD.getSnapshot().kpi.maxQueueMi;
    expect(pmQueue).toBeGreaterThan(offQueue);
  });

  it("setClosureEvent with invalid lanesClosed=2 on SEG-CONN throws", () => {
    expect(() =>
      storeD.setClosureEvent({ ...PM_EVENT, lanesClosed: 2 })
    ).toThrow();
  });

  it("weather='rain' produces higher maxQueueMi than clear (lower mu_total)", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    const clearQueue = storeD.getSnapshot().kpi.maxQueueMi;
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT, weather: "rain" });
    const wetQueue = storeD.getSnapshot().kpi.maxQueueMi;
    expect(wetQueue).toBeGreaterThan(clearQueue);
  });
});

describe("Scenario D store — Concept A toggle + inspection", () => {
  it("setConceptAMode(true) shows after; false returns to before — no recompute", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    storeD.setConceptAMode(false);
    expect(storeD.getSnapshot().displayMode).toBe("before");
    storeD.setConceptAMode(true);
    expect(storeD.getSnapshot().displayMode).toBe("after");
  });

  it("subscriber is notified exactly once when setClosureEvent is called", () => {
    storeD.reset();
    let count = 0;
    const unsub = storeD.subscribe(() => count++);
    storeD.setClosureEvent({ ...PM_EVENT });
    expect(count).toBe(1);
    unsub();
  });

  it("setConceptAMode fires one notification per call (display-only, no recompute)", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    let notifCount = 0;
    const unsub = storeD.subscribe(() => notifCount++);
    storeD.setConceptAMode(false);
    storeD.setConceptAMode(true);
    expect(notifCount).toBe(2);
    unsub();
  });

  it("inspectClosure(segmentId) sets inspectedSegmentId; null clears it", () => {
    storeD.inspectClosure("SEG-CONN");
    expect(storeD.getSnapshot().inspectedSegmentId).toBe("SEG-CONN");
    storeD.inspectClosure(null);
    expect(storeD.getSnapshot().inspectedSegmentId).toBeNull();
  });

  it("reset() restores INITIAL_STATE_D exactly", () => {
    storeD.setClosureEvent({ ...PM_EVENT });
    storeD.reset();
    expect(storeD.getSnapshot()).toMatchObject(INITIAL_STATE_D);
  });
});

describe("Scenario D store — M5 UI data layer", () => {
  it("lanesClosed menu for SEG-CONN (2 lanes) has exactly one option (1-of-2)", () => {
    const menu = getLaneMenu("SEG-CONN");
    expect(menu).toHaveLength(1);
    expect(menu[0].lanesClosed).toBe(1);
    expect(menu[0].totalLanes).toBe(2);
  });

  it("displayMode toggle (before↔after) does NOT change kpi (display-only)", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    const kpiBefore = storeD.getSnapshot().kpi;
    storeD.setConceptAMode(false);
    storeD.setConceptAMode(true);
    expect(storeD.getSnapshot().kpi).toEqual(kpiBefore);
  });

  it("kpi.currentTollUsd is tied to the Scenario C pricing module (> $0.50 floor)", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    expect(storeD.getSnapshot().kpi.currentTollUsd).toBeGreaterThan(0.50);
  });
});

describe("Scenario D store — M6 Concept B playback", () => {
  it("play() sets playbackState to 'playing'", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    storeD.play();
    expect(storeD.getSnapshot().playbackState).toBe("playing");
  });

  it("pause() sets playbackState to 'paused'", () => {
    storeD.play();
    storeD.pause();
    expect(storeD.getSnapshot().playbackState).toBe("paused");
  });

  it("scrubTo(20) sets tickIndex to 20 (O(1) lookup into the cached tickHistory)", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    storeD.scrubTo(20);
    expect(storeD.getSnapshot().tickIndex).toBe(20);
    expect(storeD.getSnapshot().tickHistory.length).toBeGreaterThan(20);
  });

  it("tickHistory is pre-computed by setClosureEvent (> 60 ticks)", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    expect(storeD.getSnapshot().tickHistory.length).toBeGreaterThan(60);
  });

  it("queue (kpis.maxQueueMi) at tick 40 > tick 0 (builds during closure)", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    const hist = storeD.getSnapshot().tickHistory;
    expect(hist[40].kpis.maxQueueMi).toBeGreaterThan(hist[0].kpis.maxQueueMi);
  });

  it("shockwave tail u at tick 30 < u at tick 5 (tail crawls upstream)", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    const hist = storeD.getSnapshot().tickHistory;
    expect(hist[30].backOfQueue!.u).toBeLessThan(hist[5].backOfQueue!.u);
  });

  it("§8 render-budget: React listener fires ≤ 3 times for 8 tick advances (coarse cadence)", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    let count = 0;
    const unsub = storeD.subscribe(() => count++);
    for (let i = 0; i < 8; i++) storeD.advanceTick();
    expect(count).toBeLessThanOrEqual(3);
    unsub();
  });

  it("§8 render-budget: first React notification fires at tick 4 (not 0/1/2/3)", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    const fireTicks: number[] = [];
    const unsub = storeD.subscribe(() => fireTicks.push(storeD.getSnapshot().tickIndex));
    for (let i = 1; i <= 4; i++) storeD.advanceTick();
    expect(fireTicks[0]).toBe(4);
    unsub();
  });

  it("final-tick unconditional emit: listener fires on the last tick regardless of cadence", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    const maxTicks = storeD.getSnapshot().maxTicks;
    storeD.scrubTo(maxTicks - 1);
    let count = 0;
    const unsub = storeD.subscribe(() => count++);
    storeD.advanceTick(); // reaches maxTicks → unconditional emit
    expect(count).toBe(1);
    unsub();
  });

  it("reset() from a playing state restores idle + tickIndex 0", () => {
    storeD.setClosureEvent({ ...PM_EVENT });
    storeD.play();
    storeD.reset();
    const s = storeD.getSnapshot();
    expect(s.playbackState).toBe("idle");
    expect(s.tickIndex).toBe(0);
  });
});

describe("Scenario D — M7 final regression + integration", () => {
  it("full 240-tick integration: every KPI field is positive", () => {
    const { finalKpi } = computeClosureSim({ ...PM_EVENT }, 240);
    expect(finalKpi.clearanceMin).toBeGreaterThan(0);
    expect(finalKpi.maxQueueMi).toBeGreaterThan(0.5);
    expect(finalKpi.delayCostUsd).toBeGreaterThan(0);
    expect(finalKpi.expressRevenueProtectedUsd).toBeGreaterThan(0);
    expect(finalKpi.currentTollUsd).toBeGreaterThan(0);
    expect(finalKpi.pctDiverted).toBeGreaterThan(0); // fraction (≈0.12); VMS diversion fired
  });

  it("play/scrub round-trip: tickHistory[20] is the tick-20 snapshot", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    storeD.scrubTo(20);
    const snap20 = storeD.getSnapshot().tickHistory[20];
    expect(snap20.tick).toBe(20);
    expect(snap20.kpis.maxQueueMi).toBeGreaterThanOrEqual(0);
  });

  it("SCHEMATIC_LABEL is exported and prominent (≥ 20 chars, contains 'SCHEMATIC')", () => {
    expect(SCHEMATIC_LABEL).toMatch(/SCHEMATIC/i);
    expect(SCHEMATIC_LABEL.length).toBeGreaterThan(20);
  });
});

describe("Scenario D — extended KPIs + dynamic-pricing toggle (G4/G5/G7)", () => {
  it("finalKpi exposes travel time, diverted volume, incident risk (0–1), and net revenue", () => {
    const { finalKpi } = computeClosureSim({ ...PM_EVENT }, 300);
    expect(finalKpi.travelTimeMin).toBeGreaterThan(10); // base traverse + queue delay
    expect(finalKpi.divertedVph).toBeGreaterThan(0);
    expect(finalKpi.secondaryIncidentRisk).toBeGreaterThan(0);
    expect(finalKpi.secondaryIncidentRisk).toBeLessThanOrEqual(1);
    expect(finalKpi.netRevenueUsd).toBeCloseTo(
      finalKpi.expressRevenueProtectedUsd - finalKpi.delayCostUsd, 2
    );
  });

  it("dynamic-pricing toggle shifts the revenue line (re-runs the sim under a different strategy)", () => {
    storeD.reset();
    storeD.setClosureEvent({ ...PM_EVENT });
    const onRev = storeD.getSnapshot().kpi.expressRevenueProtectedUsd;
    storeD.setDynamicPricing(false);
    const offRev = storeD.getSnapshot().kpi.expressRevenueProtectedUsd;
    expect(storeD.getSnapshot().dynamicPricing).toBe(false);
    // The toggle has a real effect — variable vs flat/static pricing produces different revenue.
    // (Direction is model-dependent: dynamic pricing optimizes free-flow speed, not max revenue.)
    expect(offRev).not.toBeCloseTo(onRev, 0);
  });
});
