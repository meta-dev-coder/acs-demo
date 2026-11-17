import { LOAD_STATE } from '../hooks/useRoadNetwork.js';
import { TRAFFIC_LAYERS } from '../config/liveTraffic.js';
import { SOURCE_STATUS, sourceNote } from '../liveTraffic/liveTrafficModel.js';
import { TrafficGlyph } from './LiveTrafficWorkspace.jsx';

const countLabel = (state, count) =>
  state === LOAD_STATE.LOADING ? 'loading…'
    : state === LOAD_STATE.FAILED ? 'unavailable'
    : count.toLocaleString('en-US');

/** One row per layer. Visibility and the explorer are separate controls: a layer can be drawn
 *  without its list open, and the list can be read with the layer hidden. */
function LayerRow({ name, layer, count, open, onOpen }) {
  const ready = layer.state === LOAD_STATE.READY;
  return (
    <div className="layer-row">
      <label className="layer-toggle">
        <input
          type="checkbox"
          checked={layer.visible}
          disabled={!ready}
          onChange={event => layer.setVisible(event.target.checked)}
        />
        <span className="layer-name">{name}</span>
        <span className="layer-count">{countLabel(layer.state, count)}</span>
      </label>
      <button type="button" className="layer-open" disabled={!ready} aria-pressed={open} onClick={onOpen}>
        {open ? 'Hide' : 'Explore'}
      </button>
    </div>
  );
}

/**
 * The FL511 marker layers, each toggling independently.
 *
 * Collapsed into a `<details>` so seven more rows do not push the rail over the explorer below it,
 * and every one starts OFF — turning on all seven at once is exactly the cluttered map the layer
 * rail exists to avoid. The count beside each is the live study-area count, so an operator can see
 * there are three closures before deciding to draw them.
 *
 * There is no Traffic Speeds row: FL511 publishes no speed feed through the endpoints this
 * integration reads, and a dead toggle would promise data that cannot arrive. The Live Traffic
 * Overview tab states that in words instead.
 */
function TrafficLayerRows({ traffic }) {
  const note = sourceNote(traffic.eventsPayload);
  const loading = traffic.eventsPayload.sourceStatus === SOURCE_STATUS.LOADING;
  const countFor = layer => {
    if (layer.kind === 'camera') return traffic.summary.cameras;
    if (layer.kind === 'sign') return traffic.summary.messageSigns;
    return traffic.events.filter(event => event.type === layer.key).length;
  };
  return (
    <details className="traffic-layer-group">
      <summary>
        <span className="layer-name">Live Traffic</span>
        <span className={`traffic-chip is-${note.tone}`}>{loading ? 'loading…' : note.text}</span>
      </summary>
      {TRAFFIC_LAYERS.map(layer => (
        <label key={layer.key} className="layer-toggle is-traffic">
          <input
            type="checkbox"
            checked={traffic.layers[layer.key] === true}
            onChange={event => traffic.setLayerVisible(layer.key, event.target.checked)}
          />
          <TrafficGlyph iconKey={layer.key} size={13} />
          <span className="layer-name">{layer.label}</span>
          <span className="layer-count">{loading ? '…' : countFor(layer)}</span>
        </label>
      ))}
    </details>
  );
}

export function LayerControls({ roads, buildings, infra, traffic, explorer, onToggleExplorer }) {
  return (
    <div className="layer-rail">
      <h2>Layers</h2>
      <LayerRow
        name="Road Network" layer={roads} count={roads.summary.total}
        open={explorer === 'ROADS'} onOpen={() => onToggleExplorer('ROADS')}
      />
      <LayerRow
        name="Buildings" layer={buildings} count={buildings.summary.total}
        open={explorer === 'BUILDINGS'} onOpen={() => onToggleExplorer('BUILDINGS')}
      />
      {/* Infrastructure is a registry, not a GIS layer, so it has no visibility checkbox — it
          highlights roads and footprints on the layers that are already there. */}
      <div className="layer-row is-registry">
        <span className="layer-toggle">
          <span className="layer-name">Infrastructure</span>
          <span className="layer-count">{infra.summary.total}</span>
        </span>
        <button
          type="button" className="layer-open"
          aria-pressed={explorer === 'INFRA'} onClick={() => onToggleExplorer('INFRA')}
        >{explorer === 'INFRA' ? 'Hide' : 'Explore'}</button>
      </div>

      <div className="layer-row">
        <span className="layer-toggle">
          <span className="layer-name">Live Traffic</span>
          <span className="layer-count">{traffic.summary.events + traffic.summary.cameras + traffic.summary.messageSigns}</span>
        </span>
        <button
          type="button" className="layer-open"
          aria-pressed={explorer === 'TRAFFIC'} onClick={() => onToggleExplorer('TRAFFIC')}
        >{explorer === 'TRAFFIC' ? 'Hide' : 'Explore'}</button>
      </div>

      <TrafficLayerRows traffic={traffic} />
    </div>
  );
}
