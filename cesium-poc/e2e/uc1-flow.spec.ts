/**
 * uc1-flow.spec.ts — UC1 Lane Closure Revenue Optimizer, the decide flow (P4-c) + Task C's
 * demo-mode entry (startup tile / stepper / ?uc1=1 auto-enter — see uc1-ux-storyboard.md §1/§5).
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
 * Flow: `?uc1=1` auto-enters the 5-step demo (skips the startup tile) -> Step 1 Trigger (WO layer
 * auto-on) -> click hero WO (UC1 demo button) -> Step 2 Context panel shows ticket + accidents ->
 * "Evaluate closure windows" -> Step 3 Simulate (visible SUMO run for the winning window) -> Step 4
 * Compare (3 ranked rows, the money shot) -> "Why trust this?" -> backtest tab honesty line ->
 * Assumptions tab slider -> table re-ranks live -> exec KPI strip (4 tiles + seeded label) ->
 * "Schedule this window" -> Step 5 Decide: decision POSTs to the shim's write endpoint (asserted
 * via a direct shim read-back AND the #uc1-decisions-status badge) -> visible SUMO run (P5-e
 * Decision 6, reuses the existing __closeLane/work-zone machinery — asserted via window.__kpi.workzone).
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

// Overridable via UC1_E2E_SHIM_PORT for a fully isolated throwaway run (a dev shim may already own
// the default 8787 outside this spec's control) — defaults to 8787, unchanged for normal CI runs.
const SHIM_PORT = Number(process.env.UC1_E2E_SHIM_PORT) || 8787;
const SHIM_URL  = `http://localhost:${SHIM_PORT}`;
// ?uc1=1 auto-enters the demo (Task C, storyboard §5) — skips the startup tile entirely.
const APP_URL   = `/?dc=${SHIM_URL}&uc1=1`;

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

async function gotoWithDc(page: Page, url = APP_URL): Promise<void> {
  page.on('console', (msg) => console.log(`[browser:${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => console.log(`[browser:pageerror] ${err.stack || err.message}`));
  await page.goto(url);
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
// UC1-STARTUP: the entry tile is suppressed under navigator.webdriver on a plain nav (no ?uc1)
// (Task C — every OTHER e2e spec in this repo navigates with no ?uc1 param and must see today's
// sandbox with no overlay in the way).
// ---------------------------------------------------------------------------
test('UC1-STARTUP: startup tile stays suppressed on a default nav (no ?uc1 param) under navigator.webdriver', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__viewer, { timeout: 30_000 });
  await expect(page.locator('#uc1-startup-tile')).toBeHidden();
  // Sandbox chrome untouched — no uc1-mode body class, stepper not shown.
  await expect(page.locator('body')).not.toHaveClass(/uc1-mode/);
  await expect(page.locator('#uc1-stepper')).toBeHidden();
});

// ---------------------------------------------------------------------------
// UC1-FLOW: full decide flow, end to end, driven via ?uc1=1's demo-mode auto-entry
// ---------------------------------------------------------------------------
test('UC1-FLOW: ?uc1=1 auto-enters demo -> hero WO context -> evaluate -> 3 ranked windows -> schedule -> decision logged -> stepper reaches Step 5', async ({ page }) => {
  test.setTimeout(120_000); // DataConnect load (7 paginated classes) + evaluate + schedule, on top of swiftshader warmup

  await gotoWithDc(page);

  // ---- Step 1 (Trigger): ?uc1=1 auto-entered the demo — stepper live, generic HUD suppressed,
  // the WO layer auto-toggled on (design spec §4 bullet 1, now driven by demo-mode entry rather
  // than a manual click). ----
  await page.waitForFunction(() => (window as any).__uc1Step === 1, { timeout: 15_000 });
  await expect(page.locator('#uc1-stepper')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/uc1-mode/);

  // The legacy work-zone/MUTCD HUD stays in the DOM (closure.spec.ts still drives it directly in
  // default mode) but is CSS-hidden while UC1 demo mode is active (storyboard §7).
  const wzHud = page.locator('#workzone-hud');
  await expect(wzHud).toBeAttached();
  await expect(wzHud).toBeHidden();

  await page.waitForFunction(() => (window as any).__uc1DemoReady === true, { timeout: 60_000 });
  const woBtn = page.locator('#btn-uc1-wo');
  await expect(woBtn).toHaveClass(/on/);

  // ---- drive the hero WO via the UC1 demo button (deterministic — no scene.pick() needed) ----
  await clickUc1Demo(page);

  // Step 1 -> Step 2 (Context).
  await page.waitForFunction(() => (window as any).__uc1Step === 2, { timeout: 10_000 });

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

  // ---- Task F1 bullet 1: rows carry real content (asset id/type, finding snippet, risk badge,
  // date, distance), not just a badge + date (uc1-panel-diagnosis.md #1). ----
  const firstInspectionRow = panel.locator('.uc1-ctx-section', { hasText: 'Failed inspections' }).locator('.uc1-ctx-row').first();
  await expect(firstInspectionRow.locator('.uc1-ctx-badge')).toBeVisible();
  await expect(firstInspectionRow.locator('.uc1-ctx-row-id')).not.toHaveText('');

  // ---- Task F1 bullet 2: rows are clickable -> expand an inline detail block with the full
  // record, and drive onRowFocus (main.js's focusUc1ContextRow -> flyTo + pulse, asserted via the
  // window.__uc1LastRowFocus debug hook). ----
  const firstDetail = firstInspectionRow.locator('xpath=following-sibling::div[1]');
  await expect(firstDetail).toBeHidden();
  await firstInspectionRow.click();
  await expect(firstDetail).toBeVisible();
  await expect(firstDetail).toContainText('Risk rating');
  await expect(firstInspectionRow).toHaveClass(/expanded/);
  await page.waitForFunction(() => (window as any).__uc1LastRowFocus != null, { timeout: 5_000 });

  // Clicking again collapses the detail back.
  await firstInspectionRow.click();
  await expect(firstDetail).toBeHidden();
  await expect(firstInspectionRow).not.toHaveClass(/expanded/);

  // ---- Task F1 bullet 3: the "Evaluate closure windows" CTA is pinned/always-visible — no
  // scrolling required to reach it the instant the context panel opens (uc1-panel-diagnosis.md #2:
  // it used to sit 8266px down behind 438 unlabeled rows). ----
  const evalBtn = page.locator('#uc1-evaluate-btn');
  await expect(evalBtn).toBeVisible();
  await expect(evalBtn).toBeInViewport();
  const [panelBox, btnBox] = await Promise.all([panel.boundingBox(), evalBtn.boundingBox()]);
  expect(panelBox && btnBox, 'both the panel and the CTA must have a resolvable bounding box').toBeTruthy();
  expect(btnBox!.y + btnBox!.height, 'CTA must not extend past the panel\'s own bottom edge').toBeLessThanOrEqual(panelBox!.y + panelBox!.height + 1);
  expect(btnBox!.y + btnBox!.height, 'CTA must be visible within the 900px viewport with no scrolling').toBeLessThanOrEqual(900);

  await shoot(page, 'uc1-flow-1-context-panel');

  // ---- Evaluate closure windows -> Step 2 -> 3 (Simulate, visible SUMO run for the winning
  // window) -> Step 3 -> 4 (Compare, the ranked table) -> 3 ranked rows ----
  await evalBtn.click();

  await page.waitForFunction(() => {
    const w = (window as any).__uc1Windows;
    return !!w && w.count === 3;
  }, { timeout: 10_000 });

  await page.waitForFunction(() => (window as any).__uc1Step === 4, { timeout: 10_000 });

  const windowPanel = page.locator('#uc1-window-panel');
  await expect(windowPanel).toBeVisible();
  await expect(windowPanel.locator('.uc1-win-row')).toHaveCount(3);

  await shoot(page, 'uc1-flow-2-window-panel');

  // ---- P5-e item 1: "Why trust this?" -> backtest tab renders the honesty line verbatim ----
  const trustBtn = page.locator('#uc1-trust-btn');
  await expect(trustBtn).toBeVisible();
  await trustBtn.click();

  const trustPanel = page.locator('#uc1-trust-panel');
  await expect(trustPanel).toBeVisible();
  await expect(trustPanel.locator('.uc1-trust-honesty')).toContainText(
    'traffic delay and exact revenue figures are calibrated in the pilot',
  );

  await shoot(page, 'uc1-flow-2b-trust-backtest');

  // ---- P5-e item 1: Assumptions tab slider -> window table re-ranks live (slide-11 stress test) ----
  const scoresBefore = await windowPanel.locator('.uc1-win-score').allTextContents();
  const orderBefore = await windowPanel.locator('.uc1-win-row').evaluateAll((rows) =>
    rows.map((r) => r.getAttribute('data-window-id')),
  );

  await trustPanel.locator('.uc1-trust-tab[data-tab="assumptions"]').click();
  const revenueSlider = trustPanel.locator('input.uc1-trust-slider[data-path="weights.revenue"]');
  await expect(revenueSlider).toBeVisible();
  await revenueSlider.evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = '0';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await page.waitForFunction(
    (before) => {
      const scores = Array.from(document.querySelectorAll('#uc1-window-panel .uc1-win-score')).map((n) => n.textContent);
      return JSON.stringify(scores) !== JSON.stringify(before);
    },
    scoresBefore,
    { timeout: 10_000 },
  );

  const scoresAfter = await windowPanel.locator('.uc1-win-score').allTextContents();
  const orderAfter = await windowPanel.locator('.uc1-win-row').evaluateAll((rows) =>
    rows.map((r) => r.getAttribute('data-window-id')),
  );
  expect(scoresAfter, 'zeroing the revenue weight must change the recomputed scores').not.toEqual(scoresBefore);
  console.log(`[uc1-flow] rank order before=${orderBefore.join(',')} after=${orderAfter.join(',')}`);

  await shoot(page, 'uc1-flow-2c-assumptions-rerank');

  // ---- P5-e item 2: exec KPI strip — 4 tiles + the seeded-history honesty label ----
  await page.waitForFunction(() => !!(window as any).__uc1ExecKpis, { timeout: 20_000 });
  const execStrip = page.locator('#uc1-exec-kpi-strip');
  await expect(execStrip.locator('.uc1-exec-kpi')).toHaveCount(4);
  await expect(execStrip.locator('.uc1-exec-kpi-note')).toContainText(/seeded/i);

  await shoot(page, 'uc1-flow-2d-exec-kpi-strip');

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

  // ---- Step 4 -> Step 5 (Decide): a successful schedule advances the stepper to its terminal
  // step and shows the corridor-scale heat-map zoom-out coda (storyboard §8 Mic-Drop 3). ----
  await page.waitForFunction(() => (window as any).__uc1Step === 5, { timeout: 10_000 });

  // ---- P5-e item 3: a successful schedule reuses the existing closure machinery for a visible
  // SUMO run (offline here -> the same work-zone overlay/RILCA KPIs closeLaneHook always produces). ----
  await page.waitForFunction(() => !!(window as any).__kpi?.workzone, { timeout: 15_000 });
  const workzoneAfterSchedule = await page.evaluate(() => (window as any).__kpi?.workzone);
  expect(workzoneAfterSchedule).toBeTruthy();

  // ---- exec KPI strip refreshed with the just-scheduled decision (Decision 5: live appends to seed) ----
  const execKpisAfterSchedule = await page.evaluate(() => (window as any).__uc1ExecKpis);
  expect(execKpisAfterSchedule.decisionCount).toBeGreaterThan(0);

  await shoot(page, 'uc1-flow-3-decision-logged');
});

// ---------------------------------------------------------------------------
// UC1-OFFLINE: schedule while the shim is down -> offline badge + in-memory queue
// (Runs LAST: it kills the one shim process this whole file shares.)
// ---------------------------------------------------------------------------
test('UC1-OFFLINE: scheduling while the shim is down queues the decision and flips the badge offline', async ({ page }) => {
  test.setTimeout(90_000);

  await gotoWithDc(page);
  await page.waitForFunction(() => (window as any).__uc1DemoReady === true, { timeout: 60_000 }); // ?uc1=1 auto-toggles the WO layer on
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
