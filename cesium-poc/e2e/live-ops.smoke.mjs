/**
 * Live Ops — the incident vertical slice, in the browser.
 *
 * The corridor is frequently empty of live incidents, and the acceptance scenarios have to be
 * provable at any hour, so `/api/i595/live-events` is stubbed with the shape the server really
 * produces — including the `liveOps` enrichment, whose own correctness is covered against the real
 * geometry in `tests/liveOpsResolution.test.mjs`. Everything above the endpoint is the real thing:
 * aggregation, scoring, the corridor's own FDOT segments, the Asset Explorer and the map.
 *
 * Segment ids and coordinates are read from the shipped geometry, never written here.
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const geo = JSON.parse(readFileSync(new URL('../public/data/i595_fdot_traffic_segments.geojson', import.meta.url)));
const segment = (direction, index) => geo.features.find(f =>
  f.properties.direction === direction && f.properties.fdot_segment_index === index);
const midpoint = feature => feature.geometry.coordinates[Math.floor(feature.geometry.coordinates.length / 2)];

const EB3 = segment('EB', 3), WB3 = segment('WB', 3), EB5 = segment('EB', 5);
const [eb3Lon, eb3Lat] = midpoint(EB3);
const [eb5Lon, eb5Lat] = midpoint(EB5);

/** What the server produces for one incident, including its Live Ops enrichment. */
const incident = (id, longitude, latitude, liveOps, extra = {}) => ({
  id, rawSourceId: id, type: 'INCIDENT', source: 'FL511', title: 'Crash',
  description: 'Stubbed for the acceptance scenarios', longitude, latitude,
  detailsAvailable: true, detailFields: [], ...extra,
  liveOps: { corridor: 'I-595', spatialMatch: { method: 'stub', distanceMeters: 10, confidence: 'HIGH' }, ...liveOps },
});

const EVENTS = [
  // A: eastbound, resolved to EB section 3 — the only section that may colour.
  incident('INC-EB', eb3Lon, eb3Lat, {
    carriageway: 'EB_GENERAL', carriagewayLabel: 'Eastbound General Purpose', direction: 'EB',
    sectionId: 'SECTION_03', sectionIndex: 3, sectionLabel: 'Eastbound Section 03',
    segmentId: EB3.properties.segment_id, contributesToImpact: true,
  }, { severity: 'Major' }),
  // C: express, sitting on the same stretch. Must not colour EB or WB section 3.
  incident('INC-EXP', eb3Lon, eb3Lat, {
    carriageway: 'EXPRESS', carriagewayLabel: 'I-595 Express', direction: 'EB',
    sectionId: null, sectionIndex: null, sectionLabel: null, segmentId: null, contributesToImpact: false,
  }, { severity: 'Major' }),
  // D: unresolved, also on the same stretch. Must not colour anything either.
  incident('INC-UNK', eb5Lon, eb5Lat, {
    carriageway: 'UNKNOWN', carriagewayLabel: 'Unresolved', direction: null,
    sectionId: null, sectionIndex: null, sectionLabel: null, segmentId: null, contributesToImpact: false,
  }, { severity: 'Major' }),
];

