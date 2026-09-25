/**
 * "Fly to WO-900461" — Ask the Twin reaching the maintenance classes.
 *
 * The maintenance types are workspace-owned: only one is drawn at a time, and none is drawn before
 * Maintenance is opened. Both facts used to make them unreachable from Ask the Twin — a search that
 * could not see them, and a fly-to that had no layer to switch on. This suite starts on Overview and
 * never touches the Maintenance tab by hand, so it fails if either regresses.
 *
 * Ids and coordinates come from what the app loaded, never written here.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const TYPES = ['workOrder', 'ticket', 'task', 'inspection', 'incidentRecord'];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
  const problems = [];
  const networkNoise = /Failed to load resource|net::ERR|CORS policy|Failed to fetch|live-events|snapshot|ask/i;
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !networkNoise.test(m.text())) problems.push(`console: ${m.text()}`); });

  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off&data=mock');
  await page.locator('body[data-startup="ready"]').waitFor({ timeout: 90000 });
  await page.waitForFunction(() => (window.__maintenance?.recordsForType('inspection')?.length ?? 0) > 0, null, { timeout: 90000 });
  assert.equal(await page.evaluate(() => document.body.dataset.section), 'overview', 'Maintenance was never opened');

  // 1. Every maintenance class is searchable before its card has ever been chosen.
  const searchable = await page.evaluate(() => {
    const by = {};
    for (const entry of window.__assetExplorer.searchableAssets()) by[entry.asset.assetType] = (by[entry.asset.assetType] ?? 0) + 1;
    return by;
  });
  for (const type of TYPES) assert.ok(searchable[type] > 0, `${type} is searchable without opening its card (${searchable[type] ?? 0})`);
  console.log(`✓ all five maintenance classes searchable from Overview: ${TYPES.map(t => `${t} ${searchable[t]}`).join(', ')}`);

  // 2. Nothing sits off Florida. One live class ships x and y the wrong way round, which put its
  //    inspections in the Southern Ocean and sent the camera 10,900 km away.
  const stray = await page.evaluate(types => types.flatMap(type => window.__maintenance.recordsForType(type)
    .filter(r => r.latitude != null && (r.latitude < 24 || r.latitude > 31 || r.longitude < -88 || r.longitude > -79))
    .map(r => `${type}:${r.id}`)), TYPES);
  assert.deepEqual(stray, [], 'every placed maintenance record is in Florida');
  console.log('✓ no maintenance record is placed outside Florida (the swapped-coordinate class is corrected)');

  // 3. Each type flies to its own record, from Overview, with nothing opened by hand.
  const targets = await page.evaluate(types => types.map(type => {
    const r = window.__maintenance.recordsForType(type).find(x => x.latitude != null);
    return { type, id: r.id, lat: r.latitude, lon: r.longitude };
  }), TYPES);

  for (const { type, id, lat, lon } of targets) {
    const flown = await page.evaluate(async question => {
      const search = await import('/src/assetExplorer/assetSearch.js');
      const request = search.parseFlyRequest(question);
      const resolved = search.resolveFlyTarget(search.searchAssets(window.__assetExplorer.searchableAssets(), request.target, request.types));
      if (resolved.kind !== 'fly') return { kind: resolved.kind };
      return { kind: 'fly', flown: (await window.__assetExplorer.flyToAsset(resolved.asset))?.id ?? null };
    }, `fly to ${id}`);
    assert.equal(flown.kind, 'fly', `"fly to ${id}" resolves to one ${type}`);
    assert.equal(flown.flown, id, `${type}: flyToAsset delivered it (a workspace type has no layer to switch on)`);

    // Wait for the camera to ARRIVE rather than for a fixed interval: the flight's duration varies
    // with distance, and a fixed pause occasionally measured it mid-flight.
    await page.waitForFunction(target => {
      const c = window.__viewer.camera.positionCartographic;
      const dLat = (c.latitude * 180 / Math.PI - target.lat) * 111000;
      const dLon = (c.longitude * 180 / Math.PI - target.lon) * 111000 * Math.cos(target.lat * Math.PI / 180);
      return Math.hypot(dLat, dLon) < 400;
    }, { lat, lon }, { timeout: 30000, polling: 300 }).catch(() => {});
    const camera = await page.evaluate(() => {
      const c = window.__viewer.camera.positionCartographic;
      return { lat: c.latitude * 180 / Math.PI, lon: c.longitude * 180 / Math.PI };
    });
    const metres = Math.hypot((camera.lat - lat) * 111000, (camera.lon - lon) * 111000 * Math.cos(lat * Math.PI / 180));
    assert.ok(metres < 400, `${type} ${id}: camera is ${Math.round(metres)} m from the record, not at it`);
    assert.equal(await page.evaluate(() => window.__assetExplorer.store.getState().selectedAsset?.id ?? null), id,
      `${type}: the record is selected, so details and Back behave as everywhere else`);
    console.log(`✓ ${type}: "fly to ${id}" → camera ${Math.round(metres)} m away, record selected`);
  }

  // 4. The whole thing through the chat box, which is how a person actually asks.
  const ticket = targets.find(t => t.type === 'ticket');
  await page.locator('.ask-twin-btn').click();
  const input = page.locator('.ask-twin-panel input').first();
  await input.waitFor({ timeout: 15000 });
  await input.fill(`fly to ${ticket.id}`);
  await input.press('Enter');
  await page.waitForFunction(id => window.__assetExplorer.store.getState().selectedAsset?.id === id, ticket.id, { timeout: 30000 });
  const transcript = await page.locator('.ask-twin-messages').innerText();
  assert.ok(transcript.includes(ticket.id), 'the answer names the record it flew to');
  assert.ok(!/Could not reach the twin/.test(transcript),
    'it is answered locally, not handed to the remote service');
  assert.equal(await page.evaluate(() => document.body.dataset.section), 'maintenance',
    'and the Maintenance workspace came forward to show it');
  console.log(`✓ chat: "fly to ${ticket.id}" answered locally, Maintenance opened, record selected`);

  assert.deepEqual(problems, []);
  console.log('✓ no page or console errors');
} finally { await browser.close(); }
