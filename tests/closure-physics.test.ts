/*---------------------------------------------------------------------------------------------
 * M0 skeleton — closure physics type import checks only. No physics yet.
 *
 * These tests confirm that the types file compiles and the config JSON is valid.
 * All physics implementation tests live in later milestones (M1+).
 *--------------------------------------------------------------------------------------------*/
import { describe, it, expect } from "vitest";

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
