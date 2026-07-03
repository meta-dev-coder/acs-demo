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

const toRad = (deg) => (deg * Math.PI) / 180;
const ION = import.meta.env.VITE_CESIUM_ION_TOKEN;

const N_BOOTHS = 10;
// Fixed plaza half-span: 10 lanes x 3.2 m / 2 = 14.4 m. The plaza core (fo/pl/fi) stays a straight,
// symmetric-about-y=0 tangent by design (Feature A curved-road net — see sumo/georef_nodes.py), so
// this is a FIXED constant, not derived from meta.bounds.minY/maxY: those now span the whole curved
// approach/departure trajectory (up to ~55 m), not just the booth line. Using bounds here would make
// booth markers and the mark-gates transform scale wildly wrong (this WAS a real regression — see
// e2e/bugs.spec.ts Bug 2). Mirrors fcd2json.py's ROAD_HALF_WIDTH_M, which documents the same rule.
const PLAZA_HALF_SPAN_M = 14.4;
// NTTA all-electronic reframing (NTTA has NO cash booths). The A/B contrasts what a LEGACY CASH PLAZA
// would cost the operator (baseline: 3 cash lanes → queues/delay) vs the ALL-ELECTRONIC REALITY
// (intervention: every lane AET → free-flow). Mechanics unchanged; the cash set drives booth colour +
// the cash-queue behaviour. All-electronic = empty cash set (every booth green).
const CASH_BY_SCENARIO = {
  baseline: new Set(["pl_0", "pl_1", "pl_2"]),  // "if NTTA still ran a legacy cash plaza"
  intervention: new Set([]),                     // "your all-electronic reality" — every lane AET
};
let activeCashLanes = CASH_BY_SCENARIO.baseline;
const WS_URL = "ws://localhost:8765";

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
/** Returns { transform, gates } for a site — restoring a saved {t,g} or falling back to the default. */
function loadSite(id) {
  try {
    const raw = JSON.parse(localStorage.getItem(siteKey(id)));
    if (raw && raw.t) { const t = CoordinateTransform.fromJSON(raw.t); if (t) return { transform: t, gates: raw.g || [] }; }
  } catch {}
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
}

// ============================================================================ gantry assets (GIS layer)
// The DNT toll gantries are geospatial ASSETS (Legacy / Headquarters / Gaylord), loaded from a GIS
// export (public/data/dnt-gantries.json — stands in for a TxDOT/NTTA ArcGIS FeatureLayer). They place
// onto the same corridor centerline as the traffic via T, and carry health status for the asset-ops
// scenario. Rendered as cyan discs (red when a camera degrades) with name labels.
let GANTRIES = [];
let AVG_TOLL = 1.45;
let assetIncidentOn = false;

async function loadGantries() {
  try {
    const d = await (await fetch("/data/dnt-gantries.json")).json();
    GANTRIES = (d.gantries || []).map((g) => ({ ...g }));
    AVG_TOLL = d.avgTollUsd ?? 1.45;
  } catch { GANTRIES = []; }
}

function renderGantries() {
  if (!T) return;
  for (const g of GANTRIES) {
    const degraded = g.status === "degraded";
    R.placeMarker({
      id: `gantry:${g.id}`, x: g.station, y: 0, tracking: true,
      disc: { radiusM: 3.4, colorCss: degraded ? "#ff4d4d" : "#39c0d6", alpha: 0.85 },
      label: { kind: "gantry", text: g.name.replace(" Gantry", "") + (degraded ? " ⚠" : "") },
    });
  }
}

/** Fill the Asset Operations panel from the pure assetKpis engine + current throughput/weather. */
function renderAssetOps() {
  if (!$("assetops-hud")) return;
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
  const target = GANTRIES.find((g) => g.id === "DNT-HQ") || GANTRIES[0];
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
let offlineUrl = "/data/baseline.json";

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
  ws.onclose = () => setConn(false, "socket: offline");
  ws.onerror = () => setConn(false, "socket: error");
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
  { const s = loadSite(siteId); setTransform(s.transform); }
  calibrated = true;
  trafficStarted = true;          // ship-with-default-transform → run immediately (no globe, no blank)
  _currentScenario = "baseline";  // boot always loads baseline; ensures baselineStats is captured

  await loadGantries();           // GIS asset inventory (gantries) — placed by rebuildBoothMarkers
  await loadRun(viewer, offlineUrl);
  R.clock.seek(0);  // ensure sim starts at t=0 on boot
  renderGatePanel();
  installMarking(viewer);

  // ---- Feature B: work-zone HUD wiring (lane selector + close/reopen button) ----
  const wzLaneSel = $("wz-lane-select");
  if (wzLaneSel) {
    wzLaneSel.innerHTML = AP_LANES.map((l, i) => `<option value="${l}">Lane ${i} (${l})</option>`).join("");
  }
  const wzCloseBtn = $("wz-close");
  if (wzCloseBtn) {
    wzCloseBtn.onclick = () => {
      const lane = wzLaneSel ? wzLaneSel.value : AP_LANES[0];
      if (activeWorkzoneSpec) openLaneHook(viewer, lane);
      else closeLaneHook(viewer, lane, { offsetFt: 12, speedMph: 60 });
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
  bBase.onclick = () => selectOffline("/data/baseline.json", bBase, "baseline");
  bInt.onclick = () => selectOffline("/data/intervention.json", bInt, "intervention");
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

  // ---- Renderer badge: make it obvious which 3D engine is drawing ----
  const badge = $("renderer-badge");
  if (badge) {
    badge.textContent = useArcgis ? "Esri · ArcGIS" : "CesiumJS";
    badge.classList.add(useArcgis ? "arcgis" : "cesium");
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
      { const s = loadSite(siteId); setTransform(s.transform); }
      stopLive(viewer);
      [bInt, bLive].forEach((b) => b.classList.remove("on")); bBase.classList.add("on");
      offlineUrl = "/data/baseline.json";
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
