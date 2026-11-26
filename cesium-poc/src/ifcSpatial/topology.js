/**
 * Electrical topology of an IFC model, kept apart from what is energized (electricalGraph.js) and from
 * what is reported (operations.js):
 *
 *   physical connectivity   the IFC's own port connections (IfcRelNests + IfcRelConnectsPorts), each with
 *                           its ports and what the file says about direction
 *   electrical roles        from the IFC class (IfcTransformer → TRANSFORMER, IfcLightFixture → LOAD …),
 *                           a source from the model's NetworkRole property; never from a display name
 *   supply resolution       the routes from a source to an asset, each hop with its evidence:
 *                             EXPLICIT_IFC   the ports say SOURCE → SINK in this direction
 *                             INFERRED       the ports are SOURCEANDSINK (no direction in the file); the
 *                                            direction is taken from the source side, normal switch states
 *                             FEED_THROUGH   through a load's own terminals: it has an incoming and an
 *                                            outgoing port in the model (a modelled loop-in / loop-out);
 *                                            the load does not supply what is beyond it
 *                           A route through a load that has no such pair of ports is UNRESOLVED: the model
 *                           does not say whether the load passes anything on, so it is not offered as
 *                           a supply route.
 *
 * Nothing here repairs the model: no junction, cable or direction is added that the file does not state.
 */
import { allSupplyPaths, pathEdges, switchState, SWITCH } from '../seagirt/electricalGraph.js';

export const ROLE = Object.freeze({ SOURCE: 'SOURCE', TRANSFORMER: 'TRANSFORMER', DISTRIBUTION: 'DISTRIBUTION', PROTECTION: 'PROTECTION', SWITCH: 'SWITCH',
  CONDUCTOR: 'CONDUCTOR', JUNCTION: 'JUNCTION', LOAD: 'LOAD', UNKNOWN: 'UNKNOWN' });
export const EVIDENCE = Object.freeze({ EXPLICIT_IFC: 'EXPLICIT_IFC', INFERRED: 'INFERRED', FEED_THROUGH: 'FEED_THROUGH', UNRESOLVED: 'UNRESOLVED' });

const CLASS_ROLE = [
  [/^IfcCable(Segment|CarrierSegment|Fitting|CarrierFitting)$/, ROLE.CONDUCTOR],
  [/^IfcTransformer$/, ROLE.TRANSFORMER],
  [/^IfcProtectiveDevice(TrippingUnit)?$/, ROLE.PROTECTION],
  [/^IfcSwitchingDevice$/, ROLE.SWITCH],
  [/^IfcElectricDistributionBoard$/, ROLE.DISTRIBUTION],
  [/^IfcJunctionBox$/, ROLE.JUNCTION],
  [/^IfcElectricGenerator$/, ROLE.SOURCE],
  [/^(IfcLightFixture|IfcLamp|IfcElectricAppliance|IfcOutlet|IfcElectricMotor|IfcTransportElement|IfcAudioVisualAppliance|IfcCommunicationsAppliance)$/, ROLE.LOAD],
];

/**
 * An element's electrical role and the evidence for it: its IFC class, or for a supply point (which
 * IFC has no class for) the model's own NetworkRole property.
 */
export function roleOf(element) {
  const net = element?.properties?.SuperDNA_PowerNetwork ?? {};
  const declared = String(net.NetworkRole ?? element?.networkRole ?? '').toLowerCase();
  if (declared === 'source' || declared === 'standby source') return { role: ROLE.SOURCE, evidence: 'IFC property NetworkRole' };
  for (const [re, role] of CLASS_ROLE) if (re.test(element?.ifcClass ?? '')) return { role, evidence: `IFC class ${element.ifcClass}` };
  return { role: ROLE.UNKNOWN, evidence: element?.ifcClass ? `IFC class ${element.ifcClass} (no electrical role)` : 'no IFC class' };
}

/**
 * The physical topology: nodes with role, ports and systems; one edge per IFC port connection with its
 * ports, direction (FORWARD when SOURCE → SINK, else BIDIRECTIONAL) and evidence.
 * @param {(globalId: string) => string|null} idOf the network id of an element
 */
