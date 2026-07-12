/*
 * I-595 Toll-Plaza Flow — SUMO trajectories rendered in CesiumJS.
 *
 * Coordinate conversion (SUMO metres <-> Cesium globe) is owned ENTIRELY by transform.js
 * (CoordinateTransform). The data pipeline (fcd2json.py / live_server.py) emits LOCAL SUMO
 * plaza metres; this client places them via the active transform T.sumoToWorld(x, y).
 *
 * This means BOTH vehicles AND gate markers go through the same T, so marking at any location
 * on the map moves traffic WITH the markers — the mark-coupling invariant is always maintained.
 */
// main.js is renderer-AGNOSTIC: it owns orchestration (scenario state, websocket, KPIs, gates,
// marking) and drives a renderer adapter. It imports NO Cesium types directly — the CesiumRenderer
// (and, behind ?renderer=arcgis, an ArcGIS adapter) own everything renderer-specific.
import "./style.css";
import { CoordinateTransform } from "./transform.js";
import { buildWorkZone, clearWorkZone, rilcaWorkzone, CLOSURE_CONFIG } from "./workzone.js";
import { CesiumRenderer } from "./renderers/cesium.js";
import { assetKpis } from "./assetOps.js";
import { login, fetchClass, writeRecord, onStatus } from "./dataconnect.js";
import { adaptDataConnectAssets, scoreAssets } from "./scoringA.js";
import { buildAssetLayer, disposeAssetLayer, pickAsset, installAssetPicking } from "./assetLayer.js";
import { extractAccidents, openWorkOrders, failedInspections, buildWorkOrderContext, classifyCorridorAssets, TICKETS_CLASS } from "./uc1Data.js";
import { buildWorkOrderLayer, buildAccidentLayer, buildInspectionLayer, buildAncillaryLayer, buildImpactHeatmap, disposeUc1Layer, pickUc1Point, flyToLonLat, pulseUc1Point } from "./uc1Layers.js";
import { renderWorkOrderContext } from "./contextPanel.js";
import { evaluateCandidates } from "./windowAssembly.js";
import { renderWindowPanel } from "./windowPanel.js";
import { createDemandModel } from "./demand.js";
import { runBacktest } from "./backtest.js";
import { renderTrustPanel, mergeAssumptionDefaults } from "./trustPanel.js";
import { computeExecKpis, renderExecKpiStrip } from "./execKpis.js";
import {
  enterUc1Mode, exitUc1Mode, renderStartupTile, hideStartupTile, renderStepper,
  advanceUc1Step, resetUc1Step,
} from "./uc1Mode.js";
import uc1Demo from "../config/uc1Demo.json" with { type: "json" };
import uc1Segments from "../config/segments.json" with { type: "json" };
import uc1WindowConfig from "../config/windowConfig.json" with { type: "json" };
import uc1BacktestConfig from "../config/backtestConfig.json" with { type: "json" };
import corridorCenterline from "../config/corridorCenterline.json" with { type: "json" };

