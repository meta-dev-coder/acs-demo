import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_ENVIRONMENTS, DEFAULT_BASE_ENVIRONMENT, LOAD_STATES, createGooglePhotorealistic3DService } from '../src/basePhotorealistic3D.js';

/** Enough of a Viewer to observe exactly what the service touches — and what it leaves alone. */
function fakeViewer() {
  const primitives = [];
  const dataSources = [{ name: 'existing corridor layer', show: true }];
  return {
    renders: 0,
    dataSources,
    scene: {
      globe: { show: true },
      primitives: {
        add(primitive) { primitives.push(primitive); return primitive; },
        remove(primitive) { const at = primitives.indexOf(primitive); if (at >= 0) primitives.splice(at, 1); return at >= 0; },
        get length() { return primitives.length; },
        contains: primitive => primitives.includes(primitive),
        all: () => primitives,
      },
      requestRender() { this.renders = (this.renders ?? 0) + 1; },
    },
    isDestroyed: () => false,
  };
}

const fakeTileset = () => ({ show: false, isFake: true });
const silent = { error() {}, warn() {}, log() {} };

test('the default base environment is the existing basemap', () => {
  assert.equal(DEFAULT_BASE_ENVIRONMENT, BASE_ENVIRONMENTS.SATELLITE);
  const viewer = fakeViewer();
  const service = createGooglePhotorealistic3DService(viewer, { apiKey: 'test-key', createTileset: fakeTileset });
  // Creating the service must not load anything or disturb the scene.
  assert.equal(service.isLoaded(), false);
  assert.equal(service.loadState(), LOAD_STATES.IDLE);
  assert.equal(viewer.scene.globe.show, true);
  assert.equal(viewer.scene.primitives.length, 0);
});

test('enabling lazily creates exactly one tileset and hides the globe', async () => {
  const viewer = fakeViewer();
  let created = 0;
  const service = createGooglePhotorealistic3DService(viewer, {
    apiKey: 'test-key', createTileset: async () => { created++; return fakeTileset(); },
  });
  assert.deepEqual(await service.enable(), { ok: true });
  assert.equal(created, 1);
  assert.equal(viewer.scene.primitives.length, 1);
  assert.equal(service.tileset().show, true);
  assert.equal(viewer.scene.globe.show, false);
  assert.equal(service.loadState(), LOAD_STATES.READY);
});

test('toggling back hides the tileset instead of destroying it, and restores the basemap', async () => {
  const viewer = fakeViewer();
  let created = 0;
  const service = createGooglePhotorealistic3DService(viewer, {
    apiKey: 'test-key', createTileset: async () => { created++; return fakeTileset(); },
  });
  await service.enable();
  const instance = service.tileset();
  service.disable();
  assert.equal(instance.show, false);
  assert.equal(viewer.scene.globe.show, true);
  assert.equal(viewer.scene.primitives.contains(instance), true, 'the tileset stays in the scene');

  // Switching back must reuse the cached instance — no second download, no second primitive.
  await service.enable();
  assert.equal(created, 1);
  assert.equal(viewer.scene.primitives.length, 1);
  assert.equal(service.tileset(), instance);
  assert.equal(instance.show, true);
});

test('concurrent activations still create only one tileset', async () => {
  const viewer = fakeViewer();
  let created = 0;
  const service = createGooglePhotorealistic3DService(viewer, {
    apiKey: 'test-key',
    createTileset: async () => { created++; await new Promise(resolve => setTimeout(resolve, 5)); return fakeTileset(); },
  });
  await Promise.all([service.enable(), service.enable(), service.load()]);
  assert.equal(created, 1);
  assert.equal(viewer.scene.primitives.length, 1);
});

test('a missing API key never calls Google and leaves the basemap active', async () => {
  const viewer = fakeViewer();
  let called = false;
  const service = createGooglePhotorealistic3DService(viewer, {
    apiKey: '   ', createTileset: async () => { called = true; return fakeTileset(); }, logger: silent,
  });
  const result = await service.enable();
  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'MISSING_API_KEY');
  assert.match(result.message, /VITE_GOOGLE_MAPS_API_KEY/);
  assert.equal(service.hasApiKey(), false);
  assert.equal(viewer.scene.globe.show, true, 'the existing basemap must stay visible');
  assert.equal(viewer.scene.primitives.length, 0);
});

test('a failed load falls back to the basemap and can be retried', async () => {
  const viewer = fakeViewer();
  let attempts = 0;
  const service = createGooglePhotorealistic3DService(viewer, {
    apiKey: 'test-key', logger: silent,
    // Mirrors a real failure: quota exceeded, Map Tiles API disabled, bad key, network down.
    createTileset: async () => { attempts++; if (attempts === 1) throw new Error('403 Map Tiles API disabled'); return fakeTileset(); },
  });
  const failed = await service.enable();
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'LOAD_FAILED');
  assert.match(failed.message, /could not be loaded/);
  assert.equal(viewer.scene.globe.show, true, 'the globe must never be hidden without tiles to replace it');
  assert.equal(viewer.scene.primitives.length, 0);
  assert.equal(service.loadState(), LOAD_STATES.ERROR);
  assert.match(service.lastError().message, /Map Tiles API disabled/);

  assert.deepEqual(await service.enable(), { ok: true }, 'a later attempt succeeds once the cause is fixed');
  assert.equal(attempts, 2);
  assert.equal(viewer.scene.globe.show, false);
});

test('base-environment changes never touch corridor data sources', async () => {
  const viewer = fakeViewer();
  const before = structuredClone(viewer.dataSources);
  const service = createGooglePhotorealistic3DService(viewer, { apiKey: 'test-key', createTileset: fakeTileset });
  await service.enable();
  service.disable();
  await service.enable();
  assert.deepEqual(viewer.dataSources, before, 'layer visibility and data sources are untouched');
  // Only the tileset was ever added to the scene.
  assert.deepEqual(viewer.scene.primitives.all().map(primitive => primitive.isFake), [true]);
});

test('every toggle requests a render, since the scene may not redraw on its own', async () => {
  const viewer = fakeViewer();
  const service = createGooglePhotorealistic3DService(viewer, { apiKey: 'test-key', createTileset: fakeTileset });
  viewer.scene.renders = 0;
  await service.enable();
  assert.equal(viewer.scene.renders, 1);
  service.disable();
  assert.equal(viewer.scene.renders, 2);
});

test('destroy tears the tileset out, and is not what an ordinary toggle does', async () => {
  const viewer = fakeViewer();
  const service = createGooglePhotorealistic3DService(viewer, { apiKey: 'test-key', createTileset: fakeTileset });
  await service.enable();
  service.destroy();
  assert.equal(viewer.scene.primitives.length, 0);
  assert.equal(service.isLoaded(), false);
  assert.equal(viewer.scene.globe.show, true);
});
