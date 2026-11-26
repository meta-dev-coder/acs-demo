import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildIfcNetwork, assetTypeOf, reportedPowerOf, symbolOf, voltageClass } from '../src/ifcSpatial/ifcNetwork.js';
import { IFC_QUESTION_BANK } from '../src/ifcSpatial/ifcQuestionBank.js';
import { QUESTION_BANK } from '../src/seagirt/questionBank.js';
import { createScenarioSession } from '../src/seagirt/outageScenario.js';
import { energize, compareScenario, withOutage, baselineScenario, STATE } from '../src/seagirt/electricalGraph.js';
import { ask, INTENT, validateResult } from '../src/seagirt/askSeagirt.js';

// The real IFC network (seagirt_power_network.ifc, converted), trimmed to its power-network elements.
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/ifc-network.json', import.meta.url), 'utf8'));
const toLonLat = (x, y, z) => ({ lon: -76.54 + x / 86000, lat: 39.256 + y / 111000, height: z });
const built = buildIfcNetwork({ ...FIXTURE, toLonLat });
const QUESTIONS = IFC_QUESTION_BANK.flatMap(c => c.questions);

function run(question) {
  const session = createScenarioSession({ assets: built.assets, edges: built.edges, notes: built.network.notes });
  const { parsed, answer } = ask(question, { network: session.network, session, today: '2026-11-23' });
  const { result, dropped } = validateResult(answer, session.network);
  const text = [result.answer.title, result.answer.summary, result.answer.explanation, ...result.answer.lines, ...result.answer.determinable].join(' ');
  return { parsed, r: result, dropped, text, session };
}

// ---- the network, from the IFC ----

test('the IFC network: every element with a NetworkID gets the twin type its role and class say', () => {
  const type = id => built.network.assets.get(id)?.assetType;
  assert.equal(type('UTIL-A'), 'UTILITY_SUPPLY');
  assert.equal(type('GEN-1'), 'UTILITY_SUPPLY');
  assert.equal(built.network.assets.get('GEN-1').standby, true);
  assert.equal(type('TX-M1'), 'TRANSFORMER');
  assert.equal(type('BUS-A'), 'SWITCHGEAR');
  assert.equal(type('QSS-W'), 'SWITCHGEAR');
  assert.equal(type('USS-3'), 'SUBSTATION');
  assert.equal(type('BT-1'), 'CIRCUIT_BREAKER');
  assert.equal(type('AT-1'), 'SWITCH');
  assert.equal(type('F2'), 'FEEDER');
  assert.equal(type('V05'), 'JUNCTION_BOX');
  assert.equal(type('STS-05'), 'CRANE');
  assert.equal(type('HM-3'), 'LIGHTING_CIRCUIT');
  assert.equal(type('R2'), 'OTHER_LOAD');
  assert.equal(type('GATE'), 'BUILDING');
  assert.equal(type('RTU-MSS'), undefined, 'SCADA is not part of the power graph');
  assert.equal(type('STS-05-STRUCT'), undefined, 'the crane steel is geometry, its e-house is the load');
  assert.equal(assetTypeOf({ networkId: 'FO-01', networkRole: 'SCADA fibre', ifcClass: 'IfcCableSegment' }), null);
  // Normal states from the model's NormalState.
  for (const id of ['AT-1', 'AT-2', 'RS-Y', 'RS-L', 'BT-1']) assert.equal(built.network.assets.get(id).normalState, 'OPEN', id);
  assert.equal(built.network.assets.get('ATS-1').normalState, 'CLOSED');
  assert.equal(built.network.issues.length, 0);
  assert.equal(built.scadaLinks.length, 30);
  assert.equal(built.structures.size, 12);
});

