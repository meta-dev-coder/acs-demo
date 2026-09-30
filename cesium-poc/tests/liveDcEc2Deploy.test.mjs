/**
 * EC2 always-on sync: the single-file bundle runs from an empty directory holding only dist/, reads its
 * service client through a fake `aws` CLI, and writes to the in-process DataConnect stand-in. Offline.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLiveDcBundle, OPS_FILES, RUNTIME_DATA_FILES, WEB_BUILD_ENV, webBuildEnv } from '../tools/build-live-dc-bundle.mjs';
import { createDcStandin } from '../server/liveDc/standin.mjs';
import { loadI595Network } from '../server/i595Network.mjs';
import { LIVE_CLASS } from '../server/liveDc/classes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EC2 = join(ROOT, 'deploy', 'ec2');
const read = path => readFileSync(join(EC2, path), 'utf8');
const silent = { info() {}, log() {}, warn() {}, error() {} };

const FAKE_CLIENT_ID = 'ec2-fake-client';
const FAKE_CLIENT_SECRET = 'ec2-fake-secret-Q9';
const ACCESS_TOKEN = 'ec2-fake-access-token';

function run(file, args, { cwd, env, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out\n${stdout}\n${stderr}`)); }, timeoutMs);
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function startTokenServer() {
  const posts = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      posts.push(Object.fromEntries(new URLSearchParams(body)));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 3600, token_type: 'Bearer' }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    posts, url: `http://127.0.0.1:${server.address().port}/connect/token`, close: () => new Promise(done => server.close(done)),
  })));
}

describe('EC2 bundle', () => {
  let dir;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'live-dc-ec2-'));
    await buildLiveDcBundle({ outDir: join(dir, 'dist'), web: false, logger: silent });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('dist holds one ESM file, the ops files, the corridor data the process reads and the data dictionary', () => {
    assert.deepEqual(readdirSync(join(dir, 'dist')).sort(), ['data', 'env.example', 'install.sh', 'live-dc-sync.mjs', 'live-dc.service', 'livedc.sh']);
    assert.deepEqual([...OPS_FILES].sort(), ['env.example', 'install.sh', 'live-dc.service', 'livedc.sh']);
    assert.deepEqual(readdirSync(join(dir, 'dist', 'data')).sort(), [...RUNTIME_DATA_FILES, 'data-dictionary.json'].sort());
    assert.deepEqual([...RUNTIME_DATA_FILES].sort(), [
      'express-way.geojson', 'i595_bridges.geojson', 'i595_corridor_cameras.geojson', 'i595_corridor_traffic_signals.geojson',
      'i595_express_gantries.geojson', 'i595_fdot_traffic_segments.geojson', 'i595_mainline_eb.geojson',
      'i595_mainline_wb.geojson', 'i595_ramps_connectors_classified.geojson', 'sr84_frontage_roads.geojson',
    ]);
    const dictionary = JSON.parse(readFileSync(join(dir, 'dist', 'data', 'data-dictionary.json'), 'utf8'));
    assert.equal(dictionary.dataConnect.live.length + dictionary.dataConnect.historical.length, 15);
    assert.equal(dictionary.corridorLayers.length, 6);
    const bundle = readFileSync(join(dir, 'dist', 'live-dc-sync.mjs'), 'utf8');
    const specifiers = [...bundle.matchAll(/(?:^|[;\s])(?:import|export)\s[^;'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm)]
      .map(m => m[1] ?? m[2]);
    assert.ok(specifiers.length > 0);
    for (const specifier of specifiers) assert.match(specifier, /^node:/, `non-builtin import ${specifier}`);
    assert.ok(!/with\s*\{\s*type:\s*["']json["']/.test(bundle), 'config JSON is inlined');
  });

  test('runs --once --feed from an empty directory with only dist/, service client via the aws CLI', async () => {
    const box = join(dir, 'box');
    mkdirSync(box);
    execFileSync('cp', ['-R', join(dir, 'dist'), join(box, 'dist')]);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'aws'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, 'aws-args')}"\n`
      + `echo '${JSON.stringify({ client_id: FAKE_CLIENT_ID, client_secret: FAKE_CLIENT_SECRET })}'\n`);
    chmodSync(join(bin, 'aws'), 0o755);

    const network = await loadI595Network(join(ROOT, 'public', 'data'));
    const eb = network.lines.find(line => line.facility === 'I595_EB').coordinates;
    const feedFile = join(dir, 'feed.json');
    writeFileSync(feedFile, JSON.stringify({
      incidents: [{ itemId: '868702', latitude: 26.093417, longitude: -80.226583 }], closures: [], construction: [], congestion: [],
      disabledVehicles: [{ itemId: '900001', latitude: eb[60][1], longitude: eb[60][0] }],
      details: { 868702: { title: 'Crash', description: 'Crash on I-595 West at Davie Rd. 2 right lanes blocked.', fields: [] } },
    }));

    const standin = createDcStandin({ processingDelayMs: 1, curationDelayMs: 1, assetRows: [], tokens: { [ACCESS_TOKEN]: 'admin' }, logger: silent });
    const server = await standin.listen(0);
    const tokens = await startTokenServer();
    try {
      const { code, stdout, stderr } = await run(join(box, 'dist', 'live-dc-sync.mjs'), ['--once', '--feed', feedFile], {
        cwd: box,
        env: {
          PATH: `${bin}:/usr/bin:/bin`, HOME: box,
          DC_WRITER_BASE_URL: server.url, DC_WRITER_LOAD_BASE_URL: server.url, DC_WRITER_TOKEN_URL: tokens.url, DC_WRITER_POLL_INTERVAL_MS: '50',
          LIVE_DC_SERVICE_CLIENT_SECRET_NAME: 'i595/dataconnect/service-client', LIVE_DC_AWS_REGION: 'us-east-1',
          LIVE_DC_SPAWN_TYPES: 'INCIDENT,CLOSURE,CONSTRUCTION,CONGESTION,DISABLED',
        },
      });
      assert.equal(code, 0, `${stdout}\n${stderr}`);
      assert.ok(!/http listening/.test(stdout), 'no LIVE_DC_HTTP_PORT: sync only');
      assert.match(stdout, /live-dc cycle .* source=LIVE .*events: seen=2 new=2 .*errors=0/);
      assert.deepEqual(tokens.posts.map(p => [p.grant_type, p.client_id, p.client_secret]),
        [['client_credentials', FAKE_CLIENT_ID, FAKE_CLIENT_SECRET]]);
      assert.equal(readFileSync(join(dir, 'aws-args'), 'utf8').trim().split('\n').join(' '),
        'secretsmanager get-secret-value --secret-id i595/dataconnect/service-client --region us-east-1 --query SecretString --output text');
      for (const leaked of [FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, ACCESS_TOKEN]) assert.ok(!(stdout + stderr).includes(leaked), leaked);
      assert.ok(standin.snapshot(LIVE_CLASS.EVENTS).length >= 2);
    } finally {
      await tokens.close();
      await server.close();
    }
  });
});

describe('EC2 bundle with a web build', () => {
  test('a prebuilt web/ directory is copied next to the bundle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-dc-ec2-web-'));
    try {
      const web = join(dir, 'fixture');
      mkdirSync(join(web, 'assets'), { recursive: true });
      writeFileSync(join(web, 'index.html'), '<!doctype html>');
      writeFileSync(join(web, 'assets', 'x.js'), '');
      await buildLiveDcBundle({ outDir: join(dir, 'dist'), web: { from: web }, logger: silent });
      assert.ok(readdirSync(join(dir, 'dist')).includes('web'));
      assert.deepEqual(readdirSync(join(dir, 'dist', 'web', 'assets')), ['x.js']);
      const bundle = readFileSync(join(dir, 'dist', 'live-dc-sync.mjs'), 'utf8');
      assert.match(bundle.slice(0, 600), /LIVE_DC_WEB_DIR \|\|= /);
      await assert.rejects(buildLiveDcBundle({ outDir: join(dir, 'dist2'), web: { from: join(dir, 'missing') }, logger: silent }), /web/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('EC2 frontend build environment', () => {
  test('same-origin API paths with live DataConnect on, whatever the shell or .env files say', () => {
    const env = webBuildEnv({
      shellEnv: {
        PATH: '/bin', HOME: '/h', VITE_LIVE_EVENTS_API: 'https://d3syo4sqvwi009.cloudfront.net/api/i595/live-events',
        VITE_SNAPSHOT_BASE: 'https://d3syo4sqvwi009.cloudfront.net/api/i595/camera', VITE_LIVE_DC_STATUS_URL: 'https://x.cloudfront.net/s.json',
        VITE_GOOGLE_MAPS_API_KEY: 'public-browser-key', DC_CLIENT_SECRET: 'server-only', VITE_SOMETHING_ELSE: 'dropped',
        DC_WRITER_ACCESS_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 'k',
      },
      fileEnv: { VITE_CESIUM_ION_TOKEN: 'ion-from-file', VITE_DATA_SOURCE: 'mock', VITE_DC_CLASS_WORK_ORDERS: 'c1', DC_PASSWORD: 'p' },
    });
    assert.deepEqual(WEB_BUILD_ENV, {
      VITE_DATA_SOURCE: 'dataconnect', VITE_LIVE_DC: 'true', VITE_LIVE_EVENTS_API: '/api/i595/live-events', VITE_SNAPSHOT_BASE: '/api/i595/camera',
      VITE_MESSAGE_SIGNS_API: '/api/i595/message-signs', VITE_LIVE_DC_STATUS_URL: '/status/live-dc-status.json', VITE_ASK_THE_TWIN_API: '/api/i595/ask',
      VITE_ENABLE_CESIUM_CLIP_EDITOR: 'false',
    });
    for (const [key, value] of Object.entries(WEB_BUILD_ENV)) assert.equal(env[key], value, key);
    assert.equal(env.VITE_GOOGLE_MAPS_API_KEY, 'public-browser-key');
    assert.equal(env.VITE_CESIUM_ION_TOKEN, 'ion-from-file');
    assert.equal(env.VITE_DC_CLASS_WORK_ORDERS, 'c1');
    assert.equal(env.LIVE_DC_WEB_BUILD, '1');
    assert.equal(env.NODE_ENV, 'production');
    for (const dropped of ['DC_CLIENT_SECRET', 'VITE_SOMETHING_ELSE', 'DC_WRITER_ACCESS_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DC_PASSWORD']) {
      assert.equal(env[dropped], undefined, dropped);
    }
    for (const value of Object.values(WEB_BUILD_ENV)) assert.ok(!/cloudfront|amazonaws|https?:/.test(value));
  });

  test('vite.config.js skips the server .env loader for the isolated web build', () => {
    const config = readFileSync(join(ROOT, 'vite.config.js'), 'utf8');
    assert.match(config, /if \(!process\.env\.LIVE_DC_WEB_BUILD\) loadServerEnv\(\);/);
  });
});

describe('EC2 deploy files', () => {
  const SECRETISH = /(CLIENT_SECRET|CLIENT_ID|ACCESS_TOKEN|PASSWORD|REFRESH_TOKEN)\s*=|AKIA[0-9A-Z]{12}|aws_secret_access_key|scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]{16,}\$/i;

  test('systemd unit: runs the current release, resource limits, hardened, restarts', () => {
    const unit = read('live-dc.service');
    for (const line of ['User=livedc', 'Group=livedc', 'WorkingDirectory=/opt/live-dc/current', 'EnvironmentFile=/etc/live-dc/env',
      'ExecStart=/opt/live-dc/bin/node --max-old-space-size=384 /opt/live-dc/current/live-dc-sync.mjs', 'Restart=always', 'RestartSec=30',
      'MemoryMax=512M', 'CPUQuota=50%', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes',
      'PrivateDevices=yes', 'KillSignal=SIGINT']) {
      assert.ok(unit.split('\n').includes(line), line);
    }
    assert.ok(!SECRETISH.test(unit));
  });

  test('env.example: the non-secret settings, HTTP host and release location, no secret values', () => {
    const env = read('env.example');
    const values = Object.fromEntries(env.split('\n').filter(l => /^[A-Z_][A-Z0-9_]*=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    assert.deepEqual({
      DC_WRITER_BASE_URL: values.DC_WRITER_BASE_URL, DC_WRITER_LOAD_BASE_URL: values.DC_WRITER_LOAD_BASE_URL,
      LIVE_DC_SERVICE_CLIENT_SECRET_NAME: values.LIVE_DC_SERVICE_CLIENT_SECRET_NAME, LIVE_DC_AWS_REGION: values.LIVE_DC_AWS_REGION,
      LIVE_DC_LINK_MODE: values.LIVE_DC_LINK_MODE, LIVE_DC_SPAWN_TYPES: values.LIVE_DC_SPAWN_TYPES,
      LIVE_DC_HOLD_OPEN: values.LIVE_DC_HOLD_OPEN, LIVE_DC_INTERVAL_SECONDS: values.LIVE_DC_INTERVAL_SECONDS,
      LIVE_DC_SNAPSHOT_BUCKET: values.LIVE_DC_SNAPSHOT_BUCKET, LIVE_DC_SNAPSHOT_PUBLIC_BASE: values.LIVE_DC_SNAPSHOT_PUBLIC_BASE,
      LIVE_DC_PUBLIC_API_BASE: values.LIVE_DC_PUBLIC_API_BASE,
      LIVE_DC_HTTP_HOST: values.LIVE_DC_HTTP_HOST, LIVE_DC_HTTP_PORT: values.LIVE_DC_HTTP_PORT, LIVE_DEMO_PASSWORD_HASH: values.LIVE_DEMO_PASSWORD_HASH,
      LIVE_DC_READ_BASE_URL: values.LIVE_DC_READ_BASE_URL, DC_BASE_URL: values.DC_BASE_URL,
      LIVE_DC_RELEASE_BUCKET: values.LIVE_DC_RELEASE_BUCKET, LIVE_DC_RELEASE_PREFIX: values.LIVE_DC_RELEASE_PREFIX,
    }, {
      DC_WRITER_BASE_URL: 'https://dataconnect-demo-dqa3.cohesivecloud.app', DC_WRITER_LOAD_BASE_URL: 'https://dc-load-demo-dqa3.cohesivecloud.app',
      LIVE_DC_SERVICE_CLIENT_SECRET_NAME: 'i595/dataconnect/service-client', LIVE_DC_AWS_REGION: 'us-east-1',
      LIVE_DC_LINK_MODE: 'live', LIVE_DC_SPAWN_TYPES: 'INCIDENT,CLOSURE,CONSTRUCTION,CONGESTION,DISABLED',
      LIVE_DC_HOLD_OPEN: '', LIVE_DC_INTERVAL_SECONDS: '300',
      LIVE_DC_SNAPSHOT_BUCKET: 'i595stackv5-i595corridordata41064a5b-oixfpv0dyrzj',
      LIVE_DC_SNAPSHOT_PUBLIC_BASE: 'https://d3syo4sqvwi009.cloudfront.net', LIVE_DC_PUBLIC_API_BASE: 'https://d3syo4sqvwi009.cloudfront.net',
      LIVE_DC_HTTP_HOST: '0.0.0.0', LIVE_DC_HTTP_PORT: '8095', LIVE_DEMO_PASSWORD_HASH: '',
      LIVE_DC_READ_BASE_URL: 'https://dataconnect-demo-dqa3.cohesivecloud.app', DC_BASE_URL: 'https://dc-data-mgmt-demo-dqa3.cohesivecloud.app',
      LIVE_DC_RELEASE_BUCKET: 'i595stackv5-i595corridordata41064a5b-oixfpv0dyrzj', LIVE_DC_RELEASE_PREFIX: 'releases/live-dc',
    });
    assert.equal(values.LIVE_DC_DATA_DIR, undefined, 'the bundle finds its sibling data/');
    assert.match(env, /--hash-password/);
    assert.ok(!SECRETISH.test(env.replace(/^LIVE_DEMO_PASSWORD_HASH=$/m, '')));
  });

  test('iam-policy.json: secret reads, snapshot writes, release reads', () => {
    const policy = JSON.parse(read('iam-policy.json'));
    assert.equal(policy.Version, '2012-10-17');
    assert.deepEqual(policy.Statement.map(s => [s.Effect, [s.Action].flat(), [s.Resource].flat()]), [
      ['Allow', ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'], ['arn:aws:secretsmanager:us-east-1:589391957147:secret:i595/dataconnect/service-client-*']],
      ['Allow', ['secretsmanager:GetSecretValue'], ['arn:aws:secretsmanager:us-east-1:589391957147:secret:i595/anthropic-key-*']],
      ['Allow', ['s3:PutObject'], ['arn:aws:s3:::i595stackv5-i595corridordata41064a5b-oixfpv0dyrzj/snapshots/*']],
      ['Allow', ['s3:GetObject'], ['arn:aws:s3:::i595stackv5-i595corridordata41064a5b-oixfpv0dyrzj/releases/live-dc/*']],
    ]);
  });

  test('iam-policy-uploader.json: put/get releases and list only that prefix', () => {
    const policy = JSON.parse(read('iam-policy-uploader.json'));
    assert.equal(policy.Version, '2012-10-17');
    const statements = policy.Statement.map(s => ({ effect: s.Effect, actions: [s.Action].flat().sort(), resources: [s.Resource].flat(), condition: s.Condition ?? null }));
    assert.deepEqual(statements, [
      { effect: 'Allow', actions: ['s3:GetObject', 's3:PutObject'], resources: ['arn:aws:s3:::i595stackv5-i595corridordata41064a5b-oixfpv0dyrzj/releases/live-dc/*'], condition: null },
      { effect: 'Allow', actions: ['s3:ListBucket'], resources: ['arn:aws:s3:::i595stackv5-i595corridordata41064a5b-oixfpv0dyrzj'],
        condition: { StringLike: { 's3:prefix': ['releases/live-dc/*'] } } },
    ]);
  });

  test('install.sh parses, carries no secrets, installs a release under releases/ and does not start the service', () => {
    execFileSync('bash', ['-n', join(EC2, 'install.sh')]);
    const script = read('install.sh');
    assert.ok(!SECRETISH.test(script));
    assert.match(script, /systemctl enable live-dc/);
    assert.ok(!script.split('\n').some(l => /^\s*systemctl (re)?start/.test(l)));
    assert.match(script, /chmod 640/);
    assert.match(script, /^APP_DIR=\/opt\/live-dc$/m);
    assert.match(script, /"\$APP_DIR\/releases\/\$VERSION"/);
    assert.match(script, /livedc\.sh/);
  });

  test('livedc.sh parses and carries no secrets', () => {
    execFileSync('bash', ['-n', join(EC2, 'livedc.sh')]);
    const script = read('livedc.sh');
    assert.ok(!SECRETISH.test(script));
    for (const command of ['start', 'stop', 'restart', 'status', 'logs', 'update', 'rollback', 'uninstall']) assert.match(script, new RegExp(`\\b${command}\\)`), command);
  });

  test('README and wiring: release flow, password hash, security group, uninstall', () => {
    const readme = read('README.md');
    for (const needed of ['npm run live-dc:release', 'aws s3 cp', 'sudo ./install.sh', 'sudo /opt/live-dc/livedc.sh update latest', '--hash-password',
      'LIVE_DEMO_PASSWORD_HASH', '8095', 'security group', 'livedc.sh uninstall', 'livedc.sh rollback', 'aws iam put-role-policy', 'iam-policy-uploader.json',
      'CloudFront', 'journalctl']) {
      assert.ok(readme.includes(needed), needed);
    }
    const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
    assert.equal(scripts['live-dc:bundle'], 'node tools/build-live-dc-bundle.mjs');
    assert.equal(scripts['live-dc:release'], 'node tools/release-live-dc.mjs');
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n');
    assert.ok(ignore.includes('deploy/ec2/dist/'));
    assert.ok(ignore.includes('deploy/ec2/releases/'));
  });
});

test('install.sh gives the service its own Node >= 20.12 copy, found even when sudo sees an old system node', async () => {
  const { readFileSync } = await import('node:fs');
  const sh = readFileSync(new URL('../deploy/ec2/install.sh', import.meta.url), 'utf8');
  assert.match(sh, /LIVE_DC_NODE/);
  assert.match(sh, /SUDO_USER/);
  assert.match(sh, /install -m 755 -o root -g root "\$NODE_SRC" "\$APP_DIR\/bin\/node"/);
  const unit = readFileSync(new URL('../deploy/ec2/live-dc.service', import.meta.url), 'utf8');
  assert.match(unit, /^ExecStart=\/opt\/live-dc\/bin\/node /m);
  const release = readFileSync(new URL('../tools/release-live-dc.mjs', import.meta.url), 'utf8');
  assert.match(release, /'--no-xattrs'/);
});
