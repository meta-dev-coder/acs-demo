/**
 * The Map explorer now opens collapsed, so a fresh load shows the map rather than the layer tree.
 * Tests that drive layer controls open it first, exactly as a user does.
 */
export async function openExplorer(page) {
  const toggle = page.locator('#menu-toggle');
  await toggle.waitFor({ timeout: 60000 });
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
}
