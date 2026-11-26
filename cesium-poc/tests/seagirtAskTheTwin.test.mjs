/**
 * Seagirt — the 30 Kimley-Horn acceptance questions (AskTheTwin.rtf), asked verbatim.
 *
 * A question passes only when the whole result is right, not just its text: the intent, the assets
 * it resolves to, the filtering, the traversal, the scenario it ran, the camera targets, provenance
 * and limitations — and what the MAP draws, checked on the same view model the Cesium layer and the
 * single-line diagram render (`buildViewModel`): which links animate, which are cut, which are
 * conditional, which feeders are labelled, which assets are emphasized or dimmed.
 *
 * The browser half (`e2e/seagirt.spec.ts`) asks the same questions on the live page and checks the
 * drawn entities, the single panel and that no stale selection survives.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createScenarioSession } from '../src/seagirt/outageScenario.js';
import { energize, SWITCH } from '../src/seagirt/electricalGraph.js';
import { ACTION, anchorsOf, ask, INTENT, investigate, validateResult } from '../src/seagirt/askSeagirt.js';
import { buildViewModel, focusOf, schematicLinks } from '../src/seagirt/viewModel.js';
import { assetProvenance } from '../src/seagirt/provenance.js';
import { singleLineLayout } from '../src/seagirt/singleLine.js';
import { QUESTION_BANK } from '../src/seagirt/questionBank.js';

const read = name => JSON.parse(readFileSync(new URL(`../public/data/seagirt/${name}`, import.meta.url), 'utf8'));
const ASSETS = read('electrical-assets.json').assets;
const EDGES = read('electrical-connectivity.json').edges;
const INSPECTIONS = read('inspections.json').records;
const ASSOCIATIONS = read('gis-associations.json').associations;
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/seagirt-ask-the-twin-questions.json', import.meta.url), 'utf8'));
const QUESTIONS = FIXTURE.categories.flatMap(c => c.questions);
const TODAY = '2026-11-23';

/** Ask on a fresh session and return the validated result and the view model the map would draw. */
function run(question, { context = {}, session = createScenarioSession({ assets: ASSETS, edges: EDGES }) } = {}) {
  const { parsed, answer, context: next } = ask(question, { network: session.network, session, inspections: INSPECTIONS, associations: ASSOCIATIONS, context, today: TODAY });
  const { result, dropped, droppedActions } = validateResult(answer, session.network);
  const vm = buildViewModel({ network: session.network, links: schematicLinks(session.network), baseline: energize(session.network),
    scenario: session.state().active ? session.state().result : null, view: { mode: 'overview', focus: focusOf(result) } });
  return { parsed, r: result, raw: answer, dropped, droppedActions, vm, session, context: next };
}
const Q = n => QUESTIONS[n - 1];
const link = (vm, id) => vm.links.get(id).kind;
const shown = vm => [...vm.links].filter(([, l]) => l.kind !== 'hidden').map(([id]) => id).sort();
const role = (vm, id) => vm.assets.get(id).role;
const text = r => [r.answer.title, r.answer.summary, r.answer.explanation, ...r.answer.lines, ...r.answer.determinable].join(' ');
const group = (r, key) => r.resultGroups.find(g => g.key === key)?.assetIds;
const positioned = id => Number.isFinite(ASSETS.find(a => a.id === id)?.location?.longitude);

describe('the question set', () => {
  test('30 questions in six categories, and the in-app question bank is the same text', () => {
    assert.equal(QUESTIONS.length, 30);
    assert.equal(FIXTURE.categories.length, 6);
    assert.deepEqual(QUESTION_BANK.map(c => ({ name: c.name, questions: c.questions })), FIXTURE.categories);
  });

  test('every question resolves to a valid, drawable result (no unknown ids, no unsupported answer)', () => {
    for (const q of QUESTIONS) {
      const { r, dropped, droppedActions } = run(q);
      assert.notEqual(r.intent, INTENT.UNKNOWN, q);
      assert.notEqual(r.status, 'UNSUPPORTED', q);
      assert.deepEqual(dropped, [], q);
      assert.deepEqual(droppedActions, [], q);
      assert.ok(r.actions.length, `${q}: declares map actions`);
      assert.ok(r.answer.title && r.answer.summary, `${q}: has an answer`);
      assert.ok(r.cameraTargetAssetIds.length, `${q}: has camera targets`);
      assert.ok(r.cameraTargetAssetIds.every(positioned), `${q}: camera targets are drawn on the map`);
      assert.ok(r.provenance?.identity, `${q}: states provenance`);
      for (const p of r.paths) assert.equal(p.edgeIds.length, p.assetIds.length - 1, `${q}: path runs along recorded edges`);
    }
  });
});

