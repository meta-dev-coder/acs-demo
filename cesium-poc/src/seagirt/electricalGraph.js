/**
 * The electrical connectivity engine: a directed graph of assets (nodes) and conductors (edges),
 * and which nodes are energized under a switching scenario.
 *
 * CONNECTIVITY, NOT POWER FLOW. A node is ENERGIZED when an unbroken path of closed conductors
 * runs to it from an available source, through nodes that pass power. That is all this engine
 * claims: an energized path does not mean adequate voltage, capacity or protection coordination,
 * and nothing here is a basis for real switching (see `ENGINE_LIMITATIONS`).
 *
 * THE RULES.
 *   Sources      assets of type UTILITY_SUPPLY that the scenario has not taken offline.
 *   A node passes power unless it is offline in the scenario, or it is a switching device
 *                (breaker, switch) whose state — the scenario's, else its normal state — is OPEN.
 *   An edge      carries power when its state is CLOSED. An UNKNOWN edge might: whatever is
 *                reachable only through one is UNKNOWN, never energized.
 *   Outage impact is therefore CALCULATED: after an outage, a consumer is without power only if no
 *   path from any source still reaches it. Nothing is marked off just for being "below" something.
 * Cycles and multiple supply paths are fine: traversal keeps a visited set and asks only whether
 * a node is reachable.
 *   Feed-through  a load with a modelled loop-in / loop-out (`feedThrough`, from its IFC ports) passes its
 *                 circuit on through its terminals even when the load itself is offline: a failed light
 *                 does not take the next one with it. `blockFeedThrough` treats those terminals as failed
 *                 too (what could also be affected if the fault is in the terminals).
 *
 * Every function is pure. The network and the scenario are read, never changed.
 */

export const STATE = Object.freeze({ ENERGIZED: 'ENERGIZED', DE_ENERGIZED: 'DE_ENERGIZED', UNKNOWN: 'UNKNOWN', OFFLINE: 'OFFLINE' });
export const SWITCH = Object.freeze({ OPEN: 'OPEN', CLOSED: 'CLOSED' });
export const SWITCHING_TYPES = Object.freeze(new Set(['CIRCUIT_BREAKER', 'SWITCH', 'DISCONNECT']));
export const CONSUMER_TYPES = Object.freeze(new Set(['CRANE', 'WAREHOUSE', 'LIGHTING_CIRCUIT', 'EV_CHARGING', 'BUILDING', 'OTHER_LOAD']));
export const SOURCE_TYPES = Object.freeze(new Set(['UTILITY_SUPPLY']));

export const ENGINE_LIMITATIONS = Object.freeze([
  'Connectivity model only: an energized path does not confirm adequate voltage, capacity, protection coordination or safe switching.',
  'Not a basis for field switching. Real switching follows the terminal’s approved procedures.',
]);

/**
 * Index assets and edges, and report what is wrong with them rather than throwing, so a partial
 * inventory still loads and says where it is incomplete.
 * @returns {{ assets: Map, edges: object[], out: Map, in: Map, issues: object[] }}
 */
export function createNetwork({ assets = [], edges = [] } = {}) {
  const issues = [];
  const byId = new Map();
  for (const a of assets) {
    if (!a?.id) { issues.push({ kind: 'MISSING_ID', message: 'An asset has no id.' }); continue; }
    if (byId.has(a.id)) issues.push({ kind: 'DUPLICATE_ASSET', assetId: a.id, message: `Asset ${a.id} appears more than once; the first record is used.` });
    else byId.set(a.id, a);
  }
  const out = new Map(), inn = new Map(), kept = [];
  for (const e of edges) {
    const missing = [e.fromAssetId, e.toAssetId].filter(id => !byId.has(id));
    if (missing.length) {
      issues.push({ kind: 'MISSING_REFERENCE', edgeId: e.id, message: `Connection ${e.id} refers to ${missing.join(' and ')}, which ${missing.length > 1 ? 'are' : 'is'} not in the asset registry; it is ignored.` });
      continue;
    }
    if (e.fromAssetId === e.toAssetId) { issues.push({ kind: 'SELF_LOOP', edgeId: e.id, message: `Connection ${e.id} connects ${e.fromAssetId} to itself; it is ignored.` }); continue; }
    kept.push(e);
    if (!out.has(e.fromAssetId)) out.set(e.fromAssetId, []);
    if (!inn.has(e.toAssetId)) inn.set(e.toAssetId, []);
    out.get(e.fromAssetId).push(e);
    inn.get(e.toAssetId).push(e);
  }
  for (const a of byId.values()) {
    if (a.parentAssetId && !byId.has(a.parentAssetId)) issues.push({ kind: 'MISSING_PARENT', assetId: a.id, message: `${a.id} names parent ${a.parentAssetId}, which is not in the registry.` });
  }
  return Object.freeze({ assets: byId, edges: kept, out, in: inn, issues });
}

