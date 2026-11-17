/**
 * The Live Traffic workspace: one panel, six subtabs, in the same left-hand column and the same
 * furniture as the Road, Building and Infrastructure explorers.
 *
 * Subtabs rather than one long scroll, so the panel never becomes a dashboard an operator has to
 * scroll past three empty sections to reach the one they want.
 */
import { useState } from 'react';
import {
  EMPTY_IS_NOT_NORMAL, EVENT_LABELS, LINK_STATUS_LABELS, MATCH_METHOD_LABELS,
  SOURCE_STATUS, eventLabel, formatAge, formatMeters, sourceNote, statusNotice,
} from '../liveTraffic/liveTrafficModel.js';
import { SOURCE_ATTRIBUTION, TRAFFIC_ICONS } from '../config/liveTraffic.js';

const TABS = Object.freeze([
  { key: 'OVERVIEW', label: 'Overview' },
  { key: 'CAMERAS', label: 'Cameras' },
  { key: 'EVENTS', label: 'Incidents & closures' },
  { key: 'CONGESTION', label: 'Congestion' },
  { key: 'CONSTRUCTION', label: 'Construction' },
  { key: 'SIGNS', label: 'Message signs' },
]);

/** The icon as inline SVG, at the size a list row or a legend wants. */
export function TrafficGlyph({ iconKey, size = 16 }) {
  const icon = TRAFFIC_ICONS[iconKey];
  if (!icon) return null;
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false"
      fill={icon.color} dangerouslySetInnerHTML={{ __html: icon.glyph }}
    />
  );
}

/** A freshness chip. Says how old the DATA is, not how long ago this page asked. */
function SourceChip({ payload }) {
  const note = sourceNote(payload);
  const age = payload?.dataFreshness?.ageSeconds;
  return (
    <span className={`traffic-chip is-${note.tone}`}>
      {note.text}
      {Number.isFinite(age) && <small>{formatAge(age)} old</small>}
    </span>
  );
}

/** How a road association came about, as evidence a reader can weigh. */
function AssociationLine({ link }) {
  if (!link) return null;
  return (
    <span className="traffic-assoc">
      <strong className={`is-${link.status.toLowerCase()}`}>{LINK_STATUS_LABELS[link.status]}</strong>
      {' · '}
      {link.roadName ?? `Segment ${link.roadObjectId}`}
      {link.isPortAccess && <em> · port access</em>}
      {' · '}{formatMeters(link.distanceMeters)}
      <small>{MATCH_METHOD_LABELS[link.matchMethod] ?? link.matchMethod}</small>
    </span>
  );
}

function EventRow({ event, selected, onSelect }) {
  const link = (event.roadAssociations ?? [])[0];
  return (
    <li>
      <button type="button" aria-pressed={selected} onClick={() => onSelect(event.id)}>
        <span className="traffic-row-head">
          <TrafficGlyph iconKey={event.type} />
          <span className="traffic-row-title">{eventLabel(event)}</span>
        </span>
        <span className="traffic-row-meta">{EVENT_LABELS[event.type]} · FL511 {event.sourceEventId}</span>
        <AssociationLine link={link} />
      </button>
    </li>
  );
}

/** An empty list says what empty means here. It never implies that conditions are fine. */
function EmptyState({ what }) {
  return (
    <div className="traffic-empty">
      <p>No {what} reported in the PortMiami study area.</p>
      <p className="traffic-empty-note">{EMPTY_IS_NOT_NORMAL}</p>
    </div>
  );
}

function EventList({ events, types, what, selection, onSelect }) {
  const shown = events.filter(event => types.includes(event.type));
  if (shown.length === 0) return <EmptyState what={what} />;
  return (
    <ul className="traffic-list">
      {shown.map(event => (
        <EventRow
          key={event.id} event={event} onSelect={onSelect}
          selected={selection?.kind === 'traffic-event' && selection.id === event.id}
        />
      ))}
    </ul>
  );
}

