/**
 * The single-line diagram: the electrical TOPOLOGY of the same network the map shows, drawn as a
 * schematic (source at the top, loads at the bottom, not to scale and not geographic).
 *
 * It draws the view model the map draws (`viewModel.js`): the same rings, the same investigation,
 * the same scenario. It has no state of its own and no electrical logic, so the two views cannot
 * drift apart; clicking a node selects the asset exactly as clicking its marker does.
 *
 * Layout is computed from the registry: depth from the source by recorded connections, and
 * left-to-right order from each asset's normal parent, with a branch that has a tie to another
 * branch placed on the side facing it, so ties stay short.
 */
import { SOURCE_TYPES } from './electricalGraph.js';

const SLOT = 54, LEVEL = 62, PAD_X = 34, PAD_Y = 30;
const RING = Object.freeze({ ENERGIZED: '#2ea043', NO_POWER: '#e5484d', OFFLINE: '#e5484d', UNKNOWN: '#f5a623', NOT_EVALUATED: '#8b98a9' });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Positions for every asset: { x, y, depth } in diagram units. Pure. */
export function singleLineLayout(network) {
  const ids = [...network.assets.keys()];
  const sources = ids.filter(id => SOURCE_TYPES.has(network.assets.get(id).assetType));
  const depth = new Map(sources.map(s => [s, 0]));
  const queue = [...sources];
  while (queue.length) {
    const id = queue.shift();
    for (const e of network.out.get(id) ?? []) {
      if (depth.has(e.toAssetId)) continue;
      depth.set(e.toAssetId, depth.get(id) + 1);
      queue.push(e.toAssetId);
    }
  }
  // The normal tree: each asset under the parent it is normally supplied from.
  const children = new Map(ids.map(id => [id, []]));
  const roots = [];
  for (const id of ids) {
    const p = network.assets.get(id).parentAssetId;
    if (p && children.has(p)) children.get(p).push(id); else roots.push(id);
  }
  // Ties: connections that are not parent → child (e.g. F2A → C2). Their two ends attract each other.
  const ties = network.edges.filter(e => network.assets.get(e.toAssetId)?.parentAssetId !== e.fromAssetId);
  const ancestors = id => { const out = []; let at = id; while (at) { out.push(at); at = network.assets.get(at)?.parentAssetId; } return out; };
  const subtree = id => { const out = [id]; for (const c of children.get(id)) out.push(...subtree(c)); return out; };
  const order = new Map(ids.map((id, i) => [id, i]));
  const branchIndex = id => { const chain = ancestors(id); const top = chain[Math.max(0, chain.length - 3)]; return order.get(top) ?? 0; };
  const pull = id => {
    const inside = new Set(subtree(id));
    let score = 0;
    for (const t of ties) {
      const [a, b] = inside.has(t.fromAssetId) ? [t.fromAssetId, t.toAssetId] : inside.has(t.toAssetId) ? [t.toAssetId, t.fromAssetId] : [null, null];
      if (!a || inside.has(b)) continue;
      score += Math.sign(branchIndex(b) - branchIndex(a));
    }
    return score;
  };
  // Branches stay in registry order (so tied branches sit side by side); inside a branch, the
  // subtree with the tie moves to the side that faces its partner.
  for (const [id, list] of children) if ((depth.get(id) ?? 0) >= 2) list.sort((a, b) => pull(a) - pull(b) || order.get(a) - order.get(b));
  const pos = new Map();
  let slot = 0;
  const place = id => {
    const kids = children.get(id);
    if (!kids.length) { pos.set(id, { x: slot, depth: depth.get(id) ?? 0 }); slot += 1; return; }
    kids.forEach(place);
    const xs = kids.map(k => pos.get(k).x);
    pos.set(id, { x: (Math.min(...xs) + Math.max(...xs)) / 2, depth: depth.get(id) ?? 0 });
  };
  roots.forEach(place);
  const maxDepth = Math.max(...[...pos.values()].map(p => p.depth));
  for (const [id, p] of pos) pos.set(id, { ...p, X: PAD_X + p.x * SLOT, Y: PAD_Y + p.depth * LEVEL });
  return { pos, children, width: PAD_X * 2 + (slot - 1) * SLOT, height: PAD_Y * 2 + maxDepth * LEVEL, ties };
}