/** An empty scenario: nothing offline, every switch in its normal state. */
export const baselineScenario = () => Object.freeze({ offline: Object.freeze([]), switches: Object.freeze({}), label: 'Baseline' });

/** A switching device's state in a scenario. */
export function switchState(network, scenario, id) {
  const a = network.assets.get(id);
  if (!a || !SWITCHING_TYPES.has(a.assetType)) return null;
  return scenario?.switches?.[id] ?? a.normalState ?? SWITCH.CLOSED;
}

const passes = (network, scenario, offline, id) => !offline.has(id)
  && (switchState(network, scenario, id) ?? SWITCH.CLOSED) === SWITCH.CLOSED;

/**
 * Which nodes are energized under a scenario.
 * @returns {{ nodes: Map<string,string>, edges: Map<string,string>, sources: string[] }}
 */
export function energize(network, scenario = baselineScenario(), { blockFeedThrough = [] } = {}) {
  const offline = new Set(scenario.offline ?? []);
  const blocked = new Set(blockFeedThrough);
  const carries = id => Boolean(network.assets.get(id)?.feedThrough) && !blocked.has(id);
  const onward = id => passes(network, scenario, offline, id) || (offline.has(id) && carries(id));
  const sources = [...network.assets.values()].filter(a => SOURCE_TYPES.has(a.assetType) && !offline.has(a.id)).map(a => a.id);
  const walk = allowUnknown => {
    const seen = new Set(sources);
    const queue = [...sources];
    while (queue.length) {
      const id = queue.shift();
      if (!onward(id)) continue;      // reached, but passes nothing on
      for (const e of network.out.get(id) ?? []) {
        const s = e.operationalState ?? 'CLOSED';
        if (s === 'OPEN' || (s === 'UNKNOWN' && !allowUnknown)) continue;
        if ((offline.has(e.toAssetId) && !carries(e.toAssetId)) || seen.has(e.toAssetId)) continue;
        seen.add(e.toAssetId);
        queue.push(e.toAssetId);
      }
    }
    return seen;
  };
  const certain = walk(false), possible = walk(true);
  const nodes = new Map();
  for (const id of network.assets.keys()) {
    nodes.set(id, offline.has(id) ? STATE.OFFLINE : certain.has(id) ? STATE.ENERGIZED : possible.has(id) ? STATE.UNKNOWN : STATE.DE_ENERGIZED);
  }
  const edges = new Map();
  for (const e of network.edges) {
    const from = nodes.get(e.fromAssetId);
    const through = from === STATE.OFFLINE && carries(e.fromAssetId) && (certain.has(e.fromAssetId) || possible.has(e.fromAssetId));
    const live = (from === STATE.ENERGIZED || from === STATE.UNKNOWN || through) && onward(e.fromAssetId) && (e.operationalState ?? 'CLOSED') !== 'OPEN';
    edges.set(e.id, !live ? STATE.DE_ENERGIZED
      : (e.operationalState === 'UNKNOWN' || from === STATE.UNKNOWN) ? STATE.UNKNOWN : STATE.ENERGIZED);
  }
  return { nodes, edges, sources };
}

