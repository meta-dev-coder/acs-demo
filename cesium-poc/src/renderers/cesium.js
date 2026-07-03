/*
 * renderers/cesium.js — the CesiumJS implementation of the renderer adapter.
 *
 * This is the DEFAULT renderer. It wraps a Cesium Viewer and exposes the small
 * renderer-agnostic surface that main.js drives (init / clock / raw, with vehicles,
 * markers, camera and pick moving in over subsequent steps). The goal is that the
 * Cesium behaviour is byte-identical to the pre-adapter app: the bodies here are the
 * original main.js function bodies with `viewer` captured as `this._viewer`.
 *
 * A sibling renderers/arcgis.js (loaded lazily via ?renderer=arcgis) implements the
 * SAME surface with the ArcGIS Maps SDK — the SUMO physics / websocket / KPI / transform
 * spine is shared and renderer-agnostic.
 */
import {
  Ion, Viewer, Terrain, ClockRange,
  EllipsoidTerrainProvider, UrlTemplateImageryProvider, ImageryLayer,
} from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

export class CesiumRenderer {
  constructor() {
    this._viewer = null;
    this._T = null;
  }

  /**
   * Create the Viewer + Esri World-Imagery basemap + terrain, mounted in #containerId.
   * @param {string} containerId — DOM id of the mount element.
   * @param {object} [opts]
   *   opts.ionToken — Cesium ion token; enables world terrain when present.
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
}
