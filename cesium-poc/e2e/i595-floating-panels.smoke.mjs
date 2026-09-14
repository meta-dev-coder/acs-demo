/**
 * Floating panels.
 *
 * Every panel on this map sits over the scene, so two things have to hold: it must close when the
 * user closes it, and it must be possible to move it off whatever it is covering. The close case is
 * a regression guard — `display: flex` on the Ask the Twin panel used to defeat its `hidden`
 * attribute, so the close button appeared to do nothing.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { revealLayerGroup } from './i595Explorer.mjs';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await page.locator('#bridges-all:not(:disabled)').waitFor({ state: 'attached', timeout: 90000 });

  /** Drag a panel by its handle and report how far it actually moved. */
  async function dragBy(panelSelector, handleSelector, dx, dy) {
    const before = await page.locator(panelSelector).boundingBox();
    const handle = await page.locator(handleSelector).boundingBox();
    await page.mouse.move(handle.x + 30, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 30 + dx, handle.y + handle.height / 2 + dy, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await page.locator(panelSelector).boundingBox();
    return { dx: Math.round(after.x - before.x), dy: Math.round(after.y - before.y), after };
  }

  // ---- 1. Ask the Twin opens, moves, and actually closes ----------------------------------------
  await page.locator('.ask-twin-btn').click();
  await page.locator('.ask-twin-panel').waitFor({ state: 'visible', timeout: 20000 });
  const twin = await dragBy('.ask-twin-panel', '.ask-twin-header', -300, -180);
  assert.deepEqual([twin.dx, twin.dy], [-300, -180], 'the Ask the Twin panel follows the pointer');

  await page.locator('.ask-twin-close').click();
  await page.locator('.ask-twin-panel').waitFor({ state: 'hidden', timeout: 15000 });
  assert.equal(await page.locator('.ask-twin-panel').isHidden(), true,
    'closing must hide the panel — a display rule must not defeat the hidden attribute');

  // ---- 2. A details panel drags by its heading, and its Close still works afterwards ------------
  await revealLayerGroup(page, '#bridges-all');
  await page.locator('#bridges-all').check();
  await page.locator('.bridge-list .segment-select').first().waitFor({ timeout: 30000 });
  await page.locator('.bridge-list .segment-select').first().click();
  await page.locator('.bridge-details:not([hidden])').waitFor({ timeout: 30000 });

  assert.ok(await page.locator('.bridge-details .ramp-details-heading.panel-drag-handle').count(),
    'the heading is the grab handle');
  const details = await dragBy('.bridge-details', '.bridge-details .ramp-details-heading', -430, 120);
  assert.deepEqual([details.dx, details.dy], [-430, 120], 'the details panel follows the pointer');

  // Controls inside the handle must never be swallowed by the drag.
  await page.locator('.bridge-details button[aria-label^="Close"]').click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.bridge-details').isHidden(), true, 'Close still works from a dragged position');

  // ---- 3. A panel cannot be thrown somewhere it cannot be grabbed again -------------------------
  await page.locator('.ask-twin-btn').click();
  await page.locator('.ask-twin-panel').waitFor({ state: 'visible', timeout: 20000 });
  await dragBy('.ask-twin-panel', '.ask-twin-header', -4000, -4000);
  const stranded = await page.locator('.ask-twin-panel').boundingBox();
  assert.ok(stranded.x + stranded.width > 0 && stranded.y + stranded.height > 0 && stranded.y >= 0,
    `a dragged panel stays reachable, was at ${Math.round(stranded.x)},${Math.round(stranded.y)}`);
  await dragBy('.ask-twin-panel', '.ask-twin-header', 9000, 9000);
  const other = await page.locator('.ask-twin-panel').boundingBox();
  assert.ok(other.x < 1500 && other.y < 950, 'and cannot be pushed past the far edge either');

  assert.deepEqual(errors, [], 'dragging must not throw');
  console.log('i595-floating-panels.smoke: PASS');
} finally {
  await browser.close();
}
