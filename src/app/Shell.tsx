/*---------------------------------------------------------------------------------------------
 * Operational-twin app shell. The iTwin Viewer is the hero panel; around it sit a filterable
 * asset/segment list (left), a detail inspector (right), scenario tabs (top), and a KPI bar
 * (bottom). Selection is linked both ways via the shared store: click a list row -> frame in
 * the viewer; click in the viewer -> the row highlights and the inspector updates.
 *
 * M0 refactor: scenarios are now driven by SCENARIO_REGISTRY so adding C (Dynamic Tolling)
 * and future scenarios is purely additive. The A/B panel components are unchanged.
 *--------------------------------------------------------------------------------------------*/
import "./shell.css";
import { type ReactNode, useMemo, useState } from "react";
import { store, useScenarioState } from "../scenarioA/store";
import { ageYears, bandMeta, conditionLabel } from "../scenarioA/scoring";
import { computeWorkPackage } from "../scenarioA/workPackage";
import { frameWorld } from "../scenarioA/viewportUtils";
import type { RiskBand, ScoredAsset } from "../scenarioA/types";
import { bandMeta as segBandMeta } from "../scenarioB/safetyScoring";
import type { ScoredSegment } from "../scenarioB/types";
import { GuidedTour, shouldAutoStartTour } from "./GuidedTour";
import { DataSourceSwitcher, DataTablePanel } from "./DataSource";
import { SCENARIO_REGISTRY, ALL_SCENARIOS } from "./scenarioRegistry";
import type { ScenarioKey } from "./scenarioRegistry";
import { storeC } from "../scenarioC/storeC";
import { useScenarioCState } from "../scenarioC/useScenarioCState";
import { LOS_COLORS } from "../scenarioC/decorator";
import type { TimeBlock, PricingStrategy } from "../scenarioC/types";
import { compareStore } from "../scenarioC/compareStore";
import { useCompareState } from "../scenarioC/useCompareState";
import { presentationStore } from "../scenarioC/presentationStore";
import { usePresentationState } from "../scenarioC/usePresentationState";
import { storeD } from "../scenarioD/storeD";
import { useScenarioDState } from "../scenarioD/useScenarioDState";
import { getLaneMenu, lanesClosedForType, computeClosureSim } from "../scenarioD/closurePhysics";
import { startPlayLoop, stopPlayLoop } from "../scenarioD/managerD";
import { simTicksForEvent } from "../scenarioD/storeD";
import type { ClosureEvent } from "../scenarioD/typesD";

const BANDS: RiskBand[] = ["red", "amber", "green"];
const fmt$ = (n: number) => `$${n.toLocaleString("en-US")}`;

function frameAsset(tag: string) {
  store.inspect(tag);
  const w = store.getSnapshot().worldByTag.get(tag);
  if (w) frameWorld(w, 120);
}
function frameSegment(id: string) {
  store.inspectSegment(id);
  const m = store.getSnapshot().segmentMidById.get(id);
  if (m) frameWorld(m, 260);
}

/* ----------------------------------- top bar ----------------------------------- */
function TopBar({
  scenario,
  onStartTour,
  dataOpen,
  onToggleData,
}: {
  scenario: ScenarioKey;
  onStartTour: () => void;
  dataOpen: boolean;
  onToggleData: () => void;
}) {
  return (
    <div className="sd-top">
      <div className="sd-brand">
        SuperDNA<span className="sub">I-595 Express · Operational Twin</span>
      </div>
      <div className="sd-tabs">
        {ALL_SCENARIOS.map((key) => (
          <button
            key={key}
            className={`sd-tab ${scenario === key ? "active" : ""}`}
            onClick={() => store.setScenario(key)}
          >
            {SCENARIO_REGISTRY[key].tabLabel}
          </button>
        ))}
      </div>
      <div className="spacer" />
      {/* DataSourceSwitcher supports A, B, and C */}
      {(scenario === "A" || scenario === "B" || scenario === "C") && (
        <DataSourceSwitcher scenario={scenario} dataOpen={dataOpen} onToggleData={onToggleData} />
      )}
      <button className="tour-fab" onClick={onStartTour}>● Take a tour</button>
    </div>
  );
}

/* ----------------------------------- left list ----------------------------------- */
function Legend({ scenario }: { scenario: ScenarioKey }) {
  if (scenario === "C" || scenario === "D") return null; // C/D have no risk-band legend
  const meta = scenario === "A" ? bandMeta : segBandMeta;
  return (
    <div className="sd-legend-row">
      {BANDS.map((b) => (
        <span key={b}>
          <span className="sd-dot" style={{ background: meta(b).color }} />
          {meta(b).label}
        </span>
      ))}
    </div>
  );
}

