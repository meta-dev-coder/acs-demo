import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareAnswer, namedIds, parseCompareQuestion, resolveVersions } from '../src/ifcSpatial/askCompare.js';
import { md, renderAnswer, splitLead } from '../src/ifcSpatial/answerView.js';
import { compareVersions } from '../server/ifcSpatial/compare.mjs';
import { convertIfc } from '../server/ifcSpatial/convert.mjs';

const VERSIONS = [4, 3, 2, 1].map(n => ({ versionNumber: n }));
const conv = async f => { const r = await convertIfc(readFileSync(new URL(`./fixtures/ifc/${f}`, import.meta.url)), {}); return { elements: r.elements, connections: r.connections, georeference: r.diagnostics.georeference, lengthUnitScale: r.diagnostics.lengthUnitScale }; };
const [v3, v4, v1, v2] = await Promise.all(['seagirt-compare-v3.ifc', 'seagirt-compare-v4.ifc', 'seagirt-compare-v1.ifc', 'seagirt-compare-v2.ifc'].map(conv));
const R34 = { ...compareVersions(v3, v4), computedAt: '2026-11-24T11:00:00Z' };
const R23 = compareVersions(v1, v2);
const ids34 = new Set([...v4.elements.map(e => e.networkId).filter(Boolean)]);

test('routing: version questions are recognised, in many phrasings; network questions are not', () => {
  const yes = ['What changed between V3 and V4?', 'Compare IFC V2 with V3', 'How many assets were added in V4?', 'Which assets were removed?', 'Which equipment changed location in V3?',
    'What changed in the latest IFC upload?', 'Compare the current version with the previous version', 'What are the major modifications between version 3 and version 4?'];
  for (const q of yes) assert.ok(parseCompareQuestion(q), q);
  const no = ['What is connected to USS-7?', 'Which assets have no power?', 'Which circuit breakers may exceed their interrupting ratings under the modeled short-circuit conditions?', 'What supplies STS-05?'];
  for (const q of no) assert.equal(parseCompareQuestion(q), null, q);
  // With a comparison in the conversation: follow-ups and per-asset questions.
  const cmp = { base: 3, target: 4, lastIds: [] };
  assert.equal(parseCompareQuestion('Which of those are switchgear?', { cmp }).category, 'switchgear');
  assert.equal(parseCompareQuestion('Show them on the map', { cmp }).wantsMap, true);
  assert.equal(parseCompareQuestion('What changed in UTIL-A?', { cmp, knownIds: new Set(['UTIL-A', 'UTIL-B']) }).assetId, 'UTIL-A');
  assert.equal(parseCompareQuestion('What properties changed in one of them?', { cmp }).kind, 'pick');
  assert.equal(parseCompareQuestion('Which assets have no power?', { cmp }), null, 'a power question stays with the network');
  assert.deepEqual(namedIds('changes in L6f and L6', new Set(['L6', 'L6e', 'L6f'])), ['L6f', 'L6'], 'whole ids only');
});

test('versions: named, latest, "V4 against the one before", context; unknown versions refused', () => {
  const p = q => parseCompareQuestion(q);
  assert.deepEqual(resolveVersions(p('What changed between V3 and V4?'), VERSIONS), { base: 3, target: 4, how: 'named' });
  assert.deepEqual(resolveVersions(p('Compare V4 with V3'), VERSIONS), { base: 3, target: 4, how: 'named' });
  assert.deepEqual(resolveVersions(p('What changed in the latest IFC upload?'), VERSIONS), { base: 3, target: 4, how: 'latest' });
  assert.deepEqual(resolveVersions(p('How many assets were added in V3?'), VERSIONS), { base: 2, target: 3, how: 'previous' });
  assert.match(resolveVersions(p('What changed between V7 and V9?'), VERSIONS).error, /no version V7 or V9.*Available: V4, V3, V2, V1/);
  assert.match(resolveVersions(p('What changed in V1?'), VERSIONS).error, /first version/);
  assert.deepEqual(resolveVersions(parseCompareQuestion('Which of those are cables?', { cmp: { base: 2, target: 3 } }), VERSIONS, { cmp: { base: 2, target: 3 } }), { base: 2, target: 3, how: 'context' });
});

const answer = (q, result, base, target, extra = {}) => compareAnswer(parseCompareQuestion(q, { knownIds: ids34, ...extra }), result, { question: q, fileName: 'seagirt_power_network.ifc', base, target, how: 'named', ...extra });