export function createSingleLine(container, { network, onSelect = () => {}, reducedMotion = false }) {
  const layout = singleLineLayout(network);
  const { pos, children } = layout;
  const typeOf = id => network.assets.get(id).assetType;

  function symbol(id, s) {
    const { X, Y } = pos.get(id);
    const ring = RING[s.ring] ?? RING.NOT_EVALUATED;
    const t = typeOf(id);
    const cls = `sld-node role-${s.role ?? 'none'}${s.dimmed ? ' is-dim' : ''}`;
    const label = (dx = 0, dy = 0, anchor = 'middle') => `<text x="${X + dx}" y="${Y + dy}" text-anchor="${anchor}" class="sld-id">${esc(id)}</text>`;
    let g;
    if (t === 'SWITCHGEAR') {
      const xs = children.get(id).map(c => pos.get(c).X);
      const x1 = Math.min(X, ...xs) - 12, x2 = Math.max(X, ...xs) + 12;
      g = `<rect x="${x1}" y="${Y - 3}" width="${x2 - x1}" height="6" rx="2" fill="${ring}" class="sld-bus"/>${label(x1 - 6 - X, 4, 'end')}`;
    } else if (t === 'TRANSFORMER') {
      g = `<circle cx="${X}" cy="${Y - 6}" r="9" stroke="${ring}"/><circle cx="${X}" cy="${Y + 6}" r="9" stroke="${ring}"/>${label(16, 4, 'start')}`;
    } else if (t === 'CIRCUIT_BREAKER') {
      const closed = s.ring === 'ENERGIZED' && network.assets.get(id).normalState !== 'OPEN';
      g = `<rect x="${X - 7}" y="${Y - 7}" width="14" height="14" rx="2" stroke="${ring}" class="${closed ? 'is-closed' : 'is-open'}"/>${label(12, 4, 'start')}`;
    } else if (t === 'FEEDER') {
      g = `<circle cx="${X}" cy="${Y}" r="3.5" fill="${ring}" stroke="none"/>${label(8, 4, 'start')}`;
    } else if (t === 'UTILITY_SUPPLY') {
      g = `<circle cx="${X}" cy="${Y}" r="12" stroke="${ring}"/><path d="M${X - 6} ${Y} q3 -5 6 0 t6 0" class="sld-wave"/>${label(18, 4, 'start')}`;
    } else if (t === 'SUBSTATION') {
      g = `<rect x="${X - 16}" y="${Y - 11}" width="32" height="22" rx="3" stroke="${ring}"/>${label(0, 4)}`;
    } else {
      g = `<rect x="${X - 19}" y="${Y - 11}" width="38" height="22" rx="11" stroke="${ring}"/>${label(0, 4)}`;
    }
    return `<g class="${cls}" data-asset="${esc(id)}" tabindex="0" role="button" aria-label="${esc(network.assets.get(id).name)}"><title>${esc(network.assets.get(id).name)}</title>${g}</g>`;
  }

  // Edges are drawn orthogonally: down from the upstream symbol, across, down into the next.
  function wire(e, kind) {
    const a = pos.get(e.fromAssetId), b = pos.get(e.toAssetId);
    const fromBus = typeOf(e.fromAssetId) === 'SWITCHGEAR';
    const y1 = a.Y + (fromBus ? 3 : typeOf(e.fromAssetId) === 'TRANSFORMER' ? 15 : 10), y2 = b.Y - (typeOf(e.toAssetId) === 'TRANSFORMER' ? 15 : 10);
    const d = fromBus ? `M${b.X} ${y1} V${y2}` : Math.abs(a.X - b.X) < 0.5 ? `M${a.X} ${y1} V${y2}` : `M${a.X} ${y1} V${(y1 + y2) / 2} H${b.X} V${y2}`;
    return `<path d="${d}" class="sld-wire k-${kind ?? 'hidden'}" data-edge="${esc(e.id)}"/>`;
  }

  container.innerHTML = `<svg class="sld${reducedMotion ? ' is-still' : ''}" viewBox="0 0 ${layout.width} ${layout.height}" preserveAspectRatio="xMidYMin meet" role="img" aria-label="Single-line diagram of the Seagirt electrical network"></svg>`;
  const svg = container.querySelector('svg');
  svg.addEventListener('click', e => { const g = e.target.closest('[data-asset]'); if (g) onSelect(g.dataset.asset); });
  svg.addEventListener('keydown', e => { const g = e.target.closest('[data-asset]'); if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect(g.dataset.asset); } });

  return {
    layout,
    /** Draw a view model (`buildViewModel`): the same one the map just drew. */
    render(model) {
      if (!model) return;
      const wires = network.edges.map(e => wire(e, model.edges.get(e.id))).join('');
      const nodes = [...network.assets.keys()].map(id => symbol(id, model.assets.get(id))).join('');
      svg.innerHTML = `<g class="sld-wires">${wires}</g><g class="sld-nodes">${nodes}</g>`;
    },
    edgeKinds: () => Object.fromEntries([...svg.querySelectorAll('[data-edge]')].map(p => [p.dataset.edge, [...p.classList].find(c => c.startsWith('k-'))?.slice(2)])),
    destroy() { container.innerHTML = ''; },
  };
}
