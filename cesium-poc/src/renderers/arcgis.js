/*
 * renderers/arcgis.js — the ArcGIS Maps SDK for JS (5.x, @arcgis/core) implementation of the
 * renderer adapter. Loaded LAZILY (main.js `import()` only when ?renderer=arcgis) so it is
 * code-split into its own chunk and the default Cesium bundle is untouched.
 *
 * It implements the SAME surface as CesiumRenderer (init, clock, addSampledVehicle, live vehicles,
 * placeMarker, frameCamera, onPick, setFog). The SUMO physics / websocket / KPI / transform spine is
 * shared and renderer-agnostic; positions cross the boundary as SUMO metres (x,y) + compass degrees.
 * ArcGIS has no scene clock, so the offline sampled tracks are driven by an internal rAF loop that
 * interpolates each vehicle's pose at the current sim time (see _tick).
 */
import "@arcgis/core/assets/esri/themes/dark/main.css";  // ArcGIS's own CSS — sizes .esri-view to fill
import esriConfig from "@arcgis/core/config.js";
import EsriMap from "@arcgis/core/Map.js";  // aliased: bare `Map` would shadow the built-in JS Map
import Basemap from "@arcgis/core/Basemap.js";
import SceneView from "@arcgis/core/views/SceneView.js";
import WebTileLayer from "@arcgis/core/layers/WebTileLayer.js";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer.js";
import Graphic from "@arcgis/core/Graphic.js";
import Point from "@arcgis/core/geometry/Point.js";
import PointSymbol3D from "@arcgis/core/symbols/PointSymbol3D.js";
import ObjectSymbol3DLayer from "@arcgis/core/symbols/ObjectSymbol3DLayer.js";
import IconSymbol3DLayer from "@arcgis/core/symbols/IconSymbol3DLayer.js";
import TextSymbol3DLayer from "@arcgis/core/symbols/TextSymbol3DLayer.js";

// Per-type vehicle appearance (ArcGIS palette + glb). Metre sizes (near real, lightly enlarged so they
// still read at the top-down demo zoom — ArcGIS has no Cesium-style minimumPixelSize floor).
const VEH = {
  cash:  { href: "/models/car.glb",   color: [255, 155, 26],  w: 2.6, d: 6,  h: 2.4 },
  etc:   { href: "/models/car.glb",   color: [28, 203, 64],   w: 2.6, d: 6,  h: 2.4 },
  truck: { href: "/models/truck.glb", color: [58, 128, 232],  w: 3,   d: 13, h: 3.6 },
};
// glb nose vs its default facing (deg, CW). Heading is computed from the actual travel direction
// (motion vector), so this is ONLY the model's native-forward correction. Tuned by screenshot.
const GLB_NOSE_DEG = { car: 0, truck: 0 };

// @arcgis/core loads its workers/assets from a matching CDN by default; pin it explicitly so the
// Vite dev/prod bundle never needs to copy them. (Keyless — same public Esri imagery Cesium uses.)
esriConfig.assetsPath = "https://js.arcgis.com/5.1/@arcgis/core/assets";

export class ArcgisRenderer {
  constructor() {
    this._view = null;
    this._T = null;
    this._gfx = null;        // vehicle graphics layer
    this._markerLayer = null;
    this._sampled = [];      // { type, samples, graphic }
    this._live = new Map();  // id -> graphic
    this._markers = new Map();
    this._raf = null;
    this._pickHandle = null;
    // Clock: seconds since a sim epoch, advanced by wall-clock * multiplier while playing.
    this._clock = { t0: 0, t1: 0, mult: 6, cur: 0, playing: false, lastWall: 0 };
    this.clock = {
      setRange: (t0, t1) => { this._clock.t0 = t0; this._clock.t1 = t1; },
      setMultiplier: (m) => { this._clock.mult = m; },
      seek: (t) => { this._clock.cur = t; },
      play: () => { this._clock.playing = true; this._clock.lastWall = performance.now(); this._ensureRaf(); },
      pause: () => { this._clock.playing = false; },
      setPlaying: (on) => { on ? this.clock.play() : this.clock.pause(); },
      now: () => this._clock.cur,
    };
  }

