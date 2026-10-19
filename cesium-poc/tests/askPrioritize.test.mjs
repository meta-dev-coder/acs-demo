import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStoreFromSnapshot, openTwinStore } from '../server/ask/twinStore.mjs';
import { createPrioritizer, rankSites } from '../server/ask/prioritize.mjs';
import { createScope } from '../server/ask/sources.mjs';
import { createTools } from '../server/ask/tools.mjs';
import { createInsights } from '../server/ask/insights.mjs';
import { buildAnswerExtras } from '../server/ask/answerBlocks.mjs';
import { planPrefetch } from '../server/ask/prefetch.mjs';
import { generateTollTransactions } from '../tools/generate-toll-transactions.mjs';

const SNAPSHOT = new URL('../public/dataconnect-data', import.meta.url).pathname;
let dir, store, prioritize;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'prioritize-'));
  buildStoreFromSnapshot({ snapshotDir: SNAPSHOT, outPath: join(dir, 't.sqlite') });
  store = openTwinStore(join(dir, 't.sqlite'));
  prioritize = createPrioritizer({ store, now: () => Date.parse('2026-10-12T00:00:00Z') });
});
after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test("Dan's example on real work orders: maintenance orders FIFO/distance, revenue off and said so", () => {
  const { output } = prioritize({}, { scope: createScope(['maintenance']) });
  assert.equal(output.preset, 'maintenance');
  assert.deepEqual(output.sites.map(s => s.site), ['CCTV 5078', 'CCTV 5075', 'CCTV 5079']);
  assert.deepEqual(output.sites.map(s => s.oldest_open_since), ['2024-08-21', '2025-01-17', '2025-05-07']);
  assert.equal(output.sites[0].revenue_at_risk_usd_per_day, null);
  assert.match(output.gaps.join(' '), /Tolling & revenue is toggled off/);
  assert.match(output.gaps.join(' '), /assumed depot/);
  assert.deepEqual(output.sourcesUsed, []);
  assert.ok(output.sites[2].notEvaluated.some(n => /inspection/.test(n)), 'CCTV 5079 has no inspection on record: NA, not guessed');
});

test('with Tolling & revenue on, the executive preset moves the high-revenue site first and shows the move', () => {
  const { output, summary, source } = prioritize({}, { scope: createScope(null) });
  assert.equal(output.preset, 'executive');
  assert.equal(output.sites[0].site, 'CCTV 5079');
  assert.equal(output.sites[0].rank_under_other_preset, 3);
  assert.equal(output.sites[0].moved, 2);
  assert.ok(output.sites[0].revenue_at_risk_usd_per_day > output.sites[1].revenue_at_risk_usd_per_day);
  assert.match(output.sites[0].revenue_basis, /GNT-M05/);
  assert.match(summary, /CCTV 5079 first under Executive.*#3 under Maintenance/);
  assert.match(source, /synthetic tolls/);
  assert.match(output.gaps.join(' '), /SYNTHETIC toll transactions/);
  assert.deepEqual(output.sourcesUsed, ['finance']);
  // An explicit preset is honoured even with finance on.
  assert.equal(prioritize({ preset: 'nearest' }, { scope: createScope(null) }).output.sites[0].site, 'CCTV 5075');
});

test('rankSites: weighted, normalised, NA contributes nothing, ties go to the older order', () => {
  const sites = [{ asset_id: 'a', values: { fifo: 10, distance: 5 } }, { asset_id: 'b', values: { fifo: 20, distance: null } }];
  const ranked = rankSites(sites, { fifo: 0.5, distance: 0.5 });
  // a: fifo 0 + distance 0.5 (the only known distance); b: fifo 0.5 + distance NA. Tied at 0.5 -> b, the older order, first.
  assert.deepEqual(ranked.map(s => [s.asset_id, s.score]), [['b', 0.5], ['a', 0.5]]);
  assert.equal(ranked.find(s => s.asset_id === 'b').contributions.distance, null);
});

test('the tool is refused when Maintenance is toggled off; blocks show the order and why', async () => {
  const tools = createTools({ store, insights: createInsights({ store, readLayer: () => null }) });
  const refused = await tools.run('prioritize_sites', {}, { scope: createScope(['finance']) });
  assert.equal(refused.output.gap.type, 'out_of_scope');
  const ok = await tools.run('prioritize_sites', {}, { scope: createScope(null) });
  const { blocks, evidence } = buildAnswerExtras([{ ref: 'R1', name: 'prioritize_sites', evidence: true, source: ok.source, output: ok.output }], ['R1']);
  assert.equal(blocks[0].type, 'table');
  assert.deepEqual(blocks[0].columns, ['#', 'Site', 'Open since', 'km', 'Risk', 'Revenue/day', 'vs Maintenance & operations']);
  assert.equal(blocks[0].rows[0][1], 'CCTV 5079');
  assert.equal(blocks[0].rows[0].at(-1), '▲ 2');
  assert.equal(blocks[1].title, 'Why CCTV 5079 is first');
  assert.equal(evidence.R1.records[0].id, 'CCTV 5079');
});

test('prefetch recognises "which first" questions and the asset type', () => {
  const plan = q => planPrefetch({ question: q, screen: {} }).map(p => [p.name, p.input.asset_type]);
  assert.deepEqual(plan('Which camera sites should we fix first?'), [['prioritize_sites', 'Camera']]);
  assert.deepEqual(plan('Prioritize the open DMS work orders'), [['prioritize_sites', 'DMS']]);
  assert.deepEqual(plan('How many cameras are there?'), []);
});

test('synthetic toll data is deterministic, labelled synthetic, and the committed file matches the generator', () => {
  const config = JSON.parse(readFileSync(new URL('../config/askTwin/syntheticTolls.json', import.meta.url), 'utf8'));
  const gantries = JSON.parse(readFileSync(new URL('../public/data/i595_express_gantries.geojson', import.meta.url), 'utf8'));
  const rows = generateTollTransactions(config, gantries);
  assert.deepEqual(rows, generateTollTransactions(config, gantries));
  assert.deepEqual(rows, JSON.parse(readFileSync(join(SNAPSHOT, 'toll_transactions_synthetic.json'), 'utf8')));
  assert.ok(rows.every(r => r.synthetic === true && r.image_dependent_transactions < r.transactions));
  assert.equal(store.classes().find(c => c.className === 'I595 Toll Transactions').source, 'synthetic:toll_transactions_synthetic.json');
});
