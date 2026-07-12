/**
 * uc1-segment-picker.spec.ts — UC1 deck-parity item 3 (segment ribbon + lane chooser), Phase 11.
 *
 * Kept in a separate file from uc1-flow.spec.ts (per the 3D sub-plan's own reasoning) — a narrower
 * merge/e2e-run surface for a feature that only touches the ribbon-click + lane-chooser wiring,
 * not the whole 5-step decide flow.
 *
 * Drives the segment pick deterministically via window.__uc1SelectSegment(id) (a scene.pick() click
 * on a specific ribbon polyline is not reliably reproducible headless — same rationale uc1-flow.spec.ts
 * gives for driving the hero WO pick via #btn-uc1-demo instead of a raw click). SEG4 below is a
 * regression NOTE only — closure.spec.ts itself is the acceptance check, run unmodified, separately.
 *
 * Run:
 *   cd cesium-poc && npx playwright test e2e/uc1-segment-picker.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.join(__dirname, '..', '..'); // cesium-poc/e2e -> cesium-poc -> repo root

// Overridable via UC1_E2E_SHIM_PORT for a fully isolated throwaway run (a dev shim may already own
// the default 8787 outside this spec's control) — defaults to 8787, unchanged for normal CI runs.
const SHIM_PORT = Number(process.env.UC1_E2E_SHIM_PORT) || 8787;
const SHIM_URL  = `http://localhost:${SHIM_PORT}`;
// ?uc1=1 auto-enters the demo (Task C, storyboard §5) — skips the startup tile entirely.
const APP_URL   = `/?dc=${SHIM_URL}&uc1=1`;

// The hero work order pinned in config/uc1Demo.json, and the segment it resolves to via
// resolveSegmentByName() — kept in sync manually (not imported: this spec runs under ts-node/
// Playwright, the JSON is a repo fixture whoever changes uc1Demo.json/segments.json is expected to
// update these two strings, same posture as HERO_WORK_ORDER_ID in uc1-flow.spec.ts).
const HERO_WORK_ORDER_ID = 'WO-900002';
const HERO_SEGMENT_ID = 'central'; // config/segments.json: "Central Segment" -> id "central"
const OTHER_SEGMENT_ID = 'west'; // any segment != HERO_SEGMENT_ID with a resolvable centerline trace

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
// SEG1: default-select — the hero WO's own segment is pre-selected with zero new interaction.
// ---------------------------------------------------------------------------
test('SEG1: hero WO pick default-selects its own segment on the ribbon', async ({ page }) => {
  test.setTimeout(90_000);

  await gotoWithDc(page);
  await page.waitForFunction(() => (window as any).__uc1DemoReady === true, { timeout: 60_000 });
  await clickUc1Demo(page);

  await page.waitForFunction(() => (window as any).__uc1Segment != null, { timeout: 10_000 });
  const seg = await page.evaluate(() => (window as any).__uc1Segment);
  expect(seg.segmentId).toBe(HERO_SEGMENT_ID);
  expect(seg.lanesClosed).toBe(1);

  // The existing one-click "Evaluate closure windows" path still works unmodified — the
  // default-selected segment is enough, no picker interaction required.
  await page.locator('#uc1-evaluate-btn').click();
  await page.waitForFunction(() => {
    const w = (window as any).__uc1Windows;
    return !!w && w.count === 3;
  }, { timeout: 10_000 });
});

// ---------------------------------------------------------------------------
// SEG2: override + re-evaluate — picking a different segment changes __uc1Segment and the
// evaluate path still produces the standard 3-window shape.
// ---------------------------------------------------------------------------
test('SEG2: __uc1SelectSegment overrides the default segment -> Evaluate still returns 3 windows', async ({ page }) => {
  test.setTimeout(90_000);

  await gotoWithDc(page);
  await page.waitForFunction(() => (window as any).__uc1DemoReady === true, { timeout: 60_000 });
  await clickUc1Demo(page);

  await page.waitForFunction(() => (window as any).__uc1Segment != null, { timeout: 10_000 });
  const before = await page.evaluate(() => (window as any).__uc1Segment);
  expect(before.segmentId).toBe(HERO_SEGMENT_ID);

  await page.evaluate((id) => (window as any).__uc1SelectSegment(id), OTHER_SEGMENT_ID);
  await page.waitForFunction(
    (id) => (window as any).__uc1Segment?.segmentId === id,
    OTHER_SEGMENT_ID,
    { timeout: 10_000 },
  );

  await page.locator('#uc1-evaluate-btn').click();
  await page.waitForFunction(() => {
    const w = (window as any).__uc1Windows;
    return !!w && w.count === 3;
  }, { timeout: 10_000 });
  const windowsDebug = await page.evaluate(() => (window as any).__uc1Windows);
  expect(windowsDebug.count).toBe(3);
});

// ---------------------------------------------------------------------------
// SEG3: lane-count bound — the rendered lane-chooser button count matches laneCloseOptions().
// ---------------------------------------------------------------------------
test('SEG3: lane chooser renders exactly laneCloseOptions(segment).length buttons', async ({ page }) => {
  test.setTimeout(90_000);

  await gotoWithDc(page);
  await page.waitForFunction(() => (window as any).__uc1DemoReady === true, { timeout: 60_000 });
  await clickUc1Demo(page);

  // Re-select the hero WO's own (already-default) segment via the debug hook — this is what
  // actually OPENS the chooser (the default-select on WO pick highlights the ribbon but does not
  // pop the chooser open; only an explicit segment pick does). Re-selecting the hero's own segment,
  // rather than switching to a different one, keeps the anchor point inside the tight ~500m camera
  // framing openUc1WorkOrderContext just flew to — a different segment's centerline midpoint can
  // legitimately sit off-screen at that zoom, which is a camera-framing question, not what this
  // test is about.
  await page.waitForFunction(() => (window as any).__uc1Segment != null, { timeout: 10_000 });
  await page.evaluate((id) => (window as any).__uc1SelectSegment(id), HERO_SEGMENT_ID);

  const chooser = page.locator('#uc1-lane-chooser');
  await expect(chooser).toBeVisible();
  // config/segments.json: every segment has laneCount === 3 -> laneCloseOptions() === [1, 2].
  await expect(chooser.locator('.uc1-lane-btn')).toHaveCount(2);

  // Clicking a lane button updates the selection.
  await chooser.locator('.uc1-lane-btn[data-lanes="2"]').click();
  await page.waitForFunction(() => (window as any).__uc1Segment?.lanesClosed === 2, { timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// SEG4 (regression note, not re-asserted inline): closure.spec.ts must be run unmodified as the
// acceptance check that window.__closeLane / cone / sign behavior is unaffected by the new
// isUc1SegmentRibbon-tagged entities pickUc1Point() now recognizes — uc1Layers.js's own docstring
// notes closure.spec.ts's entity filters (isCone/signText) structurally cannot see these, so no
// shared-state bleed is expected. Run separately: `npx playwright test e2e/closure.spec.ts`.
// ---------------------------------------------------------------------------
