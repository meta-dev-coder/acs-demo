import { useState } from 'react';
import { displayName } from '../roads/roadModel.js';
import { buildingLabel } from '../buildings/buildingModel.js';
import { categoryLabel, sourceById } from '../infrastructure/assetModel.js';
import { ASSET_SOURCES, OPERATIONAL_STATUS_LABELS } from '../config/infrastructure.js';
import { FOOTPRINT_COVERAGE } from '../config/buildings.js';
import { AssetFacilityTab, hasFacilityDetail } from './AssetFacilityTab.jsx';
import {
  BUILDING_RELATIONSHIPS, LINK_STATUS, MATCH_METHOD_LABELS, ROAD_RELATIONSHIPS,
} from '../infrastructure/assetLinks.js';
import {
  EVENT_LABELS, MATCH_METHOD_LABELS as TRAFFIC_MATCH_LABELS, SOURCE_STATUS as TRAFFIC_STATUS,
  eventLabel, eventsForRoads, formatMeters, sourceNote,
} from '../liveTraffic/liveTrafficModel.js';
import { TrafficGlyph } from './LiveTrafficWorkspace.jsx';

const TABS = [
  { id: 'OVERVIEW', label: 'Overview' },
  { id: 'BUILDINGS', label: 'Buildings' },
  { id: 'FACILITY', label: 'Facility' },
  { id: 'ROADS', label: 'Road access' },
  { id: 'EVIDENCE', label: 'Evidence' },
];

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

const statusChip = status => (
  <span className={`infra-chip is-${String(status).toLowerCase()}`}>
    {status === LINK_STATUS.CONFIRMED ? 'Confirmed'
      : status === LINK_STATUS.CANDIDATE ? 'Candidate'
      : status === LINK_STATUS.REJECTED ? 'Rejected'
      : 'Needs review'}
  </span>
);

/**
 * Live FL511 events on this asset's CONFIRMED access roads.
 *
 * Confirmed only. A proposed or candidate link is a suggestion a reviewer has not accepted, and
 * chaining one guess (this road serves this garage) to another (this event is on that road) would
 * produce a confident sentence out of two unconfirmed ones.
 *
 * And the sentence it does produce stops short of impact. It says an event is reported on a road
 * confirmed to serve this asset. It does NOT say access is disrupted: FL511 publishes a point and
 * a line of prose, which cannot establish whether a terminal's entrance is reachable. The
 * difference is spelled out below rather than left for the reader to assume.
 */
