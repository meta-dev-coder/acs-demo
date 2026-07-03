/*
 * renderers/cesium.js — the CesiumJS implementation of the renderer adapter.
 *
 * This is the DEFAULT renderer. It wraps a Cesium Viewer and exposes the small
 * renderer-agnostic surface that main.js drives (init / clock / vehicles, with markers,
 * camera and pick moving in over subsequent steps). The goal is that the Cesium behaviour
 * is byte-identical to the pre-adapter app: the bodies here are the original main.js
 * function bodies with `viewer` captured as `this._viewer`.
 *
 * A sibling renderers/arcgis.js (loaded lazily via ?renderer=arcgis) implements the SAME
 * surface with the ArcGIS Maps SDK — the SUMO physics / websocket / KPI / transform spine is
 * shared and renderer-agnostic. Positions cross this boundary as SUMO metres (x,y) and
 * compass degrees; the adapter applies the transform + per-model yaw offset internally.
 */
import {
  Ion, Viewer, Terrain, Color, JulianDate, Math as CMath,
  SampledPositionProperty, SampledProperty, Transforms, Matrix4,
  TimeInterval, TimeIntervalCollection, ClockRange, ExtrapolationType,
  HermitePolynomialApproximation, EllipsoidTerrainProvider, UrlTemplateImageryProvider,
  ImageryLayer, HeadingPitchRange, HeadingPitchRoll, ConstantPositionProperty,
  CallbackProperty, LabelStyle, VerticalOrigin, Cartesian2, NearFarScalar,
  ScreenSpaceEventHandler, ScreenSpaceEventType,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { CoordinateTransform } from "../transform.js";

// Sim-time origin (Cesium JulianDate). Renderer-internal: main.js deals only in seconds.
const EPOCH = JulianDate.fromIso8601("2025-01-01T00:00:00Z");

// Per-type vehicle appearance (owned by the renderer — the ArcGIS adapter keeps its own palette).
const COLORS = {
  cash: Color.fromCssColorString("#ff9b1a"),
  etc: Color.fromCssColorString("#1ccb40"),
  truck: Color.fromCssColorString("#3a80e8"),
};
const VEHICLE_SCALE  = { car: 1.0, truck: 1.25 };   // truck ~2.5x car length, not 5x
const MIN_PIXEL_SIZE = { car: 26,  truck: 30 };      // keep visible at max zoom-out
// Per-model yaw correction (deg): each glTF has its own native forward axis, so align the mesh's
// nose to the travel heading. Tuned by screenshot so cars/trucks point ALONG the corridor.
const MODEL_YAW_OFFSET = { car: -110, truck: -30 };

export class CesiumRenderer {
  constructor() {
    this._viewer = null;
    this._T = null;
    this._sampled = [];            // offline sampled-track entities
    this._live = new Map();        // id -> live entity
    this._markers = new Map();     // id -> marker entity (booths, plaza label)
    this._pickHandler = null;
    // Clock facade (renderer-owned sim time, seconds since EPOCH).
    this.clock = {
      setRange: (t0, t1) => {
        this._viewer.clock.startTime = JulianDate.addSeconds(EPOCH, t0, new JulianDate());
        this._viewer.clock.stopTime = JulianDate.addSeconds(EPOCH, t1, new JulianDate());
      },
      setMultiplier: (m) => { this._viewer.clock.multiplier = m; },
      seek: (t) => { this._viewer.clock.currentTime = JulianDate.addSeconds(EPOCH, t, new JulianDate()); },
      play: () => { this._viewer.clock.shouldAnimate = true; },
      pause: () => { this._viewer.clock.shouldAnimate = false; },
      setPlaying: (on) => { this._viewer.clock.shouldAnimate = !!on; },
      now: () => JulianDate.secondsDifference(this._viewer.clock.currentTime, EPOCH),
    };
  }

  /**
   * Create the Viewer + Esri World-Imagery basemap + terrain, mounted in #containerId.
   * @param {string} containerId — DOM id of the mount element.
   * @param {object} [opts] — opts.ionToken enables world terrain when present.
   * @returns {Promise<Viewer>} the underlying Viewer (also reachable via raw()).
   */
  async init(containerId, opts = {}) {
    const ion = opts.ionToken;
    if (ion) Ion.defaultAccessToken = ion;

    const vOpts = {
      animation: true, timeline: true, baseLayerPicker: false, geocoder: false,
      homeButton: false, navigationHelpButton: false, sceneModePicker: false,
      fullscreenButton: false, infoBox: false, selectionIndicator: false,
    };
    vOpts.baseLayer = new ImageryLayer(new UrlTemplateImageryProvider({
      url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      maximumLevel: 19, credit: "Imagery © Esri, Maxar, Earthstar Geographics",
    }));
    if (ion) vOpts.terrain = Terrain.fromWorldTerrain();
    else vOpts.terrainProvider = new EllipsoidTerrainProvider();

    const viewer = new Viewer(containerId, vOpts);
    viewer.scene.globe.enableLighting = false;
    viewer.clock.clockRange = ClockRange.LOOP_STOP;
    viewer.clock.multiplier = 6;
    this._viewer = viewer;
    return viewer;
  }

  /** Hand the active CoordinateTransform to the renderer (re-callable on re-calibration). */
  setTransform(T) { this._T = T; }

  /** The underlying Cesium Viewer (for code not yet moved behind the adapter, and window.__viewer). */
  raw() { return this._viewer; }

  // ---- internal helpers (Cesium-only) ----
  _carKey(type) { return type === "truck" ? "truck" : "car"; }

  // orientation quaternion for a SUMO/compass angle, at the plaza-centre frame.
  _orient(angleDeg, type) {
    const at = this._T.sumoToWorld(this._T.p.sumoRefX, 0);
    const yaw = this._T.headingRad(angleDeg) + CMath.toRadians(MODEL_YAW_OFFSET[this._carKey(type)]);
    return Transforms.headingPitchRollQuaternion(at, new HeadingPitchRoll(yaw, 0, 0));
  }

  _model(type) {
    const k = this._carKey(type);
    return {
      uri: type === "truck" ? "/models/truck.glb" : "/models/car.glb",
      minimumPixelSize: MIN_PIXEL_SIZE[k],
      scale: VEHICLE_SCALE[k],
      color: COLORS[type] || Color.WHITE,
      colorBlendMode: 2,  // MIX — tint while preserving model shape/shading
      colorBlendAmount: 0.6,
      silhouetteColor: Color.WHITE,
      silhouetteSize: 1.0,
    };
  }

  // ---- offline sampled track ----
  /**
   * A vehicle whose pose is a time-sampled track played by the clock.
   * @param {object} v — { type, samples:[[tSec,x,y,angleDeg],...] } (raw SUMO metres).
   */
  addSampledVehicle(v) {
    const { type, samples } = v;
    const pos = new SampledPositionProperty();
    pos.setInterpolationOptions({ interpolationDegree: 2, interpolationAlgorithm: HermitePolynomialApproximation });
    pos.forwardExtrapolationType = ExtrapolationType.HOLD;
    const ang = new SampledProperty(Number);
    for (const [t, x, y, a] of samples) {
      const time = JulianDate.addSeconds(EPOCH, t, new JulianDate());
      pos.addSample(time, this._T.sumoToWorld(x, y));
      ang.addSample(time, a);
    }
    const a0 = samples[0][3];
    const e = this._viewer.entities.add({
      availability: new TimeIntervalCollection([new TimeInterval({
        start: JulianDate.addSeconds(EPOCH, samples[0][0], new JulianDate()),
        stop: JulianDate.addSeconds(EPOCH, samples[samples.length - 1][0], new JulianDate()),
      })]),
      position: pos,
      orientation: new CallbackProperty((time) => this._orient(ang.getValue(time) ?? a0, type), false),
      model: this._model(type),
    });
    this._sampled.push(e);
    return e;
  }

  clearSampled() {
    this._sampled.forEach((e) => this._viewer.entities.remove(e));
    this._sampled = [];
  }

  // ---- live imperative vehicles ----
  addLiveVehicle(v) {
    const e = this._viewer.entities.add({
      position: new ConstantPositionProperty(this._T.sumoToWorld(v.x, v.y)),
      orientation: this._orient(v.angleDeg, v.type),
      model: this._model(v.type),
    });
    this._live.set(v.id, e);
    return e;
  }

  updateVehicle(v) {
    const e = this._live.get(v.id);
    if (!e) return;
    e.position.setValue(this._T.sumoToWorld(v.x, v.y));
    e.orientation = this._orient(v.angleDeg, v.type);
  }

  hasVehicle(id) { return this._live.has(id); }
  liveIds() { return Array.from(this._live.keys()); }
  removeVehicle(id) {
    const e = this._live.get(id);
    if (e) { this._viewer.entities.remove(e); this._live.delete(id); }
  }
  clearLiveVehicles() {
    for (const e of this._live.values()) this._viewer.entities.remove(e);
    this._live.clear();
  }

  // ---- markers (booth discs + gate ✕ labels + the TOLL PLAZA label) ----
  _labelOptions(label) {
    const textVal = label.textFn
      ? new CallbackProperty(() => label.textFn(), false)
      : label.text;
    if (label.kind === "plaza") {
      return {
        text: textVal, font: "bold 13px sans-serif",
        fillColor: Color.fromCssColorString("#bfe0ff"), showBackground: true,
        backgroundColor: Color.fromCssColorString("#0d1621").withAlpha(0.85),
        scaleByDistance: new NearFarScalar(200, 1, 4000, 0.45),
      };
    }
    // "gate" (default): red ✕ badge above the booth
    return {
      text: textVal, font: "bold 13px sans-serif", fillColor: Color.WHITE, showBackground: true,
      backgroundColor: Color.fromCssColorString("#c01a0e").withAlpha(0.92),
      style: LabelStyle.FILL, pixelOffset: new Cartesian2(0, -14),
      verticalOrigin: VerticalOrigin.BOTTOM, scaleByDistance: new NearFarScalar(200, 1, 3000, 0.5),
    };
  }

  /**
   * Upsert a marker at SUMO (x,y). id-keyed (re-place replaces). `tracking` makes the position
   * re-read the transform every frame (booths follow re-calibration). Optional disc + label.
   * @param {object} m — { id, x, y, tracking, disc?:{radiusM,colorCss,alpha}, label?:{kind,text|textFn} }
   */
  placeMarker(m) {
    const existing = this._markers.get(m.id);
    if (existing) { this._viewer.entities.remove(existing); this._markers.delete(m.id); }
    const position = m.tracking
      ? new CallbackProperty(() => this._T.sumoToWorld(m.x, m.y), false)
      : this._T.sumoToWorld(m.x, m.y);
    const opts = { position };
    if (m.disc) {
      opts.ellipse = {
        semiMajorAxis: m.disc.radiusM, semiMinorAxis: m.disc.radiusM,
        material: Color.fromCssColorString(m.disc.colorCss).withAlpha(m.disc.alpha ?? 0.9),
        outline: true, outlineColor: Color.WHITE.withAlpha(0.9), height: 1,
      };
    }
    if (m.label) opts.label = this._labelOptions(m.label);
    const e = this._viewer.entities.add(opts);
    this._markers.set(m.id, e);
    return e;
  }

  clearMarkers() {
    for (const e of this._markers.values()) this._viewer.entities.remove(e);
    this._markers.clear();
  }

  // ---- camera ----
  frameCamera({ x, y, headingDeg, oblique }) {
    const tgt = this._T.sumoToWorld(x, y);
    const headingRad = this._T.headingRad(headingDeg);
    const pitch = CMath.toRadians(oblique ? -32 : -80);
    this._viewer.camera.lookAt(tgt, new HeadingPitchRange(headingRad, pitch, oblique ? 360 : 300));
    this._viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  }

  // ---- pick (mark-gates): deliver {lon,lat}|null to cb on every left-click ----
  onPick(cb) {
    if (this._pickHandler) return;
    this._pickHandler = new ScreenSpaceEventHandler(this._viewer.scene.canvas);
    this._pickHandler.setInputAction((click) => {
      cb(CoordinateTransform.pickLonLat(this._viewer, click.position));
    }, ScreenSpaceEventType.LEFT_CLICK);
  }

  // ---- weather fog ----
  setFog(enabled, density) {
    const fog = this._viewer.scene.fog;
    fog.enabled = !!enabled;
    if (enabled && density != null) fog.density = density;
  }
}
