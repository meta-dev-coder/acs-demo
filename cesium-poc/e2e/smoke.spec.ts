import { test, expect } from '@playwright/test';

test('page loads and Cesium viewer initialises', async ({ page }) => {
  await page.goto('/');

  // Wait up to 30 s for window.__viewer to be set by main.js
  await page.waitForFunction(() => !!(window as any).__viewer, { timeout: 30000 });

  // #status element must be present in the DOM
  await expect(page.locator('#status')).toBeVisible();
});
