/**
 * uc1-flow.spec.ts — UC1 Lane Closure Revenue Optimizer, the decide flow (P4-c).
 * See docs/superpowers/specs/2026-07-11-uc1-lane-closure-revenue-optimizer-design.md ("Testing").
 *
 * Modelled on dataconnect-assets.spec.ts: spawns tools/dataconnect_shim.py itself in `beforeAll`
 * (playwright.config's webServer stays vite-only) and loads the app with `?dc=http://localhost:8787`
 * so cesium-poc/src/dataconnect.js talks to our spawned shim.
 *
 * Drives the hero work order via the "UC1 demo" button (config/uc1Demo.json's pinned
 * heroWorkOrderId) rather than a scene.pick() click, for determinism (per task instructions) —
 * DC3 in dataconnect-assets.spec.ts already exercises the real pick path for this DataConnect
 * layer family.
 *
 * Flow: toggle WO layer -> click hero WO (UC1 demo button) -> context panel shows ticket +
 * accidents -> "Evaluate closure windows" -> 3 ranked rows -> "Schedule this window" -> decision
 * POSTs to the shim's write endpoint (asserted via a direct shim read-back AND the
 * #uc1-decisions-status badge).
 *
 * Run:
 *   cd cesium-poc && npx playwright test e2e/uc1-flow.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { shoot } from './helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.join(__dirname, '..', '..'); // cesium-poc/e2e -> cesium-poc -> repo root

const SHIM_PORT = 8787;
const SHIM_URL  = `http://localhost:${SHIM_PORT}`;
const APP_URL   = `/?dc=${SHIM_URL}`;

// The hero work order pinned in config/uc1Demo.json — kept in sync manually (not imported: this
// spec runs under ts-node/Playwright, the JSON is a repo fixture whoever changes uc1Demo.json is
// expected to update this one string, same posture as ASSET_REGISTRY_PATH in dataconnect-assets).
const HERO_WORK_ORDER_ID = 'WO-900543';

// ---------------------------------------------------------------------------
// Shim lifecycle — one process shared by every test in this file.
// ---------------------------------------------------------------------------
let shim: ChildProcess | null = null;

async function waitForShimReady(timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
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
// Shim helpers (plain Node fetch — no CORS concern outside the browser context).
// ---------------------------------------------------------------------------

async function shimToken(): Promise<string> {
  const res = await fetch(`${SHIM_URL}/api/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'demo', password: 'demo' }),
  });
  const body = await res.json();
  return body.token;
}

/** Total row count of the shim's "decisions" class (committed seed + gitignored runtime log). */
async function decisionsTotal(token: string): Promise<number> {
  const res = await fetch(`${SHIM_URL}/api/data-mgmt/v1/curated-data/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ className: 'decisions', page: 1, pageSize: 1 }),
  });
  const body = await res.json();
  return body.total;
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function gotoWithDc(page: Page): Promise<void> {
  page.on('console', (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => console.log(`[browser:pageerror] ${err.stack || err.message}`));
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

/** Clicks "UC1 demo" and waits for the hero work order's context panel to be populated
 * (window.__uc1Context, main.js's openUc1WorkOrderContext debug hook). Generous timeout — this
 * triggers the shared DataConnect fetch (7 paginated classes) if it hasn't already run. */
async function clickUc1Demo(page: Page, timeout = 60_000): Promise<void> {
  await page.click('#btn-uc1-demo');
  await page.waitForFunction(
    (heroId) => {
      const ctx = (window as any).__uc1Context;
      return !!ctx && ctx.workOrderId === heroId;
    },
    HERO_WORK_ORDER_ID,
    { timeout, polling: 500 },
  );
}

// ---------------------------------------------------------------------------
// UC1-FLOW: full decide flow, end to end
// ---------------------------------------------------------------------------
test('UC1-FLOW: layer toggle -> hero WO context -> evaluate -> 3 ranked windows -> schedule -> decision logged', async ({ page }) => {
  test.setTimeout(120_000); // DataConnect load (7 paginated classes) + evaluate + schedule, on top of swiftshader warmup

  await gotoWithDc(page);

  // ---- toggle the WO layer explicitly first (design spec §4 bullet 1) ----
  const woBtn = page.locator('#btn-uc1-wo');
  await woBtn.click();
  await expect(woBtn).toHaveClass(/on/, { timeout: 60_000 });

  // ---- drive the hero WO via the UC1 demo button (deterministic — no scene.pick() needed) ----
  await clickUc1Demo(page);

  const panel = page.locator('#uc1-context-panel');
  await expect(panel).toBeVisible();

  // Context panel shows the linked ticket + a non-zero accident count (uc1Demo.json's rationale:
  // WO-900543 has a linked ticket, a failed inspection, and >=2 accidents within 500m).
  const ctx = await page.evaluate(() => (window as any).__uc1Context);
  expect(ctx).toBeTruthy();
  expect(ctx.counts.hasTicket).toBe(true);
  expect(ctx.counts.accidents).toBeGreaterThan(0);
  await expect(panel.locator('.uc1-ctx-section', { hasText: 'Linked ticket' })).not.toContainText('No linked ticket');
  await expect(panel.locator('.uc1-ctx-section', { hasText: 'Accident history' })).toContainText(String(ctx.counts.accidents));

  await shoot(page, 'uc1-flow-1-context-panel');

  // ---- Evaluate closure windows -> 3 ranked rows ----
  const evalBtn = page.locator('#uc1-evaluate-btn');
  await expect(evalBtn).toBeVisible();
  await evalBtn.click();

  await page.waitForFunction(() => {
    const w = (window as any).__uc1Windows;
    return !!w && w.count === 3;
  }, { timeout: 10_000 });

  const windowPanel = page.locator('#uc1-window-panel');
  await expect(windowPanel).toBeVisible();
  await expect(windowPanel.locator('.uc1-win-row')).toHaveCount(3);

  await shoot(page, 'uc1-flow-2-window-panel');

  // ---- Schedule the top-ranked window -> decision POSTs to the shim's write endpoint ----
  const token = await shimToken();
  const totalBefore = await decisionsTotal(token);

  await windowPanel.locator('.uc1-win-schedule-btn').first().click();

  await page.waitForFunction(() => (window as any).__uc1Decisions != null, { timeout: 15_000 });
  const decisions = await page.evaluate(() => (window as any).__uc1Decisions);
  expect(decisions.lastRecord).toBeTruthy();
  expect(decisions.lastRecord.workOrderId).toBe(HERO_WORK_ORDER_ID);
  expect(decisions.lastRecord.historyCounts.accidents).toBeGreaterThan(0);
  expect(decisions.queued).toBe(0); // write succeeded — nothing left in the offline queue

  await expect(page.locator('#uc1-decisions-status')).toHaveClass(/online/, { timeout: 10_000 });

  const totalAfter = await decisionsTotal(token);
  expect(totalAfter).toBe(totalBefore + 1);

  await shoot(page, 'uc1-flow-3-decision-logged');
});

// ---------------------------------------------------------------------------
// UC1-OFFLINE: schedule while the shim is down -> offline badge + in-memory queue
// (Runs LAST: it kills the one shim process this whole file shares.)
// ---------------------------------------------------------------------------
test('UC1-OFFLINE: scheduling while the shim is down queues the decision and flips the badge offline', async ({ page }) => {
  test.setTimeout(90_000);

  await gotoWithDc(page);
  await page.locator('#btn-uc1-wo').click();
  await clickUc1Demo(page);

  await page.locator('#uc1-evaluate-btn').click();
  await page.waitForFunction(() => {
    const w = (window as any).__uc1Windows;
    return !!w && w.count === 3;
  }, { timeout: 10_000 });

  expect(shim, 'shim child process must still be running before we can kill it').toBeTruthy();
  shim!.kill('SIGTERM');
  shim = null;

  const windowPanel = page.locator('#uc1-window-panel');
  await windowPanel.locator('.uc1-win-schedule-btn').first().click();

  await page.waitForFunction(() => {
    const d = (window as any).__uc1Decisions;
    return !!d && d.queued > 0;
  }, { timeout: 30_000, polling: 500 });

  await expect(page.locator('#uc1-decisions-status')).toHaveClass(/offline/, { timeout: 10_000 });

  const decisions = await page.evaluate(() => (window as any).__uc1Decisions);
  expect(decisions.queued).toBe(1);
  expect(decisions.lastRecord.workOrderId).toBe(HERO_WORK_ORDER_ID);

  await shoot(page, 'uc1-flow-4-offline-badge');
});
