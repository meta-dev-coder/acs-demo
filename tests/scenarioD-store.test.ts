/*---------------------------------------------------------------------------------------------
 * Scenario D — store slice (Concept A snapshot foundation) tests.
 * Mirrors tests/scenarioC-store.test.ts. Validates setClosureEvent recompute, the Concept A
 * before/after toggle (display-only, no recompute), the two distinct economics lines (§8-fix-6),
 * narrative-viability ordering (pm_peak > off_peak, rain > clear), and notification discipline.
 *--------------------------------------------------------------------------------------------*/
import { describe, it, expect } from "vitest";
import { storeD, storeDSnapshot, INITIAL_STATE_D } from "../src/scenarioD/storeD";

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
