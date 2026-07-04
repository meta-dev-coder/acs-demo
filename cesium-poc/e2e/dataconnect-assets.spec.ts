/**
 * dataconnect-assets.spec.ts — Component 4/5: DataConnect-backed Scenario A asset layer.
 * See docs/superpowers/specs/2026-07-04-dataconnect-scenario-a-demo-design.md (Testing section).
 *
 * This spec spawns tools/dataconnect_shim.py itself (child_process, cwd = repo root) in
 * `beforeAll` and kills it in `afterAll` — playwright.config's single `webServer` entry stays
 * vite-only (it only boots the app; it knows nothing about DataConnect). The app is loaded with
 * `?dc=http://localhost:8787` so cesium-poc/src/dataconnect.js talks to our spawned shim instead
 * of its `http://localhost:8787` default (same value here, but explicit per the design's client
 * contract: `?dc=` query param selects the base URL).
 *
 * Tests:
 *  DC1. toggling #btn-dc-assets on loads >=5000 scored assets, all three risk bands populated
 *       (window.__dcAssets.{count,bands}).
 *  DC2. the KPI row's three band tiles (#dc-asset-kpis .dc-asset-kpi .v) sum to
 *       window.__dcAssets.count.
 *  DC3. clicking a rendered asset point (found via a small scene.pick() grid search around a
 *       known asset's real lon/lat from tools/dataconnect-data/asset_registry.json) opens
 *       #dc-asset-panel with a score + risk-driver breakdown.
 *  DC4. killing the shim (SIGTERM) flips #dc-status to "offline" (after having been "online")
 *       while window.__dcAssets.count is left untouched (keep-previous-on-failure). Runs LAST —
 *       it kills the one shim process the whole file shares.
 *
 * Run:
 *   cd cesium-poc && npm run e2e -- e2e/dataconnect-assets.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { shoot } from './helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.join(__dirname, '..', '..'); // cesium-poc/e2e -> cesium-poc -> repo root

const SHIM_PORT = 8787;
const SHIM_URL  = `http://localhost:${SHIM_PORT}`;
const APP_URL   = `/?dc=${SHIM_URL}`;

// ---------------------------------------------------------------------------
// A known real asset (lon/lat straight from the exported class data, same fields
// scoringA.js's adaptDataConnectAssets() reads: "X Coordinates" / "Y Coordinates") so DC3 can
// point the camera at a location guaranteed to have a rendered point.
// ---------------------------------------------------------------------------
const ASSET_REGISTRY_PATH = path.join(REPO_ROOT, 'tools', 'dataconnect-data', 'asset_registry.json');
const sampleTarget = (() => {
  const rows: any[] = JSON.parse(fs.readFileSync(ASSET_REGISTRY_PATH, 'utf-8'));
  const row = rows.find(
    (r) => Number.isFinite(Number(r['X Coordinates'])) && Number.isFinite(Number(r['Y Coordinates'])),
  );
  if (!row) throw new Error('No asset_registry.json row with usable X/Y Coordinates found');
  return { lon: Number(row['X Coordinates']), lat: Number(row['Y Coordinates']) };
})();

// ---------------------------------------------------------------------------
// Shim lifecycle — one process shared by every test in this file.
// ---------------------------------------------------------------------------
let shim: ChildProcess | null = null;

async function waitForShimReady(timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // No Authorization header -> 401, which still proves the server is listening.
      const res = await fetch(`${SHIM_URL}/api/data-mgmt/v1/class`);
      if (res.status === 401 || res.ok) return;
    } catch {
      // ECONNREFUSED while the process is still starting up — keep polling.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`dataconnect_shim.py did not become ready on ${SHIM_URL} within ${timeoutMs}ms`);
}

test.beforeAll(async () => {
  shim = spawn('python3', ['tools/dataconnect_shim.py', '--port', String(SHIM_PORT)], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  shim.stdout?.on('data', (d) => process.stdout.write(`[dataconnect_shim] ${d}`));
  shim.stderr?.on('data', (d) => process.stdout.write(`[dataconnect_shim] ${d}`));
  await waitForShimReady();
});

test.afterAll(async () => {
  if (shim && !shim.killed) {
    shim.kill('SIGTERM');
  }
  shim = null;
});

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

/** Navigate with ?dc=<shim> and wait for the base twin (viewer + at least one vehicle) to be up —
 * same readiness bar as helpers.ts's waitForReady(), just against a URL carrying the query param. */
