/**
 * Seagirt Marine Terminal — the electrical connectivity engine, outage scenarios, Ask the Twin's
 * deterministic tools, inventory import, and the data's integrity (real geography attributed,
 * synthetic equipment labelled and inside the terminal outline).
 *
 * Small hand-built graphs test the engine's rules in isolation; the shipped dataset tests the
 * demonstration answers (T1 offline → C1, C2, L1 lose power; T2/T3 untouched; C2's normally-open
 * alternate through TB1).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  baselineScenario, compareScenario, createNetwork, energize, findAlternativeSupplyPaths, getDownstreamAssets, getUpstreamAssets,
  STATE, SWITCH, traceSupplyPath, transformerDependence, upstreamOfType, withOutage, withSwitch,
} from '../src/seagirt/electricalGraph.js';
import { createScenarioSession } from '../src/seagirt/outageScenario.js';
import { ask, INTENT, parseQuestion, validateActions } from '../src/seagirt/askSeagirt.js';
import { applyPositions, edgesFromRows, mapRow, mergeInventory, parseCsv, positionsFromGeoJson, validateInventory } from '../src/seagirt/inventoryImport.js';
import { pointInPolygon } from '../src/seagirt/geo.js';
import { PROJECTS, projectFor } from '../src/projects.js';

const read = name => JSON.parse(readFileSync(new URL(`../public/data/seagirt/${name}`, import.meta.url), 'utf8'));
const ASSETS = read('electrical-assets.json').assets;
const EDGES = read('electrical-connectivity.json').edges;
const INSPECTIONS = read('inspections.json').records;
const GEO = read('terminal-geography.geojson');
const net = () => createNetwork({ assets: ASSETS, edges: EDGES });

// A tiny graph builder for rule tests.
const A = (id, assetType, extra = {}) => ({ id, name: id, assetType, ...extra });
const E = (from, to, extra = {}) => ({ id: `${from}-${to}`, fromAssetId: from, toAssetId: to, operationalState: 'CLOSED', ...extra });
const states = (network, scenario) => Object.fromEntries(energize(network, scenario).nodes);

describe('connectivity engine — rules', () => {
  test('1 · a single transformer supplies its consumer', () => {
    const n = createNetwork({ assets: [A('U', 'UTILITY_SUPPLY'), A('T', 'TRANSFORMER'), A('C', 'CRANE')], edges: [E('U', 'T'), E('T', 'C')] });
    assert.equal(states(n).C, STATE.ENERGIZED);
    assert.equal(upstreamOfType(n, 'C', 'TRANSFORMER'), 'T');
    assert.equal(states(n, withOutage(n, baselineScenario(), 'T')).C, STATE.DE_ENERGIZED);
  });

  test('2 · multiple downstream consumers all lose power when their only source goes', () => {
    const n = createNetwork({ assets: [A('U', 'UTILITY_SUPPLY'), A('T', 'TRANSFORMER'), A('C1', 'CRANE'), A('C2', 'CRANE'), A('W', 'WAREHOUSE')],
      edges: [E('U', 'T'), E('T', 'C1'), E('T', 'C2'), E('T', 'W')] });
    assert.deepEqual(compareScenario(n, withOutage(n, baselineScenario(), 'T')).consumersLost.sort(), ['C1', 'C2', 'W']);
  });

  test('3 · opening a breaker cuts only what it feeds; the breaker itself stays energized on its line side', () => {
    const n = createNetwork({ assets: [A('U', 'UTILITY_SUPPLY'), A('S', 'SWITCHGEAR'), A('CB1', 'CIRCUIT_BREAKER'), A('CB2', 'CIRCUIT_BREAKER'), A('C1', 'CRANE'), A('C2', 'CRANE')],
      edges: [E('U', 'S'), E('S', 'CB1'), E('S', 'CB2'), E('CB1', 'C1'), E('CB2', 'C2')] });
    const s = states(n, withOutage(n, baselineScenario(), 'CB1'));
    assert.equal(s.C1, STATE.DE_ENERGIZED);
    assert.equal(s.C2, STATE.ENERGIZED);
    assert.equal(s.CB1, STATE.ENERGIZED);
  });

  test('7 + 8 · two supply paths: losing one keeps the consumer powered; a normally-open tie stays open', () => {
    const n = createNetwork({
      assets: [A('U', 'UTILITY_SUPPLY'), A('T1', 'TRANSFORMER'), A('T2', 'TRANSFORMER'), A('TIE', 'CIRCUIT_BREAKER', { normalState: 'OPEN' }), A('C', 'CRANE')],
      edges: [E('U', 'T1'), E('U', 'T2'), E('T1', 'C'), E('T2', 'TIE'), E('TIE', 'C')],
    });
    assert.equal(states(n, withOutage(n, baselineScenario(), 'T1')).C, STATE.DE_ENERGIZED, 'the open tie does not close itself');
    const closed = withSwitch(withOutage(n, baselineScenario(), 'T1'), 'TIE', SWITCH.CLOSED);
    assert.equal(states(n, closed).C, STATE.ENERGIZED, '9 · closing the tie restores supply');
    assert.deepEqual(compareScenario(n, closed).rerouted, ['C']);
    const paths = findAlternativeSupplyPaths(n, 'C');
    assert.deepEqual(paths.map(p => [p.live, p.needsClosing]), [[true, []], [false, ['TIE']]]);
  });

  test('10 · unknown connection data makes a consumer UNKNOWN, never energized', () => {
    const n = createNetwork({ assets: [A('U', 'UTILITY_SUPPLY'), A('C', 'CRANE')], edges: [E('U', 'C', { operationalState: 'UNKNOWN' })] });
    assert.equal(states(n).C, STATE.UNKNOWN);
  });

  test('11 · missing references are reported and ignored, never crash', () => {
    const n = createNetwork({ assets: [A('U', 'UTILITY_SUPPLY'), A('C', 'CRANE', { parentAssetId: 'GHOST' }), A('C', 'CRANE')], edges: [E('U', 'X9'), E('U', 'C')] });
    assert.deepEqual(n.issues.map(i => i.kind).sort(), ['DUPLICATE_ASSET', 'MISSING_PARENT', 'MISSING_REFERENCE']);
    assert.equal(states(n).C, STATE.ENERGIZED);
  });

  test('12 · a cyclic topology terminates and is evaluated by reachability', () => {
    const n = createNetwork({ assets: [A('U', 'UTILITY_SUPPLY'), A('B1', 'SWITCHGEAR'), A('B2', 'SWITCHGEAR'), A('C', 'CRANE')],
      edges: [E('U', 'B1'), E('B1', 'B2'), E('B2', 'B1'), E('B2', 'C')] });
    assert.equal(states(n).C, STATE.ENERGIZED);
    assert.equal(states(n, withOutage(n, baselineScenario(), 'B2')).C, STATE.DE_ENERGIZED);
    assert.ok(getUpstreamAssets(n, 'C').includes('U'));
  });

  test('an outage is calculated, not inferred: a consumer below the failed asset that is fed another way stays powered', () => {
    const n = createNetwork({ assets: [A('U', 'UTILITY_SUPPLY'), A('S1', 'SWITCHGEAR'), A('S2', 'SWITCHGEAR'), A('C', 'CRANE')],
      edges: [E('U', 'S1'), E('U', 'S2'), E('S1', 'C'), E('S2', 'C')] });
    assert.ok(getDownstreamAssets(n, 'S1').some(d => d.assetId === 'C'), 'C is downstream of S1');
    assert.equal(states(n, withOutage(n, baselineScenario(), 'S1')).C, STATE.ENERGIZED, '…and still powered');
  });
});

describe('the demonstration network', () => {
  const n = net();
  const lostWith = sc => compareScenario(n, sc);

  test('loads without integrity issues', () => assert.deepEqual(n.issues, []));

  test('Scenario A · T1 offline: S1 and the T1 feeders de-energized; C1, C2 and L1 lose power; T2/T3 untouched', () => {
    const r = lostWith(withOutage(n, baselineScenario(), 'T1'));
    assert.deepEqual(r.offline, ['T1']);
    assert.deepEqual(r.consumersLost.sort(), ['C1', 'C2', 'L1']);
    assert.ok(['S1', 'CB1', 'CB2', 'CB3', 'F1', 'F2', 'F3'].every(id => r.deEnergized.includes(id)));
    for (const id of ['T2', 'T3', 'S2', 'S3', 'C3', 'C4', 'C5', 'W1', 'W2', 'EV1']) assert.equal(r.after.nodes.get(id), STATE.ENERGIZED, id);
  });

  test('Scenario A, with the T2 tie closed: C2 is fed through T2; C1 and L1 stay dark', () => {
    const r = lostWith(withSwitch(withOutage(n, baselineScenario(), 'T1'), 'TB1', SWITCH.CLOSED));
    assert.deepEqual(r.consumersLost.sort(), ['C1', 'L1']);
    assert.deepEqual(r.rerouted, ['C2']);
  });

  test('4 · Scenario C · S2 offline: C3, C4 and W1', () => assert.deepEqual(lostWith(withOutage(n, baselineScenario(), 'S2')).consumersLost.sort(), ['C3', 'C4', 'W1']));
  test('Scenario B · CB3 opened: only Crane C1', () => assert.deepEqual(lostWith(withOutage(n, baselineScenario(), 'CB3')).consumersLost, ['C1']));
  test('5 · Feeder F2 disconnected: only Crane C2', () => assert.deepEqual(lostWith(withOutage(n, baselineScenario(), 'F2')).consumersLost, ['C2']));
  test('6 · Scenario D · SS1 offline: every modelled consumer', () => {
    const r = lostWith(withOutage(n, baselineScenario(), 'SS1'));
    assert.deepEqual(r.consumersLost.sort(), ['C1', 'C2', 'C3', 'C4', 'C5', 'EV1', 'L1', 'W1', 'W2']);
    assert.deepEqual(r.consumersPowered, []);
  });

  test('connectivity questions: supply path, breaker, downstream, single-transformer cranes', () => {
    assert.equal(upstreamOfType(n, 'C1', 'TRANSFORMER'), 'T1');
    assert.equal(upstreamOfType(n, 'C2', 'CIRCUIT_BREAKER'), 'CB2');
    assert.deepEqual(traceSupplyPath(n, 'C3').path, ['MS1', 'SS1', 'T2', 'S2', 'CB4', 'F4', 'C3']);
    const dep = Object.fromEntries(transformerDependence(n, { type: 'CRANE' }).map(d => [d.assetId, d.single]));
    assert.deepEqual(dep, { C1: true, C2: false, C3: true, C4: true, C5: true });
    const s2 = getDownstreamAssets(n, 'S2');
    assert.ok(s2.find(d => d.assetId === 'C2').viaNormallyOpen, 'C2 is below S2 only through the open tie');
  });

  test('13 + 14 · reset restores the baseline exactly, and the registry is never written', () => {
    const before = JSON.stringify(ASSETS) + JSON.stringify(EDGES);
    const session = createScenarioSession({ assets: ASSETS, edges: EDGES });
    const baseline = JSON.stringify([...energize(session.network).nodes]);
    session.outage('T1');
    session.setSwitch('TB1', SWITCH.CLOSED);
    assert.equal(session.state().active, true);
    session.reset();
    assert.equal(session.state().active, false);
    assert.equal(JSON.stringify([...energize(session.network).nodes]), baseline);
    assert.equal(JSON.stringify(ASSETS) + JSON.stringify(EDGES), before, 'source data untouched');
    assert.throws(() => { session.network.assets.get('T1').condition = 'GOOD'; }, TypeError, 'registry is frozen');
  });
});

describe('Ask the Twin — further phrasings and follow-ups (the 30 acceptance questions: seagirtAskTheTwin.test.mjs)', () => {
  const run = (questions) => {
    const session = createScenarioSession({ assets: ASSETS, edges: EDGES });
    let context = {};
    return questions.map(q => {
      const r = ask(q, { network: session.network, session, inspections: INSPECTIONS, context });
      context = r.context;
      return { ...r, session };
    });
  };
  const one = q => run([q])[0];

  test('asset identification (1–4)', () => {
    assert.deepEqual(one('Where is Transformer T1?').answer.actions.map(a => a.type), ['FOCUS_ASSET']);
    assert.deepEqual(one('Show all transformers in the terminal.').answer.resultIds, ['T1', 'T2', 'T3']);
    assert.match(one('Where is Switchgear S2 located?').answer.answer.title, /Switchgear S2/);
    assert.deepEqual(one('Show all cranes connected to the electrical network.').answer.resultIds, ['C1', 'C2', 'C3', 'C4', 'C5']);
    assert.match(one('Where is CB3?').answer.answer.summary, /Inside S1, cubicle 3; no map position of its own/, 'a breaker is located by its switchgear, not by an invented point');
  });

  test('electrical connectivity (5–9)', () => {
    assert.equal(one('Which transformer supplies Crane C1?').answer.primaryAssetId, 'T1');
    assert.deepEqual(one('Show the electrical path from the main supply to Crane C3.').answer.pathAssetIds, ['MS1', 'SS1', 'T2', 'S2', 'CB4', 'F4', 'C3']);
    assert.equal(one('Which breaker controls Crane C2?').answer.primaryAssetId, 'CB2');
    assert.ok(one('What equipment is connected downstream of Switchgear S1?').answer.resultIds.includes('C1'));
    assert.match(one('Which consumers are supplied by Transformer T2?').answer.answer.summary, /Crane C3, Crane C4 and Warehouse W1/);
  });

  test('outage impact (10–14) runs the scenario and reports its computed result', () => {
    const t1 = one('What happens if Transformer T1 goes offline?');
    assert.equal(t1.answer.intent, INTENT.OUTAGE);
    assert.deepEqual(t1.session.state().result.consumersLost.sort(), ['C1', 'C2', 'L1']);
    assert.match(t1.answer.answer.lines[0], /No power: Crane C1, Crane C2 and Lighting Circuit L1/);
    assert.equal(one('Which cranes lose power if Breaker CB3 is opened?').answer.answer.title, 'Crane C1 loses power');
    assert.deepEqual(one('What happens if Switchgear S2 fails?').answer.resultIds.sort(), ['C3', 'C4', 'W1']);
    assert.deepEqual(one('Show all equipment affected by a Feeder F2 outage.').answer.resultIds, ['C2']);
    assert.equal(one('What happens if Substation SS1 loses power?').answer.resultIds.length, 9);
  });

  test('redundancy (15–17)', () => {
    const c2 = one('Does Crane C2 have an alternative power supply?').answer;
    assert.match(c2.answer.summary, /Tie Breaker TB1 is normally open and stays open unless a scenario closes it/);
    assert.match(one('Which cranes depend on a single transformer?').answer.answer.title, /4 of 5 cranes/);
    assert.match(one('What equipment remains powered if T1 is offline?').answer.answer.lines[0], /Crane C3, Crane C4, Crane C5, Warehouse W1, Warehouse W2 and Charging Station EV1/);
  });

  test('maintenance (18–20) — from the records, never composed', () => {
    assert.match(one('When was Transformer T1 last inspected?').answer.answer.summary, /2026-03-18/);
    assert.deepEqual(one('Which transformers are in poor condition?').answer.resultIds, ['T3']);
    assert.equal(one('Show the maintenance history of Switchgear S1.').answer.answer.lines.filter(l => /^\d{4}-/.test(l)).length, 3);
  });

  test('follow-ups keep the subject and the scenario context', () => {
    const r = run(['What happens if Transformer T1 goes offline?', 'What about T2?', 'Show its downstream assets.', 'Which cranes lose power if Breaker CB3 is opened?', 'Highlight those cranes.', 'Reset the simulation.']);
    assert.deepEqual(r[1].answer.resultIds.sort(), ['C3', 'C4', 'W1'], '"What about T2?" repeats the outage for T2');
    assert.equal(r[2].parsed.subject, 'T2');
    assert.deepEqual(r[4].answer.resultIds, ['C1']);
    assert.equal(r[5].session.state().active, false);
  });

  test('nothing is invented: an unknown asset or question is said to be unknown', () => {
    assert.match(one('Where is X9?').answer.answer.summary, /not in the Seagirt electrical inventory/);
    assert.equal(one('What is the weather tomorrow?').answer.intent, INTENT.UNKNOWN);
    const network = net();
    assert.deepEqual(validateActions([{ type: 'FOCUS_ASSET', assetId: 'NOPE' }, { type: 'HIGHLIGHT_ASSETS', assetIds: ['CB1'] }], network).ok.map(a => a.type), ['HIGHLIGHT_ASSETS']);
    assert.equal(parseQuestion('Which breaker controls Crane C2?', network).upstreamType, 'CIRCUIT_BREAKER');
  });
});

describe('data integrity and provenance', () => {
  const outline = GEO.features.find(f => f.properties.layer === 'boundary');

  test('real geography is attributed to OpenStreetMap; the outline is labelled approximate', () => {
    for (const f of GEO.features) {
      assert.equal(f.properties.source, 'OpenStreetMap', f.id);
      assert.equal(f.properties.dataProvenance, 'IMPORTED_GIS', f.id);
    }
    assert.match(outline.properties.note, /Approximate/);
    assert.match(GEO.features.find(f => f.properties.layer === 'osmSubstation').properties.note, /CANDIDATE, unverified match for the illustrative Substation SS1 — not a confirmed part of the demonstration network/);
  });

  test('every synthetic asset is labelled synthetic and unverified; every positioned one lies inside the terminal', () => {
    for (const a of ASSETS) {
      assert.equal(a.dataProvenance, 'SYNTHETIC_DEMO', a.id);
      assert.equal(a.verificationStatus, 'UNVERIFIED', a.id);
      assert.equal(a.projectId, 'seagirt');
      if (Number.isFinite(a.location.longitude)) {
        assert.ok(pointInPolygon([a.location.longitude, a.location.latitude], outline.geometry.coordinates), `${a.id} inside the outline`);
        assert.match(a.location.positionNote, /Illustrative/);
      }
    }
    for (const r of [...EDGES, ...INSPECTIONS]) assert.equal(r.dataProvenance, 'SYNTHETIC_DEMO');
  });

  test('breakers have no map position of their own: they are inside a switchgear cubicle', () => {
    for (const a of ASSETS.filter(x => x.assetType === 'CIRCUIT_BREAKER')) {
      assert.equal(a.location.longitude, null, a.id);
      assert.ok(a.location.containerAssetId && a.location.cubicle, a.id);
    }
  });

  test('connectivity is its own dataset, not inferred from names', () => {
    assert.ok(EDGES.every(e => e.fromAssetId && e.toAssetId && e.connectionType === 'ELECTRICAL'));
    assert.ok(EDGES.some(e => e.id === 'EDGE-TB1-F2A') && ASSETS.find(a => a.id === 'TB1').normalState === 'OPEN');
  });

  test('15 · project isolation: Seagirt is its own registered project with its own page and data', () => {
    const p = projectFor('?demo=seagirt');
    assert.equal(p.id, 'seagirt');
    assert.equal(p.synthetic, true);
    assert.equal(PROJECTS.filter(x => x.id === 'seagirt').length, 1);
    assert.equal(projectFor('?demo=i595').id, 'i595');
  });
});

describe('inventory import (future Kimley-Horn data)', () => {
  test('CSV with quotes, a field map, and validation that names every problem', () => {
    const rows = parseCsv('Asset ID,Description,Type,Parent,Lon,Lat,Source\nT9,"Transformer, north",transformer,SS1,-76.548,39.257,VERIFIED_DRAWING\nT9,dup,TRANSFORMER,,,,\nX1,Bad,ROBOT,NOPE,500,99,SYNTHETIC_DEMO\n');
    const assets = rows.map(r => mapRow(r));
    assert.equal(assets[0].name, 'Transformer, north');
    assert.equal(assets[0].assetType, 'TRANSFORMER');
    const { errors, warnings } = validateInventory({ assets, edges: edgesFromRows([{ from: 'T9', to: 'C99' }]) });
    const kinds = errors.map(e => e.kind);
    for (const k of ['DUPLICATE_ID', 'UNKNOWN_TYPE', 'MISSING_PARENT', 'INVALID_COORDINATE', 'MISSING_REFERENCE']) assert.ok(kinds.includes(k), k);
    assert.ok(warnings.some(w => w.kind === 'PROVENANCE_STATUS'));
  });

  test('a verified record is never overwritten by a synthetic or unverified one', () => {
    const verified = { id: 'T1', dataProvenance: 'VERIFIED_SURVEY', verificationStatus: 'VERIFIED' };
    const { assets, report } = mergeInventory([verified], [{ id: 'T1', dataProvenance: 'SYNTHETIC_DEMO' }, { id: 'T7', dataProvenance: 'MANUALLY_ENTERED' }]);
    assert.equal(assets.find(a => a.id === 'T1').dataProvenance, 'VERIFIED_SURVEY');
    assert.equal(report.refused.length, 1);
    assert.deepEqual(report.added, ['T7']);
    const replaced = mergeInventory([{ id: 'T1', dataProvenance: 'SYNTHETIC_DEMO' }], [verified]);
    assert.deepEqual(replaced.report.replaced, ['T1'], 'verified data replaces synthetic');
  });

  test('geometry updates apart from metadata, from GeoJSON', () => {
    const positions = positionsFromGeoJson({ features: [{ type: 'Feature', properties: { id: 'T1' }, geometry: { type: 'Point', coordinates: [-76.546, 39.256] } }] });
    const { assets, report } = applyPositions(ASSETS, positions);
    assert.deepEqual(report.moved, ['T1']);
    const t1 = assets.find(a => a.id === 'T1');
    assert.equal(t1.location.longitude, -76.546);
    assert.equal(t1.name, 'Transformer T1', 'metadata untouched');
    assert.equal(t1.locationProvenance, 'IMPORTED_GIS');
  });
});
