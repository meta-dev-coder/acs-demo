/**
 * EC2 demo host: password gate, static frontend and the read-only API allowlist. Offline, fake handlers.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { hashPassword } from '../server/liveDc/demoAuth.mjs';
import { createDemoHost } from '../server/liveDc/demoHost.mjs';

const PASSWORD = 'Demo-Pass-Only-In-Tests-7731';
const HASH = hashPassword(PASSWORD, { N: 1024 });

function recordingLogger() {
  const lines = [];
  const log = (...args) => lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  return { lines, logger: { log, info: log, warn: log, error: log } };
}

function fakeApi() {
  const calls = [];
  return {
    calls,
    async handle(req, res) {
      const { pathname } = new URL(req.url, 'http://x');
      if (!pathname.startsWith('/api/')) return false;
      calls.push(`${req.method} ${pathname}`);
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, method: req.method, pathname }));
      return true;
    },
  };
}

/** Raw request so paths such as /../ are sent unnormalised. */
function raw(base, path, { method = 'GET', headers = {}, body } = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path, method, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function startHost(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'live-dc-host-'));
  const web = join(dir, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>I-595 fixture</title>');
  writeFileSync(join(web, 'assets', 'app-1234.js'), 'console.log("fixture");');
  writeFileSync(join(dir, 'secret.txt'), 'TOP-SECRET-OUTSIDE-WEB');
  const api = fakeApi();
  const { lines, logger } = recordingLogger();
  let now = Date.now();
  const clock = { now: () => now, advance: ms => { now += ms; } };
  const host = createDemoHost({
    passwordHash: HASH, webDir: web, apiHandlers: [api], logger, now: clock.now,
    status: { healthz: () => ({ ok: true, lastCycleAt: '2026-09-29T10:00:00.000Z', secretish: 'no' }), cloud: () => ({ lastRunAt: 'x', dcWrite: 'ok' }) },
    ...options,
  });
  await new Promise(resolve => host.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${host.server.address().port}`;
  return {
    dir, api, lines, clock, host, base,
    close: async () => {
      host.server.closeAllConnections?.();
      await new Promise(resolve => host.server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const login = (base, password, extra = {}) => fetch(`${base}/api/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password, ...extra }), redirect: 'manual',
});
const cookieOf = response => (response.headers.get('set-cookie') ?? '').split(';')[0];

describe('demo host: login', () => {
  let ctx;
  before(async () => { ctx = await startHost(); });
  after(() => ctx.close());

  test('GET /login serves the form without a session', async () => {
    const response = await fetch(`${ctx.base}/login`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const html = await response.text();
    assert.match(html, /type="password"/);
    assert.match(html, /\/api\/login/);
  });

  test('wrong password -> 401, no cookie; correct -> HttpOnly SameSite=Strict 8 h cookie', async () => {
    const wrong = await login(ctx.base, 'nope');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('set-cookie'), null);
    const right = await login(ctx.base, PASSWORD);
    assert.equal(right.status, 200);
    const cookie = right.headers.get('set-cookie');
    assert.match(cookie, /^live_dc_session=v1\.\d+\.[^;]+; /);
    for (const attr of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=28800']) assert.ok(cookie.includes(attr), attr);
    const body = await right.json();
    assert.deepEqual(body, { ok: true, next: '/?demo=i595' });
  });

  test('next is kept only when it is a same-origin path', async () => {
    assert.equal((await (await login(ctx.base, PASSWORD, { next: '/?demo=i595&live=1' })).json()).next, '/?demo=i595&live=1');
    for (const next of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', 'javascript:alert(1)']) {
      assert.equal((await (await login(ctx.base, PASSWORD, { next })).json()).next, '/?demo=i595', next);
    }
  });

  test('form-encoded login works too', async () => {
    const response = await fetch(`${ctx.base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `password=${encodeURIComponent(PASSWORD)}`,
    });
    assert.equal(response.status, 200);
  });

  test('logout clears the cookie', async () => {
    const response = await fetch(`${ctx.base}/api/logout`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /^live_dc_session=; .*Max-Age=0/);
  });

  test('the password never appears in logs or responses', () => {
    assert.ok(ctx.lines.length > 0);
    assert.ok(!ctx.lines.join('\n').includes(PASSWORD));
    assert.ok(!ctx.lines.join('\n').includes(HASH));
    assert.ok(ctx.lines.some(line => /login failed/.test(line)));
  });
});

describe('demo host: lockout', () => {
  let ctx;
  before(async () => { ctx = await startHost(); });
  after(() => ctx.close());

  test('5 failures lock the address for 15 minutes, even for the right password', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await login(ctx.base, `wrong-${i}`)).status, 401);
    const locked = await login(ctx.base, PASSWORD);
    assert.equal(locked.status, 429);
    assert.equal(locked.headers.get('retry-after'), '900');
    assert.equal(locked.headers.get('set-cookie'), null);
    ctx.clock.advance(15 * 60_000);
    assert.equal((await login(ctx.base, PASSWORD)).status, 200);
  });

  test('oversized or malformed login bodies are refused without crashing', async () => {
    const big = await fetch(`${ctx.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(20_000) }) });
    assert.equal(big.status, 413);
    const bad = await fetch(`${ctx.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${ctx.base}/api/login`)).status, 405);
  });
});

