import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * IFC Spatial Twin, in a real browser with real Cesium: the hand-written IFC fixture is converted by
 * the real server converter (web-ifc) when the suite starts, and /api/ifc-spatial/* serves that
 * output from route mocks, so no Autodesk credentials are needed. Under test: navigation and the
 * electrical twin left as it was, the converted geometry loaded as a Cesium Model, picking by IFC
 * GlobalId, model switching, placement, errors, and that no Autodesk Viewer is ever loaded.
 */
const IFC = readFileSync(new URL("../tests/fixtures/ifc/minimal-georef.ifc", import.meta.url));
// The real IFC network (converted seagirt_power_network.ifc), served beside the small 3D fixture so the
// overlay, the engine and Ask the Twin run on the actual network.
const NETWORK = JSON.parse(readFileSync(new URL("../tests/fixtures/ifc-network.json", import.meta.url), "utf8"));
let converted: { glb: Buffer; elements: any[]; diagnostics: any };
const TX = "3Ax9Lk0t95uO2QkM8XbJ1a", BOARD = "2Wc3nV7mL0XhF8pR6tY4uZ";
const FILES = [{ fileName: "seagirt_power_network.ifc", key: "a".repeat(24) }, { fileName: "seagirt_power_network_display.ifc", key: "b".repeat(24) }];

test.beforeAll(async () => {
  const { convertIfc } = await import("../server/ifcSpatial/convert.mjs");
  converted = await convertIfc(IFC, { sourceFile: "minimal-georef.ifc", versionId: "v1", versionNumber: 1 });
});

async function mockSpatial(page: Page, { prepareError = null as null | { status: number; code: string; message: string }, signedIn = true, status = {} as Record<string, Record<string, string>> } = {}) {
  const saved: Record<string, any> = {};
  // `version` is the tip version in ACC; a test raises it to publish a new version.
  const calls = { prepare: [] as string[], put: [] as any[], del: 0, viewerSdk: 0, version: 1, refreshes: 0, area: [] as any[] };
  await page.route("https://developer.api.autodesk.com/**", route => { calls.viewerSdk += 1; return route.abort(); });
  // No Google requests from tests: the Google 3D base map is refused, so the screen falls back to the simple map.
  await page.route(/googleapis\.com/, route => route.abort());
  await page.route("**/api/ifc-spatial/**", async route => {
    const url = new URL(route.request().url());
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (!signedIn) return json(401, { error: { code: "NOT_AUTHENTICATED", message: "Not signed in to Autodesk.", hint: "Open /api/aps/login to sign in." } });
    const path = url.pathname.replace("/api/ifc-spatial", "");
    if (path === "/models") {
      if (url.searchParams.get("refresh") === "1") calls.refreshes += 1;
      return json(200, { project: { id: "b.p", name: "Seagirt Electrical Digital Twin POC" },
        models: FILES.map(f => ({ fileName: f.fileName, versionId: `${f.fileName}?version=${calls.version}`, versionNumber: calls.version, key: f.key, status: "converted" })) });
    }
    if (path === "/prepare") {
      const file = FILES.find(f => f.fileName === url.searchParams.get("file"))!;
      calls.prepare.push(file.fileName);
      if (prepareError) return json(prepareError.status, { error: { code: prepareError.code, message: prepareError.message } });
      return json(200, { key: file.key, status: "ready", cached: true, fileName: file.fileName, versionId: `${file.fileName}?version=${calls.version}`, versionNumber: calls.version, convertedAt: "2026-11-23T10:00:00Z",
        glbUrl: `/api/ifc-spatial/cache/${file.key}/model.glb?v=${calls.version}`, elementsUrl: `/api/ifc-spatial/cache/${file.key}/elements.json?v=${calls.version}`,
        diagnostics: { schema: "IFC4", elements: converted.diagnostics.elements, withGeometry: converted.diagnostics.withGeometry, triangles: converted.diagnostics.triangles,
          glbBytes: converted.glb.length, sourceBytes: IFC.length, library: "web-ifc 0.0.80", placementMode: "IFC_GEOREFERENCED", crs: "EPSG:26985", warnings: 0 },
        placement: { georeferenced: converted.diagnostics.placement, saved: saved[file.key] ?? null } });
    }
    const asset = /^\/cache\/([ab]{24})\/(model\.glb|elements\.json)$/.exec(path);
    if (asset) {
      return asset[2] === "model.glb" ? route.fulfill({ status: 200, contentType: "model/gltf-binary", body: converted.glb })
        // The network's own geometry is not in this GLB, so its elements carry no feature ids here.
        // `status`: SuperDNA_AssetStatus for chosen network ids (a test's own reported states).
        : json(200, { elements: [...converted.elements, ...NETWORK.elements.map((e: any) => ({ ...e, featureId: null, ...(status[e.networkId] ? { properties: { ...e.properties, SuperDNA_AssetStatus: status[e.networkId] } } : {}) }))], connections: [...(converted.connections ?? []), ...networkConnections(calls.version)] });
    }
    // Select Area: the server's own resolution (server/ifcSpatial/area.mjs) over the served elements.
    if (path === "/area") {
      const { resolveAreaFor } = await import("../server/ifcSpatial/area.mjs");
      const body = route.request().postDataJSON();
      calls.area.push(body);
      const file = FILES.find(f => f.key === body.key) ?? FILES[0];
      try {
        return json(200, resolveAreaFor({ elements: [...converted.elements, ...NETWORK.elements], georef: converted.diagnostics.placement, placement: body.placement, body, key: body.key, fileName: file.fileName, versionNumber: calls.version }));
      } catch (error: any) { return json(400, { error: { code: error.code ?? "INVALID_AREA", message: error.message } }); }
    }
    if (path === "/placement") {
      const key = url.searchParams.get("key")!;
      if (route.request().method() === "PUT") { saved[key] = route.request().postDataJSON(); calls.put.push(saved[key]); return json(200, { key, saved: saved[key] }); }
      if (route.request().method() === "DELETE") { delete saved[key]; calls.del += 1; return json(200, { key, saved: null }); }
    }
    return json(404, { error: { code: "NOT_FOUND", message: path } });
  });
  return calls;
}

// Version 2 of the network in ACC: cable AP-03 is no longer connected, so cranes STS-03 and STS-04 lose power.
const AP03 = NETWORK.elements.find((e: any) => e.networkId === "AP-03").globalId;
const networkConnections = (version: number) => version >= 2 ? NETWORK.connections.filter((c: any) => c.from !== AP03 && c.to !== AP03) : NETWORK.connections;

// Ask the Twin answers: the newest turn of the conversation in the left panel.
const ANSWER = ".isp-askp-chat .isp-turn:last-child .isp-msg-ans";
/** Ask the Twin starts collapsed to its launcher: open it. */
async function openAsk(page: Page) {
  const launcher = page.locator('.isp-askp-launcher');
  // The launcher appears once the network has loaded, after the screen reports ready.
  await expect(page.locator(".isp-askp-launcher:visible, .isp-askbar input:visible").first()).toBeVisible({ timeout: 30_000 });
  if (await launcher.isVisible()) await launcher.click({ force: true });
  await expect(page.locator(".isp-askbar input")).toBeVisible();
  // Wait out the slide-in (slow under SwiftShader), so clicks land on the panel, not where it was.
  await page.waitForFunction(() => { const t = getComputedStyle(document.querySelector(".isp-askp")!).transform; return t === "none" || t === "matrix(1, 0, 0, 1, 0, 0)"; });
}
const spatial = (page: Page) => page.evaluate(() => (window as any).__ifcSpatial?.state() ?? null);
const ready = (page: Page) => page.waitForFunction(() => ["ready", "error"].includes((window as any).__ifcSpatial?.state().phase), null, { timeout: 60_000 });

async function openTwin(page: Page, query = "") {
  await page.goto(`/?demo=seagirt${query}${query.includes("screen=ifc-spatial") ? "&more=1" : ""}`);   // the More menu is hidden unless ?more=1
  await page.waitForFunction(() => (window as any).__seagirt, null, { timeout: 90_000 });
}

/** Click an IFC element where Cesium draws it, retrying while the first frames render. */
async function clickElement(page: Page, globalId: string) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const p = await page.evaluate(g => (window as any).__ifcSpatial.screenPositionOf(g), globalId);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(500);
    if ((await spatial(page)).selected?.globalId === globalId) return;
  }
}

