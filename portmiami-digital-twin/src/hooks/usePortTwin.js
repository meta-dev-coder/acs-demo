/**
 * The one React hook that owns the 3D world.
 *
 * It creates exactly one Cesium Viewer for the life of the component, puts the camera at the
 * configured opening pose BEFORE the first render so the globe never shows elsewhere first, then
 * asks for the photorealistic tiles. The camera is never moved again on its own: after startup the
 * only thing that flies it is the Reset view button.
 *
 * Everything the UI needs comes back as plain state, so no component below touches Cesium.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortViewer } from '../cesium/createViewer.js';
import { createGooglePhotorealistic3DService } from '../cesium/basePhotorealistic3D.js';
import { cameraPose, faceNorth, orbit } from '../cesium/camera.js';
import { CAMERA_LIMITS, MAP_PROVIDER, PORT_MIAMI_CAMERA, RESET_FLIGHT_SECONDS } from '../config/portMiami.js';

/** @typedef {'INITIALISING'|'READY'|'DEGRADED'} TwinStatus */
export const TWIN_STATUS = Object.freeze({ INITIALISING: 'INITIALISING', READY: 'READY', DEGRADED: 'DEGRADED' });

export function usePortTwin(containerRef) {
  const sessionRef = useRef(null);
  // The viewer itself, for layers that draw into it. A ref, not state, so installing a layer
  // never re-renders the tree — and so nothing below re-renders when the camera moves.
  const viewerRef = useRef(null);
  const [status, setStatus] = useState(TWIN_STATUS.INITIALISING);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const container = containerRef.current;
    // A second run with a viewer already in hand would mean two WebGL contexts on one container.
    if (!container || sessionRef.current) return undefined;

    let cancelled = false;
    const session = createPortViewer(container, {
      ionToken: import.meta.env[MAP_PROVIDER.ionTokenEnvVar],
      cameraLimits: CAMERA_LIMITS,
    });
    sessionRef.current = session;
    viewerRef.current = session.viewer;

    // A handle for the console and for browser-driven checks. Development only: a production
    // bundle must not hand the scene graph to anything that happens to be running on the page.
    if (import.meta.env.DEV) globalThis.__portViewer = session.viewer;

    // The opening frame, set (not flown) so the first painted frame is already PortMiami.
    session.viewer.camera.setView(cameraPose(PORT_MIAMI_CAMERA));

    const base = createGooglePhotorealistic3DService(session.viewer, {
      apiKey: import.meta.env[MAP_PROVIDER.apiKeyEnvVar],
    });
    session.base = base;

    // A failure here is not fatal: `enable` leaves the imagery basemap showing and reports why, so
    // the app still opens over PortMiami with a flat map and an honest message.
    base.enable().then(result => {
      if (cancelled) return;
      setStatus(result.ok ? TWIN_STATUS.READY : TWIN_STATUS.DEGRADED);
      setNotice(result.ok ? '' : (result.message ?? ''));
    });

    return () => {
      cancelled = true;
      base.destroy();
      session.destroy();
      sessionRef.current = null;
      viewerRef.current = null;
      if (import.meta.env.DEV && globalThis.__portViewer === session.viewer) delete globalThis.__portViewer;
    };
    // containerRef is a ref object: stable for the life of the component, so this runs once.
  }, [containerRef]);

  const resetView = useCallback(() => {
    const viewer = sessionRef.current?.viewer;
    if (!viewer || viewer.isDestroyed()) return;
    viewer.camera.flyTo({ ...cameraPose(PORT_MIAMI_CAMERA), duration: RESET_FLIGHT_SECONDS });
  }, []);

  const zoom = useCallback(factor => sessionRef.current?.zoom(factor), []);

  /** Orbit or tilt by a step, around the point under the centre of the view. */
  const nudge = useCallback((headingDeltaDeg, pitchDeltaDeg) => {
    const viewer = sessionRef.current?.viewer;
    if (!viewer || viewer.isDestroyed()) return;
    orbit(viewer, headingDeltaDeg, pitchDeltaDeg);
  }, []);

  /** Turn to north without moving. */
  const northUp = useCallback(() => {
    const viewer = sessionRef.current?.viewer;
    if (!viewer || viewer.isDestroyed()) return;
    faceNorth(viewer);
  }, []);

  return { status, notice, viewerRef, resetView, zoom, nudge, northUp };
}
