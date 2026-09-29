/**
 * EC2 "option A": one process runs the live sync loop and the password-gated HTTP host. The bundle runs
 * from an isolated directory against the in-process DataConnect stand-in, a fake token endpoint, a fake
 * `aws` CLI and a fixture FL511 feed. Offline.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLiveDcBundle } from '../tools/build-live-dc-bundle.mjs';
import { createDcStandin } from '../server/liveDc/standin.mjs';
import { LIVE_CLASS } from '../server/liveDc/classes.mjs';
import { hashPassword, verifyPassword } from '../server/liveDc/demoAuth.mjs';
import { createSyncStatus, loadDemoHttpConfig } from '../server/liveDc/demoServer.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const silent = { info() {}, log() {}, warn() {}, error() {} };
const PASSWORD = 'one-process-demo-pw-5519';
const HASH = hashPassword(PASSWORD, { N: 1024 });
const CLIENT_ID = 'ec2-host-fake-client';
const CLIENT_SECRET = 'ec2-host-fake-secret-K2';
const ACCESS_TOKEN = 'ec2-host-fake-access-token';

describe('demoServer config and status', () => {
  test('no LIVE_DC_HTTP_PORT -> no HTTP host (local sync unchanged)', () => {
    assert.equal(loadDemoHttpConfig({}), null);
    assert.equal(loadDemoHttpConfig({ LIVE_DC_HTTP_PORT: '' }), null);
  });

  test('port set: defaults, validation and a required password hash', () => {
    const config = loadDemoHttpConfig({ LIVE_DC_HTTP_PORT: '8095', LIVE_DEMO_PASSWORD_HASH: HASH, LIVE_DC_WEB_DIR: '/w' });
    assert.deepEqual({ ...config, passwordHash: config.passwordHash === HASH }, { host: '0.0.0.0', port: 8095, passwordHash: true, webDir: '/w' });
    assert.equal(loadDemoHttpConfig({ LIVE_DC_HTTP_PORT: '0', LIVE_DC_HTTP_HOST: '127.0.0.1', LIVE_DEMO_PASSWORD_HASH: HASH }).host, '127.0.0.1');
    assert.throws(() => loadDemoHttpConfig({ LIVE_DC_HTTP_PORT: '8095' }), /LIVE_DEMO_PASSWORD_HASH/);
    assert.throws(() => loadDemoHttpConfig({ LIVE_DC_HTTP_PORT: '8095', LIVE_DEMO_PASSWORD_HASH: 'plaintext' }), /LIVE_DEMO_PASSWORD_HASH/);
    assert.throws(() => loadDemoHttpConfig({ LIVE_DC_HTTP_PORT: '99999', LIVE_DEMO_PASSWORD_HASH: HASH }), /LIVE_DC_HTTP_PORT/);
    assert.throws(() => loadDemoHttpConfig({ LIVE_DC_HTTP_PORT: 'x', LIVE_DEMO_PASSWORD_HASH: HASH }), /LIVE_DC_HTTP_PORT/);
  });

  test('status: healthz reports the last cycle; the status file mirrors the poller shape', () => {
    let now = Date.parse('2026-09-29T10:00:00Z');
    const status = createSyncStatus({ intervalSeconds: 300, now: () => now });
    assert.deepEqual(status.healthz(), { ok: true, lastCycleAt: null });
    status.recordCycle({ at: '2026-09-29T10:00:00.000Z', sourceStatus: 'LIVE', errors: [] });
    assert.deepEqual(status.healthz(), { ok: true, lastCycleAt: '2026-09-29T10:00:00.000Z' });
    assert.deepEqual(status.cloud(), { lastRunAt: '2026-09-29T10:00:00.000Z', dcWrite: 'ok', reason: null, fl511: 'LIVE', intervalSeconds: 300, host: 'ec2' });
    now += 60_000;
    status.recordFailure(new Error('DataConnect returned 503'));
    assert.equal(status.cloud().dcWrite, 'error');
    assert.equal(status.cloud().reason, 'DataConnect returned 503');
    now += 3 * 300_000 + 120_001;
    assert.equal(status.healthz().ok, false, 'no cycle for three intervals');
  });
});

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

function waitFor(check, { timeoutMs = 20_000, intervalMs = 100 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await check();
        if (value) { resolve(value); return; }
      } catch { /* retry */ }
      if (Date.now() - started > timeoutMs) { reject(new Error('timed out waiting')); return; }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe('one process: sync loop + password-gated HTTP host', () => {
  let dir, box, bin, feedFile, standin, upstream, tokens, child, stdout = '', stderr = '', base, cookie;

  const envFor = extra => ({
    PATH: `${bin}:/usr/bin:/bin`, HOME: box,
    DC_WRITER_BASE_URL: upstream.url, DC_WRITER_LOAD_BASE_URL: upstream.url, DC_WRITER_TOKEN_URL: tokens.url, DC_WRITER_POLL_INTERVAL_MS: '50',
    LIVE_DC_READ_BASE_URL: upstream.url, LIVE_DC_READ_TOKEN_URL: tokens.url,
    DC_BASE_URL: upstream.url, DC_TOKEN_URL: tokens.url,
    LIVE_DC_SERVICE_CLIENT_SECRET_NAME: 'i595/dataconnect/service-client', LIVE_DC_AWS_REGION: 'us-east-1',
    LIVE_DC_SPAWN_TYPES: 'INCIDENT,CLOSURE,CONSTRUCTION,CONGESTION,DISABLED',
    ...extra,
  });

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'live-dc-onebox-'));
    const fixtureWeb = join(dir, 'fixture-web');
    mkdirSync(join(fixtureWeb, 'assets'), { recursive: true });
    writeFileSync(join(fixtureWeb, 'index.html'), '<!doctype html><title>onebox fixture</title>');
    writeFileSync(join(fixtureWeb, 'assets', 'a.js'), 'export {}');
    await buildLiveDcBundle({ outDir: join(dir, 'dist'), web: { from: fixtureWeb }, logger: silent });
    box = join(dir, 'box');
    mkdirSync(box);
    execFileSync('cp', ['-R', join(dir, 'dist'), join(box, 'dist')]);
    bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'aws'), `#!/bin/sh\necho '${JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET })}'\n`);
    chmodSync(join(bin, 'aws'), 0o755);
    feedFile = join(dir, 'feed.json');
    writeFileSync(feedFile, JSON.stringify({
      incidents: [{ itemId: '868702', latitude: 26.093417, longitude: -80.226583 }], closures: [], construction: [], congestion: [], disabledVehicles: [],
      details: { 868702: { title: 'Crash', description: 'Crash on I-595 West at Davie Rd. 2 right lanes blocked.', fields: [] } },
    }));
    standin = createDcStandin({ processingDelayMs: 1, curationDelayMs: 1, assetRows: [], tokens: { [ACCESS_TOKEN]: 'admin' }, logger: silent });
    upstream = await standin.listen(0);
    tokens = await startTokenServer();

    child = spawn(process.execPath, [join(box, 'dist', 'live-dc-sync.mjs'), '--feed', feedFile, '--interval', '1'], {
      cwd: box, stdio: ['ignore', 'pipe', 'pipe'],
      env: envFor({ LIVE_DC_HTTP_PORT: '0', LIVE_DC_HTTP_HOST: '127.0.0.1', LIVE_DEMO_PASSWORD_HASH: HASH }),
    });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    base = await waitFor(() => /live-dc http listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1]);
  });

  after(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await new Promise(resolve => child.once('exit', resolve));
    }
    await tokens?.close();
    await upstream?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('healthz is open and reports a finished cycle', async () => {
    const health = await waitFor(async () => {
      const body = await (await fetch(`${base}/healthz`)).json();
      return body.lastCycleAt ? body : null;
    });
    assert.equal(health.ok, true);
    assert.deepEqual(Object.keys(health).sort(), ['lastCycleAt', 'ok']);
  });

  test('everything else needs the password', async () => {
    assert.equal((await fetch(`${base}/api/live-dc/classes`)).status, 401);
    assert.equal((await fetch(`${base}/`, { redirect: 'manual' })).status, 302);
    const response = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie').split(';')[0];
  });

  test('serves the web build and the read routes from the same process', async () => {
    const get = path => fetch(`${base}${path}`, { headers: { cookie } });
    assert.match(await (await get('/?demo=i595')).text(), /onebox fixture/);
    const classes = await (await get('/api/live-dc/classes')).json();
    assert.ok(classes.classes.some(entry => entry.className === LIVE_CLASS.EVENTS));
    const fromDc = await waitFor(async () => {
      const body = await (await get('/api/i595/live-events?source=dataconnect')).json();
      return body.events?.length ? body : null;
    });
    assert.ok(fromDc.events.some(event => String(event.id ?? event.fl511Id ?? '').includes('868702') || JSON.stringify(event).includes('868702')));
    const fl511 = await (await get('/api/i595/live-events')).json();
    assert.ok(JSON.stringify(fl511).includes('868702'), 'shares the sync FL511 service (fixture feed)');
    const dc = await get('/api/dataconnect/classes');
    assert.equal(dc.status, 200);
    assert.ok((await dc.json()).classes.length > 0);
    const statusFile = await (await get('/status/live-dc-status.json')).json();
    assert.equal(statusFile.dcWrite, 'ok');
    assert.equal((await fetch(`${base}/api/dataconnect/signin/start`, { method: 'POST', headers: { cookie } })).status, 404);
  });

  test('service client from the fake aws CLI reaches the readers; nothing secret is logged', () => {
    assert.ok(tokens.posts.length >= 2);
    for (const post of tokens.posts) {
      assert.equal(post.grant_type, 'client_credentials');
      assert.equal(post.client_id, CLIENT_ID);
    }
    for (const leaked of [PASSWORD, HASH, CLIENT_ID, CLIENT_SECRET, ACCESS_TOKEN]) assert.ok(!(stdout + stderr).includes(leaked), leaked);
  });

  test('SIGINT stops the loop and the host', async () => {
    child.kill('SIGINT');
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.equal(code, 0);
    await assert.rejects(fetch(`${base}/healthz`));
  });

  test('port set without a password hash refuses to start (exit 2)', async () => {
    const run = spawn(process.execPath, [join(box, 'dist', 'live-dc-sync.mjs'), '--feed', feedFile], {
      cwd: box, stdio: ['ignore', 'pipe', 'pipe'], env: envFor({ LIVE_DC_HTTP_PORT: '0' }),
    });
    let err = '';
    run.stderr.on('data', chunk => { err += chunk; });
    const code = await new Promise(resolve => run.once('exit', resolve));
    assert.equal(code, 2);
    assert.match(err, /LIVE_DEMO_PASSWORD_HASH/);
  });
});

describe('--hash-password', () => {
  test('reads the password from stdin and prints only a verifiable scrypt hash', () => {
    const out = execFileSync(process.execPath, [join(ROOT, 'tools', 'live-dc-sync.mjs'), '--hash-password'], {
      input: 'typed-demo-password-99\n', env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    const hash = out.trim();
    assert.match(hash, /^scrypt\$16384\$8\$1\$/);
    assert.equal(verifyPassword('typed-demo-password-99', hash), true);
    assert.ok(!out.includes('typed-demo-password-99'));
  });

  test('an empty password is refused', () => {
    assert.throws(() => execFileSync(process.execPath, [join(ROOT, 'tools', 'live-dc-sync.mjs'), '--hash-password'], {
      input: '\n', env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'],
    }), error => error.status === 2);
  });
});