const payload = events => ({
  source: 'FL511', sourceStatus: 'LIVE', lastUpdated: new Date().toISOString(),
  dataFreshness: { ageSeconds: 0, refreshSeconds: 60, staleAfterSeconds: 180 },
  counts: { total: events.length, incidents: events.filter(e => e.type === 'INCIDENT').length,
    closures: events.filter(e=>e.type==='CLOSURE').length, construction: events.filter(e=>e.type==='CONSTRUCTION').length, congestion: events.filter(e=>e.type==='CONGESTION').length, disabledVehicles: events.filter(e=>e.type==='DISABLED').length },
  events,
});

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
  const problems = [];
  const noise = /Failed to load resource|net::ERR|CORS policy|Failed to fetch|snapshot/;
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !noise.test(m.text())) problems.push(`console: ${m.text()}`); });

  let served = EVENTS;
  await page.route('**/api/i595/live-events*', route =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload(served)) }));

  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off&data=mock');
  await page.locator('body[data-startup="ready"]').waitFor({ timeout: 90000 });

  // 1. Live Ops is in the navigation, beside the workspaces that were already there.
  const navItems = await page.locator('.app-nav-label').allInnerTexts();
  assert.deepEqual(navItems.slice(0, 5), ['Overview', 'Traffic', 'Maintenance', 'Safety', 'Live Ops']);
  await page.locator('.app-nav [data-section="liveOps"]').click();
  await page.locator('.liveops-workspace .ws-kpis').waitFor({ timeout: 30000 });
  await page.waitForFunction(() => window.__liveOps?.impact?.size === 16, null, { timeout: 60000 });
  console.log('✓ Live Ops opens: five KPI cards over the map, 16 corridor sections scored');
  // Operational Impact is on when the workspace opens, as the brief specifies, and the corridor's
  // own carriageways are drawn with it — the overlay colours those lines, so with them off it
  // scored correctly and painted nothing.
  assert.equal(await page.locator('[data-liveops-layer="operationalImpact"]').isChecked(), true,
    'Operational Impact is on by default');
  await page.waitForFunction(() => window.__viewer.dataSources.getByName('I-595 FDOT Traffic Segments')[0]
    .entities.values.filter(entity => entity.show).length === 16, null, { timeout: 30000 });
  console.log('✓ Operational Impact on by default, with all 16 carriageway sections drawn');

  // 2. The KPI counts the live feed, and says what the corridor model could not place.
  const kpi = key => page.locator(`.liveops-workspace .ws-kpi[data-kpi="${key}"]`);
  assert.equal(await kpi('incidents').locator('[data-count]').innerText(), '3');
  assert.equal(await kpi('incidents').locator('[data-note]').innerText(), '3 severe',
    'express and unresolved incidents are counted, and reported as unplaced');
  console.log('✓ Active Incidents: operational count/severity, without mapping jargon');

  // 3. Heat isolation — the rule this whole design exists for.
  const level = id => page.evaluate(segmentId => window.__liveOps.impact.get(segmentId)?.operationalLevel, id);
  assert.equal(await level(EB3.properties.segment_id), 'HIGH', 'the eastbound incident coloured its own section');
  assert.equal(await level(WB3.properties.segment_id), 'NORMAL',
    'the westbound side of the same corridor band is untouched');
  assert.equal(await level(EB5.properties.segment_id), 'NORMAL',
    'and the unresolved incident coloured nothing, though it sits on this section');
  const scored = await page.evaluate(() => [...window.__liveOps.impact.values()]
    .filter(s => s.operationalLevel !== 'NORMAL').map(s => s.sectionLabel));
  assert.deepEqual(scored, ['Eastbound Section 03'], 'exactly one section is coloured');
  console.log('✓ heat isolation: EB Section 03 HIGH; WB Section 03, express and unresolved all leave it alone');

  // 4. And the colour actually reached Cesium, composed with the segment layer's own styling.
  const tints = await page.evaluate(ids => {
    const layer = window.__viewer.dataSources.getByName('I-595 FDOT Traffic Segments')[0];
    const read = id => {
      const entity = layer?.entities.getById(id);
      const tint = entity?.polyline?.material?.getValue(window.__viewer.clock.currentTime)?.color;
      return tint ? [Math.round(tint.red * 255), Math.round(tint.green * 255), Math.round(tint.blue * 255)] : null;
    };
    return { eb: read(ids.eb), wb: read(ids.wb) };
  }, { eb: EB3.properties.segment_id, wb: WB3.properties.segment_id });
  assert.ok(tints.eb, 'the eastbound segment is drawn');
  // #ee9148 is the HIGH tone from the corridor's own ramp.
  assert.deepEqual(tints.eb, [238, 145, 72], 'the eastbound section carries the HIGH colour');
  assert.notDeepEqual(tints.wb, tints.eb, 'the westbound section does not');
  console.log(`✓ Cesium shows it: EB Section 03 tinted rgb(${tints.eb}), WB Section 03 left alone`);

  // Deterministic visual proof: all four heat levels on actual EB segments.
  mkdirSync('../reports/operational-impact', { recursive: true });
  const heatEvents = [
    ['DISABLED', null, null], ['INCIDENT', null, null],
    ['INCIDENT', 'Major', null], ['INCIDENT', 'Major', { fullClosure: true, source: 'parsed' }],
  ].map(([type, severity, laneImpact], i) => {
    const feature = segment('EB', i + 2), [lon, lat] = midpoint(feature);
    return incident(`FIXTURE-${i}`, lon, lat, {
      carriageway: 'EB_GENERAL', segmentId: feature.properties.segment_id,
      sectionId: `SECTION_0${i + 2}`, contributesToImpact: true, laneImpact,
    }, { type, severity });
  });
  served = heatEvents;
  await page.evaluate(() => window.__liveEvents.refresh());
  await page.evaluate(async () => { const source = window.__viewer.dataSources.getByName('I-595 FDOT Traffic Segments')[0]; await window.__viewer.flyTo(source.entities.values.filter(e => e.polyline.material.getValue(window.__viewer.clock.currentTime).color.red > .5), { duration: 0 }); });
  await page.waitForTimeout(8000);
  const expected = [[154,217,127], [229,188,87], [238,145,72], [230,98,89]];
  const ids = heatEvents.map(event => event.liveOps.segmentId);
  const rendered = () => page.evaluate(ids => {
    const source = window.__viewer.dataSources.getByName('I-595 FDOT Traffic Segments')[0];
    return ids.map(id => {
      const entity = source.entities.getById(id), tint = entity.polyline.material.getValue(window.__viewer.clock.currentTime).color;
      return { color: [tint.red, tint.green, tint.blue].map(c => Math.round(c * 255)),
        alpha: tint.alpha, width: entity.polyline.width.getValue(), visible: source.show && entity.show };
    });
  }, ids);
  assert.deepEqual((await rendered()).map(row => row.color), expected);
  assert.ok((await rendered()).every(row => row.visible && row.alpha > .99 && row.width >= 10));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '../reports/operational-impact/fixture-impact-on.png' });
  await page.locator('.liveops-layers-trigger').click();
  for (const id of ['incidents', 'closures', 'disabledVehicles', 'construction', 'congestion']) {
    await page.locator(`[data-liveops-layer="${id}"]`).uncheck();
  }
  assert.deepEqual((await rendered()).map(row => row.color), expected);
  assert.equal(await page.evaluate(() => [...window.__liveEvents.entityById.values()].filter(e => e.isShowing).length), 0);
  await page.locator('.liveops-layers-close').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '../reports/operational-impact/fixture-markers-off-heat-on.png' });
  await page.locator('.liveops-layers-trigger').click();
  await page.locator('[data-liveops-layer="operationalImpact"]').uncheck();
  assert.notDeepEqual((await rendered()).map(row => row.color), expected);
  assert.ok((await rendered()).every(row => row.visible), 'normal roads remain visible');
  await page.locator('.liveops-layers-close').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '../reports/operational-impact/fixture-impact-off.png' });
  await page.locator('.liveops-layers-trigger').click();
  await page.locator('[data-liveops-layer="operationalImpact"]').check();
  for (const id of ['incidents', 'closures', 'disabledVehicles', 'construction', 'congestion']) {
    await page.locator(`[data-liveops-layer="${id}"]`).check();
  }
  await page.locator('.liveops-layers-close').click();
  served = EVENTS;
  await page.evaluate(() => window.__liveEvents.refresh());
  console.log('✓ four rendered heat colors; markers OFF with heat ON; impact OFF restores roads');

  // 5. Choosing the KPI puts incidents — and only incidents — in the bottom explorer.
  await kpi('incidents').click();
  const explorer = page.getByRole('region', { name: 'Incidents explorer', exact: true });
  await explorer.waitFor({ timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__assetExplorer.store.getState().activeExplorerType), 'incident');
  assert.equal(await page.evaluate(() => window.__assetExplorer.store.getState().assetsByType.incident.length), 3);
  assert.equal(await page.locator('[role="region"][aria-label$="explorer"]').count(), 1,
    'one category at a time in the tray — never incidents mixed with cameras or closures');
  console.log('✓ KPI → explorer holds all 3 incidents, and nothing else');

  // 6. A card selects, and the map flies to it — including the ones with no section.
  const cameraAt = () => page.evaluate(() => { const c = window.__viewer.camera.positionWC; return [c.x, c.y, c.z]; });
  const before = await cameraAt();
  await explorer.locator('.MuiCardActionArea-root').first().click();
  await page.waitForTimeout(2500);
  const selected = await page.evaluate(() => window.__assetExplorer.store.getState().selectedAsset?.id);
  assert.ok(['INC-EB', 'INC-EXP', 'INC-UNK'].includes(selected));
  const after = await cameraAt();
  assert.ok(Math.hypot(before[0] - after[0], before[1] - after[1], before[2] - after[2]) > 100, 'the map flew to it');
  assert.equal(await level(EB3.properties.segment_id), 'HIGH');
  assert.deepEqual(await page.evaluate(id => { const t = window.__viewer.dataSources.getByName('I-595 FDOT Traffic Segments')[0].entities.getById(id).polyline.material.getValue(window.__viewer.clock.currentTime).color; return [t.red,t.green,t.blue].map(v=>Math.round(v*255)); }, EB3.properties.segment_id), [238,145,72], 'selection preserves heat');
  console.log(`✓ card → ${selected}: selected and flown to; heat preserved`);

  // 7. Live refresh: the incident goes away, everything the operator chose stays.
  const campos = await cameraAt();
  served = EVENTS.filter(event => event.id !== 'INC-EB');
  await page.evaluate(() => window.__liveEvents?.refresh?.());
  await page.waitForFunction(() => Number(document.querySelector('.liveops-workspace .ws-kpi[data-kpi="incidents"] [data-count]')?.textContent) === 2,
    null, { timeout: 90000 });
  assert.equal(await level(EB3.properties.segment_id), 'NORMAL', 'its section cooled when it left');
  assert.equal(await page.evaluate(() => window.__assetExplorer.store.getState().activeExplorerType), 'incident',
    'the active explorer survived the refresh');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('[data-liveops-layer]')].filter(i => i.checked).map(i => i.dataset.liveopsLayer).join(',')),
    'operationalImpact,incidents,disabledVehicles,closures,construction,congestion',
    'and so did the layer choices — all of them, not just the browsed one');
  const moved = await cameraAt();
  assert.ok(Math.hypot(campos[0] - moved[0], campos[1] - moved[1], campos[2] - moved[2]) < 50, 'the camera was not reset');
  console.log('✓ refresh: KPI and heat recalculated, camera, layers and explorer all preserved');

  // 8. The other workspaces are untouched.
  await page.locator('.app-nav [data-section="safety"]').click();
  await page.locator('.safety-workspace .ws-kpis').waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.liveops-workspace .ws-kpis').isVisible(), false, 'Live Ops stepped aside');
  await page.locator('.app-nav [data-section="traffic"]').click();
  await page.locator('.traffic-workspace .ws-kpis').waitFor({ timeout: 30000 });
  console.log('✓ Safety and Traffic still open and still their own');

  // Current live capture: honest empty heat state, not fixture heat presented as live.
  served = JSON.parse(readFileSync('../reports/operational-impact/live-feed.json')).events;
  await page.locator('.app-nav [data-section="liveOps"]').click();
  await page.evaluate(() => window.__liveEvents.refresh());
  await page.locator('.liveops-layers-trigger').click();
  await page.locator('[data-liveops-layer="operationalImpact"]').check();
  await page.locator('.liveops-layers-close').click();
  await page.locator('.liveops-impact-notice:not([hidden])').waitFor();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: '../reports/operational-impact/live-impact-on.png' });
  // 8. The pulsing circles at event locations.
  await page.waitForFunction(() => (window.__viewer.dataSources.getByName('Live Ops event pulses')[0]?.entities.values.length ?? 0) > 0,
    null, { timeout: 30000 });
  // Long enough for the ring to restart from the centre several times — the moment the first
  // implementation threw `semiMajorAxis must be greater than or equal to the semiMinorAxis`.
  await page.waitForTimeout(9000);
  const pulses = await page.evaluate(() => {
    const ds = window.__viewer.dataSources.getByName('Live Ops event pulses')[0];
    const time = window.__viewer.clock.currentTime;
    // The source also holds each event's static 100 m ground ring, which has no `point`.
    const rings = ds.entities.values.filter(entity => entity.point);
    const groundRings = ds.entities.values.filter(entity => entity.ellipse);
    let bad = 0;
    for (let pass = 0; pass < 25; pass++) {
      for (const ring of rings) {
        // Drawn in screen space, so there is no second axis left to disagree with the first —
        // which is what used to stop rendering outright.
        if (ring.ellipse) { bad += 1; continue; }
        const pixels = ring.point?.pixelSize?.getValue(time);
        if (!(Number.isFinite(pixels) && pixels > 0)) bad += 1;
      }
    }
    const colors = rings.map(ring => ring.point.color.getValue(time)).map(c => c.alpha);
    return { rings: rings.length, bad, shown: rings.filter(r => r.show).length,
      fading: new Set(colors.map(a => a.toFixed(3))).size > 1,
      groundRings: groundRings.length,
      groundRadii: [...new Set(groundRings.map(r => r.ellipse.semiMajorAxis.getValue(time)))],
      errorPanel: Boolean(document.querySelector('.cesium-widget-errorPanel')) };
  });
  assert.ok(pulses.rings > 0, 'events are pulsing');
  assert.equal(pulses.bad, 0, 'every ring reports a usable size across 25 samples');
  assert.ok(pulses.fading, 'the rings are at different points of their travel, so they animate');
  assert.equal(pulses.errorPanel, false, 'and rendering has not stopped');
  // Each event also carries a true 100 m ring on the ground, so that once an operator has flown to
  // one, the circle is a distance they can measure other assets against rather than a screen shape.
  assert.equal(pulses.groundRings, pulses.rings / 2, 'one ground ring per event');
  assert.deepEqual(pulses.groundRadii, [100], 'and it is a real 100 m radius');
  console.log(`✓ event pulses: ${pulses.rings} screen-space rings + ${pulses.groundRings} × 100 m ground rings, animating, no render error`);

  // Only the two ends of I-595 are signed here: a shield at every interchange repeats the same
  // route number across a corridor-wide frame. Every other workspace keeps the full set.
  const shieldsDrawn = () => page.evaluate(() => {
    const ds = window.__viewer.dataSources.getByName('I-595 Route Shields')[0];
    const time = window.__viewer.clock.currentTime;
    const all = ds.entities.values;
    // `billboard.show` is a Cesium property, not a boolean — reading it raw is always truthy.
    const visible = entity => entity.billboard.show?.getValue?.(time) ?? true;
    return { total: all.length, drawn: all.filter(visible).length };
  });
  // The suite has moved on to Traffic by this point; come back so the check is made where it counts.
  await page.locator('.app-nav [data-section="liveOps"]').click();
  await page.waitForTimeout(2500);
  const liveOpsShields = await shieldsDrawn();
  assert.ok(liveOpsShields.total > 2, 'the corridor has more shields than its two ends');
  assert.equal(liveOpsShields.drawn, 2, 'and Live Ops draws only the beginning and the end');
  console.log(`✓ route shields: ${liveOpsShields.drawn} of ${liveOpsShields.total} — the corridor's two ends only`);

  // Leaving the workspace takes them away and stops the animation loop.
  await page.locator('.app-nav [data-section="overview"]').click();
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => window.__viewer.dataSources.getByName('Live Ops event pulses')[0].show), false,
    'the pulses go with the workspace');
  assert.equal((await shieldsDrawn()).drawn, liveOpsShields.total, 'and every route shield comes back');
  console.log('✓ leaving Live Ops puts the pulses away and restores every shield');

  assert.deepEqual(problems, []);
  console.log('✓ no page or console errors');
} finally { await browser.close(); }
