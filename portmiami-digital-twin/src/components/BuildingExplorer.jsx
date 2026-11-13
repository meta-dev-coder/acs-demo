import { useDeferredValue, useMemo, useState } from 'react';
import { buildingTypeLabel } from '../buildings/buildingModel.js';
import { BUILDING_SOURCE } from '../config/buildings.js';
import { filterBuildings, HEIGHT_FILTER, HEIGHT_LABELS, isFiltered, sortBuildings } from '../buildings/buildingFilters.js';
import { BuildingList } from './BuildingList.jsx';

function Summary({ summary, years }) {
  const rows = [
    ['Loaded', summary.total],
    ['With height', summary.withHeight],
    ['No height', summary.withoutHeight],
    ['Multi-part', summary.multiPart],
  ];
  return (
    <>
      <dl className="road-summary">
        {rows.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd>{value.toLocaleString('en-US')}</dd></div>
        ))}
      </dl>
      <p className="road-count road-years">
        Source update year:{' '}
        {years.map(({ value, count }, index) => (
          <span key={value || 'none'}>
            {index > 0 && ' · '}
            {value || 'none'} <strong>{count.toLocaleString('en-US')}</strong>
          </span>
        ))}
      </p>
    </>
  );
}

export function BuildingExplorer({ network, onClose }) {
  const [query, setQuery] = useState('');
  const [year, setYear] = useState('');
  const [type, setType] = useState('');
  const [height, setHeight] = useState(HEIGHT_FILTER.ANY);

  const deferredQuery = useDeferredValue(query);
  const filters = { query: deferredQuery, year, type, height };
  const buildings = useMemo(
    () => sortBuildings(filterBuildings(network.buildings, filters), deferredQuery),
    [network.buildings, deferredQuery, year, type, height]);

  return (
    <aside className="road-explorer" aria-label="Building Explorer">
      <header className="road-explorer-head">
        <h2>Buildings</h2>
        <button type="button" className="road-icon-btn" onClick={onClose} aria-label="Close Buildings">×</button>
      </header>

      <Summary summary={network.summary} years={network.years} />

      <div className="road-filters">
        <input
          type="search"
          className="road-search"
          placeholder="Search OBJECTID, UNIQUEID or GlobalID"
          aria-label="Search buildings by OBJECTID, UNIQUEID or GlobalID"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <div className="road-group" role="group" aria-label="Height data">
          {[HEIGHT_FILTER.ANY, HEIGHT_FILTER.WITH, HEIGHT_FILTER.WITHOUT].map(value => (
            <button key={value} type="button" aria-pressed={height === value} onClick={() => setHeight(value)}>
              {HEIGHT_LABELS[value]}
            </button>
          ))}
        </div>
        <div className="road-selects">
          <label>
            <span>Update year</span>
            <select value={year} onChange={event => setYear(event.target.value)}>
              <option value="">All years</option>
              {network.years.map(({ value, count }) => (
                <option key={value || 'none'} value={value}>{value || 'None'} ({count})</option>
              ))}
            </select>
          </label>
          <label>
            <span>Type</span>
            <select value={type} onChange={event => setType(event.target.value)}>
              <option value="">All types</option>
              {network.types.map(({ value, count }) => (
                <option key={value || 'none'} value={value}>{buildingTypeLabel(value)} ({count})</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <p className="road-count">
        {isFiltered(filters)
          ? `${buildings.length.toLocaleString('en-US')} of ${network.summary.total.toLocaleString('en-US')} buildings`
          : `${network.summary.total.toLocaleString('en-US')} buildings`}
      </p>

      <BuildingList buildings={buildings} selectedId={network.selectedId} onSelect={network.select} />

      <p className="road-source-note">
        Partial dataset: {BUILDING_SOURCE.expectedFeatureCount.toLocaleString('en-US')} of the
        {' '}{BUILDING_SOURCE.completeFeatureCount.toLocaleString('en-US')} footprints in the source layer.
        TYPE is shown as the code the file carries; it ships no lookup table.
      </p>
    </aside>
  );
}
