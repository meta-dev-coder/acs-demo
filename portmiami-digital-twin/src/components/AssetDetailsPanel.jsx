import { useState } from 'react';
import { displayName } from '../roads/roadModel.js';
import { buildingLabel } from '../buildings/buildingModel.js';
import { categoryLabel, sourceById } from '../infrastructure/assetModel.js';
import {
  BUILDING_RELATIONSHIPS, LINK_STATUS, MATCH_METHOD_LABELS, ROAD_RELATIONSHIPS,
} from '../infrastructure/assetLinks.js';

const TABS = [
  { id: 'OVERVIEW', label: 'Overview' },
  { id: 'BUILDINGS', label: 'Buildings' },
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

export function AssetDetailsPanel({ asset, infra, roadsById, buildingsById, onViewOnMap, onViewRoad, onViewBuilding, onClear }) {
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
        {TABS.map(t => (
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
            <Row
              label="Address"
              value={asset.attributes.address
                ? `${asset.attributes.address.house} ${asset.attributes.address.street}`
                : null}
              note={asset.attributes.addressRange ?? (asset.attributes.address ? 'As published by the source' : 'The source publishes no address')}
            />
            <Row
              label="Location"
              value={asset.point ? `${asset.point[1].toFixed(5)}, ${asset.point[0].toFixed(5)}` : null}
              note={asset.point
                ? `${asset.location.status} — ${asset.location.basis}`
                : 'No source publishes a coordinate, and the address did not geocode'}
            />
          </dl>
          {asset.geocode && !asset.geocode.matched && asset.attributes.address && (
            <p className="road-note">Geocoding note: {asset.geocode.reason}</p>
          )}
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
          {asset.candidates.buildings.length === 0 ? (
            <p className="road-empty">
              {asset.point ? 'No footprint within 250 m of the derived point.' : 'No location, so nothing can be suggested.'}
            </p>
          ) : (
            <ul className="infra-candidates">
              {asset.candidates.buildings
                .filter(candidate => !linkedBuildingIds.has(candidate.objectId))
                .map(candidate => (
                  <li key={candidate.objectId}>
                    <span>OBJECTID {candidate.objectId}</span>
                    <span className="infra-dist">{candidate.contains ? 'contains the point' : `${Math.round(candidate.distanceM)} m`}</span>
                    <button type="button" onClick={() => onViewBuilding(candidate.objectId)}>View</button>
                    <button type="button" onClick={() => infra.linkBuilding(asset.id, candidate.objectId)}>Link</button>
                  </li>
                ))}
            </ul>
          )}
          <p className="road-note">
            Proximity to an address-derived street point is a reason to look, not a relationship.
            Nothing here is linked until you link it.
          </p>
        </section>
      )}

      {tab === 'ROADS' && (
        <section>
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
