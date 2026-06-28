/*
 * I-595 Toll-Plaza Flow — SUMO trajectories rendered in CesiumJS.
 *
 * Coordinate conversion (SUMO metres <-> Cesium globe) is owned ENTIRELY by transform.js
 * (CoordinateTransform). The data pipeline (fcd2json.py / live_server.py) emits RAW SUMO coordinates;
 * this client places them via the transform, which is produced by a 4-click calibration and persisted.
 * Nothing about placement is hardcoded here.
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
const DIMS = { cash: [4.8, 2.0, 1.6], etc: [4.8, 2.0, 1.6], truck: [12, 2.6, 3.2] };
const N_BOOTHS = 10;
const CASH_LANES = new Set(["pl_0", "pl_1", "pl_2"]);   // matches plaza.baseline.rou.xml
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
let T = null;            // the CoordinateTransform (model <-> SUMO). Null until calibrated.
let META = null;         // data meta: { bounds, boothX, tEnd, [georef, anchor, boothGeo, ...] }
let BOOTHS = [];         // [{ lane, y, cash }] or [{ lane, lonlat, cash }] for georef
let markedGates = [];    // user-clicked gate positions [{lon,lat}] — the source of truth for markers

function computeBooths(meta) {
  // Georeferenced data: use boothGeo list from meta (exact lane lon/lat from pipeline)
  if (meta.georef && meta.boothGeo && meta.boothGeo.length > 0) {
    return meta.boothGeo.map((b) => ({
      lane: b.lane,
      lonlat: { lon: b.lon, lat: b.lat },
      cash: b.cash,
    }));
  }
  // Raw SUMO data: derive booth Y positions from bounds
  const { minY, maxY } = meta.bounds;
  const out = [];
  for (let i = 0; i < N_BOOTHS; i++) {
    const lane = `pl_${i}`;
    const y = minY + (i * (maxY - minY)) / (N_BOOTHS - 1);   // lane centres span the plaza
    out.push({ lane, y, cash: CASH_LANES.has(lane) });
  }
  return out;
}

/** Is the current data georeferenced? */
function isGeoref() { return !!(META && META.georef); }

/** Get the Cartesian3 position for a SUMO (x, y) or (lon, lat) depending on georef mode. */
function samplePosition(x, y) {
  if (isGeoref()) return Cartesian3.fromDegrees(x, y, META.anchor ? META.anchor.height : 3);
  return T ? T.sumoToWorld(x, y) : null;
}

/** Get the Cartesian3 world-position anchor (for orientation frame). */
function anchorWorld() {
  if (isGeoref() && META.anchor) {
    return Cartesian3.fromDegrees(META.anchor.lon, META.anchor.lat, META.anchor.height);
  }
  return T ? T.sumoToWorld(T.p.sumoRefX, 0) : Cartesian3.fromDegrees(-80.306, 26.1124, 3);
}

