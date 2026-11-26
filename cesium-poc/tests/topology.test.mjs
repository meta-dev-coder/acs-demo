import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildIfcNetwork } from '../src/ifcSpatial/ifcNetwork.js';
import { EVIDENCE, resolveSupplyPath, ROLE, roleOf, topologyReport } from '../src/ifcSpatial/topology.js';
import { compareScenario, energize, STATE, withOutage, baselineScenario } from '../src/seagirt/electricalGraph.js';
import { convertIfc } from '../server/ifcSpatial/convert.mjs';

/**
 * Small IFC-shaped networks: elements with ports, port connections with FlowDirection. `x.y` names port
 * y of element x; a connection [a.p, b.q, 'SOURCE', 'SINK'] is one IfcRelConnectsPorts.
 */
const CLASS = { src: 'IfcElectricDistributionBoard', tx: 'IfcTransformer', cb: 'IfcProtectiveDevice', db: 'IfcElectricDistributionBoard', cable: 'IfcCableSegment', light: 'IfcLightFixture', sw: 'IfcSwitchingDevice' };
function net(spec, links) {
  const ports = new Map();
  const elements = Object.entries(spec).map(([id, kind], i) => ({ globalId: `G${i}_${id}`.padEnd(22, 'x').slice(0, 22), networkId: id, name: id, ifcClass: CLASS[kind],
    networkRole: kind === 'src' ? 'Source' : kind === 'light' ? 'Load' : kind === 'db' ? 'Switchgear bus' : null, properties: { SuperDNA_PowerNetwork: { NetworkRole: kind === 'src' ? 'Source' : undefined, Circuit: kind === 'cable' ? 'L1' : undefined, NormalState: kind === 'sw' ? 'Open' : undefined } },
    ports: [], bbox: { min: [i, 0, 0], max: [i + 1, 1, 1] } }));
  const byId = new Map(elements.map(e => [e.networkId, e]));
  const port = ref => {
    const [id, p = 'a'] = ref.split('.');
    const key = `${id}.${p}`;
    if (!ports.has(key)) { ports.set(key, `P_${key}`.padEnd(22, 'p').slice(0, 22)); byId.get(id).ports.push({ globalId: ports.get(key), flow: 'SOURCEANDSINK', systemType: 'ELECTRICAL' }); }
    return ports.get(key);
  };
  const connections = links.map(([a, b, fa = 'SOURCEANDSINK', fb = 'SOURCEANDSINK']) => ({ from: byId.get(a.split('.')[0]).globalId, to: byId.get(b.split('.')[0]).globalId,
    twoWay: fa === 'SOURCEANDSINK' || fb === 'SOURCEANDSINK', fromFlow: fa, toFlow: fb, fromPort: port(a), toPort: port(b) }));
  return buildIfcNetwork({ elements, connections, toLonLat: (x, y, z) => ({ lon: x, lat: y, height: z }) });
}
const supply = (b, id) => resolveSupplyPath(b.topology, b.network, id, { circuitOf: x => b.network.assets.get(x)?.circuit ?? null });

test('roles come from the IFC class (and a source from the model’s NetworkRole), never from a name', () => {
  assert.equal(roleOf({ ifcClass: 'IfcLightFixture', name: 'Transformer T9' }).role, ROLE.LOAD);
  assert.equal(roleOf({ ifcClass: 'IfcTransformer', name: 'Light' }).role, ROLE.TRANSFORMER);
  assert.equal(roleOf({ ifcClass: 'IfcElectricDistributionBoard', properties: { SuperDNA_PowerNetwork: { NetworkRole: 'Source' } } }).role, ROLE.SOURCE);
  assert.equal(roleOf({ ifcClass: 'IfcWall' }).role, ROLE.UNKNOWN);
});

test('1 parallel lighting circuit: three lights on one board are loads, none supplies another', () => {
  const b = net({ S: 'src', DB: 'db', C1: 'cable', C2: 'cable', C3: 'cable', H1: 'light', H2: 'light', H3: 'light' },
    [['S', 'DB', 'SOURCE', 'SINK'], ['DB.o1', 'C1.a'], ['C1.b', 'H1'], ['DB.o2', 'C2.a'], ['C2.b', 'H2'], ['DB.o3', 'C3.a'], ['C3.b', 'H3']]);
  for (const h of ['H1', 'H2', 'H3']) {
    const s = supply(b, h);
    assert.equal(s.role, ROLE.LOAD);
    assert.deepEqual(s.primary.path, ['S', 'DB', `C${h[1]}`, h]);
    assert.ok(!s.primary.path.slice(0, -1).some(x => x.startsWith('H')), `${h} is not supplied through another light`);
  }
  assert.equal(b.network.assets.get('H1').feedThrough, false);
});