describe('1 · Electrical asset identification and location', () => {
  test('Q1 locates T1, highlights it alone and says the position is illustrative', () => {
    const { r, vm } = run(Q(1));
    assert.equal(r.intent, INTENT.LOCATE);
    assert.equal(r.primaryAssetId, 'T1');
    assert.deepEqual(r.targetAssetIds, ['T1']);
    assert.deepEqual(r.actions.map(a => a.type), [ACTION.FOCUS_ASSET]);
    assert.deepEqual(r.cameraTargetAssetIds, ['T1']);
    assert.match(r.answer.summary, /Illustrative position, not a surveyed location/);
    assert.equal(role(vm, 'T1'), 'target');
    assert.equal(vm.assets.get('C1').dimmed, true, 'unrelated equipment is dimmed');
    assert.deepEqual(shown(vm), [], 'no network lines for a location question');
    assert.equal(r.provenance.location, 'ILLUSTRATIVE');
  });

  test('Q2 returns exactly T1, T2 and T3 and does not call the synthetic inventory verified', () => {
    const { r, vm } = run(Q(2));
    assert.equal(r.intent, INTENT.LIST);
    assert.deepEqual(r.targetAssetIds, ['T1', 'T2', 'T3']);
    assert.deepEqual(r.resultGroups.map(g => [g.key, g.assetIds.length]), [['TRANSFORMER', 3]]);
    assert.deepEqual(r.cameraTargetAssetIds, ['T1', 'T2', 'T3']);
    assert.ok(['T1', 'T2', 'T3'].every(id => role(vm, id) === 'target'));
    assert.equal(vm.assets.get('C1').dimmed, true);
    assert.match(r.answer.limitations.join(' '), /not a verified list/);
  });

  test('Q3 finds S2 downstream of T2 and draws the T2 → S2 connection only', () => {
    const { r, vm } = run(Q(3));
    assert.equal(r.intent, INTENT.RELATED);
    assert.deepEqual(r.targetAssetIds, ['S2']);
    assert.deepEqual(r.relatedAssetIds, ['T2']);
    assert.deepEqual(r.paths.map(p => p.assetIds), [['T2', 'S2']]);
    assert.deepEqual(r.pathEdgeIds, ['EDGE-T2-S2']);
    assert.match(r.answer.summary, /T2 → S2, direction of supply/);
    assert.equal(link(vm, 'LINK-T2-S2'), 'flow');
    assert.deepEqual(shown(vm), ['LINK-T2-S2']);
  });

  test('Q4 (regression) returns the substation AND the distribution panel, with location provenance', () => {
    const { r, vm } = run(Q(4));
    assert.equal(r.intent, INTENT.LIST);
    assert.deepEqual(r.targetAssetIds, ['SS1', 'DP3']);
    assert.deepEqual(r.resultGroups.map(g => [g.key, g.assetIds]), [['SUBSTATION', ['SS1']], ['DISTRIBUTION_PANEL', ['DP3']]]);
    assert.deepEqual(r.cameraTargetAssetIds, ['SS1', 'DP3']);
    assert.match(r.answer.lines[0], /candidate OSM footprint 132 m away, unverified/);
    assert.match(r.answer.lines[1], /illustrative position/);
    assert.deepEqual(r.provenance.candidateAssociations, ['SS1']);
    assert.equal(role(vm, 'SS1'), 'target');
    assert.equal(role(vm, 'DP3'), 'target');
  });

  test('Q5 returns all five cranes with their modelled electrical state, not just condition', () => {
    const { r } = run(Q(5));
    assert.deepEqual(r.targetAssetIds, ['C1', 'C2', 'C3', 'C4', 'C5']);
    assert.equal(r.answer.lines.length, 5);
    assert.ok(r.answer.lines.every(l => / — energized/.test(l)), 'each crane shows its electrical state');
    assert.deepEqual(r.energizedAssetIds.sort(), ['C1', 'C2', 'C3', 'C4', 'C5']);
  });
});