async function gotoWithDc(page: Page): Promise<void> {
  await page.goto(APP_URL);
  await page.waitForFunction(() => !!(window as any).__viewer, { timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const viewer = (window as any).__viewer;
      return !!viewer && viewer.entities.values.some((e: any) => e.model != null);
    },
    { timeout: 45_000, polling: 500 },
  );
}

/** Click "Assets (DataConnect)" and wait for the fetch->adapt->score->place pipeline to finish
 * (window.__dcAssets.count reaches minCount). Generous timeout — swiftshader + a real HTTP round
 * trip through 6 paginated classes. */
async function enableDcLayer(page: Page, minCount = 5000, timeout = 60_000): Promise<void> {
  await page.click('#btn-dc-assets');
  await page.waitForFunction(
    (min) => {
      const d = (window as any).__dcAssets;
      return !!d && typeof d.count === 'number' && d.count >= min;
    },
    minCount,
    { timeout, polling: 500 },
  );
}

// ---------------------------------------------------------------------------
// DC1: toggle on -> >=5000 scored assets, all three bands populated
// ---------------------------------------------------------------------------
test('DC1: enabling the DataConnect layer loads >=5000 scored assets across all three risk bands', async ({ page }) => {
  await gotoWithDc(page);
  await enableDcLayer(page);

  const dc = await page.evaluate(() => (window as any).__dcAssets);
  expect(dc).toBeTruthy();
  expect(dc.count).toBeGreaterThanOrEqual(5000);
  expect(dc.bands.red).toBeGreaterThan(0);
  expect(dc.bands.amber).toBeGreaterThan(0);
  expect(dc.bands.green).toBeGreaterThan(0);

  await shoot(page, 'dc-dc1-assets-loaded');
});

// ---------------------------------------------------------------------------
// DC2: KPI tile numbers sum to window.__dcAssets.count
// ---------------------------------------------------------------------------
test('DC2: KPI tile counts sum to window.__dcAssets.count', async ({ page }) => {
  await gotoWithDc(page);
  await enableDcLayer(page);

  const tileValues = await page.$$eval('#dc-asset-kpis .dc-asset-kpi .v', (els) =>
    els.map((el) => parseInt(el.textContent || '0', 10)),
  );
  expect(tileValues).toHaveLength(3); // red / amber / green

  const tileSum = tileValues.reduce((a, b) => a + b, 0);
  const count: number = await page.evaluate(() => (window as any).__dcAssets.count);
  expect(tileSum).toBe(count);

  await shoot(page, 'dc-dc2-kpi-sum');
});

