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
import {
  Ion, Viewer, Terrain, Cartesian3, Color, JulianDate, Math as CMath,
  SampledPositionProperty, SampledProperty, Transforms, Matrix4,
  TimeInterval, TimeIntervalCollection, ClockRange, ExtrapolationType,
  HermitePolynomialApproximation, EllipsoidTerrainProvider, UrlTemplateImageryProvider,
  ImageryLayer, HeadingPitchRange, HeadingPitchRoll, ConstantPositionProperty,
  CallbackProperty, LabelStyle, VerticalOrigin, Cartesian2, NearFarScalar,
  ScreenSpaceEventHandler, ScreenSpaceEventType,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import "./style.css";
import { CoordinateTransform } from "./transform.js";
import { buildWorkZone, clearWorkZone, rilcaWorkzone, CLOSURE_CONFIG } from "./workzone.js";
import { login, fetchClass, onStatus } from "./dataconnect.js";
import { adaptDataConnectAssets, scoreAssets } from "./scoringA.js";
import { buildAssetLayer, disposeAssetLayer, pickAsset } from "./assetLayer.js";

const ION = import.meta.env.VITE_CESIUM_ION_TOKEN;
if (ION) Ion.defaultAccessToken = ION;

// Runtime fetch/model URIs are plain strings — Vite does NOT rewrite them at build time (unlike
// index.html src/href attributes), so under a sub-path deploy (POC_BASE_PATH) they must be joined
// against BASE_URL explicitly. dataUrl("data/baseline.json") -> "/acs-demo/twin/data/baseline.json".
const dataUrl = (path) => import.meta.env.BASE_URL + path.replace(/^\//, "");

const EPOCH = JulianDate.fromIso8601("2025-01-01T00:00:00Z");
const COLORS = {
  cash: Color.fromCssColorString("#ff9b1a"),
  etc: Color.fromCssColorString("#1ccb40"),
  truck: Color.fromCssColorString("#3a80e8"),
};
// Vehicle model sizing:
//   car.glb — native body 4.8 m long (X=-2.4..+2.4), 2.0 m wide, 1.35 m tall.  scale=1.0 → real sedan.
//   truck.glb — Cesium Milk Truck, native Z span ≈4.87 m.  scale=2.465 → ~12 m semi.
const VEHICLE_SCALE   = { car: 1.0, truck: 1.25 };    // truck ~2.5× car length, not 5×
const MIN_PIXEL_SIZE  = { car: 26,  truck: 30    };   // keep visible at max zoom-out
// Per-model yaw correction (deg): each glTF has its own native forward axis, so align the mesh's
// nose to the travel heading. Tuned by screenshot so cars/trucks point ALONG the corridor.
const MODEL_YAW_OFFSET = { car: -110, truck: -30 };   // mesh nose alignment (tuned per request)
const DIMS = { cash: [4.8, 2.0, 1.6], etc: [4.8, 2.0, 1.6], truck: [12, 2.6, 3.2] };
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
const CASH_BY_SCENARIO = {
  baseline: new Set(["pl_0", "pl_1", "pl_2"]),
  intervention: new Set(["pl_0"]),
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
    const res = await fetch(dataUrl(`data/site-${id}.json`));
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
async function makeViewer() {
  const opts = {
    animation: true, timeline: true, baseLayerPicker: false, geocoder: false,
    homeButton: false, navigationHelpButton: false, sceneModePicker: false,
    fullscreenButton: false, infoBox: false, selectionIndicator: false,
  };
  opts.baseLayer = new ImageryLayer(new UrlTemplateImageryProvider({
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    maximumLevel: 19, credit: "Imagery © Esri, Maxar, Earthstar Geographics",
  }));
  if (ION) opts.terrain = Terrain.fromWorldTerrain();
  else opts.terrainProvider = new EllipsoidTerrainProvider();
  const viewer = new Viewer("cesiumContainer", opts);
  viewer.scene.globe.enableLighting = false;
  viewer.clock.clockRange = ClockRange.LOOP_STOP;
  viewer.clock.multiplier = 6;
  return viewer;
}

// orientation quaternion for a SUMO/compass angle, at the plaza-centre frame.
// `type` selects the per-model yaw correction so the mesh nose points along travel.
function orientFor(angleDeg, type) {
  const at = T.sumoToWorld(T.p.sumoRefX, 0);
  const yaw = T.headingRad(angleDeg) + CMath.toRadians(MODEL_YAW_OFFSET[type === "truck" ? "truck" : "car"]);
  return Transforms.headingPitchRollQuaternion(at, new HeadingPitchRoll(yaw, 0, 0));
}

// ============================================================================ booth markers
let boothEntities = [];
let closedSet = new Set();
const desired = new Map();
const isClosed = (lane) => !!desired.get(lane) || closedSet.has(lane);

function rebuildBoothMarkers(viewer) {
  boothEntities.forEach((e) => viewer.entities.remove(e.disc));
  boothEntities = [];

  for (const b of BOOTHS) {
    // All booths are placed via T.sumoToWorld — marking rebuilds T, so booth markers follow.
    const y = b.y;
    const boothX = META ? META.boothX : T.p.sumoRefX;
    const posCb = new CallbackProperty(() => T.sumoToWorld(boothX, y), false);
    const disc = viewer.entities.add({
      position: posCb,
      ellipse: {
        semiMajorAxis: 1.8, semiMinorAxis: 1.8,
        material: (b.cash ? COLORS.cash : COLORS.etc).withAlpha(0.9),
        outline: true, outlineColor: Color.WHITE.withAlpha(0.9), height: 1,
      },
      label: {
        text: new CallbackProperty(() => (isClosed(b.lane) ? "✕" : ""), false),
        font: "bold 13px sans-serif", fillColor: Color.WHITE, showBackground: true,
        backgroundColor: Color.fromCssColorString("#c01a0e").withAlpha(0.92),
        style: LabelStyle.FILL, pixelOffset: new Cartesian2(0, -14),
        verticalOrigin: VerticalOrigin.BOTTOM, scaleByDistance: new NearFarScalar(200, 1, 3000, 0.5),
      },
    });
    boothEntities.push({ lane: b.lane, disc });
  }

  // ONE "Toll plaza" label on the centre-line. Use a stable id + a CallbackProperty position so a
  // rebuild REPLACES it (entities.add with an existing id throws → remove-then-add) instead of stacking
  // a new label every time (that stacking was the "TOLL PLAZA × 9" bug).
  const boothX = META ? META.boothX : (T ? T.p.sumoRefX : 530);
  const existing = viewer.entities.getById("toll-plaza-label");
  if (existing) viewer.entities.remove(existing);
  if (T) {
    viewer.entities.add({
      id: "toll-plaza-label",
      position: new CallbackProperty(() => T.sumoToWorld(boothX - 26, 0), false),
      label: {
        text: "TOLL PLAZA", font: "bold 13px sans-serif",
        fillColor: Color.fromCssColorString("#bfe0ff"), showBackground: true,
        backgroundColor: Color.fromCssColorString("#0d1621").withAlpha(0.85),
        scaleByDistance: new NearFarScalar(200, 1, 4000, 0.45),
      },
    });
  }
}

// ============================================================================ offline playback
let vehicleEntities = [];
let currentData = null;
let offlineUrl = dataUrl("data/baseline.json");

function removeVehicles(viewer) {
  vehicleEntities.forEach((e) => viewer.entities.remove(e));
  vehicleEntities = [];
}

async function loadRun(viewer, url) {
  const data = await (await fetch(url)).json();
  currentData = data;
  META = data.meta;
  BOOTHS = computeBooths(META);
  removeVehicles(viewer);
  rebuildBoothMarkers(viewer);
  // New scenario data invalidates any active work-zone overlay (stale geometry/KPIs).
  clearWorkZone(viewer);
  activeWorkzoneSpec = null;

  if (!T) { setStatus("⊕ Calibrate the road to place + start the traffic."); return; }

  const height = T.p.anchorHeight || 3;

  for (const v of data.vehicles) {
    const pos = new SampledPositionProperty();
    pos.setInterpolationOptions({ interpolationDegree: 2, interpolationAlgorithm: HermitePolynomialApproximation });
    pos.forwardExtrapolationType = ExtrapolationType.HOLD;
    const ang = new SampledProperty(Number);
    for (const [t, x, y, a] of v.samples) {
      const time = JulianDate.addSeconds(EPOCH, t, new JulianDate());
      // All vehicles placed via T.sumoToWorld — marking rebuilds T, so traffic follows.
      const world = T.sumoToWorld(x, y);
      pos.addSample(time, world);
      ang.addSample(time, a);
    }
    const a0 = v.samples[0][3];
    vehicleEntities.push(viewer.entities.add({
      availability: new TimeIntervalCollection([new TimeInterval({
        start: JulianDate.addSeconds(EPOCH, v.samples[0][0], new JulianDate()),
        stop: JulianDate.addSeconds(EPOCH, v.samples[v.samples.length - 1][0], new JulianDate()),
      })]),
      position: pos,
      orientation: new CallbackProperty((time) => orientFor(ang.getValue(time) ?? a0, v.type), false),
      model: {
        uri: v.type === "truck" ? dataUrl("models/truck.glb") : dataUrl("models/car.glb"),
        minimumPixelSize: MIN_PIXEL_SIZE[v.type === "truck" ? "truck" : "car"],
        scale: VEHICLE_SCALE[v.type === "truck" ? "truck" : "car"],
        color: COLORS[v.type] || Color.WHITE,
        colorBlendMode: 2,  // MIX — tint while preserving model shape/shading
        colorBlendAmount: 0.6,
        silhouetteColor: Color.WHITE,
        silhouetteSize: 1.0,
      },
    }));
  }
  viewer.clock.startTime = EPOCH.clone();
  viewer.clock.stopTime = JulianDate.addSeconds(EPOCH, data.meta.tEnd, new JulianDate());
  if (!trafficStarted) viewer.clock.currentTime = EPOCH.clone();
  viewer.clock.shouldAnimate = trafficStarted;
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

  // Fog: lower Cesium scene fog density so distant vehicles fade
  if (window.__viewer) {
    const fog = window.__viewer.scene.fog;
    if (preset === "fog") {
      fog.enabled = true;
      fog.density = 0.002;
    } else {
      fog.enabled = false;
    }
  }

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
}

// ============================================================================ camera
let obliqueOn = false;
function frameCamera(viewer) {
  if (!T) return;
  const tgt = T.sumoToWorld(T.p.sumoRefX, 0);
  const headingRad = T.headingRad(90);
  const pitch = CMath.toRadians(obliqueOn ? -32 : -80);
  viewer.camera.lookAt(tgt, new HeadingPitchRange(headingRad, pitch, obliqueOn ? 360 : 300));
  viewer.camera.lookAtTransform(Matrix4.IDENTITY);
}

// ============================================================================ traffic gate
let calibrated = false;
let trafficStarted = false;
function startTraffic(viewer) {
  trafficStarted = true;
  viewer.clock.currentTime = EPOCH.clone();
  viewer.clock.shouldAnimate = true;
}

// ============================================================================ live mode
let ws = null, liveMode = false;
const liveEntities = new Map();
function setConn(on, text) { const e = $("conn"); e.className = "conn " + (on ? "on" : "off"); e.textContent = text; }
function clearLive(viewer) { for (const e of liveEntities.values()) viewer.entities.remove(e); liveEntities.clear(); }

function startLive(viewer) {
  liveMode = true;
  viewer.clock.shouldAnimate = false;
  removeVehicles(viewer);
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
  clearLive(viewer);
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
  rebuildBoothMarkers(viewer);
  renderGatePanel();
  closedSet = new Set(m.closed || []);
  setStatus("Live · waiting for first step…");
}
function onStep(viewer, m) {
  closedSet = new Set(m.closed || []);
  const seen = new Set();
  for (const v of m.vehicles) {
    seen.add(v.id);
    // Live data carries raw local SUMO x,y — place via T.sumoToWorld.
    const world = T ? T.sumoToWorld(v.x, v.y) : null;
    if (!world) continue;
    let e = liveEntities.get(v.id);
    if (!e) {
      e = viewer.entities.add({
        position: new ConstantPositionProperty(world),
        orientation: orientFor(v.angle, v.type),
        model: {
          uri: v.type === "truck" ? dataUrl("models/truck.glb") : dataUrl("models/car.glb"),
          minimumPixelSize: MIN_PIXEL_SIZE[v.type === "truck" ? "truck" : "car"],
          scale: VEHICLE_SCALE[v.type === "truck" ? "truck" : "car"],
          color: COLORS[v.type] || Color.WHITE,
          colorBlendMode: 2,  // MIX — tint while preserving model shape/shading
          colorBlendAmount: 0.6,
          silhouetteColor: Color.WHITE,
          silhouetteSize: 1.0,
        },
      });
      liveEntities.set(v.id, e);
    } else {
      e.position.setValue(world);
      e.orientation = orientFor(v.angle, v.type);
    }
  }
  for (const [id, e] of liveEntities) if (!seen.has(id)) { viewer.entities.remove(e); liveEntities.delete(id); }
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

const DC_CLASSES = {
  assetRegistry: "asset_registry",
  workOrders: "work_orders",
  safetyInspections: "safety_inspections_v3",
  roadwayInspections: "roadway_inspections_v3",
  itsInspections: "its_inspections_v3",
  incidents: "incidents_v3",
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
    const [assetRegistry, workOrders, safetyInspections, roadwayInspections, itsInspections, incidents] =
      await Promise.all([
        fetchClass(DC_CLASSES.assetRegistry, { pageSize: 500 }),
        fetchClass(DC_CLASSES.workOrders, { pageSize: 500 }),
        fetchClass(DC_CLASSES.safetyInspections, { pageSize: 500 }),
        fetchClass(DC_CLASSES.roadwayInspections, { pageSize: 500 }),
        fetchClass(DC_CLASSES.itsInspections, { pageSize: 500 }),
        fetchClass(DC_CLASSES.incidents, { pageSize: 500 }),
      ]);
    const raw = adaptDataConnectAssets({
      assetRegistry, workOrders, safetyInspections, roadwayInspections, itsInspections, incidents,
    });
    const scored = scoreAssets(raw, []);

    // Only now, with a fully-scored replacement in hand, touch the live layer/state.
    const prevCollection = dcCollection;
    dcCollection = buildAssetLayer(viewer, scored);
    if (prevCollection) disposeAssetLayer(viewer, prevCollection);
    dcScored = scored;
    renderDcAssetKpis(scored);
    startDcPolling();
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
    const get = (name) => fetch(dataUrl(`dataconnect-data/${name}.json`)).then((r) => {
      if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw new Error(name);
      return r.json();
    });
    const [assetRegistry, workOrders, safetyInspections, roadwayInspections, itsInspections, incidents] =
      await Promise.all([
        get(DC_CLASSES.assetRegistry), get(DC_CLASSES.workOrders), get(DC_CLASSES.safetyInspections),
        get(DC_CLASSES.roadwayInspections), get(DC_CLASSES.itsInspections), get(DC_CLASSES.incidents),
      ]);
    const scored = scoreAssets(adaptDataConnectAssets({
      assetRegistry, workOrders, safetyInspections, roadwayInspections, itsInspections, incidents,
    }), []);
    const prevCollection = dcCollection;
    dcCollection = buildAssetLayer(viewer, scored);
    if (prevCollection) disposeAssetLayer(viewer, prevCollection);
    dcScored = scored;
    renderDcAssetKpis(scored);
    stopDcPolling(); // snapshot mode is static — no live endpoint to poll
    setDcStatusBadge("snapshot");
  } catch (err) {
    console.warn("[DataConnect] snapshot fallback unavailable", err);
  }
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

  const dcHandler = new ScreenSpaceEventHandler(viewer.scene.canvas);
  dcHandler.setInputAction((click) => {
    if (!dcEnabled || !dcCollection || !dcCollection.show) return;
    const asset = pickAsset(viewer, click.position);
    if (asset) showDcAssetPanel(asset);
  }, ScreenSpaceEventType.LEFT_CLICK);
}

// ============================================================================ MARK GATES (user clicks each real toll gate)
// The user marks the road direction (2 clicks) then clicks each real toll gate on the aerial.
// Marking rebuilds T from the clicks, then reloads vehicles (placed via T.sumoToWorld) AND
// rebuilds booth markers (also via T.sumoToWorld) — so traffic and markers always coincide.
const mark = { on: false, dir: [], gates: [], handler: null };
function buildTransformFromMarks(dir, gates) {
  const [up, down] = dir;
  const mLat = 110540, mLon0 = 111320 * Math.cos(CMath.toRadians(up.lat));
  const bearingDeg = ((Math.atan2((down.lon - up.lon) * mLon0, (down.lat - up.lat) * mLat) * 180) / Math.PI + 360) % 360;
  const anchorLon = gates.reduce((s, g) => s + g.lon, 0) / gates.length;
  const anchorLat = gates.reduce((s, g) => s + g.lat, 0) / gates.length;
  const mLon = 111320 * Math.cos(CMath.toRadians(anchorLat));
  const Br = CMath.toRadians(bearingDeg);
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
  T = buildTransformFromMarks(mark.dir, mark.gates);
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
  btn.onclick = () => {
    if (mark.on) { finishMarking(viewer, btn); return; }   // 2nd click = Finish
    mark.on = true; mark.dir = []; mark.gates = [];
    viewer.clock.shouldAnimate = false;   // Bug 1 fix: pause traffic while user is picking points
    btn.textContent = "✓ Finish"; btn.classList.add("on");
    setStatus("Mark 1 — click a point UP-road (where traffic enters)");
    if (mark.handler) return;
    mark.handler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    mark.handler.setInputAction((click) => {
      if (!mark.on) return;
      const ll = CoordinateTransform.pickLonLat(viewer, click.position);
      if (!ll) { setStatus("Couldn't read that point — click on the road."); return; }
      if (mark.dir.length === 0) { mark.dir.push(ll); setStatus("Mark 2 — click a point DOWN-road (travel direction)"); return; }
      if (mark.dir.length === 1) { mark.dir.push(ll); setStatus("Now click EACH toll gate left→right. Click ✓ Finish when done."); return; }
      mark.gates.push(ll);
      // Preview the new transform after each gate click so markers track the clicks.
      if (mark.gates.length >= 2) {
        T = buildTransformFromMarks(mark.dir, mark.gates);
      }
      rebuildBoothMarkers(viewer);
      setStatus(`Gate ${mark.gates.length} marked — keep clicking gates, or ✓ Finish.`);
    }, ScreenSpaceEventType.LEFT_CLICK);
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
  const viewer = await makeViewer();
  const bBase = $("btn-baseline"), bInt = $("btn-intervention"), bLive = $("btn-live");

  // Every site ships a default transform, so the app is ALWAYS placed enough to render — it flies
  // straight to the plaza (never the bare globe) and starts traffic. ⊕ Mark gates refines placement.
  { const s = await loadSite(siteId); T = s.transform; }
  calibrated = true;
  trafficStarted = true;          // ship-with-default-transform → run immediately (no globe, no blank)
  _currentScenario = "baseline";  // boot always loads baseline; ensures baselineStats is captured

  await loadRun(viewer, offlineUrl);
  viewer.clock.currentTime = EPOCH.clone();  // ensure sim starts at t=0 on boot
  renderGatePanel();
  installMarking(viewer);
  installExportCalibration();
  installDataConnectAssets(viewer);

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
  bBase.onclick = () => selectOffline(dataUrl("data/baseline.json"), bBase, "baseline");
  bInt.onclick = () => selectOffline(dataUrl("data/intervention.json"), bInt, "intervention");
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

  // ---- SITE SELECTOR: switch the transform to a different real toll corridor (same SUMO plaza). ----
  const sel = $("site-select");
  if (sel) {
    sel.innerHTML = SITES.map((s) => `<option value="${s.id}">${s.name}</option>`).join("");
    sel.value = siteId;
    sel.onchange = async () => {
      siteId = sel.value;
      { const s = await loadSite(siteId); T = s.transform; }
      stopLive(viewer);
      [bInt, bLive].forEach((b) => b.classList.remove("on")); bBase.classList.add("on");
      offlineUrl = dataUrl("data/baseline.json");
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
  window.__viewer = viewer;
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
