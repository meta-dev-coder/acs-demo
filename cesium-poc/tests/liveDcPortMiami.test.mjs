/**
 * The PortMiami Digital Twin on the EC2 demo host: /portmiami/ behind the same password, its API mounted
 * in-process and read-only (except the question POST), its stores seeded once into the state directory,
 * and the release options that carry it. Offline: a fake PortMiami API module, no network.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../server/liveDc/demoAuth.mjs';
import { createDemoHost } from '../server/liveDc/demoHost.mjs';
import { loadPortMiami } from '../server/liveDc/portMiami.mjs';
import { PORTMIAMI_BASE, PORTMIAMI_WEB_PASSTHROUGH, parseBundleArgs, portMiamiWebEnv } from '../tools/build-live-dc-bundle.mjs';

const PASSWORD = 'Demo-Pass-Only-In-Tests-7731';
const HASH = hashPassword(PASSWORD, { N: 1024 });
const quiet = { log() {}, info() {}, warn() {}, error() {} };

function fakePortMiami() {
  const calls = [];
  return {
    calls,
    async handle(req, res) {
      const { pathname } = new URL(req.url, 'http://x');
      calls.push(`${req.method} ${pathname}`);
      if (pathname === '/api/portmiami/unknown') return false;
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pathname }));
      return true;
    },
    async stop() {},
  };
}

describe('demo host: PortMiami at /portmiami/', () => {
  let dir, base, server, pm, cookie;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'live-dc-pm-'));
    const web = join(dir, 'web');
    mkdirSync(join(web, 'portmiami', 'assets'), { recursive: true });
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>I-595 fixture</title>');
    writeFileSync(join(web, 'portmiami', 'index.html'), '<!doctype html><title>PortMiami fixture</title>');
    writeFileSync(join(web, 'portmiami', 'assets', 'index-abc.js'), 'console.log(1)');
    pm = fakePortMiami();
    ({ server } = createDemoHost({ passwordHash: HASH, webDir: web, logger: quiet, portMiami: pm }));
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
  const get = (path, init = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init, headers: { cookie, ...(init.headers ?? {}) } });

  test('needs the same session as the I-595 app', async () => {
    const page = await fetch(`${base}/portmiami/`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login?next=%2Fportmiami%2F');
    const api = await fetch(`${base}/api/portmiami/designs`);
    assert.equal(api.status, 401);
    assert.deepEqual(pm.calls, [], 'nothing reaches PortMiami without a session');
  });

  test('serves its frontend, with the trailing slash its relative data URLs need', async () => {
    const bare = await get('/portmiami');
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get('location'), '/portmiami/');
    const page = await get('/portmiami/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /PortMiami fixture/);
    const asset = await get('/portmiami/assets/index-abc.js');
    assert.match(asset.headers.get('cache-control'), /immutable/);
    assert.match(await (await get('/')).text(), /I-595 fixture/, 'the I-595 app is unchanged');
  });

  test('its API is read-only, except the question POST', async () => {
    assert.equal((await get('/api/portmiami/designs')).status, 200);
    assert.equal((await get('/api/portmiami/ask', { method: 'POST', body: '{"question":"x"}' })).status, 200);
    for (const method of ['PUT', 'POST', 'DELETE']) {
      assert.equal((await get('/api/portmiami/designs/a', { method, body: '{}' })).status, 405, method);
    }
    assert.equal((await get('/api/portmiami/unknown')).status, 404);
    assert.deepEqual(pm.calls, ['GET /api/portmiami/designs', 'POST /api/portmiami/ask', 'GET /api/portmiami/unknown']);
  });

  test('without the PortMiami bundle its routes are simply not found', async () => {
    const { server: plain } = createDemoHost({ passwordHash: HASH, webDir: join(dir, 'web'), logger: quiet });
    await new Promise(resolve => plain.listen(0, '127.0.0.1', resolve));
    const plainBase = `http://127.0.0.1:${plain.address().port}`;
    const signin = await fetch(`${plainBase}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    const plainCookie = (signin.headers.get('set-cookie') ?? '').split(';')[0];
    const r = await fetch(`${plainBase}/api/portmiami/designs`, { headers: { cookie: plainCookie } });
    assert.equal(r.status, 404);
    plain.closeAllConnections?.();
    await new Promise(resolve => plain.close(resolve));
  });
});

describe('loadPortMiami', () => {
  test('off without a bundle', async () => {
    assert.equal(await loadPortMiami({ env: {}, logger: quiet }), null);
    assert.equal(await loadPortMiami({ env: { LIVE_DC_PORTMIAMI_DIR: '/nonexistent' }, logger: quiet }), null);
  });

  test('seeds the stores into the state directory once, and never overwrites them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-dc-pm-load-'));
    try {
      const bundle = join(dir, 'portmiami'), home = join(dir, 'state');
      mkdirSync(join(bundle, 'seed'), { recursive: true });
      writeFileSync(join(bundle, 'api.mjs'), '// fake');
      writeFileSync(join(bundle, 'seed', 'design-alternatives.json'), '{"seed":1}');
      writeFileSync(join(bundle, 'seed', 'asset-geometry.json'), '{"seed":2}');
      let options = null;
      const importModule = async () => ({
        loadFl511Config: () => ({ port: 1 }),
        createDesignStore: ({ path }) => ({ path }), createGeometryStore: ({ path }) => ({ path }),
        createLiveTrafficApi: o => { options = o; return { handle: async () => true, stop: async () => {} }; },
      });
      const env = { LIVE_DC_PORTMIAMI_DIR: bundle, HOME: home, PORTMIAMI_GEOMETRY_EDIT: 'local' };
      const pm = await loadPortMiami({ env, logger: quiet, importModule });
      assert.equal(pm.stores.design, join(home, 'portmiami', 'design-alternatives.json'));
      assert.equal(readFileSync(pm.stores.design, 'utf8'), '{"seed":1}');
      assert.equal(options.designStore.path, pm.stores.design);
      assert.equal(options.roadsPath, join(bundle, 'data', 'portmiami_roads_merged.geojson'));
      assert.equal(options.env.PORTMIAMI_GEOMETRY_EDIT, '', 'editing is never switched on here');
      writeFileSync(pm.stores.design, '{"edited":true}');
      await loadPortMiami({ env, logger: quiet, importModule });
      assert.equal(readFileSync(pm.stores.design, 'utf8'), '{"edited":true}', 'a new release does not overwrite the store');
      assert.ok(existsSync(pm.stores.geometry));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('release options', () => {
  test('PortMiami is in the release unless --skip-portmiami', () => {
    assert.equal(parseBundleArgs([]).portmiami, true);
    assert.equal(parseBundleArgs(['--skip-portmiami']).portmiami, false);
  });

  test('its web build gets its base path and only its own public browser keys', () => {
    const env = portMiamiWebEnv({
      shellEnv: { PATH: '/bin', AWS_SECRET_ACCESS_KEY: 'x', VITE_GOOGLE_MAPS_API_KEY: 'shell-key' },
      fileEnv: { VITE_CESIUM_ION_TOKEN: 'file-token', VITE_LIVE_DC: 'true', VITE_SOMETHING_ELSE: 'no' },
    });
    assert.equal(env.PORTMIAMI_BASE, PORTMIAMI_BASE);
    assert.equal(env.VITE_GOOGLE_MAPS_API_KEY, 'shell-key');
    assert.equal(env.VITE_CESIUM_ION_TOKEN, 'file-token');
    assert.deepEqual(Object.keys(env).filter(k => k.startsWith('VITE_')).sort(), ['VITE_CESIUM_ION_TOKEN', 'VITE_GOOGLE_MAPS_API_KEY']);
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.deepEqual([...PORTMIAMI_WEB_PASSTHROUGH].sort(), ['VITE_CESIUM_ION_TOKEN', 'VITE_ENABLE_STREET_VIEW', 'VITE_GOOGLE_MAPS_API_KEY']);
  });
});
