/**
 * The staged startup choreography: base 3D world, flight to the western corridor, then the mainline,
 * the express lanes, the route shields and finally the live overlays — each in order, each visible
 * only from its own stage onwards. Also covers `?intro=off`, which every other smoke test uses.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { STARTUP_STAGES } from '../src/i595StartupSequence.js';
import { corridorOverview, heroView } from '../src/i595CorridorViews.js';

const corridor = JSON.parse(readFileSync(new URL('../config/corridorCenterline.json', import.meta.url)));
const hero = heroView(corridor), overview = corridorOverview(corridor);
const expected = [...STARTUP_STAGES.map(stage => stage.toLowerCase().replaceAll('_', '-')), 'ready'];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace('viewer.animation.container', 'window.v = viewer; viewer.animation.container')
      .replace('if (import.meta.hot)', 'window.shields = roadShields; window.labels = contextLabels; window.startup = startupSequence; if (import.meta.hot)');
    await route.fulfill({ response, body });
  });

  // ---- the stages happen, in order, and only once ----------------------------------------------
  // Recorded in the page: a stage can be shorter than any polling interval, so none may be missed.
  await page.addInitScript(() => {
    window.__stages = [];
    const record = () => {
      const stage = document.body?.dataset.startup;
      if (stage && window.__stages.at(-1) !== stage) window.__stages.push(stage);
    };
    // `document` always exists at document-start; documentElement may not.
    new MutationObserver(record).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-startup'] });
    record();
  });
  const samples = [];
  await page.goto('http://127.0.0.1:5188/?demo=i595');
  for (const deadline = Date.now() + 90000; Date.now() < deadline;) {
    const state = await page.evaluate(() => ({
      stage: document.body.dataset.startup,
      height: window.v?.camera.positionCartographic.height,
      // How far the faded layers have come at this instant.
      shieldAlpha: [...(window.shields?.shieldById.values() ?? [])][0]?.billboard.color.getValue()?.alpha,
      shieldsShown: [...(window.shields?.shieldById.values() ?? [])].some(entity => entity.isShowing),
    })).catch(() => ({}));
    if (state.stage) samples.push(state);
    if (state.stage === 'ready') break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  const seen = await page.evaluate(() => window.__stages);
  assert.deepEqual(seen, expected, `stages ran out of order: ${seen.join(' → ')}`);

  // ---- the flight: from the corridor overview down to the western corridor ----------------------
  const earliest = samples.find(sample => sample.stage === 'base-3d');
  assert.ok(earliest.height > overview.height * 0.9,
    `the opening frame must be the corridor overview, was ${Math.round(earliest.height)} m`);
  const camera = await page.evaluate(() => {
    const c = window.C_.Cartographic.fromCartesian(window.v.camera.position);
    return { lon: window.C_.Math.toDegrees(c.longitude), lat: window.C_.Math.toDegrees(c.latitude), height: c.height,
      heading: window.C_.Math.toDegrees(window.v.camera.heading), pitch: window.C_.Math.toDegrees(window.v.camera.pitch) };
  }).catch(async () => {
    await page.evaluate(async () => {
      const text = await (await fetch('/src/i595Demo.js')).text();
      window.C_ = await import(text.match(/from\s*"([^"]*cesium[^"]*)"/)[1]);
    });
    return page.evaluate(() => {
      const c = window.C_.Cartographic.fromCartesian(window.v.camera.position);
      return { lon: window.C_.Math.toDegrees(c.longitude), lat: window.C_.Math.toDegrees(c.latitude), height: c.height,
        heading: window.C_.Math.toDegrees(window.v.camera.heading), pitch: window.C_.Math.toDegrees(window.v.camera.pitch) };
    });
  });
  assert.ok(Math.abs(camera.lon - hero.lon) < 0.003 && Math.abs(camera.lat - hero.lat) < 0.003,
    `the flight must land on the western corridor, got ${camera.lon},${camera.lat}`);
  assert.ok(Math.abs(camera.height - hero.height) < 200, `landed at ${Math.round(camera.height)} m`);
  assert.ok(Math.abs(camera.pitch + 23) < 3, `the hero view must stay oblique, got pitch ${camera.pitch}`);
  assert.ok(camera.pitch > -30, 'a plan view would defeat the photorealistic base');
  assert.ok(Math.abs(camera.heading - hero.headingDeg) < 1, 'the flight lands on the hero heading');

  // ---- shields are dark until their own stage, then fade to full strength ----------------------
  const beforeShields = samples.filter(sample => ['base-3d', 'fly-to-corridor', 'mainline', 'express'].includes(sample.stage));
  assert.ok(beforeShields.length > 0);
  assert.ok(beforeShields.every(sample => sample.shieldsShown === false),
    'route shields must not be drawn before the shield stage');
  const alphas = samples.filter(sample => sample.shieldAlpha != null).map(sample => sample.shieldAlpha);
  assert.ok(alphas.length > 0 && alphas.at(-1) === 1, 'shields must end fully opaque');
  assert.ok(alphas.some(alpha => alpha > 0 && alpha < 1), 'shields must fade rather than snap on');

  // ---- the sequence's own report, and the end state --------------------------------------------
  const result = await page.evaluate(() => window.startup.run().then(r => ({
    completed: r.completed, failures: r.failures.map(f => f.stage),
  })));
  assert.deepEqual(result.completed, [...STARTUP_STAGES], `stages did not all complete: ${result.failures.join(', ')}`);
  // The opening scene is the corridor and nothing else.
  const layers = await page.evaluate(() => Object.fromEntries(
    ['i595_mainline_eb', 'i595_mainline_wb', 'express-way'].map(id => [id, document.querySelector(`#${id}`)?.checked === true])));
  for (const [id, on] of Object.entries(layers)) assert.equal(on, true, `${id} must be on when the intro finishes`);
  const untouched = await page.evaluate(() => ['ramps-all', 'frontage-all', 'bridges-all', 'cameras-all', 'signals-all', 'live-events-all']
    .map(id => document.querySelector(`#${id}`)).filter(Boolean).every(input => !input.checked && !input.indeterminate));
  assert.equal(untouched, true, 'CCTV, signals, live events, ramps, frontage and bridges stay off at startup');
  // The context labels arrive with the shields.
  assert.equal(await page.evaluate(() => [...window.labels.labelById.values()].every(entity => entity.isShowing)), true);
  await page.screenshot({ path: '/tmp/i595-startup-sequence.png' });

  // ---- ?intro=off: no choreography, straight to the end state -----------------------------------
  const direct = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await direct.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text())
      .replace('viewer.animation.container', 'window.v = viewer; viewer.animation.container')
      .replace('if (import.meta.hot)', 'window.shields = roadShields; if (import.meta.hot)') });
  });
  await direct.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await direct.locator('body[data-startup="ready"]').waitFor({ timeout: 30000 });
  await direct.waitForTimeout(1500);
  const skipped = await direct.evaluate(() => ({
    height: window.v.camera.positionCartographic.height,
    shieldsShown: [...window.shields.shieldById.values()].every(entity => entity.isShowing),
    checked: [...document.querySelectorAll('input[type=checkbox]')].filter(input => input.checked).length,
  }));
  assert.ok(Math.abs(skipped.height - hero.height) < 200, 'without the intro the map opens at the corridor directly');
  assert.equal(skipped.shieldsShown, true, 'shields are simply on when the intro is skipped');
  assert.equal(skipped.checked, 0, 'no layer is switched on when the intro is skipped');
  await direct.close();

  console.log(`startup sequence OK — ${seen.join(' → ')}`);
} finally {
  await browser.close();
}
