import { useDeferredValue, useMemo, useState } from 'react';
import { roadClassLabel } from '../roads/roadModel.js';
import { filterRoads, GROUP_LABELS, GROUPS, isFiltered, sortRoads } from '../roads/roadFilters.js';
import { RoadList } from './RoadList.jsx';

/** Summary figures, all computed from the GeoJSON rather than written down. */
function Summary({ summary }) {
  const rows = [
    ['Total segments', summary.total],
    ['Port access', summary.portAccess],
    ['Surrounding', summary.surrounding],
    ['Named', summary.named],
    ['Unnamed', summary.unnamed],
  ];
  return (
    <dl className="road-summary">
      {rows.map(([label, value]) => (
        <div key={label}><dt>{label}</dt><dd>{value.toLocaleString('en-US')}</dd></div>
      ))}
    </dl>
  );
}

export function RoadNetworkExplorer({ network, onClose }) {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState(GROUPS.ALL);
  const [classCode, setClassCode] = useState('');
  const [municipality, setMunicipality] = useState('');

  // The list is the expensive part. Deferring the term keeps typing responsive: the input updates
  // immediately and the 2,362-row filter catches up a frame later.
  const deferredQuery = useDeferredValue(query);
  const filters = { query: deferredQuery, group, classCode, municipality };
  const roads = useMemo(
    () => sortRoads(filterRoads(network.segments, filters), deferredQuery),
    [network.segments, deferredQuery, group, classCode, municipality]);

  return (
    <aside className="road-explorer" aria-label="Road Network Explorer">
      <header className="road-explorer-head">
        <h2>Road Network</h2>
        <button type="button" className="road-icon-btn" onClick={onClose} aria-label="Close Road Network">×</button>
      </header>

      <Summary summary={network.summary} />

      <div className="road-filters">
        <input
          type="search"
          className="road-search"
          placeholder="Search name or OBJECTID"
          aria-label="Search roads by name or OBJECTID"
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <div className="road-group" role="group" aria-label="Road group">
          {[GROUPS.ALL, GROUPS.PORT, GROUPS.SURROUNDING].map(value => (
            <button
              key={value}
              type="button"
              aria-pressed={group === value}
              onClick={() => setGroup(value)}
            >{GROUP_LABELS[value]}</button>
          ))}
        </div>
        <div className="road-selects">
          <label>
            <span>Class</span>
            <select value={classCode} onChange={event => setClassCode(event.target.value)}>
              <option value="">All classes</option>
              {network.classes.map(({ code, count }) => (
                <option key={code} value={code}>{roadClassLabel(code)} ({count})</option>
              ))}
            </select>
          </label>
          <label>
            <span>Municipality</span>
            <select value={municipality} onChange={event => setMunicipality(event.target.value)}>
              <option value="">All municipalities</option>
              {network.municipalities.map(({ name, count }) => (
                <option key={name} value={name}>{name} ({count})</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <p className="road-count">
        {isFiltered(filters)
          ? `${roads.length.toLocaleString('en-US')} of ${network.summary.total.toLocaleString('en-US')} segments`
          : `${network.summary.total.toLocaleString('en-US')} segments`}
      </p>

      <RoadList roads={roads} selectedId={network.selectedId} onSelect={network.select} />

      <p className="road-source-note">
        CLASS is shown as the code the source file carries; it ships no lookup table for it.
      </p>
    </aside>
  );
}
