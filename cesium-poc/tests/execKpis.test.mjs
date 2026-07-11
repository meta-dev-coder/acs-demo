/*---------------------------------------------------------------------------------------------
 * execKpis.test.mjs — UC1 P5-c: exec KPI strip math (design spec §4 "Exec KPI strip" + Decision
 * 5's seeded-decision-log fix). computeExecKpis() must work on the committed seed file ALONE (no
 * live decisions, no windowResults) — that's the whole point of Decision 5 (a live log with one
 * decision reads as an empty dashboard, so the shim ships a seeded log the KPI strip reads too).
 *--------------------------------------------------------------------------------------------*/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { computeExecKpis, normalizeDecisionEvidence, renderExecKpiStrip } from "../src/execKpis.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedPath = path.join(__dirname, "..", "..", "tools", "dataconnect-data", "decisions_seed.json");

function loadSeed() {
  return JSON.parse(readFileSync(seedPath, "utf-8"));
}

// ---- normalizeDecisionEvidence: bridges the seed shape and the live buildUc1DecisionRecord() shape ----

test("normalizeDecisionEvidence: reads the SEED shape (queue.avgDelayMin, openLanes/totalLanes)", () => {
  const ev = normalizeDecisionEvidence({
    seeded: true,
    window: { durationHours: 4 },
    revenueAtRiskUsd: { point: 0, low: 0, high: 0, band: 0.15 },
    queue: { avgDelayMin: 0 },
    secondaryCrashExposure: 0.3,
    openLanes: 2,
    totalLanes: 3,
  });
  assert.equal(ev.seeded, true);
  assert.equal(ev.rank, null);
  assert.equal(ev.durationHours, 4);
  assert.equal(ev.revenueAtRiskPointUsd, 0);
  assert.equal(ev.revenueAtRiskHighUsd, 0);
  assert.equal(ev.avgDelayMin, 0);
  assert.equal(ev.secondaryCrashExposure, 0.3);
  assert.ok(Math.abs(ev.laneAvailabilityFrac - 2 / 3) < 1e-9);
});

test("normalizeDecisionEvidence: reads the LIVE shape (top-level avgDelayMin, laneAvailabilityPct, rank)", () => {
  const ev = normalizeDecisionEvidence({
    seeded: undefined,
    rank: 1,
    window: { durationHours: 4 },
    revenueAtRiskUsd: { point: 100, low: 85, high: 130, band: 0.15 },
    avgDelayMin: 6.5,
    secondaryCrashExposure: 0.5,
    laneAvailabilityPct: 60,
  });
  assert.equal(ev.seeded, false);
  assert.equal(ev.rank, 1);
  assert.equal(ev.avgDelayMin, 6.5);
  assert.equal(ev.revenueAtRiskHighUsd, 130);
  assert.ok(Math.abs(ev.laneAvailabilityFrac - 0.6) < 1e-9);
});

test("normalizeDecisionEvidence: missing/malformed fields default safely (no NaN/undefined leaks)", () => {
  const ev = normalizeDecisionEvidence({});
  assert.equal(ev.durationHours, 0);
  assert.equal(ev.revenueAtRiskPointUsd, 0);
  assert.equal(ev.revenueAtRiskHighUsd, 0);
  assert.equal(ev.avgDelayMin, 0);
  assert.equal(ev.secondaryCrashExposure, 0);
  assert.equal(ev.laneAvailabilityFrac, null);
  assert.equal(ev.rank, null);
});

// ---- computeExecKpis: fallback (evidence-only, no windowResults) — the seed-alone path ----------

