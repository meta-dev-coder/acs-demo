/**
 * Loads, validates and models the road network once, then owns the Cesium layer that draws it.
 *
 * The layer is installed as soon as both the viewer and the data exist, and is torn down with the
 * component. Selection lives here as React state (one number) and is pushed into the layer; the
 * layer pushes map clicks back up. Neither side holds the other's copy of the truth.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ROAD_SOURCE } from '../config/roadNetwork.js';
import { buildRoadSegments, roadClasses, roadMunicipalities, summariseRoads, validateRoadCollection } from '../roads/roadModel.js';
import { installRoadNetworkLayer } from '../cesium/roadNetworkLayer.js';

export const LOAD_STATE = Object.freeze({ LOADING: 'LOADING', READY: 'READY', FAILED: 'FAILED' });

export function useRoadNetwork(viewerRef, pickerRef) {
  const [state, setState] = useState(LOAD_STATE.LOADING);
  const [segments, setSegments] = useState([]);
  const [validation, setValidation] = useState(null);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [visible, setVisible] = useState(true);
  const layerRef = useRef(null);

  // Load and validate. BASE_URL rather than a leading slash, so the app still works under a
  // sub-path; `document.baseURI` is not used because it carries any query string with it.
  useEffect(() => {
    let cancelled = false;
    const url = `${import.meta.env.BASE_URL}${ROAD_SOURCE.url}`;
    fetch(url)
      .then(response => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return response.json();
      })
      .then(data => {
        if (cancelled) return;
        const report = validateRoadCollection(data, { expectedFeatureCount: ROAD_SOURCE.expectedFeatureCount });
        setValidation(report);
        if (!report.ok) { setState(LOAD_STATE.FAILED); setError(report.errors.join(' ')); return; }
        setSegments(buildRoadSegments(data));
        setState(LOAD_STATE.READY);
      })
      .catch(failure => {
        if (cancelled) return;
        setState(LOAD_STATE.FAILED);
        setError(`${ROAD_SOURCE.label} could not be loaded (${failure.message}).`);
      });
    return () => { cancelled = true; };
  }, []);

  // Install the layer once both halves are ready. Picking goes through the shared dispatcher, so
  // this layer never competes with the building layer for a click.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || segments.length === 0 || layerRef.current) return undefined;
    layerRef.current = installRoadNetworkLayer(viewer, segments, { picker: pickerRef.current });
    return () => { layerRef.current?.destroy(); layerRef.current = null; };
  }, [viewerRef, pickerRef, segments]);

  useEffect(() => { layerRef.current?.select(selectedId); }, [selectedId]);
  useEffect(() => { layerRef.current?.setVisible(visible); }, [visible]);

  const summary = useMemo(() => summariseRoads(segments), [segments]);
  const classes = useMemo(() => roadClasses(segments), [segments]);
  const municipalities = useMemo(() => roadMunicipalities(segments), [segments]);
  const selected = useMemo(
    () => segments.find(segment => segment.objectId === selectedId) ?? null, [segments, selectedId]);

  /** The only thing that moves the camera for a road. Never called by selection on its own. */
  const flyToSelected = useCallback(() => {
    if (selectedId != null) layerRef.current?.flyTo(selectedId);
  }, [selectedId]);

  return {
    /** The Cesium layer handle, for cross-layer features (asset link emphasis). A ref, so taking
     *  it never re-renders and never re-creates the layer. */
    layerRef,
    state, error, validation, segments, summary, classes, municipalities,
    selected, selectedId, select: setSelectedId, clearSelection: () => setSelectedId(null),
    visible, setVisible, flyToSelected,
  };
}