/** Every asset upstream of `id`, nearest first (topology only; switch states ignored). */
export function getUpstreamAssets(network, id) {
  const out = [], seen = new Set([id]), queue = [id];
  while (queue.length) {
    for (const e of network.in.get(queue.shift()) ?? []) {
      if (seen.has(e.fromAssetId)) continue;
      seen.add(e.fromAssetId);
      out.push(e.fromAssetId);
      queue.push(e.fromAssetId);
    }
  }
  return out;
}

/**
 * Every asset downstream of `id`, nearest first, with whether it is reached only through a
 * normally-open device (so not normally supplied from here).
 */
export function getDownstreamAssets(network, id) {
  const result = new Map();   // id -> { viaNormallyOpen }
  const queue = [{ id, open: false }];
  const best = new Map([[id, false]]);
  while (queue.length) {
    const { id: at, open } = queue.shift();
    const nodeOpen = open || (switchState(network, null, at) === SWITCH.OPEN);
    for (const e of network.out.get(at) ?? []) {
      const viaOpen = nodeOpen || e.operationalState === 'OPEN';
      const prior = best.get(e.toAssetId);
      if (prior !== undefined && (prior === false || prior === viaOpen)) continue;
      best.set(e.toAssetId, viaOpen);
      result.set(e.toAssetId, { assetId: e.toAssetId, viaNormallyOpen: viaOpen });
      queue.push({ id: e.toAssetId, open: viaOpen });
    }
  }
  return [...result.values()];
}

/** Every simple path (list of asset ids) from any source to `targetId`, ignoring switch states. */
export function allSupplyPaths(network, targetId, { limit = 50 } = {}) {
  const paths = [];
  const back = (id, trail) => {
    if (paths.length >= limit) return;
    const a = network.assets.get(id);
    if (a && SOURCE_TYPES.has(a.assetType)) { paths.push([id, ...trail]); return; }
    for (const e of network.in.get(id) ?? []) {
      if (trail.includes(e.fromAssetId) || e.fromAssetId === targetId) continue;   // no cycles
      back(e.fromAssetId, [id, ...trail]);
    }
  };
  back(targetId, []);
  return paths.map(p => (p.at(-1) === targetId ? p : [...p, targetId]).filter((x, i, arr) => arr.indexOf(x) === i));
}

/** The edges along a path of asset ids. */
export const pathEdges = (network, path) => path.slice(1).map((to, i) => (network.out.get(path[i]) ?? []).find(e => e.toAssetId === to)).filter(Boolean);

/**
 * The supply path from `sourceId` (default: any source) to `targetId` that is live in the
 * scenario, else the first path in the topology. Returned with whether it is live.
 */
export function traceSupplyPath(network, targetId, { sourceId = null, scenario = baselineScenario() } = {}) {
  const live = energize(network, scenario);
  const paths = allSupplyPaths(network, targetId).filter(p => !sourceId || p[0] === sourceId);
  const isLive = p => p.every(id => live.nodes.get(id) === STATE.ENERGIZED)
    && p.slice(0, -1).every(id => passes(network, scenario, new Set(scenario.offline ?? []), id))
    && pathEdges(network, p).every(e => (e.operationalState ?? 'CLOSED') === 'CLOSED');
  const livePath = paths.find(isLive);
  return livePath ? { path: livePath, live: true } : paths[0] ? { path: paths[0], live: false } : { path: [], live: false };
}

/**
 * Every way a consumer can be supplied: each path with the normally-open devices it needs closed,
 * and whether it is live now.
 */
export function findAlternativeSupplyPaths(network, consumerId, scenario = baselineScenario()) {
  const offline = new Set(scenario.offline ?? []);
  return allSupplyPaths(network, consumerId).map(path => {
    const needsClosing = path.filter(id => switchState(network, scenario, id) === SWITCH.OPEN);
    const blocked = path.filter(id => offline.has(id));
    const unknownEdges = pathEdges(network, path).filter(e => e.operationalState === 'UNKNOWN').map(e => e.id);
    const transformers = path.filter(id => network.assets.get(id)?.assetType === 'TRANSFORMER');
    return { path, transformers, needsClosing, blocked, unknownEdges, live: !needsClosing.length && !blocked.length && !unknownEdges.length };
  });
}

