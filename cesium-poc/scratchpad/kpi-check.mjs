import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome' });
for (const width of [1280, 1440, 1600, 1920]) {
  const p = await b.newPage({ viewport: { width, height: 900 } });
  await p.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
  await p.waitForTimeout(7000);
  await p.selectOption('.app-role select', 'maintenanceTeam');
  await p.waitForTimeout(18000);
  const m = await p.evaluate(() => {
    const root = [...document.querySelectorAll('.ws-kpis')].find(r => r.offsetParent);
    const demo = root.querySelector('.ws-kpi[data-kpi="acsDemoCases"]');
    const d = demo.getBoundingClientRect();
    const inView = d.right <= window.innerWidth && d.left >= 0 && d.bottom <= window.innerHeight;
    const atPoint = document.elementFromPoint(Math.round(d.left + d.width / 2), Math.round(d.top + d.height / 2));
    return { stripH: Math.round(root.getBoundingClientRect().height),
      demoW: Math.round(d.width), demoTop: Math.round(d.top), inView,
      clickable: Boolean(atPoint && atPoint.closest('[data-kpi="acsDemoCases"]')),
      rows: new Set([...root.querySelectorAll('.ws-kpi')].map(e => Math.round(e.getBoundingClientRect().top))).size };
  });
  console.log(width, JSON.stringify(m));
  if (width === 1440) await p.screenshot({ path: 'scratchpad/kpi-1440.png', clip: { x: 0, y: 0, width, height: 230 } });
  await p.close();
}
await b.close();