export function buildTopology({ elements = [], connections = [], idOf }) {
  const nodes = new Map();
  for (const e of elements) {
    const id = idOf(e.globalId);
    if (!id || nodes.has(id)) continue;
    const { role, evidence } = roleOf(e);
    nodes.set(id, { id, globalId: e.globalId, ifcClass: e.ifcClass, role, roleEvidence: evidence, ports: e.ports ?? [], systems: e.systems ?? [], feedThrough: null, usedPorts: new Map() });
  }
  const edges = [];
  for (const c of connections) {
    const from = idOf(c.from), to = idOf(c.to);
    if (!from || !to || !nodes.has(from) || !nodes.has(to) || from === to) continue;
    const explicit = !c.twoWay && c.fromFlow === 'SOURCE' && c.toFlow === 'SINK';
    edges.push({ from, to, fromPort: c.fromPort ?? null, toPort: c.toPort ?? null, direction: explicit ? 'FORWARD' : 'BIDIRECTIONAL',
      evidence: explicit ? EVIDENCE.EXPLICIT_IFC : EVIDENCE.INFERRED, flows: [c.fromFlow ?? null, c.toFlow ?? null] });
    for (const [id, port, other] of [[from, c.fromPort, to], [to, c.toPort, from]]) {
      const used = nodes.get(id).usedPorts;
      const key = port ?? `?${other}`;
      if (!used.has(key)) used.set(key, []);
      used.get(key).push(other);
    }
  }
  // A load connected on two or more of its own ports has a modelled feed-through (loop-in / loop-out).
  // Connected more than once on a single port, or without port identities, it is unresolved.
  for (const n of nodes.values()) {
    if (n.role !== ROLE.LOAD) continue;
    const ports = [...n.usedPorts.entries()];
    const links = ports.reduce((k, [, others]) => k + others.length, 0);
    if (links < 2) continue;
    const identified = ports.filter(([p]) => !p.startsWith('?'));
    n.feedThrough = identified.length >= 2 ? 'EXPLICIT' : 'UNRESOLVED';
  }
  const adjacency = new Map();
  for (const e of edges) {
    for (const [a, b] of [[e.from, e.to], [e.to, e.from]]) { if (!adjacency.has(a)) adjacency.set(a, []); adjacency.get(a).push({ other: b, edge: e }); }
  }
  return { nodes, edges, adjacency };
}

/** The topology edge between two nodes (either way). */
const edgeBetween = (topo, a, b) => topo.adjacency.get(a)?.find(x => x.other === b)?.edge ?? null;

/**
 * The evidence for each hop of a route (source first): EXPLICIT_IFC when the file's ports run that way,
 * INFERRED when the connection has no direction in the file, FEED_THROUGH where the hop leaves a load
 * through its other port; UNRESOLVED where a route passes a load the model gives no feed-through.
 */
export function routeEvidence(topo, path) {
  const hops = [];
  for (let i = 1; i < path.length; i += 1) {
    const [a, b] = [path[i - 1], path[i]];
    const e = edgeBetween(topo, a, b);
    let evidence = !e ? EVIDENCE.UNRESOLVED : e.direction === 'FORWARD' ? (e.from === a ? EVIDENCE.EXPLICIT_IFC : EVIDENCE.UNRESOLVED) : EVIDENCE.INFERRED;
    const via = topo.nodes.get(a);
    if (i > 1 && via?.role === ROLE.LOAD) evidence = via.feedThrough === 'EXPLICIT' ? EVIDENCE.FEED_THROUGH : EVIDENCE.UNRESOLVED;
    hops.push({ from: a, to: b, evidence, ports: e ? [e.from === a ? e.fromPort : e.toPort, e.from === a ? e.toPort : e.fromPort] : [], flows: e?.flows ?? [] });
  }
  return hops;
}

const EQUIPMENT = new Set([ROLE.SOURCE, ROLE.TRANSFORMER, ROLE.DISTRIBUTION, ROLE.PROTECTION, ROLE.SWITCH, ROLE.JUNCTION]);

