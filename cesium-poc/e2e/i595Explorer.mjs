/**
 * The Map explorer now opens collapsed, so a fresh load shows the map rather than the layer tree.
 * Tests that drive layer controls open it first, exactly as a user does.
 */
export async function openExplorer(page) {
  const toggle = page.locator('#menu-toggle');
  await toggle.waitFor({ timeout: 60000 });
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
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
