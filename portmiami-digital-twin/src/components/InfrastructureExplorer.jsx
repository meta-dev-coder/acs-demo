import { useDeferredValue, useMemo, useState } from 'react';
import { ASSET_GROUPS } from '../config/infrastructure.js';
import { categoryLabel, LINK_STATUS } from '../infrastructure/assetModel.js';

const STATUS_FILTERS = [
  { id: '', label: 'Any status' },
  { id: 'VERIFIED', label: 'Verified' },
  { id: 'PROVISIONAL', label: 'Provisional' },
  { id: 'UNVERIFIED', label: 'Unverified' },
];
const GAP_FILTERS = [
  { id: '', label: 'All' },
  { id: 'NO_BUILDING', label: 'No building link' },
  { id: 'NO_ROAD', label: 'No road link' },
  { id: 'NO_LOCATION', label: 'No location' },
];

const confirmedCount = links => links.filter(l => l.status === LINK_STATUS.CONFIRMED).length;

export function InfrastructureExplorer({ infra, onClose }) {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('ALL');
  const [status, setStatus] = useState('');
  const [gap, setGap] = useState('');
  const deferred = useDeferredValue(query);

  const rows = useMemo(() => {
    const term = deferred.trim().toLowerCase();
    return infra.assets
      .map(asset => ({ asset, links: infra.linksFor(asset.id) }))
      .filter(({ asset, links }) => {
        if (group !== 'ALL' && asset.group !== group) return false;
        if (status && asset.verificationStatus !== status) return false;
        if (gap === 'NO_BUILDING' && confirmedCount(links.buildingLinks) > 0) return false;
        if (gap === 'NO_ROAD' && confirmedCount(links.roadLinks) > 0) return false;
        if (gap === 'NO_LOCATION' && asset.point) return false;
        if (!term) return true;
        return asset.name.toLowerCase().includes(term)
          || String(asset.code ?? '').toLowerCase().includes(term)
          || (asset.operator ?? '').toLowerCase().includes(term);
      });
  }, [infra, deferred, group, status, gap]);

  const filtered = Boolean(deferred.trim()) || group !== 'ALL' || status || gap;

  return (
    <aside className="road-explorer infra-explorer" aria-label="Infrastructure Explorer">
      <header className="road-explorer-head">
        <h2>Infrastructure</h2>
        <button type="button" className="road-icon-btn" onClick={onClose} aria-label="Close Infrastructure">×</button>
      </header>

      <dl className="road-summary">
        <div><dt>Assets</dt><dd>{infra.summary.total}</dd></div>
        <div><dt>Verified</dt><dd>{infra.summary.byStatus.VERIFIED}</dd></div>
        <div><dt>Located</dt><dd>{infra.summary.geocoded}</dd></div>
        <div><dt>Candidates</dt><dd>{infra.summary.candidateLinks}</dd></div>
        <div><dt>Confirmed</dt><dd>{infra.summary.confirmedLinks}</dd></div>
      </dl>

      <div className="road-filters">
        <input
          type="search" className="road-search" value={query}
          placeholder="Search asset name, code or operator"
          aria-label="Search infrastructure assets"
          onChange={event => setQuery(event.target.value)}
        />
        <div className="road-group infra-group" role="group" aria-label="Asset group">
          {ASSET_GROUPS.map(g => (
            <button key={g.id} type="button" aria-pressed={group === g.id} onClick={() => setGroup(g.id)}>
              {g.label}
            </button>
          ))}
        </div>
        <div className="road-selects">
          <label>
            <span>Verification</span>
            <select value={status} onChange={event => setStatus(event.target.value)}>
              {STATUS_FILTERS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
          <label>
            <span>Gaps</span>
            <select value={gap} onChange={event => setGap(event.target.value)}>
              {GAP_FILTERS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
        </div>
      </div>

      <p className="road-count">
        {filtered
          ? `${rows.length} of ${infra.summary.total} assets`
          : `${infra.summary.total} assets`}
      </p>

      {rows.length === 0 ? <p className="road-empty">No asset matches these filters.</p> : (
        <ol className="infra-list">
          {rows.map(({ asset, links }) => (
            <li key={asset.id}>
              <button
                type="button"
                className="road-row"
                aria-current={asset.id === infra.selectedAssetId ? 'true' : undefined}
                onClick={() => infra.select(asset.id)}
              >
                <span className="road-row-name">{asset.name}</span>
                <span className="road-row-meta">
                  <span>{categoryLabel(asset.category)}</span>
                  <span className={`infra-badge is-${asset.verificationStatus.toLowerCase()}`}>
                    {asset.verificationStatus === 'VERIFIED' ? 'Verified' : asset.verificationStatus === 'PROVISIONAL' ? 'Provisional' : 'Unverified'}
                  </span>
                  {confirmedCount(links.buildingLinks) > 0 && <span className="road-row-tag">{confirmedCount(links.buildingLinks)} bldg</span>}
                  {confirmedCount(links.roadLinks) > 0 && <span className="road-row-tag">{confirmedCount(links.roadLinks)} road</span>}
                  {!asset.point && <span className="road-row-muted">no location</span>}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}

      <p className="road-source-note">
        Names and addresses are from official Miami-Dade PortMiami pages. No source publishes a
        coordinate, so a located asset is placed from its street address against the county road
        file — provisional, and never a confirmation on its own.
      </p>
    </aside>
  );
}