/**
 * The electrical supply of an asset: every route from a source (up to `limit`), each with its hop
 * evidence, whether it is live in the scenario and which normally-open devices it needs closed; the
 * route in normal service (when exactly one is); the logical equipment chain of that route (source,
 * transformers, switchgear, protection, the circuit, the asset — loads and cables it passes are in
 * the physical route only); and what the model leaves unresolved.
 *
 * @param network the electrical network (electricalGraph.js), for switch states and sources
 * @param {object} [opts]
 * @param {(path: string[]) => boolean} [opts.isLive] whether a route is live in the scenario
 */
export function resolveSupplyPath(topo, network, targetId, { scenario = null, isLive = () => false, circuitOf = () => null, limit = 50 } = {}) {
  const target = topo.nodes.get(targetId) ?? null;
  const all = allSupplyPaths(network, targetId, { limit });
  const routes = [];
  const unresolved = [];
  for (const path of all) {
    const hops = routeEvidence(topo, path);
    const blockedAt = hops.filter(h => h.evidence === EVIDENCE.UNRESOLVED).map(h => h.from);
    const needsClosing = path.filter(id => switchState(network, scenario, id) === SWITCH.OPEN);
    const route = { path, hops, live: !blockedAt.length && isLive(path), needsClosing, feedThrough: hops.filter(h => h.evidence === EVIDENCE.FEED_THROUGH).map(h => h.from),
      inferred: hops.filter(h => h.evidence === EVIDENCE.INFERRED).length, explicit: hops.filter(h => h.evidence === EVIDENCE.EXPLICIT_IFC).length };
    if (blockedAt.length) unresolved.push({ path, at: [...new Set(blockedAt)], reason: 'passes a load the model gives no feed-through (one port, or no port identities)' });
    else routes.push(route);
  }
  const normal = routes.filter(r => !r.needsClosing.length);
  const live = normal.filter(r => r.live);
  // The route in service: the one live route; else the one normally closed route. More than one: all are
  // returned and none is preferred (a ring, or parallel feeders).
  const primary = live.length === 1 ? live[0] : !live.length && normal.length === 1 ? normal[0] : null;
  const ambiguous = !primary && (live.length > 1 || normal.length > 1);
  const route = primary ?? (live[0] ?? normal[0] ?? null);
  const logical = route ? logicalChain(topo, network, route.path, circuitOf) : [];
  const verification = !route ? 'NONE' : route.hops.every(h => h.evidence === EVIDENCE.EXPLICIT_IFC || h.evidence === EVIDENCE.FEED_THROUGH) ? 'VERIFIED' : 'NOT_FULLY_VERIFIED';
  return { targetId, role: target?.role ?? ROLE.UNKNOWN, routes, primary: route, ambiguous, alternatives: routes.filter(r => r !== route), unresolved, logical, verification,
    feedThroughOf: target?.feedThrough ?? null };
}

/** The supply equipment along a route, with the circuit the last cables belong to, ending at the asset. */
function logicalChain(topo, network, path, circuitOf) {
  const target = path.at(-1);
  const out = [];
  for (const id of path) {
    const role = topo.nodes.get(id)?.role;
    if (id === target) { out.push({ id, role, kind: 'target' }); continue; }
    if (EQUIPMENT.has(role)) out.push({ id, role, kind: 'equipment' });
  }
  // The circuit (a cable property) between the last equipment and the asset.
  const lastEq = [...path].reverse().find(id => id !== target && EQUIPMENT.has(topo.nodes.get(id)?.role));
  const tail = path.slice(path.indexOf(lastEq) + 1, -1);
  const circuit = tail.map(circuitOf).find(Boolean);
  if (circuit) out.splice(out.length - 1, 0, { id: circuit, role: 'CIRCUIT', kind: 'circuit', via: tail });
  return out;
}

/**
 * A developer-facing validation of the topology: counts, and what the model does not settle. Problems
 * in the data are kept apart from what IFC simply does not say.
 */
