/**
 * Ask the Twin "fly to <asset>": resolved against the map's own assets, flown to with the explorer's
 * View-on-map close view, and never sent to the remote service. Ordinary questions still go there.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

// The cameras the layer draws (within 150 m of the network) whose description says MP 8.5.
const atMp85 = JSON.parse(readFileSync(new URL('../public/data/i595_corridor_cameras.geojson', import.meta.url))).features
  .filter(f => { const d = Number(f.properties.distance_to_i595_network_m); return Number.isFinite(d) ? d <= 150 : true; })
  .filter(f => /\bMP 8\.5\b/.test(f.properties.description)).map(f => String(f.properties.camera_id)).sort();
// FDOT section 1 eastbound, and the point where it ends (geometry runs west to east).
const eb1 = JSON.parse(readFileSync(new URL('../public/data/i595_fdot_traffic_segments.geojson', import.meta.url))).features
  .find(f => f.properties.direction === 'EB' && f.properties.fdot_segment_index === 1);
const [eb1EndLon, eb1EndLat] = eb1.geometry.coordinates.at(-1);
const allSegments = JSON.parse(readFileSync(new URL('../public/data/i595_fdot_traffic_segments.geojson', import.meta.url))).features;
const wb2 = allSegments.find(f => f.properties.direction === 'WB' && f.properties.fdot_segment_index === 2);

// GPU rendering: software rendering never finishes loading the 3D tiles, so ground-clamped
// markers sit on placeholder heights and neither framing nor picking matches a real display.
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const problems = [];
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  // Network trouble reaching the live FL511 feed is the environment's, not this feature's.
  const networkNoise = /Failed to load resource|net::ERR|CORS policy|Failed to fetch|live-events|snapshot/;
  page.on('console', m => { if (m.type() === 'error' && !networkNoise.test(m.text())) problems.push(`console: ${m.text()}`); });
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('window.__assetExplorer = assetExplorer;', 'window.__assetExplorer = assetExplorer; window.__v = viewer;') });
  });
  // The remote service, stubbed: every question that reaches it is recorded.
  const remote = [];
  await page.route('**/api/i595/ask', async route => {
    const question = JSON.parse(route.request().postData()).question;
    remote.push(question);
    // The service's real answer to "where segment one ends" put it at -80.35, 26.07 — 5.5 km off
    // I-595. Replayed here for a question the app does not answer itself.
    const body = /Weston/.test(question)
      ? { answer: 'It is around here.', confidence: 'high', sources: ['static_knowledge'], action: { type: 'fly_to', coordinates: { lon: -80.35, lat: 26.07 } } }
      : { answer: 'About 21 km.', confidence: 'medium', sources: ['corridor'], action: { type: 'none' } };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await page.locator('body[data-startup="ready"]').waitFor({ timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('[data-count="lighting"]')?.textContent, null, { timeout: 60000 });

  const ask = async question => {
    await page.locator('.ask-twin-input').fill(question);
    await page.locator('.ask-twin-send').click();
    await page.locator('.ask-twin-input:not(:disabled)').waitFor();
  };
  const state = () => page.evaluate(() => {
    const s = window.__assetExplorer.store.getState();
    return { type: s.activeExplorerType, id: s.selectedAsset?.id ?? null, assetType: s.selectedAsset?.assetType ?? null, inspecting: s.inspectionViewActive, source: s.selectionSource };
  });
  const cameraPos = () => page.evaluate(() => { const c = window.__v.camera.positionWC; return [c.x, c.y, c.z]; });
  const lastReply = () => page.locator('.ask-twin-msg--assistant').last();

  await page.locator('.ask-twin-btn').click();
  const before = await cameraPos();

  // 1. A lighting ID whose category starts switched off.
  await ask('fly to 11063');
  await page.waitForTimeout(2200);
  let s = await state();
  assert.deepEqual([s.type, s.assetType, s.id, s.inspecting, s.source], ['lighting', 'lighting', '11063', true, 'search']);
  const distance = await page.evaluate(() => {
    const v = window.__v, e = v.dataSources.getByName('DataConnect Lighting')[0].entities.getById('lighting-11063');
    const p = e.position.getValue(v.clock.currentTime), c = v.camera.positionWC;
    return Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z);
  });
  assert.ok(distance < 150, `camera ${distance.toFixed(0)} m from 11063`);
  // The point of flying there: once the tiles under the view have loaded, the light's marker is
  // drawn in the middle of the map, not off the bottom edge.
  await page.waitForFunction(() => { let all = true; const walk = c => { for (let i = 0; i < c.length; i++) { const p = c.get(i); if (p.constructor.name === 'Cesium3DTileset' && p.show) all = all && p.tilesLoaded; else if (p.get && p.length !== undefined) walk(p); } }; walk(window.__v.scene.primitives); window.__v.scene.requestRender(); return all; }, null, { timeout: 90000, polling: 1000 });
  await page.waitForTimeout(1500);
  const drawnAt = await page.evaluate(() => {
    const v = window.__v, ds = v.dataSources.getByName('DataConnect Lighting')[0];
    const b = ds._visualizers.find(x => x.constructor.name === 'BillboardVisualizer')._items.get('lighting-11063')?.billboard;
    const p = b?._clampedPosition && v.scene.cartesianToCanvasCoordinates(b._clampedPosition);
    return p ? [Math.round(p.x), Math.round(p.y)] : null;
  });
  assert.ok(drawnAt && drawnAt[0] > 400 && drawnAt[0] < 1200 && drawnAt[1] > 200 && drawnAt[1] < 750, `11063 drawn at ${drawnAt}`);
  assert.equal(await page.locator('#lighting-general-toggle').isChecked(), true, 'its category was switched on');
  assert.match(await lastReply().innerText(), /Flying to Lighting asset 11063 · Lighting · Lighting zone Z2/);
  assert.equal(await page.getByRole('complementary', { name: 'Lighting Asset Details' }).count(), 1);
  console.log(`✓ "fly to 11063" → lighting 11063, category on, camera ${distance.toFixed(0)} m away, marker drawn at ${drawnAt} (1600×1000), details open`);

  // 2. Back from the chat restores the camera from before the flight.
  await lastReply().getByRole('button', { name: /Back to previous view/ }).click();
  await page.waitForTimeout(2000);
  const back = await cameraPos();
  const drift = Math.hypot(back[0] - before[0], back[1] - before[1], back[2] - before[2]);
  assert.ok(drift < 1, `restored within ${drift.toFixed(3)} m`);
  console.log(`✓ Back restored the previous camera (within ${drift.toFixed(3)} m)`);

  // 3. A bridge by the suggestion chip; its type wins over the under-deck lights that carry the
  //    same number in their Segment.
  await page.locator('.ask-twin-chip', { hasText: 'Fly to bridge 860384' }).count().then(n => assert.equal(n, 1, 'suggestion chip'));
  await ask('Fly to bridge 860384');
  await page.waitForTimeout(2000);
  s = await state();
  assert.deepEqual([s.type, s.assetType, s.id, s.inspecting], ['bridge', 'bridge', 'BRIDGE-860384', true]);
  assert.equal(await page.evaluate(() => window.__v.dataSources.getByName('DataConnect Lighting')[0].entities.values.filter(e => e.show).length), 0, 'lighting switched off');
  console.log('✓ "Fly to bridge 860384" → BRIDGE-860384; the lighting layer stepped aside');
  // A bridge number that is not on this map is answered here, not guessed or sent away.
  await ask('fly to bridge 860419');
  assert.match(await lastReply().innerText(), /No bridge matching "bridge 860419" is on this map \(14 bridges loaded\)/);
  console.log('✓ "fly to bridge 860419" (not on this map) → says so locally');

  // 4. A camera by ID, a lighting ID written differently from the record.
  await ask('take me to camera 1837');
  await page.waitForTimeout(2000);
  s = await state();
  assert.deepEqual([s.assetType, s.id, s.inspecting], ['camera', '1837', true]);
  await ask('a13z4');
  await page.waitForTimeout(2000);
  s = await state();
  assert.deepEqual([s.assetType, s.id], ['lighting', 'A 1 3-Z4']);
  console.log('✓ "take me to camera 1837" and bare "a13z4" → camera 1837, lighting A 1 3-Z4');

  // 5. An ambiguous description offers choices; choosing one flies there.
  await ask('fly to camera MP 8.5');
  const choices = lastReply().locator('.ask-twin-fly-btn');
  assert.match(await lastReply().innerText(), new RegExp(`${atMp85.length} assets match "camera MP 8.5"`));
  assert.equal(await choices.count(), atMp85.length);
  const offered = (await choices.allInnerTexts()).map(t => /Camera (\d+)/.exec(t)?.[1]).sort();
  assert.deepEqual(offered, atMp85);
  await choices.nth(1).click();
  await page.waitForTimeout(2200);
  s = await state();
  assert.equal(s.assetType, 'camera'); assert.ok(atMp85.includes(s.id)); assert.equal(s.inspecting, true);
  console.log(`✓ "fly to camera MP 8.5" offered ${atMp85.length} choices (${atMp85.join(', ')}); picking one flew to camera ${s.id}`);

  // 6. None of that reached the remote service; an ordinary question still does.
  assert.deepEqual(remote, []);
  await ask('How long is I-595?');
  await page.waitForTimeout(500);
  assert.deepEqual(remote, ['How long is I-595?']);
  assert.match(await lastReply().innerText(), /About 21 km/);
  // A fly-to naming no asset falls through to the remote service too (it may know the place).
  await ask('fly to the Turnpike interchange');
  await page.waitForTimeout(500);
  assert.deepEqual(remote, ['How long is I-595?', 'fly to the Turnpike interchange']);
  console.log('✓ asset fly-tos stayed local; "How long is I-595?" and an unknown place went to the remote service');

  // Which FDOT sections are drawn, read from each section's own checkbox.
  const shownSections = () => page.evaluate(() => [...document.querySelectorAll('input[data-segment-id]')]
    .filter(box => box.checked).map(box => box.dataset.segmentId).sort());

  // 7. The question from the bug report: answered from the FDOT segment data, not guessed.
  const before7 = await cameraPos();
  await ask('Fly to area where segment one ends');
  await page.waitForTimeout(2200);
  assert.match(await lastReply().innerText(), /Flying to where FDOT section 1 eastbound ends — MP 4\.182 \(the section runs MP 0\.000–4\.182\)\. FDOT describes it as OFF TO NOB HILL RD to Bridge No-860648\./);
  const toEnd = await page.evaluate(([lon, lat]) => {
    const v = window.__v, c = v.camera.positionCartographic;
    const R = 6371000, rad = Math.PI / 180;
    const dx = (lon - c.longitude / rad) * rad * Math.cos(lat * rad) * R, dy = (lat - c.latitude / rad) * rad * R;
    return Math.hypot(dx, dy);
  }, [eb1EndLon, eb1EndLat]);
  assert.ok(toEnd < 400, `camera ${toEnd.toFixed(0)} m (horizontally) from the end of section 1`);
  assert.deepEqual(await shownSections(), [eb1.properties.segment_id], 'only EB section 1 is drawn');
  assert.ok(Math.hypot(...(await cameraPos()).map((v, i) => v - before7[i])) > 100, 'the camera moved');
  assert.equal(remote.filter(q => /segment/.test(q)).length, 0, 'never sent to the remote service');
  console.log(`✓ "Fly to area where segment one ends" → end of FDOT section 1 EB (MP 4.182), camera ${toEnd.toFixed(0)} m from it horizontally`);
  // The follow-up from the bug report: segment 2, then just "westbound".
  const horizontalTo = ([lon, lat]) => page.evaluate(([lon, lat]) => {
    const c = window.__v.camera.positionCartographic, R = 6371000, rad = Math.PI / 180;
    return Math.hypot((lon - c.longitude / rad) * rad * Math.cos(lat * rad) * R, (lat - c.latitude / rad) * rad * R);
  }, [lon, lat]);
  await ask('show me area near segment 2');
  await page.waitForTimeout(2200);
  assert.match(await lastReply().innerText(), /Flying to FDOT section 2 eastbound, MP 4\.182–5\.142/);
  const remoteBefore = remote.length;
  await ask('westbound');
  await page.waitForTimeout(2200);
  assert.match(await lastReply().innerText(), /Flying to FDOT section 2 westbound, MP 4\.182–5\.142/);
  assert.doesNotMatch(await lastReply().innerText(), /Say "westbound"/);
  assert.equal(remote.length, remoteBefore, '"westbound" was not sent to the remote service');
  assert.deepEqual(await shownSections(), [wb2.properties.segment_id], 'only WB section 2 is drawn');
  const coords = wb2.geometry.coordinates, mid = coords[Math.floor(coords.length / 2)];
  const toWb2 = await horizontalTo(mid);
  assert.ok(toWb2 < 2500, `camera ${toWb2.toFixed(0)} m from the middle of WB section 2`);
  await ask('where does it end?');
  await page.waitForTimeout(2200);
  assert.match(await lastReply().innerText(), /where FDOT section 2 westbound ends — MP 4\.182/);
  const toWbEnd = await horizontalTo(coords[0]);
  assert.ok(toWbEnd < 400, `camera ${toWbEnd.toFixed(0)} m from the west end of WB section 2`);
  console.log(`✓ "show me area near segment 2" → "westbound" → "where does it end?" all followed up locally (camera ${toWbEnd.toFixed(0)} m from WB section 2's west end)`);

  // The requests from the second bug report: a whole carriageway, then one section on its own.
  const remoteBeforeRoad = remote.length;
  await ask('i want to highlight westbound i595');
  await page.waitForTimeout(2500);
  assert.match(await lastReply().innerText(), /Showing only I-595 westbound — 8 FDOT sections, MP 0\.000–12\.860\. I-595 eastbound is hidden/);
  let shown = await shownSections();
  assert.equal(shown.length, 8); assert.ok(shown.every(id => id.startsWith('I595-WB')));
  assert.deepEqual([await page.locator('#i595_mainline_wb').isChecked(), await page.locator('#i595_mainline_eb').isChecked()], [true, false]);
  console.log('✓ "i want to highlight westbound i595" → westbound only (8 sections), eastbound hidden, both checkboxes agree');
  await ask('highlight just westbound segment 2');
  await page.waitForTimeout(2500);
  assert.match(await lastReply().innerText(), /FDOT section 2 westbound, MP 4\.182–5\.142 .*Only this section is shown; the other 15 are hidden/s);
  shown = await shownSections();
  assert.deepEqual(shown, [wb2.properties.segment_id]);
  console.log(`✓ "highlight just westbound segment 2" → only ${shown[0]} shown`);
  await ask('show both directions');
  await page.waitForTimeout(2500);
  assert.match(await lastReply().innerText(), /Showing both directions of I-595 — 16 FDOT sections/);
  assert.equal((await shownSections()).length, 16);
  assert.equal(remote.length, remoteBeforeRoad, 'none of these reached the remote service');
  console.log('✓ "show both directions" → all 16 sections back; none of the road requests went to the remote service');

  // The third report: any segment request shows only what was named — bare phrases included.
  const segId = (dir, index) => allSegments.find(f => f.properties.direction === dir && f.properties.fdot_segment_index === index).properties.segment_id;
  const remoteBeforeBare = remote.length;
  // The normal startup turns 595 Express on beside both mainline directions; so does this.
  await page.evaluate(() => { const box = document.querySelector('#express-way'); if (!box.checked) box.click(); });
  await page.waitForFunction(() => document.querySelector('#express-way').checked);
  await ask('eastbound segment 3');
  await page.waitForTimeout(2500);
  assert.deepEqual(await shownSections(), [segId('EB', 3)]);
  assert.equal(await page.locator('#express-way').isChecked(), false, '595 Express switched off with the other roads');
  assert.match(await lastReply().innerText(), /595 Express is hidden too\. Say "show all of I-595" to bring everything back\./);
  assert.match(await lastReply().innerText(), /FDOT section 3 eastbound, MP 5\.142–6\.680 .*Only this section is shown; the other 15 are hidden/s);
  await ask('easbound segment 2 and westbound segment 7');
  await page.waitForTimeout(2500);
  assert.deepEqual(await shownSections(), [segId('EB', 2), segId('WB', 7)].sort());
  assert.match(await lastReply().innerText(), /Showing FDOT section 2 eastbound \(MP 4\.182–5\.142\) and section 7 westbound \(MP 10\.380–12\.579\)\. Only these are shown; the other 14 are hidden/);
  assert.equal(remote.length, remoteBeforeBare, 'bare segment phrases were not sent to the remote service');
  await ask('show all of I-595');
  await page.waitForTimeout(2500);
  assert.equal((await shownSections()).length, 16);
  assert.equal(await page.locator('#express-way').isChecked(), true, '595 Express restored');
  assert.match(await lastReply().innerText(), /595 Express is back too/);
  console.log('✓ "eastbound segment 3" → only EB 3 drawn and 595 Express off; "easbound segment 2 and westbound segment 7" → only EB 2 + WB 7; "show all of I-595" → all 16 + 595 Express back');

  await ask('fly to segment 9');
  assert.match(await lastReply().innerText(), /FDOT sections 1–8 on this map; there is no section 9/);
  console.log('✓ "fly to segment 9" → says the corridor has sections 1–8');

  // 8. A remote answer whose coordinates are off the corridor is reported, not flown to.
  const before8 = await cameraPos();
  await ask('How far is Weston from here?');
  await page.waitForTimeout(2500);
  assert.match(await lastReply().innerText(), /\(26\.07000, -80\.35000\) is 5\.\d km from I-595, so the map was not moved/);
  assert.ok(Math.hypot(...(await cameraPos()).map((v, i) => v - before8[i])) < 1, 'camera did not move');
  assert.equal(await page.locator('.ask-twin-msg--assistant').nth(-2).locator('.ask-twin-fly-btn').count(), 0, 'no Show on map button');
  console.log('✓ remote coordinates 5.5 km off I-595 → reported, map not moved, no Show on map button');

  // 9. Browsing a type and touring it: "fly to the clousers" (sic) and toll gantries.
  const remoteBeforeTour = remote.length;
  const idsOf = type => page.evaluate(t => window.__assetExplorer.searchableAssets().filter(e => e.asset.assetType === t).map(e => e.asset.id), type);
  const selectedNow = () => page.evaluate(() => window.__assetExplorer.store.getState().selectedAsset?.id ?? null);
  const buttonsOf = () => lastReply().locator('.ask-twin-fly-btn');

  // Gantries: fixed data, so the tour always has something to walk through.
  const gantries = await idsOf('gantry');
  assert.ok(gantries.length >= 2 && gantries.length <= 12, `${gantries.length} gantries`);
  await ask('show me the toll gantries');
  await page.waitForTimeout(2000);
  assert.match(await lastReply().innerText(), new RegExp(`There are ${gantries.length} toll gantries on I-595, marked on the map`));
  const listed = await buttonsOf().allInnerTexts();
  assert.equal(listed.filter(t => /^\d+\. /.test(t)).length, gantries.length, 'one button per gantry');
  assert.ok(listed.some(t => /Start with the first gantry/.test(t)));
  assert.equal(await page.evaluate(() => window.__assetExplorer.store.getState().activeExplorerType), 'gantry', 'their layer is on');
  await ask('yes');                                           // "yes" starts at the first
  await page.waitForTimeout(2200);
  const order = await page.evaluate(() => window.__assetExplorer.store.getState().assetsByType.gantry.map(a => a.id));
  assert.equal(await selectedNow(), order[0]);
  assert.match(await lastReply().innerText(), new RegExp(`Gantry 1 of ${gantries.length}: .*Go to the next gantry\\?`));
  await buttonsOf().filter({ hasText: 'Next gantry →' }).click();
  await page.waitForTimeout(2200);
  assert.equal(await selectedNow(), order[1]);
  await ask('previous');
  await page.waitForTimeout(2200);
  assert.equal(await selectedNow(), order[0]);
  await ask('the last one');
  await page.waitForTimeout(2200);
  assert.equal(await selectedNow(), order.at(-1));
  assert.match(await lastReply().innerText(), /That's the last gantry/);
  await ask('next');
  assert.match(await lastReply().innerText(), /That was the last gantry/);
  console.log(`✓ "show me the toll gantries" → ${gantries.length} listed; "yes", Next →, "previous", "the last one", "next" all stepped correctly`);

  // Closures: live FL511 data, so the expected list is whatever the feed has right now.
  const closures = await idsOf('closure');
  await ask('fly to the clousers');
  await page.waitForTimeout(2000);
  if (!closures.length) {
    assert.match(await lastReply().innerText(), /No closures are reported/);
    console.log('✓ "fly to the clousers" → no closures in the live feed right now, said so');
  } else {
    assert.match(await lastReply().innerText(), new RegExp(`There (?:is 1 closure|are ${closures.length} closures) on I-595 right now`));
    assert.equal(await page.locator('#live-events-closure').isChecked(), true, 'closure markers on');
    const first = (await buttonsOf().allInnerTexts()).find(t => /^1\. /.test(t));
    assert.doesNotMatch(first, /^1\. Closure/, 'described by where it is, not by the word "Closure"');
    await buttonsOf().filter({ hasText: /^1\. / }).click();
    await page.waitForTimeout(2200);
    assert.ok(closures.includes(await selectedNow()));
    assert.match(await lastReply().innerText(), new RegExp(`Closure 1 of ${closures.length}: (?!Closure)\\S`));
    console.log(`✓ "fly to the clousers" → ${closures.length} live closure(s) listed as "${first}", markers on, clicking flew there`);
  }

  // A question for the remote service about closures gets the map's own closures underneath.
  await ask('Any closures on I-595 right now?');
  await page.waitForTimeout(800);
  assert.equal(remote.length, remoteBeforeTour + 1, 'the question itself still goes to the remote service');
  if (closures.length) {
    assert.match(await lastReply().innerText(), new RegExp(`On the map: ${closures.length} closures?\\. Pick one to fly there`));
    console.log('✓ "Any closures on I-595 right now?" → remote answer plus the map\'s closures as buttons');
  }

  assert.deepEqual(problems, []);
  console.log('✓ no page or console errors');
} finally { await browser.close(); }
