import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * IFC Model Explorer, in a real browser, without Autodesk credentials: /api/aps/* is answered by
 * route mocks and the Autodesk Viewer SDK by a small stand-in (same API surface the explorer uses),
 * fed with properties trimmed from the real model. What is under test is this app: navigation, the
 * Seagirt screen left as it was, the viewer lifecycle, selection, hierarchy and properties, errors.
 */
const fixture = JSON.parse(readFileSync(new URL("../tests/fixtures/ifc-explorer-properties.json", import.meta.url), "utf8")).results;
const elementIds: number[] = fixture.map((r: { dbId: number }) => r.dbId).filter((id: number) => ![2, 5, 25, 106].includes(id));
const parents: Record<number, number> = { 2: 1, 5: 2, 106: 58, 25: 16, ...Object.fromEntries(elementIds.map(id => [id, 5])) };

const SDK = `(() => {
  const log = window.__fakeAps = { log: [], viewers: 0 };
  const data = ${JSON.stringify(fixture)};
  const byId = new Map(data.map(r => [r.dbId, r]));
  const parent = ${JSON.stringify(parents)};
  const children = {};
  for (const [child, p] of Object.entries(parent)) (children[p] ??= []).push(Number(child));
  const tree = { getRootId: () => 1, getNodeParentId: id => parent[id] ?? 0,
    getNodeName: id => id === 1 ? 'model' : (byId.get(id)?.name ?? 'node'),
    enumNodeChildren(id, cb, recursive) { const walk = n => { for (const k of children[n] ?? []) { cb(k); if (recursive) walk(k); } }; walk(id); } };
  let models = [];
  class GuiViewer3D {
    constructor(container) { this.c = container; this.l = {}; log.viewers += 1; log.log.push('create'); const canvas = document.createElement('canvas'); canvas.className = 'fake-aps-canvas'; container.append(canvas); log.current = this; }
    start() { log.log.push('start'); return 0; }
    setTheme() {} addEventListener(t, f) { this.l[t] = f; } removeEventListener(t) { delete this.l[t]; }
    getAllModels() { return models; }
    unloadModel(m) { models = models.filter(x => x !== m); log.log.push('unload:' + m.urn); }
    async loadDocumentNode(doc) {
      const m = { urn: doc.urn, getObjectTree: ok => ok(tree), getBulkProperties: (ids, o, ok) => ok(ids.map(i => byId.get(i)).filter(Boolean)), getProperties: (i, ok) => ok(byId.get(i)) };
      models.push(m); log.log.push('load:' + doc.urn); return m;
    }
    select(ids) { this.sel = ids; log.selected = ids; this.l.selection?.({ dbIdArray: ids }); }
    getSelection() { return this.sel ?? []; }
    fitToView() { log.log.push('fit'); } isolate(ids) { log.log.push('isolate:' + ids); } showAll() { log.log.push('showAll'); }
    clearSelection() {} resize() {} setViewFromFile() {}
    finish() { log.log.push('finish'); models = []; this.c.replaceChildren(); }
  }
  log.pick = id => log.current.l.selection?.({ dbIdArray: [id] });
  window.Autodesk = { Viewing: { GuiViewer3D, SELECTION_CHANGED_EVENT: 'selection',
    Initializer(o, done) { log.log.push('init:' + o.env); log.getAccessToken = o.getAccessToken; done(); },
    shutdown() {},
    Document: { load(urn, ok) { log.getAccessToken(token => { log.token = token; ok({ urn: urn.slice(4), getRoot: () => ({ getDefaultGeometry: () => ({}) }) }); }); } } } };
})();`;

const file = (fileName: string, urn: string, status = "success") => ({
  fileName, itemId: `urn:adsk.wipprod:dm.lineage:${urn}`, folderId: "urn:pf", folderPath: [{ id: "urn:pf", name: "Project Files" }],
  tipVersionId: `urn:adsk.wipprod:fs.file:vf.${urn}?version=1`,
  versions: [{ id: `urn:adsk.wipprod:fs.file:vf.${urn}?version=1`, versionNumber: 1, lastModifiedTime: "2026-11-20T09:00:00Z", derivativeUrn: urn }],
  derivative: { urn, manifest: { status, progress: "complete", outputs: status === "success" ? [{ outputType: "svf", status: "success" }] : [] } },
});
const filesPayload = (status = "success") => ({
  hub: { id: "b.6709a804-6c12-4829-8b23-8690cfd20da3", name: "SuperDNATechnolab" },
  project: { id: "b.ccb2f061-288c-463d-8e2a-4815350b5f6d", name: "Seagirt Electrical Digital Twin POC" },
  topFolders: [{ id: "urn:pf", name: "Project Files" }],
  files: [file("seagirt_power_network.ifc", "urnA", status), file("seagirt_power_network_display.ifc", "urnB")],
  missing: [], generatedAt: "2026-11-23T10:00:00.000Z",
});

