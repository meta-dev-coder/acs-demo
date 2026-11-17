/**
 * The Street View overlay: the panorama, and the chrome around it.
 *
 * The panorama itself is rendered by the Google Maps JS SDK into `hostRef`; everything else here
 * is this app's own chrome, in the same surface treatment as the rest of the panels.
 *
 * Mounted whenever Street View is opening or active, so the SDK has an element to attach to before
 * it is asked to. While it is up it covers the map completely — the twin underneath has had its
 * layers hidden, and the session restores them on exit.
 */
import { STREET_VIEW_STATE } from '../hooks/useStreetView.js';

export function StreetViewOverlay({ streetView }) {
  const { state, place, imageryDate, hostRef, exit } = streetView;
  if (state !== STREET_VIEW_STATE.ACTIVE && state !== STREET_VIEW_STATE.OPENING) return null;
  const opening = state === STREET_VIEW_STATE.OPENING;

  return (
    <section className="street-view" data-state={opening ? 'loading' : 'active'} aria-label="Street View">
      {/* The SDK mounts here. It must exist before `enter` runs, which is why this component is
          rendered during OPENING as well as ACTIVE. */}
      <div className="street-view-pano" ref={hostRef} aria-label="Google Street View panorama" />

      <div className="street-view-bar">
        <div className="street-view-identity">
          <p className="street-view-title">PortMiami Street View</p>
          <p className="street-view-context">
            {place?.label ?? 'PortMiami study area'}
            {place?.roadName && place?.roadObjectId != null && ` · segment ${place.roadObjectId}`}
          </p>
        </div>
        {/* Google's capture month, never presented as a live timestamp. */}
        {imageryDate && <p className="street-view-imagery">Imagery: {imageryDate}</p>}
        <button type="button" className="street-view-return" onClick={exit}>
          Return to Digital Twin
        </button>
      </div>

      {opening && <p className="street-view-status" role="status">Loading Street View…</p>}
    </section>
  );
}

/** The placement hint, shown under the map while a drop is armed. Separate: the map stays visible. */
export function StreetViewHint({ streetView }) {
  const { isPlacing, hint, error } = streetView;
  const message = error ?? hint;
  if (!message || (!isPlacing && !error)) return null;
  return (
    <p className="street-view-placement" data-state={error ? 'unavailable' : 'placement'} role="status">
      {message}
    </p>
  );
}