test('the IFC network: names, voltages, demand, routes and positions come from the model', () => {
  const tx = built.network.assets.get('TX-M1');
  assert.equal(tx.name, 'Main transformer TX-M1', 'the id prefix the IFC name carries is dropped');
  assert.equal(tx.capacityKw, 11000);
  assert.equal(voltageClass(tx), 'hv');
  assert.equal(voltageClass(built.network.assets.get('F2')), 'mv');
  assert.equal(voltageClass(built.network.assets.get('L3')), 'lv');
  assert.equal(built.network.assets.get('STS-05').demandKw, 750);
  assert.equal(built.network.assets.get('R2').reeferPlugs, 240);
  assert.ok(built.network.assets.get('F2').route.length >= 2, 'cables carry their IFC route');
  for (const a of built.assets.filter(x => x.route)) {
    assert.ok(a.route.every(p => Number.isFinite(p.lon) && Number.isFinite(p.lat)), `${a.id}: every route point is a number`);
  }
  assert.ok(Number.isFinite(tx.location.longitude) && Number.isFinite(tx.location.latitude));
  assert.equal(symbolOf(tx), 'mtx');
  assert.equal(symbolOf(built.network.assets.get('STS-05')), 'sts');
  assert.equal(symbolOf(built.network.assets.get('GEN-1')), 'gen');
});

test('the engine on the IFC network: baseline all energized; outages match the network\'s structure', () => {
  const base = energize(built.network);
  assert.deepEqual([...base.nodes.values()].filter(s => s !== STATE.ENERGIZED), []);
  const lost = id => [...compareScenario(built.network, withOutage(built.network, baselineScenario(), id)).consumersLost].sort();
  assert.deepEqual(lost('AP-03'), ['STS-03', 'STS-04']);
  assert.deepEqual(lost('TX-3'), ['R2']);
  assert.ok(lost('TX-M2').includes('STS-12') && !lost('TX-M2').includes('OPS'), 'the ops building stays up on GEN-1');
  assert.ok(lost('C-UA').includes('STS-01') && !lost('C-UA').includes('STS-12'));
});

// ---- Ask the Twin: the 30 questions, reworded for the IFC network ----

test('the IFC question bank keeps the twin\'s six categories and 30 questions', () => {
  assert.equal(QUESTIONS.length, 30);
  assert.deepEqual(IFC_QUESTION_BANK.map(c => c.name), QUESTION_BANK.map(c => c.name));
  for (const q of QUESTIONS) {
    const { r, dropped } = run(q);
    assert.notEqual(r.intent, INTENT.UNKNOWN, q);
    assert.notEqual(r.status, 'UNSUPPORTED', q);
    assert.equal(dropped.length, 0, `${q}: no unknown ids`);
  }
});

const expectations = [
  [1, INTENT.LOCATE, ['TX-M1'], r => assert.equal(r.primaryAssetId, 'TX-M1')],
  [2, INTENT.LIST, ['9 transformers']],
  [3, INTENT.RELATED, ['BUS-B', 'I-M2']],
  [4, INTENT.LIST, ['7 substations', '5 switchgear']],
  [5, INTENT.LIST, ['12 cranes']],
  [6, INTENT.UPSTREAM_TYPE, ['Main transformer TX-M1', 'BUS-A', 'F2', 'QSS-C']],
  [7, INTENT.PATH, ['UTIL-B', 'TX-M2', 'BUS-B', 'F3', 'QSS-E', 'STS-09']],
  [8, INTENT.UPSTREAM_TYPE, ['USS-5', 'TX-5']],
  [9, INTENT.DOWNSTREAM, ['62 assets']],
  [10, INTENT.DOWNSTREAM, ['7 transformers', '5 switches', '60 feeders']],
  [11, INTENT.OUTAGE, ['15 consumers', 'STS-12', 'alternate path'], r => assert.equal(r.scenario?.active ?? true, true)],
  [12, INTENT.OUTAGE, ['STS-03', 'STS-04'], r => assert.deepEqual([...r.targetAssetIds].sort(), ['AP-03', 'STS-03', 'STS-04'], 'the cut cable and the two cranes it leaves without power')],
  [13, INTENT.OUTAGE, ['0 buildings', '4 lighting circuits', '8 cranes']],
  [14, INTENT.OUTAGE, ['STS-05', 'STS-08']],
  [15, INTENT.OUTAGE, ['6 consumers'], r => { for (const id of ['GATE', 'ICTF-OFF', 'WS', 'HM-9']) assert.ok(r.targetAssetIds.includes(id), id); assert.ok(!r.targetAssetIds.includes('OPS'), 'OPS stays on GEN-1'); }],
  [16, INTENT.ALTERNATES, ['normally-open', 'BT-1']],
  [17, INTENT.TRANSFER, ['15 of 15']],
  [18, INTENT.NO_REDUNDANCY, ['single supply path']],
  [19, INTENT.SINGLE_SOURCE, ['No crane depends on a single transformer']],
  [20, INTENT.ALTERNATES, ['RS-Y']],
  [21, INTENT.INSPECTION, ['No inspection']],
  [22, INTENT.OVERDUE, ['No inspection schedules']],
  [23, INTENT.CONDITION, ['No condition records']],
  [24, INTENT.REPLACEMENT, ['No replacement-planning data']],
  [25, INTENT.HISTORY, ['no maintenance records', 'not available']],
  [26, INTENT.ENGINEERING, ['6.95 MW', '11.00 MW', 'assumed demand']],
  [27, INTENT.ENGINEERING, ['cannot be calculated']],
  [28, INTENT.ENGINEERING, ['cannot be calculated', 'STS-12']],
  [29, INTENT.ENGINEERING, ['overload TX-M1', '11.96 MW']],
  [30, INTENT.ENGINEERING, ['Interrupting duty cannot be assessed']],
];

