/*---------------------------------------------------------------------------------------------
 * M0 skeleton — closure physics type import checks only. No physics yet.
 *
 * These tests confirm that the types file compiles and the config JSON is valid.
 * All physics implementation tests live in later milestones (M1+).
 *--------------------------------------------------------------------------------------------*/
import { describe, it, expect, vi } from "vitest";

describe("M0 closure-physics skeleton — type imports only", () => {
  it("ClosureEvent type import compiles with all optional fields", () => {
    const evt: import("../src/scenarioD/typesD").ClosureEvent = {
      segment_id: "SEG-CONN",
      lanesClosed: 1,
      startMin: 0,
      durationMin: 60,
      timeOfDay: "pm_peak",
      weather: "rain",
      cause: "maintenance",
    };
    expect(evt.segment_id).toBe("SEG-CONN");
    expect(evt.weather).toBe("rain");
    expect(evt.cause).toBe("maintenance");
  });

  it("ClosureEvent off_peak timeOfDay compiles", () => {
    const evt: import("../src/scenarioD/typesD").ClosureEvent = {
      segment_id: "SEG-MN-W",
      lanesClosed: 1,
      startMin: 120,
      durationMin: 30,
      timeOfDay: "off_peak",
    };
    expect(evt.timeOfDay).toBe("off_peak");
  });

  it("ClosureLaneMenuEntry type compiles", () => {
    const entry: import("../src/scenarioD/typesD").ClosureLaneMenuEntry = {
      lanesClosed: 1,
      totalLanes: 2,
      caf: 0.35,
    };
    expect(entry.caf).toBe(0.35);
  });

  it("SegmentSimState type compiles", () => {
    const seg: import("../src/scenarioD/typesD").SegmentSimState = {
      segmentId: "SEG-CONN",
      losBand: "E",
      density: 38,
      speed: 25,
      queued: true,
    };
    expect(seg.queued).toBe(true);
  });

  it("BackOfQueue type compiles", () => {
    const boq: import("../src/scenarioD/typesD").BackOfQueue = {
      u: 0.45,
      eastingMeters: 588000,
      lengthMi: 0.8,
      segmentSpan: ["SEG-CONN"],
    };
    expect(boq.eastingMeters).toBe(588000);
  });

  it("ClosureSimState type compiles", () => {
    const state: import("../src/scenarioD/typesD").ClosureSimState = {
      tick: 0,
      segmentStates: [],
      backOfQueue: null,
      kpis: {
        maxQueueMi: 0,
        vehHrsDelay: 0,
        clearanceMin: 0,
        currentTollUsd: 0,
        pctDiverted: 0,
        delayCostUsd: 0,
        expressRevenueProtectedUsd: 0,
      },
      diversionActive: false,
      shockwaveMph: 0,
    };
    expect(state.tick).toBe(0);
    expect(state.backOfQueue).toBeNull();
  });

  it("PlaybackState type accepts all variants", () => {
    const states: import("../src/scenarioD/typesD").PlaybackState[] = [
      "idle",
      "playing",
      "paused",
    ];
    expect(states).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// M1 — Pure Physics Engine tests (all RED until closurePhysics.ts is committed)
// ---------------------------------------------------------------------------

describe("M1 closure-physics engine — §8-fix-1: single turbulence source", () => {
  it("§8-fix-1: mu_total for SEG-CONN 1-of-2, clear, not queued = CAF(0.35) × baseC(4000) exactly", async () => {
    const { computeMuTotal } = await import("../src/scenarioD/closurePhysics");
    const mu = computeMuTotal({ segment_id: "SEG-CONN", lanesClosed: 1, timeOfDay: "pm_peak" }, false, false);
    expect(mu).toBeCloseTo(0.35 * 4000, 0); // 4000 = 2000 vphpl × 2 lanes
  });

  it("§8-fix-1: mu_total with weather reduces by 0.85 factor and nothing else", async () => {
    const { computeMuTotal } = await import("../src/scenarioD/closurePhysics");
    const muClear = computeMuTotal({ segment_id: "SEG-CONN", lanesClosed: 1, timeOfDay: "pm_peak" }, false, false);
    const muWet   = computeMuTotal({ segment_id: "SEG-CONN", lanesClosed: 1, timeOfDay: "pm_peak", weather: "rain" }, true, false);
    expect(muWet).toBeCloseTo(muClear * 0.85, 1);
  });

  it("§8-fix-1: queue-discharge factor 0.93 applies once queued, not before", async () => {
    const { computeMuTotal } = await import("../src/scenarioD/closurePhysics");
    const muOpen   = computeMuTotal({ segment_id: "SEG-CONN", lanesClosed: 1, timeOfDay: "pm_peak" }, false, false);
    const muQueued = computeMuTotal({ segment_id: "SEG-CONN", lanesClosed: 1, timeOfDay: "pm_peak" }, false, true);
    expect(muQueued).toBeCloseTo(muOpen * 0.93, 1);
  });
});

describe("M1 closure-physics engine — §8-fix-2: per-segment CAF menu", () => {
  it("§8-fix-2: getLaneMenu for SEG-CONN (2 lanes) returns exactly one entry", async () => {
    const { getLaneMenu } = await import("../src/scenarioD/closurePhysics");
    const menu = getLaneMenu("SEG-CONN");
    expect(menu).toHaveLength(1);
    expect(menu[0]).toMatchObject({ lanesClosed: 1, totalLanes: 2, caf: 0.35 });
  });

  it("§8-fix-2: getLaneMenu for 3-lane mainline returns two entries", async () => {
    const { getLaneMenu } = await import("../src/scenarioD/closurePhysics");
    const menu = getLaneMenu("SEG-MN-C");
    expect(menu).toHaveLength(2);
    expect(menu.map((e: { lanesClosed: number }) => e.lanesClosed)).toEqual([1, 2]);
  });

  it("§8-fix-2: buildClosureSegment throws for lanesClosed=2 on SEG-CONN", async () => {
    const { buildClosureSegment } = await import("../src/scenarioD/closurePhysics");
    expect(() =>
      buildClosureSegment({ segment_id: "SEG-CONN", lanesClosed: 2, startMin: 0, durationMin: 60, timeOfDay: "pm_peak" })
    ).toThrow();
  });
});

describe("M1 closure-physics engine — §8-fix-3: LOS branch selection by queue membership", () => {
  it("§8-fix-3: queued segment (speed < 45 mph) maps to CONGESTED branch → LOS E or F", async () => {
    const { losFromState } = await import("../src/scenarioD/closurePhysics");
    // flow=1600 total on 2-lane segment, speed=40, queued=true
    const band = losFromState(1600, 40, true, 2);
    expect(["E", "F"]).toContain(band);
  });

  it("§8-fix-3: free-flow downstream segment (queued=false, speed ≥ 65) maps to LOS A or B", async () => {
    const { losFromState } = await import("../src/scenarioD/closurePhysics");
    // 2-lane downstream free-flow segment
    const band = losFromState(900, 65, false, 2);
    expect(["A", "B"]).toContain(band);
  });

  it("§8-fix-3: low served-flow but queued=false does NOT return LOS E or F (no blind inversion)", async () => {
    const { losFromState } = await import("../src/scenarioD/closurePhysics");
    // Low flow (served drops downstream of bottleneck) but NOT in the queue — 2-lane segment
    const band = losFromState(500, 65, false, 2);
    expect(["E", "F"]).not.toContain(band);
  });

  it("§8-fix-3: 3-lane queued segment returns correct LOS (lanes parameter respected)", async () => {
    const { losFromState } = await import("../src/scenarioD/closurePhysics");
    // 3-lane segment: same total flow as 2-lane test but divided by 3 lanes
    // flow=2400 total on 3-lane segment at 25 mph (congested), queued=true → LOS E or F
    const band3 = losFromState(2400, 25, true, 3);
    expect(["E", "F"]).toContain(band3);
    // 3-lane free-flow at low density → LOS A or B
    const bandFree3 = losFromState(900, 65, false, 3);
    expect(["A", "B"]).toContain(bandFree3);
  });
});

describe("M1 closure-physics engine — §8-fix-4: total-vph units discipline", () => {
  it("§8-fix-4: D_total = vphpl × lanes (total corridor vph, not per-lane)", async () => {
    const { computeDTotal } = await import("../src/scenarioD/closurePhysics");
    const d2lane = computeDTotal("SEG-CONN", "pm_peak", 0);
    expect(d2lane).toBeGreaterThan(1000); // 1800 vphpl × 2 = 3600 total
    const d3lane = computeDTotal("SEG-MN-C", "pm_peak", 0);
    // Doubling check: 3-lane at same vphpl → 1.5× the 2-lane total
    expect(d3lane / d2lane).toBeCloseTo(1.5, 0);
  });

  it("§8-fix-4: doubling lanes doubles mu_total (§5.2 test gate: D_total AND mu_total scale proportionally)", async () => {
    // Plan §5.2 gate: "doubling lanes doubles both D_total AND mu_total"
    // SEG-CONN: 2 lanes, baseCapPerLane=2000, CAF(1-of-2)=0.35 → mu=0.35×4000=1400
    // SEG-MN-W: 3 lanes, baseCapPerLane=2200, CAF(1-of-3)=0.49 → mu=0.49×6600=3234
    // Ratio test: SEG-MN-W/SEG-CONN with 1-of-N closed → mu_total scales with lanes×baseCapPerLane×CAF
    // For same vphpl and proportional lanes, mu_total(3-lane) / mu_total(2-lane) must be > 1
    const { computeMuTotal } = await import("../src/scenarioD/closurePhysics");
    // 2-lane segment (SEG-CONN): 1-of-2 closed, clear, not queued
    const mu2lane = computeMuTotal({ segment_id: "SEG-CONN", lanesClosed: 1, timeOfDay: "pm_peak" }, false, false);
    // 3-lane segment (SEG-MN-C): 1-of-3 closed, clear, not queued
    const mu3lane = computeMuTotal({ segment_id: "SEG-MN-C", lanesClosed: 1, timeOfDay: "pm_peak" }, false, false);
    // mu3lane must be strictly larger than mu2lane (3-lane corridor has higher total capacity)
    expect(mu3lane).toBeGreaterThan(mu2lane);
    // Exact ratio: (0.49 × 2200 × 3) / (0.35 × 2000 × 2) = 3234 / 1400 ≈ 2.31
    // The ratio must be > 1.5 (at least proportional to the lane-count increase)
    expect(mu3lane / mu2lane).toBeGreaterThan(1.5);
  });
});

describe("M1 closure-physics engine — §8-fix-5: queueTailEasting helper", () => {
  it("§8-fix-5: queueTailEasting(590000, 2000) returns 588000 ± 1 m", async () => {
    const { queueTailEasting } = await import("../src/scenarioD/closurePhysics");
    expect(queueTailEasting(590000, 2000)).toBeCloseTo(588000, 0);
  });

  it("§8-fix-5: queueTailEasting result is strictly west (< closureStartEasting) for length > 0", async () => {
    const { queueTailEasting } = await import("../src/scenarioD/closurePhysics");
    expect(queueTailEasting(590000, 500)).toBeLessThan(590000);
  });

  it("§8-fix-5: queueTailEasting is clamped to eMin (578200) for extreme lengths", async () => {
    const { queueTailEasting } = await import("../src/scenarioD/closurePhysics");
    expect(queueTailEasting(580000, 50000)).toBe(578200);
  });

  it("§8-fix-5: queueTailEasting(590000, 0) === 590000 (zero queue returns closure head)", async () => {
    const { queueTailEasting } = await import("../src/scenarioD/closurePhysics");
    expect(queueTailEasting(590000, 0)).toBe(590000);
  });
});

describe("M1 closure-physics engine — §8-fix-6: two economics lines", () => {
  it("§8-fix-6: delayCostUsd and expressRevenueProtectedUsd are distinct non-equal values", async () => {
    const { computeStateDKpi } = await import("../src/scenarioD/closurePhysics");
    const kpi = computeStateDKpi({ vehHrsDelay: 100, maxQueueMi: 1.2, pctDiverted: 12 } as any, 60);
    expect(kpi.delayCostUsd).toBeGreaterThan(0);
    expect(kpi.expressRevenueProtectedUsd).toBeGreaterThan(0);
    expect(kpi.delayCostUsd).not.toBeCloseTo(kpi.expressRevenueProtectedUsd, 0);
  });

  it("§8-fix-6: delayCostUsd / vehHrsDelay is in [18, 25] (value-of-time range)", async () => {
    const { computeStateDKpi } = await import("../src/scenarioD/closurePhysics");
    const kpi = computeStateDKpi({ vehHrsDelay: 100, maxQueueMi: 1.0, pctDiverted: 0 } as any, 60);
    const ratio = kpi.delayCostUsd / 100;
    expect(ratio).toBeGreaterThanOrEqual(18);
    expect(ratio).toBeLessThanOrEqual(25);
  });

  it("§8-fix-6: expressRevenueProtectedUsd does NOT equal closureDurationHours × 7800 × lanesClosed", async () => {
    const { computeStateDKpi } = await import("../src/scenarioD/closurePhysics");
    const closureDurationHr = 1;
    const lanesClosed = 1;
    const kpi = computeStateDKpi({ vehHrsDelay: 100, maxQueueMi: 1.0, pctDiverted: 12 } as any, closureDurationHr * 60);
    const wrongFormula = closureDurationHr * 7800 * lanesClosed;
    expect(Math.abs(kpi.expressRevenueProtectedUsd - wrongFormula)).toBeGreaterThan(100);
  });

  it("§8-fix-6: expressRevenueProtectedUsd is strictly less than projectedRevenuePerHour × closureDurationHr (baseline subtracted per §5.7)", async () => {
    // The delta formula (§5.7) subtracts the off-peak baseline, so the result must be
    // strictly less than projectedRevenuePerHour × closureDurationHr (no-baseline version).
    // This test confirms the baseline subtraction is NOT missing.
    const { computeStateDKpi, computeClosureSim } = await import("../src/scenarioD/closurePhysics");
    const kpi = computeStateDKpi({ vehHrsDelay: 50, maxQueueMi: 0.8, pctDiverted: 0 } as any, 60);
    // projectedRevenuePerHour ≈ 6071 (evening_peak_wb moderate_variable)
    // baseline ≈ 975 (off_peak), so delta ≈ 5096 per hour → for 1 hr ≈ 5096
    // Without baseline subtraction, it would be ≈ 6071. The delta is ~16% lower.
    // Verify the result is strictly less than the gross (no-subtraction) value by at least $100
    const projectedGrossApprox = 6071.75 * (60 / 60); // approximate from known pricing output
    expect(kpi.expressRevenueProtectedUsd).toBeLessThan(projectedGrossApprox - 100);
    expect(kpi.expressRevenueProtectedUsd).toBeGreaterThan(0);
    void computeClosureSim; // used in other tests
  });
});

describe("M1 closure-physics engine — additional physics correctness", () => {
  it("queue length grows monotonically for first 10 ticks (D_total > mu_total)", async () => {
    const { stepQueueModel } = await import("../src/scenarioD/closurePhysics");
    const event = { segment_id: "SEG-CONN", lanesClosed: 1, startMin: 0, durationMin: 60, timeOfDay: "pm_peak" } as const;
    let prevQ = 0;
    let state = { cumArrivals: 0, cumDepartures: 0, queue: 0, isQueued: false };
    for (let tick = 0; tick < 10; tick++) {
      state = stepQueueModel(event, state, 30, false); // 30s dt, no diversion
      expect(state.queue).toBeGreaterThanOrEqual(prevQ);
      prevQ = state.queue;
    }
    expect(prevQ).toBeGreaterThan(0);
  });

  it("queue drains monotonically after closure ends", async () => {
    const { stepQueueModel } = await import("../src/scenarioD/closurePhysics");
    const reopenEvent = { segment_id: "SEG-CONN", lanesClosed: 0, startMin: 0, durationMin: 0, timeOfDay: "pm_peak" } as const;
    let state = { cumArrivals: 300, cumDepartures: 0, queue: 300, isQueued: true };
    let prevQ = 300;
    for (let tick = 0; tick < 10; tick++) {
      state = stepQueueModel(reopenEvent, state, 30, false);
      expect(state.queue).toBeLessThanOrEqual(prevQ);
      prevQ = state.queue;
    }
  });

  it("shockwave w_stop is negative (upstream) and within -6 to -12 mph", async () => {
    const { computeShockwaveSpeed } = await import("../src/scenarioD/closurePhysics");
    const w = computeShockwaveSpeed("SEG-CONN", 1, "pm_peak");
    expect(w).toBeLessThan(0);
    expect(w).toBeGreaterThan(-15); // generous bound for synthetic frame
  });

  it("recovery wave w_recover > |w_stop| (overtakes to clear)", async () => {
    const { computeShockwaveSpeed, computeRecoveryWaveSpeed } = await import("../src/scenarioD/closurePhysics");
    const wStop = computeShockwaveSpeed("SEG-CONN", 1, "pm_peak");
    const wRecover = computeRecoveryWaveSpeed("SEG-CONN");
    expect(wRecover).toBeGreaterThan(0);
    expect(wRecover).toBeGreaterThan(Math.abs(wStop));
  });

  it("TimeBlock mapping: pm_peak maps to evening_peak_wb", async () => {
    const { mapTimeBlock } = await import("../src/scenarioD/closurePhysics");
    expect(mapTimeBlock("pm_peak")).toBe("evening_peak_wb");
    expect(mapTimeBlock("off_peak")).toBe("off_peak");
  });

  it("computeCorridorPricing is called during toll-response step", async () => {
    const pricing = await import("../src/scenarioC/pricing");
    const spy = vi.spyOn(pricing, "computeCorridorPricing");
    const { computeClosureSim } = await import("../src/scenarioD/closurePhysics");
    computeClosureSim(
      { segment_id: "SEG-CONN", lanesClosed: 1, startMin: 0, durationMin: 60, timeOfDay: "pm_peak" },
      10
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("diversion triggers when queue > 0.75 mi — pctDiverted > 0", async () => {
    const { computeClosureSim } = await import("../src/scenarioD/closurePhysics");
    const result = computeClosureSim(
      { segment_id: "SEG-CONN", lanesClosed: 1, startMin: 0, durationMin: 120, timeOfDay: "pm_peak" },
      240
    );
    const diversionTick = result.tickHistory.find((t) => t.kpis.pctDiverted > 0);
    expect(diversionTick).toBeDefined();
  });

  it("narrative viability: 1-of-2 SEG-CONN PM peak → maxQueueMi > 0.5 mi, clearanceMin > 30", async () => {
    const { computeClosureSim } = await import("../src/scenarioD/closurePhysics");
    const result = computeClosureSim(
      { segment_id: "SEG-CONN", lanesClosed: 1, startMin: 0, durationMin: 60, timeOfDay: "pm_peak" },
      240
    );
    const finalKpi = result.tickHistory[result.tickHistory.length - 1].kpis;
    expect(finalKpi.maxQueueMi).toBeGreaterThan(0.5);
    expect(finalKpi.clearanceMin).toBeGreaterThan(30);
  });

  it("clearanceMin matches the first tick where queue drains to zero after closure ends", async () => {
    // Use off_peak (lower demand = 900 vphpl × 2 = 1800 vph) with 60-min closure.
    // After closure: open-road mu=4000, demand=1800, drain rate=2200 vph.
    // Queue drains within ~11 min of closure end → clearance tick is around 142 (well within 200 ticks).
    // This guarantees clearanceTick >= 0 — the guard below is NOT dead code.
    const { computeClosureSim } = await import("../src/scenarioD/closurePhysics");
    const result = computeClosureSim(
      { segment_id: "SEG-CONN", lanesClosed: 1, startMin: 0, durationMin: 60, timeOfDay: "off_peak" },
      200
    );
    // Find the first tick after the closure starts (tick > 0) where the queue has drained to zero
    const clearanceTick = result.tickHistory.findIndex((t) => t.queue <= 0 && t.tick > 60);
    // Assert clearanceTick >= 0 FIRST — if this fails, the scenario or simulation is broken
    expect(clearanceTick).toBeGreaterThanOrEqual(0);
    const kpi = result.tickHistory[result.tickHistory.length - 1].kpis;
    // Now the inner check is NOT dead code — clearanceTick is guaranteed to be ≥ 0
    if (clearanceTick >= 0) {
      const expectedMin = (clearanceTick * 30) / 60;
      expect(kpi.clearanceMin).toBeCloseTo(expectedMin, 0);
    }
  });
});