test("computeExecKpis: works on a small mixed seeded+live fixture, no windowResults", () => {
  const decisions = [
    // A: seeded historical row — no rank recorded, revenue/delay evaluator numbers both zero
    // (matches the real seed file: off-peak historical closures never exceeded capacity).
    {
      id: "SEED-A",
      seeded: true,
      window: { durationHours: 4 },
      revenueAtRiskUsd: { point: 0, low: 0, high: 0, band: 0.15 },
      queue: { avgDelayMin: 0 },
      secondaryCrashExposure: 0.3,
      openLanes: 2,
      totalLanes: 3,
    },
    // B: live decision, rank 1 (system's optimal pick), non-zero revenue band.
    {
      id: "LIVE-B",
      rank: 1,
      window: { durationHours: 4 },
      revenueAtRiskUsd: { point: 100, low: 85, high: 130, band: 0.15 },
      avgDelayMin: 6,
      secondaryCrashExposure: 0.5,
      laneAvailabilityPct: 60,
    },
    // C: live decision, rank 2 (planner overrode the system's pick) — fully open lanes, so no
    // crash-exposure avoided by lane availability.
    {
      id: "LIVE-C",
      rank: 2,
      window: { durationHours: 2 },
      revenueAtRiskUsd: { point: 50, low: 42.5, high: 60, band: 0.15 },
      avgDelayMin: 3,
      secondaryCrashExposure: 0.4,
      laneAvailabilityPct: 100,
    },
  ];

  const kpis = computeExecKpis(decisions);

  assert.equal(kpis.decisionCount, 3);
  assert.equal(kpis.seededCount, 1);
  assert.equal(kpis.hasSeededData, true);
  assert.equal(kpis.revenueProtected, 40); // (0-0) + (130-100) + (60-50)
  assert.equal(kpis.closureHoursAvoided, 8); // A (rank defaults 1) + B (rank 1); C is rank 2, excluded
  assert.equal(kpis.pctOptimalWindow, 66.7); // 2 of 3 decisions counted "optimal"
  assert.equal(kpis.secondaryIncidentsAvoided, 0.3); // 0.3*(1/3) + 0.5*0.4 + 0.4*0
});

test("computeExecKpis: empty decisions array returns zeroed KPIs, never throws/NaNs", () => {
  const kpis = computeExecKpis([]);
  assert.equal(kpis.decisionCount, 0);
  assert.equal(kpis.hasSeededData, false);
  assert.equal(kpis.revenueProtected, 0);
  assert.equal(kpis.closureHoursAvoided, 0);
  assert.equal(kpis.pctOptimalWindow, 0);
  assert.equal(kpis.secondaryIncidentsAvoided, 0);
});

test("computeExecKpis: undefined/null decisions treated as empty, not a throw", () => {
  assert.doesNotThrow(() => computeExecKpis(undefined));
  assert.doesNotThrow(() => computeExecKpis(null));
});

// ---- computeExecKpis: the REAL seed file, alone (Decision 5's actual demo path) -----------------

test("computeExecKpis: the real decisions_seed.json alone (no windowResults) — the seeded-alone path", () => {
  const seed = loadSeed();
  assert.equal(seed.length, 15);
  assert.ok(seed.every((r) => r.seeded === true), "fixture drifted: expected every seed row seeded:true");

  const kpis = computeExecKpis(seed);

  assert.equal(kpis.decisionCount, 15);
  assert.equal(kpis.seededCount, 15);
  assert.equal(kpis.hasSeededData, true);
  // Every seed row's evaluator-recorded revenueAtRiskUsd is {point:0, high:0} (off-peak closures
  // never exceeded closed capacity) — the fallback band-delta is honestly 0, not invented.
  assert.equal(kpis.revenueProtected, 0);
  // Seed rows carry no `rank` (predate the optimizer) -> each counts as its own realized choice ->
  // every row's duration contributes. Sum of the 15 rows' window.durationHours.
  assert.equal(kpis.closureHoursAvoided, 55.5);
  assert.equal(kpis.pctOptimalWindow, 100);
  // secondaryCrashExposure * (1 - openLanes/totalLanes) summed, openLanes=2/totalLanes=3 uniformly
  // across the seed set -> sum(secondaryCrashExposure)/3.
  assert.equal(kpis.secondaryIncidentsAvoided, 0.98);
});

// ---- computeExecKpis: windowResults path (precise worst-vs-chosen deltas) -----------------------

