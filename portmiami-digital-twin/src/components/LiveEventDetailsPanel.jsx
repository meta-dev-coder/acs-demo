/**
 * One FL511 event's details.
 *
 * Follows the ACS twin's rule, and the one the Road and Building panels already follow here: what
 * FL511 published and what this app's geometry derived are rendered under SEPARATE headings and
 * never interleaved. An event 15 m from Port Blvd is routinely an event on the ramp beside it, so
 * proximity is never allowed to look like FL511 saying "Port Blvd".
 */
import {
  AREA_MATCH_LABELS, EVENT_LABELS, LINK_STATUS_LABELS, MATCH_METHOD_LABELS,
  eventLabel, eventSourceRows, formatMeters,
} from '../liveTraffic/liveTrafficModel.js';
import { TrafficGlyph } from './LiveTrafficWorkspace.jsx';

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

function Association({ link, onViewRoad }) {
  return (
    <li className={`traffic-link is-${link.status.toLowerCase()}`}>
      <div className="traffic-link-head">
        <strong>{link.roadName ?? `Segment ${link.roadObjectId}`}</strong>
        <span className="traffic-link-status">{LINK_STATUS_LABELS[link.status]}</span>
      </div>
      <p className="traffic-link-meta">
        Segment {link.roadObjectId} · {formatMeters(link.distanceMeters)}
        {link.isPortAccess && ' · port access road'}
        {link.isTunnel && ' · tunnel centreline'}
      </p>
      <p className="traffic-link-why">{MATCH_METHOD_LABELS[link.matchMethod] ?? link.matchMethod}</p>
      {link.evidence?.directionConflict && (
        <p className="traffic-warn">
          The event states direction {link.evidence.directionsInSourceText.join('/')} and this
          segment is {link.evidence.segmentDirections.join('/')}. Downgraded to a candidate.
        </p>
      )}
      <button type="button" className="road-btn is-small" onClick={() => onViewRoad(link.roadObjectId)}>
        View road
      </button>
    </li>
  );
}

export function LiveEventDetailsPanel({ event, onViewOnMap, onViewRoad, onClear }) {
  const sourceRows = eventSourceRows(event);
  const associations = event.roadAssociations ?? [];
  const matched = associations.filter(link => link.status === 'MATCHED');
  const candidates = associations.filter(link => link.status !== 'MATCHED');

  return (
    <aside className="road-details traffic-details" aria-label="Live event details">
      <header className="road-details-head">
        <div>
          <h2><TrafficGlyph iconKey={event.type} size={18} />{eventLabel(event)}</h2>
          <p>{EVENT_LABELS[event.type]} · FL511 event {event.sourceEventId}</p>
        </div>
        <button type="button" className="road-icon-btn" onClick={onClear} aria-label="Clear selection">×</button>
      </header>

      <div className="road-details-actions">
        <button type="button" className="road-btn is-primary" onClick={onViewOnMap}>View on map</button>
        <button type="button" className="road-btn" onClick={onClear}>Clear selection</button>
      </div>

      <section>
        <h3>Reported by FL511</h3>
        <dl>
          {sourceRows.map(([label, value]) => <Row key={label} label={label} value={value} />)}
        </dl>
        {!event.detailsAvailable && (
          <p className="traffic-note">
            FL511&rsquo;s detail view for this event could not be read, so only the values its map
            feed carries are shown.
          </p>
        )}
        {event.roadway == null && (
          <p className="traffic-note">
            FL511 publishes the road and direction inside its description text, not as separate
            values, so they are not listed as fields here.
          </p>
        )}
      </section>

      <section>
        <h3>Position</h3>
        <dl>
          <Row label="How it reached this study area" value={AREA_MATCH_LABELS[event.areaMatch] ?? event.areaMatch} />
          <Row
            label="Published geometry"
            value={event.geometry?.type === 'MultiPoint' ? 'Two points' : 'One point'}
            note={event.geometryBasis}
          />
        </dl>
        {event.geometry?.type === 'MultiPoint' && (
          <p className="traffic-warn">
            The dashed line on the map joins the two points FL511 published. It is not the
            alignment or the length of the affected road.
          </p>
        )}
      </section>

      <section>
        <h3>PortMiami roads</h3>
        {matched.length > 0 ? (
          <ul className="traffic-links">
            {matched.map(link => <Association key={link.roadObjectId} link={link} onViewRoad={onViewRoad} />)}
          </ul>
        ) : (
          <p className="traffic-note">
            No road in the PortMiami network is named by this event&rsquo;s own text, so none is
            matched to it. {candidates.length > 0 && 'The nearby segments below are candidates only.'}
          </p>
        )}
        {candidates.length > 0 && (
          <>
            <h3 className="traffic-subhead">Nearby candidates</h3>
            <p className="traffic-note">
              Within range, with nothing in the event naming them. Proximity alone does not say an
              event is on a road.
            </p>
            <ul className="traffic-links">
              {candidates.map(link => <Association key={link.roadObjectId} link={link} onViewRoad={onViewRoad} />)}
            </ul>
          </>
        )}
        {event.roadAssociationNote && <p className="traffic-note">{event.roadAssociationNote}</p>}
        {event.roadAssociationsTruncated > 0 && (
          <p className="traffic-note">
            {event.roadAssociationsTruncated} further segment(s) within range are not listed.
          </p>
        )}
      </section>

      {event.fl511Cameras?.length > 0 && (
        <section>
          <h3>Cameras FL511 lists for this event</h3>
          <ul className="traffic-plain-list">
            {event.fl511Cameras.map(camera => (
              <li key={camera.cameraId}>
                {camera.title ?? `FL511 camera ${camera.cameraId}`}
                {camera.description && <small>{camera.description}</small>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
