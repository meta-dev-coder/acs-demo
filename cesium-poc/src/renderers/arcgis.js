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
    // Vehicle interpolation is wired in chunk 8.
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

  // ---- stubs implemented in later chunks (present so ?renderer=arcgis boots cleanly) ----
  addSampledVehicle(_v) { /* chunk 8 */ }
  clearSampled() { this._gfx?.removeAll(); this._sampled = []; }
  addLiveVehicle(_v) { /* chunk 8 */ }
  updateVehicle(_v) { /* chunk 8 */ }
  hasVehicle(id) { return this._live.has(id); }
  liveIds() { return Array.from(this._live.keys()); }
  removeVehicle(id) { this._live.delete(id); }
  clearLiveVehicles() { this._live.clear(); }
  placeMarker(_m) { /* chunk 9 */ }
  clearMarkers() { this._markerLayer?.removeAll(); this._markers.clear(); }
  onPick(_cb) { /* chunk 9 */ }
  setFog(_enabled, _density) { /* ArcGIS: no direct analog; no-op */ }
}
