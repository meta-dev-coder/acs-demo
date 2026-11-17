import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cartesian3, HeadingPitchRange, BoundingSphere } from 'cesium';
import { assetForBuilding, representativePoint } from './infrastructure/assetModel.js';
import { PROJECT } from './config/portMiami.js';
import { usePortTwin, TWIN_STATUS } from './hooks/usePortTwin.js';
import { useMapPicker } from './hooks/useMapPicker.js';
import { useRoadNetwork, LOAD_STATE } from './hooks/useRoadNetwork.js';
import { useBuildingFootprints } from './hooks/useBuildingFootprints.js';
import { TopNav } from './components/TopNav.jsx';
import { MapControls } from './components/MapControls.jsx';
import { LoadingOverlay } from './components/LoadingOverlay.jsx';
import { LayerControls } from './components/LayerControls.jsx';
import { RoadNetworkExplorer } from './components/RoadNetworkExplorer.jsx';
import { RoadDetailsPanel } from './components/RoadDetailsPanel.jsx';
import { BuildingExplorer } from './components/BuildingExplorer.jsx';
import { BuildingDetailsPanel } from './components/BuildingDetailsPanel.jsx';
import { WeatherDialog } from './components/WeatherDialog.jsx';
import { InfrastructureExplorer } from './components/InfrastructureExplorer.jsx';
import { AssetDetailsPanel } from './components/AssetDetailsPanel.jsx';
import { useInfrastructure } from './hooks/useInfrastructure.js';
import { useLiveTraffic } from './hooks/useLiveTraffic.js';
import { useStreetView } from './hooks/useStreetView.js';
import { installAssetMarkerLayer } from './cesium/assetMarkerLayer.js';
import { StreetViewOverlay, StreetViewHint } from './components/StreetViewOverlay.jsx';
import { LiveTrafficWorkspace } from './components/LiveTrafficWorkspace.jsx';
import { AskTwinPanel } from './components/AskTwinPanel.jsx';
import { useAskTwin } from './hooks/useAskTwin.js';
import { ACTION } from './ask/actions.js';
import { WorkspaceSidebar } from './components/WorkspaceSidebar.jsx';
import { ScenarioPlanner } from './components/ScenarioPlanner.jsx';
import { useScenarioPlanner } from './hooks/useScenarioPlanner.js';
import { LiveEventDetailsPanel } from './components/LiveEventDetailsPanel.jsx';
import { CameraDetailsPanel } from './components/CameraDetailsPanel.jsx';
import { MessageSignDetailsPanel } from './components/MessageSignDetailsPanel.jsx';

/**
 * The two workspaces, over ONE Cesium viewer.
 *
 * Switching changes which panels are mounted over the map; `usePortTwin` keeps the viewer, its
 * camera and every layer exactly as they were, so a switch costs no reload and no re-fly. Two
 * viewers would mean two tile budgets and a camera that silently diverges between them.
 */
const WORKSPACE = Object.freeze({ EXPLORER: 'EXPLORER', PLANNER: 'PLANNER' });

/** Which workspace was last open. Remembered so a refresh returns where you were. */
const WORKSPACE_KEY = 'portmiami.workspace.v1';
const rememberedWorkspace = () => {
  try {
    const saved = globalThis.localStorage?.getItem(WORKSPACE_KEY);
    return saved === WORKSPACE.PLANNER ? WORKSPACE.PLANNER : WORKSPACE.EXPLORER;
  } catch {
    return WORKSPACE.EXPLORER;
  }
};

/** Which explorer is open. One at a time: two 330px columns would crowd the map. */
const EXPLORER = Object.freeze({
  NONE: 'NONE', ROADS: 'ROADS', BUILDINGS: 'BUILDINGS', INFRA: 'INFRA', TRAFFIC: 'TRAFFIC',
});

/** The selection kinds the live-traffic layer owns. */
const TRAFFIC_KINDS = Object.freeze(['traffic-event', 'traffic-camera', 'traffic-sign']);
/** A stable empty list, so the emphasis effect does not see a new array every render. */
const EMPTY_IDS = Object.freeze([]);

/**
 * The PortMiami shell.
 *
 * One selection for the whole map — `{kind, id}` — so a road and a building can never both be
 * selected and there is never more than one details panel. The layers are told what is selected;
 * neither keeps a competing copy, and clicks reach them through one shared pick dispatcher.
 *
 * Nothing here subscribes to the camera, so panning and zooming re-render no React at all.
 */
