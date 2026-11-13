/**
 * PortMiami project configuration — the single place that knows WHERE this twin is.
 *
 * Deliberately free of any Cesium import. Everything here is plain numbers and strings, so the
 * geography can be read by tests, by a future server, or by a second site (a different port, a
 * different project) without pulling the 3D engine in with it. `src/cesium/` converts these values
 * into camera poses; nothing in `src/cesium/` names PortMiami.
 */

/** Project identity, shown in the top bar. */
export const PROJECT = Object.freeze({
  id: 'portmiami',
  name: 'PortMiami Digital Twin',
  subtitle: 'Design & Construction Intelligence',
});

/**
 * The port's geographic reference.
 *
 * These coordinates are an initial CAMERA reference for Dodge Island — not a surveyed port
 * boundary, not a parcel, and not a datum for measurement. A real boundary belongs in a
 * GeoJSON layer when one is sourced.
 */
export const LOCATION = Object.freeze({
  label: 'PortMiami · Dodge Island',
  locality: 'Miami, Florida, USA',
  latitude: 25.778,
  longitude: -80.162,
});

/**
 * The opening camera, and the pose "Reset view" returns to.
 *
 * Angles are DEGREES here; the Cesium layer converts them to radians at the boundary (one place:
 * `cameraPose` in src/cesium/camera.js). Pitch is negative because Cesium measures it down from
 * the horizon, so -45 is a 45-degree oblique looking down at the island.
 *
 * Height 3500 m frames Dodge Island end to end and still carries Downtown Miami, the MacArthur
 * Causeway and the Port Tunnel portals in the surrounding view.
 */
export const PORT_MIAMI_CAMERA = Object.freeze({
  longitude: -80.162,
  latitude: 25.778,
  height: 3500,
  heading: 0,
  pitch: -45,
  roll: 0,
});

/** How long "Reset view" takes to fly back, in seconds. 0 would snap. */
export const RESET_FLIGHT_SECONDS = 1.2;

/**
 * The base map. One provider, reused from ACS: Google Photorealistic 3D Tiles, keyed by the
 * browser key in VITE_GOOGLE_MAPS_API_KEY. `ionToken` is optional and only enables Cesium World
 * Terrain under the tiles; the photorealistic mesh carries its own geometry, so the app is fully
 * usable without it.
 */
export const MAP_PROVIDER = Object.freeze({
  id: 'GOOGLE_PHOTOREALISTIC_3D',
  label: 'Google Photorealistic 3D Tiles',
  apiKeyEnvVar: 'VITE_GOOGLE_MAPS_API_KEY',
  ionTokenEnvVar: 'VITE_CESIUM_ION_TOKEN',
});

/** Camera limits for this site. A port is walked at metres and viewed at kilometres. */
export const CAMERA_LIMITS = Object.freeze({
  minimumZoomDistance: 1.5,
  maximumZoomDistance: 20_000_000,
});

/**
 * The data layers this twin is PLANNED to carry. None of them is implemented: this is a declared
 * roadmap, in one place, so adding one is a matter of writing its module and flipping `status`.
 * Nothing reads `status: 'planned'` and renders anything — the UI does not list these yet, because
 * a layer tree of switches that do nothing is worse than no layer tree.
 */
export const FUTURE_LAYERS = Object.freeze([
  Object.freeze({ id: 'infrastructure', label: 'Infrastructure & assets', status: 'planned' }),
  Object.freeze({ id: 'traffic', label: 'Traffic & traffic cameras', status: 'planned' }),
  Object.freeze({ id: 'weather-history', label: 'Historical weather & hurricanes', status: 'planned' }),
  Object.freeze({ id: 'flood-zones', label: 'FEMA flood zones & elevation', status: 'planned' }),
  Object.freeze({ id: 'ask-the-twin', label: 'Ask the Twin', status: 'planned' }),
  Object.freeze({ id: 'construction-projects', label: 'Construction project visualisation', status: 'planned' }),
  Object.freeze({ id: 'bim', label: 'BIM model replacement', status: 'planned' }),
  Object.freeze({ id: 'construction-impact', label: 'Construction impact simulation', status: 'planned' }),
]);

/** Everything above, as one object, for a module that wants the whole site description. */
export const PORT_MIAMI = Object.freeze({
  project: PROJECT,
  location: LOCATION,
  camera: PORT_MIAMI_CAMERA,
  resetFlightSeconds: RESET_FLIGHT_SECONDS,
  mapProvider: MAP_PROVIDER,
  cameraLimits: CAMERA_LIMITS,
  futureLayers: FUTURE_LAYERS,
});
