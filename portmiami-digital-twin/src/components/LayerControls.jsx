import { LOAD_STATE } from '../hooks/useRoadNetwork.js';

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

export function LayerControls({ roads, buildings, infra, explorer, onToggleExplorer }) {
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
    </div>
  );
}
