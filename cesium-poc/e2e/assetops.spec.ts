import { test, expect } from "@playwright/test";
import { waitForReady } from "./helpers.js";

// Phase B — gantry assets + the "camera degradation + rain + peak" incident scenario.
test("gantry assets render and the incident scenario drives asset-ops KPIs", async ({ page }) => {
  test.setTimeout(90000);
  await waitForReady(page);
  await page.waitForTimeout(3000);

  // DNT gantries load from the ArcGIS GIS source (live NCTCOG FeatureServer, or the local fallback)
  // and list in the panel.
  const nGantries = await page.evaluate(() => document.querySelectorAll("#ao-gantries .ao-g").length);
  expect(nGantries).toBeGreaterThanOrEqual(1);
  expect(nGantries).toBeLessThanOrEqual(6);

  // Nominal: high read rate, no dispatch.
  const nominalKpis = await page.evaluate(() => (window as any).__kpi);
  const readNominal = await page.evaluate(() => document.querySelector("#ao-kpis .ao-v")?.textContent || "");
  expect(readNominal).toContain("%");
  expect(await page.evaluate(() => !!document.querySelector(".ao-dispatch"))).toBe(false);

  // Run the incident.
  await page.click("#ao-run");
  await page.waitForTimeout(1500);

  const state = await page.evaluate(() => ({
    degradedRows: document.querySelectorAll("#ao-gantries .ao-g.deg").length,
    kpis: document.querySelector("#ao-kpis")?.textContent || "",
    dispatch: document.querySelector(".ao-dispatch")?.textContent || "",
    weather: (document.getElementById("weather-select") as HTMLSelectElement)?.value,
    btnOn: document.getElementById("ao-run")?.classList.contains("on"),
  }));
  expect(state.degradedRows, "one gantry degraded").toBe(1);
  expect(state.kpis).toMatch(/Revenue at risk/);
  expect(state.kpis).toMatch(/vs nominal/);          // before/after delta shown
  expect(state.dispatch).toMatch(/Dispatch crew/);   // maintenance dispatch recommendation
  expect(state.weather).toBe("heavyrain");           // incident bundles rain
  expect(state.btnOn).toBe(true);

  // Reset restores healthy + clear.
  await page.click("#ao-run");
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => document.querySelectorAll("#ao-gantries .ao-g.deg").length)).toBe(0);
  expect(await page.evaluate(() => !!document.querySelector(".ao-dispatch"))).toBe(false);
});