/** Get the bearing (radians) for a given SUMO compass angle. */
function headingRadFor(angleDeg) {
  const bearingDeg = (META && META.bearingDeg) ? META.bearingDeg
    : (T ? T.p.bearingDeg : 104);
  return ((angleDeg || 0) + bearingDeg - 180) * Math.PI / 180;
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

// orientation quaternion for a SUMO/compass angle, at the plaza-centre frame (small plaza → constant up)
function orientFor(angleDeg) {
  const at = anchorWorld();
  return Transforms.headingPitchRollQuaternion(at, new HeadingPitchRoll(headingRadFor(angleDeg), 0, 0));
}

// ============================================================================ booth markers
let boothEntities = [];
let closedSet = new Set();
const desired = new Map();
const isClosed = (lane) => !!desired.get(lane) || closedSet.has(lane);

function rebuildBoothMarkers(viewer) {
  boothEntities.forEach((e) => viewer.entities.remove(e.disc));
  boothEntities = [];
  // Prefer the user-marked gates (rendered at the EXACT clicked lon/lat) over computed positions.
  const useMarked = markedGates.length > 0;
  const list = useMarked
    ? markedGates.map((g, i) => ({ lane: `pl_${i}`, lonlat: g, cash: i < 3 }))
    : BOOTHS.map((b) => ({ lane: b.lane, lonlat: b.lonlat, y: b.y, cash: b.cash }));

  for (const b of list) {
    // Position: marked gates and georef booths both carry lonlat; raw SUMO uses T.sumoToWorld.
    let posCb;
    if (b.lonlat) {
      const ll = b.lonlat;
      posCb = new CallbackProperty(() => Cartesian3.fromDegrees(ll.lon, ll.lat, 2), false);
    } else if (T) {
      const y = b.y;
      posCb = new CallbackProperty(() => T.sumoToWorld(META.boothX, y), false);
    } else {
      continue;
    }
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
  // one "Toll plaza" label on the centre-line just ahead of the booths
  // For georef: place label at a fixed lon/lat slightly up-road of the anchor; for raw: use T.
  const labelPos = isGeoref() && META.anchor
    ? (() => {
        // 26 m up-road of the anchor (booth stop line) along bearing 104°
        const b = META.bearingDeg * Math.PI / 180;
        const mPerDegLon = 111320 * Math.cos(META.anchor.lat * Math.PI / 180);
        const mPerDegLat = 110540;
        const lon = META.anchor.lon - 26 * Math.sin(b) / mPerDegLon;
        const lat = META.anchor.lat - 26 * Math.cos(b) / mPerDegLat;
        return Cartesian3.fromDegrees(lon, lat, 3);
      })()
    : (T ? T.sumoToWorld(META.boothX - 26, 0) : null);
  if (labelPos) {
    viewer.entities.add({
      position: labelPos,
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
  // Georeferenced data can be placed without a calibrated T (uses fromDegrees directly).
  if (!isGeoref() && !T) { setStatus("⊕ Calibrate the road to place + start the traffic."); return; }

  const georef = isGeoref();
  const height = (META.anchor && META.anchor.height) || 3;

  for (const v of data.vehicles) {
    const pos = new SampledPositionProperty();
    pos.setInterpolationOptions({ interpolationDegree: 2, interpolationAlgorithm: HermitePolynomialApproximation });
    pos.forwardExtrapolationType = ExtrapolationType.HOLD;
    const ang = new SampledProperty(Number);
    for (const [t, x, y, a] of v.samples) {
      const time = JulianDate.addSeconds(EPOCH, t, new JulianDate());
      // Georef: samples carry [t, lon, lat, angle] → fromDegrees. Raw: T.sumoToWorld.
      const world = georef ? Cartesian3.fromDegrees(x, y, height) : T.sumoToWorld(x, y);
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
      orientation: new CallbackProperty((time) => orientFor(ang.getValue(time) ?? a0), false),
      model: {
        uri: v.type === "truck" ? "/models/truck.glb" : "/models/car.glb",
        minimumPixelSize: 8,
        scale: v.type === "truck" ? 1.0 : 0.8,
        color: COLORS[v.type] || Color.WHITE,
        colorBlendMode: 1,  // REPLACE — fully tint the model with payment-type colour
        colorBlendAmount: 1.0,
        silhouetteColor: Color.WHITE,
        silhouetteSize: 0,
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
  // Georef: target the anchor (booth stop line centre) directly; bearing from META.
  // Raw SUMO: use T to map the reference point.
  let tgt;
  let headingRad;
  if (isGeoref() && META.anchor) {
    tgt = Cartesian3.fromDegrees(META.anchor.lon, META.anchor.lat, META.anchor.height);
    headingRad = headingRadFor(90);   // look along the corridor (bearingDeg + 90 - 180 = bearing - 90)
  } else if (T) {
    tgt = T.sumoToWorld(T.p.sumoRefX, 0);
    headingRad = T.headingRad(90);
  } else {
    return;
  }
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
  // Build a META compatible with computeBooths — support both georef and raw SUMO meta.
  if (m.georef) {
    // Georef meta from live_server: has anchor, bearingDeg, boothGeo
    META = {
      georef: true,
      anchor: m.anchor || { lon: -80.306, lat: 26.1124, height: 3 },
      bearingDeg: m.bearingDeg || 104,
      boothLon: m.boothLon,
      boothLat: m.boothLat,
      boothGeo: m.boothGeo || [],
      bounds: m.bounds || { minX: -80.311, maxX: -80.302, minY: 26.111, maxY: 26.114 },
      boothX: m.boothX || 530,
      tEnd: m.tEnd || 0,
    };
  } else if (m.bounds && typeof m.boothX === "number") {
    META = { bounds: m.bounds, boothX: m.boothX, tEnd: m.tEnd || 0 };
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
  const georef = isGeoref();
  const height = (META && META.anchor && META.anchor.height) || 3;
  for (const v of m.vehicles) {
    seen.add(v.id);
    // Georef live data: v.lon, v.lat. Raw: v.x, v.y.
    const world = georef
      ? Cartesian3.fromDegrees(v.lon, v.lat, height)
      : T.sumoToWorld(v.x, v.y);
    let e = liveEntities.get(v.id);
    if (!e) {
      const dims = DIMS[v.type] || DIMS.cash;
      e = viewer.entities.add({
        position: new ConstantPositionProperty(world),
        orientation: orientFor(v.angle),
        model: {
          uri: v.type === "truck" ? "/models/truck.glb" : "/models/car.glb",
          minimumPixelSize: 8,
          scale: v.type === "truck" ? 1.0 : 0.8,
          color: COLORS[v.type] || Color.WHITE,
          colorBlendMode: 1,  // REPLACE
          colorBlendAmount: 1.0,
        },
      });
      liveEntities.set(v.id, e);
    } else {
      e.position.setValue(world);
      e.orientation = orientFor(v.angle);
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
// The user marks the road direction (2 clicks) then clicks each real toll gate on the aerial. The
// markers land EXACTLY where clicked (source of truth), and the transform is derived from them so the
// cars flow along that line. No more guessed/random gate placement.
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
  markedGates = mark.gates.slice();
  T = buildTransformFromMarks(mark.dir, markedGates);
  calibrated = true; mark.on = false;
  btn.textContent = "⊕ Mark gates"; btn.classList.remove("on", "pulse");
  try { localStorage.setItem(siteKey(siteId), JSON.stringify({ t: T.toJSON(), g: markedGates })); } catch {}
  console.log("MARKED", markedGates.length, "gates →", JSON.stringify(T.toJSON()));
  rebuildBoothMarkers(viewer);
  if (liveMode) { sendCmd({ cmd: "reset" }); trafficStarted = true; }
  else { reloadAndStart(viewer); }
  frameCamera(viewer);
  setStatus(`✓ ${markedGates.length} gates marked — traffic flowing through them (saved).`);
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
      markedGates = mark.gates.slice();
      rebuildBoothMarkers(viewer);   // show the marker immediately where clicked
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
  { const s = loadSite(siteId); T = s.transform; markedGates = s.gates; }
  calibrated = true;
  trafficStarted = true;          // ship-with-default-transform → run immediately (no globe, no blank)

  await loadRun(viewer, offlineUrl);
  viewer.clock.currentTime = EPOCH.clone();  // ensure sim starts at t=0 on boot
  renderGatePanel();
  installMarking(viewer);

  const selectOffline = async (url, onBtn) => {
    stopLive(viewer);
    [bBase, bInt, bLive].forEach((b) => b.classList.remove("on"));
    onBtn.classList.add("on");
    offlineUrl = url;
    await loadRun(viewer, url);
    startTraffic(viewer);
    frameCamera(viewer);
  };
  bBase.onclick = () => selectOffline("/data/baseline.json", bBase);
  bInt.onclick = () => selectOffline("/data/intervention.json", bInt);
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
      { const s = loadSite(siteId); T = s.transform; markedGates = s.gates; }
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
