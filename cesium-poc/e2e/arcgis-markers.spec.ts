import { test, expect } from "@playwright/test";

// ArcGIS booth markers (10 booth discs + TOLL PLAZA label) + mark-gates pick handler.
test("ArcGIS renders booth markers + supports mark-gates", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/?renderer=arcgis");
  await page.waitForFunction(() => (window as any).__arcgisReady === true, { timeout: 100000 });

  // 10 booth discs + 1 plaza label = 11 markers.
  await page.waitForFunction(() => ((window as any).__R?.markerCount?.() ?? 0) >= 11, { timeout: 20000 });
  const markers = await page.evaluate(() => (window as any).__R.markerCount());
  expect(markers).toBeGreaterThanOrEqual(11);

  // Programmatic mark-gates (uses onPick's {lon,lat} path via __markGates) rebuilds against new T.
  const before = await page.evaluate(() => (window as any).__T.p.anchorLon);
  await page.evaluate(() => {
    const dir = [{ lon: -96.8231, lat: 33.0930 }, { lon: -96.8228, lat: 33.0910 }];
    const gates = Array.from({ length: 6 }, (_, i) => ({ lon: -96.8235 + i * 0.0002, lat: 33.0920 }));
    (window as any).__markGates(dir, gates);
  });
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => (window as any).__T.p.anchorLon);
  expect(after).not.toBe(before); // T rebuilt from the marked gates
  expect(await page.evaluate(() => (window as any).__R.markerCount())).toBeGreaterThanOrEqual(11);

  await page.waitForTimeout(5000);
  await page.screenshot({ path: "test-results/arcgis-markers.png" });
});
