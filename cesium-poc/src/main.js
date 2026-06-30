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

const ION = import.meta.env.VITE_CESIUM_ION_TOKEN;
if (ION) Ion.defaultAccessToken = ION;

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
// Cash booths per scenario. Baseline: 3 cash (pl_0..2). Intervention ("Convert 2 cash → AET"):
// pl_1 & pl_2 are converted to AET (turn GREEN), only pl_0 stays cash — so green cars flow through the
// converted booths and the orange (cash) cars queue at the single remaining cash booth.
const CASH_BY_SCENARIO = {
  baseline: new Set(["pl_0", "pl_1", "pl_2"]),
  intervention: new Set(["pl_0"]),
};
let activeCashLanes = CASH_BY_SCENARIO.baseline;
const WS_URL = "ws://localhost:8765";

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
  // Derive booth Y positions from the SUMO bounds (minY..maxY spans all 10 lanes).
  const { minY, maxY } = meta.bounds;
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
let offlineUrl = "/data/baseline.json";

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
        uri: v.type === "truck" ? "/models/truck.glb" : "/models/car.glb",
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

// ============================================================================ KPIs
let baselineStats = null;
function renderKpis(s) {
  if (!baselineStats) baselineStats = s;
  const delta = (cur, base, lowerBetter) => {
    if (cur === base) return "";
    const better = lowerBetter ? cur < base : cur > base;
    const pct = base ? Math.round(((cur - base) / base) * 100) : 0;
    return `<div class="d ${better ? "good" : "bad"}">${pct > 0 ? "+" : ""}${pct}%</div>`;
  };
  const tiles = [
    ["Avg wait", `${s.avgWaitSec}s`, delta(s.avgWaitSec, baselineStats.avgWaitSec, true)],
    ["Throughput", `${s.throughputVph}`, delta(s.throughputVph, baselineStats.throughputVph, false)],
    ["Avg speed", `${s.avgSpeedMph} mph`, delta(s.avgSpeedMph, baselineStats.avgSpeedMph, false)],
    ["Mainline spillback", s.spillback ? "Yes" : "No", ""],
  ];
  $("kpis").innerHTML = tiles
    .map(([l, v, d]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div>${d}</div>`).join("");
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
  clearLive(viewer);
  closedSet = new Set();
  $("gatePanel").classList.add("hidden");
  setConn(false, "socket: offline");
}
function onMeta(viewer, m) {
  // Build a META compatible with computeBooths (raw SUMO bounds).
  if (m.bounds && typeof m.boothX === "number") {
    META = { bounds: m.bounds, boothX: m.boothX, tEnd: m.tEnd || 0 };
  } else {
    // Fallback: use default bounds matching the 10-lane plaza
    META = { bounds: { minX: 0, maxX: 930, minY: -14.4, maxY: 14.4 }, boothX: 530, tEnd: 0 };
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
          uri: v.type === "truck" ? "/models/truck.glb" : "/models/car.glb",
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
  const sumoSpan = (META.bounds.maxY - META.bounds.minY) || 1;
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
async function reloadAndStart(viewer) { await loadRun(viewer, offlineUrl); startTraffic(viewer); }

// ============================================================================ boot
(async function main() {
  const viewer = await makeViewer();
  const bBase = $("btn-baseline"), bInt = $("btn-intervention"), bLive = $("btn-live");

  // Every site ships a default transform, so the app is ALWAYS placed enough to render — it flies
  // straight to the plaza (never the bare globe) and starts traffic. ⊕ Mark gates refines placement.
  { const s = loadSite(siteId); T = s.transform; }
  calibrated = true;
  trafficStarted = true;          // ship-with-default-transform → run immediately (no globe, no blank)

  await loadRun(viewer, offlineUrl);
  viewer.clock.currentTime = EPOCH.clone();  // ensure sim starts at t=0 on boot
  renderGatePanel();
  installMarking(viewer);

  const selectOffline = async (url, onBtn, scenario) => {
    stopLive(viewer);
    [bBase, bInt, bLive].forEach((b) => b.classList.remove("on"));
    onBtn.classList.add("on");
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

  // ---- SITE SELECTOR: switch the transform to a different real toll corridor (same SUMO plaza). ----
  const sel = $("site-select");
  if (sel) {
    sel.innerHTML = SITES.map((s) => `<option value="${s.id}">${s.name}</option>`).join("");
    sel.value = siteId;
    sel.onchange = async () => {
      siteId = sel.value;
      { const s = loadSite(siteId); T = s.transform; }
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

  // debug hooks for headless verification
  window.__viewer = viewer;
  window.__startTraffic = () => startTraffic(viewer);
  window.__markGates = (dir, gates) => { mark.dir = dir; mark.gates = gates; finishMarking(viewer, $("btn-calib")); };
})();