export function topologyReport(topo, network, { versionLabel = '' } = {}) {
  const nodes = [...topo.nodes.values()];
  const electrical = nodes.filter(n => n.role !== ROLE.UNKNOWN || n.ports.some(p => p.systemType === 'ELECTRICAL'));
  const loads = nodes.filter(n => n.role === ROLE.LOAD);
  const sources = nodes.filter(n => n.role === ROLE.SOURCE);
  const connected = new Set(topo.edges.flatMap(e => [e.from, e.to]));
  const reach = new Set();
  const queue = sources.map(s => s.id);
  for (const id of queue) { if (reach.has(id)) continue; reach.add(id); for (const { other } of topo.adjacency.get(id) ?? []) queue.push(other); }
  // Cycles: an undirected graph has one when edges ≥ nodes − components.
  const comp = new Set(); let components = 0;
  for (const id of connected) {
    if (comp.has(id)) continue;
    components += 1;
    const q = [id];
    for (const x of q) { if (comp.has(x)) continue; comp.add(x); for (const { other } of topo.adjacency.get(x) ?? []) q.push(other); }
  }
  const voltages = new Map([...network.assets.values()].map(a => [a.id, a.voltageLevel]));
  const conductorEnds = topo.edges.reduce((m, e) => { for (const id of [e.from, e.to]) if (topo.nodes.get(id)?.role === ROLE.CONDUCTOR) m.set(id, (m.get(id) ?? 0) + 1); return m; }, new Map());
  return {
    version: versionLabel,
    counts: { electricalAssets: electrical.length, ports: nodes.reduce((k, n) => k + n.ports.length, 0), physicalConnections: topo.edges.length,
      directedEdges: topo.edges.filter(e => e.direction === 'FORWARD').length, undirectedEdges: topo.edges.filter(e => e.direction !== 'FORWARD').length,
      sources: sources.length, loads: loads.length, independentLoops: Math.max(0, topo.edges.length - connected.size + components) },
    loadsAsFeedThrough: loads.filter(n => n.feedThrough === 'EXPLICIT').map(n => n.id),
    loadsUnresolved: loads.filter(n => n.feedThrough === 'UNRESOLVED').map(n => n.id),
    unconnectedLoads: loads.filter(n => !connected.has(n.id)).map(n => n.id),
    notReachableFromSource: nodes.filter(n => n.role !== ROLE.UNKNOWN && connected.has(n.id) && !reach.has(n.id)).map(n => n.id),
    cablesWithMissingEnd: [...topo.nodes.values()].filter(n => n.role === ROLE.CONDUCTOR && (conductorEnds.get(n.id) ?? 0) < 2).map(n => n.id),
    voltageMismatches: topo.edges.filter(e => {
      const [a, b] = [topo.nodes.get(e.from), topo.nodes.get(e.to)];
      if (a.role === ROLE.TRANSFORMER || b.role === ROLE.TRANSFORMER) return false;
      return voltages.get(e.from) && voltages.get(e.to) && voltages.get(e.from) !== voltages.get(e.to);
    }).map(e => `${e.from}–${e.to}`),
    unknownRole: nodes.filter(n => n.role === ROLE.UNKNOWN && connected.has(n.id)).map(n => `${n.id} (${n.ifcClass})`),
    notInIfc: ['IfcElectricalCircuit (not in IFC4; circuits are a cable property, Circuit)', 'IfcRelConnectsPortToElement (not used in this model)'],
  };
}

/** The shortest chain of port connections between two assets (connectivity only; says nothing of direction). */
export function physicalConnection(topo, a, b) {
  if (!topo.nodes.has(a) || !topo.nodes.has(b)) return null;
  const prev = new Map([[a, null]]);
  const queue = [a];
  for (const id of queue) {
    if (id === b) break;
    for (const { other } of topo.adjacency.get(id) ?? []) if (!prev.has(other)) { prev.set(other, id); queue.push(other); }
  }
  if (!prev.has(b)) return null;
  const path = [];
  for (let at = b; at !== null; at = prev.get(at)) path.unshift(at);
  return path;
}

export const RELATIONSHIP = Object.freeze({ VERIFIED_SUPPLY: 'VERIFIED_SUPPLY', MODELED_DIRECTIONAL_PATH: 'MODELED_DIRECTIONAL_PATH', PHYSICALLY_CONNECTED: 'PHYSICALLY_CONNECTED',
  NO_MODELED_SUPPLY_PATH: 'NO_MODELED_SUPPLY_PATH', UNKNOWN: 'UNKNOWN', INVALID_ASSET: 'INVALID_ASSET' });