/** Fly to a bare point. Used only when an asset has a location and no confirmed footprint. */
function flyToPoint(viewer, [longitude, latitude]) {
  if (!viewer || viewer.isDestroyed()) return;
  viewer.camera.cancelFlight();
  viewer.camera.flyToBoundingSphere(
    new BoundingSphere(Cartesian3.fromDegrees(longitude, latitude, 0), 120),
    { duration: 1.6, offset: new HeadingPitchRange(0, -Math.PI / 3.2, 400) });
}

/**
 * Frame a group of points — the several roads, buildings or cameras one answer highlighted.
 *
 * A bounding sphere of them all, rather than a flight to the first: an answer that highlights
 * twelve segments has not shown them if the camera lands on one.
 */
function flyToPoints(viewer, points) {
  if (!viewer || viewer.isDestroyed() || !points.length) return;
  const sphere = BoundingSphere.fromPoints(
    points.map(([longitude, latitude]) => Cartesian3.fromDegrees(longitude, latitude, 0)));
  viewer.camera.cancelFlight();
  viewer.camera.flyToBoundingSphere(sphere, {
    duration: 1.6,
    offset: new HeadingPitchRange(0, -Math.PI / 3.2, Math.max(500, sphere.radius * 3.2)),
  });
}

export function App() {
  const containerRef = useRef(null);
  // Holds the live map-click handler; the shared picker is built once and reads through it.
  const selectFromMapRef = useRef(() => {});
  const { status, notice, viewerRef, resetView, zoom, nudge, northUp } = usePortTwin(containerRef);
  /** Open state lives here, because the map-control column has to know to step aside. */
  const [plannerOpen, setPlannerOpen] = useState(false);
  /**
   * Presentation mode: the same live scene and the same scenario, with the chrome stood down.
   *
   * It collapses the rail and folds the insight dock rather than hiding the application behind a
   * mock-up — everything on screen is still the running twin, and the way out stays in the bar.
   */
  const [presenting, setPresenting] = useState(false);

  const [selection, setSelection] = useState(null);
  const [explorer, setExplorer] = useState(EXPLORER.NONE);
  const [weatherOpen, setWeatherOpen] = useState(false);
  const [workspace, setWorkspace] = useState(rememberedWorkspace);
  useEffect(() => {
    try { globalThis.localStorage?.setItem(WORKSPACE_KEY, workspace); } catch { /* storage off */ }
  }, [workspace]);
  /**
   * What an Ask the Twin answer is highlighting, by layer. Held here rather than pushed straight
   * into the layers so that ONE effect still owns emphasis: the registry's links and the
   * assistant's highlight are merged, instead of each overwriting the other's paint.
   */
  const [askEmphasis, setAskEmphasis] = useState({ roads: [], buildings: [] });

  // A map click opens the explorer that owns what was picked, so the selection is visible in both
  // places at once. Clicking bare tiles clears the selection and leaves the explorer as it was.
  const selectFromMap = useCallback(hit => {
    setSelection(hit);
    if (hit?.kind === 'road') setExplorer(EXPLORER.ROADS);
    if (hit?.kind === 'building') setExplorer(EXPLORER.BUILDINGS);
    // A traffic marker opens Live Traffic on the subtab that lists it, so the map pick and the
    // list selection are visible together — the same behaviour roads and buildings already have.
    if (TRAFFIC_KINDS.includes(hit?.kind)) setExplorer(EXPLORER.TRAFFIC);
  }, []);

  const pickerRef = useMapPicker(viewerRef, hit => selectFromMapRef.current(hit));
  const roads = useRoadNetwork(viewerRef, pickerRef);
  const buildings = useBuildingFootprints(viewerRef, pickerRef);
  const infra = useInfrastructure({ segments: roads.segments, buildings: buildings.buildings });
  const traffic = useLiveTraffic(viewerRef, pickerRef);
  const streetView = useStreetView(viewerRef, { segments: roads.segments });
  const streetViewOn = streetView.enabled && streetView.available;

  /**
   * The camera controls, in one place.
   *
   * Shared by the map-control column and the scenario panel's own header, so the two can never
   * drift into doing different things to the same camera.
   */
  const cameraHandlers = useMemo(() => ({
    onStreetView: streetViewOn ? streetView.togglePlacement : undefined,
    streetViewArmed: streetView.isPlacing,
    onZoomIn: () => zoom(0.75),
    onZoomOut: () => zoom(1 / 0.75),
    onRotateLeft: () => nudge(-15, 0),
    onRotateRight: () => nudge(15, 0),
    onTiltUp: () => nudge(0, -6),
    onTiltDown: () => nudge(0, 6),
    onNorthUp: northUp,
    onReset: resetView,
    onWeather: () => setWeatherOpen(true),
  }), [streetViewOn, streetView.togglePlacement, streetView.isPlacing, zoom, nudge, northUp, resetView]);

  // Marks whichever asset is selected. Its own data source, so it is visible whether or not the
  // Road Network and Building layers happen to be switched on.
  const assetMarkerRef = useRef(null);
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || assetMarkerRef.current) return undefined;
    assetMarkerRef.current = installAssetMarkerLayer(viewer);
    return () => { assetMarkerRef.current?.destroy(); assetMarkerRef.current = null; };
  }, [viewerRef, status]);

  // Indexes by OBJECTID, built once per dataset, so a panel never scans 6,000 records to name one.
  const roadsById = useMemo(() => new Map(roads.segments.map(s => [s.objectId, s])), [roads.segments]);
  /** Set once `flyToAssetById` exists; the planner is declared before it. */
  const flyToAssetRef = useRef(() => {});
  const buildingsById = useMemo(() => new Map(buildings.buildings.map(b => [b.objectId, b])), [buildings.buildings]);

  // ---- the Parking Scenario Planner -------------------------------------------------------------

  const planner = useScenarioPlanner({
    viewerRef, infra, buildingsById, roadsById, active: workspace === WORKSPACE.PLANNER,
    // Through a ref: the planner is declared before the fly-to helper, because the pick
    // dispatcher above it needs the planner's picking mode.
    onFocusAsset: assetId => flyToAssetRef.current(assetId),
  });

  /**
   * "Link a footprint" from the planner: hand the user to the Explorer's existing linking
   * workflow, armed and pointed at the right asset. The planner never links one itself.
   */
  // Footprints have to be drawn to be clicked. Switching the layer on when picking starts is the
  // same courtesy "View on map" already does for a confirmed footprint.
  useEffect(() => {
    if (planner.geometryMode === 'SELECT') buildings.setVisible(true);
  }, [planner.geometryMode, buildings]);

  const linkFootprintFor = useCallback(assetId => {
    setWorkspace(WORKSPACE.EXPLORER);
    setSelection(null);
    infra.select(assetId);
    infra.setLinkMode(true);
    setExplorer(EXPLORER.INFRA);
    buildings.setVisible(true);
    flyToAssetRef.current(assetId);
  }, [infra, buildings]);
  /** Only registered parking assets may be expanded; the planner never invents a garage. */
  const garages = useMemo(
    () => infra.assets.filter(asset => asset.category === 'PARKING'), [infra.assets]);

  // While "Link building" is armed, a map click on a footprint links it to the selected asset
  // instead of selecting it. Held in a ref so the one shared picker never has to be rebuilt.
  selectFromMapRef.current = hit => {
    // While the planner is picking footprints, a building click goes into its selection set
    // instead of selecting the building — the same interception the Explorer's link mode uses.
    if (planner.geometryMode === 'SELECT' && hit?.kind === 'building') {
      planner.togglePicked(hit.id);
      return;
    }
    if (infra.linkMode && hit?.kind === 'building' && infra.selectedAssetId) {
      infra.linkBuilding(infra.selectedAssetId, hit.id);
      return;
    }
    selectFromMap(hit);
  };

  // What the planner has picked but not yet confirmed, emphasised like any other candidate.
  const plannerPicked = planner.geometryMode === 'SELECT' ? planner.picked : EMPTY_IDS;

  // Emphasise the selected asset's links on the two existing layers, plus whatever the last Ask
  // the Twin answer highlighted. No third layer, no second selection engine — the layers already
  // own their entities, and this is still the only place that paints emphasis.
  useEffect(() => {
    const merge = (fromLinks, fromAsk) => {
      const merged = new Map(fromLinks);
      // A confirmed link outranks a highlight: the assistant's result is a candidate by nature.
      for (const objectId of fromAsk) if (!merged.has(objectId)) merged.set(objectId, 'CANDIDATE');
      return merged;
    };
    roads.layerRef.current?.setEmphasis(merge(infra.emphasis.roads, askEmphasis.roads));
    buildings.layerRef.current?.setEmphasis(
      merge(infra.emphasis.buildings, [...askEmphasis.buildings, ...plannerPicked]));
  }, [infra.emphasis, askEmphasis, plannerPicked, roads.layerRef, buildings.layerRef, roads.state, buildings.state]);

  /**
   * Mark the selected asset. Driven by selection rather than by "View on map", so choosing an
   * asset in the list answers "which one is this?" immediately.
   */
  useEffect(() => {
    const marker = assetMarkerRef.current;
    if (!marker) return;
    // The planner draws its own highlight and label for the same asset; two would be clutter and
    // two labels in one place read as two different claims.
    if (workspace !== WORKSPACE.EXPLORER) { marker.clear(); return; }
    const asset = infra.selected;
    if (!asset) { marker.clear(); return; }
    // One definition of "where is this asset", shared by the marker, the camera and the details
    // panel: a confirmed footprint, else the footprint the address fronts onto, else the geocoded
    // street point, else nothing.
    const where = representativePoint(asset, infra.linksFor(asset.id), buildingsById);
    if (!where.point) { marker.clear(); return; }
    marker.show({ name: asset.name, point: where.point }, { status: where.status });
  }, [infra, buildingsById, workspace]);

  /**
   * Fly to an asset. The same three tiers the marker uses, so the camera and the pin can never
   * disagree about where the thing is: a confirmed footprint, else the footprint the address
   * fronts onto, else the street point, else no flight at all rather than a guess.
   */
  const viewAsset = useCallback(() => {
    const asset = infra.selected;
    if (!asset) return;
    const confirmedBuilding = infra.linksFor(asset.id).buildingLinks
      .find(link => link.status === 'CONFIRMED');
    if (confirmedBuilding && buildings.layerRef.current) {
      // The footprint is shown by EMPHASIS on the building layer, so flying to it with that layer
      // hidden would land on a close-up of nothing. Switch it on, as the traffic workspace does.
      buildings.setVisible(true);
      buildings.layerRef.current.flyTo(confirmedBuilding.buildingObjectId);
      return;
    }
    const where = representativePoint(asset, infra.linksFor(asset.id), buildingsById);
    if (where.point) flyToPoint(viewerRef.current, where.point);
  }, [infra, buildings, buildingsById, viewerRef]);

  // One selection, pushed down. Whichever layer does not own it is cleared, which is what stops a
  // building click from leaving an amber road highlighted behind it.
  const { select: selectRoad } = roads;
  const { select: selectBuilding } = buildings;
  useEffect(() => {
    selectRoad(selection?.kind === 'road' ? selection.id : null);
    selectBuilding(selection?.kind === 'building' ? selection.id : null);
    traffic.layerRef.current?.select(TRAFFIC_KINDS.includes(selection?.kind) ? selection : null);
  }, [selection, selectRoad, selectBuilding, traffic.layerRef]);

  // Opening a camera or a sign reads its detail from FL511 once; the hook caches by id.
  const { loadCamera, loadMessageSign } = traffic;
  useEffect(() => {
    if (selection?.kind === 'traffic-camera') void loadCamera(selection.id);
    if (selection?.kind === 'traffic-sign') void loadMessageSign(selection.id);
  }, [selection, loadCamera, loadMessageSign]);

  /**
   * Select a traffic record from a LIST. The map layer it belongs to is switched on at the same
   * time, so "View on map" can never fly the camera to a marker that is not drawn.
   */
  const selectTraffic = useCallback((kind, id, iconKey) => {
    infra.clearSelection();
    traffic.revealFor(iconKey);
    setSelection(id == null ? null : { kind, id });
  }, [infra, traffic]);

  const viewTraffic = useCallback(() => {
    if (!TRAFFIC_KINDS.includes(selection?.kind)) return;
    traffic.layerRef.current?.flyTo(selection.kind.replace('traffic-', ''), selection.id);
  }, [selection, traffic.layerRef]);

  /**
   * Open Street View at a point on the map. Used by the camera and road panels.
   *
   * Street View is Google's imagery of the public street, not a view through the asset: a camera's
   * panorama shows the road the camera overlooks, from the kerb, and is captured on Google's own
   * schedule. The panels say so where they offer it.
   */
  const streetViewAt = useCallback((longitude, latitude, label) => {
    void streetView.openAt({ longitude, latitude, label });
  }, [streetView]);

  /** Jump from a traffic marker to the road it is associated with. */
  const openRoad = useCallback(id => {
    infra.clearSelection();
    setSelection({ kind: 'road', id });
    setExplorer(EXPLORER.ROADS);
    roads.layerRef.current?.flyTo(id);
  }, [infra, roads.layerRef]);

  // ---- Ask the Twin ----------------------------------------------------------------------------

  const ask = useAskTwin({
    selection, infra, roads, buildings, traffic, explorer, viewerRef, buildingsById, planner,
  });

  /** Fly to an asset by id, using the same three tiers the marker and "View on map" use. */
  const flyToAssetById = useCallback(assetId => {
    const asset = infra.assets.find(a => a.id === assetId);
    if (!asset) return;
    const confirmed = infra.linksFor(assetId).buildingLinks.find(link => link.status === 'CONFIRMED');
    if (confirmed && buildings.layerRef.current) {
      buildings.setVisible(true);
      buildings.layerRef.current.flyTo(confirmed.buildingObjectId);
      return;
    }
    const where = representativePoint(asset, infra.linksFor(assetId), buildingsById);
    if (where.point) flyToPoint(viewerRef.current, where.point);
  }, [infra, buildings, buildingsById, viewerRef]);
  // The planner is declared above this (its picking mode is needed by the pick dispatcher), so it
  // reaches the fly-to helper through this ref rather than by closing over it.
  flyToAssetRef.current = flyToAssetById;

  /**
   * The ONE place an Ask the Twin action touches the map.
   *
   * Every action arriving here has already been validated against the loaded data, and every
   * branch below calls the same layer methods the explorers call. The assistant has no other way
   * to move the camera or change a selection, which is what keeps the two from disagreeing.
   */
  const runAskAction = useCallback(action => {
    switch (action.type) {
      case ACTION.FLY_TO_ASSET: {
        // Select it too, so the Infrastructure explorer, the marker and the camera agree.
        setSelection(null);
        infra.select(action.assetId);
        setExplorer(EXPLORER.INFRA);
        flyToAssetById(action.assetId);
        break;
      }
      case ACTION.OPEN_ASSET_DETAILS: {
        setSelection(null);
        infra.select(action.assetId);
        setExplorer(EXPLORER.INFRA);
        break;
      }
      case ACTION.SELECT_ROAD: {
        openRoad(action.objectId);
        break;
      }
      case ACTION.SELECT_BUILDING: {
        infra.clearSelection();
        setSelection({ kind: 'building', id: action.objectId });
        setExplorer(EXPLORER.BUILDINGS);
        buildings.setVisible(true);
        buildings.layerRef.current?.flyTo(action.objectId);
        break;
      }
      case ACTION.SHOW_ROADS: {
        roads.setVisible(true);
        setAskEmphasis(current => ({ ...current, roads: action.objectIds }));
        flyToPoints(viewerRef.current, action.objectIds
          .map(id => roadsById.get(id)?.midpoint).filter(Boolean));
        break;
      }
      case ACTION.SHOW_BUILDINGS: {
        buildings.setVisible(true);
        setAskEmphasis(current => ({ ...current, buildings: action.objectIds }));
        flyToPoints(viewerRef.current, action.objectIds
          .map(id => buildingsById.get(id)?.centroid).filter(Boolean));
        break;
      }
      case ACTION.SHOW_CAMERAS: {
        traffic.revealFor('CAMERA');
        // One camera is a selection, which opens its existing details panel; several is a view.
        if (action.cameraIds.length === 1) {
          selectTraffic('traffic-camera', action.cameraIds[0], 'CAMERA');
        }
        flyToPoints(viewerRef.current, action.cameraIds
          .map(id => traffic.camerasById.get(id))
          .filter(Boolean).map(camera => [camera.longitude, camera.latitude]));
        break;
      }
      case ACTION.SHOW_SCENARIO: {
        // Hand the user to the planner on that scenario. The assistant reports saved runs; the
        // planner remains the only thing that runs the model.
        setWorkspace(WORKSPACE.PLANNER);
        planner.select(action.scenarioId);
        setTimeout(() => planner.flyToScenario(), 350);
        break;
      }
      case ACTION.SHOW_TRAFFIC_EVENTS: {
        const events = action.eventIds.map(id => traffic.eventsById.get(id)).filter(Boolean);
        for (const event of events) traffic.revealFor(event.type);
        if (events.length === 1) selectTraffic('traffic-event', events[0].id, events[0].type);
        flyToPoints(viewerRef.current, events
          .map(event => [event.longitude, event.latitude])
          .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat)));
        break;
      }
      default:
        break;
    }
  }, [infra, roads, buildings, traffic, roadsById, buildingsById, viewerRef, openRoad, selectTraffic, flyToAssetById, planner]);

  const selectedTrafficEvent = selection?.kind === 'traffic-event'
    ? traffic.eventsById.get(selection.id) ?? null : null;
  const selectedCamera = selection?.kind === 'traffic-camera'
    ? traffic.camerasById.get(selection.id) ?? null : null;
  const selectedSign = selection?.kind === 'traffic-sign'
    ? traffic.signsById.get(selection.id) ?? null : null;
  const trafficSelected = Boolean(selectedTrafficEvent || selectedCamera || selectedSign);

  const clearSelection = useCallback(() => setSelection(null), []);
  const viewRoad = useCallback(id => roads.layerRef.current?.flyTo(id), [roads.layerRef]);
  const viewBuilding = useCallback(id => buildings.layerRef.current?.flyTo(id), [buildings.layerRef]);
  const toggleExplorer = next => setExplorer(current => (current === next ? EXPLORER.NONE : next));

  const isExplorer = workspace === WORKSPACE.EXPLORER;

  return (
    <div className={`app has-rail${presenting ? ' is-presenting' : ''}`}>
      <WorkspaceSidebar workspace={workspace} onChange={setWorkspace} forceCollapsed={presenting} />
      <div className="app-main">
      <TopNav project={PROJECT} askOpen={ask.open} onToggleAsk={ask.toggle}
        scenario={workspace === WORKSPACE.PLANNER ? planner.selected?.name : null}
        presenting={presenting} onPresent={() => setPresenting(value => !value)} />
      {/* `has-ask` shifts the contextual detail column left so the assistant never covers it. */}
      <main className={`app-viewport${ask.open ? ' has-ask' : ''}`}>
        <div className="cesium-container" ref={containerRef} />

        {/* The left column: the layer rail with whichever explorer is open stacked under it. A
            flex column rather than two absolutely-positioned panels, so adding a fourth layer row
            cannot push the rail under the explorer again. */}
        {/* The explorer's own chrome. Hidden in the planner, which has its own column — the
            layers themselves keep their state, so switching back restores exactly what was on. */}
        {isExplorer && (
        <div className="map-left">
          <LayerControls
            roads={roads}
            buildings={buildings}
            infra={infra}
            traffic={traffic}
            explorer={explorer}
            onToggleExplorer={toggleExplorer}
          />

        {explorer === EXPLORER.ROADS && roads.state === LOAD_STATE.READY && (
          <RoadNetworkExplorer
            network={{ ...roads, select: id => setSelection(id == null ? null : { kind: 'road', id }) }}
            onClose={() => setExplorer(EXPLORER.NONE)}
          />
        )}
        {explorer === EXPLORER.BUILDINGS && buildings.state === LOAD_STATE.READY && (
          <BuildingExplorer
            network={{ ...buildings, select: id => setSelection(id == null ? null : { kind: 'building', id }) }}
            onClose={() => setExplorer(EXPLORER.NONE)}
          />
        )}

        {explorer === EXPLORER.INFRA && (
          <InfrastructureExplorer infra={infra} onClose={() => setExplorer(EXPLORER.NONE)} />
        )}

        {explorer === EXPLORER.TRAFFIC && (
          <LiveTrafficWorkspace
            traffic={traffic}
            selection={selection}
            onSelectEvent={id => selectTraffic('traffic-event', id, traffic.eventsById.get(id)?.type)}
            onSelectCamera={id => selectTraffic('traffic-camera', id, 'CAMERA')}
            onSelectSign={id => selectTraffic('traffic-sign', id, 'MESSAGE_SIGN')}
            onClose={() => setExplorer(EXPLORER.NONE)}
          />
        )}
        </div>
        )}

        {/* One contextual panel at a time, and only in the Explorer: the planner owns the right
            column there, and selecting a garage for a scenario must not pop a panel over it. */}
        {isExplorer && selectedTrafficEvent && (
          <LiveEventDetailsPanel
            event={selectedTrafficEvent}
            onViewOnMap={viewTraffic}
            onViewRoad={openRoad}
            onClear={clearSelection}
          />
        )}
        {isExplorer && selectedCamera && (
          <CameraDetailsPanel
            camera={selectedCamera}
            detail={traffic.cameraDetails[selectedCamera.id]}
            onStreetView={streetViewOn
              ? () => streetViewAt(selectedCamera.longitude, selectedCamera.latitude,
                  traffic.cameraDetails[selectedCamera.id]?.name ?? `FL511 camera ${selectedCamera.id}`)
              : undefined}
            onViewOnMap={viewTraffic}
            onViewRoad={openRoad}
            onClear={clearSelection}
          />
        )}
        {isExplorer && selectedSign && (
          <MessageSignDetailsPanel
            sign={selectedSign}
            detail={traffic.signDetails[selectedSign.id]}
            onViewOnMap={viewTraffic}
            onViewRoad={openRoad}
            onClear={clearSelection}
          />
        )}

        {isExplorer && !trafficSelected && infra.selected ? (
          <AssetDetailsPanel
            asset={infra.selected}
            infra={infra}
            roadsById={roadsById}
            buildingsById={buildingsById}
            traffic={traffic}
            onOpenEvent={id => selectTraffic('traffic-event', id, traffic.eventsById.get(id)?.type)}
            onViewOnMap={viewAsset}
            onViewRoad={viewRoad}
            onViewBuilding={viewBuilding}
            onClear={infra.clearSelection}
          />
        ) : null}

        {isExplorer && !trafficSelected && !infra.selected && selection?.kind === 'road' && roads.selected && (
          <RoadDetailsPanel
            road={roads.selected}
            traffic={traffic}
            onStreetView={streetViewOn
              ? () => streetViewAt(roads.selected.midpoint[0], roads.selected.midpoint[1],
                  roads.selected.name || `Unnamed road · segment ${roads.selected.objectId}`)
              : undefined}
            onViewOnMap={roads.flyToSelected}
            onOpenEvent={id => selectTraffic('traffic-event', id, traffic.eventsById.get(id)?.type)}
            onClear={clearSelection}
          />
        )}
        {isExplorer && !trafficSelected && !infra.selected && selection?.kind === 'building' && buildings.selected && (
          <BuildingDetailsPanel
            building={buildings.selected}
            linkedAsset={assetForBuilding(infra.assets, infra.index, buildings.selected.objectId)}
            onOpenAsset={assetId => { infra.select(assetId); setExplorer(EXPLORER.INFRA); }}
            onFindAsset={() => setExplorer(EXPLORER.INFRA)}
            onViewOnMap={buildings.flyToSelected}
            onClear={clearSelection}
          />
        )}

        {ask.open && (
          <AskTwinPanel ask={ask} onRunAction={runAskAction} onClose={() => ask.setOpen(false)} />
        )}

        {/* The scenario panel sits where this column sits, so while it is open the column steps
            aside and the panel carries the camera buttons in its own header instead. */}
        {!plannerOpen && <MapControls {...cameraHandlers} />}

        <WeatherDialog open={weatherOpen} onClose={() => setWeatherOpen(false)} />

        {/* Placement draws on the live map, so its hint sits over the map rather than in a panel.
            The overlay replaces the map entirely once a panorama is open. */}
        <StreetViewHint streetView={streetView} />
        <StreetViewOverlay streetView={streetView} />

        {workspace === WORKSPACE.PLANNER && (
          <ScenarioPlanner
            planner={planner}
            garages={garages}
            roadsById={roadsById}
            buildingsById={buildingsById}
            onOpenAssistant={() => ask.setOpen(true)}
            onLinkFootprint={linkFootprintFor}
            open={plannerOpen}
            onOpenChange={setPlannerOpen}
            cameraHandlers={cameraHandlers}
          />
        )}

        {status === TWIN_STATUS.INITIALISING && <LoadingOverlay />}
        {notice && <p className="app-notice" role="status">{notice}</p>}
        {roads.state === LOAD_STATE.FAILED && <p className="app-notice is-second" role="status">{roads.error}</p>}
        {buildings.state === LOAD_STATE.FAILED && <p className="app-notice is-third" role="status">{buildings.error}</p>}
      </main>
      </div>
    </div>
  );
}
