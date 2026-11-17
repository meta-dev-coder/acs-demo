/**
 * Live Traffic configuration: the layers, their icons, and the endpoints behind them.
 *
 * Like src/config/portMiami.js and src/config/roadNetwork.js this file imports nothing from Cesium
 * and holds no geometry — it is the rules and the vocabulary, in one editable place.
 *
 * The icon set is ported from the ACS I-595 Safety Twin's `src/liveOps/opsIcons.js`, glyph for
 * glyph, so a closure looks like a closure in both twins: the same striped barrier, the same
 * orange cone, the same red triangle. Reusing the drawings is the point — an operator who knows
 * one map can read the other.
 */

/** Same-origin always. The browser never talks to FL511; see server/portmiami/api.mjs. */
export const LIVE_TRAFFIC_API = Object.freeze({
  events: '/api/portmiami/live-events',
  cameras: '/api/portmiami/cameras',
  camera: id => `/api/portmiami/cameras/${encodeURIComponent(id)}`,
  messageSigns: '/api/portmiami/message-signs',
  messageSign: id => `/api/portmiami/message-signs/${encodeURIComponent(id)}`,
});

/**
 * How often the browser re-reads our own API. The SERVER's FL511 cadence is separate (60 s for
 * events, 300 s for cameras and signs) and is published on every response, so a page that polls
 * faster than the server refreshes still reports the true age of the data rather than its own.
 */
export const POLL_MS = Object.freeze({ events: 60_000, assets: 300_000 });

/**
 * Filled glyphs on a 24x24 grid, ported from ACS. Filled rather than stroked because a stroke
 * thins out when the pin is rasterised small, which is what made ACS's earlier markers hard to
 * tell apart at a glance.
 */
export const TRAFFIC_ICONS = Object.freeze({
  INCIDENT: Object.freeze({
    label: 'Incidents', color: '#e5484d',
    glyph: '<path d="M12 2.8 23 21.2H1z"/><path d="M11 9h2v6h-2zM11 16.4h2v2h-2z" fill="#fff"/>',
  }),
  CLOSURE: Object.freeze({
    label: 'Road Closures', color: '#dc2626',
    glyph: '<path d="M2 7.6h20v8.8H2z"/><path d="m6.2 7.6-3 8.8H5l3-8.8zM12.2 7.6l-3 8.8H11l3-8.8zM18.2 7.6l-3 8.8H17l3-8.8z" fill="#fff"/><path d="M2.6 4.4h2.2v15.2H2.6zM19.2 4.4h2.2v15.2h-2.2z"/>',
  }),
  // Darkened from ACS's #f97316, which carries a white glyph at only 2.80:1 — under even the 3:1
  // WCAG bar for a non-text graphic. Same hue, 5.18:1. (#c2410c is already this app's warm accent
  // in the weather chart.)
  CONSTRUCTION: Object.freeze({
    label: 'Construction', color: '#c2410c',
    glyph: '<path d="M10.7 2.8h2.6l5.1 15.6H5.6z"/><path d="M8.6 9.4h6.8l.8 2.5H7.8z" fill="#fff"/><path d="M2.4 18.4h19.2v2.8H2.4z"/>',
  }),
  // Darkened from ACS's #eab308, the worst of the set at 1.92:1 — a white glyph on it was close
  // to invisible. This is SDNA's own darkened $warning (--ui-tone-warn in theme.css), 5.07:1,
  // chosen there for exactly this reason.
  CONGESTION: Object.freeze({
    label: 'Congestion', color: '#a15e21',
    glyph: '<path d="M3 5.2h13v3.4H3zM3 10.3h13v3.4H3zM3 15.4h13v3.4H3z"/><path d="M19.4 4.8h2.2v11.4h-2.2z"/><path d="m16.6 15.2 3.9 4.2 3.9-4.2z"/>',
  }),
  DISABLED_VEHICLE: Object.freeze({
    label: 'Disabled Vehicles', color: '#3b82f6',
    glyph: '<path d="M3.4 13.2 5.6 7.4A2 2 0 0 1 7.5 6h9a2 2 0 0 1 1.9 1.4l2.2 5.8v5.3a1 1 0 0 1-1 1h-1.5a1 1 0 0 1-1-1v-1H6.9v1a1 1 0 0 1-1 1H4.4a1 1 0 0 1-1-1z"/><circle cx="7.1" cy="15.1" r="1.4" fill="#fff"/><circle cx="16.9" cy="15.1" r="1.4" fill="#fff"/>',
  }),
  // Cameras and message signs are INFRASTRUCTURE, not events: they carry no severity, so they
  // take the SDNA primary blue rather than a status hue. #1862d0 is $primary from
  // sdna_quasar_wf/sdna-frontend/src/css/quasar.variables.scss, the same value src/theme.css
  // binds to --ui-accent and the road layer already uses for port-access roads.
  // White glyph on it: 5.68:1.
  CAMERA: Object.freeze({
    label: 'Traffic Cameras', color: '#1862d0',
    glyph: '<path d="M2.6 6.4h12.2a1.6 1.6 0 0 1 1.6 1.6v8a1.6 1.6 0 0 1-1.6 1.6H2.6A1.6 1.6 0 0 1 1 16V8a1.6 1.6 0 0 1 1.6-1.6z"/><path d="m18 9.6 4.4-2.6v10l-4.4-2.6z"/>',
  }),
  // A darker step of the SAME hue (#1862d0 x 0.7), not a second colour: the two infrastructure
  // pins stay one family, and are told apart by their silhouettes — a camera body against a sign
  // panel — so identity is never colour alone. White glyph on it: 9.17:1.
  MESSAGE_SIGN: Object.freeze({
    label: 'Message Signs', color: '#114592',
    glyph: '<path d="M2.4 4.6h19.2a1.4 1.4 0 0 1 1.4 1.4v9.2a1.4 1.4 0 0 1-1.4 1.4H2.4A1.4 1.4 0 0 1 1 15.2V6a1.4 1.4 0 0 1 1.4-1.4z"/><path d="M4.2 7.6h8v1.6h-8zM4.2 11.2h12v1.6h-12z" fill="#fff"/><path d="M11 17.4h2v3.4h-2z"/>',
  }),
});