describe('2 · Electrical connectivity and network tracing', () => {
  test('Q6 identifies T1, traces the energized path to C1 and names CB3 › F3 on the map', () => {
    const { r, vm } = run(Q(6));
    assert.equal(r.intent, INTENT.UPSTREAM_TYPE);
    assert.equal(r.primaryAssetId, 'T1');
    assert.deepEqual(r.targetAssetIds, ['T1', 'C1']);
    assert.deepEqual(r.pathAssetIds, ['MS1', 'SS1', 'T1', 'S1', 'CB3', 'F3', 'C1']);
    assert.deepEqual(r.pathEdgeIds, ['EDGE-MS1-SS1', 'EDGE-SS1-T1', 'EDGE-T1-S1', 'EDGE-S1-CB3', 'EDGE-CB3-F3', 'EDGE-F3-C1']);
    assert.deepEqual(r.feederIds, ['F3']);
    for (const id of ['LINK-MS1-SS1', 'LINK-SS1-T1', 'LINK-T1-S1', 'LINK-S1-C1']) assert.equal(link(vm, id), 'flow', id);
    assert.equal(vm.links.get('LINK-S1-C1').emphasis, 'strong');
    assert.deepEqual(shown(vm), ['LINK-MS1-SS1', 'LINK-S1-C1', 'LINK-SS1-T1', 'LINK-T1-S1']);
    assert.equal(vm.feeders.get('F3').show, true);
    assert.equal(vm.feeders.get('F3').text, 'CB3 › F3');
    assert.ok(['C1', 'T1', 'MS1', 'SS1', 'S1'].every(id => r.cameraTargetAssetIds.includes(id)));
  });

  test('Q7 shows MS1 → SS1 → T2 → S2 → CB4 → F4 → C3 with F4 and CB4 inspectable', () => {
    const { r, vm, session } = run(Q(7));
    assert.equal(r.intent, INTENT.PATH);
    assert.deepEqual(r.pathAssetIds, ['MS1', 'SS1', 'T2', 'S2', 'CB4', 'F4', 'C3']);
    assert.equal(r.pathEdgeIds.length, 6);
    assert.equal(vm.feeders.get('F4').text, 'CB4 › F4');
    // Inspectable on the map: the feeder by its segment's two ends, the breaker by its switchgear.
    assert.deepEqual(anchorsOf(session.network, 'F4'), ['S2', 'C3']);
    assert.deepEqual(anchorsOf(session.network, 'CB4'), ['S2']);
    assert.ok(['MS1', 'SS1', 'T2', 'S2', 'C3'].every(id => r.cameraTargetAssetIds.includes(id)), 'the whole path is framed');
    assert.equal(link(vm, 'LINK-S2-C3'), 'flow');
    assert.equal(link(vm, 'LINK-S1-C1'), 'hidden');
  });

  test('Q8 finds CB6 from the graph, with feeder F6 and the upstream / downstream relationships', () => {
    const { r, vm } = run(Q(8));
    assert.equal(r.primaryAssetId, 'CB6');
    assert.deepEqual(r.targetAssetIds, ['CB6', 'W1']);
    assert.deepEqual(r.feederIds, ['F6']);
    assert.ok(r.answer.lines.some(l => /^Breaker: CB6 in Switchgear S2, cubicle 3/.test(l)));
    assert.ok(r.answer.lines.includes('Feeder: F6'));
    assert.ok(r.answer.lines.includes('Upstream: S2 ← T2 ← SS1 ← MS1'));
    assert.ok(r.answer.lines.includes('Downstream: F6 → W1'));
    assert.equal(link(vm, 'LINK-S2-W1'), 'flow');
    assert.equal(vm.feeders.get('F6').text, 'CB6 › F6');
    assert.ok(r.cameraTargetAssetIds.includes('S2'), 'the breaker is framed by its switchgear');
  });

  test('Q9 separates what S2 normally supplies from what only the open tie TB1 reaches', () => {
    const { r, vm } = run(Q(9));
    assert.equal(r.intent, INTENT.DOWNSTREAM);
    assert.deepEqual(group(r, 'normal'), ['CB4', 'CB5', 'CB6', 'F4', 'F5', 'F6', 'C3', 'C4', 'W1']);
    assert.deepEqual(group(r, 'open'), ['TB1']);
    assert.deepEqual(group(r, 'conditional'), ['F2A', 'C2']);
    assert.deepEqual(r.conditionalAssetIds, ['TB1', 'F2A', 'C2']);
    assert.equal(link(vm, 'LINK-S2-C3'), 'flow');
    assert.equal(link(vm, 'LINK-S2-C2'), 'conditional', 'the tie path is drawn as conditional, never as live flow');
    assert.equal(link(vm, 'LINK-S1-C1'), 'hidden');
    assert.equal(role(vm, 'C2'), 'conditional');
    assert.equal(vm.assets.get('C2').label, 'C2 · VIA OPEN TIE');
    assert.match(r.answer.explanation, /not supplied from Switchgear S2 unless TB1 is closed/);
  });

  test('Q10 (regression) counts only transformers, breakers and feeders below SS1, not all 35 downstream assets', () => {
    const { r, vm } = run(Q(10));
    assert.equal(r.intent, INTENT.DOWNSTREAM);
    assert.deepEqual(r.resultGroups.map(g => [g.key, g.assetIds.length]), [['TRANSFORMER', 3], ['CIRCUIT_BREAKER', 9], ['FEEDER', 9]]);
    assert.match(r.answer.title, /^21 transformers, circuit breakers and feeders/);
    assert.match(r.answer.explanation, /35 downstream assets in total; the other 14/);
    assert.ok(r.targetAssetIds.every(id => ['T', 'C', 'F'].includes(id[0]) && !/^C\d$/.test(id)), 'no consumers or switchgear in the targets');
    assert.deepEqual(r.answer.followUps.map(f => f.label), ['Expand all downstream equipment']);
    assert.equal(role(vm, 'T1'), 'target');
    assert.equal(role(vm, 'C3'), 'context', 'consumers are shown for context, not emphasized');
    assert.equal(link(vm, 'LINK-SS1-T1'), 'flow');
    assert.equal(link(vm, 'LINK-S2-C2'), 'conditional');
    assert.ok([...vm.feeders.values()].every(f => f.show), 'every feeder is labelled');
  });
});

