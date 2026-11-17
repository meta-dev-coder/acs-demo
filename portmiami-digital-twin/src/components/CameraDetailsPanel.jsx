/**
 * One FL511 camera.
 *
 * The snapshot is proxied same-origin by this app's own server (see server/portmiami/api.mjs), so
 * the browser never talks to the image host. Two things are deliberately NOT done:
 *
 *   - No URL is constructed from a camera id. The DIVAS channel a snapshot needs is not in the map
 *     feed; it only appears in the camera's own detail fragment. Until that is read there is no
 *     snapshot URL, and the panel says the feed has not been resolved rather than showing a
 *     broken image.
 *   - The live HLS stream is reported, not embedded. It is served from a third-party host on a
 *     non-standard port, and whether it may be re-broadcast from another page is FL511's and
 *     DIVAS's decision, not this app's.
 */
import { useEffect, useState } from 'react';
import { LINK_STATUS_LABELS, MATCH_METHOD_LABELS, formatMeters } from '../liveTraffic/liveTrafficModel.js';
import { TrafficGlyph } from './LiveTrafficWorkspace.jsx';

const STATUS_LABELS = Object.freeze({
  LISTED: 'Listed by FL511 · feed not resolved yet',
  FEED_RESOLVED: 'Feed resolved',
  NO_VIDEO_DECLARED: 'FL511 declares no video for this camera',
  FEED_UNAVAILABLE: 'The source refused this camera’s image',
});

function Row({ label, value, note }) {
  const missing = value === null || value === undefined || value === '';
  return (
    <div className="road-detail-row">
      <dt>{label}</dt>
      <dd className={missing ? 'is-missing' : undefined}>
        {missing ? 'Not available' : value}
        {note && <small>{note}</small>}
      </dd>
    </div>
  );
}

/** The snapshot, with a cache-busting stamp so "Refresh" actually re-reads the camera. */
function Snapshot({ url }) {
  const [stamp, setStamp] = useState(() => Date.now());
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [url, stamp]);
  if (!url) return null;
  return (
    <figure className="traffic-snapshot">
      {failed ? (
        <p className="traffic-warn">
          This camera&rsquo;s image is not available from the source right now.
        </p>
      ) : (
        <img
          src={`${url}?t=${stamp}`} alt="Latest still image from this FL511 camera"
          loading="lazy" onError={() => setFailed(true)}
        />
      )}
      <figcaption>
        <button type="button" className="road-btn is-small" onClick={() => setStamp(Date.now())}>
          Refresh image
        </button>
        <small>Still image, proxied by this application. Not a live stream.</small>
      </figcaption>
    </figure>
  );
}

export function CameraDetailsPanel({ camera, detail, onStreetView, onViewOnMap, onViewRoad, onClear }) {
  const resolved = detail && !detail.loading && !detail.error ? detail : null;
  const shown = resolved ?? camera;
  const associations = shown.roadAssociations ?? [];

  return (
    <aside className="road-details traffic-details" aria-label="Camera details">
      <header className="road-details-head">
        <div>
          <h2><TrafficGlyph iconKey="CAMERA" size={18} />{shown.name ?? `FL511 camera ${camera.id}`}</h2>
          <p>Traffic camera · FL511 {camera.id}</p>
        </div>
        <button type="button" className="road-icon-btn" onClick={onClear} aria-label="Clear selection">×</button>
      </header>

      <div className="road-details-actions">
        <button type="button" className="road-btn is-primary" onClick={onViewOnMap}>View on map</button>
        {onStreetView && (
          <button type="button" className="road-btn" onClick={onStreetView}>Street View here</button>
        )}
        <button type="button" className="road-btn" onClick={onClear}>Clear selection</button>
      </div>
      {onStreetView && (
        <p className="traffic-note">
          Street View shows Google&rsquo;s imagery of the street this camera overlooks, captured on
          Google&rsquo;s own schedule. It is not this camera&rsquo;s view and it is not live.
        </p>
      )}

      {detail?.loading && <p className="traffic-note">Reading this camera from FL511…</p>}
      {detail?.error && <p className="traffic-warn">{detail.error}</p>}
      {resolved?.detailError && <p className="traffic-warn">{resolved.detailError}</p>}

      {resolved?.snapshotUrl && <Snapshot url={resolved.snapshotUrl} />}

      <section>
        <h3>Reported by FL511</h3>
        <dl>
          <Row
            label="Name" value={shown.name}
            note={shown.name ? null : 'The map feed publishes no title for this camera'}
          />
          <Row label="Source designation" value={resolved?.sourceDescription} />
          <Row label="Status" value={STATUS_LABELS[shown.status] ?? shown.status} />
          <Row
            label="Video declared"
            value={shown.videoEnabled === null || shown.videoEnabled === undefined
              ? null : shown.videoEnabled ? 'Yes' : 'No'}
            note={shown.videoEnabled === null ? 'FL511 published no value' : null}
          />
          <Row label="DIVAS channel" value={resolved?.divasChannel} />
          <Row label="Location" value={`${camera.latitude.toFixed(6)}, ${camera.longitude.toFixed(6)}`} note="latitude, longitude" />
          <Row label="FL511 camera ID" value={camera.id} />
        </dl>
        {resolved?.streamUrl && (
          <p className="traffic-note">
            FL511 also serves this camera as a live stream. {resolved.streamNote}{' '}
            <a href={resolved.streamUrl} target="_blank" rel="noopener noreferrer">Open the source stream</a>
          </p>
        )}
        {!resolved && !detail?.loading && (
          <p className="traffic-note">
            The map feed carries only this camera&rsquo;s position. Its name and its image feed come
            from FL511&rsquo;s own camera view, which has not been read yet.
          </p>
        )}
      </section>

      <section>
        <h3>PortMiami roads</h3>
        {associations.length === 0 ? (
          <p className="traffic-note">No PortMiami road centreline within range of this camera.</p>
        ) : (
          <ul className="traffic-links">
            {associations.map(link => (
              <li key={link.roadObjectId} className={`traffic-link is-${link.status.toLowerCase()}`}>
                <div className="traffic-link-head">
                  <strong>{link.roadName ?? `Segment ${link.roadObjectId}`}</strong>
                  <span className="traffic-link-status">{LINK_STATUS_LABELS[link.status]}</span>
                </div>
                <p className="traffic-link-meta">
                  Segment {link.roadObjectId} · {formatMeters(link.distanceMeters)}
                  {link.isPortAccess && ' · port access road'}
                </p>
                <p className="traffic-link-why">{MATCH_METHOD_LABELS[link.matchMethod] ?? link.matchMethod}</p>
                <button type="button" className="road-btn is-small" onClick={() => onViewRoad(link.roadObjectId)}>
                  View road
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
