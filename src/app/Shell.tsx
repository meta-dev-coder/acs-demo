/*---------------------------------------------------------------------------------------------
 * Operational-twin app shell. The iTwin Viewer is the hero panel; around it sit a filterable
 * asset/segment list (left), a detail inspector (right), scenario tabs (top), and a KPI bar
 * (bottom). Selection is linked both ways via the shared store: click a list row -> frame in
 * the viewer; click in the viewer -> the row highlights and the inspector updates.
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
function TopBar({ scenario, onStartTour }: { scenario: "A" | "B"; onStartTour: () => void }) {
  return (
    <div className="sd-top">
      <div className="sd-brand">
        SuperDNA<span className="sub">I-595 Express · Operational Twin</span>
      </div>
      <div className="sd-tabs">
        <button
          className={`sd-tab ${scenario === "A" ? "active" : ""}`}
          onClick={() => store.setScenario("A")}
        >
          Asset Reliability
        </button>
        <button
          className={`sd-tab ${scenario === "B" ? "active" : ""}`}
          onClick={() => store.setScenario("B")}
        >
          Safety Hotspots
        </button>
      </div>
      <div className="spacer" />
      <button className="tour-fab" onClick={onStartTour}>● Take a tour</button>
      <span style={{ color: "var(--sd-dim)", fontSize: 12, marginLeft: 14 }}>ACS · I-595 Express LLC</span>
    </div>
  );
}

/* ----------------------------------- left list ----------------------------------- */
function Legend({ scenario }: { scenario: "A" | "B" }) {
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

function LeftPanel({ scenario, onCollapse }: { scenario: "A" | "B"; onCollapse: () => void }) {
  const s = useScenarioState();
  const [q, setQ] = useState("");
  const [band, setBand] = useState<RiskBand | "all">("all");

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
  const segments = useMemo(
    () =>
      s.segments.filter(
        (g) =>
          (band === "all" || g.band === band) &&
          (ql === "" || g.name.toLowerCase().includes(ql) || g.segment_id.toLowerCase().includes(ql))
      ),
    [s.segments, band, ql]
  );
  const meta = scenario === "A" ? bandMeta : segBandMeta;

  return (
    <div className="sd-left">
      <div className="sd-panel-h">
        <button className="sd-collapse" title="Collapse" onClick={onCollapse}>‹</button>
        <h3>{scenario === "A" ? "ITS Assets" : "Corridor Segments"}</h3>
        <Legend scenario={scenario} />
      </div>
      <div className="sd-filter">
        <input
          placeholder={scenario === "A" ? "Search assets…" : "Search segments…"}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="sd-chips">
        {(["all", ...BANDS] as const).map((b) => (
          <span
            key={b}
            className={`sd-chip ${band === b ? "on" : ""}`}
            onClick={() => setBand(b)}
          >
            {b === "all" ? "All" : meta(b).label}
          </span>
        ))}
      </div>
      <div className="sd-list">
        {scenario === "A" &&
          assets.map((a) => (
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
        {scenario === "B" &&
          segments.map((g) => (
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
        <div style={{ fontSize: 11.5, color: "var(--sd-dim)", margin: "8px 0" }}>
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

function RightPanel({ scenario, onCollapse }: { scenario: "A" | "B"; onCollapse: () => void }) {
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
          <div className="sd-insp"><div className="empty">Select an ITS asset — on the model or in the list — to see its failure risk, drivers, and recommended action.</div></div>
        )}
        {pkg.length > 0 && <WorkPackagePanel assets={pkg} />}
      </div>
    );
  }
  return (
    <div className="sd-right">
      {head}
      {seg ? <SegmentInspector segment={seg} /> : (
        <div className="sd-insp"><div className="empty">Select a corridor segment to see its incident profile and test a countermeasure.</div></div>
      )}
    </div>
  );
}

/* ----------------------------------- KPI bar ----------------------------------- */
function KpiBar({ scenario }: { scenario: "A" | "B" }) {
  const s = useScenarioState();
  if (scenario === "A") {
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
  const gridTemplateColumns = `${leftOpen ? 312 : 34}px 1fr ${rightOpen ? 360 : 34}px`;

  return (
    <div className="shell" style={{ gridTemplateColumns }}>
      <TopBar scenario={scenario} onStartTour={() => setTourOpen(true)} />
      {leftOpen ? (
        <LeftPanel scenario={scenario} onCollapse={() => setLeftOpen(false)} />
      ) : (
        <div className="sd-left" style={{ gridArea: "left" }}>
          <Rail side="left" label={scenario === "A" ? "ASSETS" : "SEGMENTS"} onExpand={() => setLeftOpen(true)} />
        </div>
      )}
      <div className="sd-viewer">{viewer}</div>
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