/**
 * The map layers, in the order they appear in the rail. Each toggles independently, and every one
 * starts OFF — the map opens quiet, as the road and building layers already do, so an operator
 * turns on what they want rather than being handed seven kinds of marker at once.
 *
 * There is no Traffic Speeds row. FL511 publishes no speed feed through the endpoint family this
 * integration reads, and a toggle for a layer that can never have data would be a promise the data
 * cannot keep. The Overview tab says so in words instead.
 */
export const TRAFFIC_LAYERS = Object.freeze([
  Object.freeze({ key: 'INCIDENT', kind: 'event', label: 'Incidents' }),
  Object.freeze({ key: 'CLOSURE', kind: 'event', label: 'Road Closures' }),
  Object.freeze({ key: 'CONGESTION', kind: 'event', label: 'Congestion' }),
  Object.freeze({ key: 'CONSTRUCTION', kind: 'event', label: 'Construction' }),
  Object.freeze({ key: 'DISABLED_VEHICLE', kind: 'event', label: 'Disabled Vehicles' }),
  Object.freeze({ key: 'CAMERA', kind: 'camera', label: 'Traffic Cameras' }),
  Object.freeze({ key: 'MESSAGE_SIGN', kind: 'sign', label: 'Message Signs' }),
]);

/** How markers are drawn over Google Photorealistic 3D Tiles. */
export const TRAFFIC_RENDER = Object.freeze({
  /**
   * The same fixed offset the road layer uses, for the same reason: the globe is hidden, so there
   * is nothing to clamp to. See the header of src/cesium/roadNetworkLayer.js.
   */
  heightOffsetM: 6,
  /** Pins are raised so they stand clear of the mesh and of the road lines beneath them. */
  pinHeightM: 24,
  /**
   * The pin's size ON SCREEN, in CSS pixels, and the reason it has to be stated.
   *
   * The pin image is authored at 4x (176x208) so it stays sharp close up. A Cesium billboard with
   * no `width`/`height` takes the image's NATURAL size, so `scale` alone was sizing these against
   * 176x208 — about 92x108 px on screen, roughly three and a half times too big. ACS avoids this
   * by setting `width: 44, height: 52` explicitly (see cesium-poc/src/liveEvents.js); the same is
   * done here, a little smaller again so a port that fits in one view is not covered by its own
   * markers. `scale` below is then a plain multiplier on these numbers.
   */
  pin: Object.freeze({ width: 38, height: 44 }),
  scale: Object.freeze({ resting: 1, hovered: 1.1, selected: 1.2 }),
  /**
   * Billboards fade with distance rather than piling into an unreadable heap when the camera pulls
   * back, which is the clustering the spec asks for without hiding anything behind a count badge
   * an operator then has to click to open.
   */
  scaleByDistance: Object.freeze({ near: 300, nearValue: 1, far: 14_000, farValue: 0.45 }),
  /** The dashed line between a two-point event's published anchors. */
  connector: Object.freeze({ color: '#ff8a8a', width: 3, dashLength: 14 }),
});

/**
 * Source attribution, shown wherever live traffic data is. FL511's data is Florida DOT's and is
 * published through fl511.com; this app re-publishes it read-only and says where it came from.
 */
export const SOURCE_ATTRIBUTION = Object.freeze({
  name: 'FL511',
  operator: 'Florida Department of Transportation',
  url: 'https://fl511.com',
  note: 'Live road-event, camera and message-sign data retrieved from FL511 by this application’s '
    + 'own server. Camera imagery is served by DIVAS on FDOT’s behalf.',
});
