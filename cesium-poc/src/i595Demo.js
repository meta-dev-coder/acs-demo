import { installCctvCameras } from './cctvCameras.js';
import { installTrafficSignals } from './trafficSignals.js';
import { installLiveEvents } from './liveEvents.js';
import { BASE_ENVIRONMENTS, createGooglePhotorealistic3DService } from './basePhotorealistic3D.js';
import { installBaseEnvironmentControls } from './baseEnvironmentControls.js';
import { Color, GeoJsonDataSource, Cartesian3, Math as CMath, CameraEventType } from "cesium";
import { MAINLINE_COLORS } from "./i595RoadSegmentData.js";
import { CesiumRenderer } from "./renderers/cesium.js";
import corridor from "../config/corridorCenterline.json";
import { installRampLayerControls } from "./rampLayerControls.js";
import { installFrontageRoads } from "./sr84FrontageRoads.js";
import { createI595RoadSegmentLayer } from "./i595RoadSegmentLayer.js";
import { installI595SegmentControls } from "./i595SegmentControls.js";
import { installBridgeStructures } from "./bridgeStructures.js";
import { installI595ExpressLanes } from "./i595ExpressLanes.js";
import { createI595StartupSequence, enableLayerCheckbox } from "./i595StartupSequence.js";
import { installMapNavigationControls } from "./mapNavigationControls.js";
import { installI595RoadShields } from "./i595RoadShields.js";
import { installI595ContextLabels } from "./i595ContextLabels.js";
import { installI595Hud } from "./i595Hud.js";
import { corridorOverview, heroView } from "./i595CorridorViews.js";
import "./i595Demo.css";

document.title = "I-595-DEMO · System-of-record";
document.body.innerHTML = `
  <div id="cesiumContainer" aria-label="I-595 highway map"></div>
  <aside class="layers" aria-label="Map layers">
    <button id="menu-toggle" aria-expanded="true" aria-controls="layer-content"><span>☷ <span class="menu-title">Map explorer</span></span><span id="toggle-icon">‹</span></button>
    <div id="layer-content"><details open><summary>DataLayer</summary><details open class="roads"><summary>Roads</summary>
        <details open class="mainline-group"><summary>Mainline <span class="badge">3</span></summary>
        <label style="--road:#52dcf5"><input type="checkbox" id="i595_mainline_eb"><span class="swatch"></span><span>I-595 Eastbound</span></label>
        <label style="--road:#c49aff"><input type="checkbox" id="i595_mainline_wb"><span class="swatch"></span><span>I-595 Westbound</span></label>
        <label style="--road:#ffba62"><input type="checkbox" id="express-way"><span class="swatch"></span><span>595 Express</span></label>
        </details>
        <div id="frontage-layer-controls"></div>
        <div id="ramp-layer-controls"></div>
      </details>
      <div id="structure-layer-controls"></div>
      <details class="its-group"><summary>Traffic &amp; ITS</summary></details>
      </details>
      <div id="base-environment-controls"></div>
      <p id="layer-status" role="status" aria-live="polite">Select a road to highlight it on the map.</p>
    </div>
  </aside>
  <button id="reset-view">⌖ <span>Reset view</span></button>`;

const panel = document.querySelector(".layers");
const toggle = document.querySelector("#menu-toggle");
const setExplorerCollapsed = (collapsed) => {
  panel.classList.toggle("collapsed", collapsed);
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.setAttribute("aria-label", collapsed ? "Expand map explorer" : "Collapse map explorer");
  document.querySelector("#layer-content").hidden = collapsed;
  document.querySelector("#toggle-icon").textContent = collapsed ? "›" : "‹";
};
toggle.onclick = () => setExplorerCollapsed(!panel.classList.contains("collapsed"));
// A fresh load opens on the map, not on the layer tree; the explorer is one click away.
setExplorerCollapsed(true);