describe('3 · Power outage and failure impact', () => {
  test('Q11 runs the T1 outage: C1, C2 and L1 lose power; T2 and T3 paths stay energized', () => {
    const { r, vm, session } = run(Q(11));
    assert.equal(r.intent, INTENT.OUTAGE);
    assert.deepEqual(r.actions.map(a => a.type), [ACTION.RUN_OUTAGE, ACTION.SHOW_OUTAGE_IMPACT]);
    assert.deepEqual(session.state().result.consumersLost.sort(), ['C1', 'C2', 'L1']);
    assert.deepEqual(group(r, 'lost'), ['C1', 'C2', 'L1']);
    assert.equal(vm.assets.get('T1').ring, 'OFFLINE');
    for (const id of ['C1', 'C2', 'L1', 'S1']) assert.equal(vm.assets.get(id).ring, 'NO_POWER', id);
    for (const id of ['T2', 'T3', 'C3', 'C5', 'W2']) assert.equal(vm.assets.get(id).ring, 'ENERGIZED', id);
    for (const id of ['LINK-T1-S1', 'LINK-S1-C1', 'LINK-S1-C2', 'LINK-S1-L1']) assert.equal(link(vm, id), 'lost', id);
    for (const id of ['LINK-SS1-T2', 'LINK-S2-C3', 'LINK-S3-C5']) assert.equal(link(vm, id), 'live', id);
    assert.equal(link(vm, 'LINK-S2-C2'), 'open');
    assert.equal(vm.assets.get('C1').label, 'C1 · NO POWER');
    assert.match(r.answer.limitations.join(' '), /not the live operational state/);
  });

  test('Q12 opens CB4: only Crane C3 loses power, the other cranes are named as unaffected', () => {
    const { r, vm } = run(Q(12));
    assert.equal(r.answer.title, 'Crane C3 loses power');
    assert.deepEqual(group(r, 'lost'), ['C3']);
    assert.deepEqual(group(r, 'powered'), ['C1', 'C2', 'C4', 'C5']);
    assert.equal(link(vm, 'LINK-S2-C3'), 'lost');
    assert.equal(vm.assets.get('C4').ring, 'ENERGIZED');
  });

  test('Q13 fails S1 and reports by the requested categories, zero counts included', () => {
    const { r } = run(Q(13));
    assert.deepEqual(r.resultGroups.map(g => [g.key, g.assetIds]), [['BUILDING', []], ['LIGHTING_CIRCUIT', ['L1']], ['CRANE', ['C1', 'C2']]]);
    assert.match(r.answer.title, /0 buildings, 1 lighting circuit and 2 cranes affected/);
    assert.match(r.answer.summary, /normally supplied through Switchgear S1/);
  });

  test('Q14 disconnects F2: the feeder segment is cut and labelled, and C2 loses power', () => {
    const { r, vm, session } = run(Q(14));
    assert.equal(session.state().label, 'Feeder F2 disconnected');
    assert.deepEqual(r.targetAssetIds, ['F2', 'C2']);
    assert.equal(link(vm, 'LINK-S1-C2'), 'lost');
    assert.equal(vm.feeders.get('F2').text, 'F2 · DISCONNECTED');
    assert.equal(vm.feeders.get('F2').style, 'focus');
    assert.equal(vm.assets.get('C2').label, 'C2 · NO POWER');
    assert.match(r.answer.title, /1 consumer loses power/);
  });

  test('Q15 takes SS1 offline: every consumer and all 24 items of downstream equipment, grouped', () => {
    const { r } = run(Q(15));
    assert.deepEqual(group(r, 'lost').sort(), ['C1', 'C2', 'C3', 'C4', 'C5', 'EV1', 'L1', 'W1', 'W2']);
    assert.ok(['T1', 'T2', 'T3', 'S1', 'S2', 'S3', 'DP3'].every(id => group(r, 'equipment').includes(id)));
    assert.match(r.answer.title, /9 consumers and 24 items of equipment lose power/);
    assert.equal(group(r, 'powered'), undefined, 'nothing stays powered');
    assert.ok(r.cameraTargetAssetIds.length >= 15, 'the camera fits the whole affected network');
  });
});

