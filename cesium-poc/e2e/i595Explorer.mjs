/**
 * The Map explorer now opens collapsed, so a fresh load shows the map rather than the layer tree.
 * Tests that drive layer controls open it first, exactly as a user does.
 */
/**
 * The Map Explorer now belongs to the left bar's Layers button and starts closed, so anything that
 * drives layer controls opens it first — exactly as a user does.
 */
export async function openLayers(page) {
  const layers = page.locator('.app-nav [data-action="layers"]');
  await layers.waitFor({ timeout: 60000 });
  if (await layers.getAttribute('aria-pressed') === 'false') await layers.click();
  await page.locator('.layers').waitFor({ state: 'visible', timeout: 10000 });
}

export async function openExplorer(page) {
  await openLayers(page);
  const toggle = page.locator('#menu-toggle');
  await toggle.waitFor({ timeout: 60000 });
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  // The full layer hierarchy now lives one disclosure deep, under "All layers"; the quick layers,
  // presets and category views sit above it. Tests that drive the hierarchy want it open.
  await page.evaluate(() => { const all = document.querySelector('.all-layers'); if (all) all.open = true; });
}

/**
 * Open the explorer and every <details> that contains `selector`, so a nested layer group is
 * reachable. The Map Explorer groups layers by transportation category, so most layers now sit one
 * disclosure deep; the interactions under test stay real clicks.
 */
export async function revealLayerGroup(page, selector) {
  await openExplorer(page);
  await page.evaluate(sel => {
    for (let node = document.querySelector(sel)?.parentElement; node; node = node.parentElement) {
      if (node.tagName === 'DETAILS') node.open = true;
    }
  }, selector);
}