test('2 explicit feed-through: the physical route keeps the lights, the supply chain does not, and a failed lamp does not darken the next', () => {
  const b = net({ S: 'src', CB: 'cb', L1: 'cable', H1: 'light', L2: 'cable', H2: 'light', L3: 'cable', H3: 'light' },
    [['S', 'CB', 'SOURCE', 'SINK'], ['CB', 'L1.a'], ['L1.b', 'H1.in'], ['H1.out', 'L2.a'], ['L2.b', 'H2.in'], ['H2.out', 'L3.a'], ['L3.b', 'H3.in']]);
  const s = supply(b, 'H3');
  assert.deepEqual(s.primary.path, ['S', 'CB', 'L1', 'H1', 'L2', 'H2', 'L3', 'H3'], 'the physical route is preserved');
  assert.deepEqual(s.primary.feedThrough, ['H1', 'H2']);
  assert.deepEqual(s.logical.map(x => x.id), ['S', 'CB', 'L1', 'H3'], 'the logical chain: source, protection, the circuit, the light');
  assert.equal(s.logical[2].kind, 'circuit');
  assert.ok(s.primary.hops.filter(h => h.from === 'H1' || h.from === 'H2').every(h => h.evidence === EVIDENCE.FEED_THROUGH));
  // H1's lamp out: H2 and H3 stay supplied through its terminals; a terminal fault would take them.
  const out = withOutage(b.network, baselineScenario(), 'H1');
  assert.equal(energize(b.network, out).nodes.get('H3'), STATE.ENERGIZED);
  assert.deepEqual(compareScenario(b.network, out).consumersLost, ['H1'], 'only the failed light');
  assert.deepEqual(compareScenario(b.network, out, { blockFeedThrough: ['H1'] }).consumersLost.filter(x => x !== 'H1').sort(), ['H2', 'H3']);
});

test('3 a light with one port and two cables is unresolved: no route through it is offered, nothing is invented', () => {
  const b = net({ S: 'src', L1: 'cable', H1: 'light', L2: 'cable', H2: 'light' },
    [['S', 'L1.a', 'SOURCE', 'SINK'], ['L1.b', 'H1.p'], ['H1.p', 'L2.a'], ['L2.b', 'H2']]);
  assert.equal(b.topology.nodes.get('H1').feedThrough, 'UNRESOLVED');
  const s = supply(b, 'H2');
  assert.equal(s.primary, null);
  assert.deepEqual(s.unresolved[0].at, ['H1']);
  assert.equal(b.network.assets.size, 5, 'no junction was created');
  assert.deepEqual(topologyReport(b.topology, b.network).loadsUnresolved, ['H1']);
});

test('4 two substations joined by an undirected cable: the direction is inferred, never stated as verified', () => {
  const b = net({ S: 'src', R1: 'cable', U1: 'db', R2: 'cable', U2: 'db' },
    [['S', 'R1.a', 'SOURCE', 'SINK'], ['R1.b', 'U1.in', 'SOURCE', 'SINK'], ['U1.r', 'R2.a'], ['R2.b', 'U2']]);
  const s = supply(b, 'U2');
  assert.deepEqual(s.primary.path, ['S', 'R1', 'U1', 'R2', 'U2']);
  assert.deepEqual(s.primary.hops.map(h => h.evidence), [EVIDENCE.EXPLICIT_IFC, EVIDENCE.EXPLICIT_IFC, EVIDENCE.INFERRED, EVIDENCE.INFERRED]);
  assert.equal(s.verification, 'NOT_FULLY_VERIFIED');
  assert.equal(supply(b, 'U1').verification, 'VERIFIED');
});

test('5 a ring: two normally closed routes are both returned, none is preferred', () => {
  const b = net({ S: 'src', A: 'cable', B: 'cable', U: 'db' }, [['S.o1', 'A.a', 'SOURCE', 'SINK'], ['S.o2', 'B.a', 'SOURCE', 'SINK'], ['A.b', 'U.i1'], ['B.b', 'U.i2']]);
  const s = supply(b, 'U');
  assert.equal(s.routes.length, 2);
  assert.equal(s.ambiguous, true);
  assert.equal(s.alternatives.length, 1);
});

test('6 an open switch: the topology is unchanged, the alternative needs it closed; 9 cycles terminate', () => {
  const b = net({ S: 'src', A: 'cable', T: 'sw', B: 'cable', U: 'db', C: 'cable' },
    [['S.o1', 'A.a', 'SOURCE', 'SINK'], ['A.b', 'U.i1'], ['S.o2', 'T.a', 'SOURCE', 'SINK'], ['T.b', 'B.a'], ['B.b', 'U.i2'], ['U.o', 'C.a'], ['C.b', 'S.o3']]);
  assert.equal(b.topology.edges.length, 7, 'every port connection kept');
  const s = supply(b, 'U');
  assert.deepEqual(s.primary.path, ['S', 'A', 'U']);
  assert.ok(s.alternatives.some(r => r.needsClosing.includes('T')));
  assert.ok(topologyReport(b.topology, b.network).counts.independentLoops >= 1);
});

