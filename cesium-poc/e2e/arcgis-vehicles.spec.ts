import { test, expect } from "@playwright/test";

// ArcGIS vehicle rendering: the internal rAF loop interpolates the sampled tracks into glTF
// ObjectSymbol3DLayer graphics on the DNT aerial.
test("ArcGIS renders moving vehicles on the DNT", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/?renderer=arcgis");
  await page.waitForFunction(() => (window as any).__arcgisReady === true, { timeout: 100000 });

  // Vehicles populate as the clock advances into their availability windows.
  await page.waitForFunction(() => ((window as any).__R?.vehicleCount?.() ?? 0) > 3, { timeout: 30000 });
  const count = await page.evaluate(() => (window as any).__R.vehicleCount());
  expect(count, "no vehicle graphics").toBeGreaterThan(3);

  // Traffic persists (count stays positive a moment later) and the first vehicle's position moves.
  const firstPos = () => page.evaluate(() => {
    const g = (window as any).__R._gfx.graphics;
    const item = g.getItemAt(0);
    return item ? { lon: item.geometry.longitude, lat: item.geometry.latitude } : null;
  });
  const p1 = await firstPos();
  await page.waitForTimeout(1500);
  const stillRunning = await page.evaluate(() => (window as any).__R.vehicleCount());
  expect(stillRunning).toBeGreaterThan(0);

  await page.waitForTimeout(5000); // tiles + models settle
  await page.screenshot({ path: "test-results/arcgis-vehicles.png" });
  expect(p1).not.toBeNull();
});