// ---------------------------------------------------------------------------
// DC3: pick a rendered asset -> info panel with score breakdown
// ---------------------------------------------------------------------------
test('DC3: clicking a rendered asset point opens the info panel with a score breakdown', async ({ page }) => {
  await gotoWithDc(page);
  await enableDcLayer(page);

  // Fly the camera to look straight down at a known real asset's lon/lat (EllipsoidTerrainProvider
  // is in play here — no Ion token in this checkout — so "height above ellipsoid" is exact ground
  // level, matching assetLayer.js's POINT_HEIGHT_M=3), then run a small on-screen grid search via
  // scene.pick() to find the exact pixel a point primitive rasterizes to (projection math done by
  // hand via the already-instantiated viewer.scene.globe.ellipsoid — no extra Cesium import needed
  // in-page). The actual click is a REAL Playwright mouse click at that pixel, so it exercises
  // main.js's real ScreenSpaceEventHandler -> pickAsset() -> showDcAssetPanel() path end to end.
  const hit = await page.evaluate(({ lonDeg, latDeg }) => {
    const viewer: any = (window as any).__viewer;
    const ellipsoid = viewer.scene.globe.ellipsoid;
    const toRad = (d: number) => (d * Math.PI) / 180;

    const groundTarget = ellipsoid.cartographicToCartesian({
      longitude: toRad(lonDeg), latitude: toRad(latDeg), height: 3,
    });
    const highAbove = ellipsoid.cartographicToCartesian({
      longitude: toRad(lonDeg), latitude: toRad(latDeg), height: 1200,
    });
    viewer.camera.setView({
      destination: highAbove,
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    viewer.scene.requestRender();

    const canvasPos = viewer.scene.cartesianToCanvasCoordinates(groundTarget);
    if (!canvasPos) return null;

    const tryPick = (x: number, y: number): string | null => {
      const picked = viewer.scene.pick({ x, y });
      return picked && picked.id && picked.id.asset_tag ? picked.id.asset_tag : null;
    };

    const RADIUS = 30, STEP = 3;
    for (let dy = -RADIUS; dy <= RADIUS; dy += STEP) {
      for (let dx = -RADIUS; dx <= RADIUS; dx += STEP) {
        const x = canvasPos.x + dx, y = canvasPos.y + dy;
        const assetTag = tryPick(x, y);
        if (assetTag) return { x, y, assetTag };
      }
    }
    return null;
  }, { lonDeg: sampleTarget.lon, latDeg: sampleTarget.lat });

  expect(hit, 'Expected scene.pick() to find a rendered DataConnect asset point near its known lon/lat').not.toBeNull();

  await page.mouse.click(hit!.x, hit!.y);

  const panel = page.locator('#dc-asset-panel');
  await expect(panel).toBeVisible({ timeout: 10_000 });

  const bandText = await panel.locator('.dc-panel-band').textContent();
  expect(bandText).toMatch(/(RED|AMBER|GREEN)\s*·\s*score\s*\d+/i);

  // Score breakdown section is always rendered (either driver rows or the explicit "none" state) —
  // its presence is what "score breakdown" means in the HUD; DC1 already proved bands are mixed,
  // so drivers are populated for at least some assets across the whole demo run.
  await expect(panel.locator('.dc-panel-drivers')).toBeVisible();
  await expect(panel.locator('.dc-panel-related')).toContainText('Work orders');

  await shoot(page, 'dc-dc3-asset-panel');
});

// ---------------------------------------------------------------------------
// DC4: kill the shim -> status badge flips offline, asset data survives
// (Runs LAST: it kills the one shim process this whole file shares.)
// ---------------------------------------------------------------------------
test('DC4: killing the shim flips the status badge offline while asset data survives', async ({ page }) => {
  test.setTimeout(90_000); // 15s background poll interval + swiftshader margin, on top of the load

  await gotoWithDc(page);
  await enableDcLayer(page);

  // Must actually have gone online first, or "flips to offline" would be vacuously true.
  await expect(page.locator('#dc-status')).toHaveClass(/online/, { timeout: 10_000 });

  const countBefore: number = await page.evaluate(() => (window as any).__dcAssets.count);
  expect(countBefore).toBeGreaterThanOrEqual(5000);

  expect(shim, 'shim child process must still be running before we can kill it').toBeTruthy();
  shim!.kill('SIGTERM');

  await page.waitForFunction(
    () => document.getElementById('dc-status')?.classList.contains('offline') === true,
    { timeout: 40_000, polling: 500 },
  );

  const countAfter: number = await page.evaluate(() => (window as any).__dcAssets.count);
  expect(countAfter).toBe(countBefore); // keep-previous-on-failure — layer data must not change

  await shoot(page, 'dc-dc4-offline-badge');
});