describe('4 · Redundancy and alternative supply', () => {
  test('Q16 shows C2’s normal T1 path and its normally-open alternate through T2 and TB1', () => {
    const { r, vm } = run(Q(16));
    assert.equal(r.intent, INTENT.ALTERNATES);
    assert.deepEqual(r.paths.map(p => [p.style, p.assetIds.join('>')]), [['normal', 'MS1>SS1>T1>S1>CB2>F2>C2'], ['alternate', 'MS1>SS1>T2>S2>TB1>F2A>C2']]);
    assert.deepEqual(r.conditionalAssetIds, ['TB1', 'F2A'], 'T2 and S2 are normally energized, not conditional');
    assert.equal(link(vm, 'LINK-S1-C2'), 'flow');
    assert.equal(link(vm, 'LINK-S2-C2'), 'conditional');
    assert.notEqual(role(vm, 'T2'), 'conditional');
    assert.match(r.answer.summary, /Tie Breaker TB1 is normally open and stays open unless a scenario closes it/);
    assert.match(r.answer.explanation, /would parallel the T1 and T2 branches/);
    assert.match(r.answer.limitations[0], /not a verified, usable backup/);
  });

  test('Q17 simulates T1 failing and closing TB1: C2 restored from T2, C1 and L1 still dark', () => {
    const { r, vm, session } = run(Q(17));
    assert.equal(r.intent, INTENT.TRANSFER);
    assert.equal(session.state().scenario.switches.TB1, SWITCH.CLOSED);
    assert.deepEqual(session.state().result.consumersLost.sort(), ['C1', 'L1']);
    assert.deepEqual(session.state().result.rerouted, ['C2']);
    assert.deepEqual(group(r, 'restored'), ['C2']);
    assert.deepEqual(group(r, 'still'), ['C1', 'L1']);
    assert.deepEqual(r.paths.map(p => [p.style, p.assetIds.join('>')]), [['restored', 'MS1>SS1>T2>S2>TB1>F2A>C2']]);
    assert.equal(link(vm, 'LINK-S2-C2'), 'live');
    assert.equal(vm.links.get('LINK-S2-C2').emphasis, 'strong', 'the restored path is the strong line');
    assert.equal(link(vm, 'LINK-T1-S1'), 'lost');
    assert.equal(vm.assets.get('C2').label, 'C2 · ALTERNATE SUPPLY');
    assert.match(r.answer.explanation, /connectivity, not feasibility/);
  });

  test('Q18 finds the single-path assets, the common points of failure, and C2’s second path', () => {
    const { r } = run(Q(18));
    assert.match(r.answer.title, /^35 of 36 supplied assets have a single supply path/);
    assert.deepEqual(group(r, 'common'), ['MS1', 'SS1']);
    assert.deepEqual(group(r, 'redundant'), ['C2']);
    assert.ok(group(r, 'T1').includes('C1') && group(r, 'T2').includes('C3') && group(r, 'T3').includes('W2'));
    assert.match(r.answer.explanation, /^Scope:/);
  });

  test('Q19 shows the four single-transformer cranes and draws each dependency', () => {
    const { r, vm } = run(Q(19));
    assert.deepEqual(r.targetAssetIds, ['C1', 'C3', 'C4', 'C5']);
    assert.deepEqual(group(r, 'alternate'), ['C2']);
    assert.equal(link(vm, 'LINK-S1-C1'), 'flow');
    assert.equal(link(vm, 'LINK-S2-C2'), 'conditional');
    assert.equal(link(vm, 'LINK-MS1-SS1'), 'hidden', 'the dependency is drawn from each transformer down');
  });

  test('Q20 says plainly that no modelled feeder can supply W2, and invents none', () => {
    const { r, vm } = run(Q(20));
    assert.equal(r.status, 'NO_RESULTS');
    assert.match(r.answer.title, /No modelled alternative feeder for Warehouse W2/);
    assert.match(r.answer.summary, /only through F8 \(S3 → CB8 → F8 → DP3 → W2\)/);
    assert.deepEqual(r.feederIds, ['F8']);
    assert.equal(link(vm, 'LINK-S3-DP3'), 'flow');
    assert.equal(link(vm, 'LINK-DP3-W2'), 'flow');
  });
});