test.describe("IFC Spatial Twin", () => {
  test.setTimeout(150_000);

  test("1 its own screen and Cesium viewer; the twin's outage survives; no Autodesk Viewer", async ({ page }) => {
    const calls = await mockSpatial(page);
    await openTwin(page);
    await page.evaluate(() => (window as any).__seagirt.ask("What happens if Transformer T1 goes offline?"));
    await page.waitForFunction(() => (window as any).__seagirt.state().scenario);
    const before = await page.evaluate(() => (window as any).__seagirt.state());

    await page.click('.sg-rail-item[data-tab="ifc-spatial"]');
    await ready(page);
    const s = await spatial(page);
    expect(s.phase).toBe("ready");
    expect(s.modelLoaded).toBe(true);
    expect(s.primitives).toBe(1);
    expect(page.url()).toContain("screen=ifc-spatial");
    await expect(page.locator(".isp .cesium-widget")).toHaveCount(1);
    await expect(page.locator("#cesiumContainer")).toBeHidden();
    for (const chrome of [".sg-top", ".sg-panel", ".sg-ask"]) await expect(page.locator(chrome)).toBeHidden();
    await expect(page.locator(".isp-conv")).toContainText("Geometry converted");
    // Nothing saved for this version: it starts aligned to the terminal, not at the file's georeferencing.
    await expect(page.locator(".isp-place")).toHaveText("User calibrated · aligned to terminal");
    // Google 3D is the default base map; when it cannot load, the simple map stays and the switch says why.
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().base.note);
    expect((await spatial(page)).base).toMatchObject({ map: "simple", google: false });
    await expect(page.locator('[data-base="simple"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-base="google"]')).toHaveAttribute("data-tip", /could not be loaded/);
    expect(await page.locator(".adsk-viewing-viewer, .ifx").count()).toBe(0);
    expect(calls.viewerSdk).toBe(0);

    await page.click(`.sg-rail-item[data-tab="${before.tab}"]`);
    await expect(page.locator(".isp")).toBeHidden();
    await expect(page.locator("#cesiumContainer")).toBeVisible();
    const after = await page.evaluate(() => (window as any).__seagirt.state());
    expect(after.screen).toBe("twin");
    expect(after.scenario).toEqual(before.scenario);
    expect(after.investigation?.title).toBe(before.investigation?.title);
    expect(after.markerStatus).toEqual(before.markerStatus);
    expect((await spatial(page)).viewerAlive).toBe(false);
    expect(await page.locator(".cesium-widget").count()).toBe(1);
  });

  test("2 3D geometry (a layer): picking identifies the IFC element by GlobalId; a network element opens its asset", async ({ page }) => {
    await mockSpatial(page);
    await openTwin(page, "&screen=ifc-spatial");
    await ready(page);
    // The IFC model from ACC is on by default, as a wireframe under the network overlay.
    expect((await spatial(page)).layers.geometry).toBe(true);
    expect((await spatial(page)).modelLoaded).toBe(true);
    await expect(page.locator('[data-toggle="show"]')).toHaveAttribute("aria-pressed", "true");
    // The network overlay is drawn over the geometry and would take these clicks: hide it for this test.
    await page.click('[data-act="more"]');
    await page.click(".isp-more-panel summary:has-text('More layers')");
    await page.locator('[data-layer="network"]').uncheck({ force: true });
    await page.click('[data-act="more"]');
    // Picking hits drawn pixels: in wireframe a click inside an element's box falls between its edges.
    await page.locator('[data-toggle="wireframe"]').dispatchEvent("click"); // hidden from the header, still wired
    await expect(page.locator('[data-toggle="wireframe"]')).toHaveAttribute("aria-pressed", "false");
    expect((await spatial(page)).selectable).toBe(2);
    await page.evaluate(g => (window as any).__ifcSpatial.select(g), BOARD);
    await page.waitForTimeout(1500);
    await page.click('.isp-right:not(.isp-net-panel) [data-act="clear"]');
    await clickElement(page, BOARD);
    const s = await spatial(page);
    expect(s.selected).toMatchObject({ globalId: BOARD, ifcClass: "IfcElectricDistributionBoard", name: "SW-T Test switchboard" });
    await expect(page.locator(".isp-right:not(.isp-net-panel)")).toContainText(BOARD);
    await page.click('.isp-right:not(.isp-net-panel) [data-act="isolate"]');
    expect((await spatial(page)).isolated).toBe(true);
    await page.click('.isp-right:not(.isp-net-panel) [data-act="clear"]');
    await expect(page.locator(".isp-right:not(.isp-net-panel)")).toBeHidden();
    // The transformer has a NetworkID: picking its geometry opens it as a network asset. Bring it into view first.
    await page.evaluate(g => (window as any).__ifcSpatial.select(g), TX);
    await page.waitForTimeout(1500);
    await page.click('.isp-right:not(.isp-net-panel) [data-act="clear"]');
    for (let attempt = 0; attempt < 8 && (await spatial(page)).network?.selectedId !== "TX-T"; attempt += 1) {
      const p = await page.evaluate(g => (window as any).__ifcSpatial.screenPositionOf(g), TX);
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(500);
    }
    expect((await spatial(page)).network.selectedId).toBe("TX-T");
    await expect(page.locator(".isp-net-panel")).toContainText("TX-T");
  });

  test("3 switching models replaces the model, one at a time", async ({ page }) => {
    const calls = await mockSpatial(page);
    await openTwin(page, "&screen=ifc-spatial");
    await ready(page);
    await page.click('[data-act="more"]');
    await page.selectOption(".isp-select", "seagirt_power_network_display.ifc");
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().manifest?.key === "b".repeat(24) && (window as any).__ifcSpatial.state().phase === "ready");
    const s = await spatial(page);
    expect(s.primitives).toBe(1);
    expect(calls.prepare).toEqual(["seagirt_power_network.ifc", "seagirt_power_network_display.ifc"]);
    expect(page.url()).toContain("model=seagirt_power_network_display.ifc");
  });

  test("4 placement: a new version starts aligned to the terminal; edits become user-calibrated, save per model version, reset to the file's georeferencing", async ({ page }) => {
    const calls = await mockSpatial(page);
    await openTwin(page, "&screen=ifc-spatial");
    await ready(page);
    const reference = JSON.parse(readFileSync(new URL("../public/data/seagirt/ifc-reference-alignment.json", import.meta.url), "utf8")).placement;
    // Nothing saved: the documented terminal alignment, not saved until the user saves it.
    expect((await spatial(page)).placement).toMatchObject({ mode: "USER_CALIBRATED", lon: reference.lon, lat: reference.lat, headingDeg: reference.headingDeg, scale: reference.scale });
    expect(calls.put.length).toBe(0);
    const before = (await spatial(page)).modelMatrix;
    await page.click('[data-act="more"]');
    await page.click('[data-act="placement"]');
    await page.click('[data-act="more"]');
    await page.fill('[data-p="headingDeg"]', "-35");
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().placement.headingDeg === -35);
    expect((await spatial(page)).modelMatrix).not.toEqual(before);
    await expect(page.locator(".isp-place")).toHaveText("User calibrated");
    await page.click('[data-act="savePlacement"]');
    await expect.poll(() => calls.put.length).toBe(1);
    expect(calls.put[0]).toMatchObject({ mode: "USER_CALIBRATED", headingDeg: -35, scale: reference.scale });
    // "Align to terminal" applies the committed reference calibration, still labelled user-calibrated.
    await page.click('[data-act="alignReference"]');
    await page.waitForFunction(h => Math.abs((window as any).__ifcSpatial.state().placement.headingDeg - h) < 1e-6, reference.headingDeg);
    expect((await spatial(page)).placement).toMatchObject({ mode: "USER_CALIBRATED", lon: reference.lon, lat: reference.lat, scale: reference.scale });
    await expect(page.locator(".isp-place")).toHaveText("User calibrated · aligned to terminal");
    await expect(page.locator(".isp-ref")).toContainText("OpenStreetMap");
    await page.click('[data-act="resetPlacement"]');
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().placement.mode === "IFC_GEOREFERENCED");
    expect(calls.del).toBe(1);
    expect((await spatial(page)).modelMatrix).not.toEqual(before);
  });

  test("5 errors are shown as errors, with no geometry put in their place", async ({ page }) => {
    await mockSpatial(page, { prepareError: { status: 422, code: "INVALID_IFC", message: "The file is not an IFC STEP file (no ISO-10303-21 header)." } });
    await openTwin(page, "&screen=ifc-spatial");
    await ready(page);
    await expect(page.locator(".isp-error h2")).toHaveText("Not a valid IFC file");
    await expect(page.locator(".isp-error")).toContainText("INVALID_IFC");
    expect((await spatial(page)).primitives).toBe(0);

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mockSpatial(page, { signedIn: false });
    await openTwin(page, "&screen=ifc-spatial");
    await ready(page);
    await expect(page.locator(".isp-error h2")).toHaveText("Sign in to Autodesk");
    await expect(page.locator(".isp-error a")).toHaveAttribute("href", /\/api\/aps\/login\?returnTo=/);
  });

  test("6 the IFC network, drawn mock-style: status tiles, a what-if scenario, restore by switching", async ({ page }) => {
    await mockSpatial(page);
    await openTwin(page, "&screen=ifc-spatial");
    await ready(page);
    const counts = (await spatial(page)).network.counts;
    expect(counts.routes).toBe(65);
    expect(counts.symbols).toBeGreaterThan(50);
    expect(counts.control).toBe(15);
    await expect(page.locator(".isp-tiles")).toContainText("12/12");
    await expect(page.locator(".isp-tiles")).toContainText("420/420");
    await expect(page.locator(".isp-scenario-pill")).toBeHidden();
    // Electrical Network is the default workspace, with no Assets panel.
    await expect(page.locator('[data-ws="network"]')).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".isp-assets")).toBeHidden();
    // The Assets workspace lists the network with live states; search narrows it; a row selects.
    await page.click('[data-ws="assets"]');
    expect((await spatial(page)).network.workspace).toBe("assets");
    await expect(page.locator(".isp-arow")).toHaveCount(137, { timeout: 10000 }); // 136 from the IFC network + the 3D fixture's test transformer
    await page.fill(".isp-asearch", "STS-05");
    await expect(page.locator('.isp-arow[data-asset="STS-05"]')).toHaveCount(1);
    await expect(page.locator(".isp-arow")).not.toHaveCount(137);
    await page.click('.isp-arow[data-asset="STS-05"]');
    expect((await spatial(page)).network.selectedId).toBe("STS-05");
    await expect(page.locator(".isp-chain")).toContainText("TX-M1");
    await expect(page.locator(".isp-chain")).toContainText("QSS-C");
    await page.fill(".isp-asearch", "");
    await page.click('[data-act="more"]');
    const route = await page.evaluate(() => (window as any).__ifcSpatial.routeInfo("AP-03"));
    expect(route.points).toBeGreaterThanOrEqual(2);
    expect(Number.isFinite(route.first[0])).toBe(true);

    await page.click('[data-scenario="txm2"]');
    await page.click('[data-act="more"]');   // close the menu: the simulation panel is under it
    await expect(page.locator(".isp-tiles")).toContainText("8/12");
    // The Outage Simulation panel on the right: the failed asset, simulated vs reported, the consumers without
    // power. Ask the Twin stays collapsed and no banner repeats it.
    await expect(page.locator(".isp-sim-asset")).toContainText("TX-M2");
    await expect(page.locator(".isp-sim-pill.is-sim")).toContainText("Simulated");
    await expect(page.locator(".isp-sim-m.is-bad b")).toHaveText("15");
    await expect(page.locator(".isp-sim-tabs .isp-tab")).toHaveText(["Overview", "Connections", "Properties", /^Documents/]);
    await expect(page.locator(".isp-scenario-pill")).toBeHidden();
    await expect(page.locator(".isp-ask")).toHaveClass(/is-collapsed/);
    expect((await spatial(page)).network.nodeStates["STS-12"]).toBe("dead");
    expect((await spatial(page)).network.nodeStates.OPS, "the ops building rides through on GEN-1").toBe("backup");
    // The counts are clickable: each shows its own list.
    await page.click('.isp-sim-m[data-sim-list="substations"]', { force: true });
    await expect(page.locator(".isp-sim-card.is-list h3")).toContainText("Substations Affected");
    await page.click('.isp-sim-m[data-sim-list="consumers"]', { force: true });
    await page.click('.isp-sim [data-act="simAll"]', { force: true });
    await expect(page.locator('.isp-sim-row[data-sim-asset="STS-12"]')).toHaveCount(1);
    await expect(page.locator('.isp-sim-row[data-sim-asset="STS-01"]')).toHaveCount(0);
    // The mock's restore options: BT-1 restores all but overloads TX-M1; AT-2 brings back the east cranes.
    await expect(page.locator(".isp-restore")).toContainText("Close BT-1");
    await expect(page.locator(".isp-opt", { hasText: "Close BT-1" })).toContainText("overloads TX-M1");
    await page.click('[data-act="more"]');   // the restore options are in the menu
    await page.click('[data-close="AT-2"]');
    await page.click('[data-act="more"]');
    await expect(page.locator(".isp-tiles")).toContainText("12/12");
    expect((await spatial(page)).network.selectedId).toBe("AT-2");
    await page.click(".isp-sim-reset", { force: true });
    await expect(page.locator(".isp-sim")).toHaveCount(0);
    expect((await spatial(page)).network.scenario).toBeNull();
  });

  test("7 Ask the Twin on the IFC network: typed, from the question bank, and from a symbol on the map", async ({ page }) => {
    test.setTimeout(300_000);
    await mockSpatial(page);
    await openTwin(page, "&screen=ifc-spatial");
    await ready(page);
    await openAsk(page);
    await page.fill(".isp-askbar input", "Which transformer supplies power to Crane STS-05?");
    await page.press(".isp-askbar input", "Enter");
    await expect(page.locator(`${ANSWER} .tw-say`)).toContainText("Main transformer TX-M1 supplies STS-05");
    expect((await spatial(page)).network.result.intent).toBe("UPSTREAM_TYPE");

    await page.click('.isp-askbar [data-act="bank"]');
    await expect(page.locator(".isp-bankq")).toHaveCount(30);
    // Forced: under load Cesium starves the frames Playwright's stability check waits for.
    await page.click(".isp-bank summary:has-text('Power Outage')", { force: true });
    await page.click(".isp-bankq:has-text('Which cranes will lose power if cable AP-03 fails?')", { force: true });
    // Asked in the conversation: answered there (counts and every affected asset); no simulation panel opens.
    await expect(page.locator(`${ANSWER} .tw-say`)).toContainText("2 consumers lose power");
    await expect(page.locator(`${ANSWER} .tw-metric.is-bad b`)).toHaveText("2");
    await expect(page.locator(`${ANSWER} .tw-crow`)).toHaveCount(2);
    await expect(page.locator(`${ANSWER} .tw-crow`).first()).toContainText("No power (simulated)");
    await expect(page.locator(".isp-sim")).toHaveCount(0);
    expect((await page.evaluate(() => (window as any).__ifcSpatial.state().network.sim)).consumers.sort()).toEqual(["STS-03", "STS-04"]);
    expect((await spatial(page)).network.nodeStates["AP-03"]).toBe("off");
    await page.click(`${ANSWER} [data-act="simReset"]`, { force: true });
    expect((await spatial(page)).network.scenario).toBeNull();

    // A real click on a symbol on the map: first bring it into view (the status cards cover the right edge).
    await page.evaluate(() => (window as any).__ifcSpatial.selectAsset("QSS-C"));
    await page.waitForTimeout(1500);
    await page.click('.isp-net-panel [data-act="netClear"]', { timeout: 10_000 }).catch(() => {});
    for (let attempt = 0; attempt < 8 && (await spatial(page)).network.selectedId !== "QSS-C"; attempt += 1) {
      const p = await page.evaluate(() => (window as any).__ifcSpatial.assetScreenPosition("QSS-C"));
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(500);
    }
    expect((await spatial(page)).network.selectedId).toBe("QSS-C");
    await expect(page.locator(".isp-chain")).toContainText("BUS-A");
    await expect(page.locator(".isp-net-panel")).toContainText("Quay switching station Centre");
    await page.click('.isp-net-panel [data-inv="DOWNSTREAM"]');
    await expect(page.locator(ANSWER)).toContainText("Quay switching station Centre");
    expect((await spatial(page)).network.result.intent).toBe("DOWNSTREAM");
  });

  test("8 ACC version check: a new version is loaded in place and what it leaves without power is highlighted", async ({ page }) => {
    const calls = await mockSpatial(page);
    await openTwin(page, "&screen=ifc-spatial");
    await ready(page);
    await expect(page.locator(".isp-sync")).toContainText("ACC v1");
    // Version 1: the network is fully supplied; only the 3D fixture's test transformer, connected to nothing, has no power.
    expect((await spatial(page)).network.unpowered).toEqual(["TX-T"]);
    // Power Status starts collapsed in the header; open it.
    await expect(page.locator(".isp-ops")).toBeHidden();
    await page.click(".isp-power");
    await expect(page.locator(".isp-ops-alerts h3")).toHaveText(/^Active Alerts\s*1$/);

    // Nothing new: the check re-reads ACC and keeps the model.
    await page.evaluate(() => (window as any).__ifcSpatial.checkForUpdate());
    expect(calls.refreshes).toBe(1);
    expect(calls.prepare).toHaveLength(1);
    await expect(page.locator(".isp-sync")).toContainText("checked");

    // ACC now has version 2, with AP-03 disconnected.
    calls.version = 2;
    await page.evaluate(() => (window as any).__ifcSpatial.checkForUpdate());
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().sync.version === 2 && (window as any).__ifcSpatial.state().phase === "ready");
    expect(calls.prepare).toHaveLength(2);
    await expect(page.locator(".isp-sync")).toContainText("ACC v2 (was v1)");
    const s = await spatial(page);
    for (const id of ["AP-03", "STS-03", "STS-04"]) expect(s.network.unpowered).toContain(id);
    expect(s.network.nodeStates["STS-03"]).toBe("dead");
    expect(s.network.scenario, "the model's own state, not a simulation").toBeNull();
    // Power Status and Active Alerts follow the new version; a card selects its asset.
    await expect(page.locator('.isp-ops-row[data-ops-status="NO_POWER"] b')).toHaveText(String((await spatial(page)).ops.summary.counts.NO_POWER));
    await expect(page.locator('[data-ops-alert="STS-03"]')).toBeVisible();
    await page.click('[data-ops-alert="STS-03"]');
    expect((await spatial(page)).network.selectedId).toBe("STS-03");
    await expect(page.locator('[data-ops-alert="STS-03"]')).toHaveClass(/is-selected/);
    // The header's Power Status chip hides the cards and stays in the header; a second click brings them back.
    await expect(page.locator(".isp-power")).toContainText("Powered");
    await page.click(".isp-power");
    await expect(page.locator(".isp-ops")).toBeHidden();
    await expect(page.locator(".isp-power")).toBeVisible();
    await expect(page.locator(".isp-power")).toHaveAttribute("aria-expanded", "false");
    await page.click(".isp-power");
    await expect(page.locator(".isp-ops")).toBeVisible();
  });

  test("9 compare versions: the real V1 and V2, side by side, with the changes the server computed", async ({ page }) => {
    test.setTimeout(400_000);
    // The real server routes and converter, with the two real files standing in for ACC's versions.
    const { createIfcSpatialApi } = await import("../server/ifcSpatial/api.mjs");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Readable } = await import("node:stream");
    const bytes = [readFileSync(new URL("../tests/fixtures/ifc/seagirt-compare-v1.ifc", import.meta.url)), readFileSync(new URL("../tests/fixtures/ifc/seagirt-compare-v2.ifc", import.meta.url))];
    const ids = ["urn:v?version=1", "urn:v?version=2"];
    const files = { hub: { id: "h" }, project: { id: "p", name: "Seagirt" }, files: [{ fileName: "seagirt_power_network.ifc", itemId: "urn:item", tipVersionId: ids[1],
      versions: [{ id: ids[1], versionNumber: 2, createTime: "2026-11-24T06:11:00Z", createUserName: "Test User" }, { id: ids[0], versionNumber: 1, createTime: "2026-11-23T07:24:00Z", createUserName: "Test User" }] }] };
    const api = createIfcSpatialApi({ aps: { dataClient: () => ({}), projectFiles: async () => files }, cacheDir: mkdtempSync(join(tmpdir(), "ifc-e2e-")), logger: { info() {}, warn() {}, error() {} },
      download: async (_c: unknown, _p: unknown, versionId: string) => ({ bytes: bytes[ids.indexOf(versionId)] }) });
    await page.route(/googleapis\.com/, route => route.abort());
    await page.route("**/api/ifc-spatial/**", async route => {
      const u = new URL(route.request().url());
      const req: any = Readable.from([]);
      Object.assign(req, { method: route.request().method(), url: u.pathname + u.search, headers: {} });
      let status = 200, headers: any = {}, body: any = "";
      await api.handle(req, { writeHead(s: number, h: any) { status = s; headers = h; }, end(b: any) { body = b ?? ""; } } as any);
      await route.fulfill({ status, headers, body: Buffer.isBuffer(body) ? body : String(body) });
    });
    await openTwin(page, "&screen=ifc-spatial");
    await page.waitForFunction(() => (window as any).__ifcSpatial?.state().phase === "ready", null, { timeout: 180_000 });
    const cmp = () => page.evaluate(() => (window as any).__ifcSpatial.compare.state());

    // The dialog: this file's versions from ACC, previous vs latest by default, two different ones required.
    await page.click('[data-act="compare"]');
    await expect(page.locator(".isp-cmp-dialog select[name=base] option")).toHaveCount(2);
    await expect(page.locator(".isp-cmp-dialog select[name=base]")).toHaveValue("1");
    await expect(page.locator(".isp-cmp-dialog select[name=target]")).toHaveValue("2");
    await page.selectOption(".isp-cmp-dialog select[name=base]", "2");
    await page.click(".isp-cmp-dialog button[type=submit]");
    await expect(page.locator("[data-cmp-msg]")).toHaveText("Choose two different versions.");
    await page.selectOption(".isp-cmp-dialog select[name=base]", "1");
    await page.click(".isp-cmp-dialog button[type=submit]");
    await page.waitForFunction(() => { const c = (window as any).__ifcSpatial.compare.state(); return c.summary && !c.busy && c.models.every(Boolean); }, null, { timeout: 300_000 });
    let c = await cmp();
    expect(c.summary).toMatchObject({ added: 4, moved: 1, modified: 2, removed: 0, total: 7 }); // TX-M2's status note is a status update, not a change
    expect(c.changes.filter((x: any) => x.status === "ADDED" && x.kind === "light").map((x: any) => x.networkId)).toEqual(["HM-12", "HM-13"]);
    await expect(page.locator(".isp-dc-total")).toHaveText("7 changes");
    expect(c.mode, "opens in All Changes").toBe("all");
    await expect(page.locator(".isp-dc-row")).toHaveCount(7);
    await expect(page.locator(".isp-cmp-pane[data-side='0'] .isp-cmp-tag")).toContainText("Version 1");
    await expect(page.locator(".isp-cmp-pane[data-side='1'] .isp-cmp-tag")).toContainText("Version 2");
    await expect(page.locator(".isp")).toHaveClass(/is-comparing/);
    expect(c.markers[1]).toBeGreaterThanOrEqual(6);

    // Selecting the moved asset: Focus on Change, its old and new location and the distance.
    const moved = c.changes.find((x: any) => x.status === "MOVED");
    await page.click(`.isp-dc-row[data-cmp-select="${moved.globalId}"]`);
    await expect(page.locator(".isp-dc-detail")).toContainText("Movement515 m");
    await expect(page.locator(".isp-dc-detail")).toContainText("Previous location");
    expect((await cmp()).selected).toBe(moved.globalId);
    expect((await cmp()).mode).toBe("focus");
    await page.click('[data-cmp="back"]');
    expect((await cmp()).mode).toBe("all");
    await page.click(`.isp-dc-row[data-cmp-select="${moved.globalId}"]`);
    await page.waitForTimeout(1500);

    // Camera sync, both ways; then unlocked.
    const same = async () => { const [a, b] = await page.evaluate(() => [0, 1].map(i => (window as any).__ifcSpatial.compare.camera(i))); return a.position.every((v: number, i: number) => Math.abs(v - b.position[i]) < 0.01); };
    await page.evaluate(() => (window as any).__ifcSpatial.compare.zoom(0, 80));
    await expect.poll(same, { timeout: 30_000 }).toBe(true);
    await page.evaluate(() => (window as any).__ifcSpatial.compare.zoom(1, -60));
    await expect.poll(same, { timeout: 30_000 }).toBe(true);
    await page.locator('[data-cmp-opt="sync"]').uncheck();
    await page.evaluate(() => (window as any).__ifcSpatial.compare.zoom(0, 50));
    await page.waitForTimeout(800);
    expect(await same()).toBe(false);
    await page.locator('[data-cmp-opt="sync"]').check();
    await expect.poll(same, { timeout: 30_000 }).toBe(true);

    // A click on a change marker in the updated view selects that change.
    await page.click('[data-cmp="reset"]');
    await page.waitForTimeout(2500);
    // The change whose marker is furthest from the others, so the click cannot land on a neighbour
    // (at the terminal alignment HM-12's marker sits on the end of the new cable L6e).
    const onScreen = await page.evaluate(ids => ids.map((g: string) => ({ g, p: (window as any).__ifcSpatial.compare.screenPosition(g, 1) })).filter((x: any) => x.p),
      c.changes.filter((x: any) => x.status !== "REMOVED").map((x: any) => x.globalId));
    const gap = (x: any) => Math.min(...onScreen.filter((y: any) => y !== x).map((y: any) => Math.hypot(x.p.x - y.p.x, x.p.y - y.p.y)));
    const target = onScreen.reduce((best: any, x: any) => (gap(x) > gap(best) ? x : best)).g;
    for (let i = 0; i < 6 && (await cmp()).selected !== target; i += 1) {
      const p = await page.evaluate(g => (window as any).__ifcSpatial.compare.screenPosition(g, 1), target);
      if (p) await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(600);
    }
    expect((await cmp()).selected).toBe(target);

    // Filters and modes.
    await page.click('[data-cmp-mode="all"]');
    await page.click('.isp-dc-chip[data-cmp-filter="ADDED"]');
    await expect(page.locator(".isp-dc-row")).toHaveCount(4);
    await page.click('[data-cmp-mode="full"]');
    expect((await cmp()).mode).toBe("full");

    // Switching versions: V2 against V1 reverses the change set.
    await page.click('[data-cmp="dialog"]');
    await page.selectOption(".isp-cmp-dialog select[name=base]", "2");
    await page.selectOption(".isp-cmp-dialog select[name=target]", "1");
    await page.click(".isp-cmp-dialog button[type=submit]");
    await page.waitForFunction(() => { const s = (window as any).__ifcSpatial.compare.state(); return s.base === 2 && s.summary && !s.busy && s.models.every(Boolean); }, null, { timeout: 300_000 });
    c = await cmp();
    expect(c.summary).toMatchObject({ added: 0, removed: 4, moved: 1 });

    // Exit: the screen as it was.
    await page.click('[data-cmp="exit"]');
    expect((await cmp()).active).toBe(false);
    await expect(page.locator(".isp")).not.toHaveClass(/is-comparing/);
    await expect(page.locator(".isp-cmp")).toBeHidden();
    expect((await spatial(page)).phase).toBe("ready");
    await openAsk(page);
  });

  test("10 asset documentation: ACC Docs PDFs linked to assets, the Documents tab, preview, download and manual linking", async ({ page }) => {
    test.setTimeout(300_000);
    const { createIfcSpatialApi } = await import("../server/ifcSpatial/api.mjs");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Readable } = await import("node:stream");
    // A stand-in for ACC Docs: the documentation folder with a few category folders.
    const tree: Record<string, { folders: { id: string; name: string }[]; files: string[] }> = {
      top: { folders: [{ id: "docs", name: "Asset Documentation" }], files: [] },
      docs: { folders: [{ id: "f1", name: "01_Substations" }, { id: "f11", name: "11_Cables_480V" }], files: ["00_Asset_register.pdf"] },
      f1: { folders: [], files: ["USS-1_Substation.pdf", "USS-1_RMU.pdf", "MSS_Substation.pdf"] },
      f11: { folders: [], files: ["L1_Cable.pdf", "X-99_Cable.pdf"] },
    };
    const client = { async getAll(path: string) {
      const id = decodeURIComponent(/folders\/([^/]+)\/contents/.exec(path)![1]);
      const node = tree[id] ?? { folders: [], files: [] };
      return { data: [...node.folders.map(f => ({ type: "folders", id: f.id, attributes: { displayName: f.name } })),
        ...node.files.map(f => ({ type: "items", id: `urn:item:${f}`, attributes: { displayName: f }, relationships: { tip: { data: { id: `urn:v:${f}?version=1` } } }, links: { webView: { href: `https://acc.autodesk.com/docs/files/projects/p?entityId=${f}` } } }))],
        included: node.files.map(f => ({ type: "versions", id: `urn:v:${f}?version=1`, attributes: { name: f, versionNumber: 1, fileType: "pdf", storageSize: 2048, lastModifiedTime: "2026-11-24T08:53:00Z" } })) };
    } };
    const model = readFileSync(new URL("../tests/fixtures/ifc/seagirt-compare-v2.ifc", import.meta.url));
    const v = "urn:model?version=3";
    const files = { hub: { id: "h" }, project: { id: "b.p", name: "Seagirt" }, topFolders: [{ id: "top", name: "Project Files" }],
      files: [{ fileName: "seagirt_power_network.ifc", itemId: "urn:i", tipVersionId: v, versions: [{ id: v, versionNumber: 3 }] }] };
    const streamed: string[] = [];
    const api = createIfcSpatialApi({ aps: { dataClient: () => client, projectFiles: async () => files }, cacheDir: mkdtempSync(join(tmpdir(), "ifc-docs-e2e-")), logger: { info() {}, warn() {}, error() {} },
      download: async () => ({ bytes: model }),
      openStream: async (_c: unknown, _p: unknown, versionId: string) => { streamed.push(versionId); return { body: Readable.from([Buffer.from("%PDF-1.4\n%%EOF\n")]), contentLength: 15, fileName: versionId.replace(/^urn:v:/, "").replace(/\?.*$/, "") }; } });
    await page.route(/googleapis\.com/, route => route.abort());
    await page.route("**/api/ifc-spatial/**", async route => {
      const u = new URL(route.request().url());
      const body = route.request().postDataBuffer();
      const req: any = Readable.from(body ? [body] : []);
      Object.assign(req, { method: route.request().method(), url: u.pathname + u.search, headers: {} });
      let status = 200, headers: any = {}; const parts: Buffer[] = [];
      await api.handle(req, { writeHead(s: number, h: any) { status = s; headers = h; }, write(c: any) { parts.push(Buffer.from(c)); }, end(b: any) { if (b) parts.push(Buffer.from(b)); } } as any);
      await route.fulfill({ status, headers, body: Buffer.concat(parts) });
    });
    await openTwin(page, "&screen=ifc-spatial");
    await page.waitForFunction(() => (window as any).__ifcSpatial?.state().phase === "ready", null, { timeout: 180_000 });
    // The index loads with the model (the server syncs: its index was missing).
    await page.waitForFunction(() => (window as any).__ifcSpatial.documents.state().summary, null, { timeout: 60_000 });
    const docsState = () => page.evaluate(() => (window as any).__ifcSpatial.documents.state());
    expect((await docsState()).summary).toMatchObject({ total: 6, matched: 4, unmatched: 1, reference: 1, ambiguous: 0 });

    // The asset panel: tabs, and USS-1's two documents.
    await page.evaluate(() => (window as any).__ifcSpatial.selectAsset("USS-1"));
    await expect(page.locator(".isp-net-panel .isp-tab")).toHaveText(["Overview", "Connections", "Properties", "Documents (2)"]);
    await page.click('.isp-net-panel [data-asset-tab="documents"]');
    await expect(page.locator(".isp-net-panel .isp-doc")).toHaveCount(2);
    await expect(page.locator(".isp-net-panel .isp-doc").first()).toContainText("Source: Autodesk Construction Cloud");
    await expect(page.locator('.isp-net-panel a:has-text("Open in ACC")').first()).toHaveAttribute("href", /^https:\/\/acc\.autodesk\.com\//);
    const download = page.locator('.isp-net-panel a:has-text("Download")').first();
    await expect(download).toHaveAttribute("href", /\/api\/ifc-spatial\/documents\/[a-f0-9]{24}\/content\?download=1$/);
    // The tab stays when moving to another asset; one without documents says so.
    await page.evaluate(() => (window as any).__ifcSpatial.selectAsset("AP-01"));
    await expect(page.locator(".isp-net-panel .isp-doc-none")).toHaveText("No document linked to this asset.");
    await page.evaluate(() => (window as any).__ifcSpatial.selectAsset("USS-1"));

    // Preview: the PDF from the server's content route, inline.
    await page.locator(".isp-net-panel [data-doc-preview]").first().click();
    const src = (await docsState()).previewSrc;
    expect(src).toMatch(/\/api\/ifc-spatial\/documents\/[a-f0-9]{24}\/content$/);
    const fetched = await page.evaluate(async u => { const r = await fetch(u); return [r.status, r.headers.get("content-type"), (await r.text()).slice(0, 5)]; }, src);
    expect(fetched).toEqual([200, "application/pdf", "%PDF-"]);
    expect(streamed.at(-1)).toMatch(/USS-1_(Substation|RMU)\.pdf\?version=1$/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".isp-docview-wrap")).toBeHidden();

    // Management: totals, filter, and linking the unmatched document by hand.
    await page.click('[data-act="docs"]');
    await expect(page.locator(".isp-docs")).toBeVisible();
    await page.click('[data-docs-status="unmatched"]');
    await expect(page.locator(".isp-docs-table tbody tr")).toHaveCount(1);
    await expect(page.locator(".isp-docs-table tbody tr")).toContainText("X-99_Cable.pdf");
    await page.click(".isp-docs-table [data-docs-assign]");
    await page.fill(".isp-docs-assign input", "L1");
    await page.click('.isp-docs-assign button[type="submit"]');
    await page.waitForFunction(() => (window as any).__ifcSpatial.documents.state().summary.unmatched === 0);
    await page.click('[data-docs-status="matched"]');
    await expect(page.locator(".isp-docs-table tbody tr", { hasText: "X-99_Cable.pdf" })).toContainText("Matched · manual");
    // A non-network element (the main-substation assembly) opens in the element panel with its document.
    await page.click('.isp-docs-table [data-docs-asset="MSS"]');
    await expect(page.locator(".isp-docs")).toBeHidden();
    await expect(page.locator(".isp-right:not(.isp-net-panel)")).toBeVisible();
    await expect(page.locator(".isp-right:not(.isp-net-panel)")).toContainText("MSS_Substation.pdf");
    // Sync again: the manual link is kept.
    await page.click('[data-act="docs"]');
    await page.click("[data-docs-sync]");
    await page.waitForFunction(() => !(window as any).__ifcSpatial.documents.state().loading && (window as any).__ifcSpatial.documents.state().summary.unmatched === 0);
  });

  test("11 a large comparison (the real V3 → V4, 131 changes): significant changes, groups, clusters, all changes, full network; Ask the Twin on it", async ({ page }) => {
    test.setTimeout(900_000);
    const { createIfcSpatialApi } = await import("../server/ifcSpatial/api.mjs");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Readable } = await import("node:stream");
    const bytes = [readFileSync(new URL("../tests/fixtures/ifc/seagirt-compare-v3.ifc", import.meta.url)), readFileSync(new URL("../tests/fixtures/ifc/seagirt-compare-v4.ifc", import.meta.url))];
    const ids = ["urn:v?version=3", "urn:v?version=4"];
    const files = { hub: { id: "h" }, project: { id: "p", name: "Seagirt" }, topFolders: [], files: [{ fileName: "seagirt_power_network.ifc", itemId: "urn:item", tipVersionId: ids[1],
      versions: [{ id: ids[1], versionNumber: 4, createTime: "2026-11-24T10:19:00Z" }, { id: ids[0], versionNumber: 3, createTime: "2026-11-24T08:28:00Z" }] }] };
    const api = createIfcSpatialApi({ aps: { dataClient: () => ({ getAll: async () => ({ data: [], included: [] }) }), projectFiles: async () => files }, cacheDir: mkdtempSync(join(tmpdir(), "ifc-e2e-large-")),
      logger: { info() {}, warn() {}, error() {} }, download: async (_c: unknown, _p: unknown, versionId: string) => ({ bytes: bytes[ids.indexOf(versionId)] }) });
    await page.route(/googleapis\.com/, route => route.abort());
    await page.route("**/api/ifc-spatial/**", async route => {
      const u = new URL(route.request().url());
      const post = route.request().postDataBuffer();
      const req: any = Readable.from(post ? [post] : []);
      Object.assign(req, { method: route.request().method(), url: u.pathname + u.search, headers: {} });
      let status = 200, headers: any = {}; const parts: Buffer[] = [];
      await api.handle(req, { writeHead(s: number, h: any) { status = s; headers = h; }, write(c: any) { parts.push(Buffer.from(c)); }, end(b: any) { if (b) parts.push(Buffer.from(b)); } } as any);
      await route.fulfill({ status, headers, body: Buffer.concat(parts) });
    });
    await openTwin(page, "&screen=ifc-spatial");
    await page.waitForFunction(() => (window as any).__ifcSpatial?.state().phase === "ready", null, { timeout: 180_000 });
    const cmp = () => page.evaluate(() => (window as any).__ifcSpatial.compare.state());
    await page.click('[data-act="compare"]');
    await page.click(".isp-cmp-dialog button[type=submit]");
    await page.waitForFunction(() => { const c = (window as any).__ifcSpatial.compare.state(); return c.summary && !c.busy && c.models.every(Boolean); }, null, { timeout: 300_000 });
    let c = await cmp();
    // The engine's counts, untouched.
    expect(c.summary).toMatchObject({ added: 33, moved: 0, modified: 98, removed: 0, unchanged: 97, total: 131 });
    // Large: Significant Changes by default; property-only changes not on the map.
    expect([c.density, c.mode, c.significant, c.shownOnMap]).toEqual(["large", "significant", 35, 35]);
    expect(c.groups.map((g: any) => [g.label, g.count])).toEqual([["New Circuit Breakers", 33], ["Modified Network", 2], ["Modified Properties", 96]]);
    expect(c.groups.reduce((n: number, g: any) => n + g.count, 0)).toBe(131);
    await expect(page.locator(".isp-dc-total")).toHaveText("131 changes");
    await expect(page.locator(".isp-dc-group")).toHaveCount(3);
    await expect(page.locator('.isp-cmp-modes [data-cmp-mode="significant"]')).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(2500);
    // Clusters, not 131 labels: a handful of labels in the updated view.
    const labels = c.labels[1].length ? c.labels[1] : (await cmp()).labels[1];
    expect(labels.length).toBeLessThanOrEqual(8);
    expect(labels.some((l: string) => /New Circuit Breakers/.test(l))).toBe(true);

    // A group: its assets only, framed; expanded, its elements, searchable; one of them in focus.
    await page.click('[data-cmp-group="added-breaker"]');
    c = await cmp();
    expect([c.group, c.shownOnMap]).toEqual(["added-breaker", 33]);
    await page.click('[data-cmp-group-open="added-breaker"]');
    await expect(page.locator(".isp-dc-group.is-open .isp-dc-row")).toHaveCount(33);
    await page.fill("[data-cmp-group-search]", "CB-STS");
    await expect(page.locator(".isp-dc-group.is-open .isp-dc-row")).toHaveCount(12);
    await page.click('.isp-dc-group.is-open .isp-dc-row >> text=CB-STS-05');
    c = await cmp();
    expect([c.mode, c.selectedStatus]).toEqual(["focus", "ADDED"]);
    await expect(page.locator(".isp-dc-detail")).toContainText("New Circuit Breaker CB-STS-05");
    await page.click('[data-cmp="back"]');
    expect((await cmp()).mode).toBe("significant");
    await page.click('[data-cmp-group="added-breaker"]');

    // Hiding a group; All Changes; Full Network.
    await page.locator('[data-cmp-group-toggle="added-breaker"]').uncheck();
    expect((await cmp()).shownOnMap).toBe(2);
    await page.locator('[data-cmp-group-toggle="added-breaker"]').check();
    await page.click('[data-cmp-mode="all"]');
    c = await cmp();
    expect([c.mode, c.shownOnMap]).toEqual(["all", 131]);
    await page.waitForTimeout(1500);
    expect((await cmp()).labels[1].length).toBeLessThanOrEqual(10);
    await page.click('[data-cmp-mode="full"]');
    expect((await cmp()).mode).toBe("full");
    // Every change stays reachable in the flat list.
    await page.click('[data-cmp-view="list"]');
    await page.fill("[data-cmp-list-search]", "AP-");
    expect(await page.locator(".isp-dc-row").count()).toBeGreaterThan(10);
    await page.click('[data-cmp="exit"]');
    expect((await cmp()).active).toBe(false);

    // Ask the Twin on the same versions: a comparison answer, follow-ups, and the viewer opened on the answer.
    await openAsk(page);
    const askQ = async (q: string) => { await page.fill(".isp-askbar input", q); await page.press(".isp-askbar input", "Enter"); };
    const answer = () => page.evaluate(() => (window as any).__ifcSpatial.state().network.answer);
    await askQ("What changed between V3 and V4?");
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().network.answer?.status === "answered", null, { timeout: 120_000 });
    expect((await answer()).title).toBe("131 changes between V3 and V4");
    await expect(page.locator(`${ANSWER} .tw-metric`)).toHaveCount(5);
    await expect(page.locator(`${ANSWER} .tw-metric`).first()).toContainText("33");
    await expect(page.locator(`${ANSWER} .tw-sources`)).toContainText("IFC comparison V3 → V4");
    await askQ("Show me the newly added assets");
    await page.waitForFunction(() => /added/.test((window as any).__ifcSpatial.state().network.answer?.title ?? ""));
    await askQ("Which of those are circuit breakers?");
    await page.waitForFunction(() => /^33 circuit breakers added/.test((window as any).__ifcSpatial.state().network.answer?.title ?? ""));
    await askQ("What changed between V7 and V9?");
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().network.answer?.status === "error");
    await expect(page.locator(ANSWER)).toContainText("There is no version V7 or V9");
    await expect(page.locator(`${ANSWER} [data-ask="What changed between V7 and V9?"]`)).toHaveText("Retry");
    // A network question still goes to the network, laid out: a short direct answer, grouped items.
    await askQ("What is connected to USS-1?");
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().network.result?.intent === "DOWNSTREAM");
    await expect(page.locator(`${ANSWER} .tw-result`).first()).toBeVisible();
    const lead = page.locator(`${ANSWER} .tw-lead`);
    expect((await lead.count()) ? await lead.innerText() : "").not.toMatch(/(\b[A-Z]+-\d+\b.*){8}/);
    // "Show them on the map" stays on the current map; an asset row focuses that asset; only the button opens the comparison.
    await askQ("How many assets were added in V4?");
    await page.waitForFunction(() => /33 assets added/.test((window as any).__ifcSpatial.state().network.answer?.title ?? ""));
    await askQ("Show them on the map");
    await page.waitForFunction(() => /added/.test((window as any).__ifcSpatial.state().network.answer?.title ?? "") && (window as any).__ifcSpatial.state().network.answer?.status === "answered");
    expect((await page.evaluate(() => (window as any).__ifcSpatial.compare.state())).active).toBe(false);
    await askQ("What changed in CB-STS-05?");
    await page.waitForFunction(() => /CB-STS-05 was added in V4/.test((window as any).__ifcSpatial.state().network.answer?.title ?? ""));
    await askQ("What changed between V3 and V4?");
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().network.answer?.title === "131 changes between V3 and V4");
    const row = page.locator(`${ANSWER} [data-cmp-asset]`).first();
    const rowId = await row.getAttribute("data-cmp-asset");
    await row.click();
    await page.waitForTimeout(500);
    expect((await page.evaluate(() => (window as any).__ifcSpatial.compare.state())).active).toBe(false);
    if ((await spatial(page)).network.assetIds?.includes?.(rowId)) expect((await spatial(page)).network.selectedId).toBe(rowId);
    await page.click(`${ANSWER} [data-cmp-show]`);
    expect((await page.evaluate(() => (window as any).__ifcSpatial.compare.state())).active).toBe(false);
    await page.locator(`${ANSWER} [data-cmp-open]`).click();
    await page.waitForFunction(() => (window as any).__ifcSpatial.compare.state().active, null, { timeout: 300_000 });
    await expect(page.locator(".isp-ask")).toBeHidden();
    await page.click('[data-cmp="exit"]');
    await expect(page.locator(".isp-askp")).toBeVisible();

    // Select Area: the same comparison inside an area (each version placed at its own positions).
    const all = await page.evaluate(() => { const s = (window as any).__ifcSpatial; return ["TX-M1", "TX-M2", "STS-01", "STS-12", "HM-1", "QSS-W", "QSS-E"].map(id => s.area.lonLat(id)).filter(Boolean); });
    const lo = all.map((p: any) => p.lon), la = all.map((p: any) => p.lat), m = 0.004;
    await page.evaluate(r => (window as any).__ifcSpatial.area.select(r, "POLYGON"), [[Math.min(...lo) - m, Math.min(...la) - m], [Math.max(...lo) + m, Math.min(...la) - m], [Math.max(...lo) + m, Math.max(...la) + m], [Math.min(...lo) - m, Math.max(...la) + m]]);
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().network.area);
    await askQ("What changed in this area between V3 and V4?");
    await page.waitForFunction(() => { const a = (window as any).__ifcSpatial.state().network.answer; return a?.kind === "Area version changes" && a.status !== "loading"; }, null, { timeout: 300_000 });
    await expect(page.locator(`${ANSWER} .tw-scope`)).toContainText("Selected area");
    await expect(page.locator(`${ANSWER} .tw-say`)).toContainText(/Between V3 and V4, .* in the selected area\./);
    expect((await page.evaluate(() => (window as any).__ifcSpatial.compare.state())).active).toBe(false);
    // An area away from the terminal: no changes in it.
    await page.evaluate(() => (window as any).__ifcSpatial.area.select([[-76.60, 39.20], [-76.599, 39.20], [-76.599, 39.201], [-76.60, 39.201]], "POLYGON"));
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().network.area?.inside.length === 0);
    await askQ("Were any transformers added in this area?");
    await page.waitForFunction(() => { const a = (window as any).__ifcSpatial.state().network.answer; return a?.kind === "Area version changes" && a.status !== "loading"; }, null, { timeout: 300_000 });
    await expect(page.locator(`${ANSWER} .tw-say`)).toContainText(/^No added transformers in the selected area/);
    await page.evaluate(() => (window as any).__ifcSpatial.area.clear());
  });

  test("12 Ask the Twin results on the map: highlighted, selected without losing the set, back, clustered, cleared", async ({ page }) => {
    test.setTimeout(300_000);
    await mockSpatial(page);
    await openTwin(page, "&screen=ifc-spatial");
    await ready(page);
    const hl = () => page.evaluate(() => (window as any).__ifcSpatial.askHighlights.state());
    const title = () => page.evaluate(() => { const n = (window as any).__ifcSpatial.state().network; return n.answer?.title ?? n.result?.title ?? ""; });
    const askQ = async (q: string) => { await page.fill(".isp-askbar input", q); await page.press(".isp-askbar input", "Enter"); };
    await openAsk(page);

    await askQ("Show me all transformers installed across Seagirt");
    await page.waitForFunction(() => ((window as any).__ifcSpatial.askHighlights.state()?.count ?? 0) >= 9);
    let s = await hl();
    const n = s.count;
    expect(s.ids).toEqual(expect.arrayContaining(["TX-M1", "TX-M2", "TX-1", "TX-7"]));
    expect(s.ids.every((id: string) => /^TX-/.test(id))).toBe(true);
    expect(s.mode).toBe("individual");
    await expect(page.locator(".isp-ask-hl")).toContainText(`${n} assets highlighted`);
    expect(await title()).toMatch(new RegExp(`${n} transformers`));
    // The sentence says how many and that they are on the map; the card is the rows: five, the rest folded; a ring per located result.
    await expect(page.locator(`${ANSWER} .tw-say`)).toContainText(`I found ${n} transformers across Seagirt and highlighted`);
    await expect(page.locator(`${ANSWER} .tw-coll > .tw-coll-rows .tw-crow`)).toHaveCount(5);
    await expect(page.locator(`${ANSWER} .tw-coll-more summary`)).toContainText(`+ ${n - 5} more`);
    await expect(page.locator(`${ANSWER} .tw-keys`)).toHaveCount(0);
    expect(s.effects).toBe(s.count);

    // Selecting a result keeps the set: emphasised, details open, Back to results.
    await page.locator('.tw-crow[data-asset="TX-M1"]').first().click({ force: true });
    await page.waitForFunction(() => (window as any).__ifcSpatial.askHighlights.state()?.selected === "TX-M1");
    await expect(page.locator(`${ANSWER} .tw-crow.is-selected`)).toHaveAttribute("data-asset", "TX-M1");
    s = await hl();
    expect(s.count).toBe(n);
    expect(s.back).toBe(true);
    await expect(page.locator(".isp-insp-foot")).toContainText(`Back to Results (${n})`);
    await expect(page.locator(".isp-net-panel")).toContainText("Main transformer TX-M1");
    await expect(page.locator(".isp-net-panel")).toContainText("illustrative, not surveyed");
    await page.click('.isp-insp-foot [data-act="askBack"]', { force: true });
    await expect.poll(title).toMatch(new RegExp(`${n} transformers`));
    expect((await hl()).selected).toBe(null);
    expect((await hl()).count).toBe(n);

    // A new question replaces the set; many results cluster.
    await askQ("What is downstream of TX-M1?");
    await page.waitForFunction(() => ((window as any).__ifcSpatial.askHighlights.state()?.ids.length ?? 0) > 50);
    s = await hl();
    expect(s.ids).not.toContain("TX-7");
    expect(s.mode).toBe("cluster");
    expect(s.labels.length).toBeLessThan(s.count);

    await askQ("Which cables connect USS-1 to the main substation?");
    await page.waitForFunction(() => /connects? USS-1 and the main substation/.test((window as any).__ifcSpatial.state().network.answer?.title ?? ""));
    expect((await hl()).ids).toContain("USS-1");

    await page.click('.isp-ask-hl [data-act="askClear"]', { force: true });
    await page.waitForFunction(() => (window as any).__ifcSpatial.askHighlights.state()?.ids.length === 0);
    await expect(page.locator(".isp-ask-hl")).toBeHidden();

    // Power status comes from the screen's own statuses (the engine alone cannot answer it).
    await askQ("Which assets have no power?");
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().network.answer?.kind === "Power status");
    expect(await title()).toMatch(/no power/);
  });

  test("13 the Ask the Twin panel: docked left, welcome and suggested questions, the conversation in the panel, collapse and reopen", async ({ page }) => {
    test.setTimeout(300_000);
    await mockSpatial(page);
    await openTwin(page, "&screen=ifc-spatial");
    await ready(page);
    const panel = page.locator(".isp-askp");
    // Collapsed to its launcher at first; Labels off; Power Status in the header only.
    await expect(page.locator(".isp-ask")).toHaveClass(/is-collapsed/);
    await expect(page.locator('[data-toggle="labels"]')).toHaveAttribute("aria-pressed", "false");
    await openAsk(page);
    await expect(panel).toBeVisible();
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeLessThan(120);
    expect(box.width).toBeGreaterThanOrEqual(360);
    await expect(page.locator(".isp-askp-head h2")).toContainText("Ask the Twin");
    await expect(page.locator(".isp-askp-welcome h3")).toHaveText("Welcome to Ask the Twin");
    await expect(page.locator(".isp-askp-card")).toHaveText(["Show all transformers", "Which assets have no power?", "What does TX-M1 supply?", "Compare IFC versions"]);
    await expect(page.locator(".isp-askbar input")).toHaveAttribute("placeholder", "Ask about your twin...");
    // Decorative graphics are hidden from assistive technology.
    expect(await page.locator(".isp-askp svg:not([aria-hidden='true'])").count()).toBe(0);

    // An empty question is not sent.
    await page.press(".isp-askbar input", "Enter");
    await expect(page.locator(".isp-turn")).toHaveCount(0);

    // A suggested question goes through the same flow; the answer is in the panel, not in a card on the right.
    await page.click(".isp-askp-card >> nth=0", { force: true });
    await expect(page.locator(".isp-askp-welcome")).toBeHidden();
    await expect(page.locator(".isp-turn .isp-msg-user")).toHaveText("Show me all transformers installed across Seagirt.");
    await expect(page.locator(`${ANSWER} .tw-say`)).toContainText("transformers");
    await expect(page.locator(".isp-net-panel")).toBeHidden();
    await page.fill(".isp-askbar input", "What does TX-M1 supply?");
    await page.press(".isp-askbar input", "Enter");
    await expect(page.locator(".isp-turn")).toHaveCount(2);
    await expect(page.locator(".isp-askbar input")).toHaveValue("");

    // Collapse to the launcher and back: the conversation is kept.
    await page.click('[data-act="askCollapse"]');
    await expect(page.locator(".isp-askp-launcher")).toBeVisible();
    await expect(page.locator(".isp-ask")).toHaveClass(/is-collapsed/);
    await page.click('[data-act="askExpand"]');
    await expect(page.locator(".isp-ask")).not.toHaveClass(/is-collapsed/);
    await expect(page.locator(".isp-turn")).toHaveCount(2);
    await expect(page.locator(".isp-askbar input")).toBeFocused();
  });

  test("14 document intelligence: a tabbed review read from the asset's ACC PDFs, numbered citations that open the cited page", async ({ page }) => {
    test.setTimeout(300_000);
    const { createIfcSpatialApi } = await import("../server/ifcSpatial/api.mjs");
    const { specSheet, inspectionReport } = await import("../tests/pdfFixtures.mjs");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Readable } = await import("node:stream");
    // ACC Docs with TX-M1's asset sheet and three inspection reports (controlled contents), and TX-M2's sheet only.
    const pdfs: Record<string, Uint8Array> = {
      "TX-M1_Transformer.pdf": specSheet({ assetId: "TX-M1", fields: [["Rating", "34.5/13.8 kV, 12 MVA"], ["PrimaryVoltage", "34,500 V"], ["SecondaryVoltage", "13,800 V"], ["MaximumApparentPower", "12,000,000 VA"],
        ["Overall size L x W x H (m)", "8.40 x 4.50 x 4.20"], ["CapacitykW", "11,000"]] }),
      "TX-M1_Transformer_Inspection-2024-001_2024-03-14.pdf": inspectionReport({ assetId: "TX-M1", date: "2024-03-14", number: "INS-M1-2024", condition: "GOOD (4/5)",
        summary: ["Transformer in good condition. A light weep at radiator 3 was noted for monitoring."], findings: [["Radiators and cooling fans", "Attention", "Light weep at radiator 3 lower flange."], ["Bushings (HV and LV)", "OK", "Clean."]],
        measures: [["Test", "Result", "Previous"], ["Moisture in oil (ppm)", "12", "11"]], actions: [["Re-check radiator 3 flange at next inspection", "Low", "2025-03-14"]] }),
      "TX-M1_Transformer_Inspection-2025-001_2025-04-10.pdf": inspectionReport({ assetId: "TX-M1", date: "2025-04-10", number: "INS-M1-2025", condition: "FAIR (3/5)", conditions: "Overcast, 14 deg C",
        summary: ["Condition Fair. Radiator 3 flange dripping and fan 4 has failed."], findings: [["Radiators and cooling fans", "Attention", "Radiator 3 flange dripping. Fan 4 motor seized."], ["Bushings (HV and LV)", "OK", "Clean."]],
        measures: [["Test", "Result", "Previous (2024-03-14)"], ["Moisture in oil (ppm)", "18", "12"], ["Dielectric breakdown (kV, 2 mm gap)", "44", "52"]],
        actions: [["Repair radiator 3 flange gasket", "Medium", "2025-06-30"], ["Replace cooling fan 4 motor", "Medium", "2025-06-30"]] }),
      "TX-M1_Transformer_Inspection-2026-001_2026-10-28.pdf": inspectionReport({ assetId: "TX-M1", date: "2026-10-28", number: "INS-M1-2026", condition: "POOR (2/5)", conditions: "Clear, 12 deg C",
        summary: ["Condition Poor. The radiator 3 valve is still leaking and fan 4 is still out of service.", "The 2025 repair actions were not completed."],
        findings: [["Radiators and cooling fans", "Defect", "Radiator 3 valve still leaking. Fan 4 still failed."], ["Bushings (HV and LV)", "Defect", "Discolouration on LV X2 connector."]],
        measures: [["Test", "Result", "Previous (2025-04-10)"], ["Moisture in oil (ppm)", "27", "18"], ["Dielectric breakdown (kV, 2 mm gap)", "33", "44"]],
        actions: [["Prepare switching plan to carry Bus A loads during the outage", "High", "2026-11-27"]] }),
      "TX-M2_Transformer.pdf": specSheet({ assetId: "TX-M2", fields: [["Rating", "34.5/13.8 kV, 12 MVA"]] }),
    };
    const tree: Record<string, { folders: { id: string; name: string }[]; files: string[] }> = {
      top: { folders: [{ id: "docs", name: "Asset Documentation" }], files: [] },
      docs: { folders: [{ id: "f2", name: "02_Transformers" }], files: [] },
      f2: { folders: [], files: Object.keys(pdfs) },
    };
    const client = {
      async getAll(path: string) {
        const id = decodeURIComponent(/folders\/([^/]+)\/contents/.exec(path)![1]);
        const node = tree[id] ?? { folders: [], files: [] };
        return { data: [...node.folders.map(f => ({ type: "folders", id: f.id, attributes: { displayName: f.name } })),
          ...node.files.map(f => ({ type: "items", id: `urn:item:${f}`, attributes: { displayName: f }, relationships: { tip: { data: { id: `urn:v:${f}?version=1` } } }, links: { webView: { href: `https://acc.autodesk.com/docs/files/projects/p?entityId=${f}` } } }))],
          included: node.files.map(f => ({ type: "versions", id: `urn:v:${f}?version=1`, attributes: { name: f, versionNumber: 1, fileType: "pdf", storageSize: pdfs[f].length, lastModifiedTime: "2026-11-25T08:00:00Z" } })) };
      },
      async get() { return { data: {} }; },
    };
    const model = readFileSync(new URL("../tests/fixtures/ifc/seagirt-compare-v2.ifc", import.meta.url));
    const v = "urn:model?version=3";
    const files = { hub: { id: "h" }, project: { id: "b.p", name: "Seagirt" }, topFolders: [{ id: "top", name: "Project Files" }],
      files: [{ fileName: "seagirt_power_network.ifc", itemId: "urn:i", tipVersionId: v, versions: [{ id: v, versionNumber: 3 }] }] };
    const streamed: string[] = [];
    const analyses: string[] = [];
    const api = createIfcSpatialApi({ aps: { dataClient: () => client, projectFiles: async () => files }, cacheDir: mkdtempSync(join(tmpdir(), "ifc-docintel-e2e-")), logger: { info() {}, warn() {}, error() {} },
      download: async () => ({ bytes: model }),
      openStream: async (_c: unknown, _p: unknown, versionId: string) => {
        streamed.push(versionId);
        const name = versionId.replace(/^urn:v:/, "").replace(/\?.*$/, "");
        return { body: Readable.from([Buffer.from(pdfs[name])]), contentLength: pdfs[name].length, fileName: name };
      } });
    await page.route(/googleapis\.com/, route => route.abort());
    await page.route("**/api/ifc-spatial/**", async route => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith("/documents/analysis")) analyses.push(u.searchParams.get("asset")!);
      const body = route.request().postDataBuffer();
      const req: any = Readable.from(body ? [body] : []);
      Object.assign(req, { method: route.request().method(), url: u.pathname + u.search, headers: {} });
      let status = 200, headers: any = {}; const parts: Buffer[] = [];
      await api.handle(req, { writeHead(s: number, h: any) { status = s; headers = h; }, write(c: any) { parts.push(Buffer.from(c)); }, end(b: any) { if (b) parts.push(Buffer.from(b)); } } as any);
      await route.fulfill({ status, headers, body: Buffer.concat(parts) });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTwin(page, "&screen=ifc-spatial");
    await page.waitForFunction(() => (window as any).__ifcSpatial?.state().phase === "ready", null, { timeout: 180_000 });
    await page.waitForFunction(() => (window as any).__ifcSpatial.documents.state().summary, null, { timeout: 60_000 });

    await openAsk(page);
    await page.fill(".isp-askbar input", "Before we replace TX-M1, summarize its inspection history and technical specifications.");
    await page.press(".isp-askbar input", "Enter");
    const rev = page.locator(`${ANSWER} .tw-rev`);
    await expect(rev).toBeVisible({ timeout: 60_000 });
    // Only TX-M1's four documents were downloaded, each once (the citation preview below streams one again).
    expect(streamed.filter(x => /TX-M1_/.test(x))).toHaveLength(4);
    // No generic sentence before it: a compact sources row, one header, the demo-data notice, four tabs, Overview open.
    await expect(page.locator(`${ANSWER} .tw-say`)).toHaveCount(0);
    await expect(rev.locator(".tw-rev-src > summary")).toContainText("4 ACC documents analyzed");
    await expect(rev.locator(".tw-rev-h")).toContainText("TX-M1");
    await expect(rev.locator(".tw-rev-h")).toContainText("Transformer · Replacement review");
    await expect(rev.locator(".tw-rev-tab")).toHaveText(["Overview", "Inspections", "Specifications"]);
    await expect(rev.locator('.tw-rev-tab[aria-selected="true"]')).toHaveText("Overview");
    const overview = rev.locator('[data-doc-panel="overview"]');
    await expect(overview.locator(".tw-concl h4")).toHaveText("Engineering review required");
    await expect(overview.locator(".tw-ct svg")).toHaveAttribute("aria-label", "Documented condition rating: 2024-03-14: Good 4/5, 2025-04-10: Fair 3/5, 2026-10-28: Poor 2/5");
    await expect(overview.locator(".tw-rmetric")).toHaveCount(3);
    await expect(overview.locator(".tw-rmetric").first()).toContainText("2Latest defects");
    expect(await overview.locator(".tw-concern").count()).toBeLessThanOrEqual(3);
    // Recommended next steps: one row named for the question, collapsed until it is clicked.
    await expect(overview.locator(".tw-rnext h5")).toHaveText("Recommended next steps");
    const steps = overview.locator(".tw-rstep");
    await expect(steps.locator(":scope > summary span")).toHaveText("Before replacement");
    await expect(steps.locator(".tw-rstep-b")).toBeHidden();
    await steps.locator(":scope > summary").click();
    await expect(steps.locator(".tw-rstep-b")).toBeVisible();
    await expect(steps.locator(".tw-rgroup").first()).toHaveText("Electrical compatibility");
    await expect(steps).toContainText("Match the replacement to the documented ratings");
    await steps.locator(":scope > summary").click();
    await expect(overview.locator(".tw-rnext")).toContainText("Electrical compatibility");
    await expect(overview.locator(".tw-rnext")).toContainText("not an authorization to replace");
    await expect(overview).not.toContainText(/\bClose [A-Z]+-\d|Isolate upstream at/);
    // At 1440 × 900 the conclusion, the trend and the metrics are in view without scrolling the panel.
    const body = page.locator(".isp-askp-body");
    const bodyBox = (await body.boundingBox())!;
    const metricsBox = (await overview.locator(".tw-rmetrics").boundingBox())!;
    expect(metricsBox.y + metricsBox.height).toBeLessThanOrEqual(bodyBox.y + bodyBox.height + 1);
    const trendBox = (await overview.locator(".tw-ct").boundingBox())!;
    expect(trendBox.height).toBeLessThanOrEqual(140);
    // The footer never covers the answer: the scroll area ends where the input area starts.
    const footBox = (await page.locator(".isp-askp-foot").boundingBox())!;
    expect(bodyBox.y + bodyBox.height).toBeLessThanOrEqual(footBox.y + 1);
    await expect(page.locator(".isp-ask-hl")).toContainText("TX-M1 selected");
    await page.screenshot({ path: test.info().outputPath("review-1440-overview.png") });

    // Tabs: another panel, nothing re-requested, the asset still selected.
    const requestsBefore = analyses.length, streamedBefore = streamed.length;
    for (const [tab, name] of [["Inspections", "inspections"], ["Specifications", "specifications"], ["Overview", "overview"]]) {
      await rev.locator(".tw-rev-tab", { hasText: tab }).click();
      await expect(rev.locator(`[data-doc-panel="${name}"]`)).toBeVisible();
      await expect(rev.locator('[data-doc-panel]:visible')).toHaveCount(1);
      await page.screenshot({ path: test.info().outputPath(`review-1440-${name}.png`) });
    }
    expect(analyses.length).toBe(requestsBefore);
    expect(streamed.length).toBe(streamedBefore);
    expect((await spatial(page)).network.selected ?? (await spatial(page)).network.selectedId).toBe("TX-M1");

    // Inspections: latest first, collapsed; a card opens to its findings.
    await rev.locator(".tw-rev-tab", { hasText: "Inspections" }).click();
    const insp = rev.locator('[data-doc-panel="inspections"]');
    await expect(insp.locator(".tw-insp").first()).toContainText("2026-10-28");
    await expect(insp.locator(".tw-insp[open]")).toHaveCount(0);
    await insp.locator(".tw-insp > summary").first().click();
    await expect(insp.locator(".tw-insp").first().locator(".tw-insp-b")).toContainText("Discolouration on LV X2 connector");
    await expect(insp.locator(".tw-comp", { hasText: "Radiators and cooling fans" }).locator(".tw-rtag")).toHaveText("Worsening");
    await expect(insp.locator(".tw-rsec > summary")).toContainText("deteriorated");
    await expect(insp).toContainText("Without verified closure");
    await expect(insp).not.toContainText("moved the usual way");
    // Specifications: engineering units, the missing fields grouped.
    await rev.locator(".tw-rev-tab", { hasText: "Specifications" }).click();
    const spec = rev.locator('[data-doc-panel="specifications"]');
    await expect(spec.locator(".tw-rspec-hl")).toContainText("12 MVA");
    await expect(spec.locator(".tw-rspec-hl")).toContainText("34.5 / 13.8 kV");
    await expect(spec.locator(".tw-rmiss > summary")).toContainText(/\d+ key specifications missing/);
    // Back to the Overview: its next steps hold the replacement checks and the electrical model.
    await rev.locator(".tw-rev-tab", { hasText: "Overview" }).click();
    const repl = overview;
    // A citation number: the source card, then the existing preview at that page; the tab and the conversation stay.
    const turns = await page.locator(".isp-turn").count();
    const ref = repl.locator(".tw-ref[data-ref-page]").first();
    const refPage = await ref.getAttribute("data-ref-page");
    await ref.click();
    const pop = rev.locator(".tw-cpop");
    await expect(pop).toBeVisible();
    await expect(pop).toContainText(`page ${refPage}`);
    await expect(pop.locator("a", { hasText: "Open in ACC" })).toHaveAttribute("href", /acc\.autodesk\.com/);
    await pop.locator("[data-doc-cite]").click();
    const frame = page.locator(".isp-docview-frame");
    await expect(frame).toBeVisible();
    expect(await frame.getAttribute("src")).toMatch(new RegExp(`/content#page=${refPage}$`));
    await page.click("[data-doc-close]");
    await expect(page.locator(".isp-turn")).toHaveCount(turns);
    await expect(rev.locator('.tw-rev-tab[aria-selected="true"]')).toHaveText("Overview");

    // Open outage simulation (Before replacement): the existing panel on the right; the review stays as it was.
    const sim = repl.locator('[data-act="docSimulate"]');
    if (await sim.count()) {
      await repl.locator(".tw-rstep > summary").click();
      await sim.click();
      await expect(page.locator(".isp-sim")).toBeVisible({ timeout: 15_000 });
      await expect(rev).toBeVisible();
      await expect(rev.locator('.tw-rev-tab[aria-selected="true"]')).toHaveText("Overview");
      await page.screenshot({ path: test.info().outputPath("review-simulation.png") });
      await page.locator('.isp-sim .isp-sim-reset').click();
      await expect(page.locator('.isp-sim')).toHaveCount(0);
      await expect(rev.locator('.tw-rev-tab[aria-selected="true"]')).toHaveText("Overview");
    }

    // Other desktop sizes and a smaller window: the review fits the panel, nothing overflows sideways.
    for (const [w, h] of [[1920, 1080], [1280, 720]]) {
      await page.setViewportSize({ width: w, height: h });
      await rev.locator(".tw-rev-tab", { hasText: "Overview" }).click();
      const card = (await rev.locator(".tw-rev-card").boundingBox())!;
      const panel = (await page.locator(".isp-askp").boundingBox())!;
      expect(card.x + card.width).toBeLessThanOrEqual(panel.x + panel.width);
      await page.screenshot({ path: test.info().outputPath(`review-${w}-overview.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    // Only TX-M1's documents were downloaded, each once; TX-M2's sheet was not used.
    expect(streamed.some(x => /TX-M2_/.test(x))).toBe(false);
    const downloaded = streamed.length;
    const asked = analyses.length;

    // Follow-ups on the same asset reuse the analysis already read: no new request, the right tab open.
    await page.fill(".isp-askbar input", "What specifications are missing?");
    await page.press(".isp-askbar input", "Enter");
    await expect(page.locator(`${ANSWER} .tw-rev-tab[aria-selected="true"]`)).toHaveText("Specifications", { timeout: 30_000 });
    await expect(page.locator(`${ANSWER} .tw-rmiss[open]`)).toBeVisible();
    await page.fill(".isp-askbar input", "Which actions are not verified closed?");
    await page.press(".isp-askbar input", "Enter");
    await expect(page.locator(`${ANSWER} .tw-rev-tab[aria-selected="true"]`)).toHaveText("Overview", { timeout: 30_000 });
    await expect(page.locator(`${ANSWER} .tw-rstep > summary span`)).toHaveText("Maintenance considerations");
    await expect(page.locator(ANSWER)).toContainText("Not according to the documents");
    await page.fill(".isp-askbar input", "Has TX-M1's condition deteriorated over time?");
    await page.press(".isp-askbar input", "Enter");
    await expect(page.locator(`${ANSWER} .tw-rstep > summary span`)).toHaveText("Condition assessment", { timeout: 30_000 });
    await page.fill(".isp-askbar input", "Show the evidence for the cooling system issue.");
    await page.press(".isp-askbar input", "Enter");
    await expect(page.locator(`${ANSWER} .tw-comp[open]`)).toContainText("Radiators and cooling fans", { timeout: 30_000 });
    await page.fill(".isp-askbar input", "What is the rated capacity?");
    await page.press(".isp-askbar input", "Enter");
    await expect(page.locator(`${ANSWER} .tw-say`)).toHaveText("TX-M1's rated power: 12,000,000 VA.", { timeout: 30_000 });
    expect(analyses.length).toBe(asked);
    await page.fill(".isp-askbar input", "Summarize TX-M2's inspection history.");
    await page.press(".isp-askbar input", "Enter");
    await expect(page.locator(`${ANSWER} .tw-say`)).toHaveText("No inspection reports were found among TX-M2's linked documents.", { timeout: 30_000 });
    await page.fill(".isp-askbar input", "Which downstream assets would be affected during replacement of TX-M1?");
    await page.press(".isp-askbar input", "Enter");
    await expect(page.locator(ANSWER)).toContainText("If TX-M1 shuts down", { timeout: 30_000 });
    expect(streamed.slice(downloaded).filter(x => /TX-M1_/.test(x))).toEqual([]);
    expect(streamed.slice(downloaded)).toEqual(["urn:v:TX-M2_Transformer.pdf?version=1"]);
  });

  test("15 generated report: transformers requiring inspection, a PDF, an Excel register and an email draft from one snapshot", async ({ page }) => {
    test.setTimeout(300_000);
    const { createIfcSpatialApi } = await import("../server/ifcSpatial/api.mjs");
    const { specSheet, inspectionReport } = await import("../tests/pdfFixtures.mjs");
    const { extractPdfText } = await import("../server/ifcSpatial/docExtract.mjs");
    const ExcelJS = (await import("exceljs")).default;
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Readable } = await import("node:stream");
    // Controlled ACC records: TX-M1 has an inspection action in its latest report, TX-M2 is past its documented due date,
    // TX-1 has a clean record, TX-3 is in poor condition only (a review candidate); the other transformers have none.
    const pdfs: Record<string, Uint8Array> = {
      "TX-M1_Transformer.pdf": specSheet({ assetId: "TX-M1", fields: [["Rating", "34.5/13.8 kV, 12 MVA"]] }),
      "TX-M1_Transformer_Inspection-2026-001_2026-10-28.pdf": inspectionReport({ assetId: "TX-M1", date: "2026-10-28", number: "M1-26", condition: "POOR (2/5)", findings: [["Radiators and cooling fans", "Defect", "Leaking."]],
        actions: [["Thermographic inspection of LV connections", "High", "2026-12-15"]] }),
      "TX-M2_Transformer_Inspection-2025-001_2025-06-01.pdf": inspectionReport({ assetId: "TX-M2", date: "2025-06-01", number: "M2-25", condition: "GOOD (4/5)", findings: [["Bushings (HV and LV)", "OK", "Clean."]], nextDue: "2026-06-01" }),
      "TX-1_Transformer_Inspection-2026-001_2026-09-01.pdf": inspectionReport({ assetId: "TX-1", date: "2026-09-01", number: "T1-26", condition: "GOOD (4/5)", findings: [["Bushings (HV and LV)", "OK", "Clean."]] }),
      "TX-3_Transformer_Inspection-2026-001_2026-08-01.pdf": inspectionReport({ assetId: "TX-3", date: "2026-08-01", number: "T3-26", condition: "POOR (2/5)", findings: [["Tank, welds and gaskets", "Attention", "Staining."]] }),
    };
    const tree: Record<string, { folders: { id: string; name: string }[]; files: string[] }> = {
      top: { folders: [{ id: "docs", name: "Asset Documentation" }], files: [] }, docs: { folders: [{ id: "f2", name: "02_Transformers" }], files: [] }, f2: { folders: [], files: Object.keys(pdfs) } };
    const client = {
      async getAll(path: string) {
        const id = decodeURIComponent(/folders\/([^/]+)\/contents/.exec(path)![1]);
        const node = tree[id] ?? { folders: [], files: [] };
        return { data: [...node.folders.map(f => ({ type: "folders", id: f.id, attributes: { displayName: f.name } })),
          ...node.files.map(f => ({ type: "items", id: `urn:item:${f}`, attributes: { displayName: f }, relationships: { tip: { data: { id: `urn:v:${f}?version=1` } } }, links: { webView: { href: `https://acc.autodesk.com/docs/files/projects/p?entityId=${f}` } } }))],
          included: node.files.map(f => ({ type: "versions", id: `urn:v:${f}?version=1`, attributes: { name: f, versionNumber: 1, fileType: "pdf", storageSize: pdfs[f].length, lastModifiedTime: "2026-11-25T08:00:00Z" } })) };
      },
      async get() { return { data: {} }; },
    };
    const model = readFileSync(new URL("../tests/fixtures/ifc/seagirt-compare-v2.ifc", import.meta.url));
    const v = "urn:model?version=3";
    const files = { hub: { id: "h" }, project: { id: "b.p", name: "Seagirt Electrical Digital Twin POC" }, topFolders: [{ id: "top", name: "Project Files" }],
      files: [{ fileName: "seagirt_power_network.ifc", itemId: "urn:i", tipVersionId: v, versions: [{ id: v, versionNumber: 3 }] }] };
    const posts: string[] = [];
    const cancels: string[] = [];
    // Holds report creation until the test releases it (so a Stop lands while the answer is still running).
    let gate: Promise<void> | null = null;
    let release = () => {};
    const api = createIfcSpatialApi({ aps: { dataClient: () => client, projectFiles: async () => files, sessionId: () => "browser-session" }, cacheDir: mkdtempSync(join(tmpdir(), "ifc-report-e2e-")),
      logger: { info() {}, warn() {}, error() {} }, download: async () => ({ bytes: model }), now: () => Date.parse("2026-11-26T09:00:00Z"),
      openStream: async (_c: unknown, _p: unknown, versionId: string) => {
        const name = versionId.replace(/^urn:v:/, "").replace(/\?.*$/, "");
        return { body: Readable.from([Buffer.from(pdfs[name])]), contentLength: pdfs[name].length, fileName: name };
      } });
    await page.route(/googleapis\.com/, route => route.abort());
    // Gmail: the real /api/gmail module with fake Google clients. The fake consent URL is the app's own callback,
    // so the popup, the state check, the cookie and the postMessage back to the conversation all really run.
    const { createGmailApi, SEND_SCOPE } = await import("../server/gmail/api.mjs");
    const gmailSent: string[] = [];
    const google = {
      oauth: () => ({ credentials: {}, async generateCodeVerifierAsync() { return { codeVerifier: "v".repeat(43), codeChallenge: "c" }; },
        generateAuthUrl: (o: any) => `http://localhost:5188/api/gmail/auth/callback?state=${o.state}&code=consent-ok`,
        async getToken() { return { tokens: { access_token: "at", refresh_token: "rt", expiry_date: Date.now() + 3600e3, scope: `${SEND_SCOPE} openid email`, id_token: "i" } }; },
        async verifyIdToken() { return { getPayload: () => ({ email: "inspections.demo@gmail.com" }) }; }, setCredentials() {}, on() {}, async getAccessToken() { return { token: "at" }; }, async revokeToken() {} }),
      gmail: () => ({ users: { messages: { async send({ requestBody }: any) { gmailSent.push(requestBody.raw); return { data: { id: "18c0f2a9d1e3b7aa", threadId: "t1" } }; } } } }),
    };
    const gmailApi = createGmailApi({ env: { GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REDIRECT_URI: "http://localhost:5188/api/gmail/auth/callback" }, google, reports: api.reportAccess,
      dataDir: mkdtempSync(join(tmpdir(), "gmail-e2e-")), logger: { info() {}, warn() {}, error() {} } });
    const forward = (handler: any) => async (route: any) => {
      const u = new URL(route.request().url());
      const body = route.request().postDataBuffer();
      const req: any = Readable.from(body ? [body] : []);
      Object.assign(req, { method: route.request().method(), url: u.pathname + u.search, headers: { cookie: (await route.request().allHeaders()).cookie ?? "" } });
      let status = 200, headers: any = {}; const parts: Buffer[] = [];
      await handler.handle(req, { writeHead(s: number, h: any) { status = s; headers = h ?? {}; }, write(c: any) { parts.push(Buffer.from(c)); }, end(b: any) { if (b) parts.push(Buffer.from(b)); } } as any);
      // Playwright does not keep a Set-Cookie on a fulfilled 302: the redirect is replayed as a page that navigates.
      if (status === 302) return route.fulfill({ status: 200, headers: { ...headers, "content-type": "text/html", location: undefined }, body: `<script>location.replace(${JSON.stringify(headers.location)})</script>` });
      await route.fulfill({ status, headers, body: Buffer.concat(parts) });
    };
    await page.context().route("**/api/gmail/**", forward(gmailApi));
    await page.route("**/api/ifc-spatial/**", async route => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith("/reports") && route.request().method() === "POST") { posts.push(u.pathname); if (gate) await gate; }
      if (u.pathname.endsWith("/cancel")) cancels.push(u.pathname);
      const body = route.request().postDataBuffer();
      const req: any = Readable.from(body ? [body] : []);
      Object.assign(req, { method: route.request().method(), url: u.pathname + u.search, headers: {} });
      let status = 200, headers: any = {}; const parts: Buffer[] = [];
      await api.handle(req, { writeHead(s: number, h: any) { status = s; headers = h; }, write(c: any) { parts.push(Buffer.from(c)); }, end(b: any) { if (b) parts.push(Buffer.from(b)); } } as any);
      await route.fulfill({ status, headers, body: Buffer.concat(parts) });
    });
    const bytesOf = async (url: string) => Buffer.from(await page.evaluate(async u => { const r = await fetch(u); const b = new Uint8Array(await r.arrayBuffer()); let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); }, url), "base64");
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTwin(page, "&screen=ifc-spatial");
    await page.waitForFunction(() => (window as any).__ifcSpatial?.state().phase === "ready", null, { timeout: 180_000 });
    await page.waitForFunction(() => (window as any).__ifcSpatial.documents.state().summary, null, { timeout: 60_000 });
    await openAsk(page);

    await page.fill(".isp-askbar input", "Prepare a report of all transformers requiring inspection and draft an email to the electrical maintenance team.");
    await page.press(".isp-askbar input", "Enter");
    // Real progress first (the server's steps), then the answer.
    await expect(page.locator(`${ANSWER} .tw-pg li`).first()).toContainText("Identifying matching assets", { timeout: 30_000 });
    const card = page.locator(`${ANSWER} .tw-report[data-report]`);
    await expect(card).toBeVisible({ timeout: 120_000 });
    await expect(page.locator(`${ANSWER} .tw-say`)).toHaveText("I found 2 transformers requiring inspection.");
    await expect(page.locator(`${ANSWER} .tw-say2`)).toContainText("I've prepared an inspection report, an Excel register and a draft email for your review.");
    await expect(page.locator(`${ANSWER} .tw-say2`)).toContainText("1 more is recommended for review.");
    // The fixture asset sheet calls itself "Illustrative mock network": the notice says so.
    await expect(card.locator(".tw-rdemo")).toHaveText("Illustrative demo data — not actual inspection records.");
    await expect(card.locator(".tw-rmatch-h b")).toHaveText("2 transformers");
    await expect(card.locator(".tw-art")).toHaveCount(2);
    await expect(card.locator(".tw-art").nth(0)).toContainText("Transformer Inspection Report");
    await expect(card.locator(".tw-art").nth(1)).toContainText("Transformer Inspection Register");
    // The draft: no address invented for the group; the files attached; Send waits for Gmail and a recipient.
    await expect(card.locator('[data-chips="to"] .tw-chip2')).toHaveCount(0);
    await expect(card.locator('[data-chip-input="to"]')).toHaveAttribute("placeholder", "Electrical Maintenance Team — enter email address");
    await expect(card.locator('[data-mail="subject"]')).toHaveValue("Seagirt — Transformers requiring inspection");
    await expect(card.locator(".tw-atts > header")).toContainText("Attachments (2)");
    await expect(card.locator(".tw-att")).toHaveCount(2);
    await expect(card.locator(".tw-cmp-gm")).toContainText("Gmail not connected");
    await expect(card.locator("[data-send-btn]")).toBeDisabled();
    await expect(card.locator("[data-mail-why]")).toHaveText("Not sent · Connect Gmail to send.");
    await expect(card.locator(".tw-cmp-demo")).toHaveText("Demo data — send only to approved test recipients.");
    // The matching assets are highlighted in Cesium, and only they.
    const s = await spatial(page);
    expect([...s.network.askIds].sort()).toEqual(["TX-3", "TX-M1", "TX-M2"]);
    await page.screenshot({ path: test.info().outputPath("report-1440.png") });
    const tall = page.viewportSize()!;
    await page.setViewportSize({ width: tall.width, height: 1500 });
    await page.locator(`${ANSWER}`).screenshot({ path: test.info().outputPath("report-answer.png") });
    await page.setViewportSize(tall);

    // The files are real and agree: the same two assets in the PDF, the register and the draft.
    const pdfUrl = await card.locator(".tw-art").nth(0).locator("a.tw-art-dl").getAttribute("href");
    const xlsxUrl = await card.locator(".tw-art").nth(1).locator("a.tw-art-dl").getAttribute("href");
    const pdfBytes = await bytesOf(pdfUrl!);
    expect(pdfBytes.subarray(0, 5).toString()).toBe("%PDF-");
    const text = (await extractPdfText(pdfBytes)).pages.flatMap((p: any) => p.lines.map((l: any) => l.cells.map((c: any) => c.text).join(" "))).join("\n");
    for (const id of ["TX-M1", "TX-M2", "TX-3"]) expect(text).toContain(id);
    expect(text).toContain("Thermographic inspection of LV connections");
    expect(text).toMatch(/overdue: the latest report set the next inspection for 2026-06-01/i);
    expect(text).toContain("Source references");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await bytesOf(xlsxUrl!));
    const reg = wb.getWorksheet("Inspection Register")!;
    const rows: string[][] = [];
    reg.eachRow((r: any, n: number) => { if (n > 1) rows.push([r.getCell(1).value, r.getCell(10).value]); });
    expect(rows.filter(r => r[1] === "Inspection required").map(r => r[0]).sort()).toEqual(["TX-M1", "TX-M2"]);
    expect(rows.find(r => r[0] === "TX-3")![1]).toBe("Review recommended");
    const body = await card.locator("[data-mail-editor]").innerText();
    expect(body).toMatch(/2 transformers require inspection across Seagirt: (TX-M1, TX-M2|TX-M2, TX-M1)\./);
    expect(body.split(/\s+/).length).toBeLessThanOrEqual(150);

    // Preview: the PDF in the existing preview dialog; the register's rows.
    await card.locator('[data-report-act="preview"]').nth(0).click();
    await expect(page.locator(".isp-docview-frame")).toHaveAttribute("src", /\/reports\/RPT-\d{8}-[a-z0-9]{8}\/artifacts\//);
    await page.click("[data-doc-close]");
    await card.locator('[data-report-act="preview"]').nth(1).click();
    await expect(page.locator(".isp-xlsx-prev tbody tr")).toHaveCount(3);
    await page.click("[data-doc-close]");
    // Sources & criteria: the rules, coverage and missing records.
    await card.locator('[data-report-act="criteria"]').click();
    await expect(card.locator(".tw-rcrit-b")).toContainText("9 transformers evaluated");
    await expect(card.locator(".tw-rcrit-b")).toContainText("Missing records");
    const artifactIds = await card.locator('[data-report-act="preview"]').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.reportArtifact));

    // A row opens the asset (its inspector) and the report stays.
    await card.locator('[data-report-act="assets"]').click();
    await card.locator('.tw-crow[data-asset="TX-M1"]').click();
    await expect(page.locator(".isp-insp, .isp-ops-detail").first()).toBeVisible();
    await expect(card).toBeVisible();

    // "Make the email shorter": only the draft changes; the same files, no new report job.
    const postsBefore = posts.length;
    await page.fill(".isp-askbar input", "Make the email shorter.");
    await page.press(".isp-askbar input", "Enter");
    await expect(page.locator(`${ANSWER} .tw-say`)).toHaveText("I've shortened the email draft.", { timeout: 30_000 });
    const after = page.locator(`${ANSWER} .tw-report`);
    expect(await after.locator('[data-report-act="preview"]').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.reportArtifact))).toEqual(artifactIds);
    expect(posts.length).toBe(postsBefore);

    // Gmail: connect in a popup (the conversation stays), then an edited draft, an explicit confirmation, a real send.
    const mail = page.locator(`${ANSWER} .tw-mail`);
    const askW = () => page.locator(".isp-ask").boundingBox().then(b => b!.width);
    const toggleWidth = async (to: number) => { await page.locator(".isp-askp-width").click(); await expect.poll(askW, { timeout: 60_000 }).toBe(to); };
    await mail.scrollIntoViewIfNeeded();
    await mail.screenshot({ path: test.info().outputPath("composer-1-default-disconnected.png") });
    await toggleWidth(616);
    await mail.screenshot({ path: test.info().outputPath("composer-3-expanded-disconnected.png") });
    await toggleWidth(396);
    const turnsBefore = await page.locator(".isp-turn").count();
    const [popup] = await Promise.all([page.waitForEvent("popup"), mail.locator('[data-report-act="gmailConnect"]').click()]);
    await popup.waitForEvent("close", { timeout: 15_000 }).catch(() => {});
    await expect(mail.locator(".tw-cmp-gm")).toContainText("inspections.demo@gmail.com", { timeout: 15_000 });
    await expect(mail.locator(".tw-cmp-gm")).toContainText("Connected");
    await expect(page.locator(".isp-turn")).toHaveCount(turnsBefore);
    expect([...(await spatial(page)).network.askIds].sort()).toEqual(["TX-3", "TX-M1", "TX-M2"]);
    await expect(mail.locator("[data-mail-why]")).toHaveText("Not sent · Enter the Electrical Maintenance Team's email address.");
    // Recipient chips: a team name is not an address (shown as invalid); Backspace removes; a real address is a chip.
    await mail.locator('[data-chip-input="to"]').fill("maintenance-team");
    await mail.locator('[data-chip-input="to"]').press("Enter");
    await expect(mail.locator('[data-chips="to"] .tw-chip2.is-bad')).toHaveText("maintenance-team");
    await expect(mail.locator("[data-send-btn]")).toBeDisabled();
    await expect(mail.locator("[data-mail-why]")).toContainText("Not an email address");
    await mail.locator('[data-chip-input="to"]').press("Backspace");
    await expect(mail.locator('[data-chips="to"] .tw-chip2')).toHaveCount(0);
    await mail.locator('[data-chip-input="to"]').fill("maint.lead@test.example");
    await mail.locator('[data-chip-input="to"]').press("Enter");
    await expect(mail.locator('[data-chips="to"] .tw-chip2:not(.is-bad)')).toHaveText("maint.lead@test.example");
    await mail.locator('[data-mail="subject"]').fill("Seagirt — transformer inspections to schedule");
    await mail.locator('[data-mail="subject"]').press("Tab");
    // Formatting works: the greeting made bold is kept as <b> in the saved body.
    const editor = mail.locator("[data-mail-editor]");
    await editor.click();
    await editor.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el.querySelector("p")!); const sel = getSelection()!; sel.removeAllRanges(); sel.addRange(r); });
    await mail.locator('[data-fmt="bold"]').click();
    await expect(editor.locator("b, strong").first()).toHaveText("Hi Team,");
    await expect(mail.locator("[data-send-btn]")).toBeEnabled();
    await expect(mail.locator(".tw-att")).toHaveCount(2);
    // Switching widths while editing keeps everything (no remount, no request).
    const draftHtml = await editor.innerHTML();
    await toggleWidth(616);
    await mail.screenshot({ path: test.info().outputPath("composer-4-expanded-connected.png") });
    await toggleWidth(396);
    await toggleWidth(616);
    await toggleWidth(396);
    expect(await editor.innerHTML()).toBe(draftHtml);
    await expect(mail.locator('[data-chips="to"] .tw-chip2')).toHaveText(["maint.lead@test.example"]);
    await expect(mail.locator('[data-mail="subject"]')).toHaveValue("Seagirt — transformer inspections to schedule");
    await mail.screenshot({ path: test.info().outputPath("composer-2-default-connected.png") });
    await mail.locator("[data-send-btn]").click();
    const dialog = mail.locator(".tw-mconf");
    // It opens where the user is: on screen, next to the Send button.
    await expect(dialog).toBeInViewport();
    await expect(dialog).toContainText("inspections.demo@gmail.com");
    await expect(dialog).toContainText("maint.lead@test.example");
    await expect(dialog).toContainText("Seagirt — transformer inspections to schedule");
    await expect(dialog).toContainText("2 · Transformer_Inspection_Report_2026-11-26.pdf");
    await expect(dialog).toContainText("illustrative demo data");
    await expect(dialog.locator('[data-report-act="sendConfirm"]')).toBeDisabled();
    expect(gmailSent).toHaveLength(0);
    await dialog.locator("[data-mail-ack]").check();
    await page.screenshot({ path: test.info().outputPath("gmail-3-confirm.png") });
    await dialog.locator('[data-report-act="sendConfirm"]').click();
    await expect(mail.locator(".tw-msent-h")).toHaveText("✓ Email sent successfully", { timeout: 15_000 });
    // The Gmail message id is kept in the audit record, not shown.
    await expect(mail.locator(".tw-msent")).not.toContainText("18c0f2a9d1e3b7aa");
    await expect(mail.locator(".tw-msent")).not.toContainText("Gmail ID");
    await expect(mail.locator(".tw-msent")).toContainText("maint.lead@test.example");
    await expect(mail.locator(".tw-cmp-st")).toHaveText("Sent");
    await page.screenshot({ path: test.info().outputPath("gmail-4-sent.png") });
    // One message, with the report's own files as attachments.
    expect(gmailSent).toHaveLength(1);
    const mime = Buffer.from(gmailSent[0], "base64url").toString("latin1");
    expect(mime).toMatch(/^From: inspections\.demo@gmail\.com$/m);
    expect(mime).toMatch(/^To: maint\.lead@test\.example$/m);
    const pdfAgain = await bytesOf((await page.locator(`${ANSWER} .tw-art`).nth(0).locator("a.tw-art-dl").getAttribute("href"))!);
    expect(mime.replace(/\r\n/g, "")).toContain(pdfAgain.toString("base64").slice(0, 200));
    expect(mime).toMatch(/filename=.?Transformer_Inspection_Register_2026-11-26\.xlsx/);
    // The formatted body and its plain-text alternative.
    expect(mime).toMatch(/Content-Type: text\/html/);
    expect(mime).toMatch(/Content-Type: text\/plain/);
    // Send history: in the ⋯ menu at the default width.
    await mail.locator('[data-report-act="mailMenu"]').click();
    await mail.locator('.tw-cmp-pop [data-report-act="sendHistory"]').click();
    await expect(mail.locator(".tw-mhist")).toContainText("Sent to maint.lead@test.example");

    // The expanded panel: the report and the email use the room (the files side by side); nothing is regenerated.
    const reportPosts = posts.length;
    await page.locator(".isp-askp-width").click();
    await expect(page.locator(".isp-askp-width")).toHaveAttribute("aria-pressed", "true");
    // (Frames are sparse here with the inspector's focus effect running: the transition can take a while to finish.)
    await expect.poll(async () => (await page.locator(".isp-ask").boundingBox())!.width, { timeout: 60_000 }).toBe(616);
    const arts = page.locator(`${ANSWER} .tw-art`);
    const [b0, b1] = [(await arts.nth(0).boundingBox())!, (await arts.nth(1).boundingBox())!];
    expect(Math.abs(b0.y - b1.y)).toBeLessThan(2);
    expect(b1.x).toBeGreaterThan(b0.x + b0.width - 1);
    await expect(mail.locator(".tw-msent-h")).toHaveText("✓ Email sent successfully");
    await page.locator(`${ANSWER} .tw-report`).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("width-3-expanded-report.png") });
    expect(posts.length).toBe(reportPosts);
    await page.locator(".isp-askp-width").click();
    await expect.poll(async () => (await page.locator(".isp-ask").boundingBox())!.width, { timeout: 60_000 }).toBe(396);

    // Stop: while an answer runs the send button is a Stop button; stopping says so, drops the late result and
    // cancels the report job on the server. Esc does the same. Then the button sends again.
    gate = new Promise<void>(r => { release = r; });
    const send = page.locator(".isp-askp .isp-send");
    await page.fill(".isp-askbar input", "Prepare a report of all transformers requiring inspection.");
    await page.press(".isp-askbar input", "Enter");
    await expect(send).toHaveAttribute("aria-label", "Stop the answer");
    await expect(send).toHaveClass(/is-busy/);
    await page.screenshot({ path: test.info().outputPath("stop-button.png") });
    await send.click();
    // Stopped before the job exists ("Stopped."), or a running job cancelled on the server.
    await expect(page.locator(`${ANSWER} .tw-say`)).toHaveText(/^(Stopped\.|Report generation was cancelled\.)$/);
    await expect(send).toHaveAttribute("aria-label", "Send question");
    release();
    await expect.poll(() => cancels.length, { timeout: 10_000 }).toBe(1);
    await page.waitForTimeout(800);
    await expect(page.locator(`${ANSWER} .tw-say`)).toHaveText(/^(Stopped\.|Report generation was cancelled\.)$/);
    await expect(page.locator(`${ANSWER} .tw-art`)).toHaveCount(0);
    gate = new Promise<void>(r => { release = r; });
    await page.fill(".isp-askbar input", "Prepare a report of all cranes requiring inspection.");
    await page.press(".isp-askbar input", "Enter");
    await expect(send).toHaveClass(/is-busy/);
    await page.keyboard.press("Escape");
    await expect(page.locator(`${ANSWER} .tw-say`)).toHaveText("Stopped.");
    await expect(send).not.toHaveClass(/is-busy/);
    release();
    gate = null;
    await expect.poll(() => cancels.length, { timeout: 10_000 }).toBe(2);

    // A plain question is an evaluation, not a report; other categories go through the same workflow.
    await page.fill(".isp-askbar input", "Which transformers require inspection?");
    await page.press(".isp-askbar input", "Enter");
    await expect(page.locator(`${ANSWER} .tw-say`)).toHaveText("I found 2 transformers requiring inspection.", { timeout: 60_000 });
    await expect(page.locator(`${ANSWER} .tw-art`)).toHaveCount(0);
    await expect(page.locator(`${ANSWER} .tw-mail`)).toHaveCount(0);
    await expect(page.locator(`${ANSWER} .tw-crow`)).toHaveCount(3);
    for (const [q, say] of [["Prepare a report of all circuit breakers requiring inspection.", "No circuit breakers meet the available inspection-required criteria."],
      ["Prepare a report of all cranes requiring inspection.", "No cranes meet the available inspection-required criteria."]]) {
      await page.fill(".isp-askbar input", q);
      await page.press(".isp-askbar input", "Enter");
      await expect(page.locator(`${ANSWER} .tw-say`)).toHaveText(say, { timeout: 60_000 });
      await expect(page.locator(`${ANSWER} .tw-say2`)).toContainText("No files were generated");
    }
    await page.fill(".isp-askbar input", "Create an Excel register of all lighting assets.");
    await page.press(".isp-askbar input", "Enter");
    await expect(page.locator(`${ANSWER} .tw-art`)).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator(`${ANSWER} .tw-art`)).toContainText("XLSX");
    await expect(page.locator(`${ANSWER} .tw-say`)).toContainText(/^I found \d+ (high-mast lights|lighting circuits)\.$/);
    await page.screenshot({ path: test.info().outputPath("report-lighting.png") });
    await page.context().unroute("**/api/gmail/**");
  });

  test("16 Ask the Twin width: expand and restore, kept apart from collapsing, remembered; nothing else changes", async ({ page }) => {
    test.setTimeout(300_000);
    await mockSpatial(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTwin(page, "&screen=ifc-spatial");
    await ready(page);
    await page.evaluate(() => localStorage.removeItem("ifcSpatial.askWidth"));
    await openAsk(page);
    const ask = page.locator(".isp-ask");
    const btn = page.locator(".isp-askp-width");
    const width = async () => (await ask.boundingBox())!.width;
    // First visit: the existing default width, the expand button before the collapse button.
    const original = await width();
    expect(original).toBe(396);
    await expect(btn).toHaveAttribute("aria-pressed", "false");
    await expect(btn).toHaveAttribute("aria-label", "Expand panel width");
    await expect(btn).toHaveAttribute("title", "Expand panel width");
    expect(await page.locator(".isp-askp-head > button, .isp-askp-head .isp-askp-areabtn").evaluateAll(b => b.map(x => x.className))).toEqual(["isp-askp-areabtn", "isp-askp-width", "isp-askp-collapse"]);
    // A conversation with results on the map.
    await page.fill(".isp-askbar input", "Show me all transformers installed across Seagirt.");
    await page.press(".isp-askbar input", "Enter");
    await expect(page.locator(".isp-turn")).toHaveCount(1);
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().network.askIds.length > 0);
    await page.waitForTimeout(1500);
    const before = await spatial(page);
    const answer = await page.locator(".isp-turn .isp-msg-ans").innerHTML();
    const gid = NETWORK.elements.find((e: any) => e.networkId === "TX-M1").globalId;
    // The camera has finished its flight to the results before anything is compared.
    const pos = () => page.evaluate(g => JSON.stringify((window as any).__ifcSpatial.screenPositionOf(g)), gid);
    let at = await pos();
    // (At SwiftShader's frame rate two close readings can match mid-flight: three equal readings 1.5 s apart.)
    for (let i = 0, same = 0; i < 40 && same < 2; i += 1) { await page.waitForTimeout(1500); const now = await pos(); same = now === at ? same + 1 : 0; at = now; }
    await page.screenshot({ path: test.info().outputPath("width-1-default.png") });
    // (The flight's last frames can be seconds apart here: wait it out, then take the reference.)
    await page.waitForTimeout(6000);
    at = await pos();
    // Expand: wider, smoothly; the icon and label change; no request; the conversation, highlights and camera stay.
    const requests: string[] = [];
    // (The periodic ACC version check, /models?refresh=1 every 60 s, is the app's own timer, not the toggle.)
    page.on("request", r => { if (/\/api\//.test(r.url()) && !/\/models\?refresh=1$/.test(r.url())) requests.push(r.url()); });
    // A 250 ms transition on the width (checked as a running CSS transition: frames are too sparse under SwiftShader to sample).
    await btn.click();
    const anim = await page.evaluate(() => document.querySelector(".isp-ask")!.getAnimations().map((a: any) => ({ prop: a.transitionProperty, duration: a.effect.getTiming().duration })));
    expect(anim).toContainEqual({ prop: "width", duration: 250 });
    await expect(btn).toHaveAttribute("aria-pressed", "true");
    await expect(btn).toHaveAttribute("aria-label", "Restore original width");
    await expect(btn).toHaveAttribute("title", "Restore original width");
    await expect.poll(width).toBe(616);
    const panel = (await ask.boundingBox())!;
    expect(panel.x).toBe(76);
    expect((await page.locator(".isp-askp").boundingBox())!.height).toBeCloseTo((await page.locator(".isp-askp").boundingBox())!.height, 0);
    await page.screenshot({ path: test.info().outputPath("width-2-expanded.png") });
    expect(requests).toEqual([]);
    const after = await spatial(page);
    expect(after.network.askIds).toEqual(before.network.askIds);
    expect(after.network.askWidth).toBe("expanded");
    expect(await page.locator(".isp-turn .isp-msg-ans").innerHTML()).toBe(answer);
    expect(await pos()).toBe(at);
    // Collapse and reopen: the width mode is kept; collapsing does not change the preference.
    await page.click('[data-act="askCollapse"]');
    await expect(ask).toHaveClass(/is-collapsed/);
    expect(await page.evaluate(() => localStorage.getItem("ifcSpatial.askWidth"))).toBe("expanded");
    await page.click(".isp-askp-launcher");
    await expect(ask).not.toHaveClass(/is-collapsed/);
    await expect.poll(width).toBe(616);
    await expect(page.locator(".isp-turn")).toHaveCount(1);
    // Restored after a reload.
    await page.reload();
    await ready(page);
    await openAsk(page);
    await expect(btn).toHaveAttribute("aria-pressed", "true");
    await expect.poll(width).toBe(616);
    // Restore, by keyboard: exactly the original width.
    await btn.focus();
    await page.keyboard.press("Enter");
    await expect(btn).toHaveAttribute("aria-pressed", "false");
    await expect.poll(width).toBe(original);
    expect(await page.evaluate(() => localStorage.getItem("ifcSpatial.askWidth"))).toBe("default");
    await page.screenshot({ path: test.info().outputPath("width-4-restored.png") });
    // A wide screen: about 800px.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await btn.click();
    await expect.poll(width).toBe(800);
    await btn.click();
    await expect.poll(width).toBe(420);
  });

  test("17 Power Status and Active Alerts: one compact panel, alerts grouped, no scrollbar, paged to the window", async ({ page }) => {
    test.setTimeout(300_000);
    // Seven alerts like the reference model: three reported without power, four degraded.
    const status: Record<string, Record<string, string>> = {};
    for (const id of ["STS-01", "STS-02", "HM-1"]) status[id] = { PowerStatus: "No power", StatusDate: "2026-11-24" };
    for (const id of ["TX-1", "TX-2", "TX-3", "TX-4"]) status[id] = { PowerStatus: "Powered", StatusFlag: "Overheating", StatusDate: "2026-11-23" };
    await mockSpatial(page, { status });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTwin(page, "&screen=ifc-spatial");
    await ready(page);
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().ops?.summary);
    await page.click(".isp-power");
    const ops = page.locator(".isp-ops");
    await expect(ops).toBeVisible();
    const summary = (await spatial(page)).ops.summary;
    // Counts from the model's statuses (each asset once; degraded counted as powered in the share, not twice).
    // (The 3D fixture's own test transformer is connected to nothing, so it is a fourth asset without power.)
    expect(summary.counts.DEGRADED).toBe(4);
    expect(summary.counts.NO_POWER).toBeGreaterThanOrEqual(3);
    const total = summary.counts.NO_POWER + summary.counts.DEGRADED + summary.counts.OFFLINE;
    for (const key of ["POWERED", "NO_POWER", "DEGRADED", "OFFLINE"]) await expect(page.locator(`.isp-ops-row[data-ops-status="${key}"] b`)).toHaveText(String(summary.counts[key]));
    await expect(page.locator(".isp-ops-donut text").first()).toHaveText(`${Math.round(summary.poweredPct)}%`);
    expect((await page.locator(".isp-ops-donut").boundingBox())!.width).toBe(112);
    // Grouped, most severe first; the status is in the group heading, not repeated on each row.
    await expect(page.locator(".isp-ops-ghead span")).toHaveText(["No Power", "Degraded"]);
    await expect(page.locator(".isp-ops-ghead b")).toHaveText([String(summary.counts.NO_POWER), "4"]);
    await expect(page.locator(".isp-ops-group.is-no_power .isp-ops-alert")).toHaveCount(summary.counts.NO_POWER);
    await expect(page.locator(".isp-ops-group.is-degraded .isp-ops-alert")).toHaveCount(4);
    // On the map: alert assets pulse and are named by id only while the panel is open.
    const named = (await spatial(page)).network.alertNames as string[];
    expect(named).toHaveLength(total);
    for (const id of ["STS-01", "STS-02", "HM-1", "TX-1", "TX-2", "TX-3", "TX-4"]) expect(named).toContain(id);
    await expect(page.locator(".isp-ops-alert").first()).not.toContainText("No Power");
    await expect(page.locator(".isp-ops-alert").first()).not.toContainText("Status:");
    const rowH = (await page.locator(".isp-ops-alert").first().boundingBox())!.height;
    expect(rowH).toBeGreaterThanOrEqual(44);
    expect(rowH).toBeLessThanOrEqual(52);
    // All seven on screen, no pager, no scrollbar: the panel ends above the bottom of the window.
    const noScroll = () => ops.evaluate(el => el.scrollHeight <= el.clientHeight + 1);
    const inView = async () => { const b = (await ops.boundingBox())!; return b.y >= 56 && b.y + b.height <= page.viewportSize()!.height; };
    await expect(page.locator(".isp-ops-pager")).toHaveCount(0);
    expect(await noScroll()).toBe(true);
    expect(await inView()).toBe(true);
    const w = (await ops.boundingBox())!.width;
    expect(w).toBeGreaterThanOrEqual(336);
    expect(w).toBeLessThanOrEqual(400);
    await page.screenshot({ path: test.info().outputPath("ops-1440x900.png") });
    await ops.screenshot({ path: test.info().outputPath("ops-panel-1440.png") });
    // A group collapses on its own; a status row filters the alerts (and the map).
    await page.click('.isp-ops-ghead[data-ops-group="DEGRADED"]');
    await expect(page.locator(".isp-ops-group.is-degraded .isp-ops-alert")).toHaveCount(0);
    await expect(page.locator('.isp-ops-ghead[data-ops-group="DEGRADED"]')).toHaveAttribute("aria-expanded", "false");
    await page.click('.isp-ops-ghead[data-ops-group="DEGRADED"]');
    await page.click('.isp-ops-row[data-ops-status="DEGRADED"]');
    await expect(page.locator(".isp-ops-ghead span")).toHaveText(["Degraded"]);
    await expect(page.locator(".isp-ops-alerts h3 small")).toHaveText(`4 of ${total}`);
    await page.click('.isp-ops-row[data-ops-status="DEGRADED"]');
    await expect(page.locator(".isp-ops-alert")).toHaveCount(total);
    // A row selects its asset through the existing workflow (selection, inspector).
    await page.click('[data-ops-alert="TX-2"]');
    await expect.poll(async () => (await spatial(page)).network.selectedId).toBe("TX-2");
    await expect(page.locator('[data-ops-alert="TX-2"]')).toHaveClass(/is-selected/);
    // Other desktop sizes: on screen, no scrollbar; a short window pages the alerts and every alert stays reachable.
    for (const [vw, vh] of [[1920, 1080], [1366, 768], [1288, 624], [1280, 520]]) {
      await page.setViewportSize({ width: vw, height: vh });
      // The resize event comes with a frame (sparse under SwiftShader): let two frames pass first.
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      await expect.poll(noScroll, { message: `${vw}x${vh} scroll` }).toBe(true);
      expect(await inView(), `${vw}x${vh} in view`).toBe(true);
      const seen = new Set<string>();
      for (let i = 0; i < 8; i += 1) {
        for (const id of await page.locator(".isp-ops-alert").evaluateAll(els => els.map(e => (e as HTMLElement).dataset.opsAlert!))) seen.add(id);
        const next = page.locator('.isp-ops-pager [data-ops-page="1"]');
        if (!(await next.count()) || await next.isDisabled()) break;
        await next.click();
        expect(await noScroll()).toBe(true);
      }
      expect(seen.size, `${vw}x${vh}: every alert reachable`).toBe(total);
      if (await page.locator(".isp-ops-pager").count()) await expect(page.locator(".isp-ops-pager span")).toHaveText(new RegExp(`^Showing \\d+–\\d+ of ${total} alerts$`));
      await page.screenshot({ path: test.info().outputPath(`ops-${vw}x${vh}.png`) });
    }
    // Collapsed: only no-power assets pulse, and nothing is named.
    await page.click(".isp-power");
    expect((await spatial(page)).network.alertNames).toEqual([]);
    // Ask the Twin's welcome fits the panel at 100% zoom on a laptop (no scrollbar).
    await page.setViewportSize({ width: 1288, height: 624 });
    await openAsk(page);
    await page.waitForTimeout(300);
    expect(await page.locator(".isp-askp-body").evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("ask-1288x624.png") });
  });

  test("18 a simulated outage started from Ask the Twin: selecting the offline asset opens the Outage Simulation panel", async ({ page }) => {
    test.setTimeout(300_000);
    await mockSpatial(page);
    await openTwin(page, "&screen=ifc-spatial");
    await ready(page);
    await openAsk(page);
    await page.fill(".isp-askbar input", "What happens if TX-M1 fails?");
    await page.press(".isp-askbar input", "Enter");
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().network.sim?.id === "TX-M1");
    // Answered in the conversation: no panel yet.
    await expect(page.locator(".isp-sim")).toHaveCount(0);
    await page.click('[data-act="askCollapse"]');
    // The offline asset, selected (as a click on its map symbol does): the simulation panel, not "Simulate outage".
    await page.evaluate(() => (window as any).__ifcSpatial.selectAsset("TX-M1"));
    await expect(page.locator(".isp-sim")).toBeVisible();
    await expect(page.locator(".isp-sim")).toContainText("TX-M1");
    await expect(page.locator(".isp-sim")).toContainText("Reset Simulation");
    await expect(page.locator('[data-ops-investigate], [data-act="simulateAsset"]').filter({ hasText: /Simulate outage/ })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("sim-from-ask-panel.png") });
    // Reset ends the simulation and closes its panel.
    await page.locator(".isp-sim .isp-sim-reset").click();
    await expect(page.locator(".isp-sim")).toHaveCount(0);
  });

  test("19 Select Area: draw a rectangle and a polygon, area-scoped answers, supply beyond the area, outage by area, change and clear", async ({ page }) => {
    test.setTimeout(480_000);
    const SHOTS = process.env.AREA_SHOTS ?? null;
    const shot = async (name: string, locator?: any) => { if (SHOTS) await (locator ?? page).screenshot({ path: `${SHOTS}/${name}.png` }); };
    const calls = await mockSpatial(page);
    await page.setViewportSize({ width: 1600, height: 900 });
    await openTwin(page, "&screen=ifc-spatial");
    await ready(page);
    await openAsk(page);
    const area = () => page.evaluate(() => (window as any).__ifcSpatial.state().network.area);
    const answer = () => page.evaluate(() => (window as any).__ifcSpatial.state().network.answer);
    const askQ = async (q: string) => { await page.fill(".isp-askbar input", q); await page.press(".isp-askbar input", "Enter"); };
    const waitKind = (kind: string) => page.waitForFunction(k => { const a = (window as any).__ifcSpatial.state().network.answer; return a?.kind === k && a.status !== "loading"; }, kind, { timeout: 60_000 });
    const screenOf = (ids: string[]) => page.evaluate(list => list.map(id => (window as any).__ifcSpatial.assetScreenPosition(id)), ids);
    const scope = page.locator(`${ANSWER} .tw-scope`);

    // ---- the button and its menu ----
    const btn = page.locator(".isp-askp-areabtn");
    await expect(btn).toHaveAttribute("aria-label", "Select an area on the map");
    await expect(btn).toHaveAttribute("aria-pressed", "false");
    await btn.click();
    const menu = page.locator(".isp-askp-areamenu");
    await expect(menu.getByRole("menuitem")).toHaveText(["Draw rectangle", "Draw polygon", "Cancel"]);
    await shot("01-select-area-button", page.locator(".isp-askp"));
    // Cancel from the menu: nothing is drawn.
    await menu.getByRole("menuitem", { name: "Cancel" }).click();
    await expect(menu).toBeHidden();
    expect(await area()).toBeNull();

    // ---- a rectangle around the western cranes: press, drag, release ----
    await btn.click();
    await menu.getByRole("menuitem", { name: "Draw rectangle" }).click();
    await expect(page.locator(".isp-area-hint")).toContainText("drag on the map");
    expect(await page.evaluate(() => (window as any).__ifcSpatial.area.drawing())).toBe(true);
    const cranes = await screenOf(["STS-04", "STS-05", "STS-06"]);
    const xs = cranes.map((p: any) => p.x), ys = cranes.map((p: any) => p.y);
    const r0 = { x: Math.min(...xs) - 28, y: Math.min(...ys) - 28 }, r1 = { x: Math.max(...xs) + 28, y: Math.max(...ys) + 28 };
    expect(r0.x).toBeGreaterThan((await page.locator(".isp-askp").boundingBox())!.x + 430);
    // A click on a map asset while drawing is a corner, never a selection.
    await page.mouse.move(r0.x, r0.y);
    await page.mouse.down();
    await page.mouse.move((r0.x + r1.x) / 2, (r0.y + r1.y) / 2, { steps: 4 });
    await page.mouse.move(r1.x, r1.y, { steps: 4 });
    await shot("02-rectangle-drawing");
    await page.mouse.up();
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().network.area, null, { timeout: 30_000 });
    const a1 = await area();
    expect(a1.selectionType).toBe("RECTANGLE");
    for (const id of ["STS-04", "STS-05", "STS-06"]) expect(a1.inside).toContain(id);
    expect(a1.inside).not.toContain("TX-M1");
    expect(calls.area.length).toBe(1);
    expect(calls.area[0].geometry.type).toBe("Polygon");
    expect((await page.evaluate(() => (window as any).__ifcSpatial.state().network.selectedId))).toBeNull();
    expect(await page.evaluate(() => (window as any).__ifcSpatial.area.drawing())).toBe(false);
    await expect(btn).toHaveClass(/is-active/);

    // ---- the compact card and at most four suggestions ----
    const card = page.locator(".isp-askp-area .isp-area-card");
    await expect(card).toContainText("Selected area");
    await expect(card).toContainText(`${a1.inside.length} assets`);
    await expect(card).toContainText(a1.zone ?? "Custom selected area");
    const chips = page.locator(`${ANSWER} .tw-chip`);
    expect(await chips.count()).toBeGreaterThan(0);
    expect(await chips.count()).toBeLessThanOrEqual(4);
    await shot("04-area-summary", page.locator(".isp-askp"));

    // ---- inventory, scoped to the area ----
    await askQ("How many electrical assets are in this area?");
    await waitKind("Area inventory");
    await expect(scope).toContainText("Selected area");
    expect((await answer()).status).toBe("answered");
    const askIds = await page.evaluate(() => (window as any).__ifcSpatial.state().network.askIds);
    expect(askIds.every((id: string) => a1.inside.includes(id))).toBe(true);
    await shot("05-area-inventory", page.locator(".isp-askp"));
    await askQ("Show all cranes in this area");
    await waitKind("Area inventory");
    await expect(page.locator(`${ANSWER} .tw-say`)).toContainText(/\d+ cranes? in the selected area/);

    // ---- status: only the area's assets ----
    await askQ("Which assets are degraded or without power?");
    await waitKind("Area power status");
    await expect(scope).toContainText("Selected area");

    // ---- supply: traced through the whole network, equipment outside the area marked ----
    await askQ("Which transformers supply this area?");
    await waitKind("Area supply");
    const dep = page.locator(`${ANSWER} .tw-dep`);
    await expect(dep).toBeVisible();
    const outside = await dep.locator(".tw-dep-where.is-out").count();
    expect(outside).toBeGreaterThan(0);
    await expect(page.locator(`${ANSWER} .tw-dep-legend`)).toContainText("Outside the area");
    await shot("06-supply-dependencies", page);
    await askQ("Are any of these transformers located outside the selected area?");
    await waitKind("Area supply");
    await expect(page.locator(`${ANSWER} .tw-say`)).toContainText(/^Yes/);
    const outTx = await page.evaluate(() => (window as any).__ifcSpatial.state().network.askIds[0]);
    expect(a1.inside).not.toContain(outTx);

    // ---- outage: the whole network simulated, consumers split by the area ----
    await askQ(`What happens if ${outTx} shuts down?`);
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().network.answer?.kind === "Outage simulation", null, { timeout: 60_000 });
    const out = page.locator(`${ANSWER} .tw-out`);
    await expect(out).toContainText("Inside the selected area");
    await expect(out).toContainText("Outside the area");
    await shot("07-outage-by-area", page.locator(".isp-askp"));
    await page.locator(`${ANSWER} [data-act="simPanel"]`).click();
    await expect(page.locator(".isp-sim")).toBeVisible();
    await page.locator(".isp-sim .isp-sim-reset").click();
    await expect(page.locator(".isp-sim")).toHaveCount(0);

    // ---- a result row focuses its asset; the area stays ----
    await askQ("Show the cranes in this area");
    await waitKind("Area inventory");
    await page.locator(`${ANSWER} .tw-crow`).first().click();
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().network.selectedId);
    expect((await area()).selectionId).toBe(a1.selectionId);

    // ---- the whole terminal on request, without clearing the area ----
    await askQ("Show all degraded assets across Seagirt");
    await page.waitForFunction(() => { const a = (window as any).__ifcSpatial.state().network.answer; return a && a.kind === "Power status"; }, null, { timeout: 60_000 });
    await expect(scope).toContainText("Entire terminal");
    expect((await area()).selectionId).toBe(a1.selectionId);

    // ---- Escape cancels a drawing; the area is unchanged ----
    await btn.click();
    await menu.getByRole("menuitem", { name: "Draw polygon" }).click();
    await expect(page.locator(".isp-area-hint")).toContainText("Click to add corners");
    await page.keyboard.press("Escape");
    await expect(page.locator(".isp-area-hint")).toBeHidden();
    expect(await page.evaluate(() => (window as any).__ifcSpatial.area.drawing())).toBe(false);
    expect((await area()).selectionId).toBe(a1.selectionId);

    // ---- a polygon around the main substation: click the corners, Finish ----
    // Back to the opening view (the crane clicked above is zoomed in); the area is kept by Reset view.
    await page.click('[data-cam="home"]');
    await page.waitForFunction(() => { const s = (window as any).__ifcSpatial.assetScreenPosition("TX-M1"); return s && s.x > 560 && s.x < 1500 && s.y > 120 && s.y < 800; }, null, { timeout: 30_000 });
    await page.waitForTimeout(1500);
    expect((await area()).selectionId).toBe(a1.selectionId);
    await btn.click();
    await menu.getByRole("menuitem", { name: "Draw polygon" }).click();
    const [m1, m2] = await screenOf(["TX-M1", "TX-M2"]);
    const cx = (m1.x + m2.x) / 2, cy = (m1.y + m2.y) / 2, rr = 46;
    for (const [dx, dy] of [[-rr, -rr], [rr, -rr * 0.8], [rr * 1.1, rr], [-rr * 0.9, rr * 1.1]]) { await page.mouse.click(cx + dx, cy + dy); await page.waitForTimeout(400); }
    await expect(page.locator(".isp-area-hint")).toContainText("(4)");
    await shot("03-polygon-drawing");
    await page.locator('.isp-area-hint [data-area-hint="finish"]').click();
    await page.waitForFunction(id => { const a = (window as any).__ifcSpatial.state().network.area; return a && a.selectionId !== id; }, a1.selectionId, { timeout: 30_000 });
    const a2 = await area();
    expect(a2.selectionType).toBe("POLYGON");
    expect(a2.inside).toEqual(expect.arrayContaining(["TX-M1", "TX-M2"]));
    expect(a2.inside).not.toContain("STS-05");
    // The new area, not the previous one, answers.
    await askQ("How many assets are in this area?");
    await waitKind("Area inventory");
    const ids2 = await page.evaluate(() => (window as any).__ifcSpatial.state().network.askIds);
    expect(ids2.some((id: string) => a1.inside.includes(id) && !a2.inside.includes(id))).toBe(false);

    // ---- both widths keep the area and the conversation ----
    await page.locator(".isp-askp-width").click();
    await expect.poll(async () => (await page.locator(".isp-ask").boundingBox())!.width, { timeout: 20_000 }).toBeGreaterThan(500);
    await expect(card).toBeVisible();
    await shot("11-expanded-width", page);
    await page.locator(".isp-askp-width").click();
    await expect.poll(async () => (await page.locator(".isp-ask").boundingBox())!.width, { timeout: 20_000 }).toBeLessThan(450);
    await expect(card).toBeVisible();
    await shot("10-default-width", page);

    // ---- clear: full-terminal answers again, the conversation stays ----
    const turns = await page.locator(".isp-turn").count();
    await page.locator('.isp-area-card [data-act="areaClear"]').click();
    await expect(page.locator(".isp-askp-area")).toBeHidden();
    expect(await area()).toBeNull();
    await expect(btn).not.toHaveClass(/is-active/);
    expect(await page.locator(".isp-turn").count()).toBe(turns);
    await askQ("Which assets are degraded?");
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().network.answer?.kind === "Power status", null, { timeout: 60_000 });
    await expect(scope).toHaveCount(0);
    await shot("12-cleared", page);
    // An area question with none selected says so.
    await askQ("Which transformers supply this area?");
    await waitKind("Select Area");
    await expect(page.locator(`${ANSWER} .tw-say`)).toHaveText("No area is selected.");
  });

  test("20 maintenance investigation: 'what needs to be fixed' for degraded assets reads their ACC inspections (not a status summary), follow-ups resolve the asset", async ({ page }) => {
    test.setTimeout(420_000);
    const SHOTS = process.env.AREA_SHOTS ?? null;
    const shot = async (name: string, locator?: any) => { if (SHOTS) await (locator ?? page).screenshot({ path: `${SHOTS}/${name}.png` }); };
    const { createIfcSpatialApi } = await import("../server/ifcSpatial/api.mjs");
    const { specSheet, inspectionReport } = await import("../tests/pdfFixtures.mjs");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Readable } = await import("node:stream");
    // TX-M2 is degraded in the model (StatusFlag POOR CONDITION); its ACC records: three dated inspections.
    const pdfs: Record<string, Uint8Array> = {
      "TX-M2_Transformer.pdf": specSheet({ assetId: "TX-M2", fields: [["Rating", "34.5/13.8 kV, 12 MVA"]] }),
      "TX-M2_Transformer_Inspection-2024-001_2024-03-12.pdf": inspectionReport({ assetId: "TX-M2", date: "2024-03-12", number: "M2-24", condition: "GOOD (4/5)", findings: [["Bushings (HV and LV)", "OK", "Clean."]] }),
      "TX-M2_Transformer_Inspection-2025-001_2025-04-10.pdf": inspectionReport({ assetId: "TX-M2", date: "2025-04-10", number: "M2-25", condition: "FAIR (3/5)", findings: [["Radiators and cooling fans", "Attention", "Weep at radiator 3 valve."]], actions: [["Re-sample oil for DGA", "Medium", "2025-10-10"]] }),
      "TX-M2_Transformer_Inspection-2026-001_2026-10-28.pdf": inspectionReport({ assetId: "TX-M2", date: "2026-10-28", number: "M2-26", condition: "POOR (2/5)", findings: [["Radiators and cooling fans", "Defect", "Oil leaking at radiator 3 isolation valve."], ["Cooling fans", "Defect", "Fan 4 failed."], ["Bushings (HV and LV)", "Attention", "Discolouration on LV X2 connector."]], actions: [["Repair radiator 3 isolation valve", "High", "2026-12-15"]] }),
    };
    const tree: Record<string, { folders: { id: string; name: string }[]; files: string[] }> = {
      top: { folders: [{ id: "docs", name: "Asset Documentation" }], files: [] }, docs: { folders: [{ id: "f2", name: "02_Transformers" }], files: [] }, f2: { folders: [], files: Object.keys(pdfs) } };
    const client = {
      async getAll(path: string) {
        const id = decodeURIComponent(/folders\/([^/]+)\/contents/.exec(path)![1]);
        const node = tree[id] ?? { folders: [], files: [] };
        return { data: [...node.folders.map(f => ({ type: "folders", id: f.id, attributes: { displayName: f.name } })),
          ...node.files.map(f => ({ type: "items", id: `urn:item:${f}`, attributes: { displayName: f }, relationships: { tip: { data: { id: `urn:v:${f}?version=1` } } }, links: { webView: { href: `https://acc.autodesk.com/docs/files/projects/p?entityId=${f}` } } }))],
          included: node.files.map(f => ({ type: "versions", id: `urn:v:${f}?version=1`, attributes: { name: f, versionNumber: 1, fileType: "pdf", storageSize: pdfs[f].length, lastModifiedTime: "2026-11-25T08:00:00Z" } })) };
      },
      async get() { return { data: {} }; },
    };
    const model = readFileSync(new URL("../tests/fixtures/ifc/seagirt-compare-v2.ifc", import.meta.url));
    const v = "urn:model?version=3";
    const files = { hub: { id: "h" }, project: { id: "b.p", name: "Seagirt Electrical Digital Twin POC" }, topFolders: [{ id: "top", name: "Project Files" }],
      files: [{ fileName: "seagirt_power_network.ifc", itemId: "urn:i", tipVersionId: v, versions: [{ id: v, versionNumber: 3 }] }] };
    const analysed: string[] = [];
    const api = createIfcSpatialApi({ aps: { dataClient: () => client, projectFiles: async () => files, sessionId: () => "browser-session" }, cacheDir: mkdtempSync(join(tmpdir(), "ifc-maint-e2e-")),
      logger: { info() {}, warn() {}, error() {} }, download: async () => ({ bytes: model }), now: () => Date.parse("2026-11-26T09:00:00Z"),
      openStream: async (_c: unknown, _p: unknown, versionId: string) => {
        const name = versionId.replace(/^urn:v:/, "").replace(/\?.*$/, "");
        return { body: Readable.from([Buffer.from(pdfs[name])]), contentLength: pdfs[name].length, fileName: name };
      } });
    await page.route(/googleapis\.com/, route => route.abort());
    await page.route("**/api/ifc-spatial/**", async route => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith("/documents/analysis")) analysed.push(u.searchParams.get("asset")!);
      const body = route.request().postDataBuffer();
      const req: any = Readable.from(body ? [body] : []);
      Object.assign(req, { method: route.request().method(), url: u.pathname + u.search, headers: {} });
      let status = 200, headers: any = {}; const parts: Buffer[] = [];
      await api.handle(req, { writeHead(s: number, h: any) { status = s; headers = h; }, write(c: any) { parts.push(Buffer.from(c)); }, end(b: any) { if (b) parts.push(Buffer.from(b)); } } as any);
      await route.fulfill({ status, headers, body: Buffer.concat(parts) });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTwin(page, "&screen=ifc-spatial");
    await page.waitForFunction(() => (window as any).__ifcSpatial?.state().phase === "ready", null, { timeout: 180_000 });
    await page.waitForFunction(() => (window as any).__ifcSpatial.documents.state().summary, null, { timeout: 60_000 });
    await openAsk(page);
    const askQ = async (q: string) => { await page.fill(".isp-askbar input", q); await page.press(".isp-askbar input", "Enter"); };
    const answer = () => page.evaluate(() => (window as any).__ifcSpatial.state().network.answer);
    const waitKind = (kind: string) => page.waitForFunction(k => { const a = (window as any).__ifcSpatial.state().network.answer; return a?.kind === k && a.status !== "loading"; }, kind, { timeout: 120_000 });

    // A selected area around TX-M2: "For degraded asset, what needs to be fixed?" is a maintenance investigation.
    const m2 = await page.evaluate(() => (window as any).__ifcSpatial.area.lonLat("TX-M2"));
    const d = 0.0008;
    await page.evaluate(r => (window as any).__ifcSpatial.area.select(r, "RECTANGLE"), [[m2.lon - d, m2.lat - d], [m2.lon + d, m2.lat - d], [m2.lon + d, m2.lat + d], [m2.lon - d, m2.lat + d]]);
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().network.area?.inside.includes("TX-M2"));
    await askQ("Which assets are degraded in this area?");
    await waitKind("Area power status");
    await expect(page.locator(`${ANSWER} .tw-say`)).toContainText("degraded");
    await askQ("For degraded asset, what needs to be fixed?");
    await waitKind("Maintenance assessment");
    expect(analysed).toContain("TX-M2");
    const card = page.locator(`${ANSWER} .tw-maint`);
    await expect(page.locator(`${ANSWER} .tw-say`)).toContainText("I found one degraded transformer, TX-M2, in the selected area. Its latest inspection (2026-10-28) documents 3 issues");
    await expect(card.locator(".tw-mh").first()).toHaveText("What needs to be fixed or investigated");
    await expect(card.locator(".tw-mfind")).toHaveCount(4);
    await expect(card).toContainText("Fan 4 failed.");
    await expect(card).toContainText("Repair radiator 3 isolation valve");
    await expect(card.locator(".tw-mtrend circle")).toHaveCount(3);
    await expect(card.locator(".tw-mtrend")).toContainText("Mar 2024");
    await expect(page.locator(`${ANSWER} .tw-scope`)).toContainText("Selected area");
    await expect(page.locator(`${ANSWER} .tw-maint-list`)).toHaveCount(0, { timeout: 1000 });
    await shot("m1-single-asset", page);
    // The asset is focused on the map; the area stays.
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().network.selectedId === "TX-M2");
    expect((await page.evaluate(() => (window as any).__ifcSpatial.state().network.area))).not.toBeNull();
    // A source opens the existing document preview at its page.
    await card.locator(".tw-msrc .tw-mcite").click();
    await page.waitForFunction(() => (window as any).__ifcSpatial.documents.state().previewing, null, { timeout: 30_000 });
    await page.waitForTimeout(1500);
    await shot("m7-source-preview", page);
    await page.evaluate(() => (window as any).__ifcSpatial.documents.closePreview());

    // Follow-ups resolve TX-M2 from the conversation.
    await askQ("What needs to be fixed?");
    await waitKind("Maintenance assessment");
    await expect(page.locator(`${ANSWER} .tw-mid`)).toHaveText("TX-M2");
    // Phase 2: each follow-up answered for what it asks, from the same (cached) records.
    const before = analysed.length;
    const say = () => page.locator(`${ANSWER} .tw-say`);
    const follow = async (q: string, re: RegExp) => { await askQ(q); await waitKind("Maintenance assessment"); await expect(say()).toContainText(re); };
    await follow("Has this issue occurred before?", /^Yes: \d of TX-M2's latest findings (was|were) also reported in earlier inspections/);
    await expect(page.locator(`${ANSWER} .tw-maint`)).toContainText("Recurrence across inspections");
    await follow("Is its condition getting worse?", /Yes: TX-M2's documented condition has worsened, from Good 4\/5 \(Mar 2024\) to Poor 2\/5 \(Oct 2026\)/);
    await follow("Since when has this asset been degraded?", /do not establish when the degraded status began/);
    await follow("Which repairs are still outstanding?", /documented actions? (has|have) no verified closure for TX-M2/);
    await expect(page.locator(`${ANSWER} .tw-maint .tw-mtag`).first()).toContainText("Closure not verified");
    await follow("Can we continue operating this asset?", /operating restriction/);
    await expect(page.locator(`${ANSWER} .tw-say2`)).toContainText("needs engineering approval");
    await follow("Why is this asset degraded?", /The records do not establish why TX-M2 is degraded/);
    // Evidence opens on request.
    if (await page.locator(`${ANSWER} .tw-mfold > summary`).count()) await page.locator(`${ANSWER} .tw-mfold > summary`).click();
    await page.locator(`${ANSWER} .tw-mev > summary`).first().click();
    await expect(page.locator(`${ANSWER} .tw-mev blockquote`).first()).toBeVisible();
    expect(analysed.length).toBe(before);

    // ---- Phase 4: the investigation's report and email; network follow-ups on its asset ----
    await expect(page.locator(`${ANSWER} [data-maint-report]`)).toBeVisible();
    await askQ("Prepare a report of these issues.");
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().network.report?.status === "COMPLETED", null, { timeout: 120_000 });
    await expect(page.locator(`${ANSWER} .tw-say`)).toContainText("The maintenance report covers 1 asset: 1 with documented findings");
    // Asked with the area selected: the report keeps the area (named so) and its snapshot.
    await expect(page.locator(ANSWER)).toContainText("Selected Area Transformer Maintenance Report");
    await expect(page.locator(ANSWER)).toContainText("Selected Area Corrective Action Register");
    await expect(page.locator(ANSWER)).toContainText("PDF · Findings, corrective actions, closure and locations");
    await shot("m5-maintenance-report", page.locator(".isp-askp"));
    await askQ("Inform the maintenance team.");
    await page.waitForFunction(() => /maintenance findings/i.test(document.querySelector(".isp-askp-chat .isp-turn:last-child .isp-msg-ans")?.textContent ?? "") || /TX-M2/.test((document.querySelector(".isp-askp-chat .isp-turn:last-child .isp-msg-ans [contenteditable]") as HTMLElement)?.innerText ?? ""), null, { timeout: 60_000 });
    await expect(page.locator(`${ANSWER} [contenteditable]`).first()).toContainText("TX-M2");
    await expect(page.locator(`${ANSWER} [contenteditable]`).first()).toContainText("no verified closure");
    await expect(page.locator(`${ANSWER} .tw-say`).first()).toHaveText(/^I've drafted an email to the Maintenance Team with the report and the register attached\./);
    await shot("m6-email", page.locator(".isp-askp"));
    // The draft survives a width change (one implementation, both widths).
    const draftText = await page.locator(`${ANSWER} [contenteditable]`).first().innerText();
    await page.locator(".isp-askp-width").click();
    await expect.poll(async () => (await page.locator(".isp-ask").boundingBox())!.width, { timeout: 20_000 }).toBeGreaterThan(500);
    await shot("m8-email-expanded", page);
    expect(await page.locator(`${ANSWER} [contenteditable]`).first().innerText()).toBe(draftText);
    await page.locator(".isp-askp-width").click();
    await expect.poll(async () => (await page.locator(".isp-ask").boundingBox())!.width, { timeout: 20_000 }).toBeLessThan(450);
    await askQ("Is there an alternate supply?");
    await page.waitForFunction(() => { const a = (window as any).__ifcSpatial.state().network.answer; return a && a.status !== "loading" && a.kind !== "Maintenance assessment"; }, null, { timeout: 60_000 });
    await expect(page.locator(`${ANSWER}`)).toContainText("TX-M2");
    await expect(page.locator(".isp-turn:last-child .isp-msg-user p")).toHaveText("Is there an alternate supply?");
    // Replacement: only when asked, from the existing replacement review of the resolved asset.
    await askQ("What needs to be done before replacement?");
    await page.waitForFunction(() => { const a = (window as any).__ifcSpatial.state().network.answer; return a && a.status !== "loading" && a.kind !== "Maintenance assessment" && a.kind !== "Alternate supply"; }, null, { timeout: 90_000 });
    await expect(page.locator(ANSWER)).toContainText("TX-M2");
    await expect(page.locator(".isp-turn:last-child .isp-msg-user p")).toHaveText("What needs to be done before replacement?");
    // The asset again (the email turn is no longer the context), then the outage.
    await askQ("What needs to be fixed on TX-M2?");
    await waitKind("Maintenance assessment");
    await askQ("What happens if we shut it down?");
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().network.answer?.kind === "Outage simulation", null, { timeout: 60_000 });
    await expect(page.locator(".isp-turn:last-child .isp-msg-user p")).toHaveText("What happens if we shut it down?");
    await expect(page.locator(`${ANSWER} .tw-say`)).toContainText("TX-M2");
    await page.locator(`${ANSWER} [data-act="simReset"]`).click();

    // The whole terminal: the same investigation, the area kept.
    await askQ("Show what needs to be fixed for all degraded assets across Seagirt.");
    await waitKind("Maintenance assessment");
    await expect(page.locator(`${ANSWER} .tw-scope`)).toContainText("Entire terminal");
    expect((await page.evaluate(() => (window as any).__ifcSpatial.state().network.area))).not.toBeNull();
    // ---- Phase 3: several assets: a compact collection, drill-down, Back to results, all on the map, both widths ----
    await askQ("For all degraded and unpowered assets across Seagirt, what needs to be fixed?");
    await waitKind("Maintenance assessment");
    const list = page.locator(`${ANSWER} .tw-maint-list`);
    await expect(list).toBeVisible();
    const rows = list.locator(".tw-mrow");
    const n = await rows.count();
    expect(n).toBeGreaterThan(1);
    await expect(say()).toContainText(new RegExp(`^I found ${n} assets that are degraded or without power across the terminal\\. Inspection evidence is available for 1 of them\\.`));
    await expect(rows.first()).toHaveAttribute("data-maint-open", "TX-M2");
    await expect(list.locator(".tw-mrow:not([data-maint-open='TX-M2']) .tw-mrow-t").first()).toHaveText(/Cause of (power loss|degradation) not documented/);
    const metrics = await list.locator(".tw-mmetrics b").allTextContents();
    expect(metrics.map(Number)).toEqual([n, 1, n - 1]);
    await expect(list.locator('.tw-mrow[data-maint-open="TX-M2"] .tw-mrow-t')).toContainText("Radiators and cooling fans");
    await expect(list.locator(".tw-mrow:not([data-maint-open='TX-M2']) .tw-mrow-t").first()).toHaveText(/not documented|No linked documents/);
    // Only TX-M2 has linked documents: only its records are read (cached from before).
    expect(analysed.filter(x => x !== "TX-M2").length).toBe(0);
    const ids = await rows.evaluateAll(r => r.map(x => (x as HTMLElement).dataset.maintOpen));
    await shot("m2-multi-default", page.locator(".isp-askp"));
    // Show all on map: every row highlighted, nothing focused.
    await list.locator("[data-maint-all]").click();
    await page.waitForFunction(list => { const s = (window as any).__ifcSpatial.state().network; return list.every((id: string) => s.askIds.includes(id)); }, ids);
    // A row: that asset's assessment, focused on the map, with Back to results; the area stays.
    await list.locator('.tw-mrow[data-maint-open="TX-M2"]').click();
    await expect(page.locator(`${ANSWER} .tw-maint .tw-mid`)).toHaveText("TX-M2");
    await expect(page.locator(`${ANSWER} .tw-mback`)).toContainText(`Back to results (${n})`);
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().network.selectedId === "TX-M2");
    expect((await page.evaluate(() => (window as any).__ifcSpatial.state().network.area))).not.toBeNull();
    await shot("m4-drilldown", page);
    // Expanded and restored: the opened asset and the conversation stay.
    await page.locator(".isp-askp-width").click();
    await expect.poll(async () => (await page.locator(".isp-ask").boundingBox())!.width, { timeout: 20_000 }).toBeGreaterThan(500);
    await expect(page.locator(`${ANSWER} .tw-maint .tw-mid`)).toHaveText("TX-M2");
    await page.locator(`${ANSWER} .tw-mback`).click();
    await expect(page.locator(`${ANSWER} .tw-maint-list`)).toBeVisible();
    await page.waitForFunction(list => { const s = (window as any).__ifcSpatial.state().network; return list.every((id: string) => s.askIds.includes(id)); }, ids);
    expect((await page.evaluate(() => (window as any).__ifcSpatial.state().network.selectedId))).toBeNull();
    await shot("m3-multi-expanded", page);
    await page.locator(".isp-askp-width").click();
    await expect.poll(async () => (await page.locator(".isp-ask").boundingBox())!.width, { timeout: 20_000 }).toBeLessThan(450);
    await expect(page.locator(`${ANSWER} .tw-maint-list`)).toBeVisible();
    // A newer question while one runs: the earlier answer never lands on the newer turn.
    await askQ("For all degraded and unpowered assets across Seagirt, which repairs are still outstanding?");
    await askQ("Which assets are degraded?");
    await page.waitForFunction(() => (window as any).__ifcSpatial.state().network.answer?.kind === "Area power status" || (window as any).__ifcSpatial.state().network.answer?.kind === "Power status", null, { timeout: 60_000 });
    await page.waitForTimeout(1500);
    expect((await page.evaluate(() => (window as any).__ifcSpatial.state().network.answer)).kind).not.toBe("Maintenance assessment");

    // An asset without linked documents: nothing invented.
    await page.evaluate(() => (window as any).__ifcSpatial.area.clear());
    await askQ("What needs to be fixed on TX-M1?");
    await waitKind("Maintenance assessment");
    await expect(page.locator(`${ANSWER} .tw-maint`)).toHaveClass(/is-empty/);
    await expect(page.locator(`${ANSWER} .tw-mfind`)).toHaveCount(0);
    await shot("m9-missing-evidence", page.locator(".isp-askp"));
    // Scenario D: with the area cleared, the same question is terminal-wide and says no area.
    await askQ("For degraded assets, what needs to be fixed?");
    await waitKind("Maintenance assessment");
    await expect(page.locator(`${ANSWER} .tw-scope`)).toHaveCount(0);
    await expect(page.locator(`${ANSWER} .tw-say`)).toContainText(/^I found one degraded transformer, TX-M2\. /);
    void answer;
  });
});
