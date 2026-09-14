import { installI595Weather } from './i595Weather.js';
import { installCctvCameras } from './cctvCameras.js';
import { installTrafficSignals } from './trafficSignals.js';
import { installExpressGantries } from './expressGantries.js';
import { installLiveEvents } from './liveEvents.js';
import { BASE_ENVIRONMENTS, createGooglePhotorealistic3DService } from './basePhotorealistic3D.js';
import { installBaseEnvironmentControls } from './baseEnvironmentControls.js';
import { Color, GeoJsonDataSource, Cartesian3, Math as CMath, CameraEventType } from "cesium";
import { MAINLINE_COLORS } from "./i595RoadSegmentData.js";
import { CesiumRenderer } from "./renderers/cesium.js";
import corridor from "../config/corridorCenterline.json";
import cesiumModels from "../config/cesiumModels.json";
import { installRampLayerControls } from "./rampLayerControls.js";
import { installFrontageRoads } from "./sr84FrontageRoads.js";
import { createI595RoadSegmentLayer } from "./i595RoadSegmentLayer.js";
import { installI595SegmentControls } from "./i595SegmentControls.js";
import { installBridgeStructures } from "./bridgeStructures.js";
import { createSignStructureService } from "./signStructureService.js";
import { installSignStructureLayers } from "./signStructureLayers.js";
import { SIGN_STRUCTURE_TYPES } from "./signStructureData.js";
import { installI595ExpressLanes } from "./i595ExpressLanes.js";
import { createI595StartupSequence, enableLayerCheckbox } from "./i595StartupSequence.js";
import { installMapNavigationControls } from "./mapNavigationControls.js";
import { installCorridorStatusBar } from "./corridorStatusBar.js";
import { createMapLayerStore } from "./mapLayerStore.js";
import { createStreetViewService } from "./streetViewService.js";
import { createStreetViewMode } from "./streetViewMode.js";
import { createStreetViewPlacement } from "./streetViewPlacement.js";
import { installMapExplorer } from "./mapExplorer.js";
import { getTrafficColor } from "./corridorVisualConfig.js";
import { installI595RoadShields } from "./i595RoadShields.js";
import { installI595ContextLabels } from "./i595ContextLabels.js";
import { installI595Hud } from "./i595Hud.js";
import { createCesiumModelService } from "./cesiumModelService.js";
import { installCorridorModelLayers } from "./corridorModelLayers.js";
import { installAskTheTwin } from "./askTheTwin.js";
import { corridorOverview, heroView } from "./i595CorridorViews.js";
import "./i595Demo.css";

document.title = "I-595-DEMO · System-of-record";
document.body.innerHTML = `
  <div id="cesiumContainer" aria-label="I-595 highway map"></div>
  <aside class="layers" aria-label="Map layers">
    <div id="layer-content">
      <details open class="roads"><summary>Traffic</summary>
        <details open class="mainline-group"><summary>Traffic flow <span class="badge">3</span></summary>
        <label data-route="EB"><input type="checkbox" id="i595_mainline_eb"><span class="swatch"></span><span>I-595 Eastbound</span></label>
        <label data-route="WB"><input type="checkbox" id="i595_mainline_wb"><span class="swatch"></span><span>I-595 Westbound</span></label>
        <label style="--road:#ffba62"><input type="checkbox" id="express-way"><span class="swatch"></span><span>595 Express</span></label>
        </details>
        <label class="layer-option"><input type="checkbox" id="flow-direction" checked><span>Direction of travel</span></label>
        <div class="incidents-group"></div>
        <!-- Frontage roads and ramps carry traffic; they belong beside the mainline, not with the
             fixed infrastructure that stands over it. -->
        <div id="frontage-layer-controls"></div>
        <div id="ramp-layer-controls"></div>
      </details>
      <details class="its-group"><summary>Infrastructure</summary>
        <div id="structure-layer-controls"></div>
        <div id="gantry-layer-controls"></div>
      </details>
      <div id="base-environment-controls"></div>
      <p id="layer-status" role="status" aria-live="polite">Select a road to highlight it on the map.</p>
    </div>
  </aside>
  <button id="reset-view">⌖ <span>Reset view</span></button>`;

const weather = installI595Weather();
if (import.meta.hot) import.meta.hot.dispose(() => weather.destroy());

