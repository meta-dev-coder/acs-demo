import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { enrichmentDataPath } from '../server/liveDc/eventEnrichment.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const source = path => readFileSync(join(ROOT, path), 'utf8');

// The poller lambda is one esbuild bundle at /var/task/index.mjs, so a file read relative to a
// module's import.meta.url would resolve outside the bundle. Config is imported (and inlined) instead.
test('bundle: the liveDc modules the poller bundles read no config relative to import.meta.url', () => {
  for (const path of ['server/liveDc/classes.mjs', 'server/liveDc/workflow.mjs', 'server/liveDc/cycle.mjs',
    'server/liveDc/eventSync.mjs', 'server/liveDc/dcWriter.mjs', 'server/liveDc/tokenHandoff.mjs', 'infra/lambdas/poller/poller.mjs']) {
    assert.ok(!/new URL\([^)]*import\.meta\.url/.test(source(path)), path);
  }
});

test('bundle: corridor GeoJSON for enrichment follows LIVE_DC_DATA_DIR, else public/data', () => {
  assert.equal(enrichmentDataPath('a.geojson', { LIVE_DC_DATA_DIR: '/var/task/data' }), '/var/task/data/a.geojson');
  assert.equal(enrichmentDataPath('a.geojson', {}), join(ROOT, 'public', 'data', 'a.geojson'));
});

test('bundle: the poller Dockerfile carries everything the Live DataConnect cycle reads', () => {
  const dockerfile = source('infra/lambdas/poller/Dockerfile');
  for (const needed of ['infra/lambdas/poller/', 'server/', 'config/liveDc/', 'src/liveOps/', 'public/data/']) {
    assert.ok(dockerfile.includes(`COPY ${needed}`), needed);
  }
});