function CameraList({ cameras, selection, onSelect }) {
  if (cameras.length === 0) {
    return (
      <div className="traffic-empty">
        <p>No FL511 cameras in the PortMiami study area.</p>
      </div>
    );
  }
  return (
    <ul className="traffic-list">
      {cameras.map(camera => (
        <li key={camera.id}>
          <button
            type="button" onClick={() => onSelect(camera.id)}
            aria-pressed={selection?.kind === 'traffic-camera' && selection.id === camera.id}
          >
            <span className="traffic-row-head">
              <TrafficGlyph iconKey="CAMERA" />
              {/* Null until the camera's own detail is read — never "Camera 409", which would
                  read as FL511's name for it. */}
              <span className="traffic-row-title">{camera.name ?? `FL511 camera ${camera.id}`}</span>
            </span>
            <span className="traffic-row-meta">
              {camera.name ? `FL511 ${camera.id}` : 'Name not published in the feed'}
              {camera.videoEnabled === false && ' · no video declared'}
            </span>
            <AssociationLine link={(camera.roadAssociations ?? [])[0]} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function SignList({ signs, details, selection, onSelect }) {
  if (signs.length === 0) {
    return (
      <div className="traffic-empty">
        <p>No FL511 message signs in the PortMiami study area.</p>
      </div>
    );
  }
  return (
    <ul className="traffic-list">
      {signs.map(sign => {
        const detail = details[sign.id];
        return (
          <li key={sign.id}>
            <button
              type="button" onClick={() => onSelect(sign.id)}
              aria-pressed={selection?.kind === 'traffic-sign' && selection.id === sign.id}
            >
              <span className="traffic-row-head">
                <TrafficGlyph iconKey="MESSAGE_SIGN" />
                <span className="traffic-row-title">{detail?.name ?? sign.name ?? `FL511 sign ${sign.id}`}</span>
              </span>
              <span className="traffic-row-meta">
                {/* A sign's message is only in its own fragment. Until it is read there is no
                    message to show, which is not the same as a blank sign. */}
                {detail?.message ? detail.message : 'Message not read yet — open the sign'}
              </span>
              <AssociationLine link={(sign.roadAssociations ?? [])[0]} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Overview({ traffic }) {
  const { summary, eventsPayload, camerasPayload, signsPayload } = traffic;
  const region = eventsPayload.region;
  const speeds = eventsPayload.trafficSpeeds;
  const counts = [
    ['Incidents', summary.incidents, 'INCIDENT'],
    ['Road closures', summary.closures, 'CLOSURE'],
    ['Congestion', summary.congestion, 'CONGESTION'],
    ['Construction', summary.construction, 'CONSTRUCTION'],
    ['Disabled vehicles', summary.disabledVehicles, 'DISABLED_VEHICLE'],
    ['Cameras', summary.cameras, 'CAMERA'],
    ['Message signs', summary.messageSigns, 'MESSAGE_SIGN'],
  ];
  return (
    <div className="traffic-overview">
      <dl className="traffic-counts">
        {counts.map(([label, value, iconKey]) => (
          <div key={label}>
            <dt><TrafficGlyph iconKey={iconKey} size={14} />{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <section>
        <h3>Feed status</h3>
        <ul className="traffic-status-list">
          <li><span>Events</span><SourceChip payload={eventsPayload} /></li>
          <li><span>Cameras</span><SourceChip payload={camerasPayload} /></li>
          <li><span>Message signs</span><SourceChip payload={signsPayload} /></li>
        </ul>
        {eventsPayload.dataFreshness && (
          <p className="traffic-note">
            The server polls FL511 every {eventsPayload.dataFreshness.refreshSeconds}s for events and
            every {camerasPayload.dataFreshness?.refreshSeconds ?? 300}s for cameras and signs, and
            serves one cached copy to every viewer. Each is labelled cached once it has missed about
            three of its own polls — {eventsPayload.dataFreshness.staleAfterSeconds}s for events,
            {' '}{camerasPayload.dataFreshness?.staleAfterSeconds ?? 900}s for cameras and signs.
          </p>
        )}
        {eventsPayload.unplaceable?.length > 0 && (
          <p className="traffic-warn">
            {eventsPayload.unplaceable.length} FL511 event(s) were published without a usable
            position. They are counted here and are not shown on the map.
          </p>
        )}
      </section>

      <section>
        <h3>Road association</h3>
        <dl className="traffic-kv">
          <div><dt>Events on a named road</dt><dd>{summary.eventsOnKnownRoads} of {summary.events}</dd></div>
          <div><dt>Events on a port access road</dt><dd>{summary.eventsOnPortAccessRoads}</dd></div>
          <div><dt>Road segments searched</dt><dd>{(eventsPayload.roadNetwork?.segmentCount ?? 0).toLocaleString('en-US')}</dd></div>
          <div><dt>Search radius</dt><dd>{eventsPayload.roadNetwork?.searchRadiusMeters ?? '—'} m</dd></div>
        </dl>
        <p className="traffic-note">
          An event is <strong>Matched</strong> to a road only when the event&rsquo;s own text names
          that road and it lies within the radius. The nearest centreline alone is a{' '}
          <strong>Candidate</strong> — never a match.
        </p>
      </section>

      <section>
        <h3>Traffic speeds</h3>
        <p className={speeds?.available ? 'traffic-note' : 'traffic-warn'}>
          {speeds?.available ? 'A speed feed is available.' : 'Not available.'}
        </p>
        {speeds?.reason && <p className="traffic-note">{speeds.reason}</p>}
      </section>

      <section>
        <h3>Study area</h3>
        {region && (
          <>
            <p className="traffic-note">
              {region.bbox.west}, {region.bbox.south} to {region.bbox.east}, {region.bbox.north}
            </p>
            <p className="traffic-warn">{region.boundaryNote}</p>
          </>
        )}
      </section>

      <section>
        <h3>Source</h3>
        <p className="traffic-note">
          <a href={SOURCE_ATTRIBUTION.url} target="_blank" rel="noopener noreferrer">
            {SOURCE_ATTRIBUTION.name}
          </a>{' · '}{SOURCE_ATTRIBUTION.operator}
        </p>
        <p className="traffic-note">{SOURCE_ATTRIBUTION.note}</p>
      </section>
    </div>
  );
}

export function LiveTrafficWorkspace({ traffic, selection, onSelectEvent, onSelectCamera, onSelectSign, onClose }) {
  const [tab, setTab] = useState('OVERVIEW');
  const notice = statusNotice(traffic.eventsPayload);
  const loading = traffic.eventsPayload.sourceStatus === SOURCE_STATUS.LOADING;

  return (
    <aside className="road-explorer traffic-workspace" aria-label="Live Traffic">
      <header className="road-explorer-head">
        <h2>Live Traffic</h2>
        <button type="button" className="road-icon-btn" onClick={onClose} aria-label="Close Live Traffic">×</button>
      </header>

      <div className="traffic-tabs" role="tablist" aria-label="Live Traffic sections">
        {TABS.map(({ key, label }) => (
          <button
            key={key} type="button" role="tab" aria-selected={tab === key}
            onClick={() => setTab(key)}
          >{label}</button>
        ))}
      </div>

      {notice && <p className="traffic-warn is-banner" role="status">{notice}</p>}

      <div className="traffic-body">
        {loading && <p className="traffic-note">Reading FL511…</p>}
        {!loading && tab === 'OVERVIEW' && <Overview traffic={traffic} />}
        {!loading && tab === 'CAMERAS' && (
          <CameraList cameras={traffic.cameras} selection={selection} onSelect={onSelectCamera} />
        )}
        {!loading && tab === 'EVENTS' && (
          <EventList
            events={traffic.events} types={['INCIDENT', 'CLOSURE', 'DISABLED_VEHICLE']}
            what="incidents, closures or disabled vehicles" selection={selection} onSelect={onSelectEvent}
          />
        )}
        {!loading && tab === 'CONGESTION' && (
          <EventList events={traffic.events} types={['CONGESTION']} what="congestion" selection={selection} onSelect={onSelectEvent} />
        )}
        {!loading && tab === 'CONSTRUCTION' && (
          <EventList events={traffic.events} types={['CONSTRUCTION']} what="construction" selection={selection} onSelect={onSelectEvent} />
        )}
        {!loading && tab === 'SIGNS' && (
          <SignList signs={traffic.signs} details={traffic.signDetails} selection={selection} onSelect={onSelectSign} />
        )}
      </div>
    </aside>
  );
}