/* ---- Scenario A left list ---- */
function AssetLeftList({
  q,
  band,
  setBand,
}: {
  q: string;
  band: RiskBand | "all";
  setBand: (b: RiskBand | "all") => void;
}) {
  const s = useScenarioState();
  const ql = q.trim().toLowerCase();
  const assets = useMemo(
    () =>
      s.assets.filter(
        (a) =>
          (band === "all" || a.band === band) &&
          (ql === "" ||
            a.label.toLowerCase().includes(ql) ||
            a.asset_tag.toLowerCase().includes(ql))
      ),
    [s.assets, band, ql]
  );
  return (
    <>
      <div className="sd-chips">
        {(["all", ...BANDS] as const).map((b) => (
          <span
            key={b}
            className={`sd-chip ${band === b ? "on" : ""}`}
            onClick={() => setBand(b)}
          >
            {b === "all" ? "All" : bandMeta(b).label}
          </span>
        ))}
      </div>
      <div className="sd-list">
        {assets.map((a) => (
          <div
            key={a.asset_tag}
            className={`sd-row ${s.inspectedTag === a.asset_tag ? "sel" : ""}`}
            onClick={() => frameAsset(a.asset_tag)}
          >
            <span className="sd-dot" style={{ background: bandMeta(a.band).color }} />
            <span className="nm">
              <div className="t">{a.label}</div>
              <div className="s">{a.asset_tag} · {a.asset_class.replace(/_/g, " ")}</div>
            </span>
            <span className="pct" style={{ color: bandMeta(a.band).color }}>
              {Math.round(a.score * 100)}%
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/* ---- Scenario B left list ---- */
function SegmentLeftList({
  q,
  band,
  setBand,
}: {
  q: string;
  band: RiskBand | "all";
  setBand: (b: RiskBand | "all") => void;
}) {
  const s = useScenarioState();
  const ql = q.trim().toLowerCase();
  const segments = useMemo(
    () =>
      s.segments.filter(
        (g) =>
          (band === "all" || g.band === band) &&
          (ql === "" ||
            g.name.toLowerCase().includes(ql) ||
            g.segment_id.toLowerCase().includes(ql))
      ),
    [s.segments, band, ql]
  );
  return (
    <>
      <div className="sd-chips">
        {(["all", ...BANDS] as const).map((b) => (
          <span
            key={b}
            className={`sd-chip ${band === b ? "on" : ""}`}
            onClick={() => setBand(b)}
          >
            {b === "all" ? "All" : segBandMeta(b).label}
          </span>
        ))}
      </div>
      <div className="sd-list">
        {segments.map((g) => (
          <div
            key={g.segment_id}
            className={`sd-row ${s.inspectedSegmentId === g.segment_id ? "sel" : ""}`}
            onClick={() => frameSegment(g.segment_id)}
          >
            <span className="sd-dot" style={{ background: segBandMeta(g.band).color }} />
            <span className="nm">
              <div className="t">{g.name}</div>
              <div className="s">{g.segment_id} · {g.stats.count} incidents</div>
            </span>
            <span className="pct" style={{ color: segBandMeta(g.band).color }}>
              {Math.round(g.score * 100)}%
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

const TIME_BLOCK_LABELS: Record<TimeBlock, string> = {
  morning_peak_eb: "Morning Peak EB",
  evening_peak_wb: "Evening Peak WB",
  off_peak: "Off-Peak",
  weekend: "Weekend",
};

const STRATEGY_LABELS: Record<PricingStrategy, string> = {
  current_static: "Current Static",
  moderate_variable: "Moderate Variable",
  aggressive: "Aggressive",
};

/* ---- Scenario C: Presentation mode controls ---- */
function PresentationControls() {
  const pres = usePresentationState();
  const currentStep = pres.timeLapseSteps[pres.currentStepIndex];

  return (
    <div style={{
      padding: "8px 14px",
      borderTop: "1px solid var(--sd-line)",
      background: pres.presentationMode ? "rgba(33,150,243,0.08)" : undefined,
    }}>
      {/* Presentation mode toggle */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: "var(--sd-dim)", flex: 1 }}>Presentation mode</span>
        <button
          style={{
            fontSize: 11, padding: "2px 10px", borderRadius: 4,
            border: "1px solid var(--sd-line)",
            background: pres.presentationMode ? "var(--sd-accent)" : "var(--sd-panel2)",
            color: pres.presentationMode ? "#fff" : "var(--sd-dim)",
            cursor: "pointer",
          }}
          onClick={() => presentationStore.setPresentationMode(!pres.presentationMode)}
        >
          {pres.presentationMode ? "ON" : "OFF"}
        </button>
      </div>

      {/* AM Peak time-lapse controls — only visible when presentation mode is ON */}
      {pres.presentationMode && (
        <div>
          <div style={{ fontSize: 11, color: "var(--sd-dim)", marginBottom: 4 }}>
            Play AM Peak time-lapse
          </div>
          {/* Step label */}
          <div style={{
            fontSize: 12, fontWeight: 600, color: "var(--sd-text)",
            marginBottom: 6,
            padding: "3px 6px",
            background: pres.tweenActive ? "rgba(33,150,243,0.15)" : "transparent",
            borderRadius: 3,
            transition: "background 0.3s ease",
          }}>
            {currentStep?.label ?? "—"}
          </div>
          {/* Step indicators */}
          <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
            {pres.timeLapseSteps.map((step, i) => (
              <div
                key={step.label}
                style={{
                  flex: 1, height: 4, borderRadius: 2,
                  background: i <= pres.currentStepIndex ? "var(--sd-accent)" : "var(--sd-line)",
                  transition: "background 0.4s ease",
                }}
              />
            ))}
          </div>
          {/* Play / Pause / Reset buttons */}
          <div style={{ display: "flex", gap: 6 }}>
            {pres.isPlaying ? (
              <button
                className="sd-btn"
                style={{ fontSize: 11, padding: "3px 10px", flex: 1 }}
                onClick={() => presentationStore.pause()}
              >
                ⏸ Pause
              </button>
            ) : (
              <button
                className="sd-btn primary"
                style={{ fontSize: 11, padding: "3px 10px", flex: 1 }}
                onClick={() => presentationStore.play()}
              >
                ▶ Play AM Peak
              </button>
            )}
            <button
              className="sd-btn"
              style={{ fontSize: 11, padding: "3px 8px" }}
              onClick={() => presentationStore.resetTimeLapse()}
              title="Reset to step 0"
            >
              ↺
            </button>
            <button
              className="sd-btn"
              style={{ fontSize: 11, padding: "3px 8px" }}
              onClick={() => presentationStore.stepForward()}
              title="Step forward (discrete beat)"
            >
              ⏭
            </button>
          </div>
          {/* Demand flow + safety pulsing toggles */}
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button
              style={{
                fontSize: 10, padding: "2px 8px", borderRadius: 4, flex: 1,
                border: "1px solid var(--sd-line)",
                background: pres.demandFlowActive ? "#1565c0" : "var(--sd-panel2)",
                color: pres.demandFlowActive ? "#fff" : "var(--sd-dim)",
                cursor: "pointer",
              }}
              onClick={() => presentationStore.setDemandFlowActive(!pres.demandFlowActive)}
            >
              Demand flow
            </button>
            <button
              style={{
                fontSize: 10, padding: "2px 8px", borderRadius: 4, flex: 1,
                border: "1px solid var(--sd-line)",
                background: pres.safetyFlagPulsing ? "#b71c1c" : "var(--sd-panel2)",
                color: pres.safetyFlagPulsing ? "#fff" : "var(--sd-dim)",
                cursor: "pointer",
              }}
              onClick={() => presentationStore.setSafetyFlagPulsing(!pres.safetyFlagPulsing)}
            >
              Safety pulse
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- Scenario C: Compare mode dual KPI panel ---- */
function ComparePanel() {
  const cmp = useCompareState();
  const { kpiA, kpiB, pricedSectionsA, pricedSectionsB } = cmp;

  return (
    <div style={{ padding: "10px 14px", borderTop: "1px solid var(--sd-line)" }}>
      <div style={{
        fontSize: 11, color: "var(--sd-dim)", textTransform: "uppercase",
        letterSpacing: "0.05em", marginBottom: 8
      }}>
        Compare · Strategy A vs B
      </div>
      {/* Strategy selectors */}
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, color: "var(--sd-dim)", marginBottom: 3 }}>Strategy A (left)</div>
          <div className="sd-chips" style={{ padding: 0 }}>
            {(["current_static", "moderate_variable", "aggressive"] as PricingStrategy[]).map((strat) => (
              <span
                key={strat}
                className={`sd-chip${cmp.strategyA === strat ? " on" : ""}`}
                onClick={() => compareStore.setStrategyA(strat)}
                style={{ fontSize: 9 }}
              >
                {strat === "current_static" ? "Static" : strat === "moderate_variable" ? "Moderate" : "Aggressive"}
              </span>
            ))}
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, color: "var(--sd-dim)", marginBottom: 3 }}>Strategy B (right)</div>
          <div className="sd-chips" style={{ padding: 0 }}>
            {(["current_static", "moderate_variable", "aggressive"] as PricingStrategy[]).map((strat) => (
              <span
                key={strat}
                className={`sd-chip${cmp.strategyB === strat ? " on" : ""}`}
                onClick={() => compareStore.setStrategyB(strat)}
                style={{ fontSize: 9 }}
              >
                {strat === "current_static" ? "Static" : strat === "moderate_variable" ? "Moderate" : "Aggressive"}
              </span>
            ))}
          </div>
        </div>
      </div>
      {/* Dual KPI strip */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {/* Strategy A KPIs */}
        <div style={{
          background: "var(--sd-panel2)", borderRadius: 6,
          border: "1px solid var(--sd-line)", padding: "8px"
        }}>
          <div style={{ fontSize: 10, color: "var(--sd-accent)", fontWeight: 700, marginBottom: 6 }}>
            Strategy A · {STRATEGY_LABELS[cmp.strategyA]}
          </div>
          <div style={{ fontSize: 11, marginBottom: 3 }}>
            <span style={{ color: kpiA.speedHeld ? "#4caf50" : "#f44336", fontWeight: 700 }}>
              {kpiA.speedHeld ? "✓" : "✗"}
            </span> Speed held
          </div>
          <div style={{ fontSize: 11, marginBottom: 3 }}>
            ${Math.round(kpiA.projectedRevenuePerHour).toLocaleString()}/hr
          </div>
          <div style={{ fontSize: 11, marginBottom: 3 }}>
            {(kpiA.corridorUtilization * 100).toFixed(0)}% util
          </div>
          <div style={{ fontSize: 11, color: kpiA.safetyFlagCount > 0 ? "#cc0000" : "#4caf50" }}>
            {kpiA.safetyFlagCount} safety flag{kpiA.safetyFlagCount !== 1 ? "s" : ""}
          </div>
          <div style={{ fontSize: 10, color: "var(--sd-dim)", marginTop: 4 }}>
            Trip total: ${kpiA.corridorTotalRate.toFixed(2)}
          </div>
          {/* Section rates */}
          <div style={{ borderTop: "1px solid var(--sd-line)", marginTop: 6, paddingTop: 4 }}>
            {pricedSectionsA.map((sec) => (
              <div key={sec.sectionId} style={{ fontSize: 10, display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: LOS_COLORS[sec.los] ?? "#888" }}>{sec.sectionId}</span>
                <span>${sec.postedRate.toFixed(2)} · LOS {sec.los}</span>
              </div>
            ))}
          </div>
        </div>
        {/* Strategy B KPIs */}
        <div style={{
          background: "var(--sd-panel2)", borderRadius: 6,
          border: "1px solid var(--sd-line)", padding: "8px"
        }}>
          <div style={{ fontSize: 10, color: "#ff9800", fontWeight: 700, marginBottom: 6 }}>
            Strategy B · {STRATEGY_LABELS[cmp.strategyB]}
          </div>
          <div style={{ fontSize: 11, marginBottom: 3 }}>
            <span style={{ color: kpiB.speedHeld ? "#4caf50" : "#f44336", fontWeight: 700 }}>
              {kpiB.speedHeld ? "✓" : "✗"}
            </span> Speed held
          </div>
          <div style={{ fontSize: 11, marginBottom: 3 }}>
            ${Math.round(kpiB.projectedRevenuePerHour).toLocaleString()}/hr
          </div>
          <div style={{ fontSize: 11, marginBottom: 3 }}>
            {(kpiB.corridorUtilization * 100).toFixed(0)}% util
          </div>
          <div style={{ fontSize: 11, color: kpiB.safetyFlagCount > 0 ? "#cc0000" : "#4caf50" }}>
            {kpiB.safetyFlagCount} safety flag{kpiB.safetyFlagCount !== 1 ? "s" : ""}
          </div>
          <div style={{ fontSize: 10, color: "var(--sd-dim)", marginTop: 4 }}>
            Trip total: ${kpiB.corridorTotalRate.toFixed(2)}
          </div>
          {/* Section rates */}
          <div style={{ borderTop: "1px solid var(--sd-line)", marginTop: 6, paddingTop: 4 }}>
            {pricedSectionsB.map((sec) => (
              <div key={sec.sectionId} style={{ fontSize: 10, display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: LOS_COLORS[sec.los] ?? "#888" }}>{sec.sectionId}</span>
                <span>${sec.postedRate.toFixed(2)} · LOS {sec.los}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Scenario C left list ---- */
function TollingLeftList() {
  const s = useScenarioCState();
  const cmp = useCompareState();

  // Sort sections by utilization (highest first) — mirrors Scenario B's risk-sorted list
  const sorted = [...s.pricedSections].sort((a, b) => b.utilization - a.utilization);

  return (
    <>
      {/* Controls: time-block selector + strategy presets */}
      <div style={{ padding: "10px 14px 4px", borderBottom: "1px solid var(--sd-line)" }}>
        <div style={{ fontSize: 11, color: "var(--sd-dim)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
          Time Block
        </div>
        <div className="sd-chips" style={{ padding: 0, marginBottom: 8 }}>
          {(["morning_peak_eb", "evening_peak_wb", "off_peak", "weekend"] as TimeBlock[]).map((b) => (
            <span
              key={b}
              className={`sd-chip${s.timeBlock === b ? " on" : ""}`}
              onClick={() => storeC.setTimeBlock(b)}
              style={{ fontSize: 10 }}
            >
              {TIME_BLOCK_LABELS[b]}
            </span>
          ))}
        </div>
        <div style={{ fontSize: 11, color: "var(--sd-dim)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
          Strategy
        </div>
        <div className="sd-chips" style={{ padding: 0, marginBottom: 6 }}>
          {(["current_static", "moderate_variable", "aggressive"] as PricingStrategy[]).map((strat) => (
            <span
              key={strat}
              className={`sd-chip${s.strategy === strat ? " on" : ""}`}
              onClick={() => storeC.setStrategy(strat)}
              style={{ fontSize: 10 }}
            >
              {STRATEGY_LABELS[strat]}
            </span>
          ))}
        </div>
        {/* Color-by toggle */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
          <span style={{ fontSize: 11, color: "var(--sd-dim)" }}>Color by:</span>
          <button
            style={{
              fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--sd-line)",
              background: s.colorMode === "los" ? "var(--sd-accent)" : "var(--sd-panel2)",
              color: s.colorMode === "los" ? "#fff" : "var(--sd-dim)", cursor: "pointer"
            }}
            onClick={() => storeC.setColorMode("los")}
          >
            LOS
          </button>
          <button
            style={{
              fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--sd-line)",
              background: s.colorMode === "rate" ? "var(--sd-accent)" : "var(--sd-panel2)",
              color: s.colorMode === "rate" ? "#fff" : "var(--sd-dim)", cursor: "pointer"
            }}
            onClick={() => storeC.setColorMode("rate")}
          >
            Rate
          </button>
        </div>
        {/* Compare mode toggle */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <span style={{ fontSize: 11, color: "var(--sd-dim)", flex: 1 }}>Compare A vs B</span>
          <button
            style={{
              fontSize: 11, padding: "2px 10px", borderRadius: 4,
              border: "1px solid var(--sd-line)",
              background: cmp.compareMode ? "#1565c0" : "var(--sd-panel2)",
              color: cmp.compareMode ? "#fff" : "var(--sd-dim)",
              cursor: "pointer",
            }}
            onClick={() => compareStore.setCompareMode(!cmp.compareMode)}
          >
            {cmp.compareMode ? "ON" : "OFF"}
          </button>
        </div>
        {/* Next recompute chip (static, 15-min cadence) */}
        <div style={{ fontSize: 11, color: "var(--sd-dim)", marginTop: 8, padding: "4px 0" }}>
          Next recompute · 15-min beat
        </div>
      </div>

      {/* Compare panel (shown when compareMode is ON) */}
      {cmp.compareMode && <ComparePanel />}

      {/* Express sections sorted by utilization */}
      <div className="sd-list">
        {sorted.map((sec) => {
          const color = LOS_COLORS[sec.los] ?? "#888";
          const isInspected = s.inspectedSectionId === sec.sectionId;
          const hasOverride = (s.overrides[sec.sectionId] !== undefined);
          return (
            <div
              key={sec.sectionId}
              className={`sd-row${isInspected ? " sel" : ""}`}
              onClick={() => storeC.inspectSection(isInspected ? null : sec.sectionId)}
            >
              <span className="sd-dot" style={{ background: color, border: sec.safetyFlag ? "2px solid #cc0000" : undefined }} />
              <span className="nm">
                <div className="t">
                  {sec.sectionId}
                  {hasOverride && (
                    <span style={{ fontSize: 10, color: "#ff9800", marginLeft: 6 }}>override</span>
                  )}
                  {sec.safetyFlag && (
                    <span style={{ fontSize: 10, color: "#cc0000", marginLeft: 6 }}>safety flag</span>
                  )}
                </div>
                <div className="s">
                  LOS {sec.los} · ${sec.postedRate.toFixed(2)} · {sec.density.toFixed(1)} veh/mi/ln
                </div>
              </span>
              <span className="pct" style={{ color }}>
                {Math.round(sec.utilization * 100)}%
              </span>
            </div>
          );
        })}
      </div>

      {/* Presentation mode controls (always at bottom of left list for Scenario C) */}
      <PresentationControls />
    </>
  );
}

/* ---- Scenario D — Lane Closure UI (M5: Concept A before/after) ---- */

function ClosureLeftList() {
  const s = useScenarioDState();
  const [segmentId, setSegmentId] = useState("SEG-CONN");
  const [closureType, setClosureType] = useState<"partial" | "controlflow" | "full">("partial");
  const [timeOfDay, setTimeOfDay] = useState<"pm_peak" | "off_peak">("pm_peak");
  const [durationMin, setDurationMin] = useState(60);
  const [rain, setRain] = useState(false);
  const [compare, setCompare] = useState(false);

  const menu = getLaneMenu(segmentId);
  const segLanes = menu[0]?.totalLanes ?? 2;
  const lanesClosed = lanesClosedForType(segmentId, closureType);

  const simulate = () => {
    storeD.setClosureEvent({
      segment_id: segmentId,
      lanesClosed,
      closureType,
      startMin: 0,
      durationMin,
      timeOfDay,
      ...(rain ? { weather: "rain" as const } : {}),
    });
  };

  const segStates = s.conceptASnapshot?.segmentStates ?? [];
  const lbl = {
    fontSize: 11, color: "var(--sd-dim)", textTransform: "uppercase" as const,
    letterSpacing: "0.05em", margin: "8px 0 4px",
  };

  return (
    <>
      <div data-testid="closure-event-builder" style={{ padding: "10px 14px", borderBottom: "1px solid var(--sd-line)" }}>
        <div style={lbl}>Segment</div>
        <select
          data-testid="closure-segment-select"
          value={segmentId}
          onChange={(e) => setSegmentId(e.target.value)}
          style={{ width: "100%", padding: "4px 6px", fontSize: 12, background: "var(--sd-panel2)", color: "var(--sd-text)", border: "1px solid var(--sd-line)", borderRadius: 4 }}
        >
          <option value="SEG-CONN">SEG-CONN — Express↔Turnpike connector</option>
        </select>

        <div style={lbl}>Closure type</div>
        <div className="sd-chips" style={{ padding: 0 }}>
          {([["partial", "Partial"], ["controlflow", "Controlflow"], ["full", "Full"]] as const).map(([t, label]) => (
            <button
              key={t}
              className={`sd-chip${closureType === t ? " on" : ""}`}
              onClick={() => setClosureType(t)}
            >
              {label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 10, color: "var(--sd-dim)", marginTop: 2 }}>
          {lanesClosed} of {segLanes} lane{segLanes > 1 ? "s" : ""} closed
        </div>

        <div style={lbl}>Time of day</div>
        <div className="sd-chips" style={{ padding: 0 }}>
          <button className={`sd-chip${timeOfDay === "pm_peak" ? " on" : ""}`} onClick={() => setTimeOfDay("pm_peak")}>PM Peak</button>
          <button className={`sd-chip${timeOfDay === "off_peak" ? " on" : ""}`} onClick={() => setTimeOfDay("off_peak")}>Off Peak</button>
        </div>

        <div style={lbl}>Duration · {durationMin / 60} {durationMin === 60 ? "hour" : "hours"}</div>
        <input
          type="range" min={1} max={8} step={1} value={durationMin / 60}
          onChange={(e) => setDurationMin(parseInt(e.target.value, 10) * 60)}
          style={{ width: "100%" }}
        />

        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--sd-dim)", marginTop: 8 }}>
          <input type="checkbox" checked={rain} onChange={(e) => setRain(e.target.checked)} /> Rain (capacity ×0.85)
        </label>

        <button
          onClick={simulate}
          style={{ width: "100%", marginTop: 10, padding: "7px 0", fontSize: 13, fontWeight: 600, color: "#fff", background: "var(--sd-accent)", border: "none", borderRadius: 5, cursor: "pointer" }}
        >
          Simulate
        </button>
      </div>

      <div className="sd-list">
        {segStates.length === 0 ? (
          <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--sd-dim)", fontStyle: "italic" }}>
            Configure a closure and press Simulate to model queue buildup, shockwave propagation, and
            the dynamic-toll + diversion response.
          </div>
        ) : (
          segStates.map((seg) => (
            <div key={seg.segmentId} className="sd-row">
              <span className="sd-dot" style={{ background: LOS_COLORS[seg.losBand] ?? "#888" }} />
              <span className="nm">
                <div className="t">{seg.segmentId}</div>
                <div className="s">LOS {seg.losBand} · {seg.speed.toFixed(0)} mph · {seg.queued ? "queued" : "free-flow"}</div>
              </span>
            </div>
          ))
        )}
      </div>

      <ClosureTimelineBar />

      {s.activeEvent && (
        <div style={{ padding: "6px 14px 0" }}>
          <button
            className={`sd-chip${compare ? " on" : ""}`}
            style={{ fontSize: 11 }}
            onClick={() => setCompare(!compare)}
          >
            {compare ? "Hide" : "Compare"} PM vs Off-peak
          </button>
        </div>
      )}
      {compare && s.activeEvent && <ClosureComparePanel event={s.activeEvent} />}
    </>
  );
}

/* G6 — compare two time windows: the active closure run at PM-peak vs off-peak, side by side. */
function ClosureComparePanel({ event }: { event: ClosureEvent }) {
  const pm = useMemo(() => {
    const e: ClosureEvent = { ...event, timeOfDay: "pm_peak" };
    return computeClosureSim(e, simTicksForEvent(e)).finalKpi;
  }, [event]);
  const off = useMemo(() => {
    const e: ClosureEvent = { ...event, timeOfDay: "off_peak" };
    return computeClosureSim(e, simTicksForEvent(e)).finalKpi;
  }, [event]);

  const Row = ({ label, a, b }: { label: string; a: string; b: string }) => (
    <div style={{ display: "flex", fontSize: 11, padding: "3px 0", borderBottom: "1px solid var(--sd-line)" }}>
      <span style={{ flex: 1, color: "var(--sd-dim)" }}>{label}</span>
      <span style={{ width: 66, textAlign: "right" }}>{a}</span>
      <span style={{ width: 66, textAlign: "right" }}>{b}</span>
    </div>
  );
  const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;

  return (
    <div data-testid="closure-compare" style={{ padding: "8px 14px 12px" }}>
      <div style={{ display: "flex", fontSize: 11, fontWeight: 600, marginBottom: 2 }}>
        <span style={{ flex: 1, color: "var(--sd-dim)" }}>Time window →</span>
        <span style={{ width: 66, textAlign: "right" }}>PM Peak</span>
        <span style={{ width: 66, textAlign: "right" }}>Off-Peak</span>
      </div>
      <Row label="Max queue" a={`${pm.maxQueueMi.toFixed(1)} mi`} b={`${off.maxQueueMi.toFixed(1)} mi`} />
      <Row label="Travel time" a={`${Math.round(pm.travelTimeMin)}m`} b={`${Math.round(off.travelTimeMin)}m`} />
      <Row label="Delay cost" a={usd(pm.delayCostUsd)} b={usd(off.delayCostUsd)} />
      <Row label="Clearance" a={`${Math.round(pm.clearanceMin)}m`} b={`${Math.round(off.clearanceMin)}m`} />
      <Row label="Net revenue" a={usd(pm.netRevenueUsd)} b={usd(off.netRevenueUsd)} />
    </div>
  );
}

/** Format a sim tick (dt = 30 s) as a corridor-clock H:MM (or Mm under an hour) string. */
function fmtSimClock(tick: number): string {
  const min = tick * 0.5; // 30 s per tick
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `${m}m`;
}

/* Concept B (M6) — play/pause/scrub timeline. The rAF loop lives in managerD; this only drives
   storeD actions + startPlayLoop/stopPlayLoop. Hidden until a closure event exists. */
function ClosureTimelineBar() {
  const s = useScenarioDState();
  if (!s.activeEvent) return null;
  const playing = s.playbackState === "playing";
  const toggle = () => {
    if (playing) { storeD.pause(); stopPlayLoop(); }
    else { storeD.play(); startPlayLoop(); }
  };
  const scrub = (n: number) => {
    if (playing) { storeD.pause(); stopPlayLoop(); }
    storeD.scrubTo(n);
  };
  const setSpeed = (mult: number) => {
    storeD.setPlaybackSpeed(mult);
    if (playing) { stopPlayLoop(); startPlayLoop(); } // re-pace the running loop immediately
  };
  return (
    <div style={{ padding: "8px 14px 10px", borderTop: "1px solid var(--sd-line)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          onClick={toggle}
          style={{ fontSize: 12, padding: "3px 10px", borderRadius: 4, border: "1px solid var(--sd-line)", background: playing ? "#1565c0" : "var(--sd-accent)", color: "#fff", cursor: "pointer", minWidth: 72 }}
        >
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <input
          type="range"
          min={0}
          max={s.maxTicks}
          value={s.tickIndex}
          onChange={(e) => scrub(parseInt(e.target.value, 10))}
          style={{ flex: 1 }}
        />
        <span style={{ fontSize: 11, color: "var(--sd-dim)", minWidth: 78, textAlign: "right" }}>
          T+{fmtSimClock(s.tickIndex)} / {fmtSimClock(s.maxTicks)}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
        <span style={{ fontSize: 11, color: "var(--sd-dim)" }}>Speed</span>
        {[1, 2, 4].map((m) => (
          <button
            key={m}
            className={`sd-chip${s.playbackSpeed === m ? " on" : ""}`}
            style={{ fontSize: 10, padding: "1px 7px" }}
            onClick={() => setSpeed(m)}
          >
            {m}×
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: "var(--sd-dim)" }}>
          Corridor clock · full closure window
        </span>
      </div>
    </div>
  );
}

function ClosureInspector() {
  const s = useScenarioDState();
  const playing = s.playbackState !== "idle";
  // During playback/scrub the inspector follows the current tick (live LOS, queue, economics);
  // when idle it's the Concept A before/after snapshot.
  const showAfter = playing || s.displayMode === "after";
  const snap = playing ? s.tickHistory[s.tickIndex] ?? null : s.conceptASnapshot;
  const segStates = snap?.segmentStates ?? [];
  const boq = snap?.backOfQueue;
  const k = playing ? s.tickHistory[s.tickIndex]?.kpis ?? s.kpi : s.kpi;
  const todLabel = s.activeEvent?.timeOfDay === "off_peak" ? "Off Peak" : "PM Peak";

  return (
    <div className="sd-insp">
      <h2>Lane Closure</h2>
      <div className="sub">
        {s.activeEvent
          ? `${s.activeEvent.segment_id} · ${s.activeEvent.lanesClosed} of 2 lanes · ${todLabel} · ${s.activeEvent.durationMin} min`
          : "No closure configured"}
      </div>

      {/* Before/After toggle — mirrors Scenario B countermeasure switch */}
      <div className="sd-chips" style={{ padding: "8px 0" }}>
        <button className={`sd-chip${!showAfter ? " on" : ""}`} onClick={() => storeD.setConceptAMode(false)}>Before</button>
        <button className={`sd-chip${showAfter ? " on" : ""}`} onClick={() => storeD.setConceptAMode(true)}>After</button>
      </div>

      {!s.activeEvent ? (
        <div className="empty">{SCENARIO_REGISTRY["D"].inspectorEmptyText}</div>
      ) : (
        <>
          <div data-testid="closure-inspector-los" style={{ marginTop: 4 }}>
            {showAfter ? (
              segStates.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--sd-dim)" }}>No affected segments.</div>
              ) : (
                segStates.map((seg) => (
                  <div key={seg.segmentId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 12 }}>
                    <span className="sd-dot" style={{ background: LOS_COLORS[seg.losBand] ?? "#888" }} />
                    <span style={{ flex: 1 }}>{seg.segmentId}</span>
                    <strong>LOS {seg.losBand}</strong>
                    <span style={{ color: "var(--sd-dim)" }}>{seg.speed.toFixed(0)} mph</span>
                  </div>
                ))
              )
            ) : (
              <div style={{ fontSize: 12, color: "var(--green)", padding: "4px 0" }}>
                Open road — all segments free-flow (LOS A, ≥ 55 mph).
              </div>
            )}
          </div>

          {showAfter && boq && (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              <strong style={{ color: LOS_COLORS["F"] }}>Back of queue: {boq.lengthMi.toFixed(1)} mi</strong>
            </div>
          )}

          {/* Two co-equal economics lines — distinct formulas (§8-fix-6) */}
          <div style={{ marginTop: 12, borderTop: "1px solid var(--sd-line)", paddingTop: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>Delay cost (cumulative)</span>
              <strong data-testid="kpi-delay-cost">${Math.round(k.delayCostUsd).toLocaleString()}</strong>
            </div>
            <div style={{ color: "var(--sd-dim)", fontSize: 10, marginBottom: 8 }}>running total: vehicle-hours of delay × value-of-time</div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>Express revenue protected</span>
              <strong data-testid="kpi-express-revenue" className="green">${Math.round(k.expressRevenueProtectedUsd).toLocaleString()}</strong>
            </div>
            <div style={{ color: "var(--sd-dim)", fontSize: 10 }}>dynamic-toll pricing-response upside</div>

            {/* Dynamic-pricing toggle → net revenue position (links to Scenario 3 pricing logic) */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10 }}>
              <span style={{ fontSize: 12, flex: 1 }}>Dynamic pricing</span>
              <button className={`sd-chip${s.dynamicPricing ? " on" : ""}`} onClick={() => storeD.setDynamicPricing(true)}>On</button>
              <button className={`sd-chip${!s.dynamicPricing ? " on" : ""}`} onClick={() => storeD.setDynamicPricing(false)}>Off (static)</button>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginTop: 8, borderTop: "1px solid var(--sd-line)", paddingTop: 8 }}>
              <strong>Net revenue position</strong>
              <strong style={{ color: k.netRevenueUsd >= 0 ? "var(--green)" : "var(--red)" }}>
                {k.netRevenueUsd >= 0 ? "+" : "−"}${Math.abs(Math.round(k.netRevenueUsd)).toLocaleString()}
              </strong>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--sd-dim)", marginTop: 6 }}>
              <span>Recovery / clearance</span>
              <span>{Math.round(k.clearanceMin)} min</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function KpiBarD() {
  const s = useScenarioDState();
  const has = s.activeEvent !== null;
  // During playback/scrub, show the CURRENT tick's KPIs so the counters climb with the queue;
  // when idle, show the peak/final KPIs (the Concept A summary).
  const k = s.playbackState !== "idle" ? s.tickHistory[s.tickIndex]?.kpis ?? s.kpi : s.kpi;
  const risk = k.secondaryIncidentRisk < 0.34
    ? { l: "Low", c: "var(--green)" }
    : k.secondaryIncidentRisk < 0.67
    ? { l: "Elevated", c: "var(--amber)" }
    : { l: "High", c: "var(--red)" };
  return (
    <div className="sd-kpi">
      <div className="item" data-testid="kpi-max-queue">
        <div className="v" style={{ color: k.maxQueueMi > 0 ? "var(--red)" : "var(--sd-dim)" }}>
          {has ? `${k.maxQueueMi.toFixed(1)} mi` : "—"}
        </div>
        <div className="l">Max queue</div>
      </div>
      <div className="item">
        <div className="v">{has ? `${Math.round(k.travelTimeMin)} min` : "—"}</div>
        <div className="l">Travel time</div>
      </div>
      <div className="item">
        <div className="v" style={{ color: k.divertedVph > 0 ? "var(--amber)" : "var(--sd-dim)" }}>
          {has ? `${Math.round(k.divertedVph).toLocaleString()} vph` : "—"}
        </div>
        <div className="l">Diverted → SR-84</div>
      </div>
      <div className="item">
        <div className="v">{has ? `$${Math.round(k.delayRateUsdPerHr).toLocaleString()}/hr` : "—"}</div>
        <div className="l">Delay cost rate</div>
      </div>
      <div className="item">
        <div className="v" style={{ color: has ? risk.c : "var(--sd-dim)" }}>{has ? risk.l : "—"}</div>
        <div className="l">Incident risk</div>
      </div>
      <div className="note">I-595 Express · lane-closure impact · dynamic-tolling response</div>
    </div>
  );
}

function LeftPanel({ scenario, onCollapse }: { scenario: ScenarioKey; onCollapse: () => void }) {
  const [q, setQ] = useState("");
  const [band, setBand] = useState<RiskBand | "all">("all");
  const reg = SCENARIO_REGISTRY[scenario];

  return (
    <div className="sd-left">
      <div className="sd-panel-h">
        <button className="sd-collapse" title="Collapse" onClick={onCollapse}>‹</button>
        <h3>
          {scenario === "A" ? "ITS Assets" : scenario === "B" ? "Corridor Segments" : scenario === "C" ? "Express Sections" : "Lane Closure"}
        </h3>
        <Legend scenario={scenario} />
      </div>
      {scenario !== "C" && scenario !== "D" && (
        <div className="sd-filter">
          <input
            placeholder={reg.leftEmptyText}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      )}
      {scenario === "A" && <AssetLeftList q={q} band={band} setBand={setBand} />}
      {scenario === "B" && <SegmentLeftList q={q} band={band} setBand={setBand} />}
      {scenario === "C" && <TollingLeftList />}
      {scenario === "D" && <ClosureLeftList />}
    </div>
  );
}

/* ----------------------------------- inspector ----------------------------------- */
function AssetInspector({ asset }: { asset: ScoredAsset }) {
  const s = useScenarioState();
  const isIn = s.packageTags.includes(asset.asset_tag);
  const m = bandMeta(asset.band);
  return (
    <div className="sd-insp">
      <h2>{asset.label}</h2>
      <div className="sub">{asset.asset_tag} · {asset.location_desc}</div>

      <div className="sd-sec">
        <h4>Predicted failure risk</h4>
        <span className="sd-big" style={{ color: m.color }}>{Math.round(asset.score * 100)}%</span>{" "}
        <span className="sd-chiprisk" style={{ background: m.color }}>{m.label}</span>
      </div>

      {asset.drivers.length > 0 && (
        <div className="sd-sec">
          <h4>Why it&apos;s at risk</h4>
          {asset.drivers.map((d) => (<div className="sd-driver" key={d.key}>• {d.label}</div>))}
        </div>
      )}

      <div className="sd-sec">
        <h4>Recommended action</h4>
        <div className="sd-action">{asset.recommendedAction}</div>
      </div>

      <div className="sd-sec">
        <h4>Asset</h4>
        <dl className="sd-meta">
          <dt>Class</dt><dd>{asset.asset_class.replace(/_/g, " ")}</dd>
          <dt>Condition</dt>
          <dd style={{ color: bandMeta(asset.band).color }}>{conditionLabel(asset.band)}</dd>
          <dt>Age vs. rated life</dt>
          <dd>
            {ageYears(asset.install_date)} / {asset.expected_life_years} yr
            {" "}({Math.round((ageYears(asset.install_date) / asset.expected_life_years) * 100)}%)
          </dd>
          <dt>Installed</dt><dd>{asset.install_date}</dd>
          <dt>Last inspection</dt><dd>{asset.last_inspection_date}</dd>
          <dt>Last work order</dt><dd>{asset.last_workorder_date}</dd>
          <dt>Open tickets</dt><dd>{asset.open_tickets}</dd>
        </dl>
      </div>

      {asset.history.length > 0 && (
        <div className="sd-sec">
          <h4>History</h4>
          <ul className="sd-tl">
            {asset.history.slice(0, 5).map((h, i) => (
              <li key={i}>
                <span className="when">{h.date}</span>
                <span className="ty">{h.type.replace(/_/g, " ")}</span> — {h.description}
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        className={`sd-btn ${isIn ? "added" : "primary"}`}
        onClick={() => store.togglePackage(asset.asset_tag)}
      >
        {isIn ? "✓ In proactive work package" : "＋ Add to work package"}
      </button>
    </div>
  );
}

function WorkPackagePanel({ assets }: { assets: ScoredAsset[] }) {
  const wp = useMemo(() => computeWorkPackage(assets), [assets]);
  return (
    <div className="sd-insp" style={{ borderTop: "1px solid var(--sd-line)" }}>
      <div className="sd-sec">
        <h4>Proactive work package · {wp.count} assets</h4>
        <div className="sd-kpis">
          <div className="sd-kpibox"><div className="v green">{wp.closuresAvoided}</div><div className="l">closures avoided</div></div>
          <div className="sd-kpibox"><div className="v">{wp.crewHoursSaved}h</div><div className="l">crew saved</div></div>
          <div className="sd-kpibox"><div className="v green">{fmt$(wp.revenueProtected)}</div><div className="l">revenue protected</div></div>
        </div>
        <div style={{ fontSize: 12, color: "var(--sd-dim)", margin: "8px 0", lineHeight: 1.45 }}>
          {wp.closuresSeparate} emergency closures → 1 planned window.
        </div>
        <button className="sd-btn primary" onClick={() => store.clearPackage()}>Clear selection</button>
      </div>
    </div>
  );
}

function SegmentInspector({ segment }: { segment: ScoredSegment }) {
  const treated = store.isTreated(segment.segment_id) && !!segment.delta;
  const band = treated && segment.delta ? segment.delta.afterBand : segment.band;
  const score = treated && segment.delta ? segment.delta.afterScore : segment.score;
  const m = segBandMeta(band);
  const cm = segment.recommended;
  const d = segment.delta;
  const FACTOR: Record<string, string> = {
    queue_spillback: "Queue spillback", merge_geometry: "Merge geometry",
    lighting: "Lighting", speed: "Speed", wet_pavement: "Wet pavement",
  };
  return (
    <div className="sd-insp">
      <h2>{segment.name}</h2>
      <div className="sub">{segment.segment_id} · {segment.stats.count} incidents / 24 mo</div>

      <div className="sd-sec">
        <h4>Safety risk {treated ? "(after countermeasure)" : ""}</h4>
        <span className="sd-big" style={{ color: m.color }}>{Math.round(score * 100)}%</span>{" "}
        <span className="sd-chiprisk" style={{ background: m.color }}>{m.label}</span>
      </div>

      {!treated && (
        <>
          <div className="sd-sec">
            <h4>Incident profile · 24 mo</h4>
            <dl className="sd-meta">
              <dt>Crashes / year</dt><dd>{(segment.stats.count / 2).toFixed(1)}</dd>
              <dt>Injury / serious</dt><dd>{segment.stats.injuries} / {segment.stats.serious}</dd>
              <dt>Dominant type</dt><dd>{segment.stats.dominantType.replace(/_/g, " ")}</dd>
              <dt>Lane-closure burden</dt><dd>{Math.round(segment.stats.closureMin / 60)} hrs</dd>
              <dt>Most recent</dt><dd>{segment.incidents[0]?.date ?? "—"}</dd>
            </dl>
          </div>
          <div className="sd-sec">
            <h4>Contributing factors</h4>
            <div className="sd-tags">
              {segment.stats.factors.map((f) => (<span className="sd-tagchip" key={f}>{FACTOR[f] ?? f}</span>))}
            </div>
          </div>
          {segment.incidents.length > 0 && (
            <div className="sd-sec">
              <h4>Recent incidents</h4>
              <ul className="sd-tl">
                {segment.incidents.slice(0, 5).map((i, k) => (
                  <li key={i.incident_id ?? k}>
                    <span className="when">{i.date}</span>
                    <span className="ty">{i.type.replace(/_/g, " ")}</span> — {i.severity}
                    {i.lane_closure_min ? ` · ${i.lane_closure_min}m closure` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {treated && d && (
        <div className="sd-sec">
          <div className="sd-kpis">
            <div className="sd-kpibox"><div className="v green">{d.crashesAvoided}</div><div className="l">crashes avoided</div></div>
            <div className="sd-kpibox"><div className="v">{d.closureHoursAvoided}h</div><div className="l">closures avoided</div></div>
            <div className="sd-kpibox"><div className="v green">{fmt$(d.revenueProtected)}</div><div className="l">revenue protected</div></div>
          </div>
        </div>
      )}

      {cm && (
        <div className="sd-sec">
          <h4>Countermeasure — {cm.short}</h4>
          <div className="sd-toggle">
            <button className={!treated ? "on" : ""} onClick={() => { if (treated) store.toggleTreated(segment.segment_id); }}>Before</button>
            <button className={treated ? "on after" : ""} onClick={() => { if (!treated) store.toggleTreated(segment.segment_id); }}>After</button>
          </div>
          <div className="sd-action" style={{ marginTop: 8 }}>
            {cm.name} — {Math.round(cm.reduction * 100)}% reduction · {fmt$(cm.cost_usd)} · {cm.install_days}d
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- Scenario C inspector (full) ---- */
function TollingInspector() {
  const s = useScenarioCState();
  const section = s.inspectedSectionId
    ? s.pricedSections.find((p) => p.sectionId === s.inspectedSectionId)
    : null;

  if (!section) {
    return (
      <div className="sd-insp">
        <div className="empty">{SCENARIO_REGISTRY["C"].inspectorEmptyText}</div>
        {/* Corridor-total readout always visible */}
        <div style={{ borderTop: "1px solid var(--sd-line)", padding: "14px" }}>
          <div style={{ fontSize: 11, color: "var(--sd-dim)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
            Corridor Trip Total
          </div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "var(--sd-text)" }}>
            ${s.kpi.corridorTotalRate.toFixed(2)}
          </div>
          <div style={{ fontSize: 11, color: "var(--sd-dim)" }}>Sum of 3 section posted rates</div>
        </div>
      </div>
    );
  }

  const hasOverride = s.overrides[section.sectionId] !== undefined;
  const overrideValue = s.overrides[section.sectionId] ?? section.postedRate;
  const algorithmCap = 3.00;
  const isOverOverride = hasOverride && overrideValue > algorithmCap;
  const color = LOS_COLORS[section.los] ?? "#888";

  return (
    <div className="sd-insp">
      <h2 style={{ marginBottom: 2 }}>{section.sectionId}</h2>
      <div className="sub" style={{ color: "var(--sd-dim)", fontSize: 12, marginBottom: 12 }}>
        Express lane · {s.timeBlock.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} ·
        {" "}{STRATEGY_LABELS[s.strategy]}
      </div>

      {/* LOS band + density */}
      <div className="sd-sec">
        <h4>LOS / Density</h4>
        <div style={{ display: "flex", gap: 16, alignItems: "baseline" }}>
          <span
            className="sd-big"
            style={{ color, fontSize: 28, fontWeight: 800, minWidth: 40 }}
          >
            {section.los}
          </span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{section.density.toFixed(1)} veh/mi/ln</div>
            <div style={{ fontSize: 12, color: "var(--sd-dim)" }}>{section.speed} mph</div>
          </div>
        </div>
      </div>

      {/* Rate display: posted vs proposed */}
      <div className="sd-sec">
        <h4>Toll Rate</h4>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 12, color: "var(--sd-dim)" }}>Posted (locked)</div>
            <div style={{ fontSize: 20, fontWeight: 800 }}>${section.postedRate.toFixed(2)}</div>
          </div>
          {hasOverride && (
            <>
              <div style={{ color: "var(--sd-dim)", fontSize: 18 }}>→</div>
              <div>
                <div style={{ fontSize: 12, color: "#ff9800" }}>
                  Proposed {isOverOverride ? "(override)" : ""}
                </div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#ff9800" }}>
                  ${overrideValue.toFixed(2)}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Traffic metrics */}
      <div className="sd-sec">
        <h4>Traffic</h4>
        <dl className="sd-meta">
          <dt>Section volume</dt>
          <dd>{Math.round(section.volume).toLocaleString()} veh/hr</dd>
          <dt>Density</dt>
          <dd>{section.density.toFixed(1)} veh/mi/ln</dd>
          <dt>Speed</dt>
          <dd>{section.speed} mph</dd>
          <dt>Utilization</dt>
          <dd>{(section.utilization * 100).toFixed(1)}%</dd>
        </dl>
      </div>

      {/* Demand shift */}
      <div className="sd-sec">
        <h4>Demand Response</h4>
        <dl className="sd-meta">
          <dt>Demand retained</dt>
          <dd>{(section.demandRetained * 100).toFixed(0)}%</dd>
          <dt>Predicted shed</dt>
          <dd>{Math.round(section.shedVehicles).toLocaleString()} veh/hr</dd>
          <dt>Revenue / hr</dt>
          <dd>${Math.round(section.revenuePerHour).toLocaleString()}</dd>
        </dl>
      </div>

      {/* Safety flag */}
      {section.safetyFlag && (
        <div className="sd-sec" style={{ background: "#2a1010", borderRadius: 6, padding: "8px 10px" }}>
          <div style={{ color: "#cc0000", fontWeight: 700, marginBottom: 4 }}>Safety Flag</div>
          <div style={{ fontSize: 12, color: "#ff9090", lineHeight: 1.5 }}>
            Demand shift from this pricing scenario increases volume on the connected mainline
            ({(section.connectedMainlineUtilization * 100).toFixed(0)}% util) which has elevated safety risk.
            Review before applying.
          </div>
        </div>
      )}

      {/* Override slider ($0.50–$10.00) */}
      <div className="sd-sec">
        <h4>
          Override Rate
          {isOverOverride && (
            <span style={{ fontSize: 11, color: "#ff9800", marginLeft: 8 }}>
              above algorithm cap ($3.00)
            </span>
          )}
        </h4>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "var(--sd-dim)" }}>$0.50</span>
          <input
            type="range"
            min={0.50}
            max={10.00}
            step={0.25}
            value={overrideValue}
            onChange={(e) => storeC.setOverride(section.sectionId, parseFloat(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 11, color: "var(--sd-dim)" }}>$10.00</span>
        </div>
        <div style={{ textAlign: "center", fontWeight: 700, marginTop: 4 }}>
          ${overrideValue.toFixed(2)}
        </div>
        {hasOverride && (
          <button
            className="sd-btn"
            style={{ marginTop: 6, fontSize: 11, padding: "4px 10px" }}
            onClick={() => storeC.clearOverride(section.sectionId)}
          >
            Reset to algorithm rate
          </button>
        )}
      </div>

      {/* Corridor-total readout */}
      <div style={{ borderTop: "1px solid var(--sd-line)", padding: "10px 0 0" }}>
        <div style={{ fontSize: 11, color: "var(--sd-dim)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>
          Corridor Trip Total (3 sections)
        </div>
        <div style={{ fontSize: 20, fontWeight: 800 }}>${s.kpi.corridorTotalRate.toFixed(2)}</div>
      </div>

      {/* Closure teaser card (non-interactive) */}
      <div style={{
        marginTop: 14, borderRadius: 6, border: "1px solid var(--sd-line)",
        padding: "10px 12px", background: "var(--sd-panel2)"
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--sd-dim)", marginBottom: 4 }}>
          Combined value preview
        </div>
        <div style={{ fontSize: 12, color: "var(--sd-dim)", lineHeight: 1.5 }}>
          Full closure + pricing sim ships with Scenario 4 (Lane Closure).
          Same LOS table, demand-shift, and safety-flag math — pricing recovering revenue during a disruption.
        </div>
      </div>
    </div>
  );
}

function RightPanel({ scenario, onCollapse }: { scenario: ScenarioKey; onCollapse: () => void }) {
  const s = useScenarioState();
  const asset = s.inspectedTag ? s.assets.find((a) => a.asset_tag === s.inspectedTag) : undefined;
  const seg = s.inspectedSegmentId ? s.segments.find((g) => g.segment_id === s.inspectedSegmentId) : undefined;
  const pkg = s.assets.filter((a) => s.packageTags.includes(a.asset_tag));

  const head = (
    <div className="sd-insp-head">
      <span>Inspector</span>
      <button className="sd-collapse" title="Collapse" onClick={onCollapse}>›</button>
    </div>
  );

  if (scenario === "A") {
    return (
      <div className="sd-right">
        {head}
        {asset ? <AssetInspector asset={asset} /> : (
          <div className="sd-insp"><div className="empty">{SCENARIO_REGISTRY["A"].inspectorEmptyText}</div></div>
        )}
        {pkg.length > 0 && <WorkPackagePanel assets={pkg} />}
      </div>
    );
  }
  if (scenario === "B") {
    return (
      <div className="sd-right">
        {head}
        {seg ? <SegmentInspector segment={seg} /> : (
          <div className="sd-insp"><div className="empty">{SCENARIO_REGISTRY["B"].inspectorEmptyText}</div></div>
        )}
      </div>
    );
  }
  // Scenario C
  if (scenario === "C") {
    return (
      <div className="sd-right">
        {head}
        <TollingInspector />
      </div>
    );
  }
  // Scenario D — M0 stub
  return (
    <div className="sd-right">
      {head}
      <ClosureInspector />
    </div>
  );
}

/* ----------------------------------- KPI bar ----------------------------------- */
function KpiBarA() {
  const s = useScenarioState();
  const reds = s.assets.filter((a) => a.band === "red");
  const watch = s.assets.filter((a) => a.band === "amber").length;
  const wp = computeWorkPackage(reds);
  return (
    <div className="sd-kpi">
      <div className="item"><div className="v" style={{ color: "var(--red)" }}>{reds.length}</div><div className="l">Act now</div></div>
      <div className="item"><div className="v" style={{ color: "var(--amber)" }}>{watch}</div><div className="l">Watch</div></div>
      <div className="item"><div className="v green">{wp.closuresAvoided}</div><div className="l">Closures avoidable (proactive)</div></div>
      <div className="item"><div className="v green">{fmt$(wp.revenueProtected)}</div><div className="l">Toll revenue protected</div></div>
      <div className="note">Synthetic data · scores from config · placement: {s.placementMode}</div>
    </div>
  );
}

function KpiBarB() {
  const s = useScenarioState();
  const reds = s.segments.filter((g) => g.band === "red").length;
  const incidents = s.segments.reduce((n, g) => n + g.stats.count, 0);
  const injuries = s.segments.reduce((n, g) => n + g.stats.injuries, 0);
  const revenue = s.segments.reduce((n, g) => n + (g.delta?.revenueProtected ?? 0), 0);
  return (
    <div className="sd-kpi">
      <div className="item"><div className="v" style={{ color: "var(--red)" }}>{reds}</div><div className="l">High-risk segments</div></div>
      <div className="item"><div className="v">{incidents}</div><div className="l">Incidents / 24 mo</div></div>
      <div className="item"><div className="v" style={{ color: "var(--amber)" }}>{injuries}</div><div className="l">Injury+ crashes</div></div>
      <div className="item"><div className="v green">{fmt$(revenue)}</div><div className="l">Revenue protected (countermeasures)</div></div>
      <div className="note">Synthetic data · before/after from countermeasure catalog</div>
    </div>
  );
}

/* ---- Scenario C KPI bar (4 co-equal tiles: Speed | Revenue | Utilization | Safety) ---- */
function KpiBarC() {
  const s = useScenarioCState();
  const { kpi } = s;
  return (
    <div className="sd-kpi">
      {/* Tile 1: Speed held (mandated metric leads) */}
      <div className="item">
        <div className="v" style={{ color: kpi.speedHeld ? "var(--green)" : "var(--red)" }}>
          {kpi.speedHeld ? "✓" : "✗"} {kpi.speedHeld ? "≥45 mph" : "<45 mph"}
        </div>
        <div className="l">Speed held</div>
      </div>
      {/* Tile 2: Projected revenue / hr (co-equal) */}
      <div className="item">
        <div className="v green">${Math.round(kpi.projectedRevenuePerHour).toLocaleString()}/hr</div>
        <div className="l">Projected revenue</div>
      </div>
      {/* Tile 3: Corridor utilization (co-equal) */}
      <div className="item">
        <div className="v" style={{ color: kpi.corridorUtilization > 0.90 ? "var(--amber)" : "var(--sd-text)" }}>
          {(kpi.corridorUtilization * 100).toFixed(0)}%
        </div>
        <div className="l">Corridor utilization</div>
      </div>
      {/* Tile 4: Safety flags (co-equal) */}
      <div className="item">
        <div className="v" style={{ color: kpi.safetyFlagCount > 0 ? "var(--red)" : "var(--green)" }}>
          {kpi.safetyFlagCount}
        </div>
        <div className="l">Safety flags</div>
      </div>
      <div className="note">
        Dynamic Tolling · {TIME_BLOCK_LABELS[s.timeBlock]} · {STRATEGY_LABELS[s.strategy]} ·
        {" "}Trip total ${kpi.corridorTotalRate.toFixed(2)} · Synthetic data
      </div>
    </div>
  );
}

function KpiBar({ scenario }: { scenario: ScenarioKey }) {
  if (scenario === "A") return <KpiBarA />;
  if (scenario === "B") return <KpiBarB />;
  if (scenario === "D") return <KpiBarD />;
  return <KpiBarC />;
}

/* ----------------------------------- shell ----------------------------------- */
function Rail({ side, label, onExpand }: { side: "left" | "right"; label: string; onExpand: () => void }) {
  return (
    <div className={`sd-rail ${side}`} onClick={onExpand} title={`Expand ${label}`}>
      <span className="chev">{side === "left" ? "›" : "‹"}</span>
      <span className="vlabel">{label}</span>
    </div>
  );
}

export function Shell({ viewer }: { viewer: ReactNode }) {
  const { scenario } = useScenarioState();
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [tourOpen, setTourOpen] = useState(() => shouldAutoStartTour());
  const [dataOpen, setDataOpen] = useState(false);
  const gridTemplateColumns = `${leftOpen ? 312 : 34}px 1fr ${rightOpen ? 360 : 34}px`;

  const reg = SCENARIO_REGISTRY[scenario];

  return (
    <div className="shell" style={{ gridTemplateColumns }}>
      <TopBar
        scenario={scenario}
        onStartTour={() => setTourOpen(true)}
        dataOpen={dataOpen}
        onToggleData={() => setDataOpen((v) => !v)}
      />
      {leftOpen ? (
        <LeftPanel scenario={scenario} onCollapse={() => setLeftOpen(false)} />
      ) : (
        <div className="sd-left" style={{ gridArea: "left" }}>
          <Rail side="left" label={reg.leftRailLabel} onExpand={() => setLeftOpen(true)} />
        </div>
      )}
      <div className="sd-viewer">
        {viewer}
        {dataOpen && (scenario === "A" || scenario === "B" || scenario === "C") && (
          <DataTablePanel scenario={scenario} onClose={() => setDataOpen(false)} />
        )}
      </div>
      {rightOpen ? (
        <RightPanel scenario={scenario} onCollapse={() => setRightOpen(false)} />
      ) : (
        <div className="sd-right" style={{ gridArea: "right" }}>
          <Rail side="right" label="INSPECTOR" onExpand={() => setRightOpen(true)} />
        </div>
      )}
      <KpiBar scenario={scenario} />
      {tourOpen && <GuidedTour onClose={() => setTourOpen(false)} />}
    </div>
  );
}
