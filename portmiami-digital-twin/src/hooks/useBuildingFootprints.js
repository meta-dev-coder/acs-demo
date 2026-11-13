/**
 * Loads, validates and models the building footprints, then owns the Cesium layer that draws them.
 * Same shape as useRoadNetwork — selection is one number here, pushed into the layer; the layer
 * never holds its own copy.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BUILDING_SOURCE } from '../config/buildings.js';
import {
  buildBuildings, summariseBuildings, typeDistribution, validateBuildingCollection, yearDistribution,
} from '../buildings/buildingModel.js';
import { installBuildingFootprintLayer } from '../cesium/buildingFootprintLayer.js';

export const LOAD_STATE = Object.freeze({ LOADING: 'LOADING', READY: 'READY', FAILED: 'FAILED' });

export function useBuildingFootprints(viewerRef, pickerRef) {
  const [state, setState] = useState(LOAD_STATE.LOADING);
  const [buildings, setBuildings] = useState([]);
  const [validation, setValidation] = useState(null);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  // Off by default: 6,000 footprints over photorealistic buildings is clutter until asked for.
  const [visible, setVisible] = useState(false);
  const layerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}${BUILDING_SOURCE.url}`)
      .then(response => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.json();
      })
      .then(data => {
        if (cancelled) return;
        const report = validateBuildingCollection(data, { expectedFeatureCount: BUILDING_SOURCE.expectedFeatureCount });
        setValidation(report);
        if (!report.ok) { setState(LOAD_STATE.FAILED); setError(report.errors.join(' ')); return; }
        setBuildings(buildBuildings(data));
        setState(LOAD_STATE.READY);
      })
      .catch(failure => {
        if (cancelled) return;
        setState(LOAD_STATE.FAILED);
        setError(`${BUILDING_SOURCE.label} could not be loaded (${failure.message}).`);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || buildings.length === 0 || layerRef.current) return undefined;
    layerRef.current = installBuildingFootprintLayer(viewer, buildings, {
      picker: pickerRef.current, visible,
    });
    return () => { layerRef.current?.destroy(); layerRef.current = null; };
    // `visible` is the INITIAL value for the layer; afterwards the effect below drives it. Leaving
    // it out of the dependencies is the point — a toggle must not rebuild 6,571 polylines.
  }, [viewerRef, pickerRef, buildings]);

  useEffect(() => { layerRef.current?.select(selectedId); }, [selectedId]);
  useEffect(() => { layerRef.current?.setVisible(visible); }, [visible]);

  const summary = useMemo(() => summariseBuildings(buildings), [buildings]);
  const years = useMemo(() => yearDistribution(buildings), [buildings]);
  const types = useMemo(() => typeDistribution(buildings), [buildings]);
  const byId = useMemo(() => new Map(buildings.map(b => [b.objectId, b])), [buildings]);
  const selected = selectedId == null ? null : (byId.get(selectedId) ?? null);

  const flyToSelected = useCallback(() => {
    if (selectedId != null) layerRef.current?.flyTo(selectedId);
  }, [selectedId]);

  return {
    /** The Cesium layer handle, for cross-layer features (asset link emphasis). A ref, so taking
     *  it never re-renders and never re-creates the layer. */
    layerRef,
    state, error, validation, buildings, summary, years, types,
    selected, selectedId, select: setSelectedId, clearSelection: () => setSelectedId(null),
    visible, setVisible, flyToSelected,
  };
}
