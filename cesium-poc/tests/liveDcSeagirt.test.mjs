/**
 * The Seagirt IFC Spatial Twin on the EC2 demo host: /seagirt/ opens it behind the same password; its APIs
 * (/api/aps, /api/ifc-spatial, /api/gmail) are mounted in-process and may write (behind the session); the two
 * OAuth callbacks are answered without the session (SameSite=Strict is not sent on a cross-site redirect) and
 * the Autodesk redirect back into the app becomes a same-site navigation. Offline: fake API module, no network.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../server/liveDc/demoAuth.mjs';
import { createDemoHost } from '../server/liveDc/demoHost.mjs';
import { loadSeagirt, sameSiteRedirect, SEAGIRT_HOME } from '../server/liveDc/seagirt.mjs';
import { parseBundleArgs, seagirtPackageDirs, SEAGIRT_PACKAGES } from '../tools/build-live-dc-bundle.mjs';
import { isExcludedPath } from '../tools/release-live-dc.mjs';

const PASSWORD = 'Demo-Pass-Only-In-Tests-7731';
const HASH = hashPassword(PASSWORD, { N: 1024 });
const quiet = { log() {}, info() {}, warn() {}, error() {} };

function fakeSeagirt() {
  const calls = [];
  return {
    calls,
    async handle(req, res) {
      const { pathname } = new URL(req.url, 'http://x');
      calls.push(`${req.method} ${pathname}`);
      if (pathname === '/api/ifc-spatial/unknown') return false;
      if (pathname === '/api/aps/callback') { sameSiteRedirect(res); res.writeHead(302, { location: '/?demo=seagirt&screen=ifc-spatial', 'set-cookie': 'aps_sid=abc; Path=/; HttpOnly; SameSite=Lax' }); res.end(); return true; }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pathname }));
      return true;
    },
    async stop() {},
  };
}

describe('demo host: Seagirt at /seagirt/', () => {
  let dir, base, server, sg, cookie;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'live-dc-sg-'));
    const web = join(dir, 'web');
    mkdirSync(web, { recursive: true });
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>app fixture</title>');
    sg = fakeSeagirt();
    ({ server } = createDemoHost({ passwordHash: HASH, webDir: web, logger: quiet, seagirt: sg }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  });
  after(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const req = (path, init = {}, withSession = true) => fetch(`${base}${path}`, { redirect: 'manual', ...init, headers: { ...(withSession ? { cookie } : {}), ...(init.headers ?? {}) } });

  test('/seagirt and /seagirt/ open the IFC Spatial Twin, behind the session', async () => {
    for (const p of ['/seagirt', '/seagirt/']) {
      const r = await req(p);
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), SEAGIRT_HOME);
    }
    const anon = await req('/seagirt/', {}, false);
    assert.equal(anon.status, 302);
    assert.match(anon.headers.get('location'), /^\/login\?next=/);
  });

  test('its APIs need the session, and may write behind it', async () => {
    assert.equal((await req('/api/ifc-spatial/models', {}, false)).status, 401);
    for (const [method, path] of [['GET', '/api/ifc-spatial/models'], ['POST', '/api/ifc-spatial/prepare?file=a.ifc'], ['PUT', '/api/ifc-spatial/placement?key=k'], ['POST', '/api/ifc-spatial/reports?file=a.ifc'],
      ['GET', '/api/aps/status'], ['POST', '/api/gmail/send'], ['POST', '/api/gmail/disconnect']]) {
      const r = await req(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      assert.equal(r.status, 200, `${method} ${path}`);
    }
    assert.equal((await req('/api/ifc-spatial/unknown')).status, 404);
    // Other APIs stay read-only.
    assert.equal((await req('/api/live-dc/anything', { method: 'POST', body: '{}' })).status, 405);
  });

  test('the OAuth callbacks are answered without the session; the Autodesk return is a same-site page', async () => {
    const g = await req('/api/gmail/auth/callback?state=s&code=c', {}, false);
    assert.equal(g.status, 200);
    const a = await req('/api/aps/callback?state=s&code=c', {}, false);
    assert.equal(a.status, 200, 'not a 302: the browser would not send the session cookie on a cross-site redirect chain');
    assert.match(a.headers.get('content-type'), /text\/html/);
    assert.match(a.headers.get('set-cookie') ?? '', /aps_sid=abc/, 'the sign-in cookie is kept');
    const html = await a.text();
    assert.match(html, /location\.replace\("\/\?demo=seagirt&screen=ifc-spatial"\)/);
    // Only GET reaches a callback without the session; other API paths still need it.
    assert.equal((await req('/api/aps/callback', { method: 'POST', body: '{}' }, false)).status, 401);
    assert.equal((await req('/api/aps/login', {}, false)).status, 401);
  });
});

test('same-site redirect: only a path on this site; other targets keep their 302', () => {
  const run = location => {
    const out = {};
    const res = { writeHead(status, headers) { out.status = status; out.headers = headers; return res; }, end(body) { out.body = body; } };
    sameSiteRedirect(res);
    res.writeHead(302, { location });
    res.end();
    return out;
  };
  assert.equal(run('/?demo=seagirt').status, 200);
  for (const bad of ['https://evil.example/', '//evil.example/x', '/\\evil', 'javascript:alert(1)']) assert.equal(run(bad).status, 302, bad);
  assert.match(run('/a"<b').body, /&quot;&lt;b/, 'the attribute is escaped');
});

test('loader: off without a bundle; on with one, every store in the state directory', async () => {
  assert.equal(await loadSeagirt({ env: {}, logger: quiet }), null);
  const dir = mkdtempSync(join(tmpdir(), 'live-dc-sg-load-'));
  try {
    const bundle = join(dir, 'seagirt');
    mkdirSync(bundle);
    writeFileSync(join(bundle, 'api.mjs'), 'export function createSeagirtApis({ stateDir }) { globalThis.__sgState = stateDir; return { handlers: [{ handle: async () => true }], configured: { aps: true, gmail: false } }; }');
    const loaded = await loadSeagirt({ env: { LIVE_DC_SEAGIRT_DIR: bundle, HOME: join(dir, 'home') }, logger: quiet });
    assert.equal(loaded.stateDir, join(dir, 'home', 'seagirt'));
    assert.equal(globalThis.__sgState, join(dir, 'home', 'seagirt'));
    assert.ok(existsSync(loaded.stateDir));
    assert.deepEqual(loaded.configured, { aps: true, gmail: false });
  } finally { rmSync(dir, { recursive: true, force: true }); delete globalThis.__sgState; }
});

test('build: Seagirt is in the release by default (--skip-seagirt leaves it out); its packages resolve without native binaries', () => {
  assert.equal(parseBundleArgs([]).seagirt, true);
  assert.equal(parseBundleArgs(['--skip-seagirt']).seagirt, false);
  const dirs = seagirtPackageDirs();
  for (const p of SEAGIRT_PACKAGES) assert.ok(dirs.includes(`node_modules/${p}`), p);
  assert.ok(!dirs.some(d => d.includes('@napi-rs')), 'no platform-specific optional packages');
});

test('release filter: library files named like tokens ship with the Seagirt packages; secrets never do', () => {
  for (const keep of ['seagirt/node_modules/@fast-csv/parse/build/src/parser/Token.js', 'seagirt/node_modules/google-auth-library/build/src/gtoken', 'seagirt/node_modules/google-auth-library/build/src/auth/idtokenclient.js'])
    assert.equal(isExcludedPath(keep), false, keep);
  for (const drop of ['seagirt/node_modules/x/.env', 'seagirt/node_modules/x/server.pem', 'seagirt/node_modules/x/id_rsa', 'token.json', '.dc-token.json', 'web/assets/token.txt', 'seagirt/token.json'])
    assert.equal(isExcludedPath(drop), true, drop);
});
