import { test, expect } from "@playwright/test";

// ArcGIS renderer smoke test — the ?renderer=arcgis path. Independent of the Cesium helpers
// (which wait on window.__viewer); ArcGIS specs wait on window.__arcgisReady + the SceneView.
test("ArcGIS renderer boots the SceneView on the DNT aerial", async ({ page }) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  await page.goto("/?renderer=arcgis");
  await page.waitForFunction(() => (window as any).__arcgisReady === true, { timeout: 100000 });
  await expect(page.locator("#status")).toBeVisible();

  // The SceneView exists and the transform is the DNT anchor. (view.ready may stay false under
  // headless SwiftShader even though tiles render — see arcgis.js init note — so we don't assert it.)
  const info = await page.evaluate(() => {
    const view = (window as any).__view;
    const p = (window as any).__T?.p;
    return { hasView: !!view, type: view?.type, anchorLon: p?.anchorLon, anchorLat: p?.anchorLat };
  });
  expect(info.hasView, "SceneView missing").toBe(true);
  expect(info.type).toBe("3d");
  expect(info.anchorLon).toBeCloseTo(-96.8229, 3);
  expect(info.anchorLat).toBeCloseTo(33.0920, 3);

  await page.waitForTimeout(6000); // let Esri tiles load for the screenshot
  await page.screenshot({ path: "test-results/arcgis-dnt.png" });
  expect(errors, `page errors:\n${errors.join("\n")}`).toEqual([]);
});
