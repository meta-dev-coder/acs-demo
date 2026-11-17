/**
 * One FL511 dynamic message sign, and whatever it is currently displaying.
 *
 * A sign's message is not in the map feed — only its id and position are — so it is read from the
 * sign's own detail fragment when the sign is opened. Until then there is no message, which the
 * panel says in those words. Nothing here composes sign text: if FL511 published no message, the
 * panel shows no message.
 */
import { LINK_STATUS_LABELS, MATCH_METHOD_LABELS, formatMeters } from '../liveTraffic/liveTrafficModel.js';
import { TrafficGlyph } from './LiveTrafficWorkspace.jsx';

export function MessageSignDetailsPanel({ sign, detail, onViewOnMap, onViewRoad, onClear }) {
  const resolved = detail && !detail.loading && !detail.error ? detail : null;
  const shown = resolved ?? sign;
  const associations = shown.roadAssociations ?? [];

  return (
    <aside className="road-details traffic-details" aria-label="Message sign details">
      <header className="road-details-head">
        <div>
          <h2><TrafficGlyph iconKey="MESSAGE_SIGN" size={18} />{shown.name ?? `FL511 sign ${sign.id}`}</h2>
          <p>Dynamic message sign · FL511 {sign.id}</p>
        </div>
        <button type="button" className="road-icon-btn" onClick={onClear} aria-label="Clear selection">×</button>
      </header>

      <div className="road-details-actions">
        <button type="button" className="road-btn is-primary" onClick={onViewOnMap}>View on map</button>
        <button type="button" className="road-btn" onClick={onClear}>Clear selection</button>
      </div>

      {detail?.loading && <p className="traffic-note">Reading this sign from FL511…</p>}
      {detail?.error && <p className="traffic-warn">{detail.error}</p>}
      {resolved?.detailError && <p className="traffic-warn">{resolved.detailError}</p>}

      <section>
        <h3>Current message</h3>
        {resolved?.message ? (
          /* Rendered in the sign's own idiom — fixed pitch, upper case as FL511 sends it — so it
             reads as the sign's content rather than as this app's prose. */
          <pre className="traffic-sign-message">{resolved.message}</pre>
        ) : (
          <p className="traffic-note">
            {detail?.loading
              ? 'Reading the sign’s current message…'
              : 'FL511 published no message for this sign at the time it was read. A sign with no '
                + 'message is not the same as a sign showing nothing — this app reports only '
                + 'what the source returned.'}
          </p>
        )}
        <dl>
          <div className="road-detail-row">
            <dt>Last updated at source</dt>
            <dd className={resolved?.messageUpdatedAt ? undefined : 'is-missing'}>
              {resolved?.messageUpdatedAt ?? 'Not available'}
            </dd>
          </div>
          <div className="road-detail-row">
            <dt>Location</dt>
            <dd>{sign.latitude.toFixed(6)}, {sign.longitude.toFixed(6)}<small>latitude, longitude</small></dd>
          </div>
          <div className="road-detail-row">
            <dt>FL511 sign ID</dt>
            <dd>{sign.id}</dd>
          </div>
        </dl>
      </section>

      <section>
        <h3>PortMiami roads</h3>
        {associations.length === 0 ? (
          <p className="traffic-note">No PortMiami road centreline within range of this sign.</p>
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
        <p className="traffic-note">
          A sign stands beside a road; the message it carries may concern an entirely different one.
          These are the segments near the sign, not the roads the message is about.
        </p>
      </section>
    </aside>
  );
}
