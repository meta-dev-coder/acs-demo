import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { enrichmentDataPath } from '../server/liveDc/eventEnrichment.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const source = path => readFileSync(join(ROOT, path), 'utf8');

// The poller lambda is one esbuild bundle at /var/task/index.mjs, so a file read relative to a
// module's import.meta.url would resolve outside the bundle. Config is imported (and inlined) instead.
test('bundle: the liveDc modules the poller bundles read no config relative to import.meta.url', () => {
  for (const path of ['server/liveDc/classes.mjs', 'server/liveDc/workflow.mjs', 'server/liveDc/cycle.mjs',
    'server/liveDc/eventSync.mjs', 'server/liveDc/dcWriter.mjs', 'infra/lambdas/poller/poller.mjs',
    'server/liveDc/eventCapture.mjs', 'server/liveDc/eventSnapshots.mjs', 'server/liveDc/eventWeather.mjs', 'src/weather/weatherText.js']) {
    assert.ok(!/new URL\([^)]*import\.meta\.url/.test(source(path)), path);
  }
});

test('bundle: corridor GeoJSON for enrichment follows LIVE_DC_DATA_DIR, else public/data', () => {
  assert.equal(enrichmentDataPath('a.geojson', { LIVE_DC_DATA_DIR: '/var/task/data' }), '/var/task/data/a.geojson');
  assert.equal(enrichmentDataPath('a.geojson', {}), join(ROOT, 'public', 'data', 'a.geojson'));
});

test('bundle: the poller Dockerfile carries everything the Live DataConnect cycle reads', () => {
  const dockerfile = source('infra/lambdas/poller/Dockerfile');
  for (const needed of ['infra/lambdas/poller/', 'server/', 'config/liveDc/', 'src/liveOps/', 'src/weather/', 'public/data/']) {
    assert.ok(dockerfile.includes(`COPY ${needed}`), needed);
  }
});

const REMOVED = ['dc-token-intake', 'dcTokenPusher', 'tokenHandoff', 'DC_TOKEN_HANDOFF', 'DcTokenKey', 'secrets/dc-token',
  'DcTokenIntake', 'dcTokenAllowedSubjects', 'DC_TOKEN_BUCKET'];
const SKIP_DIRS = new Set(['node_modules', 'cdk.out', 'dist', 'tests', '.git', 'test-results', 'playwright-report']);

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name) && name !== 'data') yield* sourceFiles(full);
    } else if (/\.(m?js|ts|md|json|example)$|^Dockerfile$|^\.env\.example$/.test(name) && name !== 'cdk-outputs.json' && !name.endsWith('.d.ts')) {
      yield full;
    }
  }
}

test('removal: the token hand-off is gone from code, infra and docs', () => {
  for (const gone of ['infra/lambdas/dc-token-intake', 'server/dcTokenPusher.mjs', 'server/liveDc/tokenHandoff.mjs']) {
    assert.ok(!existsSync(join(ROOT, gone)), gone);
  }
  const files = [...sourceFiles(join(ROOT, 'server')), ...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'tools')),
    ...sourceFiles(join(ROOT, 'infra', 'lib')), ...sourceFiles(join(ROOT, 'infra', 'lambdas')),
    join(ROOT, 'infra', 'DEPLOY.md'), join(ROOT, 'vite.config.js'), join(ROOT, '.env.example')];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const name of REMOVED) assert.ok(!text.includes(name), `${file} still mentions ${name}`);
  }
});

test('stack: the poller reads the imported service-client secret and no longer touches secrets/ or KMS', () => {
  const stack = source('infra/lib/i595-stack.ts');
  assert.match(stack, /secretsmanager\.Secret\.fromSecretNameV2\(/);
  assert.match(stack, /\.grantRead\(pollerFn\)/);
  assert.match(stack, /DC_SERVICE_CLIENT_SECRET_NAME/);
  assert.match(stack, /LIVE_DC_HOLD_OPEN: String\(this\.node\.tryGetContext\('liveDcHoldOpen'\) \?\? ''\)/);
  assert.ok(!/kms/i.test(stack), 'no KMS');
  assert.ok(!stack.includes("'secrets/"), 'no secrets/ prefix');
  assert.ok(!/new secretsmanager\.Secret\(/.test(stack), 'the secret is imported, never created');
  // FL511 is polled every 5 minutes; every event type starts a chain, as in the local sync.
  assert.ok(!stack.includes("rate(1 minute)"), 'not every minute');
  assert.match(stack, /LIVE_DC_SPAWN_TYPES: 'INCIDENT,CLOSURE,CONSTRUCTION,CONGESTION,DISABLED'/);
  for (const kept of ["rate(5 minutes)", 'cdk.Duration.seconds(55)', 'memorySize: 512', "arnForObjects('snapshots/*')",
    "arnForObjects('status/*')", "'/status/*'", 'ExpireIncidentSnapshots', 'LiveDcStatusUrl']) {
    assert.ok(stack.includes(kept), kept);
  }
});

test('bundle: the poller lambda reads its service client from Secrets Manager (SDK external, not bundled)', () => {
  const index = source('infra/lambdas/poller/index.mjs');
  assert.match(index, /@aws-sdk\/client-secrets-manager/);
  assert.match(index, /DC_SERVICE_CLIENT_SECRET_NAME/);
  assert.ok(!/GetObjectCommand/.test(index));
});
