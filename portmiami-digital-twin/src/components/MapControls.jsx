/**
 * The camera controls, in the same column treatment as the ACS map navigation toolbar: zoom,
 * orbit, tilt, a compass reset, Home (which returns to the opening PortMiami view), and Weather
 * at the foot of the column, below Home — the same placement it has in the ACS twin.
 */

/** A cloud with the sun behind it, drawn on the same 20x20 grid as the other glyphs. */
const WEATHER_ICON = (
  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <path d="M7.2 8.1a4 4 0 0 1 5.6-4.4" />
    <path d="M13.3 3.1v1.3M16.9 6.7h-1.3M16.2 4.1l-.9.9M16.2 9.3l-.9-.9" />
    <path d="M6.4 16.4a3 3 0 0 1-.3-6 4.1 4.1 0 0 1 7.7 1 2.5 2.5 0 0 1-.4 5h-7Z" />
  </svg>
);

/** Pegman's silhouette, on the same 20x20 grid as the other glyphs. */
const STREET_VIEW_ICON = (
  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    <circle cx="10" cy="4.4" r="2.4" />
    <path d="M6.2 9.3a3.8 3.8 0 0 1 7.6 0v3.1h-1.9v4.9H8.1v-4.9H6.2Z" />
  </svg>
);

/**
 * Every control the column can show, in order.
 *
 * Exported because the scenario planner shows a subset of them in its own header: the panel
 * covers the column, so the camera controls move INTO the panel rather than being duplicated
 * there. One definition, one set of handlers, two places that render them.
 */
export const MAP_CONTROL_BUTTONS = [
  { key: 'zoomIn', label: 'Zoom in', glyph: '+', prop: 'onZoomIn' },
  { key: 'zoomOut', label: 'Zoom out', glyph: '−', prop: 'onZoomOut' },
  { key: 'rotateLeft', label: 'Rotate left', glyph: '↺', prop: 'onRotateLeft', group: true },
  { key: 'rotateRight', label: 'Rotate right', glyph: '↻', prop: 'onRotateRight' },
  { key: 'tiltUp', label: 'Tilt up', glyph: '↑', prop: 'onTiltUp', group: true },
  { key: 'tiltDown', label: 'Tilt down', glyph: '↓', prop: 'onTiltDown' },
  { key: 'northUp', label: 'Face north', glyph: 'N', prop: 'onNorthUp', group: true },
  { key: 'reset', label: 'Home — reset to PortMiami', glyph: '⌖', prop: 'onReset', group: true },
  { key: 'weather', label: 'Weather — today and the next 7 days', icon: WEATHER_ICON, prop: 'onWeather', group: true },
  { key: 'streetView', label: 'Street View — drop onto the map', icon: STREET_VIEW_ICON, prop: 'onStreetView' },
];

/** The camera controls the scenario panel carries in its own header: zoom, orbit and tilt. */
export const PANEL_CAMERA_KEYS = Object.freeze(
  ['zoomIn', 'zoomOut', 'rotateLeft', 'rotateRight', 'tiltUp', 'tiltDown']);

/**
 * Render a set of these buttons.
 *
 * `keys` picks which, and `grouped` says whether to keep the column's separator rules — a row in
 * a panel header has no columns to separate, so it drops them.
 */
export function MapControlButtons({ handlers, keys = null, grouped = true }) {
  const wanted = keys ? MAP_CONTROL_BUTTONS.filter(b => keys.includes(b.key)) : MAP_CONTROL_BUTTONS;
  return wanted
    // A button with no handler is not rendered: Street View is absent when it is switched off
    // or has no key, rather than present and dead.
    .filter(button => typeof handlers[button.prop] === 'function')
    .map(button => (
      <button
        key={button.key}
        type="button"
        className={`${grouped && button.group ? 'is-group-start' : ''}${button.icon ? ' has-icon' : ''}`.trim() || undefined}
        title={button.label}
        aria-label={button.label}
        aria-haspopup={button.key === 'weather' ? 'dialog' : undefined}
        aria-pressed={button.key === 'streetView' ? Boolean(handlers.streetViewArmed) : undefined}
        onClick={handlers[button.prop]}
      >
        {button.icon ?? <span aria-hidden="true">{button.glyph}</span>}
      </button>
    ));
}

export function MapControls(handlers) {
  return (
    <div className="map-controls" role="group" aria-label="Map navigation">
      <MapControlButtons handlers={handlers} />
    </div>
  );
}