for (const [n, intent, phrases, extra] of expectations) {
  test(`IFC Q${n}: ${QUESTIONS[n - 1]}`, () => {
    const { r, text } = run(QUESTIONS[n - 1]);
    assert.equal(r.intent, intent);
    for (const phrase of phrases) assert.ok(text.includes(phrase), `"${phrase}" in: ${text.slice(0, 400)}`);
    extra?.(r);
  });
}

test('IFC answers state the IFC\'s own provenance, not the synthetic inventory\'s', () => {
  const { r } = run(QUESTIONS[6]);
  assert.ok(r.answer.limitations.every(l => !/schematic between illustrative positions/.test(l)));
  assert.match(run(QUESTIONS[20]).r.answer.limitations.join(' '), /IFC model carries no inspection/);
  assert.equal(r.provenance.identity, 'ILLUSTRATIVE', 'the IFC says of itself it is an illustrative mock');
  assert.equal(r.provenance.topology, 'IMPORTED_MODEL');
});

// ---- the mock's status logic on the IFC network (networkTwin.js) ----
import { islandLoads, networkState, restoreOptions, SCENARIOS, unpoweredAssets } from '../src/ifcSpatial/networkTwin.js';
import { withOutage as outage } from '../src/seagirt/electricalGraph.js';

const scenarioOf = ids => ids.reduce((sc, id) => outage(built.network, sc, id), baselineScenario());

test('generator: standby in normal running, carrying the ops building when both utility feeds are lost', () => {
  const normal = networkState(built.network, null).nodeState;
  assert.equal(normal.get('OPS'), 'live');
  assert.equal(normal.get('GEN-1'), 'standby');
  assert.equal(normal.get('L5c'), 'standby', 'its own cable is a standby path, not "on generator"');
  const black = networkState(built.network, scenarioOf(['C-UA', 'C-UB'])).nodeState;
  assert.equal(black.get('OPS'), 'backup');
  assert.equal(black.get('GEN-1'), 'backup');
  assert.equal(black.get('STS-01'), 'dead');
  assert.equal(black.get('C-UA'), 'off');
});

test('supply islands: modelled demand per main transformer, as the mock\'s capacity bars', () => {
  const loads = Object.fromEntries(islandLoads(built.network, null).map(i => [i.id, i]));
  assert.equal(loads['TX-M1'].loadKw, 6948, '8 cranes × 750 + Reefers W 900 + 4 masts × 12 kW');
  assert.equal(loads['TX-M1'].capacityKw, 11000);
  assert.ok(loads['TX-M2'].loadKw > 0);
});

test('restore by switching after TX-M2 trips: BT-1 restores everything but overloads TX-M1; ring ties restore part safely', () => {
  const options = restoreOptions(built.network, scenarioOf(['TX-M2']));
  const bt1 = options.find(o => o.switchId === 'BT-1');
  assert.equal(bt1.restored.length, 15);
  assert.deepEqual(bt1.overloads.map(i => i.id), ['TX-M1']);
  const at2 = options.find(o => o.switchId === 'AT-2');
  assert.deepEqual([...at2.restored].sort(), ['STS-09', 'STS-10', 'STS-11', 'STS-12']);
  assert.deepEqual(at2.overloads, []);
  assert.deepEqual(restoreOptions(built.network, null), [], 'nothing to restore in normal running');
  assert.deepEqual(SCENARIOS.map(s => s.id), ['normal', 'utilA', 'txm2', 'apron', 'ring', 'reefer', 'black']);
});

