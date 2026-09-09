/**
 * Live Events layer end-to-end. The FL511-backed API is stubbed with fixtures so the run is
 * deterministic: what is under test is the layer tree, picking, provenance separation, incremental
 * diffing and stale handling — not whether Broward County has an incident this minute.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { openExplorer } from './i595Explorer.mjs';

const mainline = JSON.parse(readFileSync(new URL('../public/data/i595_mainline_eb.geojson', import.meta.url)));
const [onMainlineLon, onMainlineLat] = mainline.features[0].geometry.coordinates[40];

// Real FL511 closure 845752 (2026-09-09): metres from an I-595 ramp, but FL511 attributes it to
// 95 Express. The details panel must show FL511's words and our association separately.
const closure = {
  id: 'FL511-CLOSURE-845752', source: 'FL511', type: 'CLOSURE', rawSourceId: '845752',
  latitude: 26.085906, longitude: -80.169425,
  title: 'Closure',
  description: 'Planned construction in Broward County on 95 Express South, ramp from I-595 Mainline/Tpk/US-441. On-ramp closed.',
  severity: 'Major', region: 'Southeast', startTime: 'Sep 8 2026, 9:15 PM', lastUpdated: 'Sep 8 2026, 9:15 PM',
  detailsAvailable: true,
  detailFields: [{ label: 'Severity', value: 'Major' }, { label: 'Region', value: 'Southeast' },
    { label: 'Start Time', value: 'Sep 8 2026, 9:15 PM' }, { label: 'Last Updated', value: 'Sep 8 2026, 9:15 PM' }],
  distanceToI595NetworkM: 15.1, nearestFacility: 'RAMP_CONNECTOR', nearestFacilityLabel: 'I-595 Ramp / Connector',
  distanceToNearestFacilityM: 15.1, nearestSegmentId: null, nearestSegmentLabel: null, distanceToSegmentM: null,
};
const incident = {
  id: 'FL511-INCIDENT-845391', source: 'FL511', type: 'INCIDENT', rawSourceId: '845391',
  latitude: onMainlineLat, longitude: onMainlineLon,
  detailsAvailable: false, detailFields: [],
  distanceToI595NetworkM: 0.4, nearestFacility: 'I595_EB', nearestFacilityLabel: 'I-595 Eastbound',
  distanceToNearestFacilityM: 0.4, nearestSegmentId: 'I595-EB-FDOT-000000-004182',
  nearestSegmentLabel: 'Eastbound Segment 1', distanceToSegmentM: 0.4,
};
// A closure FL511 published with two endpoints; the connector line is endpoint-to-endpoint only.
const spanning = {
  ...closure, id: 'FL511-CLOSURE-461840', rawSourceId: '461840', severity: 'Minor',
  latitude: 26.0855, longitude: -80.1721, secondaryLatitude: onMainlineLat, secondaryLongitude: onMainlineLon,
  secondaryDistanceToI595NetworkM: 0.4,
};

const envelope = (events, sourceStatus = 'LIVE', extra = {}) => ({
  source: 'FL511', sourceStatus,
  lastUpdated: '2026-09-09T07:06:05.771Z', lastSuccessfulUpdate: '2026-09-09T07:06:05.771Z',
  dataFreshness: { ageSeconds: sourceStatus === 'STALE' ? 600 : 3, refreshSeconds: 60, staleAfterSeconds: 180 },
  bufferMeters: 250, segmentToleranceMeters: 120,
  counts: {
    total: events.length,
    incidents: events.filter(event => event.type === 'INCIDENT').length,
    closures: events.filter(event => event.type === 'CLOSURE').length,
  },
  events, diagnostics: { lastError: null }, ...extra,
});

const snapshots = [
  envelope([incident, closure]),
  // Second poll: the incident moved, the spanning closure appeared, 845752 cleared.
  envelope([{ ...incident, latitude: incident.latitude + 0.0004, severity: 'Minor' }, spanning]),
  // Third poll: FL511 stopped answering; the backend serves its cache.
  envelope([{ ...incident, latitude: incident.latitude + 0.0004, severity: 'Minor' }, spanning], 'STALE'),
];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let poll = 0, apiCalls = 0, unreachable = false;
  await page.route('**/api/i595/live-events*', async route => {
    apiCalls++;
    // `unreachable` reproduces the service being stopped: the browser gets no response at all.
    if (unreachable) return route.abort('connectionrefused');
    const body = snapshots[Math.min(poll, snapshots.length - 1)];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace('viewer.animation.container', 'window.v=viewer; viewer.animation.container')
      .replace('if (import.meta.hot)', 'window.live=liveEventControls; window.cameras=cameraControls; if (import.meta.hot)');
    await route.fulfill({ response, body });
  });
  await page.goto('http://127.0.0.1:5188/?demo=i595');
  await openExplorer(page);
  await page.locator('#live-events-all:not(:disabled)').waitFor({ state: 'attached', timeout: 60000 });
  await page.evaluate(async () => {
    const source = await (await fetch('/src/i595Demo.js')).text();
    window.C = await import(source.match(/from\s*"([^"]*cesium[^"]*)"/)[1]);
  });

  // ---- layer tree ------------------------------------------------------------------------------
  await page.locator('.its-group > summary').click();
  await page.locator('.live-events-group > summary').click({ position: { x: 5, y: 10 } });
  assert.equal(await page.locator('.live-events-group > summary .badge').textContent(), '2');
  assert.equal(await page.locator('[data-live-count="INCIDENT"]').textContent(), '1');
  assert.equal(await page.locator('[data-live-count="CLOSURE"]').textContent(), '1');
  assert.match(await page.locator('.live-events-group [role="status"]').textContent(), /2 live events within 250 m · live/);
  // The Live Events group sits alongside the existing ITS layers, which keep working.
  assert.equal(await page.locator('.cameras-group .badge').textContent(), '74');
  assert.equal(await page.locator('.signals-group .badge').textContent(), '22');

  // ---- defaults and independent toggles --------------------------------------------------------
  // Like every other layer here, both feeds start hidden even though their counts are already known.
  const shown = () => page.evaluate(() => [...live.entityById.entries()].filter(([, e]) => e.show).map(([id]) => id).sort());
  assert.equal(await page.locator('#live-events-all').isChecked(), false);
  assert.deepEqual(await shown(), []);
  await page.locator('input[data-live-type="CLOSURE"]').check();
  assert.deepEqual(await shown(), ['FL511-CLOSURE-845752']);
  assert.ok(await page.locator('#live-events-all').evaluate(node => node.indeterminate), 'one feed on is indeterminate');
  await page.locator('input[data-live-type="INCIDENT"]').check();
  assert.deepEqual(await shown(), ['FL511-CLOSURE-845752', 'FL511-INCIDENT-845391']);
  assert.equal(await page.locator('#live-events-all').evaluate(node => node.indeterminate), false);
  assert.ok(await page.locator('#live-events-all').isChecked(), 'both feeds on checks the parent');
  await page.locator('#live-events-all').uncheck();
  assert.deepEqual(await shown(), [], 'the parent switches both feeds off');
  await page.locator('#live-events-all').check();
  assert.deepEqual(await shown(), ['FL511-CLOSURE-845752', 'FL511-INCIDENT-845391']);

  // ---- picking and provenance ------------------------------------------------------------------
  await page.locator('button.segment-select[data-live-type="CLOSURE"]').click();
  await page.waitForTimeout(1800);
  const marker = await page.evaluate(id => {
    const point = C.SceneTransforms.worldToWindowCoordinates(v.scene, live.entityById.get(id).position.getValue());
    return { x: point.x, y: point.y - 15 };
  }, closure.id);
  await page.mouse.move(marker.x, marker.y);
  await page.getByRole('tooltip').filter({ hasText: /FL511 Event 845752/ }).waitFor();
  const tooltip = await page.getByRole('tooltip').textContent();
  assert.ok(tooltip.includes('95 Express South'), 'hover shows FL511 words, not our inference');
  await page.mouse.click(marker.x, marker.y);
  await page.locator('.live-event-details:not([hidden])').waitFor();
  // Clicking a live event must not leave another layer's panel open.
  assert.equal(await page.locator('.camera-details:not([hidden]), .bridge-details:not([hidden]), .signal-details:not([hidden])').count(), 0);

  const sourceTerms = await page.locator('.live-event-details > dl dt').allTextContents();
  const sourceValues = await page.locator('.live-event-details > dl dd').allTextContents();
  assert.deepEqual(sourceTerms, ['Type', 'Description', 'Severity', 'Started', 'Last Updated', 'Region', 'Location', 'Source', 'FL511 Event ID']);
  assert.ok(sourceValues.includes('FL511'));
  assert.equal(sourceValues[sourceTerms.indexOf('Severity')], 'Major');
  // FL511 publishes no structured roadway/direction/lane values, so no such row may appear.
  for (const invented of ['Road', 'Direction', 'Lanes Blocked', 'Ends', 'Status']) {
    assert.ok(!sourceTerms.includes(invented), `${invented} must not be fabricated`);
  }
  assert.match(await page.locator('.live-event-caption').textContent(), /Source data · FL511/);
  const derivedTerms = await page.locator('.live-event-association dt').allTextContents();
  const derivedValues = await page.locator('.live-event-association dd').allTextContents();
  assert.deepEqual(derivedTerms, ['Nearest Facility', 'Distance']);
  assert.deepEqual(derivedValues, ['I-595 Ramp / Connector', '15 m']);
  assert.match(await page.locator('.live-event-association p').textContent(), /Proximity does not mean FL511 placed the event on that facility/);
  await page.screenshot({ path: '/tmp/live-events-details.png' });

  // ---- incremental refresh ---------------------------------------------------------------------
  await page.evaluate(() => { live.entityById.get('FL511-INCIDENT-845391').__probe = 'kept'; });
  poll = 1;
  await page.evaluate(() => live.refresh());
  await page.waitForTimeout(400);
  assert.deepEqual(await page.evaluate(() => [...live.entityById.keys()].sort()), ['FL511-CLOSURE-461840', 'FL511-INCIDENT-845391']);
  assert.equal(await page.evaluate(() => live.entityById.get('FL511-INCIDENT-845391').__probe), 'kept',
    'the surviving event must keep its entity instead of being recreated');
  assert.equal(await page.evaluate(() => live.entityById.has('FL511-CLOSURE-845752')), false, 'a removed event must disappear');
  // The moved event's position followed the feed.
  const moved = await page.evaluate(() => {
    const carto = C.Cartographic.fromCartesian(live.entityById.get('FL511-INCIDENT-845391').position.getValue());
    return C.Math.toDegrees(carto.latitude);
  });
  assert.ok(Math.abs(moved - (incident.latitude + 0.0004)) < 1e-7);
  // The two-endpoint closure draws a connector, labelled as endpoint-to-endpoint only.
  assert.equal(await page.evaluate(() => Boolean(live.entityById.get('FL511-CLOSURE-461840'))), true);
  const connector = await page.evaluate(() => {
    const [source] = v.dataSources.getByName('FL511 Live Road Events');
    const entity = source?.entities.getById('FL511-CLOSURE-461840::connector');
    return entity ? entity.polyline.positions.getValue().length : 0;
  });
  assert.equal(connector, 2);
  // Selection was cleared with its event; open the spanning closure to see the endpoint note.
  await page.locator('button.segment-select[data-live-type="CLOSURE"]').click();
  await page.waitForTimeout(2200);
  const spanningPoint = await page.evaluate(() => {
    const point = C.SceneTransforms.worldToWindowCoordinates(v.scene, live.entityById.get('FL511-CLOSURE-461840').position.getValue());
    return point ? { x: point.x, y: point.y - 15 } : null;
  });
  assert.ok(spanningPoint, 'the spanning closure must be on screen after zooming to closures');
  await page.mouse.click(spanningPoint.x, spanningPoint.y);
  await page.locator('.live-event-note').waitFor();
  assert.match(await page.locator('.live-event-note').textContent(), /not the closed roadway geometry/);
  assert.ok((await page.locator('.live-event-details > dl dt').allTextContents()).includes('Secondary Location'));

  // ---- stale source ----------------------------------------------------------------------------
  poll = 2;
  await page.evaluate(() => live.refresh());
  await page.waitForTimeout(400);
  assert.match(await page.locator('.live-events-group [role="status"]').textContent(), /cached data from 10 min ago/);
  assert.match(await page.locator('.live-event-source').textContent(), /FL511 is not responding/);
  assert.equal(await page.evaluate(() => live.entityById.size), 2, 'stale data keeps its markers');
  assert.ok(apiCalls >= 3);
  await page.screenshot({ path: '/tmp/live-events-stale.png' });

  // ---- our own API unreachable -----------------------------------------------------------------
  // A stopped service is a different condition from FL511 failing, and the markers already received
  // stay on screen — so the wording must not claim there is no data to show.
  await page.evaluate(() => { live.entityById.get('FL511-INCIDENT-845391').__probe = 'survives-outage'; });
  unreachable = true;
  await page.evaluate(() => live.refresh());
  await page.waitForTimeout(500);
  assert.match(await page.locator('.live-events-group [role="status"]').textContent(), /Live-event service unreachable · still showing 2 events/);
  const notice = await page.locator('.live-event-source').textContent();
  assert.match(notice, /cannot reach \/api\/i595\/live-events/);
  assert.ok(!/no FL511 data has been received/.test(notice), 'two events are visible; the notice must not deny them');
  assert.equal(await page.evaluate(() => live.entityById.size), 2, 'an outage must not clear the layer');
  assert.equal(await page.evaluate(() => live.entityById.get('FL511-INCIDENT-845391').__probe), 'survives-outage',
    'entities must stay the same instances across a failed refresh');
  assert.equal(await page.locator('.live-event-retry').isHidden(), false);

  // ---- retry recovers --------------------------------------------------------------------------
  unreachable = false; poll = 1;
  await page.locator('.live-event-retry').click();
  await page.locator('.live-events-group [role="status"]').filter({ hasText: '· live' }).waitFor();
  assert.match(await page.locator('.live-events-group [role="status"]').textContent(), /2 live events within 250 m · live/);
  assert.ok(await page.locator('.live-event-source').isHidden(), 'a healthy source shows no notice');
  assert.ok(await page.locator('.live-event-retry').isHidden());
  assert.equal(await page.evaluate(() => live.entityById.get('FL511-INCIDENT-845391').__probe), 'survives-outage',
    'recovery reuses the existing entities rather than rebuilding the layer');
  console.log('PASS: live events tree, defaults, independent toggles, picking, source/derived provenance, incremental diffing, connector line, stale handling, service-unreachable wording, retry recovery');
} finally {
  await browser.close();
}