/**
 * Does `sourceId` supply `targetId`? From the model only, kept in three parts:
 *   physical       is there any chain of port connections between them (IfcRelConnectsPorts)
 *   directional    does a route from a source to the target, in normal service, pass through `sourceId`;
 *                  is the direction of every connection on that stretch stated in the IFC (SOURCE → SINK,
 *                  or through a modelled loop-in / loop-out) or only inferred (SOURCEANDSINK)
 *   operational    never verified here: there is no live SCADA, only the status recorded in the model
 * Classification: MODELED_DIRECTIONAL_PATH (direction stated along the stretch), PHYSICALLY_CONNECTED
 * (connected; any supply direction only inferred, or only with a normally-open device closed),
 * NO_MODELED_SUPPLY_PATH, INVALID_ASSET. VERIFIED_SUPPLY needs operational evidence this model has not.
 */
export function checkSupplyRelationship(topo, network, sourceId, targetId, { scenario = null, isLive = () => false, version = '' } = {}) {
  const base = { sourceAsset: sourceId, targetAsset: targetId, modelVersion: version };
  const missingAssets = [sourceId, targetId].filter(id => !topo.nodes.has(id));
  if (missingAssets.length) return { ...base, classification: RELATIONSHIP.INVALID_ASSET, missingAssets, modeledPath: [], evidence: [], missingEvidence: [] };
  const physicalPath = physicalConnection(topo, sourceId, targetId);
  const toTarget = resolveSupplyPath(topo, network, targetId, { scenario, isLive });
  const through = toTarget.routes.filter(r => r.path.indexOf(sourceId) >= 0 && r.path.indexOf(sourceId) < r.path.length - 1);
  const normal = through.filter(r => !r.needsClosing.length);
  const route = normal[0] ?? through[0] ?? null;
  const at = route ? route.path.indexOf(sourceId) : -1;
  const segment = route ? route.path.slice(at) : [];
  const hops = route ? route.hops.slice(at) : [];
  const inferred = hops.filter(h => h.evidence === EVIDENCE.INFERRED).length;
  const stated = hops.length > 0 && !inferred && hops.every(h => h.evidence !== EVIDENCE.UNRESOLVED);
  // The other way round: the target upstream of the source.
  const reverse = resolveSupplyPath(topo, network, sourceId, { scenario }).routes.some(r => !r.needsClosing.length && r.path.slice(0, -1).includes(targetId));
  let classification;
  if (!physicalPath) classification = RELATIONSHIP.NO_MODELED_SUPPLY_PATH;
  else if (normal.length && stated) classification = RELATIONSHIP.MODELED_DIRECTIONAL_PATH;
  else if (normal.length || through.length) classification = RELATIONSHIP.PHYSICALLY_CONNECTED;
  else classification = reverse ? RELATIONSHIP.NO_MODELED_SUPPLY_PATH : RELATIONSHIP.PHYSICALLY_CONNECTED;
  const missingEvidence = [
    ...(inferred ? [`${inferred} of the ${hops.length} connections from ${sourceId} to ${targetId} have no direction in the IFC (SOURCEANDSINK ports)`] : []),
    ...(route && !normal.length ? [`The route needs ${route.needsClosing.join(', ')} closed (normally open)`] : []),
    'Live breaker and switch positions (no SCADA feed; the model’s normal states are assumed)',
    'Measured power flow (no live data)',
  ];
  return {
    ...base, classification,
    physicalConnectivity: { connected: Boolean(physicalPath), path: physicalPath ?? [] },
    directionalSupply: { onNormalRoute: normal.length > 0, onlyWhenClosing: !normal.length && through.length ? route.needsClosing : [], directionStated: stated, inferredConnections: inferred, reverse },
    operationalSupply: { verified: false, energizedInModel: segment.length ? isLive(segment) : null, reason: 'No live SCADA: statuses are those recorded in the IFC model' },
    modeledPath: segment, intermediateAssets: segment.slice(1, -1), hops,
    evidence: hops.map(h => ({ from: h.from, to: h.to, evidence: h.evidence, ports: h.ports, flows: h.flows,
      globalIds: [topo.nodes.get(h.from)?.globalId, topo.nodes.get(h.to)?.globalId] })),
    alternatives: through.filter(r => r !== route).map(r => ({ path: r.path, needsClosing: r.needsClosing })),
    missingEvidence,
  };
}
