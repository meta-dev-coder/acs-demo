import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * Seagirt Marine Terminal — Electrical Digital Twin, in a real browser:
 *  1  Overview: the terminal, the major equipment, no links, no panels.
 *  2  Asset → View Connections → asset details → Ask: one panel at a time, a way back, no stale details.
 *  3  T1 outage, closing TB1, and Reset.
 *  4  Navigation: workspaces, the rail, the Assets workspace.
 *  5  All 30 acceptance questions (AskTheTwin.rtf, verbatim): the panel, the drawn links and labels,
 *     the camera and the selection agree with the result for every one.
 *  6  Feeders: selectable on the map, with their own actions.
 *  7  Single-line diagram: the same state as the map, and selectable.
 *  8  The OSM substation: a candidate association for SS1, inspectable, anchored only on request.
 *  9  Pinning, and narrower desktop widths.
 * 10  Regression: switching project leaves no Seagirt state behind.
 */
const QUESTIONS: string[] = JSON.parse(readFileSync(new URL("../tests/fixtures/seagirt-ask-the-twin-questions.json", import.meta.url), "utf8"))
  .categories.flatMap((c: { questions: string[] }) => c.questions);
const state = (page: Page) => page.evaluate(() => (window as any).__seagirt.state());
const askTwin = async (page: Page, q: string) => {
  await page.fill(".sg-ask input", q);
  await page.press(".sg-ask input", "Enter");
};

async function open(page: Page) {
  await page.goto("/?demo=seagirt");
  await page.waitForFunction(() => (window as any).__seagirt, null, { timeout: 90_000 });
}

/**
 * Wait until the page's framing flights are done and the camera has stopped. Under SwiftShader a
 * flight only advances when a frame renders, so an unchanged position alone can be a stall.
 */
async function cameraStill(page: Page) {
  let last = "", same = 0;
  for (let i = 0; i < 80 && same < 2; i += 1) {
    const [now, flying] = await page.evaluate(() => [JSON.stringify((window as any).__seagirt.camera()), (window as any).__seagirt.flying()]);
    same = !flying && now === last ? same + 1 : 0;
    last = now;
    await page.waitForTimeout(350);
  }
}

async function clickOnMap(page: Page, id: string, until: () => Promise<boolean>) {
  await cameraStill(page);
  // Markers become pickable once their images and the terrain under them have loaded.
  for (let i = 0; i < 30 && !(await page.evaluate(() => (window as any).__seagirt.tilesLoaded())); i += 1) await page.waitForTimeout(400);
  for (let attempt = 0; attempt < 6 && !(await until()); attempt += 1) {
    const p = await page.evaluate(i => (window as any).__seagirt.screenPositionOf(i), id);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(800);
  }
}
const clickMarker = (page: Page, id: string) => clickOnMap(page, id, async () => (await state(page)).selected === id);

