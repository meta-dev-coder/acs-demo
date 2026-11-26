/**
 * What the Seagirt views show, decided once: every asset's ring, role, label and visibility, every
 * schematic link's style and every feeder label — from the engine's state and the current
 * investigation. Pure and Cesium-free, so the map (`electricalLayer.js`), the single-line diagram
 * (`singleLine.js`) and the tests all read the same answer, and the two views cannot disagree.
 *
 * LINKS ARE SCHEMATIC. Breakers and feeders have no positions, so one drawn link stands for a whole
 * switchgear → breaker → feeder → consumer chain. A link that carries a feeder IS that feeder's
 * segment on the map: it is selectable as the feeder and labelled with its id. A link animates only
 * when every conductor it stands for is energized in the state shown.
 */
import { STATE } from './electricalGraph.js';

const positioned = (network, id) => Number.isFinite(network.assets.get(id)?.location?.longitude);

/**
 * Drawn links: each positioned asset's link to the positioned asset it is supplied from, with the
 * edges it stands for, the feeder and breaker on it (if any), and whether it needs a normally-open
 * device closed or crosses an undocumented connection.
 */
export function schematicLinks(network) {
  const edgeById = new Map(network.edges.map(e => [e.id, e]));
  const links = [];
  const walkUp = (id, edgeIds, start) => {
    for (const e of network.in.get(id) ?? []) {
      const chain = [e.id, ...edgeIds];
      if (!positioned(network, e.fromAssetId)) { walkUp(e.fromAssetId, chain, start); continue; }
      const base = `LINK-${e.fromAssetId}-${start}`;
      const between = [...new Set(chain.flatMap(eid => [edgeById.get(eid).fromAssetId, edgeById.get(eid).toAssetId]))]
        .filter(x => x !== e.fromAssetId && x !== start);
      const typed = type => between.find(x => network.assets.get(x)?.assetType === type) ?? null;
      links.push({
        id: links.some(l => l.id === base) ? `${base}-${chain[0]}` : base,
        fromAssetId: e.fromAssetId, toAssetId: start, edgeIds: chain, assetIds: between,
        feederId: typed('FEEDER'), breakerId: typed('CIRCUIT_BREAKER'),
        normallyOpen: chain.some(eid => {
          const from = network.assets.get(edgeById.get(eid).fromAssetId);
          return ['CIRCUIT_BREAKER', 'SWITCH'].includes(from?.assetType) && from.normalState === 'OPEN';
        }),
        unknown: chain.some(eid => edgeById.get(eid)?.operationalState === 'UNKNOWN'),
      });
    }
  };
  for (const id of network.assets.keys()) if (positioned(network, id)) walkUp(id, [], id);
  return links;
}

/** A node's state as the marker ring shows it. */
export const ringOf = s => (s === STATE.ENERGIZED ? 'ENERGIZED' : s === STATE.OFFLINE ? 'OFFLINE' : s === STATE.UNKNOWN ? 'UNKNOWN'
  : s === STATE.DE_ENERGIZED ? 'NO_POWER' : 'NOT_EVALUATED');

/** How far away a label is still drawn, by type (metres); what the view is about is labelled further out. */
const LABEL_RANGE = Object.freeze({ UTILITY_SUPPLY: 9000, SUBSTATION: 9000, TRANSFORMER: 4200, CRANE: 2600, SWITCHGEAR: 1900 });
const LABEL_CLOSE = 1100;
const FOCUS_RANGE = 30000;

/**
 * The investigation as the views need it, from an Ask the Twin result (or null). Kept to ids and
 * styles; nothing here is recomputed from the network.
 */
export function focusOf(result) {
  if (!result) return null;
  const tone = new Map();
  for (const g of result.resultGroups ?? []) for (const id of g.assetIds) if (!tone.has(id)) tone.set(id, g.tone);
  return {
    kind: result.visualization?.mode ?? 'NONE',
    targets: result.targetAssetIds ?? [],
    related: result.relatedAssetIds ?? [],
    context: result.contextAssetIds ?? [],
    conditional: result.conditionalAssetIds ?? [],
    paths: (result.paths ?? []).map(p => ({ ids: p.assetIds, style: p.style ?? 'normal' })),
    downstream: result.downstream ?? null,
    feeders: result.feederIds ?? [],
    tone,
  };
}

/**
 * @param {object} p
 * @param p.network    the frozen network
 * @param p.links      `schematicLinks(network)`
 * @param p.baseline   `energize(network)`
 * @param p.scenario   a `compareScenario` result, or null
 * @param p.view       { mode: overview|network|assets|singleline, feedersLayer, selectedId, pinnedId, focus: focusOf(...) }
 * @returns {{ assets: Map<string, object>, links: Map<string, object>, feeders: Map<string, object>, edges: Map<string, string> }}
 */