const toRad = (deg) => (deg * Math.PI) / 180;
const ION = import.meta.env.VITE_CESIUM_ION_TOKEN;
// Resolve a bundled asset against the deploy base (/ in dev, /acs-demo/twin/ on Pages) so absolute
// "/data/…" refs don't break when the app is served from a sub-path.
const asset = (p) => import.meta.env.BASE_URL + String(p).replace(/^\//, "");

const N_BOOTHS = 10;
// Fixed plaza half-span: this is the CENTRE-to-CENTRE half-span across the 10 booth lanes —
// (N_BOOTHS - 1) * laneWidth / 2 = 9 * 3.7 / 2 = 16.65 m (real AASHTO freeway lane width, see
// sumo/road_centerline.py PLAZA_LANE_WIDTH_M / PLAZA_LANE_COUNT) — NOT the plaza's edge-to-edge
// half-width (that's meta.roadHalfWidthM = N_BOOTHS * laneWidth / 2 = 18.5 m, a different quantity
// used only for the on-road clamp). computeBooths() below spaces N_BOOTHS lane markers evenly
// across [-PLAZA_HALF_SPAN_M, +PLAZA_HALF_SPAN_M] using (N_BOOTHS - 1) gaps, which lands each
// marker exactly on its lane's real centre (-16.65, -12.95, ..., +16.65 — verified against the
// SUMO fcd samples at the booth line); buildTransformFromMarks() also uses this same half-span as
// the "real-world span the 10 marked gates cover" denominator, so the two MUST use the same
// quantity (lane-centre span, not plaza edge-to-edge width) or the derived scale is wrong and
// vehicles land within one lane's width of the wrong-type gate (this WAS Bug 2's root cause —
// see e2e/bugs.spec.ts Bug 2 and e2e/helpers.ts SITE_I595.gates, which must be generated from this
// same lane-centre spacing). The plaza core (fo/pl/fi) stays a straight, symmetric-about-y=0
// tangent by design (Feature A curved-road net — see sumo/georef_nodes.py), so this is a FIXED
// constant, not derived from meta.bounds.minY/maxY: those now span the whole curved
// approach/departure trajectory (up to ~55 m), not just the booth line.
const PLAZA_HALF_SPAN_M = 16.65;
// Cash booths per scenario. Baseline: 3 cash (pl_0..2). Intervention ("Convert 2 cash → AET"):
// pl_1 & pl_2 are converted to AET (turn GREEN), only pl_0 stays cash — so green cars flow through the
// converted booths and the orange (cash) cars queue at the single remaining cash booth.
// NTTA all-electronic reframing (NTTA has NO cash booths). The A/B contrasts what a LEGACY CASH PLAZA
// would cost the operator (baseline: 3 cash lanes → queues/delay) vs the ALL-ELECTRONIC REALITY
// (intervention: every lane AET → free-flow). Mechanics unchanged; the cash set drives booth colour +
// the cash-queue behaviour. All-electronic = empty cash set (every booth green).
const CASH_BY_SCENARIO = {
  baseline: new Set(["pl_0", "pl_1", "pl_2"]),  // "if NTTA still ran a legacy cash plaza"
  intervention: new Set([]),                     // "your all-electronic reality" — every lane AET
};
let activeCashLanes = CASH_BY_SCENARIO.baseline;
// Default is localhost for local dev; a hosted page can point at any live server via ?ws=wss://host:port.
const WS_URL = new URLSearchParams(location.search).get("ws") || "ws://localhost:8765";

// ---- Feature B: MUTCD/RILCA work-zone lane closure (approach lanes only) ----
const AP_LANES = ["ap_0", "ap_1", "ap_2"];
const N_AP_LANES = AP_LANES.length;
// Canonical corridor-x stations from sumo/georef_nodes.py: A=0, B=400, C=500, D=530(=boothX), E=630,
// F=930. Node B — where the approach taper must fully merge — sits this many metres upstream of the
// booth line. Used to place the OFFLINE schematic closure (no live SUMO net to report the exact
// station); the LIVE server reports its own closureStartX from the real net, but we compute
// geometry client-side either way so the overlay appears immediately (see closeLaneHook).
const NODE_B_UPSTREAM_OF_BOOTH_M = 130;

// ---- SITES: the SAME SUMO plaza, placed on different real toll corridors purely by swapping the
// transform — proving the transform module is map-agnostic. Each ships a default transform (so it
// works out of the box) and persists its own manual calibration under a per-site key. ----
const SITES = [
  // DNT mainline, Plano–Frisco TX (business-district stretch near The Star / Legacy) — the NTTA demo
  // corridor (default). Anchor + bearing are ON the real carriageway from OSM: the DNT runs nearly due
  // north here (bearing ≈ 1°) at lon ≈ -96.8229 (verified against OpenStreetMap way geometry).
  { id: "dnt", name: "Dallas North Tollway · Plano–Frisco TX",
    transform: { anchorLon: -96.8229, anchorLat: 33.0920, anchorHeight: 3, bearingDeg: 1, scale: 0.5, sumoRefX: 530, sumoRefY: 0 } },
  { id: "i595", name: "I-595 Express · Ft Lauderdale FL",
    transform: { anchorLon: -80.306, anchorLat: 26.1124, anchorHeight: 3, bearingDeg: 104, scale: 0.5, sumoRefX: 530, sumoRefY: 0 } },
  { id: "i95de", name: "I-95 Toll Plaza · Newark DE",
    transform: { anchorLon: -75.6982, anchorLat: 39.6579, anchorHeight: 3, bearingDeg: 31, scale: 0.5, sumoRefX: 530, sumoRefY: 0 } },
];
let siteId = SITES[0].id;
const siteKey = (id) => "plazaTransform:" + id;
/** raw {t,g} -> {transform, gates}, or null if the record doesn't parse into a usable transform. */
function siteRecordFromRaw(raw) {
  if (!raw || !raw.t) return null;
  const t = CoordinateTransform.fromJSON(raw.t);
  return t ? { transform: t, gates: raw.g || [] } : null;
}
/**
 * Returns { transform, gates } for a site. Load order: per-browser localStorage calibration ->
 * a committed calibration file (public/data/site-<id>.json, same {t,g} shape — lets a team share
 * one calibration by committing it) -> the built-in SITES default (always renders something).
 */
async function loadSite(id) {
  try {
    const local = siteRecordFromRaw(JSON.parse(localStorage.getItem(siteKey(id))));
    if (local) return local;
  } catch {}
  try {
    const res = await fetch(asset(`/data/site-${id}.json`));
    // vite's dev server returns index.html (200, text/html) for unknown /data paths instead of a
    // real 404, so a missing calibration file must be detected via content-type, not just res.ok.
    if (res.ok && (res.headers.get("content-type") || "").includes("json")) {
      const fetched = siteRecordFromRaw(await res.json());
      if (fetched) return fetched;
    }
  } catch {}   // missing/invalid file falls through silently to the built-in default
  const site = SITES.find((x) => x.id === id);
  return { transform: site ? new CoordinateTransform(site.transform) : null, gates: [] };
}

const $ = (id) => document.getElementById(id);
const setStatus = (m) => ($("status").textContent = m);

// ============================================================================ transform + booths
let T = null;            // the CoordinateTransform (SUMO local metres <-> globe). Always set.
let META = null;         // data meta: { bounds, boothX, tEnd, dt }
let BOOTHS = [];         // [{ lane, y, cash }] — derived from meta.bounds

function computeBooths(meta) {
  // Derive booth Y positions from the fixed plaza half-span (NOT meta.bounds — see
  // PLAZA_HALF_SPAN_M comment above for why).
  const minY = -PLAZA_HALF_SPAN_M, maxY = PLAZA_HALF_SPAN_M;
  const out = [];
  for (let i = 0; i < N_BOOTHS; i++) {
    const lane = `pl_${i}`;
    const y = minY + (i * (maxY - minY)) / (N_BOOTHS - 1);   // lane centres span the plaza
    out.push({ lane, y, cash: activeCashLanes.has(lane) });
  }
  return out;
}

// ============================================================================ viewer
// The Cesium renderer adapter owns viewer creation (see renderers/cesium.js). main() holds
// the returned Viewer as `viewer` and drives it directly for concerns not yet moved behind
// the adapter; window.__viewer stays the same object so the e2e contract is unchanged.
let R = null;  // the active renderer adapter (Cesium by default; ArcGIS via ?renderer=arcgis). Set in main().
/** Set the active transform on BOTH the module (markers/camera still read it) and the renderer. */
function setTransform(t) { T = t; R.setTransform(t); }

// ============================================================================ booth markers
let closedSet = new Set();
const desired = new Map();
const isClosed = (lane) => !!desired.get(lane) || closedSet.has(lane);

function rebuildBoothMarkers() {
  // All markers place via the renderer through T.sumoToWorld (tracking:true) — marking rebuilds T,
  // so booth discs and the plaza label follow. The gate ✕ label is a per-frame callback on isClosed.
  R.clearMarkers();
  const boothX = META ? META.boothX : (T ? T.p.sumoRefX : 530);
  for (const b of BOOTHS) {
    R.placeMarker({
      id: `booth:${b.lane}`, x: boothX, y: b.y, tracking: true,
      disc: { radiusM: 1.8, colorCss: b.cash ? "#ff9b1a" : "#1ccb40", alpha: 0.9 },
      label: { kind: "gate", textFn: () => (isClosed(b.lane) ? "✕" : "") },
    });
  }
  // ONE "TOLL PLAZA" label on the centre-line (id-keyed, so a rebuild replaces it — the fix for the
  // old "TOLL PLAZA × 9" stacking bug).
  if (T) {
    R.placeMarker({
      id: "toll-plaza-label", x: boothX - 26, y: 0, tracking: true,
      label: { kind: "plaza", text: "TOLL PLAZA" },
    });
  }
  renderGantries();   // re-add gantry assets after any booth-marker rebuild (clearMarkers wiped them)
  renderApLaneMarkers(); // re-add UC1 click-on-twin lane-pick markers (P5-e item 4)
}

// ============================================================================ gantry assets (GIS layer)
// The DNT toll gantries are geospatial ASSETS (Legacy / Headquarters / Gaylord), loaded from a GIS
// export (public/data/dnt-gantries.json — stands in for a TxDOT/NTTA ArcGIS FeatureLayer). They place
// onto the same corridor centerline as the traffic via T, and carry health status for the asset-ops
// scenario. Rendered as cyan discs (red when a camera degrades) with name labels.
let GANTRIES = [];
let AVG_TOLL = 1.45;
let assetIncidentOn = false;
let gantrySource = "";   // where the gantry inventory came from (live ArcGIS vs local fallback)
let tollRateSource = ""; // where the per-transaction toll came from (live NTTA rates vs default)

// NTTA's OWN authoritative toll-rate table, hosted on their ArcGIS Online org — 194 toll points with
// real per-class TagFare / PlateFare. Pulling the live TagFare here makes ArcGIS the system-of-record
// for the ECONOMICS too, not just the geometry: revenue-at-risk is computed from real NTTA fares.
const NTTA_TOLLRATES_URL = "https://services.arcgis.com/pS2RA6RqB5M3sZIg/arcgis/rest/services/NTTA_TollLocation_TollRates_View_PROD/FeatureServer/0/query";

async function loadTollRates() {
  const anchor = T ? { lon: T.p.anchorLon, lat: T.p.anchorLat } : { lon: -96.8229, lat: 33.0920 };
  try {
    const params = new URLSearchParams({
      where: "CORRIDOR IN ('DNT','SRT') AND TagFare > 0",
      geometry: `${anchor.lon},${anchor.lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
      distance: "8000", units: "esriSRUnit_Meter", spatialRel: "esriSpatialRelIntersects",
      outFields: "TagFare", returnGeometry: "false", resultRecordCount: "80", f: "json",
    });
    const d = await (await fetch(`${NTTA_TOLLRATES_URL}?${params}`)).json();
    const fares = (d.features || []).map((f) => Number(f.attributes?.TagFare)).filter((v) => v > 0).sort((a, b) => a - b);
    if (!fares.length) throw new Error("no fares in response");
    // A missed read = one gantry transaction not captured, so the revenue lost per missed read is a
    // single-segment fare. AVG_TOLL is therefore the MEAN nearby TagFare — real NTTA money per read.
    const avg = fares.reduce((s, v) => s + v, 0) / fares.length;
    AVG_TOLL = Math.round(avg * 100) / 100;
    tollRateSource = `NTTA rates · live ArcGIS ($${AVG_TOLL.toFixed(2)}/read · ${fares.length} pts)`;
  } catch {
    tollRateSource = "";   // leave AVG_TOLL at its gantry-source default
  }
}

// NCTCOG regional "Toll Gantries" point layer — an authoritative, KEYLESS ArcGIS FeatureServer whose
// points carry NTTA_Gantry_ID / Corridor / Maintaining_Authority. This is the geospatial system-of-record:
// the demo queries REAL NTTA gantry locations near the corridor, not a synthetic stub.
const NCTCOG_GANTRIES_URL = "https://geospatial.nctcog.org/map/rest/services/Transportation/DFWMaps_Roadway/MapServer/6/query";

async function loadGantries() {
  const anchor = T ? { lon: T.p.anchorLon, lat: T.p.anchorLat } : { lon: -96.8229, lat: 33.0920 };
  try {
    const params = new URLSearchParams({
      where: "Corridor IN ('DNT','SRT')",
      geometry: `${anchor.lon},${anchor.lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
      distance: "4000", units: "esriSRUnit_Meter", spatialRel: "esriSpatialRelIntersects",
      outFields: "Corridor,Location,NTTA_Gantry_ID,Maintaining_Authority",
      returnGeometry: "true", outSR: "4326", f: "geojson",
    });
    const d = await (await fetch(`${NCTCOG_GANTRIES_URL}?${params}`)).json();
    // Dedup directional pairs by gantry id, keep the one nearest the corridor anchor, cap the list.
    const seen = new Map();
    for (const f of d.features || []) {
      if (!f.geometry) continue;
      const p = f.properties || {}, [lon, lat] = f.geometry.coordinates;
      const gid = p.NTTA_Gantry_ID || p.Location;
      const dist = Math.hypot(lon - anchor.lon, lat - anchor.lat);
      const name = String(p.Location || gid).replace(/\s*\d\/\d$/, "").trim();
      if (!seen.has(gid) || dist < seen.get(gid).dist) {
        seen.set(gid, { id: gid, name, corridor: p.Corridor, authority: p.Maintaining_Authority || "NTTA", lon, lat, dist, status: "healthy" });
      }
    }
    GANTRIES = Array.from(seen.values()).sort((a, b) => a.dist - b.dist).slice(0, 6);
    if (!GANTRIES.length) throw new Error("no gantries in response");
    gantrySource = `NCTCOG · ${GANTRIES[0].authority} (live ArcGIS)`;
    AVG_TOLL = 1.45;
  } catch {
    // Fallback: local sample (keeps the demo working offline / if the ArcGIS host blocks CORS).
    try {
      const d = await (await fetch(asset("/data/dnt-gantries.json"))).json();
      GANTRIES = (d.gantries || []).map((g) => ({ ...g }));
      AVG_TOLL = d.avgTollUsd ?? 1.45;
      gantrySource = "local sample";
    } catch { GANTRIES = []; gantrySource = ""; }
  }
}

function renderGantries() {
  // Gantries are REAL GIS assets at fixed lon/lat (not synthetic corridor stations), so place them
  // geographically — they stay put through re-calibration, as real infrastructure should.
  for (const g of GANTRIES) {
    if (g.lon == null) continue;
    const degraded = g.status === "degraded";
    R.placeMarker({
      id: `gantry:${g.id}`, lon: g.lon, lat: g.lat,
      disc: { radiusM: 3.4, colorCss: degraded ? "#ff4d4d" : "#39c0d6", alpha: 0.85 },
      label: { kind: "gantry", text: g.name + (degraded ? " ⚠" : "") },
    });
  }
}

/** Fill the Asset Operations panel from the pure assetKpis engine + current throughput/weather. */
function renderAssetOps() {
  if (!$("assetops-hud")) return;
  const src = $("ao-src");
  if (src && gantrySource) {
    const line = tollRateSource ? `${gantrySource} · ${tollRateSource}` : gantrySource;
    src.textContent = line;
    src.classList.toggle("live", line.includes("ArcGIS"));
  }
  const throughput = window.__kpi?.throughputVph ?? currentData?.stats?.throughputVph ?? 0;
  const state = { gantries: GANTRIES, weather: _activeWeather, throughputVph: throughput, avgTollUsd: AVG_TOLL, peak: assetIncidentOn };
  const k = assetKpis(state);
  const nominal = assetKpis({ ...state, gantries: GANTRIES.map((g) => ({ ...g, status: "healthy" })), weather: "clear", peak: false });
  const riskDelta = k.revenueRiskPerHr - nominal.revenueRiskPerHr;

  const glist = $("ao-gantries");
  if (glist) glist.innerHTML = GANTRIES.map((g) => {
    const deg = g.status === "degraded";
    return `<div class="ao-g ${deg ? "deg" : ""}"><span class="ao-dot"></span><span class="ao-name">${g.name.replace(" Gantry", "")}</span><span class="ao-badge">${deg ? "DEGRADED" : "OK"}</span></div>`;
  }).join("");

  const kv = $("ao-kpis");
  if (kv) {
    const riskChip = assetIncidentOn && riskDelta > 0 ? ` <span class="ao-delta">▲ $${riskDelta.toLocaleString()}/hr vs nominal</span>` : "";
    kv.innerHTML =
      `<div class="ao-row"><span class="ao-k">Plate/tag read rate</span><span class="ao-v ${k.readRatePct < 97 ? "warn" : "good"}">${k.readRatePct}%</span></div>` +
      `<div class="ao-row"><span class="ao-k">Missed reads</span><span class="ao-v">${k.missedPerHr.toLocaleString()}/hr</span></div>` +
      `<div class="ao-row"><span class="ao-k">Revenue at risk</span><span class="ao-v ${assetIncidentOn && k.revenueRiskPerHr > 0 ? "warn" : ""}">$${k.revenueRiskPerHr.toLocaleString()}/hr${riskChip}</span></div>` +
      `<div class="ao-row"><span class="ao-k">Congestion risk</span><span class="ao-v risk-${k.congestionRisk}">${k.congestionRisk}</span></div>` +
      `<div class="ao-row"><span class="ao-k">Maintenance</span><span class="ao-v">${k.maintenance.priority === "HIGH" ? `<b class="warn">HIGH</b> · ${k.maintenance.target}` : "nominal"}</span></div>` +
      (k.dispatch ? `<div class="ao-dispatch">🛠 ${k.dispatch}</div>` : "");
  }
  const btn = $("ao-run");
  if (btn) {
    btn.textContent = assetIncidentOn ? "Reset — restore healthy + clear" : "Run incident: camera degradation + rain";
    btn.classList.toggle("on", assetIncidentOn);
  }
}

/** The headline scenario: degrade a gantry camera + heavy rain + peak-hour, or clear it. */
function toggleIncident() {
  assetIncidentOn = !assetIncidentOn;
  const target = GANTRIES[0];   // the gantry nearest the plaza (most visible on the aerial)
  if (target) target.status = assetIncidentOn ? "degraded" : "healthy";
  const wsOpen = liveMode && ws && ws.readyState === WebSocket.OPEN;
  applyWeatherOverlay(assetIncidentOn ? "heavyrain" : "clear", wsOpen);
  const wsel = $("weather-select"); if (wsel) wsel.value = assetIncidentOn ? "heavyrain" : "clear";
  rebuildBoothMarkers();   // re-renders gantries (status colour) + booths
  renderAssetOps();
  setStatus(assetIncidentOn
    ? `⚠ Incident: ${target ? target.name : "gantry"} camera degraded + heavy rain + peak — revenue at risk, crew dispatched.`
    : "Incident cleared — all gantries healthy, weather clear.");
}

// ============================================================================ offline playback
let currentData = null;
let offlineUrl = asset("/data/baseline.json");

async function loadRun(viewer, url) {
  const data = await (await fetch(url)).json();
  currentData = data;
  META = data.meta;
  BOOTHS = computeBooths(META);
  R.clearSampled();
  rebuildBoothMarkers();
  // New scenario data invalidates any active work-zone overlay (stale geometry/KPIs).
  clearWorkZone(viewer);
  activeWorkzoneSpec = null;

  if (!T) { setStatus("⊕ Calibrate the road to place + start the traffic."); return; }

  // Vehicles are placed via the renderer through T.sumoToWorld — marking rebuilds T, so traffic follows.
  for (const v of data.vehicles) {
    R.addSampledVehicle({ type: v.type, samples: v.samples });
  }
  R.clock.setRange(0, data.meta.tEnd);
  if (!trafficStarted) R.clock.seek(0);
  R.clock.setPlaying(trafficStarted);
  renderKpis(data.stats);
  if (trafficStarted) setStatus(`${data.vehicles.length} vehicles · ${Math.round(data.meta.tEnd)} s sim`);
}

// ============================================================================ weather overlay
let _activeWeather = "clear";
let _clearCapacity = null;   // capacityVph observed under clear weather (for delta chip)

/**
 * Apply (or remove) the full-viewport weather tint overlay and set window.__weather.
 * Also sends the command to the live server if connected.
 * @param {string} preset — one of "clear"|"lightrain"|"heavyrain"|"fog"|"snowice"
 * @param {boolean} [sendToServer=true] — whether to forward the command over WS
 */
function applyWeatherOverlay(preset, sendToServer = true) {
  _activeWeather = preset;
  window.__weather = preset;

  const overlay = $("weather-overlay");
  if (overlay) {
    const classes = ["weather-clear", "weather-lightrain", "weather-heavyrain", "weather-fog", "weather-snowice"];
    overlay.className = "";
    classes.forEach((c) => overlay.classList.remove(c));
    if (preset === "clear") {
      overlay.style.display = "none";
    } else {
      overlay.className = "weather-" + preset;
      overlay.style.display = "";
    }
  }

  // Fog: lower scene fog density so distant vehicles fade
  if (preset === "fog") R.setFog(true, 0.002);
  else R.setFog(false);

  if (sendToServer) sendCmd({ cmd: "setWeather", preset });
}

// ============================================================================ KPIs
// baselineStats is captured ONLY when the baseline scenario is loaded (not first-call).
// This ensures that the delta chips compare intervention vs baseline correctly even
// if the app boots straight into the intervention scenario.
let baselineStats = null;
let _currentScenario = "baseline";  // "baseline" | "intervention" | "live"

// Animated cumulative-$ counter state
let _revCounterTarget = 0;
let _revCounterDisplayed = 0;
let _revRafId = null;
function _animateRevCounter() {
  const el = $("revenue-counter");
  if (!el) return;
  const step = (_revCounterTarget - _revCounterDisplayed) * 0.12;
  if (Math.abs(step) < 0.01) {
    _revCounterDisplayed = _revCounterTarget;
  } else {
    _revCounterDisplayed += step;
  }
  el.textContent = "$" + Math.round(_revCounterDisplayed).toLocaleString();
  if (Math.abs(_revCounterDisplayed - _revCounterTarget) > 0.01) {
    _revRafId = requestAnimationFrame(_animateRevCounter);
  } else {
    _revRafId = null;
  }
}
function _setRevCounter(target) {
  _revCounterTarget = target;
  if (_revRafId === null) {
    _revRafId = requestAnimationFrame(_animateRevCounter);
  }
}

function renderKpis(s) {
  // Capture baseline stats only when on the baseline scenario.
  if (_currentScenario === "baseline") baselineStats = s;
  if (!baselineStats) baselineStats = s;  // fallback for live / first load

  const delta = (cur, base, lowerBetter) => {
    if (cur == null || base == null || cur === base) return "";
    const better = lowerBetter ? cur < base : cur > base;
    const pct = base ? Math.round(((cur - base) / base) * 100) : 0;
    return `<div class="d ${better ? "good" : "bad"}">${pct > 0 ? "+" : ""}${pct}%</div>`;
  };

  // ---- Format helpers ----
  const fmtRev = (r) => r != null ? "$" + Math.round(r).toLocaleString() : "—";
  const fmtUtil = (u) => u != null ? Math.round(u * 100) + "%" : "—";
  const fmtDelay = (d) => d != null ? Math.round(d) + "s" : "—";

  // Track clearCapacity for weather delta: first non-zero capacityVph under clear weather
  if (s.capacityVph > 0 && (_clearCapacity === null || _activeWeather === "clear")) {
    if (_activeWeather === "clear") _clearCapacity = s.capacityVph;
  }

  // ---- KPI tiles (4 existing + Phase 0 + Phase 1 weather) ----
  const b = baselineStats;
  const capDelta = s.capacityVph != null && _clearCapacity != null && _activeWeather !== "clear"
    ? delta(s.capacityVph, _clearCapacity, false)
    : "";
  const satPct = s.satRatio != null ? Math.round(s.satRatio * 100) : null;
  const satStyle = satPct != null && satPct >= 100 ? ' style="color:#ff6b6b"' : '';

  const tiles = [
    // Existing 4 (unchanged labels/logic)
    ["Avg wait",           `${s.avgWaitSec}s`,            delta(s.avgWaitSec,   b.avgWaitSec,   true)],
    ["Throughput",         `${s.throughputVph} vph`,       delta(s.throughputVph, b.throughputVph, false)],
    ["Avg speed",          `${s.avgSpeedMph} mph`,         delta(s.avgSpeedMph,  b.avgSpeedMph,  false)],
    ["Mainline spillback", s.spillback ? "Yes" : "No",     ""],
    // Phase 0
    ["Revenue/hr",         fmtRev(s.revenuePerHr),        delta(s.revenuePerHr,  b.revenuePerHr,  false)],
    ["Avg delay",          fmtDelay(s.avgDelaySec),        delta(s.avgDelaySec,   b.avgDelaySec,   true)],
    ["Booth util",         fmtUtil(s.boothUtilisation?.overall), ""],
    // Phase 1 weather
    ["Plaza capacity",     s.capacityVph != null ? `${s.capacityVph} vph` : "—", capDelta],
    ["Saturation",         satPct != null ? `<span${satStyle}>${satPct}%</span>` : "—", ""],
  ];

  const visibleTiles = [
    tiles[0], tiles[1], tiles[2],
    tiles[4],  // Revenue/hr
    tiles[5],  // Avg delay
    tiles[6],  // Booth util
    tiles[7],  // Plaza capacity
    tiles[8],  // Saturation
  ];
  $("kpis").innerHTML = visibleTiles
    .map(([l, v, d]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div>${d}</div>`).join("");

  // ---- Animated cumulative-$ counter ----
  if (s.cumulativeRevenue != null) {
    _setRevCounter(s.cumulativeRevenue);
  }

  // ---- Cash-vs-AET card ----
  const cvaEl = $("cash-aet-card");
  if (cvaEl && s.cashVsAet) {
    const { cash, aet } = s.cashVsAet;
    const fmtCva = (bucket, label, color) => `
      <div class="cva-col" style="border-left:3px solid ${color}">
        <div class="cva-label">${label}</div>
        <div class="cva-row"><span class="cva-k">Throughput</span><span class="cva-v">${bucket.throughputVph || 0} vph</span></div>
        <div class="cva-row"><span class="cva-k">Avg wait</span><span class="cva-v">${bucket.avgWaitSec || 0}s</span></div>
        <div class="cva-row"><span class="cva-k">Avg delay</span><span class="cva-v">${bucket.avgDelaySec || 0}s</span></div>
        <div class="cva-row"><span class="cva-k">Rev/hr</span><span class="cva-v">${fmtRev(bucket.revenuePerHr)}</span></div>
      </div>`;
    cvaEl.innerHTML = `
      <div class="cva-title">Cash vs AET</div>
      <div class="cva-cols">
        ${fmtCva(cash || {}, "Cash", "#ff9b1a")}
        ${fmtCva(aet  || {}, "AET (ETC)", "#1ccb40")}
      </div>`;
  }

  // ---- Debug hook ----
  window.__kpi = s;

  // ---- Feature B: work-zone HUD readouts (geometry from activeWorkzoneSpec, live numbers from s.workzone) ----
  renderWorkzoneHud();
  // ---- Asset-operations KPIs (missed reads / revenue-risk react to live throughput + weather) ----
  renderAssetOps();
}

// ============================================================================ camera
let obliqueOn = false;
function frameCamera(viewer) {
  if (!T) return;
  R.frameCamera({ x: T.p.sumoRefX, y: 0, headingDeg: 90, oblique: obliqueOn });
}

// ============================================================================ traffic gate
let calibrated = false;
let trafficStarted = false;
function startTraffic(viewer) {
  trafficStarted = true;
  R.clock.seek(0);
  R.clock.play();
}

// ============================================================================ live mode
let ws = null, liveMode = false;
function setConn(on, text) { const e = $("conn"); e.className = "conn " + (on ? "on" : "off"); e.textContent = text; }

function startLive(viewer) {
  liveMode = true;
  R.clock.pause();
  R.clearSampled();
  setConn(false, "socket: connecting…");
  $("gatePanel").classList.remove("hidden");
  try { ws = new WebSocket(WS_URL); } catch { setConn(false, "socket: failed"); return; }
  ws.onopen = () => setConn(true, "socket: live");
  // C3: an unexpected drop (server killed, network blip) must also flip liveMode back to false —
  // otherwise closeLaneHook keeps taking the `liveMode` branch (a no-op sendCmd on a dead socket)
  // instead of falling into applyOfflineWorkzoneStats, and the KPI/queue readouts go stale.
  ws.onclose = () => { liveMode = false; setConn(false, "socket: offline"); };
  ws.onerror = () => { liveMode = false; setConn(false, "socket: error"); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "meta") onMeta(viewer, m);
    else if (m.type === "step") onStep(viewer, m);
  };
}
function stopLive(viewer) {
  liveMode = false;
  if (ws) { try { ws.close(); } catch {} ws = null; }
  R.clearLiveVehicles();
  closedSet = new Set();
  $("gatePanel").classList.add("hidden");
  setConn(false, "socket: offline");
  clearWorkZone(viewer);
  activeWorkzoneSpec = null;
  renderWorkzoneHud();
}
function onMeta(viewer, m) {
  // Preserve centerline + roadHalfWidthM from either the live server's meta message or
  // the previously loaded offline JSON (baseline.json), so window.__meta always carries
  // these fields for the CR-spec / LIVE Bug 3 invariants.
  const prevCl  = META?.centerline;
  const prevHW  = META?.roadHalfWidthM;
  // Build a META compatible with computeBooths (raw SUMO bounds).
  if (m.bounds && typeof m.boothX === "number") {
    META = {
      bounds: m.bounds, boothX: m.boothX, tEnd: m.tEnd || 0,
      centerline:    m.centerline    || prevCl,
      roadHalfWidthM: m.roadHalfWidthM ?? prevHW,
    };
  } else {
    // Fallback: use default bounds matching the 10-lane plaza
    META = {
      bounds: { minX: 0, maxX: 930, minY: -14.4, maxY: 14.4 }, boothX: 530, tEnd: 0,
      centerline:    prevCl,
      roadHalfWidthM: prevHW,
    };
  }
  BOOTHS = computeBooths(META);
  rebuildBoothMarkers();
  renderGatePanel();
  closedSet = new Set(m.closed || []);
  setStatus("Live · waiting for first step…");
}
function onStep(viewer, m) {
  closedSet = new Set(m.closed || []);
  const seen = new Set();
  for (const v of m.vehicles) {
    seen.add(v.id);
    // Live data carries raw local SUMO x,y — the renderer places it via T.sumoToWorld.
    if (!T) continue;
    const p = { id: v.id, type: v.type, x: v.x, y: v.y, angleDeg: v.angle };
    if (R.hasVehicle(v.id)) R.updateVehicle(p);
    else R.addLiveVehicle(p);
  }
  for (const id of R.liveIds()) if (!seen.has(id)) R.removeVehicle(id);
  syncGateButtons();
  const s = m.stats || {};
  // Render KPIs from live step when the stats carry the Phase 0 schema.
  if (s.schemaVersion != null) {
    _currentScenario = "live";
    // Sync weather overlay from server-confirmed weather (without re-sending to server)
    if (s.weather && s.weather !== _activeWeather) {
      applyWeatherOverlay(s.weather, false);
      const weatherSel = $("weather-select");
      if (weatherSel) weatherSel.value = s.weather;
    }
    renderKpis(s);
  }
  setStatus(`Live · t=${Math.round(m.t)}s · ${s.running || 0} cars · approach queue ${s.queueAp || 0}`);
}

// ============================================================================ gate control panel
function sendCmd(o) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); }
function renderGatePanel() {
  const host = $("gates-all");
  if (!host) return;
  host.innerHTML = "";
  for (const b of BOOTHS) {
    const btn = document.createElement("button");
    btn.dataset.lane = b.lane;
    btn.className = "gate-btn " + (b.cash ? "cash" : "etc");
    btn.textContent = b.lane.replace("pl_", "B");
    btn.onclick = () => {
      const next = !desired.get(b.lane);
      desired.set(b.lane, next);
      sendCmd({ cmd: next ? "closeGate" : "openGate", lane: b.lane });
      syncGateButtons();
    };
    host.appendChild(btn);
  }
  syncGateButtons();
}
function syncGateButtons() {
  document.querySelectorAll(".gate-btn").forEach((b) => b.classList.toggle("closed", isClosed(b.dataset.lane)));
}

// ============================================================================ Feature B: work-zone lane closure
// window.__closeLane(lane, opts) / window.__openLane(lane) — TTC overlay (workzone.js) + RILCA KPIs.
// Geometry (taper length, cone count, sign stations) is computed CLIENT-SIDE via the workzone.js
// mirror of sumo/kpi.py so the overlay appears immediately in both LIVE and OFFLINE modes, without
// waiting on a websocket round-trip. LIVE mode additionally forwards the command to live_server.py,
// which reacts with real traci physics (lane speed drop + strategic lane-change) and streams back
// the real arrival-driven RILCA queue numbers in stats.workzone (picked up by renderKpis -> here).
let activeWorkzoneSpec = null; // { lane, offsetFt, speedMph, divertPct, closureStartX, closureEndX, taperLengthM, nCones, signStationsM, laneSign }

// ---- P5-e item 4: click-on-twin lane pick — 3 small pickable markers on the approach lanes,
// upstream of the plaza at the same station closeLaneHook's offline geometry uses (Node B),
// replacing #wz-lane-select as the VISIBLE interaction (the select stays in the DOM/functional —
// see index.html/style.css — so closure.spec.ts's window.__closeLane path is untouched). ----
function apLanePickX() {
  return (META ? META.boothX : (T ? T.p.sumoRefX : 530)) - NODE_B_UPSTREAM_OF_BOOTH_M;
}

/** Re-places the 3 approach-lane pick markers (wiped by R.clearMarkers() on every rebuild — see
 * rebuildBoothMarkers). The currently-selected lane (uc1SelectedApLane) renders highlighted. */
function renderApLaneMarkers() {
  if (!T) return;
  const x = apLanePickX();
  for (const lane of AP_LANES) {
    const y = AP_LANE_Y[lane] ?? 0;
    R.placeMarker({
      id: `wzlane:${lane}`, x, y, tracking: true,
      disc: {
        radiusM: 1.3,
        colorCss: lane === uc1SelectedApLane ? "#2f6df6" : "#9fb0c3",
        alpha: lane === uc1SelectedApLane ? 0.95 : 0.55,
      },
    });
  }
  const readout = $("wz-lane-picked");
  if (readout) readout.textContent = `Approach lane: ${uc1SelectedApLane.replace("ap_", "L")} (click the twin to change)`;
}

/** installAssetPicking(viewer, cb) delivers a screen position on every left click (same generic
 * wrapper assetLayer.js already uses for the DataConnect asset layer) — reused here rather than
 * adding any new Cesium-specific picking code. The click is resolved to a ground lon/lat via
 * CoordinateTransform.pickLonLat (already used internally by R.onPick for ⊕ Mark gates), then to
 * SUMO metres via T.worldToSumo, so a click near the lane-pick station selects its nearest lane —
 * clicks elsewhere on the twin (booths, gantries, the globe) are ignored. */
function installUc1LanePick(viewer) {
  if (!viewer?.scene?.canvas) return; // Cesium-only, same guard as installAssetPicking/installUc1
  installAssetPicking(viewer, (position) => {
    if (!T) return;
    const ll = CoordinateTransform.pickLonLat(viewer, position);
    if (!ll) return;
    const { x, y } = T.worldToSumo(ll.lon, ll.lat);
    if (Math.abs(x - apLanePickX()) > AP_LANE_PICK_TOLERANCE_M) return;
    let nearest = AP_LANES[0], best = Infinity;
    for (const lane of AP_LANES) {
      const d = Math.abs(y - (AP_LANE_Y[lane] ?? 0));
      if (d < best) { best = d; nearest = lane; }
    }
    if (nearest === uc1SelectedApLane) return;
    uc1SelectedApLane = nearest;
    const sel = $("wz-lane-select");
    if (sel) sel.value = nearest; // keeps the hidden dropdown in sync — it stays functional
    renderApLaneMarkers();
    setStatus(`Approach lane ${nearest.replace("ap_", "")} selected on the twin.`);
  });
}

function workzoneGeometryOnly(offsetFt, speedMph) {
  // arrivals/t1/q2 = 0 so only the geometry fields (taper/cones/signs) are meaningful here; the
  // queue/permissible fields get recomputed with real numbers by applyOfflineWorkzoneStats / the
  // live server's stats.workzone.
  const capacityVph = CLOSURE_CONFIG.workZoneCapacityVphpl * (N_AP_LANES - 1);
  return rilcaWorkzone(offsetFt, speedMph, 0, 0, 0, capacityVph);
}

function applyOfflineWorkzoneStats(offsetFt, speedMph, divertPct, lane) {
  const capacityVph = CLOSURE_CONFIG.workZoneCapacityVphpl * (N_AP_LANES - 1);
  // SCHEMATIC: offline playback has no live SUMO physics to measure real demand under closure, so
  // assume a brief oversaturated window 15% above the reduced capacity, recovering per the RILCA
  // formula — enough to demonstrate the queue/permissibility math without a live server (mirrors the
  // live server's own q2 = capacity * workzonePostPeakFactor recovery assumption).
  const arrivalsVph = capacityVph * 1.15;
  const q2Vph = capacityVph * (CLOSURE_CONFIG.workzonePostPeakFactor ?? 0.5);
  const wz = rilcaWorkzone(offsetFt, speedMph, arrivalsVph, 0.5, q2Vph, capacityVph);
  wz.lane = lane;
  wz.divertPct = divertPct;

  const base = currentData?.stats || window.__kpi || {};
  // SCHEMATIC: taking min(base.capacityVph, workZoneCapacityVphpl*(N-1)) is not always a real drop —
  // if the pre-closure bottleneck (booths) already measured below the reduced-lane approach capacity,
  // the raw min would leave capacityVph unchanged even though a lane just closed. Instead scale the
  // *observed* baseline capacity down by the fraction of approach lanes lost (closing 1 of N lanes
  // removes ~1/N of throughput), then still cap it at the absolute per-lane work-zone capacity —
  // this always reflects the closure while never reporting more capacity than physically available.
  const laneLossFactor = (N_AP_LANES - 1) / N_AP_LANES;
  const reducedBaseCapacity = Math.round((base.capacityVph ?? capacityVph) * laneLossFactor);
  const s = { ...base, workzone: wz, capacityVph: Math.min(reducedBaseCapacity, capacityVph) };
  renderKpis(s);
}

function closeLaneHook(viewer, lane, opts = {}) {
  if (!AP_LANES.includes(lane)) lane = AP_LANES[0];
  const offsetFt = opts.offsetFt ?? 12;
  const speedMph = opts.speedMph ?? 60;
  const divertPct = opts.divertPct ?? 0;

  const geom = workzoneGeometryOnly(offsetFt, speedMph);
  const closureEndX = (META?.boothX ?? (T ? T.p.sumoRefX : 530)) - NODE_B_UPSTREAM_OF_BOOTH_M;
  const closureStartX = closureEndX - geom.taperLengthM;

  activeWorkzoneSpec = {
    lane, offsetFt, speedMph, divertPct,
    closureStartX, closureEndX,
    taperLengthM: geom.taperLengthM, nCones: geom.nCones, signStationsM: geom.signStationsM,
    laneSign: AP_LANES.indexOf(lane) === 0 ? -1 : 1,
  };

  if (T) {
    buildWorkZone(viewer, T, {
      ...activeWorkzoneSpec,
      centerline: META?.centerline || [],
      roadHalfWidthM: META?.roadHalfWidthM ?? 20,
    });
  }

  if (liveMode) sendCmd({ cmd: "closeLane", lane, offsetFt, speedMph, divertPct });
  else applyOfflineWorkzoneStats(offsetFt, speedMph, divertPct, lane);

  renderWorkzoneHud();
}

function openLaneHook(viewer, lane) {
  const closingLane = lane || activeWorkzoneSpec?.lane;
  clearWorkZone(viewer);
  activeWorkzoneSpec = null;

  // C2 fix: drop the stale workzone KPI block now, in both modes — otherwise the HUD badge/queue
  // numbers linger (showing the old closure's queue) until the next stats tick refreshes window.__kpi.
  if (window.__kpi && "workzone" in window.__kpi) delete window.__kpi.workzone;

  if (liveMode) {
    sendCmd({ cmd: "openLane", lane: closingLane });
  } else if (currentData) {
    const s = { ...(window.__kpi || currentData.stats) };
    delete s.workzone;
    if (currentData.stats?.capacityVph != null) s.capacityVph = currentData.stats.capacityVph;
    renderKpis(s);
  }
  renderWorkzoneHud();
}

/** Sync the #workzone-hud readouts from activeWorkzoneSpec (geometry) + window.__kpi.workzone (queue KPIs). */
function renderWorkzoneHud() {
  const spec = activeWorkzoneSpec;
  const wz = window.__kpi?.workzone;
  const fmt = (v, unit = "", digits = 1) => (v == null ? "—" : `${Number(v).toFixed(digits)}${unit}`);

  const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  set("wz-taper-m", spec ? fmt(spec.taperLengthM, " m", 0) : "—");
  set("wz-cone-count", spec ? String(spec.nCones ?? "—") : "—");
  set("wz-sign-distances", spec && spec.signStationsM?.length
    ? spec.signStationsM.map((m) => Math.round(m)).join(" / ") + " m" : "—");
  set("wz-max-queue", wz ? `${fmt(wz.maxQueueVeh, " veh", 0)} (${fmt(wz.maxQueueMi, " mi", 2)})` : "—");
  set("wz-max-delay", wz ? fmt(wz.maxDelayMin, " min", 1) : "—");
  set("wz-recovery", wz ? fmt(wz.recoveryTimeH, " h", 2) : "—");

  const badge = $("wz-permissible-badge");
  if (badge) {
    if (wz?.permissible) {
      badge.textContent = wz.permissible.toUpperCase() + (wz.permissible === "green" ? " — PERMISSIBLE" : " — NOT PERMISSIBLE");
      badge.className = "wz-badge wz-badge-" + wz.permissible;
    } else {
      badge.textContent = "—";
      badge.className = "wz-badge wz-badge-none";
    }
  }

  const btn = $("wz-close");
  if (btn) { btn.textContent = spec ? "Reopen lane" : "Close lane"; btn.classList.toggle("on", !!spec); }

  // OFFLINE mode has no live SUMO/traci to actually re-route traffic off the closed lane — the
  // TTC overlay + RILCA numbers are schematic-only there. Make that explicit so it isn't mistaken
  // for LIVE physics (see live_server.py's per-step early-merge enforcement, LIVE-only).
  const note = $("wz-offline-note");
  if (note) note.classList.toggle("hidden", !(spec && !liveMode));
}

// ============================================================================ Component 4/5: DataConnect asset layer
// "Assets (DataConnect)" toggle: on first enable, log in + fetch the 6 DataConnect classes the
// design spec calls for, run them through the scoringA.js adapter + scorer, and place the result
// as ONE PointPrimitiveCollection (assetLayer.js). Deferred to first click (not boot) so the base
// SUMO/Cesium twin keeps loading instantly with zero DataConnect dependency.
let dcEnabled = false;
let dcCollection = null;   // the live PointPrimitiveCollection, or null if never loaded
let dcScored = [];         // last-good scored assets (kept on failure — keep-previous-on-failure)
let dcPollTimer = null;

// ---- UC1: Lane Closure Revenue Optimizer (design spec §4) — three toggleable layers built off
// the SAME DataConnect fetch above (loadDcAssets/loadDcSnapshot), plus the click-on-WO context
// panel. Each layer has its own on/off state, independent of the "Assets (DataConnect)" toggle.
let uc1WoCollection = null, uc1AccidentCollection = null, uc1InspectionCollection = null;
let uc1WoOn = false, uc1AccidentsOn = false, uc1InspectionsOn = false;
let uc1OpenWOs = [];            // openWorkOrders() rows — trigger list + pick index
let uc1Accidents = [];          // extractAccidents() rows
let uc1FailedInspections = [];  // failedInspections() rows (pooled across the 3 inspection classes)
let uc1Tickets = [];            // raw Tickets rows (ticket join in buildWorkOrderContext)
let uc1Incidents = [];          // raw Incidents_V3 rows (accident-history join)
let uc1Loaded = false;          // true once buildUc1() has run at least once (set even under
                                 // ?renderer=arcgis, where uc1*Collection stay null — see buildUc1)
let uc1CurrentWo = null;        // the WO currently shown in the context panel — the "Evaluate
                                 // closure windows" button's target (design spec §4 bullet 3/4)
let uc1CurrentContext = null;   // buildWorkOrderContext() output for uc1CurrentWo (its `counts`
                                 // feed the scheduled decision's evidence bundle's history counts)
const uc1DemandModel = createDemandModel(undefined, uc1Segments);   // P2-a demand.js, segment-scaled
let uc1DecisionQueue = [];      // in-memory queue of decision records that failed to POST — a
                                 // successful write opportunistically drains this (keep-previous-
                                 // on-failure, matching data/loader.ts's pattern per design spec
                                 // §4 bullet 3 "Error handling").
let uc1Viewer = null;           // the raw viewer, captured once by installUc1() — P5-e's trust/
                                 // exec-kpi/SUMO-run wiring is triggered from event handlers that
                                 // aren't nested inside main(), so it can't close over `viewer`.
let uc1AncillaryAssets = [];    // pooled off-corridor bucket (WO+accident+inspection) — RENDER-only
                                 // split (uc1Data.js's classifyCorridorAssets); scoring/context-panel
                                 // joins keep using the full unfiltered uc1OpenWOs/uc1Accidents/
                                 // uc1FailedInspections above, per that function's own contract.
let uc1AncillaryCollection = null, uc1AncillaryOn = false;
let uc1HeatmapCollection = null; // closure-impact heat map (Mic-Drop 3) — off by default, shown at
                                 // the demo-mode Step 5 zoom-out coda (scheduleUc1Decision).
const UC1_CORRIDOR_MAX_M = 500; // wider than uc1Data.js's generic 300 m default: matches the
                                 // storyboard's own "500 m" context-panel radius language, and
                                 // comfortably includes config/uc1Demo.json's hero WO (~309 m out).

// ---- Task C: UC1 demo-mode (startup tile + 5-step stepper) — storyboard §1/§5, uc1Mode.js ----
let uc1DemoActive = false;      // true once the stepper flow has been entered (?uc1=1 or the
                                 // startup tile's "Start the 6-minute demo" button)
let uc1Step = 1;                // mirrors uc1Mode.js's pure advanceUc1Step() state
let uc1StepperCtl = null;       // renderStepper()'s return value ({ setStep(n) })
const UC1_CORRIDOR_OVERVIEW = (() => {
  const lons = corridorCenterline.map((p) => p.lon);
  const lats = corridorCenterline.map((p) => p.lat);
  return { lon: (Math.min(...lons) + Math.max(...lons)) / 2, lat: (Math.min(...lats) + Math.max(...lats)) / 2 };
})();

// ---- P5-e: trust panel (backtest cache + live-editable assumptions) — design spec §4 "Trust
// panel" + Decision 2 (live stress-test moment). ----
let uc1BacktestResult = null;   // runBacktest() is deterministic given (incidents, segments,
                                 // config), which never change at runtime — computed once, cached.
let uc1Assumptions = null;      // trustPanel.js's assumptions shape; lazily built from
                                 // windowConfig.json + segments.json on first trust-panel open.

/** Lazily builds the live-editable assumptions object (trustPanel.js's expected shape) from the
 * committed config defaults — same values evaluateUc1Windows() would otherwise use unedited. */
function ensureUc1Assumptions() {
  if (uc1Assumptions) return uc1Assumptions;
  const segmentDemandScale = {};
  for (const s of uc1Segments) segmentDemandScale[s.id] = s.demandScale ?? 1;
  uc1Assumptions = mergeAssumptionDefaults({
    tollRateUsd: uc1WindowConfig.tollRateUsd,
    weights: uc1WindowConfig.weights,
    mergeFriction: uc1WindowConfig.mergeFriction,
    segmentDemandScale,
    segments: uc1Segments.map((s) => ({ id: s.id, name: s.name })),
  });
  return uc1Assumptions;
}

/** windowConfig.json clone with the live-editable assumptions fields overlaid — everything else
 * (candidateHeuristics, scoreNormalization, etc.) stays the committed default. */
function currentUc1WindowConfig() {
  const a = ensureUc1Assumptions();
  return { ...uc1WindowConfig, tollRateUsd: a.tollRateUsd, weights: { ...a.weights }, mergeFriction: a.mergeFriction };
}

/** A fresh demand model built from segments.json with each segment's demandScale overridden by
 * the live assumptions (demand.js takes segments as a plain init arg — see its header — so a new
 * model, not a mutation, is how a slider edit reaches it). */
function currentUc1DemandModel() {
  const a = ensureUc1Assumptions();
  const segs = uc1Segments.map((s) => ({ ...s, demandScale: a.segmentDemandScale[s.id] ?? s.demandScale }));
  return createDemandModel(undefined, segs);
}

// ---- P5-e: exec KPI strip (design spec §4 "Exec KPI strip" + Decision 5's seeded log). ----
let uc1Decisions = [];   // decisions fetched on UC1 activation (shim seed+runtime, or the
                          // snapshot fallback) + any locally-scheduled decision appended live.

// ---- P5-e: visible SUMO run on schedule (design spec Decision 6) ----
let uc1SelectedApLane = AP_LANES[0];  // approach lane chosen via click-on-twin (P5-e item 4),
                                       // read by both #wz-close's dropdown fallback and the
                                       // auto-triggered closure below.
let uc1AutoCloseTimer = null;         // pending auto-reopen after a scheduled decision's SUMO run.
const UC1_AUTO_CLOSE_MS = 20_000;
const AP_LANE_WIDTH_M = 3.7;          // AASHTO lane width — matches PLAZA_LANE_WIDTH_M elsewhere.
const AP_LANE_Y = { ap_0: -AP_LANE_WIDTH_M, ap_1: 0, ap_2: AP_LANE_WIDTH_M };
const AP_LANE_PICK_TOLERANCE_M = 40;  // click-on-twin tolerance around the lane-pick station.

const DC_CLASSES = {
  assetRegistry: "asset_registry",
  workOrders: "work_orders",
  safetyInspections: "safety_inspections_v3",
  roadwayInspections: "roadway_inspections_v3",
  itsInspections: "its_inspections_v3",
  incidents: "incidents_v3",
  tickets: TICKETS_CLASS,
};

function setDcStatusBadge(status) {
  const el = $("dc-status");
  if (!el) return;
  el.className = "dc-status " + status;
  el.textContent = "DataConnect: " + (status === "auth-failed" ? "auth failed" : status);
}

function renderDcAssetKpis(scored) {
  const el = $("dc-asset-kpis");
  if (!el) return;
  const bands = { red: 0, amber: 0, green: 0 };
  let top = null;
  for (const a of scored) {
    if (bands[a.band] != null) bands[a.band]++;
    if (!top || a.score > top.score) top = a;
  }
  el.classList.remove("hidden");
  el.innerHTML = `
    <div class="dc-asset-kpi red"><span class="v">${bands.red}</span><span class="l">Act now</span></div>
    <div class="dc-asset-kpi amber"><span class="v">${bands.amber}</span><span class="l">Watch</span></div>
    <div class="dc-asset-kpi green"><span class="v">${bands.green}</span><span class="l">Healthy</span></div>
    ${top ? `<div class="dc-top-risk">Top risk: <b>${top.label}</b> (${top.asset_tag}) · score ${(top.score * 100).toFixed(0)}</div>` : ""}
  `;

  // Debug hook for headless verification (e2e).
  window.__dcAssets = {
    count: scored.length,
    bands,
    topRisk: top ? { id: top.asset_tag, score: top.score } : null,
  };
}

function showDcAssetPanel(asset) {
  const panel = $("dc-asset-panel");
  if (!panel) return;
  const driversHtml = (asset.drivers || [])
    .map((d) => `<div class="dc-driver"><span>${d.label}</span><span class="dc-driver-val">${Math.round(d.contribution * 100)}%</span></div>`)
    .join("") || '<div class="dc-driver-none">No significant risk drivers</div>';
  const rel = asset._related || {};

  panel.classList.remove("hidden");
  panel.innerHTML = `
    <button id="dc-asset-panel-close" class="dc-panel-close" aria-label="Close">&times;</button>
    <div class="dc-panel-h">${asset.label}</div>
    <div class="dc-panel-sub">${asset.asset_tag} · ${asset.asset_class}</div>
    <div class="dc-panel-band ${asset.band}">${asset.band.toUpperCase()} · score ${(asset.score * 100).toFixed(0)}</div>
    <div class="dc-panel-row"><span>Location</span><span>${asset.location_desc}</span></div>
    <div class="dc-panel-row"><span>Install date</span><span>${asset.install_date}</span></div>
    <div class="dc-panel-row"><span>Last inspection</span><span>${asset.last_inspection_date}</span></div>
    <div class="dc-panel-row"><span>Last work order</span><span>${asset.last_workorder_date}</span></div>
    <div class="dc-panel-drivers">${driversHtml}</div>
    <div class="dc-panel-action">${asset.recommendedAction}</div>
    <div class="dc-panel-related">Work orders ${rel.workOrders || 0} · Inspections ${rel.inspections || 0} · Incidents ${rel.incidents || 0}</div>
  `;
  const closeBtn = $("dc-asset-panel-close");
  if (closeBtn) closeBtn.onclick = () => panel.classList.add("hidden");
}

function stopDcPolling() {
  if (dcPollTimer) { clearInterval(dcPollTimer); dcPollTimer = null; }
}
/** Lightweight background connectivity check while the layer is enabled — exercises the
 * offline/auth-failed badge transitions (e.g. the shim being killed) without re-fetching /
 * re-scoring / rebuilding the whole ~5k-point layer every tick. Data is only ever replaced on a
 * FULL successful reload (loadDcAssets), so a failed ping here just flips the badge and leaves
 * dcCollection/dcScored exactly as they were (keep-previous-on-failure). */
function startDcPolling() {
  stopDcPolling();
  dcPollTimer = setInterval(() => {
    fetchClass(DC_CLASSES.assetRegistry, { pageSize: 1 }).catch(() => {});
  }, 15_000);
}

async function loadDcAssets(viewer) {
  try {
    await login();
    const [assetRegistry, workOrders, safetyInspections, roadwayInspections, itsInspections, incidents, tickets] =
      await Promise.all([
        fetchClass(DC_CLASSES.assetRegistry, { pageSize: 500 }),
        fetchClass(DC_CLASSES.workOrders, { pageSize: 500 }),
        fetchClass(DC_CLASSES.safetyInspections, { pageSize: 500 }),
        fetchClass(DC_CLASSES.roadwayInspections, { pageSize: 500 }),
        fetchClass(DC_CLASSES.itsInspections, { pageSize: 500 }),
        fetchClass(DC_CLASSES.incidents, { pageSize: 500 }),
        fetchClass(DC_CLASSES.tickets, { pageSize: 500 }),
      ]);
    const raw = adaptDataConnectAssets({
      assetRegistry, workOrders, safetyInspections, roadwayInspections, itsInspections, incidents, tickets,
    });
    const scored = scoreAssets(raw, []);

    // Only now, with a fully-scored replacement in hand, touch the live layer/state.
    const prevCollection = dcCollection;
    dcCollection = buildAssetLayer(viewer, scored);
    dcCollection.show = dcEnabled; // UC1 layers can trigger this load without the DC toggle being on
    if (prevCollection) disposeAssetLayer(viewer, prevCollection);
    dcScored = scored;
    renderDcAssetKpis(scored);
    if (!dcEnabled) $("dc-asset-kpis")?.classList.add("hidden"); // UC1-triggered load, DC toggle still off
    startDcPolling();
    buildUc1(viewer, { assetRegistry, workOrders, safetyInspections, roadwayInspections, itsInspections, incidents, tickets });
  } catch (err) {
    console.warn("[DataConnect] asset load failed — keeping previous layer/data", err);
    // keep-previous-on-failure: dcCollection/dcScored/window.__dcAssets are left untouched.
    // Static-host fallback: no live API AND nothing loaded yet -> one-shot snapshot of the same
    // class JSONs shipped with the build (public/dataconnect-data/, produced by
    // tools/dataconnect_export.py). Same adapter + scoring path; only the transport differs.
    if (!dcScored.length) await loadDcSnapshot(viewer);
  }
}

async function loadDcSnapshot(viewer) {
  try {
    const get = (name) => fetch(asset(`/dataconnect-data/${name}.json`)).then((r) => {
      if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw new Error(name);
      return r.json();
    });
    const [assetRegistry, workOrders, safetyInspections, roadwayInspections, itsInspections, incidents, tickets] =
      await Promise.all([
        get(DC_CLASSES.assetRegistry), get(DC_CLASSES.workOrders), get(DC_CLASSES.safetyInspections),
        get(DC_CLASSES.roadwayInspections), get(DC_CLASSES.itsInspections), get(DC_CLASSES.incidents),
        get(DC_CLASSES.tickets),
      ]);
    const scored = scoreAssets(adaptDataConnectAssets({
      assetRegistry, workOrders, safetyInspections, roadwayInspections, itsInspections, incidents, tickets,
    }), []);
    const prevCollection = dcCollection;
    dcCollection = buildAssetLayer(viewer, scored);
    dcCollection.show = dcEnabled; // UC1 layers can trigger this load without the DC toggle being on
    if (prevCollection) disposeAssetLayer(viewer, prevCollection);
    dcScored = scored;
    renderDcAssetKpis(scored);
    if (!dcEnabled) $("dc-asset-kpis")?.classList.add("hidden");
    stopDcPolling(); // snapshot mode is static — no live endpoint to poll
    setDcStatusBadge("snapshot");
    buildUc1(viewer, { assetRegistry, workOrders, safetyInspections, roadwayInspections, itsInspections, incidents, tickets });
  } catch (err) {
    console.warn("[DataConnect] snapshot fallback unavailable", err);
  }
}

/**
 * buildUc1(viewer, {assetRegistry, workOrders, tickets, safetyInspections, roadwayInspections,
 * itsInspections, incidents}) — rebuilds the three UC1 trigger layers (design spec §4 bullet 1)
 * off the same raw DataConnect classes loadDcAssets()/loadDcSnapshot() just fetched, and stashes
 * the normalized data uc1's context panel needs for its 500m spatial join (uc1Data.js's
 * buildWorkOrderContext()). Swap-then-dispose, same keep-previous-on-failure posture as the asset
 * layer above (this only ever runs after a successful DC load, so "previous" here just means
 * "replaced", never "left half-built").
 */
function buildUc1(viewer, { assetRegistry, workOrders, tickets, safetyInspections, roadwayInspections, itsInspections, incidents }) {
  uc1Accidents = extractAccidents(assetRegistry);
  uc1OpenWOs = openWorkOrders({ assetRegistry, workOrders, tickets, safetyInspections, roadwayInspections, itsInspections });
  uc1FailedInspections = failedInspections([...(safetyInspections || []), ...(roadwayInspections || []), ...(itsInspections || [])]);
  uc1Tickets = tickets || [];
  uc1Incidents = incidents || [];
  uc1Loaded = true;
  loadUc1ExecKpis(); // P5-e item 2: "on UC1 activation" — fire-and-forget, handles its own failures

  // Cesium-only feature (matches installDataConnectAssets' own guard): under ?renderer=arcgis
  // there is no viewer.scene, so the data above still populates (context panel needs it) but no
  // primitive layers are built.
  if (!viewer?.scene?.canvas) return;

  // Render-only corridor split (uc1Data.js's classifyCorridorAssets — a RENDERING split, never a
  // data drop: uc1OpenWOs/uc1Accidents/uc1FailedInspections above stay the FULL unfiltered arrays
  // for scoring/context-panel joins; only the map layers below use the split buckets).
  const woSplit = classifyCorridorAssets(uc1OpenWOs, corridorCenterline, UC1_CORRIDOR_MAX_M);
  const accSplit = classifyCorridorAssets(uc1Accidents, corridorCenterline, UC1_CORRIDOR_MAX_M);
  const inspSplit = classifyCorridorAssets(uc1FailedInspections, corridorCenterline, UC1_CORRIDOR_MAX_M);
  uc1AncillaryAssets = [...woSplit.ancillary, ...accSplit.ancillary, ...inspSplit.ancillary];

  const prevWo = uc1WoCollection, prevAcc = uc1AccidentCollection, prevInsp = uc1InspectionCollection;
  const prevAncillary = uc1AncillaryCollection, prevHeatmap = uc1HeatmapCollection;
  uc1WoCollection = buildWorkOrderLayer(viewer, woSplit.onCorridor);
  uc1AccidentCollection = buildAccidentLayer(viewer, accSplit.onCorridor);
  uc1InspectionCollection = buildInspectionLayer(viewer, inspSplit.onCorridor);
  uc1AncillaryCollection = buildAncillaryLayer(viewer, uc1AncillaryAssets); // starts hidden (buildAncillaryLayer default)
  uc1HeatmapCollection = buildImpactHeatmap(viewer, { accidents: uc1Accidents, incidents: uc1Incidents, segments: uc1Segments });
  uc1HeatmapCollection.show = false; // shown only at the demo-mode Step 5 zoom-out coda
  uc1WoCollection.show = uc1WoOn;
  uc1AccidentCollection.show = uc1AccidentsOn;
  uc1InspectionCollection.show = uc1InspectionsOn;
  uc1AncillaryCollection.show = uc1AncillaryOn;
  if (prevWo) disposeUc1Layer(viewer, prevWo);
  if (prevAcc) disposeUc1Layer(viewer, prevAcc);
  if (prevInsp) disposeUc1Layer(viewer, prevInsp);
  if (prevAncillary) disposeUc1Layer(viewer, prevAncillary);
  if (prevHeatmap) disposeUc1Layer(viewer, prevHeatmap);
  renderUc1AncillaryToggle();
}

/** Updates the "N off-corridor assets" disclosure button's label (storyboard §7's ancillary-
 * disclosure requirement) — called after every buildUc1() rebuild so the count stays current. */
function renderUc1AncillaryToggle() {
  const btn = $("btn-uc1-ancillary");
  if (!btn) return;
  btn.textContent = `${uc1AncillaryAssets.length} off-corridor assets`;
}

/** P5-e item 2: exec KPI strip — fetches the "decisions" class (shim merges committed seed +
 * gitignored runtime log) via dataconnect.js on UC1 activation, falling back to the committed
 * seed snapshot when the shim is unreachable (static-host / offline posture, same as
 * loadDcSnapshot). computeExecKpis() must work off the seed alone (Decision 5) so an empty/failed
 * fetch still renders a non-empty strip as long as the snapshot loads. */
async function loadUc1ExecKpis() {
  let decisions = [];
  try {
    decisions = await fetchClass("decisions", { pageSize: 500 });
  } catch (err) {
    console.warn("[UC1] decisions fetch failed — falling back to the seed snapshot", err);
    try {
      const res = await fetch(asset("/dataconnect-data/decisions_seed.json"));
      if (res.ok && (res.headers.get("content-type") || "").includes("json")) decisions = await res.json();
    } catch (err2) {
      console.warn("[UC1] decisions seed snapshot unavailable", err2);
    }
  }
  uc1Decisions = Array.isArray(decisions) ? decisions : [];
  renderUc1ExecKpiStrip();
}

/** computeExecKpis() (pure, execKpis.js) -> renderExecKpiStrip() (DOM). Re-run whenever
 * uc1Decisions changes — on activation (loadUc1ExecKpis) and after every scheduled decision
 * (scheduleUc1Decision appends locally rather than re-fetching, mirroring Decision 5's "the live
 * decision appends to the seeded log"). */
function renderUc1ExecKpiStrip() {
  const kpis = computeExecKpis(uc1Decisions);
  renderExecKpiStrip($("uc1-exec-kpi-strip"), kpis);
  window.__uc1ExecKpis = kpis; // debug hook for headless verification (e2e)
}

/** Assembles + renders a picked work order's 500m context (contextPanel.js's Mic-Drop-1 panel),
 * then appends the "Evaluate closure windows" button (design spec §4 bullet 3) — contextPanel.js
 * stays a pure renderer (its own docstring defers this wiring to "a later phase"/main.js), so the
 * button is appended here rather than baked into that module's innerHTML. */
function openUc1WorkOrderContext(wo) {
  const ctx = buildWorkOrderContext(wo, {
    assets: dcScored,
    accidents: uc1Accidents,
    inspections: uc1FailedInspections,
    tickets: uc1Tickets,
    incidents: uc1Incidents,
  });
  uc1CurrentWo = wo;
  uc1CurrentContext = ctx;
  renderWorkOrderContext($("uc1-context-panel"), { ...ctx, workOrder: wo }, { onRowFocus: focusUc1ContextRow });
  appendUc1EvaluateButton(wo);
  // A newly-picked WO invalidates any window table left over from a different WO.
  $("uc1-window-panel")?.classList.add("hidden");
  // Debug hook for headless verification (e2e) — mirrors window.__dcAssets's shape convention.
  window.__uc1Context = { workOrderId: wo?.id ?? null, counts: ctx.counts };

  // Demo-mode Step 1 -> Step 2 (storyboard §1 "Context"): tighten the camera to the ~500 m local
  // framing the deck's mic-drop moment 1 describes ("everything within 500 m... one glance").
  if (uc1DemoActive) {
    uc1Advance("pickWorkOrder");
    if (uc1Viewer && typeof wo?.lon === "number" && typeof wo?.lat === "number") {
      flyToLonLat(uc1Viewer, wo.lon, wo.lat, 500);
    }
  }
}

/** contextPanel.js's onRowFocus callback (Task F1 bullet 2): a picked context-panel row (failed
 * inspection / accident / nearby asset) flies the camera to that record's own lon/lat and drops a
 * short pulsing highlight there (uc1Layers.js's pulseUc1Point) — so clicking "risk 5 · S-66136"
 * actually shows the planner where that asset sits, not just an inline text expansion. Tighter
 * framing than the 500m WO-context flyTo (openUc1WorkOrderContext) since this is a single point,
 * not "everything nearby". No-ops (silently) on a record with no resolvable numeric lon/lat (e.g.
 * a ticket row, which carries none) — same defensive posture as flyToLonLat/pulseUc1Point
 * themselves. Exposed via a debug hook for headless e2e verification. */
function focusUc1ContextRow(record) {
  window.__uc1LastRowFocus = record ? { lon: record.lon, lat: record.lat } : null; // e2e debug hook
  if (!uc1Viewer || typeof record?.lon !== "number" || typeof record?.lat !== "number") return;
  flyToLonLat(uc1Viewer, record.lon, record.lat, 180);
  pulseUc1Point(uc1Viewer, record.lon, record.lat);
}

/** Appends "Evaluate closure windows" to the just-rendered context panel. No-ops if the panel
 * ended up hidden (renderWorkOrderContext hides+clears on a missing/empty context). */
function appendUc1EvaluateButton(wo) {
  const panel = $("uc1-context-panel");
  if (!panel || panel.classList.contains("hidden")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "uc1-evaluate-btn";
  btn.className = "uc1-win-schedule-btn uc1-evaluate-btn";
  btn.textContent = "Evaluate closure windows";
  btn.onclick = () => evaluateUc1Windows(wo);
  panel.appendChild(btn);
}

/** "Evaluate closure windows" -> windowAssembly.js's evaluateCandidates() (P2 demand.js x
 * windowEval.js, pure) -> windowPanel.js's renderWindowPanel(), wired so its "Schedule this
 * window" buttons call scheduleUc1Decision(). Design spec §4 bullet 3.
 *
 * Uses currentUc1WindowConfig()/currentUc1DemandModel() (not the committed defaults) so the
 * table reflects any live trust-panel assumption edits — this is what re-running evaluateUc1Windows
 * from onAssumptionChange turns into the "stress-test" re-rank (design spec Decision 2, P5-e item 1).
 */
function evaluateUc1Windows(wo) {
  uc1CurrentWo = wo;
  const data = evaluateCandidates(wo, {
    segments: uc1Segments,
    incidents: uc1Incidents,
    windowConfig: currentUc1WindowConfig(),
    demandModel: currentUc1DemandModel(),
  });

  // Demo-mode Step 2 -> Step 3 (storyboard §1 "Simulate"): run the EXISTING visible-SUMO-run
  // machinery (Decision 6, triggerUc1VisibleSumoRun) now, for the winning candidate window, so the
  // "traffic flows, queues build, vehicles divert" beat plays during evaluation — not just later at
  // schedule time (which still fires its own run for whichever window the planner actually picks).
  if (uc1DemoActive) {
    uc1Advance("evaluate");
    const win = data.windows[data.winnerIdx], result = data.results[data.winnerIdx];
    if (win && result) triggerUc1VisibleSumoRun(win, result);
  }

  renderWindowPanel($("uc1-window-panel"), { ...data, workOrder: wo }, (win, result, rank) =>
    scheduleUc1Decision(wo, win, result, rank)
  );
  appendUc1TrustButton(wo);
  // Debug hook for headless verification (e2e) — mirrors window.__dcAssets's shape convention.
  window.__uc1Windows = { count: data.results.length, winnerIdx: data.winnerIdx };

  // Demo-mode Step 3 -> Step 4 (storyboard §9 "the money shot"): the ranked table is up — pull the
  // camera back from the tight sim view to a comparison scale so both the twin and the table read.
  if (uc1DemoActive) {
    uc1Advance("resultsRendered");
    const plaza = uc1PlazaLonLat();
    if (uc1Viewer && plaza) flyToLonLat(uc1Viewer, plaza.lon, plaza.lat, 900);
  }
}

/** Appends "Why trust this?" to the just-rendered window panel (design spec §4 "Trust panel" —
 * same append-after-render split as appendUc1EvaluateButton, windowPanel.js stays a pure
 * renderer). Also wraps the panel's own close button so closing it reopens any lane the schedule
 * flow auto-closed for the visible SUMO run (P5-e item 3, Decision 6's "... or on panel close"). */
function appendUc1TrustButton(wo) {
  const panel = $("uc1-window-panel");
  if (!panel || panel.classList.contains("hidden")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "uc1-trust-btn";
  btn.className = "uc1-win-schedule-btn uc1-trust-btn";
  btn.textContent = "Why trust this?";
  btn.onclick = () => openUc1TrustPanel(wo);
  panel.appendChild(btn);

  const closeBtn = panel.querySelector(".dc-panel-close");
  if (closeBtn) {
    const prevOnClick = closeBtn.onclick;
    closeBtn.onclick = (ev) => {
      reopenUc1AutoClosure();
      if (typeof prevOnClick === "function") prevOnClick(ev);
    };
  }
}

/** "Why trust this?" -> backtest.js's runBacktest() (cached — deterministic, computed once) +
 * trustPanel.js's renderTrustPanel(). onAssumptionChange re-runs evaluateUc1Windows() for the
 * currently-open WO so the window table re-ranks live off the edited assumptions (the slide-11
 * "stress-test" moment — Decision 2). */
function openUc1TrustPanel(wo) {
  if (!uc1BacktestResult) {
    uc1BacktestResult = runBacktest({ incidents: uc1Incidents, segments: uc1Segments, config: uc1BacktestConfig });
  }
  renderTrustPanel($("uc1-trust-panel"), {
    backtestResult: uc1BacktestResult,
    assumptions: ensureUc1Assumptions(),
    onAssumptionChange: (next) => {
      uc1Assumptions = next;
      if (uc1CurrentWo) evaluateUc1Windows(uc1CurrentWo);
    },
  });
  // Debug hook for headless verification (e2e).
  window.__uc1Trust = { open: true, workOrderId: wo?.id ?? uc1CurrentWo?.id ?? null };
}

/** Builds the decision's evidence bundle (design spec §4: window inputs, toll rate, demand slice
 * summary, history counts from the currently-open context panel) for a scheduled window.
 * `win` (NOT `window` — must not shadow the global, see scheduleUc1Decision's debug hook). */
function buildUc1DecisionRecord(wo, win, result, rank) {
  const slices = result?.queue?.slices || [];
  const vphValues = slices.map((s) => s.demandVph ?? 0);
  const counts = (uc1CurrentWo === wo && uc1CurrentContext?.counts) || {};
  return {
    decisionId: `${wo?.id ?? "unknown"}-${win.id}-${Date.now()}`,
    workOrderId: wo?.id ?? null,
    segment: wo?.segment ?? null,
    segmentId: result.segmentId,
    window: {
      id: win.id,
      label: win.label,
      startIso: win.start.toISOString(),
      durationHours: win.durationHours,
    },
    rank,
    score: result.score,
    tollRateUsd: currentUc1WindowConfig().tollRateUsd,
    revenueAtRiskUsd: result.revenueAtRiskUsd,
    avgDelayMin: result.queue?.avgDelayMin ?? null,
    laneAvailabilityPct: result.laneAvailabilityPct,
    secondaryCrashExposure: result.secondaryCrashExposure,
    demandSliceSummary: {
      sliceCount: slices.length,
      totalArrivalsVeh: result.queue?.totalArrivals ?? null,
      avgVph: vphValues.length ? vphValues.reduce((a, b) => a + b, 0) / vphValues.length : null,
      maxVph: vphValues.length ? Math.max(...vphValues) : null,
    },
    historyCounts: {
      hasTicket: !!counts.hasTicket,
      inspections: counts.inspections ?? 0,
      accidents: counts.accidents ?? 0,
    },
    scheduledAtIso: new Date().toISOString(),
    source: "cesium-poc-uc1-demo",
  };
}

/** Sets the "decisions: …" badge in the same visual idiom as #dc-status (setDcStatusBadge). */
function setUc1DecisionsBadge(status, text) {
  const el = $("uc1-decisions-status");
  if (!el) return;
  el.className = "dc-status " + status;
  el.textContent = text;
}

/** Opportunistically drains uc1DecisionQueue on a successful write; stops at the first failure
 * (still offline) and leaves the remainder queued. */
async function flushUc1DecisionQueue() {
  while (uc1DecisionQueue.length) {
    const rec = uc1DecisionQueue[0];
    try {
      await writeRecord("decisions", rec);
      uc1DecisionQueue.shift();
    } catch {
      return;
    }
  }
}

/** Schedule action (design spec §4 bullet 3 "Schedule action"): POST the evidence-bundle decision
 * record to the shim's write endpoint via dataconnect.js's writeRecord(). Keep-previous-on-failure:
 * a failed write queues the record in memory and flips the "decisions" badge offline, matching the
 * existing #dc-status badge idiom — nothing already scheduled/rendered is rolled back.
 * `win` (NOT `window` — a param literally named `window` would shadow the global for the rest of
 * this function's body, silently breaking the `window.__uc1Decisions` debug hook below). */
async function scheduleUc1Decision(wo, win, result, rank) {
  const record = buildUc1DecisionRecord(wo, win, result, rank);
  try {
    await writeRecord("decisions", record);
    await flushUc1DecisionQueue();
    setUc1DecisionsBadge("online", `decisions: logged (${record.window.label})`);
    setStatus(`✓ Scheduled ${record.window.label} — decision logged (rank ${rank}).`);
    // Decision 5: the live decision appends to the seeded exec-KPI log (no re-fetch needed).
    uc1Decisions = [...uc1Decisions, record];
    renderUc1ExecKpiStrip();
    // Decision 6: the winning window triggers one visible SUMO run — only on a SUCCESSFUL
    // schedule (an offline/queued decision gets no camera move / closure, per spec).
    triggerUc1VisibleSumoRun(win, result);
    // Demo-mode Step 4 -> Step 5 (storyboard §1 "Decide" + §8 Mic-Drop 3): the decision-logged toast
    // is setStatus() above; here, the corridor-scale heat-map zoom-out coda + an exec-KPI-strip
    // highlight so the "if you did this every time" close (storyboard §6) lands visually.
    if (uc1DemoActive) {
      uc1Advance("schedule");
      if (uc1HeatmapCollection) uc1HeatmapCollection.show = true;
      flyToCorridorOverview(uc1Viewer);
      highlightUc1ExecKpiStrip();
    }
  } catch (err) {
    console.warn("[UC1] decision write failed — queued in memory", err);
    uc1DecisionQueue.push(record);
    setUc1DecisionsBadge("offline", `decisions: offline (${uc1DecisionQueue.length} queued)`);
    setStatus("⚠ Could not log the decision (DataConnect offline) — queued locally.");
  }
  // Debug hook for headless verification (e2e).
  window.__uc1Decisions = { queued: uc1DecisionQueue.length, lastRecord: record };
}

/** Decision 6: "the winning window triggers one visible SUMO run" — fly the camera to the plaza,
 * then reuse the EXISTING closure machinery (closeLaneHook) for the click-on-twin-selected
 * approach lane: LIVE mode forwards the real closeLane command over the websocket (real traci
 * physics); OFFLINE mode gets the same client-side work-zone overlay + schematic RILCA KPIs the
 * manual "Close lane" button produces (closeLaneHook already branches on `liveMode` — no new
 * physics here). Auto-reopens after UC1_AUTO_CLOSE_MS, or sooner if the window panel is closed
 * (reopenUc1AutoClosure, wired in appendUc1TrustButton) or another decision is scheduled first. */
function triggerUc1VisibleSumoRun(win, result) {
  void result; // reserved for a future per-window closure spec; today's spec is the fixed demo default
  const viewer = uc1Viewer;
  if (!viewer || !T) return;

  const boothX = META ? META.boothX : T.p.sumoRefX;
  const { lon, lat } = T.sumoToLonLat(boothX, 0);
  flyToLonLat(viewer, lon, lat, 260);

  const lane = uc1SelectedApLane || AP_LANES[0];
  if (activeWorkzoneSpec && activeWorkzoneSpec.lane !== lane) openLaneHook(viewer, activeWorkzoneSpec.lane);
  closeLaneHook(viewer, lane, { offsetFt: 12, speedMph: 60 });

  const isLive = liveMode && ws && ws.readyState === WebSocket.OPEN;
  setStatus(
    isLive
      ? `▶ SUMO run started — closing ${lane} for ${win.label}.`
      : `▶ ${win.label} scheduled — live SUMO feed offline, showing work-zone overlay for ${lane}.`
  );

  if (uc1AutoCloseTimer) clearTimeout(uc1AutoCloseTimer);
  uc1AutoCloseTimer = setTimeout(() => {
    uc1AutoCloseTimer = null;
    if (activeWorkzoneSpec?.lane === lane) openLaneHook(viewer, lane);
  }, UC1_AUTO_CLOSE_MS);
}

/** Reopens whatever lane triggerUc1VisibleSumoRun auto-closed, cancelling the pending timeout —
 * called when the window panel is closed early (design spec Decision 6's "... or on panel close"). */
function reopenUc1AutoClosure() {
  if (uc1AutoCloseTimer) { clearTimeout(uc1AutoCloseTimer); uc1AutoCloseTimer = null; }
  if (uc1Viewer && activeWorkzoneSpec) openLaneHook(uc1Viewer, activeWorkzoneSpec.lane);
}

/** Shared deferred-load guard (installUc1's layer toggles AND startUc1Demo below both need it):
 * the first caller of ANY kind triggers the one shared DataConnect fetch. */
async function ensureUc1DataLoaded(viewer) {
  if (!uc1Loaded) await loadDcAssets(viewer);
}

/** Lon/lat of the SUMO plaza's booth line (T.sumoToLonLat), the same point
 * triggerUc1VisibleSumoRun() flies to — factored out so the demo-mode Step 3->4 camera pull can
 * reuse it without duplicating the T/META plumbing. Returns null before T is set (never during
 * normal boot — every site ships a default transform). */
function uc1PlazaLonLat() {
  if (!T) return null;
  const boothX = META ? META.boothX : T.p.sumoRefX;
  return T.sumoToLonLat(boothX, 0);
}

/** Fly to the whole I-595 corridor at a glance (storyboard §1 Step 1 + §8 Mic-Drop 3's zoom-out
 * coda) — the midpoint of config/corridorCenterline.json's bounding box, high enough to see the
 * full ~23 km span. */
function flyToCorridorOverview(viewer) {
  flyToLonLat(viewer, UC1_CORRIDOR_OVERVIEW.lon, UC1_CORRIDOR_OVERVIEW.lat, 24000);
}

/** Briefly outlines the exec KPI strip (storyboard §1 Step 5 + §3's "standing corridor/quarterly
 * KPI strip" — the thing left on screen when the demo ends). Plain inline style (no new CSS class)
 * so this stays a main.js-only change. */
function highlightUc1ExecKpiStrip() {
  const el = $("uc1-exec-kpi-strip");
  if (!el) return;
  el.style.transition = "box-shadow .3s ease";
  el.style.boxShadow = "0 0 0 3px rgba(47, 109, 246, 0.55)";
  setTimeout(() => { el.style.boxShadow = ""; }, 2600);
}

/** advanceUc1Step (uc1Mode.js, pure) <-> the live stepper DOM + e2e debug hook. No-ops (via the
 * pure function's own no-op-on-mismatch rule) unless demo mode is active. */
function uc1Advance(event) {
  if (!uc1DemoActive) return;
  uc1Step = advanceUc1Step(uc1Step, event);
  uc1StepperCtl?.setStep(uc1Step);
  window.__uc1Step = uc1Step; // debug hook for headless verification (e2e)
}

/** Enters UC1 demo mode (storyboard §1/§5): hides the generic-twin HUD (uc1Mode.js's
 * enterUc1Mode(), CSS-only via body.uc1-mode), shows the 5-step stepper at Step 1, flies to the
 * corridor overview, and — same deferred-load pattern as the layer toggle buttons — loads the
 * DataConnect data if it hasn't already, then turns the WO layer on (ancillary stays off) so the
 * "glowing work orders" are visible the moment the twin is ready. */
async function startUc1Demo(viewer) {
  uc1DemoActive = true;
  uc1Step = resetUc1Step();
  hideStartupTile($("uc1-startup-tile"));
  enterUc1Mode();
  const stepperEl = $("uc1-stepper");
  stepperEl?.classList.remove("hidden");
  uc1StepperCtl = renderStepper(stepperEl, uc1Step, { onExit: () => exitUc1DemoMode(viewer) });
  window.__uc1Step = uc1Step;
  flyToCorridorOverview(viewer);
  setStatus("UC1 demo — Step 1 Trigger: 154 open work orders queued; one is about to glow.");

  await ensureUc1DataLoaded(viewer);
  uc1WoOn = true;
  $("btn-uc1-wo")?.classList.add("on");
  if (uc1WoCollection) uc1WoCollection.show = true;
  uc1AncillaryOn = false;
  $("btn-uc1-ancillary")?.classList.remove("on");
  if (uc1AncillaryCollection) uc1AncillaryCollection.show = false;
  window.__uc1DemoReady = true; // debug hook: data loaded + WO layer on, ready for the hero pick
}

/** Exits UC1 demo mode ("Exit demo" link in the stepper, storyboard §1's design rule doesn't cover
 * this explicitly, but the startup tile's "Explore" sibling action implies the same restore): shows
 * the generic-twin HUD again and reframes the plaza — "today's sandbox unchanged". */
function exitUc1DemoMode(viewer) {
  uc1DemoActive = false;
  exitUc1Mode();
  $("uc1-stepper")?.classList.add("hidden");
  setStatus("Exited UC1 demo — sandbox controls restored.");
  frameCamera(viewer);
}

/** "UC1 demo" hero shortcut (design spec §4, Mic-Drop 1): fly to config/uc1Demo.json's pinned
 * hero work order and open its context panel. No-ops with a console warning if the current
 * dataset doesn't contain that WO id (e.g. a future re-export moves/closes it). */
function openUc1Demo(viewer) {
  const wo = uc1OpenWOs.find((w) => w.id === uc1Demo.heroWorkOrderId);
  if (!wo) {
    console.warn("[UC1] hero work order not found in current dataset:", uc1Demo.heroWorkOrderId);
    return;
  }
  if (typeof wo.lon === "number" && typeof wo.lat === "number") flyToLonLat(viewer, wo.lon, wo.lat);
  openUc1WorkOrderContext(wo);
}

/** Wires the three UC1 layer toggles + "UC1 demo" hero button + WO-pick -> context-panel path.
 * Mirrors installDataConnectAssets()'s deferred-load pattern: the first click of ANY of these
 * controls triggers the shared DataConnect fetch (loadDcAssets) if it hasn't run yet; each layer
 * then toggles independently off that one shared load. */
function installUc1(viewer) {
  uc1Viewer = viewer; // P5-e: captured for the trust-panel/exec-KPI/SUMO-run handlers below, which
                       // fire from DOM callbacks that don't otherwise close over main()'s `viewer`.
  const woBtn = $("btn-uc1-wo"), accBtn = $("btn-uc1-accidents"), inspBtn = $("btn-uc1-inspections"), demoBtn = $("btn-uc1-demo");
  const ancillaryBtn = $("btn-uc1-ancillary");
  const ensureUc1Loaded = () => ensureUc1DataLoaded(viewer);

  if (woBtn) {
    woBtn.onclick = async () => {
      await ensureUc1Loaded();
      uc1WoOn = !uc1WoOn;
      woBtn.classList.toggle("on", uc1WoOn);
      if (uc1WoCollection) uc1WoCollection.show = uc1WoOn;
    };
  }
  if (accBtn) {
    accBtn.onclick = async () => {
      await ensureUc1Loaded();
      uc1AccidentsOn = !uc1AccidentsOn;
      accBtn.classList.toggle("on", uc1AccidentsOn);
      if (uc1AccidentCollection) uc1AccidentCollection.show = uc1AccidentsOn;
    };
  }
  if (inspBtn) {
    inspBtn.onclick = async () => {
      await ensureUc1Loaded();
      uc1InspectionsOn = !uc1InspectionsOn;
      inspBtn.classList.toggle("on", uc1InspectionsOn);
      if (uc1InspectionCollection) uc1InspectionCollection.show = uc1InspectionsOn;
    };
  }
  if (demoBtn) {
    demoBtn.onclick = async () => {
      await ensureUc1Loaded();
      uc1WoOn = true; // hero point must be visible to fly to it
      woBtn?.classList.add("on");
      if (uc1WoCollection) uc1WoCollection.show = true;
      openUc1Demo(viewer);
    };
  }
  if (ancillaryBtn) {
    ancillaryBtn.onclick = async () => {
      await ensureUc1Loaded();
      uc1AncillaryOn = !uc1AncillaryOn;
      ancillaryBtn.classList.toggle("on", uc1AncillaryOn);
      if (uc1AncillaryCollection) uc1AncillaryCollection.show = uc1AncillaryOn;
    };
  }

  // Cesium-only pick path (same guard as installDataConnectAssets — no viewer.scene under ArcGIS).
  if (!viewer?.scene?.canvas) return;
  installAssetPicking(viewer, (position) => {
    const picked = pickUc1Point(viewer, position);
    if (picked && picked.kind === "workOrder") openUc1WorkOrderContext(picked.record);
  });
  installUc1LanePick(viewer); // P5-e item 4: click-on-twin approach-lane pick
}

function installDataConnectAssets(viewer) {
  onStatus(setDcStatusBadge);

  const btn = $("btn-dc-assets");
  if (btn) {
    btn.onclick = async () => {
      dcEnabled = !dcEnabled;
      btn.classList.toggle("on", dcEnabled);
      if (!dcEnabled) {
        stopDcPolling();
        if (dcCollection) dcCollection.show = false;
        $("dc-asset-kpis")?.classList.add("hidden");
        $("dc-asset-panel")?.classList.add("hidden");
        return;
      }
      if (dcCollection) {
        dcCollection.show = true;
        $("dc-asset-kpis")?.classList.remove("hidden");
        startDcPolling();
        return;
      }
      await loadDcAssets(viewer);
    };
  }

  // Cesium-only feature: the point-primitive layer + pick handler need a Cesium Scene. Under
  // ?renderer=arcgis there is no viewer.scene — leave the panel visible but inert (badge stays
  // offline) rather than crashing boot.
  if (!viewer?.scene?.canvas) return;
  installAssetPicking(viewer, (position) => {
    if (!dcEnabled || !dcCollection || !dcCollection.show) return;
    const a = pickAsset(viewer, position);
    if (a) showDcAssetPanel(a);
  });
}

// ============================================================================ MARK GATES (user clicks each real toll gate)
// The user marks the road direction (2 clicks) then clicks each real toll gate on the aerial.
// Marking rebuilds T from the clicks, then reloads vehicles (placed via T.sumoToWorld) AND
// rebuilds booth markers (also via T.sumoToWorld) — so traffic and markers always coincide.
const mark = { on: false, dir: [], gates: [] };
function buildTransformFromMarks(dir, gates) {
  const [up, down] = dir;
  const mLat = 110540, mLon0 = 111320 * Math.cos(toRad(up.lat));
  const bearingDeg = ((Math.atan2((down.lon - up.lon) * mLon0, (down.lat - up.lat) * mLat) * 180) / Math.PI + 360) % 360;
  const anchorLon = gates.reduce((s, g) => s + g.lon, 0) / gates.length;
  const anchorLat = gates.reduce((s, g) => s + g.lat, 0) / gates.length;
  const mLon = 111320 * Math.cos(toRad(anchorLat));
  const Br = toRad(bearingDeg);
  const perp = (g) => ((g.lon - anchorLon) * mLon) * -Math.cos(Br) + ((g.lat - anchorLat) * mLat) * Math.sin(Br);
  const ps = gates.map(perp);
  const span = (Math.max(...ps) - Math.min(...ps)) || 1;
  // Fixed plaza span (NOT meta.bounds — see PLAZA_HALF_SPAN_M comment): the marked gates span the
  // real booth line, which is only ever the straight plaza core, regardless of how far the curved
  // approach/departure trajectory bounds extend.
  const sumoSpan = PLAZA_HALF_SPAN_M * 2;
  return new CoordinateTransform({ anchorLon, anchorLat, bearingDeg, scale: span / sumoSpan, sumoRefX: META.boothX, sumoRefY: 0 });
}
function finishMarking(viewer, btn) {
  if (mark.dir.length < 2 || mark.gates.length < 2) { setStatus("Mark up-road, down-road, then at least 2 gates."); return; }
  // Build a new T from the user's clicks; BOTH vehicles and booth markers use T.sumoToWorld.
  setTransform(buildTransformFromMarks(mark.dir, mark.gates));
  calibrated = true; mark.on = false;
  btn.textContent = "⊕ Mark gates"; btn.classList.remove("on", "pulse");
  try { localStorage.setItem(siteKey(siteId), JSON.stringify({ t: T.toJSON(), g: mark.gates })); } catch {}
  console.log("MARKED", mark.gates.length, "gates →", JSON.stringify(T.toJSON()));
  if (liveMode) { sendCmd({ cmd: "reset" }); trafficStarted = true; }
  else { reloadAndStart(viewer); }
  frameCamera(viewer);
  setStatus(`✓ ${mark.gates.length} gates marked — traffic flowing through them (saved).`);
}
function installMarking(viewer) {
  const btn = $("btn-calib");
  if (!btn) return;
  // Register the pick handler once; it only acts while mark.on. The renderer delivers {lon,lat}.
  R.onPick((ll) => {
    if (!mark.on) return;
    if (!ll) { setStatus("Couldn't read that point — click on the road."); return; }
    if (mark.dir.length === 0) { mark.dir.push(ll); setStatus("Mark 2 — click a point DOWN-road (travel direction)"); return; }
    if (mark.dir.length === 1) { mark.dir.push(ll); setStatus("Now click EACH toll gate left→right. Click ✓ Finish when done."); return; }
    mark.gates.push(ll);
    // Preview the new transform after each gate click so markers track the clicks.
    if (mark.gates.length >= 2) {
      setTransform(buildTransformFromMarks(mark.dir, mark.gates));
    }
    rebuildBoothMarkers();
    setStatus(`Gate ${mark.gates.length} marked — keep clicking gates, or ✓ Finish.`);
  });
  btn.onclick = () => {
    if (mark.on) { finishMarking(viewer, btn); return; }   // 2nd click = Finish
    mark.on = true; mark.dir = []; mark.gates = [];
    R.clock.pause();   // Bug 1 fix: pause traffic while user is picking points
    btn.textContent = "✓ Finish"; btn.classList.add("on");
    setStatus("Mark 1 — click a point UP-road (where traffic enters)");
  };
}
/** Wires #btn-export-calib: download the current site's localStorage calibration record as
 * site-<id>.json, in the exact {t,g} shape loadSite() reads back — so a user can commit the
 * file under public/data/ to share the calibration (localStorage -> file -> built-in default). */
function installExportCalibration() {
  const btn = $("btn-export-calib");
  if (!btn) return;
  btn.onclick = () => {
    const raw = localStorage.getItem(siteKey(siteId));
    if (!raw) { setStatus("Nothing to export yet — ⊕ Mark gates first."); return; }
    const blob = new Blob([raw], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `site-${siteId}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    setStatus(`Exported site-${siteId}.json — commit it under cesium-poc/public/data/ to share.`);
  };
}
async function reloadAndStart(viewer) { await loadRun(viewer, offlineUrl); startTraffic(viewer); }

// ============================================================================ boot
(async function main() {
  // Renderer switch: ?renderer=arcgis selects the ArcGIS adapter (lazy-loaded so the Cesium bundle is
  // untouched) — this is the "jump straight to ESRI-ARCGIS NTTA" route. Default = Cesium.
  const useArcgis = new URLSearchParams(location.search).get("renderer") === "arcgis";
  let viewer;
  if (useArcgis) {
    $("cesiumContainer").style.display = "none";
    $("arcgisContainer").style.display = "";
    // Let the browser lay out the freshly-shown container to full height BEFORE ArcGIS measures it,
    // else the SceneView sizes its WebGL canvas to a partial height and the map won't fill the area.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const { ArcgisRenderer } = await import("./renderers/arcgis.js");
    R = new ArcgisRenderer();
    viewer = await R.init("arcgisContainer", {});
  } else {
    R = new CesiumRenderer();
    viewer = await R.init("cesiumContainer", { ionToken: ION });
  }
  const bBase = $("btn-baseline"), bInt = $("btn-intervention"), bLive = $("btn-live");

  // Every site ships a default transform, so the app is ALWAYS placed enough to render — it flies
  // straight to the plaza (never the bare globe) and starts traffic. ⊕ Mark gates refines placement.
  { const s = await loadSite(siteId); setTransform(s.transform); }
  calibrated = true;
  trafficStarted = true;          // ship-with-default-transform → run immediately (no globe, no blank)
  _currentScenario = "baseline";  // boot always loads baseline; ensures baselineStats is captured

  await loadGantries();           // GIS asset inventory (gantries) — placed by rebuildBoothMarkers
  await loadTollRates();          // real NTTA per-read TagFare → revenue-at-risk uses live ArcGIS $
  await loadRun(viewer, offlineUrl);
  R.clock.seek(0);  // ensure sim starts at t=0 on boot
  renderGatePanel();
  installMarking(viewer);
  installExportCalibration();
  installDataConnectAssets(viewer);
  installUc1(viewer);

  // ---- UC1 startup tile / demo-mode entry (Task C, storyboard §5) ----
  // ?uc1=1 auto-enters the 5-step demo (skips the tile entirely — used by e2e + a "drop straight
  // into the story" presenter link). ?uc1=tile force-shows the tile regardless of navigator.webdriver
  // (screenshots/manual QA of the tile itself). Otherwise: show unless navigator.webdriver — every
  // OTHER existing e2e spec (closure.spec.ts, live.spec.ts, etc.) navigates without ?uc1 and must
  // see today's sandbox exactly as before, with no overlay blocking their flows.
  const uc1Param = new URLSearchParams(location.search).get("uc1");
  if (uc1Param === "1") {
    startUc1Demo(viewer);
  } else if (uc1Param === "tile" || !navigator.webdriver) {
    renderStartupTile($("uc1-startup-tile"), {
      onEnterDemo: () => startUc1Demo(viewer),
      onExplore: () => hideStartupTile($("uc1-startup-tile")),
    });
  }

  // ---- Feature B: work-zone HUD wiring (lane selector + close/reopen button) ----
  const wzLaneSel = $("wz-lane-select");
  if (wzLaneSel) {
    wzLaneSel.innerHTML = AP_LANES.map((l, i) => `<option value="${l}">Lane ${i} (${l})</option>`).join("");
  }
  const wzCloseBtn = $("wz-close");
  if (wzCloseBtn) {
    wzCloseBtn.onclick = () => {
      const lane = wzLaneSel ? wzLaneSel.value : AP_LANES[0];
      if (activeWorkzoneSpec) {
        // C1 fix: a closure is active. If the dropdown still points at the closed lane, this
        // click means "reopen". If the user picked a DIFFERENT lane, the intent is "switch the
        // closure to that lane" — reopen the old one, then close the newly-selected one with the
        // same params, instead of silently reopening whatever lane happens to be closed.
        if (lane === activeWorkzoneSpec.lane) {
          openLaneHook(viewer, lane);
        } else {
          const { offsetFt, speedMph, divertPct } = activeWorkzoneSpec;
          openLaneHook(viewer, activeWorkzoneSpec.lane);
          closeLaneHook(viewer, lane, { offsetFt, speedMph, divertPct });
        }
      } else {
        closeLaneHook(viewer, lane, { offsetFt: 12, speedMph: 60 });
      }
    };
  }
  renderWorkzoneHud();

  const selectOffline = async (url, onBtn, scenario) => {
    stopLive(viewer);
    [bBase, bInt, bLive].forEach((b) => b.classList.remove("on"));
    onBtn.classList.add("on");
    _currentScenario = scenario;                     // track before loadRun calls renderKpis
    activeCashLanes = CASH_BY_SCENARIO[scenario];   // recolor gates: intervention turns pl_1/pl_2 green
    offlineUrl = url;
    await loadRun(viewer, url);                      // rebuilds booths/markers with the new cash set
    renderGatePanel();                              // recolor the booth gate buttons too
    startTraffic(viewer);
    frameCamera(viewer);
  };
  bBase.onclick = () => selectOffline(asset("/data/baseline.json"), bBase, "baseline");
  bInt.onclick = () => selectOffline(asset("/data/intervention.json"), bInt, "intervention");
  bLive.onclick = () => {
    [bBase, bInt].forEach((b) => b.classList.remove("on"));
    bLive.classList.add("on");
    trafficStarted = true;
    startLive(viewer);
    frameCamera(viewer);
  };
  $("btn-view").onclick = () => {
    obliqueOn = !obliqueOn;
    $("btn-view").textContent = obliqueOn ? "Top-down view" : "Oblique view";
    frameCamera(viewer);
  };

  // ---- Renderer toggle: show which 3D engine is drawing AND let you switch from the homepage,
  //      so the ESRI/ArcGIS view is reachable without hand-typing ?renderer=arcgis. Switching a
  //      whole SDK live is impractical, so the inactive button reloads the page with the right
  //      param (preserving every other query param). ----
  const rtCesium = $("rt-cesium"), rtArcgis = $("rt-arcgis");
  if (rtCesium && rtArcgis) {
    rtCesium.classList.toggle("on", !useArcgis);
    rtArcgis.classList.toggle("on", useArcgis);
    const switchTo = (target) => {
      if ((target === "arcgis") === useArcgis) return;  // already on it
      const p = new URLSearchParams(location.search);
      if (target === "arcgis") p.set("renderer", "arcgis"); else p.delete("renderer");
      const qs = p.toString();
      location.assign(location.pathname + (qs ? "?" + qs : "") + location.hash);
    };
    rtCesium.onclick = () => switchTo("cesium");
    rtArcgis.onclick = () => switchTo("arcgis");
  }

  // ---- Minimize / expand the control panel ----
  const collapseBtn = $("btn-collapse");
  if (collapseBtn) {
    collapseBtn.onclick = () => {
      const collapsed = $("hud").classList.toggle("collapsed");
      collapseBtn.textContent = collapsed ? "▸" : "▾";
      collapseBtn.setAttribute("aria-expanded", String(!collapsed));
      collapseBtn.title = collapsed ? "Expand panel" : "Minimize panel";
    };
  }

  // ---- Playback speed (both renderers, via the shared clock adapter) ----
  const speedSeg = $("speed-seg");
  if (speedSeg) {
    const speedBtns = speedSeg.querySelectorAll("button");
    speedBtns.forEach((b) => {
      b.onclick = () => {
        R.clock.setMultiplier(Number(b.dataset.mult));
        speedBtns.forEach((x) => x.classList.toggle("on", x === b));
      };
    });
  }

  // ---- Asset-ops incident scenario (camera degradation + rain + peak) ----
  const aoRun = $("ao-run");
  if (aoRun) aoRun.onclick = () => toggleIncident();
  renderAssetOps();

  // ---- SITE SELECTOR: switch the transform to a different real toll corridor (same SUMO plaza). ----
  const sel = $("site-select");
  if (sel) {
    sel.innerHTML = SITES.map((s) => `<option value="${s.id}">${s.name}</option>`).join("");
    sel.value = siteId;
    sel.onchange = async () => {
      siteId = sel.value;
      { const s = await loadSite(siteId); setTransform(s.transform); }
      stopLive(viewer);
      [bInt, bLive].forEach((b) => b.classList.remove("on")); bBase.classList.add("on");
      offlineUrl = asset("/data/baseline.json");
      trafficStarted = false;
      await loadRun(viewer, offlineUrl);
      startTraffic(viewer);
      frameCamera(viewer);
      setStatus(`Switched to ${SITES.find((s) => s.id === siteId).name} — same plaza, new corridor.`);
    };
  }

  // Fly to the plaza (never the bare globe).
  frameCamera(viewer);
  setStatus(`${SITES.find((s) => s.id === siteId).name} — traffic running. ⊕ Calibrate to refine placement.`);

  // ---- Weather dropdown: change overlay + send to server (if live) ----
  const weatherSel = $("weather-select");
  if (weatherSel) {
    weatherSel.onchange = () => {
      const preset = weatherSel.value;
      // Apply overlay always; only send to server when in live mode with an open WS
      applyWeatherOverlay(preset, liveMode && ws && ws.readyState === WebSocket.OPEN);
    };
  }

  // debug hooks for headless verification
  window.__viewer = useArcgis ? null : viewer;  // Cesium-specific (raw Viewer) — the existing e2e contract
  window.__view = R.raw();                        // renderer-neutral (Viewer or SceneView)
  window.__R = R;                                 // the active renderer adapter (for renderer-specific specs)
  window.__arcgisReady = useArcgis;               // ArcGIS smoke specs wait on this
  window.__startTraffic = () => startTraffic(viewer);
  window.__markGates = (dir, gates) => { mark.dir = dir; mark.gates = gates; finishMarking(viewer, $("btn-calib")); };
  // Feature B: MUTCD/RILCA work-zone lane closure hooks (TTC overlay + KPIs) — see closeLaneHook.
  window.__closeLane = (lane, opts) => closeLaneHook(viewer, lane, opts);
  window.__openLane = (lane) => openLaneHook(viewer, lane);
  // Feature-A: expose live transform + meta so e2e specs can validate curved-road geometry.
  // Use property getters so the values stay current even if T / META are reassigned later
  // (e.g. after user switches sites or re-calibrates).
  Object.defineProperty(window, "__T",    { get: () => T,    configurable: true, enumerable: false });
  Object.defineProperty(window, "__meta", { get: () => META, configurable: true, enumerable: false });
})();