test('answers: the summary carries the comparison\'s own counts and groups, not 131 rows', () => {
  const { view, ids } = answer('What changed between V3 and V4?', R34, 3, 4);
  assert.equal(view.title, '131 changes between V3 and V4');
  assert.deepEqual(view.metrics.map(m => [m.label, m.value]), [['Added', 33], ['Moved', 0], ['Modified', 98], ['Removed', 0], ['Unchanged', 97]]);
  assert.deepEqual(view.groups.map(g => [g.label, g.total]), [['New Circuit Breakers', 33], ['Modified Network', 2], ['Modified Properties (properties only)', 96]]);
  assert.match(view.lead, /35 are significant/);
  assert.equal(ids.length, 131);
  assert.ok(view.actions.some(a => a.attrs['data-cmp-open'] === '3:4'));
  assert.match(view.sources[0], /IFC comparison V3 → V4 of seagirt_power_network\.ifc/);
  const html = renderAnswer(view);
  assert.ok((html.match(/class="isp-ans-item"/g) ?? []).length === 131, 'every change stays reachable');
  assert.ok((html.match(/<details class="isp-ans-more">/g) ?? []).length >= 2, 'long groups start folded');
});

test('answers: lists by status and category, follow-ups on the last set, one asset in detail', () => {
  let r = answer('How many assets were added in V4?', R34, 3, 4);
  assert.equal(r.view.title, '33 assets added between V3 and V4');
  r = answer('Which switchgear was added?', R34, 3, 4);
  assert.match(r.view.title, /^No switchgear added/);
  assert.match(r.view.lead, /33 circuit breakers/);
  const added = answer('Show me the newly added assets', R34, 3, 4, { cmp: { base: 3, target: 4, lastIds: null } });
  const breakers = answer('Which of those are circuit breakers?', R34, 3, 4, { cmp: { base: 3, target: 4, lastIds: added.ids }, lastIds: added.ids });
  assert.equal(breakers.ids.length, 33);
  const util = compareAnswer(parseCompareQuestion('Where did UTIL-A move?', { cmp: { base: 2, target: 3 }, knownIds: new Set(['UTIL-A']) }), R23, { question: 'q', fileName: 'f', base: 2, target: 3, how: 'context' });
  assert.match(util.view.title, /^UTIL-A moved 515 m between V2 and V3$/);
  assert.match(util.view.details[0].markdown, /\| Position \|/);
  // An asset the comparison reports as unchanged.
  const changed = new Set([...R34.changes.map(c => c.networkId), ...(R34.statusUpdates ?? []).map(u => u.networkId)]);
  const quiet = [...ids34].find(id => !changed.has(id));
  const same = compareAnswer(parseCompareQuestion(`What changed in ${quiet} between V3 and V4?`, { knownIds: ids34 }), R34, { question: 'q', fileName: 'f', base: 3, target: 4, how: 'named' });
  assert.equal(same.view.title, `${quiet} is unchanged between V3 and V4`);
  const tx1 = compareAnswer(parseCompareQuestion('What changed in TX-1 between V3 and V4?', { knownIds: ids34 }), R34, { question: 'q', fileName: 'f', base: 3, target: 4, how: 'named' });
  assert.equal(tx1.view.title, 'TX-1 was modified between V3 and V4');
  assert.match(tx1.view.details[0].markdown, /SuperDNA_ShortCircuitInput/);
});

test('rendering: Markdown is escaped first; tables scroll in their box; long id lists leave the lead', () => {
  const html = md('**Bold** and <script>alert(1)</script>\n\n| a | b |\n|---|---|\n| 1 | <img src=x onerror=alert(1)> |\n\n- one\n- two\n\n[ok](https://acc.autodesk.com/x) [bad](javascript:alert(1))');
  assert.ok(html.includes('<strong>Bold</strong>'));
  assert.ok(!/<script|<img/.test(html), 'no HTML from text');
  assert.ok(html.includes('isp-ans-tablewrap'));
  assert.ok(html.includes('href="https://acc.autodesk.com/x"') && !html.includes('href="javascript'));
  assert.ok(md('line one\\nline two').includes('line one line two'), 'escaped newlines are not printed as "\\n"');
  const known = new Set(Array.from({ length: 20 }, (_, i) => `A-${i}`));
  const { lead, rest } = splitLead(`31 assets are supplied from USS-7. ${[...known].join(', ')} are reachable only through RS-L.`, known);
  assert.equal(lead, '31 assets are supplied from USS-7.');
  assert.equal(splitLead('Under the modelled fault, CB-LV3: 42.21 kA duty, 101% of an assumed 42 kA rating. 3 more are above 80%.', new Set()).lead,
    'Under the modelled fault, CB-LV3: 42.21 kA duty, 101% of an assumed 42 kA rating. 3 more are above 80%.', 'a decimal point does not end a sentence');
  assert.equal(rest.length, 1);
});

test('routing: "Any recent changes to TX-M1?" is a question about the newest version of that asset', () => {
  const p = parseCompareQuestion('Any recent changes to TX-M1?', { knownIds: new Set(['TX-M1']) });
  assert.equal(p.kind, 'asset');
  assert.equal(p.assetId, 'TX-M1');
  assert.deepEqual(p.versionRef, { latest: true });
  assert.equal(parseCompareQuestion('Any recent changes?', { knownIds: new Set(['TX-M1']) }), null, 'only with an asset named');
});