describe('5 · Condition, inspection and maintenance', () => {
  test('Q21 reads T3’s last inspection and condition from the records, marked synthetic', () => {
    const { r } = run(Q(21));
    assert.equal(r.intent, INTENT.INSPECTION);
    assert.equal(r.answer.title, 'Transformer T3 last inspected 2025-10-07 — poor condition');
    assert.ok(r.answer.lines.includes('Next inspection due 2026-10-07 — overdue by 47 days (as of 2026-11-23)'));
    assert.equal(r.provenance.records, 'SYNTHETIC_DEMO');
    assert.match(r.answer.limitations[0], /synthetic demonstration data/);
  });

  test('Q22 compares due dates with today: T3 is 47 days overdue, T1 and T2 are not', () => {
    const { r } = run(Q(22));
    assert.deepEqual(r.targetAssetIds, ['T3']);
    assert.deepEqual(group(r, 'overdue'), ['T3']);
    assert.deepEqual(group(r, 'current'), ['T1', 'T2']);
    assert.match(r.answer.summary, /due 2026-10-07, 47 days overdue/);
  });

  test('Q23 returns a clear zero result and keeps condition apart from energization', () => {
    const { r } = run(Q(23));
    assert.equal(r.status, 'NO_RESULTS');
    assert.deepEqual(r.targetAssetIds, []);
    assert.deepEqual(r.relatedAssetIds, ['S1', 'S2', 'S3']);
    assert.ok(r.answer.lines.includes('S3 — fair · inspected 2026-02-14 · electrically energized'));
    assert.match(r.answer.explanation, /independent of whether the equipment is energized/);
  });

  test('Q24 says replacement planning data is unavailable rather than inventing dates', () => {
    const { r } = run(Q(24));
    assert.equal(r.status, 'DATA_UNAVAILABLE');
    assert.deepEqual(r.targetAssetIds, []);
    assert.match(r.answer.title, /No replacement-planning data/);
    assert.doesNotMatch(`${r.answer.title} ${r.answer.summary}`, /\d{4}-\d{2}-\d{2}/, 'no dates are composed');
  });

  test('Q25 opens CB5 in S2 and distinguishes no records from unavailable work orders', () => {
    const { r } = run(Q(25));
    assert.equal(r.primaryAssetId, 'CB5');
    assert.deepEqual(r.relatedAssetIds, ['S2']);
    assert.deepEqual(r.cameraTargetAssetIds, ['S2']);
    assert.equal(r.status, 'NO_RESULTS');
    assert.ok(r.answer.lines.some(l => /^Open work orders: not available/.test(l)));
    assert.ok(r.answer.lines.some(l => /^Equipment: in Switchgear S2, cubicle 2 · 1200 A · normally closed · feeds F5 → C4/.test(l)));
  });
});

describe('6 · Advanced engineering — determinable facts, stated gaps, nothing invented', () => {
  const NO_NUMBERS = /\b\d+(\.\d+)?\s*(%|kA|V\b|volts?)|utili[sz]ation of \d/i;

  test('Q26 gives T1’s rating but no load or utilization', () => {
    const { r } = run(Q(26));
    assert.equal(r.status, 'LIMITED');
    assert.match(r.answer.title, /current load is not available/);
    assert.ok(r.answer.determinable.includes('Rating: 5 MVA (illustrative record)'));
    assert.match(r.answer.missingInputs[0], /Metered or SCADA load for T1/);
    assert.doesNotMatch(text(r), NO_NUMBERS);
  });

  test('Q27 highlights F3 and its upstream path and names the inputs a capacity check needs', () => {
    const { r, vm } = run(Q(27));
    assert.deepEqual(r.pathAssetIds, ['MS1', 'SS1', 'T1', 'S1', 'CB3', 'F3', 'C1']);
    assert.deepEqual(r.targetAssetIds, ['F3']);
    assert.equal(vm.feeders.get('F3').style, 'focus');
    assert.match(r.answer.missingInputs.join(' '), /new crane’s demand/);
    assert.match(r.answer.missingInputs.join(' '), /F3 conductor size and ampacity/);
    assert.doesNotMatch(text(r), NO_NUMBERS);
  });

  test('Q28 traces the path to C4 and lists the impedance, length and load data it lacks', () => {
    const { r } = run(Q(28));
    assert.deepEqual(r.pathAssetIds, ['MS1', 'SS1', 'T2', 'S2', 'CB5', 'F5', 'C4']);
    assert.match(r.answer.missingInputs[0], /F5 conductor size, impedance/);
    assert.doesNotMatch(text(r).replace('4.16 kV', ''), NO_NUMBERS);
  });

  test('Q29 finds no modelled T2 → T3 transfer path and does not claim capacity is sufficient', () => {
    const { r } = run(Q(29));
    assert.deepEqual(r.targetAssetIds, ['T2', 'T3']);
    assert.deepEqual(group(r, 'transfer'), []);
    assert.match(r.answer.summary, /no connection to T3/);
    assert.doesNotMatch(text(r), /sufficient capacity|will not overload|no overload/i);
    assert.deepEqual(r.answer.followUps.map(f => f.question), ['What happens if Transformer T2 goes offline?']);
  });

  test('Q30 highlights the breakers by switchgear and invents no fault currents or violations', () => {
    const { r } = run(Q(30));
    assert.deepEqual(r.targetAssetIds.length, 9);
    assert.deepEqual(r.relatedAssetIds, ['S1', 'S2', 'S3']);
    assert.deepEqual(r.cameraTargetAssetIds, ['S1', 'S2', 'S3']);
    assert.match(r.answer.summary, /No fault currents are invented/);
    assert.doesNotMatch(text(r), /\d+(\.\d+)?\s*kA/);
  });
});