import { flowDirections } from '../src/ifcSpatial/networkTwin.js';
import { withSwitch } from '../src/seagirt/electricalGraph.js';

test('flow direction: each live cable is drawn from the end power arrives at, and reverses when a tie changes the feed', () => {
  const normal = flowDirections(built.network, null);
  assert.equal(normal.get('F1'), 'forward', 'F1 is modelled from Bus A towards QSS-W');
  assert.ok(!normal.has('RY-4') || normal.get('RY-4'), 'beyond the open RS-Y the ring is fed from the other side');
  // Cut RY-2 and close the yard-ring open point: RY-3 is now fed from RS-Y, the opposite end.
  const before = normal.get('RY-3');
  const tie = withSwitch(scenarioOf(['RY-2']), 'RS-Y', 'CLOSED');
  const after = flowDirections(built.network, tie).get('RY-3');
  assert.ok(before && after && before !== after, `RY-3 reverses (${before} → ${after})`);
  assert.equal(flowDirections(built.network, scenarioOf(['C-UA', 'C-UB'])).get('F1'), undefined, 'no flow where nothing is live');
});

test('unpowered in the model: none in the ACC model as drawn; a version that disconnects AP-03 leaves its cranes without power', () => {
  assert.deepEqual(unpoweredAssets(built.network), []);
  // A later version in which cable AP-03 is no longer connected at either end.
  const ap03 = FIXTURE.elements.find(e => e.networkId === 'AP-03').globalId;
  const cut = buildIfcNetwork({ ...FIXTURE, connections: FIXTURE.connections.filter(c => c.from !== ap03 && c.to !== ap03), toLonLat });
  const dead = unpoweredAssets(cut.network);
  for (const id of ['AP-03', 'STS-03', 'STS-04']) assert.ok(dead.includes(id), `${id} is unpowered`);
  assert.ok(!dead.includes('STS-05'), 'the next vault is fed from the other side');
  assert.ok(!dead.includes('GEN-1'), 'the standby generator is not counted');
});

test('reported in the model: SuperDNA_AssetStatus.PowerStatus "No power" is applied; equipment passes it on, a consumer does not', () => {
  assert.equal(reportedPowerOf('No power'), 'NO_POWER');
  assert.equal(reportedPowerOf('NO POWER'), 'NO_POWER');
  assert.equal(reportedPowerOf('Powered'), 'POWERED');
  assert.equal(reportedPowerOf(undefined), null);
  const report = (ids, value = 'No power') => FIXTURE.elements.map(e => (ids.includes(e.networkId)
    ? { ...e, properties: { ...e.properties, SuperDNA_AssetStatus: { PowerStatus: value, StatusFlag: 'NO POWER', StatusDate: '2026-11-24' } } } : e));
  // As in seagirt_power_network_status_v2.ifc: crane STS-06 and high-mast light HM-3, still connected.
  const v2 = buildIfcNetwork({ ...FIXTURE, elements: report(['STS-06', 'HM-3']), toLonLat });
  assert.deepEqual(unpoweredAssets(v2.network).sort(), ['HM-3', 'STS-06'], 'the next light on HM-3\'s circuit keeps its power');
  assert.equal(v2.network.assets.get('STS-06').statusDate, '2026-11-24');
  const { nodeState } = networkState(v2.network, null);
  assert.equal(nodeState.get('STS-06'), 'dead');
  assert.equal(nodeState.get('STS-05'), 'live');
  // Reported on a cable: what only that cable feeds is dark too.
  const cable = buildIfcNetwork({ ...FIXTURE, elements: report(['AP-03']), toLonLat });
  for (const id of ['AP-03', 'STS-03', 'STS-04']) assert.ok(unpoweredAssets(cable.network).includes(id), `${id} is unpowered`);
  // "Powered" changes nothing.
  assert.deepEqual(unpoweredAssets(buildIfcNetwork({ ...FIXTURE, elements: report(['STS-06'], 'Powered'), toLonLat }).network), []);
});