describe('demo host: gate, static files, read-only API', () => {
  let ctx, cookie;
  before(async () => {
    ctx = await startHost();
    cookie = cookieOf(await login(ctx.base, PASSWORD));
  });
  after(() => ctx.close());
  const withCookie = (path, init = {}) => fetch(`${ctx.base}${path}`, { redirect: 'manual', ...init, headers: { cookie, ...init.headers } });

  test('/healthz is open and returns only ok and lastCycleAt', async () => {
    const response = await fetch(`${ctx.base}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, lastCycleAt: '2026-09-29T10:00:00.000Z' });
  });

  test('pages redirect to /login and APIs answer 401 without a session', async () => {
    for (const path of ['/', '/?demo=i595', '/assets/app-1234.js', '/index.html', '/status/live-dc-status.json']) {
      const response = await fetch(`${ctx.base}${path}`, { redirect: 'manual' });
      assert.equal(response.status, 302, path);
      assert.equal(response.headers.get('location'), `/login?next=${encodeURIComponent(path)}`, path);
    }
    for (const [method, path] of [['GET', '/api/live-dc/classes'], ['GET', '/api/i595/live-events?source=dataconnect'],
      ['POST', '/api/live-dc/class/abc/curated-data'], ['GET', '/api/i595/camera/123/snapshot'], ['GET', '/api/dataconnect/classes']]) {
      const response = await fetch(`${ctx.base}${path}`, { method, redirect: 'manual' });
      assert.equal(response.status, 401, `${method} ${path}`);
    }
    assert.deepEqual(ctx.api.calls, []);
  });

  test('tampered and expired cookies are rejected', async () => {
    const [name, value] = cookie.split('=');
    const parts = value.split('.');
    const tampered = `${name}=${parts[0]}.${Number(parts[1]) + 10_000_000}.${parts[2]}.${parts[3]}`;
    assert.equal((await fetch(`${ctx.base}/api/live-dc/classes`, { headers: { cookie: tampered } })).status, 401);
    assert.equal((await fetch(`${ctx.base}/api/live-dc/classes`, { headers: { cookie: `${name}=garbage` } })).status, 401);
    const other = await startHost();
    try {
      const foreign = cookieOf(await login(other.base, PASSWORD));
      assert.equal((await fetch(`${ctx.base}/api/live-dc/classes`, { headers: { cookie: foreign } })).status, 401, 'other process key');
      other.clock.advance(8 * 3600_000 + 1);
      assert.equal((await fetch(`${other.base}/api/live-dc/classes`, { headers: { cookie: foreign } })).status, 401, 'expired');
    } finally { await other.close(); }
  });

  test('with a session: index, assets and SPA entry are served', async () => {
    const index = await withCookie('/?demo=i595');
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.equal(index.headers.get('cache-control'), 'no-cache');
    assert.match(await index.text(), /I-595 fixture/);
    const asset = await withCookie('/assets/app-1234.js');
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
    assert.match(asset.headers.get('cache-control'), /immutable/);
    const head = await withCookie('/assets/app-1234.js', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await withCookie('/missing.js')).status, 404);
  });

  test('no path traversal out of web/', async () => {
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/assets/%2e%2e/%2e%2e/secret.txt',
      '/..%5csecret.txt', '/%00', '/assets/../../secret.txt']) {
      const response = await raw(ctx.base, path, { headers: { cookie } });
      assert.ok([400, 404].includes(response.status), `${path} -> ${response.status}`);
      assert.ok(!response.text.includes('TOP-SECRET'), path);
    }
  });

  test('read routes pass through with a session', async () => {
    ctx.api.calls.length = 0;
    for (const [method, path] of [['GET', '/api/live-dc/classes'], ['GET', '/api/live-dc/status'], ['GET', '/api/i595/live-events?source=dataconnect'],
      ['POST', '/api/live-dc/class/abc/curated-data'], ['POST', '/api/dataconnect/class/abc/curated-data'], ['GET', '/api/dataconnect/classes'],
      ['GET', '/api/i595/camera/123/snapshot'], ['GET', '/api/i595/message-signs']]) {
      const response = await withCookie(path, { method, ...(method === 'POST' ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}) });
      assert.equal(response.status, 200, `${method} ${path}`);
    }
    assert.equal(ctx.api.calls.length, 8);
  });

  test('no write route exists: other methods and the DataConnect sign-in are refused before any handler', async () => {
    ctx.api.calls.length = 0;
    for (const [method, path, status] of [['POST', '/api/live-dc/classes', 405], ['PUT', '/api/live-dc/class/abc/curated-data', 405],
      ['DELETE', '/api/i595/live-events', 405], ['POST', '/api/i595/live-events', 405], ['PATCH', '/api/dataconnect/classes', 405],
      ['POST', '/api/dataconnect/signin/start', 404], ['POST', '/api/dataconnect/signin/cancel', 404], ['GET', '/api/dataconnect/signin/callback?code=x', 404],
      ['POST', '/api/live-dc/reset', 405], ['POST', '/api/loads/class', 405], ['POST', '/', 405]]) {
      const response = await withCookie(path, { method });
      assert.equal(response.status, status, `${method} ${path}`);
    }
    assert.deepEqual(ctx.api.calls, []);
  });

  test('the sync status file and a clear answer for the cloud-only Ask service', async () => {
    const status = await withCookie('/status/live-dc-status.json');
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { lastRunAt: 'x', dcWrite: 'ok' });
    const ask = await withCookie('/api/i595/ask', { method: 'POST', body: '{"question":"hi"}', headers: { 'content-type': 'application/json' } });
    assert.equal(ask.status, 503);
    assert.match((await ask.json()).error, /not available/);
  });
});

describe('demo host: no web build', () => {
  test('a missing web/ directory answers 503 for pages but keeps APIs', async () => {
    const ctx = await startHost({ webDir: join(tmpdir(), 'definitely-missing-web-dir-live-dc') });
    try {
      const cookie = cookieOf(await login(ctx.base, PASSWORD));
      assert.equal((await fetch(`${ctx.base}/`, { headers: { cookie } })).status, 503);
      assert.equal((await fetch(`${ctx.base}/api/live-dc/classes`, { headers: { cookie } })).status, 200);
    } finally { await ctx.close(); }
  });
});