function AssetLiveEvents({ asset, links, roadsById, traffic, onOpenEvent }) {
  if (!traffic) return null;
  const confirmed = links.roadLinks.filter(link => link.status === LINK_STATUS.CONFIRMED);
  const status = String(traffic.eventsPayload?.sourceStatus ?? '').toUpperCase();
  const note = sourceNote(traffic.eventsPayload);
  const matches = eventsForRoads(traffic.events, confirmed.map(link => link.roadObjectId));

  return (
    <div className="traffic-asset-events">
      <h3>
        Live FL511 events on confirmed access roads
        <span className={`traffic-chip is-${note.tone}`}>{note.text}</span>
      </h3>

      {confirmed.length === 0 ? (
        <p className="road-empty">
          No access road is confirmed for this asset yet, so there is no road to report events for.
          Confirm a road below first.
        </p>
      ) : status === TRAFFIC_STATUS.LOADING ? (
        <p className="traffic-note">Reading FL511…</p>
      ) : status !== TRAFFIC_STATUS.LIVE && status !== TRAFFIC_STATUS.STALE ? (
        <p className="traffic-warn">
          FL511 data is not available, so whether any event affects these roads is unknown.
        </p>
      ) : matches.length === 0 ? (
        <p className="traffic-note">
          No FL511 events currently associated with this asset&rsquo;s {confirmed.length} confirmed
          access road{confirmed.length === 1 ? '' : 's'}. That is not a statement that access is
          clear — FL511 shows only what has been reported to it.
        </p>
      ) : (
        <>
          <ul className="traffic-inline-list">
            {matches.map(({ event, link }) => {
              const segment = roadsById.get(link.roadObjectId);
              return (
                <li key={event.id}>
                  <button type="button" className="traffic-inline-event" onClick={() => onOpenEvent?.(event.id)}>
                    <span className="traffic-row-head">
                      <TrafficGlyph iconKey={event.type} size={14} />
                      <span className="traffic-row-title">{eventLabel(event)}</span>
                    </span>
                    <span className="traffic-row-meta">
                      {EVENT_LABELS[event.type]} · on {segment ? displayName(segment) : `OBJECTID ${link.roadObjectId}`}
                      {' · '}{formatMeters(link.distanceMeters)}
                    </span>
                    <small className="traffic-link-why">
                      {TRAFFIC_MATCH_LABELS[link.matchMethod] ?? link.matchMethod}
                    </small>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="traffic-warn">
            These events are reported on roads confirmed to serve {asset.name}. Whether access to
            the facility is actually affected is not something this data can establish — it would
            need the closure&rsquo;s own extent and the facility&rsquo;s driveway connections,
            neither of which is in any source wired to this twin.
          </p>
        </>
      )}
    </div>
  );
}

export function AssetDetailsPanel({ asset, infra, roadsById, buildingsById, traffic, onOpenEvent, onViewOnMap, onViewRoad, onViewBuilding, onClear }) {
  const [tab, setTab] = useState('OVERVIEW');
  const links = infra.linksFor(asset.id);
  const canFly = Boolean(asset.point)
    || links.buildingLinks.some(l => l.status === LINK_STATUS.CONFIRMED);

  const linkedBuildingIds = new Set(links.buildingLinks.map(l => l.buildingObjectId));
  const linkedRoadIds = new Set(links.roadLinks.map(l => l.roadObjectId));

  return (
    <aside className="road-details infra-details" aria-label="Infrastructure asset details">
      <header className="road-details-head">
        <div>
          <h2>{asset.name}</h2>
          <p>{categoryLabel(asset.category)}{asset.code ? ` · ${asset.code}` : ''}</p>
        </div>
        <button type="button" className="road-icon-btn" onClick={onClear} aria-label="Clear selection">×</button>
      </header>

      <div className="road-details-actions">
        <button type="button" className="road-btn is-primary" onClick={onViewOnMap} disabled={!canFly}>
          View on map
        </button>
        <button type="button" className="road-btn" onClick={onClear}>Clear selection</button>
      </div>
      {!canFly && (
        <p className="road-note infra-nolocation">
          No source publishes a location for this asset and no footprint is confirmed, so the map
          has nowhere truthful to fly. Confirm a building below and it becomes available.
        </p>
      )}

      <nav className="infra-tabs" role="tablist" aria-label="Asset detail sections">
        {TABS.filter(t => t.id !== 'FACILITY' || hasFacilityDetail(asset)).map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'BUILDINGS' && links.buildingLinks.length > 0 && <em>{links.buildingLinks.length}</em>}
            {t.id === 'ROADS' && links.roadLinks.length > 0 && <em>{links.roadLinks.length}</em>}
          </button>
        ))}
      </nav>

      {tab === 'OVERVIEW' && (
        <section>
          <dl>
            <Row label="Name" value={asset.name} />
            <Row label="Category" value={categoryLabel(asset.category)} />
            <Row label="Code" value={asset.code} />
            <Row label="Operator" value={asset.operator} />
            <Row label="Description" value={asset.description} />
            <Row
              label="Verification"
              value={asset.verificationStatus}
              note={asset.verificationStatus === 'VERIFIED'
                ? 'Name and attributes read from an official Miami-Dade source'
                : 'Backed only by a secondary source'}
            />
            {/* Separate from Verification on purpose. Terminal G is a VERIFIED asset that is also
                a building site; one field cannot carry both answers. */}
            {asset.operationalStatus && (
              <Row
                label="Operational status"
                value={OPERATIONAL_STATUS_LABELS[asset.operationalStatus.state] ?? asset.operationalStatus.state}
                note={asset.operationalStatus.basis}
              />
            )}
            <Row
              label="Address"
              // `addressText` is the source's own wording where it differs from the geocodable
              // form — Terminal C's "1741/1751 N Cruise Blvd", for instance.
              value={asset.attributes.addressText ?? (asset.attributes.address
                ? `${asset.attributes.address.house} ${asset.attributes.address.street}`
                : null)}
              note={asset.attributes.addressRange ?? (asset.attributes.address ? 'As published by the source' : 'The source publishes no address')}
            />
            <Row
              label="Location"
              value={asset.point ? `${asset.point[1].toFixed(5)}, ${asset.point[0].toFixed(5)}` : null}
              note={asset.point
                ? `${asset.location.status} — ${asset.location.basis}`
                : 'No source publishes a coordinate, and the address did not geocode'}
            />
            {/* The marker does not stand on the Location coordinate when the address fronts onto a
                footprint, so the panel says where it does stand and on what evidence. Without this
                row the two would silently disagree. */}
            {asset.frontage && (
              <Row
                label="Map marker"
                value={`${asset.frontage.point[1].toFixed(5)}, ${asset.frontage.point[0].toFixed(5)}`}
                note={asset.frontage.reason}
              />
            )}
          </dl>
          {asset.geocode && !asset.geocode.matched && asset.attributes.address && (
            <p className="road-note">Geocoding note: {asset.geocode.reason}</p>
          )}
          {/* The sources, on the first tab rather than only under Evidence: a name and an address
              are only worth as much as what published them. */}
          <h3 className="infra-sub">Sources</h3>
          <ul className="infra-source-list">
            {(asset.sources ?? []).map(id => {
              const source = ASSET_SOURCES[id];
              if (!source) return null;
              return (
                <li key={id}>
                  <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>
                  <small>
                    {source.publisher} · {source.authority === 'OFFICIAL' ? 'official' : 'secondary'}
                    {source.revised ? ` · revised ${source.revised}` : ''} · retrieved {source.retrieved}
                  </small>
                  {asset.supports?.[id] && <small className="infra-source-supports">{asset.supports[id]}</small>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {tab === 'BUILDINGS' && (
        <section>
          <div className="infra-section-head">
            <h3>Linked footprints</h3>
            <button
              type="button"
              className={`road-btn infra-linkbtn${infra.linkMode ? ' is-active' : ''}`}
              aria-pressed={infra.linkMode}
              onClick={() => infra.setLinkMode(!infra.linkMode)}
            >
              {infra.linkMode ? 'Cancel' : 'Link building'}
            </button>
          </div>
          {infra.linkMode && (
            <p className="road-note infra-hint">
              Click a footprint outline on the map to link it. The Buildings layer must be on.
            </p>
          )}

          {links.buildingLinks.length === 0 && <p className="road-empty">No footprint linked yet.</p>}
          <ul className="infra-links">
            {links.buildingLinks.map(link => {
              const building = buildingsById.get(link.buildingObjectId);
              return (
                <li key={link.id}>
                  <div className="infra-link-head">
                    <strong>{building ? buildingLabel(building) : `OBJECTID ${link.buildingObjectId}`}</strong>
                    {statusChip(link.status)}
                  </div>
                  <p className="infra-link-meta">
                    OBJECTID {link.buildingObjectId} · {BUILDING_RELATIONSHIPS[link.relationship] ?? link.relationship}
                    {' · '}{MATCH_METHOD_LABELS[link.matchMethod] ?? link.matchMethod}
                  </p>
                  {link.evidence && <p className="infra-link-evidence">{link.evidence}</p>}
                  <div className="infra-link-actions">
                    <button type="button" onClick={() => onViewBuilding(link.buildingObjectId)} disabled={!building}>View on map</button>
                    {link.status !== LINK_STATUS.CONFIRMED && <button type="button" onClick={() => infra.confirmLink(link, 'building')}>Confirm</button>}
                    {link.status !== LINK_STATUS.REJECTED && <button type="button" onClick={() => infra.rejectLink(link, 'building')}>Reject</button>}
                    <button type="button" onClick={() => infra.unlink(link, 'building')}>Unlink</button>
                  </div>
                </li>
              );
            })}
          </ul>

          <h3 className="infra-sub">Nearby footprints</h3>
          {/* Stated before the candidate list, because the list cannot show what is missing from
              it. Terminal AA opened in 2025 and Terminal G broke ground in 2025; neither can be
              in a file whose newest feature is from 2023. */}
          <p className="road-note">{FOOTPRINT_COVERAGE.note}</p>
          {asset.candidates.buildings.length === 0 ? (
            <p className="road-empty">
              {asset.point ? 'No footprint within 250 m of the derived point.' : 'No location, so nothing can be suggested.'}
            </p>
          ) : (
            <ul className="infra-candidates">
              {asset.candidates.buildings
                .filter(candidate => !linkedBuildingIds.has(candidate.objectId))
                .map(candidate => {
                  const footprint = buildingsById.get(candidate.objectId);
                  /* A terminal can span several footprints, so the first confirmed one is the
                     primary and anything linked afterwards is a secondary, not a replacement. */
                  const relationship = links.buildingLinks.some(l => l.relationship === 'PRIMARY_FOOTPRINT')
                    ? 'SECONDARY_FOOTPRINT' : 'PRIMARY_FOOTPRINT';
                  return (
                    <li key={candidate.objectId}>
                      <span>
                        OBJECTID {candidate.objectId}
                        {/* Size and part count, because distance alone cannot tell a 26 m shed
                            from a 14-part aggregate spanning half the island — and that aggregate
                            is the NEAREST candidate to three different terminals in this data. */}
                        {footprint && (
                          <small className="infra-cand-shape">
                            {Math.round(footprint.groundAreaM2).toLocaleString('en-US')} m²
                            {footprint.partCount > 1 && ` · ${footprint.partCount} parts`}
                          </small>
                        )}
                      </span>
                      <span className="infra-dist">
                        {candidate.contains ? 'contains the point' : `${Math.round(candidate.distanceM)} m`}
                      </span>
                      <button type="button" onClick={() => onViewBuilding(candidate.objectId)}>View</button>
                      <button
                        type="button"
                        onClick={() => infra.linkBuilding(asset.id, candidate.objectId, relationship)}
                      >Link</button>
                    </li>
                  );
                })}
            </ul>
          )}
          <p className="road-note">
            Proximity to an address-derived street point is a reason to look, not a relationship.
            Nothing here is linked until you link it.
          </p>
        </section>
      )}

      {tab === 'FACILITY' && hasFacilityDetail(asset) && <AssetFacilityTab asset={asset} />}

      {tab === 'ROADS' && (
        <section>
          <AssetLiveEvents asset={asset} links={links} roadsById={roadsById} traffic={traffic} onOpenEvent={onOpenEvent} />

          <h3>Access roads</h3>
          {links.roadLinks.length === 0 && <p className="road-empty">No road link yet.</p>}
          <ul className="infra-links">
            {links.roadLinks.map(link => {
              const segment = roadsById.get(link.roadObjectId);
              return (
                <li key={link.id}>
                  <div className="infra-link-head">
                    <strong>{segment ? displayName(segment) : `OBJECTID ${link.roadObjectId}`}</strong>
                    {statusChip(link.status)}
                  </div>
                  <p className="infra-link-meta">
                    OBJECTID {link.roadObjectId} · {ROAD_RELATIONSHIPS[link.relationship] ?? link.relationship}
                    {' · '}{MATCH_METHOD_LABELS[link.matchMethod] ?? link.matchMethod}
                    {segment?.isPortAccess && ' · port access road'}
                  </p>
                  {link.evidence && <p className="infra-link-evidence">{link.evidence}</p>}
                  <div className="infra-link-actions">
                    <button type="button" onClick={() => onViewRoad(link.roadObjectId)} disabled={!segment}>View on map</button>
                    {link.status !== LINK_STATUS.CONFIRMED && <button type="button" onClick={() => infra.confirmLink(link, 'road')}>Confirm</button>}
                    {link.status !== LINK_STATUS.REJECTED && <button type="button" onClick={() => infra.rejectLink(link, 'road')}>Reject</button>}
                  </div>
                </li>
              );
            })}
          </ul>

          <h3 className="infra-sub">Nearby roads</h3>
          {asset.candidates.roads.length === 0 ? (
            <p className="road-empty">
              {asset.point ? 'No road within 200 m of the derived point.' : 'No location, so nothing can be suggested.'}
            </p>
          ) : (
            <ul className="infra-candidates">
              {asset.candidates.roads
                .filter(candidate => !linkedRoadIds.has(candidate.objectId))
                .map(candidate => (
                  <li key={candidate.objectId}>
                    <span>{displayName(candidate.segment)}</span>
                    <span className="infra-dist">{Math.round(candidate.distanceM)} m</span>
                    <button type="button" onClick={() => onViewRoad(candidate.objectId)}>View</button>
                    <button
                      type="button"
                      onClick={() => infra.linkRoad(asset.id, candidate.objectId, 'NEARBY_ROAD',
                        `Within ${Math.round(candidate.distanceM)} m of the address-derived point; confirmed by a reviewer.`)}
                    >Link</button>
                  </li>
                ))}
            </ul>
          )}
          <p className="road-note">
            A road classified as <strong>port access</strong> serves the port. That is not the same
            as serving <em>this</em> asset, and neither is being nearby. Only a confirmed link here
            says a road provides access to this facility.
          </p>
        </section>
      )}

      {tab === 'EVIDENCE' && (
        <section>
          <h3>Sources</h3>
          <ul className="infra-sources">
            {asset.sources.map(id => {
              const source = sourceById(id);
              if (!source) return null;
              return (
                <li key={id}>
                  <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>
                  <span className="infra-link-meta">
                    {source.publisher} · {source.authority === 'OFFICIAL' ? 'official' : 'secondary'} · retrieved {source.retrieved}
                  </span>
                  <p className="infra-link-evidence">Supports: {asset.supports?.[id] ?? 'Not stated.'}</p>
                </li>
              );
            })}
          </ul>

          <h3 className="infra-sub">Review history</h3>
          {infra.store.history.filter(entry => entry.assetId === asset.id).length === 0
            ? <p className="road-empty">No review recorded for this asset.</p>
            : (
              <ol className="infra-history">
                {infra.store.history.filter(entry => entry.assetId === asset.id).slice().reverse().map(entry => (
                  <li key={entry.id}>
                    <span>{new Date(entry.at).toLocaleString('en-US')}</span>
                    {entry.kind} OBJECTID {entry.objectId}: {entry.from} → {entry.to}
                  </li>
                ))}
              </ol>
            )}
        </section>
      )}
    </aside>
  );
}