const status = document.querySelector("#layer-status");
const inputs = [...document.querySelectorAll('input[type="checkbox"]')];
inputs.forEach(input => { input.disabled = true; });
try {
  const renderer = new CesiumRenderer();
  const viewer = await renderer.init("cesiumContainer", { ionToken: import.meta.env.VITE_CESIUM_ION_TOKEN });
  viewer.animation.container.style.display = "none";
  viewer.timeline.container.style.display = "none";
  viewer.forceResize();
  const controller = viewer.scene.screenSpaceCameraController;
  // Manual navigation is always available — the presentation never takes the camera away from the
  // user, during the intro or after selecting a feature.
  controller.enableRotate = true;
  controller.enableTranslate = true;
  controller.enableZoom = true;
  controller.enableTilt = true;
  controller.enableLook = true;
  controller.minimumZoomDistance = 20;
  controller.maximumZoomDistance = 20000000;
  // Handle wheel/trackpad deltas consistently, keeping Cesium's drag and pinch zoom.
  controller.zoomEventTypes = [CameraEventType.RIGHT_DRAG, CameraEventType.PINCH];
  const zoom = (factor) => {
    viewer.camera.cancelFlight();
    const height = viewer.camera.positionCartographic.height;
    const target = Math.min(controller.maximumZoomDistance, Math.max(controller.minimumZoomDistance, height * factor));
    viewer.camera.zoomIn(height - target);
    viewer.scene.requestRender();
  };
  viewer.canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewer.canvas.clientHeight : 1);
    zoom(Math.exp(Math.max(-0.4, Math.min(0.4, pixels * 0.002))));
  }, { passive: false });
  // Zoom, orbit, tilt and north-up. Reset view stays a separate action on its own button.
  const navigation = installMapNavigationControls(document.body, viewer, { zoom });
  navigation.setEnabled(true);
  const lons = corridor.map(p => p.lon), lats = corridor.map(p => p.lat);
  const orientationOf = view => ({ heading: CMath.toRadians(view.headingDeg), pitch: CMath.toRadians(view.pitchDeg), roll: CMath.toRadians(view.rollDeg) });
  // Reset view stays the full corridor extent — deliberately not the close startup view.
  const overview = corridorOverview(corridor);
  const reset = () => viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(overview.lon, overview.lat, overview.height),
    orientation: orientationOf(overview), duration: 1.2,
  });
  // The opening frame is the corridor overview; the startup sequence flies from here down to the
  // oblique hero view once the 3D world is up. `?intro=off` skips the choreography entirely.
  const hero = heroView(corridor);
  const showIntro = new URLSearchParams(location.search).get("intro") !== "off";
  viewer.camera.setView(showIntro
    ? { destination: Cartesian3.fromDegrees(overview.lon, overview.lat, overview.height), orientation: orientationOf(overview) }
    : { destination: Cartesian3.fromDegrees(hero.lon, hero.lat, hero.height), orientation: orientationOf(hero) });
  document.querySelector("#reset-view").onclick = reset;
  const roadShields = installI595RoadShields(viewer, corridor);
  const contextLabels = installI595ContextLabels(viewer, corridor);
  // Shields and context labels are the same layer of meaning, so they arrive together.
  const corridorMarkers = { setOpacity: alpha => { roadShields.setOpacity(alpha); contextLabels.setOpacity(alpha); } };
  if (showIntro) corridorMarkers.setOpacity(0);
  const mainlineColors = new Map(Object.entries(MAINLINE_COLORS).map(([direction, color]) => [direction, Color.fromCssColorString(color)]));
  const rampControls = installRampLayerControls(document.querySelector("#ramp-layer-controls"), viewer);
  const frontageControls = installFrontageRoads(document.querySelector("#frontage-layer-controls"), viewer);
  const mainlineSegments = createI595RoadSegmentLayer(viewer);
  const updateMainlineCount = () => {
    const count = inputs.filter(input => input.checked || input.indeterminate).length;
    status.textContent = count ? `${count} of ${inputs.length} road layers visible` : "Select a road to highlight it on the map.";
  };
  const segmentControls = installI595SegmentControls(mainlineSegments, updateMainlineCount);
  const expressLanes = installI595ExpressLanes(viewer, document.querySelector("#express-way"), {
    onVisibilityChange: updateMainlineCount, onStatus: message => { status.textContent = message; },
  });
  const bridgeControls = installBridgeStructures(document.querySelector("#structure-layer-controls"), viewer, mainlineSegments);
  const signalControls = installTrafficSignals(document.querySelector(".its-group"), viewer);
  const cameraControls = installCctvCameras(document.querySelector(".its-group"), viewer);
  const liveEventControls = installLiveEvents(document.querySelector(".its-group"), viewer);
  // Base environment: the world the corridor sits on, so it lives outside the DataLayer tree.
  // The oblique 3D view is derived from the same corridor extent as "Reset view" — no new coordinates.
  const corridorSpan = Math.max(...lons) - Math.min(...lons);
  const view3d = () => viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(
      (Math.min(...lons) + Math.max(...lons)) / 2, Math.min(...lats) - corridorSpan * 0.3, 4200),
    orientation: { heading: 0, pitch: CMath.toRadians(-32), roll: 0 }, duration: 2,
  });
  const baseEnvironment = createGooglePhotorealistic3DService(viewer, { apiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY });
  const baseEnvironmentControls = installBaseEnvironmentControls(
    // No first-activation flight any more: 3D is the world the map opens in, and the startup camera
    // above already frames the corridor. The button below stays as an explicit "re-frame" action.
    document.querySelector("#base-environment-controls"), baseEnvironment, { onFlyRequest: view3d });
  // Photorealistic 3D is the default world. On a missing key or a failed load the service reverts to
  // the satellite basemap and says why, so startup degrades instead of failing.
  const loadBase3D = async () => {
    await baseEnvironmentControls.set(BASE_ENVIRONMENTS.GOOGLE_PHOTOREALISTIC_3D);
    const tileset = baseEnvironment.tileset();
    if (!tileset?.initialTilesLoaded) return;
    // Wait for the first tiles so the flight below crosses a drawn world, but never hang on a slow
    // or throttled connection — the intro continues either way.
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 8000);
      const remove = tileset.initialTilesLoaded.addEventListener(() => { clearTimeout(timer); remove(); resolve(); });
    });
  };
  if (!showIntro) void loadBase3D();

  const startupSequence = createI595StartupSequence({
    base3d: { load: loadBase3D },
    camera: {
      // `cancel` also resolves: taking control of the camera mid-flight must not stall the sequence.
      flyToCorridor: () => new Promise(resolve => viewer.camera.flyTo({
        destination: Cartesian3.fromDegrees(hero.lon, hero.lat, hero.height),
        orientation: orientationOf(hero), duration: 3.5, complete: resolve, cancel: resolve,
      })),
    },
    mainline: {
      enable: () => Promise.all(["#i595_mainline_eb", "#i595_mainline_wb"].map(id => enableLayerCheckbox(document.querySelector(id)))),
      // The layer's own colour hook, so the fade never touches the segments' stored styling.
      setOpacity: alpha => mainlineSegments.setColorResolver(
        alpha >= 1 ? null : segment => mainlineColors.get(segment.direction).withAlpha(alpha)),
    },
    express: { enable: () => enableLayerCheckbox(document.querySelector("#express-way")), setOpacity: alpha => expressLanes.setOpacity(alpha) },
    markers: corridorMarkers,
    onStage: stage => { document.body.dataset.startup = stage.toLowerCase().replaceAll("_", "-"); },
  });
  if (showIntro) void startupSequence.run();
  else document.body.dataset.startup = "ready";
  // Identity and real counts, read from layers that have loaded — never from the layers being shown.
  const hud = installI595Hud(document.body, {
    cameras: cameraControls.cameraById, signals: signalControls.trafficSignalById, liveEvents: liveEventControls,
  });
  if (import.meta.hot) import.meta.hot.dispose(() => { navigation.destroy(); hud.destroy(); contextLabels.destroy(); expressLanes.destroy(); roadShields.destroy(); baseEnvironmentControls.destroy(); baseEnvironment.destroy(); liveEventControls.destroy(); cameraControls.destroy(); signalControls.destroy(); bridgeControls.destroy(); segmentControls.destroy(); mainlineSegments.destroy(); frontageControls.destroy(); rampControls.destroy(); });
  for (const input of inputs) {
    if (input.id === 'i595_mainline_eb' || input.id === 'i595_mainline_wb' || input.id === 'express-way') continue;
    input.disabled = false;
    let source, pending;
    input.onchange = async () => {
      try {
        if (input.checked && !source) {
          status.textContent = "Loading road geometry…";
          pending ??= GeoJsonDataSource.load(`${import.meta.env.BASE_URL}data/${input.id}.geojson`, {
            stroke: Color.fromCssColorString(input.closest("label").style.getPropertyValue("--road")), strokeWidth: 6, clampToGround: true,
          }).then(async data => { data.show = false; await viewer.dataSources.add(data); source = data; return data; }).catch(error => { pending = null; throw error; });
          await pending;
        }
        if (source) source.show = input.checked;
        updateMainlineCount();
        viewer.scene.requestRender();
      } catch (error) {
        input.checked = false;
        status.textContent = "Unable to load this road. Check your connection and select it to retry.";
        console.error(error);
      }
    };
  }
} catch (error) {
  status.textContent = "The map could not start. Please reload with WebGL enabled.";
  console.error(error);
}
