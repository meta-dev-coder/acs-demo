import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome' });
const page = await b.newPage({ viewport: { width: 1680, height: 1050 } });
page.on('pageerror', e => console.log('PAGEERROR', String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForTimeout(10000);
await page.selectOption('.app-role select', 'tmc'); await page.waitForTimeout(1500);
await page.click('.app-nav-item[data-section="tmc"]'); await page.waitForTimeout(5000);
await page.selectOption('.tmc-mode-select', 'HISTORICAL'); await page.waitForTimeout(14000);
const setDate = async d => { await page.evaluate(v => { const el=document.querySelector('.tmc-at-input');
  el.value = v; el.dispatchEvent(new Event('change',{bubbles:true})); }, d); await page.waitForTimeout(9000); };
const probe = ['2026-01-15'];
let hit = null;
for (const d of probe.slice(0, 14)) {
  await setDate(d);
  const found = await page.evaluate(() => (window.__tmc.assessment.assessments ?? [])
    .filter(a => a.resources?.camera?.resource)
    .map(a => ({ id: a.incident.id, cam: a.resources.camera.found?.id ?? a.resources.camera.id })));
  if (found.length) { hit = { date: d, ...found[0] }; break; }
}
console.log('CAMERA CANDIDATE:', JSON.stringify(hit));
if (!hit) { console.log('no page errors'); await b.close(); process.exit(0); }
await page.evaluate(i => window.__tmc.selectIncident(i), hit.id);
await page.waitForTimeout(7000);
// The camera pin belongs to the response lens.
await page.evaluate(() => window.__tmc.showTab('response'));
await page.waitForTimeout(4000);
const cam = await page.evaluate(() => {
  const v = window.__viewer, t = v.clock.currentTime;
  const ds = v.dataSources._dataSources.find(d=>d.name==='TMC incidents');
  const e = ds?.entities.values.find(x=>/^tmc:camera:/.test(String(x.id)));
  if (!e) return null;
  const p = v.scene.cartesianToCanvasCoordinates(e.position.getValue(t));
  const o = e.billboard?.pixelOffset?.getValue?.(t) ?? {x:0,y:0};
  return { x: p.x + o.x, y: p.y + o.y - 10, id: String(e.id) };
});
console.log('CAMERA PIN:', JSON.stringify(cam));
if (!cam) console.log('TMC IDS:', JSON.stringify(await page.evaluate(() => {
  const v = window.__viewer;
  const d = v.dataSources._dataSources.find(x=>x.name==='TMC incidents');
  return d ? d.entities.values.map(e=>String(e.id)) : v.dataSources._dataSources.map(x=>x.name);
})));
if (!cam) { console.log('no page errors'); await b.close(); process.exit(0); }
const r = await page.evaluate(() => document.querySelector('canvas').getBoundingClientRect());
await page.mouse.click(r.x + cam.x, r.y + cam.y);
await page.waitForTimeout(2500);
const before = await page.evaluate(() => { const c = document.querySelector('.tmc-resource-card');
  return c && !c.hidden ? c.getBoundingClientRect().toJSON() : null; });
console.log('CARD OPEN:', JSON.stringify(before && {x:Math.round(before.x),y:Math.round(before.y)}));
if (!before) { console.log('no page errors'); await b.close(); process.exit(0); }
await page.mouse.move(before.x + 60, before.y + 16);
await page.mouse.down();
await page.mouse.move(before.x + 60 - 300, before.y + 16 + 200, { steps: 14 });
await page.mouse.up(); await page.waitForTimeout(800);
const after = await page.evaluate(() => document.querySelector('.tmc-resource-card').getBoundingClientRect().toJSON());
console.log('DRAGGED BY:', JSON.stringify({ dx: Math.round(after.x-before.x), dy: Math.round(after.y-before.y) }));
await page.evaluate(() => window.__viewer.camera.moveLeft(150));
await page.waitForTimeout(1500);
const moved = await page.evaluate(() => document.querySelector('.tmc-resource-card').getBoundingClientRect().toJSON());
console.log('STAYS PUT AFTER CAMERA MOVE:', Math.round(moved.x-after.x)===0 && Math.round(moved.y-after.y)===0);
console.log('STILL OPEN:', await page.evaluate(() => !document.querySelector('.tmc-resource-card').hidden));
await setDate(hit.date === '2026-03-06' ? '2026-03-05' : '2026-03-06');
console.log('CLOSED ON DATE CHANGE:', await page.evaluate(() => !!document.querySelector('.tmc-resource-card').hidden));
console.log('no page errors');
await b.close();
