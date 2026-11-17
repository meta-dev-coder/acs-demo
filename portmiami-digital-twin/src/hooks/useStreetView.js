/**
 * Street View, wired into the React shell.
 *
 * Owns the one service, the one session and the one placement tool, and exposes the four things
 * the UI needs: whether placement is armed, whether a panorama is open, how to open one at a
 * known point, and how to leave.
 *
 * The panorama element is a ref owned by the overlay component; the session mounts the Google SDK
 * into it. Nothing here re-renders on camera movement.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createStreetViewService } from '../streetView/streetViewService.js';
import { createStreetViewSession } from '../streetView/streetViewSession.js';
import { createStreetViewPlacement } from '../cesium/streetViewPlacement.js';
import { STREET_VIEW } from '../config/portMiami.js';

export const STREET_VIEW_STATE = Object.freeze({
  OFF: 'OFF', PLACEMENT: 'PLACEMENT', OPENING: 'OPENING', ACTIVE: 'ACTIVE',
});

export function useStreetView(viewerRef, { segments } = {}) {
  const [state, setState] = useState(STREET_VIEW_STATE.OFF);
  /** The hint line under the map while placement is armed, or an error after a failed drop. */
  const [hint, setHint] = useState(null);
  const [place, setPlace] = useState(null);
  const [imageryDate, setImageryDate] = useState(null);
  const [error, setError] = useState(null);

  const hostRef = useRef(null);
  const sessionRef = useRef(null);
  const placementRef = useRef(null);
  // Read through refs so rebuilding the tools never depends on React's render order.
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  const service = useMemo(() => createStreetViewService({}), []);

  /** Open a panorama at a known point. Shared by placement and by the "Street View here" buttons. */
  const openAt = useCallback(async target => {
    const session = sessionRef.current;
    if (!session || !target) return { ok: false };
    setError(null);
    setState(STREET_VIEW_STATE.OPENING);
    setPlace(target);
    setImageryDate(null);
    // The overlay must be in the DOM before the SDK can mount into it, so let React paint first.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const result = await session.enter(target, hostRef.current);
    if (!result.ok) {
      setState(STREET_VIEW_STATE.OFF);
      setPlace(null);
      setError(result.message ?? 'Street View could not be opened.');
      return result;
    }
    setState(STREET_VIEW_STATE.ACTIVE);
    // The imagery date arrives after the view is up; it must never read as a live timestamp.
    void session.describe(result.panoId).then(({ date }) => setImageryDate(date ?? null));
    return result;
  }, []);

  const exit = useCallback(() => {
    sessionRef.current?.exit();
    setState(STREET_VIEW_STATE.OFF);
    setPlace(null);
    setImageryDate(null);
  }, []);

  // Build the session and the placement tool once the viewer exists.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || sessionRef.current) return undefined;
    // No `tilesets` option: the session finds them on the scene, so the photorealistic tileset
    // stays private to basePhotorealistic3D.js.
    sessionRef.current = createStreetViewSession(viewer, service);
    placementRef.current = createStreetViewPlacement(viewer, {
      segments: () => segmentsRef.current ?? [],
      findPanorama: (lon, lat, radius) => service.findPanorama(lon, lat, radius),
      onPlace: target => openAt(target),
      onState: (next, message) => {
        setHint(message);
        if (next === 'placement') setState(STREET_VIEW_STATE.PLACEMENT);
        if (next === 'normal') setState(current => (current === STREET_VIEW_STATE.PLACEMENT ? STREET_VIEW_STATE.OFF : current));
      },
    });
    return () => {
      placementRef.current?.destroy();
      placementRef.current = null;
      sessionRef.current?.destroy();
      sessionRef.current = null;
    };
    // Built ONCE, when the viewer appears. `state` must not be a dependency: it changes the moment
    // placement arms, and re-running this would destroy the tool that just armed itself — and, once
    // a panorama were open, tear down the session underneath it. viewerRef is a ref, `service` is a
    // useMemo([]) and `openAt` a useCallback([]), so this list is stable for the component's life.
  }, [viewerRef, service, openAt]);

  /** Escape leaves a panorama, and disarms placement. */
  useEffect(() => {
    const onKeyDown = event => {
      if (event.key !== 'Escape') return;
      if (state === STREET_VIEW_STATE.ACTIVE) exit();
      else if (state === STREET_VIEW_STATE.PLACEMENT) placementRef.current?.stop();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [state, exit]);

  const togglePlacement = useCallback(() => {
    if (state === STREET_VIEW_STATE.ACTIVE) { exit(); return; }
    setError(null);
    placementRef.current?.toggle();
  }, [state, exit]);

  return {
    enabled: STREET_VIEW.enabled,
    /** False when no Google key is configured — the same key the photorealistic tiles need. */
    available: service.hasApiKey(),
    state,
    isActive: state === STREET_VIEW_STATE.ACTIVE,
    isPlacing: state === STREET_VIEW_STATE.PLACEMENT,
    isOpening: state === STREET_VIEW_STATE.OPENING,
    hint, error, place, imageryDate,
    hostRef,
    openAt, exit, togglePlacement,
    clearError: () => setError(null),
  };
}