/** The nearest upstream asset of a type (e.g. the transformer supplying a crane) on its live path. */
export function upstreamOfType(network, id, type, scenario = baselineScenario()) {
  const { path } = traceSupplyPath(network, id, { scenario });
  for (let i = path.length - 2; i >= 0; i -= 1) if (network.assets.get(path[i])?.assetType === type) return path[i];
  return null;
}

/** Consumers that `id` supplies in the baseline (downstream, through normally-closed paths only). */
export function getConnectedConsumers(network, id) {
  return getDownstreamAssets(network, id).filter(d => CONSUMER_TYPES.has(network.assets.get(d.assetId)?.assetType));
}

/**
 * Consumers that can only ever be supplied through one transformer (across every path, open ties
 * included), and those that have a second — with the devices that would have to close.
 */
export function transformerDependence(network, { type = null } = {}) {
  return [...network.assets.values()].filter(a => CONSUMER_TYPES.has(a.assetType) && (!type || a.assetType === type)).map(a => {
    const paths = findAlternativeSupplyPaths(network, a.id);
    const sets = new Set(paths.flatMap(p => p.transformers));
    const normal = paths.filter(p => p.live).flatMap(p => p.transformers);
    return {
      assetId: a.id, transformers: [...sets], normalTransformer: normal[0] ?? null,
      single: sets.size <= 1,
      alternates: paths.filter(p => !p.live).map(p => ({ transformers: p.transformers, needsClosing: p.needsClosing })),
    };
  });
}

/**
 * The scenario's effect against the baseline: what goes dark, what stays powered, what becomes
 * uncertain, and which consumers are now fed through a different path.
 */
export function compareScenario(network, scenario, options = {}) {
  const before = energize(network), after = energize(network, scenario, options);
  const ids = [...network.assets.keys()];
  const was = id => before.nodes.get(id) === STATE.ENERGIZED;
  const is = id => after.nodes.get(id);
  const lost = ids.filter(id => was(id) && is(id) !== STATE.ENERGIZED && is(id) !== STATE.UNKNOWN);
  const offline = ids.filter(id => is(id) === STATE.OFFLINE);
  // Newly uncertain only: something that was already UNKNOWN in the baseline is not an impact.
  const uncertain = ids.filter(id => is(id) === STATE.UNKNOWN && before.nodes.get(id) !== STATE.UNKNOWN);
  const alreadyUnknown = ids.filter(id => is(id) === STATE.UNKNOWN && before.nodes.get(id) === STATE.UNKNOWN);
  const consumers = ids.filter(id => CONSUMER_TYPES.has(network.assets.get(id).assetType));
  const rerouted = consumers.filter(id => is(id) === STATE.ENERGIZED && was(id)
    && traceSupplyPath(network, id).path.join('>') !== traceSupplyPath(network, id, { scenario }).path.join('>'));
  return {
    before, after,
    lost, offline, uncertain, alreadyUnknown, rerouted,
    deEnergized: lost.filter(id => !offline.includes(id)),
    consumersLost: consumers.filter(id => lost.includes(id)),
    consumersPowered: consumers.filter(id => is(id) === STATE.ENERGIZED),
    consumersUncertain: consumers.filter(id => uncertain.includes(id)),
    edgesLost: network.edges.filter(e => before.edges.get(e.id) === STATE.ENERGIZED && after.edges.get(e.id) === STATE.DE_ENERGIZED).map(e => e.id),
  };
}

/** A scenario with one more asset offline (a breaker is OPENED instead: it is a switching device). */
export function withOutage(network, scenario, assetId) {
  const a = network.assets.get(assetId);
  if (!a) return scenario;
  if (SWITCHING_TYPES.has(a.assetType)) return withSwitch(scenario, assetId, SWITCH.OPEN);
  return Object.freeze({ ...scenario, offline: Object.freeze([...new Set([...(scenario.offline ?? []), assetId])]) });
}

/** A scenario with one switching device set OPEN or CLOSED. */
export const withSwitch = (scenario, assetId, state) => Object.freeze({
  ...scenario, switches: Object.freeze({ ...(scenario.switches ?? {}), [assetId]: state }),
});