  async init(containerId) {
    const imagery = new WebTileLayer({
      urlTemplate: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{level}/{row}/{col}",
      copyright: "Imagery © Esri, Maxar, Earthstar Geographics",
    });
    const map = new EsriMap({ basemap: new Basemap({ baseLayers: [imagery] }) });
    this._gfx = new GraphicsLayer({ elevationInfo: { mode: "on-the-ground" } });
    this._markerLayer = new GraphicsLayer({ elevationInfo: { mode: "on-the-ground" } });
    map.addMany([this._markerLayer, this._gfx]);

    this._view = new SceneView({
      container: containerId,
      map,
      qualityProfile: "high",
      environment: { atmosphereEnabled: false, starsEnabled: false, lighting: { directShadowsEnabled: false } },
      ui: { components: [] },
      camera: { position: { longitude: -96.8229, latitude: 33.0920, z: 700 }, tilt: 0, heading: 0 },
    });
    // Do NOT hard-block boot on view.when(): under headless SwiftShader WebGL the view renders tiles
    // but its ready promise can stay pending indefinitely. Race it against a short timeout so the app
    // always finishes booting; graphics/goTo tolerate a not-yet-"ready" view and start working once it is.
    await Promise.race([
      this._view.when().catch(() => {}),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
    this._startWall = performance.now();
    return this._view;
  }

  setTransform(T) { this._T = T; }
  raw() { return this._view; }
  vehicleCount() { return this._gfx ? this._gfx.graphics.length : 0; }
  markerCount() { return this._markerLayer ? this._markerLayer.graphics.length : 0; }

  // ---- internal rAF loop (advances sim clock + interpolates sampled vehicles) ----
  _ensureRaf() {
    if (this._raf != null) return;
    const loop = () => {
      this._tick();
      this._raf = (this._clock.playing || this._sampled.length || this._markers.size) ? requestAnimationFrame(loop) : null;
    };
    this._raf = requestAnimationFrame(loop);
  }

  _tick() {
    const c = this._clock;
    if (c.playing) {
      const now = performance.now();
      c.cur += ((now - c.lastWall) / 1000) * c.mult;
      c.lastWall = now;
      if (c.t1 > c.t0 && c.cur > c.t1) c.cur = c.t0;   // loop-stop → restart (matches Cesium LOOP_STOP feel)
    }
    this._refreshMarkerLabels();
    if (!this._T || !this._sampled.length) return;
    const t = c.cur;
    for (const rec of this._sampled) {
      if (t < rec.t0 || t > rec.t1) {
        if (rec.graphic) { this._gfx.remove(rec.graphic); rec.graphic = null; }
        continue;
      }
      const [x, y] = this._sampleAt(rec, t);
      const { lon, lat } = this._T.sumoToLonLat(x, y);
      // Heading from the travel direction of the current sample segment (robust on curves).
      const s = rec.samples, i = rec.idx, j = Math.min(i + 1, s.length - 1);
      const q0 = this._T.sumoToLonLat(s[i][1], s[i][2]);
      const q1 = this._T.sumoToLonLat(s[j][1], s[j][2]);
      const h = this._headingFromMove(q0.lon, q0.lat, q1.lon, q1.lat, rec.type, rec.lastH);
      if (!rec.graphic) {
        rec.graphic = this._graphic(rec.type, lon, lat, h);
        rec.lastH = h;
        this._gfx.add(rec.graphic);
      } else {
        rec.graphic.geometry = new Point({ longitude: lon, latitude: lat, z: 0 });
        // Only rebuild the symbol (glb re-instantiation) when the heading actually turns — cheap moves.
        if (Math.abs(h - (rec.lastH ?? h)) > 2) { rec.graphic.symbol = this._symbol(rec.type, h); rec.lastH = h; }
      }
    }
  }

  // Linear-interpolate [x,y,angle] at sim time t, with a cached bracket index per vehicle.
  _sampleAt(rec, t) {
    const s = rec.samples;
    let i = rec.idx || 0;
    if (t < s[i][0]) i = 0;
    while (i < s.length - 2 && s[i + 1][0] < t) i++;
    rec.idx = i;
    const a0 = s[i], a1 = s[Math.min(i + 1, s.length - 1)];
    const f = a1[0] > a0[0] ? (t - a0[0]) / (a1[0] - a0[0]) : 0;
    return [a0[1] + (a1[1] - a0[1]) * f, a0[2] + (a1[2] - a0[2]) * f, a0[3] + (a1[3] - a0[3]) * f];
  }

  // ---- camera ----
  frameCamera({ x, y, oblique }) {
    if (!this._T || !this._view) return;
    const { lon, lat } = this._T.sumoToLonLat(x, y);
    this._view.goTo(
      { position: { longitude: lon, latitude: lat, z: oblique ? 420 : 620 }, tilt: oblique ? 58 : 0, heading: 0 },
      { animate: false },
    ).catch(() => {});
  }

  // ---- vehicle helpers ----
  _carKey(type) { return type === "truck" ? "truck" : "car"; }
  // Compass bearing (deg, CW from north) from lon/lat p0 -> p1.
  _bearingDeg(lo0, la0, lo1, la1) {
    const east = (lo1 - lo0) * Math.cos((la0 * Math.PI) / 180);
    const north = la1 - la0;
    if (Math.abs(east) < 1e-12 && Math.abs(north) < 1e-12) return null; // no movement
    return (((Math.atan2(east, north) * 180) / Math.PI) + 360) % 360;
  }
  // Heading for the glb: the travel-direction bearing + the model's native-nose offset.
  _headingFromMove(lo0, la0, lo1, la1, type, fallback) {
    const b = this._bearingDeg(lo0, la0, lo1, la1);
    if (b == null) return fallback ?? 0;
    return ((b + GLB_NOSE_DEG[this._carKey(type)]) % 360 + 360) % 360;
  }
  _symbol(type, headingDeg) {
    const s = VEH[type] || VEH.etc;
    return new PointSymbol3D({
      symbolLayers: [new ObjectSymbol3DLayer({
        resource: { href: s.href },
        width: s.w, depth: s.d, height: s.h, heading: headingDeg,
        material: { color: s.color }, anchor: "bottom",
      })],
    });
  }
  _graphic(type, lon, lat, headingDeg) {
    return new Graphic({
      geometry: new Point({ longitude: lon, latitude: lat, z: 0 }),
      symbol: this._symbol(type, headingDeg),
    });
  }

  // ---- offline sampled track (driven by _tick) ----
  addSampledVehicle(v) {
    const s = v.samples;
    this._sampled.push({ type: v.type, samples: s, t0: s[0][0], t1: s[s.length - 1][0], idx: 0, graphic: null });
    this._ensureRaf();
  }
  clearSampled() {
    for (const r of this._sampled) if (r.graphic) this._gfx.remove(r.graphic);
    this._sampled = [];
  }

  // ---- live imperative vehicles (heading from motion between steps) ----
  addLiveVehicle(v) {
    const { lon, lat } = this._T.sumoToLonLat(v.x, v.y);
    const g = this._graphic(v.type, lon, lat, 0);
    this._gfx.add(g);
    this._live.set(v.id, { g, lon, lat, h: 0 });
  }
  updateVehicle(v) {
    const rec = this._live.get(v.id);
    if (!rec) return;
    const { lon, lat } = this._T.sumoToLonLat(v.x, v.y);
    const h = this._headingFromMove(rec.lon, rec.lat, lon, lat, v.type, rec.h);
    rec.g.geometry = new Point({ longitude: lon, latitude: lat, z: 0 });
    if (Math.abs(h - rec.h) > 2) { rec.g.symbol = this._symbol(v.type, h); rec.h = h; }
    rec.lon = lon; rec.lat = lat;
  }
  hasVehicle(id) { return this._live.has(id); }
  liveIds() { return Array.from(this._live.keys()); }
  removeVehicle(id) { const rec = this._live.get(id); if (rec) { this._gfx.remove(rec.g); this._live.delete(id); } }
  clearLiveVehicles() { for (const rec of this._live.values()) this._gfx.remove(rec.g); this._live.clear(); }
  // ---- markers (booth discs + gate ✕ / TOLL PLAZA labels) ----
  _markerSymbol(m, text) {
    const layers = [];
    if (m.disc) {
      layers.push(new IconSymbol3DLayer({
        resource: { primitive: "circle" },
        material: { color: m.disc.colorCss },
        outline: { color: [255, 255, 255, 0.9], size: 1 },
        size: 11,
      }));
    }
    if (m.label && text) {
      const kind = m.label.kind;
      const style = kind === "plaza"
        ? { color: "#bfe0ff", halo: [13, 22, 33, 0.9], size: 11 }
        : kind === "gantry"
        ? { color: "#8fe8f5", halo: [7, 35, 43, 0.92], size: 12 }
        : { color: "#ffffff", halo: [192, 26, 14, 0.95], size: 13 };
      layers.push(new TextSymbol3DLayer({
        text,
        material: { color: style.color },
        halo: { color: style.halo, size: 2 },
        size: style.size,
        font: { size: style.size, weight: "bold" },
      }));
    }
    return new PointSymbol3D({ symbolLayers: layers, verticalOffset: m.label && !m.disc ? { screenLength: 0 } : undefined });
  }

  placeMarker(m) {
    const existing = this._markers.get(m.id);
    if (existing) this._markerLayer.remove(existing.graphic);
    // Geo markers (real GIS assets) carry lon/lat directly; corridor markers go through the transform.
    const { lon, lat } = m.lon != null ? { lon: m.lon, lat: m.lat } : this._T.sumoToLonLat(m.x, m.y);
    const text = m.label ? (m.label.textFn ? m.label.textFn() : m.label.text) : null;
    const g = new Graphic({
      geometry: new Point({ longitude: lon, latitude: lat, z: 0 }),
      symbol: this._markerSymbol(m, text),
    });
    this._markerLayer.add(g);
    this._markers.set(m.id, { graphic: g, spec: m, lastText: text });
    this._ensureRaf();  // so gate ✕ label refreshes appear even while paused
  }

  clearMarkers() { this._markerLayer?.removeAll(); this._markers.clear(); }

  // Re-evaluate live label callbacks (gate ✕ toggles) and rebuild only changed marker symbols.
  _refreshMarkerLabels() {
    for (const rec of this._markers.values()) {
      const fn = rec.spec.label?.textFn;
      if (!fn) continue;
      const text = fn();
      if (text !== rec.lastText) {
        rec.lastText = text;
        rec.graphic.symbol = this._markerSymbol(rec.spec, text);
      }
    }
  }

  // ---- pick (mark-gates): SceneView click gives the ground map point directly ----
  onPick(cb) {
    if (this._pickHandle || !this._view) return;
    this._pickHandle = this._view.on("click", (e) => {
      const mp = e.mapPoint;
      cb(mp ? { lon: mp.longitude, lat: mp.latitude } : null);
    });
  }

  setFog(_enabled, _density) { /* ArcGIS: no direct analog; no-op */ }
}