describe('selection, follow-ups and stale state', () => {
  test('a new question replaces the last one completely: the C3 path carries nothing of T1', () => {
    const session = createScenarioSession({ assets: ASSETS, edges: EDGES });
    const first = run(Q(1), { session });
    const second = run(Q(7), { session, context: first.context });
    assert.equal(second.r.primaryAssetId, 'C3');
    assert.ok(!second.r.targetAssetIds.includes('T1') && !second.r.relatedAssetIds.includes('T1'));
    assert.equal(second.vm.assets.get('T1').dimmed, true);
  });

  test('a baseline question clears a running simulation, and says so', () => {
    const session = createScenarioSession({ assets: ASSETS, edges: EDGES });
    run(Q(11), { session });
    const { r } = run(Q(6), { session });
    assert.equal(session.state().active, false);
    assert.ok(r.answer.lines.includes('The simulated outage was cleared to answer this from the baseline network.'));
  });

  test('an unknown asset leaves nothing to highlight', () => {
    const { r, vm } = run('Where is Transformer T9?');
    assert.equal(r.status, 'NOT_FOUND');
    assert.deepEqual(r.targetAssetIds, []);
    assert.deepEqual(r.cameraTargetAssetIds, []);
    assert.ok([...vm.assets.values()].every(a => !a.dimmed && a.role === null));
  });

  test('validation removes unknown ids and paths that do not follow recorded edges', () => {
    const network = createScenarioSession({ assets: ASSETS, edges: EDGES }).network;
    const { result, dropped, droppedActions } = validateResult({
      targetAssetIds: ['T1', 'NOPE'], relatedAssetIds: [], contextAssetIds: [], conditionalAssetIds: [], feederIds: [], cameraTargetAssetIds: ['T1'], primaryAssetId: 'NOPE',
      paths: [{ assetIds: ['MS1', 'C1'], edgeIds: [] }, { assetIds: ['T2', 'S2'], edgeIds: ['EDGE-T2-S2'] }], downstream: null, resultGroups: [],
      actions: [{ type: ACTION.SHOW_SUPPLY_PATH, assetIds: ['MS1', 'C1'] }, { type: ACTION.FOCUS_ASSET, assetId: 'T1' }],
    }, network);
    assert.deepEqual(result.targetAssetIds, ['T1']);
    assert.equal(result.primaryAssetId, null);
    assert.deepEqual(result.paths.map(p => p.assetIds), [['T2', 'S2']]);
    assert.deepEqual(dropped, ['NOPE']);
    assert.deepEqual(result.actions.map(a => a.type), [ACTION.FOCUS_ASSET]);
    assert.equal(droppedActions[0].reason, 'path does not follow recorded connections');
  });
});