test('short circuit (V4): the model\'s screening answers which breakers may exceed their interrupting rating; assumed ratings are said to be assumed', async () => {
  const { convertIfc } = await import('../server/ifcSpatial/convert.mjs');
  const converted = await convertIfc(readFileSync(new URL('./fixtures/ifc/seagirt-compare-v4.ifc', import.meta.url)), {});
  const v4 = buildIfcNetwork({ elements: converted.elements, connections: converted.connections, toLonLat });
  const session = createScenarioSession({ assets: v4.assets, edges: v4.edges, notes: v4.network.notes });
  const q = 'Which circuit breakers may exceed their interrupting ratings under the modeled short-circuit conditions?';
  const { result } = validateResult(ask(q, { network: session.network, session, today: '2026-11-24' }).answer, session.network);
  const a = result.answer;
  assert.equal(a.title, 'CB-LV3 may exceed its interrupting rating');
  assert.match(a.summary, /CB-LV3: 42\.21 kA duty, 101% of an assumed 42 kA rating/);
  assert.match(a.summary, /above 80%: CB-LV1, CB-LV7 and CB-LV5/);
  assert.match(a.summary, /against an assumed rating/);
  assert.deepEqual(result.resultGroups.map(g => [g.key, g.assetIds.length]), [['over', 1], ['close', 3], ['within', 30]]);
  assert.deepEqual(result.targetAssetIds, ['CB-LV3']);
  assert.ok(a.limitations.some(l => /Screening on assumed data/.test(l)));
  assert.ok(!/\(\)|in \./.test(JSON.stringify(a)), 'no empty fragments');
  // The same question on a model without a screening (V3): cannot be assessed, without empty fragments.
  const { result: none } = validateResult(ask(q, { network: built.network, session: createScenarioSession({ assets: built.assets, edges: built.edges, notes: built.network.notes }), today: '2026-11-24' }).answer, built.network);
  assert.equal(none.answer.title, 'Interrupting duty cannot be assessed');
  assert.ok(!/\(\)|sit in \./.test(JSON.stringify(none.answer)));
});

test('connectivity questions get connectivity answers: "what does X supply" is downstream, "what supplies X" is its supply path', () => {
  const session = createScenarioSession({ assets: built.assets, edges: built.edges, notes: built.network.notes });
  const askIt = (q, context = {}) => ask(q, { network: session.network, session, context, today: '2026-11-25' });
  const supply = askIt('What does TX-M1 supply?');
  assert.equal(supply.answer.intent, 'DOWNSTREAM');
  assert.equal(supply.answer.primaryAssetId, 'TX-M1');
  assert.ok(supply.answer.targetAssetIds.length > 1);
  assert.equal(askIt('What does the main transformer TX-M2 supply?').answer.intent, 'DOWNSTREAM');
  // "it" is the asset in the conversation (or the one selected).
  assert.equal(askIt('What does it supply?', { selectedAssetId: 'QSS-C' }).answer.primaryAssetId, 'QSS-C');
  assert.equal(askIt('What does it supply?', supply.context).answer.intent, 'DOWNSTREAM');
  assert.equal(askIt('What supplies STS-05?').answer.intent, 'PATH');
  assert.equal(askIt('Show me TX-M1').answer.intent, 'LOCATE', 'a look-up stays a look-up');
});

test('alternate supply: if TX-M1 fails, what loses supply and which normally-open device restores it; a target asked about; nothing changed', async () => {
  const { alternateSupplyOf } = await import('../src/ifcSpatial/networkTwin.js');
  const session = createScenarioSession({ assets: built.assets, edges: built.edges, notes: built.network.notes });
  const alt = alternateSupplyOf(session.network, 'TX-M1');
  assert.ok(alt.lost.length > 0);
  assert.ok(!alt.lost.includes('TX-M1'));
  assert.ok(alt.options.some(o => o.switchId === 'BT-1'), 'the bus tie brings the lost loads back');
  const one = alternateSupplyOf(session.network, 'TX-M1', { targetId: alt.lost[0] });
  assert.equal(one.target.state, 'dead');
  assert.ok(one.target.restoredBy.length > 0);
  assert.equal(session.state().active, false, 'a what-if: no scenario was started');
});
