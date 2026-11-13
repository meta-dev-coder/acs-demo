import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Cartesian3, HeadingPitchRange, BoundingSphere } from 'cesium';
import { assetForBuilding } from './infrastructure/assetModel.js';
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

/** Which explorer is open. One at a time: two 330px columns would crowd the map. */
const EXPLORER = Object.freeze({ NONE: 'NONE', ROADS: 'ROADS', BUILDINGS: 'BUILDINGS', INFRA: 'INFRA' });

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

export function App() {
  const containerRef = useRef(null);
  // Holds the live map-click handler; the shared picker is built once and reads through it.
  const selectFromMapRef = useRef(() => {});
  const { status, notice, viewerRef, resetView, zoom, nudge, northUp } = usePortTwin(containerRef);

  const [selection, setSelection] = useState(null);
  const [explorer, setExplorer] = useState(EXPLORER.NONE);
  const [weatherOpen, setWeatherOpen] = useState(false);

  // A map click opens the explorer that owns what was picked, so the selection is visible in both
  // places at once. Clicking bare tiles clears the selection and leaves the explorer as it was.
  const selectFromMap = useCallback(hit => {
    setSelection(hit);
    if (hit?.kind === 'road') setExplorer(EXPLORER.ROADS);
    if (hit?.kind === 'building') setExplorer(EXPLORER.BUILDINGS);
  }, []);

  const pickerRef = useMapPicker(viewerRef, hit => selectFromMapRef.current(hit));
  const roads = useRoadNetwork(viewerRef, pickerRef);
  const buildings = useBuildingFootprints(viewerRef, pickerRef);
  const infra = useInfrastructure({ segments: roads.segments, buildings: buildings.buildings });

  // Indexes by OBJECTID, built once per dataset, so a panel never scans 6,000 records to name one.
  const roadsById = useMemo(() => new Map(roads.segments.map(s => [s.objectId, s])), [roads.segments]);
  const buildingsById = useMemo(() => new Map(buildings.buildings.map(b => [b.objectId, b])), [buildings.buildings]);

  // While "Link building" is armed, a map click on a footprint links it to the selected asset
  // instead of selecting it. Held in a ref so the one shared picker never has to be rebuilt.
  selectFromMapRef.current = hit => {
    if (infra.linkMode && hit?.kind === 'building' && infra.selectedAssetId) {
      infra.linkBuilding(infra.selectedAssetId, hit.id);
      return;
    }
    selectFromMap(hit);
  };

  // Emphasise the selected asset's links on the two existing layers. No third layer, no second
  // selection engine — the layers already own their entities.
  useEffect(() => {
    roads.layerRef.current?.setEmphasis(infra.emphasis.roads);
    buildings.layerRef.current?.setEmphasis(infra.emphasis.buildings);
  }, [infra.emphasis, roads.layerRef, buildings.layerRef, roads.state, buildings.state]);

  /** Fly to an asset: its confirmed footprint if it has one, else its derived street point. */
  const viewAsset = useCallback(() => {
    const asset = infra.selected;
    if (!asset) return;
    const confirmedBuilding = infra.linksFor(asset.id).buildingLinks
      .find(link => link.status === 'CONFIRMED');
    if (confirmedBuilding && buildings.layerRef.current) {
      buildings.layerRef.current.flyTo(confirmedBuilding.buildingObjectId);
      return;
    }
    // No confirmed footprint and no location means no flight at all, rather than a guess.
    if (asset.point) flyToPoint(viewerRef.current, asset.point);
  }, [infra, buildings.layerRef, viewerRef]);

  // One selection, pushed down. Whichever layer does not own it is cleared, which is what stops a
  // building click from leaving an amber road highlighted behind it.
  const { select: selectRoad } = roads;
  const { select: selectBuilding } = buildings;
  useEffect(() => {
    selectRoad(selection?.kind === 'road' ? selection.id : null);
    selectBuilding(selection?.kind === 'building' ? selection.id : null);
  }, [selection, selectRoad, selectBuilding]);

  const clearSelection = useCallback(() => setSelection(null), []);
  const viewRoad = useCallback(id => roads.layerRef.current?.flyTo(id), [roads.layerRef]);
  const viewBuilding = useCallback(id => buildings.layerRef.current?.flyTo(id), [buildings.layerRef]);
  const toggleExplorer = next => setExplorer(current => (current === next ? EXPLORER.NONE : next));

  return (
    <div className="app">
      <TopNav project={PROJECT} />
      <main className="app-viewport">
        <div className="cesium-container" ref={containerRef} />

        {/* The left column: the layer rail with whichever explorer is open stacked under it. A
            flex column rather than two absolutely-positioned panels, so adding a fourth layer row
            cannot push the rail under the explorer again. */}
        <div className="map-left">
          <LayerControls
            roads={roads}
            buildings={buildings}
            infra={infra}
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
        </div>

        {/* One contextual panel at a time: an asset selection supersedes a road or building one. */}
        {infra.selected ? (
          <AssetDetailsPanel
            asset={infra.selected}
            infra={infra}
            roadsById={roadsById}
            buildingsById={buildingsById}
            onViewOnMap={viewAsset}
            onViewRoad={viewRoad}
            onViewBuilding={viewBuilding}
            onClear={infra.clearSelection}
          />
        ) : null}

        {!infra.selected && selection?.kind === 'road' && roads.selected && (
          <RoadDetailsPanel road={roads.selected} onViewOnMap={roads.flyToSelected} onClear={clearSelection} />
        )}
        {!infra.selected && selection?.kind === 'building' && buildings.selected && (
          <BuildingDetailsPanel
            building={buildings.selected}
            linkedAsset={assetForBuilding(infra.assets, infra.index, buildings.selected.objectId)}
            onOpenAsset={assetId => { infra.select(assetId); setExplorer(EXPLORER.INFRA); }}
            onFindAsset={() => setExplorer(EXPLORER.INFRA)}
            onViewOnMap={buildings.flyToSelected}
            onClear={clearSelection}
          />
        )}

        <MapControls
          onZoomIn={() => zoom(0.75)}
          onZoomOut={() => zoom(1 / 0.75)}
          onRotateLeft={() => nudge(-15, 0)}
          onRotateRight={() => nudge(15, 0)}
          onTiltUp={() => nudge(0, -6)}
          onTiltDown={() => nudge(0, 6)}
          onNorthUp={northUp}
          onReset={resetView}
          onWeather={() => setWeatherOpen(true)}
        />

        <WeatherDialog open={weatherOpen} onClose={() => setWeatherOpen(false)} />

        {status === TWIN_STATUS.INITIALISING && <LoadingOverlay />}
        {notice && <p className="app-notice" role="status">{notice}</p>}
        {roads.state === LOAD_STATE.FAILED && <p className="app-notice is-second" role="status">{roads.error}</p>}
        {buildings.state === LOAD_STATE.FAILED && <p className="app-notice is-third" role="status">{buildings.error}</p>}
      </main>
    </div>
  );
}
