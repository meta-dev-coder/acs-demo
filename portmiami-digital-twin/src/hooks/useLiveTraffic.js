/**
 * Polls this app's own live-traffic API and owns the Cesium layer that draws the result.
 *
 * One poller per mounted app, two clocks matching the server's: events on the minute, cameras and
 * signs every five. Each response carries its own freshness, so the UI reports the age of the
 * DATA rather than the age of this page's last request.
 *
 * `SERVICE_UNREACHABLE` is kept distinct from an empty study area on purpose: a fetch that fails
 * leaves the previous markers on screen and says they have stopped updating, instead of clearing
 * the map and implying the roads went quiet.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LIVE_TRAFFIC_API, POLL_MS, TRAFFIC_ICONS } from '../config/liveTraffic.js';
import { SOURCE_STATUS, summariseTraffic } from '../liveTraffic/liveTrafficModel.js';
import { installLiveTrafficLayer } from '../cesium/liveTrafficLayer.js';

const unreachable = previous => ({
  ...(previous ?? {}), sourceStatus: SOURCE_STATUS.SERVICE_UNREACHABLE,
});

export function useLiveTraffic(viewerRef, pickerRef) {
  const [eventsPayload, setEventsPayload] = useState({ sourceStatus: SOURCE_STATUS.LOADING, events: [], counts: { total: 0 } });
  const [camerasPayload, setCamerasPayload] = useState({ sourceStatus: SOURCE_STATUS.LOADING, cameras: [], count: 0 });
  const [signsPayload, setSignsPayload] = useState({ sourceStatus: SOURCE_STATUS.LOADING, signs: [], count: 0 });
  /** Which marker keys are drawn. All off, like every other layer in this app. */
  const [layers, setLayers] = useState(() => Object.fromEntries(Object.keys(TRAFFIC_ICONS).map(key => [key, false])));
  /** Details read on demand: camera id -> payload, sign id -> payload. */
  const [cameraDetails, setCameraDetails] = useState({});
  const [signDetails, setSignDetails] = useState({});
  const layerRef = useRef(null);

  // ---- polling ---------------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const read = async (url, apply) => {
      try {
        const response = await fetch(url, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(String(response.status));
        const payload = await response.json();
        if (!cancelled) apply(() => payload);
      } catch {
        // Keep whatever is on screen and relabel it, rather than blanking the map.
        if (!cancelled) apply(previous => unreachable(previous));
      }
    };
    const pollEvents = () => read(LIVE_TRAFFIC_API.events, setEventsPayload);
    const pollAssets = () => {
      void read(LIVE_TRAFFIC_API.cameras, setCamerasPayload);
      void read(LIVE_TRAFFIC_API.messageSigns, setSignsPayload);
    };
    void pollEvents();
    void pollAssets();
    const eventTimer = setInterval(pollEvents, POLL_MS.events);
    const assetTimer = setInterval(pollAssets, POLL_MS.assets);
    return () => { cancelled = true; clearInterval(eventTimer); clearInterval(assetTimer); };
  }, []);

  // ---- the Cesium layer ------------------------------------------------------------------------
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || layerRef.current) return undefined;
    layerRef.current = installLiveTrafficLayer(viewer, { picker: pickerRef.current });
    return () => { layerRef.current?.destroy(); layerRef.current = null; };
    // pickerRef/viewerRef are refs; this runs once the viewer exists.
  }, [viewerRef, pickerRef, eventsPayload, camerasPayload]);

  const events = eventsPayload.events ?? [];
  const cameras = camerasPayload.cameras ?? [];
  const signs = signsPayload.signs ?? [];

  useEffect(() => { layerRef.current?.setEvents(events); }, [events]);
  useEffect(() => { layerRef.current?.setCameras(cameras); }, [cameras]);
  useEffect(() => { layerRef.current?.setMessageSigns(signs); }, [signs]);
  useEffect(() => {
    for (const [key, isVisible] of Object.entries(layers)) layerRef.current?.setLayerVisible(key, isVisible);
  }, [layers, events, cameras, signs]);

  const setLayerVisible = useCallback((key, isVisible) => {
    setLayers(current => (current[key] === isVisible ? current : { ...current, [key]: isVisible }));
  }, []);

  /** Turn on the layer a record belongs to, so "View on map" never flies to a hidden marker. */
  const revealFor = useCallback(key => setLayerVisible(key, true), [setLayerVisible]);

  // ---- details on demand -----------------------------------------------------------------------
  const loadCamera = useCallback(async id => {
    setCameraDetails(current => (current[id] ? current : { ...current, [id]: { loading: true } }));
    try {
      const response = await fetch(LIVE_TRAFFIC_API.camera(id), { headers: { accept: 'application/json' } });
      const payload = await response.json();
      setCameraDetails(current => ({ ...current, [id]: response.ok ? payload : { error: payload?.error ?? 'Unavailable' } }));
    } catch {
      setCameraDetails(current => ({ ...current, [id]: { error: 'This camera’s details could not be read.' } }));
    }
  }, []);

  const loadMessageSign = useCallback(async id => {
    setSignDetails(current => (current[id] ? current : { ...current, [id]: { loading: true } }));
    try {
      const response = await fetch(LIVE_TRAFFIC_API.messageSign(id), { headers: { accept: 'application/json' } });
      const payload = await response.json();
      setSignDetails(current => ({ ...current, [id]: response.ok ? payload : { error: payload?.error ?? 'Unavailable' } }));
    } catch {
      setSignDetails(current => ({ ...current, [id]: { error: 'This sign’s message could not be read.' } }));
    }
  }, []);

  const summary = useMemo(() => summariseTraffic(events, cameras, signs), [events, cameras, signs]);
  const eventsById = useMemo(() => new Map(events.map(event => [event.id, event])), [events]);
  const camerasById = useMemo(() => new Map(cameras.map(camera => [camera.id, camera])), [cameras]);
  const signsById = useMemo(() => new Map(signs.map(sign => [sign.id, sign])), [signs]);

  return {
    layerRef,
    eventsPayload, camerasPayload, signsPayload,
    events, cameras, signs,
    eventsById, camerasById, signsById,
    summary,
    layers, setLayerVisible, revealFor,
    cameraDetails, loadCamera,
    signDetails, loadMessageSign,
    /** Whether any marker type is currently drawn, for the rail's summary line. */
    anyLayerOn: Object.values(layers).some(Boolean),
  };
}