test("computeExecKpis: prefers an exact worst-vs-chosen delta when windowResults[i] is supplied", () => {
  const decisions = [
    {
      id: "LIVE-D",
      rank: 1,
      window: { id: "overnight", durationHours: 4 },
      // These evidence-only numbers should be IGNORED once a real candidate set is supplied.
      revenueAtRiskUsd: { point: 20, low: 17, high: 25, band: 0.15 },
      avgDelayMin: 999,
      secondaryCrashExposure: 999,
      laneAvailabilityPct: 60,
    },
  ];
  const windowResults = [
    {
      windows: [{ id: "overnight" }, { id: "weekendMorning" }, { id: "weekdayPm" }],
      winnerIdx: 0,
      results: [
        { score: 0.05, revenueAtRiskUsd: { point: 20 }, queue: { avgDelayMin: 5 }, secondaryCrashExposure: 0.1 },
        { score: 0.2, revenueAtRiskUsd: { point: 80 }, queue: { avgDelayMin: 15 }, secondaryCrashExposure: 0.5 },
        { score: 0.5, revenueAtRiskUsd: { point: 150 }, queue: { avgDelayMin: 40 }, secondaryCrashExposure: 0.9 },
      ],
    },
  ];

  const kpis = computeExecKpis(decisions, windowResults);

  assert.equal(kpis.revenueProtected, 130); // worst(150) - chosen(20)
  assert.equal(kpis.secondaryIncidentsAvoided, 0.8); // worst(0.9) - chosen(0.1)
  assert.equal(kpis.closureHoursAvoided, 4);
  assert.equal(kpis.pctOptimalWindow, 100);
});

test("computeExecKpis: a malformed windowResults[i] entry falls back to the evidence-only path for that decision", () => {
  const decisions = [
    {
      id: "LIVE-E",
      rank: 1,
      window: { durationHours: 4 },
      revenueAtRiskUsd: { point: 0, low: 0, high: 30, band: 0.15 },
      avgDelayMin: 0,
      secondaryCrashExposure: 0.6,
      laneAvailabilityPct: 0,
    },
  ];
  const kpis = computeExecKpis(decisions, [{ results: [] }]);
  assert.equal(kpis.revenueProtected, 30); // high - point fallback
  assert.equal(kpis.secondaryIncidentsAvoided, 0.6); // fully closed (0% lanes open) -> full exposure "avoided"
});

// ---- renderExecKpiStrip: DOM string generation (containerEl.innerHTML only, no querySelector) ---

function fakeEl() {
  return { innerHTML: "" };
}

test("renderExecKpiStrip: no-ops when containerEl is missing", () => {
  assert.doesNotThrow(() => renderExecKpiStrip(null, computeExecKpis([])));
});

test("renderExecKpiStrip: renders all four KPI values", () => {
  const el = fakeEl();
  const kpis = computeExecKpis(loadSeed());
  renderExecKpiStrip(el, kpis);
  assert.ok(el.innerHTML.includes("$0")); // revenueProtected
  assert.ok(el.innerHTML.includes("55.5"));
  assert.ok(el.innerHTML.includes("100.0%"));
  assert.ok(el.innerHTML.includes("0.98"));
});

test("renderExecKpiStrip: shows the seeded-history honesty label whenever any decision is seeded", () => {
  const el = fakeEl();
  renderExecKpiStrip(el, computeExecKpis(loadSeed()));
  const html = el.innerHTML.toLowerCase();
  assert.ok(html.includes("seeded"));
  assert.ok(html.includes("2024"));
  assert.ok(html.includes("closure history"));
});

test("renderExecKpiStrip: omits the seeded-history label when no decision is seeded", () => {
  const el = fakeEl();
  const kpis = computeExecKpis([
    {
      id: "LIVE-ONLY",
      rank: 1,
      window: { durationHours: 4 },
      revenueAtRiskUsd: { point: 0, low: 0, high: 0, band: 0.15 },
      avgDelayMin: 0,
      secondaryCrashExposure: 0,
      laneAvailabilityPct: 100,
    },
  ]);
  renderExecKpiStrip(el, kpis);
  assert.ok(!el.innerHTML.toLowerCase().includes("seeded"));
});
