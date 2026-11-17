/**
 * The compact "Live FL511 Events" section inside the Road details panel.
 *
 * Two lists, kept apart on purpose:
 *   - events whose own text NAMES this road (matched), and
 *   - events that are merely within range of it (candidates).
 *
 * Merging them would tell a reader that a closure 140 m away on a different street is happening on
 * the road they have open. The candidate list is collapsed, labelled, and counted so it is
 * available without being asserted.
 *
 * And when there is nothing: an empty section says no events are ASSOCIATED, never that the road
 * is clear. FL511 reports what has been reported to it, and this twin measures no traffic of its
 * own, so "no events" and "flowing normally" are not the same statement.
 */
import {
  EVENT_LABELS, MATCH_METHOD_LABELS, NO_EVENTS_FOR_ROAD, SOURCE_STATUS,
  eventLabel, eventsForRoad, formatMeters, sourceNote,
} from '../liveTraffic/liveTrafficModel.js';
import { TrafficGlyph } from './LiveTrafficWorkspace.jsx';

function EventLine({ event, link, onOpenEvent }) {
  return (
    <li>
      <button type="button" className="traffic-inline-event" onClick={() => onOpenEvent?.(event.id)}>
        <span className="traffic-row-head">
          <TrafficGlyph iconKey={event.type} size={14} />
          <span className="traffic-row-title">{eventLabel(event)}</span>
        </span>
        <span className="traffic-row-meta">
          {EVENT_LABELS[event.type]} · {formatMeters(link.distanceMeters)} · FL511 {event.sourceEventId}
        </span>
        <small className="traffic-link-why">{MATCH_METHOD_LABELS[link.matchMethod] ?? link.matchMethod}</small>
      </button>
    </li>
  );
}

export function RoadLiveEvents({ road, traffic, onOpenEvent }) {
  if (!traffic) return null;
  const { eventsPayload } = traffic;
  const status = String(eventsPayload?.sourceStatus ?? '').toUpperCase();
  const note = sourceNote(eventsPayload);
  const { matched, candidates } = eventsForRoad(traffic.events, road.objectId);

  return (
    <section className="traffic-road-section">
      <h3>
        Live FL511 events
        <span className={`traffic-chip is-${note.tone}`}>{note.text}</span>
      </h3>

      {status === SOURCE_STATUS.LOADING && <p className="traffic-note">Reading FL511…</p>}

      {status !== SOURCE_STATUS.LOADING && status !== SOURCE_STATUS.LIVE && status !== SOURCE_STATUS.STALE && (
        <p className="traffic-warn">
          FL511 data is not available, so whether any event affects this road is unknown.
        </p>
      )}

      {(status === SOURCE_STATUS.LIVE || status === SOURCE_STATUS.STALE) && (
        <>
          {matched.length > 0 ? (
            <ul className="traffic-inline-list">
              {matched.map(({ event, link }) => (
                <EventLine key={event.id} event={event} link={link} onOpenEvent={onOpenEvent} />
              ))}
            </ul>
          ) : (
            <p className="traffic-note">{NO_EVENTS_FOR_ROAD}</p>
          )}

          {candidates.length > 0 && (
            <details className="traffic-candidates">
              <summary>
                {candidates.length} nearby event{candidates.length === 1 ? '' : 's'} not matched to this road
              </summary>
              <p className="traffic-note">
                Within range of this segment, with nothing in the event naming it. Being nearby is
                not evidence that an event is on this road.
              </p>
              <ul className="traffic-inline-list">
                {candidates.map(({ event, link }) => (
                  <EventLine key={event.id} event={event} link={link} onOpenEvent={onOpenEvent} />
                ))}
              </ul>
            </details>
          )}

          <p className="traffic-note">
            Nothing here marks this segment closed or congested. FL511 publishes point markers and
            prose, which cannot establish the operational state of a centreline.
          </p>
        </>
      )}
    </section>
  );
}
