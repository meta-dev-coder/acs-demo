import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => (window.__safetyIntel.analysis()?.hotspots.clusters.length ?? 0) > 0, null, { timeout: 180000 });
await page.waitForTimeout(2000);

// 4. Lab + wide + nothing selected -> back to normal width
await page.click('[data-wide]');
await page.waitForTimeout(400);
const wideOnAccidents = await page.$eval('.si-analysis', el => Math.round(el.getBoundingClientRect().width));
await page.click('[data-tab="lab"]');
await page.waitForTimeout(1200);
console.log('4 Lab with no incident:', { wideOnAccidents,
  afterOpeningLab: await page.$eval('.si-analysis', el => Math.round(el.getBoundingClientRect().width)),
  wideState: await page.evaluate(() => window.__safetyIntel.state.wide) });

// 3. Accidents in wide mode -> rows of charts
await page.click('[data-tab="accidents"]');
await page.waitForTimeout(1200);
// Turn wide ON only if the Lab visit switched it off.
if (!(await page.evaluate(() => window.__safetyIntel.state.wide))) {
  await page.click('[data-wide]');
  await page.waitForTimeout(600);
}
console.log('3 wide Accidents rows:', JSON.stringify(await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.si-row')];
  return rows.map(row => ({
    cols: getComputedStyle(row).gridTemplateColumns.split(' ').length,
    sections: row.children.length,
    sameRow: new Set([...row.children].map(c => Math.round(c.getBoundingClientRect().top))).size === 1,
  }));
})));
await page.screenshot({ path: 'scratchpad/wide-accidents.png' });

// 1 + 2. Patrols on the map with times
if (await page.evaluate(() => window.__safetyIntel.state.wide)) await page.click('[data-wide]');
await page.evaluate(() => {
  const si = window.__safetyIntel;
  const f = si.analysis().hotspots.clusters[0].facts.find(x => x.laneClosure) ?? si.analysis().hotspots.clusters[0].facts[0];
  si.selectIncidentById(f.id);
});
await page.waitForTimeout(3500);
await page.click('[data-lab-tab="patrols"]');
await page.waitForTimeout(4000);
console.log('camera framed fleet:', await page.evaluate(() => {
  const v = window.__viewer;
  const src = v.dataSources.getByName('I-595 Safety Intelligence')[0];
  const marks = src.entities.values.filter(e => /^patrol:[^:]+$/.test(String(e.id)));
  const onScreen = marks.filter(e => {
    const p = window.Cesium?.SceneTransforms?.worldToWindowCoordinates?.(v.scene,
      e.position.getValue(v.clock.currentTime));
    return p && p.x > 0 && p.x < v.canvas.clientWidth && p.y > 0 && p.y < v.canvas.clientHeight;
  }).length;
  return { marks: marks.length, height: Math.round(v.camera.positionCartographic.height) };
}));
console.log('1 patrols on map:', JSON.stringify(await page.evaluate(() => {
  const src = window.__viewer.dataSources.getByName('I-595 Safety Intelligence')[0];
  const t = window.__viewer.clock.currentTime;
  const marks = src.entities.values.filter(e => String(e.id).startsWith('patrol:') && !String(e.id).endsWith(':line'));
  return { patrolMarks: marks.length,
    lines: src.entities.values.filter(e => String(e.id).endsWith(':line')).length,
    labels: marks.map(e => e.label?.text?.getValue?.(t)).filter(Boolean) };
}), null, 1));
console.log('2 clearance spread:', await page.evaluate(() => {
  const si = window.__safetyIntel;
  const text = document.querySelector('.lab-panel .si-lede')?.textContent.replace(/\s+/g, ' ').trim();
  return text?.slice(0, 150);
}));
await page.screenshot({ path: 'scratchpad/patrols-map.png' });
// leaving the tab removes them
await page.click('[data-lab-tab="overview"]');
await page.waitForTimeout(1200);
console.log('patrols cleared on leaving:', await page.evaluate(() => {
  const src = window.__viewer.dataSources.getByName('I-595 Safety Intelligence')[0];
  return src.entities.values.filter(e => String(e.id).startsWith('patrol:')).length;
}));
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