describe('feeders are first-class network assets', () => {
  const session = createScenarioSession({ assets: ASSETS, edges: EDGES });
  const network = session.network;
  const links = schematicLinks(network);

  test('each feeder is exactly one selectable schematic segment, with its breaker', () => {
    const feeders = ASSETS.filter(a => a.assetType === 'FEEDER').map(a => a.id).sort();
    assert.deepEqual(links.filter(l => l.feederId).map(l => l.feederId).sort(), feeders);
    const f3 = links.find(l => l.feederId === 'F3');
    assert.deepEqual([f3.fromAssetId, f3.toAssetId, f3.breakerId], ['S1', 'C1', 'CB3']);
    const f2a = links.find(l => l.feederId === 'F2A');
    assert.deepEqual([f2a.fromAssetId, f2a.toAssetId, f2a.breakerId, f2a.normallyOpen], ['S2', 'C2', 'TB1', true]);
  });

  test('feeder actions trace upstream, downstream, loads and disconnection through the same result contract', () => {
    const deps = { network, session, inspections: INSPECTIONS, associations: ASSOCIATIONS, today: TODAY };
    assert.deepEqual(investigate('UPSTREAM', 'F3', deps).pathAssetIds, ['MS1', 'SS1', 'T1', 'S1', 'CB3', 'F3']);
    assert.deepEqual(investigate('DOWNSTREAM', 'F3', deps).downstream.normal, ['C1']);
    assert.deepEqual(investigate('LOADS', 'F4', deps).targetAssetIds, ['C3']);
    const off = investigate('OUTAGE', 'F3', deps);
    assert.deepEqual(off.scenario.result.consumersLost, ['C1']);
    session.reset();
  });

  test('a trace that starts or ends on a feeder draws that feeder’s segment', () => {
    const deps = { network, session, inspections: INSPECTIONS, associations: ASSOCIATIONS, today: TODAY };
    const draw = r => buildViewModel({ network, links, baseline: energize(network), view: { mode: 'overview', focus: focusOf(r) } });
    const up = draw(investigate('UPSTREAM', 'F3', deps));
    assert.equal(up.links.get('LINK-S1-C1').kind, 'flow');
    assert.equal(up.links.get('LINK-T1-S1').kind, 'flow');
    assert.equal(up.links.get('LINK-S1-C2').kind, 'hidden');
    const down = draw(investigate('DOWNSTREAM', 'F3', deps));
    assert.equal(down.links.get('LINK-S1-C1').kind, 'flow');
    assert.equal(down.links.get('LINK-T1-S1').kind, 'hidden');
    const tie = draw(investigate('DOWNSTREAM', 'TB1', deps));
    assert.equal(tie.links.get('LINK-S2-C2').kind, 'conditional', 'below a normally-open breaker the segment is conditional');
  });

  test('feeder labels: hidden in Overview, shown with the Feeders layer, named with their breaker on a traced path', () => {
    const vmOf = view => buildViewModel({ network, links, baseline: energize(network), view });
    assert.ok([...vmOf({ mode: 'overview' }).feeders.values()].every(f => !f.show));
    const withLayer = vmOf({ mode: 'overview', feedersLayer: true });
    assert.ok([...withLayer.feeders.values()].every(f => f.show));
    assert.equal(withLayer.links.get('LINK-S1-C1').kind, 'flowSoft');
    assert.equal(withLayer.links.get('LINK-S2-C2').kind, 'open', 'normally-open feeder segments are distinguished');
    assert.equal(withLayer.links.get('LINK-MS1-SS1').kind, 'hidden', 'only feeders, not the whole network');
    assert.equal(vmOf({ mode: 'overview', selectedId: 'F3' }).links.get('LINK-S1-C1').emphasis, 'selected');
  });
});

describe('GIS association: the OSM substation is a candidate for SS1, never silently merged', () => {
  test('one CANDIDATE association, unverified, with the evidence computed from the data', () => {
    assert.equal(ASSOCIATIONS.length, 1);
    const [a] = ASSOCIATIONS;
    assert.equal(a.electricalAssetId, 'SS1');
    assert.equal(a.osmId, 'way/336181714');
    assert.equal(a.associationStatus, 'CANDIDATE');
    assert.equal(a.verified, false);
    assert.equal(a.geometryConfidence, 'PUBLIC_MAPPED');
    assert.equal(a.topologyConfidence, 'ILLUSTRATIVE');
    assert.equal(a.distanceM, 132);
    assert.deepEqual(a.osmTags, { barrier: 'fence', power: 'substation' });
    assert.ok(a.evidence.some(e => /inside the mapped Seagirt Marine Terminal outline/.test(e)));
    assert.ok(a.missingEvidence.some(e => /No drawing, single-line diagram or asset register/.test(e)));
  });

  test('the association changes how SS1’s location is described, not the registry', () => {
    const ss1 = ASSETS.find(a => a.id === 'SS1');
    const p = assetProvenance(ss1, { associations: ASSOCIATIONS, records: INSPECTIONS });
    assert.equal(p.location, 'CANDIDATE_ASSOCIATION');
    assert.equal(p.identity, 'ILLUSTRATIVE');
    assert.equal(p.topology, 'ILLUSTRATIVE');
    assert.match(p.locationNote, /132 m away is a candidate match \(unverified\)/);
    assert.deepEqual([ss1.location.longitude, ss1.location.latitude], [-76.549, 39.2614], 'registry position unchanged');
    assert.equal(assetProvenance(ASSETS.find(a => a.id === 'CB3')).location, 'IN_CONTAINER');
    assert.equal(assetProvenance(ASSETS.find(a => a.id === 'F3')).location, 'SCHEMATIC');
  });
});

describe('single-line diagram layout', () => {
  test('every asset is placed; source on top; the F2A → C2 tie stays one slot long', () => {
    const network = createScenarioSession({ assets: ASSETS, edges: EDGES }).network;
    const { pos, ties } = singleLineLayout(network);
    assert.equal(pos.size, ASSETS.length);
    assert.equal(pos.get('MS1').depth, 0);
    assert.ok(pos.get('C3').depth > pos.get('S2').depth);
    assert.deepEqual(ties.map(t => t.id), ['EDGE-F2A-C2']);
    assert.ok(Math.abs(pos.get('F2A').x - pos.get('C2').x) <= 1);
    assert.ok(pos.get('T1').x < pos.get('T2').x && pos.get('T2').x < pos.get('T3').x, 'branches stay in registry order');
  });
});