test.describe("Seagirt electrical twin", () => {
  test.setTimeout(150_000);

  test("1 overview: the terminal, its major equipment, no links", async ({ page }) => {
    await open(page);
    await expect(page.locator(".sg-brand")).toContainText("Seagirt Marine Terminal");
    await expect(page.locator(".sg-brand")).toContainText("Electrical Digital Twin");
    // The header holds the map controls; no project selector and no badge.
    await expect(page.locator(".sg-top .map-nav")).toBeVisible();
    expect(await page.locator(".sg-top select, .sg-synthetic").count()).toBe(0);
    expect(await page.locator("body > .map-nav").count()).toBe(0);
    await expect(page.locator(".sg-scenario")).toContainText("Baseline");
    await expect(page.locator('.sg-rail-item[aria-current="page"]')).toHaveAttribute("data-tab", "overview");
    await page.waitForTimeout(2500);
    const cam = await page.evaluate(() => (window as any).__seagirt.camera());
    expect(cam.lon).toBeGreaterThan(-76.58); expect(cam.lon).toBeLessThan(-76.51);
    expect(cam.lat).toBeGreaterThan(39.22); expect(cam.lat).toBeLessThan(39.28);
    for (const id of ["MS1", "SS1", "T1", "T2", "T3", "C1", "C5"]) {
      expect(await page.evaluate(i => (window as any).__seagirt.screenPositionOf(i), id)).not.toBeNull();
    }
    const s = await state(page);
    expect(Object.values(s.links).every(k => k === "hidden")).toBe(true);
    expect(Object.values(s.feeders).every((f: any) => !f.shown)).toBe(true);
    expect(s.markerStatus.T1).toBe("ENERGIZED");
    expect(s.panel.kind).toBeNull();
    expect(await page.locator(".sg-legend").isHidden()).toBe(true);
    expect(await page.locator(".sg-suggest").isHidden()).toBe(true);
    // The major equipment is named, and no two labels overlap.
    await cameraStill(page);
    for (let i = 0; i < 30 && !(await page.evaluate(() => (window as any).__seagirt.tilesLoaded())); i += 1) await page.waitForTimeout(400);
    await page.waitForTimeout(800);
    expect((await state(page)).labels).toEqual(expect.arrayContaining(["MS1", "SS1", "T1", "T2", "T3"]));
    const boxes = (await page.evaluate(() => (window as any).__seagirt.labelBoxes())).filter((b: any) => !b.hidden).map((b: any) => b.box);
    for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
      const [a, b] = [boxes[i], boxes[j]];
      expect(a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1], `labels ${i} and ${j} overlap`).toBe(false);
    }
  });

  test("2 one panel at a time: connections, details with a way back, then a question replaces them", async ({ page }) => {
    await open(page);
    await clickMarker(page, "C1");
    await expect(page.locator(".sg-panel h2")).toHaveText("Crane C1");
    await page.getByRole("button", { name: "View Connections" }).click();
    let s = await state(page);
    expect(s.panel.kind).toBe("result");
    expect(s.selected).toBeNull();
    expect(s.trace[0]).toEqual(["MS1", "SS1", "T1", "S1", "CB3", "F3", "C1"]);
    for (const id of ["LINK-MS1-SS1", "LINK-SS1-T1", "LINK-T1-S1", "LINK-S1-C1"]) expect(s.links[id], id).toBe("flow");
    expect(s.links["LINK-S2-C3"]).toBe("hidden");
    // Every component of the path, breaker and feeder included, opens its own details.
    await page.locator(".sg-steps button", { hasText: "CB3" }).click();
    await expect(page.locator(".sg-panel h2")).toHaveText("Circuit Breaker CB3");
    await expect(page.locator(".sg-back")).toContainText("Connections of Crane C1");
    expect((await state(page)).trace[0]).toEqual(["MS1", "SS1", "T1", "S1", "CB3", "F3", "C1"]);
    await page.locator(".sg-back").click();
    await expect(page.locator(".sg-panel h2")).toHaveText("Connections of Crane C1");

    await clickMarker(page, "T1");
    await expect(page.locator(".sg-panel h2")).toHaveText("Transformer T1");
    await expect(page.locator(".sg-panel")).toContainText("Substation SS1");
    await expect(page.locator(".sg-panel")).toContainText("Data confidence");
    // A new question replaces the open details: no stale Transformer T1.
    await askTwin(page, QUESTIONS[6]);
    await expect(page.locator(".sg-panel h2")).toHaveText("Supply path to Crane C3");
    s = await state(page);
    expect(s.selected).toBeNull();
    expect(s.panel.visible).toBe(1);
    expect(await page.locator(".sg-panel").innerText()).not.toContain("Transformer T1");
  });

  test("3 T1 outage, closing TB1, and Reset", async ({ page }) => {
    await open(page);
    const baseline = (await state(page)).markerStatus;
    await askTwin(page, "What happens if Transformer T1 goes offline?");
    await expect(page.locator(".sg-impact h2")).toHaveText("Transformer T1 — Offline");
    await expect(page.locator(".sg-impact .sg-kicker")).toContainText("not the live state");
    let s = await state(page);
    expect(s.panel.visible).toBe(1);
    expect(s.scenario.consumersLost.sort()).toEqual(["C1", "C2", "L1"]);
    expect(s.markerStatus.T1).toBe("OFFLINE");
    for (const id of ["S1", "C1", "C2", "L1"]) expect(s.markerStatus[id], id).toBe("NO_POWER");
    for (const id of ["T2", "T3", "S2", "S3", "C3", "C4", "C5", "W1", "W2", "EV1"]) expect(s.markerStatus[id], id).toBe("ENERGIZED");
    for (const id of ["LINK-T1-S1", "LINK-S1-C1", "LINK-S1-C2", "LINK-S1-L1"]) expect(s.links[id], id).toBe("lost");
    for (const id of ["LINK-SS1-T2", "LINK-T2-S2", "LINK-S2-C3", "LINK-T3-S3", "LINK-S3-C5"]) expect(s.links[id], id).toBe("live");
    expect(s.links["LINK-S2-C2"]).toBe("open");
    await expect(page.locator(".sg-impact .sg-count b")).toHaveText("3");
    await expect(page.locator(".sg-impact")).toContainText("Still powered · 6 consumers");
    await expect(page.locator(".sg-scenario")).toContainText("Transformer T1 — Offline");
    await expect(page.locator(".sg-legend")).toBeVisible();

    await page.locator(".sg-impact").getByRole("button", { name: "Simulate Closing TB1" }).click();
    await expect(page.locator(".sg-restored")).toHaveText("Power restored to Crane C2 via alternate supply from Transformer T2");
    await expect(page.locator(".sg-impact .sg-count b")).toHaveText("2");
    await expect(page.locator(".sg-impact")).toContainText("not an approved switching instruction");
    await expect(page.locator(".sg-impact")).toContainText("3 → 2 consumers without power");
    s = await state(page);
    expect(s.scenario.consumersLost.sort()).toEqual(["C1", "L1"]);
    expect(s.links["LINK-S2-C2"]).toBe("live");
    expect(s.markerStatus.C2).toBe("ENERGIZED");
    await page.locator(".sg-impact summary", { hasText: "Why?" }).click();
    await expect(page.locator(".sg-impact .sg-reason")).not.toContainText("reaches them");

    await page.locator(".sg-impact").getByRole("button", { name: "Reset Simulation", exact: true }).click();
    const after = await state(page);
    expect(after.scenario).toBeNull();
    expect(after.markerStatus).toEqual(baseline);
    expect(Object.values(after.links).every(k => k === "hidden")).toBe(true);
    expect(await page.locator(".sg-impact").count()).toBe(0);
    await expect(page.locator(".sg-scenario")).toContainText("Baseline");
  });

  test("4 navigation: workspaces and the rail", async ({ page }) => {
    await open(page);
    await expect(page.locator("body")).not.toHaveClass(/sg-rail-open/);
    await page.click(".sg-rail-item[data-tab='network']");
    let s = await state(page);
    expect(s.tab).toBe("network");
    expect(s.links["LINK-MS1-SS1"]).toBe("flowSoft");
    expect(s.links["LINK-S2-C2"]).toBe("open");
    expect(s.links["LINK-L1-L1-MASTS"]).toBe("unknown");
    await expect(page.locator(".sg-legend")).toBeVisible();

    await page.click(".sg-rail-item[data-tab='assets']");
    await expect(page.locator(".sg-assets")).toBeVisible();
    await page.fill(".sg-assets input", "F3");
    await expect(page.locator(".sg-assets li").first()).toContainText("Feeder F3");
    await expect(page.locator(".sg-assets li").first()).toContainText("CB3 → C1");
    await page.fill(".sg-assets input", "T1");
    await page.locator(".sg-assets li button").first().click();
    await expect(page.locator(".sg-panel h2")).toHaveText("Transformer T1");

    await page.click(".sg-rail-item[data-tab='ask']");
    await expect(page.locator(".sg-suggest")).toBeVisible();
    await expect(page.locator(".sg-bank-tabs button")).toHaveCount(6);
    await expect(page.locator(".sg-bank-list button")).toHaveCount(5);
    await expect(page.locator(".sg-assets")).toBeHidden();

    await page.click(".sg-rail-toggle");
    await expect(page.locator("body")).toHaveClass(/sg-rail-open/);
    await expect(page.locator(".sg-rail-item[data-tab='overview'] .sg-rail-label")).toBeVisible();
    await page.click(".sg-rail-item[data-tab='overview']");
    s = await state(page);
    expect(Object.values(s.links).every(k => k === "hidden")).toBe(true);
  });

  test("5 all 30 acceptance questions drive the panel, the map and the camera", async ({ page }) => {
    test.setTimeout(600_000);
    await open(page);
    // What each question must show on the map beyond the checks every question gets.
    const MAP: Record<number, (s: any) => void> = {
      1: s => { expect(s.roles.T1).toBe("target"); expect(s.labels).toContain("T1"); },
      3: s => { expect(s.links["LINK-T2-S2"]).toBe("flow"); },
      4: s => { expect(s.roles.SS1).toBe("target"); expect(s.roles.DP3).toBe("target"); },
      5: s => { for (const c of ["C1", "C2", "C3", "C4", "C5"]) expect(s.labels, c).toContain(c); },
      6: s => { expect(s.links["LINK-S1-C1"]).toBe("flow"); expect(s.feeders.F3.text).toBe("CB3 › F3"); },
      7: s => { expect(s.links["LINK-S2-C3"]).toBe("flow"); expect(s.feeders.F4.text).toBe("CB4 › F4"); expect(s.roles.T1).not.toBe("target"); },
      8: s => { expect(s.links["LINK-S2-W1"]).toBe("flow"); expect(s.feeders.F6.text).toBe("CB6 › F6"); },
      9: s => { expect(s.links["LINK-S2-C2"]).toBe("conditional"); expect(s.links["LINK-S2-C3"]).toBe("flow"); expect(s.roles.C2).toBe("conditional"); },
      10: s => { expect(s.links["LINK-SS1-T1"]).toBe("flow"); expect(s.roles.C3).toBe("context"); },
      11: s => { expect(s.links["LINK-T1-S1"]).toBe("lost"); expect(s.markerStatus.C1).toBe("NO_POWER"); },
      12: s => { expect(s.links["LINK-S2-C3"]).toBe("lost"); expect(s.markerStatus.C4).toBe("ENERGIZED"); },
      13: s => { expect(s.markerStatus.L1).toBe("NO_POWER"); },
      14: s => { expect(s.links["LINK-S1-C2"]).toBe("lost"); expect(s.feeders.F2.text).toBe("F2 · DISCONNECTED"); },
      15: s => { expect(Object.values(s.markerStatus).filter(v => v === "NO_POWER").length).toBeGreaterThan(10); },
      16: s => { expect(s.links["LINK-S1-C2"]).toBe("flow"); expect(s.links["LINK-S2-C2"]).toBe("conditional"); },
      17: s => { expect(s.links["LINK-S2-C2"]).toBe("live"); expect(s.markerStatus.C2).toBe("ENERGIZED"); expect(s.markerStatus.C1).toBe("NO_POWER"); },
      19: s => { expect(s.links["LINK-S2-C2"]).toBe("conditional"); },
      20: s => { expect(s.links["LINK-DP3-W2"]).toBe("flow"); },
      27: s => { expect(s.links["LINK-S1-C1"]).toBe("flow"); },
      28: s => { expect(s.links["LINK-S2-C4"]).toBe("flow"); },
      30: s => { for (const g of ["S1", "S2", "S3"]) expect(s.roles[g]).toBe("related"); },
    };
    const SCENARIO = new Set([11, 12, 13, 14, 15, 17]);
    let previous: string | null = null;
    for (const [i, q] of QUESTIONS.entries()) {
      const n = i + 1;
      // Open some asset's details first, so a stale selection would show.
      if (n % 5 === 1) { await clickMarker(page, "T1"); expect((await state(page)).selected, `Q${n} pre`).toBe("T1"); }
      await askTwin(page, q);
      await expect(page.locator(".sg-panel")).toBeVisible();
      await cameraStill(page);
      const s = await state(page);
      const inv = s.investigation;
      expect(inv, `Q${n}`).not.toBeNull();
      expect(s.selected, `Q${n}: no stale selection`).toBeNull();
      expect(s.panel.visible, `Q${n}: one panel`).toBe(1);
      expect(s.panel.kind, `Q${n}`).toBe(SCENARIO.has(n) ? "impact" : "result");
      if (!SCENARIO.has(n)) expect(s.panel.title, `Q${n}: the panel shows this result`).toBe(inv.title);
      expect(await page.locator(".sg-panel .sg-q").first().innerText(), `Q${n}`).toBe(q);
      expect(Boolean(s.scenario), `Q${n}: scenario only when asked`).toBe(SCENARIO.has(n));
      expect(inv.title, `Q${n}: a new answer`).not.toBe(previous);
      previous = inv.title;
      // Everything the result is about is on the map: emphasized, and inside the uncovered area.
      for (const id of inv.targets.filter((t: string) => t in s.roles && s.markerStatus[t])) {
        expect(s.dimmed, `Q${n}: ${id} not dimmed`).not.toContain(id);
      }
      expect(await page.evaluate(ids => (window as any).__seagirt.onScreen(ids), inv.camera), `Q${n}: camera frames ${inv.camera}`).toBe(true);
      MAP[n]?.(s);
      if (SCENARIO.has(n)) await page.locator(".sg-impact").getByRole("button", { name: "Reset Simulation", exact: true }).click();
    }
  });

  test("6 feeders are selectable on the map, with their own actions", async ({ page }) => {
    await open(page);
    await askTwin(page, QUESTIONS[5]);
    await clickOnMap(page, "F3", async () => (await state(page)).selected === "F3");
    await expect(page.locator(".sg-panel h2")).toHaveText("Feeder F3");
    const panel = page.locator(".sg-panel");
    for (const text of ["CB3", "cubicle 3", "Schematic segment", "Not recorded", "CB3 normally closed"]) await expect(panel).toContainText(text);
    for (const name of ["Trace Upstream", "Trace Downstream", "Highlight Connected Loads", "Simulate Disconnection"]) {
      await expect(panel.getByRole("button", { name })).toBeVisible();
    }
    expect((await state(page)).trace[0]).toEqual(["MS1", "SS1", "T1", "S1", "CB3", "F3", "C1"]);
    await panel.getByRole("button", { name: "Trace Downstream" }).click();
    await expect(page.locator(".sg-panel h2")).toHaveText("1 asset normally supplied from Feeder F3");
    expect((await state(page)).links["LINK-S1-C1"]).toBe("flow");
    await askTwin(page, "Where is Feeder F3?");
    expect((await state(page)).investigation.feeders).toEqual(["F3"]);
    await page.getByRole("button", { name: "Open F3 details" }).click();
    await expect(page.locator(".sg-panel h2")).toHaveText("Feeder F3");
    await page.locator(".sg-panel").getByRole("button", { name: "Simulate Disconnection" }).click();
    await expect(page.locator(".sg-impact h2")).toHaveText("Feeder F3 — Disconnected");
    const s = await state(page);
    expect(s.scenario.consumersLost).toEqual(["C1"]);
    expect(s.links["LINK-S1-C1"]).toBe("lost");
    // The Feeders layer labels every feeder in Overview.
    await page.locator(".sg-impact").getByRole("button", { name: "Reset Simulation", exact: true }).click();
    await page.click(".sg-layers summary");
    await page.check("[data-feeders]");
    const f = (await state(page)).feeders;
    expect(Object.values(f).filter((x: any) => x.wanted).length).toBe(9);
    expect(f.F2A.kind).toBe("open");
  });

  test("7 the single-line diagram shows the map's state and selects assets", async ({ page }) => {
    await open(page);
    await page.click(".sg-rail-item[data-tab='singleline']");
    await expect(page.locator(".sg-sld")).toBeVisible();
    await askTwin(page, QUESTIONS[8]);
    let s = await state(page);
    expect(s.sldEdges["EDGE-F2A-C2"]).toBe("conditional");
    expect(s.sldEdges["EDGE-F4-C3"]).toBe("flow");
    expect(s.sldEdges["EDGE-F3-C1"]).toBe("hidden");
    await askTwin(page, QUESTIONS[10]);
    s = await state(page);
    expect(s.sldEdges["EDGE-T1-S1"]).toBe("lost");
    expect(s.sldEdges["EDGE-T2-S2"]).toBe("live");
    await page.locator(".sld-node[data-asset='C3']").click();
    await expect(page.locator(".sg-panel h2")).toHaveText("Crane C3");
    expect((await state(page)).selected).toBe("C3");
    await page.locator(".sg-sld .sg-close").click();
    await expect(page.locator(".sg-sld")).toBeHidden();
  });

  test("8 the OSM substation is a candidate for SS1: inspectable, anchored only on request", async ({ page }) => {
    await open(page);
    await askTwin(page, "Where is Substation SS1 located?");
    await expect(page.locator(".sg-panel")).toContainText("candidate match (unverified)");
    await page.getByRole("button", { name: "Inspect SS1 GIS association" }).click();
    const panel = page.locator(".sg-panel");
    await expect(panel.locator("h2")).toHaveText("Substation SS1 ↔ mapped OSM substation");
    for (const text of ["CANDIDATE · not verified", "way/336181714", "power=substation", "132 m", "No drawing, single-line diagram or asset register"]) await expect(panel).toContainText(text);
    const before = await page.evaluate(() => (window as any).__seagirt.screenPositionOf("SS1"));
    await panel.locator("[data-act='anchor']").check();
    await cameraStill(page);
    expect((await state(page)).anchored).toBe(true);
    const after = await page.evaluate(() => (window as any).__seagirt.screenPositionOf("SS1"));
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(5);
    // A display anchor only: the registry and the answers are unchanged.
    await askTwin(page, "Where is Substation SS1 located?");
    await expect(page.locator(".sg-panel")).toContainText("Illustrative position");
  });

  test("9 pinning, and narrower desktop widths", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 760 });
    await open(page);
    await clickMarker(page, "T1");
    await page.locator(".sg-pin").click();
    await askTwin(page, QUESTIONS[6]);
    let s = await state(page);
    expect(s.pinned).toBe("T1");
    expect(s.selected).toBeNull();
    await expect(page.locator(".sg-pinned")).toContainText("Transformer T1");
    expect(s.roles.T1).not.toBeNull();
    // The panel, the Ask bar and the left dock never cover each other. This checks where the layout
    // ends up, not the 180 ms slide: under SwiftShader a camera flight can starve CSS transitions for
    // seconds, so they are switched off for this check.
    await page.addStyleTag({ content: ".sg-ask, .sg-layers, .sg-legend { transition: none !important; }" });
    await page.click(".sg-rail-item[data-tab='singleline']");
    const box = async (sel: string) => (await page.locator(sel).boundingBox())!;
    const apart = (x: any, y: any) => x.x + x.width <= y.x || y.x + y.width <= x.x || x.y + x.height <= y.y || y.y + y.height <= x.y;
    await expect.poll(async () => {
      const [p, a, d] = [await box(".sg-panel"), await box(".sg-ask-bar"), await box(".sg-sld")];
      return [apart(p, a), apart(d, a), apart(d, p)];
    }, { intervals: [250], timeout: 8000 }).toEqual([true, true, true]);
    await page.locator(".sg-pinned .sg-close").click();
    s = await state(page);
    expect(s.pinned).toBeNull();
  });

  test("10 switching project leaves no Seagirt state behind", async ({ page }) => {
    await open(page);
    await askTwin(page, "What happens if Transformer T1 goes offline?");
    await expect(page.locator(".sg-impact")).toBeVisible();
    // No selector in the Seagirt header: another project is opened by its link.
    await page.goto("/?demo=construction-integration");
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => Boolean((window as any).__seagirt))).toBe(false);
    expect(await page.locator(".sg-top, .sg-rail, .sg-panel, #cesiumContainer").count()).toBe(0);
    await page.goto("/?demo=seagirt");
    await page.waitForFunction(() => (window as any).__seagirt, null, { timeout: 90_000 });
    expect((await state(page)).scenario).toBeNull();
    expect((await state(page)).panel.kind).toBeNull();
  });
});
