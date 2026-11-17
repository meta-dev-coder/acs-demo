import { displayName, roadClassLabel, LENGTH_UNIT } from '../roads/roadModel.js';
import { RoadLiveEvents } from './RoadLiveEvents.jsx';

/** A labelled value. `null` is rendered as a stated absence, never as 0 or a blank. */
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

const coordinate = ([lon, lat]) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

/**
 * Impedance, shown as the number the file carries and nothing more.
 *
 * It is NOT presented as travel time or as a directional access rule. Two things in the data say
 * that would be a guess: the value tracks `Shape.STLength()` almost exactly (median ratio 0.9999
 * over 2,355 segments), and 806 segments differ between the two directions. The source ships no
 * schema for the field, so the number is shown and its meaning is not claimed.
 */
function Impedance({ value }) {
  if (value === null || value === undefined) return 'Not available';
  if (value === -1) return <>-1 <small>sentinel value; its meaning is not documented in this file</small></>;
  return value.toLocaleString('en-US');
}

export function RoadDetailsPanel({ road, traffic, onStreetView, onViewOnMap, onOpenEvent, onClear }) {
  const p = road.properties;
  /**
   * An address range, or nothing. `0 to 0` is the source's "no range assigned" sentinel — 705 of
   * the 2,362 segments carry it, and every real range in the file starts at 1 — so showing it as
   * an address range would be showing missing data as a number.
   */
  const addressRange = (from, to) => {
    if (from == null && to == null) return null;
    if ((from ?? 0) === 0 && (to ?? 0) === 0) return null;
    return `${from ?? '—'} to ${to ?? '—'}`;
  };

  return (
    <aside className="road-details" aria-label="Road details">
      <header className="road-details-head">
        <div>
          <h2>{displayName(road)}</h2>
          <p>Segment {road.objectId}{road.isTunnel && ' · Underground tunnel centreline'}</p>
        </div>
        <button type="button" className="road-icon-btn" onClick={onClear} aria-label="Clear selection">×</button>
      </header>

      <div className="road-details-actions">
        <button type="button" className="road-btn is-primary" onClick={onViewOnMap}>View on map</button>
        {/* The midpoint of this segment, which is where the panorama is looked up. A tunnel
            centreline has no street-level imagery to find, so it is not offered one. */}
        {onStreetView && !road.isTunnel && (
          <button type="button" className="road-btn" onClick={onStreetView}>Street View</button>
        )}
        <button type="button" className="road-btn" onClick={onClear}>Clear selection</button>
      </div>
      {onStreetView && road.isTunnel && (
        <p className="road-note">
          Street View is not offered for a tunnel centreline: the geometry is underground, so a
          panorama looked up at it would be of the surface street above, not of this road.
        </p>
      )}

      <section>
        <h3>Road identity</h3>
        <dl>
          <Row label="Name" value={road.name || null} note={road.name ? null : 'The source has no name for this segment'} />
          <Row label="Segment ID" value={road.objectId} />
          <Row label="GlobalID" value={road.globalId || null} />
          <Row label="Class" value={roadClassLabel(road.classCode)} />
          <Row
            label="Classification"
            value={road.isPortAccess ? 'Port access road' : 'Surrounding network'}
            note={road.classificationReason}
          />
        </dl>
      </section>

      <section>
        <h3>Location</h3>
        <dl>
          <Row label="Municipality" value={road.municipality || null} />
          <Row label="Segment midpoint" value={coordinate(road.midpoint)} note="latitude, longitude" />
          <Row label="Geometry" value={`LineString · ${road.coordinates.length} vertices`} />
        </dl>
      </section>

      <section>
        <h3>Network attributes</h3>
        <dl>
          <Row
            label="Source length"
            value={road.lengthFeet == null ? null : `${Math.round(road.lengthFeet).toLocaleString('en-US')} ${LENGTH_UNIT}`}
            note="Shape.STLength(); unit inferred from the data — see note below"
          />
          <Row label="From-to impedance" value={<Impedance value={p.FROM_TO_IMP} />} />
          <Row label="To-from impedance" value={<Impedance value={p.TO_FROM_IMP} />} />
          <Row
            label="Left address range"
            value={addressRange(p.L_ADD_FROM, p.L_ADD_TO)}
            note={addressRange(p.L_ADD_FROM, p.L_ADD_TO) ? null : 'No range assigned in the source'}
          />
          <Row
            label="Right address range"
            value={addressRange(p.R_ADD_FROM, p.R_ADD_TO)}
            note={addressRange(p.R_ADD_FROM, p.R_ADD_TO) ? null : 'No range assigned in the source'}
          />
        </dl>
        <p className="road-note">
          Impedance is shown as the source records it. Its units and direction semantics are not
          documented in this file, so it is not presented as travel time or as an access rule.
        </p>
      </section>

      <RoadLiveEvents road={road} traffic={traffic} onOpenEvent={onOpenEvent} />

      <section>
        <h3>Operational information</h3>
        <dl>
          <Row label="Lane count" value={null} note="Not in the source dataset" />
          <Row label="Speed limit" value={null} note="Not in the source dataset" />
          <Row
            label="Measured traffic speed"
            value={null}
            note="No speed feed is available from FL511 — see Live Traffic › Overview"
          />
          <Row
            label="PortMiami construction schedule"
            value={null}
            note="Not connected. FL511 construction events are externally reported traffic events and are listed above, not port project records"
          />
        </dl>
      </section>
    </aside>
  );
}
