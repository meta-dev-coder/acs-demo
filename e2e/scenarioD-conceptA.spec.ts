/*---------------------------------------------------------------------------------------------
 * M4-B — Scenario D (Lane Closure) Concept A end-to-end GATE spec.
 *
 * This is the insurance-deliverable gate: it proves the before/after Concept A snapshot works
 * end-to-end in the real browser-driven app, and drives the 30-second banked recording.
 *
 * ⚠️ OWED / HEADED-ONLY. This project's iTwin IMS auth FAILS in headless browsers — it requires
 * a HEADED persistent-context browser for silent re-auth (see memory/acs-i595-placement-and-selftest
 * and scripts/pw-driver.mjs). It also does not yet ship @playwright/test as a dependency or a
 * playwright.config. This file is therefore a READY, DOM-accurate artifact (selectors verified
 * against the M5 Shell.tsx render), NOT yet wired into CI. To run it for the banked recording:
 *   1. npm i -D @playwright/test  (dev-only; the deploy.yml CI sets PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD)
 *   2. add a playwright.config.ts pointing baseURL at the dev server, with a HEADED, persistent
 *      auth context (reuse the storage state / profile that scripts/pw-driver.mjs establishes).
 *   3. npx playwright test e2e/scenarioD-conceptA.spec.ts --headed
 * It lives under e2e/ (outside tsconfig "include":["src"] and the vitest "tests/**" glob) so it
 * neither breaks `tsc --noEmit` nor runs in the node unit suite.
 *--------------------------------------------------------------------------------------------*/
import { test, expect } from "@playwright/test";

test("Scenario D Concept A — before/after snapshot is self-sufficient", async ({ page }) => {
  await page.goto("/");

  // 1. Navigate to the Lane Closure tab (sd-tab button labelled by SCENARIO_REGISTRY['D'].tabLabel).
  await page.getByRole("button", { name: "Lane Closure" }).click();
  await expect(page.locator(".sd-left h3")).toContainText("Lane Closure");

  // 2. The ClosureEventBuilder form is visible.
  await expect(page.locator("[data-testid='closure-event-builder']")).toBeVisible();

  // 3. Build a closure: SEG-CONN, 1-of-2, PM peak, then Simulate.
  await page.selectOption("[data-testid='closure-segment-select']", "SEG-CONN");
  await page.getByRole("button", { name: "Partial" }).click();
  await page.getByRole("button", { name: "PM Peak" }).click();
  await page.getByRole("button", { name: "Simulate" }).click();

  // 4. KpiBarD shows a non-zero max queue.
  const maxQueueTile = page.locator("[data-testid='kpi-max-queue']");
  await expect(maxQueueTile).toBeVisible();
  const queueMi = parseFloat((await maxQueueTile.textContent())?.match(/[\d.]+/)?.[0] ?? "0");
  expect(queueMi).toBeGreaterThan(0);

  // 5. The inspector "After" view shows a congested LOS (E or F) for the closed segment.
  await page.getByRole("button", { name: "After" }).click();
  const losText = (await page.locator("[data-testid='closure-inspector-los']").textContent()) ?? "";
  expect(["E", "F"].some((b) => losText.includes(`LOS ${b}`))).toBe(true);

  // 6. Two distinct, non-zero economics lines are both visible.
  await expect(page.getByText("Delay cost")).toBeVisible();
  await expect(page.getByText("Express revenue protected")).toBeVisible();
  const delayCost = parseFloat((await page.locator("[data-testid='kpi-delay-cost']").textContent())?.replace(/[^0-9.]/g, "") ?? "0");
  const expRev = parseFloat((await page.locator("[data-testid='kpi-express-revenue']").textContent())?.replace(/[^0-9.]/g, "") ?? "0");
  expect(delayCost).toBeGreaterThan(0);
  expect(expRev).toBeGreaterThan(0);
  expect(Math.abs(delayCost - expRev)).toBeGreaterThan(10); // distinct formulas → distinct values

  // 7. Regression: Scenario A still works after exercising D.
  await page.getByRole("button", { name: "Asset Reliability" }).click();
  await expect(page.locator(".sd-left h3")).toContainText("ITS Assets");
});