test('the real IFC (V4): HM-3 is supplied through HM-2 and HM-1’s explicit loop-in / loop-out terminals; USS-1 → USS-2 is inferred on the ring', async () => {
  const r = await convertIfc(readFileSync(new URL('./fixtures/ifc/seagirt-compare-v4.ifc', import.meta.url)), {});
  const b = buildIfcNetwork({ elements: r.elements, connections: r.connections, toLonLat: (x, y, z) => ({ lon: x / 1e5, lat: y / 1e5, height: z }) });
  const s = supply(b, 'HM-3');
  assert.deepEqual(s.primary.path, ['UTIL-A', 'C-UA', 'CB-M1P', 'TX-M1', 'I-M1', 'CB-M1S', 'BUS-A', 'CB-RY1', 'RY-1', 'USS-1', 'RY-2', 'USS-2', 'TX-2', 'CB-LV2', 'L2a', 'HM-2', 'L2b', 'HM-1', 'L2c', 'HM-3']);
  assert.deepEqual(s.primary.feedThrough, ['HM-2', 'HM-1']);
  assert.equal(s.verification, 'NOT_FULLY_VERIFIED');
  const ev = Object.fromEntries(s.primary.hops.map(h => [`${h.from}>${h.to}`, h.evidence]));
  assert.equal(ev['RY-1>USS-1'], EVIDENCE.EXPLICIT_IFC);
  assert.equal(ev['USS-1>RY-2'], EVIDENCE.INFERRED);
  assert.deepEqual(s.logical.map(x => x.id), ['UTIL-A', 'CB-M1P', 'TX-M1', 'CB-M1S', 'BUS-A', 'CB-RY1', 'USS-1', 'USS-2', 'TX-2', 'CB-LV2', 'LIGHT-W', 'HM-3']);
  assert.ok(s.alternatives.every(a => a.needsClosing.length), 'the other routes need a normally-open device closed');
  // 7 HM-3 reports no power: that is its own status; HM-4 beyond it stays supplied through its terminals.
  assert.equal(b.network.assets.get('HM-3').reportedPower, 'NO_POWER');
  const rep = topologyReport(b.topology, b.network);
  assert.ok(rep.loadsAsFeedThrough.includes('HM-1'));
  assert.deepEqual(rep.loadsUnresolved, []);
  assert.ok(rep.counts.undirectedEdges > 0 && rep.counts.directedEdges > 0);
});

test('supply relationship on the real IFC (V4): USS-1 → USS-2 is connected and upstream in normal service, but its direction is not stated', async () => {
  const { checkSupplyRelationship, RELATIONSHIP } = await import('../src/ifcSpatial/topology.js');
  const r = await convertIfc(readFileSync(new URL('./fixtures/ifc/seagirt-compare-v4.ifc', import.meta.url)), {});
  const b = buildIfcNetwork({ elements: r.elements, connections: r.connections, toLonLat: (x, y, z) => ({ lon: x / 1e5, lat: y / 1e5, height: z }) });
  const rel = (s, t) => checkSupplyRelationship(b.topology, b.network, s, t, { version: 'v4' });
  const a = rel('USS-1', 'USS-2');
  assert.equal(a.classification, RELATIONSHIP.PHYSICALLY_CONNECTED);
  assert.deepEqual(a.physicalConnectivity.path, ['USS-1', 'RY-2', 'USS-2']);
  assert.deepEqual(a.modeledPath, ['USS-1', 'RY-2', 'USS-2'], 'no invented intermediate equipment');
  assert.equal(a.directionalSupply.onNormalRoute, true);
  assert.equal(a.directionalSupply.directionStated, false);
  assert.equal(a.directionalSupply.inferredConnections, 2);
  assert.equal(a.operationalSupply.verified, false);
  assert.ok(a.missingEvidence.some(m => /no direction in the IFC/.test(m)));
  // The other way round: only with normally-open devices closed; and it is the reverse of the normal flow.
  const back = rel('USS-2', 'USS-1');
  assert.deepEqual(back.directionalSupply.onlyWhenClosing.sort(), ['BT-1', 'RS-Y']);
  assert.equal(back.directionalSupply.reverse, true);
  // Every connection stated SOURCE → SINK: a modeled directional path (still not verified operationally).
  assert.equal(rel('CB-RY1', 'USS-1').classification, RELATIONSHIP.MODELED_DIRECTIONAL_PATH);
  assert.equal(rel('USS-1', 'NOPE').classification, RELATIONSHIP.INVALID_ASSET);
});

test('alternate supply for a piece of equipment asked about (not only consumers): if USS-1 fails, closing RS-Y restores USS-2', async () => {
  const { alternateSupplyOf } = await import('../src/ifcSpatial/networkTwin.js');
  const r = await convertIfc(readFileSync(new URL('./fixtures/ifc/seagirt-compare-v4.ifc', import.meta.url)), {});
  const b = buildIfcNetwork({ elements: r.elements, connections: r.connections, toLonLat: (x, y, z) => ({ lon: x / 1e5, lat: y / 1e5, height: z }) });
  const alt = alternateSupplyOf(b.network, 'USS-1', { targetId: 'USS-2' });
  assert.equal(alt.target.state, 'dead');
  assert.deepEqual(alt.target.restoredBy, ['RS-Y']);
});