async function mockAps(page: Page, { authenticated = true, files = filesPayload(), token = 200 } = {}) {
  await page.route("https://developer.api.autodesk.com/modelderivative/v2/viewers/**", route =>
    route.fulfill({ status: 200, contentType: route.request().url().endsWith(".css") ? "text/css" : "application/javascript", body: route.request().url().endsWith(".css") ? "" : SDK }));
  await page.route("**/api/aps/**", route => {
    const path = new URL(route.request().url()).pathname;
    const json = (status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/aps/status") return json(200, { configured: true, authenticated, requestedScope: "data:read viewables:read" });
    if (path === "/api/aps/files") return authenticated ? json(200, files) : json(401, { error: { code: "NOT_AUTHENTICATED", message: "Not signed in to Autodesk." } });
    if (path === "/api/aps/viewer-token") return token === 200 ? json(200, { access_token: "view-only-token", expires_in: 3599, scope: "viewables:read" })
      : json(401, { error: { code: "TOKEN_EXPIRED", message: "The Autodesk session has expired or was revoked.", hint: "Sign in again at /api/aps/login." } });
    return route.continue();
  });
}

const twin = (page: Page) => page.evaluate(() => (window as any).__seagirt.state());
const explorer = (page: Page) => page.evaluate(() => (window as any).__ifc?.state() ?? null);
const fake = (page: Page) => page.evaluate(() => { const f = (window as any).__fakeAps; return f && { log: f.log, viewers: f.viewers, token: f.token, selected: f.selected }; });
const ready = (page: Page) => page.waitForFunction(() => (window as any).__ifc?.state().phase === "ready", null, { timeout: 30_000 });

async function openTwin(page: Page, query = "") {
  await page.goto(`/?demo=seagirt${query}`);
  await page.waitForFunction(() => (window as any).__seagirt, null, { timeout: 90_000 });
}

test.describe("IFC Model Explorer", () => {
  test.setTimeout(120_000);

  test("1 a separate screen: the twin's outage, investigation and map survive a round trip", async ({ page }) => {
    await mockAps(page);
    await openTwin(page);
    await page.evaluate(() => (window as any).__seagirt.ask("What happens if Transformer T1 goes offline?"));
    await page.waitForFunction(() => (window as any).__seagirt.state().scenario);
    const before = await twin(page);
    expect(before.scenario.lost).toContain("C1");

    // The legacy explorer has no rail entry any more (the IFC Spatial Twin has it); it opens by ?screen=ifc or the hook.
    await page.evaluate(() => (window as any).__seagirt.openScreen("ifc"));
    await ready(page);
    expect(page.url()).toContain("screen=ifc");
    await expect(page.locator(".ifx")).toBeVisible();
    await expect(page.locator("#cesiumContainer")).toBeHidden();
    for (const chrome of [".sg-top", ".sg-panel", ".sg-ask", ".sg-layers"]) await expect(page.locator(chrome)).toBeHidden();
    await expect(page.locator('.sg-rail-item[data-tab="ifc"]')).toHaveCount(0);
    expect(await page.locator(".cesium-widget").count()).toBe(1);
    // The Autodesk Viewer lives inside the explorer, never over the map.
    expect(await page.locator("#cesiumContainer .fake-aps-canvas").count()).toBe(0);
    expect(await page.locator(".ifx-viewer .fake-aps-canvas").count()).toBe(1);

    await page.click(`.sg-rail-item[data-tab="${before.tab}"]`);
    await expect(page.locator(".ifx")).toBeHidden();
    await expect(page.locator("#cesiumContainer")).toBeVisible();
    await expect(page.locator(".sg-panel")).toBeVisible();
    expect(page.url()).not.toContain("screen=");
    const after = await twin(page);
    expect(after.screen).toBe("twin");
    expect(after.scenario).toEqual(before.scenario);
    expect(after.investigation?.title).toBe(before.investigation?.title);
    expect(after.markerStatus).toEqual(before.markerStatus);
    expect((await explorer(page)).viewerAlive).toBe(false);
    expect((await fake(page)).log).toContain("finish");
  });

  test("2 direct link: hierarchy, search, selection and properties from the model", async ({ page }) => {
    await mockAps(page);
    await openTwin(page, "&screen=ifc");
    await ready(page);
    const s = await explorer(page);
    expect(s.fileName).toBe("seagirt_power_network.ifc");
    expect(s.elementCount).toBe(fixture.length);
    expect(s.modelCount).toBe(1);
    expect((await fake(page)).token).toBe("view-only-token");
    await expect(page.locator(".ifx-conn")).toHaveText("Connected");
    await expect(page.locator(".ifx-source")).toContainText("Seagirt Electrical Digital Twin POC");
    await expect(page.locator(".ifx-version")).toHaveText("Version 1");
    await expect(page.locator(".ifx-right")).toContainText("Electrical equipment found");

    // Hierarchy: project > grouping node > elements, expandable.
    await expect(page.locator(".ifx-list .ifx-row-name", { hasText: "Seagirt Marine Terminal power network" })).toBeVisible();
    await page.fill(".ifx-search", "TX-M1");
    const hit = page.locator(".ifx-list .ifx-row", { hasText: "TX-M1 Main transformer" });
    await expect(hit).toBeVisible();
    await hit.click();
    const tx = fixture.find((r: { name: string }) => r.name.includes("TX-M1"));
    expect((await fake(page)).selected).toEqual([tx.dbId]);
    await expect(page.locator(".ifx-title")).toHaveText("TX-M1 Main transformer TX-M1");
    const globalId = tx.properties.find((p: any) => p.displayCategory === "IFC Attributes" && p.displayName === "GlobalId").displayValue;
    await expect(page.locator(".ifx-dl").first()).toContainText(String(tx.dbId));
    await expect(page.locator(".ifx-dl").first()).toContainText(globalId);
    await expect(page.locator(".ifx-group summary", { hasText: "Pset_TransformerTypeCommon" })).toBeVisible();
    await page.click('.ifx-right [data-act="isolate"]');
    expect((await fake(page)).log).toContain(`isolate:${tx.dbId}`);

    // A click on body geometry in the viewer selects the element that owns it.
    await page.evaluate(() => (window as any).__fakeAps.pick(106));
    await expect(page.locator(".ifx-title")).toContainText("F1 Quay feeder F1");
    expect((await explorer(page)).selectedDbId).toBe(58);
  });

  test("3 switching models disposes the previous one; mapping is read-only", async ({ page }) => {
    await mockAps(page);
    await openTwin(page, "&screen=ifc");
    await ready(page);
    await page.selectOption(".ifx-model select", "seagirt_power_network_display.ifc");
    await page.waitForFunction(() => (window as any).__ifc.state().fileName.includes("display") && (window as any).__ifc.state().phase === "ready");
    const log = (await fake(page)).log;
    expect(log.filter((e: string) => /^(load|unload)/.test(e))).toEqual(["load:urnA", "unload:urnA", "load:urnB"]);
    expect((await explorer(page)).modelCount).toBe(1);
    expect(page.url()).toContain("model=seagirt_power_network_display.ifc");

    await page.click('.ifx-tabs [data-tab="mapping"]');
    await expect(page.locator(".ifx-list")).toContainText("Identifier candidates (unconfirmed)");
    await expect(page.locator(".ifx-map.is-cand")).toContainText("L1");
    await expect(page.locator(".ifx-map.is-amb").first()).toContainText("Voltage differs");
    const before = await twin(page);
    expect(before.scenario).toBeNull();
  });

  test("4 leaving disposes the viewer; returning reloads the chosen model", async ({ page }) => {
    await mockAps(page);
    await openTwin(page, "&screen=ifc");
    await ready(page);
    await page.click('.sg-rail-item[data-tab="overview"]');
    expect((await explorer(page)).viewerAlive).toBe(false);
    await page.evaluate(() => (window as any).__seagirt.openScreen("ifc"));
    await ready(page);
    const f = await fake(page);
    expect(f.viewers).toBe(2);
    expect(f.log.filter((e: string) => e === "finish").length).toBe(1);
    expect(f.log.filter((e: string) => e.startsWith("init")).length).toBe(1);
    expect((await explorer(page)).modelCount).toBe(1);
  });

  test("5 errors: not signed in, expired token, failed derivative", async ({ page }) => {
    await mockAps(page, { authenticated: false });
    await openTwin(page, "&screen=ifc");
    await expect(page.locator(".ifx-error h2")).toHaveText("Sign in to Autodesk");
    await expect(page.locator(".ifx-error a")).toHaveAttribute("href", /\/api\/aps\/login\?returnTo=%2F%3Fdemo%3Dseagirt%26screen%3Difc/);

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mockAps(page, { token: 401 });
    await openTwin(page, "&screen=ifc");
    await expect(page.locator(".ifx-error h2")).toHaveText("Sign in to Autodesk");
    await expect(page.locator(".ifx-error")).toContainText("TOKEN_EXPIRED");
    await expect(page.locator(".ifx-conn")).toHaveText("Not signed in");

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await mockAps(page, { files: filesPayload("failed") });
    await openTwin(page, "&screen=ifc");
    await expect(page.locator(".ifx-error h2")).toHaveText("Translation not complete");
    expect(((await fake(page))?.log ?? []).some((e: string) => e.startsWith("load:"))).toBe(false);
  });
});