// Legend swatches come from the same palette the corridor is drawn with.
for (const label of document.querySelectorAll("label[data-route]")) {
  label.style.setProperty("--road", getTrafficColor(undefined, label.dataset.route));
}
const panel = document.querySelector(".layers");
let explorerToggle = null;
const setExplorerCollapsed = (collapsed) => {
  panel.classList.toggle("collapsed", collapsed);
  explorerToggle?.setAttribute("aria-expanded", String(!collapsed));
  explorerToggle?.setAttribute("aria-label", collapsed ? "Open map explorer" : "Close map explorer");
  document.querySelector("#layer-content").hidden = collapsed;
};

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
  // One bottom toolbar for zoom, orbit, tilt, Street View and Reset View.
  let streetViewPlacement = null;
  const navigation = installMapNavigationControls(document.body, viewer, {
    zoom, onStreetView: () => streetViewPlacement?.toggle(),
  });
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
  // Derive the opening destination using exactly three presses of the existing Zoom In.
  viewer.camera.setView({ destination: Cartesian3.fromDegrees(hero.lon, hero.lat, hero.height), orientation: orientationOf(hero) });
  for (let step = 0; step < 3; step++) zoom(0.75);
  const closer = viewer.camera.positionCartographic;
  Object.assign(hero, { lon: CMath.toDegrees(closer.longitude), lat: CMath.toDegrees(closer.latitude), height: closer.height,
    headingDeg: CMath.toDegrees(viewer.camera.heading), pitchDeg: CMath.toDegrees(viewer.camera.pitch) });
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
  const routeInputs = inputs.filter(input => ["i595_mainline_eb", "i595_mainline_wb", "express-way"].includes(input.id));
  const updateMainlineCount = () => {
    const count = routeInputs.filter(input => input.checked || input.indeterminate).length;
    status.textContent = count ? `${count} of ${routeInputs.length} traffic routes shown` : "Select a route to highlight it on the map.";
  };
  const segmentControls = installI595SegmentControls(mainlineSegments, updateMainlineCount);
  const flowToggle = document.querySelector("#flow-direction");
  // Every checkbox starts disabled until its layer is ready; this one is a display option with no
  // data to load, so it is ready as soon as the segment layer exists.
  flowToggle.disabled = false;
  flowToggle.onchange = () => mainlineSegments.setFlowVisible(flowToggle.checked);
  const expressLanes = installI595ExpressLanes(viewer, document.querySelector("#express-way"), {
    onVisibilityChange: updateMainlineCount, onStatus: message => { status.textContent = message; },
  });
  const bridgeControls = installBridgeStructures(document.querySelector("#structure-layer-controls"), viewer, mainlineSegments);
  // FDOT sign structures sit inside the Structures group the bridge layer opens, so the hierarchy
  // reads Structures → Bridges / Overlane. The service loads each type's GeoJSON exactly once.
  const signStructureService = createSignStructureService();
  const signStructureControls = installSignStructureLayers(
    document.querySelector("#structure-layer-controls .structures-group"), viewer, signStructureService,
    // The corridor's own geometry aims the inspection camera along the road: FDOT's `heading`
    // field is reserved for the model-calibration pass and is null in every current record.
    { centerline: corridor });
  const signalControls = installTrafficSignals(document.querySelector(".its-group"), viewer);
  // Street View shares the map key the photorealistic tileset already uses; the provider is only
  // created the first time someone asks for a panorama.
  // No key of its own: the provider uses GoogleMaps.defaultApiKey, which the photorealistic
  // tileset sets from VITE_GOOGLE_MAPS_API_KEY. One key, configured in one place.
  const streetView = createStreetViewService();
  const streetViewMode = createStreetViewMode(viewer, streetView, {
    tilesets: () => [baseEnvironment.tileset()],
  });
  const openStreetView = async place => {
    const result = await streetViewMode.enter(place);
    if (!result.ok && result.message) status.textContent = result.message;
    return result;
  };
  const cameraControls = installCctvCameras(document.querySelector(".its-group"), viewer, { onStreetView: openStreetView });

  // Street View is a way of exploring the corridor, not a camera feature: the toolbar tool works
  // whether or not any layer is switched on.
  const placementChip = document.createElement("p");
  placementChip.className = "street-view-placement";
  placementChip.setAttribute("role", "status");
  placementChip.hidden = true;
  document.body.append(placementChip);
  streetViewPlacement = createStreetViewPlacement(viewer, corridor, {
    onPlace: openStreetView,
    findPanorama: (lon, lat, radius) => streetView.findPanorama(lon, lat, radius),
    // Which carriageway is under the drop, when the mainline is drawn there.
    directionAt: screenPosition => mainlineSegments.directionAt(screenPosition),
    onState: (state, message) => {
      placementChip.dataset.state = state;
      placementChip.hidden = !message;
      placementChip.textContent = message ?? "";
      navigation.setStreetViewActive(state !== "normal");
    },
  });
  // Escape leaves placement without entering anything.
  const onPlacementKey = event => { if (event.key === "Escape") streetViewPlacement.stop(); };
  document.addEventListener("keydown", onPlacementKey);
  const gantryControls = installExpressGantries(document.querySelector("#gantry-layer-controls"), viewer);
  const liveEventControls = installLiveEvents(document.querySelector(".incidents-group"), viewer);
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
  // Whoever starts the base environment — the intro's first stage or the `?intro=off` path below —
  // settles this, so work that needs the drawn world can wait on readiness without racing to be the
  // one that triggers it.
  let base3dSettled;
  const base3dReady = new Promise(resolve => { base3dSettled = resolve; });
  const loadBase3D = async () => {
    try {
      await baseEnvironmentControls.set(BASE_ENVIRONMENTS.GOOGLE_PHOTOREALISTIC_3D);
      const tileset = baseEnvironment.tileset();
      if (!tileset?.initialTilesLoaded) return;
      // Wait for the first tiles so the flight below crosses a drawn world, but never hang on a slow
      // or throttled connection — the intro continues either way.
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 8000);
        const remove = tileset.initialTilesLoaded.addEventListener(() => { clearTimeout(timer); remove(); resolve(); });
      });
    } finally {
      base3dSettled();
    }
  };
  if (!showIntro) void loadBase3D();

  // GLB models from config/cesiumModels.json. They are sampled onto the world that is actually
  // drawn, so they wait for the base environment to settle — never on a timer, and never by moving
  // the camera: whatever the user is looking at stays exactly where it is.
  const corridorModels = createCesiumModelService(viewer);
  // Gantries and lane barriers are corridor layers in their own right: their controls, pins and
  // fly-to behaviour come from the records, so a new record joins the right layer on its own.
  const corridorModelLayers = installCorridorModelLayers(document.querySelector(".its-group"), viewer, corridorModels, cesiumModels);
  if (import.meta.env.DEV) window.__cesiumModels = corridorModels;

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
  // Meshes are heavy — the gantry alone is tens of megabytes. Fetching one while the corridor is
  // fading in competes with the intro for bandwidth and makes the choreography stutter, so models
  // are the last thing to arrive: after the sequence for an intro run, after the world is up
  // otherwise. Either way the camera is never touched.
  const placeCorridorModels = () => corridorModelLayers.place();
  if (showIntro) void startupSequence.run().then(placeCorridorModels);
  else {
    document.body.dataset.startup = "ready";
    void base3dReady.then(placeCorridorModels);
  }
  // Identity and real counts, read from layers that have loaded — never from the layers being shown.
  const hud = installI595Hud(document.body, {
    cameras: cameraControls.cameraById, signals: signalControls.trafficSignalById, liveEvents: liveEventControls,
  });
  // One canonical view of layer visibility, read and written through the controls the layer modules
  // already own — the rail, the quick layers, the categories, the presets and the full hierarchy
  // are all surfaces onto the same state.
  const layerStore = createMapLayerStore({
    counts: {
      signals: () => signalControls.trafficSignalById.size,
      cameras: () => cameraControls.cameraById.size,
      incidents: () => liveEventControls.events.length,
      structures: () => bridgeControls.bridgeById.size,
      // One entry per registered structure type, so a new type gets its badge for free.
      ...Object.fromEntries(SIGN_STRUCTURE_TYPES.map(type => [type.id, () => signStructureControls.countFor(type.id)])),
      gantries: () => corridorModelLayers.countFor("gantries"),
      barriers: () => corridorModelLayers.countFor("lane-barriers"),
    },
  });
  const explorer = installMapExplorer(panel, layerStore, {
    onOpenWeather: () => document.querySelector(".weather-launch")?.click(),
    onTogglePanel: () => setExplorerCollapsed(!panel.classList.contains("collapsed")),
  });
  explorerToggle = document.querySelector("#menu-toggle");
  // A fresh load opens on the map, not on the layer tree; the quick rail keeps the common
  // toggles one click away, and the explorer itself is one click from the rail.
  setExplorerCollapsed(true);

  // Operational strip: corridor facts and the live-event feed, with gaps stated rather than filled.
  const corridorStatus = installCorridorStatusBar(document.body, { mainline: mainlineSegments, liveEvents: liveEventControls });
  const askTwin = installAskTheTwin(viewer, { cameraControls });
  if (import.meta.hot) import.meta.hot.dispose(() => { document.removeEventListener("keydown", onPlacementKey); streetViewPlacement.destroy(); placementChip.remove(); streetViewMode.destroy(); askTwin.destroy(); explorer.destroy(); layerStore.destroy(); corridorStatus.destroy(); corridorModelLayers.destroy(); corridorModels.destroy(); navigation.destroy(); hud.destroy(); contextLabels.destroy(); expressLanes.destroy(); roadShields.destroy(); baseEnvironmentControls.destroy(); baseEnvironment.destroy(); liveEventControls.destroy(); cameraControls.destroy(); signalControls.destroy(); gantryControls.destroy(); signStructureControls.destroy(); bridgeControls.destroy(); segmentControls.destroy(); mainlineSegments.destroy(); frontageControls.destroy(); rampControls.destroy(); });
  for (const input of inputs) {
    // Layers with their own loader, plus display options that are not data layers at all: this loop
    // fetches `data/<id>.geojson`, and "flow-direction" has no such file — being swept up here
    // overwrote its handler and reset it on every click.
    if (['i595_mainline_eb', 'i595_mainline_wb', 'express-way', 'flow-direction'].includes(input.id)) continue;
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