export function buildViewModel({ network, links, baseline, scenario = null, view = {} }) {
  const sc = scenario;
  const nodes = sc ? sc.after.nodes : baseline.nodes;
  const edges = sc ? sc.after.edges : baseline.edges;
  const f = view.focus ?? null;
  const mode = view.mode ?? 'overview';
  const set = ids => new Set(ids ?? []);
  const targets = set(f?.targets), related = set(f?.related), context = set(f?.context), conditional = set(f?.conditional);
  const pathIds = set(f?.paths?.flatMap(p => p.ids));
  const downNormal = set(f?.downstream?.normal), downCond = set(f?.downstream?.conditional);
  if (f?.downstream?.rootId) downNormal.add(f.downstream.rootId);
  const feederFocus = set(f?.feeders);
  const impacted = sc ? new Set([...sc.lost, ...sc.offline, ...sc.uncertain]) : new Set();
  const rerouted = set(sc?.rerouted);
  const pinned = view.pinnedId ?? null, selected = view.selectedId ?? null;
  const focusActive = Boolean(targets.size || related.size || pathIds.size || downNormal.size || downCond.size || conditional.size || feederFocus.size || context.size);
  const interesting = id => targets.has(id) || related.has(id) || pathIds.has(id) || downNormal.has(id) || downCond.has(id)
    || conditional.has(id) || context.has(id) || feederFocus.has(id) || id === selected || id === pinned
    || (sc && (impacted.has(id) || rerouted.has(id)));

  // ---- assets (every asset: the map draws the positioned ones, the single-line draws all) ----
  const assets = new Map();
  for (const a of network.assets.values()) {
    const id = a.id, s = nodes.get(id), ring = ringOf(s);
    const isCond = conditional.has(id) || downCond.has(id);
    const role = id === selected ? 'selected'
      : targets.has(id) ? 'target'
        : sc && s === STATE.OFFLINE ? 'offline'
          : sc && sc.consumersLost.includes(id) ? 'lost'
            : sc && rerouted.has(id) ? 'restored'
              : isCond ? 'conditional'
                : related.has(id) ? 'related'
                  // Context (the rest of a filtered downstream set, a feeder's ends) is shown, not emphasized.
                  : context.has(id) ? 'context'
                    : pathIds.has(id) || downNormal.has(id) || feederFocus.has(id) ? 'path'
                      : id === pinned ? 'pinned' : null;
    const dimmed = focusActive && !interesting(id);
    const major = a.mapTier === 'MAJOR';
    const show = major || mode !== 'overview' || Boolean(sc) || interesting(id) || Boolean(view.feedersLayer);
    let label = id, labelStyle = 'plain';
    if (sc && s === STATE.OFFLINE) { label = `${id} · ${a.assetType === 'FEEDER' ? 'DISCONNECTED' : 'OFFLINE'}`; labelStyle = 'bad'; }
    else if (sc && sc.consumersLost.includes(id)) { label = `${id} · NO POWER`; labelStyle = 'bad'; }
    else if (sc && rerouted.has(id)) { label = `${id} · ALTERNATE SUPPLY`; labelStyle = 'good'; }
    else if (isCond && !sc) { label = `${id} · VIA OPEN TIE`; labelStyle = 'cond'; }
    else if (role === 'selected' || role === 'target' || role === 'pinned') labelStyle = 'focus';
    else if (f?.tone?.get(id) === 'warn') labelStyle = 'warn';
    const priority = { selected: 100, target: 90, offline: 85, lost: 80, restored: 80, conditional: 75, path: 70, pinned: 65, related: 60 }[role]
      ?? (major ? 40 : role === 'context' ? 15 : 20);
    // Context (e.g. the loads at the end of a feeder) is shown, but only what the view is about is named.
    const labelShow = !dimmed && role !== 'context';
    assets.set(id, {
      id, ring, role, dimmed, show, label, labelStyle, labelShow, priority,
      labelFar: priority >= 60 ? FOCUS_RANGE : LABEL_RANGE[a.assetType] ?? LABEL_CLOSE,
      tone: f?.tone?.get(id) ?? null,
    });
  }

  // ---- links ----
  const conductor = l => {
    const states = l.edgeIds.map(id => edges.get(id));
    if (states.every(s => s === STATE.ENERGIZED)) return 'energized';
    if (sc && l.edgeIds.some(id => sc.edgesLost.includes(id))) return 'lost';
    if (states.includes(STATE.UNKNOWN)) return 'unknown';
    return l.normallyOpen ? 'open' : 'dead';
  };
  const edgeById = new Map(network.edges.map(e => [e.id, e]));
  // A path that ends on a feeder or breaker (which have no position) ends inside a drawn link: that
  // link is the feeder's segment and is drawn as part of the path.
  const inPath = (l, ids) => {
    if (!ids.includes(l.fromAssetId)) return false;
    if (ids.includes(l.toAssetId)) return l.edgeIds.every(eid => { const e = edgeById.get(eid); return ids.includes(e.fromAssetId) && ids.includes(e.toAssetId); });
    const end = l.assetIds.indexOf(ids.at(-1));
    return end >= 0 && l.assetIds.slice(0, end + 1).every(x => ids.includes(x));
  };
  // Likewise a downstream trace rooted on a feeder or breaker starts inside its link.
  const rootIn = l => Boolean(f?.downstream) && l.assetIds.includes(f.downstream.rootId);
  const outLinks = new Map();
  for (const l of links) {
    const c = conductor(l);
    const still = c === 'lost' ? 'lost' : c === 'unknown' ? 'unknown' : c === 'open' ? 'open' : 'dim';
    const traced = f?.paths?.find(p => inPath(l, p.ids));
    const after = l.assetIds.slice(rootIn(l) ? l.assetIds.indexOf(f.downstream.rootId) + 1 : 0);
    const inDown = (downNormal.has(l.fromAssetId) || rootIn(l)) && downNormal.has(l.toAssetId) && after.every(x => downNormal.has(x));
    const toCond = (downCond.has(l.toAssetId) || after.some(x => downCond.has(x))) && (downNormal.has(l.fromAssetId) || rootIn(l));
    const feederFocused = l.feederId && feederFocus.has(l.feederId);
    let kind, emphasis = 'normal';
    if (traced) {
      emphasis = 'strong';
      kind = c === 'energized' ? (sc ? 'live' : 'flow') : traced.style === 'alternate' && c === 'open' ? 'conditional' : still;
    } else if (f?.downstream && (inDown || toCond)) {
      kind = toCond ? 'conditional' : c === 'energized' ? 'flow' : still;
    } else if (feederFocused) {
      emphasis = 'strong';
      kind = c === 'energized' ? (sc ? 'live' : 'flow') : still;
    } else if (f && (f.paths.length || f.downstream)) {
      // A trace or a downstream view shows only what it is about (a scenario keeps its own colours).
      kind = sc ? (c === 'energized' ? 'live' : still) : 'hidden';
    } else if (sc) {
      // The outage's own story (what was cut, what was rerouted) is drawn strong; the rest of the
      // still-energized network stays visible but quiet, so the map is not a web of equal lines.
      kind = c === 'energized' ? 'live' : still;
      const involved = rerouted.has(l.toAssetId) || impacted.has(l.toAssetId) || impacted.has(l.fromAssetId) || l.assetIds.some(x => impacted.has(x) || rerouted.has(x));
      const restoredHere = rerouted.has(l.toAssetId) && kind === 'live';
      emphasis = restoredHere ? 'strong' : kind === 'live' && !involved ? 'soft' : 'normal';
    }
    else if (mode === 'network') { kind = c === 'energized' ? 'flowSoft' : still; emphasis = 'soft'; }
    else if (view.feedersLayer && l.feederId) { kind = c === 'energized' ? 'flowSoft' : still; emphasis = 'soft'; }
    else kind = 'hidden';
    if (l.feederId && l.feederId === selected && kind !== 'hidden') emphasis = 'selected';
    if (l.feederId && l.feederId === selected && kind === 'hidden') { kind = c === 'energized' ? 'flow' : still; emphasis = 'selected'; }
    outLinks.set(l.id, { id: l.id, kind, emphasis, conductor: c, feederId: l.feederId, breakerId: l.breakerId });
  }

  // ---- feeder labels: on the feeder's segment, named when the view is about it or feeders are shown ----
  const feeders = new Map();
  for (const l of links) {
    if (!l.feederId) continue;
    const fid = l.feederId, s = outLinks.get(l.id), st = nodes.get(fid);
    const inFocus = pathIds.has(fid) || feederFocus.has(fid) || targets.has(fid) || downNormal.has(fid) || downCond.has(fid) || fid === selected
      || (sc && (impacted.has(fid) || sc.edgesLost.some(e => l.edgeIds.includes(e))));
    const show = s.kind !== 'hidden' && (inFocus || mode === 'network' || Boolean(view.feedersLayer));
    // In a focused path the breaker is named with its feeder, so every component is on the map.
    const text = sc && st === STATE.OFFLINE ? `${fid} · DISCONNECTED`
      : (pathIds.has(fid) || fid === selected) && l.breakerId ? `${l.breakerId} › ${fid}` : fid;
    const style = fid === selected || targets.has(fid) ? 'focus' : s.kind === 'lost' ? 'bad' : s.kind === 'conditional' || s.kind === 'open' ? 'cond'
      : s.kind === 'unknown' ? 'warn' : 'feeder';
    feeders.set(fid, { id: fid, linkId: l.id, show, text, style, priority: fid === selected ? 100 : targets.has(fid) ? 88 : inFocus ? 68 : 30 });
  }

  // ---- per conductor (the single-line diagram draws every edge): the style of the link it is part of ----
  const edgeKinds = new Map();
  for (const l of links) for (const eid of l.edgeIds) edgeKinds.set(eid, outLinks.get(l.id).kind);
  return { assets, links: outLinks, feeders, edges: edgeKinds };
}
