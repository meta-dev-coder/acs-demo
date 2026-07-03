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

// Per-type vehicle appearance (ArcGIS palette + glb). Sizes are exaggerated ~3x real so the vehicles
// read clearly at the top-down demo zoom (ArcGIS has no Cesium-style minimumPixelSize floor).
const VEH = {
  cash:  { href: "/models/car.glb",   color: [255, 155, 26],  w: 6,  d: 15, h: 5 },
  etc:   { href: "/models/car.glb",   color: [28, 203, 64],   w: 6,  d: 15, h: 5 },
  truck: { href: "/models/truck.glb", color: [58, 128, 232],  w: 7,  d: 22, h: 7 },
};
// glb nose vs ArcGIS heading (deg, CW from north): the world travel heading is the SUMO angle rotated
// into the placed corridor; this per-model offset aligns the mesh nose to travel. Tuned by screenshot.
const ARCGIS_YAW_OFFSET = { car: 90, truck: 90 };

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

  // ---- internal rAF loop (advances sim clock + interpolates sampled vehicles) ----
  _ensureRaf() {
    if (this._raf != null) return;
    const loop = () => {
      this._tick();
      this._raf = (this._clock.playing || this._sampled.length) ? requestAnimationFrame(loop) : null;
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
    if (!this._T || !this._sampled.length) return;
    const t = c.cur;
    for (const rec of this._sampled) {
      if (t < rec.t0 || t > rec.t1) {
        if (rec.graphic) { this._gfx.remove(rec.graphic); rec.graphic = null; }
        continue;
      }
      const [x, y, a] = this._sampleAt(rec, t);
      const { lon, lat } = this._T.sumoToLonLat(x, y);
      const h = this._headingFor(a, rec.type);
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
  _headingFor(angleDeg, type) {
    const off = ARCGIS_YAW_OFFSET[this._carKey(type)];
    return (((angleDeg + (this._T?.p.bearingDeg || 0) + off) % 360) + 360) % 360;
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

  // ---- live imperative vehicles ----
  addLiveVehicle(v) {
    const { lon, lat } = this._T.sumoToLonLat(v.x, v.y);
    const g = this._graphic(v.type, lon, lat, this._headingFor(v.angleDeg, v.type));
    this._gfx.add(g);
    this._live.set(v.id, g);
  }
  updateVehicle(v) {
    const g = this._live.get(v.id);
    if (!g) return;
    const { lon, lat } = this._T.sumoToLonLat(v.x, v.y);
    g.geometry = new Point({ longitude: lon, latitude: lat, z: 0 });
    g.symbol = this._symbol(v.type, this._headingFor(v.angleDeg, v.type));
  }
  hasVehicle(id) { return this._live.has(id); }
  liveIds() { return Array.from(this._live.keys()); }
  removeVehicle(id) { const g = this._live.get(id); if (g) { this._gfx.remove(g); this._live.delete(id); } }
  clearLiveVehicles() { for (const g of this._live.values()) this._gfx.remove(g); this._live.clear(); }
  placeMarker(_m) { /* chunk 9 */ }
  clearMarkers() { this._markerLayer?.removeAll(); this._markers.clear(); }
  onPick(_cb) { /* chunk 9 */ }
  setFog(_enabled, _density) { /* ArcGIS: no direct analog; no-op */ }
}
